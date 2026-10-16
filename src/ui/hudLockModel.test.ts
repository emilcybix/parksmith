import { describe, expect, it } from 'vitest';
import { unlockConditionText } from '../game/profile/unlocks';
import { ParkSession } from '../game/session/ParkSession';
import { profileLockView, researchRequirementLine } from './hudLockModel';

describe('profile lock text', () => {
  it('shortens the condition for the badge and phrases the hint for the title and toast', () => {
    const view = profileLockView('Clear Frost Fair in Scenario mode or on The Map');
    expect(view.reason).toBe('Clear Frost Fair');
    expect(view.hint).toBe('Unlock by clearing Frost Fair in Scenario mode or on The Map');
  });

  it('reads the real condition of a gated entry', () => {
    const view = profileLockView(unlockConditionText('tiki-tumbler'));
    expect(view.reason).toBe('Clear Boardwalk Breeze');
    expect(view.hint).toBe('Unlock by clearing Boardwalk Breeze in Scenario mode');
  });

  it('passes an unfamiliar text through', () => {
    expect(profileLockView('Unlock it by playing scenarios')).toEqual({ reason: 'Unlock it by playing scenarios', hint: 'Unlock it by playing scenarios' });
  });
});

describe('research requirement line (Phase 33)', () => {
  const projects = new ParkSession(null).progression.snapshot().projects;
  const project = (id: string) => projects.find((candidate) => candidate.id === id)!;

  it('states an opener as its effective RP and cash', () => {
    const spin = project('spin-studies');
    expect(researchRequirementLine(spin)).toBe(`${spin.researchPointCost.toLocaleString('en-US')} RP · $${spin.cashCost.toLocaleString('en-US')}`);
  });

  it('names the prerequisite study and a rating milestone by its target', () => {
    const thrill = project('thrill-engineering');
    expect(researchRequirementLine(thrill)).toBe(`${thrill.researchPointCost.toLocaleString('en-US')} RP · $1,100 · after Vertical Motion · rating 60`);
  });

  it('formats every requirement kind exactly', () => {
    expect(researchRequirementLine({ researchPointCost: 120, cashCost: 800, prerequisiteIds: ['spin-studies'], requiredMilestoneIds: [] })).toBe('120 RP · $800 · after Spin Studies');
    expect(researchRequirementLine({ researchPointCost: 1200, cashCost: 2500, prerequisiteIds: ['spin-studies', 'garden-appeal'], requiredMilestoneIds: ['experiences-100', 'rating-70'] }))
      .toBe('1,200 RP · $2,500 · after Spin Studies + Garden Appeal · 100 experiences · rating 70');
  });

  it('every project of the tree fits one short card line', () => {
    for (const candidate of projects) expect(researchRequirementLine(candidate).length, candidate.id).toBeLessThanOrEqual(60);
  });
});
