import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../game/content/catalog';
import type { BuildDefinition } from '../game/types';
import { GameWorld } from '../game/World';
import { ParkSession } from '../game/session/ParkSession';
import {
  PATH_BLOCKED_MESSAGE,
  clearHoverText,
  demolitionToast,
  obstacleMessage,
  pathBlockedMessage,
  permanentPropText,
  placementBlockReason,
  placementBlockToast,
  buildLockRefusal,
  shortfallMessage,
} from './placementFeedback';

/**
 * PA-019 had one cause: the readout and the toast were written separately, so the readout said
 * "Blocked or unaffordable" for four different problems while the toast named the real one. The
 * invariant that replaces it — and the reason this file exists — is that both surfaces put the
 * same obstacle into the same words, and that only the toast may add what to do next.
 */
const ride = BUILD_BY_ID.get('petal-roundabout') as BuildDefinition;
const carousel = BUILD_BY_ID.get('moonpetal-carousel') as BuildDefinition;

const world = (cash: number): GameWorld => {
  const created = new GameWorld(cash);
  return created;
};

describe('placement feedback wording', () => {
  it('says the same thing in the readout and the toast', () => {
    const park = world(100_000);
    park.buildObject(carousel.id, { x: 10, y: 10 });
    const cases = [
      { reason: 'locked' as const, anchor: { x: 4, y: 4 } },
      { reason: 'funds' as const, anchor: { x: 4, y: 4 } },
      { reason: 'blocked' as const, anchor: { x: 10, y: 10 } },
      { reason: 'blocked' as const, anchor: { x: 31, y: 31 } },
    ];
    for (const { reason, anchor } of cases) {
      const readout = placementBlockReason(park, reason, ride, anchor, 0);
      const toast = placementBlockToast(park, reason, ride, anchor, 0);
      expect(readout.length, `${reason} produced an empty reason`).toBeGreaterThan(0);
      expect(toast, `${reason} was worded differently in the toast`).toContain(readout);
      expect(toast.startsWith(readout), `${reason} did not open with the reason`).toBe(true);
    }
  });

  it('names the building in the way, and only the toast offers the way out', () => {
    const park = world(100_000);
    park.buildObject(carousel.id, { x: 10, y: 10 });
    const readout = placementBlockReason(park, 'blocked', ride, { x: 10, y: 10 }, 0);
    const toast = placementBlockToast(park, 'blocked', ride, { x: 10, y: 10 }, 0);
    expect(readout).toBe('Blocked by Moonpetal Carousel');
    expect(toast).toBe('Blocked by Moonpetal Carousel — press Esc to inspect it');
  });

  it('distinguishes every cause instead of merging them', () => {
    const park = world(10);
    park.buildObject(carousel.id, { x: 10, y: 10 });
    const reasons = new Set([
      placementBlockReason(park, 'locked', ride, { x: 4, y: 4 }, 0),
      placementBlockReason(park, 'funds', ride, { x: 4, y: 4 }, 0),
      placementBlockReason(park, 'blocked', ride, { x: 10, y: 10 }, 0),
      placementBlockReason(park, 'blocked', ride, { x: 31, y: 31 }, 0),
      PATH_BLOCKED_MESSAGE,
    ]);
    expect(reasons.size, 'two different problems share one wording').toBe(5);
  });

  it('states the shortfall with the real numbers, in one phrasing', () => {
    const park = world(940);
    expect(shortfallMessage(1_600, park.cash)).toBe('Need $1,600 · you have $940');
    // A build refused for funds must quote exactly that phrasing, cost included.
    expect(placementBlockReason(park, 'funds', BUILD_BY_ID.get('harbor-swings') as BuildDefinition, { x: 4, y: 4 }, 0))
      .toBe('Need $1,600 · you have $940');
  });

  it('never reports a negative balance as money the player has', () => {
    const park = world(0);
    park.addMoney(-500, 'debt');
    expect(shortfallMessage(900, park.cash)).toBe('Need $900 · you have $0');
  });

  it('detects a footprint that leaves the plot, not just an occupied one', () => {
    const park = world(100_000);
    expect(placementBlockReason(park, 'blocked', ride, { x: 31, y: 31 }, 0))
      .toBe('That footprint runs off the plot');
  });

  it('reports a path in the way of a rotated footprint', () => {
    const park = world(100_000);
    const coach = BUILD_BY_ID.get('bumble-coach') as BuildDefinition;
    park.buildPaths([{ x: 5, y: 7 }]);
    // 4×2 rotated to 2×4 reaches y+3, so the path at y=7 only blocks the rotated placement.
    expect(placementBlockReason(park, 'blocked', coach, { x: 5, y: 4 }, 0))
      .toBe('That footprint is blocked');
    expect(placementBlockReason(park, 'blocked', coach, { x: 5, y: 4 }, 1))
      .toBe('Blocked by a path');
  });
});

