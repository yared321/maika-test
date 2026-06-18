# Face scan — pre-production testing guide

Use this checklist before pushing the demo face-scan feature to production.
It covers the full wizard flow (access code → baseline scan → music → post-music
scan → results), all 13 frontend quality controls, phone vs desktop behavior,
performance targets, upload/API integration, and common failure modes.

For architecture and file ownership, see
[face-scan-architecture.md](face-scan-architecture.md). For phone/desktop tuning
and frame-count targets, see
[face-scan-recording-performance.md](face-scan-recording-performance.md).

---

## 1. Pre-production gate (must pass before deploy)

Complete this section first. Any **blocker** item fails the release.

| # | Item | How to verify | Blocker? |
|---|------|---------------|----------|
| 1 | **Debug logging off in production HTML** | In `site/demo/index.html`, set `maika-face-scan-debug` to `false` or remove the meta tag. Confirm DevTools shows no `[Maika FaceScan]` banner on load. | **Yes** |
| 2 | **No debug metadata writes in prod** | With debug off, complete a recording. Network tab must **not** show `POST /api/face-scan-debug-metadata`. | **Yes** |
| 3 | **Trial flags reviewed** | In `face_scan_flow_controller.js`, confirm production policy: `PHONE_RECORD_LUMINANCE_CHECKS_ENABLED = false` (skip checks 6–9 on phone during record; `true` costs ~45–60 frames). `PHONE_RECORD_MESH_ENABLED = false` (mesh off + BlazeFace during record; `true` forces Landmarker + mesh and costs ~70+ frames). | **Yes** |
| 4 | **HTTPS / localhost** | Face scan requires secure context. Test on production URL (HTTPS), not `file://`. | **Yes** |
| 5 | **Env vars on host** | Netlify/Cloudflare: demo verify, face-assess proxy, Turnstile, backend keys configured per `.dev.vars.example` / `.env.example`. | **Yes** |
| 6 | **MediaPipe CDN reachable** | Model + WASM load from configured CDN URLs (check Network tab on first scan). | **Yes** |
| 7 | **Gitignored debug artifacts** | `site/demo/data/meta_data/*.json` stays out of the commit (see `.gitignore`). | **Yes** |

---

## 2. Test environments

| Environment | Command / URL | Use for |
|-------------|---------------|---------|
| **Local dev** | `./run.sh` or `npm run dev` (maika-dev-proxy) | Full flow + optional debug metadata JSON writes |
| **Local static only** | `npx serve site` | UI smoke only — APIs and debug metadata POST will fail |
| **Staging / preview** | Netlify/Cloudflare preview URL | Production-like API routing before merge |
| **Production** | Live demo URL | Final sign-off after staging passes |

### Debug mode (local QA only)

Enable when you need metadata JSON files and structured console logs:

- Meta: `maika-face-scan-debug="true"` in `site/demo/index.html`, or
- URL: `?faceScanDebug=1`

Filter DevTools console by `[Maika FaceScan]`. Metadata files appear at
`site/demo/data/meta_data/face-scan-camera-metadata-<timestamp>.json` when
using `./run.sh` (not on static-only hosts).

**During performance tests:** keep the browser tab **focused** and DevTools
**closed** (or undocked) for the full 30 s recording. Background tabs and heavy
console logging can cause multi-second stalls that show up as low
`estimated_frame_count` and high `max_suppressed_gap_ms`.

---

## 3. Devices and browsers

Minimum matrix before production:

| Device class | Browser | Priority |
|--------------|---------|----------|
| **Desktop / laptop** | Chrome (latest) | Required |
| **Desktop / laptop** | Safari (macOS) | Required |
| **Phone** | Chrome Android | Required |
| **Phone** | Safari iOS | Required |
| **Tablet** (optional) | Safari iOS / Chrome | Recommended — may match phone perf profile |

Record which class the app chose via debug metadata (when enabled):

```json
"is_phone": true,
"record_framing_interval_ms": 350,
"skip_record_luminance_checks": true,
"defer_record_detector_load": true,
"record_video_bps": 1200000
```

