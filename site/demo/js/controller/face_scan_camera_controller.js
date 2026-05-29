/**
 * Camera preview, getUserMedia, alignment / record face-framing loops, scan FX, countdown.
 */
import * as H from "../utils/face_scan_helpers.js";
import * as Dbg from "../utils/face_scan_debug.js";
import {
  getEffectiveRecordTargetMs,
  resetArtifactTimeline,
} from "./face_scan_artifact_policy.js";
import { evaluateFaceQuality } from "./face_scan_quality_checks.js";

var MAX_ALLOWED_RECORDING_PAUSES_BEFORE_RESTART = 5;

/**
 * Normalizes controller runtime state and guarantees quality-trace fields exist.
 * Returns the shared state object used by all camera-controller helpers.
 */
function createCameraControllerState(spec) {
  if (!spec.ctx.quality || typeof spec.ctx.quality !== "object") {
    spec.ctx.quality = {};
  }
  if (!Array.isArray(spec.ctx.quality.brightnessHistory)) {
    spec.ctx.quality.brightnessHistory = [];
  }
  if (!Array.isArray(spec.ctx.quality.greenHistory)) {
    spec.ctx.quality.greenHistory = [];
  }
  if (!Array.isArray(spec.ctx.quality.frameDtHistory)) {
    spec.ctx.quality.frameDtHistory = [];
  }
  if (!Array.isArray(spec.ctx.quality.motionHistory)) {
    spec.ctx.quality.motionHistory = [];
  }
  spec.ctx.quality.lastCenter = null;
  spec.ctx.quality.lastSampleAt = null;
  return {
    ctx: spec.ctx,
    el: spec.elements,
    cfg: spec.config,
    bridges: spec.bridges || {},
  };
}

/**
 * Hides camera-loading and camera-error overlays without changing stream state.
 */
function hideScanCameraStates(state) {
  if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
  if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.add("hidden");
}

/** Shows the camera-denied overlay with a readable failure reason. */
function showCameraDeniedOverlay(state, message) {
  if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
  if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.remove("hidden");
  if (state.el.scanOverlayDeniedText) state.el.scanOverlayDeniedText.textContent = message;
}

/** Stops the alignment polling interval if it is active. */
function stopAlignLoop(state) {
  if (state.ctx.alignTimer != null) {
    clearInterval(state.ctx.alignTimer);
    state.ctx.alignTimer = null;
  }
}

/** Resets recording-only timers, flags, and rolling quality histories. */
function resetRecordingBudget(state) {
  state.ctx.recordBudgetAccumMs = 0;
  state.ctx.recordBudgetLastSample = null;
  state.ctx.recordWallClockStartedAt = null;
  state.ctx.recordingFaceInGuide = false;
  state.ctx.recordingFramingReady = false;
  state.ctx.recordingPauseCount = 0;
  state.ctx.recordingPauseActive = false;
  state.ctx.quality.brightnessHistory = [];
  state.ctx.quality.greenHistory = [];
  state.ctx.quality.frameDtHistory = [];
  state.ctx.quality.motionHistory = [];
  state.ctx.quality.visibilityFailStreak = 0;
  resetArtifactTimeline(state.ctx);
  state.ctx.quality.lastCenter = null;
  state.ctx.quality.lastSampleAt = null;
}

function getRecordTargetMs(state) {
  return getEffectiveRecordTargetMs(state.ctx, state.cfg);
}

function placementMessageForArtifact(quality) {
  if (!quality || !quality.artifact) {
    return quality && quality.message ? quality.message : null;
  }
  var a = quality.artifact;
  if (a.effectiveAction === "track_minor") {
    return "Recording — hold still for best signal.";
  }
  if (a.effectiveAction === "pause_moderate") {
    return quality.message ? "Paused — " + quality.message : "Paused — adjust position or lighting.";
  }
  if (a.effectiveAction === "stop_major") {
    return quality.message
      ? "Paused — " + quality.message
      : "Paused — quality too low. Fix your setup to continue.";
  }
  return quality.message;
}

