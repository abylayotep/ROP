import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { layout, type Point } from './layout.js';
import { EmptyState, Skeleton } from '@/components/ui/states';
import { pluralRu } from '@/lib/training-state';
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

const MIN_SCALE = 0.05;
const MAX_SCALE = 5;
/** Below this zoom, titles would overlap into noise faster than they'd help — so they wait
 * until the owner has zoomed in enough for a label per node to make sense. */
const LABEL_SCALE_THRESHOLD = 0.6;
/** A vault this small has room for every title at any zoom the fit picks. */
const ALWAYS_LABEL_NOTES = 40;
const NODE_RADIUS = 5;
/** Each link a note takes part in grows its dot a little, up to this radius. */
const MAX_NODE_RADIUS = 11;
/** Generous past the drawn radius: a precise click on a 5px dot is not a fair ask. */
const HIT_RADIUS = 12;
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

function nodeRadius(degree: number): number {
  return Math.min(MAX_NODE_RADIUS, NODE_RADIUS + Math.sqrt(degree) * 2);
}

/** The camera that frames every position with a margin, or null when there is nothing to frame. */
function fitCamera(positions: Map<string, Point>, size: Size): Camera | null {
  if (positions.size === 0 || size.width === 0 || size.height === 0) return null;
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
  // Wider on the right: labels are drawn to the right of their dot.
  const padX = 180;
  const padY = 70;
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const fitScale = Math.min(
    Math.max(size.width - padX, 40) / spanX,
    Math.max(size.height - padY, 40) / spanY,
    1.6,
  );
  const scale = Math.max(MIN_SCALE, fitScale);
  // Nudged left by a label's width so the rightmost titles are not clipped.
  return { scale, x: -((minX + maxX) / 2) * scale - 50, y: -((minY + maxY) / 2) * scale };
}

