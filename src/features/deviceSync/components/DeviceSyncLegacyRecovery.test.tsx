import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { makeAuthState, makeServer } from '@/test/helpers/factories';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { useDeviceSyncStore } from '@/features/deviceSync/store/deviceSyncStore';
import { serverIndexKeyForProfile } from '@/lib/server/serverBaseUrl';
import { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { onInvoke } from '@/test/mocks/tauri';
import DeviceSyncLegacyRecovery from './DeviceSyncLegacyRecovery';

describe('DeviceSyncLegacyRecovery', () => {
  beforeEach(() => {
    resetAuthStore();
    useDeviceSyncStore.setState({
      targetDir: null,
      sources: [],
      legacySources: [{ type: 'album', id: 'legacy', name: 'Legacy' }],
      legacyTargetDir: null,
      checkedIds: [],
      pendingDeletion: [],
      deviceFilePaths: [],
      scanning: false,
    });
  });

  it('requires an explicit server choice before recovering quarantined sources', async () => {
    const server = makeServer({ id: 'server-a', name: 'My Server', url: 'https://server.test' });
    const serverIndexKey = serverIndexKeyForProfile(server);
    useAuthStore.setState(makeAuthState({ servers: [server], activeServerId: server.id }));
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
      version: 1,
      servers: {
        [serverIndexKey]: { canonicalVersion: 1, phase: 'legacy', checkedVersion: '0.63.2' },
      },
    }));
    const user = userEvent.setup();
    const view = renderWithProviders(<DeviceSyncLegacyRecovery />);
    const recover = view.getByRole('button', { name: 'Recover sources' });

    expect(recover).toBeDisabled();
    await user.selectOptions(view.getByLabelText('Assign to server'), serverIndexKey);
    await user.click(recover);

    expect(useDeviceSyncStore.getState().legacySources).toEqual([]);
    expect(useDeviceSyncStore.getState().sources).toEqual([{
      type: 'album', id: 'legacy', name: 'Legacy', serverIndexKey,
    }]);
  });

  it('keeps sources quarantined when the device manifest cannot be updated', async () => {
    const server = makeServer({ id: 'server-a', name: 'My Server', url: 'https://server.test' });
    const serverIndexKey = serverIndexKeyForProfile(server);
    useAuthStore.setState(makeAuthState({ servers: [server], activeServerId: server.id }));
    useDeviceSyncStore.setState({ targetDir: '/device', legacyTargetDir: '/device' });
    onInvoke('write_device_manifest', () => { throw new Error('read only'); });
    const user = userEvent.setup();
    const view = renderWithProviders(<DeviceSyncLegacyRecovery />);

    await user.selectOptions(view.getByLabelText('Assign to server'), serverIndexKey);
    await user.click(view.getByRole('button', { name: 'Recover sources' }));

    expect(useDeviceSyncStore.getState().legacySources).toHaveLength(1);
    expect(useDeviceSyncStore.getState().sources).toEqual([]);
  });

  it('does not commit recovery after the target device changes', async () => {
    const server = makeServer({ id: 'server-a', name: 'My Server', url: 'https://server.test' });
    const serverIndexKey = serverIndexKeyForProfile(server);
    useAuthStore.setState(makeAuthState({ servers: [server], activeServerId: server.id }));
    useDeviceSyncStore.setState({ targetDir: '/device-a', legacyTargetDir: '/device-a' });
    let resolveWrite!: () => void;
    onInvoke('write_device_manifest', () => new Promise<void>(resolve => { resolveWrite = resolve; }));
    const user = userEvent.setup();
    const view = renderWithProviders(<DeviceSyncLegacyRecovery />);

    await user.selectOptions(view.getByLabelText('Assign to server'), serverIndexKey);
    await user.click(view.getByRole('button', { name: 'Recover sources' }));
    expect(view.getByLabelText('Assign to server')).toBeDisabled();
    expect(view.getByRole('button', { name: 'Recover sources' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Discard' })).toBeDisabled();
    useDeviceSyncStore.getState().setTargetDir('/device-b');
    resolveWrite();
    await Promise.resolve();

    expect(useDeviceSyncStore.getState().targetDir).toBe('/device-b');
    expect(useDeviceSyncStore.getState().legacySources).toHaveLength(1);
    expect(useDeviceSyncStore.getState().sources).toEqual([]);
  });
});
