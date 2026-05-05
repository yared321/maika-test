export class ValenceSliderController {
  constructor(options = {}) {
    this.sliderEl = options.sliderEl || null;
    this.valueEl = options.valueEl || null;
    this.hintEl = options.hintEl || null;
    this.emojiEl = options.emojiEl || null;
    this.defaultValue = Number.isFinite(options.defaultValue)
      ? Number(options.defaultValue)
      : 0;
    this.onChange =
      typeof options.onChange === "function" ? options.onChange : null;
    this.state = {
      xAxisValencePercent: this.defaultValue,
      xAxisValenceLabel: "Neutral",
      xAxisValenceEmoji: this.toneEmoji(this.defaultValue),
    };
  }

  init() {
    if (!this.sliderEl) return;
    this.sliderEl.value = String(this.defaultValue);
    this.updateFromRaw(this.sliderEl.value);
    this.sliderEl.addEventListener("input", () => {
      this.updateFromRaw(this.sliderEl.value);
    });
  }

  clampAndRound(rawValue) {
    let n = Number(rawValue);
    if (!Number.isFinite(n)) n = this.defaultValue;
    if (n > 100) n = 100;
    if (n < -100) n = -100;
    return Math.round(n);
  }

  signedPercentLabel(n) {
    return (n > 0 ? "+" : "") + String(n) + "%";
  }

  toneLabel(n) {
    if (n <= -60) return "Very negative / unpleasant";
    if (n < -15) return "Negative";
    if (n < 15) return "Neutral";
    if (n < 60) return "Positive";
    return "Very positive / pleasant";
  }

  /**
   * Finer steps than {@link toneLabel} so the face tracks the slider continuously.
   * Extremes: −100 → 💔, +100 → 🤩.
   */
  toneEmoji(n) {
    if (n >= 90) return "🤩";
    if (n >= 72) return "😁";
    if (n >= 54) return "😄";
    if (n >= 36) return "😊";
    if (n >= 8) return "🙂";
    if (n > -8) return "😐";
    if (n > -18) return "🙁";
    if (n > -36) return "😕";
    if (n > -54) return "😟";
    if (n > -72) return "😢";
    if (n > -90) return "😭";
    return "💔";
  }

  updateFromRaw(rawValue) {
    const n = this.clampAndRound(rawValue);
    this.state.xAxisValencePercent = n;
    this.state.xAxisValenceLabel = this.toneLabel(n);
    this.state.xAxisValenceEmoji = this.toneEmoji(n);

    if (this.valueEl) this.valueEl.textContent = this.signedPercentLabel(n);
    if (this.hintEl) this.hintEl.textContent = this.state.xAxisValenceLabel;
    if (this.emojiEl) this.emojiEl.textContent = this.state.xAxisValenceEmoji;
    if (this.onChange) this.onChange(this.getState());
  }

  getState() {
    return {
      xAxisValencePercent: this.state.xAxisValencePercent,
      xAxisValenceLabel: this.state.xAxisValenceLabel,
      xAxisValenceEmoji: this.state.xAxisValenceEmoji,
    };
  }
}
