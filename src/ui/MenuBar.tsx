import { gameBridge } from '../app/gameBridge';
import { runBridge } from './runBridge';
import { ariaKeyShortcuts, useKeybindings, withKeyHint } from '../settings';
import { menuBarButtons, menuBarLiveLine, type MenuBarButtonId } from './menuBarModel';
import { showToast } from './showToast';
import { useUiStore } from './store';

/** First Day steps that ask the player to build something. */
const BUILD_STEPS: ReadonlySet<string> = new Set(['lay-path', 'first-ride', 'first-food', 'first-drink']);

/**
 * Phase 43: the main menu bar along the bottom edge: one button per main area, pressed while its panel is open, with a
 * badge when something there needs attention and one polite live line for all badges. The build menu opens above it.
 */
export const MenuBar = (): React.JSX.Element => {
  const keys = useKeybindings();
  const dockOpen = useUiStore((state) => state.dockOpen);
  const pulseOpen = useUiStore((state) => state.pulseOpen);
  const openWindows = useUiStore((state) => state.openWindows);
  const managementOpen = useUiStore((state) => state.managementOpen);
  const managementTab = useUiStore((state) => state.managementTab);
  const tool = useUiStore((state) => state.tool);
  const landRestricted = useUiStore((state) => state.land !== null);
  const inRun = useUiStore((state) => state.sessionMode === 'run' && state.run !== null);
  const management = useUiStore((state) => state.management);
  const noPathAccessIds = useUiStore((state) => state.noPathAccessIds);
  const progression = useUiStore((state) => state.progression);
  const onboarding = useUiStore((state) => state.onboarding);
  const hasMusic = useUiStore((state) => state.music !== null);
  const musicOpen = useUiStore((state) => state.musicPlayerOpen);
  const maintenance = management?.parkOperations.maintenance;
  const buttons = menuBarButtons({
    dockOpen,
    pulseOpen,
    openWindows,
    managementOpen,
    managementTab,
    landTool: tool === 'land',
    landRestricted,
    runMode: inRun,
    staffAttention: maintenance ? Math.max(maintenance.awaitingMechanic, maintenance.brokenRides) : 0,
    buildingsAttention: noPathAccessIds.length,
    researchReady: progression?.projects.filter((project) => project.status === 'affordable').length ?? 0,
    pulseWarnings: management?.notifications.length ?? 0,
    buildHinted: onboarding !== null && onboarding.active && onboarding.currentStepId !== null && BUILD_STEPS.has(onboarding.currentStepId),
    musicOpen: hasMusic ? musicOpen : null,
  });
  const press = (id: MenuBarButtonId): void => {
    const ui = useUiStore.getState();
    switch (id) {
      case 'build': ui.toggleDock(); return;
      case 'staff': ui.toggleWindow('staff'); return;
      case 'buildings': ui.toggleWindow('buildings'); return;
      case 'pulse': ui.togglePulse(); return;
      case 'finances':
      case 'research': {
        const tab = id;
        if (ui.managementOpen && ui.managementTab === tab) ui.closeManagement();
        else if (tab === 'research') ui.openResearch();
        else ui.openManagement('finances');
        return;
      }
      case 'land':
        if (ui.tool === 'land') ui.selectPointer();
        else ui.selectLandTool();
        return;
      case 'music': ui.setMusicPlayerOpen(!ui.musicPlayerOpen); return;
      case 'runMap': runBridge.openRunMap(); return;
      default: gameBridge.openParksChooser('modes');
    }
  };
  const live = menuBarLiveLine(buttons);
  return (
    <nav className="menu-bar" aria-label="Main menu">
      {buttons.map((entry) => {
        const title = [entry.action ? withKeyHint(entry.label, entry.action, keys) : entry.label, entry.attention, entry.disabledReason]
          .filter((part): part is string => part !== null).join(' · ');
        return (
          <button
            key={entry.id}
            className={`menu-bar-button${entry.pressed ? ' active' : ''}${entry.hinted ? ' hinted' : ''}`}
            data-menu-bar={entry.id}
            aria-pressed={entry.id === 'runMap' || entry.id === 'parks' ? undefined : entry.pressed}
            aria-disabled={entry.disabledReason !== null ? true : undefined}
            aria-keyshortcuts={entry.action ? ariaKeyShortcuts(entry.action, keys) : undefined}
            title={title}
            onClick={() => {
              if (entry.disabledReason !== null) {
                showToast(entry.disabledReason, 'alert');
                return;
              }
              press(entry.id);
            }}
          >
            <span className="menu-bar-icon" aria-hidden="true">{entry.icon}</span>
            <span className="menu-bar-label">{entry.label}</span>
            {entry.badge > 0 && <b className="menu-bar-badge" aria-hidden="true">{entry.badge > 9 ? '9+' : entry.badge}</b>}
          </button>
        );
      })}
      <span className="sr-only" role="status" aria-live="polite">{live}</span>
    </nav>
  );
};
