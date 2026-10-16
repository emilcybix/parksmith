import { useEffect, useRef, useState } from 'react';
import { recoveryBridge } from '../app/gameBridge';
import { isRecoveryPromptOpen, isTextInputTarget } from './inputContext';
import {
  describeRecoveryButtons,
  describeRecoveryFailure,
  describeRecoveryOffer,
  planRecoveryResume,
  RECOVERY_REPLACE_TEXT,
  recoveryFailureOffersSaveDialog,
} from './recoveryModel';
import { describeLoadResult } from './saveLoadModel';
import { openSaveLoadDialog } from './openSaveLoad';
import { showToast } from './showToast';
import { useUiStore } from './store';

const FOCUSABLE = 'button:not([disabled])';

/**
 * Offers to resume the autosave of a session that ended unexpectedly. Mounted only while an offer
 * is unresolved, and hidden while the Save / Load dialog is open (the "all slots are full" message
 * sends the player there; two modals at once would fight over focus and Escape).
 */
export const RecoveryPrompt = (): React.JSX.Element | null => {
  const phase = useUiStore((state) => state.recovery.phase);
  const savesDialogOpen = useUiStore((state) => state.savesDialogOpen);
  return isRecoveryPromptOpen(phase) && !savesDialogOpen ? <RecoveryPromptBody /> : null;
};

const RecoveryPromptBody = (): React.JSX.Element | null => {
  const recovery = useUiStore((state) => state.recovery);
  const unsavedChanges = useUiStore((state) => state.saves.unsavedChanges);
  const dialogRef = useRef<HTMLDivElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Whoever had the keyboard gets it back when the prompt goes away.
  const [opener] = useState<Element | null>(() => document.activeElement);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const offer = recovery.offer;
  const buttons = describeRecoveryButtons(recovery.phase);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * Focus starts on the safe choice, Resume, but never rips the keyboard out of a text field the
   * player is typing in: it waits for that field to lose focus. While a command is in flight the
   * buttons are disabled, so the dialog itself holds focus and the Tab trap keeps working.
   */
  useEffect(() => {
    if (buttons.disabled) {
      dialogRef.current?.focus();
      return;
    }
    if (confirming) {
      cancelRef.current?.focus();
      return;
    }
    if (isTextInputTarget(document.activeElement)) {
      const onFocusOut = (): void => { window.setTimeout(() => resumeRef.current?.focus(), 0); };
      document.addEventListener('focusout', onFocusOut, { once: true });
      return () => document.removeEventListener('focusout', onFocusOut);
    }
    resumeRef.current?.focus();
  }, [buttons.disabled, confirming]);

  useEffect(() => () => {
    if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) opener.focus();
  }, [opener]);

  /**
   * Escape does NOT dismiss: a stray key must not decide about a save. It is swallowed in the
   * capture phase so it also cannot pop the layer underneath. Tab is trapped inside the prompt.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current;
      if (dialog === null) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || active === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  if (offer === null) return null;
  const model = describeRecoveryOffer(offer, now);

  const resume = async (): Promise<void> => {
    setConfirming(false);
    const result = await recoveryBridge.resume();
    if (!result.ok) return;
    const ui = useUiStore.getState();
    showToast(describeLoadResult(result.value), 'routine');
    // Idempotent with the load flow, which closes these too; keeps the UI right if it did not.
    ui.closeScenarioPicker();
  };

  const onResume = (): void => {
    if (planRecoveryResume(unsavedChanges) === 'confirm-replace') setConfirming(true);
    else void resume();
  };

  const error = recovery.error;

  return (
    <div className="recovery-backdrop">
      <div
        ref={dialogRef}
        className="recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-title"
        aria-describedby="recovery-summary"
        aria-busy={buttons.disabled}
        tabIndex={-1}
      >
        <small>PARKSMITH</small>
        <h2 id="recovery-title">{model.title}</h2>
        <p id="recovery-summary" className="recovery-summary">{model.summary}</p>
        <div className="recovery-card">
          <strong title={model.autosaveName}>{model.autosaveName}</strong>
          <dl>
            {model.stats.map((stat) => (
              <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}</dd></div>
            ))}
          </dl>
        </div>
        {error !== null && (
          <div className="recovery-error" role="alert">
            <span>{describeRecoveryFailure(error)}</span>
            {recoveryFailureOffersSaveDialog(error) && <button onClick={openSaveLoadDialog}>Open Save / Load</button>}
          </div>
        )}
        {confirming ? (
          <div className="recovery-confirm" role="group" aria-label="Confirm resume">
            <span>{RECOVERY_REPLACE_TEXT}</span>
            <button className="primary" onClick={() => void resume()}>Replace park</button>
            <button ref={cancelRef} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        ) : (
          <>
            <div className="recovery-actions">
              <button ref={resumeRef} className="primary" disabled={buttons.disabled} onClick={onResume}>{buttons.resumeLabel}</button>
              <button disabled={buttons.disabled} onClick={() => void recoveryBridge.dismiss()}>{buttons.notNowLabel}</button>
            </div>
            <p className="recovery-note">{model.reassurance}</p>
          </>
        )}
      </div>
    </div>
  );
};
