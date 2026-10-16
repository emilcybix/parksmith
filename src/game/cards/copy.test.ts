import { describe, expect, it } from 'vitest';
import { classifyTransaction } from '../management/ManagementSimulation';
import { CARD_MODIFIABLE_RULES } from '../scenarios/rules';
import { PULSE_CARDS } from './content';
import { DEFERRED_COST_NOTE, durationPhrase, formatCountdown, formatDollars, modifierLine, numberWord, oneShotLines, oneShotTransactions, stageCardLines } from './copy';
import { RULE_COPY } from './ruleCopy';

/** Phase 25 (design 4, 11.1): the generated card copy, the one-shot templates and the transaction labels. */
const COLOUR_TERMS = /colou?r|swatch|recolou?r|paint|preset|palette/i;

describe('generated stage-card copy', () => {
  it('prints exactly one sentence per modifier, upsides then downsides, in modifier order, joined with "; "', () => {
    for (const card of PULSE_CARDS) {
      if (card.kind !== 'stage') continue;
      const lines = stageCardLines(card.modifiers);
      expect({ upside: card.upside, downside: card.downside }).toEqual(lines);
      const sentences = [...card.upside.split('; '), ...card.downside.split('; ')];
      expect(sentences, card.id).toHaveLength(Object.keys(card.modifiers).length);
      for (const [rule, value] of Object.entries(card.modifiers)) {
        const line = modifierLine(rule as never, value);
        expect(sentences.map((text) => text.toLowerCase()), `${card.id} ${rule}`).toContain(line.toLowerCase());
        expect(line).toContain(`${Math.round(Math.abs(value - 1) * 100)}%`);
      }
    }
  });

  it('reads like the design table for the cards it names', () => {
    const copy = (id: string) => {
      const card = PULSE_CARDS.find((entry) => entry.id === id)!;
      return [card.upside, card.downside];
    };
    expect(copy('grand-opening')).toEqual(['Guests arrive 20% faster', 'Guests carry 15% less money']);
    expect(copy('weather-station')).toEqual([
      'Rain, storms and heat bite 40% less; rain and storms 25% rarer',
      'Ride operating costs 20% higher; guests carry 10% less money',
    ]);
    expect(copy('long-days')).toEqual(['Days are 50% longer (the sunny first day lasts)', 'Staff wages 15% higher']);
    expect(copy('brisk-days')).toEqual(['Guests carry 10% more money', 'Days are 25% shorter (weather turns sooner)']);
    expect(copy('night-market')[0]).toBe('Night-time arrivals (21:30-05:00) 60% higher');
    expect(copy('bridging-loan')).toEqual(['$2,000 now', `$2,400 is taken back four minutes later; ${DEFERRED_COST_NOTE}`]);
    expect(copy('coach-party')).toEqual(['Twenty guests arrive at once', `A $900 bill is due one minute later; ${DEFERRED_COST_NOTE}`]);
    expect(copy('sponsor-banner')).toEqual(['$1,500 now', "Every guest's happiness drops 8"]);
    expect(copy('inspection-day')).toEqual(['Every idle ride serviced to full condition, breakdowns cleared', '$150 per ride now; their queues are sent away']);
  });

  it('every card-modifiable rule has a line both ways', () => {
    for (const rule of CARD_MODIFIABLE_RULES) {
      expect(RULE_COPY[rule](10, true).length).toBeGreaterThan(0);
      expect(RULE_COPY[rule](10, true)).not.toBe(RULE_COPY[rule](10, false));
    }
  });
});

describe('one-shot copy', () => {
  it('every number of a one-shot effect appears in its copy, and every deferred cost carries the debt note', () => {
    for (const card of PULSE_CARDS) {
      if (card.kind !== 'one-shot') continue;
      const text = `${card.upside} | ${card.downside}`;
      expect({ upside: card.upside, downside: card.downside }).toEqual(oneShotLines(card.effect));
      const effect = card.effect;
      const money: number[] = [];
      const counts: number[] = [];
      const seconds: number[] = [];
      switch (effect.kind) {
        case 'loan': money.push(effect.amount, effect.repay); seconds.push(effect.afterSeconds); break;
        case 'research': money.push(effect.fee); counts.push(effect.points); break;
        case 'repair': money.push(effect.perRide); if (effect.afterSeconds !== null) seconds.push(effect.afterSeconds); break;
        case 'sweep': money.push(effect.fee); break;
        case 'forecast': money.push(effect.fee); counts.push(effect.slots); break;
        case 'surge': money.push(effect.bill); counts.push(effect.guests); seconds.push(effect.afterSeconds); break;
        case 'cheer': money.push(Math.abs(effect.fee)); counts.push(Math.abs(effect.happiness)); break;
      }
      for (const amount of money) expect(text, card.id).toContain(formatDollars(amount));
      for (const count of counts) expect(text.toLowerCase().includes(String(count)) || text.toLowerCase().includes(numberWord(count)), `${card.id} ${count}`).toBe(true);
      for (const value of seconds) expect(text, card.id).toContain(durationPhrase(value));
      expect(card.downside.includes(DEFERRED_COST_NOTE), card.id).toBe(seconds.length > 0);
    }
  });

  it('formats money, durations and countdowns without a locale', () => {
    expect(formatDollars(1_200)).toBe('$1,200');
    expect(formatDollars(-6_250)).toBe('-$6,250');
    expect(formatDollars(1_234_567)).toBe('$1,234,567');
    expect(formatDollars(0)).toBe('$0');
    expect(durationPhrase(60)).toBe('one minute');
    expect(durationPhrase(240)).toBe('four minutes');
    expect(durationPhrase(90)).toBe('90 seconds');
    expect(formatCountdown(90)).toBe('1:30');
    expect(formatCountdown(0)).toBe('0:00');
    expect(numberWord(20)).toBe('twenty');
    expect(numberWord(21)).toBe('21');
  });

  it('no card text uses the colour terms (colourNoRequirement.test.ts)', () => {
    for (const card of PULSE_CARDS) expect(JSON.stringify(card), card.id).not.toMatch(COLOUR_TERMS);
  });
});

describe('transaction labels', () => {
  it('every label lands in its declared category in the finance view (no "other" label is re-classified by its words)', () => {
    const declared: Record<string, string> = { grant: 'grants', research: 'research', maintenance: 'maintenance', 'staff-salaries': 'staffSalaries', other: 'other' };
    let seen = 0;
    for (const card of PULSE_CARDS) {
      if (card.kind !== 'one-shot') continue;
      for (const transaction of oneShotTransactions(card.name, card.effect)) {
        seen += 1;
        expect(transaction.label.length).toBeLessThanOrEqual(80);
        expect(classifyTransaction(transaction), `${card.id}: "${transaction.label}"`).toBe(declared[transaction.category]);
        // The label alone (as an old build or a category-less reader would see it) is not re-classified either.
        if (transaction.category === 'other') expect(classifyTransaction({ amount: transaction.amount, label: transaction.label })).toBe('other');
      }
    }
    expect(seen).toBeGreaterThanOrEqual(11);
  });
});
