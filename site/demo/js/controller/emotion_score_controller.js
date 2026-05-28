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
  controller.emotionModeAnchors = controller.root.querySelector("#emotion-mode-anchors");
  controller.emotionConstellationCluster = controller.root.querySelector(
    "#emotion-constellation-cluster",
  );
  controller.emotionGuideX = controller.root.querySelector("#emotion-guide-x");
  controller.emotionGuideY = controller.root.querySelector("#emotion-guide-y");
  controller.emotionPrimaryLabel = controller.root.querySelector("#emotion-primary-label");
  controller.emotionPrimaryValue = controller.root.querySelector("#emotion-primary-value");
  controller.emotionBaselineArousalLabel = controller.root.querySelector(
    "#emotion-baseline-arousal-label",
  );
  controller.emotionPostArousalLabel = controller.root.querySelector(
    "#emotion-post-arousal-label",
  );
  controller.emotionBaselineArousalFill = controller.root.querySelector(
    "#emotion-baseline-arousal-fill",
  );
  controller.emotionPostArousalFill = controller.root.querySelector(
    "#emotion-post-arousal-fill",
  );
  controller.emotionArousalDeltaHint = controller.root.querySelector(
    "#emotion-arousal-delta-hint",
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
 * Build a regular star polygon in map viewBox coordinates (0–100).
 * @param {number} cx
 * @param {number} cy
 * @param {number} outerR
 * @param {number} innerR
 * @param {number} [points]
 * @returns {string}
 */
function computeStarPoints(cx, cy, outerR, innerR, points = 5) {
  const coords = [];
  const step = Math.PI / points;
  let angle = -Math.PI / 2;
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outerR : innerR;
    coords.push(
      (cx + radius * Math.cos(angle)).toFixed(3) +
        "," +
        (cy + radius * Math.sin(angle)).toFixed(3),
    );
    angle += step;
  }
  return coords.join(" ");
}

/**
 * @param {number} cx
 * @param {number} cy
 * @param {{ outerR?: number, innerR?: number, className?: string, label?: string, points?: number }} options
 * @returns {SVGPolygonElement}
 */
