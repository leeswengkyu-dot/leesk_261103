import fs from 'node:fs';
import path from 'node:path';
import { db, dbPath, getSetting, setSetting } from './db';
import { kstDate, kstHour, nowIso } from './time';

export const backupDir = () => path.join(path.dirname(dbPath()), 'backups');

function prune(dir: string) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^argus-\d{8}.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const x of files.slice(14)) fs.rmSync(path.join(dir, x.f), { force: true });
}

/** SQLite 백업 API 로 복사. 최근 14개만 보관 (FR-X-03) */
export async function backupNow(name?: string): Promise<string> {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = kstDate().replace(/-/g, '');
  const file = path.join(dir, name ?? `argus-${stamp}-${String(kstHour()).padStart(2, '0')}${new Date().toISOString().slice(14, 16)}.db`);
  await db().backup(file);
  setSetting('last_backup_at', nowIso());
  prune(dir);
  return file;
}

/** 당일 첫 수집 전 백업: argus-YYYYMMDD.db 가 없으면 생성 */
export async function backupIfFirstOfDay(): Promise<string | null> {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `argus-${kstDate().replace(/-/g, '')}.db`;
  if (fs.existsSync(path.join(dir, name))) return null;
  return backupNow(name);
}

export function storageInfo() {
  const p = dbPath();
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {}
  let count = 0;
  try {
    count = fs.readdirSync(backupDir()).filter((f) => f.endsWith('.db')).length;
  } catch {}
  return { path: p, size, last_backup_at: getSetting('last_backup_at') || null, backup_count: count, backup_dir: backupDir() };
}
