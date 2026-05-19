/**
 * Test server fixture — starts the WebServer with a MockTracker
 * for E2E testing without the full PI extension runtime.
 */

import { test as base } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { WebServer } from "../../src/server.js";
import { MockTracker } from "./mock-tracker.js";
import type { TrackedChange } from "../../src/types.js";

interface Fixtures {
  tracker: MockTracker;
  port: number;
  baseUrl: string;
}

export const test = base.extend<Fixtures>({
  tracker: async ({}, use) => {
    const tracker = new MockTracker();
    await use(tracker);
  },

  port: async ({ tracker }, use) => {
    const server = new WebServer(tracker);
    const port = await server.start();

    // Seed sample data
    tracker.seedChanges([
      {
        filePath: "/tmp/test/src/app.ts",
        relativePath: "src/app.ts",
        toolName: "edit",
        originalContent: "console.log('hello');",
        diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n-console.log('hello');\n+console.log('hello');\n+console.log('world');\n",
        status: "pending",
        baselineContent: "console.log('hello');",
      },
      {
        filePath: "/tmp/test/src/utils.ts",
        relativePath: "src/utils.ts",
        toolName: "write",
        originalContent: "",
        diff: "--- /dev/null\n+++ b/src/utils.ts\n@@ -0,0 +1,3 @@\n+function add(a, b) {\n+  return a + b;\n+}\n",
        status: "pending",
        baselineContent: "",
      },
    ]);

    // Write seeded files to disk so the full-file content endpoint works
    for (const c of tracker.getChanges()) {
      const absPath = c.filePath;
      const dir = dirname(absPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(absPath, c.originalContent || "", "utf8");
    }

    await use(port);

    // Cleanup
    server.stop();
  },

  baseUrl: async ({ port }, use) => {
    await use(`http://localhost:${port}`);
  },
});

export { expect } from "@playwright/test";
