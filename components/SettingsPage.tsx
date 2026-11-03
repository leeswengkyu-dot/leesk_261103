'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { fmtKst } from '@/lib/time';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function SettingsPage() {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [csv, setCsv] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setS(await api('/api/settings'));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!s?.collecting) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [s?.collecting, load]);

  const run = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      load();
    }
  };

  const collect = () =>
    run('collect', async () => {
      const r = await api<any>('/api/collect', { method: 'POST' });
      setMsg(`수집 완료: 신규 기사 ${r.new_articles}건, 새 사건 ${r.events}건 (${r.status})${r.aiNote ? ` — ${r.aiNote}` : ''}`);
    });

  const upload = () =>
    run('csv', async () => {
      const f = fileRef.current?.files?.[0];
      if (!f) throw new Error('CSV 파일을 선택하세요');
      const fd = new FormData();
      fd.append('file', f);
      setCsv(await api('/api/upload-csv', { method: 'POST', body: fd, form: true }));
    });

  if (!s) return <div className="p-6 text-gray-500">{err ?? '불러오는 중...'}</div>;
  const nextRun = '매일 07:00 KST (Vercel Cron, 최대 1시간 이내 지연 가능)';
  const last = s.runs[0];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4">
      {err && <div className="rounded bg-red-50 p-3 text-red-800">{err}</div>}
      {msg && <div className="rounded bg-green-50 p-3 text-green-800">{msg}</div>}

      <section className="card p-4">
        <h2 className="mb-2 text-lg font-bold">1. 수집 실행</h2>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={!!busy || s.collecting} onClick={collect}>{busy === 'collect' || s.collecting ? '수집 중... (최대 몇 분)' : '지금 수집'}</button>
          <span className="text-sm text-gray-700">다음 예약: {nextRun}</span>
          <span className="text-sm text-gray-700">마지막 실행: {last ? `${fmtKst(last.started_at)} · ${last.status} · 신규 ${last.new_articles}건` : '없음'}</span>
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.live.on} onChange={(e) => run('live', () => api('/api/settings', { method: 'PATCH', body: { live: e.target.checked } }))} />
          실시간 자동 수집 — 상황판 화면이 열려 있는 동안 {s.live.interval_min > 0 ? `${s.live.interval_min}분마다` : '(LIVE_INTERVAL_MIN=0 으로 꺼져 있음)'} 자동 수집
        </label>
        <div className="mt-2 flex items-center gap-2">
          <button className="btn btn-sm" disabled={!!busy} onClick={() => run('tr', async () => { const r = await api<any>('/api/translate', { method: 'POST' }); setMsg(`제목 번역: ${r.translated}건 완료, 실패 ${r.failed}건, 남음 ${r.left}건`); })}>{busy === 'tr' ? '번역 중...' : '기사 제목 번역 지금 실행'}</button>
          <span className="text-xs text-gray-500">수집 때마다 자동 번역됩니다. 번역은 AI API(Gemini/Claude, 키가 있을 때) 또는 무료 웹 번역을 사용합니다.</span>
        </div>
        <p className="mt-2 text-xs text-gray-500">수집이 진행 중이면 새 요청은 거부됩니다. 원문 본문은 가져오지 않고 제목·설명·링크만 저장합니다.</p>
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-lg font-bold">2. 수집 기록 (최근 14회)</h2>
        {s.runs.length === 0 ? (
          <div className="text-gray-500">아직 수집을 실행하지 않았습니다</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs"><tr><th className="p-1">시각(KST)</th><th>방식</th><th>상태</th><th>신규 기사</th><th>새 사건</th><th>출처별 결과</th></tr></thead>
              <tbody>
                {s.runs.map((r: any) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="p-1 whitespace-nowrap">{fmtKst(r.started_at)}</td>
                    <td>{{ cron: '예약', catchup: '놓친 수집', manual: '수동', live: '실시간' }[r.trigger as string]}</td>
                    <td className={r.status === 'failed' ? 'font-semibold text-red-700' : r.status === 'partial' ? 'text-amber-700' : ''}>{{ running: '실행 중', success: '성공', partial: '일부 실패', failed: '실패' }[r.status as string]}</td>
                    <td>{r.new_articles}</td>
                    <td>{r.events}</td>
                    <td className="text-xs">
                      {r.feeds.map((f: any) => (
                        <div key={f.feed_id} className={f.ok ? '' : 'text-red-700'}>{f.ok ? '✓' : '✗'} {f.name}: {f.ok ? `신규 ${f.new}` : f.error}</div>
                      ))}
                      {r.ai_note && <div className="text-gray-600">AI: {r.ai_note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-lg font-bold">3. 수집 출처</h2>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs"><tr><th className="p-1">이름</th><th>지역</th><th>등급</th><th>당사자</th><th>주소</th><th>활성</th></tr></thead>
          <tbody>
            {s.feeds.map((f: any) => (
              <tr key={f.id} className="border-t">
                <td className="p-1">{f.name}</td>
                <td>{{ nk: '북한', me: '이란·중동', ru_ua: '러우전쟁', global: '공통' }[f.region as string]}</td>
                <td>{f.grade}</td>
                <td>{f.is_party_source ? '예' : '-'}</td>
                <td className="max-w-xs truncate text-xs" title={f.url}>{f.url}</td>
                <td><input type="checkbox" checked={!!f.active} onChange={(e) => run('feed', () => api('/api/settings', { method: 'PATCH', body: { feed_id: f.id, active: e.target.checked } }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-gray-500">출처 추가·편집은 data/feeds.seed.json 을 고친 뒤 DB 를 새로 만들 때 반영됩니다 (MVP는 활성 토글만 지원).</p>
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-lg font-bold">4. CSV 업로드</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" />
          <button className="btn" disabled={!!busy} onClick={upload}>업로드</button>
        </div>
        <p className="mt-1 text-xs text-gray-500">UTF-8, 첫 행 헤더. 필수: event_key, title, region, occurred_at, event_type, source_name, source_grade, url, published_at. 선택: country, location_name, lat, lng, location_accuracy, area_radius_km, is_party_claim, summary_statements(라벨::문장::url1,url2 를 &quot; || &quot;로 구분)</p>
        {csv && (
          <div className="mt-2 text-sm">
            <div>총 {csv.total_rows}행 중 {csv.imported_rows}행 반영 (사건 {csv.events}건, 이미 있는 URL {csv.skipped_duplicates}행 건너뜀), 오류 {csv.errors.length}건</div>
            {csv.errors.length > 0 && (
              <table className="mt-1 w-full text-xs">
                <thead className="bg-gray-50 text-left"><tr><th className="p-1">행</th><th>컬럼</th><th>사유</th></tr></thead>
                <tbody>{csv.errors.map((e: any, i: number) => <tr key={i} className="border-t text-red-700"><td className="p-1">{e.row}</td><td>{e.column}</td><td>{e.reason}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-lg font-bold">5. AI 설정</h2>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="radio" name="aim" checked={s.ai_mode === 'api'} disabled={!s.ai.hasKey || !s.ai.model} onChange={() => run('ai', () => api('/api/settings', { method: 'PATCH', body: { ai_mode: 'api' } }))} />외부 AI API</label>
          <label className="flex items-center gap-1"><input type="radio" name="aim" checked={s.ai_mode === 'pre' || !s.ai.hasKey} onChange={() => run('ai', () => api('/api/settings', { method: 'PATCH', body: { ai_mode: 'pre' } }))} />사전 생성만 (AI 호출 없음)</label>
          <span>오늘 AI 호출: <b>{s.ai.used}</b> / {s.ai.limit}</span>
          <span>AI: {s.ai.provider === 'gemini' ? 'Gemini' : 'Claude'} · 모델: {s.ai.model ?? '(미설정)'}</span>
        </div>
        {s.ai.reason && <div className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900">{s.ai.reason}. AI 없이도 키워드 규칙으로 사건을 만들고, 요약은 직접 작성하거나 CSV(사전 생성 요약)로 넣을 수 있습니다.</div>}
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-lg font-bold">6. 저장소</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-gray-600">데이터베이스</dt><dd className="break-all">{s.storage.label}</dd>
          <dt className="text-gray-600">저장된 건수</dt><dd>사건 {s.storage.events}건 · 기사 {s.storage.articles}건</dd>
          <dt className="text-gray-600">실행 모드</dt><dd>{s.mode === 'lan' ? '공유 모드 (쓰기에 PIN 필요)' : '로컬 모드'}</dd>
        </dl>
        <p className="mt-2 text-xs text-gray-500">백업은 Supabase 대시보드(Database → Backups)에서 관리합니다.</p>
      </section>
    </div>
  );
}
