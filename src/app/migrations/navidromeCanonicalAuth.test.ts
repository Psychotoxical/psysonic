import { describe, expect, it } from 'vitest';
import {
  AUTH_PERSISTENCE_KEY,
  readRawAuthServerProfileGroups,
} from './navidromeCanonicalAuth';

function profile(id: string, url: string) {
  return { id, name: id, url, username: `${id}-user`, password: `${id}-password` };
}

function writeAuth(servers: unknown[], activeServerId: unknown = null): void {
  localStorage.setItem(AUTH_PERSISTENCE_KEY, JSON.stringify({
    state: { servers, activeServerId },
    version: 1,
  }));
}

describe('readRawAuthServerProfileGroups', () => {
  it('groups profiles sharing a server index key', () => {
    writeAuth([
      profile('one', 'https://music.test/'),
      profile('two', 'music.test'),
      profile('other', 'https://other.test/subsonic'),
    ]);

    expect(readRawAuthServerProfileGroups()).toEqual([
      { serverIndexKey: 'music.test', profiles: [profile('one', 'https://music.test/'), profile('two', 'music.test')] },
      { serverIndexKey: 'other.test/subsonic', profiles: [profile('other', 'https://other.test/subsonic')] },
    ]);
  });

  it('puts the active matching profile first without disturbing other groups', () => {
    writeAuth([
      profile('first', 'https://music.test'),
      profile('active', 'http://music.test'),
      profile('third', 'music.test'),
      profile('other', 'other.test'),
    ], 'active');

    const groups = readRawAuthServerProfileGroups();
    expect(groups[0]?.profiles.map(server => server.id)).toEqual(['active', 'first', 'third']);
    expect(groups[1]?.profiles.map(server => server.id)).toEqual(['other']);
  });

  it('skips malformed profiles and preserves valid optional connection fields', () => {
    const valid = {
      ...profile('valid', 'https://music.test'),
      alternateUrl: 'http://music.lan',
      shareUsesLocalUrl: true,
      customHeaders: [{ name: 'Authorization', value: 'secret' }],
      customHeadersApplyTo: 'both' as const,
    };
    writeAuth([
      null,
      {},
      { ...profile('empty-url', '   ') },
      { ...profile('padded-url', ' https://bad.test') },
      { ...profile('bad-password', 'bad.test'), password: 42 },
      { ...profile('bad-headers', 'bad.test'), customHeaders: [{ name: 'X-Test' }] },
      valid,
    ], 'valid');

    expect(readRawAuthServerProfileGroups()).toEqual([
      { serverIndexKey: 'music.test', profiles: [valid] },
    ]);
  });

  it('throws for malformed auth JSON', () => {
    localStorage.setItem(AUTH_PERSISTENCE_KEY, '{not-json');
    expect(() => readRawAuthServerProfileGroups()).toThrow('Malformed psysonic-auth JSON');
  });
});
