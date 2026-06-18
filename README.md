# MAIKA Website

Marketing website for MAIKA.

## Structure

- `site/`: static site content (HTML/CSS/JS)

## Demo face scan

The demo face scan (`site/demo/`) uses MediaPipe in the browser for face
detection, quality gating, and recording a 30-second video clip for rPPG
assessment.

### Documentation

| Document | What it covers |
|----------|----------------|
| [doc/face-scan-architecture.md](doc/face-scan-architecture.md) | File ownership, configuration constants, and the complete data flow from page load through camera capture, quality gating, recording, and upload |
| [doc/face-scan-recording-performance.md](doc/face-scan-recording-performance.md) | Phone vs desktop tuning, measured frame-count results, quality gate compliance (multi-face, FPS gate, skip-scan), optional metadata fields, and rollback guide |
| [doc/face-scan-visual-overlay.md](doc/face-scan-visual-overlay.md) | Face mesh canvas overlay: animation cycle, bounding box constraint, forehead expansion, sweep phase mechanics, color states |
| [doc/face-scan-pre-production-testing.md](doc/face-scan-pre-production-testing.md) | Pre-production checklist, all 13 quality controls, performance acceptance criteria, and sign-off template |

### Quick reference

**MediaPipe runtime** is configured via `<meta>` tags in `site/demo/index.html`:
`maika-mediapipe-model-type`, `maika-mediapipe-js-cdn`, `maika-mediapipe-wasm-root`,
`maika-mediapipe-model-url`, `maika-mediapipe-delegate`,
`maika-mediapipe-min-detection-confidence`.

**Phone production defaults** (both `false`):
- `PHONE_RECORD_LUMINANCE_CHECKS_ENABLED` — skip checks 6–9 during record on phone
- `PHONE_RECORD_MESH_ENABLED` — keep mesh overlay + Landmarker during record on phone

**Debug logging:** set `maika-face-scan-debug="true"` in `index.html` (or `?faceScanDebug=1`).
Filter DevTools by `[Maika FaceScan]`.
