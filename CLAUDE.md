# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Psysonic

A desktop music player (Tauri v2 + React 18 + TypeScript) for Subsonic API-compatible servers (Navidrome, Gonic, etc.). UI is styled after the Catppuccin aesthetic with glassmorphism effects.

## Commands

```bash
# Dev mode (Linux — uses X11 backend to avoid WebKit compositing issues)
npm run tauri:dev
# Equivalent to: GDK_BACKEND=x11 WEBKIT_DISABLE_COMPOSITING_MODE=1 tauri dev

# Production build
npm run tauri:build

# Frontend-only dev server (no Tauri shell)
npm run dev

# Type-check + bundle frontend
npm run build
```

There are no test scripts. TypeScript compilation (`tsc`) is part of the build.

## Architecture

### Stack
- **Frontend**: React 18 + TypeScript + Vite, served inside a Tauri WebView
- **Backend**: Rust (Tauri v2) — handles tray icon, media key shortcuts, `exit_app` command, and the full audio engine
- **State**: Zustand stores (no Redux)
- **Audio**: Rust/rodio engine (`src-tauri/src/audio.rs`) — downloads track bytes via reqwest, decodes with symphonia, plays via rodio. Replaces Howler.js. See detailed notes in the Notes section.
- **API**: All server communication goes through `src/api/subsonic.ts` — a thin wrapper around axios using Subsonic token auth (MD5 hash of password + salt)
- **i18n**: react-i18next, all translations inline in `src/i18n.ts` (English + German)

### Key files

