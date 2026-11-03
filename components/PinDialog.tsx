'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { setPin } from '@/lib/client/api';

type PinRequest = { message?: string; resolve: (pin: string | null) => void };

/**
 * 화면 안 PIN 입력창. requestPin() 이 보내는 'argus-pin-request' 이벤트를 받아 열리고,
 * 서버(/api/mode)로 PIN 을 먼저 확인한 뒤에만 저장한다 (틀리면 창 안에서 바로 알려줌).
 */
export default function PinDialog() {
  const [req, setReq] = useState<PinRequest | null>(null);
  const [val, setVal] = useState('');
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const w = window as unknown as { __argusPinDialog?: boolean };
    w.__argusPinDialog = true;
    const onRequest = (ev: Event) => {
      const detail = (ev as CustomEvent<PinRequest>).detail;
      setReq((prev) => {
        prev?.resolve(null);
        return detail;
      });
      setVal('');
      setErr(null);
    };
    window.addEventListener('argus-pin-request', onRequest);
    return () => {
      w.__argusPinDialog = false;
      window.removeEventListener('argus-pin-request', onRequest);
    };
  }, []);

  useEffect(() => {
    if (req) setTimeout(() => inputRef.current?.focus(), 0);
  }, [req]);

  if (!req) return null;

  const close = (pin: string | null) => {
    req.resolve(pin);
    setReq(null);
    setVal('');
    setErr(null);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const p = val.trim();
    if (!p) {
      setErr('PIN을 입력하세요');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/mode', { method: 'POST', headers: { 'x-edit-pin': p }, cache: 'no-store' });
      if (res.ok) {
        setPin(p, remember);
        window.dispatchEvent(new Event('argus-pin'));
        close(p);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error || (res.status === 429 ? '10분 후 다시 시도하세요' : 'PIN이 올바르지 않습니다'));
        setVal('');
        inputRef.current?.focus();
      }
    } catch {
      setErr('서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/40 no-print"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(null);
      }}
    >
      <form onSubmit={submit} className="w-80 rounded-lg bg-white p-4 text-slate-900 shadow-xl" role="dialog" aria-label="공유 PIN 입력">
        <h2 className="text-base font-bold">공유 PIN 입력</h2>
        <p className="mt-1 text-xs text-gray-600">{req.message || '수집·편집·검토 같은 쓰기 작업에 필요합니다.'}</p>
        <input
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          className="input mt-3 w-full text-lg tracking-widest"
          value={val}
          placeholder="PIN"
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close(null);
          }}
        />
        {err && <div className="mt-2 text-xs font-semibold text-red-700">{err}</div>}
        <label className="mt-2 flex items-center gap-1 text-xs text-gray-700">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          이 브라우저에서 기억하기 (공용 PC에서는 끄세요)
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn btn-sm" onClick={() => close(null)}>
            취소
          </button>
          <button type="submit" className="btn btn-sm border-blue-600 bg-blue-600 text-white" disabled={busy}>
            {busy ? '확인 중…' : '확인'}
          </button>
        </div>
      </form>
    </div>
  );
}
