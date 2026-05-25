import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../store/authStore';
import { coverCacheRestHost, librarySqlServerId } from './coverCache';

describe('librarySqlServerId', () => {
  beforeEach(() => {
    useAuthStore.setState({
      servers: [{ id: 'profile-uuid', name: 'Home', url: 'http://music.example:4533', username: 'u', password: 'p' }],
      activeServerId: 'profile-uuid',
    });
  });

  it('maps auth profile UUID to host index key for SQLite', () => {
    expect(librarySqlServerId('profile-uuid')).toBe('music.example:4533');
  });

  it('passes through values that are already index keys', () => {
    expect(librarySqlServerId('music.example:4533')).toBe('music.example:4533');
  });
});

describe('coverCacheRestHost', () => {
  it('strips /rest for Rust cover fetch', () => {
    expect(coverCacheRestHost('http://music.example:4533')).toBe('http://music.example:4533');
    expect(coverCacheRestHost('http://music.example:4533/')).toBe('http://music.example:4533');
  });
});
