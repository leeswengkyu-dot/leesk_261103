import { read } from '@/lib/api';
import { getSetting } from '@/lib/db';
import { runCollection, isCollecting, lastRunAt, CollectBusy } from '@/lib/collect';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const liveIntervalMin = () => parseInt(process.env.LIVE_INTERVAL_MIN ?? '10', 10);

/**
 * 실시간 수집 신호. 상황판이 열려 있는 브라우저가 주기적으로 호출한다 (서버리스에는 상시 타이머가 없다).
 * 실시간이 켜져 있고, 마지막 수집 후 간격이 지났고, 진행 중인 수집이 없을 때만 실제로 수집한다.
 * PIN 없이 호출되므로 간격 제한으로 과도한 실행을 막는다.
 */
export const POST = read(async () => {
  const min = liveIntervalMin();
  if (min <= 0 || (await getSetting('live', 'on')) === 'off') return { ran: false, reason: 'off' };
  const last = await lastRunAt();
  if (last && Date.now() - new Date(last).getTime() < min * 60_000) return { ran: false, reason: 'recent' };
  if (await isCollecting()) return { ran: false, reason: 'busy' };
  try {
    const r = await runCollection('live');
    return { ran: true, new_articles: r.new_articles, events: r.events, status: r.status };
  } catch (e) {
    if (e instanceof CollectBusy) return { ran: false, reason: 'busy' };
    throw e;
  }
});
