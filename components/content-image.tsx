"use client";

import { useState } from "react";
import type { ResolvedImage } from "@/lib/image-ref";
import { ImageLightbox } from "./image-lightbox";

// Module-neutral content image. Renders a bounded responsive thumbnail (a real
// button) that opens the shared <ImageLightbox> showing the same image full-window.
// Images are rendered ONLY via <img src> — never inline SVG markup — so a hosted
// SVG can't inject script into the page. If the thumbnail <img> fails to load, the
// component falls back to a muted note.
export function ContentImage({ image }: { image: ResolvedImage }) {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const alt = image.alt ?? "";

  if (failed) {
    return <p className="text-foreground/55 text-sm">Image could not be loaded</p>;
  }

  return (
    <>
      {/* The thumbnail and its credit are grouped in a figure sized to the image
          (width: fit-content), so the credit aligns to the image's width rather
          than the full column. */}
      <figure className="mb-2 w-fit max-w-full">
        {/* A real button (keyboard/screen-reader operable) with no button chrome —
            just the bounded, framed image. */}
        <button
          type="button"
          className="block max-w-full cursor-zoom-in leading-none focus-visible:rounded-lg focus-visible:outline-2 focus-visible:outline-foreground/45 focus-visible:outline-offset-2"
          aria-label="View larger image"
          onClick={() => setOpen(true)}
        >
          {/* biome-ignore lint/performance/noImgElement: hosted images are arbitrary external blobs (incl. SVG), not bundled assets — next/image's optimizer/loader doesn't apply. */}
          <img
            className="block max-h-88 max-w-full rounded-lg border border-foreground/15 object-contain dark:bg-white"
            src={image.url}
            alt={alt}
            onError={() => setFailed(true)}
          />
        </button>
        {image.credit ? (
          // width:0 + min-width:100% pins the caption to the image's width (the
          // figure's content box) so a long URL wraps under the image instead of
          // stretching the figure wider than the image.
          <figcaption className="wrap-anywhere mt-1.5 w-0 min-w-full text-left text-foreground/55 text-xs leading-snug">
            {image.credit}
          </figcaption>
        ) : null}
      </figure>

      <ImageLightbox image={image} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
