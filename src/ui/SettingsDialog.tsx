import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { KeyboardSettings } from './KeyboardSettings';
import { DEVELOPER_MODE } from '../app/devMode';
import {
  onReducedMotionChange,
  reducedMotion,
  resetSettings,
  settingsStore,
  updateSettings,
  type Settings,
} from '../settings';
import {
  SETTINGS_GROUPS,
  developerToolsState,
  flashesAvailability,
  motionStatus,
  persistenceNotice,
  segmentedHint,
  uiScaleStatus,
  graphicsStatus,
  SOUND_HINT,
  VOLUME_CONTROLS,
  volumeText,
  type SegmentedControl,
} from './settingsModel';
import { activeInputContext } from './inputContext';
import { BOOT_GRAPHICS } from '../app/rendererFlag';
import { useUiStore } from './store';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const focusableWithin = (root: HTMLElement): HTMLElement[] => (
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null)
);

const useSettingsState = (): { settings: Settings; persistence: 'ok' | 'unavailable' } => {
  const settings = useStore(settingsStore, (state) => state.settings);
  const persistence = useStore(settingsStore, (state) => state.persistence);
  return { settings, persistence };
};

const useWindowSize = (): { width: number; height: number } => {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
};

interface SegmentedProps {
  control: SegmentedControl;
  value: Settings[SegmentedControl['key']];
  hint: string;
  extra?: string | null;
}

