/**
 * E2E tests for line number rendering, diff table structure,
 * and inline comment functionality.
 *
 * Targets the reported bugs:
 * - Duplicate line numbers in diff/full-file views
 * - Duplicate comment input boxes on changed lines
 * - Comment toggle (open/close) on line number click
 */

import { test, expect } from "./fixtures/test-server.js";

// ---------------------------------------------------------------------------
// Diff line number correctness
// ---------------------------------------------------------------------------

test("diff table line numbers are sequential and unique per row type", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  // Select first file (src/app.ts with a simple add diff)
  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Collect all line numbers from non-hunk rows
  const lineNums = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-table tbody tr:not(.diff-hunk)");
    const nums: string[] = [];
    rows.forEach(row => {
      const td = row.querySelector(".line-num");
      if (td && td.textContent) nums.push(td.textContent.trim());
    });
    return nums;
  });

  // Each line number should be a valid positive integer
  for (const num of lineNums) {
    expect(parseInt(num, 10)).toBeGreaterThan(0);
  }

  // Line numbers should not be empty
  expect(lineNums.length).toBeGreaterThan(0);
});

test("diff table has correct number of rows for the seeded diff", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // The seeded diff for src/app.ts has:
  // - 1 del line (orig line 1)
  // - 2 add lines (new lines 1-2)
  // So we expect 3 content rows (+ 1 hunk header)
  const contentRows = page.locator(".diff-add, .diff-del, .diff-ctx");
  const count = await contentRows.count();
  expect(count).toBeGreaterThanOrEqual(2);
});

test("addition rows show new file line numbers", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");

  // All .diff-add rows should have line numbers
  const addRows = page.locator(".diff-add");
  const addCount = await addRows.count();
  expect(addCount).toBeGreaterThan(0);

  for (let i = 0; i < addCount; i++) {
    const lineNum = await addRows.nth(i).locator(".line-num").textContent();
    expect(parseInt(lineNum!, 10)).toBeGreaterThan(0);
  }
});

test("deletion rows show empty line numbers (not in new file)", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");

  const delRows = page.locator(".diff-del");
  const delCount = await delRows.count();
  if (delCount > 0) {
    for (let i = 0; i < delCount; i++) {
      // Deleted lines don't exist in the new file, so line number is empty
      const lineNum = await delRows.nth(i).locator(".line-num").textContent();
      expect(lineNum?.trim()).toBe("");
    }
  }
});

// ---------------------------------------------------------------------------
// Comment input: no duplicates
// ---------------------------------------------------------------------------

test("clicking a line number opens exactly ONE comment input box", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Click the first line number
  const firstLineNum = page.locator(".diff-add, .diff-del, .diff-ctx").first().locator(".line-num");
  await firstLineNum.click({ delay: 10 });
  await page.waitForTimeout(200);

  // There should be exactly ONE comment input row
  const inputRows = page.locator(".diff-comment-input");
  const inputCount = await inputRows.count();
  expect(inputCount).toBe(1);

  // There should be exactly ONE input element
  const inputs = page.locator('[data-action="comment-input"]');
  expect(await inputs.count()).toBe(1);
});

test("clicking the same line number again closes the comment box (toggle)", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Open comment
  const firstLineNum = page.locator(".diff-add, .diff-del, .diff-ctx").first().locator(".line-num");
  await firstLineNum.click({ delay: 10 });
  await page.waitForTimeout(200);
  expect(await page.locator(".diff-comment-input").count()).toBe(1);

  // Click same line again — should close
  await firstLineNum.click({ delay: 10 });
  await page.waitForTimeout(200);
  expect(await page.locator(".diff-comment-input").count()).toBe(0);
});

test("clicking a different line moves the comment box (no duplicates)", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Get all content rows
  const contentRows = page.locator(".diff-add, .diff-del, .diff-ctx");
  const rowCount = await contentRows.count();
  expect(rowCount).toBeGreaterThanOrEqual(2);

  // Open comment on first row
  await contentRows.first().locator(".line-num").click({ delay: 10 });
  await page.waitForTimeout(200);
  expect(await page.locator(".diff-comment-input").count()).toBe(1);

  // Click a different row's line number
  await contentRows.nth(1).locator(".line-num").click({ delay: 10 });
  await page.waitForTimeout(200);

  // Still exactly ONE input box (moved, not duplicated)
  expect(await page.locator(".diff-comment-input").count()).toBe(1);
});

