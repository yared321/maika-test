/**
 * Per-tick face quality stats collector for the record phase.
 * Gathers box/quality data each detection tick and finalizes into
 * cameraMetadata aggregates when recording stops.
 *
 * Core counters (face present / quality ok / fail reasons) run every tick.
 * Geometry (width fraction, center offset, contained) runs only when
 * `visibleRegion` is passed — throttled via cfg.recordCollectorEveryNTicks
 * (every 4th tick on desktop, every tick on phone).
 * Luma and exposure stats are collected when box is present and luminance
 * checks ran (desktop only — skipped when skipRecordLuminanceChecks is true).
 * Brightness asymmetry follows the same desktop-only constraint.
 */
function mean(arr) {
  if (!arr || !arr.length) return null;
  var s = 0;
  for (var i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stddev(arr) {
  if (!arr || arr.length < 2) return null;
  var m = mean(arr);
  var v = 0;
  for (var i = 0; i < arr.length; i++) {
    var d = arr[i] - m;
    v += d * d;
  }
  return Math.sqrt(v / arr.length);
}

function median(arr) {
  if (!arr || !arr.length) return null;
  var s = arr.slice().sort(function (a, b) {
    return a - b;
  });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(arr, p) {
  if (!arr || !arr.length) return null;
  var s = arr.slice().sort(function (a, b) {
    return a - b;
  });
  var idx = Math.max(0, Math.ceil((p / 100) * s.length) - 1);
  return s[idx];
}

function r3(v) {
  return v != null && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

/** Consecutive absolute diffs between adjacent elements of arr. */
function consecutiveDeltas(arr) {
  if (!arr || arr.length < 2) return [];
  var out = [];
  for (var i = 1; i < arr.length; i++) out.push(Math.abs(arr[i] - arr[i - 1]));
  return out;
}

/**
 * Returns the full check object `{ id, pass, detail }` for a given check id,
 * or null if the check didn't run in this tick.
 */
function findCheck(quality, checkId) {
  if (!quality || !Array.isArray(quality.checks)) return null;
  for (var i = 0; i < quality.checks.length; i++) {
    var ck = quality.checks[i];
    if (ck && ck.id === checkId) return ck;
  }
  return null;
}

/**
 * Returns the detail object for a specific check id when the check ran and
 * was not skipped, or null otherwise.
 */
function findCheckDetail(quality, checkId) {
  if (!quality || !Array.isArray(quality.checks)) return null;
  for (var i = 0; i < quality.checks.length; i++) {
    var ck = quality.checks[i];
    if (ck && ck.id === checkId && ck.detail && !ck.detail.skipped) return ck.detail;
  }
  return null;
}

/** Initializes per-recording collector state on ctx. Call at recording start. */
export function initRecordCollector(ctx) {
  ctx.recordCollector = {
    tickCount: 0,
    faceDetectedSum: 0,
    qualityOkSum: 0,
    reasonCounts: {},
    widthFracs: [],
    bboxAreaFracs: [],
    centerOffsetsX: [],
    centerOffsetsY: [],
    centerOffsets: [],
    faceContained: [],
    asymmetryRatios: [],
    lumaValues: [],
    overexposedRatios: [],
    underexposedRatios: [],
    facePrevDetected: false,
    faceLostCount: 0,
    faceLostStreakStartMs: null,
    faceLongestLostStreakMs: 0,
    yawRatios: [],
    rollRatios: [],
    pitchOkValues: [],
    poseRunCount: 0,
    poseBadCount: 0,
    lumaStdValues: [],
    brightnessJumpCount: 0,
    motionRunCount: 0,
    motionBadCount: 0,
    foreheadSkinFracs: [],
    leftCheekSkinFracs: [],
    rightCheekSkinFracs: [],
  };
  ctx.recordCollectorSeq = 0;
}

/**
 * Records one quality tick. Call from tickCameraRecordFraming after evaluateFaceQuality.
 * @param {object} ctx
 * @param {object|null} box
 * @param {object} quality
 * @param {{ sx: number, sy: number, sw: number, sh: number }|null} [visibleRegion]
 *   Precomputed cover crop region; omit on throttled ticks (geometry skipped).
 * @param {number} [nowMs] performance.now() timestamp for streak timing.
 */
export function collectRecordTick(ctx, box, quality, visibleRegion, nowMs) {
  var c = ctx.recordCollector;
  if (!c) return;

  c.tickCount += 1;
  if (box) c.faceDetectedSum += 1;
  if (quality && quality.ok) c.qualityOkSum += 1;

  // Face-loss streak tracking.
  var faceNow = !!box;
  if (!faceNow) {
    if (c.facePrevDetected) {
      c.faceLostCount += 1;
      if (nowMs != null) c.faceLostStreakStartMs = nowMs;
    } else if (nowMs != null && c.faceLostStreakStartMs != null) {
      var streak = nowMs - c.faceLostStreakStartMs;
      if (streak > c.faceLongestLostStreakMs) c.faceLongestLostStreakMs = streak;
    }
  } else if (!c.facePrevDetected && c.faceLostStreakStartMs != null && nowMs != null) {
    var recovered = nowMs - c.faceLostStreakStartMs;
    if (recovered > c.faceLongestLostStreakMs) c.faceLongestLostStreakMs = recovered;
    c.faceLostStreakStartMs = null;
  }
  c.facePrevDetected = faceNow;

  var failedId =
    quality && quality.artifact && quality.artifact.failedCheckId
      ? quality.artifact.failedCheckId
      : null;
  if (failedId) c.reasonCounts[failedId] = (c.reasonCounts[failedId] || 0) + 1;

  // Collect luminance and exposure stats from checks 6-9 (desktop only; skipped on phone).
  if (box && quality) {
    var check6 = findCheckDetail(quality, "6_brightness_in_range");
    if (check6 && typeof check6.meanLuminance === "number") {
      c.lumaValues.push(check6.meanLuminance);
    }
    var check7 = findCheckDetail(quality, "7_no_overexposed_skin");
    if (check7 && typeof check7.overexposedRatio === "number") {
      c.overexposedRatios.push(check7.overexposedRatio);
    }
    var check8 = findCheckDetail(quality, "8_no_underexposed_skin");
    if (check8 && typeof check8.underexposedRatio === "number") {
      c.underexposedRatios.push(check8.underexposedRatio);
    }
    var check9 = findCheckDetail(quality, "9_left_right_illumination_symmetric");
    if (check9 && typeof check9.sideAsymmetryRatio === "number") {
      c.asymmetryRatios.push(check9.sideAsymmetryRatio);
    }

    // Head pose from check 4 — landmarks mode only (no mesh on phone during record).
    var c4 = findCheck(quality, "4_face_pose_frontal");
    if (c4 && c4.detail && c4.detail.mode === "landmarks") {
      c.poseRunCount += 1;
      if (!c4.pass) c.poseBadCount += 1;
      if (typeof c4.detail.yawRatio === "number") c.yawRatios.push(c4.detail.yawRatio);
      if (typeof c4.detail.rollRatio === "number") c.rollRatios.push(c4.detail.rollRatio);
      if (typeof c4.detail.pitchOk === "boolean") c.pitchOkValues.push(c4.detail.pitchOk ? 1 : 0);
    }

    // ROI skin fractions from check 5 — skin_classification mode only (landmarks required).
    var c5 = findCheckDetail(quality, "5_anatomy_visible");
    if (c5 && c5.mode === "skin_classification" && c5.regions) {
      var fh = c5.regions.forehead;
      if (fh && typeof fh.skinFraction === "number") c.foreheadSkinFracs.push(fh.skinFraction);
      var lc = c5.regions.leftCheek;
      if (lc && typeof lc.skinFraction === "number") c.leftCheekSkinFracs.push(lc.skinFraction);
      var rc = c5.regions.rightCheek;
      if (rc && typeof rc.skinFraction === "number") c.rightCheekSkinFracs.push(rc.skinFraction);
    }

    // Check 10: brightness stability — counts jumps and collects rolling luma std.
    var ck10 = findCheck(quality, "10_brightness_stable_over_time");
    if (ck10 && ck10.detail && !ck10.detail.skipped) {
      if (typeof ck10.detail.brightnessStd === "number") c.lumaStdValues.push(ck10.detail.brightnessStd);
      if (!ck10.pass) c.brightnessJumpCount += 1;
    }

    // Check 11: head motion — tracks severe-motion fraction.
    var ck11 = findCheck(quality, "11_head_motion_low");
    if (ck11 && ck11.detail && !ck11.detail.skipped) {
      c.motionRunCount += 1;
      if (!ck11.pass) c.motionBadCount += 1;
    }
  }

  if (!box || !visibleRegion || visibleRegion.sw <= 0 || visibleRegion.sh <= 0) {
    return;
  }

  var reg = visibleRegion;
  var widthFrac = box.width / reg.sw;
  c.widthFracs.push(widthFrac);
  c.bboxAreaFracs.push(widthFrac * widthFrac);

  var boxCx = box.x + box.width * 0.5;
  var boxCy = box.y + box.height * 0.5;
  var regCx = reg.sx + reg.sw * 0.5;
  var regCy = reg.sy + reg.sh * 0.5;
  var ox = (boxCx - regCx) / reg.sw;
  var oy = (boxCy - regCy) / reg.sh;
  c.centerOffsetsX.push(ox);
  c.centerOffsetsY.push(oy);
  c.centerOffsets.push(Math.sqrt(ox * ox + oy * oy));

  var contained =
    box.x >= reg.sx &&
    box.y >= reg.sy &&
    box.x + box.width <= reg.sx + reg.sw &&
    box.y + box.height <= reg.sy + reg.sh;
  c.faceContained.push(contained ? 1 : 0);
}

/**
 * Computes aggregates from collected ticks and writes them to ctx.cameraMetadata.
 * Call once when recording stops (success or discard).
 * @param {object} ctx
 * @param {number} [nowMs] performance.now() at stop time, used to close any open face-loss streak.
 */
export function finalizeRecordCollector(ctx, nowMs) {
  var c = ctx.recordCollector;
  ctx.recordCollector = null;
  ctx.recordCollectorSeq = 0;
  if (!ctx.cameraMetadata || !c) return;

  var total = c.tickCount;
  if (!total) return;

  ctx.cameraMetadata.face_detected_ratio = r3(c.faceDetectedSum / total);
  ctx.cameraMetadata.face_ok_fraction = r3(c.qualityOkSum / total);
  ctx.cameraMetadata.face_contained_fraction = r3(
    c.faceContained.length ? mean(c.faceContained) : null,
  );
  ctx.cameraMetadata.quality_reason_counts = c.reasonCounts;
  ctx.cameraMetadata.frontend_quality_mean = ctx.cameraMetadata.face_ok_fraction;
  ctx.cameraMetadata.frontend_quality_min = c.qualityOkSum < total ? 0 : 1;

  if (c.widthFracs.length) {
    ctx.cameraMetadata.face_width_fraction_mean = r3(mean(c.widthFracs));
    ctx.cameraMetadata.face_width_fraction_median = r3(median(c.widthFracs));
    ctx.cameraMetadata.face_width_fraction_std = r3(stddev(c.widthFracs));
    ctx.cameraMetadata.face_bbox_area_ratio_mean = r3(mean(c.bboxAreaFracs));
  }

  if (c.centerOffsets.length) {
    ctx.cameraMetadata.face_center_offset_mean = r3(mean(c.centerOffsets));
    ctx.cameraMetadata.face_center_offset_p95 = r3(percentile(c.centerOffsets, 95));
    ctx.cameraMetadata.face_center_offset_x_mean = r3(mean(c.centerOffsetsX));
    ctx.cameraMetadata.face_center_offset_y_mean = r3(mean(c.centerOffsetsY));
  }

  // Center jitter: frame-to-frame Euclidean displacement of face center.
  if (c.centerOffsetsX.length >= 2) {
    var cjDeltas = [];
    for (var i = 1; i < c.centerOffsetsX.length; i++) {
      var dx = c.centerOffsetsX[i] - c.centerOffsetsX[i - 1];
      var dy = c.centerOffsetsY[i] - c.centerOffsetsY[i - 1];
      cjDeltas.push(Math.sqrt(dx * dx + dy * dy));
    }
    ctx.cameraMetadata.center_jitter_mean = r3(mean(cjDeltas));
    ctx.cameraMetadata.center_jitter_p95 = r3(percentile(cjDeltas, 95));
  }

  // Scale jitter: frame-to-frame absolute change in face width fraction.
  if (c.widthFracs.length >= 2) {
    var sjDeltas = consecutiveDeltas(c.widthFracs);
    ctx.cameraMetadata.scale_jitter_mean = r3(mean(sjDeltas));
    ctx.cameraMetadata.scale_jitter_p95 = r3(percentile(sjDeltas, 95));
  }

  // Close any open face-loss streak (recording stopped while face was absent).
  if (c.faceLostStreakStartMs != null && nowMs != null) {
    var closingStreak = nowMs - c.faceLostStreakStartMs;
    if (closingStreak > c.faceLongestLostStreakMs) c.faceLongestLostStreakMs = closingStreak;
  }
  ctx.cameraMetadata.face_lost_count = c.faceLostCount;
  if (c.faceLongestLostStreakMs > 0) {
    ctx.cameraMetadata.longest_face_lost_streak_ms = Math.round(c.faceLongestLostStreakMs);
  }

  // Face luma stats from check 6 (desktop only; skipped when skipRecordLuminanceChecks).
  if (c.lumaValues.length) {
    var lumaArr = c.lumaValues.slice().sort(function (a, b) { return a - b; });
    ctx.cameraMetadata.face_luma_mean = r3(mean(c.lumaValues));
    ctx.cameraMetadata.face_luma_std = r3(stddev(c.lumaValues));
    ctx.cameraMetadata.face_luma_min = r3(lumaArr[0]);
    ctx.cameraMetadata.face_luma_p05 = r3(percentile(c.lumaValues, 5));
  }

  // Exposure fractions from checks 7 and 8 (desktop only).
  if (c.overexposedRatios.length) {
    ctx.cameraMetadata.near_white_face_pixel_fraction = r3(mean(c.overexposedRatios));
  }
  if (c.underexposedRatios.length) {
    ctx.cameraMetadata.near_black_face_pixel_fraction = r3(mean(c.underexposedRatios));
  }

  // Brightness asymmetry: left/right luminance ratio from check 9 (desktop only).
  if (c.asymmetryRatios.length) {
    ctx.cameraMetadata.brightness_asymmetry_mean = r3(mean(c.asymmetryRatios));
    ctx.cameraMetadata.brightness_asymmetry_p95 = r3(percentile(c.asymmetryRatios, 95));
  }

  // Brightness stability from check 10 (desktop only; phone has no luma history).
  // brightness_jump_count is only written when check 10 ran to avoid a spurious 0 on phone.
  if (c.lumaStdValues.length) {
    ctx.cameraMetadata.rolling_luma_std_mean = r3(mean(c.lumaStdValues));
    ctx.cameraMetadata.brightness_jump_count = c.brightnessJumpCount;
  }

  // Severe motion fraction from check 11.
  if (c.motionRunCount > 0) {
    ctx.cameraMetadata.severe_motion_fraction = r3(c.motionBadCount / c.motionRunCount);
  }

  // ROI skin fractions from check 5 (skin_classification mode; landmarks required).
  if (c.foreheadSkinFracs.length) ctx.cameraMetadata.forehead_visible_ratio = r3(mean(c.foreheadSkinFracs));
  if (c.leftCheekSkinFracs.length) ctx.cameraMetadata.left_cheek_visible_ratio = r3(mean(c.leftCheekSkinFracs));
  if (c.rightCheekSkinFracs.length) ctx.cameraMetadata.right_cheek_visible_ratio = r3(mean(c.rightCheekSkinFracs));

  // Head pose ratios from check 4 (landmarks mode only; absent when mesh is off during record).
  if (c.yawRatios.length) ctx.cameraMetadata.head_yaw_mean = r3(mean(c.yawRatios));
  if (c.rollRatios.length) ctx.cameraMetadata.head_roll_mean = r3(mean(c.rollRatios));
  if (c.pitchOkValues.length) ctx.cameraMetadata.head_pitch_mean = r3(mean(c.pitchOkValues));
  if (c.poseRunCount > 0) {
    ctx.cameraMetadata.head_pose_bad_fraction = r3(c.poseBadCount / c.poseRunCount);
  }

  // Motion score: weighted composite of center and scale jitter (lower = smoother).
  var cjm = ctx.cameraMetadata.center_jitter_mean;
  var sjm = ctx.cameraMetadata.scale_jitter_mean;
  if (cjm != null && sjm != null) {
    ctx.cameraMetadata.motion_score = r3(cjm + sjm * 0.5);
  }
}
