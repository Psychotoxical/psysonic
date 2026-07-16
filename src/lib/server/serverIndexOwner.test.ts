import { describe, expect, it } from 'vitest';
import { serverIndexOwnerForKey, serverIndexOwners } from './serverIndexKey';

const primary = {
  id: 'primary',
  name: 'Primary',
  url: 'https://same.example',
  username: 'owner',
  password: 'secret',
};
const alias = {
  ...primary,
  id: 'alias',
  name: 'Alias',
  url: 'http://same.example/',
};

describe('serverIndexOwner', () => {
  it.each(['primary', 'alias', null])('keeps selected common-order ownership when active is %s', activeServerId => {
    const state = {
      servers: [primary, alias],
      activeServerId,
      musicLibraryServerIds: ['alias', 'primary'],
    };
    expect(serverIndexOwners(state).map(server => server.id)).toEqual(['primary']);
    expect(serverIndexOwnerForKey(state, 'same.example')?.id).toBe('primary');
  });

  it('lets a selected alias own the index when the earlier profile is outside the selected scope', () => {
    expect(serverIndexOwners({
      servers: [primary, alias],
      musicLibraryServerIds: ['alias'],
    }).map(server => server.id)).toEqual(['alias']);
  });

  it('rejects selected aliases whose credentials cannot share one physical session', () => {
    expect(() => serverIndexOwners({
      servers: [primary, { ...alias, username: 'different' }],
      musicLibraryServerIds: ['primary', 'alias'],
    })).toThrow(/share library index "same\.example" but use incompatible credentials or connection settings/);
  });
});
