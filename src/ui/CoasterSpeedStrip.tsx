import type { CoasterLiftView } from '../game/coaster/lift';
import { speedStripModel } from './coasterSpeedStripModel';

const WIDTH = 220;
const HEIGHT = 36;

/** Speed over distance for a built coaster: one bar per track segment, coloured by how the train climbs. */
export const CoasterSpeedStrip = ({ view }: { view: CoasterLiftView }): React.JSX.Element => {
  const model = speedStripModel(view, WIDTH, HEIGHT);
  return (
    <svg
      className="coaster-speed-strip"
      role="img"
      aria-label={model.summary}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width="100%"
      preserveAspectRatio="none"
    >
      {model.bars.map((bar, index) => (
        <rect
          key={index}
          className={`speed-bar ${bar.kind}`}
          x={bar.x}
          y={HEIGHT - bar.h}
          width={Math.max(0, bar.w - 0.5)}
          height={bar.h}
        />
      ))}
      <line className="speed-creep" x1="0" x2={WIDTH} y1={model.creepY} y2={model.creepY} />
    </svg>
  );
};
