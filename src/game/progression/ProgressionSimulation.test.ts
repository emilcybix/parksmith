import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import { RESEARCH_PROJECTS } from './content';
import { RideSimulation } from '../rides/RideSimulation';
import { ShopSimulation } from '../shops/ShopSimulation';
import { GameWorld } from '../World';
import { ProgressionSimulation } from './ProgressionSimulation';

const createHarness = () => {
  const world = new GameWorld();
  const progression = new ProgressionSimulation(world);
  const rideObject = world.buildObject('petal-roundabout', { x: 3, y: 3 });
  const serviceObject = world.buildObject('picnic-pocket', { x: 10, y: 3 });
  const rides = new RideSimulation(world);
  const shops = new ShopSimulation(world);
  if (!rideObject || !serviceObject) throw new Error('Starter content should be buildable');
  const ride = rides.getRide(rideObject.id);
  const service = shops.getService(serviceObject.id);
  if (!ride || !service) throw new Error('Starter runtimes should exist');
  return { world, progression, rides, shops, ride, service };
};

describe('research content', () => {
  it('references only real catalog builds and valid prerequisites', () => {
    const projectIds = new Set(RESEARCH_PROJECTS.map((project) => project.id));
    for (const project of RESEARCH_PROJECTS) {
      expect(project.unlockDefinitionIds.length).toBeGreaterThan(0);
      for (const definitionId of project.unlockDefinitionIds) {
        expect(BUILD_BY_ID.has(definitionId), `${project.id} unlocks unknown ${definitionId}`).toBe(true);
      }
      for (const prerequisiteId of project.prerequisiteIds) {
        expect(projectIds.has(prerequisiteId)).toBe(true);
      }
      expect(project.researchPointCost).toBeGreaterThan(0);
      expect(project.cashCost).toBeGreaterThan(0);
    }
  });
});

