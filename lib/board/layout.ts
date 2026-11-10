// Ids of derived elements (labels, patches, lifelines) use ":" — a character
// model ids can never contain — so they never collide with a model's id.
//
// The board's deterministic layout: a board state → Excalidraw element
// skeletons (plain data, fed to `convertToExcalidrawElements` in the browser),
// and `finish`, which places labels and arrow points after Excalidraw has
// measured the text. No model is involved and nothing here imports Excalidraw:
// fixed grid cells and fixed sequence pitches keep unchanged parts where they
// were when the drawing grows.

import {
  type ArrowDef,
  type BoardDef,
  type BoardState,
  type BoxDef,
  type BoxShape,
  COLORS,
  groupCells,
  isInside,
} from "./model";

/** The highlight marker: stronger than the yellow box fill, so a yellow box still changes. */
export const MARK = "#ffe066";
const RED = "#e03131";
const INK = "#1e1e1e";
const MUTED = "#868e96";
const FRAME = "#495057";
const GROUP_TINT = {
  blue: "#e7f5ff",
  green: "#ebfbee",
  yellow: "#fff9db",
  red: "#fff5f5",
  gray: "#f1f3f5",
  white: "transparent",
} as const;

type Point = [number, number];
type Align = "center" | "above" | "below" | "left" | "right";

/**
 * One Excalidraw element skeleton. Loose on purpose: it is handed to
 * `convertToExcalidrawElements` as is; `customData.points` / `customData.anchor`
 * are read back by `finish`.
 */
export interface BoardElementSkeleton {
  type: "text" | "rectangle" | "ellipse" | "diamond" | "arrow" | "line";
  id: string;
  x: number;
  y: number;
  [key: string]: unknown;
}

// Excalidraw does not wrap a bound label on conversion, so wrap words ourselves.
export function wrap(t: string, n = 16): string {
  return t
    .split(" ")
    .reduce<string[]>((ls, w) => {
      const last = ls.at(-1);
      if (last !== undefined && `${last} ${w}`.length <= n) ls[ls.length - 1] = `${last} ${w}`;
      else ls.push(w);
      return ls;
    }, [])
    .join("\n");
}

const TOP = 60;
const BOARD_GAP = 140;
const GAP = 6;
// the text area of an ellipse/diamond is smaller than its bounding box, so they are wider and wrap earlier
const SHAPE = {
  rect: { w: 210, chars: 16, pad: 22, min: 70 },
  ellipse: { w: 240, chars: 13, pad: 44, min: 84 },
  diamond: { w: 250, chars: 10, pad: 64, min: 100 },
} as const;
const shapeOf = (b: { shape?: BoxShape }) => SHAPE[b.shape ?? "rect"];
const boxLines = (b: BoxDef) => {
  const k = shapeOf(b);
  return [wrap(b.text, k.chars), ...b.notes.map((n) => wrap(n, k.chars + 4))].join("\n");
};
const boxHeight = (b: BoxDef) => {
  const k = shapeOf(b);
  return Math.max(k.min, boxLines(b).split("\n").length * 25 + k.pad);
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: BoxShape;
  frame?: boolean;
  label?: string;
  fontSize?: number;
  dashed?: boolean;
}
interface Route {
  pts: Point[];
  label: Point;
  align: Align;
}
interface BoardLayout {
  rects: Map<string, Rect>;
  extra: Map<string, BoardElementSkeleton[]>;
  deco: BoardElementSkeleton[];
  frames?: { id: string; r: Rect; depth: number }[];
  width: number;
  routes: Map<string, Route>;
}

// --- grid: fixed cells, so nothing moves when the drawing grows (the export crops empty margins).
const CELL_W = 330;
const CELL_H = 170;
const MAX_BOX_H = 150;
const ROW_GAP = CELL_H - 80;
const FRAME_PAD = 14;
const FRAME_TOP = 20;

