import { db } from '@/lib/db';
import { write, body } from '@/lib/api';
import { saveStatement, ValidationError, recomputeEvent } from '@/lib/events';
import { nowIso } from '@/lib/time';

export const dynamic = 'force-dynamic';

interface In {
  op: 'create' | 'update' | 'delete' | 'approve';
  event_id?: string;
  id?: string;
  text?: string;
  label?: string;
  article_ids?: string[];
  actor?: string;
}

/** 요약 문장 CRUD. 라벨 규칙(F2)은 saveStatement 가 서버에서 강제한다. */
export const POST = write(async (req) => {
  const b = await body<In>(req);
  const d = db();
  if (b.op === 'delete') {
    if (!b.id) throw new ValidationError('id 가 필요합니다');
    const st = await d.prepare('SELECT event_id FROM summary_statements WHERE id=?').get<{ event_id: string }>(b.id);
    await d.prepare('DELETE FROM statement_sources WHERE statement_id=?').run(b.id);
    await d.prepare('DELETE FROM summary_statements WHERE id=?').run(b.id);
    if (st) await d.prepare('UPDATE events SET updated_at=? WHERE id=?').run(nowIso(), st.event_id);
    return { ok: true };
  }
  if (b.op === 'approve') {
    // [사실 제안] 승인: 사람이 [사실]로 저장 (조건 미충족이면 거부)
    const st = await d.prepare('SELECT * FROM summary_statements WHERE id=?').get<{ event_id: string; text: string }>(b.id);
    if (!st) throw new ValidationError('문장을 찾을 수 없습니다');
    const ids = (await d.prepare('SELECT article_id FROM statement_sources WHERE statement_id=?').all<{ article_id: string }>(b.id)).map((r) => r.article_id);
    const r = await saveStatement({ event_id: st.event_id, id: b.id, text: st.text, label: 'fact', article_ids: ids, origin: 'human', human: true, actor: b.actor });
    return { ok: true, ...r };
  }
  if (!b.event_id) throw new ValidationError('event_id 가 필요합니다');
  const r = await saveStatement({
    event_id: b.event_id,
    id: b.op === 'update' ? b.id : undefined,
    text: b.text ?? '',
    label: b.label ?? 'unverified',
    article_ids: b.article_ids ?? [],
    origin: 'human',
    human: true,
    actor: b.actor,
  });
  await recomputeEvent(b.event_id);
  return { ok: true, ...r };
});
