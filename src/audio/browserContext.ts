import type { AudioContextLike } from './AudioEngine';

/**
 * Phase 15: the real Web Audio context, or null where there is none (Node, an old browser): the engine then stays
 * silent. Only ever called from a user gesture (AudioEngine.unlock).
 */
export const createBrowserAudioContext = (): AudioContextLike | null => {
  const scope = globalThis as unknown as { AudioContext?: new (options?: { latencyHint?: string }) => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  return Context ? new Context({ latencyHint: 'interactive' }) : null;
};