describe('obstacles and clearing (Phase 24)', () => {
  const canyon = (): GameWorld => new ParkSession(null, [], { mapId: 'red-rock-canyon' }).world;

  it('says what blocks a footprint: a clearable prop with its price, a permanent one, water', () => {
    const world = canyon();
    const bench = BUILD_BY_ID.get('ribbon-bench')!;
    expect(world.checkObjectBuild('ribbon-bench', { x: 27, y: 1 }, 0)).toMatchObject({ ok: false, reason: 'obstacle' });
    expect(placementBlockReason(world, 'obstacle', bench, { x: 27, y: 1 }, 0)).toBe('Blocked by Red boulder · clear it for $180');
    expect(placementBlockReason(world, 'obstacle', bench, { x: 9, y: 0 }, 0)).toBe('Blocked by Canyon wall (it cannot be cleared)');
    expect(placementBlockToast(world, 'obstacle', bench, { x: 27, y: 1 }, 0)).toBe('Blocked by Red boulder · clear it for $180');
    const sea = new ParkSession(null, [], { mapId: 'seaside-cove' }).world;
    const water = (() => {
      for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) if (sea.obstacleAt({ x, y })?.kind === 'water') return { x, y };
      throw new Error('no water');
    })();
    expect(placementBlockReason(sea, 'obstacle', bench, water, 0)).toBe('Blocked by water');
    expect(obstacleMessage(sea, water)).toBe('Blocked by water');
    expect(obstacleMessage(sea, { x: 15, y: 15 })).toBeNull();
  });

  it('a path refusal names the obstacle, else keeps the plain sentence', () => {
    const world = canyon();
    expect(pathBlockedMessage(world, { x: 27, y: 1 })).toBe('Blocked by Red boulder · clear it for $180');
    expect(pathBlockedMessage(world, { x: 14, y: 14 })).toBe(PATH_BLOCKED_MESSAGE);
  });

  it('words the bulldozer: hover headline, permanent text', () => {
    expect(clearHoverText('Red boulder', 180)).toBe('Clear Red boulder · $180');
    expect(clearHoverText('Great oak', 1234.4)).toBe('Clear Great oak · $1,234');
    expect(permanentPropText('Canyon wall')).toBe('Canyon wall cannot be cleared');
  });

  it('the toast for clearing: one prop, several, and mixed with demolitions (the old texts are unchanged)', () => {
    expect(demolitionToast(['Red boulder'], 0, 180, ['Red boulder'])).toBe('Cleared Red boulder · -$180');
    expect(demolitionToast(['Saguaro', 'Saguaro', 'Red boulder'], 0, 320, ['Saguaro', 'Saguaro', 'Red boulder'])).toBe('Cleared 3 obstacles · -$320');
    expect(demolitionToast(['a path tile', 'a path tile', 'Red boulder'], 6, 180, ['Red boulder'])).toBe('Demolished 3 tiles · $6 refunded · $180 clearing');
    expect(demolitionToast(['a path tile'], 6)).toBe('Demolished a path tile · $6 refunded');
    expect(demolitionToast([], 0)).toBe('');
  });
});

describe('why a locked entry cannot be placed (Phase 22)', () => {
  const tiki = BUILD_BY_ID.get('tiki-tumbler') as BuildDefinition;

  it('a profile lock names the scenario that grants the entry, in the readout and the toast', () => {
    const park = world(100_000);
    const lock = { kind: 'profile' as const, text: 'Clear Boardwalk Breeze in Scenario mode' };
    expect(placementBlockReason(park, 'locked', tiki, { x: 4, y: 4 }, 0, lock)).toBe('Unlock it by clearing Boardwalk Breeze (Scenario mode)');
    expect(placementBlockToast(park, 'locked', tiki, { x: 4, y: 4 }, 0, lock)).toBe('Unlock it by clearing Boardwalk Breeze (Scenario mode)');
  });

  it('a research lock keeps its old words, also with no lock given', () => {
    expect(buildLockRefusal({ kind: 'research', projectId: 'x' as never })).toBe('Complete its research project first');
    expect(buildLockRefusal(null)).toBe('Complete its research project first');
    expect(buildLockRefusal(undefined)).toBe('Complete its research project first');
  });

  it('a scenario lock names the rule', () => {
    expect(buildLockRefusal({ kind: 'scenario', conditionName: 'Dusty gears' })).toBe('Locked by this scenario: Dusty gears');
  });

  it('a session refuses a gated ride with the profile reason and builds it once the grant holds it', () => {
    const locked = new ParkSession(null);
    expect(locked.world.checkObjectBuild(tiki.id, { x: 12, y: 12 }, 0)).toMatchObject({ ok: false, reason: 'locked' });
    expect(buildLockRefusal(locked.buildLockOf(tiki.id), tiki.id)).toContain('Boardwalk Breeze');
    const granted = new ParkSession(null, [], { grant: { unlockedBuildingIds: [tiki.id], bonusIds: [] } });
    granted.world.addMoney(50_000);
    expect(granted.buildLockOf(tiki.id)).toBeNull();
    expect(granted.world.checkObjectBuild(tiki.id, { x: 12, y: 12 }, 0).ok).toBe(true);
  });
});
