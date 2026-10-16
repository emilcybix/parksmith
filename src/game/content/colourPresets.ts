/**
 * Phase 28 step 2: named colour presets and the pure rules of the Paint tool. Pure content and
 * functions: no simulation reads any of it, and nothing here is saved (a preset is DERIVED data: applying
 * one writes ordinary per-object colour records; the paint brush is UI state).
 *
 * A preset maps slot ROLES (colours.ts: primary, secondary, trim, rail, support) to swatch indices. A role
 * a definition does not have is ignored; a role the preset leaves null means "the slot default". Applying a
 * preset REPLACES the object's whole record, so Candy (every role null) is "reset to the shipped colours".
 */
import {
  COLOUR_SLOT_IDS,
  COLOUR_SWATCHES,
  SWATCH_COUNT,
  colourSlotsFor,
  isSlotDefaultSwatch,
  sameObjectColours,
  swatchOfRgb,
  type ColourSlotId,
  type ObjectColours,
} from './colours';

export type ColourPresetId = 'candy' | 'seaside' | 'midnight' | 'autumn' | 'meadow' | 'berry';

/** role -> swatch index, or null (the slot default). Absent roles behave as null. */
export type ColourRoleMap = Readonly<Partial<Record<ColourSlotId, number | null>>>;

export interface ColourPreset {
  readonly id: ColourPresetId;
  readonly name: string;
  /** One line of what it reads as (tooltip and accessible description). */
  readonly description: string;
  readonly roles: ColourRoleMap;
}

const preset = (id: ColourPresetId, name: string, description: string, roles: ColourRoleMap): ColourPreset => (
  Object.freeze({ id, name, description, roles: Object.freeze({ ...roles }) })
);

/**
 * The presets, in panel order. Swatch indices are the save-format indices of COLOUR_SWATCHES (append-only),
 * so a preset never changes meaning. Within one preset every set role is a different swatch (a coaster
 * shows all five at once), which is what the readability test relies on.
 */
export const COLOUR_PRESETS: readonly ColourPreset[] = Object.freeze([
  preset('candy', 'Candy', 'The shipped colours of every ride, stall and gate.', {
    primary: null, secondary: null, trim: null, rail: null, support: null,
  }),
  preset('seaside', 'Seaside', 'Blue and white with sea-green trim.', {
    primary: 16, secondary: 6, trim: 17, rail: 14, support: 20,
  }),
  preset('midnight', 'Midnight', 'Deep purple with gold.', {
    primary: 12, secondary: 4, trim: 11, rail: 5, support: 13,
  }),
  preset('autumn', 'Autumn', 'Reds and ambers.', {
    primary: 0, secondary: 3, trim: 2, rail: 1, support: 13,
  }),
  preset('meadow', 'Meadow', 'Spring greens and pinks.', {
    primary: 18, secondary: 8, trim: 5, rail: 6, support: 19,
  }),
  preset('berry', 'Berry', 'Pinks and purples.', {
    primary: 7, secondary: 6, trim: 9, rail: 8, support: 11,
  }),
]);

export const COLOUR_PRESET_BY_ID: ReadonlyMap<ColourPresetId, ColourPreset> = new Map(
  COLOUR_PRESETS.map((entry) => [entry.id, entry]),
);

const isSwatchIndex = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SWATCH_COUNT
);

/**
 * Builds the record a role map gives a definition: one entry per slot of the definition, a swatch equal to
 * the slot's default stored as null (the "default swatch" rule of step 1), an all-default result is null.
 * A role the map does not mention, a null and an invalid swatch all mean the slot default.
 */
const recordFromRoles = (definitionId: string, roles: ColourRoleMap): ObjectColours | null => {
  const slots = colourSlotsFor(definitionId);
  if (slots.length === 0) return null;
  const entries: (number | null)[] = slots.map((slot, index) => {
    const swatch = roles[slot.id];
    if (!isSwatchIndex(swatch) || isSlotDefaultSwatch(definitionId, index, swatch)) return null;
    return swatch;
  });
  return entries.every((entry) => entry === null) ? null : Object.freeze(entries);
};

/**
 * The record a preset gives one definition, REPLACING whatever the object had: null when the result is
 * every-default (Candy, or a preset whose roles all equal the definition's defaults) or when the
 * definition is not colourable (trees, paths and unknown ids). Works for ENTRANCE_COLOUR_ID too.
 */
export const presetRecord = (definitionId: string, presetId: ColourPresetId): ObjectColours | null => {
  const found = COLOUR_PRESET_BY_ID.get(presetId);
  return found ? recordFromRoles(definitionId, found.roles) : null;
};

/** The three swatches a preset chip shows as dots: primary, secondary, then trim or rail (null = default). */
export const presetDots = (presetId: ColourPresetId): readonly (number | null)[] => {
  const roles = COLOUR_PRESET_BY_ID.get(presetId)?.roles ?? {};
  const third = roles.trim ?? roles.rail ?? null;
  return [roles.primary ?? null, roles.secondary ?? null, third];
};

