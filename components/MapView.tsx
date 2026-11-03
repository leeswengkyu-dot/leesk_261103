'use client';

import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { REGION_VIEW } from '@/lib/geo';
import { RELIABILITY, ACCURACY, EVENT_TYPES, type EventRow } from '@/lib/types';
import { fmtKst } from '@/lib/time';

interface Props {
  events: EventRow[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  region: string;
  height?: string;
  onTileError?: () => void;
  fitAll?: boolean;
  /** 사건 ID → 목록 번호 (목록과 지도 마커 번호를 맞춘다) */
  numbers?: Record<string, number>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function Layers({ events, selectedId, onSelect, region, fitAll, numbers }: Props) {
  const map = useMap();
  const selRef = useRef(onSelect);
  selRef.current = onSelect;
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);

  // 지역 변경 시 기본 범위로 이동
  useEffect(() => {
    if (fitAll && events.length) {
      const pts = events.filter((e) => e.lat != null && e.lng != null).map((e) => [e.lat as number, e.lng as number] as [number, number]);
      if (pts.length) {
        map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 9 });
        return;
      }
    }
    const v = REGION_VIEW[region] ?? REGION_VIEW.all;
    map.setView(v.center, v.zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, map]);

  // 마커·원 다시 그리기
  useEffect(() => {
    clusterRef.current?.remove();
    overlayRef.current?.remove();
    markersRef.current.clear();
    const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 10, maxClusterRadius: 45, showCoverageOnHover: false });
    const overlay = L.layerGroup();
    // 같은 좌표에 사건이 여러 개면 마커가 겹치므로 고리 모양으로 살짝 벌려 표시 (실제 좌표는 팝업·원에 그대로)
    const groups = new Map<string, EventRow[]>();
    for (const e of events) {
      if (e.lat == null || e.lng == null || e.location_accuracy === 'unknown') continue;
      const k = `${e.lat},${e.lng}`;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    const spread = new Map<string, [number, number]>();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const r = 0.04 + 0.012 * list.length;
      list.forEach((e, i) => {
        const a = (2 * Math.PI * i) / list.length;
        spread.set(e.id, [(e.lat as number) + r * Math.sin(a), (e.lng as number) + (r * Math.cos(a)) / Math.cos(((e.lat as number) * Math.PI) / 180)]);
      });
    }
    for (const e of events) {
      if (e.lat == null || e.lng == null || e.location_accuracy === 'unknown') continue;
      const rel = RELIABILITY[e.reliability];
      const alert = e.alert_reasons.length > 0;
      const sel = e.id === selectedId;
      const num = numbers?.[e.id];
      const size = sel ? 38 : 32;
      const html = `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${rel.color};color:#fff;font:800 ${sel ? 15 : 13}px/${size - 6}px sans-serif;text-align:center;border:3px ${e.location_accuracy === 'exact' ? 'solid' : 'dashed'} ${alert ? '#dc2626' : '#fff'};box-shadow:0 0 0 ${sel ? 3 : 1}px ${sel ? '#2563eb' : 'rgba(0,0,0,.35)'};position:relative">${num ?? rel.letter}<span style="position:absolute;bottom:-7px;right:-7px;background:#fff;color:${rel.color};border:1px solid ${rel.color};border-radius:8px;font:700 10px/12px sans-serif;padding:0 3px">${rel.letter}</span>${alert ? '<span style="position:absolute;top:-9px;right:-6px;color:#dc2626;background:#fff;border-radius:8px;font-size:11px;line-height:12px;padding:0 3px;border:1px solid #dc2626">!</span>' : ''}</div>`;
      const pos = spread.get(e.id) ?? [e.lat, e.lng];
      const m = L.marker(pos as [number, number], {
        icon: L.divIcon({ html, className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        zIndexOffset: sel ? 1000 : 0,
      });
      const popup = `<div style="min-width:200px"><b>${num ? `#${num} ` : ''}${esc(e.title)}</b>${e.title_ko ? `<br/><span style="color:#1e3a8a">${esc(e.title_ko)}</span>` : ''}<br/>
        <span>${fmtKst(e.occurred_at ?? e.first_published_at)}</span><br/>
        ${EVENT_TYPES[e.event_type]?.name ?? ''} · 위치 ${ACCURACY[e.location_accuracy]}${e.location_accuracy === 'area' ? ` (반경 ${e.area_radius_km ?? ''}km)` : ''}<br/>
        신뢰도 ${rel.name} · 출처 ${e.source_count}건<br/>
        ${e.location_conflict ? '<b style="color:#b91c1c">위치 충돌</b><br/>' : ''}
        <button data-open="${e.id}" style="margin-top:6px;padding:2px 8px;border:1px solid #2563eb;color:#2563eb;border-radius:4px;background:#fff;cursor:pointer">상세 보기</button></div>`;
      m.bindPopup(popup);
      m.on('click', () => selRef.current?.(e.id));
      m.on('popupopen', (ev) => {
        const btn = ev.popup.getElement()?.querySelector('button[data-open]');
        btn?.addEventListener('click', () => selRef.current?.(e.id));
      });
      cluster.addLayer(m);
      markersRef.current.set(e.id, m);
      if (e.location_accuracy === 'area' && e.area_radius_km) {
        L.circle([e.lat, e.lng], { radius: e.area_radius_km * 1000, color: rel.color, weight: 2, dashArray: '6 6', fillOpacity: 0.05, interactive: false }).addTo(overlay);
      }
      if (e.conflict_circle) {
        const c = e.conflict_circle;
        L.circle([c.lat, c.lng], { radius: c.radiusKm * 1000, color: '#dc2626', weight: 2, dashArray: '2 6', fillOpacity: 0.06, interactive: false }).addTo(overlay);
      }
    }
    cluster.addTo(map);
    overlay.addTo(map);
    clusterRef.current = cluster;
    overlayRef.current = overlay;
    return () => {
      cluster.remove();
      overlay.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, selectedId, map, numbers]);

  // 목록에서 선택 → 지도 이동
  useEffect(() => {
    if (!selectedId) return;
    const m = markersRef.current.get(selectedId);
    if (!m) return;
    const ll = m.getLatLng();
    map.setView(ll, Math.max(map.getZoom(), 7), { animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, map]);

  return null;
}

export default function MapView(props: Props) {
  const v = REGION_VIEW[props.region] ?? REGION_VIEW.all;
  return (
    <MapContainer center={v.center} zoom={v.zoom} minZoom={3} maxZoom={12} scrollWheelZoom style={{ height: props.height ?? '100%', width: '100%' }}>
      <TileLayer
        attribution="© OpenStreetMap contributors © CARTO"
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxNativeZoom={12}
        maxZoom={12}
        eventHandlers={{ tileerror: () => props.onTileError?.() }}
      />
      <Layers {...props} />
    </MapContainer>
  );
}
