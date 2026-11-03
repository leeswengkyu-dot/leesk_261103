import { write } from '@/lib/api';
import { translatePending } from '@/lib/translate';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** 번역 안 된 기사 제목을 지금 번역 */
export const POST = write(async () => translatePending(300));