/** Returns true when the wall-clock recording cap has been reached. */
function isRecordingWallClockLimitReached(state, nowMs) {
  var startedAt = Number(state.ctx.recordWallClockStartedAt);
  var maxWallMs = Number(state.cfg.recordMaxWallClockMs) || 0;
  if (!Number.isFinite(startedAt) || startedAt <= 0 || maxWallMs <= 0) return false;
  return nowMs - startedAt >= maxWallMs;
}

/** Stops record framing loop and clears recording budget state. */
function stopRecordFramingLoop(state) {
  if (state.ctx.recordFramingTimer != null) {
    clearInterval(state.ctx.recordFramingTimer);
    state.ctx.recordFramingTimer = null;
  }
  resetRecordingBudget(state);
}

/** Shows a centered fallback target when ellipse geometry cannot be computed. */
function showFallbackTarget(state) {
  if (!state.el.faceScanTarget) return;
  state.el.faceScanTarget.classList.remove("hidden");
  state.el.faceScanTarget.style.left = "50%";
  state.el.faceScanTarget.style.top = "50%";
  state.el.faceScanTarget.style.width = "34%";
  state.el.faceScanTarget.style.height = "42%";
}

/** Applies directional target classes and updates movement hint text. */
function syncTargetGuide(state, direction) {
  if (!state.el.faceScanTarget) return;
  state.el.faceScanTarget.classList.remove(
    "guide-left",
    "guide-right",
    "guide-up",
    "guide-down",
  );
  if (direction === "left") state.el.faceScanTarget.classList.add("guide-left");
  else if (direction === "right") state.el.faceScanTarget.classList.add("guide-right");
  else if (direction === "up") state.el.faceScanTarget.classList.add("guide-up");
  else if (direction === "down") state.el.faceScanTarget.classList.add("guide-down");

  var guideEl = state.el.faceScanTarget.querySelector(".face-scan-target-guide");
  if (!guideEl) return;
  var labels = {
    left: "Move left",
    right: "Move right",
    up: "Move up",
    down: "Move down",
    near: "Move closer",
    far: "Move back",
    center: "Move to center",
  };
  var txt = labels[direction] || "";
  guideEl.textContent = txt;
  guideEl.classList.toggle("hidden", !txt);
}

/**
 * Updates visual face-scan overlays (clip, target, paused state) from detection state.
 * This affects UI only and does not change recorded video pixels.
 */
function syncFaceScanFx(state, optBox, alignOk, guideDirection) {
  if (!state.el.faceScanFx || !state.el.preview) return;
  var box = optBox && typeof optBox.width === "number" ? optBox : null;
  var show = state.ctx.phase === "record" || (state.ctx.phase === "align" && !!box);
  state.el.faceScanFx.classList.toggle("hidden", !show);

  if (state.el.faceScanClipEl && box && state.el.preview.readyState >= 2) {
    var ell = H.computeFaceScanEllipse(box, state.el.preview);
    if (ell) {
      var topFactor = 1.0;
      var bottomFactor = 0.93;
      var left = Math.max(0.8, ell.cxPct - ell.rxPct);
      var top = Math.max(0.8, ell.cyPct - ell.ryPct * topFactor);
      var right = Math.min(99.2, ell.cxPct + ell.rxPct);
      var bottom = Math.min(99.2, ell.cyPct + ell.ryPct * bottomFactor);
      var insetTop = top;
      var insetRight = 100 - right;
      var insetBottom = 100 - bottom;
      var insetLeft = left;
      var roundPct = Math.max(
        2.2,
        Math.min(10, Math.min((right - left) * 0.18, (bottom - top) * 0.18)),
      );
      state.el.faceScanClipEl.style.clipPath =
        "inset(" +
        insetTop.toFixed(2) +
        "% " +
        insetRight.toFixed(2) +
        "% " +
        insetBottom.toFixed(2) +
        "% " +
        insetLeft.toFixed(2) +
        "% round " +
        roundPct.toFixed(2) +
        "%)";
      if (state.el.faceScanTarget) {
        state.el.faceScanTarget.classList.remove("hidden");
        state.el.faceScanTarget.style.left = ell.cxPct.toFixed(2) + "%";
        var targetCenterY =
          ell.cyPct - (ell.ryPct * (topFactor - bottomFactor)) / 2;
        state.el.faceScanTarget.style.top = targetCenterY.toFixed(2) + "%";
        state.el.faceScanTarget.style.width = (ell.rxPct * 2).toFixed(2) + "%";
        state.el.faceScanTarget.style.height =
          (ell.ryPct * (topFactor + bottomFactor)).toFixed(2) + "%";
        syncTargetGuide(state, guideDirection);
      }
    } else {
      state.el.faceScanClipEl.style.clipPath = "inset(0)";
      if (state.el.faceScanTarget) {
        if (guideDirection) {
          showFallbackTarget(state);
          syncTargetGuide(state, guideDirection);
        } else {
          state.el.faceScanTarget.classList.add("hidden");
          syncTargetGuide(state, null);
        }
      }
    }
  } else if (state.el.faceScanClipEl) {
    state.el.faceScanClipEl.style.clipPath = "inset(0)";
    if (state.el.faceScanTarget) {
      if (guideDirection) {
        showFallbackTarget(state);
        syncTargetGuide(state, guideDirection);
      } else {
        state.el.faceScanTarget.classList.add("hidden");
        syncTargetGuide(state, null);
      }
    }
  }

  var recordPausedSoft =
    state.ctx.phase === "record" &&
    (!state.ctx.recordingFaceInGuide || !state.ctx.recordingFramingReady);
  var alignLoose = state.ctx.phase === "align" && !!box && alignOk === false;
  state.el.faceScanFx.classList.toggle(
    "face-scan-fx--paused",
    recordPausedSoft || alignLoose,
  );
}

