/**
 * MediaPipe-only face model config and loader.
 */

import * as Dbg from "./debug.js";

const DEFAULT_MEDIAPIPE_JS_CDN =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const DEFAULT_MEDIAPIPE_DETECTOR_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const DEFAULT_MEDIAPIPE_LANDMARKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let mediapipeDetector = null;
let mediapipeLandmarker = null;
let faceMeshTesselation = null;
let cachedVision = null;
let cachedResolver = null;
let recordDetectorLoadPromise = null;

function normalizeMediaPipeModelType(v) {
  const t = String(v || "landmarker").toLowerCase();
  return t === "detector" ? "detector" : "landmarker";
}

const config = {
  provider: "mediapipe",
  enabled: true,
  deferRecordDetectorLoad: false,
  mediapipe: {
    modelType: "landmarker",
    jsCdn: DEFAULT_MEDIAPIPE_JS_CDN,
    wasmRoot: DEFAULT_MEDIAPIPE_JS_CDN + "/wasm",
    modelAssetPath: DEFAULT_MEDIAPIPE_LANDMARKER_MODEL_URL,
    delegate: "GPU",
    minDetectionConfidence: 0.35,
  },
};

function applyFaceModelConfig(partial) {
  if (!partial || typeof partial !== "object") return;
  if (partial.provider != null) config.provider = "mediapipe";
  if (partial.kind != null) {
    const k = String(partial.kind).toLowerCase();
    if (k === "none" || k === "off") config.enabled = false;
  }
  if (partial.enabled != null) config.enabled = partial.enabled !== false;
  if (partial.deferRecordDetectorLoad != null) {
    config.deferRecordDetectorLoad = !!partial.deferRecordDetectorLoad;
  }
  if (partial.mediapipe && typeof partial.mediapipe === "object") {
    if (partial.mediapipe.modelType != null) {
      config.mediapipe.modelType = normalizeMediaPipeModelType(
        partial.mediapipe.modelType,
      );
    }
    if (partial.mediapipe.jsCdn != null) config.mediapipe.jsCdn = partial.mediapipe.jsCdn;
    if (partial.mediapipe.wasmRoot != null) config.mediapipe.wasmRoot = partial.mediapipe.wasmRoot;
    if (partial.mediapipe.modelAssetPath != null) config.mediapipe.modelAssetPath = partial.mediapipe.modelAssetPath;
    if (partial.mediapipe.delegate != null) config.mediapipe.delegate = partial.mediapipe.delegate;
    if (partial.mediapipe.minDetectionConfidence != null) {
      config.mediapipe.minDetectionConfidence = partial.mediapipe.minDetectionConfidence;
    }
  }
}

export function setConfig(partial) {
  applyFaceModelConfig(partial);
}

export function getConfig() {
  return {
    provider: "mediapipe",
    enabled: config.enabled,
    mediapipe: {
      modelType: config.mediapipe.modelType,
      jsCdn: config.mediapipe.jsCdn,
      wasmRoot: config.mediapipe.wasmRoot,
      modelAssetPath: config.mediapipe.modelAssetPath,
      delegate: config.mediapipe.delegate,
      minDetectionConfidence: config.mediapipe.minDetectionConfidence,
    },
  };
}

export function getDetectorOptions() {
  if (!config.enabled) return null;
  return { provider: "mediapipe", modelType: config.mediapipe.modelType };
}

export function isDetectionEnabled() {
  return config.enabled;
}

/**
 * Returns the {start,end} index pairs for the 468-point face mesh wireframe,
 * available once the landmarker model has loaded. Null otherwise.
 */
export function getFaceMeshTesselation() {
  return faceMeshTesselation;
}

export function getProviderLabel() {
  return config.mediapipe.modelType === "landmarker"
    ? "MediaPipe Face Detector"
    : "MediaPipe Face Detector";
}