function gridLayout(s: BoardState, b: BoardDef, x0: number): BoardLayout {
  const boxes = [...s.boxes.values()].filter((x) => x.board === b.id);
  const rects = new Map<string, Rect>();
  const boxRects = new Map<string, Rect>();
  for (const x of boxes) {
    const h = Math.min(MAX_BOX_H, boxHeight(x));
    const w = shapeOf(x).w;
    const r: Rect = {
      x: x0 + (x.col ?? 0) * CELL_W + (CELL_W - w) / 2,
      y: TOP + (x.row ?? 0) * CELL_H + (CELL_H - h) / 2,
      w,
      h,
      ...(x.shape ? { shape: x.shape } : {}),
    };
    rects.set(x.id, r);
    boxRects.set(x.id, r);
  }
  // group frames: union of the members' rects (inner frames first), padded; label sits on the top border
  const frames: { id: string; r: Rect; depth: number }[] = [];
  const frameOf = (gid: string, depth: number): Rect | null => {
    const parts = [
      ...[...s.boxes.values()].filter((x) => x.in === gid).map((x) => rects.get(x.id)),
      ...[...s.groups.values()].filter((x) => x.in === gid).map((x) => frameOf(x.id, depth + 1)),
    ].filter((r): r is Rect => Boolean(r));
    if (!parts.length) return null;
    const x1 = Math.min(...parts.map((r) => r.x));
    const y1 = Math.min(...parts.map((r) => r.y));
    const x2 = Math.max(...parts.map((r) => r.x + r.w));
    const y2 = Math.max(...parts.map((r) => r.y + r.h));
    const r: Rect = {
      x: x1 - FRAME_PAD,
      y: y1 - FRAME_TOP,
      w: x2 - x1 + 2 * FRAME_PAD,
      h: y2 - y1 + FRAME_TOP + FRAME_PAD,
      frame: true,
    };
    rects.set(gid, r);
    frames.push({ id: gid, r, depth });
    return r;
  };
  for (const g of s.groups.values()) if (g.board === b.id && !g.in) frameOf(g.id, 0);
  frames.sort((p, q) => p.depth - q.depth); // outer frames are drawn first (below)
  const cols = Math.max(1, ...boxes.map((x) => (x.col ?? 0) + 1));
  return {
    rects,
    extra: new Map(),
    deco: [],
    frames,
    width: cols * CELL_W,
    routes: route(s, rects, boxRects),
  };
}

// --- sequence: boxes are participants left→right, arrows are messages top→bottom in drawing order
const ACT_W = 180;
const MSG_H = 66;
const PITCH = 270; // fixed, so participants never move when messages are added

function sequenceLayout(s: BoardState, b: BoardDef, x0: number): BoardLayout {
  const actors = s.order.map((id) => s.boxes.get(id)).filter((x): x is BoxDef => x?.board === b.id);
  const msgs = s.order
    .map((id) => s.arrows.get(id))
    .filter((a): a is ArrowDef => Boolean(a) && s.boxes.get((a as ArrowDef).from)?.board === b.id);
  const h = Math.max(70, ...actors.map(boxHeight));
  const rects = new Map<string, Rect>();
  const extra = new Map<string, BoardElementSkeleton[]>();
  const routes = new Map<string, Route>();
  const cx = new Map<string, number>();
  actors.forEach((a, i) => {
    rects.set(a.id, { x: x0 + i * PITCH, y: TOP, w: ACT_W, h });
    cx.set(a.id, x0 + i * PITCH + ACT_W / 2);
  });
  let y = TOP + h + 50;
  for (const m of msgs) {
    const xa = cx.get(m.from) ?? 0;
    const xb = cx.get(m.to) ?? 0;
    if (m.from === m.to) {
      routes.set(m.id, {
        pts: [
          [xa + 4, y],
          [xa + 44, y],
          [xa + 44, y + 30],
          [xa + 8, y + 30],
        ],
        label: [xa + 52, y + 15],
        align: "left",
      });
      y += MSG_H + 14;
    } else {
      const dir = Math.sign(xb - xa);
      routes.set(m.id, {
        pts: [
          [xa + dir * 4, y],
          [xb - dir * 6, y],
        ],
        label: [(xa + xb) / 2, y - 6],
        align: "above",
      });
      y += MSG_H;
    }
  }
  for (const a of actors) {
    const x = cx.get(a.id) ?? 0;
    extra.set(a.id, [
      {
        type: "line",
        id: `${a.id}:life`,
        x,
        y: TOP + h,
        width: 0.01,
        height: y - TOP - h,
        strokeColor: MUTED,
        strokeStyle: "dashed",
        strokeWidth: 1,
        customData: {
          points: [
            [0, 0],
            [0, y - TOP - h],
          ],
        },
      },
    ]);
  }
  const width = actors.length ? (actors.length - 1) * PITCH + ACT_W : 260;
  return { rects, extra, deco: [], width, routes };
}

