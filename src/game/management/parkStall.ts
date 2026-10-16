/**
 * PA-028. A park can stop being able to earn at all: no reachable ride to run, and not enough cash
 * to build or connect one. From there nothing changes no matter how long the player waits, and
 * before this the game said nothing — it kept billing wages and showing a park rating.
 *
 * The hard part is not detecting "poor and idle", which is true of a perfectly healthy park four
 * minutes in. It is detecting that there is no way out. So this asks one question — *could income
 * resume?* — and treats a free action (open a ride, open the park) as an answer, not a symptom.
 *
 * Pure and input-only, so both the true and the false cases are cheap to pin down in tests.
 */
export interface StallInputs {
  cash: number;
  /** Cost of one path tile, i.e. the price of connecting a stranded ride. */
  pathCost: number;
  /** Cheapest ride the player is allowed to build right now, research locks included. */
  cheapestRideCost: number;
  guestCount: number;
  /** Rides with entrance-connected access, whether or not they are currently open. */
  reachableRides: number;
  /** Rides that exist but have no path access — connecting one costs at least a tile. */
  unreachableRides: number;
  /**
   * Services with entrance-connected access. A service cannot attract anybody on its own —
   * arrivals require an open ride — so it is only a way back while guests are still inside.
   */
  reachableServices: number;
  dismissableStaff: number;
  /** What the whole crew costs per payroll interval, for the "stop the bleeding" line. */
  staffWageBill: number;
  /** What bulldozing everything would return, at the salvage rate. */
  demolitionValue: number;
}

export interface StallAssessment {
  stalled: boolean;
  /** Ways out that actually exist in this park, in the order worth trying. */
  exits: string[];
  message: string;
}

const money = (value: number): string => `$${Math.round(value).toLocaleString()}`;

export const assessParkStall = (inputs: StallInputs): StallAssessment => {
  // A reachable ride is a free way back: open it, open the park, and guests start arriving.
  const canRunARide = inputs.reachableRides > 0;
  // A reachable service earns from the crowd already inside, but cannot bring anyone in.
  const canServeTheCrowd = inputs.reachableServices > 0 && inputs.guestCount > 0;
  const canBuildARide = inputs.cash >= inputs.cheapestRideCost;
  const canConnectARide = inputs.unreachableRides > 0 && inputs.cash >= inputs.pathCost;
  const stalled = !canRunARide && !canServeTheCrowd && !canBuildARide && !canConnectARide;

  if (!stalled) return { stalled: false, exits: [], message: '' };

  const exits: string[] = [];
  if (inputs.dismissableStaff > 0) {
    exits.push(`dismiss your ${inputs.dismissableStaff} staff to stop ${money(inputs.staffWageBill)} of wages per shift`);
  }
  if (inputs.demolitionValue >= inputs.cheapestRideCost) {
    exits.push(`demolish what you have for about ${money(inputs.demolitionValue)}, enough for another ride`);
  }
  const message = exits.length > 0
    ? `No ride can earn and ${money(inputs.cash)} will not build one. You can still ${exits.join(', or ')}.`
    : `No ride can earn, ${money(inputs.cash)} will not build one, and there is nothing left to sell. `
      + 'This park cannot recover — start a new one from the Parks menu.';
  return { stalled: true, exits, message };
};
