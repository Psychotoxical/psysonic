import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import PlaylistFolderSection from '@/features/playlist/components/PlaylistFolderSection';
import { usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';
import type { PlaylistFolder } from '@/features/playlist/utils/playlistFolders';

const store = () => usePlaylistFolderStore.getState();
const assignments = (serverId: string) => store().byServer[serverId]?.assignments ?? {};

beforeEach(() => {
  usePlaylistFolderStore.setState({ byServer: {}, groupView: true });
});

/** Simulate the shared mouse-DnD system releasing a playlist over an element. */
function dropPlaylist(el: Element, playlistId: string) {
  el.dispatchEvent(
    new CustomEvent('psy-drop', {
      bubbles: true,
      detail: { data: JSON.stringify({ type: 'playlist', id: playlistId }) },
    }),
  );
}

describe('PlaylistFolderSection — drop target', () => {
  it('files a dropped playlist into the folder', () => {
    const id = store().createFolder('s1', 'Rock');
    const folder: PlaylistFolder = { id, name: 'Rock', order: 0, collapsed: false };
    const { container } = renderWithProviders(
      <PlaylistFolderSection
        serverId="s1"
        folder={folder}
        items={[]}
        renderCard={() => null}
        disableVirtualization
      />,
    );
    dropPlaylist(container.querySelector('.playlist-folder')!, 'p1');
    expect(assignments('s1').p1).toBe(id);
  });

  it('unfiles a dropped playlist in the ungrouped section', () => {
    const id = store().createFolder('s1', 'Rock');
    store().setPlaylistFolder('s1', 'p1', id);
    const { container } = renderWithProviders(
      <PlaylistFolderSection
        serverId="s1"
        folder={null}
        items={[]}
        renderCard={() => null}
        disableVirtualization
      />,
    );
    dropPlaylist(container.querySelector('.playlist-folder--ungrouped')!, 'p1');
    expect(assignments('s1').p1).toBeUndefined();
  });
});
