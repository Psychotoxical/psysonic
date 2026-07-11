import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import {
  invalidateReachableEndpointCache,
  type PickReachableResult,
} from '@/lib/server/serverEndpoint';

vi.mock('@/lib/api/subsonic', () => ({
  pingWithCredentials: vi.fn(),
  pingWithCredentialsForProfile: vi.fn(),
  scheduleInstantMixProbeForServer: vi.fn(),
}));

vi.mock('@/lib/perf/perfFlags', () => ({
  usePerfProbeFlags: () => ({ disableBackgroundPolling: false }),
}));

const isTauri = vi.fn(() => false);
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => isTauri(),
}));

import { pingWithCredentialsForProfile } from '@/lib/api/subsonic';
import { useDevOfflineBrowseStore } from '@/features/offline';
import { resetActiveServerConnectionSnapshot, setConnectionStatus } from '@/lib/network/activeServerReachability';
import { useConnectionStatus } from './useConnectionStatus';

beforeEach(() => {
  resetAuthStore();
  resetActiveServerConnectionSnapshot();
  invalidateReachableEndpointCache();
  useDevOfflineBrowseStore.getState().setForceOffline(false);
  isTauri.mockReturnValue(false);
  vi.mocked(pingWithCredentialsForProfile).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function seedDualAddressServer(): string {
  const id = useAuthStore.getState().addServer({
    name: 'Home',
    url: 'https://music.example.com',
    alternateUrl: 'http://192.168.0.10',
    username: 'tester',
    password: 'pw',
  });
  useAuthStore.getState().setActiveServer(id);
  return id;
}

describe('useConnectionStatus.isLan', () => {
  it('reports the active endpoint kind after a probe, not the primary URL kind', async () => {
    seedDualAddressServer();
    // LAN endpoint answers — alternateUrl is the LAN side here, so a
    // primary-url-only check would say "public". We assert it says "local"
    // (active endpoint kind).
    vi.mocked(pingWithCredentialsForProfile).mockImplementation(async (_profile, url) =>
      url === 'http://192.168.0.10'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );

    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(result.current.isLan).toBe(true);
  });

  it('falls back to public when only the public address answers', async () => {
    vi.useFakeTimers();
    seedDualAddressServer();
    vi.mocked(pingWithCredentialsForProfile).mockImplementation(async (_profile, url) =>
      url === 'https://music.example.com'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );

    const { result } = renderHook(() => useConnectionStatus());
    await act(async () => {
      for (let i = 0; i < 2; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }
    });
    expect(result.current.status).toBe('connected');
    // primary url is `https://music.example.com` — public. isLanUrl alone
    // would have said `false` for the wrong reason (because the primary
    // happens to be public); the test is meaningful because the LAN side
    // was probed first and refused, so `activeEndpointKind` actively
    // reflects "public".
    expect(result.current.isLan).toBe(false);
  });

  it('updates the badge when the active server switches (LAN → public)', async () => {
    seedDualAddressServer();
    vi.mocked(pingWithCredentialsForProfile).mockImplementation(async (_profile, url) =>
      url === 'http://192.168.0.10'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );
    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.isLan).toBe(true));

    // Switch to a public-only server: the badge must follow, not stay 'local'.
    const remoteId = useAuthStore.getState().addServer({
      name: 'Remote',
      url: 'https://remote.example.com',
      username: 'tester',
      password: 'pw',
    });
    vi.mocked(pingWithCredentialsForProfile).mockImplementation(async (_profile, url) =>
      url === 'https://remote.example.com'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );
    act(() => {
      useAuthStore.getState().setActiveServer(remoteId);
    });
    await waitFor(() => expect(result.current.isLan).toBe(false));
  });

  it('falls back to primary URL classification before the first probe completes', () => {
    seedDualAddressServer();
    // Don't resolve the ping — the hook is still in the `checking` state.
    let _resolve: ((v: PickReachableResult) => void) | null = null;
    vi.mocked(pingWithCredentialsForProfile).mockReturnValue(
      new Promise(r => {
        _resolve = ((res: PickReachableResult) => {
          if (res.ok) {
            r({
              ok: true,
              type: res.ping.type,
              serverVersion: res.ping.serverVersion,
              openSubsonic: res.ping.openSubsonic,
            });
          } else {
            r({ ok: false });
          }
        }) as never;
      }),
    );

    const { result } = renderHook(() => useConnectionStatus());
    // Before the probe completes, isLan reflects the primary URL — public
    // here, so false.
    expect(result.current.isLan).toBe(false);
  });
});

