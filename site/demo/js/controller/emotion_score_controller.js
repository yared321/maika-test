/**
 * Cache all DOM elements used by the step-5 emotion visualization UI.
 * This avoids repeated `querySelector` calls during each render cycle.
 * @param {object} controller
 */
function bindDomElements(controller) {
  controller.emotionMap = controller.root.querySelector("#emotion-map");
  controller.emotionMapPoint = controller.root.querySelector("#emotion-map-point");
  controller.emotionPointLabel = controller.root.querySelector("#emotion-point-label");
  controller.emotionGuideX = controller.root.querySelector("#emotion-guide-x");
  controller.emotionGuideY = controller.root.querySelector("#emotion-guide-y");
  controller.emotionPrimaryLabel = controller.root.querySelector("#emotion-primary-label");
  controller.emotionPrimaryValue = controller.root.querySelector("#emotion-primary-value");
  controller.emotionPrimarySub = controller.root.querySelector("#emotion-primary-sub");
  controller.emotionArousalValue = controller.root.querySelector("#emotion-arousal-value");
  controller.emotionValenceValue = controller.root.querySelector("#emotion-valence-value");
  controller.emotionQuadrantValue = controller.root.querySelector("#emotion-quadrant-value");
  controller.emotionInterpretation = controller.root.querySelector("#emotion-interpretation");
  controller.emotionSimpleEmoji = controller.root.querySelector("#emotion-simple-emoji");
  controller.emotionSimpleTitle = controller.root.querySelector("#emotion-simple-title");
  controller.emotionSimpleText = controller.root.querySelector("#emotion-simple-text");
  controller.emotionArousalMeterLabel = controller.root.querySelector(
    "#emotion-arousal-meter-label",
  );
  controller.emotionValenceMeterLabel = controller.root.querySelector(
    "#emotion-valence-meter-label",
  );
  controller.emotionArousalMeterFill = controller.root.querySelector(
    "#emotion-arousal-meter-fill",
  );
  controller.emotionValenceMeterFill = controller.root.querySelector(
    "#emotion-valence-meter-fill",
  );
}

/**
 * Normalize any input to the valence/arousal score domain [-100, 100].
 * Non-numeric values are treated as 0 to keep rendering safe.
 * @param {unknown} value
 * @returns {number}
 */
function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 100) return 100;
  if (n < -100) return -100;
  return n;
}

/**
 * Clamp map coordinates to an inner safe plotting range [2, 98].
 * This keeps the marker/label away from hard edges of the map.
 * @param {unknown} value
 * @returns {number}
 */
function clampPlotPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  if (n > 98) return 98;
  if (n < 2) return 2;
  return n;
}

/**
 * Format a number as signed percentage text used in labels and meta rows.
 * Examples: `+12.3%`, `-4.0%`, `0.0%`.
 * @param {unknown} n
 * @param {number} digits
 * @returns {string}
 */
function signedPercent(n, digits) {
  const d = typeof digits === "number" ? digits : 1;
  let v = Number(n);
  if (!Number.isFinite(v)) v = 0;
  return (v > 0 ? "+" : "") + v.toFixed(d) + "%";
}

/**
 * Translate valence/arousal sign combinations into quadrant label copy.
 * @param {number} valence
 * @param {number} arousal
 * @returns {string}
 */
function getQuadrantLabel(valence, arousal) {
  if (arousal >= 0 && valence >= 0) return "Excited";
  if (arousal >= 0 && valence < 0) return "Stressed";
  if (arousal < 0 && valence >= 0) return "Content / Relaxed";
  return "Sad / Depressed";
}

/**
 * Return the simplified user-facing tone (emoji/title/text) for a quadrant.
 * @param {string} quadrant
 * @returns {{ emoji: string, title: string, text: string }}
 */