Desktop reference:

```json
"is_phone": false,
"record_framing_interval_ms": 120,
"skip_record_luminance_checks": false,
"record_video_bps": 2200000
```

---

## 4. End-to-end wizard flow

The demo wizard has **4 steps** (0-indexed in code, 1–4 in UI):

| Step | UI label | What happens |
|------|----------|--------------|
| **1** | Baseline face scan | Pre-music scan; consent required; upload → auto-advance |
| **2** | Listen to music | Random track; Next enabled after 30 s; auto-advance at 60 s |
| **3** | Post-music face scan | Second scan; consent skipped; upload → auto-advance |
| **4** | Session result | Before/after arousal comparison + emotion map |

### 4.1 Demo access (landing)

| Test | Steps | Expected |
|------|-------|----------|
| Invalid code | Enter wrong code → submit | Error message; stay on landing |
| Valid code | Enter valid demo code (+ Turnstile if enabled) | Demo wizard unlocks; step 1 visible |
| Empty code | Submit with blank field | "Please enter your demo code" |

### 4.2 Step 1 — Baseline face scan

| Test | Steps | Expected |
|------|-------|----------|
| Consent gate | Leave checkbox unchecked → Start | Error: consent required; start disabled |
| Consent + start | Check consent → Start face scan | Camera permission prompt; model loading overlay |
| Happy path | Align → 3-2-1 → 30 s record → upload | Upload progress; wizard auto-advances to step 2 |
| Demographics gate | Try Next without age/gender if required | Wizard error; cannot proceed |

### 4.3 Step 2 — Music

| Test | Steps | Expected |
|------|-------|----------|
| Playback | Wait for track load → play | Waveform animates; audio audible |
| Proceed timing | Before 30 s | Next disabled (or blocked) |
| Auto-advance | Listen 60 s without clicking Next | Advances to step 3 |
| Back navigation | Back to step 1 | Music fades; baseline state restored appropriately |

### 4.4 Step 3 — Post-music face scan

| Test | Steps | Expected |
|------|-------|----------|
| Auto-start | Enter step 3 | Camera starts without consent checkbox (second scan) |
| No duplicate camera | Watch Network / camera indicator | Single `getUserMedia` — no double-start flicker |
| Happy path | Full scan + upload | Auto-advance to step 4 |
| Record again | From result panel, click Record again | New take; preview updates |

### 4.5 Step 4 — Results

| Test | Steps | Expected |
|------|-------|----------|
| Scores displayed | After both scans succeed | Baseline + post arousal values; emotion map renders |
| Valence slider | Adjust valence on step 3 panel | Reflected in result visualization |
| Incomplete session | Skip post scan (if possible in test build) | Graceful handling — no crash; missing data shown as "—" |

---

## 5. Face scan pipeline (phase by phase)

### 5.1 Model bootstrap

| Test | Expected |
|------|----------|
| First visit | "Preparing detector…" overlay; MediaPipe WASM + model fetch succeed |
| Slow network | Loading state persists until model ready; no silent failure |
| Start button | Disabled until model ready **and** consent checked (step 1 only) |

### 5.2 Camera permission

| Test | Expected |
|------|----------|
| Allow camera | Preview video appears; warmup tip shown |
| Deny camera | Denied overlay with retry/back actions |
| Revoke mid-session | Track `onended` → "Camera disconnected" recovery |

### 5.3 Warmup (~2.5 s)

| Test | Expected |
|------|----------|
| After stream attach | Tip: "Hold steady — preparing your camera…" |
| Before align gating | No quality pass/fail yet; ~2.5 s pause |
| After warmup | Alignment tip; mesh + guide ellipse active |

### 5.4 Alignment

