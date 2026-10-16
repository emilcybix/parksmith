/**
 * Pure copy for demolishing from a ride or service inspector (Phase 11, PA-015): the button, and the confirmation
 * group that replaces it. Focus lands on Keep it, the safe button. The refund is `World.demolitionRefund(id)`,
 * published by GameApp as `selectedDemolitionRefund`. The bulldozer's coaster two-click copy lives in
 * `src/app/placementFeedback.ts`.
 */

export const DEMOLISH_CONFIRM_GROUP_LABEL = 'Confirm demolition';
export const DEMOLISH_KEEP_LABEL = 'Keep it';
export const DEMOLISH_CONFIRM_LABEL = 'Demolish';

const money = (amount: number): string => `$${Math.round(amount).toLocaleString('en-US')}`;

/** The inspector button: `Demolish · refund $340` (just `Demolish` before the refund is known). */
export const demolishButtonLabel = (refund: number | null): string =>
  refund === null ? 'Demolish' : `Demolish · refund ${money(refund)}`;

/** The confirmation question: `Demolish Comet Coaster? You get $340 back.` */
export const demolishConfirmText = (name: string, refund: number | null): string =>
  refund === null ? `Demolish ${name}?` : `Demolish ${name}? You get ${money(refund)} back.`;
