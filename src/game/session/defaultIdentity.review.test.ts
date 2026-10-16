import { describe, expect, it, vi } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ONBOARDING_STEPS } from '../onboarding/content';
import { FOUNDING_SCENARIOS, SCENARIO_BY_ID } from '../scenarios/content';
import { compileParkRules } from '../scenarios/rules';
import { DETERMINISM_FIXTURES } from '../save/determinismFixtures';
import { runReference } from '../save/determinismHarness';
import { hashState } from '../save/hash';
import { stripGuestLife } from '../save/schema14TestSupport';
import { drawDay, firstDayOf, stationaryDistribution, transitionRow } from '../weather/chain';
import { WeatherRandom, mixSeed } from '../weather/random';
import { WEATHER_KINDS, type WeatherKind } from '../weather/types';
import { ParkSession, SANDBOX_SEED } from './ParkSession';
import { seedDevPark } from './devPark';
import { sessionFromSave } from './fromSave';

/**
 * Phase 24 default identity (a review pin). The default park, Meadow Garden (today's 32 x 32 garden with the
 * gate at (15, 31)), MUST stay bit-identical: a new sandbox park, the dev park, every scenario, every
 * determinism fixture, every frozen save, the First Day pacing latch ticks, the drawn weather and the compiled
 * rulesets produce exactly what the pre-Phase-24 code produced. The pins below were captured from the
 * schema-7 code BEFORE any Phase 24 change (scratchpad phase24/baseline/game.json) and are never re-pinned:
 * a moved value means Meadow changed, and the fix is in the code, not here.
 *
 * Schema 8 adds a top-level `map` key and, for non-Meadow biomes only, two rule keys; they are removed
 * before hashing (STRIP), exactly like the earlier new-key reviews do. The `world` owner hash needs no
 * stripping at all: the world key is byte-identical for a Meadow park (checked below).
 *
 * Phase 16 (content version 3) appends 12 catalog entries and 5 research projects and switches on two base-layer
 * rule keys for NEW parks (`themeAffinity` 0.3, `researchCostScale` 10). This review runs under the NEUTRAL Phase 16
 * values through the `vi.mock('../config')` below (affinity share 0, cost scale 1): the base layer reads both at
 * compile time, neutral values are never written, and so every pin here stays byte-identical. That is the proof
 * that the append moved nothing; the switch-on itself is re-pinned elsewhere (save/determinism 2c, liftPersistence).
 *
 * Phase 29 (schema 15, content version 5) likewise runs with guest life switched off (`guestLife.enabled`), and the
 * guest fields, the sick flag and the souvenir total it adds to a save are stripped before hashing: with the switch off
 * every pin here holds, which is the proof that the six appended stalls and the new code paths move nothing by themselves.
 *
 * Phase 38 (2026-10-16): only the `observables` pins moved. The probe in determinismHarness.observe asks
 * canPlaceCoasterPiece on every cell, and track may now run over low objects and other track at clearance, so the
 * answers for cells under benches or beside existing coasters changed by design. Final state, events and fingerprints
 * are unchanged in every fixture.
 */
vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  const config = actual.GAME_CONFIG;
  return {
    ...actual,
    GAME_CONFIG: {
      ...config,
      scenery: { ...config.scenery, themeAffinity: { ...config.scenery.themeAffinity, share: 0 } },
      research: { ...config.research, costScale: 1 },
      crowd: { ...config.crowd, feedback: 0 },
      // Phase 29: guest life switched off (the master switch); the four guest fields it saves are stripped below.
      guestLife: { ...config.guestLife, enabled: false },
      // Phase 40: front-only access switched off, so new parks compile no `frontAccess` key and seed as they did.
      access: { ...config.access, frontOnly: false },
    },
  };
});

