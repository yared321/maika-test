/**
 * getUserMedia stream lifecycle: requesting/attaching the camera stream and
 * tearing it down. Owns the stream re-entrancy guard (cameraRequestInFlight),
 * the generation counter that discards stale getUserMedia resolutions, and
 * the track.onended disconnect handler.
 */
import * as H from "../utils/face_scan_helpers.js";
import { startAlignLoop, stopAlignLoop } from "./face_scan_align_loop.js";
import { stopRecordFramingLoop } from "./face_scan_record_loop.js";
import { syncFaceScanFx, clearFaceMesh, showCameraDeniedOverlay } from "./face_scan_camera_fx.js";

/**
 * Requested camera constraints per the client's frontend quality-control spec.
 * No `min` on width/height/frameRate: a hard `min` can throw OverconstrainedError
 * on devices/browsers that can't meet it, where graceful degradation is what we
 * want instead. `max: 30` on frameRate is safe to keep (a `max` can never fail
 * this way — it only prevents picking an unnecessarily high rate that would
 * bloat file size/processing for no analysis benefit).
 */
var REQUESTED_VIDEO_CONSTRAINTS = {
  facingMode: "user",
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 30, max: 30 },
};

/** Stops loops, closes media tracks, and resets camera runtime to idle. */
export function stopStream(state) {
  state.ctx.streamRequestGen = (state.ctx.streamRequestGen || 0) + 1;
  stopRecordFramingLoop(state);
  stopAlignLoop(state);
  state.ctx.detectionInFlight = false;
  if (state.el.preview) state.el.preview.onloadeddata = null;
  if (state.ctx.stream) {
    state.ctx.stream.getTracks().forEach(function (t) {
      t.onended = null;
      t.stop();
    });
    state.ctx.stream = null;
  }
  if (state.el.preview) state.el.preview.srcObject = null;
  state.ctx.placementStableHits = 0;
  if (state.el.placementStatus) H.setPlacementUi(state.el.placementStatus, "wait", "…");
  state.ctx.phase = "idle";
  syncFaceScanFx(state, null);
  clearFaceMesh(state);
}

/**
 * Starts camera capture and enters alignment flow.
 *
 * This function:
 * - Validates browser media support.
 * - Shows camera-loading overlay and requests front camera via getUserMedia.
 * - Attaches MediaStream to preview video when permission is granted.
 * - Hides loading/denied overlays, initializes placement UI, and waits for first
 *   frame (`onloadeddata`) so detector logic starts on a ready preview.
 * - Triggers integration callback (`onCameraReady`) and starts align loop.
 * - On failure, shows a human-readable denied/error overlay and returns to idle.
 *
 * This is the single entry point for camera startup in the scan flow.
 */
export function requestCameraAndStartAlignment(state) {
  if (state.ctx.cameraRequestInFlight) return;
  if (state.bridges.hideError) state.bridges.hideError();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraDeniedOverlay(state, "Camera needs HTTPS or localhost.");
    return;
  }

  if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.remove("hidden");
  if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.add("hidden");
  if (state.el.scanOverlayCameraText) {
    state.el.scanOverlayCameraText.textContent = "Requesting camera access…";
  }

  state.ctx.cameraRequestInFlight = true;
  var myGen = (state.ctx.streamRequestGen = (state.ctx.streamRequestGen || 0) + 1);
  state.ctx.phase = "align";
  state.ctx.cameraMetadata = {
    requested_width: REQUESTED_VIDEO_CONSTRAINTS.width.ideal,
    requested_height: REQUESTED_VIDEO_CONSTRAINTS.height.ideal,
    requested_fps: REQUESTED_VIDEO_CONSTRAINTS.frameRate.ideal,
    actual_width: null,
    actual_height: null,
    reported_fps: null,
    facing_mode: null,
    codec: null,
    mime_type: null,
  };
  navigator.mediaDevices
    .getUserMedia({
      video: REQUESTED_VIDEO_CONSTRAINTS,
      audio: false,
    })
    .then(function (mediaStream) {
      if (state.ctx.streamRequestGen !== myGen) {
        // A stopStream()/newer request happened while permission was pending; discard.
        mediaStream.getTracks().forEach(function (t) {
          t.stop();
        });
        return Promise.reject(new Error("face_scan_stale_stream_request"));
      }
      state.ctx.stream = mediaStream;
      var videoTracks = mediaStream.getVideoTracks();
      videoTracks.forEach(function (t) {
        t.onended = function () {
          if (state.ctx.streamRequestGen !== myGen) return;
          showCameraDeniedOverlay(state, "Camera disconnected. Please reconnect and retry.");
          stopStream(state);
        };
      });
      var track0 = videoTracks[0];
      if (track0 && typeof track0.getSettings === "function") {
        var settings = track0.getSettings();
        state.ctx.cameraMetadata.actual_width = settings.width != null ? settings.width : null;
        state.ctx.cameraMetadata.actual_height = settings.height != null ? settings.height : null;
        state.ctx.cameraMetadata.reported_fps = settings.frameRate != null ? settings.frameRate : null;
        state.ctx.cameraMetadata.facing_mode = settings.facingMode || null;
      }
      if (state.el.preview) state.el.preview.srcObject = mediaStream;
      if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
      if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.add("hidden");
      if (state.el.overlayCountdown) state.el.overlayCountdown.hidden = true;
      H.setPlacementUi(
        state.el.placementStatus,
        "wait",
        "Position your face in the frame.",
      );
      return new Promise(function (resolve) {
        if (!state.el.preview) {
          resolve();
          return;
        }
        state.el.preview.onloadeddata = function () {
          state.el.preview.onloadeddata = null;
          resolve();
        };
      });
    })
    .then(function () {
      state.ctx.cameraRequestInFlight = false;
      if (state.ctx.streamRequestGen !== myGen) return;
      if (state.bridges.onCameraReady) state.bridges.onCameraReady();
      startAlignLoop(state);
    })
    .catch(function (e) {
      state.ctx.cameraRequestInFlight = false;
      if (state.ctx.streamRequestGen !== myGen) return;
      showCameraDeniedOverlay(state, H.friendlyCameraMessage(e));
      state.ctx.phase = "idle";
    });
}
