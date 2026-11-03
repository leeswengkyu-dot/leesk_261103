'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { fmtKst } from '@/lib/time';
import { ACCURACY, EVENT_TYPES, REGIONS, LABELS, LABEL_KEYS, CHANGE_TYPES } from '@/lib/types';
import { alertText } from '@/lib/rules/labels';
import { googleEarthUrl } from '@/lib/earth';
import { AlertBadges, ChangeBadge, Chip, LabelBadge, RelBadge } from './Badges';

/* eslint-disable @typescript-eslint/no-explicit-any */
type D = any;

interface Props {
  id: string;
  aiAvailable: boolean;
  aiReason: string | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenEvent: (id: string) => void;
}

const actorKey = 'argus_actor';

export default function EventDetail({ id, aiAvailable, aiReason, onClose, onChanged, onOpenEvent }: Props) {
  const [d, setD] = useState<D | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Record<string, any>>({});
  const [actor, setActor] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // statement id | 'new'
  const [draft, setDraft] = useState<{ text: string; label: string; article_ids: string[] }>({ text: '', label: 'unverified', article_ids: [] });

  useEffect(() => {
    try {
      setActor(localStorage.getItem(actorKey) || '');
    } catch {}
  }, []);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api<D>(`/api/events/${id}`);
      setD(r);
      const e = r.event;
      setF({
        title: e.title ?? '',
        region: e.region,
        location_name: e.location_name ?? '',
        lat: e.lat ?? '',
        lng: e.lng ?? '',
        location_accuracy: e.location_accuracy,
        area_radius_km: e.area_radius_km ?? '',
        event_type: e.event_type,
        change_type: e.change_type,
        memo: e.memo ?? '',
        conflict_note: e.conflict_note ?? '',
        content_conflict: !!e.content_conflict,
        updated_at: e.updated_at,
      });
      setConfirmed(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setD(null);
    setEditing(null);
    setMsg(null);
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message + (e instanceof ApiError && e.status >= 500 ? ' [다시 시도]' : ''));
    } finally {
      setBusy(false);
    }
  };

  if (err && !d)
    return (
      <div className="p-4">
        <div className="rounded bg-red-50 p-3 text-red-800">{err}</div>
        <button className="btn mt-2" onClick={load}>다시 시도</button>
        <button className="btn ml-2 mt-2" onClick={onClose}>닫기</button>
      </div>
    );
  if (!d) return <div className="p-4 text-gray-500">불러오는 중...</div>;

  const e = d.event;
  const arts: any[] = d.articles;
  const artNo = (aid: string) => arts.findIndex((a) => a.id === aid) + 1;
  const readOnly = e.review_status === 'merged' || e.review_status === 'rejected';
  const aiFailed = arts.some((a) => a.ai_status === 'failed');
  const pts = arts.filter((a) => a.extracted_lat != null);

  const saveFields = () =>
    act(
      () =>
        api(`/api/events/${id}`, {
          method: 'PATCH',
          body: {
            title: f.title,
            region: f.region,
            location_name: f.location_name,
            lat: f.lat,
            lng: f.lng,
            location_accuracy: f.location_accuracy,
            area_radius_km: f.area_radius_km,
            event_type: f.event_type,
            change_type: f.change_type,
            memo: f.memo,
            conflict_note: f.conflict_note,
            content_conflict: f.content_conflict,
            expected_updated_at: f.updated_at,
          },
        }),
      '저장했습니다',
    );

  const saveStatement = () =>
    act(
      () =>
        api('/api/statements', {
          method: 'POST',
          body: { op: editing === 'new' ? 'create' : 'update', id: editing === 'new' ? undefined : editing, event_id: id, ...draft, actor },
        }).then(() => setEditing(null)),
      '문장을 저장했습니다',
    );

  const srcChecks = (
    <div className="mt-1 flex flex-wrap gap-2 text-xs">
      {arts.map((a, i) => (
        <label key={a.id} className="flex items-center gap-1 rounded border px-1.5 py-0.5">
          <input
            type="checkbox"
            checked={draft.article_ids.includes(a.id)}
            onChange={(ev) => setDraft((p) => ({ ...p, article_ids: ev.target.checked ? [...p.article_ids, a.id] : p.article_ids.filter((x) => x !== a.id) }))}
          />
          [{i + 1}] {a.source_name}({a.source_grade}){a.is_party_claim ? ' · 당사자' : ''}
        </label>
      ))}
    </div>
  );

  const statementEditor = (
    <div className="mt-2 space-y-2 rounded border border-blue-300 bg-blue-50 p-2">
      <textarea className="input" rows={3} value={draft.text} onChange={(ev) => setDraft({ ...draft, text: ev.target.value })} placeholder="주체(누가 발표·보도·평가했는지)를 밝혀 쓰세요" />
      <div className="flex items-center gap-2">
        <span className="text-xs">라벨</span>
        <select className="input w-auto" value={draft.label} onChange={(ev) => setDraft({ ...draft, label: ev.target.value })}>
          {LABEL_KEYS.map((k) => (
            <option key={k} value={k}>[{LABELS[k].name}]</option>
          ))}
        </select>
      </div>
      <div className="text-xs text-gray-600">근거 출처 (1개 이상 필요, 없으면 [미확인])</div>
      {srcChecks}
      <div className="flex gap-2">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={saveStatement}>저장</button>
        <button className="btn btn-sm" onClick={() => setEditing(null)}>취소</button>
      </div>
    </div>
  );

  const field = (label: string, el: React.ReactNode) => (
    <label className="block text-xs text-gray-600">
      {label}
      <div className="mt-0.5 text-sm text-gray-900">{el}</div>
    </label>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <div className="flex items-start gap-2 border-b p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <Chip tone={e.review_status === 'reviewed' ? 'blue' : 'gray'}>{e.review_status === 'reviewed' ? '검토 완료' : e.review_status === 'collected' ? '수집함' : e.review_status === 'rejected' ? '기각됨' : '병합됨'}</Chip>
            <RelBadge level={e.reliability} />
            <ChangeBadge type={e.change_type} />
            <AlertBadges reasons={e.alert_reasons} />
            {e.location_conflict ? <Chip tone="red">위치 충돌</Chip> : null}
            {e.content_conflict ? <Chip tone="red">내용 충돌</Chip> : null}
          </div>
          <input className="input mt-2 text-base font-bold" value={f.title} disabled={readOnly} onChange={(ev) => setF({ ...f, title: ev.target.value })} />
          {e.title_ko && e.title_ko !== e.title && <div className="mt-1 text-sm text-blue-900"><span className="mr-1 rounded bg-blue-100 px-1 text-[10px] font-bold">한글</span>{e.title_ko}</div>}
          <div className="mt-1 text-xs text-gray-700">출처: {Array.from(new Set(d.articles.map((a: any) => `${a.source_name}(${a.source_grade})`))).join(' · ')}</div>
        </div>
        <button className="btn btn-sm" onClick={onClose} aria-label="닫기">✕</button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {err && (
          <div className="rounded bg-red-50 p-2 text-sm text-red-800">
            {err}
            {err.includes('먼저 수정') && <button className="btn btn-sm ml-2" onClick={load}>새로 불러오기</button>}
          </div>
        )}
        {msg && <div className="rounded bg-green-50 p-2 text-sm text-green-800">{msg}</div>}
        {aiFailed && <div className="rounded bg-amber-50 p-2 text-sm text-amber-900">AI 요약 실패 — 직접 작성하거나 다시 시도하세요.</div>}
        {readOnly && e.merged_into && (
          <div className="rounded bg-gray-100 p-2 text-sm">이 사건은 다른 사건에 병합되었습니다. <button className="underline" onClick={() => onOpenEvent(e.merged_into)}>대표 사건 보기</button></div>
        )}

        {/* 기본 정보 */}
        <section className="grid grid-cols-2 gap-3">
          {field('지역', <select className="input" disabled={readOnly} value={f.region} onChange={(ev) => setF({ ...f, region: ev.target.value })}>{Object.entries(REGIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>)}
          {field('사건 유형', <select className="input" disabled={readOnly} value={f.event_type} onChange={(ev) => setF({ ...f, event_type: ev.target.value })}>{Object.entries(EVENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.name}</option>)}</select>)}
          {field('위치명', <input className="input" disabled={readOnly} value={f.location_name} onChange={(ev) => setF({ ...f, location_name: ev.target.value })} />)}
          {field('위치 정확도', <select className="input" disabled={readOnly} value={f.location_accuracy} onChange={(ev) => setF({ ...f, location_accuracy: ev.target.value })}>{Object.entries(ACCURACY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>)}
          {field('위도', <input className="input" disabled={readOnly} value={f.lat} onChange={(ev) => setF({ ...f, lat: ev.target.value })} />)}
          {field('경도', <input className="input" disabled={readOnly} value={f.lng} onChange={(ev) => setF({ ...f, lng: ev.target.value })} />)}
          {f.location_accuracy === 'area' && field('"일대" 반경(km)', <input className="input" disabled={readOnly} value={f.area_radius_km} onChange={(ev) => setF({ ...f, area_radius_km: ev.target.value })} />)}
          {field('변화 구분', <select className="input" disabled={readOnly} value={f.change_type} onChange={(ev) => setF({ ...f, change_type: ev.target.value })}>{Object.entries(CHANGE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>)}
          {field('발생 시각(KST)', e.occurred_at ? fmtKst(e.occurred_at) : '발생 시각 미상(게시 시각 기준)')}
          {field('최초 게시 시각(KST)', fmtKst(e.first_published_at))}
        </section>
        {e.coord_origin === 'ai_estimated' && e.lat != null && <div className="rounded bg-amber-50 p-2 text-xs text-amber-900">AI 추정 위치 — 확인 필요 (좌표를 직접 고치면 &quot;사람 확인&quot;으로 바뀝니다)</div>}
        {e.coord_origin === 'gazetteer' && e.lat != null && <div className="rounded bg-amber-50 p-2 text-xs text-amber-900">지명 사전 기반 추정 위치(&quot;{e.location_name}&quot; 일대 대표 좌표) — 기사 속 지명으로 자동 부여했으므로 확인 필요 (좌표를 직접 고치면 &quot;사람 확인&quot;으로 바뀝니다)</div>}
        {e.lat != null && e.lng != null && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <a className="btn btn-sm" href={googleEarthUrl(Number(e.lat), Number(e.lng), { accuracy: e.location_accuracy, radiusKm: e.area_radius_km })} target="_blank" rel="noopener noreferrer" title="구글어스 위성사진에서 이 위치 보기 (새 탭)">구글어스에서 보기 ↗</a>
            <button className="btn btn-sm" title="구글어스 프로(데스크톱)에서 열 수 있는 이 사건의 KML 파일" onClick={async () => {
              try {
                const res = await fetch('/api/export-kml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], title: `ARGUS-K ${e.title}` }) });
                if (!res.ok) throw new Error('KML 을 만들지 못했습니다');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(await res.blob());
                a.download = `ARGUS-K_${String(e.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 40)}.kml`;
                a.click();
                URL.revokeObjectURL(a.href);
              } catch (er) {
                setErr((er as Error).message);
              }
            }}>KML 받기 (구글어스 프로)</button>
            <span className="text-gray-500">저장된 좌표({e.lat}, {e.lng}) 기준 · 위성사진으로 위치 확인</span>
          </div>
        )}
        <div className="text-xs text-gray-600">신뢰도 근거: {d.reliability_basis}{e.alert_reasons.length ? ` · 경보 사유: ${e.alert_reasons.map(alertText).join(', ')}` : ''}</div>
        <label className="block text-xs text-gray-600">메모 (공개정보 수준만)
          <textarea className="input mt-0.5" rows={2} disabled={readOnly} value={f.memo} onChange={(ev) => setF({ ...f, memo: ev.target.value })} />
        </label>
        {!readOnly && <button className="btn btn-primary btn-sm" disabled={busy} onClick={saveFields}>정보 저장</button>}

        {/* 요약 문장 */}
        <section>
          <div className="mb-1 flex items-center gap-2">
            <h3 className="font-bold">요약 문장 (라벨 · 출처)</h3>
            {!readOnly && (
              <>
                <button className="btn btn-sm" disabled={busy} onClick={() => { setEditing('new'); setDraft({ text: '', label: 'unverified', article_ids: arts.map((a) => a.id).slice(0, 1) }); }}>+ 직접 작성</button>
                <button className="btn btn-sm" disabled={busy || !aiAvailable} title={aiAvailable ? '' : aiReason ?? ''} onClick={() => act(() => api(`/api/events/${id}`, { method: 'POST', body: { action: 'ai_summary' } }), 'AI 요약을 추가했습니다 (모두 검토 전 상태)')}>AI 요약 생성</button>
              </>
            )}
          </div>
          {!aiAvailable && <div className="mb-1 text-xs text-gray-500">AI 사용 불가: {aiReason}</div>}
          {d.statements.length === 0 && editing !== 'new' && (
            <div className="rounded bg-gray-50 p-3 text-sm text-gray-600">
              요약이 없습니다. [AI 요약 생성] 또는 [직접 작성]을 쓰거나, 아래 버튼으로 기사 제목을 요약 문장으로 가져오세요.
              {!readOnly && arts.length > 0 && (
                <div className="mt-2">
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() =>
                      act(
                        () =>
                          Promise.all(
                            arts.map((a) =>
                              api('/api/statements', {
                                method: 'POST',
                                body: {
                                  op: 'create',
                                  event_id: id,
                                  text: `${a.source_name} 보도: ${a.title_ko && a.title_ko !== a.title ? a.title_ko : a.title}`,
                                  label: a.is_party_claim ? 'party_claim' : 'unverified',
                                  article_ids: [a.id],
                                  actor,
                                },
                              }),
                            ),
                          ),
                        '기사 제목을 요약 문장으로 추가했습니다 (라벨은 [미확인]/[당사자 주장]). 내용을 확인하고 수정하세요',
                      )
                    }
                  >
                    기사 제목으로 요약 문장 만들기
                  </button>
                </div>
              )}
            </div>
          )}
          <ul className="space-y-2">
            {d.statements.map((s: any) => (
              <li key={s.id} className="rounded border p-2">
                {editing === s.id ? (
                  statementEditor
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-1">
                      <LabelBadge label={s.label} suggested={!!s.fact_suggested} />
                      {s.article_ids.length === 0 && <Chip tone="red">출처 없음</Chip>}
                      {s.article_ids.map((aid: string) => (
                        <a key={aid} href={`#art-${aid}`} className="rounded bg-blue-50 px-1 text-xs text-blue-800 underline">[{artNo(aid)}]</a>
                      ))}
                      {s.approved_by && <span className="text-xs text-gray-500">승인: {s.approved_by}</span>}
                    </div>
                    <p className="mt-1">{s.text}</p>
                    {s.warnings.map((w: string, i: number) => <div key={i} className="mt-1 text-xs text-amber-800">⚠ {w}</div>)}
                    {!readOnly && (
                      <div className="mt-1 flex gap-1">
                        {s.fact_suggested && s.label !== 'fact' && (
                          <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api('/api/statements', { method: 'POST', body: { op: 'approve', id: s.id, actor } }), '[사실]로 승인했습니다')}>[사실 제안] 승인</button>
                        )}
                        <button className="btn btn-sm" onClick={() => { setEditing(s.id); setDraft({ text: s.text, label: s.fact_suggested && s.label !== 'fact' ? 'fact' : s.label, article_ids: s.article_ids }); }}>수정</button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => confirm('이 문장을 삭제할까요?') && act(() => api('/api/statements', { method: 'POST', body: { op: 'delete', id: s.id } }))}>삭제</button>
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {editing === 'new' && statementEditor}
        </section>

        {/* 출처 표 */}
        <section>
          <h3 className="mb-1 font-bold">출처 ({arts.length})</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-left"><tr><th className="p-1">번호</th><th>출처</th><th>등급</th><th>당사자</th><th>게시(KST)</th><th>추출 위치</th></tr></thead>
              <tbody>
                {arts.map((a, i) => (
                  <tr key={a.id} id={`art-${a.id}`} className="border-t align-top">
                    <td className="p-1">[{i + 1}]</td>
                    <td><a className="text-blue-700 underline" href={a.url} target="_blank" rel="noreferrer">{a.source_name}</a><div className="max-w-[18rem] text-gray-700">{a.title}</div>{a.title_ko && a.title_ko !== a.title && <div className="max-w-[18rem] text-blue-900">{a.title_ko}</div>}</td>
                    <td>{a.source_grade}</td>
                    <td>{a.is_party_claim ? '예' : '-'}</td>
                    <td>{fmtKst(a.published_at)}</td>
                    <td>{a.extracted_location_name ?? '-'}{a.extracted_lat != null ? ` (${a.extracted_lat}, ${a.extracted_lng})` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 충돌 */}
        {(e.location_conflict || e.content_conflict || !readOnly) && (
          <section>
            <h3 className="mb-1 font-bold">출처 충돌</h3>
            {e.location_conflict ? (
              <div className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-xs">
                <b>위치 충돌</b> — 출처 간 좌표 최대 거리 {d.max_distance_km}km (25km 초과). 지도에 모든 좌표를 포함하는 원이 표시됩니다.
                <ul className="mt-1">{pts.map((a) => <li key={a.id}>[{artNo(a.id)}] {a.source_name}: {a.extracted_location_name ?? '-'} ({a.extracted_lat}, {a.extracted_lng})</li>)}</ul>
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" disabled={readOnly} checked={f.content_conflict} onChange={(ev) => setF({ ...f, content_conflict: ev.target.checked })} />
              내용 충돌 표시 (시각·수량·장소·주체가 출처마다 다름)
            </label>
            {f.content_conflict && <textarea className="input mt-1" rows={2} placeholder="항목별 차이 (예: 발사 수량 — A매체 1발 / B매체 2발)" value={f.conflict_note} disabled={readOnly} onChange={(ev) => setF({ ...f, conflict_note: ev.target.value })} />}
            {!readOnly && (
              <div className="mt-1 flex gap-2">
                <button className="btn btn-sm" disabled={busy} onClick={saveFields}>충돌 표시 저장</button>
                <button className="btn btn-sm" disabled={busy || !aiAvailable} title={aiAvailable ? '' : aiReason ?? ''} onClick={() => act(async () => {
                  const r = await api<{ suggestion: { content_conflict: boolean; conflict_items: { item: string; detail: string }[]; change_type?: string | null } }>(`/api/events/${id}`, { method: 'POST', body: { action: 'ai_conflict' } });
                  const s = r.suggestion;
                  setMsg(`AI 제안(확정 아님): 내용 충돌 ${s.content_conflict ? '있음' : '없음'}${s.conflict_items.length ? ' — ' + s.conflict_items.map((x) => `${x.item}: ${x.detail}`).join('; ') : ''}${s.change_type ? ` / 변화 구분 제안: ${CHANGE_TYPES[s.change_type]}` : ''}`);
                })}>AI 충돌·변화 제안</button>
              </div>
            )}
          </section>
        )}

        {/* 중복 후보 */}
        {d.duplicates.length > 0 && (
          <section>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h3 className="font-bold">중복 후보 ({d.duplicates.filter((x: any) => x.status === 'suggested' && x.ai_verdict !== 'different').length})</h3>
              {(() => {
                const sg = d.duplicates.filter((x: any) => x.status === 'suggested');
                const cnt = (v: string) => sg.filter((x: any) => x.ai_verdict === v).length;
                const judged = sg.filter((x: any) => x.ai_verdict).length;
                return judged > 0 ? (
                  <span className="text-xs text-gray-600">AI 1차 판단: 같은 사건 <b className="text-red-700">{cnt('same')}</b> · 불확실 {cnt('unsure')} · 별개 {cnt('different')}{judged < sg.length ? ` · 미판단 ${sg.length - judged}` : ''}</span>
                ) : null;
              })()}
              {!readOnly && d.duplicates.some((x: any) => x.status === 'suggested') && (
                <button className="btn btn-sm" disabled={busy || !aiAvailable} title={aiAvailable ? '' : aiReason ?? ''} onClick={() => act(async () => {
                  const r = await api<{ judged: number }>(`/api/events/${id}`, { method: 'POST', body: { action: 'ai_duplicates' } });
                  setMsg(`AI가 중복 후보 ${r.judged}건을 판단했습니다 (제안일 뿐, 확정은 직접 해주세요)`);
                })}>{d.duplicates.some((x: any) => x.ai_verdict) ? 'AI 다시 판단' : 'AI 중복 판단'}</button>
              )}
            </div>
            {(() => {
              const isDiff = (c: any) => c.status === 'suggested' && c.ai_verdict === 'different';
              const main = d.duplicates.filter((c: any) => !isDiff(c));
              const folded = d.duplicates.filter(isDiff);
              const item = (c: any) => (
                <li key={c.id} className={`rounded border p-2 text-xs ${c.status === 'suggested' && c.ai_verdict === 'same' ? 'border-red-300' : c.status === 'suggested' && c.ai_verdict === 'different' ? 'opacity-70' : ''}`}>
                    <button className="font-semibold text-blue-700 underline" onClick={() => onOpenEvent(c.other_id)}>{c.other?.title ?? c.other_id}</button>
                    <div className="text-gray-600">{fmtKst(c.other?.occurred_at ?? c.other?.first_published_at)} · {c.other?.location_name ?? '위치 미상'} · 출처 {c.other?.source_count}건 · {c.status === 'confirmed' ? '확정됨' : '제안됨'}</div>
                    {c.ai_verdict && c.status === 'suggested' && (
                      <div className={`mt-1 rounded px-2 py-1 ${c.ai_verdict === 'same' ? 'bg-red-50 text-red-800' : c.ai_verdict === 'unsure' ? 'bg-amber-50 text-amber-900' : 'bg-gray-50 text-gray-600'}`}>
                        <b>AI 판단: {c.ai_verdict === 'same' ? '같은 사건' : c.ai_verdict === 'unsure' ? '불확실' : '별개 사건'}</b>
                        {c.ai_confidence != null && <span> (확신도 {c.ai_confidence}%)</span>}
                        {c.ai_reason && <span> — {c.ai_reason}</span>}
                        <span className="text-gray-400"> · 제안일 뿐, 확정은 사람이 합니다</span>
                      </div>
                    )}
                    {c.status === 'suggested' && !readOnly && (
                      <div className="mt-1 flex gap-1">
                        <button className="btn btn-sm" disabled={busy} onClick={() => confirm('이 사건을 대표로 두고, 상대 사건의 기사를 합칩니다. 계속할까요?') && act(() => api('/api/duplicates', { method: 'POST', body: { op: 'confirm', candidate_id: c.id, representative_id: id } }), '같은 사건으로 확정했습니다 (출처 수 재계산)')}>같은 사건으로 확정 (이 사건 유지)</button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api('/api/duplicates', { method: 'POST', body: { op: 'dismiss', candidate_id: c.id } }), '별개 사건으로 처리했습니다')}>별개 사건</button>
                      </div>
                    )}
                  </li>
              );
              return (
                <>
                  {main.length > 0 ? <ul className="space-y-1">{main.map(item)}</ul> : <div className="text-xs text-gray-500">AI가 같은 사건일 수 있다고 본 후보는 없습니다.</div>}
                  {folded.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-gray-600">AI가 별개 사건으로 본 후보 {folded.length}건 (펼치기)</summary>
                      {!readOnly && (
                        <button className="btn btn-sm mt-1" disabled={busy} onClick={() => confirm(`AI가 별개로 본 후보 ${folded.length}건을 모두 "별개 사건"으로 처리할까요?`) && act(async () => {
                          for (const c of folded) await api('/api/duplicates', { method: 'POST', body: { op: 'dismiss', candidate_id: c.id } });
                        }, `${folded.length}건을 별개 사건으로 처리했습니다`)}>모두 별개 사건으로 처리</button>
                      )}
                      <ul className="mt-1 space-y-1">{folded.map(item)}</ul>
                    </details>
                  )}
                </>
              );
            })()}
          </section>
        )}
        {d.merged_children.length > 0 && <div className="text-xs text-gray-600">병합된 사건: {d.merged_children.map((m: any) => m.title).join(' / ')}</div>}

        {d.briefings.length > 0 && (
          <div className="text-xs">
            <Link className="text-blue-700 underline" href="/briefing">브리핑 {d.briefings.some((b: any) => b.status === 'draft') ? '초안' : ''}에 사용됨 →</Link>
          </div>
        )}

        {/* 검토 */}
        {!readOnly && (
          <section className="rounded border bg-gray-50 p-3">
            <h3 className="mb-1 font-bold">검토</h3>
            {e.review_status === 'reviewed' ? (
              <div className="text-sm">검토 완료: {fmtKst(e.reviewed_at)} {e.reviewed_by ? `· ${e.reviewed_by}` : ''}
                <button className="btn btn-sm ml-2" disabled={busy} onClick={() => act(() => api(`/api/events/${id}`, { method: 'POST', body: { action: 'unreview' } }), '검토를 취소했습니다')}>검토 취소</button>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="text-xs text-gray-600">검토자 이름(선택)</span>
                  <input className="input w-40" value={actor} onChange={(ev) => { setActor(ev.target.value); try { localStorage.setItem(actorKey, ev.target.value); } catch {} }} />
                </div>
                <label className="mb-2 flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={confirmed} onChange={(ev) => setConfirmed(ev.target.checked)} />
                  위치·유형·라벨·출처를 확인했습니다
                </label>
                <ReviewButton disabled={busy || !confirmed || arts.length < 1 || d.statements.length < 1} reason={arts.length < 1 ? '연결된 기사가 필요합니다' : d.statements.length < 1 ? '요약 문장이 1개 이상 필요합니다' : !confirmed ? '확인 체크가 필요합니다' : ''} onClick={() => act(() => api(`/api/events/${id}`, { method: 'POST', body: { action: 'review', reviewer: actor, confirmed: true } }), '검토 완료 처리했습니다')} />
              </>
            )}
            <div className="mt-2">
              <button className="btn btn-sm" disabled={busy} onClick={async () => {
                if (!confirm('관련 없는 사건으로 기각할까요? (목록에서 사라집니다)')) return;
                await act(() => api(`/api/events/${id}`, { method: 'POST', body: { action: 'reject' } }));
                onClose();
              }}>사건 기각 (관련 없음)</button>
            </div>
          </section>
        )}
        {e.review_status === 'rejected' && <button className="btn btn-sm" onClick={() => act(() => api(`/api/events/${id}`, { method: 'POST', body: { action: 'restore' } }))}>기각 취소</button>}
      </div>
    </div>
  );
}

function ReviewButton({ disabled, reason, onClick }: { disabled: boolean; reason: string; onClick: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <button className="btn btn-primary" disabled={disabled} onClick={onClick}>검토 완료</button>
      {disabled && reason && <span className="text-xs text-gray-600">{reason}</span>}
    </div>
  );
}
