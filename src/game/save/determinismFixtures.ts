import { COASTER_TYPE_BY_ID } from '../coaster/content';
import { coasterBaseCost, deriveCoasterStats, type CoasterPiece } from '../coaster/design';
import { hillDipNorthLayout } from '../coaster/testLayouts';
import { ENTRANCE_COLOUR_ID } from '../content/colours';
import { presetRecord } from '../content/colourPresets';
import { buildFirstDayRoute } from '../onboarding/routeInFrame';
import { PROJECT_BY_BUILD_ID, RESEARCH_PROJECT_BY_ID } from '../progression/content';
import type { ResearchProjectId } from '../progression/types';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { ParkSession } from '../session/ParkSession';
import { entranceFrame } from '../maps/frame';
import { testStageSession } from '../run/testSupport';
import { seedDevPark } from '../session/devPark';
import type { Act } from './determinismHarness';

/**
 * The parks the determinism proof runs on. Each one is a deterministic `build()` plus a scripted
 * `act` (player actions at fixed ticks, applied identically in the reference and in every twin)
 * and the save points worth trying. Every fixture says, in `expectations`, what must be true at
 * its save points, so a refactor that quietly stops exercising a trap (a queue, a repair, a
 * pending event) fails loudly instead of turning the proof into a tour of empty parks.
 */

export interface SavePoint {
  tick: number;
  /** Human-readable problems when the session is not in the state this save point exists to cover. */
  expect?: (session: ParkSession) => string[];
}

export interface DeterminismFixture {
  name: string;
  build: () => ParkSession;
  act: Act;
  total: number;
  savePoints: SavePoint[];
}

/**
 * Phase 16: a fixed research grant written for the base RP costs, re-expressed for the park's research cost scale:
 * "old grant - old base cost + effective cost" of the projects the fixture then buys. The leftover RP and every event
 * are therefore identical at scale 1 (the grant is exactly the old one), and the fixture still works at any scale.
 */
export const scaledResearchGrant = (session: ParkSession, grant: number, projectIds: readonly ResearchProjectId[]): number => (
  projectIds.reduce((total, id) => {
    const project = RESEARCH_PROJECT_BY_ID.get(id);
    if (!project) throw new Error(`unknown research project ${id}`);
    return total - project.researchPointCost + session.progression.researchPointCostOf(project);
  }, grant)
);

export const need = (condition: boolean, problem: string): string[] => (condition ? [] : [problem]);

const rideList = (session: ParkSession) => [...session.rides.rides.values()];
const staffList = (session: ParkSession) => [...session.operations.staff.values()];

const sandboxId = (session: ParkSession, definitionId: string, occurrence = 0): number => {
  const matches = [...session.world.objects.values()].filter((object) => object.definitionId === definitionId);
  const found = matches[occurrence];
  if (!found) throw new Error(`fixture needs a ${definitionId} (#${occurrence})`);
  return found.id;
};

/** Builds `definitionId` on the first free anchor east of the avenue at x=15, or throws. */
const buildEastOfAvenue = (session: ParkSession, definitionId: string, rows: readonly number[]): number => {
  for (const y of rows) {
    const built = session.world.buildObject(definitionId, { x: 16, y });
    if (built) return built.id;
  }
  throw new Error(`fixture could not place ${definitionId}`);
};

const buildDevPark = (guestCount: number): ParkSession => {
  const session = new ParkSession(null);
  const report = seedDevPark(session);
  if (report.skipped.length > 0) throw new Error(`dev park skipped ${report.skipped.join(', ')}`);
  session.syncWithWorld();
  session.guests.spawnGuests(guestCount);
  return session;
};

/** Edits go through the world and are synced the way the app's world-changed handler syncs. */
const edit = (session: ParkSession, change: () => void): void => {
  change();
  session.syncWithWorld();
};

/**
 * Fixture 1: the developer park with the guest cap reached, a coaster, and a stream of player
 * actions: a price change, a bin demolished, a path tile bulldozed and rebuilt (so `paths`
 * insertion order differs from sorted order and every route goes stale), a hire and a training.
 */
