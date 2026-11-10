// The tutor board's model: the `board` tool's step language → checks → a new
// board state. Pure data and pure functions — the tutor-tool catalog imports
// this module, so it sits inside the CLI prompt-dump grep-guard closure
// (docs/tutor-tools.md): no `app/**`, no DB, no Excalidraw.
//
// The model never chooses coordinates: it picks a board kind, grid cells, order
// or bit widths, colour names and arrow styles; `layout.ts` does all geometry.
// `apply` is all or nothing — structural problems are errors (nothing applied,
// the model fixes them and calls again), cosmetic ones (highlight or remove of
// an unknown id) are warnings on an applied call, because a retry costs a whole
// extra model round.

export const LIMITS = {
  boards: 3,
  rows: 5,
  cols: 4,
  actors: 6,
  elements: 40,
  text: 50,
  title: 70,
  notesPerBox: 3,
  groupDepth: 3,
  fieldBits: 1024,
} as const;

/** Box fills by colour name. */
export const COLORS = {
  blue: "#a5d8ff",
  green: "#b2f2bb",
  yellow: "#ffec99",
  red: "#ffc9c9",
  gray: "#e9ecef",
  white: "#ffffff",
} as const;

export type BoardColor = keyof typeof COLORS;
export const BOARD_KINDS = ["grid", "sequence", "bits"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];
const ROW_BITS = [8, 16, 32, 64];
export const ARROW_STYLES = ["normal", "problem", "dashed", "inherits", "has"] as const;
export type ArrowStyle = (typeof ARROW_STYLES)[number];
const SHAPES = ["rect", "ellipse", "diamond"] as const;
export type BoxShape = "ellipse" | "diamond";
const OPS = ["board", "group", "box", "arrow", "note", "change", "remove", "highlight"];
const ID = /^[a-z][a-z0-9-]{0,39}$/;

export interface BoardDef {
  id: string;
  title: string;
  kind: BoardKind;
  /** Bits per row (bits boards only). */
  rowBits?: number;
}

export interface GroupDef {
  id: string;
  board: string;
  text: string;
  color: BoardColor;
  in?: string;
}

export interface BoxDef {
  id: string;
  board: string;
  row?: number;
  col?: number;
  /** Field size (bits boards); undefined = variable length. */
  bits?: number;
  text: string;
  color: BoardColor;
  shape?: BoxShape;
  in?: string;
  notes: string[];
}

export interface ArrowDef {
  id: string;
  from: string;
  to: string;
  text?: string;
  style: ArrowStyle;
  notes: string[];
}

/** The whole board. Maps keep insertion order; `order` is the drawing order. */
export interface BoardState {
  boards: Map<string, BoardDef>;
  groups: Map<string, GroupDef>;
  boxes: Map<string, BoxDef>;
  arrows: Map<string, ArrowDef>;
  order: string[];
  /** Every id ever used (ids are never reused, not even after remove). */
  used: Set<string>;
  /** What the latest call highlighted. */
  highlight: string[];
  /** What the latest call added or changed. */
  fresh: string[];
  /** The board following steps default to. */
  current: string | null;
}

/** The tool's input as the model sends it; the checks below explain every mistake. */
export interface BoardInput {
  steps?: unknown;
}

export type ApplyResult =
  | { state: BoardState; warnings: string[]; errors?: undefined }
  | { errors: string[]; state?: undefined; warnings?: undefined };

export function emptyBoard(): BoardState {
  return {
    boards: new Map(),
    groups: new Map(),
    boxes: new Map(),
    arrows: new Map(),
    order: [],
    used: new Set(),
    highlight: [],
    fresh: [],
    current: null,
  };
}

const list = (m: Map<string, unknown>) => (m.size ? [...m.keys()].join(", ") : "(none)");
const json = (v: unknown) => JSON.stringify(v) ?? "undefined";
const isColor = (v: unknown): v is BoardColor => typeof v === "string" && v in COLORS;
const isStyle = (v: unknown): v is ArrowStyle =>
  typeof v === "string" && (ARROW_STYLES as readonly string[]).includes(v);

// One step after normalization: every field still unchecked.
type Step = Record<string, unknown>;

