import { colourSlotsFor, isSlotDefaultSwatch, SWATCH_COUNT, type ObjectColours } from '../game/content/colours';

/**
 * Phase 28 step 1: the pure part of an inspector colour edit. The UI sends "slot N gets swatch S"
 * (or null for that slot's default); the record the world wants is the whole array, so this builds
 * it from the current one. Kept out of GameApp so the rules are a unit test: it never produces an
 * array the world's strict validator would refuse, and it refuses what the validator would.
 */

/**
 * The record after setting one slot, or null when the request cannot be honoured: the definition has
 * no slots, the slot index is not one of them, or the swatch is not null or a catalog swatch index.
 * The current record is padded with defaults when it is shorter than the slot list (a record from an
 * older slot list), so an edit never trips over a legacy length. Picking the swatch that IS the slot's
 * default colour (the one the Default chip names) stores null: it is the default, in both renderers,
 * so it leaves the ride at "Default colours" and a pick of it on a default slot changes nothing.
 */
export const withSlotColour = (
  definitionId: string,
  current: ObjectColours | null,
  slot: number,
  swatch: number | null,
): (number | null)[] | null => {
  const slots = colourSlotsFor(definitionId);
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots.length) return null;
  if (swatch !== null && !(Number.isInteger(swatch) && swatch >= 0 && swatch < SWATCH_COUNT)) return null;
  const stored = swatch !== null && isSlotDefaultSwatch(definitionId, slot, swatch) ? null : swatch;
  return slots.map((_slot, index) => (index === slot ? stored : (current?.[index] ?? null)));
};
