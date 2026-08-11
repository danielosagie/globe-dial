# Follow-up verification report

Date: 2026-08-11  
Environment: macOS, Chromium via Playwright CLI, Vite dev server at `127.0.0.1:5173`

## 0. Memory-exhaustion hang

### Starting state confirmed before edits

The round-one work was present and was not redone or reverted. The initial worktree was:

```text
## main...origin/main
 M README.md
 M src/App.tsx
 M src/lib/dialConfig.ts
 M src/lib/mov.ts
 M src/styles.css
```

The initial diff stat was:

```text
README.md             |  3 ++-
src/App.tsx           | 51 ++++++++++++++++++++++++++++++++-----------------
src/lib/dialConfig.ts |  4 ++--
src/lib/mov.ts        | 53 +++++++++++++++++++++++++++++++++++++++++++--------
src/styles.css        | 20 ++++++++++++++++++++
5 files changed, 102 insertions(+), 29 deletions(-)
```

The verified dangerous defaults were 24 seconds per turn, 120 fps, and an 1800 × 1800 output. That is 2,880 frames × 12,960,000 bytes = 37,324,800,000 bytes of raw BGRA sample data retained in the tab before the MOV could be downloaded.

### Fix

- Changed the fresh default `spin.secondsPerTurn` from 24 seconds to **4 seconds**. A default full turn is now 480 frames at 120 fps rather than 2,880.
- Added a **512,000,000-byte (512 MB decimal)** in-tab ceiling for raw MOV.
- An estimated MOV above that threshold cannot enter the in-memory encoder silently:
  - Chromium shows the exact estimated size, frame count, and dimensions in a blocking confirmation.
  - Confirming opens `showSaveFilePicker`; every BGRA frame is written immediately through `createWritable`, so JavaScript retains one raw frame rather than the entire movie.
  - Cancelling returns before `busyRef`, `stage.begin`, or frame capture is started.
  - A browser without File System Access is blocked with the same exact estimate and instructions to lower Stage scale, duration, fps, or turns, or use `pnpm render`.
- The streaming muxer writes `ftyp`, reserves a fixed 16-byte extended-size `mdat` header, writes samples sequentially, seeks back once to write the final 64-bit `mdat` size, then appends the small `moov` box once final frame count/duration are known. This removes the tab-heap ceiling without reserving a worst-case header.
- Kept the round-one per-frame `MessageChannel` yield and Stop button. Small-export testing below confirms cancellation was already wired; the unrecoverable 37 GB case was memory exhaustion, not a second cancel-path defect.

### Exact 2,880-frame reproduction

Using the real app and real Record button at 24 seconds, 120 fps, 1800 × 1800, the dialog text was:

```text
This would be ~37.3 GB of uncompressed BGRA data (2,880 frames at 1,800 × 1,800). Buffering it in this tab will likely exhaust memory and hang it.

Choose OK to save directly to disk while frames render, or Cancel to lower Stage scale, duration, fps, or turns.
```

After dismissing it, observed state was:

```text
elapsedMs: 389
progressPills: 0
downloads: 0
readout note: mov cancelled before capture (~37.3 GB)
```

Capture never reached frame 1. The hang is no longer reproducible.

Fresh storage at the new defaults produced the corresponding guard before capture:

```text
This would be ~6.22 GB of uncompressed BGRA data (480 frames at 1,800 × 1,800). Buffering it in this tab will likely exhaust memory and hang it.
progressPills: 0
```

### Direct-to-disk path

The writer branch was exercised in Chromium through the real Record button with a random-access test file handle. The estimate was 590 MB (1,440 frames at 320 × 320), which forced the guard and streaming branch. Stop was clicked while the pill read `9/1440`; the finalized file contained 18 frames because the React progress text lagged the encoder count. Writer state was `closed: true`, `aborted: false`.

`ffprobe` on that exact streamed partial output:

```text
codec_name=rawvideo
codec_tag_string=BGRA
width=320
height=320
avg_frame_rate=120/1
duration=0.150000
nb_read_packets=18
```

AVFoundation also reported `isPlayable: true` and decoded a frame successfully from the streamed output.

### Stop control isolation

