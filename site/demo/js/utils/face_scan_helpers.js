/**
 * Reusable helpers for the face scan UI.
 */

import { getDetectorOptions as getFaceDetectorOptions } from "./face_scan_face_model.js";

/**
 * `document.getElementById` shorthand.
 * @param {string} id
 * @returns {HTMLElement | null}
 */
export function byId(id) {
  return document.getElementById(id);
}

/**
 * Detector options for `faceapi.detectSingleFace`.
 * @returns {object | null}
 */
export function getDetectorOptions() {
  return getFaceDetectorOptions();
}

/** Picks a MediaRecorder MIME type browsers on this machine are likely to support. */
export function pickMimeType() {
  var mimeCandidates = [
    "video/mp4; codecs=avc1.42E01E",
    "video/mp4; codecs=avc1.4D0028",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (var i = 0; i < mimeCandidates.length; i++) {
    if (MediaRecorder.isTypeSupported(mimeCandidates[i]))
      return mimeCandidates[i];
  }
  return "";
}

/** `mm:ss` from milliseconds. */
export function formatTime(ms) {
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  var r = s % 60;
  return m + ":" + (r < 10 ? "0" : "") + r;
}

/** Human-readable explanation for typical getUserMedia errors. */
export function friendlyCameraMessage(err) {
  var name = err && err.name ? String(err.name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Camera access was blocked. Allow the camera for this site, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No camera was found.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The camera is busy or could not start.";
  }
  return "Could not open the camera. Use HTTPS or localhost.";
}

/**
 * Rectangle of **camera frame pixels** that are actually visible inside the `<video>` element when
 * CSS `object-fit: cover` scales the stream to fill the layout box (sides or top/bottom are cropped).
 *
 * Returned keys stay short for call sites: `sx,sy,sw,sh` = crop **origin + size** in intrinsic pixels;
 * `vw,vh` = full intrinsic frame size.
 *
 * @returns {{
 *   sx: number, sy: number, sw: number, sh: number,
 *   vw: number, vh: number
 * } | null}
 */
export function getCoverVisibleRegion(video) {
  var intrinsicW = video.videoWidth;
  var intrinsicH = video.videoHeight;
  var layoutW = video.offsetWidth || video.clientWidth;
  var layoutH = video.offsetHeight || video.clientHeight;
  if (!intrinsicW || !intrinsicH || !layoutW || !layoutH) return null;

  var videoAspect = intrinsicW / intrinsicH;
  var layoutAspect = layoutW / layoutH;

  var cropOriginX;
  var cropOriginY;
  var cropWidthPx;
  var cropHeightPx;

  if (videoAspect > layoutAspect) {
    // Frame is wider than the box (for its height): cover crops the **left and right** of the frame.
    cropHeightPx = intrinsicH;
    cropWidthPx = intrinsicH * layoutAspect;
    cropOriginX = (intrinsicW - cropWidthPx) / 2;
    cropOriginY = 0;
  } else {
    // Frame is taller than the box (for its width): cover crops **top and bottom**.
    cropWidthPx = intrinsicW;
    cropHeightPx = intrinsicW / layoutAspect;
    cropOriginX = 0;
    cropOriginY = (intrinsicH - cropHeightPx) / 2;
  }

  return {
    sx: cropOriginX,
    sy: cropOriginY,
    sw: cropWidthPx,
    sh: cropHeightPx,
    vw: intrinsicW,
    vh: intrinsicH,
  };
}

/**
 * True if face box is centered and sized in the cropped preview (mirrored selfie semantics).
 * @param {number} faceMinFrac
 * @param {number} faceMaxFrac
 */
export function isFaceWellFramed(box, video, faceMinFrac, faceMaxFrac) {
  var reg = getCoverVisibleRegion(video);
  if (!reg || !box) return false;
  var cxView = reg.vw - (box.x + box.width / 2);
  var cyView = box.y + box.height / 2;
  var cx0 = reg.sx + reg.sw / 2;
  var cy0 = reg.sy + reg.sh / 2;
  if (Math.abs(cxView - cx0) > reg.sw * 0.38) return false;
  if (Math.abs(cyView - cy0) > reg.sh * 0.42) return false;
  if (box.width < reg.sw * faceMinFrac || box.width > reg.sw * faceMaxFrac)
    return false;

  var top = box.y;
  var bottom = box.y + box.height;
  var bandTop = reg.sy + reg.sh * 0.06;
  var bandBot = reg.sy + reg.sh * 0.94;
  return top >= bandTop && bottom <= bandBot;
}

/**
 * Directional guidance when face is visible but off-center / off-size.
 * Returns null when no guidance is needed.
 */
export function getFaceFramingGuidance(box, video, faceMinFrac, faceMaxFrac) {
  var reg = getCoverVisibleRegion(video);
  if (!reg || !box) return null;

  // Same horizontal convention as `isFaceWellFramed`: mirror intrinsic X so
  // guidance matches what the user sees in the selfie preview (CSS scaleX flip).
  var cxView = reg.vw - (box.x + box.width / 2);
  var cyView = box.y + box.height / 2;
  var cx0 = reg.sx + reg.sw / 2;
  var cy0 = reg.sy + reg.sh / 2;

  // Positive dx = face is to the right of center → user should move slightly left.
  var dxPct = ((cxView - cx0) / reg.sw) * 100;
  // Positive dy = face is below vertical center → user should move slightly up.
  var dyPct = ((cyView - cy0) / reg.sh) * 100;

  var widthFrac = box.width / reg.sw;

  if (widthFrac < faceMinFrac) {
    return { direction: "near", message: "Move slightly closer." };
  }
  if (widthFrac > faceMaxFrac) {
    return { direction: "far", message: "Move slightly back." };
  }

  var absX = Math.abs(dxPct);
  var absY = Math.abs(dyPct);
  if (absX < 6 && absY < 7) return null;

  if (absX >= absY) {
    if (dxPct < 0) {
      return { direction: "right", message: "Move slightly to the right." };
    }
    return { direction: "left", message: "Move slightly to the left." };
  }

  if (dyPct < 0) {
    return { direction: "down", message: "Move slightly down." };
  }
  return { direction: "up", message: "Move slightly up." };
}

/** Minimum mean luma (0–255) over the face ROI before align/recording may proceed. Tune per backend sensitivity. */
export const DEFAULT_FACE_MIN_MEAN_LUMINANCE = 46;

var _luminanceCanvas = null;

/**
 * Mean perceptual luminance (BT.601) over the face bounding region in video pixels.
 * Downsamples for speed; returns null if sampling fails.
 * @param {HTMLVideoElement} video
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @returns {number | null}
 */
export function estimateFaceRegionMeanLuminance(video, box) {
  if (!video || !box || !video.videoWidth || video.readyState < 2) return null;
  var vw = video.videoWidth;
  var vh = video.videoHeight;
  var pad = 0.1;
  var bw = box.width * (1 + 2 * pad);
  var bh = box.height * (1 + 2 * pad);
  var bx = box.x + box.width / 2 - bw / 2;
  var by = box.y + box.height / 2 - bh / 2;
  var sx = Math.max(0, Math.floor(bx));
  var sy = Math.max(0, Math.floor(by));
  var sw = Math.min(vw - sx, Math.ceil(bw));
  var sh = Math.min(vh - sy, Math.ceil(bh));
  if (sw < 4 || sh < 4) return null;

  if (!_luminanceCanvas) _luminanceCanvas = document.createElement("canvas");
  var canvas = _luminanceCanvas;
  var maxSide = 96;
  var tw = Math.min(maxSide, sw);
  var th = Math.min(maxSide, sh);
  canvas.width = tw;
  canvas.height = th;
  var ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, tw, th);
  } catch (_e) {
    return null;
  }
  var imageData = ctx.getImageData(0, 0, tw, th);
  var data = imageData.data;
  var sum = 0;
  var n = 0;
  for (var i = 0; i < data.length; i += 4) {
    var r = data[i];
    var g = data[i + 1];
    var b = data[i + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
    n++;
  }
  return n > 0 ? sum / n : null;
}

