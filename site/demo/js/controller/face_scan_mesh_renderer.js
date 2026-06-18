/**
 * Draws the live MediaPipe face-mesh on a canvas overlay with a shen.ai-style
 * scan animation: progressive left→right mesh build, vertical sweep bar, then
 * sparse glowing tracking dots, then fade — looping continuously.
 */
import { getCoverVisibleRegion } from "../utils/face_scan_helpers.js";
import { FaceScanFaceModel } from "../utils/face_scan_face_model.js";

// Brand colors
var COLOR_BASE = "223, 122, 254";   // purple (aligning)
var COLOR_GOOD = "118, 240, 191";   // green  (quality ok)

// A small set of anatomically meaningful landmark indices shown as tracking dots
var KEY_LANDMARK_INDICES = [
  10,   // forehead center
  33,   // left eye inner corner
  133,  // left eye outer corner
  362,  // right eye inner corner
  263,  // right eye outer corner
  1,    // nose tip
  4,    // nose bridge
  61,   // left mouth corner
  291,  // right mouth corner
  175,  // chin center
  234,  // left cheek
  454,  // right cheek
  105,  // left eyebrow
  334,  // right eyebrow
  152,  // jaw bottom
];

// Upper-face landmarks used to compute the expansion centroid — excludes chin/jaw
// points that would pull the centroid down and weaken the forehead stretch.
var CENTROID_INDICES = [10, 109, 338, 67, 297, 54, 284, 103, 332, 21, 251];

// How much to stretch the top of the mesh upward beyond the raw landmark boundary.
// Points above the face centroid are pushed further away from it by this factor.
var MESH_EXPAND_TOP = 1.30;

// Animation cycle phases (fractions of total cycle length)
var CYCLE_MS        = 3600;
var P_BUILD_END     = 0.30;   // 0 → 30%:  mesh builds left → right
var P_FULL_END      = 0.48;   // 30 → 48%: full mesh shown
var P_SWEEP_END     = 0.65;   // 48 → 65%: vertical sweep bar crosses face
var P_DOTS_END      = 0.86;   // 65 → 86%: sparse glowing tracking dots
                               // 86→100%:  fade to nothing

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function syncCanvasSize(canvas) {
  var dpr = globalThis.devicePixelRatio || 1;
  var cssW = canvas.clientWidth;
  var cssH = canvas.clientHeight;
  if (!cssW || !cssH) return false;
  var tw = Math.round(cssW * dpr);
  var th = Math.round(cssH * dpr);
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  return true;
}

