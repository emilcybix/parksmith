import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COLOUR_SWATCHES } from '../game/content/colours';
import { ColourSectionView } from './ColourSection';

/**
 * The thin component over `colourModel`: what a screen reader and the keyboard get from the markup.
 * (Real clicks, focus movement and the repaint are the browser e2e's; this pins the structure.)
 */

const render = (definitionId: string, colours: readonly (number | null)[] | null, open: boolean): string => {
  return renderToStaticMarkup(<ColourSectionView definitionId={definitionId} colours={colours} open={open} onOpenChange={() => undefined} />);
};

const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

describe('ColourSection markup', () => {
  it('renders nothing for a definition without slots', () => {
    expect(render('confetti-tree', null, true)).toBe('');
    expect(render('sunstone-path', null, true)).toBe('');
  });

  it('closed: a disclosure button that says what it opens and shows one dot per slot, nothing else', () => {
    const html = render('moonpetal-carousel', null, false);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="colour-body"');
    expect(html, 'no aria-label on the button that would replace the visible text').not.toContain('aria-label="Colours Default');
    expect(html).toContain('<small>COLOURS</small> <strong>Default colours</strong>');
    expect(html).toContain('<span class="sr-only">: Main Default (Orchid), Accent Default (Cream), Trim Default (Sunflower)</span>');
    expect(count(html, /class="colour-dots"[^>]*>(<i [^>]*><\/i>){3}</g)).toBe(1);
    expect(html).not.toContain('colour-swatch');
    expect(html, 'aria-controls always points at something').toMatch(/<div class="colour-body" id="colour-body" hidden="">\s*<\/div>/);
    expect(html).toContain('Default colours');
  });

  it('open: one labelled group per slot with every swatch a named toggle button', () => {
    const html = render('moonpetal-carousel', null, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('id="colour-body"');
    for (const label of ['Main colour', 'Accent colour', 'Trim colour']) expect(html).toContain(`role="group" data-roving="true" aria-label="${label}"`);
    expect(count(html, /class="colour-swatch /g)).toBe(3 * COLOUR_SWATCHES.length);
    for (const swatch of COLOUR_SWATCHES) expect(count(html, new RegExp(`aria-label="${swatch.name}"`, 'g'))).toBe(3);
    expect(count(html, /class="colour-swatch [^"]*" [^>]*aria-pressed="false"/g)).toBe(3 * COLOUR_SWATCHES.length);
    expect(html, 'swatches are real buttons, not links or divs').not.toMatch(/<(div|a|span)[^>]*class="colour-swatch/);
  });

  it('exactly one tab stop per swatch group: the first when nothing is chosen, the chosen one otherwise', () => {
    const plain = render('petal-roundabout', null, true);
    const groups = plain.split('role="group"').slice(1);
    expect(groups.length).toBe(2);
    for (const group of groups) {
      expect(count(group, /data-roving-item="true"[^>]*tabindex="0"/g)).toBe(1);
      expect(count(group, /tabindex="-1"/g)).toBe(COLOUR_SWATCHES.length - 1);
      expect(group.indexOf('tabindex="0"'), 'the first swatch').toBeLessThan(group.indexOf('tabindex="-1"'));
    }
    const chosen = render('petal-roundabout', [19, null], true).split('role="group"').slice(1);
    const tabbable = /data-swatch="(\d+)"[^>]*tabindex="0"/.exec(chosen[0]);
    expect(tabbable?.[1]).toBe('19');
    expect(/data-swatch="(\d+)"[^>]*tabindex="0"/.exec(chosen[1])?.[1], 'the default slot starts at the first').toBe('0');
  });

  it('marks the chosen swatch pressed with a check mark, and the Default chip of the other slot pressed', () => {
    const html = render('petal-roundabout', [19, null], true);
    expect(count(html, /aria-pressed="true"/g), 'one swatch plus the Accent slot\'s Default chip').toBe(2);
    expect(html).toMatch(/aria-label="Teal"[^>]*>|aria-pressed="true"[^>]*aria-label="Teal"/);
    expect(html).toContain('<span aria-hidden="true">✓</span>');
    expect(count(html, /✓/g), 'a check mark only on the explicit choice').toBe(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Accent: default, Sunflower"|aria-label="Accent: default, Sunflower"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Main: default, Rose"|aria-label="Main: default, Rose"[^>]*aria-pressed="false"/);
  });

  it('Reset is disabled-but-focusable at defaults (the project convention) and live when customised', () => {
    expect(render('petal-roundabout', null, true)).toMatch(/class="colour-reset" aria-disabled="true"[^>]*>At default colours</);
    expect(render('petal-roundabout', [3, null], true)).toMatch(/class="colour-reset" aria-disabled="false"[^>]*>Reset to default</);
  });

  it('announces the result through one polite status line', () => {
    const html = render('petal-roundabout', [19, null], true);
    expect(html).toContain('role="status">Colours: Main Teal; Accent default, Sunflower.</span>');
  });
});

describe('ColourSection markup for the step-2 kinds', () => {
  it('a coaster section has four named swatch groups, a stall two, each with 21 swatches', () => {
    const coaster = render('star-chaser', null, true);
    for (const label of ['Train colour', 'Seats colour', 'Rails colour', 'Supports colour']) expect(coaster).toContain(`role="group" data-roving="true" aria-label="${label}"`);
    expect(count(coaster, /colour-swatch /g)).toBe(4 * COLOUR_SWATCHES.length);
    const stall = render('picnic-pocket', [19, null], true);
    for (const label of ['Walls colour', 'Roof colour']) expect(stall).toContain(`aria-label="${label}"`);
    expect(count(stall, /colour-swatch /g)).toBe(2 * COLOUR_SWATCHES.length);
    expect(stall).toContain('aria-pressed="true"');
  });

  it('has nothing for a tree or a path', () => {
    expect(render('confetti-tree', null, true)).toBe('');
    expect(render('sunstone-path', null, true)).toBe('');
  });
});
