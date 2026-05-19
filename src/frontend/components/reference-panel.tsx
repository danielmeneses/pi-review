/**
 * ReferencePanel component for referencing selected code to the agent.
 *
 * Supports a conversation thread: user can ask follow-up questions
 * and the agent's responses are displayed inline in the thread.
 */

import { JSX } from "preact";
import { useRef, useEffect, useMemo } from "preact/hooks";
import { highlightBlock } from "../highlight.js";
import { esc } from "../utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SelectedLines {
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  code: string;
}

export interface ConversationMessage {
  role: "user" | "agent";
  text: string;
  timestamp: number;
}

export interface ReferencePanelProps {
  /** The selected lines info, or null if panel is closed. */
  selection: SelectedLines | null;
  /** Conversation history (user + agent messages). */
  messages: ConversationMessage[];
  /** Current draft text in the input. */
  draft: string;
  /** Agent response text for the current message, or null if not yet received. */
  response: string | null;
  /** Whether we're waiting for the agent response. */
  sending: boolean;
  /** Whether the first message has been sent (to show Ask/Edit vs Send). */
  hasStarted: boolean;
  /** Called when draft changes. */
  onDraftChange: (value: string) => void;
  /** Called when Ask is clicked (first message, read-only). */
  onAsk: () => void;
  /** Called when Edit is clicked (first message, may edit). */
  onEdit: () => void;
  /** Called when Ask is clicked for follow-up. */
  onAskFollowup: () => void;
  /** Called when Edit is clicked for follow-up. */
  onEditFollowup: () => void;
  /** Called to close the panel. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReferencePanel(props: ReferencePanelProps): JSX.Element {
  const { selection, messages, draft, response, sending, hasStarted, onDraftChange, onAsk, onEdit, onAskFollowup, onEditFollowup, onClose } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  // Auto-focus textarea and scroll to bottom
  useEffect(() => {
    if (selection) {
      textareaRef.current?.focus();
    }
  }, [selection]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, response]);

  // Highlight the code block (must be before any early return)
  const highlightedCode = useMemo(() => {
    if (!selection || !selection.code) return "";
    const hl = highlightBlock(selection.code, selection.filePath);
    return hl || esc(selection.code);
  }, [selection?.code, selection?.filePath]);

  if (!selection) return <></>;

  const hasCode = selection.startLine > 0 && selection.code;
  const range = hasCode
    ? (selection.startLine === selection.endLine
        ? `line ${selection.startLine}`
        : `lines ${selection.startLine}-${selection.endLine}`)
    : "";
  const title = range ? `${selection.relativePath}[${range}]` : selection.relativePath;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!hasStarted) onAsk();
      else onAskFollowup();
    }
  };

  return (
    <div class="reference-panel">
      <div class="reference-panel-header">
        <span>Reference: {title}</span>
        <button class="btn-close" onClick={onClose} title="Close">✕</button>
      </div>
      {hasCode && (
        <details class="reference-panel-code-details" open={!hasStarted}>
          <summary class="reference-panel-code-summary">Selected code ({range})</summary>
          <pre class="reference-panel-code" dangerouslySetInnerHTML={{ __html: highlightedCode }} />
        </details>
      )}
      <div class="reference-panel-thread">
        {messages.map((msg, i) => (
          <div key={i} class={`ref-thread-msg ref-thread-${msg.role}`}>
            <div class="ref-thread-role">{msg.role === "user" ? "You" : "Agent"}</div>
            <div class="ref-thread-text">{msg.text}</div>
          </div>
        ))}
        {sending && (
          <div class="ref-thread-msg ref-thread-agent">
            <div class="ref-thread-role">Agent</div>
            <div class="ref-thread-text ref-thread-loading">Thinking...</div>
          </div>
        )}
        <div ref={threadEndRef} />
      </div>
      <div class="reference-panel-input">
        <textarea
          ref={textareaRef}
          data-gramm="false"
          placeholder={hasStarted ? "Type a follow-up..." : "What would you like to know or change?"}
          value={draft}
          onInput={(e: Event) => onDraftChange((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {!sending ? (
        <div class="reference-panel-actions">
          <button class="btn-reference-ask" onClick={hasStarted ? onAskFollowup : onAsk}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
              <path d="M9 14c.6 1.5 2 2.5 3.5 2.5S15.5 15.5 16 14" />
            </svg>
            Ask
          </button>
          <button class="btn-reference-edit" onClick={hasStarted ? onEditFollowup : onEdit}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
          <span style="font-size:0.625rem;color:var(--text3);align-self:center;margin-left:8px">
            Ctrl+Enter to Ask
          </span>
        </div>
      ) : null}
    </div>
  );
}
