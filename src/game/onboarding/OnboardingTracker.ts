import { plainNumber } from '../save/plainData';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_COUNTER, requireNumberInRange } from '../save/ranges';
import type { OnboardingCompletionState, OnboardingState, Serializable } from '../save/state';
import { SaveError, invalidState } from '../save/version';
import { ONBOARDING_STEPS, ONBOARDING_STEP_BY_ID } from './content';
import { EVIDENCE, observeFlags } from './evidence';
import type {
  OnboardingFlags,
  OnboardingInput,
  OnboardingSnapshot,
  OnboardingStepId,
  OnboardingStepSnapshot,
} from './types';

const OWNER = 'OnboardingTracker';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Owns the First Day progression of a sandbox park: which steps have latched (with the tick and the
 * evidence), which the player skipped, and whether the hints are switched off.
 *
 * It only ever READS the simulation, through an `OnboardingInput` snapshot, and it has no reference
 * to the world's build path, so it can never refuse or delay a build. Completion is sticky: `step`
 * only adds to `completed`; only `restore` replaces it.
 *
 * Save/restore (Phase 13): every field is SERIALIZED; there is no derived or config state.
 */
export class OnboardingTracker implements Serializable<OnboardingState> {
  private dismissed = false;
  private completed: OnboardingCompletionState[] = [];
  private skipped: OnboardingStepId[] = [];
  private sawLitter = false;

  /**
   * One evaluation. Called by ParkSession every 10th tick, so a saved-and-restored run evaluates on
   * the same ticks. Steps latch independently and in any order; a skipped step keeps evaluating
   * (completion wins over skip). Idles once the hints are dismissed or every step is done.
   */
  step(input: OnboardingInput): void {
    if (this.dismissed || this.completed.length >= ONBOARDING_STEPS.length) return;
    const flags: OnboardingFlags = { sawLitter: this.sawLitter };
    observeFlags(flags, input);
    this.sawLitter = flags.sawLitter;
    for (const definition of ONBOARDING_STEPS) {
      if (this.isCompleted(definition.id)) continue;
      const evidence = EVIDENCE[definition.id](input, flags);
      // A non-finite value could not be saved; it is treated as "not observed".
      if (evidence === null || !Number.isFinite(evidence)) continue;
      this.completed.push({
        id: definition.id,
        tick: input.tick,
        evidence: Math.min(Math.max(evidence, 0), MAXIMUM_SAVED_AMOUNT),
      });
    }
  }

  /** The first step that is neither done nor skipped; null when none is left or the hints are off. */
  currentStepId(): OnboardingStepId | null {
    if (this.dismissed) return null;
    for (const definition of ONBOARDING_STEPS) {
      if (!this.isCompleted(definition.id) && !this.skipped.includes(definition.id)) return definition.id;
    }
    return null;
  }

  /** Skips one step. A step that is already done or skipped, or an unknown id, is left alone. */
  skipStep(id: OnboardingStepId): void {
    if (!ONBOARDING_STEP_BY_ID.has(id) || this.isCompleted(id) || this.skipped.includes(id)) return;
    this.skipped.push(id);
  }

  skipCurrent(): void {
    const current = this.currentStepId();
    if (current !== null) this.skipStep(current);
  }

  /** Switches the hints off for this park, for good. */
  dismissAll(): void {
    this.dismissed = true;
  }

  /**
   * Carries the player's skip and dismiss choices over from an earlier snapshot of THIS park after
   * the state was rewound (undo restores a saved image, which predates the choice). Only ever adds:
   * a step that completed in the restored timeline stays done, and nothing is un-skipped.
   */
  adoptDismissals(previous: Pick<OnboardingSnapshot, 'dismissed' | 'steps'>): void {
    if (previous.dismissed) this.dismissed = true;
    for (const step of previous.steps) {
      if (step.status === 'skipped') this.skipStep(step.id);
    }
  }

