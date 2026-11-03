import { read, body } from '@/lib/api';
import { listEventRows } from '@/lib/events';
import { buildKml } from '@/lib/csv-kml';

export const dynamic = 'force-dynamic';

/** 현재 필터 결과(사건 ID 목록) 중 좌표가 있는 사건을 KML 로 내보낸다 (FR-X-01) */
export const POST = read(async (req) => {
  const b = await body<{ ids: string[]; title?: string }>(req);
  const set = new Set(b.ids ?? []);
  const rows = (await listEventRows()).filter((e) => set.has(e.id));
  const kml = await buildKml(rows, b.title ?? 'ARGUS-K');
  return new Response(kml, { headers: { 'Content-Type': 'application/vnd.google-earth.kml+xml; charset=utf-8' } });
});
