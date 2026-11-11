"use client";

import { useAgent, useRenderTool } from "@copilotkit/react-core/v2";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import {
  BOARD_TOOL_NAME,
  type BoardPillLabel,
  boardCallsFromAgui,
  boardPillLabels,
  changeStatus,
  describeBoard,
  replay,
} from "@/lib/board";
import { cn } from "@/lib/utils";
import { BoardImageStack } from "./board-image";
import {
  type Camera,
  fitCamera,
  focusCamera,
  INITIAL_SHEET,
  nextZoom,
  type SheetEvent,
  type Size,
  sheetReducer,
} from "./sheet";
import { type BoardImageLayer, useBoardImage } from "./use-board-image";

// The tutor's board pane (docs/tutor-board.md): the drawing the `board` tool
// makes, beside the chat on laptops and docked above it on phones. It is DERIVED
// from the chat's message list — the replay of the `board` calls whose results
// say `ok: true`, live and after a reload alike — and never keeps its own copy.
// Rendered inside the CopilotKit provider (ModuleChat's `frame`), so Start over
// (a provider remount) empties it.

/** The largest scale a fitted drawing gets: a small board stays crisp instead of being blown up. */
const FIT_MAX = 1.1;

/** Tailwind's `md` (48rem): beside the chat at and above it, docked above it below. */
const WIDE_QUERY = "(min-width: 48rem)";

interface BoardContextValue {
  pills: Map<string, BoardPillLabel>;
  openBoard: () => void;
}

const BoardContext = createContext<BoardContextValue | null>(null);

/** The chat marker for one `board` call (null for a rejected call or a later call of the same reply). */
function BoardPill({ toolCallId }: { toolCallId: string }) {
  const ctx = useContext(BoardContext);
  const label = ctx?.pills.get(toolCallId);
  if (!ctx || !label) return null;
  return (
    <button
      type="button"
      data-testid="board-pill"
      onClick={ctx.openBoard}
      className="my-1 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-foreground/25 bg-background px-3 text-foreground/70 text-xs hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
    >
      <span aria-hidden="true">▦</span>
      {label}
    </button>
  );
}

const anyParameters = z.looseObject({});

function useWide(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return wide;
}

