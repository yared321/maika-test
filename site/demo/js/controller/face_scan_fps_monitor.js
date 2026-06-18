/**
 * Real delivered-FPS measurement, per the client's frontend quality-control
 * spec. Uses `requestVideoFrameCallback` (rVFC) to sample actual camera frame
 * arrival timestamps — not the polling-loop tick cadence the rest of the app
 * used to rely on for FPS — falling back to a `requestAnimationFrame` loop
 * that detects new frames via `video.currentTime` changes when rVFC isn't
 * supported.
 *
 * Runs continuously from camera-stream-attached to stream-teardown,
 * independent of ctx.phase:
 *   - Every sampled interval feeds ctx.quality.frameDtHistory directly (same
 *     field/cap the align/record temporal-stability check already reads —
 *     this is a drop-in replacement for the old tick-cadence producer, no
 *     changes needed to the check itself).
 *   - A separate, recording-phase-scoped collection
 *     (ctx.fpsMonitorRecordingSamples) is reset at recording start and
 *     finalized into ctx.cameraMetadata at recording stop, producing the
 *     delivered_fps_* upload metadata fields.
 */

/** Returns the arithmetic mean of a numeric array, or null when empty. */
function mean(arr) {
  if (!arr || !arr.length) return null;
  var sum = 0;
  for (var i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

/** Returns the population standard deviation of a numeric array, or null when < 2 samples. */
function stddev(arr) {
  if (!arr || arr.length < 2) return null;
  var m = mean(arr);
  var sumSq = 0;
  for (var i = 0; i < arr.length; i++) {
    var d = arr[i] - m;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / arr.length);
}

/** Returns the minimum value of a numeric array, or null when empty. */
function min(arr) {
  if (!arr || !arr.length) return null;
  var m = arr[0];
  for (var i = 1; i < arr.length; i++) if (arr[i] < m) m = arr[i];
  return m;
}

/** Returns the maximum value of a numeric array, or null when empty. */
function max(arr) {
  if (!arr || !arr.length) return null;
  var m = arr[0];
  for (var i = 1; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/** Returns the median of a numeric array, or null when empty. */
function median(arr) {
  if (!arr || !arr.length) return null;
  var sorted = arr.slice().sort(function (a, b) {
    return a - b;
  });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Returns the p-th percentile (0-100) of a numeric array, or null when empty. */
function percentile(arr, p) {
  if (!arr || !arr.length) return null;
  var sorted = arr.slice().sort(function (a, b) {
    return a - b;
  });
  var idx = Math.ceil((p / 100) * sorted.length) - 1;
  idx = Math.max(0, Math.min(sorted.length - 1, idx));
  return sorted[idx];
}

/** Pushes a value onto a rolling array, trimming the oldest entries past maxLen. */
function pushCapped(arr, value, maxLen) {
  arr.push(value);
  while (arr.length > maxLen) arr.shift();
}

/**
 * Generic absolute floor used only when the requested fps isn't known yet.
 * Faster than this is never a real consumer-camera frame regardless of
 * configuration.
 */
var ABSOLUTE_MIN_PLAUSIBLE_FRAME_DT_MS = 5;
/** Intervals at or above this (ms) are excluded from stats but tracked as suppressed gaps. */
var MAX_ACCEPTED_FRAME_DT_MS = 2000;

/**
 * Returns the minimum plausible inter-frame interval (ms) given the camera's
 * requested fps cap. We explicitly request `frameRate: { ideal, max }`, so
 * the camera should never legitimately deliver faster than that — anything
 * implying more than ~2x the requested rate isn't a real frame, it's a
 * measurement/delivery artifact (e.g. a browser delivering a backlog of
 * buffered callbacks in a tight burst after a stall, which can report
 * near-zero intervals for what were really distinct, properly-spaced
 * frames). This doesn't depend on trusting any particular clock field to be
 * accurate for live MediaStream sources, which rVFC's metadata often isn't.
 */
function minPlausibleFrameDtMs(state) {
  var requestedFps =
    Number(state.ctx.cameraMetadata && state.ctx.cameraMetadata.requested_fps) || 30;
  var nominalMs = 1000 / requestedFps;
  return Math.max(ABSOLUTE_MIN_PLAUSIBLE_FRAME_DT_MS, nominalMs / 2);
}

/** Tracks a gap rejected from recording-phase stats (too short/long to be plausible). */
function trackSuppressedGap(ctx, dtMs) {
  if (!ctx.fpsMonitorSuppressedGaps || !(dtMs > 0)) return;
  ctx.fpsMonitorSuppressedGaps.count++;
  if (dtMs > ctx.fpsMonitorSuppressedGaps.maxMs) {
    ctx.fpsMonitorSuppressedGaps.maxMs = dtMs;
  }
}

/** Records one sampled inter-frame interval (ms) into both consumers. */
function recordSample(state, dtMs) {
  var minDt = minPlausibleFrameDtMs(state);
  var inRecording = Array.isArray(state.ctx.fpsMonitorRecordingSamples);
  if (!(dtMs >= minDt && dtMs < MAX_ACCEPTED_FRAME_DT_MS)) {
    if (inRecording) trackSuppressedGap(state.ctx, dtMs);
    return;
  }
  var historyLen = Number(state.cfg.qualityHistoryLen) || 24;
  pushCapped(state.ctx.quality.frameDtHistory, dtMs, historyLen);
  if (inRecording) state.ctx.fpsMonitorRecordingSamples.push(dtMs);
}

/**
 * rVFC-driven sampling loop; re-registers itself each frame.
 *
 * Uses `metadata.mediaTime` (the frame's position in the video's own capture
 * timeline) rather than the callback's `now` argument. `now` is when the
 * browser happened to run our JS, not when the frame was actually captured —
 * after a real stall, browsers can deliver a backlog of buffered callbacks in
 * a tight burst, several reporting nearly identical `now` values even though
 * they represent different frames. That produced spurious near-zero
 * intervals that wrecked the fps mean/std. `mediaTime` tracks the camera's
 * actual frame cadence and isn't affected by JS-scheduling catch-up bursts.
 */
function startNativeLoop(state, video) {
  state.ctx.fpsMonitorUsesNative = true;
  var lastTimeMs = null;
  function onFrame(now, metadata) {
    if (!state.ctx.fpsMonitorActive) return;
    var timeMs =
      metadata && Number.isFinite(metadata.mediaTime) ? metadata.mediaTime * 1000 : now;
    if (lastTimeMs != null) recordSample(state, timeMs - lastTimeMs);
    lastTimeMs = timeMs;
    state.ctx.fpsMonitorHandle = video.requestVideoFrameCallback(onFrame);
  }
  state.ctx.fpsMonitorHandle = video.requestVideoFrameCallback(onFrame);
}

/** requestAnimationFrame fallback: detects new frames via video.currentTime changes. */
function startFallbackLoop(state, video) {
  state.ctx.fpsMonitorUsesNative = false;
  var lastTime = null;
  var lastCurrentTime = -1;
  function tick() {
    if (!state.ctx.fpsMonitorActive) return;
    if (video.currentTime !== lastCurrentTime) {
      lastCurrentTime = video.currentTime;
      var now = performance.now();
      if (lastTime != null) recordSample(state, now - lastTime);
      lastTime = now;
    }
    state.ctx.fpsMonitorHandle = globalThis.requestAnimationFrame(tick);
  }
  state.ctx.fpsMonitorHandle = globalThis.requestAnimationFrame(tick);
}

/** Starts continuous delivered-FPS sampling against the preview video element. */
export function startFpsMonitor(state) {
  stopFpsMonitor(state);
  var video = state.el.preview;
  if (!video) return;
  state.ctx.fpsMonitorActive = true;
  if (typeof video.requestVideoFrameCallback === "function") {
    startNativeLoop(state, video);
  } else {
    startFallbackLoop(state, video);
  }
}

/** Stops delivered-FPS sampling. Safe to call repeatedly. */
export function stopFpsMonitor(state) {
  state.ctx.fpsMonitorActive = false;
  if (state.ctx.fpsMonitorHandle == null) return;
  var video = state.el.preview;
  if (
    state.ctx.fpsMonitorUsesNative &&
    video &&
    typeof video.cancelVideoFrameCallback === "function"
  ) {
    try {
      video.cancelVideoFrameCallback(state.ctx.fpsMonitorHandle);
    } catch (_e) {}
  } else {
    globalThis.cancelAnimationFrame(state.ctx.fpsMonitorHandle);
  }
  state.ctx.fpsMonitorHandle = null;
}

/** Resets the recording-phase sample collection. Call once when a recording starts. */
export function resetFpsRecordingSamples(ctx) {
  ctx.fpsMonitorRecordingSamples = [];
  ctx.fpsMonitorSuppressedGaps = { count: 0, maxMs: 0 };
}

/**
 * Computes delivered-FPS statistics from the recording-phase samples and
 * writes them onto ctx.cameraMetadata, then clears the collection. Call once
 * when a recording stops (success or discard) — whichever happens first.
 *
 * @param {object} ctx - face scan flow context
 * @param {number|null|undefined} recordingDurationMs - wall-clock recording span
 */
export function finalizeFpsRecordingMetadata(ctx, recordingDurationMs) {
  var samples = ctx.fpsMonitorRecordingSamples;
  var suppressed = ctx.fpsMonitorSuppressedGaps;
  ctx.fpsMonitorRecordingSamples = null;
  ctx.fpsMonitorSuppressedGaps = null;
  if (!ctx.cameraMetadata || !Array.isArray(samples) || !samples.length) return;

  var fpsInstantaneous = samples.map(function (dt) {
    return 1000 / dt;
  });
  var dtMean = mean(samples);
  var nominalIntervalMs = 1000 / (Number(ctx.cameraMetadata.requested_fps) || 30);
  var longFrameThresholdMs = nominalIntervalMs * 2;
  var longFrameCount = 0;
  for (var i = 0; i < samples.length; i++) {
    if (samples[i] > longFrameThresholdMs) longFrameCount++;
  }

  var durationMs = Number(recordingDurationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    var startedAt = ctx.recordWallClockStartedAt;
    if (Number.isFinite(startedAt) && startedAt > 0) {
      durationMs = performance.now() - startedAt;
    }
  }

  ctx.cameraMetadata.fps_monitor_mode = ctx.fpsMonitorUsesNative ? "rvfc" : "raf_fallback";
  ctx.cameraMetadata.delivered_fps_overall = dtMean > 0 ? 1000 / dtMean : null;
  ctx.cameraMetadata.delivered_fps_mean = ctx.cameraMetadata.delivered_fps_overall;
  ctx.cameraMetadata.delivered_fps_instantaneous_mean = mean(fpsInstantaneous);
  ctx.cameraMetadata.delivered_fps_median = median(fpsInstantaneous);
  ctx.cameraMetadata.delivered_fps_p10 = percentile(fpsInstantaneous, 10);
  ctx.cameraMetadata.delivered_fps_min = min(fpsInstantaneous);
  ctx.cameraMetadata.delivered_fps_std = stddev(fpsInstantaneous);
  ctx.cameraMetadata.frame_count = samples.length + 1;
  ctx.cameraMetadata.estimated_frame_count = samples.length + 1;
  ctx.cameraMetadata.max_inter_frame_gap_ms = max(samples);
  ctx.cameraMetadata.frame_timestamp_jitter_ms = stddev(samples);
  ctx.cameraMetadata.long_frame_count = longFrameCount;
  ctx.cameraMetadata.long_frame_fraction = longFrameCount / samples.length;
  ctx.cameraMetadata.recording_duration_ms =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
  ctx.cameraMetadata.duration_ms = ctx.cameraMetadata.recording_duration_ms;
  if (suppressed) {
    ctx.cameraMetadata.suppressed_gap_count = suppressed.count;
    ctx.cameraMetadata.max_suppressed_gap_ms =
      suppressed.maxMs > 0 ? suppressed.maxMs : null;
  }
}