const devPark1000: DeterminismFixture = {
  name: 'dev park, 1,000 guests, coaster',
  build: () => buildDevPark(1000),
  act: (session, tick) => {
    if (tick === 150) session.rides.setTicketPrice(sandboxId(session, 'comet-cups'), 7);
    if (tick === 300) {
      const bin = [...session.world.objects.values()].find((object) => object.definitionId === 'tidy-totem');
      if (bin) edit(session, () => session.world.bulldoze(bin.anchor));
    }
    if (tick === 450) {
      edit(session, () => { session.world.bulldoze({ x: 23, y: 11 }); });
      edit(session, () => { session.world.buildPaths([{ x: 23, y: 11 }]); });
    }
    if (tick === 700) session.operations.hireStaff('cleaner');
    if (tick === 900) session.operations.trainStaff('cleaner');
    // Phase 28: colours are world state (saved, hashed, restored) but never read by the simulation.
    // The twins must carry every record through a save, including a clear and a partial record.
    if (tick === 150) edit(session, () => session.world.setObjectColours(sandboxId(session, 'comet-cups'), [19, null]));
    if (tick === 400) edit(session, () => session.world.setObjectColours(sandboxId(session, 'aurora-wheel'), [18, 5, 13]));
    if (tick === 600) edit(session, () => session.world.clearObjectColours(sandboxId(session, 'comet-cups')));
    if (tick === 800) edit(session, () => session.world.setObjectColours(sandboxId(session, 'moonpetal-carousel'), [null, null, 13]));
    // Phase 28 step 2: a stall, the coaster, the park-level gate record and a whole-park preset.
    if (tick === 220) edit(session, () => session.world.setObjectColours(sandboxId(session, 'picnic-pocket'), [19, 6]));
    if (tick === 260) edit(session, () => session.world.setObjectColours(sandboxId(session, 'star-chaser'), [null, 4, 12, null]));
    if (tick === 300) edit(session, () => session.world.setGateColours([19, null, 13]));
    if (tick === 1300) edit(session, () => session.world.applyPresetToPark('autumn'));
  },
  total: 1800,
  savePoints: [
    { tick: 61 },
    {
      tick: 333,
      expect: (session) => [
        ...need(session.guests.guests.size >= 900, 'at least 900 guests'),
        ...need(rideList(session).some((ride) => ride.status === 'running' && ride.cycleRemainingSeconds > 0), 'a ride mid-cycle'),
        ...need(rideList(session).some((ride) => ride.queueGuestIds.length > 0), 'a ride queue'),
        ...need([...session.world.coasters.keys()].length === 1, 'the coaster'),
        ...need(JSON.stringify(session.world.objectColours(sandboxId(session, 'comet-cups'))) === '[19,null]', 'a recoloured comet-cups'),
        ...need(JSON.stringify(session.world.objectColours(sandboxId(session, 'picnic-pocket'))) === '[19,6]', 'a recoloured stall'),
        ...need(JSON.stringify(session.world.objectColours(sandboxId(session, 'star-chaser'))) === '[null,4,12,null]', 'a recoloured coaster'),
        ...need(JSON.stringify(session.world.gateColours) === '[19,null,13]', 'a recoloured gate'),
      ],
    },
    {
      tick: 757,
      expect: (session) => [
        ...need([...session.shops.services.values()].some((service) => service.queueGuestIds.length > 0), 'a shop queue'),
        ...need([...session.shops.services.values()].some((service) => service.activeGuestId !== null), 'an active shopper'),
        ...need(staffList(session).some((worker) => worker.task !== null), 'a staff member mid-task'),
        ...need(JSON.stringify(session.world.objectColours(sandboxId(session, 'aurora-wheel'))) === '[18,5,13]', 'a three-slot recoloured wheel'),
        ...need(session.world.objectColours(sandboxId(session, 'comet-cups')) === null, 'a cleared comet-cups'),
      ],
    },
    {
      tick: 1201,
      expect: (session) => [
        ...need(JSON.stringify(session.world.objectColours(sandboxId(session, 'moonpetal-carousel'))) === '[null,null,13]', 'a partial carousel record'),
        ...need(JSON.stringify(session.world.objectColours(sandboxId(session, 'aurora-wheel'))) === '[18,5,13]', 'the recoloured wheel'),
      ],
    },
    {
      tick: 1500,
      expect: (session) => [
        ...need(JSON.stringify(session.world.objectColours(sandboxId(session, 'star-chaser'))) === JSON.stringify(presetRecord('star-chaser', 'autumn')), 'the coaster wears the Autumn preset'),
        ...need(JSON.stringify(session.world.gateColours) === JSON.stringify(presetRecord(ENTRANCE_COLOUR_ID, 'autumn')), 'the gate wears the Autumn preset'),
        ...need(session.world.objectColours(sandboxId(session, 'aurora-wheel'))?.length === 3, 'the wheel wears the Autumn preset'),
      ],
    },
  ],
};

/**
 * Fixture 2: a scenario with two Pulse Cards (multipliers compose in loadout order before a
 * three-decimal round) and a hand-built little park, saved while the objective is still running.
 */
