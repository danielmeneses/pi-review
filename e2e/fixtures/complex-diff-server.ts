/**
 * Test server fixture with a complex diff that has additions, deletions,
 * modifications, and context lines for thorough diff/full-file view testing.
 */

import { test as base } from "@playwright/test";
import { WebServer } from "../../src/server.js";
import { MockTracker } from "./mock-tracker.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

interface Fixtures {
  tracker: MockTracker;
  port: number;
  baseUrl: string;
}

// The new (current) file content — what the file looks like after changes
const newFileContent = [
  "line one",
  "line two",
  "new four",
  "line five",
  "line six",
  "brand new line",
].join("\n");

export const test = base.extend<Fixtures>({
  tracker: async ({}, use) => {
    const tracker = new MockTracker();
    await use(tracker);
  },

  port: async ({ tracker }, use) => {
    const filePath = "/tmp/test/src/complex.ts";

    // Create the actual file on disk so the server can serve its content
    mkdirSync("/tmp/test/src", { recursive: true });
    writeFileSync(filePath, newFileContent);

    const server = new WebServer(tracker);
    const port = await server.start();

    // Seed a complex diff with:
    // Original file (6 lines):
    //   1: line one          (context)
    //   2: line two          (context)
    //   3: old line three    <- DELETED
    //   4: old four          <- DELETED (part of modification)
    //   5: line five         (context)
    //   6: line six          (context)
    //
    // New file (6 lines):
    //   1: line one          (context)
    //   2: line two          (context)
    //   3: new four          <- ADDED (replacement for "old four")
    //   4: line five         (context)
    //   5: line six          (context)
    //   6: brand new line    <- ADDED
    tracker.seedChanges([
      {
        filePath,
        relativePath: "src/complex.ts",
        toolName: "edit",
        originalContent: [
          "line one",
          "line two",
          "old line three",
          "old four",
          "line five",
          "line six",
        ].join("\n"),
        diff: [
          "--- a/src/complex.ts",
          "+++ b/src/complex.ts",
          "@@ -1,6 +1,6 @@",
          " line one",
          " line two",
          "-old line three",
          "-old four",
          "+new four",
          " line five",
          " line six",
          "+brand new line",
        ].join("\n"),
        status: "pending",
        baselineContent: [
          "line one",
          "line two",
          "old line three",
          "old four",
          "line five",
          "line six",
        ].join("\n"),
      },
    ]);

    await use(port);

    // Cleanup
    server.stop();
    try { rmSync("/tmp/test", { recursive: true, force: true }); } catch {}
  },

  baseUrl: async ({ port }, use) => {
    await use(`http://localhost:${port}`);
  },
});

export { expect } from "@playwright/test";
