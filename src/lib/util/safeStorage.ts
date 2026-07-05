import { createJSONStorage, type PersistStorage, type StateStorage } from 'zustand/middleware';

/**
 * `localStorage` wrapped so a failed write never throws.
 *
 * zustand's persist middleware calls the storage from *inside* `set()`. When a
 * persisted slice grows past the origin quota (~5 MB) — e.g. a multi-thousand
 * track queue — `localStorage.setItem` throws `QuotaExceededError`, and because
 * that throw happens inside `set()` it aborts the calling action. That is how a
 * full quota previously killed `playTrack` before it ever reached `audio_play`
 * (no audio output at all on huge queues).
 *
 * Persistence is best-effort: a dropped write just means the in-memory store
 * keeps working and the slice isn't saved this time. This is the same try/catch
 * shape already used ad-hoc for direct `localStorage.setItem` calls elsewhere
 * (e.g. mini-player geometry); this is its shared home for persist stores.
 */
// Warn once per key per quota-exceeded streak — a 50k+ queue persists on every
// mutation, so an unthrottled warning floods the console. Re-armed when a write
// to that key next succeeds (queue shrank back under the quota).
const quotaWarned = new Set<string>();

const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
      quotaWarned.delete(name);
    } catch (e) {
      if (import.meta.env.DEV && !quotaWarned.has(name)) {
        quotaWarned.add(name);
        console.warn(
          `[psysonic] persist write skipped for "${name}" (storage quota?) — further skips silenced until it fits`,
          e,
        );
      }
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* best-effort */
    }
  },
};

/**
 * Drop-in replacement for `createJSONStorage(() => localStorage)` whose writes
 * never throw. Use for any persist store whose slice can grow unbounded.
 */
export const createSafeJSONStorage = <S>() => createJSONStorage<S>(() => safeLocalStorage);

/**
 * Wraps a persist storage so `setItem` is a no-op until the store finishes its
 * first hydration. Zustand v5 persists on every `setState`; without this gate,
 * startup side effects (e.g. `runInitialAudioSync`) can overwrite the saved
 * blob with in-memory defaults before async rehydration merges localStorage.
 */
export function createHydrationGatedStorage<S>(
  base: PersistStorage<S> | undefined,
  isWriteAllowed: () => boolean,
): PersistStorage<S> | undefined {
  if (!base) return undefined;
  return {
    getItem: base.getItem.bind(base),
    removeItem: base.removeItem.bind(base),
    setItem: (name, value) => {
      if (!isWriteAllowed()) return;
      return base.setItem(name, value);
    },
  };
}
