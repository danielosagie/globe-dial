import createGlobe from 'cobe';
import type { StageSettings } from './settings';

export type GlobeFrame = { settings: StageSettings; phi: number };

/**
 * cobe reads every uniform through onRender, so the only thing that forces a
 * rebuild is the canvas resolution. Both the live preview and the Remotion
 * render mount the globe this way and differ only in how they compute phi.
 */
export function attachGlobe(
  canvas: HTMLCanvasElement,
  resolution: number,
  read: () => GlobeFrame
) {
  canvas.style.width = `${resolution}px`;
  canvas.style.height = `${resolution}px`;

  const initial = read();

  return createGlobe(canvas, {
    devicePixelRatio: 1,
    width: resolution,
    height: resolution,
    phi: initial.phi,
    theta: initial.settings.globe.theta,
    dark: initial.settings.globe.dark,
    diffuse: initial.settings.globe.diffuse,
    mapSamples: initial.settings.globe.mapSamples,
    mapBrightness: initial.settings.globe.mapBrightness,
    baseColor: initial.settings.globe.baseColor,
    markerColor: initial.settings.globe.markerColor,
    glowColor: initial.settings.globe.glowColor,
    markers: initial.settings.globe.markers,
    // Without this the drawing buffer is empty by the time we composite it.
    context: { preserveDrawingBuffer: true },
    onRender: (state) => {
      const { settings, phi } = read();
      const globe = settings.globe;
      state.phi = phi;
      state.theta = globe.theta;
      state.dark = globe.dark;
      state.diffuse = globe.diffuse;
      state.mapSamples = globe.mapSamples;
      state.mapBrightness = globe.mapBrightness;
      state.mapBaseBrightness = globe.mapBaseBrightness;
      state.baseColor = globe.baseColor;
      state.markerColor = globe.markerColor;
      state.glowColor = globe.glowColor;
      state.markers = globe.markers;
      state.scale = globe.scale;
      state.opacity = globe.opacity;
      state.width = resolution;
      state.height = resolution;
    },
  });
}
