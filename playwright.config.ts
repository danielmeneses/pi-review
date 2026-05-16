/**
 * Playwright configuration for E2E tests.
 *
 * Tests run against a local WebServer instance with a MockTracker,
 * so no PI extension runtime is needed.
 *
 * Uses the system-installed Chrome browser.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,       // servers share ports, run sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,                 // one test at a time to avoid port conflicts
  reporter: "list",
  use: {
    baseURL: "http://localhost",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Use system Chrome
    channel: "chrome",
  },

  projects: [
    {
      name: "chrome",
      use: {
        channel: "chrome",
        viewport: { width: 1280, height: 720 },
      },
    },
  ],

  // Web server is started by the test fixture, not by Playwright
  webServer: undefined,
});
