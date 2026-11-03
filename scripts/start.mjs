// npm run start:local / start:lan  →  빌드 후 서버 시작
import { loadEnv, portFree, runNext } from './launcher.mjs';

const mode = process.argv[2] === 'lan' ? 'lan' : 'local';
if (!loadEnv()) console.warn('[ARGUS-K] .env.local 이 없습니다. .env.example 을 복사해 만들면 AI 설정을 쓸 수 있습니다 (없어도 실행은 됩니다).');

const host = mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
const port = parseInt(process.env.PORT || '3000', 10);
process.env.HOST = host;
if (!process.env.DATABASE_URL && !process.env.PGLITE_DIR) process.env.PGLITE_DIR = './data/pglite';

if (mode === 'lan') {
  const pin = process.env.EDIT_PIN || '';
  if (pin.length < 6) {
    console.error('\n[ARGUS-K] 내부망 공유 모드는 EDIT_PIN(6자리 이상)이 필요합니다. .env.local 에 EDIT_PIN 을 설정하세요.\n');
    process.exit(1);
  }
}

if (!(await portFree(port, host))) {
  console.error(`\n[ARGUS-K] 포트 ${port}이 사용 중입니다. .env.local 의 PORT 를 바꾸세요.\n`);
  process.exit(1);
}

console.log(`\n[ARGUS-K] ${mode === 'lan' ? '내부망 공유 모드 — 같은 네트워크에서 접속 가능 (쓰기에 PIN 필요)' : '로컬 모드 — 이 PC에서만 접속 가능'}`);
console.log(`[ARGUS-K] DB: ${process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : 'PGlite 로컬 파일 ' + process.env.PGLITE_DIR}\n`);

if (!process.argv.includes('--no-build')) {
  console.log('[ARGUS-K] 빌드 중... (처음에는 1~2분 걸립니다)');
  const code = await runNext(['build']);
  if (code !== 0) process.exit(code);
}
console.log(`\n[ARGUS-K] 서버 시작: http://localhost:${port}\n`);
process.exit(await runNext(['start', '-H', host, '-p', String(port)]));
