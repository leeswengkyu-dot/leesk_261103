import { z } from 'zod';
import { db } from './db';
import { aiJson, aiStatus } from './ai/provider';

/**
 * 기사 제목 한글 번역 (원문은 그대로 두고 title_ko 에 따로 저장).
 * TRANSLATE_PROVIDER: auto(기본: Claude 가능하면 Claude, 아니면 무료 웹 번역) | claude | google | off
 */
const g = globalThis as unknown as { __argusTranslating?: boolean };

const hasHangul = (s: string) => /[가-힣]/.test(s);
const provider = () => (process.env.TRANSLATE_PROVIDER || 'auto').toLowerCase();

const SYSTEM = `기사 제목을 자연스러운 한국어로 번역합니다. 제목에 없는 내용을 덧붙이거나 해석하지 말고, 고유명사는 통용되는 한국어 표기로 옮기십시오.
입력은 제목 문자열의 JSON 배열입니다. 같은 개수·같은 순서로 {"translations":[...]} JSON 객체 하나만 출력하십시오.`;

async function viaClaude(titles: string[]): Promise<string[]> {
  const out = await aiJson(SYSTEM, JSON.stringify(titles), z.object({ translations: z.array(z.string()) }));
  if (out.translations.length !== titles.length) throw new Error('번역 개수가 맞지 않습니다');
  return out.translations;
}

async function googleOne(t: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t&q=${encodeURIComponent(t)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 ARGUS-K' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as [string, string][][];
    return (data[0] ?? []).map((p) => p[0]).join('').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function viaGoogle(titles: string[]): Promise<string[]> {
  const out: string[] = new Array(titles.length).fill('');
  let i = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (i < titles.length) {
        const k = i++;
        try {
          out[k] = await googleOne(titles[k]);
        } catch {
          out[k] = '';
        }
      }
    }),
  );
  return out;
}

async function translateBatch(titles: string[]): Promise<string[]> {
  const p = provider();
  if (p === 'off') return titles.map(() => '');
  if ((p === 'auto' || p === 'claude') && (await aiStatus()).available) {
    try {
      return await viaClaude(titles);
    } catch (e) {
      if (p === 'claude') throw e;
    }
  }
  if (p === 'claude') return titles.map(() => '');
  return viaGoogle(titles);
}

export interface TranslateResult {
  translated: number;
  failed: number;
  left: number;
}

/** 번역이 없는 기사 제목을 번역해 저장한다. 한글 제목은 번역 없이 건너뛴다. */
export async function translatePending(limit = 150): Promise<TranslateResult> {
  const res: TranslateResult = { translated: 0, failed: 0, left: 0 };
  if (g.__argusTranslating) return res;
  g.__argusTranslating = true;
  try {
    const d = db();
    // 한글 제목은 번역 대상이 아님: 원문을 그대로 두어 다시 검사하지 않게 한다
    const all = await d.prepare('SELECT id, title, event_id FROM articles WHERE title_ko IS NULL ORDER BY published_at DESC').all<{ id: string; title: string; event_id: string | null }>();
    const setKo = d.prepare('UPDATE articles SET title_ko=? WHERE id=?');
    const todo: typeof all = [];
    for (const r of all) {
      if (hasHangul(r.title)) await setKo.run(r.title, r.id);
      else todo.push(r);
    }
    res.left = Math.max(0, todo.length - limit);
    const work = todo.slice(0, limit);
    const setEv = d.prepare('UPDATE events SET title_ko=? WHERE id=? AND title=?');
    for (let i = 0; i < work.length; i += 30) {
      const batch = work.slice(i, i + 30);
      let tr: string[];
      try {
        tr = await translateBatch(batch.map((b) => b.title));
      } catch {
        res.failed += batch.length;
        continue;
      }
      for (let k = 0; k < batch.length; k++) {
        const b = batch[k];
        const t = (tr[k] ?? '').trim();
        if (!t) {
          res.failed++;
          continue;
        }
        await setKo.run(t, b.id);
        if (b.event_id) await setEv.run(t, b.event_id, b.title);
        res.translated++;
      }
    }
  } finally {
    g.__argusTranslating = false;
  }
  return res;
}
