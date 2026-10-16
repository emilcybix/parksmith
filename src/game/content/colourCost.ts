/**
 * Phase 28 step 2: what a recolour costs. Data and plumbing only: Phase 22 (profile unlocks) and Phase 25
 * (cards) have not decided what colour should cost, so every default is 0 and the Sandbox is free by rule.
 * The levers that let them act later are the per-mode config (GAME_CONFIG.colours.recolourCostPerObject)
 * and the park rule `recolourCostMultiplier` (a card or a scenario may scale it; lower is better).
 *
 * Pure. A colour is never part of an objective and no simulation reads it, so this module is only imported
 * by the app (which posts the transaction) and by tests.
 */
import { GAME_CONFIG } from '../config';

/** Where the park is played: the Sandbox, a stand-alone Scenario, or a Park Tour node (The Map). */
export type ColourCostMode = 'sandbox' | 'scenario' | 'map';

export type ColourCostTable = Readonly<Record<'scenario' | 'map', number>>;

/**
 * The cash a gesture costs: `round(perObject x multiplier) x objectsChanged`, 0 in the Sandbox whatever
 * the config says, and 0 for a non-finite, negative or zero input (a hostile multiplier must never pay
 * the player or charge NaN). `objectsChanged` counts the objects whose record actually changed (the gate
 * counts as one); an object that already had the colours is neither counted nor charged.
 * `perObject` defaults to the shipped config; tests inject their own.
 */
export const recolourCharge = (
  mode: ColourCostMode,
  objectsChanged: number,
  recolourCostMultiplier: number,
  perObject: ColourCostTable = GAME_CONFIG.colours.recolourCostPerObject,
): number => {
  if (mode === 'sandbox') return 0;
  if (!Number.isFinite(objectsChanged) || objectsChanged <= 0) return 0;
  const each = perObject[mode];
  if (!Number.isFinite(each) || each <= 0) return 0;
  const multiplier = Number.isFinite(recolourCostMultiplier) && recolourCostMultiplier > 0 ? recolourCostMultiplier : 1;
  return Math.round(each * multiplier) * Math.floor(objectsChanged);
};
