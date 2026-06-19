/**
 * Record-framing polling loop: samples detection during recording, evaluates
 * quality, and aborts the active MediaRecorder based on the artifact policy
 * tier when quality fails to recover (the recorder itself is never
 * paused/resumed — uploaded videos must be one continuous take). Also owns
 * the recording-duration budget bookkeeping.
 */
import * as H from "../../utils/face_scan/helpers.js";
import * as Dbg from "../../utils/face_scan/debug.js";
import {
  getEffectiveRecordTargetMs,
  resetArtifactTimeline,
} from "./artifact_policy.js";
import { evaluateFaceQuality } from "./quality_checks.js";
import {
  extractBoxFromDetection,
  extractFaceCountFromDetection,
  extractLandmarksFromDetection,
} from "./detection_utils.js";
import { syncFaceScanFx, syncFaceMesh, clearFaceMesh } from "./camera_fx.js";
import { collectRecordTick } from "./record_collector.js";

/** Resets recording-only timers, flags, and rolling quality histories. */
function resetRecordingBudget(state) {
  state.ctx.recordBudgetAccumMs = 0;
  state.ctx.recordBudgetLastSample = null;
  state.ctx.recordWallClockStartedAt = null;
  state.ctx.recordingFaceInGuide = false;
  state.ctx.recordingFramingReady = false;
  state.ctx.quality.brightnessHistory = [];
  state.ctx.quality.greenHistory = [];
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
    return quality.message ? "Recording — " + quality.message : "Recording — adjust position or lighting.";
  }
  if (a.effectiveAction === "stop_major") {
    return quality.message
      ? "Recording — " + quality.message
      : "Recording — quality too low. Fix your setup to continue.";
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
 * - Never pauses/resumes the recorder: uploaded videos must be one continuous
 *   recording. Degraded quality only surfaces a warning and keeps recording;
 *   only a sustained major artifact (`shouldAbortRecording`) stops the take,
 *   discards it, and lets the flow restart from a clean alignment.
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

  detectFaceForRecordPhase(state)
    .then(function (detection) {
      state.ctx.detectionInFlight = false;
      if (state.ctx.phase !== "record") return;
      var rec = state.ctx.recorder;
      if (!rec) return;
      var box = extractBoxFromDetection(detection);
      var faceCount = extractFaceCountFromDetection(detection);
      var landmarks = extractLandmarksFromDetection(detection);
      var now = performance.now();
      if (isRecordingWallClockLimitReached(state, now)) {
        try {
          rec.stop();
        } catch (esWall) {}
        return;
      }
      var metrics = box ? sampleRecordMetrics(state, box) : null;
      var quality = evaluateFaceQuality(
        state,
        "record",
        box,
        state.cfg.skipMeshDuringRecord ? null : landmarks,
        metrics,
        now,
        faceCount,
      );
      syncRecordMesh(state, landmarks, quality.ok);
      state.ctx.recordCollectorSeq = (state.ctx.recordCollectorSeq || 0) + 1;
      var collectorEvery = Number(state.cfg.recordCollectorEveryNTicks) || 1;
      var collectorReg =
        box &&
        state.el.preview &&
        state.ctx.recordCollectorSeq % collectorEvery === 0
          ? H.getCoverVisibleRegion(state.el.preview)
          : null;
      collectRecordTick(state.ctx, box, quality, collectorReg, now);

      // Sustained major artifact: discard this attempt and let the flow restart
      // alignment for a fresh, fully continuous take.
      if (quality.artifact && quality.artifact.shouldAbortRecording) {
        Dbg.logFaceScanStep("record: aborting — sustained major artifact", quality.artifact);
        state.ctx.discardCurrentRecording = true;
        state.ctx.autoRestartCameraAfterAbort = true;
        state.ctx.qualityRestartMessage =
          "Signal stayed unstable for too long. Keep your face centered, hold still, and use steady lighting.";
        if (state.ctx.cameraMetadata) {
          state.ctx.cameraMetadata.abort_reason = quality.message || null;
          var recStart = state.ctx.recordWallClockStartedAt;
          state.ctx.cameraMetadata.abort_at_ms = Number.isFinite(recStart)
            ? Math.round(now - recStart) : null;
        }
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

      // Quality dipped into moderate/major territory but hasn't sustained long
      // enough to abort: the recorder is NEVER paused mid-take (uploaded videos
      // must be one continuous recording), so we just surface guidance here and
      // fall through to the same budget-accumulation tail used by the good path.
      var degraded = !!(quality.artifact && quality.artifact.isDegraded);
      if (degraded) {
        if (!state.ctx._lastRecordPauseLogged || state.ctx._lastRecordPauseLogged !== quality.message) {
          state.ctx._lastRecordPauseLogged = quality.message;
          Dbg.logFaceScanStep("record: quality degraded (tracked, recording continues)", {
            tier: quality.artifact.tier,
            action: quality.artifact.effectiveAction,
            streak: quality.artifact.failStreak,
            message: quality.message,
          });
        }
        state.ctx.recordingFaceInGuide = false;
        H.setPlacementUi(
          state.el.placementStatus,
          "bad",
          placementMessageForArtifact(quality),
        );
        syncFaceScanFx(state, box, false, quality.direction || null);
      } else {
        if (state.ctx._lastRecordPauseLogged) {
          Dbg.logFaceScanStep("record: quality recovered");
          state.ctx._lastRecordPauseLogged = null;
        }
        state.ctx.recordingFaceInGuide = true;
        state.ctx.recordingFramingReady = true;
        var statusMsg = placementMessageForArtifact(quality) || "Recording...";
        H.setPlacementUi(
          state.el.placementStatus,
          quality.artifact && quality.artifact.effectiveAction === "track_minor"
            ? "wait"
            : "good",
          statusMsg,
        );
        syncFaceScanFx(state, box);
      }

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
      }
    })
    .catch(function () {
      state.ctx.detectionInFlight = false;
      syncFaceScanFx(state, null);
      clearFaceMesh(state);
    });
}

function getRecordFramingIntervalMs(state) {
  var ms = Number(state.cfg.recordFramingIntervalMs);
  if (Number.isFinite(ms) && ms > 0) return ms;
  return Number(state.cfg.alignIntervalMs) || 120;
}

function detectFaceForRecordPhase(state) {
  if (state.cfg.useDetectorDuringRecord) {
    return H.detectSingleFaceForRecord(state.el.preview);
  }
  return H.detectSingleFace(state.el.preview);
}

function sampleRecordMetrics(state, box) {
  if (!box || !state.el.preview) return null;
  if (state.cfg.skipRecordLuminanceChecks) return null;
  return H.sampleFaceRegionMetrics(state.el.preview, box);
}

function syncRecordMesh(state, landmarks, qualityOk) {
  if (state.cfg.skipMeshDuringRecord) {
    clearFaceMesh(state);
    return;
  }
  syncFaceMesh(state, landmarks, qualityOk);
}

/** Starts the recording-framing loop from a fresh recording budget. */
export function startRecordFramingLoop(state) {
  stopRecordFramingLoop(state);
  Dbg.resetFaceScanDebugDedupe("record");
  Dbg.logFaceScanStep("phase: record framing loop started", {
    intervalMs: getRecordFramingIntervalMs(state),
  });
  state.ctx.recordFramingTimer = globalThis.setInterval(
    function () {
      tickCameraRecordFraming(state);
    },
    getRecordFramingIntervalMs(state),
  );
  tickCameraRecordFraming(state);
}
