// npm run dev  →  개발용 DB(argus-dev.db)로 개발 서버 시작
import { loadEnv, portFree, runNext } from './launcher.mjs';

loadEnv();
process.env.HOST = '127.0.0.1';
process.env.DB_PATH = process.env.DEV_DB_PATH || './data/argus-dev.db';
const port = parseInt(process.env.PORT || '3000', 10);
if (!(await portFree(port, '127.0.0.1'))) {
  console.error(`\n[ARGUS-K] 포트 ${port}이 사용 중입니다. .env.local 의 PORT 를 바꾸세요.\n`);
  process.exit(1);
}
console.log(`[ARGUS-K] 개발 모드 (DB: ${process.env.DB_PATH}). 시드 데이터는 npm run seed:dev 로 넣습니다.`);
process.exit(await runNext(['dev', '-H', '127.0.0.1', '-p', String(port)]));
