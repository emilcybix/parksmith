import { GAME_CONFIG } from '../config';
import { SOUVENIR_KINDS, type SouvenirKind } from '../types';
import type { ParkConditions } from '../weather/types';
import type { Guest, GuestPause } from './types';

/**
 * Phase 29: guest life. The pure rules the guest, ride and shop simulations share: how a ride unsettles a stomach, what
 * a purchase does to a guest's warmth and keepsakes, and how a short pause starts. Nothing here draws a random number or
 * reads a clock, so a ride or a stall can call it mid-step without touching the guest simulation's RNG.
 */

const LIFE = GAME_CONFIG.guestLife;

export const THOUGHTS = {
  queasy: 'I feel a bit queasy...',
  vomit: 'Bleurgh!',
  afterVomit: "I shouldn't have ridden that.",
  recovered: 'Phew, that passed.',
  hot: "It's so hot!",
  cold: "Brr, I'm freezing.",
  soaked: "I'm getting soaked!",
  dryUnderUmbrella: 'Glad I have an umbrella.',
  sick: 'Eww, someone was sick here!',
  noBench: 'I wish there was a bench.',
  sitDown: 'Time for a little sit down.',
  rested: 'I feel rested.',
  admire: 'What a lovely spot.',
  photo: 'I have to get a photo of this!',
  watchRide: 'Look at that ride go!',
  balloonLost: 'Oh no, my balloon!',
  glowing: 'My glow wand looks amazing at night!',
} as const;

/** What a guest thinks the moment they buy each keepsake (the shop writes it; Park Pulse summarises all five as one). */
export const SOUVENIR_THOUGHT: Readonly<Record<SouvenirKind, string>> = {
  umbrella: 'Now the rain can do its worst!',
  hat: 'This hat keeps the sun off.',
  balloon: 'I love my new balloon!',
  plush: 'Look at my new teddy!',
  glowWand: 'My glow wand is so bright!',
};

/** Phase 30: the shop's line when a keepsake cost more than it was worth (a complaint about that stall). */
export const PRICEY_SOUVENIR_THOUGHT = 'That souvenir was pricey.';

/**
 * Phase 30: the thoughts that may carry a `Guest.thoughtObjectId` (the building complained about), so the Pulse and
 * the guest inspector can link to it. Every other thought clears the id (`setThought`), and the readers ignore an id
 * whose thought is not listed here, so a write site that bypasses the helper can never link the wrong building.
 */
export const COMPLAINT_THOUGHTS: ReadonlySet<string> = new Set([
  'This queue is taking forever.',
  "I'm not paying that much.",
  "I can't afford that anymore.",
  'That queue is completely full.',
  'That service queue is completely full.',
  'That ride is closed.',
  'That service is closed.',
  PRICEY_SOUVENIR_THOUGHT,
]);

/**
 * Phase 30: the one way to write a guest's thought. `objectId` is the building a complaint is about and is kept only
 * for a COMPLAINT_THOUGHTS line; any other text clears it, so the id never outlives the thought it belongs to.
 */
export const setThought = (guest: Pick<Guest, 'currentThought' | 'thoughtObjectId'>, text: string, objectId: number | null = null): void => {
  guest.currentThought = text;
  guest.thoughtObjectId = objectId !== null && COMPLAINT_THOUGHTS.has(text) ? objectId : null;
};

export const souvenirBit = (kind: SouvenirKind): number => 1 << SOUVENIR_KINDS.indexOf(kind);

/** Every souvenir bit set: the largest valid `Guest.souvenirs`. */
export const ALL_SOUVENIR_BITS = (1 << SOUVENIR_KINDS.length) - 1;

export const holdsSouvenir = (guest: Pick<Guest, 'souvenirs'>, kind: SouvenirKind): boolean =>
  (guest.souvenirs & souvenirBit(kind)) !== 0;

export const isRaining = (conditions: Pick<ParkConditions, 'weatherKind' | 'weatherIntensity'>): boolean =>
  (conditions.weatherKind === 'rain' || conditions.weatherKind === 'storm') && conditions.weatherIntensity > 0;

export const pauseSeconds = (activity: GuestPause): number => LIFE.pauseSeconds[activity];

/**
 * Stops the guest where they stand for a short `activity`. `lookAt` is the object they face (scenery they admire, the
 * ride they watch); the route is kept but finished, so nothing walks them on until the pause ends.
 */
export const startPause = (
  guest: Guest,
  activity: GuestPause,
  thought: string | null = null,
  lookAt: number | null = null,
  /** Phase 30: the building a complaint `thought` is about (the sulk keeps its queue's id); ignored without a thought. */
  thoughtObjectId: number | null = null,
): void => {
  guest.state = 'pausing';
  guest.activity = activity;
  guest.destinationObjectId = lookAt;
  guest.servicePriceLimit = null;
  guest.routeIndex = guest.route.length;
  guest.stateTimerSeconds = 0;
  if (thought !== null) setThought(guest, thought, thoughtObjectId);
};

/** Nausea a ride of `intensity` adds to a guest who prefers `preferredIntensity` (more on a full stomach). */
export const nauseaGain = (intensity: number, preferredIntensity: number, hunger: number): number => {
  const nausea = LIFE.nausea;
  if (!(intensity > nausea.minimumIntensity)) return 0;
  const gain = (intensity - nausea.minimumIntensity) * nausea.perIntensity
    + Math.max(0, intensity - preferredIntensity - nausea.excessSlack) * nausea.perExcessIntensity;
  return hunger < nausea.fullStomachHunger ? gain * nausea.fullStomachFactor : gain;
};

