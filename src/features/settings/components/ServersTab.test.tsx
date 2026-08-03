import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';

const mocks = vi.hoisted(() => ({
  bootstrapIndexedServer: vi.fn(),
  ensureConnectUrlResolved: vi.fn(),
  pingWithCredentialsForProfile: vi.fn(),
  syncServerHttpContextForProfile: vi.fn(async () => undefined),
  invalidateReachableEndpointCache: vi.fn(),
  onPersisted: vi.fn(),
}));

vi.mock('@/lib/library/hooks/useLibraryIndexSync', () => ({
  useLibraryIndexSync: () => ({
    statusByServer: {}, connectionByServer: {}, progressByServer: {}, busyServerId: null,
    bootstrapping: false, globalBusy: false, runServerAction: vi.fn(), handleCancel: vi.fn(),
  }),
}));

vi.mock('@/lib/library/librarySession', () => ({
  bootstrapIndexedServer: mocks.bootstrapIndexedServer,
}));

vi.mock('@/lib/api/subsonic', () => ({
  pingWithCredentialsForProfile: mocks.pingWithCredentialsForProfile,
  scheduleInstantMixProbeForServer: vi.fn(),
}));

vi.mock('@/lib/server/syncServerHttpContext', () => ({
  clearServerHttpContext: vi.fn(),
  setServerHttpContextIdentitySource: vi.fn(),
  syncServerHttpContextForProfile: mocks.syncServerHttpContextForProfile,
}));

vi.mock('@/lib/server/serverEndpoint', () => ({
  ensureConnectUrlResolved: mocks.ensureConnectUrlResolved,
  invalidateReachableEndpointCache: mocks.invalidateReachableEndpointCache,
  allNormalizedAddresses: (srv: { url: string; alternateUrl?: string }) =>
    [srv.url, srv.alternateUrl].filter(Boolean),
  profileProbeFingerprint: (profile: {
    url: string;
    alternateUrl?: string;
    username: string;
    password: string;
    customHeaders?: unknown[];
    customHeadersApplyTo?: string;
  }) => JSON.stringify([
    profile.url,
    profile.alternateUrl ?? '',
    profile.username,
    profile.password,
    profile.customHeaders ?? [],
    profile.customHeadersApplyTo ?? '',
  ]),
}));

vi.mock('@/lib/server/serverFingerprint', () => ({
  verifySameServerEndpoints: vi.fn(),
}));

vi.mock('@/lib/server/serverUrlRemigration', () => ({
  indexKeyRemapForUrlChange: () => null,
  runIndexKeyRemigration: vi.fn(),
}));

vi.mock('@/lib/serverCapabilities/storeView', () => ({
  isFeatureActiveForServer: () => false,
  resolveFeatureForServer: () => null,
}));

vi.mock('@/features/settings/components/ServerLibraryIndexControls', () => ({
  default: () => null,
}));

vi.mock('@/features/settings/components/ServerCapabilityHeaderBadge', () => ({
  ServerCapabilityHeaderBadge: () => null,
}));

vi.mock('@/features/settings/components/ReorderGripHandle', () => ({
  ReorderGripHandle: () => null,
}));

vi.mock('@/lib/hooks/useListReorderDnd', () => ({
  useListReorderDnd: () => ({
    isDragging: false,
    setContainer: vi.fn(),
    onMouseMove: vi.fn(),
    dropEdge: () => null,
  }),
}));

vi.mock('@/features/settings/components/AddServerForm', () => ({
  AddServerForm: ({ editingServer, onSave }: {
    editingServer?: { url: string; name: string; username: string; password: string };
    onSave: (data: {
      name: string;
      url: string;
      username: string;
      password: string;
    }, onPersisted?: () => void) => void;
  }) => editingServer ? (
    <button type="button" onClick={() => onSave({
      name: editingServer.name,
      url: editingServer.url,
      username: editingServer.username,
      password: `${editingServer.password}-new`,
    }, mocks.onPersisted)}>
      save-edit
    </button>
  ) : null,
}));

import { ServersTab } from './ServersTab';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  resetAuthStore();
  mocks.bootstrapIndexedServer.mockReset().mockResolvedValue('bound');
  mocks.ensureConnectUrlResolved.mockReset();
  mocks.pingWithCredentialsForProfile.mockReset();
  mocks.syncServerHttpContextForProfile.mockReset().mockResolvedValue(undefined);
  mocks.invalidateReachableEndpointCache.mockReset();
  mocks.onPersisted.mockReset();
  useAuthStore.setState({
    activeServerId: 'a',
    isLoggedIn: true,
    servers: [{
      id: 'a', name: 'A', url: 'https://a.test', username: 'user', password: 'old-password',
    }],
  });
});

describe('ServersTab profile edit bootstrap ordering', () => {
  it('bootstraps only after the post-edit connection test succeeds', async () => {
    const ping = deferred<{
      ok: true;
      type: string;
      serverVersion: string;
      openSubsonic: boolean;
    }>();
    mocks.ensureConnectUrlResolved.mockReturnValue(ping.promise.then(result => ({
      ok: true as const,
      baseUrl: 'https://a.test',
      endpoint: { url: 'https://a.test', kind: 'public' as const },
      ping: result,
    })));
    const user = userEvent.setup();
    const view = renderWithProviders(<ServersTab initialInvite={null} />);

    await user.click(view.container.querySelector('#settings-edit-server-a')!);
    await user.click(screen.getByRole('button', { name: 'save-edit' }));

    expect(mocks.invalidateReachableEndpointCache).toHaveBeenCalledWith('a');
    expect(mocks.onPersisted).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapIndexedServer).not.toHaveBeenCalled();

    await act(async () => {
      ping.resolve({ ok: true, type: 'navidrome', serverVersion: '0.56.0', openSubsonic: true });
    });

    await waitFor(() => expect(mocks.bootstrapIndexedServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', password: 'old-password-new' }),
    ));
  });

  it('does not bootstrap an older captured profile after a newer edit', async () => {
    const firstPing = deferred<{
      ok: true;
      type: string;
      serverVersion: string;
      openSubsonic: boolean;
    }>();
    const secondPing = deferred<{
      ok: true;
      type: string;
      serverVersion: string;
      openSubsonic: boolean;
    }>();
    mocks.ensureConnectUrlResolved
      .mockReturnValueOnce(firstPing.promise.then(result => ({
        ok: true as const,
        baseUrl: 'https://a.test',
        endpoint: { url: 'https://a.test', kind: 'public' as const },
        ping: result,
      })))
      .mockReturnValueOnce(secondPing.promise.then(result => ({
        ok: true as const,
        baseUrl: 'https://a.test',
        endpoint: { url: 'https://a.test', kind: 'public' as const },
        ping: result,
      })));
    const user = userEvent.setup();
    const view = renderWithProviders(<ServersTab initialInvite={null} />);

    await user.click(view.container.querySelector('#settings-edit-server-a')!);
    await user.click(screen.getByRole('button', { name: 'save-edit' }));
    await user.click(view.container.querySelector('#settings-edit-server-a')!);
    await user.click(screen.getByRole('button', { name: 'save-edit' }));

    await act(async () => {
      secondPing.resolve({ ok: true, type: 'navidrome', serverVersion: '0.56.0', openSubsonic: true });
    });
    await waitFor(() => expect(mocks.bootstrapIndexedServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', password: 'old-password-new-new' }),
    ));

    await act(async () => {
      firstPing.resolve({ ok: true, type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true });
    });
    expect(mocks.bootstrapIndexedServer).toHaveBeenCalledTimes(1);
  });
});
