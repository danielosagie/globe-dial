/**
 * A QuickTime muxer for uncompressed BGRA video, which is how this tool gets
 * a transparent .mov out of a browser.
 *
 * Nothing in a browser can encode an alpha channel into a normal video codec:
 * WebCodecs reports `alpha: 'keep'` unsupported for avc, hevc, vp9, vp8 and
 * av1, and MediaRecorder only carries alpha in webm. A first attempt at this
 * muxer stored each frame as PNG under the classic QuickTime 'png ' codec,
 * which is a legacy Component Manager codec: modern QuickTime Player is built
 * entirely on AVFoundation, which does not implement it. That version parsed
 * as a valid container (AVFoundation's own asset loader reported the track
 * and its format description correctly) but could not decode a single frame,
 * confirmed with AVFoundation's own image generator, not just ffprobe.
 *
 * 'BGRA' is not a codec in that sense at all, it is a registered raw pixel
 * format (`kCVPixelFormatType_32BGRA`), so there is no decoder to be missing.
 * Verified the same way: AVFoundation reports the asset playable and produces
 * a correct image with real alpha values, not just a parseable container.
 *
 * The cost is real: uncompressed 32bpp video is width * height * 4 bytes per
 * frame, no compression at all. At 1800px that is 13 MB a frame. Keep
 * transparent browser exports short and small, or use `pnpm render` for
 * ProRes 4444, which is genuinely compressed and still AVFoundation-native.
 */

const encoder = new TextEncoder();

function fourcc(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) out[i] = type.charCodeAt(i);
  return out;
}

function u16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value & 0xffff));
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0));
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.length + 8), fourcc(type), body]);
}

/** `mdat` is the only box that can exceed the classic 32-bit size field. */
function mediaDataHeader(payloadBytes: number, forceExtended = false): Uint8Array {
  const compactSize = payloadBytes + 8;
  if (!forceExtended && compactSize <= 0xffffffff) {
    return concat([u32(compactSize), fourcc('mdat')]);
  }
  return concat([u32(1), fourcc('mdat'), u64(payloadBytes + 16)]);
}

/** Identity matrix, the only one QuickTime ever needs here. */
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

function compressorName(name: string): Uint8Array {
  // 32 byte Pascal string: length byte then the text, zero padded.
  const out = new Uint8Array(32);
  const text = encoder.encode(name).slice(0, 31);
  out[0] = text.length;
  out.set(text, 1);
  return out;
}

/**
 * A raw pixel format sample entry has no wrapped codec box, unlike 'png '
 * which nests one. Field layout and values here were read back byte for byte
 * from a known-working reference file (ffmpeg's own '-pix_fmt bgra -c:v
 * rawvideo' mov output) rather than assembled from the spec alone.
 */
function visualSampleEntry(width: number, height: number): Uint8Array {
  return box(
    'BGRA',
    u16(0, 0, 0), // reserved
    u16(1), // data reference index
    u16(0, 0), // version, revision
    fourcc('appl'), // vendor
    u32(0), // temporal quality
    u32(1024), // spatial quality
    u16(width, height),
    u32(0x00480000, 0x00480000), // 72 dpi
    u32(0), // data size
    u16(1), // frame count
    compressorName('Globe BGRA'),
    u16(32), // depth: 32 signals colour plus alpha
    u16(0xffff) // colour table id -1, no palette
  );
}

/** BGRA byte order per pixel, which is what the 'BGRA' fourCC promises. */
function toBgra(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2]; // B
    out[i + 1] = rgba[i + 1]; // G
    out[i + 2] = rgba[i]; // R
    out[i + 3] = rgba[i + 3]; // A
  }
  return out;
}

export type MovResult = { blob: Blob; frames: number };
export type MovFileResult = { frames: number };

/**
 * Fallback ceiling, used only when the browser refuses to report a quota.
 *
 * This number used to be the whole decision, and that was the bug: the app's
 * own defaults (1920x1080, 30 fps, one 4 second turn) come to 995 MB, which
 * slipped under it, so a default recording took the in-memory path, rendered
 * all 120 frames, and only then died in `new Blob()` with QuotaExceededError.
 * No fixed constant could have caught that, because the real limit is
 * Chromium's per-origin storage quota — a share of free disk that moves with
 * the machine. `availableStorageBytes` asks for the real number now, and this
 * is what's left when there is no one to ask.
 */