// --- bits: boxes are fields of a header/format, filling rows of `rowBits` bits left→right
const ROW_W = 640;
const ROW_H = 64;
const GUTTER = 56;

function bitsLayout(s: BoardState, b: BoardDef, x0: number): BoardLayout {
  const fields = s.order.map((id) => s.boxes.get(id)).filter((x): x is BoxDef => x?.board === b.id);
  const n = b.rowBits ?? 32;
  const U = ROW_W / n;
  const top = TOP + 34;
  const rects = new Map<string, Rect>();
  const extra = new Map<string, BoardElementSkeleton[]>();
  const deco: BoardElementSkeleton[] = [];
  let off = 0;
  for (const f of fields) {
    let rest = f.bits ?? (off % n ? n - (off % n) : n);
    const segs: Rect[] = [];
    while (rest > 0) {
      const row = Math.floor(off / n);
      const col = off % n;
      const take = Math.min(rest, n - col);
      segs.push({ x: x0 + GUTTER + col * U, y: top + row * ROW_H, w: take * U, h: ROW_H });
      off += take;
      rest -= take;
    }
    const main = segs.reduce((m, g) => (g.w > m.w ? g : m));
    const chars = Math.max(3, Math.floor((main.w - 8) / 9));
    const label = [
      wrap(f.text, chars),
      f.bits ? `${f.bits} bit` : "variable",
      ...f.notes.map((t) => wrap(t, chars)),
    ].join("\n");
    rects.set(f.id, { ...main, label, fontSize: 16, dashed: !f.bits });
    // a field crossing a row boundary continues in the next row: label that part "… (cont.)"
    extra.set(
      f.id,
      segs
        .filter((g) => g !== main)
        .map((g, k) => ({
          type: "rectangle" as const,
          id: `${f.id}:seg${k}`,
          x: g.x,
          y: g.y,
          width: g.w,
          height: g.h,
          backgroundColor: COLORS[f.color],
          fillStyle: "solid",
          strokeColor: INK,
          strokeWidth: 2,
          strokeStyle: f.bits ? "solid" : "dashed",
          label: {
            text: wrap(`${f.text} (cont.)`, Math.max(3, Math.floor((g.w - 8) / 8))),
            fontSize: 14,
            strokeColor: MUTED,
          },
        })),
    );
  }
  const rowsUsed = Math.ceil(off / n);
  for (const bit of [0, n / 4, n / 2, (3 * n) / 4, n - 1]) {
    deco.push({
      type: "text",
      id: `${b.id}:bit${bit}`,
      x: x0 + GUTTER + bit * U + 2,
      y: TOP + 8,
      text: String(bit),
      fontSize: 14,
      strokeColor: MUTED,
    });
  }
  for (let r = 0; r < rowsUsed; r++) {
    deco.push({
      type: "text",
      id: `${b.id}:row${r}`,
      x: x0 + 4,
      y: top + r * ROW_H + ROW_H / 2 - 9,
      text: `+${(r * n) / 8}`,
      fontSize: 14,
      strokeColor: MUTED,
    });
  }
  // fields touch each other, so arrows between fields always run in a channel right of the header
  const routes = new Map<string, Route>();
  const right = x0 + GUTTER + ROW_W;
  [...s.arrows.values()]
    .filter((a) => rects.has(a.from) && rects.has(a.to))
    .forEach((a, i) => {
      const A = rects.get(a.from) as Rect;
      const B = rects.get(a.to) as Rect;
      const cx = right + 30 + i * 16;
      const ya = A.y + A.h / 2;
      const yb = B.y + B.h / 2;
      routes.set(a.id, {
        pts: [
          [A.x + A.w + GAP, ya],
          [cx, ya],
          [cx, yb],
          [B.x + B.w + GAP, yb],
        ],
        label: [cx + 10, (ya + yb) / 2],
        align: "left",
      });
    });
  return { rects, extra, deco, width: GUTTER + ROW_W + 40 + 16 * routes.size, routes };
}

