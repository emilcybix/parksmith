import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../../config';
import { hash32 } from '../../weather/random';
import { GROUND_WATER } from '../types';
import { CELLS, SIZE, clearedArea, createDraft, indexOf, openArea, RESERVED_APRON, type MapDraft } from './draft';
import { generateMap, recipeOf } from './index';
import { repairDraft } from './repair';
import { weightPerCell } from './weights';
import type { PropKindId } from '../props';

/**
 * The repair pass must be bounded and always successful, whatever it is fed. These drafts bypass the generator's caps on
 * purpose (a whole map of walls cannot be placed with tryPlace): repair must cope with anything.
 */

const targets = { open: GAME_CONFIG.maps.generator.minimumOpenArea, cleared: GAME_CONFIG.maps.generator.minimumClearedArea };
const gateDraft = (): MapDraft => createDraft({ x: 15, y: 31, facing: 'north' });

/** Puts a 1x1 prop straight into the draft (no caps), keeping the counters in step so removal stays consistent. */
const force = (draft: MapDraft, kind: PropKindId, x: number, y: number): void => {
  const index = indexOf(x, y);
  if (draft.occupancy[index] !== 0 || index === indexOf(draft.gate.x, draft.gate.y)) return;
  draft.props.push({ kind, x, y, rotation: 0 });
  draft.occupancy[index] = draft.props.length;
  draft.chunkCells[(y >> 3) * 4 + (x >> 3)] += 1;
  draft.chunkWeight[(y >> 3) * 4 + (x >> 3)] += weightPerCell(kind);
  draft.totalWeight += weightPerCell(kind);
  draft.count += 1;
};

const check = (draft: MapDraft, label: string): void => {
  const { steps, log } = repairDraft(draft, targets);
  expect(openArea(draft), `${label} open`).toBeGreaterThanOrEqual(targets.open);
  expect(clearedArea(draft), `${label} cleared`).toBeGreaterThanOrEqual(targets.cleared);
  expect(steps.r1, `${label} r1`).toBeLessThanOrEqual(GAME_CONFIG.maps.generator.maxCarves);
  expect(steps.r2, `${label} r2`).toBeLessThanOrEqual(GAME_CONFIG.maps.generator.maxCarves);
  expect(steps.r3, `${label} r3`).toBeLessThanOrEqual(1);
  expect(log.length, `${label} log`).toBeLessThanOrEqual(2 * GAME_CONFIG.maps.generator.maxCarves + 1);
  for (const step of log) {
    expect(step.obstaclesAfter, `${label} ${step.phase} never adds obstacles`).toBeLessThanOrEqual(step.obstaclesBefore);
    if (step.phase !== 'r3') expect(step.detachedAfter, `${label} ${step.phase} joins a component`).toBeLessThan(step.detachedBefore);
  }
  // The apron and halo were never touched.
  for (let index = 0; index < CELLS; index += 1) {
    if ((draft.reserved[index] & RESERVED_APRON) !== 0) expect(draft.occupancy[index] === 0 && draft.ground[index] !== GROUND_WATER).toBe(true);
  }
  // Counters stay honest after removals.
  let live = 0;
  for (const prop of draft.props) if (prop) live += 1;
  expect(draft.count).toBe(live);
  expect(draft.chunkCells.reduce((a, b) => a + b, 0)).toBe(live);
};

