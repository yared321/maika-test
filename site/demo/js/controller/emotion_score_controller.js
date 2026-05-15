/**
 * Cache all DOM elements used by the step-5 emotion visualization UI.
 * This avoids repeated `querySelector` calls during each render cycle.
 * @param {object} controller
 */
function bindDomElements(controller) {
  controller.emotionMap = controller.root.querySelector("#emotion-map");
  controller.emotionMapPoint = controller.root.querySelector("#emotion-map-point");
  controller.emotionModeLayer = controller.root.querySelector("#emotion-mode-layer");
  controller.emotionConstellation = controller.root.querySelector("#emotion-constellation");
  controller.emotionConstellationLinks = controller.root.querySelector(
    "#emotion-constellation-links",
  );
  controller.emotionConstellationStars = controller.root.querySelector(
    "#emotion-constellation-stars",
  );
  controller.emotionGuideX = controller.root.querySelector("#emotion-guide-x");
  controller.emotionGuideY = controller.root.querySelector("#emotion-guide-y");
  controller.emotionPrimaryLabel = controller.root.querySelector("#emotion-primary-label");
  controller.emotionPrimaryValue = controller.root.querySelector("#emotion-primary-value");
  // controller.emotionPrimarySub = controller.root.querySelector("#emotion-primary-sub");
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
 * Return the simplified user-facing tone (emoji/title/text).
 * Rules:
 * - If both axes are close to center (|x| <= 20 and |y| <= 20), treat as neutral.
 * - If arousal is close to x-axis (|y| <= 20), ignore arousal and speak only by valence.
 * - Otherwise use quadrant-style messaging.
 * @param {number} valence
 * @param {number} arousal
 * @param {string} quadrant
 * @returns {{ emoji: string, title: string, text: string }}
 */
function getSimpleTone(valence, arousal, quadrant) {
  const CENTER_THRESHOLD = 20;
  const nearCenterValence = Math.abs(Number(valence)) <= CENTER_THRESHOLD;
  const nearCenterArousal = Math.abs(Number(arousal)) <= CENTER_THRESHOLD;

  if (nearCenterValence && nearCenterArousal) {
    return {
      emoji: "😐",
      title: "Neutral",
      text: "Both activation and positivity are close to neutral right now.",
    };
  }

  if (nearCenterArousal) {
    if (valence >= 0) {
      return {
        emoji: "🙂",
        title: "Positive",
        text: "Your feeling leans positive, while activation stays close to neutral.",
      };
    }
    return {
      emoji: "😕",
      title: "Negative",
      text: "Your feeling leans negative, while activation stays close to neutral.",
    };
  }

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
      title: "High energy and low mood",
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
 * Create an SVG element in the SVG namespace.
 * Uses document.createElementNS with the standard SVG namespace URI to ensure proper SVG element creation.
 * @param {string} tag - The SVG element tag name (e.g., 'line', 'circle').
 * @returns {SVGElement}
 */
function createSvgElement(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

/**
 * Draw SVG lines connecting the nearest emotion modes to form a constellation pattern,
 * including links between modes and from the primary mode to the current point.
 * @param {object} controller - The controller object containing DOM elements and positions.
 * @param {string[]} nearestLabels - Array of labels for the nearest emotion modes.
 * @param {number} mapLeft - The x-coordinate of the current point on the map.
 * @param {number} mapTop - The y-coordinate of the current point on the map.
 */
function drawConstellationLines(controller, nearestLabels, mapLeft, mapTop) {
  if (!controller.emotionConstellationLinks || !controller.emotionModePositions) return;
  controller.emotionConstellationLinks.innerHTML = "";

  const nearest = Array.isArray(nearestLabels) ? nearestLabels : [];
  if (!nearest.length) return;

  const linkPairs = [];
  if (nearest.length >= 2) linkPairs.push([nearest[0], nearest[1]]);
  if (nearest.length >= 3) linkPairs.push([nearest[1], nearest[2]]);

  linkPairs.forEach((pair, pairIndex) => {
    const a = controller.emotionModePositions.get(pair[0]);
    const b = controller.emotionModePositions.get(pair[1]);
    if (!a || !b) return;
    const line = createSvgElement("line");
    line.setAttribute("x1", a.mapLeft.toFixed(2));
    line.setAttribute("y1", a.mapTop.toFixed(2));
    line.setAttribute("x2", b.mapLeft.toFixed(2));
    line.setAttribute("y2", b.mapTop.toFixed(2));
    line.setAttribute(
      "class",
      "emotion-constellation-link" + (pairIndex === 0 ? " is-cluster-main" : " is-cluster"),
    );
    controller.emotionConstellationLinks.appendChild(line);
  });

  const primaryPos = controller.emotionModePositions.get(nearest[0]);
  if (!primaryPos) return;
  const toPoint = createSvgElement("line");
  toPoint.setAttribute("x1", primaryPos.mapLeft.toFixed(2));
  toPoint.setAttribute("y1", primaryPos.mapTop.toFixed(2));
  toPoint.setAttribute("x2", Number(mapLeft).toFixed(2));
  toPoint.setAttribute("y2", Number(mapTop).toFixed(2));
  toPoint.setAttribute("class", "emotion-constellation-link is-primary");
  controller.emotionConstellationLinks.appendChild(toPoint);
}

const EMOTION_MODE_POINTS = [
  { label: "Angry", valence: -25, arousal: 90 },
  { label: "Afraid", valence: -54, arousal: 72 },
  { label: "Stressed", valence: -67, arousal: 54 },
  { label: "Annoyed", valence: -24, arousal: 42 },
  { label: "Frustrated", valence: -55, arousal: 24 },
  { label: "Disappointed", valence: -75, arousal: 0 },
  { label: "Apathetic", valence: -56, arousal: -24 },
  { label: "Melancholic", valence: -24, arousal: -46 },
  { label: "Sad", valence: -58, arousal: -70 },
  { label: "Bored", valence: -30, arousal: -86 },
  { label: "Neutral", valence: 0, arousal: 0 },
  { label: "Aroused", valence: 32, arousal: 76 },
  { label: "Excited", valence: 65, arousal: 60 },
  { label: "Focused", valence: 40, arousal: 39 },
  { label: "Happy", valence: 72, arousal: 24 },
  { label: "Pleased", valence: 72, arousal: 0 },
  { label: "Content", valence: 56, arousal: -30 },
  { label: "Relaxed", valence: 62, arousal: -60 },
  { label: "Calm", valence: 36, arousal: -84 },
];

/**
 * Find the nearest emotion modes to the given valence and arousal scores
 * by calculating Euclidean distance and returning the top N labels.
 * @param {number} valence - The valence score.
 * @param {number} arousal - The arousal score.
 * @param {number} count - The number of nearest modes to return.
 * @returns {string[]} Array of emotion mode labels sorted by proximity.
 */
function getNearestEmotionModes(valence, arousal, count) {
  return EMOTION_MODE_POINTS
    .map((m) => {
      const dx = valence - m.valence;
      const dy = arousal - m.arousal;
      return {
        label: m.label,
        dist2: dx * dx + dy * dy,
      };
    })
    .sort((a, b) => a.dist2 - b.dist2)
    .slice(0, Math.max(1, count))
    .map((m) => m.label);
}

/**
 * Initialize the emotion mode layer by creating DOM elements and SVG stars
 * for each predefined emotion mode point on the map.
 * @param {object} controller - The controller object to initialize.
 */
function initEmotionModeLayer(controller) {
  if (!controller.emotionModeLayer) return;
  controller.emotionModeLayer.innerHTML = "";
  if (controller.emotionConstellationStars) {
    controller.emotionConstellationStars.innerHTML = "";
  }
  if (controller.emotionConstellationLinks) {
    controller.emotionConstellationLinks.innerHTML = "";
  }
  controller.emotionModeEls = new Map();
  controller.emotionModeStars = new Map();
  controller.emotionModePositions = new Map();

  for (const mode of EMOTION_MODE_POINTS) {
    const pos = computeMapPosition(mode.valence, mode.arousal);
    controller.emotionModePositions.set(mode.label, pos);

    const el = document.createElement("span");
    el.className = "emotion-mode-tag";
    el.textContent = mode.label;
    el.style.left = `${pos.mapLeft.toFixed(2)}%`;
    el.style.top = `${pos.mapTop.toFixed(2)}%`;
    controller.emotionModeLayer.appendChild(el);
    controller.emotionModeEls.set(mode.label, el);

    if (controller.emotionConstellationStars) {
      const star = createSvgElement("circle");
      star.setAttribute("cx", pos.mapLeft.toFixed(2));
      star.setAttribute("cy", pos.mapTop.toFixed(2));
      star.setAttribute("r", "0.72");
      star.setAttribute("class", "emotion-constellation-star");
      controller.emotionConstellationStars.appendChild(star);
      controller.emotionModeStars.set(mode.label, star);
    }
  }
}

/**
 * Set the active state for emotion mode elements and stars based on the nearest modes
 * to the current valence and arousal scores, and draw constellation lines if positions are valid.
 * @param {object} controller - The controller object containing mode elements.
 * @param {number} valence - The valence score.
 * @param {number} arousal - The arousal score.
 * @param {number} mapLeft - The x-coordinate of the current point.
 * @param {number} mapTop - The y-coordinate of the current point.
 */
function setActiveEmotionModes(controller, valence, arousal, mapLeft, mapTop) {
  if (!controller.emotionModeEls) return;
  const nearest = getNearestEmotionModes(valence, arousal, 3);
  const nearestSet = new Set(nearest);

  for (const [label, el] of controller.emotionModeEls.entries()) {
    // Keep all mode tags visible for alignment tuning.
    const isActive = nearestSet.has(label);
    el.classList.toggle("is-active", isActive);
    el.classList.toggle("is-primary", nearest[0] === label);
  }

  if (controller.emotionModeStars) {
    for (const [label, star] of controller.emotionModeStars.entries()) {
      const isActive = nearestSet.has(label);
      star.classList.toggle("is-active", isActive);
      star.classList.toggle("is-primary", nearest[0] === label);
    }
  }

  if (Number.isFinite(mapLeft) && Number.isFinite(mapTop)) {
    drawConstellationLines(controller, nearest, mapLeft, mapTop);
  }
}

/**
 * Clear the active state from all emotion mode elements, stars, and remove constellation lines.
 * @param {object} controller - The controller object containing mode elements.
 */
function clearActiveEmotionModes(controller) {
  if (controller.emotionModeEls) {
    for (const el of controller.emotionModeEls.values()) {
      el.classList.remove("is-active", "is-primary");
    }
  }
  if (controller.emotionModeStars) {
    for (const star of controller.emotionModeStars.values()) {
      star.classList.remove("is-active", "is-primary");
    }
  }
  if (controller.emotionConstellationLinks) {
    controller.emotionConstellationLinks.innerHTML = "";
  }
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
}

/**
 * Update the simplified emotion summary and both compact progress meters.
 * @param {object} controller
 * @param {number} valence
 * @param {number} arousal
 * @param {string} quadrant
 */
function updateSimpleSummaryAndMeters(controller, valence, arousal, quadrant) {
  const simpleTone = getSimpleTone(valence, arousal, quadrant);
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
  setActiveEmotionModes(controller, valence, arousal, mapLeft, mapTop);
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
  // if (controller.emotionPrimarySub) {
  //   controller.emotionPrimarySub.textContent =
  //     "No backend arousal available yet. Complete the face scan and calculate score first.";
  // }
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
  clearActiveEmotionModes(controller);
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
  initEmotionModeLayer(controller);

  return {
    render: function render() {
      renderController(controller);
    },
  };
}

export const ScoreVisualizationController = {
  create: createScoreVisualizationController,
};
