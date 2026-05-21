import {
  fetchMusicData,
  MUSIC_ENDED_EVENT,
  MUSIC_PROGRESS_EVENT,
  interruptMusicFadeOut,
  resetMusicDemoSession,
  stopMusicPlayback,
} from "./controller/music_stream_controller.js";
import { ValenceSliderController } from "./controller/slider_controller.js";
import { ScoreVisualizationController } from "./controller/emotion_score_controller.js";
import { handleDemoAccess, unlockDemoFlow, setDemoAccessError } from "./controller/demo_access_controller.js";
import { saveDemographics, validateAgeField } from "./controller/demographic_form_controller.js";
import {
  applyRecordedPreview,
  clearRecordedPreview,
  resetUploadState,
  startFaceUpload,
  stopUploadPulse,
  syncFaceStepNextGate,
  syncRecordAgainButton,
} from "./controller/face_scan_upload_controller.js";

import {
  initFaceScanFlow,
  resetFaceScanFlowForLanding,
  restartFaceScanForNewRecording,
} from "./controller/face_scan_flow_controller.js";

var MUSIC_FADE_MS_ON_BACK_TO_DEMOGRAPHIC = 3000; // Fade duration when wizard Back / Done returns user and music should ease out (ms).
const VALENCE_X_AXIS_DEFAULT = 0;

// Preload music data on page load to improve perceived performance later.
try {
  await fetchMusicData();
} catch (error) {
  console.error("Failed to fetch music data:", error);
}

// Initialize face scan flow early, since model loading can be slow.
try {
  await initFaceScanFlow();
} catch (error) {
  console.error("Failed to initialize face scan flow:", error);
}

initDemoWizard();

/**
 * Initialize the demo wizard by collecting DOM nodes, state, and controllers.
 * This starts the demo experience and prepares the view and event wiring.
 */
function initDemoWizard() {
  const dom = getDomReferences();
  if (!dom.wizardForm) return;

  const state = createInitialState(dom.steps.length);
  const controllers = createControllers(dom, state);

  initializeUi(dom, state);
  bindEvents(dom, state, controllers);
}

/**
 * Grab all needed DOM references used across the demo flow.
 * Returns an object of frequently reused DOM elements.
 */
function getDomReferences() {
  const wizardForm = document.getElementById("demoWizardForm");
  return {
    demoLanding: document.getElementById("demo-landing"),
    demoFlow: document.getElementById("demo-flow"),
    demoAccessInput: document.getElementById("demo-access-code"),
    demoAccessButton: document.getElementById("demo-access-cta"),
    demoAccessError: document.getElementById("demo-access-error"),
    wizardForm,
    steps: wizardForm ? Array.from(wizardForm.querySelectorAll(".wizard-step")) : [],
    backButton: wizardForm?.querySelector('[data-action="back"]'),
    nextButton: wizardForm?.querySelector('[data-action="next"]'),
    ageInput: wizardForm?.querySelector("#age"),
    genderInput: wizardForm?.querySelector("#gender"),
    valenceSlider: wizardForm?.querySelector("#valence-slider"),
    valenceValue: wizardForm?.querySelector("#valence-value"),
    valenceHint: wizardForm?.querySelector("#valence-hint"),
    valenceEmoji: wizardForm?.querySelector("#valence-emoji"),
    stepCurrent: wizardForm?.querySelector("[data-step-current]"),
    stepTotal: wizardForm?.querySelector("[data-step-total]"),
    errorMessage: wizardForm?.querySelector("[data-wizard-error]"),
    uploadPreviewCard: wizardForm?.querySelector("#upload-preview-card"),
    recordedPreview: wizardForm?.querySelector("#recorded-preview"),
    uploadStatusCard: wizardForm?.querySelector("#upload-status-card"),
    uploadStatusLabel: wizardForm?.querySelector("#upload-status-label"),
    uploadProgressTrack: wizardForm?.querySelector("#upload-progress-track"),
    btnRecordAgain: wizardForm?.querySelector("#btn-record-again"),
    faceScanHostPre: wizardForm?.querySelector("#face-scan-host-pre"),
    faceScanHostPost: wizardForm?.querySelector("#face-scan-host-post"),
    faceScanApp: wizardForm?.querySelector("#face-scan-host-post .app"),
    faceScanTitle: wizardForm?.querySelector("#face-scan-title"),
    faceScanSubtitle: wizardForm?.querySelector("#face-scan-subtitle"),
  };
}

/**
 * Final map arousal from baseline (a1) and post-music (a2): (a2 - a1) / 2.
 * @param {Record<string, any>} state
 * @returns {number | null}
 */