// ---------------------------------------------------------------------------------------------
// The Paint tool's pure model (UI state lives in src/ui/store.ts; nothing here is saved)
// ---------------------------------------------------------------------------------------------

/**
 * What the paint tool holds. `default` resets the slots it targets; `swatch` paints one swatch;
 * `preset` and `copied` (the eyedropper's roles) always paint the whole object.
 */
export type PaintBrush =
  | { readonly kind: 'default' }
  | { readonly kind: 'swatch'; readonly swatch: number }
  | { readonly kind: 'preset'; readonly presetId: ColourPresetId }
  | { readonly kind: 'copied'; readonly sourceName: string; readonly roles: ColourRoleMap };

/** Which slots a `default` or `swatch` brush touches: the main slot, the accent slot, or every slot. */
export type PaintTarget = 'primary' | 'secondary' | 'all';

/**
 * The target of one gesture: Shift at pointer down widens a swatch/default brush to every slot. A preset or
 * copied brush is already whole-object, so Shift adds nothing for them (the result is the same either way).
 */
export const paintTargetFor = (target: PaintTarget, shift: boolean): PaintTarget => (shift ? 'all' : target);

/**
 * One paint click on one object: the NEW record (null = every slot default), or 'skip' when the definition
 * is not colourable or lacks the targeted slot (Accent on the fountain). A result equal to `current` is
 * returned as an equal record, never 'skip': the caller compares with sameObjectColours to leave an object
 * that already looks right alone (not counted, not charged, no undo entry).
 */
export const paintRecord = (
  definitionId: string,
  current: ObjectColours | null,
  brush: PaintBrush,
  target: PaintTarget,
): ObjectColours | null | 'skip' => {
  const slots = colourSlotsFor(definitionId);
  if (slots.length === 0) return 'skip';
  if (brush.kind === 'preset') return presetRecord(definitionId, brush.presetId);
  if (brush.kind === 'copied') return recordFromRoles(definitionId, brush.roles);
  const targeted = target === 'all' ? slots.map((_, index) => index) : slots.flatMap((slot, index) => (slot.id === target ? [index] : []));
  if (targeted.length === 0) return 'skip';
  const entries: (number | null)[] = slots.map((_, index) => current?.[index] ?? null);
  for (const index of targeted) {
    if (brush.kind === 'default' || !isSwatchIndex(brush.swatch) || isSlotDefaultSwatch(definitionId, index, brush.swatch)) entries[index] = null;
    else entries[index] = brush.swatch;
  }
  return entries.every((entry) => entry === null) ? null : Object.freeze(entries);
};

/**
 * Colour before placing: the record the NEXT building gets. A swatch brush colours the primary slot only
 * (the same rule as a plain click), a preset or copied brush its roles, `default` nothing. Null for a
 * definition that is not colourable.
 */
export const placementRecord = (definitionId: string, brush: PaintBrush): ObjectColours | null => {
  const result = paintRecord(definitionId, null, brush, 'primary');
  return result === 'skip' ? null : result;
};

/**
 * The eyedropper: the swatch each ROLE of an object currently shows. A slot on its default colour copies as
 * that swatch when the default is exactly a swatch (so the copy looks the same elsewhere), and as null (the
 * target's own default) when it is not. Roles the definition lacks are absent.
 */
export const rolesOfRecord = (definitionId: string, colours: ObjectColours | null): ColourRoleMap => {
  const roles: Partial<Record<ColourSlotId, number | null>> = {};
  colourSlotsFor(definitionId).forEach((slot, index) => {
    const chosen = colours?.[index] ?? null;
    roles[slot.id] = chosen ?? swatchOfRgb(slot.defaultRgb)?.index ?? null;
  });
  return roles;
};

/**
 * The brush's single swatch colour for the hover tint and the dock chip (classicRgb, the colour both
 * renderers draw), null for default, preset and copied brushes (they have no single colour).
 */
export const brushPrimaryRgb = (brush: PaintBrush): number | null => (
  brush.kind === 'swatch' && isSwatchIndex(brush.swatch) ? COLOUR_SWATCHES[brush.swatch].classicRgb : null
);

/** Value equality of two brushes (UI state diffing). */
export const sameBrush = (a: PaintBrush, b: PaintBrush): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'swatch') return a.swatch === (b as typeof a).swatch;
  if (a.kind === 'preset') return a.presetId === (b as typeof a).presetId;
  if (a.kind === 'copied') {
    const other = b as typeof a;
    return a.sourceName === other.sourceName && COLOUR_SLOT_IDS.every((id) => (a.roles[id] ?? null) === (other.roles[id] ?? null));
  }
  return true;
};

/** Whether painting `brush` onto an object currently coloured `current` would change nothing. */
export const paintIsNoOp = (
  definitionId: string,
  current: ObjectColours | null,
  brush: PaintBrush,
  target: PaintTarget,
): boolean => {
  const next = paintRecord(definitionId, current, brush, target);
  return next === 'skip' || sameObjectColours(current, next);
};
