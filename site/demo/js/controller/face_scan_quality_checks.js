import * as H from "../utils/face_scan_helpers.js";
import { applyArtifactPolicy } from "./face_scan_artifact_policy.js";
import {
  collectQualityTraces,
  evaluatePoseCheck,
  evaluateTemporalQuality,
  evaluateVisibilityCheck,
  getGuideOrCenter,
  publishQualityReport,
  qualityCheck,
  resolveFaceMaxMeanLuminance,
  resolveFaceMinMeanLuminance,
  resolveGuideMessage,
} from "./face_scan_quality_helpers.js";

/**
 * Check 1: verifies exactly one face was detected in the current frame.
 */
function check1FacePresent(box, faceCount) {
  var count = typeof faceCount === "number" ? faceCount : (box ? 1 : 0);
  if (count > 1) {
    return {
      check: qualityCheck("1_face_present", false, { detected: true, faceCount: count, reason: "multiple_faces" }),
      ok: false,
      message: "Multiple faces detected. Only one person should be in frame.",
    };
  }
  var check = qualityCheck("1_face_present", !!box, { detected: !!box, faceCount: count });
  if (!box) {
    return {
      check: check,
      ok: false,
      message: "Position your face in the frame.",
      direction: "center",
    };
  }
  return { check: check, ok: true };
}

/** Check 2: verifies face is centered in the guide area. */
function check2FaceCentered(state, box) {
  var framed = H.isFaceWellFramed(
    box,
    state.el.preview,
    state.cfg.faceMinFrac,
    state.cfg.faceMaxFrac,
  );
  var check = qualityCheck("2_face_centered", framed, { centeredInGuide: framed });
  if (!framed) {
    var guide = getGuideOrCenter(state, box);
    var message = "Center your face.";
    if (guide && guide.direction === "near") message = "Move slightly closer.";
    else if (guide && guide.direction === "far") message = "Move slightly back.";
    return {
      check: check,
      ok: false,
      message: message,
      direction: guide && guide.direction,
    };
  }
  return { check: check, ok: true };
}

/**
 * Check 3: records detected face size (width fraction of the visible crop) for
 * telemetry/debugging. This intentionally always returns `ok: true` — it is NOT
 * a redundant/dead gate. Check 2 (`check2FaceCentered` -> `H.isFaceWellFramed`)
 * already enforces the same `faceMinFrac`/`faceMaxFrac` width bound and early-exits
 * the pipeline on failure before this function ever runs, so by the time we get
 * here `sizeOk` is guaranteed true. This function exists only to log the precise
 * width-fraction metric (`qualityCheck("3_face_size_in_range", ...)`) as its own
 * entry in the quality trace/debug report, separate from check 2's combined
 * centering+size+vertical-band result. Do not "fix" this into a second blocking
 * gate — that would just duplicate check 2's behavior.
 */
function check3FaceSizeInRange(state, box) {
  var reg = H.getCoverVisibleRegion(state.el.preview);
  var widthFrac = reg ? box.width / reg.sw : null;
  var sizeOk =
    widthFrac != null &&
    widthFrac >= state.cfg.faceMinFrac &&
    widthFrac <= state.cfg.faceMaxFrac;
  var check = qualityCheck("3_face_size_in_range", sizeOk, {
    faceWidthFrac: widthFrac != null ? Number(widthFrac.toFixed(3)) : null,
    minFrac: state.cfg.faceMinFrac,
    maxFrac: state.cfg.faceMaxFrac,
  });

  // Soft preferred-width warning (55–65%): passes the hard gate but nudges the
  // user toward the ideal framing range without blocking the countdown.
  var widthWarning = null;
  if (sizeOk && widthFrac != null) {
    var prefMin = state.cfg.facePreferredMinFrac || 0.55;
    var prefMax = state.cfg.facePreferredMaxFrac || 0.65;
    if (widthFrac < prefMin) {
      widthWarning = "Move a little closer for best quality.";
    } else if (widthFrac > prefMax) {
      widthWarning = "Move a little further back for best quality.";
    }
  }

  return { check: check, ok: true, widthWarning: widthWarning };
}

/** Check 4: verifies face pose is approximately frontal. */
function check4FacePoseFrontal(state, box, landmarks) {
  var pose = evaluatePoseCheck(state, box, landmarks);
  var check = qualityCheck("4_face_pose_frontal", pose.pass, pose.detail);
  if (!pose.pass) {
    return {
      check: check,
      ok: false,
      message: "Turn to a frontal pose and face the camera directly.",
    };
  }
  return { check: check, ok: true };
}