function mapMediaPipeBoxToFaceApiLike(box) {
  if (!box || typeof box !== "object") return null;
  const x = Number(box.originX);
  const y = Number(box.originY);
  const width = Number(box.width);
  const height = Number(box.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function resolveLandmarkerModelPath() {
  let modelAssetPath = config.mediapipe.modelAssetPath || DEFAULT_MEDIAPIPE_LANDMARKER_MODEL_URL;
  if (modelAssetPath === DEFAULT_MEDIAPIPE_DETECTOR_MODEL_URL) {
    modelAssetPath = DEFAULT_MEDIAPIPE_LANDMARKER_MODEL_URL;
  }
  return modelAssetPath;
}

function resolveDetectorModelPath() {
  const modelType = normalizeMediaPipeModelType(config.mediapipe.modelType);
  if (modelType === "landmarker") return DEFAULT_MEDIAPIPE_DETECTOR_MODEL_URL;
  let modelAssetPath = config.mediapipe.modelAssetPath || DEFAULT_MEDIAPIPE_DETECTOR_MODEL_URL;
  if (modelAssetPath === DEFAULT_MEDIAPIPE_LANDMARKER_MODEL_URL) {
    modelAssetPath = DEFAULT_MEDIAPIPE_DETECTOR_MODEL_URL;
  }
  return modelAssetPath;
}

function buildBaseOptions(modelAssetPath) {
  const baseOptions = { modelAssetPath: modelAssetPath };
  if (config.mediapipe.delegate) {
    baseOptions.delegate = config.mediapipe.delegate;
  }
  return baseOptions;
}

function detectWithLandmarker(source, ts) {
  if (!mediapipeLandmarker) return Promise.resolve(null);
  const res = mediapipeLandmarker.detectForVideo(source, ts);
  const faceLandmarks =
    res && Array.isArray(res.faceLandmarks) && res.faceLandmarks.length > 0
      ? res.faceLandmarks[0]
      : null;
  if (!faceLandmarks || !faceLandmarks.length) return Promise.resolve(null);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < faceLandmarks.length; i++) {
    const p = faceLandmarks[i];
    if (!p) continue;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return Promise.resolve(null);
  const vw = source && source.videoWidth ? source.videoWidth : 0;
  const vh = source && source.videoHeight ? source.videoHeight : 0;
  if (!vw || !vh) return Promise.resolve(null);
  const box = {
    x: Math.max(0, minX * vw),
    y: Math.max(0, minY * vh),
    width: Math.max(0, (maxX - minX) * vw),
    height: Math.max(0, (maxY - minY) * vh),
  };
  return Promise.resolve({ box: box, landmarks: faceLandmarks, faceCount: res.faceLandmarks.length });
}

function detectWithDetector(source, ts) {
  if (!mediapipeDetector) return Promise.resolve(null);
  const result = mediapipeDetector.detectForVideo(source, ts);
  const detections = result && Array.isArray(result.detections) ? result.detections : [];
  const first = detections.length > 0 ? detections[0] : null;
  const mpBox = first && first.boundingBox ? first.boundingBox : null;
  const box = mapMediaPipeBoxToFaceApiLike(mpBox);
  const faceCount = detections.length;
  if (box) return Promise.resolve({ box: box, faceCount: faceCount });
  // No primary box but multiple faces detected — still report count so check 1 can reject.
  if (faceCount > 1) return Promise.resolve({ faceCount: faceCount });
  return Promise.resolve(null);
}

/**
 * Unified single-face detection for active provider.
 * Returns an object containing normalized `box` and optional `landmarks`.
 * @param {HTMLVideoElement|HTMLCanvasElement} source
 * @param {{ mode?: "landmarker" | "detector" }} [options] Optional model override.
 */
export function detectSingleFace(source, options) {
  if (!isDetectionEnabled()) return Promise.resolve(null);
  const ts = performance.now();
  const mode =
    options && options.mode
      ? normalizeMediaPipeModelType(options.mode)
      : normalizeMediaPipeModelType(config.mediapipe.modelType);
  if (mode === "landmarker") return detectWithLandmarker(source, ts);
  return detectWithDetector(source, ts);
}

/** Lightweight box-only detection for the recording phase. */
export function detectSingleFaceForRecord(source) {
  if (!isDetectionEnabled()) return Promise.resolve(null);
  if (config.deferRecordDetectorLoad && !mediapipeDetector) {
    return ensureRecordDetectorLoaded().then(function () {
      return detectSingleFace(source, { mode: "detector" });
    });
  }
  return detectSingleFace(source, { mode: "detector" });
}

/** Phone-only: load BlazeFace after landmarker (during countdown / record start). */
export function ensureRecordDetectorLoaded() {
  if (!config.enabled || !config.deferRecordDetectorLoad) return Promise.resolve();
  if (mediapipeDetector) return Promise.resolve();
  if (recordDetectorLoadPromise) return recordDetectorLoadPromise;

  recordDetectorLoadPromise = (async function () {
    if (!cachedVision || !cachedResolver) {
      await loadMediaPipe();
      if (mediapipeDetector) return;
    }
    mediapipeDetector = await createMediaPipeDetector(
      cachedVision,
      cachedResolver,
      DEFAULT_MEDIAPIPE_DETECTOR_MODEL_URL,
    );
    Dbg.logFaceScanStep("detector: blaze_face loaded (deferred, phone record)", {
      detectorReady: !!mediapipeDetector,
    });
  })().catch(function (err) {
    recordDetectorLoadPromise = null;
    throw err;
  });

  return recordDetectorLoadPromise;
}

async function createMediaPipeLandmarker(vision, resolver, modelAssetPath) {
  if (!vision.FaceLandmarker) throw new Error("mediapipe_face_landmarker_unavailable");
  faceMeshTesselation = Array.isArray(vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION)
    ? vision.FaceLandmarker.FACE_LANDMARKS_TESSELATION
    : null;
  const landmarkerOptions = {
    baseOptions: buildBaseOptions(modelAssetPath),
    runningMode: "VIDEO",
    numFaces: 1,
  };
  try {
    return await vision.FaceLandmarker.createFromOptions(resolver, landmarkerOptions);
  } catch (_firstErr) {
    return vision.FaceLandmarker.createFromOptions(resolver, {
      baseOptions: { modelAssetPath: modelAssetPath },
      runningMode: "VIDEO",
      numFaces: 1,
    });
  }
}

async function createMediaPipeDetector(vision, resolver, modelAssetPath) {
  if (!vision.FaceDetector) throw new Error("mediapipe_face_detector_unavailable");
  const detectorOptions = {
    baseOptions: buildBaseOptions(modelAssetPath),
    runningMode: "VIDEO",
    minDetectionConfidence: Number(config.mediapipe.minDetectionConfidence) || 0.35,
  };
  try {
    return await vision.FaceDetector.createFromOptions(resolver, detectorOptions);
  } catch (_firstErr) {
    return vision.FaceDetector.createFromOptions(resolver, {
      baseOptions: { modelAssetPath: modelAssetPath },
      runningMode: "VIDEO",
      minDetectionConfidence: Number(config.mediapipe.minDetectionConfidence) || 0.35,
    });
  }
}

async function loadMediaPipe() {
  const vision = await import(config.mediapipe.jsCdn || DEFAULT_MEDIAPIPE_JS_CDN);
  if (!vision || !vision.FilesetResolver) {
    throw new Error("mediapipe_vision_import_failed");
  }
  const resolver = await vision.FilesetResolver.forVisionTasks(
    config.mediapipe.wasmRoot ||
      (config.mediapipe.jsCdn || DEFAULT_MEDIAPIPE_JS_CDN) + "/wasm",
  );
  cachedVision = vision;
  cachedResolver = resolver;
  const modelType = normalizeMediaPipeModelType(config.mediapipe.modelType);
  mediapipeDetector = null;
  mediapipeLandmarker = null;
  faceMeshTesselation = null;
  recordDetectorLoadPromise = null;

  if (modelType === "landmarker") {
    const landmarkerModelPath = resolveLandmarkerModelPath();
    mediapipeLandmarker = await createMediaPipeLandmarker(
      vision,
      resolver,
      landmarkerModelPath,
    );
    if (!config.deferRecordDetectorLoad) {
      mediapipeDetector = await createMediaPipeDetector(
        vision,
        resolver,
        DEFAULT_MEDIAPIPE_DETECTOR_MODEL_URL,
      );
    }
    return;
  }

  mediapipeDetector = await createMediaPipeDetector(
    vision,
    resolver,
    resolveDetectorModelPath(),
  );
}

/**
 * Load the configured detector provider models/runtime.
 */
export function load() {
  if (!isDetectionEnabled()) {
    mediapipeDetector = null;
    mediapipeLandmarker = null;
    return Promise.resolve();
  }
  return loadMediaPipe().then(function () {
    Dbg.logFaceScanStep("detector: mediapipe loaded", {
      modelType: config.mediapipe.modelType,
      modelAssetPath: config.mediapipe.modelAssetPath,
      landmarkerReady: !!mediapipeLandmarker,
      detectorReady: !!mediapipeDetector,
      deferRecordDetectorLoad: config.deferRecordDetectorLoad,
      recordUsesDetector:
        normalizeMediaPipeModelType(config.mediapipe.modelType) === "landmarker",
    });
  });
}

/**
 * Optional warmup pass.
 */
export function warmup() {
  if (!isDetectionEnabled()) return Promise.resolve();
  return Promise.resolve();
}

export const FaceScanFaceModel = {
  setConfig: setConfig,
  getConfig: getConfig,
  load: load,
  getDetectorOptions: getDetectorOptions,
  isDetectionEnabled: isDetectionEnabled,
  detectSingleFace: detectSingleFace,
  detectSingleFaceForRecord: detectSingleFaceForRecord,
  ensureRecordDetectorLoaded: ensureRecordDetectorLoaded,
  warmup: warmup,
  getProviderLabel: getProviderLabel,
  getFaceMeshTesselation: getFaceMeshTesselation,
};
