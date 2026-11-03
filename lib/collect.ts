import Parser from 'rss-parser';
import { db, uuid } from './db';
import { nowIso, parseTime } from './time';
import { backupIfFirstOfDay } from './backup';
import { processPendingArticles } from './ingest';
import { translatePending } from './translate';

const g = globalThis as unknown as { __argusCollecting?: boolean };

export interface FeedResult {
  feed_id: string;
  name: string;
  ok: boolean;
  new: number;
  error?: string;
}

export class CollectBusy extends Error {
  status = 409;
  constructor() {
    super('수집이 이미 진행 중입니다');
  }
}

/** FR-F1-06: utm_* 제거, 해시 제거, 호스트 소문자화 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    [...u.searchParams.keys()].filter((k) => /^utm_/i.test(k)).forEach((k) => u.searchParams.delete(k));
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`시간 초과 (${ms / 1000}초)`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

interface FeedRow {
  id: string;
  name: string;
  region: string;
  grade: string;
  is_party_source: number;
  url: string;
}

async function collectFeed(f: FeedRow): Promise<FeedResult> {
  const parser = new Parser();
  try {
    // fetch 로 직접 받고(15초 제한) rss-parser 는 문자열 파싱만 사용한다
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    let xml: string;
    try {
      const res = await fetch(f.url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ARGUS-K/1.1; public-info analysis tool)', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xml = await res.text();
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error('시간 초과 (15초)');
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const feed = await withTimeout(parser.parseString(xml.replace(/^[﻿\s]+/, '')), 15000);
    const cutoff = Date.now() - 48 * 3600_000; // FR-F1-07
    const d = db();
    const ins = d.prepare(
      `INSERT OR IGNORE INTO articles (id,feed_id,source_name,source_grade,is_party_claim,url,title,description,published_at,ai_status,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
    );
    let added = 0;
    d.transaction(() => {
      for (const it of feed.items ?? []) {
        if (!it.link || !it.title) continue;
        const pub = parseTime(it.isoDate || it.pubDate || null);
        if (!pub || new Date(pub).getTime() < cutoff) continue;
        const desc = stripHtml(it.contentSnippet || it.content || (it as { description?: string }).description || '').slice(0, 1000); // FR-F1-05: 본문 아님, 설명만
        const r = ins.run(uuid(), f.id, f.name, f.grade, f.is_party_source, normalizeUrl(it.link), stripHtml(it.title), desc || null, pub, nowIso());
        added += r.changes;
      }
    })();
    return { feed_id: f.id, name: f.name, ok: true, new: added };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const isFormat = /Non-whitespace|Unexpected close|Invalid character|Feed not recognized|Attribute without value/i.test(msg);
    return { feed_id: f.id, name: f.name, ok: false, new: 0, error: isFormat ? `형식 오류: ${msg.slice(0, 120)}` : msg.slice(0, 160) };
  }
}

export function isCollecting(): boolean {
  return !!g.__argusCollecting;
}

/** 수집 파이프라인 (15.3). 동시 실행은 거부한다 (FR-F1-04). */
export async function runCollection(trigger: 'cron' | 'catchup' | 'manual' | 'live') {
  if (g.__argusCollecting) throw new CollectBusy();
  g.__argusCollecting = true;
  const d = db();
  const runId = uuid();
  d.prepare("INSERT INTO collection_runs (id,trigger,started_at,status) VALUES (?,?,?,'running')").run(runId, trigger, nowIso());
  const results: FeedResult[] = [];
  let aiNote: string | null = null;
  let events = 0;
  let status: 'success' | 'partial' | 'failed' = 'success';
  try {
    try {
      await backupIfFirstOfDay();
    } catch (e) {
      console.error('[backup] 백업 실패:', (e as Error).message);
    }
    const feeds = d.prepare('SELECT id,name,region,grade,is_party_source,url FROM feeds WHERE active=1').all() as FeedRow[];
    for (const f of feeds) results.push(await collectFeed(f));
    const ok = results.filter((r) => r.ok).length;
    status = feeds.length === 0 || ok === 0 ? 'failed' : ok < results.length ? 'partial' : 'success';
    const pr = await processPendingArticles();
    events = pr.events;
    try {
      await translatePending();
    } catch (e) {
      console.error('[translate] 번역 실패:', (e as Error).message);
    }
    aiNote = pr.aiNote;
    if (pr.pendingLeft) aiNote = `${aiNote ?? ''} (AI 처리 대기 ${pr.pendingLeft}건)`.trim();
  } catch (e) {
    status = 'failed';
    aiNote = `수집 오류: ${(e as Error).message}`;
  } finally {
    const total = results.reduce((s, r) => s + r.new, 0);
    d.prepare('UPDATE collection_runs SET finished_at=?, status=?, results=?, new_articles=? WHERE id=?').run(
      nowIso(), status, JSON.stringify({ feeds: results, ai_note: aiNote, events }), total, runId,
    );
    g.__argusCollecting = false;
  }
  return { runId, status, results, new_articles: results.reduce((s, r) => s + r.new, 0), events, aiNote };
}
