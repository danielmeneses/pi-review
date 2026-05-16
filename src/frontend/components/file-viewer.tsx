/**
 * FileViewer component for displaying a selected file's changes.
 *
 * Combines the file header (path, status, action buttons) with either
 * the diff table view or the full file view with diff highlighting.
 * Also supports viewing history cycle diffs.
 */

import { JSX } from "preact";
import type { FileDiff, ChangeCycle } from "../../types.js";
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
import { FullFileView } from "./full-file-view.js";
import type { SelectedLineInfo } from "../selection.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileViewerProps {
  /** The currently selected file diff, or null. */
  selectedFile: FileDiff | null;
  /** The currently selected history cycle, or null. */
  selectedCycle: ChangeCycle | null;
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
    showFullFile,
    fileContent,
    lineComments,
    editingComment,
    editingCommentDraft,
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

  // If a history cycle is selected, show that cycle's diff
  if (selectedCycle) {
    return <HistoryCycleView cycle={selectedCycle} onReference={onReference} />;
  }

  // No file selected
  if (!selectedFile) {
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
          <button
            class="btn-open-editor"
            title="Open in VS Code"
            onClick={async () => {
              try {
                await fetch(`/api/open-in-editor/${encodeURIComponent(f.filePath)}`, { method: "POST" });
              } catch { /* ignore */ }
            }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
              <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/>
            </svg>
          </button>
          <span class="file-header-meta">
            {tools} - {formatChangeCount(f.changeCount)}
          </span>
          {isPending && (
            <span class={`badge ${badgeClass}`}>
              {statusLabel(f.status)}
            </span>
          )}
        </div>
        {f.hasExternalChanges && (
          <div class="file-external-warning">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            External modifications detected — diff includes changes from outside the agent
          </div>
        )}
        <div class="file-header-actions">
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
      <div class="diff-scroll">
        {showFullFile ? (
          <FullFileView
            fileDiff={f}
            content={fileContent}
            lineComments={lineComments}
            editingComment={editingComment}
            editingCommentDraft={editingCommentDraft}
            allowComments={true}
            onStartEditComment={onStartEditComment}
            onSaveComment={onSaveComment}
            onCancelComment={onCancelComment}
            onRemoveComment={onRemoveComment}
            onDraftChange={onDraftChange}
            onReference={onReference}
          />
        ) : f.diff ? (
          <DiffTable
            diff={f.diff}
            filePath={f.filePath}
            fileStatus={isPending ? f.status : "resolved"}
            lineComments={lineComments}
            editingComment={isPending ? editingComment : null}
            editingCommentDraft={editingCommentDraft}
            allowComments={isPending}
            onStartEditComment={onStartEditComment}
            onSaveComment={onSaveComment}
            onCancelComment={onCancelComment}
            onRemoveComment={onRemoveComment}
            onDraftChange={onDraftChange}
            onReference={onReference}
          />
        ) : (
          <div class="main-empty"><p>No diff available</p></div>
        )}
      </div>
    </div>
  );
}
