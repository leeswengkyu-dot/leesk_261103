import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3', 'node-cron', 'rss-parser'],
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // 경로에 한글/OneDrive 가 있어도 '@/' 별칭이 확실히 동작하도록 webpack 별칭을 명시
  webpack(config) {
    config.resolve.alias['@'] = root;
    return config;
  },
};

export default nextConfig;
