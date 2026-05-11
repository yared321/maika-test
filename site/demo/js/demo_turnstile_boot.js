/**
 * Global callback used by Turnstile data-callback attribute if configured.
 * Keep this file tiny and non-module so it is available immediately.
 */
window.onSuccess = function onDemoTurnstileSuccess() {
  const errorEl = document.getElementById("demo-access-error");
  if (!errorEl) return;
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
};
