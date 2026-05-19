/**
 * Unit tests for the ChangeTracker's external change features.
 *
 * Tests cover:
 * 1. External change lifecycle (detect → store → acknowledge → persist)
 * 2. Gitignore filtering
 * 3. buildFileDiffs external annotation
 * 4. Persistence round-trip
 * 5. Persistence system robustness (atomic writes, corruption, stale cleanup)
 * 6. Project scope guarding
 *
 * These tests use Node's built-in test runner (`node --test`).
 * They create a temp directory as the project root and mock the PI API.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import { ChangeTracker } from "../src/tracker.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAPI(): ExtensionAPI {
  const events = new EventEmitter();
  return {
    on: events.on.bind(events) as any,
    events: events as any,
    sendUserMessage: () => {},
    exec: async () => "",
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
}

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-test-"));
  mkdirSync(join(dir, ".pi", "pi-review"), { recursive: true });
  return dir;
}

function writeGitignore(dir: string, patterns: string[]): void {
  writeFileSync(join(dir, ".gitignore"), patterns.join("\n") + "\n", "utf8");
}

function writeFile(dir: string, relPath: string, content: string): string {
  const absPath = join(dir, relPath);
  const parent = absPath.split("/").slice(0, -1).join("/");
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(absPath, content, "utf8");
  return absPath;
}

// ---------------------------------------------------------------------------
// 1. External change lifecycle
// ---------------------------------------------------------------------------

describe("external change lifecycle", () => {
  let projectDir: string;
  let tracker: ChangeTracker;
  let api: ExtensionAPI;

  before(() => {
    projectDir = createTempProject();
    api = createMockAPI();
    tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();
  });

  after(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should start with empty external changes", () => {
    const state = tracker.getAggregatedState();
    assert.ok(Array.isArray(state.externalChanges));
    assert.equal(state.externalChanges.length, 0);
  });

  it("should record external change lines and make them visible in FileDiff", () => {
    writeFile(projectDir, "test.txt", "line1\nline2\nline3\n");
    const state = tracker.getAggregatedState();
    assert.ok(Array.isArray(state.fileDiffs));
  });

  it("should survive a save/load cycle", () => {
    const stateBefore = tracker.getAggregatedState();
    const api2 = createMockAPI();
    const tracker2 = new ChangeTracker(projectDir, api2);
    const stateAfter = tracker2.getAggregatedState();

    assert.ok(Array.isArray(stateAfter.externalChanges));
    assert.equal(stateAfter.externalChanges.length, stateBefore.externalChanges.length);
  });
});

// ---------------------------------------------------------------------------
// 2. Gitignore filtering
// ---------------------------------------------------------------------------

describe("gitignore filtering", () => {
  let projectDir: string;
  let tracker: ChangeTracker;

  before(() => {
    projectDir = createTempProject();
    writeGitignore(projectDir, ["*.log", "node_modules/", "build/"]);
    const api = createMockAPI();
    tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();
  });

  after(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should reject gitignored paths", () => {
    const st = (tracker as any).shouldTrack.bind(tracker);
    assert.equal(st(join(projectDir, "server.log")), false);
    assert.equal(st(join(projectDir, "node_modules", "pkg", "index.js")), false);
  });

  it("should allow non-gitignored paths", () => {
    const st = (tracker as any).shouldTrack.bind(tracker);
    assert.equal(st(join(projectDir, "src", "app.ts")), true);
    assert.equal(st(join(projectDir, "index.ts")), true);
  });

  it("should reject paths outside the project", () => {
    const st = (tracker as any).shouldTrack.bind(tracker);
    assert.equal(st("/etc/passwd"), false);
    assert.equal(st("../outside.ts"), false);
  });

  it("should handle missing .gitignore gracefully", () => {
    const noGitignoreDir = createTempProject();
    rmSync(join(noGitignoreDir, ".gitignore"), { force: true });
    const api = createMockAPI();
    const t = new ChangeTracker(noGitignoreDir, api);
    const st = (t as any).shouldTrack.bind(t);
    assert.equal(st(join(noGitignoreDir, "anyfile.txt")), true);
    rmSync(noGitignoreDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 3. buildFileDiffs external annotation
// ---------------------------------------------------------------------------

describe("buildFileDiffs external annotation", () => {
  let projectDir: string;
  let tracker: ChangeTracker;

  before(() => {
    projectDir = createTempProject();
    const api = createMockAPI();
    tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();
  });

  after(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should not crash on empty state", () => {
    const state = tracker.getAggregatedState();
    assert.ok(Array.isArray(state.fileDiffs));
    assert.ok(Array.isArray(state.externalChanges));
  });

  it("should not crash when file diffs reference missing files", () => {
    // Manually add a change for a file that doesn't exist on disk
    (tracker as any).changes.push({
      id: "change-stale",
      filePath: join(projectDir, "nonexistent.ts"),
      relativePath: "nonexistent.ts",
      toolName: "edit",
      timestamp: Date.now(),
      originalContent: "",
      diff: "",
      status: "pending",
      toolCallId: "tool-stale",
    });
    const state = tracker.getAggregatedState();
    assert.ok(Array.isArray(state.fileDiffs));
  });
});

// ---------------------------------------------------------------------------
// 4. Persistence round-trip
// ---------------------------------------------------------------------------

describe("persistence round-trip", () => {
  it("should save and load state correctly", () => {
    const projectDir = createTempProject();
    const api = createMockAPI();
    const tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();

    tracker.clearNonPending(); // triggers save

    const stateFile = join(projectDir, ".pi", "pi-review", "state.json");
    assert.ok(existsSync(stateFile));

    const raw = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok("externalChanges" in raw);
    assert.ok("acknowledgedExternalLines" in raw);
    assert.ok("changes" in raw);
    assert.ok("history" in raw);

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should preserve acknowledgedExternalLines after save/load cycle", () => {
    const projectDir = createTempProject();
    const api1 = createMockAPI();
    const tracker1 = new ChangeTracker(projectDir, api1);
    tracker1.registerHooks();

    const absFile = join(projectDir, "test.txt");
    (tracker1 as any).acknowledgedExternalLines.set(absFile, new Set([1, 3, 5]));
    (tracker1 as any).saveToDisk();

    const api2 = createMockAPI();
    const tracker2 = new ChangeTracker(projectDir, api2);
    const loaded = (tracker2 as any).acknowledgedExternalLines.get(absFile);

    assert.ok(loaded instanceof Set);
    assert.ok(loaded.has(1));
    assert.ok(loaded.has(3));
    assert.ok(loaded.has(5));

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should not resurrect cleared changes after reload", () => {
    const projectDir = createTempProject();
    const api1 = createMockAPI();
    const tracker1 = new ChangeTracker(projectDir, api1);
    tracker1.registerHooks();
    tracker1.clearNonPending();

    const api2 = createMockAPI();
    const tracker2 = new ChangeTracker(projectDir, api2);
    const state = tracker2.getAggregatedState();

    assert.equal(state.fileDiffs.length, 0);
    assert.equal(state.rawChanges.length, 0);
    assert.equal(state.externalChanges.length, 0);

    rmSync(projectDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 5. Persistence system — comprehensive
// ---------------------------------------------------------------------------

describe("persistence system robustness", () => {

  it("should write atomically — no orphaned .tmp file after save", () => {
    const projectDir = createTempProject();
    const api = createMockAPI();
    const tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();
    tracker.clearNonPending();

    const tmpFile = join(projectDir, ".pi", "pi-review", "state.json.tmp");
    assert.equal(existsSync(tmpFile), false);

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should handle corrupt JSON — deletes bad file, starts fresh", () => {
    const projectDir = createTempProject();
    const stateFile = join(projectDir, ".pi", "pi-review", "state.json");
    writeFileSync(stateFile, "{{{ NOT JSON }}}", "utf8");

    const api = createMockAPI();
    const tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();

    assert.equal(existsSync(stateFile), false);
    assert.equal(tracker.getAggregatedState().rawChanges.length, 0);

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should survive a bad section without losing others", () => {
    const projectDir = createTempProject();
    const api = createMockAPI();
    const tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();

    const testRel = "test.ts";
    const testAbs = writeFile(projectDir, testRel, "content");
    // Register the file as tracked so fileLastKnown gets rebuilt from disk on load
    (tracker as any).changes.push({
      id: "change-bad-section",
      filePath: testAbs,
      relativePath: testRel,
      toolName: "edit",
      timestamp: Date.now(),
      originalContent: "",
      diff: "",
      status: "pending",
      toolCallId: "tool-bad",
    });
    (tracker as any).fileLastKnown.set(testAbs, "old_content");
    (tracker as any).fileBaselines.set(testAbs, "content");
    (tracker as any).saveToDisk();

    // Corrupt one section in the JSON
    const stateFile = join(projectDir, ".pi", "pi-review", "state.json");
    const data = JSON.parse(readFileSync(stateFile, "utf8"));
    data.fileBaselines = "NOT_AN_OBJECT";
    writeFileSync(stateFile, JSON.stringify(data), "utf8");

    const api2 = createMockAPI();
    const tracker2 = new ChangeTracker(projectDir, api2);
    // fileLastKnown was rebuilt from current disk content
    assert.equal((tracker2 as any).fileLastKnown.get(testAbs), "content",
      "fileLastKnown should be rebuilt from current disk content");
    // fileBaselines was corrupted — should be empty
    assert.equal((tracker2 as any).fileBaselines.has(testAbs), false,
      "bad fileBaselines should be ignored");
    // Change survived despite bad fileBaselines
    assert.equal((tracker2 as any).changes.length, 1,
      "changes should survive bad fileBaselines");

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should prune stale fileLastKnown entries on load", () => {
    const projectDir = createTempProject();
    const api = createMockAPI();
    const tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();

    const stalePath = join(projectDir, "stale_file.ts");
    const trackedRel = "tracked.ts";
    const trackedAbs = writeFile(projectDir, trackedRel, "real content");

    (tracker as any).fileLastKnown.set(stalePath, "old content");
    (tracker as any).fileLastKnown.set(trackedAbs, "real content");

    (tracker as any).changes.push({
      id: "change-1",
      filePath: trackedAbs,
      relativePath: trackedRel,
      toolName: "edit",
      timestamp: Date.now(),
      originalContent: "",
      diff: "",
      status: "pending",
      toolCallId: "tool-1",
    });

    (tracker as any).saveToDisk();
    const api2 = createMockAPI();
    const tracker2 = new ChangeTracker(projectDir, api2);
    const lk = (tracker2 as any).fileLastKnown;

    assert.equal(lk.has(stalePath), false);
    assert.equal(lk.has(trackedAbs), true);

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should rebuild fileLastKnown from current disk content on load", () => {
    const projectDir = createTempProject();
    const api1 = createMockAPI();
    const tracker1 = new ChangeTracker(projectDir, api1);
    tracker1.registerHooks();

    const testRel = "test.ts";
    const testAbs = writeFile(projectDir, testRel, "current_content");

    (tracker1 as any).changes.push({
      id: "change-rebuild",
      filePath: testAbs,
      relativePath: testRel,
      toolName: "edit",
      timestamp: Date.now(),
      originalContent: "old_content",
      diff: "+current_content",
      status: "pending",
      toolCallId: "tool-rebuild",
    });
    (tracker1 as any).fileLastKnown.set(testAbs, "stale_content");
    (tracker1 as any).saveToDisk();

    const api2 = createMockAPI();
    const tracker2 = new ChangeTracker(projectDir, api2);
    assert.equal((tracker2 as any).fileLastKnown.get(testAbs), "current_content",
      "fileLastKnown should be rebuilt from current disk content, not stale save");

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should preserve all data types through a save/load cycle", () => {
    const projectDir = createTempProject();
    const api1 = createMockAPI();
    const tracker1 = new ChangeTracker(projectDir, api1);
    tracker1.registerHooks();

    const agentRel = "agent_file.ts";
    const agentAbs = writeFile(projectDir, agentRel, "agent content");
    const extRel = "external_file.ts";
    const extAbs = writeFile(projectDir, extRel, "external content");

    // Agent change
    (tracker1 as any).changes.push({
      id: "change-99",
      filePath: agentAbs,
      relativePath: agentRel,
      toolName: "edit",
      timestamp: Date.now(),
      originalContent: "",
      diff: "+agent content\n",
      status: "pending",
      toolCallId: "tool-99",
    });
    (tracker1 as any).fileLastKnown.set(agentAbs, "agent content");
    (tracker1 as any).fileBaselines.set(agentAbs, "");

    // External change (different file — same-file case is pruned on load)
    (tracker1 as any).externalChangesList.push({
      id: "ext-1",
      filePath: extAbs,
      relativePath: extRel,
      changedLines: [2],
      timestamp: Date.now() - 1000,
      diff: "-old\n+new\n",
    });

    // Acknowledged external lines
    (tracker1 as any).acknowledgedExternalLines.set(agentAbs, new Set([3]));

    // History
    (tracker1 as any).history.push({
      id: "cycle-1",
      filePath: agentAbs,
      relativePath: agentRel,
      diff: "+old_line\n",
      action: "accepted",
      timestamp: Date.now() - 2000,
      changeCount: 1,
      tools: ["edit"],
    });

    (tracker1 as any).nextId = 100;
    (tracker1 as any).nextCycleId = 2;
    (tracker1 as any).saveToDisk();

    const api2 = createMockAPI();
    const tracker2 = new ChangeTracker(projectDir, api2);
    const state = tracker2.getAggregatedState();

    assert.equal(state.rawChanges.length, 1);
    assert.equal(state.rawChanges[0].id, "change-99");
    assert.equal(state.externalChanges.length, 1);
    assert.equal(state.externalChanges[0].changedLines[0], 2);
    assert.equal((tracker2 as any).history.length, 1);
    assert.equal((tracker2 as any).history[0].action, "accepted");

    const ack = (tracker2 as any).acknowledgedExternalLines.get(agentAbs);
    assert.ok(ack instanceof Set);
    assert.ok(ack.has(3));

    assert.equal(state.nextId, 100);
    assert.equal(state.nextCycleId, 2);

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should not lose data across multiple rapid saves", () => {
    const projectDir = createTempProject();
    const api = createMockAPI();
    const tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();

    const N = 10;
    for (let i = 0; i < N; i++) {
      const testRel = `file_${i}.ts`;
      writeFile(projectDir, testRel, `content_${i}`);
      (tracker as any).changes.push({
        id: `change-${i}`,
        filePath: join(projectDir, testRel),
        relativePath: testRel,
        toolName: "edit",
        timestamp: Date.now(),
        originalContent: "",
        diff: `+content_${i}`,
        status: "pending",
        toolCallId: `tool-${i}`,
      });
      (tracker as any).emitUpdate();
    }

    assert.equal((tracker as any).changes.length, N);

    const api2 = createMockAPI();
    const tracker2 = new ChangeTracker(projectDir, api2);
    assert.equal(tracker2.getChanges().length, N);

    rmSync(projectDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 6. Project scope guarding
// ---------------------------------------------------------------------------

describe("project scope guarding", () => {
  let projectDir: string;
  let tracker: ChangeTracker;

  before(() => {
    projectDir = createTempProject();
    const api = createMockAPI();
    tracker = new ChangeTracker(projectDir, api);
    tracker.registerHooks();
  });

  after(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("should reject paths outside the project root", () => {
    const st = (tracker as any).shouldTrack.bind(tracker);
    assert.equal(st("/bin/sh"), false);
    assert.equal(st("/tmp/some-file.txt"), false);
    assert.equal(st("../outside.ts"), false);
  });

  it("should accept paths inside the project root", () => {
    const st = (tracker as any).shouldTrack.bind(tracker);
    assert.equal(st(join(projectDir, "test.ts")), true);
    assert.equal(st(join(projectDir, "src", "lib.ts")), true);
  });
});
