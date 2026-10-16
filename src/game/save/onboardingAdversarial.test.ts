import { describe, expect, it } from 'vitest';
import { ParkSession } from '../session/ParkSession';
import { OnboardingTracker } from '../onboarding/OnboardingTracker';
import { hashState } from './hash';
import { createParkSave } from './version';
import { migrateSave } from './migrate';

const base = () => new ParkSession(null).serialize().onboarding!;
const rejects = (mutate: (s: ReturnType<typeof base>) => unknown) => {
  const s = base() as unknown as Record<string, unknown>;
  const m = mutate(s as never);
  expect(() => new OnboardingTracker().restore((m ?? s) as never)).toThrow();
};

describe('onboarding adversarial', () => {
  it('rejects corrupt tracker state', () => {
    rejects((s) => { (s as any).completed = [{ id: 'lay-path', tick: NaN, evidence: 1 }]; });
    rejects((s) => { (s as any).completed = [{ id: 'lay-path', tick: 1.5, evidence: 1 }]; });
    rejects((s) => { (s as any).completed = [{ id: 'lay-path', tick: -1, evidence: 1 }]; });
    rejects((s) => { (s as any).completed = [{ id: 'lay-path', tick: 1, evidence: Infinity }]; });
    rejects((s) => { (s as any).completed = [{ id: '__proto__', tick: 1, evidence: 1 }]; });
    rejects((s) => { (s as any).completed = [{ id: 'constructor', tick: 1, evidence: 1 }]; });
    rejects((s) => { (s as any).skipped = ['toString']; });
    rejects((s) => { (s as any).completed = new Array(1e7); });
    rejects((s) => { (s as any).skipped = new Array(1e7).fill('lay-path'); });
    expect(() => new OnboardingTracker().restore(null as never)).toThrow();
    expect(() => new OnboardingTracker().restore([] as never)).toThrow();
  });
  it('a failed restore leaves the tracker untouched', () => {
    const t = new OnboardingTracker();
    t.dismissAll();
    const before = JSON.stringify(t.serialize());
    expect(() => t.restore({ dismissed: false, completed: [], skipped: ['nope' as never], sawLitter: true })).toThrow();
    expect(JSON.stringify(t.serialize())).toBe(before);
  });
  it('save with future completion tick is rejected by fromState', () => {
    const s = new ParkSession(null);
    const st = s.serialize();
    st.onboarding!.completed = [{ id: 'lay-path', tick: st.world.tick + 10, evidence: 6 }];
    expect(() => ParkSession.fromState(st)).toThrow();
  });
  it('sandbox with onboarding null and scenario with onboarding are rejected', () => {
    const st = new ParkSession(null).serialize();
    expect(() => ParkSession.fromState({ ...st, onboarding: null })).toThrow();
    const rest: Record<string, unknown> = { ...st };
    delete rest.onboarding;
    expect(() => ParkSession.fromState(rest as never)).toThrow();
  });
  it('migration tolerates malformed state without hanging', () => {
    const save = createParkSave(new ParkSession(null).serialize(), { clock: { tick: 0 } } as never, 0);
    for (const state of [null, 5, [], 'x']) {
      let threw = false;
      try { migrateSave({ ...save, schemaVersion: 1, state }); } catch { threw = true; }
      expect(threw).toBe(true);
    }
  });
  it('hash round-trips through restore with progress in the ledger', () => {
    const s = new ParkSession(null);
    for (let i = 0; i < 40; i += 1) s.step(100);
    s.onboarding!.skipStep('first-ride');
    const a = s.serialize();
    const b = ParkSession.fromState(JSON.parse(JSON.stringify(a))).serialize();
    expect(hashState(b)).toBe(hashState(a));
  });
});
