import { colourSlotsFor, COLOUR_SWATCHES, isSlotDefaultSwatch, type ColourSlotId, type ObjectColours } from '../game/content/colours';

/**
 * The classic renderer's colour paint (Phase 28): how an art builder asks for a slot colour. Pure (no Pixi),
 * so the coaster palette and the train style, which are plain data, can use it. rideArt.ts re-exports it.
 */

/**
 * Phase 28: how a builder asks for a colour. `slot` is the colour slot the part belongs to, `fallback`
 * the colour the part has always had; an object with no record answers every call with its fallback,
 * so a default ride draws exactly the art it drew before colours existed. Parts that are not in a
 * slot (steel, timber, glass, ground plates, lights, riders) never call it.
 */
export interface RidePaint {
  (slot: ColourSlotId, fallback: number): number;
  /**
   * A fixed shading literal of a slot-coloured surface (a drum's dark underside, a carousel's mauve
   * drum): the literal itself while its slot is at default, otherwise the same shading of the new
   * colour (`linkedTone`). `slotDefault` is the colour the literal was drawn to go with.
   */
  tone(slot: ColourSlotId, literal: number, slotDefault: number): number;
  /** Whether the slot is recoloured (a swatch that is not its default colour): the art then follows the slot. */
  isSet(slot: ColourSlotId): boolean;
}

const makePaint = (
  colour: (slot: ColourSlotId, fallback: number) => number,
  tone: RidePaint['tone'],
  isSet: RidePaint['isSet'],
): RidePaint => Object.assign(colour, { tone, isSet });

/** The answer of an uncoloured object: every part keeps its own colour. */
export const DEFAULT_RIDE_PAINT: RidePaint = makePaint((_slot, fallback) => fallback, (_slot, literal) => literal, () => false);

const channelsOf = (rgb: number): [number, number, number] => [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
const packRgb = (r: number, g: number, b: number): number => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
const lumaOf = (rgb: number): number => {
  const [r, g, b] = channelsOf(rgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * The classic art draws some surfaces in a tone of their slot colour (a darker underside, a lighter
 * band). After a recolour they must keep that relation to the NEW colour or the ride reads broken (a
 * blue drum with a dark-red rim). `slotNow === slotDefault` returns the literal EXACTLY, so a default
 * ride is untouched. A literal darker than the slot default scales the new colour by the same luma
 * ratio; a lighter one mixes the new colour toward white by the share of the way the literal went.
 */
export const linkedTone = (literal: number, slotDefault: number, slotNow: number): number => {
  if (slotNow === slotDefault) return literal;
  const [lr, lg, lb] = channelsOf(literal);
  const [dr, dg, db] = channelsOf(slotDefault);
  const [nr, ng, nb] = channelsOf(slotNow);
  const literalLuma = lumaOf(literal);
  const defaultLuma = lumaOf(slotDefault);
  if (literalLuma < defaultLuma) {
    const scale = literalLuma / defaultLuma;
    return packRgb(nr * scale, ng * scale, nb * scale);
  }
  const share = (lit: number, base: number): number => (base >= 255 ? 0 : (lit - base) / (255 - base));
  const t = Math.min(1, Math.max(0, (share(lr, dr) + share(lg, dg) + share(lb, db)) / 3));
  return packRgb(nr + (255 - nr) * t, ng + (255 - ng) * t, nb + (255 - nb) * t);
};

/**
 * The paint of one placed ride: the slot colours its record names (through the swatch's classic
 * colour), the fallback for every slot left at default or set to the swatch that is its default
 * colour (isSlotDefaultSwatch). A record that does not fit the definition
 * (wrong length, unknown index) is read leniently the way restore reads it: such a slot is default.
 */
export const ridePaintFor = (definitionId: string, colours: ObjectColours | null | undefined): RidePaint => {
  if (!colours) return DEFAULT_RIDE_PAINT;
  const slots = colourSlotsFor(definitionId);
  const chosen = new Map<ColourSlotId, number>();
  for (const [index, slot] of slots.entries()) {
    const swatch = colours[index];
    // The swatch that is exactly the slot's default colour draws the default art: some classic parts of a
    // slot were drawn in their own literal long before slots existed (the carousel's cream manes, finial
    // and pennant, the aurora's fff3d0 cabins), and picking "the default" must not repaint them.
    if (typeof swatch === 'number' && !isSlotDefaultSwatch(definitionId, index, swatch)
      && Number.isInteger(swatch) && swatch >= 0 && swatch < COLOUR_SWATCHES.length) {
      chosen.set(slot.id, COLOUR_SWATCHES[swatch].classicRgb);
    }
  }
  if (chosen.size === 0) return DEFAULT_RIDE_PAINT;
  return makePaint(
    (slot, fallback) => chosen.get(slot) ?? fallback,
    (slot, literal, slotDefault) => {
      const now = chosen.get(slot);
      return now === undefined ? literal : linkedTone(literal, slotDefault, now);
    },
    (slot) => chosen.has(slot),
  );
};
