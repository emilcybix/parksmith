import type { CoasterSpecial } from '../game/coaster/content';
import { Fragment, useEffect, useRef, useState } from 'react';
import { BUILD_CATALOG, BUILD_BY_ID } from '../game/content/catalog';
import { PROJECT_BY_BUILD_ID } from '../game/progression/content';
import { footprintSize } from '../game/types';
import type { BuildCategory, GameSpeed } from '../game/types';
import type { NotificationClass } from '../settings/notify';
import { gameBridge } from '../app/gameBridge';
import { runBridge } from './runBridge';
import { DEVELOPER_MODE } from '../app/devMode';
import { FirstDayCard, MapOffer } from './FirstDayCard';
import { describeFirstDay, gateInwardOnScreen, inspectorBesidePulse } from './firstDayModel';
import { ScenarioPanel } from './ScenarioHud';
import { SaveLoadButton } from './SaveLoadButton';
import { GAME_CONFIG } from '../game/config';
import { clockAriaLabel, clockLine, dayLengthOptions, TIME_LOCK_OPTIONS } from './clockModel';
import {
  climateText,
  pulseWeatherLines,
  scheduleClosedLabel,
  SEVERITY_OPTIONS,
  souvenirDemandLine,
  weatherAriaLabel,
  weatherChipGlyph,
  weatherChipLabel,
  weatherGuestLines,
  weatherTooltip,
} from './weatherModel';
import type { ServiceKind } from '../game/shops/types';
import type { GuestSnapshot } from '../game/guests/types';
import { ariaKeyShortcuts, FIXED_KEYS, helpHintItems, keyLabel, useKeybindings, withKeyHint, type ActionId } from '../settings';
import { handleRovingKey, useFocusReturn } from './a11yHooks';
import { ComplaintLink } from './ComplaintLink';
import { ColourSection } from './ColourSection';
import { dockPaint } from './paintPanelModel';
import {
  NO_TOAST_ANNOUNCED,
  openToggleLabel,
  percentLabel,
  planPulseAnnouncement,
  planToastAnnouncement,
  rovingStop,
  rovingTabIndex,
  stepperLabel,
  type PulseAnnounceState,
  type ToastAnnounceState,
} from './a11yModel';
import { useUiStore } from './store';
import { profileLockView, researchRequirementLine } from './hudLockModel';
import { describeLand } from './landModel';
import { showToast } from './showToast';
import { describeViewRotation } from './viewRotateModel';
import { CoasterSpeedStrip } from './CoasterSpeedStrip';
import { CoasterLiftRows } from './CoasterLiftRows';
import { chainCostLine } from './coasterSpeedStripModel';
import { liftSummary } from './coasterLiftRowsModel';
import { describeUndoButton } from './undoModel';
import { THEME_LABELS, inspectorThemeLine, isLocalStyle, placementThemeLine, sceneryNextStepLine, themeChipText } from './themeCopy';
import { cashDeltaText, tweenedCash } from './cashPillModel';
import { reducedMotion } from '../settings/motion';
import { CAPACITY_INSIGHT_GLYPH, describeCapacity } from './capacityModel';
import { CROWD_LEGEND_TEXT, CROWD_TOGGLE_CLASSIC_DESCRIPTION, CROWD_TOGGLE_CLASSIC_TITLE, CROWD_TOGGLE_LABEL, CROWD_TOGGLE_TITLE } from './neighborhoodModel';
import { setCrowdHeatmap } from './NeighborhoodsTab';
import {
  DEMOLISH_CONFIRM_GROUP_LABEL,
  DEMOLISH_CONFIRM_LABEL,
  DEMOLISH_KEEP_LABEL,
  demolishButtonLabel,
  demolishConfirmText,
} from './demolishModel';
import { lacksPathAccess, pathAccessNote } from './pathAccessModel';
import { buildFilterView, rideBandOf, type RideBand } from './buildFilterModel';

const categories: { id: BuildCategory; label: string; icon: string }[] = [
  { id: 'paths', label: 'Paths', icon: '⌁' },
  { id: 'rides', label: 'Rides', icon: '✦' },
  { id: 'shops', label: 'Shops', icon: '◒' },
  { id: 'facilities', label: 'Facilities', icon: '▣' },
  { id: 'comforts', label: 'Comforts', icon: '⌑' },
  { id: 'scenery', label: 'Scenery', icon: '✿' },
];

/** The tag a ride card wears for its band (Phase 29: the same bands the filter rail uses). */
const RIDE_BAND_TAGS: Readonly<Record<RideBand, { label: string; tone: string }>> = {
  coaster: { label: 'Designer', tone: 'designer' },
  gentle: { label: 'Gentle', tone: 'gentle' },
  family: { label: 'Family', tone: 'family' },
  thrill: { label: 'Thrill', tone: 'thrill' },
};

const SPEED_ACTIONS: Record<GameSpeed, ActionId> = { 0: 'speedPause', 1: 'speed1', 2: 'speed2', 4: 'speed4' };

const SpeedControls = (): React.JSX.Element => {
  const speed = useUiStore((state) => state.speed);
  const keys = useKeybindings();
  return (
    <div className="speed-controls" role="group" aria-label="Game speed">
      {([0, 1, 2, 4] as GameSpeed[]).map((value) => (
        <button
          key={value}
          className={speed === value ? 'active' : ''}
          onClick={() => gameBridge.setSpeed(value)}
          aria-pressed={speed === value}
          aria-label={value === 0 ? 'Pause' : `${value}× speed`}
          aria-keyshortcuts={ariaKeyShortcuts(SPEED_ACTIONS[value], keys)}
          title={withKeyHint(value === 0 ? 'Pause' : `${value}× speed`, SPEED_ACTIONS[value], keys)}
        >
          {value === 0 ? 'Ⅱ' : `${value}×`}
        </button>
      ))}
    </div>
  );
};

/**
 * The park clock and weather: "DAY 3 / 14:20 · Dusk" and "WEATHER / ☂ Rain". Both chips open one
 * small non-modal popover: the forecast for every park, and in a Sandbox also the day length, a fixed
 * time of day (look only), opening hours and the weather switches. A scenario park keeps the clock
 * chip a plain readout and the popover forecast-only (its time and weather are fixed). The phase and
 * weather dots are a second cue next to the words, never the only one.
 */
