import { gameBridge } from '../app/gameBridge';

/** The close button of the building inspector `focusBuilding` opens (the ride or the stall one, never the guest one). */
const OPENED_INSPECTOR_FOCUS = '.ride-inspector:not(.guest-inspector) header button[aria-label="Close inspector"]';

/**
 * Phase 30, the owner's feature: "→ Cloud Hopper" after a complaint about a building, in Park Pulse, the guest
 * inspector and the dashboard's Live signals and Repeated thoughts (one component, so every place names it the same
 * way: "Show <name>", which contains the visible name). Pressing it eases the camera to the building and opens its
 * inspector (`focusBuilding`, which also closes the dashboard). The link's own panel may unmount on the way (the guest
 * inspector, the dashboard), so on the next frame keyboard focus moves into the opened inspector rather than dropping
 * to the page; the inspector's focus return then gives it back to whatever had it before. Rendered only while the
 * building stands (the simulation drops a demolished one's id), so it never leads nowhere.
 */
export const ComplaintLink = ({ objectId, objectName, className }: {
  objectId: number;
  objectName: string;
  className: string;
}): React.JSX.Element => (
  <button
    type="button"
    className={className}
    onClick={() => {
      gameBridge.focusBuilding(objectId);
      focusOpenedInspector();
    }}
    title={`Show ${objectName} and open its inspector`}
    aria-label={`Show ${objectName}`}
  ><span aria-hidden="true">→ </span>{objectName}</button>
);

/** Moves focus to the opened building inspector once React has rendered it (a no-op without a DOM). */
export const focusOpenedInspector = (): void => {
  if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(OPENED_INSPECTOR_FOCUS)?.focus();
  });
};
