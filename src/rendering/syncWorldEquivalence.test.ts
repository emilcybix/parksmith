import { describe, expect, it } from 'vitest';
import type { CoasterPiece } from '../game/coaster/design';
import { COASTER_TYPE_BY_ID } from '../game/coaster/content';
import { deriveCoasterStats, validateCoasterLayout } from '../game/coaster/design';
import { BUILD_CATALOG } from '../game/content/catalog';
import type { ParkSaveV4 } from '../game/save/state';
import { ParkSession } from '../game/session/ParkSession';
import type { Cell } from '../game/types';
import type { GameWorld } from '../game/World';
import { fingerprintNode } from './sceneFingerprint';
import { WorldRenderer } from './WorldRenderer';

/**
 * `syncWorld` is incremental: it creates and destroys per-object displays, redraws the walkway
 * graphic only when the path version moves, and rebuilds a ride's plot art only when the set of
 * plot edges a path touches actually changes. Every one of those is a cache, and caches fail
 * silently — a stale fence, a leaked ride display, a decoration that stopped bobbing.
 *
 * So this file asserts the only property that matters: after any sequence of world mutations, the
 * incrementally maintained scene is *identical* to the scene a renderer built from scratch on the
 * same world. Identical means the same displays, the same transforms, the same visibility, the
 * same recorded geometry, and the same plot-art signatures.
 *
 * The sequences are seeded and include the cases the caching is most likely to get wrong: paths
 * appearing and disappearing beside a ride's plot, rides removed next to a path, batched
 * bulldozer drags, rotated footprints, and coasters.
 */

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

const RIDES = BUILD_CATALOG.filter((d) => d.kind === 'ride' && !d.custom).map((d) => d.id);
const SERVICES = BUILD_CATALOG.filter((d) => Boolean(d.stats?.serviceType)).map((d) => d.id);
const DECORATIONS = BUILD_CATALOG
  .filter((d) => d.kind === 'scenery' || d.kind === 'amenity')
  .map((d) => d.id);

