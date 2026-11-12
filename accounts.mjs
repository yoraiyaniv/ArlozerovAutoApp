import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { openStore } from './store.mjs';
import { Fizikal } from './fizikal.mjs';
import { Scheduler } from './scheduler.mjs';
import { israelDate, shiftDate } from './time.mjs';
const YEAR = 365 * 86400000;
const digest = token => createHash('sha256').update(token).digest('hex');
const publicClass = ({ raw, ...a }) => a;
export class Accounts {
  constructor(dir, key, { live = false, clientFactory = () => new Fizikal(), now = () => Date.now(), workers = true } = {}) {
    this.dir = dir; this.key = key; this.live = live; this.clientFactory = clientFactory; this.now = now; this.workers = workers;
    this.root = openStore(dir, key); this.contexts = new Map();
    this.root.db.exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,memberKey TEXT UNIQUE NOT NULL,name TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(hash TEXT PRIMARY KEY,accountId TEXT NOT NULL,expiresAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS devices_account ON devices(accountId);`);
  }
  context(account) {
    if (this.contexts.has(account.id)) return this.contexts.get(account.id);
    const store = openStore(resolve(this.dir, 'accounts', account.id), this.key);
    const client = this.clientFactory();
    const scheduler = new Scheduler(store, client, { live: this.live, now: this.now });
    const connectSaved = scheduler.connect.bind(scheduler);
    const bookingLocks = new Set(), calendarLoads = new Map();
    scheduler.blockedKeys = bookingLocks;
    let reconnecting;
    const memberReady = async () => {
      if (client.session) return true;
      if (!reconnecting) reconnecting = connectSaved().finally(() => { reconnecting = null; });
      if (!(await reconnecting)) throw new Error('Sign in with your Fizikal account again');
      if (`230:23:${client.session.userId}` !== account.memberKey) {
        client.session = null; throw new Error('Your club membership changed. Sign in again.');
      }
      return true;
    };
    client.reauthenticate = async () => { await memberReady(); return true; };
    scheduler.connect = memberReady;
    const load = async (start, days, force) => {
      const key = `calendar:${start}:${days}`, saved = store.get(key);
      const cached = saved ? JSON.parse(saved) : null;
      const refresh = () => {
        if (!calendarLoads.has(key)) calendarLoads.set(key, client.calendar(start, shiftDate(start, days - 1)).then(classes => {
          const result = { classes: classes.map(publicClass), fetchedAt: this.now() };
          store.set(key, JSON.stringify(result)); return result;
        }).finally(() => calendarLoads.delete(key)));
        return calendarLoads.get(key);
      };
      if (cached && !force) {
        if (this.now() - cached.fetchedAt > 30000) memberReady().then(refresh).catch(() => {});
        return { ...cached, stale: this.now() - cached.fetchedAt > 30000 };
      }
      await memberReady();
      try { return await refresh(); } catch (e) { if (cached) return { ...cached, stale: true, failed: true }; throw e; }
    };
    // Fizikal takes seconds per day, so save the coming week in the background after a user request.
    let warmedAt = 0, warming = false;
    const warm = async () => {
      const first = israelDate(this.now());
      for (let i = 0; i < 7; i++) {
        const day = shiftDate(first, i), saved = store.get(`calendar:${day}:1`);
        if (saved && this.now() - JSON.parse(saved).fetchedAt < 300000) continue;
        try { await load(day, 1, true); } catch { return; }
      }
    };
    const schedule = async (start, days = 1, force = false) => {
      const result = await load(start, days, force);
      if (this.workers && !force && !warming && this.now() - warmedAt > 300000) {
        warmedAt = this.now(); warming = true; warm().finally(() => { warming = false; });
      }
      return result;
    };
    const context = { account, store, client, scheduler, bookingLocks, schedule, memberReady };
    this.contexts.set(account.id, context);
    if (this.workers) scheduler.start();
    return context;
  }
  start() {
    for (const account of this.root.db.prepare('SELECT * FROM accounts').all()) this.context(account);
  }
  async login(phone, password) {
    const verified = this.clientFactory();
    await verified.login(phone, password);
    const memberKey = `230:23:${verified.session.userId}`;
    let account = this.root.db.prepare('SELECT * FROM accounts WHERE memberKey=?').get(memberKey);
    if (!account) {
      account = { id: randomUUID(), memberKey, name: verified.session.name || 'Member', createdAt: this.now() };
      this.root.db.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run(account.id, memberKey, account.name, account.createdAt);
    }
    const context = this.context(account);
    context.client.session = verified.session;
    context.client.dayCache?.clear();
    context.store.set('credentials', context.store.encrypt({ phone, password }));
    this.root.db.prepare('UPDATE accounts SET name=? WHERE id=?').run(verified.session.name || 'Member', account.id);
    context.account.name = verified.session.name || 'Member';
    // Adopt old single-account data only after authenticating that same Fizikal membership.
    const legacy = this.root.get('credentials');
    if (legacy && !this.root.get('legacy_migrated')) {
      const saved = this.root.decrypt(legacy);
      if (saved.phone.replace(/[ -]/g, '') === phone.replace(/[ -]/g, '')) {
        try {
          const oldClient = this.clientFactory(); await oldClient.login(saved.phone, saved.password);
          if (`230:23:${oldClient.session.userId}` === memberKey) this.migrateLegacy(context);
        } catch { context.store.event('Legacy account migration needs reconnection; original data preserved'); }
      }
    }
    context.scheduler.lastSync = 0;
    return context;
  }
  migrateLegacy(context) {
    const db = context.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of this.root.db.prepare('SELECT * FROM rules').all()) db.prepare('INSERT OR IGNORE INTO rules VALUES (?,?)').run(r.id, r.data);
      for (const j of this.root.db.prepare('SELECT * FROM jobs').all()) db.prepare('INSERT OR IGNORE INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)').run(j.key,j.ruleId,j.dueAt,j.startsAt,j.status,j.attempts,j.nextAt,j.updatedAt,j.message,j.data);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    this.root.set('legacy_migrated', context.account.id);
    this.root.db.prepare("DELETE FROM settings WHERE key='credentials'").run();
  }
  issue(accountId) {
    const token = randomBytes(32).toString('hex');
    this.root.db.prepare('INSERT INTO devices VALUES (?,?,?)').run(digest(token), accountId, this.now() + YEAR);
    return token;
  }
  authenticate(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const device = this.root.db.prepare('SELECT * FROM devices WHERE hash=? AND expiresAt>?').get(digest(token), this.now());
    if (!device) return null;
    const account = this.root.db.prepare('SELECT * FROM accounts WHERE id=?').get(device.accountId);
    if (!account) return null;
    this.root.db.prepare('UPDATE devices SET expiresAt=? WHERE hash=?').run(this.now() + YEAR, digest(token));
    return this.context(account);
  }
  logout(token) { if (token) this.root.db.prepare('DELETE FROM devices WHERE hash=?').run(digest(token)); }
  revokeAll(accountId) { this.root.db.prepare('DELETE FROM devices WHERE accountId=?').run(accountId); }
  close() { for (const c of this.contexts.values()) { c.scheduler.stop(); c.store.db.close(); } this.root.db.close(); }
}
export function sessionCookie(token, secure = false) {
  return `arlo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 365 * 86400 : 0}${secure ? '; Secure' : ''}`;
}
