import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
import { Scheduler } from '../scheduler.mjs';
import { Fizikal } from '../fizikal.mjs';
import { normalize, matches, DAY, israelDate, weekday } from '../time.mjs';
import { outcomeNotice, ruleNotice } from '../push.mjs';
const SYNC_CANCEL = 'Class removed, changed, or weekly rule paused';
function fixture(t, { live = true, ruleExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arlo-rel-')), store = openStore(dir);
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true }); });
  const a = normalize({ LessonID: 5, ID: 0, Name: 'Yoga', StartDateTimeJson: '2026-11-14T09:50:00+02:00', StartHour: '095000', DurationInMinutes: 45, Status: 6, EmployeeID: 1 });
  const f = { store, a, now: a.dueAt - 600000, status: 6, sends: 0, events: [], reads: [], list: null, gate: null };
  const rule = { id: 'r1', lessonId: a.lessonId, weekday: a.weekday, time: a.time, enabled: true, waitlist: false, ...ruleExtra };
  store.db.prepare('INSERT INTO rules VALUES (?,?)').run(rule.id, JSON.stringify(rule));
  store.set('credentials', store.encrypt({ phone: '0500000000', password: 'test-only' }));
  f.client = {
    session: { userId: 1 },
    async calendar(start, end, guest, fresh) {
      if (start === end) f.reads.push(fresh);
      else if (f.gate) await f.gate;
      return f.list ? f.list() : [{ ...a, status: f.status }];
    },
    async register() { f.sends++; f.status = 2; }
  };
  f.scheduler = new Scheduler(store, f.client, { live, now: () => f.now });
  f.scheduler.onEvent = (job, stage, message) => f.events.push([stage, message]);
  f.job = () => store.db.prepare('SELECT * FROM jobs').get();
  return f;
}
test('a booking attempt reads the club fresh, never a cached copy', async t => {
  const f = fixture(t); await f.scheduler.sync(); f.now = f.a.dueAt; f.status = 3; await f.scheduler.tick();
  assert.equal(f.sends, 1); assert.ok(f.reads.length >= 2 && f.reads.every(fresh => fresh === true));
});
test('the whole lifecycle is announced once: starting, first failure, then the result', async t => {
  const f = fixture(t); await f.scheduler.sync();
  f.now = f.a.dueAt; await f.scheduler.tick();
  f.now += 2001; await f.scheduler.tick(); f.now += 4001; await f.scheduler.tick();
  assert.equal(f.job().status, 'retry');
  f.status = 3; f.now += 8001; await f.scheduler.tick();
  assert.deepEqual(f.events.map(e => e[0]), ['starting', 'retrying', 'registered']);
});
test('a request that keeps failing is retried through the window, then reported as failed', async t => {
  const f = fixture(t); await f.scheduler.sync();
  f.now = f.a.dueAt; let tries = 0;
  while (!['failed', 'registered'].includes(f.job().status) && f.now < f.a.dueAt + 200000) { await f.scheduler.tick(); tries++; f.now += 1000; }
  assert.equal(f.job().status, 'failed'); assert.ok(tries > 100, 'polled while waiting'); assert.equal(f.sends, 0);
  const attempts = f.job().attempts; assert.ok(attempts >= 6, `retried ${attempts} times inside the two minute window`);
  assert.equal(f.events.filter(e => e[0] === 'failed').length, 1); assert.match(f.events.at(-1)[1], /not open yet/);
});
test('a failed final attempt of a one-time rule still removes the rule', async t => {
  const f = fixture(t, { ruleExtra: { once: normalize({ LessonID: 5, StartDateTimeJson: '2026-11-14T09:50:00+02:00', StartHour: '095000' }).key } });
  await f.scheduler.sync(); f.now = f.a.dueAt;
  while (f.job().status !== 'failed' && f.now < f.a.dueAt + 200000) { await f.scheduler.tick(); f.now += 1000; }
  assert.equal(f.job().status, 'failed'); assert.equal(f.store.rules().length, 0);
});
test('a slow background refresh never delays a booking that is due', async t => {
  const f = fixture(t); await f.scheduler.sync(); f.scheduler.lastSync = 0;
  f.now = f.a.dueAt - 100000; let release; f.gate = new Promise(resolve => { release = resolve; });
  const refresh = f.scheduler.maybeSync(); assert.ok(f.scheduler.syncing, 'refresh is running');
  f.now = f.a.dueAt; f.status = 3; await f.scheduler.runDue();
  assert.equal(f.sends, 1); assert.equal(f.job().status, 'registered');
  release(); await refresh;
});
test('no background refresh starts within 90 seconds of an opening', async t => {
  const f = fixture(t); await f.scheduler.sync(); f.scheduler.lastSync = 0; f.reads.length = 0;
  let wide = 0; const calendar = f.client.calendar; f.client.calendar = async (s, e, ...rest) => { if (s !== e) wide++; return calendar.call(f.client, s, e, ...rest); };
  f.now = f.a.dueAt - 60000; await f.scheduler.maybeSync(); assert.equal(wide, 0);
  f.now = f.a.dueAt - 100000; await f.scheduler.maybeSync(); assert.ok(wide > 0);
});
test('a partial club response cannot permanently cancel a queued booking', async t => {
  const f = fixture(t); f.list = () => []; await f.scheduler.sync();
  assert.equal(f.job(), undefined, 'nothing queued from an empty answer');
  f.list = null; await f.scheduler.sync(); assert.equal(f.job().status, 'pending');
  f.list = () => []; f.scheduler.lastSync = 0; await f.scheduler.sync();
  assert.equal(f.job().status, 'cancelled'); assert.equal(f.job().message, SYNC_CANCEL);
  f.list = null; await f.scheduler.sync(); assert.equal(f.job().status, 'pending', 'revived when the class is back');
  f.now = f.a.dueAt; f.status = 3; await f.scheduler.tick(); assert.equal(f.job().status, 'registered');
});
test('an occurrence the member cancelled on purpose is never revived', async t => {
  const f = fixture(t); await f.scheduler.sync();
  f.store.db.prepare("UPDATE jobs SET status='cancelled',message='This occurrence excluded by user'").run();
  await f.scheduler.sync(); assert.equal(f.job().status, 'cancelled');
});
test('a revived booking after the window closed is not resurrected', async t => {
  const f = fixture(t); await f.scheduler.sync();
  f.store.db.prepare("UPDATE jobs SET status='cancelled',message=?").run(SYNC_CANCEL);
  f.now = f.a.dueAt + 121000; await f.scheduler.sync(); assert.equal(f.job().status, 'cancelled');
});
test('target time is exactly 24 elapsed hours before class, across DST changes and midnight', () => {
  const cases = ['2026-03-27T08:00:00+02:00', '2026-03-28T08:00:00+02:00', '2026-03-29T08:00:00+03:00', '2026-10-24T08:00:00+03:00', '2026-10-25T08:00:00+02:00', '2026-10-26T00:30:00+02:00', '2026-06-30T23:45:00+03:00'];
  for (const iso of cases) {
    const a = normalize({ LessonID: 1, StartHour: iso.slice(11, 13) + iso.slice(14, 16) + '00', StartDateTimeJson: iso });
    assert.equal(a.startsAt - a.dueAt, DAY, iso);
    assert.equal(a.date, iso.slice(0, 10), `${iso} keeps its club-local date`);
    assert.equal(a.weekday, weekday(iso.slice(0, 10)), `${iso} weekday follows the club date, not UTC`);
    assert.equal(a.time, iso.slice(11, 16)); assert.equal(israelDate(a.startsAt), iso.slice(0, 10));
  }
});
test('a weekly rule matches the same weekday and time each week, and only those', () => {
  const at = iso => normalize({ LessonID: 3, EmployeeID: 9, StartHour: iso.slice(11, 13) + iso.slice(14, 16) + '00', StartDateTimeJson: iso });
  const base = at('2026-11-14T09:50:00+02:00'), rule = { lessonId: 3, weekday: base.weekday, time: base.time };
  assert.ok(matches(rule, at('2026-11-21T09:50:00+02:00')));
  assert.ok(matches(rule, at('2026-12-26T09:50:00+02:00')));
  assert.ok(!matches(rule, at('2026-11-15T09:50:00+02:00')), 'different weekday');
  assert.ok(!matches(rule, at('2026-11-21T10:50:00+02:00')), 'different time');
  assert.ok(!matches({ ...rule, lessonId: 4 }, base), 'different class');
});
test('club reads are retried after a dropped connection or a server error, but not forever', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const client = new Fizikal(); client.config = { server: 'https://m.fizikal.co.il/wsw', headers: {} }; client.session = { token: 't', userId: 1 }; client.retryDelay = 0;
  let calls = 0;
  globalThis.fetch = async () => { calls++; if (calls === 1) throw new TypeError('fetch failed'); if (calls === 2) return { ok: false, status: 502 }; return { ok: true, status: 200, json: async () => ({ ResultCode: 1, Data: ['ok'] }) }; };
  assert.deepEqual(await client.call('/JActivityService.svc/User'), ['ok']); assert.equal(calls, 3);
  calls = 0; globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
  await assert.rejects(client.call('/JActivityService.svc/User'), /fetch failed/); assert.equal(calls, 3);
  calls = 0; globalThis.fetch = async () => { calls++; throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); };
  await assert.rejects(client.call('/JActivityService.svc/User'), /timed out/); assert.equal(calls, 1, 'a 45 second timeout is not repeated');
  calls = 0; globalThis.fetch = async () => { calls++; return { ok: false, status: 404 }; };
  await assert.rejects(client.call('/JActivityService.svc/User'), /HTTP 404/); assert.equal(calls, 1, 'client errors are not retried');
});
test('a booking write is never retried by the client', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const client = new Fizikal(); client.config = { server: 'https://m.fizikal.co.il/wsw', headers: {} }; client.session = { token: 't', userId: 1 }; client.retryDelay = 0;
  let calls = 0; globalThis.fetch = async () => { calls++; return { ok: false, status: 503 }; };
  await assert.rejects(client.call('/JActivityService.svc/User', {}, 'PUT', {}), /HTTP 503/); assert.equal(calls, 1);
  calls = 0; globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
  await assert.rejects(client.call('/JActivityService.svc/User', {}, 'DELETE'), /fetch failed/); assert.equal(calls, 1);
});
test('notification text covers the whole lifecycle', () => {
  const job = { key: 'k', startsAt: Date.parse('2026-11-14T09:50:00+02:00'), data: JSON.stringify({ name: 'Yoga' }) };
  assert.equal(outcomeNotice(job, 'starting', 'Trying to register now.', true).title, 'Booking now: Yoga');
  assert.match(outcomeNotice(job, 'retrying', 'Registration is not open yet Trying again.', true).body, /Trying again/);
  assert.equal(outcomeNotice(job, 'retrying', 'x', true).tag, 'k', 'one notification per class, updated in place');
  const weekly = { id: 'r', name: 'Yoga', weekday: 6, time: '09:50' }, once = { id: 'o', name: 'Yoga', once: 'k', startsAt: job.startsAt };
  assert.equal(ruleNotice('saved', weekly, true).title, 'Weekly routine saved: Yoga'); assert.match(ruleNotice('saved', weekly, true).body, /Every Saturday at 09:50/);
  assert.match(ruleNotice('saved', weekly, false).body, /paused/);
  assert.equal(ruleNotice('saved', once, true).title, 'Scheduled: Yoga'); assert.match(ruleNotice('saved', once, true).body, /Sat 14 Nov/);
  for (const kind of ['paused', 'resumed', 'removed']) assert.ok(ruleNotice(kind, weekly, true).title.startsWith('Routine '));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('the timer loop keeps booking on time while a refresh is still running', async t => {
  const f = fixture(t); await f.scheduler.sync(); f.scheduler.lastSync = 0;
  f.now = f.a.dueAt - 100000; f.status = 3; let release; f.gate = new Promise(resolve => { release = resolve; });
  f.scheduler.start();
  await sleep(1150); assert.ok(f.scheduler.syncing, 'the refresh has started and is blocked');
  f.now = f.a.dueAt;
  for (let i = 0; i < 40 && f.job().status !== 'registered'; i++) await sleep(100);
  assert.equal(f.job().status, 'registered'); assert.ok(f.scheduler.syncing, 'while the refresh is still running');
  f.scheduler.stop(); release(); await sleep(50);
});
