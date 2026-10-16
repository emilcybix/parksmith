import { useEffect, useRef, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import { runBridge } from './runBridge';
import {
  CELEBRATION_MS,
  composeAnnouncement,
  EMPTY_CELEBRATION,
  nextCelebration,
  type Celebration,
  type CelebrationState,
  type FirstDayView,
  type PipState,
} from './firstDayModel';
import { describeMapOffer } from './mapOfferModel';
import { useUiStore } from './store';

const PIP_GLYPH: Record<PipState, string> = { done: '✓', skipped: '–', current: '', upcoming: '' };

/**
 * The First Day card inside Park Pulse: the current step, one friendly line, progress, and two
 * real buttons. A sibling of the pulse launcher (buttons cannot nest). It is not modal, takes no
 * focus and handles no keys, so building and every shortcut work exactly as before. What it says
 * is decided in firstDayModel.ts. `compact` squeezes the finished state into one row, so the Park
 * Map offer under it never pushes the card over the build dock on a short screen. In the step state
 * `compact` keeps header, title and both buttons and drops the hint, pips and celebration row (the live
 * region still announces a completion).
 */
export const FirstDayCard = ({ view, compact = false }: { view: FirstDayView; compact?: boolean }): React.JSX.Element => {
  const onboarding = useUiStore((state) => state.onboarding);
  const epoch = useUiStore((state) => state.parkEpoch);
  const celebrationState = useRef<CelebrationState>(EMPTY_CELEBRATION);
  const [shown, setShown] = useState<Celebration | null>(null);

  // Fold every snapshot in; a row is handed out only while none is on screen.
  useEffect(() => {
    const result = nextCelebration(celebrationState.current, onboarding, epoch, shown === null);
    celebrationState.current = result.state;
    if (result.celebrate) setShown(result.celebrate);
  }, [onboarding, epoch, shown]);

  useEffect(() => {
    if (shown === null) return undefined;
    const timer = window.setTimeout(() => setShown(null), CELEBRATION_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  // A new park ends the old park's row at once.
  useEffect(() => { setShown(null); }, [epoch]);

  // The live region stays mounted while empty so its changes are announced (same pattern as Toast).
  const region = (
    <div className="sr-only" role="status" aria-live="polite">{composeAnnouncement(view, shown)}</div>
  );
  if (view.mode === 'hidden') return region;

  const pips = (
    <ol className="first-day-pips" aria-hidden="true">
      {view.pips.map((pip, index) => (
        <li key={index} className={`pip ${pip}`}>{PIP_GLYPH[pip]}</li>
      ))}
    </ol>
  );
  const progress = (
    <em>{view.progressText}{view.skippedText ? ` · ${view.skippedText}` : ''}</em>
  );
  const done = shown
    ? <div className="first-day-done" key={shown.stepId}><span aria-hidden="true">✓</span>{shown.title}</div>
    : null;

  if (view.mode === 'finished' && compact) {
    return (
      <section className="first-day finished compact" aria-label="First Day">
        {region}
        {done}
        <div className="first-day-row">
          <strong className="first-day-title"><span aria-hidden="true">✦</span>{view.headline}</strong>
          <button type="button" className="first-day-hide" onClick={() => gameBridge.dismissOnboarding()}>Close</button>
        </div>
      </section>
    );
  }

  if (view.mode === 'finished') {
    return (
      <section className="first-day finished" aria-label="First Day">
        {region}
        <header><small>FIRST DAY</small>{progress}</header>
        {done}
        <strong className="first-day-title"><span aria-hidden="true">✦</span>{view.headline}</strong>
        <p>{view.line}</p>
        {pips}
        <div className="first-day-actions">
          <button type="button" className="first-day-hide" onClick={() => gameBridge.dismissOnboarding()}>Close</button>
        </div>
      </section>
    );
  }

  return (
    <section className={`first-day${compact ? ' compact' : ''}`} aria-label="First Day">
      {region}
      <header><small>FIRST DAY</small>{progress}</header>
      {compact ? null : done}
      <strong className="first-day-title"><span aria-hidden="true">✦</span>{view.title}</strong>
      {compact ? null : <p>{view.hint}</p>}
      {compact ? null : pips}
      <div className="first-day-actions">
        <button
          type="button"
          className="first-day-skip"
          aria-label={`Skip step: ${view.title}`}
          onClick={() => gameBridge.skipOnboardingStep()}
        >
          Skip step
        </button>
        <button
          type="button"
          className="first-day-hide"
          title="Hide the First Day hints for this park"
          onClick={() => gameBridge.dismissOnboarding()}
        >
          Hide hints
        </button>
      </div>
    </section>
  );
};

/** The one-time "Ready for The Map?" offer, shown under the First Day card once the sandbox park is stable. */
export const MapOffer = (): React.JSX.Element | null => {
  const pending = useUiStore((state) => state.mapOfferPending);
  const view = describeMapOffer(pending);
  if (!view.visible) return null;
  return (
    <section className="map-offer" aria-label="The Map">
      <p><span aria-hidden="true">✦</span>{view.line}</p>
      <div className="first-day-actions">
        <button
          type="button"
          className="first-day-skip"
          aria-label={view.openAriaLabel}
          onClick={() => runBridge.resolveMapOffer(true)}
        >
          {view.openLabel}
        </button>
        <button
          type="button"
          className="first-day-hide"
          aria-label={view.dismissAriaLabel}
          onClick={() => runBridge.resolveMapOffer(false)}
        >
          {view.dismissLabel}
        </button>
      </div>
    </section>
  );
};
