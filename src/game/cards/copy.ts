import { scaledResearchPoints } from '../progression/content';
import { compileParkRules, MULTIPLIER_DIRECTION, researchCostScaleOf, type CardModifiableRule, type CardModifiers } from '../scenarios/rules';
import type { TransactionCategory } from '../types';
import { RULE_COPY } from './ruleCopy';
import type { OneShotEffect } from './types';

/**
 * Generated card copy (Phase 25). A stage card's upside and downside are printed from its modifiers (RULE_COPY, the same
 * sentences the scenario screen uses), so the copy cannot disagree with the numbers; a one-shot's are templated from its
 * effect. Locale-free formatting: the copy is the same in every process.
 */

/** "$1,200"; "-$600" for a negative amount. Integer dollars, no locale. */
export const formatDollars = (amount: number): string => {
  const whole = Math.round(Math.abs(amount)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount < 0 ? '-' : ''}$${whole}`;
};

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
];

/** "four" for 4 (0..20), digits above. */
export const numberWord = (value: number): string => (
  Number.isInteger(value) && value >= 0 && value < NUMBER_WORDS.length ? NUMBER_WORDS[value] : String(value)
);

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** "one minute", "four minutes", "90 seconds". */
export const durationPhrase = (seconds: number): string => {
  if (seconds > 0 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${numberWord(minutes)} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
};

/** "1:30" for a countdown. */
export const formatCountdown = (seconds: number): string => {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** Appended to every deferred cost (design 3.6). */
export const DEFERRED_COST_NOTE = "if still unpaid when the level ends, it comes off the next level's starting cash";

/** Extra words for a rule whose plain sentence would mislead (the day length's direction rests on the sunny first day). */
const RULE_SUFFIX: Partial<Record<CardModifiableRule, (better: boolean) => string>> = {
  dayLengthMultiplier: (better) => (better ? ' (the sunny first day lasts)' : ' (weather turns sooner)'),
};

/** True when a multiplier helps the player. */
export const isUpside = (rule: CardModifiableRule, value: number): boolean => (
  value !== 1 && (MULTIPLIER_DIRECTION[rule] === 'higherIsBetter') === (value > 1)
);

/** One sentence for one modifier: "Guests arrive 20% faster". */
export const modifierLine = (rule: CardModifiableRule, value: number): string => {
  const better = isUpside(rule, value);
  const percent = Math.round(Math.abs(value - 1) * 100);
  return `${RULE_COPY[rule](percent, better)}${RULE_SUFFIX[rule]?.(better) ?? ''}`;
};

const joinLines = (lines: readonly string[]): string => lines.map((line, index) => (index === 0 ? capitalise(line) : lowerFirst(line))).join('; ');

/** A stage card's upside and downside, in modifier order, joined with "; ". */
export const stageCardLines = (modifiers: CardModifiers): { upside: string; downside: string } => {
  const up: string[] = [];
  const down: string[] = [];
  for (const [rule, value] of Object.entries(modifiers) as Array<[CardModifiableRule, number]>) {
    if (value === 1) continue;
    (isUpside(rule, value) ? up : down).push(modifierLine(rule, value));
  }
  return { upside: joinLines(up), downside: joinLines(down) };
};

/**
 * Phase 16: the research cost scale a NEW park compiles (`researchCostScale` of the default ruleset; 1 when the config is
 * neutral). Card and bonus copy that names research points is printed at this scale, because explicit RP grants are
 * scaled at application exactly like project costs.
 */
export const newParkResearchCostScale = (): number => researchCostScaleOf(compileParkRules());

/**
 * Phase 16: the Research Grant upside at a given scale ("200 research points now" for 20 base points at scale 10). Card
 * definitions print it at the new-park scale; a live park whose ruleset holds another scale (a park saved before the
 * scale existed) re-prints it with its own, so the line always says what a play grants.
 */
export const researchGrantUpside = (basePoints: number, researchCostScale: number): string => (
  `${scaledResearchPoints(basePoints, researchCostScale)} research points now`
);

const deferred = (line: string): string => `${line}; ${DEFERRED_COST_NOTE}`;

/** A one-shot's upside and downside, templated from its effect. */
export const oneShotLines = (effect: OneShotEffect): { upside: string; downside: string } => {
  switch (effect.kind) {
    case 'loan':
      return {
        upside: `${formatDollars(effect.amount)} now`,
        downside: deferred(`${formatDollars(effect.repay)} is taken back ${durationPhrase(effect.afterSeconds)} later`),
      };
    case 'research':
      return { upside: researchGrantUpside(effect.points, newParkResearchCostScale()), downside: `Costs ${formatDollars(effect.fee)} now` };
    case 'repair': {
      const upside = effect.scope === 'broken'
        ? 'Every broken ride is repaired at once'
        : 'Every idle ride serviced to full condition, breakdowns cleared';
      const unit = effect.scope === 'broken' ? 'per repaired ride' : 'per ride';
      const queues = effect.scope === 'all' ? '; their queues are sent away' : '';
      const downside = effect.afterSeconds === null
        ? `${formatDollars(effect.perRide)} ${unit} now${queues}`
        : deferred(`${formatDollars(effect.perRide)} ${unit} is billed ${durationPhrase(effect.afterSeconds)} later${queues}`);
      return { upside, downside };
    }
    case 'sweep':
      return { upside: 'Every litter pile cleared and every bin emptied now', downside: `${formatDollars(effect.fee)} crew wages now (counts against profit)` };
    case 'forecast':
      return { upside: `The next ${numberWord(effect.slots)} weather slots turn ${effect.weather}`, downside: `Costs ${formatDollars(effect.fee)} now` };
    case 'surge':
      return {
        upside: `${capitalise(numberWord(effect.guests))} guests arrive at once`,
        downside: deferred(`A ${formatDollars(effect.bill)} bill is due ${durationPhrase(effect.afterSeconds)} later`),
      };
    case 'cheer': {
      const up: string[] = [];
      const down: string[] = [];
      if (effect.happiness > 0) up.push(`Every guest's happiness rises ${effect.happiness}`);
      if (effect.happiness < 0) down.push(`Every guest's happiness drops ${-effect.happiness}`);
      if (effect.fee > 0) down.push(`Costs ${formatDollars(effect.fee)} now`);
      if (effect.fee < 0) up.push(`${formatDollars(-effect.fee)} now`);
      return { upside: joinLines(up), downside: joinLines(down) };
    }
  }
};

