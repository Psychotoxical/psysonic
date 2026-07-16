import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { runPlaylistCsvImport } from '@/features/playlist/utils/runPlaylistCsvImport';
import { makeSubsonicSong } from '@/test/helpers/factories';

const openDialogMock = vi.fn();
const readTextFileMock = vi.fn();
const searchForServerMock = vi.fn();

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (...args: unknown[]) => openDialogMock(...args) }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: (...args: unknown[]) => readTextFileMock(...args) }));
vi.mock('@/lib/api/subsonicSearch', () => ({
  searchForServer: (...args: unknown[]) => searchForServerMock(...args),
}));
vi.mock('@/lib/dom/toast', () => ({ showToast: vi.fn() }));

describe('runPlaylistCsvImport', () => {
  beforeEach(() => {
    openDialogMock.mockReset().mockResolvedValue('/tmp/import.csv');
    readTextFileMock.mockReset().mockResolvedValue(
      'Track URI,Track Name,Artist Name(s),Album Name,ISRC\nspotify:track:1,Hidden Song,Artist,Album,ISRC1',
    );
    searchForServerMock.mockReset().mockResolvedValue({
      songs: [makeSubsonicSong({ id: 'hidden', title: 'Hidden Song', artist: 'Artist', album: 'Album', isrc: 'ISRC1' })],
    });
  });

  it('treats hidden full-membership tracks as duplicates', async () => {
    const savePlaylist = vi.fn().mockResolvedValue(undefined);
    const setSongs = vi.fn();
    const setCsvImportReport = vi.fn();

    await runPlaylistCsvImport({
      songs: [makeSubsonicSong({ id: 'visible', title: 'Visible' })],
      existingSongIds: ['visible', 'hidden'],
      ownerServerId: 'srv-owner',
      t: ((key: string) => key) as TFunction,
      savePlaylist,
      setSongs,
      setCsvImporting: vi.fn(),
      setCsvImportReport,
    });

    expect(setSongs).not.toHaveBeenCalled();
    expect(savePlaylist).not.toHaveBeenCalled();
    expect(setCsvImportReport).not.toHaveBeenCalled();
  });
});
