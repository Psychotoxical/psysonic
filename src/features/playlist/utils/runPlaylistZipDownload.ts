import { downloadZip } from '@/lib/api/downloadZip';
import { join } from '@tauri-apps/api/path';
import { buildDownloadUrl } from '@/lib/api/subsonicStreamUrl';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { useZipDownloadStore } from '@/features/offline';
import { sanitizeFilename } from '@/lib/format/playlistDetailHelpers';

export interface RunPlaylistZipDownloadDeps {
  playlist: SubsonicPlaylist;
  id: string;
  downloadFolder: string | null;
  requestDownloadFolder: () => Promise<string | null>;
  setZipDownloadId: (id: string | null) => void;
}

export async function runPlaylistZipDownload(deps: RunPlaylistZipDownloadDeps): Promise<void> {
  const { playlist, id, downloadFolder, requestDownloadFolder, setZipDownloadId } = deps;
  const folder = downloadFolder || await requestDownloadFolder();
  if (!folder) return;

  const filename = `${sanitizeFilename(playlist.name)}.zip`;
  const destPath = await join(folder, filename);
  const url = buildDownloadUrl(id);
  const downloadId = crypto.randomUUID();

  const { start, complete, fail } = useZipDownloadStore.getState();
  start(downloadId, filename);
  setZipDownloadId(downloadId);
  try {
    await downloadZip({ id: downloadId, url, destPath });
    complete(downloadId);
  } catch (e) {
    fail(downloadId);
    console.error('ZIP download failed:', e);
  }
}
