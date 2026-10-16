import { describe, expect, it } from 'vitest';
import type { RecoveryFailure, RecoveryFailureCode, RecoveryOffer, RecoverySnapshot } from '../app/saves/recoveryTypes';
import {
  describeRecoveryButtons,
  describeRecoveryFailure,
  describeRecoveryOffer,
  planRecoveryResume,
  recoveryBanner,
  recoveryFailureOffersSaveDialog,
  visibleRecoveryBanner,
} from './recoveryModel';

const NOW = 1_800_000_000_000;

const offer: RecoveryOffer = {
  interruptedSessionIds: ['tab-a'],
  sessionId: 'tab-a',
  parkName: 'Garden Gate',
  scenarioId: null,
  startedAt: NOW - 3_600_000,
  lastSeenAt: NOW - 200_000,
  autosave: {
    name: 'Garden Gate',
    scenarioName: 'Garden Gate',
    savedAt: NOW - 5 * 60_000,
    playtimeSeconds: 725,
    guestCount: 1234,
    cash: 45_210.4,
    rating: 812.6,
    revision: 7,
  },
  evidence: 'lock-free',
};

const snapshot = (overrides: Partial<RecoverySnapshot>): RecoverySnapshot => ({ phase: 'idle', offer: null, error: null, notice: null, ...overrides });

describe('describeRecoveryOffer', () => {
  it('names the park, the age and the autosave numbers without alarm', () => {
    const model = describeRecoveryOffer(offer, NOW);
    expect(model.summary).toBe('Parksmith closed unexpectedly while you were playing Garden Gate. Your last autosave was saved 5 min ago.');
    expect(model.stats).toEqual([
      { label: 'Park time', value: '12m 05s' },
      { label: 'Guests', value: '1,234' },
      { label: 'Cash', value: '$45,210' },
      { label: 'Rating', value: '813' },
    ]);
    expect(model.reassurance, 'the player must be told Not now deletes nothing').toContain('Recovered autosave');
    expect(model.reassurance).toContain('Nothing is deleted');
  });

  it('falls back to neutral words for a blank park name and an unknown time', () => {
    const model = describeRecoveryOffer({ ...offer, parkName: '  ', autosave: { ...offer.autosave, savedAt: 0 } }, NOW);
    expect(model.summary).toContain('playing your park.');
    expect(model.summary).toContain('Your last autosave is ready.');
  });
});

describe('describeRecoveryButtons', () => {
  it('enables both buttons while the prompt waits for the player', () => {
    expect(describeRecoveryButtons('offered')).toEqual({ resumeLabel: 'Resume autosave', notNowLabel: 'Not now', disabled: false });
  });

  it('locks both buttons while either command is in flight and says which', () => {
    expect(describeRecoveryButtons('resuming')).toMatchObject({ resumeLabel: 'Resuming…', disabled: true });
    expect(describeRecoveryButtons('dismissing')).toMatchObject({ notNowLabel: 'Keeping…', disabled: true });
  });
});

describe('planRecoveryResume', () => {
  it('asks only when the live park has unsaved changes', () => {
    expect(planRecoveryResume(false)).toBe('resume-now');
    expect(planRecoveryResume(true)).toBe('confirm-replace');
  });
});

describe('describeRecoveryFailure', () => {
  const codes: RecoveryFailureCode[] = ['no-offer', 'changed', 'no-free-slot', 'unreadable', 'not-found', 'busy', 'store'];

  it('has plain words for every failure code, never the raw message', () => {
    for (const code of codes) {
      const error: RecoveryFailure = { code, message: 'DOMException: internal' };
      const text = describeRecoveryFailure(error);
      expect(text.length, `${code} has words`).toBeGreaterThan(10);
      expect(text, `${code} hides internals`).not.toContain('DOMException');
    }
  });

  it('explains the full-slots case and offers the dialog only for it', () => {
    const error: RecoveryFailure = { code: 'no-free-slot', message: '' };
    expect(describeRecoveryFailure(error)).toContain('All ten save slots are full');
    expect(recoveryFailureOffersSaveDialog(error)).toBe(true);
    expect(recoveryFailureOffersSaveDialog({ code: 'busy', message: '' })).toBe(false);
    expect(recoveryFailureOffersSaveDialog(null)).toBe(false);
  });
});

describe('recoveryBanner', () => {
  it('shows nothing while checking or while the prompt carries the news', () => {
    expect(recoveryBanner(snapshot({ phase: 'checking', notice: { id: 1, text: 'x' } }))).toBeNull();
    expect(recoveryBanner(snapshot({ phase: 'offered', offer, error: { code: 'busy', message: '' } }))).toBeNull();
  });

  it('shows the controller notice once resolved, keyed by its id', () => {
    const banner = recoveryBanner(snapshot({ notice: { id: 4, text: 'Parksmith closed unexpectedly. There was no autosave to resume.' } }));
    expect(banner).toEqual({ key: 'notice:4', text: 'Parksmith closed unexpectedly. There was no autosave to resume.' });
  });

  it('turns an error left on an idle controller (a withdrawn offer) into a banner', () => {
    const banner = recoveryBanner(snapshot({ error: { code: 'changed', message: '' } }));
    expect(banner?.key).toBe('error:changed');
    expect(banner?.text).toContain('Another Parksmith tab');
  });

  it('is null when there is nothing to say, and hides a dismissed banner but not the next one', () => {
    expect(recoveryBanner(snapshot({}))).toBeNull();
    const first = snapshot({ notice: { id: 1, text: 'one' } });
    expect(visibleRecoveryBanner(first, 'notice:1')).toBeNull();
    expect(visibleRecoveryBanner(snapshot({ notice: { id: 2, text: 'two' } }), 'notice:1')?.text).toBe('two');
  });
});

describe('recovery text by game mode (Phase 22)', () => {
  const summaryOf = (over: Partial<RecoveryOffer>): string => describeRecoveryOffer({ ...offer, ...over }, NOW).summary;

  it('names the mode of the interrupted park', () => {
    expect(summaryOf({ mode: 'sandbox', parkName: 'Sandbox park' })).toContain('while you were playing your Sandbox park. Your last autosave');
    expect(summaryOf({ mode: 'scenario', parkName: 'Penny Lane' })).toContain('while you were playing the Scenario Penny Lane. Your last autosave');
    expect(summaryOf({ mode: 'run', parkName: 'Garden Gala' })).toContain('while you were playing Garden Gala on The Map. Your last autosave');
  });

  it('keeps today\'s text for a marker without a mode or with a hostile one', () => {
    expect(summaryOf({ mode: undefined })).toContain('while you were playing Garden Gate.');
    expect(summaryOf({ mode: 'weird' as never })).toContain('while you were playing Garden Gate.');
  });

  it('falls back to "your park" for a blank name in every mode', () => {
    expect(summaryOf({ mode: 'scenario', parkName: ' ' })).toContain('the Scenario your park');
  });
});

describe('an offer of the previous autosave generation (Phase 31)', () => {
  it('says the last autosave could not be read and names the one it offers', () => {
    const previous: RecoveryOffer = { ...offer, autosave: { ...offer.autosave, name: 'Autosave', slotId: 'autosave-previous' } };
    const model = describeRecoveryOffer(previous, NOW);
    expect(model.summary).toContain('The last autosave could not be read, but the one before it was saved 5 min ago.');
    expect(model.autosaveName).toBe('Previous autosave');
    expect(describeRecoveryOffer({ ...offer, autosave: { ...offer.autosave, name: 'Autosave' } }, NOW).autosaveName, 'the current one keeps its name').toBe('Autosave');
  });
});