function getSimpleTone(quadrant) {
  if (quadrant === "Excited") {
    return {
      emoji: "😄",
      title: "Energized and positive",
      text: "You look activated and your self-reported feeling is on the positive side.",
    };
  }
  if (quadrant === "Stressed") {
    return {
      emoji: "😣",
      title: "Energized but tense",
      text: "Your body looks activated, while your feeling leans negative or unpleasant.",
    };
  }
  if (quadrant === "Content / Relaxed") {
    return {
      emoji: "😌",
      title: "Calm and positive",
      text: "You appear relaxed and your self-reported feeling is positive.",
    };
  }
  return {
    emoji: "😔",
    title: "Low energy and low mood",
    text: "Both activation and self-reported feeling are on the lower/negative side.",
  };
}

/**
 * Convert valence/arousal scores into map percentages for x/y placement.
 * Input domain is [-100, 100], output domain is safe plot percentages.
 * @param {number} valence
 * @param {number} arousal
 * @returns {{ mapLeft: number, mapTop: number }}
 */
function computeMapPosition(valence, arousal) {
  return {
    mapLeft: clampPlotPercent(((valence + 100) / 200) * 100),
    mapTop: clampPlotPercent(100 - ((arousal + 100) / 200) * 100),
  };
}

/**
 * Set vertical guide direction classes and return computed segment geometry.
 * The segment always grows from the map midline toward the marker.
 * @param {HTMLElement | null} guideYEl
 * @param {number} mapTopPercent
 * @returns {{ topPercent: number, segmentPercent: number }}
 */
function setGuideDirectionClass(guideYEl, mapTopPercent) {
  const MIDLINE_PERCENT = 50;
  if (!guideYEl) return { topPercent: MIDLINE_PERCENT, segmentPercent: 0 };

  let topPercent = MIDLINE_PERCENT;
  let segmentPercent = 0;
  guideYEl.classList.remove("toward-top", "toward-bottom");

  if (mapTopPercent + 1e-4 < MIDLINE_PERCENT) {
    topPercent = mapTopPercent;
    segmentPercent = MIDLINE_PERCENT - mapTopPercent;
    guideYEl.classList.add("toward-top");
  } else if (mapTopPercent > MIDLINE_PERCENT + 1e-4) {
    topPercent = MIDLINE_PERCENT;
    segmentPercent = mapTopPercent - MIDLINE_PERCENT;
    guideYEl.classList.add("toward-bottom");
  }

  return { topPercent: topPercent, segmentPercent: segmentPercent };
}

/**
 * Replays axis→marker segment animation after layout is updated (new width / height).
 * X guides: transform scale on `::before`. Y guides: clip-path reveal axis→marker on `::before`.
 * @param {object} controller
 */
function scheduleGuideAnimations(controller) {
  const guideXEl = controller.emotionGuideX;
  const guideYEl = controller.emotionGuideY;
  const hasVerticalGuideDirection =
    guideYEl &&
    (guideYEl.classList.contains("toward-top") ||
      guideYEl.classList.contains("toward-bottom"));

  if (controller.guideDrawTimerId != null) {
    globalThis.clearTimeout(controller.guideDrawTimerId);
    controller.guideDrawTimerId = null;
  }

  controller.guideAltDrawTick = !controller.guideAltDrawTick;
  const drawCls = controller.guideAltDrawTick ? "animate-draw-replay" : "animate-draw";

  guideXEl?.classList.remove("animate-draw", "animate-draw-replay");
  guideYEl?.classList.remove("animate-draw", "animate-draw-replay");

  guideXEl && void guideXEl.offsetWidth;
  guideYEl && void guideYEl.offsetWidth;

  const reduceMotion =
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

  globalThis.requestAnimationFrame(() => {
    globalThis.requestAnimationFrame(() => {
      const xWidth = guideXEl && guideXEl.style.width ? parseFloat(guideXEl.style.width) : 0;
      if (guideXEl && Number.isFinite(xWidth) && xWidth >= 0.25) {
        guideXEl.classList.add(drawCls);
      }

      const yHeight =
        guideYEl && guideYEl.style.height ? parseFloat(guideYEl.style.height) : 0;
      if (
        guideYEl &&
        Number.isFinite(yHeight) &&
        yHeight >= 0.25 &&
        hasVerticalGuideDirection
      ) {
        guideYEl.classList.add(drawCls);
      }

      if (reduceMotion) return;
      controller.guideDrawTimerId = globalThis.setTimeout(() => {
        controller.guideDrawTimerId = null;
        guideXEl?.classList.remove("animate-draw", "animate-draw-replay");
        guideYEl?.classList.remove("animate-draw", "animate-draw-replay");
      }, 840);
    });
  });
}

