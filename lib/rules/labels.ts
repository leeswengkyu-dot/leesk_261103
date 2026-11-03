import { haversineKm } from '../geo';
import { EVENT_TYPES } from '../types';

export interface ArticleLite {
  source_name: string;
  source_grade: string;
  is_party_claim: number | boolean;
}

const isParty = (a: ArticleLite) => !!a.is_party_claim;

/** 사실 판정의 근거가 될 수 있는 기사 (당사자 주장 제외) */
export const evidenceArticles = (arts: ArticleLite[]) => arts.filter((a) => !isParty(a));

/** 독립 출처 수: source_name 이 다르고 D등급이 아닌 출처 (당사자 주장 제외) */
export function independentCount(arts: ArticleLite[]): number {
  const names = new Set(evidenceArticles(arts).filter((a) => a.source_grade !== 'D').map((a) => a.source_name));
  return names.size;
}

export interface FactCheck {
  ok: boolean;
  reason?: string;
}

/**
 * FR-F2-04 [사실] 조건.
 * (a) 서로 독립적인 출처 2개 이상, 또는 (b) A등급 기사 1개 이상 + 실무자 승인. 당사자 주장 기사는 제외.
 */
export function checkFact(arts: ArticleLite[], humanApproved: boolean): FactCheck {
  if (arts.length === 0) return { ok: false, reason: '연결된 출처가 없습니다. 출처가 있어야 [사실]로 저장할 수 있습니다' };
  const ev = evidenceArticles(arts);
  if (ev.length === 0) return { ok: false, reason: '당사자 주장 기사만 연결되어 있어 [사실]이 될 수 없습니다. [당사자 주장]으로 저장하세요' };
  if (independentCount(arts) >= 2) return { ok: true };
  if (humanApproved && ev.some((a) => a.source_grade === 'A')) return { ok: true };
  return { ok: false, reason: '독립 출처 2개 이상 또는 A등급 출처가 필요합니다' };
}

export interface Reliability {
  level: 'high' | 'medium' | 'low';
  basis: string;
}

/** FR-F2-08 사건 신뢰도 */
export function computeReliability(arts: ArticleLite[]): Reliability {
  const ev = evidenceArticles(arts);
  const ind = independentCount(arts);
  if (ind >= 2) return { level: 'high', basis: `독립 출처 ${ind}개가 확인됨 → 높음` };
  if (ev.some((a) => a.source_grade === 'A')) return { level: 'high', basis: 'A등급(공식) 출처 1개 이상 → 높음' };
  if (ev.some((a) => a.source_grade === 'B')) return { level: 'medium', basis: 'B등급 출처 1개 (단일) → 보통' };
  if (arts.length && ev.length === 0) return { level: 'low', basis: '당사자 주장 기사만 있음 → 낮음' };
  return { level: 'low', basis: 'C·D등급 출처만 있음 → 낮음' };
}

/** FR-F3-03 사건 단위 경보 사유 */
export function alertReasons(e: { event_type: string; location_conflict: number; content_conflict: number }): string[] {
  const r: string[] = [];
  if (EVENT_TYPES[e.event_type]?.alert) r.push(`type:${e.event_type}`);
  if (e.location_conflict) r.push('location_conflict');
  if (e.content_conflict) r.push('content_conflict');
  return r;
}

export const ALERT_TEXT: Record<string, string> = {
  location_conflict: '위치 충돌',
  content_conflict: '내용 충돌',
};
export function alertText(reason: string): string {
  if (reason.startsWith('type:')) return EVENT_TYPES[reason.slice(5)]?.name ?? reason;
  return ALERT_TEXT[reason] ?? reason;
}

/** FR-F3-03 지역 단위 급증: 최근 24시간 3건 이상이고 직전 24시간의 2배 이상 */
export function isSurge(cur: number, prev: number): boolean {
  return cur >= 3 && cur >= 2 * prev;
}

export interface DupLite {
  region: string;
  event_type: string;
  occurred_at: string | null;
  first_published_at: string;
  lat: number | null;
  lng: number | null;
}

/** FR-F1-16 중복 후보 조건 */
export function isDuplicateCandidate(a: DupLite, b: DupLite): boolean {
  if (a.region !== b.region) return false;
  if (a.event_type !== b.event_type) return false;
  const ta = new Date(a.occurred_at ?? a.first_published_at).getTime();
  const tb = new Date(b.occurred_at ?? b.first_published_at).getTime();
  if (Math.abs(ta - tb) > 24 * 3600_000) return false;
  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    if (haversineKm({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }) > 100) return false;
  }
  return true;
}

/**
 * FR-F2-03 원문 근거 검증: 문장의 숫자·영문 고유명사가 연결 기사의 제목·설명에 나타나는지.
 * 나타나지 않는 표현 목록을 돌려준다.
 */
export function ungroundedTokens(text: string, sourceTexts: string[]): string[] {
  const hay = sourceTexts.join(' ').toLowerCase();
  const bad: string[] = [];
  const nums = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  for (const n of nums) if (!hay.includes(n.toLowerCase())) bad.push(n);
  const names = text.match(/\b[A-Z][A-Za-z\-]{2,}(?:\s+[A-Z][A-Za-z\-]{2,})*/g) ?? [];
  for (const nm of names) if (!hay.includes(nm.toLowerCase())) bad.push(nm);
  return [...new Set(bad)];
}

/** 브리핑 "종합" 섹션에 허용되는 라벨 */
export const SUMMARY_ALLOWED_LABELS = ['fact', 'party_claim'];
