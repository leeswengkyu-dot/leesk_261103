import { db, uuid } from './db';
import { nowIso, parseTime } from './time';
import { inRegionBox, round3, defaultAreaRadius } from './geo';
import { aiJson, aiStatus, AiUnavailable, batchLimit } from './ai/provider';
import { T1Schema, T2Schema, T3Schema, type T1 } from './ai/schemas';
import { T1_SYSTEM, T2_SYSTEM, T3_SYSTEM } from './ai/prompts';
import { guessEventType, guessRegion } from './heuristics';
import { locate } from './gazetteer';
import { articlesOf, defaultChangeType, findDuplicateCandidates, recomputeEvent, saveStatement, type ArticleRow } from './events';

interface PendingArticle extends ArticleRow {
  feed_region: string | null;
  feed_party: number | null;
}

interface NewEvent {
  title: string;
  region: string;
  country?: string | null;
  location_name?: string | null;
  lat?: number | null;
  lng?: number | null;
  coord_origin: 'ai_estimated' | 'gazetteer' | 'human' | 'csv' | 'none';
  location_accuracy: 'exact' | 'area' | 'unknown';
  area_radius_km?: number | null;
  occurred_at?: string | null;
  event_type: string;
  summary_origin: 'ai_api' | 'pre_generated' | 'human' | 'none';
  first_published_at: string;
}

