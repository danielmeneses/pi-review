/**
 * FileViewer component for displaying a selected file's changes.
 *
 * Combines the file header (path, status, action buttons) with either
 * the diff table view or the full file view with diff highlighting.
 * Also supports viewing history cycle diffs.
 */

import { JSX } from "preact";
import { useMemo, useRef } from "preact/hooks";
import type { FileDiff, ChangeCycle, ExternalFileChange } from "../../types.js";
import {
  dotClassForStatus,
  statusLabel,
  formatChangeCount,
  formatTime,
  formatDateTime,
  type LineCommentsStore,
  type EditingComment,
} from "../utils.js";
import { DiffTable } from "./diff-table.js";
import { FullFileView, buildMinimapLinesPlain, buildMinimapLinesFull, parseDiffRows, buildFullFileRows } from "./full-file-view.js";
import { EditorSelector } from "./editor-selector.js";
import { CodeMinimap } from "./code-minimap.js";
import type { SelectedLineInfo } from "../selection.js";
import type { MinimapLine } from "./code-minimap.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileViewerProps {
  /** The currently selected file diff, or null. */
  selectedFile: FileDiff | null;
  /** The currently selected history cycle, or null. */
  selectedCycle: ChangeCycle | null;
  /** The currently selected file path (from sidebar). */
  selectedPath?: string | null;
  /** Whether the full file view is enabled for the selected file. */
  showFullFile: boolean;
  /** The cached file content for full file view. */
  fileContent: string | null;
  /** All line comments across files. */
  lineComments: LineCommentsStore;
  /** Currently editing comment position, or null. */
  editingComment: EditingComment | null;
  /** Draft text for the editing comment input. */
  editingCommentDraft: string;
  /** Set of line numbers that were externally changed (for showing line icons). */
  externalChangedLines?: Set<number>;
  /** All external file changes. */
  externalChanges?: ExternalFileChange[];
  /** Called to accept the selected file. */
  onAccept: () => void;
  /** Called to revert the selected file. */
  onRevert: () => void;
  /** Called to toggle the full file view. */
  onToggleFull: () => void;
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
// History Cycle Viewer
// ---------------------------------------------------------------------------

/**
 * Renders a read-only view of a history cycle's diff.
 */
