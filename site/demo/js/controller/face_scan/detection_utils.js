/**
 * Normalizes raw face-detector payloads (box/landmarks) into a shape the
 * alignment and record loops can consume uniformly. Pure functions, no state.
 */

/**
 * Normalizes provider-specific landmark payloads into an array of points.
 * Returns null when the active detector output does not include landmarks.
 */
export function extractLandmarksFromDetection(detection) {
  if (!detection || typeof detection !== "object") return null;
  if (Array.isArray(detection.landmarks)) return detection.landmarks;
  if (
    detection.landmarks &&
    typeof detection.landmarks === "object" &&
    Array.isArray(detection.landmarks.positions)
  ) {
    return detection.landmarks.positions;
  }
  if (Array.isArray(detection.faceLandmarks)) return detection.faceLandmarks;
  return null;
}

/** Returns the number of faces detected in the payload (0 when unknown). */
export function extractFaceCountFromDetection(detection) {
  if (!detection || typeof detection !== "object") return 0;
  if (typeof detection.faceCount === "number") return detection.faceCount;
  return detection.box ? 1 : 0;
}

/**
 * Normalizes detection box payloads to { x, y, width, height }.
 * Supports standard detector payloads and numeric safety checks.
 */
export function extractBoxFromDetection(detection) {
  if (!detection || typeof detection !== "object") return null;
  var box = detection.box || null;
  if (!box || typeof box !== "object") return null;
  var x = Number(box.x);
  var y = Number(box.y);
  var width = Number(box.width);
  var height = Number(box.height);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: x, y: y, width: width, height: height };
}
