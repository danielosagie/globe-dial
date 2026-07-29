import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  MovOutputFormat,
  Output,
  WebMOutputFormat,
  canEncodeVideo,
  type VideoCodec,
} from 'mediabunny';

/**
 * Frame-stepped encoding through WebCodecs.
 *
 * MediaRecorder samples a canvas in realtime, so it drops frames whenever the
 * machine hitches and can never exceed the display refresh rate. This drives
 * the encoder itself: every frame is drawn, handed over, and awaited, so the
 * file contains exactly the frames asked for at exactly the rate asked for,
 * however long each one took to render.
 */
export type EncodeContainer = 'mp4' | 'mov' | 'webm';

const CODEC_FOR: Record<EncodeContainer, VideoCodec> = {
  mp4: 'avc',
  mov: 'avc',
  webm: 'vp9',
};

const MIME_FOR: Record<EncodeContainer, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export function codecFor(container: EncodeContainer): VideoCodec {
  return CODEC_FOR[container];
}

export async function canEncode(container: EncodeContainer): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return await canEncodeVideo(CODEC_FOR[container]);
  } catch {
    return false;
  }
}

function formatFor(container: EncodeContainer) {
  if (container === 'webm') return new WebMOutputFormat();
  if (container === 'mov') return new MovOutputFormat();
  return new Mp4OutputFormat();
}

export async function encodeFrames(options: {
  canvas: HTMLCanvasElement;
  container: EncodeContainer;
  fps: number;
  frames: number;
  bitrate: number;
  drawFrame: (frame: number) => void;
  onProgress?: (done: number) => void;
  cancelled?: () => boolean;
}): Promise<Blob | null> {
  const { canvas, container, fps, frames, bitrate, drawFrame, onProgress, cancelled } = options;

  const output = new Output({ format: formatFor(container), target: new BufferTarget() });
  // The source reads the canvas at add() time, so the first frame has to be
  // drawn before the track is started or the encoder locks onto a blank size.
  drawFrame(0);
  const source = new CanvasSource(canvas, { codec: CODEC_FOR[container], bitrate });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  try {
    for (let frame = 0; frame < frames; frame += 1) {
      if (cancelled?.()) break;
      drawFrame(frame);
      // Awaiting respects encoder backpressure, which is what keeps memory flat
      // on long exports instead of queueing every frame at once.
      await source.add(frame / fps, 1 / fps);
      onProgress?.(frame + 1);
    }
    await output.finalize();
  } catch (error) {
    console.error('[encode] failed', error);
    try {
      await output.cancel();
    } catch {
      // Already torn down.
    }
    return null;
  }

  const buffer = output.target.buffer;
  if (!buffer) return null;
  return new Blob([buffer], { type: MIME_FOR[container] });
}
