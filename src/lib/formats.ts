export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif';

/**
 * Alpha is a container and codec property, not a toggle. h264 has no alpha
 * channel at all, so mp4 can never carry a transparent background no matter
 * what the stage is set to. The two that can are ProRes 4444 in a mov and
 * VP9 in a webm, both of which need PNG frames on the Remotion side.
 */
export const EXPORT_FORMATS: {
  value: ExportFormat;
  label: string;
  alpha: boolean;
}[] = [
  { value: 'mp4', label: 'mp4', alpha: false },
  { value: 'mov', label: 'mov alpha', alpha: true },
  { value: 'webm', label: 'webm alpha', alpha: true },
  { value: 'gif', label: 'gif', alpha: false },
];

export const FORMAT_OPTIONS = EXPORT_FORMATS.map(({ value, label }) => ({ value, label }));

export function carriesAlpha(format: string): boolean {
  return EXPORT_FORMATS.find((entry) => entry.value === format)?.alpha ?? false;
}
