/**
 * EditorSelector — a small dropdown in the file header that lets the user
 * choose which IDE to open files in. The choice is persisted to localStorage
 * and survives reloads.
 */

import { JSX } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import { apiOpenInEditor } from "../store.js";

// ---------------------------------------------------------------------------
// Available editors
// ---------------------------------------------------------------------------

const EDITORS: Array<{ id: string; label: string; icon: string }> = [
  { id: "code",     label: "VS Code",   icon: "⌨" },
  { id: "cursor",   label: "Cursor",    icon: "↗" },
  { id: "windsurf", label: "Windsurf",  icon: "🌊" },
  { id: "idea",     label: "IntelliJ",  icon: "◆" },
  { id: "webstorm", label: "WebStorm",  icon: "⚡" },
];

const STORAGE_KEY = "pi-review-editor";

function getStoredEditor(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "code";
  } catch {
    return "code";
  }
}

function storeEditor(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface EditorSelectorProps {
  filePath: string;
}

export function EditorSelector({ filePath }: EditorSelectorProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState(getStoredEditor);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current = EDITORS.find(e => e.id === editor) ?? EDITORS[0];

  const handleOpen = async () => {
    await apiOpenInEditor(filePath, editor);
  };

  const handleSelect = (id: string) => {
    storeEditor(id);
    setEditor(id);
    setOpen(false);
    // Open immediately with the newly selected editor
    apiOpenInEditor(filePath, id);
  };

  return (
    <div class="editor-selector">
      <button
        ref={btnRef}
        class="btn-open-editor"
        title={`Open in ${current.label}`}
        onClick={handleOpen}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/>
        </svg>
        <span class="editor-label">{current.label}</span>
      </button>
      <button
        class="editor-arrow"
        title="Choose editor"
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div ref={menuRef} class="editor-menu">
          {EDITORS.map(ed => (
            <div
              key={ed.id}
              class={`editor-menu-item${ed.id === editor ? " editor-menu-active" : ""}`}
              onClick={() => handleSelect(ed.id)}
            >
              <span class="editor-menu-icon">{ed.icon}</span>
              <span>{ed.label}</span>
              {ed.id === editor && <span class="editor-check">✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
