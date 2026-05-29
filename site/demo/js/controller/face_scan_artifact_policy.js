/**
 * rPPG-oriented artifact severity: minor (track), moderate (pause/extend), major (stop/retry).
 * Frame streaks assume ~8 quality samples/s at 120ms align interval.
 */

/** Consecutive fail samples at or below this count → minor tier (keep recording). */
var FRAMES_MINOR_MAX = 4;
/** Consecutive fail samples above minor and at or below this → moderate tier (pause). */
var FRAMES_MODERATE_MAX = 24;
/** Consecutive fail samples at or above this while major → shouldAbortRecording. */
var MAJOR_ABORT_STREAK = 30;
/** Usable-duration target increase per moderate pause episode. */
var RECORD_EXTENSION_PER_MODERATE_MS = 2500;
/** Cap on total extension added by moderate pauses. */
var RECORD_EXTENSION_MAX_MS = 12000;

/** Default severity per failed quality check id (before streak escalation). */
var CHECK_BASE_SEVERITY = {
  "1_face_present": "major",
  "2_face_centered": "moderate",
  "3_face_size_in_range": "moderate",
  "4_face_pose_frontal": "moderate",
  "5_anatomy_visible": "moderate",
  "6_brightness_in_range": "moderate",
  "7_no_overexposed_skin": "moderate",
  "8_no_underexposed_skin": "moderate",
  "9_left_right_illumination_symmetric": "minor",
  "10_brightness_stable_over_time": "minor",
  "11_head_motion_low": "minor",
  "12_frame_rate_stable": "minor",
  "13_preliminary_rppg_signal": "minor",
};

/**
 * Ensures ctx.quality and record-extension fields exist for artifact tracking.
 * @param {object} ctx - face scan flow context
 * @returns {object} ctx.quality with streak, segments, and open segment initialized
 */
function ensureArtifactState(ctx) {
  if (!ctx.quality || typeof ctx.quality !== "object") ctx.quality = {};
  var q = ctx.quality;
  if (typeof q.artifactFailStreak !== "number") q.artifactFailStreak = 0;
  if (!Array.isArray(q.qualitySegments)) q.qualitySegments = [];
  if (!q.openLowQualitySegment) q.openLowQualitySegment = null;
  if (typeof ctx.recordTargetExtensionMs !== "number") ctx.recordTargetExtensionMs = 0;
  return q;
}

/** Returns the id of the first failing check in a quality result, or null if none. */
function getFailedCheckId(result) {
  if (!result || !Array.isArray(result.checks)) return null;
  for (var i = 0; i < result.checks.length; i++) {
    var c = result.checks[i];
    if (c && c.pass === false) return c.id;
  }
  return null;
}

/**
 * Maps the current failure to a base severity (minor | moderate | major | none).
 * Anatomy check can escalate to major when multiple regions block or nose bridge is occluded.
 */
function resolveBaseSeverity(result) {
  var id = getFailedCheckId(result);
  if (!id) return "none";
  var base = CHECK_BASE_SEVERITY[id] || "moderate";
  if (id === "5_anatomy_visible" && result.checks) {
    for (var i = 0; i < result.checks.length; i++) {
      var c = result.checks[i];
      if (c && c.id === "5_anatomy_visible" && c.detail) {
        var blocking = c.detail.blockingIssues;
        if (Array.isArray(blocking) && blocking.length >= 2) return "major";
        if (blocking && blocking.some(function (code) {
          return code.indexOf("noseBridge_") === 0 && code.indexOf("non_skin") >= 0;
        })) {
          return "major";
        }
      }
    }
  }
  return base;
}

/**
 * Escalates base severity using consecutive fail streak and FRAMES_* thresholds.
 * Major-class checks reach major faster; moderate checks skip minor after 2 samples.
 */
function streakToTier(streak, baseSeverity) {
  if (streak <= 0) return "none";
  var tier = "minor";
  if (streak > FRAMES_MINOR_MAX) tier = "moderate";
  if (streak > FRAMES_MODERATE_MAX) tier = "major";
  if (baseSeverity === "major" && streak >= 8) tier = "major";
  else if (baseSeverity === "major" && streak >= 1) tier = maxTier(tier, "moderate");
  else if (baseSeverity === "moderate" && tier === "minor" && streak >= 2) tier = "moderate";
  return tier;
}

/** Returns the higher of two severity tiers (none < minor < moderate < major). */
function maxTier(a, b) {
  var order = { none: 0, minor: 1, moderate: 2, major: 3 };
  return (order[a] || 0) >= (order[b] || 0) ? a : b;
}

/** Maps artifact tier to recorder action: continue, track_minor, pause_moderate, or stop_major. */
function tierToAction(tier) {
  if (tier === "none") return "continue";
  if (tier === "minor") return "track_minor";
  if (tier === "moderate") return "pause_moderate";
  return "stop_major";
}

