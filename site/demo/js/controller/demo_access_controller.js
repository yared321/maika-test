const DEMO_ACCESS_CODES = new Set(["HELSANA", "MAIKA26", "PROXYMM"]);

export function handleDemoAccess(dom, state, updateStep) {
  const entered = String(dom.demoAccessInput?.value || "").trim();
  if (!entered) {
    setDemoAccessError(dom, "Please enter your demo code to proceed.");
    dom.demoAccessInput?.focus();
    return;
  }
  if (!DEMO_ACCESS_CODES.has(entered.toUpperCase())) {
    setDemoAccessError(dom, "Invalid code. Please try again.");
    dom.demoAccessInput?.focus();
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
