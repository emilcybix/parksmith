import { describe, expect, it } from 'vitest';
import { BIOMES } from '../biomes/content';
import { BUILD_CATALOG } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { MAPS } from '../maps/content';
import { layoutOfMapId } from '../maps/parse';
import { PROP_KIND_BY_ID, PROP_KINDS } from '../maps/props';
import { GROUND_WATER, type MapId } from '../maps/types';
import { createParkSave } from '../save/version';
import { hashState } from '../save/hash';
import type { Cell, Rotation } from '../types';
import { NEUTRAL_MIX, drawDay, firstDayOf, stationaryDistribution, transitionRow } from '../weather/chain';
import { applyClimate } from '../weather/climate';
import { WeatherRandom, mixSeed } from '../weather/random';
import { WEATHER_KINDS, type ParkConditions, type WeatherKind } from '../weather/types';
import { GameWorld } from '../World';
import { ParkSession } from './ParkSession';
import { RULE_CLAMPS } from '../scenarios/rules';
import { resolvePaintTarget } from '../../app/paintGesture';
import { sessionFromSave } from './fromSave';

/**
 * Phase 24 step 1, adversarial review (role D: default identity and simulation). These tests do not repeat the
 * builders' happy paths; they sweep EVERY obstructed cell of EVERY shipped map through EVERY placement entry point,
 * charge-and-undo every clearable prop kind, watch 1,000 guests and the staff cell by cell on the densest map,
 * replay non-Meadow weather 1,000 times and across save/restore, and bound the climate terms.
 */

const key = (cell: Cell): string => `${cell.x},${cell.y}`;
const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];
const step = (session: ParkSession, ticks: number, each?: (tick: number) => void): void => {
  for (let tick = 0; tick < ticks; tick += 1) {
    session.step(GAME_CONFIG.fixedStepMs);
    each?.(tick);
  }
};

/** Every cell a prop or water stands on, per map. */
const obstructedCells = (world: GameWorld): Cell[] => {
  const cells: Cell[] = [];
  for (let y = 0; y < world.height; y += 1) for (let x = 0; x < world.width; x += 1) if (world.isObstructed({ x, y })) cells.push({ x, y });
  return cells;
};

const PLACEABLE = BUILD_CATALOG.filter((definition) => definition.kind !== 'path' && !definition.custom);

