import { slotCostTotal } from '../cards/content';
import { PHASE14_RULE_KEYS, PHASE16_RULE_KEYS, PHASE40_RULE_KEYS, compileParkRules, preBonusStartingCash, type ParkRuleset } from '../scenarios/rules';
import type { ParkSession } from '../session/ParkSession';
import { compileBonusLayer } from './bonuses';

/**
 * Keys left out of the comparison on both sides. The Phase 16 base-layer keys (`themeAffinity`, `researchCostScale`)
 * come from GAME_CONFIG at the time a park was created, not from its scenario, cards, biome or grant: a park saved
 * before the switch-on (content version 2, no keys) must not lose reward eligibility because today's config compiles
 * them. Restore already refuses out-of-range values, so what remains is a balance-era choice, not a reward exploit.
 * The Phase 14 key (`crowdFeedback`) is ignored for the same reason: a Scenario or run park saved before Phase 14
 * (content version 3, no key) stays reward-eligible although today's config compiles feedback for a new park.
 */
const IGNORED_KEYS: ReadonlySet<string> = new Set<string>([...PHASE16_RULE_KEYS, ...PHASE14_RULE_KEYS, ...PHASE40_RULE_KEYS]);

/** A ruleset as canonical text (sorted keys; an absent optional key is simply absent; IGNORED_KEYS dropped). */
const canonical = (rules: ParkRuleset): string => JSON.stringify(
  Object.fromEntries(
    Object.entries(rules)
      .filter(([key, value]) => value !== undefined && !IGNORED_KEYS.has(key))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ),
);

/**
 * "Never trust a save for profile rewards": recompiles the ruleset a park started in this game would have (the
 * scenario's rules, its active cards, the map's biome and the bonus layer of the park's own grant) and compares it with
 * the ruleset the session actually plays under. A mismatch means a hand-edited save; the result is shown, but no reward
 * is granted. Sandbox parks have no result, so they are never eligible. A result the session did not reach live (it was
 * restored from a save whose scenario had already ended, see ParkSession.resultFromSave) is never eligible either: a
 * hand-edited `scenario.status` must not pay out (Phase 23 review; a run settles such a stage on load, Scenario mode never
 * records it at all).
 */
export const rewardEligible = (session: ParkSession): boolean => {
  const definition = session.scenarioDefinition;
  if (definition === null || session.mode === 'sandbox' || session.resultFromSave) return false;
  const layer = compileBonusLayer(session.grant.bonusIds, session.mode, preBonusStartingCash(definition.rules));
  if (slotCostTotal(session.activeCards.map((card) => card.id)) > definition.cardSlots + layer.extraCardSlots) return false;
  const expected = compileParkRules(
    definition.rules,
    session.activeCards.map((card) => card.modifiers),
    session.map.biome.rules,
    layer,
  );
  return canonical(expected) === canonical(session.rules);
};
