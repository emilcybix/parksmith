import { Component, Suspense, lazy, type ComponentType, type ReactNode } from 'react';
import { BUILD_BY_ID } from '../game/content/catalog';
import { isColourable } from '../game/content/colours';
import { useKeybindings } from '../settings/useKeybindings';
import type { PaintPanelMode } from './paintPanelModel';
import type { PaintPanelViewProps } from './PaintPanel';
import { showToast } from './showToast';
import { useUiStore } from './store';

/**
 * Phase 34 (bundle budget): panels that a session may never open are separate chunks, loaded the first time they
 * open. What stays in the main chunk is only the open check below; the bodies are `SettingsDialog.tsx` (with the
 * Keyboard section), `SaveLoadDialog.tsx` and `PaintPanel.tsx`, which no main-chunk module imports statically
 * (pinned by `src/app/bundleSplit.static.test.ts`).
 *
 * While a body loads, nothing is drawn (the dialog's input context is already active, so the game ignores keys as it
 * did before). If the chunk cannot be fetched (offline after a deploy), the boundary closes the panel, says why, and
 * the next open tries again instead of reusing the failed load; the rest of the UI keeps running.
 */

/** Loaders, exported for the test that checks each resolves to the component it names. */
export const PANEL_LOADERS = {
  settings: () => import('./SettingsDialog').then((module) => ({ default: module.SettingsDialogBody })),
  saveLoad: () => import('./SaveLoadDialog').then((module) => ({ default: module.SaveLoadDialogBody })),
  paint: () => import('./PaintPanel').then((module) => ({ default: module.PaintPanelView })),
} as const;

/**
 * Phase 35: what the idle prefetch needs from the browser. `requestIdleCallback` where there is one (not Safari), else a
 * plain timer; injectable so a test can drive both paths with a fake.
 */
export interface IdleHost {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => unknown;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
}

/** An idle callback still runs within this long on a page that is never idle. */
export const PREFETCH_IDLE_TIMEOUT_MS = 10_000;
/** Without `requestIdleCallback`: how long after the first world frame each panel is fetched. */
export const PREFETCH_FALLBACK_DELAY_MS = 2_000;

const whenIdle = (host: IdleHost, task: () => void): void => {
  if (typeof host.requestIdleCallback === 'function') host.requestIdleCallback(task, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
  else host.setTimeout(task, PREFETCH_FALLBACK_DELAY_MS);
};

/**
 * Phase 35: fetch the Settings, Save / Load and Paint chunks while the browser is idle, one per idle slot, so their first
 * open does not wait on the network. Called once after the first world frame (`App.tsx`). The loaders are the ones
 * `React.lazy` calls, and the module cache makes its later `import()` resolve at once. A failed prefetch is silent: the
 * panel then loads (or fails, through `PanelBoundary` and its toast) when it is opened, exactly as before. Resolves when
 * every prefetch has settled; never rejects.
 */
export const prefetchLazyPanels = (
  host: IdleHost = globalThis as unknown as IdleHost,
  loaders: readonly (() => Promise<unknown>)[] = Object.values(PANEL_LOADERS),
): Promise<void> => loaders.reduce<Promise<void>>(
  (previous, load) => previous.then(() => new Promise<void>((resolve) => {
    whenIdle(host, () => {
      // A loader that throws synchronously is as silent as one that rejects.
      let loading: Promise<unknown>;
      try { loading = load(); } catch { loading = Promise.resolve(); }
      loading.then(() => resolve(), () => resolve());
    });
  })),
  Promise.resolve(),
);

/** A `React.lazy` that can be rebuilt after a failed load, because React keeps a rejected lazy rejected for good. */
export interface RetryableLazy<P extends object> {
  component(): ComponentType<P>;
  reset(): void;
}

export const retryableLazy = <P extends object>(load: () => Promise<{ default: ComponentType<P> }>): RetryableLazy<P> => {
  let current = lazy(load);
  return {
    component: () => current,
    reset: () => { current = lazy(load); },
  };
};

export const PANEL_LOAD_FAILED = 'This panel could not be loaded. Check your connection and try again.';

interface BoundaryProps {
  children: ReactNode;
  onFailure: () => void;
}

/** Catches a failed chunk load (or a render error) of one lazy panel so it cannot take the whole UI down. */
export class PanelBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(error);
    this.props.onFailure();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const settingsBody = retryableLazy(PANEL_LOADERS.settings);
const saveLoadBody = retryableLazy(PANEL_LOADERS.saveLoad);
const paintView = retryableLazy<PaintPanelViewProps>(PANEL_LOADERS.paint);

const failed = (body: { reset(): void }, close: () => void) => (): void => {
  body.reset();
  close();
  showToast(PANEL_LOAD_FAILED, 'alert');
};

export const SettingsDialog = (): React.JSX.Element | null => {
  const open = useUiStore((state) => state.settingsOpen);
  if (!open) return null;
  const Body = settingsBody.component();
  return (
    <PanelBoundary onFailure={failed(settingsBody, () => useUiStore.getState().closeSettings())}>
      <Suspense fallback={null}><Body /></Suspense>
    </PanelBoundary>
  );
};

export const SaveLoadDialog = (): React.JSX.Element | null => {
  const open = useUiStore((state) => state.savesDialogOpen);
  if (!open) return null;
  const Body = saveLoadBody.component();
  return (
    <PanelBoundary onFailure={failed(saveLoadBody, () => useUiStore.getState().closeSavesDialog())}>
      <Suspense fallback={null}><Body /></Suspense>
    </PanelBoundary>
  );
};

/**
 * Phase 28 step 2's Paint panel, shown with the Paint tool armed, or next to a colourable build card the player opened
 * it for (the "Colour" button). The view is `PaintPanelView` in `PaintPanel.tsx`.
 */
export const PaintPanel = (): React.JSX.Element | null => {
  const tool = useUiStore((state) => state.tool);
  const selectedDefinitionId = useUiStore((state) => state.selectedDefinitionId);
  const panelOpen = useUiStore((state) => state.paintPanelOpen);
  const inspectorOpen = useUiStore((state) => state.selectedRide !== null || state.selectedService !== null || state.selectedGuest !== null);
  const brush = useUiStore((state) => state.paintBrush);
  const target = useUiStore((state) => state.paintTarget);
  const picking = useUiStore((state) => state.paintPicking);
  const keys = useKeybindings();
  const armedColourable = tool === 'build' && selectedDefinitionId !== null && isColourable(selectedDefinitionId);
  const mode: PaintPanelMode | null = tool === 'paint' ? 'paint' : armedColourable && panelOpen && !inspectorOpen ? 'place' : null;
  if (mode === null) return null;
  const armedName = selectedDefinitionId ? BUILD_BY_ID.get(selectedDefinitionId)?.name ?? null : null;
  const View = paintView.component();
  return (
    <PanelBoundary onFailure={failed(paintView, () => useUiStore.getState().cancelTool())}>
      <Suspense fallback={null}>
        <View brush={brush} target={target} picking={picking} mode={mode} armedName={armedName} keys={keys} />
      </Suspense>
    </PanelBoundary>
  );
};