describe('nothing can be built on a prop or on water (every map, every obstructed cell, every entry point)', () => {
  it.each(MAPS.map((map) => [map.id] as const))('%s', (mapId) => {
    const layout = layoutOfMapId(mapId);
    const world = new GameWorld(10_000_000, 1, layout);
    const cells = obstructedCells(world);
    if (mapId !== 'meadow') expect(cells.length, 'a non-default map has obstacles').toBeGreaterThan(0);
    else expect(cells, 'Meadow has none').toEqual([]);
    const versionBefore = world.version;
    const cashBefore = world.cash;
    const transactionsBefore = world.transactions.length;

    // Paths: the single check, a drag across all of them, and the free scenario seeding.
    for (const cell of cells) expect(world.canPlacePath(cell), `path ${key(cell)}`).toBe(false);
    expect(world.buildPaths(cells).built).toBe(0);
    expect(world.seedScenarioPaths(cells)).toBe(0);

    // Coaster pieces at every height (elevated track does not fly over a tree either).
    for (const cell of cells) {
      for (const height of [0, 1, GAME_CONFIG.coaster.pathClearanceHeight, 12]) {
        expect(world.canPlaceCoasterPiece({ cell, height }), `coaster ${key(cell)} h${height}`).toBe(false);
      }
    }

    // Every placeable catalog object, every rotation, every anchor whose footprint covers an obstructed cell.
    const obstructed = new Set(cells.map(key));
    let checked = 0;
    for (const definition of PLACEABLE) {
      for (const rotation of ROTATIONS) {
        for (let y = -3; y < world.height; y += 1) {
          for (let x = -3; x < world.width; x += 1) {
            const footprint = world.footprintCells(definition, { x, y }, rotation);
            if (!footprint.some((cell) => obstructed.has(key(cell)))) continue;
            checked += 1;
            const check = world.checkObjectBuild(definition.id, { x, y }, rotation);
            if (check.ok) throw new Error(`${definition.id} r${rotation} at ${x},${y} is buildable over an obstacle`);
            // Inside the map and on nothing but free ground and obstacles: the typed reason is 'obstacle'.
            // Phase 21: on an estate a footprint touching land the park does not own is 'unowned' first.
            if (footprint.every((cell) => world.isInside(cell))) {
              expect(check.reason, `${definition.id} ${x},${y}`).toBe(footprint.every((cell) => world.isOwned(cell)) ? 'obstacle' : 'unowned');
            }
            expect(world.canPlace(definition, { x, y }, rotation)).toBe(false);
          }
        }
      }
    }
    if (mapId !== 'meadow') expect(checked).toBeGreaterThan(1_000);
    // buildObject and seedScenarioObject on one representative anchor per obstructed cell.
    for (const cell of cells) {
      expect(world.buildObject('lollipop-lamp', cell)).toBeNull();
      expect(world.seedScenarioObject('lollipop-lamp', cell)).toBeNull();
    }
    expect(world.cash, 'nothing was charged').toBe(cashBefore);
    expect(world.transactions.length).toBe(transactionsBefore);
    expect(world.version, 'nothing changed').toBe(versionBefore);
    expect(world.paths.size).toBe(1);
    expect(world.objects.size).toBe(0);
   }, 60_000);

  it('the paint tool never targets a prop or water: only the gate (wherever it is) and placed objects', () => {
    for (const map of MAPS) {
      const world = new GameWorld(1_000_000, 1, layoutOfMapId(map.id));
      for (const cell of obstructedCells(world)) expect(resolvePaintTarget(world, cell), `${map.id} ${key(cell)}`).toBeNull();
      expect(resolvePaintTarget(world, world.entrance)?.kind, `${map.id}: the gate is paintable where the map puts it`).toBe('gate');
    }
  });

  it('a coaster whose track crosses a prop is refused before any charge (reason is the untyped `blocked`, see the review note)', () => {
    const world = new GameWorld(10_000_000, 1, layoutOfMapId('red-rock-canyon'));
    const prop = [...world.props.values()][0];
    const before = world.cash;
    const result = world.placeCoaster('custom-coaster' as never, [{ cell: { x: prop.x, y: prop.y }, height: 6, special: null } as never], {} as never, 1000);
    // Whatever the definition id resolves to, the world never places the track and never charges.
    expect('error' in result).toBe(true);
    expect(world.cash).toBe(before);
    const coaster = BUILD_CATALOG.find((definition) => definition.custom === 'coaster');
    if (coaster) {
      const typed = world.placeCoaster(coaster.id, [{ cell: { x: prop.x, y: prop.y }, height: 6, special: null } as never], {} as never, 1000);
      expect(typed).toEqual({ error: 'blocked' });
      expect(world.cash).toBe(before);
    }
  });
});

