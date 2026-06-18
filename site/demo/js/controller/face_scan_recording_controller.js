/**
 * MediaRecorder session: chunks, timer pill, start after countdown, stop → blob + upload bridge.
 */
import * as H from "../utils/face_scan_helpers.js";
import * as Dbg from "../utils/face_scan_debug.js";
import {
  finalizeArtifactTimeline,
  getEffectiveRecordTargetMs,
} from "./face_scan_artifact_policy.js";
import { FaceScanUpload } from "../service/service.js";
import {
  resetFpsRecordingSamples,
  finalizeFpsRecordingMetadata,
} from "./face_scan_fps_monitor.js";
import {
  initRecordCollector,
  finalizeRecordCollector,
} from "./face_scan_record_collector.js";

/** Extracts the codec list from a MediaRecorder MIME type string, if present. */
function parseCodecFromMimeType(mimeType) {
  if (!mimeType) return null;
  var match = /codecs=([^;]+)/i.exec(mimeType);
  return match ? match[1].replace(/"/g, "").trim() : null;
}

/**
 * Debug-only: POST camera-init metadata to the local dev server, which writes
 * `site/demo/data/meta_data/face-scan-camera-metadata-<timestamp>.json`.
 * Gated behind the same flag as console logging (maika-face-scan-debug /
 * ?faceScanDebug=1) — never runs for real users. Requires `npm run dev`
 * (maika-dev-proxy); on static hosts the request is a no-op after a silent
 * failure. Fires once per recording attempt, regardless of outcome.
 */
function saveCameraMetadataDebugJson(ctx) {
  if (!Dbg.isFaceScanDebugEnabled()) return;
  if (!ctx.cameraMetadata) return;
  var payload = ctx.cameraMetadata;
  fetch("/api/face-scan-debug-metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(function (res) {
      if (!res.ok) return null;
      return res.json();
    })
    .then(function (data) {
      if (data && data.ok) {
        Dbg.logFaceScanStep("camera metadata saved", {
          path: data.path,
          metadata: payload,
        });
      }
    })
    .catch(function () {});
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
    var targetMs = getEffectiveRecordTargetMs(ctx, cfg);
    var label =
      H.formatTime(ctx.recordBudgetAccumMs) + " / " + H.formatTime(targetMs);
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
 * Derives an A/B/C/D acquisition grade from finalized metadata.
 * A = excellent (≥90% quality ticks, ≥25 fps)
 * B = acceptable (≥75% quality ticks, ≥15 fps)
 * C = low quality (≥50% quality ticks)
 * D = poor (below all thresholds or no data)
 * The grade is metadata-only and never shown to the user.
 */
function computeQualityGrade(meta) {
  if (!meta) return "D";
  var okFrac = typeof meta.face_ok_fraction === "number" ? meta.face_ok_fraction : null;
  var fps = typeof meta.delivered_fps_overall === "number" ? meta.delivered_fps_overall : null;
  if (okFrac === null) return "D";
  if (okFrac >= 0.90 && fps !== null && fps >= 25) return "A";
  if (okFrac >= 0.75 && fps !== null && fps >= 15) return "B";
  if (okFrac >= 0.50) return "C";
  return "D";
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
    var nowMs = performance.now();
    var recordingDurationMs = null;
    var recordStartedAt = state.ctx.recordWallClockStartedAt;
    if (Number.isFinite(recordStartedAt) && recordStartedAt > 0) {
      recordingDurationMs = nowMs - recordStartedAt;
    }
    var activeRecordingMs = state.ctx.recordBudgetAccumMs || 0;
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

    var qualityTimeline = finalizeArtifactTimeline(state.ctx, nowMs);
    state.ctx.qualityTimeline = qualityTimeline;
    finalizeFpsRecordingMetadata(state.ctx, recordingDurationMs);
    finalizeRecordCollector(state.ctx, nowMs);
    if (state.ctx.cameraMetadata) {
      state.ctx.cameraMetadata.active_recording_duration_ms =
        activeRecordingMs > 0 ? Math.round(activeRecordingMs) : null;
      state.ctx.cameraMetadata.quality_grade = computeQualityGrade(state.ctx.cameraMetadata);
    }
    saveCameraMetadataDebugJson(state.ctx);

    var discardRun =
      state.discardCurrentRecording || !!state.ctx.discardCurrentRecording;
    if (discardRun) {
      state.discardCurrentRecording = false;
      state.ctx.discardCurrentRecording = false;
      state.chunks.length = 0;
      var autoRestart = !!state.ctx.autoRestartCameraAfterAbort;
      var restartMessage = state.ctx.qualityRestartMessage || "";
      state.ctx.autoRestartCameraAfterAbort = false;
      state.ctx.qualityRestartMessage = "";
      if (autoRestart && typeof state.bridges.onQualityRestart === "function") {
        state.bridges.onQualityRestart(restartMessage, qualityTimeline);
      } else {
        state.bridges.resetUiToStart();
      }
      resolve();
      return;
    }

    var blob = new Blob(state.chunks, { type: state.lastMime || "video/mp4" });
    state.chunks.length = 0;
    state.bridges.hideError();

    var baseTxt = "";
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
        "Recording — full view.",
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
    if (state.ctx.cameraMetadata) {
      state.ctx.cameraMetadata.mime_type = state.lastMime || null;
      state.ctx.cameraMetadata.codec = parseCodecFromMimeType(state.lastMime);
      var mimeLower = (state.lastMime || "").toLowerCase();
      state.ctx.cameraMetadata.record_video_bps =
        mimeLower.indexOf("mp4") !== -1
          ? state.cfg.recordVideoBpsMp4
          : state.cfg.recordVideoBpsWebm;
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
    state.ctx.recordWallClockStartedAt = performance.now();
    resetFpsRecordingSamples(state.ctx);
    initRecordCollector(state.ctx);
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
  