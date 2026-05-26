/**
 * Camera preview, getUserMedia, alignment / record face-framing loops, scan FX, countdown.
 */
import * as H from "../utils/face_scan_helpers.js";

/**
 * @param {{ faceMinMeanLuminance?: number }} cfg
 * @returns {number}
 */
function resolveFaceMinMeanLuminance(cfg) {
  return typeof cfg.faceMinMeanLuminance === "number" &&
    Number.isFinite(cfg.faceMinMeanLuminance)
    ? cfg.faceMinMeanLuminance
    : H.DEFAULT_FACE_MIN_MEAN_LUMINANCE;
}

/**
 * Build normalized runtime state used by all camera controller helpers.
 * @param {{
 *   ctx: Record<string, unknown>,
 *   elements: Record<string, HTMLElement | null>,
 *   config: { alignIntervalMs: number, stableHitCount: number, faceMinFrac: number, faceMaxFrac: number, recordTargetMs: number, faceMinMeanLuminance?: number },
 *   bridges: { hideError?: function(): void, onCountdownDone?: function(): Promise<unknown> | unknown }
 * }} spec
 * @returns {{ ctx: Record<string, unknown>, el: Record<string, HTMLElement | null>, cfg: Record<string, unknown>, bridges: Record<string, unknown> }}
 */
function createCameraControllerState(spec) {
  return {
    ctx: spec.ctx,
    el: spec.elements,
    cfg: spec.config,
    bridges: spec.bridges || {},
  };
}

/**
 * Hides both the “waiting for camera” and “camera denied” full-screen overlays inside the video area.
 * Does not stop the stream or change phase.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function hideScanCameraStates(state) {
  if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
  if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.add("hidden");
}

/**
 * Shows the error overlay (and hides the loading overlay) with a human-readable reason.
 * @param {ReturnType<typeof createCameraControllerState>} state
 * @param {string} message
 */
function showCameraDeniedOverlay(state, message) {
  if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
  if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.remove("hidden");
  if (state.el.scanOverlayDeniedText) state.el.scanOverlayDeniedText.textContent = message;
}

/**
 * Clears the interval that runs `tickAlignment` during the pre-record align phase.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function stopAlignLoop(state) {
  if (state.ctx.alignTimer != null) {
    clearInterval(state.ctx.alignTimer);
    state.ctx.alignTimer = null;
  }
}

/**
 * Resets counters used only while recording.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function resetRecordingBudget(state) {
  state.ctx.recordBudgetAccumMs = 0;
  state.ctx.recordBudgetLastSample = null;
  state.ctx.recordingFaceInGuide = false;
  state.ctx.recordingFramingReady = false;
}

/**
 * Stops the record-framing interval and resets its budget state.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function stopRecordFramingLoop(state) {
  if (state.ctx.recordFramingTimer != null) {
    clearInterval(state.ctx.recordFramingTimer);
    state.ctx.recordFramingTimer = null;
  }
  resetRecordingBudget(state);
}

/**
 * Show a centered fallback face target when detector geometry is unavailable.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function showFallbackTarget(state) {
  if (!state.el.faceScanTarget) return;
  state.el.faceScanTarget.classList.remove("hidden");
  state.el.faceScanTarget.style.left = "50%";
  state.el.faceScanTarget.style.top = "50%";
  state.el.faceScanTarget.style.width = "34%";
  state.el.faceScanTarget.style.height = "42%";
}

/**
 * Apply directional guide classes and human-readable movement text.
 * @param {ReturnType<typeof createCameraControllerState>} state
 * @param {string | null | undefined} direction
 */
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
 * Updates the decorative face-scan FX overlay (visual-only, not encoded in output video).
 * @param {ReturnType<typeof createCameraControllerState>} state
 * @param {{ x?: number, y?: number, width: number, height: number }|null} [optBox]
 * @param {boolean} [alignOk]
 * @param {string | null} [guideDirection]
 */
