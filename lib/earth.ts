/**
 * 구글어스(웹) 연동. 좌표로 바로 이동하는 링크를 만든다 (계정·API 키 불필요, 새 탭에서 열림).
 * 형식: https://earth.google.com/web/search/<위도>,<경도>/@<위도>,<경도>,<고도>a,<카메라 거리>d,<시야각>y,<방위>h,<기울기>t,<회전>r
 */
export function googleEarthUrl(lat: number, lng: number, opts: { accuracy?: string | null; radiusKm?: number | null } = {}): string {
  const la = Math.round(lat * 1e5) / 1e5;
  const ln = Math.round(lng * 1e5) / 1e5;
  // 카메라 거리(m): 정확 → 3km 상공, "일대" → 반경 원이 화면에 들어오도록, 그 외 → 20km
  let dist = 20000;
  if (accuracyIs(opts.accuracy, 'exact')) dist = 3000;
  else if (accuracyIs(opts.accuracy, 'area') && opts.radiusKm) dist = Math.min(Math.max(opts.radiusKm * 3000, 5000), 800000);
  return `https://earth.google.com/web/search/${la},${ln}/@${la},${ln},0a,${Math.round(dist)}d,35y,0h,0t,0r`;
}

const accuracyIs = (v: string | null | undefined, k: string) => v === k;
