import * as H from "../../utils/face_scan/helpers.js";
import * as Dbg from "../../utils/face_scan/debug.js";

/** Resolves the minimum allowed face luminance from config with fallback defaults. */
export function resolveFaceMinMeanLuminance(cfg) {
  return typeof cfg.faceMinMeanLuminance === "number" &&
    Number.isFinite(cfg.faceMinMeanLuminance)
    ? cfg.faceMinMeanLuminance
    : H.DEFAULT_FACE_MIN_MEAN_LUMINANCE;
}

/** Resolves the maximum allowed face luminance from config with fallback defaults. */
export function resolveFaceMaxMeanLuminance(cfg) {
  return typeof cfg.faceMaxMeanLuminance === "number" &&
    Number.isFinite(cfg.faceMaxMeanLuminance)
    ? cfg.faceMaxMeanLuminance
    : H.DEFAULT_FACE_MAX_MEAN_LUMINANCE;
}

/** Builds one normalized quality-check result entry for reports. */
export function qualityCheck(id, pass, detail) {
  return { id: id, pass: !!pass, detail: detail || {} };
}

/** Returns directional framing guidance, defaulting to center instruction. */
export function getGuideOrCenter(state, box) {
  if (!box) {
    return { direction: "center", message: "Center your face." };
  }
  return (
    H.getFaceFramingGuidance(
      box,
      state.el.preview,
      state.cfg.faceMinFrac,
      state.cfg.faceMaxFrac,
    ) || { direction: "center", message: "Center your face." }
  );
}

/** Returns guide message when available, otherwise the provided fallback text. */
export function resolveGuideMessage(guide, fallbackMessage) {
  return guide && guide.message ? guide.message : fallbackMessage;
}

/**
 * Converts a normalized landmark point to preview pixel coordinates.
 * Returns null when the point or preview dimensions are not usable.
 */
export function getLandmarkPx(landmarks, index, preview) {
  if (!Array.isArray(landmarks)) return null;
  var p = landmarks[index];
  if (!p) return null;
  var x = Number(p.x);
  var y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  var vw = preview && preview.videoWidth ? preview.videoWidth : 0;
  var vh = preview && preview.videoHeight ? preview.videoHeight : 0;
  if (!vw || !vh) return null;
  return { x: x * vw, y: y * vh };
}

/**
 * Evaluates whether face pose is frontal enough for reliable measurement.
 * Uses landmarks when available and falls back to box aspect heuristics.
 */
export function evaluatePoseCheck(state, box, landmarks) {
  var preview = state.el.preview;
  var maxRoll = Number(state.cfg.maxLandmarkRollRatio) || 0.18;
  var maxYaw = Number(state.cfg.maxLandmarkYawRatio) || 0.35;
  var eyeL = getLandmarkPx(landmarks, 33, preview);
  var eyeR = getLandmarkPx(landmarks, 263, preview);
  var nose = getLandmarkPx(landmarks, 1, preview);
  var mouth = getLandmarkPx(landmarks, 13, preview);
  if (eyeL && eyeR && nose) {
    var eyeDx = eyeR.x - eyeL.x;
    var eyeDy = eyeR.y - eyeL.y;
    var eyeDist = Math.max(1, Math.sqrt(eyeDx * eyeDx + eyeDy * eyeDy));
    var rollRatio = Math.abs(eyeDy) / eyeDist;
    var eyesMidX = (eyeL.x + eyeR.x) * 0.5;
    var yawRatio = Math.abs(nose.x - eyesMidX) / eyeDist;
    var pitchOk = true;
    if (mouth) {
      pitchOk = nose.y > eyeL.y - eyeDist * 0.2 && nose.y < mouth.y + eyeDist * 0.4;
    }
    var pass = rollRatio <= maxRoll && yawRatio <= maxYaw && pitchOk;
    return {
      pass: pass,
      detail: {
        mode: "landmarks",
        rollRatio: Number(rollRatio.toFixed(3)),
        maxRoll: maxRoll,
        yawRatio: Number(yawRatio.toFixed(3)),
        maxYaw: maxYaw,
        pitchOk: pitchOk,
      },
    };
  }

  if (!box || box.width <= 0 || box.height <= 0) {
    return { pass: false, detail: { mode: "heuristic", reason: "no_box" } };
  }
  var ratio = box.width / box.height;
  var min = Number(state.cfg.poseRatioMin) || 0.65;
  var max = Number(state.cfg.poseRatioMax) || 1.35;
  return {
    pass: ratio >= min && ratio <= max,
    detail: {
      mode: "heuristic",
      widthHeightRatio: Number(ratio.toFixed(3)),
      min: min,
      max: max,
    },
  };
}

