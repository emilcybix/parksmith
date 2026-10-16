import { describe, expect, it } from 'vitest';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import { fuzzAct, mulberry32 } from './fuzzSupport';
import { firstDifference, liveGraphDifference, stepOnce } from './determinismHarness';
import { hashState } from './hash';

/**
 * The stale-cache trap of an IN-PLACE restore (snapshot undo itself swaps to a fresh session,
 * but `restoreState` stays a supported in-place path and the renderer equivalence tests rewind through it). Two parks are built to the same version numbers (`world.version`
 * and `pathVersion`) but different contents; restoring one into the other must still land exactly,
 * which only holds if every owner's cache keyed by a version is invalidated on restore. A fresh
 * session never shows this: its caches start empty. Deleting any owner's reset (the guest
 * navigation, the operations navigation, scenery or management connectivity versions) makes one
 * variant fail.
 */

const edit = (session: ParkSession, change: () => void): void => {
  change();
  session.syncWithWorld();
};

const developmentPark = (): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.syncWithWorld();
  session.guests.spawnGuests(300);
  return session;
};

/** Anchors of the cells that can be bulldozed: bare path tiles or placed objects. */
const targets = (session: ParkSession, variant: 'paths' | 'objects'): Array<{ x: number; y: number }> => {
  if (variant === 'objects') return [...session.world.objects.values()].map((object) => ({ ...object.anchor }));
  return [...session.world.paths]
    .map((key) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y };
    })
    .filter((cell) => !session.world.objectAt(cell))
    .sort((left, right) => left.y - right.y || left.x - right.x);
};

type Variant = 'paths' | 'objects';

/**
 * Two development parks that took one DIFFERENT demolition each (so their contents differ) and then
 * ran the same scripted edits; `equalVersions` says whether their version counters ended equal,
 * which is what the trap needs.
 */
const divergedPair = (variant: Variant, seed: number) => {
  const act = fuzzAct({ kind: 'dev', cardIds: [], seed: seed + 100 });
  const source = developmentPark();
  const target = developmentPark();
  for (let tick = 0; tick < 150; tick += 1) {
    stepOnce(source);
    stepOnce(target);
  }
  const random = mulberry32(seed * 7);
  const choices = targets(source, variant);
  const first = Math.floor(random() * choices.length);
  const second = (first + 1 + Math.floor(random() * (choices.length - 1))) % choices.length;
  edit(source, () => { source.world.bulldoze(choices[first]); });
  edit(target, () => { target.world.bulldoze(choices[second]); });
  for (let tick = 150; tick < 300; tick += 1) {
    act(source, tick);
    act(target, tick);
    stepOnce(source);
    stepOnce(target);
  }
  const equalVersions = source.world.version === target.world.version && source.world.pathVersion === target.world.pathVersion;
  return { act, source, target, equalVersions };
};

const VARIANTS: readonly Variant[] = ['paths', 'objects'];
const SEEDS = [1, 2, 3, 4];

describe('in-place restore with equal version numbers but different contents', () => {
  for (const variant of VARIANTS) {
    for (const seed of SEEDS) {
      it(`${variant}, seed ${seed}`, () => {
        const { act, source, target, equalVersions } = divergedPair(variant, seed);
        // The trap needs equal counters; a seed where the scripted edits moved them apart sets no
        // trap, and the test below proves enough seeds do.
        if (!equalVersions) return;

        const saved = JSON.parse(JSON.stringify(source.serialize())) as ReturnType<ParkSession['serialize']>;
        target.restoreState(saved);
        target.syncWithWorld();
        expect(liveGraphDifference(source, target), 'right after the in-place restore').toBeNull();
        for (let tick = 300; tick < 600; tick += 1) {
          act(source, tick);
          act(target, tick);
          stepOnce(source);
          stepOnce(target);
          if (tick % 100 === 0) {
            expect(firstDifference(source.serialize(), target.serialize()), `${variant} seed ${seed} tick ${tick}`).toBeNull();
            expect(liveGraphDifference(source, target), `${variant} seed ${seed} tick ${tick}: live graph`).toBeNull();
          }
        }
        expect(hashState(source.serialize()), 'final states agree').toBe(hashState(target.serialize()));
      }, 120_000);
    }
  }

  it('is not vacuous: enough seeds really end with equal version counters', () => {
    let equalPairs = 0;
    for (const variant of VARIANTS) {
      for (const seed of SEEDS) if (divergedPair(variant, seed).equalVersions) equalPairs += 1;
    }
    expect(equalPairs, 'seeds where the version counters coincide').toBeGreaterThanOrEqual(2);
  }, 120_000);
});
