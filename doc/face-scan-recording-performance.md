# Face scan recording performance

This document describes everything we changed to improve **delivered frame count**
during the 30-second recording phase, enforce the client's quality-gate spec, and
add full camera metadata. The number of real camera frames captured in the uploaded
video is tracked via `estimated_frame_count` in debug metadata.

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
| **Current phone profile** | **~830** | **~27.2** | **~4.6%** | 350 ms loop + skip lum 6–9 + mesh off + BlazeFace (`…5293850.json`) |
| Luminance trial (6–9 on) | ~776–794 | ~25–26 | ~7–8% | `skip_record_luminance_checks: false` |
| Mesh + Landmarker trial | ~759 | ~25.1 | ~10% | `skip_mesh_during_record: false` (also switches off BlazeFace) |
| Mac reference (desktop path) | ~901 | ~29.7 | ~0.1% | Full-quality path |

**Current phone profile ≈ 92% of Mac frame count** (~70 frames remaining at ~830 vs ~901).

### Phone trial toggles (`face_scan/flow_controller.js`)

Production defaults (both `false`):

| Flag | Default | When `true` on phone |
|------|---------|----------------------|
| `PHONE_RECORD_LUMINANCE_CHECKS_ENABLED` | `false` | Runs checks 6–9 during record (`getImageData` every 350 ms). Align still gates lighting. ~45–60 fewer frames vs default. |
| `PHONE_RECORD_MESH_ENABLED` | `false` | Keeps mesh overlay during record **and** switches record detection back to **Landmarker** (BlazeFace has no landmarks for mesh). ~70+ fewer frames vs default; not mesh-only cost. |

Both flags are independent but mesh-on implicitly disables BlazeFace during record.

---

## How phone vs desktop is chosen

Detection runs once at init via `isLikelyPhoneRecordingDevice()` in
`face_scan/flow_controller.js`:

1. `navigator.userAgentData.mobile === true` when available (Chrome Android), or
2. `(pointer: coarse)` **and** `(hover: none)` (typical phones; excludes most touch laptops)

That drives `getDevicePerfConfig()` and mobile bitrates. It is **not** based on
screen width or user-agent string sniffing.

Verify on a run via debug metadata:

```json
"is_phone": true,
"record_framing_interval_ms": 350,
"skip_record_luminance_checks": true,
"skip_mesh_during_record": true,
"skip_mesh_during_align": true,
"use_detector_during_align": true,
"phone_mesh_intro_ms": 2000,
"defer_record_detector_load": true,
"record_video_bps": 1200000
```

---

## Shared optimizations (phone **and** desktop)

These apply to **both** device classes. They improve measurement accuracy and
align-phase behavior; they do not reduce recording-phase quality on desktop.

### 1. Real delivered-FPS monitor (`face_scan/fps_monitor.js`)

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

### 3. Camera warmup (`face_scan/warmup.js`)

- Fixed **2500 ms** after stream attach, before align gating (client spec).
- Separate `ctx.warmupSummary` baseline; does not pollute align rolling histories.

**Why it matters:** Stabilizes exposure/focus before quality gating; indirect
effect on record quality, not a record-phase CPU cut.

### 4. Align phase (device-specific)

Shared on both devices:

- **120 ms** align loop (`ALIGN_INTERVAL_MS`)
- Full quality checks 1–13 during align (including luminance 6–9)

| | Desktop | Phone (default profile) |
|---|---------|-------------------------|
| Detector | **Landmarker** every tick | **Landmarker** first 2 s, then **BlazeFace** |
| Mesh overlay | Every tick | First **2 s** only (`PHONE_MESH_INTRO_MS`), throttled every 2nd tick; cleared after |
| BlazeFace prefetch | At bootstrap (with Landmarker) | During countdown via `ensureRecordDetectorLoaded()` |

