import { describe, expect, it } from 'vitest';
import { PROP_KIND_BY_ID } from '../../../game/maps/props';
import { ParkSession } from '../../../game/session/ParkSession';
import { previewFill, PREVIEW_FILL_BULLDOZE, PREVIEW_FILL_BULLDOZE_REFUSED, PREVIEW_FILL_INVALID, PREVIEW_FILL_VALID } from '../../previewFill';
import { createModelCache } from '../blueprint/compile';
import {
  GHOST_COVERAGE_INVALID,
  GHOST_COVERAGE_VALID,
  GHOST_TINT_BULLDOZE,
  GHOST_TINT_BULLDOZE_REFUSED,
  GHOST_TINT_INVALID,
  GHOST_TINT_VALID,
} from '../contracts/gbuffer';
import { GROUND_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { gamePalette } from '../gamePalette';
import { GhostPreview } from './ghost';
import { REGISTRY_CONTENT, SceneModels } from './staticWorld';

/**
 * Phase 24 review fix: the bulldozer over a map prop marks the prop itself (its model in place), so the see-through
 * cutaway learns its height and keeps it, and a refused clear (a permanent prop, or a price the park cannot pay) reads
 * apart from one that will happen, in the ghost and in the preview diamond of both renderers.
 */

const TILE = VOXELS_PER_TILE;
const models = new SceneModels(gamePalette(), createModelCache(), REGISTRY_CONTENT, (message, error) => { throw new Error(`${message} ${String(error)}`); });

const canyon = (): ParkSession => new ParkSession(null, [], { mapId: 'red-rock-canyon' });
const propOf = (session: ParkSession, kind: string) => [...session.world.props.values()].find((prop) => prop.kind === kind)!;

describe('bulldoze ghost over a prop', () => {
  it.each(['red-boulder', 'saguaro', 'canyon-wall'])('%s: the prop\'s own flat model at its anchor, from any footprint cell', (kind) => {
    const session = canyon();
    const prop = propOf(session, kind);
    const definition = PROP_KIND_BY_ID.get(prop.kind)!;
    const flat = models.propFlat(definition, 0);
    for (const cell of session.world.propFootprint(prop)) {
      const ghost = new GhostPreview();
      ghost.set(session.world.propFootprint(prop).filter((other) => other.x === cell.x && other.y === cell.y), null, true, true, 0);
      const state = ghost.resolve(session.world, models)!;
      expect(state).not.toBeNull();
      expect(state.boxes).toBe(flat.boxes);
      expect(state.boxCount).toBe(flat.boxCount);
      expect([state.originX, state.originY, state.originZ]).toEqual([prop.x * TILE, prop.y * TILE, GROUND_TOP_Z]);
      expect(state.heightVoxels, 'the cutaway learns a real height').toBeGreaterThan(0);
    }
  });

  it('a clear that will happen is tinted the demolition red; a refused one slate, screened like an invalid ghost', () => {
    const session = canyon();
    const boulder = propOf(session, 'red-boulder');
    const ghost = new GhostPreview();
    ghost.set(session.world.propFootprint(boulder), null, true, true, 0);
    let state = ghost.resolve(session.world, models)!;
    expect([state.tint, state.coverage]).toEqual([GHOST_TINT_BULLDOZE, GHOST_COVERAGE_VALID]);
    ghost.set(session.world.propFootprint(boulder), null, false, true, 0);
    state = ghost.resolve(session.world, models)!;
    expect([state.tint, state.coverage]).toEqual([GHOST_TINT_BULLDOZE_REFUSED, GHOST_COVERAGE_INVALID]);
  });

  it('the ghost goes with the prop: once cleared, the same request resolves to nothing', () => {
    const session = canyon();
    const boulder = propOf(session, 'red-boulder');
    const cell = { x: boulder.x, y: boulder.y };
    const ghost = new GhostPreview();
    ghost.set([cell], null, true, true, 0);
    expect(ghost.resolve(session.world, models)).not.toBeNull();
    expect(ghost.followsWorld).toBe(true);
    session.world.cash = 1_000_000;
    expect(session.world.bulldoze(cell).removed).toBe(true);
    expect(session.world.propAt(cell)).toBeUndefined();
    expect(ghost.resolve(session.world, models)).toBeNull();
  });

  it('open ground under the bulldozer still has no ghost', () => {
    const session = canyon();
    let free = { x: -1, y: -1 };
    for (let y = 0; y < session.world.height && free.x < 0; y += 1) {
      for (let x = 0; x < session.world.width; x += 1) {
        const cell = { x, y };
        if (!session.world.propAt(cell) && !session.world.objectAt(cell) && !session.world.paths.has(`${x},${y}`)) { free = cell; break; }
      }
    }
    const ghost = new GhostPreview();
    ghost.set([free], null, true, true, 0);
    expect(ghost.resolve(session.world, models)).toBeNull();
  });
});

describe('preview fill (shared by the classic renderer and the voxel overlay)', () => {
  it('keeps every fill it had before Phase 24 and adds slate only for a refused bulldoze', () => {
    expect(previewFill(true, false)).toBe(0x69f0c0);
    expect(previewFill(false, false)).toBe(0xff6277);
    expect(previewFill(true, true)).toBe(0xff5f70);
    expect(previewFill(false, true)).toBe(PREVIEW_FILL_BULLDOZE_REFUSED);
    expect(new Set([PREVIEW_FILL_VALID, PREVIEW_FILL_INVALID, PREVIEW_FILL_BULLDOZE, PREVIEW_FILL_BULLDOZE_REFUSED]).size).toBe(4);
  });

  it('the voxel ghost tints equal the diamond fills', () => {
    expect(GHOST_TINT_VALID).toBe(PREVIEW_FILL_VALID);
    expect(GHOST_TINT_INVALID).toBe(PREVIEW_FILL_INVALID);
    expect(GHOST_TINT_BULLDOZE).toBe(PREVIEW_FILL_BULLDOZE);
    expect(GHOST_TINT_BULLDOZE_REFUSED).toBe(PREVIEW_FILL_BULLDOZE_REFUSED);
  });
});
