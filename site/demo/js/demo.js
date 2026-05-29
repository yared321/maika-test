import {
  fetchMusicData,
  MUSIC_PROGRESS_EVENT,
  interruptMusicFadeOut,
  autoplayRandomMusicTrack,
  resetMusicDemoSession,
  stopMusicPlayback,
} from "./controller/music_stream_controller.js";
import { ValenceSliderController } from "./controller/slider_controller.js";
import { ScoreVisualizationController } from "./controller/emotion_score_controller.js";
import { handleDemoAccess, unlockDemoFlow, setDemoAccessError } from "./controller/demo_access_controller.js";
import { applyDefaultDemographics } from "./controller/demographic_form_controller.js";
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
  setFaceScanConsentRequired,
} from "./controller/face_scan_flow_controller.js";
import { MUSIC_HISTOGRAM_WINDOW_SEC } from "./controller/music_waveform_renderer.js";
import { syncWizardNextButton } from "./controller/wizard_nav_controller.js";
import {
  placeValenceInScanIntro,
  resetValencePlacementForScan,
} from "./controller/valence_placement_controller.js";

var MUSIC_FADE_MS_ON_BACK_TO_DEMOGRAPHIC = 3000;
const VALENCE_X_AXIS_DEFAULT = 0;
/** Earliest manual proceed to face scan (button enabled). */
const MUSIC_PROCEED_MIN_SECONDS = 30;
/** Auto-advance to face scan after one minute of listening. */
const MUSIC_AUTO_ADVANCE_SECONDS = MUSIC_HISTOGRAM_WINDOW_SEC;

/** Wizard steps that hide Next (post-music face scan auto-advances after upload). */
const AUTO_ADVANCE_STEPS = new Set([2]);

try {
  await fetchMusicData();
} catch (_error) {
}

try {
  await initFaceScanFlow();
} catch (_error) {
}

initDemoWizard();

function initDemoWizard() {
  const dom = getDomReferences();
  if (!dom.wizardForm) return;

  const state = createInitialState(dom.steps.length);
  const controllers = createControllers(dom, state);

  initializeUi(dom, state);
  bindEvents(dom, state, controllers);
}

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
    valenceCard: wizardForm?.querySelector("#face-scan-valence-panel"),
  };
}

function computeMusicResponseArousal(state) {
  const a1 = state.assessment.baselineArousal;
  const a2 = state.assessment.postArousal;
  if (!Number.isFinite(a1) || !Number.isFinite(a2)) return null;
  return (a2 - a1) / 2;
}

function createInitialState(stepCount) {
  const state = {
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
      postScanValenceConfirmed: false,
    },
    musicGate: {
      proceedMinSeconds: MUSIC_PROCEED_MIN_SECONDS,
      autoAdvanceSeconds: MUSIC_AUTO_ADVANCE_SECONDS,
      listenedSeconds: 0,
      requirementMet: false,
      autoAdvanced: false,
    },
    nextButtonLabels: new Map([
      [0, "Continue"],
      [1, "Proceed to face scan"],
      [3, "Done"],
    ]),
  };
  applyDefaultDemographics(state);
  return state;
}

function createControllers(dom, state) {
  const score = ScoreVisualizationController.create({
    root: dom.wizardForm,
    getValence: () => state.emotionViz.xAxisValencePercent,
    getArousal: () => computeMusicResponseArousal(state),
    getBaselineArousal: () => state.assessment.baselineArousal,
    getPostArousal: () => state.assessment.postArousal,
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
      if (state.currentStep === 2) {
        state.emotionViz.postScanValenceConfirmed = true;
        setWizardError(dom, "");
      }
    },
  });
  valence.init();

  return { score, valence };
}

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
  setValencePanelVisible(dom, false);
  setFaceScanConsentRequired(true);
  updateStep(dom, state, 0, { focus: false });
}

/**
 * Start the post-music face scan exactly once from wizard step 3.
 * This prevents duplicate camera requests and keeps alignment state stable.
 */
