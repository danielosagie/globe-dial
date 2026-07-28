#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENTRY = 'src/remotion/index.ts';
const COMPOSITION = 'GlobeVideo';
const DEFAULT_PROPS = './globe.props.json';

/**
 * Alpha lives in the codec, not in a flag you can bolt onto anything. Only
 * ProRes 4444 and VP9 can carry it, and both need PNG frames.
 */
const PLANS = {
  mp4: { codec: 'h264', ext: 'mp4', alpha: false },
  mov: { codec: 'prores', ext: 'mov', alpha: true },
  webm: { codec: 'vp9', ext: 'webm', alpha: true },
  gif: { codec: 'gif', ext: 'gif', alpha: false },
};

const args = process.argv.slice(2);
const valueOf = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const passthrough = args.filter(
  (arg) => !arg.startsWith('--props=') && !arg.startsWith('--out=')
);

const propsArg = valueOf('props');
const propsPath = propsArg ?? (existsSync(DEFAULT_PROPS) ? DEFAULT_PROPS : null);

let values = null;
if (propsPath) {
  if (!existsSync(propsPath)) {
    console.error(`No props file at ${propsPath}. Use Save JSON in the panel.`);
    process.exit(1);
  }
  try {
    values = JSON.parse(readFileSync(propsPath, 'utf8')).values ?? null;
  } catch (error) {
    console.error(`Could not read ${propsPath}: ${error.message}`);
    process.exit(1);
  }
} else {
  console.log('No props file, rendering panel defaults. Use Save JSON to export yours.');
}

const transparent = values?.stage?.transparent === true;
const requested = values?.record?.format ?? 'mp4';
let format = requested in PLANS ? requested : 'mp4';

if (transparent && !PLANS[format].alpha) {
  const fallback = 'mov';
  console.log(
    `${format} cannot carry an alpha channel. Rendering ${fallback} (ProRes 4444) so the transparent background survives.`
  );
  format = fallback;
}

const plan = PLANS[format];
const outPath = valueOf('out') ?? `out/globe.${plan.ext}`;
mkdirSync(dirname(resolve(outPath)), { recursive: true });

const flags = [`--codec=${plan.codec}`];

if (plan.codec === 'prores') {
  // 4444 is the only ProRes profile with an alpha channel. hq is smaller when
  // there is nothing to keep transparent.
  flags.push(`--prores-profile=${transparent ? '4444' : 'hq'}`);
}

if (transparent) {
  flags.push('--image-format=png');
  flags.push(`--pixel-format=${plan.codec === 'prores' ? 'yuva444p10le' : 'yuva420p'}`);
}

if (propsPath) flags.push(`--props=${propsPath}`);

const fps = values?.record?.fps;
const seconds = (values?.record?.turns ?? 1) * (values?.spin?.secondsPerTurn ?? 0);
console.log(
  [
    `format ${format}`,
    `codec ${plan.codec}`,
    transparent ? 'alpha yes' : 'alpha no',
    fps ? `${fps} fps` : null,
    seconds ? `${seconds}s` : null,
    `-> ${outPath}`,
  ]
    .filter(Boolean)
    .join('  ')
);

const bin = existsSync('node_modules/.bin/remotion') ? 'node_modules/.bin/remotion' : 'remotion';
const result = spawnSync(bin, ['render', ENTRY, COMPOSITION, outPath, ...flags, ...passthrough], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