export function insertEvent(n: NewEvent): string {
  const id = uuid();
  const now = nowIso();
  const lat = n.lat != null ? round3(n.lat) : null;
  const lng = n.lng != null ? round3(n.lng) : null;
  db()
    .prepare(
      `INSERT INTO events (id,title,region,country,location_name,lat,lng,coord_origin,location_accuracy,area_radius_km,occurred_at,first_published_at,event_type,change_type,summary_origin,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, n.title, n.region, n.country ?? null, n.location_name ?? null, lat, lng, lat != null ? n.coord_origin : 'none', n.location_accuracy, n.area_radius_km ?? null, n.occurred_at ?? null, n.first_published_at, n.event_type, 'new', n.summary_origin, now, now);
  return id;
}

/** AI 추출 결과 검증 (좌표 경계, 부대·개인 위치) */
function sanitizeT1(t: T1, region: string): T1 {
  const o = { ...t };
  let lat = o.lat ?? null;
  let lng = o.lng ?? null;
  if (o.unit_or_person_location) {
    lat = lng = null;
    o.location_accuracy = 'unknown';
  }
  if (lat != null && lng != null && !inRegionBox(region, lat, lng)) {
    lat = lng = null;
    o.location_accuracy = 'unknown';
  }
  if (lat == null || lng == null) {
    lat = lng = null;
    o.location_accuracy = 'unknown';
  }
  o.lat = lat;
  o.lng = lng;
  if (o.location_accuracy === 'area' && !o.area_radius_km) o.area_radius_km = defaultAreaRadius(o.location_name);
  return o;
}

function attachEvent(article: ArticleRow, evId: string, loc?: { name?: string | null; lat?: number | null; lng?: number | null }, aiStatusVal: string = 'done') {
  db()
    .prepare('UPDATE articles SET event_id=?, ai_status=?, extracted_location_name=?, extracted_lat=?, extracted_lng=? WHERE id=?')
    .run(evId, aiStatusVal, loc?.name ?? null, loc?.lat != null ? round3(loc.lat) : null, loc?.lng != null ? round3(loc.lng) : null, article.id);
}

function finishEvent(evId: string) {
  const d = db();
  const e = d.prepare('SELECT * FROM events WHERE id=?').get(evId) as { id: string; region: string; event_type: string; occurred_at: string | null; first_published_at: string; lat: number | null; lng: number | null };
  const ct = defaultChangeType(e);
  d.prepare('UPDATE events SET change_type=? WHERE id=?').run(ct, evId);
  recomputeEvent(evId);
  findDuplicateCandidates(evId);
}

/** AI 없이(또는 실패 시) 기사 제목·키워드 규칙으로 사건을 만든다. 관련 없으면 null */
function createHeuristicEvent(a: PendingArticle, status: 'failed' | 'skipped'): string | null {
  const text = `${a.title} ${a.description ?? ''}`;
  const region = guessRegion(text, a.feed_region ?? 'global');
  if (!region) {
    db().prepare("UPDATE articles SET ai_status='skipped' WHERE id=?").run(a.id);
    return null;
  }
  const place = locate(text, region);
  const evId = insertEvent({
    title: a.title.slice(0, 300),
    region,
    location_name: place?.name ?? null,
    lat: place?.lat ?? null,
    lng: place?.lng ?? null,
    coord_origin: 'gazetteer',
    location_accuracy: place ? 'area' : 'unknown',
    area_radius_km: place?.radius ?? null,
    event_type: guessEventType(text),
    summary_origin: 'none',
    first_published_at: a.published_at,
  });
  attachEvent(a, evId, place ? { name: place.name, lat: place.lat, lng: place.lng } : undefined, status);
  finishEvent(evId);
  return evId;
}

async function createAiEvent(a: PendingArticle): Promise<string | null> {
  const feedRegion = a.feed_region && a.feed_region !== 'global' ? a.feed_region : null;
  const user = JSON.stringify({
    제목: a.title,
    설명: a.description ?? '',
    출처: a.source_name,
    출처등급: a.source_grade,
    당사자_출처: !!a.feed_party,
    게시시각: a.published_at,
    힌트_지역: feedRegion,
  });
  const raw = await aiJson(T1_SYSTEM, user, T1Schema);
  if (!raw.relevant || !(raw.region || feedRegion)) {
    db().prepare("UPDATE articles SET ai_status='done' WHERE id=?").run(a.id);
    return null;
  }
  const region = (raw.region || feedRegion) as string;
  const t = sanitizeT1(raw, region);
  let originKind: 'ai_estimated' | 'gazetteer' = 'ai_estimated';
  if (t.lat == null) {
    // AI 가 위치를 못 찾으면 지명 사전으로 보완
    const place = locate(`${a.title} ${a.description ?? ''}`, region);
    if (place) {
      t.lat = place.lat;
      t.lng = place.lng;
      t.location_name = t.location_name || place.name;
      t.location_accuracy = 'area';
      t.area_radius_km = place.radius;
      originKind = 'gazetteer';
    }
  }
  const isParty = !!(t.is_party_claim || a.feed_party);
  const evId = insertEvent({
    title: a.title.slice(0, 300),
    region,
    country: t.country,
    location_name: t.location_name,
    lat: t.lat,
    lng: t.lng,
    coord_origin: originKind,
    location_accuracy: t.location_accuracy,
    area_radius_km: t.location_accuracy === 'area' ? t.area_radius_km : null,
    occurred_at: parseTime(t.occurred_at),
    event_type: t.event_type,
    summary_origin: t.summary ? 'ai_api' : 'none',
    first_published_at: a.published_at,
  });
  attachEvent(a, evId, { name: t.location_name, lat: t.lat, lng: t.lng }, 'done');
  db().prepare('UPDATE articles SET is_party_claim=? WHERE id=?').run(isParty ? 1 : 0, a.id);
  if (t.summary) {
    // FR-F1-13: 수집 직후 모든 요약 문장은 [미확인]으로 시작
    saveStatement({ event_id: evId, text: t.summary, label: 'unverified', article_ids: [a.id], origin: 'ai_api', downgrade: true });
  }
  finishEvent(evId);
  return evId;
}

/** 위치가 비어 있는 기존 수집함 사건에 지명 사전으로 위치를 채운다 (사람이 고친 위치는 건드리지 않음) */
export function backfillLocations(): number {
  const d = db();
  const rows = d
    .prepare("SELECT id, region FROM events WHERE review_status='collected' AND lat IS NULL AND coord_origin IN ('none','gazetteer')")
    .all() as { id: string; region: string }[];
  let n = 0;
  for (const r of rows) {
    const arts = articlesOf(r.id);
    const place = locate(arts.map((a) => `${a.title} ${a.description ?? ''}`).join(' '), r.region);
    if (!place) continue;
    d.prepare(
      "UPDATE events SET location_name=COALESCE(location_name,?), lat=?, lng=?, coord_origin='gazetteer', location_accuracy='area', area_radius_km=?, updated_at=? WHERE id=?",
    ).run(place.name, round3(place.lat), round3(place.lng), place.radius, nowIso(), r.id);
    d.prepare('UPDATE articles SET extracted_location_name=?, extracted_lat=?, extracted_lng=? WHERE event_id=? AND extracted_lat IS NULL').run(place.name, round3(place.lat), round3(place.lng), r.id);
    recomputeEvent(r.id);
    n++;
  }
  return n;
}

export interface ProcessResult {
  processed: number;
  events: number;
  failed: number;
  pendingLeft: number;
  aiNote: string | null;
}

/** FR-F1-10~15: pending 기사를 사건으로 만든다 (실행당 최대 AI_BATCH_LIMIT 건) */
export async function processPendingArticles(): Promise<ProcessResult> {
  const d = db();
  const pending = d
    .prepare(
      `SELECT a.*, f.region feed_region, f.is_party_source feed_party FROM articles a LEFT JOIN feeds f ON f.id=a.feed_id
       WHERE a.ai_status='pending' AND a.event_id IS NULL ORDER BY a.published_at DESC`,
    )
    .all() as PendingArticle[];
  const res: ProcessResult = { processed: 0, events: 0, failed: 0, pendingLeft: 0, aiNote: null };
  let aiCount = 0;
  const limit = batchLimit();
  let aiOff = !aiStatus().available;
  if (aiOff) res.aiNote = aiStatus().reason;

  for (const a of pending) {
    if (a.feed_party) d.prepare('UPDATE articles SET is_party_claim=1 WHERE id=?').run(a.id);
    if (!aiOff && aiCount >= limit) {
      res.pendingLeft++;
      continue; // 다음 실행에서 처리
    }
    if (aiOff) {
      const st = aiStatus();
      if (st.code === 'limit') {
        res.pendingLeft++;
        continue;
      }
      // API 키 없음·사전 생성만 모드: 키워드 규칙으로 사건 생성
      const id = createHeuristicEvent(a, 'skipped');
      res.processed++;
      if (id) res.events++;
      continue;
    }
    aiCount++;
    try {
      const id = await createAiEvent(a);
      res.processed++;
      if (id) res.events++;
    } catch (e) {
      if (e instanceof AiUnavailable && e.code === 'limit') {
        res.pendingLeft++;
        aiOff = true;
        res.aiNote = e.message;
        continue;
      }
      res.failed++;
      res.processed++;
      const id = createHeuristicEvent(a, 'failed');
      if (id) res.events++;
      res.aiNote = `AI 처리 실패: ${(e as Error).message.slice(0, 120)}`;
    }
  }
  return res;
}

/* ───────────── T2 / T3 (상세 패널에서 호출) ───────────── */

export async function generateSummary(eventId: string): Promise<number> {
  const arts = articlesOf(eventId);
  if (!arts.length) throw new Error('연결된 기사가 없습니다');
  const input = arts.map((a, i) => ({
    번호: i + 1,
    출처: a.source_name,
    등급: a.source_grade,
    당사자주장: !!a.is_party_claim,
    제목: a.title,
    설명: a.description ?? '',
    게시시각: a.published_at,
  }));
  let out;
  try {
    out = await aiJson(T2_SYSTEM, JSON.stringify(input), T2Schema);
  } catch (e) {
    db().prepare("UPDATE articles SET ai_status='failed' WHERE event_id=? AND ai_status<>'done'").run(eventId);
    throw e;
  }
  let n = 0;
  for (const s of out.statements) {
    const ids = s.source_numbers.map((x) => arts[x - 1]?.id).filter(Boolean) as string[]; // 존재하지 않는 번호 제거
    saveStatement({
      event_id: eventId,
      text: s.text,
      label: s.label,
      article_ids: ids,
      origin: 'ai_api',
      fact_suggested: s.fact_suggested || s.label === 'fact',
      downgrade: true,
    });
    n++;
  }
  db().prepare("UPDATE events SET summary_origin='ai_api', updated_at=? WHERE id=?").run(nowIso(), eventId);
  return n;
}

/** T3: 충돌·변화 제안. 제안으로만 반환하고 사람이 확정한다. */
export async function suggestConflictAndChange(eventId: string) {
  const arts = articlesOf(eventId);
  const input = arts.map((a, i) => ({ 번호: i + 1, 출처: a.source_name, 제목: a.title, 설명: a.description ?? '', 위치: a.extracted_location_name, 게시시각: a.published_at }));
  return aiJson(T3_SYSTEM, JSON.stringify(input), T3Schema);
}
