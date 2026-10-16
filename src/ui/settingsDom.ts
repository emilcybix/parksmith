import {
  MOTION_ATTRIBUTE,
  effectiveUiScale,
  onReducedMotionChange,
  reducedMotion,
  settingsStore,
  type Settings,
} from '../settings';

/**
 * Writes the settings that CSS needs onto <html>: the UI zoom and the zoomed viewport size
 * (`--ui-zoom`, `--ui-vw`, `--ui-vh`), and `data-motion="reduce" | "full"`. The effective reduced-
 * motion value comes from the motion module, so the stylesheet and every script agree.
 */
export interface UiVars {
  zoom: number;
  /** The viewport in the UI layer's own (zoomed) CSS pixels: what `100vw` / `100vh` mean inside it. */
  width: number;
  height: number;
}

export const uiLayoutVars = (uiScale: Settings['uiScale'], innerWidth: number, innerHeight: number): UiVars => {
  const zoom = effectiveUiScale(uiScale, innerWidth, innerHeight);
  return { zoom, width: innerWidth / zoom, height: innerHeight / zoom };
};

export interface DomRoot {
  style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
}

export interface ViewportSource {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

export const applySettingsToDom = (root: DomRoot, settings: Settings, viewport: Pick<ViewportSource, 'innerWidth' | 'innerHeight'>, reduced: boolean): UiVars => {
  const vars = uiLayoutVars(settings.uiScale, viewport.innerWidth, viewport.innerHeight);
  root.style.setProperty('--ui-zoom', String(round(vars.zoom)));
  root.style.setProperty('--ui-vw', `${round(vars.width)}px`);
  root.style.setProperty('--ui-vh', `${round(vars.height)}px`);
  root.setAttribute(MOTION_ATTRIBUTE, reduced ? 'reduce' : 'full');
  return vars;
};

/** Applies now and keeps the DOM in step with settings, the OS motion preference and window size. */
export const startSettingsDom = (
  root: DomRoot = document.documentElement,
  viewport: ViewportSource = window,
): (() => void) => {
  const apply = (): void => {
    applySettingsToDom(root, settingsStore.getState().settings, viewport, reducedMotion());
  };
  apply();
  let frame: number | null = null;
  const onResize = (): void => {
    if (!viewport.requestAnimationFrame) { apply(); return; }
    if (frame !== null) return;
    frame = viewport.requestAnimationFrame(() => { frame = null; apply(); });
  };
  const stopStore = settingsStore.subscribe(apply);
  const stopMotion = onReducedMotionChange(apply);
  viewport.addEventListener('resize', onResize);
  return () => {
    stopStore();
    stopMotion();
    viewport.removeEventListener('resize', onResize);
    if (frame !== null) viewport.cancelAnimationFrame?.(frame);
  };
};
