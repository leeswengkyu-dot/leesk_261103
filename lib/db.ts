import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/*
 * DB 계층. DATABASE_URL 이 있으면 Postgres(Supabase), 없으면 로컬 개발용 PGlite(파일)를 쓴다.
 * 호출 형태는 기존 better-sqlite3 와 비슷하게 유지하되 모두 비동기다:
 *   await db().prepare('SELECT ... WHERE id=?').get(id)
 *   await inTx(async () => { ... })
 */
type Row = Record<string, unknown>;
type Res = { rows: Row[]; count: number };
type Q = (sql: string, params: unknown[]) => Promise<Res>;
interface Conn {
  q: Q;
  exec: (sql: string) => Promise<void>;
}
interface Driver extends Conn {
  kind: 'postgres' | 'pglite';
  label: string;
  tx: <T>(fn: (c: Conn) => Promise<T>) => Promise<T>;
}

const g = globalThis as unknown as { __argusDb?: Promise<Driver> };
const als = new AsyncLocalStorage<Conn>();

export const uuid = () => randomUUID();

/** '?' 와 '@name' 자리표시자를 $1.. 로 바꾼다 (작은따옴표 문자열 안은 건드리지 않음) */
export function toPg(sql: string, args: unknown[]): { text: string; values: unknown[] } {
  const first = args[0];
  const obj = args.length === 1 && first && typeof first === 'object' && !Array.isArray(first) && !(first instanceof Date) ? (first as Row) : null;
  const pos = obj ? [] : args.length === 1 && Array.isArray(first) ? (first as unknown[]) : args;
  const values: unknown[] = [];
  const named = new Map<string, number>();
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '?') {
      values.push(pos[n++] ?? null);
      out += `$${values.length}`;
      i++;
      continue;
    }
    if (c === '@' && obj) {
      const m = /^@(\w+)/.exec(sql.slice(i));
      if (m) {
        let k = named.get(m[1]);
        if (!k) {
          values.push(obj[m[1]] ?? null);
          k = values.length;
          named.set(m[1], k);
        }
        out += `$${k}`;
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return { text: out, values };
}

const fixRow = (r: Row): Row => {
  for (const k in r) if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
  return r;
};

async function openPg(url: string): Promise<Driver> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v: string) => parseInt(v, 10)); // COUNT(*) 등 bigint
  pg.types.setTypeParser(1700, (v: string) => parseFloat(v)); // numeric
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  u.searchParams.delete('pgbouncer');
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || process.env.DATABASE_SSL === 'off';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 3, idleTimeoutMillis: 10_000, ssl: local ? undefined : { rejectUnauthorized: false } });
  const wrap = (c: { query: (t: string, v?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }> }): Conn => ({
    q: async (text, values) => {
      const r = await c.query(text, values);
      return { rows: r.rows, count: r.rowCount ?? 0 };
    },
    exec: async (text) => {
      await c.query(text);
    },
  });
  const base = wrap(pool);
  return {
    kind: 'postgres',
    label: `Postgres (${u.hostname})`,
    ...base,
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

async function openPglite(): Promise<Driver> {
  const name = '@electric-sql/pglite';
  const { PGlite } = (await import(/* webpackIgnore: true */ name)) as { PGlite: new (dir: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const dir = path.resolve(process.cwd(), process.env.PGLITE_DIR || './data/pglite');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const pgl = new PGlite(dir);
  await pgl.waitReady;
  const wrap = (c: any): Conn => ({
    q: async (text, values) => {
      const r = await c.query(text, values);
      return { rows: (r.rows as Row[]).map(fixRow), count: r.affectedRows ?? r.rows.length };
    },
    exec: async (text) => {
      await c.exec(text);
    },
  });
  return { kind: 'pglite', label: `PGlite 로컬 파일 (${dir})`, ...wrap(pgl), tx: (fn) => pgl.transaction((t: unknown) => fn(wrap(t))) };
}

async function migrate(d: Driver) {
  await d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.resolve(process.cwd(), 'db/migrations');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await d.tx(async (c) => {
      await c.q('SELECT pg_advisory_xact_lock(7314001)', []); // 여러 인스턴스가 동시에 시작해도 한 번만 적용
      const done = await c.q('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rows.length) return;
      await c.exec(sql);
      await c.q('INSERT INTO schema_migrations (name, applied_at) VALUES ($1,$2)', [f, new Date().toISOString()]);
      console.log(`[db] 마이그레이션 적용: ${f}`);
    });
  }
}

async function seedFeeds(d: Driver) {
  const n = Number((await d.q('SELECT COUNT(*) c FROM feeds', [])).rows[0]?.c ?? 0);
  if (n > 0) return;
  const file = path.resolve(process.cwd(), 'data/feeds.seed.json');
  if (!fs.existsSync(file)) return;
  const feeds = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[];
  await d.tx(async (c) => {
    for (const f of feeds) {
      await c.q(
        'INSERT INTO feeds (id,name,region,grade,is_party_source,feed_type,url,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING',
        [f.id, f.name, f.region, f.grade, f.is_party_source, f.feed_type, f.url, f.active],
      );
    }
  });
  console.log(`[db] 수집 출처 ${feeds.length}개 등록`);
}

async function open(): Promise<Driver> {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.VERCEL) throw new Error('DATABASE_URL 환경변수가 없습니다 (Supabase 연결 문자열을 Vercel 환경변수에 등록하세요)');
  try {
    const d = url ? await openPg(url) : await openPglite();
    await migrate(d);
    await seedFeeds(d);
    return d;
  } catch (e) {
    console.error(`[db] DB를 열 수 없습니다: ${(e as Error).message}`);
    throw e;
  }
}

function driver(): Promise<Driver> {
  if (!g.__argusDb) {
    g.__argusDb = open().catch((e) => {
      g.__argusDb = undefined;
      throw e;
    });
  }
  return g.__argusDb;
}

async function run(sql: string, args: unknown[]): Promise<Res> {
  const { text, values } = toPg(sql, args);
  const conn = als.getStore() ?? (await driver());
  return conn.q(text, values);
}

export interface Stmt {
  get<T = Row>(...args: unknown[]): Promise<T | undefined>;
  all<T = Row>(...args: unknown[]): Promise<T[]>;
  run(...args: unknown[]): Promise<{ changes: number }>;
}

const handle = {
  prepare(sql: string): Stmt {
    return {
      get: async <T = Row>(...a: unknown[]) => (await run(sql, a)).rows[0] as T | undefined,
      all: async <T = Row>(...a: unknown[]) => (await run(sql, a)).rows as T[],
      run: async (...a: unknown[]) => ({ changes: (await run(sql, a)).count }),
    };
  },
  async exec(sql: string) {
    const conn = als.getStore() ?? (await driver());
    await conn.exec(sql);
  },
};

export const db = () => handle;

/** 트랜잭션. 안에서 db().prepare(...) 를 호출하면 같은 연결을 쓴다. 이미 트랜잭션 안이면 그대로 실행 */
export async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  if (als.getStore()) return fn();
  const d = await driver();
  return d.tx((conn) => als.run(conn, fn));
}

/** 저장소 정보 (설정 화면용) */
export async function dbInfo() {
  const d = await driver();
  return { kind: d.kind, label: d.label };
}

export async function getSetting(key: string, def = ''): Promise<string> {
  const r = await db().prepare('SELECT value FROM settings WHERE key=?').get<{ value: string | null }>(key);
  return r?.value ?? def;
}

export async function setSetting(key: string, value: string) {
  await db().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
