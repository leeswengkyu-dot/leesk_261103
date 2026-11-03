'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { audioReady, siren, unlockAudio } from '@/lib/client/alarm';
import { fmtKst, parseTime } from '@/lib/time';
import { EVENT_TYPES, REGIONS, RELIABILITY, REVIEW_STATUS, type EventRow, type RegionSummary } from '@/lib/types';
import { alertText } from '@/lib/rules/labels';
import { AlertBadges, ChangeBadge, Chip, LabelBadge, RelBadge } from './Badges';
import EventDetail from './EventDetail';

const MapView = dynamic(() => import('./MapView'), { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-gray-500">지도 불러오는 중...</div> });

interface BoardData {
  now: string;
  live: { enabled: boolean; interval_min: number };
  events: EventRow[];
  summaries: RegionSummary[];
  status: {
    run_count: number;
    last_status: string | null;
    last_started_at: string | null;
    failed_feeds: number;
    collecting: boolean;
    running_trigger: string | null;
    ai_available: boolean;
    ai_reason: string | null;
  };
}

const PERIODS: Record<string, number> = { '24h': 24, '3d': 72, '7d': 168 };
const REL_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const evTime = (e: EventRow) => new Date(e.occurred_at ?? e.first_published_at).getTime();

export default function Board() {
  const router = useRouter();
  const sp = useSearchParams();
  const [data, setData] = useState<BoardData | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tileErr, setTileErr] = useState(false);
  const [showUnknown, setShowUnknown] = useState(false);
  const [sort, setSort] = useState<'occurred' | 'published' | 'reliability'>('occurred');
  const [exporting, setExporting] = useState(false);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  const region = sp.get('region') ?? 'nk';
  const period = sp.get('period') ?? '24h';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const types = useMemo(() => (sp.get('types') ? sp.get('types')!.split(',') : []), [sp]);
  const rels = useMemo(() => (sp.get('rel') ? sp.get('rel')!.split(',') : []), [sp]);
  const tab = sp.get('tab') ?? 'all';
  const sel = sp.get('sel');

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const p = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') p.delete(k);
        else p.set(k, v);
      }
      router.replace(`/?${p.toString()}`, { scroll: false });
    },
    [router, sp],
  );

  const seen = useRef<Set<string> | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [urgent, setUrgent] = useState<EventRow[]>([]);
  const [soundOn, setSoundOn] = useState(false);
  const [audioOk, setAudioOk] = useState(false);

  useEffect(() => {
    let on = false;
    try {
      on = localStorage.getItem('argus_sound') === 'on';
    } catch {}
    setSoundOn(on);
    // 브라우저는 클릭 전에는 소리를 막으므로, 첫 클릭에서 소리를 연다
    const unlock = () => {
      if (on) setAudioOk(unlockAudio() && audioReady());
    };
    document.addEventListener('pointerdown', unlock);
    return () => document.removeEventListener('pointerdown', unlock);
  }, []);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    try {
      localStorage.setItem('argus_sound', next ? 'on' : 'off');
    } catch {}
    if (next) {
      unlockAudio();
      setAudioOk(true);
      siren(); // 확인용 시험음
    }
  };

  // 긴급 알림이 떠 있는 동안 경보음 반복 + 탭 제목 깜빡임
  useEffect(() => {
    if (urgent.length === 0) return;
    if (soundOn) {
      siren();
      const t = setInterval(siren, 6000);
      return () => clearInterval(t);
    }
  }, [urgent.length, soundOn]);

  useEffect(() => {
    if (urgent.length === 0) {
      document.title = 'ARGUS-K';
      return;
    }
    let flip = false;
    const t = setInterval(() => {
      flip = !flip;
      document.title = flip ? `🚨 긴급 ${urgent.length}건 - ARGUS-K` : 'ARGUS-K';
    }, 800);
    return () => {
      clearInterval(t);
      document.title = 'ARGUS-K';
    };
  }, [urgent.length]);

  const load = useCallback(async () => {
    try {
      const r = await api<BoardData>('/api/board');
      // 새로 들어온 사건 감지 (첫 로드는 기준만 저장)
      if (seen.current) {
        const prev = seen.current;
        const freshEv = r.events.filter((e) => !prev.has(e.id));
        if (freshEv.length) setNewIds((p) => new Set([...p, ...freshEv.map((e) => e.id)]));
        // 경보 대상(미사일 발사·핵·무력 충돌, 위치/내용 충돌) 새 사건 → 긴급 알림
        const hot = freshEv.filter((e) => e.alert_reasons.length > 0);
        if (hot.length) setUrgent((p) => [...p, ...hot]);
      }
      seen.current = new Set(r.events.map((e) => e.id));
      setData(r);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000); // 15초마다 확인 → 서버가 자동 수집한 새 사건이 바로 나타남
    return () => clearInterval(t);
  }, [load]);

  // 실시간 수집: 서버에는 상시 타이머가 없으므로 상황판이 열려 있는 동안 1분마다 신호를 보낸다.
  // 서버가 설정 간격·진행 여부를 확인해 필요할 때만 수집한다.
  const liveOn = !!data?.live.enabled;
  useEffect(() => {
    if (!liveOn) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/live', { method: 'POST', cache: 'no-store' });
        const j = (await r.json().catch(() => ({}))) as { ran?: boolean };
        if (!stop && j.ran) load();
      } catch {}
    };
    const first = setTimeout(tick, 5000);
    const t = setInterval(tick, 60_000);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [liveOn, load]);

  // 수집 중이면 짧게 폴링
  useEffect(() => {
    if (!data?.status.collecting) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [data?.status.collecting, load]);

  /* 필터 (클라이언트에서 처리: NFR-02) */
  const filtered = useMemo(() => {
    if (!data) return [] as EventRow[];
    const now = Date.now();
    let lo = -Infinity;
    let hi = Infinity;
    if (period === 'custom') {
      const a = from ? new Date(parseTime(from) as string).getTime() : -Infinity;
      const b = to ? new Date(parseTime(to) as string).getTime() + 24 * 3600_000 : Infinity;
      lo = a;
      hi = b;
    } else lo = now - (PERIODS[period] ?? 24) * 3600_000;
    const list = data.events.filter((e) => {
      if (region !== 'all' && e.region !== region) return false;
      const t = evTime(e);
      if (t < lo || t > hi) return false;
      if (types.length && !types.includes(e.event_type)) return false;
      if (rels.length && !rels.includes(e.reliability)) return false;
      if (tab === 'inbox' && e.review_status !== 'collected') return false;
      if (tab === 'reviewed' && e.review_status !== 'reviewed') return false;
      return true;
    });
    return list.sort((a, b) =>
      sort === 'occurred' ? evTime(b) - evTime(a) : sort === 'published' ? new Date(b.first_published_at).getTime() - new Date(a.first_published_at).getTime() : REL_ORDER[a.reliability] - REL_ORDER[b.reliability] || evTime(b) - evTime(a),
    );
  }, [data, region, period, from, to, types, rels, tab, sort]);

  // 목록 번호 = 지도 마커 번호 (현재 필터·정렬 기준 1부터)
  const numbers = useMemo(() => Object.fromEntries(filtered.map((e, i) => [e.id, i + 1])) as Record<string, number>, [filtered]);

  const mapEvents = useMemo(() => filtered.filter((e) => e.lat != null && e.lng != null && e.location_accuracy !== 'unknown'), [filtered]);
  const unknownEvents = useMemo(() => filtered.filter((e) => !(e.lat != null && e.lng != null && e.location_accuracy !== 'unknown')), [filtered]);

  // 지도 → 목록 스크롤 (FR-F3-07)
  useEffect(() => {
    if (sel) rowRefs.current.get(sel)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sel, filtered]);

  const select = (id: string | null) => setParams({ sel: id });

  /* 상단 요약·경보 */
  const regionsShown = region === 'all' ? Object.keys(REGIONS) : [region];
  const alertEvents = useMemo(() => {
    if (!data) return [];
    const lo = Date.now() - 24 * 3600_000;
    return data.events.filter((e) => regionsShown.includes(e.region) && e.alert_reasons.length > 0 && evTime(e) >= lo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, region]);
  const surgeRegions = data?.summaries.filter((s) => s.surge && regionsShown.includes(s.region)) ?? [];

  const exportKml = async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/export-kml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: mapEvents.map((e) => e.id), title: `ARGUS-K ${region === 'all' ? '전체' : REGIONS[region as keyof typeof REGIONS]}` }) });
      if (!res.ok) throw new Error('내보내지 못했습니다');
      const blob = await res.blob();
      const t = fmtKst(new Date().toISOString()).replace(/[- :]/g, '');
      const name = `ARGUS-K_${region === 'all' ? '전체' : REGIONS[region as keyof typeof REGIONS]}_${t.slice(0, 8)}-${t.slice(8, 12)}.kml`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const [collecting, setCollecting] = useState(false);
  const [collectMsg, setCollectMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const collectNow = async () => {
    setCollecting(true);
    setCollectMsg(null);
    try {
      const r = await api<{ new_articles: number; events: number; status: string; aiNote?: string | null }>('/api/collect', { method: 'POST' });
      const failed = r.status === 'failed' ? ' — 모든 출처 수집에 실패했습니다 (인터넷 연결 확인)' : r.status === 'partial' ? ' (일부 출처 실패)' : '';
      setCollectMsg({ ok: r.status !== 'failed', text: `수집 완료: 신규 기사 ${r.new_articles}건, 새 사건 ${r.events}건${failed}` });
    } catch (e) {
      setCollectMsg({ ok: false, text: (e as Error).message });
    } finally {
      setCollecting(false);
      load();
    }
  };

  // 수집 중에는 목록을 자주 갱신해 새 사건이 바로 나타나게 한다
  useEffect(() => {
    if (!collecting) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [collecting, load]);

  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const Row = ({ e }: { e: EventRow }) => (
    <li
      ref={(el) => {
        if (el) rowRefs.current.set(e.id, el);
        else rowRefs.current.delete(e.id);
      }}
      onClick={() => select(e.id)}
      className={`cursor-pointer border-b px-3 py-2 hover:bg-blue-50 ${sel === e.id ? 'bg-blue-100 ring-2 ring-inset ring-blue-500' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-1 text-sm font-extrabold text-white"
          style={{ background: RELIABILITY[e.reliability].color }}
          title={e.lat != null && e.location_accuracy !== 'unknown' ? `지도의 ${numbers[e.id]}번 마커` : '위치 미상 (지도에 표시되지 않음)'}
        >
          {numbers[e.id]}
        </span>
        <span className="mt-1 text-base" title={EVENT_TYPES[e.event_type]?.name}>{EVENT_TYPES[e.event_type]?.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug">{e.title}</div>
          {e.title_ko && <div className="leading-snug text-blue-900"><span className="mr-1 rounded bg-blue-100 px-1 text-[10px] font-bold">한글</span>{e.title_ko}</div>}
          <div className="text-xs text-gray-600">
            {e.occurred_at ? fmtKst(e.occurred_at) : `${fmtKst(e.first_published_at)} (게시 기준)`} · {REGIONS[e.region]}
            {e.location_name ? ` · ${e.location_name}` : ' · 위치 미상'}
          </div>
          {e.sources.length > 0 && <div className="text-xs text-gray-700">출처: {e.sources.map((s) => `${s.name}(${s.grade})`).join(' · ')}</div>}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <RelBadge level={e.reliability} />
            <LabelBadge label={e.top_label} />
            <ChangeBadge type={e.change_type} />
            <Chip>출처 {e.source_count}</Chip>
            {newIds.has(e.id) && <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-xs font-bold text-white">NEW</span>}
            <Chip tone={e.review_status === 'reviewed' ? 'blue' : 'gray'}>{REVIEW_STATUS[e.review_status]}</Chip>
            <AlertBadges reasons={e.alert_reasons.filter((r) => !['location_conflict', 'content_conflict'].includes(r))} />
            {e.location_conflict ? <Chip tone="red">위치 충돌</Chip> : null}
            {e.content_conflict ? <Chip tone="red">내용 충돌</Chip> : null}
            {e.dup_count > 0 && <Chip tone="amber">중복 후보 {e.dup_count}건</Chip>}
          </div>
        </div>
      </div>
    </li>
  );

  const st = data?.status;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 긴급 알림: 경보 대상 새 사건이 들어오면 확인할 때까지 유지 */}
      {urgent.length > 0 && (
        <div className="fixed inset-x-0 top-0 z-[3000] animate-pulse border-b-4 border-red-900 bg-red-600 px-4 py-3 text-white shadow-2xl">
          <div className="flex items-start gap-3">
            <span className="text-3xl">🚨</span>
            <div className="min-w-0 flex-1">
              <div className="text-lg font-extrabold">긴급: 경보 대상 새 사건 {urgent.length}건</div>
              <ul className="mt-1 space-y-1">
                {urgent.slice(0, 4).map((e) => (
                  <li key={e.id} className="truncate">
                    <b>[{e.alert_reasons.map(alertText).join(', ')}]</b> {REGIONS[e.region]} · {e.title}
                    {e.title_ko ? <span className="ml-1 text-red-100">({e.title_ko})</span> : null}
                    <button className="ml-2 rounded bg-white px-2 text-xs font-bold text-red-700" onClick={() => { setParams({ region: e.region, sel: e.id, tab: 'all', period: '24h' }); }}>보기</button>
                  </li>
                ))}
              </ul>
              {urgent.length > 4 && <div className="text-sm">외 {urgent.length - 4}건</div>}
              <div className="mt-1 text-xs text-red-100">자동 수집된 미확인 정보입니다. 반드시 출처를 확인하고 검토하세요.</div>
            </div>
            <button className="rounded bg-white px-4 py-2 font-extrabold text-red-700" onClick={() => setUrgent([])}>확인 (경보 끄기)</button>
          </div>
        </div>
      )}
      {/* 안내 띠 */}
      {loadErr && (
        <div className="flex items-center gap-3 bg-red-600 px-4 py-1.5 text-sm text-white">
          데이터를 불러오지 못했습니다: {loadErr}
          <button className="rounded bg-white px-2 py-0.5 text-red-700" onClick={load}>다시 시도</button>
        </div>
      )}
      {(collecting || st?.collecting) && <div className="bg-blue-600 px-4 py-1.5 text-sm text-white">{st?.running_trigger === 'catchup' ? '놓친 아침 수집을 지금 실행합니다...' : '수집을 실행 중입니다... 새 사건이 생기면 목록에 자동으로 나타납니다 (최대 몇 분)'}</div>}
      <div className="flex flex-wrap items-center gap-3 border-b bg-white px-4 py-1 text-xs text-gray-700">
        {data?.live.enabled ? (
          <span className="font-semibold text-emerald-700">● 실시간 수집 켜짐 — 이 화면이 열려 있는 동안 {data.live.interval_min}분마다 자동 수집 · 화면은 15초마다 갱신</span>
        ) : (
          <span className="text-gray-500">○ 실시간 자동 수집 꺼짐 (데이터·설정에서 켤 수 있음)</span>
        )}
        <span>마지막 수집: {st?.last_started_at ? fmtKst(st.last_started_at) : '없음'}</span>
        <button className={`rounded border px-2 py-0.5 font-semibold ${soundOn ? 'border-red-600 bg-red-50 text-red-700' : 'border-gray-300'}`} onClick={toggleSound}>
          {soundOn ? '🔔 경보음 켜짐 (끄기)' : '🔕 경보음 꺼짐 (켜기)'}
        </button>
        {soundOn && !audioOk && <span className="text-amber-700">화면을 한 번 클릭하면 경보음이 활성화됩니다</span>}
        {soundOn && <button className="rounded border px-2 py-0.5" onClick={() => { unlockAudio(); siren(); }}>시험음</button>}
        {newIds.size > 0 && (
          <button className="rounded bg-emerald-600 px-2 py-0.5 font-bold text-white" onClick={() => setNewIds(new Set())}>
            새 사건 {newIds.size}건 들어옴 — NEW 표시 지우기
          </button>
        )}
      </div>
      {collectMsg && !collecting && (
        <div className={`flex items-center gap-3 px-4 py-1.5 text-sm ${collectMsg.ok ? 'bg-green-100 text-green-900' : 'bg-red-100 text-red-900'}`}>
          {collectMsg.text}
          <button className="ml-auto rounded border px-2 text-xs" onClick={() => setCollectMsg(null)}>닫기</button>
        </div>
      )}
      {st && !st.collecting && st.last_status === 'failed' && (
        <div className="bg-red-100 px-4 py-1.5 text-sm text-red-900">최근 수집이 실패했습니다. <Link className="underline" href="/settings">데이터·설정에서 재시도</Link></div>
      )}
      {st && st.failed_feeds > 0 && st.last_status !== 'failed' && <div className="bg-amber-100 px-4 py-1.5 text-sm text-amber-900">최근 수집에서 {st.failed_feeds}개 출처 실패 — <Link className="underline" href="/settings">자세히</Link></div>}

      {/* 변화 요약 + 경보 */}
      <div className="border-b bg-white px-4 py-2">
        <div className="flex flex-wrap items-stretch gap-2">
          {(data?.summaries ?? []).map((s) => {
            const diff = s.cur - s.prev;
            const on = region === 'all' || region === s.region;
            return (
              <button key={s.region} onClick={() => setParams({ region: s.region, sel: null })} className={`rounded border px-3 py-1 text-left text-xs ${on ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-gray-50 opacity-70'}`}>
                <div className="flex items-center gap-1 font-bold text-sm">{REGIONS[s.region]} {s.surge && <span className="rounded bg-red-600 px-1 text-white">! 급증</span>}</div>
                <div>신규 <b>{s.new}</b> · 지속 <b>{s.continuing}</b> · 확대 <b>{s.escalated}</b> · 종료 <b>{s.ended}</b></div>
                <div className="text-gray-600">최근 24시간 {s.cur}건 (직전 24시간 대비 {diff > 0 ? '+' : ''}{diff})</div>
              </button>
            );
          })}
          <div className="flex min-w-[12rem] flex-1 flex-wrap content-center items-center gap-1">
            {alertEvents.length === 0 && surgeRegions.length === 0 && <span className="text-xs text-gray-500">경보 없음</span>}
            {surgeRegions.map((s) => <span key={s.region} className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">! {REGIONS[s.region]} 사건 급증</span>)}
            {alertEvents.slice(0, 6).map((e) => (
              <button key={e.id} onClick={() => setParams({ region: e.region, sel: e.id })} className="max-w-[16rem] truncate rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800 hover:bg-red-200" title={e.title}>
                ! {alertText(e.alert_reasons[0])}: {e.title}
              </button>
            ))}
            {alertEvents.length > 6 && <span className="text-xs text-gray-600">외 {alertEvents.length - 6}건</span>}
          </div>
        </div>
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-gray-50 px-4 py-2 text-sm">
        <select className="input w-auto" value={region} onChange={(e) => setParams({ region: e.target.value, sel: null })}>
          {Object.entries(REGIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="all">전체</option>
        </select>
        <select className="input w-auto" value={period} onChange={(e) => setParams({ period: e.target.value })}>
          <option value="24h">최근 24시간</option>
          <option value="3d">3일</option>
          <option value="7d">7일</option>
          <option value="custom">직접 지정</option>
        </select>
        {period === 'custom' && (
          <>
            <input type="date" className="input w-auto" value={from} onChange={(e) => setParams({ from: e.target.value })} />~
            <input type="date" className="input w-auto" value={to} onChange={(e) => setParams({ to: e.target.value })} />
          </>
        )}
        <details className="relative">
          <summary className="btn cursor-pointer list-none">사건 유형{types.length ? ` (${types.length})` : ''} ▾</summary>
          <div className="absolute z-[1000] mt-1 w-52 rounded border bg-white p-2 shadow-lg">
            {Object.entries(EVENT_TYPES).map(([k, v]) => (
              <label key={k} className="flex items-center gap-2 py-0.5"><input type="checkbox" checked={types.includes(k)} onChange={() => setParams({ types: toggle(types, k).join(',') })} />{v.icon} {v.name}</label>
            ))}
          </div>
        </details>
        <details className="relative">
          <summary className="btn cursor-pointer list-none">신뢰도{rels.length ? ` (${rels.length})` : ''} ▾</summary>
          <div className="absolute z-[1000] mt-1 w-36 rounded border bg-white p-2 shadow-lg">
            {[['high', '높음'], ['medium', '보통'], ['low', '낮음']].map(([k, v]) => (
              <label key={k} className="flex items-center gap-2 py-0.5"><input type="checkbox" checked={rels.includes(k)} onChange={() => setParams({ rel: toggle(rels, k).join(',') })} />{v}</label>
            ))}
          </div>
        </details>
        <div className="ml-2 flex overflow-hidden rounded border">
          {[['inbox', '수집함'], ['reviewed', '검토 완료'], ['all', '전체']].map(([k, v]) => (
            <button key={k} onClick={() => setParams({ tab: k })} className={`px-3 py-1 ${tab === k ? 'bg-blue-700 font-semibold text-white' : 'bg-white'}`}>{v}</button>
          ))}
        </div>
        <button className="btn" onClick={() => router.replace('/')}>필터 초기화</button>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-primary" disabled={collecting || !!st?.collecting} onClick={collectNow}>
            {collecting || st?.collecting ? '⟳ 수집 중...' : '⟳ 지금 수집'}
          </button>
          <span className="font-semibold">지도 {mapEvents.length}건 + 위치 미상 {unknownEvents.length}건</span>
          <button className="btn" disabled={exporting || mapEvents.length === 0} onClick={exportKml}>KML 내보내기</button>
        </div>
      </div>

      {/* 본문: 지도 60% / 목록 40% */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[3fr_2fr]" style={{ height: 'calc(100vh - 230px)', minHeight: 420 }}>
        <div className="relative flex min-h-[320px] flex-col border-r">
          <div className="relative min-h-0 flex-1">
            <MapView events={mapEvents} numbers={numbers} selectedId={sel} onSelect={(id) => select(id)} region={region} onTileError={() => setTileErr(true)} />
            {tileErr && <div className="absolute inset-x-0 top-0 z-[1000] bg-amber-100 px-3 py-1 text-center text-sm text-amber-900">지도를 불러오지 못했습니다. 목록은 계속 사용할 수 있습니다</div>}
            <div className="absolute bottom-1 left-1 z-[1000] rounded bg-white/90 px-2 py-1 text-[11px] text-gray-700">
              마커 숫자 = 목록 번호 · 모서리 H/M/L·색 = 신뢰도 · 실선 = 정확 · 점선 원 = &quot;일대&quot; 범위 · 빨강 점선 = 위치 충돌 · ! = 경보 · 같은 위치 사건은 겹치지 않게 벌려 표시
            </div>
          </div>
          <div className="border-t bg-white">
            <button className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm font-semibold" onClick={() => setShowUnknown((v) => !v)}>
              위치 미상 목록 ({unknownEvents.length}건) <span>{showUnknown ? '▲' : '▼'}</span>
            </button>
            {showUnknown && (
              <ul className="max-h-40 overflow-y-auto border-t text-sm">
                {unknownEvents.length === 0 && <li className="px-3 py-2 text-gray-500">위치 미상 사건이 없습니다</li>}
                {unknownEvents.map((e) => (
                  <li key={e.id} onClick={() => select(e.id)} className={`cursor-pointer border-b px-3 py-1 hover:bg-blue-50 ${sel === e.id ? 'bg-blue-100' : ''}`}><b className="mr-1">#{numbers[e.id]}</b>{e.title}{e.title_ko ? <span className="block text-blue-900">{e.title_ko}</span> : null}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col bg-white" style={{ maxHeight: 'calc(100vh - 230px)' }}>
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
            <span className="font-semibold">사건 {filtered.length}건</span>
            <span className="ml-auto text-gray-600">정렬</span>
            <select className="input w-auto py-0.5 text-xs" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="occurred">발생 시각</option>
              <option value="published">게시 시각</option>
              <option value="reliability">신뢰도</option>
            </select>
          </div>
          <div className={`min-h-0 overflow-y-auto ${sel ? 'h-[30%] shrink-0 border-b' : 'flex-1'}`}>
            {!data && !loadErr && <div className="p-4 text-gray-500">불러오는 중...</div>}
            {data && data.status.run_count === 0 && data.events.length === 0 && (
              <div className="p-6 text-center text-gray-600">아직 수집된 데이터가 없습니다.<br /><Link className="btn btn-primary mt-3" href="/settings">데이터·설정에서 지금 수집</Link></div>
            )}
            {data && filtered.length === 0 && !(data.status.run_count === 0 && data.events.length === 0) && (
              <div className="p-6 text-center text-gray-600">조건에 맞는 사건이 없습니다. 필터를 바꾸거나 데이터·설정에서 &apos;지금 수집&apos;을 실행하세요<br /><Link className="btn mt-3" href="/settings">데이터·설정으로 이동</Link></div>
            )}
            <ul>{filtered.map((e) => <Row key={e.id} e={e} />)}</ul>
          </div>
          {sel && (
            <div className="min-h-0 flex-1">
              <EventDetail
                id={sel}
                aiAvailable={!!st?.ai_available}
                aiReason={st?.ai_reason ?? null}
                onClose={() => select(null)}
                onChanged={load}
                onOpenEvent={(id) => select(id)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
