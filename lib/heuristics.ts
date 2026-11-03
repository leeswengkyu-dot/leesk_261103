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

const TYPE_PATTERNS: [string, RegExp][] = [
  ['missile_launch', /미사일|탄도|순항|발사체|발사|missile|icbm|rocket launch|ballistic/i],
  ['nuclear', /핵|nuclear|uranium|enrichment|iaea|plutonium|영변/i],
  ['armed_clash', /교전|충돌|공습|폭격|포격|총격|전투|airstrike|clash|shelling|attack|strike|drone attack|offensive/i],
  ['military_exercise', /훈련|연합연습|기동|exercise|drill|maneuver/i],
  ['sanctions', /제재|sanction/i],
  ['diplomacy', /회담|정상|외교|협상|담판|summit|talks|diplomat|negotiat|ceasefire|휴전/i],
  ['official_statement', /담화|성명|발표|statement|spokesperson|announce/i],
];

export function guessEventType(text: string): string {
  for (const [t, re] of TYPE_PATTERNS) if (re.test(text) && EVENT_TYPES[t]) return t;
  return 'other';
}
