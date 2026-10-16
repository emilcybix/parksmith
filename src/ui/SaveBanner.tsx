import { useEffect, useState } from 'react';
import { saveBridge } from '../app/gameBridge';
import { AUTOSAVE_INDICATOR_VISIBLE_MS, SAVE_NOTICE_VISIBLE_MS } from '../app/saves/constants';
import type { AutosaveIndicator, SaveNotice } from '../app/saves/types';
import { openSaveLoadDialog } from './openSaveLoad';
import {
  describeAutosavePause,
  describePersistenceBanner,
  indicatorDelayMs,
  indicatorLabel,
} from './saveLoadModel';
import { RECOVERY_BANNER_VISIBLE_MS, visibleRecoveryBanner } from './recoveryModel';
import { useUiStore } from './store';

/**
 * Whether a banner is on screen, so the toast and notification stack can move down instead of
 * hiding behind it. Hidden while the dialog is open: the dialog shows its own copy, and two
 * live regions would announce the same failure twice.
 */
export const useSaveBannerVisible = (): boolean => useUiStore((state) => (
  !state.savesDialogOpen
  && (
    describePersistenceBanner(state.saves.persistence) !== null
    || describeAutosavePause(state.saves, state.recovery.phase) !== null
    || visibleRecoveryBanner(state.recovery, state.recoveryBannerDismissedKey) !== null
  )
));

/** Persistence-unavailable and autosave-paused banners. Always mounted; renders nothing when fine. */
export const SaveBanner = (): React.JSX.Element | null => {
  const saves = useUiStore((state) => state.saves);
  const dialogOpen = useUiStore((state) => state.savesDialogOpen);
  const banner = describePersistenceBanner(saves.persistence);
  const recoveryPhase = useUiStore((state) => state.recovery.phase);
  const pause = describeAutosavePause(saves, recoveryPhase);
  const recovery = useUiStore((state) => state.recovery);
  const dismissedKey = useUiStore((state) => state.recoveryBannerDismissedKey);
  const news = visibleRecoveryBanner(recovery, dismissedKey);
  const newsKey = news?.key ?? null;
  // The notice is news, not a standing fault: it lets go by itself like the save notices do.
  useEffect(() => {
    if (newsKey === null) return;
    const timer = window.setTimeout(() => useUiStore.getState().dismissRecoveryBanner(newsKey), RECOVERY_BANNER_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [newsKey]);
  if (dialogOpen) return null;
  if (banner) {
    return (
      <div className="save-banner" role="alert">
        <span aria-hidden="true">!</span>
        <p>{banner.message}</p>
        <button onClick={() => void saveBridge.retryPersistence()}>Retry</button>
        <button onClick={() => saveBridge.dismissBanner()} aria-label="Dismiss saving warning">Dismiss</button>
      </div>
    );
  }
  if (pause) {
    return (
      <div className="save-banner soft" role="status">
        <span aria-hidden="true">Ⅱ</span>
        <p>{pause.message}</p>
        {pause.cause === 'other-tab'
          ? <button onClick={() => saveBridge.resumeAutosaveHere()}>Resume here</button>
          : <button onClick={openSaveLoadDialog}>Open Save / Load</button>}
      </div>
    );
  }
  if (news) {
    return (
      <div className="save-banner soft" role="status">
        <span aria-hidden="true">i</span>
        <p>{news.text}</p>
        <button onClick={() => useUiStore.getState().dismissRecoveryBanner(news.key)} aria-label="Dismiss notice">OK</button>
      </div>
    );
  }
  return null;
};

/** The notice the manager published, shown for SAVE_NOTICE_VISIBLE_MS and then let go. */
export const useVisibleSaveNotice = (): SaveNotice | null => {
  const notice = useUiStore((state) => state.saves.notice);
  const [expiredId, setExpiredId] = useState<number | null>(null);
  const id = notice?.id ?? null;
  useEffect(() => {
    if (id === null) return;
    const timer = window.setTimeout(() => setExpiredId(id), SAVE_NOTICE_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [id]);
  return notice !== null && notice.id !== expiredId ? notice : null;
};

/** Errors interrupt (role alert), results wait their turn (role status). */
export const SaveNoticeLine = ({ notice }: { notice: SaveNotice | null }): React.JSX.Element | null => {
  if (notice === null) return null;
  return notice.kind === 'error'
    ? <span className="save-notice error" role="alert">{notice.text}</span>
    : <span className="save-notice" role="status">{notice.text}</span>;
};

/** Delays "Saving…" so a save that ends in a blink never flashes, and lets "Autosaved" fade. */
const useShownIndicator = (indicator: AutosaveIndicator): AutosaveIndicator => {
  const [shown, setShown] = useState<AutosaveIndicator>('hidden');
  useEffect(() => {
    const show = window.setTimeout(() => setShown(indicator), indicatorDelayMs(indicator));
    const fade = indicator === 'saved' ? window.setTimeout(() => setShown('hidden'), AUTOSAVE_INDICATOR_VISIBLE_MS) : undefined;
    return () => {
      window.clearTimeout(show);
      if (fade !== undefined) window.clearTimeout(fade);
    };
  }, [indicator]);
  return indicator === 'hidden' ? 'hidden' : shown;
};

/**
 * One small strip under the top bar: the autosave indicator, or a fresh save/load notice that
 * takes its place. The live region stays mounted while empty, because a region added together
 * with its text is not reliably announced.
 */
export const SaveStatusStrip = (): React.JSX.Element => {
  const indicator = useShownIndicator(useUiStore((state) => state.saves.autosave.indicator));
  const dialogOpen = useUiStore((state) => state.savesDialogOpen);
  const notice = useVisibleSaveNotice();
  const showNotice = !dialogOpen && notice !== null;
  const text = showNotice ? notice.text : indicatorLabel(indicator);
  const tone = showNotice && notice.kind === 'error' ? 'error' : indicator === 'failed' && !showNotice ? 'error' : '';
  return (
    <div className={`save-strip ${text ? 'visible' : ''} ${tone}`} role={tone === 'error' ? 'alert' : 'status'} aria-live={tone === 'error' ? 'assertive' : 'polite'}>
      {text}
    </div>
  );
};
