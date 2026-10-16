import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { ENTRANCE_COLOUR_ID, COLOUR_SWATCHES, colourSlotsFor } from '../game/content/colours';
import type { PaintBrush, PaintTarget } from '../game/content/colourPresets';
import type { ColourCostMode } from '../game/content/colourCost';
import { GameWorld } from '../game/World';
import {
  PaintGesture, brushAction, brushName, judgePaint, paintedLabel, pickBrush, resolvePaintTarget, targetLabel,
  type PaintHost, type PaintUndo,
} from './paintGesture';

/** The pure model of the Paint tool: targets, verdicts and words, the eyedropper, and one gesture's undo and cost behaviour. */

const TEAL = 19;
const swatch = (index: number): PaintBrush => ({ kind: 'swatch', swatch: index });

const parkWorld = () => {
  const world = new GameWorld(500_000);
  const bench = world.buildObject('ribbon-bench', { x: 4, y: 4 })!;
  const lamp = world.buildObject('lollipop-lamp', { x: 6, y: 4 })!;
  const tree = world.buildObject('confetti-tree', { x: 8, y: 4 })!;
  const stall = world.buildObject('picnic-pocket', { x: 4, y: 8 })!;
  const ride = world.buildObject('moonpetal-carousel', { x: 12, y: 8 })!;
  const fountain = world.seedScenarioObject('ripple-fountain', { x: 20, y: 8 }, 0)!;
  return { world, bench, lamp, tree, stall, ride, fountain };
};

/** A fake ring that counts what a gesture asks of it and applies the version rule (a commit without a change is no entry). */
const fakeUndo = (world: GameWorld) => {
  const log: string[] = [];
  const entries: { id: number; kind: 'recolour'; label: string }[] = [];
  let pending: { stamp: number } | null = null;
  let label = '';
  const undo: PaintUndo = {
    begin: (kind) => { log.push(`begin:${kind}`); if (pending === null) pending = { stamp: world.appearanceVersion }; return true; },
    commit: (text) => {
      log.push('commit');
      if (pending !== null && world.appearanceVersion !== pending.stamp) entries.push({ id: entries.length + 1, kind: 'recolour', label: text || label });
      pending = null;
    },
    setPendingLabel: (text) => { label = text; },
    get hasPending() { return pending !== null; },
    get newest() { return entries.at(-1) ?? null; },
  };
  return { undo, log, entries };
};

const host = (world: GameWorld, options: { mode?: ColourCostMode; multiplier?: number } = {}) => {
  const ring = fakeUndo(world);
  const toasts: string[] = [];
  let changes = 0;
  const value: PaintHost = {
    world,
    undo: ring.undo,
    mode: () => options.mode ?? 'sandbox',
    multiplier: () => options.multiplier ?? 1,
    onChanged: () => { changes += 1; },
    toast: (text) => toasts.push(text),
  };
  return { host: value, ring, toasts, get changes() { return changes; } };
};

describe('resolvePaintTarget', () => {
  it('finds the object under any cell of its footprint, the gate by its cell, and nothing on bare ground', () => {
    const { world, ride, bench } = parkWorld();
    const target = resolvePaintTarget(world, { x: ride.anchor.x + 1, y: ride.anchor.y + 1 });
    expect(target).toMatchObject({ kind: 'object', objectId: ride.id, name: 'Moonpetal Carousel' });
    expect(target?.cells).toEqual(world.objectFootprint(ride));
    expect(resolvePaintTarget(world, bench.anchor)).toMatchObject({ objectId: bench.id, name: 'Ribbon Bench' });
    expect(resolvePaintTarget(world, world.entrance)).toEqual({ kind: 'gate', key: 'gate', definitionId: ENTRANCE_COLOUR_ID, name: 'Entrance gate', cells: [world.entrance] });
    expect(resolvePaintTarget(world, { x: 1, y: 1 })).toBeNull();
  });

  it('a coaster is targeted by any of its track cells and highlights the whole track', () => {
    const world = new GameWorld(500_000);
    // A footprint list is all the target needs of a coaster: use the world's own coaster record API through a hand-made one.
    const fake = { entrance: world.entrance, objectAt: () => ({ id: 9, definitionId: 'star-chaser', anchor: { x: 1, y: 1 }, rotation: 0 as const }), objectFootprint: () => [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }] };
    const target = resolvePaintTarget(fake, { x: 2, y: 1 });
    expect(target).toMatchObject({ definitionId: 'star-chaser', name: 'Star Chaser' });
    expect(target?.cells).toHaveLength(3);
  });
});

