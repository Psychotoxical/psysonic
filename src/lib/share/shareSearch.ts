import {
  decodeSharePayloadFromText,
  PSYSONIC_SHARE_PREFIX,
} from '@/lib/share/shareLink';

export type QueueableShareSearchPayload =
  | { srv: string; k: 'track'; id: string }
  | { srv: string; k: 'queue'; ids: string[] };

export type AlbumShareSearchPayload = { srv: string; k: 'album'; id: string };
export type ArtistShareSearchPayload = { srv: string; k: 'artist'; id: string };
export type ComposerShareSearchPayload = { srv: string; k: 'composer'; id: string };

export type ShareSearchMatch =
  | { type: 'queueable'; payload: QueueableShareSearchPayload }
  | { type: 'album'; payload: AlbumShareSearchPayload }
  | { type: 'artist'; payload: ArtistShareSearchPayload }
  | { type: 'composer'; payload: ComposerShareSearchPayload }
  | { type: 'unsupported' };

export function parseShareSearchText(text: string): ShareSearchMatch | null {
  const trimmed = text.trim();
  if (!trimmed.includes(PSYSONIC_SHARE_PREFIX)) return null;

  const payload = decodeSharePayloadFromText(trimmed);
  if (!payload) return { type: 'unsupported' };
  if (payload.k === 'track') {
    return {
      type: 'queueable',
      payload: { srv: payload.srv, k: 'track', id: payload.id },
    };
  }
  if (payload.k === 'queue') {
    return {
      type: 'queueable',
      payload: { srv: payload.srv, k: 'queue', ids: payload.ids },
    };
  }
  if (payload.k === 'album') {
    return {
      type: 'album',
      payload: { srv: payload.srv, k: 'album', id: payload.id },
    };
  }
  if (payload.k === 'artist') {
    return {
      type: 'artist',
      payload: { srv: payload.srv, k: 'artist', id: payload.id },
    };
  }
  if (payload.k === 'composer') {
    return {
      type: 'composer',
      payload: { srv: payload.srv, k: 'composer', id: payload.id },
    };
  }

  return { type: 'unsupported' };
}

export function sharePayloadTotal(payload: QueueableShareSearchPayload): number {
  return payload.k === 'track' ? 1 : payload.ids.length;
}
