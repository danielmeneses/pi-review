/**
 * FilesPane — right-side panel for searching and browsing project files.
 *
 * Features:
 * - Search bar with debounced autocomplete
 * - List of opened/searched files
 * - Click file to view in main area
 * - Remove individual files or clear all
 * - Toggle pane open/closed
 */

import { JSX } from "preact";
import { useState, useRef, useEffect, useCallback } from "preact/hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileEntry {
  relativePath: string;
  absolutePath: string;
}

export interface FilesPaneProps {
  /** List of file entries currently open in the pane. */
  files: FileEntry[];
  /** Currently selected file from this pane, or null. */
  selectedFile: string | null;
  /** Whether the pane is visible. */
  open: boolean;
  /** Pane width in pixels. */
  width?: number;
  /** Called when user clicks a file to view it. Receives relative and absolute paths. */
  onSelectFile: (relativePath: string, absolutePath: string) => void;
  /** Called when user removes a file from the list. */
  onRemoveFile: (relativePath: string) => void;
  /** Called when user clears all files. */
  onClearAll: () => void;
  /** Called to toggle the pane open/closed. */
  onToggle: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FilesPane(props: FilesPaneProps): JSX.Element {
  const { files, selectedFile, open, width, onSelectFile, onRemoveFile, onClearAll, onToggle } = props;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ relativePath: string; absolutePath: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Focus search input when pane opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setDropdownOpen(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search-files?q=${encodeURIComponent(q)}`);
        if (!res.ok) { setResults([]); return; }
        const data = await res.json();
        setResults(data.results ?? []);
        setDropdownOpen(true);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (dropdownRef.current && !dropdownRef.current.contains(target) &&
          inputRef.current && !inputRef.current.contains(target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const handleSelectResult = useCallback((result: { relativePath: string; absolutePath: string }) => {
    onSelectFile(result.relativePath, result.absolutePath);
    setQuery("");
    setResults([]);
    setDropdownOpen(false);
  }, [onSelectFile]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setDropdownOpen(false);
      setQuery("");
    }
  }, []);

  if (!open) {
    return <></>;
  }

  return (
    <div class="files-pane" style={width ? { width: width + "px" } : undefined}>
      <div class="files-pane-header">
        <span class="files-pane-title">Files</span>
        <div class="files-pane-header-actions">
          {files.length > 0 && (
            <button class="files-pane-clear-all" title="Clear all files" onClick={onClearAll}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
              </svg>
            </button>
          )}
          <button class="files-pane-close" title="Close pane" onClick={onToggle}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div class="files-pane-search">
        <svg class="files-pane-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          class="files-pane-search-input"
          placeholder="Search files..."
          value={query}
          onInput={(e: Event) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results.length > 0) setDropdownOpen(true); }}
        />
        {searching && <div class="files-pane-search-spinner" />}

        {/* Search results dropdown */}
        {dropdownOpen && results.length > 0 && (
          <div ref={dropdownRef} class="files-pane-dropdown">
            {results.map((r) => (
              <div
                key={r.relativePath}
                class="files-pane-dropdown-item"
                onClick={() => handleSelectResult(r)}
              >
                <span class="files-pane-dropdown-name">{r.relativePath}</span>
              </div>
            ))}
          </div>
        )}

        {dropdownOpen && results.length === 0 && !searching && query.length >= 2 && (
          <div class="files-pane-dropdown files-pane-dropdown-empty">
            <span>No files found</span>
          </div>
        )}
      </div>

      {/* Opened files list */}
      <div class="files-pane-list">
        {files.length === 0 ? (
          <div class="files-pane-empty">Search and select files to add them here</div>
        ) : (
          files.map((f) => (
            <div
              key={f.relativePath}
              class={`files-pane-item${selectedFile === f.relativePath ? " selected" : ""}`}
              onClick={() => onSelectFile(f.relativePath, f.absolutePath)}
            >
              <span class="files-pane-item-name" title={f.relativePath}>{f.relativePath}</span>
              <button
                class="files-pane-item-remove"
                title="Remove"
                onClick={(e: MouseEvent) => { e.stopPropagation(); onRemoveFile(f.relativePath); }}
              >
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