/**
 * Evaluates forehead/cheeks/nose bridge visibility using:
 *   1. Boundary check — landmarks inside visible frame
 *   2. Skin classification — pixel YCbCr analysis on each ROI patch
 *   3. Geometric coherence — debug metric only (not used to fail)
 *
 * Fails only on strong signals: very low skin fraction and/or severe out-of-frame.
 * Uses a short fail streak to avoid one-frame glitches.
 */
var VISIBILITY_FAIL_STREAK_REQUIRED = 10;

export function evaluateVisibilityCheck(state, box, landmarks) {
  var reg = H.getCoverVisibleRegion(state.el.preview);
  if (!reg || !box) {
    return { pass: false, detail: { reason: "no_visible_region_or_box" } };
  }
  var preview = state.el.preview;
  if (!preview || preview.readyState < 2) {
    return { pass: false, detail: { reason: "no_video_dimensions" } };
  }
  var vw = preview.videoWidth;
  var vh = preview.videoHeight;
  if (!vw || !vh) {
    return { pass: false, detail: { reason: "no_video_dimensions" } };
  }

  if (!Array.isArray(landmarks) || landmarks.length === 0) {
    if (!box || box.width <= 0 || box.height <= 0) {
      return { pass: false, detail: { reason: "no_landmarks_no_box" } };
    }
    var fbCanvas = getOrCreateSamplingCanvas(vw, vh);
    var fbCtx = fbCanvas.getContext("2d", { willReadFrequently: true });
    if (!fbCtx) return { pass: true, detail: { mode: "box_fallback", skipped: true } };
    try {
      fbCtx.drawImage(preview, 0, 0, vw, vh);
    } catch (_e) {
      return { pass: true, detail: { mode: "box_fallback", skipped: true } };
    }
    var fbCx = box.x + box.width * 0.5;
    var fbCy = box.y + box.height * 0.45;
    var fbR = Math.max(12, Math.min(48, box.width * 0.22));
    var fbSkin = classifySkinFraction(fbCtx, fbCx, fbCy, fbR, vw, vh);
    return {
      pass: fbSkin >= 0.22,
      detail: { mode: "box_fallback", skinFraction: Number(fbSkin.toFixed(3)) },
    };
  }

  var ROIS = {
    noseBridge: {
      indices: [1, 2, 3, 4, 5, 6, 168, 197],
      minSkin: 0.24,
      minBoundary: 0.55,
      severeBoundary: 0.45,
    },
    forehead: {
      indices: [10, 67, 69, 104, 108, 151, 337, 299],
      minSkin: 0.2,
      minBoundary: 0.55,
      severeBoundary: 0.4,
      sampleShiftY: 0.35,
    },
    leftCheek: {
      indices: [234, 227, 116, 123, 132, 93],
      minSkin: 0.24,
      minBoundary: 0.55,
      severeBoundary: 0.45,
    },
    rightCheek: {
      indices: [454, 447, 345, 352, 361, 323],
      minSkin: 0.24,
      minBoundary: 0.55,
      severeBoundary: 0.45,
    },
  };

  var canvas = getOrCreateSamplingCanvas(vw, vh);
  var ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx2d) {
    return { pass: false, detail: { reason: "no_video_dimensions" } };
  }
  try {
    ctx2d.drawImage(preview, 0, 0, vw, vh);
  } catch (_e) {
    return { pass: false, detail: { reason: "no_video_dimensions" } };
  }

  var marginX = reg.sw * (Number(state.cfg.faceVisibleMarginFracX) || 0.03);
  var marginY = reg.sh * (Number(state.cfg.faceVisibleMarginFracY) || 0.04);
  var insetL = reg.sx + marginX;
  var insetR = reg.sx + reg.sw - marginX;
  var insetT = reg.sy + marginY;
  var insetB = reg.sy + reg.sh - marginY;

  var issues = [];
  var blockingIssues = [];
  var regionStats = {};
  var q = state.ctx && state.ctx.quality ? state.ctx.quality : null;
  if (q && typeof q.visibilityFailStreak !== "number") q.visibilityFailStreak = 0;

  for (var name in ROIS) {
    var roi = ROIS[name];
    var pts = [];

    for (var i = 0; i < roi.indices.length; i++) {
      var p = getLandmarkPx(landmarks, roi.indices[i], preview);
      if (!p) continue;
      if (p.x < insetL || p.x > insetR || p.y < insetT || p.y > insetB) continue;
      pts.push(p);
    }

    var boundaryRatio = pts.length / roi.indices.length;

    var severeBoundary = roi.severeBoundary != null ? roi.severeBoundary : 0.45;
    if (boundaryRatio < severeBoundary) {
      var outCode = name + "_out_of_frame";
      issues.push(outCode);
      blockingIssues.push(outCode);
      regionStats[name] = { boundaryRatio: boundaryRatio, pass: false, reason: "out_of_frame" };
      continue;
    }

    if (pts.length < 3) {
      issues.push(name + "_insufficient_landmarks");
      regionStats[name] = {
        boundaryRatio: boundaryRatio,
        pass: false,
        reason: "insufficient_landmarks",
      };
      continue;
    }

    var cx = 0;
    var cy = 0;
    for (var j = 0; j < pts.length; j++) {
      cx += pts[j].x;
      cy += pts[j].y;
    }
    cx /= pts.length;
    cy /= pts.length;

    var patchRadius = estimatePatchRadius(pts, cx, cy);
    var sampleCy = cy;
    if (roi.sampleShiftY) {
      sampleCy += patchRadius * roi.sampleShiftY;
    }
    var skinFraction = classifySkinFraction(ctx2d, cx, sampleCy, patchRadius, vw, vh);
    var coherence = computeGeometricCoherence(pts, name);

    var stat = {
      boundaryRatio: Number(boundaryRatio.toFixed(3)),
      skinFraction: Number(skinFraction.toFixed(3)),
      coherence: Number(coherence.toFixed(3)),
      patchRadius: Math.round(patchRadius),
      centroid: { x: Math.round(cx), y: Math.round(sampleCy) },
      pass: true,
    };

    if (skinFraction < roi.minSkin) {
      var skinCode = name + "_non_skin_occlusion";
      issues.push(skinCode);
      stat.pass = false;
      stat.reason = "non_skin_occlusion";
    } else if (coherence < 0.45) {
      issues.push(name + "_geometry_distorted");
      stat.reason = "geometry_distorted";
    }

    regionStats[name] = stat;
  }

  for (var bi = 0; bi < issues.length; bi++) {
    var issueCode = issues[bi];
    if (issueCode.indexOf("_non_skin_occlusion") >= 0) {
      blockingIssues.push(issueCode);
    }
  }

  var nonSkinCount = 0;
  var noseNonSkin = false;
  for (var bj = 0; bj < blockingIssues.length; bj++) {
    if (blockingIssues[bj].indexOf("_non_skin_occlusion") >= 0) {
      nonSkinCount++;
      if (blockingIssues[bj].indexOf("noseBridge_") === 0) noseNonSkin = true;
    }
  }

  var rawPass = true;
  if (noseNonSkin && nonSkinCount >= 1) rawPass = false;
  else if (nonSkinCount >= 2) rawPass = false;
  else {
    var severeOutCount = 0;
    for (var bk = 0; bk < blockingIssues.length; bk++) {
      if (blockingIssues[bk].indexOf("_out_of_frame") >= 0) severeOutCount++;
    }
    if (severeOutCount >= 2) rawPass = false;
  }

  var pass = rawPass;
  if (q) {
    if (rawPass) {
      q.visibilityFailStreak = 0;
    } else {
      q.visibilityFailStreak++;
      pass = q.visibilityFailStreak < VISIBILITY_FAIL_STREAK_REQUIRED;
    }
  }

  return {
    pass: pass,
    detail: {
      mode: "skin_classification",
      regions: regionStats,
      issues: issues,
      blockingIssues: blockingIssues,
      rawPass: rawPass,
      failStreak: q ? q.visibilityFailStreak : 0,
    },
  };
}

