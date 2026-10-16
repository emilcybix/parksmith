import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import { WorldRenderer } from './WorldRenderer';

/**
 * The classic renderer's whole day look is one tint on the camera container: it changes with the
 * clock, day is exactly white, and sweeping a whole day creates or destroys no display object.
 */
const countDisplays = (root: Container): number => {
  let count = 1;
  for (const child of root.children) count += countDisplays(child as Container);
  return count;
};

describe('classic renderer time of day', () => {
  const renderer = new WorldRenderer(new ParkSession(null));
  renderer.syncWorld();
  const camera = (renderer as unknown as { camera: Container }).camera;

  it('is untinted by day and tinted at night and dusk', () => {
    renderer.setTimeOfDay(0.5);
    expect(camera.tint).toBe(0xffffff);
    renderer.setTimeOfDay(0.1);
    expect(camera.tint).not.toBe(0xffffff);
    const night = camera.tint;
    renderer.setTimeOfDay(19 / 24);
    expect(camera.tint).not.toBe(night);
    renderer.setTimeOfDay(0.5);
    expect(camera.tint).toBe(0xffffff);
  });

  it('sweeps a whole day without adding or removing a display object, writing the tint only when it changes', () => {
    const layers = Object.values(renderer).filter((value): value is Container => value instanceof Container);
    const before = layers.map(countDisplays);
    const writes: number[] = [];
    let last = camera.tint;
    for (let minute = 0; minute <= 1440; minute += 1) {
      renderer.setTimeOfDay(minute / 1440);
      if (camera.tint !== last) writes.push(camera.tint);
      last = camera.tint;
    }
    expect(layers.map(countDisplays)).toEqual(before);
    expect(writes.length, 'a few dozen tint writes per day, not one per frame').toBeLessThan(120);
    expect(writes.length).toBeGreaterThan(5);
  });
});
