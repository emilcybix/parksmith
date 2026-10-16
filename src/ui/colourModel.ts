import {
  COLOUR_SWATCHES,
  SWATCH_ROWS,
  colourSlotsFor,
  type ObjectColours,
} from '../game/content/colours';
import { contrastRatio } from './a11yModel';

/**
 * Phase 28: the pure model behind the inspector's Colours section (rides, coasters, stalls and facilities). No React, no store, no
 * game types beyond the swatch and slot data: given a ride definition and its colour record it says
 * what to draw (one row per slot, the swatches in their themed rows, which one is chosen, the
 * accessible name of everything) so the component is a thin map over it and every rule is a test.
 *
 * What it does NOT do: build the record to store. The UI sends "slot, swatch" through the bridge and
 * `app/colourEdit.ts` composes the array the world validates.
 */

/** The swatch grid is `SWATCH_COLUMNS` wide: one themed row of the data per grid row. */
export const SWATCH_COLUMNS = Math.max(...SWATCH_ROWS.map((row) => row.swatches.length));

const INK = '#1d2b27';
const WHITE = '#ffffff';

export const hexOf = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`;

export interface SwatchChoice {
  readonly index: number;
  readonly name: string;
  readonly hex: string;
  /** Chosen explicitly for this slot (aria-pressed). The default is shown by the Default chip. */
  readonly selected: boolean;
  /** The check mark's colour: whichever of white and ink contrasts more with the swatch (selection is never colour alone). */
  readonly checkTone: 'light' | 'dark';
  /** The themed row ("Sunny"), for the tooltip. */
  readonly rowLabel: string;
  /** Accessible name: the colour, nothing else (the group names the slot, aria-pressed the state). */
  readonly label: string;
}

export interface SlotRowModel {
  readonly slotIndex: number;
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Accessible name of the swatch group: "Main colour". */
  readonly groupLabel: string;
  /** What the slot is now: "Cherry" or "Default (Rose)". */
  readonly currentName: string;
  readonly currentHex: string;
  readonly isDefault: boolean;
  readonly defaultHex: string;
  /** The name of the slot's default colour (a swatch's name only when that swatch is exactly it). */
  readonly defaultName: string;
  readonly defaultChipLabel: string;
  readonly swatches: readonly SwatchChoice[];
  /** The swatch that is the roving tab stop when nothing was focused yet: the chosen one, else the first. */
  readonly initialStop: number;
}

export interface ColourDot {
  readonly id: string;
  readonly label: string;
  readonly hex: string;
  readonly name: string;
}

export interface ColourSectionModel {
  readonly rows: readonly SlotRowModel[];
  /** At least one slot is not at its default. */
  readonly customised: boolean;
  /** One dot per slot for the collapsed header. */
  readonly dots: readonly ColourDot[];
  /** "Custom colours" or "Default colours". */
  readonly title: string;
  /** The sentence a screen reader gets after a change: "Colours: Main Cherry; Accent default, Sunflower." */
  readonly summary: string;
  /** What the header button adds to its visible text for a screen reader: the colours, slot by slot. */
  readonly toggleSummary: string;
  readonly resetLabel: string;
}

const checkToneFor = (hex: string): 'light' | 'dark' => (contrastRatio(hex, WHITE) >= contrastRatio(hex, INK) ? 'light' : 'dark');

const SWATCH_ROW_LABEL = new Map(SWATCH_ROWS.flatMap((row) => row.swatches.map((index) => [index, row.label] as const)));

/** The 21 swatches as picker buttons, `chosen` marked (null: none). Shared by the inspector and the Paint panel. */
export const swatchChoices = (chosen: number | null): SwatchChoice[] => COLOUR_SWATCHES.map((swatch): SwatchChoice => {
  const hex = hexOf(swatch.rgb);
  return {
    index: swatch.index,
    name: swatch.name,
    hex,
    selected: swatch.index === chosen,
    checkTone: checkToneFor(hex),
    rowLabel: SWATCH_ROW_LABEL.get(swatch.index) ?? '',
    label: swatch.name,
  };
});

/**
 * The section for one placed object (a ride, a coaster or a stall): null when the definition has no slots (a custom coaster, anything
 * not colourable), so the component renders nothing for it. A record shorter or longer than the slot
 * list, or with an entry that is not a swatch, reads as defaults for those slots (what restore does).
 */
export const colourSection = (definitionId: string, colours: ObjectColours | null | undefined): ColourSectionModel | null => {
  const slots = colourSlotsFor(definitionId);
  if (slots.length === 0) return null;
  const rows: SlotRowModel[] = slots.map((slot, slotIndex) => {
    const entry = colours?.[slotIndex];
    const chosen = typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry < COLOUR_SWATCHES.length ? entry : null;
    const defaultHex = hexOf(slot.defaultRgb);
    const defaultName = slot.defaultName;
    const swatches = swatchChoices(chosen);
    return {
      slotIndex,
      id: slot.id,
      label: slot.label,
      description: slot.description,
      groupLabel: `${slot.label} colour`,
      currentName: chosen === null ? `Default (${defaultName})` : COLOUR_SWATCHES[chosen].name,
      currentHex: chosen === null ? defaultHex : hexOf(COLOUR_SWATCHES[chosen].rgb),
      isDefault: chosen === null,
      defaultHex,
      defaultName,
      defaultChipLabel: `${slot.label}: default, ${defaultName}`,
      swatches,
      initialStop: chosen ?? 0,
    };
  });
  const customised = rows.some((row) => !row.isDefault);
  const current = rows.map((row) => `${row.label} ${row.currentName}`).join(', ');
  const title = customised ? 'Custom colours' : 'Default colours';
  return {
    rows,
    customised,
    dots: rows.map((row) => ({ id: row.id, label: row.label, hex: row.currentHex, name: row.currentName })),
    title,
    summary: `Colours: ${rows.map((row) => `${row.label} ${row.isDefault ? `default, ${row.defaultName}` : row.currentName}`).join('; ')}.`,
    toggleSummary: current,
    resetLabel: customised ? 'Reset to default colours' : 'Colours are at their defaults',
  };
};
