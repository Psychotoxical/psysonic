import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../store/authStore';
import { COVER_SCOPE_ACTIVE } from './types';
import { coverServerScopeForServerId } from './serverScope';

describe('coverServerScopeForServerId', () => {
  beforeEach(() => {
    useAuthStore.setState({
      activeServerId: 'srv-active',
      servers: [
        { id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
      ],
    });
  });

  it('returns active scope when serverId is missing', () => {
    expect(coverServerScopeForServerId(undefined)).toBe(COVER_SCOPE_ACTIVE);
    expect(coverServerScopeForServerId(null)).toBe(COVER_SCOPE_ACTIVE);
  });

  it('returns explicit server scope for a known profile id', () => {
    expect(coverServerScopeForServerId('srv-a')).toEqual({
      kind: 'server',
      serverId: 'srv-a',
      url: 'https://a.test',
      username: 'u',
      password: 'p',
    });
  });

  it('falls back to active scope for unknown ids', () => {
    expect(coverServerScopeForServerId('missing')).toBe(COVER_SCOPE_ACTIVE);
  });
});