// Ids are case-insensitive ("Browser" finds "browser"); null means "not given";
// {"op":"ellipse"} is a box with that shape; a non-numeric "bits" means variable length.
function normalize(st: unknown): Step | undefined {
  if (!st || typeof st !== "object" || Array.isArray(st)) return undefined;
  const o: Step = { ...(st as Step) };
  for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
  if ((SHAPES as readonly unknown[]).includes(o.op)) {
    o.shape = o.op;
    o.op = "box";
  }
  for (const k of ["id", "board", "from", "to", "on", "in"]) {
    const v = o[k];
    if (typeof v === "string") o[k] = v.toLowerCase();
  }
  if (Array.isArray(o.ids)) o.ids = o.ids.map((v) => (typeof v === "string" ? v.toLowerCase() : v));
  if (o.bits !== undefined && typeof o.bits !== "number") delete o.bits;
  return o;
}

const cloneState = (s: BoardState): BoardState => structuredClone(s);

/**
 * Applies one `board` call. All or nothing: returns the new state plus warnings,
 * or only errors — never changes the input state.
 */
export function apply(state: BoardState, input: unknown): ApplyResult {
  const s = cloneState(state);
  const errors: string[] = [];
  const warnings: string[] = [];
  const steps = (input as BoardInput | null | undefined)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { errors: ['"steps" must be a non-empty array of steps'] };
  }
  s.highlight = [];
  s.fresh = [];
  const removed = new Set<string>(); // ids removed by an earlier step of this call
  const failed = new Set<unknown>(); // ids whose step failed in this call: later references stay quiet
  const count = () => s.boards.size + s.groups.size + s.boxes.size + s.arrows.size;

  steps.map(normalize).forEach((st, i) => {
    const op = st?.op;
    const at = `steps[${i}]${op ? ` (${String(op)}${st?.id ? ` "${String(st.id)}"` : ""})` : ""}`;
    const before = errors.length;
    let quiet = false;
    const err = (m: string): false => {
      errors.push(`${at}: ${m}`);
      return false;
    };
    const text = (
      v: unknown,
      field: string,
      { required = true, max = LIMITS.text as number } = {},
    ): v is string => {
      if (v === undefined && !required) return true;
      if (typeof v !== "string" || !v.trim()) return err(`"${field}" must be a non-empty string`);
      if (v.length > max) {
        return err(`"${field}" has ${v.length} characters; keep it to ${max} (a few words)`);
      }
      return true;
    };
    const newId = (id: unknown): id is string => {
      if (typeof id !== "string" || !ID.test(id)) {
        return err(
          `"id" must be lowercase letters, digits and dashes, starting with a letter (got ${json(id)})`,
        );
      }
      if (s.used.has(id))
        return err(`id "${id}" is already used; ids are never reused, pick a new one`);
      return true;
    };
    // A box (or, except for notes, a group) by id.
    const box = (id: unknown, field: string): BoxDef | GroupDef | null => {
      if (typeof id === "string") {
        const found = s.boxes.get(id) ?? (field !== "on" ? s.groups.get(id) : undefined);
        if (found) return found;
      }
      if (failed.has(id)) {
        quiet = true;
        return null;
      }
      const why =
        typeof id === "string" && removed.has(id)
          ? "was removed by an earlier step of this call"
          : `is not a ${field === "on" ? "box or arrow" : "box"} on the board`;
      err(`"${field}" refers to ${json(id)}, which ${why}. Existing boxes: ${list(s.boxes)}`);
      return null;
    };
    const int = (v: unknown, field: string, min: number, max: number): v is number => {
      if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) return true;
      return err(`"${field}" must be a whole number from ${min} to ${max} (got ${json(v)})`);
    };
    const color = (v: unknown): boolean =>
      v === undefined || isColor(v)
        ? true
        : err(`"color" must be one of ${Object.keys(COLORS).join(", ")} (got ${json(v)})`);
    // "in": a group on the same grid board
    const parent = (b: BoardDef, v: unknown): boolean => {
      if (v === undefined) return true;
      const g = typeof v === "string" ? s.groups.get(v) : undefined;
      if (g && g.board === b.id) return true;
      if (failed.has(v)) {
        quiet = true;
        return false;
      }
      const groups =
        [...s.groups.values()]
          .filter((x) => x.board === b.id)
          .map((x) => x.id)
          .join(", ") || "(none)";
      return err(
        `"in" refers to ${json(v)}, which is not a group on board "${b.id}". Groups: ${groups}`,
      );
    };
    const boardOf = (v: unknown) => (typeof v === "string" ? s.boards.get(v) : undefined);

    switch (st?.op) {
      case "board": {
        const kind = st.kind ?? "grid";
        // so following boxes of a failed board stay quiet (the clone is discarded on any error)
        s.current = typeof st.id === "string" ? st.id : null;
        const okId = newId(st.id);
        const okTitle = text(st.title, "title", { max: LIMITS.title });
        if (!(BOARD_KINDS as readonly unknown[]).includes(kind)) {
          err(`"kind" must be one of ${BOARD_KINDS.join(", ")} (got ${json(kind)})`);
          break;
        }
        if (kind === "bits" && st.bits !== undefined && !ROW_BITS.includes(st.bits as number)) {
          err(`"bits" (bits per row) must be one of ${ROW_BITS.join(", ")}`);
          break;
        }
        if (!okId || !okTitle) break;
        const id = st.id as string;
        if (s.boards.size >= LIMITS.boards) {
          err(`at most ${LIMITS.boards} boards side by side; remove one first`);
          break;
        }
        const k = kind as BoardKind;
        s.boards.set(id, {
          id,
          title: st.title as string,
          kind: k,
          ...(k === "bits" ? { rowBits: (st.bits as number | undefined) ?? 32 } : {}),
        });
        s.used.add(id);
        s.order.push(id);
        s.fresh.push(id);
        s.current = id;
        break;
      }
      case "group": {
        // a labelled frame around its members' cells (grid only); members join with "in"
        const ref = st.board ?? s.current;
        const b = boardOf(ref);
        if (!b) {
          if (failed.has(ref)) quiet = true;
          else err(`no such board ${json(ref)}`);
          break;
        }
        if (b.kind !== "grid") {
          err(`groups only exist on grid boards ("${b.id}" is a ${b.kind} board)`);
          break;
        }
        const ok = [newId(st.id), text(st.text, "text"), color(st.color), parent(b, st.in)];
        if (!ok.every(Boolean)) break;
        let depth = 1;
        for (let g = s.groups.get(st.in as string); g; g = g.in ? s.groups.get(g.in) : undefined) {
          depth++;
        }
        if (depth > LIMITS.groupDepth) {
          err(`groups nest at most ${LIMITS.groupDepth} deep`);
          break;
        }
        const id = st.id as string;
        s.groups.set(id, {
          id,
          board: b.id,
          text: st.text as string,
          color: (st.color as BoardColor | undefined) ?? "white",
          ...(st.in !== undefined ? { in: st.in as string } : {}),
        });
        s.used.add(id);
        s.order.push(id);
        s.fresh.push(id);
        s.current = b.id;
        break;
      }
      case "box": {
        const boardId = st.board ?? s.current;
        const b = boardOf(boardId);
        if (!b) {
          if (failed.has(boardId)) {
            quiet = true;
            break;
          }
          err(
            boardId === undefined || boardId === null
              ? `no board yet: start with {"op":"board"}`
              : `"board" refers to ${json(boardId)}, which does not exist. Existing boards: ${list(s.boards)}`,
          );
          break;
        }
        const ok: boolean[] = [newId(st.id), text(st.text, "text"), color(st.color)];
        if (st.shape !== undefined && !(SHAPES as readonly unknown[]).includes(st.shape)) {
          ok.push(err(`"shape" must be one of ${SHAPES.join(", ")} (got ${json(st.shape)})`));
        }
        if (st.in !== undefined && b.kind !== "grid") {
          ok.push(err(`"in" (groups) only works on grid boards`));
        } else ok.push(parent(b, st.in));
        if (b.kind === "grid") {
          ok.push(int(st.row, "row", 0, LIMITS.rows - 1), int(st.col, "col", 0, LIMITS.cols - 1));
          if (ok.every(Boolean)) {
            const taken = [...s.boxes.values()].find(
              (x) => x.board === b.id && x.row === st.row && x.col === st.col,
            );
            if (taken) {
              err(
                `row ${String(st.row)}, col ${String(st.col)} on board "${b.id}" is already taken by "${taken.id}"; pick a free cell`,
              );
              break;
            }
          }
        } else if (b.kind === "sequence") {
          const n = [...s.boxes.values()].filter((x) => x.board === b.id).length;
          if (n >= LIMITS.actors) {
            err(`a sequence board has at most ${LIMITS.actors} boxes (participants)`);
            break;
          }
        } else if (st.bits !== undefined && st.bits !== 0) {
          ok.push(int(st.bits, "bits", 1, LIMITS.fieldBits));
        }
        if (!ok.every(Boolean)) break;
        const id = st.id as string;
        const shape =
          b.kind === "grid" && st.shape !== undefined && st.shape !== "rect"
            ? (st.shape as BoxShape)
            : undefined;
        const bits = (st.bits as number | undefined) || undefined;
        s.boxes.set(id, {
          id,
          board: b.id,
          ...(b.kind === "grid" ? { row: st.row as number, col: st.col as number } : {}),
          ...(bits !== undefined ? { bits } : {}),
          text: st.text as string,
          color: (st.color as BoardColor | undefined) ?? "white",
          ...(shape ? { shape } : {}),
          ...(st.in !== undefined ? { in: st.in as string } : {}),
          notes: [],
        });
        s.used.add(id);
        s.order.push(id);
        s.fresh.push(id);
        s.current = b.id;
        break;
      }
      case "arrow": {
        let id = st.id;
        if (id === undefined && typeof st.from === "string" && typeof st.to === "string") {
          const base = `${st.from}-${st.to}`.slice(0, 36);
          id = base;
          for (let k = 2; s.used.has(id as string); k++) id = `${base}-${k}`;
        }
        const ok = [newId(id), text(st.text, "text", { required: false })].every(Boolean);
        const a = box(st.from, "from");
        const b = box(st.to, "to");
        if (st.style !== undefined && !isStyle(st.style)) {
          err(`"style" must be one of ${ARROW_STYLES.join(", ")} (got ${json(st.style)})`);
          break;
        }
        if (!ok || !a || !b) break;
        if (a.board !== b.board) {
          err(
            `arrows connect boxes on the same board; "${a.id}" is on "${a.board}", "${b.id}" on "${b.board}"`,
          );
          break;
        }
        if (!("notes" in a) && (st.style === "inherits" || st.style === "has")) {
          err(`"${st.style}" arrows connect boxes, not groups`);
          break;
        }
        if (a === b && s.boards.get(a.board)?.kind !== "sequence") {
          err(`"from" and "to" are the same box "${a.id}" (only allowed on a sequence board)`);
          break;
        }
        const arrowId = id as string;
        s.arrows.set(arrowId, {
          id: arrowId,
          from: a.id,
          to: b.id,
          ...(st.text !== undefined ? { text: st.text as string } : {}),
          style: (st.style as ArrowStyle | undefined) ?? "normal",
          notes: [],
        });
        s.used.add(arrowId);
        s.order.push(arrowId);
        s.fresh.push(arrowId);
        break;
      }
      case "note": {
        // an extra line inside a box, or under an arrow's label
        const target: BoxDef | GroupDef | ArrowDef | null =
          (typeof st.on === "string" ? s.arrows.get(st.on) : undefined) ?? box(st.on, "on");
        if (!text(st.text, "text") || !target) break;
        if (!("notes" in target)) {
          err(`"on" must be a box or an arrow, not a group`);
          break;
        }
        if (target.notes.length >= LIMITS.notesPerBox) {
          err(`box "${target.id}" already has ${LIMITS.notesPerBox} notes`);
          break;
        }
        target.notes.push(st.text);
        break;
      }
      case "change": {
        // restyle in place: box text/color/group, arrow text/style, board title (no moving)
        const id = typeof st.id === "string" ? st.id : "";
        const boxDef = s.boxes.get(id);
        const group = s.groups.get(id);
        const arrow = s.arrows.get(id);
        const board = s.boards.get(id);
        const target = boxDef ?? group ?? arrow ?? board;
        if (!target) {
          err(
            `unknown id ${json(st.id)}${removed.has(id) ? " (removed by an earlier step)" : ""}. On the board: ${s.order.join(", ") || "(nothing)"}`,
          );
          break;
        }
        const isBox = Boolean(boxDef ?? group);
        const allowed = isBox
          ? ["text", "color", ...(boxDef ? ["in"] : [])]
          : arrow
            ? ["text", "style"]
            : ["title"];
        const extra = Object.keys(st).filter((k) => !["op", "id", ...allowed].includes(k));
        if (extra.length) {
          err(
            `can only change ${allowed.join(", ")} of a ${isBox ? "box" : arrow ? "arrow" : "board"} (got ${extra.join(", ")}); to move something, remove it and draw it again`,
          );
          break;
        }
        const container = boxDef ?? group;
        const containerBoard = container ? s.boards.get(container.board) : undefined;
        const ok = [
          st.in === undefined || (containerBoard ? parent(containerBoard, st.in) : false),
          st.text === undefined || text(st.text, "text"),
          st.title === undefined || text(st.title, "title", { max: LIMITS.title }),
          color(st.color),
        ];
        if (st.style !== undefined && !isStyle(st.style)) {
          err(`"style" must be one of ${ARROW_STYLES.join(", ")} (got ${json(st.style)})`);
          break;
        }
        if (!ok.every(Boolean)) break;
        const patch = Object.fromEntries(
          allowed.filter((k) => st[k] !== undefined).map((k) => [k, st[k]]),
        );
        Object.assign(target, patch);
        s.fresh.push(id);
        break;
      }
      case "remove":
      case "highlight": {
        if (!Array.isArray(st.ids) || st.ids.length === 0) {
          err(`"ids" must be a non-empty array of ids`);
          break;
        }
        const known = (v: unknown): v is string =>
          typeof v === "string" &&
          (s.boards.has(v) || s.groups.has(v) || s.boxes.has(v) || s.arrows.has(v));
        const unknown = (st.ids as unknown[]).filter((v) => !known(v) && !failed.has(v));
        if (unknown.length) {
          const named = unknown
            .map((u) =>
              typeof u === "string" && removed.has(u)
                ? `"${u}" (removed by an earlier step)`
                : `"${String(u)}"`,
            )
            .join(", ");
          warnings.push(`${at}: ignored ${named}; not on the board`);
        }
        const ids = (st.ids as unknown[]).filter(known);
        if (st.op === "highlight") {
          s.highlight.push(...ids);
          break;
        }
        for (const id of ids) {
          removed.add(id);
          s.boards.delete(id);
          // removing a group removes only its frame; members move up one level
          const g = s.groups.get(id);
          if (g) {
            s.groups.delete(id);
            for (const m of [...s.boxes.values(), ...s.groups.values()]) {
              if (m.in === id) {
                if (g.in) m.in = g.in;
                else delete m.in;
              }
            }
          }
          for (const x of [...s.groups.values()]) {
            if (!s.boards.has(x.board)) {
              s.groups.delete(x.id);
              removed.add(x.id);
            }
          }
          for (const b of [...s.boxes.values()]) {
            if (b.id === id || !s.boards.has(b.board)) {
              s.boxes.delete(b.id);
              removed.add(b.id);
            }
          }
        }
        const end = (id: string) => s.boxes.has(id) || s.groups.has(id);
        for (const a of [...s.arrows.values()]) {
          if (ids.includes(a.id) || !end(a.from) || !end(a.to)) {
            s.arrows.delete(a.id);
            removed.add(a.id);
          }
        }
        s.order = s.order.filter(
          (id) => s.boards.has(id) || s.groups.has(id) || s.boxes.has(id) || s.arrows.has(id),
        );
        if (s.current === null || !s.boards.has(s.current)) {
          s.current = [...s.boards.keys()].at(-1) ?? null;
        }
        break;
      }
      default:
        err(`unknown op ${json(st?.op)}; use one of ${OPS.join(", ")}`);
    }
    const own =
      st?.op === "arrow" && st.id === undefined && typeof st.from === "string"
        ? `${st.from}-${String(st.to)}`.slice(0, 36)
        : st?.id;
    if ((errors.length > before || quiet) && typeof own === "string") failed.add(own);
    if (count() > LIMITS.elements) {
      err(`the board would have more than ${LIMITS.elements} elements; remove something first`);
    }
  });

  if (!errors.length) errors.push(...checkGroups(s));
  return errors.length ? { errors } : { state: s, warnings };
}

