import { db, getSetting } from '@/lib/db';
import { read } from '@/lib/api';
import { listEventRows, regionSummaries } from '@/lib/events';
import { isCollecting } from '@/lib/collect';
import { aiStatus } from '@/lib/ai/provider';

export const dynamic = 'force-dynamic';

export const GET = read(() => {
  const rows = listEventRows();
  const d = db();
  const last = d.prepare('SELECT * FROM collection_runs ORDER BY started_at DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  const runCount = (d.prepare('SELECT COUNT(*) c FROM collection_runs').get() as { c: number }).c;
  let failedFeeds = 0;
  let lastStatus: string | null = null;
  if (last) {
    lastStatus = last.status as string;
    try {
      const r = JSON.parse(last.results as string);
      failedFeeds = (r.feeds ?? []).filter((f: { ok: boolean }) => !f.ok).length;
    } catch {}
  }
  const running = d.prepare("SELECT trigger FROM collection_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1").get() as { trigger: string } | undefined;
  const ai = aiStatus();
  return {
    now: new Date().toISOString(),
    live: {
      enabled: process.env.NODE_ENV === 'production' && parseInt(process.env.LIVE_INTERVAL_MIN ?? '10', 10) > 0 && getSetting('live', 'on') !== 'off',
      interval_min: parseInt(process.env.LIVE_INTERVAL_MIN ?? '10', 10),
    },
    events: rows,
    summaries: regionSummaries(rows),
    status: {
      run_count: runCount,
      last_status: lastStatus,
      last_started_at: last?.started_at ?? null,
      failed_feeds: failedFeeds,
      collecting: isCollecting(),
      running_trigger: running?.trigger ?? null,
      ai_available: ai.available,
      ai_reason: ai.reason,
    },
  };
});