| File | Role |
|---|---|
| `src/api/subsonic.ts` | All Subsonic REST calls + `buildStreamUrl` / `buildCoverArtUrl` / `buildDownloadUrl` helpers. Also exports `pingWithCredentials()` and `coverArtCacheKey()`. `getRandomSongs` includes a `_t` timestamp param to prevent browser/axios caching. |
| `src/utils/imageCache.ts` | IndexedDB image cache (30-day TTL) + in-memory object URL Map. `getCachedUrl(fetchUrl, cacheKey)` is the main entry point. Capped at 150 entries with LRU eviction + `URL.revokeObjectURL`. Max 5 concurrent fetches. |
| `src/components/CachedImage.tsx` | Drop-in `<img>` replacement that resolves via the image cache. Also exports `useCachedUrl(fetchUrl, cacheKey)` hook for CSS background-image use cases. Uses cancellation flag to prevent setState on unmounted components. |
| `src/store/authStore.ts` | Multi-server support via `ServerProfile[]` + `activeServerId`. `getBaseUrl()` / `getActiveServer()` used by subsonic.ts. Persisted via **`localStorage`** (synchronous — do not change to async storage). |
| `src/store/playerStore.ts` | Playback state, queue, scrobbling at 50%, server queue sync (debounced 1.5s). Persists `currentTrack`, `queue`, `queueIndex`, `currentTime` for cold-start resume. |
| `src-tauri/src/audio.rs` | Rust audio engine: `audio_play`, `audio_pause`, `audio_resume`, `audio_stop`, `audio_seek`, `audio_set_volume` commands. Emits `audio:playing`, `audio:progress` (500ms), `audio:ended`, `audio:error` events. |
| `src/store/themeStore.ts` | Theme selection (8 themes), applied as `data-theme` on `<html>` |
| `src-tauri/src/lib.rs` | Tray menu, media key global shortcuts (disabled on Linux), `exit_app` command |
| `src/App.tsx` | Root routing, `RequireAuth` guard, `TauriEventBridge` (media keys → store actions) |
| `src/i18n.ts` | All translations (en + de) inline. Language persisted in `localStorage('psysonic_language')`. |
| `src/components/Sidebar.tsx` | Sidebar nav + `UpdateToast` component. On mount (1.5s delay) fetches `https://api.github.com/repos/Psychotoxical/psysonic/releases/latest`, compares `tag_name` against `version` imported directly from `package.json` (build-time constant — more reliable than `getVersion()` from Tauri API), and shows a toast above Statistics only when a newer version exists. Silently no-ops if offline. |
| `src/components/AlbumHeader.tsx` | Extracted from AlbumDetail — cover art, album info, play/enqueue buttons, bio modal, download. |
| `src/components/AlbumTrackList.tsx` | Extracted from AlbumDetail — tracklist with star ratings, codec labels, VA artist column, context menu. |
| `src/components/QueuePanel.tsx` | Queue sidebar. Shows song count + total duration below title. Items get `.context-active` class while their context menu is open. |
| `packages/aur/PKGBUILD` | AUR package definition for Arch/CachyOS. Installs a wrapper script at `/usr/bin/psysonic` that sets `GDK_BACKEND=x11`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`, `WEBKIT_DISABLE_DMABUF_RENDERER=1` before launching the binary. |

### Multi-server support
`authStore` holds a `ServerProfile[]` array and an `activeServerId`. The `ServerProfile` shape is:
```typescript
interface ServerProfile {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
}
```
Use `getActiveServer()` to get the current server, `getBaseUrl()` to get its URL.

### Login / connection flow
- Connection is tested with `pingWithCredentials(url, username, password)` from `src/api/subsonic.ts` **before** writing anything to the store.
- Only after a successful ping: `addServer()` + `setActiveServer()` + `setLoggedIn(true)`.
- `RequireAuth` in `App.tsx` redirects to `/login` if `!isLoggedIn || !activeServerId || servers.length === 0`.
- **Do not** call `addServer()` before verifying the connection — this avoids a rehydration race condition with Zustand's async storage.

### Auth salt security
`secureRandomSalt()` in `subsonic.ts` uses `crypto.getRandomValues()` (not `Math.random()`) for all token auth salts.

### Image caching
`buildCoverArtUrl()` generates a new ephemeral URL on every call (new salt) — the browser cache is useless. All cover art and artist images are cached via:
- `coverArtCacheKey(id, size)` — stable key: `${serverId}:cover:${id}:${size}`
- `CachedImage` component or `useCachedUrl` hook — resolve via IndexedDB, fall back to direct URL
- Use `useCachedUrl` (not `CachedImage`) for CSS `background-image` properties
- **Gotcha**: `useCachedUrl` / hooks from `CachedImage.tsx` must be called unconditionally, before any early `return` in the component. Derive inputs from nullable state (e.g. `album?.album.coverArt`) rather than placing the hook after guard returns.

### Data flow
1. `authStore.getBaseUrl()` returns the active server's URL
2. `subsonic.ts` calls `useAuthStore.getState()` directly (not hooks) to build each request
3. `playerStore.playTrack()` calls `invoke('audio_play', { url, volume, durationHint })`, calls `reportNowPlaying`, listens for `audio:progress` / `audio:ended` events, triggers scrobble at 50% via `scrobbleSong`, and debounces server queue sync
4. Tauri events (`media:play-pause`, `tray:play-pause`, etc.) are bridged to store actions in `TauriEventBridge` inside `App.tsx`
5. On cold start (app restart): if `currentTrack` is in localStorage, `resume()` calls `audio_play` + seeks to saved `currentTime`

### Adding a new page
1. Create `src/pages/MyPage.tsx`
2. Add a `<Route>` in `AppShell` in `src/App.tsx`
3. Add a sidebar link in `src/components/Sidebar.tsx`
4. Add i18n keys to both `enTranslation` and `deTranslation` in `src/i18n.ts`

### Adding a new Subsonic API call
Add a function to `src/api/subsonic.ts` using the `api<T>()` helper. The helper automatically injects auth params and unwraps `subsonic-response`.

### Themes
8 themes are available, selectable in Settings. `themeStore` persists the choice and sets `data-theme` on `<html>`. All component CSS uses semantic tokens (`--accent`, `--text-primary`, etc.) — only the player button gradient and a few decorative elements reference `--ctp-*` palette vars directly, so every theme must define the full `--ctp-*` set.

| Theme | Style | Accent |
|---|---|---|
| `mocha` | Catppuccin dark | Mauve |
| `macchiato` | Catppuccin medium-dark | Mauve |
| `frappe` | Catppuccin medium | Mauve |
| `latte` | Catppuccin light | Mauve |
| `nord` | Nord Polar Night dark | Frost `#88c0d0` |
| `nord-snowstorm` | Nord Snow Storm light | Deep-Blue `#5e81ac` |
| `nord-frost` | Nord deep ocean blue | Frost `#88c0d0` |
| `nord-aurora` | Nord Polar Night + aurora | Purple `#b48ead` |