export const RAW_MOV_MEMORY_LIMIT_BYTES = 1_500_000_000;

/**
 * Fraction of reported free quota an in-memory export may claim.
 *
 * A margin, not a measurement, and worth saying so: `estimate()` is
 * documented as approximate and padded, other tabs on the same origin spend
 * from the same pot, and a Blob this size is registered while its frames are
 * still alive in the JS heap. Spending the last byte of a number that is
 * itself approximate is how you land back on the failure above.
 */
const MEMORY_QUOTA_HEADROOM = 0.8;

/**
 * Bytes this origin can still store, or null when the browser won't say.
 *
 * Chromium reports a share of free disk here, so it differs per machine and
 * per day. That is exactly why it has to be asked for at export time rather
 * than guessed at build time.
 */
export async function availableStorageBytes(): Promise<number | null> {
  const storage = navigator.storage;
  if (!storage?.estimate) return null;
  try {
    const { quota, usage } = await storage.estimate();
    if (typeof quota !== 'number') return null;
    return Math.max(0, quota - (usage ?? 0));
  } catch {
    // Some embedded and privacy-hardened contexts throw rather than answer.
    return null;
  }
}

/**
 * Whether a raw export of this size can be built in tab memory, plus the
 * measured headroom when there was one, so the caller can say what it found
 * instead of just refusing.
 */
export async function fitsInTabMemory(
  estimatedBytes: number
): Promise<{ fits: boolean; availableBytes: number | null }> {
  const availableBytes = await availableStorageBytes();
  if (availableBytes === null) {
    return { fits: estimatedBytes <= RAW_MOV_MEMORY_LIMIT_BYTES, availableBytes };
  }
  return {
    fits: estimatedBytes <= availableBytes * MEMORY_QUOTA_HEADROOM,
    availableBytes,
  };
}

export type RawMovWriter = {
  write: (
    data: Uint8Array | { type: 'seek'; position: number }
  ) => Promise<void>;
  close: () => Promise<void>;
  abort: (reason?: unknown) => Promise<void>;
};

/** width * height * 4 * frameCount, exactly, before any frame is drawn. */
export function estimateMovBytes(width: number, height: number, frames: number): number {
  return width * height * 4 * frames;
}

/**
 * Let React paint progress and let input events update the cancellation ref.
 * MessageChannel yields to the browser without tying export to rAF, which can
 * stop running when the tab is in the background.
 */
function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

type RawMovOptions = {
  canvas: HTMLCanvasElement;
  fps: number;
  frames: number;
  drawFrame: (frame: number) => void;
  onProgress?: (done: number) => void;
  cancelled?: () => boolean;
};

function movieMetadata(
  width: number,
  height: number,
  fps: number,
  count: number,
  firstSampleOffset: number
): Uint8Array {
  const frameBytes = width * height * 4;
  const duration = count;

  const stsd = box('stsd', u32(0), u32(1), visualSampleEntry(width, height));
  const stts = box('stts', u32(0), u32(1), u32(count, 1));
  // All samples form one contiguous chunk. That keeps the offset table tiny,
  // even for a streamed file larger than 4 GB.
  const stsc = box('stsc', u32(0), u32(1), u32(1, count, 1));
  // Every raw frame is exactly the same size, so the compact constant-size
  // form applies: no 4-byte-per-sample size table needed.
  const stsz = box('stsz', u32(0), u32(frameBytes), u32(count));
  const stco = box('stco', u32(0), u32(1), u32(firstSampleOffset));
  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);

  const vmhd = box('vmhd', u32(0x00000001), u16(0, 0, 0, 0));
  const dref = box('dref', u32(0), u32(1), box('url ', u32(0x00000001)));
  const dinf = box('dinf', dref);
  const minf = box('minf', vmhd, dinf, stbl);

  const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(fps), u32(duration), u16(0x55c4, 0));
  const hdlr = box(
    'hdlr',
    u32(0),
    u32(0),
    fourcc('vide'),
    u32(0, 0, 0),
    new Uint8Array([...encoder.encode('Globe'), 0])
  );
  const mdia = box('mdia', mdhd, hdlr, minf);

  const tkhd = box(
    'tkhd',
    u32(0x00000007), // enabled, in movie, in preview
    u32(0), // created
    u32(0), // modified
    u32(1), // track id
    u32(0), // reserved
    u32(duration),
    u32(0, 0), // reserved
    u16(0, 0), // layer, alternate group
    u16(0, 0), // volume, reserved
    MATRIX,
    u32(width * 65536, height * 65536)
  );
  const trak = box('trak', tkhd, mdia);

  const mvhd = box(
    'mvhd',
    u32(0), // version and flags
    u32(0), // created
    u32(0), // modified
    u32(fps), // timescale
    u32(duration),
    u32(0x00010000), // rate 1.0
    u16(0x0100, 0), // volume, reserved
    u32(0, 0), // reserved
    MATRIX,
    u32(0, 0, 0, 0, 0, 0), // predefined
    u32(2) // next track id
  );

  return box('moov', mvhd, trak);
}

