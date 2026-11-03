export const REGIONS = { nk: '북한', me: '이란·중동', ru_ua: '러우전쟁' } as const;
export type Region = keyof typeof REGIONS;
export const REGION_KEYS: Region[] = ['nk', 'me', 'ru_ua'];

export const EVENT_TYPES: Record<string, { name: string; alert: boolean; icon: string }> = {
  missile_launch: { name: '미사일 발사', alert: true, icon: '🚀' },
  nuclear: { name: '핵 관련', alert: true, icon: '☢' },
  armed_clash: { name: '무력 충돌', alert: true, icon: '⚔' },
  military_exercise: { name: '군사 훈련', alert: false, icon: '🎯' },
  official_statement: { name: '공식 발표·담화', alert: false, icon: '📢' },
  diplomacy: { name: '외교', alert: false, icon: '🤝' },
  sanctions: { name: '제재', alert: false, icon: '⛔' },
  other: { name: '기타', alert: false, icon: '•' },
};

export const LABELS: Record<string, { name: string; cls: string }> = {
  fact: { name: '사실', cls: 'bg-green-100 text-green-900 border-green-300' },
  analysis: { name: '분석', cls: 'bg-blue-100 text-blue-900 border-blue-300' },
  estimate: { name: '추정', cls: 'bg-amber-100 text-amber-900 border-amber-300' },
  party_claim: { name: '당사자 주장', cls: 'bg-purple-100 text-purple-900 border-purple-300' },
  unverified: { name: '미확인', cls: 'bg-gray-100 text-gray-800 border-gray-300' },
};
export const LABEL_KEYS = ['fact', 'analysis', 'estimate', 'party_claim', 'unverified'] as const;
export type Label = (typeof LABEL_KEYS)[number];

export const RELIABILITY: Record<string, { name: string; letter: string; color: string }> = {
  high: { name: '높음', letter: 'H', color: '#15803d' },
  medium: { name: '보통', letter: 'M', color: '#b45309' },
  low: { name: '낮음', letter: 'L', color: '#6b7280' },
};

export const CHANGE_TYPES: Record<string, string> = {
  new: '신규',
  continuing: '지속',
  escalated: '확대',
  ended: '종료',
};

export const ACCURACY: Record<string, string> = { exact: '정확', area: '일대', unknown: '미상' };

export const REVIEW_STATUS: Record<string, string> = {
  collected: '수집함',
  reviewed: '검토 완료',
  rejected: '기각',
  merged: '병합됨',
};

/** 목록/지도에 내려가는 사건 요약 */
export interface EventRow {
  id: string;
  title: string;
  title_ko: string | null;
  sources: { name: string; grade: string }[];
  region: Region;
  country: string | null;
  location_name: string | null;
  lat: number | null;
  lng: number | null;
  coord_origin: string;
  location_accuracy: 'exact' | 'area' | 'unknown';
  area_radius_km: number | null;
  location_conflict: number;
  content_conflict: number;
  occurred_at: string | null;
  first_published_at: string;
  event_type: string;
  change_type: string;
  source_count: number;
  reliability: 'high' | 'medium' | 'low';
  alert_reasons: string[];
  review_status: string;
  summary_origin: string;
  dup_count: number;
  top_label: string;
  statement_count: number;
  conflict_circle: { lat: number; lng: number; radiusKm: number } | null;
}

export interface RegionSummary {
  region: Region;
  new: number;
  continuing: number;
  escalated: number;
  ended: number;
  cur: number;
  prev: number;
  surge: boolean;
}
