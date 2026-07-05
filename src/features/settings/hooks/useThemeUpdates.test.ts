import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/themes/themeRegistry', () => ({
  fetchRegistry: vi.fn(),
  getCachedRegistry: vi.fn(() => null),
}));

import { fetchRegistry, type Registry } from '@/lib/themes/themeRegistry';
import { useInstalledThemesStore, type InstalledTheme } from '@/store/installedThemesStore';
import { useThemeUpdates, themeUpdateSignature } from '@/features/settings/hooks/useThemeUpdates';

const fetchRegistryMock = vi.mocked(fetchRegistry);

function inst(id: string, version: string): InstalledTheme {
  return { id, name: id, author: 'x', version, description: '', mode: 'dark', css: '', installedAt: 0 };
}

function registry(themes: { id: string; version: string }[]): Registry {
  return { themes: themes.map(t => ({ id: t.id, name: t.id, version: t.version })) } as unknown as Registry;
}

beforeEach(() => {
  useInstalledThemesStore.setState({ themes: [] });
  fetchRegistryMock.mockReset();
});

describe('useThemeUpdates', () => {
  it('lists only installed themes that have a newer registry version', async () => {
    useInstalledThemesStore.setState({ themes: [inst('a', '1.0.0'), inst('b', '2.0.0'), inst('c', '1.5.0')] });
    fetchRegistryMock.mockResolvedValue({
      registry: registry([
        { id: 'a', version: '1.1.0' }, // newer → update
        { id: 'b', version: '2.0.0' }, // same → no
        { id: 'c', version: '1.4.0' }, // older → no
      ]),
      stale: false,
    });

    const { result } = renderHook(() => useThemeUpdates());
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].id).toBe('a');
    expect(result.current[0].version).toBe('1.1.0');
  });

  it('returns nothing when nothing is outdated', async () => {
    useInstalledThemesStore.setState({ themes: [inst('a', '1.0.0')] });
    fetchRegistryMock.mockResolvedValue({ registry: registry([{ id: 'a', version: '1.0.0' }]), stale: false });

    const { result } = renderHook(() => useThemeUpdates());
    await waitFor(() => expect(fetchRegistryMock).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('ignores registry themes the user has not installed', async () => {
    useInstalledThemesStore.setState({ themes: [inst('a', '1.0.0')] });
    fetchRegistryMock.mockResolvedValue({ registry: registry([{ id: 'z', version: '9.0.0' }]), stale: false });

    const { result } = renderHook(() => useThemeUpdates());
    await waitFor(() => expect(fetchRegistryMock).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});

describe('themeUpdateSignature', () => {
  it('is order-independent and encodes id@version', () => {
    const a = themeUpdateSignature([{ id: 'b', version: '2.0.0' }, { id: 'a', version: '1.1.0' }]);
    const b = themeUpdateSignature([{ id: 'a', version: '1.1.0' }, { id: 'b', version: '2.0.0' }]);
    expect(a).toBe(b);
    expect(a).toBe('a@1.1.0,b@2.0.0');
  });

  it('changes when a version bumps so a dismissed notice can reappear', () => {
    expect(themeUpdateSignature([{ id: 'a', version: '1.1.0' }]))
      .not.toBe(themeUpdateSignature([{ id: 'a', version: '1.2.0' }]));
  });
});
