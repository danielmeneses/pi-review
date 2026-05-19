/**
 * Header component for Pi Review.
 *
 * Displays the app title, status badges (pending/accepted/reverted counts),
 * and toolbar buttons (Accept All, Revert All, Send Comments, Clear All, Refresh).
 */

import { JSX } from "preact";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HeaderProps {
  /** Number of pending files. */
  pending: number;
  /** Total number of line comments. */
  commentCount: number;
  /** Called when Accept All is clicked. */
  onAcceptAll: () => void;
  /** Called when Revert All is clicked. */
  onRevertAll: () => void;
  /** Called when Send Comments is clicked. */
  onSendComments: () => void;
  /** Called when Clear All Comments is clicked. */
  onClearComments: () => void;
  /** Called when Chat is clicked. */
  onOpenChat: () => void;
  /** Called when Refresh is clicked. */
  onRefresh: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the top header bar with title, badges, and action buttons.
 */
export function Header(props: HeaderProps): JSX.Element {
  const {
    pending,
    commentCount,
    onAcceptAll,
    onRevertAll,
    onSendComments,
    onClearComments,
    onOpenChat,
    onRefresh,
  } = props;

  return (
    <header>
      <h1>Pi Review{pending > 0 && <span class="h1-badge" title={pending === 1 ? `There is 1 file awaiting review.` : `There are ${pending} files awaiting review.`}>{pending}</span>}</h1>
      <button class="btn-chat" onClick={onOpenChat}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        Chat with Agent
      </button>
      <div class="toolbar">
        {pending > 0 && (
          <button id="btn-accept-all" onClick={onAcceptAll}>
            <svg class="btn-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
            Accept All
          </button>
        )}
        {pending > 0 && (
          <button id="btn-revert-all" onClick={onRevertAll}>
            <svg class="btn-icon" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
            Revert All
          </button>
        )}
        {commentCount > 0 && (
          <button id="btn-send-comments" onClick={onSendComments}>
            <svg class="btn-icon" viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
            Send comments<span class="btn-comment-count">{commentCount}</span>
          </button>
        )}
        {commentCount > 0 && (
          <button id="btn-clear-all-comments" onClick={onClearComments}>
            <svg class="btn-icon" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            Clear comments
          </button>
        )}
        <button onClick={onRefresh}>
          <svg class="btn-icon" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
          Refresh
        </button>
      </div>
    </header>
  );
}
