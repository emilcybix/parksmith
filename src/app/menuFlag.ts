/**
 * `&menu=0` (or `false` / `off`) skips the start screen at boot: the game opens straight into its
 * default park, as it did before the menu existed. Tests and scripts use it. Like the renderer
 * flags it is read once from the URL and never remembered, so a debugging choice cannot stick; and
 * `?dev=1` does not change it (the developer sees the menu too).
 */
export const parseStartMenuFlag = (search: string): boolean => {
  const value = new URLSearchParams(search).get('menu');
  return !(value === '0' || value === 'false' || value === 'off');
};

/**
 * The default for a GameApp built without an explicit option. Outside a browser (unit tests build
 * GameApp against a stubbed window) there is no URL to read, and the answer is "no menu", so a test
 * that does not ask for the menu keeps the straight-to-the-park behaviour it was written for.
 */
export const START_MENU_DEFAULT: boolean = ((): boolean => {
  try {
    if (typeof window === 'undefined' || typeof window.location?.search !== 'string') return false;
    return parseStartMenuFlag(window.location.search);
  } catch {
    return false;
  }
})();