const ClockChip = (): React.JSX.Element => {
  const dayNumber = useUiStore((state) => state.dayNumber);
  const clockText = useUiStore((state) => state.clockText);
  const phaseLabel = useUiStore((state) => state.phaseLabel);
  const timeLock = useUiStore((state) => state.timeLock);
  const dayLengthSeconds = useUiStore((state) => state.dayLengthSeconds);
  const editable = useUiStore((state) => state.calendarEditable);
  const weather = useUiStore((state) => state.weatherUi);
  // The open flag lives in the store because the popover is an input context layer: Escape is
  // routed by GameApp (popInputContext), so it closes this one layer and nothing below it.
  const open = useUiStore((state) => state.clockPopoverOpen);
  const setOpen = useUiStore((state) => state.setClockPopoverOpen);
  const root = useRef<HTMLDivElement>(null);
  const shown = open;
  // Closing the popover with Escape while focus is inside it must not drop focus on the page.
  useFocusReturn(shown, root);
  useEffect(() => {
    if (!shown) return undefined;
    const close = (event: Event): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [shown, setOpen]);
  useEffect(() => () => setOpen(false), [setOpen]);
  const ui = { dayNumber, clockText, phaseLabel, timeLock, dayLengthSeconds, calendarEditable: editable };
  const line = clockLine(ui);
  const body = (
    <>
      <small>DAY {dayNumber}</small>
      <strong>
        <span className={`phase-dot ${phaseLabel.toLowerCase()}`} aria-hidden="true" />
        {line.time}<span className="clock-phase"> · {line.phase}</span>
      </strong>
    </>
  );
  const severityId = weather.weatherEnabled ? weather.weatherSeverity : 'off';
  const activeHours = GAME_CONFIG.calendar.hours.presets.find((preset) => (
    preset.enabled === weather.hoursEnabled && (!preset.enabled || (preset.open === weather.openHour && preset.close === weather.closeHour))
  ));
  return (
    <div className="clock-chip-wrap" ref={root}>
      {editable ? (
        <button
          className="clock-chip"
          aria-haspopup="true"
          aria-expanded={shown}
          aria-controls={shown ? 'clock-popover' : undefined}
          title={`Time and weather settings${timeLock === 'auto' ? '' : ` · sky fixed to ${(TIME_LOCK_OPTIONS.find((option) => option.id === timeLock)?.label ?? timeLock).toLowerCase()}`}`}
          onClick={() => setOpen(!open)}
        >
          {body}
        </button>
      ) : (
        <div className="clock-chip readout" role="img" aria-label={clockAriaLabel(ui)}>{body}</div>
      )}
      <button
        className="weather-chip"
        aria-label={weatherAriaLabel(weather)}
        aria-haspopup="true"
        aria-expanded={shown}
        aria-controls={shown ? 'clock-popover' : undefined}
        title={weatherTooltip(weather)}
        onClick={() => setOpen(!open)}
      >
        <small>WEATHER</small>
        <strong>
          <span className={`weather-dot ${weather.weatherEnabled ? weather.weatherKind : 'off'}`} aria-hidden="true" />
          <span className="weather-glyph" aria-hidden="true">{weatherChipGlyph(weather)}</span>
          <span className="weather-label">{weatherChipLabel(weather)}</span>
        </strong>
      </button>
      {shown && (
        <div className="clock-popover" id="clock-popover" role="group" aria-label="Time and weather">
          <div className="clock-setting">
            <span className="clock-setting-title" role="heading" aria-level={2}>Forecast</span>
            {weather.weatherEnabled ? (
              <ul className="forecast-list">
                {weather.forecastText.map((row) => <li key={row}>{row}</li>)}
              </ul>
            ) : <p className="clock-help forecast-off">Weather is switched off in this Sandbox.</p>}
            <p className="clock-help climate-line">{climateText(weather)}</p>
            {/* Phase 33: what the rain, the heat and the night do to the guests (here, never in the Pulse budget). */}
            {weatherGuestLines(weather).map((line) => <p key={line} className="clock-help weather-guest-line">{line}</p>)}
          </div>
          {editable ? (
            <>
              <div className="clock-setting">
                <span className="clock-setting-title" role="heading" aria-level={2}>Day length</span>
                <div className="clock-segments" role="group" aria-label="Day length">
                  {dayLengthOptions().map((option) => (
                    <button
                      key={option.seconds}
                      className={dayLengthSeconds === option.seconds ? 'active' : ''}
                      aria-pressed={dayLengthSeconds === option.seconds}
                      onClick={() => gameBridge.setDayLength(option.seconds)}
                    >
                      {option.label}<small>{option.detail}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div className="clock-setting">
                <span className="clock-setting-title" role="heading" aria-level={2}>Time of day</span>
                <div className="clock-segments five" role="group" aria-label="Time of day">
                  {TIME_LOCK_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      className={timeLock === option.id ? 'active' : ''}
                      aria-pressed={timeLock === option.id}
                      onClick={() => gameBridge.setTimeLock(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="clock-setting">
                <span className="clock-setting-title" role="heading" aria-level={2}>Opening hours</span>
                <div className="clock-segments three" role="group" aria-label="Opening hours">
                  {GAME_CONFIG.calendar.hours.presets.map((preset) => (
                    <button
                      key={preset.id}
                      className={activeHours?.id === preset.id ? 'active' : ''}
                      aria-pressed={activeHours?.id === preset.id}
                      onClick={() => gameBridge.setOpeningHours(preset.enabled, preset.open, preset.close)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="clock-setting">
                <span className="clock-setting-title" role="heading" aria-level={2}>Weather</span>
                <div className="clock-segments" role="group" aria-label="Weather">
                  {SEVERITY_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      className={severityId === option.id ? 'active' : ''}
                      aria-pressed={severityId === option.id}
                      onClick={() => {
                        if (option.id === 'off') gameBridge.setWeatherEnabled(false);
                        else {
                          gameBridge.setWeatherSeverity(option.id);
                          gameBridge.setWeatherEnabled(true);
                        }
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="clock-help">Fixed time only changes the look; the day keeps counting.</p>
            </>
          ) : (
            <p className="clock-help">Scenario parks use fixed time and weather.</p>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Phase 15: the shown cash tweens to the real value and a big enough change raises a delta chip (cashPillModel.ts).
 * One rAF loop while a tween runs, none in a steady state.
 */
const useAnimatedCash = (cash: number): { shown: number; delta: { text: string; gain: boolean; id: number } | null } => {
  const [shown, setShown] = useState(cash);
  const [delta, setDelta] = useState<{ text: string; gain: boolean; id: number } | null>(null);
  const previous = useRef(cash);
  const shownRef = useRef(cash);
  useEffect(() => {
    const from = shownRef.current;
    const change = cash - previous.current;
    previous.current = cash;
    if (change === 0) return undefined;
    const text = cashDeltaText(change);
    if (text !== null) setDelta((current) => ({ text, gain: change > 0, id: (current?.id ?? 0) + 1 }));
    const tween = { from, to: cash, startMs: performance.now() };
    let frame = 0;
    const tick = (): void => {
      const value = tweenedCash(tween, performance.now(), reducedMotion());
      shownRef.current = value;
      setShown(value);
      if (value !== cash) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [cash]);
  return { shown, delta };
};

export const TopBar = (): React.JSX.Element => {
  const cash = useUiStore((state) => state.cash);
  const animated = useAnimatedCash(cash);
  const parkOpen = useUiStore((state) => state.parkOpen);
  const weatherUi = useUiStore((state) => state.weatherUi);
  const scheduleClosed = scheduleClosedLabel(weatherUi);
  const managementOpen = useUiStore((state) => state.managementOpen);
  const openManagement = useUiStore((state) => state.openManagement);
  const inRun = useUiStore((state) => state.sessionMode === 'run' && state.run !== null);
  // Phase 33: the subtitle names the park on screen (it was a fixed "Garden Gate" in every park).
  const parkTitle = useUiStore((state) => state.parkTitle);
  return (
    <header className="top-bar">
      <button className="brand" onClick={() => gameBridge.focusEntrance('ease')} title="Center camera on the park entrance">
        <span className="brand-mark" aria-hidden="true">P</span>
        <span><strong>Parksmith</strong>{parkTitle !== '' && <small title={parkTitle}>{parkTitle}</small>}</span>
      </button>
      <div className="top-bar-center">
        <button
          className={`park-toggle ${parkOpen && !scheduleClosed ? 'open' : ''} ${scheduleClosed ? 'scheduled' : ''}`}
          title={scheduleClosed ? 'Held shut by the opening hours; the gate opens on schedule' : undefined}
          onClick={() => gameBridge.togglePark()}
        >
          <span className="status-dot" aria-hidden="true" /> {scheduleClosed ?? `Park ${parkOpen ? 'open' : 'closed'}`}
        </button>
        <ClockChip />
        <SpeedControls />
        {inRun ? (
          <button className="new-park" data-run-map-button onClick={() => runBridge.openRunMap()} title="Open the run map: levels, deck and offers">
            <span aria-hidden="true">⚑</span> Run map
          </button>
        ) : (
          <button className="new-park" onClick={() => gameBridge.openParksChooser('modes')} title="Sandbox, Scenario or The Map">
            <span aria-hidden="true">⚑</span> Parks
          </button>
        )}
        <SaveLoadButton className="new-park save-open" />
      </div>
      <button
        className="cash-pill"
        title="Open financial report"
        aria-label={`Available $${cash.toLocaleString()}, open the financial report`}
        aria-expanded={managementOpen}
        aria-controls={managementOpen ? 'management-dashboard' : undefined}
        onClick={() => openManagement('finances')}
      >
        <small>AVAILABLE</small><strong>${animated.shown.toLocaleString()}</strong>
        {animated.delta !== null && (
          <span key={animated.delta.id} className={`cash-delta ${animated.delta.gain ? 'gain' : 'spend'}`} aria-hidden="true">{animated.delta.text}</span>
        )}
      </button>
    </header>
  );
};

/**
 * Park Pulse changes every few seconds; only a NEW line (a fresh weather note or guest concern) is worth saying aloud, and not more often than every 12 s. Notifications are spoken only
 * by ManagementNotifications (one event, one utterance). The rules are in
 * a11yModel.planPulseAnnouncement; this only keeps the state and renders the polite region.
 */
const PulseAnnouncer = ({ lines }: { lines: readonly string[] }): React.JSX.Element => {
  const state = useRef<PulseAnnounceState | null>(null);
  const [said, setSaid] = useState('');
  const key = lines.join('\n');
  useEffect(() => {
    const plan = planPulseAnnouncement(state.current, { lines: key === '' ? [] : key.split('\n') }, Date.now());
    state.current = plan.state;
    if (plan.say !== null) setSaid(plan.say);
  }, [key]);
  return <div className="sr-only" role="status" aria-live="polite" aria-label="Park Pulse updates">{said}</div>;
};

/** Phase 30: Park Pulse shows at most this many lines under the stats (weather, capacity, crowd and thoughts together). */
export const PULSE_LINE_BUDGET = 3;

export const ParkPulse = (): React.JSX.Element => {
  const pathCount = useUiStore((state) => state.pathCount);
  const objectCount = useUiStore((state) => state.objectCount);
  const cash = useUiStore((state) => state.cash);
  const guestCount = useUiStore((state) => state.guestCount);
  const pulseInsights = useUiStore((state) => state.pulseInsights);
  const weatherUi = useUiStore((state) => state.weatherUi);
  const weatherLines = pulseWeatherLines(weatherUi);
  const guestCapacity = useUiStore((state) => state.guestCapacity);
  const atCapacity = useUiStore((state) => state.atCapacity);
  const capacity = describeCapacity(guestCapacity, guestCount, atCapacity);
  // Phase 30 (revising PA-009): a THREE-line budget, and while there is a guest thought to show, one slot is kept for
  // it, so weather, capacity and crowd together can never push every thought out. Priority among the other lines is
  // unchanged: opening hours and weather first, then capacity (Phase 11), then one neighborhood line (Phase 14).
  const crowdPulseLine = useUiStore((state) => state.crowd?.pulseLine ?? null);
  const otherBudget = PULSE_LINE_BUDGET - (pulseInsights.length > 0 ? 1 : 0);
  const shownWeatherLines = weatherLines.slice(0, otherBudget);
  const capacityLines = capacity.insight === null ? [] : [capacity.insight].slice(0, Math.max(0, otherBudget - shownWeatherLines.length));
  const crowdLines = crowdPulseLine === null ? [] : [crowdPulseLine].slice(0, Math.max(0, otherBudget - shownWeatherLines.length - capacityLines.length));
  const thoughtSlots = Math.max(0, PULSE_LINE_BUDGET - shownWeatherLines.length - capacityLines.length - crowdLines.length);
  const activeCards = useUiStore((state) => state.activeCards);
  const playedCardLines = activeCards.filter((card) => card.playState === 'played').map((card) => `${card.name} played`);
  const management = useUiStore((state) => state.management);
  const progression = useUiStore((state) => state.progression);
  const onboarding = useUiStore((state) => state.onboarding);
  const mapOfferPending = useUiStore((state) => state.mapOfferPending);
  const managementOpen = useUiStore((state) => state.managementOpen);
  const managementTab = useUiStore((state) => state.managementTab);
  const openManagement = useUiStore((state) => state.openManagement);
  const openResearch = useUiStore((state) => state.openResearch);
  const happiness = management?.operations.averageHappiness;
  const rating = management?.rating.score;
  const notificationCount = management?.notifications.length ?? 0;
  const nextMilestone = progression?.milestones.find((milestone) => !milestone.completed);
  const milestonePercent = nextMilestone
    ? Math.round(Math.min(100, nextMilestone.progress / Math.max(1, nextMilestone.target) * 100))
    : 100;
  const researchReady = progression?.projects.filter((project) => project.status === 'affordable').length ?? 0;
  const gateFacing = useUiStore((state) => state.gateFacing);
  const viewRotation = useUiStore((state) => state.viewRotation);
  const firstDay = describeFirstDay(onboarding, gateInwardOnScreen(gateFacing, viewRotation));
  const insight = objectCount === 0
    ? 'Sketch a path from the gate, then add your first attraction.'
    : pathCount < 4
      ? 'Your first attraction needs a welcoming route from the gate.'
      : guestCount === 0
        ? 'Connect a path beside a ride so guests can discover it.'
      : cash < 1_000
        ? 'Cash is getting tight. Leave room for future guest services.'
        : `${guestCount} guest${guestCount === 1 ? ' is' : 's are'} exploring your park right now.`;
  return (
    <aside className="pulse-card" aria-label="Park Pulse overview">
      {/* A one-shot played this level is a new line here too (Phase 25, design 10.3), next to the toast. */}
      {/* Phase 30: only the lines the three-line budget shows are announced, so a screen reader hears what is seen. */}
      <PulseAnnouncer lines={[...shownWeatherLines.map((line) => line.text), ...capacityLines, ...crowdLines, ...pulseInsights.slice(0, thoughtSlots).map((item) => (item.objectName == null ? item.text : `${item.text} ${item.objectName}.`)), ...playedCardLines]} />
      {/*
        Phase 30: the insight lines carry buttons (complaint links), and a button may hold no interactive content, so the
        card is three siblings: the launcher (title and stats, opens the Overview as before, the dashboard's focus
        return lands on it), the lines, and a small "Open management report" button with the same action.
      */}
      <button
        className="pulse-launcher"
        onClick={() => openManagement('overview')}
        aria-expanded={managementOpen}
        aria-controls={managementOpen ? 'management-dashboard' : undefined}
      >
        <div className="pulse-title">
          <span className="pulse-wave" aria-hidden="true">⌁</span>
          <span><small>LIVE OVERVIEW</small><strong>Park Pulse</strong></span>
          {notificationCount > 0 ? <b className="pulse-badge" aria-label={`${notificationCount} notification${notificationCount === 1 ? '' : 's'}`}>{notificationCount}</b> : <i aria-hidden="true" />}
        </div>
        <div className="pulse-stats">
          <span className="pulse-guests"><strong className={capacity.atCapacityTone ? 'at-capacity' : undefined}>{guestCount}</strong><small>{capacity.pulseLabel}</small></span>
          <span><strong>{happiness === null || happiness === undefined ? '—' : `${Math.round(happiness)}%`}</strong><small>happiness</small></span>
          <span><strong>{rating === undefined ? '—' : Math.round(rating)}</strong><small>rating</small></span>
        </div>
      </button>
      <div className="pulse-insights">
        {/* Weather and opening hours explain themselves first; they take the top of the three-line budget. */}
        {shownWeatherLines.map((line) => (
          <p key={line.text} className="pulse-weather"><span aria-hidden="true">{line.glyph}</span>{line.text}</p>
        ))}
        {capacityLines.map((text) => (
          <p key={text} className="pulse-capacity"><span aria-hidden="true">{CAPACITY_INSIGHT_GLYPH}</span>{text}</p>
        ))}
        {crowdLines.map((text) => (
          <p key={text} className="pulse-crowd"><span aria-hidden="true">≋</span>{text}</p>
        ))}
        {pulseInsights.slice(0, thoughtSlots).map((item) => (
          <p key={`${item.text}|${item.objectId ?? ''}`}>
            <span aria-hidden="true">✦</span><strong>{item.count}</strong> {item.objectId == null || item.objectName == null
              ? item.text
              : <span className="pulse-copy">{item.text} <ComplaintLink objectId={item.objectId} objectName={item.objectName} className="pulse-link" /></span>}
          </p>
        ))}
        {shownWeatherLines.length === 0 && capacityLines.length === 0 && crowdLines.length === 0 && pulseInsights.length === 0 && firstDay.mode === 'hidden'
          ? <p><span aria-hidden="true">✦</span>{insight}</p> : null}
      </div>
      <button
        className="pulse-open-report"
        onClick={() => openManagement('overview')}
        aria-expanded={managementOpen}
        aria-controls={managementOpen ? 'management-dashboard' : undefined}
      >Open management report <span aria-hidden="true">→</span></button>
      <FirstDayCard view={firstDay} compact={mapOfferPending} />
      <MapOffer />
      {progression && (
        <button
          className="pulse-research"
          onClick={() => openResearch()}
          aria-expanded={managementOpen && managementTab === 'research'}
          aria-controls={managementOpen ? 'management-dashboard' : undefined}
          title="Open research and park milestones"
        >
          <span>
            <small>{nextMilestone ? 'NEXT MILESTONE' : 'PARK PROGRESSION'}</small>
            <strong>{nextMilestone?.name ?? 'All milestones reached'}</strong>
          </span>
          <i aria-hidden="true"><b style={{ width: `${milestonePercent}%` }} /></i>
          <em>{progression.researchPoints} RP{researchReady > 0 ? ` · ${researchReady} ready` : ''}</em>
        </button>
      )}
      <ScenarioPanel />
    </aside>
  );
};

/** The bulldozer tool's icon: a small dozer with its blade, drawn in the button's text colour. */
const BulldozerIcon = (): React.JSX.Element => (
  <svg className="bulldozer-icon" viewBox="0 0 20 16" width="18" height="15" aria-hidden="true" focusable="false">
    <rect x="9" y="2" width="5" height="4" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="5.5" y="6" width="10" height="4.5" rx="0.8" fill="currentColor" />
    <rect x="4.5" y="11" width="12" height="4" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5.5 8.5 H3" stroke="currentColor" strokeWidth="1.4" />
    <path d="M1.2 5.5 Q3.4 9.25 1.2 13 H3 V5.5 Z" fill="currentColor" />
  </svg>
);

export const BuildDock = (): React.JSX.Element => {
  const keys = useKeybindings();
  const activeCategory = useUiStore((state) => state.activeCategory);
  const selected = useUiStore((state) => state.selectedDefinitionId);
  const tool = useUiStore((state) => state.tool);
  const cash = useUiStore((state) => state.cash);
  const progression = useUiStore((state) => state.progression);
  const setCategory = useUiStore((state) => state.setCategory);
  const selectBuild = useUiStore((state) => state.selectBuild);
  const selectBulldozer = useUiStore((state) => state.selectBulldozer);
  const selectLandTool = useUiStore((state) => state.selectLandTool);
  const land = useUiStore((state) => state.land);
  const selectPaint = useUiStore((state) => state.selectPaint);
  const paintBrush = useUiStore((state) => state.paintBrush);
  const paintPicking = useUiStore((state) => state.paintPicking);
  const paintPanelOpen = useUiStore((state) => state.paintPanelOpen);
  const setPaintPanelOpen = useUiStore((state) => state.setPaintPanelOpen);
  const inspectorOpen = useUiStore((state) => state.selectedRide !== null || state.selectedService !== null || state.selectedGuest !== null);
  const selectPointer = useUiStore((state) => state.selectPointer);
  const openResearch = useUiStore((state) => state.openResearch);
  const undoStatus = useUiStore((state) => state.undoStatus);
  const buildRotation = useUiStore((state) => state.buildRotation);
  const undo = describeUndoButton(undoStatus);
  // Phase 29: the filter rail (rides by kind, shops by what they sell, scenery by theme) narrows the card strip.
  const storedFilter = useUiStore((state) => state.buildFilters[state.activeCategory]);
  const setBuildFilter = useUiStore((state) => state.setBuildFilter);
  const filterView = buildFilterView(BUILD_CATALOG, activeCategory, storedFilter);
  const definitions = filterView.definitions;
  const categoryLabel = categories.find((category) => category.id === activeCategory)?.label ?? 'buildings';
  // Roving tabindex for the card grid: one tab stop (the last card focused, else the armed one, else the first).
  const [rememberedCard, setRememberedCard] = useState<string | null>(null);
  const armedIndex = tool === 'build' ? definitions.findIndex((definition) => definition.id === selected) : -1;
  const rememberedIndex = rememberedCard === null ? -1 : definitions.findIndex((definition) => definition.id === rememberedCard);
  const cardStop = rovingStop(definitions.length, rememberedIndex >= 0 ? rememberedIndex : null, armedIndex >= 0 ? armedIndex : null);
  const unlockedDefinitionIds = new Set(progression?.unlockedDefinitionIds ?? BUILD_CATALOG.map((definition) => definition.id));
  const scenario = useUiStore((state) => state.scenario);
  const scenarioLockedIds = new Set(scenario?.lockedDefinitionIds ?? []);
  const profileLocks = useUiStore((state) => state.profileLocks);
  const constructionCostMultiplier = useUiStore((state) => state.sessionRules?.constructionCostMultiplier ?? 1);
  // Phase 16: the map's biome decides which theme reads as "local style" (UI only; the rules never look at it).
  const biomeId = useUiStore((state) => state.weatherUi.biomeId);
  // Colour before placing: the brush's colour for the armed card, in words (null: the shipped colours).
  const paint = dockPaint({ tool, selectedDefinitionId: selected, brush: paintBrush, picking: paintPicking, panelOpen: paintPanelOpen, inspectorOpen });
  const nextColourName = paint.nextColourName;
  return (
    <section className="build-dock" aria-label="Construction catalog">
      <div className={`category-tabs${land !== null ? ' has-land' : ''}`}>
        {/* A real tablist holds only tabs, so the tool buttons stay outside it; CSS `display: contents` keeps one flex row. */}
        <div
          className="category-tablist"
          role="tablist"
          aria-label="Build categories"
          onKeyDown={(event) => handleRovingKey(event, { orientation: 'horizontal' }, (element) => setCategory(element.dataset.category as BuildCategory))}
        >
          {categories.map((category) => (
            <button
              key={category.id}
              id={`build-tab-${category.id}`}
              role="tab"
              aria-selected={activeCategory === category.id}
              aria-controls="build-panel"
              tabIndex={activeCategory === category.id ? 0 : -1}
              data-roving-item
              data-category={category.id}
              className={activeCategory === category.id ? 'active' : ''}
              onClick={() => setCategory(category.id)}
            >
              <span aria-hidden="true">{category.icon}</span>{category.label}
            </button>
          ))}
        </div>
        <div className="tab-spacer" />
        <button
          className={`pointer-tab ${tool === 'pointer' ? 'active' : ''}`}
          onClick={selectPointer}
          aria-pressed={tool === 'pointer'}
          title="Select and inspect buildings (Esc). Building tools stay armed until you change them."
        ><span aria-hidden="true">⌖</span>Select</button>
        {/*
          Phase 11 (PA-022): the rotation is sticky between pieces, so the button says when it is turned
          ("Rotate, now turned 90°"; the name starts with the visible text).
        */}
        <button
          className={`rotate-tab${buildRotation !== 0 ? ' rotated' : ''}`}
          // The button lays its children out as flex items, so Chromium joins them with a space ("Rotate , now turned
          // 90°"); the label says it in one piece (Wave 3 audit). It still starts with the visible "Rotate".
          aria-label={buildRotation !== 0 ? `Rotate, now turned ${buildRotation * 90}°` : undefined}
          onClick={() => gameBridge.rotateBuild()}
          aria-keyshortcuts={ariaKeyShortcuts('rotate', keys)}
          title={withKeyHint('Rotate the selected building', 'rotate', keys)}
        >
          <span aria-hidden="true">⟳</span>Rotate
          {buildRotation !== 0 && <b className="rotate-state"><span className="sr-only">, now turned </span>{buildRotation * 90}°</b>}
        </button>
        {/*
          The label says what the NEXT press does and how far back it goes ("Undo · rewinds 42 s"),
          because undo rewinds the whole park, not just the last building. It stays clickable when
          unavailable so a press says why (the toast carries the reason) instead of going quietly
          grey; `aria-disabled` tells assistive tech the truth. The label comes from the ring, or
          from GameApp while a coaster track is being drawn ("Undo track piece").
        */}
        <button
          className={undo.className}
          onClick={() => gameBridge.requestUndo()}
          aria-disabled={undo.disabled}
          aria-label={undo.ariaLabel}
          title={undo.title}
        >
          <span aria-hidden="true">⎌</span>
          <b className="undo-label">{undo.label}</b>
          {undo.depthBadge !== null && <i className="undo-depth" aria-hidden="true">{undo.depthBadge}</i>}
        </button>
        <button
          className={`bulldoze-tab ${tool === 'bulldoze' ? 'active' : ''}`}
          onClick={selectBulldozer}
          aria-pressed={tool === 'bulldoze'}
          aria-keyshortcuts={ariaKeyShortcuts('bulldozer', keys)}
          title={withKeyHint('Bulldozer: drag over paths, buildings or props to demolish them', 'bulldozer', keys)}
        ><span aria-hidden="true"><BulldozerIcon /></span>Demolish</button>
        {/* Phase 21: only an estate (land for sale) offers the Land tool; a wholly owned park keeps today's toolbar. */}
        {land !== null && (
          <button
            className={`land-tab ${tool === 'land' ? 'active' : ''}`}
            onClick={selectLandTool}
            aria-pressed={tool === 'land'}
            aria-keyshortcuts={ariaKeyShortcuts('landTool', keys)}
            title={withKeyHint(`Buy land: ${describeLand(land).summary}`, 'landTool', keys)}
            // Icon only: with a fifth tool the dock squeezed the Undo label to "U" (browser check, 2026-10-14).
            aria-label="Land"
          ><span aria-hidden="true">▦</span></button>
        )}
        <button
          className={`paint-tab ${tool === 'paint' ? 'active' : ''}`}
          onClick={() => selectPaint(false)}
          aria-pressed={tool === 'paint'}
          aria-keyshortcuts={ariaKeyShortcuts('paintTool', keys)}
          title={withKeyHint('Paint: click or drag to recolour buildings', 'paintTool', keys)}
        >
          <span aria-hidden="true">◐</span>Paint
          {paint.buttonDot !== null && <i className="paint-tab-dot" aria-hidden="true" style={{ background: paint.buttonDot }} />}
        </button>
      </div>
      <div className="armed-row">
        <p className="armed-tool" role="status" aria-live="polite">
          {tool === 'pointer'
            ? <><span aria-hidden="true">⌖</span> Select — click a ride, stall or guest to inspect it</>
            : tool === 'bulldoze'
              ? <><span className="armed" aria-hidden="true"><BulldozerIcon /></span> Bulldozer armed — drag to demolish</>
              : tool === 'paint'
                ? <><span className="armed" aria-hidden="true">◐</span> {paint.paintLine}</>
                : tool === 'land'
                  ? <><span className="armed" aria-hidden="true">▦</span> Land armed — click a parcel next to your land to buy it</>
                  : <><span className="armed" aria-hidden="true">◈</span> {BUILD_BY_ID.get(selected ?? '')?.name ?? 'Build'} armed{nextColourName ? ` — next colour ${nextColourName}` : ''} — Esc to put it down</>}
        </p>
        {paint.colourButton.visible && (
          <button
            type="button"
            className={`armed-colour${paintPanelOpen ? ' active' : ''}`}
            aria-pressed={paint.colourButton.pressed}
            title="Choose the colour of the next one you place"
            onClick={() => setPaintPanelOpen(!paintPanelOpen)}
          ><span aria-hidden="true">◐</span>Colour</button>
        )}
      </div>
      <div className="build-body">
        {filterView.chips.length > 0 && (
          <div className="build-filters" role="group" aria-label={`Filter ${categoryLabel.toLowerCase()}`}>
            {filterView.chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={`build-filter${chip.active ? ' active' : ''}`}
                aria-pressed={chip.active}
                data-filter-id={chip.id}
                title={`${chip.label}: ${chip.count} ${chip.count === 1 ? 'card' : 'cards'}`}
                onClick={() => setBuildFilter(activeCategory, chip.id)}
              >
                <span aria-hidden="true">{chip.icon}</span>{chip.label}<b>{chip.count}</b>
              </button>
            ))}
          </div>
        )}
        <div
          className="build-list"
          id="build-panel"
          role="tabpanel"
          aria-labelledby={`build-tab-${activeCategory}`}
          data-roving
          onFocus={(event) => {
            const id = (event.target as HTMLElement).closest<HTMLElement>('[data-definition-id]')?.dataset.definitionId;
            if (id && id !== rememberedCard) setRememberedCard(id);
          }}
          onKeyDown={(event) => handleRovingKey(event, { orientation: 'both', wrap: false })}
        >
          {definitions.map((definition, index) => {
            const projectId = PROJECT_BY_BUILD_ID.get(definition.id);
            const project = projectId ? progression?.projects.find((candidate) => candidate.id === projectId) : undefined;
            const profileLockText = Object.hasOwn(profileLocks, definition.id) ? profileLocks[definition.id] : undefined;
            const profileLock = profileLockText === undefined ? null : profileLockView(profileLockText);
            // A profile lock (Phase 22) is its own state: the research tree cannot open it, so it never reads as "Requires research".
            const locked = profileLock === null && Boolean(progression && !unlockedDefinitionIds.has(definition.id));
            const scenarioLocked = scenarioLockedIds.has(definition.id);
            const requirementLine = locked && project !== undefined ? researchRequirementLine(project) : null;
            const effectiveCost = Math.round(definition.buildCost * constructionCostMultiplier);
            const unaffordable = !locked && !scenarioLocked && profileLock === null && cash < effectiveCost;
            const sceneryAppeal = definition.stats?.sceneryAppeal;
            const sceneryRadius = definition.stats?.sceneryRadius;
            const isNext = tool === 'build' && selected === definition.id;
            const themeChip = themeChipText(definition.theme, biomeId);
            const localStyle = definition.theme !== undefined && isLocalStyle(definition.theme, biomeId);
            const chipDots = isNext ? paint.chip : null;
            const band = rideBandOf(definition);
            const intensityTag = band === null ? null : RIDE_BAND_TAGS[band];
            return (
              <button
                key={definition.id}
                data-roving-item
                data-definition-id={definition.id}
                tabIndex={rovingTabIndex(index, cardStop)}
                aria-pressed={selected === definition.id && tool === 'build'}
                className={`build-card ${selected === definition.id && tool === 'build' ? 'active' : ''} ${locked || scenarioLocked || profileLock !== null ? 'locked' : ''}${requirementLine !== null && !scenarioLocked ? ' needs-research' : ''} ${unaffordable ? 'unaffordable' : ''}`}
                onClick={() => {
                  if (scenarioLocked) return;
                  if (profileLock !== null) { showToast(profileLock.hint, 'routine'); return; }
                  if (locked) openResearch(projectId); else selectBuild(definition.id);
                }}
                aria-disabled={locked || scenarioLocked || profileLock !== null}
                title={scenarioLocked
                  ? `${scenario?.constraint?.name ?? 'Scenario condition'}: ${scenario?.constraint?.detail ?? 'unavailable in this park'}`
                  : profileLock !== null
                    ? profileLock.hint
                    : locked
                    ? `Research ${project?.name ?? 'this unlock'} to build ${definition.name}${requirementLine !== null ? `: ${requirementLine}` : ''}`
                    : unaffordable
                      ? `${definition.name} costs $${effectiveCost.toLocaleString()} and you have $${cash.toLocaleString()}. Pick it up anyway to line up the plot.`
                      : isNext && nextColourName ? `Next colour: ${nextColourName}` : undefined}
              >
                {chipDots && (
                  <span className="build-next-colour" aria-hidden="true">
                    {chipDots.map((hex, index) => <i key={index} className={hex === null ? 'dot-default' : undefined} style={hex === null ? undefined : { background: hex }} />)}
                  </span>
                )}
                {(locked || profileLock !== null) && !scenarioLocked && <span className="build-lock-badge">LOCKED</span>}
                {scenarioLocked && <span className="build-lock-badge scenario">UNAVAILABLE</span>}
                {unaffordable && <span className="build-lock-badge funds">SHORT ${(effectiveCost - cash).toLocaleString()}</span>}
                <span className="build-icon" aria-hidden="true" style={{ '--item-color': `#${definition.color.toString(16).padStart(6, '0')}` } as React.CSSProperties}>{definition.icon}</span>
                <span className="build-copy">
                  <strong>{definition.name}</strong>
                  <small>{definition.description}</small>
                  {intensityTag && (
                    <em className={`build-intensity-tag ${intensityTag.tone}`}>{intensityTag.label}</em>
                  )}
                  {sceneryAppeal !== undefined && sceneryRadius !== undefined && (
                    <em className="build-scenery-stat">＋{sceneryAppeal} appeal · radius {sceneryRadius}</em>
                  )}
                  {locked && !scenarioLocked && <em className="build-lock-reason"><span aria-hidden="true">⌑</span> Requires {project?.name ?? 'research'}</em>}
                  {/* Phase 33: the project's exact terms on the card itself (the research card still marks what is missing). */}
                  {locked && !scenarioLocked && requirementLine !== null && <em className="build-lock-needs">{requirementLine}</em>}
                  {profileLock !== null && !scenarioLocked && <em className="build-lock-reason profile"><span aria-hidden="true">🏆</span> {profileLock.reason}</em>}
                  {scenarioLocked && <em className="build-lock-reason"><span aria-hidden="true">⚑</span> {scenario?.constraint?.name ?? 'Scenario condition'}</em>}
                  {unaffordable && (
                    <em className="build-lock-reason funds">
                      <span aria-hidden="true">⛁</span> Need ${effectiveCost.toLocaleString()}{definition.custom ? ' to start' : ''} · you have ${cash.toLocaleString()}
                    </em>
                  )}
                </span>
                <span className="build-price">{definition.custom ? 'from ' : ''}${effectiveCost.toLocaleString()}</span>
                {/* Phase 16: the theme chip shares the price row, so a themed card is no taller (the dock height is an anchor). */}
                {themeChip !== null && (
                  <em className={`build-theme-chip${localStyle ? ' local' : ''}`} title={themeChip}>
                    {/* A local style shows a compact star (the full words fit no normal-width card); title and reader keep them. */}
                    <span className="sr-only">Theme: </span>{localStyle ? <>{THEME_LABELS[definition.theme!]}<span aria-hidden="true"> ★</span><span className="sr-only"> · local style</span></> : themeChip}
                  </em>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export const CursorReadout = (): React.JSX.Element | null => {
  const keys = useKeybindings();
  const { hoveredCell, previewCost, previewValid, previewBlock, previewTitle, previewTheme, selectedDefinitionId, tool, buildRotation, paintReadout, showCrowdHeatmap, crowd } = useUiStore((state) => state);
  if (!hoveredCell) return null;
  if (tool === 'pointer') {
    // Phase 14: with the crowd heatmap on, the pointer reads the hovered path ("Busy path · 38 guests a minute · Clover
    // Corner"): words, never colour alone. Off the network (no hover line) the readout stays hidden, as before.
    const hover = showCrowdHeatmap ? crowd?.hover ?? null : null;
    // Phase 21: unowned land is never silently unbuildable; the pointer names it ("For sale · $1,230 · Land tool (L)").
    if (hover === null && previewTitle !== null) {
      return (
        <div className="cursor-readout land-readout">
          <strong>{previewTitle}</strong>
          <small>{previewBlock ?? `${hoveredCell.x}, ${hoveredCell.y}`}</small>
        </div>
      );
    }
    if (hover === null) return null;
    return (
      <div className="cursor-readout crowd-readout">
        <strong>{hover}</strong>
        <small>{hoveredCell.x}, {hoveredCell.y}</small>
      </div>
    );
  }
  if (tool === 'paint') {
    return (
      <div className={`cursor-readout paint-readout${paintReadout?.muted ? ' muted' : ''}`}>
        <strong>{paintReadout?.title ?? 'Paint'}</strong>
        <small>{paintReadout?.detail ?? `${hoveredCell.x}, ${hoveredCell.y}`}</small>
      </div>
    );
  }
  const definition = selectedDefinitionId ? BUILD_BY_ID.get(selectedDefinitionId) : null;
  const sceneryAppeal = definition?.stats?.sceneryAppeal;
  const sceneryRadius = definition?.stats?.sceneryRadius;
  const rotatable = Boolean(definition) && definition!.kind !== 'path' && !definition!.custom;
  const [width, depth] = definition ? footprintSize(definition, buildRotation) : [0, 0];
  // The preview belongs to the armed piece only; a stale one (another card armed since) is never shown.
  const themeLine = definition?.theme && previewTheme?.theme === definition.theme ? placementThemeLine(previewTheme) : null;
  return (
    <div className={`cursor-readout ${previewValid ? '' : 'invalid'}`}>
      <strong>{tool === 'bulldoze' ? previewTitle ?? 'Demolish' : tool === 'land' ? previewTitle ?? 'Land' : definition?.name}</strong>
      {previewCost > 0 && previewTitle === null && <span>−${previewCost.toLocaleString()}</span>}
      {/* The exact reason, in the same words the click toast would use — never both at once. A block that only repeats
          the title (the armed coaster, Phase 11) is said once: the small line keeps the cell. */}
      <small>{previewBlock !== null && previewBlock !== previewTitle ? previewBlock : `${hoveredCell.x}, ${hoveredCell.y}`}</small>
      {rotatable && (
        <em className="cursor-rotation">
          ⟳ {buildRotation !== 0 && `${buildRotation * 90}° · `}{width}×{depth}{keyLabel('rotate', keys) !== '—' && ` · ${keyLabel('rotate', keys)} to rotate`}
        </em>
      )}
      {sceneryAppeal !== undefined && sceneryRadius !== undefined && (
        <em>
          ＋{sceneryAppeal} appeal within {sceneryRadius} tiles
          {/* Phase 16: what this piece adds to same-theme rides and stalls in reach (null for a themeless piece). */}
          {themeLine !== null && <span className="cursor-theme"> · {themeLine}</span>}
        </em>
      )}
    </div>
  );
};

/** Phase 30: the toast's glyph by notification class; confirmations and progress keep the tick, a refusal says "!". */
export const TOAST_GLYPHS: Readonly<Record<NotificationClass, string>> = { routine: '✓', important: '✓', alert: '!' };

export const Toast = (): React.JSX.Element | null => {
  const toast = useUiStore((state) => state.toast);
  const cls = useUiStore((state) => state.toastClass);
  const seq = useUiStore((state) => state.toastSeq);
  const announced = useRef<ToastAnnounceState>(NO_TOAST_ANNOUNCED);
  const [polite, setPolite] = useState<{ text: string; seq: number } | null>(null);
  const [assertive, setAssertive] = useState<{ text: string; seq: number } | null>(null);
  useEffect(() => {
    if (toast === null) {
      setPolite(null);
      setAssertive(null);
      return;
    }
    const plan = planToastAnnouncement(announced.current, toast, cls, Date.now());
    announced.current = plan.state;
    if (plan.say === null) return;
    // One region speaks at a time; the other is emptied so it cannot replay.
    if (plan.say.politeness === 'assertive') { setAssertive({ text: plan.say.text, seq }); setPolite(null); }
    else { setPolite({ text: plan.say.text, seq }); setAssertive(null); }
  }, [toast, cls, seq]);
  // Both live regions stay mounted while empty: a region added together with its text is not
  // reliably announced, and the undo confirmation ("press again to confirm") must be heard. A
  // refusal is an alert (assertive); confirmations and progress wait their turn (polite). Each new
  // message is a new child, so the same refusal twice is spoken twice.
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{polite ? <span key={polite.seq}>{polite.text}</span> : null}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{assertive ? <span key={assertive.seq}>{assertive.text}</span> : null}</div>
      {/* Phase 30: the class rides on the element and an alert (a refusal, an error) wears "!" instead of the tick. */}
      {toast ? <div className={`toast ${cls}`} aria-hidden="true"><span>{TOAST_GLYPHS[cls]}</span>{toast}</div> : null}
    </>
  );
};

export const UtilityBar = (): React.JSX.Element => {
  const keys = useKeybindings();
  const showGrid = useUiStore((state) => state.showGrid);
  const showPerformance = useUiStore((state) => state.showPerformance);
  const showSceneryInfluence = useUiStore((state) => state.showSceneryInfluence);
  const setGrid = useUiStore((state) => state.setGrid);
  const setPerformanceVisible = useUiStore((state) => state.setPerformanceVisible);
  const setSceneryInfluenceVisible = useUiStore((state) => state.setSceneryInfluenceVisible);
  const showCrowdHeatmap = useUiStore((state) => state.showCrowdHeatmap);
  const crowdHeatmapSupported = useUiStore((state) => state.crowdHeatmapSupported);
  const setCrowdHeatmapVisible = useUiStore((state) => state.setCrowdHeatmapVisible);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const openSettings = useUiStore((state) => state.openSettings);
  const closeSettings = useUiStore((state) => state.closeSettings);
  const toggleGrid = (): void => { setGrid(!showGrid); gameBridge.setGridVisible(!showGrid); };
  const toggleScenery = (): void => {
    const visible = !showSceneryInfluence;
    // Phase 14: the two ground heatmaps are exclusive; turning scenery on turns the crowd flow off.
    if (visible && showCrowdHeatmap) {
      setCrowdHeatmapVisible(false);
      gameBridge.setCrowdHeatmapVisible(false);
    }
    setSceneryInfluenceVisible(visible);
    gameBridge.setSceneryInfluenceVisible(visible);
  };
  const crowdOn = crowdHeatmapSupported && showCrowdHeatmap;
  return (
    <div className="utility-bar" role="group" aria-label="Park controls">
      <button
        onClick={() => gameBridge.openPauseMenu()}
        title="Menu (Esc)"
        aria-label="Menu"
        aria-haspopup="dialog"
        data-menu-button
      ><span aria-hidden="true">☰</span></button>
      <button
        className={showGrid ? 'active' : ''}
        onClick={toggleGrid}
        aria-label="Grid"
        aria-pressed={showGrid}
        aria-keyshortcuts={ariaKeyShortcuts('toggleGrid', keys)}
        title={withKeyHint('Toggle grid', 'toggleGrid', keys)}
      ><span aria-hidden="true">#</span></button>
      <button
        className={showPerformance ? 'active' : ''}
        onClick={() => setPerformanceVisible(!showPerformance)}
        aria-label="Performance overlay"
        aria-pressed={showPerformance}
        title="Performance overlay"
      ><span aria-hidden="true">⌁</span></button>
      <button
        className={showSceneryInfluence ? 'active scenery' : 'scenery'}
        onClick={toggleScenery}
        aria-label="Scenery influence"
        aria-pressed={showSceneryInfluence}
        title="Toggle scenery influence"
      ><span aria-hidden="true">✿</span></button>
      {/* Phase 14: voxel only. The classic renderer keeps it focusable but aria-disabled; a press lets GameApp say why. */}
      <button
        className={crowdOn ? 'active crowd' : 'crowd'}
        onClick={() => setCrowdHeatmap(!crowdOn)}
        aria-label={CROWD_TOGGLE_LABEL}
        aria-pressed={crowdOn}
        aria-disabled={crowdHeatmapSupported ? undefined : true}
        aria-description={crowdHeatmapSupported ? CROWD_LEGEND_TEXT : CROWD_TOGGLE_CLASSIC_DESCRIPTION}
        title={crowdHeatmapSupported ? withKeyHint(CROWD_TOGGLE_TITLE, 'toggleCrowdHeatmap', keys) : CROWD_TOGGLE_CLASSIC_TITLE}
        aria-keyshortcuts={ariaKeyShortcuts('toggleCrowdHeatmap', keys)}
      ><span aria-hidden="true">≋</span></button>
      <button
        className={settingsOpen ? 'active' : ''}
        onClick={settingsOpen ? closeSettings : openSettings}
        title="Settings"
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        data-settings-gear
      ><span aria-hidden="true">⚙</span></button>
      {DEVELOPER_MODE && (
        <>
          <i className="utility-dev-divider" aria-hidden="true" />
          {/* The Parks map that used to host this went with the Park Tour (Phase 23); the dev park lives here now. */}
          <button className="dev" onClick={() => gameBridge.startDevPark()} title="Developer: start the dev park (replaces the current park)" aria-label="⌂ Start dev park (replaces the current park)"><span aria-hidden="true">⌂</span><span className="sr-only">Start dev park</span></button>
          <button className="dev" onClick={() => gameBridge.addMoney()} title="Developer: add $5,000" aria-label="＋$ Developer: add $5,000">＋$</button>
          <button className="dev" onClick={() => gameBridge.spawnGuests()} title="Developer: spawn 25 guests" aria-label="＋G Developer: spawn 25 guests">＋G</button>
          <button className="dev" onClick={() => gameBridge.fillGuests()} title="Developer: fill the park to the guest cap" aria-label="＋＋G Developer: fill the park to the guest cap">＋＋G</button>
          <button className="dev" onClick={() => gameBridge.removeGuests()} title="Developer: remove all guests" aria-label="−G Developer: remove all guests">−G</button>
          <button className="dev" onClick={() => gameBridge.cycleDevWeather()} title="Developer: step this slot through the weather kinds" aria-label="☂ Developer: step this slot through the weather kinds">☂</button>
        </>
      )}
    </div>
  );
};

/** Always visible, so the menus can never be lost; H does the same from the keyboard. */
export const CleanViewHandle = (): React.JSX.Element | null => {
  const keys = useKeybindings();
  const cleanView = useUiStore((state) => state.cleanView);
  const toggle = useUiStore((state) => state.toggleCleanView);
  // Not over the start screen or the pause menu: there is nothing to hide, and the menu owns the keyboard.
  const menuOpen = useUiStore((state) => state.menuKind !== null);
  if (menuOpen) return null;
  return (
    <button
      className={`clean-view-handle ${cleanView ? 'active' : ''}`}
      onClick={toggle}
      aria-label={`${cleanView ? 'Show menus' : 'Hide menus'} · ${keyLabel('toggleCleanView', keys)}`}
      aria-keyshortcuts={ariaKeyShortcuts('toggleCleanView', keys)}
      title={withKeyHint(cleanView ? 'Show the menus' : 'Hide the menus to look at the park', 'toggleCleanView', keys)}
    >
      <span className="clean-view-long">{cleanView ? 'Show menus · ' : 'Hide menus · '}</span>{keyLabel('toggleCleanView', keys)}
    </button>
  );
};

/**
 * Phase 26: the two quarter-turn buttons with a compass between them. The compass is a small
 * diamond (the map's own shape) whose marked corner turns with the view. Stays visible in clean
 * view like the handle it sits beside; Q and E do the same from the keyboard. Phase 11 (PA-021):
 * after a hairline, ⌂ eases the camera back to the park entrance (V from the keyboard), so the
 * group is the "Map view" now.
 */
export const ViewRotateButtons = (): React.JSX.Element => {
  const keys = useKeybindings();
  const rotation = useUiStore((state) => state.viewRotation);
  const { compassDegrees, label } = describeViewRotation(rotation);
  return (
    <div className="view-rotate" role="group" aria-label="Map view">
      <button
        onClick={() => gameBridge.rotateView(-1)}
        aria-label={`Rotate view left · ${keyLabel('rotateViewLeft', keys)}`}
        aria-keyshortcuts={ariaKeyShortcuts('rotateViewLeft', keys)}
        title={withKeyHint('Rotate the map left', 'rotateViewLeft', keys)}
      ><span aria-hidden="true">↺</span></button>
      <svg className="view-compass" viewBox="-12 -12 24 24" role="img" aria-label={label}>
        <g transform={`rotate(${compassDegrees})`}>
          <rect x="-7" y="-7" width="14" height="14" rx="1.5" className="view-compass-map" />
          <path d="M-7 -7 H0 V-2 H-2 V0 H-7 Z" className="view-compass-mark" />
        </g>
      </svg>
      <button
        onClick={() => gameBridge.rotateView(1)}
        aria-label={`Rotate view right · ${keyLabel('rotateViewRight', keys)}`}
        aria-keyshortcuts={ariaKeyShortcuts('rotateViewRight', keys)}
        title={withKeyHint('Rotate the map right', 'rotateViewRight', keys)}
      ><span aria-hidden="true">↻</span></button>
      <i className="view-divider" aria-hidden="true" />
      <button
        className="view-recentre"
        onClick={() => gameBridge.focusEntrance('ease')}
        aria-label={`Recentre view · ${keyLabel('recentreView', keys)}`}
        aria-keyshortcuts={ariaKeyShortcuts('recentreView', keys)}
        title={withKeyHint('Recentre on the park entrance', 'recentreView', keys)}
      ><span aria-hidden="true">⌂</span></button>
    </div>
  );
};

/** The bottom-right cluster: the view buttons beside the clean-view handle, hidden over the menus. */
export const ViewControls = (): React.JSX.Element | null => {
  const menuOpen = useUiStore((state) => state.menuKind !== null);
  if (menuOpen) return null;
  return (
    <div className="view-controls">
      <ViewRotateButtons />
      <CleanViewHandle />
    </div>
  );
};

export const PerformanceOverlay = (): React.JSX.Element | null => {
  const visible = useUiStore((state) => state.showPerformance);
  const perf = useUiStore((state) => state.performance);
  const tick = useUiStore((state) => state.tick);
  if (!visible) return null;
  return (
    <aside className="performance-overlay" aria-label="Performance statistics">
      <strong>PERFORMANCE</strong>
      <span>FPS <b>{perf.fps}</b></span>
      <span>SIM <b>{perf.simulationMs.toFixed(2)} ms</b></span>
      <span>RENDER <b>{perf.renderMs.toFixed(2)} ms</b></span>
      <span>ENTITIES <b>{perf.entities}</b></span>
      <span>TICK <b>{tick}</b></span>
      <span>PATHFIND <b>{perf.pathfindingRequests} / sec</b></span>
      {perf.gpu && (
        <>
          <span>ZOOM <b>{perf.gpu.zoom}</b> · TARGET <b>{perf.gpu.lowWidth}×{perf.gpu.lowHeight}</b> ({((perf.gpu.lowWidth * perf.gpu.lowHeight) / 1e6).toFixed(2)} M)</span>
          {perf.gpu.passes
            ? <span>GPU <b>{(perf.gpu.passes.gbuffer + perf.gpu.passes.light + perf.gpu.passes.composite + perf.gpu.passes.upscale).toFixed(2)} ms</b> (G {perf.gpu.passes.gbuffer.toFixed(2)} · L {perf.gpu.passes.light.toFixed(2)} · C {perf.gpu.passes.composite.toFixed(2)} · U {perf.gpu.passes.upscale.toFixed(2)})</span>
            : <span>GPU <b>no timer queries</b></span>}
        </>
      )}
    </aside>
  );
};

const formatWait = (seconds: number): string => {
  if (seconds <= 0) return 'No wait';
  if (seconds < 60) return '< 1 min';
  return `${Math.ceil(seconds / 60)} min`;
};

interface SceneryImpactProps {
  score: number;
  choiceBonus: number;
  satisfactionBonus: number;
  /** Phase 16: the theme line ("Theme · Carnival: ＋6 from 2 carnival pieces (max ＋10)"); null for a themeless one. */
  themeLine: string | null;
  /** Phase 49: the next step line (`sceneryNextStepLine`); null at the top or before it is published. */
  nextLine: string | null;
}

/** Phase 49: the inspector's next scenery step for one ride or stall. */
const useSceneryNextLine = (objectId: number, score: number): string | null => {
  const next = useUiStore((state) => state.sceneryNextStep);
  return sceneryNextStepLine(score, next, objectId);
};

/** Phase 16: the inspector's theme line for one ride or stall, from the park's scenery snapshot. */
const useThemeLine = (objectId: number, definitionId: string): string | null => {
  const theme = BUILD_BY_ID.get(definitionId)?.theme;
  const affinity = useUiStore((state) => state.scenery?.themeAffinity ?? 0);
  const themeBonus = useUiStore((state) => state.scenery?.destinations.find((entry) => entry.objectId === objectId)?.themeBonus);
  const matchingSources = useUiStore((state) => state.scenery?.destinations.find((entry) => entry.objectId === objectId)?.matchingSources);
  return inspectorThemeLine(theme, matchingSources === undefined ? undefined : { themeBonus: themeBonus ?? 0, matchingSources }, affinity);
};

const SceneryImpact = ({ score, choiceBonus, satisfactionBonus, themeLine, nextLine }: SceneryImpactProps): React.JSX.Element => (
  <section className="scenery-impact" aria-label={`Area scenery score ${Math.round(score)}`}>
    <header><span><small>AREA SCENERY</small><strong>{score > 0 ? 'A more inviting setting' : 'No nearby scenery influence'}</strong></span><b>{Math.round(score)}</b></header>
    <div className="scenery-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, score))}%` }} /></div>
    {/* Before the bonus grid, which stays the last child (a11y.css darkens its small print through that selector). */}
    {themeLine !== null && <p className="scenery-theme-line">{themeLine}</p>}
    {nextLine !== null && <p className="scenery-theme-line scenery-next-line">{nextLine}</p>}
    <div>
      <span><small>CHOICE BONUS</small><strong>+{choiceBonus.toFixed(1)}</strong></span>
      <span><small>SATISFACTION</small><strong>+{satisfactionBonus.toFixed(1)}</strong></span>
    </div>
  </section>
);

/** The fixed Delete / Backspace row, read for the button's hint so the words match KEYBINDINGS.md. */
const DEMOLISH_KEYS = FIXED_KEYS.find((row) => row.label === 'Demolish')?.keys ?? null;

/**
 * Phase 11 (PA-015): the inspector's last control. The button opens a confirmation that replaces
 * it (the open id lives in the store, so Delete / Backspace and Escape, routed by GameApp, see the
 * same state). Focus lands on Keep it, the safe button, when it opens, and goes back to the
 * Demolish button when it closes with the inspector still open (Keep it, Escape), but only when
 * focus was in the inspector or lost with the group: a canvas click keeps its focus.
 */
const DemolishControl = ({ objectId, name }: { objectId: number; name: string }): React.JSX.Element => {
  const refund = useUiStore((state) => state.selectedDemolitionRefund);
  const confirmId = useUiStore((state) => state.demolishConfirmId);
  const openConfirm = useUiStore((state) => state.openDemolishConfirm);
  const closeConfirm = useUiStore((state) => state.closeDemolishConfirm);
  const confirming = confirmId === objectId;
  const root = useRef<HTMLDivElement>(null);
  const demolishButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  // The id whose confirmation was open at the last render: a selection change to another object never pulls focus.
  const wasConfirming = useRef<number | null>(null);
  useEffect(() => {
    if (confirming) keepButton.current?.focus();
    else if (wasConfirming.current === objectId) {
      const active = document.activeElement;
      const inspector = root.current?.closest('.ride-inspector');
      if (active === null || active === document.body || (inspector?.contains(active) ?? false)) demolishButton.current?.focus();
    }
    wasConfirming.current = confirming ? objectId : null;
  }, [confirming, objectId]);
  if (!confirming) {
    return (
      <div className="inspector-demolish" ref={root}>
        <button
          ref={demolishButton}
          className="demolish-button"
          onClick={() => openConfirm(objectId)}
          aria-keyshortcuts="Delete Backspace"
          title={DEMOLISH_KEYS === null ? `Demolish ${name}` : `Demolish ${name} (${DEMOLISH_KEYS})`}
        >{demolishButtonLabel(refund)}</button>
      </div>
    );
  }
  return (
    <div className="inspector-demolish" ref={root}>
      <div className="demolish-confirm" role="group" aria-label={DEMOLISH_CONFIRM_GROUP_LABEL}>
        <p>{demolishConfirmText(name, refund)}</p>
        <div className="demolish-confirm-actions">
          <button ref={keepButton} className="demolish-keep" onClick={() => closeConfirm()}>{DEMOLISH_KEEP_LABEL}</button>
          <button className="demolish-confirm-button" onClick={() => gameBridge.demolishSelected()}>{DEMOLISH_CONFIRM_LABEL}</button>
        </div>
      </div>
    </div>
  );
};

/** Phase 11 (PA-024): the text twin of the voxel no-access badge, under the state row. */
const PathAccessNote = ({ objectId }: { objectId: number }): React.JSX.Element | null => {
  const note = useUiStore((state) => pathAccessNote(lacksPathAccess(state.noPathAccessIds, objectId)));
  return note === null ? null : <p className="inspector-warning" role="note">{note}</p>;
};

/** Phase 30: shown when a ride's intensity is above the nausea floor (GAME_CONFIG.guestLife.nausea.minimumIntensity). */
export const INTENSE_RIDE_NOTE = 'Intense: some riders feel queasy';

export const RideInspector = (): React.JSX.Element | null => {
  const ride = useUiStore((state) => state.selectedRide);
  const cinematicAvailable = useUiStore((state) => state.cinematicAvailable);
  const coasterLift = useUiStore((state) => state.selectedCoasterLift);
  const colours = useUiStore((state) => state.selectedColours);
  const besidePulse = useUiStore((state) => inspectorBesidePulse(state.onboarding, state.mapOfferPending));
  useFocusReturn(ride !== null);
  const themeLine = useThemeLine(ride?.objectId ?? -1, ride?.definitionId ?? '');
  const nextLine = useSceneryNextLine(ride?.objectId ?? -1, ride?.sceneryScore ?? 0);
  if (!ride) return null;
  const definition = BUILD_BY_ID.get(ride.definitionId);
  const satisfaction = ride.satisfaction === null ? '—' : `${Math.round(ride.satisfaction)}%`;
  const cycleProgress = ride.status === 'running'
    ? Math.max(0, Math.min(100, 100 - ride.cycleRemainingSeconds / ride.rideDurationSeconds * 100))
    : 0;
  const conditionTone = ride.broken || ride.pendingBreakdown
    ? 'critical'
    : ride.condition < 35 ? 'critical' : ride.condition < 65 ? 'warning' : 'good';
  const conditionLabel = ride.broken ? 'Broken down' : ride.condition < 35 ? 'Critical wear' : ride.condition < 65 ? 'Needs inspection' : 'Good condition';
  const maintenanceProgress = Math.round(ride.maintenanceProgress * 100);
  const breakdownRisk = `${(ride.breakdownChance * 100).toFixed(1)}%`;
  const band = definition === undefined ? null : rideBandOf(definition);
  return (
    <aside className={`ride-inspector${besidePulse ? ' beside-pulse' : ''}`} aria-label={`Ride inspector: ${ride.name}`}>
      <header>
        <span className="inspector-icon" aria-hidden="true" style={{ '--ride-color': `#${definition?.color.toString(16).padStart(6, '0') ?? '57d9ad'}` } as React.CSSProperties}>{definition?.icon ?? '✦'}</span>
        <span><small>ATTRACTION</small><strong role="heading" aria-level={2}>{ride.name}</strong></span>
        <button onClick={() => gameBridge.closeInspector()} title="Close inspector (Esc)" aria-label="Close inspector"><span aria-hidden="true">×</span></button>
      </header>
      <div className="ride-state-row">
        <span className={`ride-status ${ride.status}`}><i aria-hidden="true" />{ride.status}{ride.closureReason === 'storm' && <b className="ride-closure"> · storm</b>}</span>
        <button className={ride.open ? 'ride-open' : 'ride-closed'} aria-label={openToggleLabel('Ride', ride.open)} onClick={() => gameBridge.setSelectedRideOpen(!ride.open)}>
          {ride.open ? 'Open' : 'Closed'}
        </button>
      </div>
      <PathAccessNote objectId={ride.objectId} />
      {/* Phase 41 step 4: ride along (the lead car of a coaster, a close circle round a flat ride). */}
      {cinematicAvailable && (
        <button className="ride-along-button" onClick={() => gameBridge.startRideAlong(ride.objectId)} title="Ride along: Esc returns to the park">
          <span aria-hidden="true">▶</span> {definition?.custom === 'coaster' ? 'Ride along' : 'Ride view'}
        </button>
      )}
      {/* Phase 30: every ride says its band and numbers (only custom coasters did); an intense one warns about queasy riders. */}
      {band !== null && (
        <p className="ride-band-line">
          <em className={`build-intensity-tag ${RIDE_BAND_TAGS[band].tone}`}>{RIDE_BAND_TAGS[band].label}</em>
          <span>Excitement {Math.round(ride.excitement)} · Intensity {Math.round(ride.intensity)}</span>
          {ride.intensity > GAME_CONFIG.guestLife.nausea.minimumIntensity && <b className="ride-intense-note">{INTENSE_RIDE_NOTE}</b>}
        </p>
      )}
      {ride.status === 'running' && (
        <div className="cycle-progress"><i aria-hidden="true" style={{ width: `${cycleProgress}%` }} /><span>{Math.ceil(ride.cycleRemainingSeconds)}s remaining</span></div>
      )}
      <div className="price-control">
        <span><small>TICKET PRICE</small><strong role="status"><span className="sr-only">Ticket price </span>${ride.ticketPrice.toFixed(2)}</strong></span>
        <div role="group" aria-label="Ticket price">
          <button onClick={() => gameBridge.adjustSelectedRidePrice(-0.5)} aria-label={stepperLabel('lower', 'ticket price', 0.5)}><span aria-hidden="true">−</span></button>
          <button onClick={() => gameBridge.adjustSelectedRidePrice(0.5)} aria-label={stepperLabel('raise', 'ticket price', 0.5)}><span aria-hidden="true">＋</span></button>
        </div>
      </div>
      <ColourSection definitionId={ride.definitionId} colours={colours} />
      {ride.coaster && (
        <section className="coaster-evidence" aria-label="Coaster design evidence">
          <header><span><small>CUSTOM COASTER</small><strong>Excitement {Math.round(ride.excitement)} · Intensity {Math.round(ride.intensity)}</strong></span></header>
          <p>
            {ride.coaster.pieces} track pieces · {ride.coaster.turns} turns · {ride.coaster.drops} drop{ride.coaster.drops === 1 ? '' : 's'}
            {' '}({ride.coaster.totalDescent} levels of descent) · highest point {ride.coaster.highestHeight}
            {' '}· top speed {ride.coaster.topSpeed}
            {ride.coaster.loops > 0 ? ` · ${ride.coaster.loops} loop${ride.coaster.loops === 1 ? '' : 's'}` : ''}
            {ride.coaster.boosts > 0 ? ` · ${ride.coaster.boosts} boost${ride.coaster.boosts === 1 ? '' : 's'}` : ''}
          </p>
          {coasterLift && (
            <>
              <CoasterSpeedStrip view={coasterLift} />
              <p className="coaster-strip-legend">
                <i className="chain" aria-hidden="true" /> chain
                <i className="free" aria-hidden="true" /> free climb
                <i className="creep" aria-hidden="true" /> crawl
                <i className="other" aria-hidden="true" /> rolling
              </p>
              <p className="coaster-chain-cost">{chainCostLine(coasterLift)}</p>
            </>
          )}
        </section>
      )}
      {ride.maintenanceKind !== null && (
        <div className="maintenance-progress">
          <span><strong>{ride.maintenanceKind === 'repair' ? 'Repair in progress' : 'Safety inspection'}</strong><small>{maintenanceProgress}%</small></span>
          <div aria-hidden="true"><i style={{ width: `${maintenanceProgress}%` }} /></div>
        </div>
      )}
      <section className={`ride-condition-panel ${conditionTone}`}>
        <header>
          <span><small>RIDE CONDITION</small><strong>{conditionLabel}</strong></span>
          <b>{Math.round(ride.condition)}%</b>
        </header>
        <div className={`condition-meter ${conditionTone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ride.condition)} aria-label={percentLabel(`${ride.name} condition`, ride.condition)}>
          <i style={{ width: `${ride.condition}%` }} />
        </div>
        <div className="ride-condition-stats">
          <span><small>RELIABILITY</small><strong>{Math.round(ride.reliability)}%</strong></span>
          <span><small>BREAKDOWN RISK</small><strong>{breakdownRisk}<em>/cycle</em></strong></span>
          <span><small>STATUS</small><strong>{ride.broken
            ? 'Awaiting repair'
            : ride.pendingBreakdown
              ? 'Failure pending'
              : ride.maintenanceKind
                ? 'Under maintenance'
                : 'Operational'}</strong></span>
        </div>
        {ride.pendingBreakdown && !ride.broken && <p className="ride-condition-alert">A failure was detected. The ride will stop safely after this cycle.</p>}
      </section>
      <SceneryImpact
        score={ride.sceneryScore}
        choiceBonus={ride.sceneryChoiceBonus}
        satisfactionBonus={ride.scenerySatisfactionBonus}
        themeLine={themeLine}
        nextLine={nextLine}
      />
      <div className="ride-metrics">
        <span><small>QUEUE</small><strong>{ride.queueLength}</strong></span>
        <span><small>EST. WAIT</small><strong>{formatWait(ride.estimatedWaitSeconds)}</strong></span>
        <span><small>RIDERS</small><strong>{ride.ridersToday}</strong></span>
        <span><small>THROUGHPUT</small><strong>{ride.throughputPerHour}/hr</strong></span>
      </div>
      <dl className="ride-details">
        <div><dt>Capacity</dt><dd>{ride.capacity} guests</dd></div>
        <div><dt>Satisfaction</dt><dd>{satisfaction}</dd></div>
        <div><dt>Revenue</dt><dd className="positive">${ride.lifetimeRevenue.toFixed(2)}</dd></div>
        <div><dt>Operating cost</dt><dd>${ride.operatingCost}/cycle</dd></div>
        <div><dt>Breakdowns</dt><dd>{ride.breakdownCount}</dd></div>
        <div><dt>Inspections / repairs</dt><dd>{ride.inspectionsCompleted} / {ride.repairsCompleted}</dd></div>
        <div><dt>Maintenance cost</dt><dd>${ride.lifetimeMaintenanceCost.toFixed(2)}</dd></div>
      </dl>
      <DemolishControl objectId={ride.objectId} name={ride.name} />
      {DEVELOPER_MODE && (
        <button
          className="inspector-dev-action"
          onClick={() => gameBridge.forceSelectedRideBreakdown()}
          disabled={ride.broken || ride.maintenanceKind !== null}
          title="Developer: force this ride to break down"
        >
          DEV · Force breakdown
        </button>
      )}
    </aside>
  );
};

/** Phase 30: the service inspector's words per kind (souvenir stalls read as "DRINK STALL" before). */
const SERVICE_CATEGORY: Readonly<Record<ServiceKind, string>> = { food: 'FOOD STALL', drink: 'DRINK STALL', toilet: 'FACILITY', souvenir: 'SOUVENIR STALL' };
const SERVICE_INSPECTOR_KIND: Readonly<Record<ServiceKind, string>> = { food: 'Food stall', drink: 'Drink stall', toilet: 'Facility', souvenir: 'Souvenir stall' };
export const SERVICE_TYPE_LABEL: Readonly<Record<ServiceKind, string>> = { food: 'Food', drink: 'Drinks', toilet: 'Toilets', souvenir: 'Souvenirs' };

export const ServiceInspector = (): React.JSX.Element | null => {
  const service = useUiStore((state) => state.selectedService);
  const besidePulse = useUiStore((state) => inspectorBesidePulse(state.onboarding, state.mapOfferPending));
  const colours = useUiStore((state) => state.selectedColours);
  const weatherUi = useUiStore((state) => state.weatherUi);
  useFocusReturn(service !== null);
  const themeLine = useThemeLine(service?.objectId ?? -1, service?.definitionId ?? '');
  const nextLine = useSceneryNextLine(service?.objectId ?? -1, service?.sceneryScore ?? 0);
  if (!service) return null;
  const definition = BUILD_BY_ID.get(service.definitionId);
  const satisfaction = service.satisfaction === null ? '—' : `${Math.round(service.satisfaction)}%`;
  const progress = service.status === 'serving'
    ? Math.max(0, Math.min(100, 100 - service.serviceRemainingSeconds / service.serviceTimeSeconds * 100))
    : 0;
  const category = SERVICE_CATEGORY[service.kind];
  const inspectorKind = SERVICE_INSPECTOR_KIND[service.kind];
  // Phase 30: a souvenir stall says whether its keepsake is wanted right now, by the guests' own rule (weatherUi).
  const souvenirKind = service.kind === 'souvenir' ? definition?.stats?.souvenir ?? null : null;
  return (
    <aside className={`ride-inspector service-inspector${besidePulse ? ' beside-pulse' : ''}`} aria-label={`${inspectorKind} inspector: ${service.name}`}>
      <header>
        <span className="inspector-icon" aria-hidden="true" style={{ '--ride-color': `#${definition?.color.toString(16).padStart(6, '0') ?? '57d9ad'}` } as React.CSSProperties}>{definition?.icon ?? '◒'}</span>
        <span><small>{category}</small><strong role="heading" aria-level={2}>{service.name}</strong></span>
        <button onClick={() => gameBridge.closeInspector()} title="Close inspector (Esc)" aria-label="Close inspector"><span aria-hidden="true">×</span></button>
      </header>
      <div className="ride-state-row">
        <span className={`ride-status ${service.status}`}><i aria-hidden="true" />{service.status}</span>
        <button className={service.open ? 'ride-open' : 'ride-closed'} aria-label={openToggleLabel(service.kind === 'toilet' ? 'Facility' : 'Stall', service.open)} onClick={() => gameBridge.setSelectedServiceOpen(!service.open)}>
          {service.open ? 'Open' : 'Closed'}
        </button>
      </div>
      <PathAccessNote objectId={service.objectId} />
      {service.status === 'serving' && (
        <div className="cycle-progress"><i aria-hidden="true" style={{ width: `${progress}%` }} /><span>{Math.ceil(service.serviceRemainingSeconds)}s remaining</span></div>
      )}
      <SceneryImpact
        score={service.sceneryScore}
        choiceBonus={service.sceneryChoiceBonus}
        satisfactionBonus={service.scenerySatisfactionBonus}
        themeLine={themeLine}
        nextLine={nextLine}
      />
      <div className="ride-metrics">
        <span><small>QUEUE</small><strong>{service.queueLength}</strong></span>
        <span><small>EST. WAIT</small><strong>{formatWait(service.estimatedWaitSeconds)}</strong></span>
        <span><small>SERVED</small><strong>{service.customersServed}</strong></span>
        <span><small>SATISFACTION</small><strong>{satisfaction}</strong></span>
      </div>
      <div className="price-control">
        <span><small>{service.kind === 'toilet' ? 'ACCESS PRICE' : 'ITEM PRICE'}</small><strong role="status"><span className="sr-only">{service.kind === 'toilet' ? 'Access price ' : 'Item price '}</span>${service.itemPrice.toFixed(2)}</strong></span>
        <div role="group" aria-label={service.kind === 'toilet' ? 'Access price' : 'Item price'}>
          <button onClick={() => gameBridge.adjustSelectedServicePrice(-0.5)} aria-label={stepperLabel('lower', service.kind === 'toilet' ? 'access price' : 'item price', 0.5)}><span aria-hidden="true">−</span></button>
          <button onClick={() => gameBridge.adjustSelectedServicePrice(0.5)} aria-label={stepperLabel('raise', service.kind === 'toilet' ? 'access price' : 'item price', 0.5)}><span aria-hidden="true">＋</span></button>
        </div>
      </div>
      <ColourSection definitionId={service.definitionId} colours={colours} />
      <dl className="ride-details">
        <div><dt>Service type</dt><dd>{SERVICE_TYPE_LABEL[service.kind]}</dd></div>
        {souvenirKind !== null && <div><dt>Demand now</dt><dd>{souvenirDemandLine(souvenirKind, weatherUi)}</dd></div>}
        <div><dt>Service time</dt><dd>{service.serviceTimeSeconds.toFixed(1)} sec</dd></div>
        <div><dt>Current guest</dt><dd>{service.activeGuestId === null ? '—' : `#${service.activeGuestId}`}</dd></div>
        <div><dt>Revenue</dt><dd className="positive">${service.lifetimeRevenue.toFixed(2)}</dd></div>
      </dl>
      <DemolishControl objectId={service.objectId} name={service.name} />
    </aside>
  );
};

/** Phase 30: the guest inspector's words for the likes band (the same bands as the build cards, rideBandOf). */
const LIKES_LABEL: Readonly<Record<GuestSnapshot['likes'], string>> = { gentle: 'Likes gentle rides', family: 'Likes family rides', thrill: 'Likes thrill rides' };

/** Phase 30: the comfort chips, in the order they are shown; only the true ones render. */
export const GUEST_FLAGS: ReadonlyArray<{ key: 'tired' | 'queasy' | 'hot' | 'cold' | 'soaked'; label: string }> = [
  { key: 'tired', label: 'Tired' },
  { key: 'queasy', label: 'Queasy' },
  { key: 'hot', label: 'Too hot' },
  { key: 'cold', label: 'Cold' },
  { key: 'soaked', label: 'Soaked' },
];

/** Phase 30: the warmth tile's word, from the same thresholds as the guest's own flags. */
export const warmthLabel = (guest: Pick<GuestSnapshot, 'hot' | 'cold'>): string => (guest.hot ? 'hot' : guest.cold ? 'cold' : 'comfortable');

/** "In the park 12 min" (under a minute: seconds). */
const ageText = (seconds: number): string => (seconds < 60 ? `${Math.floor(seconds)} s` : `${Math.floor(seconds / 60)} min`);

/**
 * Phase 30: the guest inspector. The pointer's click on a guest figure (where no ride or stall is) opens it in the
 * ride inspector's slot and rules: beside Park Pulse, exclusive with the paint panel, Escape and the close button
 * close it, a session swap or the guest leaving closes it (GameApp drops the id). It shows what the guest is doing,
 * their thought with a "→ building" link when it is a complaint about one, the needs and comfort grid, the likes band,
 * the keepsakes held and the comfort flags. Read-only: nothing here changes the simulation.
 */
export const GuestInspector = (): React.JSX.Element | null => {
  const guest = useUiStore((state) => state.selectedGuest);
  const besidePulse = useUiStore((state) => inspectorBesidePulse(state.onboarding, state.mapOfferPending));
  useFocusReturn(guest !== null);
  if (!guest) return null;
  const flags = GUEST_FLAGS.filter((flag) => guest[flag.key]);
  const percent = (value: number): string => `${Math.round(value)}%`;
  return (
    <aside className={`ride-inspector guest-inspector${besidePulse ? ' beside-pulse' : ''}`} aria-label={`Guest inspector: Guest #${guest.id}`}>
      <header>
        <span className="inspector-icon" aria-hidden="true" style={{ '--ride-color': '#5b8def' } as React.CSSProperties}>☺︎</span>
        <span><small>GUEST</small><strong role="heading" aria-level={2}>Guest #{guest.id}</strong></span>
        <button onClick={() => gameBridge.closeInspector()} title="Close inspector (Esc)" aria-label="Close inspector"><span aria-hidden="true">×</span></button>
      </header>
      <p className="guest-doing"><span aria-hidden="true">⌖</span>{guest.doing}</p>
      <p className="guest-thought">
        <q>{guest.thought}</q>
        {guest.thoughtObjectId != null && guest.thoughtObjectName != null && (
          <ComplaintLink objectId={guest.thoughtObjectId} objectName={guest.thoughtObjectName} className="inspector-link" />
        )}
      </p>
      <div className="ride-metrics guest-needs">
        <span><small>HAPPINESS</small><strong>{percent(guest.happiness)}</strong></span>
        <span><small>MONEY</small><strong>${guest.money.toFixed(2)}</strong></span>
        <span><small>HUNGER</small><strong>{percent(guest.hunger)}</strong></span>
        <span><small>THIRST</small><strong>{percent(guest.thirst)}</strong></span>
        <span><small>TOILET</small><strong>{percent(guest.toiletNeed)}</strong></span>
        <span><small>ENERGY</small><strong>{percent(guest.energy)}</strong></span>
        <span><small>NAUSEA</small><strong>{percent(guest.nausea)}</strong></span>
        <span><small>WARMTH</small><strong>{Math.round(guest.warmth)}<em> {warmthLabel(guest)}</em></strong></span>
      </div>
      {flags.length > 0 && (
        <ul className="guest-flags" aria-label="Comfort">
          {flags.map((flag) => <li key={flag.key} className={flag.key}>{flag.label}</li>)}
        </ul>
      )}
      <dl className="ride-details">
        <div><dt>Likes</dt><dd><em className={`build-intensity-tag ${guest.likes}`}>{RIDE_BAND_TAGS[guest.likes].label}</em><span className="sr-only"> {LIKES_LABEL[guest.likes]}</span></dd></div>
        <div><dt>Souvenirs</dt><dd>{guest.souvenirs.length === 0 ? 'None' : guest.souvenirs.join(', ')}</dd></div>
        <div><dt>Heading for</dt><dd>{guest.destinationName ?? '—'}</dd></div>
        <div><dt>In the park</dt><dd>{ageText(guest.ageSeconds)}</dd></div>
      </dl>
    </aside>
  );
};

/**
 * The designer's special-piece buttons, in order (Phase 46 adds the elements). Each one lays its own track from the
 * last piece (the straight or the U-turn it needs, and a plain piece after); Undo takes it back.
 */
const COASTER_SPECIAL_BUTTONS: ReadonlyArray<{ kind: CoasterSpecial; icon: string; label: string; title: string }> = [
  { kind: 'loop', icon: '◎', label: 'Loop', title: 'Add a vertical loop: lays a straight piece with the loop and a plain piece after it' },
  { kind: 'boost', icon: '»', label: 'Boost', title: 'Add a boost: lays a straight piece with the boost and a plain piece after it' },
  { kind: 'launch', icon: '⚡', label: 'Launch', title: 'Add a launch: lays a straight piece that fires the train out at full speed, and a plain piece after it' },
  { kind: 'airtime-hill', icon: '◠', label: 'Airtime hill', title: 'Add an airtime hill: lays a straight piece with a hump that floats the riders, and a plain piece after it' },
  { kind: 'corkscrew', icon: '⥁', label: 'Corkscrew', title: 'Add a corkscrew: lays two straight pieces rolling a full turn, and a plain piece after them' },
  { kind: 'zero-g-roll', icon: '∞', label: 'Zero-g roll', title: 'Add a zero-g roll: lays two straight pieces with a weightless roll over a hump, and a plain piece after them' },
  { kind: 'cobra-roll', icon: '⤾', label: 'Cobra roll', title: 'Add a cobra roll: lays a U-turn that inverts twice (toward the free side) and a plain piece leading back' },
];

/** Above this, discarding a whole layout asks first — it is too much work to lose to one click. */
const CLEAR_CONFIRM_PIECES = 4;

export const CoasterPanel = (): React.JSX.Element | null => {
  const keys = useKeybindings();
  const draft = useUiStore((state) => state.coasterDraft);
  const selected = useUiStore((state) => state.selectedDefinitionId);
  const tool = useUiStore((state) => state.tool);
  const [confirmClear, setConfirmClear] = useState(false);
  const pieces = draft?.pieces ?? 0;
  useEffect(() => { setConfirmClear(false); }, [pieces]);
  const selectedDefinition = selected ? BUILD_BY_ID.get(selected) : undefined;
  if (!draft || selectedDefinition?.custom !== 'coaster' || tool !== 'build') return null;
  return (
    <aside className="coaster-panel" aria-label="Coaster designer">
      <header>
        <span><small>COASTER DESIGNER</small><strong>{draft.typeName}</strong></span>
        <b>{draft.pieces} pcs</b>
      </header>
      <div className="coaster-height-row">
        <small>TRACK HEIGHT (MAX {draft.maximumHeight})</small>
        <div className="coaster-height-controls">
          <button
            onClick={() => gameBridge.coasterAdjustHeight(-1)}
            aria-label="Lower track height"
            aria-keyshortcuts={ariaKeyShortcuts('coasterLower', keys)}
            title={withKeyHint('Lower track height', 'coasterLower', keys)}
          ><span aria-hidden="true">−</span></button>
          <strong role="status"><span className="sr-only">Track height </span>{draft.height}</strong>
          <button
            onClick={() => gameBridge.coasterAdjustHeight(1)}
            aria-label="Raise track height"
            aria-keyshortcuts={ariaKeyShortcuts('coasterRaise', keys)}
            title={withKeyHint('Raise track height', 'coasterRaise', keys)}
          ><span aria-hidden="true">+</span></button>
        </div>
        <em>New pieces climb toward this level</em>
      </div>
      {draft.launchSpeed !== null && (
        <div className="coaster-height-row">
          <small>LAUNCH SPEED (STATION)</small>
          <div className="coaster-height-controls">
            <button
              onClick={() => gameBridge.coasterAdjustLaunch(-1)}
              aria-label="Lower launch speed"
              title="Lower launch speed"
            ><span aria-hidden="true">−</span></button>
            <strong role="status"><span className="sr-only">Launch speed </span>{draft.launchSpeed.toFixed(1)}</strong>
            <button
              onClick={() => gameBridge.coasterAdjustLaunch(1)}
              aria-label="Raise launch speed"
              title="Raise launch speed"
            ><span aria-hidden="true">+</span></button>
          </div>
          <em>The train climbs until it runs out of speed, then rolls back</em>
        </div>
      )}
      {draft.allowedSpecials.length > 0 && (
        <div className="coaster-specials-row">
          <small>SPECIAL PIECES · ADDED AT THE END</small>
          <div className="coaster-special-buttons">
            {COASTER_SPECIAL_BUTTONS.filter((button) => draft.allowedSpecials.includes(button.kind)).map((button) => (
              <button
                key={button.kind}
                onClick={() => gameBridge.coasterToggleSpecial(button.kind)}
                disabled={draft.pieces < 3}
                title={button.title}
              ><span aria-hidden="true">{button.icon}</span> {button.label}</button>
            ))}
          </div>
        </div>
      )}
      {draft.helix && (
        <div className="coaster-specials-row">
          <small>HELIX · FROM THE LAST PIECE</small>
          <div className="coaster-special-buttons">
            <button onClick={() => gameBridge.coasterHelix(1)} disabled={draft.pieces < 3} title="Lay a helix turning left: four turns round a 2 × 2 block, climbing or falling a level a piece toward the track height">
              <span aria-hidden="true">↺</span> Helix left
            </button>
            <button onClick={() => gameBridge.coasterHelix(-1)} disabled={draft.pieces < 3} title="Lay a helix turning right: four turns round a 2 × 2 block, climbing or falling a level a piece toward the track height">
              <span aria-hidden="true">↻</span> Helix right
            </button>
          </div>
        </div>
      )}
      <CoasterLiftRows runs={draft.liftRuns} chainSavings={draft.chainSavings} keys={keys} />
      {draft.stats && draft.pieces > 0 && (
        <div className="coaster-stats">
          <span><small>EXCITEMENT</small><strong>{Math.round(draft.stats.excitement)}</strong></span>
          <span><small>INTENSITY</small><strong>{Math.round(draft.stats.intensity)}</strong></span>
          <span><small>RIDE TIME</small><strong>{Math.round(draft.stats.durationSeconds)}s</strong></span>
          <span><small>COST</small><strong>${draft.effectiveCost.toLocaleString()}</strong></span>
        </div>
      )}
      {draft.stats && draft.pieces > 0 && (
        <p className="coaster-evidence-line">
          {draft.stats.turns} turns · {draft.stats.drops} drop{draft.stats.drops === 1 ? '' : 's'} · highest point {draft.stats.highestHeight}
          {' '}· top speed {draft.stats.topSpeed}
          {draft.stats.loops > 0 ? ` · ${draft.stats.loops} loop${draft.stats.loops === 1 ? '' : 's'}` : ''}
          {draft.stats.boosts > 0 ? ` · ${draft.stats.boosts} boost${draft.stats.boosts === 1 ? '' : 's'}` : ''}
          {liftSummary(draft.liftRuns) ? ` · ${liftSummary(draft.liftRuns)}` : ''}
        </p>
      )}
      <p className={`coaster-validation ${draft.buildable && !draft.warning ? 'ready' : ''}`}>{draft.validationMessage}</p>
      <div className="coaster-actions">
        <button onClick={() => gameBridge.coasterUndo()} disabled={draft.pieces === 0} title="Step back one piece (Esc or right-click)">Undo</button>
        <button
          className={confirmClear ? 'confirm-clear' : ''}
          onClick={() => {
            if (draft.pieces > CLEAR_CONFIRM_PIECES && !confirmClear) {
              setConfirmClear(true);
              return;
            }
            gameBridge.coasterClear();
            setConfirmClear(false);
          }}
          disabled={draft.pieces === 0}
          title="Discard the whole layout. Esc and right-click only step back one piece."
        >{confirmClear ? `Discard ${draft.pieces}?` : 'Clear'}</button>
        <button className="primary" onClick={() => gameBridge.coasterBuild()} disabled={!draft.buildable}>
          Build coaster
        </button>
      </div>
      {draft.pieces > 0 && <em className="coaster-persist-hint">This layout is kept if you switch tools.</em>}
    </aside>
  );
};

export const HelpHint = (): React.JSX.Element => {
  const items = helpHintItems(useKeybindings());
  return (
    <div className="help-hint">
      {items.map((item, index) => (
        <Fragment key={item}>
          {index > 0 && <><i /> </>}
          <span>{item}</span>
        </Fragment>
      ))}
    </div>
  );
};

/** Phase 41 step 4: the one control left while riding along: the ride's name, the field of view, and the way out. */
export const RideAlongBar = (): React.JSX.Element | null => {
  const ride = useUiStore((state) => state.rideAlong);
  if (ride === null) return null;
  return (
    <div className="ride-along-bar" role="group" aria-label={`Riding along: ${ride.name}`}>
      <strong>Riding {ride.name}</strong>
      <button onClick={() => gameBridge.setRideAlongWide(!ride.wide)} aria-pressed={ride.wide} title="A wider view feels faster; a narrower one is calmer">
        {ride.wide ? 'Wide view' : 'Calm view'}
      </button>
      <button className="ride-along-exit" onClick={() => gameBridge.stopRideAlong()} title="Back to the park (Esc)">Exit ride</button>
    </div>
  );
};
