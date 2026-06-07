import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import {
  invalidateReachableEndpointCache,
  type PickReachableResult,
} from '@/utils/server/serverEndpoint';

vi.mock('@/api/subsonic', () => ({
  pingWithCredentials: vi.fn(),
  scheduleInstantMixProbeForServer: vi.fn(),
}));

vi.mock('@/utils/perf/perfFlags', () => ({
  usePerfProbeFlags: () => ({ disableBackgroundPolling: false }),
}));

import { pingWithCredentials } from '@/api/subsonic';
import { useDevOfflineBrowseStore } from '@/store/devOfflineBrowseStore';
import { useConnectionStatus } from './useConnectionStatus';

beforeEach(() => {
  resetAuthStore();
  invalidateReachableEndpointCache();
  useDevOfflineBrowseStore.getState().setForceOffline(false);
  vi.mocked(pingWithCredentials).mockReset();
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
    vi.mocked(pingWithCredentials).mockImplementation(async url =>
      url === 'http://192.168.0.10'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );

    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(result.current.isLan).toBe(true);
  });

  it('falls back to public when only the public address answers', async () => {
    seedDualAddressServer();
    vi.mocked(pingWithCredentials).mockImplementation(async url =>
      url === 'https://music.example.com'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );

    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.status).toBe('connected'));
    // primary url is `https://music.example.com` — public. isLanUrl alone
    // would have said `false` for the wrong reason (because the primary
    // happens to be public); the test is meaningful because the LAN side
    // was probed first and refused, so `activeEndpointKind` actively
    // reflects "public".
    expect(result.current.isLan).toBe(false);
  });

  it('falls back to primary URL classification before the first probe completes', () => {
    seedDualAddressServer();
    // Don't resolve the ping — the hook is still in the `checking` state.
    let _resolve: ((v: PickReachableResult) => void) | null = null;
    vi.mocked(pingWithCredentials).mockReturnValue(
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
    vi.mocked(pingWithCredentials).mockImplementation(async url =>
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
    vi.mocked(pingWithCredentials).mockClear();
    vi.mocked(pingWithCredentials).mockImplementation(async url =>
      url === 'https://music.example.com'
        ? { ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true }
        : { ok: false },
    );

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(result.current.isLan).toBe(false));
    // Both endpoints were probed (LAN refused, public answered).
    expect(vi.mocked(pingWithCredentials).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('useConnectionStatus DEV offline toggle', () => {
  it('does not probe again on mount beyond the polling effect', async () => {
    seedDualAddressServer();
    vi.mocked(pingWithCredentials).mockResolvedValue({
      ok: true,
      type: 'navidrome',
      serverVersion: '0.55.0',
      openSubsonic: true,
    });

    renderHook(() => useConnectionStatus());
    await waitFor(() => expect(vi.mocked(pingWithCredentials).mock.calls.length).toBeGreaterThanOrEqual(1));
    const callsAfterMount = vi.mocked(pingWithCredentials).mock.calls.length;
    await new Promise(r => setTimeout(r, 20));
    expect(vi.mocked(pingWithCredentials).mock.calls.length).toBe(callsAfterMount);
  });

  it('disconnects on force-offline toggle without an extra probe', async () => {
    seedDualAddressServer();
    vi.mocked(pingWithCredentials).mockResolvedValue({
      ok: true,
      type: 'navidrome',
      serverVersion: '0.55.0',
      openSubsonic: true,
    });

    const { result } = renderHook(() => useConnectionStatus());
    await waitFor(() => expect(result.current.status).toBe('connected'));
    const callsBeforeToggle = vi.mocked(pingWithCredentials).mock.calls.length;

    act(() => useDevOfflineBrowseStore.getState().setForceOffline(true));
    await waitFor(() => expect(result.current.status).toBe('disconnected'));
    expect(vi.mocked(pingWithCredentials).mock.calls.length).toBe(callsBeforeToggle);
  });
});
