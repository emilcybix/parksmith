import { describe, expect, it } from 'vitest';
import type { BuildDefinition } from '../types';
import { BUILD_CATALOG } from './catalog';

/**
 * Phase 16 (design 3.3): no catalog entry is dominated by another of its kind. `a` dominates `b` when a >= b on every
 * axis and a > b on at least one. Paths and coasters (custom entries) are not compared; services only within the same
 * need and the same `serves` (warm and cold draw different weather); rides only within 15 intensity (outside that they
 * serve different guests). Scenery is always compared: a theme does not exempt a piece. Toilets carry no theme.
 */

type Axes = readonly number[];

const area = (definition: BuildDefinition): number => definition.footprint[0] * definition.footprint[1];

const rideAxes = (definition: BuildDefinition): Axes => {
  const stats = definition.stats ?? {};
  const capacity = stats.capacity ?? 0;
  return [
    capacity,
    capacity / (stats.duration ?? 1),
    stats.excitement ?? 0,
    stats.reliability ?? 0,
    -(stats.runningCost ?? 0),
    -definition.buildCost,
    -area(definition),
  ];
};

const serviceAxes = (definition: BuildDefinition): Axes => {
  const stats = definition.stats ?? {};
  return [stats.needRelief ?? 0, -(stats.serviceDuration ?? 0), stats.itemPrice ?? 0, -definition.buildCost, -area(definition)];
};

const sceneryAxes = (definition: BuildDefinition): Axes => {
  const stats = definition.stats ?? {};
  return [stats.sceneryAppeal ?? 0, stats.sceneryRadius ?? 0, -definition.buildCost, -area(definition)];
};

/**
 * The one dominated pair that predates Phase 16 (the scenery family was never compared before): Sunburst Flowers
 * (10 appeal, radius 3, $28) beats Lollipop Lamp (8, 3, $35) on numbers; the lamp's difference is its light after dusk,
 * which no axis measures. Neither can change: appeal and radius are in every saved scenery signature (a change refuses
 * the load) and the build cost is read live (inspection, refunds). Recorded for the owner (Phase 16 W1-A report); any
 * other dominated pair fails.
 */
const LEGACY_DOMINATED_PAIRS = ['sunburst-flowers dominates lollipop-lamp'] as const;

const dominates = (a: Axes, b: Axes): boolean => a.every((value, index) => value >= b[index]) && a.some((value, index) => value > b[index]);

const compared = BUILD_CATALOG.filter((definition) => definition.kind !== 'path' && definition.custom === undefined);
const rides = compared.filter((definition) => definition.kind === 'ride');
const services = compared.filter((definition) => definition.stats?.serviceType !== undefined);
const scenery = compared.filter((definition) => definition.kind === 'scenery');

interface Family {
  name: string;
  members: readonly BuildDefinition[];
  axes: (definition: BuildDefinition) => Axes;
  comparable: (a: BuildDefinition, b: BuildDefinition) => boolean;
}

const FAMILIES: readonly Family[] = [
  {
    name: 'rides',
    members: rides,
    axes: rideAxes,
    comparable: (a, b) => Math.abs((a.stats?.intensity ?? 0) - (b.stats?.intensity ?? 0)) <= 15,
  },
  {
    name: 'services',
    members: services,
    axes: serviceAxes,
    // Phase 29: souvenir stalls are only compared with stalls selling the same keepsake.
    comparable: (a, b) => a.stats?.serviceType === b.stats?.serviceType && a.serves === b.serves && a.stats?.souvenir === b.stats?.souvenir,
  },
  { name: 'scenery', members: scenery, axes: sceneryAxes, comparable: () => true },
];

const dominatedPairs = (family: Family): string[] => {
  const pairs: string[] = [];
  for (const a of family.members) {
    for (const b of family.members) {
      if (a === b || !family.comparable(a, b)) continue;
      if (dominates(family.axes(a), family.axes(b))) pairs.push(`${a.id} dominates ${b.id}`);
    }
  }
  return pairs;
};

describe('Phase 16: no dominated catalog entry', () => {
  it('the compared families are the whole buildable catalog except paths, coasters and comforts', () => {
    expect(rides.length).toBe(14);
    expect(services.length).toBe(18);
    expect(scenery.length).toBe(12);
  });

  it.each(FAMILIES.map((family) => [family.name, family] as const))('%s: no entry dominates another of its kind', (name, family) => {
    expect(dominatedPairs(family)).toEqual(name === 'scenery' ? [...LEGACY_DOMINATED_PAIRS] : []);
  });

  it('no Phase 16 entry takes part in a dominated pair, and the legacy pair is the only one', () => {
    const appended = new Set(BUILD_CATALOG.slice(BUILD_CATALOG.findIndex((definition) => definition.id === 'puddle-jumpers')).map((definition) => definition.id));
    // Phase 16's 12, Phase 29's 6 and Phase 39's 4 coasters (coasters are not compared).
    expect(appended.size).toBe(22);
    for (const pair of FAMILIES.flatMap(dominatedPairs)) {
      const [winner, , loser] = pair.split(' ');
      expect(appended.has(winner) || appended.has(loser), pair).toBe(false);
      expect(LEGACY_DOMINATED_PAIRS, pair).toContain(pair);
    }
  });

  it('the rule bites: a strictly cheaper twin would be flagged', () => {
    const carousel = rides.find((definition) => definition.id === 'moonpetal-carousel')!;
    const cheaper: BuildDefinition = { ...carousel, id: 'cheaper-carousel', buildCost: carousel.buildCost - 1 };
    const family: Family = { ...FAMILIES[0], members: [carousel, cheaper] };
    expect(dominatedPairs(family)).toEqual(['cheaper-carousel dominates moonpetal-carousel']);
  });

  it('no two compared entries of a kind share an identical vector', () => {
    for (const family of FAMILIES) {
      const seen = new Map<string, string>();
      for (const definition of family.members) {
        const key = JSON.stringify([family.name === 'services' ? [definition.stats?.serviceType, definition.serves] : [], family.axes(definition)]);
        expect(seen.get(key), `${definition.id} repeats ${seen.get(key)}`).toBeUndefined();
        seen.set(key, definition.id);
      }
    }
  });

  it('every ride, stall and scenery piece except toilets has a theme; coasters, toilets, comforts and paths have none', () => {
    for (const definition of BUILD_CATALOG) {
      const themed = definition.custom === undefined
        && (definition.kind === 'ride' || definition.kind === 'shop' || definition.kind === 'scenery');
      expect(definition.theme !== undefined, definition.id).toBe(themed);
    }
  });
});
