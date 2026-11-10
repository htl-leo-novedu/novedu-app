// The tutor board: a pure model of the `board` tool's drawing (docs/tutor-tools.md).
// `model.ts` checks and applies calls, `layout.ts` turns a state into Excalidraw
// element skeletons, `calls.ts` finds the successful calls in a message list,
// `describe.ts` words a board for people.

export {
  BOARD_TOOL_NAME,
  type BoardCall,
  type BoardPillLabel,
  boardCallsFromAgui,
  boardCallsFromStored,
  boardPillLabels,
  isAppliedResult,
} from "./calls";
export { changeStatus, describeBoard } from "./describe";
export {
  type BoardElementSkeleton,
  type FinishableElement,
  finish,
  layout,
  MARK,
  markedIds,
  wrap,
} from "./layout";
export {
  type ApplyResult,
  apply,
  type BoardState,
  COLORS,
  emptyBoard,
  LIMITS,
  replay,
  summary,
} from "./model";
