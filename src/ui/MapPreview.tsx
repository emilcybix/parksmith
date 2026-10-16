import { useEffect, useRef } from 'react';
import type { MapPreviewImage } from '../game/maps/preview';

/**
 * A map preview (Phase 24 step 2) as a canvas: `putImageData` of the pure `MapPreviewImage` from
 * `game/maps/preview.ts`. Exported for the New park picker now and for Phase 22/23 (scenario list, The Map): pass
 * `renderMapPreview(layout, { cellPx: 2 })` for a 64 px thumbnail. Without a 2D context (jsdom, a blocked canvas) it
 * draws nothing and keeps its size, so layout never depends on it. `null` draws an empty frame.
 */
export const MapPreview = ({ image, label, className = 'pick-preview-canvas' }: { image: MapPreviewImage | null; label: string; className?: string }): React.JSX.Element => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null || image === null) return;
    let context: CanvasRenderingContext2D | null;
    try {
      context = canvas.getContext('2d');
    } catch {
      context = null;
    }
    if (context === null) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  }, [image]);
  return (
    <canvas
      ref={ref}
      className={className}
      width={image?.width ?? 128}
      height={image?.height ?? 128}
      role="img"
      aria-label={label}
      data-preview-hash={image?.hash}
      data-empty={image === null ? '' : undefined}
    />
  );
};

/** A PNG data URL of a preview for `<img>` users, or null where no canvas is available. Built on demand, not cached here. */
export const previewDataUrl = (image: MapPreviewImage): string | null => {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
};