/**
 * Normalizes provider-specific landmark payloads into an array of points.
 * Returns null when the active detector output does not include landmarks.
 */
function extractLandmarksFromDetection(detection) {
  if (!detection || typeof detection !== "object") return null;
  if (Array.isArray(detection.landmarks)) return detection.landmarks;
  if (
    detection.landmarks &&
    typeof detection.landmarks === "object" &&
    Array.isArray(detection.landmarks.positions)
  ) {
    return detection.landmarks.positions;
  }
  if (Array.isArray(detection.faceLandmarks)) return detection.faceLandmarks;
  return null;
}

/**
 * Normalizes detection box payloads to { x, y, width, height }.
 * Supports standard detector payloads and numeric safety checks.
 */
function extractBoxFromDetection(detection) {
  if (!detection || typeof detection !== "object") return null;
  var box = detection.box || null;
  if (!box || typeof box !== "object") return null;
  var x = Number(box.x);
  var y = Number(box.y);
  var width = Number(box.width);
  var height = Number(box.height);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: x, y: y, width: width, height: height };
}

/**
 * Runs one recording-phase quality tick.
 *
 * This function:
 * - Runs only while the controller is in `record` phase.
 * - If detector is disabled, it keeps recording continuously and only tracks elapsed
 *   recording budget until target duration is reached.
 * - If detector is enabled, it performs one face detection sample and evaluates
 *   quality gates (framing, pose, visibility, lighting, temporal stability).
 * - Pauses the recorder when quality fails and resumes when quality passes.
 * - Updates placement status text + face-scan overlay guidance in real time.
 * - Accumulates elapsed "valid recording" time and stops recorder when the
 *   configured recording target is reached.
 *
 * This is the main quality gate loop that makes recording self-correcting.
 */
