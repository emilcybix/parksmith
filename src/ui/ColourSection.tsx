import { useMemo, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import type { ObjectColours } from '../game/content/colours';
import { rovingStop, rovingTabIndex } from './a11yModel';
import { handleRovingKey } from './a11yHooks';
import { colourSection, SWATCH_COLUMNS } from './colourModel';
import { useUiStore } from './store';

/**
 * Phase 28 step 1: the Colours section of the ride inspector. A thin map over `colourModel`: a
 * disclosure header with one dot per slot, then one row per slot (label, a Default chip, and the
 * swatches in their themed rows), and Reset. Picking a swatch repaints the ride itself at once, so
 * the object is the preview; there is nothing to apply or cancel, and Ctrl+Z takes the picks back.
 *
 * Keyboard: the header and each row's Default chip are ordinary buttons; the swatches of a slot are
 * one roving group (one tab stop, arrows move by one and by a row, Home and End jump to the ends,
 * Enter or Space picks). Selection is shown by a check mark as well as a ring, never by colour alone.
 */
export const ColourSection = ({ definitionId, colours }: {
  definitionId: string;
  colours: ObjectColours | null;
}): React.JSX.Element | null => {
  const open = useUiStore((state) => state.colourPanelOpen);
  const setOpen = useUiStore((state) => state.setColourPanelOpen);
  return <ColourSectionView definitionId={definitionId} colours={colours} open={open} onOpenChange={setOpen} />;
};

/** The section with its expanded state handed in (the store is the one place that remembers it). */
export const ColourSectionView = ({ definitionId, colours, open, onOpenChange }: {
  definitionId: string;
  colours: ObjectColours | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element | null => {
  const model = useMemo(() => colourSection(definitionId, colours), [definitionId, colours]);
  // Per slot, the swatch that holds the tab stop once the player has moved focus there.
  const [remembered, setRemembered] = useState<Readonly<Record<number, number>>>({});
  if (!model) return null;
  return (
    <section className="colour-section" aria-label="Colours">
      <button
        type="button"
        className="colour-toggle"
        aria-expanded={open}
        aria-controls="colour-body"
        onClick={() => onOpenChange(!open)}
      >
        <span className="colour-toggle-title">
          <small>COLOURS</small>{' '}<strong>{model.title}</strong>
          {/* The name is the visible text and then the colours (WCAG 2.5.3); aria-expanded says open or closed. */}
          <span className="sr-only">: {model.toggleSummary}</span>
        </span>
        <span className="colour-dots" aria-hidden="true">
          {model.dots.map((dot) => <i key={dot.id} style={{ background: dot.hex }} title={`${dot.label}: ${dot.name}`} />)}
        </span>
        <span className="colour-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      <div className="colour-body" id="colour-body" hidden={!open}>
        {open && (<>
          {model.rows.map((row) => {
            const stop = rovingStop(row.swatches.length, remembered[row.slotIndex] ?? null, row.initialStop);
            return (
              <div className="colour-row" key={row.id} data-slot={row.id}>
                <div className="colour-row-head">
                  <strong title={row.description}>{row.label}</strong>
                  <button
                    type="button"
                    className={`colour-default${row.isDefault ? ' active' : ''}`}
                    aria-pressed={row.isDefault}
                    aria-label={row.defaultChipLabel}
                    title={`Use the original ${row.label.toLowerCase()} colour (${row.defaultName})`}
                    onClick={() => gameBridge.setSelectedObjectColour(row.slotIndex, null)}
                  >
                    <i aria-hidden="true" style={{ background: row.defaultHex }} />
                    <span>Default</span>
                  </button>
                </div>
                <div
                  className="colour-grid"
                  role="group"
                  data-roving
                  aria-label={row.groupLabel}
                  style={{ '--colour-columns': SWATCH_COLUMNS } as React.CSSProperties}
                  onFocus={(event) => {
                    const index = (event.target as HTMLElement).closest<HTMLElement>('[data-swatch]')?.dataset.swatch;
                    if (index !== undefined && Number(index) !== remembered[row.slotIndex]) {
                      setRemembered((previous) => ({ ...previous, [row.slotIndex]: Number(index) }));
                    }
                  }}
                  onKeyDown={(event) => handleRovingKey(event, { orientation: 'both', wrap: false })}
                >
                  {row.swatches.map((swatch, position) => (
                    <button
                      type="button"
                      key={swatch.index}
                      data-roving-item
                      data-swatch={swatch.index}
                      className={`colour-swatch ${swatch.checkTone}${swatch.selected ? ' selected' : ''}`}
                      style={{ '--swatch': swatch.hex } as React.CSSProperties}
                      tabIndex={rovingTabIndex(position, stop)}
                      aria-pressed={swatch.selected}
                      aria-label={swatch.label}
                      title={`${row.label}: ${swatch.name} (${swatch.rowLabel})`}
                      onClick={() => gameBridge.setSelectedObjectColour(row.slotIndex, swatch.index)}
                    >
                      <span aria-hidden="true">{swatch.selected ? '✓' : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="colour-foot">
            <button
              type="button"
              className="colour-reset"
              aria-disabled={!model.customised}
              onClick={() => { if (model.customised) gameBridge.resetSelectedObjectColours(); }}
            >{model.customised ? 'Reset to default' : 'At default colours'}</button>
            <span className="sr-only" role="status">{model.summary}</span>
          </div>
        </>)}
      </div>
    </section>
  );
};
