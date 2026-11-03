import { db, getSetting, setSetting } from '@/lib/db';
import { read, write, body } from '@/lib/api';
import { aiStatus } from '@/lib/ai/provider';
import { storageInfo } from '@/lib/backup';
import { isCollecting } from '@/lib/collect';
import { isLanMode } from '@/lib/pin';
import { ValidationError } from '@/lib/events';

export const dynamic = 'force-dynamic';

export const GET = read(() => {
  const d = db();
  const runs = (d.prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 14').all() as Record<string, unknown>[]).map((r) => {
    let parsed: { feeds?: unknown[]; ai_note?: string | null; events?: number } = {};
    try {
      parsed = JSON.parse(r.results as string);
    } catch {}
    return { ...r, results: undefined, feeds: parsed.feeds ?? [], ai_note: parsed.ai_note ?? null, events: parsed.events ?? 0 };
  });
  const feeds = d.prepare('SELECT * FROM feeds ORDER BY region, name').all();
  const cron = process.env.COLLECT_CRON || '0 7 * * *';
  return {
    runs,
    feeds,
    cron,
    collecting: isCollecting(),
    ai: aiStatus(),
    storage: storageInfo(),
    mode: isLanMode() ? 'lan' : 'local',
    ai_mode: getSetting('ai_mode', 'api'),
    live: { on: getSetting('live', 'on') !== 'off', interval_min: parseInt(process.env.LIVE_INTERVAL_MIN ?? '10', 10), active: process.env.NODE_ENV === 'production' },
  };
});

export const PATCH = write(async (req) => {
  const b = await body<{ ai_mode?: string; feed_id?: string; active?: boolean; live?: boolean }>(req);
  if (typeof b.live === 'boolean') setSetting('live', b.live ? 'on' : 'off');
  if (b.ai_mode) {
    if (!['api', 'pre'].includes(b.ai_mode)) throw new ValidationError('요약 방식 값이 올바르지 않습니다');
    setSetting('ai_mode', b.ai_mode);
  }
  if (b.feed_id) db().prepare('UPDATE feeds SET active=? WHERE id=?').run(b.active ? 1 : 0, b.feed_id);
  return { ok: true };
});
