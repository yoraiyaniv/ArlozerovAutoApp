import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../accounts.mjs';
import { createApplication } from '../server.mjs';
import { createPush, outcomeNotice, validSubscription } from '../push.mjs';
import { normalize } from '../time.mjs';
const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const sub = (path = 'abc123') => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/' + path, keys });
const setup = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const clientFactory = () => ({ session: null, dayCache: new Map(), async login(phone) { this.session = { userId: Number(phone.slice(-1)), token: 't', name: 'M' }; } });
  const accounts = new Accounts(dir, undefined, { clientFactory, workers: false });
  t.after(() => { accounts.close(); rmSync(dir, { recursive: true }); });
  return accounts;
};
test('only genuine browser push services with valid keys are accepted', () => {
  assert.ok(validSubscription(sub()));
  assert.ok(validSubscription({ endpoint: 'https://web.push.apple.com/QGx', keys }));
  assert.ok(validSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys }));
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://evil.example/fcm.googleapis.com/', 'https://fcm.googleapis.com.evil.example/x', 'https://push.apple.com.evil.example/x'])
    assert.ok(!validSubscription({ endpoint, keys }), endpoint);
  assert.ok(!validSubscription({ endpoint: sub().endpoint, keys: { p256dh: 'x', auth: 'y' } }));
  assert.ok(!validSubscription(null));
});
test('notifications reach every saved phone and dead subscriptions are pruned', async t => {
  const accounts = setup(t, 'arlo-push-'), ctx = await accounts.login('0500000001', 'x'), sent = [];
  ctx.store.addPush(sub('alive')); ctx.store.addPush(sub('gone')); ctx.store.addPush(sub('flaky'));
  const push = createPush(accounts.root, { send: async (s, body) => { sent.push([s.endpoint, JSON.parse(body)]); if (s.endpoint.endsWith('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 }); if (s.endpoint.endsWith('flaky')) throw Object.assign(new Error('busy'), { statusCode: 500 }); } });
  await push.notify(ctx.store, { title: 'Hello' });
  assert.equal(sent.length, 3);
  assert.deepEqual(ctx.store.pushSubs().map(s => s.endpoint.split('/').pop()).sort(), ['alive', 'flaky']);
  assert.equal(push.publicKey, createPush(accounts.root).publicKey, 'VAPID key persists across restarts');
});
test('notification text covers each outcome and explains preview-mode misses', () => {
  const job = { key: 'k1', startsAt: Date.parse('2026-11-14T09:50:00+02:00'), data: JSON.stringify({ name: 'Yoga' }) };
  const registered = outcomeNotice(job, 'registered', 'Registration confirmed by the club', true);
  assert.equal(registered.title, 'Registered: Yoga'); assert.match(registered.body, /Sat 14 Nov.*09:50.*confirmed/); assert.equal(registered.tag, 'k1'); assert.equal(registered.url, '/#activity');
  assert.equal(outcomeNotice(job, 'waitlisted', 'x', true).title, 'On the waitlist: Yoga');
  assert.equal(outcomeNotice(job, 'failed', 'Class full', true).title, 'Booking failed: Yoga');
  assert.match(outcomeNotice(job, 'missed', 'Opening window missed', false).body, /automatic booking is paused/);
  assert.match(outcomeNotice(job, 'missed', 'Opening window missed', true).body, /Opening window missed/);
  assert.equal(outcomeNotice(job, 'cancelled', 'x', true).title, 'Booking cancelled: Yoga');
});
test('finishing a booking sends the account its notification', async t => {
  const accounts = setup(t, 'arlo-push-final-'), ctx = await accounts.login('0500000001', 'x'), sent = [];
  ctx.store.addPush(sub());
  accounts.push = createPush(accounts.root, { send: async (s, body) => { sent.push(JSON.parse(body)); } });
  const data = JSON.stringify({ name: 'Pilates', date: '2026-11-14' });
  ctx.store.db.prepare("INSERT INTO jobs(key,ruleId,dueAt,startsAt,status,nextAt,updatedAt,data) VALUES ('j1','r1',1,?,'running',1,1,?)").run(Date.parse('2026-11-14T09:50:00+02:00'), data);
  ctx.scheduler.finish('j1', 'registered', 'Registration confirmed by the club');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1); assert.equal(sent[0].title, 'Registered: Pilates');
  ctx.scheduler.finish('j1', 'retry', 'not final'); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent.length, 1, 'non-final states do not notify');
  accounts.push = { notify: async () => { throw new Error('push service down'); } };
  ctx.scheduler.finish('j1', 'failed', 'x'); assert.equal(ctx.store.db.prepare("SELECT status FROM jobs WHERE key='j1'").get().status, 'failed', 'a push failure never affects the booking');
});
test('subscription endpoints require sign-in, validate input, and keep one phone with one account', async t => {
  const accounts = setup(t, 'arlo-push-http-'), server = createApplication(accounts);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function req(path, cookie, method = 'GET', data) {
    const res = await fetch(origin + '/api/' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { status: res.status, data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  assert.equal((await req('push/key')).status, 401);
  const a = await req('auth', null, 'POST', { phone: '0500000001', password: 'x' }), b = await req('auth', null, 'POST', { phone: '0500000002', password: 'x' });
  assert.equal((await req('push/key', a.cookie)).data.publicKey, accounts.push.publicKey);
  assert.equal((await req('push/subscribe', a.cookie, 'POST', { subscription: { endpoint: 'https://127.0.0.1/x', keys } })).status, 400);
  assert.equal((await req('push/subscribe', a.cookie, 'POST', { subscription: sub('phone') })).status, 200);
  const ctxA = [...accounts.contexts.values()].find(c => c.account.name && c.store.pushSubs().length), idA = ctxA.account.id;
  assert.equal(ctxA.store.pushSubs().length, 1);
  assert.equal((await req('push/subscribe', b.cookie, 'POST', { subscription: sub('phone') })).status, 200);
  assert.equal(accounts.contexts.get(idA).store.pushSubs().length, 0, 'the phone moved to the new account');
  const total = [...accounts.contexts.values()].reduce((n, c) => n + c.store.pushSubs().length, 0); assert.equal(total, 1);
  assert.equal((await req('push/unsubscribe', b.cookie, 'POST', { endpoint: sub('phone').endpoint })).status, 200);
  assert.equal([...accounts.contexts.values()].reduce((n, c) => n + c.store.pushSubs().length, 0), 0);
  await req('push/subscribe', b.cookie, 'POST', { subscription: sub('again') });
  await req('account', b.cookie, 'DELETE');
  assert.equal([...accounts.contexts.values()].reduce((n, c) => n + c.store.pushSubs().length, 0), 0, 'disconnecting removes every saved phone');
});
test('registering and cancelling by hand each send a notification, repeats do not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'arlo-push-manual-'));
  let status = 3;
  const clientFactory = () => ({ session: null, dayCache: new Map(),
    async login() { this.session = { userId: 1, token: 't', name: 'M' }; },
    async calendar() { return [normalize({ LessonID: 7, ID: 0, Name: 'Yoga', StartDateTimeJson: '2050-10-28T19:00:00+02:00', StartHour: '190000', DurationInMinutes: 45, Status: status })]; },
    async upcoming() { return (await this.calendar()).filter(a => [2, 4].includes(a.status)); },
    async register() { status = 2; }, async cancel() { status = 3; } });
  const accounts = new Accounts(dir, undefined, { clientFactory, workers: false }), server = createApplication(accounts), sent = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); accounts.close(); rmSync(dir, { recursive: true }); });
  accounts.push = createPush(accounts.root, { send: async (s, body) => { sent.push(JSON.parse(body)); } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, cookie, data) => { const res = await fetch(origin + '/api/' + path, { method: data ? 'POST' : 'GET', headers: { Origin: origin, Cookie: cookie, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }); return res.json(); };
  const login = await fetch(origin + '/api/auth', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0500000001', password: 'x' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  [...accounts.contexts.values()][0].store.addPush(sub());
  const cls = (await req('calendar?start=2050-10-28&days=1', cookie)).classes[0], pause = () => new Promise(resolve => setTimeout(resolve, 30));
  await req('bookings/register', cookie, { key: cls.key, date: cls.date }); await pause();
  assert.equal(sent.length, 1); assert.equal(sent[0].title, 'Registered: Yoga'); assert.match(sent[0].body, /Fri 28 Oct, 20:00.*confirmed/);
  await req('bookings/register', cookie, { key: cls.key, date: cls.date }); await pause();
  assert.equal(sent.length, 1, 'registering again changes nothing, so no notification');
  await req('bookings/cancel', cookie, { key: cls.key, date: cls.date }); await pause();
  assert.equal(sent.length, 2); assert.equal(sent[1].title, 'Cancelled: Yoga'); assert.match(sent[1].body, /Cancellation confirmed/);
  await req('bookings/cancel', cookie, { key: cls.key, date: cls.date }); await pause();
  assert.equal(sent.length, 2, 'cancelling again changes nothing, so no notification');
});
test('saving, pausing, resuming and removing a routine each send a notification', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'arlo-push-rules-'));
  const clientFactory = () => ({ session: null, dayCache: new Map(), async login() { this.session = { userId: 1, token: 't', name: 'M' }; },
    async calendar() { return [normalize({ LessonID: 7, ID: 0, Name: 'Yoga', StartDateTimeJson: '2050-10-28T19:00:00+02:00', StartHour: '190000', DurationInMinutes: 45, Status: 3 })]; } });
  const accounts = new Accounts(dir, undefined, { clientFactory, workers: false }), server = createApplication(accounts), sent = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); accounts.close(); rmSync(dir, { recursive: true }); });
  accounts.push = createPush(accounts.root, { send: async (s, body) => { sent.push(JSON.parse(body)); } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, cookie, method = 'GET', data) => { const res = await fetch(origin + '/api/' + path, { method, headers: { Origin: origin, Cookie: cookie, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }); return res.json(); };
  const login = await fetch(origin + '/api/auth', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0500000001', password: 'x' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], pause = () => new Promise(resolve => setTimeout(resolve, 30));
  [...accounts.contexts.values()][0].store.addPush(sub());
  const cls = (await req('calendar?start=2050-10-28&days=1', cookie)).classes[0];
  const { rule } = await req('rules', cookie, 'POST', { key: cls.key, start: cls.date }); await pause();
  assert.equal(sent.at(-1).title, 'Weekly routine saved: Yoga'); assert.match(sent.at(-1).body, /paused/, 'preview mode says nothing will be booked');
  await req('rules/' + rule.id, cookie, 'PATCH', { enabled: false }); await pause(); assert.equal(sent.at(-1).title, 'Routine paused: Yoga');
  await req('rules/' + rule.id, cookie, 'PATCH', { waitlist: true }); await pause(); assert.equal(sent.length, 2, 'changing only the waitlist option is not announced');
  await req('rules/' + rule.id, cookie, 'PATCH', { enabled: true }); await pause(); assert.equal(sent.at(-1).title, 'Routine resumed: Yoga');
  await req('rules/' + rule.id, cookie, 'DELETE'); await pause(); assert.equal(sent.at(-1).title, 'Routine removed: Yoga'); assert.equal(sent.length, 4);
  const once = await req('rules', cookie, 'POST', { key: cls.key, start: cls.date, once: true }); await pause();
  assert.equal(sent.at(-1).title, 'Scheduled: Yoga'); assert.equal(once.rule.once, cls.key);
});
