import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import { hashState } from '../save/hash';
import { assertPlainData, assertStructuredCloneSafe, auditOwnProperties, plainDeepEqual } from '../save/plainData';
import type { SceneryState } from '../save/state';
import { SaveError } from '../save/version';
import { GameWorld } from '../World';
import { ScenerySimulation } from './ScenerySimulation';

/** Seeded RNG so every churn run makes the same edits (mulberry32). */
const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const SCENERY_IDS = ['lollipop-lamp', 'confetti-tree', 'ripple-fountain'];

const createWorld = (): GameWorld => {
  const world = new GameWorld();
  world.cash = 10_000_000;
  const cells = [];
  for (let y = 30; y >= 20; y -= 1) cells.push({ x: 15, y });
  world.buildPaths(cells);
  world.buildObject('petal-roundabout', { x: 12, y: 26 });
  return world;
};

/**
 * Edits the world only (place, overlap, demolish scenery). `afterEdit` is where a scenery instance
 * syncs, so two instances can see the same world edits with a different application history.
 */
const churn = (world: GameWorld, seed: number, edits: number, afterEdit: () => void): void => {
  const random = createRandom(seed);
  for (let edit = 0; edit < edits; edit += 1) {
    const sceneryObjects = [...world.objects.values()]
      .filter((object) => BUILD_BY_ID.get(object.definitionId)?.kind === 'scenery');
    if (sceneryObjects.length > 4 && random() < 0.4) {
      const victim = sceneryObjects[Math.floor(random() * sceneryObjects.length)];
      world.bulldoze({ ...victim.anchor });
    } else {
      const id = SCENERY_IDS[Math.floor(random() * SCENERY_IDS.length)];
      world.buildObject(id, { x: 6 + Math.floor(random() * 20), y: 14 + Math.floor(random() * 12) });
    }
    afterEdit();
  }
};

const allCells = (world: GameWorld) => {
  const cells = [];
  for (let y = 0; y < world.height; y += 1) for (let x = 0; x < world.width; x += 1) cells.push({ x, y });
  return cells;
};

const expectSameReadings = (left: ScenerySimulation, right: ScenerySimulation, world: GameWorld, message: string): void => {
  expect(plainDeepEqual(left.serialize(), right.serialize()), `${message}: serialized scores`).toBe(true);
  for (const cell of allCells(world)) {
    if (left.scoreAt(cell) !== right.scoreAt(cell)) throw new Error(`${message}: scoreAt differs at ${cell.x},${cell.y}`);
  }
  for (const object of world.objects.values()) {
    expect(right.scoreForObject(object.id), `${message}: scoreForObject ${object.id}`).toBe(left.scoreForObject(object.id));
  }
};

/** A world and a scenery that went through a long churn, plus its saved state. */
const savedChurn = () => {
  const world = createWorld();
  const scenery = new ScenerySimulation(world);
  churn(world, 7, 60, () => scenery.syncWithWorld());
  return { world, scenery, state: scenery.serialize() };
};

/** The same world content, rebuilt by replaying the same edits (the world has no save yet). */
const replayedWorld = (edits = 60): GameWorld => {
  const world = createWorld();
  churn(world, 7, edits, () => undefined);
  return world;
};

