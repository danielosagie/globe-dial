import {
  useCallback,
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

/**
 * Lets the encoder step the globe by frame instead of watching a clock.
 * Every method here is synchronous and free of requestAnimationFrame, so an
 * export keeps running at full speed in a background tab where rAF is frozen.
 */
export type StageHandle = {
  begin: () => void;
  renderFrame: (frame: number, fps: number) => void;
  end: () => void;
  /** Stop the preview loop repainting so a capture cannot be raced. */
  suspend: () => void;
  resume: () => void;
  /** Paint once, at whatever resolution renderFullRef currently asks for. */
  composeFull: () => void;
};

type Props = {
  settings: StageSettings;
  /** The composited canvas. This is what gets encoded. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** performance.now() at record start, else null. Drives an exact-length loop. */
  recordAnchorRef: RefObject<number | null>;
  /** Render at full output resolution instead of the crisper preview size. */
  renderFullRef: RefObject<boolean>;
  handleRef: RefObject<StageHandle | null>;
};

export function GlobeStage({
  settings,
  canvasRef,
  recordAnchorRef,
  renderFullRef,
  handleRef,
}: Props) {
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
  const globeRef = useRef<ReturnType<typeof attachGlobe> | null>(null);
  const exportFrameRef = useRef<number | null>(null);
  const exportFpsRef = useRef(60);
  const suspendRef = useRef(false);

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

      // Frame-stepped export: the angle is a pure function of the frame index,
      // so the same frame always produces the same pixels and the last frame
      // lands exactly one turn on from the first.
      const exportFrame = exportFrameRef.current;
      if (exportFrame !== null) {
        const framesPerTurn = Math.max(1, s.spin.secondsPerTurn * exportFpsRef.current);
        const angle = s.spin.on ? (exportFrame / framesPerTurn) * TAU : 0;
        return {
          settings: s,
          phi: (s.spin.startAngle * Math.PI) / 180 + angle + dragSpring.get(),
        };
      }

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
          // A tuning aid for the live preview only. Frame-stepped exports take
          // the branch above, and realtime recording has a non-null anchor, so
          // previewSpeed can never change pixels written to a recording.
          angleRef.current += ((now - last) / period) * TAU * s.spin.previewSpeed;
        }
      }
      lastFrameRef.current = now;

      return {
        settings: s,
        phi: (s.spin.startAngle * Math.PI) / 180 + angleRef.current + dragSpring.get(),
      };
    });

    globeRef.current = globe;
    return () => {
      globeRef.current = null;
      globe.destroy();
    };
  }, [resolution, dragSpring, recordAnchorRef]);

  const composite = useCallback(() => {
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

    const ctx =
      contextRef.current ?? stage.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    contextRef.current = ctx;

    paintStage(ctx, globeCanvas, s, width, height, scale);
  }, [canvasRef, renderFullRef]);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      // The export loop owns the canvas while it runs; drawing from both
      // would race and emit duplicated or half-painted frames.
      if (!suspendRef.current) composite();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [composite]);

  useEffect(() => {
    handleRef.current = {
      begin: () => {
        // Stop cobe's own loop so nothing advances between our steps.
        globeRef.current?.toggle(false);
        suspendRef.current = true;
        exportFrameRef.current = 0;
      },
      renderFrame: (frame: number, fps: number) => {
        exportFrameRef.current = frame;
        exportFpsRef.current = fps;
        const globe = globeRef.current;
        // phenomenon draws with the current uniforms and only then calls
        // onRender, so the first pass installs this frame and the second draws it.
        globe?.render();
        globe?.render();
        composite();
      },
      end: () => {
        exportFrameRef.current = null;
        suspendRef.current = false;
        globeRef.current?.toggle(true);
      },
      suspend: () => {
        suspendRef.current = true;
      },
      resume: () => {
        suspendRef.current = false;
      },
      composeFull: () => composite(),
    };
    return () => {
      handleRef.current = null;
    };
  }, [composite, handleRef]);

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
