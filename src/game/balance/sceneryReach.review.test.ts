import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../content/catalog';
import { ParkSession } from '../session/ParkSession';
import type { Cell } from '../types';

/**
 * Phase 49 measurement: what a "fully decorated" 3x3 ride needs to reach an area scenery score of 50, 75 and 100, one
 * scenery type at a time, nearest free cell first. Off by default; `SCENERY_REPORT=1 yarn vitest run
 * src/game/balance/sceneryReach.review.test.ts` prints the table recorded in BALANCE_NOTES.md ("Phase 49: scenery").
 */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const enabled = env.SCENERY_REPORT === '1';

const RIDE = { x: 14, y: 12 };
const RIDE_ID = 'petal-roundabout';

interface Reach {
  id: string;
  marks: Record<number, { pieces: number; cost: number } | null>;
  best: number;
  piecesAtBest: number;
}

const measure = (sceneryId: string): Reach => {
  const session = new ParkSession(null);
  const world = session.world;
  world.addMoney(500_000, 'scenery measurement funding');
  world.setBuildAccessPolicy(null);
  // One path along the ride's south side, as a ride's queue usually has, and nothing else nearby.
  world.buildPaths(Array.from({ length: 30 }, (_, index) => ({ x: index + 1, y: RIDE.y + 3 })).concat({ x: world.entrance.x, y: RIDE.y + 4 }));
  const ride = world.buildObject(RIDE_ID, RIDE);
  if (!ride) throw new Error('the ride does not fit');
  const definition = BUILD_BY_ID.get(sceneryId)!;
  const [width, height] = definition.footprint;
  const reach = definition.stats!.sceneryRadius!;
  // Every anchor whose footprint is within reach of the ride, nearest first (Manhattan, as the field measures).
  const distance = (cell: Cell): number => {
    const dx = Math.max(0, RIDE.x - (cell.x + width - 1), cell.x - (RIDE.x + 2));
    const dy = Math.max(0, RIDE.y - (cell.y + height - 1), cell.y - (RIDE.y + 2));
    return dx + dy;
  };
  const anchors: Cell[] = [];
  for (let y = RIDE.y - reach - height; y <= RIDE.y + 3 + reach; y += 1) {
    for (let x = RIDE.x - reach - width; x <= RIDE.x + 3 + reach; x += 1) {
      if (distance({ x, y }) >= 1 && distance({ x, y }) <= reach) anchors.push({ x, y });
    }
  }
  anchors.sort((a, b) => distance(a) - distance(b) || a.y - b.y || a.x - b.x);
  const marks: Reach['marks'] = { 50: null, 75: null, 100: null };
  let pieces = 0;
  let best = 0;
  let piecesAtBest = 0;
  for (const anchor of anchors) {
    if (!world.buildObject(sceneryId, anchor)) continue;
    pieces += 1;
    session.scenery.syncWithWorld();
    const score = session.scenery.scoreForObject(ride.id);
    if (score > best) {
      best = score;
      piecesAtBest = pieces;
    }
    for (const mark of [50, 75, 100]) {
      if (marks[mark] === null && score >= mark) marks[mark] = { pieces, cost: pieces * definition.buildCost };
    }
  }
  return { id: sceneryId, marks, best, piecesAtBest };
};

describe.skipIf(!enabled)('Phase 49: scenery reach', () => {
  it('prints what a 3x3 ride needs for 50, 75 and 100', () => {
    const rows = BUILD_CATALOG.filter((definition) => definition.kind === 'scenery').map((definition) => measure(definition.id));
    const cell = (mark: { pieces: number; cost: number } | null): string => (mark === null ? 'not reached' : `${mark.pieces} ($${mark.cost})`);
    console.log([
      '| scenery | appeal / radius | 50 | 75 | 100 | best (pieces) |',
      '|---|---|---|---|---|---|',
      ...rows.map((row) => {
        const stats = BUILD_BY_ID.get(row.id)!.stats!;
        return `| ${row.id} | ${stats.sceneryAppeal} / ${stats.sceneryRadius} | ${cell(row.marks[50])} | ${cell(row.marks[75])} | ${cell(row.marks[100])} | ${row.best} (${row.piecesAtBest}) |`;
      }),
    ].join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 120_000);
});