| Test | Expected |
|------|----------|
| Stable alignment | **4** consecutive good samples → 3-2-1 countdown |
| Unstable face | Placement status updates in real time; countdown does not start |
| Mesh overlay | Green when OK, purple when failing (desktop: every tick; phone: every 2nd tick) |
| Multi-face | Second person in frame → "Multiple faces detected. Only one person should be in frame." |
| FPS gate (< 15 fps) | Check 12 fails; yellow **Record anyway** banner visible |
| FPS skip | Click Record anyway → countdown can proceed; `skipFpsGate` reset on new attempt |

### 5.5 Countdown

| Test | Expected |
|------|----------|
| 3-2-1 display | Overlay visible; cancel aborts back to align |
| Phone | BlazeFace prefetch during countdown (`deferRecordDetectorLoad`) |

### 5.6 Recording (30 s continuous)

| Test | Expected |
|------|----------|
| Duration | Recording pill shows ~0:30 / 0:30; stops automatically |
| Continuous take | **No pause/resume** — one uninterrupted clip |
| Minor quality dip | Recording continues; optional "hold still" guidance |
| Moderate degradation | Recording continues; degraded UI message |
| Major sustained failure | After ~12 s sustained major artifact → take **discarded**; recovery card |
| Wall-clock cap | If tab backgrounded badly, safety stop at 45 s max wall-clock |
| Music fade | Background music fades **after** blob ready (not at record start) |

### 5.7 Upload and result

| Test | Expected |
|------|----------|
| Upload progress | Progress UI animates; completes without error |
| Upload failure | Error message; Record again + retry options |
| Blob preview | Recorded video preview playable in result panel |
| MIME / codec | MP4 (`avc1`) on Chrome; reasonable fallback on Safari |

---

## 6. Quality controls — all 13 checks

Checks run in order during **align** and **record**. During **record** on
phone, checks 6–9 may be skipped (align-gated) depending on
`PHONE_RECORD_LUMINANCE_CHECKS_ENABLED`.

Use debug mode + `[Maika FaceScan] Quality [align|record]` logs to confirm
which check failed. Align phase uses full `console.table`; record phase logs
compact failed-check ids only.

| # | Check | How to trigger (test) | Expected user message |
|---|-------|----------------------|------------------------|
| 1 | Face present | Move out of frame | "Position your face in the frame." |
| 1 | Multi-face | Two faces in frame | "Multiple faces detected. Only one person should be in frame." |
| 2 | Face centered / size | Move off-center or too far/close | Direction hint (center / closer / farther) |
| 3 | Face size (telemetry) | — | Non-blocking; always passes once check 2 passed |
| 4 | Frontal pose | Turn head yaw/roll | "Turn to a frontal pose and face the camera directly." |
| 5 | Anatomy visible | Cover forehead, cheeks, or nose | Forehead / hand / visibility messages |
| 6 | Brightness range | Very dark room | "Move to a brighter place." |
| 6 | Brightness range | Strong direct light | "Reduce direct light on your face." |
| 7 | Overexposure | Harsh frontal light on skin | "Skin highlights are overexposed…" |
| 8 | Underexposure | Deep shadows on face | "Face shadows are too strong…" |
| 9 | L/R symmetry | Light one side only | "Use more even light on both sides of your face." |
| 10 | Brightness stability | Change lighting mid-align | "Avoid changing light or moving the phone." |
| 11 | Head motion | Move head quickly | "Hold still for a few seconds." |
| 12 | FPS stability | Heavy load / throttle (or slow device) | "Camera FPS is too low…" or "Frame rate is unstable…" |
| 13 | rPPG proxy | — | **Disabled** (`FACE_PRELIMINARY_RPPG_ENABLED = false`) |

### Record-phase differences (phone vs desktop)

| Check | Desktop (record) | Phone (record, default profile) |
|-------|------------------|----------------------------------|
| 1–3, 11–12 | Full @ 120 ms | Full @ 350 ms (coarser sampling) |
| 4–5 | Landmarker landmarks | BlazeFace box fallbacks (weaker pose/visibility) |
| 6–9 | Full luminance every tick | **Skipped** if `PHONE_RECORD_LUMINANCE_CHECKS_ENABLED = false` |
| 6–9 | Full | **Active** if trial flag `= true` |
| Mesh | Drawn every tick | Cleared every tick when `PHONE_RECORD_MESH_ENABLED = false` (default) |
| Mesh trial | — | On when `PHONE_RECORD_MESH_ENABLED = true` (forces Landmarker in record) |

