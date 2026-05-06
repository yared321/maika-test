/**
 * Debug: confirms whether Netlify attached function env to this deploy.
 * GET https://YOUR_SITE/.netlify/functions/diag-maika-env
 * Remove this file before production if you prefer not to expose key names.
 */

export const handler = async () => {
  const upstream = process.env["MAIKA_RPPG_UPSTREAM"];
  const set = !!(upstream && String(upstream).trim());
  const maikaKeys = Object.keys(process.env).filter((k) => k.startsWith("MAIKA_"));
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(
      {
        maikaUpstreamConfigured: set,
        maikaEnvKeyNames: maikaKeys,
        hint: set
          ? "Env is present on the function. If uploads still fail, check URL path and upstream."
          : "Netlify did not inject MAIKA_RPPG_UPSTREAM for this function deploy. Re-deploy after setting the var, or use Deploy with build (not drag-drop of site/ only).",
      },
      null,
      2,
    ),
  };
};
