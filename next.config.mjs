import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg', 'rss-parser', '@electric-sql/pglite'],
  // 마이그레이션 SQL 과 출처 시드는 런타임에 fs 로 읽으므로 서버리스 번들에 명시적으로 포함
  outputFileTracingIncludes: { '/api/**/*': ['./db/migrations/**/*', './data/feeds.seed.json'] },
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // 경로에 한글/OneDrive 가 있어도 '@/' 별칭이 확실히 동작하도록 webpack 별칭을 명시
  webpack(config) {
    config.resolve.alias['@'] = root;
    return config;
  },
};

export default nextConfig;
