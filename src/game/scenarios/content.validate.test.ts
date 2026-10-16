import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { MAP_BY_ID } from '../maps/content';
import { entranceFrame } from '../maps/frame';
import { layoutOfMapId } from '../maps/parse';
import { BONUSES, BONUS_BY_ID } from '../profile/bonuses';
import { PROFILE_GATED_IDS, isProfileGated } from '../profile/unlocks';
import { TOUR_NODES } from '../tour/content';
import { ParkSession } from '../session/ParkSession';
import { FOUNDING_SCENARIO_IDS, MAXIMUM_DEADLINE_DAYS, SCENARIOS, SCENARIO_BY_ID, defineScenario } from './content';
import { CARD_MODIFIABLE_RULES, RULE_CLAMPS, compileParkRules } from './rules';
import { SCENARIO_DIFFICULTY_LABELS, type ScenarioDefinition, type ScenarioId } from './types';
import { describeUnlockCondition, isScenarioUnlocked } from './unlock';

describe('scenario data validation (Phase 22: scenarios are data)', () => {
  it('has ten scenarios: the four shipped, one per new biome and the Phase 21 estate', () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'sunny-start', 'penny-lane', 'garden-gala', 'starlight-finale',
      'boardwalk-breeze', 'canyon-caravan', 'frost-fair', 'ruins-rush', 'harvest-festival', 'room-to-grow',
    ]);
    expect(SCENARIO_BY_ID.size).toBe(10);
    expect(new Set(SCENARIOS.map((scenario) => scenario.seed)).size, 'every scenario has its own seed').toBe(10);
    expect(SCENARIOS.slice(4, 9).map((scenario) => MAP_BY_ID.get(scenario.mapId!)?.biome)).toEqual(['seaside', 'desert-canyon', 'winter', 'jungle', 'autumn-forest']);
    expect(new Set(SCENARIOS.slice(4).map((scenario) => scenario.mapId)).size, 'each new scenario is on its own map').toBe(6);
    expect(SCENARIO_BY_ID.get('room-to-grow')?.mapId, 'the Phase 21 scenario plays the estate').toBe('meadow-estate');
  });

  it('every field is present and sane', () => {
    for (const scenario of SCENARIOS) {
      const where = scenario.id;
      expect(scenario.name.length, where).toBeGreaterThan(0);
      expect(scenario.tagline.endsWith('.'), `${where} tagline`).toBe(true);
      expect(scenario.description.length, where).toBeGreaterThan(20);
      expect(Object.keys(SCENARIO_DIFFICULTY_LABELS).map(Number), where).toContain(scenario.difficulty);
      expect(scenario.cardSlots, where).toBe(2);
      expect(scenario.rewards.cardDraftChoices, where).toBe(3);
      expect(scenario.timeLimitSeconds, where).toBeGreaterThan(0);
      expect(scenario.objective.target, where).toBeGreaterThan(0);
      if (scenario.constraint) {
        expect(scenario.constraint.name.length, where).toBeGreaterThan(0);
        expect(scenario.constraint.detail.length, where).toBeGreaterThan(0);
      }
    }
  });

  it('the five new deadlines are written in days (a multiple of a weather slot) and compile to seconds', () => {
    for (const scenario of SCENARIOS.slice(4)) {
      expect(scenario.timeLimitDays, scenario.id).toBeDefined();
      expect(scenario.timeLimitDays! * 4, scenario.id).toBe(Math.round(scenario.timeLimitDays! * 4));
      expect(scenario.timeLimitDays!, scenario.id).toBeLessThanOrEqual(MAXIMUM_DEADLINE_DAYS);
      expect(scenario.timeLimitSeconds, scenario.id).toBe(scenario.timeLimitDays! * GAME_CONFIG.calendar.defaultDayLengthSeconds);
    }
    expect(() => defineScenario({ ...SCENARIO_BY_ID.get('frost-fair')!, timeLimitDays: 1.1, timeLimitSeconds: undefined } as never)).toThrow(/multiple/);
  });

  it('the objectives span the existing families (reach, earn, sustain) and metrics', () => {
    const kinds = new Set(SCENARIOS.map((scenario) => scenario.objective.kind));
    expect([...kinds].sort()).toEqual(['earn', 'reach', 'sustain']);
    const metrics = new Set(SCENARIOS.map((scenario) => scenario.objective.metric));
    expect(metrics.size).toBeGreaterThanOrEqual(5);
    for (const scenario of SCENARIOS.slice(4)) {
      const objective = scenario.objective;
      if (objective.kind === 'sustain') expect(objective.durationSeconds, scenario.id).toBeLessThan(scenario.timeLimitSeconds);
    }
  });

  it('every map exists, the setup is a straight stub from the gate on buildable, unobstructed cells and the park holds all of it', () => {
    for (const scenario of SCENARIOS) {
      const layout = layoutOfMapId(scenario.mapId ?? 'meadow');
      const frame = entranceFrame(layout.entrance);
      const setupPaths = scenario.setup.paths;
      for (const cell of [...setupPaths, ...scenario.setup.objects.map((object) => object.anchor)]) {
        expect(cell.x, `${scenario.id} inside`).toBeGreaterThanOrEqual(0);
        expect(cell.y, `${scenario.id} inside`).toBeGreaterThanOrEqual(0);
        expect(cell.x, `${scenario.id} inside`).toBeLessThan(layout.width);
        expect(cell.y, `${scenario.id} inside`).toBeLessThan(layout.height);
      }
      const session = new ParkSession(scenario, [], { mode: 'scenario' });
      for (const cell of setupPaths) expect(session.world.paths.has(`${cell.x},${cell.y}`), `${scenario.id}: setup path ${cell.x},${cell.y} was stamped`).toBe(true);
      expect(session.world.objects.size, `${scenario.id}: every setup object was stamped`).toBe(scenario.setup.objects.length);
      // Contiguous from the gate: walk the stub outward from the gate cell.
      const seen = new Set<string>();
      const queue = [{ x: layout.entrance.x, y: layout.entrance.y }];
      const wanted = new Set(setupPaths.map((cell) => `${cell.x},${cell.y}`));
      while (queue.length > 0) {
        const cell = queue.pop()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = { x: cell.x + dx, y: cell.y + dy };
          const key = `${next.x},${next.y}`;
          if (wanted.has(key) && !seen.has(key)) { seen.add(key); queue.push(next); }
        }
      }
      expect(seen.size, `${scenario.id}: the setup paths are connected to the gate`).toBe(wanted.size);
      if (scenario.mapId !== undefined) {
        const expected = [1, 2, 3].map((depth) => frame.toWorld(0, depth));
        expect(setupPaths, `${scenario.id}: a straight 3-cell stub inward from the gate`).toEqual(expected);
      }
    }
  });

  it('setup objects are never profile-gated and the setup never needs a research unlock', () => {
    for (const scenario of SCENARIOS) {
      for (const object of scenario.setup.objects) {
        expect(isProfileGated(object.definitionId), scenario.id).toBe(false);
        expect(BUILD_BY_ID.has(object.definitionId), scenario.id).toBe(true);
      }
    }
  });

  it('cash is within the rule clamps and rule overrides touch only the keys a scenario may', () => {
    const allowed = new Set<string>(['startingCash', 'lockedDefinitionIds', ...CARD_MODIFIABLE_RULES]);
    for (const scenario of SCENARIOS) {
      const cash = scenario.rules.startingCash!;
      expect(cash, scenario.id).toBeGreaterThanOrEqual(RULE_CLAMPS.minimumStartingCash);
      expect(cash, scenario.id).toBeLessThanOrEqual(RULE_CLAMPS.maximumStartingCash);
      for (const key of Object.keys(scenario.rules)) expect(allowed.has(key), `${scenario.id}.${key}`).toBe(true);
      for (const [key, value] of Object.entries(scenario.rules)) {
        if (typeof value !== 'number' || key === 'startingCash') continue;
        expect(value, `${scenario.id}.${key}`).toBeGreaterThanOrEqual(RULE_CLAMPS.minimumMultiplier);
        expect(value, `${scenario.id}.${key}`).toBeLessThanOrEqual(RULE_CLAMPS.maximumMultiplier);
      }
      // The compile keeps the overrides as written (they are inside the clamps).
      const compiled = compileParkRules(scenario.rules);
      for (const [key, value] of Object.entries(scenario.rules)) {
        if (key === 'lockedDefinitionIds') expect(compiled.lockedDefinitionIds, scenario.id).toEqual(value);
        else expect((compiled as unknown as Record<string, unknown>)[key], `${scenario.id}.${key}`).toBe(value);
      }
    }
  });

  it('a constraint is told whenever a rule override exists (the copy and the rules agree)', () => {
    for (const scenario of SCENARIOS) {
      const overrides = Object.keys(scenario.rules).filter((key) => key !== 'startingCash');
      expect(scenario.constraint !== null, scenario.id).toBe(overrides.length > 0);
    }
  });

  it('lockedDefinitionIds never lock all food, all drink or all rides that are open at park start', () => {
    for (const scenario of SCENARIOS) {
      const locked = new Set(scenario.rules.lockedDefinitionIds ?? []);
      const session = new ParkSession(scenario, [], { mode: 'scenario' });
      const open = (predicate: (id: string) => boolean): number => [...BUILD_BY_ID.values()]
        .filter((definition) => predicate(definition.id) && !locked.has(definition.id) && session.world.isDefinitionUnlocked(definition.id)).length;
      expect(open((id) => BUILD_BY_ID.get(id)!.kind === 'ride'), `${scenario.id} rides`).toBeGreaterThan(0);
      expect(open((id) => BUILD_BY_ID.get(id)!.stats?.serviceType === 'food'), `${scenario.id} food`).toBeGreaterThan(0);
      expect(open((id) => BUILD_BY_ID.get(id)!.stats?.serviceType === 'drink'), `${scenario.id} drink`).toBeGreaterThan(0);
      expect(open((id) => BUILD_BY_ID.get(id)!.stats?.serviceType === 'toilet'), `${scenario.id} toilets`).toBeGreaterThan(0);
    }
  });

  it('rewards reference existing gated ids and bonuses, and each gated id and each bonus is granted exactly once', () => {
    const unlockCounts = new Map<string, number>();
    const bonusCounts = new Map<string, number>();
    for (const scenario of SCENARIOS) {
      for (const id of scenario.rewards.unlocks) {
        expect(isProfileGated(id), `${scenario.id} unlock ${id}`).toBe(true);
        unlockCounts.set(id, (unlockCounts.get(id) ?? 0) + 1);
      }
      for (const id of scenario.rewards.bonuses) {
        expect(BONUS_BY_ID.has(id), `${scenario.id} bonus ${id}`).toBe(true);
        bonusCounts.set(id, (bonusCounts.get(id) ?? 0) + 1);
      }
      expect(new Set(scenario.rewards.unlocks).size, scenario.id).toBe(scenario.rewards.unlocks.length);
      expect(new Set(scenario.rewards.bonuses).size, scenario.id).toBe(scenario.rewards.bonuses.length);
      expect(scenario.rewards.unlocks.length + scenario.rewards.bonuses.length, `${scenario.id} has a reward`).toBeGreaterThan(0);
    }
    for (const id of PROFILE_GATED_IDS) expect(unlockCounts.get(id), id).toBe(1);
    for (const bonus of BONUSES) expect(bonusCounts.get(bonus.id), bonus.id).toBe(1);
    expect(unlockCounts.size).toBe(PROFILE_GATED_IDS.length);
  });

  it('the unlock graph references known scenarios, is acyclic and opens every scenario from the always-open set by clears alone', () => {
    const ids = new Set<ScenarioId>(SCENARIOS.map((scenario) => scenario.id));
    for (const scenario of SCENARIOS) {
      if (scenario.unlockedBy.kind === 'clear-any') {
        expect(scenario.unlockedBy.scenarioIds.length, scenario.id).toBeGreaterThan(0);
        for (const id of scenario.unlockedBy.scenarioIds) {
          expect(ids.has(id), `${scenario.id} depends on ${id}`).toBe(true);
          expect(id, `${scenario.id} depends on itself`).not.toBe(scenario.id);
        }
      }
    }
    // Reachability by BFS (clearing everything open, repeatedly) also proves acyclicity from the roots.
    const cleared = new Set<ScenarioId>();
    const order: ScenarioId[] = [];
    for (let round = 0; round < SCENARIOS.length; round += 1) {
      const open = SCENARIOS.filter((scenario) => !cleared.has(scenario.id) && isScenarioUnlocked(scenario, cleared));
      if (open.length === 0) break;
      for (const scenario of open) { cleared.add(scenario.id); order.push(scenario.id); }
    }
    expect(order.length, 'every scenario is reachable').toBe(SCENARIOS.length);
    expect(SCENARIOS.filter((scenario) => scenario.unlockedBy.kind === 'always').map((scenario) => scenario.id)).toEqual(['sunny-start']);
    // Acyclic: the rounds above only finish when no scenario waits on a later one.
    const position = new Map(order.map((id, index) => [id, index]));
    for (const scenario of SCENARIOS) {
      if (scenario.unlockedBy.kind !== 'clear-any') continue;
      expect(Math.min(...scenario.unlockedBy.scenarioIds.map((id) => position.get(id)!)), scenario.id).toBeLessThan(position.get(scenario.id)!);
    }
  });

  it('unlock text reads right', () => {
    const text = (id: ScenarioId): string | null => describeUnlockCondition(SCENARIO_BY_ID.get(id)!);
    expect(text('sunny-start')).toBeNull();
    expect(text('penny-lane')).toBe('Clear Sunny Start first');
    expect(text('starlight-finale')).toBe('Clear Penny Lane or Garden Gala first');
    expect(text('canyon-caravan')).toBe('Clear Penny Lane or Boardwalk Breeze first');
    expect(isScenarioUnlocked(SCENARIO_BY_ID.get('starlight-finale')!, new Set(['garden-gala']))).toBe(true);
    expect(isScenarioUnlocked(SCENARIO_BY_ID.get('starlight-finale')!, new Set(['sunny-start']))).toBe(false);
  });

  it('the Park Tour nodes still reference only the four shipped scenarios', () => {
    for (const node of TOUR_NODES) expect(FOUNDING_SCENARIO_IDS).toContain(node.scenarioId);
  });

  it('every scenario builds a park on its own map with its own seed and biome rules', () => {
    for (const scenario of SCENARIOS) {
      const session = new ParkSession(scenario, [], { mode: 'scenario' });
      expect(session.map.id, scenario.id).toBe(scenario.mapId ?? 'meadow');
      expect(session.seed, scenario.id).toBe(scenario.seed);
      expect(session.world.cash, scenario.id).toBe(scenario.rules.startingCash);
    }
  });

  it('a scenario definition is plain data: it survives structuredClone', () => {
    for (const scenario of SCENARIOS) expect(structuredClone(scenario) as ScenarioDefinition).toEqual(scenario);
  });
});
