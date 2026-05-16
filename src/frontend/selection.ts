/**
 * Utility for extracting selected lines from a diff table.
 * Used by the right-click "Reference this code" feature.
 */

export interface SelectedLineInfo {
  lineNum: number;
  type: string;
  content: string;
}

/**
 * Check if any part of a node intersects the given selection range.
 * Uses Selection.containsNode which is more reliable than Range.intersectsNode.
 */
function isRowSelected(sel: Selection, row: HTMLElement): boolean {
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    // Check if the range intersects this row
    if (range.intersectsNode(row)) return true;
    // Also check if the common ancestor is within this row
    let ancestor: Node | null = range.commonAncestorContainer;
    while (ancestor) {
      if (ancestor === row) return true;
      ancestor = ancestor.parentNode;
    }
    // Check start and end containers
    const startRow = findParentRow(range.startContainer);
    const endRow = findParentRow(range.endContainer);
    if (startRow === row || endRow === row) return true;
    // Check if row is between start and end containers
    if (startRow && endRow) {
      // Walk siblings between start and end to see if row is in between
      let node: Node | null = range.startContainer;
      while (node && node !== range.endContainer) {
        const parentRow = findParentRow(node);
        if (parentRow === row) return true;
        node = nextNode(node, range.endContainer);
        if (!node || node === document.body) break;
      }
    }
  }
  return false;
}

function findParentRow(node: Node | null): HTMLTableRowElement | null {
  while (node) {
    if (node instanceof HTMLTableRowElement) return node;
    node = node.parentNode;
  }
  return null;
}

function nextNode(node: Node, endContainer: Node): Node | null {
  if (node.firstChild) return node.firstChild;
  while (node) {
    if (node === endContainer) return null;
    if (node.nextSibling) return node.nextSibling;
    node = node.parentNode!;
    if (node === endContainer) return null;
  }
  return null;
}

/**
 * Extract selected lines from a diff table based on the current browser selection.
 * Walks the DOM to find <tr> elements with data-line attributes that intersect
 * the selection range.
 *
 * @param tableEl - The <table> element containing the diff.
 * @returns Array of selected lines, sorted by line number.
 */
export function extractSelectedLines(tableEl: HTMLElement): SelectedLineInfo[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];

  const selectedRows = new Map<number, SelectedLineInfo>();

  const rows = tableEl.querySelectorAll<HTMLTableRowElement>("tr[data-line]");
  for (const row of rows) {
    const lineNum = parseInt(row.dataset.line || "0", 10);
    if (lineNum <= 0 || selectedRows.has(lineNum)) continue;

    if (isRowSelected(sel, row)) {
      const type = row.dataset.type || "ctx";
      const contentCell = row.querySelector<HTMLTableCellElement>(".line-content");
      const content = contentCell?.textContent ?? "";
      selectedRows.set(lineNum, { lineNum, type, content });
    }
  }

  return [...selectedRows.values()].sort((a, b) => a.lineNum - b.lineNum);
}