// --- arrow routing for grid boards: straight if free, else the shortest free elbow
function route(
  s: BoardState,
  rects: Map<string, Rect>,
  obstacles: Map<string, Rect>,
): Map<string, Route> {
  // Both ends must be laid out: a group without member boxes has no frame.
  const arrows = [...s.arrows.values()].filter((a) => rects.has(a.from) && rects.has(a.to));
  const all = [...obstacles.entries()]; // group frames are endpoints, never obstacles
  if (!all.length) return new Map();
  const hit = (pts: Point[], skip: string[]) => {
    for (let k = 0; k < pts.length - 1; k++) {
      const [p, q] = [pts[k] as Point, pts[k + 1] as Point];
      for (let t = 0; t <= 1; t += 1 / 50) {
        const x = p[0] + (q[0] - p[0]) * t;
        const y = p[1] + (q[1] - p[1]) * t;
        for (const [id, r] of all) {
          if (
            !skip.includes(id) &&
            x > r.x - 3 &&
            x < r.x + r.w + 3 &&
            y > r.y - 3 &&
            y < r.y + r.h + 3
          ) {
            return true;
          }
        }
      }
    }
    return false;
  };
  const len = (pts: Point[]) =>
    pts.slice(1).reduce((a, p, k) => {
      const prev = pts[k] as Point;
      return a + Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]);
    }, 0);
  const L = Math.min(...all.map(([, r]) => r.x));
  const R = Math.max(...all.map(([, r]) => r.x + r.w));
  const T = Math.min(...all.map(([, r]) => r.y));
  const B = Math.max(...all.map(([, r]) => r.y + r.h));
  // channels: the free space between boxes (and around everything) that elbows may run in
  const xs = [L - 40, R + 40];
  const ys = [T - 30, B + 30];
  for (const [, r] of all) {
    xs.push(r.x - 40, r.x + r.w + 40);
    ys.push(r.y - ROW_GAP / 2, r.y + r.h + ROW_GAP / 2);
  }
  const used = new Map<string, number>(); // channel usage → offset so parallel elbows don't coincide
  const bump = (key: string) => {
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    return n * 14;
  };

  const groups = new Map<string, ArrowDef[]>();
  for (const a of arrows) {
    const key = [a.from, a.to].sort().join("|");
    const g = groups.get(key) ?? [];
    g.push(a);
    groups.set(key, g);
  }
  const routes = new Map<string, Route>();
  for (const g of groups.values()) {
    g.forEach((a, i) => {
      const A = rects.get(a.from) as Rect;
      const Bx = rects.get(a.to) as Rect;
      const skip = [a.from, a.to];
      // round shapes: keep parallel arrows near the middle so they still hit the outline
      const f =
        A.shape || Bx.shape
          ? 0.5 + ((i + 1) / (g.length + 1) - 0.5) * 0.4
          : (i + 1) / (g.length + 1);
      const ca: Point = [A.x + A.w / 2, A.y + A.h / 2];
      const cb: Point = [Bx.x + Bx.w / 2, Bx.y + Bx.h / 2];
      const hs = [Math.max(A.x, Bx.x) + 20, Math.min(A.x + A.w, Bx.x + Bx.w) - 20] as const;
      const vs = [Math.max(A.y, Bx.y) + 12, Math.min(A.y + A.h, Bx.y + Bx.h) - 12] as const;
      let pts: Point[];
      let label: Point;
      let align: Align = "center";
      if (hs[1] > hs[0] && (A.y + A.h <= Bx.y || Bx.y + Bx.h <= A.y)) {
        const x = hs[0] + (hs[1] - hs[0]) * f;
        const down = A.y < Bx.y;
        pts = [
          [x, down ? A.y + A.h + GAP : A.y - GAP],
          [x, down ? Bx.y - GAP : Bx.y + Bx.h + GAP],
        ];
        const midY = ((pts[0] as Point)[1] + (pts[1] as Point)[1]) / 2;
        if (g.length > 1) {
          // parallel: labels on opposite sides
          label = [x + (i % 2 ? 8 : -8), midY];
          align = i % 2 ? "left" : "right";
        } else label = [x, midY];
      } else if (vs[1] > vs[0] && (A.x + A.w <= Bx.x || Bx.x + Bx.w <= A.x)) {
        const y = vs[0] + (vs[1] - vs[0]) * f;
        const right = A.x < Bx.x;
        pts = [
          [right ? A.x + A.w + GAP : A.x - GAP, y],
          [right ? Bx.x - GAP : Bx.x + Bx.w + GAP, y],
        ];
        label = [((pts[0] as Point)[0] + (pts[1] as Point)[0]) / 2, i % 2 ? y + 6 : y - 6];
        align = i % 2 ? "below" : "above";
      } else {
        const clip = (r: Rect, from: Point, to: Point): Point => {
          const c = [r.x + r.w / 2, r.y + r.h / 2] as const;
          const d = [to[0] - from[0], to[1] - from[1]] as const;
          const k = Math.min(
            Math.abs(r.w / 2 / d[0]) || Number.POSITIVE_INFINITY,
            Math.abs(r.h / 2 / d[1]) || Number.POSITIVE_INFINITY,
          );
          const l = Math.hypot(d[0], d[1]);
          return [c[0] + d[0] * k + (d[0] / l) * GAP, c[1] + d[1] * k + (d[1] / l) * GAP];
        };
        const d = [cb[0] - ca[0], cb[1] - ca[1]] as const;
        const l = Math.hypot(d[0], d[1]);
        const o = (i - (g.length - 1) / 2) * 22;
        const n = [(-d[1] / l) * o, (d[0] / l) * o] as const; // parallel arrows side by side
        pts = [clip(A, ca, cb), clip(Bx, cb, ca)].map((q): Point => [q[0] + n[0], q[1] + n[1]]);
        label = [
          ((pts[0] as Point)[0] + (pts[1] as Point)[0]) / 2,
          ((pts[0] as Point)[1] + (pts[1] as Point)[1]) / 2,
        ];
      }
      if (hit(pts, skip)) {
        const side = (r: Rect, x: number) => (x > r.x + r.w / 2 ? r.x + r.w + GAP : r.x - GAP);
        const end = (r: Rect, y: number) => (y > r.y + r.h / 2 ? r.y + r.h + GAP : r.y - GAP);
        type Cand = { key?: string; pts?: Point[]; mk?: (o: number) => Point[] };
        const cands: Cand[] = [];
        // L-shapes: leave sideways, enter from top/bottom — and the other way round
        cands.push({
          pts: [
            [side(A, cb[0]), ca[1]],
            [cb[0], ca[1]],
            [cb[0], end(Bx, ca[1])],
          ],
        });
        cands.push({
          pts: [
            [ca[0], end(A, cb[1])],
            [ca[0], cb[1]],
            [side(Bx, ca[0]), cb[1]],
          ],
        });
        for (const x of xs) {
          cands.push({
            key: `x${Math.round(x)}`,
            mk: (o) => [
              [side(A, x), ca[1]],
              [x + o, ca[1]],
              [x + o, cb[1]],
              [side(Bx, x), cb[1]],
            ],
          });
        }
        for (const y of ys) {
          cands.push({
            key: `y${Math.round(y)}`,
            mk: (o) => [
              [ca[0], end(A, y)],
              [ca[0], y + o],
              [cb[0], y + o],
              [cb[0], end(Bx, y)],
            ],
          });
        }
        const free = cands
          .map((c) => ({ ...c, pts: c.pts ?? (c.mk as (o: number) => Point[])(0) }))
          .filter((c) => !hit(c.pts, skip))
          .sort((p, q) => len(p.pts) - len(q.pts));
        const best = free[0];
        if (best) {
          pts = best.key && best.mk ? best.mk(bump(best.key)) : best.pts;
          // label on the longest segment: beside a vertical one, above a horizontal one
          const seg = (j: number) => {
            const p = pts[j] as Point;
            const q = pts[j + 1] as Point;
            return Math.hypot(q[0] - p[0], q[1] - p[1]);
          };
          let k = 0;
          for (let j = 1; j < pts.length - 1; j++) if (seg(j) > seg(k)) k = j;
          const p = pts[k] as Point;
          const q = pts[k + 1] as Point;
          if (p[0] === q[0]) {
            const outside = p[0] < (ca[0] + cb[0]) / 2; // channel left of the boxes → label further left
            label = [p[0] + (outside ? -10 : 10), (p[1] + q[1]) / 2];
            align = outside ? "right" : "left";
          } else {
            label = [(p[0] + q[0]) / 2, p[1] - 6];
            align = "above";
          }
        }
      }
      pts[0] = snap(A, pts[0] as Point, pts[1] as Point);
      pts[pts.length - 1] = snap(Bx, pts.at(-1) as Point, pts.at(-2) as Point);
      routes.set(a.id, { pts, label, align });
    });
  }
  return routes;
}

