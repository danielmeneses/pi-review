/**
 * CodeMinimap — narrow overview strip pinned to the far right.
 * Renders actual code text scaled to fit. Shows viewport overlay.
 * Click to jump to that region.
 *
 * Must be placed inside .diff-scroll with absolute positioning.
 */

import { JSX } from "preact";
import { useRef, useEffect, useState, useCallback } from "preact/hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MinimapLine {
  type: "add" | "del" | "ctx";
  lineNum: number;
  content: string;
}

export interface CodeMinimapProps {
  lines: MinimapLine[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINIMAP_WIDTH = 120;
const FONT_SIZE = 4;
const LINE_HEIGHT = 6;
const FONT_FAMILY = '"SF Mono", "Fira Code", Menlo, monospace';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CodeMinimap({ lines }: CodeMinimapProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const lineCount = lines.length;
  const contentHeight = lineCount * LINE_HEIGHT;

  // Find scroll parent (.diff-scroll) and track container size
  const [containerHeight, setContainerHeight] = useState(300);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container) return;

    // Find .diff-scroll sibling (we're inside .file-body-with-minimap)
    const body = container.closest(".file-body-with-minimap");
    const parent = body?.querySelector<HTMLElement>(".diff-scroll") ?? null;
    setScrollParent(parent);

    // Size canvas to match container
    const updateSize = () => {
      const h = container.clientHeight;
      setContainerHeight(Math.max(20, h));
      if (canvas) {
        canvas.style.height = `${h}px`;
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Draw code text onto canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || lineCount === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = MINIMAP_WIDTH;
    const cssHeight = containerHeight;

    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // Scale: how many content pixels fit in container
    const scale = cssHeight / contentHeight;
    const scaledLineHeight = LINE_HEIGHT * scale;

    ctx.font = `${Math.max(2, FONT_SIZE * scale)}px ${FONT_FAMILY}`;
    ctx.textBaseline = "top";

    const paddingX = 3;
    const maxWidth = cssWidth - paddingX * 2;

    for (let i = 0; i < lineCount; i++) {
      const line = lines[i];
      const y = i * scaledLineHeight;

      // Skip if completely outside viewport
      if (y + scaledLineHeight < 0 || y > cssHeight) continue;

      // Draw bg bar for add/del to make changes pop
      if (line.type === "add") {
        ctx.fillStyle = "rgba(52,211,153,0.15)";
        ctx.fillRect(paddingX, y, maxWidth, scaledLineHeight);
      } else if (line.type === "del") {
        ctx.fillStyle = "rgba(248,113,113,0.15)";
        ctx.fillRect(paddingX, y, maxWidth, scaledLineHeight);
      }

      // Text color by type
      switch (line.type) {
        case "add":
          ctx.fillStyle = "rgba(52,211,153,0.95)";
          break;
        case "del":
          ctx.fillStyle = "rgba(248,113,113,0.95)";
          break;
        default:
          ctx.fillStyle = "rgba(148,163,184,0.4)";
          break;
      }

      // Truncate text to fit
      let text = line.content.slice(0, 120);
      if (!text || text.length === 0) {
        // Empty line: just draw a thin line
        ctx.fillRect(paddingX, y + scaledLineHeight * 0.4, maxWidth, 1);
      } else {
        ctx.fillText(text, paddingX, y, maxWidth);
      }
    }
  }, [lines, lineCount, contentHeight, containerHeight]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  // Viewport overlay tracking
  const [viewportTop, setViewportTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const parent = scrollParent;
    if (!parent) return;

    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = parent;
      if (scrollHeight <= clientHeight) {
        setViewportTop(0);
        setViewportHeight(containerHeight);
        return;
      }
      const ratio = clientHeight / scrollHeight;
      setViewportTop((scrollTop / scrollHeight) * containerHeight);
      setViewportHeight(containerHeight * ratio);
    };

    parent.addEventListener("scroll", update, { passive: true });
    update();
    return () => parent.removeEventListener("scroll", update);
  }, [scrollParent, containerHeight]);

  // Mouse down → start drag or click
  const handleMouseDown = useCallback((e: MouseEvent) => {
    const parent = scrollParent;
    if (!parent) return;
    e.preventDefault();

    const rect = (e.target as HTMLElement).getBoundingClientRect();
    dragRef.current = {
      startY: e.clientY,
      startScrollTop: parent.scrollTop,
    };
    setIsDragging(true);
    document.body.style.userSelect = "none";
  }, [scrollParent]);

  // Mouse move → drag scroll
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current || !scrollParent) return;
    e.preventDefault();

    const deltaY = e.clientY - dragRef.current.startY;
    const scrollDelta = (deltaY / containerHeight) * scrollParent.scrollHeight;

    scrollParent.scrollTop = dragRef.current.startScrollTop + scrollDelta;
  }, [scrollParent, containerHeight]);

  // Mouse up → end drag. If no movement, treat as click jump.
  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (!dragRef.current || !scrollParent) {
      setIsDragging(false);
      document.body.style.userSelect = "";
      return;
    }

    const deltaY = Math.abs(e.clientY - dragRef.current.startY);
    const wasDrag = deltaY > 3;

    if (!wasDrag) {
      // Treat as click: jump to position
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const ratio = clickY / containerHeight;
      scrollParent.scrollTo({
        top: ratio * scrollParent.scrollHeight,
        behavior: "smooth",
      });
    }

    dragRef.current = null;
    setIsDragging(false);
    document.body.style.userSelect = "";
  }, [scrollParent, containerHeight]);

  // Attach global move/up listeners when dragging
  useEffect(() => {
    if (!isDragging) return;
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  if (lineCount === 0) return <div class="code-minimap" />;

  return (
    <div ref={containerRef} class={`code-minimap${isDragging ? " code-minimap-dragging" : ""}`}>
      <canvas
        ref={canvasRef}
        class="code-minimap-canvas"
        onMouseDown={handleMouseDown}
      />
      <div
        class="code-minimap-viewport"
        style={{
          top: `${viewportTop}px`,
          height: `${Math.max(4, viewportHeight)}px`,
        }}
      />
    </div>
  );
}