describe('clearing: exactly one charge, the right category, undo restores land and cash', () => {
  const clearable = PROP_KINDS.filter((kind) => kind.clearCost !== null);
  const permanent = PROP_KINDS.filter((kind) => kind.clearCost === null);

  /** The first map (and prop) that uses a kind. */
  const firstUse = (kindId: string): { mapId: MapId; propId: number } | null => {
    for (const map of MAPS) {
      const prop = layoutOfMapId(map.id).props.find((candidate) => candidate.kind === kindId);
      if (prop) return { mapId: map.id, propId: prop.id };
    }
    return null;
  };

  it('every prop kind the game ships is used by some shipped map (no dead content)', () => {
    const unused = PROP_KINDS.filter((kind) => firstUse(kind.id) === null).map((kind) => kind.id);
    expect(unused).toEqual([]);
  });

  it.each(clearable.map((kind) => [kind.id] as const))('%s: one ledger row, every footprint cell, again = no-op, undo = byte-identical', (kindId) => {
    const use = firstUse(kindId)!;
    const session = new ParkSession(null, [], { mapId: use.mapId });
    session.syncWithWorld();
    const { world } = session;
    const prop = world.props.get(use.propId)!;
    const footprint = world.propFootprint(prop);
    const before = session.serialize();
    const beforeHash = hashState(before);
    const cash = world.cash;
    const rows = world.transactions.length;
    const demolitions = world.demolitions;
    const cost = world.clearCost(prop)!;
    expect(cost).toBe(PROP_KIND_BY_ID.get(kindId)!.clearCost);

    // A drag across every footprint cell twice, in one batch, like the app's bulldozer.
    world.batch(() => {
      for (let pass = 0; pass < 2; pass += 1) for (const cell of footprint) world.bulldoze(cell);
    });
    expect(world.cash, 'charged exactly once').toBe(cash - cost);
    expect(world.transactions.length).toBe(rows + 1);
    const row = world.transactions[world.transactions.length - 1];
    expect(row.category).toBe('land-clearing');
    expect(row.amount).toBe(-cost);
    expect(world.demolitions, 'a clear is not a demolition').toBe(demolitions);
    for (const cell of footprint) {
      expect(world.propAt(cell)).toBeUndefined();
      expect(world.isObstructed(cell)).toBe(world.groundAt(cell) === GROUND_WATER);
      expect(world.canPlacePath(cell)).toBe(true);
    }
    session.syncWithWorld();

    // Snapshot undo (GameApp swaps to fromState of the snapshot taken before the gesture).
    const undone = ParkSession.fromState(JSON.parse(JSON.stringify(before)));
    undone.syncWithWorld();
    expect(hashState(undone.serialize()), 'undo is byte-identical').toBe(beforeHash);
    expect(undone.world.cash).toBe(cash);
    expect(undone.world.props.get(prop.id)).toEqual(prop);
    for (const cell of footprint) expect(undone.world.isObstructed(cell)).toBe(true);
    // In-place rewind (restoreState) brings the prop back too.
    session.restoreState(JSON.parse(JSON.stringify(before)));
    session.syncWithWorld();
    expect(hashState(session.serialize())).toBe(beforeHash);
  });

  it.each(permanent.map((kind) => [kind.id] as const))('%s: refused with the typed reason, nothing moves, even with a fortune', (kindId) => {
    const use = firstUse(kindId)!;
    const session = new ParkSession(null, [], { mapId: use.mapId });
    session.world.addMoney(10_000_000);
    session.syncWithWorld();
    const { world } = session;
    const prop = world.props.get(use.propId)!;
    const hash = hashState(session.serialize());
    const version = world.version;
    for (const cell of world.propFootprint(prop)) {
      expect(world.checkClear(cell)).toEqual({ ok: false, reason: 'permanent', cost: null });
      const result = world.bulldoze(cell);
      expect(result.removed).toBe(false);
      expect(result.refused).toBe('permanent');
      expect(result.cost).toBeUndefined();
    }
    expect(world.version).toBe(version);
    expect(hashState(session.serialize())).toBe(hash);
  });

  it('the funds boundary: one dollar short refuses, the exact price clears; a cost multiplier is applied once and rounded', () => {
    const layout = layoutOfMapId('red-rock-canyon');
    const boulder = layout.props.find((prop) => prop.kind === 'red-boulder')!;
    const base = PROP_KIND_BY_ID.get('red-boulder')!.clearCost!;
    for (const multiplier of [1, 0.25, 1.333, 4]) {
      const price = Math.round(base * multiplier);
      const short = new GameWorld(price - 1, multiplier, layout);
      const result = short.bulldoze(boulder);
      expect(result).toMatchObject({ removed: false, refused: 'funds' });
      expect(short.cash).toBe(price - 1);
      expect(short.transactions).toEqual([]);
      const exact = new GameWorld(price, multiplier, layout);
      expect(exact.bulldoze(boulder)).toMatchObject({ removed: true, cost: price, refund: 0 });
      expect(exact.cash).toBe(0);
      expect(exact.transactions.map((row) => [row.amount, row.category])).toEqual([[-price, 'land-clearing']]);
    }
  });

  it('water is not clearable and never charges; the gate is never bulldozed on any map', () => {
    for (const map of MAPS) {
      const world = new GameWorld(1_000_000, 1, layoutOfMapId(map.id));
      for (let index = 0; index < world.map.ground.length; index += 1) {
        if (world.map.ground[index] !== GROUND_WATER) continue;
        const cell = { x: index % world.width, y: Math.floor(index / world.width) };
        // A pier stands on water and is permanent: refused by name, never charged. Bare water is not a prop at all.
        const pier = world.propAt(cell);
        expect(world.bulldoze(cell)).toEqual(pier ? { removed: false, refund: 0, label: null, refused: 'permanent' } : { removed: false, refund: 0, label: null });
      }
      expect(world.bulldoze(world.entrance).removed).toBe(false);
      expect(world.paths.has(key(world.entrance))).toBe(true);
      expect(world.cash).toBe(1_000_000);
    }
  });
});