/**
 * @param {HTMLVideoElement} video
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {number} [minMean]
 * @returns {boolean}
 */
export function isFaceRegionBrightEnough(video, box, minMean) {
  var min =
    typeof minMean === "number" && Number.isFinite(minMean)
      ? minMean
      : DEFAULT_FACE_MIN_MEAN_LUMINANCE;
  var L = estimateFaceRegionMeanLuminance(video, box);
  if (L == null || !Number.isFinite(L)) return false;
  console.log('L', L);
  console.log('min', min);
  return L >= min;
}

/** Maps detection box → CSS clip-path ellipse on the mirrored preview overlay. */
export function computeFaceScanEllipse(box, video) {
  if (!box || !video.videoWidth || video.readyState < 2) return null;
  var reg = getCoverVisibleRegion(video);
  if (!reg || reg.sw <= 8 || reg.sh <= 8) return null;
  // `flip-stack` already mirrors both video + overlay with CSS scaleX(-1),
  // so we should use detector X directly here (no extra mirror transform).
  var cxView = box.x + box.width * 0.5;
  var cyView = box.y + box.height * 0.43;
  var cxPct = ((cxView - reg.sx) / reg.sw) * 100;
  var cyPct = ((cyView - reg.sy) / reg.sh) * 100;
  var rxPct = Math.min(44, ((box.width / reg.sw) * 0.5 + 0.14) * 100);
  var ryPct = Math.min(50, ((box.height / reg.sh) * 0.5 + 0.18) * 100);
  return {
    cxPct: Math.min(99, Math.max(1, cxPct)),
    cyPct: Math.min(99, Math.max(1, cyPct)),
    rxPct: rxPct,
    ryPct: ryPct,
  };
}

