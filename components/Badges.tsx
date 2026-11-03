import { LABELS, RELIABILITY, CHANGE_TYPES } from '@/lib/types';
import { alertText } from '@/lib/rules/labels';

export function LabelBadge({ label, suggested }: { label: string; suggested?: boolean }) {
  if (suggested && label !== 'fact') {
    return <span className="inline-block rounded border border-green-400 border-dashed bg-green-50 px-1.5 py-0.5 text-xs font-semibold text-green-900">사실 제안</span>;
  }
  const l = LABELS[label] ?? LABELS.unverified;
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold ${l.cls}`}>{l.name}</span>;
}

export function RelBadge({ level }: { level: string }) {
  const r = RELIABILITY[level] ?? RELIABILITY.low;
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold" style={{ borderColor: r.color, color: r.color }}>
      <b>{r.letter}</b>
      {r.name}
    </span>
  );
}

export function AlertBadges({ reasons }: { reasons: string[] }) {
  return (
    <>
      {reasons.map((r) => (
        <span key={r} className="inline-block rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">
          ! {alertText(r)}
        </span>
      ))}
    </>
  );
}

export function ChangeBadge({ type }: { type: string }) {
  const cls: Record<string, string> = { new: 'bg-sky-100 text-sky-900', continuing: 'bg-gray-100 text-gray-800', escalated: 'bg-orange-100 text-orange-900', ended: 'bg-slate-200 text-slate-800' };
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${cls[type] ?? cls.continuing}`}>{CHANGE_TYPES[type] ?? type}</span>;
}

export function Chip({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'gray' | 'red' | 'amber' | 'blue' }) {
  const t = { gray: 'bg-gray-100 text-gray-800', red: 'bg-red-100 text-red-900', amber: 'bg-amber-100 text-amber-900', blue: 'bg-blue-100 text-blue-900' }[tone];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}
