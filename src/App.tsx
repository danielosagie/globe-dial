import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DialRoot } from 'dialkit';
import 'dialkit/styles.css';
import { GlobeStage, type StageHandle } from './GlobeStage';
import { canEncode, encodeFrames, type EncodeContainer } from './lib/encode';
import {
  encodeRawMov,
  encodeRawMovToWriter,
  estimateMovBytes,
  RAW_MOV_MEMORY_LIMIT_BYTES,
  type RawMovWriter,
} from './lib/mov';
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

/** Give the compositor time to swap to full output resolution before capture. */
function waitFrames(count: number) {
  return new Promise<void>((resolve) => {
    let left = count;
    const step = () => (left-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

type SaveFilePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable: () => Promise<RawMovWriter> }>;

function getSaveFilePicker(): SaveFilePicker | null {
  const picker = (
    window as typeof window & { showSaveFilePicker?: SaveFilePicker }
  ).showSaveFilePicker;
  return picker?.bind(window) ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    const digits = bytes >= 10_000_000_000 ? 1 : 2;
    return `${(bytes / 1_000_000_000).toFixed(digits)} GB`;
  }
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * A small thumbnail of the stage canvas's current pixels, alpha intact, as a
 * PNG data URL. Must run synchronously right after an export finishes and
 * before anything else touches the canvas: the live preview loop resumes on
 * the next animation frame and will overwrite this content otherwise.
 */
function capturePreview(canvas: HTMLCanvasElement): string | null {
  const THUMB = 160;
  const scale = Math.min(1, THUMB / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const thumb = document.createElement('canvas');
  thumb.width = w;
  thumb.height = h;
  const ctx = thumb.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  return thumb.toDataURL('image/png');
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
  // Proof, not a promise: an actual frame from the file just saved, shown on
  // the checkerboard so alpha is something you see, not something you take
  // on faith or go verify in QuickTime.
  const [alphaPreview, setAlphaPreview] = useState<string | null>(null);

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
      let blob: Blob | null = null;
      let failureReason: string | null = null;
      stage.begin();
      try {
        blob = await encodeFrames({
          canvas,
          container,
          fps,
          frames,
          bitrate: s.record.bitsPerSecond,
          drawFrame: (frame: number) => stage.renderFrame(frame, fps),
          onProgress: (done: number) => setExporting({ done, total: frames }),
          cancelled: () => cancelExportRef.current,
        });
      } catch (error) {
        console.error('[encode] failed', error);
        failureReason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      } finally {
        stage.end();
        renderFullRef.current = false;
        busyRef.current = false;
        setExporting(null);
      }

      if (!blob || blob.size < 1024) {
        flash(failureReason ? `encode failed: ${failureReason}` : 'encode failed');
        return;
      }
      download(blob, `globe-${stamp()}.${await actualExtension(blob, container)}`);
      flash(cancelExportRef.current ? 'saved, stopped early' : 'saved');
    },
    [flash]
  );

  /**
   * Transparent exports, muxed as uncompressed BGRA frames in a QuickTime
   * container. There is no encoder here, so this is not a bitrate choice,
   * it is genuinely width * height * 4 bytes per frame.
   */
  const exportRawMov = useCallback(async () => {
    const canvas = stageCanvasRef.current;
    const stage = stageHandleRef.current;
    if (!canvas || !stage) return;

    const s = settingsRef.current;
    const fps = s.record.fps;
    const frames = Math.max(1, Math.round(durationSeconds(s) * fps));
    const { width, height } = outputSize(s);
    const estimatedBytes = estimateMovBytes(width, height, frames);
    let writer: RawMovWriter | null = null;
    setAlphaPreview(null);

    if (estimatedBytes > RAW_MOV_MEMORY_LIMIT_BYTES) {
      const estimate = formatBytes(estimatedBytes);
      const detail = `${frames.toLocaleString()} frames at ${width.toLocaleString()} × ${height.toLocaleString()}`;
      const picker = getSaveFilePicker();

      if (!picker) {
        window.alert(
          `This would be ~${estimate} of uncompressed BGRA data (${detail}) and will likely hang this tab. This browser cannot stream raw MOV directly to disk. Lower Stage scale, duration, fps, or turns until the estimate is below ${formatBytes(RAW_MOV_MEMORY_LIMIT_BYTES)}, or use pnpm render.`
        );
        flash(`mov blocked at ~${estimate}`);
        return;
      }

      const streamToDisk = window.confirm(
        `This would be ~${estimate} of uncompressed BGRA data (${detail}). Buffering it in this tab will likely exhaust memory and hang it.\n\nChoose OK to save directly to disk while frames render, or Cancel to lower Stage scale, duration, fps, or turns.`
      );
      if (!streamToDisk) {
        flash(`mov cancelled before capture (~${estimate})`);
        return;
      }

      try {
        const handle = await picker({
          suggestedName: `globe-${stamp()}.mov`,
          types: [
            {
              description: 'QuickTime movie',
              accept: { 'video/quicktime': ['.mov'] },
            },
          ],
        });
        writer = await handle.createWritable();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          flash('mov cancelled before capture');
        } else {
          console.error('[mov] save picker failed', error);
          flash('could not open a mov destination');
        }
        return;
      }
    }

    busyRef.current = true;
    cancelExportRef.current = false;
    renderFullRef.current = true;
    setExporting({ done: 0, total: frames });

    let result: { frames: number } | null = null;
    // Surfaced in the flash message on failure. A generic "mov encode
    // failed" with nothing behind it is undiagnosable from the outside -
    // this is what actually let us find out what broke, not just that it did.
    let failureReason: string | null = null;
    stage.begin();
    try {
      const options = {
        canvas,
        fps,
        frames,
        drawFrame: (frame: number) => stage.renderFrame(frame, fps),
        onProgress: (done: number) => setExporting({ done, total: frames }),
        cancelled: () => cancelExportRef.current,
      };
      result = writer
        ? await encodeRawMovToWriter({ ...options, writer })
        : await encodeRawMov(options);
    } catch (error) {
      console.error('[mov] failed', error);
      failureReason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    } finally {
      stage.end();
      renderFullRef.current = false;
      busyRef.current = false;
      setExporting(null);
    }

    if (!result) {
      flash(failureReason ? `mov encode failed: ${failureReason}` : 'mov encode failed: 0 frames captured');
      return;
    }
    // Read before anything else touches the canvas: the live preview loop
    // resumes as soon as the browser gets control back and would paint over
    // this at preview resolution otherwise.
    if (s.background.transparent) setAlphaPreview(capturePreview(canvas));
    const mb = Math.round(estimateMovBytes(width, height, result.frames) / 1_000_000);
    if (!writer) {
      const memoryResult = result as Awaited<ReturnType<typeof encodeRawMov>>;
      if (!memoryResult) return;
      download(memoryResult.blob, `globe-${stamp()}.mov`);
    }
    flash(`${writer ? 'saved to disk' : 'saved'} ${result.frames} frames, ${mb} MB`);
  }, [flash]);

  const startRecording = useCallback(async () => {
    const canvas = stageCanvasRef.current;
    if (!canvas || busyRef.current) return;

    const s = settingsRef.current;
    setAlphaPreview(null);

    // WebCodecs cannot keep an alpha channel, verified across avc, hevc, vp9,
    // vp8 and av1, and there is no in-browser ProRes encoder either. A
    // transparent stage therefore goes to the raw BGRA mov muxer, unless webm
    // was asked for specifically, which MediaRecorder can do with VP9 alpha
    // and which is far smaller for web use.
    if (s.background.transparent && s.record.format !== 'webm') {
      await exportRawMov();
      return;
    }

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
    // Same ordering constraint as the mov path: capture before anything else
    // touches the canvas, while it still shows the last captured frame.
    if (s.background.transparent) setAlphaPreview(capturePreview(canvas));

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
  }, [flash, encodeExport, exportRawMov]);

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

  const stopActiveCapture = useCallback(() => {
    cancelExportRef.current = true;
    handleRef.current?.stop();
  }, []);

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
        stopActiveCapture();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startRecording, stopActiveCapture]);

  const { width: outWidth, height: outHeight } = outputSize(settings);
  const panelHidden = Boolean(recording || exporting) && settings.record.hidePanel;
  // Asking for a transparent stage in a container that cannot store alpha.
  // mp4 is the only choice that cannot hold alpha in any container we can write.
  const alphaLost = settings.background.transparent && settings.record.format === 'gif';

  // What `r` will actually produce, shown up front rather than as a flash
  // after the file has already landed in Downloads under a misleading name.
  // Opaque exports encode the chosen container directly; only alpha is forced
  // down a different route, because no browser encoder keeps an alpha channel
  // outside MediaRecorder's webm.
  const capturesAs = useMemo(() => {
    const format = settings.record.format;
    // Transparent exports go out as a raw BGRA mov, so only mp4 and gif shift.
    if (settings.background.transparent) return format === 'mov' || format === 'webm' ? null : 'mov';
    return format === 'gif' ? 'webm' : null;
  }, [settings.record.format, settings.background.transparent]);

  // A raw mov has no compression at all, so the size is knowable up front and
  // worth showing before someone starts a 2 GB export by accident.
  const rawMovMb = useMemo(() => {
    if (!settings.background.transparent || settings.record.format === 'webm') return null;
    const { width, height } = outputSize(settings);
    const frames = Math.max(1, Math.round(durationSeconds(settings) * settings.record.fps));
    return Math.round(estimateMovBytes(width, height, frames) / 1_000_000);
  }, [settings]);

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
          <button className="pill__stop" type="button" onClick={stopActiveCapture}>
            Stop
          </button>
          <span className="pill__hint">esc</span>
        </div>
      ) : null}

      {recording ? (
        <div className="pill" role="status">
          <span className="pill__dot" />
          <span>{(remaining / 1000).toFixed(1)}s</span>
          <button className="pill__stop" type="button" onClick={stopActiveCapture}>
            Stop
          </button>
          <span className="pill__hint">esc</span>
        </div>
      ) : null}

      {alphaPreview ? (
        <div className="alpha-preview">
          <div className="alpha-preview__thumb">
            <img src={alphaPreview} alt="Frame from the file just saved, alpha preserved" />
          </div>
          <div className="alpha-preview__row">
            <span>from the saved file</span>
            <button
              className="alpha-preview__close"
              type="button"
              onClick={() => setAlphaPreview(null)}
              aria-label="Dismiss preview"
            >
              &times;
            </button>
          </div>
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
          {rawMovMb !== null ? (
            <span className={rawMovMb > 300 ? 'readout__warn' : undefined}>~{rawMovMb} MB</span>
          ) : null}
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
