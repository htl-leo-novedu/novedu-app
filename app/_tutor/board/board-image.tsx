"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { BoardImageLayer } from "./use-board-image";

/**
 * The board's image layers, stacked: the newest fades in over the previous one
 * (about 300 ms; none with reduced motion); the hook drops the old one afterwards.
 * Fills its (positioned) parent; `fit` letterboxes the drawing in it.
 */
export function BoardImageStack({
  layers,
  alt,
  fit = "contain",
  className,
}: {
  layers: BoardImageLayer[];
  alt: string;
  fit?: "contain" | "fill";
  className?: string;
}) {
  return (
    <div className={cn("relative h-full w-full", className)}>
      {layers.map((layer, i) => (
        <FadingImage
          key={layer.key}
          layer={layer}
          // Only the current image is announced; older ones are leaving.
          alt={i === layers.length - 1 ? alt : ""}
          fit={fit}
        />
      ))}
    </div>
  );
}

function FadingImage({
  layer,
  alt,
  fit,
}: {
  layer: BoardImageLayer;
  alt: string;
  fit: "contain" | "fill";
}) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // A cached image may be complete before React attaches onLoad.
  useEffect(() => {
    if (ref.current?.complete) setShown(true);
  }, []);
  const style: CSSProperties = { opacity: shown ? 1 : 0 };
  return (
    // biome-ignore lint/performance/noImgElement: a blob: URL rendered in the browser — next/image has nothing to optimise.
    <img
      ref={ref}
      src={layer.url}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      data-testid={alt ? "board-image" : undefined}
      draggable={false}
      onLoad={() => setShown(true)}
      style={style}
      className={cn(
        "absolute inset-0 h-full w-full select-none transition-opacity duration-300 motion-reduce:transition-none",
        fit === "contain" ? "object-contain" : "object-fill",
      )}
    />
  );
}
