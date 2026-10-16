import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getSettings, updateSettings, useKeybindings, type ActionId } from '../settings';
import {
  captureStep,
  customBindingCount,
  fixedKeys,
  isCapturing,
  keyboardGroups,
  type CaptureAction,
  type CaptureState,
} from './keyboardSettingsModel';
import './keyboardSettings.css';

interface KeyboardSettingsProps {
  /** Set while a key capture is open, so the dialog's own Tab trap and Esc handling stand down. */
  capturingRef: { current: boolean };
}

/**
 * The Keyboard section of the settings panel: every rebindable shortcut by group, a press-a-key
 * capture (Esc cancels the capture, not the panel), per-row Clear and Reset, and Reset all. All
 * native buttons, so it is fully operable from the keyboard; every result goes through one polite
 * status region. The rules live in keyboardSettingsModel.ts.
 */
export const KeyboardSettings = ({ capturingRef }: KeyboardSettingsProps): React.JSX.Element => {
  const overrides = useKeybindings();
  const baseId = useId();
  const [capture, setCaptureState] = useState<CaptureState>({ mode: 'idle' });
  const [status, setStatus] = useState('');
  const captureRef = useRef<CaptureState>(capture);
  const buttons = useRef(new Map<ActionId, HTMLButtonElement>());
  const refocus = useRef<ActionId | null>(null);

  const setCapture = useCallback((next: CaptureState): void => {
    captureRef.current = next;
    capturingRef.current = isCapturing(next);
    setCaptureState(next);
  }, [capturingRef]);

  /** Runs one reducer step against the live settings and applies its result. */
  const run = useCallback((action: CaptureAction): void => {
    const current = getSettings().keybindings;
    const outcome = captureStep(captureRef.current, action, current);
    const wasCapturing = isCapturing(captureRef.current);
    if (outcome.changed) updateSettings({ keybindings: outcome.overrides });
    setCapture(outcome.state);
    if (outcome.status !== null) setStatus(outcome.status);
    if (wasCapturing && !isCapturing(outcome.state) && 'id' in captureRef.current) refocus.current = captureRef.current.id;
  }, [setCapture]);

  const capturingId = capture.mode === 'idle' ? null : capture.id;

  // While capturing, every key press is the answer, not a command: it is swallowed before the game,
  // the dialog's Tab trap and the Esc handling see it, and Esc cancels only the capture.
  useEffect(() => {
    if (capturingId === null) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
      // A held Enter that opened the capture must not answer it.
      if (event.repeat) return;
      const previous = captureRef.current;
      run({ type: 'key', event });
      if (previous.mode !== 'idle' && event.key === 'Escape') refocus.current = previous.id;
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturingId, run]);

  // Leaving capture (committed or cancelled) puts focus back on that row's Change button.
  useEffect(() => {
    if (capture.mode !== 'idle' || refocus.current === null) return;
    buttons.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [capture]);

  useEffect(() => () => { capturingRef.current = false; }, [capturingRef]);

  const groups = keyboardGroups(overrides);
  const changed = customBindingCount(overrides);

  return (
    <details className="settings-group settings-keyboard">
      <summary>Keyboard</summary>
      <p className="settings-hint" id={`${baseId}-intro`}>
        Change a shortcut: choose Change, then press the new key. Esc cancels. Esc itself, Ctrl+Z and Ctrl+S are fixed.
      </p>
      <p className="kb-status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
      {groups.map((group) => (
        <div key={group.group} className="kb-group" role="group" aria-labelledby={`${baseId}-${group.group}`}>
          <h4 id={`${baseId}-${group.group}`}>{group.title}</h4>
          {group.note ? <p className="settings-hint">{group.note}</p> : null}
          <ul className="kb-list">
            {group.rows.map((row) => {
              const rowCapturing = capture.mode !== 'idle' && capture.id === row.id;
              const message = rowCapturing && capture.mode === 'refused' ? capture.message : null;
              const descId = `${baseId}-${row.id}-d`;
              const messageId = `${baseId}-${row.id}-m`;
              return (
                <li key={row.id} className={`kb-row${rowCapturing ? ' capturing' : ''}`}>
                  <div className="kb-name">
                    <span className="kb-label">{row.label}</span>
                    <small id={descId}>{row.description}</small>
                  </div>
                  <kbd className={`kb-key${row.bound ? '' : ' unbound'}`} title={row.physical ? 'Physical key position' : undefined}>
                    <span className="sr-only">Key: </span>{row.bound ? row.keyText : 'None'}
                  </kbd>
                  <div className="kb-actions">
                    <button
                      type="button"
                      className="settings-button kb-change"
                      ref={(element) => {
                        if (element) buttons.current.set(row.id, element);
                        else buttons.current.delete(row.id);
                      }}
                      aria-label={rowCapturing ? `Press a key for ${row.label}. Esc cancels.` : `Change key for ${row.label}`}
                      aria-describedby={message ? `${descId} ${messageId}` : descId}
                      aria-invalid={message ? true : undefined}
                      onClick={() => run({ type: 'start', id: row.id })}
                      onBlur={() => {
                        if (captureRef.current.mode !== 'idle' && captureRef.current.id === row.id) run({ type: 'cancel' });
                      }}
                    >
                      {rowCapturing ? 'Press a key…' : 'Change'}
                    </button>
                    <button
                      type="button"
                      className="settings-button kb-small"
                      disabled={!row.bound}
                      aria-label={`Clear key for ${row.label}`}
                      onClick={() => run({ type: 'clear', id: row.id })}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      className="settings-button kb-small"
                      disabled={row.isDefault}
                      aria-label={`Reset ${row.label} to ${row.defaultText}`}
                      onClick={() => run({ type: 'reset', id: row.id })}
                    >
                      Reset
                    </button>
                  </div>
                  {message ? <p id={messageId} className="kb-message">{message}</p> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="kb-footer">
        <button
          type="button"
          className="settings-button"
          disabled={changed === 0}
          onClick={() => run({ type: 'resetAll' })}
        >
          Reset all keyboard shortcuts
        </button>
      </div>
      <div className="kb-group" role="group" aria-labelledby={`${baseId}-fixed`}>
        <h4 id={`${baseId}-fixed`}>Fixed keys</h4>
        <dl className="kb-fixed">
          {fixedKeys().map((fixed) => (
            <div key={fixed.keys}>
              <dt>{fixed.keys}</dt>
              <dd><strong>{fixed.label}.</strong> {fixed.description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
};
