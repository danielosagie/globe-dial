const MP4 = ['video/mp4;codecs=avc1.42E01E', 'video/mp4'];
const WEBM = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export type BrowserCapture = { mimeType: string; note: string | null };

/**
 * MediaRecorder can only write mp4 or webm, and only webm carries alpha.
 * Pick the closest container to what the panel asked for and say plainly when
 * that is not the same thing. Remotion is the path for mov, gif and ProRes.
 */
export function pickBrowserCapture(format: string, transparent: boolean): BrowserCapture | null {
  if (typeof MediaRecorder === 'undefined') return null;

  const needsAlpha = transparent;
  let candidates = MP4;
  let note: string | null = null;

  if (format === 'mp4') {
    // A transparent stage in an opaque container silently loses the alpha.
    if (needsAlpha) {
      candidates = WEBM;
      note = 'mp4 has no alpha, captured webm';
    }
  } else if (format === 'mov' || format === 'gif') {
    candidates = WEBM;
    note = `${format} renders in remotion, captured webm`;
  } else {
    candidates = WEBM;
  }

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType, note };
  }

  // Safari and Firefox have no mp4 MediaRecorder. Falling back beats refusing.
  if (candidates === MP4) {
    for (const mimeType of WEBM) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return { mimeType, note: 'this browser cannot record mp4, captured webm' };
      }
    }
  }
  return null;
}

export function extensionFor(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

/**
 * Name the file after what is actually inside it. The requested mime type is
 * a request, not a guarantee, and a webm called .mp4 reads as a broken export.
 */
export async function actualExtension(blob: Blob, mimeType: string): Promise<string> {
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
    if (String.fromCharCode(head[4], head[5], head[6], head[7]) === 'ftyp') return 'mp4';
  } catch {
    // Fall through to the declared type.
  }
  return extensionFor(mimeType);
}

export type RecordHandle = {
  stop: () => void;
  done: Promise<Blob | null>;
};

export function recordCanvas(
  canvas: HTMLCanvasElement,
  options: { fps: number; mimeType: string; bitsPerSecond: number }
): RecordHandle {
  const stream = canvas.captureStream(options.fps);
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: options.mimeType,
    videoBitsPerSecond: options.bitsPerSecond,
  });

  const done = new Promise<Blob | null>((resolve) => {
    const finish = (blob: Blob | null) => {
      for (const track of stream.getTracks()) track.stop();
      resolve(blob);
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      finish(chunks.length ? new Blob(chunks, { type: options.mimeType }) : null);
    };
    recorder.onerror = () => finish(null);
  });

  recorder.start();

  return {
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop();
    },
    done,
  };
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
