import type { Blueprint, BlueprintPart, Shape } from '../contracts/blueprint';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import { MAT, PATTERN } from '../contracts/palette';
import { PLOT_TOP_Z } from '../contracts/space';

/**
 * Hand-written sample blueprints sized to the art bible (design §12). They cover every shape kind,
 * carving, moving parts and lights, so the compiler tests, the compile-time benchmark and the
 * scratch preview tool all measure something the size of real content. The game never uses them:
 * real models live in content/*.
 *
 * Materials are fixed MAT ids, so the samples need no palette.
 */

const around = (count: number, radius: number, centerX: number, centerY: number): [number, number, number][] =>
  Array.from({ length: count }, (_unused, index) => {
    const angle = (index / count) * Math.PI * 2;
    return [centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius, angle];
  });

/**
 * A 3×3 carousel: a static base and column, and one part spinning about z that carries the
 * platform, poles, horses and a striped cone canopy resting on the column's top. At rest no part
 * overlaps another (overlapping boxes would z-fight).
 */
export const SAMPLE_CAROUSEL: Blueprint = {
  id: 'sample:carousel',
  footprint: [3, 3],
  parts: [
    {
      id: 'body',
      pivot: [0, 0, 0],
      shapes: [
        { kind: 'cylinder', base: [48, 48, PLOT_TOP_Z], radius: 45, length: 2, axis: 'z', material: MAT.CONCRETE, pattern: PATTERN.COBBLE },
        { kind: 'cylinder', base: [48, 48, 3], radius: 4, length: 80, axis: 'z', material: MAT.STEEL_LIGHT, pattern: PATTERN.METAL },
      ],
    },
    {
      id: 'spin',
      pivot: [48, 48, 3],
      shapes: [
        { kind: 'cylinder', base: [48, 48, 3], radius: 42, length: 4, axis: 'z', material: MAT.WOOD, pattern: PATTERN.PLANKS },
        // The platform turns around the static column, never through it.
        { kind: 'cylinder', base: [48, 48, 3], radius: 5, length: 4, axis: 'z', material: 0 },
        ...around(6, 32, 48, 48).flatMap(([x, y, angle]): Shape[] => {
          const tangentX = -Math.sin(angle) * 6;
          const tangentY = Math.cos(angle) * 6;
          return [
            { kind: 'cylinder', base: [Math.round(x), Math.round(y), 7], radius: 1, length: 76, axis: 'z', material: MAT.RAIL },
            { kind: 'segment', from: [x - tangentX, y - tangentY, 34], to: [x + tangentX, y + tangentY, 34], radius: 2.5, material: MAT.WHITE },
            { kind: 'ellipsoid', center: [x + tangentX * 1.2, y + tangentY * 1.2, 39], radii: [2.5, 2.5, 3.5], material: MAT.WHITE },
          ];
        }),
        { kind: 'cone', base: [48, 48, 83], radius: 45, height: 24, topRadius: 3, material: MAT.CANVAS, pattern: PATTERN.STRIPES },
        { kind: 'ring', center: [48, 48, 85], radius: 43, thickness: 4, width: 5, axis: 'z', material: MAT.ARCH_PINK, pattern: PATTERN.FABRIC },
        { kind: 'cone', base: [48, 48, 107], radius: 4, height: 10, material: MAT.RAIL },
      ],
    },
  ],
  lights: around(8, 44, 48, 48).map(([x, y]) => ({
    position: [x, y, 84] as const,
    radius: 16,
    color: 0xfff4c9,
    presets: LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT,
  })),
};

const WHEEL_HUB: [number, number, number] = [64, 48, 70];
const WHEEL_RADIUS = 54;

/**
 * A 4×3 observation wheel: disc in the x–z plane (the plot's long axis), axle along y, radius 54.
 * The wheel part turns about y; twelve gondola parts hang in front of the rim (+y), clear of it.
 */