---

## 7. Performance acceptance criteria

Run **three** clean takes per device class (tab focused, debug off for prod
sign-off; debug on for local metadata capture).

### Desktop (Mac / Windows laptop, Chrome)

| Metric | Pass threshold | Fail indicator |
|--------|----------------|----------------|
| `estimated_frame_count` | **≥ 850** (target ~880–900) | < 800 |
| `delivered_fps_overall` | **≥ 28.5** | < 27 sustained |
| `suppressed_gap_count` | **0** | ≥ 1 with `max_suppressed_gap_ms` > 2000 |
| `long_frame_fraction` | **< 0.01** | > 0.05 |
| `delivered_fps_p10` | **≥ 28** (near median) | ≤ 15 (tail stalls) |
| `recording_duration_ms` / `duration_ms` | ~30,000–30,200 | << 29,000 or >> 31,000 |
| `abort_reason` | `null` | Any abort on happy-path take |

### Phone (Android Chrome / iOS Safari)

| Metric | Pass threshold | Fail indicator |
|--------|----------------|----------------|
| `estimated_frame_count` | **≥ 780** (target ~820+) | < 700 |
| `delivered_fps_overall` | **≥ 25** | < 22 sustained |
| `long_frame_fraction` | **< 0.10** | > 0.20 |
| `is_phone` | `true` | `false` on known phone |
| `record_framing_interval_ms` | `350` | `120` on phone |
| `record_video_bps` | `1200000` (MP4) | Desktop bitrate on phone |

### Qualitative performance

- [ ] Countdown starts within ~1 s of stable alignment
- [ ] Mesh overlay does not visibly freeze for > 1 s during align
- [ ] Recording timer advances smoothly (no multi-second jumps)
- [ ] Upload starts within a few seconds of record stop
- [ ] No browser "page unresponsive" dialog during recording

---

## 8. Error recovery and edge cases

| Scenario | How to test | Expected |
|----------|-------------|----------|
| **Quality abort (major streak)** | Cover camera for 12+ s during record | Take discarded; recovery card; **Restart camera** + **Cancel** |
| **Manual restart** | Click Restart camera on recovery card | Clean new align flow; no stitched segments |
| **Cancel scan** | Cancel from recovery or intro | Returns to safe idle; streams stopped |
| **Camera retry** | Deny then allow on retry | Second permission flow works |
| **Tab background during record** | Switch tab 5+ s mid-record | May degrade FPS or hit wall-clock cap; must not corrupt UI |
| **Double Start click** | Rapidly click Start | `cameraRequestInFlight` prevents duplicate streams |
| **Navigate away mid-scan** | Browser back / close tab | Tracks stop (no orphaned camera LED) |
| **Record again (wizard)** | Complete scan → Record again | New blob; upload state reset |
| **Upload retry** | Simulate offline during upload | Error surfaced; user can retry or record again |
| **Skip FPS gate** | Slow device → Record anyway | Scan completes; check 12 shows `skippedGate: true` in debug logs |
| **New scan after skip** | Restart after skip | FPS gate enforced again (`skipFpsGate` cleared) |

---

## 9. Upload and API integration

Test on **staging/production-like** host (not local static-only).

| Test | Expected |
|------|----------|
| `POST /api/demo-verify` | Valid/invalid codes behave correctly |
| Face assess upload | Multipart upload succeeds; assessment JSON returned |
| CORS | Demo origin allowed; no browser CORS errors |
| Consent field | Upload includes `consent: true` when checkbox was checked |
| Error handling | 4xx/5xx show user-facing message, not raw stack traces |
| Beta register (if used) | `/api/beta-register` validates email + device type |

---

## 10. Security and privacy smoke tests

