import Papa from 'papaparse';
import { db, inTx } from './db';
import { parseTime } from './time';
import { EVENT_TYPES, LABELS, RELIABILITY, REGIONS, type EventRow } from './types';
import { insertEvent } from './ingest';
import { articlesOf, defaultChangeType, findDuplicateCandidates, recomputeEvent, saveStatement, getEventDetail } from './events';
import { uuid } from './db';
import { normalizeUrl } from './collect';
import { nowIso } from './time';
import { defaultAreaRadius } from './geo';
import { fmtKst } from './time';

export interface CsvError {
  row: number;
  column: string;
  reason: string;
}
export interface CsvResult {
  total_rows: number;
  imported_rows: number;
  events: number;
  skipped_duplicates: number;
  errors: CsvError[];
}

const REQUIRED = ['event_key', 'title', 'region', 'occurred_at', 'event_type', 'source_name', 'source_grade', 'url', 'published_at'];

interface Row {
  rowNo: number;
  r: Record<string, string>;
  occurred: string;
  published: string;
}

export async function importCsv(text: string): Promise<CsvResult> {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const res: CsvResult = { total_rows: parsed.data.length, imported_rows: 0, events: 0, skipped_duplicates: 0, errors: [] };
  const header = parsed.meta.fields ?? [];
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    res.errors.push({ row: 1, column: missing.join(', '), reason: '필수 컬럼이 없습니다' });
    return res;
  }
  const d = db();
  const groups = new Map<string, Row[]>();
  parsed.data.forEach((raw, i) => {
    const rowNo = i + 2; // 헤더가 1행
    const r: Record<string, string> = {};
    for (const k of Object.keys(raw)) r[k] = (raw[k] ?? '').toString().trim();
    const err = (column: string, reason: string) => res.errors.push({ row: rowNo, column, reason });
    let bad = false;
    for (const c of REQUIRED) if (!r[c]) { err(c, '필수 값이 비어 있습니다'); bad = true; }
    if (bad) return;
    if (!['nk', 'me', 'ru_ua'].includes(r.region)) { err('region', 'nk/me/ru_ua 중 하나여야 합니다'); bad = true; }
    if (!EVENT_TYPES[r.event_type]) { err('event_type', '알 수 없는 사건 유형 코드입니다'); bad = true; }
    if (!['A', 'B', 'C', 'D'].includes(r.source_grade)) { err('source_grade', 'A/B/C/D 중 하나여야 합니다'); bad = true; }
    if (!/^https?:\/\/\S+$/i.test(r.url)) { err('url', 'http(s) URL 형식이 아닙니다'); bad = true; }
    const occurred = parseTime(r.occurred_at);
    const published = parseTime(r.published_at);
    if (!occurred) { err('occurred_at', '날짜 형식이 올바르지 않습니다 (ISO 8601 또는 YYYY-MM-DD HH:mm)'); bad = true; }
    if (!published) { err('published_at', '날짜 형식이 올바르지 않습니다'); bad = true; }
    if (r.lat || r.lng) {
      const la = Number(r.lat), ln = Number(r.lng);
      if (!isFinite(la) || !isFinite(ln) || r.lat === '' || r.lng === '' || Math.abs(la) > 90 || Math.abs(ln) > 180) { err('lat/lng', '십진수 좌표가 올바르지 않습니다'); bad = true; }
    }
    if (r.location_accuracy && !['exact', 'area', 'unknown'].includes(r.location_accuracy)) { err('location_accuracy', 'exact/area/unknown 중 하나여야 합니다'); bad = true; }
    if (r.area_radius_km && !isFinite(Number(r.area_radius_km))) { err('area_radius_km', '숫자가 아닙니다'); bad = true; }
    if (r.is_party_claim && !['true', 'false'].includes(r.is_party_claim.toLowerCase())) { err('is_party_claim', 'true/false 중 하나여야 합니다'); bad = true; }
    if (bad) return;
    const l = groups.get(r.event_key) ?? [];
    l.push({ rowNo, r, occurred: occurred as string, published: published as string });
    groups.set(r.event_key, l);
  });

  for (const rows of groups.values()) {
    await inTx(async () => {
      const fresh: Row[] = [];
      for (const x of rows) if (!(await d.prepare('SELECT 1 FROM articles WHERE url=?').get(normalizeUrl(x.r.url)))) fresh.push(x);
      res.skipped_duplicates += rows.length - fresh.length;
      if (!fresh.length) return;
      fresh.sort((a, b) => a.published.localeCompare(b.published));
      const f = fresh[0].r;
      const withCoord = fresh.find((x) => x.r.lat && x.r.lng)?.r;
      const acc = (withCoord?.location_accuracy || (withCoord ? 'exact' : 'unknown')) as 'exact' | 'area' | 'unknown';
      const hasSummary = fresh.some((x) => x.r.summary_statements);
      const evId = await insertEvent({
        title: f.title.slice(0, 300),
        region: f.region,
        country: f.country || null,
        location_name: f.location_name || withCoord?.location_name || null,
        lat: withCoord ? Number(withCoord.lat) : null,
        lng: withCoord ? Number(withCoord.lng) : null,
        coord_origin: 'csv',
        location_accuracy: withCoord ? acc : 'unknown',
        area_radius_km: acc === 'area' ? Number(withCoord?.area_radius_km || 0) || defaultAreaRadius(withCoord?.location_name) : null,
        occurred_at: fresh[0].occurred,
        event_type: f.event_type,
        summary_origin: hasSummary ? 'pre_generated' : 'none',
        first_published_at: fresh[0].published,
      });
      const insA = d.prepare(
        `INSERT INTO articles (id,event_id,source_name,source_grade,is_party_claim,url,title,description,published_at,extracted_location_name,extracted_lat,extracted_lng,ai_status,fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'skipped',?)`,
      );
      for (const x of fresh) {
        await insA.run(uuid(), evId, x.r.source_name, x.r.source_grade, x.r.is_party_claim?.toLowerCase() === 'true' ? 1 : 0, normalizeUrl(x.r.url), x.r.title, null, x.published, x.r.location_name || null, x.r.lat ? Number(x.r.lat) : null, x.r.lng ? Number(x.r.lng) : null, nowIso());
        res.imported_rows++;
      }
      res.events++;
      const arts = await articlesOf(evId);
      for (const x of fresh) {
        if (!x.r.summary_statements) continue;
        for (const item of x.r.summary_statements.split(' || ')) {
          const [label, text, urls] = item.split('::');
          if (!label || !text) continue;
          const ids = (urls ?? '').split(',').map((u) => arts.find((a) => a.url === normalizeUrl(u.trim()))?.id).filter(Boolean) as string[];
          try {
            await saveStatement({ event_id: evId, text, label: label.trim(), article_ids: ids, origin: 'pre_generated', downgrade: true });
          } catch (e) {
            res.errors.push({ row: x.rowNo, column: 'summary_statements', reason: (e as Error).message });
          }
        }
      }
      const e = (await d.prepare('SELECT * FROM events WHERE id=?').get(evId)) as never;
      await d.prepare('UPDATE events SET change_type=? WHERE id=?').run(await defaultChangeType(e), evId);
      await recomputeEvent(evId);
      await findDuplicateCandidates(evId);
    });
  }
  return res;
}