describe('ScenerySimulation serialize', () => {
  it('writes plain, structured-clone-safe, JSON-stable sparse data in ascending order', () => {
    const { state, world } = savedChurn();
    assertPlainData(state);
    assertStructuredCloneSafe(state);
    expect(plainDeepEqual(JSON.parse(JSON.stringify(state)), state), 'JSON round trip is byte identical').toBe(true);
    expect(state.width).toBe(world.width);
    expect(state.height).toBe(world.height);
    expect(state.scores.length, 'non-trivial field').toBeGreaterThan(20);
    expect(state.scores.length, 'sparse, not the whole grid').toBeLessThan(world.width * world.height);
    state.scores.forEach(([index, value], position) => {
      expect(value).toBeGreaterThan(0);
      if (position > 0) expect(index).toBeGreaterThan(state.scores[position - 1][0]);
    });
    state.sources.forEach((source, position) => {
      if (position > 0) expect(source.objectId).toBeGreaterThan(state.sources[position - 1].objectId);
    });
  });

  it('is pure: no sync, no cache bump, even when the world changed since the last sync', () => {
    const world = createWorld();
    const scenery = new ScenerySimulation(world);
    world.buildObject('confetti-tree', { x: 20, y: 20 });
    const internals = scenery as unknown as { cacheVersion: number; lastWorldVersion: number };
    const versionBefore = internals.cacheVersion;
    const worldVersionBefore = internals.lastWorldVersion;
    const first = scenery.serialize();
    const second = scenery.serialize();
    expect(plainDeepEqual(first, second)).toBe(true);
    expect(internals.cacheVersion, 'cacheVersion untouched').toBe(versionBefore);
    expect(internals.lastWorldVersion, 'no sync happened').toBe(worldVersionBefore);
    expect(first.sources.length, 'the unsynced tree is not a source yet').toBe(0);
  });

  it('round trips: restoring into a rebuilt-from-scratch instance gives equal state and hash', () => {
    const { state, scenery } = savedChurn();
    const world = replayedWorld();
    const target = new ScenerySimulation(world);
    target.restore(state);
    const again = target.serialize();
    expect(plainDeepEqual(again, state)).toBe(true);
    expect(hashState(again)).toBe(hashState(state));
    expect(hashState(scenery.serialize())).toBe(hashState(state));
    const viaJson = new ScenerySimulation(replayedWorld());
    viaJson.restore(JSON.parse(JSON.stringify(state)) as SceneryState);
    expect(hashState(viaJson.serialize())).toBe(hashState(state));
  });

  it('restoring into a dirty instance equals restoring into a fresh one, and keeps identity', () => {
    const { state } = savedChurn();
    const world = replayedWorld();
    const fresh = new ScenerySimulation(world);
    fresh.restore(state);

    // Dirty: created on an empty world and fed the same edits with a different sync cadence.
    const dirtyWorld = createWorld();
    const dirty = new ScenerySimulation(dirtyWorld);
    let counter = 0;
    churn(dirtyWorld, 7, 60, () => { counter += 1; if (counter % 5 === 0) dirty.syncWithWorld(); });
    const reader = dirty;
    const versionBefore = dirty.snapshot().version;
    dirty.restore(state);
    expect(reader, 'same instance').toBe(dirty);
    expect(plainDeepEqual(dirty.serialize(), fresh.serialize())).toBe(true);
    expect(dirty.snapshot().version, 'cacheVersion keeps counting up').toBeGreaterThan(versionBefore);
    expect(dirty.snapshot().cells).toEqual(fresh.snapshot().cells);
    expect(dirty.snapshot().destinations).toEqual(fresh.snapshot().destinations);
  });

  it('does not double count: restored readings equal the never-saved run', () => {
    const { state, scenery, world } = savedChurn();
    const target = new ScenerySimulation(world);
    target.restore(state);
    expectSameReadings(scenery, target, world, 'right after restore');
    const left = scenery.snapshot();
    const right = target.snapshot();
    expect({ ...right, version: 0 }).toEqual({ ...left, version: 0 });
  });

  it('keeps float history bit-exact through further place/overlap/demolish churn', () => {
    const reference = createWorld();
    const referenceScenery = new ScenerySimulation(reference);
    churn(reference, 7, 60, () => referenceScenery.syncWithWorld());
    const saved = referenceScenery.serialize();
    expect(
      plainDeepEqual(new ScenerySimulation(reference).serialize().scores, saved.scores),
      'precondition: the churn leaves float residue a from-scratch rebuild does not reproduce',
    ).toBe(false);

    const restoredWorld = replayedWorld();
    const restoredScenery = new ScenerySimulation(restoredWorld);
    restoredScenery.restore(JSON.parse(JSON.stringify(saved)) as SceneryState);

    // The same later edits on both worlds (same seed continues from the same world state).
    churn(reference, 99, 80, () => referenceScenery.syncWithWorld());
    churn(restoredWorld, 99, 80, () => restoredScenery.syncWithWorld());
    expect(restoredWorld.objects.size).toBe(reference.objects.size);
    expectSameReadings(referenceScenery, restoredScenery, reference, 'after more churn');
    expect(hashState(restoredScenery.serialize())).toBe(hashState(referenceScenery.serialize()));
  });

  it('refuses a save written under different scenery content with content-mismatch, changing nothing', () => {
    const { state } = savedChurn();
    const target = new ScenerySimulation(replayedWorld());
    const before = target.serialize();
    const cases: Array<[string, (copy: SceneryState) => void]> = [
      ['changed appeal in a signature', (copy) => { copy.sources[0].signature = copy.sources[0].signature.replace(/:\d+(\.\d+)?:\d+$/, ':1:1'); }],
      ['corrupted signature string', (copy) => { copy.sources[1].signature += 'x'; }],
      ['extra source', (copy) => { copy.sources.push({ objectId: 99_999, signature: 'ghost:0:0:1:1:5:2' }); }],
      ['missing source', (copy) => { copy.sources.pop(); }],
    ];
    for (const [name, mutate] of cases) {
      const copy = structuredClone(state);
      mutate(copy);
      expect(() => target.restore(copy), name).toThrow(SaveError);
      try { target.restore(copy); } catch (error) { expect((error as SaveError).code, name).toBe('content-mismatch'); }
      expect(plainDeepEqual(target.serialize(), before), `${name}: nothing mutated`).toBe(true);
    }
  });

  it('rejects malformed payloads with invalid-state and leaves the instance untouched', () => {
    const { state, world } = savedChurn();
    const target = new ScenerySimulation(replayedWorld());
    target.restore(state);
    const before = target.serialize();
    const cases: Array<[string, (copy: SceneryState) => void]> = [
      ['wrong width', (copy) => { copy.width += 1; }],
      ['wrong height', (copy) => { copy.height -= 1; }],
      ['index out of range', (copy) => { copy.scores.push([world.width * world.height, 1]); }],
      ['negative index', (copy) => { copy.scores[0] = [-1, 1]; }],
      ['fractional index', (copy) => { copy.scores[0] = [0.5, 1]; }],
      ['not ascending', (copy) => { copy.scores.reverse(); }],
      ['duplicate index', (copy) => { copy.scores[1] = [copy.scores[0][0], 1]; }],
      ['zero value', (copy) => { copy.scores[0] = [copy.scores[0][0], 0]; }],
      ['negative value', (copy) => { copy.scores[0] = [copy.scores[0][0], -2]; }],
      ['NaN value', (copy) => { copy.scores[0] = [copy.scores[0][0], Number.NaN]; }],
      ['Infinity value', (copy) => { copy.scores[0] = [copy.scores[0][0], Number.POSITIVE_INFINITY]; }],
      ['pair of three', (copy) => { (copy.scores as unknown[])[0] = [0, 1, 2]; }],
      ['scores not an array', (copy) => { (copy as unknown as Record<string, unknown>).scores = {}; }],
      ['sources not ascending', (copy) => { copy.sources.reverse(); }],
      ['source id fractional', (copy) => { copy.sources[0].objectId = 1.5; }],
      ['signature not a string', (copy) => { (copy.sources[0] as unknown as Record<string, unknown>).signature = 7; }],
      ['sources missing', (copy) => { delete (copy as unknown as Record<string, unknown>).sources; }],
    ];
    for (const [name, mutate] of cases) {
      const copy = structuredClone(state);
      mutate(copy);
      let thrown: unknown;
      try { target.restore(copy); } catch (error) { thrown = error; }
      expect(thrown, `${name} throws`).toBeInstanceOf(SaveError);
      expect((thrown as SaveError).code, `${name} code`).toBe('invalid-state');
      expect(plainDeepEqual(target.serialize(), before), `${name}: nothing mutated`).toBe(true);
    }
    expect(() => target.restore(null as unknown as SceneryState)).toThrow(SaveError);
  });

  it('restores an empty world and a state with no scores', () => {
    const world = new GameWorld();
    const scenery = new ScenerySimulation(world);
    const state = scenery.serialize();
    expect(state.scores).toEqual([]);
    expect(state.sources).toEqual([]);
    const dirtyWorld = createWorld();
    new ScenerySimulation(dirtyWorld).restore(state as SceneryState);
  });
});

