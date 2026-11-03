import { db, uuid } from './db';
import { nowIso, kstDate } from './time';
import { aiJson } from './ai/provider';
import { T4Schema } from './ai/schemas';
import { T4_SYSTEM } from './ai/prompts';
import { checkFact, SUMMARY_ALLOWED_LABELS } from './rules/labels';
import { ValidationError, type ArticleRow } from './events';
import { REGION_KEYS, CHANGE_TYPES } from './types';

export interface BSentence {
  id: string;
  text: string;
  label: string;
  source_numbers: number[];
  event_ids: string[];
}
export interface BSource {
  n: number;
  article_id: string;
  source_name: string;
  source_grade: string;
  url: string;
  title: string;
  published_at: string;
}
export interface BContent {
  summary: BSentence[];
  regions: { region: string; sentences: BSentence[] }[];
  changes: BSentence[];
  watch: BSentence[];
  sources: BSource[];
}

const RANK: Record<string, number> = { unverified: 0, estimate: 1, analysis: 2, party_claim: 3, fact: 4 };
const sid = () => uuid().slice(0, 8);

interface StRow {
  id: string;
  event_id: string;
  text: string;
  label: string;
  fact_suggested: number;
  position: number;
}

export function emptyContent(): BContent {
  return { summary: [], regions: REGION_KEYS.map((region) => ({ region, sentences: [] })), changes: [], watch: [], sources: [] };
}

function reviewedEvents(ids: string[]) {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return db().prepare(`SELECT * FROM events WHERE id IN (${ph}) AND review_status='reviewed'`).all(...ids) as Record<string, unknown>[];
}

function buildSources(eventIds: string[]): BSource[] {
  if (!eventIds.length) return [];
  const ph = eventIds.map(() => '?').join(',');
  const arts = db().prepare(`SELECT * FROM articles WHERE event_id IN (${ph}) ORDER BY published_at ASC`).all(...eventIds) as ArticleRow[];
  return arts.map((a, i) => ({ n: i + 1, article_id: a.id, source_name: a.source_name, source_grade: a.source_grade, url: a.url, title: a.title, published_at: a.published_at }));
}

function stmtSources(stId: string, srcs: BSource[]): number[] {
  const ids = (db().prepare('SELECT article_id FROM statement_sources WHERE statement_id=?').all(stId) as { article_id: string }[]).map((r) => r.article_id);
  return srcs.filter((s) => ids.includes(s.article_id)).map((s) => s.n);
}

/** 규칙 기반 초안 (AI 없이도 승인된 문장만으로 구성) */
function ruleDraft(events: Record<string, unknown>[], sts: StRow[], srcs: BSource[]): BContent {
  const c = emptyContent();
  c.sources = srcs;
  const evBy = new Map(events.map((e) => [e.id as string, e]));
  const mk = (s: StRow, text?: string): BSentence => ({ id: sid(), text: text ?? s.text, label: s.label, source_numbers: stmtSources(s.id, srcs), event_ids: [s.event_id] });
  const used = new Set<string>();
  const relRank = (id: string) => ({ high: 0, medium: 1, low: 2 }[(evBy.get(id)?.reliability as string) ?? 'low'] ?? 2);

  const strong = sts.filter((s) => SUMMARY_ALLOWED_LABELS.includes(s.label)).sort((a, b) => relRank(a.event_id) - relRank(b.event_id));
  for (const s of strong.slice(0, 3)) {
    c.summary.push(mk(s));
    used.add(s.id);
  }
  for (const r of c.regions) {
    const list = sts.filter((s) => evBy.get(s.event_id)?.region === r.region && !used.has(s.id) && !(s.label === 'unverified' || s.label === 'estimate'));
    for (const s of list.slice(0, 5)) {
      r.sentences.push(mk(s));
      used.add(s.id);
    }
  }
  for (const e of events) {
    const ct = e.change_type as string;
    if (ct === 'continuing') continue;
    const first = sts.find((s) => s.event_id === e.id);
    if (!first) continue;
    c.changes.push({ id: sid(), text: `[${CHANGE_TYPES[ct]}] ${e.title as string}`, label: first.label, source_numbers: stmtSources(first.id, srcs), event_ids: [e.id as string] });
  }
  for (const s of sts) {
    if (used.has(s.id)) continue;
    if (s.label === 'unverified' || s.label === 'estimate') c.watch.push(mk(s));
  }
  for (const e of events) {
    if (!e.content_conflict && !e.location_conflict) continue;
    const arts = srcs.filter((x) => (db().prepare('SELECT event_id FROM articles WHERE id=?').get(x.article_id) as { event_id: string } | undefined)?.event_id === e.id);
    if (!arts.length) continue;
    const why = [e.content_conflict ? '내용' : '', e.location_conflict ? '위치' : ''].filter(Boolean).join('·');
    c.watch.push({ id: sid(), text: `출처 간 ${why} 충돌: ${e.title as string} (${arts.map((a) => a.source_name).join(', ')})`, label: 'unverified', source_numbers: arts.map((a) => a.n), event_ids: [e.id as string] });
  }
  return c;
}

