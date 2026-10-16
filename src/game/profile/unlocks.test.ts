import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../content/catalog';
import { COLOURABLE_DEFINITION_IDS } from '../content/colours';
import { GAME_CONFIG } from '../config';
import { PROJECT_BY_BUILD_ID, scaledResearchPoints } from '../progression/content';
import { researchCostScaleOf } from '../scenarios/rules';
import { hashState } from '../save/hash';
import { gamePalette } from '../../rendering/voxel/gamePalette';
import { SCENARIOS, SCENARIO_BY_ID } from '../scenarios/content';
import { testStageSession } from '../run/testSupport';
import { entranceFrame } from '../maps/frame';
import { EMPTY_GRANT, ParkSession } from '../session/ParkSession';
import type { BuildDefinition } from '../types';
import { PROFILE_GATED_IDS, isProfileGated, normaliseGatedIds, unlockConditionText, unlockSourceOf } from './unlocks';

const sandbox = (unlocked: readonly string[] = []): ParkSession => new ParkSession(null, [], { grant: { unlockedBuildingIds: unlocked, bonusIds: [] } });

describe('the four profile-gated catalog entries', () => {
  it('are appended after the original catalog (Phase 16 appends after them), in this order, flagged profileGate and nothing else is', () => {
    expect(PROFILE_GATED_IDS).toEqual(['tiki-tumbler', 'cactus-cooler', 'cocoa-chalet', 'lantern-maple']);
    const first = BUILD_CATALOG.findIndex((definition) => definition.id === 'tiki-tumbler');
    expect(BUILD_CATALOG[first - 1]?.id).toBe('ripple-fountain');
    expect(BUILD_CATALOG.slice(first, first + 4).map((definition) => definition.id)).toEqual(PROFILE_GATED_IDS);
    expect(BUILD_CATALOG[first + 4]?.id).toBe('puddle-jumpers');
    expect(BUILD_CATALOG.filter((definition) => definition.profileGate).map((definition) => definition.id)).toEqual(PROFILE_GATED_IDS);
    for (const id of PROFILE_GATED_IDS) expect(isProfileGated(id), id).toBe(true);
    expect(isProfileGated('comet-cups')).toBe(false);
    expect(isProfileGated('__proto__')).toBe(false);
  });

  it('have no research project, so only the profile gate decides', () => {
    for (const id of PROFILE_GATED_IDS) expect(PROJECT_BY_BUILD_ID.has(id), id).toBe(false);
  });

  it('are each the reward of exactly one scenario, which names it in the lock text', () => {
    for (const id of PROFILE_GATED_IDS) {
      const sources = SCENARIOS.filter((scenario) => scenario.rewards.unlocks.includes(id));
      expect(sources, id).toHaveLength(1);
      expect(unlockSourceOf(id)).toBe(sources[0].id);
      expect(unlockConditionText(id)).toBe(`Clear ${sources[0].name} in Scenario mode`);
    }
    expect(unlockSourceOf('comet-cups')).toBeUndefined();
    expect(unlockConditionText('nope')).toMatch(/scenarios/);
  });

  it('fit their biome: the source scenario is on a matching map', () => {
    const biomeOf = (id: string): string | undefined => SCENARIO_BY_ID.get(unlockSourceOf(id)!)?.mapId;
    expect(biomeOf('tiki-tumbler')).toBe('seaside-cove');
    expect(biomeOf('cactus-cooler')).toBe('red-rock-canyon');
    expect(biomeOf('cocoa-chalet')).toBe('frosted-hollow');
    expect(biomeOf('lantern-maple')).toBe('maple-ridge');
  });

  it('normaliseGatedIds keeps gated ids in catalog order and drops everything else', () => {
    expect(normaliseGatedIds(['lantern-maple', 'comet-cups', 7, 'tiki-tumbler', 'tiki-tumbler', '__proto__'])).toEqual(['tiki-tumbler', 'lantern-maple']);
  });
});

describe('the palette costs nothing: the new entries reuse existing catalog colours', () => {
  it('the voxel palette is the one it was before the entries existed (count pinned from the schema-9 code; the texture digest is hashState of its bytes, equal to the sha256 captured before the entries existed)', () => {
    const palette = gamePalette();
    expect(palette.count).toBe(162);
    expect(hashState(Array.from(palette.textureData()))).toBe('f432d9c53824dca8');
  });

  it('each entry colour and accent is an existing catalog colour or accent', () => {
    const existing = BUILD_CATALOG.filter((definition) => !definition.profileGate);
    const colours = new Set(existing.map((definition) => definition.color));
    const accents = new Set([...existing.map((definition) => definition.accent), ...colours]);
    for (const id of PROFILE_GATED_IDS) {
      const definition = BUILD_BY_ID.get(id)!;
      expect(colours.has(definition.color) || accents.has(definition.color), `${id} colour`).toBe(true);
      expect(accents.has(definition.accent), `${id} accent`).toBe(true);
    }
  });

  it('three are colourable like their kind, the tree is fixed like the Confetti Tree', () => {
    for (const id of ['tiki-tumbler', 'cactus-cooler', 'cocoa-chalet']) expect(COLOURABLE_DEFINITION_IDS, id).toContain(id);
    expect(COLOURABLE_DEFINITION_IDS).not.toContain('lantern-maple');
  });
});

