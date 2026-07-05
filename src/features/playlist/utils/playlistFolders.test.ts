import { describe, expect, it } from 'vitest';
import {
  groupPlaylistsByFolder,
  nextFolderOrder,
  type PlaylistFolder,
} from '@/features/playlist/utils/playlistFolders';

const folder = (id: string, order: number, name = id): PlaylistFolder =>
  ({ id, name, order, collapsed: false });
const pl = (id: string) => ({ id });

describe('groupPlaylistsByFolder', () => {
  it('places playlists into their assigned folder and the rest in ungrouped', () => {
    const folders = [folder('f1', 0), folder('f2', 1)];
    const result = groupPlaylistsByFolder(
      [pl('a'), pl('b'), pl('c'), pl('d')],
      folders,
      { a: 'f1', c: 'f2' },
    );
    expect(result.folders[0].playlists.map(p => p.id)).toEqual(['a']);
    expect(result.folders[1].playlists.map(p => p.id)).toEqual(['c']);
    expect(result.ungrouped.map(p => p.id)).toEqual(['b', 'd']);
  });

  it('returns folders in order, including empty ones', () => {
    const result = groupPlaylistsByFolder(
      [pl('a')],
      [folder('f2', 1, 'B'), folder('f1', 0, 'A')],
      { a: 'f1' },
    );
    expect(result.folders.map(g => g.folder.id)).toEqual(['f1', 'f2']);
    expect(result.folders[1].playlists).toEqual([]);
  });

  it('treats assignments to a missing folder as ungrouped', () => {
    const result = groupPlaylistsByFolder([pl('a')], [folder('f1', 0)], { a: 'gone' });
    expect(result.ungrouped.map(p => p.id)).toEqual(['a']);
    expect(result.folders[0].playlists).toEqual([]);
  });

  it('preserves input order within a bucket', () => {
    const result = groupPlaylistsByFolder(
      [pl('c'), pl('a'), pl('b')],
      [folder('f1', 0)],
      { a: 'f1', b: 'f1', c: 'f1' },
    );
    expect(result.folders[0].playlists.map(p => p.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('nextFolderOrder', () => {
  it('is 0 for an empty list', () => {
    expect(nextFolderOrder([])).toBe(0);
  });
  it('is one past the highest existing order', () => {
    expect(nextFolderOrder([folder('a', 0), folder('b', 5)])).toBe(6);
  });
});
