"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardState } from "@/lib/board";
import { type RenderedBoard, renderBoard } from "./render";
import type { Rect } from "./sheet";

/** One rendered image of the board; the newest crossfades over the one before. */
export interface BoardImageLayer {
  key: number;
  url: string;
  width: number;
  height: number;
  focus: Rect | null;
}

/** The crossfade between two images (board-image.tsx). */
export const CROSSFADE_MS = 300;

/** Device pixels per drawing pixel: the pixel ratio × the largest zoom the pane uses (1.1). */
function renderScale(): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(4, Math.max(1, dpr) * 1.1);
}

/**
 * Renders the board whenever `stateKey` changes and keeps the last two images:
 * `layers.at(-1)` is the current one, an older one stays underneath until the
 * crossfade has ended. A failed render keeps the last good image — a
 * student never sees a board error.
 */
export function useBoardImage(state: BoardState | null, stateKey: string) {
  const [layers, setLayers] = useState<BoardImageLayer[]>([]);
  const counter = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const current = stateRef.current;
    if (!current || !stateKey) {
      setLayers((old) => {
        for (const l of old) URL.revokeObjectURL(l.url);
        return [];
      });
      return;
    }
    let cancelled = false;
    renderBoard(current, renderScale()).then(
      (r: RenderedBoard) => {
        if (cancelled) return;
        const layer: BoardImageLayer = {
          key: ++counter.current,
          url: URL.createObjectURL(r.blob),
          width: r.width,
          height: r.height,
          focus: r.focus,
        };
        setLayers((old) => {
          // Keep only the newest previous layer under the new one.
          for (const l of old.slice(0, -1)) URL.revokeObjectURL(l.url);
          return [...old.slice(-1), layer];
        });
        // Once the crossfade is over (also without one, under reduced motion),
        // drop everything below the new image.
        settleTimer.current = setTimeout(() => {
          setLayers((old) => {
            const keep = old.filter((l) => l.key >= layer.key);
            for (const l of old) if (l.key < layer.key) URL.revokeObjectURL(l.url);
            return keep;
          });
        }, CROSSFADE_MS + 100);
      },
      (error: unknown) => {
        if (!cancelled) console.error("board: rendering failed", error);
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(settleTimer.current);
    };
  }, [stateKey]);

  // Revoke everything on unmount (Start over remounts the whole chat).
  const latest = useRef(layers);
  latest.current = layers;
  useEffect(
    () => () => {
      for (const l of latest.current) URL.revokeObjectURL(l.url);
    },
    [],
  );

  return { layers, current: layers.at(-1) ?? null };
}
