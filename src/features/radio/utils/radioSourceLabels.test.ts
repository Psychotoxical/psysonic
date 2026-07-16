import { describe, expect, it } from 'vitest';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';

describe('radio source labels', () => {
  it('qualifies colliding server names for individual station provenance', () => {
    const servers = [
      { id: 'home', name: 'Music', url: 'https://music.home.test', username: 'alice', password: 'a' },
      { id: 'office', name: 'Music', url: 'https://music.office.test', username: 'bob', password: 'b' },
    ];

    expect(serverListDisplayLabel(servers[0], servers)).toBe('alice@music.home.test');
    expect(serverListDisplayLabel(servers[1], servers)).toBe('bob@music.office.test');
  });
});