describe('words', () => {
  it('names a brush and what it does', () => {
    expect(brushName({ kind: 'default' })).toBe('Default colours');
    expect(brushName(swatch(TEAL))).toBe('Teal');
    expect(brushName({ kind: 'preset', presetId: 'seaside' })).toBe('Seaside');
    expect(brushName({ kind: 'copied', sourceName: 'Picnic Pocket', roles: {} })).toBe('Colours of Picnic Pocket');
    expect(brushName(swatch(99))).toBe('Default colours');
    expect(brushAction(swatch(TEAL), 'primary')).toBe('Main to Teal');
    expect(brushAction(swatch(TEAL), 'all')).toBe('Every part to Teal');
    expect(brushAction({ kind: 'default' }, 'secondary')).toBe('Accent to default');
    expect(brushAction({ kind: 'preset', presetId: 'midnight' }, 'primary')).toBe('Midnight colours');
    expect(targetLabel('secondary')).toBe('Accent');
    expect(paintedLabel(['A'])).toBe('Painted A');
    expect(paintedLabel(['A', 'B', 'C'])).toBe('Painted 3 things');
  });
});

describe('judgePaint', () => {
  it('paints, says "already" for an equal result, and skips what cannot take the brush, with the words the readout shows', () => {
    const { world, stall, tree, fountain } = parkWorld();
    const stallTarget = resolvePaintTarget(world, stall.anchor)!;
    expect(judgePaint(stallTarget, null, swatch(TEAL), 'primary')).toMatchObject({ kind: 'paint', text: 'Main to Teal', record: [TEAL, null] });
    expect(judgePaint(stallTarget, [TEAL, null], swatch(TEAL), 'primary')).toEqual({ kind: 'same', text: 'Already these colours' });
    expect(judgePaint(resolvePaintTarget(world, tree.anchor)!, null, swatch(TEAL), 'primary')).toEqual({ kind: 'skip', text: 'Trees keep their colours' });
    expect(judgePaint(resolvePaintTarget(world, fountain.anchor)!, null, swatch(TEAL), 'secondary')).toEqual({ kind: 'skip', text: 'No Accent part' });
    expect(judgePaint({ definitionId: 'sunstone-path', name: 'Sunstone Path' }, null, swatch(TEAL), 'primary')).toEqual({ kind: 'skip', text: 'Sunstone Path keeps its colours' });
  });

  it('the default swatch is no change, and a brush of the slot default stores no record', () => {
    const { world, stall } = parkWorld();
    const target = resolvePaintTarget(world, stall.anchor)!;
    expect(judgePaint(target, null, { kind: 'default' }, 'primary').kind).toBe('same');
    const slots = colourSlotsFor('picnic-pocket');
    expect(slots).toHaveLength(2);
  });
});

describe('the eyedropper', () => {
  it('copies roles, not indices: the copy of a stall paints another stall the same way', () => {
    const { world, stall } = parkWorld();
    world.setObjectColours(stall.id, [TEAL, 7]);
    const brush = pickBrush(world, resolvePaintTarget(world, stall.anchor)!)!;
    expect(brush).toMatchObject({ kind: 'copied', sourceName: 'Picnic Pocket', roles: { primary: TEAL, secondary: 7 } });
  });

  it('refuses what is not colourable, and reads the gate', () => {
    const { world, tree } = parkWorld();
    expect(pickBrush(world, resolvePaintTarget(world, tree.anchor)!)).toBeNull();
    world.setGateColours([TEAL, null, 13]);
    const brush = pickBrush(world, resolvePaintTarget(world, world.entrance)!)!;
    expect(brush).toMatchObject({ kind: 'copied', sourceName: 'Entrance gate' });
    expect(brush.kind === 'copied' && brush.roles.primary).toBe(TEAL);
    expect(brush.kind === 'copied' && brush.roles.trim).toBe(13);
  });
});