describe('useConnectionStatus online event', () => {
  it('flushes the reachable-endpoint cache when the browser fires online', async () => {
    seedDualAddressServer();
    // Initial probe: LAN answers.
    vi.mocked(pingWithCredentialsForProfile).mockImplementation(async (_profile, url) =>
      url === 'http://192.168.0.10'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );

    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.status).toBe('connected'));

    // Now flip: LAN goes dark, only public answers. The 120 s tick won't
    // fire in this test; we trigger the online event instead. The handler
    // invalidates the sticky cache so the next probe goes LAN-first and
    // flips over to public when LAN refuses.
    vi.mocked(pingWithCredentialsForProfile).mockClear();
    vi.mocked(pingWithCredentialsForProfile).mockImplementation(async (_profile, url) =>
      url === 'https://music.example.com'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );

    vi.useFakeTimers();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      for (let i = 0; i < 2; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }
    });
    vi.useRealTimers();

    await waitFor(() => expect(result.current.isLan).toBe(false));
    // Both endpoints were probed (LAN refused, public answered).
    expect(vi.mocked(pingWithCredentialsForProfile).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('useConnectionStatus DEV offline toggle', () => {
  it('does not probe again on mount beyond the polling effect', async () => {
    seedDualAddressServer();
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValue({
      ok: true,
      type: 'navidrome',
      serverVersion: '0.55.0',
      openSubsonic: true,
    });

    renderHook(() => useConnectionStatus());
    await waitFor(() => expect(vi.mocked(pingWithCredentialsForProfile).mock.calls.length).toBeGreaterThanOrEqual(1));
    const callsAfterMount = vi.mocked(pingWithCredentialsForProfile).mock.calls.length;
    await new Promise(r => setTimeout(r, 20));
    expect(vi.mocked(pingWithCredentialsForProfile).mock.calls.length).toBe(callsAfterMount);
  });

  it('disconnects on force-offline toggle without an extra probe', async () => {
    seedDualAddressServer();
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValue({
      ok: true,
      type: 'navidrome',
      serverVersion: '0.55.0',
      openSubsonic: true,
    });

    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.status).toBe('connected'));
    const callsBeforeToggle = vi.mocked(pingWithCredentialsForProfile).mock.calls.length;

    act(() => useDevOfflineBrowseStore.getState().setForceOffline(true));
    await waitFor(() => expect(result.current.status).toBe('disconnected'));
    expect(vi.mocked(pingWithCredentialsForProfile).mock.calls.length).toBe(callsBeforeToggle);
  });
});

describe('useConnectionStatus navigator.onLine (Tauri)', () => {
  it('probes the server when navigator.onLine is false inside Tauri', async () => {
    isTauri.mockReturnValue(true);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });

    seedDualAddressServer();
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValue({
      ok: true,
      type: 'navidrome',
      serverVersion: '0.62.0',
      openSubsonic: true,
    });

    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(vi.mocked(pingWithCredentialsForProfile).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('re-probes on offline event in Tauri instead of disconnecting', async () => {
    isTauri.mockReturnValue(true);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });

    seedDualAddressServer();
    vi.mocked(pingWithCredentialsForProfile).mockResolvedValue({
      ok: true,
      type: 'navidrome',
      serverVersion: '0.62.0',
      openSubsonic: true,
    });

    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.status).toBe('connected'));
    const callsAfterMount = vi.mocked(pingWithCredentialsForProfile).mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });

    await waitFor(() =>
      expect(vi.mocked(pingWithCredentialsForProfile).mock.calls.length).toBeGreaterThan(callsAfterMount),
    );
    expect(result.current.status).toBe('connected');
  });
});

describe('useConnectionStatus shared status', () => {
  it('keeps all hook instances in sync when connection status changes', () => {
    const shell = renderHook(() => useConnectionStatus());
    const sidebar = renderHook(() => useConnectionStatus());

    act(() => {
      setConnectionStatus('disconnected');
    });
    expect(shell.result.current.status).toBe('disconnected');
    expect(sidebar.result.current.status).toBe('disconnected');

    act(() => {
      setConnectionStatus('connected');
    });
    expect(shell.result.current.status).toBe('connected');
    expect(sidebar.result.current.status).toBe('connected');
  });
});
