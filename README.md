# globe-dial

A DialKit playground for the cobe globe, with two ways out: a quick in-browser
capture, and a frame-exact Remotion render.

```bash
pnpm install
pnpm dev
```

Deployed at https://globe-dial.vercel.app

## How it works

The globe renders into an offscreen WebGL canvas. A second canvas composites
background, globe, and text every frame, and that composite is what you see and
what gets exported. Text is painted into the canvas rather than layered over it
in DOM, so it is captured too.

Every dial except `globe.resolution` is read live inside cobe's `onRender`, so
turning knobs never rebuilds the WebGL context.

The preview renders at native device pixels rather than at full output size.
Downsampling a 1800px canvas into a 650px box is what made text look rough.
Export briefly switches the same canvas up to full resolution first.

## Getting a video out

### Remotion, for anything you ship

Realtime browser capture drops frames whenever the machine hitches. Remotion
renders offline, one frame at a time, so the result is smooth regardless of how
long any frame took.

1. Dial it in, then `Save JSON` from the panel. You get `globe.props.json`.
2. Render it:

```bash
pnpm render --props=./globe.props.json
```

Also available: `pnpm render:gif`, `pnpm render:png` for a frame sequence,
`pnpm still` for a poster, and `pnpm studio` to scrub the composition.

Width, height, fps and length all come from the JSON through
`calculateMetadata`, so the render matches the readout in the panel. Rotation is
derived from the frame number, not from a clock.

For a transparent webm:

```bash
pnpm render --props=./globe.props.json --codec=vp8 --pixel-format=yuva420p out/globe.webm
```

Renders need a named OpenGL backend, set in `remotion.config.ts` to `angle`.
On a machine with no display, pass `--gl=swangle`.

### Browser capture, for a quick look

Press `r`, or use Record in the panel. `Esc` stops early.

- Duration is `record.turns` multiplied by `spin.secondsPerTurn`.
- Rotation is driven from the record start time rather than accumulated per
  frame, so the last frame lands on the first one and the clip loops.
- Recording starts from whatever angle is already on screen, so nothing jumps.
- `record.hidePanel` clears the panel and readout for the duration.

Keep the tab in front. A backgrounded tab pauses requestAnimationFrame, the
canvas stops updating, and the capture comes back empty. The app refuses to
start when the tab is hidden and reports a short file rather than saving one.

## Handoff

`Copy config` puts a ready `COBEOptions` object on the clipboard with colors
already converted to cobe's 0-1 triplets. `Save PNG` writes the current frame at
full resolution. DialKit's own Copy exports the raw panel JSON.

## Text

`text.value` splits on `|` for multiple lines. `text.show` hides it without
losing what you typed.

## Notes

`pnpm-workspace.yaml` sets `minimumReleaseAge` to match Vercel's supply-chain
policy. Without it, pnpm resolves packages published minutes ago and the deploy
fails on `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.
