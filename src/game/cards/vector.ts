import { MULTIPLIER_DIRECTION, type CardModifiableRule, type CardModifiers } from '../scenarios/rules';
import type { EffectAxis, EffectVector } from './types';

/**
 * The effect vector of a card and the no-strictly-better relation (Phase 25, design 1.5). Positive = good for the player
 * on every axis. A stage card's vector is derived from its modifiers in log space (the compile multiplies per rule, so
 * logs add); a one-shot's is authored in the table. Kind, rarity, slot cost and tags are never axes.
 */
/** What a vector is computed from: a stage card's modifiers or a one-shot's authored vector (a row or a definition). */
export type VectorSource = { kind: 'stage'; modifiers: CardModifiers } | { kind: 'one-shot'; vector: EffectVector };

export const effectVectorOf = (card: VectorSource): EffectVector => {
  if (card.kind === 'one-shot') return { ...card.vector };
  const vector: EffectVector = {};
  for (const [rule, value] of Object.entries(card.modifiers) as Array<[CardModifiableRule, number]>) {
    if (value === 1) continue;
    const log = Math.log(value);
    vector[rule] = MULTIPLIER_DIRECTION[rule] === 'higherIsBetter' ? log : -log;
  }
  return vector;
};

/** `a` dominates `b`: at least as good on every axis of either, strictly better on one. */
export const dominates = (a: EffectVector, b: EffectVector): boolean => {
  const axes = new Set<EffectAxis>([...Object.keys(a), ...Object.keys(b)] as EffectAxis[]);
  let strictly = false;
  for (const axis of axes) {
    const left = a[axis] ?? 0;
    const right = b[axis] ?? 0;
    if (left < right) return false;
    if (left > right) strictly = true;
  }
  return strictly;
};

/** The axes of a vector that help (> 0) and hurt (< 0) the player. */
export const upsideAxesOf = (vector: EffectVector): EffectAxis[] => (Object.keys(vector) as EffectAxis[]).filter((axis) => (vector[axis] ?? 0) > 0);
export const downsideAxesOf = (vector: EffectVector): EffectAxis[] => (Object.keys(vector) as EffectAxis[]).filter((axis) => (vector[axis] ?? 0) < 0);
