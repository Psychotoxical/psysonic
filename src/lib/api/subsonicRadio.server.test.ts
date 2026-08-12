import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  api: vi.fn(),
  apiForServer: vi.fn(),
  uploadRadioCover: vi.fn(),
  deleteRadioCover: vi.fn(),
  findServerByIdOrIndexKey: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/generated/bindings', () => ({
  commands: {
    uploadRadioCover: hoisted.uploadRadioCover,
    deleteRadioCover: hoisted.deleteRadioCover,
    fetchUrlBytes: vi.fn(),
  },
}));
vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ activeServerId: 'srv-active' }) },
}));
vi.mock('@/lib/api/subsonicClient', () => ({
  api: hoisted.api,
  apiForServer: hoisted.apiForServer,
}));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({
  shouldAttemptSubsonicForServer: vi.fn(() => true),
}));
vi.mock('@/lib/server/serverLookup', () => ({
  findServerByIdOrIndexKey: hoisted.findServerByIdOrIndexKey,
}));
vi.mock('@/lib/server/serverEndpoint', () => ({
  connectBaseUrlForServer: (server: { id: string }) => `https://${server.id}.test`,
}));

import {
  createInternetRadioStationForServer,
  deleteInternetRadioStationForServer,
  getInternetRadioStationsForServer,
  getInternetRadioStationsForServersSettled,
  updateInternetRadioStationForServer,
  uploadRadioCoverArtBytesForServer,
} from './subsonicRadio';

describe('subsonicRadio explicit server ownership', () => {
  beforeEach(() => {
    Object.values(hoisted).forEach(mock => mock.mockReset());
    hoisted.uploadRadioCover.mockResolvedValue({ status: 'ok', data: null });
    hoisted.findServerByIdOrIndexKey.mockImplementation((serverId: string) => ({
      id: serverId,
      username: `${serverId}-user`,
      password: `${serverId}-password`,
    }));
  });

  it('preserves duplicate raw ids from successful owners and reports partial failures', async () => {
    hoisted.apiForServer.mockImplementation(async (serverId: string) => {
      if (serverId === 'srv-b') throw new Error('offline');
      return {
        internetRadioStations: {
          internetRadioStation: [{
            id: 'shared',
            name: `${serverId} Radio`,
            streamUrl: `https://${serverId}.test/live`,
          }],
        },
      };
    });

    await expect(getInternetRadioStationsForServersSettled([
      'srv-a',
      'srv-b',
      'srv-a',
      'srv-c',
    ])).resolves.toEqual({
      stations: [
        {
          id: 'shared',
          serverId: 'srv-a',
          name: 'srv-a Radio',
          streamUrl: 'https://srv-a.test/live',
        },
        {
          id: 'shared',
          serverId: 'srv-c',
          name: 'srv-c Radio',
          streamUrl: 'https://srv-c.test/live',
        },
      ],
      failedServerIds: ['srv-b'],
    });
  });

  it('normalises the Subsonic homePageUrl response field', async () => {
    hoisted.apiForServer.mockResolvedValue({
      internetRadioStations: {
        internetRadioStation: [{
          id: 'radio-1',
          name: 'Station',
          streamUrl: 'https://radio.test/live',
          homePageUrl: 'https://radio.test',
        }],
      },
    });

    await expect(getInternetRadioStationsForServer('srv-owner')).resolves.toEqual([{
      id: 'radio-1',
      serverId: 'srv-owner',
      name: 'Station',
      streamUrl: 'https://radio.test/live',
      homepageUrl: 'https://radio.test',
    }]);
  });

  it('routes create, update, delete, and cover upload to the captured owner', async () => {
    hoisted.apiForServer.mockResolvedValue({});

    await createInternetRadioStationForServer('srv-owner', 'One', 'https://one.test/live');
    await updateInternetRadioStationForServer(
      'srv-owner',
      'radio-1',
      'Updated',
      'https://updated.test/live',
      'https://updated.test',
    );
    await deleteInternetRadioStationForServer('srv-owner', 'radio-1');
    await uploadRadioCoverArtBytesForServer('srv-owner', 'radio-1', [1, 2, 3], 'image/png');

    expect(hoisted.apiForServer).toHaveBeenNthCalledWith(
      1,
      'srv-owner',
      'createInternetRadioStation.view',
      { name: 'One', streamUrl: 'https://one.test/live' },
    );
    expect(hoisted.apiForServer).toHaveBeenNthCalledWith(
      2,
      'srv-owner',
      'updateInternetRadioStation.view',
      {
        id: 'radio-1',
        name: 'Updated',
        streamUrl: 'https://updated.test/live',
        homepageUrl: 'https://updated.test',
      },
    );
    expect(hoisted.apiForServer).toHaveBeenNthCalledWith(
      3,
      'srv-owner',
      'deleteInternetRadioStation.view',
      { id: 'radio-1' },
    );
    expect(hoisted.uploadRadioCover).toHaveBeenCalledWith(
      'https://srv-owner.test',
      'radio-1',
      'srv-owner-user',
      'srv-owner-password',
      [1, 2, 3],
      'image/png',
    );
  });
});
