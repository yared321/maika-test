/**
 * MediaRecorder session: chunks, timer pill, start after countdown, stop → blob + upload bridge.
 */
import * as H from "../utils/face_scan_helpers.js";
import { FaceScanUpload } from "../service/service.js";

/**
 * Build a short human-readable recording summary for UI hints.
 * @param {Blob} blob
 * @param {number} w0
 * @param {number} h0
 * @returns {string}
 */
function buildRecordingBaseHint(blob, w0, h0) {
  var mb = (blob.size / 1024 / 1024).toFixed(1);
  return (
    (w0 ? "Resolution " + w0 + "×" + h0 + ". " : "") +
    "~" +
    mb +
    " MB" +
    (blob.type ? " · " + blob.type : "")
  );
}

/**
 * Reveal result panel and hide scan panel after recording completes.
 * @param {Record<string, HTMLElement|null>} el
 */
function showRecordingResultPanel(el) {
  if (el.panelScan) el.panelScan.classList.add("hidden");
  if (el.panelResult) el.panelResult.classList.remove("hidden");
}

/**
 * Start and return the recording pill interval handle.
 * @param {Record<string, unknown>} ctx
 * @param {Record<string, HTMLElement|null>} el
 * @param {{ recordTargetMs: number }} cfg
 * @returns {number}
 */
function startRecordingPillTicker(ctx, el, cfg) {
  if (el.recordingPill) el.recordingPill.classList.remove("hidden");
  return globalThis.setInterval(function () {
    if (!el.recordingTime) return;
    var label =
      H.formatTime(ctx.recordBudgetAccumMs) + " / " + H.formatTime(cfg.recordTargetMs);
    var pausedUi =
      ctx.recordingFramingReady && ctx.recorder && ctx.recorder.state === "paused";
    el.recordingTime.textContent = pausedUi ? label + " · paused" : label;
  }, 250);
}

/**
 * Handle deferred blob-only flow when upload is done by outer wizard.
 * @param {Blob} blob
 * @param {string} lastMime
 * @param {string} baseTxt
 * @param {Record<string, HTMLElement|null>} el
 * @param {Record<string, any>} bridges
 * @param {() => void} resolve
 */
function handleDeferredUploadFlow(blob, lastMime, baseTxt, el, bridges, resolve) {
  bridges.onRecordingBlobReady(blob, lastMime || blob.type || "", baseTxt);
  if (el.mimeHint) {
    el.mimeHint.textContent =
      baseTxt + ". Use Calculate Score in the demo wizard to submit to the API.";
  }
  showRecordingResultPanel(el);
  resolve();
}

/**
 * Handle immediate upload when deferred upload mode is disabled.
 * @param {Blob} blob
 * @param {string} lastMime
 * @param {string} baseTxt
 * @param {Record<string, HTMLElement|null>} el
 * @param {Record<string, any>} bridges
 * @param {() => void} resolve
 */
function handleImmediateUploadFlow(blob, lastMime, baseTxt, el, bridges, resolve) {
  var upload = FaceScanUpload;
  if (!upload || typeof upload.resolveEndpoint !== "function") {
    bridges.showError(
      "Upload module missing. Load service.js before app.js (see README).",
    );
    if (el.mimeHint) el.mimeHint.textContent = baseTxt + ".";
    showRecordingResultPanel(el);
    resolve();
    return;
  }

  var endpoint = upload.resolveEndpoint();
  if (!endpoint) {
    bridges.applyRecordingOutcomeHint(baseTxt, { ok: false, status: 0 }, false);
    showRecordingResultPanel(el);
    resolve();
    return;
  }

  upload
    .postRecording(blob, endpoint, {
      recordedMime: lastMime || blob.type || "",
    })
    .then(function (res) {
      bridges.applyRecordingOutcomeHint(baseTxt, res, true);
    })
    .then(function () {
      showRecordingResultPanel(el);
      resolve();
    });
}

/**
 * Produce `onstop` callback that finalizes recorder state and upload flow.
 * @param {Record<string, any>} state
 * @param {object|null} Camera
 * @param {() => void} resolve
 * @returns {() => void}
 */
function createRecorderStopHandler(state, Camera, resolve) {
  return function () {
    var Camera2 = Camera;
    var w0 = state.el.preview ? state.el.preview.videoWidth : 0;
    var h0 = state.el.preview ? state.el.preview.videoHeight : 0;
    state.ctx.phase = "idle";
    if (Camera2) {
      Camera2.syncFaceScanFx(null);
      Camera2.stopRecordFramingLoop();
    }
    if (state.el.recordingPill) state.el.recordingPill.classList.add("hidden");
    if (state.recordingTimer) {
      globalThis.clearInterval(state.recordingTimer);
    }
    state.recordingTimer = 0;
    state.ctx.recorder = null;
    if (Camera2) Camera2.stopStream();

    var blob = new Blob(state.chunks, { type: state.lastMime || "video/mp4" });
    if (state.discardCurrentRecording) {
      state.discardCurrentRecording = false;
      state.chunks.length = 0;
      state.bridges.resetUiToStart();
      resolve();
      return;
    }
    state.chunks.length = 0;
    state.bridges.hideError();

    var baseTxt = buildRecordingBaseHint(blob, w0, h0);
    var defer = state.bridges.deferAssessUpload === true;
    if (defer && typeof state.bridges.onRecordingBlobReady === "function") {
      handleDeferredUploadFlow(
        blob,
        state.lastMime,
        baseTxt,
        state.el,
        state.bridges,
        resolve,
      );
      return;
    }
    handleImmediateUploadFlow(
      blob,
      state.lastMime,
      baseTxt,
      state.el,
      state.bridges,
      resolve,
    );
  };
}

