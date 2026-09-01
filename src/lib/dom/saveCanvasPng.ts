import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { showToast } from '@/lib/dom/toast';

export interface SavePngStrings {
  /** Native save-dialog title. */
  dialogTitle: string;
  /** Toast after a successful write. */
  savedToast: string;
  /** Toast when the write fails. */
  failedToast: string;
}

/**
 * Shared "save this PNG blob" tail used by the canvas export modals: native
 * save dialog, file write, success/error toasts. Returns `true` when the file
 * was written, `false` when the user cancelled the dialog.
 */
export async function savePngBlob(
  blob: Blob,
  suggestedName: string,
  strings: SavePngStrings,
): Promise<boolean> {
  const path = await save({
    title: strings.dialogTitle,
    defaultPath: suggestedName,
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (!path) return false;
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    await writeFile(path, buf);
    showToast(strings.savedToast, 2400, 'info');
    return true;
  } catch (err) {
    console.error('[export] save failed', err);
    showToast(strings.failedToast, 3200, 'error');
    return false;
  }
}
