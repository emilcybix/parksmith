import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { BUILD_CATALOG } from '../game/content/catalog';
import { ParkSession } from '../game/session/ParkSession';
import { seedDevPark } from '../game/session/devPark';
import { countGraphicsDrawCalls } from './drawCallCounter';
import { createRideArt } from './rideArt';
import { WorldRenderer } from './WorldRenderer';

/**
 * Recording a path is cheap; Pixi re-tessellating and re-uploading it during the render pass
 * is not, and on a throttled CPU that cost dominates the frame. So the rule this file guards
 * is simple: after the scene exists, a frame may move things, but it may not rebuild geometry.
 *
 * The construction frame — where geometry legitimately does change — is guarded separately, with
 * a proportional ceiling rather than zero, in `constructionCost.test.ts`.
 */
describe('per-frame render cost', () => {
  it('animates every ride without rebuilding any geometry', () => {
    const rides = BUILD_CATALOG.filter((definition) => definition.kind === 'ride' && !definition.custom);
    // Building the art draws plenty — that is the one-off cost, and it proves the counter works.
    let arts: ReturnType<typeof createRideArt>[] = [];
    expect(countGraphicsDrawCalls(() => { arts = rides.map((definition) => createRideArt(definition)); }))
      .toBeGreaterThan(100);
    const calls = countGraphicsDrawCalls(() => {
      for (let step = 0; step < 12; step += 1) {
        for (const art of arts) {
          art.animate({
            spin: step * 240,
            motion: step % 3 === 0 ? 0 : 1,
            progress: step / 12,
            elapsedMs: step * 160,
            status: step % 3 === 0 ? 'idle' : 'running',
          });
        }
      }
    });
    expect(calls, 'ride machinery rebuilt geometry during animate').toBe(0);
  });

  it('runs a full dev-park frame without rebuilding any geometry', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    session.guests.spawnGuests(300);
    for (let step = 0; step < 100; step += 1) session.step(GAME_CONFIG.fixedStepMs);

    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    // The first frames create the guest, worker, litter, bin, and train displays, which draws.
    expect(countGraphicsDrawCalls(() => renderer.update(16, 16))).toBeGreaterThan(0);
    renderer.update(16, 32);
    expect(session.world.coasters.size).toBeGreaterThan(0);

    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 10; frame += 1) renderer.update(16, 48 + frame * 16);
    });
    expect(calls, 'a steady-state frame rebuilt geometry').toBe(0);
  });

  it('keeps the start screen\'s camera sweep free of geometry rebuilds and of any real cost', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    session.guests.spawnGuests(300);
    for (let step = 0; step < 100; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    const renderer = new WorldRenderer(session);
    // The camera call needs a screen size; there is no Pixi application in a unit test.
    (renderer as unknown as { app: { screen: { width: number; height: number } } }).app = { screen: { width: 1280, height: 720 } };
    renderer.syncWorld();
    renderer.update(16, 16);
    renderer.update(16, 32);

    const frames = 600;
    const drawCalls = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 30; frame += 1) {
        renderer.setCameraCentre(16 + 5 * Math.sin(frame / 7), 16 + 2 * Math.sin(frame / 11));
        renderer.update(16, 48 + frame * 16);
      }
    });
    expect(drawCalls, 'panning the camera rebuilt geometry').toBe(0);

    // The sweep itself is a handful of float writes: its share of a frame is noise next to the frame.
    const time = (sweeping: boolean): number => {
      const start = performance.now();
      for (let frame = 0; frame < frames; frame += 1) {
        if (sweeping) renderer.setCameraCentre(16 + 5 * Math.sin(frame / 40), 16 + 2 * Math.sin(frame / 63));
        renderer.update(16, 1_000 + frame * 16);
      }
      return (performance.now() - start) / frames;
    };
    time(false);
    const still = time(false);
    const sweeping = time(true);
    expect(sweeping - still, `sweep overhead per frame (still ${still.toFixed(3)} ms, sweeping ${sweeping.toFixed(3)} ms)`).toBeLessThan(0.5);
  });
});