function computeMusicResponseArousal(state) {
  const a1 = state.assessment.baselineArousal;
  const a2 = state.assessment.postArousal;
  if (!Number.isFinite(a1) || !Number.isFinite(a2)) return null;
  return (a2 - a1) / 2;
}

/**
 * Create the initial wizard state object with progress, upload, and assessment data.
 * The state object drives UI behavior and upload handling.
 */
function createInitialState(stepCount) {
  return {
    currentStep: 0,
    lastStep: Math.max(0, stepCount - 1),
    demographics: {
      age: "",
      gender: "",
    },
    upload: {
      recordedPreviewUrl: "",
      pulseTimer: 0,
      isInFlight: false,
      completed: false,
      pendingBlob: null,
      pendingMime: "",
      pendingConsent: true,
    },
    assessment: {
      latestResult: null,
      baselineArousal: null,
      postArousal: null,
    },
    emotionViz: {
      xAxisValencePercent: VALENCE_X_AXIS_DEFAULT,
      xAxisValenceLabel: "Neutral",
      xAxisValenceEmoji: "😐",
    },
    musicGate: {
      minimumListenSeconds: 30,
      listenedSeconds: 0,
      requirementMet: false,
    },
    nextButtonLabels: new Map([
      [0, "Listen Music"],
      [1, "Proceed to Music"],
      [2, "Proceed to Face Scan"],
      [3, "Continue"],
      [4, "See Results"],
      [5, "Done"],
    ]),
  };
}

/**
 * Instantiate and initialize UI controllers for score visualization and valence slider.
 * These controllers keep the UI responsive to state changes.
 */
function createControllers(dom, state) {
  const score = ScoreVisualizationController.create({
    root: dom.wizardForm,
    getValence: () => state.emotionViz.xAxisValencePercent,
    getArousal: () => computeMusicResponseArousal(state),
  });

  const valence = new ValenceSliderController({
    sliderEl: dom.valenceSlider,
    valueEl: dom.valenceValue,
    hintEl: dom.valenceHint,
    emojiEl: dom.valenceEmoji,
    defaultValue: VALENCE_X_AXIS_DEFAULT,
    onChange: (valenceState) => {
      state.emotionViz.xAxisValencePercent = valenceState.xAxisValencePercent;
      state.emotionViz.xAxisValenceLabel = valenceState.xAxisValenceLabel;
      state.emotionViz.xAxisValenceEmoji = valenceState.xAxisValenceEmoji;
    },
  });
  valence.init();

  return { score, valence };
}

/**
 * Set initial UI visibility and step indicators for the demo wizard.
 * Hides the flow until access is granted and shows the landing screen.
 */
function initializeUi(dom, state) {
  if (dom.stepTotal) dom.stepTotal.textContent = String(dom.steps.length);
  if (dom.demoFlow) {
    dom.demoFlow.hidden = true;
    dom.demoFlow.classList.add("hidden");
  }
  if (dom.demoLanding) {
    dom.demoLanding.hidden = false;
    dom.demoLanding.classList.remove("hidden");
  }
  updateStep(dom, state, 0, { focus: false });
}

/**
 * Wire up event handlers for form controls, wizard navigation, and face-scan flow.
 * Handles button clicks, custom events, and page unload cleanup.
 */
