/** Placeholder values required by the upload API (discarded server-side). */
export const DEMO_DEFAULT_AGE = "30";
export const DEMO_DEFAULT_GENDER = "prefer_not_to_say";

/**
 * Apply fixed demographic placeholders used for every face-scan upload.
 * @param {Record<string, any>} state
 */
export function applyDefaultDemographics(state) {
  state.demographics.age = DEMO_DEFAULT_AGE;
  state.demographics.gender = DEMO_DEFAULT_GENDER;
}


