/**
 * SearchedFileView — renders a plain file from search with full file viewer style.
 *
 * Reuses FullFileView and CodeMinimap with the same layout as FileViewer's
 * full-file mode so scrolling and minimap behavior stay consistent.
 */

import { JSX } from "preact";
import { useRef, useMemo } from "preact/hooks";
import type { FileDiff } from "../../types.js";
import type { LineCommentsStore, EditingComment } from "../utils.js";
import type { SelectedLineInfo } from "../selection.js";
import { EditorSelector } from "./editor-selector.js";
import { FullFileView, buildMinimapLinesPlain } from "./full-file-view.js";
import { CodeMinimap } from "./code-minimap.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SearchedFileViewProps {
  relativePath: string;
  absolutePath: string;
  content: string;
  lineComments: LineCommentsStore;
  editingComment: EditingComment | null;
  editingCommentDraft: string;
  onStartEditComment: (filePath: string, lineNum: number, rowKey: string) => void;
  onSaveComment: (filePath: string, lineNum: number) => void;
  onCancelComment: () => void;
  onRemoveComment: (filePath: string, lineNum: number) => void;
  onDraftChange: (value: string) => void;
  onReference?: (lines: SelectedLineInfo[], filePath: string) => void;
}

function makePlainFileDiff(relativePath: string, absolutePath: string, content: string): FileDiff {
  return {
    filePath: absolutePath,
    relativePath,
    diff: "",
    blocks: [],
    originalContent: content,
    status: "accepted",
    changeCount: 0,
    tools: [],
    firstChangeTime: 0,
    lastChangeTime: 0,
    fileExisted: true,
    hasExternalChanges: false,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SearchedFileView(props: SearchedFileViewProps): JSX.Element {
  const {
    relativePath,
    absolutePath,
    content,
    lineComments,
    editingComment,
    editingCommentDraft,
    onStartEditComment,
    onSaveComment,
    onCancelComment,
    onRemoveComment,
    onDraftChange,
    onReference,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileDiff = useMemo(
    () => makePlainFileDiff(relativePath, absolutePath, content),
    [relativePath, absolutePath, content],
  );
  const minimapLines = useMemo(() => buildMinimapLinesPlain(content), [content]);
  const lineCount = minimapLines.length;

  return (
    <div class="file-viewer">
      <div class="file-header">
        <div class="file-header-info">
          <span class="status-dot dot-accepted"></span>
          <span class="file-header-path" title={relativePath}>{relativePath}</span>
          <EditorSelector filePath={absolutePath} />
          <span class="file-header-meta">{lineCount} lines</span>
        </div>
      </div>
      <div class="file-body-with-minimap">
        <div class="diff-scroll" ref={scrollRef}>
          <FullFileView
            fileDiff={fileDiff}
            content={content}
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
        </div>
        <CodeMinimap lines={minimapLines} scrollRef={scrollRef} />
      </div>
    </div>
  );
}