/**
 * Apply visual theme class for the active quadrant on the map background.
 * Passing empty/unknown clears all quadrant theme classes.
 * @param {object} controller
 * @param {string} name
 */
function setMapQuadrantTheme(controller, name) {
  if (!controller.emotionMap) return;
  controller.emotionMap.classList.remove(
    "quadrant-q1",
    "quadrant-q2",
    "quadrant-q3",
    "quadrant-q4",
  );
  if (name === "q1") controller.emotionMap.classList.add("quadrant-q1");
  else if (name === "q2") controller.emotionMap.classList.add("quadrant-q2");
  else if (name === "q3") controller.emotionMap.classList.add("quadrant-q3");
  else if (name === "q4") controller.emotionMap.classList.add("quadrant-q4");
}

/**
 * Update the detailed numeric summary card and descriptive interpretation text.
 * This is the "full detail" block shown above the map.
 * @param {object} controller
 * @param {number} valence
 * @param {number} arousal
 * @param {string} quadrant
 */
function updateArousalSummary(controller, valence, arousal, quadrant) {
  const primaryLabel = arousal >= 0 ? "Focus score" : "Relax score";
  const primaryMagnitude = Math.abs(arousal);
  if (controller.emotionPrimaryLabel) controller.emotionPrimaryLabel.textContent = primaryLabel;
  if (controller.emotionPrimaryValue) {
    controller.emotionPrimaryValue.textContent = primaryMagnitude.toFixed(1) + "%";
  }
  if (controller.emotionPrimarySub) {
    controller.emotionPrimarySub.textContent =
      arousal >= 0
        ? "Positive arousal means activation/focus (Y-axis up)."
        : "Negative arousal means deactivation/relaxation (Y-axis down).";
  }
  if (controller.emotionArousalValue) {
    controller.emotionArousalValue.textContent = signedPercent(arousal, 1);
  }
  if (controller.emotionValenceValue) {
    controller.emotionValenceValue.textContent = signedPercent(valence, 0);
  }
  if (controller.emotionQuadrantValue) controller.emotionQuadrantValue.textContent = quadrant;
  if (controller.emotionInterpretation) {
    controller.emotionInterpretation.textContent =
      "Your point sits in the " +
      quadrant +
      " quadrant: valence " +
      signedPercent(valence, 0) +
      " on X-axis and arousal " +
      signedPercent(arousal, 1) +
      " on Y-axis.";
  }
}

/**
 * Update the simplified emotion summary and both compact progress meters.
 * @param {object} controller
 * @param {number} valence
 * @param {number} arousal
 * @param {string} quadrant
 */
function updateSimpleSummaryAndMeters(controller, valence, arousal, quadrant) {
  const simpleTone = getSimpleTone(quadrant);
  const primaryMagnitude = Math.abs(arousal);
  if (controller.emotionSimpleEmoji) controller.emotionSimpleEmoji.textContent = simpleTone.emoji;
  if (controller.emotionSimpleTitle) controller.emotionSimpleTitle.textContent = simpleTone.title;
  if (controller.emotionSimpleText) controller.emotionSimpleText.textContent = simpleTone.text;
  if (controller.emotionArousalMeterLabel) {
    controller.emotionArousalMeterLabel.textContent =
      (arousal >= 0 ? "Focus " : "Relax ") + primaryMagnitude.toFixed(1) + "%";
  }
  if (controller.emotionValenceMeterLabel) {
    controller.emotionValenceMeterLabel.textContent =
      (valence >= 0 ? "Positive " : "Negative ") + Math.abs(valence).toFixed(0) + "%";
  }
  if (controller.emotionArousalMeterFill) {
    controller.emotionArousalMeterFill.style.width = primaryMagnitude.toFixed(1) + "%";
  }
  if (controller.emotionValenceMeterFill) {
    controller.emotionValenceMeterFill.style.width = Math.abs(valence).toFixed(1) + "%";
  }
}

