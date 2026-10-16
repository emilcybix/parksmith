import { gameBridge } from '../app/gameBridge';
import { GAME_CONFIG } from '../game/config';
import type { StaffRole } from '../game/operations/types';
import { formatMoney } from './format';
import { roleLabel, staffOverview, workerActivity, workerName } from './staffWindowModel';
import { useUiStore } from './store';
import { WindowFrame } from './WindowFrame';

/**
 * Phase 42: the Staff window (a lazy chunk): the overview, the per-role controls that used to live only in the
 * Operations tab (hire, fire one, train, payroll), and one row per worker with what they are doing. A row moves the
 * camera to its worker; "Fire" dismisses exactly that worker.
 */
export const StaffWindowBody = (): React.JSX.Element | null => {
  const management = useUiStore((state) => state.management);
  const workers = useUiStore((state) => state.workers);
  const buildings = useUiStore((state) => state.buildings);
  const cash = useUiStore((state) => state.cash);
  const close = (): void => useUiStore.getState().closeWindow('staff');
  if (!management) return null;
  const operations = management.parkOperations;
  const overview = staffOverview(operations);
  const names = new Map(buildings.map((row) => [row.objectId, row.name]));
  const nameOf = (objectId: number): string | null => names.get(objectId) ?? null;
  const crewOf = (role: StaffRole) => (role === 'cleaner' ? operations.staff.cleaners : operations.staff.mechanics);
  const capacity = operations.staff.capacityPerRole;

  return (
    <WindowFrame id="staff" title="Staff" onClose={close}>
      <div className="window-kpis">
        <span className={overview.litterUnits > 0 ? 'warning' : ''}><small>LITTER</small><strong>{overview.litterUnits}</strong><em>{overview.dirtyPathTiles} tiles</em></span>
        <span className={overview.awaitingMechanic > 0 ? 'critical' : ''}><small>WAITING FOR A MECHANIC</small><strong>{overview.awaitingMechanic}</strong><em>{overview.brokenRides} broken</em></span>
        <span><small>CLEANLINESS</small><strong>{Math.round(operations.cleanliness.score)}%</strong></span>
      </div>
      {overview.hints.length > 0 && (
        <ul className="window-hints">{overview.hints.map((hint) => <li key={hint}>{hint}</li>)}</ul>
      )}
      {(['cleaner', 'mechanic'] as const).map((role) => {
        const crew = crewOf(role);
        const roleWorkers = workers.filter((worker) => worker.role === role);
        const affordable = crew.trainingCost !== null && cash >= crew.trainingCost;
        return (
          <section key={role} className="window-section staff-role">
            <header>
              <strong>{roleLabel(role)}s</strong>
              <small>{crew.busy}/{crew.total} busy · cap {capacity} · {formatMoney(crew.total * crew.salaryPerInterval)} every {operations.staff.payrollIntervalSeconds}s</small>
            </header>
            <div className="staff-actions" role="group" aria-label={`${roleLabel(role)} staffing controls`}>
              <button className="hire" onClick={() => gameBridge.hireStaff(role)} disabled={crew.total >= capacity}
                title={crew.total >= capacity ? `Crew cap reached: ${capacity} ${role}s at this park size` : `Hire one ${role}`}>＋ Hire</button>
              <button className="train" onClick={() => gameBridge.trainStaff(role)}
                disabled={crew.trainingCost === null || crew.total === 0 || !affordable}
                title={crew.trainingCost === null ? 'This crew is fully trained' : `Train the whole crew one level for ${formatMoney(crew.trainingCost)}`}>
                {crew.trainingCost === null ? `★ Trained ${crew.trainingLevel}/${operations.staff.maximumTrainingLevel}` : `★ Train ${formatMoney(crew.trainingCost)}`}
              </button>
            </div>
            {roleWorkers.length === 0
              ? <p className="empty-copy">No {role}s hired.</p>
              : (
                <ul className="worker-list" aria-label={`${roleLabel(role)}s`}>
                  {roleWorkers.map((worker) => (
                    <li key={worker.id} className={`worker-row ${worker.state}`}>
                      <button className="worker-focus" onClick={() => gameBridge.focusWorker(worker.id)} title={`Show ${workerName(worker.id)}`}>
                        <strong>{workerName(worker.id)}</strong>
                        <small>{workerActivity(worker, nameOf)}</small>
                      </button>
                      <button className="worker-fire" onClick={() => gameBridge.fireWorker(worker.id)} aria-label={`Fire ${workerName(worker.id)}`}>Fire</button>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        );
      })}
      <p className="operations-advice">
        The crew cap grows with the crowd: {GAME_CONFIG.operations.staff.baseCapacityPerRole} per role plus one per {GAME_CONFIG.operations.staff.guestsPerExtraStaff} guests.
      </p>
    </WindowFrame>
  );
};