  snapshot(): OnboardingSnapshot {
    const currentStepId = this.currentStepId();
    const steps: OnboardingStepSnapshot[] = ONBOARDING_STEPS.map((definition) => {
      const completion = this.completed.find((entry) => entry.id === definition.id);
      const status = completion
        ? 'done'
        : this.skipped.includes(definition.id)
          ? 'skipped'
          : definition.id === currentStepId ? 'current' : 'upcoming';
      return {
        id: definition.id,
        title: definition.title,
        hint: definition.hint,
        status,
        evidence: completion ? definition.evidenceLabel(completion.evidence) : null,
        completedAtTick: completion ? completion.tick : null,
      };
    });
    return {
      active: currentStepId !== null,
      dismissed: this.dismissed,
      currentStepId,
      completedCount: this.completed.length,
      totalCount: ONBOARDING_STEPS.length,
      steps,
    };
  }

  serialize(): OnboardingState {
    return {
      dismissed: this.dismissed,
      completed: this.completed.map((entry) => ({
        id: entry.id,
        tick: entry.tick,
        evidence: plainNumber(entry.evidence, 'completed.evidence'),
      })),
      skipped: [...this.skipped],
      sawLitter: this.sawLitter,
    };
  }

  /** Validates everything first, then replaces the whole state with fresh copies. */
  restore(state: OnboardingState): void {
    const validated = this.validate(state);
    this.dismissed = validated.dismissed;
    this.completed = validated.completed;
    this.skipped = validated.skipped;
    this.sawLitter = validated.sawLitter;
  }

  private isCompleted(id: OnboardingStepId): boolean {
    return this.completed.some((entry) => entry.id === id);
  }

  private validate(state: OnboardingState): OnboardingState {
    if (!isRecord(state)) throw invalidState(OWNER, 'state', 'is not an object');
    if (typeof state.dismissed !== 'boolean') throw invalidState(OWNER, 'dismissed', 'must be a boolean');
    if (typeof state.sawLitter !== 'boolean') throw invalidState(OWNER, 'sawLitter', 'must be a boolean');
    const knownId = (value: unknown, path: string): OnboardingStepId => {
      if (typeof value !== 'string') throw invalidState(OWNER, path, 'must be a string');
      if (!ONBOARDING_STEP_BY_ID.has(value as OnboardingStepId)) {
        throw new SaveError('content-mismatch', `${OWNER} cannot restore: unknown step '${value}' at ${path}`);
      }
      return value as OnboardingStepId;
    };

    if (!Array.isArray(state.completed)) throw invalidState(OWNER, 'completed', 'must be an array');
    if (state.completed.length > ONBOARDING_STEPS.length) {
      throw invalidState(OWNER, 'completed', `has more than ${ONBOARDING_STEPS.length} entries`);
    }
    const seen = new Set<string>();
    let previousTick = 0;
    const completed = (state.completed as unknown[]).map((entry, index): OnboardingCompletionState => {
      const path = `completed[${index}]`;
      if (!isRecord(entry)) throw invalidState(OWNER, path, 'is not an object');
      const id = knownId(entry.id, `${path}.id`);
      if (seen.has(id)) throw invalidState(OWNER, `${path}.id`, `duplicates '${id}'`);
      seen.add(id);
      const tick = requireNumberInRange(OWNER, entry.tick, `${path}.tick`, 0, MAXIMUM_SAVED_COUNTER);
      if (!Number.isInteger(tick)) throw invalidState(OWNER, `${path}.tick`, 'must be an integer');
      if (tick < previousTick) throw invalidState(OWNER, `${path}.tick`, 'is earlier than the previous completion');
      previousTick = tick;
      const evidence = requireNumberInRange(OWNER, entry.evidence, `${path}.evidence`, 0, MAXIMUM_SAVED_AMOUNT);
      return { id, tick, evidence: evidence === 0 ? 0 : evidence };
    });

    if (!Array.isArray(state.skipped)) throw invalidState(OWNER, 'skipped', 'must be an array');
    const skippedSeen = new Set<string>();
    const skipped = (state.skipped as unknown[]).map((value, index) => {
      const id = knownId(value, `skipped[${index}]`);
      if (skippedSeen.has(id)) throw invalidState(OWNER, `skipped[${index}]`, `duplicates '${id}'`);
      skippedSeen.add(id);
      return id;
    });
    return { dismissed: state.dismissed, completed, skipped, sawLitter: state.sawLitter };
  }
}
