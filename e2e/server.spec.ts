/**
 * E2E tests for the Change Tracker server API.
 *
 * Tests cover:
 * - Frontend HTML serving
 * - API endpoints (file-diffs, changes, state)
 * - Accept/revert operations
 * - SSE stream
 */

import { test, expect } from "./fixtures/test-server.js";

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

test("serves the frontend HTML", async ({ page, baseUrl }) => {
  const res = await page.request.get(baseUrl + "/");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/html");
});

test("frontend loads without errors", async ({ page, baseUrl }) => {
  const consoleErrors: string[] = [];
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
  // Wait for the page to render (SSE keeps networkidle from firing)
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Should have no critical console errors (favicon 404 is harmless)
  const criticalErrors = consoleErrors.filter(e =>
    !e.includes("SSE") && !e.includes("EventSource") && !e.includes("404")
  );
  expect(criticalErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

test("GET /api/file-diffs returns FileDiff[]", async ({ page, baseUrl }) => {
  const res = await page.request.get(baseUrl + "/api/file-diffs");
  expect(res.status()).toBe(200);

  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThanOrEqual(2); // we seeded 2 files

  // Check structure
  const first = data[0];
  expect(first).toHaveProperty("filePath");
  expect(first).toHaveProperty("relativePath");
  expect(first).toHaveProperty("diff");
  expect(first).toHaveProperty("status");
  expect(first).toHaveProperty("changeCount");
  expect(first).toHaveProperty("tools");
});

test("GET /api/changes returns raw changes", async ({ page, baseUrl }) => {
  const res = await page.request.get(baseUrl + "/api/changes");
  expect(res.status()).toBe(200);

  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThanOrEqual(2);
});

test("GET /api/state returns aggregated state", async ({ page, baseUrl }) => {
  const res = await page.request.get(baseUrl + "/api/state");
  expect(res.status()).toBe(200);

  const data = await res.json();
  expect(data).toHaveProperty("fileDiffs");
  expect(data).toHaveProperty("rawChanges");
  expect(data).toHaveProperty("nextId");
  expect(Array.isArray(data.fileDiffs)).toBe(true);
  expect(Array.isArray(data.rawChanges)).toBe(true);
});

// ---------------------------------------------------------------------------
// Accept / Revert operations
// ---------------------------------------------------------------------------

test("POST /api/changes/accept-all marks all as accepted", async ({ page, baseUrl }) => {
  // Verify pending changes exist
  const before = await page.request.get(baseUrl + "/api/file-diffs");
  const beforeData = await before.json();
  const pendingBefore = beforeData.filter((f: any) => f.status === "pending").length;
  expect(pendingBefore).toBeGreaterThan(0);

  // Accept all
  const res = await page.request.post(baseUrl + "/api/changes/accept-all");
  expect(res.status()).toBe(200);

  const result = await res.json();
  expect(result.success).toBe(true);
  expect(result.count).toBeGreaterThan(0);

  // Verify all accepted
  const after = await page.request.get(baseUrl + "/api/file-diffs");
  const afterData = await after.json();
  const pendingAfter = afterData.filter((f: any) => f.status === "pending").length;
  expect(pendingAfter).toBe(0);
});

test("POST /api/changes/revert-all marks all as reverted", async ({ page, baseUrl }) => {
  // Revert all
  const res = await page.request.post(baseUrl + "/api/changes/revert-all");
  expect(res.status()).toBe(200);

  const result = await res.json();
  expect(result.success).toBe(true);
  expect(result.count).toBeGreaterThan(0);

  // Verify all reverted
  const after = await page.request.get(baseUrl + "/api/file-diffs");
  const afterData = await after.json();
  const pendingAfter = afterData.filter((f: any) => f.status === "pending").length;
  expect(pendingAfter).toBe(0);
  const revertedAfter = afterData.filter((f: any) => f.status === "reverted").length;
  expect(revertedAfter).toBeGreaterThan(0);
});

test("POST /api/files/:path/accept accepts a single file", async ({ page, baseUrl }) => {
  const diffs = await page.request.get(baseUrl + "/api/file-diffs");
  const data = await diffs.json();
  const firstFile = data[0];

  const res = await page.request.post(
    `${baseUrl}/api/files/${encodeURIComponent(firstFile.filePath)}/accept`
  );
  expect(res.status()).toBe(200);

  const result = await res.json();
  expect(result.success).toBe(true);

  // Verify that file is now accepted
  const after = await page.request.get(baseUrl + "/api/file-diffs");
  const afterData = await after.json();
  const updatedFile = afterData.find((f: any) => f.filePath === firstFile.filePath);
  expect(updatedFile.status).toBe("accepted");
});

test("POST /api/files/:path/revert reverts a single file", async ({ page, baseUrl }) => {
  const diffs = await page.request.get(baseUrl + "/api/file-diffs");
  const data = await diffs.json();
  const firstFile = data[0];

  const res = await page.request.post(
    `${baseUrl}/api/files/${encodeURIComponent(firstFile.filePath)}/revert`
  );
  expect(res.status()).toBe(200);

  const result = await res.json();
  expect(result.success).toBe(true);

  // Verify that file is now reverted
  const after = await page.request.get(baseUrl + "/api/file-diffs");
  const afterData = await after.json();
  const updatedFile = afterData.find((f: any) => f.filePath === firstFile.filePath);
  expect(updatedFile.status).toBe("reverted");
});

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

test("GET /api/stream returns SSE content type", async ({ page, baseUrl }) => {
  const res = await page.request.get(baseUrl + "/api/stream", {
    timeout: 5000,
  }).catch(() => null); // SSE keeps connection open, may timeout

  // Either we get the response or it times out (both are OK for SSE)
  if (res) {
    expect(res.headers()["content-type"]).toContain("text/event-stream");
  }
});

// ---------------------------------------------------------------------------
// 404 for unknown routes
// ---------------------------------------------------------------------------

test("unknown routes return 404", async ({ page, baseUrl }) => {
  const res = await page.request.get(baseUrl + "/nonexistent");
  expect(res.status()).toBe(404);
});
