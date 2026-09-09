import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { layout, type Point } from './layout.js';
import { EmptyState } from '@/components/ui/states';
import { useAppState } from '@/store/app-state';
import type { KbGraph } from '@/types';

/**
 * The graph tab: every note as a node, every resolved `[[link]]` as an edge, positioned by
 * `layout`.
 *
 * Read-only, on purpose. A link is text inside a note — a `[[Title]]` somewhere in its
 * markdown body — and this canvas is a *view* of that text, not a second place to author
 * it. So there is no dragging a line between two nodes to create a link: the only mutation
 * a click here can cause is opening the note the graph already drew. Panning and zooming
 * only move the camera, never the vault.
 */

const MIN_SCALE = 0.15;
const MAX_SCALE = 5;
/** Below this zoom, titles would overlap into noise faster than they'd help — so they wait
 * until the owner has zoomed in enough for a label per node to make sense. */
const LABEL_SCALE_THRESHOLD = 0.6;
const NODE_RADIUS = 5;
/** Generous past the drawn radius: a precise click on a 5px dot is not a fair ask. */
const HIT_RADIUS = 10;
/** A drag under this many pixels reads as a click that wobbled, not a pan. */
const DRAG_THRESHOLD = 4;

interface Camera {
  scale: number;
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
  dpr: number;
}

function truncateLabel(title: string): string {
  return title.length > 28 ? `${title.slice(0, 27)}…` : title;
}

export function Graph({
  graph,
  onOpenNote,
}: {
  graph: KbGraph;
  /** Already the screen's own dirty-editor guard — this component never bypasses it. */
  onOpenNote: (noteId: string) => void;
}) {
  const { theme } = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0, dpr: 1 });
  const [camera, setCamera] = useState<Camera>({ scale: 1, x: 0, y: 0 });
  // The last drawn screen position of every node, so a click can hit-test against exactly
  // what is on screen without recomputing the world-to-screen transform by hand.
  const screenRef = useRef<Map<string, Point>>(new Map());
  const dragRef = useRef<{ x: number; y: number; camX: number; camY: number; moved: boolean } | null>(
    null,
  );
  // Which `positions` map the camera was last fitted to — so a freshly loaded graph gets
  // framed once, but panning or resizing afterwards does not keep yanking the view back.
  const fittedRef = useRef<Map<string, Point> | null>(null);

  // Fewer steps for a big vault: the simulation is O(notes^2) per step, and a tab switch
  // should not stall the UI thread waiting on the server's 500-note cap to settle.
  const steps = Math.max(60, Math.min(300, Math.round(30_000 / Math.max(graph.notes.length, 1))));
  const positions = useMemo(() => layout(graph, steps), [graph, steps]);

  // Size the canvas in device pixels for crisp lines on a hi-DPI screen, and re-measure
  // whenever the container's own box changes — including the very first layout pass.
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const measure = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      setSize({ width: rect.width, height: rect.height, dpr });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Frame every node the first time its layout is ready, so a vault of five notes and one
  // of five hundred both open already fitted to the canvas instead of at a fixed zoom that
  // suits neither.
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    if (fittedRef.current === positions) return;
    fittedRef.current = positions;
    if (positions.size === 0) return;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const padding = 60;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const fitScale = Math.min(
      (size.width - padding) / spanX,
      (size.height - padding) / spanY,
      MAX_SCALE,
    );
    const scale = Math.max(MIN_SCALE, fitScale);
    setCamera({ scale, x: -((minX + maxX) / 2) * scale, y: -((minY + maxY) / 2) * scale });
  }, [positions, size.width, size.height]);

  // The draw pass. `theme` is a dependency purely to force a redraw when the owner flips
  // light/dark — the canvas reads colours from CSS custom properties at paint time rather
  // than duplicating the palette in TypeScript, and nothing else tells it those values moved.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const styles = getComputedStyle(document.documentElement);
    const lineColor = styles.getPropertyValue('--line-strong').trim() || '#888';
    const nodeFill = styles.getPropertyValue('--accent-2').trim() || '#0d9668';
    const nodeStroke = styles.getPropertyValue('--accent-4').trim() || '#0b7a55';
    const labelColor = styles.getPropertyValue('--text-3').trim() || '#888';

    const screen = new Map<string, Point>();
    for (const note of graph.notes) {
      const p = positions.get(note.id);
      if (!p) continue;
      screen.set(note.id, {
        x: size.width / 2 + camera.x + p.x * camera.scale,
        y: size.height / 2 + camera.y + p.y * camera.scale,
      });
    }
    screenRef.current = screen;

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const link of graph.links) {
      const a = screen.get(link.from);
      const b = screen.get(link.to);
      if (!a || !b) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    const showLabels = camera.scale >= LABEL_SCALE_THRESHOLD;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    for (const note of graph.notes) {
      const p = screen.get(note.id);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = nodeFill;
      ctx.fill();
      ctx.strokeStyle = nodeStroke;
      ctx.lineWidth = 1;
      ctx.stroke();

      if (showLabels) {
        ctx.fillStyle = labelColor;
        ctx.fillText(truncateLabel(note.title), p.x + NODE_RADIUS + 4, p.y);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, positions, camera, size, theme]);

  function hitTest(mx: number, my: number): string | null {
    let found: string | null = null;
    let bestDist = HIT_RADIUS;
    for (const [id, p] of screenRef.current) {
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d <= bestDist) {
        bestDist = d;
        found = id;
      }
    }
    return found;
  }

  function onWheel(e: ReactWheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setCamera((prev) => {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));
      // Zoom around the cursor, not the centre: the world point under the mouse stays put.
      const worldX = (mx - size.width / 2 - prev.x) / prev.scale;
      const worldY = (my - size.height / 2 - prev.y) / prev.scale;
      return {
        scale: nextScale,
        x: mx - size.width / 2 - worldX * nextScale,
        y: my - size.height / 2 - worldY * nextScale,
      };
    });
  }

  // Pointer capture (not plain mouse events) so a pan that ends outside the canvas — an
  // easy thing to do while dragging a wide graph — still delivers its move and up events
  // here instead of leaving the drag stuck open.
  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, camX: camera.x, camY: camera.y, moved: false };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true;
    setCamera((prev) => ({ ...prev, x: drag.camX + dx, y: drag.camY + dy }));
  }

  function endDrag(e: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    // A pan that moved the camera is not a click on a node — only a still pointer-up asks
    // "what did I click", the way it does everywhere else on this screen.
    if (!drag || drag.moved) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) onOpenNote(hit);
  }

  if (graph.notes.length === 0) {
    return <EmptyState>В базе знаний пока нет заметок — рисовать граф не из чего.</EmptyState>;
  }
  if (graph.notes.length === 1) {
    return (
      <EmptyState>
        В базе одна заметка. Граф показывает связи между заметками — сошлитесь на другую
        через «[[Название]]», и здесь появится вторая точка и линия между ними.
      </EmptyState>
    );
  }

  return (
    <div>
      {graph.truncated && (
        <div style={{ padding: '0 2px 10px', fontSize: 11, color: 'var(--text-dim)' }}>
          Показаны первые 500 заметок — в базе их больше. Остальные и их связи здесь не
          нарисованы, чтобы граф не показывал то, чего не видит.
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          width: '100%',
          height: 560,
          overflow: 'hidden',
          background: 'var(--sunken)',
          border: '1px solid var(--line)',
          borderRadius: 8,
        }}
      >
        <canvas
          ref={canvasRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          style={{ width: '100%', height: '100%', display: 'block', cursor: 'grab', touchAction: 'none' }}
        />
      </div>
    </div>
  );
}
