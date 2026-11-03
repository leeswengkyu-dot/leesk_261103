/**
 * 지명 사전: AI 없이 기사 제목·설명에서 지명을 찾아 "일대" 수준 위치를 부여한다.
 * 도시·시설·해역 단위만 다루며(부대·개인 위치 아님), 결과는 항상 "추정 위치 — 확인 필요"로 표시된다.
 */
export interface Place {
  name: string;
  names: string[];
  lat: number;
  lng: number;
  radius: number;
}

const P = (name: string, names: string[], lat: number, lng: number, radius = 15): Place => ({ name, names, lat, lng, radius });

const NK: Place[] = [
  P('평양 일대', ['평양', 'pyongyang'], 39.019, 125.738),
  P('영변 핵시설 일대', ['영변', 'yongbyon'], 39.795, 125.755),
  P('평안북도 동창리 일대', ['동창리', 'sohae', 'tongchang-ri', 'tongchang'], 39.66, 124.705),
  P('풍계리 일대', ['풍계리', 'punggye-ri', 'punggye'], 41.277, 129.087),
  P('신포 일대', ['신포', 'sinpo'], 40.035, 128.185),
  P('함흥 일대', ['함흥', 'hamhung'], 39.918, 127.536),
  P('원산 일대', ['원산', 'wonsan'], 39.153, 127.446),
  P('청진 일대', ['청진', 'chongjin'], 41.795, 129.775),
  P('나진 일대', ['나진', '라진', 'rajin', 'nampho port'], 42.25, 130.3),
  P('개성 일대', ['개성', 'kaesong'], 37.971, 126.554),
  P('사리원 일대', ['사리원', 'sariwon'], 38.507, 125.762),
  P('남포 일대', ['남포', 'nampo', 'nampho'], 38.737, 125.407),
  P('신의주 일대', ['신의주', 'sinuiju'], 40.1, 124.4),
  P('해주 일대', ['해주', 'haeju'], 38.04, 125.71),
  P('강계 일대', ['강계', 'kanggye'], 40.97, 126.6),
  P('혜산 일대', ['혜산', 'hyesan'], 41.4, 128.17),
  P('김책 일대', ['김책', 'kimchaek'], 40.67, 129.2),
  P('판문점 일대', ['판문점', 'panmunjom'], 37.956, 126.677),
  P('비무장지대(DMZ) 일대', ['비무장지대', 'dmz', 'demilitarized zone', '군사분계선', 'mdl'], 38.3, 127.5, 60),
  P('백령도 인근 서해', ['백령도', '서해 5도', 'nll', 'northern limit line', 'baengnyeong'], 37.96, 124.67, 60),
  P('평안북도 일대', ['평안북도', 'north phyongan', 'north pyongan'], 40.0, 125.0, 60),
  P('평안남도 일대', ['평안남도', 'south phyongan', 'south pyongan'], 39.3, 126.0, 60),
  P('함경남도 일대', ['함경남도', 'south hamgyong'], 40.2, 127.5, 60),
  P('함경북도 일대', ['함경북도', 'north hamgyong'], 41.8, 129.0, 60),
  P('황해북도 일대', ['황해북도', 'north hwanghae'], 38.5, 126.3, 60),
  P('황해남도 일대', ['황해남도', 'south hwanghae'], 38.1, 125.2, 60),
  P('자강도 일대', ['자강도', 'jagang'], 40.5, 126.5, 60),
  P('양강도 일대', ['양강도', 'ryanggang'], 41.2, 128.0, 60),
  P('동해상', ['동해', 'east sea', 'sea of japan'], 39.5, 131.0, 100),
  P('서해상', ['서해', 'west sea', 'yellow sea'], 37.8, 124.5, 100),
];

const ME: Place[] = [
  P('테헤란 일대', ['테헤란', 'tehran'], 35.69, 51.39),
  P('나탄즈 일대', ['나탄즈', 'natanz'], 33.72, 51.73),
  P('포르도 일대', ['포르도', 'fordow'], 34.88, 50.99),
  P('이스파한 일대', ['이스파한', 'isfahan'], 32.65, 51.67),
  P('가자 지구 일대', ['가자', 'gaza'], 31.5, 34.47),
  P('예루살렘 일대', ['예루살렘', 'jerusalem'], 31.77, 35.21),
  P('텔아비브 일대', ['텔아비브', 'tel aviv'], 32.08, 34.78),
  P('베이루트 일대', ['베이루트', 'beirut'], 33.89, 35.5),
  P('레바논 일대', ['레바논', 'lebanon'], 33.85, 35.86, 60),
  P('다마스쿠스 일대', ['다마스쿠스', 'damascus'], 33.51, 36.28),
  P('바그다드 일대', ['바그다드', 'baghdad'], 33.31, 44.37),
  P('예멘 일대', ['예멘', '후티', 'yemen', 'houthi'], 15.35, 44.2, 60),
  P('호르무즈 해협', ['호르무즈', 'hormuz'], 26.57, 56.25, 100),
  P('홍해', ['홍해', 'red sea'], 20.0, 38.0, 100),
];

const RU: Place[] = [
  P('키이우 일대', ['키이우', '키예프', 'kyiv', 'kiev'], 50.45, 30.52),
  P('하르키우 일대', ['하르키우', 'kharkiv'], 49.99, 36.23),
  P('오데사 일대', ['오데사', 'odesa', 'odessa'], 46.48, 30.73),
  P('자포리자 일대', ['자포리자', 'zaporizhzhia', 'zaporizhia'], 47.84, 35.14),
  P('도네츠크 일대', ['도네츠크', 'donetsk'], 48.0, 37.8),
  P('루한스크 일대', ['루한스크', 'luhansk'], 48.57, 39.31),
  P('헤르손 일대', ['헤르손', 'kherson'], 46.64, 32.62),
  P('바흐무트 일대', ['바흐무트', 'bakhmut'], 48.59, 38.0),
  P('포크로우스크 일대', ['포크로우스크', 'pokrovsk'], 48.28, 37.18),
  P('수미 일대', ['수미', 'sumy'], 50.91, 34.8),
  P('드니프로 일대', ['드니프로', 'dnipro'], 48.46, 35.05),
  P('마리우폴 일대', ['마리우폴', 'mariupol'], 47.1, 37.54),
  P('쿠르스크 일대', ['쿠르스크', 'kursk'], 51.73, 36.19),
  P('모스크바 일대', ['모스크바', 'moscow'], 55.75, 37.62),
  P('크림반도 일대', ['크림', 'crimea'], 45.0, 34.1, 60),
  P('흑해', ['흑해', 'black sea'], 43.5, 34.0, 100),
];

const BY_REGION: Record<string, Place[]> = { nk: NK, me: ME, ru_ua: RU };

function hit(text: string, n: string): boolean {
  const t = text.toLowerCase();
  if (/^[a-z\- ]+$/.test(n)) return new RegExp(`(^|[^a-z])${n.replace(/[-\s]/g, '[-\\s]?')}([^a-z]|$)`).test(t);
  return t.includes(n);
}

/** 사건 지역에 해당하는 지명 사전에서 가장 먼저 나오는(구체적인 순서) 지명을 찾는다 */
export function locate(text: string, region: string): Place | null {
  for (const p of BY_REGION[region] ?? []) if (p.names.some((n) => hit(text, n))) return p;
  return null;
}
