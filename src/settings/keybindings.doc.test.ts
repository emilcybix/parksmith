import { describe, expect, it } from 'vitest';
import { KEY_ACTIONS, renderKeybindingsMarkdown } from './keybindings';

const docs = import.meta.glob('../../KEYBINDINGS.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const onDisk = Object.values(docs)[0] ?? '';

const updateRequested = (): boolean => (
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_KEYBINDINGS_DOC === '1'
);

describe('KEYBINDINGS.md', () => {
  it('is generated from the registry and not stale', async () => {
    const rendered = renderKeybindingsMarkdown();
    if (updateRequested()) {
      // Resolved at run time so the browser type-check does not need the Node typings.
      const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { writeFileSync(path: URL, text: string): void };
      fs.writeFileSync(new URL('../../KEYBINDINGS.md', import.meta.url), rendered);
      return;
    }
    expect(
      onDisk === rendered,
      'KEYBINDINGS.md is stale: run UPDATE_KEYBINDINGS_DOC=1 npx vitest run src/settings/keybindings.doc.test.ts to regenerate',
    ).toBe(true);
  });

  it('mentions every action and the Esc rule', () => {
    const rendered = renderKeybindingsMarkdown();
    for (const def of KEY_ACTIONS) expect(rendered).toContain(def.label);
    expect(rendered).toContain('Esc always gets you out');
  });
});