// move an arrow end that stops at the bounding box of an ellipse/diamond onward to the real outline
function snap(r: Rect, p: Point, q: Point): Point {
  if (!r.shape) return p;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const inside = ([x, y]: Point) =>
    r.shape === "ellipse"
      ? ((x - cx) / (r.w / 2)) ** 2 + ((y - cy) / (r.h / 2)) ** 2 <= 1
      : Math.abs(x - cx) / (r.w / 2) + Math.abs(y - cy) / (r.h / 2) <= 1;
  const l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
  const d = [(p[0] - q[0]) / l, (p[1] - q[1]) / l] as const;
  for (let t = 0; t < Math.max(r.w, r.h); t += 2) {
    const z: Point = [p[0] + d[0] * t, p[1] + d[1] * t];
    if (inside(z)) return [z[0] - d[0] * GAP, z[1] - d[1] * GAP];
  }
  return p;
}

const LAYOUTS = { grid: gridLayout, sequence: sequenceLayout, bits: bitsLayout };

/** The ids the latest call highlighted, with group members (what the marker paints). */
export function markedIds(s: BoardState): Set<string> {
  const marked = new Set(s.highlight);
  for (const g of s.groups.values()) {
    if (!marked.has(g.id)) continue;
    for (const x of s.boxes.values())
      if (x.board === g.board && isInside(s, x, g.id)) marked.add(x.id);
  }
  return marked;
}

