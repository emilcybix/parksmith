import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { deriveCoasterStats, validateCoasterLayout } from '../../../game/coaster/design';
import type { CoasterPiece } from '../../../game/coaster/design';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SWATCHES, colourSlotsFor, ENTRANCE_COLOUR_ID, SWATCH_COUNT } from '../../../game/content/colours';
import { COLOUR_PRESETS } from '../../../game/content/colourPresets';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { SCENARIOS } from '../../../game/scenarios/content';
import type { ParkSaveV4 } from '../../../game/save/state';
import { ParkSession } from '../../../game/session/ParkSession';
import type { Cell, Rotation } from '../../../game/types';
import type { GameWorld } from '../../../game/World';
import { createModelCache } from '../blueprint/compile';
import type { ModelCache } from '../blueprint/compile';
import type { Blueprint } from '../contracts/blueprint';
import type { ObjectContent } from '../contracts/content';
import { MAT } from '../contracts/palette';
import type { PartDriver } from '../contracts/rigid';
import { VOXELS_PER_TILE } from '../contracts/space';
import { buildPalette } from '../palette';
import { setPoseRotation } from './rigid';
import { PLACEHOLDER_CONTENT, REGISTRY_CONTENT } from './staticWorld';
import type { SceneContent } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * The static world is incremental: `syncWorld` diffs the path grid and the object list, marks the
 * chunks whose boxes can change — an object's chunks, the chunks of path tiles beside a changed
 * tile (curbs), the chunks of rides beside it (fences) — and the next update rebuilds only those.
 * Every one of those rules is a cache, and caches fail silently: a stale fence, a curb left
 * standing, a moving part drawn through a slot another object now owns.
 *
 * So this file asserts the one property that matters: after any sequence of world changes, every
 * chunk of the incrementally maintained scene hashes equal to the same chunk of a scene built from
 * scratch on the same world (boxes, bounds, lights; transform slots compared through the key they
 * were handed out for, since slot numbers depend on history). The sequences are seeded, animate the
 * rides between changes, and include what the caching is most likely to get wrong: paths appearing
 * and disappearing beside a ride's plot, batched bulldozer drags, rotated footprints, coasters,
 * undo pushed through its intermediate state, and swaps to another park (`setSession`).
 */

const TILE = VOXELS_PER_TILE;
const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));

class Rng {
  constructor(private state: number) {}
  next(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
  int(maximum: number): number {
    return Math.floor(this.next() * maximum);
  }
  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)];
  }
}

const RIDES = BUILD_CATALOG.filter((definition) => definition.kind === 'ride' && !definition.custom).map((definition) => definition.id);
const SERVICES = BUILD_CATALOG.filter((definition) => Boolean(definition.stats?.serviceType)).map((definition) => definition.id);
const DECORATIONS = BUILD_CATALOG.filter((definition) => definition.kind === 'scenery' || definition.kind === 'amenity').map((definition) => definition.id);
const CARDINALS: readonly Cell[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const cellKey = ({ x, y }: Cell): string => `${x},${y}`;

const randomCell = (world: GameWorld, rng: Rng): Cell => ({ x: rng.int(world.width), y: rng.int(world.height) });

const line = (from: Cell, length: number, direction: Cell): Cell[] =>
  Array.from({ length }, (_unused, index) => ({ x: from.x + direction.x * index, y: from.y + direction.y * index }));

const rideObjects = (world: GameWorld): number[] =>
  [...world.objects.values()]
    .filter((object) => BUILD_BY_ID.get(object.definitionId)?.kind === 'ride' && !world.coasters.has(object.id))
    .map((object) => object.id);

/** Placed objects that have colour slots (Phase 28: rides, coasters, stalls, facilities, comforts and scenery with a variant). */
const colourableRides = (world: GameWorld): number[] =>
  [...world.objects.values()].filter((object) => colourSlotsFor(object.definitionId).length > 0).map((object) => object.id);

const PRESET_IDS = COLOUR_PRESETS.map((preset) => preset.id);

/** A random record for an object: each slot a random swatch or the default. */
const randomColours = (world: GameWorld, id: number, rng: Rng): (number | null)[] =>
  colourSlotsFor(world.objects.get(id)?.definitionId ?? '').map(() => (rng.int(4) === 0 ? null : rng.int(SWATCH_COUNT)));

/** A closed rectangular loop with a flat station, one hill and one drop. */
const coasterLoop = (origin: Cell, width: number, depth: number): CoasterPiece[] => {
  const ring: Cell[] = [];
  for (let x = 0; x < width; x += 1) ring.push({ x: origin.x + x, y: origin.y });
  for (let y = 1; y < depth; y += 1) ring.push({ x: origin.x + width - 1, y: origin.y + y });
  for (let x = width - 2; x >= 0; x -= 1) ring.push({ x: origin.x + x, y: origin.y + depth - 1 });
  for (let y = depth - 2; y >= 1; y -= 1) ring.push({ x: origin.x, y: origin.y + y });
  const descentStart = ring.length - 3;
  return ring.map((cell, index) => {
    let height = 0;
    if (index >= 3 && index < descentStart) height = Math.min(2, index - 2);
    else if (index >= descentStart) height = Math.max(0, ring.length - 1 - index);
    return { cell, height };
  });
};

const placeCoaster = (world: GameWorld, rng: Rng): number | null => {
  const type = COASTER_TYPE_BY_ID.get('star-chaser');
  if (!type) return null;
  const pieces = coasterLoop({ x: 1 + rng.int(22), y: 1 + rng.int(24) }, 6, 4);
  if (!validateCoasterLayout(pieces, type).ok) return null;
  const placed = world.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), 1_000);
  return 'error' in placed ? null : placed.id;
};

