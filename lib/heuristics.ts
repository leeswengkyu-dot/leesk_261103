import { EVENT_TYPES } from './types';

/** AI 없이 사용하는 키워드 규칙 (지역 판별 / 사건 유형 추정). 정확하지 않으므로 실무자 검토가 전제. */

const REGION_PATTERNS: [string, RegExp][] = [
  ['nk', /북한|북측|평양|김정은|조선중앙|노동당|인민군|동창리|영변|north korea|dprk|pyongyang|kim jong[- ]un|korean peninsula|kcna/i],
  ['ru_ua', /우크라이나|러시아|키이우|돈바스|ukrain|russia|kyiv|kiev|donbas|zelensk|putin|crimea|kremlin/i],
  ['me', /이란|이스라엘|가자|중동|하마스|헤즈볼라|예멘|후티|시리아|레바논|이라크|iran|israel|gaza|middle east|hamas|hezbollah|yemen|houthi|syria|lebanon|iraq|tehran|red sea|hormuz/i],
];

export function guessRegion(text: string, feedRegion: string): string | null {
  if (feedRegion === 'nk' || feedRegion === 'me' || feedRegion === 'ru_ua') return feedRegion;
  for (const [r, re] of REGION_PATTERNS) if (re.test(text)) return r;
  return null;
}

// 미사일 발사: "미사일" 같은 단어만으로는 부족하고, 실제 발사·시험 행위를 뜻하는 표현이 함께 있어야 한다
const LAUNCH_OBJ = /미사일|탄도|순항|발사체|방사포|탄두|집속탄|icbm|slbm|missile|projectile|ballistic|rocket|warhead/i;
const LAUNCH_ACT = /발사(?!체|대|장)|시험(?!장)|시험사격|쏘아|쐈|fires?\b|fired|launch(es|ed|ing)?\b|test[- ]fir|\btest(s|ed)?\b/i;
// 사설·분석·전망 기사 (사건 보도가 아님 → 기타)
const ANALYSIS = /사설|칼럼|기고|분석|전망|해설|위협할 수|editorial|opinion|analysis|commentary|explainer/i;
// 다른 나라를 비난·규탄하는 담화·성명 (경보 대상이 아님 → 공식 발표)
const STATEMENT = /비난|규탄|반발|논평|담화|성명|condemn|slam|blast|criticiz|denounc/i;

const TYPE_PATTERNS: [string, RegExp][] = [
  ['nuclear', /핵(?!심)|nuclear|uranium|enrichment|iaea|plutonium|영변/i],
  ['armed_clash', /교전|공습|폭격|포격|총격|전투|공격(?!적)|airstrike|clash|shelling|drone attack|missile attack|offensive|\battack(ed|s)?\b|\bstrikes? on\b/i],
  ['military_exercise', /훈련|연합연습|기동|exercise|drill|maneuver/i],
  ['sanctions', /제재|sanction/i],
  ['diplomacy', /회담|정상|외교|협상|담판|방중|방러|방북|summit|talks|diplomat|negotiat|ceasefire|휴전/i],
  ['official_statement', /발표|statement|spokesperson|announce/i],
];

export function guessEventType(text: string): string {
  if (ANALYSIS.test(text)) return 'other';
  if (LAUNCH_OBJ.test(text) && LAUNCH_ACT.test(text) && !STATEMENT.test(text)) return 'missile_launch';
  if (STATEMENT.test(text)) return 'official_statement';
  for (const [t, re] of TYPE_PATTERNS) if (re.test(text) && EVENT_TYPES[t]) return t;
  return 'other';
}
