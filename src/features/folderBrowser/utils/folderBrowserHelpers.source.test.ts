import { describe, expect, it } from 'vitest';
import { entryToTrack } from './folderBrowserHelpers';

describe('folder browser source routing', () => {
  it('carries the directory source into playback and actions', () => {
    expect(entryToTrack({
      id: 'same', title: 'Track', isDir: false, serverId: 'server-b',
    }).serverId).toBe('server-b');
  });
});
