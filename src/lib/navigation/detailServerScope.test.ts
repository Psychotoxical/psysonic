import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { appendServerQuery, readDetailServerId } from '@/lib/navigation/detailServerScope';

describe('detailServerScope', () => {
  beforeEach(() => {
    useAuthStore.setState({
      activeServerId: 'srv-active',
      servers: [
        { id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'srv-b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
    });
  });

  it('readDetailServerId prefers valid ?server= over fallback', () => {
    const params = new URLSearchParams('server=srv-b&lossless=1');
    expect(readDetailServerId(params, 'srv-active')).toBe('srv-b');
  });

  it('readDetailServerId falls back when server param is unknown', () => {
    const params = new URLSearchParams('server=missing');
    expect(readDetailServerId(params, 'srv-active')).toBe('srv-active');
  });

  it('appendServerQuery merges with existing query parts', () => {
    expect(appendServerQuery('lossless=1', 'srv-a')).toBe('lossless=1&server=srv-a');
    expect(appendServerQuery(undefined, 'srv-a')).toBe('server=srv-a');
  });
});
