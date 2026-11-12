import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Accounts, sessionCookie } from './accounts.mjs';
import { Fizikal } from './fizikal.mjs';
import { israelDate, shiftDate, matches } from './time.mjs';
import { singleBooking, cancelBooking } from './bookings.mjs';
const root = dirname(fileURLToPath(import.meta.url));
function send(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
async function body(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('JSON required');
  let value = ''; for await (const chunk of req) { value += chunk; if (value.length > 8192) throw new Error('Request too large'); }
  return JSON.parse(value || '{}');
}
function publicClass(a) { const { raw, ...rest } = a; return rest; }
const abVariant = accountId => createHash('sha256').update(accountId).digest()[0] < 128 ? 'A' : 'B';
const AB_EVENTS = ['dialog_opened', 'rule_created', 'single_booked'];
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/install.js': ['install.js', 'text/javascript'], '/sw.js': ['sw.js', 'text/javascript'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/offline.html': ['offline.html', 'text/html'], ...Object.fromEntries(['icon-192.png','icon-512.png','icon-maskable.png','apple-touch-icon.png'].map(name => ['/' + name, [name, 'image/png']])) };
export function createApplication(accounts, { secure = false } = {}) {
const failures = new Map();
const getToken = req => req.headers.cookie?.match(/(?:^|; )arlo_session=([^;]+)/)?.[1];
return http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (files[url.pathname] && req.method === 'GET') {
      const [file, type] = files[url.pathname]; res.writeHead(200, { 'Content-Type': type === 'image/png' ? type : `${type}; charset=utf-8` }); return res.end(await readFile(resolve(root, 'public', file)));
    }
    // Reject cross-origin writes, including login and credential submission.
    if (!['GET', 'HEAD'].includes(req.method) && (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host)) return send(res, 403, { error: 'Same-origin request required' });
    if (url.pathname === '/api/auth' && req.method === 'POST') {
      const address = req.socket.remoteAddress;
      const prior = failures.get(address);
      if (prior?.count >= 8 && prior.until > Date.now()) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const { phone, password } = await body(req);
      if (typeof phone !== 'string' || !/^[+\d -]{8,20}$/.test(phone) || typeof password !== 'string' || !password || password.length > 500) return send(res, 400, { error: 'Enter your Fizikal phone number and password' });
      failures.set(address, { count: prior?.until > Date.now() ? prior.count + 1 : 1, until: Date.now() + 900000 });
      try {
        const context = await accounts.login(phone.trim(), password);
        const oldToken = getToken(req); if (oldToken) accounts.logout(oldToken);
        const token = accounts.issue(context.account.id);
        res.setHeader('Set-Cookie', sessionCookie(token, secure));
        failures.delete(address);
        return send(res, 200, { ok: true, name: context.account.name });
      } catch { return send(res, 401, { error: 'Fizikal sign-in failed. Check your details or try again shortly.' }); }
    }
    const token = getToken(req);
    const context = accounts.authenticate(token);
    if (!context) return send(res, 401, { error: 'Sign in with your Fizikal account' });
    if (req.headers['x-arlo-account'] && req.headers['x-arlo-account'] !== context.account.id) return send(res, 409, { error: 'The signed-in account changed. Please sign in again.', code: 'ACCOUNT_CHANGED' });
    res.setHeader('Set-Cookie', sessionCookie(token, secure));
    const { store, client, scheduler, bookingLocks, schedule, memberReady } = context;
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      accounts.logout(token); res.setHeader('Set-Cookie', sessionCookie('', secure));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/bookings' && req.method === 'GET') {
      await memberReady();
      const start = israelDate();
      const classes = await client.upcoming(start, shiftDate(start, 60));
      return send(res, 200, { classes: classes.map(publicClass), fetchedAt: Date.now(), through: shiftDate(start, 60) });
    }
    if (['/api/bookings/register', '/api/bookings/cancel'].includes(url.pathname) && req.method === 'POST') {
      const { key, date, waitlist = false } = await body(req);
      if (typeof key !== 'string' || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof waitlist !== 'boolean') return send(res, 400, { error: 'Choose a class from the schedule' });
      await memberReady();
      if (bookingLocks.has(key) || store.db.prepare("SELECT key FROM jobs WHERE key=? AND status='running'").get(key)) return send(res, 409, { error: 'An operation for this class is already running. Refresh shortly.' });
      bookingLocks.add(key);
      try {
        const cancelling = url.pathname.endsWith('/cancel');
        // Persist an occurrence exclusion before cancelling, so a weekly worker cannot rebook it.
        if (cancelling) {
          const a = (await client.calendar(date, date)).find(a => a.key === key);
          if (a) {
            store.db.prepare(`INSERT INTO jobs(key,ruleId,dueAt,startsAt,status,nextAt,updatedAt,message,data) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status='cancelled',message=excluded.message,updatedAt=excluded.updatedAt`)
              .run(a.key, 'manual', a.dueAt, a.startsAt, 'cancelled', a.dueAt, Date.now(), 'This occurrence excluded by user', JSON.stringify(a));
          }
        }
        const result = cancelling ? await cancelBooking(client, key, date) : await singleBooking(client, key, date, waitlist);
        if (!cancelling) store.db.prepare('UPDATE jobs SET status=?,message=?,updatedAt=? WHERE key=?').run(result.status, 'One-time registration confirmed by club', Date.now(), key);
        return send(res, 200, result);
      } finally { bookingLocks.delete(key); }
    }
    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, {
        connected: !!store.get('credentials'), member: context.account.name, accountId: context.account.id, abVariant: abVariant(context.account.id),
        live: scheduler.live, lastSync: scheduler.lastSync || null, syncError: scheduler.syncError,
        timezone: 'Asia/Jerusalem', rules: store.rules(),
        jobs: store.db.prepare('SELECT key,ruleId,dueAt,startsAt,status,attempts,updatedAt,message,data FROM jobs ORDER BY dueAt DESC LIMIT 150').all().map(j => ({ ...j, data: publicClass(JSON.parse(j.data)) }))
      });
    }
    if (url.pathname === '/api/ab/event' && req.method === 'POST') {
      const { event } = await body(req);
      if (!AB_EVENTS.includes(event)) return send(res, 400, { error: 'Unknown event' });
      store.logAbEvent(abVariant(context.account.id), event);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/ab/report' && req.method === 'GET') {
      const report = { A: {}, B: {} };
      for (const c of accounts.contexts.values()) for (const { variant, event, count } of c.store.abCounts()) report[variant][event] = (report[variant][event] || 0) + count;
      for (const v of ['A', 'B']) { const r = report[v]; r.conversion = r.dialog_opened ? +(((r.rule_created || 0) / r.dialog_opened).toFixed(3)) : null; }
      return send(res, 200, report);
    }
    if (url.pathname === '/api/calendar' && req.method === 'GET') {
      const start = url.searchParams.get('start') || israelDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) return send(res, 400, { error: 'Invalid date' });
      const days = url.searchParams.get('days') === '1' ? 1 : 7;
      return send(res, 200, await schedule(start, days, url.searchParams.get('refresh') === '1'));
    }
    if (url.pathname === '/api/account' && req.method === 'POST') {
      const { phone, password } = await body(req);
      if (typeof phone !== 'string' || !/^[+\d -]{8,20}$/.test(phone) || typeof password !== 'string' || !password) return send(res, 400, { error: 'Enter your club phone number and password' });
      const verified = new Fizikal();
      const info = await verified.login(phone.trim(), password);
      if (`230:23:${verified.session.userId}` !== context.account.memberKey) return send(res, 409, { error: 'Sign out before switching to another Fizikal account' });
      client.session = verified.session; client.dayCache.clear();
      store.set('credentials', store.encrypt({ phone: phone.trim(), password }));
      scheduler.lastSync = 0;
      return send(res, 200, { ok: true, ...info });
    }
    if (url.pathname === '/api/account' && req.method === 'DELETE') {
      store.db.prepare("DELETE FROM settings WHERE key='credentials'").run(); client.session = null;
      for (const rule of store.rules()) { rule.enabled = false; store.db.prepare('UPDATE rules SET data=? WHERE id=?').run(JSON.stringify(rule), rule.id); }
      store.db.prepare("UPDATE jobs SET status='cancelled',message='Account disconnected' WHERE status IN ('pending','retry')").run();
      accounts.revokeAll(context.account.id); res.setHeader('Set-Cookie', sessionCookie('', secure));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/rules' && req.method === 'POST') {
      const { key, start, waitlist = false, pinInstructor = false, once = false } = await body(req);
      if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(start) || typeof key !== 'string' || typeof waitlist !== 'boolean' || typeof pinInstructor !== 'boolean' || typeof once !== 'boolean') return send(res, 400, { error: 'Choose a class from the schedule' });
      const a = (await client.calendar(start, shiftDate(start, 6))).find(a => a.key === key);
      if (!a) return send(res, 409, { error: 'Class changed. Refresh the schedule.' });
      if (a.paid || a.seatsMap || a.raw.RequireReserve || a.raw.HasCourt) return send(res, 400, { error: 'This class requires manual booking on Fizikal' });
      if (once && a.dueAt <= Date.now()) return send(res, 400, { error: 'This class is already open. Register for it directly.' });
      if (store.rules().some(r => once ? r.once === a.key || (!r.once && matches(r, a)) : !r.once && r.lessonId === a.lessonId && r.weekday === a.weekday && r.time === a.time)) return send(res, 409, { error: once ? 'This class is already scheduled' : 'A weekly rule already exists for this class' });
      const rule = { id: randomUUID(), lessonId: a.lessonId, name: a.name, weekday: a.weekday, time: a.time, instructor: a.instructor, instructorId: a.instructorId, waitlist, pinInstructor, enabled: true, createdAt: Date.now(), ...(once ? { once: a.key, startsAt: a.startsAt } : {}) };
      store.db.prepare('INSERT INTO rules VALUES (?,?)').run(rule.id, JSON.stringify(rule));
      scheduler.lastSync = 0;
      return send(res, 201, { rule });
    }
    if (url.pathname.startsWith('/api/rules/') && ['PATCH', 'DELETE'].includes(req.method)) {
      const id = url.pathname.slice('/api/rules/'.length), rule = store.rules().find(r => r.id === id);
      if (!rule) return send(res, 404, { error: 'Rule not found' });
      if (req.method === 'DELETE') store.db.prepare('DELETE FROM rules WHERE id=?').run(id);
      else {
        const change = await body(req);
        for (const key of ['enabled', 'waitlist', 'pinInstructor']) if (key in change) {
          if (typeof change[key] !== 'boolean') return send(res, 400, { error: 'Invalid rule setting' }); rule[key] = change[key];
        }
        store.db.prepare('UPDATE rules SET data=? WHERE id=?').run(JSON.stringify(rule), id);
      }
      // Pause/remove takes effect synchronously, even when Fizikal is unavailable.
      store.db.prepare("UPDATE jobs SET status='cancelled',message='Weekly rule changed' WHERE ruleId=? AND status IN ('pending','retry')").run(id);
      // Future cancelled occurrences may be re-created explicitly when resuming.
      if (req.method === 'PATCH' && rule.enabled) store.db.prepare("DELETE FROM jobs WHERE ruleId=? AND status='cancelled' AND dueAt>?").run(id, Date.now());
      scheduler.lastSync = 0; return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, 400, { error: String(e.message).slice(0, 250) }); }
});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3000);
  const secure = process.env.COOKIE_SECURE === 'true';
  if (host !== '127.0.0.1' && (!process.env.ENCRYPTION_KEY || !secure)) throw new Error('Cloud mode requires ENCRYPTION_KEY and COOKIE_SECURE=true');
  const accounts = new Accounts(resolve(process.env.DATA_DIR || './data'), process.env.ENCRYPTION_KEY, { live: process.env.BOOKING_ENABLED === 'true' });
  accounts.start();
  const server = createApplication(accounts, { secure });
  server.listen(port, host, () => console.log(`Arlo Auto: http://${host}:${port} · Personal Fizikal accounts · Automatic booking ${process.env.BOOKING_ENABLED === 'true' ? 'enabled' : 'paused'}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { accounts.close(); process.exit(0); }));
}
