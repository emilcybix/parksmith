import { describe, expect, it } from 'vitest';
import { KEY_ACTION_BY_ID, resolveKeyAction, validateKeybindings } from './keybindings';
import { muteToastText, nextMuteStep } from './muteToggle';

/**
 * Phase 35: two new defaults, T (crowd heatmap) and M (mute). A player who bound another action to either before the
 * update keeps that binding and the new action loads unbound, the Phase 26 Q/E pattern.
 */
describe('Phase 35 key defaults', () => {
  it('ships the crowd heatmap on T and mute on M, in the park view, yielding to stored bindings', () => {
    expect(KEY_ACTION_BY_ID.get('toggleCrowdHeatmap')).toMatchObject({ label: 'Crowd heatmap', group: 'view', scope: 'view', defaultKey: 'k:t', yieldsDefault: true });
    expect(KEY_ACTION_BY_ID.get('toggleMute')).toMatchObject({ label: 'Mute sound', group: 'sound', scope: 'view', defaultKey: 'k:m', yieldsDefault: true });
    expect(resolveKeyAction({ key: 't', code: 'KeyT' }, () => true, {})).toBe('toggleCrowdHeatmap');
    expect(resolveKeyAction({ key: 'm', code: 'KeyM' }, () => true, {})).toBe('toggleMute');
    // Letters follow the typed character: on AZERTY the M key sits where QWERTY has the semicolon.
    expect(resolveKeyAction({ key: 'm', code: 'Semicolon' }, () => true, {})).toBe('toggleMute');
  });

  it('an older binding on T or M wins and the new action loads unbound', () => {
    expect(validateKeybindings({ bulldozer: 'k:t' })).toEqual({ bulldozer: 'k:t', toggleCrowdHeatmap: null });
    expect(validateKeybindings({ peek: 'k:m' })).toEqual({ peek: 'k:m', toggleMute: null });
    expect(validateKeybindings({ coasterLower: 'k:m' })).toEqual({ coasterLower: 'k:m', toggleMute: null });
  });

  it('a rebound or unbound new action keeps the player choice', () => {
    expect(validateKeybindings({ toggleMute: 'k:u' })).toEqual({ toggleMute: 'k:u' });
    expect(validateKeybindings({ toggleCrowdHeatmap: null })).toEqual({ toggleCrowdHeatmap: null });
  });
});

describe('the mute step', () => {
  it('mutes to 0 and remembers the level, then brings it back', () => {
    const muted = nextMuteStep(40, null);
    expect(muted).toEqual({ masterVolume: 0, remembered: 40, muted: true });
    expect(nextMuteStep(0, muted.remembered)).toEqual({ masterVolume: 40, remembered: null, muted: false });
  });

  it('unmuting with nothing remembered (slider at 0, or after a reload) brings back the default level', () => {
    expect(nextMuteStep(0, null)).toEqual({ masterVolume: 70, remembered: null, muted: false });
    expect(nextMuteStep(0, 0)).toEqual({ masterVolume: 70, remembered: null, muted: false });
  });

  it('the toast names the state', () => {
    expect(muteToastText(nextMuteStep(70, null), 'M')).toBe('Sound muted · M to unmute');
    expect(muteToastText(nextMuteStep(70, null), null)).toBe('Sound muted');
    expect(muteToastText(nextMuteStep(0, 30), null)).toBe('Sound on · Master 30 %');
  });
});
