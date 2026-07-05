import { beforeEach, describe, expect, it, vi } from 'vitest';

// Scenario: server switch × active orbit + playing queue (closes the switchActiveServer
// QA). Switching servers must tear down a live orbit session (its playlists live on the
// old backend), flush the old server's play queue, rebind the active server, and mark a
// queue handoff. Deep modules are mocked (not the @/features/orbit barrel) to avoid
// partial-barrel collapse; the real orbit + auth stores drive the observable assertions.

const ensureConnectUrlResolved = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/serverEndpoint', async (io) => ({
  ...(await io<typeof import('@/lib/server/serverEndpoint')>()),
  ensureConnectUrlResolved,
}));

const flushPlayQueueForServer = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/features/playback/store/queueSync', async (io) => ({
  ...(await io<typeof import('@/features/playback/store/queueSync')>()),
  flushPlayQueueForServer,
}));

const markQueueHandoffPending = vi.hoisted(() => vi.fn());
vi.mock('@/features/playback/store/queueSyncUiState', async (io) => ({
  ...(await io<typeof import('@/features/playback/store/queueSyncUiState')>()),
  markQueueHandoffPending,
}));

// Fire-and-forget from switchActiveServer (`void`); stub so its real IPC/header
// wiring doesn't surface as an unhandled rejection after the assertion.
vi.mock('@/lib/server/syncServerHttpContext', async (io) => ({
  ...(await io<typeof import('@/lib/server/syncServerHttpContext')>()),
  syncServerHttpContextForProfile: vi.fn(),
}));

const endOrbitSession = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/features/orbit/utils/host', async (io) => ({
  ...(await io<typeof import('@/features/orbit/utils/host')>()),
  endOrbitSession,
}));

const leaveOrbitSession = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/features/orbit/utils/guest', async (io) => ({
  ...(await io<typeof import('@/features/orbit/utils/guest')>()),
  leaveOrbitSession,
}));

import { switchActiveServer } from '@/utils/server/switchActiveServer';
import { useAuthStore } from '@/store/authStore';
import { useOrbitStore } from '@/features/orbit';
import { makeServer } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';

const oldServer = makeServer({ id: 'old', url: 'https://old.example' });
const newServer = makeServer({ id: 'new', url: 'https://new.example' });

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  useAuthStore.setState({ servers: [oldServer, newServer], activeServerId: oldServer.id });
  ensureConnectUrlResolved.mockResolvedValue({
    ok: true,
    baseUrl: 'https://new.example',
    ping: { type: 'navidrome', serverVersion: '1.0.0', openSubsonic: true },
  });
});

describe('server switch × active orbit + playing queue', () => {
  it('aborts when the new server is unreachable — no teardown, no rebind', async () => {
    ensureConnectUrlResolved.mockResolvedValue({ ok: false, reason: 'unreachable' });
    const ok = await switchActiveServer(newServer);
    expect(ok).toBe(false);
    expect(flushPlayQueueForServer).not.toHaveBeenCalled();
    expect(useAuthStore.getState().activeServerId).toBe(oldServer.id);
  });

  it('as host: tears down orbit, flushes the old queue, rebinds, marks handoff', async () => {
    useOrbitStore.setState({ role: 'host', phase: 'active' });
    const ok = await switchActiveServer(newServer);
    expect(ok).toBe(true);
    expect(endOrbitSession).toHaveBeenCalledTimes(1);
    expect(leaveOrbitSession).not.toHaveBeenCalled();
    expect(useOrbitStore.getState().role).toBeNull();
    expect(flushPlayQueueForServer).toHaveBeenCalledWith(oldServer.id);
    expect(useAuthStore.getState().activeServerId).toBe(newServer.id);
    expect(markQueueHandoffPending).toHaveBeenCalledTimes(1);
  });

  it('as guest: leaves the session instead of ending it', async () => {
    useOrbitStore.setState({ role: 'guest', phase: 'active' });
    const ok = await switchActiveServer(newServer);
    expect(ok).toBe(true);
    expect(leaveOrbitSession).toHaveBeenCalledTimes(1);
    expect(endOrbitSession).not.toHaveBeenCalled();
    expect(useOrbitStore.getState().role).toBeNull();
  });

  it('with no orbit session: still rebinds + flushes, no teardown call', async () => {
    const ok = await switchActiveServer(newServer);
    expect(ok).toBe(true);
    expect(endOrbitSession).not.toHaveBeenCalled();
    expect(leaveOrbitSession).not.toHaveBeenCalled();
    expect(flushPlayQueueForServer).toHaveBeenCalledWith(oldServer.id);
    expect(useAuthStore.getState().activeServerId).toBe(newServer.id);
  });
});
