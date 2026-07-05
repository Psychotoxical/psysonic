import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { timelineBootstrapIndexReady } from '@/features/playback/utils/timelineBootstrapReady';

vi.mock('@/lib/library/libraryReady', () => ({
  libraryIsReady: vi.fn(),
}));

import { libraryIsReady } from '@/lib/library/libraryReady';

describe('timelineBootstrapIndexReady', () => {
  beforeEach(() => {
    vi.mocked(libraryIsReady).mockReset();
    useAuthStore.setState({
      servers: [
        { id: 's1', name: 'A', url: 'https://a', username: 'u', password: 'p' },
        { id: 's2', name: 'B', url: 'https://b', username: 'u', password: 'p' },
      ],
      activeServerId: 's1',
    } as never);
    useLibraryIndexStore.setState({
      masterEnabled: true,
      isIndexEnabled: id => !!id,
      indexedServerIds: ids => ids,
    });
  });

  it('returns true when no servers are configured', async () => {
    useAuthStore.setState({ servers: [], activeServerId: null } as never);
    await expect(timelineBootstrapIndexReady()).resolves.toBe(true);
  });

  it('returns true when any indexed server is ready', async () => {
    vi.mocked(libraryIsReady).mockImplementation(async id => id === 's2');
    await expect(timelineBootstrapIndexReady()).resolves.toBe(true);
  });

  it('returns false when no indexed server is ready yet', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(false);
    await expect(timelineBootstrapIndexReady()).resolves.toBe(false);
  });
});