const cellKey = ({ x, y }: Cell): string => `${x},${y}`;
const CARDINALS: readonly Cell[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

const randomCell = (world: GameWorld, rng: Rng): Cell =>
  ({ x: rng.int(world.width), y: rng.int(world.height) });

const line = (from: Cell, length: number, direction: Cell): Cell[] =>
  Array.from({ length }, (_unused, index) => ({
    x: from.x + direction.x * index,
    y: from.y + direction.y * index,
  }));

const rideObjects = (world: GameWorld): { id: number; anchor: Cell }[] =>
  [...world.objects.values()]
    .filter((object) => BUILD_CATALOG.find((d) => d.id === object.definitionId)?.kind === 'ride')
    .map((object) => ({ id: object.id, anchor: { ...object.anchor } }));

/** A closed rectangular loop with a straight flat station, one hill and one drop. */
const coasterLoop = (origin: Cell, width: number, depth: number): CoasterPiece[] => {
  const ring: Cell[] = [];
  for (let x = 0; x < width; x += 1) ring.push({ x: origin.x + x, y: origin.y });
  for (let y = 1; y < depth; y += 1) ring.push({ x: origin.x + width - 1, y: origin.y + y });
  for (let x = width - 2; x >= 0; x -= 1) ring.push({ x: origin.x + x, y: origin.y + depth - 1 });
  for (let y = depth - 2; y >= 1; y -= 1) ring.push({ x: origin.x, y: origin.y + y });
  // Flat station, climb to 2, cruise, then come back down to 0 before closing the loop.
  const descentStart = ring.length - 3;
  return ring.map((cell, index) => {
    let height = 0;
    if (index >= 3 && index < descentStart) height = Math.min(2, index - 2);
    else if (index >= descentStart) height = Math.max(0, ring.length - 1 - index);
    return { cell, height };
  });
};

/** The two ways a park can be put back to a snapshot, both exercised below. */
interface Rewind {
  snapshot(): ParkSaveV4;
  restore(snapshot: ParkSaveV4): void;
}

interface Mutation {
  label: string;
  /**
   * `rewind` is how the app takes a gesture back: capture the park before it, restore the snapshot
   * after it (see `Rewind`). `sync` lets a mutation push the incremental renderer through an
   * intermediate state: without it, a build and its rewind land in the same sync window and the
   * renderer never sees the thing that was built, which is precisely the window where a stale
   * cache would hide. A mutation that calls `sync` counts as having changed the world even though
   * the rewind returns the version number to where it started.
   */
  run: (world: GameWorld, rng: Rng, rewind: Rewind, sync: () => void) => void;
}

const MUTATIONS: Mutation[] = [
  {
    label: 'path tile',
    run: (world, rng) => { world.buildPaths([randomCell(world, rng)]); },
  },
  {
    label: 'path line',
    run: (world, rng) => {
      world.buildPaths(line(randomCell(world, rng), 3 + rng.int(5), rng.pick(CARDINALS)));
    },
  },
  {
    label: 'ride, random rotation',
    run: (world, rng) => {
      world.buildObject(rng.pick(RIDES), randomCell(world, rng), rng.int(4) as 0 | 1 | 2 | 3);
    },
  },
  {
    label: 'service, random rotation',
    run: (world, rng) => {
      world.buildObject(rng.pick(SERVICES), randomCell(world, rng), rng.int(4) as 0 | 1 | 2 | 3);
    },
  },
  {
    label: 'decoration',
    run: (world, rng) => { world.buildObject(rng.pick(DECORATIONS), randomCell(world, rng)); },
  },
  {
    label: 'bulldoze one cell',
    run: (world, rng) => { world.bulldoze(randomCell(world, rng)); },
  },
  {
    label: 'bulldoze drag, batched',
    run: (world, rng) => {
      const cells = line(randomCell(world, rng), 4 + rng.int(5), rng.pick(CARDINALS));
      world.batch(() => { for (const cell of cells) world.bulldoze(cell); });
    },
  },
  {
    // The case the fence signature exists for: a path appearing against a ride's plot has to
    // reopen its fence, and a path appearing one tile further away must not redraw anything.
    label: 'path beside a ride plot',
    run: (world, rng) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      const ride = rng.pick(rides);
      const object = world.objects.get(ride.id);
      if (!object) return;
      const footprint = world.objectFootprint(object);
      const cell = rng.pick(footprint);
      const direction = rng.pick(CARDINALS);
      world.buildPaths([{ x: cell.x + direction.x, y: cell.y + direction.y }]);
    },
  },
  {
    label: 'clear a path beside a ride plot',
    run: (world, rng) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      const ride = rng.pick(rides);
      const object = world.objects.get(ride.id);
      if (!object) return;
      const adjacent = world.objectFootprint(object)
        .flatMap((cell) => CARDINALS.map((d) => ({ x: cell.x + d.x, y: cell.y + d.y })))
        .filter((cell) => world.paths.has(cellKey(cell)));
      if (adjacent.length === 0) return;
      world.bulldoze(rng.pick(adjacent));
    },
  },
  {
    label: 'remove a ride',
    run: (world, rng) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      world.bulldoze(rng.pick(rides).anchor);
    },
  },
  {
    label: 'place a coaster',
    run: (world, rng) => {
      const type = COASTER_TYPE_BY_ID.get('star-chaser');
      if (!type) return;
      const pieces = coasterLoop({ x: 1 + rng.int(20), y: 1 + rng.int(20) }, 6, 4);
      if (!validateCoasterLayout(pieces, type).ok) return;
      world.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), 1_000);
    },
  },
  // A rewind puts the whole park back to a snapshot taken before a gesture, through the same
  // boundary as a load. Each of these builds (or demolishes) something and immediately rewinds,
  // so the scene has to land exactly where it started: a leaked display, a stale fence signature
  // or a cache keyed by a version that went backwards shows up as a divergence.
  {
    label: 'build an object, then rewind it',
    run: (world, rng, rewind, sync) => {
      const definitionId = rng.pick([...RIDES, ...SERVICES, ...DECORATIONS]);
      const anchor = randomCell(world, rng);
      const before = rewind.snapshot();
      if (!world.buildObject(definitionId, anchor, rng.int(4) as 0 | 1 | 2 | 3)) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'build a path drag, then rewind it',
    run: (world, rng, rewind, sync) => {
      const before = rewind.snapshot();
      const drag = world.buildPaths(line(randomCell(world, rng), 3 + rng.int(6), rng.pick(CARDINALS)));
      if (drag.built === 0) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    // The fence signature is at its most exposed here: the tile opens a ride's fence on the way
    // in and has to close it again on the way out.
    label: 'build a path beside a ride plot, then rewind it',
    run: (world, rng, rewind, sync) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      const object = world.objects.get(rng.pick(rides).id);
      if (!object) return;
      const cell = rng.pick(world.objectFootprint(object));
      const direction = rng.pick(CARDINALS);
      const before = rewind.snapshot();
      const drag = world.buildPaths([{ x: cell.x + direction.x, y: cell.y + direction.y }]);
      if (drag.built === 0) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'build a coaster, then rewind it',
    run: (world, rng, rewind, sync) => {
      const type = COASTER_TYPE_BY_ID.get('star-chaser');
      if (!type) return;
      const pieces = coasterLoop({ x: 1 + rng.int(20), y: 1 + rng.int(20) }, 6, 4);
      if (!validateCoasterLayout(pieces, type).ok) return;
      const before = rewind.snapshot();
      const placed = world.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), 1_000);
      if ('error' in placed) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    // What the Phase 11 undo could not do: a demolished ride has to come back, with its display.
    label: 'demolish a ride, then rewind it',
    run: (world, rng, rewind, sync) => {
      const rides = rideObjects(world);
      if (rides.length === 0) return;
      const before = rewind.snapshot();
      world.bulldoze(rng.pick(rides).anchor);
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'demolish a batched drag, then rewind it',
    run: (world, rng, rewind, sync) => {
      const before = rewind.snapshot();
      const cells = line(randomCell(world, rng), 4 + rng.int(5), rng.pick(CARDINALS));
      const versionBefore = world.version;
      world.batch(() => { for (const cell of cells) world.bulldoze(cell); });
      if (world.version === versionBefore) return;
      sync();
      rewind.restore(before);
    },
  },
  {
    label: 'remove a coaster by one track cell',
    run: (world, rng) => {
      const coasters = [...world.coasters.values()];
      if (coasters.length === 0) return;
      const coaster = rng.pick(coasters);
      world.bulldoze(rng.pick(coaster.pieces).cell);
    },
  },
];

/** Everything the scene consists of, normalised so only genuine differences survive. */
const describeScene = (renderer: WorldRenderer): unknown => {
  const probe = renderer.sceneProbe;
  return {
    drawnPathVersion: probe.drawnPathVersion,
    paths: probe.pathDisplay ? fingerprintNode(probe.pathDisplay) : null,
    entrance: probe.entranceDisplay ? fingerprintNode(probe.entranceDisplay) : null,
    // Layer insertion order legitimately differs — Pixi sorts by zIndex at render time — so the
    // comparison is keyed by object id instead.
    objects: [...probe.objects]
      .sort((left, right) => left.objectId - right.objectId)
      .map((object) => ({
        objectId: object.objectId,
        isRide: object.isRide,
        pathEdges: object.pathEdges,
        hasBase: object.base !== null,
        display: fingerprintNode(object.container),
      })),
    rideDisplayIds: [...probe.rideDisplayIds].sort((a, b) => a - b),
    animatedDisplayIds: [...probe.animatedDisplayIds].sort((a, b) => a - b),
    rideArtTops: [...probe.rideArtTops]
      .sort((left, right) => left[0] - right[0])
      .map(([id, top]) => [id, Math.round(top * 1_000) / 1_000]),
  };
};

const fromScratch = (session: ParkSession): unknown => {
  const renderer = new WorldRenderer(session);
  renderer.syncWorld();
  return describeScene(renderer);
};

/**
 * A small working park before the random sequence starts, so the ride-adjacent mutations have
 * targets from the first step and a run can never be trivially empty.
 */
const seedPark = (world: GameWorld): void => {
  world.addMoney(5_000_000, 'Equivalence test funding');
  world.buildPaths(line({ x: 15, y: 30 }, 14, { x: 0, y: -1 }));
  world.buildPaths(line({ x: 10, y: 20 }, 12, { x: 1, y: 0 }));
  world.buildObject('petal-roundabout', { x: 16, y: 21 });
  world.buildObject('moonpetal-carousel', { x: 11, y: 16 });
  world.buildObject('bumble-coach', { x: 6, y: 21 }, 1);
  world.buildObject('picnic-pocket', { x: 13, y: 21 });
  world.buildObject('confetti-tree', { x: 16, y: 19 });
};

/** How often each mutation genuinely changed the world, across every seed. */
const effectiveMutations = new Map<string, number>();

/** Runs the same seeded sequence twice: once rewinding in place, once swapping to a fresh session. */
const REWIND_MODES = ['restoreState in place', 'setSession(fromState)'] as const;

describe('incremental syncWorld equivalence', () => {
  const SEEDS =[1, 2, 3, 7, 11, 19, 23, 42, 101, 313, 997, 4_099, 31_337, 0x5eed, 0xbeef, 0xc0ffee];
  const STEPS = 40;
  const CASES = REWIND_MODES.flatMap((mode) => SEEDS.map((seed) => [mode, seed] as const));

  it.each(CASES)('converges on a from-scratch rebuild (%s, seed %i)', (mode, seed) => {
    const rng = new Rng(seed);
    let session = new ParkSession(null);
    seedPark(session.world);
    const incremental = new WorldRenderer(session);
    incremental.syncWorld();
    const rewind: Rewind = {
      snapshot: () => {
        session.syncWithWorld();
        return session.serialize();
      },
      restore: (snapshot) => {
        if (mode === 'restoreState in place') {
          session.restoreState(snapshot);
          session.syncWithWorld();
        } else {
          session = ParkSession.fromState(snapshot);
          incremental.setSession(session);
        }
      },
    };

    let effectiveSteps = 0;
    for (let step = 0; step < STEPS; step += 1) {
      const mutation = rng.pick(MUTATIONS);
      const versionBefore = session.world.version;
      let synced = false;
      mutation.run(session.world, rng, rewind, () => { synced = true; incremental.syncWorld(); });
      if (synced || session.world.version !== versionBefore) {
        effectiveSteps += 1;
        effectiveMutations.set(mutation.label, (effectiveMutations.get(mutation.label) ?? 0) + 1);
      }
      incremental.syncWorld();
      expect(
        describeScene(incremental),
        `${mode}, seed ${seed}, step ${step} (${mutation.label}) diverged from a from-scratch rebuild`,
      ).toEqual(fromScratch(session));
    }

    // A sequence of no-ops would pass trivially, so prove the world really moved.
    expect(effectiveSteps, `seed ${seed} barely changed the world`).toBeGreaterThan(STEPS / 4);
  });

  it.each(REWIND_MODES)('a rewound demolition leaves the scene of a never-demolished park (%s)', (mode) => {
    let session = new ParkSession(null);
    seedPark(session.world);
    const incremental = new WorldRenderer(session);
    incremental.syncWorld();
    const neverDemolished = describeScene(incremental);
    session.syncWithWorld();
    const before = session.serialize();

    const rides = rideObjects(session.world);
    expect(rides.length, 'the fixture park has rides to demolish').toBeGreaterThan(1);
    for (const ride of rides) session.world.bulldoze(ride.anchor);
    incremental.syncWorld();
    expect(describeScene(incremental), 'the demolition is visible in the scene').not.toEqual(neverDemolished);

    if (mode === 'restoreState in place') {
      session.restoreState(before);
      session.syncWithWorld();
    } else {
      session = ParkSession.fromState(before);
      incremental.setSession(session);
    }
    incremental.syncWorld();
    expect(describeScene(incremental), 'every demolished ride is back with its display').toEqual(neverDemolished);
    expect(describeScene(incremental)).toEqual(fromScratch(session));
  });

  // Runs after the seeded sequences above, and is the reason those sequences can be trusted:
  // an equivalence test that never exercised a mutation proves nothing about it.
  it('actually exercised every kind of mutation', () => {
    const never = MUTATIONS
      .map((mutation) => mutation.label)
      .filter((label) => (effectiveMutations.get(label) ?? 0) === 0);
    expect(never, 'these mutations never once changed the world').toEqual([]);
  });

  it('detects a stale fence, proving the comparison has teeth', () => {
    const session = new ParkSession(null);
    session.world.addMoney(100_000, 'Test funding');
    const renderer = new WorldRenderer(session);
    session.world.buildObject('petal-roundabout', { x: 10, y: 10 });
    renderer.syncWorld();
    const before = describeScene(renderer);

    // A path against the plot must reopen the fence, so the scene must change.
    session.world.buildPaths([{ x: 10, y: 9 }]);
    renderer.syncWorld();
    expect(describeScene(renderer)).not.toEqual(before);
    expect(describeScene(renderer)).toEqual(fromScratch(session));
  });

  it('leaves a ride plot alone when a path appears out of reach of it', () => {
    const session = new ParkSession(null);
    session.world.addMoney(100_000, 'Test funding');
    const renderer = new WorldRenderer(session);
    session.world.buildObject('petal-roundabout', { x: 4, y: 4 });
    renderer.syncWorld();
    const plotBefore = renderer.sceneProbe.objects[0];
    const baseBefore = plotBefore.base;

    session.world.buildPaths([{ x: 25, y: 25 }]);
    renderer.syncWorld();
    const plotAfter = renderer.sceneProbe.objects[0];
    expect(plotAfter.pathEdges).toBe(plotBefore.pathEdges);
    expect(plotAfter.base, 'a distant path rebuilt a ride plot for nothing').toBe(baseBefore);
  });
});