/** Pauses MediaRecorder if supported when user leaves framing. */
export function safeRecorderPause(rec) {
  if (!rec || typeof rec.pause !== "function") return;
  if (rec.state === "recording")
    try {
      rec.pause();
    } catch (e0) {}
}

/** Resumes MediaRecorder after being paused (face back in frame). */
export function safeRecorderResume(rec) {
  if (!rec || typeof rec.resume !== "function") return;
  if (rec.state === "paused")
    try {
      rec.resume();
    } catch (e1) {}
}

/** Updates placement pill text and state-* class on the element. */
export function setPlacementUi(el, state, message) {
  if (!el) return;
  el.textContent = message;
  el.classList.remove("state-wait", "state-good", "state-bad");
  el.classList.add(
    state === "good"
      ? "state-good"
      : state === "bad"
        ? "state-bad"
        : "state-wait",
  );
}

/**
 * Attempts bitrate hint first, falls back to plain MediaRecorder ctor.
 * @param {number} bpsMp4
 * @param {number} bpsWebm
 */
export function createRecorder(mediaStream, mimeHint, bpsMp4, bpsWebm) {
  var withRate = {};
  if (mimeHint) withRate.mimeType = mimeHint;
  var m = (mimeHint || "").toLowerCase();
  withRate.videoBitsPerSecond = m.indexOf("mp4") !== -1 ? bpsMp4 : bpsWebm;

  try {
    return new MediaRecorder(mediaStream, withRate);
  } catch (e1) {
    try {
      return mimeHint
        ? new MediaRecorder(mediaStream, { mimeType: mimeHint })
        : new MediaRecorder(mediaStream);
    } catch (e2) {
      throw e2;
    }
  }
}

export const FaceScanHelpers = {
  byId,
  getDetectorOptions,
  pickMimeType,
  formatTime,
  friendlyCameraMessage,
  getCoverVisibleRegion,
  isFaceWellFramed,
  getFaceFramingGuidance,
  computeFaceScanEllipse,
  safeRecorderPause,
  safeRecorderResume,
  setPlacementUi,
  createRecorder,
  DEFAULT_FACE_MIN_MEAN_LUMINANCE,
  estimateFaceRegionMeanLuminance,
  isFaceRegionBrightEnough,
};
