import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { compileParkRules, type ParkRuleset } from '../scenarios/rules';
import { ParkSession } from '../session/ParkSession';
import type { Cell, PlacedObject, Rotation } from '../types';

/**
 * Phase 16 (design 4.1): the theme affinity. A themed ride or stall gains min(maximumBonus, matching x share) on its
 * scenery score from same-theme scenery whose radius reaches its footprint; `matching` is the footprint mean of the
 * same-theme appeal field. Parks are built under an explicit `rules` option: today's compiled ruleset with the two
 * Phase 16 keys removed (so `{}` is a pre-Phase-16 park whatever the config ships), plus the patch.
 */

const rulesWith = (patch: Partial<ParkRuleset>): ParkRuleset => {
  const base: Record<string, unknown> = { ...compileParkRules() };
  delete base.themeAffinity;
  delete base.researchCostScale;
  return { ...(base as unknown as ParkRuleset), ...patch };
};

const park = (patch: Partial<ParkRuleset> = { themeAffinity: 0.3 }): ParkSession => {
  const session = new ParkSession(null, [], { rules: rulesWith(patch) });
  session.world.addMoney(100_000);
  return session;
};

const build = (session: ParkSession, definitionId: string, anchor: Cell, rotation: Rotation = 0): PlacedObject => {
  const placed = session.world.buildObject(definitionId, anchor, rotation);
  if (!placed) throw new Error(`could not place ${definitionId} at ${anchor.x},${anchor.y}`);
  session.syncWithWorld();
  return placed;
};

const cellsOf = (anchor: Cell, footprint: readonly [number, number]): Cell[] => {
  const cells: Cell[] = [];
  for (let y = anchor.y; y < anchor.y + footprint[1]; y += 1) {
    for (let x = anchor.x; x < anchor.x + footprint[0]; x += 1) cells.push({ x, y });
  }
  return cells;
};

const distance = (source: { anchor: Cell; footprint: readonly [number, number] }, cell: Cell): number => {
  const maximumX = source.anchor.x + source.footprint[0] - 1;
  const maximumY = source.anchor.y + source.footprint[1] - 1;
  const dx = cell.x < source.anchor.x ? source.anchor.x - cell.x : Math.max(0, cell.x - maximumX);
  const dy = cell.y < source.anchor.y ? source.anchor.y - cell.y : Math.max(0, cell.y - maximumY);
  return dx + dy;
};

