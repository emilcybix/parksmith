import { describe, expect, it, vi } from 'vitest';
import { GAME_CONFIG } from '../config';
import * as generator from '../maps/generator';
import { buildFirstDayRoute } from '../onboarding/routeInFrame';
import { ParkSession } from '../session/ParkSession';
import { hashState } from './hash';
import { createParkSave } from './version';
import { sessionFromSave } from '../session/fromSave';

vi.mock('../maps/generator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../maps/generator')>();
  return { ...actual, generateMap: vi.fn(actual.generateMap) };
});

const step = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
};

/** Generated maps in saves (Phase 24 step 2): the full MapState PLUS the recipe; restore never regenerates. */
describe('a generated park through a save', () => {
  const recipe = generator.recipeOf('seaside', 1234, { density: 'high' });
  const play = (): ParkSession => {
    const session = new ParkSession(null, [], { layout: generator.generateMap(recipe).layout });
    buildFirstDayRoute(session);
    step(session, 400);
    const palm = [...session.world.props.values()].find((prop) => prop.kind === 'palm-tree');
    if (palm) session.world.bulldoze(palm);
    session.syncWithWorld();
    return session;
  };

  it('serialize() holds the ground rows, the remaining props AND the recipe; the save round-trips through JSON', () => {
    const session = play();
    const state = session.serialize();
    expect(state.map.recipe).toEqual(recipe);
    expect(state.map.ground.length).toBe(32);
    expect(state.map.props.length).toBe(session.world.props.size);
    expect(state.map.props.length).toBeLessThan(session.map.props.length);
    const envelope = JSON.parse(JSON.stringify(createParkSave(state, { clock: { speed: 1, simulationTimeMs: 40_000 }, tourNodeId: null }, 1)));
    const restored = sessionFromSave(envelope).session;
    expect(restored.map.recipe).toEqual(recipe);
    expect(restored.map.name).toBe('Generated · seed 1234');
    expect(hashState(restored.serialize())).toBe(hashState(state));
  });

  it('continues 600 ticks exactly like the uninterrupted run', () => {
    const uninterrupted = play();
    const saved = play();
    const envelope = JSON.parse(JSON.stringify(createParkSave(saved.serialize(), { clock: { speed: 1, simulationTimeMs: 40_000 }, tourNodeId: null }, 1)));
    const restored = sessionFromSave(envelope).session;
    step(uninterrupted, 600);
    step(restored, 600);
    expect(hashState(restored.serialize())).toBe(hashState(uninterrupted.serialize()));
  }, 60_000);

  it('restore never calls the generator (the stored state wins)', () => {
    const state = play().serialize();
    const mocked = vi.mocked(generator.generateMap);
    mocked.mockClear();
    ParkSession.fromState(JSON.parse(JSON.stringify(state)));
    sessionFromSave(JSON.parse(JSON.stringify(createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 1))));
    expect(mocked).not.toHaveBeenCalled();
  });

  it('a later change of the generator cannot change a saved park: a recipe of an unreproducible version still restores', () => {
    const state = JSON.parse(JSON.stringify(play().serialize()));
    state.map.recipe.generatorVersion = 3;
    const session = ParkSession.fromState(state);
    expect(session.world.props.size).toBe(state.map.props.length);
    expect(session.map.recipe?.generatorVersion).toBe(3);
  });
});
