import { write } from '@/lib/api';
import { backupNow, storageInfo } from '@/lib/backup';

export const dynamic = 'force-dynamic';

export const POST = write(async () => {
  try {
    const file = await backupNow();
    return { ok: true, file, storage: storageInfo() };
  } catch (e) {
    return Response.json({ error: `백업하지 못했습니다: ${(e as Error).message}` }, { status: 500 });
  }
});
