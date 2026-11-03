import { db, inTx, uuid } from './db';
import { nowIso, addHours } from './time';
import { conflictCircle, haversineKm, maxPairDistanceKm, LOCATION_CONFLICT_KM, round3 } from './geo';
import {
  alertReasons,
  checkFact,
  computeReliability,
  isDuplicateCandidate,
  isSurge,
  ungroundedTokens,
  type ArticleLite,
} from './rules/labels';
import { REGION_KEYS, type EventRow, type RegionSummary } from './types';

export class ValidationError extends Error {
  status = 422;
}

/* ───────────── 조회 ───────────── */

export interface ArticleRow extends ArticleLite {
  id: string;
  event_id: string | null;
  feed_id: string | null;
  url: string;
  title: string;
  description: string | null;
  published_at: string;
  extracted_location_name: string | null;
  extracted_lat: number | null;
  extracted_lng: number | null;
  ai_status: string;
  fetched_at: string;
}

export async function articlesOf(eventId: string): Promise<ArticleRow[]> {
  return db().prepare('SELECT * FROM articles WHERE event_id=? ORDER BY published_at ASC').all<ArticleRow>(eventId);
}

const artPts = (arts: ArticleRow[]) =>
  arts.filter((a) => a.extracted_lat != null && a.extracted_lng != null).map((a) => ({ lat: a.extracted_lat as number, lng: a.extracted_lng as number }));

/** 목록·지도용 사건 행 (rejected, merged 제외) */
export async function listEventRows(): Promise<EventRow[]> {
  const d = db();
  const events = await d.prepare("SELECT * FROM events WHERE review_status IN ('collected','reviewed') ORDER BY COALESCE(occurred_at, first_published_at) DESC").all();
  const arts = await d.prepare('SELECT event_id, extracted_lat, extracted_lng, source_name, source_grade FROM articles WHERE event_id IS NOT NULL ORDER BY published_at').all<{ event_id: string; extracted_lat: number | null; extracted_lng: number | null; source_name: string; source_grade: string }>();
  const ptsBy = new Map<string, { lat: number; lng: number }[]>();
  const srcBy = new Map<string, { name: string; grade: string }[]>();
  for (const a of arts) {
    const sl = srcBy.get(a.event_id) ?? [];
    if (!sl.some((x) => x.name === a.source_name)) sl.push({ name: a.source_name, grade: a.source_grade });
    srcBy.set(a.event_id, sl);
    if (a.extracted_lat == null || a.extracted_lng == null) continue;
    const l = ptsBy.get(a.event_id) ?? [];
    l.push({ lat: a.extracted_lat, lng: a.extracted_lng });
    ptsBy.set(a.event_id, l);
  }
  const dupCnt = new Map<string, number>();
  for (const r of await d.prepare("SELECT event_a, event_b FROM duplicate_candidates WHERE status='suggested'").all<{ event_a: string; event_b: string }>()) {
    dupCnt.set(r.event_a, (dupCnt.get(r.event_a) ?? 0) + 1);
    dupCnt.set(r.event_b, (dupCnt.get(r.event_b) ?? 0) + 1);
  }
  const st = await d.prepare('SELECT event_id, label, COUNT(*) OVER (PARTITION BY event_id) n, position FROM summary_statements ORDER BY event_id, position').all<{ event_id: string; label: string; n: number }>();
  const stBy = new Map<string, { label: string; n: number }>();
  for (const s of st) if (!stBy.has(s.event_id)) stBy.set(s.event_id, { label: s.label, n: s.n });

  return events.map((e) => {
    const id = e.id as string;
    const circle = e.location_conflict ? conflictCircle(ptsBy.get(id) ?? []) : null;
    return {
      id,
      title: e.title as string,
      title_ko: e.title_ko && e.title_ko !== e.title ? (e.title_ko as string) : null,
      sources: srcBy.get(id) ?? [],
      region: e.region as EventRow['region'],
      country: e.country as string | null,
      location_name: e.location_name as string | null,
      lat: e.lat as number | null,
      lng: e.lng as number | null,
      coord_origin: e.coord_origin as string,
      location_accuracy: e.location_accuracy as EventRow['location_accuracy'],
      area_radius_km: e.area_radius_km as number | null,
      location_conflict: e.location_conflict as number,
      content_conflict: e.content_conflict as number,
      occurred_at: e.occurred_at as string | null,
      first_published_at: e.first_published_at as string,
      event_type: e.event_type as string,
      change_type: e.change_type as string,
      source_count: e.source_count as number,
      reliability: e.reliability as EventRow['reliability'],
      alert_reasons: JSON.parse((e.alert_reasons as string) || '[]'),
      review_status: e.review_status as string,
      summary_origin: e.summary_origin as string,
      dup_count: dupCnt.get(id) ?? 0,
      top_label: stBy.get(id)?.label ?? 'unverified',
      statement_count: stBy.get(id)?.n ?? 0,
      conflict_circle: circle,
    };
  });
}

