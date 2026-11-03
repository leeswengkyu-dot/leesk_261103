// npm run dev  →  개발용 로컬 DB(PGlite)로 개발 서버 시작
import { loadEnv, portFree, runNext } from './launcher.mjs';

loadEnv();
process.env.HOST = '127.0.0.1';
// 개발 모드는 운영 DB(Supabase)를 건드리지 않도록 기본적으로 로컬 PGlite 를 쓴다. 개발용 Postgres 가 있으면 DEV_DATABASE_URL 로 지정
if (process.env.DEV_DATABASE_URL) process.env.DATABASE_URL = process.env.DEV_DATABASE_URL;
else delete process.env.DATABASE_URL;
process.env.PGLITE_DIR = process.env.DEV_PGLITE_DIR || './data/pglite-dev';
const port = parseInt(process.env.PORT || '3000', 10);
if (!(await portFree(port, '127.0.0.1'))) {
  console.error(`\n[ARGUS-K] 포트 ${port}이 사용 중입니다. .env.local 의 PORT 를 바꾸세요.\n`);
  process.exit(1);
}
console.log(`[ARGUS-K] 개발 모드 (DB: ${process.env.DATABASE_URL ? 'DEV_DATABASE_URL' : process.env.PGLITE_DIR}). 시드 데이터는 npm run seed:dev 로 넣습니다.`);
process.exit(await runNext(['dev', '-H', '127.0.0.1', '-p', String(port)]));
