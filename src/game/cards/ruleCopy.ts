import type { CardModifiableRule } from '../scenarios/rules';

/**
 * Turns one effective multiplier into a human sentence: `percent` is |m - 1| in whole percent, `better` whether the
 * change helps the player (MULTIPLIER_DIRECTION). Game code (the generated card copy) and the UI (scenarioCopy.ts)
 * share it; typed over every card-modifiable rule, so a new key without a line is a compile error.
 */
export const RULE_COPY: Readonly<Record<CardModifiableRule, (percent: number, better: boolean) => string>> = {
  arrivalIntervalMultiplier: (p, better) => `Guests arrive ${p}% ${better ? 'faster' : 'slower'}`,
  guestBudgetMultiplier: (p, better) => `Guests carry ${p}% ${better ? 'more' : 'less'} money`,
  servicePriceToleranceMultiplier: (p, better) => `Guests tolerate ${p}% ${better ? 'higher' : 'lower'} prices`,
  needDecayMultiplier: (p, better) => `Guest needs grow ${p}% ${better ? 'slower' : 'faster'}`,
  constructionCostMultiplier: (p, better) => `Construction costs ${p}% ${better ? 'less' : 'more'}`,
  rideOperatingCostMultiplier: (p, better) => `Ride operating costs ${p}% ${better ? 'lower' : 'higher'}`,
  rideDispatchMultiplier: (p, better) => `Rides dispatch ${p}% ${better ? 'sooner' : 'later'}`,
  serviceDurationMultiplier: (p, better) => `Services work ${p}% ${better ? 'faster' : 'slower'}`,
  needReliefMultiplier: (p, better) => `Purchases relieve ${p}% ${better ? 'more' : 'less'} need`,
  staffSalaryMultiplier: (p, better) => `Staff wages ${p}% ${better ? 'lower' : 'higher'}`,
  staffSpeedMultiplier: (p, better) => `Staff walk ${p}% ${better ? 'faster' : 'slower'}`,
  chainLiftCostMultiplier: (p, better) => `Chain lifts ${p}% ${better ? 'cheaper' : 'dearer'}`,
  recolourCostMultiplier: (p, better) => `Recolouring costs ${p}% ${better ? 'less' : 'more'}`,
  wetWeatherMultiplier: (p, better) => `Rain and storms ${p}% ${better ? 'rarer' : 'more common'}`,
  weatherEffectMultiplier: (p, better) => `Rain, storms and heat bite ${p}% ${better ? 'less' : 'harder'}`,
  nightArrivalMultiplier: (p, better) => `Night-time arrivals (21:30-05:00) ${p}% ${better ? 'higher' : 'lower'}`,
  dayLengthMultiplier: (p, better) => `Days are ${p}% ${better ? 'longer' : 'shorter'}`,
  crowdCapacityMultiplier: (p, better) => `The park holds ${p}% ${better ? 'more' : 'fewer'} guests`,
  litterImpactMultiplier: (p, better) => `Litter bothers guests ${p}% ${better ? 'less' : 'more'}`,
  breakdownRateMultiplier: (p, better) => `Rides break down ${p}% ${better ? 'less' : 'more'} often`,
  sceneryAppealMultiplier: (p, better) => `Scenery appeal ${p}% ${better ? 'higher' : 'lower'}`,
  landCostMultiplier: (p, better) => `Land costs ${p}% ${better ? 'less' : 'more'}`,
};
