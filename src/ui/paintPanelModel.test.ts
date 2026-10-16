import { describe, expect, it } from 'vitest';
import { COLOUR_SWATCHES } from '../game/content/colours';
import { COLOUR_PRESETS, type PaintBrush } from '../game/content/colourPresets';
import { contrastRatio } from './a11yModel';
import { SWATCH_COLUMNS } from './colourModel';
import { brushDots, brushStatus, dockPaint, paintPanel, type DockPaintInput } from './paintPanelModel';

const DEFAULT: PaintBrush = { kind: 'default' };
const panel = (brush: PaintBrush = DEFAULT, extra: Partial<Parameters<typeof paintPanel>[0]> = {}) => (
  paintPanel({ brush, target: 'primary', picking: false, mode: 'paint', ...extra })
);

describe('paint panel model', () => {
  it('offers the 21 swatches once each in catalog order, grouped as the inspector groups them, labelled by name', () => {
    const model = panel();
    expect(model.swatches.map((swatch) => swatch.index)).toEqual(COLOUR_SWATCHES.map((swatch) => swatch.index));
    expect(model.swatches.map((swatch) => swatch.label)).toEqual(COLOUR_SWATCHES.map((swatch) => swatch.name));
    expect(SWATCH_COLUMNS).toBe(7);
    expect(model.swatches).toHaveLength(21);
  });

  it('marks the chosen swatch (ring and check come from `selected`), with a check tone that has 3:1 against it', () => {
    const model = panel({ kind: 'swatch', swatch: 19 });
    expect(model.swatches.filter((swatch) => swatch.selected).map((swatch) => swatch.name)).toEqual(['Teal']);
    expect(model.initialStop).toBe(19);
    expect(model.defaultChip.selected).toBe(false);
    for (const swatch of model.swatches) {
      const mark = swatch.checkTone === 'light' ? '#ffffff' : '#1d2b27';
      expect(contrastRatio(swatch.hex, mark), swatch.name).toBeGreaterThanOrEqual(3);
    }
  });

  it('the default brush selects the Default chip and no swatch; the tab stop starts on the first swatch', () => {
    const model = panel();
    expect(model.defaultChip).toMatchObject({ selected: true, label: 'Default' });
    expect(model.swatches.some((swatch) => swatch.selected)).toBe(false);
    expect(model.initialStop).toBe(0);
  });

  it('says what the brush is in one polite line', () => {
    expect(brushStatus(DEFAULT, 'primary')).toBe('Brush: Default colours on Main');
    expect(brushStatus({ kind: 'swatch', swatch: 19 }, 'secondary')).toBe('Brush: Teal on Accent');
    expect(brushStatus({ kind: 'swatch', swatch: 19 }, 'all')).toBe('Brush: Teal on Every part');
    expect(brushStatus({ kind: 'preset', presetId: 'seaside' }, 'primary')).toBe('Brush: Seaside colours');
    expect(brushStatus({ kind: 'copied', sourceName: 'Picnic Pocket', roles: {} }, 'primary')).toBe('Brush: Colours of Picnic Pocket');
    expect(panel({ kind: 'swatch', swatch: 4 }).status).toBe('Brush: Buttercup on Main');
  });

  it('the target group is Main, Accent, All, one selected; inert (and none selected) for a preset or a copied brush', () => {
    const plain = panel({ kind: 'swatch', swatch: 3 }, { target: 'secondary' });
    expect(plain.targets?.map((target) => [target.label, target.selected])).toEqual([['Main', false], ['Accent', true], ['All', false]]);
    expect(plain.targetsInert).toBe(false);
    for (const brush of [{ kind: 'preset', presetId: 'autumn' }, { kind: 'copied', sourceName: 'X', roles: {} }] as PaintBrush[]) {
      const model = panel(brush, { target: 'secondary' });
      expect(model.targetsInert).toBe(true);
      expect(model.targets?.some((target) => target.selected)).toBe(false);
    }
  });

  it('lists the six presets in data order, each with three dots, and selects the chosen one', () => {
    const model = panel({ kind: 'preset', presetId: 'midnight' });
    expect(model.presets.map((preset) => preset.id)).toEqual(COLOUR_PRESETS.map((preset) => preset.id));
    expect(model.presets).toHaveLength(6);
    for (const preset of model.presets) expect(preset.dots).toHaveLength(3);
    expect(model.presets.filter((preset) => preset.selected).map((preset) => preset.id)).toEqual(['midnight']);
    expect(model.presets.find((preset) => preset.id === 'candy')?.dots, 'Candy is the shipped colours: no swatch dots').toEqual([null, null, null]);
    expect(model.presets.find((preset) => preset.id === 'seaside')?.dots.every((hex) => /^#[0-9a-f]{6}$/.test(hex ?? ''))).toBe(true);
    expect(model.presets[1].title).toContain(':');
  });

  it('"Apply to whole park" is enabled only with a preset brush and names it', () => {
    expect(panel().applyToPark).toMatchObject({ label: 'Apply to whole park', enabled: false });
    expect(panel({ kind: 'swatch', swatch: 1 }).applyToPark?.enabled).toBe(false);
    expect(panel({ kind: 'copied', sourceName: 'X', roles: {} }).applyToPark?.enabled).toBe(false);
    expect(panel({ kind: 'preset', presetId: 'berry' }).applyToPark).toMatchObject({ label: 'Apply Berry to whole park', enabled: true });
  });

  it('the Pick toggle reports its state and the key the registry says (rebinding follows)', () => {
    expect(panel().pick).toMatchObject({ pressed: false, label: 'Pick colours', keyLabel: 'I' });
    expect(panel(DEFAULT, { picking: true }).pick?.pressed).toBe(true);
    expect(panel(DEFAULT, { keys: { eyedropper: 'k:o' } }).pick?.keyLabel).toBe('O');
    expect(panel(DEFAULT, { keys: { eyedropper: null } }).pick).toMatchObject({ keyLabel: null, keyShortcuts: undefined });
  });

  it('the copied brush shows as its own line', () => {
    expect(panel({ kind: 'copied', sourceName: 'Picnic Pocket', roles: {} }).copied).toBe('Colours of Picnic Pocket');
    expect(panel().copied).toBeNull();
  });

  it('place mode (a colourable card is armed) has only the brush parts and names the card', () => {
    const model = panel({ kind: 'swatch', swatch: 19 }, { mode: 'place', armedName: 'Picnic Pocket' });
    expect(model.title).toBe('Picnic Pocket');
    expect(model.status, 'the target does not apply to the next building').toBe('Next one: Teal');
    expect(panel(DEFAULT, { mode: 'place' }).status).toBe('Next one: shipped colours');
    expect(panel({ kind: 'preset', presetId: 'seaside' }, { mode: 'place', target: 'secondary' }).status).toBe('Next one: Seaside colours');
    expect(model.targets).toBeNull();
    expect(model.applyToPark).toBeNull();
    expect(model.pick).toBeNull();
    expect(model.swatches).toHaveLength(21);
    expect(model.presets).toHaveLength(6);
    expect(model.hint).toBe('The next one you place gets this colour.');
    expect(panel(DEFAULT, { mode: 'place' }).title).toBe('Building');
  });

  it('the paint mode hint says what click, drag and Shift do', () => {
    expect(panel().hint).toBe('Click or drag to paint. Shift paints every part.');
    expect(panel().title).toBe('Paint');
  });

  it('an out-of-range swatch brush reads as no chosen swatch (a hostile or stale value never throws)', () => {
    const model = panel({ kind: 'swatch', swatch: 99 });
    expect(model.swatches.some((swatch) => swatch.selected)).toBe(false);
    expect(model.initialStop).toBe(0);
    expect(model.status).toBe('Brush: Default colours on Main');
  });
});

describe('the dock model (Paint button, armed line, Colour button, next-colour chip)', () => {
  const dock = (extra: Partial<DockPaintInput> = {}) => dockPaint({
    tool: 'build', selectedDefinitionId: 'picnic-pocket', brush: { kind: 'swatch', swatch: 19 }, picking: false, panelOpen: false, inspectorOpen: false, ...extra,
  });

  it('a colourable armed card with a swatch brush names the next colour, wears one dot, and offers the Colour button', () => {
    const model = dock();
    expect(model.nextColourName).toBe('Teal');
    expect(model.chip).toEqual(['#3aa7a3']);
    expect(model.colourButton).toEqual({ visible: true, pressed: false });
    expect(dock({ panelOpen: true }).colourButton.pressed).toBe(true);
    expect(model.paintLine, 'the dock keeps its own words for a build card').toBeNull();
  });

  it('a preset brush gives three dots, a copied one three dots with null for a shipped colour, the default brush nothing', () => {
    expect(dock({ brush: { kind: 'preset', presetId: 'seaside' } }).chip).toHaveLength(3);
    expect(dock({ brush: { kind: 'preset', presetId: 'seaside' } }).nextColourName).toBe('Seaside');
    expect(brushDots({ kind: 'copied', sourceName: 'X', roles: { primary: 19 } })).toEqual(['#3aa7a3', null, null]);
    const none = dock({ brush: { kind: 'default' } });
    expect(none.nextColourName).toBeNull();
    expect(none.chip).toBeNull();
    expect(none.colourButton.visible, 'the button stays for a colourable card').toBe(true);
    expect(brushDots({ kind: 'default' })).toBeNull();
  });

  it('a card that cannot be coloured, or a path, has no next colour, no chip and no button', () => {
    for (const id of ['confetti-tree', 'sunstone-path']) {
      const model = dock({ selectedDefinitionId: id });
      expect(model.nextColourName, id).toBeNull();
      expect(model.chip, id).toBeNull();
      expect(model.colourButton.visible, id).toBe(false);
    }
  });

  it('every colourable catalog card (coasters included) gets the button; an open inspector hides it', () => {
    for (const id of ['comet-trail', 'star-chaser', 'comfort-cabin', 'ribbon-bench', 'tidy-totem', 'ripple-fountain', 'petal-roundabout']) {
      expect(dock({ selectedDefinitionId: id }).colourButton.visible, id).toBe(true);
    }
    expect(dock({ inspectorOpen: true }).colourButton.visible).toBe(false);
  });

  it('the Paint tool has its own line, in pick mode too, and the dot of a swatch brush; no card means no next colour', () => {
    const paint = dock({ tool: 'paint', selectedDefinitionId: null });
    expect(paint.paintLine).toBe('Paint armed — click or drag a building, Shift paints every part · Esc to put it down');
    expect(dock({ tool: 'paint', selectedDefinitionId: null, picking: true }).paintLine).toBe('Pick armed — click a building to copy its colours · Esc to put it down');
    expect(paint.buttonDot).toBe('#3aa7a3');
    expect(paint.nextColourName).toBeNull();
    expect(paint.colourButton.visible).toBe(false);
    expect(dock({ brush: { kind: 'preset', presetId: 'berry' } }).buttonDot).toBeNull();
    expect(dock({ tool: 'pointer', selectedDefinitionId: null }).paintLine).toBeNull();
  });

  it('a stale or hostile swatch index never throws', () => {
    expect(() => dock({ brush: { kind: 'swatch', swatch: 99 } })).not.toThrow();
    expect(dock({ brush: { kind: 'swatch', swatch: 99 } }).buttonDot).toBeNull();
  });
});