function tickCameraRecordFraming(state) {
  if (state.ctx.phase !== "record" || !state.el.preview || !state.el.preview.videoWidth) return;
  if (!H.isDetectorEnabled()) {
    var recNoDet = state.ctx.recorder;
    if (!recNoDet) return;
    var now0 = performance.now();
    if (isRecordingWallClockLimitReached(state, now0)) {
      try {
        recNoDet.stop();
      } catch (esWall0) {}
      return;
    }
    state.ctx.recordingFaceInGuide = true;
    state.ctx.recordingFramingReady = true;
    H.safeRecorderResume(recNoDet);
    H.setPlacementUi(
      state.el.placementStatus,
      "good",
      "Recording — face guide off.",
    );
    syncFaceScanFx(state, null);
    if (recNoDet.state !== "recording") {
      state.ctx.recordBudgetLastSample = null;
      return;
    }
    if (state.ctx.recordBudgetLastSample == null) {
      state.ctx.recordBudgetLastSample = now0;
      return;
    }
    var dt0 = now0 - state.ctx.recordBudgetLastSample;
    if (dt0 > 0 && dt0 < 800) state.ctx.recordBudgetAccumMs += dt0;
    state.ctx.recordBudgetLastSample = now0;
    if (state.ctx.recordBudgetAccumMs >= getRecordTargetMs(state)) {
      try {
        recNoDet.stop();
      } catch (es0) {}
    }
    return;
  }

  if (state.ctx.detectionInFlight) return;
  state.ctx.detectionInFlight = true;

  H.detectSingleFace(state.el.preview)
    .then(function (detection) {
      state.ctx.detectionInFlight = false;
      if (state.ctx.phase !== "record") return;
      var rec = state.ctx.recorder;
      if (!rec) return;
      var box = extractBoxFromDetection(detection);
      var landmarks = extractLandmarksFromDetection(detection);
      var now = performance.now();
      if (isRecordingWallClockLimitReached(state, now)) {
        try {
          rec.stop();
        } catch (esWall) {}
        return;
      }
      var metrics = box ? H.sampleFaceRegionMetrics(state.el.preview, box) : null;
      var quality = evaluateFaceQuality(
        state,
        "record",
        box,
        landmarks,
        metrics,
        now,
      );

      // Primary restart trigger: sustained major artifact from policy.
      // Pause-count restart is an additional fallback trigger below.
      if (quality.artifact && quality.artifact.shouldAbortRecording) {
        Dbg.logFaceScanStep("record: aborting — sustained major artifact", quality.artifact);
        state.ctx.discardCurrentRecording = true;
        state.ctx.autoRestartCameraAfterAbort = true;
        state.ctx.qualityRestartMessage =
          "Signal stayed unstable for too long. Keep your face centered, hold still, and use steady lighting.";
        H.safeRecorderPause(rec);
        state.ctx.recordingFaceInGuide = false;
        H.setPlacementUi(
          state.el.placementStatus,
          "bad",
          "Signal was unstable for too long. Restarting camera for a clean measurement…",
        );
        try {
          rec.stop();
        } catch (_majorAbortStop) {}
        syncFaceScanFx(state, box, false, quality.direction || null);
        return;
      }

      if (quality.artifact && quality.artifact.shouldPauseRecorder) {
        if (!state.ctx.recordingPauseActive) {
          state.ctx.recordingPauseActive = true;
          state.ctx.recordingPauseCount =
            (Number(state.ctx.recordingPauseCount) || 0) + 1;
        }
        if (!state.ctx._lastRecordPauseLogged || state.ctx._lastRecordPauseLogged !== quality.message) {
          state.ctx._lastRecordPauseLogged = quality.message;
          Dbg.logFaceScanStep("record: recorder paused (artifact)", {
            tier: quality.artifact.tier,
            action: quality.artifact.effectiveAction,
            streak: quality.artifact.failStreak,
            pauseCount: state.ctx.recordingPauseCount,
            message: quality.message,
          });
        }
        if (state.ctx.recordingPauseCount > MAX_ALLOWED_RECORDING_PAUSES_BEFORE_RESTART) {
          Dbg.logFaceScanStep("record: aborting — too many pause events", {
            pauseCount: state.ctx.recordingPauseCount,
          });
          state.ctx.discardCurrentRecording = true;
          state.ctx.autoRestartCameraAfterAbort = true;
          state.ctx.qualityRestartMessage =
            "Recording was paused too many times (movement/lighting interruptions). Keep steady lighting and hold still so we can finish in one pass.";
          H.safeRecorderPause(rec);
          state.ctx.recordingFaceInGuide = false;
          H.setPlacementUi(
            state.el.placementStatus,
            "bad",
            "Too many pauses detected. Restarting camera for a cleaner recording…",
          );
          try {
            rec.stop();
          } catch (_pauseAbortStop) {}
          syncFaceScanFx(state, box, false, quality.direction || null);
          return;
        }
        state.ctx.recordingFaceInGuide = false;
        H.safeRecorderPause(rec);
        state.ctx.recordBudgetLastSample = null;
        H.setPlacementUi(
          state.el.placementStatus,
          "bad",
          placementMessageForArtifact(quality),
        );
        syncFaceScanFx(state, box, false, quality.direction || null);
        return;
      }

      if (state.ctx._lastRecordPauseLogged) {
        Dbg.logFaceScanStep("record: recorder resumed (quality pass)");
        state.ctx._lastRecordPauseLogged = null;
      }
      state.ctx.recordingPauseActive = false;
      state.ctx.recordingFaceInGuide = true;
      state.ctx.recordingFramingReady = true;
      H.safeRecorderResume(rec);
      var statusMsg = placementMessageForArtifact(quality) || "Recording...";
      H.setPlacementUi(
        state.el.placementStatus,
        quality.artifact && quality.artifact.effectiveAction === "track_minor"
          ? "wait"
          : "good",
        statusMsg,
      );
      syncFaceScanFx(state, box);

      if (rec.state !== "recording") {
        state.ctx.recordBudgetLastSample = null;
        return;
      }
      if (state.ctx.recordBudgetLastSample == null) {
        state.ctx.recordBudgetLastSample = now;
        return;
      }
      var dt = now - state.ctx.recordBudgetLastSample;
      if (dt > 0 && dt < 800) state.ctx.recordBudgetAccumMs += dt;
      state.ctx.recordBudgetLastSample = now;

      if (state.ctx.recordBudgetAccumMs >= getRecordTargetMs(state)) {
        try {
          rec.stop();
        } catch (es) {}
      } else {
        syncFaceScanFx(state, box);
      }
    })
    .catch(function () {
      state.ctx.detectionInFlight = false;
      syncFaceScanFx(state, null);
    });
}

