# Face scan — visual overlay and mesh renderer

This document covers the face-mesh canvas overlay drawn during align and record
phases: how the animated mesh works, what drives its lifecycle, the animation
cycle phases, the forehead expansion, and the color-state mapping.

For broader architecture context (how the renderer fits into the camera
controller), see [face-scan-architecture.md](face-scan-architecture.md). For
phone performance trade-offs (mesh off during record on phone), see
[face-scan-recording-performance.md](face-scan-recording-performance.md).

---

## Overview

A live wireframe of the MediaPipe 468-point face mesh is drawn on a canvas
overlay positioned over the camera preview. The mesh runs a looping scan
animation synchronized to the live landmark positions each frame.

| What | Where |
|------|-------|
| Canvas element | `#face-scan-mesh` in `site/demo/index.html` |
| CSS positioning | `site/demo/css/face_scanner_fx.css` (absolute over video; opacity fade-in/out) |
| Renderer | `site/demo/js/controller/face_scan_mesh_renderer.js` |
| Public API | `createFaceMeshRenderer(canvas, video)` → `{ draw, clear }` |
| Tessellation data | `FaceScanFaceModel.getFaceMeshTesselation()` in `face_scan_face_model.js` (populated once FaceLandmarker loads) |

The renderer is driven on every detection tick:
- **`syncFaceMesh(landmarks, ok)`** (in `face_scan_camera_fx.js`) calls
  `renderer.draw(landmarks, ok)` — starts the animation loop with fresh landmark data.
- **`clearFaceMesh()`** calls `renderer.clear()` — stops the loop and clears the canvas.
- Called from `face_scan_align_loop.js` (every tick on desktop; every 2nd tick on
  phone) and `face_scan_record_loop.js` (clears mesh during record on phone by default).

---

## Animation loop

The renderer uses a self-pacing `requestAnimationFrame` loop (`drawFrame`) that
reads the most-recent landmark snapshot set by `draw()`. The canvas is sized to
the CSS client area × `devicePixelRatio` each frame (`syncCanvasSize`) so it
stays crisp on HiDPI displays.

A **3.6-second cycle** (`CYCLE_MS = 3600`) repeats continuously while landmarks
are present:

| Phase | Timing | What is drawn |
|-------|--------|---------------|
| Build | 0 – 30% (0 – 1080 ms) | Mesh builds left → right behind a moving glow frontier line |
| Full  | 30 – 48% (1080 – 1728 ms) | Complete mesh held at full opacity |
| Sweep | 48 – 65% (1728 – 2340 ms) | Vertical glow bar sweeps left → right; mesh fades out in the bar's wake |
| Dots  | 65 – 86% (2340 – 3096 ms) | Sparse glowing dots at 15 key landmarks (eyes, nose, mouth, cheeks, forehead) |
| Fade  | 86 – 100% (3096 – 3600 ms) | Canvas cleared; cycle restarts |

All phase transitions use `easeInOut` easing for smooth acceleration/deceleration.

---

## Face bounding box constraint

Every moving element (frontier line, sweep bar) is constrained to the **live
face bounding box** — not the full canvas. The bounding box is recomputed each
frame from all 468 canvas-projected landmark positions:

```
faceMinX / faceMaxX / faceMinY / faceMaxY
faceW = faceMaxX - faceMinX
```

If all landmarks are null and `faceW ≤ 0`, the frame is skipped (guard against
degenerate state). This means:

- The build frontier line runs from `faceMinX` to `faceMinX + faceW`, not
  canvas edge to edge.
- The sweep bar spans `faceMinY` to `faceMaxY` vertically, not the full canvas
  height.
- The sweep X position is `faceMinX + sweepT × (faceW × 1.12) − faceW × 0.06`,
  so the bar overshoots slightly past the face edge before the phase ends.

---

## Forehead expansion (`MESH_EXPAND_TOP`)

The raw MediaPipe landmarks stop at the hairline. To make the mesh feel like it
reaches the forehead, points above the face centroid are stretched upward:

```
MESH_EXPAND_TOP = 1.30
```

In `toCvs(p)`, after projecting a landmark to canvas coordinates, if `cy <
centroidCY` the Y distance from the centroid is multiplied by `1.30`:

```js
if (cy < centroidCY) {
  cy = centroidCY + (cy - centroidCY) * MESH_EXPAND_TOP;
}
```

The centroid Y (`centroidCY`) is computed from a **small set of upper-face
landmarks only** (`CENTROID_INDICES`), not all 468 points. Using all 468 would
let chin and jaw points pull the centroid down, which would weaken the stretch
effect on forehead landmarks. `CENTROID_INDICES` contains forehead, temples, and
upper-cheek landmarks:

```
[10, 109, 338, 67, 297, 54, 284, 103, 332, 21, 251]
```

---

## Sweep phase detail (Fix 1)

During the sweep phase, each mesh segment fades out as the sweep bar passes it.
The alpha for a segment is proportional to how far the segment's midpoint is
behind the sweep position:

```js
var alpha = Math.max(0, Math.min(0.48,
  (sweepX - midX) / (faceW * 0.2) * 0.48
));
```

Each segment must be drawn with its own `beginPath()` / `stroke()` pair so the
`strokeStyle` is applied per-segment. A single shared `beginPath()` / `stroke()`
block would use only the last `strokeStyle` set, making all segments the same
alpha (the canvas API applies style at `stroke()` time, not `moveTo()` time).

---

## Color states

| State | Color | RGB |
|-------|-------|-----|
| Aligning (quality not yet passing) | Purple | `223, 122, 254` |
| Quality ok (all checks passing) | Green-teal | `118, 240, 191` |

The `ok` flag is passed to `draw(landmarks, ok)` on every tick from
`syncFaceMesh`. Both the mesh lines and the glow accent (frontier line, sweep
bar) use the same color. The color changes immediately on the next `drawFrame`
call after the flag changes.

---

## Key landmarks shown as tracking dots

During the Dots phase, 15 anatomically meaningful landmarks pulse with a
sinusoidal glow:

| Index | Anatomical location |
|-------|---------------------|
| 10 | Forehead center |
| 33 | Left eye inner corner |
| 133 | Left eye outer corner |
| 362 | Right eye inner corner |
| 263 | Right eye outer corner |
| 1 | Nose tip |
| 4 | Nose bridge |
| 61 | Left mouth corner |
| 291 | Right mouth corner |
| 175 | Chin center |
| 234 | Left cheek |
| 454 | Right cheek |
| 105 | Left eyebrow |
| 334 | Right eyebrow |
| 152 | Jaw bottom |

Dot pulse: `alpha = (0.55 + 0.45 × sin(now × 0.005)) × (1 − dotsT^2.5)`, where
`dotsT` is 0 → 1 across the Dots phase. This gives a pulsing fade-out toward
the end of the phase.

---

## Phone behavior

On phone, the mesh overlay is **cleared** during the 30-second recording phase
by default (`PHONE_RECORD_MESH_ENABLED = false` → `clearFaceMesh()` every tick
in `face_scan_record_loop.js`). Alignment still shows the full animated mesh.
During align on phone, `syncFaceMesh` is called every **2nd** tick
(`alignMeshEveryNTicks: 2`) to reduce main-thread load.

See [face-scan-recording-performance.md](face-scan-recording-performance.md#4-face-mesh-off-during-record)
for the measured frame-count impact of enabling mesh during record on phone.
