/**
 * FullFileView component for displaying the complete file content
 * with diff highlighting on changed lines.
 *
 * Shows ALL lines of the current file, with deleted lines injected
 * at their original positions (highlighted in red), added lines
 * highlighted in green, and unchanged lines shown normally.
 * This gives the same change visibility as the diff view but
 * within the context of the full file.
 */

import { JSX } from "preact";
import { useRef, useEffect, useMemo, useState } from "preact/hooks";
import type { FileDiff } from "../../types.js";
import {
  type FileComments,
  type LineCommentsStore,
  type EditingComment,
} from "../utils.js";
import { highlightLine } from "../highlight.js";
import { extractSelectedLines, type SelectedLineInfo } from "../selection.js";
import type { MinimapLine } from "./code-minimap.js";

/** Build minimap lines from content (non-pending: all ctx). */
export function buildMinimapLinesPlain(content: string): MinimapLine[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line, i) => ({ type: "ctx" as const, lineNum: i + 1, content: line }));
}

/** Build minimap lines from fullRows (pending: typed add/del/ctx). */
export function buildMinimapLinesFull(fullRows: Array<{ type: "add" | "del" | "ctx"; displayLineNum: number; content: string }>): MinimapLine[] {
  return fullRows.map((row) => ({ type: row.type, lineNum: row.displayLineNum, content: row.content }));
}


// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FullFileViewProps {
  /** The file diff for the selected file. */
  fileDiff: FileDiff;
  /** The current file content (fetched from server). */
  content: string | null;
  /** All line comments across files. */
  lineComments: LineCommentsStore;
  /** Currently editing comment position, or null. */
  editingComment: EditingComment | null;
  /** Draft text for the editing comment input. */
  editingCommentDraft: string;
  /** Whether comments are allowed. */
  allowComments: boolean;
  /** Called to start editing a comment on a line. */
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
  /** Set of line numbers that were externally changed (for showing line icons). */
  externalChangedLines?: Set<number>;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into rows with line number tracking.
 */
export function parseDiffRows(diff: string): Array<{
  type: "add" | "del" | "ctx";
  origLineNum: number;
  newLineNum: number;
  content: string;
}> {
  const lines = diff.split("\n");
  const rows: Array<{
    type: "add" | "del" | "ctx";
    origLineNum: number;
    newLineNum: number;
    content: string;
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
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

    if (line.startsWith("+")) {
      newLineNum++;
      rows.push({ type: "add", origLineNum, newLineNum, content: line.slice(1) });
    } else if (line.startsWith("-")) {
      origLineNum++;
      rows.push({ type: "del", origLineNum, newLineNum, content: line.slice(1) });
    } else if (line.startsWith(" ")) {
      origLineNum++;
      newLineNum++;
      rows.push({ type: "ctx", origLineNum, newLineNum, content: line.slice(1) });
    }
  }

  return rows;
}

/**
 * Build a merged view of the full file with deleted lines injected.
 * Line numbers track the actual file position (sequential from 1).
 * Deleted lines are shown without a line number (they no longer exist).
 */
export function buildFullFileRows(
  currentContent: string,
  diffRows: Array<{ type: "add" | "del" | "ctx"; origLineNum: number; newLineNum: number; content: string }>,
): Array<{
  type: "add" | "del" | "ctx";
  displayLineNum: number;
  content: string;
  rowKey: string;
}> {
  const currentLines = currentContent.split("\n");
  if (currentLines.length > 0 && currentLines[currentLines.length - 1] === "") {
    currentLines.pop();
  }

  // Find where the diff starts in the new file
  let minNewNum = Infinity;
  for (const row of diffRows) {
    if (row.type === "ctx" || row.type === "add") {
      if (row.newLineNum < minNewNum) minNewNum = row.newLineNum;
    }
  }
  if (minNewNum === Infinity) minNewNum = 1;

  const result: Array<{ type: "add" | "del" | "ctx"; displayLineNum: number; content: string; rowKey: string }> = [];
  let currentIdx = 0;
  let lineCounter = 1;

  // Lines before the first diff hunk (purely context)
  for (let i = 0; i < currentLines.length; i++) {
    if (i + 1 >= minNewNum) break;
    result.push({ type: "ctx", displayLineNum: lineCounter, content: currentLines[i], rowKey: `pre-${i}` });
    currentIdx = i + 1;
    lineCounter++;
  }

  // Walk through diff rows, reading from current file for add/ctx
  for (let i = 0; i < diffRows.length; i++) {
    const row = diffRows[i];

    if (row.type === "del") {
      // Deleted content — show without a line number (displayLineNum=0 means none)
      result.push({ type: "del", displayLineNum: 0, content: row.content, rowKey: `d${row.origLineNum}` });
    } else {
      // add or ctx — read next line from current file
      const content = currentIdx < currentLines.length ? currentLines[currentIdx] : "";
      currentIdx++;
      const stableNum = row.type === "add" ? row.newLineNum : row.origLineNum;
      result.push({ type: row.type, displayLineNum: lineCounter, content, rowKey: `${row.type[0]}${stableNum}` });
      lineCounter++;
    }
  }

  // Lines after the last diff hunk
  while (currentIdx < currentLines.length) {
    result.push({ type: "ctx", displayLineNum: lineCounter, content: currentLines[currentIdx], rowKey: `post-${currentIdx}` });
    currentIdx++;
    lineCounter++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Comment rendering
// ---------------------------------------------------------------------------

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
    <span class={`line-comment-indicator${isSent ? " comment-sent" : ""}${isDone ? " comment-done" : ""}`} title={comment.text}></span>
  );
}

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
        <span class="comment-text">[comment] {comment.text}</span>
        {isSent && <span class="comment-sent-check">✓</span>}
        {isDone && <span class="comment-done-check">✓</span>}
        <button
          class="btn-comment-remove"
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
            onClick={() => onSave(filePath, lineNum)}
            title="Save comment"
          >
            ✓
          </button>
          <button
            class="btn-comment btn-comment-cancel"
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
// Component
// ---------------------------------------------------------------------------

