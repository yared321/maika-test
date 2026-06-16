/**
 * Record-framing polling loop: samples detection during recording, evaluates
 * quality, and pauses/resumes/aborts the active MediaRecorder based on the
 * artifact policy tier. Also owns the recording-duration budget bookkeeping.
 */
import * as H from "../utils/face_scan_helpers.js";
import * as Dbg from "../utils/face_scan_debug.js";
import {
  getEffectiveRecordTargetMs,
  resetArtifactTimeline,
} from "./face_scan_artifact_policy.js";
import { evaluateFaceQuality } from "./face_scan_quality_checks.js";
import {
  extractBoxFromDetection,
  extractLandmarksFromDetection,
} from "./face_scan_detection_utils.js";
import { syncFaceScanFx, syncFaceMesh, clearFaceMesh } from "./face_scan_camera_fx.js";

/**
 * Consecutive quality-pause events allowed within one recording before the
 * camera/recording flow gives up and restarts from a clean state.
 */
var MAX_ALLOWED_RECORDING_PAUSES_BEFORE_RESTART = 100;

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
export function stopRecordFramingLoop(state) {
  if (state.ctx.recordFramingTimer != null) {
    clearInterval(state.ctx.recordFramingTimer);
    state.ctx.recordFramingTimer = null;
  }
  resetRecordingBudget(state);
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
export function tickCameraRecordFraming(state) {
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
    clearFaceMesh(state);
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
      syncFaceMesh(state, landmarks, !!(quality && quality.ok));

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
      clearFaceMesh(state);
    });
}

/** Starts the recording-framing loop from a fresh recording budget. */
export function startRecordFramingLoop(state) {
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