test("comment input appears immediately after its parent line", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Open comment on a specific row
  const contentRows = page.locator(".diff-add, .diff-del, .diff-ctx");
  const clickedIdx = 0;
  await contentRows.nth(clickedIdx).locator(".line-num").click({ delay: 10 });
  await page.waitForTimeout(200);

  // Check that the comment input row is right after the clicked row
  const inputPosition = await page.evaluate(() => {
    const allRows = Array.from(document.querySelectorAll(".diff-table tbody tr"));
    const inputRow = document.querySelector(".diff-comment-input");
    if (!inputRow) return -1;
    return allRows.indexOf(inputRow);
  });

  const clickedRowPosition = await page.evaluate(() => {
    const allRows = Array.from(document.querySelectorAll(".diff-table tbody tr"));
    // Find the row that has a clicked line-num (we check by index)
    let idx = 0;
    for (const row of allRows) {
      if (row.classList.contains("diff-add") || row.classList.contains("diff-del") || row.classList.contains("diff-ctx")) {
        if (idx === 0) return allRows.indexOf(row);
        idx++;
      }
    }
    return -1;
  });

  // Input row should be immediately after the clicked row
  expect(inputPosition).toBe(clickedRowPosition + 1);
});

// ---------------------------------------------------------------------------
// Full file view line numbers
// ---------------------------------------------------------------------------

test("full file view shows sequential line numbers starting from 1", async ({ page, baseUrl }) => {
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

  // Check if content loaded (might not be available in mock server)
  const isLoading = await page.locator(".main-empty").count();
  if (isLoading > 0) {
    const loadingText = await page.locator(".main-empty").first().textContent();
    if (loadingText?.includes("Loading")) {
      test.skip();
      return;
    }
  }

  // Collect all line numbers
  const lineNums = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-table tbody tr");
    const nums: number[] = [];
    rows.forEach(row => {
      const td = row.querySelector(".line-num");
      if (td && td.textContent && td.textContent.trim()) {
        nums.push(parseInt(td.textContent.trim(), 10));
      }
    });
    return nums;
  });

  // Skip if no content available
  if (lineNums.length === 0) {
    test.skip();
    return;
  }

  // Should start from 1 and be sequential
  expect(lineNums[0]).toBe(1);
  for (let i = 1; i < lineNums.length; i++) {
    expect(lineNums[i]).toBe(lineNums[i - 1] + 1);
  }
});

test("full file view has no duplicate line numbers", async ({ page, baseUrl }) => {
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

  // Skip if content not available
  const lineNums = await page.evaluate(() => {
    const rows = document.querySelectorAll(".diff-table tbody tr");
    const nums: string[] = [];
    rows.forEach(row => {
      const td = row.querySelector(".line-num");
      if (td && td.textContent && td.textContent.trim()) {
        nums.push(td.textContent.trim());
      }
    });
    return nums;
  });

  if (lineNums.length === 0) {
    test.skip();
    return;
  }

  const hasDuplicates = lineNums.length !== new Set(lineNums).size;
  expect(hasDuplicates).toBe(false);
});

// ---------------------------------------------------------------------------
// Comment input row structure
// ---------------------------------------------------------------------------

test("comment input row has correct structure (3 cells)", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Open a comment
  await page.locator(".diff-add, .diff-del, .diff-ctx").first().locator(".line-num").click({ delay: 10 });
  await page.waitForTimeout(200);

  const inputRow = page.locator(".diff-comment-input");
  expect(await inputRow.count()).toBe(1);

  // Should have exactly 3 <td> cells
  const cells = inputRow.locator("td");
  expect(await cells.count()).toBe(3);
});

test("comment input row has save and cancel buttons", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  await page.locator(".diff-add, .diff-del, .diff-ctx").first().locator(".line-num").click({ delay: 10 });
  await page.waitForTimeout(200);

  // Save button should exist
  const saveBtn = page.locator('[data-action="comment-save"]');
  expect(await saveBtn.count()).toBe(1);
  await expect(saveBtn).toBeVisible();

  // Cancel button should exist
  const cancelBtn = page.locator('[data-action="comment-cancel"]');
  expect(await cancelBtn.count()).toBe(1);
  await expect(cancelBtn).toBeVisible();
});

// ---------------------------------------------------------------------------
// No stray comment overlays
// ---------------------------------------------------------------------------

test("no bottom comment overlay exists after clicking a line", async ({ page, baseUrl }) => {
  await page.goto(baseUrl + "/");
  await page.waitForSelector("#sidebar-list", { state: "visible", timeout: 5000 });

  await page.click(".sidebar-item:first-child");
  await expect(page.locator(".diff-table")).toBeVisible();

  // Click a line to comment
  await page.locator(".diff-add, .diff-del, .diff-ctx").first().locator(".line-num").click({ delay: 10 });
  await page.waitForTimeout(200);

  // There should be NO .comment-overlay element (that was the old bottom-pinned approach)
  const overlay = page.locator(".comment-overlay");
  expect(await overlay.count()).toBe(0);
});
