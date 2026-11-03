import cron from 'node-cron';
import { db, getSetting } from './db';
import { nowIso, kstDate, kstHour } from './time';
import { runCollection, isCollecting } from './collect';
import { backfillLocations } from './ingest';
import { translatePending } from './translate';

const g = globalThis as unknown as { __argusScheduler?: boolean };

/** 서버 시작 시 1회: 중단된 수집 정리, 07:00 스케줄 등록, 놓친 수집(catchup) */
export function startScheduler() {
  if (g.__argusScheduler) return;
  g.__argusScheduler = true;
  const d = db();

  // 수집 중 앱이 종료된 기록 정리
  const n = d
    .prepare(
      "UPDATE collection_runs SET status='failed', finished_at=?, results=? WHERE status='running'",
    )
    .run(nowIso(), JSON.stringify({ feeds: [], ai_note: '중단됨 (앱이 수집 중 종료됨)', events: 0 })).changes;
  if (n) console.log(`[scheduler] 중단된 수집 기록 ${n}건을 정리했습니다`);

  try {
    const filled = backfillLocations();
    if (filled) console.log(`[scheduler] 지명 사전으로 위치 ${filled}건을 채웠습니다`);
  } catch (e) {
    console.error('[scheduler] 위치 보완 실패:', (e as Error).message);
  }

  // 번역이 비어 있는 기존 기사 제목을 백그라운드에서 번역 (서버 시작을 막지 않음)
  translatePending().catch((e) => console.error('[translate] 번역 실패:', e.message));

  const expr = process.env.COLLECT_CRON || '0 7 * * *';
  if (!cron.validate(expr)) console.error(`[scheduler] COLLECT_CRON 형식이 올바르지 않습니다: ${expr}`);
  else {
    cron.schedule(
      expr,
      () => {
        console.log('[scheduler] 예약 수집 시작');
        runCollection('cron').catch((e) => console.error('[scheduler] 수집 실패:', e.message));
      },
      { timezone: 'Asia/Seoul' },
    );
    console.log(`[scheduler] 자동 수집 예약: "${expr}" (Asia/Seoul)`);
  }

  // 실시간 자동 수집: 서버가 켜져 있는 동안 LIVE_INTERVAL_MIN 분마다 (0 이면 끔). 개발 모드에서는 실행하지 않음
  const liveMin = parseInt(process.env.LIVE_INTERVAL_MIN ?? '10', 10);
  if (process.env.NODE_ENV === 'production' && liveMin > 0) {
    setInterval(() => {
      if (getSetting('live', 'on') === 'off' || isCollecting()) return;
      runCollection('live').catch((e) => console.error('[live] 수집 실패:', e.message));
    }, liveMin * 60_000);
    console.log(`[scheduler] 실시간 자동 수집: ${liveMin}분마다 (설정 화면에서 끌 수 있음)`);
  }

  // FR-F1-02 놓친 아침 수집 (개발 모드는 합성 데이터 DB 를 오염시키지 않도록 건너뜀)
  if (process.env.NODE_ENV !== 'production') console.log('[scheduler] 개발 모드: 놓친 수집(catchup)은 실행하지 않습니다');
  else if (kstHour() >= 7) {
    const today = kstDate();
    const rows = d.prepare("SELECT started_at FROM collection_runs WHERE trigger IN ('cron','catchup')").all() as { started_at: string }[];
    const done = rows.some((r) => kstDate(new Date(r.started_at)) === today);
    if (!done) {
      console.log('[scheduler] 놓친 아침 수집을 지금 실행합니다');
      setTimeout(() => runCollection('catchup').catch((e) => console.error('[scheduler] catchup 실패:', e.message)), 3000);
    }
  }
}
