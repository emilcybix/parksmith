import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ParkSession } from '../../../game/session/ParkSession';
import { countGraphicsDrawCalls } from '../../drawCallCounter';
import type { WorldEffect } from '../../RendererPort';
import { createViewFrame } from '../../viewRotation';
import { EFFECT_LIFETIME_MS, EFFECT_TINT, MAX_EFFECTS, RISE_STEP_MS, VoxelEffects, moneyText } from './effects';

const rig = (reduced = false) => {
  const session = new ParkSession(null);
  const root = new Container();
  const tops = new Map<number, number>();
  const effects = new VoxelEffects(root, () => session, (id) => tops.get(id) ?? null, () => reduced);
  const layer = root.children[0] as Container;
  const ride = session.world.seedScenarioObject('petal-roundabout', { x: 8, y: 8 })!;
  tops.set(ride.id, 60);
  return { session, effects, layer, rideId: ride.id, tops };
};

const effect = (overrides: Partial<WorldEffect> = {}): WorldEffect => ({ kind: 'money-spend', x: 10, y: 10, objectId: null, amount: 1_150, ...overrides });
const shownSlots = (layer: Container): Container[] => layer.children.filter((child) => child.visible) as Container[];

describe('VoxelEffects (Phase 15)', () => {
  it('writes money as "+$40", "-$1,150" and "+$12k"', () => {
    expect(moneyText(40)).toBe('+$40');
    expect(moneyText(-1_150)).toBe('-$1,150');
    expect(moneyText(12_345)).toBe('+$12,345');
    expect(moneyText(123_456)).toBe('+$123k');
  });

  it('builds every shape once: showing, running and ending effects never draws', () => {
    const { effects, rideId } = rig();
    const calls = countGraphicsDrawCalls(() => {
      effects.update(0);
      effects.show(effect());
      effects.show(effect({ kind: 'ride-cycle', objectId: rideId }));
      effects.show(effect({ kind: 'happy', x: 5.5, y: 6.25 }));
      for (let frame = 1; frame <= 120; frame += 1) effects.update(frame * 16);
    });
    expect(calls).toBe(0);
    expect(effects.isEmpty, 'all ended').toBe(true);
  });

  it('a money popup shows one tinted glyph per character, centred, whole texels', () => {
    const { effects, layer } = rig();
    effects.update(0);
    effects.show(effect());
    const [slot] = shownSlots(layer);
    const glyphs = slot.children.filter((child) => child.visible) as Graphics[];
    expect(glyphs.length).toBe('-$1,150'.length);
    for (const glyph of glyphs) {
      expect(glyph.tint).toBe(EFFECT_TINT['money-spend']);
      expect(Number.isInteger(glyph.x) && Number.isInteger(glyph.y)).toBe(true);
    }
    expect(Number.isInteger(slot.x) && Number.isInteger(slot.y)).toBe(true);
  });

  it('rises a texel a step, fades in eighths over its last third, and ends after its lifetime', () => {
    const { effects, layer } = rig();
    effects.update(1_000);
    effects.show(effect());
    const [slot] = shownSlots(layer);
    const y0 = slot.y;
    effects.update(1_000 + RISE_STEP_MS * 3);
    expect(slot.y).toBe(y0 - 3);
    expect(slot.alpha).toBe(1);
    effects.update(1_000 + EFFECT_LIFETIME_MS - 50);
    expect(slot.alpha).toBeLessThan(1);
    expect(Number.isInteger(slot.alpha * 8)).toBe(true);
    effects.update(1_000 + EFFECT_LIFETIME_MS);
    expect(slot.visible).toBe(false);
    expect(effects.isEmpty).toBe(true);
  });

  it('under reduced motion an effect neither rises nor fades, and still ends', () => {
    const { effects, layer } = rig(true);
    effects.update(0);
    effects.show(effect());
    const [slot] = shownSlots(layer);
    const y0 = slot.y;
    effects.update(EFFECT_LIFETIME_MS - 1);
    expect([slot.y, slot.alpha]).toEqual([y0, 1]);
    effects.update(EFFECT_LIFETIME_MS);
    expect(effects.isEmpty).toBe(true);
  });

  it('the pool is fixed: a burst reuses the oldest slot, never grows', () => {
    const { effects, layer } = rig();
    const children = layer.children.length;
    for (let index = 0; index < MAX_EFFECTS * 3; index += 1) {
      effects.update(index);
      effects.show(effect({ amount: index + 1 }));
    }
    expect(layer.children.length).toBe(children);
    expect(effects.active).toBe(MAX_EFFECTS);
  });

  it('an object effect sits above the object top; an unknown object is dropped; a new object (no top yet) still shows', () => {
    const { effects, layer, rideId, session, tops } = rig();
    effects.update(0);
    effects.show(effect({ kind: 'breakdown', objectId: rideId }));
    effects.show(effect({ kind: 'repair', objectId: 9_999 }));
    expect(shownSlots(layer).length).toBe(1);
    const [slot] = shownSlots(layer);
    // Ride footprint centre (9, 9): ground y = 16 x 19 = 304 + 16, lifted by the top (60) and the clearance.
    expect(slot.y).toBeLessThan(304 + 16 - 60);
    // Built this gesture: the scene has no top for it yet.
    const fresh = session.world.seedScenarioObject('picnic-pocket', { x: 20, y: 20 })!;
    effects.show(effect({ kind: 'money-spend', objectId: fresh.id }));
    effects.show(effect({ kind: 'build', objectId: fresh.id }));
    const shown = shownSlots(layer);
    expect(shown.length).toBe(3);
    const [, money, puff] = shown;
    expect(puff.y, 'the puff sits on the ground, under the money').toBeGreaterThan(money.y);
    // The scene learns the stall's top on the next frame: the popup moves above it.
    const before = money.y;
    tops.set(fresh.id, 90);
    effects.update(16);
    expect(money.y).toBeLessThan(before - 40);
  });

  it('a steady frame with nothing running keeps its version; a view turn moves running effects once', () => {
    const { effects } = rig();
    effects.update(0);
    const still = effects.version;
    for (let frame = 1; frame < 30; frame += 1) effects.update(frame * 16);
    expect(effects.version).toBe(still);
    effects.show(effect());
    const before = effects.version;
    effects.setView(createViewFrame(1, 32, 32));
    expect(effects.version).toBe(before + 1);
    effects.setView(createViewFrame(1, 32, 32));
    expect(effects.version).toBe(before + 1);
    effects.reset();
    expect(effects.isEmpty).toBe(true);
  });
});