Before the new work, a real Record/Stop run at 320 × 320, 2 seconds, 24 fps saved a valid 8.6 MB partial MOV rather than hanging. After the change, the same real UI flow showed Stop after 282 ms; clicking it produced the download 236 ms later. The exact partial file had 21 BGRA frames and 0.875 seconds duration:

```text
codec_tag_string=BGRA
avg_frame_rate=24/1
duration=0.875000
nb_read_packets=21
```

Conclusion: Stop is responsive at sane memory pressure. Daniel's apparent unresponsive Stop was the tab entering GC/memory exhaustion under the 37 GB allocation path.

## 1. Panel ergonomics

DialKit 1.4.3 was checked directly. `parseConfig` iterates `Object.entries(config)`, pushes controls in that order, and the React renderer maps that control array without sorting. Object key order is therefore the rendered folder order.

The folder order is now:

```text
Spin → Color → Globe → Stage → Markers → Text → Record → Output
```

`Globe` stays intact rather than splitting saved settings paths. Its first controls are Size, Offset X, and Offset Y, so position/framing remains coherent and appears immediately after Speed and Color. A headed Chromium screenshot and accessibility snapshot confirmed the rendered order, not just the object literal.

## 2. Performance

The live-preview sample used 120 idle `requestAnimationFrame` intervals and 90 intervals while Playwright generated a 60-step drag across Offset X. The export sample used a completed real Record-button raw MOV at 320 × 320, 3 seconds, 30 fps (90 frames, 36.9 MB of samples).

| Measurement | Before | After |
| --- | ---: | ---: |
| Idle average frame interval | 8.292 ms | 8.311 ms |
| Idle p95 | 9.900 ms | 9.300 ms |
| Idle max / intervals over 20 ms | 10.200 ms / 0 | 25.000 ms / 1 |
| Slider-drag average | 9.631 ms | 9.476 ms |
| Slider-drag p95 | 16.600 ms | 9.400 ms |
| Slider-drag max / intervals over 20 ms | 41.700 ms / 4 | 41.700 ms / 4 |
| 3-second MOV wall time | 830 ms | 773 ms |

The preview remained near the 120 Hz display cadence when idle and averaged about 105 fps during the synthetic slider drag. There was no sustained preview-loop bottleneck that justified speculative restructuring. The isolated long drag frames remain visible in the max/over-20-ms counts, but neither average nor p95 indicates persistent lag.

Chromium did identify one concrete raw-export issue before the change:

```text
Canvas2D: Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true.
```

The compositor now obtains its 2D context with `willReadFrequently: true`. The warning is gone, live preview timing did not regress, and the measured 90-frame export improved from 830 ms to 773 ms (about 7%). The 3-second clip exports in 0.773 seconds, about 3.9× faster than realtime, so yielding once per frame was retained for responsiveness rather than batched. No fps, frame count, resolution, or bitrate was reduced.

The hot-path review also confirmed that the canvas backing size and CSS size are assigned only when dimensions actually change. No redundant per-frame resize was found. Other allocations were not changed because the measurements did not show an actionable sustained cost.

## 3. Preview-only speed multiplier

Added `spin.previewSpeed`, range **0.25× to 8×**, step 0.25, default 1×. It multiplies only the incremental wall-clock angle when there is no recording anchor.

- Frame-stepped browser exports take the `exportFrameRef !== null` branch and derive phi only from frame index, fps, and `secondsPerTurn`.
- Realtime MediaRecorder capture has a non-null recording anchor and derives phi from elapsed recording time without the preview multiplier.
- Remotion already derives phi from frame number and never reads `previewSpeed`.

Proof used two real transparent MOV exports at 320 × 320, 2 seconds, 24 fps. The first was recorded at 1×. The Preview Speed slider was then moved through the real panel to `8.00`, the fast preview was allowed to run, and the second was recorded.

```text
48 frames
24/1 fps
2.000000 seconds
SHA-256 at 1×: 6763a929fd20bd3589dd8752e16d6b76c1b7c531ceeec0955ffdfd1867d0f0a2
SHA-256 at 8×: 6763a929fd20bd3589dd8752e16d6b76c1b7c531ceeec0955ffdfd1867d0f0a2
cmp exit: 0
```

The complete files, including `mdat`, were byte-identical. Preview speed has zero effect on recorded output.

## 4. End-to-end real-user playability

All three files below came from the running app through actual DialKit controls and an actual Record-button click. None was assembled by the probe.

