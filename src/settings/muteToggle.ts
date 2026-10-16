import { DEFAULT_SETTINGS, type VolumeLevel } from './schema';

/**
 * Phase 35: the mute key. Muting is the Master volume at 0, so the Sound slider always shows the truth and a muted game
 * stays muted after a reload with no new settings field. Unmuting brings back the level the key muted from (kept by the
 * caller for this session); with none (muted from the slider, or before a reload) it brings back the default level.
 */
export interface MuteStep {
  /** The Master volume to store. */
  masterVolume: VolumeLevel;
  /** The level to bring back on the next unmute (null once unmuted). */
  remembered: VolumeLevel | null;
  muted: boolean;
}

export const nextMuteStep = (current: VolumeLevel, remembered: VolumeLevel | null): MuteStep => {
  if (current > 0) return { masterVolume: 0, remembered: current, muted: true };
  const back = remembered !== null && remembered > 0 ? remembered : DEFAULT_SETTINGS.masterVolume;
  return { masterVolume: back, remembered: null, muted: false };
};

/** The toast that names the new state: "Sound muted · M to unmute", "Sound on · Master 70 %". */
export const muteToastText = (step: Readonly<MuteStep>, keyLabel: string | null): string => (
  step.muted
    ? `Sound muted${keyLabel === null ? '' : ` · ${keyLabel} to unmute`}`
    : `Sound on · Master ${step.masterVolume} %`
);