/** The densest shipped map by prop cells. */
const heaviestMap = (): MapId => {
  let best: MapId = 'meadow';
  let bestCells = -1;
  for (const map of MAPS) {
    const world = new GameWorld(0, 1, layoutOfMapId(map.id));
    const cells = [...world.props.values()].reduce((sum, prop) => sum + world.propFootprint(prop).length, 0);
    if (cells > bestCells) {
      best = map.id;
      bestCells = cells;
    }
  }
  return best;
};

/** A comb of paths over the open land reachable from the gate, some rides and stalls next to it, staff hired. */
const buildBusyPark = (mapId: MapId): ParkSession => {
  const session = new ParkSession(null, [], { mapId });
  const { world } = session;
  world.addMoney(500_000);
  const reachable = new Set<string>([key(world.entrance)]);
  const queue: Cell[] = [{ ...world.entrance }];
  for (let head = 0; head < queue.length; head += 1) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: queue[head].x + dx, y: queue[head].y + dy };
      if (!world.isInside(next) || world.isObstructed(next) || reachable.has(key(next))) continue;
      reachable.add(key(next));
      queue.push(next);
    }
  }
  const candidates = new Set([...reachable].filter((entry) => {
    const [x, y] = entry.split(',').map(Number);
    return y % 3 === 0 || x % 4 === 0 || x === world.entrance.x || y === world.entrance.y;
  }));
  candidates.add(key(world.entrance));
  const joined: Cell[] = [{ ...world.entrance }];
  const seen = new Set([key(world.entrance)]);
  for (let head = 0; head < joined.length; head += 1) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { x: joined[head].x + dx, y: joined[head].y + dy };
      if (!candidates.has(key(next)) || seen.has(key(next))) continue;
      seen.add(key(next));
      joined.push(next);
    }
  }
  world.buildPaths(joined);
  const ids = ['petal-roundabout', 'moonpetal-carousel', 'picnic-pocket', 'fizz-foundry', 'comfort-cabin', 'petal-roundabout', 'picnic-pocket'];
  for (const id of ids) {
    let placed = false;
    for (let y = 0; y < world.height && !placed; y += 1) {
      for (let x = 0; x < world.width && !placed; x += 1) {
        if (!world.checkObjectBuild(id, { x, y }).ok) continue;
        const cells = world.footprintCells(BUILD_CATALOG.find((definition) => definition.id === id)!, { x, y });
        const touches = cells.some((cell) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => world.paths.has(key({ x: cell.x + dx, y: cell.y + dy }))));
        if (touches) placed = world.buildObject(id, { x, y }) !== null;
      }
    }
  }
  for (let index = 0; index < 4; index += 1) {
    session.operations.hireStaff('cleaner');
    session.operations.hireStaff('mechanic');
  }
  session.syncWithWorld();
  return session;
};