const PINS = {
 "parks": {
  "sandbox": {
   "start": "0cf70f722d1e2a96",
   "startOwners": {
    "scenarioId": "5b9bc4ba528108e4",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "e27f25d3cec6d6ce",
    "rules": "1c25989667203fbe",
    "world": "c33d8a4c226e6e28",
    "scenery": "acb025b5b0fef6db",
    "calendar": "521d31370213cfa6",
    "weather": "e7d243c4f9b8b97e",
    "rides": "c9bfd56b5080ceff",
    "shops": "31fa5635f85ee93b",
    "guests": "fe3746e501f909b8",
    "operations": "dd4dbb3f68664560",
    "progression": "1895f17901234da4",
    "management": "279d1a2918ebb06b",
    "onboarding": "51a44c942663ffec",
    "scenario": "5b9bc4ba528108e4"
   },
   "after3000": "a45a2c6c988a0527",
   "afterOwners": {
    "scenarioId": "5b9bc4ba528108e4",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "e27f25d3cec6d6ce",
    "rules": "1c25989667203fbe",
    "world": "260fd82505a375d1",
    "scenery": "acb025b5b0fef6db",
    "calendar": "521d31370213cfa6",
    "weather": "e7d243c4f9b8b97e",
    "rides": "83d0c5527f98f864",
    "shops": "31fa5635f85ee93b",
    "guests": "80f37fb48774e14f",
    "operations": "84f3b069c1dd6c13",
    "progression": "b3878b04aeb19fe4",
    "management": "c781290a1e23094e",
    "onboarding": "51a44c942663ffec",
    "scenario": "5b9bc4ba528108e4"
   },
   "cash": 5000,
   "guests": 0
  },
  "sandbox-pacing-route": {
   "start": "0cf70f722d1e2a96",
   "startOwners": {
    "scenarioId": "5b9bc4ba528108e4",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "e27f25d3cec6d6ce",
    "rules": "1c25989667203fbe",
    "world": "c33d8a4c226e6e28",
    "scenery": "acb025b5b0fef6db",
    "calendar": "521d31370213cfa6",
    "weather": "e7d243c4f9b8b97e",
    "rides": "c9bfd56b5080ceff",
    "shops": "31fa5635f85ee93b",
    "guests": "fe3746e501f909b8",
    "operations": "dd4dbb3f68664560",
    "progression": "1895f17901234da4",
    "management": "279d1a2918ebb06b",
    "onboarding": "51a44c942663ffec",
    "scenario": "5b9bc4ba528108e4"
   },
   "after3000": "8fd5ef2e42622f38",
   "afterOwners": {
    "scenarioId": "5b9bc4ba528108e4",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "e27f25d3cec6d6ce",
    "rules": "1c25989667203fbe",
    "world": "8138bd519fb9b23d",
    "scenery": "04f8674e086c44ca",
    "calendar": "521d31370213cfa6",
    "weather": "e7d243c4f9b8b97e",
    "rides": "70dde1b93d4e3bb7",
    "shops": "e4fccad497b065f7",
    "guests": "ef49974cfafe1edb",
    "operations": "5e02ee8429716beb",
    "progression": "4102834d4bf11028",
    "management": "c85bb7649e0530c2",
    "onboarding": "5d704ab734d5d2f1",
    "scenario": "5b9bc4ba528108e4"
   },
   "cash": 3042.5,
   "guests": 71
  },
  "devPark": {
   "start": "ed196dc9029b7a3b",
   "startOwners": {
    "scenarioId": "5b9bc4ba528108e4",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "e27f25d3cec6d6ce",
    "rules": "1c25989667203fbe",
    "world": "541674cd06dffd91",
    "scenery": "76a1fd5bc1ecbc95",
    "calendar": "521d31370213cfa6",
    "weather": "e7d243c4f9b8b97e",
    "rides": "b26f0f0688d9d24e",
    "shops": "ee0b8ce7c487b7ed",
    "guests": "fe3746e501f909b8",
    "operations": "1616773bc06a7562",
    "progression": "1895f17901234da4",
    "management": "279d1a2918ebb06b",
    "onboarding": "62cfc04622bbcf6b",
    "scenario": "5b9bc4ba528108e4"
   },
   "after3000": "ef0e0fb768cea6c8",
   "afterOwners": {
    "scenarioId": "5b9bc4ba528108e4",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "e27f25d3cec6d6ce",
    "rules": "1c25989667203fbe",
    "world": "be6dda64577290ff",
    "scenery": "76a1fd5bc1ecbc95",
    "calendar": "521d31370213cfa6",
    "weather": "e7d243c4f9b8b97e",
    "rides": "064f3293ad5ed829",
    "shops": "62f8eb518dea70fc",
    "guests": "cf10a2611dc29a7a",
    "operations": "9f2f69f7e88c05c1",
    "progression": "9354f1406427ec76",
    "management": "e35a2c844e1bb715",
    "onboarding": "62cfc04622bbcf6b",
    "scenario": "5b9bc4ba528108e4"
   },
   "cash": 255185.1999999998,
   "guests": 471
  },
  "scenario:sunny-start": {
   "start": "d9202aa2f990f2c6",
   "startOwners": {
    "scenarioId": "c44d938624988d99",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "2fd8fc587c341409",
    "rules": "bc3938f96cddcc0a",
    "world": "88bf0363e1f649e1",
    "scenery": "acb025b5b0fef6db",
    "calendar": "521d31370213cfa6",
    "weather": "721fd293e85bc57f",
    "rides": "c9bfd56b5080ceff",
    "shops": "31fa5635f85ee93b",
    "guests": "d27a6cac9856f155",
    "operations": "dd4dbb3f68664560",
    "progression": "1895f17901234da4",
    "management": "234219fb92a8939e",
    "onboarding": "5b9bc4ba528108e4",
    "scenario": "6a419c1a46dacb58"
   },
   "after3000": "947b4ac9b94e2c68",
   "afterOwners": {
    "scenarioId": "c44d938624988d99",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "2fd8fc587c341409",
    "rules": "bc3938f96cddcc0a",
    "world": "15db1aecf56768a8",
    "scenery": "acb025b5b0fef6db",
    "calendar": "521d31370213cfa6",
    "weather": "721fd293e85bc57f",
    "rides": "83d0c5527f98f864",
    "shops": "31fa5635f85ee93b",
    "guests": "d0cf84f7ba0e46b2",
    "operations": "84f3b069c1dd6c13",
    "progression": "b3878b04aeb19fe4",
    "management": "1378709a1e8d481f",
    "onboarding": "5b9bc4ba528108e4",
    "scenario": "2b97baefcb3676cd"
   },
   "cash": 9000,
   "guests": 0
  },
  "scenario:penny-lane": {
   "start": "607ced8bb1d5fa7c",
   "startOwners": {
    "scenarioId": "f81a77831f80f21c",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "bfb6cd4fb004b323",
    "rules": "7f58870991611a50",
    "world": "93704ab67e7191bd",
    "scenery": "acb025b5b0fef6db",
    "calendar": "521d31370213cfa6",
    "weather": "beee148ba2216484",
    "rides": "c9bfd56b5080ceff",
    "shops": "31fa5635f85ee93b",
    "guests": "939a53bda3af6a7b",
    "operations": "dd4dbb3f68664560",
    "progression": "1895f17901234da4",
    "management": "aace6ecae7b37cd7",
    "onboarding": "5b9bc4ba528108e4",
    "scenario": "4a672d62b45fb09f"
   },
   "after3000": "31193111606e8334",
   "afterOwners": {
    "scenarioId": "f81a77831f80f21c",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "bfb6cd4fb004b323",
    "rules": "7f58870991611a50",
    "world": "ee0cb436aeb4d0fc",
    "scenery": "acb025b5b0fef6db",
    "calendar": "521d31370213cfa6",
    "weather": "beee148ba2216484",
    "rides": "83d0c5527f98f864",
    "shops": "31fa5635f85ee93b",
    "guests": "250ff3b125036ca8",
    "operations": "84f3b069c1dd6c13",
    "progression": "b3878b04aeb19fe4",
    "management": "f39ffa642bc209d0",
    "onboarding": "5b9bc4ba528108e4",
    "scenario": "0caff06023537614"
   },
   "cash": 11000,
   "guests": 0
  },
  "scenario:garden-gala": {
   "start": "b83341106befb321",
   "startOwners": {
    "scenarioId": "058aee78d446595e",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "b6e1294faaf733e2",
    "rules": "81d5f196cc37d660",
    "world": "e3639c69802e490c",
    "scenery": "156aae55aa46cb4d",
    "calendar": "521d31370213cfa6",
    "weather": "769b08ab468f74b3",
    "rides": "c9bfd56b5080ceff",
    "shops": "31fa5635f85ee93b",
    "guests": "dfb665b65f5f3c10",
    "operations": "dd4dbb3f68664560",
    "progression": "1895f17901234da4",
    "management": "c41ce4ac34c51724",
    "onboarding": "5b9bc4ba528108e4",
    "scenario": "2303a615e6d906c1"
   },
   "after3000": "f7cc2032586251b7",
   "afterOwners": {
    "scenarioId": "058aee78d446595e",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "b6e1294faaf733e2",
    "rules": "81d5f196cc37d660",
    "world": "363aadc8098153ad",
    "scenery": "156aae55aa46cb4d",
    "calendar": "521d31370213cfa6",
    "weather": "769b08ab468f74b3",
    "rides": "83d0c5527f98f864",
    "shops": "31fa5635f85ee93b",
    "guests": "efd5761154c4e7dc",
    "operations": "84f3b069c1dd6c13",
    "progression": "8ae676e643d646ef",
    "management": "20149e5d360576d2",
    "onboarding": "5b9bc4ba528108e4",
    "scenario": "785a4db31dc49a47"
   },
   "cash": 14000,
   "guests": 0
  },
  "scenario:starlight-finale": {
   "start": "7f96a6be16a9fd2b",
   "startOwners": {
    "scenarioId": "dff7a5bc35c0e7f9",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "8b32d94f921ecd1c",
    "rules": "36e26b2883082fca",
    "world": "813ef451ba8f0d31",
    "scenery": "d845ad89ab637c25",
    "calendar": "521d31370213cfa6",
    "weather": "b61b7fa97c6e164a",
    "rides": "c9bfd56b5080ceff",
    "shops": "31fa5635f85ee93b",
    "guests": "074a9418c7f87dfe",
    "operations": "dd4dbb3f68664560",
    "progression": "1895f17901234da4",
    "management": "aebcde70a3fa81b0",
    "onboarding": "5b9bc4ba528108e4",
    "scenario": "b97e577d8be1c3dc"
   },
   "after3000": "ce258f72e93f232e",
   "afterOwners": {
    "scenarioId": "dff7a5bc35c0e7f9",
    "activeCardIds": "09612b07b5ecb5a5",
    "seed": "8b32d94f921ecd1c",
    "rules": "36e26b2883082fca",
    "world": "9584a53703e14ba8",
    "scenery": "d845ad89ab637c25",
    "calendar": "521d31370213cfa6",
    "weather": "b61b7fa97c6e164a",
    "rides": "83d0c5527f98f864",
    "shops": "31fa5635f85ee93b",
    "guests": "259eedbb917c072a",
    "operations": "84f3b069c1dd6c13",
    "progression": "8ae676e643d646ef",
    "management": "9bcaefa86234e3d7",
    "onboarding": "5b9bc4ba528108e4",
    "scenario": "2c3848cf083e8f22"
   },
   "cash": 16000,
   "guests": 0
  }
 },
 "fixtures": {
  "dev park, 1,000 guests, coaster": {
   "final": "37b9839ed1ac1082",
   "events": "85b42f32fd2f7088",
   "fingerprints": "8d1f3ab1ce0c91b4",
   "observables": "0531a31fc777d23f"
  },
  "scenario with Pulse Cards and a rules-locked id": {
   "final": "a38348e75876bd9d",
   "events": "a55cd1bbd70c91a3",
   "fingerprints": "d9b71b690f928d5d",
   "observables": "af3c7dd0082e2717"
  },
  "scenario latched success": {
   "final": "611ca60232cc1abb",
   "events": "6aad4b929198382a",
   "fingerprints": "b8176d816a885fa3",
   "observables": "aa2f929603bdfb02"
  },
  "scenario latched failure": {
   "final": "7f3a96c21949a427",
   "events": "6ace405e46b8ecc5",
   "fingerprints": "6074455586d5f497",
   "observables": "a4b4efaafeef04cd"
  },
  "scenario mid sustain streak": {
   "final": "0876429f97742226",
   "events": "008be93323b5a50d",
   "fingerprints": "257c3bc00aee79d5",
   "observables": "26dd4d27c23b33ff"
  },
  "player-built coaster with loop and boost, bulldozed later": {
   "final": "1b9ce3ef9eb3848c",
   "events": "de00f1379c7a98ce",
   "fingerprints": "6e588caf53342bef",
   "observables": "069efc300dcf595e"
  },
  "player-built coaster with free-climb hills, bulldozed later": {
   "final": "266c12ffb53fba46",
   "events": "da2aa3c245a9890a",
   "fingerprints": "263409137e976652",
   "observables": "f7a2a57bc5589bff"
  },
  "hand-driven park: breakdown, repair, litter, closure, research": {
   "final": "c9d9c23cd337f770",
   "events": "a83316788b2bbcf1",
   "fingerprints": "d22643d3568dfe09",
   "observables": "fdebb7d1d4fb204a"
  },
  "first day: sandbox progression latching, skip and dismiss": {
   "final": "861cc46a17740a89",
   "events": "0f26f59950e20f4e",
   "fingerprints": "cb730b49c122f64a",
   "observables": "a24f1f294b0e6960"
  },
  "pre-first-step and right after removeAll": {
   "final": "3c3f5a3395da788d",
   "events": "bf28cd9330b85580",
   "fingerprints": "3f04cd268b5223de",
   "observables": "f78c32b5cc6fa4b8"
  },
  "park calendar: short days, a length change and a time lock": {
   "final": "eba869dcca654689",
   "events": "0784261b6fcf47ab",
   "fingerprints": "b43e10574683d20b",
   "observables": "504721b63b79f30a"
  },
  "weather: a stormy afternoon with a storm-closed ride, a player-closed ride and opening hours": {
   "final": "a8d02c5d6a065a79",
   "events": "cc4d7844cbe7bf85",
   "fingerprints": "ccf572985e786231",
   "observables": "388283ec32430348"
  }
 },
 "savedFixtures": {
  "park-v1-sandbox.json": [
   "05f417d27ba5e94f",
   "31f024b01f461e12",
   "9d97b75b4ebe6bb2",
   "95b7f00ac10e2fc6",
   "4672571958600756",
   "1f3ff3d798d3a161",
   "c6c1146b78176d64"
  ],
  "park-v1-scenario.json": [
   "396a1caf822fb6b4",
   "9c78b7f58d258a85",
   "190285dfbeadc1d7",
   "8fc961e540a40d8f",
   "e9dcce1c3a8b035f",
   "949db0c96cd0f190",
   "1d17128497d3cafa"
  ],
  "park-v2-sandbox.json": [
   "18b9efcf3f85668a",
   "29e2dc9ef97dffa4",
   "97a0030cda112cba",
   "0d886ac8c61e5f67",
   "de4550c8e8558bbb",
   "b184040cba1602b9",
   "b41ec7e52caffe67"
  ],
  "park-v2-scenario.json": [
   "39b863fd65982322",
   "b080f98697c2f25a",
   "ce5c5529b5b28f40",
   "d487d3d64710b871",
   "835a082abe5dcf9f",
   "8230c0859b49be34",
   "4c7b742a67fa7df2"
  ],
  "park-v3-sandbox-late.json": [
   "9f16d29ad0f3f629",
   "cfd2b4f1f0636711",
   "7933bc451366866e",
   "25c0f9c80a1d7adc",
   "6f7f234fca4c1edc",
   "aa138314fd3016f1",
   "6c16ee42eda4afe7"
  ],
  "park-v3-sandbox.json": [
   "2bb1b0f84ad2b8f6",
   "03fb89cc456491a5",
   "bdcd93f78b7d14e4",
   "f6efba8f4eb74e50",
   "a75412c8e88fd217",
   "ad6448be1704447c",
   "8466ba95bf57276f"
  ],
  "park-v3-scenario.json": [
   "4f61753e3844b553",
   "2e53f11f69ef9ba0",
   "dccbd04a883fd7d3",
   "da6c26f16576968b",
   "4cdbdccb029bc3c9",
   "fc82eebeeb84fafd",
   "efff8ae6c7fb94df"
  ],
  "park-v4-sandbox-coaster.json": [
   "3095bd92255c3a6c",
   "ab67546ef5b00d49",
   "8481d10e9e67a8d0",
   "dfbf5580fd1d5cc8",
   "3c42a730f9a30b44",
   "aba65d11533c9d96",
   "b3cff964624cabae"
  ],
  "park-v4-scenario.json": [
   "270364256d2fd4f7",
   "593f4b69c9d77508",
   "46ab21afb3cb8fb1",
   "45a618478b969aef",
   "51346ab0cc5a1f60",
   "4a79ebe70b6e890b",
   "e3f8e4911185df73"
  ],
  "park-v5-sandbox-rides.json": [
   "4c22671a34d3cb51",
   "d7abab006b2defcc",
   "c1d337cad9c33bdd",
   "160f98619ff17c4b",
   "fca5695462b5e375",
   "17f191b46f8ea2c4",
   "4ea7217475259e3e"
  ],
  "park-v5-scenario.json": [
   "b6e87bda32f2a4e8",
   "1454f6d4047e8ce8",
   "3ce82ccaf0863ab4",
   "be372ccfcc9be60e",
   "3b194684cab8fff6",
   "a809c4aa46a36c2a",
   "64c9cc2e51a1932e"
  ],
  "park-v6-sandbox-colours.json": [
   "66fba01e48e19370",
   "f6f75bceb1773bf9",
   "39faf0432bc319d2",
   "6c995de2c26a2f64",
   "1d69ebc2e6855624",
   "457ac86aa0cc9ab1",
   "67018dda7b5b17a5"
  ],
  "park-v6-scenario.json": [
   "b6e87bda32f2a4e8",
   "1454f6d4047e8ce8",
   "3ce82ccaf0863ab4",
   "be372ccfcc9be60e",
   "3b194684cab8fff6",
   "a809c4aa46a36c2a",
   "64c9cc2e51a1932e"
  ]
 },
 "pacing": {
  "latch": {
   "lay-path": 10,
   "first-ride": 10,
   "set-price": 10,
   "first-rider": 500,
   "first-food": 10,
   "first-drink": 10,
   "guest-target": 1340,
   "first-profit": 1020,
   "fix-problem": 2150,
   "good-rating": 600
  },
  "minimumCash": 1798.5
 },
 "weather": {
  "days": {
   "sandbox@1": "8e9f2cbfa43e1f94",
   "sandbox@0.6": "70d236c34c2e5dda",
   "sunny-start@1": "8d47279fd6f234a6",
   "sunny-start@0.6": "910ba0bb8122bbac",
   "penny-lane@1": "a40d5c9ad43f3fb8",
   "penny-lane@0.6": "3e7aada512835503",
   "garden-gala@1": "edaadefde06f8800",
   "garden-gala@0.6": "17579c1e1d373412",
   "starlight-finale@1": "5912bfb70f2c99fa",
   "starlight-finale@0.6": "8921ad22230a4b46"
  },
  "firstDays": [
   "sunny:sunny@0.7,sunny@0.7,sunny@0.7,cloudy@0.7",
   "cloudy:cloudy@0.54,cloudy@0.85,cloudy@0.71,cloudy@0.97",
   "sunny:sunny@0.85,sunny@0.82,sunny@0.67,cloudy@0.87",
   "hot:sunny@0.96,hot@0.81,hot@0.93,cloudy@0.99",
   "storm:cloudy@0.87,storm@0.76,rain@0.69,cloudy@0.8",
   "rain:cloudy@0.81,rain@0.8,rain@0.37,cloudy@0.88",
   "sunny:sunny@0.63,sunny@0.96,sunny@0.84,cloudy@0.81",
   "cloudy:cloudy@0.81,cloudy@0.53,cloudy@0.74,cloudy@0.87",
   "sunny:sunny@0.61,sunny@0.55,sunny@0.78,cloudy@0.8",
   "hot:sunny@0.83,hot@0.66,hot@0.78,cloudy@0.91",
   "storm:cloudy@0.86,storm@0.75,rain@0.84,cloudy@0.61",
   "storm:cloudy@0.99,storm@0.83,rain@0.76,cloudy@0.93"
  ],
  "rows": {
   "sunny@0.5": [
    0.5416666666666666,
    0.14583333333333334,
    0.2708333333333333,
    0.036458333333333336,
    0.005208333333333333
   ],
   "hot@0.5": [
    0.3655913978494623,
    0.3655913978494623,
    0.19354838709677416,
    0.02150537634408602,
    0.05376344086021505
   ],
   "cloudy@0.5": [
    0.3930635838150289,
    0.05780346820809249,
    0.3930635838150289,
    0.13294797687861273,
    0.023121387283236997
   ],
   "rain@0.5": [
    0.24999999999999997,
    0,
    0.49999999999999994,
    0.18749999999999994,
    0.06249999999999999
   ],
   "storm@0.5": [
    0.25882352941176473,
    0.047058823529411764,
    0.5176470588235295,
    0.15294117647058825,
    0.023529411764705882
   ],
   "sunny@1": [
    0.52,
    0.14,
    0.26,
    0.07,
    0.01
   ],
   "hot@1": [
    0.33999999999999997,
    0.33999999999999997,
    0.17999999999999997,
    0.039999999999999994,
    0.09999999999999998
   ],
   "cloudy@1": [
    0.34,
    0.05,
    0.34,
    0.23,
    0.04
   ],
   "rain@1": [
    0.19999999999999996,
    0,
    0.3999999999999999,
    0.29999999999999993,
    0.09999999999999998
   ],
   "storm@1": [
    0.22,
    0.04,
    0.44,
    0.26,
    0.04
   ],
   "sunny@2": [
    0.48148148148148145,
    0.12962962962962962,
    0.24074074074074073,
    0.12962962962962962,
    0.018518518518518517
   ],
   "hot@2": [
    0.2982456140350877,
    0.2982456140350877,
    0.15789473684210523,
    0.07017543859649122,
    0.17543859649122806
   ],
   "cloudy@2": [
    0.2677165354330709,
    0.03937007874015748,
    0.2677165354330709,
    0.36220472440944884,
    0.06299212598425197
   ],
   "rain@2": [
    0.14285714285714285,
    0,
    0.2857142857142857,
    0.4285714285714285,
    0.14285714285714285
   ],
   "storm@2": [
    0.1692307692307692,
    0.030769230769230767,
    0.3384615384615384,
    0.4,
    0.061538461538461535
   ]
  },
  "stationary": {
   "sunny": 0.3805239959280991,
   "hot": 0.10665577368343056,
   "cloudy": 0.30665028969445196,
   "rain": 0.16149652278382592,
   "storm": 0.044673417910192414
  }
 },
 "rules": {
  "base": "{\"startingCash\":5000,\"lockedDefinitionIds\":[],\"arrivalIntervalMultiplier\":1,\"guestBudgetMultiplier\":1,\"servicePriceToleranceMultiplier\":1,\"needDecayMultiplier\":1,\"constructionCostMultiplier\":1,\"rideOperatingCostMultiplier\":1,\"rideDispatchMultiplier\":1,\"serviceDurationMultiplier\":1,\"needReliefMultiplier\":1,\"staffSalaryMultiplier\":1,\"staffSpeedMultiplier\":1,\"wetWeatherMultiplier\":1,\"chainLiftCostMultiplier\":1,\"recolourCostMultiplier\":1,\"weatherEffectMultiplier\":1,\"nightArrivalMultiplier\":1,\"dayLengthMultiplier\":1,\"crowdCapacityMultiplier\":1,\"litterImpactMultiplier\":1,\"breakdownRateMultiplier\":1,\"sceneryAppealMultiplier\":1,\"landCostMultiplier\":1}",
  "sunny-start": "{\"startingCash\":9000,\"lockedDefinitionIds\":[],\"arrivalIntervalMultiplier\":1,\"guestBudgetMultiplier\":1,\"servicePriceToleranceMultiplier\":1,\"needDecayMultiplier\":1,\"constructionCostMultiplier\":1,\"rideOperatingCostMultiplier\":1,\"rideDispatchMultiplier\":1,\"serviceDurationMultiplier\":1,\"needReliefMultiplier\":1,\"staffSalaryMultiplier\":1,\"staffSpeedMultiplier\":1,\"wetWeatherMultiplier\":1,\"chainLiftCostMultiplier\":1,\"recolourCostMultiplier\":1,\"weatherEffectMultiplier\":1,\"nightArrivalMultiplier\":1,\"dayLengthMultiplier\":1,\"crowdCapacityMultiplier\":1,\"litterImpactMultiplier\":1,\"breakdownRateMultiplier\":1,\"sceneryAppealMultiplier\":1,\"landCostMultiplier\":1}",
  "penny-lane": "{\"startingCash\":11000,\"lockedDefinitionIds\":[],\"arrivalIntervalMultiplier\":1.3,\"guestBudgetMultiplier\":1,\"servicePriceToleranceMultiplier\":1,\"needDecayMultiplier\":1,\"constructionCostMultiplier\":1,\"rideOperatingCostMultiplier\":1,\"rideDispatchMultiplier\":1,\"serviceDurationMultiplier\":1,\"needReliefMultiplier\":1,\"staffSalaryMultiplier\":1,\"staffSpeedMultiplier\":1,\"wetWeatherMultiplier\":1,\"chainLiftCostMultiplier\":1,\"recolourCostMultiplier\":1,\"weatherEffectMultiplier\":1,\"nightArrivalMultiplier\":1,\"dayLengthMultiplier\":1,\"crowdCapacityMultiplier\":1,\"litterImpactMultiplier\":1,\"breakdownRateMultiplier\":1,\"sceneryAppealMultiplier\":1,\"landCostMultiplier\":1}",
  "garden-gala": "{\"startingCash\":14000,\"lockedDefinitionIds\":[\"tidy-totem\"],\"arrivalIntervalMultiplier\":1,\"guestBudgetMultiplier\":1,\"servicePriceToleranceMultiplier\":1,\"needDecayMultiplier\":1,\"constructionCostMultiplier\":1,\"rideOperatingCostMultiplier\":1,\"rideDispatchMultiplier\":1,\"serviceDurationMultiplier\":1,\"needReliefMultiplier\":1,\"staffSalaryMultiplier\":1,\"staffSpeedMultiplier\":1,\"wetWeatherMultiplier\":1,\"chainLiftCostMultiplier\":1,\"recolourCostMultiplier\":1,\"weatherEffectMultiplier\":1,\"nightArrivalMultiplier\":1,\"dayLengthMultiplier\":1,\"crowdCapacityMultiplier\":1,\"litterImpactMultiplier\":1,\"breakdownRateMultiplier\":1,\"sceneryAppealMultiplier\":1,\"landCostMultiplier\":1}",
  "starlight-finale": "{\"startingCash\":16000,\"lockedDefinitionIds\":[],\"arrivalIntervalMultiplier\":1.15,\"guestBudgetMultiplier\":1,\"servicePriceToleranceMultiplier\":1,\"needDecayMultiplier\":1,\"constructionCostMultiplier\":1,\"rideOperatingCostMultiplier\":1,\"rideDispatchMultiplier\":1,\"serviceDurationMultiplier\":1,\"needReliefMultiplier\":1,\"staffSalaryMultiplier\":1,\"staffSpeedMultiplier\":1,\"wetWeatherMultiplier\":1,\"chainLiftCostMultiplier\":1,\"recolourCostMultiplier\":1,\"weatherEffectMultiplier\":1,\"nightArrivalMultiplier\":1,\"dayLengthMultiplier\":1,\"crowdCapacityMultiplier\":1,\"litterImpactMultiplier\":1,\"breakdownRateMultiplier\":1,\"sceneryAppealMultiplier\":1,\"landCostMultiplier\":1}"
 }
} as const;