/**
 * Build mutable controller state shared by helper functions.
 * @param {{
 *   ctx: Record<string, unknown>,
 *   getCamera: function(): object | null | undefined,
 *   elements: {
 *     preview: HTMLVideoElement | null,
 *     placementStatus: HTMLElement | null,
 *     recordingPill: HTMLElement | null,
 *     recordingTime: HTMLElement | null,
 *     panelScan: HTMLElement | null,
 *     panelResult: HTMLElement | null,
 *     mimeHint: HTMLElement | null,
 *   },
 *   config: { recordTargetMs: number, recordVideoBpsMp4: number, recordVideoBpsWebm: number },
 *   bridges: {
 *     showError: function(string): void,
 *     hideError: function(): void,
 *     applyRecordingOutcomeHint: function(string, object, boolean): void,
 *     resetUiToStart: function(): void,
 *     deferAssessUpload?: boolean,
 *     onRecordingBlobReady?: function(Blob, string, string): void,
 *   },
 * }} spec
 * @returns {Record<string, any>}
 */
function createRecordingControllerState(spec) {
  return {
    ctx: spec.ctx,
    getCamera: spec.getCamera,
    el: spec.elements,
    cfg: spec.config,
    bridges: spec.bridges || {},
    chunks: [],
    lastMime: "",
    recordingTimer: 0,
    discardCurrentRecording: false,
  };
}

/**
 * Resolve the current camera controller from state getter.
 * @param {Record<string, any>} state
 * @returns {object|null|undefined}
 */
function getCameraFromState(state) {
  return state.getCamera && state.getCamera();
}

/**
 * Clear recording pill timer and hide pill.
 * @param {Record<string, any>} state
 */
function teardownRecordingPillState(state) {
  if (state.recordingTimer) {
    globalThis.clearInterval(state.recordingTimer);
    state.recordingTimer = 0;
  }
  if (state.el.recordingPill) state.el.recordingPill.classList.add("hidden");
}

/**
 * Abort the active recording and mark it for discard.
 * @param {Record<string, any>} state
 */
function abortRecordingDiscardState(state) {
  var Camera = getCameraFromState(state);
  state.discardCurrentRecording = true;
  if (Camera) Camera.stopRecordFramingLoop();
  teardownRecordingPillState(state);
  if (state.ctx.recorder && state.ctx.recorder.state === "recording") {
    try {
      state.ctx.recorder.stop();
    } catch (e) {}
  }
  state.ctx.recorder = null;
  state.ctx.phase = "idle";
  if (Camera) Camera.syncFaceScanFx(null);
}

/**
 * Start MediaRecorder and wire data/stop handlers for one recording run.
 * @param {Record<string, any>} state
 * @returns {Promise<void>}
 */
function beginRecordingState(state) {
  return new Promise(function (resolve) {
    var Camera = getCameraFromState(state);
    if (!Camera) {
      resolve();
      return;
    }

    Camera.stopRecordFramingLoop();

    if (!state.ctx.stream) {
      state.bridges.showError("No camera stream.");
      state.bridges.resetUiToStart();
      resolve();
      return;
    }

    state.ctx.phase = "record";
    if (state.el.placementStatus) {
      H.setPlacementUi(
        state.el.placementStatus,
        "wait",
        "Recording — full camera view.",
      );
    }

    state.chunks.length = 0;
    state.lastMime = H.pickMimeType();

    try {
      state.ctx.recorder = H.createRecorder(
        state.ctx.stream,
        state.lastMime || undefined,
        state.cfg.recordVideoBpsMp4,
        state.cfg.recordVideoBpsWebm,
      );
    } catch (e) {
      state.bridges.showError(
        e && e.message ? e.message : "Could not start recorder.",
      );
      Camera.stopStream();
      state.bridges.resetUiToStart();
      resolve();
      return;
    }

    if (!state.lastMime && state.ctx.recorder.mimeType) {
      state.lastMime = state.ctx.recorder.mimeType;
    }

    Camera.startRecordFramingLoop();

    state.ctx.recorder.ondataavailable = function (e) {
      if (e.data && e.data.size) state.chunks.push(e.data);
    };

    state.ctx.recorder.onstop = createRecorderStopHandler(state, Camera, resolve);

    state.recordingTimer = startRecordingPillTicker(
      state.ctx,
      state.el,
      state.cfg,
    );
    state.ctx.recorder.start(200);
    Camera.syncFaceScanFx(null);
  });
}

/**
 * Build the controller API that coordinates MediaRecorder lifecycle.
 * @param {object} spec
 */
export function createRecordingController(spec) {
  var state = createRecordingControllerState(spec);
  return {
    beginRecording: function () {
      return beginRecordingState(state);
    },
    abortRecordingDiscard: function () {
      abortRecordingDiscardState(state);
    },
    teardownRecordingPill: function () {
      teardownRecordingPillState(state);
    },
  };
}

export const FaceScanRecordingController = {
  create: createRecordingController,
};
  