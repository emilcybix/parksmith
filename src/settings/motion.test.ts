import { describe, expect, it } from 'vitest';
import { createMotionModel, resolveReducedMotion } from './motion';
import { createSettingsStore } from './settingsStore';
import { fakeEnv } from './settingsStore.test';
import { ClassicSeeThrough } from '../rendering/classicSeeThrough';
import { SeeThroughFade } from '../rendering/seeThrough';
import { WeatherLook, presentationFlags } from '../rendering/weatherLook';
import { createWeatherView } from '../game/weather/types';
import { Container, Graphics } from 'pixi.js';
import { VoxelHints } from '../rendering/voxel/overlay/hints';

describe('resolveReducedMotion', () => {
  it('system follows the OS, on and off ignore it', () => {
    expect(resolveReducedMotion('system', false)).toBe(false);
    expect(resolveReducedMotion('system', true)).toBe(true);
    expect(resolveReducedMotion('on', false)).toBe(true);
    expect(resolveReducedMotion('on', true)).toBe(true);
    expect(resolveReducedMotion('off', false)).toBe(false);
    expect(resolveReducedMotion('off', true)).toBe(false);
  });
});

const rig = () => {
  const env = fakeEnv();
  const store = createSettingsStore(env);
  const model = createMotionModel(store, env);
  return { env, store, model };
};

describe('motion model', () => {
  it('reads the effective value now, from the setting and the OS', () => {
    const { env, store, model } = rig();
    expect(model.reducedMotion()).toBe(false);
    env.os.reduced = true;
    expect(model.reducedMotion()).toBe(true);
    store.getState().update({ reducedMotion: 'off' });
    expect(model.reducedMotion()).toBe(false);
    store.getState().update({ reducedMotion: 'on' });
    env.os.reduced = false;
    expect(model.reducedMotion()).toBe(true);
  });

  it('fires once per EFFECTIVE change, never on subscribe, and an OS flip only matters in system', () => {
    const { env, store, model } = rig();
    const seen: boolean[] = [];
    const stop = model.onReducedMotionChange((reduced) => seen.push(reduced));
    expect(seen).toEqual([]);
    store.getState().update({ reducedMotion: 'on' });
    expect(seen).toEqual([true]);
    env.emitOs(true);
    env.emitOs(false);
    expect(seen).toEqual([true]);
    store.getState().update({ uiScale: 85 });
    expect(seen).toEqual([true]);
    store.getState().update({ reducedMotion: 'system' });
    expect(seen).toEqual([true, false]);
    env.emitOs(true);
    expect(seen).toEqual([true, false, true]);
    stop();
    env.emitOs(false);
    expect(seen).toHaveLength(3);
  });

  it('a change from another tab (a store write without persisting) reaches subscribers', () => {
    const { env, store, model } = rig();
    store.startSync();
    const seen: boolean[] = [];
    model.onReducedMotionChange((reduced) => seen.push(reduced));
    env.emit({ key: 'parksmith-settings', newValue: JSON.stringify({ version: 1, reducedMotion: 'on' }) });
    expect(seen).toEqual([true]);
  });

  it('releases its store and OS subscriptions when the last listener leaves', () => {
    const { env, model } = rig();
    const stopA = model.onReducedMotionChange(() => undefined);
    const stopB = model.onPresentationChange(() => undefined);
    stopA();
    stopB();
    let called = 0;
    const stopC = model.onReducedMotionChange(() => { called += 1; });
    env.emitOs(true);
    expect(called).toBe(1);
    stopC();
  });

  it('presentation prefs report motion, weather level and flashes together', () => {
    const { store, model } = rig();
    const seen: string[] = [];
    model.onPresentationChange((p) => seen.push(`${p.reducedMotion}/${p.weatherEffects}/${p.lightningFlashes}`));
    store.getState().update({ weatherEffects: 'reduced' });
    store.getState().update({ lightningFlashes: false });
    store.getState().update({ reducedMotion: 'on' });
    store.getState().update({ notifications: 'minimal' });
    expect(seen).toEqual(['false/reduced/true', 'false/reduced/false', 'true/reduced/false']);
    expect(model.getPresentation()).toEqual({ reducedMotion: true, weatherEffects: 'reduced', lightningFlashes: false });
  });

  it('getPresentation is fresh even with no listeners attached', () => {
    const { store, model } = rig();
    store.getState().update({ weatherEffects: 'off' });
    expect(model.getPresentation().weatherEffects).toBe('off');
  });
});

describe('every consumer follows one setting change together', () => {
  it('weather look, see-through fades and the hint pulse all flip on one update', () => {
    const { store, model } = rig();
    const look = new WeatherLook(presentationFlags(model.getPresentation()));
    model.onPresentationChange((p) => look.setPresentation(p));
    const fade = new SeeThroughFade(model.reducedMotion);
    expect(new ClassicSeeThrough(model.reducedMotion)).toBeDefined();
    const root = new Container();
    root.addChild(new Container(), new Container(), new Container());
    const hints = new VoxelHints(root, 2, model.reducedMotion);
    hints.set([{ cells: [{ x: 1, y: 1 }] }]);

    const storm = { ...createWeatherView(), kind: 'storm' as const, intensity: 1, flashSeed: 3 };
    const step = (): number => {
      for (let i = 0; i < 120; i += 1) look.update(storm, { day: 1, dusk: 0, night: 0 }, 16, false);
      return look.effects.cloudOffsetX;
    };
    const first = step();
    expect(step(), 'clouds drift while motion is full').not.toBe(first);
    fade.setTarget(true);
    expect(fade.value, 'the fade eases').toBeLessThan(1);

    store.getState().update({ reducedMotion: 'on' });
    expect(model.reducedMotion()).toBe(true);
    const frozen = step();
    expect(step()).toBe(frozen);
    expect(look.effects.flash).toBe(0);
    expect(fade.step(16), 'the same change makes the fade instant').toBe(1);
    hints.update(1000);
    const [bright, dim] = (root.children[2] as Container).children as Graphics[];
    expect([bright.visible, dim.visible], 'the hint stands on the bright ring').toEqual([true, false]);

    store.getState().update({ reducedMotion: 'off' });
    expect(model.reducedMotion()).toBe(false);
    const again = step();
    expect(step()).not.toBe(again);
  });
});
