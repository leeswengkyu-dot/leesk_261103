'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { fmtKst } from '@/lib/time';
import { LABELS, LABEL_KEYS, REGIONS, type EventRow } from '@/lib/types';
import { LabelBadge } from './Badges';
import type { BContent, BSentence, Violation } from '@/lib/briefing';

const MapView = dynamic(() => import('./MapView'), { ssr: false, loading: () => <div className="p-4 text-gray-500">지도 불러오는 중...</div> });

interface Shape {
  id: string;
  status: string;
  briefing_date: string;
  published_at: string | null;
  published_by: string | null;
  event_ids: string[];
  content: BContent;
  events: EventRow[];
}
interface History {
  id: string;
  briefing_date: string;
  published_at: string;
}

type Mode = 'view' | 'edit' | 'present';
type SecKey = 'summary' | 'changes' | 'watch' | string; // string = region:nk

const SECTION_TITLES = ['종합', '지역별 주요 동향', '전일 대비 변화', '관심 관찰 사항', '출처 목록'];

export default function BriefingPage() {
  const [mode, setMode] = useState<Mode>('view');
  const [pub, setPub] = useState<Shape | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [pickId, setPickId] = useState<string>('');
  const [draft, setDraft] = useState<Shape | null>(null);
  const [reviewed, setReviewed] = useState<EventRow[]>([]);
  const [checked, setChecked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [busy, setBusy] = useState(false);
  const [by, setBy] = useState('');
  const [fullAll, setFullAll] = useState(false);
  const presentRef = useRef<HTMLDivElement>(null);
  const [lastPubAt, setLastPubAt] = useState<string | null>(null);

  const loadPub = useCallback(
    async (id?: string) => {
      try {
        const r = await api<{ briefing: Shape | null; history: History[] }>(`/api/briefings${id ? `?id=${id}` : ''}`);
        setPub(r.briefing);
        setHistory(r.history);
        if (!id) setLastPubAt(r.briefing?.published_at ?? null);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [],
  );

  const loadDraft = useCallback(async () => {
    try {
      const r = await api<{ draft: Shape | null; reviewed_events: EventRow[] }>('/api/briefings?view=draft');
      setDraft(r.draft);
      setReviewed(r.reviewed_events);
      setChecked((prev) => {
        if (r.draft) return r.draft.event_ids;
        if (prev.length) return prev.filter((id) => r.reviewed_events.some((e) => e.id === id));
        const cut = Date.now() - 48 * 3600_000;
        return r.reviewed_events.filter((e) => new Date(e.occurred_at ?? e.first_published_at).getTime() >= cut).map((e) => e.id);
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadPub();
    try {
      setBy(localStorage.getItem('argus_actor') || '');
    } catch {}
  }, [loadPub]);

  useEffect(() => {
    if (mode === 'edit') loadDraft();
  }, [mode, loadDraft]);

  // FR-F3-17: 60초마다 최신 게시본 확인 (과거 브리핑을 보는 중이 아닐 때)
  useEffect(() => {
    if (mode === 'edit' || pickId) return;
    const t = setInterval(() => loadPub(), 60_000);
    return () => clearInterval(t);
  }, [mode, pickId, loadPub]);

  // 발표 모드: 전체화면
  const startPresent = async () => {
    setMode('present');
    try {
      await presentRef.current?.requestFullscreen?.();
    } catch {}
  };
  useEffect(() => {
    const h = () => {
      if (!document.fullscreenElement) setMode((m) => (m === 'present' ? 'view' : m));
    };
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.data.violations)) setViolations(e.data.violations as Violation[]);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const generate = () =>
    run(async () => {
      const r = await api<{ usedAi: boolean; note: string | null }>('/api/briefings', { method: 'POST', body: { op: 'generate', event_ids: checked } });
      setNote(r.note ?? (r.usedAi ? 'AI 초안을 만들었습니다. 문장을 확인하고 수정하세요.' : null));
      setViolations([]);
      await loadDraft();
    });
  const blank = () =>
    run(async () => {
      await api('/api/briefings', { method: 'POST', body: { op: 'blank', event_ids: checked } });
      setViolations([]);
      await loadDraft();
    });
  const save = () =>
    run(async () => {
      if (!draft) return;
      const r = await api<{ violations: Violation[] }>('/api/briefings', { method: 'POST', body: { op: 'save', id: draft.id, content: draft.content } });
      setViolations(r.violations);
      setNote(r.violations.length ? `저장했습니다. 게시 전에 고쳐야 할 항목 ${r.violations.length}건` : '저장했습니다. 게시할 수 있습니다');
    });
  const publish = () =>
    run(async () => {
      if (!draft) return;
      try {
        localStorage.setItem('argus_actor', by);
      } catch {}
      await api('/api/briefings', { method: 'POST', body: { op: 'publish', id: draft.id, content: draft.content, published_by: by } });
      setViolations([]);
      setDraft(null);
      setMode('view');
      setPickId('');
      await loadPub();
    });

  const edit = (fn: (c: BContent) => void) =>
    setDraft((d) => {
      if (!d) return d;
      const c = structuredClone(d.content);
      fn(c);
      return { ...d, content: c };
    });

  const findList = (c: BContent, key: SecKey): BSentence[] => (key === 'summary' ? c.summary : key === 'changes' ? c.changes : key === 'watch' ? c.watch : c.regions.find((r) => r.region === key.split(':')[1])!.sentences);

  const view = mode === 'edit' ? draft : pub;
  const shownEvents = view?.events ?? [];
  // 지도: 포함된 사건이 한 지역뿐이면 그 지역으로, 위치 있는 사건이 없으면 안내 문구 표시
  const located = (pub?.events ?? []).filter((e) => e.lat != null && e.lng != null && e.location_accuracy !== 'unknown');
  const regionSet = new Set((pub?.events ?? []).map((e) => e.region));
  const mapRegion = regionSet.size === 1 ? [...regionSet][0] : 'all';
  const noLocNote = pub && located.length < pub.events.length
    ? located.length === 0
      ? `이 브리핑의 사건 ${pub.events.length}건은 위치 정보가 없어 지도에 표시되지 않습니다 (상황판 상세 패널에서 위도·경도를 입력하면 표시됩니다)`
      : `위치가 없는 사건 ${pub.events.length - located.length}건은 지도에 표시되지 않습니다`
    : null;

  /* ───── 렌더 조각 ───── */
  const srcLinks = (s: BSentence, c: BContent) =>
    s.source_numbers.map((n) => {
      const src = c.sources.find((x) => x.n === n);
      return (
        <a key={n} href={src?.url} target="_blank" rel="noreferrer" title={src ? `${src.source_name} — ${src.title}` : ''} className="mx-0.5 rounded bg-blue-50 px-1 text-[0.8em] text-blue-800 underline">
          [{n}]
        </a>
      );
    });

  const sentenceView = (s: BSentence, c: BContent, present = false) => (
    <li key={s.id} className="flex flex-wrap items-baseline gap-1.5 py-0.5">
      <LabelBadge label={s.label} />
      <span className={present ? 'text-[1em]' : ''}>{s.text}</span>
      {srcLinks(s, c)}
      {s.event_ids[0] && mode !== 'present' && <Link href={`/?region=all&period=7d&tab=all&sel=${s.event_ids[0]}`} className="text-[0.75em] text-gray-500 underline">사건</Link>}
    </li>
  );

  const sentenceEdit = (s: BSentence, key: SecKey, c: BContent) => {
    const bad = violations.filter((v) => v.sentence_id === s.id);
    return (
      <li key={s.id} className={`rounded border p-2 ${bad.length ? 'border-red-500 bg-red-50' : 'border-gray-200'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-auto py-0.5 text-xs" value={s.label} onChange={(e) => edit((cc) => { findList(cc, key).find((x) => x.id === s.id)!.label = e.target.value; })}>
            {LABEL_KEYS.map((k) => <option key={k} value={k}>[{LABELS[k].name}]</option>)}
          </select>
          <details className="relative text-xs">
            <summary className="btn btn-sm cursor-pointer list-none">출처 {s.source_numbers.length ? s.source_numbers.map((n) => `[${n}]`).join('') : '없음'} ▾</summary>
            <div className="absolute z-20 mt-1 max-h-56 w-72 overflow-y-auto rounded border bg-white p-2 shadow-lg">
              {c.sources.map((src) => (
                <label key={src.n} className="flex items-start gap-1 py-0.5">
                  <input type="checkbox" checked={s.source_numbers.includes(src.n)} onChange={(e) => edit((cc) => { const t = findList(cc, key).find((x) => x.id === s.id)!; t.source_numbers = e.target.checked ? [...t.source_numbers, src.n].sort((a, b) => a - b) : t.source_numbers.filter((n) => n !== src.n); })} />
                  <span>[{src.n}] {src.source_name}({src.source_grade}) {src.title.slice(0, 40)}</span>
                </label>
              ))}
            </div>
          </details>
          <button className="btn btn-sm ml-auto" onClick={() => edit((cc) => { const l = findList(cc, key); l.splice(l.findIndex((x) => x.id === s.id), 1); })}>삭제</button>
        </div>
        <textarea className="input mt-1" rows={2} value={s.text} onChange={(e) => edit((cc) => { findList(cc, key).find((x) => x.id === s.id)!.text = e.target.value; })} />
        {bad.map((v, i) => <div key={i} className="mt-1 text-xs font-semibold text-red-700">⚠ {v.reason}</div>)}
      </li>
    );
  };

  const addSentence = (key: SecKey) =>
    edit((cc) => {
      const list = findList(cc, key);
      const evs = draft?.event_ids ?? [];
      list.push({ id: Math.random().toString(36).slice(2, 10), text: '', label: key === 'summary' ? 'fact' : 'unverified', source_numbers: [], event_ids: evs.slice(0, 1) });
    });

  const section = (title: string, key: SecKey, c: BContent, editMode: boolean) => {
    const list = findList(c, key);
    return (
      <div key={key} className="mb-2">
        {title && <h4 className="mt-2 font-semibold text-gray-700">{title}</h4>}
        <ul>{list.map((s) => (editMode ? sentenceEdit(s, key, c) : sentenceView(s, c)))}</ul>
        {list.length === 0 && !editMode && <div className="text-sm text-gray-400">해당 없음</div>}
        {editMode && <button className="btn btn-sm mt-1" onClick={() => addSentence(key)}>+ 문장 추가</button>}
      </div>
    );
  };

  const sourcesList = (c: BContent) => {
    const used = new Set<number>([...c.summary, ...c.changes, ...c.watch, ...c.regions.flatMap((r) => r.sentences)].flatMap((s) => s.source_numbers));
    const list = c.sources.filter((s) => used.has(s.n));
    if (!list.length) return <div className="text-sm text-gray-400">참조된 출처가 없습니다</div>;
    return (
      <ol className="space-y-0.5 text-[0.85em]">
        {list.map((s) => (
          <li key={s.n}>[{s.n}] {s.source_name} · <a className="text-blue-700 underline" href={s.url} target="_blank" rel="noreferrer">{s.url.length > 70 ? s.url.slice(0, 70) + '…' : s.url}</a> · {fmtKst(s.published_at)}</li>
        ))}
      </ol>
    );
  };

  const titleOf = (b: Shape) => {
    const d = new Date(b.published_at ?? Date.now());
    const k = fmtKst(d.toISOString());
    return `${k.slice(5, 7)}월 ${k.slice(8, 10)}일 국방·안보 동향${b.published_at ? ` (게시 ${k.slice(11, 16)})` : ' (초안)'}`;
  };

  /* ───── 발표 모드 ───── */
  const presentView = pub && (
    <div ref={presentRef} className="present flex h-screen flex-col overflow-hidden bg-slate-950 p-4 text-white" style={{ fontSize: 20, display: mode === 'present' ? 'flex' : 'none' }}>
      <div className="flex items-baseline gap-4">
        <h1 className="text-[1.4em] font-extrabold">{titleOf(pub)}</h1>
        <span className="text-[0.7em] text-slate-300">게시 {fmtKst(pub.published_at)}{pub.published_by ? ` · ${pub.published_by}` : ''}</span>
        <button className="ml-auto rounded border border-slate-500 px-3 text-[0.7em]" onClick={() => document.exitFullscreen?.().catch(() => {})}>종료 (Esc)</button>
      </div>
      <div className="mt-2 grid min-h-0 flex-1 grid-cols-[3fr_2fr] gap-4">
        <div className="min-h-0 space-y-1 overflow-hidden text-white [&_a]:text-sky-300">
          <PresentSection title="1. 종합"><ul>{pub.content.summary.map((s) => sentenceView(s, pub.content, true))}</ul></PresentSection>
          <PresentSection title="2. 지역별 주요 동향">
            {pub.content.regions.filter((r) => r.sentences.length).map((r) => (
              <div key={r.region}>
                <b className="text-amber-300">{REGIONS[r.region as keyof typeof REGIONS]}</b>
                <ul>{(fullAll ? r.sentences : r.sentences.slice(0, 3)).map((s) => sentenceView(s, pub.content, true))}</ul>
                {!fullAll && r.sentences.length > 3 && <button className="text-[0.7em] underline" onClick={() => setFullAll(true)}>전체 보기 (+{r.sentences.length - 3})</button>}
              </div>
            ))}
          </PresentSection>
          <PresentSection title="3. 전일 대비 변화"><ul>{pub.content.changes.slice(0, 6).map((s) => sentenceView(s, pub.content, true))}</ul></PresentSection>
          <PresentSection title="4. 관심 관찰 사항"><ul>{pub.content.watch.slice(0, 4).map((s) => sentenceView(s, pub.content, true))}</ul></PresentSection>
        </div>
        <div className="flex min-h-0 flex-col gap-2">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded bg-white">
            {mode === 'present' && <MapView events={pub.events} region={mapRegion} fitAll />}
            {noLocNote && <div className="absolute inset-x-0 bottom-0 z-[1000] bg-amber-100 px-2 py-1 text-[0.6em] text-amber-900">{noLocNote}</div>}
          </div>
          <div className="max-h-[22%] overflow-hidden text-[0.6em] text-slate-300"><b>5. 출처 목록</b> {pub.content.sources.slice(0, 8).map((s) => `[${s.n}] ${s.source_name}`).join(' · ')}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {presentView}
      <div style={{ display: mode === 'present' ? 'none' : 'block' }} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b bg-white px-4 py-2">
          <div className="flex overflow-hidden rounded border">
            {([['view', '보기'], ['edit', '편집']] as const).map(([k, v]) => (
              <button key={k} className={`px-3 py-1 ${mode === k ? 'bg-blue-700 font-semibold text-white' : 'bg-white'}`} onClick={() => setMode(k)}>{v}</button>
            ))}
          </div>
          <button className="btn" disabled={!pub} onClick={startPresent}>발표 모드</button>
          {mode === 'view' && history.length > 0 && (
            <select className="input w-auto" value={pickId} onChange={(e) => { setPickId(e.target.value); if (e.target.value) loadPub(e.target.value); else loadPub(); }}>
              <option value="">최신 게시본</option>
              {history.map((h) => <option key={h.id} value={h.id}>{h.briefing_date} ({fmtKst(h.published_at).slice(11)} 게시)</option>)}
            </select>
          )}
          {mode === 'view' && <button className="btn btn-sm" onClick={() => loadPub(pickId || undefined)}>새로고침</button>}
        </div>

        {err && <div className="bg-red-50 px-4 py-2 text-sm text-red-800">{err}</div>}
        {note && <div className="bg-blue-50 px-4 py-2 text-sm text-blue-900">{note}</div>}

        {mode === 'view' && !pub && !err && (
          <div className="flex flex-1 items-center justify-center p-8 text-lg text-gray-600">아직 게시된 브리핑이 없습니다</div>
        )}

        {mode === 'view' && pub && (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[3fr_2fr]">
            <div className="overflow-y-auto bg-white p-6">
              <h1 className="text-2xl font-extrabold">{titleOf(pub)}</h1>
              <div className="mb-3 text-sm text-gray-600">게시 {fmtKst(pub.published_at)} KST{pub.published_by ? ` · 게시자 ${pub.published_by}` : ''}</div>
              <div className="space-y-5 text-[15px] leading-relaxed">
                <div><h2 className="border-b font-bold">1. {SECTION_TITLES[0]}</h2>{section('', 'summary', pub.content, false)}</div>
                <div><h2 className="border-b font-bold">2. {SECTION_TITLES[1]}</h2>{pub.content.regions.map((r) => r.sentences.length ? <div key={r.region}>{section(REGIONS[r.region as keyof typeof REGIONS], `region:${r.region}`, pub.content, false)}</div> : null)}</div>
                <div><h2 className="border-b font-bold">3. {SECTION_TITLES[2]}</h2>{section('', 'changes', pub.content, false)}</div>
                <div><h2 className="border-b font-bold">4. {SECTION_TITLES[3]}</h2>{section('', 'watch', pub.content, false)}</div>
                <div><h2 className="border-b font-bold">5. {SECTION_TITLES[4]}</h2>{sourcesList(pub.content)}</div>
              </div>
            </div>
            <div className="relative min-h-[300px] border-l">
              <MapView events={shownEvents} region={mapRegion} fitAll />
              {noLocNote && <div className="absolute inset-x-0 bottom-0 z-[1000] bg-amber-100 px-3 py-1.5 text-sm text-amber-900">{noLocNote}</div>}
            </div>
          </div>
        )}

        {mode === 'edit' && (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[2fr_3fr]">
            <div className="overflow-y-auto border-r bg-white p-4">
              <h2 className="font-bold">1. 포함할 사건 (검토 완료만)</h2>
              {reviewed.length === 0 ? (
                <div className="mt-2 rounded bg-gray-50 p-3 text-sm text-gray-600">검토 완료된 사건이 없어 초안을 만들 수 없습니다.<br /><Link className="btn mt-2" href="/">상황판으로 이동</Link></div>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {reviewed.map((e) => (
                    <li key={e.id}>
                      <label className="flex items-start gap-2">
                        <input type="checkbox" className="mt-1" checked={checked.includes(e.id)} onChange={(ev) => setChecked((p) => (ev.target.checked ? [...p, e.id] : p.filter((x) => x !== e.id)))} />
                        <span>{e.title}<span className="block text-xs text-gray-500">{REGIONS[e.region]} · {fmtKst(e.occurred_at ?? e.first_published_at)} · 문장 {e.statement_count}</span></span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn btn-primary" disabled={busy || checked.length === 0} onClick={generate}>{busy ? '생성 중...' : 'AI 초안 생성'}</button>
                <button className="btn" disabled={busy || checked.length === 0} onClick={blank}>빈 양식으로 시작</button>
              </div>
              <p className="mt-2 text-xs text-gray-500">초안은 검토 완료 사건의 승인된 문장만 입력으로 사용합니다. [사실 제안] 상태의 문장은 [미확인]으로 취급됩니다. 게시 전에는 지휘관 화면이 바뀌지 않습니다.</p>
            </div>
            <div className="overflow-y-auto bg-white p-4">
              {!draft ? (
                <div className="p-6 text-center text-gray-500">왼쪽에서 사건을 고르고 초안을 만드세요.</div>
              ) : (
                <>
                  <div className="sticky top-0 z-10 -mx-4 -mt-4 mb-3 flex flex-wrap items-center gap-2 border-b bg-white px-4 py-2">
                    <b>초안 편집</b>
                    {violations.length > 0 && <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">수정 필요 {violations.length}건</span>}
                    <input className="input ml-auto w-32" placeholder="게시자(선택)" value={by} onChange={(e) => setBy(e.target.value)} />
                    <button className="btn" disabled={busy} onClick={save}>저장·검증</button>
                    <button className="btn btn-primary" disabled={busy} onClick={publish}>브리핑 게시</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => confirm('초안을 버릴까요?') && run(async () => { await api('/api/briefings', { method: 'POST', body: { op: 'discard' } }); setDraft(null); })}>초안 삭제</button>
                  </div>
                  {violations.filter((v) => !v.sentence_id).map((v, i) => <div key={i} className="mb-2 rounded bg-red-50 p-2 text-sm text-red-800">⚠ {v.reason}</div>)}
                  <h3 className="font-bold">1. 종합 <span className="text-xs font-normal text-gray-500">([사실]·[당사자 주장]만)</span></h3>
                  {section('', 'summary', draft.content, true)}
                  <h3 className="mt-3 font-bold">2. 지역별 주요 동향</h3>
                  {draft.content.regions.map((r) => <div key={r.region}>{section(REGIONS[r.region as keyof typeof REGIONS], `region:${r.region}`, draft.content, true)}</div>)}
                  <h3 className="mt-3 font-bold">3. 전일 대비 변화</h3>
                  {section('', 'changes', draft.content, true)}
                  <h3 className="mt-3 font-bold">4. 관심 관찰 사항</h3>
                  {section('', 'watch', draft.content, true)}
                  <h3 className="mt-3 font-bold">5. 출처 목록</h3>
                  {sourcesList(draft.content)}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PresentSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="border-b border-slate-600 text-[0.8em] font-bold text-sky-200">{title}</div>
      <div className="leading-snug">{children}</div>
    </div>
  );
}
