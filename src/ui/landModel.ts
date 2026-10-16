import type { LandUi } from './store';

/**
 * Phase 33: the park's land in words, from the one `LandUi` GameApp publishes. The Land button's tooltip and the
 * Overview's Land KPI read the same figures, so they can never disagree. Only an estate (restricted land) has a
 * `LandUi`; a wholly owned park has none and shows neither.
 */
export interface LandView {
  /** "12 of 64 parcels owned · from $1,230" (the Land button tooltip, before its key hint). */
  summary: string;
  /** The KPI's big figure: the parcels owned. */
  owned: string;
  /** Beside it: "/ 64". */
  of: string;
  /** Under it: "from $1,230", or "all owned" / "none for sale". */
  note: string;
}

const money = (value: number): string => `$${value.toLocaleString('en-US')}`;

export const describeLand = (land: LandUi): LandView => {
  const price = land.cheapestPrice === null ? null : `from ${money(land.cheapestPrice)}`;
  return {
    summary: `${land.ownedParcels} of ${land.totalParcels} parcels owned${price === null ? '' : ` · ${price}`}`,
    owned: String(land.ownedParcels),
    of: `/ ${land.totalParcels}`,
    note: price ?? (land.ownedParcels >= land.totalParcels ? 'all owned' : 'none for sale'),
  };
};