/**
 * Runs one alignment-phase quality tick.
 *
 * This function:
 * - Runs only while the controller is in `align` phase.
 * - Samples the current frame, detects face, and evaluates the same quality checks
 *   used by recording mode.
 * - Increments `placementStableHits` while quality remains good.
 * - Resets stable hits when quality drops and surfaces directional guidance.
 * - When stable hits reach threshold, transitions phase to `countdown` and starts
 *   the 3-2-1 pre-record countdown.
 *
 * This is the alignment gate before recording starts.
 */
function tickAlignment(state) {
  if (state.ctx.phase !== "align") return;
  if (!state.el.preview) return;
  if (!H.isDetectorEnabled()) {
    stopAlignLoop(state);
    state.ctx.phase = "countdown";
    syncFaceScanFx(state, null);
    H.setPlacementUi(state.el.placementStatus, "wait", "Starting…");
    runCountdownThenRecord(state);
    return;
  }
  var reg =
    state.el.preview.readyState >= 2 ? H.getCoverVisibleRegion(state.el.preview) : null;
  if (!reg || reg.vw < 160) return;

  H.detectSingleFace(state.el.preview)
    .then(function (detection) {
      if (state.ctx.phase !== "align") return;
      var box = extractBoxFromDetection(detection);
      var landmarks = extractLandmarksFromDetection(detection);
      var metrics = box ? H.sampleFaceRegionMetrics(state.el.preview, box) : null;
      var quality = evaluateFaceQuality(
        state,
        "align",
        box,
        landmarks,
        metrics,
        performance.now(),
      );

      if (quality.ok) {
        state.ctx.placementStableHits++;
        if (state.ctx.placementStableHits === 1) {
          Dbg.logFaceScanStep("align: first stable quality pass");
        }
        var msg =
          state.ctx.placementStableHits >= state.cfg.stableHitCount - 1
            ? "Almost there — hold still."
            : state.ctx.placementStableHits >= state.cfg.stableHitCount - 2
              ? "Looking good."
              : "Face aligned — hold still.";
        H.setPlacementUi(state.el.placementStatus, "good", msg);
        if (state.ctx.placementStableHits >= state.cfg.stableHitCount) {
          Dbg.logFaceScanStep("align: stable hits reached, starting countdown", {
            hits: state.ctx.placementStableHits,
            required: state.cfg.stableHitCount,
          });
          stopAlignLoop(state);
          state.ctx.phase = "countdown";
          syncFaceScanFx(state, null);
          H.setPlacementUi(state.el.placementStatus, "wait", "Starting…");
          runCountdownThenRecord(state);
        }
      } else {
        state.ctx.placementStableHits = 0;
        H.setPlacementUi(
          state.el.placementStatus,
          "bad",
          quality.message || "Adjust face scan quality.",
        );
        syncFaceScanFx(state, box, false, quality.direction || null);
        return;
      }
      syncFaceScanFx(state, box, quality.ok, null);
    })
    .catch(function () {
      syncFaceScanFx(state, null);
    });
}

