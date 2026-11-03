import { db } from './db';
import { nowIso } from './time';
import { aiJson, aiStatus, AiUnavailable } from './ai/provider';
import { T5_SYSTEM } from './ai/prompts';
import { T5Schema } from './ai/schemas';

/**
 * 중복 후보 AI 1차 판단 (제안만 한다. 병합·기각은 사람이 확정).
 * 기준 사건 1건 + 후보 사건 여러 건을 한 번의 AI 호출로 판단해 duplicate_candidates 에 기록한다.
 */

/** 한 번의 AI 호출에 넣는 후보 수 */
const CHUNK = 10;
/** 수집 1회당 중복 판단에 쓰는 AI 호출 상한 */
const callsPerRun = () => parseInt(process.env.DUP_AI_CALLS ?? '12', 10);

interface Cand {
  id: string;
  other_id: string;
}

async function eventBrief(id: string) {
  const d = db();
  const e = await d
    .prepare('SELECT id,title,title_ko,occurred_at,first_published_at,location_name,country,event_type FROM events WHERE id=?')
    .get<Record<string, string | null>>(id);
  if (!e) return null;
  const arts = await d
    .prepare('SELECT source_name,title,description,published_at FROM articles WHERE event_id=? ORDER BY published_at LIMIT 3')
    .all<{ source_name: string; title: string; description: string | null; published_at: string }>(id);
  return {
    제목: e.title,
    시각: e.occurred_at ?? e.first_published_at,
    위치: e.location_name ?? e.country ?? null,
    기사: arts.map((a) => ({ 출처: a.source_name, 제목: a.title, 설명: (a.description ?? '').slice(0, 300), 게시시각: a.published_at })),
  };
}

/** 기준 사건과 후보들을 판단해 저장한다. 판단한 후보 수를 돌려준다 */
async function judgeGroup(baseId: string, cands: Cand[]): Promise<number> {
  const base = await eventBrief(baseId);
  if (!base) return 0;
  const list: (Cand & { brief: NonNullable<Awaited<ReturnType<typeof eventBrief>>> })[] = [];
  for (const c of cands) {
    const b = await eventBrief(c.other_id);
    if (b) list.push({ ...c, brief: b });
  }
  if (!list.length) return 0;
  const input = { 기준사건: base, 후보: list.map((c, i) => ({ 번호: i + 1, ...c.brief })) };
  const out = await aiJson(T5_SYSTEM, JSON.stringify(input), T5Schema);
  const upd = db().prepare('UPDATE duplicate_candidates SET ai_verdict=?, ai_confidence=?, ai_reason=?, ai_checked_at=? WHERE id=?');
  const now = nowIso();
  let n = 0;
  for (const r of out.results) {
    const c = list[r.number - 1];
    if (!c) continue; // 존재하지 않는 번호는 버린다
    const conf = Math.round(Math.max(0, Math.min(1, r.confidence > 1 ? r.confidence / 100 : r.confidence)) * 100);
    await upd.run(r.verdict, conf, r.reason.slice(0, 300), now, c.id);
    n++;
  }
  return n;
}

/** 특정 사건의 중복 후보를 판단한다 (상세 패널의 "AI 중복 판단" 버튼). force 면 이미 판단한 것도 다시 판단 */
export async function judgeDuplicatesFor(eventId: string, force = false): Promise<number> {
  const rows = await db()
    .prepare(
      `SELECT id, CASE WHEN event_a=? THEN event_b ELSE event_a END other_id FROM duplicate_candidates
       WHERE (event_a=? OR event_b=?) AND status='suggested' ${force ? '' : 'AND ai_verdict IS NULL'} ORDER BY created_at`,
    )
    .all<Cand>(eventId, eventId, eventId);
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) n += await judgeGroup(eventId, rows.slice(i, i + CHUNK));
  return n;
}

/** 수집 때 아직 판단하지 않은 중복 후보를 몇 건씩 판단한다 (기존 후보도 차례로 채워짐) */
export async function judgePendingDuplicates(deadline = Infinity): Promise<{ calls: number; judged: number; note: string | null }> {
  const res = { calls: 0, judged: 0, note: null as string | null };
  const max = callsPerRun();
  if (max <= 0 || !(await aiStatus()).available) return res;
  const rows = await db()
    .prepare("SELECT id, event_a, event_b FROM duplicate_candidates WHERE status='suggested' AND ai_verdict IS NULL ORDER BY created_at DESC")
    .all<{ id: string; event_a: string; event_b: string }>();
  // 같은 기준 사건(event_a)끼리 묶어 한 번에 판단한다
  const groups = new Map<string, Cand[]>();
  for (const r of rows) {
    const g = groups.get(r.event_a) ?? [];
    g.push({ id: r.id, other_id: r.event_b });
    groups.set(r.event_a, g);
  }
  outer: for (const [baseId, cands] of groups) {
    for (let i = 0; i < cands.length; i += CHUNK) {
      if (res.calls >= max || Date.now() > deadline) break outer;
      res.calls++;
      try {
        res.judged += await judgeGroup(baseId, cands.slice(i, i + CHUNK));
      } catch (e) {
        if (e instanceof AiUnavailable) {
          res.note = e.message;
          break outer;
        }
        res.note = `중복 판단 실패: ${(e as Error).message.slice(0, 120)}`;
      }
    }
  }
  return res;
}