async function captureRawFrames(
  options: RawMovOptions,
  consume: (frame: Uint8Array) => void | Promise<void>
): Promise<{ count: number; frameBytes: number; width: number; height: number } | null> {
  const { canvas, frames, drawFrame, onProgress, cancelled } = options;

  // Draw before measuring. The canvas is only resized to the real output
  // size as a side effect of a frame actually being painted (renderFrame
  // -> composite), so reading canvas.width/height first can capture
  // whatever stale size — preview resolution, a previous export, anything —
  // happened to be sitting there, silently ignoring the dialed-in settings.
  drawFrame(0);
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const frameBytes = width * height * 4;
  let count = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    if (cancelled?.()) break;
    drawFrame(frame);
    const { data } = ctx.getImageData(0, 0, width, height);
    await consume(toBgra(data));
    count += 1;
    onProgress?.(count);
    await yieldToMainThread();
  }

  return { count, frameBytes, width, height };
}

export async function encodeRawMov(options: RawMovOptions): Promise<MovResult | null> {
  // Keep only frames actually drawn. Besides avoiding a full-size allocation
  // up front, this is what lets a cancelled export finish as a valid short MOV.
  const mediaFrames: Uint8Array[] = [];
  const capture = await captureRawFrames(options, (frame) => {
    mediaFrames.push(frame);
  });
  if (!capture?.count) return null;

  const { count, frameBytes, width, height } = capture;

  const ftyp = box('ftyp', fourcc('qt  '), u32(0x00000200), fourcc('qt  '));
  const mdatHeader = mediaDataHeader(frameBytes * count);
  // stco holds absolute file offsets, and the layout is ftyp then mdat.
  const firstSampleOffset = ftyp.length + mdatHeader.length;
  const moov = movieMetadata(width, height, options.fps, count, firstSampleOffset);

  return {
    // Passing frames as separate Blob parts avoids allocating another
    // contiguous copy of the entire movie when a partial export is saved.
    blob: new Blob(
      [ftyp, mdatHeader, ...mediaFrames, moov].map((part) => part.buffer as ArrayBuffer),
      {
        type: 'video/quicktime',
      }
    ),
    frames: count,
  };
}

/**
 * Stream raw samples directly to a user-selected file. The fixed 16-byte mdat
 * header is rewritten once the final frame count is known, then moov is
 * appended. Only one raw frame is retained in JavaScript at any moment.
 */
export async function encodeRawMovToWriter(
  options: RawMovOptions & { writer: RawMovWriter }
): Promise<MovFileResult | null> {
  const { writer } = options;
  const ftyp = box('ftyp', fourcc('qt  '), u32(0x00000200), fourcc('qt  '));
  const mdatOffset = ftyp.length;
  const placeholder = mediaDataHeader(0, true);

  try {
    await writer.write(ftyp);
    await writer.write(placeholder);

    const capture = await captureRawFrames(options, (frame) => writer.write(frame));
    if (!capture?.count) {
      await writer.abort();
      return null;
    }

    const { count, frameBytes, width, height } = capture;
    const payloadBytes = frameBytes * count;
    const firstSampleOffset = ftyp.length + placeholder.length;
    const mediaEnd = firstSampleOffset + payloadBytes;
    const moov = movieMetadata(width, height, options.fps, count, firstSampleOffset);

    await writer.write({ type: 'seek', position: mdatOffset });
    await writer.write(mediaDataHeader(payloadBytes, true));
    await writer.write({ type: 'seek', position: mediaEnd });
    await writer.write(moov);
    await writer.close();

    return { frames: count };
  } catch (error) {
    try {
      await writer.abort(error);
    } catch {
      // The stream may already have torn itself down after a disk error.
    }
    throw error;
  }
}
