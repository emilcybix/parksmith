import { Container, Sprite } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSettings, updateSettings } from '../settings';
import { GAME_CONFIG } from '../game/config';
import { ParkSession } from '../game/session/ParkSession';
import { createWeatherView, type WeatherKind, type WeatherView } from '../game/weather/types';
import { classicTint, CLASSIC_WEATHER_FLOOR } from './classicDayTint';
import { CLASSIC_CLOUD_POOL, CLASSIC_RAIN_POOL, ClassicWeather } from './classicWeather';
import { createDayWeights, dayWeights } from './dayCycle';
import { countGraphicsDrawCalls } from './drawCallCounter';
import { createWeatherEffects, WeatherLook } from './weatherLook';
import { WorldRenderer } from './WorldRenderer';

const SCREEN = { width: 1280, height: 720 };
const FIELD = { x: -1000, y: 0, width: 2000, height: 1000 };
const makePool = (): ClassicWeather => new ClassicWeather(() => SCREEN, () => FIELD);
const weights = (hour: number) => dayWeights(createDayWeights(), hour / 24);
const channels = (tint: number): number[] => [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
const viewOf = (kind: WeatherKind, intensity: number, over: Partial<WeatherView> = {}): WeatherView => (
  { ...createWeatherView(), kind, intensity, ...over }
);
const count = (root: Container): number => root.children.reduce((sum, child) => sum + count(child as Container), 1);

const stormEffects = (reducedMotion = false) => {
  const look = new WeatherLook({ reducedMotion, pin: { kind: 'storm', intensity: 1 } });
  const effects = look.update(createWeatherView(), weights(12), 16, false);
  return { look, effects };
};

describe('classic weather pool', () => {
  it('creates its whole pool once and draws nothing', () => {
    let pool: ClassicWeather | null = null;
    const draws = countGraphicsDrawCalls(() => { pool = makePool(); });
    expect(draws).toBe(0);
    expect(pool!.displayCount).toBe(CLASSIC_CLOUD_POOL + CLASSIC_RAIN_POOL + 2);
    expect(count(pool!.cloudLayer) - 1).toBe(CLASSIC_CLOUD_POOL);
    expect(count(pool!.rainLayer) - 1).toBe(CLASSIC_RAIN_POOL);
  });

  it('shows nothing for a clear sky', () => {
    const pool = makePool();
    pool.apply(createWeatherEffects());
    expect(pool.cloudLayer.visible).toBe(false);
    expect(pool.rainLayer.visible).toBe(false);
  });

  it('rain density sets how many streaks show, and streaks stay on screen', () => {
    const pool = makePool();
    const look = new WeatherLook({ pin: { kind: 'rain', intensity: 1 } });
    const effects = look.update(createWeatherView(), weights(12), 16, false);
    pool.apply(effects);
    const streaks = pool.rainLayer.children as Sprite[];
    const visible = streaks.filter((sprite) => sprite.visible);
    expect(visible.length).toBe(Math.round(CLASSIC_RAIN_POOL * effects.rainDensity));
    for (const sprite of visible) {
      expect(sprite.x).toBeGreaterThanOrEqual(0);
      expect(sprite.x).toBeLessThan(SCREEN.width);
      expect(sprite.y).toBeGreaterThanOrEqual(0);
      expect(sprite.y).toBeLessThan(SCREEN.height);
    }
  });

  it('creates no display object over many frames of every weather, and never draws', () => {
    const pool = makePool();
    const before = count(pool.cloudLayer) + count(pool.rainLayer);
    const look = new WeatherLook({ pin: { kind: 'storm', intensity: 1 } });
    const draws = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 600; frame += 1) pool.apply(look.update(createWeatherView(), weights(12), 16, false));
    });
    expect(draws).toBe(0);
    expect(count(pool.cloudLayer) + count(pool.rainLayer)).toBe(before);
  });

  it('streaks fall while the game runs and stand still while paused', () => {
    const pool = makePool();
    const look = new WeatherLook({ pin: { kind: 'rain', intensity: 1 } });
    const y = (): number => (pool.rainLayer.children[0] as Sprite).y;
    pool.apply(look.update(createWeatherView(), weights(12), 16, false));
    const running = y();
    for (let frame = 0; frame < 10; frame += 1) pool.apply(look.update(createWeatherView(), weights(12), 16, false));
    expect(y()).not.toBe(running);
    const frozen = y();
    for (let frame = 0; frame < 30; frame += 1) pool.apply(look.update(createWeatherView(), weights(12), 16, true));
    expect(y()).toBe(frozen);
  });

  it('writes nothing for an unchanged frame', () => {
    const pool = makePool();
    const { look, effects } = stormEffects();
    pool.apply(effects);
    const sprite = pool.rainLayer.children[0] as Sprite;
    let writes = 0;
    const position = sprite.position;
    const observer = new Proxy(position, { set: (target, key, value) => { writes += 1; return Reflect.set(target, key, value); } });
    Object.defineProperty(sprite, 'position', { value: observer });
    // Paused and calm: the effects do not move, so apply must return early.
    for (let frame = 0; frame < 20; frame += 1) pool.apply(look.update(createWeatherView(), weights(12), 16, true));
    expect(writes).toBe(0);
  });

  it('reduced motion: clouds and rain stand still, rain is a light static texture, no flash', () => {
    const pool = makePool();
    const { look } = stormEffects(true);
    const positions = (): string => pool.rainLayer.children.map((c) => `${c.x},${c.y}`).join('|') + pool.cloudLayer.children.map((c) => `${c.x},${c.y}`).join('|');
    pool.apply(look.update(createWeatherView(), weights(12), 16, false));
    const first = positions();
    let flash = 0;
    for (let frame = 0; frame < 300; frame += 1) {
      const effects = look.update(createWeatherView(), weights(12), 16, false);
      flash = Math.max(flash, effects.flash);
      pool.apply(effects);
    }
    expect(positions()).toBe(first);
    expect(flash).toBe(0);
    const visible = (pool.rainLayer.children as Sprite[]).filter((sprite) => sprite.visible).length;
    expect(visible).toBeLessThanOrEqual(Math.round(CLASSIC_RAIN_POOL * 0.35));
    expect(visible).toBeGreaterThan(0);
  });

  it('cloud shadows multiply, never grey a colour out (every channel >= 0.78), and scale with cloud cover', () => {
    const pool = makePool();
    const look = new WeatherLook({ pin: { kind: 'cloudy', intensity: 1 } });
    pool.apply(look.update(createWeatherView(), weights(12), 16, false));
    const clouds = pool.cloudLayer.children as Sprite[];
    expect(clouds.filter((sprite) => sprite.visible).length).toBeGreaterThanOrEqual(4);
    for (const sprite of clouds) {
      expect(sprite.blendMode).toBe('multiply');
      for (const value of channels(sprite.tint)) expect(value).toBeGreaterThanOrEqual(Math.floor(0.78 * 255));
    }
  });

  it('destroy releases both layers and is idempotent', () => {
    const pool = makePool();
    const parent = new Container();
    parent.addChild(pool.cloudLayer, pool.rainLayer);
    pool.destroy();
    pool.destroy();
    expect(parent.children.length).toBe(0);
    expect(() => pool.apply(createWeatherEffects())).not.toThrow();
  });
});

