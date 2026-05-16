/**
 * Build script for the Preact frontend.
 *
 * Uses esbuild to bundle src/frontend/main.tsx → dist/frontend.js
 * and copies src/frontend/styles.css → dist/frontend.css
 */

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

// Ensure dist directory exists
mkdirSync("dist", { recursive: true });

// Bundle the Preact app
await esbuild.build({
  entryPoints: ["src/frontend/main.tsx"],
  bundle: true,
  outfile: "dist/frontend.js",
  format: "iife",
  globalName: "FrontendApp",
  minify: true,
  target: ["chrome90", "firefox90", "safari14"],
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
});

// Copy CSS as-is
copyFileSync("src/frontend/styles.css", "dist/frontend.css");

console.log("Build complete: dist/frontend.js, dist/frontend.css");