const scenarioCards = (): DeterminismFixture => {
  const definition = SCENARIO_BY_ID.get('garden-gala')!;
  return {
    name: 'scenario with Pulse Cards and a rules-locked id',
    build: () => new ParkSession(definition, ['hungry-tourists', 'lean-crew', 'grand-opening']),
    act: (session, tick) => {
      if (tick === 0) {
        edit(session, () => {
          const cells = [];
          for (let y = 27; y >= 18; y -= 1) cells.push({ x: 15, y });
          session.world.buildPaths(cells);
          buildEastOfAvenue(session, 'petal-roundabout', [26, 22, 18]);
          buildEastOfAvenue(session, 'moonpetal-carousel', [24, 20, 16]);
          buildEastOfAvenue(session, 'picnic-pocket', [27, 14]);
          buildEastOfAvenue(session, 'lollipop-lamp', [29]);
        });
        session.operations.hireStaff('cleaner');
      }
      if (tick === 900) session.rides.setOpen(sandboxId(session, 'moonpetal-carousel'), false);
      if (tick === 1000) session.rides.setOpen(sandboxId(session, 'moonpetal-carousel'), true);
    },
    total: 2600,
    savePoints: [
      {
        tick: 400,
        expect: (session) => [
          ...need(session.activeCards.length === 2, 'two active cards (slots cap the loadout)'),
          ...need(session.scenario?.snapshot().status === 'running', 'scenario running'),
          ...need(!session.world.isDefinitionUnlocked('tidy-totem'), 'the rules-locked bin stays locked'),
          ...need(session.guests.guests.size > 5, 'guests in the park'),
        ],
      },
      { tick: 950, expect: (session) => need(!session.rides.rides.get(sandboxId(session, 'moonpetal-carousel'))!.open, 'a closed ride') },
      { tick: 1700 },
    ],
  };
};

/** Fixture 2b: saved right after the objective latched (success), and before the event was drained. */
const scenarioSuccessLatch = (): DeterminismFixture => {
  const definition = SCENARIO_BY_ID.get('sunny-start')!;
  return {
    name: 'scenario latched success',
    build: () => new ParkSession(definition, ['grand-opening']),
    act: (session, tick) => {
      if (tick === 0) {
        edit(session, () => {
          session.world.buildPaths([{ x: 15, y: 26 }, { x: 15, y: 25 }, { x: 15, y: 24 }]);
          buildEastOfAvenue(session, 'moonpetal-carousel', [24, 22]);
        });
      }
      if (tick === 500) session.guests.spawnGuests(150);
    },
    total: 1200,
    savePoints: [
      { tick: 500, expect: (session) => need(session.scenario?.snapshot().status === 'running', 'not yet latched, but 150 arrivals queued') },
      { tick: 502, expect: (session) => need(session.scenario?.snapshot().status === 'succeeded', 'latched success') },
      { tick: 900 },
    ],
  };
};

/**
 * Fixture 2c: failure latched by direct scenario stepping, so the failure event is still pending
 * (undrained) when the save is taken right after the action.
 */
const scenarioFailureLatch = (): DeterminismFixture => {
  const definition = SCENARIO_BY_ID.get('penny-lane')!;
  return {
    name: 'scenario latched failure',
    build: () => new ParkSession(definition, ['velvet-ropes', 'local-contractors']),
    act: (session, tick) => {
      if (tick === 0) {
        edit(session, () => {
          session.world.buildPaths([{ x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 }]);
          buildEastOfAvenue(session, 'petal-roundabout', [26, 24]);
        });
      }
      if (tick === 300) {
        session.scenario!.step(definition.timeLimitSeconds * 1000 + 1000, {
          cumulativeGuests: 0, guestCount: 0, parkRating: 0, averageHappiness: 0, operatingProfit: 0, averageQueueSeconds: 0,
        });
      }
    },
    total: 800,
    savePoints: [
      { tick: 300, expect: (session) => need(session.scenario?.snapshot().status === 'failed', 'failure latched with its event still pending') },
      { tick: 301, expect: (session) => need(session.scenario?.snapshot().status === 'failed', 'failure latched, event drained') },
    ],
  };
};

/**
 * Fixture 2d: a sustain objective part-way through a streak. The first save point is taken while
 * `sustainedSeconds` is non-zero, `longestSustainedSeconds` exceeds it (an earlier streak was
 * broken) and `latestMetrics` holds numbers the next step has not overwritten yet, so a serializer
 * that dropped any of them would pass every other fixture (those saves fall before any streak).
 */
const scenarioSustainStreak = (): DeterminismFixture => {
  const definition = SCENARIO_BY_ID.get('garden-gala')!;
  const metrics = (parkRating: number) => ({
    cumulativeGuests: 321, guestCount: 17, parkRating, averageHappiness: 61.25, operatingProfit: 812.5, averageQueueSeconds: 9.75,
  });
  return {
    name: 'scenario mid sustain streak',
    build: () => {
      const session = new ParkSession(definition, ['grand-opening']);
      session.guests.spawnGuests(40);
      return session;
    },
    act: (session, tick) => {
      // The organic step after every tick resets the streak (the real rating is low), so a streak is
      // built inside one act: 3 s, a drop that breaks it (the longest streak stays), then 2 s again.
      // The save point falls right after the second act, before a step overwrites the metrics.
      if (tick === 40) {
        for (let index = 0; index < 30; index += 1) session.scenario!.step(100, metrics(90));
        session.scenario!.step(100, metrics(10));
      }
      if (tick === 60) {
        for (let index = 0; index < 20; index += 1) session.scenario!.step(100, metrics(90));
      }
    },
    total: 400,
    savePoints: [
      { tick: 45 },
      {
        tick: 60,
        expect: (session) => {
          const state = session.scenario!.serialize();
          return [
            ...need(state.sustainedSeconds > 0, 'a running streak'),
            ...need(state.longestSustainedSeconds > state.sustainedSeconds, 'an earlier, longer streak'),
            ...need(state.latestMetrics.cumulativeGuests > 0, 'non-trivial latestMetrics'),
          ];
        },
      },
      { tick: 200 },
    ],
  };
};

