export interface Pt {
  lat: number;
  lng: number;
}

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function maxPairDistanceKm(pts: Pt[]): number {
  let m = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.max(m, haversineKm(pts[i], pts[j]));
  return m;
}

/** FR-F2-09: 중심 = 좌표 평균, 반경 = 중심에서 가장 먼 좌표까지 거리 + 5km */
export function conflictCircle(pts: Pt[]): { lat: number; lng: number; radiusKm: number } | null {
  if (pts.length < 2) return null;
  const c = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
  const r = Math.max(...pts.map((p) => haversineKm(c, p))) + 5;
  return { lat: c.lat, lng: c.lng, radiusKm: r };
}

export const LOCATION_CONFLICT_KM = 25;
export const DUPLICATE_KM = 100;

/** 지역별 경계 상자 (AI 좌표 사후 검증) */
export const REGION_BBOX: Record<string, { minLat: number; maxLat: number; minLng: number; maxLng: number }> = {
  nk: { minLat: 32.5, maxLat: 43.6, minLng: 123, maxLng: 132.5 },
  me: { minLat: 10, maxLat: 42.5, minLng: 25, maxLng: 66 },
  ru_ua: { minLat: 41, maxLat: 70, minLng: 20, maxLng: 62 },
};

export function inRegionBox(region: string, lat: number, lng: number): boolean {
  const b = REGION_BBOX[region];
  if (!b) return false;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/** 약 100m 단위로 반올림 (소수점 3자리) */
export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const REGION_VIEW: Record<string, { center: [number, number]; zoom: number }> = {
  nk: { center: [38.5, 127.5], zoom: 6 },
  me: { center: [29, 50], zoom: 5 },
  ru_ua: { center: [48.8, 31.5], zoom: 6 },
  all: { center: [38, 60], zoom: 3 },
};

/** "일대" 기본 반경 */
export function defaultAreaRadius(locationName?: string | null): number {
  const s = locationName || '';
  if (/(해상|동해|서해|남해|해역|바다|sea|gulf|strait)/i.test(s)) return 100;
  if (/(도 일대|주 일대|province|oblast)/i.test(s)) return 60;
  return 15;
}
