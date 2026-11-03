import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import { db, getSetting } from '../db';
import { kstDate } from '../time';

/**
 * AI 제공자: Gemini(Google) 또는 Claude(Anthropic).
 * AI_PROVIDER=gemini | anthropic 로 지정하거나, 비워 두면 키가 있는 쪽을 자동 선택(GEMINI_API_KEY 우선).
 */
export type AiProvider = 'gemini' | 'anthropic';

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
  provider: AiProvider;
  model: string | null;
}

const GEMINI_DEFAULT_MODEL = 'gemini-3.6-flash';
const GEMINI_DEFAULT_FALLBACK = 'gemini-3.5-flash-lite';

const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

export function aiProvider(): AiProvider {
  const p = (process.env.AI_PROVIDER || '').toLowerCase();
  if (p === 'gemini' || p === 'google') return 'gemini';
  if (p === 'anthropic' || p === 'claude') return 'anthropic';
  if (geminiKey()) return 'gemini';
  return 'anthropic';
}

function aiKey(p: AiProvider) {
  return p === 'gemini' ? geminiKey() : process.env.ANTHROPIC_API_KEY || '';
}

function aiModel(p: AiProvider): string | null {
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  return p === 'gemini' ? GEMINI_DEFAULT_MODEL : null;
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
  const provider = aiProvider();
  const hasKey = !!aiKey(provider);
  const model = aiModel(provider);
  const used = await aiUsedToday();
  const limit = dailyLimit();
  let reason: string | null = null;
  let code: string | null = null;
  if (!hasKey) {
    reason = 'AI API 키가 설정되지 않았습니다(GEMINI_API_KEY 또는 ANTHROPIC_API_KEY)';
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
  return { available: !reason, reason, code, mode, used, limit, hasKey, provider, model };
}

function extractJson(text: string): unknown {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('JSON 객체를 찾지 못했습니다');
  return JSON.parse(text.slice(s, e + 1));
}

/* ───────────── Claude ───────────── */

let client: Anthropic | null = null;

async function callAnthropic(model: string, system: string, user: string): Promise<string> {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 0 });
  const res = await client.messages.create({
    model,
    max_tokens: 3000,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/* ───────────── Gemini (REST, SDK 없이 fetch) ───────────── */

class GeminiHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 과부하(503)·한도(429)·일시 오류(500) 는 예비 모델로 넘긴다 */
const isTransient = (e: unknown) => e instanceof GeminiHttpError && [429, 500, 503].includes(e.status);

async function callGeminiOnce(model: string, system: string, user: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (!res.ok) throw new GeminiHttpError(res.status, `Gemini ${res.status}: ${data.error?.message ?? res.statusText}`);
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) {
    const why = data.promptFeedback?.blockReason || cand?.finishReason || '빈 응답';
    throw new Error(`Gemini 응답 없음(${why})`);
  }
  return text;
}

async function callGemini(model: string, system: string, user: string): Promise<string> {
  try {
    return await callGeminiOnce(model, system, user);
  } catch (e) {
    const fallback = process.env.AI_FALLBACK_MODEL ?? GEMINI_DEFAULT_FALLBACK;
    if (!isTransient(e) || !fallback || fallback === model) throw e;
    return callGeminiOnce(fallback, system, user);
  }
}

/** AI 호출 → JSON → zod 검증. 실패하면 1회 재시도. 호출 때마다 사용량을 센다. */
export async function aiJson<T>(system: string, user: string, schema: ZodType<T>): Promise<T> {
  const st = await aiStatus();
  if (!st.available) throw new AiUnavailable((st.code as 'no_key') ?? 'no_key', st.reason ?? 'AI 사용 불가');
  const model = st.model as string;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await aiUsedToday()) >= dailyLimit()) throw new AiUnavailable('limit', '오늘 AI 호출 한도에 도달했습니다');
    await bumpUsage();
    try {
      const text = st.provider === 'gemini' ? await callGemini(model, system, user) : await callAnthropic(model, system, user);
      return schema.parse(extractJson(text));
    } catch (e) {
      lastErr = e;
      if (e instanceof GeminiHttpError && e.status === 429) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
