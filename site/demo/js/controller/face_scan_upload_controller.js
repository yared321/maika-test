import { postRecording, resolveEndpoint } from "../service/service.js";

const UPLOAD_STATUS = {
  idle: "Ready to upload and calculate score",
  uploading: "Uploading video and calculating score…",
  success: "Score calculated. You can continue.",
  error: "Upload/score calculation failed. Click Continue to retry.",
};

/**
 * Update upload progress CSS variable (0-100).
 * @param {Record<string, HTMLElement|null>} dom
 * @param {number} percent
 */
function setUploadProgressFill(dom, percent) {
  if (!dom.uploadProgressTrack) return;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  dom.uploadProgressTrack.style.setProperty("--upload-fill", `${p}%`);
}

/**
 * Apply visual upload state (idle/uploading/success/error) to UI.
 * @param {Record<string, HTMLElement|null>} dom
 * @param {Record<string, any>} state
 * @param {"idle"|"uploading"|"success"|"error"} mode
 * @param {string} label
 */
function setUploadUiState(dom, state, mode, label) {
  if (!dom.uploadStatusCard) return;
  stopUploadPulse(state);
  dom.uploadStatusCard.classList.remove("is-uploading", "is-success", "is-error");

  if (mode === "uploading") {
    dom.uploadStatusCard.classList.add("is-uploading");
    setUploadProgressFill(dom, 16);
    let phase = 16;
    state.upload.pulseTimer = globalThis.setInterval(() => {
      phase += 14;
      if (phase > 86) phase = 24;
      setUploadProgressFill(dom, phase);
    }, 260);
  } else if (mode === "success") {
    dom.uploadStatusCard.classList.add("is-success");
    setUploadProgressFill(dom, 100);
  } else if (mode === "error") {
    dom.uploadStatusCard.classList.add("is-error");
    setUploadProgressFill(dom, 46);
  } else {
    setUploadProgressFill(dom, 8);
  }

  if (dom.uploadStatusLabel) {
    dom.uploadStatusLabel.textContent = label || "";
  }
}

/**
 * Enable or disable the wizard next button for the face-scan step.
 * @param {Record<string, HTMLElement|null>} dom
 * @param {Record<string, any>} state
 */
export function syncFaceStepNextGate(dom, state) {
  if (!dom.nextButton || dom.nextButton.hidden) return;
  if (state.currentStep !== 2) {
    dom.nextButton.disabled = false;
    return;
  }
  dom.nextButton.disabled =
    state.upload.isInFlight || (!state.upload.completed && !state.upload.pendingBlob);
}

/**
 * Stop upload progress pulse timer if active.
 * @param {Record<string, any>} state
 */
export function stopUploadPulse(state) {
  if (!state.upload.pulseTimer) return;
  globalThis.clearInterval(state.upload.pulseTimer);
  state.upload.pulseTimer = 0;
}

/**
 * Clear recorded preview UI and revoke existing blob URL.
 * @param {Record<string, HTMLElement|null>} dom
 * @param {Record<string, any>} state
 */
export function clearRecordedPreview(dom, state) {
  if (dom.recordedPreview) {
    dom.recordedPreview.pause();
    dom.recordedPreview.removeAttribute("src");
    dom.recordedPreview.load();
  }
  if (state.upload.recordedPreviewUrl) {
    URL.revokeObjectURL(state.upload.recordedPreviewUrl);
    state.upload.recordedPreviewUrl = "";
  }
  dom.uploadPreviewCard?.classList.add("hidden");
  setUploadUiState(dom, state, "idle", UPLOAD_STATUS.idle);
}

/**
 * Render a recorded blob preview and reset status to idle.
 * @param {Record<string, HTMLElement|null>} dom
 * @param {Record<string, any>} state
 * @param {Blob} blob
 */