function startPostScanCapture(dom, state) {
  moveFaceScanApp(dom, "post");
  setFaceScanConsentRequired(false);
  resetValencePlacementForScan(dom);
  state.emotionViz.postScanValenceConfirmed = false;
  resetUploadState(state);
  clearRecordedPreview(dom, state);
  syncRecordAgainButton(dom, false);
  restartFaceScanForNewRecording();
}

function bindEvents(dom, state, controllers) {
  document.addEventListener(MUSIC_PROGRESS_EVENT, (ev) => {
    const seconds = Number(ev?.detail?.currentTime) || 0;
    state.musicGate.listenedSeconds = Math.max(state.musicGate.listenedSeconds, seconds);

    if (
      !state.musicGate.requirementMet &&
      state.musicGate.listenedSeconds >= state.musicGate.proceedMinSeconds
    ) {
      state.musicGate.requirementMet = true;
      syncWizardNextButton(dom, state);
    }

    if (
      state.currentStep === 1 &&
      !state.musicGate.autoAdvanced &&
      state.musicGate.listenedSeconds >= state.musicGate.autoAdvanceSeconds
    ) {
      state.musicGate.autoAdvanced = true;
      updateStep(dom, state, 2, { controllers });
    }
  });

  document.addEventListener("maika-demo:face-scan-blob-ready", (ev) => {
    const detail = ev?.detail;
    if (!detail?.blob) return;
    state.upload.pendingBlob = detail.blob;
    state.upload.pendingMime = detail.recordedMime || detail.blob.type || "";
    state.upload.pendingConsent = detail.consentGiven !== false;
    state.upload.completed = false;
    if (state.currentStep === 2) {
      state.emotionViz.postScanValenceConfirmed = false;
    }
    applyRecordedPreview(dom, state, detail.blob);
    void startFaceUpload(dom, state, setWizardError);
    syncFaceStepNextGate(dom, state);
  });

  document.addEventListener("maika-demo:face-scan-blob-cleared", () => {
    resetUploadState(state);
    state.emotionViz.postScanValenceConfirmed = false;
    clearRecordedPreview(dom, state);
    syncRecordAgainButton(dom, false);
    syncFaceStepNextGate(dom, state);
    if (state.currentStep === 2) {
      resetValencePlacementForScan(dom);
    }
  });

  document.addEventListener("maika-demo:face-scan-countdown-complete", () => {
    if (state.currentStep !== 2) return;
    placeValenceInScanIntro(dom);
  });

  document.addEventListener("maika-demo:face-upload-complete", (ev) => {
    const phase = ev?.detail?.scanPhase;
    if (phase === "baseline" && state.currentStep === 0 && state.upload.completed) {
      updateStep(dom, state, 1);
      return;
    }
    if (phase === "post" && state.currentStep === 2 && state.upload.completed) {
      syncPostScanValenceForResults(state, controllers);
      updateStep(dom, state, 3, { controllers });
    }
  });

  dom.btnRecordAgain?.addEventListener("click", () => {
    if (state.upload.isInFlight) return;
    resetUploadState(state);
    state.emotionViz.postScanValenceConfirmed = false;
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

function updateStep(dom, state, targetStep, options = {}) {
  if (state.currentStep === 1 && targetStep < 1) {
    void stopMusicPlayback({
      fadeOutMs: MUSIC_FADE_MS_ON_BACK_TO_DEMOGRAPHIC,
    }).then(() => {
      resetMusicDemoSession();
    });
  }

  if (state.currentStep === 0 && targetStep === 1) {
    interruptMusicFadeOut();
    resetMusicDemoSession();
  }

  if (targetStep === 0) {
    setFaceScanConsentRequired(true);
    setValencePanelVisible(dom, false);
    applyDefaultDemographics(state);
    moveFaceScanApp(dom, "pre");
    if (state.currentStep !== 0 && !state.upload.completed) {
      restartFaceScanForNewRecording();
    }
  }

  if (targetStep === 1) {
    state.musicGate.listenedSeconds = 0;
    state.musicGate.requirementMet = false;
    state.musicGate.autoAdvanced = false;
    globalThis.requestAnimationFrame(function () {
      globalThis.requestAnimationFrame(function () {
        void autoplayRandomMusicTrack();
      });
    });
  }

  if (targetStep === 2) {
    startPostScanCapture(dom, state);
  }

  if (targetStep === 3) {
    setValencePanelVisible(dom, false);
    if (options.controllers) {
      syncPostScanValenceForResults(state, options.controllers);
    }
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
    dom.nextButton.hidden = AUTO_ADVANCE_STEPS.has(targetStep);
  }
  if (dom.backButton) {
    dom.backButton.hidden = targetStep >= 2;
  }

  syncWizardNextButton(dom, state);

  if (dom.demoFlow?.hidden) return;
  if (options.focus === false) return;
  const focusable = dom.steps[state.currentStep]?.querySelector(
    "input, select, textarea, button",
  );
  focusable?.focus();
}

function setValencePanelVisible(dom, visible) {
  if (!dom.valenceCard) return;
  dom.valenceCard.classList.toggle("hidden", !visible);
  dom.valenceCard.setAttribute("aria-hidden", String(!visible));
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

/**
 * Copy the post-scan valence slider into wizard state before rendering results.
 * @param {Record<string, any>} state
 * @param {{ valence?: { getState: () => { xAxisValencePercent: number, xAxisValenceLabel: string, xAxisValenceEmoji: string } } }} controllers
 */
function syncPostScanValenceForResults(state, controllers) {
  const valenceState = controllers.valence?.getState?.();
  if (!valenceState) return;
  state.emotionViz.xAxisValencePercent = valenceState.xAxisValencePercent;
  state.emotionViz.xAxisValenceLabel = valenceState.xAxisValenceLabel;
  state.emotionViz.xAxisValenceEmoji = valenceState.xAxisValenceEmoji;
  state.emotionViz.postScanValenceConfirmed = true;
}

function setWizardError(dom, message) {
  if (!dom.errorMessage) return;
  dom.errorMessage.textContent = message || "";
}

function validateCurrentStep(dom, state) {
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

async function handleNextClick(dom, state, controllers) {
  if (!validateCurrentStep(dom, state)) {
    setWizardError(dom, "Please complete this step before continuing.");
    return;
  }

  if (state.currentStep === 0) {
    if (state.upload.isInFlight) {
      setWizardError(dom, "Uploading video and calculating score. Please wait.");
      return;
    }
    if (state.upload.completed) {
      updateStep(dom, state, 1, { controllers });
      return;
    }
    setWizardError(dom, "Complete a face recording first.");
    return;
  }

  if (state.currentStep === 1) {
    if (!state.musicGate.requirementMet) {
      const remaining = Math.max(
        0,
        Math.ceil(state.musicGate.proceedMinSeconds - state.musicGate.listenedSeconds),
      );
      setWizardError(
        dom,
        `Listen for ${remaining} more second${remaining === 1 ? "" : "s"} to continue.`,
      );
      return;
    }
    updateStep(dom, state, 2, { controllers });
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

function returnToLandingPage(dom, state, controllers) {
  void stopMusicPlayback({
    fadeOutMs: MUSIC_FADE_MS_ON_BACK_TO_DEMOGRAPHIC,
  }).then(() => {
    resetMusicDemoSession();
  });
  resetFaceScanFlowForLanding();
  moveFaceScanApp(dom, "post");
  setValencePanelVisible(dom, false);
  resetUploadState(state);
  clearRecordedPreview(dom, state);
  resetValencePlacementForScan(dom);

  const initialState = createInitialState(dom.steps.length);
  Object.assign(state, initialState);

  if (controllers.valence) {
    controllers.valence.setValue(VALENCE_X_AXIS_DEFAULT);
  }

  if (controllers.score) {
    controllers.score.reset?.();
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
