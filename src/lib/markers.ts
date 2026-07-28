import type { Marker } from 'cobe';

/** Named marker sets. Pick one in the panel, or switch to custom and paste JSON. */
export const MARKER_PRESETS: Record<string, Marker[]> = {
  world: [
    { location: [14.5995, 120.9842], size: 0.03 },
    { location: [19.076, 72.8777], size: 0.1 },
    { location: [23.8103, 90.4125], size: 0.05 },
    { location: [30.0444, 31.2357], size: 0.07 },
    { location: [39.9042, 116.4074], size: 0.08 },
    { location: [-23.5505, -46.6333], size: 0.1 },
    { location: [19.4326, -99.1332], size: 0.1 },
    { location: [40.7128, -74.006], size: 0.1 },
    { location: [34.6937, 135.5022], size: 0.05 },
    { location: [41.0082, 28.9784], size: 0.06 },
  ],
  usa: [
    { location: [40.7128, -74.006], size: 0.09 },
    { location: [34.0522, -118.2437], size: 0.09 },
    { location: [41.8781, -87.6298], size: 0.07 },
    { location: [29.7604, -95.3698], size: 0.07 },
    { location: [33.749, -84.388], size: 0.08 },
    { location: [47.6062, -122.3321], size: 0.06 },
    { location: [25.7617, -80.1918], size: 0.06 },
    { location: [39.7392, -104.9903], size: 0.05 },
  ],
  atlanta: [{ location: [33.749, -84.388], size: 0.12 }],
  none: [],
};

export const MARKER_OPTIONS = [
  { value: 'world', label: 'world' },
  { value: 'usa', label: 'usa' },
  { value: 'atlanta', label: 'atlanta' },
  { value: 'none', label: 'none' },
  { value: 'custom', label: 'custom' },
];

function isMarker(value: unknown): value is Marker {
  if (!value || typeof value !== 'object') return false;
  const m = value as Marker;
  return (
    Array.isArray(m.location) &&
    m.location.length === 2 &&
    m.location.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    typeof m.size === 'number' &&
    Number.isFinite(m.size)
  );
}

/** Custom JSON is user input mid-typing, so a bad parse falls back rather than throws. */
export function parseMarkers(json: string): Marker[] | null {
  const text = (json ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const markers = parsed.filter(isMarker);
    return markers.length === parsed.length ? markers : null;
  } catch {
    return null;
  }
}

export function resolveMarkers(preset: string, custom: string, sizeScale: number): Marker[] {
  const base = preset === 'custom' ? parseMarkers(custom) ?? [] : MARKER_PRESETS[preset] ?? [];
  if (sizeScale === 1) return base;
  return base.map((m) => ({ ...m, size: m.size * sizeScale }));
}
