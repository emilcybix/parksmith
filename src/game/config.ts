/**
 * The need levels at which a guest gives up and leaves the park (GuestSimulation.shouldLeave / leavingThought). Phase
 * 30: one constant so the guest-life need gate (`guestLife.lifeNeedCeiling`), which is set at these levels, can never
 * drift from them.
 */
const LEAVE_NEED_THRESHOLDS = { hunger: 96, thirst: 94, toiletNeed: 97 } as const;

export const GAME_CONFIG = {
  /** The classic map size: every hand-made 32 x 32 map and the generator's default. Not a limit (see `land`). */
  mapWidth: 32,
  mapHeight: 32,
  /**
   * Land (Phase 21). One big map divided into square parcels; only owned parcels can be built on. A map whose owned
   * area is null (every 32 x 32 map, every save before Phase 21) owns all of it. Parcels are the voxel renderer's 8 x 8
   * static chunk. Map sizes are whole parcels between `minimumMapSize` and `maximumMapSize` on each axis.
   */
  land: {
    parcelSize: 8,
    minimumMapSize: 32,
    /** Measured against the 1,000-guest tick, the voxel chunk budget and the path distance fields (BALANCE_NOTES Phase 21). */
    maximumMapSize: 64,
    /**
     * Parcel price: round to `roundTo` of (basePrice + perOwnedParcel x parcels already owned) x distance factor x the
     * ruleset's landCostMultiplier. Distance factor: 1 + nearPremium at the gate's parcel, falling by `perStep` per parcel
     * of Chebyshev distance to a floor of `farFloor` (prime land by the gate costs more, remote land less).
     */
    price: {
      basePrice: 600,
      perOwnedParcel: 75,
      nearPremium: 0.15,
      perStep: 0.05,
      farFloor: 0.8,
      roundTo: 10,
    },
  },
  /**
   * Confirmed in Phase 16 (bot evidence; see BALANCE_NOTES.md BN-001). Sized from the actual catalog so a sandbox
   * start buys paths plus one premium ride, two cheap rides and services, or three small rides, and no more,
   * forcing the first real trade-off. It deliberately does not cover the whole research-free catalog.
   */
  startingCash: 5_000,
  pathCost: 12,
  bulldozeRefundRate: 0.2,
  fixedStepMs: 100,
  maxCatchUpSteps: 8,
  startingOpen: true,
  /**
   * The park calendar (Phase 20). One simulation tick is `fixedStepMs`; a day is a whole number of
   * simulation seconds, so pausing stops the clock and 2x/4x scale it. Tick 0 is `startHour` on day 1.
   */
  calendar: {
    defaultDayLengthSeconds: 720,
    /** Bounds a saved or chosen day length must stay inside (each bound is a promise to old saves). */
    minDayLengthSeconds: 60,
    maxDayLengthSeconds: 7_200,
    dayLengthPresets: [
      { id: 'brisk', label: 'Brisk', seconds: 360 },
      { id: 'standard', label: 'Standard', seconds: 720 },
      { id: 'relaxed', label: 'Relaxed', seconds: 1_440 },
      { id: 'leisurely', label: 'Leisurely', seconds: 2_880 },
    ],
    startHour: 6,
    hoursPerDay: 24,
    /** Label boundaries, in clock hours. */
    phaseHours: { dawnStart: 5, dayStart: 8.5, duskStart: 17, nightStart: 21.5 },
    /**
     * Look keys: [hour, weightDay, weightDusk, weightNight]. Between keys the weights ease with a
     * smoothstep; the table wraps at 24 h (the last key is pure night, like the first). Dawn is a
     * derived mix of the existing dusk and night presets, never a preset of its own.
     */
    lookKeys: [
      [5, 0, 0, 1],
      [7, 0, 0.6, 0.4],
      [8.5, 1, 0, 0],
      [17, 1, 0, 0],
      [18.5, 0, 1, 0],
      [19.5, 0, 1, 0],
      [21.5, 0, 0, 1],
    ],
    /** Clock hours a sandbox "fixed time of day" pins the LOOK to. */
    fixedTimeHours: { dawn: 7, noon: 12.5, dusk: 19, night: 0 },
    /** The light pass (lamp pools) runs while the blended light strength is above this. */
    lightPassMinStrength: 0.02,
    /**
     * Guest arrival curve over the RAW clock: [hour, multiplier]. Between keys it eases with a
     * smoothstep and wraps at 24 h (the last key repeats the first). The day-long mean is 1.00, so
     * the curve moves arrivals within the day and leaves the daily total where it was: a quiet
     * morning (about half the afternoon), a busy afternoon (peak 14:00), a thin evening and a night floor.
     */
    arrivalCurve: [
      [0, 0.48], [5, 0.48], [6, 0.86], [8, 0.95], [10, 1.24], [12, 1.57], [14, 1.67],
      [16, 1.62], [18, 1.24], [20, 0.91], [21.5, 0.67], [23, 0.52], [24, 0.48],
    ],
    /**
     * Optional opening hours (sandbox). Off by default so a new park is open around the clock and
     * the First Day pacing is untouched; with hours on, guests head home at closing time.
     */
    hours: {
      defaultEnabled: false,
      defaultOpen: 8,
      defaultClose: 21,
      openRange: [5, 12],
      closeRange: [15, 23],
      minSpan: 6,
      presets: [
        { id: 'always', label: 'Always', enabled: false, open: 8, close: 21 },
        { id: 'standard', label: '08-21', enabled: true, open: 8, close: 21 },
        { id: 'long', label: '06-23', enabled: true, open: 6, close: 23 },
      ],
    },
  },
  /**
   * Weather (Phase 20, step 2). A day is drawn from a seeded Markov chain (one row per current kind,
   * columns in KINDS order) and split into four six hour slots whose kinds follow the arc of the
   * day's kind. Everything drawn is saved, so the forecast IS the future and a later change of
   * these numbers can never rewrite a park in progress. Slot 0 of every arc is dry and day 1 is
   * fixed sunny, so no rain can fall inside the 15 minute First Day window.
   */
  weather: {
    slotsPerDay: 4,
    forecastDays: 2,
    maxSavedDays: 16,
    firstDay: { kind: 'sunny', intensity: 0.7 },
    transitions: {
      sunny: [0.52, 0.14, 0.26, 0.07, 0.01],
      hot: [0.34, 0.34, 0.18, 0.04, 0.1],
      cloudy: [0.34, 0.05, 0.34, 0.23, 0.04],
      rain: [0.2, 0, 0.4, 0.3, 0.1],
      storm: [0.22, 0.04, 0.44, 0.26, 0.04],
    },
    /** Columns multiplied by the park's wetWeatherMultiplier rule (then the row is renormalised). */
    wetKinds: ['rain', 'storm'],
    /** Slot kinds of a day of this kind: [06-12, 12-18, 18-24, 00-06]. */
    arcs: {
      sunny: ['sunny', 'sunny', 'sunny', 'cloudy'],
      hot: ['sunny', 'hot', 'hot', 'cloudy'],
      cloudy: ['cloudy', 'cloudy', 'cloudy', 'cloudy'],
      rain: ['cloudy', 'rain', 'rain', 'cloudy'],
      storm: ['cloudy', 'storm', 'rain', 'cloudy'],
    },
    intensityRange: {
      sunny: [0.5, 1],
      hot: [0.5, 1],
      cloudy: [0.4, 1],
      rain: [0.3, 1],
      storm: [0.6, 1],
    },
    /** Sandbox "weather intensity" switch: effective intensity = min(1, drawn * scale). */
    severityScale: { low: 0.6, normal: 1, high: 1.4 },
    /**
     * Effects. Every factor is `1 + (value - 1) * e` and every bias is `value * e`, `e` being the
     * effective intensity 0..1, so a weak shower nudges and a hard one bites.
     */
    effects: {
      arrivalFactor: { sunny: 1.08, hot: 0.92, cloudy: 1, rain: 0.65, storm: 0.4 },
      thirstFactor: { sunny: 1.08, hot: 1.35, cloudy: 1, rain: 1, storm: 1 },
      walkSpeedFactor: { sunny: 1, hot: 0.9, cloudy: 1, rain: 1, storm: 1 },
      /** Ride utility points: covered rides draw guests in the wet, open-air ones lose a little. */
      rideBias: {
        sunny: { covered: 0, openAir: 0 },
        hot: { covered: 0, openAir: 0 },
        cloudy: { covered: 0, openAir: 0 },
        rain: { covered: 10, openAir: -6 },
        storm: { covered: 14, openAir: 0 },
      },
      /** Service utility points. The catalog has no umbrellas: warm food stands in for them. */
      serviceBias: {
        sunny: { warm: 0, cold: 2 },
        hot: { warm: -4, cold: 6 },
        cloudy: { warm: 0, cold: 0 },
        rain: { warm: 7, cold: -5 },
        storm: { warm: 8, cold: -6 },
      },
      stormClosesOpenAir: true,
      /** The sunny Park Pulse line only shows when arrivals move at least this many percent. */
      pulseMinArrivalDeltaPercent: 7,
    },
    /** Storm flash timing (pure data for the presentation step): see weather/flash.ts. */
    flash: { slotSeconds: 6, chancePerSlot: 0.35, durationSeconds: 0.35, flickerGapSeconds: 0.12, flickerStrength: 0.4 },
    /**
     * Climate (Phase 24): the constant, place-bound part of the conditions, scaled by a biome's temperature
     * (-1 cold .. +1 hot; 0 = Meadow, nothing applied). PROVISIONAL, small on purpose: a full-intensity rain day
     * is warm +7 / cold -5, so Winter at -1 is a permanent rainy-day appetite for warm food. Heat raises cold
     * treat utility and lowers warm food utility, cold does the opposite. Applies after the weather effects and
     * even when the weather switch is off (climate belongs to the place). Points are service utility points.
     */
    climate: {
      heat: { coldTreatBonus: 5, warmFoodPenalty: 3 },
      cold: { warmFoodBonus: 8, coldTreatPenalty: 6 },
      /** Temperature thresholds the Park Pulse and the clock popover use to word the climate. */
      pulse: { coldAt: -0.7, coolAt: -0.3, warmAt: 0.3, hotAt: 0.7 },
    },
  },
  /**
   * Biomes and maps (Phase 24). The map data carries its own size (whole parcels, see `land`), entrance and owned area.
   * The area-bound caps below were tuned on 32 x 32 maps and scale with the map's area (`areaScaleOf`).
   */
  maps: {
    /** Cells reachable from the gate without spending anything (props and water block). */
    minimumOpenArea: 160,
    /** The same flood with every clearable prop removed: the land a patient player can reach. */
    minimumClearedArea: 480,
    maxProps: 320,
    /** Prop cells in one 8x8 chunk (the voxel static chunk): bounds the box budget of a forest. */
    maxPropCellsPerChunk: 40,
    /** The First Day apron in the entrance frame: lateral range (inclusive) and depth, free of props and water. */
    firstDayApron: { lateral: [-2, 3], depth: 12 },
    /** A save holding more props than this was not written by this game (checked before iterating): one per cell of the largest map. */
    maxSavedProps: 4_096,
    /** The map generator's targets and caps (Phase 24 step 2); any change here changes the output, so it bumps GENERATOR_VERSION. */
    generator: {
      /** Open area (no spending) a generated map must offer from the gate; the hand-made minimum is 447. */
      minimumOpenArea: 400,
      minimumClearedArea: 640,
      maxGeneratedProps: 300,
      /** Upper bounds of the voxel box weight of the props in one 8x8 chunk and in the whole map (see generator/weights.ts). */
      chunkPropWeightCap: 1_400,
      mapPropWeightCap: 8_600,
      /** Corridors the bounded repair pass may carve per target. */
      maxCarves: 24,
    },
    /** Biome rule layer bounds (hunger and thirst growth), see scenarios/rules.ts. */
    biomeRuleClamp: { minimum: 0.8, maximum: 1.25 },
  },
  guests: {
    maximum: 1_000,
    /** A guest leaves at or above any of these needs (see LEAVE_NEED_THRESHOLDS). */
    leaveNeedThresholds: LEAVE_NEED_THRESHOLDS,
    walkingCellsPerSecond: 1.85,
    baseSpawnIntervalSeconds: 4.2,
    minimumSpawnIntervalSeconds: 0.55,
    spawnRideBonusSeconds: 0.32,
    needUpdateSeconds: 1,
    postActivityDecisionSeconds: 1.4,
    hungerPerSecond: 0.22,
    thirstPerSecond: 0.34,
    toiletNeedPerSecond: 0.2,
    energyPerSecond: 0.12,
    minimumVisitSeconds: 140,
    variableVisitSeconds: 160,
    goodRideStayBonusSeconds: 20,
    goodPurchaseStayBonusSeconds: 10,
    maximumVisitSeconds: 900,
  },
  /**
   * Phase 29: guest life. What guests do between rides and stalls — sitting on benches, stopping to admire scenery or
   * watch a ride, cheering, feeling queasy and being sick, getting too hot or too cold — and what their souvenirs do.
   * Pauses are short standing activities ('pausing'); the bench is a sitting rest ('resting'). Rates are per second.
   */
  guestLife: {
    /**
     * The master switch. Off, guests live exactly as they did before Phase 29 (no pause, bench, nausea, warmth, souvenir
     * or flourish; no extra random draw), which is how the older review pins neutralise it. Souvenir stalls then sell
     * nothing.
     */
    enabled: true,
    /** Seconds each pause lasts (the moment after a ride or a purchase is `guests.postActivityDecisionSeconds`). */
    pauseSeconds: {
      admire: 2.5, watchRide: 2, photo: 2, queasy: 3, vomit: 2.2, fanSelf: 2, shiver: 2, sulk: 2, balloonLost: 2.4,
      // The flourishes (shown during the existing moment after a ride or a purchase) never hold a guest up; these only
      // apply should one ever be started as a pause.
      cheer: 1.4, eat: 1.4, drink: 1.4, showOff: 1.4,
    },
    nausea: {
      /** Rides at or below this intensity never unsettle a stomach. */
      minimumIntensity: 45,
      /** Gain per intensity point above the minimum. */
      perIntensity: 0.9,
      /** Extra gain per intensity point above what the guest likes (plus the slack). */
      perExcessIntensity: 0.8,
      excessSlack: 10,
      /** A guest who just ate (hunger below this) feels a ride more. */
      fullStomachHunger: 30,
      fullStomachFactor: 1.35,
      decayPerSecond: 0.6,
      /** At or above this after a ride the guest stops, queasy; at or above `vomit` after that they are sick. */
      queasy: 55,
      vomit: 80,
      /** Where nausea settles after being sick, and what it costs in happiness. */
      afterVomit: 15,
      vomitHappiness: 10,
      /** Utility lost per nausea point times the ride's intensity share (0..1): a queasy guest skips thrills. */
      rideAversion: 0.8,
      /** A queasy guest's food threshold rises by this share of their nausea. */
      foodAversion: 0.5,
    },
    /** A ride this satisfying makes the guest cheer. */
    cheerSatisfaction: 74,
    warmth: {
      neutral: 50,
      /** Share of the gap to the ambient warmth closed per second. */
      driftPerSecond: 0.012,
      hot: 78,
      cold: 22,
      hotThirstFactor: 1.25,
      hotHappinessPerSecond: 0.04,
      coldHappinessPerSecond: 0.05,
      /** Warmth a warm item adds and a cold item takes away. */
      itemWarmth: 18,
      /** Service utility points for a cold treat to a hot guest and a warm one to a cold guest. */
      comfortServiceBonus: 14,
      /** Chance at a decision point that a hot guest fans themself (or a cold one shivers). */
      pauseChance: 0.2,
      /** Ambient warmth per weather kind at full intensity, as an offset from neutral. */
      weatherShift: { sunny: 8, hot: 34, cloudy: -4, rain: -16, storm: -22 },
      /** Offset at night, and per unit of biome temperature (-1..1). */
      nightShift: -10,
      climateShift: 12,
      /** A sun hat halves the heat above neutral; an umbrella lifts rain chill to at least this. */
      hatHeatShare: 0.5,
      umbrellaFloor: 44,
    },
    rain: {
      /** Happiness lost per second at full rain intensity without an umbrella. */
      soakedHappinessPerSecond: 0.05,
    },
    bench: {
      seats: 2,
      /** A guest this tired looks for a bench (and below `seekChanceEnergy` always does). */
      seekEnergy: 50,
      seekChance: 0.5,
      seekChanceEnergy: 35,
      /** Route steps a guest will walk to a bench. */
      maximumDistance: 12,
      energyPerSecond: 3,
      happinessPerSecond: 0.25,
      maximumHappiness: 92,
      /** A rest ends at this energy, after at least the minimum and at most the maximum seconds. */
      restedEnergy: 90,
      minimumSeconds: 6,
      maximumSeconds: 24,
    },
    admire: {
      /** Scenery score of the guest's tile needed to stop and look, and the chance at a decision point. */
      sceneryScore: 20,
      chance: 0.25,
      /** Scenery at least this appealing is photographed instead. */
      photoAppeal: 30,
      happiness: 2.5,
      /** A ride this close (cells from its footprint) can be watched while it runs. */
      watchRideDistance: 3,
      watchRideChance: 0.1,
    },
    souvenir: {
      /** Desire (service utility points) per keepsake before weather and mood. */
      baseDesire: { umbrella: 2, hat: 5, balloon: 22, plush: 18, glowWand: 3 },
      /** Umbrella desire added at full rain intensity, hat desire per warmth point above neutral, glow wand at night. */
      rainDesire: 70,
      hatDesirePerWarmth: 1.4,
      nightDesire: 28,
      /** Balloon and plush desire per happiness point above 60. */
      moodDesire: 0.5,
      /**
       * What a guest will pay at most: the keepsake's fair price times (minimum share + desire / desirePerShare), so a
       * guest who barely wants one pays below the shelf price and a soaked one pays well above it.
       */
      fairPrice: { umbrella: 6, hat: 5, balloon: 3, plush: 8, glowWand: 4 },
      minimumPriceShare: 0.8,
      desirePerShare: 50,
      /** Money a guest keeps back for rides when buying a keepsake. */
      reserve: 8,
      purchaseSatisfaction: 72,
      /** Mood lifts while held. */
      balloonHappinessPerSecond: 0.03,
      plushHappinessPerSecond: 0.04,
      glowHappinessPerSecond: 0.06,
      maximumHappiness: 92,
      /** Chance per second that a balloon slips away, and what that costs. */
      balloonLossPerSecond: 0.004,
      balloonLossHappiness: 4,
    },
    /** Extra litter penalty multiplier for a sick pile, which guests notice from afar. */
    sickLitterFactor: 2,
    /**
     * Phase 30: a guest whose hunger, thirst or toilet need is at or above its ceiling skips every life activity
     * (bench, admire, photo, watch, fan, shiver) at a decision point. Set at the leave thresholds (shouldLeave: thirst
     * 94, hunger 96, toilet 97), where the gate is a safety net rather than a rule: the designed level, 72 (the
     * "urgent unmet need" level of chooseDestination), pushed two run-margin proofs (The Map seed 4 L5 "visitors",
     * standard and the Tough deck) from inside the 90% margin to exactly 90% (1460 s of 1620 s), so it stays here
     * until the owner retunes (BALANCE_NOTES Phase 30). At this level the gate cannot fire in a running session:
     * step() runs shouldLeave (same thresholds) before any handler can reach tryLifeActivity, so only direct calls
     * exercise it. It shares LEAVE_NEED_THRESHOLDS by construction; a retune replaces this reference with numbers.
     */
    lifeNeedCeiling: LEAVE_NEED_THRESHOLDS,
  },
  rides: {
    maximumDispatchWaitSeconds: 6,
    maximumQueueLength: 80,
    minimumTicketPrice: 0,
    maximumTicketPrice: 25,
    ticketPriceStep: 0.5,
  },
  services: {
    maximumQueueLength: 24,
    minimumPrice: 0,
    maximumPrice: 20,
    priceStep: 0.5,
    queuePatienceMultiplier: 1.25,
    foodDecisionThreshold: 38,
    drinkDecisionThreshold: 34,
    toiletDecisionThreshold: 42,
  },
  research: {
    rideCompletionPoints: 1,
    serviceCompletionPoints: 0.5,
    /**
     * Phase 16: the research-point cost scale a NEW park stores in its ruleset (`researchCostScale`). Every project's
     * RP cost is round(base x scale); cash costs and milestone rewards are unscaled, and the two explicit RP grants
     * (the Research Grant card and the profile bonus) are scaled at application. 1 = neutral (the key is then not
     * written, and a park plays exactly as before). Old saves have no key, which means 1. Switched on at 10 in Phase 16
     * (content version 3): the 14-project tree costs 8,150 RP, well over an hour of play: the bots reach 38-55 % of it by 45 minutes (BALANCE_NOTES Phase 16, PA-014).
     */
    costScale: 10,
    /** The bounds a stored `researchCostScale` must stay inside (compile clamps; restore refuses outside). */
    costScaleBounds: { minimum: 1, maximum: 20 },
  },
  scenery: {
    maximumScore: 100,
    rideChoiceWeight: 0.12,
    serviceChoiceWeight: 0.06,
    rideSatisfactionWeight: 0.10,
    serviceSatisfactionWeight: 0.05,
    ambientHappinessThreshold: 25,
    ambientHappinessPerSecond: 0.12,
    maximumAmbientHappiness: 92,
    ambientThoughtThreshold: 55,
    /**
     * Phase 16 theme affinity: a themed ride or stall gains min(maximumBonus, matching x share) on its scenery score
     * from same-theme scenery within reach (`matching` is the footprint-mean appeal field of those sources).
     * `share` is what a NEW park stores in its ruleset (`themeAffinity`), clamped to [0, maximumShare]; 0 = off (the key
     * is then not written). Old saves have no key, which means 0. Switched on in Phase 16 (content version 3) at 0.2: the
     * design's 0.3 slowed two late "visitors" run stages past the 90% bot margin (Standard seed 4 L5, Tough seed 1 L5 deck),
     * so the design-10 fallback stepped it to 0.2 (BALANCE_NOTES Phase 16).
     */
    themeAffinity: {
      share: 0.2,
      maximumBonus: 10,
      maximumShare: 0.5,
    },
  },
  /**
   * Phase 14 (Neighborhoods & Crowd Flow). Pressure is the rolling flow of walking guests through a path tile, held in
   * integer fixed point: an entry adds `entryUnits`; each tick `p -= ceil(p / decayDivisor)` (tau 320 ticks = 32 s of
   * simulation time). Guests a minute = p * 600 / (entryUnits * decayDivisor); load = that / (laneWidth x
   * `laneCapacityPerMinute`). `feedback` is what a NEW park stores in its ruleset (`crowdFeedback`), in (0,
   * `maximumFeedback`]; 0 = off (the key is then not written). Old saves have no key, which means 0. Below load 1 the
   * feedback is exactly neutral (factor literal 1, no happiness branch), so the bot proofs keep their outcomes.
   * `bands` are guests a minute per lane (quiet below `normal`); `hysteresis` is display only. Measured evidence: design
   * section 2 and BALANCE_NOTES "Phase 14".
   *
   * Calibration (Phase 14 calibration pass, real field, every tile, every tick). Scale: one guest walking a tile without
   * stopping enters 1.85 x 60 = 111 tiles a minute, so per-lane flow / 111 is the average number of walkers on the tile.
   * The design's first thresholds (30; 8/24/45) came from a probe that read flows 10x too low; every park measured since
   * sits about 10x above its numbers. Peaks per lane, feedback off: bot parks (60 run stages, the 300-run sweep, every
   * card / deck / stress / robust proof, 9 scenario plans, the 51-run strategy sweep) 70-272, the Season Ticket card
   * 329; the First Day route 190-329 on all 19 maps of the pacing proofs (Meadow 297.5); the dev park held at
   * 150 / 300 / 600 / 1,000 guests 281 / 563 / 1,125 / 1,875 (median of the per-tick worst tile 83 / 205 / 522 /
   * 1,073). So feedback starts at 400 (21 % above every bot and First Day peak: they stay bit-identical), severe is
   * 450 (about four walkers a tile), busy 270 (a First Day corridor touches it for seconds; no crowd Pulse line), normal
   * 80. Normal and severe are the design's numbers x10; busy (x10 = 240) and the capacity (x10 = 300) are raised for
   * headroom over the First Day.
   */
  crowd: {
    feedback: 1,
    maximumFeedback: 1,
    entryUnits: 1024,
    decayDivisor: 320,
    laneCapacityPerMinute: 400,
    bands: { normal: 80, busy: 270, severe: 450 },
    hysteresis: 0.85,
    speedPenaltyPerLoad: 0.4,
    minimumSpeedFactor: 0.6,
    severeHappinessPerSecond: 0.2,
    neighborhood: { leaderRadius: 6, bucketSize: 8, gateSteps: 4, reachSteps: 16 },
    pulse: {
      holdSeconds: 10,
      slowHoldSeconds: 20,
      releaseSeconds: 20,
      crowdedShare: 0.25,
      minimumGuests: 5,
      unhappyBelow: 50,
      unhappyGuests: 10,
      litterItems: 5,
    },
  },
  coaster: {
    stationLength: 3,
    minimumPieces: 12,
    maximumPieces: 64,
    absoluteMaximumHeight: 4,
    pathClearanceHeight: 2,
    stationLoadSeconds: 6,
    speed: {
      lift: 1.6,
      cruise: 2.4,
      maximum: 6,
      minimum: 1.1,
      dropBoostPerLevel: 1.9,
      flatDrag: 0.25,
      boost: 5.2,
      loopDrag: 0.6,
      loopLengthFactor: 3,
    },
    /**
     * Lift hills (Phase 27 step 4). PROVISIONAL: see BALANCE_NOTES.md. An uphill run is either
     * chained (steady `speed.lift`) or free (a fixed-point energy model, below).
     */
    lift: {
      /** Fixed-point scale of the free-climb step: speeds are whole milli-cells per second inside it. */
      speedScale: 1000,
      /** Speed squared lost per level climbed, in (milli-cells/s)^2: 4.0 cells^2/s^2. */
      freeClimbLossPerLevel: 4_000_000,
      /** Creep floor as a fraction of `speed.maximum`, in permille: 200 gives 1.2 cells/s. */
      creepPermille: 200,
      /** The designer refuses a free run with more than this many segments at the creep floor. */
      maxCreepSegments: 2,
      /** Construction cost of the chain on one chained climbing segment (already inside the piece prices). */
      chainCostPerPiece: 40,
      /** Running cost of the chain per chained climbing segment and cycle (already inside `runningCost`). */
      chainRunningCostPerPiece: 0.08,
      /** Per free run, bounded by the maximum: the thrill of a climb on momentum. */
      freeRunExcitement: 1.5,
      maxFreeExcitement: 3,
      freeRunIntensity: 1,
      maxFreeIntensity: 2,
      /**
       * Per free run, bounded by the maximum: a train that takes its hills on its own momentum is
       * harder on wheels and brakes than one hauled up at a steady pace. This is the chain's upside
       * (excitement versus reliability), so a free hill is never better on every axis.
       */
      freeRunReliabilityLoss: 2,
      maxFreeReliabilityLoss: 4,
    },
    specials: {
      loop: { cost: 260, excitement: 9, intensity: 12 },
      boost: { cost: 140, excitement: 3, intensity: 4 },
    },
  },
  operations: {
    staff: {
      /** Crew room a park always has, before any guests show up. */
      baseCapacityPerRole: 6,
      /** One more hire allowed per this many guests in the park. */
      guestsPerExtraStaff: 100,
      maximumCapacityPerRole: 20,
      training: {
        maximumLevel: 3,
        workSpeedPerLevel: 0.25,
        walkSpeedPerLevel: 0.1,
        /** Trained crews cost more every payroll, so training is an ongoing decision. */
        salaryPerLevel: 0.2,
        cleanerCost: 240,
        mechanicCost: 360,
      },
    },
    payrollIntervalSeconds: 30,
    staffWalkingCellsPerSecond: 2,
    cleaner: {
      salaryPerInterval: 12,
      litterSecondsPerUnit: 1.25,
      binEmptySeconds: 3,
    },
    mechanic: {
      salaryPerInterval: 18,
      inspectionSeconds: 6,
      repairSeconds: 12,
    },
    litter: {
      maximumUnits: 300,
      binUseRangeCells: 6,
      binEmptyThreshold: 7,
      happinessIntervalSeconds: 4,
      happinessRadiusCells: 1,
      happinessPenaltyPerUnit: 0.4,
      maximumHappinessPenalty: 2,
      /** Phase 29: litter units a guest's being sick leaves on the path. */
      sickUnits: 3,
    },
    maintenance: {
      preventiveConditionThreshold: 70,
      safeConditionThreshold: 70,
      inspectionRestoreCondition: 100,
      repairRestoreCondition: 90,
      conditionLossBasePerCycle: 2,
      conditionLossIntensityFactor: 0.012,
      conditionLossDurationFactor: 0.006,
      minimumInspectionCost: 5,
      inspectionCostBuildFraction: 0.004,
      minimumRepairCost: 25,
      repairCostBuildFraction: 0.025,
    },
    cleanliness: {
      minimumPathDivisor: 12,
      litterDensityMultiplier: 250,
      maximumLitterPenalty: 75,
      fullBinFractionPenalty: 20,
    },
  },
  /**
   * The Map (Phase 23): roguelite runs. EVERY number here is PROVISIONAL (BALANCE_NOTES, "Phase 23: The Map runs");
   * the bot proof in src/game/run/winnability.*.test.ts holds them. Any change to a value that alters `planRun` output
   * bumps RUN_PLAN_VERSION (a golden digest pins it).
   */
  run: {
    levelCount: 5,
    starterDeckSize: 3,
    offerSize: 2,
    /** `all` = every offered card joins the deck (the user's rule); `pick` = choose `pick` of the offer (data, UI ships `all`). */
    offerRule: { kind: 'all' } as { readonly kind: 'all' } | { readonly kind: 'pick'; readonly pick: number },
    /** Base card slots per level (the run grant's Spare card slot adds one on top). */
    slotsByLevel: [1, 1, 2, 2, 3],
    /** The most copies of one card that may ever be ADDED to a run (starter plus offers). */
    copyCap: 3,
    /** 'stage-start' = loadout cards are used up when the stage starts; 'stage-clear' = only when it is cleared. */
    consumeAt: 'stage-start' as 'stage-start' | 'stage-clear',
    firstBiome: 'meadow' as const,
    /**
     * Phase 25 card rarity: frequency and slot cost, nothing else (rarity never enters a card's numbers, its effect
     * vector or the compile). `weight` = run offer weight, `firstLevel` = the 1-based level an offer before it may first
     * hold the tier, `starter` = may be dealt in a starter deck, `draftWeight` = Scenario reward draft weight. Integer
     * weights only (the keyed draw replicates a card `weight` times, run/rng.ts).
     */
    rarity: {
      common: { weight: 6, slotCost: 1, firstLevel: 1, starter: true, draftWeight: 6 },
      uncommon: { weight: 3, slotCost: 1, firstLevel: 2, starter: false, draftWeight: 3 },
      rare: { weight: 2, slotCost: 2, firstLevel: 3, starter: false, draftWeight: 2 },
    },
    /** One-shot cards left unplayed when a stage resolves: 'return' to the deck, or 'consume' them like stage cards. */
    unplayedOneShots: 'return' as 'return' | 'consume',
    /**
     * A biome whose stationary rain + storm share is below this makes the wet-weather axis dead there (a card whose
     * every upside is dead in every remaining biome is never offered). Desert Canyon is 0.047; the next lowest is 0.206.
     */
    deadWetShare: 0.1,
    /**
     * One row per level (the last row repeats if levelCount is raised). Targets: a family absent from a row is not drawn
     * there. Plan version 2 (Phase 23 balance review): the curve is set by the LEVEL, not by the family drawn. Crowd is a
     * park-size goal (reached as soon as a three-ride park fills, about 115 guests, whatever the level), so it is the
     * opening family of levels 1 and 2 only; spirits is a hold whose length grows with the level (and with the
     * difficulty, `spiritsSecondsScale`), with bars low enough that a biome's daily dip does not reset a long hold;
     * level 5 draws the two families whose targets scale (visitors, profit).
     */
    levels: [
      { startingCash: 10_000, conditions: 0, density: 'low', targets: { visitors: 150, crowd: 65 } },
      { startingCash: 11_000, conditions: 1, density: 'normal', targets: { visitors: 220, profit: 2_500, crowd: 85, spirits: { bar: 68, seconds: 480 } } },
      { startingCash: 12_000, conditions: 1, density: 'normal', targets: { visitors: 260, profit: 3_500, spirits: { bar: 68, seconds: 600 } } },
      { startingCash: 13_000, conditions: 2, density: 'high', targets: { visitors: 330, profit: 5_000, spirits: { bar: 68, seconds: 780 } } },
      { startingCash: 14_000, conditions: 2, density: 'high', targets: { visitors: 380, profit: 6_500 } },
    ] as ReadonlyArray<{
      readonly startingCash: number;
      readonly conditions: number;
      readonly density: 'low' | 'normal' | 'high';
      readonly targets: {
        readonly visitors?: number;
        readonly profit?: number;
        readonly crowd?: number;
        readonly spirits?: { readonly bar: number; readonly seconds: number };
      };
    }>,
    maxConditionsPerLevel: 3,
    /**
     * Difficulty is a run setting, and this is the one table of it (Phase 25 retune, design 7.1; plan version 4).
     * Relaxed is the Phase 23 Standard. Per level (the last entry repeats): `deadlineDays` (whole quarter days) and
     * `cashDelta` (added to the row's `startingCash`). Targets scale (crowd, visitors, profit), the spirits hold
     * lengthens (`spiritsSecondsScale`) and its bar shifts, conditions and map density step. `botMargin` is the share of
     * the deadline the no-card bot must clear every level within; `deckMargin` the share a plausible deck must clear
     * Tough levels 4-5 within (winnability.*.test.ts). Tough's targetScale is 1.10, not the design's 1.15: the first step
     * of the balance ladder (a plausible deck missed 0.90 at Tough level 5; BALANCE_NOTES, Phase 25).
     */
    difficulties: {
      relaxed: {
        deadlineDays: [1.5, 2, 2, 2.5, 2.5], targetScale: 1, spiritsSecondsScale: 1, spiritsBarDelta: 0,
        cashDelta: [0, 0, 0, 0, 0], conditionDelta: 0, densityStep: 0, botMargin: 0.85, deckMargin: 0.85,
      },
      standard: {
        deadlineDays: [1.25, 1.75, 1.75, 2.25, 2.25], targetScale: 1.1, spiritsSecondsScale: 1.05, spiritsBarDelta: 1,
        cashDelta: [-250, -250, -500, -1_000, -1_000], conditionDelta: 0, densityStep: 0, botMargin: 0.9, deckMargin: 0.85,
      },
      tough: {
        deadlineDays: [1.25, 1.75, 1.75, 2.25, 2.25], targetScale: 1.1, spiritsSecondsScale: 1.1, spiritsBarDelta: 2,
        cashDelta: [-1_000, -1_500, -2_000, -2_500, -2_500], conditionDelta: 1, densityStep: 1, botMargin: 1, deckMargin: 0.9,
      },
    } as Readonly<Record<'relaxed' | 'standard' | 'tough', {
      readonly deadlineDays: readonly number[];
      readonly targetScale: number;
      readonly spiritsSecondsScale: number;
      readonly spiritsBarDelta: number;
      readonly cashDelta: readonly number[];
      readonly conditionDelta: number;
      readonly densityStep: number;
      readonly botMargin: number;
      readonly deckMargin: number;
    }>>,
    /** Rounding of scaled targets. */
    rounding: { visitors: 10, profit: 100, crowd: 5, spiritsSeconds: 30 },
    /** Generated-map acceptance (see run/plan.ts). */
    map: {
      minimumClearedArea: 640,
      /** The entrance corridor: lateral -half..+half, depth 0..depth, free of water and permanent props. */
      corridor: { half: 1, depth: 14 },
      /** Attempts with the level's density and water, then attempts on a low, dry map. */
      attempts: 16,
      fallbackAttempts: 16,
    },
    /** Profile: the last run keys kept for idempotent rewards. */
    recentRunKeys: 32,
  },
  /**
   * Phase 28 step 2: colour customisation. Recolouring is free in the Sandbox, always (a rule in
   * colourCost.ts, not config). In a Scenario and on The Map each recoloured object may cost this much
   * (times the park's `recolourCostMultiplier` rule), charged once at the end of a paint gesture. 0 = free
   * until Phase 22 (profile unlocks) and Phase 25 (cards) decide; no objective may ever require a colour.
   */
  colours: {
    recolourCostPerObject: {
      scenario: 0,
      map: 0,
    },
  },
} as const;
