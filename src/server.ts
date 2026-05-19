/**
 * WebServer  -- HTTP server for the Change Tracker extension.
 *
 * Provides:
 * - REST API for querying and managing tracked changes
 * - SSE (Server-Sent Events) for real-time UI updates
 * - Preact frontend served from pre-built dist/ artifacts
 *
 * The frontend is a Preact app (TSX → vanilla JS via esbuild).
 * Build with: npm run build:frontend
 *
 * API endpoints:
 *   GET  /api/file-diffs          -- aggregated FileDiff[] (merged per file)
 *   GET  /api/changes             -- raw TrackedChange[] (backward compat)
 *   GET  /api/state               -- full AggregatedState
 *   POST /api/files/:path/accept  -- accept all pending for a file
 *   POST /api/files/:path/revert  -- revert all pending for a file
 *   POST /api/changes/accept-all  -- accept all pending changes
 *   POST /api/changes/revert-all  -- revert all pending changes
 *   POST /api/changes/:id/accept  -- accept single change (legacy)
 *   POST /api/changes/:id/revert  -- revert single change (legacy)
 *   GET  /api/stream              -- SSE event stream
 *   GET  /                        -- frontend HTML (Preact app)
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { ChangeState, AggregatedState, FileDiff, ExternalFileChange } from "./types.js";

// ---------------------------------------------------------------------------
// Tracker interface (dependency injection for testability)
// ---------------------------------------------------------------------------

export interface TrackerInterface {
  getChanges: () => ChangeState["changes"];
  getState: () => ChangeState;
  getAggregatedState?: () => AggregatedState;
  accept: (id: string) => boolean;
  revert: (id: string) => boolean;
  acceptFile?: (filePath: string) => number;
  revertFile?: (filePath: string) => number;
  acceptAll: () => number;
  revertAll: () => number;
  getPendingCount: () => number;
  emitComments?: (comments: Array<{ filePath: string; relativePath: string; lineNum: number; text: string }>) => void;
  emitReference?: (params: { filePath: string; relativePath: string; startLine: number; endLine: number; code: string; question: string; mode: "ask" | "edit" }) => void;
  emitReferenceFollowup?: (params: { filePath: string; relativePath: string; startLine: number; endLine: number; code: string; messages: Array<{ role: string; text: string }>; question: string; mode: "ask" | "edit" }) => void;
  clearNonPending: () => number;
  clearFile: (filePath: string) => number;
  drainCommentResponses?: () => Array<{ text: string; timestamp: number }>;
  drainReferenceResponses?: () => Array<{ text: string; timestamp: number }>;
  sendChat?: (message: string) => void;
  drainChatResponses?: () => Array<{ text: string; timestamp: number }>;
  getExternalChanges?: () => ExternalFileChange[];
  acknowledgeExternalChanges?: (filePath: string) => void;
  acknowledgeAllExternalChanges?: () => void;
  clearExternalChanges?: (filePath: string) => void;
  clearAllExternalChanges?: () => void;
}

// ---------------------------------------------------------------------------
// WebServer
// ---------------------------------------------------------------------------

export class WebServer {
  private server: Server | null = null;
  private port: number;
  private sseClients: Set<ServerResponse> = new Set();
  private cwd: string;

  constructor(
    private tracker: TrackerInterface,
  ) {
    const envPort = parseInt(process.env.PI_REVIEW_PORT ?? "", 10);
    this.port = Number.isFinite(envPort) && envPort > 0 ? envPort : 3123;
    this.cwd = process.cwd();
  }

  /** Check if the server is currently running. */
  isRunning(): boolean {
    return this.server !== null;
  }

  /** Push current tracker state to all connected SSE clients. */
  broadcastUpdate(): void {
    if (this.sseClients.size === 0) return;

    // Prefer aggregated state if available
    const state = this.tracker.getAggregatedState
      ? this.tracker.getAggregatedState()
      : { fileDiffs: [], rawChanges: this.tracker.getChanges(), nextId: 0 };

    // Include any pending comment responses
    const commentResponses = this.tracker.drainCommentResponses?.() ?? [];

    this.broadcastSSE(JSON.stringify({
      type: "update",
      data: state,
      commentResponses: commentResponses.length > 0 ? commentResponses : undefined,
    }));
  }

  /** Start the HTTP server. Resolves with the actual port number. */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.handleRequest.bind(this));
      this.server.listen(this.port, "127.0.0.1", () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        this.port = actualPort;
        resolve(actualPort);
      });
      this.server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.server?.close();
          this.server = createServer(this.handleRequest.bind(this));
          this.server.listen(0, "127.0.0.1", () => {
            const addr = this.server?.address();
            const actualPort = typeof addr === "object" && addr ? addr.port : 0;
            this.port = actualPort;
            resolve(actualPort);
          });
          this.server.once("error", reject);
        } else {
          reject(err);
        }
      });
    });
  }

  /** Stop the server and disconnect all SSE clients. */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.sseClients.clear();
  }

  // ------------------------------------------------------------------
  // SSE
  // ------------------------------------------------------------------

  /** Broadcast a message to all SSE clients, removing disconnected ones. */
  private broadcastSSE(data: string): void {
    const msg = `data: ${data}\n\n`;
    const disconnected: ServerResponse[] = [];
    for (const client of this.sseClients) {
      try { client.write(msg); }
      catch { disconnected.push(client); }
    }
    for (const client of disconnected) {
      this.sseClients.delete(client);
    }
  }

  // ------------------------------------------------------------------
  // Request routing
  // ------------------------------------------------------------------

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // SSE endpoint
    if (path === "/api/stream") {
      return this.handleSSE(req, res);
    }

    // Aggregated file diffs
    if (path === "/api/file-diffs" && method === "GET") {
      return this.handleGetFileDiffs(res);
    }

    // Legacy: raw changes
    if (path === "/api/changes" && method === "GET") {
      return this.handleGetChanges(res);
    }

    // Full state
    if (path === "/api/state" && method === "GET") {
      return this.handleGetState(res);
    }

    // Per-file content (current on-disk content)
    if (method === "GET") {
      const fileContentMatch = path.match(/^\/api\/files\/(.+)\/content$/);
      if (fileContentMatch) {
        return this.handleGetFileContent(decodeURIComponent(fileContentMatch[1]), res);
      }
    }

    // Per-file accept/revert
    if (method === "POST") {
      const fileAcceptMatch = path.match(/^\/api\/files\/(.+)\/accept$/);
      if (fileAcceptMatch) {
        return this.handleAcceptFile(decodeURIComponent(fileAcceptMatch[1]), res);
      }
      const fileRevertMatch = path.match(/^\/api\/files\/(.+)\/revert$/);
      if (fileRevertMatch) {
        return this.handleRevertFile(decodeURIComponent(fileRevertMatch[1]), res);
      }

    }

    // Global accept/revert all
    if (path === "/api/changes/accept-all" && method === "POST") {
      return this.handleAcceptAll(res);
    }
    if (path === "/api/changes/revert-all" && method === "POST") {
      return this.handleRevertAll(res);
    }

    // Send comments to agent
    if (path === "/api/comments/send" && method === "POST") {
      return this.handleSendComments(req, res);
    }

    // Send reference to agent
    if (path === "/api/reference/send" && method === "POST") {
      return this.handleSendReference(req, res);
    }

    // Send follow-up to agent
    if (path === "/api/reference/followup" && method === "POST") {
      return this.handleSendFollowup(req, res);
    }

    // Poll for comment responses
    if (path === "/api/comments/response" && method === "GET") {
      return this.handleCommentResponsePoll(res);
    }

    // Poll for reference responses
    if (path === "/api/reference/response" && method === "GET") {
      return this.handleReferenceResponsePoll(res);
    }

    // Chat
    if (path === "/api/chat/send" && method === "POST") {
      return this.handleSendChat(req, res);
    }
    if (path === "/api/chat/response" && method === "GET") {
      return this.handleChatResponsePoll(res);
    }

    // External changes
    if (path === "/api/external-changes" && method === "GET") {
      return this.handleGetExternalChanges(res);
    }
    if (path === "/api/external-changes/acknowledge-all" && method === "POST") {
      return this.handleAcknowledgeAllExternal(res);
    }
    if (method === "POST") {
      const ackMatch = path.match(/^\/api\/external-changes\/acknowledge\/(.+)$/);
      if (ackMatch) {
        return this.handleAcknowledgeExternal(decodeURIComponent(ackMatch[1]), res);
      }
      const clearExternalMatch = path.match(/^\/api\/external-changes\/clear\/(.+)$/);
      if (clearExternalMatch) {
        return this.handleClearExternal(clearExternalMatch[1], res);
      }
    }

    // Open file in VS Code
    if (method === "POST") {
      const editorMatch = path.match(/^\/api\/open-in-editor\/(.+)$/);
      if (editorMatch) {
        return this.handleOpenInEditor(decodeURIComponent(editorMatch[1]), req, res);
      }
    }

    // Clear non-pending changes
    if (path === "/api/changes/clear-all" && method === "POST") {
      return this.handleClearAllNonPending(res);
    }
    if (method === "POST") {
      const clearFileMatch = path.match(/^\/api\/changes\/clear\/(.+)$/);
      if (clearFileMatch) {
        return this.handleClearFile(decodeURIComponent(clearFileMatch[1]), res);
      }
    }

    // Legacy: per-change accept/revert
    if (method === "POST") {
      const acceptMatch = path.match(/^\/api\/changes\/(.+)\/accept$/);
      if (acceptMatch) {
        return this.handleAccept(decodeURIComponent(acceptMatch[1]), res);
      }
      const revertMatch = path.match(/^\/api\/changes\/(.+)\/revert$/);
      if (revertMatch) {
        return this.handleRevert(decodeURIComponent(revertMatch[1]), res);
      }
    }

    // Frontend
    if (path === "/" || path === "") {
      return this.handleFrontend(res);
    }

    sendJson(res, 404, { error: "Not found" });
  }

  // ------------------------------------------------------------------
  // SSE handler
  // ------------------------------------------------------------------

  private handleSSE(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);
    res.on("close", () => this.sseClients.delete(res));
  }

  // ------------------------------------------------------------------
  // GET handlers
  // ------------------------------------------------------------------

  private handleGetFileDiffs(res: ServerResponse): void {
    const state = this.tracker.getAggregatedState
      ? this.tracker.getAggregatedState()
      : { fileDiffs: [], rawChanges: this.tracker.getChanges(), nextId: 0 };
    sendJson(res, 200, state.fileDiffs);
  }

  private handleGetChanges(res: ServerResponse): void {
    sendJson(res, 200, this.tracker.getChanges());
  }

  private handleGetState(res: ServerResponse): void {
    const state = this.tracker.getAggregatedState
      ? this.tracker.getAggregatedState()
      : { fileDiffs: [], rawChanges: this.tracker.getChanges(), nextId: this.tracker.getState().nextId };
    sendJson(res, 200, state);
  }

  // ------------------------------------------------------------------
  // Per-file accept/revert
  // ------------------------------------------------------------------

  private handleAcceptFile(relPath: string, res: ServerResponse): void {
    if (!this.tracker.acceptFile) {
      sendJson(res, 501, { success: false, error: "Per-file accept not supported" });
      return;
    }
    const absPath = relPath.startsWith("/") ? relPath : relPath; // already absolute from API
    const count = this.tracker.acceptFile(absPath);
    this.broadcastUpdate();
    sendJson(res, 200, { success: true, count });
  }

  private handleRevertFile(relPath: string, res: ServerResponse): void {
    if (!this.tracker.revertFile) {
      sendJson(res, 501, { success: false, error: "Per-file revert not supported" });
      return;
    }
    const absPath = relPath.startsWith("/") ? relPath : relPath;
    const count = this.tracker.revertFile(absPath);
    this.broadcastUpdate();
    sendJson(res, 200, { success: true, count });
  }

  /**
   * GET /api/files/:path/content  -- return the current on-disk content of a file.
   * Used by the "Full File" view to display the complete file with diff highlighting.
   */
  private handleGetFileContent(filePath: string, res: ServerResponse): void {
    try {
      const absPath = filePath.startsWith("/") ? filePath : filePath;
      const content = readFileSync(absPath, "utf8");
      sendJson(res, 200, { success: true, content });
    } catch {
      sendJson(res, 404, { success: false, error: "File not found" });
    }
  }

  /**
   * POST /api/files/:path/edit-line  -- edit a specific line in a file.
   * Body: { lineNum: number, newContent: string }
   * Reads the current file, replaces the line, writes back, and records a
   * TrackedChange so the edit shows up as a pending change in the review UI.
   */


  /**
   * POST /api/comments/send  -- send line comments to the agent as instructions.
   * Reads the JSON body { comments: [{ filePath, relativePath, lineNum, text }] }
   * and emits them as a prompt for the agent.
   */
  private handleSendComments(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const comments = data.comments || [];
        if (comments.length === 0) {
          sendJson(res, 200, { success: true, count: 0 });
          return;
        }
        // Build a formatted message for the agent
        const message = comments.map((c: any) =>
          '📝 **' + c.relativePath + ':** line ' + c.lineNum + '\n   ' + c.text
        ).join('\n\n');
        // Emit the comments as an event for the agent to pick up
        this.tracker.emitComments?.(comments);
        sendJson(res, 200, { success: true, count: comments.length, message });
      } catch {
        sendJson(res, 400, { success: false, error: 'Invalid JSON' });
      }
    });
  }

  /**
   * POST /api/reference/send  -- send a code reference + question to the agent.
   * Expects JSON body: { filePath, relativePath, startLine, endLine, code, question, mode }
   */
  private handleSendReference(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.filePath || !data.question || !data.code) {
          sendJson(res, 400, { success: false, error: 'Missing required fields' });
          return;
        }
        this.tracker.emitReference?.({
          filePath: data.filePath,
          relativePath: data.relativePath || data.filePath,
          startLine: data.startLine || 0,
          endLine: data.endLine || 0,
          code: data.code,
          question: data.question,
          mode: data.mode === 'edit' ? 'edit' : 'ask',
        });
        sendJson(res, 200, { success: true });
      } catch {
        sendJson(res, 400, { success: false, error: 'Invalid JSON' });
      }
    });
  }

  /**
   * POST /api/reference/followup  -- send a follow-up message with conversation history.
   */
  private handleSendFollowup(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.filePath || !data.question) {
          sendJson(res, 400, { success: false, error: 'Missing required fields' });
          return;
        }
        this.tracker.emitReferenceFollowup?.({
          filePath: data.filePath,
          relativePath: data.relativePath || data.filePath,
          startLine: data.startLine || 0,
          endLine: data.endLine || 0,
          code: data.code || '',
          messages: data.messages || [],
          question: data.question,
          mode: data.mode === 'edit' ? 'edit' : 'ask',
        });
        sendJson(res, 200, { success: true });
      } catch {
        sendJson(res, 400, { success: false, error: 'Invalid JSON' });
      }
    });
  }

  // ------------------------------------------------------------------
  // Clear non-pending
  // ------------------------------------------------------------------

  private handleClearAllNonPending(res: ServerResponse): void {
    const count = this.tracker.clearNonPending();
    this.broadcastUpdate();
    sendJson(res, 200, { success: true, count });
  }

  private handleClearFile(filePath: string, res: ServerResponse): void {
    const count = this.tracker.clearFile(filePath);
    this.broadcastUpdate();
    sendJson(res, 200, { success: true, count, filePath });
  }

  // ------------------------------------------------------------------
  // External change handlers
  // ------------------------------------------------------------------

  /** GET /api/external-changes — return all external changes. */
  private handleGetExternalChanges(res: ServerResponse): void {
    const changes = this.tracker.getExternalChanges?.() ?? [];
    sendJson(res, 200, changes);
  }

  /** POST /api/external-changes/acknowledge/:path — acknowledge a specific file. */
  private handleAcknowledgeExternal(filePath: string, res: ServerResponse): void {
    this.tracker.acknowledgeExternalChanges?.(filePath);
    this.broadcastUpdate();
    sendJson(res, 200, { success: true, filePath });
  }

  /** POST /api/external-changes/acknowledge-all — acknowledge all. */
  private handleAcknowledgeAllExternal(res: ServerResponse): void {
    this.tracker.acknowledgeAllExternalChanges?.();
    this.broadcastUpdate();
    sendJson(res, 200, { success: true });
  }

  /** POST /api/external-changes/clear/:path — clear external changes for a file. */
  private handleClearExternal(filePath: string, res: ServerResponse): void {
    this.tracker.clearExternalChanges?.(filePath);
    this.broadcastUpdate();
    sendJson(res, 200, { success: true, filePath });
  }

  /** GET /api/comments/response — poll for agent responses to comments. */
  private handleCommentResponsePoll(res: ServerResponse): void {
    const responses = this.tracker.drainCommentResponses?.() ?? [];
    sendJson(res, 200, { responses });
  }

  /** GET /api/reference/response — poll for agent responses to references. */
  private handleReferenceResponsePoll(res: ServerResponse): void {
    const responses = this.tracker.drainReferenceResponses?.() ?? [];
    sendJson(res, 200, { responses });
  }

  /** POST /api/chat/send — send a chat message to the agent. */
  private handleSendChat(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.message) { sendJson(res, 400, { success: false }); return; }
        this.tracker.sendChat?.(data.message);
        sendJson(res, 200, { success: true });
      } catch { sendJson(res, 400, { success: false }); }
    });
  }

  /** GET /api/chat/response — poll for agent chat responses. */
  private handleChatResponsePoll(res: ServerResponse): void {
    const responses = this.tracker.drainChatResponses?.() ?? [];
    sendJson(res, 200, { responses });
  }

  /**
   * POST /api/open-in-editor/:path  -- open a file in the given editor.
   * Reads `editor` from the JSON body (defaults to "code").
   *
   * Supported editors:
   *   code     → VS Code       (code --goto file)
   *   cursor   → Cursor        (cursor --goto file)
   *   windsurf → Windsurf      (windsurf --goto file)
   *   idea     → IntelliJ IDEA (idea file)
   *   webstorm → WebStorm      (webstorm file)
   */
  private handleOpenInEditor(filePath: string, req: IncomingMessage, res: ServerResponse): void {
    let editor = "code";
    let body = "";
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      try {
        if (body) {
          const data = JSON.parse(body);
          if (data.editor) editor = data.editor;
        }
      } catch { /* use default */ }

      const editors: Record<string, { cmd: string; args: string[] }> = {
        code:     { cmd: "code",     args: [this.cwd, "--goto", filePath] },
        cursor:   { cmd: "cursor",   args: [this.cwd, "--goto", filePath] },
        windsurf: { cmd: "windsurf", args: [this.cwd, "--goto", filePath] },
        idea:     { cmd: "idea",     args: [filePath] },
        webstorm: { cmd: "webstorm", args: [filePath] },
      };

      const cfg = editors[editor] ?? editors.code;
      try {
        const result = spawnSync(cfg.cmd, cfg.args, { timeout: 5000 });
        if (result.error) {
          sendJson(res, 500, { success: false, error: result.error.message });
        } else {
          sendJson(res, 200, { success: true });
        }
      } catch (e) {
        sendJson(res, 500, { success: false, error: String(e) });
      }
    });
  }

  // ------------------------------------------------------------------
  // Global accept/revert all
  // ------------------------------------------------------------------

  private handleAcceptAll(res: ServerResponse): void {
    const count = this.tracker.acceptAll();
    this.broadcastUpdate();
    sendJson(res, 200, { success: true, count });
  }

  private handleRevertAll(res: ServerResponse): void {
    const count = this.tracker.revertAll();
    this.broadcastUpdate();
    sendJson(res, 200, { success: true, count });
  }

  // ------------------------------------------------------------------
  // Legacy per-change accept/revert
  // ------------------------------------------------------------------

  private handleAccept(id: string, res: ServerResponse): void {
    const success = this.tracker.accept(id);
    if (success) {
      this.broadcastUpdate();
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { success: false, error: "Change not found or not pending" });
    }
  }

  private handleRevert(id: string, res: ServerResponse): void {
    const success = this.tracker.revert(id);
    if (success) {
      this.broadcastUpdate();
      sendJson(res, 200, { success: true });
    } else {
      sendJson(res, 404, { success: false, error: "Change not found or not pending" });
    }
  }

  // ------------------------------------------------------------------
  // Frontend
  // ------------------------------------------------------------------

  private handleFrontend(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(this.buildFrontendHTML());
  }

  /**
   * Build the frontend HTML by reading the pre-built Preact bundle and CSS.
   * Falls back to an error page if build artifacts are missing.
   * @returns The complete HTML string for the frontend.
   */
  private buildFrontendHTML(): string {
    // Resolve paths relative to this source file
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const distDir = join(__dirname, "..", "dist");
    const jsPath = join(distDir, "frontend.js");
    const cssPath = join(distDir, "frontend.css");

    let jsContent = "";
    let cssContent = "";
    let buildError = null;

    try {
      if (existsSync(jsPath)) {
        jsContent = readFileSync(jsPath, "utf8");
      }
      if (existsSync(cssPath)) {
        cssContent = readFileSync(cssPath, "utf8");
      }
    } catch (e) {
      buildError = e instanceof Error ? e.message : String(e);
    }

    if (!jsContent || !cssContent) {
      // Fallback: show error page
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PI Review</title>
<style>
  body { font-family: sans-serif; background: #1e293b; color: #f1f5f9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .error { text-align: center; max-width: 500px; }
  .error h1 { color: #f87171; }
  .error p { color: #94a3b8; }
  .error code { background: #334155; padding: 2px 6px; border-radius: 4px; }
</style>
</head>
<body>
<div class="error">
  <h1>Frontend not built</h1>
  <p>Run <code>npm run build:frontend</code> to build the Preact frontend.</p>
  ${buildError ? `<p style="color:#f87171">Error: ${buildError.replace(/</g, '&lt;')}</p>` : ''}
</div>
</body>
</html>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PI Review</title>
<style>
${cssContent}
</style>
</head>
<body>
<div id="app"><div id="pi-review-app"></div></div>
<script>
${jsContent}
</script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// JSON helper
// ---------------------------------------------------------------------------

/** Send a JSON response with appropriate headers. */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

