const SCAN_INTRO_ID = "scan-intro";
const SCAN_INTRO_INSTRUCTIONS_ID = "scan-intro-instructions";

/**
 * @param {HTMLElement | null} panel
 */
function showValencePanel(panel) {
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.setAttribute("aria-hidden", "false");
}

/**
 * @param {HTMLElement | null} panel
 */
function hideValencePanel(panel) {
  if (!panel) return;
  panel.classList.add("hidden");
  panel.setAttribute("aria-hidden", "true");
}

/**
 * Post-music scan: show valence inside "What to do" (after countdown completes).
 * @param {Record<string, HTMLElement|null>} dom
 */
export function placeValenceInScanIntro(dom) {
  const intro = document.getElementById(SCAN_INTRO_ID);
  const instructions = document.getElementById(SCAN_INTRO_INSTRUCTIONS_ID);
  const panel = dom.valenceCard;
  if (!intro || !panel) return;

  intro.classList.add("scan-intro--with-valence");
  panel.classList.add("valence-card--in-scan-intro");
  instructions?.classList.add("hidden");
  instructions?.setAttribute("aria-hidden", "true");
  showValencePanel(panel);
}

/**
 * Hide valence and restore instruction list (start of scan / record again).
 * @param {Record<string, HTMLElement|null>} dom
 */
export function resetValencePlacementForScan(dom) {
  const intro = document.getElementById(SCAN_INTRO_ID);
  const instructions = document.getElementById(SCAN_INTRO_INSTRUCTIONS_ID);
  const panel = dom.valenceCard;
  if (!intro || !panel) return;

  intro.classList.remove("scan-intro--with-valence");
  panel.classList.remove("valence-card--in-scan-intro");
  instructions?.classList.remove("hidden");
  instructions?.setAttribute("aria-hidden", "false");
  hideValencePanel(panel);
}
