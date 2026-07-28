import { useDialKit } from 'dialkit';
import { DIALS } from './dialConfig';

export { DIALS, DEFAULT_VALUES, FONT_OPTIONS, type DialValues } from './dialConfig';
export { toStage, outputSize, durationSeconds, type StageSettings } from './settings';

export function useGlobeDials(onAction: (action: string) => void) {
  return useDialKit('Globe', DIALS, { id: 'globe-dial', persist: true, onAction });
}
