import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NewParkPanel } from './NewParkPanel';

/** The picker's structure for a screen reader and the keyboard; clicks, focus moves and starting a park are the browser e2e's. */
describe('NewParkPanel markup', () => {
  const html = renderToStaticMarkup(<NewParkPanel onBack={() => undefined} />);
  const count = (pattern: RegExp): number => (html.match(pattern) ?? []).length;

  it('has two labelled radio groups: six biomes and the maps of the selected one', () => {
    expect(html).toContain('role="radiogroup" aria-label="Biome"');
    expect(html).toContain('aria-label="Map in Meadow"');
    expect(count(/class="pick-card( selected)?"/g)).toBe(6);
    // Meadow: Meadow Garden, Brookside Meadow, the Phase 21 Meadow Estate and Generate.
    expect(count(/class="pick-map( pick-generate)?( selected)?"/g)).toBe(4);
    expect(count(/role="radio"/g)).toBe(10);
  });

  it('has exactly one tab stop per group (roving tabindex), on the selected radio, and Meadow Garden preselected', () => {
    expect(count(/tabindex="0" class="pick-card selected"/g)).toBe(1);
    expect(count(/tabindex="-1" class="pick-card"/g)).toBe(5);
    expect(count(/tabindex="0" class="pick-map selected"/g)).toBe(1);
    expect(count(/aria-checked="true"/g)).toBe(2);
    expect(html).toContain('Start Meadow Garden');
  });

  it('puts the initial focus target on the selected biome card only, and hides the swatch strips from assistive tech', () => {
    expect(count(/data-panel-focus/g)).toBe(1);
    expect(count(/class="pick-swatches" aria-hidden="true"/g)).toBe(6);
  });

  it('offers Start and Back as plain buttons', () => {
    expect(html).toContain('data-pick-start');
    expect(html).toContain('data-pick-back');
    expect(html).toMatch(/<button type="button" class="menu-back pick-back"[^>]*>Back<\/button>/);
  });
});
