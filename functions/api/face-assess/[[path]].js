import { proxyFaceAssess } from "../../_lib/face_assess_proxy.js";

/** `/api/face-assess/*` subpaths. */
export async function onRequest(context) {
  return proxyFaceAssess(context.request, context.env);
}
