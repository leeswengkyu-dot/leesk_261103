export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { db } = await import('./lib/db');
    db(); // 마이그레이션·출처 시드 적용 (DB 파일이 없으면 새로 만든다)
    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
  }
}
