/**
 * Face scan runtime flow:
 * start camera -> align -> countdown -> record -> emit blob-ready event.
 */
import * as H from "../../utils/face_scan/helpers.js";
import * as Dbg from "../../utils/face_scan/debug.js";
import { FaceScanFaceModel } from "../../utils/face_scan/face_model.js";
import { FaceScanCameraController } from "./camera_controller.js";
import { FaceScanRecordingController } from "./recording_controller.js";
import { FaceScanUpload } from "../../service/service.js";
import { stopMusicPlayback } from "../music_stream_controller.js";

/** Fade out background music when face recording finishes (blob ready), not when starting the camera. */
var MUSIC_FADE_MS_AFTER_RECORDING_COMPLETE = 5000;
/** Camera warmup duration (client spec: "2-3 seconds") before alignment gating starts. */
var WARMUP_DURATION_MS = 2500;
var RECORD_TARGET_MS = 30000;
var RECORD_MAX_WALL_CLOCK_MS = 45000;
var ALIGN_INTERVAL_MS = 120;
/** Phone-only: slower record quality-sample cadence (desktop matches align at 120ms). */
var RECORD_FRAMING_INTERVAL_MS_PHONE = 350;
/** Trial toggle: record-phase checks 6–9 on phone (BlazeFace + 350ms still on). */
var PHONE_RECORD_LUMINANCE_CHECKS_ENABLED = false;
/** Trial toggle: face-mesh overlay during phone record (needs Landmarker, not BlazeFace). */
var PHONE_RECORD_MESH_ENABLED = false;
var STABLE_HIT_COUNT = 4;
var MIN_ALIGN_MS = 5000;
var FACE_MIN_FRAC = 0.40;
var FACE_MAX_FRAC = 0.72;
var FACE_PREFERRED_MIN_FRAC = 0.55;
var FACE_PREFERRED_MAX_FRAC = 0.65;
var FACE_MAX_MEAN_LUMINANCE = 210;
var FACE_MAX_OVEREXPOSED_RATIO = 0.1;
var FACE_MAX_UNDEREXPOSED_RATIO = 0.22;
var FACE_MAX_SIDE_LUMA_ASYMMETRY = 0.32;
var FACE_MAX_BRIGHTNESS_STD = 15;
var FACE_MAX_HEAD_MOTION_FRAC_PER_SAMPLE = 0.028;
var FACE_MIN_STABLE_FPS = 15;
/** Retuned for rVFC-backed ~30fps intervals (was 0.45 for 120ms poll cadence). */
var FACE_MAX_FRAME_DT_STD_RATIO = 0.85;
var FACE_POSE_RATIO_MIN = 0.65;
var FACE_POSE_RATIO_MAX = 1.35;
var FACE_MAX_LANDMARK_ROLL_RATIO = 0.18;
var FACE_MAX_LANDMARK_YAW_RATIO = 0.35;
var FACE_VISIBLE_MARGIN_FRAC_X = 0.03;
var FACE_VISIBLE_MARGIN_FRAC_Y = 0.04;
var FACE_QUALITY_HISTORY_LEN = 24;
var FACE_PRELIMINARY_RPPG_ENABLED = false;
var FACE_PRELIMINARY_RPPG_MIN_GREEN_STD = 0.8;
var FACE_PRELIMINARY_RPPG_MAX_GREEN_STD = 30;
var RECORD_VIDEO_BPS_MP4 = 2200000;
var RECORD_VIDEO_BPS_WEBM = 1800000;
/** Lower encode load on phones (desktop keeps 2.2 Mbps MP4). */
var RECORD_VIDEO_BPS_MP4_MOBILE = 1200000;
var RECORD_VIDEO_BPS_WEBM_MOBILE = 1000000;
var DEFAULT_QUALITY_RESTART_MESSAGE =
  "We paused because the signal was unstable. Adjust your setup, then restart when ready.";
/** After this many quality-triggered retries, offer the user a "Skip scan" escape hatch. */
var SKIP_SCAN_OFFER_AFTER_RETRIES = 3;

function readMetaContent(name) {
  var el = document.querySelector('meta[name="' + name + '"]');
  if (!el) return "";
  return String(el.getAttribute("content") || "").trim();
}

