/**
 * Minimal face scan uploader (module version).
 */

const DEFAULT_ENDPOINT =
  "https://maika-rppg-web-staging-x4o27bgmjq-oa.a.run.app/v1/web/assess";
const LOCAL_PROXY_ENDPOINT = "/api/rppg/v1/web/assess";
const DEFAULT_TIMEOUT_MS = 120000;
const UPLOAD_FORMDATA_FIELD = "video";

const STATIC_FIELDS = {
  consent: "true",
  request_id: "11111111-1111-1111-1111-111111111111",
};

// Normalize a required form field by trimming it and removing null-like values.
// Returns an empty string for missing or invalid values.
function normalizeRequiredField(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (!s || s === "null" || s === "undefined") return "";
  return s;
}

export const FaceScanUpload = {
  fieldName: UPLOAD_FORMDATA_FIELD,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

// Resolve which upload endpoint to use based on the environment.
// Uses a local proxy for localhost, otherwise falls back to the default endpoint.
export function resolveEndpoint() {
  let endpointCandidate = "";
  
  const h = (globalThis.location && globalThis.location.hostname) || "";
    endpointCandidate =
      h === "localhost" || h === "127.0.0.1"
        ? LOCAL_PROXY_ENDPOINT
        : DEFAULT_ENDPOINT;

  try {
    return new URL(endpointCandidate, globalThis.location.href).href;
  } catch (e) {
    return "";
  }
}

// Get a header value from a meta tag.
// Returns a trimmed string or empty string if no value is found.
function getHeaderValue(metaName) {
  const meta = document.querySelector(`meta[name="${metaName}"]`);
  return meta ? String(meta.getAttribute("content") || "").trim() : "";
}

// Ensure the video blob uses a consistent video format mp4/webm type for upload.
// If the input blob is already the desired type, it is returned unchanged.
function normalizeVideoBlob(blob, recordedMime) {
  const mimeLower = String(blob.type || recordedMime || "").toLowerCase();
  const normalizedMime =
    mimeLower.indexOf("mp4") !== -1 || mimeLower.indexOf("avc1") !== -1
      ? "video/mp4"
      : "video/webm";
  if (blob.type === normalizedMime) return blob;
  return new Blob([blob], { type: normalizedMime });
}

// Extract a readable error message from response text, falling back to plain text.
function parseErrorText(text) {
  const trimmedText = String(text || "").trim();
  if (!trimmedText) return "";
  try {
    const parsed = JSON.parse(trimmedText);
    if (parsed && parsed.error && typeof parsed.error.message === "string")
      return parsed.error.message;
    if (parsed && typeof parsed.message === "string") return parsed.message;
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch (e) {}
  return trimmedText;
}

// Parse JSON text safely and return null if parsing fails.
function parseJsonSafely(text) {
  const trimmedText = String(text || "").trim();
  if (!trimmedText) return null;
  try {
    return JSON.parse(trimmedText);
  } catch (e) {
    return null;
  }
}

// Upload a recorded face scan to the configured endpoint with metadata and optional headers.
// Returns a promise resolving to the response status, parsed data, and any error message.
export function postRecording(blob, endpointUrl, options) {
  const recordedMimeHint = (options && options.recordedMime) || blob.type || "";
  const normalizedAge = normalizeRequiredField(options && options.age);
  const normalizedSex = normalizeRequiredField(options && options.sex);
  const consentFieldValue =
    options && typeof options.consent === "boolean"
      ? options.consent
        ? "true"
        : "false"
      : STATIC_FIELDS.consent;
  const requestIdFieldValue =
    options && options.requestId != null && String(options.requestId).trim()
      ? String(options.requestId).trim()
      : STATIC_FIELDS.request_id;

  if (!blob || typeof blob.size !== "number") {
    return Promise.resolve({
      ok: false,
      status: 0,
      netError: true,
      errorMessage: "Invalid recording blob.",
    });
  }

  if (!normalizedAge || !normalizedSex) {
    return Promise.resolve({
      ok: false,
      status: 0,
      netError: true,
      errorMessage: "Age and sex are required for assessment upload.",
    });
  }

  const resolvedEndpoint = endpointUrl || resolveEndpoint();
  
  if (!resolvedEndpoint) {
    return Promise.resolve({
      ok: false,
      status: 0,
      netError: true,
      errorMessage: "Upload endpoint is not configured.",
    });
  }

  const videoBlob = normalizeVideoBlob(blob, recordedMimeHint);
  const ext = videoBlob.type === "video/mp4" ? "mp4" : "webm";
  const formData = new FormData();
  formData.append("age", normalizedAge);
  formData.append("sex", normalizedSex);
  formData.append("consent", consentFieldValue);
  formData.append("request_id", requestIdFieldValue);
  formData.append(
    FaceScanUpload.fieldName,
    videoBlob,
    `face-scan-${Date.now()}.${ext}`,
  );

  const headers = {};
  const publicKey = getHeaderValue("x-maika-public-key");
  const captcha = getHeaderValue(
    "x-maika-captcha-token"
  );
  if (publicKey) headers["X-Maika-Public-Key"] = publicKey;
  if (captcha) headers["X-Maika-Captcha-Token"] = captcha;

  const abortController =
    typeof AbortController !== "undefined" ? new AbortController() : null;
    
  const timeoutMs =
    FaceScanUpload.timeoutMs > 0
      ? FaceScanUpload.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const timeoutId = abortController
    ? globalThis.setTimeout(function () {
        abortController.abort();
      }, timeoutMs)
    : 0;

  const fetchOptions = {
    method: "POST",
    body: formData,
    headers: Object.keys(headers).length ? headers : undefined,
    signal: abortController ? abortController.signal : undefined,
  };


  return fetch(resolvedEndpoint, fetchOptions)
    .then(function (response) {
      if (timeoutId) globalThis.clearTimeout(timeoutId);
      return Promise.resolve(response.text()).then(function (responseText) {
        const data = parseJsonSafely(responseText);
        return {
          ok: response.ok,
          status: response.status,
          errorMessage: response.ok ? "" : parseErrorText(responseText),
          data: data,
        };
      });
    })
    .catch(function (err) {
      if (timeoutId) globalThis.clearTimeout(timeoutId);
      const name = err && err.name ? String(err.name) : "";
      if (name === "AbortError") {
        return {
          ok: false,
          status: 0,
          timedOut: true,
          errorMessage: "Upload timed out.",
        };
      }
      return {
        ok: false,
        status: 0,
        netError: true,
        errorMessage: (err && err.message) || "Upload failed.",
      };
    });
}

FaceScanUpload.resolveEndpoint = resolveEndpoint;
FaceScanUpload.postRecording = postRecording;
