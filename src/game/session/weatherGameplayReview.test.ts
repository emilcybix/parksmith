import { describe, expect, it } from 'vitest';
import { countdownText } from '../../ui/scenarioDeadlineModel';
import { ParkSession } from './ParkSession';
import { SCENARIO_BY_ID } from '../scenarios/content';

/**
 * Phase 20 step 2 gameplay review (adversarial). Each test pins a defect found in review and since fixed.
 */

const street = (): ParkSession => {
  const session = new ParkSession(null);
  session.world.setBuildAccessPolicy(null);
  const cells = [];
  for (let y = 31; y >= 22; y -= 1) cells.push({ x: 15, y });
  session.world.buildPaths(cells);
  session.world.buildObject('comet-cups', { x: 12, y: 26 });
  session.syncWithWorld();
  return session;
};
const run = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(100);
};

describe('weather review: storm closure labelling', () => {
  it('a ride that is broken during a storm is not reported as closed by the storm', () => {
    const session = street();
    run(session, 1_800); // slot 1 starts: 12:00
    const id = [...session.world.objects.values()].find((object) => object.definitionId === 'comet-cups')!.id;
    session.weather.forceCurrentSlot('storm', 1);
    run(session, 5);
    expect(session.rides.forceBreakdown(id, session.guests.guests)).toBe(true);
    for (let tick = 0; tick < 600 && session.rides.snapshot(id)!.status !== 'broken'; tick += 1) session.step(100);
    const snapshot = session.rides.snapshot(id)!;
    expect(snapshot.status).toBe('broken');
    // The HUD prints "broken · storm"; the storm is not why the ride is down, and it would not reopen at the storm's end.
    expect(snapshot.closureReason).not.toBe('storm');
  });
});

describe('weather review: scenario deadline text', () => {
  it('a running days-scenario never reads "0.0 days left"', () => {
    const base = SCENARIO_BY_ID.get('sunny-start')!;
    const countdown = countdownText({
      timeLimitDays: 1.25,
      timeLimitSeconds: base.timeLimitSeconds,
      remainingDays: 0.04,
      remainingSeconds: 29,
    });
    expect(countdown).not.toMatch(/^0\.0 /);
  });

  it('the countdown and the limit text round the same way (1.25 days is not "1.3 days left" at the start)', () => {
    const countdown = countdownText({ timeLimitDays: 1.25, timeLimitSeconds: 900, remainingDays: 1.25, remainingSeconds: 900 });
    expect(countdown).toBe('1.25 days left');
  });
});
