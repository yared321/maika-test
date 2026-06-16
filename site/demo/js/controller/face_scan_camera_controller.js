/**
 * Camera controller composition root.
 *
 * This file builds the shared per-instance `state` object and wires together
 * the camera-related concerns implemented in sibling modules, exposing the
 * single public factory consumed by face_scan_flow_controller.js. It owns no
 * stream/loop/overlay logic itself — that all lives in:
 *
 *   face_scan_camera_stream.js    - getUserMedia lifecycle (start/stop stream,
 *                                   re-entrancy guard, disconnect handling)
 *   face_scan_align_loop.js       - alignment polling loop + 3-2-1 countdown
 *   face_scan_record_loop.js      - record-framing polling loop + recording
 *                                   budget/pause/abort logic
 *   face_scan_camera_fx.js        - overlay FX (clip/target guide) + the
 *                                   face-mesh wireframe sync, camera
 *                                   loading/denied overlay toggles
 *   face_scan_detection_utils.js  - shared detection-payload normalization
 *
 * Each module takes the same shared `state` shape this file constructs:
 * `{ ctx, el, cfg, bridges, faceMesh }`. If you need to change camera
 * behavior, find the concern above first — this file should stay a thin
 * composition layer.
 */
import { createFaceMeshRenderer } from "./face_scan_mesh_renderer.js";
import {
  requestCameraAndStartAlignment,
  stopStream,
} from "./face_scan_camera_stream.js";
import {
  startAlignLoop,
  stopAlignLoop,
  runCountdownThenRecord,
  cancelCountdown,
} from "./face_scan_align_loop.js";
import {
  startRecordFramingLoop,
  stopRecordFramingLoop,
} from "./face_scan_record_loop.js";
import {
  syncFaceScanFx,
  hideScanCameraStates,
  showCameraDeniedOverlay,
} from "./face_scan_camera_fx.js";

/**
 * Normalizes controller runtime state and guarantees quality-trace fields exist.
 * Returns the shared state object used by all camera-controller helpers.
 */
function createCameraControllerState(spec) {
  if (!spec.ctx.quality || typeof spec.ctx.quality !== "object") {
    spec.ctx.quality = {};
  }
  if (!Array.isArray(spec.ctx.quality.brightnessHistory)) {
    spec.ctx.quality.brightnessHistory = [];
  }
  if (!Array.isArray(spec.ctx.quality.greenHistory)) {
    spec.ctx.quality.greenHistory = [];
  }
  if (!Array.isArray(spec.ctx.quality.frameDtHistory)) {
    spec.ctx.quality.frameDtHistory = [];
  }
  if (!Array.isArray(spec.ctx.quality.motionHistory)) {
    spec.ctx.quality.motionHistory = [];
  }
  spec.ctx.quality.lastCenter = null;
  spec.ctx.quality.lastSampleAt = null;
  return {
    ctx: spec.ctx,
    el: spec.elements,
    cfg: spec.config,
    bridges: spec.bridges || {},
    faceMesh:
      spec.elements.faceMeshCanvas && spec.elements.preview
        ? createFaceMeshRenderer(spec.elements.faceMeshCanvas, spec.elements.preview)
        : null,
  };
}

/**
 * Builds the camera controller public API.
 *
 * This factory provides:
 * - Lifecycle controls (`requestCameraAndStartAlignment`, `stopStream`).
 * - Phase loop controls (`start/stopAlignLoop`, `start/stopRecordFramingLoop`).
 * - Overlay/FX helpers (`hideScanCameraStates`, `showCameraDeniedOverlay`, `syncFaceScanFx`).
 * - Countdown controls (`runCountdownThenRecord`, `cancelCountdown`).
 *
 * The returned object is the public integration surface consumed by
 * `face_scan_flow_controller.js`. Its method names/signatures are a stable
 * contract — `face_scan_recording_controller.js` calls several of these
 * directly on the instance it's handed, so don't rename/remove without
 * updating both call sites.
 */
export function createCameraController(spec) {
  var state = createCameraControllerState(spec);
  return {
    hideScanCameraStates: function hide() {
      hideScanCameraStates(state);
    },
    showCameraDeniedOverlay: function showDenied(message) {
      showCameraDeniedOverlay(state, message);
    },
    requestCameraAndStartAlignment: function requestAndAlign() {
      requestCameraAndStartAlignment(state);
    },
    stopStream: function stop() {
      stopStream(state);
    },
    stopAlignLoop: function stopAlign() {
      stopAlignLoop(state);
    },
    startAlignLoop: function startAlign() {
      startAlignLoop(state);
    },
    stopRecordFramingLoop: function stopRecordLoop() {
      stopRecordFramingLoop(state);
    },
    startRecordFramingLoop: function startRecordLoop() {
      startRecordFramingLoop(state);
    },
    syncFaceScanFx: function syncFx(optBox, alignOk, guideDirection) {
      syncFaceScanFx(state, optBox, alignOk, guideDirection);
    },
    runCountdownThenRecord: function runCountdown() {
      return runCountdownThenRecord(state);
    },
    cancelCountdown: function cancel() {
      cancelCountdown(state);
    },
  };
}

export const FaceScanCameraController = {
  create: createCameraController,
};
