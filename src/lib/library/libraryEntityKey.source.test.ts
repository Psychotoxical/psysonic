import { describe, expect, it } from 'vitest';
import { libraryEntityKey } from './libraryEntityKey';

describe('source-qualified live entity keys', () => {
  it('keeps equal raw ids distinct across servers', () => {
    expect(libraryEntityKey({ id: 'same', serverId: 'a' }))
      .not.toBe(libraryEntityKey({ id: 'same', serverId: 'b' }));
  });
});