var _samplingCanvas = null;
var _samplingCanvasW = 0;
var _samplingCanvasH = 0;

function getOrCreateSamplingCanvas(w, h) {
  if (!_samplingCanvas || _samplingCanvasW !== w || _samplingCanvasH !== h) {
    _samplingCanvas = document.createElement("canvas");
    _samplingCanvas.width = w;
    _samplingCanvas.height = h;
    _samplingCanvasW = w;
    _samplingCanvasH = h;
  }
  return _samplingCanvas;
}

function estimatePatchRadius(pts, cx, cy) {
  var sum = 0;
  for (var i = 0; i < pts.length; i++) {
    var dx = pts[i].x - cx;
    var dy = pts[i].y - cy;
    sum += Math.sqrt(dx * dx + dy * dy);
  }
  var mean = sum / pts.length;
  return Math.max(10, Math.min(60, mean * 1.4));
}

function classifySkinFraction(ctx2d, cx, cy, radius, vw, vh) {
  var r = Math.ceil(radius);
  var x0 = Math.max(0, Math.round(cx - r));
  var y0 = Math.max(0, Math.round(cy - r));
  var x1 = Math.min(vw, Math.round(cx + r));
  var y1 = Math.min(vh, Math.round(cy + r));
  var pw = x1 - x0;
  var ph = y1 - y0;

  if (pw <= 0 || ph <= 0) return 0;

  var imageData;
  try {
    imageData = ctx2d.getImageData(x0, y0, pw, ph);
  } catch (_e) {
    return 0;
  }

  var data = imageData.data;
  var skinCount = 0;
  var totalCount = 0;
  var r2 = radius * radius;

  for (var py = 0; py < ph; py++) {
    for (var px = 0; px < pw; px++) {
      var dx = x0 + px - cx;
      var dy = y0 + py - cy;
      if (dx * dx + dy * dy > r2) continue;

      var idx = (py * pw + px) * 4;
      var R = data[idx];
      var G = data[idx + 1];
      var B = data[idx + 2];

      var Y = 0.299 * R + 0.587 * G + 0.114 * B;
      var Cb = -0.169 * R - 0.331 * G + 0.5 * B + 128;
      var Cr = 0.5 * R - 0.419 * G - 0.081 * B + 128;

      totalCount++;
      if (Y > 35 && Y < 245 && Cb > 75 && Cb < 145 && Cr > 125 && Cr < 190) {
        skinCount++;
      }
    }
  }

  return totalCount > 0 ? skinCount / totalCount : 0;
}

