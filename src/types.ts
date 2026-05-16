/**
 * Core type definitions for the PI Review extension.
 *
 * Tracks file modifications made by agent tools (edit, write, bash),
 * merges changes per file between user accepts, and supports
 * accept/revert at both file and global level.
 */

/**
 * A single tracked change from one tool invocation.
 *
 * These are the raw, per-tool-call entries kept for audit trail.
 * Multiple TrackedChange entries for the same file are merged
 * into a single FileDiff for display purposes.
 */
export interface TrackedChange {
  id: string;
  filePath: string;
  relativePath: string;
  toolName: "edit" | "write" | "bash";
  timestamp: number;
  originalContent: string;
  diff: string;
  status: "pending" | "accepted" | "reverted";
  toolCallId: string;
  turnIndex?: number;
  /**
   * Whether the file existed on disk at the time of the tool call.
   * false = newly created file (revert should delete it)
   * true = modified or deleted file (revert should restore original content)
   */
  fileExistsAtToolCall?: boolean;
  /**
   * The baseline content used for merging diffs.
   * Set to the original content from the first pending change in a cycle.
   */
  baselineContent?: string;
  /**
   * Whether external (user/TUI) modifications were detected on the file
   * between the last agent action and this tool call.
   */
  hasExternalChanges?: boolean;
}

/**
 * Legacy state shape, kept for backward compatibility.
 */
export interface ChangeState {
  changes: TrackedChange[];
  nextId: number;
  history?: ChangeCycle[];
  nextCycleId?: number;
}

/**
 * A contiguous group of addition/deletion lines from a unified diff.
 *
 * Used for potential per-block accept/revert (nice-to-have feature).
 */
export interface DiffBlock {
  /** The +/- lines in this block (no context lines). */
  lines: string[];
  /** Starting line number in the original file (from hunk header). */
  startLine: number;
}

/**
 * An aggregated, per-file view of all pending changes.
 *
 * Multiple TrackedChange entries for the same file are merged into
 * a single FileDiff with one unified diff (baseline → current content).
 */
export interface FileDiff {
  /** Absolute file path. */
  filePath: string;
  /** File path relative to project root. */
  relativePath: string;
  /** The merged unified diff string (baseline → current). */
  diff: string;
  /** Parsed blocks of changes for potential granular UI. */
  blocks: DiffBlock[];
  /** The baseline content (original content at start of this cycle). */
  originalContent: string;
  /** Current status of this file's changes. */
  status: "pending" | "accepted" | "reverted";
  /** Number of individual TrackedChange entries merged into this diff. */
  changeCount: number;
  /** Unique tool names involved in the changes (e.g., ["edit", "bash"]). */
  tools: string[];
  /** Timestamp of the first change in this cycle. */
  firstChangeTime: number;
  /** Timestamp of the most recent change in this cycle. */
  lastChangeTime: number;
  /** Whether the file existed at the time of the first change. */
  fileExisted: boolean;
  /** Whether any of the pending changes in this cycle were preceded by
   * external (user/TUI) modifications to the file. */
  hasExternalChanges: boolean;
}

/**
 * A snapshot of a file's changes at the time of an accept or revert action.
 * Stored in history so the user can see the full accept/revert timeline per file.
 */
export interface ChangeCycle {
  /** Unique ID for this cycle. */
  id: string;
  /** Absolute file path. */
  filePath: string;
  /** File path relative to project root. */
  relativePath: string;
  /** The diff that was accepted or reverted. */
  diff: string;
  /** Whether this cycle was accepted or reverted. */
  action: "accepted" | "reverted";
  /** Timestamp when the action was taken. */
  timestamp: number;
  /** Number of individual changes in this cycle. */
  changeCount: number;
  /** Tools involved in this cycle. */
  tools: string[];
}

/**
 * The full aggregated state, including both merged file diffs
 * and raw per-tool-call changes for audit purposes.
 */
export interface AggregatedState {
  /** Merged per-file diffs (primary view for UI). */
  fileDiffs: FileDiff[];
  /** History of accept/revert cycles per file (for timeline display). */
  history: ChangeCycle[];
  /** Raw per-tool-call changes (audit trail, backward compat). */
  rawChanges: TrackedChange[];
  /** Next ID counter for new changes. */
  nextId: number;
  /** Next cycle ID counter. */
  nextCycleId: number;
}

/**
 * A line-level comment from the user, attached to a specific file and line.
 */
export interface LineComment {
  /** Absolute file path. */
  filePath: string;
  /** File path relative to project root. */
  relativePath: string;
  /** 1-based line number. */
  lineNum: number;
  /** The comment text (instruction for the agent). */
  text: string;
}
