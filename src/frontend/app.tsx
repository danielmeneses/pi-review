/**
 * App component — top-level Preact component for the Change Tracker.
 *
 * Manages all application state including file diffs, history, selected file,
 * line comments, and SSE connection. Coordinates data fetching and renders
 * the Header, Sidebar, and FileViewer components.
 */

import { JSX } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import type { FileDiff, ChangeCycle, AggregatedState, ExternalFileChange } from "../types.js";
import {
  countTotalComments,
  relativePathFromAbs,
  buildDiffLineMap,
  lookupDiffLine,
  type LineCommentsStore,
  type EditingComment,
} from "./utils.js";
import {
  fetchState,
  apiAcceptAll,
  apiRevertAll,
  apiAcceptFile,
  apiRevertFile,
  apiGetFileContent,
  apiSendComments,
  apiSendReference,
  apiSendFollowup,
  apiPollReferenceResponse,
  apiSendChat,
  apiPollChatResponse,
  SSEManager,
  type SSEStatus,
  apiClearNonPending,
  apiClearFile,
  fetchExternalChanges,
  apiAcknowledgeExternal,
  apiAcknowledgeAllExternal,
} from "./store.js";
import { Header } from "./components/header.js";
import { Sidebar } from "./components/sidebar.js";
import { FileViewer } from "./components/file-viewer.js";
import { ReferencePanel, type SelectedLines, type ConversationMessage } from "./components/reference-panel.js";
import { ChatPanel, type ChatMessage } from "./components/chat-panel.js";
import type { SelectedLineInfo } from "./selection.js";

// ---------------------------------------------------------------------------
// App Component
// ---------------------------------------------------------------------------

/**
 * The root component for the Change Tracker frontend.
 * Manages state, SSE, API calls, and renders the full UI.
 */
