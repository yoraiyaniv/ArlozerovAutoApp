import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
import { Scheduler } from '../scheduler.mjs';
import { normalize, matches } from '../time.mjs';
const cls = (day, status) => normalize({ LessonID: 9, ID: 0, Name: 'Yoga', StartDateTimeJson: `2026-11-${day}T09:50:00+02:00`, StartHour: '095000', DurationInMinutes: 45, Status: status, EmployeeID: 1 });
function fixture(t, { live = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arlo-once-')), store = openStore(dir);
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true }); });
  const target = cls('14', 6), nextWeek = cls('21', 6);
  let now = target.dueAt - 3600000, status = 6, sends = 0;
  const rule = { id: 'once1', lessonId: target.lessonId, weekday: target.weekday, time: target.time, once: target.key, startsAt: target.startsAt, enabled: true, waitlist: false };
  store.db.prepare('INSERT INTO rules VALUES (?,?)').run(rule.id, JSON.stringify(rule));
  store.set('credentials', store.encrypt({ phone: '0500000000', password: 'test-only' }));
  const client = { session: { userId: 1 }, async calendar() { return [{ ...target, status }, { ...nextWeek, status: 6 }]; }, async register() { sends++; status = 2; } };
  const scheduler = new Scheduler(store, client, { live, now: () => now });
  return { store, scheduler, target, nextWeek, rule, setNow(v) { now = v; }, setStatus(v) { status = v; }, sends: () => sends };
}
test('a one-time rule matches only its own occurrence', t => {
  const f = fixture(t);
  assert.ok(matches(f.rule, f.target));
  assert.ok(!matches(f.rule, f.nextWeek));
});
test('a not-yet-open class is registered at the 24 hour mark, only once, then the rule removes itself', async t => {
  const f = fixture(t); await f.scheduler.sync();
  const jobs = () => f.store.db.prepare('SELECT key,status FROM jobs').all();
  assert.deepEqual(jobs().map(j => j.key), [f.target.key]);
  await f.scheduler.tick(); assert.equal(f.sends(), 0);
  f.setNow(f.target.dueAt); f.setStatus(3); await f.scheduler.tick();
  assert.equal(f.sends(), 1); assert.equal(jobs()[0].status, 'registered');
  assert.equal(f.store.rules().length, 0);
  await f.scheduler.sync(); assert.equal(jobs().length, 1);
});
test('a one-time rule is cleaned up when its window is missed or in preview mode', async t => {
  const f = fixture(t, { live: false }); await f.scheduler.sync();
  f.setNow(f.target.dueAt + 130000); await f.scheduler.tick();
  assert.equal(f.sends(), 0); assert.equal(f.store.db.prepare('SELECT status FROM jobs').get().status, 'missed');
  assert.equal(f.store.rules().length, 0);
});
