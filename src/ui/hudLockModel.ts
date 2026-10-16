import { RESEARCH_MILESTONE_BY_ID, RESEARCH_PROJECTS } from '../game/progression/content';
import type { ResearchMilestoneId, ResearchProjectSnapshot } from '../game/progression/types';
import { shortenUnlockCondition, unlockHint } from './unlockCopy';

/**
 * A profile-locked build card (Phase 22) as text: the badge reason ("Clear Frost Fair"), the title / description and
 * the toast a click gives. `text` is what the session says ("Clear Frost Fair in Scenario mode").
 */
export interface ProfileLockView {
  /** After the trophy: "Clear Frost Fair". */
  reason: string;
  /** "Unlock by clearing Frost Fair in Scenario mode". */
  hint: string;
}

export const profileLockView = (text: string): ProfileLockView => ({
  reason: shortenUnlockCondition(text),
  hint: unlockHint(text),
});

const PROJECT_NAMES: ReadonlyMap<string, string> = new Map(RESEARCH_PROJECTS.map((project) => [project.id, project.name]));

/** "rating 60" or "25 experiences": the milestone's own target, shorter than its name ("Rising Reputation"). */
const milestoneRequirement = (id: ResearchMilestoneId): string => {
  const milestone = RESEARCH_MILESTONE_BY_ID.get(id);
  if (milestone === undefined) return id;
  return milestone.metric === 'rating' ? `rating ${milestone.target}` : `${milestone.target} experiences`;
};

/**
 * Phase 33: what a research-locked build card needs, in one short line from the project snapshot: the effective RP
 * cost, the cash, the prerequisite projects and the milestones ("120 RP · $800 · after Spin Studies · rating 60").
 * Every requirement is named, met or not, because the line states the project's terms; the research card marks which
 * are still missing.
 */
export const researchRequirementLine = (
  project: Pick<ResearchProjectSnapshot, 'researchPointCost' | 'cashCost' | 'prerequisiteIds' | 'requiredMilestoneIds'>,
  projectNames: ReadonlyMap<string, string> = PROJECT_NAMES,
): string => {
  const parts = [`${project.researchPointCost.toLocaleString('en-US')} RP`, `$${project.cashCost.toLocaleString('en-US')}`];
  if (project.prerequisiteIds.length > 0) {
    parts.push(`after ${project.prerequisiteIds.map((id) => projectNames.get(id) ?? id).join(' + ')}`);
  }
  for (const id of project.requiredMilestoneIds) parts.push(milestoneRequirement(id));
  return parts.join(' · ');
};
