import { describe, expect, it } from 'vitest';
import { validateKeybindings } from './keybindings';

/**
 * Phase 26 review: Q and E became defaults (rotate view). A player who bound another action to Q or
 * E before the update must not silently lose that binding when their stored settings load: the
 * player's binding wins and the new rotate action loads unbound (null), visible in the panel.
 */
describe('stored overrides on the new Q/E defaults', () => {
  it('keeps a pre-Phase-26 override of the bulldozer on Q and unbinds rotate left', () => {
    expect(validateKeybindings({ bulldozer: 'k:q' })).toEqual({ bulldozer: 'k:q', rotateViewLeft: null });
  });

  it('keeps a pre-Phase-26 override of the grid toggle on E and unbinds rotate right', () => {
    expect(validateKeybindings({ toggleGrid: 'k:e' })).toEqual({ toggleGrid: 'k:e', rotateViewRight: null });
  });

  it('a player who rebound rotate themselves keeps that choice; the clash rule still applies', () => {
    expect(validateKeybindings({ rotateViewLeft: 'k:z' })).toEqual({ rotateViewLeft: 'k:z' });
    // rotateViewLeft stored on Q-free key, bulldozer on Q: both survive, nothing unbound.
    expect(validateKeybindings({ rotateViewLeft: 'k:z', bulldozer: 'k:q' })).toEqual({ rotateViewLeft: 'k:z', bulldozer: 'k:q' });
  });

  it('a stored null for the new action survives untouched, and no clash leaves defaults alone', () => {
    expect(validateKeybindings({ rotateViewRight: null })).toEqual({ rotateViewRight: null });
    expect(validateKeybindings({ bulldozer: 'k:n' })).toEqual({ bulldozer: 'k:n' });
  });

  it('a designer-only binding on Q also wins: the designer scope overlaps the view scope', () => {
    expect(validateKeybindings({ coasterLower: 'k:q' })).toEqual({ coasterLower: 'k:q', rotateViewLeft: null });
  });
});