describe('ScenerySimulation field coverage guard', () => {
  /**
   * HOW TO FIX A FAILURE HERE: you added (or renamed) a field on ScenerySimulation. Decide:
   *  - it influences future behaviour and cannot be rebuilt: add it to SceneryState in
   *    src/game/save/state.ts, write it in serialize(), read it in restore(), list it under
   *    `serialized` below and give it a mutator that proves serialize() reads it;
   *  - it is a cache rebuilt by restore: list it under `derived` and say how it is rebuilt;
   *  - it is injected configuration or a telemetry counter: list it under `config` / `transient`.
   */
  const accounting = {
    serialized: ['scores', 'sources'],
    // objectScores/latestSnapshot are refilled by syncWithWorld(); the last*Version markers are
    // reset to -1 by restore() so that sync always rebuilds them.
    derived: ['objectScores', 'latestSnapshot', 'lastWorldVersion', 'lastPathVersion'],
    // `rules` (sceneryAppealMultiplier) is the session's ruleset, identical in a restore target; `themeAffinity`
    // (Phase 16) is read from it at construction.
    config: ['world', 'rules', 'themeAffinity'],
    // cacheVersion is a monotone render-cache key: never saved, never reset.
    transient: ['cacheVersion'],
  };

  const mutators: Record<string, (scenery: ScenerySimulation) => void> = {
    scores: (scenery) => {
      const scores = (scenery as unknown as { scores: Float64Array }).scores;
      scores[scores.length - 1] += 3.5;
    },
    sources: (scenery) => {
      const sources = (scenery as unknown as { sources: Map<number, unknown> }).sources;
      sources.delete([...sources.keys()][0]);
    },
  };

  it('accounts for every own property exactly once', () => {
    const { scenery } = savedChurn();
    expect(auditOwnProperties(scenery, accounting), 'see the HOW TO FIX comment in this describe').toEqual([]);
  });

  it('proves every serialized field is actually read by serialize()', () => {
    for (const name of accounting.serialized) {
      const mutate = mutators[name];
      expect(mutate, `serialized field '${name}' needs a mutator in this test`).toBeDefined();
      const { scenery } = savedChurn();
      const before = hashState(scenery.serialize());
      mutate(scenery);
      expect(hashState(scenery.serialize()), `serialize() ignores '${name}'`).not.toBe(before);
    }
  });
});