/** The design formula, written out independently of the simulation. */
const expectedMatching = (session: ParkSession, target: PlacedObject): number => {
  const theme = BUILD_BY_ID.get(target.definitionId)!.theme;
  const footprint = cellsOf(target.anchor, BUILD_BY_ID.get(target.definitionId)!.footprint);
  let total = 0;
  for (const object of [...session.world.objects.values()].sort((left, right) => left.id - right.id)) {
    const definition = BUILD_BY_ID.get(object.definitionId)!;
    if (definition.kind !== 'scenery' || definition.theme !== theme) continue;
    const appeal = Math.min(100, definition.stats!.sceneryAppeal! * session.rules.sceneryAppealMultiplier);
    const radius = definition.stats!.sceneryRadius!;
    for (const cell of footprint) {
      const d = distance({ anchor: object.anchor, footprint: definition.footprint }, cell);
      if (d <= radius) total += appeal * (radius + 1 - d) / (radius + 1);
    }
  }
  return total / footprint.length;
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const destinationOf = (session: ParkSession, objectId: number) => session.scenery.snapshot().destinations.find((destination) => destination.objectId === objectId);

/** A Meadow park with a path spine from the gate, a carnival carousel and a garden roundabout either side of it. */
const spinePark = (patch?: Partial<ParkRuleset>) => {
  const session = park(patch);
  const entrance = session.world.entrance;
  const spine: Cell[] = [];
  for (let y = entrance.y; y >= entrance.y - 12; y -= 1) spine.push({ x: entrance.x, y });
  session.world.buildPaths(spine);
  session.syncWithWorld();
  const carousel = build(session, 'moonpetal-carousel', { x: entrance.x + 1, y: entrance.y - 8 });
  const roundabout = build(session, 'petal-roundabout', { x: entrance.x - 3, y: entrance.y - 8 });
  return { session, entrance, carousel, roundabout };
};

describe('Phase 16 theme affinity', () => {
  it('a matching piece adds min(10, share x matching); the score is the footprint average plus the bonus', () => {
    const { session, carousel } = spinePark();
    const before = destinationOf(session, carousel.id)!;
    expect(before).toMatchObject({ theme: 'carnival', themeBonus: 0, matchingSources: 0 });
    build(session, 'lollipop-lamp', { x: carousel.anchor.x + 3, y: carousel.anchor.y });
    const after = destinationOf(session, carousel.id)!;
    const matching = expectedMatching(session, carousel);
    expect(matching).toBeCloseTo(20 / 9, 10);
    expect(after.themeBonus).toBe(round2(Math.min(10, 0.3 * matching)));
    expect(after.matchingSources).toBe(1);
    // The plain field average here is the same lamp's field: 20 / 9.
    expect(after.score).toBe(round2(round2(20 / 9) + after.themeBonus));
    expect(session.scenery.scoreForObject(carousel.id)).toBe(after.score);
    expect(after.choiceBonus).toBe(round2(after.score * GAME_CONFIG.scenery.rideChoiceWeight));
  });

  it('a piece of another theme adds 0 (it still adds its plain appeal)', () => {
    const { session, carousel } = spinePark();
    build(session, 'sunburst-flowers', { x: carousel.anchor.x + 3, y: carousel.anchor.y });
    const destination = destinationOf(session, carousel.id)!;
    expect(destination).toMatchObject({ theme: 'carnival', themeBonus: 0, matchingSources: 0 });
    expect(destination.score).toBeGreaterThan(0);
  });

  it('a themeless destination (a toilet) adds 0', () => {
    const { session, entrance } = spinePark();
    const cabin = build(session, 'comfort-cabin', { x: entrance.x + 1, y: entrance.y - 3 });
    build(session, 'lollipop-lamp', { x: entrance.x + 3, y: entrance.y - 3 });
    build(session, 'sunburst-flowers', { x: entrance.x + 3, y: entrance.y - 2 });
    expect(destinationOf(session, cabin.id)).toMatchObject({ theme: null, themeBonus: 0, matchingSources: 0 });
  });

  it('absent (every park before Phase 16) means 0: the score is exactly the footprint average', () => {
    const on = spinePark();
    const off = spinePark({});
    expect('themeAffinity' in off.session.rules).toBe(false);
    for (const { session, carousel } of [on, off]) build(session, 'lollipop-lamp', { x: carousel.anchor.x + 3, y: carousel.anchor.y });
    const destination = destinationOf(off.session, off.carousel.id)!;
    expect(destination).toMatchObject({ themeBonus: 0, matchingSources: 1 });
    expect(destination.score).toBe(round2(20 / 9));
    expect(off.session.scenery.snapshot().themeAffinity).toBe(0);
    expect(on.session.scenery.snapshot().themeAffinity).toBe(0.3);
  });

  it('the bonus is capped at 10 and the score at 100', () => {
    const { session, carousel } = spinePark({ themeAffinity: 0.5, sceneryAppealMultiplier: 4 });
    // Carnival lamps and masts on the free cells of the ring around the carousel (the map's props decide which).
    let built = 0;
    for (let dy = -1; dy <= 3; dy += 1) {
      for (let dx = -1; dx <= 3; dx += 1) {
        const anchor = { x: carousel.anchor.x + dx, y: carousel.anchor.y + dy };
        const id = built % 2 === 0 ? 'lollipop-lamp' : 'bunting-mast';
        if (!session.world.canPlace(BUILD_BY_ID.get(id)!, anchor)) continue;
        build(session, id, anchor);
        built += 1;
      }
    }
    expect(built).toBeGreaterThanOrEqual(6);
    const destination = destinationOf(session, carousel.id)!;
    expect(expectedMatching(session, carousel) * 0.5).toBeGreaterThan(10);
    expect(destination.themeBonus).toBe(GAME_CONFIG.scenery.themeAffinity.maximumBonus);
    expect(destination.matchingSources).toBe(built);
    expect(destination.score).toBe(GAME_CONFIG.scenery.maximumScore);
  });

  it('derived state is restore-identical (save, restore, compare snapshots and object scores)', () => {
    const { session, carousel, roundabout } = spinePark();
    build(session, 'lollipop-lamp', { x: carousel.anchor.x + 3, y: carousel.anchor.y });
    build(session, 'bunting-mast', { x: carousel.anchor.x + 3, y: carousel.anchor.y + 2 });
    build(session, 'confetti-tree', { x: roundabout.anchor.x - 1, y: roundabout.anchor.y + 1 });
    for (let tick = 0; tick < 50; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    const restored = ParkSession.fromState(structuredClone(session.serialize()));
    const strip = (snapshot: ReturnType<ParkSession['scenery']['snapshot']>) => ({ ...snapshot, version: 0 });
    expect(strip(restored.scenery.snapshot())).toEqual(strip(session.scenery.snapshot()));
    for (const id of [carousel.id, roundabout.id]) expect(restored.scenery.scoreForObject(id)).toBe(session.scenery.scoreForObject(id));
    expect(destinationOf(restored, carousel.id)!.themeBonus).toBeGreaterThan(0);
    expect(destinationOf(restored, roundabout.id)!.themeBonus).toBeGreaterThan(0);
  });

  it('the preview equals the bonus after the build, names the raised destinations, and changes nothing', () => {
    const { session, carousel, roundabout } = spinePark();
    build(session, 'lollipop-lamp', { x: carousel.anchor.x + 3, y: carousel.anchor.y });
    const anchor = { x: carousel.anchor.x + 3, y: carousel.anchor.y + 2 };
    const versionBefore = session.scenery.snapshot().version;
    const preview = session.scenery.previewThemeBonus('bunting-mast', anchor, 0);
    expect(session.scenery.snapshot().version).toBe(versionBefore);
    expect(preview.theme).toBe('carnival');
    expect(preview.themeAffinity).toBe(0.3);
    expect(preview.reachedDestinations).toBe(1);
    expect(preview.destinations.map((entry) => entry.objectId)).toEqual([carousel.id]);
    const [entry] = preview.destinations;
    expect(entry.themeBonus).toBe(destinationOf(session, carousel.id)!.themeBonus);
    build(session, 'bunting-mast', anchor);
    expect(destinationOf(session, carousel.id)!.themeBonus).toBe(entry.previewBonus);
    expect(entry.gain).toBe(round2(entry.previewBonus - entry.themeBonus));
    // A garden piece beside the carousel raises nothing there; beside the roundabout it does.
    expect(session.scenery.previewThemeBonus('sunburst-flowers', { x: carousel.anchor.x + 3, y: carousel.anchor.y + 1 }).destinations).toEqual([]);
    const garden = session.scenery.previewThemeBonus('confetti-tree', { x: roundabout.anchor.x - 1, y: roundabout.anchor.y });
    expect(garden.destinations.map((raised) => raised.objectId)).toEqual([roundabout.id]);
  });

  it('the preview is empty for a themeless or non-scenery definition, and when the affinity is off', () => {
    const { session, carousel } = spinePark();
    expect(session.scenery.previewThemeBonus('tidy-totem', carousel.anchor)).toMatchObject({ theme: null, destinations: [] });
    expect(session.scenery.previewThemeBonus('nope', carousel.anchor)).toMatchObject({ theme: null, destinations: [] });
    expect(session.scenery.previewThemeBonus('harbor-swings', carousel.anchor)).toMatchObject({ theme: 'seaside', destinations: [] });
    const off = spinePark({});
    const preview = off.session.scenery.previewThemeBonus('lollipop-lamp', { x: off.carousel.anchor.x + 3, y: off.carousel.anchor.y });
    expect(preview).toEqual({ theme: 'carnival', themeAffinity: 0, destinations: [], reachedDestinations: 1 });
  });
});
