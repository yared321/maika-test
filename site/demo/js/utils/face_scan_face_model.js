/**
 * Pluggable face-api.js detector config and loader.
 */

const DEFAULT_CDN =
  "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
const DEFAULT_LOCAL = "models";

const config = {
  kind: "tiny",
  weightsCdn: DEFAULT_CDN,
  weightsLocal: DEFAULT_LOCAL,
  tiny: { inputSize: 512, scoreThreshold: 0.35 },
  ssd: { minConfidence: 0.35 },
};

/**
 * Apply partial face model configuration to the active config.
 * Only fields that are explicitly provided in the partial object
 * will override the existing defaults.
 */
function applyFaceModelConfig(partial) {
  if (!partial || typeof partial !== "object") return;
  if (partial.kind != null) config.kind = String(partial.kind).toLowerCase();
  if (partial.weightsCdn != null) config.weightsCdn = partial.weightsCdn;
  if (partial.weightsLocal != null) config.weightsLocal = partial.weightsLocal;
  if (partial.tiny && typeof partial.tiny === "object") {
    if (partial.tiny.inputSize != null) config.tiny.inputSize = partial.tiny.inputSize;
    if (partial.tiny.scoreThreshold != null) {
      config.tiny.scoreThreshold = partial.tiny.scoreThreshold;
    }
  }
  if (partial.ssd && typeof partial.ssd === "object") {
    if (partial.ssd.minConfidence != null) {
      config.ssd.minConfidence = partial.ssd.minConfidence;
    }
  }
}

/**
 * Apply runtime face model configuration values.
 * Accepts a partial config and merges only the provided fields.
 */
export function setConfig(partial) {
  applyFaceModelConfig(partial);
}

/**
 * Return the current face model configuration.
 * This returns a copy of the active config values.
 */
export function getConfig() {
  return {
    kind: config.kind,
    weightsCdn: config.weightsCdn,
    weightsLocal: config.weightsLocal,
    tiny: {
      inputSize: config.tiny.inputSize,
      scoreThreshold: config.tiny.scoreThreshold,
    },
    ssd: { minConfidence: config.ssd.minConfidence },
  };
}

/**
 * Build and return face-api.js detector options based on config.
 * Returns null when detection is disabled or faceapi is unavailable.
 */
export function getDetectorOptions() {
  const k = String(config.kind || "tiny").toLowerCase();
  if (k === "none" || k === "off") return null;
  if (typeof globalThis.faceapi === "undefined") return null;
  if (k === "tiny") {
    return new globalThis.faceapi.TinyFaceDetectorOptions({
      inputSize: config.tiny.inputSize,
      scoreThreshold: config.tiny.scoreThreshold,
    });
  }
  if (k === "ssd") {
    return new globalThis.faceapi.SsdMobilenetv1Options({
      minConfidence: config.ssd.minConfidence,
    });
  }
  return null;
}

/**
 * Load the configured face-api.js model weights.
 * Falls back to local assets if CDN loading fails, and downgrades SSD to tiny if needed.
 */
export function load() {
  const k = String(config.kind || "tiny").toLowerCase();
  if (k === "none" || k === "off") {
    return Promise.resolve();
  }
  if (typeof globalThis.faceapi === "undefined") {
    return Promise.reject(new Error("faceapi_undefined"));
  }
  const cdn = config.weightsCdn || DEFAULT_CDN;
  const local = config.weightsLocal || DEFAULT_LOCAL;
  if (k === "tiny") {
    return globalThis.faceapi.nets.tinyFaceDetector.loadFromUri(cdn).catch(function () {
      return globalThis.faceapi.nets.tinyFaceDetector.loadFromUri(local);
    });
  }
  if (k === "ssd") {
    return globalThis.faceapi.nets.ssdMobilenetv1
      .loadFromUri(cdn)
      .catch(function () {
        return globalThis.faceapi.nets.ssdMobilenetv1.loadFromUri(local);
      })
      .catch(function () {
        // Robust fallback: if SSD weights are unavailable, fall back to TinyFaceDetector.
        config.kind = "tiny";
        return globalThis.faceapi.nets.tinyFaceDetector
          .loadFromUri(cdn)
          .catch(function () {
            return globalThis.faceapi.nets.tinyFaceDetector.loadFromUri(local);
          });
      });
  }
  return Promise.reject(new Error("face_scan_unknown_model_kind:" + k));
}

export const FaceScanFaceModel = {
  setConfig: setConfig,
  getConfig: getConfig,
  load: load,
  getDetectorOptions: getDetectorOptions,
};
  