import { useEffect, useRef, useState } from 'react';
import { GameApp } from '../app/GameApp';
import { BuildDock, ViewControls, CoasterPanel, CursorReadout, GuestInspector, HelpHint, ParkPulse, PerformanceOverlay, RideInspector, ServiceInspector, Toast, TopBar, UtilityBar } from './Hud';
import { MainMenu } from './MainMenu';
import { ManagementDashboard, ManagementNotifications } from './ManagementDashboard';
import { RecoveryPrompt } from './RecoveryPrompt';
import { SaveBanner, SaveStatusStrip, useSaveBannerVisible } from './SaveBanner';
import { PaintPanel, SaveLoadDialog, SettingsDialog, prefetchLazyPanels } from './lazyPanels';
import { LeaveRunPrompt } from './LeaveRunPrompt';
import { RunScreen } from './RunScreen';
import { ScenarioPicker, ScenarioResultOverlay } from './ScenarioHud';
import { useUiStore } from './store';
import { FatalScreen } from './FatalScreen';
import { GAME_VERSION } from './aboutModel';

/** Phase 19 (PA-026): the branded loading state while the renderer starts (index.html shows the same before scripts run). */
const BootScreen = (): React.JSX.Element => (
  <div className="boot-screen" role="status" aria-live="polite">
    <span className="brand-mark" aria-hidden="true">P</span>
    <strong>Parksmith</strong>
    <span>Opening the park gates…</span>
    <i className="boot-dots" aria-hidden="true"><b /><b /><b /></i>
    <small>v{GAME_VERSION}</small>
  </div>
);

export const App = (): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const fatalError = useUiStore((state) => state.fatalError);
  const managementOpen = useUiStore((state) => state.managementOpen);
  const cleanView = useUiStore((state) => state.cleanView);
  const menuKind = useUiStore((state) => state.menuKind);
  // Behind the start screen the park is only a backdrop: no HUD at all. Behind the pause menu it stays
  // visible but inert, so neither the mouse nor Tab can reach it.
  const hudHidden = cleanView || menuKind === 'start';
  const saveBannerVisible = useSaveBannerVisible();

  useEffect(() => {
    if (!hostRef.current) return;
    const game = new GameApp();
    void game.mount(hostRef.current).then(() => {
      setBooted(true);
      // Phase 35: once the park is on screen, fetch the lazy panels while the browser is idle (silent if it fails).
      void game.firstFrame.then(() => prefetchLazyPanels());
    }, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'The park renderer could not start.');
    });
    return () => game.destroy();
  }, []);

  return (
    <main className="app-shell">
      <h1 className="sr-only">Parksmith</h1>
      <div ref={hostRef} className="world-host" />
      {!booted && error === null && <BootScreen />}
      {error !== null || fatalError !== null ? <FatalScreen message={error ?? fatalError ?? ''} /> : (
        <div className={`ui-layer ${managementOpen ? 'management-open' : ''} ${saveBannerVisible ? 'save-banner-open' : ''} ${cleanView ? 'clean-view' : ''}`}>
          <div className="clean-hideable" hidden={hudHidden} inert={menuKind !== null}>
            <TopBar />
            <ParkPulse />
            <UtilityBar />
            <PerformanceOverlay />
            <RideInspector />
            <ServiceInspector />
            <GuestInspector />
            <PaintPanel />
            <ManagementDashboard />
            <ManagementNotifications />
            <CursorReadout />
            <CoasterPanel />
          </div>
          <MainMenu />
          <ScenarioPicker />
          <RunScreen />
          <LeaveRunPrompt />
          <ScenarioResultOverlay />
          <SettingsDialog />
          <SaveLoadDialog />
          <RecoveryPrompt />
          <SaveStatusStrip />
          <SaveBanner />
          <Toast />
          <div className="clean-hideable" hidden={hudHidden} inert={menuKind !== null}>
            <HelpHint />
            <BuildDock />
          </div>
          <ViewControls />
        </div>
      )}
    </main>
  );
};
