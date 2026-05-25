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

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TrackedChange, ChangeState, FileDiff, DiffBlock, AggregatedState, ChangeCycle, ExternalFileChange } from "./types.js";
import { FileWatcher, type ExternalChangeCallback } from "./watcher.js";
import { GitignoreMatcher } from "./gitignore.js";

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
   * Set of absolute file paths currently being modified by an agent tool.
   * Used to prevent the file watcher from reporting the agent's own writes
   * as external changes (race: tool writes, watcher fires before tool_result
   * updates fileLastKnown).
   *
   * Persisted to disk so it survives extension reloads.
   * Values are timestamps (Date.now()) for stale-entry expiry on load.
   */
  private _toolActiveFiles = new Map<string, number>();

  constructor(
    private cwd: string,
    private pi: ExtensionAPI,
  ) {
    log("ChangeTracker initialized, cwd:", cwd);
    this.reviewDir = join(cwd, ".pi", "pi-review");
    this.loadFromDisk();

    // Create the file watcher for detecting external (non-agent) changes
    this.watcher = new FileWatcher(
      cwd,
      this.handleExternalChange.bind(this),
      (filePath) => this.fileLastKnown.get(filePath),
      300,
    );

    // Create the .gitignore matcher for the project
    this.gitignore = new GitignoreMatcher(cwd);
  }

  private reviewDir: string;

  /** The file watcher for detecting external changes. */
  private watcher: FileWatcher;

  /** The .gitignore matcher for project-scoped filtering. */
  private gitignore: GitignoreMatcher;

  /**
   * Tracks line numbers from external changes that were acknowledged.
   * These persist so the ⚡ icon remains visible in the diff even after
   * the external change entry is removed.
   * Map: absolute filePath → Set of 1-based line numbers.
   */
  private acknowledgedExternalLines = new Map<string, Set<number>>();

  /**
   * External change entries — one per detected external modification.
   * Multiple entries can exist for the same file until accept/revert clears them.
   */
  private externalChangesList: ExternalFileChange[] = [];
  /** Counter for unique external change IDs. */
  private nextExternalId = 1;

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
      externalChanges: [...this.externalChangesList],
      nextId: this.nextId,
      nextCycleId: this.nextCycleId,
    };
  }

  // ------------------------------------------------------------------
  // External change methods
  // ------------------------------------------------------------------

  /**
   * Handle a detected file change from the watcher. Checks whether the
   * change was made by the agent (has a pending TrackedChange) — if so
   * it's skipped. Only truly external changes are recorded.
   */
  private handleExternalChange: ExternalChangeCallback = (
    filePath: string,
    currentContent: string,
    lastKnownContent: string,
    relPath: string,
  ) => {
    // Safety check: skip files outside project or matching .gitignore
    if (!this.shouldTrack(filePath)) {
      log("handleExternalChange: path not tracked, skipping:", relPath);
      return;
    }

    // Skip files currently being written by an agent tool — the agent's
    // own writes would otherwise be detected as spurious external changes
    // when the watcher fires before tool_result updates fileLastKnown.
    if (this._toolActiveFiles.has(filePath)) {
      log("handleExternalChange: agent tool is modifying this file, skipping:", relPath);
      return;
    }

    // Log a notice when the file also has pending agent changes — the user
    // is manually editing a file the agent is working on.
    if (this.changes.some(c => c.filePath === filePath && c.status === "pending")) {
      log("handleExternalChange: external edit detected on file with pending agent changes:", relPath);
    }

    const diff = this.generateDiff(lastKnownContent, currentContent, relPath);
    const changedLines = this.extractChangedLines(diff);

    if (changedLines.length === 0 && !diff) {
      log("handleExternalChange: no actual changes for", relPath);
      return;
    }

    this.externalChangesList.push({
      id: `ext-${this.nextExternalId++}`,
      filePath,
      relativePath: relPath,
      changedLines,
      timestamp: Date.now(),
      diff,
    });

    this.fileLastKnown.set(filePath, currentContent);
    log("handleExternalChange: recorded external change for", relPath, "lines:", changedLines);
    this.emitUpdate();
  };

  /**
   * Parse a unified diff and extract the line numbers (in the new file)
   * that were added or modified. Returns 1-based line numbers.
   */
  private extractChangedLines(diff: string): number[] {
    if (!diff) return [];
    const lines = diff.split("\n");
    const changedLines = new Set<number>();
    let newLineNum = 0;

    for (const line of lines) {
      // Hunk header: @@ -start,count +start,count @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (hunkMatch) {
        newLineNum = parseInt(hunkMatch[2], 10) - 1;
        continue;
      }

      if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

      if (line.startsWith("+")) {
        newLineNum++;
        changedLines.add(newLineNum);
      } else if (line.startsWith("-")) {
        // Deletions don't have a line number in the new file
        continue;
      } else if (line.startsWith(" ")) {
        newLineNum++;
      }
    }

    return [...changedLines].sort((a, b) => a - b);
  }

  /**
   * Get all external changes.
   */
  getExternalChanges(): ExternalFileChange[] {
    return [...this.externalChangesList];
  }

  /**
   * Acknowledge and remove external changes for a specific file.
   * Also updates the file baseline to the current content so future
   * diffs start from the correct state (including the external edits).
   */
  acknowledgeExternalChanges(filePath: string): void {
    const wasRemoved = this.externalChangesList.some(ec => ec.filePath === filePath);
    if (!wasRemoved) return;

    // Save the changed lines before removing so the ⚡ icons stay visible
    const changedLines = this.externalChangesList
      .filter(ec => ec.filePath === filePath)
      .flatMap(ec => ec.changedLines);
    if (changedLines.length > 0) {
      const existing = this.acknowledgedExternalLines.get(filePath) ?? new Set();
      for (const ln of changedLines) existing.add(ln);
      this.acknowledgedExternalLines.set(filePath, existing);
    }

    this.externalChangesList = this.externalChangesList.filter(c => c.filePath !== filePath);

    // Update baseline to current file content so the external change
    // is reflected in future diffs.
    try {
      const current = readFileSync(filePath, "utf8");
      this.fileBaselines.set(filePath, current);
      this.fileLastKnown.set(filePath, current);
    } catch {
      this.fileBaselines.delete(filePath);
      this.fileLastKnown.delete(filePath);
    }
    this.emitUpdate();
  }

  /**
   * Acknowledge and remove all external changes.
   */
  acknowledgeAllExternalChanges(): void {
    if (this.externalChangesList.length === 0) return;

    // Save all changed lines before clearing
    for (const ec of this.externalChangesList) {
      if (ec.changedLines.length > 0) {
        const existing = this.acknowledgedExternalLines.get(ec.filePath) ?? new Set();
        for (const ln of ec.changedLines) existing.add(ln);
        this.acknowledgedExternalLines.set(ec.filePath, existing);
      }
    }

    const affectedFiles = new Set(this.externalChangesList.map(ec => ec.filePath));
    this.externalChangesList = [];
    for (const filePath of affectedFiles) {
      try {
        const current = readFileSync(filePath, "utf8");
        this.fileBaselines.set(filePath, current);
        this.fileLastKnown.set(filePath, current);
      } catch {
        this.fileBaselines.delete(filePath);
        this.fileLastKnown.delete(filePath);
      }
    }
    this.emitUpdate();
  }

  /**
   * Clear external changes for a specific file (e.g., after accept/revert).
   */
  clearExternalChanges(filePath: string): void {
    const before = this.externalChangesList.length;
    this.externalChangesList = this.externalChangesList.filter(c => c.filePath !== filePath);
    if (this.externalChangesList.length !== before) this.emitUpdate();
  }

  /**
   * Clear all external changes.
   */
  clearAllExternalChanges(): void {
    if (this.externalChangesList.length > 0) {
      this.externalChangesList = [];
      this.emitUpdate();
    }
  }

  // ------------------------------------------------------------------
  // Clear non-pending changes
  // ------------------------------------------------------------------

  /** Remove all non-pending (accepted/reverted) changes, history,
   *  and all associated per-file state (baselines, last-known, etc.)
   *  for files that have no remaining changes.
   *  @returns number of changes removed. */
  clearNonPending(): number {
    const before = this.changes.length;
    // Determine which files are being fully cleared (no pending changes
    // remaining — only accepted/reverted entries are being removed).
    const clearedFiles = new Set<string>();
    for (const c of this.changes) {
      if (c.status !== "pending") clearedFiles.add(c.filePath);
    }
    this.changes = this.changes.filter(c => c.status === "pending");
    // Remove cleared files from pending set (they may still have pending changes)
    for (const c of this.changes) clearedFiles.delete(c.filePath);

    this.history = [];
    this.externalChangesList = [];
    for (const fp of clearedFiles) {
      this.fileBaselines.delete(fp);
      this.fileLastKnown.delete(fp);
      this.acknowledgedExternalLines.delete(fp);
    }
    this.emitUpdate();
    return before - this.changes.length;
  }

  /** Remove all non-pending changes and all associated state for a file.
   *  Clears history, baselines, last-known content, acknowledged external
   *  lines, and external change entries for this file.
   *  @returns number of changes removed. */
  clearFile(filePath: string): number {
    const before = this.changes.length;
    this.changes = this.changes.filter(
      c => c.filePath !== filePath || c.status === "pending",
    );
    this.history = this.history.filter(h => h.filePath !== filePath);
    this.externalChangesList = this.externalChangesList.filter(ec => ec.filePath !== filePath);
    this.fileBaselines.delete(filePath);
    this.fileLastKnown.delete(filePath);
    this.acknowledgedExternalLines.delete(filePath);
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

    // Move external changed lines to acknowledged set so ⚡ icons persist
    // after accept — they're absorbed into the new baseline but still visually marked.
    const extLines = this.externalChangesList
      .filter(ec => ec.filePath === filePath)
      .flatMap(ec => ec.changedLines);
    if (extLines.length > 0) {
      const existing = this.acknowledgedExternalLines.get(filePath) ?? new Set();
      for (const ln of extLines) existing.add(ln);
      this.acknowledgedExternalLines.set(filePath, existing);
    }
    this.externalChangesList = this.externalChangesList.filter(ec => ec.filePath !== filePath);

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

      // Clear external changes for this file
      this.externalChangesList = this.externalChangesList.filter(ec => ec.filePath !== filePath);

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

    // Move external changed lines to acknowledged set for all accepted files
    if (count > 0) {
      const acceptedPaths = new Set(fileGroups.keys());
      for (const ec of this.externalChangesList) {
        if (acceptedPaths.has(ec.filePath) && ec.changedLines.length > 0) {
          const existing = this.acknowledgedExternalLines.get(ec.filePath) ?? new Set();
          for (const ln of ec.changedLines) existing.add(ln);
          this.acknowledgedExternalLines.set(ec.filePath, existing);
        }
      }
      this.externalChangesList = this.externalChangesList.filter(ec => !acceptedPaths.has(ec.filePath));
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

        // Clear external changes for this file
        this.externalChangesList = this.externalChangesList.filter(ec => ec.filePath !== filePath);
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

    // Start file watcher for detecting external changes
    this.watcher.start();
    log("registerHooks: file watcher started");
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
          const entries: Array<{ path: string; content: string; existed: boolean; hasExternal?: boolean }> = [];
          for (const relPath of affectedPaths) {
            const absPath = relPath.startsWith("/") ? relPath : join(this.cwd, relPath);
            // Skip files outside the project directory or matching .gitignore
            if (!this.shouldTrack(absPath)) {
              log("tool_call: bash path not tracked, skipping:", absPath);
              continue;
            }
            // Cancel pending watcher debounce and mark as agent-active
            // to prevent spurious external change detections.
            const rel = absPath.startsWith(this.cwd) ? relative(this.cwd, absPath) : relPath;
            this.watcher.cancelPending(rel);
            this._toolActiveFiles.set(absPath, Date.now());
            try {
              const content = readFileSync(absPath, "utf8");
              // Detect external changes for this specific file
              const lastKnown = this.fileLastKnown.get(absPath);
              const hasExternal = lastKnown !== undefined && lastKnown !== content;
              entries.push({ path: absPath, content, existed: true, hasExternal });
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

        // Skip files outside the project directory or matching .gitignore
        if (!this.shouldTrack(absPath)) {
          log("tool_call: path not tracked, skipping:", absPath);
          return;
        }

        // Cancel any pending watcher debounce for this file — prevents the
        // agent's own write from being detected as an external change.
        const relPath = filePath.startsWith(this.cwd) ? relative(this.cwd, absPath) : filePath;
        this.watcher.cancelPending(relPath);
        // Mark as being actively modified by the agent to prevent the
        // watcher from racing with tool_result's fileLastKnown update.
        this._toolActiveFiles.set(absPath, Date.now());

        try {
          const content = readFileSync(absPath, "utf8");
          this.originalContents.set(event.toolCallId, { content, existed: true });
          log("tool_call: stored original content, length:", content.length);
          // Detect external changes: file differs from last known agent state
          const lastKnown = this.fileLastKnown.get(absPath);
          if (lastKnown !== undefined && lastKnown !== content) {
            this.externalChangesDetected.set(event.toolCallId, true);
            log("tool_call: EXTERNAL CHANGES detected for", absPath);
          }
        } catch {
          this.originalContents.set(event.toolCallId, { content: "", existed: false });
          log("tool_call: file not found, marking as new file");
          // New files: still mark as tool-active until tool_result runs
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
    let entries: Array<{ path: string; content: string; existed: boolean; hasExternal?: boolean }>;
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
      // Safety check: skip files outside the project directory or matching .gitignore
      if (!this.shouldTrack(absPath)) {
        log("tool_result: bash path not tracked, skipping:", absPath);
        continue;
      }
      const originalContent = entry.content;
      const fileExistedAtToolCall = entry.existed;
      const hasExternal = entry.hasExternal ?? false;
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

      // Release the tool-active lock — bash is done modifying this file
      this._toolActiveFiles.delete(absPath);

      log("tool_result: bash, change pushed for", absPath);
    }

    if (changesAdded > 0) {
      log("tool_result: bash, total changes added:", changesAdded, "pending:", this.getPendingCount());
      this.emitUpdate();
      if (_ctx.hasUI) {
        _ctx.ui.setStatus("pi-review", `${this.getPendingCount()} pending`);
      }
    }

    return event;
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
    // Safety check: skip files outside the project directory or matching .gitignore
    if (!this.shouldTrack(absPath)) {
      log("tool_result: path not tracked, skipping:", absPath);
      this.originalContents.delete(event.toolCallId);
      return;
    }
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
    };

    change.fileExistsAtToolCall = fileExistedAtToolCall;
    this.changes.push(change);
    this.originalContents.delete(event.toolCallId);
    this.externalChangesDetected.delete(event.toolCallId);

    // Update last known state for this file
    if (!fileDeleted) {
      this.fileLastKnown.set(absPath, currentContent);
    } else {
      this.fileLastKnown.delete(absPath);
    }

    // Release the tool-active lock — agent is done modifying this file
    this._toolActiveFiles.delete(absPath);

    log("tool_result: change pushed, total:", this.changes.length, "pending:", this.getPendingCount());

    this.emitUpdate();

    if (_ctx.hasUI) {
      _ctx.ui.setStatus("pi-review", `${this.getPendingCount()} pending`);
    }

    return event;
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
      const fileExisted = first.fileExistsAtToolCall ?? true;

      // Read current content
      let currentContent = "";
      try {
        currentContent = readFileSync(filePath, "utf8");
      } catch {
        // File was deleted
        currentContent = "";
      }

      // Generate a fresh diff from original baseline to current content
      // whenever the file on disk differs from the baseline. This ensures
      // external changes (detected by watcher or acknowledged) show as hunks.
      let diff: string;
      if (baselineContent !== currentContent) {
        diff = this.generateDiff(baselineContent, currentContent, relPath);
      } else {
        diff = changes.map((c) => c.diff).join("\n");
      }

      fileDiffs.push({
        filePath,
        relativePath: relPath,
        diff,
        blocks: this.parseDiffBlocks(diff),
        originalContent: baselineContent,
        status,
        changeCount: changes.length,
        tools,
        firstChangeTime: allSorted[0].timestamp,
        lastChangeTime: allSorted[allSorted.length - 1].timestamp,
        fileExisted,
      });
    }

    // --- Second pass: annotate with external change info ---
    // This is separate from the main loop for clarity. It attaches
    // external change metadata (⚡ line markers, timestamps) to each
    // FileDiff, merging both active watcher entries and acknowledged
    // (historical) external changes.
    for (const fd of fileDiffs) {
      const fileExtChanges = this.externalChangesList.filter(ec => ec.filePath === fd.filePath);
      const currentExtLines = fileExtChanges.flatMap(ec => ec.changedLines);
      const acknowledgedLines = [...(this.acknowledgedExternalLines.get(fd.filePath) ?? [])];
      const allExtLines = [...new Set([...currentExtLines, ...acknowledgedLines])].sort((a, b) => a - b);
      fd.externalChangedLines = allExtLines.length > 0 ? allExtLines : undefined;
      fd.externalChangeTime = fileExtChanges.length > 0
        ? Math.max(...fileExtChanges.map(ec => ec.timestamp))
        : undefined;
      fd.hasExternalChanges = fd.externalChangedLines !== undefined ||
        this.changes.some(c => c.filePath === fd.filePath && c.status === "pending" && c.hasExternalChanges);
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
  // Project scope guard
  // ------------------------------------------------------------------

  /**
   * Check whether an absolute path is within the project directory.
   * Files outside the project scope are not tracked for either agent
   * or external changes.
   */
  /**
   * Check whether a file should be tracked at all.
   * Returns false if the path is outside the project directory or
   * matches a .gitignore pattern.
   */
  private shouldTrack(absPath: string): boolean {
    if (!absPath) return false;
    if (!absPath.startsWith(this.cwd)) return false;
    if (this.gitignore.isIgnored(absPath)) return false;
    return true;
  }

  private isWithinProject(absPath: string): boolean {
    if (!absPath) return false;
    return absPath.startsWith(this.cwd);
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
      const tmpDir = join(this.reviewDir, "tmp");
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

  /** Save full tracker state to .pi/pi-review/state.json. */
  private saveToDisk(): void {
    try {
      if (!existsSync(this.reviewDir)) mkdirSync(this.reviewDir, { recursive: true });
      // Snapshot all in-memory state atomically
      const snapshot = {
        changes: [...this.changes],
        history: [...this.history],
        nextId: this.nextId,
        nextCycleId: this.nextCycleId,
        fileBaselines: Object.fromEntries(this.fileBaselines),
        fileLastKnown: Object.fromEntries(this.fileLastKnown),
        _toolActiveFiles: [...this._toolActiveFiles.entries()],
        externalChanges: this.externalChangesList,
        acknowledgedExternalLines: Object.fromEntries(
          [...this.acknowledgedExternalLines.entries()].map(([k, s]) => [k, [...s]])
        ),
      };
      // Atomically write to a temp file then rename, preventing partial
      // writes if the process crashes mid-write or the file is read concurrently.
      const stateFile = join(this.reviewDir, "state.json");
      const tmpFile = join(this.reviewDir, "state.json.tmp");
      const data = JSON.stringify(snapshot, null, 2);
      writeFileSync(tmpFile, data, "utf8");
      rmSync(stateFile, { force: true });
      renameSync(tmpFile, stateFile);
    } catch (err) {
      log("saveToDisk: ERROR:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Load tracker state from .pi/pi-review/state.json.
   *
   * Persistence contract:
   *   PERSISTS  → changes, history, counters, fileBaselines, externalChangesList,
   *               acknowledgedExternalLines
   *   RESETS    → fileLastKnown is rebuilt from current disk content so the
   *               watcher only detects changes that happen AFTER reload
   */
  private loadFromDisk(): void {
    const stateFile = join(this.reviewDir, "state.json");

    // Backward-compat: migrate from old .pi-review/ path to .pi/pi-review/
    if (!existsSync(stateFile)) {
      const oldStateFile = join(this.cwd, ".pi-review", "state.json");
      if (existsSync(oldStateFile)) {
        try {
          mkdirSync(dirname(stateFile), { recursive: true });
          renameSync(oldStateFile, stateFile);
          // Clean up old tmp dir if it exists
          const oldTmpDir = join(this.cwd, ".pi-review-tmp");
          if (existsSync(oldTmpDir)) {
            try { rmSync(oldTmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
          }
          // Remove old .pi-review dir if empty
          try { rmSync(dirname(oldStateFile), { force: true }); } catch { /* ignore */ }
          log("loadFromDisk: migrated state from .pi-review/ to .pi/pi-review/");
        } catch (err) {
          log("loadFromDisk: migration failed:", err instanceof Error ? err.message : String(err));
          return;
        }
      } else {
        return;
      }
    }

    let raw: string;
    try {
      raw = readFileSync(stateFile, "utf8");
    } catch {
      log("loadFromDisk: could not read state file");
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      log("loadFromDisk: state file is corrupt JSON, resetting");
      rmSync(stateFile, { force: true });
      return;
    }

    // ── PERSIST across reloads ─────────────────────────────────────
    // Each section loaded independently — one bad field can't wipe others.

    try { if (Array.isArray(data.changes)) this.changes = data.changes; }
    catch { log("loadFromDisk: ignoring bad changes"); }
    try { if (Array.isArray(data.history)) this.history = data.history; }
    catch { log("loadFromDisk: ignoring bad history"); }
    try { if (typeof data.nextId === "number") this.nextId = data.nextId; }
    catch { log("loadFromDisk: ignoring bad nextId"); }
    try { if (typeof data.nextCycleId === "number") this.nextCycleId = data.nextCycleId; }
    catch { log("loadFromDisk: ignoring bad nextCycleId"); }

    try {
      if (data.fileBaselines && typeof data.fileBaselines === "object") {
        this.fileBaselines.clear();
        for (const [k, v] of Object.entries(data.fileBaselines as Record<string, unknown>)) {
          if (typeof v === "string") this.fileBaselines.set(k, v);
        }
      }
    } catch { log("loadFromDisk: ignoring bad fileBaselines"); }

    try {
      if (data.externalChanges && Array.isArray(data.externalChanges)) {
        this.externalChangesList = data.externalChanges as ExternalFileChange[];
        for (const ec of this.externalChangesList) {
          if (ec.id && ec.id.startsWith("ext-")) {
            const num = parseInt(ec.id.replace("ext-", ""), 10);
            if (num >= this.nextExternalId) this.nextExternalId = num + 1;
          }
        }
      }
    } catch { log("loadFromDisk: ignoring bad externalChanges"); }

    try {
      if (data.acknowledgedExternalLines && typeof data.acknowledgedExternalLines === "object") {
        this.acknowledgedExternalLines.clear();
        for (const [k, lines] of Object.entries(data.acknowledgedExternalLines as Record<string, unknown>)) {
          if (Array.isArray(lines)) this.acknowledgedExternalLines.set(k, new Set(lines as number[]));
        }
      }
    } catch { log("loadFromDisk: ignoring bad acknowledgedExternalLines"); }

    // Restore agent-tool-active files from persisted state so external
    // change detection survives extension reloads. Expire entries older
    // than 60 seconds — they're stale from a crashed/aborted tool call.
    try {
      if (data._toolActiveFiles && Array.isArray(data._toolActiveFiles)) {
        const expiry = Date.now() - 60_000;
        this._toolActiveFiles.clear();
        for (const [path, ts] of data._toolActiveFiles as Array<[string, number]>) {
          if (typeof path === "string" && typeof ts === "number" && ts > expiry) {
            this._toolActiveFiles.set(path, ts);
          }
        }
      }
    } catch { log("loadFromDisk: ignoring bad _toolActiveFiles"); }

    // ── RESET on reload ────────────────────────────────────────────
    // fileLastKnown is rebuilt from current disk content so the watcher
    // only flags files that change WHILE it's running, not files that
    // were legitimately modified before the reload.
    this.fileLastKnown.clear();
    const allTrackedFiles = new Set([
      ...this.changes.map(c => c.filePath),
      ...this.externalChangesList.map(ec => ec.filePath),
      ...this.acknowledgedExternalLines.keys(),
    ]);
    for (const absPath of allTrackedFiles) {
      try {
        const current = readFileSync(absPath, "utf8");
        this.fileLastKnown.set(absPath, current);
      } catch {
        // File doesn't exist — skip
      }
    }

    log("loadFromDisk: loaded", this.changes.length, "changes,", this.history.length, "history entries, ",
      this.externalChangesList.length, "external, ", this.acknowledgedExternalLines.size, "ackLines");
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
   * Build an annotated code block with diff prefixes.
   * Each line is prefixed with + (added), - (removed), or space (context).
   * Falls back to plain code if no per-line type info available.
   */
  private buildAnnotatedCodeBlock(code: string, lines?: Array<{ content: string; type: "add" | "del" | "ctx" }>): string {
    if (!lines || lines.length === 0) {
      return code;
    }
    return lines.map((l) => {
      const prefix = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      return `${prefix}${l.content}`;
    }).join("\n");
  }

  /**
   * Emit a code reference question to the agent.
   * Formats the selected code + user question and sends as a prompt.
   * Code block lines are annotated with diff prefixes (+/-/ ) when available.
   */
  emitReference(params: {
    filePath: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    code: string;
    lines?: Array<{ content: string; type: "add" | "del" | "ctx" }>;
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
      const hasLineTypes = params.lines && params.lines.length > 0;
      const annotatedCode = this.buildAnnotatedCodeBlock(params.code, params.lines);
      promptParts.push("", "**Selected code:**", "```");
      promptParts.push(annotatedCode);
      promptParts.push("```");
      if (hasLineTypes) {
        promptParts.push("");
        promptParts.push("**Legend:** Lines prefixed with `+` were **added**, `-` were **removed**, and ` ` (space) are **unchanged context**. Use these markers to understand which lines are new changes vs existing code.");
      }
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
    lines?: Array<{ content: string; type: "add" | "del" | "ctx" }>;
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
      const hasLineTypes = params.lines && params.lines.length > 0;
      const annotatedCode = this.buildAnnotatedCodeBlock(params.code, params.lines);
      promptParts.push("", "**Original code:**", "```");
      promptParts.push(annotatedCode);
      promptParts.push("```");
      if (hasLineTypes) {
        promptParts.push("");
        promptParts.push("**Legend:** Lines prefixed with `+` were **added**, `-` were **removed**, and ` ` (space) are **unchanged context**. Use these markers to understand which lines are new changes vs existing code.");
      }
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
      if (this.pendingChatResponse) {
        this.chatResponses.push({ text: text.trim(), timestamp: Date.now() });
        this.pendingChatResponse = false;
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

  /** Send a chat message to the agent. */
  sendChat(message: string): void {
    this.pi.sendUserMessage(message);
    this.pendingChatResponse = true;
  }

  /** If set, we're waiting for a chat response. */
  private pendingChatResponse = false;

  /** Collected chat responses. */
  private chatResponses: Array<{ text: string; timestamp: number }> = [];

  /** Get and clear chat responses. */
  drainChatResponses(): Array<{ text: string; timestamp: number }> {
    const responses = [...this.chatResponses];
    this.chatResponses = [];
    return responses;
  }

}