export function App(): JSX.Element {
  // -- Sidebar resize state --
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // -- Data state --
  const [fileDiffs, setFileDiffs] = useState<FileDiff[]>([]);
  const [history, setHistory] = useState<ChangeCycle[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // -- Selection state --
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);

  // -- View state --
  const [fullFileView, setFullFileView] = useState<Record<string, boolean>>({});
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});

  // -- Comment state --
  const COMMENT_STORAGE_KEY = "pi-review-comments";
  const [lineComments, setLineComments] = useState<LineCommentsStore>(() => {
    try {
      const stored = localStorage.getItem(COMMENT_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [editingComment, setEditingComment] = useState<EditingComment | null>(null);
  const [editingCommentDraft, setEditingCommentDraft] = useState("");

  // -- SSE state --
  const [sseStatus, setSseStatus] = useState<SSEStatus>("disconnected");

  // -- External changes state --
  const [externalChanges, setExternalChanges] = useState<ExternalFileChange[]>([]);

  // -- Reference panel state --
  const [refSelection, setRefSelection] = useState<SelectedLines | null>(null);
  const [refMessages, setRefMessages] = useState<ConversationMessage[]>([]);
  const [refDraft, setRefDraft] = useState("");
  const [refResponse, setRefResponse] = useState<string | null>(null);
  const [refSending, setRefSending] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const refMessagesRef = useRef<ConversationMessage[]>([]);
  const refDraftRef = useRef("");
  const lastSelectionRef = useRef<SelectedLines | null>(null);
  const refResponseReceivedRef = useRef(false);
  const refSendingRef = useRef(false);

  useEffect(() => { refMessagesRef.current = refMessages; }, [refMessages]);
  useEffect(() => { refDraftRef.current = refDraft; }, [refDraft]);
  useEffect(() => { refSendingRef.current = refSending; }, [refSending]);

  // -- Refs --
  const sseManagerRef = useRef<SSEManager | null>(null);
  const editingCommentRef = useRef<EditingComment | null>(null);

  // Keep ref in sync with state for SSE callback
  useEffect(() => {
    editingCommentRef.current = editingComment;
  }, [editingComment]);

  // Persist comments to localStorage
  useEffect(() => {
    localStorage.setItem(COMMENT_STORAGE_KEY, JSON.stringify(lineComments));
  }, [lineComments]);

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------

  /**
   * Fetch the full state from the server and update all state.
   * Preserves selected file and skips render while typing a comment.
   */
  const refresh = useCallback(async () => {
    try {
      const state: AggregatedState = await fetchState();
      setFileDiffs(state.fileDiffs || []);
      setHistory(state.history || []);
      setExternalChanges(state.externalChanges || []);
      setFetchError(null);

      // Auto-select first pending file on initial load
      if (!selectedPath && !selectedCycleId) {
        const firstPending = (state.fileDiffs || []).find(
          (f) => f.status === "pending",
        ) || (state.fileDiffs || [])[0];
        if (firstPending) {
          setSelectedPath(firstPending.filePath);
        }
      }
    } catch (e) {
      setFetchError(
        "Cannot reach server. Run /review in pi to start it.",
      );
      console.error("Fetch failed", e);
    }
  }, [selectedPath, selectedCycleId]);

  // SSE update handler
  const handleSSEUpdate = useCallback((data: AggregatedState) => {
    if (editingCommentRef.current) return;
    setFileDiffs(data.fileDiffs || []);
    setHistory(data.history || []);
    setExternalChanges(data.externalChanges || []);
    setFetchError(null);
  }, []);

  // Comment response handler — marks sent comments as done when response arrives
  const handleReferenceResponse = useCallback((responses: Array<{ text: string; timestamp: number }>) => {
    if (responses.length > 0 && !refResponseReceivedRef.current) {
      refResponseReceivedRef.current = true;
      const responseText = responses[0].text;
      setRefResponse(responseText);
      setRefMessages((prev) => [...prev, { role: "agent", text: responseText, timestamp: Date.now() }]);
      setRefSending(false);
    }
  }, []);

  const handleCommentResponse = useCallback((responses: Array<{ text: string; timestamp: number }>) => {
    setLineComments((prev) => {
      let ri = 0;
      const updated = { ...prev };
      for (const filePath of Object.keys(updated)) {
        for (const rowKey of Object.keys(updated[filePath])) {
          const entry = updated[filePath][rowKey];
          if (entry.sent && !entry.done && ri < responses.length) {
            const responseText = responses[ri++].text;
            updated[filePath] = { ...updated[filePath] };
            updated[filePath][rowKey] = { ...entry, response: responseText, sent: false, done: true };
          }
        }
      }
      return updated;
    });
  }, []);

  // When fileDiffs change and full-file view is open, re-fetch content
  // so the merge always uses fresh data (avoids stale cache after deletions).
  useEffect(() => {
    for (const filePath of Object.keys(fullFileView)) {
      if (fullFileView[filePath]) {
        apiGetFileContent(filePath).then((content) => {
          setFileContents((fc) => ({ ...fc, [filePath]: content }));
        }).catch(() => {});
      }
    }
  }, [fileDiffs, fullFileView]);

  // When the selected path changes, fetch file content if not already cached.
  // Also fetch for external-only files (not in fileDiffs but in externalChanges).
  useEffect(() => {
    if (!selectedPath) return;
    const hasAgentChanges = fileDiffs.some(f => f.filePath === selectedPath);
    const hasExternalChanges = externalChanges.some(ec => ec.filePath === selectedPath);
    // Always fetch if we have external changes for this file (may be external-only)
    if (!hasAgentChanges && !hasExternalChanges) return;
    apiGetFileContent(selectedPath).then((content) => {
      setFileContents((fc) => ({ ...fc, [selectedPath]: content }));
    }).catch(() => {});
  }, [selectedPath, fileDiffs, externalChanges]);

  // -----------------------------------------------------------------------
  // SSE connection lifecycle
  // -----------------------------------------------------------------------

  useEffect(() => {
    const sse = new SSEManager();
    sseManagerRef.current = sse;

    sse.setUpdateHandler(handleSSEUpdate);
    sse.setCommentResponseHandler(handleCommentResponse);
    sse.setReferenceResponseHandler(handleReferenceResponse);
    sse.setStatusHandler(setSseStatus);
    sse.connect();

    // Initial fetch + periodic refresh
    refresh();
    const interval = setInterval(refresh, 10000);

    return () => {
      sse.disconnect();
      clearInterval(interval);
    };
  }, [handleSSEUpdate, refresh]);

  // -----------------------------------------------------------------------
  // Keyboard shortcuts for comment input
  // -----------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!editingComment) return;
      if (e.key === "Enter") {
        e.preventDefault();
        handleSaveComment(editingComment.filePath, editingComment.lineNum);
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancelComment();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [editingComment, editingCommentDraft]);

  // -----------------------------------------------------------------------
  // API action handlers
  // -----------------------------------------------------------------------

  /** Accept all pending changes. */
  const handleAcceptAll = useCallback(async () => {
    await apiAcceptAll();
    await refresh();
  }, [refresh]);

  /** Revert all pending changes. */
  const handleRevertAll = useCallback(async () => {
    await apiRevertAll();
    await refresh();
  }, [refresh]);

  /** Accept a single file. */
  const handleAcceptFile = useCallback(async (filePath: string) => {
    await apiAcceptFile(filePath);
    await refresh();
  }, [refresh]);

  /** Revert a single file. */
  const handleRevertFile = useCallback(async (filePath: string) => {
    await apiRevertFile(filePath);
    await refresh();
  }, [refresh]);

  /** Toggle the full file view for a file. Always fetches fresh content
   *  when enabling, since the file may have changed after accepts. */
  const handleToggleFullFile = useCallback(async (filePath: string) => {
    const enabling = !fullFileView[filePath];
    setFullFileView((prev) => {
      return { ...prev, [filePath]: enabling };
    });

    if (enabling) {
      // Always fetch fresh content when enabling full-file view
      try {
        const content = await apiGetFileContent(filePath);
        setFileContents((fc) => ({ ...fc, [filePath]: content }));
      } catch (e) {
        console.error("Failed to fetch file content", e);
      }
    }
  }, [fullFileView, fileContents]);

  // -----------------------------------------------------------------------
  // Selection handlers
  // -----------------------------------------------------------------------

  /** Select a file from the sidebar. */
  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedPath(filePath);
    setSelectedCycleId(null);
  }, []);

  /** Select a history cycle from the sidebar. */
  const handleSelectCycle = useCallback((cycleId: string, filePath: string) => {
    setSelectedPath(filePath);
    setSelectedCycleId(cycleId);
  }, []);

  /** Toggle collapse state for a file's history. */
  const handleToggleCollapse = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      // Default (undefined) = collapsed. Toggle: collapsed→expanded→collapsed.
      const current = prev[filePath] === false ? false : true;
      const next = !current;
      return { ...prev, [filePath]: next };
    });
  }, []);

  // -----------------------------------------------------------------------
  // Comment handlers
  // -----------------------------------------------------------------------

  /** Start editing a comment on a line. Pre-fills draft with existing text if present. */
  const handleStartEditComment = useCallback((filePath: string, lineNum: number, rowKey: string) => {
    setEditingComment({ filePath, lineNum, rowKey });
    // Pre-fill draft with existing comment text for editing
    const existing = lineComments[filePath]?.[rowKey]?.text;
    setEditingCommentDraft(existing ?? "");
    setLineComments((prev) => {
      const updated = { ...prev };
      if (!updated[filePath]) updated[filePath] = {};
      if (!updated[filePath][rowKey]) {
        updated[filePath][rowKey] = { text: "" };
      }
      return updated;
    });
  }, [lineComments]);

  /** Save the current comment. */
  const handleSaveComment = useCallback((filePath: string, lineNum: number) => {
    const value = editingCommentDraft.trim();
    if (value && editingComment) {
      const rk = editingComment.rowKey;
      setLineComments((prev) => {
        const updated = { ...prev };
        if (!updated[filePath]) updated[filePath] = {};
        updated[filePath][rk] = { text: value, rowKey: rk };
        return updated;
      });
    }
    setEditingComment(null);
    setEditingCommentDraft("");
  }, [editingCommentDraft, editingComment]);

  /** Cancel editing a comment. */
  const handleCancelComment = useCallback(() => {
    if (editingComment) {
      const { filePath, rowKey } = editingComment;
      setLineComments((prev) => {
        const updated = { ...prev };
        if (updated[filePath] && updated[filePath][rowKey]) {
          if (!updated[filePath][rowKey].text.trim()) {
            delete updated[filePath][rowKey];
            if (Object.keys(updated[filePath]).length === 0) {
              delete updated[filePath];
            }
          }
        }
        return updated;
      });
    }
    setEditingComment(null);
    setEditingCommentDraft("");
  }, [editingComment]);

  /** Remove a saved comment. */
  const handleRemoveComment = useCallback((filePath: string, lineNum: number) => {
    // Remove by looking up the rowKey from editingComment if active, otherwise iterate
    setLineComments((prev) => {
      const updated = { ...prev };
      if (updated[filePath]) {
        // Try to find the comment by rowKey if editing, otherwise find by lineNum
        if (editingComment && editingComment.filePath === filePath && editingComment.lineNum === lineNum) {
          delete updated[filePath][editingComment.rowKey];
        } else {
          // Fallback: find any entry with matching lineNum
          for (const key of Object.keys(updated[filePath])) {
            if (key.startsWith(`${lineNum}-`)) {
              delete updated[filePath][key];
              break;
            }
          }
        }
        if (Object.keys(updated[filePath]).length === 0) {
          delete updated[filePath];
        }
      }
      return updated;
    });
  }, [editingComment]);

  /** Send all comments to the agent. Enriches each comment with line content and change type.
   * Falls back to reading the current file content when the diff doesn't cover a line
   * (e.g. in full-file view on accepted/reverted files). */
  const handleSendComments = useCallback(async () => {
    const comments: Array<{
      filePath: string;
      relativePath: string;
      lineNum: number;
      text: string;
      lineContent: string;
      changeType: "add" | "del" | "ctx";
    }> = [];

    for (const filePath of Object.keys(lineComments)) {
      const fileDiff = fileDiffs.find((f) => f.filePath === filePath);
      const lineMap = fileDiff ? buildDiffLineMap(fileDiff.diff) : {};

      for (const rowKey of Object.keys(lineComments[filePath])) {
        const comment = lineComments[filePath][rowKey];
        if (!comment.text.trim() || comment.done) continue;
        // Extract lineNum from rowKey (format: "N-type")
        const num = parseInt(rowKey.split("-")[0], 10) || 0;
        // Use current file content as the primary source — always accurate.
        // Fall back to diff lookup for deleted lines (not in current file).
        let lineContent = "";
        let changeType: "add" | "del" | "ctx" = "ctx";

        // Try current file content first
        if (fileContents[filePath]) {
          const lines = fileContents[filePath].split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
          const idx = num - 1;
          if (idx >= 0 && idx < lines.length) {
            lineContent = lines[idx];
          }
        }

        // If file content didn't have this line (deleted), use diff
        if (!lineContent) {
          const lineInfo = comment.rowKey
            ? lookupDiffLine(lineMap, comment.rowKey, num)
            : lineMap[String(num)];
          lineContent = lineInfo?.content ?? "";
          changeType = lineInfo?.type ?? "ctx";
        } else {
          // Try to get changeType from diff for highlighting
          const lineInfo = comment.rowKey
            ? lookupDiffLine(lineMap, comment.rowKey, num)
            : undefined;
          changeType = lineInfo?.type ?? "ctx";
        }

        comments.push({
          filePath,
          relativePath: relativePathFromAbs(filePath, fileDiffs),
          lineNum: num,
          text: comment.text.trim(),
          lineContent,
          changeType,
        });
      }
    }

    if (comments.length === 0) return;

    try {
      const result = await apiSendComments(comments);
      // Mark comments as sent instead of clearing them
      setLineComments((prev) => {
        const updated = { ...prev };
        for (const filePath of Object.keys(updated)) {
          for (const rowKey of Object.keys(updated[filePath])) {
            if (updated[filePath][rowKey].text.trim()) {
              updated[filePath][rowKey] = { ...updated[filePath][rowKey], sent: true };
            }
          }
        }
        return updated;
      });
      setEditingComment(null);
      setEditingCommentDraft("");

      // Poll for agent response every 500ms for up to 30s
      let attempts = 0;
      const maxAttempts = 60;
      const poll = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
          clearInterval(poll);
          return;
        }
        try {
          const res = await fetch("/api/comments/response");
          const data = await res.json();
          if (data.responses && data.responses.length > 0) {
            handleCommentResponse(data.responses);
            clearInterval(poll);
          }
        } catch {}
      }, 500);
    } catch (e) {
      console.error("Failed to send comments", e);
    }
  }, [lineComments, fileDiffs, fileContents]);

  /** Clear all comments. */
  const handleClearAllComments = useCallback(() => {
    setLineComments({});
    setEditingComment(null);
    setEditingCommentDraft("");
  }, []);

  /** Clear all non-pending files from the tracker. */
  const handleClearNonPending = useCallback(async () => {
    await apiClearNonPending();
    await refresh();
  }, [refresh]);

  /** Clear non-pending changes for a specific file. */
  const handleClearFile = useCallback(async (filePath: string) => {
    await apiClearFile(filePath);
    await refresh();
  }, [refresh]);

  // -----------------------------------------------------------------------
  // Reference panel handlers
  // -----------------------------------------------------------------------

  /** Called when user clicks "Reference this code" from context menu. */
  const handleReference = useCallback((lines: SelectedLineInfo[], filePath: string) => {
    if (lines.length === 0) return;
    const relPath = relativePathFromAbs(filePath, fileDiffs);
    const sorted = [...lines].sort((a, b) => a.lineNum - b.lineNum);
    const startLine = sorted[0].lineNum;
    const endLine = sorted[sorted.length - 1].lineNum;
    const code = sorted.map(l => l.content).join("\n");
    const lineEntries = sorted.map(l => ({
      content: l.content,
      type: (l.type === "add" ? "add" : l.type === "del" ? "del" : "ctx") as "add" | "del" | "ctx",
    }));
    const sel: SelectedLines = { filePath, relativePath: relPath, startLine, endLine, code, lines: lineEntries };
    lastSelectionRef.current = sel;
    refResponseReceivedRef.current = false;
    setRefSelection(sel);
    setRefMessages([]);
    setRefDraft("");
    setRefResponse(null);
    setRefSending(false);
    setConversationOpen(true);
    setTimeout(() => {
      document.querySelector(".reference-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }, [fileDiffs]);

  /** Send reference question and poll for response. */
  const sendRefAndPoll = useCallback(async (mode: "ask" | "edit", existingMessages: ConversationMessage[]) => {
    const draft = refDraftRef.current.trim();
    if (!refSelection || !draft) return;
    const question = draft;
    refResponseReceivedRef.current = false;
    const userMsg: ConversationMessage = { role: "user", text: question, timestamp: Date.now() };
    const updatedMessages = [...existingMessages, userMsg];
    setRefMessages(updatedMessages);
    setRefDraft("");
    setRefSending(true);
    setRefResponse(null);

    // Send with conversation history for follow-ups
    if (updatedMessages.length > 1) {
      await apiSendFollowup({
        ...refSelection,
        messages: updatedMessages.slice(0, -1),
        question,
        mode,
      });
    } else {
      await apiSendReference({ ...refSelection, question, mode });
    }

    // Poll for agent response
    let attempts = 0;
    const maxAttempts = 60;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const responses = await apiPollReferenceResponse();
        if (responses.length > 0) {
          const responseText = responses[0].text;
          setRefResponse(responseText);
          setRefMessages((prev) => [...prev, { role: "agent", text: responseText, timestamp: Date.now() }]);
          setRefSending(false);
          clearInterval(poll);
        } else if (attempts >= maxAttempts) {
          setRefSending(false);
          clearInterval(poll);
        }
      } catch {
        if (attempts >= maxAttempts) {
          setRefSending(false);
          clearInterval(poll);
        }
      }
    }, 500);
  }, [refSelection]);

  /** Send reference question in "ask" mode (read-only). */
  const handleRefAsk = useCallback(() => {
    sendRefAndPoll("ask", []);
  }, [sendRefAndPoll]);

  /** Send reference question in "edit" mode. */
  const handleRefEdit = useCallback(() => {
    sendRefAndPoll("edit", []);
  }, [sendRefAndPoll]);

  /** Send follow-up in ask mode. */
  const handleRefAskFollowup = useCallback(() => {
    if (!refDraftRef.current.trim()) return;
    sendRefAndPoll("ask", refMessagesRef.current);
  }, [sendRefAndPoll]);

  /** Send follow-up in edit mode. */
  const handleRefEditFollowup = useCallback(() => {
    if (!refDraftRef.current.trim()) return;
    sendRefAndPoll("edit", refMessagesRef.current);
  }, [sendRefAndPoll]);

  /** Toggle the conversation panel open/closed. */
  const handleToggleConversation = useCallback(() => {
    setConversationOpen((prev) => {
      const next = !prev;
      if (!next) return next;

      if (lastSelectionRef.current) {
        setRefSelection(lastSelectionRef.current);
      } else if (selectedPath) {
        const diff = fileDiffs.find(f => f.filePath === selectedPath);
        if (diff) {
          // Reference the file without sending full content
          const sel: SelectedLines = {
            filePath: selectedPath,
            relativePath: diff.relativePath,
            startLine: 0,
            endLine: 0,
            code: "",
          };
          lastSelectionRef.current = sel;
          setRefSelection(sel);
        }
      }
      return next;
    });
  }, [selectedPath, fileContents, fileDiffs]);

  /** Close the reference panel (from the ✕ button inside the panel). */
  const handleRefClose = useCallback(() => {
    setConversationOpen(false);
  }, []);

  // -----------------------------------------------------------------------
  // Chat handlers
  // -----------------------------------------------------------------------

  const handleToggleChat = useCallback(() => setChatOpen(prev => !prev), []);
  const handleCloseChat = useCallback(() => setChatOpen(false), []);
  const handleClearChat = useCallback(() => setChatMessages([]), []);

  const handleSendChat = useCallback(async () => {
    const msg = chatDraft.trim();
    if (!msg || chatSending) return;
    const userMsg: ChatMessage = { role: "user", text: msg, timestamp: Date.now() };
    setChatMessages(prev => [...prev, userMsg]);
    setChatDraft("");
    setChatSending(true);

    await apiSendChat(msg);

    let attempts = 0;
    const maxAttempts = 60;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const responses = await apiPollChatResponse();
        if (responses.length > 0) {
          for (const r of responses) {
            setChatMessages(prev => [...prev, { role: "agent", text: r.text, timestamp: r.timestamp }]);
          }
          setChatSending(false);
          clearInterval(poll);
        } else if (attempts >= maxAttempts) {
          setChatSending(false);
          clearInterval(poll);
        }
      } catch {
        if (attempts >= maxAttempts) { setChatSending(false); clearInterval(poll); }
      }
    }, 500);
  }, [chatDraft, chatSending]);

  // -----------------------------------------------------------------------
  // Derived state
  // -----------------------------------------------------------------------

  const pending = fileDiffs.filter((c) => c.status === "pending").length;
  const commentCount = countTotalComments(lineComments);

  // Find the selected file diff
  const selectedFile = fileDiffs.find((f) => f.filePath === selectedPath) || null;

  // Find the selected history cycle
  const selectedCycle = selectedCycleId
    ? history.find((h) => h.id === selectedCycleId) || null
    : null;

  // Check if we should show the main empty state
  const hasNoData = fileDiffs.length === 0 && history.length === 0 && externalChanges.length === 0 && !fetchError;

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <>
      <Header
        pending={pending}
        commentCount={commentCount}
        onAcceptAll={handleAcceptAll}
        onRevertAll={handleRevertAll}
        onSendComments={handleSendComments}
        onClearComments={handleClearAllComments}
        onOpenChat={handleToggleChat}
        onRefresh={refresh}
      />

      <div
        class="layout"
        style={sidebarWidth ? { "--sidebar-width-custom": sidebarWidth + "px" } as Record<string, string> : undefined}
      >
        <Sidebar
          fileDiffs={fileDiffs}
          history={history}
          externalChanges={externalChanges}
          selectedPath={selectedPath}
          selectedCycle={selectedCycleId}
          collapsedFiles={collapsedFiles}
          fetchError={fetchError}
          hasNonPending={fileDiffs.some(f => f.status !== "pending")}
          conversationOpen={conversationOpen}
          onToggleConversation={handleToggleConversation}
          refMessagesCount={refMessages.length}
          onSelectFile={handleSelectFile}
          onSelectCycle={handleSelectCycle}
          onAcceptFile={handleAcceptFile}
          onRevertFile={handleRevertFile}
          onToggleCollapse={handleToggleCollapse}
          onClearFile={handleClearFile}
          onClearHistory={handleClearNonPending}
          onAcknowledgeExternal={(fp) => apiAcknowledgeExternal(fp)}
          onAcknowledgeAllExternal={() => apiAcknowledgeAllExternal()}
        />

        {/* Resize handle between sidebar and main */}
        <div
          class="resize-handle"
          onMouseDown={(e: MouseEvent) => {
            e.preventDefault();
            const sidebar = (e.target as HTMLElement).parentElement?.querySelector(".sidebar") as HTMLElement;
            if (!sidebar) return;
            const currentWidth = sidebar.offsetWidth;
            dragRef.current = { startX: e.clientX, startWidth: currentWidth };
            (e.target as HTMLElement).classList.add("active");

            const onMouseMove = (ev: MouseEvent) => {
              if (!dragRef.current) return;
              const delta = ev.clientX - dragRef.current.startX;
              // Dragging right → sidebar wider; dragging left → sidebar narrower (main wider)
              const newWidth = Math.max(260, dragRef.current.startWidth + delta);
              setSidebarWidth(newWidth);
            };

            const onMouseUp = () => {
              dragRef.current = null;
              document.removeEventListener("mousemove", onMouseMove);
              document.removeEventListener("mouseup", onMouseUp);
              document.querySelector(".resize-handle")?.classList.remove("active");
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
        />

        <div class="main" id="main-area">
          {hasNoData ? (
            <div class="main-empty">
              <div>
                <h2>No tracked changes</h2>
                <p>Changes made by the agent will appear here</p>
              </div>
            </div>
          ) : (
            <FileViewer
              selectedFile={selectedFile}
              selectedCycle={selectedCycle}
              selectedPath={selectedPath}
              showFullFile={fullFileView[selectedPath || ""] === true}
              fileContent={selectedPath ? fileContents[selectedPath] || null : null}
              lineComments={lineComments}
              editingComment={editingComment}
              editingCommentDraft={editingCommentDraft}
              externalChanges={externalChanges}
              onAccept={() => selectedPath && handleAcceptFile(selectedPath)}
              onRevert={() => selectedPath && handleRevertFile(selectedPath)}
              onToggleFull={() => selectedPath && handleToggleFullFile(selectedPath)}
              onStartEditComment={handleStartEditComment}
              onSaveComment={handleSaveComment}
              onCancelComment={handleCancelComment}
              onRemoveComment={handleRemoveComment}
              onDraftChange={setEditingCommentDraft}
              onReference={handleReference}
            />
          )}
          {conversationOpen && refSelection && (
            <ReferencePanel
              selection={refSelection}
              messages={refMessages}
              draft={refDraft}
              response={refResponse}
              sending={refSending}
              hasStarted={refMessages.length > 0}
              onDraftChange={setRefDraft}
              onAsk={handleRefAsk}
              onEdit={handleRefEdit}
              onAskFollowup={handleRefAskFollowup}
              onEditFollowup={handleRefEditFollowup}
              onClose={handleRefClose}
            />
          )}
        </div>
      </div>

      {/* SSE status indicator */}
      <div
        class={`sse-status ${sseStatus === "connected" ? "sse-connected" : "sse-disconnected"}`}
        id="sse-status"
      >
        <span class="sse-dot"></span>
        <span id="sse-text">
          {sseStatus === "connected"
            ? "Live"
            : sseStatus === "reconnecting"
              ? "Reconnecting..."
              : "Disconnected"}
        </span>
      </div>

      <ChatPanel
        open={chatOpen}
        messages={chatMessages}
        draft={chatDraft}
        sending={chatSending}
        onDraftChange={setChatDraft}
        onSend={handleSendChat}
        onClose={handleCloseChat}
        onClear={handleClearChat}
      />
    </>
  );
}
