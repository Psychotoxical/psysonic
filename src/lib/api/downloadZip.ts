/**
 * Typed facade over the generated `download_zip` command (album/playlist ZIP
 * download to disk). Result-wrapped → the facade re-throws on error so the
 * callers' `try`/`catch` (which drive the ZIP-download store) stay unchanged.
 */
import { commands } from '@/generated/bindings';

export async function downloadZip(args: {
  id: string;
  url: string;
  destPath: string;
}): Promise<string> {
  const res = await commands.downloadZip(args.id, args.url, args.destPath);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}
