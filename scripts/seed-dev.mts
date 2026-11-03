/**
 * 개발용 시드 데이터 (24.1). 개발용 DB(argus-dev.db)에만 넣는다. 합성 데이터이므로 운영 DB 에는 절대 넣지 않는다.
 * 사용: npm run seed:dev   (DB_PATH 기본값 ./data/argus-dev.db)
 */
import path from 'node:path';

process.env.DB_PATH = process.env.DB_PATH || './data/argus-dev.db';
if (path.basename(process.env.DB_PATH) === 'argus.db') {
  console.error('운영 DB(argus.db)에는 합성 데이터를 넣을 수 없습니다. DB_PATH 를 개발용 DB 로 지정하세요.');
  process.exit(1);
}

const { db, uuid } = await import('../lib/db');
const { insertEvent } = await import('../lib/ingest');
const { recomputeEvent, saveStatement, articlesOf, defaultChangeType, findDuplicateCandidates } = await import('../lib/events');

const d = db();
if ((d.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c > 0) {
  console.log('이미 이벤트가 있어 시드를 건너뜁니다. (초기화하려면 data/argus-dev.db 를 지우고 다시 실행)');
  process.exit(0);
}

let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const now = Date.now();
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();

interface A {
  src: string;
  grade: 'A' | 'B' | 'C' | 'D';
  party?: boolean;
  lat?: number;
  lng?: number;
  loc?: string;
  ago?: number;
  title?: string;
}
interface S {
  text: string;
  label: string;
  arts: number[];
  ai?: boolean;
}
interface E {
  title: string;
  region: 'nk' | 'me' | 'ru_ua';
  type: string;
  ago: number;
  loc?: string;
  lat?: number;
  lng?: number;
  acc?: 'exact' | 'area' | 'unknown';
  radius?: number;
  arts: A[];
  st: S[];
  reviewed?: string;
  conflict?: boolean;
}

let n = 0;
function mk(e: E) {
  const lat = e.lat, lng = e.lng;
  const evId = insertEvent({
    title: e.title,
    region: e.region,
    country: e.region === 'nk' ? '북한' : e.region === 'me' ? '중동' : '우크라이나',
    location_name: e.loc,
    lat, lng,
    coord_origin: lat != null ? 'ai_estimated' : 'none',
    location_accuracy: e.acc ?? (lat != null ? 'exact' : 'unknown'),
    area_radius_km: e.acc === 'area' ? e.radius ?? 15 : null,
    occurred_at: iso(e.ago),
    event_type: e.type,
    summary_origin: 'human',
    first_published_at: iso(e.ago - 0.3),
  });
  e.arts.forEach((a, i) => {
    n++;
    d.prepare(
      `INSERT INTO articles (id,event_id,source_name,source_grade,is_party_claim,url,title,description,published_at,extracted_location_name,extracted_lat,extracted_lng,ai_status,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'done',?)`,
    ).run(uuid(), evId, a.src, a.grade, a.party ? 1 : 0, `https://example.com/seed/${n}`, a.title ?? e.title, `${e.title} 관련 보도(시드 데이터).`, iso(e.ago - 0.3 - (a.ago ?? i * 0.4)), a.loc ?? e.loc ?? null, a.lat ?? lat ?? null, a.lng ?? lng ?? null, new Date().toISOString());
  });
  const arts = articlesOf(evId);
  for (const s of e.st) {
    saveStatement({
      event_id: evId,
      text: s.text,
      label: s.label,
      article_ids: s.arts.map((i) => arts[i]?.id).filter(Boolean),
      origin: s.ai ? 'ai_api' : 'human',
      human: !s.ai,
      downgrade: true,
    });
  }
  if (e.conflict) d.prepare('UPDATE events SET content_conflict=1, conflict_note=? WHERE id=?').run('발사 수량: 매체 A는 1발, 매체 B는 2발로 보도', evId);
  const row = d.prepare('SELECT * FROM events WHERE id=?').get(evId) as never;
  d.prepare('UPDATE events SET change_type=? WHERE id=?').run(defaultChangeType(row), evId);
  recomputeEvent(evId);
  if (e.reviewed) d.prepare("UPDATE events SET review_status='reviewed', reviewed_by=?, reviewed_at=? WHERE id=?").run(e.reviewed, iso(1), evId);
  return evId;
}

const sites = [
  { n: '평안북도 동창리 일대', lat: 39.66, lng: 124.705 },
  { n: '영변 핵시설 일대', lat: 39.795, lng: 125.755 },
  { n: '평양 순안 일대', lat: 39.2, lng: 125.67 },
  { n: '함경남도 함흥 일대', lat: 39.918, lng: 127.536 },
  { n: '강원도 원산 일대', lat: 39.153, lng: 127.446 },
  { n: '함경북도 청진 일대', lat: 41.795, lng: 129.775 },
  { n: '신포 일대', lat: 40.035, lng: 128.185 },
  { n: '풍계리 일대', lat: 41.277, lng: 129.087 },
  { n: '개성 일대', lat: 37.971, lng: 126.554 },
  { n: '동해상', lat: 39.5, lng: 131.0 },
];

// ── 지정 사례 ──
mk({ title: '북한, 동해상으로 탄도미사일 1발 발사', region: 'nk', type: 'missile_launch', ago: 5, loc: '평양 순안 일대', lat: 39.2, lng: 125.67, acc: 'area', radius: 15,
  arts: [{ src: '합동참모본부', grade: 'A' }, { src: '연합뉴스', grade: 'B' }],
  st: [{ text: '합참은 북한이 동해상으로 탄도미사일 1발을 발사했다고 발표했다.', label: 'fact', arts: [0, 1] }, { text: '일부 언론은 추가 발사 가능성을 제기했다.', label: 'estimate', arts: [1] }], reviewed: '김분석' });
mk({ title: '조선중앙통신 "신형 전술유도무기 시험사격 성공"', region: 'nk', type: 'missile_launch', ago: 4, loc: '평안북도 일대', lat: 39.9, lng: 125.0, acc: 'area', radius: 60,
  arts: [{ src: '조선중앙통신', grade: 'C', party: true }],
  st: [{ text: '북한 관영매체는 신형 전술유도무기 시험사격에 성공했다고 주장했다.', label: 'party_claim', arts: [0] }, { text: '(시도) 사실로 저장 시도용 문장', label: 'unverified', arts: [0] }] });
mk({ title: '38 North "동창리 발사장 시설 확장 진행"', region: 'nk', type: 'nuclear', ago: 10, loc: '평안북도 동창리 일대', lat: 39.66, lng: 124.705, acc: 'area', radius: 15,
  arts: [{ src: '38 North', grade: 'B' }],
  st: [{ text: '38 North는 위성사진상 동창리 시설 확장이 진행 중이라고 평가했다.', label: 'analysis', arts: [0] }] });
mk({ title: 'IAEA, 영변 시설 가동 징후 보고', region: 'nk', type: 'nuclear', ago: 14, loc: '영변 핵시설 일대', lat: 39.795, lng: 125.755, acc: 'area', radius: 15,
  arts: [{ src: 'IAEA', grade: 'A' }],
  st: [{ text: 'IAEA는 영변 시설에서 가동 징후가 관찰된다고 보고했다.', label: 'unverified', arts: [0], ai: true }] });
mk({ title: '북한 포병 사격 정황 보도 (위치 충돌)', region: 'nk', type: 'armed_clash', ago: 8, loc: '서해 북방 일대', lat: 38.0, lng: 125.0, acc: 'area', radius: 60,
  arts: [{ src: '연합뉴스', grade: 'B', lat: 37.9, lng: 124.8, loc: '서해 5도 인근' }, { src: 'NK News', grade: 'C', lat: 38.4, lng: 125.2, loc: '황해남도 해안' }],
  st: [{ text: '두 매체는 서해 인근에서 포병 사격이 있었다고 보도했으나 위치가 서로 다르다.', label: 'unverified', arts: [0, 1] }] });
mk({ title: '북한 위치 불명 선박 동향 보도', region: 'nk', type: 'other', ago: 6, acc: 'unknown',
  arts: [{ src: 'NK News', grade: 'C' }], st: [{ text: 'NK News는 선박 이동 정황을 보도했다.', label: 'unverified', arts: [0] }] });
mk({ title: '북한, 미사일 발사 수량 보도 엇갈림', region: 'nk', type: 'missile_launch', ago: 20, loc: '함경남도 함흥 일대', lat: 39.918, lng: 127.536, acc: 'area', radius: 15, conflict: true,
  arts: [{ src: '연합뉴스', grade: 'B' }, { src: 'NK News', grade: 'C' }],
  st: [{ text: '한 매체는 1발, 다른 매체는 2발이 발사됐다고 보도했다.', label: 'unverified', arts: [0, 1] }] });
mk({ title: '통일부 "북한 담화 관련 입장 발표"', region: 'nk', type: 'official_statement', ago: 22, loc: '서울', lat: 37.57, lng: 126.98, acc: 'exact',
  arts: [{ src: '통일부', grade: 'A' }], st: [{ text: '통일부는 북한 담화와 관련해 입장을 발표했다.', label: 'fact', arts: [0] }], reviewed: '박검토' });
// 중복 후보 3쌍
const dupSites = [sites[3], sites[4], sites[5]];
dupSites.forEach((s, i) => {
  mk({ title: `북한 ${s.n.split(' ')[0]} ${s.n.split(' ')[1] ?? ''} 부근 군사 훈련 포착 (1)`, region: 'nk', type: 'military_exercise', ago: 12 + i, loc: s.n, lat: s.lat, lng: s.lng, acc: 'area', radius: 15,
    arts: [{ src: '연합뉴스', grade: 'B' }], st: [{ text: '연합뉴스는 해당 일대에서 훈련이 포착됐다고 보도했다.', label: 'unverified', arts: [0] }] });
  mk({ title: `${s.n} 군사 훈련 정황 (2)`, region: 'nk', type: 'military_exercise', ago: 11 + i, loc: s.n, lat: s.lat + 0.1, lng: s.lng + 0.1, acc: 'area', radius: 15,
    arts: [{ src: 'NK News', grade: 'C' }], st: [{ text: 'NK News는 같은 일대에서 훈련 정황을 전했다.', label: 'unverified', arts: [0] }] });
});

// 나머지 북한 사건 (최근 24시간 급증 + 직전 24시간 소수)
const types = ['missile_launch', 'military_exercise', 'official_statement', 'diplomacy', 'sanctions', 'other', 'nuclear', 'armed_clash'];
const typeKo: Record<string, string> = { missile_launch: '미사일 관련 동향', military_exercise: '군사 훈련 동향', official_statement: '담화 발표', diplomacy: '외교 동향', sanctions: '제재 관련 보도', other: '기타 동향', nuclear: '핵 관련 동향', armed_clash: '접경 충돌 보도' };
const srcPool: A[] = [{ src: '연합뉴스', grade: 'B' }, { src: 'NK News', grade: 'C' }, { src: '38 North', grade: 'B' }, { src: 'UN News', grade: 'A' }, { src: '통일부', grade: 'A' }];
let extra = 0;
while (extra < 30 - 8 - 6 - 0 && extra < 16) {
  const s = pick(sites);
  const t = pick(types);
  const ago = extra < 8 ? 1 + rnd() * 20 : extra < 11 ? 26 + rnd() * 18 : 50 + rnd() * 100;
  const a1 = pick(srcPool);
  const a2 = extra % 3 === 0 ? [pick(srcPool.filter((x) => x.src !== a1.src))] : [];
  mk({ title: `${s.n.split(' ')[0]} ${typeKo[t]} (${extra + 1})`, region: 'nk', type: t, ago, loc: s.n, lat: s.lat + (rnd() - 0.5) * 0.3, lng: s.lng + (rnd() - 0.5) * 0.3, acc: rnd() > 0.5 ? 'area' : 'exact', radius: 15,
    arts: [{ ...a1 }, ...a2],
    st: [{ text: `${a1.src}는 ${s.n}에서 ${typeKo[t]}이 있었다고 전했다.`, label: a2.length ? 'unverified' : 'unverified', arts: [0, ...a2.map((_, i) => i + 1)] }] });
  extra++;
}

// 이란·중동 5건, 러우전쟁 5건
const me: [string, string, number, number, number][] = [
  ['호르무즈 해협 인근 선박 충돌 보도', 'armed_clash', 26.5, 56.3, 9],
  ['이란, 우라늄 농축 관련 성명', 'nuclear', 35.7, 51.4, 18],
  ['가자 지구 휴전 협상 재개', 'diplomacy', 31.5, 34.45, 30],
  ['예멘 후티 홍해 선박 공격 주장', 'armed_clash', 15.4, 42.6, 7],
  ['이스라엘-레바논 접경 교전', 'armed_clash', 33.1, 35.5, 40],
];
me.forEach(([t, ty, la, ln, ago], i) =>
  mk({ title: t, region: 'me', type: ty, ago, loc: t.split(' ')[0], lat: la, lng: ln, acc: i % 2 ? 'area' : 'exact', radius: 60,
    arts: [{ src: 'BBC News 중동', grade: 'C' }, ...(i % 2 ? [{ src: 'Yonhap News (English)', grade: 'B' as const }] : [])],
    st: [{ text: `BBC News는 ${t}을(를) 보도했다.`, label: 'unverified', arts: [0] }] }),
);
const ru: [string, string, number, number, number][] = [
  ['하르키우 일대 공습 보도', 'armed_clash', 49.99, 36.23, 6],
  ['러시아, 드론 공격 발표', 'armed_clash', 50.45, 30.52, 15],
  ['우크라이나 에너지 시설 피해', 'other', 48.45, 34.98, 27],
  ['러-우 포로 교환 협상', 'diplomacy', 50.45, 30.52, 33],
  ['흑해 해상 드론 공격 주장', 'armed_clash', 44.6, 33.5, 12],
];
ru.forEach(([t, ty, la, ln, ago], i) =>
  mk({ title: t, region: 'ru_ua', type: ty, ago, loc: t.split(' ')[0], lat: la, lng: ln, acc: 'area', radius: 15,
    arts: [{ src: 'Kyiv Independent', grade: 'C', party: i === 1 }],
    st: [{ text: `Kyiv Independent는 ${t}을(를) 전했다.`, label: i === 1 ? 'party_claim' : 'unverified', arts: [0] }] }),
);

// 중복 후보 재계산
for (const r of d.prepare("SELECT id FROM events WHERE review_status='collected'").all() as { id: string }[]) findDuplicateCandidates(r.id);

const c = d.prepare('SELECT region, COUNT(*) c FROM events GROUP BY region').all();
console.log('시드 완료:', JSON.stringify(c), '중복 후보', (d.prepare("SELECT COUNT(*) c FROM duplicate_candidates").get() as { c: number }).c);