/** FR-F3-01: 지역별 최근 24시간 / 직전 24시간 */
export function regionSummaries(rows: EventRow[], now = new Date()): RegionSummary[] {
  const t1 = now.getTime();
  const out: RegionSummary[] = [];
  for (const region of REGION_KEYS) {
    const s: RegionSummary = { region, new: 0, continuing: 0, escalated: 0, ended: 0, cur: 0, prev: 0, surge: false };
    for (const e of rows) {
      if (e.region !== region) continue;
      const t = new Date(e.occurred_at ?? e.first_published_at).getTime();
      if (t > t1) continue;
      if (t >= t1 - 24 * 3600_000) {
        s.cur++;
        const k = e.change_type as 'new' | 'continuing' | 'escalated' | 'ended';
        if (k in s) s[k]++;
      } else if (t >= t1 - 48 * 3600_000) s.prev++;
    }
    s.surge = isSurge(s.cur, s.prev);
    out.push(s);
  }
  return out;
}

export async function getEventDetail(id: string) {
  const d = db();
  const ev = await d.prepare('SELECT * FROM events WHERE id=?').get(id);
  if (!ev) return null;
  const articles = await articlesOf(id);
  const stRows = await d.prepare('SELECT * FROM summary_statements WHERE event_id=? ORDER BY position, created_at').all(id);
  const statements = await Promise.all(
    stRows.map(async (s) => ({
      ...s,
      warnings: JSON.parse((s.warnings as string) || '[]') as string[],
      article_ids: (await d.prepare('SELECT article_id FROM statement_sources WHERE statement_id=?').all<{ article_id: string }>(s.id)).map((r) => r.article_id),
    })),
  );
  const dups = await d
    .prepare(
      `SELECT c.id, c.status, c.ai_verdict, c.ai_confidence, c.ai_reason, c.ai_checked_at, CASE WHEN c.event_a=@id THEN c.event_b ELSE c.event_a END other_id
       FROM duplicate_candidates c WHERE (c.event_a=@id OR c.event_b=@id) AND c.status IN ('suggested','confirmed')`,
    )
    .all<{ id: string; status: string; other_id: string; ai_verdict: string | null; ai_confidence: number | null; ai_reason: string | null; ai_checked_at: string | null }>({ id });
  // AI 가 같은 사건으로 본 후보를 위로, 별개로 본 후보를 아래로
  const vOrder: Record<string, number> = { same: 0, unsure: 1, different: 3 };
  dups.sort((a, b) => (a.status === 'confirmed' ? -1 : vOrder[a.ai_verdict ?? ''] ?? 2) - (b.status === 'confirmed' ? -1 : vOrder[b.ai_verdict ?? ''] ?? 2));
  const dupDetail = await Promise.all(
    dups.map(async (c) => {
      const o = await d.prepare('SELECT id,title,occurred_at,first_published_at,location_name,source_count,review_status FROM events WHERE id=?').get(c.other_id);
      return { ...c, other: o ?? null };
    }),
  );
  const mergedChildren = await d.prepare("SELECT id,title FROM events WHERE merged_into=?").all(id);
  const rel = computeReliability(articles);
  const briefings = await d.prepare('SELECT id,status,briefing_date FROM briefings WHERE event_ids LIKE ?').all<{ id: string; status: string; briefing_date: string }>(`%${id}%`);
  const pts = artPts(articles);
  return {
    event: { ...ev, alert_reasons: JSON.parse((ev.alert_reasons as string) || '[]') as string[] },
    articles,
    statements,
    duplicates: dupDetail,
    merged_children: mergedChildren,
    reliability_basis: rel.basis,
    max_distance_km: pts.length > 1 ? Math.round(maxPairDistanceKm(pts) * 10) / 10 : 0,
    briefings,
  };
}

