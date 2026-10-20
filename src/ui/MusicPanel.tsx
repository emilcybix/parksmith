import { gameBridge } from '../app/gameBridge';
import { useUiStore } from './store';

/**
 * The music player: what plays, the previous and next track of the park's playlist, and the whole list to pick from.
 * Opened from the menu bar's Music button. The titles come from the file names (`titleFromFile`: "Rush_Hour.ogg" reads
 * "Rush Hour"). The start screen has one theme, so the button only does something in a park; volume stays in Settings.
 */
export const MusicPanel = (): React.JSX.Element | null => {
  const music = useUiStore((state) => state.music);
  const open = useUiStore((state) => state.musicPlayerOpen);
  const setOpen = useUiStore((state) => state.setMusicPlayerOpen);
  if (!open || music === null) return null;
  const current = music.tracks.find((track) => track.id === music.currentId) ?? null;
  return (
    <section className="music-panel" aria-label="Music player">
      <header>
        <span><small>MUSIC</small><strong aria-live="polite">{current?.title ?? 'Loading…'}</strong></span>
        <button className="music-close" onClick={() => setOpen(false)} aria-label="Close the music player" title="Close">×</button>
      </header>
      <div className="music-controls" role="group" aria-label="Track">
        <button onClick={() => gameBridge.musicPrevious()} disabled={!music.playlist} aria-label="Previous track" title="Previous track">⏮</button>
        <button onClick={() => gameBridge.musicNext()} disabled={!music.playlist} aria-label="Next track" title="Next track">⏭</button>
      </div>
      <ol className="music-tracks" aria-label="Tracks">
        {music.tracks.map((track) => (
          <li key={track.id}>
            <button
              className={track.id === music.currentId ? 'playing' : ''}
              aria-current={track.id === music.currentId ? 'true' : undefined}
              onClick={() => gameBridge.musicSelect(track.id)}
            >
              <span aria-hidden="true">{track.id === music.currentId ? '♪' : ''}</span>{track.title}
            </button>
          </li>
        ))}
      </ol>
      <p className="music-note">Volume is in Settings.</p>
    </section>
  );
};
