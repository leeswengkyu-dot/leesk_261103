'use client';

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Record<string, unknown>) {
    super(message);
  }
}

const KEY = 'argus_pin';
export const getPin = () => {
  try {
    return sessionStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
};
export const setPin = (p: string) => {
  try {
    if (p) sessionStorage.setItem(KEY, p);
    else sessionStorage.removeItem(KEY);
  } catch {}
};

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
    const p = window.prompt('공유 PIN을 입력하세요 (쓰기 작업에 필요합니다)');
    if (p) {
      setPin(p.trim());
      window.dispatchEvent(new Event('argus-pin'));
      res = await once(url, method, opts.body, opts.form);
    }
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
