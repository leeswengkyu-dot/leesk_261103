import { db } from '@/lib/db';
import { read, write, body } from '@/lib/api';
import { getEventDetail, recomputeEvent, reviewBlockers, ValidationError, findDuplicateCandidates } from '@/lib/events';
import { generateSummary, suggestConflictAndChange } from '@/lib/ingest';
import { EVENT_TYPES } from '@/lib/types';
import { nowIso } from '@/lib/time';
import { round3, defaultAreaRadius } from '@/lib/geo';

export const dynamic = 'force-dynamic';
type P = { id: string };

export const GET = read<P>(async (_req, { params }) => {
  const { id } = await params;
  const det = getEventDetail(id);
  if (!det) throw new ValidationError('사건을 찾을 수 없습니다');
  return det;
});

/** 필드 수정. expected_updated_at 이 다르면 409 (동시 수정 경고) */
export const PATCH = write<P>(async (req, { params }) => {
  const { id } = await params;
  const b = await body<Record<string, unknown>>(req);
  const d = db();
  const ev = d.prepare('SELECT * FROM events WHERE id=?').get(id) as Record<string, unknown> | undefined;
  if (!ev) throw new ValidationError('사건을 찾을 수 없습니다');
  if (b.expected_updated_at && b.expected_updated_at !== ev.updated_at) {
    return Response.json({ error: '다른 사용자가 먼저 수정했습니다. 새로 불러올까요?', code: 'conflict' }, { status: 409 });
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => {
    sets.push(`${col}=?`);
    vals.push(v);
  };
  if (typeof b.title === 'string') {
    if (!b.title.trim()) throw new ValidationError('제목을 입력하세요');
    put('title', b.title.trim());
    if (b.title.trim() !== ev.title) put('title_ko', null); // 제목을 고치면 옛 번역은 무효
  }
  if ('country' in b) put('country', (b.country as string) || null);
  if ('location_name' in b) put('location_name', (b.location_name as string) || null);
  if (typeof b.region === 'string') {
    if (!['nk', 'me', 'ru_ua'].includes(b.region)) throw new ValidationError('지역 값이 올바르지 않습니다');
    put('region', b.region);
  }
  if (typeof b.event_type === 'string') {
    if (!EVENT_TYPES[b.event_type]) throw new ValidationError('사건 유형이 올바르지 않습니다');
    put('event_type', b.event_type);
  }
  if (typeof b.change_type === 'string') {
    if (!['new', 'continuing', 'escalated', 'ended'].includes(b.change_type)) throw new ValidationError('변화 구분이 올바르지 않습니다');
    put('change_type', b.change_type);
  }
  if (typeof b.location_accuracy === 'string') {
    if (!['exact', 'area', 'unknown'].includes(b.location_accuracy)) throw new ValidationError('위치 정확도가 올바르지 않습니다');
    put('location_accuracy', b.location_accuracy);
    if (b.location_accuracy === 'area' && !('area_radius_km' in b) && !ev.area_radius_km) put('area_radius_km', defaultAreaRadius((b.location_name as string) ?? (ev.location_name as string)));
    if (b.location_accuracy !== 'area') put('area_radius_km', null);
  }
  if ('area_radius_km' in b && (b.location_accuracy ?? ev.location_accuracy) === 'area') put('area_radius_km', b.area_radius_km === '' || b.area_radius_km == null ? null : Number(b.area_radius_km));
  if ('lat' in b || 'lng' in b) {
    const lat = b.lat === '' || b.lat == null ? null : Number(b.lat);
    const lng = b.lng === '' || b.lng == null ? null : Number(b.lng);
    if ((lat == null) !== (lng == null)) throw new ValidationError('위도와 경도를 함께 입력하세요');
    if (lat != null && (!isFinite(lat) || !isFinite(lng as number) || Math.abs(lat) > 90 || Math.abs(lng as number) > 180)) throw new ValidationError('좌표 형식이 올바르지 않습니다');
    put('lat', lat != null ? round3(lat) : null);
    put('lng', lng != null ? round3(lng as number) : null);
    put('coord_origin', lat != null ? 'human' : 'none');
    if (lat == null) put('location_accuracy', 'unknown');
  }
  if ('occurred_at' in b) put('occurred_at', (b.occurred_at as string) || null);
  if ('memo' in b) put('memo', (b.memo as string) || null);
  if ('content_conflict' in b) put('content_conflict', b.content_conflict ? 1 : 0);
  if ('conflict_note' in b) put('conflict_note', (b.conflict_note as string) || null);
  if (!sets.length) return { ok: true };
  put('updated_at', nowIso());
  d.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
  recomputeEvent(id);
  if ('region' in b || 'event_type' in b) findDuplicateCandidates(id);
  return { ok: true };
});

/** 동작: review / unreview / reject / restore / ai_summary / ai_conflict */
export const POST = write<P>(async (req, { params }) => {
  const { id } = await params;
  const b = await body<{ action: string; reviewer?: string; confirmed?: boolean }>(req);
  const d = db();
  const now = nowIso();
  switch (b.action) {
    case 'review': {
      const blockers = reviewBlockers(id);
      if (blockers.length) throw new ValidationError(blockers.join(' / '));
      if (!b.confirmed) throw new ValidationError('위치·유형·라벨·출처를 확인했다는 체크가 필요합니다');
      d.prepare("UPDATE events SET review_status='reviewed', reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=? AND review_status IN ('collected','reviewed')").run(b.reviewer?.trim() || null, now, now, id);
      return { ok: true };
    }
    case 'unreview':
      d.prepare("UPDATE events SET review_status='collected', reviewed_at=NULL, reviewed_by=NULL, updated_at=? WHERE id=? AND review_status='reviewed'").run(now, id);
      return { ok: true };
    case 'reject':
      d.prepare("UPDATE events SET review_status='rejected', updated_at=? WHERE id=?").run(now, id);
      return { ok: true };
    case 'restore':
      d.prepare("UPDATE events SET review_status='collected', updated_at=? WHERE id=? AND review_status='rejected'").run(now, id);
      return { ok: true };
    case 'ai_summary': {
      const n = await generateSummary(id);
      recomputeEvent(id);
      return { ok: true, count: n };
    }
    case 'ai_conflict': {
      const out = await suggestConflictAndChange(id);
      return { ok: true, suggestion: out };
    }
    default:
      throw new ValidationError('알 수 없는 동작입니다');
  }
});
