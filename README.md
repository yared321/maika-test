# MAIKA Website

Marketing website for MAIKA.

## Structure

- `site/`: static site content (HTML/CSS/JS)

## Demo face scan (current logic)

The demo face scan (`site/demo/`) is now **MediaPipe-only** for browser-side detection/alignment.

- Runtime: `@mediapipe/tasks-vision`
- Default model type: `landmarker`
- Upload/scoring API behavior is unchanged (this affects client-side framing/quality gating only)

### Runtime config in `site/demo/index.html`

Current flow reads these meta tags:

- `maika-mediapipe-model-type` (`landmarker` or `detector`)
- `maika-mediapipe-js-cdn`
- `maika-mediapipe-wasm-root`
- `maika-mediapipe-model-url`
- `maika-mediapipe-delegate`
- `maika-mediapipe-min-detection-confidence`

`maika-face-detector-provider` can stay in markup for compatibility, but the active flow in
`site/demo/js/controller/face_scan_flow_controller.js` configures MediaPipe explicitly.

## Face scan quality pipeline

During align + record phases, the demo evaluates:

1. Face present
2. Face centered
3. Face size in range
4. Frontal pose
5. Forehead/cheeks/nose visibility
6. Mean luminance range
7. Overexposure ratio
8. Underexposure ratio
9. Left/right luminance symmetry
10. Brightness stability over time
11. Head motion per sample
12. FPS stability
13. Optional preliminary rPPG proxy

Thresholds are defined in `site/demo/js/controller/face_scan_flow_controller.js`
and consumed by quality helpers/controllers.

## Artifact policy and restart behavior

Recording quality now uses tiered artifact handling from
`site/demo/js/controller/face_scan_artifact_policy.js`:

- **Minor** (`1-4` fail samples): keep recording, track segment
- **Moderate** (`5-24`): pause recording + extend target by `2500ms` each time
- **Major** (`25+`): stop-level quality; sustained streak (`30+`) can abort recording

Additional guard: too many pause episodes (`recordingPauseCount > 5`) also triggers abort.

### Recording time behavior

- Base usable target: `RECORD_TARGET_MS = 30000`
- Wall-clock cap: `RECORD_MAX_WALL_CLOCK_MS = 45000`
- Moderate pauses can extend usable target up to `+12000ms` total

### Manual restart UX

On quality abort, the run is discarded and the UI shows:

- recovery card (`scan-recovery`)
- **Restart camera** action (manual user-triggered restart)
- **Cancel** action

No automatic restart loop is used.

## Post-scan startup behavior

Post-music scan now uses one entry path in `site/demo/js/demo.js`:

- `startPostScanCapture(dom, state)` handles all setup and starts camera once via
  `restartFaceScanForNewRecording()`
- removed extra `requestAnimationFrame(autoStartFaceScanDirectly)` call that previously could cause duplicate camera starts

## Face scan debug logging

Enable structured logs in DevTools:

- Meta tag: `maika-face-scan-debug="true"` in `site/demo/index.html`
- Or URL: `?faceScanDebug=1`

Filter by `[Maika FaceScan]`.

## Key face-scan files

- `site/demo/js/demo.js`
- `site/demo/js/controller/face_scan_flow_controller.js`
- `site/demo/js/controller/face_scan_camera_controller.js`
- `site/demo/js/controller/face_scan_recording_controller.js`
- `site/demo/js/controller/face_scan_artifact_policy.js`
- `site/demo/js/controller/face_scan_quality_checks.js`
- `site/demo/js/controller/face_scan_quality_helpers.js`
- `site/demo/js/utils/face_scan_face_model.js`