function syncFaceScanFx(state, optBox, alignOk, guideDirection) {
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

/**
 * Get face-framing guidance or a default center instruction.
 * @param {ReturnType<typeof createCameraControllerState>} state
 * @param {any} box
 * @returns {{ direction: string, message: string }}
 */
function getGuideOrCenter(state, box) {
  if (!box) {
    return { direction: "center", message: "Move to the center." };
  }
  return (
    H.getFaceFramingGuidance(
      box,
      state.el.preview,
      state.cfg.faceMinFrac,
      state.cfg.faceMaxFrac,
    ) || { direction: "center", message: "Move to the center." }
  );
}

/**
 * Return guide message when available, otherwise fallback text.
 * @param {{ message?: string } | null | undefined} guide
 * @param {string} fallbackMessage
 * @returns {string}
 */
function resolveGuideMessage(guide, fallbackMessage) {
  return guide && guide.message ? guide.message : fallbackMessage;
}

/**
 * One tick of recording-mode framing checks and budget accumulation.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function tickCameraRecordFraming(state) {
  if (state.ctx.phase !== "record" || !state.el.preview || !state.el.preview.videoWidth) return;
  var opts = H.getDetectorOptions();
  if (!opts) {
    var recNoDet = state.ctx.recorder;
    if (!recNoDet) return;
    state.ctx.recordingFaceInGuide = true;
    state.ctx.recordingFramingReady = true;
    H.safeRecorderResume(recNoDet);
    H.setPlacementUi(
      state.el.placementStatus,
      "good",
      "Recording — face guide off.",
    );
    syncFaceScanFx(state, null);
    if (recNoDet.state !== "recording") {
      state.ctx.recordBudgetLastSample = null;
      return;
    }
    var now0 = performance.now();
    if (state.ctx.recordBudgetLastSample == null) {
      state.ctx.recordBudgetLastSample = now0;
      return;
    }
    var dt0 = now0 - state.ctx.recordBudgetLastSample;
    if (dt0 > 0 && dt0 < 800) state.ctx.recordBudgetAccumMs += dt0;
    state.ctx.recordBudgetLastSample = now0;
    if (state.ctx.recordBudgetAccumMs >= state.cfg.recordTargetMs) {
      try {
        recNoDet.stop();
      } catch (es0) {}
    }
    return;
  }

  if (state.ctx.detectionInFlight) return;
  state.ctx.detectionInFlight = true;

  globalThis.faceapi
    .detectSingleFace(state.el.preview, opts)
    .then(function (detection) {
      state.ctx.detectionInFlight = false;
      if (state.ctx.phase !== "record") return;
      var rec = state.ctx.recorder;
      if (!rec) return;
      var box = detection && detection.box ? detection.box : null;
      var ok = !!(
        box &&
        H.isFaceWellFramed(box, state.el.preview, state.cfg.faceMinFrac, state.cfg.faceMaxFrac)
      );

      if (!ok) {
        var guide = getGuideOrCenter(state, box);
        state.ctx.recordingFaceInGuide = false;
        H.safeRecorderPause(rec);
        state.ctx.recordBudgetLastSample = null;
        H.setPlacementUi(
          state.el.placementStatus,
          "bad",
          box
            ? resolveGuideMessage(
                guide,
                "Paused — move to the center.",
              )
            : "Paused — center your face in the frame.",
        );
        syncFaceScanFx(state, box, false, guide && guide.direction);
        return;
      }

      var minLRec = resolveFaceMinMeanLuminance(state.cfg);
      if (!H.isFaceRegionBrightEnough(state.el.preview, box, minLRec)) {
        state.ctx.recordingFaceInGuide = false;
        H.safeRecorderPause(rec);
        state.ctx.recordBudgetLastSample = null;
        H.setPlacementUi(
          state.el.placementStatus,
          "bad",
          "Paused — too dark. Add more light.",
        );
        syncFaceScanFx(state, box, false, null);
        return;
      }

      state.ctx.recordingFaceInGuide = true;
      state.ctx.recordingFramingReady = true;
      H.safeRecorderResume(rec);
      H.setPlacementUi(
        state.el.placementStatus,
        "good",
        "Recording...",
      );
      syncFaceScanFx(state, box);

      if (rec.state !== "recording") {
        state.ctx.recordBudgetLastSample = null;
        return;
      }

      var now = performance.now();
      if (state.ctx.recordBudgetLastSample == null) {
        state.ctx.recordBudgetLastSample = now;
        return;
      }
      var dt = now - state.ctx.recordBudgetLastSample;
      if (dt > 0 && dt < 800) state.ctx.recordBudgetAccumMs += dt;
      state.ctx.recordBudgetLastSample = now;

      if (state.ctx.recordBudgetAccumMs >= state.cfg.recordTargetMs) {
        try {
          rec.stop();
        } catch (es) {}
      } else {
        syncFaceScanFx(state, box);
      }
    })
    .catch(function () {
      state.ctx.detectionInFlight = false;
      syncFaceScanFx(state, null);
    });
}

/**
 * One tick of align-mode polling; advances to countdown after stable hits.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function tickAlignment(state) {
  if (state.ctx.phase !== "align") return;
  if (!state.el.preview) return;
  var optsAlign = H.getDetectorOptions();
  if (!optsAlign) {
    stopAlignLoop(state);
    state.ctx.phase = "countdown";
    syncFaceScanFx(state, null);
    H.setPlacementUi(state.el.placementStatus, "wait", "Starting…");
    runCountdownThenRecord(state);
    return;
  }
  var reg =
    state.el.preview.readyState >= 2 ? H.getCoverVisibleRegion(state.el.preview) : null;
  if (!reg || reg.vw < 160) return;

  globalThis.faceapi
    .detectSingleFace(state.el.preview, optsAlign)
    .then(function (detection) {
      if (state.ctx.phase !== "align") return;
      var box = detection && detection.box ? detection.box : null;
      var aligned = !!(
        box &&
        H.isFaceWellFramed(box, state.el.preview, state.cfg.faceMinFrac, state.cfg.faceMaxFrac)
      );

      if (aligned) {
        var minLAlign = resolveFaceMinMeanLuminance(state.cfg);
        if (!H.isFaceRegionBrightEnough(state.el.preview, box, minLAlign)) {
          state.ctx.placementStableHits = 0;
          H.setPlacementUi(
            state.el.placementStatus,
            "bad",
            "Too dark — add light on your face.",
          );
          syncFaceScanFx(state, box, false, null);
          return;
        }
        state.ctx.placementStableHits++;
        var msg =
          state.ctx.placementStableHits >= state.cfg.stableHitCount - 1
            ? "Almost there — hold still."
            : state.ctx.placementStableHits >= state.cfg.stableHitCount - 2
              ? "Looking good."
              : "Face aligned — hold still.";
        H.setPlacementUi(state.el.placementStatus, "good", msg);
        if (state.ctx.placementStableHits >= state.cfg.stableHitCount) {
          stopAlignLoop(state);
          state.ctx.phase = "countdown";
          syncFaceScanFx(state, null);
          H.setPlacementUi(state.el.placementStatus, "wait", "Starting…");
          runCountdownThenRecord(state);
        }
      } else {
        var guideAlign = getGuideOrCenter(state, box);
        state.ctx.placementStableHits = 0;
        H.setPlacementUi(
          state.el.placementStatus,
          "bad",
          detection && detection.box
            ? resolveGuideMessage(guideAlign, "Move to the center.")
            : "Center your face in the frame.",
        );
        syncFaceScanFx(state, box, false, guideAlign && guideAlign.direction);
        return;
      }
      syncFaceScanFx(state, box, aligned, null);
    })
    .catch(function () {
      syncFaceScanFx(state, null);
    });
}

/**
 * Start align polling from a clean state.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function startAlignLoop(state) {
  stopAlignLoop(state);
  state.ctx.placementStableHits = 0;
  state.ctx.phase = "align";
  state.ctx.alignTimer = globalThis.setInterval(
    function () {
      tickAlignment(state);
    },
    state.cfg.alignIntervalMs,
  );
  tickAlignment(state);
}

/**
 * Shows a 3-2-1 overlay, then resolves after the last tick.
 * @param {ReturnType<typeof createCameraControllerState>} state
 * @returns {Promise<void>}
 */
function runCountdownThenRecord(state) {
  return new Promise(function (resolve) {
    var n = 3;
    if (state.el.overlayCountdown) {
      state.el.overlayCountdown.hidden = false;
      state.el.overlayCountdown.classList.remove("hidden");
    }
    if (state.el.countdownNumber) state.el.countdownNumber.textContent = String(n);
    state.ctx.countdownTimer = globalThis.setInterval(function () {
      n--;
      if (n <= 0) {
        globalThis.clearInterval(state.ctx.countdownTimer);
        state.ctx.countdownTimer = 0;
        if (state.el.overlayCountdown) {
          state.el.overlayCountdown.hidden = true;
          state.el.overlayCountdown.classList.add("hidden");
        }
        document.dispatchEvent(
          new CustomEvent("maika-demo:face-scan-countdown-complete"),
        );
        var p = state.bridges.onCountdownDone && state.bridges.onCountdownDone();
        Promise.resolve(p).then(resolve);
        return;
      }
      if (state.el.countdownNumber) state.el.countdownNumber.textContent = String(n);
    }, 1000);
  });
}

/**
 * Clears the countdown interval and hides the countdown overlay.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function cancelCountdown(state) {
  if (state.ctx.countdownTimer) {
    globalThis.clearInterval(state.ctx.countdownTimer);
    state.ctx.countdownTimer = 0;
  }
  if (state.el.overlayCountdown) {
    state.el.overlayCountdown.hidden = true;
    state.el.overlayCountdown.classList.add("hidden");
  }
}

/**
 * Tear down camera state and associated intervals/stream.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function stopStream(state) {
  stopRecordFramingLoop(state);
  stopAlignLoop(state);
  state.ctx.detectionInFlight = false;
  if (state.ctx.stream) {
    state.ctx.stream.getTracks().forEach(function (t) {
      t.stop();
    });
    state.ctx.stream = null;
  }
  if (state.el.preview) state.el.preview.srcObject = null;
  state.ctx.placementStableHits = 0;
  if (state.el.placementStatus) H.setPlacementUi(state.el.placementStatus, "wait", "…");
  state.ctx.phase = "idle";
  syncFaceScanFx(state, null);
}

/**
 * Request camera, connect stream to preview, then start alignment loop.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function requestCameraAndStartAlignment(state) {
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

  state.ctx.phase = "align";
  navigator.mediaDevices
    .getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280, min: 640 },
        height: { ideal: 720, min: 480 },
        frameRate: { ideal: 24, max: 30 },
      },
      audio: false,
    })
    .then(function (mediaStream) {
      state.ctx.stream = mediaStream;
      if (state.el.preview) state.el.preview.srcObject = mediaStream;
      if (state.el.scanOverlayCamera) state.el.scanOverlayCamera.classList.add("hidden");
      if (state.el.scanOverlayDenied) state.el.scanOverlayDenied.classList.add("hidden");
      if (state.el.overlayCountdown) state.el.overlayCountdown.hidden = true;
      H.setPlacementUi(
        state.el.placementStatus,
        "wait",
        "Center your face in the frame.",
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
      if (state.bridges.onCameraReady) state.bridges.onCameraReady();
      startAlignLoop(state);
    })
    .catch(function (e) {
      showCameraDeniedOverlay(state, H.friendlyCameraMessage(e));
      state.ctx.phase = "idle";
    });
}

/**
 * Start record-framing loop from a clean budget.
 * @param {ReturnType<typeof createCameraControllerState>} state
 */
function startRecordFramingLoop(state) {
  stopRecordFramingLoop(state);
  state.ctx.recordFramingTimer = globalThis.setInterval(
    function () {
      tickCameraRecordFraming(state);
    },
    state.cfg.alignIntervalMs,
  );
  tickCameraRecordFraming(state);
}

/**
 * Create camera controller runtime API.
 * @param {{
 *   ctx: Record<string, unknown>,
 *   elements: Record<string, HTMLElement | null>,
 *   config: { alignIntervalMs: number, stableHitCount: number, faceMinFrac: number, faceMaxFrac: number, recordTargetMs: number, faceMinMeanLuminance?: number },
 *   bridges: { hideError?: function(): void, onCountdownDone?: function(): Promise<unknown> | unknown, onCameraReady?: function(): void }
 * }} spec
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
