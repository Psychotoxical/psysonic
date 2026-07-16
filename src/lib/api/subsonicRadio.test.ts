import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

const { apiForServer, uploadRadioCover } = vi.hoisted(() => ({
  apiForServer: vi.fn(),
  uploadRadioCover: vi.fn(),
}));

vi.mock('@/lib/api/subsonicClient', () => ({
  api: vi.fn(),
  apiForServer,
  getServerById: (serverId: string) => useAuthStore.getState().servers.find(server => server.id === serverId),
}));

vi.mock('@/generated/bindings', () => ({
  commands: { uploadRadioCover },
}));

import {
  createInternetRadioStationForServer,
  deleteInternetRadioStationForServer,
  updateInternetRadioStationForServer,
  uploadRadioCoverArtBytesForServer,
} from './subsonicRadio';

beforeEach(() => {
  resetAuthStore();
  apiForServer.mockReset().mockResolvedValue({});
  uploadRadioCover.mockReset().mockResolvedValue({ status: 'ok', data: null });
});

describe('server-qualified radio management', () => {
  it('routes create, update, and delete to the station owner', async () => {
    await createInternetRadioStationForServer('office', 'Test FM', 'https://radio.test');
    await updateInternetRadioStationForServer('office', 'r1', 'Test FM 2', 'https://radio.test/2');
    await deleteInternetRadioStationForServer('office', 'r1');

    expect(apiForServer).toHaveBeenNthCalledWith(1, 'office', 'createInternetRadioStation.view', {
      name: 'Test FM',
      streamUrl: 'https://radio.test',
    });
    expect(apiForServer).toHaveBeenNthCalledWith(2, 'office', 'updateInternetRadioStation.view', {
      id: 'r1',
      name: 'Test FM 2',
      streamUrl: 'https://radio.test/2',
    });
    expect(apiForServer).toHaveBeenNthCalledWith(3, 'office', 'deleteInternetRadioStation.view', { id: 'r1' });
  });

  it('uses the selected server credentials for directory cover upload', async () => {
    const serverId = useAuthStore.getState().addServer({
      name: 'Office',
      url: 'https://office.test',
      username: 'bob',
      password: 'secret',
    });

    await uploadRadioCoverArtBytesForServer(serverId, 'r1', [1, 2, 3], 'image/png');

    expect(uploadRadioCover).toHaveBeenCalledWith(
      'https://office.test',
      'r1',
      'bob',
      'secret',
      [1, 2, 3],
      'image/png',
    );
  });
});
