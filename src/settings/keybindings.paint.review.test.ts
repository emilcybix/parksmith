import { describe, expect, it } from 'vitest';
import { KEY_ACTIONS, validateKeybindings } from './keybindings';

/** Phase 28 step 2 review: the C / I defaults yield to an older binding however it was stored. */
describe('review: paint defaults yield to a stored binding on the same physical key', () => {
  it('a physical-code token (c:KeyC) on another tool is kept and does not unbind the paint letter default: k: and c: only clash with a known layout (documented policy; a c: token on an auto action only comes from a non-Latin layout, where k:c never fires)', () => {
    expect(validateKeybindings({ pathTool: 'c:KeyC' })).toEqual({ pathTool: 'c:KeyC' });
  });

  it('a letter token on another tool in an overlapping scope unbinds the paint default instead of being dropped', () => {
    expect(validateKeybindings({ pathTool: 'k:c' })).toEqual({ pathTool: 'k:c', paintTool: null });
    expect(validateKeybindings({ rotate: 'k:i' })).toEqual({ rotate: 'k:i', eyedropper: null });
    expect(validateKeybindings({ peek: 'k:c' }), 'peek is a build-scope hold key: it overlaps too').toEqual({ peek: 'k:c', paintTool: null });
  });

  it('a stored designer-only binding on C does not take C from the paint tool (scopes do not overlap)', () => {
    const result = validateKeybindings({ coasterRaise: 'k:c' });
    expect(result).toEqual({ coasterRaise: 'k:c' });
  });

  it('swapping paint and bulldozer keys is kept; paint and eyedropper on one key is not', () => {
    expect(validateKeybindings({ paintTool: 'k:b', bulldozer: 'k:c' })).toEqual({ paintTool: 'k:b', bulldozer: 'k:c' });
    const clash = validateKeybindings({ paintTool: 'k:j', eyedropper: 'k:j' });
    expect(Object.values(clash).filter((token) => token === 'k:j')).toHaveLength(1);
  });

  it('the paint actions are build-not-designer tools, like the bulldozer', () => {
    for (const id of ['paintTool', 'eyedropper'] as const) {
      const def = KEY_ACTIONS.find((entry) => entry.id === id)!;
      expect(def.scope).toBe('build-not-designer');
      expect(def.group).toBe('tools');
    }
  });
});
