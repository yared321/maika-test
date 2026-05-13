#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DEMO_HTML = path.join(REPO_ROOT, "site", "demo", "index.html");

const siteKey = String(process.env.TURNSTILE_SITE_KEY || "").trim();

if (!fs.existsSync(DEMO_HTML)) {
  console.error("inject-public-env: demo index not found");
  process.exit(1);
}

const src = fs.readFileSync(DEMO_HTML, "utf8");
let out = src;

// Keep the placeholder in source when key is absent so local builds
// do not permanently disable captcha in the tracked HTML file.
if (siteKey) {
  out = src.replaceAll("__TURNSTILE_SITE_KEY__", siteKey);
}

if (out !== src) {
  fs.writeFileSync(DEMO_HTML, out, "utf8");
}

console.error(
  "inject-public-env: TURNSTILE_SITE_KEY " +
    (siteKey ? "injected" : "left empty (captcha disabled)"),
);
