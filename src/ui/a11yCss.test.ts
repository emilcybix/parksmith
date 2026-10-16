import { describe, expect, it } from 'vitest';
import { contrastRatio } from './a11yModel';

// Vitest stubs CSS imports, so the stylesheets are read from disk (no @types/node in this project).
const nodeFs = (globalThis as unknown as { process: { getBuiltinModule(id: string): { readFileSync(path: string, enc: string): string } } })
  .process.getBuiltinModule('node:fs');
const read = (relative: string): string => nodeFs.readFileSync(new URL(relative, import.meta.url).pathname, 'utf8');
const tsxSources = import.meta.glob(['./*.tsx', '!./*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const a11yCss = stripComments(read('./a11y.css'));
const stylesCss = stripComments(read('./styles.css'));
const mainSource = read('../main.tsx');

/** The darkest paper tint small print sits on (checked against the audit's measured backgrounds). */
const DARKEST_PAPER = '#e6eee1';

describe('a11y.css: loading', () => {
  it('is imported once, after styles.css, from main.tsx', () => {
    const imports = Object.entries(tsxSources).filter(([, text]) => /import\s+'\.\/a11y\.css'/.test(text));
    expect(imports).toEqual([]);
    const stylesAt = mainSource.indexOf("'./ui/styles.css'");
    const a11yAt = mainSource.indexOf("'./ui/a11y.css'");
    expect(stylesAt).toBeGreaterThan(-1);
    expect(a11yAt).toBeGreaterThan(stylesAt);
  });
});

describe('a11y.css: focus ring', () => {
  const token = (name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{3,6})`, 'i').exec(a11yCss)?.[1] ?? '';
  it('the ring colours clear 3:1 (WCAG 1.4.11) against the cream paper and the white halo', () => {
    const ring = token('--focus-ring');
    const halo = token('--focus-halo');
    expect(contrastRatio(ring, '#fffaf0')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ring, '#e6eee1')).toBeGreaterThanOrEqual(3);
    // On a dark surface the cream halo is what is seen.
    expect(contrastRatio(halo, ring)).toBeGreaterThanOrEqual(3);
  });
  it('is at least 2px wide', () => {
    expect(Number(/--focus-width:\s*(\d+)px/.exec(a11yCss)?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
  });
});

describe('a11y.css: muted text overrides', () => {
  const rules = [...a11yCss.matchAll(/([^{}]+)\{\s*color:\s*(#[0-9a-f]{6});?\s*\}/gi)].map((match) => ({ selector: match[1].trim(), colour: match[2] }));
  it('has the generated block', () => {
    expect(rules.length).toBeGreaterThan(50);
  });
  it.each(rules.map((rule) => [rule.selector, rule.colour]))('%s (%s) is AA on the darkest paper tint', (_selector, colour) => {
    expect(contrastRatio(colour, DARKEST_PAPER)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('stylesheets never remove a focus indicator without drawing another', () => {
  // These controls draw their own ring (white gap + band) and are measured by the audit.
  const OWN_RING = /(\.menu-entry|\.menu-back|\.settings-seg input|\.settings-switch input|\.run-node)/;
  const offenders: string[] = [];
  for (const [name, css] of [['styles.css', stylesCss], ['a11y.css', a11yCss]] as const) {
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      const body = match[2];
      if (!/outline:\s*(none|0)\b/.test(body)) continue;
      if (!/:focus/.test(selector)) continue;
      if (OWN_RING.test(selector)) continue;
      if (/box-shadow:\s*[^;]*0 0 0/.test(body)) continue;
      if (/\[tabindex="-1"\]/.test(selector)) continue;
      offenders.push(`${name}: ${selector}`);
    }
  }
  it('every `outline: none` on a focus selector has a replacement', () => {
    expect(offenders).toEqual([]);
  });
});

describe('styles.css: Phase 30 complaint links (review fixes)', () => {
  it("the Pulse's yellow glyph rule does not reach the link's arrow, which keeps the link's ink", () => {
    expect(stylesCss).toMatch(/\.pulse-card p \.pulse-link span \{ color: inherit; \}/);
  });

  it("the dashboard's insight link clears 4.5:1 on white and on the darkest paper", () => {
    const colour = /\.dashboard-insights \.insight-link \{[^}]*?color: (#[0-9a-f]{6})/i.exec(stylesCss)?.[1] ?? '';
    expect(colour).not.toBe('');
    expect(contrastRatio(colour, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colour, DARKEST_PAPER)).toBeGreaterThanOrEqual(4.5);
  });
});