describe('guests and staff never stand on, or route through, an obstacle', () => {
  it('1,000 guests on the densest map: every tick, every guest and worker cell (current, position and route) is free land', () => {
    const mapId = heaviestMap();
    expect(['frosted-hollow', 'maple-ridge'], 'the builders\' performance test covers the densest map').toContain(mapId);
    const session = buildBusyPark(mapId);
    const { world } = session;
    session.guests.spawnGuests(1_000);
    expect(session.guests.guests.size).toBe(1_000);
    let violations = 0;
    const first: string[] = [];
    const flag = (who: string, cell: Cell): void => {
      const c = { x: Math.round(cell.x), y: Math.round(cell.y) };
      if (!world.isObstructed(c)) return;
      violations += 1;
      if (first.length < 5) first.push(`${who} at ${key(c)} tick ${world.tick}`);
    };
    let widest = 0;
    let guestTicks = 0;
    const audit = (): void => {
      widest = Math.max(widest, new Set([...session.guests.guests.values()].map((guest) => key(guest.currentCell))).size);
      guestTicks += session.guests.guests.size;
      for (const guest of session.guests.guests.values()) {
        flag(`guest ${guest.id}`, guest.currentCell);
        flag(`guest ${guest.id} position`, guest.position);
        for (let index = guest.routeIndex; index < guest.route.length; index += 1) flag(`guest ${guest.id} route`, guest.route[index]);
      }
      for (const worker of session.operations.staff.values()) {
        flag(`staff ${worker.id}`, worker.currentCell);
        flag(`staff ${worker.id} position`, worker.position);
        for (let index = worker.routeIndex; index < worker.route.length; index += 1) flag(`staff ${worker.id} route`, worker.route[index]);
      }
    };
    step(session, 1_500, (tick) => {
      if (tick % 3 === 0) audit();
      // Keep the crowd at the cap: a thin park sends guests home, the audit wants 1,000 walkers all the time.
      if (tick % 150 === 0) session.guests.spawnGuests(1_000 - session.guests.guests.size);
    });
    // Clear a few props next to paths mid-run (the land changes, the guests still never touch the rest).
    let cleared = 0;
    for (const prop of [...world.props.values()]) {
      if (cleared >= 10) break;
      if (world.checkClear({ x: prop.x, y: prop.y }).ok && world.bulldoze({ x: prop.x, y: prop.y }).removed) cleared += 1;
    }
    session.syncWithWorld();
    step(session, 1_500, (tick) => {
      if (tick % 3 === 0) audit();
      // Keep the crowd at the cap: a thin park sends guests home, the audit wants 1,000 walkers all the time.
      if (tick % 150 === 0) session.guests.spawnGuests(1_000 - session.guests.guests.size);
    });
    expect(first, 'first violations').toEqual([]);
    expect(violations).toBe(0);
    expect(cleared).toBe(10);
    // The audit watched a real crowd: guests spread over many path cells and staff exist.
    expect(widest).toBeGreaterThan(40);
    expect(guestTicks, 'about 1,000 guests audited on every sampled tick').toBeGreaterThan(900 * 1_000);
    expect(session.operations.staff.size).toBe(8);
  }, 120_000);
});

