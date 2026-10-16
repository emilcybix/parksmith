import type { PropKindDefinition } from '../../../../game/maps/props';
import type { Blueprint, Shape, Vec3 } from '../../contracts/blueprint';
import type { Palette } from '../../contracts/palette';
import { PATTERN } from '../../contracts/palette';
import { VOXELS_PER_TILE } from '../../contracts/space';

/**
 * The tools the prop modules share (Phase 24). A prop is one static body that stands on the ground (z = 0, so
 * `floorZ: 0`) inside its own footprint: x in [0, 32 w), y in [0, 32 d) of the UNROTATED kind, so two props never
 * overlap and a forest never z-fights. Every colour comes from the palette by rgb (`palette.material`), which
 * throws for a colour the palette lacks, so a colour typo fails loudly in props.test.ts rather than in the park.
 *
 * Authoring notes (art bible, props): props are chunkier than catalog scenery and cheap in boxes; round shapes are
 * stepped domes (two crossing boxes per layer), ellipsoids only where a smooth silhouette pays for itself. Every
 * prop reads as an obstacle from every view: no thin shape is the only thing marking a blocked cell.
 */

export type Material = number;

export const TILE = VOXELS_PER_TILE;

export const box = (x: number, y: number, z: number, w: number, d: number, h: number, material: Material, pattern: number = PATTERN.PLAIN): Shape => ({
  kind: 'box',
  min: [x, y, z],
  size: [w, d, h],
  material,
  pattern,
});

export const ellipsoid = (
  cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, material: Material, pattern: number = PATTERN.PLAIN,
): Shape => ({ kind: 'ellipsoid', center: [cx, cy, cz], radii: [rx, ry, rz], material, pattern });

export const cone = (
  cx: number, cy: number, z: number, radius: number, height: number, material: Material, pattern: number = PATTERN.PLAIN, topRadius = 0,
): Shape => ({ kind: 'cone', base: [cx, cy, z], radius, height, topRadius, material, pattern });

export const cylinder = (
  cx: number, cy: number, z: number, radius: number, length: number, material: Material, pattern: number = PATTERN.PLAIN,
): Shape => ({ kind: 'cylinder', base: [cx, cy, z], radius, length, axis: 'z', material, pattern });

export const segment = (from: Vec3, to: Vec3, radius: number, material: Material, pattern: number = PATTERN.PLAIN): Shape => ({
  kind: 'segment', from, to, radius, material, pattern,
});

/** One layer of a stepped dome: a rounded square of half-width `half` with `chamfer` cut from every corner, `height` tall. */
export interface DomeLayer {
  readonly half: number;
  readonly chamfer: number;
  readonly height: number;
  /** Overrides the dome's material for this layer (two-tone crowns). */
  readonly material?: Material;
}

/**
 * A stepped dome centred on (cx, cy): layers stacked from `z`, each an octagon made of two crossing boxes. Cheap
 * (about three boxes a layer) and reads as a round crown at one texel per voxel.
 */
export const dome = (cx: number, cy: number, z: number, layers: readonly DomeLayer[], material: Material, pattern: number = PATTERN.PLAIN): Shape[] => {
  const shapes: Shape[] = [];
  let at = z;
  for (const layer of layers) {
    const m = layer.material ?? material;
    const inner = layer.half - layer.chamfer;
    shapes.push(box(cx - layer.half, cy - inner, at, 2 * layer.half, 2 * inner, layer.height, m, pattern));
    shapes.push(box(cx - inner, cy - layer.half, at, 2 * inner, 2 * layer.half, layer.height, m, pattern));
    at += layer.height;
  }
  return shapes;
};

/** The blueprint of a kind from its shapes: one body part, standing on the ground. */
export const propBlueprint = (kind: PropKindDefinition, shapes: readonly Shape[]): Blueprint => ({
  id: `prop:${kind.id}`,
  footprint: kind.footprint,
  floorZ: 0,
  parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
});

/** A prop module's entry: its shapes from the palette. */
export type PropBuilder = (kind: PropKindDefinition, material: (rgb: number) => Material) => readonly Shape[];

export const propContent = (build: PropBuilder) => ({
  blueprint: (kind: PropKindDefinition, palette: Palette): Blueprint => propBlueprint(kind, build(kind, (rgb) => palette.material(rgb))),
});
