import { useRef, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import type { BiomeId } from '../game/biomes/types';
import type { MapDensity } from '../game/maps/types';
import type { ModeResumeOffer } from './menuModel';
import { MapPreview } from './MapPreview';
import {
  DEFAULT_GENERATOR_DRAFT,
  DEFAULT_NEW_PARK_SELECTION,
  GENERATE_CHOICE,
  buildNewParkPicker,
  moveRadio,
  rerolledSeedText,
  selectBiome,
  selectMap,
  type GeneratorDraft,
  type MapChoice,
  type NewParkSelection,
} from './newParkModel';

interface NewParkPanelProps {
  onBack: () => void;
  /** The newest sandbox save when Continue means another mode's park (Phase 22), else null. */
  resume?: ModeResumeOffer | null;
}

/**
 * The New park picker (Phase 24): six biome cards with a swatch strip, the selected biome's maps, Start and Back.
 * Meadow / Meadow Garden is preselected, so Enter on the map row (or Start) is today's sandbox. Both groups are
 * radio groups with a roving tab stop; arrows select as they move. `newParkModel.ts` decides everything.
 */
export const NewParkPanel = ({ onBack, resume = null }: NewParkPanelProps): React.JSX.Element => {
  const [selection, setSelection] = useState<NewParkSelection>(DEFAULT_NEW_PARK_SELECTION);
  const [draft, setDraft] = useState<GeneratorDraft>(DEFAULT_GENERATOR_DRAFT);
  const panelRef = useRef<HTMLElement>(null);
  const picker = buildNewParkPicker(selection, draft);
  const controls = picker.controls;

  const focusRadio = (group: 'biome' | 'map', id: string): void => {
    // Every radio of both groups is already in the DOM (tabindex -1 ones are focusable), so focus moves with the key, not a frame later.
    panelRef.current?.querySelector<HTMLElement>(`[data-pick-${group}="${id}"]`)?.focus();
  };

  const start = (): void => {
    if (picker.selection.mapId === GENERATE_CHOICE) {
      if (controls?.recipe) gameBridge.menuNewGenerated(controls.recipe);
      return;
    }
    gameBridge.menuNewPark(picker.selection.mapId);
  };

  const reroll = (): void => setDraft((previous) => ({ ...previous, seedText: rerolledSeedText(Math.random) }));

  const onDensityKey = (event: React.KeyboardEvent): void => {
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-pick-density]')?.dataset.pickDensity ?? draft.density;
    const next = moveRadio(['low', 'normal', 'high'], current, event.key);
    if (next === null) return;
    event.preventDefault();
    setDraft((previous) => ({ ...previous, density: next as MapDensity }));
    panelRef.current?.querySelector<HTMLElement>(`[data-pick-density="${next}"]`)?.focus();
  };

  const onBiomeKey = (event: React.KeyboardEvent): void => {
    // The focused radio is the truth even when React has not rendered the previous key yet (a laggy page, fast typing).
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-pick-biome]')?.dataset.pickBiome ?? picker.selection.biomeId;
    const next = moveRadio(picker.biomes.map((card) => card.id), current, event.key);
    if (next === null) return;
    event.preventDefault();
    setSelection((previous) => selectBiome(previous, next as BiomeId));
    focusRadio('biome', next);
  };

  const onMapKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      // Enter on a map row starts it; Space (the button's own click) only selects.
      event.preventDefault();
      start();
      return;
    }
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-pick-map]')?.dataset.pickMap ?? picker.selection.mapId;
    const next = moveRadio([...picker.maps.map((row) => row.id), GENERATE_CHOICE], current, event.key);
    if (next === null) return;
    event.preventDefault();
    setSelection((previous) => selectMap(previous, next as MapChoice));
    focusRadio('map', next);
  };

  return (
    <section className="menu-picker" aria-label="Sandbox" ref={panelRef}>
      <h2>Sandbox</h2>
      {resume !== null && (
        <button type="button" className="pick-resume" data-pick-resume onClick={() => void gameBridge.menuLoadSlot(resume.slotId)}>
          {resume.text}
        </button>
      )}
      <p className="menu-picker-lead">Pick a biome, then a map. The First Day hints guide the start on every one.</p>
      <div className="pick-biomes" role="radiogroup" aria-label="Biome" onKeyDown={onBiomeKey}>
        {picker.biomes.map((card) => (
          <button
            key={card.id}
            type="button"
            role="radio"
            aria-checked={card.selected}
            tabIndex={card.selected ? 0 : -1}
            className={`pick-card${card.selected ? ' selected' : ''}`}
            data-pick-biome={card.id}
            data-panel-focus={card.selected ? '' : undefined}
            onClick={() => setSelection((previous) => selectBiome(previous, card.id))}
          >
            <span className="pick-swatches" aria-hidden="true">
              {card.swatches.map((colour, index) => <i key={index} style={{ background: colour }} />)}
            </span>
            <span className="pick-card-name">{card.name}</span>
            <span className="pick-card-chip">{card.climateLabel}</span>
            <span className="pick-card-tagline">{card.tagline}</span>
          </button>
        ))}
      </div>
      <div className="pick-lower">
        <div className="pick-lower-main">
          <div className="pick-maps" role="radiogroup" aria-label={`Map in ${picker.biomes.find((card) => card.selected)?.name ?? 'this biome'}`} onKeyDown={onMapKey}>
            {picker.maps.map((row) => (
              <button
                key={row.id}
                type="button"
                role="radio"
                aria-checked={row.selected}
                tabIndex={row.selected ? 0 : -1}
                className={`pick-map${row.selected ? ' selected' : ''}`}
                data-pick-map={row.id}
                onClick={() => setSelection((previous) => selectMap(previous, row.id))}
              >
                <span className="pick-map-name">{row.name}</span>
                <span className="pick-map-blurb">{row.blurb}</span>
                <span className="pick-map-facts">{row.facts}</span>
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={picker.generate.selected}
              tabIndex={picker.generate.selected ? 0 : -1}
              className={`pick-map pick-generate${picker.generate.selected ? ' selected' : ''}`}
              data-pick-map={GENERATE_CHOICE}
              onClick={() => setSelection((previous) => selectMap(previous, GENERATE_CHOICE))}
            >
              <span className="pick-map-name">{picker.generate.name}</span>
              <span className="pick-map-blurb">{picker.generate.blurb}</span>
              <span className="pick-map-facts">{picker.generate.facts}</span>
            </button>
          </div>
          {controls !== null && (
            <div className="pick-controls" role="group" aria-label="Generator settings">
              <div className="pick-field">
                <label htmlFor="pick-seed">Seed</label>
                <input
                  id="pick-seed"
                  className="pick-seed"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={12}
                  value={controls.seedText}
                  aria-invalid={controls.seedError !== null}
                  aria-describedby="pick-seed-help"
                  data-pick-seed
                  onChange={(event) => setDraft((previous) => ({ ...previous, seedText: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      start();
                    } else if (event.key === 'Escape') {
                      // Escape in a text field is the field's (the menu ignores it), so it leaves the field for the Generate
                      // choice; the next Escape goes back to the start list like everywhere else in the picker.
                      event.preventDefault();
                      focusRadio('map', GENERATE_CHOICE);
                    }
                  }}
                />
                <button type="button" className="pick-reroll" data-pick-reroll onClick={reroll}>Reroll seed</button>
              </div>
              <p id="pick-seed-help" className={`pick-seed-help${controls.seedError === null ? '' : ' error'}`} aria-live="polite">
                {controls.seedError ?? 'The same seed and settings always make the same map.'}
              </p>
              <div className="pick-field-row">
              <div className="pick-field">
                <span id="pick-density-label">Scenery</span>
                <div className="pick-density" role="radiogroup" aria-labelledby="pick-density-label" onKeyDown={onDensityKey}>
                  {controls.densities.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={item.id === controls.density}
                      tabIndex={item.id === controls.density ? 0 : -1}
                      className={`pick-chip${item.id === controls.density ? ' selected' : ''}`}
                      data-pick-density={item.id}
                      onClick={() => setDraft((previous) => ({ ...previous, density: item.id }))}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              {controls.water !== null && (
                <label className="pick-water">
                  <input
                    type="checkbox"
                    checked={controls.water.on}
                    data-pick-water
                    onChange={(event) => setDraft((previous) => ({ ...previous, water: event.target.checked }))}
                  />
                  <span>{controls.water.label}</span>
                </label>
              )}
              {/* Phase 21: a generated estate, 64 x 64 with land for sale around a starting area by the gate. */}
              <label className="pick-water" title="A 64 x 64 map: you own the land by the gate and buy the rest parcel by parcel">
                <input
                  type="checkbox"
                  checked={controls.estate}
                  data-pick-estate
                  onChange={(event) => setDraft((previous) => ({ ...previous, estate: event.target.checked }))}
                />
                <span>Estate (64 × 64, buy land)</span>
              </label>
              </div>
            </div>
          )}
        </div>
        <figure className="pick-preview">
          <MapPreview image={picker.preview} label={picker.previewLabel} />
          <figcaption>{picker.preview === null ? 'No preview' : 'North is up. The pink marker is the gate.'}</figcaption>
        </figure>
      </div>
      <div className="pick-actions">
        <button type="button" className="menu-entry primary pick-start" data-pick-start disabled={!picker.canStart} onClick={() => start()}>
          <span className="menu-entry-label">{picker.startLabel}</span>
        </button>
        <button type="button" className="menu-back pick-back" data-pick-back onClick={onBack}>Back</button>
      </div>
    </section>
  );
};
