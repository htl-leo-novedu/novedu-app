"use client";

import { useState } from "react";
import { DialogShell } from "@/components/ui/dialog-shell";
import type { ResolvedImage } from "@/lib/image-ref";

// The shared image lightbox: the app's DialogShell (which owns open/close,
// Escape, backdrop click, and the Close button) sized to the image. Images are
// rendered ONLY via <img src> — never inline SVG markup — so a hosted SVG can't
// inject script. Reused by <ContentImage> (the quiz / tutor / fragment content
// image) and by the /images list's "View" button, so both surfaces get the
// identical lightbox.
export function ImageLightbox({
  image,
  open,
  onClose,
}: {
  image: ResolvedImage;
  open: boolean;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const alt = image.alt ?? "";

  return (
    // size="fit" / w-fit: the dialog hugs the image; the caps keep it inside
    // the viewport (max-h-[88vh] widens the variant's 85vh cap — images want
    // every pixel), and min-h-0 lets the image shrink within the flex column
    // so the credit line stays visible below tall images. `w-fit`, NEVER
    // `w-auto`: the UA zeroes a dialog's inline insets too, so an indefinite
    // width stretches to the 92vw cap and a small image blows up inside a
    // giant box — the inline-axis twin of the `h-auto` bug (see DialogShell).
    <DialogShell
      open={open}
      onClose={onClose}
      size="fit"
      className="max-h-[88vh] w-fit max-w-[92vw]"
    >
      {failed ? (
        <p className="px-10 py-8 text-foreground/55 text-sm">Image could not be loaded</p>
      ) : (
        // biome-ignore lint/performance/noImgElement: hosted images are arbitrary external blobs (incl. SVG), not bundled assets — next/image's optimizer/loader doesn't apply.
        <img
          className="block min-h-0 max-w-full object-contain dark:bg-white"
          src={image.url}
          alt={alt}
          onError={() => setFailed(true)}
        />
      )}
      {image.credit ? (
        <p className="wrap-anywhere px-2.5 pt-1.5 pb-2.5 text-center text-foreground/60 text-xs">
          {image.credit}
        </p>
      ) : null}
    </DialogShell>
  );
}
