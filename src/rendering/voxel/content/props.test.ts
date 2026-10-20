import { describe, expect, it } from 'vitest';
import { BIOMES } from '../../../game/biomes/content';
import { PROP_KIND_BY_ID, PROP_KINDS } from '../../../game/maps/props';
import type { PropKindDefinition } from '../../../game/maps/props';
import { compileBlueprintReport, rotateModel, flattenAtRest } from '../blueprint/compile';
import { voxelizeShapes } from '../blueprint/voxelize';
import type { Blueprint } from '../contracts/blueprint';
import { BOX_FLOATS } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import { MAT_COLOR, MATERIAL_FLAG_EMISSIVE, MATERIAL_FLAG_GLASS, MATERIAL_FLAG_SHADOW, MATERIAL_FLAG_WATER } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import { gamePalette } from '../gamePalette';
import { buildPalette } from '../palette';
import { BIOME_MATERIALS, collectBiomeMaterials } from './biomeMaterials';
import { PLACEHOLDER_PROP_HEIGHT } from './placeholder';
import { propContentFor } from './registry';
import { COLOUR_SWATCHES } from '../../../game/content/colours';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';

/**
 * Phase 24 props: every kind has authored content (not the stand-in), compiles at both quarter turns inside its box
 * budget, stands on the ground inside its own footprint (so a forest never overlaps or z-fights), uses only colours the
 * palette registers for it, and is a single static body. The palette count (164 of 256 since Phase 49) and the guarantee that no
 * material id of the pre-biome palette moved are pinned here too.
 */

const palette = gamePalette();
const QUARTER_TURNS: readonly QuarterTurn[] = [0, 1];
const fixedColours = new Set<number>(Object.values(MAT_COLOR));

const budgetOf = (kind: PropKindDefinition): number => {
  const [w, d] = kind.footprint;
  return w * d === 1 ? BOX_BUDGET.prop : w * d === 2 ? BOX_BUDGET.propLong : BOX_BUDGET.propLarge;
};

/** A palette that records every colour the blueprint asks for. */
const recording = (): { palette: Palette; asked: Set<number> } => {
  const asked = new Set<number>();
  return {
    asked,
    palette: new Proxy(palette, {
      get: (target, key) => {
        if (key === 'material') return (rgb: number) => { asked.add(rgb); return target.material(rgb); };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }),
  };
};

describe('palette (Phase 24)', () => {
  it('holds 164 of 256 materials: 131 before the biomes, 31 new plain ones and the sick splat\'s two (Phase 49)', () => {
    expect(palette.count).toBe(164);
    const before = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
    expect(before.count).toBe(131);
    const per = BIOMES.map((biome) => buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb), collectBiomeMaterials([biome], PROP_KINDS.filter((kind) => kind.biome === biome.id))).count - 131);
    expect(per, 'new materials per biome: Meadow 0, Seaside 8, Desert 7, Winter 6, Jungle 3, Autumn 7').toEqual([0, 8, 7, 6, 3, 7]);
  });

  it('never moves an existing material: the first 131 texels of every row are byte-identical', () => {
    const before = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb)).textureData();
    const after = palette.textureData();
    for (let row = 0; row < 4; row += 1) {
      expect(Array.from(after.subarray(row * 1024, row * 1024 + 131 * 4)), `row ${row}`).toEqual(Array.from(before.subarray(row * 1024, row * 1024 + 131 * 4)));
    }
  });

  it('gives every biome ground colour a plain material whose secondary is the declared one (no accidental de-duplication)', () => {
    for (const biome of BIOMES) {
      const g = biome.ground;
      for (const colour of [g.base, g.alt, g.soil, g.paving, g.curb, ...(g.waterMaterial === 'plain' ? [g.water] : [])]) {
        const material = palette.material(colour.rgb);
        expect(palette.flags(material), `${biome.id} ${colour.rgb.toString(16)} is plain`).toBe(0);
        // The one allowed difference: Winter's white curb is the fixed WHITE, whose secondary is the derived one.
        expect(palette.secondaryColor(material), `${biome.id} ${colour.rgb.toString(16)}`).toBe(colour.secondary);
      }
    }
  });

  it('lists each new colour once and every biome material is an unflagged colour', () => {
    expect(BIOME_MATERIALS.length).toBeGreaterThan(31);
    for (const entry of BIOME_MATERIALS) {
      const flags = palette.flags(palette.material(entry.rgb));
      expect(flags & (MATERIAL_FLAG_EMISSIVE | MATERIAL_FLAG_GLASS | MATERIAL_FLAG_WATER | MATERIAL_FLAG_SHADOW), entry.what).toBe(0);
    }
  });
});

