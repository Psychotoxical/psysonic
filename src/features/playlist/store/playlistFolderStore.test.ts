import { beforeEach, describe, expect, it } from 'vitest';
import { usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';

const get = () => usePlaylistFolderStore.getState();
const server = (id: string) => get().byServer[id] ?? { folders: [], assignments: {} };

beforeEach(() => {
  usePlaylistFolderStore.setState({ byServer: {}, groupView: true });
});

describe('playlistFolderStore', () => {
  it('creates a folder and returns its id', () => {
    const id = get().createFolder('s1', '  Rock  ');
    const { folders } = server('s1');
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ id, name: 'Rock', collapsed: false });
  });

  it('assigns and reassigns a playlist, and clears assignment with null', () => {
    const f1 = get().createFolder('s1', 'A');
    const f2 = get().createFolder('s1', 'B');
    get().setPlaylistFolder('s1', 'p1', f1);
    expect(server('s1').assignments.p1).toBe(f1);
    get().setPlaylistFolder('s1', 'p1', f2);
    expect(server('s1').assignments.p1).toBe(f2);
    get().setPlaylistFolder('s1', 'p1', null);
    expect(server('s1').assignments.p1).toBeUndefined();
  });

  it('deleting a folder drops its assignments (playlists become ungrouped)', () => {
    const f1 = get().createFolder('s1', 'A');
    get().setPlaylistFolder('s1', 'p1', f1);
    get().setPlaylistFolder('s1', 'p2', f1);
    get().deleteFolder('s1', f1);
    expect(server('s1').folders).toHaveLength(0);
    expect(server('s1').assignments).toEqual({});
  });

  it('renames and toggles collapse', () => {
    const f1 = get().createFolder('s1', 'A');
    get().renameFolder('s1', f1, '  Jazz ');
    get().toggleFolderCollapsed('s1', f1);
    expect(server('s1').folders[0]).toMatchObject({ name: 'Jazz', collapsed: true });
  });

  it('toggles the grouped view (default on, global)', () => {
    expect(get().groupView).toBe(true);
    get().toggleGroupView();
    expect(get().groupView).toBe(false);
    get().toggleGroupView();
    expect(get().groupView).toBe(true);
  });

  it('scopes folders per server', () => {
    get().createFolder('s1', 'A');
    get().createFolder('s2', 'B');
    expect(server('s1').folders).toHaveLength(1);
    expect(server('s2').folders).toHaveLength(1);
    expect(server('s1').folders[0].name).toBe('A');
    expect(server('s2').folders[0].name).toBe('B');
  });
});