export function Graph({
  graph,
  onOpenNote,
  onOpenReview,
}: {
  graph: KbGraph;
  /** Already the screen's own dirty-editor guard — this component never bypasses it. */
  onOpenNote: (noteId: string) => void;
  /** Given only when drafts wait for review: an empty base usually means nothing is applied yet. */
  onOpenReview?: () => void;
}) {
  const { theme } = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0, dpr: 1 });
  const [camera, setCamera] = useState<Camera>({ scale: 1, x: 0, y: 0 });
  // The note under the pointer: it and its neighbours stay bright, the rest of the vault dims.
  const [hovered, setHovered] = useState<string | null>(null);
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

  // `layout` itself stays a pure, synchronous function — that purity is what makes it
  // unit-testable, and slicing it across frames would trade that away for a saving nobody
  // needs at the 500-note cap. What moves is *when* it runs: at that cap it costs on the
  // order of 200ms, and running it inside render (e.g. via `useMemo`) would compute it
  // before React ever commits and paints the loading skeleton below — the owner would see
  // the tab freeze, then the picture appear. An effect runs after that paint, so the
  // skeleton is what freezes the thread this time, not a blank tab.
  const [positions, setPositions] = useState<Map<string, Point> | null>(null);

  useEffect(() => {
    // A stale computation must never win a race against a newer one, and a graph that
    // changed underneath a finished layout must not leave the old picture on screen: reset
    // to "computing" the moment `graph`/`steps` change, and let `cancelled` stop a
    // still-running previous computation from overwriting the newer one's result.
    let cancelled = false;
    setPositions(null);
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      const result = layout(graph, steps);
      if (!cancelled) setPositions(result);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [graph, steps]);

  // The canvas exists only past the empty states below. Keyed into the sizing effect so a
  // graph that grows from one note to two, without a remount, still gets its canvas measured.
  const drawable = graph.notes.length > 1;

  // Size the canvas in device pixels for crisp lines on a hi-DPI screen, and re-measure
  // whenever the container's own box changes — including the very first layout pass. The
  // graph view sits in a panel hidden with `display: none` while the notes view is on screen;
  // the observer also fires when that panel is shown again, so the canvas never stays 0×0.
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
  }, [drawable]);

  // Frame every node the first time its layout is ready, so a vault of five notes and one
  // of five hundred both open already fitted to the canvas instead of at a fixed zoom that
  // suits neither.
  useEffect(() => {
    // Still computing (or about to start over for a newer graph) — nothing to fit yet.
    if (!positions || size.width === 0 || size.height === 0) return;
    if (fittedRef.current === positions) return;
    fittedRef.current = positions;
    const next = fitCamera(positions, size);
    if (next) setCamera(next);
  }, [positions, size]);

  const degree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of graph.links) {
      counts.set(link.from, (counts.get(link.from) ?? 0) + 1);
      counts.set(link.to, (counts.get(link.to) ?? 0) + 1);
    }
    return counts;
  }, [graph]);

  const neighbours = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const link of graph.links) {
      if (link.from === hovered) set.add(link.to);
      if (link.to === hovered) set.add(link.from);
    }
    return set;
  }, [graph, hovered]);

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
    // Still computing (or starting over for a newer graph): leave the canvas blank under
    // the loading skeleton rather than drawing the previous graph's stale positions.
    if (!positions) return;

    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    // `--line-strong` is a border colour and all but vanishes on the canvas's own ground.
    const lineColor = token('--text-dim', '#6f7c78');
    const accent = token('--accent', '#12b37d');
    const nodeFill = token('--accent-2', '#0d9668');
    const lonelyFill = token('--text-dim', '#6f7c78');
    const labelColor = token('--text-3', '#b9c4c1');
    const haloColor = token('--sunken', '#0f1413');

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

    const dimmed = (id: string) => neighbours !== null && !neighbours.has(id);

    ctx.lineWidth = 1.2;
    for (const link of graph.links) {
      const a = screen.get(link.from);
      const b = screen.get(link.to);
      if (!a || !b) continue;
      const lit = hovered !== null && (link.from === hovered || link.to === hovered);
      ctx.globalAlpha = lit ? 1 : neighbours === null ? 0.7 : 0.12;
      ctx.strokeStyle = lit ? accent : lineColor;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const showLabels = graph.notes.length <= ALWAYS_LABEL_NOTES || camera.scale >= LABEL_SCALE_THRESHOLD;
    ctx.font = '500 12px "Golos Text", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    for (const note of graph.notes) {
      const p = screen.get(note.id);
      if (!p) continue;
      const links = degree.get(note.id) ?? 0;
      const r = nodeRadius(links);
      const isHovered = note.id === hovered;
      ctx.globalAlpha = dimmed(note.id) ? 0.2 : 1;

      if (isHovered) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.22;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      // A note nothing links to, and that links nowhere, is drawn grey: the one thing the
      // picture can say about it is that it stands alone.
      ctx.fillStyle = isHovered ? accent : links === 0 ? lonelyFill : nodeFill;
      ctx.fill();

      if (showLabels || isHovered) {
        const label = truncateLabel(note.title);
        const lx = p.x + r + 6;
        // A halo in the canvas's own ground keeps a title readable where it crosses a line.
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = 4;
        ctx.strokeText(label, lx, p.y);
        ctx.fillStyle = isHovered ? accent : labelColor;
        ctx.fillText(label, lx, p.y);
      }
    }
    ctx.globalAlpha = 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, positions, camera, size, theme, hovered, neighbours, degree]);

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
    if (!drag) {
      const rect = e.currentTarget.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit !== hovered) setHovered(hit);
      return;
    }
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

  function refit() {
    if (!positions) return;
    const next = fitCamera(positions, size);
    if (next) setCamera(next);
  }

  if (graph.notes.length === 0) {
    return (
      <EmptyState>
        <p style={{ margin: 0 }}>Граф появится, когда в базе знаний будут заметки.</p>
        {onOpenReview && (
          <button type="button" className="btn btn-sm" style={{ marginTop: 12 }} onClick={onOpenReview}>
            Открыть «На проверке»
          </button>
        )}
      </EmptyState>
    );
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
      {graph.links.length === 0 && (
        <div style={{ padding: '0 2px 10px', fontSize: 12, lineHeight: 1.5, color: 'var(--text-dim)' }}>
          Связей пока нет: они появляются из ссылок [[Название]] в тексте заметок. Серые точки —
          заметки, которые ни с чем не связаны; нажмите на точку, чтобы открыть заметку.
        </div>
      )}
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
          onPointerLeave={() => {
            if (!dragRef.current) setHovered(null);
          }}
          aria-label="Граф связей между заметками"
          style={{ width: '100%', height: '100%', display: 'block', cursor: hovered ? 'pointer' : 'grab', touchAction: 'none' }}
        />
        {positions && (
          <div className="knowledge-graph__toolbar">
            <span>{graph.notes.length} {pluralRu(graph.notes.length, 'заметка', 'заметки', 'заметок')} · {graph.links.length} {pluralRu(graph.links.length, 'связь', 'связи', 'связей')}</span>
            <button type="button" className="btn-sm" onClick={refit}>Вписать</button>
          </div>
        )}
        {/* Canvas stays mounted underneath — its own sizing effect must not lose its ref —
            but blank, while this covers it: the owner sees the wait, not a frozen tab. */}
        {!positions && (
          <div style={{ position: 'absolute', inset: 0, padding: 12 }}>
            <Skeleton height="100%" radius={8} />
          </div>
        )}
      </div>
    </div>
  );
}