describe('ProgressionSimulation', () => {
  it('starts with unmapped content unlocked and research content locked at the world boundary', () => {
    const world = new GameWorld();
    const progression = new ProgressionSimulation(world);

    expect(progression.isUnlocked('petal-roundabout')).toBe(true);
    expect(progression.isUnlocked('comet-cups')).toBe(false);
    expect(world.isDefinitionUnlocked('comet-cups')).toBe(false);
    expect(world.checkObjectBuild('comet-cups', { x: 4, y: 4 })).toEqual({ ok: false, reason: 'locked' });
    expect(world.buildObject('comet-cups', { x: 4, y: 4 })).toBeNull();
  });

  it('awards exact weighted points from positive completion deltas without step-zero or repeat awards', () => {
    const { progression, rides, shops, ride, service } = createHarness();
    ride.satisfactionCount = 4;
    service.customersServed = 3;

    progression.step(0, rides, shops, 0);
    expect(progression.snapshot().researchPoints).toBe(0);

    progression.step(100, rides, shops, 0);
    expect(progression.snapshot()).toMatchObject({
      researchPoints: 5.5,
      completedExperiences: 7,
      completedRideExperiences: 4,
      completedServiceExperiences: 3,
    });

    progression.step(100, rides, shops, 0);
    expect(progression.snapshot().researchPoints).toBe(5.5);
    expect(progression.snapshot().completedExperiences).toBe(7);
  });

  it('handles reset counters as a new baseline without negative or duplicate progress', () => {
    const { progression, rides, shops, ride } = createHarness();
    ride.satisfactionCount = 5;
    progression.step(100, rides, shops, 0);
    expect(progression.snapshot().researchPoints).toBe(5);

    ride.satisfactionCount = 2;
    progression.step(100, rides, shops, 0);
    expect(progression.snapshot().researchPoints).toBe(5);

    ride.satisfactionCount = 4;
    progression.step(100, rides, shops, 0);
    expect(progression.snapshot().researchPoints).toBe(7);
    expect(progression.snapshot().completedExperiences).toBe(7);
  });

  it('awards each experience and rating milestone exactly once', () => {
    const { progression, rides, shops, ride } = createHarness();
    ride.satisfactionCount = 250;
    progression.step(100, rides, shops, 70);

    const snapshot = progression.snapshot();
    expect(snapshot.researchPoints).toBe(400);
    expect(snapshot.milestones.every((milestone) => milestone.completed)).toBe(true);
    expect(progression.drainEvents().filter((event) => event.kind === 'milestoneReached')).toHaveLength(5);

    progression.step(100, rides, shops, 70);
    expect(progression.snapshot().researchPoints).toBe(400);
    expect(progression.drainEvents()).toEqual([]);
  });

  it('purchases research atomically, records its expense, and immediately unlocks the build', () => {
    const { world, progression } = createHarness();
    progression.grantResearchPoints(30);
    const cashBefore = world.cash;

    const result = progression.purchase('spin-studies');
    expect(result).toEqual({
      ok: true,
      projectId: 'spin-studies',
      unlockedDefinitionIds: ['comet-cups'],
      researchPointsSpent: 30,
      cashSpent: 300,
    });
    expect(progression.snapshot().researchPoints).toBe(0);
    expect(world.cash).toBe(cashBefore - 300);
    expect(world.transactions[0]).toMatchObject({ amount: -300, category: 'research' });
    expect(world.checkObjectBuild('comet-cups', { x: 18, y: 4 }).ok).toBe(true);

    const cashAfterPurchase = world.cash;
    expect(progression.purchase('spin-studies')).toEqual({ ok: false, reason: 'completed' });
    expect(world.cash).toBe(cashAfterPurchase);
  });

  it('returns precise purchase failures without mutating cash or research points', () => {
    const { world, progression } = createHarness();
    const startingCash = world.cash;

    expect(progression.purchase('not-a-project')).toEqual({ ok: false, reason: 'missing' });
    expect(progression.purchase('vertical-motion')).toEqual({ ok: false, reason: 'locked' });
    expect(progression.purchase('spin-studies')).toEqual({ ok: false, reason: 'insufficient-rp' });

    progression.grantResearchPoints(30);
    world.cash = 0;
    expect(progression.purchase('spin-studies')).toEqual({ ok: false, reason: 'insufficient-cash' });
    expect(progression.snapshot().researchPoints).toBe(30);
    expect(world.cash).toBe(0);
    expect(world.transactions.filter((transaction) => transaction.category === 'research')).toHaveLength(0);
    expect(startingCash).toBeGreaterThan(0);
  });

  it('requires both the project chain and rating milestone for skyline research', () => {
    const { progression, rides, shops } = createHarness();
    progression.grantResearchPoints(300);

    expect(progression.purchase('skyline-engineering')).toEqual({ ok: false, reason: 'locked' });
    expect(progression.purchase('spin-studies').ok).toBe(true);
    expect(progression.purchase('vertical-motion').ok).toBe(true);
    expect(progression.purchase('skyline-engineering')).toEqual({ ok: false, reason: 'locked' });

    progression.step(100, rides, shops, 70);
    expect(progression.purchase('skyline-engineering').ok).toBe(true);
    expect(progression.isUnlocked('aurora-wheel')).toBe(true);
  });

  it('returns cloned snapshots, results, and drained events', () => {
    const { progression } = createHarness();
    progression.grantResearchPoints(30);
    const result = progression.purchase('spin-studies');
    if (!result.ok) throw new Error('Research purchase should succeed');
    result.unlockedDefinitionIds.push('mutated-result');

    const snapshot = progression.snapshot();
    snapshot.completedProjectIds.push('express-service');
    snapshot.projects[0].unlockDefinitionIds.push('mutated-snapshot');
    expect(progression.snapshot().completedProjectIds).toEqual(['spin-studies']);
    expect(progression.snapshot().projects[0].unlockDefinitionIds).toEqual(['comet-cups']);

    const events = progression.drainEvents();
    expect(events).toHaveLength(1);
    if (events[0].kind !== 'researchCompleted') throw new Error('Expected a research event');
    expect(events[0].unlockedDefinitionIds).toEqual(['comet-cups']);
    events[0].unlockedDefinitionIds.push('mutated-event');
    expect(progression.drainEvents()).toEqual([]);
  });
});