**Light-theme gotcha**: The Hero and Fullscreen Player sit on top of album-art backgrounds with dark overlays. Their text colors are hardcoded white (not `var(--text-primary)`) so they stay readable in light themes (Latte, Nord Snowstorm).

### Artists page — initial avatars
Artist images are intentionally **not loaded** on the Artists overview page (grid + list view) to avoid slow server disk I/O on large libraries. Instead, each artist gets a colour-coded initial avatar: first letter of the name (skipping leading punctuation/numbers), colour deterministically hashed from the name using Catppuccin palette variables. Artist images are still loaded on the individual ArtistDetail page (cached via IndexedDB).

### Artist cards
`ArtistCardLocal` uses the same structure as `AlbumCard`: no padding, full-width square cover via `aspect-ratio: 1`, info below. Both use `flex: 0 0 clamp(140px, 15vw, 180px)` inside `.album-grid` so they stay the same size as album cards.

### NowPlayingDropdown — Live button
`src/components/NowPlayingDropdown.tsx` polls `getNowPlaying` every 10 seconds in the background. Navidrome keeps stale "now playing" entries for several minutes after playback stops. To fix this: entries belonging to the current user (`ownUsername`) are filtered by the **local `isPlaying` state** from `playerStore` — so the badge disappears instantly when the user pauses or stops, without waiting for the server to clear the entry. Clicking an entry navigates to the album page (`/album/:albumId`) if `stream.albumId` is available.

### i18n
All German strings live exclusively in `src/i18n.ts` — never hardcode German in `.tsx` files. Translation namespaces: `sidebar`, `home`, `hero`, `search`, `nowPlaying`, `contextMenu`, `albumDetail`, `artistDetail`, `favorites`, `randomMix`, `randomAlbums`, `playlists`, `albums`, `artists`, `statistics`, `login`, `common`, `settings`, `help`, `queue`, `player`.

**German terminology**: "Queue" is always "Warteschlange" in German — never leave "Queue" untranslated in DE strings.

### Tauri capabilities
Tauri v2 capability configs live in `src-tauri/capabilities/`. Schema is auto-generated into `src-tauri/gen/schemas/`. Modify capabilities there when adding new Tauri plugins or IPC commands.

## Release / CI

Releases are triggered by pushing a `v*` tag. The GitHub Actions workflow (`.github/workflows/release.yml`) builds for macOS (arm64 + x86_64), Linux (Ubuntu 24.04 → deb + rpm), and Windows.

The workflow is split into three jobs: `create-release` (creates the GitHub Release with changelog body from CHANGELOG.md), `build-macos-windows` (macOS + Windows via tauri-action), and `build-linux` (Ubuntu 24.04, manual, builds only deb + rpm via `--bundles deb,rpm`).

**AppImage is no longer built.** The AppImage was fundamentally incompatible with non-Ubuntu distros (Arch, Fedora) due to the bundled WebKitGTK conflicting with the system's Mesa/EGL stack.

### Linux distribution channels
| Distro family | Package |
|---|---|
| Ubuntu / Debian | `.deb` from GitHub Releases |
| Fedora / RHEL | `.rpm` from GitHub Releases |
| Arch / CachyOS | AUR: `yay -S psysonic` or `paru -S psysonic` |