function bindEvents(dom, state, controllers) {
  dom.ageInput?.addEventListener("input", () => validateAgeField(dom));
  dom.ageInput?.addEventListener("change", () => validateAgeField(dom));

  document.addEventListener(MUSIC_ENDED_EVENT, () => {
    if (state.currentStep === 2 && state.musicGate.requirementMet) {
      updateStep(dom, state, 3);
    }
  });

  document.addEventListener(MUSIC_PROGRESS_EVENT, (ev) => {
    const seconds = Number(ev?.detail?.currentTime) || 0;
    if (!state.musicGate.requirementMet) {
      state.musicGate.listenedSeconds = Math.max(state.musicGate.listenedSeconds, seconds);
      if (state.musicGate.listenedSeconds >= state.musicGate.minimumListenSeconds) {
        state.musicGate.requirementMet = true;
      }
    }
    syncMusicStepNextGate(dom, state);
  });

  document.addEventListener("maika-demo:face-scan-blob-ready", (ev) => {
    const detail = ev?.detail;
    if (!detail?.blob) return;
    state.upload.pendingBlob = detail.blob;
    state.upload.pendingMime = detail.recordedMime || detail.blob.type || "";
    state.upload.pendingConsent = detail.consentGiven !== false;
    state.upload.completed = false;
    applyRecordedPreview(dom, state, detail.blob);
    void startFaceUpload(dom, state, setWizardError);
    syncFaceStepNextGate(dom, state);
  });

  document.addEventListener("maika-demo:face-scan-blob-cleared", () => {
    resetUploadState(state);
    clearRecordedPreview(dom, state);
    syncRecordAgainButton(dom, false);
    syncFaceStepNextGate(dom, state);
  });

  dom.btnRecordAgain?.addEventListener("click", () => {
    if (state.upload.isInFlight) return;
    resetUploadState(state);
    clearRecordedPreview(dom, state);
    setWizardError(dom, "");
    syncRecordAgainButton(dom, false);
    restartFaceScanForNewRecording();
    syncFaceStepNextGate(dom, state);
  });

  dom.backButton?.addEventListener("click", () => {
    if (state.currentStep === 0) {
      returnToLandingPage(dom, state, controllers);
      return;
    }
    updateStep(dom, state, state.currentStep - 1);
  });

  dom.nextButton?.addEventListener("click", () => {
    void handleNextClick(dom, state, controllers);
  });

  dom.demoAccessButton?.addEventListener("click", () => {
    void handleDemoAccess(dom, state, updateStep);
  });
  dom.demoAccessInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void handleDemoAccess(dom, state, updateStep);
    }
  });

  globalThis.addEventListener("beforeunload", () => {
    stopUploadPulse(state);
    if (state.upload.recordedPreviewUrl) {
      URL.revokeObjectURL(state.upload.recordedPreviewUrl);
    }
  });
}


/**
 * Move the wizard to a specific step and update UI, buttons, and focus.
 * Also saves demographics or stops playback as needed for the new step.
 */
function updateStep(dom, state, targetStep, options = {}) {
  // Leaving the music step: fade volume, then clear player / unlock picker (once, after fade).
  if (state.currentStep === 2 && targetStep <= 1) {
    void stopMusicPlayback({
      fadeOutMs: MUSIC_FADE_MS_ON_BACK_TO_DEMOGRAPHIC,
    }).then(() => {
      resetMusicDemoSession();
    });
  }

  // Demographics → music: cancel stray fade-from-back and reset player so picker works.
  if (state.currentStep <= 1 && targetStep === 2) {
    interruptMusicFadeOut();
    resetMusicDemoSession();
  }

  if (targetStep === 1) {
    moveFaceScanApp(dom, "pre");
    saveDemographics(dom, state);
  }

  if (targetStep === 2) {
    state.musicGate.listenedSeconds = 0;
    state.musicGate.requirementMet = false;
  }

  if (targetStep === 3) {
    moveFaceScanApp(dom, "post");
    resetUploadState(state);
    clearRecordedPreview(dom, state);
    syncRecordAgainButton(dom, false);
    restartFaceScanForNewRecording();
  }

  if (targetStep === 5) {
    options.controllers?.score?.render?.();
  }

  state.currentStep = targetStep;
  dom.steps.forEach((step, index) => {
    const isActive = index === state.currentStep;
    step.classList.toggle("is-active", isActive);
    step.setAttribute("aria-hidden", String(!isActive));
  });

  if (dom.stepCurrent) dom.stepCurrent.textContent = String(state.currentStep + 1);
  setWizardError(dom, "");
  if (dom.nextButton) {
    dom.nextButton.textContent = state.nextButtonLabels.get(targetStep) ?? "Next";
    dom.nextButton.hidden = false;
  }
  if (dom.backButton) {
    // Hide Back from face-scan step onward (camera, slider, final result).
    dom.backButton.hidden = targetStep >= 3;
  }

  syncFaceStepNextGate(dom, state);
  syncMusicStepNextGate(dom, state);

  if (dom.demoFlow?.hidden) return;
  if (options.focus === false) return;
  const focusable = dom.steps[state.currentStep]?.querySelector(
    "input, select, textarea, button",
  );
  focusable?.focus();
}

function moveFaceScanApp(dom, targetHost) {
  if (!dom.faceScanApp) return;
  const host = targetHost === "pre" ? dom.faceScanHostPre : dom.faceScanHostPost;
  if (!host) return;

  if (dom.faceScanTitle) {
    if (targetHost === "pre") {
      dom.faceScanTitle.textContent = "Baseline face scan";
      if (dom.faceScanSubtitle) {
        dom.faceScanSubtitle.textContent =
          "Your baseline scan before listening to music.";
        dom.faceScanSubtitle.hidden = false;
      }
    } else {
      dom.faceScanTitle.textContent = "Face scan";
      if (dom.faceScanSubtitle) {
        dom.faceScanSubtitle.textContent =
          "Scan again after listening to music.";
        dom.faceScanSubtitle.hidden = false;
      }
    }
  }

  if (dom.faceScanApp.parentElement !== host) {
    host.appendChild(dom.faceScanApp);
  }
}

