import { useMemo, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import type { PaintBrush, PaintTarget } from '../game/content/colourPresets';
import type { KeybindingOverrides } from '../settings/keybindings';
import { rovingStop, rovingTabIndex } from './a11yModel';
import { handleRovingKey } from './a11yHooks';
import { SWATCH_COLUMNS } from './colourModel';
import { paintPanel, type PaintPanelMode } from './paintPanelModel';
import { useUiStore } from './store';

/**
 * Phase 28 step 2: the Paint panel. A thin map over `paintPanelModel`: a header with a close button (which is Esc),
 * a polite status line, the brush grid (a Default chip and the 21 swatches in their themed rows, one roving tab
 * stop), the Main / Accent / All choice, the six presets, "Apply to whole park" and the Pick toggle.
 *
 * Shown with the Paint tool armed, and, with only the brush parts, next to a colourable build card the player
 * opened it for (the "Colour" button): the brush then colours the NEXT building. Everything is a real button with
 * a name; the chosen swatch shows a ring AND a check mark, never colour alone. Painting a thing is a pointer
 * gesture (the documented exception); keyboard players recolour from the inspector or apply a preset to the park.
 *
 * Phase 34: this module is a lazy chunk. `PaintPanel` (which decides whether the panel shows and reads the store) lives
 * in `lazyPanels.tsx`; this module holds the view.
 */
export interface PaintPanelViewProps {
  brush: PaintBrush;
  target: PaintTarget;
  picking: boolean;
  mode: PaintPanelMode;
  armedName?: string | null;
  keys?: KeybindingOverrides;
}

/** The panel with its state handed in (the store is the one place that holds it), so the markup is testable. */
export const PaintPanelView = ({ brush, target, picking, mode, armedName = null, keys }: PaintPanelViewProps): React.JSX.Element => {
  const model = useMemo(() => paintPanel({ brush, target, picking, mode, armedName, keys }), [brush, target, picking, mode, armedName, keys]);
  const ui = useUiStore.getState;
  // The swatch (and preset) that holds the tab stop once the player has moved focus there.
  const [rememberedSwatch, setRememberedSwatch] = useState<number | null>(null);
  const [rememberedPreset, setRememberedPreset] = useState<number | null>(null);
  const swatchStop = rovingStop(model.swatches.length, rememberedSwatch, model.initialStop);
  const presetStop = rovingStop(model.presets.length, rememberedPreset, model.presets.findIndex((preset) => preset.selected));
  const targetStop = model.targets === null ? 0 : Math.max(0, model.targets.findIndex((choice) => choice.selected));
  const close = (): void => {
    const ui = useUiStore.getState();
    if (mode === 'paint') ui.cancelTool();
    else ui.setPaintPanelOpen(false);
  };
  return (
    <aside className={`paint-panel ${mode}`} aria-label={mode === 'paint' ? 'Paint tool' : `Colour of the next ${armedName ?? 'building'}`}>
      <header>
        <span className="paint-icon" aria-hidden="true">◐</span>
        <span><small>{mode === 'paint' ? 'COLOUR TOOL' : 'NEXT COLOUR'}</small><strong role="heading" aria-level={2}>{model.title}</strong></span>
        <button type="button" onClick={close} title={mode === 'paint' ? 'Put the paint tool down (Esc)' : 'Close'} aria-label={mode === 'paint' ? 'Put the paint tool down' : 'Close the colour panel'}><span aria-hidden="true">×</span></button>
      </header>
      <p className="paint-status" role="status">{model.status}</p>
      <div className="paint-section">
        <div className="paint-section-head">
          <strong>Colour</strong>
          <span className="paint-head-actions">
            <button
              type="button"
              className={`colour-default${model.defaultChip.selected ? ' active' : ''}`}
              aria-pressed={model.defaultChip.selected}
              title={model.defaultChip.title}
              onClick={() => ui().setPaintBrush({ kind: 'default' })}
            >
              <i aria-hidden="true" className="paint-default-dot" />
              <span>{model.defaultChip.label}</span>
            </button>
            {model.pick !== null && (
              <button
                type="button"
                className={`colour-default paint-pick${model.pick.pressed ? ' active' : ''}`}
                aria-pressed={model.pick.pressed}
                aria-keyshortcuts={model.pick.keyShortcuts}
                title={`Click a building to copy its colours into the brush${model.pick.keyLabel ? ` (${model.pick.keyLabel})` : ''}`}
                onClick={() => ui().setPaintPicking(!model.pick?.pressed)}
              >
                <span aria-hidden="true">✎</span><span>{model.pick.label}</span>{model.pick.keyLabel && <kbd aria-hidden="true">{model.pick.keyLabel}</kbd>}
              </button>
            )}
          </span>
        </div>
        <div
          className="colour-grid paint-grid"
          role="group"
          data-roving
          aria-label="Brush colour"
          style={{ '--colour-columns': SWATCH_COLUMNS } as React.CSSProperties}
          onFocus={(event) => {
            const index = (event.target as HTMLElement).closest<HTMLElement>('[data-swatch]')?.dataset.swatch;
            if (index !== undefined && Number(index) !== rememberedSwatch) setRememberedSwatch(Number(index));
          }}
          onKeyDown={(event) => handleRovingKey(event, { orientation: 'both', wrap: false })}
        >
          {model.swatches.map((swatch, position) => (
            <button
              type="button"
              key={swatch.index}
              data-roving-item
              data-swatch={swatch.index}
              className={`colour-swatch ${swatch.checkTone}${swatch.selected ? ' selected' : ''}`}
              style={{ '--swatch': swatch.hex } as React.CSSProperties}
              tabIndex={rovingTabIndex(position, swatchStop)}
              aria-pressed={swatch.selected}
              aria-label={swatch.label}
              title={`${swatch.name} (${swatch.rowLabel})`}
              onClick={() => ui().setPaintBrush({ kind: 'swatch', swatch: swatch.index })}
            >
              <span aria-hidden="true">{swatch.selected ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      </div>
      {model.targets !== null && (
        <div className="paint-section paint-target-row">
          <strong id="paint-target-label">Paint</strong>
          <div
            className="paint-targets"
            role="radiogroup"
            aria-labelledby="paint-target-label"
            aria-disabled={model.targetsInert}
            onKeyDown={(event) => handleRovingKey(event, { orientation: 'horizontal', wrap: true }, (element) => {
              if (!model.targetsInert) ui().setPaintTarget(element.dataset.target as PaintTarget);
            })}
          >
            {model.targets.map((choice, position) => (
              <button
                type="button"
                key={choice.id}
                role="radio"
                data-roving-item
                data-target={choice.id}
                aria-checked={choice.selected}
                aria-disabled={model.targetsInert}
                tabIndex={rovingTabIndex(position, targetStop)}
                className={`paint-target${choice.selected ? ' selected' : ''}`}
                title={model.targetsInert ? 'A preset or a picked colour set paints every part' : choice.description}
                onClick={() => { if (!model.targetsInert) ui().setPaintTarget(choice.id); }}
              >{choice.label}</button>
            ))}
          </div>
        </div>
      )}
      <div className="paint-section">
        <div className="paint-section-head"><strong id="paint-preset-label">Presets</strong></div>
        <div
          className="paint-presets"
          role="group"
          data-roving
          aria-labelledby="paint-preset-label"
          onFocus={(event) => {
            const index = (event.target as HTMLElement).closest<HTMLElement>('[data-preset-index]')?.dataset.presetIndex;
            if (index !== undefined && Number(index) !== rememberedPreset) setRememberedPreset(Number(index));
          }}
          onKeyDown={(event) => handleRovingKey(event, { orientation: 'both', wrap: false })}
        >
          {model.presets.map((preset, position) => (
            <button
              type="button"
              key={preset.id}
              data-roving-item
              data-preset={preset.id}
              data-preset-index={position}
              tabIndex={rovingTabIndex(position, presetStop)}
              className={`paint-preset${preset.selected ? ' selected' : ''}`}
              aria-pressed={preset.selected}
              title={preset.title}
              onClick={() => ui().setPaintBrush({ kind: 'preset', presetId: preset.id })}
            >
              <span className="paint-dots" aria-hidden="true">
                {preset.dots.map((hex, index) => <i key={index} className={hex === null ? 'dot-default' : undefined} style={hex === null ? undefined : { background: hex }} />)}
              </span>
              <span className="paint-preset-name">{preset.name}</span>
              <span className="paint-preset-check" aria-hidden="true">{preset.selected ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      </div>
      {model.copied !== null && (
        <p className="paint-copied"><span aria-hidden="true">✎</span> {model.copied}</p>
      )}
      {model.applyToPark !== null && (
        <div className="paint-actions">
          <button
            type="button"
            className="paint-apply"
            aria-disabled={!model.applyToPark.enabled}
            title={model.applyToPark.title}
            onClick={() => {
              if (!model.applyToPark?.enabled) return;
              const current = useUiStore.getState().paintBrush;
              if (current.kind === 'preset') gameBridge.applyPresetToPark(current.presetId);
            }}
          >{model.applyToPark.label}</button>
        </div>
      )}
      <p className="paint-hint">{model.hint}</p>
    </aside>
  );
};