### AUR package (`packages/aur/PKGBUILD`)
- Maintained at `aur.archlinux.org/packages/psysonic` (account: Psychotoxical)
- Builds from source using the system's own WebKitGTK — no bundled libs, no EGL issues
- Installs a wrapper script at `/usr/bin/psysonic` setting `GDK_BACKEND=x11`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`, `WEBKIT_DISABLE_DMABUF_RENDERER=1`
- **When releasing**: bump `pkgver` in `packages/aur/PKGBUILD`, copy to `~/aur-psysonic/`, run `makepkg --printsrcinfo > .SRCINFO`, commit and push to AUR remote

## Notes
- Media key shortcuts (`MediaPlayPause`, etc.) are **not registered on Linux** (see `#[cfg(not(target_os = "linux"))]` in `lib.rs`). Spacebar is the keyboard shortcut for play/pause instead.
- `playerStore` persists `volume`, `repeatMode`, `currentTrack`, `queue`, `queueIndex`, and `currentTime` to `localStorage` via Zustand `partialize`. The audio engine state is runtime-only (Rust side).
- Auth data is persisted via **`localStorage`** (synchronous Zustand storage). Do **not** switch to `@tauri-apps/plugin-store` for `authStore` — async storage causes a rehydration race condition where `getActiveServer()` returns `undefined` before state is restored.
- `tauri.conf.json` CSP is set to `null` — a stricter CSP breaks HTTP requests in WebKitGTK on Linux.
- App logo: `public/logo.png` (used in login page and elsewhere). All platform icons generated from this via `npx tauri icon public/logo.png`.
- **Audio engine (Rust/rodio)**: `audio_play` downloads the full track via reqwest, decodes with symphonia/rodio `Decoder`, appends to a `Sink`. A generation counter (`AtomicU64`) cancels in-flight downloads when the user skips. Progress is tracked via wall-clock (`seek_offset + elapsed`) clamped to `duration_secs` — **not** `sink.empty()` (unreliable in rodio 0.19). `audio:ended` fires after 2 consecutive ticks where `pos >= dur - 1.0s`. Tauri IPC parameter names are **camelCase** (`durationHint`, not `duration_hint`) — this is a hard-learned gotcha, do not revert.
- **Seek**: `playerStore.seek()` debounces by 100 ms, then calls `invoke('audio_seek', { seconds })`. The Rust side calls `sink.try_seek()` and updates `seek_offset` + `play_started`.
- **Cold-start resume**: `resume()` checks `isAudioPaused` flag. If true (warm resume), calls `audio_resume`. If false (cold start after restart), calls `audio_play` with saved URL then `audio_seek` to saved `currentTime`. Position preference: server queue position > 0 → use server; otherwise use localStorage value.
- **Drag-and-drop**: All drag sources use `dataTransfer.setData('text/plain', ...)` — WebView2 (Windows) does not support custom MIME types like `application/json`. Queue reordering calculates the **drop target index from `e.clientY`** at drop time (iterates `[data-queue-idx]` elements, picks the first whose midpoint is below the cursor). `fromIdx` comes from `dataTransfer` (set in `dragstart`, always reliable). `onDragEnd` clears refs synchronously. All drops are handled by the `<aside>` container — no `onDrop` on individual queue items.
- **Drag-and-drop cursor (Linux)**: WebKitGTK does not honour `dropEffect` for cursor display — the cursor may show as forbidden or no indicator depending on the compositor (KDE Plasma vs GNOME). DnD works correctly regardless. This is a known WebKitGTK limitation, not fixable from web content.
- **Fullscreen Player ("Ambient Stage")**: Single centered column — no tracklist. Background uses the artist's `largeImageUrl` from `getArtistInfo()` (falls back to cover art). Three CSS-animated color orbs (`--ctp-mauve`, `--ctp-blue`, `--ctp-lavender`) drift behind everything. Cover has a slow breathing animation (`cover-breathe` keyframe). Long song titles scroll as a marquee (`MarqueeTitle` component — measures overflow via `getBoundingClientRect` + `ResizeObserver`, animates via CSS custom property `--scroll-amount`). `Track.artistId` is populated from `SubsonicSong.artistId` (Navidrome returns this field) across all 18 track-construction sites.
- **Sidebar**: Fixed width via CSS `clamp(200px, 15vw, 220px)` — no drag-to-resize. Collapsed state (72px) persisted in `localStorage`. Update notification uses Tauri Shell plugin `open()` to launch the system browser — `<a target="_blank">` does not work inside a Tauri WebView.
- **Tracklist columns**: Order is `# | Title | [Artist (VA only)] | Favorite | Rating | Duration | Format`. Format column uses `120px` (NOT `auto` or `1fr`) — `auto` caused misalignment because header and track-row are independent grid containers: "FORMAT" header text is narrower than "MP3 · 320 kbps", so the `fr` title column calculated differently in header vs rows, shifting all subsequent columns. `1fr` fixed alignment but made the format column too wide. Fixed `120px` fits all codec strings (MP3/FLAC/OGG · kbps) and aligns perfectly. Total row uses explicit `grid-column` numbers (not negative indices).
- **AlbumDetail**: Thin orchestrator (`src/pages/AlbumDetail.tsx`) — state, handlers, `useCachedUrl` hook, renders `AlbumHeader` + `AlbumTrackList` + related albums section. Logic is split into the two extracted components.
- **Playlists page**: List layout (not card grid) with sort buttons (Name / Tracks / Duration, toggle asc/desc) and a filter input. Play icon and delete button appear on row hover.
- **Statistics page**: Library stat cards (Artists / Albums / Songs / Genres), Recently Played, Most Played, Highest Rated, Genre Chart. Data loaded in parallel via `Promise.allSettled`. No decade distribution (API caps byYear at 200 — all bars show "200+" which is useless).
- **Context menu**: `song` and `queue-item` types both have "Go to Album" (`Disc3` icon, shown only when `song.albumId` exists) and "Favorite" options. Context menu type union: `'song' | 'album' | 'artist' | 'queue-item' | 'album-song'`.
- **QueuePanel meta box**: Shows title (no link) → artist (linked to `/artist/:id`) → album (linked to `/album/:id`). Year display removed. Header shows song count + total duration below the queue title.
- **Queue hover**: Queue items use `.context-active` CSS class when their context menu is open, keeping the hover highlight visible.
- **Random Mix hover**: Row uses `.context-active` CSS class when a context menu is open for that song. `contextMenuSongId` state cleared via `useEffect` when `contextMenu.isOpen` becomes false.
- **Favorites songs**: Full tracklist layout matching AlbumDetail — `track-row-va` grid with `#`, Title, Artist, Duration columns and a header row. Artist name clickable → artist page. "Add all to queue" button (`btn btn-surface`) next to the section title sends all favorited songs to the queue.
- **Random Mix — Genre Filter**: `excludeAudiobooks` + `customGenreBlacklist` in `authStore` (persisted). Hardcoded `AUDIOBOOK_GENRES` list in `RandomMix.tsx` and `AUDIOBOOK_GENRES_DISPLAY` in `Settings.tsx` must be kept in sync. Filter checks `song.genre`, `song.title`, and `song.album`. Clickable genre chips in the tracklist let users add genres to the blacklist on the fly.
- **Random Mix — Super Genre Mix**: 9 super-genres defined in `SUPER_GENRES` constant. Server genres fetched via `getGenres()` on mount; `availableSuperGenres` filters to those with ≥1 keyword match. `loadGenreMix` uses progressive rendering — `setGenreMixSongs` updated after each genre request resolves. Genre list capped at 50 (randomly sampled) so total fetch stays near 50 songs — no over-fetching. `genreMixComplete` state gates the "Play All" button: button stays `btn-surface` with live `n / 50` counter while loading, switches to `btn-primary` only when all songs are ready.
- **RandomAlbums**: No auto-refresh timer — loads once on mount, manual refresh button only. `loadingRef` guards against concurrent fetches.
- **Queue shuffle**: `shuffleQueue()` in playerStore keeps current track at index 0, Fisher-Yates shuffles the rest.
- **Tooltip z-index**: `.main-content` has `z-index: 1` so tooltips in the content area render above the queue panel (which has no z-index but appears later in DOM order). Multi-line tooltips: add `data-tooltip-wrap` attribute + use `\n` in the string; CSS rule `[data-tooltip-wrap]::after { white-space: pre-line; max-width: 220px }`.
- **Version**: 1.4.4