describe('PaintGesture', () => {
  const run = (setup: ReturnType<typeof parkWorld>, brush: PaintBrush, target: PaintTarget, shift: boolean, options: Parameters<typeof host>[1] = {}) => {
    const h = host(setup.world, options);
    const gesture = new PaintGesture(h.host, brush, target, shift);
    return { h, gesture };
  };

  it('opens its undo snapshot lazily: a gesture that paints nothing never begins one', () => {
    const setup = parkWorld();
    const { h, gesture } = run(setup, swatch(TEAL), 'primary', false);
    gesture.start({ x: 1, y: 1 });
    gesture.move({ x: 3, y: 2 });
    const outcome = gesture.end();
    expect(h.ring.log).toEqual([]);
    expect(outcome).toMatchObject({ changed: 0, entryId: null, charge: 0 });
  });

  it('paints each object once per gesture however many cells of it the path crosses, in one batch per move', () => {
    const setup = parkWorld();
    const { h, gesture } = run(setup, swatch(TEAL), 'primary', false);
    const version = setup.world.appearanceVersion;
    gesture.start(setup.ride.anchor);
    gesture.move({ x: setup.ride.anchor.x + 1, y: setup.ride.anchor.y + 1 });
    gesture.move({ x: setup.ride.anchor.x + 2, y: setup.ride.anchor.y });
    const outcome = gesture.end();
    expect(outcome.changed).toBe(1);
    expect(setup.world.appearanceVersion - version, 'one change, not one per cell').toBe(1);
    expect(h.changes).toBe(1);
    expect(h.ring.entries).toHaveLength(1);
    expect(outcome.entryId).toBe(1);
  });

  it('a drag along a row paints bench and lamp and skips the tree, as one entry named "Painted 2 things"', () => {
    const setup = parkWorld();
    const { h, gesture } = run(setup, swatch(TEAL), 'primary', false);
    gesture.start(setup.bench.anchor);
    gesture.move(setup.tree.anchor);
    const outcome = gesture.end();
    expect(outcome).toMatchObject({ changed: 2, label: 'Painted 2 things', lastSkip: 'Trees keep their colours' });
    expect(setup.world.objectColours(setup.bench.id)).toEqual([TEAL, null]);
    expect(setup.world.objectColours(setup.lamp.id)).toEqual([TEAL, null]);
    expect(setup.world.objectColours(setup.tree.id)).toBeNull();
    expect(h.ring.entries).toHaveLength(1);
    expect(h.ring.log.filter((entry) => entry.startsWith('begin'))).toHaveLength(2); // one per painting step, idempotent in the real ring
  });

  it('Shift at pointer down widens a swatch brush to every part and changes nothing for a preset', () => {
    const setup = parkWorld();
    const shifted = run(setup, swatch(TEAL), 'primary', true);
    expect(shifted.gesture.target).toBe('all');
    shifted.gesture.start(setup.stall.anchor);
    shifted.gesture.end();
    expect(setup.world.objectColours(setup.stall.id)).toEqual([TEAL, COLOUR_SWATCHES[TEAL].index]);
    const preset = run(parkWorld(), { kind: 'preset', presetId: 'midnight' }, 'primary', true);
    expect(preset.gesture.target).toBe('all');
  });

  it('charges ONCE at the end, from the mode and the park rule, as one construction transaction; free means nothing is posted', () => {
    const table = GAME_CONFIG.colours.recolourCostPerObject as { scenario: number; map: number };
    const saved = { ...table };
    try {
      const free = parkWorld();
      const freeRun = run(free, swatch(TEAL), 'primary', false, { mode: 'map' });
      freeRun.gesture.start(free.bench.anchor);
      freeRun.gesture.move(free.lamp.anchor);
      const freeCash = free.world.cash;
      expect(freeRun.gesture.end().charge, 'the shipped config is free').toBe(0);
      expect(free.world.cash).toBe(freeCash);
      expect(free.world.transactions.filter((entry) => entry.label === 'Repainting')).toEqual([]);

      Object.assign(table, { scenario: 15, map: 40 });
      const setup = parkWorld();
      const { h, gesture } = run(setup, swatch(TEAL), 'primary', false, { mode: 'map', multiplier: 0.5 });
      gesture.start(setup.bench.anchor);
      gesture.move(setup.lamp.anchor);
      const cash = setup.world.cash;
      expect(setup.world.cash, 'nothing is charged mid-gesture').toBe(cash);
      const outcome = gesture.end();
      expect(outcome.charge, '2 objects x round(40 x 0.5)').toBe(40);
      expect(setup.world.cash).toBe(cash - 40);
      expect(setup.world.transactions[0]).toMatchObject({ amount: -40, label: 'Repainting', category: 'construction' });
      expect(h.toasts).toEqual([]);
      const sandbox = parkWorld();
      const sandboxRun = run(sandbox, swatch(TEAL), 'primary', false, { mode: 'sandbox' });
      sandboxRun.gesture.start(sandbox.bench.anchor);
      expect(sandboxRun.gesture.end().charge, 'the Sandbox is free whatever the table says').toBe(0);
    } finally {
      Object.assign(table, saved);
    }
  });

  it('stops painting at the object it cannot pay for, keeps the earlier ones, and says so once', () => {
    const table = GAME_CONFIG.colours.recolourCostPerObject as { scenario: number; map: number };
    const saved = { ...table };
    try {
      Object.assign(table, { scenario: 50, map: 50 });
      const setup = parkWorld();
      (setup.world as unknown as { cash: number }).cash = 70;
      const { h, gesture } = run(setup, swatch(TEAL), 'primary', false, { mode: 'scenario' });
      gesture.start(setup.bench.anchor);
      gesture.move(setup.lamp.anchor);
      gesture.move(setup.stall.anchor);
      const outcome = gesture.end();
      expect(outcome).toMatchObject({ changed: 1, charge: 50, stoppedForCash: true });
      expect(setup.world.objectColours(setup.lamp.id)).toBeNull();
      expect(h.toasts).toHaveLength(1);
    } finally {
      Object.assign(table, saved);
    }
  });

  it('Ctrl+Z mid-drag (dropUndone): the release counts, names and charges only what is still painted', () => {
    const table = GAME_CONFIG.colours.recolourCostPerObject as { scenario: number; map: number };
    const saved = { ...table };
    try {
      Object.assign(table, { scenario: 20, map: 20 });
      const setup = parkWorld();
      const { h, gesture } = run(setup, swatch(TEAL), 'primary', false, { mode: 'scenario' });
      const cash = setup.world.cash;
      gesture.start(setup.bench.anchor);
      // What the ring and GameApp do on Ctrl+Z: commit the pending snapshot, restore its colours, tell the gesture.
      h.ring.undo.commit('Painted Ribbon Bench');
      setup.world.recolourBatch([{ objectId: setup.bench.id, colours: null }]);
      h.ring.entries.pop();
      gesture.dropUndone();
      gesture.move(setup.bench.anchor);
      expect(setup.world.objectColours(setup.bench.id), 'the undone object is not painted again by the same gesture').toBeNull();
      const undoneOnly = gesture.changed;
      gesture.move(setup.lamp.anchor);
      const outcome = gesture.end();
      expect(undoneOnly).toBe(0);
      expect(outcome).toMatchObject({ changed: 1, charge: 20, label: 'Painted Lollipop Lamp' });
      expect(setup.world.cash).toBe(cash - 20);
      expect(h.ring.entries).toEqual([{ id: 1, kind: 'recolour', label: 'Painted Lollipop Lamp' }]);

      const alone = parkWorld();
      const lone = run(alone, swatch(TEAL), 'primary', false, { mode: 'scenario' });
      const loneCash = alone.world.cash;
      lone.gesture.start(alone.bench.anchor);
      lone.h.ring.undo.commit('Painted Ribbon Bench');
      alone.world.recolourBatch([{ objectId: alone.bench.id, colours: null }]);
      lone.gesture.dropUndone();
      expect(lone.gesture.end()).toMatchObject({ changed: 0, charge: 0 });
      expect(alone.world.cash, 'nothing left painted, nothing charged').toBe(loneCash);
      expect(alone.world.transactions.filter((entry) => entry.label === 'Repainting')).toEqual([]);
    } finally {
      Object.assign(table, saved);
    }
  });

  it('is idempotent at the end and ignores moves after it', () => {
    const setup = parkWorld();
    const { gesture } = run(setup, swatch(TEAL), 'primary', false);
    gesture.start(setup.bench.anchor);
    const first = gesture.end();
    gesture.move(setup.lamp.anchor);
    const second = gesture.end();
    expect(first.changed).toBe(1);
    expect(second.changed).toBe(1);
    expect(setup.world.objectColours(setup.lamp.id)).toBeNull();
  });

  it('paints the gate by its cell and counts it as one object', () => {
    const setup = parkWorld();
    const { gesture } = run(setup, swatch(TEAL), 'primary', false);
    gesture.start(setup.world.entrance);
    expect(gesture.end().changed).toBe(1);
    expect(setup.world.gateColours).toEqual([TEAL, null, null]);
  });
});
