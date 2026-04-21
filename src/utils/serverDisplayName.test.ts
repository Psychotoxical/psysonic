import { describe, expect, it } from 'vitest';
import type { ServerProfile } from '../store/authStore';
import { serverListDisplayLabel, shortHostFromServerUrl } from './serverDisplayName';

function srv(p: Partial<ServerProfile> & Pick<ServerProfile, 'id'>): ServerProfile {
  return {
    name: '',
    url: 'https://example.com',
    username: 'u',
    password: 'p',
    ...p,
  };
}

describe('shortHostFromServerUrl', () => {
  it('strips https and path', () => {
    expect(shortHostFromServerUrl('https://music.one.com/v1')).toBe('music.one.com');
  });
  it('keeps port', () => {
    expect(shortHostFromServerUrl('http://127.0.0.1:4533')).toBe('127.0.0.1:4533');
  });
});

describe('serverListDisplayLabel', () => {
  it('uses short host when name empty', () => {
    const a = srv({ id: '1', url: 'https://a.com', username: 'u', password: 'p', name: '' });
    expect(serverListDisplayLabel(a, [a])).toBe('a.com');
  });
  it('disambiguates duplicate names', () => {
    const a = srv({ id: '1', url: 'https://music.one.com', username: 'alice', password: 'p', name: 'Home' });
    const b = srv({ id: '2', url: 'https://other.net', username: 'bob', password: 'p', name: 'Home' });
    const all = [a, b];
    expect(serverListDisplayLabel(a, all)).toBe('alice@music.one.com');
    expect(serverListDisplayLabel(b, all)).toBe('bob@other.net');
  });
});
