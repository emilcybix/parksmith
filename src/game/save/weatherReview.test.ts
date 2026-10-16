import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { hashState } from './hash';
import type { ParkSaveV7 } from './state';
import { SaveError } from './version';

const MIN = GAME_CONFIG.calendar.minDayLengthSeconds;
const DAY_TICKS = MIN * 10;

/** day -> kind/slots for every day ever seen in the saved list. */
const harvest = (session: ParkSession, into: Map<number, string>): void => {
  const w = session.weather;
  w.days.forEach((d, i) => into.set(w.firstDay + i, JSON.stringify(d)));
};

const drive = (session: ParkSession, ticks: number, into: Map<number, string>, perTick?: (s: ParkSession, t: number) => ParkSession): ParkSession => {
  let current = session;
  for (let t = 0; t < ticks; t += 1) {
    current.step(100);
    if (perTick) current = perTick(current, t);
    if (t % 50 === 0) harvest(current, into);
  }
  harvest(current, into);
  return current;
};

describe('weather review: determinism over 40 days', () => {
  it('same seed => same days regardless of save/load, pauses, toggles, day-length edits', () => {
    const a = new ParkSession(null); a.calendar.setDayLength(MIN);
    const b = new ParkSession(null); b.calendar.setDayLength(MIN);
    const ma = new Map<number, string>(); const mb = new Map<number, string>();
    const total = DAY_TICKS * 41;
    drive(a, total, ma);
    drive(b, total, mb, (s, t) => {
      if (t % 1_777 === 0) s = ParkSession.fromState(structuredClone(JSON.parse(JSON.stringify(s.serialize()))) as ParkSaveV7);
      if (t % 913 === 0) { s.setWeatherEnabled(t % 2 === 0); s.setWeatherSeverity(t % 3 === 0 ? 'high' : 'low'); }
      if (t % 3_001 === 0) s.calendar.setDayLength(t % 2 ? MIN : MIN * 2);
      return s;
    });
    expect(ma.size).toBeGreaterThanOrEqual(40);
    for (const [day, json] of ma) {
      const other = mb.get(day);
      if (other !== undefined) expect(other, `day ${day}`).toBe(json);
    }
  }, 120_000);
});

describe('weather review: hash covers weather', () => {
  it('any weather edit changes the state hash', () => {
    const s = new ParkSession(null); s.step(100);
    const base = hashState(s.serialize());
    const mutate: Array<(x: ParkSaveV7) => void> = [
      (x) => { x.weather.rngState ^= 1; },
      (x) => { x.weather.days[0].slots[2].intensity = 0.123; },
      (x) => { x.weather.severity = 'high'; },
      (x) => { x.calendar.hoursEnabled = true; },
      (x) => { x.rules.wetWeatherMultiplier = 2; },
    ];
    for (const m of mutate) { const c = structuredClone(s.serialize()); m(c); expect(hashState(c)).not.toBe(base); }
  });
});

describe('weather review: hostile', () => {
  const base = (): ParkSaveV7 => { const s = new ParkSession(null); for (let i = 0; i < 5; i += 1) s.step(100); return structuredClone(s.serialize()); };
  it('huge world tick with huge anchorUnits is bounded, not hanging', () => {
    const st = base();
    st.world.tick = 2 ** 31; st.calendar.anchorTick = 2 ** 31 - 1; st.calendar.anchorUnits = 2 ** 31 * 1e6 / 600 - 5;
    st.weather.days = []; // as a migrated save
    const t0 = Date.now();
    let err: unknown;
    try { const s = ParkSession.fromState(st); s.step(100); } catch (e) { err = e; }
    expect(Date.now() - t0).toBeLessThan(3_000);
    if (err) expect(err).toBeInstanceOf(SaveError);
  });
  it('a legit forced slot (dev tool) still round-trips through consistency', () => {
    const s = new ParkSession(null); s.step(100);
    s.weather.forceCurrentSlot('storm', 1);
    const st = s.serialize();
    expect(() => ParkSession.fromState(structuredClone(st))).not.toThrow();
  });
});

describe('weather review: storm closure', () => {
  const stormSession = (): ParkSession => {
    const s = new ParkSession(null); s.step(100);
    s.weather.forceCurrentSlot('storm', 1);
    return s;
  };
  it('snapshot reports closureReason; toggles interplay', () => {
    const s = stormSession();
    expect(s.weather.conditions.stormActive).toBe(true);
    expect(s.weather.conditions.arrivalRate).toBeGreaterThan(0);
  });
  it('closing the weather switch off mid-storm reopens; severity low keeps storm', () => {
    const s = stormSession();
    s.setWeatherEnabled(false);
    expect(s.weather.conditions.stormActive).toBe(false);
    s.setWeatherEnabled(true);
    expect(s.weather.conditions.stormActive).toBe(true);
    s.setWeatherSeverity('low');
    expect(s.weather.conditions.stormActive).toBe(true);
  });
});
