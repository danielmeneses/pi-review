/**
 * Main entry point for the Change Tracker Preact frontend.
 *
 * Mounts the App component into the #app DOM element.
 * This file is bundled by esbuild into dist/frontend.js.
 */

import { render } from "preact";
import { App } from "./app.js";

// Mount the app
const root = document.getElementById("pi-review-app");
if (root) {
  render(<App />, root);
} else {
  console.error("[PIReview] #pi-review-app element not found in DOM");
}
