import { proxyFaceAssess } from "../../_lib/face_assess_proxy.js";

/** `/api/face-assess` and `/api/face-assess/` */
export async function onRequest(context) {
  return proxyFaceAssess(context.request, context.env);
}