/* ───────────── KML ───────────── */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function buildKml(rows: EventRow[], title: string): Promise<string> {
  const pm = (await Promise.all(rows
    .filter((e) => e.lat != null && e.lng != null)
    .map(async (e) => {
      const det = await getEventDetail(e.id);
      const lines: string[] = [];
      lines.push(`발생 시각(KST): ${fmtKst(e.occurred_at ?? e.first_published_at)}`);
      lines.push(`신뢰도: ${RELIABILITY[e.reliability].name}`);
      lines.push(`위치: ${e.location_name ?? '-'} (${e.location_accuracy === 'area' ? `일대, 반경 약 ${e.area_radius_km ?? ''}km` : e.location_accuracy === 'exact' ? '정확' : '미상'})`);
      lines.push('');
      for (const s of (det?.statements ?? []) as unknown as { label: string; text: string }[]) lines.push(`[${LABELS[s.label]?.name}] ${s.text}`);
      lines.push('');
      for (const a of det?.articles ?? []) lines.push(`출처: ${a.source_name} ${a.url}`);
      return `<Placemark><name>${esc(e.title)}</name><description>${esc(lines.join('\n'))}</description><Point><coordinates>${e.lng},${e.lat},0</coordinates></Point></Placemark>`;
    })))
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(title)}</name>\n${pm}\n</Document></kml>\n`;
}

export { REGIONS };
