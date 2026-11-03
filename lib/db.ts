import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type Db = Database.Database;
const g = globalThis as unknown as { __argusDb?: Db };

export const uuid = () => randomUUID();

export function dbPath(): string {
  return path.resolve(process.cwd(), process.env.DB_PATH || './data/argus.db');
}

function migrate(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.resolve(process.cwd(), 'db/migrations');
  if (!fs.existsSync(dir)) return;
  const done = new Set((db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    })();
    console.log(`[db] 마이그레이션 적용: ${f}`);
  }
}

function seedFeeds(db: Db) {
  const n = (db.prepare('SELECT COUNT(*) c FROM feeds').get() as { c: number }).c;
  if (n > 0) return;
  const file = path.resolve(process.cwd(), 'data/feeds.seed.json');
  if (!fs.existsSync(file)) return;
  const feeds = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[];
  const ins = db.prepare(
    'INSERT INTO feeds (id,name,region,grade,is_party_source,feed_type,url,active) VALUES (@id,@name,@region,@grade,@is_party_source,@feed_type,@url,@active)',
  );
  db.transaction(() => feeds.forEach((f) => ins.run(f)))();
  console.log(`[db] 수집 출처 ${feeds.length}개 등록`);
}

function open(): Db {
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db: Db;
  try {
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    seedFeeds(db);
  } catch (e) {
    console.error(`[db] DB를 열 수 없습니다: ${file}\n  사유: ${(e as Error).message}\n  data/backups 의 최근 백업으로 복원하세요.`);
    throw e;
  }
  return db;
}

export function db(): Db {
  if (!g.__argusDb) g.__argusDb = open();
  return g.__argusDb;
}

export function getSetting(key: string, def = ''): string {
  const r = db().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
  return r?.value ?? def;
}

export function setSetting(key: string, value: string) {
  db().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
