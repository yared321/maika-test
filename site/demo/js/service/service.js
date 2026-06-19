/**
 * Minimal face scan uploader (module version).
 */

const PROXY_BASE              = "/api/face-assess";
const ENDPOINT_ASSESS         = "/v1/web/assess";
const ENDPOINT_ASSESS_BASELINE = "/v1/web/assess-baseline";
const ENDPOINT_ASSESS_POST    = "/v1/web/assess-post";
const DEFAULT_TIMEOUT_MS      = 180000;
const UPLOAD_FORMDATA_FIELD   = "video";
// Delays between retry attempts — length also defines max retry count (2).
const RETRY_DELAYS_MS         = [500, 1000];
// Cloud Run hard limit is 32 MiB; cap at 31 MiB to leave multipart overhead room.
const MAX_BLOB_BYTES          = 31 * 1024 * 1024;

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

/**
 * Unique `request_id` for each face-assess upload (correlation / idempotency hint).
 * Prefers `crypto.randomUUID()`, then RFC-4122-style v4 from `getRandomValues`, else time + random.
 * @returns {string}
 */
export function generateFaceScanRequestId() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    if (c && typeof c.getRandomValues === "function") {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const hex = Array.from(b, (x) =>
        x.toString(16).padStart(2, "0"),
      ).join("");
      return (
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
        `${hex.slice(16, 20)}-${hex.slice(20)}`
      );
    }
  } catch (e) {
    /* fall through */
  }
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 2147483647).toString(36);
  return `${t}-${r}`;
}

// Resolve a proxy-routed upload endpoint by path.
// Pass ENDPOINT_ASSESS_BASELINE or ENDPOINT_ASSESS_POST for the two-step wizard flow,
// or omit to get the legacy single-step endpoint (standalone upload paths only).
export function resolveEndpoint(path) {
  try {
    return new URL(PROXY_BASE + (path || ENDPOINT_ASSESS), globalThis.location.href).href;
  } catch (e) {
    return "";
  }
}

export const ASSESS_PATHS = {
  baseline: ENDPOINT_ASSESS_BASELINE,
  post: ENDPOINT_ASSESS_POST,
  single: ENDPOINT_ASSESS,
};

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

function sleep(ms) {
  return new Promise(function (resolve) { globalThis.setTimeout(resolve, ms); });
}

// Retry on network errors, timeouts, and 5xx only — not on 4xx or when the API
// explicitly signals retryable: false (quality/format errors where the same
// video would fail again regardless).
function isRetryable(result) {
  if (result.retryable === false) return false;
  if (result.timedOut || result.netError) return true;
  return result.status >= 500 && result.status <= 599;
}

// Single fetch attempt with its own AbortController + timeout.
function fetchOnce(resolvedEndpoint, formData, timeoutMs) {
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? globalThis.setTimeout(function () { controller.abort(); }, timeoutMs)
    : 0;

  return fetch(resolvedEndpoint, {
    method: "POST",
    body: formData,
    signal: controller ? controller.signal : undefined,
  })
    .then(function (response) {
      if (timeoutId) globalThis.clearTimeout(timeoutId);
      return response.text().then(function (responseText) {
        const data = parseJsonSafely(responseText);
        const errorNode = data && data.error && typeof data.error === "object" ? data.error : null;
        return {
          ok: response.ok,
          status: response.status,
          errorMessage: response.ok ? "" : parseErrorText(responseText),
          errorCode: errorNode && typeof errorNode.code === "string" ? errorNode.code : null,
          retryable: errorNode && typeof errorNode.retryable === "boolean" ? errorNode.retryable : null,
          data: data,
        };
      });
    })
    .catch(function (err) {
      if (timeoutId) globalThis.clearTimeout(timeoutId);
      const name = err && err.name ? String(err.name) : "";
      if (name === "AbortError") {
        return { ok: false, status: 0, timedOut: true, errorMessage: "Upload timed out." };
      }
      return { ok: false, status: 0, netError: true, errorMessage: (err && err.message) || "Upload failed." };
    });
}

// Upload a recorded face scan to the configured endpoint with metadata.
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
      ok: false, status: 0, netError: true,
      errorMessage: "Invalid recording blob.",
    });
  }

  if (blob.size > MAX_BLOB_BYTES) {
    return Promise.resolve({
      ok: false, status: 0, retryable: false,
      errorCode: "PAYLOAD_TOO_LARGE",
      errorMessage: "Recording is too large to upload (max 31 MB). Please record again.",
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
  const baselineToken = options && options.baselineToken
    ? String(options.baselineToken).trim()
    : "";
  if (baselineToken) formData.append("baseline_token", baselineToken);
  if (options && options.captureMetadata && typeof options.captureMetadata === "object") {
    try {
      formData.append("capture_metadata", JSON.stringify(options.captureMetadata));
    } catch (e) { /* ignore serialization errors — field is optional */ }
  }
  formData.append(
    FaceScanUpload.fieldName,
    videoBlob,
    `face-scan-${Date.now()}.${ext}`,
  );

  const timeoutMs =
    FaceScanUpload.timeoutMs > 0 ? FaceScanUpload.timeoutMs : DEFAULT_TIMEOUT_MS;

  // Retry loop: first attempt + up to RETRY_DELAYS_MS.length retries on transient failures.
  async function attemptWithRetry() {
    let result = await fetchOnce(resolvedEndpoint, formData, timeoutMs);
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      if (!isRetryable(result)) break;
      await sleep(RETRY_DELAYS_MS[i]);
      result = await fetchOnce(resolvedEndpoint, formData, timeoutMs);
    }
    return result;
  }

  return attemptWithRetry();
}

FaceScanUpload.resolveEndpoint = resolveEndpoint;
FaceScanUpload.postRecording = postRecording;