/* ───────────── 재계산 ───────────── */

/** 연결 기사 기준으로 출처 수·신뢰도·위치 충돌·경보·최초 게시 시각 갱신 */
export async function recomputeEvent(id: string) {
  const d = db();
  const ev = await d.prepare('SELECT * FROM events WHERE id=?').get(id);
  if (!ev) return;
  const arts = await articlesOf(id);
  const rel = computeReliability(arts);
  const pts = artPts(arts);
  const locConflict = pts.length > 1 && maxPairDistanceKm(pts) > LOCATION_CONFLICT_KM ? 1 : 0;
  const sourceCount = new Set(arts.map((a) => a.source_name)).size;
  const first = arts.length ? arts[0].published_at : (ev.first_published_at as string);
  const alerts = alertReasons({ event_type: ev.event_type as string, location_conflict: locConflict, content_conflict: ev.content_conflict as number });
  await d.prepare(
    'UPDATE events SET source_count=?, reliability=?, location_conflict=?, alert_reasons=?, first_published_at=?, updated_at=? WHERE id=?',
  ).run(sourceCount, rel.level, locConflict, JSON.stringify(alerts), first, nowIso(), id);
}

/** FR-F3-02 변화 구분 기본값: 직전 24시간 안에 같은 지역·유형·100km 이내 사건이 있으면 지속 */
export async function defaultChangeType(e: { id: string; region: string; event_type: string; occurred_at: string | null; first_published_at: string; lat: number | null; lng: number | null }): Promise<'new' | 'continuing'> {
  const t = e.occurred_at ?? e.first_published_at;
  const from = addHours(t, -24);
  const rows = await db()
    .prepare(
      `SELECT lat,lng FROM events WHERE id<>? AND region=? AND event_type=? AND review_status IN ('collected','reviewed')
       AND COALESCE(occurred_at, first_published_at) >= ? AND COALESCE(occurred_at, first_published_at) < ?`,
    )
    .all<{ lat: number | null; lng: number | null }>(e.id, e.region, e.event_type, from, t);
  for (const r of rows) {
    if (e.lat == null || r.lat == null || e.lng == null || r.lng == null) return 'continuing';
    if (haversineKm({ lat: e.lat, lng: e.lng }, { lat: r.lat as number, lng: r.lng as number }) <= 100) return 'continuing';
  }
  return 'new';
}

/** FR-F1-16 중복 후보 계산 (제안만 한다) */
export async function findDuplicateCandidates(eventId: string): Promise<number> {
  const d = db();
  const e = await d.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  if (!e || (e.review_status !== 'collected' && e.review_status !== 'reviewed')) return 0;
  const others = await d
    .prepare("SELECT * FROM events WHERE id<>? AND region=? AND event_type=? AND review_status IN ('collected','reviewed')")
    .all(eventId, e.region, e.event_type);
  let n = 0;
  const ins = d.prepare('INSERT INTO duplicate_candidates (id,event_a,event_b,status,created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING');
  const chk = d.prepare('SELECT 1 FROM duplicate_candidates WHERE (event_a=? AND event_b=?) OR (event_a=? AND event_b=?)');
  for (const o of others) {
    if (!isDuplicateCandidate(e as never, o as never)) continue;
    if (await chk.get(eventId, o.id, o.id, eventId)) continue;
    await ins.run(uuid(), eventId, o.id as string, 'suggested', nowIso());
    n++;
  }
  return n;
}

/* ───────────── 요약 문장 ───────────── */

export interface StatementInput {
  event_id: string;
  id?: string;
  text: string;
  label: string;
  article_ids: string[];
  origin: 'ai_api' | 'pre_generated' | 'human';
  fact_suggested?: boolean;
  actor?: string | null;
  /** 사람이 직접 저장하는 경우 true. [사실] 조건 (b)의 실무자 승인으로 간주 */
  human?: boolean;
  /** AI·CSV 문장: 조건 미충족 시 거부하지 않고 [미확인]으로 낮춘다 */
  downgrade?: boolean;
}