/** T4 결과를 서버에서 검증·정리. 라벨은 참조한 문장 중 가장 약한 라벨로 강제한다. */
function applyT4(out: ReturnType<typeof T4Schema.parse>, events: Record<string, unknown>[], sts: StRow[], srcs: BSource[]): BContent {
  const c = emptyContent();
  c.sources = srcs;
  const byId = new Map(sts.map((s) => [s.id, s]));
  const conv = (x: { text: string; statement_ids: string[] }): BSentence | null => {
    const refs = x.statement_ids.map((i) => byId.get(i)).filter(Boolean) as StRow[];
    if (!refs.length) return null;
    const label = refs.reduce((m, s) => (RANK[s.label] < RANK[m] ? s.label : m), refs[0].label);
    const nums = [...new Set(refs.flatMap((s) => stmtSources(s.id, srcs)))].sort((a, b) => a - b);
    if (!nums.length) return null;
    return { id: sid(), text: x.text, label, source_numbers: nums, event_ids: [...new Set(refs.map((s) => s.event_id))] };
  };
  c.summary = out.summary.map(conv).filter((x): x is BSentence => !!x && SUMMARY_ALLOWED_LABELS.includes(x.label)).slice(0, 3);
  for (const r of c.regions) {
    const got = out.regions.find((x) => x.region === r.region);
    r.sentences = (got?.sentences ?? []).map(conv).filter((x): x is BSentence => !!x).slice(0, 5);
  }
  c.watch = out.watch.map(conv).filter((x): x is BSentence => !!x);
  // 전일 대비 변화는 서버가 결정적으로 구성
  c.changes = ruleDraft(events, sts, srcs).changes;
  return c;
}

export async function generateDraft(eventIds: string[], opts: { actor?: string | null } = {}) {
  const events = reviewedEvents(eventIds);
  if (!events.length) throw new ValidationError('검토 완료된 사건이 없어 초안을 만들 수 없습니다');
  const ids = events.map((e) => e.id as string);
  const ph = ids.map(() => '?').join(',');
  const srcs = buildSources(ids);
  // 출처가 없는 문장은 초안에 넣지 않는다 (게시 검증에서 어차피 거부됨)
  const sts = (db().prepare(`SELECT id,event_id,text,label,fact_suggested,position FROM summary_statements WHERE event_id IN (${ph}) ORDER BY event_id, position`).all(...ids) as StRow[]).filter((s) => stmtSources(s.id, srcs).length > 0);
  let content: BContent;
  let note: string | null = null;
  let usedAi = false;
  try {
    const input = events.map((e) => ({
      사건: e.title,
      지역: e.region,
      신뢰도: e.reliability,
      변화: e.change_type,
      문장: sts.filter((s) => s.event_id === e.id).map((s) => ({ statement_id: s.id, 라벨: s.fact_suggested && s.label !== 'fact' ? 'unverified' : s.label, 문장: s.text })),
    }));
    const out = await aiJson(T4_SYSTEM, JSON.stringify(input), T4Schema);
    content = applyT4(out, events, sts, srcs);
    usedAi = true;
  } catch (e) {
    content = ruleDraft(events, sts, srcs);
    note = `AI 초안을 만들지 못해 승인된 문장으로 규칙 기반 초안을 만들었습니다 (${(e as Error).message.slice(0, 80)})`;
  }
  const row = saveDraftRow(content, ids);
  void opts;
  return { id: row, usedAi, note };
}

