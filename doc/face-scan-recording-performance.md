# Face scan recording performance

This document describes everything we changed to improve **delivered frame count**
during the 30-second recording phase — the number of real camera frames captured
in the uploaded video (~`estimated_frame_count` in debug metadata).

It is organized so you can decide what to keep, tune, or revert **per device class**
(phone vs desktop). For architecture and quality-check definitions, see
[face-scan-architecture.md](face-scan-architecture.md). For threshold values in
the shared pipeline, see the “Demo face scan” sections in [README.md](../README.md).

---

## Problem we were solving

On phone, the camera hardware delivers ~30 FPS, but main-thread work during
recording (MediaPipe inference, canvas/`getImageData`, H.264 encode) caused
**stalls** — gaps between frames where the browser could not keep up. That
showed up as:

- Low `delivered_fps_overall` (~7–26 FPS depending on stage)
- Low `estimated_frame_count` (~230–824 vs ~901 on Mac)
- High `long_frame_fraction` (share of inter-frame gaps &gt; ~67 ms)

Desktop (Mac) was already near the ceiling (~901 frames / ~29.7 FPS) without
phone-specific reductions.

---

## Measured results (phone progression)

Debug metadata files live in `site/demo/data/meta_data/` (gitignored; written
when `?faceScanDebug=1` or `maika-face-scan-debug` is on).

| Stage | `estimated_frame_count` | `delivered_fps_overall` | `long_frame_fraction` | Notes |
|-------|-------------------------|-------------------------|------------------------|-------|
| Baseline (no mobile tuning) | ~231 | ~7.6 | ~99% | Landmarker + mesh + full checks during record |
| Mesh off during record | ~272 | ~8.9 | ~89% | Global at the time |
| BlazeFace during record | ~638 | ~21 | ~23% | Lighter detector in record phase |
| 240 ms record loop | ~789 | ~26.0 | ~6.6% | Slower quality polling during record |
| **Current phone profile** | **~824** | **~26.9** | **~4.7%** | 350 ms loop + skip lum checks 6–9 + deferred BlazeFace |
| Mac reference (desktop path) | ~901 | ~29.7 | ~0.1% | Full-quality path |

**Current phone profile ≈ 91% of Mac frame count** (~77 frames remaining).

---

## How phone vs desktop is chosen

Detection runs once at init via `isLikelyPhoneRecordingDevice()` in
`face_scan_flow_controller.js`:

1. `navigator.userAgentData.mobile === true` when available (Chrome Android), or
2. `(pointer: coarse)` **and** `(hover: none)` (typical phones; excludes most touch laptops)

That drives `getDevicePerfConfig()` and mobile bitrates. It is **not** based on
screen width or user-agent string sniffing.

Verify on a run via debug metadata:

```json
"is_phone": true,
"record_framing_interval_ms": 350,
"skip_record_luminance_checks": true,
"defer_record_detector_load": true,
"record_video_bps": 1200000
```

---

## Shared optimizations (phone **and** desktop)

These apply to **both** device classes. They improve measurement accuracy and
align-phase behavior; they do not reduce recording-phase quality on desktop.

### 1. Real delivered-FPS monitor (`face_scan_fps_monitor.js`)

- Uses `video.requestVideoFrameCallback` (RAF + `video.currentTime` fallback).
- Feeds `ctx.quality.frameDtHistory` for quality check 12 (FPS stability).
- Writes recording-phase stats into `cameraMetadata` at record stop
  (`delivered_fps_overall`, `estimated_frame_count`, `long_frame_fraction`, etc.).
- **Artifact rejection:** intervals implying &gt; ~2× requested camera FPS are
  dropped (`minPlausibleFrameDtMs`) to avoid burst-after-stall measurement bugs.

**Why it matters:** We can trust `estimated_frame_count` when comparing tuning
changes. This does not by itself increase frame count.

### 2. Check 12 jitter threshold retune

- `FACE_MAX_FRAME_DT_STD_RATIO`: `0.45` → **`0.85`**
- Needed because check 12 now reads real ~30 FPS rVFC intervals instead of the
  old 120 ms poll cadence approximation.

**Why it matters:** Avoids false FPS-stability failures on healthy ~30 FPS
streams. Does not reduce main-thread load.

### 3. Camera warmup (`face_scan_warmup.js`)

