import { db } from './db';
import { nowIso, parseTime } from './time';
import { round3 } from './geo';
import { aiJson, aiStatus, AiUnavailable } from './ai/provider';
import { T1Schema } from './ai/schemas';
import { T1_SYSTEM } from './ai/prompts';
import { articlesOf, findDuplicateCandidates, recomputeEvent, saveStatement } from './events';
import { generateSummary, sanitizeT1 } from './ingest';

/**
 * 기존 사건 AI 재분석.
 * AI 가 꺼져 있던 동안(또는 AI 실패로) 키워드 규칙으로 만들어진 "수집함" 사건을 AI 로 다시 분석해
 * 사건 유형·위치·발생 시각·요약 초안을 채운다. 사람이 고친 좌표(human/csv)와 기존 요약 문장은 건드리지 않는다.
 */

/** 수집 1회당 재분석할 사건 수 (0 이면 수집 때 자동 재분석 끔) */
const perRun = () => parseInt(process.env.REANALYZE_PER_RUN ?? '10', 10);

const TARGET_SQL = `FROM events e WHERE e.review_status='collected'
  AND EXISTS (SELECT 1 FROM articles a WHERE a.event_id=e.id AND a.ai_status IN ('skipped','failed'))`;

/** 재분석 대상 사건 수 */
export async function reanalyzeLeft(): Promise<number> {
  const r = await db().prepare(`SELECT COUNT(*) c ${TARGET_SQL}`).get<{ c: number }>();
  return Number(r?.c ?? 0);
}

export interface ReanalyzeResult {
  done: number;
  changedType: number;
  located: number;
  summarized: number;
  notRelevant: number;
  failed: number;
  left: number;
  note: string | null;
}

