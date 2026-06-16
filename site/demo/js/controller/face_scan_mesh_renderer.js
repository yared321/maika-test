/**
 * Draws the live MediaPipe 468-point face-mesh wireframe on a canvas overlay,
 * matching the same object-fit:cover crop used by the video preview.
 */
import { getCoverVisibleRegion } from "../utils/face_scan_helpers.js";
import { FaceScanFaceModel } from "../utils/face_scan_face_model.js";

var COLOR_BASE = "223, 122, 254";
var COLOR_GOOD = "118, 240, 191";

/**
 * Resizes the backing pixel buffer to match the canvas's rendered CSS box,
 * accounting for device pixel ratio so the wireframe stays crisp.
 */
function syncCanvasSize(canvas) {
  var dpr = globalThis.devicePixelRatio || 1;
  var cssW = canvas.clientWidth;
  var cssH = canvas.clientHeight;
  if (!cssW || !cssH) return false;
  var targetW = Math.round(cssW * dpr);
  var targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  return true;
}

/**
 * Builds a stateful mesh-overlay renderer bound to one canvas/video pair.
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLVideoElement} video
 */
export function createFaceMeshRenderer(canvas, video) {
  var ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;

  function clear() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /**
   * Draws the wireframe mesh + landmark dots for one detection frame.
   * @param {Array<{x:number,y:number}>|null} landmarks Normalized (0-1) MediaPipe points.
   * @param {boolean} [ok] Whether current quality/alignment is good (tints the mesh).
   */
  function draw(landmarks, ok) {
    if (!ctx || !video || !video.videoWidth) {
      clear();
      return;
    }
    if (!landmarks || !landmarks.length) {
      clear();
      return;
    }
    if (!syncCanvasSize(canvas)) {
      clear();
      return;
    }
    var reg = getCoverVisibleRegion(video);
    if (!reg || reg.sw <= 8 || reg.sh <= 8) {
      clear();
      return;
    }
    var scaleX = canvas.width / reg.sw;
    var scaleY = canvas.height / reg.sh;

    function toCanvasPoint(p) {
      var px = p.x * reg.vw;
      var py = p.y * reg.vh;
      return [(px - reg.sx) * scaleX, (py - reg.sy) * scaleY];
    }

    var color = ok ? COLOR_GOOD : COLOR_BASE;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.lineWidth = Math.max(1, canvas.width / 480);
    ctx.strokeStyle = "rgba(" + color + ", 0.55)";
    ctx.shadowColor = "rgba(" + color + ", 0.65)";
    ctx.shadowBlur = Math.max(2, canvas.width / 220);

    var connections = FaceScanFaceModel.getFaceMeshTesselation();
    if (connections && connections.length) {
      ctx.beginPath();
      for (var i = 0; i < connections.length; i++) {
        var c = connections[i];
        var a = landmarks[c.start];
        var b = landmarks[c.end];
        if (!a || !b) continue;
        var pa = toCanvasPoint(a);
        var pb = toCanvasPoint(b);
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
      }
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(" + color + ", 0.85)";
    var dotR = Math.max(0.8, canvas.width / 360);
    for (var j = 0; j < landmarks.length; j += 3) {
      var lp = landmarks[j];
      if (!lp) continue;
      var pp = toCanvasPoint(lp);
      ctx.beginPath();
      ctx.arc(pp[0], pp[1], dotR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  return { draw: draw, clear: clear };
}