export function applyRecordedPreview(dom, state, blob) {
  if (!blob || !dom.recordedPreview) return;
  if (state.upload.recordedPreviewUrl) {
    URL.revokeObjectURL(state.upload.recordedPreviewUrl);
  }
  state.upload.recordedPreviewUrl = URL.createObjectURL(blob);
  dom.recordedPreview.src = state.upload.recordedPreviewUrl;
  dom.recordedPreview.load();
  dom.uploadPreviewCard?.classList.remove("hidden");
  setUploadUiState(dom, state, "idle", UPLOAD_STATUS.idle);
}

/**
 * Reset upload state flags and pending upload payload.
 * @param {Record<string, any>} state
 */
export function resetUploadState(state) {
  state.upload.isInFlight = false;
  state.upload.completed = false;
  state.upload.pendingBlob = null;
  state.upload.pendingMime = "";
  state.upload.pendingConsent = true;
}

/**
 * Upload the recorded face blob and sync UI/state from result.
 * @param {Record<string, HTMLElement|null>} dom
 * @param {Record<string, any>} state
 * @param {(dom: Record<string, HTMLElement|null>, message: string) => void} setWizardError
 * @returns {Promise<void>}
 */
export async function startFaceUpload(dom, state, setWizardError) {
  if (!state.upload.pendingBlob || state.upload.isInFlight || state.upload.completed) {
    return;
  }

  const age = String(state.demographics.age || "").trim();
  const sex = String(state.demographics.gender || "").trim();
  if (!age || !sex) {
    setUploadUiState(dom, state, "error", "Missing age or gender.");
    setWizardError(
      dom,
      "Age and gender are required before upload. Please return to step 1 and confirm your details.",
    );
    syncFaceStepNextGate(dom, state);
    return;
  }

  if (!state.upload.pendingConsent) {
    setUploadUiState(dom, state, "error", "Consent required before upload/score.");
    setWizardError(
      dom,
      "Face-scan consent is required before upload and score calculation.",
    );
    syncFaceStepNextGate(dom, state);
    return;
  }

  const endpoint = resolveEndpoint();
  if (!endpoint) {
    setUploadUiState(
      dom,
      state,
      "error",
      "Upload URL is not configured, so score cannot be calculated.",
    );
    setWizardError(dom, "Upload URL is not configured.");
    syncFaceStepNextGate(dom, state);
    return;
  }

  state.upload.isInFlight = true;
  setWizardError(dom, "");
  setUploadUiState(dom, state, "uploading", UPLOAD_STATUS.uploading);
  syncFaceStepNextGate(dom, state);

  try {
    // Contract requires a random integer in [0..9] for request_id.
    const requestIdDigit = Math.floor(Math.random() * 10);
    const uploadResult = await postRecording(state.upload.pendingBlob, endpoint, {
      recordedMime: state.upload.pendingMime || state.upload.pendingBlob.type || "",
      age: age,
      sex: sex,
      consent: true,
      requestId: requestIdDigit,
    });

    if (uploadResult.ok) {
      state.upload.completed = true;
      setUploadUiState(dom, state, "success", UPLOAD_STATUS.success);
      if (uploadResult.data && typeof uploadResult.data === "object") {
        state.assessment.latestResult = uploadResult.data;
      }
      state.upload.pendingBlob = null;
      state.upload.pendingMime = "";
      setWizardError(dom, "");
      syncFaceStepNextGate(dom, state);
      return;
    }

    state.upload.completed = false;
    setUploadUiState(dom, state, "error", UPLOAD_STATUS.error);
    const message =
      uploadResult.errorMessage ||
      (uploadResult.timedOut
        ? "Upload timed out."
        : uploadResult.netError
          ? "Network or CORS error."
          : `Upload failed (HTTP ${uploadResult.status || 0}).`);
    setWizardError(dom, message);
    syncFaceStepNextGate(dom, state);
  } catch (error) {
    state.upload.completed = false;
    setUploadUiState(dom, state, "error", UPLOAD_STATUS.error);
    setWizardError(dom, "Unexpected upload error. Please try again.");
    console.error("Upload failed unexpectedly:", error);
    syncFaceStepNextGate(dom, state);
  } finally {
    state.upload.isInFlight = false;
    syncFaceStepNextGate(dom, state);
  }
}