export const SAMPLE_WHEEL: Blueprint = {
  id: 'sample:wheel',
  footprint: [4, 3],
  parts: [
    {
      id: 'body',
      pivot: [0, 0, 0],
      shapes: [
        { kind: 'box', min: [8, 16, PLOT_TOP_Z], size: [112, 64, 3], material: MAT.CONCRETE },
        { kind: 'box', min: [48, 70, 4], size: [32, 16, 4], material: MAT.WOOD, pattern: PATTERN.PLANKS },
        ...[[30, 30], [98, 30], [30, 66], [98, 66]].map(([x, y]): Shape => ({
          kind: 'segment',
          from: [x, y, 4],
          to: [64, y < 48 ? 38 : 58, 70],
          radius: 1.5,
          material: MAT.STEEL,
        })),
        // Axle stubs on both sides of the turning hub.
        { kind: 'cylinder', base: [64, 36, 70], radius: 3, length: 8, axis: 'y', material: MAT.STEEL_LIGHT, pattern: PATTERN.METAL },
        { kind: 'cylinder', base: [64, 52, 70], radius: 3, length: 8, axis: 'y', material: MAT.STEEL_LIGHT, pattern: PATTERN.METAL },
      ],
    },
    {
      id: 'wheel',
      pivot: WHEEL_HUB,
      shapes: [
        { kind: 'ring', center: WHEEL_HUB, radius: WHEEL_RADIUS, thickness: 3, width: 4, axis: 'y', material: MAT.STEEL, pattern: PATTERN.METAL },
        { kind: 'ring', center: WHEEL_HUB, radius: 42, thickness: 2, width: 4, axis: 'y', material: MAT.STEEL_LIGHT },
        ...around(12, WHEEL_RADIUS, WHEEL_HUB[0], WHEEL_HUB[2]).map(([x, z]): Shape => ({
          kind: 'segment',
          from: WHEEL_HUB,
          to: [x, WHEEL_HUB[1], z],
          radius: 1,
          material: MAT.FENCE_RAIL,
        })),
        { kind: 'cylinder', base: [64, 44, 70], radius: 6, length: 8, axis: 'y', material: MAT.RAIL },
      ],
    },
    ...around(12, WHEEL_RADIUS, WHEEL_HUB[0], WHEEL_HUB[2]).map(([x, z], index): BlueprintPart => {
      const pivotX = Math.round(x);
      const pivotZ = Math.round(z);
      return {
        id: `gondola-${index}`,
        pivot: [pivotX, 52, pivotZ],
        shapes: [
          { kind: 'box', min: [pivotX - 1, 50, pivotZ - 4], size: [2, 2, 4], material: MAT.STEEL },
          { kind: 'box', min: [pivotX - 4, 52, pivotZ - 12], size: [8, 8, 8], material: MAT.MECHANIC_UNIFORM },
          { kind: 'box', min: [pivotX - 3, 59, pivotZ - 9], size: [6, 1, 3], material: MAT.GLASS, pattern: PATTERN.WINDOW },
        ],
      };
    }),
  ],
};

/** The art-bible tree: a 4×4 trunk to z 26 and a crown of three ellipsoids, top ≤ 60. */
export const SAMPLE_TREE: Blueprint = {
  id: 'sample:tree',
  footprint: [1, 1],
  parts: [
    {
      id: 'body',
      pivot: [0, 0, 0],
      shapes: [
        { kind: 'box', min: [14, 14, PLOT_TOP_Z], size: [4, 4, 25], material: MAT.TIMBER, pattern: PATTERN.PLANKS },
        { kind: 'ellipsoid', center: [14, 16, 38], radii: [11, 11, 10], material: MAT.FOLIAGE, pattern: PATTERN.FOLIAGE },
        { kind: 'ellipsoid', center: [19, 17, 41], radii: [10, 10, 9], material: MAT.FOLIAGE_DARK, pattern: PATTERN.FOLIAGE },
        { kind: 'ellipsoid', center: [16, 14, 47], radii: [10, 10, 9], material: MAT.FOLIAGE, pattern: PATTERN.FOLIAGE },
      ],
    },
  ],
};

/** A 2×2 kiosk: walls with a carved door, a window, a striped awning and a stepped gable roof. */
export const SAMPLE_KIOSK: Blueprint = {
  id: 'sample:kiosk',
  footprint: [2, 2],
  parts: [
    {
      id: 'body',
      pivot: [0, 0, 0],
      shapes: [
        { kind: 'box', min: [4, 4, PLOT_TOP_Z], size: [56, 56, 30], material: MAT.WOOD, pattern: PATTERN.PLANKS },
        { kind: 'box', min: [36, 58, PLOT_TOP_Z], size: [12, 2, 22], material: 0 },
        { kind: 'box', min: [36, 57, PLOT_TOP_Z], size: [12, 1, 22], material: MAT.INK },
        { kind: 'box', min: [10, 59, 10], size: [16, 1, 12], material: MAT.GLASS, pattern: PATTERN.WINDOW },
        { kind: 'box', min: [2, 60, 24], size: [60, 4, 2], material: MAT.CANVAS, pattern: PATTERN.STRIPES },
        { kind: 'gable', min: [1, 1, 31], size: [62, 62, 16], ridge: 'x', material: MAT.TRACK, pattern: PATTERN.ROOF },
      ],
    },
  ],
  lights: [{ position: [18, 61, 16], radius: 28, color: 0xffd28a, presets: LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT }],
};

export const SAMPLE_BLUEPRINTS: readonly Blueprint[] = [SAMPLE_CAROUSEL, SAMPLE_WHEEL, SAMPLE_TREE, SAMPLE_KIOSK];
