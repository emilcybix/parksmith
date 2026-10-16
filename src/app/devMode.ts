import { getSettings } from '../settings/settingsStore';

/**
 * Developer tools — the cash/guest cheat buttons, the forced breakdown, and the Developer Park —
 * are a regression fixture, not player-facing content. They are reachable only behind an explicit
 * switch, so an ordinary Sandbox session cannot cheat by accident and a playtest measures the real
 * game.
 *
 * The switch is the persisted `developerTools` setting (Settings panel, off by default). `?dev=1`
 * in the URL forces it on and `?dev=0` forces it off for this page load only; the URL is never
 * written to the setting, so one visit to a shared link cannot leave dev tools on. The old `parksmith-dev` localStorage flag is imported once by
 * the settings migration. The value is read once at module load, so switching it takes a reload —
 * which is exactly what we want, since half the tools reshape the whole session.
 */
export const readDeveloperUrlForce = (search: string): boolean | null => {
  const parameter = new URLSearchParams(search).get('dev');
  if (parameter === null) return null;
  return parameter !== '0' && parameter !== 'false';
};

const urlForce = ((): boolean | null => {
  if (typeof window === 'undefined') return null;
  try {
    return readDeveloperUrlForce(window.location.search);
  } catch {
    return null;
  }
})();

export const DEVELOPER_FORCED_BY_URL = urlForce !== null;
export const DEVELOPER_MODE: boolean = urlForce ?? getSettings().developerTools;
