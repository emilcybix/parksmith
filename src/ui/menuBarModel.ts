import type { ActionId } from '../settings/keybindings';

/**
 * Phase 43: the main menu bar's pure model: one button per main area of the game (Build, Staff, Buildings, Park Pulse,
 * Finances, Research, Land, and the Run map or Parks), whether each is pressed (its panel is open), its attention badge
 * and the one live line that reads every badge out. No store, no DOM.
 */
export type MenuBarButtonId = 'build' | 'staff' | 'buildings' | 'pulse' | 'finances' | 'research' | 'land' | 'music' | 'runMap' | 'parks';

export interface MenuBarInput {
  dockOpen: boolean;
  pulseOpen: boolean;
  openWindows: readonly string[];
  managementOpen: boolean;
  managementTab: string;
  landTool: boolean;
  /** The park has land to buy (an estate); elsewhere the Land button explains itself instead. */
  landRestricted: boolean;
  runMode: boolean;
  /** Rides broken or waiting for a mechanic. */
  staffAttention: number;
  /** Buildings guests cannot reach (no path access, a Phase 40 front facing no path). */
  buildingsAttention: number;
  /** Research projects the park can buy now. */
  researchReady: number;
  /** Management warnings while Park Pulse is closed (the card would show them). */
  pulseWarnings: number;
  /** A First Day step asks the player to build while the dock is closed: the Build button is the way in. */
  buildHinted: boolean;
  /** The music player: open or closed, or null while there is no produced music (the button is then left out). */
  musicOpen?: boolean | null;
}

export interface MenuBarButton {
  id: MenuBarButtonId;
  label: string;
  icon: string;
  /** The rebindable action that does the same (its key goes in the tooltip). */
  action: ActionId | null;
  pressed: boolean;
  badge: number;
  /** Plain words for the tooltip and the live line, or null when nothing needs attention. */
  attention: string | null;
  hinted: boolean;
  disabledReason: string | null;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export const menuBarButtons = (input: MenuBarInput): MenuBarButton[] => {
  const button = (id: MenuBarButtonId, label: string, icon: string, action: ActionId | null, pressed: boolean, badge = 0, attention: string | null = null): MenuBarButton => ({
    id, label, icon, action, pressed, badge, attention: badge > 0 ? attention : null, hinted: false, disabledReason: null,
  });
  const buttons: MenuBarButton[] = [
    { ...button('build', 'Build', '▦', 'toggleBuildMenu', input.dockOpen), hinted: input.buildHinted && !input.dockOpen },
    button('staff', 'Staff', '☺', 'staffWindow', input.openWindows.includes('staff'), input.staffAttention,
      plural(input.staffAttention, 'ride needs a mechanic', 'rides need a mechanic')),
    button('buildings', 'Buildings', '▤', 'buildingsWindow', input.openWindows.includes('buildings'), input.buildingsAttention,
      plural(input.buildingsAttention, 'building has no path access', 'buildings have no path access')),
    button('pulse', 'Park Pulse', '♥', 'togglePulse', input.pulseOpen, input.pulseOpen ? 0 : input.pulseWarnings,
      plural(input.pulseWarnings, 'new Park Pulse warning', 'new Park Pulse warnings')),
    button('finances', 'Finances', '$', 'openFinances', input.managementOpen && input.managementTab === 'finances'),
    button('research', 'Research', '⚗', 'openResearch', input.managementOpen && input.managementTab === 'research', input.researchReady,
      plural(input.researchReady, 'research project ready', 'research projects ready')),
    {
      ...button('land', 'Land', '⬚', 'landTool', input.landTool),
      disabledReason: input.landRestricted ? null : 'This park owns all of its land',
    },
    ...(input.musicOpen === undefined || input.musicOpen === null ? [] : [button('music', 'Music', '♪', null, input.musicOpen)]),
    input.runMode ? button('runMap', 'Run map', '⚑', null, false) : button('parks', 'Parks', '⚑', null, false),
  ];
  return buttons;
};

/** The one polite live line for every badge (empty when nothing needs attention). */
export const menuBarLiveLine = (buttons: readonly MenuBarButton[]): string => (
  buttons.map((entry) => entry.attention).filter((line): line is string => line !== null).map((line) => `${line[0].toUpperCase()}${line.slice(1)}.`).join(' ')
);
