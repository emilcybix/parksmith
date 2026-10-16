import type { Cell } from '../types';

export type ServiceKind = 'food' | 'drink' | 'toilet' | 'souvenir';

export type WasteServiceKind = Exclude<ServiceKind, 'toilet' | 'souvenir'>;

/** A successful takeaway purchase that may leave packaging in the park. */
export interface ServiceCompletionEvent {
  id: number;
  serviceObjectId: number;
  guestId: number;
  kind: WasteServiceKind;
  cell: Cell;
}

export type ServiceStatus = 'idle' | 'serving' | 'closed';

export interface ServiceRuntime {
  objectId: number;
  definitionId: string;
  kind: ServiceKind;
  open: boolean;
  status: ServiceStatus;
  itemPrice: number;
  serviceTimeSeconds: number;
  queueGuestIds: number[];
  activeGuestId: number | null;
  serviceRemainingSeconds: number;
  customersServed: number;
  lifetimeRevenue: number;
  satisfactionTotal: number;
  satisfactionCount: number;
}

export interface ServiceSnapshot {
  objectId: number;
  definitionId: string;
  name: string;
  kind: ServiceKind;
  open: boolean;
  status: ServiceStatus;
  itemPrice: number;
  serviceTimeSeconds: number;
  serviceRemainingSeconds: number;
  queueLength: number;
  activeGuestId: number | null;
  estimatedWaitSeconds: number;
  customersServed: number;
  lifetimeRevenue: number;
  satisfaction: number | null;
  sceneryScore: number;
  sceneryChoiceBonus: number;
  scenerySatisfactionBonus: number;
}
