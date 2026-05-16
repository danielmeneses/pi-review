/**
 * DiffTable component for rendering unified diffs as an HTML table.
 *
 * Parses a unified diff string into rows with line numbers, +/- signs,
 * and content. Supports inline line comments with add/edit/remove actions.
 */

import { JSX } from "preact";
import { useRef, useEffect, useMemo, useState } from "preact/hooks";
import {
  type FileComments,
  type LineCommentsStore,
  type EditingComment,
} from "../utils.js";
import { highlightLine } from "../highlight.js";
import { extractSelectedLines, type SelectedLineInfo } from "../selection.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface DiffTableProps {
  /** The unified diff string to render. */
  diff: string;
  /** The file path (for comment tracking). */
  filePath: string;
  /** File status — used to style rows when accepted/reverted. */
  fileStatus: string;
  /** All line comments across files. */
  lineComments: LineCommentsStore;
  /** Currently editing comment position, or null. */
  editingComment: EditingComment | null;
  /** Draft text for the editing comment input. */
  editingCommentDraft: string;
  /** Whether comments are allowed (false for accepted/reverted/history views). */
  allowComments: boolean;
  /** Called to start editing a comment on a line. rowKey uniquely identifies the row. */
  onStartEditComment: (filePath: string, lineNum: number, rowKey: string) => void;
  /** Called to save a comment. */
  onSaveComment: (filePath: string, lineNum: number) => void;
  /** Called to cancel editing a comment. */
  onCancelComment: () => void;
  /** Called to remove a saved comment. */
  onRemoveComment: (filePath: string, lineNum: number) => void;
  /** Called when the draft input value changes. */
  onDraftChange: (value: string) => void;
  /** Called when user right-clicks selected lines to reference code. */
  onReference?: (lines: SelectedLineInfo[], filePath: string) => void;
}

// ---------------------------------------------------------------------------
// Comment rendering helpers
// ---------------------------------------------------------------------------

/**
 * Check if a specific row is currently being edited for a comment.
 * Uses a composite rowKey (lineNum + type) to avoid ambiguity
 * when add/del rows share the same line number.
 */
function isLineEditing(
  editingComment: EditingComment | null,
  filePath: string,
  rowKey: string,
): boolean {
  return !!(
    editingComment &&
    editingComment.filePath === filePath &&
    editingComment.rowKey === rowKey
  );
}

/**
 * Render the inline comment bubble (saved comment) for a line.
 * Only returns JSX when a comment exists — the editing input is
 * rendered as a separate <tr> by the parent.
 */
/**
 * Render the inline comment indicator dot (goes before line content).
 */
function renderCommentIndicator(
  fileComments: FileComments,
  rowKey: string,
  lineNum: number,
): JSX.Element | null {
  const comment = fileComments[rowKey] ?? fileComments[String(lineNum)];
  if (!comment || !comment.text) return null;
  const isSent = comment.sent === true;
  const isDone = comment.done === true;
  return (
    <span
      class={`line-comment-indicator${isSent ? " comment-sent" : ""}${isDone ? " comment-done" : ""}`}
      title={comment.text}
    ></span>
  );
}

/**
 * Render the comment bubble and response (block, below line content).
 * Only returns JSX when a comment exists — the editing input is
 * rendered as a separate <tr> by the parent.
 */
function renderCommentBubble(
  filePath: string,
  lineNum: number,
  rowKey: string,
  fileComments: FileComments,
  onStartEdit: (fp: string, ln: number, rk: string) => void,
  onRemove: (fp: string, ln: number) => void,
): JSX.Element | null {
  const comment = fileComments[rowKey] ?? fileComments[String(lineNum)];
  if (!comment || !comment.text) return null;

  const isSent = comment.sent === true;
  const isDone = comment.done === true;

  return (
    <>
      <div
        class={`line-comment-bubble${isSent ? " comment-sent" : ""}${isDone ? " comment-done" : ""}`}
        style="cursor:pointer"
        title={isDone ? "Done" : isSent ? "Sent — click to edit" : "Click to edit"}
        onClick={() => onStartEdit(filePath, lineNum, rowKey)}
      >
        <span class="comment-text">
          [comment] {comment.text}
        </span>
        {isSent && <span class="comment-sent-check">✓</span>}
        {isDone && <span class="comment-done-check">✓</span>}
        <button
          class="btn-comment-remove"
          data-action="comment-remove"
          onClick={(e: Event) => {
            e.stopPropagation();
            onRemove(filePath, lineNum);
          }}
        >
          <svg class="btn-icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
      {comment.response && (
        <div class={`line-comment-response${isDone ? " comment-response-done" : ""}`}>
          <span class="comment-response-text">{comment.response}</span>
        </div>
      )}
    </>
  );
}