/**
 * The element skeletons for the whole board. Highlight = a marker: a
 * highlighted box gets the marker fill and outline 3, a highlighted arrow or
 * group a marker patch behind its label and a stronger line; everything else
 * fades to 30% opacity, except what the same call added or changed.
 */
export function layout(s: BoardState): BoardElementSkeleton[] {
  const lit = new Set(s.highlight.length ? [...s.highlight, ...s.fresh] : []);
  for (const g of s.groups.values()) {
    if (!lit.has(g.id) || !groupCells(s, g)) continue;
    for (const x of s.boxes.values())
      if (x.board === g.board && isInside(s, x, g.id)) lit.add(x.id);
  }
  for (const id of s.highlight) {
    if (!s.boards.has(id)) continue;
    for (const x of s.boxes.values()) if (x.board === id) lit.add(x.id);
    for (const a of s.arrows.values()) if (lit.has(a.from)) lit.add(a.id);
  }
  const dim = (id: string) => (lit.size && !lit.has(id) ? { opacity: 30 } : {});
  const marked = markedIds(s);

  const per = new Map<string, BoardLayout & { x0: number }>();
  let x0 = 0;
  for (const b of s.boards.values()) {
    const r = LAYOUTS[b.kind](s, b, x0);
    per.set(b.id, { ...r, x0 });
    x0 += r.width + BOARD_GAP;
  }
  const layoutOf = (id: string) => {
    for (const p of per.values()) if (p.rects.has(id)) return p;
    return undefined;
  };

  const out: BoardElementSkeleton[] = [];
  const labels: BoardElementSkeleton[] = [];
  for (const id of s.order) {
    const board = s.boards.get(id);
    if (board) {
      const p = per.get(id);
      if (!p) continue;
      out.push({ type: "text", id, x: p.x0, y: 0, text: board.title, fontSize: 24, ...dim(id) });
      for (const d of p.deco) out.push({ ...d, ...dim(id) });
      for (const { id: gid, r } of p.frames ?? []) {
        const g = s.groups.get(gid);
        if (!g) continue;
        const tint = GROUP_TINT[g.color];
        // the label patch takes the nearest tinted ancestor's colour, so the frame line never shows through
        let under = "#ffffff";
        for (
          let q = g.in ? s.groups.get(g.in) : undefined;
          q;
          q = q.in ? s.groups.get(q.in) : undefined
        ) {
          if (GROUP_TINT[q.color] !== "transparent") {
            under = GROUP_TINT[q.color];
            break;
          }
        }
        out.push({
          type: "rectangle",
          id: gid,
          x: r.x,
          y: r.y,
          width: r.w,
          height: r.h,
          backgroundColor: tint,
          fillStyle: "solid",
          strokeColor: FRAME,
          strokeStyle: "dashed",
          strokeWidth: marked.has(gid) ? 2.5 : 1.5,
          roundness: { type: 3 },
          ...dim(gid),
        });
        out.push({
          type: "rectangle",
          id: `${gid}:label:bg`,
          x: r.x,
          y: r.y,
          width: 1,
          height: 1,
          backgroundColor: marked.has(gid) ? MARK : tint === "transparent" ? under : tint,
          strokeColor: "transparent",
          fillStyle: "solid",
          roughness: 0,
          ...dim(gid),
        });
        out.push({
          type: "text",
          id: `${gid}:label`,
          x: r.x,
          y: r.y,
          text: g.text,
          fontSize: 16,
          strokeColor: FRAME,
          customData: { anchor: [r.x + 12, r.y], align: "left" },
          ...dim(gid),
        });
      }
      continue;
    }
    if (s.groups.has(id)) continue; // drawn with its board, below everything else
    const b = s.boxes.get(id);
    if (b) {
      const p = layoutOf(id);
      const r = p?.rects.get(id);
      if (!p || !r) continue;
      const groupIds = [`${id}:group`];
      out.push({
        type: r.shape ?? "rectangle",
        id,
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
        label: { text: r.label ?? boxLines(b), fontSize: r.fontSize ?? 20 },
        backgroundColor: marked.has(id) ? MARK : COLORS[b.color],
        fillStyle: "solid",
        strokeColor: INK,
        strokeWidth: marked.has(id) ? 3 : 2,
        strokeStyle: r.dashed ? "dashed" : "solid",
        groupIds,
        ...dim(id),
      });
      for (const e of p.extra.get(id) ?? []) out.push({ ...e, groupIds, ...dim(id) });
      continue;
    }
    const a = s.arrows.get(id);
    if (!a) continue;
    const rt = layoutOf(a.from)?.routes.get(id);
    if (!rt) continue;
    const { pts, label, align } = rt;
    const first = pts[0] as Point;
    const last = pts.at(-1) as Point;
    const color = a.style === "problem" ? RED : INK;
    const rel = pts.map((q): Point => [q[0] - first[0], q[1] - first[1]]);
    const relLast = rel.at(-1) as Point;
    const groupIds = [`${id}:group`];
    out.push({
      type: "arrow",
      id,
      x: first[0],
      y: first[1],
      width: relLast[0] || 0.01,
      height: relLast[1],
      strokeColor: color,
      strokeWidth: a.style === "problem" ? 4 : marked.has(id) ? 3 : 2,
      ...dim(id),
      strokeStyle: a.style === "dashed" ? "dashed" : "solid",
      groupIds,
      customData: { points: rel },
      ...(a.style === "inherits"
        ? { endArrowhead: "triangle_outline" }
        : a.style === "has"
          ? { startArrowhead: "diamond", endArrowhead: null }
          : {}),
    });
    const text = [a.text, ...a.notes].filter(Boolean).join(" · ");
    if (text) {
      labels.push({
        type: "rectangle",
        id: `${id}:label:bg`,
        x: label[0],
        y: label[1],
        width: 1,
        height: 1,
        backgroundColor: marked.has(id) ? MARK : "#ffffff",
        strokeColor: "transparent",
        fillStyle: "solid",
        roughness: 0,
        groupIds,
        ...dim(id),
      });
      labels.push({
        type: "text",
        id: `${id}:label`,
        x: label[0],
        y: label[1],
        text: wrap(text, align === "above" && Math.abs(last[0] - first[0]) < 200 ? 14 : 26),
        fontSize: 16,
        strokeColor: color,
        groupIds,
        customData: { anchor: label, align },
        ...dim(id),
      });
    }
  }
  return [...out, ...labels];
}