function computeGeometricCoherence(pts, regionName) {
  if (pts.length < 3) return 0;

  var minX = Infinity;
  var maxX = -Infinity;
  var minY = Infinity;
  var maxY = -Infinity;
  for (var i = 0; i < pts.length; i++) {
    if (pts[i].x < minX) minX = pts[i].x;
    if (pts[i].x > maxX) maxX = pts[i].x;
    if (pts[i].y < minY) minY = pts[i].y;
    if (pts[i].y > maxY) maxY = pts[i].y;
  }

  var spanX = maxX - minX;
  var spanY = maxY - minY;
  var aspectRatio = spanX > 0 ? spanY / spanX : 0;
  var expectedAspect = 1.0;
  if (regionName === "noseBridge") expectedAspect = 2.5;
  else if (regionName === "forehead") expectedAspect = 0.45;
  var aspectDenom = Math.max(0.2, expectedAspect);
  var aspectScore = 1 - Math.min(1, Math.abs(aspectRatio - expectedAspect) / aspectDenom);

  var bboxArea = spanX * spanY;
  if (bboxArea < 1) return aspectScore;

  var hullArea = approximateClusterArea(pts);
  var compactness = Math.min(1, hullArea / (bboxArea * 0.9));

  return 0.5 * aspectScore + 0.5 * compactness;
}

