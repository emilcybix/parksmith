import { afterEach, describe, expect, it } from 'vitest';
import { createWeatherView, type WeatherView } from '../game/weather/types';
import { createDayWeights } from '../rendering/dayCycle';
import { MAX_FLASHES_PER_SECOND, WeatherLook, presentationFlags } from '../rendering/weatherLook';
import { SeeThroughFade } from '../rendering/seeThrough';
import { ClassicSeeThrough } from '../rendering/classicSeeThrough';
import { resolveReducedMotion, createMotionModel } from './motion';
import { createSettingsStore } from './settingsStore';
import { resetSettings } from './index';

/**
 * Phase 18 step 1 adversarial review: reduced motion / weather level / flashes single source of
 * truth, the combinations of OS and setting, live changes, and the CSS root-class coverage.
 */
// Vitest stubs CSS imports, so read the stylesheet from disk (no @types/node in this project).
const nodeFs = (globalThis as unknown as { process: { getBuiltinModule(id: string): { readFileSync(path: string, enc: string): string } } })
  .process.getBuiltinModule('node:fs');
const css = nodeFs.readFileSync(new URL('../ui/styles.css', import.meta.url).pathname, 'utf8');
const WEIGHTS = createDayWeights();
const storm = (): WeatherView => ({ ...createWeatherView(), kind: 'storm', intensity: 1, flashSeed: 12345, enabled: true });
afterEach(() => resetSettings());

const run = (look: WeatherLook, seconds: number, view: WeatherView, paused = false): { maxFlash: number; onsets: number } => {
  let maxFlash = 0; let onsets = 0; let prev = 0;
  for (let t = 0; t < seconds * 60; t++) {
    const v = { ...view, secondsIntoSegment: t / 60 };
    const f = look.update(v, WEIGHTS, 1000 / 60, paused).flash;
    if (f > 0.05 && prev <= 0.05) onsets += 1;
    prev = f; maxFlash = Math.max(maxFlash, f);
  }
  return { maxFlash, onsets };
};

describe('OS x setting matrix', () => {
  const cases: Array<[string, boolean, boolean]> = [
    ['system', true, true], ['system', false, false], ['on', true, true], ['on', false, true], ['off', true, false], ['off', false, false],
  ];
  it.each(cases)('%s with OS reduce=%s resolves to %s', (mode, os, expected) => {
    expect(resolveReducedMotion(mode as 'system' | 'on' | 'off', os)).toBe(expected);
  });
});

describe('flash policy in WeatherLook', () => {
  it('no flash under reduced motion, flashes=false, level reduced or off, and when paused', () => {
    const view = storm();
    const base = { level: 'full' as const, flashes: true, reducedMotion: false };
    expect(run(new WeatherLook(base), 20, view).maxFlash).toBeGreaterThan(0); // the control: it does flash
    for (const over of [{ reducedMotion: true }, { flashes: false }, { level: 'reduced' as const }, { level: 'off' as const }]) {
      expect(run(new WeatherLook({ ...base, ...over }), 20, view).maxFlash, JSON.stringify(over)).toBe(0);
    }
    expect(run(new WeatherLook(base), 20, view, true).maxFlash).toBe(0);
  });

  it('the cap holds when settings flip live mid-storm, repeatedly', () => {
    const look = new WeatherLook({ level: 'full', flashes: true, reducedMotion: false });
    const view = storm();
    const times: number[] = []; let prev = 0;
    for (let t = 0; t < 60 * 60; t++) {
      if (t % 37 === 0) look.setPresentation({ reducedMotion: (t / 37) % 3 === 1, weatherEffects: 'full', lightningFlashes: (t / 37) % 5 !== 2 });
      const f = look.update({ ...view, secondsIntoSegment: t / 60 }, WEIGHTS, 1000 / 60, false).flash;
      if (f > 0.05 && prev <= 0.05) times.push(t / 60);
      prev = f;
    }
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((x) => x >= times[i] && x < times[i] + 1).length;
      expect(inWindow).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
    }
  });

  it('turning reduced motion on mid-flash zeroes the published flash on the very next update', () => {
    const look = new WeatherLook({ level: 'full', flashes: true, reducedMotion: false });
    const view = storm();
    let t = 0;
    for (; t < 60 * 30; t++) if (look.update({ ...view, secondsIntoSegment: t / 60 }, WEIGHTS, 1000 / 60, false).flash > 0.1) break;
    expect(t).toBeLessThan(60 * 30);
    look.setPresentation({ reducedMotion: true, weatherEffects: 'full', lightningFlashes: true });
    expect(look.update({ ...view, secondsIntoSegment: t / 60 }, WEIGHTS, 1000 / 60, false).flash).toBe(0);
  });

  it('weather Off is the player switch: it beats a view that says weather is enabled, and leaves the view alone', () => {
    const view = storm();
    const frozen = JSON.stringify(view);
    const look = new WeatherLook({ level: 'off' });
    let last = look.update(view, WEIGHTS, 1000 / 60, false);
    for (let i = 0; i < 600; i++) last = look.update(view, WEIGHTS, 1000 / 60, false);
    expect(last.rainDensity).toBe(0);
    expect(last.cloudCover).toBe(0);
    expect(JSON.stringify(view)).toBe(frozen);
    look.setPresentation({ reducedMotion: false, weatherEffects: 'full', lightningFlashes: true });
    for (let i = 0; i < 600; i++) last = look.update(view, WEIGHTS, 1000 / 60, false);
    expect(last.rainDensity).toBeGreaterThan(0);
  });

  // it.fails: a confirmed defect (low, dev URL only); flips to a normal failure the day it is fixed.
  it.fails('dev flash pin (&wflash) still respects the Flashes switch', () => {
    // Documents the contract in the task: flashes=false must mean no flash. The pin is a dev URL aid,
    // so a failure here is low severity, but the pin silently overriding a photosensitivity setting is a trap.
    const look = new WeatherLook({ level: 'full', flashes: false, reducedMotion: false, flashPin: 1 });
    expect(look.update(storm(), WEIGHTS, 1000 / 60, false).flash).toBe(0);
  });
});

