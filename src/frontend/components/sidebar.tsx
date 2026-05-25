/**
 * Sidebar component for the Change Tracker.
 *
 * Displays the list of files with pending/accepted/reverted changes,
 * plus nested history entries for each file. Supports collapse/expand
 * of history trees and inline accept/revert actions.
 */

import { JSX } from "preact";
import { useState, useEffect } from "preact/hooks";
import type { FileDiff, ChangeCycle, ExternalFileChange } from "../../types.js";
import {
  dotClassForStatus,
  formatChangeCount,
  formatTime,
} from "../utils.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SidebarProps {
  /** All file diffs (current status). */
  fileDiffs: FileDiff[];
  /** History of accept/revert cycles. */
  history: ChangeCycle[];
  /** External file changes detected by watcher. */
  externalChanges: ExternalFileChange[];
  /** Currently selected file path (for current pending view). */
  selectedPath: string | null;
  /** Currently selected history cycle ID (or null for current view). */
  selectedCycle: string | null;
  /** Map of collapsed files (true = collapsed). */
  collapsedFiles: Record<string, boolean>;
  /** Error message to display, or null. */
  fetchError: string | null;
  /** Called when a file is selected. */
  onSelectFile: (filePath: string) => void;
  /** Called when a history cycle is selected. */
  onSelectCycle: (cycleId: string, filePath: string) => void;
  /** Called to accept a file. */
  onAcceptFile: (filePath: string) => void;
  /** Called to revert a file. */
  onRevertFile: (filePath: string) => void;
  /** Called to toggle collapse state of a file's history. */
  onToggleCollapse: (filePath: string) => void;
  /** Called to clear non-pending changes for a file. */
  onClearFile: (filePath: string) => void;
  /** Whether there are non-pending files to clear. */
  hasNonPending: boolean;
  /** Called to clear all non-pending changes. */
  onClearHistory: () => void;
  /** Whether the conversation panel is open. */
  conversationOpen: boolean;
  /** Called to toggle the conversation panel. */
  onToggleConversation: () => void;
  /** Number of messages in the conversation (for badge). */
  refMessagesCount: number;
  /** Called to acknowledge external changes for a file. */
  onAcknowledgeExternal?: (filePath: string) => void;
  /** Called to acknowledge (clear) all external changes. */
  onAcknowledgeAllExternal?: () => void;
}

// ---------------------------------------------------------------------------
// SidebarItem sub-component
// ---------------------------------------------------------------------------

interface SidebarItemProps {
  /** The file diff entry. */
  fileDiff: FileDiff;
  /** Whether this file is currently selected. */
  isSelected: boolean;
  /** Whether history entries are collapsed for this file. */
  isCollapsed: boolean;
  /** History cycles nested under this file. */
  historyCycles: ChangeCycle[];
  /** Selected cycle ID. */
  selectedCycle: string | null;
  /** Select this file. */
  onSelect: () => void;
  /** Accept this file. */
  onAccept: () => void;
  /** Revert this file. */
  onRevert: () => void;
  /** Toggle collapse. */
  onToggleCollapse: () => void;
  /** Clear non-pending changes for this file. */
  onClear: () => void;
  /** Select a history cycle. */
  onSelectCycle: (cycleId: string, filePath: string) => void;
}

/**
 * Renders a single sidebar file item with optional nested history entries.
 */
