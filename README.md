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

Realtime browser capture drops frames whenever the machine hitches, and it can
never exceed the display refresh rate. Remotion renders offline, one frame at a
time, so 120 fps is real regardless of how long any frame took.

1. Dial it in, then `Save JSON` from the panel. You get `globe.props.json`.
2. Render it:

```bash
pnpm render --props=./globe.props.json
```

The script reads the JSON and picks the codec, profile and pixel format for you,
so you cannot land on a combination that quietly drops what you asked for. It
prints what it chose. Anything else you pass is forwarded to `remotion render`.

Width, height, fps and length come from the same JSON through
`calculateMetadata`, so the render matches the readout in the panel. Rotation is
derived from the frame number, not from a clock.

Also available: `pnpm render:png` for a frame sequence, `pnpm still` for a
poster, and `pnpm studio` to scrub the composition.

Renders need a named OpenGL backend, set in `remotion.config.ts` to `angle`.
On a machine with no display, pass `--gl=swangle`.

At 120 fps the default 24 second turn is 2880 frames. Shorten
`spin.secondsPerTurn` while you are iterating.

## Transparent background

Alpha is a property of the codec, not a flag. Verified behaviour:

| Format | Codec | Alpha |
| --- | --- | --- |
| `mov` | ProRes 4444, `yuva444p12le` | yes |
| `webm` | VP9, `yuva420p` | yes |
| `mp4` | h264 | **no**, h264 has no alpha channel |
| `gif` | gif | 1 bit only, no soft edges |

There is no transparent mp4. h264 cannot hold alpha, and while HEVC can in
principle, `hevc_videotoolbox -alpha_quality` was tried here and emitted a plain
`yuv420p` track with no alpha layer, byte for byte identical with and without
the flag.

### Transparent mov from the browser

No browser can *encode* alpha. `VideoEncoder.isConfigSupported` reports
`alpha: 'keep'` unsupported for avc, hevc, vp9, vp8 and av1, and MediaRecorder
only carries alpha in webm. There is no ProRes encoder in a browser either.

So a transparent export skips video encoding altogether. Each frame is taken as
a PNG, which already has an alpha channel and is lossless, and those frames are
muxed into a QuickTime container with the `png ` codec by `src/lib/mov.ts`. That
is a real QuickTime format, read with transparency by QuickTime, Final Cut,
Premiere, After Effects and Resolve.

Verified end to end: ffmpeg reports `codec_name=png`, `pix_fmt=rgba`, and every
frame decodes with corner alpha 0 and centre alpha 255.

Because frames are stored individually, size scales with resolution and length.
A 320 px 48 frame clip is about 1 MB. At 1800 px it will be far larger, so drop
`stage.scale` or shorten the clip if the file matters more than the fidelity.
Pick `webm` instead when the target is a web page: VP9 alpha through
MediaRecorder is much smaller, and that is the one path that still needs the tab
in front.

Turn on `stage.transparent`, pick `mov` or `webm`, and render. The panel warns in
the readout when the stage is transparent but the chosen format cannot store it,
and the render script upgrades mp4 to ProRes 4444 rather than silently flattening
the background, telling you it did.

`mov` is the one to hand to After Effects, Final Cut or Premiere. `webm` is the
one to put on a web page. Both were checked by reading back pixel alpha, not by
trusting the container metadata.

Note that ffmpeg's default decoder ignores WebM alpha side data, so extracting a
frame with ffmpeg makes a working transparent webm look opaque. Check it in a
browser instead.

### In the browser

Press `r`, or use Record in the panel. `Esc` stops early.

This encodes rather than records. Frames are drawn and handed to a WebCodecs
encoder one at a time through mediabunny, so the file holds exactly the frames
asked for at exactly the rate asked for, however long any single frame took.
A 2 second 120 fps export lands 240 samples at a timescale of 120, every time.

Because nothing waits on `requestAnimationFrame`, an export keeps running at
full speed in a background tab. It is also frequently faster than realtime.

Files are named from the container's magic bytes, so the extension always
matches what is inside. Renaming a `.webm` to `.mp4` does not transcode it.

A transparent stage exports as `.mov`, muxed here rather than encoded by the
browser. See below for why.

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

## Glow

cobe's glow is an atmosphere that fades into whatever sits behind the globe, not
a light source drawn on top of it. It only looks right when `color.glow` matches
the backdrop. Set them apart and the halo stops reading as a glow and starts
reading as a hard coloured ring around the sphere.

`color.glowFollowsBackground` is on by default and keeps the two in step. Turn it
off only if you are deliberately after a rim.

On a transparent stage there is no backdrop to match, so the glow blends into
whatever you composite onto later. Keep `stage.background` set to the colour you
intend to land on and leave the toggle on, even while transparent.

The glow is written with premultiplied alpha and a real falloff, so it composites
correctly anywhere alpha is honoured. Players that flatten alpha instead of
compositing it, including some desktop and chat-app players, show the glow at
full colour strength as a solid ring. That is the player, not the export. Check a
transparent render in a browser before concluding it is wrong.

## Text

`text.value` splits on `|` for multiple lines. `text.show` hides it without
losing what you typed.

## Notes

`pnpm-workspace.yaml` sets `minimumReleaseAge` to match Vercel's supply-chain
policy. Without it, pnpm resolves packages published minutes ago and the deploy
fails on `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.