/** Check 5: verifies required face regions are visible. */
function check5AnatomyVisible(state, box, landmarks) {
  var vis = evaluateVisibilityCheck(state, box, landmarks);
  var check = qualityCheck("5_anatomy_visible", vis.pass, {
    blockingIssues: vis.detail && vis.detail.blockingIssues,
    issues: vis.detail && vis.detail.issues,
    regions: vis.detail && vis.detail.regions,
    mode: vis.detail && vis.detail.mode,
    reason: vis.detail && vis.detail.reason,
  });
  if (!vis.pass) {
    var reason =
      vis &&
      vis.detail &&
      typeof vis.detail.reason === "string" &&
      vis.detail.reason
        ? vis.detail.reason
        : "";
    var issues =
      vis &&
      vis.detail &&
      Array.isArray(vis.detail.issues)
        ? vis.detail.issues
        : [];
    var blockingIssues =
      vis &&
      vis.detail &&
      Array.isArray(vis.detail.blockingIssues)
        ? vis.detail.blockingIssues
        : issues;
    if (
      reason === "no_landmarks" ||
      reason === "no_video_dimensions" ||
      reason === "no_visible_region_or_box"
    ) {
      return {
        check: check,
        ok: false,
        message: "Keep your full face in view and try again.",
      };
    }

    var hasForeheadCover = false;
    var hasNoseIssue = false;
    var hasCoveringIssue = false;
    for (var ii = 0; ii < blockingIssues.length; ii++) {
      var code = blockingIssues[ii];
      if (
        code === "forehead_non_skin_occlusion" ||
        code === "forehead_out_of_frame"
      ) {
        hasForeheadCover = true;
      }
      if (code.indexOf("noseBridge_") === 0) hasNoseIssue = true;
      if (code.indexOf("_non_skin_occlusion") >= 0) hasCoveringIssue = true;
    }

    var hasOutOfFrame = false;
    for (var oi = 0; oi < blockingIssues.length; oi++) {
      if (blockingIssues[oi].indexOf("_out_of_frame") >= 0) hasOutOfFrame = true;
    }
    if (hasOutOfFrame && !hasCoveringIssue) {
      return {
        check: check,
        ok: false,
        message: "Center your face.",
      };
    }

    if (hasForeheadCover) {
      return {
        check: check,
        ok: false,
        message: "Keep your forehead uncovered and visible.",
      };
    }
    if (hasNoseIssue && hasCoveringIssue) {
      return {
        check: check,
        ok: false,
        message: "Move your hand away from your nose and cheeks.",
      };
    }
    if (hasCoveringIssue) {
      return {
        check: check,
        ok: false,
        message:
          "Something is covering part of your face. Uncover your forehead, nose, and cheeks.",
      };
    }
    return {
      check: check,
      ok: false,
      message:
        "Keep your forehead, nose, and cheeks fully visible. Move your hand or any covering away.",
    };
  }
  return { check: check, ok: true };
}

/** Check 6: verifies average face luminance is within configured bounds. */
function check6BrightnessInRange(state, metrics) {
  if (!metrics) {
    return {
      ok: false,
      message: "Lighting sample unavailable. Hold still and retry.",
    };
  }

  var minL = resolveFaceMinMeanLuminance(state.cfg);
  var maxL = resolveFaceMaxMeanLuminance(state.cfg);
  var check = qualityCheck(
    "6_brightness_in_range",
    metrics.meanLuminance >= minL && metrics.meanLuminance <= maxL,
    {
      meanLuminance: Number(metrics.meanLuminance.toFixed(1)),
      min: minL,
      max: maxL,
    },
  );
  if (metrics.meanLuminance < minL) {
    return {
      check: check,
      ok: false,
      message: "Move to a brighter place.",
    };
  }
  if (metrics.meanLuminance > maxL) {
    return {
      check: check,
      ok: false,
      message: "Reduce direct light on your face.",
    };
  }
  return { check: check, ok: true };
}

/** Check 7: verifies no excessive overexposed skin regions are present. */
function check7NoOverexposedSkin(state, metrics) {
  var maxOver = Number(state.cfg.maxOverexposedRatio) || 0.1;
  var check = qualityCheck("7_no_overexposed_skin", metrics.overexposedRatio <= maxOver, {
    overexposedRatio: Number(metrics.overexposedRatio.toFixed(3)),
    max: maxOver,
  });
  if (metrics.overexposedRatio > maxOver) {
    return {
      check: check,
      ok: false,
      message: "Skin highlights are overexposed. Reduce frontal light intensity.",
    };
  }
  return { check: check, ok: true };
}

