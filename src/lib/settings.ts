import type { Marker } from 'cobe';
import { toRgb, type RGB } from './color';
import { resolveMarkers } from './markers';
import type { DialValues } from './dialConfig';

export type StageSettings = {
  out: { width: number; height: number; scale: number };
  background: { color: string; transparent: boolean };
  globe: {
    resolution: number;
    size: number;
    offsetX: number;
    offsetY: number;
    dark: number;
    diffuse: number;
    mapSamples: number;
    mapBrightness: number;
    mapBaseBrightness: number;
    scale: number;
    theta: number;
    opacity: number;
    baseColor: RGB;
    markerColor: RGB;
    glowColor: RGB;
    markers: Marker[];
  };
  spin: {
    on: boolean;
    secondsPerTurn: number;
    startAngle: number;
    drag: boolean;
    /** Drag distance in css px for one full turn. */
    dragPerTurn: number;
    spring: { stiffness: number; damping: number; mass: number };
  };
  text: {
    show: boolean;
    value: string;
    font: string;
    weight: string;
    size: number;
    tracking: number;
    lineHeight: number;
    color: string;
    opacity: number;
    x: number;
    y: number;
    align: CanvasTextAlign;
  };
  record: {
    turns: number;
    fps: number;
    format: string;
    bitsPerSecond: number;
    hidePanel: boolean;
  };
};

export function toStage(v: DialValues): StageSettings {
  return {
    out: { width: v.stage.width, height: v.stage.height, scale: v.stage.scale },
    background: { color: v.stage.background, transparent: v.stage.transparent },
    globe: {
      resolution: Number(v.globe.resolution),
      size: v.globe.size,
      offsetX: v.globe.offsetX,
      offsetY: v.globe.offsetY,
      dark: v.globe.dark,
      diffuse: v.globe.diffuse,
      mapSamples: Math.round(v.globe.mapSamples),
      mapBrightness: v.globe.mapBrightness,
      mapBaseBrightness: v.globe.mapBaseBrightness,
      scale: v.globe.zoom,
      theta: v.globe.tilt,
      opacity: v.globe.opacity,
      baseColor: toRgb(v.color.base, [0.23, 0.23, 0.23]),
      markerColor: toRgb(v.color.marker, [0.98, 0.39, 0.08]),
      glowColor: toRgb(
        v.color.glowFollowsBackground ? v.stage.background : v.color.glow,
        [0.04, 0.04, 0.05]
      ),
      markers: resolveMarkers(v.markers.preset, v.markers.custom, v.markers.size),
    },
    spin: {
      on: v.spin.on,
      secondsPerTurn: v.spin.secondsPerTurn,
      startAngle: v.spin.startAngle,
      drag: v.spin.drag,
      dragPerTurn: v.spin.dragPerTurn,
      spring: { stiffness: v.spin.stiffness, damping: v.spin.damping, mass: v.spin.mass },
    },
    text: {
      show: v.text.show,
      value: v.text.value,
      font: v.text.font,
      weight: v.text.weight,
      size: v.text.size,
      tracking: v.text.tracking,
      lineHeight: v.text.lineHeight,
      color: v.text.color,
      opacity: v.text.opacity,
      x: v.text.x,
      y: v.text.y,
      align: v.text.align as CanvasTextAlign,
    },
    record: {
      turns: Math.round(v.record.turns),
      fps: Number(v.record.fps),
      format: v.record.format,
      bitsPerSecond: Math.round(v.record.mbps * 1_000_000),
      hidePanel: v.record.hidePanel,
    },
  };
}

export function outputSize(settings: StageSettings) {
  return {
    width: Math.round(settings.out.width * settings.out.scale),
    height: Math.round(settings.out.height * settings.out.scale),
  };
}

export function durationSeconds(settings: StageSettings) {
  return settings.record.turns * settings.spin.secondsPerTurn;
}
