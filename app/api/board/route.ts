import { db, getSetting } from '@/lib/db';
import { read } from '@/lib/api';
import { listEventRows, regionSummaries } from '@/lib/events';
import { isCollecting } from '@/lib/collect';
import { aiStatus } from '@/lib/ai/provider';

export const dynamic = 'force-dynamic';

export const GET = read(async () => {
  const rows = await listEventRows();
  const d = db();
  const last = await d.prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 1').get();
  const runCount = (await d.prepare('SELECT COUNT(*) c FROM collection_runs').get<{ c: number }>())?.c ?? 0;
  let failedFeeds = 0;
  let lastStatus: string | null = null;
  if (last) {
    lastStatus = last.status as string;
    try {
      const r = JSON.parse(last.results as string);
      failedFeeds = (r.feeds ?? []).filter((f: { ok: boolean }) => !f.ok).length;
    } catch {}
  }
  const collecting = await isCollecting();
  const running = collecting ? await d.prepare("SELECT trigger FROM collection_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").get<{ trigger: string }>() : undefined;
  const ai = await aiStatus();
  const liveMin = parseInt(process.env.LIVE_INTERVAL_MIN ?? '10', 10);
  return {
    now: new Date().toISOString(),
    live: {
      enabled: liveMin > 0 && (await getSetting('live', 'on')) !== 'off',
      interval_min: liveMin,
    },
    events: rows,
    summaries: regionSummaries(rows),
    status: {
      run_count: runCount,
      last_status: lastStatus,
      last_started_at: last?.started_at ?? null,
      failed_feeds: failedFeeds,
      collecting,
      running_trigger: running?.trigger ?? null,
      ai_available: ai.available,
      ai_reason: ai.reason,
    },
  };
});
