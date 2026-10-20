import { describe, expect, it } from 'vitest';
import { ParkSession } from '../session/ParkSession';

/**
 * Phase 49: the inspector's next scenery step. The comfort cabin has no theme, so its score is the base the step
 * measures (a themed ride's theme bonus only adds on top).
 */
const park = () => {
  const session = new ParkSession(null);
  const { world } = session;
  world.addMoney(100_000, 'test');
  world.setBuildAccessPolicy(null);
  world.buildPaths(Array.from({ length: 30 }, (_, index) => ({ x: index + 1, y: 20 })).concat({ x: world.entrance.x, y: 21 }));
  const cabin = world.buildObject('comfort-cabin', { x: 14, y: 18 });
  if (!cabin) throw new Error('the cabin does not fit');
  const canPlace = (definitionId: string, anchor: { x: number; y: number }): boolean => {
    const check = world.checkObjectBuild(definitionId, anchor);
    return check.ok || check.reason === 'funds';
  };
  return { session, world, cabin, canPlace };
};

describe('Phase 49: ScenerySimulation.nextStepFor', () => {
  it('names a piece and a free spot whose gain is what building it then adds', () => {
    const { session, world, cabin, canPlace } = park();
    const before = session.scenery.scoreForObject(cabin.id);
    const step = session.scenery.nextStepFor(cabin.id, ['lollipop-lamp', 'confetti-tree', 'sunburst-flowers'], canPlace);
    expect(step).not.toBeNull();
    expect(step!.definitionId, 'the tree adds the most').toBe('confetti-tree');
    expect(step!.scoreBefore).toBeCloseTo(before, 1);
    expect(world.buildObject(step!.definitionId, step!.anchor)).not.toBeNull();
    session.scenery.syncWithWorld();
    expect(session.scenery.scoreForObject(cabin.id)).toBeCloseTo(step!.scoreAfter, 1);
    expect(step!.scoreAfter - step!.scoreBefore).toBeCloseTo(step!.gain, 1);
  });

  it('respects where a piece may stand, and says nothing when nothing may', () => {
    const { session, cabin } = park();
    expect(session.scenery.nextStepFor(cabin.id, ['confetti-tree'], () => false)).toBeNull();
    expect(session.scenery.nextStepFor(cabin.id, ['ribbon-bench', 'not-a-thing'], () => true), 'only scenery counts').toBeNull();
    expect(session.scenery.nextStepFor(9_999, ['confetti-tree'], () => true), 'no such object').toBeNull();
  });

  it('runs out below 100 with lamps alone, and reaches 100 one tree at a time', () => {
    const lamps = park();
    let steps = 0;
    for (let step = lamps.session.scenery.nextStepFor(lamps.cabin.id, ['lollipop-lamp'], lamps.canPlace); step; steps += 1) {
      expect(lamps.world.buildObject(step.definitionId, step.anchor)).not.toBeNull();
      step = lamps.session.scenery.nextStepFor(lamps.cabin.id, ['lollipop-lamp'], lamps.canPlace);
    }
    expect(steps).toBeGreaterThan(5);
    expect(lamps.session.scenery.scoreForObject(lamps.cabin.id), 'lamps top out well below the top').toBeLessThan(75);

    const trees = park();
    for (let step = trees.session.scenery.nextStepFor(trees.cabin.id, ['confetti-tree'], trees.canPlace); step;) {
      expect(trees.world.buildObject(step.definitionId, step.anchor)).not.toBeNull();
      step = trees.session.scenery.nextStepFor(trees.cabin.id, ['confetti-tree'], trees.canPlace);
    }
    expect(trees.session.scenery.scoreForObject(trees.cabin.id)).toBe(100);
  });
});