function syncMusicStepNextGate(dom, state) {
  if (!dom.nextButton || dom.nextButton.hidden) return;
  if (state.currentStep !== 2) return;
  const min = state.musicGate.minimumListenSeconds;
  const listened = Math.min(min, Math.floor(state.musicGate.listenedSeconds));
  const met = state.musicGate.requirementMet;
  dom.nextButton.disabled = !met;
  if (!met) {
    const remain = Math.max(0, min - listened);
    const m = Math.floor(remain / 60);
    const s = String(remain % 60).padStart(2, "0");
    // setWizardError(dom, `Listen for at least 1:00 before continuing (${m}:${s} remaining).`);
  } else if (
    dom.errorMessage &&
    /Listen for at least 1:00 before continuing/.test(dom.errorMessage.textContent || "")
  ) {
    setWizardError(dom, "");
  }
}


/**
 * Display an error message inside the wizard UI.
 * If no error target exists, it safely does nothing.
 */
function setWizardError(dom, message) {
  if (!dom.errorMessage) return;
  dom.errorMessage.textContent = message || "";
}

/**
 * Validate all visible inputs on the current wizard step.
 * Reports the first invalid field and returns false when validation fails.
 */
function validateCurrentStep(dom, state) {
  validateAgeField(dom);
  const activeFields = Array.from(
    dom.steps[state.currentStep]?.querySelectorAll("input, select, textarea") || [],
  );
  for (const field of activeFields) {
    if (!field.checkValidity()) {
      field.reportValidity();
      return false;
    }
  }
  return true;
}


/**
 * Handle the wizard's Next button behavior for navigation and upload flow.
 * Advances steps, triggers upload, or returns to landing as appropriate.
 */
async function handleNextClick(dom, state, controllers) {
  if (state.currentStep === 2 && !state.musicGate.requirementMet) {
    syncMusicStepNextGate(dom, state);
    return;
  }

  if (!validateCurrentStep(dom, state)) {
    setWizardError(dom, "Please complete this step before continuing.");
    return;
  }

  if (state.currentStep === 1 || state.currentStep === 3) {
    if (state.upload.isInFlight) {
      setWizardError(dom, "Uploading video and calculating score. Please wait.");
      return;
    }
    if (state.upload.completed) {
      updateStep(dom, state, state.currentStep + 1);
      return;
    }
    if (state.upload.pendingBlob) {
      await startFaceUpload(dom, state, setWizardError);
      return;
    }
    setWizardError(dom, "Complete a face recording first.");
    return;
  }

  if (state.currentStep === state.lastStep) {
    returnToLandingPage(dom, state, controllers);
    return;
  }

  const nextStep = state.currentStep + 1;
  updateStep(dom, state, nextStep, {
    controllers: controllers,
  });
}

/**
 * Return the demo to the landing page and reset the wizard state.
 * Stops playback, clears upload state, and resets the access form.
 */
function returnToLandingPage(dom, state, controllers) {
  void stopMusicPlayback({
    fadeOutMs: MUSIC_FADE_MS_ON_BACK_TO_DEMOGRAPHIC,
  }).then(() => {
    resetMusicDemoSession();
  });
  resetFaceScanFlowForLanding();
  moveFaceScanApp(dom, "post");
  resetUploadState(state);
  clearRecordedPreview(dom, state);

  // Reset state to initial values
  const initialState = createInitialState(dom.steps.length);
  Object.assign(state, initialState);

  // Clear demographics inputs
  if (dom.ageInput) dom.ageInput.value = "";
  if (dom.genderInput) dom.genderInput.value = "";

  // Reset valence slider to default
  if (controllers.valence) {
    controllers.valence.setValue(VALENCE_X_AXIS_DEFAULT);
  }

  if (controllers.score) {
    controllers.score.render();
  }

  if (dom.demoFlow) {
    dom.demoFlow.hidden = true;
    dom.demoFlow.classList.add("hidden");
  }
  if (dom.demoLanding) {
    dom.demoLanding.hidden = false;
    dom.demoLanding.classList.remove("hidden");
  }

  if (dom.demoAccessInput) {
    dom.demoAccessInput.value = "";
    dom.demoAccessInput.focus();
  }
  setDemoAccessError(dom, "");
  updateStep(dom, state, 0, { focus: false });
}
