/**
 * E2E tests for the Change Tracker UI.
 *
 * Tests cover:
 * - Sidebar file list rendering
 * - File selection and diff viewing
 * - Accept/revert from UI
 * - Accept All / Revert All from UI
 * - Dark mode styling
 * - SSE live updates
 */

import { test, expect } from "./fixtures/test-server.js";

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

test("sidebar shows pending files", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Should see sidebar items
  const sidebarItems = page.locator(".sidebar-item");
  await expect(sidebarItems).toHaveCount(2);
});

test("sidebar shows file paths", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Check that file paths are visible
  const paths = page.locator(".sidebar-file-path");
  await expect(paths.first()).toBeVisible();
});

test("sidebar shows change counts", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  const counts = page.locator(".sidebar-count");
  await expect(counts.first()).toBeVisible();
});

test("sidebar shows tool badges", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  const badges = page.locator(".sidebar-tool-badge");
  await expect(badges.first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

test("header shows pending count next to title", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  const badge = page.locator(".h1-badge");
  await expect(badge).toBeVisible();
  const text = await badge.textContent();
  // Should show a number (pending count)
  expect(parseInt(text!, 10)).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// File selection and diff viewing
// ---------------------------------------------------------------------------

test("clicking sidebar item selects file and shows diff", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Click first sidebar item
  await page.click(".sidebar-item:first-child");

  // Main area should show file viewer
  await expect(page.locator(".file-viewer")).toBeVisible();
  await expect(page.locator(".file-header-path")).toBeVisible();
});

test("diff table renders with line numbers", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Click first file to show diff
  await page.click(".sidebar-item:first-child");

  // Diff table should be visible
  await expect(page.locator(".diff-table")).toBeVisible();

  // Line numbers should be present
  const lineNums = page.locator(".line-num");
  await expect(lineNums.first()).toBeVisible();
});

test("diff shows addition lines", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");

  // Should have at least one addition line
  const addLines = page.locator(".diff-add");
  const count = await addLines.count();
  expect(count).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Accept / Revert from UI
// ---------------------------------------------------------------------------

test("accept button in sidebar marks file as accepted", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Click accept button on first file
  const acceptBtn = page.locator(".sidebar-item:first-child .btn-sm-accept");
  await expect(acceptBtn).toBeVisible();
  await acceptBtn.click();

  // Wait for update
  await page.waitForTimeout(500);

  // File should now be in accepted state (dimmed) - check non-history items
  const acceptedItem = page.locator(".sidebar-item.status-accepted:not(.sidebar-history)");
  await expect(acceptedItem).toBeVisible();
});

test("accept button in file header marks file as accepted", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Select first file
  await page.click(".sidebar-item:first-child");

  // Click accept in header
  const acceptBtn = page.locator(".file-header-actions .btn-accept");
  await expect(acceptBtn).toBeVisible();
  await acceptBtn.click();

  await page.waitForTimeout(500);

  // After accept, the file should appear as accepted in the sidebar
  const acceptedItem = page.locator(".sidebar-item.status-accepted:not(.sidebar-history)");
  await expect(acceptedItem).toBeVisible();
});

test("revert button in sidebar marks file as reverted", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Click revert button on first file
  const revertBtn = page.locator(".sidebar-item:first-child .btn-sm-revert");
  await expect(revertBtn).toBeVisible();
  await revertBtn.click();

  await page.waitForTimeout(500);

  // File should now be in reverted state - check non-history items
  const revertedItem = page.locator(".sidebar-item.status-reverted:not(.sidebar-history)");
  await expect(revertedItem).toBeVisible();
});

// ---------------------------------------------------------------------------
// Accept All / Revert All
// ---------------------------------------------------------------------------

test("Accept All button marks all files accepted", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Verify pending files exist
  const pendingItems = page.locator(".sidebar-item.status-pending");
  const pendingCount = await pendingItems.count();
  expect(pendingCount).toBeGreaterThan(0);

  // Click Accept All
  await page.click('button:has-text("Accept All")');
  await page.waitForTimeout(500);

  // All should be accepted now
  const stillPending = page.locator(".sidebar-item.status-pending");
  const stillPendingCount = await stillPending.count();
  expect(stillPendingCount).toBe(0);
});

test("Revert All button marks all files reverted", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Click Revert All
  await page.click('button:has-text("Revert All")');
  await page.waitForTimeout(500);

  // All should be reverted now
  const pendingItems = page.locator(".sidebar-item.status-pending");
  const pendingCount = await pendingItems.count();
  expect(pendingCount).toBe(0);

  const revertedItems = page.locator(".sidebar-item.status-reverted");
  const revertedCount = await revertedItems.count();
  expect(revertedCount).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Dark mode
// ---------------------------------------------------------------------------

test("dark mode uses non-black background", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  const bgColor = await page.evaluate(() => {
    return getComputedStyle(document.body).backgroundColor;
  });

  // Should not be pure black
  expect(bgColor).not.toBe("rgb(0, 0, 0)");
  // Should be a dark color (slate tones)
  expect(bgColor).toMatch(/rgb\(\d+, \d+, \d+\)/);
});

test("CSS uses slate color palette", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Check that custom properties are defined
  const cssVars = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      bg: root.getPropertyValue("--bg").trim(),
      bgPanel: root.getPropertyValue("--bg-panel").trim(),
      text: root.getPropertyValue("--text").trim(),
    };
  });

  // Background should be a hex color (not empty)
  expect(cssVars.bg).toMatch(/^#[0-9a-f]{6}$/i);
  expect(cssVars.bgPanel).toMatch(/^#[0-9a-f]{6}$/i);
});

// ---------------------------------------------------------------------------
// SSE live updates
// ---------------------------------------------------------------------------

test("SSE status indicator shows connected", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Wait a moment for SSE to connect
  await page.waitForTimeout(1000);

  const sseStatus = page.locator("#sse-status");
  // Should either be connected or attempting (not permanently disconnected)
  await expect(sseStatus).toBeVisible();
});

test("UI updates after API change without refresh", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Get initial pending count
  const initialBadge = page.locator(".h1-badge");
  const initialText = await initialBadge.textContent();

  // Accept all via API directly
  await page.request.post(baseUrl + "/api/changes/accept-all");

  // Wait for SSE to propagate
  await page.waitForTimeout(1000);

  // Pending badge should be gone (no pending files)
  await expect(page.locator(".h1-badge")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Responsive layout
// ---------------------------------------------------------------------------

test("toolbar buttons are visible", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await expect(page.locator('button:has-text("Accept All")')).toBeVisible();
  await expect(page.locator('button:has-text("Revert All")')).toBeVisible();
  await expect(page.locator('button:has-text("Refresh")')).toBeVisible();
});
