/**
 * Demo music list + playback wiring.
 *
 * Flow: demo.js imports `fetchMusicData` → runs once at startup → fills
 * #music-select, binds one change handler, attaches one audio control listener set.
 *
 * Emits `maika-demo:music-ended` on `document` when a track finishes (wizard can listen).
 */
import {
  attachWaveformCanvas,
  clearWaveform,
  ensureSpectrumFromUserGesture,
  loadWaveformFromUrl,
  startSpectrumRenderLoop,
  stopSpectrumRenderLoop,
} from "./music_waveform_renderer.js";

export const MUSIC_ENDED_EVENT = "maika-demo:music-ended";
export const MUSIC_PROGRESS_EVENT = "maika-demo:music-progress";

let musicData = [];
let controlsBound = false;
let selectBound = false;
let selectionLocked = false;
let activeFadeRaf = 0;
/** Bumps when session resets so in-flight autoplay attempts are ignored. */
let autoplayGeneration = 0;
/** Resolves the Promise from the current `stopMusicPlayback` fade (if any). */
let activeFadeResolve = null;

function clearActiveFade() {
  if (!activeFadeRaf) return;
  globalThis.cancelAnimationFrame(activeFadeRaf);
  activeFadeRaf = 0;
}

/** Cancel an in-progress volume fade and restore volumes from #volume-slider. */
export function interruptMusicFadeOut() {
  clearActiveFade();
  if (typeof activeFadeResolve === "function") {
    const finish = activeFadeResolve;
    activeFadeResolve = null;
    finish();
  }
  const audio = getMainAudio();
  const fallback = document.getElementById("audio-player");
  const volumeSlider = document.getElementById("volume-slider");
  const v = volumeSlider ? Number(volumeSlider.value) || 0 : 1;
  if (audio && Number.isFinite(audio.volume)) audio.volume = v;
  if (fallback && Number.isFinite(fallback.volume)) fallback.volume = v;
}

/** Cached #music-select in the wizard. */
function getSelect() {
  return document.getElementById("music-select");
}

/** Main audio element driven by custom controls (`#main-audio`). */
function getMainAudio() {
  return document.getElementById("main-audio");
}

function getMusicDeck() {
  return document.getElementById("music-player-deck");
}

function setDeckPlaying(isPlaying) {
  const deck = getMusicDeck();
  if (!deck) return;
  deck.classList.toggle("is-playing", Boolean(isPlaying));
}

function setPlayButtonAppearance(glyph, ariaLabel) {
  const playBtn = document.getElementById("play-pause-btn");
  const playGlyph = document.getElementById("play-pause-glyph");
  if (playGlyph) playGlyph.textContent = glyph;
  else if (playBtn) playBtn.textContent = glyph;
  if (playBtn && ariaLabel) playBtn.setAttribute("aria-label", ariaLabel);
}

function setWavePanelLoading(on) {
  const el = document.getElementById("music-wave-loading");
  if (!el) return;
  el.hidden = !on;
  el.setAttribute("aria-busy", on ? "true" : "false");
}

/** Escapes plain text for safe insertion into HTML (option labels). */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

/**
 * Writes 0–100 into --range-fill so the track shows “elapsed” vs “remaining” /
 * loud vs quiet distinctly (paired with demo.css gradients).
 */
function setRangeFillPercent(rangeEl, percent) {
  if (!rangeEl) return;
  const p = Math.min(100, Math.max(0, percent));
  rangeEl.style.setProperty("--range-fill", `${p}%`);
}

/** Rebuilds dropdown options from `musicData` (replace, never append). Preserves a valid selection. */
function populateMusicSelect() {
  const select = getSelect();
  if (!select || !Array.isArray(musicData)) return;

  const preservedValue = select.value;

  let optionsMarkup = "";
  for (let i = 0; i < musicData.length; i += 1) {
    const song = musicData[i];
    optionsMarkup += `<option value="${i}">${escapeHtml(formatTrackOptionLabel(song))}</option>`;
  }

  select.innerHTML =
    '<option value="">— Choose a track —</option>' + optionsMarkup;

  if (preservedValue !== "" && musicData[Number(preservedValue)]) {
    select.value = preservedValue;
  }
}

