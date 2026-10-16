import type { PulseCardRow } from './types';

/**
 * The Pulse Card pool (Phase 25): data only. Order = canonical order (the starter deck, offers, the deck and the
 * collection sort by it): the six shipped cards first, unchanged, then the Phase 25 cards appended. Copy (upside,
 * downside) and slot cost are derived (content.ts, copy.ts); a stage card's effect vector is derived from its
 * modifiers, a one-shot's is authored here and cross-checked against its effect by a test (vector.ts).
 *
 * Rarity is frequency and slot cost only (GAME_CONFIG.run.rarity). Tags are labels with one rule each (interaction.ts).
 * Changing any row changes run plans: bump RUN_PLAN_VERSION.
 */
export const PULSE_CARD_TABLE = [
  // --- The shipped six (ids, numbers and order unchanged) -------------------------------------------------------
  {
    id: 'grand-opening', name: 'Grand Opening', icon: '🎈', tagline: 'Free balloons and a very loud jingle.',
    family: 'arrivals', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { arrivalIntervalMultiplier: 0.8, guestBudgetMultiplier: 0.85 },
  },
  {
    id: 'velvet-ropes', name: 'Velvet Ropes', icon: '🎗', tagline: 'An exclusive invitation, hand-lettered.',
    family: 'arrivals', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { guestBudgetMultiplier: 1.25, arrivalIntervalMultiplier: 1.2 },
  },
  {
    id: 'local-contractors', name: 'Local Contractors', icon: '🔨', tagline: 'Friendly rates from the village workshop.',
    family: 'build', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { constructionCostMultiplier: 0.8, rideOperatingCostMultiplier: 1.3 },
  },
  {
    id: 'quick-turnaround', name: 'Quick Turnaround', icon: '⏱', tagline: 'No dawdling on the platform.',
    family: 'rides', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { rideDispatchMultiplier: 0.6, rideOperatingCostMultiplier: 1.25 },
  },
  {
    id: 'hungry-tourists', name: 'Hungry Tourists', icon: '🥨', tagline: 'A bus tour with a generous lunch budget.',
    family: 'economy', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { servicePriceToleranceMultiplier: 1.3, needDecayMultiplier: 1.25 },
  },
  {
    id: 'lean-crew', name: 'Lean Crew', icon: '🧹', tagline: 'A small team that knows every shortcut.',
    family: 'staff', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { staffSalaryMultiplier: 0.65, staffSpeedMultiplier: 0.8 },
  },
  // --- Weather ------------------------------------------------------------------------------------------------
  {
    id: 'storm-shutters', name: 'Storm Shutters', icon: '🪟', tagline: 'Bolted down before the first drop.',
    family: 'weather', rarity: 'common', tags: ['weather'], kind: 'stage',
    modifiers: { weatherEffectMultiplier: 0.7, rideOperatingCostMultiplier: 1.1 },
  },
  {
    id: 'umbrella-stand', name: 'Umbrella Stand', icon: '☂', tagline: 'One by every queue, just in case.',
    family: 'weather', rarity: 'common', tags: ['weather'], kind: 'stage',
    modifiers: { weatherEffectMultiplier: 0.85, rideDispatchMultiplier: 1.2 },
  },
  {
    id: 'dry-spell', name: 'Dry Spell', icon: '🌵', tagline: 'Not a cloud in the long-range outlook.',
    family: 'weather', rarity: 'uncommon', tags: ['wet'], kind: 'stage',
    modifiers: { wetWeatherMultiplier: 0.6, needDecayMultiplier: 1.1 },
  },
  {
    id: 'farmers-almanac', name: "Farmer's Almanac", icon: '📖', tagline: 'Fewer showers, fiercer when they come.',
    family: 'weather', rarity: 'common', tags: ['wet', 'weather'], kind: 'stage',
    modifiers: { wetWeatherMultiplier: 0.8, weatherEffectMultiplier: 1.15 },
  },
  {
    id: 'heat-haze', name: 'Heat Haze', icon: '🥵', tagline: 'Every lemonade tastes twice as good.',
    family: 'weather', rarity: 'common', tags: ['weather'], kind: 'stage',
    modifiers: { needReliefMultiplier: 1.3, weatherEffectMultiplier: 1.25 },
  },
  {
    id: 'weather-station', name: 'Weather Station', icon: '📡', tagline: 'A mast, a barometer and a nervous accountant.',
    family: 'weather', rarity: 'rare', tags: ['weather', 'wet'], kind: 'stage',
    modifiers: { weatherEffectMultiplier: 0.6, wetWeatherMultiplier: 0.75, rideOperatingCostMultiplier: 1.2, guestBudgetMultiplier: 0.9 },
  },
  {
    id: 'clear-skies', name: 'Clear Skies', icon: '🌤', tagline: 'A favour called in at the weather office.',
    family: 'weather', rarity: 'uncommon', tags: ['weather'], kind: 'one-shot',
    effect: { kind: 'forecast', weather: 'sunny', slots: 4, intensity: 0.7, fee: 600 },
    vector: { forecast: 1, cashNow: -0.6 },
  },
  // --- Day and night ------------------------------------------------------------------------------------------
  {
    id: 'night-market', name: 'Night Market', icon: '🏮', tagline: 'Stalls that open when the sun goes down.',
    family: 'day-night', rarity: 'uncommon', tags: ['night'], kind: 'stage',
    modifiers: { nightArrivalMultiplier: 1.6, guestBudgetMultiplier: 0.9 },
  },
  {
    id: 'lantern-walk', name: 'Lantern Walk', icon: '🪔', tagline: 'A gentle stroll under a thousand lights.',
    family: 'day-night', rarity: 'uncommon', tags: ['night'], kind: 'stage',
    modifiers: { nightArrivalMultiplier: 1.3, rideOperatingCostMultiplier: 1.1 },
  },
  {
    id: 'lamplighters', name: 'Lamplighters', icon: '🕯', tagline: 'Someone has to light them all by hand.',
    family: 'day-night', rarity: 'uncommon', tags: ['night', 'scenery'], kind: 'stage',
    modifiers: { nightArrivalMultiplier: 1.3, sceneryAppealMultiplier: 1.1, staffSalaryMultiplier: 1.15 },
  },
  {
    id: 'long-days', name: 'Long Days', icon: '🌅', tagline: 'The sun seems in no hurry to set.',
    family: 'day-night', rarity: 'uncommon', tags: [], kind: 'stage',
    modifiers: { dayLengthMultiplier: 1.5, staffSalaryMultiplier: 1.15 },
  },
  {
    id: 'brisk-days', name: 'Brisk Days', icon: '🌬', tagline: 'Busy mornings, short afternoons.',
    family: 'day-night', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { guestBudgetMultiplier: 1.1, dayLengthMultiplier: 0.75 },
  },
  {
    id: 'fireworks-night', name: 'Fireworks Night', icon: '🎆', tagline: 'Oohs, aahs and a hefty invoice.',
    family: 'day-night', rarity: 'common', tags: [], kind: 'one-shot',
    effect: { kind: 'cheer', happiness: 12, fee: 1_200 },
    vector: { spirits: 1.2, cashNow: -1.2 },
  },
  // --- Arrivals -----------------------------------------------------------------------------------------------
  {
    id: 'word-on-the-street', name: 'Word on the Street', icon: '🗣', tagline: 'Everyone has heard of the park, and of a bargain.',
    family: 'arrivals', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { arrivalIntervalMultiplier: 0.85, servicePriceToleranceMultiplier: 0.85 },
  },
  {
    id: 'overflow-lot', name: 'Overflow Lot', icon: '🅿', tagline: 'A field next door, mown flat for cars.',
    family: 'arrivals', rarity: 'uncommon', tags: ['crowd'], kind: 'stage',
    modifiers: { crowdCapacityMultiplier: 1.3, needDecayMultiplier: 1.15 },
  },
  {
    id: 'season-ticket', name: 'Season Ticket', icon: '🎫', tagline: 'Regulars by the thousand, on a budget.',
    family: 'arrivals', rarity: 'rare', tags: ['crowd'], kind: 'stage',
    modifiers: { crowdCapacityMultiplier: 1.5, arrivalIntervalMultiplier: 0.8, guestBudgetMultiplier: 0.7, rideOperatingCostMultiplier: 1.2 },
  },
  {
    id: 'coach-party', name: 'Coach Party', icon: '🚌', tagline: 'Twenty day-trippers and one tired driver.',
    family: 'arrivals', rarity: 'common', tags: ['crowd'], kind: 'one-shot',
    effect: { kind: 'surge', guests: 20, bill: 900, afterSeconds: 60 },
    vector: { visitors: 2, cashLater: -0.9 },
  },
  // --- Cleanliness and staff ----------------------------------------------------------------------------------
  {
    id: 'tidy-town', name: 'Tidy Town', icon: '🧽', tagline: 'Spotless, and the crew knows its worth.',
    family: 'staff', rarity: 'common', tags: ['litter'], kind: 'stage',
    modifiers: { litterImpactMultiplier: 0.6, staffSalaryMultiplier: 1.15 },
  },
  {
    id: 'greasy-fairground', name: 'Greasy Fairground', icon: '🍟', tagline: 'Nobody minds the mess when the chips are this good.',
    family: 'staff', rarity: 'common', tags: ['litter'], kind: 'stage',
    modifiers: { servicePriceToleranceMultiplier: 1.15, litterImpactMultiplier: 1.5 },
  },
  {
    id: 'master-mechanics', name: 'Master Mechanics', icon: '🔧', tagline: 'They hear a loose bolt from across the park.',
    family: 'staff', rarity: 'uncommon', tags: ['repair'], kind: 'stage',
    modifiers: { breakdownRateMultiplier: 0.5, staffSalaryMultiplier: 1.25 },
  },
  {
    id: 'apprentices', name: 'Apprentices', icon: '🧑‍🎓', tagline: 'Keen, cheap and still learning.',
    family: 'staff', rarity: 'common', tags: ['repair'], kind: 'stage',
    modifiers: { staffSalaryMultiplier: 0.75, breakdownRateMultiplier: 1.3 },
  },
  {
    id: 'sweep-the-park', name: 'Sweep the Park', icon: '🗑', tagline: 'Every hand on a broom for one hour.',
    family: 'staff', rarity: 'common', tags: ['litter'], kind: 'one-shot',
    effect: { kind: 'sweep', fee: 400 },
    vector: { litter: 1, cashNow: -0.4 },
  },
  {
    id: 'repair-crew', name: 'Repair Crew', icon: '🛠', tagline: 'A van full of spares, billed later.',
    family: 'staff', rarity: 'uncommon', tags: ['repair'], kind: 'one-shot',
    effect: { kind: 'repair', scope: 'broken', perRide: 250, afterSeconds: 90 },
    vector: { repair: 1, cashLater: -0.25 },
  },
  // --- Rides and coasters -------------------------------------------------------------------------------------
  {
    id: 'safety-first', name: 'Safety First', icon: '🦺', tagline: 'Every harness checked twice.',
    family: 'rides', rarity: 'common', tags: ['repair'], kind: 'stage',
    modifiers: { breakdownRateMultiplier: 0.7, rideDispatchMultiplier: 1.3 },
  },
  {
    id: 'oil-and-grease', name: 'Oil and Grease', icon: '🛢', tagline: 'Runs smooth, until it does not.',
    family: 'rides', rarity: 'common', tags: ['repair'], kind: 'stage',
    modifiers: { rideOperatingCostMultiplier: 0.8, breakdownRateMultiplier: 1.25 },
  },
  {
    id: 'full-trains', name: 'Full Trains', icon: '🚃', tagline: 'Nobody leaves the platform with an empty seat.',
    family: 'rides', rarity: 'uncommon', tags: [], kind: 'stage',
    modifiers: { rideOperatingCostMultiplier: 0.7, rideDispatchMultiplier: 1.5 },
  },
  {
    id: 'chain-gang', name: 'Chain Gang', icon: '⛓', tagline: 'A bulk order of lift chain, slightly used.',
    family: 'rides', rarity: 'uncommon', tags: ['coaster'], kind: 'stage',
    modifiers: { chainLiftCostMultiplier: 0.5, constructionCostMultiplier: 1.1 },
  },
  {
    id: 'inspection-day', name: 'Inspection Day', icon: '📋', tagline: 'Clipboards out, queues out.',
    family: 'rides', rarity: 'uncommon', tags: ['repair'], kind: 'one-shot',
    effect: { kind: 'repair', scope: 'all', perRide: 150, afterSeconds: null },
    vector: { repair: 1, condition: 1, queues: -1, cashNow: -0.15 },
  },
  // --- Economy and pricing ------------------------------------------------------------------------------------
  {
    id: 'value-menu', name: 'Value Menu', icon: '🍔', tagline: 'Bigger portions, smaller margins.',
    family: 'economy', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { needReliefMultiplier: 1.4, servicePriceToleranceMultiplier: 0.8 },
  },
  {
    id: 'tip-jar', name: 'Tip Jar', icon: '🫙', tagline: 'Guests come with change to spare.',
    family: 'economy', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { guestBudgetMultiplier: 1.15, needDecayMultiplier: 1.1 },
  },
  {
    id: 'premium-pricing', name: 'Premium Pricing', icon: '💎', tagline: 'Exclusive, and priced like it.',
    family: 'economy', rarity: 'uncommon', tags: [], kind: 'stage',
    modifiers: { servicePriceToleranceMultiplier: 1.5, arrivalIntervalMultiplier: 1.25 },
  },
  {
    id: 'bridging-loan', name: 'Bridging Loan', icon: '🏦', tagline: 'A friendly bank manager, for now.',
    family: 'economy', rarity: 'common', tags: ['cash'], kind: 'one-shot',
    effect: { kind: 'loan', amount: 2_000, repay: 2_400, afterSeconds: 240 },
    vector: { cashNow: 2, cashLater: -2.4 },
  },
  {
    id: 'big-loan', name: 'Big Loan', icon: '💰', tagline: 'Sign here, and here, and here.',
    family: 'economy', rarity: 'rare', tags: ['cash'], kind: 'one-shot',
    effect: { kind: 'loan', amount: 5_000, repay: 6_250, afterSeconds: 300 },
    vector: { cashNow: 5, cashLater: -6.25 },
  },
  {
    id: 'sponsor-banner', name: 'Sponsor Banner', icon: '📣', tagline: 'A giant advert for fizzy drinks over the gate.',
    family: 'economy', rarity: 'uncommon', tags: ['cash'], kind: 'one-shot',
    effect: { kind: 'cheer', happiness: -8, fee: -1_500 },
    vector: { cashNow: 1.5, spirits: -0.8 },
  },
  {
    id: 'research-grant', name: 'Research Grant', icon: '🔬', tagline: 'A small lab, a big idea.',
    family: 'economy', rarity: 'common', tags: ['research'], kind: 'one-shot',
    effect: { kind: 'research', points: 20, fee: 700 },
    vector: { research: 2, cashNow: -0.7 },
  },
  // --- Scenery and themes -------------------------------------------------------------------------------------
  {
    id: 'garden-club', name: 'Garden Club', icon: '🌷', tagline: 'Volunteers with opinions about hedges.',
    family: 'scenery', rarity: 'common', tags: ['scenery'], kind: 'stage',
    modifiers: { sceneryAppealMultiplier: 1.3, constructionCostMultiplier: 1.1 },
  },
  {
    id: 'plastic-flowers', name: 'Plastic Flowers', icon: '🌼', tagline: 'They never wilt, and nobody looks twice.',
    family: 'scenery', rarity: 'common', tags: ['scenery'], kind: 'stage',
    modifiers: { constructionCostMultiplier: 0.85, sceneryAppealMultiplier: 0.7 },
  },
  {
    id: 'heritage-trail', name: 'Heritage Trail', icon: '🏛', tagline: 'Little plaques on everything worth a look.',
    family: 'scenery', rarity: 'uncommon', tags: ['scenery'], kind: 'stage',
    modifiers: { sceneryAppealMultiplier: 1.2, staffSpeedMultiplier: 0.85 },
  },
  {
    id: 'bloom-festival', name: 'Bloom Festival', icon: '💐', tagline: 'One glorious weekend of flowers.',
    family: 'scenery', rarity: 'uncommon', tags: ['scenery'], kind: 'one-shot',
    effect: { kind: 'cheer', happiness: 8, fee: 600 },
    vector: { spirits: 0.8, cashNow: -0.6 },
  },
  // --- Build and tools ----------------------------------------------------------------------------------------
  {
    id: 'prefab-kits', name: 'Prefab Kits', icon: '📦', tagline: 'Flat-packed rides, some assembly required.',
    family: 'build', rarity: 'common', tags: ['repair'], kind: 'stage',
    modifiers: { constructionCostMultiplier: 0.8, breakdownRateMultiplier: 1.2 },
  },
  {
    id: 'master-builders', name: 'Master Builders', icon: '🏗', tagline: 'The best crew in the trade, at their rates.',
    family: 'build', rarity: 'rare', tags: ['coaster'], kind: 'stage',
    modifiers: { constructionCostMultiplier: 0.6, chainLiftCostMultiplier: 0.6, staffSalaryMultiplier: 1.3, rideOperatingCostMultiplier: 1.15 },
  },
  {
    id: 'timber-tariff', name: 'Timber Tariff', icon: '🪵', tagline: 'Dear wood, generous neighbours.',
    family: 'build', rarity: 'common', tags: [], kind: 'stage',
    modifiers: { guestBudgetMultiplier: 1.1, constructionCostMultiplier: 1.2 },
  },
] as const satisfies readonly PulseCardRow[];
