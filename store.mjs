import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export function openStore(dir, configuredKey) {
  mkdirSync(dir, { recursive: true });
  const keyFile = resolve(dir, 'local.key');
  if (!configuredKey && !existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const hex = configuredKey || readFileSync(keyFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('ENCRYPTION_KEY must be 64 hexadecimal characters');
  const key = Buffer.from(hex, 'hex');
  const db = new DatabaseSync(resolve(dir, 'arlo.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, ruleId TEXT NOT NULL, dueAt INTEGER NOT NULL, startsAt INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, message TEXT NOT NULL DEFAULT '', data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ab_events (id INTEGER PRIMARY KEY, variant TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL);
  `);
  const encrypt = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: bytes.toString('hex') });
  };
  const decrypt = value => {
    const v = JSON.parse(value), decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(v.tag, 'hex'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.data, 'hex')), decipher.final()]).toString('utf8'));
  };
  return { db, encrypt, decrypt,
    get(k) { return db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value; },
    set(k, value) { db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, value); },
    rules() { return db.prepare('SELECT data FROM rules').all().map(r => JSON.parse(r.data)); },
    event(message) { db.prepare('INSERT INTO events(at,message) VALUES (?,?)').run(Date.now(), message); },
    logAbEvent(variant, event) { db.prepare('INSERT INTO ab_events(variant,event,at) VALUES (?,?,?)').run(variant, event, Date.now()); },
    abCounts() { return db.prepare('SELECT variant,event,COUNT(*) AS count FROM ab_events GROUP BY variant,event').all(); }
  };
}
