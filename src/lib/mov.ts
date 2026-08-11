/**
 * A QuickTime muxer for PNG video, which is how this tool gets a transparent
 * .mov out of a browser.
 *
 * Nothing in a browser can encode an alpha channel into a normal video codec:
 * WebCodecs reports `alpha: 'keep'` unsupported for avc, hevc, vp9, vp8 and
 * av1, and MediaRecorder only carries alpha in webm. QuickTime's `png ` codec
 * sidesteps that entirely by storing each frame as a PNG, which already has an
 * alpha channel, is lossless, and is read with transparency by QuickTime,
 * Final Cut, Premiere, After Effects and Resolve.
 *
 * Frames are PNG compressed rather than raw, so a mostly transparent globe
 * stays reasonable. Raw RGBA at 1800px would be 13 MB per frame.
 */

const encoder = new TextEncoder();

function fourcc(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) out[i] = type.charCodeAt(i);
  return out;
}

function u8(...values: number[]): Uint8Array {
  return new Uint8Array(values);
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

function visualSampleEntry(width: number, height: number): Uint8Array {
  return box(
    'png ',
    u8(0, 0, 0, 0, 0, 0), // reserved
    u16(1), // data reference index
    u16(0, 0), // version, revision
    u32(0), // vendor
    u32(0), // temporal quality
    u32(512), // spatial quality
    u16(width, height),
    u32(0x00480000, 0x00480000), // 72 dpi
    u32(0), // data size
    u16(1), // frame count
    compressorName('PNG'),
    u16(32), // depth 32 signals colour plus alpha
    u16(0xffff) // colour table id -1
  );
}

export type MovResult = { blob: Blob; frames: number };

export async function encodePngMov(options: {
  canvas: HTMLCanvasElement;
  fps: number;
  frames: number;
  drawFrame: (frame: number) => void;
  onProgress?: (done: number) => void;
  cancelled?: () => boolean;
}): Promise<MovResult | null> {
  const { canvas, fps, frames, drawFrame, onProgress, cancelled } = options;

  const samples: Uint8Array[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    if (cancelled?.()) break;
    drawFrame(frame);
    // toBlob keeps the alpha channel and never touches requestAnimationFrame,
    // so this runs at full speed in a background tab.
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png')
    );
    if (!png) return null;
    samples.push(new Uint8Array(await png.arrayBuffer()));
    onProgress?.(frame + 1);
  }

  if (!samples.length) return null;

  const width = canvas.width;
  const height = canvas.height;
  const count = samples.length;
  const duration = count;

  const ftyp = box('ftyp', fourcc('qt  '), u32(0x00000200), fourcc('qt  '));
  const mediaData = concat(samples);
  const mdat = box('mdat', mediaData);
  // stco holds absolute file offsets, and the layout is ftyp then mdat.
  const firstSampleOffset = ftyp.length + 8;

  const stsd = box('stsd', u32(0), u32(1), visualSampleEntry(width, height));
  const stts = box('stts', u32(0), u32(1), u32(count, 1));
  const stsc = box('stsc', u32(0), u32(1), u32(1, count, 1));
  const stsz = box('stsz', u32(0), u32(0), u32(count), u32(...samples.map((s) => s.length)));
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
    u8(...encoder.encode('Globe'), 0)
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
