/**
 * Mock tracker implementation for E2E testing.
 *
 * Implements TrackerInterface with in-memory data so the server
 * can be tested without the full PI extension runtime.
 */

import type { TrackerInterface, TrackedChange, FileDiff, AggregatedState } from "../../src/types.js";

/**
 * A simple in-memory tracker for testing the server and UI.
 * Supports seeding changes, accept/revert operations, and SSE updates.
 */
export class MockTracker implements TrackerInterface {
  private changes: TrackedChange[] = [];
  private nextId = 1;
  private history: any[] = []; // ChangeCycle[]
  private nextCycleId = 1;
  private onBroadcast?: () => void;

  /** Set a callback invoked when broadcastUpdate is called. */
  setBroadcastCallback(cb: () => void): void {
    this.onBroadcast = cb;
  }

  /**
   * Seed the tracker with sample changes for testing.
   * @param changes - Array of partial change objects to add.
   */
  seedChanges(changes: Partial<TrackedChange>[]): void {
    for (const partial of changes) {
      this.changes.push({
        id: `change-${this.nextId++}`,
        filePath: partial.filePath ?? `/tmp/test/${partial.relativePath ?? "test.txt"}`,
        relativePath: partial.relativePath ?? "test.txt",
        toolName: partial.toolName ?? "edit",
        timestamp: partial.timestamp ?? Date.now(),
        originalContent: partial.originalContent ?? "",
        diff: partial.diff ?? "",
        status: partial.status ?? "pending",
        toolCallId: partial.toolCallId ?? `tool-${this.nextId}`,
        fileExistsAtToolCall: partial.fileExistsAtToolCall ?? true,
        baselineContent: partial.baselineContent ?? partial.originalContent ?? "",
      });
    }
  }

  getChanges(): TrackedChange[] {
    return [...this.changes];
  }

  getState(): { changes: TrackedChange[]; nextId: number } {
    return { changes: this.getChanges(), nextId: this.nextId };
  }

  getAggregatedState(): AggregatedState {
    // Group by filePath for file diffs
    const fileMap = new Map<string, TrackedChange[]>();
    for (const change of this.changes) {
      const group = fileMap.get(change.filePath) ?? [];
      group.push(change);
      fileMap.set(change.filePath, group);
    }

    const fileDiffs: FileDiff[] = [];
    for (const [filePath, fileChanges] of fileMap) {
      const pending = fileChanges.filter(c => c.status === "pending");
      const accepted = fileChanges.filter(c => c.status === "accepted");
      const reverted = fileChanges.filter(c => c.status === "reverted");

      let status: "pending" | "accepted" | "reverted";
      if (pending.length > 0) status = "pending";
      else if (reverted.length > 0) status = "reverted";
      else status = "accepted";

      const first = fileChanges[0];
      fileDiffs.push({
        filePath,
        relativePath: first.relativePath,
        diff: first.diff,
        blocks: [],
        originalContent: first.originalContent,
        status,
        changeCount: fileChanges.length,
        tools: [...new Set(fileChanges.map(c => c.toolName))],
        firstChangeTime: fileChanges[0].timestamp,
        lastChangeTime: fileChanges[fileChanges.length - 1].timestamp,
        fileExisted: first.fileExistsAtToolCall ?? true,
        hasExternalChanges: false,
        externalLineNums: [],
        externalLineContents: [],
      });
    }

    return {
      fileDiffs,
      history: this.history,
      rawChanges: this.changes,
      nextId: this.nextId,
      nextCycleId: this.nextCycleId,
    };
  }

  getPendingCount(): number {
    return this.changes.filter(c => c.status === "pending").length;
  }

  accept(id: string): boolean {
    const change = this.changes.find(c => c.id === id);
    if (!change || change.status !== "pending") return false;
    change.status = "accepted";
    return true;
  }

  revert(id: string): boolean {
    const change = this.changes.find(c => c.id === id);
    if (!change || change.status !== "pending") return false;
    change.status = "reverted";
    return true;
  }

  acceptFile(filePath: string): number {
    const pending = this.changes.filter(c => c.filePath === filePath && c.status === "pending");
    for (const change of pending) {
      change.status = "accepted";
    }
    if (pending.length > 0) {
      this.history.push({
        id: `cycle-${this.nextCycleId++}`,
        filePath,
        relativePath: pending[0].relativePath,
        diff: pending.map(c => c.diff).join("\n"),
        action: "accepted",
        timestamp: Date.now(),
        changeCount: pending.length,
        tools: [...new Set(pending.map(c => c.toolName))],
      });
    }
    return pending.length;
  }

  revertFile(filePath: string): number {
    const pending = this.changes.filter(c => c.filePath === filePath && c.status === "pending");
    for (const change of pending) {
      change.status = "reverted";
    }
    if (pending.length > 0) {
      this.history.push({
        id: `cycle-${this.nextCycleId++}`,
        filePath,
        relativePath: pending[0].relativePath,
        diff: pending.map(c => c.diff).join("\n"),
        action: "reverted",
        timestamp: Date.now(),
        changeCount: pending.length,
        tools: [...new Set(pending.map(c => c.toolName))],
      });
    }
    return pending.length;
  }

  acceptAll(): number {
    const pending = this.changes.filter(c => c.status === "pending");
    for (const change of pending) {
      change.status = "accepted";
    }
    if (pending.length > 0) {
      this.history.push({
        id: `cycle-${this.nextCycleId++}`,
        filePath: pending[0].filePath,
        relativePath: pending[0].relativePath,
        diff: pending.map(c => c.diff).join("\n"),
        action: "accepted",
        timestamp: Date.now(),
        changeCount: pending.length,
        tools: [...new Set(pending.map(c => c.toolName))],
      });
    }
    return pending.length;
  }

  revertAll(): number {
    const pending = this.changes.filter(c => c.status === "pending");
    for (const change of pending) {
      change.status = "reverted";
    }
    if (pending.length > 0) {
      this.history.push({
        id: `cycle-${this.nextCycleId++}`,
        filePath: pending[0].filePath,
        relativePath: pending[0].relativePath,
        diff: pending.map(c => c.diff).join("\n"),
        action: "reverted",
        timestamp: Date.now(),
        changeCount: pending.length,
        tools: [...new Set(pending.map(c => c.toolName))],
      });
    }
    return pending.length;
  }

  clearNonPending(): number {
    const before = this.changes.length;
    this.changes = this.changes.filter(c => c.status === "pending");
    this.history = [];
    if (this.onBroadcast) this.onBroadcast();
    return before - this.changes.length;
  }

  clearFile(filePath: string): number {
    const before = this.changes.length;
    this.changes = this.changes.filter(
      c => c.filePath !== filePath || c.status === "pending",
    );
    this.history = this.history.filter(h => h.filePath !== filePath);
    if (this.onBroadcast) this.onBroadcast();
    return before - this.changes.length;
  }

  drainCommentResponses(): Array<{ text: string; timestamp: number }> {
    return [];
  }
}
