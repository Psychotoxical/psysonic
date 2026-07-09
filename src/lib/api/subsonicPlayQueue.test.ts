import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';

const { apiForServerMock, apiPostFormForServerMock, authState } = vi.hoisted(() => ({
  apiForServerMock: vi.fn(async () => ({ status: 'ok' })),
  apiPostFormForServerMock: vi.fn(async () => ({ status: 'ok' })),
  authState: {
    openSubsonicExtensionsByServer: {} as Record<string, string[]>,
  },
}));

vi.mock('@/lib/api/subsonicClient', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/subsonicClient')>('@/lib/api/subsonicClient');
  return {
    ...actual,
    api: vi.fn(),
    apiForServer: apiForServerMock,
    apiPostFormForServer: apiPostFormForServerMock,
  };
});

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

import { savePlayQueue } from '@/lib/api/subsonicPlayQueue';

beforeEach(() => {
  apiForServerMock.mockReset();
  apiPostFormForServerMock.mockReset();
  apiForServerMock.mockResolvedValue({ status: 'ok' });
  apiPostFormForServerMock.mockResolvedValue({ status: 'ok' });
  authState.openSubsonicExtensionsByServer = {};
});

describe('savePlayQueue transport', () => {
  it('uses form POST when formPost is advertised', async () => {
    authState.openSubsonicExtensionsByServer = { 'srv-a': ['formPost', 'playbackReport'] };
    await savePlayQueue(['a', 'b'], 'a', 1000, 'srv-a');
    expect(apiPostFormForServerMock).toHaveBeenCalledWith('srv-a', 'savePlayQueue.view', {
      id: ['a', 'b'],
      current: 'a',
      position: 1000,
    });
    expect(apiForServerMock).not.toHaveBeenCalled();
  });

  it('uses GET when formPost is not advertised', async () => {
    authState.openSubsonicExtensionsByServer = { 'srv-a': ['playbackReport'] };
    await savePlayQueue(['a'], 'a', 0, 'srv-a');
    expect(apiForServerMock).toHaveBeenCalledWith('srv-a', 'savePlayQueue.view', {
      id: ['a'],
      current: 'a',
      position: 0,
    });
    expect(apiPostFormForServerMock).not.toHaveBeenCalled();
  });

  it('retries once as POST after HTTP 414 on GET', async () => {
    const err = new AxiosError('Request failed');
    err.response = { status: 414, data: '', statusText: 'URI Too Long', headers: {}, config: {} as never };
    apiForServerMock.mockRejectedValueOnce(err);

    await savePlayQueue(['a', 'b'], 'a', 50, 'srv-a');

    expect(apiForServerMock).toHaveBeenCalledTimes(1);
    expect(apiPostFormForServerMock).toHaveBeenCalledWith('srv-a', 'savePlayQueue.view', {
      id: ['a', 'b'],
      current: 'a',
      position: 50,
    });
  });

  it('does not retry POST on non-414 GET failures', async () => {
    apiForServerMock.mockRejectedValueOnce(new Error('offline'));
    await expect(savePlayQueue(['a'], 'a', 0, 'srv-a')).rejects.toThrow('offline');
    expect(apiPostFormForServerMock).not.toHaveBeenCalled();
  });
});
