import {
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useMotionValue, useSpring } from 'motion/react';
import { attachGlobe } from './lib/globe';
import { paintStage } from './lib/paint';
import type { StageSettings } from './lib/settings';

const TAU = Math.PI * 2;

type Props = {
  settings: StageSettings;
  /** The composited canvas. This is what the browser recorder captures. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** performance.now() at record start, else null. Drives an exact-length loop. */
  recordAnchorRef: RefObject<number | null>;
  /** Render at full output resolution instead of the crisper preview size. */
  renderFullRef: RefObject<boolean>;
};

export function GlobeStage({ settings, canvasRef, recordAnchorRef, renderFullRef }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const globeCanvasRef = useRef<HTMLCanvasElement>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const boxRef = useRef({ width: 0, height: 0 });

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const spring = useMemo(
    () => settings.spin.spring,
    [settings.spin.spring.stiffness, settings.spin.spring.damping, settings.spin.spring.mass]
  );
  const dragValue = useMotionValue(0);
  const dragSpring = useSpring(dragValue, spring);

  const pointerX = useRef<number | null>(null);
  const angleRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const anchorSeenRef = useRef<number | null>(null);
  const anchorBaseRef = useRef(0);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      boxRef.current = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const resolution = settings.globe.resolution;
  useEffect(() => {
    const canvas = globeCanvasRef.current;
    if (!canvas) return;

    const globe = attachGlobe(canvas, resolution, () => {
      const s = settingsRef.current;
      const now = performance.now();
      const period = Math.max(0.1, s.spin.secondsPerTurn) * 1000;
      const anchor = recordAnchorRef.current;

      if (anchor !== anchorSeenRef.current) {
        anchorSeenRef.current = anchor;
        // Recording starts from wherever the globe already sits, so the last
        // frame lands exactly back on the first one.
        if (anchor !== null) anchorBaseRef.current = angleRef.current;
      }

      if (s.spin.on) {
        if (anchor !== null) {
          angleRef.current = anchorBaseRef.current + ((now - anchor) / period) * TAU;
        } else {
          const last = lastFrameRef.current ?? now;
          angleRef.current += ((now - last) / period) * TAU;
        }
      }
      lastFrameRef.current = now;

      return {
        settings: s,
        phi: (s.spin.startAngle * Math.PI) / 180 + angleRef.current + dragSpring.get(),
      };
    });

    return () => globe.destroy();
  }, [resolution, dragSpring, recordAnchorRef]);

  useEffect(() => {
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const stage = canvasRef.current;
      const globeCanvas = globeCanvasRef.current;
      if (!stage || !globeCanvas) return;

      const s = settingsRef.current;
      const box = boxRef.current;

      // Never blow the stage up past its authored size, only shrink to fit.
      const fit =
        box.width > 0 && box.height > 0
          ? Math.min(1, box.width / s.out.width, box.height / s.out.height)
          : 1;

      // Preview renders at native device pixels. Downsampling a full-size
      // export canvas into a smaller box is what made text look rough.
      const previewScale = Math.min(s.out.scale, Math.max(0.25, fit * (window.devicePixelRatio || 1)));
      const scale = renderFullRef.current ? s.out.scale : previewScale;

      const width = Math.round(s.out.width * scale);
      const height = Math.round(s.out.height * scale);
      if (stage.width !== width) stage.width = width;
      if (stage.height !== height) stage.height = height;

      const cssWidth = `${Math.round(s.out.width * fit)}px`;
      const cssHeight = `${Math.round(s.out.height * fit)}px`;
      if (stage.style.width !== cssWidth) stage.style.width = cssWidth;
      if (stage.style.height !== cssHeight) stage.style.height = cssHeight;

      const ctx = contextRef.current ?? stage.getContext('2d');
      if (!ctx) return;
      contextRef.current = ctx;

      paintStage(ctx, globeCanvas, s, width, height, scale);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [canvasRef, renderFullRef]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!settingsRef.current.spin.drag) return;
    pointerX.current = event.clientX;
    event.currentTarget.style.cursor = 'grabbing';
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerX.current === null) return;
    const delta = event.clientX - pointerX.current;
    pointerX.current = event.clientX;
    const perTurn = Math.max(1, settingsRef.current.spin.dragPerTurn);
    dragValue.set(dragValue.get() + (delta / perTurn) * TAU);
  };

  const endPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerX.current === null) return;
    pointerX.current = null;
    event.currentTarget.style.cursor = settingsRef.current.spin.drag ? 'grab' : 'default';
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="stage-frame" ref={frameRef}>
      <div className="globe-offscreen" aria-hidden="true">
        <canvas ref={globeCanvasRef} />
      </div>
      <canvas
        ref={canvasRef}
        className="stage-canvas"
        style={{ cursor: settings.spin.drag ? 'grab' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      />
    </div>
  );
}
