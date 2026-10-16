import { useId, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import { FEEDBACK_MESSAGE_LIMIT } from '../app/alpha/feedbackReport';
import { FEEDBACK_URL, copyReport, downloadReport } from './feedbackActions';

/**
 * Phase 19: the feedback entry point (About and changelog, start screen and pause menu). The report always carries the
 * version, save format, renderer and browser; the current park is attached only when the box is ticked. Copy or
 * download it, then send it where the alpha asks (the feedback page when one is configured).
 */
export const FeedbackForm = (): React.JSX.Element => {
  const id = useId();
  const [message, setMessage] = useState('');
  const [includePark, setIncludePark] = useState(false);
  const [status, setStatus] = useState('');
  const canAttach = gameBridge.canAttachPark();
  const report = () => gameBridge.buildFeedbackReport(message, includePark && canAttach);
  return (
    <section className="feedback-form" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Send feedback</h3>
      <label htmlFor={`${id}-message`}>What happened, or what would you change?</label>
      <textarea
        id={`${id}-message`}
        value={message}
        maxLength={FEEDBACK_MESSAGE_LIMIT}
        rows={4}
        onChange={(event) => setMessage(event.target.value)}
      />
      <label className="settings-switch">
        <input type="checkbox" checked={includePark && canAttach} disabled={!canAttach} onChange={(event) => setIncludePark(event.target.checked)} />
        <span>{canAttach ? 'Attach my current park (a save file)' : 'No park to attach right now'}</span>
      </label>
      <p className="feedback-note">The report holds the game version, your browser and screen size, and a few settings. Nothing is sent until you send it.</p>
      <div className="feedback-actions">
        <button
          type="button"
          className="menu-back"
          onClick={() => {
            const built = report();
            if (built === null) return;
            void copyReport(built).then((ok) => setStatus(ok ? 'Copied: paste it into your message.' : 'Copying was refused: download the file instead.'));
          }}
        >Copy report</button>
        <button
          type="button"
          className="menu-back"
          onClick={() => {
            const built = report();
            if (built === null) return;
            downloadReport(built);
            setStatus('Downloaded the report file.');
          }}
        >Download report</button>
        {FEEDBACK_URL !== null && (
          <a className="menu-back" href={FEEDBACK_URL} target="_blank" rel="noreferrer">Open the feedback page</a>
        )}
      </div>
      <p className="feedback-status" role="status">{status}</p>
    </section>
  );
};
