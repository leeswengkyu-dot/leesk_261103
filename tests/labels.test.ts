import { describe, expect, it } from 'vitest';
import { alertReasons, checkFact, computeReliability, isDuplicateCandidate, isSurge, ungroundedTokens } from '../lib/rules/labels';

const art = (source_name: string, source_grade: string, party = false) => ({ source_name, source_grade, is_party_claim: party });

describe('[사실] 조건 (AC-12~14)', () => {
  it('B등급 단일 출처는 [사실]이 될 수 없다 (AC-12)', () => {
    expect(checkFact([art('연합', 'B')], true).ok).toBe(false);
  });
  it('당사자 주장 기사만 있으면 [사실]이 될 수 없다 (AC-13)', () => {
    const r = checkFact([art('조선중앙통신', 'A', true)], true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('당사자');
  });
  it('독립 출처 2개면 [사실] 가능 (AC-14)', () => {
    expect(checkFact([art('연합', 'B'), art('38 North', 'B')], false).ok).toBe(true);
  });
  it('같은 출처명 2건은 독립이 아니다', () => {
    expect(checkFact([art('연합', 'B'), art('연합', 'B')], true).ok).toBe(false);
  });
  it('D등급(재인용)은 독립 출처로 세지 않는다', () => {
    expect(checkFact([art('연합', 'B'), art('블로그', 'D')], true).ok).toBe(false);
  });
  it('A등급 1개는 실무자 승인이 있어야 한다', () => {
    expect(checkFact([art('합참', 'A')], false).ok).toBe(false);
    expect(checkFact([art('합참', 'A')], true).ok).toBe(true);
  });
  it('출처가 없으면 거부', () => {
    expect(checkFact([], true).ok).toBe(false);
  });
});

describe('신뢰도', () => {
  it('독립 2개 → 높음', () => expect(computeReliability([art('a', 'C'), art('b', 'C')]).level).toBe('high'));
  it('A 1개 → 높음', () => expect(computeReliability([art('합참', 'A')]).level).toBe('high'));
  it('B 1개 → 보통', () => expect(computeReliability([art('연합', 'B')]).level).toBe('medium'));
  it('C만 → 낮음', () => expect(computeReliability([art('x', 'C')]).level).toBe('low'));
  it('당사자 주장만 → 낮음', () => expect(computeReliability([art('KCNA', 'A', true)]).level).toBe('low'));
});

describe('경보·급증·중복', () => {
  it('미사일 발사는 경보', () => expect(alertReasons({ event_type: 'missile_launch', location_conflict: 0, content_conflict: 0 })).toEqual(['type:missile_launch']));
  it('충돌은 경보 사유', () => expect(alertReasons({ event_type: 'other', location_conflict: 1, content_conflict: 1 })).toHaveLength(2));
  it('급증: 3건 이상이고 직전의 2배 이상', () => {
    expect(isSurge(3, 0)).toBe(true);
    expect(isSurge(2, 0)).toBe(false);
    expect(isSurge(6, 3)).toBe(true);
    expect(isSurge(5, 3)).toBe(false);
  });
  const base = { region: 'nk', event_type: 'missile_launch', occurred_at: '2026-11-02T00:00:00Z', first_published_at: '2026-11-02T00:00:00Z', lat: 39, lng: 125 };
  it('중복 후보 조건 충족', () => expect(isDuplicateCandidate(base, { ...base, occurred_at: '2026-11-02T10:00:00Z', lat: 39.2, lng: 125.1 })).toBe(true));
  it('24시간 초과면 후보 아님', () => expect(isDuplicateCandidate(base, { ...base, occurred_at: '2026-11-03T10:00:00Z' })).toBe(false));
  it('100km 초과면 후보 아님', () => expect(isDuplicateCandidate(base, { ...base, lat: 41, lng: 127 })).toBe(false));
  it('한쪽 좌표가 없으면 거리 조건은 통과', () => expect(isDuplicateCandidate(base, { ...base, lat: null, lng: null })).toBe(true));
  it('유형이 다르면 후보 아님', () => expect(isDuplicateCandidate(base, { ...base, event_type: 'nuclear' })).toBe(false));
});

describe('원문 근거 검증 (FR-F2-03)', () => {
  it('원문에 없는 숫자는 걸러낸다', () => {
    expect(ungroundedTokens('미사일 3발을 발사했다', ['북한이 미사일 1발을 발사'])).toEqual(['3']);
  });
  it('원문에 있으면 통과', () => {
    expect(ungroundedTokens('Pyongyang launched 1 missile', ['Pyongyang launched 1 missile today'])).toEqual([]);
  });
});
