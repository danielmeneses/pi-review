/**
 * ChangeTracker — core engine for tracking, merging, accepting, and reverting
 * file modifications made by PI agent tools (edit, write, bash).
 *
 * Key behaviors:
 * - Captures original file content before each tool call.
 * - Creates a TrackedChange per tool call (audit trail).
 * - Merges all pending changes per file into a single FileDiff for display.
 * - Accept resets the baseline so future edits diff against the accepted content.
 * - Revert restores the baseline content from the start of the cycle.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TrackedChange, ChangeState, FileDiff, DiffBlock, AggregatedState, ChangeCycle } from "./types.js";

const started = new Date().toISOString();

/** Write a debug log line to stderr and/or a log file (controlled by env vars). */
function log(...args: unknown[]): void {
  if (process.env.PI_REVIEW_DEBUG === "1") {
    console.error("[pi-review]", ...args);
  }
  const logFile = process.env.PI_REVIEW_LOG_FILE;
  if (logFile) {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${args.join(" ")}\n`, "utf8");
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class ChangeTracker {
  private changes: TrackedChange[] = [];
  private nextId = 1;
  /**
   * Maps toolCallId → { content: string, existed: boolean }
   * content="" + existed=false means newly created file.
   */
  private originalContents = new Map<string, { content: string; existed: boolean }>();
  /**
   * Maps absolute filePath → current baseline content.
   * Updated on accept so future diffs start from the accepted content.
   */
  private fileBaselines = new Map<string, string>();
  /**
   * History of accept/revert cycles per file.
   * Each entry captures the diff at the time of the action.
   */
  private history: ChangeCycle[] = [];
  private nextCycleId = 1;
  /**
   * Tracks the last known file state after each agent tool result or accept.
   * Used to detect external (user/TUI) modifications between agent actions.
   */
  private fileLastKnown = new Map<string, string>();
  /**
   * Per-toolCallId flag: whether external changes were detected at tool_call time.
   */
  private externalChangesDetected = new Map<string, boolean>();
  /**
   * Per-toolCallId: the fileLastKnown content at the time external changes were detected.
   * Used to compute per-line external change tracking.
   */
  private externalBaselineContents = new Map<string, string>();

  constructor(
    private cwd: string,
    private pi: ExtensionAPI,
  ) {
    log("ChangeTracker initialized, cwd:", cwd);
    this.reviewDir = join(cwd, ".pi-review");
    this.loadFromDisk();
  }

  private reviewDir: string;

  // ------------------------------------------------------------------
  // Query methods
  // ------------------------------------------------------------------

  /** Return a shallow copy of all raw tracked changes. */
  getChanges(): TrackedChange[] {
    return [...this.changes];
  }

  /** Return the count of pending (non-accepted, non-reverted) changes. */
  getPendingCount(): number {
    return this.changes.filter((c) => c.status === "pending").length;
  }

  /**
   * Return the legacy ChangeState (raw changes + nextId).
   * Kept for backward compatibility.
   */
  getState(): ChangeState {
    return { changes: this.getChanges(), nextId: this.nextId, history: this.history, nextCycleId: this.nextCycleId };
  }

  /**
   * Return the full aggregated state: merged FileDiff[] per file
   * plus raw changes for audit.
   */
  getAggregatedState(): AggregatedState {
    return {
      fileDiffs: this.buildFileDiffs(),
      history: [...this.history],
      rawChanges: this.getChanges(),
      nextId: this.nextId,
      nextCycleId: this.nextCycleId,
    };
  }

  // ------------------------------------------------------------------
  // Clear non-pending changes
  // ------------------------------------------------------------------

  /**
   * Remove all accepted/reverted changes (non-pending) from the tracker.
   * Also clears all history entries.
   * @returns number of changes removed.
   */
  clearNonPending(): number {
    const before = this.changes.length;
    this.changes = this.changes.filter(c => c.status === "pending");
    this.history = [];
    this.emitUpdate();
    return before - this.changes.length;
  }

  /**
   * Remove all non-pending changes for a specific file.
   * Also clears history entries for this file.
   * @returns number of changes removed.
   */
  clearFile(filePath: string): number {
    const before = this.changes.length;
    this.changes = this.changes.filter(
      c => c.filePath !== filePath || c.status === "pending",
    );
    this.history = this.history.filter(h => h.filePath !== filePath);
    this.emitUpdate();
    return before - this.changes.length;
  }

  // ------------------------------------------------------------------
  // Accept / Revert — per change (legacy, backward compat)
  // ------------------------------------------------------------------

  /**
   * Accept a single change by ID. Marks it accepted and emits update.
   * @returns true if the change was found and accepted.
   */
  accept(id: string): boolean {
    const change = this.changes.find((c) => c.id === id);
    if (!change || change.status !== "pending") return false;
    change.status = "accepted";
    this.emitUpdate();
    return true;
  }

  /**
   * Revert a single change by ID. Restores original content and marks reverted.
   * @returns true if the change was found and reverted.
   */
  revert(id: string): boolean {
    const change = this.changes.find((c) => c.id === id);
    if (!change || change.status !== "pending") return false;
    try {
      this.restoreFile(change);
      change.status = "reverted";
      this.emitUpdate();
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Accept / Revert — per file
  // ------------------------------------------------------------------

  /**
   * Accept all pending changes for a specific file (by absolute path).
   * Updates the file baseline so future diffs start from current content.
   * Records a history entry for the accept action.
   * @returns the number of changes accepted.
   */
  acceptFile(filePath: string): number {
    const pending = this.changes.filter(c => c.filePath === filePath && c.status === "pending");
    if (pending.length === 0) return 0;

    for (const change of pending) {
      change.status = "accepted";
    }

    // Record history entry
    const first = pending[0];
    const diff = pending.map(c => c.diff).join("\n");
    const tools = [...new Set(pending.map(c => c.toolName))];
    this.history.push({
      id: `cycle-${this.nextCycleId++}`,
      filePath,
      relativePath: first.relativePath,
      diff,
      action: "accepted",
      timestamp: Date.now(),
      changeCount: pending.length,
      tools,
    });

    // Update baseline and last known state: current content becomes the new reference
    try {
      const current = readFileSync(filePath, "utf8");
      this.fileBaselines.set(filePath, current);
      this.fileLastKnown.set(filePath, current);
    } catch {
      this.fileBaselines.delete(filePath);
      this.fileLastKnown.delete(filePath);
    }

    this.emitUpdate();
    return pending.length;
  }

  /**
   * Revert all pending changes for a specific file (by absolute path).
   * Restores the file to its baseline content.
   * Records a history entry for the revert action.
   * @returns the number of changes reverted.
   */
  revertFile(filePath: string): number {
    const pending = this.changes.filter(
      (c) => c.filePath === filePath && c.status === "pending",
    );
    if (pending.length === 0) return 0;

    // Use the baseline from the first pending change
    const first = pending[0];
    try {
      this.restoreFile(first);
      for (const change of pending) {
        change.status = "reverted";
      }

      // Record history entry
      const diff = pending.map(c => c.diff).join("\n");
      const tools = [...new Set(pending.map(c => c.toolName))];
      this.history.push({
        id: `cycle-${this.nextCycleId++}`,
        filePath,
        relativePath: first.relativePath,
        diff,
        action: "reverted",
        timestamp: Date.now(),
        changeCount: pending.length,
        tools,
      });

      // Clear the baseline and last known state since file is restored
      this.fileBaselines.delete(filePath);
      this.fileLastKnown.delete(filePath);
      this.emitUpdate();
      return pending.length;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------------
  // Accept / Revert — all
  // ------------------------------------------------------------------

  /**
   * Accept all pending changes across all files.
   * Updates baselines so future diffs start from current content.
   * Records history entries for each file accepted.
   * @returns the number of changes accepted.
   */
  acceptAll(): number {
    // Group by file
    const fileGroups = new Map<string, TrackedChange[]>();
    for (const change of this.changes) {
      if (change.status !== "pending") continue;
      const group = fileGroups.get(change.filePath) ?? [];
      group.push(change);
      fileGroups.set(change.filePath, group);
    }

    let count = 0;
    for (const [filePath, pending] of fileGroups) {
      for (const change of pending) {
        change.status = "accepted";
      }
      count += pending.length;

      // Record history
      const first = pending[0];
      const diff = pending.map(c => c.diff).join("\n");
      const tools = [...new Set(pending.map(c => c.toolName))];
      this.history.push({
        id: `cycle-${this.nextCycleId++}`,
        filePath,
        relativePath: first.relativePath,
        diff,
        action: "accepted",
        timestamp: Date.now(),
        changeCount: pending.length,
        tools,
      });

      // Update baseline and last known state
      try {
        const current = readFileSync(filePath, "utf8");
        this.fileBaselines.set(filePath, current);
        this.fileLastKnown.set(filePath, current);
      } catch {
        this.fileBaselines.delete(filePath);
        this.fileLastKnown.delete(filePath);
      }
    }

    if (count > 0) this.emitUpdate();
    return count;
  }

  /**
   * Revert all pending changes across all files.
   * Restores each file to its baseline content.
   * Records history entries for each file reverted.
   * @returns the number of changes reverted.
   */
  revertAll(): number {
    // Group by file
    const fileGroups = new Map<string, TrackedChange[]>();
    for (const change of this.changes) {
      if (change.status !== "pending") continue;
      const group = fileGroups.get(change.filePath) ?? [];
      group.push(change);
      fileGroups.set(change.filePath, group);
    }

    let count = 0;
    for (const [filePath, pending] of fileGroups) {
      const first = pending[0];
      try {
        this.restoreFile(first);
        for (const change of pending) {
          change.status = "reverted";
        }
        count += pending.length;

        // Record history
        const diff = pending.map(c => c.diff).join("\n");
        const tools = [...new Set(pending.map(c => c.toolName))];
        this.history.push({
          id: `cycle-${this.nextCycleId++}`,
          filePath,
          relativePath: first.relativePath,
          diff,
          action: "reverted",
          timestamp: Date.now(),
          changeCount: pending.length,
          tools,
        });

        this.fileBaselines.delete(filePath);
        this.fileLastKnown.delete(filePath);
      } catch {
        // skip files that can't be reverted
      }
    }

    if (count > 0) this.emitUpdate();
    return count;
  }

  // ------------------------------------------------------------------
  // Session reconstruction
  // ------------------------------------------------------------------

  /**
   * Rebuild tracker state from the session history (e.g., on reconnect).
   * Restores all previously tracked changes from session entries.
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.changes = [];
    this.nextId = 1;
    this.history = [];
    this.nextCycleId = 1;
    this.originalContents.clear();
    this.fileBaselines.clear();
    this.fileLastKnown.clear();
    this.externalChangesDetected.clear();
    this.externalBaselineContents.clear();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || (msg.toolName !== "edit" && msg.toolName !== "write" && msg.toolName !== "bash")) continue;

      const details = msg.details as ChangeTrackerDetails | undefined;
      if (details?.changeTracker) {
        const state = details.changeTracker as ChangeState;
        this.changes = state.changes;
        this.nextId = state.nextId;
        if (state.history) this.history = state.history;
        if (state.nextCycleId) this.nextCycleId = state.nextCycleId;
      }
    }
  }

  // ------------------------------------------------------------------
  // Hook registration
  // ------------------------------------------------------------------

  /**
   * Register PI tool_call and tool_result hooks to capture file changes.
   * tool_call: store original file content before modification.
   * tool_result: create TrackedChange entries after modification.
   */
  registerHooks(): void {
    log("registerHooks: registering tool_call, tool_result, message hooks");
    this.registerToolCallHook();
    this.registerToolResultHook();
    this.registerMessageHook();
  }

  /**
   * tool_call hook — capture original file content before the tool runs.
   */
  private registerToolCallHook(): void {
    this.pi.on("tool_call", async (event, _ctx) => {
      try {
        if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return;

        // Handle bash commands — extract affected paths
        if (event.toolName === "bash") {
          const command = typeof event.input.command === "string" ? event.input.command : "";
          const affectedPaths = this.extractBashAffectedPaths(command);
          if (affectedPaths.length === 0) {
            log("tool_call: bash, no affected paths detected, skipping");
            return;
          }
          log("tool_call: bash, affected paths:", affectedPaths);
          const entries: Array<{ path: string; content: string; existed: boolean; hasExternal?: boolean; externalBaseline?: string }> = [];
          for (const relPath of affectedPaths) {
            const absPath = relPath.startsWith("/") ? relPath : join(this.cwd, relPath);
            try {
              const content = readFileSync(absPath, "utf8");
              // Detect external changes for this specific file
              const lastKnown = this.fileLastKnown.get(absPath);
              const hasExternal = lastKnown !== undefined && lastKnown !== content;
              entries.push({ path: absPath, content, existed: true, hasExternal, externalBaseline: hasExternal ? lastKnown : undefined });
              log("tool_call: bash, stored original for", absPath, "length:", content.length, hasExternal ? "EXTERNAL" : "");
            } catch {
              entries.push({ path: absPath, content: "", existed: false, hasExternal: false });
              log("tool_call: bash, file not found:", absPath, "marking as new");
            }
          }
          this.originalContents.set(event.toolCallId, {
            content: JSON.stringify(entries),
            existed: true,
          });
          return;
        }

        // Safely extract path from event input (bash commands don't have path)
        const input = event.input as Record<string, unknown>;
        const filePath = typeof input.path === "string" ? input.path : "";
        log("tool_call:", event.toolName, filePath, "id:", event.toolCallId);

        if (!filePath) { log("tool_call: no filePath, skipping"); return; }

        const absPath = filePath.startsWith("/") ? filePath : join(this.cwd, filePath);

        try {
          const content = readFileSync(absPath, "utf8");
          this.originalContents.set(event.toolCallId, { content, existed: true });
          log("tool_call: stored original content, length:", content.length);
          // Detect external changes: file differs from last known agent state
          const lastKnown = this.fileLastKnown.get(absPath);
          if (lastKnown !== undefined && lastKnown !== content) {
            this.externalChangesDetected.set(event.toolCallId, true);
            // Store the pre-external-change content for per-line tracking
            this.externalBaselineContents.set(event.toolCallId, lastKnown);
            log("tool_call: EXTERNAL CHANGES detected for", absPath);
          }
        } catch {
          this.originalContents.set(event.toolCallId, { content: "", existed: false });
          log("tool_call: file not found, marking as new file");
        }
      } catch (err) {
        log("tool_call: ERROR:", err instanceof Error ? err.stack : String(err));
      }
    });
  }

  /**
   * tool_result hook — create TrackedChange after the tool modifies files.
   */
  private registerToolResultHook(): void {
    this.pi.on("tool_result", async (event, _ctx) => {
      try {
        if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return;

        // Handle bash — iterate over all affected paths
        if (event.toolName === "bash") {
          return this.handleBashResult(event, _ctx);
        }

        // Handle edit/write
        return this.handleEditWriteResult(event, _ctx);
      } catch (err) {
        log("tool_result: ERROR:", err instanceof Error ? err.stack : String(err));
      }
    });
  }

  /**
   * Process bash tool result: create changes for each affected file.
   */
  private handleBashResult(event: any, _ctx: ExtensionContext): any {
    const origEntry = this.originalContents.get(event.toolCallId);
    if (!origEntry) {
      log("tool_result: bash, no original content stored, skipping");
      return;
    }
    let entries: Array<{ path: string; content: string; existed: boolean; hasExternal?: boolean; externalBaseline?: string }>;
    try {
      entries = JSON.parse(origEntry.content);
    } catch {
      log("tool_result: bash, failed to parse stored entries");
      this.originalContents.delete(event.toolCallId);
      return;
    }
    this.originalContents.delete(event.toolCallId);

    let changesAdded = 0;
    for (const entry of entries) {
      const absPath = entry.path;
      const originalContent = entry.content;
      const fileExistedAtToolCall = entry.existed;
      const hasExternal = entry.hasExternal ?? false;
      const externalBaseline = entry.externalBaseline;
      const relPath = relative(this.cwd, absPath);

      let currentContent = "";
      let fileDeleted = false;
      try {
        currentContent = readFileSync(absPath, "utf8");
      } catch {
        currentContent = "";
        fileDeleted = true;
      }

      if (originalContent === currentContent && !fileDeleted && fileExistedAtToolCall) {
        log("tool_result: bash, no change for", absPath, "skipping");
        continue;
      }

      const diff = this.generateDiff(originalContent, currentContent, relPath);
      if (!diff) {
        log("tool_result: bash, empty diff for", absPath, "skipping");
        continue;
      }

      const change: TrackedChange = {
        id: `change-${this.nextId++}`,
        filePath: absPath,
        relativePath: relPath,
        toolName: "bash",
        timestamp: Date.now(),
        originalContent,
        diff,
        status: "pending",
        toolCallId: event.toolCallId,
        baselineContent: originalContent,
        hasExternalChanges: hasExternal,
        externalBaselineContent: externalBaseline,
      };
      change.fileExistsAtToolCall = fileExistedAtToolCall;
      this.changes.push(change);
      changesAdded++;

      // Update last known state for this file
      if (!fileDeleted) {
        this.fileLastKnown.set(absPath, currentContent);
      } else {
        this.fileLastKnown.delete(absPath);
      }

      log("tool_result: bash, change pushed for", absPath);
    }

    if (changesAdded > 0) {
      log("tool_result: bash, total changes added:", changesAdded, "pending:", this.getPendingCount());
      this.emitUpdate();
      if (_ctx.hasUI) {
        _ctx.ui.setStatus("pi-review", `${this.getPendingCount()} pending`);
      }
    }

    return {
      details: this.mergeDetails(event.details, { changeTracker: this.getState() }),
    };
  }

  /**
   * Process edit/write tool result: create a change for the modified file.
   */
  private handleEditWriteResult(event: any, _ctx: ExtensionContext): any {
    const input = event.input as Record<string, unknown>;
    const filePath = typeof input.path === "string" ? input.path : "";
    log("tool_result:", event.toolName, filePath, "id:", event.toolCallId);

    if (!filePath) { log("tool_result: no filePath, skipping"); return; }

    const absPath = filePath.startsWith("/") ? filePath : join(this.cwd, filePath);
    const origEntry = this.originalContents.get(event.toolCallId);
    const originalContent = origEntry?.content ?? "";
    const fileExistedAtToolCall = origEntry?.existed ?? false;

    log("tool_result: absPath:", absPath, "origLen:", originalContent.length, "existed:", fileExistedAtToolCall);

    let currentContent = "";
    let fileDeleted = false;
    try {
      currentContent = readFileSync(absPath, "utf8");
    } catch {
      log("tool_result: file not found after write (deletion)");
      currentContent = "";
      fileDeleted = true;
    }

    if (originalContent === currentContent && !fileDeleted) {
      log("tool_result: no change detected, skipping");
      this.originalContents.delete(event.toolCallId);
      return;
    }

    const diff = this.generateDiff(originalContent, currentContent, filePath);
    log("tool_result: diff length:", diff.length, "deleted:", fileDeleted);

    const change: TrackedChange = {
      id: `change-${this.nextId++}`,
      filePath: absPath,
      relativePath: relative(this.cwd, absPath),
      toolName: event.toolName as "edit" | "write",
      timestamp: Date.now(),
      originalContent,
      diff,
      status: "pending",
      toolCallId: event.toolCallId,
      baselineContent: originalContent,
      hasExternalChanges: this.externalChangesDetected.get(event.toolCallId) ?? false,
      externalBaselineContent: this.externalBaselineContents.get(event.toolCallId),
    };

    change.fileExistsAtToolCall = fileExistedAtToolCall;
    this.changes.push(change);
    this.originalContents.delete(event.toolCallId);
    this.externalChangesDetected.delete(event.toolCallId);
    this.externalBaselineContents.delete(event.toolCallId);

    // Update last known state for this file
    if (!fileDeleted) {
      this.fileLastKnown.set(absPath, currentContent);
    } else {
      this.fileLastKnown.delete(absPath);
    }

    log("tool_result: change pushed, total:", this.changes.length, "pending:", this.getPendingCount());

    this.emitUpdate();

    if (_ctx.hasUI) {
      _ctx.ui.setStatus("pi-review", `${this.getPendingCount()} pending`);
    }

    return {
      details: this.mergeDetails(event.details, { changeTracker: this.getState() }),
    };
  }

  // ------------------------------------------------------------------
  // File restoration helper
  // ------------------------------------------------------------------

  /**
   * Restore a file to its original state (before the tracked change).
   * For newly created files, deletes them. For modified files, writes original content.
   */
  private restoreFile(change: TrackedChange): void {
    if (!change.fileExistsAtToolCall) {
      rmSync(change.filePath, { force: true });
    } else {
      const dir = dirname(change.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(change.filePath, change.originalContent ?? "", "utf8");
    }
  }

  // ------------------------------------------------------------------
  // Diff aggregation — build FileDiff[] from pending changes
  // ------------------------------------------------------------------

  /**
   * Build the merged FileDiff[] from all tracked changes.
   *
   * Algorithm:
   * 1. Group changes by filePath.
   * 2. For each group, find the baseline (original content from first pending change).
   * 3. Read current file content from disk.
   * 4. Generate unified diff: baseline → current.
   * 5. Parse diff into DiffBlock[] for granular UI.
   * 6. Build FileDiff with metadata.
   *
   * Accepted/reverted files are included with their status for audit trail.
   */
  private buildFileDiffs(): FileDiff[] {
    const fileMap = new Map<string, TrackedChange[]>();

    for (const change of this.changes) {
      const group = fileMap.get(change.filePath) ?? [];
      group.push(change);
      fileMap.set(change.filePath, group);
    }

    const fileDiffs: FileDiff[] = [];

    for (const [filePath, changes] of fileMap) {
      const pending = changes.filter((c) => c.status === "pending");
      const accepted = changes.filter((c) => c.status === "accepted");
      const reverted = changes.filter((c) => c.status === "reverted");

      let status: "pending" | "accepted" | "reverted";
      if (pending.length > 0) {
        status = "pending";
      } else if (reverted.length > 0) {
        status = "reverted";
      } else {
        status = "accepted";
      }

      // Use the earliest change for metadata
      const allSorted = [...changes].sort((a, b) => a.timestamp - b.timestamp);
      const first = allSorted[0];
      const relPath = relative(this.cwd, filePath);

      // Determine tools involved
      const tools = [...new Set(changes.map((c) => c.toolName))];

      // Determine the correct baseline for the diff.
      // If there are pending changes AND the file was previously accepted,
      // use the post-accept baseline so the diff only shows new changes.
      // For fully accepted/reverted files, use the original baseline to keep
      // the historical diff for audit trail.
      const acceptedBaseline = this.fileBaselines.get(filePath);
      let useAcceptedBaseline = status === "pending" && pending.length > 0 && acceptedBaseline !== undefined;
      // Use the first PENDING change's baseline, not the earliest overall change.
      // This ensures we diff against the state BEFORE the first pending change,
      // correctly excluding already accepted/reverted changes.
      const firstPending = pending[0];
      // If the file changed on disk after accept (e.g. user edited it) before
      // the agent's next tool_call, the acceptedBaseline is stale. Fall back to
      // the snapshot captured at the start of the current pending cycle.
      if (useAcceptedBaseline && firstPending) {
        const snapshotted = firstPending.baselineContent ?? firstPending.originalContent;
        if (snapshotted !== acceptedBaseline) {
          useAcceptedBaseline = false;
        }
      }
      const baselineContent = useAcceptedBaseline
        ? acceptedBaseline!
        : (firstPending?.baselineContent ?? firstPending?.originalContent ??
           first.baselineContent ?? first.originalContent);

      // Check if any pending change in this cycle had external changes
      const hasExternal = pending.some(c => c.hasExternalChanges === true);

      // For external changes: use the pre-external-change baseline and compute
      // which lines were modified externally for per-line marking in the UI.
      let externalLineNums: number[] = [];
      let externalLineContents: string[] = [];
      let effectiveBaseline = baselineContent;
      if (hasExternal && status === "pending" && firstPending) {
        const extBaseline = firstPending.externalBaselineContent;
        if (extBaseline !== undefined) {
          // Use the pre-external-change baseline so the diff includes both
          // external and agent changes
          effectiveBaseline = extBaseline;
          // Compute external diff to identify externally modified line numbers
          const extDiff = this.generateDiff(extBaseline, firstPending.baselineContent ?? firstPending.originalContent, relPath);
          const result = this.extractChangedLineNums(extDiff);
          externalLineNums = result.lineNums;
          externalLineContents = result.contents;
        }
      }

      const fileExisted = first.fileExistsAtToolCall ?? true;

      // Read current content
      let currentContent = "";
      try {
        currentContent = readFileSync(filePath, "utf8");
      } catch {
        // File was deleted
        currentContent = "";
      }

      // For pending files: generate fresh diff from baseline to current.
      // For accepted/reverted files: concatenate individual diffs for audit trail.
      let diff: string;
      if (status === "pending") {
        diff = this.generateDiff(effectiveBaseline, currentContent, relPath);
      } else {
        diff = changes.map((c) => c.diff).join("\n");
      }

      fileDiffs.push({
        filePath,
        relativePath: relPath,
        diff,
        blocks: this.parseDiffBlocks(diff),
        originalContent: effectiveBaseline,
        status,
        changeCount: changes.length,
        tools,
        firstChangeTime: allSorted[0].timestamp,
        lastChangeTime: allSorted[allSorted.length - 1].timestamp,
        fileExisted,
        hasExternalChanges: hasExternal,
        externalLineNums,
        externalLineContents,
      });
    }

    // Sort: pending first, then by lastChangeTime descending
    fileDiffs.sort((a, b) => {
      const statusOrder = { pending: 0, accepted: 1, reverted: 2 };
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;
      return b.lastChangeTime - a.lastChangeTime;
    });

    return fileDiffs;
  }

  /**
   * Parse a unified diff string into DiffBlock[] for granular display.
   *
   * Groups contiguous +/- lines into blocks, tracking the start line
   * from hunk headers (@@ ... @@).
   */
  private parseDiffBlocks(diff: string): DiffBlock[] {
    if (!diff) return [];

    const blocks: DiffBlock[] = [];
    const lines = diff.split("\n");
    let currentBlock: string[] = [];
    let startLine = 1;
    let inHunk = false;

    for (const line of lines) {
      // Hunk header: @@ -start,count +start,count @@
      const hunkMatch = line.match(/^@@ -(\d+)/);
      if (hunkMatch) {
        inHunk = true;
        startLine = parseInt(hunkMatch[1], 10);
        continue;
      }

      // Skip file headers
      if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

      if (!inHunk) continue;

      // Addition or deletion
      if (line.startsWith("+") || line.startsWith("-")) {
        currentBlock.push(line);
      } else {
        // Context line or empty — finalize block if we have one
        if (currentBlock.length > 0) {
          blocks.push({ lines: [...currentBlock], startLine });
          currentBlock = [];
        }
      }
    }

    // Finalize last block
    if (currentBlock.length > 0) {
      blocks.push({ lines: [...currentBlock], startLine });
    }

    return blocks;
  }

  /**
   * Extract line numbers and content of added/modified lines from a unified diff.
   * Returns { lineNums, contents } for lines changed externally.
   */
  private extractChangedLineNums(diff: string): { lineNums: number[]; contents: string[] } {
    if (!diff) return { lineNums: [], contents: [] };
    const lines = diff.split("\n");
    let newLineNum = 0;
    const lineNums: number[] = [];
    const contents: string[] = [];
    for (const line of lines) {
      if (line.startsWith("@@")) {
        const plusIdx = line.indexOf(" +");
        if (plusIdx !== -1) {
          const plusPart = line.substring(plusIdx + 2).split(" ")[0];
          const plusNum = parseInt(plusPart.split(",")[0], 10);
          if (!isNaN(plusNum)) newLineNum = plusNum - 1;
        }
        continue;
      }
      if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) {
        newLineNum++;
        lineNums.push(newLineNum);
        contents.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        newLineNum++;
      }
    }
    return { lineNums, contents };
  }

  // ------------------------------------------------------------------
  // Bash path extraction
  // ------------------------------------------------------------------

  /**
   * Extract file paths that a bash command is likely to modify.
   * @returns array of file paths (relative or absolute).
   */
  private extractBashAffectedPaths(command: string): string[] {
    const paths = new Set<string>();
    const segments = command.split("|");

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;

      // Redirect targets: > file, >> file, 2> file, &> file
      const redirectMatches = trimmed.match(/[0-9&]*>{1,2}\s*([^\s;|&]+)/g);
      if (redirectMatches) {
        for (const match of redirectMatches) {
          const pathMatch = match.match(/[0-9&]*>{1,2}\s*(.+)$/);
          if (pathMatch) {
            const path = pathMatch[1].trim();
            if (path && !["/dev/null", "/dev/zero", "/dev/stdout", "/dev/stderr"].includes(path)) {
              paths.add(path);
            }
          }
        }
      }

      const tokens = this.tokenizeShell(trimmed);
      if (tokens.length === 0) continue;

      const cmd = tokens[0];

      // sed -i modifies in place. Find the last non-flag argument as the file.
      if (cmd === "sed") {
        const hasInline = tokens.some((t, i) => i > 0 && (t === "-i" || t.startsWith("-i")));
        if (hasInline) {
          // Last non-flag token is the file (handles all expression syntaxes)
          for (let i = tokens.length - 1; i >= 1; i--) {
            if (!tokens[i].startsWith("-") && ![";", "&&", "||"].includes(tokens[i])) {
              paths.add(tokens[i]);
              break;
            }
          }
        }
      }

      // tee writes to file
      if (cmd === "tee") {
        for (let i = 1; i < tokens.length; i++) {
          if (!tokens[i].startsWith("-") && ![";", "&&", "||"].includes(tokens[i])) {
            paths.add(tokens[i]);
          }
        }
      }

      // rm, unlink: files are deleted
      if (["rm", "unlink"].includes(cmd)) {
        for (let i = 1; i < tokens.length; i++) {
          if (!tokens[i].startsWith("-") && ![";", "&&", "||"].includes(tokens[i])) {
            paths.add(tokens[i]);
          }
        }
      }

      // mv, cp, ln: destination is affected
      if (["mv", "cp", "ln"].includes(cmd)) {
        const args = tokens.filter((t, idx) => idx > 0 && !t.startsWith("-") && ![";", "&&", "||"].includes(t));
        if (args.length >= 2) {
          paths.add(args[args.length - 1]);
        }
      }

      // touch: all non-flag args are files
      if (cmd === "touch") {
        for (let i = 1; i < tokens.length; i++) {
          if (!tokens[i].startsWith("-") && ![";", "&&", "||"].includes(tokens[i])) {
            paths.add(tokens[i]);
          }
        }
      }

      // Generic file-modifying commands: last non-flag arg is the file
      const fileModifyingCommands = ["awk", "perl", "python", "python3", "ruby", "node", "chmod", "chown", "install"];
      if (fileModifyingCommands.includes(cmd)) {
        for (let i = tokens.length - 1; i >= 1; i--) {
          if (!tokens[i].startsWith("-") && ![";", "&&", "||"].includes(tokens[i])) {
            paths.add(tokens[i]);
            break;
          }
        }
      }
    }

    return [...paths];
  }

  /**
   * Simple shell tokenizer — handles quotes and basic escaping.
   */
  private tokenizeShell(input: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];

      if (escaped) { current += ch; escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }

      if (inSingleQuote) {
        if (ch === "'") inSingleQuote = false;
        else current += ch;
        continue;
      }

      if (inDoubleQuote) {
        if (ch === '"') inDoubleQuote = false;
        else current += ch;
        continue;
      }

      if (ch === "'") { inSingleQuote = true; continue; }
      if (ch === '"') { inDoubleQuote = true; continue; }

      if (ch === " " || ch === "\t") {
        if (current) { tokens.push(current); current = ""; }
        continue;
      }

      if (ch === ";" || ch === "&" || ch === "|") {
        if (current) { tokens.push(current); current = ""; }
        break;
      }

      current += ch;
    }

    if (current) tokens.push(current);
    return tokens;
  }

  // ------------------------------------------------------------------
  // Diff generation
  // ------------------------------------------------------------------

  /**
   * Generate a unified diff between original and current content.
   * Uses CLI `diff -u` when available, falls back to a simple line-by-line diff.
   */
  private generateDiff(original: string, current: string, filePath: string): string {
    if (original === current) return "";

    // File created
    if (!original && current) {
      const lines = current.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map((line) => `+${line}`).join("\n") + "\n";
    }

    // File deleted
    if (original && !current) {
      const lines = original.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return `--- a/${filePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n` +
        lines.map((line) => `-${line}`).join("\n") + "\n";
    }

    // Try unified diff via CLI
    try {
      const tmpDir = join(this.cwd, ".pi-review-tmp");
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

      const oldFile = join(tmpDir, `orig-${Date.now()}`);
      const newFile = join(tmpDir, `curr-${Date.now()}`);

      writeFileSync(oldFile, original, "utf8");
      writeFileSync(newFile, current, "utf8");

      const result = spawnSync("diff", ["-U", "5", oldFile, newFile], {
        encoding: "utf8",
        timeout: 5000,
      });

      rmSync(oldFile, { force: true });
      rmSync(newFile, { force: true });

      if (result.status === 1 && result.stdout) {
        let output = result.stdout;
        output = output.replace(oldFile, `a/${filePath}`);
        output = output.replace(newFile, `b/${filePath}`);
        // Strip "\ No newline at end of file" markers
        output = output.replace(/^\\ No newline at end of file\n/gm, "");
        return output;
      }

      if (result.status === 0) return "";
    } catch {
      // diff not available
    }

    return this.fallbackDiff(original, current, filePath);
  }

  /**
   * Simple line-by-line fallback diff when `diff` CLI is unavailable.
   * Includes 5 lines of context around each change.
   */
  private fallbackDiff(original: string, current: string, filePath: string): string {
    const origLines = original.split("\n");
    const currLines = current.split("\n");

    if (origLines.length > 0 && origLines[origLines.length - 1] === "") origLines.pop();
    if (currLines.length > 0 && currLines[currLines.length - 1] === "") currLines.pop();

    // Find changed line indices
    const changedIndices: number[] = [];
    const maxLen = Math.max(origLines.length, currLines.length);
    for (let i = 0; i < maxLen; i++) {
      const orig = origLines[i];
      const curr = currLines[i];
      if (orig !== curr) {
        changedIndices.push(i);
      }
    }

    if (changedIndices.length === 0) return "";

    // Build context ranges: 5 lines before and after each change
    const context = 5;
    const includeLines = new Set<number>();
    for (const idx of changedIndices) {
      for (let j = Math.max(0, idx - context); j <= Math.min(maxLen - 1, idx + context); j++) {
        includeLines.add(j);
      }
    }

    const lines: string[] = [];
    lines.push(`--- a/${filePath}`);
    lines.push(`+++ b/${filePath}`);
    lines.push(`@@ -1,${origLines.length} +1,${currLines.length} @@`);

    for (const idx of [...includeLines].sort((a, b) => a - b)) {
      const orig = origLines[idx];
      const curr = currLines[idx];
      if (orig === undefined) {
        lines.push(`+${curr}`);
      } else if (curr === undefined) {
        lines.push(`-${orig}`);
      } else if (orig !== curr) {
        lines.push(`-${orig}`);
        lines.push(`+${curr}`);
      } else {
        lines.push(` ${orig}`);
      }
    }

    return lines.join("\n");
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------

  /** Emit an update event so the server can broadcast to SSE clients. */
  private emitUpdate(): void {
    this.saveToDisk();
    this.pi.events.emit("pi-review:update", this.getState());
  }

  // ------------------------------------------------------------------
  // Disk persistence
  // ------------------------------------------------------------------

  /** Save full tracker state to .pi-review/state.json. */
  private saveToDisk(): void {
    try {
      if (!existsSync(this.reviewDir)) mkdirSync(this.reviewDir, { recursive: true });
      const stateFile = join(this.reviewDir, "state.json");
      const data = JSON.stringify({
        changes: this.changes,
        history: this.history,
        nextId: this.nextId,
        nextCycleId: this.nextCycleId,
        fileBaselines: Object.fromEntries(this.fileBaselines),
        fileLastKnown: Object.fromEntries(this.fileLastKnown),
      }, null, 2);
      writeFileSync(stateFile, data, "utf8");
    } catch (err) {
      log("saveToDisk: ERROR:", err instanceof Error ? err.message : String(err));
    }
  }

  /** Load tracker state from .pi-review/state.json. */
  private loadFromDisk(): void {
    try {
      const stateFile = join(this.reviewDir, "state.json");
      if (!existsSync(stateFile)) return;
      const raw = readFileSync(stateFile, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data.changes)) this.changes = data.changes;
      if (Array.isArray(data.history)) this.history = data.history;
      if (typeof data.nextId === "number") this.nextId = data.nextId;
      if (typeof data.nextCycleId === "number") this.nextCycleId = data.nextCycleId;
      if (data.fileBaselines) {
        this.fileBaselines.clear();
        for (const [k, v] of Object.entries(data.fileBaselines)) {
          this.fileBaselines.set(k, v as string);
        }
      }
      if (data.fileLastKnown) {
        this.fileLastKnown.clear();
        for (const [k, v] of Object.entries(data.fileLastKnown)) {
          this.fileLastKnown.set(k, v as string);
        }
      }
      log("loadFromDisk: loaded", this.changes.length, "changes,", this.history.length, "history entries");
    } catch (err) {
      log("loadFromDisk: ERROR:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Emit line comments as instructions for the agent.
   * Formats the comments and sends them as a user message via the PI API.
   */
  emitComments(comments: Array<{
    filePath: string;
    relativePath: string;
    lineNum: number;
    text: string;
    lineContent?: string;
    changeType?: "add" | "del" | "ctx";
  }>): void {
    const changeLabels: Record<string, string> = {
      add: "added",
      del: "removed",
      ctx: "existing",
    };

    const sections = comments.map(c => {
      const changeLabel = c.changeType ? changeLabels[c.changeType] ?? "changed" : "changed";
      const lineRef = c.lineContent
        ? `\n   → **Line ${c.lineNum}** — \`${c.lineContent}\``
        : `\n   → **Line ${c.lineNum}**`;
      return `**${c.relativePath}** (${changeLabel})${lineRef}\n   ${c.text}`;
    });

    const message = sections.join("\n\n");
    const prompt = [
      "👤 **Here is my REVIEW on the changes you just made.**",
      "",
      "Please address **only** the issues I mention below. Do not try to fix unrelated problems,",
      "refactor unrelated code, or make changes outside of what I'm asking for.",
      "Be precise and minimal in your fixes.",
      "",
      "Each comment references a **line number** and the **exact line text**. Use the exact",
      "text to locate the line — if line numbers don't match, search by content.",
      "",
      "**Important:** Only make code changes when I explicitly ask you to (e.g. 'fix this', 'remove this',",
      "'change X to Y'). If I'm just asking a question or asking for an explanation, **answer the question",
      "without modifying any files.**. for this user REVIEW request only use write and edit tools to create or modify files.",
      "",
      message,
      "",
      "Again: **only do what I've explicitly asked above**. Ignore everything else.",
    ].join("\n");

    this.pi.sendUserMessage(prompt);
    this.pi.events.emit("pi-review:comments", { comments, message });

    // Mark that we're waiting for a response to these comments
    this.pendingCommentResponse = { comments, prompt };
  }

  /**
   * Emit a code reference question to the agent.
   * Formats the selected code + user question and sends as a prompt.
   */
  emitReference(params: {
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    code: string;
    question: string;
    mode: "ask" | "edit";
  }): void {
    const hasCode = params.startLine > 0 && params.code;
    const range = hasCode
      ? (params.startLine === params.endLine
          ? `line ${params.startLine}`
          : `lines ${params.startLine}-${params.endLine}`)
      : "";
    const fileRef = range
      ? `**File:** \`${params.relativePath}\` (${range})`
      : `**File:** \`${params.relativePath}\``;

    const askMode = params.mode === "ask";
    const promptParts = [
      askMode
        ? "👤 **I have a QUESTION. Please READ-ONLY — do not modify any files.**"
        : "👤 **I want you to MODIFY something. You may use edit/write tools to make changes.**",
      "",
      fileRef,
    ];

    if (hasCode) {
      promptParts.push("", "**Selected code:**", "```", params.code, "```");
    }

    promptParts.push("", `**My request:** ${params.question}`, "");
    promptParts.push(
      askMode
        ? "**Reminder: answer my question but do NOT edit any files.**"
        : "**You may edit files to fulfill this request.**",
    );

    const prompt = promptParts.join("\n");

    this.pi.sendUserMessage(prompt);
    // Mark that we're waiting for a response to this reference
    this.pendingReferenceResponse = { params, prompt };
  }

  /**
   * Emit a follow-up message with full conversation history.
   */
  emitReferenceFollowup(params: {
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    code: string;
    messages: Array<{ role: string; text: string }>;
    question: string;
    mode: "ask" | "edit";
  }): void {
    const hasCode = params.startLine > 0 && params.code;
    const range = hasCode
      ? (params.startLine === params.endLine
          ? `line ${params.startLine}`
          : `lines ${params.startLine}-${params.endLine}`)
      : "";
    const fileRef = range
      ? `**File:** \`${params.relativePath}\` (${range})`
      : `**File:** \`${params.relativePath}\``;

    const askMode = params.mode === "ask";
    const history = params.messages.map((m, i) => {
      const role = m.role === "user" ? "👤 You" : "🤖 Agent";
      return `**${role}:** ${m.text}`;
    }).join("\n\n");

    const promptParts = [
      "👤 **Follow-up regarding the referenced file.**",
      "",
      fileRef,
    ];

    if (hasCode) {
      promptParts.push("", "**Original code:**", "```", params.code, "```");
    }

    promptParts.push(
      "",
      "**Conversation so far:**",
      history,
      "",
      `**My follow-up:** ${params.question}`,
      "",
      askMode
        ? "**Reminder: answer my question but do NOT edit any files.**"
        : "**You may edit files to fulfill this request.**",
    );

    const prompt = promptParts.join("\n");
    this.pi.sendUserMessage(prompt);
    this.pendingReferenceResponse = { params, prompt };
  }

  /** If set, we're waiting for an agent response to these comments. */
  private pendingCommentResponse: { comments: any[]; prompt: string } | null = null;

  /** If set, we're waiting for an agent response to a reference question. */
  private pendingReferenceResponse: { params: any; prompt: string } | null = null;

  /**
   * Listen for agent text messages. After sending comments, capture
   * the next agent text response and broadcast it to the frontend.
   */
  private registerMessageHook(): void {
    this.pi.on("message_end", (event: any) => {
      const msg = event.message;
      if (!msg || msg.role !== "assistant") return;
      // Extract text content
      let text = "";
      if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      } else if (typeof msg.content === "string") {
        text = msg.content;
      }
      if (!text.trim()) return;

      if (this.pendingCommentResponse) {
        this.commentResponses.push({ text: text.trim(), timestamp: Date.now() });
        this.pendingCommentResponse = null;
        this.emitUpdate();
      }
      if (this.pendingReferenceResponse) {
        this.referenceResponses.push({ text: text.trim(), timestamp: Date.now() });
        this.pendingReferenceResponse = null;
        this.emitUpdate();
      }
    });
  }

  /** Collected agent responses to comments. */
  private commentResponses: Array<{ text: string; timestamp: number }> = [];

  /** Collected agent responses to reference questions. */
  private referenceResponses: Array<{ text: string; timestamp: number }> = [];

  /** Get and clear comment responses. */
  drainCommentResponses(): Array<{ text: string; timestamp: number }> {
    const responses = [...this.commentResponses];
    this.commentResponses = [];
    return responses;
  }

  /** Get and clear reference responses. */
  drainReferenceResponses(): Array<{ text: string; timestamp: number }> {
    const responses = [...this.referenceResponses];
    this.referenceResponses = [];
    return responses;
  }

  /** Merge tracker details into an existing details object. */
  private mergeDetails(existing: any, tracker: ChangeTrackerDetails): any {
    if (!existing) return tracker;
    if (typeof existing !== "object") return tracker;
    return { ...existing, ...tracker };
  }
}

/** Internal details shape attached to tool result messages. */
interface ChangeTrackerDetails {
  changeTracker?: ChangeState;
}
