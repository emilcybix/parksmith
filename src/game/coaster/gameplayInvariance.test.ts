import { describe, expect, it } from 'vitest';
import { coasterHeadIndex } from '../../rendering/coasterTrain';
import { GAME_CONFIG } from '../config';
import type { Guest } from '../guests/types';
import { RideSimulation } from '../rides/RideSimulation';
import { GameWorld } from '../World';
import { COASTER_TYPE_BY_ID } from './content';
import { coasterBaseCost, coasterSpeedProfile, deriveCoasterStats, validateCoasterLayout } from './design';
import type { CoasterPiece } from './design';
import golden from './gameplayInvariance.golden.json';
import { hillDipLayout, loopOvalLayout, ovalLayout, zigzagLayout } from './testLayouts';

/**
 * Phase 27 is visual only. This pins every coaster gameplay number (derived stats, cost, speed
 * profile, the train's piece index over a cycle, a full simulated cycle in a world, the serialised
 * world) to golden values captured BEFORE the rounded centre line existed
 * (`gameplayInvariance.golden.json`). Rounded corners and smooth heights must not move any of them.
 * Regenerate it only for an intentional gameplay change: print `normalise(report())` from this
 * file and replace the JSON.
 */

interface Case { name: string; typeId: string; pieces: () => CoasterPiece[] }
const CASES: readonly Case[] = [
  { name: 'oval-comet', typeId: 'comet-trail', pieces: () => ovalLayout() },
  { name: 'oval-chaser', typeId: 'star-chaser', pieces: () => ovalLayout() },
  { name: 'zigzag-chaser', typeId: 'star-chaser', pieces: () => zigzagLayout() },
  { name: 'hilldip-serpent', typeId: 'skyline-serpent', pieces: () => hillDipLayout() },
  { name: 'loops-serpent', typeId: 'skyline-serpent', pieces: () => loopOvalLayout() },
];

const guest = (id: number): Guest => ({
  id,
  position: { x: 1, y: 1 },
  currentCell: { x: 1, y: 1 },
  route: [{ x: 1, y: 1 }],
  routeIndex: 1,
  routeVersion: 0,
  state: 'wandering',
  destinationObjectId: null,
  money: 60,
  happiness: 70,
  hunger: 10,
  thirst: 10,
  toiletNeed: 10,
  energy: 90,
  preferredIntensity: 45,
  currentThought: '',
  thoughtObjectId: null,
  patienceSeconds: 120,
  lastQueueWaitSeconds: 0,
  lastRideSatisfaction: null,
  lastPurchaseSatisfaction: null,
  servicePriceLimit: null,
  recentRideIds: [],
  recentServiceIds: [],
  ageSeconds: 0,
  maximumVisitSeconds: 10_000,
  stateTimerSeconds: 0,
  needTimerSeconds: 0,
  color: 0xffffff,
  accent: 0xffffff,
  nausea: 0,
  warmth: 50,
  souvenirs: 0,
  activity: null,
} as Guest);

const describeCase = (entry: Case): unknown => {
  const type = COASTER_TYPE_BY_ID.get(entry.typeId)!;
  const pieces = entry.pieces();
  const stats = deriveCoasterStats(pieces, type);
  const profile = coasterSpeedProfile(pieces);
  const record = { pieces, stats: { durationSeconds: stats.durationSeconds, travelSeconds: stats.travelSeconds } };
  const heads: number[] = [];
  for (let step = 0; step <= 40; step += 1) {
    const remaining = stats.durationSeconds * (1 - step / 40);
    heads.push(coasterHeadIndex(record, remaining));
  }
  const world = new GameWorld(50_000, 1);
  const placed = world.placeCoaster(type.definitionId, pieces, stats, coasterBaseCost(pieces, type)) as { id: number };
  const rides = new RideSimulation(world);
  const runtime = rides.getRide(placed.id)!;
  const rider = guest(1);
  const joined = rides.joinQueue(placed.id, rider);
  const guests = new Map([[rider.id, rider]]);
  const ticks = Math.ceil(GAME_CONFIG.rides.maximumDispatchWaitSeconds * 10) + Math.ceil(stats.durationSeconds * 10) + 2;
  for (let tick = 0; tick < ticks; tick += 1) rides.step(100, guests);
  return {
    valid: validateCoasterLayout(pieces, type),
    stats,
    profile,
    cost: coasterBaseCost(pieces, type),
    heads,
    sim: {
      joined,
      completedCycles: runtime.completedCycles,
      ridersToday: runtime.ridersToday,
      condition: runtime.condition,
      cash: world.cash,
      snapshot: rides.snapshot(placed.id),
    },
    world: world.serialize(),
  };
};

const report = (): unknown => Object.fromEntries(CASES.map((entry) => [entry.name, describeCase(entry)]));
const normalise = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('coaster gameplay is independent of the rendered centre line', () => {
  it('matches the golden values captured before Phase 27', () => {
    expect(normalise(report())).toEqual(golden);
  });
});
