/**
 * SoundCloud-style timeline bars extracted from track content.
 * Bars are static per track (frequency-weighted intensity), while playback updates
 * highlighted progress across the strip.
 */

const DISPLAY_BARS = 320;
const SYNTH_BARS = 220;

let canvasEl = null;
let ctx2d = null;
let getAudioFn = () => /** @type {HTMLAudioElement | null} */ (null);
let barValues = null;
let rafId = 0;
let spectrumRunning = false;
let loadGeneration = 0;

function syncCanvasSize() {
  if (!canvasEl || !ctx2d) return;
  const dpr = globalThis.devicePixelRatio || 1;
  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w;
    canvasEl.height = h;
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawIdle() {
  if (!canvasEl || !ctx2d) return;
  syncCanvasSize();
  const w = canvasEl.getBoundingClientRect().width;
  const h = canvasEl.getBoundingClientRect().height;
  ctx2d.clearRect(0, 0, w, h);
  const baseY = h - 6;
  ctx2d.strokeStyle = "rgba(255,255,255,0.14)";
  ctx2d.lineWidth = 1;
  ctx2d.beginPath();
  ctx2d.moveTo(0, baseY);
  ctx2d.lineTo(w, baseY);
  ctx2d.stroke();
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function syntheticBarsFromUrl(url, n) {
  const out = new Float32Array(n);
  let state = hashString(url || "demo");
  for (let i = 0; i < n; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const t = i / Math.max(1, n - 1);
    const env = 0.4 + 0.6 * Math.sin(t * Math.PI);
    const noise = (state % 1000) / 1000;
    out[i] = Math.max(0.06, Math.min(1, env * (0.45 + noise * 0.75)));
  }
  return out;
}

function getTrackMonoSamples(buffer) {
  const ch0 = buffer.getChannelData(0);
  if (buffer.numberOfChannels < 2) return ch0;
  const ch1 = buffer.getChannelData(1);
  const n = Math.min(ch0.length, ch1.length);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    mono[i] = (ch0[i] + ch1[i]) * 0.5;
  }
  return mono;
}

/**
 * Frequency-weighted "tone intensity" per timeline bucket.
 * Uses both amplitude and sample-to-sample delta energy (high-frequency activity).
 */
function computeFrequencyWeightedBars(buffer, nBars) {
  const mono = getTrackMonoSamples(buffer);
  const out = new Float32Array(nBars);
  const hop = Math.max(64, Math.floor(mono.length / nBars));

  let globalMax = 0;
  for (let i = 0; i < nBars; i += 1) {
    const start = i * hop;
    const end = Math.min(mono.length, start + hop);
    if (end <= start + 1) {
      out[i] = 0.08;
      continue;
    }

    let sumAmp = 0;
    let sumDelta = 0;
    let prev = mono[start];
    for (let j = start + 1; j < end; j += 1) {
      const v = mono[j];
      sumAmp += Math.abs(v);
      sumDelta += Math.abs(v - prev);
      prev = v;
    }

    const len = end - start;
    const avgAmp = sumAmp / len;
    const avgDelta = sumDelta / len;
    // Delta gets a higher weight to emphasize tonal changes/frequency detail.
    const score = avgAmp * 0.55 + avgDelta * 1.45;
    out[i] = score;
    if (score > globalMax) globalMax = score;
  }

  const norm = globalMax > 0 ? 1 / globalMax : 1;
  for (let i = 0; i < nBars; i += 1) {
    const v = Math.pow(out[i] * norm, 0.85);
    out[i] = Math.max(0.06, Math.min(1, v));
  }
  return out;
}

function drawSpectrumFrame() {
  if (!canvasEl || !ctx2d) return;
  const audio = getAudioFn();
  syncCanvasSize();
  const w = canvasEl.getBoundingClientRect().width;
  const h = canvasEl.getBoundingClientRect().height;
  ctx2d.clearRect(0, 0, w, h);
  const values = barValues || syntheticBarsFromUrl("", SYNTH_BARS);

  const baseY = h - 6;
  const cap = h - 14;
  const n = values.length;
  const slot = w / Math.max(1, n);
  const barW = Math.max(1, slot * 0.78);
  const gap = slot - barW;

  const d = audio?.duration;
  const ct = audio?.currentTime;
  const progress =
    audio && Number.isFinite(d) && d > 0 && Number.isFinite(ct)
      ? Math.min(1, Math.max(0, ct / d))
      : 0;

  for (let i = 0; i < n; i += 1) {
    const amp = Math.max(2, values[i] * cap);
    const x = i * slot + gap * 0.5;
    const ratio = (i + 0.5) / n;
    ctx2d.fillStyle =
      ratio <= progress
        ? "rgba(255, 112, 34, 0.95)"
        : "rgba(245, 245, 245, 0.9)";
    ctx2d.fillRect(x, baseY - amp, barW, amp);
  }
}

function tick() {
  rafId = 0;
  if (!spectrumRunning) return;
  const audio = getAudioFn();
  if (!audio || audio.paused || audio.ended) {
    spectrumRunning = false;
    drawIdle();
    return;
  }
  drawSpectrumFrame();
  rafId = globalThis.requestAnimationFrame(tick);
}

/**
 * Kept for controller compatibility; no graph bootstrapping is required for
 * static timeline bars, but we keep this async hook for the play gesture flow.
 * @param {HTMLAudioElement} _audio
 */
export async function ensureSpectrumFromUserGesture(_audio) {
  return Promise.resolve();
}

export function startSpectrumRenderLoop() {
  if (!canvasEl) return;
  spectrumRunning = true;
  if (rafId) {
    globalThis.cancelAnimationFrame(rafId);
    rafId = 0;
  }
  rafId = globalThis.requestAnimationFrame(tick);
}

export function stopSpectrumRenderLoop() {
  spectrumRunning = false;
  if (rafId) {
    globalThis.cancelAnimationFrame(rafId);
    rafId = 0;
  }
  drawIdle();
}

/**
 * @param {HTMLCanvasElement | null} canvas
 * @param {() => HTMLAudioElement | null} getAudio
 */
export function attachWaveformCanvas(canvas, getAudio) {
  canvasEl = canvas;
  ctx2d = canvas ? canvas.getContext("2d") : null;
  getAudioFn = typeof getAudio === "function" ? getAudio : () => null;

  if (!canvasEl) return;

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      if (spectrumRunning) drawSpectrumFrame();
      else drawIdle();
    });
    ro.observe(canvasEl);
  }

  globalThis.addEventListener("resize", drawIdle, { passive: true });
  globalThis.addEventListener("orientationchange", drawIdle, { passive: true });
  drawIdle();
}

/**
 * Loads current track and extracts a timeline histogram from track content.
 * If cross-origin fetch/decode is unavailable, falls back to a deterministic pattern.
 * @param {string} url
 */
export async function loadWaveformFromUrl(url) {
  loadGeneration += 1;
  const gen = loadGeneration;
  barValues = syntheticBarsFromUrl(url, SYNTH_BARS);
  drawSpectrumFrame();
  if (!url) return;

  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw new Error("AudioContext not available");
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const arr = await res.arrayBuffer();
    const ctx = new AC();
    try {
      const buf = await ctx.decodeAudioData(arr.slice(0));
      if (gen !== loadGeneration) return;
      barValues = computeFrequencyWeightedBars(buf, DISPLAY_BARS);
      drawSpectrumFrame();
    } finally {
      await ctx.close().catch(() => {});
    }
  } catch {
    // Keep deterministic fallback bars when cross-origin decode is blocked.
    if (gen !== loadGeneration) return;
    drawSpectrumFrame();
  }
}

export function clearWaveform() {
  loadGeneration += 1;
  barValues = null;
  stopSpectrumRenderLoop();
  drawIdle();
}
