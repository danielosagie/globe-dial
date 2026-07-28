import { Config } from '@remotion/cli/config';

// cobe is WebGL. Headless Chrome has no GPU backend unless one is named, and
// without this every frame fails with a null WebGL context.
// Use swangle instead on a machine with no display (CI, Lambda).
Config.setChromiumOpenGlRenderer('angle');

// The globe is fine dots and the text is thin. A jpeg intermediate smears both.
Config.setVideoImageFormat('png');
