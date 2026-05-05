const AGE_MIN = 12;
const AGE_MAX = 100;

/**
 * Save demographic input values from the form into the current state.
 * Trims values to remove any accidental whitespace.
 */
export function saveDemographics(dom, state) {
  state.demographics.age = String(
    dom.wizardForm?.querySelector("[name=age]")?.value || "",
  ).trim();
  state.demographics.gender = String(
    dom.wizardForm?.querySelector("[name=gender]")?.value || "",
  ).trim();
}

/**
 * Validate the age field and set browser validity state if invalid.
 * Ensures entered age is an integer within the allowed range.
 */
export function validateAgeField(dom) {
  const ageInput = dom.ageInput;
  if (!ageInput) return;
  const raw = String(ageInput.value || "").trim();
  if (!raw) {
    ageInput.setCustomValidity("");
    return;
  }
  const value = Number(raw);
  const isValidInteger = Number.isInteger(value);
  const isInRange = value >= AGE_MIN && value <= AGE_MAX;
  if (!isValidInteger || !isInRange) {
    ageInput.setCustomValidity(
      `Age must be between ${AGE_MIN} and ${AGE_MAX} (inclusive).`,
    );
    return;
  }
  ageInput.setCustomValidity("");
}