/** A weak Pareto comparison: `a` is at least as good in every dimension and strictly better in one. */
const dominates = (a: readonly number[], b: readonly number[]): boolean => (
  a.every((value, index) => value >= b[index]) && a.some((value, index) => value > b[index])
);

const vectorOf = (definition: BuildDefinition): number[] | null => {
  const stats = definition.stats ?? {};
  if (definition.kind === 'ride') {
    return [stats.capacity ?? 0, stats.excitement ?? 0, stats.reliability ?? 0, -(stats.runningCost ?? 0), -definition.buildCost];
  }
  if (stats.serviceType) return [stats.needRelief ?? 0, -(stats.serviceDuration ?? 0), stats.itemPrice ?? 0, -definition.buildCost];
  if (definition.kind === 'scenery') return [stats.sceneryAppeal ?? 0, stats.sceneryRadius ?? 0, -definition.buildCost];
  return null;
};

describe('no dominance: a gated entry is never strictly better than an existing one of its kind', () => {
  it('pairwise over every stat that matters', () => {
    for (const id of PROFILE_GATED_IDS) {
      const gated = BUILD_BY_ID.get(id)!;
      const mine = vectorOf(gated)!;
      for (const other of BUILD_CATALOG) {
        if (other.profileGate || other.kind !== gated.kind || other.custom) continue;
        if (gated.stats?.serviceType !== other.stats?.serviceType) continue;
        const theirs = vectorOf(other);
        if (!theirs) continue;
        expect(dominates(mine, theirs), `${gated.id} must not dominate ${other.id}`).toBe(false);
      }
    }
  });

  it('and fits a slot between the neighbours it was designed against', () => {
    const tiki = BUILD_BY_ID.get('tiki-tumbler')!.stats!;
    const cups = BUILD_BY_ID.get('comet-cups')!.stats!;
    expect(tiki.excitement!).toBeGreaterThan(cups.excitement!);
    expect(tiki.capacity!).toBeLessThan(cups.capacity!);
    expect(tiki.reliability!).toBeLessThan(cups.reliability!);
    const cactus = BUILD_BY_ID.get('cactus-cooler')!;
    const fizz = BUILD_BY_ID.get('fizz-foundry')!;
    expect(cactus.stats!.serviceDuration!).toBeLessThan(fizz.stats!.serviceDuration!);
    expect(cactus.stats!.needRelief!).toBeLessThan(fizz.stats!.needRelief!);
    expect(cactus.buildCost).toBeGreaterThan(fizz.buildCost);
    const maple = BUILD_BY_ID.get('lantern-maple')!;
    const tree = BUILD_BY_ID.get('confetti-tree')!;
    expect(maple.stats!.sceneryAppeal! / maple.buildCost).toBeLessThan(tree.stats!.sceneryAppeal! / tree.buildCost);
  });
});