/** The parts of an Excalidraw element `finish` reads and writes. */
export interface FinishableElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  containerId?: string | null;
  customData?: Record<string, unknown>;
  points?: readonly (readonly [number, number])[];
  roundness?: unknown;
}

/**
 * After Excalidraw has measured the text: real arrow/line points, placed
 * labels, sized label patches. Mutates and returns the converted elements.
 */
export function finish<T extends FinishableElement>(elements: T[]): T[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  for (const e of elements) {
    const container = e.containerId ? byId.get(e.containerId) : undefined;
    if (container) e.opacity = container.opacity; // box labels dim with their box
    const p = e.customData?.points as Point[] | undefined;
    if (p && (e.type === "arrow" || e.type === "line")) {
      e.points = p;
      const xs = p.map((q) => q[0]);
      const ys = p.map((q) => q[1]);
      e.width = Math.max(...xs) - Math.min(...xs);
      e.height = Math.max(...ys) - Math.min(...ys);
      if (p.length > 2) e.roundness = null;
    }
    const a = e.customData?.anchor as Point | undefined;
    if (a && e.type === "text") {
      const align = e.customData?.align as Align | undefined;
      e.x = align === "left" ? a[0] : align === "right" ? a[0] - e.width : a[0] - e.width / 2;
      e.y = align === "above" ? a[1] - e.height : align === "below" ? a[1] : a[1] - e.height / 2;
      const bg = byId.get(`${e.id}:bg`);
      if (bg)
        Object.assign(bg, { x: e.x - 4, y: e.y - 2, width: e.width + 8, height: e.height + 4 });
    }
  }
  return elements;
}