See [§4b Phone align mesh intro](#4b-phone-align-mesh-intro-2-s-landmarker-then-lite-path) below.

---

## Quality gate compliance updates

These changes bring the quality gates into alignment with the client's Frontend
Quality Control Plan (V2). They run on both phone and desktop.

---

### 1. Multi-face rejection — check 1 now requires exactly one face

**Before:** `check1FacePresent` passed whenever any face box was detected (`!!box`).
Two people in frame would not block the countdown or recording.

**After:** The raw detection payload (`face_scan/face_model.js`) now carries a
`faceCount` field:

- **Landmarker path:** `faceCount = res.faceLandmarks.length`
- **BlazeFace path:** `faceCount = detections.length`; if multiple faces are
  found but no primary box is returned, a `{ faceCount: N }` payload is still
  emitted so check 1 can fire.

`check1FacePresent(box, faceCount)` rejects when `faceCount > 1` with the message:
**"Multiple faces detected. Only one person should be in frame."**
The check detail records `{ reason: "multiple_faces", faceCount: N }`.

The `faceCount` value flows through:

```
detectWithLandmarker / detectWithDetector
  → extractFaceCountFromDetection()       (face_scan/detection_utils.js)
  → evaluateFaceQuality(…, faceCount)     (face_scan/quality_checks.js)
  → check1FacePresent(box, faceCount)
```

**Files changed:** `face_scan/face_model.js`, `face_scan/detection_utils.js`,
`face_scan/quality_checks.js`, `face_scan/align_loop.js`,
`face_scan/record_loop.js`

---

### 2. FPS minimum gate raised: 7 → 15

`FACE_MIN_STABLE_FPS` in `face_scan/flow_controller.js` was `7`; it is now `15`.

The check-12 gate in `evaluateTemporalQuality` fires once ≥ 8 rVFC samples are
collected. It now blocks the countdown until the device sustains ≥ 15 fps (from
those samples). A device running at, say, 12 fps will fail check 12 with:
**"Camera FPS is too low. Hold steady and close background apps."**

This matches the spec requirement: *FPS minimum ≥ 15*.

**File changed:** `face_scan/flow_controller.js`

---

### 3. "Record anyway" skip UI when FPS < 15 (debug only)

Production blocks below 15 fps during align — users see the placement error and must
**Restart camera** (no upload below threshold). For local testing on slow devices,
face-scan **debug mode** exposes an optional bypass.

**Production:** `skipFpsGate` is ignored unless debug is enabled (`?faceScanDebug=1`
or `maika-face-scan-debug="true"`). The FPS skip banner is hidden.

**Debug mode:**

1. `evaluateTemporalQuality` returns `fpsLow: true` when `fps < minFps` and
   `skipFpsGate` is not set.
2. `tickAlignment` shows `#fps-skip-banner` only when debug is on and `fpsLow`.
3. **"Record anyway"** sets `context.skipFpsGate = true` (debug click handler only).
4. Next tick: check 12 passes with `{ skippedGate: true }` in metadata.
5. `resetUiToStart` clears `skipFpsGate` on each new attempt.

**HTML element:** `<div id="fps-skip-banner">` (debug visibility only).  
**CSS:** `.fps-skip-banner`, `.fps-skip-message`, `.btn-fps-skip` in
`face_scanner.css`.

**Files:** `face_scan/quality_helpers.js`, `face_scan/align_loop.js`,
`face_scan/flow_controller.js`, `site/demo/index.html`, `site/demo/css/face_scanner.css`

---

### 4. FPS tiered behavior (15–20 and 20–25 ranges)

The spec defines graduated FPS behavior, not just a binary pass/fail at 15:

| Delivered FPS | Spec requirement | Implementation |
|--------------|------------------|----------------|
| < 15 | Block (production) | Hard block; restart camera. Debug: optional skip banner (see §3) |
| 15–19 | Allow only if face/light/motion are good | Passes check 12; placement status shows **"FPS is low (N fps). Close background apps for better quality."** |
| 20–24 | Allow with quality warning | Passes check 12; placement status shows **"FPS slightly low (N fps). Recording quality may be limited."** |
| ≥ 25 | Acceptable / preferred | Silent pass, normal alignment messages |

`evaluateTemporalQuality` now computes a `fpsTier` string (`"blocked"`, `"low"`,
`"caution"`, `"ok"`) and attaches it to the check-12 detail in metadata:

```json
{ "id": "12_frame_rate_stable", "pass": true, "detail": { "fps": 18.2, "tier": "low" } }
```

When `fpsTier` is `"low"` or `"caution"`, the function also returns an `fpsWarning`
string. `tickAlignment` uses this to replace the normal "Face aligned" message with
the warning text, using the `"wait"` (amber) placement state instead of `"good"`
(green) — so the user sees the caution without the countdown being blocked.

The stable-hit counter still increments; the countdown fires normally once hits are
reached. Only the user-facing guidance message changes.

**Files changed:** `face_scan/quality_helpers.js`, `face_scan/quality_checks.js`,
`face_scan/align_loop.js`

---

### 5. Two-step assessment upload (baseline + post)

The demo wizard uploads each scan to paired endpoints — not the legacy single
`/v1/web/assess` path.

| Phase | Endpoint | Pairing |
|-------|----------|---------|
| Baseline (wizard step 1) | `POST …/assess-baseline` | Response must include `baseline_token` |
| Post (wizard step 3) | `POST …/assess-post` | Requires `baseline_token` from baseline |

**Production rules** (`upload_controller.js`):

- Baseline without `baseline_token` in the response → error; user re-records baseline.
- Post without in-memory `baselineToken` → upload blocked; `maika-demo:baseline-pairing-required` resets wizard to baseline step.
- **No silent fallback** to `…/assess` when pairing is missing.

Legacy `…/assess` remains for standalone/non-wizard upload paths only.

**Files:** `upload_controller.js`, `service.js`, `demo.js`

---

### 6. ~~"Skip scan" offer~~ (removed)

The **Skip scan** button was removed from production. Quality failures offer
**Restart camera** only (`#btn-restart-camera` in recovery UI).

---

### 7. Internal quality grade A / B / C / D

The spec defines internal acquisition grades for metadata (never shown to the
user). `computeQualityGrade` runs once at recording stop, after all finalize
calls, and writes `quality_grade` to `cameraMetadata`.

| Grade | Condition |
|-------|-----------|
| **A** | `face_ok_fraction ≥ 0.90` **and** `delivered_fps_overall ≥ 25` |
| **B** | `face_ok_fraction ≥ 0.75` **and** `delivered_fps_overall ≥ 15` |
| **C** | `face_ok_fraction ≥ 0.50` |
| **D** | Below all thresholds, or `face_ok_fraction` unavailable |

`face_ok_fraction` is the fraction of record-phase quality ticks that passed all
active checks. `delivered_fps_overall` is the mean FPS across the full recording
(computed by `finalizeFpsRecordingMetadata` before grading runs).

**Why `delivered_fps_overall` and not `delivered_fps_min`?** A single brief stall
(e.g. one ~66 ms frame gap) would unfairly drag down the grade even when the rest
of the recording ran at 30 fps. The mean is more representative of sustained
delivery quality. `long_frame_fraction` captures stall severity separately.

**Example:** `face_ok_fraction: 0.825`, `delivered_fps_overall: 29.78` → grade
**B** (fps clears A threshold but ok_fraction 0.825 < 0.90).

**File changed:** `face_scan/recording_controller.js`

---

## Optional metadata fields

The client spec lists optional face-quality metadata fields to attach to each
recording. This section tracks which are implemented, where the data comes from,
and what remains.

All collection happens in `face_scan/record_collector.js` (`collectRecordTick`
called every detection tick during record) and is finalized at recording stop
(`finalizeRecordCollector`). Fields only appear in the debug JSON when their
source arrays have sufficient data — desktop-only fields are absent on mobile
recordings where luminance checks and mesh are skipped.

---

### Implemented — motion stability

| Field | Source | Desktop / Both |
|-------|--------|----------------|
| `center_jitter_mean` | Consecutive Euclidean deltas of face center (normalized to visible-region width), mean | Both |
| `center_jitter_p95` | Same deltas, 95th percentile | Both |
| `scale_jitter_mean` | Consecutive absolute deltas of `face_width_fraction`, mean | Both |
| `scale_jitter_p95` | Same deltas, 95th percentile | Both |
| `motion_score` | Finalize composite: `center_jitter_mean + scale_jitter_mean × 0.5` (lower = smoother) | Both |
| `severe_motion_fraction` | Fraction of check-11 ticks (non-skipped) where `motionFrac > maxMotionFrac` | Both |

Check 11 (`11_head_motion_low`) only activates once ≥ 6 rolling motion samples
exist, so warming-up ticks are excluded from `severe_motion_fraction`.

---

### Implemented — brightness / exposure

| Field | Source | Desktop / Both |
|-------|--------|----------------|
| `face_luma_mean` | Mean of per-tick `meanLuminance` from check-6 detail | Desktop |
| `face_luma_std` | Std dev of per-tick `meanLuminance` | Desktop |
| `face_luma_min` | Min of per-tick `meanLuminance` | Desktop |
| `face_luma_p05` | 5th-percentile of per-tick `meanLuminance` | Desktop |
| `near_white_face_pixel_fraction` | Mean of per-tick `overexposedRatio` from check-7 detail | Desktop |
| `near_black_face_pixel_fraction` | Mean of per-tick `underexposedRatio` from check-8 detail | Desktop |
| `brightness_asymmetry_mean` | Mean of per-tick `sideAsymmetryRatio` from check-9 detail | Desktop |
| `brightness_asymmetry_p95` | 95th-percentile of `sideAsymmetryRatio` | Desktop |
| `brightness_jump_count` | Count of check-10 ticks (non-skipped) where `pass: false` (rolling luma std exceeded threshold) | Desktop |
| `rolling_luma_std_mean` | Mean of per-tick `brightnessStd` from check-10 detail | Desktop |

Desktop-only because phone sets `skipRecordLuminanceChecks: true`, so checks
6–9 auto-pass as `align_gated` and produce no per-tick luma data. Check 10
relies on a brightness history that is never populated on phone.

---

### Implemented — face detection

| Field | Source | Desktop / Both |
|-------|--------|----------------|
| `face_lost_count` | Count of face-present → face-absent transitions (box present on previous tick, absent on this tick) | Both |
| `longest_face_lost_streak_ms` | Longest continuous absence duration in ms (using `performance.now()` timestamps); absent when face was never lost | Both |

An open loss streak at recording stop is closed using the stop timestamp passed
to `finalizeRecordCollector`.

---

### Implemented — head pose

| Field | Source | Desktop / Both |
|-------|--------|----------------|
| `head_yaw_mean` | Mean of per-tick `yawRatio` from check-4 detail (landmarks mode only) | Desktop |
| `head_roll_mean` | Mean of per-tick `rollRatio` from check-4 detail (landmarks mode only) | Desktop |
| `head_pitch_mean` | Mean of `pitchOk ? 1 : 0` per tick — fraction of frames with valid pitch (1.0 = always ok) | Desktop |
| `head_pose_bad_fraction` | `poseBadCount / poseRunCount` across ticks where check 4 ran with landmarks | Desktop |

`yawRatio` and `rollRatio` are normalized proxy values (0 = frontal/level,
higher = more turned/tilted). They are not angular degrees. Check 4 uses a
box-aspect heuristic on phone (`skipMeshDuringRecord: true`), which does not
produce `yawRatio` / `rollRatio`, so these fields are desktop-only in practice.

---

### Implemented — ROI visibility

| Field | Source | Desktop / Both |
|-------|--------|----------------|
| `forehead_visible_ratio` | Mean of per-tick `regions.forehead.skinFraction` from check-5 detail (skin\_classification mode) | Desktop |
| `left_cheek_visible_ratio` | Mean of `regions.leftCheek.skinFraction` | Desktop |
| `right_cheek_visible_ratio` | Mean of `regions.rightCheek.skinFraction` | Desktop |

`skinFraction` is the fraction of the sampled ROI patch that classifies as skin
tone (YCbCr-based). It proxies for how unoccluded the region is. Only populated
when check 5 runs in `skin_classification` mode (landmarks required). On phone,
check 5 falls back to a box-aspect heuristic that does not emit `regions`.

---

### Not implemented — blur detection

| Field | Why missing |
|-------|-------------|
| `blur_score_mean` | No blur detection exists in the pipeline. Would require a new Laplacian variance computation over the face ROI on each detection tick — new infrastructure. |
| `blur_bad_fraction` | Same — depends on a per-tick blur score and a threshold. |

---

### Summary table

| Field | Status |
|-------|--------|
| `center_jitter_mean` / `center_jitter_p95` | ✓ implemented |
| `scale_jitter_mean` / `scale_jitter_p95` | ✓ implemented |
| `motion_score` | ✓ implemented |
| `severe_motion_fraction` | ✓ implemented |
| `face_luma_mean` / `face_luma_std` / `face_luma_min` / `face_luma_p05` | ✓ implemented (desktop) |
| `near_white_face_pixel_fraction` / `near_black_face_pixel_fraction` | ✓ implemented (desktop) |
| `brightness_asymmetry_mean` / `brightness_asymmetry_p95` | ✓ implemented (desktop) |
| `brightness_jump_count` / `rolling_luma_std_mean` | ✓ implemented (desktop) |
| `face_lost_count` / `longest_face_lost_streak_ms` | ✓ implemented |
| `head_yaw_mean` / `head_roll_mean` / `head_pitch_mean` | ✓ implemented (desktop) |
| `head_pose_bad_fraction` | ✓ implemented (desktop) |
| `forehead_visible_ratio` / `left_cheek_visible_ratio` / `right_cheek_visible_ratio` | ✓ implemented (desktop) |
| `blur_score_mean` / `blur_bad_fraction` | ✗ not implemented — requires new blur detection |

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

**Files:** `face_scan/flow_controller.js`, `face_scan/record_loop.js`

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

**Files:** `face_scan/flow_controller.js`, `face_scan/recording_controller.js`

---

### 3. BlazeFace detector during record (not Landmarker)

| | Phone | Desktop |
|---|-------|---------|
| Align (first 2 s) | Face **Landmarker** + mesh intro | Face **Landmarker** + mesh |
| Align (after 2 s) | **BlazeFace FaceDetector** (box only) | Face **Landmarker** (full mesh) |
| Record | **BlazeFace FaceDetector** (box only) | Face **Landmarker** (full mesh) |

`useDetectorDuringRecord: true` → `detectSingleFaceForRecord()` in
`face_scan/record_loop.js`.

**Tradeoff:** No landmarks during record on phone → check 5 uses **box fallback**
instead of skin/landmark visibility (`face_scan/quality_helpers.js`). Align
already validated visibility.

**Files:** `face_scan/record_loop.js`, `face_scan/face_model.js`

---

### 4. Face mesh off during record

`skipMeshDuringRecord: true` → `clearFaceMesh()` on every record tick; no
wireframe canvas work while encoding.

**Tradeoff:** No live mesh overlay during the 30 s take. On phone, align shows mesh for the first 2 s only (`PHONE_MESH_INTRO_MS`); desktop keeps mesh for the full align phase.

**Files:** `face_scan/record_loop.js`, `face_scan/camera_fx.js`, `face_scan/align_loop.js`

---

### 4b. Phone align mesh intro (2 s Landmarker, then lite path)

**Phone only** — fixes pre-scan FPS on phones without affecting desktop.

| Phase | Phone align | Desktop align |
|-------|-------------|---------------|
| First 2 s | Landmarker + animated mesh (`syncFaceMesh`) | — (not used) |
| After 2 s | BlazeFace + mesh cleared (`detectSingleFaceForRecord`) | — |
| Full align | — | Landmarker + mesh every tick |

Controlled by `getDevicePerfConfig()`:

- `phoneMeshIntroMs: 2000` when `isPhone && !PHONE_RECORD_MESH_ENABLED`
- `phoneMeshIntroMs: 0` on desktop → `align_loop.js` keeps full mesh for entire align

**Files:** `face_scan/flow_controller.js`, `face_scan/align_loop.js`

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

**Files:** `face_scan/quality_checks.js`, `face_scan/record_loop.js`,
`face_scan/align_loop.js`

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

**Files:** `face_scan/face_model.js`, `face_scan/align_loop.js`,
`face_scan/helpers.js`

---

### 7. Throttled mesh during align (phone intro only)

`alignMeshEveryNTicks: 2` on phone → `syncFaceMesh` runs on every other align
sample during the 2 s mesh intro only (desktop: every tick).

**Tradeoff:** During the phone intro, mesh updates at ~4 Hz instead of ~8 Hz;
minor visual lag only. After 2 s the mesh is cleared entirely.

**Files:** `face_scan/align_loop.js`

---

## Desktop-only behavior (full-quality path)

Nothing was added **only** to speed up desktop. Desktop is the **baseline**:
all shared improvements above, plus the full recording-phase workload.

| Setting | Desktop value | Phone value |
|---------|---------------|-------------|
| Record loop interval | **120 ms** | **350 ms** |
| Record bitrate (MP4) | **2.2 Mbps** | **1.2 Mbps** |
| Detector during record | **Landmarker** | **BlazeFace** |
| Detector during align | **Landmarker** (every tick) | **Landmarker** 2 s intro, then **BlazeFace** |
| Mesh during record | **On** | **Off** |
| Luminance checks 6–9 during record | **Every tick** | **Skipped** (align-gated) |
| Model load at startup | **Landmarker + BlazeFace** | **Landmarker only** (BlazeFace deferred) |
| Mesh during align | **Every tick** (full Landmarker) | **2 s intro** then cleared; BlazeFace after |
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
| **Visual mesh during record on phone** | Set `PHONE_RECORD_MESH_ENABLED: true` (also re-enables Landmarker in record). Measured ~759 frames (−9% vs ~830 default); not a small cost. |
| **Landmark visibility checks during record** | Set `useDetectorDuringRecord: false` or enable mesh trial (same effect). Larger FPS cost. |
| **Desktop parity on phone** | Disable entire phone profile (not recommended on low-end devices). |
| **iPad / large touch device** | Review `isLikelyPhoneRecordingDevice()` — tablets may match phone heuristics today. |

### Suggested rollback order (if phone quality is too loose)

1. Re-enable checks 6–9 during record (`PHONE_RECORD_LUMINANCE_CHECKS_ENABLED = true`).
2. Reduce record interval 350 → 240 ms.
3. Re-enable mesh during record (`PHONE_RECORD_MESH_ENABLED = true` — also restores Landmarker in record).
4. Lower `recordCollectorEveryNTicks` or disable debug collector optimizations (dev only).

---

## Key source files

| File | Role |
|------|------|
| `site/demo/js/controller/face_scan/flow_controller.js` | Phone detection, `getDevicePerfConfig()`, trial toggles, `PHONE_MESH_INTRO_MS`, `FACE_MIN_STABLE_FPS`, restart-camera recovery |
| `site/demo/js/controller/face_scan/upload_controller.js` | Two-step upload routing (`assess-baseline` / `assess-post`), `baseline_token` pairing, no silent `/assess` fallback |
| `site/demo/js/service/service.js` | `ASSESS_PATHS`, `postRecording`, multipart FormData including `baseline_token` |
| `site/demo/js/demo.js` | Wizard step routing, `maika-demo:baseline-pairing-required` → reset to baseline |
| `site/demo/js/controller/face_scan/record_loop.js` | Record loop, detector choice, metrics sampling, `faceCount` extraction |
| `site/demo/js/controller/face_scan/align_loop.js` | Phone-only 2 s mesh intro then BlazeFace; desktop full mesh; deferred detector prefetch; debug-only FPS skip banner |
| `site/demo/js/controller/face_scan/quality_checks.js` | Skip checks 6–9, `check1FacePresent` multi-face logic, `fpsLow` / `fpsTier` / `fpsWarning` propagation |
| `site/demo/js/controller/face_scan/quality_helpers.js` | `evaluateTemporalQuality` — FPS gate, debug-only `skipFpsGate`, `fpsTier` + `fpsWarning` |
| `site/demo/js/controller/face_scan/detection_utils.js` | `extractFaceCountFromDetection` |
| `site/demo/js/utils/face_scan/face_model.js` | Landmarker vs BlazeFace, deferred load, `faceCount` in detection payloads |
| `site/demo/js/controller/face_scan/fps_monitor.js` | Delivered FPS measurement |
| `site/demo/js/controller/face_scan/camera_stream.js` | Debug metadata flags at stream start |
| `site/demo/js/controller/face_scan/recording_controller.js` | `record_video_bps` in metadata, `computeQualityGrade` → `quality_grade`, calls `finalizeRecordCollector` |
| `site/demo/js/controller/face_scan/record_collector.js` | Per-tick stats collector |
| `site/demo/index.html` | `#fps-skip-banner`, `#btn-fps-skip` (debug-only visibility) |
| `site/demo/css/face_scanner.css` | `.fps-skip-banner`, `.btn-fps-skip` styles |

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

**Multi-face check:** Trigger by having a second face in frame during align.
Confirm `1_face_present` check has `pass: false` and
`detail.reason === "multiple_faces"` with `detail.faceCount ≥ 2`.

**FPS gate (≥ 15, production):** On a slow device with debug **off**, confirm check 12
shows `pass: false` with `detail.fps < 15` and the user cannot proceed (restart only).

**FPS skip (debug only):** With debug on, confirm the yellow skip banner appears.
After clicking "Record anyway", confirm check 12 detail contains `"skippedGate": true`.

**FPS tier warning (15–24):** On a device delivering 15–24 fps, check 12 should
show `pass: true` with `detail.tier === "low"` or `"caution"`. The placement
status text should show the FPS warning message in amber rather than the normal
"Face aligned" green message. The countdown should still fire normally.

**Normal FPS pass (≥ 25):** Check 12 shows `pass: true`, `detail.tier === "ok"`,
no warning message, placement status is green.

**Two-step upload (wizard):** Complete baseline + post scans. Confirm baseline
response includes `baseline_token` and post upload uses `assess-post` (not legacy
`assess`). Clear `baselineToken` in devtools before post and confirm pairing
failure resets to baseline step.

**Quality grade:** After a successful take, confirm `quality_grade` is present in
the metadata JSON. Grade should be `"A"` when `face_ok_fraction ≥ 0.90` and
`delivered_fps_overall ≥ 25`; `"B"` when ok_fraction is 0.75–0.89 or fps is
15–24; `"C"` when ok_fraction is 0.50–0.74; `"D"` otherwise.

Filter DevTools console by `[Maika FaceScan]` for step logs (detector deferred
load, record loop interval, etc.).

**Optional metadata fields (desktop):** After a desktop take, confirm the
following groups appear in the metadata JSON:

- Motion: `center_jitter_mean`, `scale_jitter_mean`, `motion_score`,
  `severe_motion_fraction`
- Brightness: `face_luma_mean`, `face_luma_min`, `face_luma_p05`,
  `near_white_face_pixel_fraction`, `near_black_face_pixel_fraction`,
  `brightness_asymmetry_mean`, `brightness_jump_count`, `rolling_luma_std_mean`
- Face detection: `face_lost_count` (≥ 0 always present),
  `longest_face_lost_streak_ms` (only present when face was lost at least once)
- Head pose: `head_yaw_mean`, `head_roll_mean`, `head_pitch_mean`,
  `head_pose_bad_fraction`
- ROI: `forehead_visible_ratio`, `left_cheek_visible_ratio`,
  `right_cheek_visible_ratio`

On a phone recording, confirm that all desktop-only fields above are absent
(they depend on luminance data and landmark mesh that are skipped on phone).
`face_lost_count`, `motion_score`, `severe_motion_fraction`, `center_jitter_*`,
and `scale_jitter_*` should still be present on phone.
