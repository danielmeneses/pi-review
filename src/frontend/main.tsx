/**
 * Main entry point for the Change Tracker Preact frontend.
 *
 * Mounts the App component into the #app DOM element.
 * This file is bundled by esbuild into dist/frontend.js.
 */

import { render } from "preact";
import { App } from "./app.js";

// Mount the app — guard against double initialization
const appRoot = document.getElementById("pi-review-app");
if (appRoot && appRoot.children.length === 0) {
  render(<App />, appRoot);
} else if (appRoot) {
  console.warn("[PIReview] app already mounted, skipping duplicate render");
} else {
  console.error("[PIReview] #pi-review-app element not found in DOM");
}
