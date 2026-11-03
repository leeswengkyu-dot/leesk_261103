import Parser from 'rss-parser';
import { db, inTx, uuid } from './db';
import { nowIso, parseTime } from './time';
import { processPendingArticles } from './ingest';
import { translatePending } from './translate';
import { judgePendingDuplicates } from './dupjudge';

/** 수집 한 번의 최대 시간(ms). 서버리스 함수 제한 안에서 끝내기 위해 기사 처리를 이 안에서 멈춘다 */
const BUDGET_MS = 200_000;
/** 이 시간보다 오래 'running' 이면 중단된 것으로 본다 */
const STALE_MS = 6 * 60_000;

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
      `INSERT INTO articles (id,feed_id,source_name,source_grade,is_party_claim,url,title,description,published_at,ai_status,fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT (url) DO NOTHING`,
    );
    let added = 0;
    await inTx(async () => {
      for (const it of feed.items ?? []) {
        if (!it.link || !it.title) continue;
        const pub = parseTime(it.isoDate || it.pubDate || null);
        if (!pub || new Date(pub).getTime() < cutoff) continue;
        const desc = stripHtml(it.contentSnippet || it.content || (it as { description?: string }).description || '').slice(0, 1000); // FR-F1-05: 본문 아님, 설명만
        const r = await ins.run(uuid(), f.id, f.name, f.grade, f.is_party_source, normalizeUrl(it.link), stripHtml(it.title), desc || null, pub, nowIso());
        added += r.changes;
      }
    });
    return { feed_id: f.id, name: f.name, ok: true, new: added };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const isFormat = /Non-whitespace|Unexpected close|Invalid character|Feed not recognized|Attribute without value/i.test(msg);
    return { feed_id: f.id, name: f.name, ok: false, new: 0, error: isFormat ? `형식 오류: ${msg.slice(0, 120)}` : msg.slice(0, 160) };
  }
}

/** 진행 중인 수집이 있는가. 서버리스에서는 인스턴스가 여러 개라 메모리 대신 DB 로 확인한다 */
export async function isCollecting(): Promise<boolean> {
  const since = new Date(Date.now() - STALE_MS).toISOString();
  const r = await db().prepare("SELECT COUNT(*) c FROM collection_runs WHERE status='running' AND started_at>?").get<{ c: number }>(since);
  return (r?.c ?? 0) > 0;
}

/** 마지막으로 끝난(또는 시작한) 수집의 시작 시각 */
export async function lastRunAt(): Promise<string | null> {
  const r = await db().prepare('SELECT started_at FROM collection_runs ORDER BY started_at DESC LIMIT 1').get<{ started_at: string }>();
  return r?.started_at ?? null;
}

/** 수집 파이프라인 (15.3). 동시 실행은 거부한다 (FR-F1-04). */
export async function runCollection(trigger: 'cron' | 'catchup' | 'manual' | 'live') {
  const d = db();
  // 중단된 기록 정리 후 동시 실행 확인
  await d
    .prepare("UPDATE collection_runs SET status='failed', finished_at=?, results=? WHERE status='running' AND started_at<=?")
    .run(nowIso(), JSON.stringify({ feeds: [], ai_note: '중단됨 (시간 초과 또는 서버 종료)', events: 0 }), new Date(Date.now() - STALE_MS).toISOString());
  const runId = uuid();
  // 진행 중인 수집이 없을 때만 한 번에 등록한다 (동시 요청이 겹쳐도 하나만 통과)
  const claimed = await d
    .prepare(
      `INSERT INTO collection_runs (id,trigger,started_at,status)
       SELECT ?,?,?,'running' WHERE NOT EXISTS (SELECT 1 FROM collection_runs WHERE status='running' AND started_at>?)`,
    )
    .run(runId, trigger, nowIso(), new Date(Date.now() - STALE_MS).toISOString());
  if (!claimed.changes) throw new CollectBusy();
  const deadline = Date.now() + BUDGET_MS;
  let results: FeedResult[] = [];
  let aiNote: string | null = null;
  let events = 0;
  let status: 'success' | 'partial' | 'failed' = 'success';
  try {
    const feeds = await d.prepare('SELECT id,name,region,grade,is_party_source,url FROM feeds WHERE active=1').all<FeedRow>();
    results = await Promise.all(feeds.map((f) => collectFeed(f)));
    const ok = results.filter((r) => r.ok).length;
    status = feeds.length === 0 || ok === 0 ? 'failed' : ok < results.length ? 'partial' : 'success';
    const pr = await processPendingArticles(deadline);
    events = pr.events;
    try {
      if (Date.now() < deadline) await translatePending();
    } catch (e) {
      console.error('[translate] 번역 실패:', (e as Error).message);
    }
    aiNote = pr.aiNote;
    // 중복 후보 AI 1차 판단 (아직 판단 안 한 후보를 몇 건씩)
    try {
      if (Date.now() < deadline) {
        const dj = await judgePendingDuplicates(deadline);
        if (dj.note && !aiNote) aiNote = dj.note;
      }
    } catch (e) {
      console.error('[dupjudge] 중복 판단 실패:', (e as Error).message);
    }
    if (pr.pendingLeft) aiNote = `${aiNote ?? ''} (처리 대기 ${pr.pendingLeft}건 — 다음 수집에서 이어서 처리)`.trim();
  } catch (e) {
    status = 'failed';
    aiNote = `수집 오류: ${(e as Error).message}`;
  } finally {
    const total = results.reduce((s, r) => s + r.new, 0);
    await d.prepare('UPDATE collection_runs SET finished_at=?, status=?, results=?, new_articles=? WHERE id=?').run(
      nowIso(), status, JSON.stringify({ feeds: results, ai_note: aiNote, events }), total, runId,
    );
  }
  return { runId, status, results, new_articles: results.reduce((s, r) => s + r.new, 0), events, aiNote };
}