/** Starts alignment polling from a clean runtime state. */
function startAlignLoop(state) {
  stopAlignLoop(state);
  Dbg.resetFaceScanDebugDedupe("align");
  Dbg.resetFaceScanDebugDedupe("record");
  Dbg.logFaceScanStep("phase: align loop started");
  state.ctx.placementStableHits = 0;
  state.ctx.quality.brightnessHistory = [];
  state.ctx.quality.greenHistory = [];
  state.ctx.quality.frameDtHistory = [];
  state.ctx.quality.motionHistory = [];
  state.ctx.quality.lastCenter = null;
  state.ctx.quality.lastSampleAt = null;
  state.ctx.phase = "align";
  state.ctx.alignTimer = globalThis.setInterval(
    function () {
      tickAlignment(state);
    },
    state.cfg.alignIntervalMs,
  );
  tickAlignment(state);
}

/** Shows the 3-2-1 countdown overlay, then continues into recording. */
function runCountdownThenRecord(state) {
  return new Promise(function (resolve) {
    var n = 3;
    if (state.el.overlayCountdown) {
      state.el.overlayCountdown.hidden = false;
      state.el.overlayCountdown.classList.remove("hidden");
    }
    if (state.el.countdownNumber) state.el.countdownNumber.textContent = String(n);
    state.ctx.countdownTimer = globalThis.setInterval(function () {
      n--;
      if (n <= 0) {
        globalThis.clearInterval(state.ctx.countdownTimer);
        state.ctx.countdownTimer = 0;
        if (state.el.overlayCountdown) {
          state.el.overlayCountdown.hidden = true;
          state.el.overlayCountdown.classList.add("hidden");
        }
        document.dispatchEvent(
          new CustomEvent("maika-demo:face-scan-countdown-complete"),
        );
        var p = state.bridges.onCountdownDone && state.bridges.onCountdownDone();
        Promise.resolve(p).then(resolve);
        return;
      }
      if (state.el.countdownNumber) state.el.countdownNumber.textContent = String(n);
    }, 1000);
  });
}

/** Cancels active countdown timer and hides the countdown overlay. */
function cancelCountdown(state) {
  if (state.ctx.countdownTimer) {
    globalThis.clearInterval(state.ctx.countdownTimer);
    state.ctx.countdownTimer = 0;
  }
  if (state.el.overlayCountdown) {
    state.el.overlayCountdown.hidden = true;
    state.el.overlayCountdown.classList.add("hidden");
  }
}

/** Stops loops, closes media tracks, and resets camera runtime to idle. */
function stopStream(state) {
  stopRecordFramingLoop(state);
  stopAlignLoop(state);
  state.ctx.detectionInFlight = false;
  if (state.ctx.stream) {
    state.ctx.stream.getTracks().forEach(function (t) {
      t.stop();
    });
    state.ctx.stream = null;
  }
  if (state.el.preview) state.el.preview.srcObject = null;
  state.ctx.placementStableHits = 0;
  if (state.el.placementStatus) H.setPlacementUi(state.el.placementStatus, "wait", "…");
  state.ctx.phase = "idle";
  syncFaceScanFx(state, null);
}

