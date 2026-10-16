/**
 * The fill of a preview diamond, shared by the classic renderer and the voxel overlay so the two always agree.
 *
 * - A build preview: mint when the placement is allowed, red when it is refused.
 * - A bulldoze preview: the demolition red when the bulldozer will take something (or the cell is empty: the
 *   bulldozer cursor itself), and, Phase 24, a cool slate when it will NOT: a map prop that can never be cleared,
 *   or one whose price the park cannot pay. GameApp passes `valid = false` only for those (hoverBulldoze and the
 *   drag step), so every other bulldoze preview keeps the red it always had. The voxel ghost uses the same slate
 *   (GHOST_TINT_BULLDOZE_REFUSED); a test pins the two equal.
 */
export const PREVIEW_FILL_VALID = 0x69f0c0;
export const PREVIEW_FILL_INVALID = 0xff6277;
export const PREVIEW_FILL_BULLDOZE = 0xff5f70;
export const PREVIEW_FILL_BULLDOZE_REFUSED = 0x8c97ad;

export const previewFill = (valid: boolean, bulldoze: boolean): number => (
  bulldoze
    ? valid ? PREVIEW_FILL_BULLDOZE : PREVIEW_FILL_BULLDOZE_REFUSED
    : valid ? PREVIEW_FILL_VALID : PREVIEW_FILL_INVALID
);
