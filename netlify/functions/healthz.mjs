/**
 * Lightweight health probe (parity with scripts/maika-rppg-proxy.mjs `/healthz`).
 */

export const config = {
  path: "/healthz",
};

export default async () =>
  new Response("ok", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
