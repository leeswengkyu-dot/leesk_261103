import { db } from '@/lib/db';
import { write, body } from '@/lib/api';
import { mergeEvents, ValidationError } from '@/lib/events';

export const dynamic = 'force-dynamic';

/** 중복 후보 확정/기각. 자동 병합은 없다 (FR-F1-17, 18) */
export const POST = write(async (req) => {
  const b = await body<{ op: 'confirm' | 'dismiss'; candidate_id: string; representative_id?: string }>(req);
  const d = db();
  const c = await d.prepare('SELECT * FROM duplicate_candidates WHERE id=?').get<{ event_a: string; event_b: string; status: string }>(b.candidate_id);
  if (!c) throw new ValidationError('중복 후보를 찾을 수 없습니다');
  if (b.op === 'dismiss') {
    await d.prepare("UPDATE duplicate_candidates SET status='dismissed' WHERE id=?").run(b.candidate_id);
    return { ok: true };
  }
  const rep = b.representative_id && [c.event_a, c.event_b].includes(b.representative_id) ? b.representative_id : c.event_a;
  await mergeEvents(rep, rep === c.event_a ? c.event_b : c.event_a, b.candidate_id);
  return { ok: true, representative_id: rep };
});
