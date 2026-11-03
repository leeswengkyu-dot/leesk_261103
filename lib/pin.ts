import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { db } from './db';
import { nowIso } from './time';

/** 공유 모드 여부: Vercel 배포이거나 HOST 가 127.0.0.1/localhost 가 아니면 공유 모드 */
export function isLanMode(): boolean {
  if (process.env.VERCEL) return true;
  const h = (process.env.HOST || '127.0.0.1').trim();
  return !(h === '127.0.0.1' || h === 'localhost' || h === '::1');
}

function clientIp(req: Request): string {
  const xf = req.headers.get('x-forwarded-for');
  return (xf ? xf.split(',')[0].trim() : '') || 'direct';
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * 쓰기 작업 보호 (22.2). 로컬 모드는 통과, 공유 모드는 x-edit-pin 헤더를 확인한다.
 * 5회 연속 실패하면 10분 잠금. 통과하면 null, 아니면 응답을 돌려준다.
 */
export async function requireWrite(req: Request): Promise<NextResponse | null> {
  if (!isLanMode()) return null;
  const pin = process.env.EDIT_PIN || '';
  const ip = clientIp(req);
  const d = db();
  const row = await d.prepare('SELECT * FROM pin_attempts WHERE ip=?').get<{ fail_count: number; locked_until: string | null }>(ip);
  if (row?.locked_until && row.locked_until > nowIso()) {
    return NextResponse.json({ error: '10분 후 다시 시도하세요', code: 'locked' }, { status: 429 });
  }
  const given = req.headers.get('x-edit-pin') || '';
  if (pin && given && same(given, pin)) {
    if (row) await d.prepare('DELETE FROM pin_attempts WHERE ip=?').run(ip);
    return null;
  }
  const fails = (row && (!row.locked_until || row.locked_until <= nowIso()) ? row.fail_count : 0) + (given ? 1 : 0);
  if (given) {
    const lock = fails >= 5 ? new Date(Date.now() + 10 * 60_000).toISOString() : null;
    await d.prepare(
      'INSERT INTO pin_attempts (ip,fail_count,locked_until) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET fail_count=excluded.fail_count, locked_until=excluded.locked_until',
    ).run(ip, lock ? 0 : fails, lock);
    if (lock) return NextResponse.json({ error: '10분 후 다시 시도하세요', code: 'locked' }, { status: 429 });
  }
  return NextResponse.json({ error: given ? 'PIN이 올바르지 않습니다' : 'PIN이 필요합니다', code: 'pin' }, { status: 401 });
}