/** A money movement a one-shot makes: now (`afterSeconds` null) or scheduled. */
export interface OneShotTransaction {
  amount: number;
  label: string;
  category: TransactionCategory;
  afterSeconds: number | null;
  /** True when the amount is per affected ride (a repair). */
  perRide: boolean;
}

/**
 * Every transaction a one-shot can post, with its label and category. `other` labels are re-classified by regex in the
 * finance view (classifyTransaction), so a test runs each through it; no label may say grant, funding, refund, sales...
 */
export const oneShotTransactions = (name: string, effect: OneShotEffect): OneShotTransaction[] => {
  switch (effect.kind) {
    case 'loan':
      return [
        { amount: effect.amount, label: `${name} cash`, category: 'grant', afterSeconds: null, perRide: false },
        { amount: -effect.repay, label: `${name} repaid`, category: 'other', afterSeconds: effect.afterSeconds, perRide: false },
      ];
    case 'research':
      return [{ amount: -effect.fee, label: `${name} fee`, category: 'research', afterSeconds: null, perRide: false }];
    case 'repair':
      return [{ amount: -effect.perRide, label: `${name} repairs`, category: 'maintenance', afterSeconds: effect.afterSeconds, perRide: true }];
    case 'sweep':
      return [{ amount: -effect.fee, label: 'Sweep crew wages', category: 'staff-salaries', afterSeconds: null, perRide: false }];
    case 'forecast':
      return [{ amount: -effect.fee, label: `${name} fee`, category: 'other', afterSeconds: null, perRide: false }];
    case 'surge':
      return [{ amount: -effect.bill, label: `${name} bill`, category: 'other', afterSeconds: effect.afterSeconds, perRide: false }];
    case 'cheer':
      if (effect.fee > 0) return [{ amount: -effect.fee, label: `${name} costs`, category: 'other', afterSeconds: null, perRide: false }];
      if (effect.fee < 0) return [{ amount: -effect.fee, label: `${name} cash`, category: 'grant', afterSeconds: null, perRide: false }];
      return [];
  }
};
