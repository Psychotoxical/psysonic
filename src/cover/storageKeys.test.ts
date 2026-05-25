import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coverStorageKey } from './storageKeys';

vi.mock('../store/authStore', () => ({
  useAuthStore: {
    getState: () => ({
      activeServerId: 'srv-1',
    }),
  },
}));

describe('coverStorageKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats active server keys', () => {
    expect(coverStorageKey({ kind: 'active' }, 'al-42', 128)).toBe('srv-1:cover:al-42:128');
  });

  it('formats explicit server scope', () => {
    expect(
      coverStorageKey(
        {
          kind: 'server',
          serverId: 'srv-2',
          url: 'https://x',
          username: 'u',
          password: 'p',
        },
        'ar-1',
        512,
      ),
    ).toBe('srv-2:cover:ar-1:512');
  });
});
