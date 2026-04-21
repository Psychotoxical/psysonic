import { useAuthStore } from '../store/authStore';
import { encodeSharePayload, type EntityShareKind } from './shareLink';
import { copyTextToClipboard } from './serverMagicString';

/** Copies a track / album / artist share link (`psysonic2-`) to the clipboard. */
export async function copyEntityShareLink(kind: EntityShareKind, id: string): Promise<boolean> {
  const srv = useAuthStore.getState().getBaseUrl();
  if (!srv || !id.trim()) return false;
  return copyTextToClipboard(encodeSharePayload({ srv, k: kind, id: id.trim() }));
}
