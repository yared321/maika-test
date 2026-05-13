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

function readMetaSiteKey() {
  var meta = document.querySelector('meta[name="turnstile-site-key"]');
  return meta ? String(meta.getAttribute("content") || "").trim() : "";
}

function isPlaceholder(value) {
  return !value || value.indexOf("__TURNSTILE_SITE_KEY__") !== -1;
}

function widgetHasRenderedIframe(widget) {
  return !!widget.querySelector("iframe");
}

function renderWidgetWhenReady(widget, key) {
  var attempts = 0;
  var timerId = window.setInterval(function () {
    attempts += 1;
    if (widgetHasRenderedIframe(widget)) {
      window.clearInterval(timerId);
      return;
    }
    var api = window.turnstile;
    if (!api || typeof api.render !== "function") {
      if (attempts > 40) window.clearInterval(timerId);
      return;
    }
    try {
      api.render(widget, { sitekey: key, callback: "onSuccess" });
      window.clearInterval(timerId);
    } catch {
      if (attempts > 40) window.clearInterval(timerId);
    }
  }, 100);
}

async function readRuntimeSiteKey() {
  try {
    var res = await fetch("/api/demo-config", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return "";
    var data = await res.json();
    return String((data && data.turnstileSiteKey) || "").trim();
  } catch {
    return "";
  }
}

(async function configureTurnstileSiteKey() {
  var widget = document.querySelector(".demo-access-card .cf-turnstile");
  if (!widget) return;

  var key = readMetaSiteKey();
  if (isPlaceholder(key)) {
    key = await readRuntimeSiteKey();
  }
  if (isPlaceholder(key)) {
    widget.removeAttribute("data-sitekey");
    return;
  }

  widget.setAttribute("data-sitekey", key);
  renderWidgetWhenReady(widget, key);
})();
