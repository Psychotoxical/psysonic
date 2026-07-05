import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/lib/api/navidromeAdmin', () => ({
  ndLogin: vi.fn(),
}));

import { ndLogin } from '@/lib/api/navidromeAdmin';
import { useNavidromeAdminRole, canManageNavidromeRadio } from './useNavidromeAdminRole';

beforeEach(() => {
  resetAuthStore();
  vi.mocked(ndLogin).mockReset();
});

function seedNavidromeServer(): string {
  const id = useAuthStore.getState().addServer({
    name: 'Home',
    url: 'music.example.com',
    username: 'tester',
    password: 'pw',
  });
  useAuthStore.getState().setActiveServer(id);
  useAuthStore.getState().setLoggedIn(true);
  useAuthStore.getState().setSubsonicServerIdentity(id, {
    type: 'navidrome',
    serverVersion: '0.62.0',
    openSubsonic: true,
  });
  return id;
}

describe('useNavidromeAdminRole', () => {
  it('returns na when not logged in', () => {
    const id = useAuthStore.getState().addServer({
      name: 'Home',
      url: 'https://music.example.com',
      username: 'tester',
      password: 'pw',
    });
    useAuthStore.getState().setActiveServer(id);
    useAuthStore.getState().setSubsonicServerIdentity(id, {
      type: 'navidrome',
      serverVersion: '0.62.0',
      openSubsonic: true,
    });

    const { result } = renderHook(() => useNavidromeAdminRole());
    expect(result.current).toBe('na');
    expect(ndLogin).not.toHaveBeenCalled();
  });

  it('returns checking until server identity is known', () => {
    const id = useAuthStore.getState().addServer({
      name: 'Home',
      url: 'https://music.example.com',
      username: 'tester',
      password: 'pw',
    });
    useAuthStore.getState().setActiveServer(id);
    useAuthStore.getState().setLoggedIn(true);

    const { result } = renderHook(() => useNavidromeAdminRole());
    expect(result.current).toBe('checking');
    expect(ndLogin).not.toHaveBeenCalled();
  });

  it('returns na for non-Navidrome servers', () => {
    const id = useAuthStore.getState().addServer({
      name: 'Ampache',
      url: 'https://music.example.com',
      username: 'tester',
      password: 'pw',
    });
    useAuthStore.getState().setActiveServer(id);
    useAuthStore.getState().setLoggedIn(true);
    useAuthStore.getState().setSubsonicServerIdentity(id, {
      type: 'ampache',
      serverVersion: '6.0.0',
      openSubsonic: false,
    });

    const { result } = renderHook(() => useNavidromeAdminRole());
    expect(result.current).toBe('na');
    expect(ndLogin).not.toHaveBeenCalled();
  });

  it('probes Navidrome native login and reports admin', async () => {
    seedNavidromeServer();
    vi.mocked(ndLogin).mockResolvedValue({ token: 't', userId: '1', isAdmin: true });

    const { result } = renderHook(() => useNavidromeAdminRole());
    await waitFor(() => expect(result.current).toBe('admin'));
    expect(ndLogin).toHaveBeenCalledWith('http://music.example.com', 'tester', 'pw');
  });

  it('probes Navidrome native login and reports standard user', async () => {
    seedNavidromeServer();
    vi.mocked(ndLogin).mockResolvedValue({ token: 't', userId: '2', isAdmin: false });

    const { result } = renderHook(() => useNavidromeAdminRole());
    await waitFor(() => expect(result.current).toBe('user'));
  });

  it('returns error when native login fails', async () => {
    seedNavidromeServer();
    vi.mocked(ndLogin).mockRejectedValue(new Error('denied'));

    const { result } = renderHook(() => useNavidromeAdminRole());
    await waitFor(() => expect(result.current).toBe('error'));
  });
});

describe('canManageNavidromeRadio', () => {
  it('blocks only a confirmed standard Navidrome user', () => {
    expect(canManageNavidromeRadio('user')).toBe(false);
  });

  it('allows admins, non-Navidrome servers, and transient/unknown states', () => {
    for (const role of ['admin', 'na', 'idle', 'checking', 'error'] as const) {
      expect(canManageNavidromeRadio(role)).toBe(true);
    }
  });
});