- Fixed **2500 ms** after stream attach, before align gating (client spec).
- Separate `ctx.warmupSummary` baseline; does not pollute align rolling histories.

**Why it matters:** Stabilizes exposure/focus before quality gating; indirect
effect on record quality, not a record-phase CPU cut.

### 4. Align phase unchanged on both devices

- **120 ms** align loop (`ALIGN_INTERVAL_MS`)
- Full **Face Landmarker** (468-point mesh + box)
- Full quality checks 1–13 during align (including luminance 6–9)
- Mesh drawn every align tick on desktop; every **2nd** tick on phone only (see below)

---

## Phone-only optimizations (current profile)

All of the following are gated by `getDevicePerfConfig()` when `isPhone` is true.
Desktop does **not** use these.

### 1. Slower record-framing loop — **350 ms**

| | Phone | Desktop |
|---|-------|---------|
| Constant | `RECORD_FRAMING_INTERVAL_MS_PHONE = 350` | Uses `ALIGN_INTERVAL_MS` (**120**) |
| Ticks per 30 s take | ~86 | ~250 |
| `majorAbortStreak` | **34** (~12 s wall-clock at 350 ms) | **100** (~12 s at 120 ms) |

During record, the loop still runs face detection + framing checks (1–5, 10–12),
but **less often**, freeing the main thread for camera delivery and encode.

**Tradeoff:** Coarser mid-record quality feedback; brief lighting/pose issues
lasting &lt; 350 ms may be missed.

**Files:** `face_scan_flow_controller.js`, `face_scan_record_loop.js`

---

### 2. Lower recording bitrate

| | Phone | Desktop |
|---|-------|---------|
| MP4 | **1.2 Mbps** (`RECORD_VIDEO_BPS_MP4_MOBILE`) | **2.2 Mbps** |
| WebM | **1.0 Mbps** | **1.8 Mbps** |

Set in `getRecordVideoBitrates()`; applied when `MediaRecorder` starts.
Logged as `record_video_bps` in metadata.

**Tradeoff:** Slightly lower encode quality; usually fine for rPPG. Small FPS
gain on its own; helps when encode was contending with detection.

**Files:** `face_scan_flow_controller.js`, `face_scan_recording_controller.js`

---

### 3. BlazeFace detector during record (not Landmarker)

| | Phone | Desktop |
|---|-------|---------|
| Align | Face **Landmarker** | Face **Landmarker** |
| Record | **BlazeFace FaceDetector** (box only) | Face **Landmarker** (full mesh) |

`useDetectorDuringRecord: true` → `detectSingleFaceForRecord()` in
`face_scan_record_loop.js`.

**Tradeoff:** No landmarks during record on phone → check 5 uses **box fallback**
instead of skin/landmark visibility (`face_scan_quality_helpers.js`). Align
already validated visibility.

**Files:** `face_scan_record_loop.js`, `face_scan_face_model.js`

---

### 4. Face mesh off during record

`skipMeshDuringRecord: true` → `clearFaceMesh()` on every record tick; no
wireframe canvas work while encoding.

**Tradeoff:** No live mesh overlay during the 30 s take (align still shows mesh).

**Files:** `face_scan_record_loop.js`, `face_scan_camera_fx.js`

---

### 5. Skip luminance checks 6–9 during record

`skipRecordLuminanceChecks: true`:

- **No** `getImageData` / `sampleFaceRegionMetrics` during record (largest CPU win
  after detector choice).
- Checks 6–9 auto-pass with `mode: "align_gated"` in the quality trace.
- Align phase still enforces brightness, over/under-exposure, and symmetry before
  countdown.

`alignBaselineMetrics` is stored when countdown starts (for debug/trace).

**Tradeoff:** Lighting can change mid-take without re-checking 6–9. Acceptable if
align gate is trusted and users hold steady lighting.

**Files:** `face_scan_quality_checks.js`, `face_scan_record_loop.js`,
`face_scan_align_loop.js`

---

### 6. Deferred BlazeFace model load

`deferRecordDetectorLoad: true`:

- **Startup:** load **Landmarker only** (smaller initial memory/CPU).
- **Countdown (3-2-1):** prefetch BlazeFace via `ensureRecordDetectorLoaded()`.
- **Record:** `detectSingleFaceForRecord()` awaits detector if not ready.

Desktop loads **both** Landmarker + BlazeFace at bootstrap when
`modelType === "landmarker"`.

