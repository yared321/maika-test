function getMetaContent(name) {
  for (const m of document.querySelectorAll("meta")) {
    if (m.getAttribute("name") === name) {
      return String(m.getAttribute("content") || "").trim();
    }
  }
  return "";
}

function getVerifyUrl() {
  const override = getMetaContent("demo-verify-url");
  if (override) return override;
  return `${window.location.origin}/api/demo-verify`;
}

function getTurnstileToken() {
  const input = document.querySelector('[name="cf-turnstile-response"]');
  return input ? String(input.value || "").trim() : "";
}

function hasTurnstileWidget() {
  const widget = document.querySelector(".demo-access-card .cf-turnstile");
  return !!(widget && String(widget.getAttribute("data-sitekey") || "").trim());
}

function resetTurnstile() {
  const api = window.turnstile;
  if (!api || typeof api.reset !== "function") return;
  try {
    api.reset();
  } catch {
    // Best-effort reset.
  }
}

export async function handleDemoAccess(dom, state, updateStep) {
  const entered = String(dom.demoAccessInput?.value || "").trim();
  if (!entered) {
    setDemoAccessError(dom, "Please enter your demo code to proceed.");
    dom.demoAccessInput?.focus();
    return;
  }

  const captchaEnabled = hasTurnstileWidget();
  const turnstileToken = captchaEnabled ? getTurnstileToken() : "";
  if (captchaEnabled && !turnstileToken) {
    setDemoAccessError(dom, "Please complete the security check and try again.");
    return;
  }

  try {
    const res = await fetch(getVerifyUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: entered, turnstileToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setDemoAccessError(dom, data?.error || "Could not verify access.");
      dom.demoAccessInput?.focus();
      if (captchaEnabled) resetTurnstile();
      return;
    }
  } catch (_err) {
    setDemoAccessError(dom, "Could not reach verification service. Please try again.");
    dom.demoAccessInput?.focus();
    if (captchaEnabled) resetTurnstile();
    return;
  }

  unlockDemoFlow(dom);
  updateStep(dom, state, 0);
  dom.wizardForm?.querySelector("#age")?.focus();
}

export function unlockDemoFlow(dom) {
  if (dom.demoFlow) {
    dom.demoFlow.hidden = false;
    dom.demoFlow.classList.remove("hidden");
  }
  if (dom.demoLanding) {
    dom.demoLanding.hidden = true;
    dom.demoLanding.classList.add("hidden");
  }
  setDemoAccessError(dom, "");
}

export function setDemoAccessError(dom, message) {
  if (!dom.demoAccessError) return;
  dom.demoAccessError.textContent = message || "";
  dom.demoAccessError.classList.toggle("hidden", !message);
}
