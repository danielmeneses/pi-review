/**
 * FileWatcher — monitors the project directory tree for external file changes.
 *
 * Detects modifications made outside the agent (user editor, TUI, git ops, etc.)
 * and records which lines changed. The watcher is debounced per-file to avoid
 * noisy events from rapid saves.
 *
 * Usage:
 *   const watcher = new FileWatcher(projectRoot);
 *   watcher.onExternalChange((filePath, content, lastKnownContent) => { ... });
 *   watcher.start();
 *   // ... later
 *   watcher.stop();
 *
 * The watcher excludes:
 *   - .git/ directory
 *   - .pi/ directory (pi metadata including pi-review state)
 *   - node_modules/ directory
 *   - dist/ directory (build artifacts)
 *   - Any paths explicitly excluded by the user/system
 */

import { watch, readFileSync, existsSync } from "node:fs";
import { relative, join } from "node:path";
import { appendFileSync } from "node:fs";
import { GitignoreMatcher } from "./gitignore.js";

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  if (process.env.PI_REVIEW_DEBUG === "1") {
    console.error("[pi-review:watcher]", ...args);
  }
  const logFile = process.env.PI_REVIEW_LOG_FILE;
  if (logFile) {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] [watcher] ${args.join(" ")}\n`, "utf8");
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Excluded directory patterns
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".pi",
  "dist",
  ".cache",
]);

/**
 * Check whether a path should be excluded from watching.
 */
function isExcluded(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts.some(p => EXCLUDED_DIRS.has(p));
}

// ---------------------------------------------------------------------------
// Callback type
// ---------------------------------------------------------------------------

export type ExternalChangeCallback = (
  filePath: string,
  currentContent: string,
  lastKnownContent: string,
  relPath: string,
) => void;

// ---------------------------------------------------------------------------
// FileWatcher
// ---------------------------------------------------------------------------

export class FileWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;
  private debounceMs: number;
  /**
   * Timestamp when the watcher started. Events within the first N ms
   * are ignored to avoid false positives from initial fs.watch scans
   * (inotify on Linux can fire events for existing files on setup).
   */
  private startedAt = 0;
  private startupGraceMs = 2000;

  constructor(
    private cwd: string,
    private onExternalChange: ExternalChangeCallback,
    private getLastKnown: (filePath: string) => string | undefined,
    debounceMs = 300,
  ) {
    this.debounceMs = debounceMs;
    this.gitignore = new GitignoreMatcher(cwd);
  }

  private gitignore: GitignoreMatcher;

  /** Start watching the project directory tree. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    try {
      // Use recursive watcher (available since Node 19.1+)
      // Falls back to non-recursive on older systems
      this.watcher = watch(this.cwd, { recursive: true });
      log("start: recursive watcher created for", this.cwd);

      this.watcher.on("change", (eventType: string, filename: string | null) => {
        this.handleChange(eventType, filename);
      });

      this.watcher.on("error", (err: Error) => {
        log("error:", err.message);
      });
    } catch (err) {
      log("start: ERROR creating watcher:", err instanceof Error ? err.message : String(err));
      // If recursive fails, try non-recursive
      try {
        this.watcher = watch(this.cwd);
        log("start: non-recursive fallback watcher");
        this.watcher.on("change", (eventType: string, filename: string | null) => {
          this.handleChange(eventType, filename);
        });
      } catch (err2) {
        log("start: ERROR creating fallback watcher:", err2 instanceof Error ? err2.message : String(err2));
        this.running = false;
      }
    }
  }

  /** Stop watching. Clears all debounce timers. */
  stop(): void {
    this.running = false;

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    log("stop: watcher stopped");
  }

  /** Whether the watcher is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  // ------------------------------------------------------------------
  // Change handling
  // ------------------------------------------------------------------

  /**
   * Handle a file system change event.
   * Debounces per file — only fires after `debounceMs` of inactivity.
   */
  private handleChange(eventType: string, filename: string | null): void {
    if (!filename || !this.running) return;

    // Ignore events during the startup grace period to avoid reporting
    // existing files as external changes (inotify can fire initial scans).
    if (Date.now() - this.startedAt < this.startupGraceMs) return;

    // Normalize to relative path
    const relPath = filename.startsWith("/")
      ? relative(this.cwd, filename)
      : filename;

    // Skip excluded directories
    if (isExcluded(relPath)) return;

    // Resolve to absolute path
    const absPath = join(this.cwd, relPath);

    // Double-check the resolved path is within the project root
    if (!absPath.startsWith(this.cwd)) {
      log("handleChange: path outside project, skipping:", absPath);
      return;
    }

    // Skip files matching .gitignore patterns
    if (this.gitignore.isIgnored(relPath)) {
      log("handleChange: path matches .gitignore, skipping:", relPath);
      return;
    }

    // Only watch files (skip if directory or doesn't exist)
    // We check existence on debounce fire, not here

    // Cancel existing debounce timer
    const existing = this.debounceTimers.get(relPath);
    if (existing) clearTimeout(existing);

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(relPath);
      this.fireChange(absPath, relPath);
    }, this.debounceMs);

    this.debounceTimers.set(relPath, timer);
  }

  /**
   * Fire an external change callback after debounce.
   * Reads the file, compares with last known state, and calls the callback.
   */
  private fireChange(absPath: string, relPath: string): void {
    if (!this.running) return;

    // Read current file content
    let currentContent: string;
    try {
      currentContent = readFileSync(absPath, "utf8");
    } catch {
      // File was deleted — we can detect via agent tool results
      // but for external deletions we note it
      log("fireChange: file not found, skipping:", absPath);
      return;
    }

    // Get last known content
    const lastKnown = this.getLastKnown(absPath);

    // If no last known state, the agent never touched this file.
    // Skip — we only flag external changes for files the agent has
    // worked with, not every file in the project tree.
    if (lastKnown === undefined) {
      return;
    }

    if (lastKnown === currentContent) {
      // Content hasn't changed — skip (this can happen when tool results
      // write content and the watcher fires before fileLastKnown is updated)
      return;
    }

    log("fireChange: external change detected for", relPath);
    this.onExternalChange(absPath, currentContent, lastKnown, relPath);
  }

  /**
   * Force-check a specific file for external changes (used after agent actions).
   * This clears the debounce for that file and checks immediately.
   */
  forceCheck(absPath: string): void {
    const relPath = relative(this.cwd, absPath);

    // Cancel any pending debounce
    const existing = this.debounceTimers.get(relPath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(relPath);
    }

    this.fireChange(absPath, relPath);
  }

  /**
   * Cancel any pending debounce for a file (useful when agent is about to modify it).
   */
  cancelPending(relPath: string): void {
    const existing = this.debounceTimers.get(relPath);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(relPath);
    }
  }

  /**
   * Get the set of files currently pending debounce checks.
   */
  getPendingPaths(): string[] {
    return [...this.debounceTimers.keys()];
  }
}
