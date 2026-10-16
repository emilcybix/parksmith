import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { menuBarButtons, menuBarLiveLine, type MenuBarInput } from './menuBarModel';
import { MenuBar } from './MenuBar';
import { useUiStore } from './store';

/** Phase 43: the main menu bar: buttons, pressed states, badges, the live line and the markup. */
const base: MenuBarInput = {
  dockOpen: true, pulseOpen: true, openWindows: [], managementOpen: false, managementTab: 'overview', landTool: false,
  landRestricted: false, runMode: false, staffAttention: 0, buildingsAttention: 0, researchReady: 0, pulseWarnings: 0, buildHinted: false,
};

describe('Phase 43: menu bar model', () => {
  it('has the eight areas in order, Parks outside a run and Run map in one', () => {
    expect(menuBarButtons(base).map((button) => button.id)).toEqual(['build', 'staff', 'buildings', 'pulse', 'finances', 'research', 'land', 'parks']);
    expect(menuBarButtons({ ...base, runMode: true }).at(-1)!.id).toBe('runMap');
  });

  it('shows each panel as pressed while it is open', () => {
    const pressed = (input: Partial<MenuBarInput>) => menuBarButtons({ ...base, dockOpen: false, pulseOpen: false, ...input }).filter((button) => button.pressed).map((button) => button.id);
    expect(pressed({})).toEqual([]);
    expect(pressed({ dockOpen: true })).toEqual(['build']);
    expect(pressed({ openWindows: ['staff', 'buildings'] })).toEqual(['staff', 'buildings']);
    expect(pressed({ managementOpen: true, managementTab: 'research' })).toEqual(['research']);
    expect(pressed({ managementOpen: true, managementTab: 'finances' })).toEqual(['finances']);
    expect(pressed({ landTool: true })).toEqual(['land']);
  });

  it('badges appear and clear with their condition, and one live line reads them all', () => {
    const quiet = menuBarButtons(base);
    expect(quiet.every((button) => button.badge === 0)).toBe(true);
    expect(menuBarLiveLine(quiet)).toBe('');
    const busy = menuBarButtons({ ...base, staffAttention: 2, researchReady: 1, pulseOpen: false, pulseWarnings: 3 });
    expect(busy.find((button) => button.id === 'staff')!.badge).toBe(2);
    expect(busy.find((button) => button.id === 'pulse')!.badge).toBe(3);
    expect(menuBarLiveLine(busy)).toBe('2 rides need a mechanic. 3 new Park Pulse warnings. 1 research project ready.');
    expect(menuBarButtons({ ...base, pulseWarnings: 3 }).find((button) => button.id === 'pulse')!.badge, 'no badge while Pulse is open').toBe(0);
  });

  it('a First Day build step with the dock closed hints at Build; Land explains itself off an estate', () => {
    expect(menuBarButtons({ ...base, dockOpen: false, buildHinted: true })[0].hinted).toBe(true);
    expect(menuBarButtons({ ...base, buildHinted: true })[0].hinted, 'the dock is already open').toBe(false);
    expect(menuBarButtons(base).find((button) => button.id === 'land')!.disabledReason).toMatch(/owns all of its land/);
    expect(menuBarButtons({ ...base, landRestricted: true }).find((button) => button.id === 'land')!.disabledReason).toBeNull();
  });

  it('renders as a labelled nav with every button and its key in the tooltip', () => {
    const html = renderToStaticMarkup(<MenuBar />);
    expect(html).toContain('aria-label="Main menu"');
    expect((html.match(/data-menu-bar=/g) ?? []).length).toBe(8);
    expect(html).toMatch(/title="Staff \(K\)/);
    expect(useUiStore.getState().dockOpen).toBe(true);
  });
});