const Segmented = ({ control, value, hint, extra }: SegmentedProps): React.JSX.Element => {
  const hintId = useId();
  return (
    <fieldset className="settings-field" aria-describedby={hintId}>
      <legend>{control.legend}</legend>
      <div className="settings-segmented">
        {control.options.map((option) => (
          <label key={String(option.value)} className="settings-seg">
            <input
              type="radio"
              name={`setting-${control.key}`}
              checked={option.value === value}
              onChange={() => updateSettings({ [control.key]: option.value } as Partial<Settings>)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <p id={hintId} className="settings-hint">
        {hint}
        {extra ? <strong className="settings-note" role="status"> {extra}</strong> : null}
      </p>
    </fieldset>
  );
};

/**
 * Phase 34: the panel's body (with the Keyboard section) is a lazy chunk. `SettingsDialog` (the open check) lives in
 * `lazyPanels.tsx`, so nothing in the main chunk imports this module statically.
 */
export const SettingsDialogBody = (): React.JSX.Element => {
  const { settings, persistence } = useSettingsState();
  const reduced = useSyncExternalStore(onReducedMotionChange, reducedMotion);
  const size = useWindowSize();
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  // True while the Keyboard section waits for a key: Tab and Esc then belong to that capture.
  const capturingRef = useRef(false);
  const [resetAt, setResetAt] = useState<Settings | null>(null);
  const close = useUiStore((state) => state.closeSettings);

  // Only the topmost layer owns focus: when Save / Load or the recovery prompt is above the panel
  // (a menu calling openSettings() over them), the panel neither steals focus nor traps Tab.
  const topmost = useUiStore((state) => activeInputContext(state) === 'settings');
  const topmostRef = useRef(topmost);
  topmostRef.current = topmost;

  // Focus moves in once the panel is topmost, and back to whatever opened it on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener !== null && opener.isConnected && opener !== document.body) opener.focus();
      else document.querySelector<HTMLElement>('[data-settings-gear]')?.focus();
    };
  }, []);
  useEffect(() => {
    if (topmost) titleRef.current?.focus();
  }, [topmost]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current;
      if (dialog === null || event.key !== 'Tab' || !topmostRef.current || capturingRef.current) return;
      const focusable = focusableWithin(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || active === titleRef.current) {
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

  const flashes = flashesAvailability(settings, reduced);
  const developerState = developerToolsState(settings.developerTools, DEVELOPER_MODE);
  const storageNotice = persistenceNotice(persistence);

  return (
    <>
      <div className="settings-catcher" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId} ref={titleRef} tabIndex={-1}>Settings</h2>
          <button type="button" className="settings-close" onClick={close} aria-label="Close settings" title="Close (Esc)">×</button>
        </header>
        <div className="settings-body">
          {SETTINGS_GROUPS.map((group) => (
            <section key={group.id} className="settings-group" aria-labelledby={`${titleId}-${group.id}`}>
              <h3 id={`${titleId}-${group.id}`}>{group.title}</h3>
              {group.controls.map((control) => (
                <Segmented
                  key={control.key}
                  control={control}
                  value={settings[control.key]}
                  hint={segmentedHint(control.key, settings)}
                  extra={control.key === 'reducedMotion'
                    ? motionStatus(settings, reduced)
                    : control.key === 'uiScale'
                      ? uiScaleStatus(settings, size.width, size.height)
                      : control.key === 'renderer' || control.key === 'graphicsDetail'
                        ? graphicsStatus(control.key, settings[control.key], BOOT_GRAPHICS[control.key])
                        : null}
                />
              ))}
              {group.id === 'graphics' && (settings.renderer !== BOOT_GRAPHICS.renderer || settings.graphicsDetail !== BOOT_GRAPHICS.graphicsDetail) && (
                <button type="button" className="settings-button" onClick={() => window.location.reload()}>Reload now</button>
              )}
              {group.id === 'weather' && (
                <div className="settings-field settings-switch-row">
                  <label className="settings-switch">
                    <input
                      type="checkbox"
                      checked={settings.lightningFlashes}
                      disabled={flashes.disabled}
                      onChange={(event) => updateSettings({ lightningFlashes: event.target.checked })}
                      aria-describedby={`${titleId}-flash`}
                    />
                    <span>Lightning flashes</span>
                  </label>
                  <p id={`${titleId}-flash`} className="settings-hint">
                    {flashes.reason ?? 'Brief flashes in storms, at most three per second. Turn off if they bother you.'}
                  </p>
                </div>
              )}
            </section>
          ))}
          {/* Phase 15: the sound group, one slider per bus (steps of 10). */}
          <section className="settings-group" aria-labelledby={`${titleId}-sound`}>
            <h3 id={`${titleId}-sound`}>Sound</h3>
            {VOLUME_CONTROLS.map((control) => (
              <label key={control.key} className="settings-field settings-volume">
                <span>{control.label}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={10}
                  value={settings[control.key]}
                  aria-valuetext={volumeText(settings[control.key])}
                  onChange={(event) => updateSettings({ [control.key]: Number(event.target.value) as Settings[typeof control.key] })}
                />
                <output>{volumeText(settings[control.key])}</output>
              </label>
            ))}
            <p className="settings-hint">{SOUND_HINT}</p>
          </section>
          <KeyboardSettings capturingRef={capturingRef} />
          <details className="settings-group settings-developer">
            <summary>Developer tools</summary>
            <div className="settings-field settings-switch-row">
              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={settings.developerTools}
                  onChange={(event) => updateSettings({ developerTools: event.target.checked })}
                  aria-describedby={`${titleId}-dev`}
                />
                <span>Developer tools</span>
              </label>
              <p id={`${titleId}-dev`} className="settings-hint">
                Cheat buttons and test parks. Changes what a playtest measures.
                {developerState === 'pending-on' && ' Reload to turn on.'}
                {developerState === 'pending-off' && ' Reload to turn off.'}
              </p>
              {(developerState === 'pending-on' || developerState === 'pending-off') && (
                <button type="button" className="settings-button" onClick={() => window.location.reload()}>Reload now</button>
              )}
            </div>
          </details>
        </div>
        <footer>
          <div className="settings-status" role="status">
            {storageNotice ?? (resetAt === settings ? 'Defaults restored.' : '')}
          </div>
          <button
            type="button"
            className="settings-button"
            onClick={() => { resetSettings(); setResetAt(settingsStore.getState().settings); }}
          >
            Reset to defaults
          </button>
        </footer>
      </section>
    </>
  );
};
