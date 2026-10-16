import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { Shape } from '../contracts/blueprint';
import { MAT } from '../contracts/palette';
import { buildPalette } from '../palette';
import { buildCloudHopper } from './dropTower';

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

/** The mast's outer layer on each side (centre 48, mast 14 wide: voxels 41..54). */
const MAST_MIN = 41;
const MAST_LAST = 54;

type BoxShape = Extract<Shape, { kind: 'box' }>;

const latticeRuns = (shapes: readonly Shape[]): BoxShape[] =>
  shapes.filter((shape): shape is BoxShape => shape.kind === 'box' && shape.material === MAT.STEEL_LIGHT);

describe('cloud hopper mast lattice (Phase 26: every side is seen from some view)', () => {
  const definition = BUILD_BY_ID.get('cloud-hopper');
  if (!definition) throw new Error('cloud-hopper missing from the catalog');
  const body = buildCloudHopper(definition, palette).parts[0];
  const runs = latticeRuns(body.shapes);
  const onFace = (axis: 0 | 1, at: number): BoxShape[] => runs.filter((box) => box.size[axis] === 1 && box.min[axis] === at);

  it('runs round all four mast faces with the same rungs and braces', () => {
    const faces = [onFace(1, MAST_LAST), onFace(1, MAST_MIN), onFace(0, MAST_LAST), onFace(0, MAST_MIN)];
    const counts = faces.map((face) => face.length);
    expect(counts[0]).toBeGreaterThan(0);
    expect(new Set(counts).size).toBe(1);
    const heights = faces.map((face) => face.map((box) => `${box.min[2]}:${box.size[2]}`).sort().join(','));
    expect(new Set(heights).size).toBe(1);
  });
});
