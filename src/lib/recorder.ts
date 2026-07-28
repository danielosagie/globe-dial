export const FORMAT_OPTIONS = [
  { value: 'vp9', label: 'webm vp9' },
  { value: 'vp8', label: 'webm vp8' },
  { value: 'mp4', label: 'mp4' },
];

const CANDIDATES: Record<string, string[]> = {
  vp9: ['video/webm;codecs=vp9', 'video/webm'],
  vp8: ['video/webm;codecs=vp8', 'video/webm'],
  mp4: ['video/mp4;codecs=avc1.42E01E', 'video/mp4'],
};

/** Codec support varies by browser, so probe rather than assume. */
export function pickMimeType(format: string): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of CANDIDATES[format] ?? []) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

export function extensionFor(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
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
