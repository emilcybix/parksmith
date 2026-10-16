import { describe, expect, it } from 'vitest';
import { KEY_ACTIONS, resolveKeyAction, validateKeybindings } from './keybindings';

/**
 * Phase 28 step 2: C (paint tool) and I (colour picker) became defaults. A player who bound another action to
 * C or I before the update keeps it: the new action loads unbound (null) instead of the old binding being
 * dropped. The registry has no other letter clash.
 */
describe('stored overrides on the new C and I defaults', () => {
  it('keeps an older binding of the bulldozer on C and unbinds the paint tool', () => {
    expect(validateKeybindings({ bulldozer: 'k:c' })).toEqual({ bulldozer: 'k:c', paintTool: null });
  });

  it('keeps an older binding of the grid toggle on I and unbinds the colour picker', () => {
    expect(validateKeybindings({ toggleGrid: 'k:i' })).toEqual({ toggleGrid: 'k:i', eyedropper: null });
  });

  it('a player who moved the new actions keeps that choice, and a stored null survives', () => {
    expect(validateKeybindings({ paintTool: 'k:z', eyedropper: null })).toEqual({ paintTool: 'k:z', eyedropper: null });
  });

  it('with no stored bindings the defaults are C and I, free of every other default key', () => {
    expect(validateKeybindings({})).toEqual({});
    const others = KEY_ACTIONS.filter((def) => def.id !== 'paintTool' && def.id !== 'eyedropper').map((def) => def.defaultKey);
    expect(others).not.toContain('k:c');
    expect(others).not.toContain('k:i');
  });

  it('resolves C and I to the paint actions in the world and the build contexts, not in the coaster designer', () => {
    const world = (scope: string): boolean => scope === 'view' || scope === 'build' || scope === 'build-not-designer';
    const designer = (scope: string): boolean => scope === 'view' || scope === 'build' || scope === 'designer';
    const event = (key: string, code: string) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false });
    expect(resolveKeyAction(event('c', 'KeyC'), world, {})).toBe('paintTool');
    expect(resolveKeyAction(event('i', 'KeyI'), world, {})).toBe('eyedropper');
    expect(resolveKeyAction(event('c', 'KeyC'), designer, {})).toBeNull();
    expect(resolveKeyAction(event('i', 'KeyI'), designer, {})).toBeNull();
  });
});