/** 사건 1건 재분석. 결과 요약을 돌려준다 */
export async function reanalyzeEvent(eventId: string) {
  const d = db();
  const ev = await d.prepare('SELECT * FROM events WHERE id=?').get<Record<string, unknown>>(eventId);
  if (!ev) throw new Error('사건을 찾을 수 없습니다');
  const arts = await articlesOf(eventId);
  if (!arts.length) throw new Error('연결된 기사가 없습니다');
  const a = arts[0];
  const feed = a.feed_id
    ? await d.prepare('SELECT region, is_party_source FROM feeds WHERE id=?').get<{ region: string; is_party_source: number }>(a.feed_id)
    : undefined;
  const feedRegion = feed?.region && feed.region !== 'global' ? feed.region : null;
  // 기사가 여러 건이면 다른 기사 제목도 참고로 넣는다
  const user = JSON.stringify({
    제목: a.title,
    설명: a.description ?? '',
    출처: a.source_name,
    출처등급: a.source_grade,
    당사자_출처: !!feed?.is_party_source,
    게시시각: a.published_at,
    힌트_지역: feedRegion ?? ev.region,
    같은_사건_다른_기사_제목: arts.slice(1, 4).map((x) => x.title),
  });
  const raw = await aiJson(T1_SYSTEM, user, T1Schema);
  const region = (raw.region || ev.region) as string;
  const t = sanitizeT1(raw, region);
  const out = { changedType: false, located: false, summarized: false, notRelevant: !raw.relevant };

  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (c: string, v: unknown) => {
    sets.push(`${c}=?`);
    vals.push(v);
  };
  const newType = raw.relevant ? t.event_type : 'other';
  if (newType !== ev.event_type) {
    put('event_type', newType);
    out.changedType = true;
  }
  if (raw.region && raw.region !== ev.region) put('region', raw.region);
  if (!ev.country && t.country) put('country', t.country);
  if (!ev.occurred_at && parseTime(t.occurred_at)) put('occurred_at', parseTime(t.occurred_at));
  // 위치: 사람이 고친 좌표·CSV 좌표는 그대로 두고, 비어 있거나 지명 사전 추정일 때만 AI 추정으로 바꾼다
  const coordOrigin = ev.coord_origin as string;
  if (t.lat != null && t.lng != null && (coordOrigin === 'none' || coordOrigin === 'gazetteer' || ev.lat == null)) {
    put('lat', round3(t.lat));
    put('lng', round3(t.lng));
    put('coord_origin', 'ai_estimated');
    put('location_accuracy', t.location_accuracy);
    put('area_radius_km', t.location_accuracy === 'area' ? t.area_radius_km ?? null : null);
    if (t.location_name) put('location_name', t.location_name);
    out.located = ev.lat == null;
  } else if (!ev.location_name && t.location_name) {
    put('location_name', t.location_name);
  }
  if (sets.length) {
    put('updated_at', nowIso());
    await d.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id=?`).run(...vals, eventId);
  }

  // 기사 상태·추출 위치
  const isParty = !!(t.is_party_claim || feed?.is_party_source);
  await d
    .prepare('UPDATE articles SET extracted_location_name=COALESCE(extracted_location_name, ?), extracted_lat=COALESCE(extracted_lat, ?), extracted_lng=COALESCE(extracted_lng, ?), is_party_claim=? WHERE id=?')
    .run(t.location_name ?? null, t.lat != null ? round3(t.lat) : null, t.lng != null ? round3(t.lng) : null, isParty ? 1 : 0, a.id);
  await d.prepare("UPDATE articles SET ai_status='done' WHERE event_id=? AND ai_status IN ('skipped','failed','pending')").run(eventId);

  // 요약 초안: 요약 문장이 하나도 없을 때만 [미확인] 문장으로 넣는다 (사람이 검토)
  const stCount = (await d.prepare('SELECT COUNT(*) c FROM summary_statements WHERE event_id=?').get<{ c: number }>(eventId))?.c ?? 0;
  if (Number(stCount) === 0 && raw.relevant) {
    if (t.summary) {
      await saveStatement({ event_id: eventId, text: t.summary, label: 'unverified', article_ids: [a.id], origin: 'ai_api', downgrade: true });
      await d.prepare("UPDATE events SET summary_origin='ai_api' WHERE id=?").run(eventId);
      out.summarized = true;
    } else {
      try {
        if ((await generateSummary(eventId)) > 0) out.summarized = true;
      } catch {
        /* 요약 실패는 재분석 실패로 보지 않는다 */
      }
    }
  }
  await recomputeEvent(eventId);
  if (out.changedType || raw.region) await findDuplicateCandidates(eventId);
  return out;
}

/** 재분석 대상 사건을 경보 사건 → 최신 순으로 처리한다 */
export async function reanalyzePending(opts: { max?: number; deadline?: number } = {}): Promise<ReanalyzeResult> {
  const res: ReanalyzeResult = { done: 0, changedType: 0, located: 0, summarized: 0, notRelevant: 0, failed: 0, left: 0, note: null };
  const max = opts.max ?? perRun();
  const deadline = opts.deadline ?? Infinity;
  const st = await aiStatus();
  if (!st.available) {
    res.note = st.reason;
    res.left = await reanalyzeLeft();
    return res;
  }
  const rows = await db()
    .prepare(`SELECT e.id ${TARGET_SQL} ORDER BY CASE WHEN e.alert_reasons IS NOT NULL AND e.alert_reasons<>'[]' THEN 0 ELSE 1 END, e.first_published_at DESC LIMIT ?`)
    .all<{ id: string }>(Math.max(0, max));
  for (const r of rows) {
    if (Date.now() > deadline) break;
    try {
      const o = await reanalyzeEvent(r.id);
      res.done++;
      if (o.changedType) res.changedType++;
      if (o.located) res.located++;
      if (o.summarized) res.summarized++;
      if (o.notRelevant) res.notRelevant++;
    } catch (e) {
      if (e instanceof AiUnavailable) {
        res.note = e.message;
        break;
      }
      res.failed++;
      res.note = `재분석 실패: ${(e as Error).message.slice(0, 120)}`;
      // 같은 사건을 계속 다시 시도하지 않도록 표시 (상세 패널의 AI 요약 버튼으로는 계속 처리 가능)
      await db().prepare("UPDATE articles SET ai_status='reanalyze_failed' WHERE event_id=? AND ai_status IN ('skipped','failed')").run(r.id);
    }
  }
  res.left = await reanalyzeLeft();
  return res;
}