describe('bounded repair', () => {
  it('a draft that already meets both targets needs no step', () => {
    const draft = gateDraft();
    const { steps, log } = repairDraft(draft, targets);
    expect(steps).toEqual({ r1: 0, r2: 0, r3: 0 });
    expect(log).toEqual([]);
  });

  it('the whole map walled with permanent props except the apron', () => {
    const draft = gateDraft();
    for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) if (draft.reserved[indexOf(x, y)] === 0) force(draft, 'canyon-wall', x, y);
    check(draft, 'walled');
    expect(draft.count).toBeLessThan(CELLS);
  });

  it('water everywhere except the halo', () => {
    const draft = gateDraft();
    for (let index = 0; index < CELLS; index += 1) if (draft.reserved[index] === 0) draft.ground[index] = GROUND_WATER;
    check(draft, 'flooded');
  });

  it('a checkerboard of permanent props (every other cell)', () => {
    const draft = gateDraft();
    for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) if ((x + y) % 2 === 0 && draft.reserved[indexOf(x, y)] === 0) force(draft, 'canyon-wall', x, y);
    check(draft, 'checkerboard');
  });

  it('closed rings: an enclosed pocket of open land is joined, not abandoned', () => {
    const draft = gateDraft();
    // A water ring around a 12 x 12 pocket in the far corner, and permanent walls around a second pocket.
    for (let i = 0; i < 14; i += 1) {
      for (const [x, y] of [[2 + i, 2], [2 + i, 15], [2, 2 + i], [15, 2 + i]]) draft.ground[indexOf(x, y)] = GROUND_WATER;
    }
    for (let i = 0; i < 12; i += 1) {
      for (const [x, y] of [[18 + i, 4], [18 + i, 15], [18, 4 + i], [29, 4 + i]]) force(draft, 'canyon-wall', x, y);
    }
    check(draft, 'rings');
  });

  it('a hundred pseudo-random hostile drafts: valid after repair, every loop within its cap', () => {
    for (let n = 0; n < 100; n += 1) {
      const draft = createDraft({ x: 6 + (n % 20), y: 31, facing: 'north' });
      const kindRoll = [450, 600, 750, 850][n % 4];
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const index = indexOf(x, y);
          if (draft.reserved[index] !== 0) continue;
          const roll = hash32(n, index, 3) % 1000;
          if (roll < kindRoll / 2) draft.ground[index] = GROUND_WATER;
          else if (roll < kindRoll) force(draft, roll % 2 === 0 ? 'canyon-wall' : 'red-boulder', x, y);
        }
      }
      check(draft, `hostile #${n}`);
    }
  });

  it('cannot loop: the loops are for-loops capped by maxCarves (a flood of components still ends)', () => {
    const draft = gateDraft();
    // 60 isolated single-cell pockets: more than 24 components, so the cap, not the target, ends R1 and R3 finishes the job.
    for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) if (draft.reserved[indexOf(x, y)] === 0) force(draft, 'canyon-wall', x, y);
    for (let y = 1; y < 30; y += 2) for (let x = 1; x < 30; x += 4) {
      const index = indexOf(x, y);
      if (draft.reserved[index] === 0 && draft.occupancy[index] !== 0) {
        draft.props[draft.occupancy[index] - 1] = null;
        draft.occupancy[index] = 0;
        draft.count -= 1;
        draft.chunkCells[(y >> 3) * 4 + (x >> 3)] -= 1;
        draft.chunkWeight[(y >> 3) * 4 + (x >> 3)] -= weightPerCell('canyon-wall');
        draft.totalWeight -= weightPerCell('canyon-wall');
      }
    }
    const { steps } = repairDraft(draft, targets);
    expect(steps.r1 + steps.r2).toBeLessThanOrEqual(2 * GAME_CONFIG.maps.generator.maxCarves);
    expect(openArea(draft)).toBeGreaterThanOrEqual(targets.open);
    expect(clearedArea(draft)).toBeGreaterThanOrEqual(targets.cleared);
  });

  it('stranded land: a permanent wall line meeting water, with the targets already met, still gets a gap per stranded strip (R2 joins them)', () => {
    const draft = gateDraft();
    // A wall across y = 6 (except x = 21..22) and a water column x = 21..22 from y = 0 to 6: two strips behind it (x 0..20
    // and x 23..31, rows 0..5) are cut off, while the rest of the map already meets both targets.
    for (let x = 0; x <= 20; x += 1) force(draft, 'canyon-wall', x, 6);
    for (let y = 0; y <= 6; y += 1) for (const x of [21, 22]) draft.ground[indexOf(x, y)] = GROUND_WATER;
    for (let x = 23; x < SIZE; x += 1) force(draft, 'canyon-wall', x, 6);
    expect(clearedArea(draft)).toBeGreaterThanOrEqual(targets.cleared);
    const before = clearedArea(draft);
    const { steps } = repairDraft(draft, targets);
    expect(steps).toEqual({ r1: 0, r2: 2, r3: 0 });
    // Both strips are reachable now, each through one removed wall cell (cheaper than filling water); the water stays.
    expect(clearedArea(draft)).toBe(before + 6 * 30 + 2);
    let water = 0;
    for (let index = 0; index < CELLS; index += 1) if (draft.ground[index] === GROUND_WATER) water += 1;
    expect(water).toBe(14);
  });

  it('Autumn Forest 391 (review: a stone-wall line met the stream and stranded 263 cells) and seeds 0..199 strand no land', () => {
    expect(generateMap(recipeOf('autumn-forest', 391, { density: 'normal' })).stats.stranded).toBe(0);
    const stranded: number[] = [];
    for (let seed = 0; seed < 200; seed += 1) if (generateMap(recipeOf('autumn-forest', seed, { density: 'normal' })).stats.stranded > 0) stranded.push(seed);
    expect(stranded).toEqual([]);
  }, 20_000);
});