/**
 * Comment input row component — renders a full-width <tr> for the
 * comment editing input, placed immediately after the diff line.
 */
function CommentInputRow(props: {
  filePath: string;
  lineNum: number;
  editingCommentDraft: string;
  onSave: (fp: string, ln: number) => void;
  onCancel: () => void;
  onDraftChange: (v: string) => void;
}): JSX.Element {
  const { filePath, lineNum, editingCommentDraft, onSave, onCancel, onDraftChange } = props;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <tr class="diff-comment-input">
      <td class="line-num" />
      <td class="line-sign" />
      <td class="line-content">
        <div class="line-comment-input">
          <input
            ref={inputRef}
            type="text"
            placeholder={`Comment on line ${lineNum}`}
            value={editingCommentDraft}
            data-action="comment-input"
            data-path={filePath}
            data-line={lineNum}
            onInput={(e: Event) => {
              onDraftChange((e.target as HTMLInputElement).value);
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSave(filePath, lineNum);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
          />
          <button
            class="btn-comment btn-comment-add"
            data-action="comment-save"
            onClick={() => onSave(filePath, lineNum)}
            title="Save comment"
          >
            ✓
          </button>
          <button
            class="btn-comment btn-comment-cancel"
            data-action="comment-cancel"
            onClick={onCancel}
            title="Cancel"
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string into renderable rows.
 * @param diff - The unified diff string.
 * @returns Array of row objects with type, line numbers, and content.
 */
function parseDiffRows(diff: string): Array<{
  type: "hunk" | "add" | "del" | "ctx" | "header";
  origLineNum: number;
  newLineNum: number;
  content: string;
  sign: string;
}> {
  const lines = diff.split("\n");
  const rows: Array<{
    type: "hunk" | "add" | "del" | "ctx" | "header";
    origLineNum: number;
    newLineNum: number;
    content: string;
    sign: string;
  }> = [];

  let origLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const minusIdx = line.indexOf("-");
      const plusIdx = line.indexOf(" +");
      if (minusIdx !== -1 && plusIdx !== -1) {
        const minusPart = line.substring(minusIdx + 1, plusIdx).trim();
        const plusPart = line.substring(plusIdx + 2).split(" ")[0];
        const minusNum = parseInt(minusPart.split(",")[0], 10);
        const plusNum = parseInt(plusPart.split(",")[0], 10);
        if (!isNaN(minusNum)) origLineNum = minusNum - 1;
        if (!isNaN(plusNum)) newLineNum = plusNum - 1;
      }
      rows.push({ type: "hunk", origLineNum, newLineNum, content: line, sign: "" });
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      rows.push({ type: "header", origLineNum, newLineNum, content: line, sign: "" });
      continue;
    }

    if (line.startsWith("+")) {
      newLineNum++;
      rows.push({ type: "add", origLineNum, newLineNum, content: line.slice(1), sign: "+" });
    } else if (line.startsWith("-")) {
      origLineNum++;
      rows.push({ type: "del", origLineNum, newLineNum, content: line.slice(1), sign: "-" });
    } else if (line.startsWith(" ")) {
      origLineNum++;
      newLineNum++;
      rows.push({ type: "ctx", origLineNum, newLineNum, content: line.slice(1), sign: " " });
    } else if (line === "") {
      continue;
    } else {
      rows.push({ type: "ctx", origLineNum, newLineNum, content: line, sign: "" });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a unified diff as an HTML table with line numbers, +/- indicators,
 * and inline comment support.
 */
export function DiffTable(props: DiffTableProps): JSX.Element {
  const {
    diff,
    filePath,
    fileStatus,
    lineComments,
    editingComment,
    editingCommentDraft,
    allowComments,
    onStartEditComment,
    onSaveComment,
    onCancelComment,
    onRemoveComment,
    onDraftChange,
    onReference,
  } = props;

  if (!diff) return <div class="main-empty"><p>No diff available</p></div>;

  const fileComments = lineComments[filePath] || {};
  const rows = parseDiffRows(diff);

  // Context menu state — captures selection at right-click time
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; lines: SelectedLineInfo[] } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  // Close context menu on any click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [contextMenu]);

  // Pre-compute highlighted line content (memoized on diff + filePath)
  const highlightedLines = useMemo(() => {
    const map = new Map<number, string>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.type === "hunk" || r.type === "header") continue;
      const hl = highlightLine(r.content, filePath);
      if (hl) map.set(i, hl);
    }
    return map;
  }, [diff, filePath]);

  // Build a flat array of <tr> elements so Preact reconciles correctly
  const tableRows: JSX.Element[] = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];

    if (row.type === "hunk" || row.type === "header") {
      const showAction = fileStatus === "accepted" || fileStatus === "reverted";
      const statusLabel = showAction
        ? `[${fileStatus === "accepted" ? "Accepted" : "Reverted"}] `
        : "";
      tableRows.push(
        <tr key={idx} class="diff-hunk">
          <td class="line-num" colspan={3}>
            <span class={`hunk-status-${fileStatus}`}>{statusLabel}</span>
            {row.content}
          </td>
        </tr>,
      );
      continue;
    }

    // Standard unified diff: del/ctx show origLineNum, add shows newLineNum
    const lineNum = row.type === "del" ? row.origLineNum : row.newLineNum;
    const rowKey = `${lineNum}-${row.type}`;
    const isEditing = isLineEditing(editingComment, filePath, rowKey);
    const commentBubble = (isEditing || !allowComments)
      ? null
      : renderCommentBubble(
          filePath,
          lineNum,
          rowKey,
          fileComments,
          onStartEditComment,
          onRemoveComment,
        );
    const commentIndicator = (isEditing || !allowComments)
      ? null
      : renderCommentIndicator(fileComments, rowKey, lineNum);

    tableRows.push(
      <tr key={idx} class={`diff-${row.type}${fileStatus !== "pending" ? ` diff-status-${fileStatus}` : ""}`} data-line={lineNum} data-type={row.type}>
        <td
          class={`line-num${allowComments ? "" : " line-num-disabled"}`}
          data-action={allowComments ? "comment-line" : undefined}
          data-path={allowComments ? filePath : undefined}
          data-line={allowComments ? lineNum : undefined}
          onClick={allowComments
            ? () => { isEditing ? onCancelComment() : onStartEditComment(filePath, lineNum, rowKey); }
            : undefined
          }
        >
          {row.type === "del" ? "" : lineNum}
        </td>
        <td class="line-sign">{fileStatus === "accepted" ? "✓" : fileStatus === "reverted" ? "✕" : row.sign}</td>
        <td class="line-content">
          {commentIndicator}
          {highlightedLines.has(idx) ? (
            <span dangerouslySetInnerHTML={{ __html: highlightedLines.get(idx)! }} />
          ) : (
            row.content
          )}
        </td>
      </tr>,
    );

    // Show saved comment bubble as a separate row below the content
    if (commentBubble) {
      tableRows.push(
        <tr key={`bubble-${idx}`} class={`diff-${row.type}${fileStatus !== "pending" ? ` diff-status-${fileStatus}` : ""}`}>
          <td class="line-num" />
          <td class="line-sign" />
          <td class="line-content" style="white-space:normal;overflow:visible">
            {commentBubble}
          </td>
        </tr>,
      );
    }

    // If this line is being edited, append the input row right after
    if (isEditing && allowComments) {
      tableRows.push(
        <CommentInputRow
          key={rowKey}
          filePath={filePath}
          lineNum={lineNum}
          editingCommentDraft={editingCommentDraft}
          onSave={onSaveComment}
          onCancel={onCancelComment}
          onDraftChange={onDraftChange}
        />,
      );
    }
  }

  return (
    <>
      <table
        class="diff-table"
        ref={tableRef}
        onContextMenu={(e: MouseEvent) => {
          if (!onReference) return;
          e.preventDefault();
          // Capture selection now — clicking the menu clears it
          const lines = tableRef.current ? extractSelectedLines(tableRef.current) : [];
          setContextMenu({ x: e.clientX, y: e.clientY, lines });
        }}
      >
        <colgroup>
          <col class="col-num" />
          <col class="col-sign" />
          <col class="col-content" />
        </colgroup>
        <tbody>
          {tableRows}
        </tbody>
      </table>
      {contextMenu && onReference && (
        <div
          class="context-menu"
          style={{ left: contextMenu.x + "px", top: contextMenu.y + "px" }}
        >
          <div
            class="context-menu-item"
            onClick={() => {
              if (contextMenu.lines.length > 0) {
                onReference(contextMenu.lines, filePath);
              }
              setContextMenu(null);
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Reference this code
          </div>
        </div>
      )}
    </>
  );
}