/** Check 8: verifies no excessive underexposed skin regions are present. */
function check8NoUnderexposedSkin(state, metrics) {
  var maxUnder = Number(state.cfg.maxUnderexposedRatio) || 0.22;
  var check = qualityCheck("8_no_underexposed_skin", metrics.underexposedRatio <= maxUnder, {
    underexposedRatio: Number(metrics.underexposedRatio.toFixed(3)),
    max: maxUnder,
  });
  if (metrics.underexposedRatio > maxUnder) {
    return {
      check: check,
      ok: false,
      message: "Face shadows are too strong. Increase even front lighting.",
    };
  }
  return { check: check, ok: true };
}

/** Check 9: verifies left/right illumination is reasonably symmetric. */
function check9LeftRightIlluminationSymmetric(state, metrics) {
  var maxSide = Number(state.cfg.maxSideLuminanceAsymmetry) || 0.32;
  var sideBase = Math.max(1, metrics.meanLuminance);
  var sideDiff =
    Math.abs(metrics.leftMeanLuminance - metrics.rightMeanLuminance) / sideBase;
  var check = qualityCheck("9_left_right_illumination_symmetric", sideDiff <= maxSide, {
    sideAsymmetryRatio: Number(sideDiff.toFixed(3)),
    max: maxSide,
    leftMean: Number(metrics.leftMeanLuminance.toFixed(1)),
    rightMean: Number(metrics.rightMeanLuminance.toFixed(1)),
  });
  if (sideDiff > maxSide) {
    return {
      check: check,
      ok: false,
      message: "Use more even light on both sides of your face.",
    };
  }
  return { check: check, ok: true };
}

function getTemporalCheckById(temporalChecks, id) {
  for (var i = 0; i < temporalChecks.length; i++) {
    if (temporalChecks[i] && temporalChecks[i].id === id) return temporalChecks[i];
  }
  return qualityCheck(id, true, { skipped: true, reason: "not_available" });
}

/** Check 10: verifies brightness stability over recent samples. */
function check10BrightnessStableOverTime(temporal) {
  return { check: getTemporalCheckById(temporal.checks, "10_brightness_stable_over_time"), ok: true };
}

/** Check 11: verifies head motion remains low over recent samples. */
function check11HeadMotionLow(temporal) {
  return { check: getTemporalCheckById(temporal.checks, "11_head_motion_low"), ok: true };
}

/** Check 12: verifies frame-rate stability (fps + jitter). */
function check12FrameRateStable(temporal) {
  return { check: getTemporalCheckById(temporal.checks, "12_frame_rate_stable"), ok: true };
}

/** Check 13: optional preliminary rPPG signal quality check. */
function check13PreliminaryRppgSignal(temporal) {
  return { check: getTemporalCheckById(temporal.checks, "13_preliminary_rppg_signal"), ok: true };
}

/**
 * Executes the 13 face-quality checks and returns pass/fail guidance.
 * This function orchestrates check order and early exits.
 */