**Tradeoff:** BlazeFace must finish loading before first record tick; countdown
window usually covers this.

**Files:** `face_scan_face_model.js`, `face_scan_align_loop.js`,
`face_scan_helpers.js`

---

### 7. Throttled mesh during align (every 2nd tick)

`alignMeshEveryNTicks: 2` → `syncFaceMesh` runs on every other align sample only.

**Tradeoff:** Mesh updates at ~4 Hz instead of ~8 Hz during align; minor visual
lag only.

**Files:** `face_scan_align_loop.js`

---

## Desktop-only behavior (full-quality path)

Nothing was added **only** to speed up desktop. Desktop is the **baseline**:
all shared improvements above, plus the full recording-phase workload.

| Setting | Desktop value | Phone value |
|---------|---------------|-------------|
| Record loop interval | **120 ms** | **350 ms** |
| Record bitrate (MP4) | **2.2 Mbps** | **1.2 Mbps** |
| Detector during record | **Landmarker** | **BlazeFace** |
| Mesh during record | **On** | **Off** |
| Luminance checks 6–9 during record | **Every tick** | **Skipped** (align-gated) |
| Model load at startup | **Landmarker + BlazeFace** | **Landmarker only** (BlazeFace deferred) |
| Mesh during align | **Every tick** | **Every 2nd tick** |
| `majorAbortStreak` | **100** | **34** |

Desktop already achieves ~901 frames without phone reductions.

---

## Decision guide

Use this when choosing what to enable on a new device class or to relax phone
cuts.

| If you prioritize… | Consider… |
|--------------------|-----------|
| **Maximum frame count on phone** | Keep full phone profile (current). Biggest levers: skip 6–9, 350 ms loop, BlazeFace in record. |
| **Stricter mid-record lighting enforcement** | Set `skipRecordLuminanceChecks: false` on phone (re-enable `getImageData` each tick or throttled). Expect fewer frames. |
| **Finer quality sampling during record** | Lower `RECORD_FRAMING_INTERVAL_MS_PHONE` (e.g. 240 ms). Expect fewer frames. |
| **Visual mesh during record on phone** | Set `skipMeshDuringRecord: false`. Small FPS cost. |
| **Landmark visibility checks during record** | Set `useDetectorDuringRecord: false` (use Landmarker in record). Larger FPS cost. |
| **Desktop parity on phone** | Disable entire phone profile (not recommended on low-end devices). |
| **iPad / large touch device** | Review `isLikelyPhoneRecordingDevice()` — tablets may match phone heuristics today. |

### Suggested rollback order (if phone quality is too loose)

1. Re-enable checks 6–9 during record (keep 350 ms loop).
2. Reduce record interval 350 → 240 ms.
3. Switch record back to Landmarker (`useDetectorDuringRecord: false`).
4. Re-enable mesh during record.

---

## Key source files

| File | Role |
|------|------|
| `site/demo/js/controller/face_scan_flow_controller.js` | Phone detection, `getDevicePerfConfig()`, bitrate constants |
| `site/demo/js/controller/face_scan_record_loop.js` | Record loop, detector choice, metrics sampling |
| `site/demo/js/controller/face_scan_align_loop.js` | Align mesh throttle, deferred detector prefetch |
| `site/demo/js/controller/face_scan_quality_checks.js` | Skip checks 6–9 when `skipRecordLuminanceChecks` |
| `site/demo/js/utils/face_scan_face_model.js` | Landmarker vs BlazeFace, deferred load |
| `site/demo/js/controller/face_scan_fps_monitor.js` | Delivered FPS measurement |
| `site/demo/js/controller/face_scan_camera_stream.js` | Debug metadata flags at stream start |
| `site/demo/js/controller/face_scan_recording_controller.js` | `record_video_bps` in metadata |

---

## Debug checklist

1. Enable `?faceScanDebug=1` or meta `maika-face-scan-debug="true"`.
2. Complete a full 30 s take on phone.
3. Open `site/demo/data/meta_data/face-scan-camera-metadata-<timestamp>.json`.
4. Confirm phone flags and compare:
   - `estimated_frame_count` (primary metric)
   - `delivered_fps_overall`
   - `long_frame_fraction` (lower is better)
   - `delivered_fps_p10` (tail latency; should be near median when healthy)

Filter DevTools console by `[Maika FaceScan]` for step logs (detector deferred
load, record loop interval, etc.).