/**
 * Called by the ride simulation for each rider as the cycle ends, after it has set the guest wandering: the stomach
 * settles the ride, and a queasy guest stops to recover (the guest simulation decides whether they are sick) while a
 * delighted one cheers.
 */
export const afterRide = (guest: Guest, intensity: number, satisfaction: number): void => {
  if (!LIFE.enabled) return;
  guest.nausea = Math.min(100, guest.nausea + nauseaGain(intensity, guest.preferredIntensity, guest.hunger));
  if (guest.nausea >= LIFE.nausea.queasy) startPause(guest, 'queasy', THOUGHTS.queasy);
  else if (satisfaction >= LIFE.cheerSatisfaction) guest.activity = 'cheer';
};

/**
 * Called by the shop simulation after a completed purchase (the guest is already wandering): warm items warm, cold
 * ones cool, a souvenir is kept, and the guest eats, drinks or shows the keepsake off in the moment before moving on
 * (a flourish: the pose changes, the timing does not). The thought is the shop's (Phase 30: the keepsake line, or the
 * pricey complaint when the purchase disappointed), so nothing here writes it.
 */
export const afterPurchase = (
  guest: Guest,
  kind: 'food' | 'drink' | 'toilet' | 'souvenir',
  serves: 'warm' | 'cold' | undefined,
  souvenir: SouvenirKind | undefined,
): void => {
  if (!LIFE.enabled) return;
  const warmth = LIFE.warmth;
  if (serves === 'warm') guest.warmth = Math.min(100, guest.warmth + warmth.itemWarmth);
  else if (serves === 'cold') guest.warmth = Math.max(0, guest.warmth - warmth.itemWarmth);
  if (kind === 'food') guest.activity = 'eat';
  else if (kind === 'drink') guest.activity = 'drink';
  else if (kind === 'souvenir' && souvenir !== undefined) {
    guest.souvenirs |= souvenirBit(souvenir);
    guest.activity = 'showOff';
  }
};

/** Out in the open (not on a ride, in a shop or in a facility). */
export const isExposed = (state: Guest['state']): boolean =>
  state !== 'riding' && state !== 'shopping' && state !== 'usingFacility';

/**
 * Phase 30: whether a guest in `state` is getting wet right now: out in the rain (not inside a ride or a stall) with no
 * umbrella. The guest simulation's soaked thought and mood loss, and the dashboard's comfort count, share it.
 */
export const isSoaked = (
  guest: Pick<Guest, 'souvenirs' | 'state'>,
  conditions: Pick<ParkConditions, 'weatherKind' | 'weatherIntensity'>,
): boolean =>
  LIFE.enabled && isExposed(guest.state) && isRaining(conditions) && !holdsSouvenir(guest, 'umbrella');

/** Phase 30: the counterpart of `isSoaked`: out in the rain, but under their own umbrella. */
export const isDryUnderUmbrella = (
  guest: Pick<Guest, 'souvenirs' | 'state'>,
  conditions: Pick<ParkConditions, 'weatherKind' | 'weatherIntensity'>,
): boolean =>
  LIFE.enabled && isExposed(guest.state) && isRaining(conditions) && holdsSouvenir(guest, 'umbrella');

/**
 * Phase 30: whether the conditions themselves sell a keepsake right now (the weather, heat or night part of
 * `souvenirDesire`, without any guest's mood or warmth), for the stall inspector's "Demand now" line.
 */
export const souvenirSellsNow = (kind: SouvenirKind, conditions: ParkConditions): boolean => {
  switch (kind) {
    case 'umbrella': return isRaining(conditions);
    case 'hat': return conditions.ambientWarmth > LIFE.warmth.neutral;
    case 'glowWand': return conditions.night;
    case 'balloon':
    case 'plush': return true;
  }
};

/** The warmth a guest drifts toward: the park's, softened by a sun hat in the heat and an umbrella in the rain. */
export const targetWarmth = (guest: Pick<Guest, 'souvenirs'>, conditions: ParkConditions): number => {
  const warmth = LIFE.warmth;
  let target = conditions.ambientWarmth;
  if (target > warmth.neutral && holdsSouvenir(guest, 'hat')) target = warmth.neutral + (target - warmth.neutral) * warmth.hatHeatShare;
  if (isRaining(conditions) && holdsSouvenir(guest, 'umbrella')) target = Math.max(target, warmth.umbrellaFloor);
  return target;
};

/**
 * How much a guest wants a souvenir right now, in service utility points: rain sells umbrellas, heat sells hats, the
 * night sells glow wands, and a good mood sells balloons and plushies. 0 for one already held.
 */
export const souvenirDesire = (guest: Pick<Guest, 'souvenirs' | 'warmth' | 'happiness'>, kind: SouvenirKind, conditions: ParkConditions): number => {
  if (!LIFE.enabled || holdsSouvenir(guest, kind)) return 0;
  const config = LIFE.souvenir;
  const base = config.baseDesire[kind];
  const mood = Math.max(0, guest.happiness - 60) * config.moodDesire;
  switch (kind) {
    case 'umbrella': return base + (isRaining(conditions) ? config.rainDesire * conditions.weatherIntensity : 0);
    case 'hat': return base + Math.max(0, Math.max(guest.warmth, conditions.ambientWarmth) - LIFE.warmth.neutral) * config.hatDesirePerWarmth;
    case 'glowWand': return base + (conditions.night ? config.nightDesire : 0);
    case 'balloon':
    case 'plush': return base + mood;
  }
};

/** The most a guest pays for a souvenir they want this much. */
export const souvenirPriceLimit = (kind: SouvenirKind, desire: number): number =>
  LIFE.souvenir.fairPrice[kind] * (LIFE.souvenir.minimumPriceShare + desire / LIFE.souvenir.desirePerShare);