export function FullFileView(props: FullFileViewProps): JSX.Element {
  const {
    fileDiff,
    content,
    lineComments,
    editingComment,
    editingCommentDraft,
    allowComments,
    externalChangedLines,
    onStartEditComment,
    onSaveComment,
    onCancelComment,
    onRemoveComment,
    onDraftChange,
    onReference,
  } = props;

  // Context menu state — captures selection at right-click time
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; lines: any[] } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);



  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [contextMenu]);

  if (!content) {
    return <div class="main-empty"><p>Loading file content...</p></div>;
  }

  const fileComments = lineComments[fileDiff.filePath] || {};
  const isPending = fileDiff.status === "pending";

  // Split current content once, used by both paths
  const currentLines = useMemo(() => {
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }, [content]);

  // Pre-compute highlighted line content for non-pending path
  const hlCache = useMemo(() => {
    if (isPending) return new Map<number, string>();
    const m = new Map<number, string>();
    for (let i = 0; i < currentLines.length; i++) {
      const hl = highlightLine(currentLines[i], fileDiff.filePath);
      if (hl) m.set(i, hl);
    }
    return m;
  }, [currentLines, fileDiff.filePath, isPending]);

  // Parse diff/full rows for pending path
  const diffRows = useMemo(() => isPending ? parseDiffRows(fileDiff.diff) : [], [fileDiff.diff, isPending]);
  const fullRows = useMemo(() => isPending ? buildFullFileRows(content, diffRows) : [], [content, diffRows, isPending]);

  // Pre-compute highlighted line content for pending path
  const hlCacheFull = useMemo(() => {
    if (!isPending) return new Map<number, string>();
    const m = new Map<number, string>();
    for (let i = 0; i < fullRows.length; i++) {
      const hl = highlightLine(fullRows[i].content, fileDiff.filePath);
      if (hl) m.set(i, hl);
    }
    return m;
  }, [fullRows, fileDiff.filePath, isPending]);

  // If no pending changes, show plain file content without diff highlighting
  if (!isPending) {
    const tableRows: JSX.Element[] = [];
    for (let i = 0; i < currentLines.length; i++) {
      const lineNum = i + 1;
      const rowKey = `${lineNum}-ctx`;
      const isEditing = allowComments && isLineEditing(editingComment, fileDiff.filePath, rowKey);
      const isExternalLine = externalChangedLines && externalChangedLines.has(lineNum);
      const commentBubble = (isEditing || !allowComments)
        ? null
        : renderCommentBubble(fileDiff.filePath, lineNum, rowKey, fileComments, onStartEditComment, onRemoveComment);
      const commentIndicator = (isEditing || !allowComments)
        ? null
        : renderCommentIndicator(fileComments, rowKey, lineNum);

      tableRows.push(
        <tr key={i} class={`diff-ctx${isExternalLine ? " diff-external" : ""}`}>
          <td
            class={`line-num${allowComments ? "" : " line-num-disabled"}`}
            data-action={allowComments ? "comment-line" : undefined}
            data-path={allowComments ? fileDiff.filePath : undefined}
            data-line={allowComments ? lineNum : undefined}
            onClick={allowComments
              ? () => { isEditing ? onCancelComment() : onStartEditComment(fileDiff.filePath, lineNum, rowKey); }
              : undefined
            }
          >
            {lineNum}
            {isExternalLine && <span class="ext-change-icon" title="Externally modified">⚡</span>}
          </td>
          <td class="line-sign"> </td>
          <td class="line-content">
            {commentIndicator}
            {hlCache.has(i) ? (
              <span dangerouslySetInnerHTML={{ __html: hlCache.get(i)! }} />
            ) : (
              currentLines[i]
            )}
          </td>
        </tr>,
      );

      // Show saved comment bubble as a separate row below content
      if (commentBubble) {
        tableRows.push(
          <tr key={`bubble-${i}`} class="diff-ctx">
            <td class="line-num" />
            <td class="line-sign" />
            <td class="line-content" style="white-space:normal;overflow:visible">
              {commentBubble}
            </td>
          </tr>,
        );
      }

      if (isEditing) {
        tableRows.push(
          <CommentInputRow
            key={rowKey}
            filePath={fileDiff.filePath}
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
          <div class="context-menu" style={{ left: contextMenu.x + "px", top: contextMenu.y + "px" }}>
            <div class="context-menu-item" onClick={() => {
              if (contextMenu.lines.length > 0) onReference(contextMenu.lines, fileDiff.filePath);
              setContextMenu(null);
            }}>
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

  // Pending changes: show merged view with deleted lines and highlighting
  const tableRows: JSX.Element[] = [];

  for (let i = 0; i < fullRows.length; i++) {
    const row = fullRows[i];
    const lineNum = row.displayLineNum;
    const rowKey = row.rowKey;
    const isEditing = isLineEditing(editingComment, fileDiff.filePath, rowKey);
    // Don't render the saved comment bubble if we're currently editing this row
    // or if comments are disabled for this view
    const commentBubble = (isEditing || !allowComments)
      ? null
      : renderCommentBubble(
          fileDiff.filePath,
          lineNum,
          rowKey,
          fileComments,
          onStartEditComment,
          onRemoveComment,
        );
    const commentIndicator = (isEditing || !allowComments)
      ? null
      : renderCommentIndicator(fileComments, rowKey, lineNum);

    const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
    const showLineNum = row.displayLineNum > 0 ? String(row.displayLineNum) : "";
    const isExternalLine = externalChangedLines && row.displayLineNum > 0 && externalChangedLines.has(row.displayLineNum);

    tableRows.push(
      <tr key={i} class={`diff-${row.type}${isExternalLine ? " diff-external" : ""}`} data-line={row.displayLineNum > 0 ? row.displayLineNum : 0} data-type={row.type}>
        <td
          class={`line-num${allowComments && lineNum > 0 ? "" : " line-num-disabled"}`}
          data-action={allowComments && lineNum > 0 ? "comment-line" : undefined}
          data-path={allowComments && lineNum > 0 ? fileDiff.filePath : undefined}
          data-line={allowComments && lineNum > 0 ? lineNum : undefined}
          onClick={allowComments && lineNum > 0
            ? () => { isEditing ? onCancelComment() : onStartEditComment(fileDiff.filePath, lineNum, rowKey); }
            : undefined
          }
        >
          {showLineNum}
          {isExternalLine && <span class="ext-change-icon" title="Externally modified">⚡</span>}
        </td>
        <td class="line-sign">{sign}</td>
        <td class="line-content">
          {commentIndicator}
          {hlCacheFull.has(i) ? (
            <span dangerouslySetInnerHTML={{ __html: hlCacheFull.get(i)! }} />
          ) : (
            row.content
          )}
        </td>
      </tr>,
    );

    // Show saved comment bubble as a separate row below content
    if (commentBubble) {
      tableRows.push(
        <tr key={`bubble-${i}`} class={`diff-${row.type}`}>
          <td class="line-num" />
          <td class="line-sign" />
          <td class="line-content" style="white-space:normal;overflow:visible">
            {commentBubble}
          </td>
        </tr>,
      );
    }

    if (isEditing && allowComments) {
      tableRows.push(
        <CommentInputRow
          key={rowKey}
          filePath={fileDiff.filePath}
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
        <div class="context-menu" style={{ left: contextMenu.x + "px", top: contextMenu.y + "px" }}>
          <div class="context-menu-item" onClick={() => {
            if (contextMenu.lines.length > 0) onReference(contextMenu.lines, fileDiff.filePath);
            setContextMenu(null);
          }}>
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
