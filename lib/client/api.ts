'use client';

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown>) {
    super(message);
  }
}

const KEY = 'argus_pin';
/** PIN: 이 탭(sessionStorage) → "기억하기"를 켠 경우 이 브라우저(localStorage) 순으로 찾는다 */
export const getPin = () => {
  try {
    return sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
};
export const setPin = (p: string, remember = false) => {
  try {
    if (p) {
      sessionStorage.setItem(KEY, p);
      if (remember) localStorage.setItem(KEY, p);
    } else {
      sessionStorage.removeItem(KEY);
      localStorage.removeItem(KEY);
    }
  } catch {}
};

/** 화면 안 PIN 입력창(PinDialog)을 띄워 PIN 을 받는다. 입력창이 없으면 브라우저 기본 입력창을 쓴다 */
export function requestPin(message?: string): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const w = window as unknown as { __argusPinDialog?: boolean };
  if (!w.__argusPinDialog) {
    const p = window.prompt(message || '공유 PIN을 입력하세요')?.trim() || '';
    if (p) {
      setPin(p);
      window.dispatchEvent(new Event('argus-pin'));
    }
    return Promise.resolve(p || null);
  }
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent('argus-pin-request', { detail: { message, resolve } }));
  });
}

async function once(url: string, method: string, body?: unknown, isForm = false) {
  const headers: Record<string, string> = {};
  const pin = getPin();
  if (pin) headers['x-edit-pin'] = pin;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  return fetch(url, { method, headers, body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined, cache: 'no-store' });
}

/** JSON API 호출. 공유 모드에서 PIN 이 필요하면 입력을 받아 한 번 재시도한다. */
export async function api<T = Record<string, unknown>>(url: string, opts: { method?: string; body?: unknown; form?: boolean } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  let res = await once(url, method, opts.body, opts.form);
  if (res.status === 401 && method !== 'GET') {
    const p = await requestPin(getPin() ? 'PIN이 맞지 않거나 바뀌었습니다. 다시 입력하세요.' : '이 작업에는 공유 PIN이 필요합니다.');
    if (p) res = await once(url, method, opts.body, opts.form);
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok) {
    if (res.status === 401) setPin('');
    throw new ApiError((data.error as string) || `요청 실패 (${res.status})`, res.status, data);
  }
  return data as T;
}
