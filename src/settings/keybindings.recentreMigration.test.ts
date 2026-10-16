import { describe, expect, it } from 'vitest';
import { KEY_ACTION_BY_ID, resolveKeyAction, validateKeybindings } from './keybindings';

/**
 * Phase 11 (PA-021): V became a default (recentre view). A player who bound another action to V
 * before the update must not silently lose that binding when their stored settings load: the
 * player's binding wins and the recentre action loads unbound (null), visible in the panel. This is
 * the Phase 26 Q/E pattern (`keybindings.viewRotationMigration.test.ts`).
 */
describe('stored overrides on the new V default', () => {
  it('ships recentre on V in the view scope, yielding to stored bindings', () => {
    const def = KEY_ACTION_BY_ID.get('recentreView');
    expect(def).toMatchObject({
      label: 'Recentre view',
      description: 'Move the camera back to the park entrance.',
      group: 'view',
      scope: 'view',
      defaultKey: 'k:v',
      match: 'auto',
      yieldsDefault: true,
    });
    expect(resolveKeyAction({ key: 'v', code: 'KeyV' }, () => true, {})).toBe('recentreView');
  });

  it('keeps a pre-Phase-11 override of peek on V and unbinds recentre', () => {
    expect(validateKeybindings({ peek: 'k:v' })).toEqual({ peek: 'k:v', recentreView: null });
  });

  it('keeps a pre-Phase-11 override of the bulldozer on V and unbinds recentre', () => {
    expect(validateKeybindings({ bulldozer: 'k:v' })).toEqual({ bulldozer: 'k:v', recentreView: null });
  });

  it('a designer-only binding on V also wins: the designer scope overlaps the view scope', () => {
    expect(validateKeybindings({ coasterLower: 'k:v' })).toEqual({ coasterLower: 'k:v', recentreView: null });
  });

  it('a player who rebound recentre keeps that choice, and a stored null survives', () => {
    expect(validateKeybindings({ recentreView: 'k:z' })).toEqual({ recentreView: 'k:z' });
    expect(validateKeybindings({ recentreView: 'k:z', bulldozer: 'k:v' })).toEqual({ recentreView: 'k:z', bulldozer: 'k:v' });
    expect(validateKeybindings({ recentreView: null })).toEqual({ recentreView: null });
    expect(validateKeybindings({ bulldozer: 'k:n' })).toEqual({ bulldozer: 'k:n' });
  });
});