const strip = (state: unknown): unknown => {
  const copy = stripGuestLife(state) as Record<string, unknown> & { rules?: Record<string, unknown> };
  delete copy.map;
  delete copy.mode;
  delete copy.grant;
  if (copy.rules) {
    delete copy.rules.hungerRateMultiplier;
    delete copy.rules.thirstRateMultiplier;
  }
  return copy;
};
const h = (state: unknown): string => hashState(strip(state));
const owners = (state: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(strip(state) as Record<string, unknown>)) out[key] = hashState(value);
  return out;
};

const place = (session: ParkSession, id: string, x: number, y: number): void => {
  if (!session.world.buildObject(id, { x, y })) throw new Error(`could not place ${id}`);
};
/** pacing.test.ts's rich route, verbatim (Meadow cells: the default map's gate is (15, 31)). */
const pacingRoute = (session: ParkSession): void => {
  const cells = [];
  for (let y = 31; y >= 20; y -= 1) cells.push({ x: 15, y });
  session.world.buildPaths(cells);
  place(session, 'moonpetal-carousel', 16, 26);
  place(session, 'picnic-pocket', 16, 29);
  place(session, 'fizz-foundry', 13, 29);
  place(session, 'petal-roundabout', 16, 22);
  place(session, 'lollipop-lamp', 14, 26);
  place(session, 'lollipop-lamp', 14, 23);
  place(session, 'sunburst-flowers', 14, 22);
  session.syncWithWorld();
  const carousel = [...session.world.objects.values()].find((o) => o.definitionId === 'moonpetal-carousel')!;
  session.rides.setTicketPrice(carousel.id, 5);
  session.operations.hireStaff('cleaner');
};