### MOV, transparent raw BGRA

Panel state: transparent On, format MOV, 320 × 320, 2 seconds, 24 fps. Downloaded file size: 19,661,388 bytes. `ffprobe` independently counted 48 BGRA samples and 2.000000 seconds.

Verbatim Swift/AVFoundation probe output from the exact browser download:

```text
file: /Users/dosagie/Documents/CodeProjects/globe-dial/output/playwright/verification/e2e-real.mov
isPlayable: true
isReadable: true
tracks: 1 (video: 1)
fourCC: BGRA
copyCGImage: success
decodedSize: 320x320
actualTimeSeconds: 0.000000
cornerPixels: rgba(0,0,0,0) rgba(0,0,0,0) rgba(0,0,0,0) rgba(0,0,0,0)
cornerAlpha: 0 0 0 0
centerPixel: rgba(6,6,6,255)
centerAlpha: 255
```

The probe used `AVURLAsset.load(.isPlayable)`, `.load(.isReadable)`, `.load(.tracks)`, the track's format descriptions, `AVAssetImageGenerator.copyCGImage`, an explicit RGBA Core Graphics context, and `CFDataGetBytePtr` for the samples.

Quick Look provided a second AVFoundation-backed signal:

```text
Testing Quick Look thumbnails with files:
    e2e-real.mov
* .../e2e-real.mov produced one thumbnail
Done producing thumbnails
e2e-real.mov.png: PNG image data, 320 x 320, 8-bit/color RGBA, non-interlaced
```

### MP4, opaque H.264

Panel state: transparent Off, format MP4, 320 × 320, 2 seconds, 24 fps. The exact 1,031,403-byte download contained 48 H.264/`avc1` frames and 2.000000 seconds.

Verbatim `<video>`/canvas playback result from serving that exact downloaded file:

```json
{"readyState":4,"duration":2,"videoWidth":320,"videoHeight":320,"currentTime":0.250565,"paused":true,"drawableFrame":true,"centerRgba":[6,6,6,255],"cornerRgba":[12,12,12,255],"mediaError":null}
```

### WebM, transparent VP9

Panel state: transparent On, format WebM, 320 × 320, 2 seconds, 24 fps. The exact 734,818-byte download contained 48 VP9 packets; its measured duration was 1.960510 seconds, as expected for realtime MediaRecorder capture.

Verbatim `<video>`/canvas playback result from serving that exact downloaded file:

```json
{"readyState":4,"duration":1.96051,"videoWidth":320,"videoHeight":320,"currentTime":0.251593,"paused":true,"drawableFrame":true,"centerRgba":[9,9,9,255],"cornerRgba":[255,255,255,1],"mediaError":null}
```

Both browser formats reached `HAVE_ENOUGH_DATA` (`readyState: 4`), advanced playback time, had no media error, and successfully drew decoded pixels to a canvas. The transparent WebM's corner alpha was 1 while its center alpha was 255.

## 5. Static checks and final worktree

`pnpm build` passes (`tsc -b` and Vite production build). `git diff --check` passes. A final `pnpm dev --host 127.0.0.1` start reached Vite ready in 162 ms, and `curl -fsS http://127.0.0.1:5173/` returned the app HTML. The Vite build retains its pre-existing informational warning that the main minified bundle exceeds 500 kB.

Final `git status --short --branch` and `git diff --stat` are recorded below after generated browser/probe artifacts were removed:

```text
## main...origin/main
 M README.md
 M src/App.tsx
 M src/GlobeStage.tsx
 M src/lib/dialConfig.ts
 M src/lib/mov.ts
 M src/lib/settings.ts
 M src/styles.css
?? TEST_REPORT.md
```

```text
README.md             |  14 +++-
src/App.tsx           | 139 ++++++++++++++++++++++++++++++-------
src/GlobeStage.tsx    |   8 ++-
src/lib/dialConfig.ts |  53 +++++++-------
src/lib/mov.ts        | 187 +++++++++++++++++++++++++++++++++++++++++---------
src/lib/settings.ts   |   2 +
src/styles.css        |  20 ++++++
7 files changed, 339 insertions(+), 84 deletions(-)
```

`TEST_REPORT.md` is untracked, so Git does not include it in `git diff --stat` until it is added to the index.