/** Whether `x` sits (directly or nested) inside group `groupId`. */
export function isInside(s: BoardState, x: { in?: string }, groupId: string): boolean {
  for (let p = x.in; p; p = s.groups.get(p)?.in) if (p === groupId) return true;
  return false;
}

export interface GroupCells {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

// A group's frame spans the cells of all its (nested) member boxes.
export function groupCells(s: BoardState, g: GroupDef): GroupCells | null {
  const boxes = [...s.boxes.values()].filter((x) => x.board === g.board && isInside(s, x, g.id));
  if (!boxes.length) return null;
  const r = boxes.map((x) => x.row ?? 0);
  const c = boxes.map((x) => x.col ?? 0);
  return { r0: Math.min(...r), r1: Math.max(...r), c0: Math.min(...c), c1: Math.max(...c) };
}

// A frame must not swallow a non-member box, and two groups' frames may only
// overlap when one is inside the other.
function checkGroups(s: BoardState): string[] {
  const errors: string[] = [];
  const cells = new Map<string, GroupCells>();
  for (const g of s.groups.values()) {
    const c = groupCells(s, g);
    if (c) cells.set(g.id, c);
  }
  const within = (c: GroupCells, x: BoxDef) =>
    (x.row ?? 0) >= c.r0 && (x.row ?? 0) <= c.r1 && (x.col ?? 0) >= c.c0 && (x.col ?? 0) <= c.c1;
  const nested = (a: string, b: string) => {
    for (let p = s.groups.get(a)?.in; p; p = s.groups.get(p)?.in) if (p === b) return true;
    return false;
  };
  for (const [id, c] of cells) {
    const g = s.groups.get(id);
    if (!g) continue;
    for (const x of s.boxes.values()) {
      if (x.board === g.board && within(c, x) && !isInside(s, x, id)) {
        errors.push(
          `group "${id}" spans rows ${c.r0}–${c.r1}, cols ${c.c0}–${c.c1} and would enclose box "${x.id}" (row ${x.row}, col ${x.col}), which is not in it: move one of them or set "in":"${id}" on the box`,
        );
      }
    }
    for (const [id2, c2] of cells) {
      if (id2 <= id || s.groups.get(id2)?.board !== g.board) continue;
      const overlap = c.r0 <= c2.r1 && c2.r0 <= c.r1 && c.c0 <= c2.c1 && c2.c0 <= c.c1;
      if (overlap && !nested(id, id2) && !nested(id2, id)) {
        errors.push(
          `groups "${id}" and "${id2}" overlap (rows ${c.r0}–${c.r1}/${c2.r0}–${c2.r1}, cols ${c.c0}–${c.c1}/${c2.c0}–${c2.c1}); put their boxes in separate cells or nest one group "in" the other`,
        );
      }
    }
  }
  return errors;
}

/** What the tool returns to the model after a successful call: compact, ids first. */
export function summary(s: BoardState): string {
  const lines: string[] = [];
  for (const b of s.boards.values()) {
    const boxes = [...s.boxes.values()].filter((x) => x.board === b.id);
    const pos = (x: BoxDef) =>
      b.kind === "grid"
        ? ` r${x.row}c${x.col}`
        : b.kind === "bits"
          ? x.bits
            ? ` ${x.bits}b`
            : " var"
          : "";
    lines.push(
      `board ${b.id} (${b.kind}): ${boxes.map((x) => x.id + pos(x)).join(", ") || "empty"}`,
    );
    const groups = [...s.groups.values()].filter((g) => g.board === b.id);
    if (groups.length) {
      const members = (g: GroupDef) =>
        [...s.groups.values(), ...s.boxes.values()]
          .filter((m) => m.in === g.id)
          .map((m) => m.id)
          .join(" ");
      lines.push(`  groups: ${groups.map((g) => `${g.id}{${members(g)}}`).join(", ")}`);
    }
    const arrows = [...s.arrows.values()].filter(
      (a) => (s.boxes.get(a.from) ?? s.groups.get(a.from))?.board === b.id,
    );
    if (arrows.length) {
      lines.push(
        `  arrows: ${arrows.map((a) => `${a.id}${a.style !== "normal" ? ` [${a.style}]` : ""}`).join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

/** Replays successful calls in order onto an empty board (a failing call is skipped). */
export function replay(calls: readonly unknown[]): BoardState {
  let s = emptyBoard();
  for (const call of calls) {
    const r = apply(s, call);
    if (r.state) s = r.state;
  }
  return s;
}
