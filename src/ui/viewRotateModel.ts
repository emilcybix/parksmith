import { compassAngle, type ViewRotation } from '../rendering/viewRotation';

/** What the view buttons and the compass say for one view, as plain data so a test can pin it. */
export interface ViewRotateReadout {
  /** The compass glyph's rotation in degrees (clockwise on screen). */
  compassDegrees: number;
  /** "View 2 of 4", for the compass label and the screen reader. */
  label: string;
}

export const describeViewRotation = (rotation: ViewRotation): ViewRotateReadout => ({
  compassDegrees: compassAngle(rotation),
  label: `Map view ${rotation + 1} of 4`,
});