/** The board derived from the chat's messages: state, its key, and the status line. */
function useBoardFromMessages() {
  const { agent } = useAgent({ agentId: "tutor" });
  const messages = agent.messages;
  const calls = boardCallsFromAgui(messages);
  const key = calls.map((c) => c.id).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the calls.
  const pills = useMemo(() => boardPillLabels(messages), [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the calls.
  const derived = useMemo(() => {
    if (calls.length === 0) return null;
    const inputs = calls.map((c) => c.input);
    const state = replay(inputs);
    const prev = calls.length > 1 ? replay(inputs.slice(0, -1)) : null;
    return { state, status: changeStatus(prev, state), alt: describeBoard(state) };
  }, [key]);
  const sent = messages.filter((m) => m.role === "user").length;
  return { key, derived, pills, sent };
}

/**
 * Wraps the chat: lays the board out next to (or above) it once there is one.
 * Without a board the chat renders exactly as before.
 */
export function BoardFrame({ children }: { children: ReactNode }) {
  const wide = useWide();
  const { key, derived, pills, sent } = useBoardFromMessages();
  const { layers, current } = useBoardImage(derived?.state ?? null, key);
  const [collapsed, setCollapsed] = useState(false);
  const [laptopFull, setLaptopFull] = useState(false);
  const [railUnseen, setRailUnseen] = useState(false);
  const [sheet, dispatch] = useReducer(sheetReducer, INITIAL_SHEET);
  const [announcement, setAnnouncement] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Each change of the board: the sheet rules, the rail's dot, the announcement.
  const firstKey = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per board change only.
  useEffect(() => {
    if (!key) {
      dispatch({ type: "cleared" });
      setLaptopFull(false);
      return;
    }
    dispatch({ type: "changed" });
    if (firstKey.current) {
      firstKey.current = false;
    } else {
      setRailUnseen((u) => u || collapsed);
    }
    if (derived) setAnnouncement(`Board updated: ${derived.status}`);
  }, [key]);

  // Phones: tapping into the message field tucks the sheet (the keyboard takes
  // half the screen); leaving it or sending brings it back. Only a focus that
  // follows the student's tap counts — the chat refocuses its field by itself
  // after a send, and that must not tuck the board away again.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || wide) return;
    const isField = (t: EventTarget | null) => t instanceof HTMLTextAreaElement;
    let tappedAt = 0;
    const onDown = (e: PointerEvent) => {
      if (isField(e.target)) tappedAt = Date.now();
    };
    const onIn = (e: FocusEvent) => {
      if (isField(e.target) && Date.now() - tappedAt < 1000) dispatch({ type: "inputFocus" });
    };
    const onOut = (e: FocusEvent) => isField(e.target) && dispatch({ type: "inputBlur" });
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
    };
  }, [wide]);
  // A sent message ends the tuck.
  // biome-ignore lint/correctness/useExhaustiveDependencies: per sent message.
  useEffect(() => dispatch({ type: "inputBlur" }), [sent]);

  // State setters and dispatch are stable, so the marker's handler is too.
  const openBoard = useCallback(() => {
    setCollapsed(false);
    setRailUnseen(false);
    dispatch({ type: "open" });
  }, []);
  const ctx = useMemo(() => ({ pills, openBoard }), [pills, openBoard]);

  useRenderTool(
    {
      name: BOARD_TOOL_NAME,
      parameters: anyParameters,
      render: ({ toolCallId, status }) =>
        status === "complete" ? <BoardPill toolCallId={toolCallId} /> : null,
    },
    [],
  );

  const hasBoard = derived !== null;
  const status = current ? (derived?.status ?? "") : "Drawing…";
  const alt = derived?.alt ?? "";

  return (
    <BoardContext.Provider value={ctx}>
      <div
        ref={rootRef}
        data-testid="board-frame"
        className="flex min-h-0 flex-1 flex-col md:flex-row"
      >
        <p className="sr-only" aria-live="polite" data-testid="board-announcement">
          {announcement}
        </p>
        {hasBoard && !wide ? (
          <PhoneSheet
            sheet={sheet}
            dispatch={dispatch}
            layers={layers}
            current={current}
            status={status}
            alt={alt}
          />
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {hasBoard && wide ? (
          collapsed ? (
            <BoardRail
              unseen={railUnseen}
              onOpen={() => {
                setCollapsed(false);
                setRailUnseen(false);
              }}
            />
          ) : (
            <LaptopPane
              layers={layers}
              current={current}
              status={status}
              alt={alt}
              onCollapse={() => setCollapsed(true)}
              onOpenFull={() => setLaptopFull(true)}
            />
          )
        ) : null}
        {hasBoard && wide && laptopFull ? (
          <FullScreenBoard
            testId="board-fullscreen"
            layers={layers}
            current={current}
            status={status}
            alt={alt}
            autoScale={(fit) => Math.min(fit, FIT_MAX)}
            onClose={() => setLaptopFull(false)}
          />
        ) : null}
      </div>
    </BoardContext.Provider>
  );
}

const PANE_HEADING = "font-semibold text-sm";
const PANE_STATUS = "truncate text-foreground/65 text-xs";
const ZOOM_BUTTON =
  "inline-flex h-7 min-w-7 shrink-0 cursor-pointer items-center justify-center rounded-full px-1.5 font-semibold text-sm hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 disabled:cursor-default disabled:text-foreground/30 disabled:hover:bg-transparent";
const TOOL =
  "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full border border-foreground/25 bg-background px-3 font-semibold text-xs hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";

function LaptopPane({
  layers,
  current,
  status,
  alt,
  onCollapse,
  onOpenFull,
}: {
  layers: BoardImageLayer[];
  current: BoardImageLayer | null;
  status: string;
  alt: string;
  onCollapse: () => void;
  onOpenFull: () => void;
}) {
  return (
    <section
      aria-label="Board"
      data-testid="board-pane"
      className="flex min-h-0 min-w-0 flex-[1.35] flex-col border-foreground/15 border-l bg-canvas"
    >
      <header className="flex shrink-0 items-center gap-3 px-4 py-2">
        <h2 className={PANE_HEADING}>Board</h2>
        <p className={cn(PANE_STATUS, "flex-1")} data-testid="board-status">
          {status}
        </p>
        <button
          type="button"
          className={TOOL}
          onClick={onOpenFull}
          aria-label="Show board full screen"
          title="Full screen"
          data-testid="board-full"
        >
          ⤢
        </button>
        <button
          type="button"
          className={TOOL}
          onClick={onCollapse}
          aria-label="Hide board"
          title="Hide board"
          data-testid="board-collapse"
        >
          ›
        </button>
      </header>
      <div className="mx-4 mb-4 flex min-h-0 flex-1 overflow-hidden rounded-lg border border-foreground/15 bg-white">
        {current ? (
          <ZoomBoard
            layers={layers}
            current={current}
            alt={alt}
            autoScale={(fit) => Math.min(fit, FIT_MAX)}
          />
        ) : (
          <div className="h-full flex-1" aria-busy="true" />
        )}
      </div>
    </section>
  );
}

function BoardRail({ unseen, onOpen }: { unseen: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={unseen ? "Show board (changed)" : "Show board"}
      data-testid="board-rail"
      className="relative flex w-11 shrink-0 cursor-pointer flex-col items-center gap-3 border-foreground/15 border-l bg-canvas pt-3 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
    >
      <span aria-hidden="true" className="font-semibold text-sm">
        ‹
      </span>
      <span className="font-semibold text-xs [writing-mode:vertical-rl]">Board</span>
      {unseen ? (
        <span
          data-testid="board-unseen"
          aria-hidden="true"
          className="absolute top-2 right-2 size-2 rounded-full bg-foreground"
        />
      ) : null}
    </button>
  );
}

/** Tracks an element's size. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function PhoneSheet({
  sheet,
  dispatch,
  layers,
  current,
  status,
  alt,
}: {
  sheet: typeof INITIAL_SHEET;
  dispatch: (e: SheetEvent) => void;
  layers: BoardImageLayer[];
  current: BoardImageLayer | null;
  status: string;
  alt: string;
}) {
  const [zoomed, setZoomed] = useState(true);
  // A new highlight zooms in again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: per new image.
  useEffect(() => setZoomed(true), [current?.key]);

  if (sheet.state === "hidden") return null;

  if (sheet.state === "peek") {
    return (
      <section
        aria-label="Board"
        data-testid="board-sheet"
        data-state="peek"
        className="flex h-[60px] shrink-0 items-center gap-3 border-foreground/15 border-b bg-canvas px-4"
      >
        <div className="relative h-10 w-14 shrink-0 overflow-hidden rounded border border-foreground/15 bg-white">
          {current ? (
            // biome-ignore lint/performance/noImgElement: a blob: URL thumbnail.
            <img src={current.url} alt="" className="h-full w-full object-cover object-left-top" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <p className={PANE_HEADING}>
            Board
            {sheet.unseen ? (
              <>
                <span
                  data-testid="board-unseen"
                  aria-hidden="true"
                  className="ml-1.5 inline-block size-2 rounded-full bg-foreground align-middle"
                />
                <span className="sr-only"> (changed)</span>
              </>
            ) : null}
          </p>
          <p className={PANE_STATUS} data-testid="board-status">
            {status}
          </p>
        </div>
        <button
          type="button"
          className={TOOL}
          onClick={() => dispatch({ type: "open" })}
          data-testid="board-show"
        >
          Show
        </button>
      </section>
    );
  }

  if (sheet.state === "full") {
    return (
      <FullScreenBoard
        testId="board-sheet"
        dataState="full"
        layers={layers}
        current={current}
        status={status}
        alt={alt}
        // A phone opens the drawing at a readable scale and scrolls to the highlight.
        autoScale={(fit) => Math.min(1, Math.max(0.9, fit))}
        onClose={() => dispatch({ type: "closeFull" })}
      />
    );
  }

  return (
    <section
      aria-label="Board"
      data-testid="board-sheet"
      data-state={sheet.state}
      className="flex shrink-0 basis-[46%] flex-col border-foreground/15 border-b bg-canvas"
    >
      <header className="flex shrink-0 items-center gap-2 px-4 py-2">
        <h2 className={PANE_HEADING}>Board</h2>
        <p className={cn(PANE_STATUS, "flex-1")} data-testid="board-status">
          {status}
        </p>
        <button
          type="button"
          className={TOOL}
          onClick={() => dispatch({ type: "full" })}
          aria-label="Show board full screen"
          data-testid="board-full"
        >
          ⤢
        </button>
        <button
          type="button"
          className={TOOL}
          onClick={() => dispatch({ type: "collapse" })}
          aria-label="Hide board"
          data-testid="board-collapse"
        >
          ⌃
        </button>
      </header>
      <CameraBoard
        layers={layers}
        current={current}
        alt={alt}
        zoomed={zoomed}
        onToggleZoom={() => setZoomed((z) => !z)}
        onOpenFull={() => dispatch({ type: "full" })}
      />
    </section>
  );
}

/**
 * The half sheet: the whole board, or framed on the highlight with an animated
 * camera. The "Whole board" / "Zoom to highlight" pill shows only when the two
 * framings really differ. Tapping the drawing opens the full view; the image
 * stays outside that button so its alt text is read.
 */
function CameraBoard({
  layers,
  current,
  alt,
  zoomed,
  onToggleZoom,
  onOpenFull,
}: {
  layers: BoardImageLayer[];
  current: BoardImageLayer | null;
  alt: string;
  zoomed: boolean;
  onToggleZoom: () => void;
  onOpenFull: () => void;
}) {
  const [ref, view] = useSize<HTMLDivElement>();
  let whole: Camera = { x: 0, y: 0, scale: 1 };
  let focused: Camera | null = null;
  if (current && view.w > 0) {
    const image = { w: current.width, h: current.height };
    whole = fitCamera(view, image, FIT_MAX);
    if (current.focus) focused = focusCamera(view, image, current.focus, { maxScale: FIT_MAX });
  }
  const canZoom =
    focused !== null &&
    (Math.abs(focused.scale - whole.scale) > 0.02 ||
      Math.abs(focused.x - whole.x) > 4 ||
      Math.abs(focused.y - whole.y) > 4);
  const camera = zoomed && canZoom && focused ? focused : whole;
  return (
    <div
      ref={ref}
      data-testid="board-camera"
      className="relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-lg border border-foreground/15 bg-white"
    >
      {current ? (
        <div
          data-testid="board-camera-frame"
          className="absolute top-0 left-0 origin-top-left transition-transform duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: current.width,
            height: current.height,
            transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
          }}
        >
          <BoardImageStack layers={layers} alt={alt} fit="fill" />
        </div>
      ) : null}
      <button
        type="button"
        onClick={onOpenFull}
        aria-label="Show board full screen"
        className="absolute inset-0 cursor-zoom-in focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      />
      {canZoom ? (
        <button
          type="button"
          className={cn(TOOL, "absolute bottom-2 left-2")}
          onClick={onToggleZoom}
          data-testid="board-zoom-toggle"
        >
          {zoomed ? "Whole board" : "Zoom to highlight"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Full screen, on laptops and phones: the board covers the app, with the
 * zoomable drawing. ✕ or Escape closes it.
 */
function FullScreenBoard({
  testId,
  dataState,
  layers,
  current,
  status,
  alt,
  autoScale,
  onClose,
}: {
  testId: string;
  dataState?: string;
  layers: BoardImageLayer[];
  current: BoardImageLayer | null;
  status: string;
  alt: string;
  autoScale: (fit: number) => number;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);
  return (
    <section
      aria-label="Board"
      data-testid={testId}
      data-state={dataState}
      className="fixed inset-0 z-50 flex flex-col bg-canvas"
    >
      <header className="flex shrink-0 items-center gap-2 px-4 py-2">
        {/* Close sits first: the top-right corner is where floating overlays
            (CopilotKit's dev inspector, browser UI) tend to land. */}
        <button
          ref={closeRef}
          type="button"
          className={TOOL}
          onClick={onClose}
          aria-label="Close board"
          title="Close (Esc)"
          data-testid="board-close"
        >
          ✕
        </button>
        <h2 className={PANE_HEADING}>Board</h2>
        <p className={cn(PANE_STATUS, "flex-1")} data-testid="board-status">
          {status}
        </p>
      </header>
      <div className="flex min-h-0 flex-1 bg-white">
        {current ? (
          <ZoomBoard layers={layers} current={current} alt={alt} autoScale={autoScale} />
        ) : null}
      </div>
    </section>
  );
}

/** Space around the drawing inside its scroll area. */
const ZOOM_PAD = 12;

/**
 * The drawing in a scroll area with − / percentage / + buttons. Until the
 * student zooms it shows `autoScale(fit)`, where `fit` shows the whole drawing;
 * the percentage button goes back to that. Zooming keeps the point in the middle
 * of the view in place — or, from the whole drawing, moves to the highlight.
 * A chosen zoom survives the tutor's changes; a new highlight out of view is
 * scrolled into it.
 */
function ZoomBoard({
  layers,
  current,
  alt,
  autoScale,
}: {
  layers: BoardImageLayer[];
  current: BoardImageLayer;
  alt: string;
  autoScale: (fit: number) => number;
}) {
  const [ref, view] = useSize<HTMLDivElement>();
  const contentRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const ready = view.w > 0;
  const image = { w: current.width, h: current.height };
  const inner = { w: view.w - 2 * ZOOM_PAD, h: view.h - 2 * ZOOM_PAD };
  const fit = ready ? fitCamera(inner, image, Number.POSITIVE_INFINITY).scale : 1;
  const auto = autoScale(fit);
  const scale = zoom ?? auto;
  const lowest = Math.min(fit, auto);
  const zoomIn = nextZoom(scale, lowest, "in");
  const zoomOut = nextZoom(scale, lowest, "out");

  const zoomTo = (next: number | null) => {
    const el = ref.current;
    const content = contentRef.current;
    if (el && content) {
      const whole = scale <= fit + 0.01;
      const focus = current.focus;
      anchor.current =
        whole && focus
          ? { x: focus.x + focus.w / 2, y: focus.y + focus.h / 2 }
          : {
              x: (el.scrollLeft + el.clientWidth / 2 - content.offsetLeft) / scale,
              y: (el.scrollTop + el.clientHeight / 2 - content.offsetTop) / scale,
            };
    }
    setZoom(next);
  };

  // After a zoom: bring the anchor point back to the middle of the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: per new scale.
  useLayoutEffect(() => {
    const el = ref.current;
    const content = contentRef.current;
    const a = anchor.current;
    anchor.current = null;
    if (!el || !content || !a) return;
    el.scrollTo({
      left: a.x * scale + content.offsetLeft - el.clientWidth / 2,
      top: a.y * scale + content.offsetTop - el.clientHeight / 2,
    });
  }, [scale]);

  // Each new image: a highlight that is not fully in view scrolls into the
  // middle (the zoom stays as the student set it).
  const focus = current.focus;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per image.
  useEffect(() => {
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content || !focus || !ready) return;
    const left = focus.x * scale + content.offsetLeft;
    const top = focus.y * scale + content.offsetTop;
    const inView =
      left >= el.scrollLeft &&
      top >= el.scrollTop &&
      left + focus.w * scale <= el.scrollLeft + el.clientWidth &&
      top + focus.h * scale <= el.scrollTop + el.clientHeight;
    if (inView) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({
      left: left + (focus.w * scale) / 2 - el.clientWidth / 2,
      top: top + (focus.h * scale) / 2 - el.clientHeight / 2,
      behavior: still ? "auto" : "smooth",
    });
  }, [current.key, ready]);

  const percent = Math.round(scale * 100);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* A flex container with an auto-margin child centres a small drawing and
          still scrolls a large one from its edge. */}
      <div
        ref={ref}
        className="relative flex min-h-0 min-w-0 flex-1 overflow-auto"
        style={{ padding: ZOOM_PAD }}
        data-testid="board-zoom-view"
      >
        <div
          ref={contentRef}
          className="relative m-auto shrink-0"
          data-testid="board-zoom-content"
          style={{
            width: ready ? current.width * scale : 0,
            height: ready ? current.height * scale : 0,
          }}
        >
          <BoardImageStack layers={layers} alt={alt} fit="fill" />
        </div>
      </div>
      <fieldset
        aria-label="Zoom"
        className="absolute right-3 bottom-3 flex items-center gap-1 rounded-full border border-foreground/15 bg-background/95 p-1 shadow-sm"
      >
        <button
          type="button"
          className={ZOOM_BUTTON}
          onClick={() => zoomOut !== null && zoomTo(zoomOut)}
          disabled={zoomOut === null}
          aria-label="Zoom out"
          title="Zoom out"
          data-testid="board-zoom-out"
        >
          −
        </button>
        <button
          type="button"
          className={cn(ZOOM_BUTTON, "w-14 font-normal tabular-nums")}
          onClick={() => zoomTo(null)}
          disabled={zoom === null}
          aria-label={`Zoom ${percent}%. Fit the drawing`}
          title="Fit the drawing"
          data-testid="board-zoom-fit"
        >
          {percent}%
        </button>
        <button
          type="button"
          className={ZOOM_BUTTON}
          onClick={() => zoomIn !== null && zoomTo(zoomIn)}
          disabled={zoomIn === null}
          aria-label="Zoom in"
          title="Zoom in"
          data-testid="board-zoom-in"
        >
          +
        </button>
      </fieldset>
    </div>
  );
}
