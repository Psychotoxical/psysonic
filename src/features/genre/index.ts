/**
 * Genre feature — the genre overview (`Genres`) and per-genre album browse
 * (`GenreDetail`) pages plus the genre-detail browse hook. The pages are
 * lazy-loaded by the router via their deep paths, so they are not re-exported
 * here; nothing else outside the feature consumes its modules.
 *
 * Stays OUT (library-core / shared, consumed by this feature, not owned): the
 * `lib/library/genre*` catalog/query helpers + `genreColor`, the album-side
 * `useGenreAlbumBrowse` browse hook (`features/album`), and the
 * `genreBrowsePlayback` queue builder (`features/playback`).
 */
export {};
