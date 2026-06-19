// Dev-only spike for the artist-fanart pipeline (image-scraper P0). Exposed on
// `window` in dev builds; fire it from the DevTools console:
//
//   await psyFanartSpike()                 // defaults to "Iron Maiden"
//   await psyFanartSpike('Pink Floyd')     // any artist name (resolved by search)
//
// Launch the dev process with PSYSONIC_FANART_KEY set (and optionally
// PSYSONIC_FANART_CLIENT_KEY for a BYOK personal key). It resolves the name to
// the first matching Navidrome artist id, then reuses the normal
// `cover_cache_ensure` command with the additive external-artwork args — so it
// exercises the real `ensure_inner` external branch (§16 P0), no new IPC, no
// production path. On success it returns `{ hit, path }` pointing at
// `…/2000-fanart.webp` and writes `2000-fanart.webp` + `512-fanart.webp`.
//
// Note: the early peek serves a cached Navidrome `2000.webp` first, so if the
// result path is not `*-fanart.webp`, clear that artist's cover dir and retry.
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { search } from '../api/subsonicSearch';
import { artistCoverRef } from '../cover/ref';
import { coverIndexKeyFromRef } from '../cover/storageKeys';

export async function fanartSpike(artistName = 'Iron Maiden', tier = 2000): Promise<unknown> {
  const server = useAuthStore.getState().getActiveServer();
  if (!server) {
    console.warn('[fanart-spike] no active server — log in first');
    return;
  }

  // Resolve the name to the first search hit that actually carries an id
  // (Navidrome can return junk artist rows without one).
  let hits: { id: string; name: string }[] = [];
  try {
    const { artists } = await search(artistName, { artistCount: 8, albumCount: 0, songCount: 0 });
    hits = artists.map((a) => ({ id: a.id, name: a.name }));
  } catch (e) {
    console.warn('[fanart-spike] search failed:', e);
  }
  console.info('[fanart-spike] search →', hits);
  const hit = hits.find((a) => typeof a.id === 'string' && a.id.trim().length > 0);
  if (!hit) {
    console.warn(
      `[fanart-spike] no artist with a usable id for "${artistName}" — try a different name`,
    );
    return;
  }
  const artistId = hit.id;
  const label = `${hit.name} (${hit.id})`;

  const ref = artistCoverRef(artistId);
  const args = {
    serverIndexKey: coverIndexKeyFromRef(ref),
    cacheKind: ref.cacheKind,
    cacheEntityId: ref.cacheEntityId,
    coverArtId: ref.fetchCoverArtId ?? artistId,
    tier,
    restBaseUrl: useAuthStore.getState().getBaseUrl(),
    username: server.username,
    password: server.password,
    externalArtworkEnabled: true,
    surfaceKind: 'fanart',
  };
  console.info('[fanart-spike]', label, '· tier', tier, '…');
  const res = await invoke('cover_cache_ensure', { args });
  console.info('[fanart-spike] result:', res);
  return res;
}

export function registerFanartSpike(): void {
  (window as unknown as { psyFanartSpike?: typeof fanartSpike }).psyFanartSpike = fanartSpike;
  console.info('[fanart-spike] ready — call: await psyFanartSpike("Iron Maiden")');
}
