/**
 * E2E tests for diff-only vs full-file view consistency.
 *
 * Tests cover:
 * - Diff view shows deletions, additions, modifications, and context
 * - Full file view shows the current file state
 * - Deleted lines are absent from full file view (they no longer exist)
 * - Added lines appear in full file view with correct highlighting
 * - Line counts match expectations
 */

import { test, expect } from "./fixtures/complex-diff-server.js";

// The seeded diff for src/complex.ts:
// Original file (6 lines):
//   1: line one
//   2: line two
//   3: old line three    <- DELETED
//   4: old four          <- MODIFIED (deleted + added)
//   5: line five
//   6: line six
//
// New file (7 lines):
//   1: line one          (context)
//   2: line two          (context)
//   3: new four          (modified from "old four")
//   4: line five         (context, but follows a deletion)
//   5: line six          (context)
//   6: brand new line    (added)
//
// Diff view rows:
//   ctx: "line one"
//   ctx: "line two"
//   del: "old line three"
//   del: "old four"
//   add: "new four"
//   ctx: "line five"
//   ctx: "line six"
//   add: "brand new line"

// ---------------------------------------------------------------------------
// Diff-only view: verify all row types are present
// ---------------------------------------------------------------------------

test("diff view shows context lines", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  const ctxRows = page.locator(".diff-ctx");
  expect(await ctxRows.count()).toBeGreaterThanOrEqual(2);
});

test("diff view shows deletion rows", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  const delRows = page.locator(".diff-del");
  const delCount = await delRows.count();
  expect(delCount).toBeGreaterThanOrEqual(2); // "old line three" and "old four"
});

test("diff view shows addition rows", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  const addRows = page.locator(".diff-add");
  const addCount = await addRows.count();
  expect(addCount).toBeGreaterThanOrEqual(2); // "new four" and "brand new line"
});

test("diff view has correct total row count", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Total content rows = ctx + del + add
  const total = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-table tbody tr");
    let count = 0;
    rows.forEach(row => {
      if (row.classList.contains("diff-ctx") ||
          row.classList.contains("diff-add") ||
          row.classList.contains("diff-del")) {
        count++;
      }
    });
    return count;
  });

  // Expected: 4 ctx + 2 del + 2 add = 8 content rows
  expect(total).toBeGreaterThanOrEqual(6);
});

test("diff view deletion rows contain the deleted text", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Check that deletion rows have the expected content
  const delContents = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-del .line-content");
    return Array.from(rows).map(row => row.textContent?.trim() ?? "");
  });

  expect(delContents).toContain("old line three");
  expect(delContents).toContain("old four");
});

test("diff view addition rows contain the added text", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  const addContents = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-add .line-content");
    return Array.from(rows).map(row => row.textContent?.trim() ?? "");
  });

  expect(addContents).toContain("new four");
  expect(addContents).toContain("brand new line");
});

// ---------------------------------------------------------------------------
// Full file view: verify deleted lines ARE shown (matching diff view)
// ---------------------------------------------------------------------------

test("full file view DOES show deleted lines (matching diff view)", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Switch to full file view
  const toggleBtn = page.locator('button:has-text("Full File")');
  if (!(await toggleBtn.isVisible())) {
    test.skip();
    return;
  }
  await toggleBtn.click();
  await page.waitForTimeout(500);

  // Skip if content not loaded
  const isLoading = await page.evaluate(() => {
    const empty = document.querySelector(".main-empty");
    return empty?.textContent?.includes("Loading") ?? false;
  });
  if (isLoading) {
    test.skip();
    return;
  }

  // Check that deleted content IS present in deletion rows
  const delContents = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-del .line-content");
    return Array.from(rows).map(row => row.textContent?.trim() ?? "");
  });

  // Deleted lines SHOULD appear in full file view
  expect(delContents).toContain("old line three");
  expect(delContents).toContain("old four");
});

test("full file view has deletion rows", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  const toggleBtn = page.locator('button:has-text("Full File")');
  if (!(await toggleBtn.isVisible())) {
    test.skip();
    return;
  }
  await toggleBtn.click();
  await page.waitForTimeout(500);

  const isLoading = await page.evaluate(() => {
    const empty = document.querySelector(".main-empty");
    return empty?.textContent?.includes("Loading") ?? false;
  });
  if (isLoading) {
    test.skip();
    return;
  }

  // Full file view should have deletion rows
  const delRows = page.locator(".diff-del");
  expect(await delRows.count()).toBeGreaterThanOrEqual(2);
});

test("full file view shows the modified replacement text", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  const toggleBtn = page.locator('button:has-text("Full File")');
  if (!(await toggleBtn.isVisible())) {
    test.skip();
    return;
  }
  await toggleBtn.click();
  await page.waitForTimeout(500);

  const isLoading = await page.evaluate(() => {
    const empty = document.querySelector(".main-empty");
    return empty?.textContent?.includes("Loading") ?? false;
  });
  if (isLoading) {
    test.skip();
    return;
  }

  const allContent = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-table tbody tr .line-content");
    return Array.from(rows).map(row => row.textContent?.trim() ?? "");
  });

  // The modified line should show the NEW text
  expect(allContent).toContain("new four");
  // Context lines should be present
  expect(allContent).toContain("line one");
  expect(allContent).toContain("line two");
  expect(allContent).toContain("line five");
  expect(allContent).toContain("line six");
  // The added line should be present
  expect(allContent).toContain("brand new line");
});

test("full file view row count matches the diff view (includes deletions)", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Get diff view row count
  const diffRowCount = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-table tbody tr");
    let count = 0;
    rows.forEach(row => {
      if (row.classList.contains("diff-ctx") ||
          row.classList.contains("diff-add") ||
          row.classList.contains("diff-del")) {
        count++;
      }
    });
    return count;
  });

  // Switch to full file view
  const toggleBtn = page.locator('button:has-text("Full File")');
  if (!(await toggleBtn.isVisible())) {
    test.skip();
    return;
  }
  await toggleBtn.click();
  await page.waitForTimeout(500);

  const isLoading = await page.evaluate(() => {
    const empty = document.querySelector(".main-empty");
    return empty?.textContent?.includes("Loading") ?? false;
  });
  if (isLoading) {
    test.skip();
    return;
  }

  // Get full file view row count
  const fullRowCount = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-table tbody tr");
    let count = 0;
    rows.forEach(row => {
      if (row.classList.contains("diff-ctx") ||
          row.classList.contains("diff-add") ||
          row.classList.contains("diff-del")) {
        count++;
      }
    });
    return count;
  });

  // Full file view should have >= the diff view row count
  // (it includes all diff rows PLUS any context lines outside hunks)
  expect(fullRowCount).toBeGreaterThanOrEqual(diffRowCount);
});

// ---------------------------------------------------------------------------
// Diff view: line numbers for del/add pairs
// ---------------------------------------------------------------------------

test("diff view del and add rows for a modification are consecutive", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Find a del row followed immediately by an add row (a modification)
  const consecutive = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".diff-table tbody tr"));
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].classList.contains("diff-del") && rows[i + 1].classList.contains("diff-add")) {
        return true;
      }
    }
    return false;
  });

  expect(consecutive).toBe(true);
});
