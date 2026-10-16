import { COLOUR_SWATCHES, isColourable } from '../game/content/colours';
import { COLOUR_PRESETS, placementRecord, presetDots, type ColourPresetId, type PaintBrush, type PaintTarget } from '../game/content/colourPresets';
import { brushName, targetLabel } from '../app/paintGesture';
import { ariaKeyShortcutsFor, keyLabelFor, type KeybindingOverrides } from '../settings/keybindings';
import { hexOf, swatchChoices, type SwatchChoice } from './colourModel';

/**
 * Phase 28 step 2: the pure model behind the Paint panel. No React, no store: given the brush, the target, the
 * pick mode and where the panel is shown, it says what to draw (the Default chip, the 21 swatches in their themed
 * rows, the Main / Accent / All choice, the six presets, "Apply to whole park", the Pick toggle) and the accessible
 * name of everything, so the component is a thin map and every rule is a test. The rules of what a click does
 * live in `app/paintGesture.ts`; this file only presents them.
 *
 * Two places show it. With the Paint tool armed (`mode: 'paint'`) it has everything. With a colourable build
 * card armed (`mode: 'place'`, opened by the "Colour" button) only the brush parts show: they choose the colour of
 * the NEXT building, so a target, "Apply to whole park" and Pick (which act on things already built) would only
 * confuse.
 */

export type PaintPanelMode = 'paint' | 'place';

export interface PaintPanelInput {
  readonly brush: PaintBrush;
  readonly target: PaintTarget;
  readonly picking: boolean;
  readonly mode: PaintPanelMode;
  /** The armed card's name, for the place mode's heading ("Next Picnic Pocket"). */
  readonly armedName?: string | null;
  readonly keys?: KeybindingOverrides;
}

export interface TargetChoice {
  readonly id: PaintTarget;
  readonly label: string;
  readonly description: string;
  readonly selected: boolean;
}

export interface PresetChoice {
  readonly id: ColourPresetId;
  readonly name: string;
  readonly description: string;
  /** Three dots: the hex of the preset's primary, secondary and third colours, or null for "the shipped colour". */
  readonly dots: readonly (string | null)[];
  readonly selected: boolean;
  /** "Seaside: Blue and white with sea-green trim." for the tooltip; the button's name is just "Seaside". */
  readonly title: string;
}

export interface PaintPanelModel {
  readonly mode: PaintPanelMode;
  readonly title: string;
  /** The polite status line: "Brush: Teal on Main", "Brush: Seaside colours". */
  readonly status: string;
  readonly defaultChip: { readonly selected: boolean; readonly label: string; readonly title: string };
  readonly swatches: readonly SwatchChoice[];
  /** The roving tab stop of the swatch grid before the player moves focus: the chosen swatch, else the first. */
  readonly initialStop: number;
  /** Null in place mode. */
  readonly targets: readonly TargetChoice[] | null;
  /** A preset or copied brush always paints every part: the choice is shown but inert (aria-disabled). */
  readonly targetsInert: boolean;
  readonly presets: readonly PresetChoice[];
  /** Null in place mode. Enabled only with a preset brush. */
  readonly applyToPark: { readonly label: string; readonly enabled: boolean; readonly title: string } | null;
  /** Null in place mode. */
  readonly pick: { readonly pressed: boolean; readonly label: string; readonly keyLabel: string | null; readonly keyShortcuts: string | undefined } | null;
  /** The copied brush, shown as a line of its own ("Colours of Picnic Pocket") so it reads as a brush the grid does not hold. */
  readonly copied: string | null;
  readonly hint: string;
}

const TARGETS: readonly { id: PaintTarget; description: string }[] = [
  { id: 'primary', description: 'Paint the main part: a ride\'s body, a stall\'s walls, a coaster\'s train' },
  { id: 'secondary', description: 'Paint the accent part: a stall\'s roof, a ride\'s second colour, a coaster\'s seats' },
  { id: 'all', description: 'Paint every colourable part with the swatch' },
];

const chosenSwatch = (brush: PaintBrush): number | null => (
  brush.kind === 'swatch' && brush.swatch >= 0 && brush.swatch < COLOUR_SWATCHES.length ? brush.swatch : null
);

/** "Brush: Teal on Main", "Brush: Default colours on Main", "Brush: Seaside colours", "Brush: Colours of Picnic Pocket". */
export const brushStatus = (brush: PaintBrush, target: PaintTarget): string => {
  switch (brush.kind) {
    case 'default': return `Brush: Default colours on ${targetLabel(target)}`;
    case 'swatch': return `Brush: ${brushName(brush)} on ${targetLabel(target)}`;
    case 'preset': return `Brush: ${brushName(brush)} colours`;
    case 'copied': return `Brush: ${brushName(brush)}`;
  }
};

/** Place mode: what the NEXT building gets. The target does not apply (a swatch colours the main part, a preset or a copy its roles). */
export const nextStatus = (brush: PaintBrush): string => {
  switch (brush.kind) {
    case 'default': return 'Next one: shipped colours';
    case 'swatch': return `Next one: ${brushName(brush)}`;
    case 'preset': return `Next one: ${brushName(brush)} colours`;
    case 'copied': return `Next one: ${brushName(brush)}`;
  }
};