export function createFaceMeshRenderer(canvas, video) {
  var ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  var _landmarks = null;
  var _ok = false;
  var _animating = false;
  var _rafId = null;
  var _cycleStart = null;

  function clear() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function stopAnimation() {
    _animating = false;
    _landmarks = null;
    _cycleStart = null;
    if (_rafId != null) { cancelAnimationFrame(_rafId); _rafId = null; }
  }

  function drawFrame(now) {
    if (!_animating || !_landmarks) { stopAnimation(); return; }
    if (!ctx || !video || !video.videoWidth) { stopAnimation(); clear(); return; }
    if (!syncCanvasSize(canvas)) { _rafId = requestAnimationFrame(drawFrame); return; }

    var reg = getCoverVisibleRegion(video);
    if (!reg || reg.sw <= 8 || reg.sh <= 8) { _rafId = requestAnimationFrame(drawFrame); return; }

    // Restart cycle if needed
    if (_cycleStart === null) _cycleStart = now;
    var elapsed = (now - _cycleStart) % CYCLE_MS;
    var phase = elapsed / CYCLE_MS;

    var scaleX = canvas.width / reg.sw;
    var scaleY = canvas.height / reg.sh;
    var color = _ok ? COLOR_GOOD : COLOR_BASE;

    // Fix 3: centroid computed from upper-face landmarks only, so chin/jaw
    // points don't pull it down and weaken the forehead expansion.
    var sumNY = 0, centroidCount = 0;
    for (var ci = 0; ci < CENTROID_INDICES.length; ci++) {
      var clm = _landmarks[CENTROID_INDICES[ci]];
      if (clm) { sumNY += clm.y; centroidCount++; }
    }
    var centroidCY = centroidCount > 0
      ? ((sumNY / centroidCount) * reg.vh - reg.sy) * scaleY
      : canvas.height * 0.5;

    function toCvs(p) {
      var cx = (p.x * reg.vw - reg.sx) * scaleX;
      var cy = (p.y * reg.vh - reg.sy) * scaleY;
      // Stretch points above the centroid upward
      if (cy < centroidCY) {
        cy = centroidCY + (cy - centroidCY) * MESH_EXPAND_TOP;
      }
      return [cx, cy];
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var lw = Math.max(0.8, canvas.width / 520);

    // Fix 4: hoist single tessellation call used by all three mesh phases
    var connections = FaceScanFaceModel.getFaceMeshTesselation();

    // Face bounding box in canvas coords — constrains sweep lines to the face area
    var faceMinX = Infinity, faceMaxX = -Infinity;
    var faceMinY = Infinity, faceMaxY = -Infinity;
    for (var li = 0; li < _landmarks.length; li++) {
      var lpt = _landmarks[li];
      if (!lpt) continue;
      var lc = toCvs(lpt);
      if (lc[0] < faceMinX) faceMinX = lc[0];
      if (lc[0] > faceMaxX) faceMaxX = lc[0];
      if (lc[1] < faceMinY) faceMinY = lc[1];
      if (lc[1] > faceMaxY) faceMaxY = lc[1];
    }
    var faceW = faceMaxX - faceMinX;

    // Fix 2: guard against degenerate landmark set (all null → faceW ≤ 0)
    if (!(faceW > 0)) { _rafId = requestAnimationFrame(drawFrame); return; }

    // ── Phase 0 → P_BUILD_END: mesh builds from left ──────────────────────────
    if (phase < P_BUILD_END) {
      var buildProgress = easeInOut(phase / P_BUILD_END);
      var revealX = faceMinX + buildProgress * faceW;
      if (connections && connections.length) {
        ctx.save();
        ctx.lineWidth = lw;
        ctx.strokeStyle = "rgba(" + color + ", 0.50)";
        ctx.shadowColor  = "rgba(" + color + ", 0.35)";
        ctx.shadowBlur   = Math.max(1.5, canvas.width / 360);
        ctx.beginPath();
        for (var i = 0; i < connections.length; i++) {
          var c = connections[i];
          var a = _landmarks[c.start];
          var b = _landmarks[c.end];
          if (!a || !b) continue;
          var pa = toCvs(a);
          var pb = toCvs(b);
          // only draw if both endpoints are left of the reveal frontier
          if (pa[0] > revealX && pb[0] > revealX) continue;
          ctx.moveTo(pa[0], pa[1]);
          ctx.lineTo(pb[0], pb[1]);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Moving frontier glow line — spans only the face's vertical extent
      ctx.save();
      var fg = ctx.createLinearGradient(revealX - faceW * 0.06, 0, revealX + faceW * 0.03, 0);
      fg.addColorStop(0, "rgba(" + color + ", 0)");
      fg.addColorStop(0.7, "rgba(" + color + ", 0.55)");
      fg.addColorStop(1,   "rgba(" + color + ", 0.85)");
      ctx.strokeStyle = fg;
      ctx.lineWidth = Math.max(1.5, canvas.width / 240);
      ctx.shadowColor = "rgba(" + color + ", 0.9)";
      ctx.shadowBlur  = Math.max(4, canvas.width / 100);
      ctx.beginPath();
      ctx.moveTo(revealX, faceMinY);
      ctx.lineTo(revealX, faceMaxY);
      ctx.stroke();
      ctx.restore();
    }

    // ── Phase P_BUILD_END → P_FULL_END: full mesh ─────────────────────────────
    else if (phase < P_FULL_END) {
      if (connections && connections.length) {
        ctx.save();
        ctx.lineWidth = lw;
        ctx.strokeStyle = "rgba(" + color + ", 0.48)";
        ctx.shadowColor  = "rgba(" + color + ", 0.30)";
        ctx.shadowBlur   = Math.max(1.5, canvas.width / 360);
        ctx.beginPath();
        for (var i2 = 0; i2 < connections.length; i2++) {
          var c2 = connections[i2];
          var a2 = _landmarks[c2.start];
          var b2 = _landmarks[c2.end];
          if (!a2 || !b2) continue;
          var pa2 = toCvs(a2);
          var pb2 = toCvs(b2);
          ctx.moveTo(pa2[0], pa2[1]);
          ctx.lineTo(pb2[0], pb2[1]);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── Phase P_FULL_END → P_SWEEP_END: vertical sweep L → R ─────────────────
    else if (phase < P_SWEEP_END) {
      var sweepT = easeInOut((phase - P_FULL_END) / (P_SWEEP_END - P_FULL_END));
      var sweepX = faceMinX + sweepT * (faceW + faceW * 0.12) - faceW * 0.06;

      // Fix 1: per-segment beginPath/stroke so each segment's alpha is applied
      // correctly (a single shared path only uses the last strokeStyle set).
      if (connections && connections.length) {
        ctx.save();
        ctx.lineWidth = lw;
        ctx.shadowBlur = 0;
        for (var i3 = 0; i3 < connections.length; i3++) {
          var c3 = connections[i3];
          var a3 = _landmarks[c3.start];
          var b3 = _landmarks[c3.end];
          if (!a3 || !b3) continue;
          var pa3 = toCvs(a3);
          var pb3 = toCvs(b3);
          var midX = (pa3[0] + pb3[0]) * 0.5;
          if (midX > sweepX) continue;
          var alpha = Math.max(0, Math.min(0.48, (sweepX - midX) / (faceW * 0.2) * 0.48));
          ctx.strokeStyle = "rgba(" + color + ", " + alpha.toFixed(2) + ")";
          ctx.beginPath();
          ctx.moveTo(pa3[0], pa3[1]);
          ctx.lineTo(pb3[0], pb3[1]);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Bright sweep line — confined to face bounding box vertically
      ctx.save();
      var sw = faceW * 0.09;
      var sg = ctx.createLinearGradient(sweepX - sw, 0, sweepX + sw * 0.4, 0);
      sg.addColorStop(0,   "rgba(" + color + ", 0)");
      sg.addColorStop(0.6, "rgba(" + color + ", 0.45)");
      sg.addColorStop(0.85,"rgba(" + color + ", 0.75)");
      sg.addColorStop(1,   "rgba(" + color + ", 0.90)");
      ctx.fillStyle = sg;
      ctx.fillRect(sweepX - sw, faceMinY, sw + sw * 0.4, faceMaxY - faceMinY);
      ctx.shadowColor = "rgba(" + color + ", 1)";
      ctx.shadowBlur  = Math.max(5, canvas.width / 80);
      ctx.strokeStyle = "rgba(" + color + ", 0.92)";
      ctx.lineWidth   = Math.max(1.5, canvas.width / 220);
      ctx.beginPath();
      ctx.moveTo(sweepX, faceMinY);
      ctx.lineTo(sweepX, faceMaxY);
      ctx.stroke();
      ctx.restore();
    }

    // ── Phase P_SWEEP_END → P_DOTS_END: sparse glowing tracking dots ──────────
    else if (phase < P_DOTS_END) {
      var dotsT = (phase - P_SWEEP_END) / (P_DOTS_END - P_SWEEP_END);
      var pulse = 0.55 + 0.45 * Math.sin(now * 0.005);
      var dotAlpha = pulse * (1 - Math.pow(dotsT, 2.5));
      var dotR = Math.max(2.5, canvas.width / 120);
      ctx.save();
      for (var k = 0; k < KEY_LANDMARK_INDICES.length; k++) {
        var idx = KEY_LANDMARK_INDICES[k];
        var lm = _landmarks[idx];
        if (!lm) continue;
        var dp = toCvs(lm);
        ctx.shadowColor = "rgba(" + color + ", " + (dotAlpha * 0.9).toFixed(2) + ")";
        ctx.shadowBlur  = dotR * 3.5;
        ctx.fillStyle   = "rgba(" + color + ", " + dotAlpha.toFixed(2) + ")";
        ctx.beginPath();
        ctx.arc(dp[0], dp[1], dotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // ── Phase P_DOTS_END → 1.0: fade to nothing (canvas stays clear) ──────────
    // nothing drawn; canvas already cleared above

    _rafId = requestAnimationFrame(drawFrame);
  }

  function draw(landmarks, ok) {
    _ok = !!ok;
    if (!landmarks || !landmarks.length) { stopAnimation(); clear(); return; }
    _landmarks = landmarks;
    if (!_animating) {
      _animating = true;
      _cycleStart = null;
      _rafId = requestAnimationFrame(drawFrame);
    }
  }

  return {
    draw: draw,
    clear: function () { stopAnimation(); clear(); },
  };
}