function createMapStar(cx, cy, options = {}) {
  const outerR = options.outerR ?? 0.72;
  const innerR = options.innerR ?? outerR * 0.42;
  const star = createSvgElement("polygon");
  star.setAttribute(
    "points",
    computeStarPoints(cx, cy, outerR, innerR, options.points ?? 5),
  );
  star.setAttribute("class", options.className ?? "emotion-map-star");
  if (options.label) star.setAttribute("data-emotion", options.label);
  return star;
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
  if (nearest.length >= 3) {
    linkPairs.push([nearest[1], nearest[2]]);
    linkPairs.push([nearest[0], nearest[2]]);
  }

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
function showConstellationLayer(controller) {
  controller.emotionConstellation?.removeAttribute("hidden");
}

function renderEmotionModeAnchorStars(controller) {
  if (!controller.emotionModeAnchors) return;
  controller.emotionModeAnchors.innerHTML = "";

  for (const mode of EMOTION_MODE_POINTS) {
    const pos = computeMapPosition(mode.valence, mode.arousal);
    const star = createMapStar(pos.mapLeft, pos.mapTop, {
      outerR: 0.72,
      innerR: 0.3,
      className: "emotion-mode-anchor-star",
      label: mode.label,
    });
    controller.emotionModeAnchors.appendChild(star);
  }
}

function initEmotionModeLayer(controller) {
  showConstellationLayer(controller);
  clearActiveEmotionModes(controller);
  controller.emotionModePositions = new Map();

  for (const mode of EMOTION_MODE_POINTS) {
    controller.emotionModePositions.set(
      mode.label,
      computeMapPosition(mode.valence, mode.arousal),
    );
  }

  renderEmotionModeAnchorStars(controller);
}

/**
 * Render constellation stars and labels for the nearest emotion modes only.
 * @param {object} controller
 * @param {string[]} nearest
 */
function setClusterFloating(controller, enabled) {
  controller.emotionConstellationCluster?.classList.toggle("is-floating", enabled);
  controller.emotionModeLayer?.classList.toggle("is-floating", enabled);
}

function renderNearestEmotionMarkers(controller, nearest) {
  const hasCluster = Array.isArray(nearest) && nearest.length > 0;
  setClusterFloating(controller, hasCluster);

  if (controller.emotionConstellationStars) {
    controller.emotionConstellationStars.innerHTML = "";
    for (const label of nearest) {
      const pos = controller.emotionModePositions.get(label);
      if (!pos) continue;
      const isPrimary = label === nearest[0];
      const star = createMapStar(pos.mapLeft, pos.mapTop, {
        outerR: 0.72,
        innerR: 0.3,
        className:
          "emotion-constellation-star is-active" + (isPrimary ? " is-primary" : ""),
        label: label,
      });
      controller.emotionConstellationStars.appendChild(star);
    }
  }

  if (controller.emotionModeLayer) {
    controller.emotionModeLayer.innerHTML = "";
    controller.emotionModeLayer.removeAttribute("hidden");
    for (const label of nearest) {
      const pos = controller.emotionModePositions.get(label);
      if (!pos) continue;
      const el = document.createElement("span");
      el.className = "emotion-mode-tag is-active";
      if (label === nearest[0]) {
        el.classList.add("is-primary");
      }
      el.textContent = label;
      el.style.left = `${pos.mapLeft.toFixed(2)}%`;
      el.style.top = `${pos.mapTop.toFixed(2)}%`;
      controller.emotionModeLayer.appendChild(el);
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
  const nearest = getNearestEmotionModes(valence, arousal, 3);
  renderNearestEmotionMarkers(controller, nearest);

  if (Number.isFinite(mapLeft) && Number.isFinite(mapTop)) {
    drawConstellationLines(controller, nearest, mapLeft, mapTop);
  }
}

/**
 * Clear the active state from all emotion mode elements, stars, and remove constellation lines.
 * @param {object} controller - The controller object containing mode elements.
 */
function clearActiveEmotionModes(controller) {
  setClusterFloating(controller, false);
  if (controller.emotionModeLayer) {
    controller.emotionModeLayer.innerHTML = "";
  }
  if (controller.emotionConstellationStars) {
    controller.emotionConstellationStars.innerHTML = "";
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
  if (controller.guidesDrawn) return;
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

      controller.guidesDrawn = true;
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

/** Update the primary focus/relax score card above the map. */
function updateArousalSummary(controller, arousal) {
  const primaryLabel = arousal >= 0 ? "Focus score" : "Relax score";
  const primaryMagnitude = Math.abs(arousal);
  if (controller.emotionPrimaryLabel) controller.emotionPrimaryLabel.textContent = primaryLabel;
  if (controller.emotionPrimaryValue) {
    controller.emotionPrimaryValue.textContent = primaryMagnitude.toFixed(1) + "%";
  }
}

/**
 * Update baseline vs post face-scan comparison bars and delta copy.
 * @param {object} controller
 */
function updateBeforeAfterComparison(controller) {
  const baselineRaw = Number(controller.getBaselineArousal());
  const postRaw = Number(controller.getPostArousal());
  const hasBaseline = Number.isFinite(baselineRaw);
  const hasPost = Number.isFinite(postRaw);
  const baseline = hasBaseline ? clampPercent(baselineRaw) : null;
  const post = hasPost ? clampPercent(postRaw) : null;

  if (controller.emotionBaselineArousalLabel) {
    controller.emotionBaselineArousalLabel.textContent =
      baseline == null ? "—" : signedPercent(baseline, 1);
  }
  if (controller.emotionPostArousalLabel) {
    controller.emotionPostArousalLabel.textContent =
      post == null ? "—" : signedPercent(post, 1);
  }
  if (controller.emotionBaselineArousalFill) {
    controller.emotionBaselineArousalFill.style.width =
      baseline == null ? "0%" : Math.abs(baseline).toFixed(1) + "%";
  }
  if (controller.emotionPostArousalFill) {
    controller.emotionPostArousalFill.style.width =
      post == null ? "0%" : Math.abs(post).toFixed(1) + "%";
  }

  if (baseline == null || post == null) {
    if (controller.emotionArousalDeltaHint) {
      controller.emotionArousalDeltaHint.textContent =
        "Complete both face scans to see baseline vs after-music change.";
    }
    return;
  }

  const delta = post - baseline;
  if (controller.emotionArousalDeltaHint) {
    if (Math.abs(delta) < 1) {
      controller.emotionArousalDeltaHint.textContent =
        "Your activation level stayed almost unchanged after music.";
    } else if (delta > 0) {
      controller.emotionArousalDeltaHint.textContent =
        "Your after-music face scan shows higher activation than baseline.";
    } else {
      controller.emotionArousalDeltaHint.textContent =
        "Your after-music face scan shows lower activation than baseline.";
    }
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
  updateBeforeAfterComparison(controller);
}

/**
 * Render full emotion-map state when both valence and arousal are available.
 * @param {object} controller
 * @param {number} valence
 * @param {number} arousal
 */
function renderWithArousal(controller, valence, arousal) {
  const mapPos = computeMapPosition(valence, arousal);
  const mapLeft = mapPos.mapLeft;
  const mapTop = mapPos.mapTop;
  const qTheme = arousal >= 0
    ? (valence >= 0 ? "q1" : "q2")
    : (valence >= 0 ? "q4" : "q3");

  updateArousalSummary(controller, arousal);
  updateMapAndGuides(controller, valence, arousal, mapLeft, mapTop);
  scheduleGuideAnimations(controller);
  setMapQuadrantTheme(controller, qTheme);
  updateBeforeAfterComparison(controller);
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
    /** Run axis guide draw animation only once per results view */
    guidesDrawn: false,
    getValence:
      typeof options.getValence === "function" ? options.getValence : () => 0,
    getArousal:
      typeof options.getArousal === "function" ? options.getArousal : () => null,
    getBaselineArousal:
      typeof options.getBaselineArousal === "function"
        ? options.getBaselineArousal
        : () => null,
    getPostArousal:
      typeof options.getPostArousal === "function" ? options.getPostArousal : () => null,
  };
  bindDomElements(controller);
  initEmotionModeLayer(controller);

  return {
    render: function render() {
      renderController(controller);
    },
    reset: function reset() {
      controller.guidesDrawn = false;
      if (controller.guideDrawTimerId != null) {
        globalThis.clearTimeout(controller.guideDrawTimerId);
        controller.guideDrawTimerId = null;
      }
      controller.emotionGuideX?.classList.remove("animate-draw", "animate-draw-replay");
      controller.emotionGuideY?.classList.remove("animate-draw", "animate-draw-replay");
    },
  };
}

export const ScoreVisualizationController = {
  create: createScoreVisualizationController,
};
