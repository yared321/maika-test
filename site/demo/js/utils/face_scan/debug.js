/**
 * Toggleable console logging for face-scan quality pipeline.
 * Enable via meta `maika-face-scan-debug="true"` or URL `?faceScanDebug=1`.
 */

var PREFIX = "[Maika FaceScan]";
var enabled = null;
var lastReportKeyByPhase = {};

function readMetaFlag(name) {
  var el = document.querySelector('meta[name="' + name + '"]');
  if (!el) return false;
  var v = String(el.getAttribute("content") || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function readUrlFlag() {
  try {
    var params = new URLSearchParams(globalThis.location.search);
    var v = String(params.get("faceScanDebug") || "").toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  } catch (_e) {
    return false;
  }
}

/**
 * Resolve debug flag once per page load.
 * @returns {boolean}
 */
export function isFaceScanDebugEnabled() {
  if (enabled != null) return enabled;
  enabled = readMetaFlag("maika-face-scan-debug") || readUrlFlag();
  if (enabled) {
    console.info(
      PREFIX,
      "Debug logging ON — set maika-face-scan-debug=false or remove ?faceScanDebug=1 to disable.",
    );
  }
  return enabled;
}

/**
 * @param {string} step
 * @param {unknown} [data]
 */
export function logFaceScanStep(step, data) {
  if (!isFaceScanDebugEnabled()) return;
  if (data === undefined) {
    console.log(PREFIX, step);
    return;
  }
  console.log(PREFIX, step, data);
}

/**
 * @param {string} step
 * @param {unknown} [data]
 */
export function warnFaceScanStep(step, data) {
  if (!isFaceScanDebugEnabled()) return;
  if (data === undefined) {
    console.warn(PREFIX, step);
    return;
  }
  console.warn(PREFIX, step, data);
}

/**
 * Log full quality report; repeats only when outcome/checks change (per phase).
 * @param {string} phase
 * @param {{
 *   ok: boolean,
 *   message?: string,
 *   checks?: Array<{ id: string, pass: boolean, detail?: Record<string, unknown> }>,
 *   metrics?: Record<string, unknown> | null,
 *   traces?: Record<string, unknown> | null,
 *   box?: Record<string, unknown> | null,
 *   landmarkMode?: string
 * }} report
 */
export function logFaceScanQualityReport(phase, report) {
  if (!isFaceScanDebugEnabled()) return;
  var key =
    phase +
    "|" +
    String(!!report.ok) +
    "|" +
    String(report.message || "") +
    "|" +
    JSON.stringify(
      (report.checks || []).map(function (c) {
        return c.id + ":" + (c.pass ? "1" : "0");
      }),
    );
  if (lastReportKeyByPhase[phase] === key) return;
  lastReportKeyByPhase[phase] = key;

  var style = report.ok
    ? "color:#2e7d32;font-weight:bold"
    : "color:#c62828;font-weight:bold";
  console.groupCollapsed(
    "%c" + PREFIX + " Quality [" + phase + "] " + (report.ok ? "PASS" : "FAIL"),
    style,
  );
  if (report.message) console.log("message:", report.message);
  if (report.landmarkMode) console.log("landmarkMode:", report.landmarkMode);
  if (report.box) console.log("box:", report.box);
  if (report.metrics) console.log("metrics:", report.metrics);
  if (report.traces) console.log("rolling traces:", report.traces);
  if (report.checks && report.checks.length) {
    // console.table on every state change during record blocks the main thread;
    // align/warmup still get the full table, record gets a compact line.
    if (phase === "record") {
      var failed = report.checks.filter(function (c) {
        return !c.pass;
      });
      if (failed.length) {
        console.log(
          "failed checks:",
          failed.map(function (c) {
            return c.id;
          }).join(", "),
        );
      }
    } else {
      console.table(
        report.checks.map(function (c) {
          return {
            check: c.id,
            pass: c.pass,
            detail: c.detail ? JSON.stringify(c.detail) : "",
          };
        }),
      );
    }
  }
  console.groupEnd();
}

/**
 * Clear per-phase dedupe keys (e.g. on phase transition).
 * @param {string} [phase]
 */
export function resetFaceScanDebugDedupe(phase) {
  if (!phase) {
    lastReportKeyByPhase = {};
    return;
  }
  delete lastReportKeyByPhase[phase];
}

export const FaceScanDebug = {
  isEnabled: isFaceScanDebugEnabled,
  log: logFaceScanStep,
  warn: warnFaceScanStep,
  logQualityReport: logFaceScanQualityReport,
  resetDedupe: resetFaceScanDebugDedupe,
};
