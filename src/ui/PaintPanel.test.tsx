import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PaintBrush } from '../game/content/colourPresets';
import { PaintPanelView, type PaintPanelViewProps } from './PaintPanel';

/** The thin component over `paintPanelModel`: what a screen reader and the keyboard get from the markup. */

const render = (props: Partial<PaintPanelViewProps> = {}): string => renderToStaticMarkup(
  <PaintPanelView brush={{ kind: 'default' }} target="primary" picking={false} mode="paint" {...props} />,
);
const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

describe('PaintPanel markup (paint mode)', () => {
  const html = render({ brush: { kind: 'swatch', swatch: 19 } as PaintBrush });

  it('is a labelled region with a heading, a close button that says what it does, and a polite status line', () => {
    expect(html).toContain('aria-label="Paint tool"');
    expect(html).toContain('role="heading" aria-level="2">Paint');
    expect(html).toContain('aria-label="Put the paint tool down"');
    expect(html).toContain('title="Put the paint tool down (Esc)"');
    expect(html).toContain('role="status">Brush: Teal on Main');
  });

  it('the swatch grid is ONE roving group of 21 named toggle buttons with one tab stop, a ring and a check on the chosen one', () => {
    expect(html).toContain('role="group" data-roving="true" aria-label="Brush colour"');
    expect(count(html, /data-swatch="/g)).toBe(21);
    expect(count(html, /tabindex="0"[^>]*data-swatch|data-swatch[^>]*tabindex="0"/g)).toBe(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Teal"|aria-label="Teal"[^>]*aria-pressed="true"/);
    expect(count(html, /colour-swatch[^"]* selected/g)).toBe(1);
    expect(html).toContain('<span aria-hidden="true">✓</span>');
    for (const name of ['Cherry', 'Teal', 'Lagoon']) expect(html).toContain(`aria-label="${name}"`);
  });

  it('the Default chip is a toggle with its own tab stop', () => {
    expect(html).toContain('aria-pressed="false" title="Paint the shipped colours back"');
  });

  it('the Paint choice is a radiogroup of three radios, one tab stop on the checked one', () => {
    expect(html).toContain('role="radiogroup" aria-labelledby="paint-target-label" aria-disabled="false"');
    expect(count(html, /role="radio"/g)).toBe(3);
    expect(html).toMatch(/role="radio"[^>]*data-target="primary"[^>]*aria-checked="true"[^>]*tabindex="0"/);
    expect(count(html, /role="radio"[^>]*tabindex="-1"/g)).toBe(2);
    for (const label of ['>Main<', '>Accent<', '>All<']) expect(html).toContain(label);
  });

  it('six presets, each a named toggle with a decorative dot strip, in one roving group; none pressed for a swatch brush', () => {
    expect(count(html, /data-preset="/g)).toBe(6);
    expect(count(html, /class="paint-dots" aria-hidden="true"/g)).toBe(6);
    expect(html).toContain('aria-labelledby="paint-preset-label"');
    expect(count(html, /paint-preset selected/g)).toBe(0);
    for (const name of ['Candy', 'Seaside', 'Midnight', 'Autumn', 'Meadow', 'Berry']) expect(html).toContain(`>${name}</span>`);
  });

  it('Apply to whole park is aria-disabled (the project convention, never `disabled`) until a preset is the brush; Pick has the key', () => {
    expect(html).toContain('aria-disabled="true" title="Choose a preset first');
    expect(html).not.toContain(' disabled=');
    expect(html).toContain('aria-keyshortcuts="i"');
    expect(html).toContain('aria-pressed="false" aria-keyshortcuts');
    const preset = render({ brush: { kind: 'preset', presetId: 'seaside' } });
    expect(preset).toContain('Apply Seaside to whole park');
    expect(preset).toContain('aria-disabled="false" title="Seaside on every ride');
    expect(preset).toContain('role="radiogroup" aria-labelledby="paint-target-label" aria-disabled="true"');
    expect(count(preset, /paint-preset selected/g)).toBe(1);
  });

  it('a picking panel has the Pick toggle pressed, a copied brush shows its own line', () => {
    expect(render({ picking: true })).toMatch(/paint-pick active"[^>]*aria-pressed="true"/);
    const copied = render({ brush: { kind: 'copied', sourceName: 'Picnic Pocket', roles: {} } });
    expect(copied).toContain('class="paint-copied"');
    expect(copied).toContain('Colours of Picnic Pocket');
  });

  it('has the one-line hint', () => {
    expect(html).toContain('Click or drag to paint. Shift paints every part.');
  });
});

describe('PaintPanel markup (place mode)', () => {
  const html = render({ mode: 'place', armedName: 'Picnic Pocket', brush: { kind: 'swatch', swatch: 4 } });

  it('names the armed card and offers only the brush parts', () => {
    expect(html).toContain('aria-label="Colour of the next Picnic Pocket"');
    expect(html).toContain('>Picnic Pocket</strong>');
    expect(html).toContain('Next one: Teal'.replace('Teal', 'Buttercup'));
    expect(html).toContain('aria-label="Close the colour panel"');
    expect(count(html, /data-swatch="/g)).toBe(21);
    expect(count(html, /data-preset="/g)).toBe(6);
    expect(html).not.toContain('paint-targets');
    expect(html).not.toContain('paint-apply');
    expect(html).not.toContain('paint-pick');
    expect(html).toContain('The next one you place gets this colour.');
  });
});
