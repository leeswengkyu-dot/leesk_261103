import { db, dbInfo, getSetting, setSetting } from '@/lib/db';
import { read, write, body } from '@/lib/api';
import { aiStatus } from '@/lib/ai/provider';
import { isCollecting } from '@/lib/collect';
import { isLanMode } from '@/lib/pin';
import { ValidationError } from '@/lib/events';

export const dynamic = 'force-dynamic';

export const GET = read(async () => {
  const d = db();
  const rawRuns = await d.prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 14').all();
  const runs = rawRuns.map((r) => {
    let parsed: { feeds?: unknown[]; ai_note?: string | null; events?: number } = {};
    try {
      parsed = JSON.parse(r.results as string);
    } catch {}
    return { ...r, results: undefined, feeds: parsed.feeds ?? [], ai_note: parsed.ai_note ?? null, events: parsed.events ?? 0 };
  });
  const feeds = await d.prepare('SELECT * FROM feeds ORDER BY region, name').all();
  const count = async (t: string) => (await d.prepare(`SELECT COUNT(*) c FROM ${t}`).get<{ c: number }>())?.c ?? 0;
  const live = parseInt(process.env.LIVE_INTERVAL_MIN ?? '10', 10);
  return {
    runs,
    feeds,
    cron: process.env.COLLECT_CRON || '0 7 * * *',
    collecting: await isCollecting(),
    ai: await aiStatus(),
    storage: { ...(await dbInfo()), events: await count('events'), articles: await count('articles') },
    mode: isLanMode() ? 'lan' : 'local',
    ai_mode: await getSetting('ai_mode', 'api'),
    live: { on: (await getSetting('live', 'on')) !== 'off', interval_min: live, active: live > 0 },
  };
});

export const PATCH = write(async (req) => {
  const b = await body<{ ai_mode?: string; feed_id?: string; active?: boolean; live?: boolean }>(req);
  if (typeof b.live === 'boolean') await setSetting('live', b.live ? 'on' : 'off');
  if (b.ai_mode) {
    if (!['api', 'pre'].includes(b.ai_mode)) throw new ValidationError('요약 방식 값이 올바르지 않습니다');
    await setSetting('ai_mode', b.ai_mode);
  }
  if (b.feed_id) await db().prepare('UPDATE feeds SET active=? WHERE id=?').run(b.active ? 1 : 0, b.feed_id);
  return { ok: true };
});
