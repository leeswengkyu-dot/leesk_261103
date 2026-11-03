'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fmtKst } from '@/lib/time';
import { api, getPin, setPin } from '@/lib/client/api';

export default function TopBar() {
  const path = usePathname();
  const sp = useSearchParams();
  const [now, setNow] = useState('');
  const [mode, setMode] = useState<'local' | 'lan' | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [boardQuery, setBoardQuery] = useState('');
  const [present, setPresent] = useState(false);

  useEffect(() => {
    const tick = () => setNow(fmtKst(new Date().toISOString()));
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api<{ mode: 'local' | 'lan' }>('/api/mode').then((r) => setMode(r.mode)).catch(() => {});
    const upd = () => setHasPin(!!getPin());
    upd();
    window.addEventListener('argus-pin', upd);
    return () => window.removeEventListener('argus-pin', upd);
  }, []);

  // 탭 이동 시 상황판 필터 유지 (URL 쿼리스트링)
  useEffect(() => {
    if (path === '/') {
      const q = sp.toString();
      try {
        sessionStorage.setItem('argus_board_q', q);
      } catch {}
      setBoardQuery(q);
    } else {
      try {
        setBoardQuery(sessionStorage.getItem('argus_board_q') || '');
      } catch {}
    }
  }, [path, sp]);

  useEffect(() => {
    const h = () => setPresent(!!document.fullscreenElement && path === '/briefing');
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, [path]);

  if (present) return null;

  const tab = (href: string, label: string, active: boolean) => (
    <Link href={href} className={`rounded px-3 py-1.5 text-sm font-semibold ${active ? 'bg-white text-slate-900' : 'text-slate-200 hover:bg-slate-700'}`}>
      {label}
    </Link>
  );

  return (
    <header className="no-print">
      <div className="flex flex-wrap items-center gap-3 bg-slate-900 px-4 py-2 text-white">
        <Link href="/" className="text-lg font-extrabold tracking-wide">
          ARGUS-K
        </Link>
        <nav className="flex gap-1">
          {tab(boardQuery ? `/?${boardQuery}` : '/', '상황판', path === '/')}
          {tab('/briefing', '브리핑', path === '/briefing')}
          {tab('/settings', '데이터·설정', path === '/settings')}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span>{now} KST</span>
          {mode && (
            <span className={`rounded px-2 py-0.5 font-semibold ${mode === 'lan' ? 'bg-amber-400 text-slate-900' : 'bg-slate-700'}`}>
              {mode === 'lan' ? '내부망 공유 모드' : '로컬 모드'}
            </span>
          )}
          {mode === 'lan' && (
            <button
              className="rounded border border-slate-500 px-2 py-0.5 hover:bg-slate-700"
              onClick={() => {
                if (hasPin) {
                  setPin('');
                  window.dispatchEvent(new Event('argus-pin'));
                } else {
                  const p = window.prompt('공유 PIN을 입력하세요');
                  if (p) {
                    setPin(p.trim());
                    window.dispatchEvent(new Event('argus-pin'));
                  }
                }
              }}
            >
              PIN: {hasPin ? '입력됨 (해제)' : '미입력'}
            </button>
          )}
        </div>
      </div>
      {mode === 'lan' && <div className="bg-amber-100 px-4 py-1 text-xs font-semibold text-amber-900">내부망 공유 모드 — 같은 네트워크에서 접속 가능합니다. 쓰기 작업에는 공유 PIN이 필요합니다.</div>}
      <div className="border-b border-amber-300 bg-amber-50 px-4 py-1 text-xs text-amber-900">
        공개정보 기반 분석지원 도구입니다. AI 결과는 반드시 검토하고, 최종 판단은 사람이 합니다. 사건 정보는 요약을 위해 외부 AI 서비스로 전송되므로 비공개 업무 내용을 입력하지 마십시오.
      </div>
    </header>
  );
}