/** FR-F2-01~06 서버 검증을 적용해 문장을 저장한다. */
export async function saveStatement(inp: StatementInput): Promise<{ id: string; label: string; warnings: string[] }> {
  const d = db();
  const ev = await d.prepare('SELECT * FROM events WHERE id=?').get(inp.event_id);
  if (!ev) throw new ValidationError('사건을 찾을 수 없습니다');
  const text = (inp.text || '').trim();
  if (!text) throw new ValidationError('문장 내용을 입력하세요');
  if (!['fact', 'analysis', 'estimate', 'party_claim', 'unverified'].includes(inp.label)) throw new ValidationError('알 수 없는 라벨입니다');

  const own = new Set((await articlesOf(inp.event_id)).map((a) => a.id));
  const ids = [...new Set(inp.article_ids)].filter((x) => own.has(x));
  const arts: ArticleRow[] = [];
  for (const i of ids) arts.push((await d.prepare('SELECT * FROM articles WHERE id=?').get<ArticleRow>(i)) as ArticleRow);

  let label = inp.label;
  let factSuggested = inp.fact_suggested ? 1 : 0;
  const warnings: string[] = [];

  // FR-F2-02 출처 없는 문장은 [미확인]
  if (arts.length === 0) {
    if (label !== 'unverified') label = 'unverified';
    warnings.push('출처 없음');
  }

  // FR-F2-03 원문에 없는 수치·고유명사 (AI·CSV 생성 문장)
  if (inp.origin !== 'human' && arts.length) {
    const bad = ungroundedTokens(text, arts.map((a) => `${a.title} ${a.description ?? ''}`));
    if (bad.length) {
      warnings.push(`원문 미확인 표현 포함: ${bad.slice(0, 5).join(', ')}`);
      if (label === 'fact') factSuggested = 0;
      label = 'unverified';
    }
  }

  // FR-F2-04 / 06 / 11 [사실] 조건
  if (label === 'fact') {
    let reason: string | undefined;
    const chk = checkFact(arts, !!inp.human);
    if (!chk.ok) reason = chk.reason;
    else if (ev.content_conflict) reason = '내용 충돌이 표시된 사건입니다. 충돌 항목은 [미확인]으로 두고 양쪽 출처를 표시하세요';
    if (reason) {
      if (inp.downgrade) {
        label = 'unverified';
        factSuggested = 1;
        warnings.push(`[사실] 조건 미충족 → [미확인]으로 낮춤 (${reason})`);
      } else throw new ValidationError(reason);
    }
  }
  // AI·CSV 가 낸 [사실]은 승인 전까지 [사실 제안] (FR-F2-05)
  if (inp.origin !== 'human' && label === 'fact') {
    label = 'unverified';
    factSuggested = 1;
    warnings.push('[사실 제안] 실무자 승인 필요');
  }
  if (label === 'fact') factSuggested = 0;

  const now = nowIso();
  const approvedBy = label === 'fact' && inp.human ? inp.actor || '실무자' : null;
  let id = inp.id;
  await inTx(async () => {
    if (id) {
      const ex = await d.prepare('SELECT 1 FROM summary_statements WHERE id=? AND event_id=?').get(id, inp.event_id);
      if (!ex) throw new ValidationError('문장을 찾을 수 없습니다');
      await d.prepare('UPDATE summary_statements SET text=?, label=?, fact_suggested=?, approved_by=?, warnings=?, updated_at=? WHERE id=?').run(
        text, label, factSuggested, approvedBy, JSON.stringify(warnings), now, id,
      );
      await d.prepare('DELETE FROM statement_sources WHERE statement_id=?').run(id);
    } else {
      id = uuid();
      const pos = (await d.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM summary_statements WHERE event_id=?').get<{ p: number }>(inp.event_id))!.p;
      await d.prepare(
        'INSERT INTO summary_statements (id,event_id,position,text,label,fact_suggested,approved_by,origin,warnings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(id, inp.event_id, pos, text, label, factSuggested, approvedBy, inp.origin, JSON.stringify(warnings), now, now);
    }
    const ins = d.prepare('INSERT INTO statement_sources (statement_id,article_id) VALUES (?,?)');
    for (const a of ids) await ins.run(id, a);
    if (inp.origin === 'human') await d.prepare("UPDATE events SET summary_origin='human', updated_at=? WHERE id=? AND summary_origin='none'").run(now, inp.event_id);
  });
  return { id: id as string, label, warnings };
}

/** 문장 라벨 재검증: 사건의 출처가 바뀌면(병합 등) [사실]이 조건을 잃을 수 있다. */
export async function revalidateFacts(eventId: string) {
  const d = db();
  const sts = await d.prepare("SELECT id FROM summary_statements WHERE event_id=? AND label='fact'").all<{ id: string }>(eventId);
  for (const s of sts) {
    const arts = await d.prepare('SELECT a.* FROM articles a JOIN statement_sources ss ON ss.article_id=a.id WHERE ss.statement_id=?').all<ArticleRow>(s.id);
    if (!checkFact(arts, true).ok) {
      await d.prepare("UPDATE summary_statements SET label='unverified', fact_suggested=1, approved_by=NULL, updated_at=? WHERE id=?").run(nowIso(), s.id);
    }
  }
}

/* ───────────── 검토·병합 ───────────── */

export async function reviewBlockers(eventId: string): Promise<string[]> {
  const d = db();
  const ev = await d.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  const out: string[] = [];
  if (!ev) return ['사건을 찾을 수 없습니다'];
  if ((await articlesOf(eventId)).length < 1) out.push('연결된 기사가 1개 이상 필요합니다');
  if ((await d.prepare('SELECT COUNT(*) c FROM summary_statements WHERE event_id=?').get<{ c: number }>(eventId))!.c < 1) out.push('요약 문장이 1개 이상 필요합니다');
  if (!ev.event_type) out.push('사건 유형을 지정하세요');
  if (!ev.location_accuracy) out.push('위치 정확도를 지정하세요');
  return out;
}

/** FR-F1-18: 대표 사건에 모든 기사를 연결하고 나머지는 merged */
export async function mergeEvents(repId: string, otherId: string, candidateId?: string) {
  const d = db();
  if (repId === otherId) throw new ValidationError('같은 사건입니다');
  const rep = await d.prepare('SELECT * FROM events WHERE id=?').get(repId);
  const oth = await d.prepare('SELECT * FROM events WHERE id=?').get(otherId);
  if (!rep || !oth) throw new ValidationError('사건을 찾을 수 없습니다');
  await inTx(async () => {
    await d.prepare('UPDATE articles SET event_id=? WHERE event_id=?').run(repId, otherId);
    await d.prepare('UPDATE summary_statements SET event_id=?, position=position+1000 WHERE event_id=?').run(repId, otherId);
    await d.prepare("UPDATE events SET review_status='merged', merged_into=?, updated_at=? WHERE id=?").run(repId, nowIso(), otherId);
    if (candidateId) await d.prepare("UPDATE duplicate_candidates SET status='confirmed' WHERE id=?").run(candidateId);
    else
      await d.prepare("UPDATE duplicate_candidates SET status='confirmed' WHERE (event_a=? AND event_b=?) OR (event_a=? AND event_b=?)").run(repId, otherId, otherId, repId);
    // 병합된 사건에 걸려 있던 다른 후보는 대표 사건 기준으로 다시 계산
    await d.prepare("UPDATE duplicate_candidates SET status='dismissed' WHERE status='suggested' AND (event_a=? OR event_b=?)").run(otherId, otherId);
    const rows = await d.prepare('SELECT id FROM summary_statements WHERE event_id=? ORDER BY position, created_at').all<{ id: string }>(repId);
    let i = 0;
    for (const r of rows) await d.prepare('UPDATE summary_statements SET position=? WHERE id=?').run(++i, r.id);
    // 병합으로 한 사건에 합쳐지면 충돌 표시는 합산
    if (oth.content_conflict) await d.prepare('UPDATE events SET content_conflict=1 WHERE id=?').run(repId);
  });
  await recomputeEvent(repId);
  await revalidateFacts(repId);
  await findDuplicateCandidates(repId);
}

export { round3 };
