import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DialRoot } from 'dialkit';
import 'dialkit/styles.css';
import { GlobeStage } from './GlobeStage';
import { durationSeconds, outputSize, toStage, useGlobeDials, type DialValues } from './lib/dials';
import { rgbLiteral } from './lib/color';
import {
  download,
  extensionFor,
  pickMimeType,
  recordCanvas,
  stamp,
  type RecordHandle,
} from './lib/recorder';

/** Give the compositor time to swap to full output resolution before capture. */
function waitFrames(count: number) {
  return new Promise<void>((resolve) => {
    let left = count;
    const step = () => (left-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

export default function App() {
  const actionRef = useRef<(action: string) => void>(() => {});
  const values = useGlobeDials((action) => actionRef.current(action));
  const settings = useMemo(() => toStage(values), [values]);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const valuesRef = useRef<DialValues>(values);
  valuesRef.current = values;

  const stageCanvasRef = useRef<HTMLCanvasElement>(null);
  const recordAnchorRef = useRef<number | null>(null);
  const renderFullRef = useRef(false);
  const handleRef = useRef<RecordHandle | null>(null);
  const busyRef = useRef(false);

  const [recording, setRecording] = useState<{ endsAt: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const flash = useCallback((message: string) => {
    setNote(message);
    window.setTimeout(() => setNote((current) => (current === message ? null : current)), 2600);
  }, []);

  const startRecording = useCallback(async () => {
    const canvas = stageCanvasRef.current;
    if (!canvas || busyRef.current) return;

    const s = settingsRef.current;
    const mimeType = pickMimeType(s.record.format);
    if (!mimeType) {
      flash('format not supported in this browser');
      return;
    }
    // A backgrounded tab pauses rAF, which stalls the canvas and the stream.
    if (document.hidden) {
      flash('bring the tab to the front');
      return;
    }

    let wentHidden = false;
    const watchVisibility = () => {
      if (document.hidden) wentHidden = true;
    };
    document.addEventListener('visibilitychange', watchVisibility);

    busyRef.current = true;
    // captureStream locks onto the canvas size at start, so resize first.
    renderFullRef.current = true;
    await waitFrames(2);

    const durationMs = durationSeconds(s) * 1000;
    recordAnchorRef.current = performance.now();
    setRecording({ endsAt: performance.now() + durationMs });

    const handle = recordCanvas(canvas, {
      fps: s.record.fps,
      mimeType,
      bitsPerSecond: s.record.bitsPerSecond,
    });
    handleRef.current = handle;
    const timer = window.setTimeout(() => handle.stop(), durationMs);

    const blob = await handle.done;

    window.clearTimeout(timer);
    document.removeEventListener('visibilitychange', watchVisibility);
    handleRef.current = null;
    recordAnchorRef.current = null;
    renderFullRef.current = false;
    busyRef.current = false;
    setRecording(null);

    // A header-only webm still arrives as a Blob, so size is the real signal.
    if (!blob || blob.size < 4096) {
      flash('no frames captured, keep the tab in front');
      return;
    }
    download(blob, `globe-${stamp()}.${extensionFor(mimeType)}`);
    flash(wentHidden ? 'saved, frames may be missing' : 'saved');
  }, [flash]);

  const saveStill = useCallback(async () => {
    const canvas = stageCanvasRef.current;
    if (!canvas || busyRef.current) return;
    busyRef.current = true;
    renderFullRef.current = true;
    await waitFrames(2);
    canvas.toBlob((blob) => {
      renderFullRef.current = false;
      busyRef.current = false;
      if (!blob) {
        flash('still failed');
        return;
      }
      download(blob, `globe-${stamp()}.png`);
      flash('saved');
    }, 'image/png');
  }, [flash]);

  const saveProps = useCallback(() => {
    const json = JSON.stringify({ values: valuesRef.current }, null, 2);
    download(new Blob([json], { type: 'application/json' }), 'globe.props.json');
    flash('saved, render it with pnpm render');
  }, [flash]);

  const copyConfig = useCallback(async () => {
    const s = settingsRef.current;
    const g = s.globe;
    const px = Math.round(g.size * s.out.scale);
    const snippet = [
      'const GLOBE_CONFIG: COBEOptions = {',
      `  width: ${px},`,
      `  height: ${px},`,
      '  onRender: () => {},',
      `  devicePixelRatio: ${s.out.scale},`,
      `  phi: ${((s.spin.startAngle * Math.PI) / 180).toFixed(4)},`,
      `  theta: ${g.theta},`,
      `  dark: ${g.dark},`,
      `  diffuse: ${g.diffuse},`,
      `  mapSamples: ${g.mapSamples},`,
      `  mapBrightness: ${g.mapBrightness},`,
      `  mapBaseBrightness: ${g.mapBaseBrightness},`,
      `  baseColor: ${rgbLiteral(g.baseColor)},`,
      `  markerColor: ${rgbLiteral(g.markerColor)},`,
      `  glowColor: ${rgbLiteral(g.glowColor)},`,
      `  scale: ${g.scale},`,
      `  opacity: ${g.opacity},`,
      `  markers: ${JSON.stringify(g.markers)},`,
      '};',
    ].join('\n');

    try {
      await navigator.clipboard.writeText(snippet);
      flash('config copied');
    } catch {
      flash('clipboard blocked');
    }
  }, [flash]);

  actionRef.current = (action: string) => {
    if (action === 'record.start') void startRecording();
    else if (action === 'output.still') void saveStill();
    else if (action === 'output.props') saveProps();
    else if (action === 'output.copy') void copyConfig();
  };

  useEffect(() => {
    if (!recording) return;
    const tick = () => setRemaining(Math.max(0, recording.endsAt - performance.now()));
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [recording]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        void startRecording();
      }
      if (event.key === 'Escape') handleRef.current?.stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startRecording]);

  const { width: outWidth, height: outHeight } = outputSize(settings);
  const panelHidden = Boolean(recording) && settings.record.hidePanel;

  return (
    <main className={`page${settings.background.transparent ? ' page--checker' : ''}`}>
      <GlobeStage
        settings={settings}
        canvasRef={stageCanvasRef}
        recordAnchorRef={recordAnchorRef}
        renderFullRef={renderFullRef}
      />

      {recording ? (
        <div className="pill" role="status">
          <span className="pill__dot" />
          <span>{(remaining / 1000).toFixed(1)}s</span>
          <span className="pill__hint">esc to stop</span>
        </div>
      ) : null}

      {!panelHidden ? (
        <footer className="readout">
          <span>
            {outWidth} &times; {outHeight}
          </span>
          <span>{settings.record.format}</span>
          <span>{durationSeconds(settings).toFixed(1)}s</span>
          <span>{settings.record.fps} fps</span>
          {note ? <span className="readout__note">{note}</span> : <span>r to record</span>}
        </footer>
      ) : null}

      {!panelHidden ? (
        <DialRoot position="bottom-right" defaultOpen theme="dark" productionEnabled />
      ) : null}
    </main>
  );
}