describe('classic weather tint', () => {
  it('is the plain day tint with no gloom and no flash', () => {
    for (const hour of [2, 9, 12, 19]) {
      expect(classicTint(weights(hour), 0, 0)).toBe(classicTint(weights(hour)));
    }
  });

  it('gloom dims monotonically but keeps every channel above the colourful floor, at every hour', () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      let last = channels(classicTint(weights(hour), 0, 0));
      for (let gloom = 0.1; gloom <= 1.0001; gloom += 0.1) {
        const now = channels(classicTint(weights(hour), gloom, 0));
        for (let i = 0; i < 3; i += 1) {
          expect(now[i]).toBeLessThanOrEqual(last[i]);
          expect(now[i]).toBeGreaterThanOrEqual(Math.floor(CLASSIC_WEATHER_FLOOR * 255));
        }
        last = now;
      }
    }
  });

  it('a flash lifts the tint toward white and never past it', () => {
    for (const hour of [2, 12, 19]) {
      const dim = channels(classicTint(weights(hour), 1, 0));
      const lit = channels(classicTint(weights(hour), 1, 1));
      for (let i = 0; i < 3; i += 1) {
        expect(lit[i]).toBeGreaterThanOrEqual(dim[i]);
        expect(lit[i]).toBeLessThanOrEqual(255);
      }
    }
    const night = channels(classicTint(weights(2), 1, 1));
    expect(night[0]).toBeGreaterThan(channels(classicTint(weights(2), 1, 0))[0]);
  });
});

