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

(function configureTurnstileSiteKey() {
  var widget = document.querySelector(".demo-access-card .cf-turnstile");
  if (!widget) return;
  var meta = document.querySelector('meta[name="turnstile-site-key"]');
  var key = meta ? String(meta.getAttribute("content") || "").trim() : "";
  if (!key || key.indexOf("__TURNSTILE_SITE_KEY__") !== -1) {
    widget.removeAttribute("data-sitekey");
    return;
  }
  widget.setAttribute("data-sitekey", key);
})();
