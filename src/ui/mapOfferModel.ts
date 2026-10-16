import { GAME_CONFIG } from '../game/config';
import { numberWord } from './runCopy';

/** The one-time "Ready for The Map?" offer in Park Pulse (it was the Park Tour offer), as pure data. */

export type MapOfferView =
  | { visible: false }
  | {
    visible: true;
    line: string;
    openLabel: string;
    openAriaLabel: string;
    dismissLabel: string;
    dismissAriaLabel: string;
  };

export const describeMapOffer = (pending: boolean, levelCount: number = GAME_CONFIG.run.levelCount): MapOfferView => (
  pending
    ? {
      visible: true,
      line: `Ready for The Map? ${numberWord(levelCount).replace(/^./, (letter) => letter.toUpperCase())} parks in a row with a deck of cards.`,
      openLabel: 'Open The Map',
      openAriaLabel: 'Open The Map to start a run',
      dismissLabel: 'Not now',
      dismissAriaLabel: 'Not now: hide the offer to open The Map',
    }
    : { visible: false }
);