describe('classic renderer weather wiring', () => {
  afterEach(() => { vi.unstubAllGlobals(); resetSettings(); });

  const make = () => {
    const renderer = new WorldRenderer(new ParkSession(null));
    renderer.syncWorld();
    const internals = renderer as unknown as { camera: Container; classicWeather: ClassicWeather };
    return { renderer, ...internals };
  };

  it('a clear or off weather leaves the picture exactly as before', () => {
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0.5);
    renderer.setWeather(viewOf('storm', 1, { enabled: false }));
    for (let frame = 0; frame < 60; frame += 1) renderer.update(16, frame * 16);
    expect(camera.tint).toBe(0xffffff);
    expect(classicWeather.cloudLayer.visible).toBe(false);
    expect(classicWeather.rainLayer.visible).toBe(false);
  });

  it('a storm fades in (no pop), dims the tint and shows clouds, then fades out again when switched off', () => {
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0.5);
    renderer.update(16, 0);
    renderer.setWeather(viewOf('storm', 1));
    const tints: number[] = [];
    for (let frame = 0; frame < 60 * 8; frame += 1) {
      renderer.update(16, frame * 16);
      tints.push(camera.tint);
    }
    expect(classicWeather.cloudLayer.visible).toBe(true);
    expect(camera.tint).not.toBe(0xffffff);
    for (const value of channels(camera.tint)) expect(value).toBeGreaterThanOrEqual(Math.floor(CLASSIC_WEATHER_FLOOR * 255));
    // Eased: the first frame after the change is nearly the old tint, not the final one.
    expect(channels(tints[0])[0]).toBeGreaterThan(channels(camera.tint)[0]);
    renderer.setWeather(viewOf('storm', 1, { enabled: false }));
    for (let frame = 0; frame < 60 * 20; frame += 1) renderer.update(16, frame * 16);
    expect(camera.tint).toBe(0xffffff);
    expect(classicWeather.cloudLayer.visible).toBe(false);
  });

  it('creates no display object and builds no geometry across frames of a storm', () => {
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0.5);
    renderer.setWeather(viewOf('storm', 1, { flashSeed: 7 }));
    const before = count(camera) + count(classicWeather.rainLayer);
    for (let frame = 0; frame < 20; frame += 1) renderer.update(16, frame * 16);
    const draws = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 600; frame += 1) renderer.update(16, frame * 16);
    });
    expect(draws).toBe(0);
    expect(count(camera) + count(classicWeather.rainLayer)).toBe(before);
  });

  it('paused: clouds do not drift', () => {
    const { renderer, classicWeather } = make();
    renderer.setTimeOfDay(0.5);
    renderer.setWeather(viewOf('cloudy', 1));
    for (let frame = 0; frame < 120; frame += 1) renderer.update(16, frame * 16);
    renderer.setMachineryPaused(true);
    const where = (): string => classicWeather.cloudLayer.children.map((c) => `${c.x},${c.y}`).join('|');
    const frozen = where();
    for (let frame = 0; frame < 600; frame += 1) renderer.update(16, frame * 16);
    expect(where()).toBe(frozen);
    renderer.setMachineryPaused(false);
    for (let frame = 0; frame < 600; frame += 1) renderer.update(16, frame * 16);
    expect(where()).not.toBe(frozen);
  });

  it('honours reduced motion: stand-still clouds, no flash tint pulses', () => {
    updateSettings({ reducedMotion: 'on' });
    const { renderer, camera, classicWeather } = make();
    renderer.setTimeOfDay(0.5);
    renderer.setWeather(viewOf('storm', 1, { flashSeed: 11 }));
    for (let frame = 0; frame < 60 * 6; frame += 1) renderer.update(16, frame * 16);
    const where = (): string => classicWeather.cloudLayer.children.map((c) => `${c.x},${c.y}`).join('|');
    const still = where();
    const settled = camera.tint;
    for (let frame = 0; frame < 60 * 60; frame += 1) {
      renderer.setWeather(viewOf('storm', 1, { flashSeed: 11, secondsIntoSegment: frame / 4 }));
      renderer.update(16, frame * 16);
      expect(camera.tint).toBe(settled);
    }
    expect(where()).toBe(still);
  });

  it('the frame cost test shape still holds: a weather frame is cheap', () => {
    const session = new ParkSession(null);
    session.step(GAME_CONFIG.fixedStepMs);
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    renderer.setWeather(viewOf('rain', 0.8));
    renderer.update(16, 16);
    expect(countGraphicsDrawCalls(() => renderer.update(16, 32))).toBe(0);
  });
});