/** Closes the in-progress low-quality segment and appends it to qualitySegments. */
function closeOpenSegment(q, nowMs) {
  var open = q.openLowQualitySegment;
  if (!open) return;
  open.t1Ms = nowMs;
  q.qualitySegments.push(open);
  q.openLowQualitySegment = null;
}

/** Starts a new open low-quality segment after closing any previous one. */
function openLowQualitySegment(q, nowMs, severity, checkId, message) {
  closeOpenSegment(q, nowMs);
  q.openLowQualitySegment = {
    t0Ms: nowMs,
    t1Ms: null,
    severity: severity,
    checkId: checkId || null,
    message: message || "",
  };
}

/**
 * Main policy entry: updates fail streak, timeline segments, and record target extension.
 * Returns flags the camera/recording controllers use (pause, abort, recordingOk, message).
 * @param {object} ctx - face scan flow context
 * @param {object} result - output from runFaceQualityChecks
 * @param {number} nowMs - performance.now()
 * @param {string} phase - "align" | "record"
 * @returns {object} artifact decision for this quality sample
 */
export function applyArtifactPolicy(ctx, result, nowMs, phase) {
  var q = ensureArtifactState(ctx);
  var sampleOk = !!(result && result.ok);
  var failedCheckId = getFailedCheckId(result);
  var baseSeverity = sampleOk ? "none" : resolveBaseSeverity(result);

  if (sampleOk) {
    q.artifactFailStreak = 0;
    closeOpenSegment(q, nowMs);
    return {
      tier: "none",
      baseSeverity: "none",
      failStreak: 0,
      effectiveAction: "continue",
      recordingOk: true,
      alignCountsAsStable: true,
      shouldPauseRecorder: false,
      shouldAbortRecording: false,
      failedCheckId: null,
      message: null,
    };
  }

  q.artifactFailStreak++;
  var tier = streakToTier(q.artifactFailStreak, baseSeverity);
  var effectiveAction = tierToAction(tier);
  var message = result && result.message ? result.message : "Adjust your position or lighting.";

  if (phase === "record") {
    if (effectiveAction === "track_minor") {
      if (!q.openLowQualitySegment || q.openLowQualitySegment.severity !== "minor") {
        openLowQualitySegment(q, nowMs, "minor", failedCheckId, message);
      } else {
        q.openLowQualitySegment.t1Ms = nowMs;
      }
    } else {
      closeOpenSegment(q, nowMs);
      q.qualitySegments.push({
        t0Ms: nowMs,
        t1Ms: nowMs,
        severity: tier,
        checkId: failedCheckId,
        message: message,
        pulse: true,
      });
    }

    if (effectiveAction === "pause_moderate") {
      var ext = Math.min(
        RECORD_EXTENSION_MAX_MS,
        (ctx.recordTargetExtensionMs || 0) + RECORD_EXTENSION_PER_MODERATE_MS,
      );
      ctx.recordTargetExtensionMs = ext;
    }
  }

  var shouldAbortRecording =
    phase === "record" &&
    effectiveAction === "stop_major" &&
    q.artifactFailStreak >= MAJOR_ABORT_STREAK;

  return {
    tier: tier,
    baseSeverity: baseSeverity,
    failStreak: q.artifactFailStreak,
    effectiveAction: effectiveAction,
    recordingOk: effectiveAction === "continue" || effectiveAction === "track_minor",
    alignCountsAsStable: false,
    shouldPauseRecorder:
      phase === "record" &&
      (effectiveAction === "pause_moderate" || effectiveAction === "stop_major"),
    shouldAbortRecording: shouldAbortRecording,
    failedCheckId: failedCheckId,
    message: message,
  };
}

/**
 * Effective usable-duration target: base recordTargetMs plus moderate pause extensions.
 * @param {object} ctx - face scan flow context (recordTargetExtensionMs)
 * @param {object} cfg - scan config (recordTargetMs, default 30000)
 * @returns {number} milliseconds of good signal required before stopping
 */
export function getEffectiveRecordTargetMs(ctx, cfg) {
  var base = Number(cfg && cfg.recordTargetMs) || 30000;
  var ext = Number(ctx && ctx.recordTargetExtensionMs) || 0;
  return base + ext;
}

/**
 * Closes any open low-quality segment at end of recording and returns the full timeline.
 * @param {object} ctx - face scan flow context
 * @param {number} nowMs - performance.now()
 * @returns {Array} completed qualitySegments for upload/metadata
 */
export function finalizeArtifactTimeline(ctx, nowMs) {
  var q = ensureArtifactState(ctx);
  closeOpenSegment(q, nowMs);
  return q.qualitySegments;
}

/**
 * Clears artifact streak, segments, and record extension (e.g. on restart or new scan).
 * @param {object} ctx - face scan flow context
 */
export function resetArtifactTimeline(ctx) {
  if (!ctx) return;
  ctx.recordTargetExtensionMs = 0;
  if (!ctx.quality) return;
  ctx.quality.artifactFailStreak = 0;
  ctx.quality.qualitySegments = [];
  ctx.quality.openLowQualitySegment = null;
}
