import { describe, expect, it } from 'vitest';
import { contrastRatio } from './a11yModel';

// Vitest stubs CSS imports, so the stylesheet is read from disk (no @types/node in this project).
const nodeFs = (globalThis as unknown as { process: { getBuiltinModule(id: string): { readFileSync(path: string, enc: string): string } } })
  .process.getBuiltinModule('node:fs');
const css = nodeFs.readFileSync(new URL('./styles.css', import.meta.url).pathname, 'utf8');
const start = css.indexOf('The Map (Phase 23): setup, run overlay, leave-run question');
const block = start < 0 ? '' : css.slice(start);
const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');

const balanced = (source: string): { depth: number; lowest: number } => {
  let depth = 0;
  let lowest = 0;
  for (const ch of source.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; lowest = Math.min(lowest, depth); }
  }
  return { depth, lowest };
};

describe('stylesheets stay well formed', () => {
  // A stray closing brace swallows the next rule in every browser: removing the Park Tour block once left one, and the coaster
  // designer lost its position until the layout audit caught it.
  it.each(['./styles.css', './a11y.css', './keyboardSettings.css'])('%s has balanced braces and never closes more than it opened', (file) => {
    const text = nodeFs.readFileSync(new URL(file, import.meta.url).pathname, 'utf8');
    expect(balanced(text)).toEqual({ depth: 0, lowest: 0 });
  });
});

describe('The Map styles', () => {
  it('has its own block in styles.css', () => {
    expect(start).toBeGreaterThan(0);
    expect(rules).toContain('.run-screen');
    expect(rules).toContain('.run-node');
    expect(rules).toContain('.leave-run');
  });

  it('uses container queries only: no viewport @media inside the Map block (ARCHITECTURE: the UI layer is zoomed)', () => {
    expect(rules).not.toMatch(/@media\b/);
    expect(rules).toMatch(/@container ui \(max-height: 760px\)/);
  });

  it('styles the Phase 25 card pieces: badges, notes, the pocket line, the Collection families', () => {
    for (const selector of ['.card-badges', '.card-badge', '.card-notes', '.card-note', '.loadout-pocket', '.collection-family', '.run-continue-note']) {
      expect(rules, selector).toContain(selector);
    }
  });

  it('styles the Phase 25 play path: the HUD card list, the Play button, the due row and the narrow-UI chip (design 10.4)', () => {
    for (const selector of ['.scenario-cards', '.card-play', '.scenario-card-due', '.card-chip-short', '.card-chip-full', '.card-state', '.card-due', '.run-debt']) {
      expect(rules, selector).toContain(selector);
    }
    // The chip rule is a container query on the UI layer, and the full name is clipped, never display: none (it is the label).
    const narrow = /@container ui \(max-width: 1216px\) \{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? '';
    expect(narrow).toContain('.card-chip-short { display: inline; }');
    expect(narrow).toMatch(/\.card-chip-full \{[^}]*clip-path/);
    expect(narrow).not.toMatch(/\.card-chip-full \{[^}]*display:\s*none/);
    expect(rules, 'the disabled Play button is styled by its aria-disabled state').toContain('.card-play[aria-disabled="true"]');
  });

  it('keeps Park Pulse clear of the build dock: capped at --dock-reserve, the stage card list gives way and scrolls (Phase 25 audit)', () => {
    // One-shots with their facts and a due row pushed the objective panel under the dock at 760 px (Wave 3 note); the
    // browser audit measured it across the 1280x720..1920x1080 x 100..130 matrix.
    expect(rules).toMatch(/\.pulse-card \{[^}]*max-height: calc\(var\(--ui-vh\) - 94px - var\(--dock-reserve\)\)/);
    expect(rules).toMatch(/\.pulse-card > \.scenario-panel:has\(\.scenario-cards\) \{[^}]*min-height: 0/);
    // The rows' sr-only prefixes are absolute: the list must be their containing block or they stretch Park Pulse.
    expect(rules).toMatch(/\.scenario-panel \.scenario-cards \{[^}]*position: relative;[^}]*overflow-y: auto/);
    expect(rules).toMatch(/@container ui \(max-height: 820px\) \{[^}]*\.pulse-insights \{ display: none; \}/);
    // The same containing-block rule for the Collection's grouped tiles (they hung off the menu backdrop and scrolled the page).
    expect(rules).toMatch(/\.collection-family \{ position: relative; \}/);
  });

  it('has one .scenario-cards rule set: the retired picker grid no longer leaks into the HUD list', () => {
    for (const match of css.matchAll(/(^|\n)\.scenario-cards \{([^}]*)\}/g)) {
      expect(match[2]).not.toMatch(/grid-template-columns|overflow-y/);
    }
  });

  it('moves nothing: no animation, no transition, no keyframes (the current level is a static ring and a word)', () => {
    expect(rules).not.toMatch(/animation\s*:/);
    expect(rules).not.toMatch(/transition\s*:/);
    expect(rules).not.toMatch(/@keyframes/);
  });

  it('never fixes a width in pixels that would break at a large UI scale (max-width and min() only)', () => {
    for (const match of rules.matchAll(/(^|[;{\s])width:\s*(\d+)px/g)) {
      // The map previews and the close button are the only fixed boxes (squares that do not hold text).
      expect(['34', '72', '52']).toContain(match[2]);
    }
  });

  it('small print on the cards clears 4.5:1 on white and on the paper tints', () => {
    const inks = [...new Set([...rules.matchAll(/color:\s*(#[0-9a-f]{6})/gi)].map((match) => match[1].toLowerCase()))];
    expect(inks.length).toBeGreaterThan(3);
    for (const ink of inks) {
      if (ink === '#fff' || ink === '#ffffff') continue;
      // Light inks sit only on the dark Next chip and the primary button, both ink-coloured.
      const onWhite = contrastRatio(ink, '#ffffff');
      const onTint = contrastRatio(ink, '#e3eddc');
      if (onWhite < 4.5) continue;
      expect(onTint, `${ink} on the chip tint`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