export function blankDraft(eventIds: string[]) {
  const events = reviewedEvents(eventIds);
  const ids = events.map((e) => e.id as string);
  const c = emptyContent();
  c.sources = buildSources(ids);
  return { id: saveDraftRow(c, ids) };
}

function saveDraftRow(content: BContent, eventIds: string[]): string {
  const d = db();
  const ex = d.prepare("SELECT id FROM briefings WHERE status='draft' ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
  const now = nowIso();
  if (ex) {
    d.prepare('UPDATE briefings SET content=?, event_ids=?, briefing_date=?, created_at=? WHERE id=?').run(JSON.stringify(content), JSON.stringify(eventIds), kstDate(), now, ex.id);
    return ex.id;
  }
  const id = uuid();
  d.prepare("INSERT INTO briefings (id,status,briefing_date,content,event_ids,created_at) VALUES (?,'draft',?,?,?,?)").run(id, kstDate(), JSON.stringify(content), JSON.stringify(eventIds), now);
  return id;
}

export interface Violation {
  sentence_id: string | null;
  reason: string;
}

/** FR-F3-13 게시 전 검증 + F2 규칙 재적용 */
export function validateBriefing(content: BContent, eventIds: string[]): Violation[] {
  const v: Violation[] = [];
  const reviewed = new Set((reviewedEvents(eventIds)).map((e) => e.id as string));
  for (const id of eventIds) if (!reviewed.has(id)) v.push({ sentence_id: null, reason: `검토 완료가 아닌 사건이 포함되어 있습니다 (${id.slice(0, 8)})` });
  const srcBy = new Map(content.sources.map((s) => [s.n, s]));
  const all: [string, BSentence][] = [
    ...content.summary.map((s) => ['summary', s] as [string, BSentence]),
    ...content.regions.flatMap((r) => r.sentences.map((s) => ['regions', s] as [string, BSentence])),
    ...content.changes.map((s) => ['changes', s] as [string, BSentence]),
    ...content.watch.map((s) => ['watch', s] as [string, BSentence]),
  ];
  for (const [sec, s] of all) {
    if (!s.text.trim()) v.push({ sentence_id: s.id, reason: '내용이 비어 있습니다' });
    const nums = s.source_numbers.filter((n) => srcBy.has(n));
    if (nums.length === 0) {
      v.push({ sentence_id: s.id, reason: '출처 없는 문장입니다' });
      continue;
    }
    for (const eid of s.event_ids) if (!reviewed.has(eid)) v.push({ sentence_id: s.id, reason: '검토 완료가 아닌 사건을 참조합니다' });
    if (sec === 'summary' && !SUMMARY_ALLOWED_LABELS.includes(s.label)) v.push({ sentence_id: s.id, reason: '종합에는 [사실]과 [당사자 주장]만 쓸 수 있습니다' });
    if (s.label === 'fact') {
      const arts = nums.map((n) => db().prepare('SELECT * FROM articles WHERE id=?').get(srcBy.get(n)!.article_id) as ArticleRow).filter(Boolean);
      const chk = checkFact(arts, true);
      if (!chk.ok) v.push({ sentence_id: s.id, reason: `[사실] 조건 미충족: ${chk.reason}` });
    }
  }
  return v;
}

export function publishBriefing(id: string, by: string | null) {
  const d = db();
  const b = d.prepare("SELECT * FROM briefings WHERE id=? AND status='draft'").get(id) as { content: string; event_ids: string } | undefined;
  if (!b) throw new ValidationError('초안을 찾을 수 없습니다');
  const content = JSON.parse(b.content) as BContent;
  const eventIds = JSON.parse(b.event_ids) as string[];
  const violations = validateBriefing(content, eventIds);
  if (violations.length) return { ok: false as const, violations };
  const now = nowIso();
  d.prepare("UPDATE briefings SET status='published', published_at=?, published_by=?, briefing_date=? WHERE id=?").run(now, by || null, kstDate(), id);
  return { ok: true as const, published_at: now };
}
