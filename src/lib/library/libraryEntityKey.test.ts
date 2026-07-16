import { describe, expect, it } from 'vitest';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';
import { dedupeById } from '@/lib/util/dedupeById';

describe('libraryEntityKey', () => {
  it('keeps equal raw ids distinct across servers', () => {
    expect(libraryEntityKey({ serverId: 'srv-a', id: 'same' })).toBe('srv-a:same');
    expect(libraryEntityKey({ serverId: 'srv-b', id: 'same' })).toBe('srv-b:same');
    expect(dedupeById([
      { serverId: 'srv-a', id: 'same' },
      { serverId: 'srv-b', id: 'same' },
      { serverId: 'srv-a', id: 'same' },
    ])).toEqual([
      { serverId: 'srv-a', id: 'same' },
      { serverId: 'srv-b', id: 'same' },
    ]);
  });

  it('preserves the legacy single-server key when provenance is absent', () => {
    expect(libraryEntityKey({ id: 'album-1' })).toBe('album-1');
  });
});
