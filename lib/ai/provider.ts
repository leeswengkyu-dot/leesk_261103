import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import { db, getSetting } from '../db';
import { kstDate } from '../time';

export class AiUnavailable extends Error {
  constructor(public code: 'no_key' | 'no_model' | 'mode_off' | 'limit', message: string) {
    super(message);
  }
}

export interface AiStatus {
  available: boolean;
  reason: string | null;
  code: string | null;
  mode: 'api' | 'pre';
  used: number;
  limit: number;
  hasKey: boolean;
  model: string | null;
}

const dailyLimit = () => parseInt(process.env.AI_DAILY_LIMIT || '300', 10);
export const batchLimit = () => parseInt(process.env.AI_BATCH_LIMIT || '100', 10);

export async function aiUsedToday(): Promise<number> {
  const r = await db().prepare('SELECT call_count c FROM ai_usage WHERE usage_date=?').get<{ c: number }>(kstDate());
  return r?.c ?? 0;
}

async function bumpUsage() {
  await db()
    .prepare('INSERT INTO ai_usage (usage_date, call_count) VALUES (?,1) ON CONFLICT(usage_date) DO UPDATE SET call_count=ai_usage.call_count+1')
    .run(kstDate());
}

export async function aiStatus(): Promise<AiStatus> {
  const mode = (await getSetting('ai_mode', 'api')) === 'pre' ? 'pre' : 'api';
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  const model = process.env.AI_MODEL || null;
  const used = await aiUsedToday();
  const limit = dailyLimit();
  let reason: string | null = null;
  let code: string | null = null;
  if (!hasKey) {
    reason = 'AI API 키가 설정되지 않았습니다(.env.local)';
    code = 'no_key';
  } else if (!model) {
    reason = 'AI_MODEL 이 설정되지 않았습니다(.env.local)';
    code = 'no_model';
  } else if (mode === 'pre') {
    reason = '요약 방식이 "사전 생성만"으로 설정되어 있습니다';
    code = 'mode_off';
  } else if (used >= limit) {
    reason = '오늘 AI 호출 한도에 도달했습니다';
    code = 'limit';
  }
  return { available: !reason, reason, code, mode, used, limit, hasKey, model };
}

function extractJson(text: string): unknown {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('JSON 객체를 찾지 못했습니다');
  return JSON.parse(text.slice(s, e + 1));
}

let client: Anthropic | null = null;

/** AI 호출 → JSON → zod 검증. 실패하면 1회 재시도. 호출 때마다 사용량을 센다. */
export async function aiJson<T>(system: string, user: string, schema: ZodType<T>): Promise<T> {
  const st = await aiStatus();
  if (!st.available) throw new AiUnavailable((st.code as 'no_key') ?? 'no_key', st.reason ?? 'AI 사용 불가');
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 0 });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await aiUsedToday()) >= dailyLimit()) throw new AiUnavailable('limit', '오늘 AI 호출 한도에 도달했습니다');
    await bumpUsage();
    try {
      const res = await client.messages.create({
        model: process.env.AI_MODEL as string,
        max_tokens: 3000,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return schema.parse(extractJson(text));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