| Test | Expected |
|------|----------|
| Debug off in prod | No metadata POST; no verbose console logs |
| No secrets in client | View page source / bundled JS — no API keys |
| User-facing errors | No internal paths or stack traces in UI |
| Consent copy | Checkbox text visible on first scan only |
| Camera indicator | LED off after scan complete / cancel / navigate away |
| Dev-only debug route | `POST /api/face-scan-debug-metadata` returns 404 on Netlify/Cloudflare prod |

---

## 11. UI / accessibility spot checks

- [ ] Placement status messages readable on phone and desktop
- [ ] Recovery card visible and actionable on small screens
- [ ] Countdown overlay visible above video
- [ ] Face mesh and guide ellipse aligned with video crop
- [ ] Wizard Back/Next keyboard reachable
- [ ] Error regions use `role="alert"` where applicable
- [ ] Valence slider usable on touch devices

---

## 12. Regression checklist (quick pass)

Run after any face-scan code change:

1. [ ] Desktop happy path: step 1 → 2 → 3 → 4 complete
2. [ ] Phone happy path: same
3. [ ] Consent blocks start on step 1; skipped on step 3
4. [ ] Multi-face rejected during align
5. [ ] One quality-fail message spot-check (e.g. turn head → pose message)
6. [ ] Major abort → recovery → restart works
7. [ ] `estimated_frame_count` within thresholds (one take per class)
8. [ ] Upload succeeds on staging URL
9. [ ] Debug flag state matches intended environment

---

## 13. Known issues (review before production)

Track these from the latest code review; fix or accept before sign-off.

| Severity | Issue | Location | Notes |
|----------|-------|----------|-------|
| **Blocker** | Debug on in HTML | `site/demo/index.html` `maika-face-scan-debug="true"` | Set `false` or remove for prod (Section 1). |
| **High** | Multi-face check ineffective | `face_scan_face_model.js` `numFaces: 1` | Landmarker never returns `faceCount ≥ 2`; multi-face message won't trigger until `numFaces` is raised. |
| **High** | FPS tier skips motion/light checks | `face_scan_quality_helpers.js` `evaluateTemporalQuality` | At 15–24 fps, check 12 passes with warning but checks 10–11 are skipped (early return). |
| **Medium** | Skip scan button orphaned | `face_scan_flow_controller.js` → `maika-demo:face-scan-skipped` | No listener in `demo.js`; button resets UI but does not advance wizard. |
| **Medium** | `retryCount` not reset on new session | `face_scan_flow_controller.js` | Skip-scan offer can appear too soon after a prior failed session. |

---

## 14. Sign-off template

Copy and fill before merging to production:

```
Date:
Tester:
Environment URL:
Git commit / branch:

Devices tested:
  [ ] Desktop Chrome — pass / fail
  [ ] Desktop Safari — pass / fail
  [ ] Android Chrome — pass / fail
  [ ] iOS Safari — pass / fail

Pre-production gate (Section 1):  pass / fail
E2E wizard (Section 4):           pass / fail
Quality controls sampled:         pass / fail
Performance (Section 7):          pass / fail
  Desktop estimated_frame_count:
  Phone estimated_frame_count:
Upload/API (Section 9):           pass / fail

Blockers / notes:

Approved for production:  YES / NO
```

---

## Related files (when debugging failures)

| Symptom | First files to inspect |
|---------|------------------------|
| Low frame count | `face_scan_fps_monitor.js`, metadata `suppressed_gap_*` |
| Phone treated as desktop | `getDevicePerfConfig()` in `face_scan_flow_controller.js` |
| Quality false positives | Threshold constants in `face_scan_flow_controller.js` |
| Abort too early/late | `face_scan_artifact_policy.js` |
| Upload failures | `face_scan_upload_controller.js`, `service.js`, network Functions |
| Camera stuck | `face_scan_camera_stream.js`, `streamRequestGen` / `cameraRequestInFlight` |
| Debug metadata | `face_scan_recording_controller.js`, `face_scan_record_collector.js` |
