import type { StageSettings } from './settings';

/**
 * One paint path for both surfaces: the browser preview and the Remotion
 * render. Anything drawn here ends up in the recording, which is why the text
 * lives in the canvas rather than in DOM on top of it.
 *
 * `scale` is output pixels per stage unit. The preview passes a smaller scale
 * than the export so it can render at native device resolution and stay crisp.
 */
export function paintStage(
  ctx: CanvasRenderingContext2D,
  globeCanvas: CanvasImageSource,
  settings: StageSettings,
  width: number,
  height: number,
  scale: number
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;

  if (settings.background.transparent) {
    ctx.clearRect(0, 0, width, height);
  } else {
    ctx.fillStyle = settings.background.color;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const size = settings.globe.size * scale;
  const x = (width - size) / 2 + settings.globe.offsetX * scale;
  const y = (height - size) / 2 + settings.globe.offsetY * scale;
  ctx.drawImage(globeCanvas, x, y, size, size);

  paintText(ctx, settings, width, height, scale);
}

function paintText(
  ctx: CanvasRenderingContext2D,
  settings: StageSettings,
  width: number,
  height: number,
  scale: number
) {
  const text = settings.text;
  if (!text.show || !text.value.trim()) return;

  const size = text.size * scale;
  ctx.save();
  ctx.font = `${text.weight} ${size}px ${text.font}`;
  ctx.textAlign = text.align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = text.color;
  ctx.globalAlpha = text.opacity;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${text.tracking}em`;

  const lines = text.value.split('|');
  const step = size * text.lineHeight;
  // Whole device pixels keep glyph rasterization from softening.
  const originX = Math.round(text.x * width);
  const originY = text.y * height - ((lines.length - 1) * step) / 2;
  lines.forEach((line, index) =>
    ctx.fillText(line.trim(), originX, Math.round(originY + index * step))
  );

  ctx.restore();
}
