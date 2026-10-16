import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PANEL_LOADERS, PANEL_LOAD_FAILED, PREFETCH_FALLBACK_DELAY_MS, PREFETCH_IDLE_TIMEOUT_MS, PanelBoundary, PaintPanel, SaveLoadDialog,
  SettingsDialog, prefetchLazyPanels, retryableLazy, type IdleHost,
} from './lazyPanels';
import { PaintPanelView } from './PaintPanel';
import { SaveLoadDialogBody } from './SaveLoadDialog';
import { SettingsDialogBody } from './SettingsDialog';
import { useUiStore } from './store';

/** Phase 34: the lazily loaded panels (see lazyPanels.tsx and src/app/bundleSplit.static.test.ts). */
describe('lazy panels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useUiStore.setState({ settingsOpen: false, savesDialogOpen: false, toast: null });
  });

  it('each loader resolves to the component its open check renders', async () => {
    expect((await PANEL_LOADERS.settings()).default).toBe(SettingsDialogBody);
    expect((await PANEL_LOADERS.saveLoad()).default).toBe(SaveLoadDialogBody);
    expect((await PANEL_LOADERS.paint()).default).toBe(PaintPanelView);
  });

  it('a closed panel renders nothing; building a lazy panel does not load it', () => {
    const load = vi.fn(PANEL_LOADERS.settings);
    retryableLazy(load).component();
    expect(renderToStaticMarkup(<SettingsDialog />)).toBe('');
    expect(renderToStaticMarkup(<SaveLoadDialog />)).toBe('');
    expect(renderToStaticMarkup(<PaintPanel />)).toBe('');
    expect(load).not.toHaveBeenCalled();
  });

  it('a failed load is not cached: reset() builds a new lazy component that loads again', () => {
    const load = vi.fn(() => Promise.reject(new Error('offline')));
    const body = retryableLazy(load);
    const first = body.component();
    expect(body.component()).toBe(first);
    body.reset();
    expect(body.component()).not.toBe(first);
  });

  it('the boundary swallows the failure, renders nothing and reports it once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onFailure = vi.fn();
    const boundary = new PanelBoundary({ children: 'body', onFailure });
    expect(boundary.render()).toBe('body');
    expect(PanelBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    boundary.state = { failed: true };
    expect(boundary.render()).toBeNull();
    boundary.componentDidCatch(new Error('chunk failed'));
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('the failure text says what happened and what to do', () => {
    expect(PANEL_LOAD_FAILED).toMatch(/could not be loaded/);
    expect(PANEL_LOAD_FAILED).toMatch(/try again/);
  });
});

/** Phase 35: the idle prefetch, driven by a fake idle host. */
describe('idle prefetch of the lazy panels', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const fakeIdle = () => {
    const queue: Array<() => void> = [];
    const options: unknown[] = [];
    const host: IdleHost = {
      requestIdleCallback: (callback, given) => { queue.push(callback); options.push(given); return queue.length; },
      setTimeout: () => { throw new Error('the timer is only the fallback'); },
    };
    /** Runs the next idle callback, waiting (a few macrotasks at most) for the previous prefetch to schedule it. */
    const runNext = async (): Promise<void> => {
      for (let i = 0; i < 200 && queue.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      queue.shift()?.();
      await flush();
    };
    return { host, queue, options, runNext };
  };

  it('fetches nothing until the browser is idle, then one panel per idle slot', async () => {
    const idle = fakeIdle();
    const loads = [vi.fn(() => Promise.resolve('settings')), vi.fn(() => Promise.resolve('saves')), vi.fn(() => Promise.resolve('paint'))];
    const done = vi.fn();
    void prefetchLazyPanels(idle.host, loads).then(done);
    await flush();
    expect(loads.map((load) => load.mock.calls.length)).toEqual([0, 0, 0]);
    expect(idle.queue).toHaveLength(1);
    expect(idle.options[0]).toEqual({ timeout: PREFETCH_IDLE_TIMEOUT_MS });
    await idle.runNext();
    expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 0, 0]);
    await idle.runNext();
    await idle.runNext();
    expect(loads.map((load) => load.mock.calls.length)).toEqual([1, 1, 1]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(idle.queue).toHaveLength(0);
  });

  it('a failed prefetch is silent: no toast, no console error, and the rest still load', async () => {
    useUiStore.setState({ toast: null });
    const errors = vi.spyOn(console, 'error');
    const idle = fakeIdle();
    const loads = [
      vi.fn(() => Promise.reject(new Error('offline'))),
      vi.fn((): Promise<unknown> => { throw new Error('sync failure'); }),
      vi.fn(() => Promise.resolve('paint')),
    ];
    const settled = prefetchLazyPanels(idle.host, loads);
    for (let i = 0; i < 3; i += 1) await idle.runNext();
    await expect(settled).resolves.toBeUndefined();
    expect(loads[2]).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().toast).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it('without requestIdleCallback it falls back to a timer', async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const host: IdleHost = { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; } };
    const load = vi.fn(() => Promise.resolve());
    const settled = prefetchLazyPanels(host, [load]);
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(timers.map((timer) => timer.delay)).toEqual([PREFETCH_FALLBACK_DELAY_MS]);
    timers[0].callback();
    await expect(settled).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('by default it prefetches exactly the five panel loaders (Phase 42 added the two windows)', async () => {
    const idle = fakeIdle();
    // Resolved at once: the real chunks would load the modules, which under a busy suite can outlast runNext's wait.
    const spies = (['settings', 'saveLoad', 'paint', 'staff', 'buildings'] as const)
      .map((name) => vi.spyOn(PANEL_LOADERS, name).mockResolvedValue({ default: () => null } as never));
    // The default list is read when the call is made, so the spies are what it calls.
    const settled = prefetchLazyPanels(idle.host);
    for (let i = 0; i < 5; i += 1) await idle.runNext();
    await settled;
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