function readMetaNumber(name) {
  var raw = readMetaContent(name);
  if (!raw) return null;
  var value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isLikelyPhoneRecordingDevice() {
  if (
    typeof navigator !== "undefined" &&
    navigator.userAgentData &&
    navigator.userAgentData.mobile
  ) {
    return true;
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return (
      window.matchMedia("(pointer: coarse)").matches &&
      window.matchMedia("(hover: none)").matches
    );
  }
  return false;
}

function getRecordVideoBitrates() {
  if (isLikelyPhoneRecordingDevice()) {
    return {
      mp4: RECORD_VIDEO_BPS_MP4_MOBILE,
      webm: RECORD_VIDEO_BPS_WEBM_MOBILE,
    };
  }
  return { mp4: RECORD_VIDEO_BPS_MP4, webm: RECORD_VIDEO_BPS_WEBM };
}

/** Phone-only recording/align perf tuning; desktop keeps full-quality paths. */
function getDevicePerfConfig() {
  var isPhone = isLikelyPhoneRecordingDevice();
  var recordFramingMs = isPhone ? RECORD_FRAMING_INTERVAL_MS_PHONE : ALIGN_INTERVAL_MS;
  return {
    isPhone: isPhone,
    recordFramingIntervalMs: recordFramingMs,
    majorAbortStreak: isPhone
      ? Math.max(1, Math.round((100 * ALIGN_INTERVAL_MS) / recordFramingMs))
      : 100,
    useDetectorDuringRecord: isPhone && !PHONE_RECORD_MESH_ENABLED,
    skipMeshDuringRecord: isPhone && !PHONE_RECORD_MESH_ENABLED,
    skipRecordLuminanceChecks: isPhone && !PHONE_RECORD_LUMINANCE_CHECKS_ENABLED,
    deferRecordDetectorLoad: isPhone,
    alignMeshEveryNTicks: isPhone ? 2 : 1,
    /** Desktop: geometry metadata every 4th tick (~480ms) to spare main thread. */
    recordCollectorEveryNTicks: isPhone ? 1 : 4,
  };
}

function getFaceDetectorRuntimeConfig() {
  var mediapipeMinConf = readMetaNumber(
    "maika-mediapipe-min-detection-confidence",
  );
  return {
    provider: "mediapipe",
    mediapipe: {
      modelType: readMetaContent("maika-mediapipe-model-type") || "landmarker",
      jsCdn: readMetaContent("maika-mediapipe-js-cdn"),
      wasmRoot: readMetaContent("maika-mediapipe-wasm-root"),
      modelAssetPath: readMetaContent("maika-mediapipe-model-url"),
      delegate: readMetaContent("maika-mediapipe-delegate"),
      minDetectionConfidence: mediapipeMinConf,
    },
  };
}

var context = {
  phase: "idle",
  stream: null,
  recorder: null,
  cameraMetadata: null,
  warmupTimer: null,
  warmupTimeout: null,
  warmupSummary: null,
  fpsMonitorActive: false,
  fpsMonitorHandle: null,
  fpsMonitorUsesNative: false,
  fpsMonitorRecordingSamples: null,
  alignTimer: null,
  recordFramingTimer: null,
  countdownTimer: 0,
  placementStableHits: 0,
  recordBudgetAccumMs: 0,
  recordBudgetLastSample: null,
  recordWallClockStartedAt: null,
  qualityTimeline: [],
  discardCurrentRecording: false,
  autoRestartCameraAfterAbort: false,
  qualityRestartMessage: "",
  recordingFaceInGuide: false,
  recordingFramingReady: false,
  detectionInFlight: false,
  attemptCount: 0,
  retryCount: 0,
};

var faceModelsReady = false;
var faceModelsLoadFailed = false;
var modelsLoadPromise = null;
var cameraDOM = null;
/** When false, consent UI is hidden and camera may start without checkbox (second scan). */
var faceScanConsentRequired = true;

/** Active camera + recording refs after successful init (for wizard landing reset). */
var faceScanFlowHandles = {
  camera: null,
  recording: null,
};

/**
 * Collect all face scan DOM elements used by the runtime flow.
 * @returns {Record<string, HTMLElement|null>}
 */
function getDomReferences() {
  return {
    panelInstructions: H.byId("panel-instructions"),
    panelScan: H.byId("panel-scan"),
    scanIntro: H.byId("scan-intro"),
    panelResult: H.byId("panel-result"),
    preview: H.byId("preview"),
    faceMeshCanvas: H.byId("face-scan-mesh"),
    videoWrap: H.byId("video-wrap"),
    scanRecovery: H.byId("scan-recovery"),
    scanRecoveryMessage: H.byId("scan-recovery-message"),
    scanActions: H.byId("scan-actions"),
    placementStatus: H.byId("placement-status"),
    scanHudStars: H.byId("scan-hud-stars"),
    scanHudText: H.byId("scan-hud-text"),
    scanHudBottom: H.byId("scan-hud-bottom"),
    scanRingArc: H.byId("scan-ring-arc"),
    modelsStatus: H.byId("models-status"),
    btnStart: H.byId("btn-start"),
    btnRestartCamera: H.byId("btn-restart-camera"),
    btnCancel: H.byId("btn-cancel"),
    overlayCountdown: H.byId("overlay-countdown"),
    countdownNumber: H.byId("countdown-number"),
    recordingPill: H.byId("recording-pill"),
    recordingTime: H.byId("recording-time"),
    errorMsg: H.byId("error-msg"),
    mimeHint: H.byId("mime-hint"),
    faceScanFx: H.byId("face-scan-fx"),
    faceScanClipEl: H.byId("face-scan-fx-clip"),
    faceScanTarget: H.byId("face-scan-target"),
    faceConsentCheckbox: H.byId("face-consent-checkbox"),
    scanOverlayCamera: H.byId("scan-overlay-camera"),
    scanOverlayDenied: H.byId("scan-overlay-denied"),
    scanOverlayCameraText: H.byId("scan-overlay-camera-text"),
    scanOverlayTip: H.byId("scan-overlay-tip"),
    scanStageModel: H.byId("scan-stage-model"),
    scanStageCamera: H.byId("scan-stage-camera"),
    scanStageAlign: H.byId("scan-stage-align"),
    scanOverlayDeniedText: H.byId("scan-overlay-denied-text"),
    btnCameraRetry: H.byId("btn-camera-retry"),
    btnCameraBack: H.byId("btn-camera-back"),
    fpsScanSkipBanner: H.byId("fps-skip-banner"),
    btnFpsSkip: H.byId("btn-fps-skip"),
    btnSkipScan: H.byId("btn-skip-scan"),
  };
}

/**
 * Show or hide camera consent UI (first scan only).
 * @param {boolean} required
 */
export function setFaceScanConsentRequired(required) {
  faceScanConsentRequired = required !== false;
  if (!cameraDOM) return;
  var consentBox = H.byId("face-consent-box");
  if (consentBox) {
    consentBox.classList.toggle("hidden", !faceScanConsentRequired);
  }
  syncStartButtonAvailability();
}

/**
 * Return whether the user has agreed to face scan consent.
 * @returns {boolean}
 */
function hasFaceScanConsent() {
  if (!faceScanConsentRequired) return true;
  return !!(
    cameraDOM.faceConsentCheckbox && cameraDOM.faceConsentCheckbox.checked
  );
}

/**
 * Enable or disable the start button based on detector readiness and consent.
 */
function syncStartButtonAvailability() {
  if (!cameraDOM.btnStart) return;
  var canStart =
    faceModelsReady &&
    !faceModelsLoadFailed &&
    (hasFaceScanConsent() || !faceScanConsentRequired);
  cameraDOM.btnStart.disabled = !canStart;
}

/**
 * Set the scan overlay tip text if the overlay exists.
 * @param {string} text
 */
function setScanOverlayTip(text) {
  if (!cameraDOM.scanOverlayTip) return;
  cameraDOM.scanOverlayTip.textContent = text || "";
}

/**
 * Update the quality HUD values and ring arc display.
 * @param {number|string} level
 * @param {string} text
 * @param {string} bottomText
 * @param {number|string} arcDeg
 */
function setScanHudQuality(level, text, bottomText, arcDeg) {
  var safeLevel = Math.max(1, Math.min(5, Number(level) || 1));
  if (cameraDOM.scanHudStars) {
    cameraDOM.scanHudStars.setAttribute("data-level", String(safeLevel));
  }
  if (cameraDOM.scanHudText && text) {
    cameraDOM.scanHudText.textContent = text;
  }
  if (cameraDOM.scanHudBottom && bottomText) {
    cameraDOM.scanHudBottom.textContent = bottomText;
  }
  if (cameraDOM.scanRingArc) {
    var deg = Math.max(24, Math.min(180, Number(arcDeg) || 36));
    cameraDOM.scanRingArc.style.setProperty("--arc-deg", deg + "deg");
  }
}

/**
 * Sync the HUD and overlay tip based on current face placement state.
 */
function syncScanHudFromPlacement() {
  if (!cameraDOM.placementStatus) return;
  var isGood = cameraDOM.placementStatus.classList.contains("state-good");
  var isBad = cameraDOM.placementStatus.classList.contains("state-bad");
  var phase = String(context.phase || "");
  var placementText = (cameraDOM.placementStatus.textContent || "").trim();

  if (isBad && placementText) {
    setScanOverlayTip(placementText);
  } else if (phase === "record" && isGood) {
    setScanOverlayTip("Great framing. Keep your face centered and steady.");
  }

  if (phase === "record" && isGood) {
    setScanHudQuality(
      5,
      "Great signal. Keep your face steady and centered.",
      "Measuring…",
      168,
    );
    return;
  }

  if (isGood) {
    setScanHudQuality(
      4,
      "Alignment looks good. Hold still for auto start.",
      "Almost ready…",
      132,
    );
    return;
  }

  if (isBad) {
    setScanHudQuality(
      2,
      "Move into frame and keep your face centered.",
      "Adjusting position…",
      58,
    );
    return;
  }

  setScanHudQuality(
    3,
    "Hold still, keep steady lighting, and center your face.",
    "Preparing…",
    84,
  );
}

/**
 * Update the current camera model/align stage UI classes.
 * @param {string} stage
 */
function setScanOverlayStage(stage) {
  var stages = [
    { key: "model", el: cameraDOM.scanStageModel },
    { key: "camera", el: cameraDOM.scanStageCamera },
    { key: "align", el: cameraDOM.scanStageAlign },
  ];
  var rank =
    stage === "align" ? 3 : stage === "camera" ? 2 : stage === "model" ? 1 : 0;
  stages.forEach(function (item) {
    if (!item.el) return;
    var itemRank = item.key === "align" ? 3 : item.key === "camera" ? 2 : 1;
    item.el.classList.toggle("is-active", itemRank === rank);
    item.el.classList.toggle("is-done", itemRank < rank);
  });
}

/**
 * Display a visible error message inside the scan flow UI.
 * @param {string} text
 */
function showError(text) {
  cameraDOM.errorMsg.textContent = text;
  cameraDOM.errorMsg.classList.remove("hidden");
}

/**
 * Hide any visible scan flow error message.
 */
function hideError() {
  cameraDOM.errorMsg.classList.add("hidden");
  cameraDOM.errorMsg.textContent = "";
}

/**
 * Initialize face detector model loading and update step availability.
 * @returns {Promise<void>}
 */
function bootstrapModels() {
  if (modelsLoadPromise) return modelsLoadPromise;
  faceModelsReady = false;
  faceModelsLoadFailed = false;
  syncStartButtonAvailability();

  var runtimeConfig = getFaceDetectorRuntimeConfig();
  Dbg.logFaceScanStep("bootstrap: detector config", {
    provider: runtimeConfig.provider,
    kind: runtimeConfig.kind,
    mediapipe: runtimeConfig.mediapipe,
    preliminaryRppgEnabled: FACE_PRELIMINARY_RPPG_ENABLED,
    qualityThresholds: {
      faceMinFrac: FACE_MIN_FRAC,
      faceMaxFrac: FACE_MAX_FRAC,
      facePreferredMinFrac: FACE_PREFERRED_MIN_FRAC,
      facePreferredMaxFrac: FACE_PREFERRED_MAX_FRAC,
      minLuminance: H.DEFAULT_FACE_MIN_MEAN_LUMINANCE,
      maxLuminance: FACE_MAX_MEAN_LUMINANCE,
      preliminaryRppgMinGreenStd: FACE_PRELIMINARY_RPPG_MIN_GREEN_STD,
      preliminaryRppgMaxGreenStd: FACE_PRELIMINARY_RPPG_MAX_GREEN_STD,
    },
  });
  FaceScanFaceModel.setConfig({
    provider: "mediapipe",
    mediapipe: runtimeConfig.mediapipe,
    deferRecordDetectorLoad: getDevicePerfConfig().deferRecordDetectorLoad,
  });

  modelsLoadPromise = FaceScanFaceModel.load()
    .then(function () {
      return FaceScanFaceModel.warmup().then(function () {
        Dbg.logFaceScanStep("bootstrap: models ready", FaceScanFaceModel.getConfig());
        cameraDOM.modelsStatus.textContent =
          FaceScanFaceModel.getProviderLabel() + " ready.";
        cameraDOM.modelsStatus.classList.remove("hint", "failed");
        cameraDOM.modelsStatus.classList.add("hint", "ready");
        faceModelsReady = true;
        faceModelsLoadFailed = false;
        setScanOverlayStage("model");
        syncStartButtonAvailability();
      });
    })
    .catch(function (err) {
      Dbg.warnFaceScanStep("bootstrap: model load failed", {
        provider: runtimeConfig.provider,
        error: err && err.message ? err.message : String(err),
      });
      cameraDOM.modelsStatus.textContent =
        FaceScanFaceModel.getProviderLabel() +
        " failed to load. Check network settings and detector configuration.";
      cameraDOM.modelsStatus.classList.add("failed");
      faceModelsLoadFailed = true;
      faceModelsReady = false;
      syncStartButtonAvailability();
    });
  return modelsLoadPromise;
}

/**
 * Shows or hides the in-frame recovery card and stacked action buttons.
 * @param {boolean} visible
 * @param {string} [message]
 */
function setScanRecoveryUi(visible, message) {
  if (cameraDOM.videoWrap) {
    cameraDOM.videoWrap.classList.toggle("is-recovery", !!visible);
  }
  if (cameraDOM.scanRecovery) {
    cameraDOM.scanRecovery.classList.toggle("hidden", !visible);
  }
  if (cameraDOM.scanActions) {
    cameraDOM.scanActions.classList.toggle("scan-actions--recovery", !!visible);
  }
  if (visible && cameraDOM.scanRecoveryMessage) {
    cameraDOM.scanRecoveryMessage.textContent =
      message || DEFAULT_QUALITY_RESTART_MESSAGE;
  }
}

/** Clears recovery overlay state (card, dimmer, action layout). */
function clearScanRecoveryUi() {
  setScanRecoveryUi(false);
}

/**
 * Open the scan panel and request camera access (shared by manual and auto start).
 * @param {object} camera
 */
function openScanPanelAndRequestCamera(camera) {
  clearScanRecoveryUi();
  if (cameraDOM.btnRestartCamera) {
    cameraDOM.btnRestartCamera.classList.add("hidden");
  }
  if (cameraDOM.btnSkipScan) {
    cameraDOM.btnSkipScan.classList.add("hidden");
  }
  if (cameraDOM.btnStart) cameraDOM.btnStart.disabled = true;
  cameraDOM.panelInstructions.classList.add("hidden");
  cameraDOM.panelScan.classList.remove("hidden");
  if (cameraDOM.scanIntro) {
    cameraDOM.scanIntro.classList.remove("hidden");
    cameraDOM.scanIntro.hidden = false;
  }
  hideError();
  waitForModelsThenOpenCamera(camera);
}

/**
 * Start the camera flow from the intro panel after validating consent.
 */
function startCameraFromIntro(camera) {
  if (!hasFaceScanConsent()) {
    showError(
      "Please provide consent before starting face scan. We use the video to calculate arousal score and then discard it.",
    );
    if (cameraDOM.faceConsentCheckbox) cameraDOM.faceConsentCheckbox.focus();
    syncStartButtonAvailability();
    return;
  }
  openScanPanelAndRequestCamera(camera);
}

/**
 * Skip intro/consent and start the camera immediately (second scan after music).
 */
export function autoStartFaceScanDirectly() {
  if (!cameraDOM || !faceScanFlowHandles.camera) return;
  if (!faceModelsLoadFailed && (faceModelsReady || modelsLoadPromise)) {
    openScanPanelAndRequestCamera(faceScanFlowHandles.camera);
    return;
  }
  bootstrapModels()
    .catch(function () {})
    .finally(function () {
      if (!faceScanFlowHandles.camera || faceModelsLoadFailed) return;
      openScanPanelAndRequestCamera(faceScanFlowHandles.camera);
    });
}

/**
 * Wait for the model pipeline to be ready, then request camera access.
 */
function waitForModelsThenOpenCamera(camera) {
  cameraDOM.scanOverlayCamera.classList.remove("hidden");
  cameraDOM.scanOverlayDenied.classList.add("hidden");
  cameraDOM.scanOverlayCameraText.textContent = "Preparing face scan…";
  setScanOverlayStage("model");
  setScanOverlayTip(
    "Finalizing detector startup. This is done once and usually takes a few seconds.",
  );

  if (faceModelsLoadFailed) {
    cameraDOM.scanOverlayCamera.classList.add("hidden");
    cameraDOM.scanOverlayDenied.classList.remove("hidden");
    cameraDOM.scanOverlayDeniedText.textContent =
      FaceScanFaceModel.getProviderLabel() +
      " failed to load. Check detector meta config and refresh.";
    syncStartButtonAvailability();
    return;
  }

  if (faceModelsReady) {
    cameraDOM.scanOverlayCameraText.textContent = "Requesting camera access…";
    setScanOverlayStage("camera");
    setScanOverlayTip("Please allow camera access when your browser asks.");
    if (camera) camera.requestCameraAndStartAlignment();
    return;
  }

  Promise.resolve(modelsLoadPromise || bootstrapModels())
    .then(function () {
      if (faceModelsLoadFailed) {
        throw new Error("face_models_failed");
      }
      cameraDOM.scanOverlayCameraText.textContent = "Requesting camera access…";
      setScanOverlayStage("camera");
      setScanOverlayTip("Please allow camera access when your browser asks.");
      if (camera) camera.requestCameraAndStartAlignment();
    })
    .catch(function () {
      cameraDOM.scanOverlayCamera.classList.add("hidden");
      cameraDOM.scanOverlayDenied.classList.remove("hidden");
      cameraDOM.scanOverlayDeniedText.textContent =
        FaceScanFaceModel.getProviderLabel() +
        " failed to load. Check detector meta config and refresh.";
      syncStartButtonAvailability();
    });
}

/**
 * Update the hint text after recording upload completion or failure.
 * @param {string} baseTxt
 * @param {object} uploadResult
 * @param {boolean} endpointConfigured
 */
function applyRecordingOutcomeHint(baseTxt, uploadResult, endpointConfigured) {
  var parts = [baseTxt + "."];
  if (!endpointConfigured) {
    showError(
      "Upload URL is not configured. Set meta face-scan-upload-url or MAIKA_FACE_SCAN_UPLOAD_URL (see README).",
    );
    parts.push("Set the upload URL, then refresh the page to try again.");
    cameraDOM.mimeHint.textContent = parts.join(" ");
    return;
  }
  if (uploadResult.ok) {
    hideError();
    parts.push("Upload to your API completed successfully.");
    cameraDOM.mimeHint.textContent = parts.join(" ");
    return;
  }
  if (uploadResult.timedOut) {
    var timeoutSec = Math.round(
      ((FaceScanUpload && FaceScanUpload.timeoutMs) || 120000) / 1000,
    );
    showError(
      "Upload timed out after " +
        timeoutSec +
        "s. Try again or increase FaceScanUpload.timeoutMs in service.js.",
    );
  } else if (uploadResult.netError) {
    showError(
      (uploadResult.errorMessage ? uploadResult.errorMessage + " " : "") +
        "If this persists, confirm the API allows this origin (CORS) and that you are on HTTPS or localhost.",
    );
  } else {
    var serverHint = uploadResult.errorMessage
      ? " " + uploadResult.errorMessage
      : "";
    showError(
      "Upload rejected (HTTP " +
        uploadResult.status +
        ")." +
        serverHint +
        ' Check server logs and multipart field "' +
        (FaceScanUpload && FaceScanUpload.fieldName
          ? FaceScanUpload.fieldName
          : "video") +
        '".',
    );
  }
  parts.push("Refresh the page to retry when the issue is resolved.");
  cameraDOM.mimeHint.textContent = parts.join(" ");
}

/**
 * Same as Cancel: stop streams, panels, overlays, blob bridge.
 * Safe to call from demo wizard when exiting the flow.
 */
export function resetFaceScanFlowForLanding() {
  if (!cameraDOM) return;
  setFaceScanConsentRequired(true);
  resetUiToStart(faceScanFlowHandles.camera, faceScanFlowHandles.recording);
  if (cameraDOM.faceConsentCheckbox) {
    cameraDOM.faceConsentCheckbox.checked = false;
  }
  syncStartButtonAvailability();
}

/**
 * Return to the face-scan intro so the user can capture a new video
 * (e.g. after upload rejected for low quality).
 */
export function restartFaceScanForNewRecording() {
  if (!cameraDOM) return;
  resetUiToStart(faceScanFlowHandles.camera, faceScanFlowHandles.recording);
  syncStartButtonAvailability();
  if (faceScanFlowHandles.camera && !faceScanConsentRequired) {
    autoStartFaceScanDirectly();
  }
}

/**
 * Reset the camera/recording flow UI back to the start page.
 */
function resetUiToStart(camera, recording) {
  if (recording) recording.teardownRecordingPill();
  if (camera) camera.stopStream();
  if (camera) camera.cancelCountdown();
  context.skipFpsGate = false;
  if (cameraDOM.fpsScanSkipBanner) cameraDOM.fpsScanSkipBanner.classList.add("hidden");
  if (cameraDOM.btnSkipScan) cameraDOM.btnSkipScan.classList.add("hidden");
  cameraDOM.panelInstructions.classList.remove("hidden");
  cameraDOM.panelScan.classList.add("hidden");
  cameraDOM.panelResult.classList.add("hidden");
  if (cameraDOM.scanIntro) {
    cameraDOM.scanIntro.classList.add("hidden");
    cameraDOM.scanIntro.hidden = true;
  }
  if (camera) camera.hideScanCameraStates();
  if (cameraDOM.btnRestartCamera) {
    cameraDOM.btnRestartCamera.classList.add("hidden");
  }
  clearScanRecoveryUi();
  cameraDOM.overlayCountdown.hidden = true;
  cameraDOM.overlayCountdown.classList.add("hidden");
  hideError();
  setScanOverlayStage("model");
  setScanOverlayTip(
    "We are preparing the detector in the background for a smoother start.",
  );
  syncStartButtonAvailability();
  document.dispatchEvent(new CustomEvent("maika-demo:face-scan-blob-cleared"));
}

/**
 * Return true when required DOM elements for face scan flow are present.
 * @returns {boolean}
 */
function hasRequiredDom() {
  return !!(
    cameraDOM.btnStart &&
    cameraDOM.btnRestartCamera &&
    cameraDOM.btnCancel &&
    cameraDOM.btnCameraRetry &&
    cameraDOM.btnCameraBack &&
    cameraDOM.preview
  );
}

/**
 * Build the recording controller instance.
 * @returns {object}
 */
function createRecordingController(getCamera, onResetUi) {
  var recordBps = getRecordVideoBitrates();
  return FaceScanRecordingController.create({
    ctx: context,
    getCamera: function () {
      return getCamera();
    },
    elements: {
      preview: cameraDOM.preview,
      placementStatus: cameraDOM.placementStatus,
      recordingPill: cameraDOM.recordingPill,
      recordingTime: cameraDOM.recordingTime,
      panelScan: cameraDOM.panelScan,
      panelResult: cameraDOM.panelResult,
      mimeHint: cameraDOM.mimeHint,
    },
    config: {
      recordTargetMs: RECORD_TARGET_MS,
      recordVideoBpsMp4: recordBps.mp4,
      recordVideoBpsWebm: recordBps.webm,
    },
    bridges: {
      showError: showError,
      hideError: hideError,
      applyRecordingOutcomeHint: applyRecordingOutcomeHint,
      resetUiToStart: function () {
        onResetUi();
      },
      deferAssessUpload: true,
      onRecordingBlobReady: function (blob, recordedMime, baseTxt) {
        void stopMusicPlayback({
          fadeOutMs: MUSIC_FADE_MS_AFTER_RECORDING_COMPLETE,
        });
        document.dispatchEvent(
          new CustomEvent("maika-demo:face-scan-blob-ready", {
            detail: {
              blob: blob,
              recordedMime: recordedMime,
              baseTxt: baseTxt,
              consentGiven: hasFaceScanConsent(),
              qualityTimeline: context.qualityTimeline || [],
              captureMetadata: context.cameraMetadata || null,
            },
          }),
        );
        if (cameraDOM.mimeHint) {
          cameraDOM.mimeHint.textContent =
            baseTxt + "Upload and score calculation start automatically.";
        }
      },
      onQualityRestart: function (message, qualityTimeline) {
        context.retryCount = (context.retryCount || 0) + 1;
        context.qualityTimeline = Array.isArray(qualityTimeline)
          ? qualityTimeline
          : [];
        hideError();
        var recoveryMessage = message || DEFAULT_QUALITY_RESTART_MESSAGE;
        setScanRecoveryUi(true, recoveryMessage);
        if (cameraDOM.btnRestartCamera) {
          cameraDOM.btnRestartCamera.classList.remove("hidden");
        }
        if (cameraDOM.btnSkipScan) {
          var offerSkip = context.retryCount >= SKIP_SCAN_OFFER_AFTER_RETRIES;
          cameraDOM.btnSkipScan.classList.toggle("hidden", !offerSkip);
        }
        if (cameraDOM.mimeHint) {
          cameraDOM.mimeHint.textContent =
            "Tap Restart camera below when you are ready for another measurement.";
        }
        if (cameraDOM.placementStatus) {
          H.setPlacementUi(
            cameraDOM.placementStatus,
            "bad",
            "Paused — restart below when ready.",
          );
        }
        if (cameraDOM.scanOverlayCameraText) {
          cameraDOM.scanOverlayCameraText.textContent =
            "Restart recommended for a cleaner measurement.";
        }
        if (cameraDOM.scanOverlayCamera) {
          cameraDOM.scanOverlayCamera.classList.add("hidden");
        }
        if (cameraDOM.scanOverlayDenied) {
          cameraDOM.scanOverlayDenied.classList.add("hidden");
        }
        setScanOverlayTip("Use steady lighting and hold still after you restart.");
      },
    },
  });
}

/**
 * Build the camera controller instance.
 * @returns {object}
 */
function createCameraController(recording) {
  var perf = getDevicePerfConfig();
  return FaceScanCameraController.create({
    ctx: context,
    elements: {
      preview: cameraDOM.preview,
      faceMeshCanvas: cameraDOM.faceMeshCanvas,
      placementStatus: cameraDOM.placementStatus,
      scanOverlayCamera: cameraDOM.scanOverlayCamera,
      scanOverlayDenied: cameraDOM.scanOverlayDenied,
      scanOverlayCameraText: cameraDOM.scanOverlayCameraText,
      scanOverlayDeniedText: cameraDOM.scanOverlayDeniedText,
      faceScanFx: cameraDOM.faceScanFx,
      faceScanClipEl: cameraDOM.faceScanClipEl,
      faceScanTarget: cameraDOM.faceScanTarget,
      overlayCountdown: cameraDOM.overlayCountdown,
      countdownNumber: cameraDOM.countdownNumber,
    },
    config: {
      warmupDurationMs: WARMUP_DURATION_MS,
      alignIntervalMs: ALIGN_INTERVAL_MS,
      isPhone: perf.isPhone,
      recordFramingIntervalMs: perf.recordFramingIntervalMs,
      majorAbortStreak: perf.majorAbortStreak,
      useDetectorDuringRecord: perf.useDetectorDuringRecord,
      skipMeshDuringRecord: perf.skipMeshDuringRecord,
      skipRecordLuminanceChecks: perf.skipRecordLuminanceChecks,
      deferRecordDetectorLoad: perf.deferRecordDetectorLoad,
      alignMeshEveryNTicks: perf.alignMeshEveryNTicks,
      recordCollectorEveryNTicks: perf.recordCollectorEveryNTicks,
      stableHitCount: STABLE_HIT_COUNT,
      minAlignMs: MIN_ALIGN_MS,
      faceMinFrac: FACE_MIN_FRAC,
      faceMaxFrac: FACE_MAX_FRAC,
      facePreferredMinFrac: FACE_PREFERRED_MIN_FRAC,
      facePreferredMaxFrac: FACE_PREFERRED_MAX_FRAC,
      recordTargetMs: RECORD_TARGET_MS,
      recordMaxWallClockMs: RECORD_MAX_WALL_CLOCK_MS,
      faceMinMeanLuminance: H.DEFAULT_FACE_MIN_MEAN_LUMINANCE,
      faceMaxMeanLuminance: FACE_MAX_MEAN_LUMINANCE,
      maxOverexposedRatio: FACE_MAX_OVEREXPOSED_RATIO,
      maxUnderexposedRatio: FACE_MAX_UNDEREXPOSED_RATIO,
      maxSideLuminanceAsymmetry: FACE_MAX_SIDE_LUMA_ASYMMETRY,
      maxBrightnessStd: FACE_MAX_BRIGHTNESS_STD,
      maxHeadMotionFracPerSample: FACE_MAX_HEAD_MOTION_FRAC_PER_SAMPLE,
      minStableFps: FACE_MIN_STABLE_FPS,
      maxFrameDtStdRatio: FACE_MAX_FRAME_DT_STD_RATIO,
      poseRatioMin: FACE_POSE_RATIO_MIN,
      poseRatioMax: FACE_POSE_RATIO_MAX,
      maxLandmarkRollRatio: FACE_MAX_LANDMARK_ROLL_RATIO,
      maxLandmarkYawRatio: FACE_MAX_LANDMARK_YAW_RATIO,
      faceVisibleMarginFracX: FACE_VISIBLE_MARGIN_FRAC_X,
      faceVisibleMarginFracY: FACE_VISIBLE_MARGIN_FRAC_Y,
      qualityHistoryLen: FACE_QUALITY_HISTORY_LEN,
      preliminaryRppgEnabled: FACE_PRELIMINARY_RPPG_ENABLED,
      preliminaryRppgMinGreenStd: FACE_PRELIMINARY_RPPG_MIN_GREEN_STD,
      preliminaryRppgMaxGreenStd: FACE_PRELIMINARY_RPPG_MAX_GREEN_STD,
    },
    bridges: {
      hideError: hideError,
      onCameraReady: function () {
        setScanOverlayStage("camera");
        setScanOverlayTip("Hold steady — preparing your camera…");
      },
      onAlignmentStart: function () {
        setScanOverlayStage("align");
        setScanOverlayTip(
          "Center your face in the guide. We start automatically once alignment is stable.",
        );
      },
      onCountdownDone: function () {
        setScanOverlayStage("align");
        setScanOverlayTip("Perfect alignment. Starting recording now…");
        if (!recording) return Promise.resolve();
        context.attemptCount = (context.attemptCount || 0) + 1;
        if (context.cameraMetadata) {
          context.cameraMetadata.attempt_count = context.attemptCount;
          context.cameraMetadata.retry_count = context.retryCount || 0;
        }
        return recording.beginRecording();
      },
    },
  });
}

/**
 * Attach all UI event handlers used by the face scan flow.
 */
function bindFaceScanEvents(camera, recording) {
  cameraDOM.btnStart.addEventListener("click", function () {
    startCameraFromIntro(camera);
  });

  cameraDOM.btnCameraRetry.addEventListener("click", function () {
    hideError();
    if (camera) camera.requestCameraAndStartAlignment();
  });

  cameraDOM.btnCameraBack.addEventListener("click", function () {
    if (camera) camera.hideScanCameraStates();
    if (camera) camera.stopStream();
    cameraDOM.panelScan.classList.add("hidden");
    if (cameraDOM.scanIntro) {
      cameraDOM.scanIntro.classList.add("hidden");
      cameraDOM.scanIntro.hidden = true;
    }
    cameraDOM.panelInstructions.classList.remove("hidden");
    hideError();
    syncStartButtonAvailability();
  });

  cameraDOM.btnCancel.addEventListener("click", function () {
    if (camera) camera.cancelCountdown();
    if (context.recorder && context.recorder.state === "recording") {
      if (recording) recording.abortRecordingDiscard();
      return;
    }
    resetUiToStart(camera, recording);
  });

  if (cameraDOM.btnRestartCamera) {
    cameraDOM.btnRestartCamera.addEventListener("click", function () {
      hideError();
      openScanPanelAndRequestCamera(camera);
    });
  }

  if (cameraDOM.faceConsentCheckbox) {
    cameraDOM.faceConsentCheckbox.addEventListener("change", function () {
      hideError();
      syncStartButtonAvailability();
    });
  }

  if (cameraDOM.btnFpsSkip) {
    cameraDOM.btnFpsSkip.addEventListener("click", function () {
      context.skipFpsGate = true;
      if (cameraDOM.fpsScanSkipBanner) {
        cameraDOM.fpsScanSkipBanner.classList.add("hidden");
      }
    });
  }

  if (cameraDOM.btnSkipScan) {
    cameraDOM.btnSkipScan.addEventListener("click", function () {
      resetUiToStart(camera, recording);
      document.dispatchEvent(new CustomEvent("maika-demo:face-scan-skipped", {
        detail: { retryCount: context.retryCount },
      }));
    });
  }
}

/**
 * Observe placement text/state changes and sync the quality HUD.
 */
function initPlacementObserver() {
  if (!cameraDOM.placementStatus) return;
  var placementObserver = new MutationObserver(function () {
    syncScanHudFromPlacement();
  });
  placementObserver.observe(cameraDOM.placementStatus, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  syncScanHudFromPlacement();
}

/**
 * Initialize the face scan flow and wire event handlers.
 */
export function initFaceScanFlow() {
  "use strict";

  cameraDOM = getDomReferences();
  var camera = null;
  var recording = null;

  if (!hasRequiredDom()) return;

  recording = createRecordingController(
    function () {
      return camera;
    },
    function () {
      resetUiToStart(camera, recording);
    },
  );
  camera = createCameraController(recording);
  faceScanFlowHandles.camera = camera;
  faceScanFlowHandles.recording = recording;
  bindFaceScanEvents(camera, recording);
  initPlacementObserver();

  bootstrapModels().catch(function () {
    // Failure state is already reflected in UI via cameraDOM.modelsStatus / faceModelsLoadFailed.
  });
}