/** Formats seconds as M:SS for the HUD. */
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${min}:${sec < 10 ? "0" : ""}${sec}`;
}

function normalizeGenres(song) {
  if (!song) return [];
  const raw = song.genres ?? song.genre;
  if (Array.isArray(raw)) {
    return raw.map((g) => String(g || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

/** Dropdown label: title plus genre(s) in brackets when present. */
function formatTrackOptionLabel(song) {
  const title = typeof song?.title === "string" ? song.title : "";
  const genres = normalizeGenres(song);
  if (!genres.length) return title;
  return `${title} (${genres.join(", ")})`;
}

/**
 * Turns optional `image` from music.json into a browser URL (absolute https, site-root
 * `/demo/...`, or legacy `site/demo/...` paths from the repo layout).
 */
function resolveTrackImageUrl(song) {
  const raw = song?.image;
  if (!raw || typeof raw !== "string") return "";
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("/")) return t;
  if (t.startsWith("site/")) return `/${t.slice("site/".length)}`;
  try {
    const base = new URL("../../data/music.json", import.meta.url).href;
    return new URL(t, base).href;
  } catch {
    return "";
  }
}

function getMusicArtSlot() {
  return document.getElementById("music-art-slot");
}

function clearCoverArt() {
  const img = document.getElementById("music-cover-art");
  const wrap = document.getElementById("music-cover-wrap");
  const slot = getMusicArtSlot();
  if (img) {
    img.onerror = null;
    img.hidden = true;
    img.removeAttribute("src");
    img.alt = "";
  }
  if (wrap) {
    wrap.classList.add("music-player__cover-wrap--empty");
    wrap.setAttribute("aria-hidden", "true");
  }
  slot?.classList.remove("is-showing-cover");
}

/** Preload cover for the selected track; shown in the art slot only after playback starts. */
function stageCoverArt(song) {
  const img = document.getElementById("music-cover-art");
  const wrap = document.getElementById("music-cover-wrap");
  const slot = getMusicArtSlot();
  if (!img || !wrap) return;

  slot?.classList.remove("is-showing-cover");
  const url = resolveTrackImageUrl(song);
  if (!url) {
    clearCoverArt();
    return;
  }

  wrap.classList.remove("music-player__cover-wrap--empty");
  wrap.setAttribute("aria-hidden", "true");
  img.alt = song?.title ? `Cover art for ${song.title}` : "";
  img.hidden = true;
  img.onerror = () => {
    img.onerror = null;
    clearCoverArt();
  };
  img.src = url;
}

function revealCoverArtInSlot() {
  const img = document.getElementById("music-cover-art");
  const wrap = document.getElementById("music-cover-wrap");
  const slot = getMusicArtSlot();
  if (!img || !wrap || !slot) return;
  if (wrap.classList.contains("music-player__cover-wrap--empty") || !img.getAttribute("src")) {
    return;
  }

  img.hidden = false;
  wrap.setAttribute("aria-hidden", "false");
  slot.classList.add("is-showing-cover");
}

/** Updates visible title row for the picked track. */
function updateNowPlaying(song) {
  const titleEl = document.getElementById("title");
  const artistEl = document.getElementById("artist");
  const genresEl = document.getElementById("genre-tags");
  if (titleEl) titleEl.textContent = song.title;
  if (artistEl) {
    const artist = typeof song?.artist === "string" ? song.artist.trim() : "";
    artistEl.textContent = artist;
    artistEl.hidden = !artist;
  }
  if (genresEl) {
    const genres = normalizeGenres(song);
    if (genres.length > 0) {
      genresEl.innerHTML = genres
        .map((genre) => `<span class="music-player__genre-chip">${escapeHtml(genre)}</span>`)
        .join("");
      genresEl.hidden = false;
    } else {
      genresEl.innerHTML = "";
      genresEl.hidden = true;
    }
  }
  stageCoverArt(song);
}

/**
 * Hooks play-only controls — once only.
 * Bails early if markup is incomplete; does not toggle `controlsBound` on failure so a later retry is possible.
 */
function bindAudioControlsOnce() {
  if (controlsBound) return;

  const audio = getMainAudio();
  const playBtn = document.getElementById("play-pause-btn");
  const prevBtn = document.getElementById("prev-btn");
  const rewindBtn = document.getElementById("rewind-btn");
  const forwardBtn = document.getElementById("forward-btn");
  const nextBtn = document.getElementById("next-btn");
  const progressBar = document.getElementById("progress-bar");
  const currentTimeEl = document.getElementById("current-time");
  const volumeSlider = document.getElementById("volume-slider");

  if (
    !audio ||
    !playBtn ||
    !rewindBtn ||
    !forwardBtn ||
    !progressBar ||
    !currentTimeEl ||
    !volumeSlider
  ) {
    return;
  }

  controlsBound = true;

  // Restrict controls to "play only" flow.
  if (prevBtn) prevBtn.hidden = true;
  if (nextBtn) nextBtn.hidden = true;
  if (rewindBtn) rewindBtn.hidden = true;
  if (forwardBtn) forwardBtn.hidden = true;
  rewindBtn.disabled = true;
  forwardBtn.disabled = true;
  progressBar.disabled = true;
  setPlayButtonAppearance("▶", "Play selected track");
  playBtn.disabled = true;

  playBtn.addEventListener("click", () => {
    if (getSelect().value === "" || !audio.paused) return;
    setPlayButtonAppearance("⏳", "Starting playback");
    playBtn.disabled = true;
    void (async () => {
      try {
        await ensureSpectrumFromUserGesture(audio);
        startSpectrumRenderLoop();
        await audio.play();
      } catch {
        setPlayButtonAppearance("▶", "Play selected track");
        playBtn.disabled = false;
        setDeckPlaying(false);
        stopSpectrumRenderLoop();
      }
    })();
  });

  audio.addEventListener("play", () => {
    setDeckPlaying(true);
    setPlayButtonAppearance("♪", "Playing");
    playBtn.disabled = true;
    revealCoverArtInSlot();
    startSpectrumRenderLoop();
  });

  audio.addEventListener("pause", () => {
    stopSpectrumRenderLoop();
    setDeckPlaying(false);
  });

  audio.addEventListener("ended", () => {
    setPlayButtonAppearance("▶", "Play");
    playBtn.disabled = false;
    setDeckPlaying(false);
    stopSpectrumRenderLoop();
    setRangeFillPercent(progressBar, 0);
    progressBar.value = "0";
    currentTimeEl.textContent = "0:00";
    document.dispatchEvent(
      new CustomEvent(MUSIC_ENDED_EVENT, { bubbles: true }),
    );
  });

  audio.addEventListener("timeupdate", () => {
    const d = audio.duration;
    const progress =
      Number.isFinite(d) && d > 0 ? (audio.currentTime / d) * 100 : 0;
    progressBar.value = String(progress || 0);
    setRangeFillPercent(progressBar, progress);
    currentTimeEl.textContent = formatTime(audio.currentTime);
    document.dispatchEvent(
      new CustomEvent(MUSIC_PROGRESS_EVENT, {
        bubbles: true,
        detail: {
          currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          duration: Number.isFinite(audio.duration) ? audio.duration : 0,
        },
      }),
    );
  });

  // Keep seek interaction code for future use, but disable dragging for now.
  // progressBar.addEventListener("input", () => {
  //   const d = audio.duration;
  //   const pct = Number(progressBar.value);
  //   setRangeFillPercent(progressBar, pct);
  //   if (!Number.isFinite(d) || d <= 0) return;
  //   audio.currentTime = (pct / 100) * d;
  // });

  // Keep skip controls code for future use, but disable/hide these controls for now.
  // rewindBtn.addEventListener("click", () => {
  //   audio.currentTime = Math.max(0, audio.currentTime - 10);
  // });
  // forwardBtn.addEventListener("click", () => {
  //   const d = audio.duration;
  //   if (Number.isFinite(d) && d > 0) {
  //     audio.currentTime = Math.min(d, audio.currentTime + 10);
  //   } else {
  //     audio.currentTime += 10;
  //   }
  // });

  audio.volume = Number(volumeSlider.value) || 0;
  setRangeFillPercent(volumeSlider, (Number(volumeSlider.value) || 0) * 100);
  volumeSlider.addEventListener("input", () => {
    audio.volume = Number(volumeSlider.value);
    setRangeFillPercent(volumeSlider, (Number(volumeSlider.value) || 0) * 100);
  });
}

/**
 * Applies URL + resets HUD after #music-select change; empty selection clears playback.
 */
function onMusicSelectChange() {
  const select = getSelect();
  const audio = getMainAudio();
  const fallback = document.getElementById("audio-player");
  const playBtn = document.getElementById("play-pause-btn");
  const progressBar = document.getElementById("progress-bar");
  const currentTimeEl = document.getElementById("current-time");

  if (!select || !audio) return;

  const idx = select.value;

  if (idx === "") {
    if (selectionLocked) {
      return;
    }
    audio.pause();
    audio.removeAttribute("src");
    if (fallback) {
      fallback.pause();
      fallback.removeAttribute("src");
    }
    if (progressBar) {
      progressBar.value = "0";
      setRangeFillPercent(progressBar, 0);
    }
    if (currentTimeEl) currentTimeEl.textContent = "0:00";
    if (playBtn) playBtn.disabled = true;
    setPlayButtonAppearance("▶", "Play selected track");
    setDeckPlaying(false);
    setWavePanelLoading(false);
    clearWaveform();
    clearCoverArt();
    return;
  }

  const song = musicData[Number(idx)];
  if (!song?.url) return;

  if (!selectionLocked) {
    selectionLocked = true;
    select.disabled = true;
  }

  audio.pause();
  if (playBtn) {
    setPlayButtonAppearance("▶", "Play selected track");
    playBtn.disabled = true;
  }
  setWavePanelLoading(true);
  audio.src = song.url;
  audio.preload = "auto";
  audio.load();
  if (fallback) {
    fallback.src = song.url;
    fallback.preload = "auto";
    fallback.load();
  }

  if (progressBar) {
    progressBar.value = "0";
    setRangeFillPercent(progressBar, 0);
  }
  if (currentTimeEl) currentTimeEl.textContent = "0:00";

  updateNowPlaying(song);
  void loadWaveformFromUrl(song.url);

  const markPlayable = () => {
    if (playBtn && getSelect().value !== "") {
      setPlayButtonAppearance("▶", "Play selected track");
      playBtn.disabled = false;
    }
    setWavePanelLoading(false);
  };

  const markFailed = () => {
    if (playBtn && getSelect().value !== "") {
      setPlayButtonAppearance("⚠", "Unable to load track");
      playBtn.disabled = true;
    }
    setWavePanelLoading(false);
    clearWaveform();
  };

  audio.addEventListener("canplay", markPlayable, { once: true });
  audio.addEventListener("loadeddata", markPlayable, { once: true });
  audio.addEventListener("error", markFailed, { once: true });
}

/** Registers a single listener on #music-select. */
function bindMusicSelectOnce() {
  const select = getSelect();
  if (!select || selectBound) return;
  selectBound = true;
  select.addEventListener("change", onMusicSelectChange);
}

/**
 * Loads `data/music.json` next to this module and initializes the picker + player.
 */
export async function fetchMusicData() {
  try {
    const jsonUrl = new URL("../../data/music.json", import.meta.url);
    const response = await fetch(jsonUrl.href);
    const data = await response.json();
    musicData = Array.isArray(data) ? data : [];
    populateMusicSelect();
    bindMusicSelectOnce();
    bindAudioControlsOnce();
    const wf = document.getElementById("music-waveform-canvas");
    if (wf) attachWaveformCanvas(wf, getMainAudio);
    const pb = document.getElementById("progress-bar");
    const vs = document.getElementById("volume-slider");
    setRangeFillPercent(pb, pb ? Number(pb.value) || 0 : 0);
    setRangeFillPercent(vs, vs ? (Number(vs.value) || 0) * 100 : 100);
  } catch (_error) {
    musicData = [];
    populateMusicSelect();
  }
}

export function stopMusicPlayback(options = {}) {
  const audio = getMainAudio();
  const fallback = document.getElementById("audio-player");
  const playBtn = document.getElementById("play-pause-btn");

  const stopNow = () => {
    clearActiveFade();
    activeFadeResolve = null;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    if (fallback) {
      fallback.pause();
      fallback.currentTime = 0;
    }
    if (playBtn) {
      setPlayButtonAppearance("▶", "Play");
    }
    setDeckPlaying(false);
    stopSpectrumRenderLoop();
  };

  const fadeOutMs = Math.max(0, Number(options.fadeOutMs) || 0);
  const fadeTargets = [audio, fallback]
    .filter(
      (el) =>
        el &&
        !el.paused &&
        Number.isFinite(el.volume) &&
        el.volume > 0,
    )
    .map((el) => ({ el, startVolume: el.volume }));

  if (fadeOutMs === 0 || fadeTargets.length === 0) {
    stopNow();
    return Promise.resolve();
  }

  clearActiveFade();
  const startAt = globalThis.performance.now();

  return new Promise((resolve) => {
    const restoreVolumes = () => {
      for (const target of fadeTargets) {
        target.el.volume = target.startVolume;
      }
    };

    const finishFade = () => {
      activeFadeResolve = null;
      stopNow();
      restoreVolumes();
      resolve();
    };

    activeFadeResolve = finishFade;

    const tick = (now) => {
      const allPaused = fadeTargets.every((target) => target.el.paused);
      if (allPaused) {
        finishFade();
        return;
      }

      const elapsed = Math.max(0, now - startAt);
      const progress = Math.min(1, elapsed / fadeOutMs);
      // Ease-in curve keeps the first half gentler and avoids an abrupt-feeling drop.
      const easedProgress = progress * progress;
      for (const target of fadeTargets) {
        target.el.volume = Math.max(0, target.startVolume * (1 - easedProgress));
      }

      if (progress >= 1) {
        finishFade();
        return;
      }
      activeFadeRaf = globalThis.requestAnimationFrame(tick);
    };

    activeFadeRaf = globalThis.requestAnimationFrame(tick);
  });
}

/**
 * Full demo reset: unlock track picker, clear sources, HUD, and “now playing” labels.
 * Call when returning to landing (e.g. wizard Done) so the next run starts clean.
 */
/**
 * Load a track by catalog index (used by guided auto-play; #music-select may be hidden).
 * @param {number} index
 * @returns {boolean}
 */
export function selectMusicTrackByIndex(index) {
  const select = getSelect();
  if (!select || !musicData[Number(index)]) return false;
  select.value = String(index);
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Picks a random catalog track and loads it into the player. */
export function selectRandomMusicTrack() {
  if (!musicData.length) return false;
  const idx = Math.floor(Math.random() * musicData.length);
  return selectMusicTrackByIndex(idx);
}

/**
 * Pick a random track, wait until it can play, then start playback (wizard music step).
 * @returns {Promise<boolean>}
 */
export async function autoplayRandomMusicTrack() {
  const gen = ++autoplayGeneration;
  const audio = getMainAudio();
  if (!audio || !selectRandomMusicTrack()) return false;

  const waitForReady = () =>
    new Promise((resolve, reject) => {
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        resolve();
        return;
      }
      const timeoutMs = 45000;
      const timeoutId = globalThis.setTimeout(() => {
        cleanup();
        reject(new Error("Track load timed out"));
      }, timeoutMs);
      const cleanup = () => {
        globalThis.clearTimeout(timeoutId);
        audio.removeEventListener("canplay", onReady);
        audio.removeEventListener("loadeddata", onReady);
        audio.removeEventListener("error", onError);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Track failed to load"));
      };
      audio.addEventListener("canplay", onReady, { once: true });
      audio.addEventListener("loadeddata", onReady, { once: true });
      audio.addEventListener("error", onError, { once: true });
    });

  try {
    await waitForReady();
    if (gen !== autoplayGeneration) return false;
    if (!audio.getAttribute("src")) return false;

    await ensureSpectrumFromUserGesture(audio);
    if (gen !== autoplayGeneration) return false;

    startSpectrumRenderLoop();
    await audio.play();
    return true;
  } catch {
    if (gen !== autoplayGeneration) return false;
    const playBtn = document.getElementById("play-pause-btn");
    if (playBtn && getSelect().value !== "") {
      setPlayButtonAppearance("▶", "Play selected track");
      playBtn.disabled = false;
    }
    setDeckPlaying(false);
    stopSpectrumRenderLoop();
    return false;
  }
}

export function resetMusicDemoSession() {
  autoplayGeneration += 1;
  selectionLocked = false;

  const select = getSelect();
  const audio = getMainAudio();
  const fallback = document.getElementById("audio-player");
  const playBtn = document.getElementById("play-pause-btn");
  const progressBar = document.getElementById("progress-bar");
  const currentTimeEl = document.getElementById("current-time");

  if (select) {
    select.disabled = false;
    select.value = "";
  }

  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute("src");
  }
  if (fallback) {
    fallback.pause();
    fallback.currentTime = 0;
    fallback.removeAttribute("src");
  }

  if (progressBar) {
    progressBar.value = "0";
    setRangeFillPercent(progressBar, 0);
  }
  if (currentTimeEl) currentTimeEl.textContent = "0:00";

  if (playBtn) {
    setPlayButtonAppearance("▶", "Play selected track");
    playBtn.disabled = true;
  }

  const titleEl = document.getElementById("title");
  const artistEl = document.getElementById("artist");
  const genresEl = document.getElementById("genre-tags");
  if (titleEl) titleEl.textContent = "Song Title";
  if (artistEl) {
    artistEl.textContent = "";
    artistEl.hidden = true;
  }
  if (genresEl) {
    genresEl.innerHTML = "";
    genresEl.hidden = true;
  }
  clearCoverArt();
  setDeckPlaying(false);
  setWavePanelLoading(false);
  clearWaveform();
}
