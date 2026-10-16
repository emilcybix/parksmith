import type { MapRecipe } from '../game/maps/types';
import { mapPreviewOf, type MapPreviewImage } from '../game/maps/preview';
import { generatedFor } from './newParkModel';

/** The preview image of a level's generated map (the run map's cards). Pure of the DOM; `generatedFor` and `mapPreviewOf` cache too. */

const keyOf = (recipe: MapRecipe): string => `${recipe.biomeId}|${recipe.seed}|${recipe.density}|${recipe.water ? 1 : 0}|${recipe.generatorVersion ?? ''}`;
const made = new Map<string, MapPreviewImage>();

/** The image if it was made before (so a map opened again shows its pictures at once), else null. Never generates. */
export const cachedLevelPreview = (recipe: MapRecipe): MapPreviewImage | null => made.get(keyOf(recipe)) ?? null;

export const levelPreviewOf = (recipe: MapRecipe): MapPreviewImage => {
  const key = keyOf(recipe);
  const hit = made.get(key);
  if (hit !== undefined) return hit;
  const image = mapPreviewOf(generatedFor(recipe).layout);
  made.set(key, image);
  if (made.size > 24) made.delete(made.keys().next().value as string);
  return image;
};