/**
 * Starts camera capture and enters alignment flow.
 *
 * This function:
 * - Validates browser media support.
 * - Shows camera-loading overlay and requests front camera via getUserMedia.
 * - Attaches MediaStream to preview video when permission is granted.
 * - Hides loading/denied overlays, initializes placement UI, and waits for first
 *   frame (`onloadeddata`) so detector logic starts on a ready preview.
 * - Triggers integration callback (`onCameraReady`) and starts align loop.
 * - On failure, shows a human-readable denied/error overlay and returns to idle.
 *
 * This is the single entry point for camera startup in the scan flow.
 */
function requestCameraAndStartAlignment(state) {
  if (state.bridges.hideError) state.bridges.hideError();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraDeniedOverlay(state, "Camera needs HTTPS or localhost.");
    return;
  }

  if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.remove("hidden");
  if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.add("hidden");
  if (state.el.scanOverlayCameraText) {
    state.el.scanOverlayCameraText.textContent = "Requesting camera access…";
  }

  state.ctx.phase = "align";
  navigator.mediaDevices
    .getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280, min: 640 },
        height: { ideal: 720, min: 480 },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: false,
    })
    .then(function (mediaStream) {
      state.ctx.stream = mediaStream;
      if (state.el.preview) state.el.preview.srcObject = mediaStream;
      if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
      if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.add("hidden");
      if (state.el.overlayCountdown) state.el.overlayCountdown.hidden = true;
      H.setPlacementUi(
        state.el.placementStatus,
        "wait",
        "Position your face in the frame.",
      );
      return new Promise(function (resolve) {
        if (!state.el.preview) {
          resolve();
          return;
        }
        state.el.preview.onloadeddata = function () {
          state.el.preview.onloadeddata = null;
          resolve();
        };
      });
    })
    .then(function () {
      if (state.bridges.onCameraReady) state.bridges.onCameraReady();
      startAlignLoop(state);
    })
    .catch(function (e) {
      showCameraDeniedOverlay(state, H.friendlyCameraMessage(e));
      state.ctx.phase = "idle";
    });
}

/** Starts the recording-framing loop from a fresh recording budget. */
function startRecordFramingLoop(state) {
  stopRecordFramingLoop(state);
  Dbg.resetFaceScanDebugDedupe("record");
  Dbg.logFaceScanStep("phase: record framing loop started");
  state.ctx.recordFramingTimer = globalThis.setInterval(
    function () {
      tickCameraRecordFraming(state);
    },
    state.cfg.alignIntervalMs,
  );
  tickCameraRecordFraming(state);
}

/**
 * Builds the camera controller public API.
 *
 * This factory provides:
 * - Lifecycle controls (`requestCameraAndStartAlignment`, `stopStream`).
 * - Phase loop controls (`start/stopAlignLoop`, `start/stopRecordFramingLoop`).
 * - Overlay/FX helpers (`hideScanCameraStates`, `showCameraDeniedOverlay`, `syncFaceScanFx`).
 * - Countdown controls (`runCountdownThenRecord`, `cancelCountdown`).
 *
 * The returned object is the public integration surface consumed by
 * `face_scan_flow_controller.js`.
 */
export function createCameraController(spec) {
  var state = createCameraControllerState(spec);
  return {
    hideScanCameraStates: function hide() {
      hideScanCameraStates(state);
    },
    showCameraDeniedOverlay: function showDenied(message) {
      showCameraDeniedOverlay(state, message);
    },
    requestCameraAndStartAlignment: function requestAndAlign() {
      requestCameraAndStartAlignment(state);
    },
    stopStream: function stop() {
      stopStream(state);
    },
    stopAlignLoop: function stopAlign() {
      stopAlignLoop(state);
    },
    startAlignLoop: function startAlign() {
      startAlignLoop(state);
    },
    stopRecordFramingLoop: function stopRecordLoop() {
      stopRecordFramingLoop(state);
    },
    startRecordFramingLoop: function startRecordLoop() {
      startRecordFramingLoop(state);
    },
    syncFaceScanFx: function syncFx(optBox, alignOk, guideDirection) {
      syncFaceScanFx(state, optBox, alignOk, guideDirection);
    },
    runCountdownThenRecord: function runCountdown() {
      return runCountdownThenRecord(state);
    },
    cancelCountdown: function cancel() {
      cancelCountdown(state);
    },
  };
}

export const FaceScanCameraController = {
  create: createCameraController,
};
