import { write } from '@/lib/api';
import { runCollection } from '@/lib/collect';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 지금 수집. 진행 중이면 409 (FR-F1-04). 완료까지 기다렸다가 결과를 돌려준다. */
export const POST = write(async () => {
  const r = await runCollection('manual');
  return r;
});
