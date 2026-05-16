/**
 * Utility functions for the Change Tracker frontend.
 *
 * Provides HTML escaping, path helpers, and comment counting.
 */

import type { FileDiff, ChangeCycle } from "../types.js";

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/**
 * HTML-escape a string for safe insertion into the DOM.
 * @param s - The string to escape.
 * @returns The escaped string safe for HTML.
 */
export function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the relative path for an absolute file path by looking it up in fileDiffs.
 * @param absPath - The absolute file path.
 * @param fileDiffs - The list of file diffs to search.
 * @returns The relative path, or the absolute path if not found.
 */
export function relativePathFromAbs(absPath: string, fileDiffs: FileDiff[]): string {
  const selected = fileDiffs.find((f) => f.filePath === absPath);
  return selected ? selected.relativePath : absPath;
}

// ---------------------------------------------------------------------------
// Comment helpers
// ---------------------------------------------------------------------------

/**
 * Comment state for a single line.
 */
export interface LineCommentEntry {
  text: string;
  /** Composite row key (lineNum-type) used to look up exact diff content. */
  rowKey?: string;
  /** Whether this comment has been sent and is awaiting a response. */
  sent?: boolean;
  /** Whether this comment+response is resolved (done). */
  done?: boolean;
  /** Agent response text (if available). */
  response?: string;
}

/**
 * Comment state per file: maps line number (string key) to comment entry.
 */
export type FileComments = Record<string, LineCommentEntry>;

/**
 * Top-level comment state: maps file path to file comments.
 */
export type LineCommentsStore = Record<string, FileComments>;

/**
 * The currently editing comment position.
 * Uses a composite rowKey (lineNum + rowType) to uniquely identify
 * the exact table row, since add/del rows can share the same line number.
 */
export interface EditingComment {
  filePath: string;
  lineNum: number;
  rowKey: string; // e.g. "34-add", "34-del", "34-ctx"
}

/**
 * Count total non-empty comments across all files.
 * @param lineComments - The comment store.
 * @returns The count of comments with non-empty text.
 */
export function countTotalComments(lineComments: LineCommentsStore): number {
  let count = 0;
  for (const filePath of Object.keys(lineComments)) {
    const fileComments = lineComments[filePath];
    for (const key of Object.keys(fileComments)) {
      if (fileComments[key].text.trim() && !fileComments[key].sent && !fileComments[key].done) count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

/**
 * Group history cycles by file path, sorted oldest first.
 * @param history - The list of change cycles.
 * @returns A map from file path to sorted cycles.
 */
export function groupHistoryByFile(history: ChangeCycle[]): Map<string, ChangeCycle[]> {
  const historyByFile = new Map<string, ChangeCycle[]>();
  for (const h of history) {
    const group = historyByFile.get(h.filePath) ?? [];
    group.push(h);
    historyByFile.set(h.filePath, group);
  }
  for (const filePath of historyByFile.keys()) {
    historyByFile.get(filePath)!.sort((a, b) => a.timestamp - b.timestamp);
  }
  return historyByFile;
}

// ---------------------------------------------------------------------------
// Badge / status helpers
// ---------------------------------------------------------------------------

/**
 * Get the CSS class for a status dot.
 * @param status - The change status.
 * @returns The CSS class name for the dot.
 */
export function dotClassForStatus(status: string): string {
  if (status === "pending") return "dot-pending";
  if (status === "accepted") return "dot-accepted";
  return "dot-reverted";
}

/**
 * Format a change count with proper pluralization.
 * @param count - The number of changes.
 * @returns Formatted string like "3 changes" or "1 change".
 */
export function formatChangeCount(count: number): string {
  return `${count} change${count !== 1 ? "s" : ""}`;
}

/**
 * Get the capitalized status label.
 * @param status - The status string.
 * @returns Capitalized status (e.g., "Pending").
 */
export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Format a timestamp as a localized time string.
 * @param timestamp - Unix timestamp in milliseconds.
 * @returns Formatted time string.
 */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Format a timestamp as a localized date+time string.
 * @param timestamp - Unix timestamp in milliseconds.
 * @returns Formatted date and time string.
 */
export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

// ---------------------------------------------------------------------------
// Diff line lookup
// ---------------------------------------------------------------------------

/**
 * A single parsed diff line with its content and type.
 */
export interface ParsedDiffLine {
  /** The actual text of the line (without the +/- prefix). */
  content: string;
  /** Whether this is an addition, deletion, or context line. */
  type: "add" | "del" | "ctx";
  /** Line number in the original file (for del/ctx). */
  origLineNum: number;
  /** Line number in the new file (for add/ctx). */
  newLineNum: number;
}

/**
 * Parse a unified diff into a map of composite keys to their content and type.
 * Keys are "lineNum-type" (e.g. "5-add", "5-del", "5-ctx") to avoid collisions
 * when add/del rows share the same line number.
 * @param diffText - The unified diff string.
 * @returns A map from composite key to parsed line info.
 */
export function buildDiffLineMap(diffText: string): Record<string, ParsedDiffLine> {
  const map: Record<string, ParsedDiffLine> = {};
  if (!diffText) return map;

  const lines = diffText.split("\n");
  let origLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const minusIdx = line.indexOf("-");
      const plusIdx = line.indexOf(" +");
      if (minusIdx !== -1 && plusIdx !== -1) {
        const minusPart = line.substring(minusIdx + 1, plusIdx).trim();
        const plusPart = line.substring(plusIdx + 2).split(" ")[0];
        const minusNum = parseInt(minusPart.split(",")[0], 10);
        const plusNum = parseInt(plusPart.split(",")[0], 10);
        if (!isNaN(minusNum)) origLineNum = minusNum - 1;
        if (!isNaN(plusNum)) newLineNum = plusNum - 1;
      }
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

    if (line.startsWith("+")) {
      newLineNum++;
      const key = `${newLineNum}-add`;
      map[key] = { content: line.slice(1), type: "add", origLineNum, newLineNum };
    } else if (line.startsWith("-")) {
      origLineNum++;
      const key = `${origLineNum}-del`;
      map[key] = { content: line.slice(1), type: "del", origLineNum, newLineNum };
    } else if (line.startsWith(" ")) {
      origLineNum++;
      newLineNum++;
      const key = `${origLineNum}-ctx`;
      map[key] = { content: line.slice(1), type: "ctx", origLineNum, newLineNum };
    }
  }

  return map;
}

/**
 * Look up a diff line by rowKey (e.g. "5-add", "5-del").
 * Falls back to line number only if rowKey lookup fails.
 */
export function lookupDiffLine(
  lineMap: Record<string, ParsedDiffLine>,
  rowKey: string,
  lineNum: number,
): ParsedDiffLine | undefined {
  return lineMap[rowKey] ?? lineMap[String(lineNum)];
}
