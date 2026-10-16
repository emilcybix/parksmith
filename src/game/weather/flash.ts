import { GAME_CONFIG } from '../config';
import { hash32 } from './random';

/**
 * Storm flash timing as pure data (step 3 draws it). Time inside a storm slot is cut into cells of
 * `flash.slotSeconds`; cell `n` holds a flash when `hash(flashSeed, n) / 2^32 < chancePerSlot`, at
 * an offset inside the cell given by a second hash. A flash is a main burst that fades over
 * `durationSeconds`, then a weaker flicker after a short gap. The same seed and time give the same
 * answer, so a paused game freezes the sky and a replay shows the same lightning.
 */

export interface StormFlash {
  /** 0..1 brightness of the flash right now. */
  strength: number;
  /** uint32 to seed the bolt shape; 0 when there is no flash. */
  boltSeed: number;
}

export const createStormFlash = (): StormFlash => ({ strength: 0, boltSeed: 0 });

/** Fills `out` (allocation-free) and returns it. */
export const stormFlashAt = (flashSeed: number, secondsIntoSegment: number, out: StormFlash = createStormFlash()): StormFlash => {
  out.strength = 0;
  out.boltSeed = 0;
  if (flashSeed === 0 || !Number.isFinite(secondsIntoSegment) || secondsIntoSegment < 0) return out;
  const { slotSeconds, chancePerSlot, durationSeconds, flickerGapSeconds, flickerStrength } = GAME_CONFIG.weather.flash;
  const cell = Math.floor(secondsIntoSegment / slotSeconds);
  if (hash32(flashSeed, cell) / 4294967296 >= chancePerSlot) return out;
  const flickerSeconds = durationSeconds / 2;
  const span = durationSeconds + flickerGapSeconds + flickerSeconds;
  const offset = hash32(flashSeed, cell, 1) / 4294967296 * (slotSeconds - span);
  const local = secondsIntoSegment - cell * slotSeconds - offset;
  if (local < 0 || local >= span) return out;
  if (local < durationSeconds) out.strength = 1 - local / durationSeconds;
  else if (local >= durationSeconds + flickerGapSeconds) {
    out.strength = flickerStrength * (1 - (local - durationSeconds - flickerGapSeconds) / flickerSeconds);
  } else return out;
  out.boltSeed = hash32(flashSeed, cell, 2) || 1;
  return out;
};
