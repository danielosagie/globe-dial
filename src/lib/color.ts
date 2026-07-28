export type RGB = [number, number, number];

const HEX = /^#?([\da-f]{3,8})$/i;
const FUNC = /^rgba?\(([^)]+)\)$/i;

/** DialKit color controls hand back a CSS string. cobe wants 0-1 triplets. */
export function toRgb(input: string, fallback: RGB = [1, 1, 1]): RGB {
  const value = (input ?? '').trim();
  if (!value) return fallback;

  const hex = HEX.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .slice(0, 3)
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (digits.length < 6) return fallback;
    const n = Number.parseInt(digits.slice(0, 6), 16);
    if (!Number.isFinite(n)) return fallback;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  const func = FUNC.exec(value);
  if (func) {
    const parts = func[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number)
      .slice(0, 3);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
    }
  }

  return fallback;
}

export function rgbLiteral(rgb: RGB): string {
  return `[${rgb.map((n) => Number(n.toFixed(4))).join(', ')}]`;
}
