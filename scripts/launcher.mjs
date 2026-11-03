// 공통: .env.local 읽기, 포트 확인, next 실행
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

export function loadEnv() {
  const file = path.join(root, '.env.local');
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
  }
  return true;
}

export function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

export function runNext(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [nextBin, ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('exit', (code) => resolve(code ?? 0));
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => p.kill(sig));
  });
}
