import { db } from '@/lib/db';
import { read, write, body } from '@/lib/api';
import { blankDraft, generateDraft, publishBriefing, validateBriefing, type BContent } from '@/lib/briefing';
import { listEventRows, ValidationError } from '@/lib/events';
import { nowIso } from '@/lib/time';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  status: string;
  briefing_date: string;
  content: string;
  event_ids: string;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
}

async function shape(r: Row | undefined) {
  if (!r) return null;
  const ids = JSON.parse(r.event_ids) as string[];
  const set = new Set(ids);
  return {
    id: r.id,
    status: r.status,
    briefing_date: r.briefing_date,
    published_at: r.published_at,
    published_by: r.published_by,
    event_ids: ids,
    content: JSON.parse(r.content) as BContent,
    events: (await listEventRows()).filter((e) => set.has(e.id)),
  };
}

/**
 * GET ?view=published(기본) → 최신 게시본 (보기 화면)
 * GET ?view=draft → 편집 중 초안 + 검토 완료 사건 후보
 * GET ?id=... → 특정 게시본
 */
export const GET = read(async (req) => {
  const url = new URL(req.url);
  const view = url.searchParams.get('view') ?? 'published';
  const d = db();
  const history = await d.prepare("SELECT id, briefing_date, published_at FROM briefings WHERE status='published' ORDER BY published_at DESC LIMIT 60").all();
  if (view === 'draft') {
    const draft = await d.prepare("SELECT * FROM briefings WHERE status='draft' ORDER BY created_at DESC LIMIT 1").get<Row>();
    const reviewed = (await listEventRows()).filter((e) => e.review_status === 'reviewed');
    return { draft: await shape(draft), reviewed_events: reviewed, history };
  }
  const id = url.searchParams.get('id');
  const row = id
    ? await d.prepare("SELECT * FROM briefings WHERE id=? AND status='published'").get<Row>(id)
    : await d.prepare("SELECT * FROM briefings WHERE status='published' ORDER BY published_at DESC LIMIT 1").get<Row>();
  return { briefing: await shape(row), history };
});

interface In {
  op: 'generate' | 'blank' | 'save' | 'publish' | 'discard';
  event_ids?: string[];
  id?: string;
  content?: BContent;
  published_by?: string;
}

export const POST = write(async (req) => {
  const b = await body<In>(req);
  const d = db();
  switch (b.op) {
    case 'generate': {
      const r = await generateDraft(b.event_ids ?? []);
      return { ok: true, ...r };
    }
    case 'blank':
      return { ok: true, ...(await blankDraft(b.event_ids ?? [])) };
    case 'save': {
      if (!b.id || !b.content) throw new ValidationError('저장할 내용이 없습니다');
      const row = await d.prepare("SELECT event_ids FROM briefings WHERE id=? AND status='draft'").get<{ event_ids: string }>(b.id);
      if (!row) throw new ValidationError('초안을 찾을 수 없습니다');
      await d.prepare('UPDATE briefings SET content=?, created_at=? WHERE id=?').run(JSON.stringify(b.content), nowIso(), b.id);
      return { ok: true, violations: await validateBriefing(b.content, JSON.parse(row.event_ids)) };
    }
    case 'publish': {
      if (!b.id) throw new ValidationError('초안이 없습니다');
      if (b.content) await d.prepare("UPDATE briefings SET content=? WHERE id=? AND status='draft'").run(JSON.stringify(b.content), b.id);
      const r = await publishBriefing(b.id, b.published_by ?? null);
      if (!r.ok) return Response.json({ error: '게시 전 검증에 실패했습니다. 강조된 문장을 수정하세요', violations: r.violations }, { status: 422 });
      return r;
    }
    case 'discard':
      await d.prepare("DELETE FROM briefings WHERE status='draft'").run();
      return { ok: true };
    default:
      throw new ValidationError('알 수 없는 동작입니다');
  }
});