function approximateClusterArea(pts) {
  if (pts.length < 3) return 0;

  var cx = 0;
  var cy = 0;
  for (var i = 0; i < pts.length; i++) {
    cx += pts[i].x;
    cy += pts[i].y;
  }
  cx /= pts.length;
  cy /= pts.length;

  var sorted = pts.slice().sort(function (a, b) {
    return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
  });

  var area = 0;
  for (var j = 0; j < sorted.length; j++) {
    var next = sorted[(j + 1) % sorted.length];
    area += sorted[j].x * next.y;
    area -= next.x * sorted[j].y;
  }
  return Math.abs(area) / 2;
}

/** Appends a value to a bounded rolling array, trimming oldest samples. */
function pushRollingValue(arr, value, maxLen) {
  if (!Array.isArray(arr)) return;
  arr.push(value);
  while (arr.length > maxLen) arr.shift();
}

/** Returns the arithmetic mean for a numeric array. */
function mean(arr) {
  if (!arr || !arr.length) return 0;
  var sum = 0;
  for (var i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

/** Returns population standard deviation for a numeric array. */
function stddev(arr) {
  if (!arr || arr.length < 2) return 0;
  var m = mean(arr);
  var varSum = 0;
  for (var i = 0; i < arr.length; i++) {
    var d = arr[i] - m;
    varSum += d * d;
  }
  return Math.sqrt(varSum / arr.length);
}

/**
 * Samples and stores rolling temporal traces (brightness, green channel, motion).
 * frameDtHistory (used by the FPS check) is NOT populated here — it's fed
 * directly by face_scan_fps_monitor.js from real video frame timestamps, not
 * this function's polling-loop tick cadence.
 */
export function collectQualityTraces(state, box, metrics, nowMs) {
  var q = state.ctx.quality;
  var historyLen = Number(state.cfg.qualityHistoryLen) || 24;
  if (metrics && Number.isFinite(metrics.meanLuminance)) {
    pushRollingValue(q.brightnessHistory, metrics.meanLuminance, historyLen);
  }
  if (metrics && Number.isFinite(metrics.meanGreen)) {
    pushRollingValue(q.greenHistory, metrics.meanGreen, historyLen);
  }
  q.lastSampleAt = nowMs;
  if (box) {
    var cx = box.x + box.width * 0.5;
    var cy = box.y + box.height * 0.5;
    if (q.lastCenter) {
      var dx = cx - q.lastCenter.x;
      var dy = cy - q.lastCenter.y;
      var speed = Math.sqrt(dx * dx + dy * dy);
      pushRollingValue(q.motionHistory, speed, historyLen);
    }
    q.lastCenter = { x: cx, y: cy };
  } else {
    q.lastCenter = null;
  }
}

/** Validates temporal stability constraints such as FPS, jitter, motion, and light drift. */
export function evaluateTemporalQuality(state, preview) {
  var q = state.ctx.quality;
  var reg = H.getCoverVisibleRegion(preview);
  var regScale = reg ? Math.max(1, reg.sw) : 640;
  var checks = [];

  var dtAvg = mean(q.frameDtHistory);
  var dtStd = stddev(q.frameDtHistory);
  var minFps = Number(state.cfg.minStableFps) || 7;
  var maxDtRatio = Number(state.cfg.maxFrameDtStdRatio) || 0.45;
  if (q.frameDtHistory.length >= 8) {
    var fps = dtAvg > 0 ? 1000 / dtAvg : 0;
    var stableRatio = dtAvg > 0 ? dtStd / dtAvg : 0;
    var fpsTier = fps >= 25 ? "ok" : fps >= 20 ? "caution" : fps >= minFps ? "low" : "blocked";
    var frameRateStable = fps >= minFps && stableRatio <= maxDtRatio;
    checks.push(
      qualityCheck("12_frame_rate_stable", frameRateStable, {
        fps: Number(fps.toFixed(1)),
        minFps: minFps,
        tier: fpsTier,
        dtStdRatio: Number(stableRatio.toFixed(3)),
        maxDtStdRatio: maxDtRatio,
        samples: q.frameDtHistory.length,
      }),
    );
    if (fps < minFps) {
      if (state.ctx && state.ctx.skipFpsGate) {
        checks[checks.length - 1] = qualityCheck("12_frame_rate_stable", true, {
          fps: Number(fps.toFixed(1)),
          minFps: minFps,
          tier: "skipped",
          skippedGate: true,
        });
      } else {
        return {
          ok: false,
          message: "Camera FPS is too low. Hold steady and close background apps.",
          checks: checks,
          fpsLow: true,
        };
      }
    }
    if (stableRatio > maxDtRatio) {
      return {
        ok: false,
        message: "Frame rate is unstable. Keep camera and device steady.",
        checks: checks,
      };
    }
    if (fpsTier === "low") {
      return {
        ok: true,
        checks: checks,
        fpsTier: "low",
        fpsWarning: "FPS is low (" + Number(fps.toFixed(0)) + " fps). Close background apps for better quality.",
      };
    }
    if (fpsTier === "caution") {
      return {
        ok: true,
        checks: checks,
        fpsTier: "caution",
        fpsWarning: "FPS slightly low (" + Number(fps.toFixed(0)) + " fps). Recording quality may be limited.",
      };
    }
  } else {
    checks.push(
      qualityCheck("12_frame_rate_stable", true, {
        skipped: true,
        reason: "warming_up",
        needSamples: 8,
        have: q.frameDtHistory.length,
      }),
    );
  }

  var maxMotion = Number(state.cfg.maxHeadMotionFracPerSample) || 0.028;
  if (q.motionHistory.length >= 6) {
    var motionPx = mean(q.motionHistory);
    var motionFrac = motionPx / regScale;
    checks.push(
      qualityCheck("11_head_motion_low", motionFrac <= maxMotion, {
        motionFrac: Number(motionFrac.toFixed(4)),
        maxMotionFrac: maxMotion,
        samples: q.motionHistory.length,
      }),
    );
    if (motionFrac > maxMotion) {
      return {
        ok: false,
        message: "Hold still for a few seconds.",
        checks: checks,
      };
    }
  } else {
    checks.push(
      qualityCheck("11_head_motion_low", true, {
        skipped: true,
        needSamples: 6,
        have: q.motionHistory.length,
      }),
    );
  }

  var maxBrightStd = Number(state.cfg.maxBrightnessStd) || 15;
  if (q.brightnessHistory.length >= 8) {
    var brightStd = stddev(q.brightnessHistory);
    checks.push(
      qualityCheck("10_brightness_stable_over_time", brightStd <= maxBrightStd, {
        brightnessStd: Number(brightStd.toFixed(2)),
        maxStd: maxBrightStd,
        samples: q.brightnessHistory.length,
      }),
    );
    if (brightStd > maxBrightStd) {
      return {
        ok: false,
        message: "Avoid changing light or moving the phone.",
        checks: checks,
      };
    }
  } else {
    checks.push(
      qualityCheck("10_brightness_stable_over_time", true, {
        skipped: true,
        needSamples: 8,
        have: q.brightnessHistory.length,
      }),
    );
  }

  var rppgEnabled = !!state.cfg.preliminaryRppgEnabled;
  var minGreenStd = Number(state.cfg.preliminaryRppgMinGreenStd) || 0.8;
  var maxGreenStd = Number(state.cfg.preliminaryRppgMaxGreenStd) || 30;
  var minRppgSamples = Number(state.cfg.preliminaryRppgMinSamples) || 150;
  if (rppgEnabled && q.greenHistory.length >= minRppgSamples) {
    var gStd = stddev(q.greenHistory);
    checks.push(
      qualityCheck("13_preliminary_rppg_signal", gStd >= minGreenStd && gStd <= maxGreenStd, {
        greenStd: Number(gStd.toFixed(2)),
        minGreenStd: minGreenStd,
        maxGreenStd: maxGreenStd,
        samples: q.greenHistory.length,
        note: "proxy: std-dev of mean green in face ROI",
      }),
    );
    if (gStd < minGreenStd) {
      return {
        ok: false,
        message: "Keep still and use steady, even light.",
        checks: checks,
      };
    }
    if (gStd > maxGreenStd) {
      return {
        ok: false,
        message: "Keep still and use steady, even light.",
        checks: checks,
      };
    }
  } else {
    checks.push(
      qualityCheck("13_preliminary_rppg_signal", true, {
        skipped: true,
        enabled: rppgEnabled,
        needSamples: minRppgSamples,
        have: q.greenHistory.length,
      }),
    );
  }

  return { ok: true, checks: checks };
}

/** Creates a compact snapshot of rolling quality traces for debug logs. */
function getQualityTracesSnapshot(state) {
  var q = state.ctx.quality;
  var dtAvg = mean(q.frameDtHistory);
  return {
    brightnessSamples: q.brightnessHistory.length,
    brightnessMean: Number(mean(q.brightnessHistory).toFixed(2)),
    brightnessStd: Number(stddev(q.brightnessHistory).toFixed(2)),
    greenSamples: q.greenHistory.length,
    greenMean: Number(mean(q.greenHistory).toFixed(2)),
    greenStd: Number(stddev(q.greenHistory).toFixed(2)),
    motionSamples: q.motionHistory.length,
    motionMeanPx: Number(mean(q.motionHistory).toFixed(2)),
    frameDtSamples: q.frameDtHistory.length,
    fpsEstimate: dtAvg > 0 ? Number((1000 / dtAvg).toFixed(1)) : 0,
    frameDtStdRatio:
      dtAvg > 0 ? Number((stddev(q.frameDtHistory) / dtAvg).toFixed(3)) : 0,
  };
}

/** Emits the current quality evaluation payload to debug logging. */
export function publishQualityReport(phase, state, result, box, metrics, landmarks) {
  if (!Dbg.isFaceScanDebugEnabled()) return;
  // Record phase runs ~250 ticks/take; skip heavy trace/metrics snapshots here —
  // they were running every 120ms even when debug logging deduped the output.
  var includeHeavyDebug = phase !== "record";
  Dbg.logFaceScanQualityReport(phase, {
    ok: result.ok,
    message: result.message,
    artifact: result.artifact,
    checks: result.checks,
    metrics: includeHeavyDebug ? metrics : null,
    traces: includeHeavyDebug ? getQualityTracesSnapshot(state) : null,
    box: box
      ? {
          x: Number(box.x.toFixed(1)),
          y: Number(box.y.toFixed(1)),
          width: Number(box.width.toFixed(1)),
          height: Number(box.height.toFixed(1)),
        }
      : null,
    landmarkMode:
      landmarks && landmarks.length ? "landmark-based" : "bounding-box heuristic",
  });
}
