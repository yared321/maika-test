/**
 * Camera warmup phase: runs for a fixed duration right after the camera
 * stream attaches and before alignment quality-gating begins, per the
 * client's frontend quality-control spec ("Step 1 - camera warmup"). Lets
 * auto-exposure/autofocus settle, takes a one-time ambient brightness/FPS
 * baseline reading, and primes the face detector before the first real
 * alignment tick.
 *
 * Deliberately does NOT write into ctx.quality.brightnessHistory/frameDtHistory
 * — startAlignLoop resets those arrays the moment it starts, so anything
 * warmup wrote there would be wiped immediately. Instead this keeps its own
 * one-time summary on ctx.warmupSummary.
 *
 * The FPS figure here is the same tick-interval approximation used elsewhere
 * in the app today, not a true requestVideoFrameCallback-based delivered-FPS
 * measurement (that's a separate, not-yet-built piece of work) — treat
 * `baselineFps` as a rough warmup-time signal, not the precise metric.
 */
import * as H from "../../utils/face_scan/helpers.js";
import * as Dbg from "../../utils/face_scan/debug.js";

/** Builds a synthetic center-crop box (50% width/height) for ambient sampling. */
function buildCenterBox(reg) {
  var w = reg.sw * 0.5;
  var h = reg.sh * 0.5;
  return {
    x: reg.sx + (reg.sw - w) / 2,
    y: reg.sy + (reg.sh - h) / 2,
    width: w,
    height: h,
  };
}

/** Returns the arithmetic mean of a numeric array, or null when empty. */
function mean(arr) {
  if (!arr || !arr.length) return null;
  var sum = 0;
  for (var i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

/** One warmup sample: ambient brightness + a detector-priming call + frame interval. */
function tickWarmup(state) {
  if (state.ctx.phase !== "warmup") return;
  if (!state.el.preview || state.el.preview.readyState < 2) return;

  var reg = H.getCoverVisibleRegion(state.el.preview);
  if (reg && reg.sw > 8 && reg.sh > 8) {
    var metrics = H.sampleFaceRegionMetrics(state.el.preview, buildCenterBox(reg));
    if (metrics && Number.isFinite(metrics.meanLuminance)) {
      state.ctx.warmupSummary.brightnessSamples.push(metrics.meanLuminance);
    }
  }

  if (H.isDetectorEnabled()) {
    // Result is discarded — this call exists only to prime the detector
    // (WASM/model warm state) before align's first real tick.
    H.detectSingleFace(state.el.preview).catch(function () {});
  }

  var now = performance.now();
  if (state.ctx.warmupSummary.lastSampleAt != null) {
    var dt = now - state.ctx.warmupSummary.lastSampleAt;
    if (dt > 0 && dt < 2000) state.ctx.warmupSummary.frameDtSamples.push(dt);
  }
  state.ctx.warmupSummary.lastSampleAt = now;
}

/** Stops warmup sampling and the completion timer. Safe to call repeatedly. */
export function stopWarmup(state) {
  if (state.ctx.warmupTimer != null) {
    clearInterval(state.ctx.warmupTimer);
    state.ctx.warmupTimer = null;
  }
  if (state.ctx.warmupTimeout != null) {
    clearTimeout(state.ctx.warmupTimeout);
    state.ctx.warmupTimeout = null;
  }
}

/**
 * Starts the warmup phase for `state.cfg.warmupDurationMs`, then calls
 * `onComplete()`. Computes a one-time baseline brightness/FPS summary from
 * the samples collected during the window.
 */
export function startWarmup(state, onComplete) {
  stopWarmup(state);
  state.ctx.phase = "warmup";
  state.ctx.warmupSummary = {
    brightnessSamples: [],
    frameDtSamples: [],
    lastSampleAt: null,
    baselineBrightness: null,
    baselineFps: null,
  };
  Dbg.logFaceScanStep("phase: warmup started", {
    durationMs: state.cfg.warmupDurationMs,
  });
  if (state.el.placementStatus) {
    H.setPlacementUi(state.el.placementStatus, "wait", "Preparing camera…");
  }

  state.ctx.warmupTimer = globalThis.setInterval(function () {
    tickWarmup(state);
  }, state.cfg.alignIntervalMs);
  tickWarmup(state);

  state.ctx.warmupTimeout = globalThis.setTimeout(function () {
    stopWarmup(state);
    var summary = state.ctx.warmupSummary;
    if (summary) {
      summary.baselineBrightness = mean(summary.brightnessSamples);
      var meanDt = mean(summary.frameDtSamples);
      summary.baselineFps = meanDt ? 1000 / meanDt : null;
    }
    Dbg.logFaceScanStep("phase: warmup complete", summary);
    onComplete();
  }, state.cfg.warmupDurationMs);
}
