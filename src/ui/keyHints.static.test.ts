import { describe, expect, it } from 'vitest';

const sources = import.meta.glob(['./*.tsx', '!./*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * A tooltip that spells out a rebindable key as a literal goes stale the moment the player rebinds
 * it. Hints must come from the registry (withKeyHint / keyLabel / helpHintItems). Fixed keys (Esc,
 * Ctrl+S) may stay literal.
 */
describe('key hints are derived from the keybinding registry', () => {
  it('no component spells a rebindable single key in a title or label literal', () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const match of text.matchAll(/(?:title|aria-label)="[^"]*\(([A-Za-z0-9])\)[^"]*"/g)) offenders.push(`${file}: ${match[0]}`);
      for (const match of text.matchAll(/(?:title|aria-label)=\{`[^`]*\(([A-Za-z0-9])\)[^`]*`\}/g)) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the help hint has no literal key phrases', () => {
    const hud = Object.entries(sources).find(([file]) => file.endsWith('Hud.tsx'))?.[1] ?? '';
    expect(hud).not.toMatch(/R to rotate|Hold X|WASD to pan/);
    expect(hud).toContain('helpHintItems');
  });
});