describe('weather per biome: deterministic, finite, and Meadow is exactly today', () => {
  const mixOf = (biomeId: string): readonly number[] => BIOMES.find((biome) => biome.id === biomeId)!.weatherMix;
  const chain = (seed: number, mix: readonly number[], days: number, wet = 1): string => {
    const random = new WeatherRandom(mixSeed(seed));
    let kind: WeatherKind = firstDayOf().kind;
    const out: string[] = [];
    for (let day = 0; day < days; day += 1) {
      const drawn = drawDay(kind, wet, random, mix);
      kind = drawn.kind;
      out.push(`${drawn.kind}:${drawn.slots.map((slot) => slot.intensity).join('/')}`);
    }
    return out.join(',');
  };

  it('Meadow\'s mix is the neutral mix, so its rows and draws equal the unweighted (pre-Phase-24) call bit for bit', () => {
    expect(mixOf('meadow')).toEqual(NEUTRAL_MIX);
    for (const kind of WEATHER_KINDS) {
      for (const wet of [RULE_CLAMPS.minimumMultiplier, 0.5, 1, 2, RULE_CLAMPS.maximumMultiplier]) {
        const row = transitionRow(kind, wet);
        expect(transitionRow(kind, wet, mixOf('meadow'))).toEqual(row);
        // The pre-change formula, re-derived here: weight wet columns, renormalise.
        const base = GAME_CONFIG.weather.transitions[kind];
        const wetKinds = GAME_CONFIG.weather.wetKinds as readonly string[];
        const scaled = WEATHER_KINDS.map((k, index) => base[index] * (wetKinds.includes(k) ? wet : 1));
        const total = scaled.reduce((sum, value) => sum + value, 0);
        expect(row).toEqual(scaled.map((value) => value / total));
      }
    }
    for (const seed of [0x5eed1234, 1, 0xffffffff, 77]) expect(chain(seed, mixOf('meadow'), 200)).toBe(chain(seed, NEUTRAL_MIX, 200));
  });

  it('every biome x from-kind x wet multiplier in the rule clamp gives a finite, normalised row and a finite stationary mix', () => {
    for (const biome of BIOMES) {
      for (const wet of [RULE_CLAMPS.minimumMultiplier, 1, RULE_CLAMPS.maximumMultiplier]) {
        for (const kind of WEATHER_KINDS) {
          const row = transitionRow(kind, wet, biome.weatherMix);
          expect(row.every((value) => Number.isFinite(value) && value >= 0), `${biome.id} ${kind} ${wet}`).toBe(true);
          expect(Math.abs(row.reduce((sum, value) => sum + value, 0) - 1)).toBeLessThan(1e-12);
        }
        const stationary = stationaryDistribution(wet, biome.weatherMix);
        expect(Object.values(stationary).every(Number.isFinite), biome.id).toBe(true);
      }
    }
  });

  it('1,000 replays per biome of 60 drawn days are identical (same seed + same biome = same weather)', () => {
    for (const biome of BIOMES) {
      const reference = chain(0x24a1_0003, biome.weatherMix, 60);
      for (let run = 0; run < 1_000; run += 1) if (chain(0x24a1_0003, biome.weatherMix, 60) !== reference) throw new Error(`${biome.id} run ${run}`);
    }
   }, 60_000);

  it.each(MAPS.filter((map) => map.id !== 'meadow').map((map) => [map.id] as const))('%s: a mid-run save/restore continues with the same weather, forecast and park', (mapId) => {
    const live = buildBusyPark(mapId);
    live.guests.spawnGuests(120);
    step(live, 2_500);
    const save = createParkSave(live.serialize(), { clock: { speed: 1, simulationTimeMs: live.world.tick * GAME_CONFIG.fixedStepMs }, tourNodeId: null }, 0);
    const { session: restored } = sessionFromSave(JSON.parse(JSON.stringify(save)));
    expect(restored.map.biome.id).toBe(live.map.biome.id);
    expect(restored.weather.forecast(8)).toEqual(live.weather.forecast(8));
    // Two simulated days onward (a day is dayLengthSeconds * 10 ticks).
    const ticks = live.calendar.dayLengthSeconds * 10 * 2;
    step(live, ticks);
    step(restored, ticks);
    expect(hashState(restored.weather.serialize())).toBe(hashState(live.weather.serialize()));
    expect(hashState(restored.serialize())).toBe(hashState(live.serialize()));
  }, 120_000);
});

