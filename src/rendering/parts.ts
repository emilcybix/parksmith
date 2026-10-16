import { Container, Graphics } from 'pixi.js';

/**
 * Pre-built moving parts.
 *
 * Clearing and redrawing a `Graphics` every frame is deceptively expensive: the path itself
 * is cheap to record, but Pixi re-tessellates it and re-uploads the geometry during the
 * render pass, and strokes tessellate into a lot of triangles. On a weak CPU that dominates
 * the frame. Everything here is therefore drawn once and animated by transform, alpha, and
 * visibility alone — the parts a ride moves every frame must never rebuild their geometry.
 */

/** A unit-length horizontal line, stretched between two points by transform alone. */
export const createSegment = (color: number, width: number, alpha = 1): Graphics => {
  const segment = new Graphics();
  segment.moveTo(0, 0).lineTo(1, 0).stroke({ color, width, alpha });
  return segment;
};

/**
 * Points a segment from one place to another. Scaling along its own axis changes length
 * only, so the stroke keeps its width.
 */
export const stretchSegment = (
  segment: Graphics,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void => {
  const dx = toX - fromX;
  const dy = toY - fromY;
  segment.position.set(fromX, fromY);
  segment.rotation = Math.atan2(dy, dx);
  segment.scale.x = Math.hypot(dx, dy) || 0.001;
};

export interface BandSet {
  /** Sweeps the bands to a new rotation phase. */
  update(phase: number, alpha?: number): void;
}

/**
 * Vertical bands on a camera-facing cylinder: only the front half shows, and each band
 * narrows toward the silhouette, which reads unmistakably as rotation. Built once, then
 * moved — the bands are the single most-animated geometry in the park.
 */
export const createBandSet = (
  parent: Container,
  centerY: number,
  height: number,
  radius: number,
  count: number,
  color: number,
): BandSet => {
  const nominal = Math.PI * 2 * radius / count * 0.55;
  const bands = Array.from({ length: count }, () => {
    const band = new Graphics();
    band.roundRect(-0.5, centerY - height, 1, height, 0.4).fill(color);
    parent.addChild(band);
    return band;
  });
  return {
    update: (phase, alpha = 1) => {
      for (const [index, band] of bands.entries()) {
        const angle = phase + index * Math.PI * 2 / count;
        const facing = Math.cos(angle);
        band.visible = facing > 0.04;
        if (!band.visible) continue;
        band.position.x = Math.sin(angle) * radius;
        band.scale.x = Math.max(0.9, nominal * facing);
        band.alpha = (0.3 + facing * 0.55) * alpha;
      }
    },
  };
};
