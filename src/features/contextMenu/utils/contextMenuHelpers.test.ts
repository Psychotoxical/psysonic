import { describe, expect, it } from 'vitest';
import { manualPlaylistTargetsForServer } from '@/features/contextMenu/utils/contextMenuHelpers';

describe('manualPlaylistTargetsForServer', () => {
  it('keeps only manual playlists owned by the requested server', () => {
    const playlists = [
      { id: 'shared', name: 'A', songCount: 0, duration: 0, created: '', changed: '', serverId: 'server-a' },
      { id: 'shared', name: 'B', songCount: 0, duration: 0, created: '', changed: '', serverId: 'server-b' },
      { id: 'smart', name: 'psy-smart-auto', songCount: 0, duration: 0, created: '', changed: '', serverId: 'server-a' },
      { id: 'native-smart', name: 'Feishin mix', smart: true, songCount: 0, duration: 0, created: '', changed: '', serverId: 'server-a' },
      { id: 'prefix-false-positive', name: 'psy-smart-Regular', smart: false, songCount: 0, duration: 0, created: '', changed: '', serverId: 'server-a' },
      { id: 'legacy', name: 'Legacy', songCount: 0, duration: 0, created: '', changed: '' },
    ];

    expect(manualPlaylistTargetsForServer(playlists, 'server-a').map(p => p.name))
      .toEqual(['A', 'psy-smart-Regular']);
    expect(manualPlaylistTargetsForServer(playlists, 'server-b').map(p => p.name))
      .toEqual(['B']);
    expect(manualPlaylistTargetsForServer(playlists, undefined)).toEqual([]);
  });
});