describe('climate (heat and cold) is small, bounded and declared in GAME_CONFIG', () => {
  const blank = (): ParkConditions => ({ warmFoodBonus: 0, coldTreatBonus: 0 } as ParkConditions);
  it('temperature 0 touches nothing; |terms| never exceed the declared table; hot and cold never both apply', () => {
    const { heat, cold } = GAME_CONFIG.weather.climate;
    const zero = blank();
    applyClimate(zero, 0);
    expect(zero).toEqual(blank());
    for (let t = -1; t <= 1.0000001; t += 0.05) {
      const out = blank();
      applyClimate(out, t);
      expect(Number.isFinite(out.warmFoodBonus) && Number.isFinite(out.coldTreatBonus)).toBe(true);
      if (t > 0) {
        expect(out.coldTreatBonus).toBeGreaterThan(0);
        expect(out.coldTreatBonus).toBeLessThanOrEqual(heat.coldTreatBonus + 1e-9);
        expect(out.warmFoodBonus).toBeLessThanOrEqual(0);
        expect(out.warmFoodBonus).toBeGreaterThanOrEqual(-heat.warmFoodPenalty - 1e-9);
      } else if (t < -1e-9) {
        expect(out.warmFoodBonus).toBeGreaterThan(0);
        expect(out.warmFoodBonus).toBeLessThanOrEqual(cold.warmFoodBonus + 1e-9);
        expect(out.coldTreatBonus).toBeLessThanOrEqual(0);
        expect(out.coldTreatBonus).toBeGreaterThanOrEqual(-cold.coldTreatPenalty - 1e-9);
      }
    }
    // Every biome sits inside [-1, 1], so the table is the hard bound of the climate term in play.
    for (const biome of BIOMES) expect(Math.abs(biome.temperature)).toBeLessThanOrEqual(1);
  });

  it('the climate term reaches the live park conditions in Winter and Desert, not in Meadow, with the weather switch off too', () => {
    const term = (mapId: MapId, enabled: boolean): [number, number] => {
      const session = new ParkSession(null, [], { mapId });
      session.weather.setEnabled(enabled);
      session.weather.refresh(0);
      const neutral = new ParkSession(null, [], { mapId: 'meadow' });
      neutral.weather.setEnabled(enabled);
      neutral.weather.refresh(0);
      return [
        session.weather.conditions.warmFoodBonus - neutral.weather.conditions.warmFoodBonus,
        session.weather.conditions.coldTreatBonus - neutral.weather.conditions.coldTreatBonus,
      ];
    };
    for (const enabled of [true, false]) {
      expect(term('meadow', enabled)).toEqual([0, 0]);
      const [warm, coldTreat] = term('frosted-hollow', enabled);
      expect(warm, 'winter: hot food wanted more').toBeCloseTo(GAME_CONFIG.weather.climate.cold.warmFoodBonus, 9);
      expect(coldTreat, 'winter: drinks/treats wanted less').toBeCloseTo(-GAME_CONFIG.weather.climate.cold.coldTreatPenalty, 9);
      const [dWarm, dCold] = term('red-rock-canyon', enabled);
      expect(dCold).toBeCloseTo(GAME_CONFIG.weather.climate.heat.coldTreatBonus, 9);
      expect(dWarm).toBeCloseTo(-GAME_CONFIG.weather.climate.heat.warmFoodPenalty, 9);
    }
  });
});

describe('hostile saves: actors placed on an obstacle', () => {
  const busySave = () => {
    const session = buildBusyPark('red-rock-canyon');
    session.guests.spawnGuests(40);
    step(session, 600);
    return { session, state: JSON.parse(JSON.stringify(session.serialize())) as ReturnType<ParkSession['serialize']> };
  };

  it('a guest saved standing on a canyon wall is either refused at load or walks off without crashing or hanging', () => {
    const { session, state } = busySave();
    const wall = [...session.world.props.values()].find((prop) => prop.kind === 'canyon-wall')!;
    const guest = state.guests.guests[0];
    guest.currentCell = { x: wall.x, y: wall.y };
    guest.position = { x: wall.x, y: wall.y };
    guest.route = [{ x: wall.x, y: wall.y }];
    guest.routeIndex = 0;
    // Policy today (unchanged by Phase 24): guest cells are bounds-checked, not path-checked, so the save loads.
    const loaded = ParkSession.fromState(state);
    loaded.syncWithWorld();
    const started = performance.now();
    step(loaded, 600);
    expect(performance.now() - started).toBeLessThan(30_000);
    // A guest with no route home is taken out of the park: it never walks the canyon.
    expect(loaded.guests.guests.has(guest.id), 'the stranded guest is removed').toBe(false);
    for (const other of loaded.guests.guests.values()) expect(loaded.world.isObstructed(other.currentCell)).toBe(false);
  }, 60_000);
});
