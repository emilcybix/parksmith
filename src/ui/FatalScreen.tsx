import { buildFeedbackReport } from '../app/alpha/feedbackReport';
import { requestRecoverOnBoot } from '../app/alpha/bootFlags';
import { gameBridge } from '../app/gameBridge';
import { getSettings } from '../settings';
import { GAME_VERSION } from './aboutModel';
import { downloadReport } from './feedbackActions';

/**
 * Phase 19 (PA-026): the error screen. It replaces the game when no renderer could start or when the frame loop threw.
 * The park was stopped and, when possible, autosaved; "Reload and recover" reloads the tab and continues the newest
 * save as soon as the start screen has read it. The report button downloads a feedback report with the error in it
 * (with the park attached when the game is still able to save it).
 */
export const FatalScreen = ({ message }: { message: string }): React.JSX.Element => {
  const report = () => gameBridge.buildFeedbackReport('', true) ?? buildFeedbackReport('', {
    gameVersion: GAME_VERSION,
    renderer: null,
    userAgent: navigator.userAgent,
    screen: { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio },
    createdAt: new Date().toISOString(),
    fatalError: message,
  }, getSettings(), null);
  return (
    <div className="fatal-error" role="alertdialog" aria-labelledby="fatal-title" aria-describedby="fatal-detail">
      <span className="brand-mark" aria-hidden="true">P</span>
      <strong id="fatal-title">Park closed unexpectedly</strong>
      <span id="fatal-detail">{message}</span>
      <p>Your park was stopped and saved if it could be. Reloading usually helps; recovering continues your newest save.</p>
      <div className="fatal-actions">
        <button type="button" className="menu-back primary" onClick={() => { requestRecoverOnBoot(); window.location.reload(); }}>Reload and recover last save</button>
        <button type="button" className="menu-back" onClick={() => window.location.reload()}>Reload</button>
        <button type="button" className="menu-back" onClick={() => downloadReport({ ...report(), fatalError: message })}>Download an error report</button>
      </div>
      <small>Parksmith v{GAME_VERSION}</small>
    </div>
  );
};
