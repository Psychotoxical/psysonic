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
  syncAllServerHttpContexts: vi.fn(),
  clearServerHttpContext: vi.fn(),
  invalidateReachableEndpointCache: vi.fn(),
  librarySyncClearSession: vi.fn(),
  libraryDeleteServerData: vi.fn(),
  onPersisted: vi.fn(),
  showToast: vi.fn(),
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
  clearServerHttpContext: mocks.clearServerHttpContext,
  setServerHttpContextIdentitySource: vi.fn(),
  syncAllServerHttpContexts: mocks.syncAllServerHttpContexts,
  syncServerHttpContextForProfile: mocks.syncServerHttpContextForProfile,
}));

vi.mock('@/lib/api/library', () => ({
  librarySyncClearSession: mocks.librarySyncClearSession,
  libraryDeleteServerData: mocks.libraryDeleteServerData,
}));

vi.mock('@/lib/dom/toast', () => ({
  showToast: mocks.showToast,
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
  AddServerForm: ({ editingServer, onSave, onDelete }: {
    editingServer?: { url: string; name: string; username: string; password: string };
    onSave: (data: {
      name: string;
      url: string;
      username: string;
      password: string;
    }, onPersisted?: () => void) => void;
    onDelete?: () => void;
  }) => editingServer ? (
    <>
      <button type="button" onClick={() => onSave({
        name: editingServer.name,
        url: editingServer.url,
        username: editingServer.username,
        password: `${editingServer.password}-new`,
      }, mocks.onPersisted)}>
        save-edit
      </button>
      <button type="button" onClick={onDelete}>delete-edit</button>
      <button type="button" onClick={() => onSave({
        name: editingServer.name,
        url: 'https://a.test/',
        username: 'user',
        password: editingServer.password,
      })}>
        save-edit-duplicate
      </button>
    </>
  ) : (
    <>
      <button type="button" onClick={() => onSave({
        name: 'Duplicate',
        url: 'https://a.test/',
        username: 'user',
        password: 'password',
      })}>
        save-add-duplicate
      </button>
      <button type="button" onClick={() => onSave({
        name: 'Other user',
        url: 'https://a.test/',
        username: 'other',
        password: 'password',
      })}>
        save-add-other-user
      </button>
    </>
  ),
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
  mocks.syncAllServerHttpContexts.mockReset().mockResolvedValue(undefined);
  mocks.clearServerHttpContext.mockReset().mockResolvedValue(undefined);
  mocks.invalidateReachableEndpointCache.mockReset();
  mocks.onPersisted.mockReset();
  mocks.showToast.mockReset();
  mocks.librarySyncClearSession.mockReset().mockResolvedValue(undefined);
  mocks.libraryDeleteServerData.mockReset().mockResolvedValue(undefined);
  useAuthStore.setState({
    activeServerId: 'a',
    isLoggedIn: true,
    servers: [{
      id: 'a', name: 'A', url: 'https://a.test', username: 'user', password: 'old-password',
    }],
  });
});

describe('ServersTab duplicate server login validation', () => {
  it('blocks adding an existing URL and username before connecting', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<ServersTab initialInvite={null} />);

    await user.click(view.container.querySelector('#settings-add-server-btn')!);
    await user.click(screen.getByRole('button', { name: 'save-add-duplicate' }));

    expect(mocks.pingWithCredentialsForProfile).not.toHaveBeenCalled();
    expect(useAuthStore.getState().servers).toHaveLength(1);
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/already exists/i),
      5000,
      'error',
    );
  });

  it('blocks editing another profile to an existing URL and username', async () => {
    useAuthStore.setState({
      servers: [
        ...useAuthStore.getState().servers,
        { id: 'b', name: 'B', url: 'https://b.test', username: 'other', password: 'password' },
      ],
    });
    const user = userEvent.setup();
    const view = renderWithProviders(<ServersTab initialInvite={null} />);

    await user.click(view.container.querySelector('#settings-edit-server-b')!);
    await user.click(screen.getByRole('button', { name: 'save-edit-duplicate' }));

    expect(useAuthStore.getState().servers.find(server => server.id === 'b')).toMatchObject({
      url: 'https://b.test',
      username: 'other',
    });
    expect(mocks.ensureConnectUrlResolved).not.toHaveBeenCalled();
  });

  it('allows the same URL for a different username', async () => {
    mocks.pingWithCredentialsForProfile.mockResolvedValue({
      ok: true,
      type: 'navidrome',
      serverVersion: '0.56.0',
      openSubsonic: true,
    });
    const user = userEvent.setup();
    const view = renderWithProviders(<ServersTab initialInvite={null} />);

    await user.click(view.container.querySelector('#settings-add-server-btn')!);
    await user.click(screen.getByRole('button', { name: 'save-add-other-user' }));

    await waitFor(() => expect(useAuthStore.getState().servers).toHaveLength(2));
    expect(useAuthStore.getState().servers[1]).toMatchObject({
      url: 'https://a.test/',
      username: 'other',
    });
    expect(mocks.showToast).not.toHaveBeenCalled();
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

describe('ServersTab profile removal', () => {
  it('clears and purges the captured index key even if HTTP cleanup fails', async () => {
    const profile = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'A',
      url: 'https://a.test',
      username: 'user',
      password: 'password',
    };
    useAuthStore.setState({ activeServerId: profile.id, servers: [profile] });
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    mocks.clearServerHttpContext.mockRejectedValueOnce(new Error('registry unavailable'));
    const user = userEvent.setup();
    const view = renderWithProviders(<ServersTab initialInvite={null} />);

    await user.click(view.container.querySelector(`#settings-edit-server-${profile.id}`)!);
    await user.click(screen.getByRole('button', { name: 'delete-edit' }));

    await waitFor(() => {
      expect(mocks.librarySyncClearSession).toHaveBeenCalledWith('a.test');
      expect(mocks.libraryDeleteServerData).toHaveBeenCalledWith('a.test');
    });
    expect(mocks.clearServerHttpContext).toHaveBeenCalledWith(profile);
    expect(useAuthStore.getState().servers).toEqual([]);
  });

  it('rebinds a shared index key instead of clearing another profile data', async () => {
    const removed = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Primary',
      url: 'https://a.test',
      username: 'first',
      password: 'first-password',
    };
    const replacement = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Replacement',
      url: 'https://a.test/',
      username: 'second',
      password: 'second-password',
    };
    useAuthStore.setState({ activeServerId: removed.id, servers: [removed, replacement] });
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);
    const user = userEvent.setup();
    const view = renderWithProviders(<ServersTab initialInvite={null} />);

    await user.click(view.container.querySelector(`#settings-edit-server-${removed.id}`)!);
    await user.click(screen.getByRole('button', { name: 'delete-edit' }));

    await waitFor(() => expect(mocks.bootstrapIndexedServer).toHaveBeenCalledWith(replacement));
    expect(mocks.syncAllServerHttpContexts).toHaveBeenCalledWith([replacement]);
    expect(mocks.clearServerHttpContext).not.toHaveBeenCalled();
    expect(mocks.librarySyncClearSession).not.toHaveBeenCalled();
    expect(mocks.libraryDeleteServerData).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().servers).toEqual([replacement]);
  });
});