/**
 * Paint live marker/label/guide positions onto the map for current scores.
 * Also updates directional classes used by guide animations.
 * @param {object} controller
 * @param {number} valence
 * @param {number} arousal
 * @param {number} mapLeft
 * @param {number} mapTop
 */
function updateMapAndGuides(controller, valence, arousal, mapLeft, mapTop) {
  if (controller.emotionMapPoint && controller.emotionMap) {
    controller.emotionMap.style.setProperty("--point-x", mapLeft.toFixed(2) + "%");
    controller.emotionMap.style.setProperty("--point-y", mapTop.toFixed(2) + "%");
  }
  if (controller.emotionPointLabel) {
    controller.emotionPointLabel.textContent =
      "V " + signedPercent(valence, 0) + " · A " + signedPercent(arousal, 1);
    controller.emotionPointLabel.classList.toggle("below", mapTop < 18);
    controller.emotionPointLabel.classList.toggle("edge-right", mapLeft > 84);
    controller.emotionPointLabel.classList.toggle("edge-left", mapLeft < 16);
  }
  if (controller.emotionGuideX) {
    controller.emotionGuideX.style.left = (valence >= 0 ? 50 : mapLeft).toFixed(2) + "%";
    controller.emotionGuideX.style.top = mapTop.toFixed(2) + "%";
    controller.emotionGuideX.style.width = Math.abs(mapLeft - 50).toFixed(2) + "%";
    controller.emotionGuideX.classList.toggle("to-left", valence < 0);
  }
  if (controller.emotionGuideY) {
    controller.emotionGuideY.style.left = mapLeft.toFixed(2) + "%";
    const yLayout = setGuideDirectionClass(controller.emotionGuideY, mapTop);
    const ySegment = Number.isFinite(yLayout.segmentPercent)
      ? Math.max(0, Math.min(50, yLayout.segmentPercent))
      : 0;
    controller.emotionGuideY.style.top = yLayout.topPercent.toFixed(4) + "%";
    controller.emotionGuideY.style.height = ySegment <= 0 ? "0%" : ySegment.toFixed(4) + "%";
  }
}

/**
 * Apply fallback UI when backend arousal is unavailable.
 * @param {object} controller
 * @param {number} valence
 */
function renderWithoutArousal(controller, valence) {
  if (controller.emotionPrimaryLabel) controller.emotionPrimaryLabel.textContent = "Arousal score";
  if (controller.emotionPrimaryValue) controller.emotionPrimaryValue.textContent = "—";
  if (controller.emotionPrimarySub) {
    controller.emotionPrimarySub.textContent =
      "No backend arousal available yet. Complete the face scan and calculate score first.";
  }
  if (controller.emotionArousalValue) controller.emotionArousalValue.textContent = "—";
  if (controller.emotionValenceValue) {
    controller.emotionValenceValue.textContent = signedPercent(valence, 0);
  }
  if (controller.emotionQuadrantValue) controller.emotionQuadrantValue.textContent = "—";
  if (controller.emotionInterpretation) {
    controller.emotionInterpretation.textContent =
      "We need the face-scan arousal score to place your final point on the map.";
  }
  if (controller.emotionSimpleEmoji) controller.emotionSimpleEmoji.textContent = "🙂";
  if (controller.emotionSimpleTitle) controller.emotionSimpleTitle.textContent = "Your quick result";
  if (controller.emotionSimpleText) {
    controller.emotionSimpleText.textContent =
      "Complete face scan scoring to get a simple emotional summary.";
  }
  if (controller.emotionArousalMeterLabel) controller.emotionArousalMeterLabel.textContent = "—";
  if (controller.emotionValenceMeterLabel) {
    controller.emotionValenceMeterLabel.textContent =
      (valence >= 0 ? "Positive " : "Negative ") + signedPercent(Math.abs(valence), 0);
  }
  if (controller.emotionArousalMeterFill) controller.emotionArousalMeterFill.style.width = "0%";
  if (controller.emotionValenceMeterFill) {
    controller.emotionValenceMeterFill.style.width = Math.abs(valence).toFixed(1) + "%";
  }
  if (controller.emotionMapPoint) {
    const fallbackLeft = clampPlotPercent(((valence + 100) / 200) * 100);
    if (controller.emotionMap) {
      controller.emotionMap.style.setProperty("--point-x", fallbackLeft.toFixed(2) + "%");
      controller.emotionMap.style.setProperty("--point-y", "50%");
    }
  }
  if (controller.emotionPointLabel) {
    controller.emotionPointLabel.textContent = "V " + signedPercent(valence, 0) + " · A —";
    controller.emotionPointLabel.classList.remove("below", "edge-right", "edge-left");
  }
  if (controller.emotionGuideX) {
    const fallbackLeft = clampPlotPercent(((valence + 100) / 200) * 100);
    const fallbackWidth = Math.abs(fallbackLeft - 50);
    controller.emotionGuideX.style.width = fallbackWidth.toFixed(2) + "%";
    controller.emotionGuideX.style.left = (valence >= 0 ? 50 : fallbackLeft).toFixed(2) + "%";
    controller.emotionGuideX.style.top = "50%";
    controller.emotionGuideX.classList.toggle("to-left", valence < 0);
  }
  if (controller.emotionGuideY) {
    controller.emotionGuideY.style.height = "0%";
    controller.emotionGuideY.style.left = clampPlotPercent(
      ((valence + 100) / 200) * 100,
    ).toFixed(2) + "%";
    controller.emotionGuideY.style.top = "50%";
    controller.emotionGuideY.classList.remove("toward-top", "toward-bottom");
  }
  scheduleGuideAnimations(controller);
  setMapQuadrantTheme(controller, "");
}

