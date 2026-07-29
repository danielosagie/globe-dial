import type { DialConfig, ResolvedValues } from 'dialkit';
import { MARKER_OPTIONS } from './markers';
import { FORMAT_OPTIONS } from './formats';

export const FONT_OPTIONS = [
  { value: 'system-ui, -apple-system, "Helvetica Neue", sans-serif', label: 'sans' },
  { value: 'Georgia, "Times New Roman", serif', label: 'serif' },
  { value: 'ui-monospace, "SF Mono", Menlo, monospace', label: 'mono' },
];

const WEIGHT_OPTIONS = ['300', '400', '500', '600', '700', '800'];
const ALIGN_OPTIONS = ['left', 'center', 'right'];
const FPS_OPTIONS = ['24', '30', '60', '120'];
const RESOLUTION_OPTIONS = ['512', '768', '1024', '1536', '2048'];

/**
 * The whole panel. `satisfies` keeps the literal types (so number tuples stay
 * tuples) while still checking the shape, which is what lets DialValues and the
 * Remotion default props both be derived from this one object.
 */
export const DIALS = {
  stage: {
    width: [900, 320, 1920, 10],
    height: [900, 320, 1920, 10],
    scale: [2, 1, 3, 1],
    background: { type: 'color', default: '#0b0b0c' },
    transparent: false,
  },
  globe: {
    size: [560, 120, 1920, 5],
    offsetX: [0, -600, 600, 1],
    offsetY: [0, -600, 600, 1],
    resolution: { type: 'select', options: RESOLUTION_OPTIONS, default: '1024' },
    dark: [1, 0, 1, 0.01],
    diffuse: [1.2, 0, 3, 0.01],
    mapSamples: [16000, 2000, 40000, 500],
    mapBrightness: [6, 0, 20, 0.1],
    mapBaseBrightness: [0.05, 0, 1, 0.01],
    zoom: [1, 0.5, 2, 0.01],
    tilt: [0.3, -1, 1, 0.01],
    opacity: [1, 0, 1, 0.01],
  },
  color: {
    base: { type: 'color', default: '#3a3a3a' },
    marker: { type: 'color', default: '#fb6415' },
    glow: { type: 'color', default: '#0b0b0c' },
    // cobe's glow is an atmosphere that fades into the backdrop, so it only
    // looks right when it matches what sits behind the globe. Leaving these
    // out of sync is what turns the halo into a hard coloured ring.
    glowFollowsBackground: true,
  },
  spin: {
    on: true,
    secondsPerTurn: [24, 2, 120, 0.5],
    startAngle: [0, 0, 360, 1],
    drag: true,
    dragPerTurn: [600, 100, 3000, 10],
    stiffness: [100, 10, 400, 5],
    damping: [30, 5, 120, 1],
    mass: [1, 0.2, 5, 0.1],
  },
  markers: {
    preset: { type: 'select', options: MARKER_OPTIONS, default: 'world' },
    size: [1, 0, 4, 0.05],
    custom: {
      type: 'text',
      default: '',
      placeholder: '[{"location":[33.749,-84.388],"size":0.1}]',
    },
  },
  text: {
    show: false,
    value: { type: 'text', default: '', placeholder: 'label, | splits lines' },
    font: { type: 'select', options: FONT_OPTIONS, default: FONT_OPTIONS[0].value },
    weight: { type: 'select', options: WEIGHT_OPTIONS, default: '500' },
    size: [48, 8, 240, 1],
    tracking: [0, -0.08, 0.4, 0.005],
    lineHeight: [1.25, 0.8, 2.4, 0.05],
    color: { type: 'color', default: '#f5f5f4' },
    opacity: [1, 0, 1, 0.01],
    x: [0.5, 0, 1, 0.005],
    y: [0.88, 0, 1, 0.005],
    align: { type: 'select', options: ALIGN_OPTIONS, default: 'center' },
  },
  record: {
    start: { type: 'action', label: 'Record' },
    turns: [1, 1, 8, 1],
    fps: { type: 'select', options: FPS_OPTIONS, default: '120' },
    format: { type: 'select', options: FORMAT_OPTIONS, default: 'mp4' },
    mbps: [16, 2, 80, 1],
    hidePanel: true,
  },
  output: {
    still: { type: 'action', label: 'Save PNG' },
    props: { type: 'action', label: 'Save JSON' },
    copy: { type: 'action', label: 'Copy config' },
  },
} satisfies DialConfig;

export type DialValues = ResolvedValues<typeof DIALS>;

type AnyRecord = Record<string, unknown>;

function resolveDefaults(config: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      out[key] = value[0];
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      out[key] = value;
      continue;
    }
    const control = value as { type?: string; default?: unknown };
    if (control.type === 'action') continue;
    if (control.type === 'select' || control.type === 'color' || control.type === 'text') {
      out[key] = control.default ?? '';
      continue;
    }
    out[key] = resolveDefaults(value as AnyRecord);
  }
  return out;
}

/** Remotion needs plain default props, derived rather than duplicated. */
export const DEFAULT_VALUES = resolveDefaults(DIALS) as unknown as DialValues;
