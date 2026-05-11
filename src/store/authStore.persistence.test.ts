/**
 * authStore persistence + sync-storage characterization.
 *
 * Covers Zustand persist's hydration path (via `useAuthStore.persist.rehydrate()`):
 * existing localStorage shapes load, missing fields default to the store's
 * initial values, corrupt JSON does not crash bootstrap, the
 * hotCacheEnabled / preloadMode≠'off' conflicting-legacy migration clears
 * both, and a few smaller field-level migrations.
 *
 * Also pins the **synchronous storage** invariant called out in `CLAUDE.md`
 * ("never switch to async storage") — regression §2 of the pre-refactor
 * testing plan v2.
 *
 * Phase F2 / PR 3.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from './authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

const PERSIST_KEY = 'psysonic-auth';

function writePersistedState(state: Record<string, unknown>): void {
  localStorage.setItem(PERSIST_KEY, JSON.stringify({ state, version: 0 }));
}

beforeEach(() => {
  resetAuthStore();
  localStorage.removeItem(PERSIST_KEY);
});

describe('hydration — loads existing localStorage shape', () => {
  it('restores servers + activeServerId from a fresh-shape payload', async () => {
    const server = { id: 's1', name: 'Home', url: 'https://x.test', username: 'u', password: 'p' };
    writePersistedState({ servers: [server], activeServerId: 's1' });

    await useAuthStore.persist.rehydrate();

    const s = useAuthStore.getState();
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]?.id).toBe('s1');
    expect(s.activeServerId).toBe('s1');
  });

  it('defaults missing fields to their initial values', async () => {
    // Minimal payload — no scrobblingEnabled, no replayGain settings, etc.
    writePersistedState({ servers: [], activeServerId: null });

    await useAuthStore.persist.rehydrate();

    const s = useAuthStore.getState();
    expect(s.scrobblingEnabled).toBe(true);
    expect(s.crossfadeEnabled).toBe(false);
    expect(s.gaplessEnabled).toBe(false);
    expect(s.replayGainEnabled).toBe(false);
    expect(s.normalizationEngine).toBe('off');
    expect(s.preloadMode).toBe('balanced');
  });

  it('preserves saved fields verbatim when present', async () => {
    writePersistedState({
      servers: [],
      activeServerId: null,
      scrobblingEnabled: false,
      crossfadeEnabled: true,
      gaplessEnabled: false,
      crossfadeSecs: 7,
    });

    await useAuthStore.persist.rehydrate();

    const s = useAuthStore.getState();
    expect(s.scrobblingEnabled).toBe(false);
    expect(s.crossfadeEnabled).toBe(true);
    expect(s.crossfadeSecs).toBe(7);
  });
});

describe('hydration — corrupt / unexpected input', () => {
  it('does not crash bootstrap when the persisted blob is not valid JSON', async () => {
    localStorage.setItem(PERSIST_KEY, '{not[json}');
    await expect(useAuthStore.persist.rehydrate()).resolves.not.toThrow();

    const s = useAuthStore.getState();
    // No servers loaded; defaults remain.
    expect(s.servers).toEqual([]);
    expect(s.scrobblingEnabled).toBe(true);
  });

  it('is robust to a missing top-level `state` field', async () => {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ version: 0 }));
    await expect(useAuthStore.persist.rehydrate()).resolves.not.toThrow();
    expect(useAuthStore.getState().servers).toEqual([]);
  });
});

describe('onRehydrate migrations', () => {
  it('clears the conflicting hotCacheEnabled + preloadMode≠"off" legacy combo', async () => {
    writePersistedState({
      servers: [],
      activeServerId: null,
      hotCacheEnabled: true,
      preloadMode: 'balanced',
    });

    await useAuthStore.persist.rehydrate();

    const s = useAuthStore.getState();
    expect(s.hotCacheEnabled).toBe(false);
    expect(s.preloadMode).toBe('off');
  });

  it('keeps hotCacheEnabled when preloadMode was already "off"', async () => {
    writePersistedState({
      servers: [],
      activeServerId: null,
      hotCacheEnabled: true,
      preloadMode: 'off',
    });

    await useAuthStore.persist.rehydrate();

    const s = useAuthStore.getState();
    expect(s.hotCacheEnabled).toBe(true);
    expect(s.preloadMode).toBe('off');
  });

  it('migrates a legacy `waveform` seekbarStyle to `truewave`', async () => {
    writePersistedState({
      servers: [],
      activeServerId: null,
      seekbarStyle: 'waveform', // legacy / no longer in VALID_SEEKBAR_STYLES
    });

    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().seekbarStyle).toBe('truewave');
  });

  it('keeps a valid seekbarStyle unchanged', async () => {
    writePersistedState({
      servers: [],
      activeServerId: null,
      seekbarStyle: 'neon',
    });

    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().seekbarStyle).toBe('neon');
  });

  it('strips the removed `animationMode` and `reducedAnimations` legacy fields', async () => {
    writePersistedState({
      servers: [],
      activeServerId: null,
      animationMode: 'reduced',
      reducedAnimations: true,
    });

    await useAuthStore.persist.rehydrate();
    const s = useAuthStore.getState() as unknown as Record<string, unknown>;
    expect(s.animationMode).toBeUndefined();
    expect(s.reducedAnimations).toBeUndefined();
  });
});

describe('partialize — what gets persisted', () => {
  it('strips `musicFolders` from the persisted payload', () => {
    useAuthStore.setState({ musicFolders: [{ id: 'mf-1', name: 'Music' }] });
    // Trigger persist (Zustand persist writes on every state change).
    useAuthStore.setState({ scrobblingEnabled: false });

    const raw = localStorage.getItem(PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(parsed.state.musicFolders).toBeUndefined();
  });
});

describe('synchronous storage invariant (CLAUDE.md gotcha)', () => {
  // Regression §2 of the v2 eval doc: a refactor that swaps localStorage
  // for an async store (e.g. @tauri-apps/plugin-store) would break the
  // bootstrap path — `getActiveServer()` would return undefined for one
  // event-loop tick after `addServer` + `setActiveServer`.
  it('addServer + setActiveServer → getActiveServer is visible in the same tick (no await)', () => {
    const id = useAuthStore.getState().addServer({
      name: 'Sync', url: 'https://sync.test', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(id);

    // No `await` between the writes and the read. If storage were async
    // the activeServerId would not yet be reflected by `getActiveServer`.
    expect(useAuthStore.getState().getActiveServer()?.id).toBe(id);
    expect(useAuthStore.getState().getActiveServer()?.name).toBe('Sync');
  });

  it('exposes a synchronous getter API — never returns a Promise', () => {
    // Type-level + runtime check that the selectors stay sync.
    const active = useAuthStore.getState().getActiveServer();
    const baseUrl = useAuthStore.getState().getBaseUrl();
    expect(active).not.toBeInstanceOf(Promise);
    expect(baseUrl).not.toBeInstanceOf(Promise);
    expect(typeof baseUrl).toBe('string');
  });
});
