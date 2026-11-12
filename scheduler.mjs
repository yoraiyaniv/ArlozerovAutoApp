import { israelDate, shiftDate, matches } from './time.mjs';
export const FINAL = new Set(['registered', 'waitlisted', 'failed', 'missed', 'cancelled']);
export class Scheduler {
  constructor(store, client, { live = false, now = () => Date.now() } = {}) {
    this.store = store; this.client = client; this.live = live; this.now = now;
    this.busy = false; this.lastSync = 0; this.syncError = null; this.timer = null;
  }
  async connect() {
    const saved = this.store.get('credentials');
    if (!saved) return false;
    const { phone, password } = this.store.decrypt(saved);
    await this.client.login(phone, password);
    return true;
  }
  async sync() {
    const start = israelDate(this.now());
    let rules = this.store.rules().filter(r => r.enabled);
    const db = this.store.db;
    if (!rules.length) {
      db.prepare("UPDATE jobs SET status='cancelled',message='No active weekly rules' WHERE status IN ('pending','retry')").run();
      this.lastSync = this.now(); this.syncError = null;
      return [];
    }
    const [first, second] = await Promise.all([
      this.client.calendar(start, shiftDate(start, 6)),
      this.client.calendar(shiftDate(start, 7), shiftDate(start, 13))
    ]);
    const classes = [...new Map([...first, ...second].map(a => [a.key, a])).values()];
    rules = this.store.rules().filter(r => r.enabled);
    for (const a of classes) {
      if (a.startsAt <= this.now()) continue;
      const rule = rules.find(r => matches(r, a));
      if (!rule) continue;
      const job = db.prepare('SELECT key FROM jobs WHERE key=?').get(a.key);
      // A newly enabled rule never causes a surprise immediate, late booking.
      if (!job && a.dueAt < this.now()) continue;
      db.prepare(`INSERT INTO jobs(key,ruleId,dueAt,startsAt,status,nextAt,updatedAt,data) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET data=excluded.data, ruleId=excluded.ruleId WHERE jobs.status='pending'`)
        .run(a.key, rule.id, a.dueAt, a.startsAt, 'pending', a.dueAt, this.now(), JSON.stringify(a));
    }
    // Only cancel missing occurrences inside the fetched range. Future records survive range boundaries.
    const keys = new Set(classes.map(a => a.key));
    for (const job of db.prepare("SELECT * FROM jobs WHERE status IN ('pending','retry')").all()) {
      const a = JSON.parse(job.data);
      if (!rules.some(r => r.id === job.ruleId && matches(r, a)) || (a.date >= start && a.date <= shiftDate(start, 13) && !keys.has(a.key))) this.finish(job.key, 'cancelled', 'Class removed, changed, or weekly rule paused');
    }
    this.lastSync = this.now(); this.syncError = null;
    return classes;
  }
  finish(key, status, message) {
    this.store.db.prepare('UPDATE jobs SET status=?,message=?,updatedAt=? WHERE key=?').run(status, message, this.now(), key);
    // A one-time rule has done its job once its single occurrence reaches a final state.
    if (FINAL.has(status)) {
      const job = this.store.db.prepare('SELECT key,ruleId,startsAt,data FROM jobs WHERE key=?').get(key);
      if (this.store.rules().some(r => r.id === job?.ruleId && r.once)) this.store.db.prepare('DELETE FROM rules WHERE id=?').run(job.ruleId);
      if (job) try { this.onFinal?.(job, status, message); } catch { /* a notification problem must never affect booking */ }
    }
  }
  async attempt(job) {
    if (this.blockedKeys?.has(job.key)) return;
    const db = this.store.db;
    const rule = this.store.rules().find(r => r.id === job.ruleId && r.enabled);
    if (!rule) return this.finish(job.key, 'cancelled', 'Weekly rule paused');
    if (this.now() > job.dueAt + 120000) return this.finish(job.key, 'missed', 'Opening window missed; no late booking attempted');
    if (!this.live) return; // Preview mode cannot send a booking request.
    const claim = db.prepare("UPDATE jobs SET status='running', attempts=attempts+1,updatedAt=? WHERE key=? AND status IN ('pending','retry')").run(this.now(), job.key);
    if (!claim.changes) return;
    try {
      if (!this.client.session && !(await this.connect())) throw new Error('Connect your club account first');
      const snapshot = JSON.parse(job.data);
      const current = (await this.client.calendar(snapshot.date, snapshot.date)).find(a => a.key === job.key);
      if (!current || !matches(rule, current)) return this.finish(job.key, 'cancelled', 'Class changed or is no longer on the schedule');
      if ([2, 8].includes(current.status)) return this.finish(job.key, 'registered', 'Registration confirmed by the club');
      if (current.status === 4) return this.finish(job.key, 'waitlisted', 'Waitlist confirmed by the club');
      if (current.paid || current.seatsMap || current.raw.RequireReserve || current.raw.HasCourt) return this.finish(job.key, 'failed', 'Manual booking needed: purchase, seat, or reservation selection');
      const waitlist = current.status === 1 && rule.waitlist;
      if ([0, 1].includes(current.status) && !waitlist) return this.finish(job.key, 'failed', 'Class full; waitlist not enabled or unavailable');
      if (![3, 5].includes(current.status) && !waitlist) throw new Error('Registration is not open yet');
      if (!this.store.rules().some(r => r.id === job.ruleId && r.enabled) || !this.store.get('credentials')) return this.finish(job.key, 'cancelled', 'Rule paused or account disconnected');
      await this.client.register(current, waitlist);
      // Always read back. A successful HTTP request alone is not a confirmed booking.
      const confirmed = (await this.client.calendar(current.date, current.date)).find(a => a.key === job.key);
      if (confirmed && [2, 8].includes(confirmed.status)) return this.finish(job.key, 'registered', 'Registration confirmed by the club');
      if (confirmed?.status === 4) return this.finish(job.key, 'waitlisted', 'Waitlist confirmed by the club');
      throw new Error('Booking response received; waiting for club confirmation');
    } catch (error) {
      if (error.code === 2 || error.code === 3) this.client.session = null;
      const nextAt = this.now() + Math.min(5000 * 2 ** Math.min(job.attempts, 3), 30000);
      const retry = nextAt <= job.dueAt + 120000;
      db.prepare('UPDATE jobs SET status=?,nextAt=?,message=?,updatedAt=? WHERE key=?').run(retry ? 'retry' : 'failed', nextAt, String(error.message).slice(0, 250), this.now(), job.key);
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Recover interrupted attempts by reconciling with the club before sending again.
      this.store.db.prepare("UPDATE jobs SET status='retry' WHERE status='running' AND updatedAt<?").run(this.now() - 45000);
      const jobs = this.store.db.prepare("SELECT * FROM jobs WHERE status IN ('pending','retry') AND nextAt<=? ORDER BY dueAt").all(this.now());
      for (const job of jobs) await this.attempt(job);
      const nextDue = this.store.db.prepare("SELECT MIN(nextAt) AS at FROM jobs WHERE status IN ('pending','retry')").get()?.at;
      if (this.now() - this.lastSync >= 300000 && (!nextDue || nextDue - this.now() > 30000)) {
        try { await this.sync(); }
        catch (e) { this.syncError = String(e.message).slice(0, 250); this.lastSync = this.now() - 240000; }
      }
    } finally { this.busy = false; }
  }
  arm() {
    clearTimeout(this.timer);
    const next = this.store.db.prepare("SELECT MIN(nextAt) AS at FROM jobs WHERE status IN ('pending','retry')").get()?.at;
    const delay = next ? Math.max(this.live ? 20 : 1000, Math.min(next - this.now(), 1000)) : 1000;
    this.timer = setTimeout(async () => { try { await this.tick(); } finally { this.arm(); } }, delay);
  }
  start() { this.arm(); }
  stop() { clearTimeout(this.timer); }
}
