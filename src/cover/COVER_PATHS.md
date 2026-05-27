# Cover art resolution paths (audit)

All **library-backed** surfaces resolve through:

1. **SQLite** — `library_resolve_cover_entry` / `cover_resolve.rs`
2. **TS** — `resolveEntryLibrary.ts` → hooks (`useAlbumCoverRef`, …) or entity images (`AlbumCoverArtImage`, …)
3. **Disk** — `psysonic_core::cover_cache_layout` (`cover-cache/<server>/<kind>/<entity_id>/`)

## UI entry points

| Surface | Mechanism |
|---------|-----------|
| Album / artist / track grids & cards | `use*CoverRef` or `*CoverArtImage` |
| Playback (player, queue, now playing) | `usePlaybackTrackCoverRef` |
| Prefetch / warm peek | `useLibraryCoverPrefetch`, `collectAlbumCoverWarmItems` (library async) |
| Share search (foreign server) | `*CoverArtImage` + `serverScope` |
| Playlists | `usePlaylistCovers` → `resolveAlbumCoverRefFromLibrary` |

## Intentional exceptions (not in library index)

| Case | Why |
|------|-----|
| Internet radio (`ra-*`, `coverArtIdFromRadio`) | Not album/artist/track entities |
| Sync fallback in `ref.ts` | First paint before IPC; upgraded by hooks |

## Deprecated direct use

Do **not** call `albumCoverRef` / `artistCoverRef` in new UI — use hooks or `*CoverArtImage`.
`albumCoverRef` remains for sync fallback inside hooks, radio, and tests.

**Hook pitfall:** never use inline `{ kind: 'active' }` as a default argument or dep — use `COVER_SCOPE_ACTIVE` from `types.ts`. Unstable scope objects caused render loops (IPC storm, frozen UI).