/**
 * Render full emotion-map state when both valence and arousal are available.
 * @param {object} controller
 * @param {number} valence
 * @param {number} arousal
 */
function renderWithArousal(controller, valence, arousal) {
  const quadrant = getQuadrantLabel(valence, arousal);
  const mapPos = computeMapPosition(valence, arousal);
  const mapLeft = mapPos.mapLeft;
  const mapTop = mapPos.mapTop;
  const qTheme = arousal >= 0
    ? (valence >= 0 ? "q1" : "q2")
    : (valence >= 0 ? "q4" : "q3");

  updateArousalSummary(controller, valence, arousal, quadrant);
  updateSimpleSummaryAndMeters(controller, valence, arousal, quadrant);
  updateMapAndGuides(controller, valence, arousal, mapLeft, mapTop);
  scheduleGuideAnimations(controller);
  setMapQuadrantTheme(controller, qTheme);
}

/**
 * Main render entry: reads providers, normalizes values, and renders
 * either pending mode (no arousal) or full arousal+valence map.
 * @param {object} controller
 */
function renderController(controller) {
  const valence = clampPercent(controller.getValence());
  const rawArousal = controller.getArousal();
  const arousal = Number.isFinite(Number(rawArousal))
    ? clampPercent(Number(rawArousal))
    : null;

  if (arousal == null) {
    renderWithoutArousal(controller, valence);
    return;
  }

  renderWithArousal(controller, valence, arousal);
}

/**
 * Create score-visualization controller runtime for the demo wizard.
 * @param {{ root?: ParentNode, getValence?: () => number, getArousal?: () => number | null }} options
 * @returns {{ render: () => void }}
 */
function createScoreVisualizationController(options = {}) {
  const controller = {
    root: options.root || document,
    /** Toggles animate-draw ↔ animate-draw-replay so pseudo-element keyframes reliably restart every render */
    guideAltDrawTick: false,
    /** Timeout id for stripping draw-* classes after completion */
    guideDrawTimerId: null,
    getValence:
      typeof options.getValence === "function" ? options.getValence : () => 0,
    getArousal:
      typeof options.getArousal === "function" ? options.getArousal : () => null,
  };
  bindDomElements(controller);

  return {
    render: function render() {
      renderController(controller);
    },
  };
}

export const ScoreVisualizationController = {
  create: createScoreVisualizationController,
};
