/**
 * Small player preferences that must survive even when the main
 * `psysonic-player` Zustand blob exceeds the localStorage quota (full
 * queueItems persist since thin-state #872). Same pattern as
 * `queueVisibilityStorage.ts`.
 */
export type PlayerRepeatMode = 'off' | 'all' | 'one';

export type PlayerPrefs = {
  volume: number;
  repeatMode: PlayerRepeatMode;
};

const PREFS_STORAGE_KEY = 'psysonic_player_prefs';
const LEGACY_PLAYER_STORAGE_KEY = 'psysonic-player';

const DEFAULT_VOLUME = 0.8;
const DEFAULT_REPEAT_MODE: PlayerRepeatMode = 'off';

const REPEAT_MODES: readonly PlayerRepeatMode[] = ['off', 'all', 'one'];

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, value));
}

function parseRepeatMode(value: unknown): PlayerRepeatMode {
  if (typeof value === 'string' && (REPEAT_MODES as readonly string[]).includes(value)) {
    return value as PlayerRepeatMode;
  }
  return DEFAULT_REPEAT_MODE;
}

function readLegacyPrefsFromPlayerBlob(): Partial<PlayerPrefs> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LEGACY_PLAYER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Partial<PlayerPrefs> };
    return parsed.state ?? null;
  } catch {
    return null;
  }
}

export function readInitialPlayerPrefs(): PlayerPrefs {
  if (typeof window === 'undefined') {
    return { volume: DEFAULT_VOLUME, repeatMode: DEFAULT_REPEAT_MODE };
  }

  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PlayerPrefs>;
      return {
        volume: clampVolume(typeof parsed.volume === 'number' ? parsed.volume : DEFAULT_VOLUME),
        repeatMode: parseRepeatMode(parsed.repeatMode),
      };
    }
  } catch {
    // fall through to legacy blob / defaults
  }

  const legacy = readLegacyPrefsFromPlayerBlob();
  if (legacy) {
    return {
      volume: clampVolume(typeof legacy.volume === 'number' ? legacy.volume : DEFAULT_VOLUME),
      repeatMode: parseRepeatMode(legacy.repeatMode),
    };
  }

  return { volume: DEFAULT_VOLUME, repeatMode: DEFAULT_REPEAT_MODE };
}

export function persistPlayerPrefs(prefs: PlayerPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        volume: clampVolume(prefs.volume),
        repeatMode: parseRepeatMode(prefs.repeatMode),
      }),
    );
  } catch {
    // best-effort — in-memory state still works this session
  }
}
