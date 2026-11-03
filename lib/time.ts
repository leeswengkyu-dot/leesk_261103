const KST = 'Asia/Seoul';

export function nowIso(): string {
  return new Date().toISOString();
}

const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: KST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** UTC ISO → 'YYYY-MM-DD HH:mm' (KST) */
export function fmtKst(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '-';
  return fmt.format(d).replace('T', ' ');
}

/** KST 기준 날짜 'YYYY-MM-DD' */
export function kstDate(d: Date = new Date()): string {
  return fmt.format(d).slice(0, 10);
}

/** KST 기준 시(0-23) */
export function kstHour(d: Date = new Date()): number {
  return parseInt(fmt.format(d).slice(11, 13), 10) % 24;
}

/** 'YYYY-MM-DD HH:mm'(KST로 해석) 또는 ISO 8601 → UTC ISO. 실패 시 null */
export function parseTime(input?: string | null): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  let d: Date;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s) && /T/.test(s)) d = new Date(s);
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) d = new Date(s.replace(' ', 'T') + '+09:00');
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(s + 'T00:00:00+09:00');
  else d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function addHours(iso: string, h: number): string {
  return new Date(new Date(iso).getTime() + h * 3600_000).toISOString();
}
