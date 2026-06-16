/**
 * Alignment polling loop: samples detection, evaluates quality, and gates the
 * transition into the 3-2-1 countdown once alignment is stable. Owns the
 * countdown timer too, since it's the direct continuation of "alignment passed".
 */
import * as H from "../utils/face_scan_helpers.js";
import * as Dbg from "../utils/face_scan_debug.js";
import { evaluateFaceQuality } from "./face_scan_quality_checks.js";
import {
  extractBoxFromDetection,
  extractLandmarksFromDetection,
} from "./face_scan_detection_utils.js";
import { syncFaceScanFx, syncFaceMesh, clearFaceMesh } from "./face_scan_camera_fx.js";

/** Stops the alignment polling interval if it is active. */
export function stopAlignLoop(state) {
  if (state.ctx.alignTimer != null) {
    clearInterval(state.ctx.alignTimer);
    state.ctx.alignTimer = null;
  }
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
export function tickAlignment(state) {
  if (state.ctx.phase !== "align") return;
  if (!state.el.preview) return;
  if (!H.isDetectorEnabled()) {
    stopAlignLoop(state);
    state.ctx.phase = "countdown";
    syncFaceScanFx(state, null);
    clearFaceMesh(state);
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
      syncFaceMesh(state, landmarks, quality.ok);

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
          clearFaceMesh(state);
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
      clearFaceMesh(state);
    });
}

/** Starts alignment polling from a clean runtime state. */
export function startAlignLoop(state) {
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
export function runCountdownThenRecord(state) {
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
export function cancelCountdown(state) {
  if (state.ctx.countdownTimer) {
    globalThis.clearInterval(state.ctx.countdownTimer);
    state.ctx.countdownTimer = 0;
  }
  if (state.el.overlayCountdown) {
    state.el.overlayCountdown.hidden = true;
    state.el.overlayCountdown.classList.add("hidden");
  }
}
