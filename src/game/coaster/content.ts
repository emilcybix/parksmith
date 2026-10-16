export type CoasterSpecial = 'loop' | 'boost';

/**
 * A buildable coaster family: same designer, different physical limits and economy.
 * Referenced by the catalog card's definition id.
 */
export interface CoasterTypeDefinition {
  definitionId: string;
  maximumHeight: number;
  trainCapacity: number;
  trainCars: number;
  reliability: number;
  stationCost: number;
  pieceCost: number;
  heightCostPerLevel: number;
  allowedSpecials: readonly CoasterSpecial[];
}

export const COASTER_TYPES: readonly CoasterTypeDefinition[] = [
  {
    definitionId: 'comet-trail',
    maximumHeight: 2,
    trainCapacity: 12,
    trainCars: 4,
    reliability: 92,
    stationCost: 400,
    pieceCost: 45,
    heightCostPerLevel: 30,
    allowedSpecials: [],
  },
  {
    definitionId: 'star-chaser',
    maximumHeight: 3,
    trainCapacity: 10,
    trainCars: 5,
    reliability: 86,
    stationCost: 550,
    pieceCost: 55,
    heightCostPerLevel: 40,
    allowedSpecials: ['loop'],
  },
  {
    definitionId: 'skyline-serpent',
    maximumHeight: 4,
    trainCapacity: 8,
    trainCars: 6,
    reliability: 80,
    stationCost: 750,
    pieceCost: 65,
    heightCostPerLevel: 45,
    allowedSpecials: ['loop', 'boost'],
  },
] as const;

export const COASTER_TYPE_BY_ID = new Map<string, CoasterTypeDefinition>(
  COASTER_TYPES.map((type) => [type.definitionId, type]),
);
