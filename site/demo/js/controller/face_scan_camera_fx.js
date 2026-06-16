/**
 * Overlay rendering for the face-scan camera: the clip/target FX layer and
 * the face-mesh wireframe, plus the camera-loading/denied overlay toggles.
 * Pure UI sync from detection state — never touches the stream or recorder.
 */
import * as H from "../utils/face_scan_helpers.js";

/** Hides camera-loading and camera-error overlays without changing stream state. */
export function hideScanCameraStates(state) {
  if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
  if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.add("hidden");
}

/** Shows the camera-denied overlay with a readable failure reason. */
export function showCameraDeniedOverlay(state, message) {
  if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
  if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.remove("hidden");
  if (state.el.scanOverlayDeniedText) state.el.scanOverlayDeniedText.textContent = message;
}

/** Hides/clears the face-mesh wireframe overlay. */
export function clearFaceMesh(state) {
  if (state.el.faceMeshCanvas) state.el.faceMeshCanvas.classList.add("hidden");
  if (state.faceMesh) state.faceMesh.clear();
}

/** Draws the face-mesh wireframe overlay for the current detection frame. */
export function syncFaceMesh(state, landmarks, ok) {
  if (!state.faceMesh) return;
  if (!landmarks || !landmarks.length) {
    clearFaceMesh(state);
    return;
  }
  if (state.el.faceMeshCanvas) state.el.faceMeshCanvas.classList.remove("hidden");
  state.faceMesh.draw(landmarks, ok);
}

/** Shows a centered fallback target when ellipse geometry cannot be computed. */
function showFallbackTarget(state) {
  if (!state.el.faceScanTarget) return;
  state.el.faceScanTarget.classList.remove("hidden");
  state.el.faceScanTarget.style.left = "50%";
  state.el.faceScanTarget.style.top = "50%";
  state.el.faceScanTarget.style.width = "34%";
  state.el.faceScanTarget.style.height = "42%";
}

/** Applies directional target classes and updates movement hint text. */
function syncTargetGuide(state, direction) {
  if (!state.el.faceScanTarget) return;
  state.el.faceScanTarget.classList.remove(
    "guide-left",
    "guide-right",
    "guide-up",
    "guide-down",
  );
  if (direction === "left") state.el.faceScanTarget.classList.add("guide-left");
  else if (direction === "right") state.el.faceScanTarget.classList.add("guide-right");
  else if (direction === "up") state.el.faceScanTarget.classList.add("guide-up");
  else if (direction === "down") state.el.faceScanTarget.classList.add("guide-down");

  var guideEl = state.el.faceScanTarget.querySelector(".face-scan-target-guide");
  if (!guideEl) return;
  var labels = {
    left: "Move left",
    right: "Move right",
    up: "Move up",
    down: "Move down",
    near: "Move closer",
    far: "Move back",
    center: "Move to center",
  };
  var txt = labels[direction] || "";
  guideEl.textContent = txt;
  guideEl.classList.toggle("hidden", !txt);
}

/**
 * Updates visual face-scan overlays (clip, target, paused state) from detection state.
 * This affects UI only and does not change recorded video pixels.
 */
export function syncFaceScanFx(state, optBox, alignOk, guideDirection) {
  if (!state.el.faceScanFx || !state.el.preview) return;
  var box = optBox && typeof optBox.width === "number" ? optBox : null;
  var show = state.ctx.phase === "record" || (state.ctx.phase === "align" && !!box);
  state.el.faceScanFx.classList.toggle("hidden", !show);

  if (state.el.faceScanClipEl && box && state.el.preview.readyState >= 2) {
    var ell = H.computeFaceScanEllipse(box, state.el.preview);
    if (ell) {
      var topFactor = 1.0;
      var bottomFactor = 0.93;
      var left = Math.max(0.8, ell.cxPct - ell.rxPct);
      var top = Math.max(0.8, ell.cyPct - ell.ryPct * topFactor);
      var right = Math.min(99.2, ell.cxPct + ell.rxPct);
      var bottom = Math.min(99.2, ell.cyPct + ell.ryPct * bottomFactor);
      var insetTop = top;
      var insetRight = 100 - right;
      var insetBottom = 100 - bottom;
      var insetLeft = left;
      var roundPct = Math.max(
        2.2,
        Math.min(10, Math.min((right - left) * 0.18, (bottom - top) * 0.18)),
      );
      state.el.faceScanClipEl.style.clipPath =
        "inset(" +
        insetTop.toFixed(2) +
        "% " +
        insetRight.toFixed(2) +
        "% " +
        insetBottom.toFixed(2) +
        "% " +
        insetLeft.toFixed(2) +
        "% round " +
        roundPct.toFixed(2) +
        "%)";
      if (state.el.faceScanTarget) {
        state.el.faceScanTarget.classList.remove("hidden");
        state.el.faceScanTarget.style.left = ell.cxPct.toFixed(2) + "%";
        var targetCenterY =
          ell.cyPct - (ell.ryPct * (topFactor - bottomFactor)) / 2;
        state.el.faceScanTarget.style.top = targetCenterY.toFixed(2) + "%";
        state.el.faceScanTarget.style.width = (ell.rxPct * 2).toFixed(2) + "%";
        state.el.faceScanTarget.style.height =
          (ell.ryPct * (topFactor + bottomFactor)).toFixed(2) + "%";
        syncTargetGuide(state, guideDirection);
      }
    } else {
      state.el.faceScanClipEl.style.clipPath = "inset(0)";
      if (state.el.faceScanTarget) {
        if (guideDirection) {
          showFallbackTarget(state);
          syncTargetGuide(state, guideDirection);
        } else {
          state.el.faceScanTarget.classList.add("hidden");
          syncTargetGuide(state, null);
        }
      }
    }
  } else if (state.el.faceScanClipEl) {
    state.el.faceScanClipEl.style.clipPath = "inset(0)";
    if (state.el.faceScanTarget) {
      if (guideDirection) {
        showFallbackTarget(state);
        syncTargetGuide(state, guideDirection);
      } else {
        state.el.faceScanTarget.classList.add("hidden");
        syncTargetGuide(state, null);
      }
    }
  }

  var recordPausedSoft =
    state.ctx.phase === "record" &&
    (!state.ctx.recordingFaceInGuide || !state.ctx.recordingFramingReady);
  var alignLoose = state.ctx.phase === "align" && !!box && alignOk === false;
  state.el.faceScanFx.classList.toggle(
    "face-scan-fx--paused",
    recordPausedSoft || alignLoose,
  );
}
