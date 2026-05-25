import { appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChangeTracker } from "./tracker.js";
import { WebServer } from "./server.js";

function log(msg: string): void {
  const f = process.env.PI_REVIEW_LOG_FILE;
  if (f) {
    try { appendFileSync(f, `[${new Date().toISOString()}] [index] ${msg}\n`, "utf8"); } catch { /* ignore */ }
  }
}

export default function (pi: ExtensionAPI) {
  log("PI Review extension started");
  const cwd = process.cwd();
  const tracker = new ChangeTracker(cwd, pi);
  const server = new WebServer(tracker);

  tracker.registerHooks();
  log("registerHooks complete");

  // Wire tracker events → SSE broadcast
  pi.events.on("pi-review:update", () => {
    server.broadcastUpdate();
  });

  // Wire comments event → send to agent
  pi.events.on("pi-review:comments", (data: { comments: Array<{ filePath: string; relativePath: string; lineNum: number; text: string }>; message: string }) => {
    log("Comments received, sending to agent: " + data.message);
    // Broadcast the comments to SSE clients so the UI can clear them
    server.broadcastUpdate();
  });

  let port: number | undefined;

  // Fire-and-forget server start so factory returns immediately
  server.start().then((p) => {
    port = p;
    if (process.env.PI_REVIEW_DEBUG === "1") {
      console.error("[pi-review] server started on port", port);
    }
  }).catch((e) => {
    console.error("[pi-review] server failed to start:", e);
  });

  // Detect if dist/ is missing (e.g. git install without a build step)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distJs = resolve(__dirname, "../dist/frontend.js");
  let distMissing = !existsSync(distJs);

  pi.on("session_start", async (_event, ctx) => {
    if (distMissing) {
      ctx.ui.notify("pi-review: frontend not built. Run 'npm run build:frontend' and then /reload.", "error");
    }
    // Disk state was already loaded in the constructor — no session replay needed.
    // Ensure server is started (may already be running from fire-and-forget).
    if (!server.isRunning()) {
      try {
        port = await server.start();
      } catch {
        ctx.ui.notify("Change tracker: could not start web server", "error");
      }
    }
    const running = server.isRunning();
    ctx.ui.setStatus(
      "pi-review",
      running ? `tracker ready — /review → http://localhost:${port ?? 3123}` : `tracker not running — /review to start`,
    );
  });

  pi.on("session_shutdown", () => {
    tracker.flushDisk();
    server.stop();
    port = undefined;
  });

  pi.registerCommand("review", {
    description: "Open pi-review web UI",
    handler: async (_args, ctx) => {
      if (!server.isRunning()) {
        try {
          port = await server.start();
        } catch {
          ctx.ui.notify("Change tracker: could not start web server", "error");
          return;
        }
      }
      const url = `http://localhost:${port ?? 3123}`;
      ctx.ui.notify(`Opening pi-review at ${url}`, "info");
      try {
        await pi.exec("xdg-open", [url], { cwd, timeout: 5000 });
      } catch {
        try {
          await pi.exec("open", [url], { cwd, timeout: 5000 });
        } catch {
          ctx.ui.notify(`Open ${url} in your browser`, "info");
        }
      }
    },
  });

  pi.registerCommand("accept-all", {
    description: "Accept all pending tracked changes",
    handler: async (_args, ctx) => {
      const count = tracker.acceptAll();
      if (count > 0) {
        ctx.ui.notify(`Accepted ${count} change(s)`, "info");
      } else {
        ctx.ui.notify("No pending changes to accept", "info");
      }
    },
  });

  pi.registerCommand("revert-all", {
    description: "Revert all pending tracked changes",
    handler: async (_args, ctx) => {
      const pending = tracker.getPendingCount();
      if (pending === 0) {
        ctx.ui.notify("No pending changes to revert", "info");
        return;
      }
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          "Revert all changes",
          `This will restore ${pending} file(s) to their original content. Continue?`,
        );
        if (!confirmed) return;
      }
      const count = tracker.revertAll();
      if (count > 0) {
        ctx.ui.notify(`Reverted ${count} change(s)`, "info");
      }
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    const pending = tracker.getPendingCount();
    if (ctx.hasUI) {
      if (pending > 0) {
        const running = server.isRunning();
        const label = running
          ? `${pending} changes pending — http://localhost:${port ?? 3123}`
          : `${pending} changes pending — run /changes to view`;
        ctx.ui.setStatus("pi-review", label);
        ctx.ui.notify(`${pending} file(s) changed. Run /review to review.`, "info");
      } else {
        ctx.ui.setStatus("pi-review", undefined);
      }
    }
  });
}
