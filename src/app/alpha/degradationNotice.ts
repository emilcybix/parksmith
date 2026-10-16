/**
 * Voxel leftovers: the words for a voxel degradation (`window.__voxelDegraded`, labels joined by '+', see
 * rendering/voxel/gpu/glFailure.ts degradedLabelFor). The renderer keeps running with less; the player is told what
 * went and where the Graphics settings are.
 */
const PARTS: Readonly<Record<string, string>> = {
  'composite-lite': 'simpler light',
  'no-weather': 'no weather effects',
  'no-lights': 'no lamp light',
  'no-shadows': 'no soft shadows',
  'no-seethrough': 'no see-through',
  'no-translucent-seethrough': 'a simpler see-through',
  'no-view-rotation': 'no map rotation',
};

export const degradationNotice = (label: string): string => {
  const parts = label.split('+').map((part) => PARTS[part]).filter((part): part is string => part !== undefined);
  const what = parts.length === 0 ? 'some effects are off' : parts.join(', ');
  return `Your graphics card refused part of the picture, so the game runs with ${what}. Settings > Graphics can switch to Lite or Classic.`;
};