function runFaceQualityChecks(state, phase, box, landmarks, metrics, nowMs, faceCount) {
  var checks = [];

  var c1 = check1FacePresent(box, faceCount);
  checks.push(c1.check);
  if (!c1.ok) return { ok: false, message: c1.message, direction: c1.direction, checks: checks };

  var c2 = check2FaceCentered(state, box);
  checks.push(c2.check);
  if (!c2.ok) return { ok: false, message: c2.message, direction: c2.direction, checks: checks };

  var c3 = check3FaceSizeInRange(state, box);
  checks.push(c3.check);
  var widthWarning = c3.widthWarning || null;

  var c4 = check4FacePoseFrontal(state, box, landmarks);
  checks.push(c4.check);
  if (!c4.ok) return { ok: false, message: c4.message, checks: checks };

  var c5 = check5AnatomyVisible(state, box, landmarks);
  checks.push(c5.check);
  if (!c5.ok) return { ok: false, message: c5.message, checks: checks };

  var skipLuma =
    phase === "record" && state.cfg.skipRecordLuminanceChecks;
  if (skipLuma) {
    checks.push(
      qualityCheck("6_brightness_in_range", true, {
        skipped: true,
        mode: "align_gated",
      }),
    );
    checks.push(
      qualityCheck("7_no_overexposed_skin", true, {
        skipped: true,
        mode: "align_gated",
      }),
    );
    checks.push(
      qualityCheck("8_no_underexposed_skin", true, {
        skipped: true,
        mode: "align_gated",
      }),
    );
    checks.push(
      qualityCheck("9_left_right_illumination_symmetric", true, {
        skipped: true,
        mode: "align_gated",
      }),
    );
  } else {
    var c6 = check6BrightnessInRange(state, metrics);
    if (c6.check) checks.push(c6.check);
    if (!c6.ok) return { ok: false, message: c6.message, checks: checks };

    var c7 = check7NoOverexposedSkin(state, metrics);
    checks.push(c7.check);
    if (!c7.ok) return { ok: false, message: c7.message, checks: checks };

    var c8 = check8NoUnderexposedSkin(state, metrics);
    checks.push(c8.check);
    if (!c8.ok) return { ok: false, message: c8.message, checks: checks };

    var c9 = check9LeftRightIlluminationSymmetric(state, metrics);
    checks.push(c9.check);
    if (!c9.ok) return { ok: false, message: c9.message, checks: checks };
  }

  collectQualityTraces(state, box, skipLuma ? null : metrics, nowMs);
  var temporal = evaluateTemporalQuality(state, state.el.preview);

  var c10 = check10BrightnessStableOverTime(temporal);
  checks.push(c10.check);
  var c11 = check11HeadMotionLow(temporal);
  checks.push(c11.check);
  var c12 = check12FrameRateStable(temporal);
  checks.push(c12.check);
  // var c13 = check13PreliminaryRppgSignal(temporal);
  // checks.push(c13.check);

  return {
    ok: temporal.ok,
    message: temporal.message,
    checks: checks,
    direction: temporal.direction,
    fpsLow: !!temporal.fpsLow,
    fpsTier: temporal.fpsTier || null,
    fpsWarning: temporal.fpsWarning || null,
    widthWarning: widthWarning,
  };
}

/**
 * Runs the full face-quality gate and returns pass/fail with user-facing guidance.
 *
 * Included checks:
 * 1) face present — blocking, see check1FacePresent.
 * 2) face centered — blocking; also enforces the face-size bound (3) and a
 *    vertical containment band, via H.isFaceWellFramed.
 * 3) face size in range — non-blocking by design; telemetry-only restatement of
 *    the size bound already enforced by check 2. See check3FaceSizeInRange.
 * 4) face approximately frontal — blocking, see check4FacePoseFrontal.
 * 5) forehead/cheeks/nose bridge visible — blocking, see check5AnatomyVisible.
 * 6) brightness in range — blocking, see check6BrightnessInRange.
 * 7) no overexposed skin — blocking, see check7NoOverexposedSkin.
 * 8) no underexposed skin — blocking, see check8NoUnderexposedSkin.
 * 9) left/right illumination symmetry — blocking, see check9LeftRightIlluminationSymmetric.
 * 10) brightness stability over time — blocking once >=8 rolling samples exist;
 *     a no-op pass while warming up. See evaluateTemporalQuality.
 * 11) low head motion — blocking once >=6 rolling samples exist; no-op while
 *     warming up. See evaluateTemporalQuality.
 * 12) stable frame rate (fps + jitter) — blocking once >=8 rolling samples exist;
 *     no-op while warming up. See evaluateTemporalQuality.
 * 13) optional preliminary rPPG signal quality — disabled by default
 *     (preliminaryRppgEnabled config flag); no-op until enough green-channel
 *     samples accumulate.
 *
 * Checks run in order with an early exit on the first blocking failure, so the
 * `checks` array returned on a failing sample may not contain every check id
 * (e.g. checks 10-13 are skipped entirely if check 9 already failed).
 */
export function evaluateFaceQuality(state, phase, box, landmarks, metrics, nowMs, faceCount) {
  var result = runFaceQualityChecks(state, phase, box, landmarks, metrics, nowMs, faceCount);
  var artifact = applyArtifactPolicy(state.ctx, result, nowMs, phase, {
    majorAbortStreak: state.cfg.majorAbortStreak,
  });
  result.artifact = artifact;
  if (phase === "record") {
    result.ok = artifact.recordingOk;
  }
  publishQualityReport(phase, state, result, box, metrics, landmarks);
  return result;
}
