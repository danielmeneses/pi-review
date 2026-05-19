/**
 * ChatPanel component — slide-in side panel for conversation with the agent.
 *
 * Slides in from the right edge of the window, overlaying the main content
 * without a dark backdrop so the user can still see diffs behind it.
 * Clean chat bubbles, compact header, auto-resizing textarea, and a
 * draggable left-edge handle to resize the panel width.
 */

import { JSX } from "preact";
import { useRef, useEffect, useState } from "preact/hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "agent";
  text: string;
  timestamp: number;
}

export interface ChatPanelProps {
  /** Whether the chat panel is open. */
  open: boolean;
  /** Conversation messages. */
  messages: ChatMessage[];
  /** Current draft text. */
  draft: string;
  /** Whether waiting for agent response. */
  sending: boolean;
  /** Called when draft changes. */
  onDraftChange: (value: string) => void;
  /** Called when Send is clicked. */
  onSend: () => void;
  /** Called to close the panel. */
  onClose: () => void;
  /** Called to clear all messages. */
  onClear: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the first letter of a role, uppercased. */
function roleInitial(role: "user" | "agent"): string {
  return role === "user" ? "U" : "A";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatPanel(props: ChatPanelProps): JSX.Element {
  const { open, messages, draft, sending, onDraftChange, onSend, onClose, onClear } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [chatWidth, setChatWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (open) {
      textareaRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta && open) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
    }
  }, [draft, open]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (draft.trim() && !sending) onSend();
    }
  };

  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    // Disable transition during drag so width changes are instant
    panel.style.transition = "none";
    const currentWidth = panel.offsetWidth;
    dragRef.current = { startX: e.clientX, startWidth: currentWidth };
    setDragging(true);

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientX - dragRef.current.startX;
      // Panel is right-aligned: mouse left → wider, mouse right → narrower
      const newWidth = Math.max(280, Math.min(window.innerWidth * 0.7, dragRef.current.startWidth - delta));
      setChatWidth(newWidth);
    };

    const onMouseUp = () => {
      dragRef.current = null;
      setDragging(false);
      if (panelRef.current) {
        panelRef.current.style.transition = "";
      }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      ref={panelRef}
      class={`chat-panel${open ? " chat-panel-open" : ""}`}
      style={chatWidth ? { width: chatWidth + "px" } : undefined}
    >
      {/* Resize handle on the left edge */}
      <div
        class={`chat-resize-handle${dragging ? " active" : ""}`}
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div class="chat-header">
        <div class="chat-header-left">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>Chat</span>
        </div>
        {messages.length > 0 && (
          <button class="chat-clear" onClick={onClear} title="Clear messages">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        )}
        <button class="chat-close" onClick={onClose} title="Close (Esc)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Thread */}
      <div class="chat-thread">
        {messages.length === 0 && !sending && (
          <div class="chat-empty">
            <svg class="chat-empty-icon" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p>Ask anything about your project</p>
            <p class="chat-empty-hint">The agent can see file changes and project context</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} class={`chat-msg chat-msg-${msg.role}`}>
            <div class="chat-msg-avatar">{roleInitial(msg.role)}</div>
            <div class="chat-msg-body">
              <div class="chat-msg-role">{msg.role === "user" ? "You" : "Agent"}</div>
              <div class="chat-msg-text">{msg.text}</div>
            </div>
          </div>
        ))}
        {sending && (
          <div class="chat-msg chat-msg-agent">
            <div class="chat-msg-avatar">A</div>
            <div class="chat-msg-body">
              <div class="chat-msg-role">Agent</div>
              <div class="chat-msg-text">
                <span class="chat-typing">
                  <span>.</span><span>.</span><span>.</span>
                </span>
              </div>
            </div>
          </div>
        )}
        <div ref={threadEndRef} />
      </div>

      {/* Input area */}
      <div class="chat-input-area">
        <textarea
          id="pi-review-chat-input"
          ref={textareaRef}
          class="chat-input"
          placeholder="Type a message..."
          value={draft}
          disabled={sending}
          spellcheck={true}
          autocomplete="off"
          data-gramm="false"
          data-gramm_editor="false"
          data-enable-grammarly="false"
          onInput={(e: Event) => onDraftChange((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button
          class="chat-send-btn"
          disabled={!draft.trim() || sending}
          onClick={onSend}
          title="Send (Enter)"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