describe('prop content (Phase 24)', () => {
  it('registers authored content for every kind (none falls back to the stone block)', () => {
    for (const kind of PROP_KINDS) {
      const blueprint = propContentFor(kind.id).blueprint(kind, palette);
      expect(blueprint.id, kind.id).toBe(`prop:${kind.id}`);
      expect(blueprint.id.startsWith('placeholder')).toBe(false);
    }
    expect(PROP_KINDS).toHaveLength(32);
    expect(propContentFor('no-such-kind' as never).blueprint(PROP_KIND_BY_ID.get('oak-tree')!, palette).id).toBe('placeholder-prop:oak-tree');
    expect(PLACEHOLDER_PROP_HEIGHT).toBeGreaterThan(16);
  });

  it.each(PROP_KINDS.map((kind) => [kind.id, kind] as const))('%s: one static body on the ground, inside its footprint, within its box budget at both quarter turns', (_id, kind) => {
    const blueprint: Blueprint = propContentFor(kind.id).blueprint(kind, palette);
    expect(blueprint.floorZ, 'stands on the ground (z = 0)').toBe(0);
    expect(blueprint.footprint).toEqual(kind.footprint);
    expect(blueprint.parts, 'one static body, no moving parts').toHaveLength(1);
    expect(blueprint.lights ?? [], 'no lights in step 1').toHaveLength(0);
    const width = kind.footprint[0] * VOXELS_PER_TILE;
    const depth = kind.footprint[1] * VOXELS_PER_TILE;
    const report = compileBlueprintReport(blueprint);
    expect(report.model.boxCount, 'boxes').toBeGreaterThan(0);
    expect(report.model.boxCount, `${kind.id} boxes against its budget`).toBeLessThanOrEqual(budgetOf(kind));
    for (const quarterTurn of QUARTER_TURNS) {
      const turned = rotateModel(report.model, quarterTurn);
      expect(turned.boxCount).toBeLessThanOrEqual(budgetOf(kind));
      const flat = flattenAtRest(turned);
      const [fw, fd] = quarterTurn === 0 ? [width, depth] : [depth, width];
      for (let box = 0; box < flat.boxCount; box += 1) {
        const at = box * BOX_FLOATS;
        const [x, y, z, sx, sy, sz] = [flat.boxes[at], flat.boxes[at + 1], flat.boxes[at + 2], flat.boxes[at + 4], flat.boxes[at + 5], flat.boxes[at + 6]];
        expect(x, `${kind.id} q${quarterTurn} box ${box} x`).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(z, 'nothing below the ground').toBeGreaterThanOrEqual(0);
        expect(x + sx, `${kind.id} q${quarterTurn} x extent`).toBeLessThanOrEqual(fw);
        expect(y + sy, `${kind.id} q${quarterTurn} y extent`).toBeLessThanOrEqual(fd);
        expect(sz).toBeGreaterThan(0);
      }
      expect(turned.top, 'an obstacle is at least a knee high').toBeGreaterThanOrEqual(8);
      expect(turned.top, 'and below the box ceiling of the camera').toBeLessThanOrEqual(80);
    }
  });

  it.each(PROP_KINDS.map((kind) => [kind.id, kind] as const))('%s: asks the palette only for fixed colours and its declared colours, and uses its two main colours', (_id, kind) => {
    const spy = recording();
    propContentFor(kind.id).blueprint(kind, spy.palette);
    const allowed = new Set<number>([...fixedColours, ...kind.colors]);
    const strangers = [...spy.asked].filter((rgb) => !allowed.has(rgb)).map((rgb) => rgb.toString(16));
    expect(strangers, 'colours that are neither fixed nor declared in the kind\'s `colors`').toEqual([]);
    expect(spy.asked.has(kind.color), 'its main colour').toBe(true);
    expect(spy.asked.has(kind.accent), 'its accent').toBe(true);
  });

  it.each(PROP_KINDS.map((kind) => [kind.id, kind] as const))('%s: every voxel is face-connected to the ground (nothing floats)', (_id, kind) => {
    const blueprint = propContentFor(kind.id).blueprint(kind, palette);
    const grid = voxelizeShapes(blueprint.parts[0].shapes, 0, kind.id);
    const { sizeX, sizeY, sizeZ } = grid;
    const filled = (x: number, y: number, z: number): boolean => x >= 0 && y >= 0 && z >= 0 && x < sizeX && y < sizeY && z < sizeZ
      && grid.material[(z * sizeY + y) * sizeX + x] !== 0;
    const seen = new Uint8Array(sizeX * sizeY * sizeZ);
    const stack: number[] = [];
    let total = 0;
    for (let z = 0; z < sizeZ; z += 1) for (let y = 0; y < sizeY; y += 1) for (let x = 0; x < sizeX; x += 1) {
      if (!filled(x, y, z)) continue;
      total += 1;
      if (z + grid.originZ === 0) { seen[(z * sizeY + y) * sizeX + x] = 1; stack.push((z * sizeY + y) * sizeX + x); }
    }
    let reached = 0;
    while (stack.length > 0) {
      const at = stack.pop() as number;
      reached += 1;
      const x = at % sizeX;
      const y = Math.floor(at / sizeX) % sizeY;
      const z = Math.floor(at / (sizeX * sizeY));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const next = ((z + dz) * sizeY + y + dy) * sizeX + x + dx;
        if (filled(x + dx, y + dy, z + dz) && seen[next] === 0) { seen[next] = 1; stack.push(next); }
      }
    }
    expect(grid.originZ, 'the lowest voxel is the ground layer').toBe(0);
    expect(reached, `${total - reached} voxels of ${kind.id} are not connected to the ground`).toBe(total);
  });

  it('compiles the same boxes twice (deterministic)', () => {
    for (const kind of PROP_KINDS) {
      const a = compileBlueprintReport(propContentFor(kind.id).blueprint(kind, palette)).model;
      const b = compileBlueprintReport(propContentFor(kind.id).blueprint(kind, palette)).model;
      expect(Array.from(a.parts[0].boxes.subarray(0, a.parts[0].boxCount * BOX_FLOATS))).toEqual(Array.from(b.parts[0].boxes.subarray(0, b.parts[0].boxCount * BOX_FLOATS)));
    }
  });
});
