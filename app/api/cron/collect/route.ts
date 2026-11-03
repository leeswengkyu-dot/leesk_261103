import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runCollection, CollectBusy } from '@/lib/collect';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Vercel Cron 이 매일 호출 (vercel.json). CRON_SECRET 과 일치하는 Bearer 토큰이 있어야 실행한다 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET || '';
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!secret || !same(given, secret)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const r = await runCollection('cron');
    return NextResponse.json({ ok: true, status: r.status, new_articles: r.new_articles, events: r.events });
  } catch (e) {
    if (e instanceof CollectBusy) return NextResponse.json({ ok: false, error: e.message }, { status: 409 });
    console.error('[cron]', e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
