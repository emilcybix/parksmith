import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { columnsFromOffsets, rovingTarget, type RovingOptions } from './a11yModel';

/**
 * The DOM half of the keyboard rules in a11yModel.ts: roving focus for tablists and grids, focus
 * that returns to the control that opened a panel, and a Tab trap for modal layers. Each is small
 * and does one thing; the decisions (which key goes where) live in the pure model.
 */

const ROVING_ITEM = '[data-roving-item]';

/**
 * onKeyDown for a roving group. Items are marked `data-roving-item`; the one that is the tab stop
 * has tabIndex 0 (the caller renders that), the rest -1. Arrows, Home and End move focus to the
 * target item and call `onMove` so the caller can select it (a tablist selects on focus) or
 * remember it as the new tab stop. Disabled items are skipped; aria-disabled ones stay reachable,
 * because the project keeps them focusable on purpose (they say why they are unavailable).
 */
export const handleRovingKey = (
  event: ReactKeyboardEvent<HTMLElement>,
  options: RovingOptions,
  onMove?: (element: HTMLElement, index: number) => void,
): void => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const container = event.currentTarget;
  const current = (event.target as HTMLElement).closest<HTMLElement>(ROVING_ITEM);
  if (!current || !container.contains(current)) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>(ROVING_ITEM)).filter((item) => !(item as HTMLButtonElement).disabled);
  const index = items.indexOf(current);
  if (index < 0) return;
  const columns = options.orientation === 'both' ? columnsFromOffsets(items.map((item) => item.offsetTop)) : 1;
  const target = rovingTarget(event.key, index, items.length, { ...options, columns });
  if (target === null) return;
  event.preventDefault();
  event.stopPropagation();
  if (target === index) return;
  items[target].focus();
  onMove?.(items[target], target);
};

/**
 * Remembers what had focus when a panel opened and gives it back when the panel goes away while
 * focus is lost (the focused control was inside the panel, so the browser dropped it on `body`).
 * If the player moved focus somewhere real in the meantime, it is left alone. A panel opened by a
 * click on the map has no opener to return to, and nothing happens.
 */
export const useFocusReturn = (open: boolean, containerRef?: RefObject<HTMLElement | null>): void => {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !containerRef?.current?.contains(active)) opener.current = active;
    return () => {
      const target = opener.current;
      opener.current = null;
      if (!target) return;
      const now = document.activeElement;
      const lost = now === null || now === document.body || !now.isConnected;
      if (lost && target.isConnected) target.focus();
    };
  // The container ref is a stable object; only the open flag drives this.
  }, [open]);
};

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const visibleFocusables = (root: HTMLElement): HTMLElement[] => (
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => !element.closest('[inert],[hidden]') && element.getClientRects().length > 0)
);

/**
 * A modal layer: focus moves into it when it opens (to `initialSelector` when given, else the first
 * control), Tab and Shift+Tab wrap inside it, and focus goes back to the opener when it closes.
 * Escape is not handled here: GameApp owns it through the input context stack.
 */
export const useModalFocus = (active: boolean, rootRef: RefObject<HTMLElement | null>, initialSelector?: string): void => {
  useEffect(() => {
    if (!active) return undefined;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const root = rootRef.current;
    if (root) {
      const initial = initialSelector ? root.querySelector<HTMLElement>(initialSelector) : null;
      (initial ?? visibleFocusables(root)[0])?.focus();
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const layer = rootRef.current;
      if (!layer) return;
      // Another modal on top of this one (Save / Load over the run map) owns Tab.
      const topmost = Array.from(document.querySelectorAll('[aria-modal="true"]')).filter((node) => (node as HTMLElement).getClientRects().length > 0).pop();
      if (topmost && !layer.contains(topmost) && topmost !== layer && !topmost.contains(layer)) return;
      const focusable = visibleFocusables(layer);
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const here = document.activeElement;
      if (!layer.contains(here)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
      if (event.shiftKey && here === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && here === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (opener?.isConnected) {
        const now = document.activeElement;
        if (now === null || now === document.body || !now.isConnected || rootRef.current?.contains(now)) opener.focus();
      }
    };
  // Re-run only when the layer opens or closes.
  }, [active]);
};
