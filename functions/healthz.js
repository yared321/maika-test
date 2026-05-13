/**
 * GET `/healthz` — returns `200` and plain text `ok`. Quick liveness check only
 * (not a deep dependency check).
 */
export async function onRequest() {
  return new Response("ok", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
