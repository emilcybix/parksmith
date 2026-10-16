import { colourSlotsFor, type ColourSlotId } from '../../../game/content/colours';
import { slotted } from '../contracts/blueprint';

/**
 * Phase 28 step 2: how content tags the shapes of a colour slot. A slot's tag is POSITIONAL (its index in the
 * definition's slot list plus one, `ColourSlotDef.tag`), so a blueprint asks the slot table for it instead of
 * hard-coding a number. A definition without the slot (an unknown id standing in for a colourable blueprint, a
 * test's mutated copy) gets its material back untagged: tagging is an authoring aid and never changes geometry.
 */
export type SlotTagger = (slot: ColourSlotId, material: number) => number;

/** The tagger of one definition (or of the pseudo id `park-entrance`). Build once per blueprint, not per shape. */
export const slotTagger = (definitionId: string): SlotTagger => {
  const slots = colourSlotsFor(definitionId);
  return (slot, material) => {
    const found = slots.find((candidate) => candidate.id === slot);
    return found === undefined ? material : slotted(material, found.tag);
  };
};