function HistoryCycleView({ cycle, onReference }: { cycle: ChangeCycle; onReference?: (lines: any[], filePath: string) => void }): JSX.Element {
  const timeStr = formatDateTime(cycle.timestamp);
  const statusClass = cycle.action === "accepted" ? "dot-accepted" : "dot-reverted";
  const badgeClass = cycle.action === "accepted" ? "badge-accepted" : "badge-reverted";

  return (
    <div class="file-viewer">
      <div class="file-header">
        <div class="file-header-info">
          <span class={`status-dot ${statusClass}`}></span>
          <span
            class="file-header-path"
            title={cycle.relativePath}
          >
            {cycle.relativePath}
          </span>
          <span class="file-header-meta">
            {cycle.action} - {formatChangeCount(cycle.changeCount)} - {timeStr}
          </span>
          <span class={`badge ${badgeClass}`}>
            {statusLabel(cycle.action)}
          </span>
        </div>
      </div>
      <div class="diff-scroll">
        {cycle.diff ? (
          <DiffTable
            diff={cycle.diff}
            filePath={cycle.filePath}
            fileStatus={cycle.action}
            lineComments={{}}
            editingComment={null}
            editingCommentDraft=""
            allowComments={false}
            onStartEditComment={() => {}}
            onSaveComment={() => {}}
            onCancelComment={() => {}}
            onRemoveComment={() => {}}
            onDraftChange={() => {}}
            onReference={onReference}
          />
        ) : (
          <div class="main-empty"><p>No diff available</p></div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the file viewer: header with path/status/actions,
 * and either a diff table or full file view below.
 */
export function FileViewer(props: FileViewerProps): JSX.Element {
  const {
    selectedFile,
    selectedCycle,
    selectedPath,
    showFullFile,
    fileContent,
    lineComments,
    editingComment,
    editingCommentDraft,
    externalChangedLines,
    externalChanges,
    onAccept,
    onRevert,
    onToggleFull,
    onStartEditComment,
    onSaveComment,
    onCancelComment,
    onRemoveComment,
    onDraftChange,
    onReference,
  } = props;

  const fullFileScrollRef = useRef<HTMLDivElement>(null);

  // If a history cycle is selected, show that cycle's diff
  if (selectedCycle) {
    return <HistoryCycleView cycle={selectedCycle} onReference={onReference} />;
  }

  // No file selected — check if there's an external change for the path
  if (!selectedFile) {
    // Merge ALL external changes for this file (multiple entries possible)
    const extFiles = selectedPath
      ? externalChanges?.filter(ec => ec.filePath === selectedPath)
      : undefined;
    if (extFiles && extFiles.length > 0) {
      // Aggregate all changed lines and diffs from all external change entries
      const allChangedLines = extFiles.flatMap(ec => ec.changedLines);
      const allDiffs = extFiles.map(ec => ec.diff).join("\n");
      const firstExt = extFiles[0];
      const countLabel = extFiles.length > 1
        ? `${extFiles.length} external change${extFiles.length > 1 ? 's' : ''}`
        : 'external changes only';
      return (
        <div class="file-viewer">
          <div class="file-header">
            <div class="file-header-info">
              <span class="status-dot dot-external"></span>
              <span class="file-header-path" title={firstExt.relativePath}>
                {firstExt.relativePath}
              </span>
              <span class="file-header-meta">{countLabel}</span>
              <span class="badge badge-pending">External</span>
            </div>
          </div>
          <div class="diff-scroll">
            <DiffTable
              diff={allDiffs}
              filePath={firstExt.filePath}
              fileStatus="pending"
              lineComments={lineComments}
              editingComment={editingComment}
              editingCommentDraft={editingCommentDraft}
              allowComments={true}
              externalChangedLines={new Set(allChangedLines)}
              onStartEditComment={onStartEditComment}
              onSaveComment={onSaveComment}
              onCancelComment={onCancelComment}
              onRemoveComment={onRemoveComment}
              onDraftChange={onDraftChange}
              onReference={onReference}
            />
          </div>
        </div>
      );
    }
    return (
      <div class="main-empty">
        <div>
          <h2>Select a file</h2>
          <p>Choose a file from the sidebar to view its changes</p>
        </div>
      </div>
    );
  }

  const f = selectedFile;
  const isPending = f.status === "pending";
  const tools = f.tools.join(", ");
  const dotClass = dotClassForStatus(f.status);
  const badgeClass = `badge-${f.status}`;

  // Build minimap lines for full-file view
  const minimapLines: MinimapLine[] = useMemo(() => {
    if (!showFullFile || !fileContent) return [];
    if (!isPending) {
      return buildMinimapLinesPlain(fileContent);
    }
    const dRows = parseDiffRows(f.diff);
    const fullRows = buildFullFileRows(fileContent, dRows);
    return buildMinimapLinesFull(fullRows);
  }, [showFullFile, fileContent, isPending, f.diff, f.filePath]);

  return (
    <div class="file-viewer">
      <div class="file-header">
        <div class="file-header-info">
          <span class={`status-dot ${dotClass}`}></span>
          <span
            class="file-header-path"
            title={f.relativePath}
          >
            {f.relativePath}
          </span>
          <EditorSelector filePath={f.filePath} />
          <span class="file-header-meta">
            {tools} - {formatChangeCount(f.changeCount)}
          </span>
          {isPending && (
            <span class={`badge ${badgeClass}`}>
              {statusLabel(f.status)}
            </span>
          )}
        </div>
        <div class="file-header-actions">
          {showFullFile && isPending && (
            <button
              class="btn btn-scroll-next"
              data-action="scroll-next-diff"
              title="Scroll to next diff"
              onClick={() => {
                const scrollEl = document.querySelector(".diff-scroll");
                if (!scrollEl) return;
                const diffRows = scrollEl.querySelectorAll<HTMLElement>("tr.diff-add, tr.diff-del");
                if (diffRows.length === 0) return;
                const viewportBottom = scrollEl.scrollTop + scrollEl.clientHeight;
                // Find the first row whose top is at or below the viewport bottom
                let nextRow: HTMLElement | null = null;
                for (const row of diffRows) {
                  const rowTop = row.getBoundingClientRect().top;
                  const scrollRect = scrollEl.getBoundingClientRect();
                  const relativeTop = rowTop - scrollRect.top;
                  if (relativeTop >= viewportBottom - 10) {
                    nextRow = row;
                    break;
                  }
                }
                // If no row is below viewport, wrap to the first diff row
                if (!nextRow && diffRows.length > 0) {
                  nextRow = diffRows[0] as HTMLElement;
                }
                if (nextRow) {
                  nextRow.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }}
            >
              <svg class="btn-icon" viewBox="0 0 24 24" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>
            </button>
          )}
          <button
            class={`btn btn-toggle-full${showFullFile ? " btn-toggle-active" : ""}`}
            data-action="toggle-full"
            data-path={f.filePath}
            onClick={onToggleFull}
          >
            {showFullFile ? (
              <>
                <svg class="btn-icon" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
                Diff Only
              </>
            ) : (
              <>
                <svg class="btn-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>
                Full File
              </>
            )}
          </button>
          {isPending && (
            <>
              <button
                class="btn btn-accept"
                data-action="accept-file"
                data-path={f.filePath}
                onClick={onAccept}
              >
                <svg class="btn-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
                Accept
              </button>
              <button
                class="btn btn-revert"
                data-action="revert-file"
                data-path={f.filePath}
                onClick={onRevert}
              >
                <svg class="btn-icon" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                Revert
              </button>
            </>
          )}
        </div>
      </div>
      {showFullFile ? (
        <div class="file-body-with-minimap">
          <div class="diff-scroll" ref={fullFileScrollRef}>
            {buildExternalChangedLines(f.externalChangedLines, showFullFile, f, fileContent, lineComments, editingComment, editingCommentDraft, isPending, onStartEditComment, onSaveComment, onCancelComment, onRemoveComment, onDraftChange, onReference)}
          </div>
          <CodeMinimap lines={minimapLines} scrollRef={fullFileScrollRef} />
        </div>
      ) : (
        <div class="diff-scroll">
          {buildExternalChangedLines(f.externalChangedLines, showFullFile, f, fileContent, lineComments, editingComment, editingCommentDraft, isPending, onStartEditComment, onSaveComment, onCancelComment, onRemoveComment, onDraftChange, onReference)}
        </div>
      )}
    </div>
  );
}

/** Helper to render the diff/full-file view with external change line info. */
function buildExternalChangedLines(
  externalChangedLines: number[] | undefined,
  showFullFile: boolean,
  f: FileDiff,
  fileContent: string | null,
  lineComments: LineCommentsStore,
  editingComment: EditingComment | null,
  editingCommentDraft: string,
  isPending: boolean,
  onStartEditComment: (filePath: string, lineNum: number, rowKey: string) => void,
  onSaveComment: (filePath: string, lineNum: number) => void,
  onCancelComment: () => void,
  onRemoveComment: (filePath: string, lineNum: number) => void,
  onDraftChange: (value: string) => void,
  onReference?: (lines: SelectedLineInfo[], filePath: string) => void,
): JSX.Element {
  const extChanged = externalChangedLines ? new Set(externalChangedLines) : undefined;

  if (showFullFile) {
    return (
      <FullFileView
        fileDiff={f}
        content={fileContent}
        lineComments={lineComments}
        editingComment={editingComment}
        editingCommentDraft={editingCommentDraft}
        allowComments={true}
        externalChangedLines={extChanged}
        onStartEditComment={onStartEditComment}
        onSaveComment={onSaveComment}
        onCancelComment={onCancelComment}
        onRemoveComment={onRemoveComment}
        onDraftChange={onDraftChange}
        onReference={onReference}
      />
    );
  }

  if (f.diff) {
    return (
      <DiffTable
        diff={f.diff}
        filePath={f.filePath}
        fileStatus={isPending ? f.status : "resolved"}
        lineComments={lineComments}
        editingComment={isPending ? editingComment : null}
        editingCommentDraft={editingCommentDraft}
        allowComments={isPending}
        externalChangedLines={extChanged}
        onStartEditComment={onStartEditComment}
        onSaveComment={onSaveComment}
        onCancelComment={onCancelComment}
        onRemoveComment={onRemoveComment}
        onDraftChange={onDraftChange}
        onReference={onReference}
      />
    );
  }

  return <div class="main-empty"><p>No diff available</p></div>;
}