describe('gating end to end: a locked building cannot be built, placed or ghosted, and says why', () => {
  const anchorFor = (_session: ParkSession, definitionId: string): { x: number; y: number } => {
    const definition = BUILD_BY_ID.get(definitionId)!;
    // The meadow apron north of the gate is clear: any anchor with its footprint inside it works.
    return { x: 16, y: 31 - 4 - definition.footprint[1] };
  };

  it.each(PROFILE_GATED_IDS)('%s: locked in a park without the grant', (id) => {
    const session = sandbox();
    const anchor = anchorFor(session, id);
    expect(session.world.isDefinitionUnlocked(id)).toBe(false);
    expect(session.world.checkObjectBuild(id, anchor, 0)).toEqual({ ok: false, reason: 'locked' });
    const cash = session.world.cash;
    expect(session.world.buildObject(id, anchor, 0)).toBeNull();
    expect(session.world.cash, 'a refused build costs nothing').toBe(cash);
    expect(session.world.objects.size).toBe(0);
    expect(session.buildLockOf(id)).toEqual({ kind: 'profile', text: unlockConditionText(id) });
    expect(session.profileLocks().map((lock) => lock.definitionId)).toContain(id);
    expect(session.profileLocks().find((lock) => lock.definitionId === id)?.text).toBe(unlockConditionText(id));
  });

  it.each(PROFILE_GATED_IDS)('%s: buildable from the start in a run stage when the run grant holds it, locked without', (id) => {
    const definition = BUILD_BY_ID.get(id)!;
    for (const granted of [true, false]) {
      const { session } = testStageSession({ grant: { unlockedBuildingIds: granted ? [id] : [], bonusIds: [] } });
      const frame = entranceFrame({ ...session.world.entrance, facing: session.world.entranceFacing });
      const anchor = frame.rectToWorld(1, 4, definition.footprint[0], definition.footprint[1]);
      expect(session.mode).toBe('run');
      expect(session.world.isDefinitionUnlocked(id), `${id} granted ${granted}`).toBe(granted);
      expect(session.buildLockOf(id)?.kind ?? null).toBe(granted ? null : 'profile');
      if (granted) {
        expect(session.world.buildObject(id, anchor, frame.rotation), `${id} in a run stage`).not.toBeNull();
      } else {
        expect(session.world.buildObject(id, anchor, frame.rotation)).toBeNull();
      }
    }
  });

  it.each(PROFILE_GATED_IDS)('%s: buildable from the start when the grant holds it, in Sandbox and Scenario', (id) => {
    for (const make of [
      () => sandbox([id]),
      () => new ParkSession(SCENARIOS[0], [], { mode: 'scenario', grant: { unlockedBuildingIds: [id], bonusIds: [] } }),
    ]) {
      const session = make();
      const anchor = anchorFor(session, id);
      expect(session.world.isDefinitionUnlocked(id)).toBe(true);
      expect(session.buildLockOf(id)).toBeNull();
      expect(session.profileLocks().map((lock) => lock.definitionId)).not.toContain(id);
      const built = session.world.buildObject(id, anchor, 0);
      expect(built, `${id} in ${session.mode}`).not.toBeNull();
      session.syncWithWorld();
      expect(session.serialize().world.objects.some((object) => object.definitionId === id)).toBe(true);
    }
  });

  it('the grant unlocks only what it names', () => {
    const session = sandbox(['tiki-tumbler']);
    expect(session.profileLocks().map((lock) => lock.definitionId)).toEqual(['cactus-cooler', 'cocoa-chalet', 'lantern-maple']);
    expect(session.world.isDefinitionUnlocked('cactus-cooler')).toBe(false);
    expect(session.buildLockOf('tiki-tumbler')).toBeNull();
  });

  it('an empty grant locks all four and every older entry answers exactly as before', () => {
    const session = new ParkSession(null, [], { grant: EMPTY_GRANT });
    for (const definition of BUILD_CATALOG) {
      const expected = !definition.profileGate && !PROJECT_BY_BUILD_ID.has(definition.id);
      expect(session.world.isDefinitionUnlocked(definition.id), definition.id).toBe(expected);
    }
  });

  it('keeps the other two kinds of lock apart: research and scenario rules', () => {
    const session = sandbox(['tiki-tumbler']);
    expect(session.buildLockOf('comet-cups')).toEqual({ kind: 'research', projectId: 'spin-studies' });
    expect(session.buildLockOf('picnic-pocket')).toBeNull();
    const gala = new ParkSession(SCENARIO_BY_ID.get('garden-gala')!, [], { mode: 'scenario' });
    expect(gala.buildLockOf('tidy-totem')).toEqual({ kind: 'scenario', conditionName: 'Bin shipment delayed' });
    expect(gala.world.checkObjectBuild('tidy-totem', { x: 17, y: 22 }, 0)).toEqual({ ok: false, reason: 'locked' });
  });

  it('the research tree still works for the rest: a project unlocks its entry whatever the grant', () => {
    const session = sandbox();
    session.progression.grantResearchPoints(scaledResearchPoints(200, researchCostScaleOf(session.rules)));
    session.world.postTransaction(5_000, 'test cash', 'other' as never);
    expect(session.progression.purchase('spin-studies')).toMatchObject({ ok: true });
    expect(session.world.isDefinitionUnlocked('comet-cups')).toBe(true);
    expect(session.buildLockOf('comet-cups')).toBeNull();
    expect(session.world.isDefinitionUnlocked('tiki-tumbler')).toBe(false);
  });

  it('a save that holds a gated building the grant lacks still loads (integrity is not authenticity)', () => {
    const session = sandbox(['tiki-tumbler']);
    session.world.buildObject('tiki-tumbler', anchorFor(session, 'tiki-tumbler'), 0);
    session.syncWithWorld();
    const state = JSON.parse(JSON.stringify(session.serialize()));
    state.grant = { unlockedBuildingIds: [], bonusIds: [] };
    const restored = ParkSession.fromState(state);
    expect(restored.world.objects.size).toBe(1);
    expect(restored.world.isDefinitionUnlocked('tiki-tumbler')).toBe(false);
  });

  it('a built Tiki Tumbler runs: guests ride it and it earns', () => {
    const session = sandbox(['tiki-tumbler']);
    const frame = { x: 15, y: 31 };
    const cells = [];
    for (let d = 1; d <= 8; d += 1) cells.push({ x: frame.x, y: frame.y - d });
    session.world.buildPaths(cells);
    const tiki = session.world.buildObject('tiki-tumbler', { x: 16, y: 31 - 5 }, 0)!;
    session.world.buildObject('moonpetal-carousel', { x: 12, y: 31 - 5 }, 0);
    session.syncWithWorld();
    for (let tick = 0; tick < 3_000; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    expect(session.rides.snapshot(tiki.id)!.ridersToday).toBeGreaterThan(0);
  });
});