export const paintPanel = (input: PaintPanelInput): PaintPanelModel => {
  const { brush, target, picking, mode } = input;
  const place = mode === 'place';
  const chosen = chosenSwatch(brush);
  const presets = COLOUR_PRESETS.map((preset): PresetChoice => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    dots: presetDots(preset.id).map((swatch) => (swatch === null ? null : hexOf(COLOUR_SWATCHES[swatch].rgb))),
    selected: brush.kind === 'preset' && brush.presetId === preset.id,
    title: `${preset.name}: ${preset.description}`,
  }));
  const wholeObject = brush.kind === 'preset' || brush.kind === 'copied';
  const presetName = brush.kind === 'preset' ? brushName(brush) : null;
  const keys = input.keys ?? {};
  const keyLabel = keyLabelFor('eyedropper', keys);
  return {
    mode,
    title: place ? (input.armedName ?? 'Building') : 'Paint',
    status: place ? nextStatus(brush) : brushStatus(brush, target),
    defaultChip: {
      selected: brush.kind === 'default',
      label: 'Default',
      title: place ? 'Place it in its shipped colours' : 'Paint the shipped colours back',
    },
    swatches: swatchChoices(chosen),
    initialStop: chosen ?? 0,
    targets: place ? null : TARGETS.map((entry) => ({
      id: entry.id,
      label: targetLabel(entry.id) === 'Every part' ? 'All' : targetLabel(entry.id),
      description: entry.description,
      selected: !wholeObject && entry.id === target,
    })),
    targetsInert: wholeObject,
    presets,
    applyToPark: place ? null : {
      label: presetName === null ? 'Apply to whole park' : `Apply ${presetName} to whole park`,
      enabled: presetName !== null,
      title: presetName === null
        ? 'Choose a preset first: it recolours every ride, coaster, stall, bench, lamp and the gate in one undo step'
        : `${presetName} on every ride, coaster, stall, bench, lamp and the gate: one undo step`,
    },
    pick: place ? null : {
      pressed: picking,
      label: 'Pick colours',
      keyLabel: keyLabel === '—' ? null : keyLabel,
      keyShortcuts: ariaKeyShortcutsFor('eyedropper', keys),
    },
    copied: brush.kind === 'copied' ? brushName(brush) : null,
    hint: place
      ? 'The next one you place gets this colour.'
      : 'Click or drag to paint. Shift paints every part.',
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// The dock's side of the Paint tool and of colour before placing
// ---------------------------------------------------------------------------------------------------------------------

/** The dots of a next-colour chip: one for a swatch, three for a preset or a copied brush (null = the shipped colour), none for the default brush. */
export const brushDots = (brush: PaintBrush): readonly (string | null)[] | null => {
  if (brush.kind === 'swatch') return [hexOf(COLOUR_SWATCHES[brush.swatch]?.rgb ?? 0xffffff)];
  if (brush.kind === 'preset') return presetDots(brush.presetId).map((swatch) => (swatch === null ? null : hexOf(COLOUR_SWATCHES[swatch].rgb)));
  if (brush.kind === 'copied') {
    return (['primary', 'secondary', 'trim'] as const).map((role) => {
      const swatch = brush.roles[role];
      return typeof swatch === 'number' && swatch >= 0 && swatch < COLOUR_SWATCHES.length ? hexOf(COLOUR_SWATCHES[swatch].rgb) : null;
    });
  }
  return null;
};

export interface DockPaintInput {
  readonly tool: 'pointer' | 'build' | 'bulldoze' | 'paint' | 'land';
  readonly selectedDefinitionId: string | null;
  readonly brush: PaintBrush;
  readonly picking: boolean;
  readonly panelOpen: boolean;
  /** An inspector is open: it owns the panel slot, so the Colour button hides. */
  readonly inspectorOpen: boolean;
}

export interface DockPaintModel {
  /** The dot on the Paint button: the brush swatch, null for any other brush. */
  readonly buttonDot: string | null;
  /** The armed-tool line while the Paint tool is armed (null for any other tool: the dock keeps its own words). */
  readonly paintLine: string | null;
  /** What the next building gets, in words, for the armed card's line and tooltip; null when it keeps its shipped colours. */
  readonly nextColourName: string | null;
  /** The chip on the armed card; null when there is nothing to show. */
  readonly chip: readonly (string | null)[] | null;
  /** The "Colour" button on the armed-tool line (a colourable card is armed and no inspector holds the slot). */
  readonly colourButton: { readonly visible: boolean; readonly pressed: boolean };
}

export const dockPaint = (input: DockPaintInput): DockPaintModel => {
  const { tool, selectedDefinitionId, brush } = input;
  const armedCard = tool === 'build' && selectedDefinitionId !== null ? selectedDefinitionId : null;
  const nextColourName = armedCard !== null && placementRecord(armedCard, brush) !== null ? brushName(brush) : null;
  return {
    buttonDot: brush.kind === 'swatch' && COLOUR_SWATCHES[brush.swatch] ? hexOf(COLOUR_SWATCHES[brush.swatch].rgb) : null,
    paintLine: tool === 'paint'
      ? `${input.picking ? 'Pick armed — click a building to copy its colours' : 'Paint armed — click or drag a building, Shift paints every part'} · Esc to put it down`
      : null,
    nextColourName,
    chip: nextColourName === null ? null : brushDots(brush),
    colourButton: { visible: armedCard !== null && isColourable(armedCard) && !input.inspectorOpen, pressed: input.panelOpen },
  };
};
