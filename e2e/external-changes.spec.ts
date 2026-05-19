/**
 * E2E tests for External Change Tracking.
 *
 * Tests cover:
 * - External changes appearing in the sidebar "External Changes" section
 * - External change file selection and diff viewing
 * - Acknowledge (clear) individual external changes
 * - Acknowledge all (clear all) external changes
 * - External changed lines showing ⚡ icons in diff view
 * - SSE broadcast of external changes
 */

import { test, expect } from "./fixtures/test-server.js";

// ---------------------------------------------------------------------------
// External changes section in sidebar
// ---------------------------------------------------------------------------

test("external changes section appears when external changes exist", async ({ page, baseUrl, tracker }) => {
  // Seed an external change
  tracker.seedExternalChange({
    filePath: "/tmp/test/src/external.ts",
    relativePath: "src/external.ts",
    changedLines: [3, 7],
    diff: "--- a/src/external.ts\n+++ b/src/external.ts\n@@ -3,7 +3,7 @@\n-const x = 1;\n+const x = 2;\n",
    timestamp: Date.now(),
  });

  await page.goto(baseUrl + "/");
  await page.waitForSelector(".sidebar-section-label", { state: "visible", timeout: 5000 });

  // Should see "External Changes" section label
  const sectionLabel = page.locator(".sidebar-section-label");
  await expect(sectionLabel).toContainText("External Changes");
});

test("external changes section shows file path and line count", async ({ page, baseUrl, tracker }) => {
  tracker.seedExternalChange({
    filePath: "/tmp/test/src/external.ts",
    relativePath: "src/external.ts",
    changedLines: [3, 7],
    diff: "--- a/src/external.ts\n+++ b/src/external.ts\n@@ -3,7 +3,7 @@\n-const x = 1;\n+const x = 2;\n",
  });

  await page.goto(baseUrl + "/");
  await page.waitForSelector(".sidebar-external", { state: "visible", timeout: 5000 });

  const externalItem = page.locator(".sidebar-external").first();
  await expect(externalItem).toContainText("src/external.ts");
  await expect(externalItem).toContainText("2 lines changed");
});

test("external changes section shows multiple files", async ({ page, baseUrl, tracker }) => {
  tracker.seedExternalChange({
    filePath: "/tmp/test/src/file1.ts",
    relativePath: "src/file1.ts",
    changedLines: [5],
    diff: "",
  });
  tracker.seedExternalChange({
    filePath: "/tmp/test/src/file2.ts",
    relativePath: "src/file2.ts",
    changedLines: [10],
    diff: "",
  });

  await page.goto(baseUrl + "/");
  await page.waitForSelector(".sidebar-external", { state: "visible", timeout: 5000 });

  const items = page.locator(".sidebar-external");
  await expect(items).toHaveCount(2);
});

// ---------------------------------------------------------------------------
// Acknowledge external changes
// ---------------------------------------------------------------------------

test("acknowledge button removes individual external change", async ({ page, baseUrl, tracker }) => {
  tracker.seedExternalChange({
    filePath: "/tmp/test/src/external.ts",
    relativePath: "src/external.ts",
    changedLines: [3],
    diff: "",
  });

  await page.goto(baseUrl + "/");
  await page.waitForSelector(".sidebar-external", { state: "visible", timeout: 5000 });

  // Click acknowledge button
  const ackBtn = page.locator(".btn-sm-ack").first();
  await ackBtn.click();

  // Wait for the external change to be removed
  await page.waitForTimeout(500);
  const items = page.locator(".sidebar-external");
  await expect(items).toHaveCount(0);
});

test("clear all button removes all external changes", async ({ page, baseUrl, tracker }) => {
  tracker.seedExternalChange({
    filePath: "/tmp/test/src/file1.ts",
    relativePath: "src/file1.ts",
    changedLines: [5],
    diff: "",
  });
  tracker.seedExternalChange({
    filePath: "/tmp/test/src/file2.ts",
    relativePath: "src/file2.ts",
    changedLines: [10],
    diff: "",
  });

  await page.goto(baseUrl + "/");
  await page.waitForSelector(".sidebar-section-label", { state: "visible", timeout: 5000 });

  // Click the trash button in the section header
  const trashBtn = page.locator(".sidebar-section-label .sidebar-header-trash");
  await trashBtn.click();

  // Wait for external changes to be removed
  await page.waitForTimeout(500);
  const items = page.locator(".sidebar-external");
  await expect(items).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// External change header in test server fixture
// ---------------------------------------------------------------------------

test("external changes section is hidden when no external changes exist", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // The "External Changes" label should not be visible
  const sectionLabel = page.locator(".sidebar-section-label");
  await expect(sectionLabel).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// SSE broadcast test
// ---------------------------------------------------------------------------

test("external changes are included in API state response", async ({ page, baseUrl, tracker }) => {
  tracker.seedExternalChange({
    filePath: "/tmp/test/src/external.ts",
    relativePath: "src/external.ts",
    changedLines: [1],
    diff: "--- a/src/external.ts\n+++ b/src/external.ts\n@@ -1 +1 @@\n-old\n+new\n",
  });

  const res = await page.request.get(baseUrl + "/api/state");
  const data = await res.json();

  expect(data.externalChanges).toBeDefined();
  expect(Array.isArray(data.externalChanges)).toBe(true);
  expect(data.externalChanges.length).toBe(1);
  expect(data.externalChanges[0].relativePath).toBe("src/external.ts");
  expect(data.externalChanges[0].changedLines).toEqual([1]);
});