/**
 * The 20-piece loop used for player-built coasters: a valid Skyline Serpent layout with one loop and
 * one boost, so `loops`, `boosts`, piece heights, `biggestDrop` and `paidCost` are all non-trivial.
 */
const serpentLayout = (): CoasterPiece[] => {
  const cells: Array<{ x: number; y: number }> = [];
  // North of the dev park's street (rows 0..5 are free), so it never collides with the park.
  for (let x = 4; x <= 11; x += 1) cells.push({ x, y: 1 });
  for (let y = 2; y <= 4; y += 1) cells.push({ x: 11, y });
  for (let x = 10; x >= 4; x -= 1) cells.push({ x, y: 4 });
  for (let y = 3; y >= 2; y -= 1) cells.push({ x: 4, y });
  const heights = [0, 0, 0, 1, 2, 3, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return cells.map((cell, index): CoasterPiece => {
    const piece: CoasterPiece = { cell, height: heights[index] };
    if (index === 8) piece.special = 'loop';
    if (index === 14) piece.special = 'boost';
    return piece;
  });
};

/**
 * Fixture 2e: a coaster the player designed (loop and boost pieces), saved while it runs and BEFORE
 * it is bulldozed, so the refund the bulldoze pays (`paidCost`) and the stats its ride profile reads
 * must survive the round trip. Save points after the bulldoze cover the removed record.
 */
const playerCoaster: DeterminismFixture = {
  name: 'player-built coaster with loop and boost, bulldozed later',
  build: () => buildDevPark(160),
  act: (session, tick) => {
    if (tick === 5) {
      const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
      const layout = serpentLayout();
      session.world.addMoney(300_000, 'Fixture grant');
      // Skyline Serpent (the only type with both specials) is a research unlock.
      session.progression.grantResearchPoints(scaledResearchGrant(session, 500, ['spin-studies', 'vertical-motion']));
      for (const project of ['spin-studies', 'vertical-motion']) {
        if (!session.progression.purchase(project).ok) throw new Error(`fixture could not research ${project}`);
      }
      edit(session, () => {
        const result = session.world.placeCoaster(type.definitionId, layout, deriveCoasterStats(layout, type), coasterBaseCost(layout, type));
        if ('error' in result) throw new Error(`fixture could not place the coaster: ${result.error}`);
      });
    }
    if (tick === 700) {
      const coaster = [...session.world.objects.values()].find((object) => object.definitionId === 'skyline-serpent');
      if (!coaster) throw new Error('fixture coaster is missing');
      edit(session, () => session.world.bulldoze(coaster.anchor));
    }
  },
  total: 1100,
  savePoints: [
    {
      tick: 300,
      expect: (session) => {
        const record = [...session.world.coasters.values()].find((candidate) => candidate.pieces.some((piece) => piece.special === 'loop'));
        return [
          ...need(record !== undefined && record.pieces.some((piece) => piece.special === 'boost'), 'the player coaster with a loop and a boost'),
          ...need(record !== undefined && record.paidCost > 0, 'a paid cost to refund'),
        ];
      },
    },
    { tick: 650, expect: (session) => need(rideList(session).some((ride) => ride.completedCycles > 0 && ride.lifetimeOperatingCost > 0), 'a ride with completed cycles') },
    { tick: 701, expect: (session) => need(![...session.world.coasters.values()].some((record) => record.pieces.some((piece) => piece.special === 'loop')), 'the player coaster is gone') },
    { tick: 1000 },
  ],
};

/**
 * Fixture 2f: a coaster with a chained station lift and FREE hills after its drops (lift hills,
 * schema 5), so the fixed-point free-climb model, the `freeClimb` flags in the save and the saved
 * stats they produced all run under the determinism proof. Saved mid-cycle, bulldozed later.
 */
const freeClimbCoaster: DeterminismFixture = {
  name: 'player-built coaster with free-climb hills, bulldozed later',
  build: () => buildDevPark(160),
  act: (session, tick) => {
    if (tick === 5) {
      const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
      const layout = hillDipNorthLayout(true);
      session.world.addMoney(300_000, 'Fixture grant');
      session.progression.grantResearchPoints(scaledResearchGrant(session, 500, ['spin-studies', 'vertical-motion']));
      for (const project of ['spin-studies', 'vertical-motion']) {
        if (!session.progression.purchase(project).ok) throw new Error(`fixture could not research ${project}`);
      }
      edit(session, () => {
        const result = session.world.placeCoaster(type.definitionId, layout, deriveCoasterStats(layout, type), coasterBaseCost(layout, type));
        if ('error' in result) throw new Error(`fixture could not place the coaster: ${result.error}`);
      });
    }
    if (tick === 700) {
      const coaster = [...session.world.objects.values()].find((object) => object.definitionId === 'skyline-serpent');
      if (!coaster) throw new Error('fixture coaster is missing');
      edit(session, () => session.world.bulldoze(coaster.anchor));
    }
  },
  total: 1000,
  savePoints: [
    {
      tick: 250,
      expect: (session) => {
        const record = [...session.world.coasters.values()].find((candidate) => candidate.pieces.some((piece) => piece.freeClimb === true));
        const ride = record ? session.rides.rides.get(record.objectId) : undefined;
        return [
          ...need(record !== undefined, 'the free-climb coaster'),
          ...need(record !== undefined && record.pieces.some((piece) => piece.freeClimb !== true && piece.height > 0), 'a chained climb beside the free ones'),
          ...need(ride !== undefined && ride.cycleRemainingSeconds > 0, 'a cycle in flight'),
        ];
      },
    },
    { tick: 650, expect: (session) => need(rideList(session).some((ride) => ride.completedCycles >= 3), 'a ride with completed cycles') },
    { tick: 701, expect: (session) => need(![...session.world.coasters.values()].some((record) => record.pieces.some((piece) => piece.freeClimb === true)), 'the free-climb coaster is gone') },
  ],
};

/**
 * Fixture 3: the hand-driven trap park (dev layout, 220 guests so every state is reachable quickly).
 * Covers a ride that breaks and is repaired by a mechanic, litter and bins, a closed and reopened
 * park, a research purchase left pending, a fired highest-id worker, training, scenery churn and
 * a path edited between two steps.
 */
const handBuilt: DeterminismFixture = {
  name: 'hand-driven park: breakdown, repair, litter, closure, research',
  build: () => buildDevPark(220),
  act: (session, tick) => {
    if (tick === 0) {
      session.operations.trainStaff('cleaner');
      session.operations.fireStaff('mechanic');
    }
    if (tick === 20) {
      // Demolish and rebuild a ride and a decoration: new ids, tail positions in every Map.
      const rideId = sandboxId(session, 'comet-cups', 1);
      const ride = session.world.objects.get(rideId)!;
      edit(session, () => session.world.bulldoze(ride.anchor));
      edit(session, () => { session.world.buildObject('comet-cups', ride.anchor); });
      const bin = [...session.world.objects.values()].find((object) => object.definitionId === 'tidy-totem');
      if (bin) {
        edit(session, () => session.world.bulldoze(bin.anchor));
        edit(session, () => { session.world.buildObject('tidy-totem', bin.anchor); });
      }
    }
    if (tick === 60) session.operations.hireStaff('mechanic');
    if (tick === 100) {
      for (let index = 0; index < 5; index += 1) session.operations.addLitter({ x: 15, y: 22 + index }, 2);
    }
    if (tick === 120) {
      // A bin filled to the brim: a cleaner must be dispatched for it.
      const bin = [...session.operations.bins.values()][3];
      bin.fill = bin.capacity;
    }
    if (tick >= 200 && tick < 330) {
      // Break the first ride that is not running (a running ride only flags a pending breakdown).
      const idle = rideList(session).find((ride) => !ride.broken && ride.maintenanceKind === null && ride.status !== 'running');
      const anyBroken = rideList(session).some((ride) => ride.broken || ride.maintenanceKind !== null);
      if (idle && !anyBroken) session.rides.forceBreakdown(idle.objectId, session.guests.guests);
    }
    if (tick === 1000) {
      // A ride that is RUNNING cannot break at once: the breakdown is only flagged (pendingBreakdown).
      const running = rideList(session).find((ride) => ride.status === 'running' && !ride.broken && ride.maintenanceKind === null);
      if (running) session.rides.forceBreakdown(running.objectId, session.guests.guests);
    }
    if (tick === 400) session.world.setParkOpen(false);
    if (tick === 700) session.world.setParkOpen(true);
    if (tick === 800) {
      session.progression.grantResearchPoints(scaledResearchGrant(session, 2000, ['spin-studies']));
      session.progression.purchase('spin-studies');
    }
    if (tick === 900) {
      // A path tile removed and re-added between two steps: routes planned before are stale.
      edit(session, () => { session.world.bulldoze({ x: 7, y: 11 }); });
      edit(session, () => { session.world.buildPaths([{ x: 7, y: 11 }]); });
    }
  },
  total: 1500,
  savePoints: [
    { tick: 25 },
    {
      tick: 160,
      expect: (session) => [
        ...need([...session.operations.bins.values()].some((bin) => bin.fill === bin.capacity), 'a full bin'),
        ...need([...session.operations.bins.values()].some((bin) => bin.assignedCleanerId !== null), 'a cleaner assigned to a bin'),
        ...need(session.operations.snapshot().cleanliness.litterUnits > 0, 'litter on the paths'),
        ...need(session.operations.staffTrainingLevel('cleaner') > 0, 'a trained cleaner crew'),
      ],
    },
    {
      tick: 240,
      expect: (session) => [
        ...need(rideList(session).some((ride) => ride.broken), 'a broken ride'),
        ...need(staffList(session).some((worker) => worker.role === 'mechanic' && worker.state === 'walking' && worker.task?.kind === 'repairRide'), 'a mechanic walking to the repair'),
      ],
    },
    {
      tick: 330,
      expect: (session) => [
        ...need(rideList(session).some((ride) => ride.maintenanceKind === 'repair' && ride.maintenanceProgress > 0.1 && ride.maintenanceProgress < 0.9), 'a repair part-way through'),
        ...need(staffList(session).some((worker) => worker.role === 'mechanic' && worker.task?.maintenanceStarted === true), 'a mechanic mid-repair'),
      ],
    },
    { tick: 550, expect: (session) => need(!session.world.parkOpen, 'the park closed') },
    { tick: 800, expect: (session) => need(session.progression.serialize().pendingEvents.length > 0, 'a research event pending (purchase before the step)') },
    { tick: 900 },
    {
      tick: 1000,
      expect: (session) => need(rideList(session).some((ride) => ride.status === 'running' && !ride.broken && ride.maintenanceKind === null), 'a running ride to flag'),
    },
    { tick: 1001, expect: (session) => need(rideList(session).some((ride) => ride.pendingBreakdown), 'a ride with pendingBreakdown set') },
    { tick: 1100 },
    { tick: 1450 },
  ],
};

/**
 * Fixture 3b: a fresh sandbox walked through the First Day ladder by scripted player actions, so
 * the saves land between latches. Covers an unlatched ledger, a partly latched one, a skipped step
 * that later completes anyway, the litter latch, and a dismissed tracker.
 */
const firstDay: DeterminismFixture = {
  name: 'first day: sandbox progression latching, skip and dismiss',
  build: () => new ParkSession(null),
  act: (session, tick) => {
    if (tick === 0) {
      edit(session, () => {
        const cells = [];
        for (let y = 31; y >= 20; y -= 1) cells.push({ x: 15, y });
        session.world.buildPaths(cells);
        buildEastOfAvenue(session, 'petal-roundabout', [26, 22, 18]);
      });
    }
    if (tick === 20) session.rides.setTicketPrice(sandboxId(session, 'petal-roundabout'), 6);
    if (tick === 30) session.onboarding!.skipStep('first-drink');
    if (tick === 100) {
      edit(session, () => {
        buildEastOfAvenue(session, 'picnic-pocket', [29]);
        buildEastOfAvenue(session, 'fizz-foundry', [23, 21, 24]);
      });
    }
    if (tick === 200) session.operations.addLitter({ x: 15, y: 25 }, 4);
    if (tick === 230) session.operations.hireStaff('cleaner');
    if (tick === 900) session.onboarding!.dismissAll();
  },
  total: 1300,
  savePoints: [
    { tick: 0, expect: (session) => need(session.onboarding!.snapshot().completedCount === 0, 'nothing latched yet') },
    { tick: 25 },
    { tick: 60, expect: (session) => need(session.onboarding!.snapshot().completedCount >= 2, 'path and ride latched, later steps pending') },
    { tick: 101, expect: (session) => need(session.onboarding!.snapshot().steps.find((step) => step.id === 'first-drink')!.status === 'skipped', 'a skipped step') },
    { tick: 240, expect: (session) => need(session.onboarding!.serialize().sawLitter || session.onboarding!.snapshot().completedCount >= 5, 'litter seen or services latched') },
    { tick: 600 },
    { tick: 901, expect: (session) => need(session.onboarding!.snapshot().dismissed, 'dismissed') },
  ],
};

/** Fixture 4: the two edge saves, before any step ever ran, and right after removeAll(). */
const earlyAndEmpty = (): DeterminismFixture => ({
  name: 'pre-first-step and right after removeAll',
  build: () => buildDevPark(120),
  act: (session, tick) => {
    if (tick === 200) session.guests.removeAll();
  },
  total: 700,
  savePoints: [{ tick: 0 }, { tick: 200, expect: (session) => need(session.guests.guests.size === 0, 'empty guest Map') }, { tick: 260 }],
});

/**
 * Fixture 5: the park calendar. A 60 s day (600 ticks) crosses two day boundaries, the length is
 * changed mid-day (the re-anchor), and the time lock is set later; save points sit just before and
 * after a boundary, right at the length change and after it.
 */
const calendarDays = (): DeterminismFixture => ({
  name: 'park calendar: short days, a length change and a time lock',
  build: () => {
    const session = buildDevPark(40);
    session.calendar.setDayLength(60);
    return session;
  },
  act: (session, tick) => {
    if (tick === 700) session.calendar.setDayLength(120);
    if (tick === 900) session.calendar.setTimeLock('dusk');
  },
  total: 2000,
  savePoints: [
    { tick: 0 },
    { tick: 599, expect: (session) => need(session.calendarView().day === 1, 'still day 1 one tick before the boundary') },
    { tick: 601, expect: (session) => need(session.calendarView().day === 2, 'day 2 after the boundary') },
    { tick: 699, expect: (session) => need(session.calendar.dayLengthSeconds === 60, 'saved just before the change') },
    { tick: 700, expect: (session) => need(session.calendar.dayLengthSeconds === 120 && session.calendar.anchorTick === 700, 'saved after the re-anchor') },
    { tick: 901, expect: (session) => need(session.calendar.timeLock === 'dusk', 'time lock saved') },
    { tick: 1900, expect: (session) => need(session.calendarView().day >= 3, 'third day reached') },
  ],
});

/**
 * Fixture 6: weather. A storm is placed in day 1's afternoon through the public restore API (valid
 * state), a covered ride, an open-air ride and a player-closed open-air ride stand in a park with
 * guests, the severity changes in the middle of the storm, opening hours switch on at 15:00 (so the
 * gate closes mid-run, guests go home) and off again. Save points sit before, at the start of,
 * inside and after the storm, with the gate shut, and after it reopened.
 */
const stormyDay = (): DeterminismFixture => ({
  name: 'weather: a stormy afternoon with a storm-closed ride, a player-closed ride and opening hours',
  build: () => {
    const session = new ParkSession(null);
    // The open-air rides are research unlocks: buy the two it needs through the public API, so the
    // restored twin (which rebuilds the access policy itself) agrees about what is unlocked.
    session.progression.grantResearchPoints(scaledResearchGrant(session, 100_000, ['spin-studies', 'family-favorites']));
    for (const id of ['comet-cups', 'bumble-coach']) {
      const projectId = PROJECT_BY_BUILD_ID.get(id);
      if (!projectId || !session.progression.purchase(projectId)) throw new Error(`fixture could not unlock ${id}`);
    }
    session.world.addMoney(40_000);
    const cells = [];
    for (let y = 31; y >= 20; y -= 1) cells.push({ x: 15, y });
    session.world.buildPaths(cells);
    session.world.buildObject('comet-cups', { x: 12, y: 26 });
    session.world.buildObject('petal-roundabout', { x: 16, y: 26 });
    session.world.buildObject('bumble-coach', { x: 11, y: 22 });
    session.world.buildObject('picnic-pocket', { x: 16, y: 29 });
    session.world.buildObject('glacier-scoop', { x: 13, y: 29 });
    session.syncWithWorld();
    session.guests.spawnGuests(60);
    // Day 1, slot 1 (12:00-18:00) begins at tick 1,800 at the default day length.
    if (!session.weather.forceCurrentSlot('storm', 0.9, 1_900)) throw new Error('fixture could not place the storm');
    return session;
  },
  act: (session, tick) => {
    if (tick === 100) session.rides.setOpen(sandboxId(session, 'bumble-coach'), false);
    if (tick === 2_000) session.setWeatherSeverity('high');
    if (tick === 2_600) session.setWeatherSeverity('normal');
    if (tick === 3_000) session.setOpeningHours(true, 6, 15);
    if (tick === 3_300) session.setOpeningHours(false, 8, 21);
  },
  total: 4_200,
  savePoints: [
    { tick: 1_700, expect: (session) => need(session.rides.stormClosedCount() === 0, 'no storm yet') },
    { tick: 1_801, expect: (session) => need(session.rides.stormClosedCount() === 1, 'the storm just started and closed the open-air ride') },
    {
      tick: 2_200,
      expect: (session) => [
        ...need(session.rides.stormClosedCount() === 1, 'a storm-closed ride'),
        ...need(session.rides.snapshot(sandboxId(session, 'bumble-coach'))!.closureReason === 'player', 'a player-closed ride inside the storm'),
        ...need(session.rides.snapshot(sandboxId(session, 'petal-roundabout'))!.closureReason === null, 'the covered ride keeps running'),
        ...need(session.weather.severity === 'high', 'high severity'),
      ],
    },
    { tick: 2_999 },
    { tick: 3_050, expect: (session) => need(!session.world.gateOpen && session.world.parkOpen, 'the opening hours closed the gate') },
    { tick: 3_301, expect: (session) => need(session.world.gateOpen && !session.calendar.hoursEnabled, 'hours off again, gate open') },
    { tick: 3_700, expect: (session) => need(session.rides.stormClosedCount() === 0, 'the storm has passed and the ride reopened') },
  ],
});

/**
 * Fixture 13 (Phase 24): Red Rock Canyon (gate (16, 0) facing south, a desert climate and rules) with the First
 * Day route built in the gate frame, boulders and a cactus cleared for money in the middle of the run, a
 * permanent wall refused, and a hot afternoon forced over day 1. Save points sit before and after a clear
 * and inside the hot slot, so the `map` layer (the remaining props), the cleared land, the land-clearing ledger
 * rows, the biome rule keys and the climate all run under the determinism proof.
 */
const redRockCanyon = (): DeterminismFixture => {
  const propOf = (session: ParkSession, kind: string, occurrence = 0) => {
    const found = [...session.world.props.values()].filter((prop) => prop.kind === kind)[occurrence];
    if (!found) throw new Error(`fixture needs a ${kind} (#${occurrence})`);
    return found;
  };
  return {
    name: 'red rock canyon: First Day route in the gate frame, boulders cleared, a hot afternoon',
    build: () => {
      const session = new ParkSession(null, [], { mapId: 'red-rock-canyon' });
      buildFirstDayRoute(session);
      session.guests.spawnGuests(80);
      // Day 1, slot 1 (12:00-18:00) begins at tick 1,800 at the default day length.
      if (!session.weather.forceCurrentSlot('hot', 0.9, 1_900)) throw new Error('fixture could not place the heat');
      return session;
    },
    act: (session, tick) => {
      if (tick === 300) edit(session, () => session.world.bulldoze(propOf(session, 'red-boulder', 0)));
      if (tick === 900) {
        edit(session, () => {
          session.world.bulldoze(propOf(session, 'saguaro', 0));
          session.world.bulldoze(propOf(session, 'red-boulder', 0));
          // A permanent canyon wall refuses and changes nothing.
          session.world.bulldoze(propOf(session, 'canyon-wall', 0));
        });
      }
      if (tick === 1_200) session.setWeatherSeverity('high');
      if (tick === 2_800) session.setWeatherSeverity('normal');
    },
    total: 4_000,
    savePoints: [
      { tick: 299, expect: (session) => need(session.world.props.size === session.map.props.length, 'no prop cleared yet') },
      { tick: 301, expect: (session) => need(session.world.props.size === session.map.props.length - 1 && session.world.transactions.some((entry) => entry.category === 'land-clearing'), 'the first boulder was cleared and booked') },
      { tick: 901, expect: (session) => need(session.world.props.size <= session.map.props.length - 3 && session.rules.thirstRateMultiplier === 1.12, 'three props cleared, the desert thirst rule in the ruleset') },
      { tick: 2_000, expect: (session) => need(session.weather.conditions.weatherKind === 'hot' && session.weather.conditions.coldTreatBonus > 5, 'inside the hot slot, the climate adds to the heat') },
      { tick: 2_900 },
      { tick: 3_999 },
    ],
  };
};

/**
 * Fixture 2c (Phase 25): a run stage (seed 2, level 1, Meadow) whose one-shot Bridging Loan is played at tick 300 (+$2,000
 * now); its $2,400 repayment is pending in the `plays` ledger until it falls due at tick 2,700. Saved before the play,
 * after it, just before the cost and just after it.
 */
const runStageOneShot = (): DeterminismFixture => ({
  name: 'run stage, one-shot played at tick 300, cost due at 2,700',
  build: () => testStageSession({ seed: 2, cardIds: ['bridging-loan'] }).session,
  act: (session, tick) => {
    if (tick === 0) {
      edit(session, () => {
        const w = session.world;
        const frame = entranceFrame({ ...w.entrance, facing: w.entranceFacing });
        w.buildPaths(Array.from({ length: 10 }, (_, depth) => frame.toWorld(0, depth + 1)));
        w.buildObject('moonpetal-carousel', frame.rectToWorld(1, 3, 3, 3), frame.rotation);
        w.buildObject('picnic-pocket', frame.rectToWorld(1, 1, 1, 1), frame.rotation);
        w.buildObject('fizz-foundry', frame.rectToWorld(-2, 1, 1, 1), frame.rotation);
      });
      session.operations.hireStaff('cleaner');
    }
    if (tick === 300) {
      const result = session.playCard('bridging-loan');
      if (!result.ok) throw new Error(`fixture 2c: the loan could not be played (${result.reason})`);
    }
  },
  total: 2_900,
  savePoints: [
    { tick: 250, expect: (session) => need(session.plays?.hasPlayed('bridging-loan') === false, 'the loan is not played yet') },
    {
      tick: 350,
      expect: (session) => [
        ...need(session.plays?.unpaidTotal() === 2_400, 'the repayment is pending'),
        ...need(session.plays?.pendingOf('bridging-loan')?.dueTick === 2_700, 'it falls due at tick 2,700'),
      ],
    },
    { tick: 2_650, expect: (session) => need(session.plays?.unpaidTotal() === 2_400, 'still pending just before it falls due') },
    { tick: 2_750, expect: (session) => need(session.plays?.unpaidTotal() === 0 && session.world.transactions.some((entry) => entry.amount === -2_400), 'repaid') },
  ],
});

export const DETERMINISM_FIXTURES: readonly DeterminismFixture[] = [
  devPark1000,
  scenarioCards(),
  scenarioSuccessLatch(),
  scenarioFailureLatch(),
  scenarioSustainStreak(),
  runStageOneShot(),
  playerCoaster,
  freeClimbCoaster,
  handBuilt,
  firstDay,
  earlyAndEmpty(),
  calendarDays(),
  stormyDay(),
  redRockCanyon(),
];
