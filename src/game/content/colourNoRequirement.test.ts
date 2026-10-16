import { describe, expect, it } from 'vitest';
import { PULSE_CARDS } from '../cards/content';
import { RESEARCH_MILESTONES, RESEARCH_PROJECTS } from '../progression/content';
import { SCENARIOS } from '../scenarios/content';
import { CARD_MODIFIABLE_RULES } from '../scenarios/rules';
import { TOUR_NODES } from '../tour/content';

/**
 * Phase 28 step 2 policy: a colour is cosmetic and never required. No scenario objective, card, research
 * project, milestone or tour node may mention colours, swatches or the recolour cost rule, and no game
 * system outside the world, the colour content and the save layer may import or read them. The one
 * deliberate exception is the rule list itself (`recolourCostMultiplier` is a card-modifiable rule, so Phase 25
 * can price colours; no card does today).
 */
const TERMS = /colou?r|swatch|recolou?r|paint|preset|palette/i;

describe('no objective, card, project or tour node references colours', () => {
  const texts = (value: unknown): string => JSON.stringify(value);

  it('scenarios (objectives, rules, text)', () => {
    expect(SCENARIOS.length).toBeGreaterThan(2);
    for (const scenario of SCENARIOS) {
      // `color` can legitimately appear nowhere in a scenario: it is purely objective data and prose.
      expect(texts(scenario), scenario.id).not.toMatch(TERMS);
    }
  });

  it('Pulse Cards modify no colour rule, and the multiplier is on no card', () => {
    expect(PULSE_CARDS.length).toBeGreaterThan(5);
    for (const card of PULSE_CARDS) {
      expect(texts(card), card.id).not.toMatch(TERMS);
      expect(Object.keys(card.modifiers ?? {}), card.id).not.toContain('recolourCostMultiplier');
    }
  });

  it('research projects, milestones and tour nodes', () => {
    for (const project of RESEARCH_PROJECTS) expect(texts(project), project.id).not.toMatch(TERMS);
    for (const milestone of RESEARCH_MILESTONES) expect(texts(milestone), milestone.id).not.toMatch(TERMS);
    for (const node of TOUR_NODES) expect(texts(node), node.id).not.toMatch(TERMS);
  });

  it('no scenario overrides the recolour multiplier (it is plumbing for Phase 22 and 25)', () => {
    for (const scenario of SCENARIOS) expect(Object.keys(scenario.rules ?? {}), scenario.id).not.toContain('recolourCostMultiplier');
    expect(CARD_MODIFIABLE_RULES.filter((rule) => TERMS.test(rule))).toEqual(['recolourCostMultiplier']);
  });
});

describe('static guard: the colour content is imported only by the world, the save layer, the colour content and test support', () => {
  const raw = import.meta.glob<string>(['../**/*.ts', '!../**/*.test.ts'], { query: '?raw', import: 'default', eager: true });
  /** Vite keys files of this directory as './x.ts'; normalise them to '../content/x.ts' like their siblings. */
  const sources: Record<string, string> = Object.fromEntries(Object.entries(raw).map(([path, text]) => [path.startsWith('./') ? `../content/${path.slice(2)}` : path, text]));
  const IMPORTERS = [
    '../World.ts', '../types.ts', '../content/colourCost.ts', '../content/colourPresets.ts', '../content/colours.ts',
    '../session/colourTestPark.ts',
  ];

  it('nothing in the simulation, scenarios, cards, progression or tour imports colours, presets or the cost module', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders = Object.entries(sources)
      .filter(([path, text]) => /from '(?:\.\.?\/)+(?:content\/)?colour(?:s|Presets|Cost)'/.test(text) && !IMPORTERS.includes(path) && !path.startsWith('../save/'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('the cost module reads only config; the presets and slots import only each other', () => {
    expect(sources['../content/colourCost.ts']).toMatch(/from '\.\.\/config'/);
    expect(sources['../content/colourCost.ts']).not.toMatch(/from '\.\.\/(?:World|session|guests)/);
    const presetImports = [...sources['../content/colourPresets.ts'].matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(presetImports).toEqual(['./colours']);
  });

  it('no game system but the world and the app-facing rule list mentions the recolour cost rule', () => {
    const mentions = Object.entries(sources).filter(([, text]) => /recolourCostMultiplier/.test(text)).map(([path]) => path).sort();
    expect(mentions).toEqual(['../cards/ruleCopy.ts', '../config.ts', '../content/colourCost.ts', '../scenarios/rules.ts', '../save/state.ts', '../save/migrate.ts', '../session/ParkSession.ts'].sort());
  });
});
