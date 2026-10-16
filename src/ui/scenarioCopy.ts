import {
  CARD_MODIFIABLE_RULES,
  MULTIPLIER_DIRECTION,
  type CardModifiableRule,
  type ParkRuleset,
} from '../game/scenarios/rules';
import { RULE_COPY } from '../game/cards/ruleCopy';
import type { ObjectiveDefinition, ObjectiveMetric } from '../game/scenarios/types';

/**
 * Plain-English copy for objectives and rule changes, shared by the HUD panel, the loadout, the Scenario browser
 * and the result overlay (it used to live inside ScenarioHud.tsx). UI copy only, never parsed.
 */

export const METRIC_COPY: Record<ObjectiveMetric, { label: string; format: (value: number) => string }> = {
  cumulativeGuests: { label: 'total visitors', format: (value) => `${Math.round(value)}` },
  guestCount: { label: 'guests in the park', format: (value) => `${Math.round(value)}` },
  parkRating: { label: 'park rating', format: (value) => `${Math.round(value)}` },
  averageHappiness: { label: 'average happiness', format: (value) => `${Math.round(value)}%` },
  operatingProfit: { label: 'operating profit', format: (value) => `$${Math.round(value).toLocaleString('en-US')}` },
  averageQueueSeconds: { label: 'average queue time', format: (value) => `${Math.round(value)}s` },
  ownedParcels: { label: 'parcels of land owned', format: (value) => `${Math.round(value)}` },
};

export interface EffectiveModifier {
  rule: CardModifiableRule;
  text: string;
  beneficial: boolean;
}

export const describeEffectiveModifiers = (rules: ParkRuleset): EffectiveModifier[] => (
  CARD_MODIFIABLE_RULES
    .filter((rule) => Math.abs(rules[rule] - 1) > 0.0005)
    .map((rule) => {
      const multiplier = rules[rule];
      const percent = Math.round(Math.abs(multiplier - 1) * 100);
      const beneficial = MULTIPLIER_DIRECTION[rule] === 'higherIsBetter' ? multiplier > 1 : multiplier < 1;
      return { rule, text: RULE_COPY[rule](percent, beneficial), beneficial };
    })
);

/** "7:05" for seconds of park time. */
export const formatClock = (seconds: number): string => {
  const whole = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

export const objectiveSentence = (objective: Pick<ObjectiveDefinition, 'kind' | 'metric' | 'target'> & {
  comparison?: 'atLeast' | 'atMost';
  durationSeconds?: number;
}): string => {
  const copy = METRIC_COPY[objective.metric];
  if (objective.kind === 'sustain') {
    return `Hold ${copy.label} ${objective.comparison === 'atMost' ? 'at or below' : 'at or above'} `
      + `${copy.format(objective.target)} for ${formatClock(objective.durationSeconds ?? 0)}.`;
  }
  return `${objective.kind === 'earn' ? 'Earn' : 'Reach'} ${copy.format(objective.target)} ${copy.label} before time runs out.`;
};
