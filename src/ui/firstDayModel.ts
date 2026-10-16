import { FACING_VECTORS, type Facing } from '../game/maps/types';
import { layPathHint, type GateInward } from '../game/onboarding/content';
import type { OnboardingSnapshot, OnboardingStepId, OnboardingStepStatus } from '../game/onboarding/types';
import { vectorToView, type ViewRotation } from '../rendering/viewRotation';

/**
 * The First Day card in Park Pulse, as pure data: what the card says for one engine snapshot, and
 * when a step that just latched deserves its small "done" moment. The component only renders it.
 */

export type PipState = OnboardingStepStatus;

export type FirstDayView =
  | { mode: 'hidden' }
  | {
    mode: 'step';
    stepId: OnboardingStepId;
    title: string;
    hint: string;
    /** "3 of 10 done": steps latch in any order, so the honest number is the count of done steps. */
    progressText: string;
    /** "1 skipped", or null when nothing was skipped. */
    skippedText: string | null;
    pips: PipState[];
    /** The text for the polite live region; changes only when the current step does. */
    announcement: string;
    canSkip: boolean;
  }
  | {
    mode: 'finished';
    headline: string;
    line: string;
    progressText: string;
    skippedText: string | null;
    pips: PipState[];
    announcement: string;
  };

const skippedTextOf = (skipped: number): string | null => (skipped > 0 ? `${skipped} skipped` : null);

/**
 * Phase 24: which way the park runs from the gate on screen. A gate's `facing` is the inward direction of the border
 * it stands on (maps/parse.ts facingOfBorder); that vector is turned into the view, and an isometric view vector
 * (u, v) moves the screen by (u - v) across and (u + v) down. The Meadow gate (bottom border, facing north) in view 0
 * gives 'up' (up and to the right), the catalog wording.
 */
export const gateInwardOnScreen = (facing: Facing, rotation: ViewRotation): GateInward => {
  const inward = FACING_VECTORS[facing];
  const view = vectorToView(rotation, inward.x, inward.y, { x: 0, y: 0 });
  const down = view.x + view.y > 0;
  const right = view.x - view.y > 0;
  if (!down) return right ? 'up' : 'up-left';
  return right ? 'down-right' : 'down-left';
};

/**
 * Phase 33: the build tab once called Treats is Shops. The First Day hints are game content whose text is part of the
 * determinism observables, so the step text stays as shipped and the card names the tab as the dock does now, and
 * (Phase 40) says a stall goes with its front to the path.
 */
export const dockTabWording = (hint: string): string => hint
  .replace(/\bTreats\b/g, 'Shops')
  // Phase 40: a stall is used from its front, so the card says so (the ghost turns it toward the path by itself).
  .replace(/with a side on the path/g, 'with its front on the path')
  .replace(/\(drinks\) beside the path/g, '(drinks) facing the path');

export const describeFirstDay = (snapshot: OnboardingSnapshot | null, inward: GateInward = 'up'): FirstDayView => {
  if (snapshot === null || snapshot.dismissed) return { mode: 'hidden' };
  const pips = snapshot.steps.map((step) => step.status);
  const skipped = pips.filter((status) => status === 'skipped').length;
  const progressText = `${snapshot.completedCount} of ${snapshot.totalCount} done`;
  const current = snapshot.steps.find((step) => step.id === snapshot.currentStepId);
  if (snapshot.active && current) {
    const hint = current.id === 'lay-path' ? layPathHint(inward) : dockTabWording(current.hint);
    return {
      mode: 'step',
      stepId: current.id,
      title: current.title,
      hint,
      progressText,
      skippedText: skippedTextOf(skipped),
      pips,
      announcement: `Next: ${current.title}. ${hint}`,
      canSkip: true,
    };
  }
  const wrapped = skipped > 0;
  return {
    mode: 'finished',
    headline: wrapped ? 'First Day wrapped up' : 'First Day complete',
    line: wrapped
      ? 'You can keep building at your own pace.'
      : 'Nicely done. Your park is up and running.',
    progressText,
    skippedText: skippedTextOf(skipped),
    pips,
    announcement: wrapped ? 'First Day wrapped up.' : 'First Day complete.',
  };
};

export interface CelebrationState {
  /** The park the state belongs to; null before the first snapshot. */
  epoch: number | null;
  /** Every step seen done in this epoch. Monotone, so an undo and a redo never celebrate twice. */
  seen: readonly OnboardingStepId[];
  /** Newly done steps waiting for their turn, in catalog order. */
  pending: readonly OnboardingStepId[];
}

export const EMPTY_CELEBRATION: CelebrationState = { epoch: null, seen: [], pending: [] };

export interface Celebration {
  stepId: OnboardingStepId;
  title: string;
}

/** How long a "done" row stays before the next step takes over. */
export const CELEBRATION_MS = 3500;

/**
 * Folds one snapshot into the celebration state. The first snapshot of an epoch (a new park, a
 * load) only seeds the seen set, so nothing celebrates for steps that were already done. A newly
 * done step is queued; at most one is handed out per call, and only while `canShow` (no row is on
 * screen), so two steps that latch together appear one after the other.
 */
export const nextCelebration = (
  state: CelebrationState,
  snapshot: OnboardingSnapshot | null,
  epoch: number,
  canShow = true,
): { state: CelebrationState; celebrate: Celebration | null } => {
  if (snapshot === null) return { state, celebrate: null };
  const done = snapshot.steps.filter((step) => step.status === 'done');
  if (state.epoch !== epoch) {
    return { state: { epoch, seen: done.map((step) => step.id), pending: [] }, celebrate: null };
  }
  const seen = new Set(state.seen);
  const pending = [...state.pending];
  for (const step of done) {
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    pending.push(step.id);
  }
  let celebrate: Celebration | null = null;
  if (canShow && pending.length > 0) {
    const stepId = pending.shift()!;
    const title = snapshot.steps.find((step) => step.id === stepId)?.title ?? '';
    celebrate = { stepId, title };
  }
  if (seen.size === state.seen.length && pending.length === state.pending.length && celebrate === null) {
    return { state, celebrate: null };
  }
  return { state: { epoch, seen: [...seen], pending }, celebrate };
};

/** The live-region text: the done step first, then what is next. */
export const composeAnnouncement = (view: FirstDayView, celebration: Celebration | null): string => {
  if (view.mode === 'hidden') return '';
  return celebration ? `Step done: ${celebration.title}. ${view.announcement}` : view.announcement;
};

/**
 * The ride and stall inspectors normally sit under Park Pulse. While the First Day card or the Park
 * Map offer is showing, Pulse is taller and would be covered (Skip step and Hide hints with it), so
 * the inspector steps left of it instead.
 */
export const inspectorBesidePulse = (snapshot: OnboardingSnapshot | null, mapOfferPending: boolean): boolean => (
  mapOfferPending || describeFirstDay(snapshot).mode !== 'hidden'
);