/**
 * How the app takes a gesture back: snapshot before, restore after. The restore is either an
 * in-place `restoreState` (the world version goes backwards under every cache) or a swap to a fresh
 * `fromState` session through `setSession`, which is what the app does; both must converge.
 */
interface Rewind {
  snapshot(): ParkSaveV4;
  restore(snapshot: ParkSaveV4): void;
}

interface Mutation {
  label: string;
  /**
   * `sync` pushes the incremental scene through an intermediate state: without it, a build and its
   * rewind land in the same frame and the scene never sees the thing that was built — exactly the
   * window where a stale cache would hide. A mutation that calls it counts as having changed the
   * world even though the rewind returns the version number to where it started.
   */
  run: (world: GameWorld, rng: Rng, rewind: Rewind, sync: () => void) => void;
}

/** Objects are seeded (no cost, no research locks), so every catalog entry takes part. */
const place = (world: GameWorld, definitionId: string, anchor: Cell, rotation: Rotation): number | null =>
  world.seedScenarioObject(definitionId, anchor, rotation)?.id ?? null;

const MUTATIONS: Mutation[] = [
  { label: 'path tile', run: (world, rng) => { world.buildPaths([randomCell(world, rng)]); } },
  { label: 'path line', run: (world, rng) => { world.buildPaths(line(randomCell(world, rng), 3 + rng.int(6), rng.pick(CARDINALS))); } },
  { label: 'ride, random rotation', run: (world, rng) => { place(world, rng.pick(RIDES), randomCell(world, rng), rng.int(4) as Rotation); } },
  { label: 'service, random rotation', run: (world, rng) => { place(world, rng.pick(SERVICES), randomCell(world, rng), rng.int(4) as Rotation); } },
  { label: 'decoration', run: (world, rng) => { place(world, rng.pick(DECORATIONS), randomCell(world, rng), rng.int(4) as Rotation); } },
  {
    // Phase 16: a random cell of the world (the longer catalog shifted every seed's draws, and a blind cell missed
    // everything in all of them), or a random cell of a random object's footprint, so it does hit something.
    label: 'bulldoze one cell',
    run: (world, rng) => {
      const ids = [...world.objects.keys()];
      const object = ids.length > 0 && rng.int(2) === 0 ? world.objects.get(rng.pick(ids)) : undefined;
      world.bulldoze(object ? rng.pick(world.objectFootprint(object)) : randomCell(world, rng));
    },
  },
  {
    label: 'bulldoze drag, batched',
    run: (world, rng) => {
      const cells = line(randomCell(world, rng), 4 + rng.int(9), rng.pick(CARDINALS));
      world.batch(() => {
        for (const cell of cells) world.bulldoze(cell);
      });
    },
  },
  {
    label: 'path beside a ride plot',
    run: (world, rng) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      const object = world.objects.get(rng.pick(rides));
      if (!object) return;
      const cell = rng.pick(world.objectFootprint(object));
      const direction = rng.pick(CARDINALS);
      world.buildPaths([{ x: cell.x + direction.x, y: cell.y + direction.y }]);
    },
  },
  {
    label: 'clear a path beside a ride plot',
    run: (world, rng) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      const object = world.objects.get(rng.pick(rides));
      if (!object) return;
      const adjacent = world.objectFootprint(object)
        .flatMap((cell) => CARDINALS.map((direction) => ({ x: cell.x + direction.x, y: cell.y + direction.y })))
        .filter((cell) => world.paths.has(cellKey(cell)));
      if (adjacent.length > 0) world.bulldoze(rng.pick(adjacent));
    },
  },
  {
    label: 'remove a ride',
    run: (world, rng) => {
      const rides = rideObjects(world);
      if (rides.length > 0) world.bulldoze(world.objects.get(rng.pick(rides))!.anchor);
    },
  },
  { label: 'place a coaster', run: (world, rng) => { placeCoaster(world, rng); } },
  {
    // Phase 28: a recolour is no version bump, so only the appearance diff can find it.
    label: 'recolour a ride',
    run: (world, rng) => {
      const rides = colourableRides(world);
      if (rides.length === 0) return;
      const id = rng.pick(rides);
      world.setObjectColours(id, randomColours(world, id, rng));
    },
  },
  {
    label: 'recolour two rides in one batch',
    run: (world, rng) => {
      const rides = colourableRides(world);
      if (rides.length === 0) return;
      world.batch(() => {
        for (let count = 0; count < 2; count += 1) {
          const id = rng.pick(rides);
          world.setObjectColours(id, randomColours(world, id, rng));
        }
      });
    },
  },
  {
    // Phase 28 step 2: the gate is a park-level record, not an object.
    label: 'recolour the gate',
    run: (world, rng) => {
      if (rng.int(4) === 0) world.clearGateColours();
      else world.setGateColours(colourSlotsFor(ENTRANCE_COLOUR_ID).map(() => (rng.int(4) === 0 ? null : rng.int(SWATCH_COUNT))));
    },
  },
  {
    label: 'apply a preset to the whole park',
    run: (world, rng) => { world.applyPresetToPark(rng.pick(PRESET_IDS)); },
  },
  {
    label: 'apply a preset to the whole park, then rewind it',
    run: (world, rng, rewind, sync) => {
      const before = rewind.snapshot();
      if (world.applyPresetToPark(rng.pick(PRESET_IDS.filter((id) => id !== 'candy'))).changedCount === 0) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'reset the colours of a ride',
    run: (world, rng) => {
      const rides = colourableRides(world);
      if (rides.length > 0) world.clearObjectColours(rng.pick(rides));
    },
  },
  {
    label: 'recolour a ride, then rewind it',
    run: (world, rng, rewind, sync) => {
      const rides = colourableRides(world);
      if (rides.length === 0) return;
      const id = rng.pick(rides);
      const before = rewind.snapshot();
      if (!world.setObjectColours(id, randomColours(world, id, rng).map((swatch) => swatch ?? rng.int(SWATCH_COUNT))).ok) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'build an object, then rewind it',
    run: (world, rng, rewind, sync) => {
      const definitionId = rng.pick([...RIDES, ...SERVICES, ...DECORATIONS]);
      const before = rewind.snapshot();
      if (place(world, definitionId, randomCell(world, rng), rng.int(4) as Rotation) === null) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'build a path drag, then rewind it',
    run: (world, rng, rewind, sync) => {
      const before = rewind.snapshot();
      if (world.buildPaths(line(randomCell(world, rng), 3 + rng.int(6), rng.pick(CARDINALS))).built === 0) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'build a path beside a ride plot, then rewind it',
    run: (world, rng, rewind, sync) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      const object = world.objects.get(rng.pick(rides));
      if (!object) return;
      const cell = rng.pick(world.objectFootprint(object));
      const direction = rng.pick(CARDINALS);
      const before = rewind.snapshot();
      if (world.buildPaths([{ x: cell.x + direction.x, y: cell.y + direction.y }]).built === 0) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'build a coaster, then rewind it',
    run: (world, rng, rewind, sync) => {
      const before = rewind.snapshot();
      if (placeCoaster(world, rng) === null) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    // What the Phase 11 undo could not do: a demolished ride has to come back, with its geometry.
    label: 'demolish a ride, then rewind it',
    run: (world, rng, rewind, sync) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      const before = rewind.snapshot();
      world.bulldoze(world.objects.get(rng.pick(rides))!.anchor);
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'remove a coaster by one track cell',
    run: (world, rng) => {
      const coasters = [...world.coasters.values()];
      if (coasters.length > 0) world.bulldoze(rng.pick(rng.pick(coasters).pieces).cell);
    },
  },
];

/** A small working park, so the ride-adjacent mutations have targets from the first step. */
const seedPark = (world: GameWorld): void => {
  world.addMoney(5_000_000, 'Equivalence test funding');
  world.buildPaths(line({ x: 15, y: 30 }, 14, { x: 0, y: -1 }));
  world.buildPaths(line({ x: 10, y: 20 }, 12, { x: 1, y: 0 }));
  const petal = place(world, 'petal-roundabout', { x: 16, y: 21 }, 0);
  if (petal !== null) world.setObjectColours(petal, [19, null]);
  place(world, 'moonpetal-carousel', { x: 11, y: 16 }, 1);
  place(world, 'bumble-coach', { x: 6, y: 21 }, 1);
  place(world, 'aurora-wheel', { x: 16, y: 16 }, 3);
  place(world, 'picnic-pocket', { x: 13, y: 21 }, 0);
  place(world, 'confetti-tree', { x: 16, y: 19 }, 0);
  place(world, 'lollipop-lamp', { x: 14, y: 19 }, 0);
  place(world, 'ripple-fountain', { x: 20, y: 16 }, 0);
  place(world, 'ribbon-bench', { x: 18, y: 19 }, 0);
};

/**
 * The placeholders with a turning part on every object, so transform slots are handed out, released
 * and reused by every mutation — the slot keys in the hashes are then exercised as hard as the boxes.
 */
const TURNING: PartDriver = (motion, out) => setPoseRotation(out, 0, 0, 1, motion.spin / 700);
const turningContent: ObjectContent = {
  blueprint: (definition): Blueprint => {
    const [wide, deep] = definition.footprint;
    return {
      id: `test:turning:${definition.id}`,
      footprint: definition.footprint,
      parts: [
        { id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [4, 4, 1], size: [wide * TILE - 8, deep * TILE - 8, 6], material: MAT.CONCRETE }] },
        { id: 'top', pivot: [16, 16, 10], shapes: [{ kind: 'box', min: [12, 12, 9], size: [8, 8, 3], material: MAT.STEEL }] },
      ],
      lights: [{ position: [16, 16, 14], radius: 16, color: 0xfff4c9, presets: 6 }],
    };
  },
  drivers: { top: TURNING },
};
const TURNING_CONTENT: SceneContent = { ...PLACEHOLDER_CONTENT, objectContent: () => turningContent };

const CACHES = new Map<SceneContent, ModelCache>();
const cacheFor = (content: SceneContent): ModelCache => {
  let cache = CACHES.get(content);
  if (!cache) {
    cache = createModelCache();
    CACHES.set(content, cache);
  }
  return cache;
};

const sceneFor = (session: ParkSession, content: SceneContent): VoxelScene =>
  new VoxelScene(session, PALETTE, cacheFor(content), { content, prewarmBudgetMs: 0, reportError: () => undefined });

/** Chunk indices whose hashes differ from a scene built from scratch on the same session. */
const divergentChunks = (incremental: VoxelScene, session: ParkSession, content: SceneContent): number[] => {
  const fresh = sceneFor(session, content);
  fresh.update(16, 16, 0);
  const differing: number[] = [];
  for (let chunk = 0; chunk < incremental.chunkCount; chunk += 1) {
    if (incremental.chunkHash(chunk) !== fresh.chunkHash(chunk)) differing.push(chunk);
  }
  return differing;
};

const SEEDS = [1, 2, 3, 7, 11, 19, 23, 42, 101, 313, 997, 4_099, 31_337, 0x5eed, 0xbeef, 0xc0ffee];
const STEPS = 40;
/** How often a step swaps the incremental scene to another park instead of mutating this one. */
const SESSION_SWAP_EVERY = 13;

const effective = new Map<string, number>();

describe.each([
  ['placeholders with a turning part on everything', TURNING_CONTENT],
  ['the content authored so far', REGISTRY_CONTENT],
] as const)('incremental static world equivalence (%s)', (_name, content) => {
  it.each(SEEDS)('matches a from-scratch scene after every step (seed %i)', (seed) => {
    const rng = new Rng(seed);
    let session = new ParkSession(null);
    seedPark(session.world);
    const incremental = sceneFor(session, content);
    let elapsed = 0;
    const frame = (): void => {
      // Uneven frames, so ride motion runs while the world changes around it.
      const delta = 8 + rng.int(40);
      elapsed += delta;
      incremental.update(delta, elapsed, rng.next());
    };
    let unsubscribe = session.world.subscribe(() => incremental.syncWorld());
    const rewind: Rewind = {
      snapshot: () => {
        session.syncWithWorld();
        return session.serialize();
      },
      restore: (snapshot) => {
        if (rng.int(2) === 0) {
          session.restoreState(snapshot);
          session.syncWithWorld();
          effective.set('rewind in place', (effective.get('rewind in place') ?? 0) + 1);
          return;
        }
        unsubscribe();
        session = ParkSession.fromState(snapshot);
        incremental.setSession(session);
        unsubscribe = session.world.subscribe(() => incremental.syncWorld());
        effective.set('rewind by swap', (effective.get('rewind by swap') ?? 0) + 1);
      },
    };
    frame();
    for (let step = 0; step < STEPS; step += 1) {
      if (step % SESSION_SWAP_EVERY === SESSION_SWAP_EVERY - 1) {
        unsubscribe();
        session = new ParkSession(rng.int(3) === 0 ? null : rng.pick(SCENARIOS));
        session.world.addMoney(5_000_000, 'Equivalence test funding');
        if (rng.int(2) === 0) seedPark(session.world);
        incremental.setSession(session);
        unsubscribe = session.world.subscribe(() => incremental.syncWorld());
        effective.set('setSession', (effective.get('setSession') ?? 0) + 1);
      } else {
        const mutation = rng.pick(MUTATIONS);
        const before = session.world.version + session.world.appearanceVersion;
        let synced = false;
        mutation.run(session.world, rng, rewind, () => { synced = true; frame(); });
        if (synced || session.world.version + session.world.appearanceVersion !== before) effective.set(mutation.label, (effective.get(mutation.label) ?? 0) + 1);
      }
      frame();
      if (step % 2 === 1 || step === STEPS - 1) {
        expect(divergentChunks(incremental, session, content), `seed ${seed}, step ${step}: chunks that differ from scratch`).toEqual([]);
      }
    }
    // Simulation steps (guests, rides opening) change no geometry and must leave it equal.
    session.guests.spawnGuests(30);
    for (let tick = 0; tick < 30; tick += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
      frame();
    }
    expect(divergentChunks(incremental, session, content), `seed ${seed}: after simulation steps`).toEqual([]);
  });

  it.each(['in place', 'by swap'] as const)('a rewound demolition leaves the scene of a never-demolished park (%s)', (how) => {
    let session = new ParkSession(null);
    seedPark(session.world);
    const incremental = sceneFor(session, content);
    let unsubscribe = session.world.subscribe(() => incremental.syncWorld());
    incremental.update(16, 16, 0);
    const hashes = (): string[] => Array.from({ length: incremental.chunkCount }, (_unused, chunk) => incremental.chunkHash(chunk));
    const neverDemolished = hashes();
    session.syncWithWorld();
    const before = session.serialize();

    const rides = rideObjects(session.world);
    expect(rides.length, 'the fixture park has rides to demolish').toBeGreaterThan(1);
    for (const id of rides) session.world.bulldoze(session.world.objects.get(id)!.anchor);
    incremental.update(16, 32, 0);
    expect(hashes(), 'the demolition is visible in the scene').not.toEqual(neverDemolished);

    if (how === 'in place') {
      session.restoreState(before);
      session.syncWithWorld();
    } else {
      unsubscribe();
      session = ParkSession.fromState(before);
      incremental.setSession(session);
      unsubscribe = session.world.subscribe(() => incremental.syncWorld());
    }
    incremental.update(16, 48, 0);
    expect(hashes(), 'every demolished ride is back').toEqual(neverDemolished);
    expect(divergentChunks(incremental, session, content)).toEqual([]);
    unsubscribe();
  });

  it('exercised every kind of change', () => {
    for (const label of [...MUTATIONS.map((mutation) => mutation.label), 'setSession', 'rewind in place', 'rewind by swap']) {
      expect(effective.get(label) ?? 0, `"${label}" changed the world at least once`).toBeGreaterThan(0);
    }
  });
});
