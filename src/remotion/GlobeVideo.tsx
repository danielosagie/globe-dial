import { useEffect, useMemo, useRef } from 'react';
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { attachGlobe } from '../lib/globe';
import { paintStage } from '../lib/paint';
import { toStage, type StageSettings } from '../lib/settings';
import type { DialValues } from '../lib/dialConfig';

const TAU = Math.PI * 2;

export type GlobeVideoProps = { values: DialValues };

/**
 * Deterministic counterpart to the live stage. cobe's internal rAF loop is
 * switched off and stepped by hand once per Remotion frame, so the output is
 * frame exact rather than whatever realtime capture happened to catch.
 */
export const GlobeVideo: React.FC<GlobeVideoProps> = ({ values }) => {
  const settings = useMemo(() => toStage(values), [values]);
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const stageRef = useRef<HTMLCanvasElement>(null);
  const globeCanvasRef = useRef<HTMLCanvasElement>(null);
  const globeRef = useRef<ReturnType<typeof attachGlobe> | null>(null);

  const scale = width / settings.out.width;
  const framesPerTurn = Math.max(1, settings.spin.secondsPerTurn * fps);
  const phi =
    (settings.spin.startAngle * Math.PI) / 180 +
    (settings.spin.on ? (frame / framesPerTurn) * TAU : 0);

  // Read by cobe's onRender, which fires inside our manual render() calls.
  const stateRef = useRef<{ settings: StageSettings; phi: number }>({ settings, phi });
  stateRef.current = { settings, phi };

  const resolution = settings.globe.resolution;
  useEffect(() => {
    const canvas = globeCanvasRef.current;
    if (!canvas) return;
    const globe = attachGlobe(canvas, resolution, () => stateRef.current);
    globe.toggle(false);
    globeRef.current = globe;
    return () => {
      globeRef.current = null;
      globe.destroy();
    };
  }, [resolution]);

  useEffect(() => {
    const stage = stageRef.current;
    const globeCanvas = globeCanvasRef.current;
    const globe = globeRef.current;
    if (!stage || !globeCanvas || !globe) return;

    const handle = delayRender(`globe frame ${frame}`);

    // phenomenon draws with the current uniforms and only then calls onRender,
    // so the first pass installs this frame's values and the second draws them.
    globe.render();
    globe.render();

    const ctx = stage.getContext('2d');
    if (ctx) paintStage(ctx, globeCanvas, settings, width, height, scale);

    continueRender(handle);
  }, [frame, settings, width, height, scale]);

  return (
    <>
      <div className="globe-offscreen" aria-hidden="true">
        <canvas ref={globeCanvasRef} />
      </div>
      <canvas ref={stageRef} width={width} height={height} />
    </>
  );
};
