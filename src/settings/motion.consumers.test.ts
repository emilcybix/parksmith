import { describe, expect, it } from 'vitest';

const sources = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * styles.css is covered separately once the UI layer moves its two `@media (prefers-reduced-motion)`
 * blocks to `:root[data-motion="reduce"]` (the panel step); this scan is for scripts.
 */
describe('reduced motion has a single source of truth', () => {
  it('only the settings environment asks the OS; nothing else reads prefers-reduced-motion', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /prefers-reduced-motion/.test(text))
      .map(([file]) => file)
      .filter((file) => file !== './settingsStore.ts');
    expect(offenders).toEqual([]);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });
});
