/**
 * Store module for the Change Tracker frontend.
 *
 * Provides API call functions and SSE connection management.
 * All state mutations happen through these functions, which
 * notify subscribers when data changes.
 */

import type { AggregatedState, FileDiff, ChangeCycle } from "../types.js";
import type { LineCommentsStore, EditingComment } from "./utils.js";

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * Fetch the full aggregated state from the server.
 * @returns The aggregated state with file diffs, history, and raw changes.
 */
export async function fetchState(): Promise<AggregatedState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Accept all pending changes via the API.
 * @returns The API response with success status and count.
 */
export async function apiAcceptAll(): Promise<{ success: boolean; count: number }> {
  const res = await fetch("/api/changes/accept-all", { method: "POST" });
  return res.json();
}

/**
 * Revert all pending changes via the API.
 * @returns The API response with success status and count.
 */
export async function apiRevertAll(): Promise<{ success: boolean; count: number }> {
  const res = await fetch("/api/changes/revert-all", { method: "POST" });
  return res.json();
}

/**
 * Accept all pending changes for a specific file.
 * @param filePath - The absolute file path.
 * @returns The API response with success status and count.
 */
export async function apiAcceptFile(filePath: string): Promise<{ success: boolean; count: number }> {
  const res = await fetch(`/api/files/${encodeURIComponent(filePath)}/accept`, { method: "POST" });
  return res.json();
}

/**
 * Revert all pending changes for a specific file.
 * @param filePath - The absolute file path.
 * @returns The API response with success status and count.
 */
export async function apiRevertFile(filePath: string): Promise<{ success: boolean; count: number }> {
  const res = await fetch(`/api/files/${encodeURIComponent(filePath)}/revert`, { method: "POST" });
  return res.json();
}

/**
 * Fetch the current on-disk content of a file.
 * @param filePath - The absolute file path.
 * @returns The file content string.
 */
export async function apiGetFileContent(filePath: string): Promise<string> {
  const res = await fetch(`/api/files/${encodeURIComponent(filePath)}/content`);
  if (!res.ok) throw new Error("File not found");
  const data = await res.json();
  return data.content;
}

/**
 * Send line comments to the agent as instructions.
 * @param comments - Array of comment objects with filePath, relativePath, lineNum, and text.
 * @returns The API response with success status.
 */
export async function apiSendComments(
  comments: Array<{
    filePath: string;
    relativePath: string;
    lineNum: number;
    text: string;
    lineContent: string;
    changeType: "add" | "del" | "ctx";
  }>,
): Promise<{ success: boolean; count: number; message?: string }> {
  const res = await fetch("/api/comments/send", {
    method: "POST",
    body: JSON.stringify({ comments }),
  });
  return res.json();
}

/** Clear all non-pending (accepted/reverted) changes. */
export async function apiClearNonPending(): Promise<{ success: boolean; count: number }> {
  const res = await fetch("/api/changes/clear-all", { method: "POST" });
  return res.json();
}

/** Clear non-pending changes for a specific file. */
export async function apiClearFile(filePath: string): Promise<{ success: boolean; count: number }> {
  const res = await fetch("/api/changes/clear/" + encodeURIComponent(filePath), { method: "POST" });
  return res.json();
}

/** Send a code reference + question to the agent. */
export async function apiSendReference(params: {
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  code: string;
  question: string;
  mode: "ask" | "edit";
}): Promise<{ success: boolean }> {
  const res = await fetch("/api/reference/send", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return res.json();
}

/** Open a file in VS Code. */
export async function apiOpenInEditor(filePath: string): Promise<{ success: boolean }> {
  const res = await fetch(`/api/open-in-editor/${encodeURIComponent(filePath)}`, { method: "POST" });
  return res.json();
}

/** Poll for agent responses to reference questions. */
export async function apiPollReferenceResponse(): Promise<Array<{ text: string; timestamp: number }>> {
  const res = await fetch("/api/reference/response");
  if (!res.ok) return [];
  const data = await res.json();
  return data.responses ?? [];
}

/** Send a follow-up message with conversation history. */
export async function apiSendFollowup(params: {
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  code: string;
  messages: Array<{ role: string; text: string }>;
  question: string;
  mode: "ask" | "edit";
}): Promise<{ success: boolean }> {
  const res = await fetch("/api/reference/followup", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// SSE Connection
// ---------------------------------------------------------------------------

/** SSE connection state. */
export type SSEStatus = "connected" | "disconnected" | "reconnecting";

/** Callback type for SSE messages. */
export type SSEUpdateHandler = (data: AggregatedState) => void;

/**
 * Manage the SSE (Server-Sent Events) connection for real-time updates.
 */
export class SSEManager {
  private eventSource: EventSource | null = null;
  private status: SSEStatus = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onUpdate: SSEUpdateHandler | null = null;
  private onStatusChange: ((status: SSEStatus) => void) | null = null;
  private onCommentResponse: ((responses: Array<{ text: string; timestamp: number }>) => void) | null = null;

  setUpdateHandler(handler: SSEUpdateHandler): void { this.onUpdate = handler; }
  setStatusHandler(handler: (status: SSEStatus) => void): void { this.onStatusChange = handler; }
  setCommentResponseHandler(handler: (responses: Array<{ text: string; timestamp: number }>) => void): void {
    this.onCommentResponse = handler;
  }

  /** Get the current connection status. */
  getStatus(): SSEStatus {
    return this.status;
  }

  /**
   * Connect to the SSE stream at /api/stream.
   * Automatically reconnects on error with exponential backoff.
   */
  connect(): void {
    this.disconnect();

    try {
      this.eventSource = new EventSource("/api/stream");

      this.eventSource.onmessage = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "update") {
            if (this.onUpdate) this.onUpdate(msg.data);
            if (msg.commentResponses && this.onCommentResponse) {
              this.onCommentResponse(msg.commentResponses);
            }
          }
        } catch (err) {
          console.error("SSE parse error", err);
        }
      };

      this.eventSource.onopen = () => {
        this.setStatus("connected");
      };

      this.eventSource.onerror = () => {
        this.setStatus("reconnecting");
        this.eventSource?.close();
        this.eventSource = null;
        // Reconnect after 3 seconds
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      };
    } catch (e) {
      this.setStatus("disconnected");
      console.error("SSE unavailable", e);
    }
  }

  /**
   * Disconnect the SSE stream and clean up timers.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Update the connection status and notify listeners.
   * @param status - The new connection status.
   */
  private setStatus(status: SSEStatus): void {
    this.status = status;
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }
}