const step = (session: ParkSession, ticks: number): void => {
  for (let t = 0; t < ticks; t += 1) session.step(GAME_CONFIG.fixedStepMs);
};

const parkRecord = (build: () => ParkSession, prepare?: (s: ParkSession) => void) => {
  const session = build();
  session.syncWithWorld();
  const atStart = session.serialize();
  if (prepare) prepare(session);
  step(session, 3000);
  const after = session.serialize();
  return { start: h(atStart), startOwners: owners(atStart), after3000: h(after), afterOwners: owners(after), cash: session.world.cash, guests: session.guests.guests.size };
};

const weatherDays = (seed: number, wet: number): string[] => {
  const random = new WeatherRandom(mixSeed(seed));
  const days = [firstDayOf()];
  let kind: WeatherKind = days[0].kind;
  for (let d = 2; d <= 120; d += 1) {
    const day = drawDay(kind, wet, random);
    days.push(day);
    kind = day.kind;
  }
  return days.map((day) => `${day.kind}:${day.slots.map((s) => `${s.kind}@${s.intensity}`).join(',')}`);
};

describe('Phase 24 default identity: Meadow Garden is today\'s park', () => {
  it('a fresh sandbox, the pacing-route sandbox, the dev park and every scenario: construction and 3,000 ticks', () => {
    expect(parkRecord(() => new ParkSession(null))).toEqual(PINS.parks.sandbox);
    expect(parkRecord(() => new ParkSession(null), pacingRoute)).toEqual(PINS.parks['sandbox-pacing-route']);
    expect(parkRecord(() => { const s = new ParkSession(null); seedDevPark(s); return s; })).toEqual(PINS.parks.devPark);
    for (const scenario of FOUNDING_SCENARIOS) {
      expect(parkRecord(() => new ParkSession(scenario)), scenario.id).toEqual(PINS.parks[`scenario:${scenario.id}` as keyof typeof PINS.parks]);
    }
  }, 120_000);

  it('the world key of a new Meadow park is byte-identical, with no stripping at all', () => {
    const session = new ParkSession(null);
    session.syncWithWorld();
    expect(hashState(session.serialize().world)).toBe(PINS.parks.sandbox.startOwners.world);
    expect(hashState(session.serialize().rules), 'no biome rule keys for Meadow').toBe(PINS.parks.sandbox.startOwners.rules);
    expect(Object.keys(session.serialize().rules)).not.toContain('hungerRateMultiplier');
    expect(session.seed).toBe(SANDBOX_SEED);
    expect(session.world.entrance).toEqual({ x: 15, y: 31 });
    expect(session.world.props.size).toBe(0);
  });

  it('every determinism fixture: final state, events, fingerprints and observables', () => {
    const seen = new Set<string>();
    for (const subject of DETERMINISM_FIXTURES) {
      const pinned = PINS.fixtures[subject.name as keyof typeof PINS.fixtures] as { final: string; events: string; fingerprints: string; observables: string } | undefined;
      if (!pinned) continue;
      seen.add(subject.name);
      const trace = runReference({ build: subject.build, act: subject.act, total: subject.total, checkpointTicks: new Set(), checkpoints: false, observeAtEnd: true });
      expect({ final: h(trace.finalState), events: hashState(trace.eventHashes), fingerprints: hashState(trace.fingerprints), observables: hashState(trace.observables) }, subject.name).toEqual(pinned);
    }
    expect(seen.size, 'every pinned fixture still exists').toBe(Object.keys(PINS.fixtures).length);
  }, 120_000);

  it('the First Day pacing route: the latch ticks and the lowest cash are unchanged', () => {
    const session = new ParkSession(null);
    pacingRoute(session);
    let minimumCash = session.world.cash;
    for (let t = 0; t < 9000; t += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
      minimumCash = Math.min(minimumCash, session.world.cash);
    }
    const latched = new Map(session.onboarding!.serialize().completed.map((e) => [e.id, e.tick]));
    expect({ latch: Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.id, latched.get(s.id) ?? null])), minimumCash }).toEqual(PINS.pacing);
  }, 120_000);

  it('the drawn weather: 120 days per seed, the transition rows and the stationary mix', () => {
    const seeds: Record<string, number> = { sandbox: SANDBOX_SEED };
    for (const scenario of FOUNDING_SCENARIOS) seeds[scenario.id] = scenario.seed;
    for (const [name, seed] of Object.entries(seeds)) {
      expect(hashState(weatherDays(seed, 1)), `${name}@1`).toBe(PINS.weather.days[`${name}@1` as keyof typeof PINS.weather.days]);
      expect(hashState(weatherDays(seed, 0.6)), `${name}@0.6`).toBe(PINS.weather.days[`${name}@0.6` as keyof typeof PINS.weather.days]);
    }
    expect(weatherDays(SANDBOX_SEED, 1).slice(0, 12)).toEqual(PINS.weather.firstDays);
    for (const wet of [0.5, 1, 2]) {
      for (const kind of WEATHER_KINDS) {
        expect(transitionRow(kind, wet), `${kind}@${wet}`).toEqual(PINS.weather.rows[`${kind}@${wet}` as keyof typeof PINS.weather.rows]);
      }
    }
    expect(stationaryDistribution(1)).toEqual(PINS.weather.stationary);
  });

  it('the compiled rulesets (no biome keys for Meadow, so the JSON is exactly what it was)', () => {
    expect(JSON.stringify(compileParkRules())).toBe(PINS.rules.base);
    for (const scenario of FOUNDING_SCENARIOS) expect(JSON.stringify(compileParkRules(scenario.rules)), scenario.id).toBe(PINS.rules[scenario.id as keyof typeof PINS.rules]);
    expect(SCENARIO_BY_ID.size, 'four founding scenarios plus the Phase 22 ones and the Phase 21 estate, which are not pinned here').toBe(10);
  });

  it('every frozen save before schema 8 loads and plays on the pre-change hashes (load, then every 500 ticks)', () => {
    const fixtures = import.meta.glob<Record<string, unknown>>('../save/fixtures/park-v[1-6]-*.json', { import: 'default', eager: true });
    const names = Object.keys(fixtures).map((path) => path.split('/').pop() as string).sort();
    expect(names).toEqual(Object.keys(PINS.savedFixtures).sort());
    for (const name of names) {
      const { session } = sessionFromSave(structuredClone(fixtures[`../save/fixtures/${name}`]));
      const hashes = [h(session.serialize())];
      for (let tick = 1; tick <= 3000; tick += 1) {
        session.step(GAME_CONFIG.fixedStepMs);
        if (tick % 500 === 0) hashes.push(h(session.serialize()));
      }
      expect(hashes, name).toEqual(PINS.savedFixtures[name as keyof typeof PINS.savedFixtures]);
    }
  }, 180_000);
});
