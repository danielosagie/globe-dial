import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DialRoot } from 'dialkit';
import 'dialkit/styles.css';
import { GlobeStage, type StageHandle } from './GlobeStage';
import { canEncode, encodeFrames, type EncodeContainer } from './lib/encode';
import { durationSeconds, outputSize, toStage, useGlobeDials, type DialValues } from './lib/dials';
import { rgbLiteral } from './lib/color';
import {
  actualExtension,
  download,
  pickBrowserCapture,
  recordCanvas,
  stamp,
  type RecordHandle,
} from './lib/recorder';
import { carriesAlpha } from './lib/formats';

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
  const stageHandleRef = useRef<StageHandle | null>(null);
  const recordAnchorRef = useRef<number | null>(null);
  const renderFullRef = useRef(false);
  const handleRef = useRef<RecordHandle | null>(null);
  const busyRef = useRef(false);
  const cancelExportRef = useRef(false);

  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  const [recording, setRecording] = useState<{ endsAt: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const flash = useCallback((message: string) => {
    setNote(message);
    window.setTimeout(() => setNote((current) => (current === message ? null : current)), 2600);
  }, []);

  /**
   * Frame-stepped export. Nothing here runs against a clock, so the file has
   * exactly the frames asked for at exactly the rate asked for.
   */
  const encodeExport = useCallback(
    async (container: EncodeContainer) => {
      const canvas = stageCanvasRef.current;
      const stage = stageHandleRef.current;
      if (!canvas || !stage) return;

      const s = settingsRef.current;
      const fps = s.record.fps;
      const frames = Math.max(1, Math.round(durationSeconds(s) * fps));

      busyRef.current = true;
      cancelExportRef.current = false;
      renderFullRef.current = true;
      setExporting({ done: 0, total: frames });

      // No waiting on animation frames anywhere in here. renderFrame paints
      // synchronously at full resolution, so the export survives a background
      // tab, which is exactly where realtime capture falls apart.
      stage.begin();
      const blob = await encodeFrames({
        canvas,
        container,
        fps,
        frames,
        bitrate: s.record.bitsPerSecond,
        drawFrame: (frame) => stage.renderFrame(frame, fps),
        onProgress: (done) => setExporting({ done, total: frames }),
        cancelled: () => cancelExportRef.current,
      });
      stage.end();

      renderFullRef.current = false;
      busyRef.current = false;
      setExporting(null);

      if (!blob || blob.size < 1024) {
        flash('encode failed');
        return;
      }
      download(blob, `globe-${stamp()}.${await actualExtension(blob, container)}`);
      flash(cancelExportRef.current ? 'saved, stopped early' : 'saved');
    },
    [flash]
  );

  const startRecording = useCallback(async () => {
    const canvas = stageCanvasRef.current;
    if (!canvas || busyRef.current) return;

    const s = settingsRef.current;

    // WebCodecs cannot keep an alpha channel, verified across avc, vp9, vp8,
    // hevc and av1. MediaRecorder's VP9 webm is the only browser encoder that
    // does, so a transparent stage goes through it and everything else takes
    // the frame-stepped path.
    if (!s.background.transparent) {
      const container = (s.record.format === 'gif' ? 'webm' : s.record.format) as EncodeContainer;
      if (await canEncode(container)) {
        await encodeExport(container);
        return;
      }
    }

    const capture = pickBrowserCapture(s.record.format, s.background.transparent);
    if (!capture) {
      flash('no recordable format in this browser');
      return;
    }
    const { mimeType } = capture;
    if (capture.note) flash(capture.note);
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
    download(blob, `globe-${stamp()}.${await actualExtension(blob, mimeType)}`);
    flash(wentHidden ? 'saved, frames may be missing' : 'saved');
  }, [flash, encodeExport]);

  const saveStill = useCallback(async () => {
    const canvas = stageCanvasRef.current;
    const stage = stageHandleRef.current;
    if (!canvas || !stage || busyRef.current) return;
    busyRef.current = true;
    renderFullRef.current = true;
    // Suspend the preview loop first, otherwise it can repaint at preview
    // resolution between this composite and the snapshot.
    stage.suspend();
    stage.composeFull();
    canvas.toBlob((blob) => {
      stage.resume();
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
      if (event.key === 'Escape') {
        cancelExportRef.current = true;
        handleRef.current?.stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startRecording]);

  const { width: outWidth, height: outHeight } = outputSize(settings);
  const panelHidden = Boolean(recording || exporting) && settings.record.hidePanel;
  // Asking for a transparent stage in a container that cannot store alpha.
  const alphaLost = settings.background.transparent && !carriesAlpha(settings.record.format);

  // What `r` will actually produce, shown up front rather than as a flash
  // after the file has already landed in Downloads under a misleading name.
  // Opaque exports encode the chosen container directly; only alpha is forced
  // down a different route, because no browser encoder keeps an alpha channel
  // outside MediaRecorder's webm.
  const capturesAs = useMemo(() => {
    const format = settings.record.format;
    if (settings.background.transparent) return format === 'webm' ? null : 'webm';
    return format === 'gif' ? 'webm' : null;
  }, [settings.record.format, settings.background.transparent]);

  return (
    <main className={`page${settings.background.transparent ? ' page--checker' : ''}`}>
      <GlobeStage
        settings={settings}
        canvasRef={stageCanvasRef}
        recordAnchorRef={recordAnchorRef}
        renderFullRef={renderFullRef}
        handleRef={stageHandleRef}
      />

      {exporting ? (
        <div className="pill" role="status">
          <span className="pill__dot" />
          <span>
            {exporting.done}/{exporting.total}
          </span>
          <span className="pill__hint">esc to stop</span>
        </div>
      ) : null}

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
          <span>
            {settings.record.format}
            {capturesAs ? <span className="readout__warn"> &rarr; {capturesAs}</span> : null}
          </span>
          <span>{durationSeconds(settings).toFixed(1)}s</span>
          <span>{settings.record.fps} fps</span>
          {alphaLost ? (
            <span className="readout__warn">{settings.record.format} has no alpha</span>
          ) : null}
          {note ? <span className="readout__note">{note}</span> : <span>r to record</span>}
        </footer>
      ) : null}

      {!panelHidden ? (
        <DialRoot position="bottom-right" defaultOpen theme="dark" productionEnabled />
      ) : null}
    </main>
  );
}
