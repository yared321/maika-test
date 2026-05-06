/**
 * Demo music list + playback wiring.
 *
 * Flow: demo.js imports `fetchMusicData` → runs once at startup → fills
 * #music-select, binds one change handler, attaches audio control listeners once.
 *
 * Emits `maika-demo:music-ended` on `document` when a track finishes (wizard can listen).
 */
export const MUSIC_ENDED_EVENT = "maika-demo:music-ended";

let musicData = [];
let controlsBound = false;
let selectBound = false;
let selectionLocked = false;
let activeFadeRaf = 0;

function clearActiveFade() {
  if (!activeFadeRaf) return;
  globalThis.cancelAnimationFrame(activeFadeRaf);
  activeFadeRaf = 0;
}

/** Cached #music-select in the wizard. */
function getSelect() {
  return document.getElementById("music-select");
}

/** Main audio element driven by custom controls (`#main-audio`). */
function getMainAudio() {
  return document.getElementById("main-audio");
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
    optionsMarkup += `<option value="${i}">${escapeHtml(song.title)}</option>`;
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

/** Updates visible title row for the picked track (JSON has no artist — placeholder label). */
function updateNowPlaying(song) {
  const titleEl = document.getElementById("title");
  const artistEl = document.getElementById("artist");
  if (titleEl) titleEl.textContent = song.title;
  if (artistEl) artistEl.textContent = "Maika demo";
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
  const durationEl = document.getElementById("duration");
  const volumeSlider = document.getElementById("volume-slider");
  const volumeContainer = volumeSlider
    ? volumeSlider.closest(".volume-container")
    : null;

  if (
    !audio ||
    !playBtn ||
    !rewindBtn ||
    !forwardBtn ||
    !progressBar ||
    !currentTimeEl ||
    !durationEl ||
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
  if (volumeContainer) volumeContainer.hidden = true;
  rewindBtn.disabled = true;
  forwardBtn.disabled = true;
  progressBar.disabled = true;
  playBtn.textContent = "▶ Play";
  playBtn.disabled = true;
  playBtn.setAttribute("aria-label", "Play selected track");

  playBtn.addEventListener("click", () => {
    if (audio.paused && getSelect().value !== "") {
      playBtn.textContent = "⏳ Starting…";
      playBtn.disabled = true;
      void audio.play().catch(() => {
        playBtn.textContent = "▶ Play";
        playBtn.disabled = false;
      });
    }
  });

  audio.addEventListener("play", () => {
    playBtn.textContent = "⏸ Playing";
    playBtn.disabled = false;
  });
  audio.addEventListener("pause", () => {
    playBtn.textContent = "▶ Play";
    playBtn.disabled = false;
  });
  audio.addEventListener("ended", () => {
    playBtn.textContent = "▶ Play";
    playBtn.disabled = false;
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
    durationEl.textContent = formatTime(audio.duration);
  });

  audio.addEventListener("loadedmetadata", () => {
    durationEl.textContent = formatTime(audio.duration);
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
  const durationEl = document.getElementById("duration");

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
    if (durationEl) durationEl.textContent = "0:00";
    if (playBtn) playBtn.textContent = "▶ Play";
    if (playBtn) playBtn.disabled = true;
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
    playBtn.textContent = "⏳ Loading…";
    playBtn.disabled = true;
  }
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
  if (durationEl) durationEl.textContent = "0:00";

  updateNowPlaying(song);

  const markPlayable = () => {
    if (playBtn && getSelect().value !== "") {
      playBtn.textContent = "▶ Play";
      playBtn.disabled = false;
    }
  };

  const markFailed = () => {
    if (playBtn && getSelect().value !== "") {
      playBtn.textContent = "⚠ Unable to load";
      playBtn.disabled = true;
    }
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
    const pb = document.getElementById("progress-bar");
    const vs = document.getElementById("volume-slider");
    setRangeFillPercent(pb, pb ? Number(pb.value) || 0 : 0);
    setRangeFillPercent(vs, vs ? (Number(vs.value) || 0) * 100 : 100);
  } catch (error) {
    console.error("Error fetching music data:", error);
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
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    if (fallback) {
      fallback.pause();
      fallback.currentTime = 0;
    }
    if (playBtn) {
      playBtn.textContent = "▶ Play";
    }
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
  const startVolume = audio.volume;
  const startAt = globalThis.performance.now();

  return new Promise((resolve) => {
    const restoreVolumes = () => {
      for (const target of fadeTargets) {
        target.el.volume = target.startVolume;
      }
    };

    const tick = (now) => {
      const allPaused = fadeTargets.every((target) => target.el.paused);
      if (allPaused) {
        stopNow();
        restoreVolumes();
        resolve();
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
        stopNow();
        restoreVolumes();
        resolve();
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
export function resetMusicDemoSession() {
  selectionLocked = false;

  const select = getSelect();
  const audio = getMainAudio();
  const fallback = document.getElementById("audio-player");
  const playBtn = document.getElementById("play-pause-btn");
  const progressBar = document.getElementById("progress-bar");
  const currentTimeEl = document.getElementById("current-time");
  const durationEl = document.getElementById("duration");

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
  if (durationEl) durationEl.textContent = "0:00";

  if (playBtn) {
    playBtn.textContent = "▶ Play";
    playBtn.disabled = true;
  }

  const titleEl = document.getElementById("title");
  const artistEl = document.getElementById("artist");
  if (titleEl) titleEl.textContent = "Song Title";
  if (artistEl) artistEl.textContent = "Artist Name";
}