function SidebarItem(props: SidebarItemProps): JSX.Element {
  const {
    fileDiff,
    isSelected,
    isCollapsed,
    historyCycles,
    selectedCycle,
    onSelect,
    onAccept,
    onRevert,
    onToggleCollapse,
    onClear,
    onSelectCycle,
  } = props;

  const f = fileDiff;
  const dotClass = dotClassForStatus(f.status);
  const tools = f.tools.join(", ");
  const isPending = f.status === "pending";
  const hasHistory = historyCycles.length > 0;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <>
      <div
        class={`sidebar-item status-${f.status}${isSelected ? " selected" : ""}`}
        data-select={f.filePath}
        onClick={onSelect}
      >
        <span class={`status-dot ${dotClass}`}></span>
        <div class="sidebar-item-info">
          <div class="sidebar-file-row">
            <span
              class="sidebar-file-path"
              title={f.relativePath}
            >
              {f.relativePath}
            </span>
            {f.hasExternalChanges && (
              <span class="sidebar-external-badge" title="This file was modified externally (user/TUI) before the agent's changes">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              </span>
            )}
            <button
              class="sidebar-copy-path"
              title="Copy file path"
              onClick={(e: Event) => {
                e.stopPropagation();
                navigator.clipboard.writeText(f.relativePath).then(() => setCopied(true)).catch(() => {});
              }}
            >
              {copied ? (
                <svg viewBox="0 0 24 24" width="13" height="13">
                  <polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="13" height="13">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" stroke-width="2" />
                </svg>
              )}
            </button>
          </div>
          <div class="sidebar-meta">
            <span class="sidebar-tool-badge">{tools}</span>
            <span class="sidebar-count">{formatChangeCount(f.changeCount)}</span>
          </div>
        </div>
        <div class="sidebar-right">
          {hasHistory && (
            <button
              class={`collapse-toggle${isCollapsed ? "" : " expanded"}`}
              data-action="toggle-collapse"
              data-path={f.filePath}
              title={isCollapsed ? "Show change history" : "Hide change history"}
              onClick={(e: Event) => {
                e.stopPropagation();
                onToggleCollapse();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
          {isPending && (
            <div class="sidebar-actions">
              <button
                class="btn-sm btn-sm-accept"
                data-action="accept-file"
                data-path={f.filePath}
                onClick={(e: Event) => {
                  e.stopPropagation();
                  onAccept();
                }}
              >
                <svg class="btn-icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>
              </button>
              <button
                class="btn-sm btn-sm-revert"
                data-action="revert-file"
                data-path={f.filePath}
                onClick={(e: Event) => {
                  e.stopPropagation();
                  onRevert();
                }}
              >
                <svg class="btn-icon" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
              </button>
            </div>
          )}
          {!isPending && hasHistory && (
            <button
              class="btn-sm btn-clear-file"
              data-action="clear-file"
              data-path={f.filePath}
              title="Clear resolved changes"
              onClick={(e: Event) => {
                e.stopPropagation();
                onClear();
              }}
            >
              <svg class="btn-icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          )}
        </div>
      </div>
      {historyCycles.map((c) => (
        <div
          key={c.id}
          class={`sidebar-item status-${c.action} sidebar-history${isCollapsed ? " collapsed" : ""}`}
          data-select-cycle={c.id}
          data-cycle-path={c.filePath}
          onClick={(e: Event) => {
            e.stopPropagation();
            onSelectCycle(c.id, c.filePath);
          }}
        >
          <span class={`status-dot ${dotClassForStatus(c.action)}`}></span>
          <div class="sidebar-item-info">
            <span
              class="sidebar-file-path"
              title={c.relativePath}
            >
              {c.relativePath}
            </span>
            <div class="sidebar-meta">
              <span class="sidebar-tool-badge">{c.action}</span>
              <span class="sidebar-count">
                {c.changeCount} - {formatTime(c.timestamp)}
              </span>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// HistoryOnlyItem for files with no current pending entry
// ---------------------------------------------------------------------------

interface HistoryOnlyItemProps {
  filePath: string;
  relativePath: string;
  historyCycles: ChangeCycle[];
  isCollapsed: boolean;
  selectedCycle: string | null;
  onSelectCycle: (cycleId: string, filePath: string) => void;
  onToggleCollapse: () => void;
  onClear: () => void;
}

/**
 * Renders a sidebar entry for a file that has only history (no current pending/accepted/reverted diff).
 */
function HistoryOnlyItem(props: HistoryOnlyItemProps): JSX.Element {
  const {
    filePath,
    relativePath,
    historyCycles,
    isCollapsed,
    selectedCycle,
    onSelectCycle,
    onToggleCollapse,
    onClear,
  } = props;

  return (
    <>
      <div
        class="sidebar-item status-accepted"
        data-select={filePath}
        onClick={() => {}}
      >
        <span class="status-dot dot-accepted"></span>
        <div class="sidebar-item-info">
          <span
            class="sidebar-file-path"
            title={relativePath}
          >
            {relativePath}
          </span>
          <div class="sidebar-meta">
            <span class="sidebar-count">no pending changes</span>
          </div>
        </div>
        <div class="sidebar-right">
          <button
            class={`collapse-toggle${isCollapsed ? "" : " expanded"}`}
            title={isCollapsed ? "Show change history" : "Hide change history"}
            onClick={(e: Event) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <button
            class="btn-sm btn-clear-file"
            title="Clear resolved changes"
            onClick={(e: Event) => {
              e.stopPropagation();
              onClear();
            }}
          >
            <svg class="btn-icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>
      {historyCycles.map((c) => (
        <div
          key={c.id}
          class={`sidebar-item status-${c.action} sidebar-history${isCollapsed ? " collapsed" : ""}`}
          data-select-cycle={c.id}
          data-cycle-path={c.filePath}
          onClick={(e: Event) => {
            e.stopPropagation();
            onSelectCycle(c.id, c.filePath);
          }}
        >
          <span class={`status-dot ${dotClassForStatus(c.action)}`}></span>
          <div class="sidebar-item-info">
            <span class="sidebar-file-path" title={c.relativePath}>
              {c.relativePath}
            </span>
            <div class="sidebar-meta">
              <span class="sidebar-tool-badge">{c.action}</span>
              <span class="sidebar-count">
                {c.changeCount} - {formatTime(c.timestamp)}
              </span>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Sidebar Component
// ---------------------------------------------------------------------------

/**
 * Renders the file list sidebar with current diffs and nested history.
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const {
    fileDiffs,
    history,
    externalChanges,
    selectedPath,
    selectedCycle,
    collapsedFiles,
    fetchError,
    onSelectFile,
    onSelectCycle,
    onAcceptFile,
    onRevertFile,
    onToggleCollapse,
    onClearFile,
    hasNonPending,
    onClearHistory,
    conversationOpen,
    onToggleConversation,
    refMessagesCount,
    onAcknowledgeExternal,
    onAcknowledgeAllExternal,
  } = props;

  // Build history lookup: filePath -> sorted cycles
  const historyByFile = new Map<string, ChangeCycle[]>();
  for (const h of history) {
    const group = historyByFile.get(h.filePath) ?? [];
    group.push(h);
    historyByFile.set(h.filePath, group);
  }
  for (const filePath of historyByFile.keys()) {
    historyByFile.get(filePath)!.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Files that have a current entry
  const filesWithCurrentEntries = new Set(fileDiffs.map((f) => f.filePath));

  return (
    <div class="sidebar">
      <div class="sidebar-header">
        <span>Files</span>
        {hasNonPending && (
          <button
            class="sidebar-header-trash"
            title="Clear resolved changes"
            onClick={(e: Event) => {
              e.stopPropagation();
              onClearHistory();
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        )}
      </div>
      <div class="sidebar-list" id="sidebar-list">
        {fetchError ? (
          <div class="main-empty">
            <p style="color:var(--diff-del)">{fetchError}</p>
          </div>
        ) : fileDiffs.length === 0 && history.length === 0 && externalChanges.length === 0 ? (
          <div class="main-empty">
            <p>No tracked changes</p>
          </div>
        ) : (
          <>
            {/* Current file entries with nested history */}
            {fileDiffs.map((f) => (
              <SidebarItem
                key={f.filePath}
                fileDiff={f}
                isSelected={f.filePath === selectedPath && selectedCycle === null}
                isCollapsed={collapsedFiles[f.filePath] !== false}
                historyCycles={historyByFile.get(f.filePath) ?? []}
                selectedCycle={selectedCycle}
                onSelect={() => onSelectFile(f.filePath)}
                onAccept={() => onAcceptFile(f.filePath)}
                onRevert={() => onRevertFile(f.filePath)}
                onToggleCollapse={() => onToggleCollapse(f.filePath)}
                onClear={() => onClearFile(f.filePath)}
                onSelectCycle={onSelectCycle}
              />
            ))}
            {/* External changes section — deduplicated by filePath */}
            {externalChanges.length > 0 && (() => {
              // Group external changes by filePath, merge timestamps and line counts
              const grouped = new Map<string, { entries: ExternalFileChange[]; latestTimestamp: number; mergedLines: Set<number> }>();
              for (const ec of externalChanges) {
                const g = grouped.get(ec.filePath);
                if (g) {
                  g.entries.push(ec);
                  if (ec.timestamp > g.latestTimestamp) g.latestTimestamp = ec.timestamp;
                  for (const ln of ec.changedLines) g.mergedLines.add(ln);
                } else {
                  grouped.set(ec.filePath, {
                    entries: [ec],
                    latestTimestamp: ec.timestamp,
                    mergedLines: new Set(ec.changedLines),
                  });
                }
              }
              const groupedList = [...grouped.entries()]
                .sort(([, a], [, b]) => b.latestTimestamp - a.latestTimestamp);
              return (
                <>
                  <div class="sidebar-section-label">
                    <span>External Changes</span>
                    <button
                      class="sidebar-header-trash"
                      title="Clear all external changes"
                      onClick={(e: Event) => {
                        e.stopPropagation();
                        onAcknowledgeAllExternal?.();
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                  {groupedList.map(([filePath, { entries, latestTimestamp, mergedLines }]) => {
                    const ec = entries[0]; // first entry for display metadata
                    const totalLines = mergedLines.size;
                    const countLabel = entries.length > 1
                      ? `${entries.length} edits · ${totalLines} line${totalLines !== 1 ? "s" : ""}`
                      : `${totalLines} line${totalLines !== 1 ? "s" : ""}`;
                    return (
                      <div key={filePath} class={`sidebar-item sidebar-external${filePath === selectedPath ? " selected" : ""}`} onClick={() => onSelectFile(filePath)}>
                        <span class="status-dot dot-external"></span>
                        <div class="sidebar-item-info">
                          <div class="sidebar-file-row">
                            <span class="sidebar-file-path" title={ec.relativePath}>
                              {ec.relativePath}
                            </span>
                          </div>
                          <div class="sidebar-meta">
                            <span class="sidebar-tool-badge">external</span>
                            <span class="sidebar-count">{countLabel} · {formatTime(latestTimestamp)}</span>
                          </div>
                        </div>
                        <div class="sidebar-right">
                          <button
                            class="btn-sm btn-sm-ack"
                            title="Acknowledge external changes"
                            onClick={(e: Event) => {
                              e.stopPropagation();
                              onAcknowledgeExternal?.(filePath);
                            }}
                          >
                            ✓
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              );
            })()}

            {/* History-only files (no current pending entry) */}
            {[...historyByFile.keys()]
              .filter((fp) => !filesWithCurrentEntries.has(fp))
              .sort()
              .map((filePath) => {
                const cycles = historyByFile.get(filePath) ?? [];
                const relPath = cycles[0]?.relativePath ?? filePath;
                return (
                <HistoryOnlyItem
                  key={filePath}
                  filePath={filePath}
                  relativePath={relPath}
                  historyCycles={cycles}
                  isCollapsed={collapsedFiles[filePath] !== false}
                  selectedCycle={selectedCycle}
                  onSelectCycle={onSelectCycle}
                  onToggleCollapse={() => onToggleCollapse(filePath)}
                  onClear={() => onClearFile(filePath)}
                />
              );
              })}
          </>
        )}
      </div>
      {/* Always show conversation button */}
      <div class="sidebar-footer">
          <button
            class={`sidebar-conversation-toggle${conversationOpen ? " conv-active" : ""}`}
            title={conversationOpen ? "Hide conversation" : "Show conversation"}
            onClick={onToggleConversation}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Conversation</span>
            {refMessagesCount > 0 && (
              <span class="sidebar-conv-badge">{refMessagesCount}</span>
            )}
          </button>
        </div>
    </div>
  );
}
