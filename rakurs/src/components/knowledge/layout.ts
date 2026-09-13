import type { KbGraph } from '@/types';

/**
 * A deterministic force layout for the graph tab.
 *
 * Fruchterman-Reingold, the textbook algorithm: every note repels every other note (so
 * unrelated notes spread out instead of piling on top of each other), every `[[link]]`
 * pulls its two notes together (so a note and what it links to end up closer than two notes
 * that share no link), and a cooling "temperature" caps how far a note may move each step —
 * the annealing that lets the layout settle instead of oscillating forever.
 *
 * The one departure from the textbook version is where the starting positions come from.
 * The original seeds them with `Math.random`; this hashes each note's id instead. That is
 * the whole reason `layout` is a pure function you can unit-test: the same graph laid out
 * twice, with the same `steps`, lands on the exact same floats both times, and a vault does
 * not redraw itself differently every time an owner opens the tab.
 */

export interface Point {
  x: number;
  y: number;
}

// A fixed simulation plane, independent of whatever pixel size the canvas ends up drawing
// at. `Graph.tsx` maps these coordinates into its own viewport; the layout itself never
// needs to know how large the screen is.
const WIDTH = 1000;
const HEIGHT = 1000;
/**
 * Pull toward the origin, per unit of distance. Balanced against the summed repulsion of
 * the other notes (about `n · k² / r` with `k² = WIDTH · HEIGHT / n`), it settles notes in
 * a disc of radius `sqrt(WIDTH · HEIGHT / GRAVITY)` ≈ 500 whatever the vault's size — the
 * same plane the seeds start in.
 */
const GRAVITY = 4;

/**
 * FNV-1a over the id's characters. Any string in, the same 32-bit unsigned integer out,
 * every time — that determinism is all this needs to provide.
 */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, deterministic PRNG. Seeded once per note from `hashId`, it stands
 * in for `Math.random` without reading anything outside the note's own id. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function layout(graph: KbGraph, steps: number): Map<string, Point> {
  const positions = new Map<string, Point>();
  if (graph.notes.length === 0) return positions;

  // Two calls to the same note's PRNG, so a note's x and y do not collapse onto the same
  // value — and no note's start depends on any other note's id or on iteration order.
  for (const note of graph.notes) {
    const rand = mulberry32(hashId(note.id));
    positions.set(note.id, {
      x: (rand() - 0.5) * WIDTH,
      y: (rand() - 0.5) * HEIGHT,
    });
  }

  // One note has nothing to repel and nothing to link to — its seeded position is the
  // whole answer, and running the simulation would just be arithmetic on zero forces.
  if (graph.notes.length < 2) return positions;

  const ids = graph.notes.map((n) => n.id);
  const k = Math.sqrt((WIDTH * HEIGHT) / ids.length);

  // The server only ever sends edges whose target resolved, but a defensive filter here
  // costs nothing and keeps this function correct even if that guarantee ever loosens.
  const edges = graph.links.filter((l) => positions.has(l.from) && positions.has(l.to));

  for (let step = 0; step < steps; step += 1) {
    const displacement = new Map<string, Point>(ids.map((id) => [id, { x: 0, y: 0 }]));

    // Repulsion between every pair — O(n^2), fine up to the server's 500-note cap.
    for (let i = 0; i < ids.length; i += 1) {
      const a = positions.get(ids[i])!;
      const da = displacement.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j += 1) {
        const b = positions.get(ids[j])!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        // Clamped so two notes whose seeded positions coincide exactly cannot divide by
        // zero. That does not push them apart: `ux`/`uy` below are both zero in that case,
        // so the pair displaces each other by nothing and stays coincident. Harmless, and
        // only possible when two note ids hash to the same 32-bit value.
        const dist = Math.max(Math.hypot(dx, dy), 0.01);
        const force = (k * k) / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        da.x += ux * force;
        da.y += uy * force;
        const db = displacement.get(ids[j])!;
        db.x -= ux * force;
        db.y -= uy * force;
      }
    }

    // Attraction along every link — the force that pulls linked notes closer than
    // unlinked ones, which is the property the brief's tests hold this function to.
    for (const edge of edges) {
      const a = positions.get(edge.from)!;
      const b = positions.get(edge.to)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const force = (dist * dist) / k;
      const ux = dx / dist;
      const uy = dy / dist;
      const da = displacement.get(edge.from)!;
      da.x -= ux * force;
      da.y -= uy * force;
      const db = displacement.get(edge.to)!;
      db.x += ux * force;
      db.y += uy * force;
    }

    // Gravity toward the centre. Without it, repulsion is the only force on a note with no
    // links, and a vault of unlinked notes flies apart without bound — eight notes spread
    // over ~27 000 units, far past what the camera can frame. Linear in distance, so it is
    // negligible near the middle and wins over the (1/dist) repulsion further out, which
    // settles every note, linked or not, inside a bounded disc.
    for (const id of ids) {
      const pos = positions.get(id)!;
      const disp = displacement.get(id)!;
      disp.x -= pos.x * GRAVITY;
      disp.y -= pos.y * GRAVITY;
    }

    // Cooling: the cap on a single step's move shrinks linearly to zero across the run.
    // Early steps can leap; late steps only settle — this is what makes the simulation
    // converge on a stable picture instead of two notes bouncing past each other forever.
    const temperature = (WIDTH / 10) * (1 - step / steps);
    for (const id of ids) {
      const pos = positions.get(id)!;
      const disp = displacement.get(id)!;
      const dist = Math.max(Math.hypot(disp.x, disp.y), 0.01);
      const capped = Math.min(dist, temperature);
      pos.x += (disp.x / dist) * capped;
      pos.y += (disp.y / dist) * capped;
    }
  }

  return positions;
}