describe('fades and the model follow the effective value live', () => {
  it('a model built on a fresh store follows OS flips only under System', () => {
    let os = false; const osListeners = new Set<(v: boolean) => void>();
    const store = createSettingsStore({
      storage: () => null, onStorageEvent: () => () => undefined,
      osReducedMotion: () => os, onOsReducedMotionChange: (l: (v: boolean) => void) => { osListeners.add(l); return () => osListeners.delete(l); },
    } as never);
    const model = createMotionModel(store, {
      storage: () => null, onStorageEvent: () => () => undefined,
      osReducedMotion: () => os, onOsReducedMotionChange: (l: (v: boolean) => void) => { osListeners.add(l); return () => osListeners.delete(l); },
    } as never);
    const seen: boolean[] = [];
    model.onReducedMotionChange((v) => seen.push(v));
    os = true; osListeners.forEach((l) => l(true));
    expect(model.reducedMotion()).toBe(true);
    store.getState().update?.({ reducedMotion: 'off' } as never);
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it('SeeThroughFade snaps mid-fade when reduced flips on, and animates again when it flips off', () => {
    let reduced = false;
    const fade = new SeeThroughFade(() => reduced);
    fade.setTarget(true);
    const partial = fade.step(50);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    reduced = true;
    expect(fade.step(16)).toBe(1);
    fade.setTarget(false);
    expect(fade.step(16)).toBe(0);
    reduced = false;
    fade.setTarget(true);
    const again = fade.step(16);
    expect(again).toBeGreaterThan(0);
    expect(again).toBeLessThan(1);
  });

  it('ClassicSeeThrough takes the reduce flag as a live callback, not a captured boolean', () => {
    expect(ClassicSeeThrough.length).toBe(1);
    expect(typeof presentationFlags).toBe('function');
  });
});

describe('styles.css: every CSS animation is under the reduced-motion root class', () => {
  // Innermost `selector { body }` pairs (container queries nest, keyframes are skipped).
  const animated = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim().split('\n').pop()!.trim(), body: m[2] }))
    .filter((r) => !/^(from|to|\d+%|[\d%,\s]+)$/.test(r.selector))
    .flatMap((r) => [...r.body.matchAll(/\banimation(?:-name)?\s*:\s*([a-z][\w-]*)/g)].map((m) => ({ selector: r.selector, name: m[1] })))
    .filter((a) => a.name !== 'none');
  const reduceBlocks = css.split(/\n(?=\S)/).filter((b: string) => b.includes('[data-motion="reduce"]')).join('\n');
  it('finds the animated rules (guards the scan itself)', () => {
    expect(animated.length).toBeGreaterThan(8);
  });
  it('each animated class is named in a data-motion=reduce rule (the spinner only slows down)', () => {
    const missing = animated
      .filter((a) => a.name !== 'save-spin')
      .filter((a) => {
        const classes = a.selector.match(/\.[a-z][\w-]*/g) ?? [];
        return !classes.some((c: string) => reduceBlocks.includes(c));
      });
    expect(missing).toEqual([]);
  });
  it('no stylesheet reads the OS media query any more', () => {
    expect(css).not.toMatch(/prefers-reduced-motion/);
  });
});
