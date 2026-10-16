import { describe, expect, it } from 'vitest';
import { describeLand } from './landModel';

/** Phase 33: the Land KPI and the Land button tooltip share one description of the estate. */
describe('describeLand', () => {
  it('says the parcels owned and the cheapest next price', () => {
    const view = describeLand({ ownedParcels: 12, totalParcels: 64, forSaleParcels: 9, cheapestPrice: 1230 });
    expect(view.summary).toBe('12 of 64 parcels owned · from $1,230');
    expect(view.owned).toBe('12');
    expect(view.of).toBe('/ 64');
    expect(view.note).toBe('from $1,230');
  });

  it('says when every parcel is owned', () => {
    const view = describeLand({ ownedParcels: 64, totalParcels: 64, forSaleParcels: 0, cheapestPrice: null });
    expect(view.summary).toBe('64 of 64 parcels owned');
    expect(view.note).toBe('all owned');
  });

  it('says when nothing is for sale though land is left', () => {
    const view = describeLand({ ownedParcels: 10, totalParcels: 64, forSaleParcels: 0, cheapestPrice: null });
    expect(view.summary).toBe('10 of 64 parcels owned');
    expect(view.note).toBe('none for sale');
  });
});
