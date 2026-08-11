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

/** width * height * 4 * frameCount, exactly, before any frame is drawn. */
export function estimateMovBytes(width: number, height: number, frames: number): number {
  return width * height * 4 * frames;
}

export async function encodeRawMov(options: {
  canvas: HTMLCanvasElement;
  fps: number;
  frames: number;
  drawFrame: (frame: number) => void;
  onProgress?: (done: number) => void;
  cancelled?: () => boolean;
}): Promise<MovResult | null> {
  const { canvas, fps, frames, drawFrame, onProgress, cancelled } = options;

  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const frameBytes = width * height * 4;
  const mediaData = new Uint8Array(frameBytes * frames);
  let count = 0;

  for (let frame = 0; frame < frames; frame += 1) {
    if (cancelled?.()) break;
    drawFrame(frame);
    const { data } = ctx.getImageData(0, 0, width, height);
    mediaData.set(toBgra(data), count * frameBytes);
    count += 1;
    onProgress?.(count);
  }

  if (!count) return null;
  const usedBytes = count === frames ? mediaData : mediaData.subarray(0, count * frameBytes);
  const duration = count;

  const ftyp = box('ftyp', fourcc('qt  '), u32(0x00000200), fourcc('qt  '));
  const mdat = box('mdat', usedBytes);
  // stco holds absolute file offsets, and the layout is ftyp then mdat.
  const firstSampleOffset = ftyp.length + 8;

  const stsd = box('stsd', u32(0), u32(1), visualSampleEntry(width, height));
  const stts = box('stts', u32(0), u32(1), u32(count, 1));
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
  const moov = box('moov', mvhd, trak);

  return {
    blob: new Blob([concat([ftyp, mdat, moov]).buffer as ArrayBuffer], {
      type: 'video/quicktime',
    }),
    frames: count,
  };
}
