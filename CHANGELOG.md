# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] - 2026-03-21

### Added

#### Three New Themes
- **Neon Drift**: Deep midnight-blue background (`#12132c`) with electric cyan accent (`#00f2ff`) — subtle synthwave/cyberpunk aesthetic. Glowing player track name, cyan-glow nav active state, neon-lit primary buttons, glowing range slider thumb.
- **Cupertino Light**: macOS Ventura-inspired light theme. Clean white base, Apple-grey sidebar (`#f2f2f7`), Apple blue accent (`#0071e3`). Frosted-glass sidebar and player bar with `backdrop-filter: blur`. Solid blue pill nav active (white text, no left border).
- **Cupertino Dark**: macOS Ventura-inspired dark theme. Space Grey base (`#1e1e1f`), dark frosted sidebar, vibrant blue accent (`#007aff`). Same pill nav active as Cupertino Light. Solid blue Play/Pause button with glow.

#### New Theme Group: Betriebssysteme
- OS-aesthetic themes are now consolidated into one group: **Cupertino Light**, **Cupertino Dark**, **Aero Glass**, **Luna Teal**.
- **Psysonic Themes** and **Psysonic Themes — Mediaplayer** moved to the top of the theme picker.

#### Configurable Keybindings
- New `keybindingsStore` with 10 bindable actions: Play/Pause, Next, Previous, Volume Up/Down, Seek ±10 s, Toggle Queue, Fullscreen Player, Native Fullscreen.
- Rebind any action in **Settings → Keybindings** — click the key badge, press any key, saved immediately to `localStorage`.
- Defaults: `Space` = Play/Pause, `F11` = Native Fullscreen. All other actions unbound by default.

#### Font Picker
- 10 UI fonts selectable in **Settings → Appearance**: Inter, Outfit, DM Sans, Nunito, Rubik, Space Grotesk, Figtree, Manrope, Plus Jakarta Sans, Lexend.
- Persisted in `localStorage` (`psysonic_font`), applied via `data-font` attribute on `<html>`.

#### Home Page — Instant Play
- **Album cards**: "Details" button replaced with a **Play** button — clicking plays the album immediately with a smooth 700 ms fade-out of the current track.
- **Hero**: "Play Album" button now starts playback directly (with fade-out) instead of navigating to the album detail page.
- Fade-out implemented via `playAlbum.ts` utility: fades volume to 0 over 700 ms, restores volume in the store (no Rust side-effect) before handing off to `playTrack`.

#### Now Playing Page — Layout & Readability
- **3-column hero layout**: album cover + info (left, `flex: 1`) — EQ bars (centre, fixed width) — tag cloud (right, `flex: 1`). EQ bars are now truly centred regardless of content length on either side.
- **Background**: increased brightness from `0.25` to `0.55`, reduced overlay opacity from `0.55` to `0.38` — background art is now visible instead of near-black.
- **Text contrast**: track times, card links (artist/album), and section title opacity all increased for better readability on the blurred background.

### Changed

#### Theme Renames — Trademark-Safe Names
All media-player and OS-themed theme IDs and labels have been renamed to avoid potential trademark conflicts:

| Old Name | New Name |
|---|---|
| Classic Winamp | WnAmp |
| Musicmatch Jukebox | Navy Jukebox |
| WMP8 Classic | Cobalt Media |
| PowerDVD Classic | Onyx Cinema |
| Win7 Aero | Aero Glass |
| WinXP Luna | Luna Teal |

> **Note**: If you had one of these themes selected, your preference will reset to Mocha on first launch. Re-select your preferred theme in Settings.

### Fixed

- **Linux — ALSA underruns**: `PIPEWIRE_LATENCY` (`4096/48000` ≈ 85 ms) and `PULSE_LATENCY_MSEC` (`85`) are now set before audio stream creation, reducing the frequency of ALSA `snd_pcm_recover` underrun events on PipeWire systems. Existing user-set values are respected.

---

## [1.8.0] - 2026-03-21

### Added

#### Three New Themes
- **Poison**: Dark charcoal background (`#1a1a1a`) with phosphor green (`#1bd655`) accent — high-contrast, industrial aesthetic. LCD glow text-shadow on the now-playing track name.
- **Nucleo**: Warm brass/cream light theme inspired by vintage hi-fi equipment. Warm white cards, gold/amber accents, brushed-metal bevel buttons, and a warm LCD glow on the player track name. `color-scheme: light`.
- **Classic Winamp**: Cool gray-blue dark theme (`#2b2b3a`) channelling the classic Winamp 2.x skin. Yellow primary accent (`#d4cc46`), orange volume slider override (`--volume-accent: #de9b35`), Courier New monospace font with bright-green LCD glow for the track name.

#### Psychowave Theme — Major Overhaul
- Psychowave recoloured from loud neon pink/purple to a refined deep violet palette: background `#161428`, accent `#a06ae0`. All neon colours replaced with muted, tasteful variants. No longer marked as WIP.

#### ThemePicker Redesign
- Themes reorganised into semantic groups: **Catppuccin**, **Nord**, **Retro** (formerly Gruvbox), **Tokyo Night**, and a new **Psysonic Themes** section (Classic Winamp, Poison, Nucleo, Psychowave). The separate *Experimental* group is removed.
- "Gruvbox" renamed to **Retro**.

#### Image Lightbox
- Clicking the **album cover** on an Album Detail page or the **artist avatar** on an Artist Detail page opens a full-screen lightbox showing the high-resolution image (up to 2000 px). Click outside or press Escape to close.
- Both use a shared `CoverLightbox` component — consistent behaviour across the app.

#### Queue Toolbar — Complete Redesign
- The queue panel now has a **centred icon toolbar** with round buttons (border-radius 50%, solid accent fill when active):
  - **Shuffle** — Fisher-Yates shuffle, keeps current track at position 0
  - **Save** — save queue as playlist
  - **Load** — load a playlist into the queue
  - **Clear** — remove all tracks from the queue
  - **Gapless** (∞ icon) — toggle gapless playback on/off
  - **Crossfade** (≋ icon) — toggle crossfade on/off; when inactive, clicking enables crossfade *and* opens a popover slider
- **Crossfade popover**: a small overlay below the Crossfade button with a range slider (1–10 s) to configure the fade duration. Clicking the active Crossfade button disables crossfade and closes the popover. Closes on outside click.
- **Queue header**: title enlarged to 16 px/700, track count and total duration shown inline next to the title in accent colour. Close (×) button removed.
- **Tech info overlay**: codec and bitrate displayed as a frosted glass badge (`backdrop-filter: blur(4px)`) overlaid on the bottom edge of the cover art image.

#### French & Dutch Translations
- Full UI translation added for **French** (`fr`) and **Dutch** (`nl`) — all namespaces covered.
- Language selector in Settings now lists all four languages sorted alphabetically (Dutch, English, French, German).

#### Help Page — Layout & Content Update
- **2-column grid layout** for the accordion — makes better use of horizontal space on widescreen displays.
- New Q&A entry: **Crossfade & Gapless** (Playback section) — explains what each feature does, how to enable them, and their experimental status.
- Updated entries: Themes (reflects all 21 themes), Languages (4 languages), Scrobbling (direct Last.fm), System browser links, Linux distribution (no AppImage).

#### Settings — Experimental Labels
- Crossfade and Gapless toggles in Settings → Playback now show an **"Experimental"** badge next to their label.

### Fixed

- **Now Playing dropdown — refresh button**: The refresh icon spin was applied to the entire button, blocking clicks during the animation. Spin state is now separate from the background poll loading state — the button is always clickable, and the icon spins for a minimum of 600 ms for clear visual feedback.
- **Crossfade popover positioning**: Popover was overflowing the right edge of the viewport. Now right-aligned relative to the Crossfade button and positioned below it.

---

## [1.7.2] - 2026-03-20

### Fixed

- **Last.fm**: Stability improvements for the authentication flow and session handling.
- **Settings**: Minor display fixes in the Last.fm profile badge.

---

## [1.7.1] - 2026-03-20

### Fixed

- **Build**: TypeScript errors in Settings.tsx and Statistics.tsx that broke the release build.

---

## [1.7.0] - 2026-03-20

### Added

#### Last.fm Integration *(Beta)*
- **Direct Last.fm scrobbling**: Tracks are scrobbled directly via the Last.fm API at 50% playback — no longer routed through Navidrome. Configure in Settings → Server with your Last.fm username and password.
- **Now Playing updates**: Last.fm receives the currently playing track in real time.
- **Love / Unlove**: Heart button in the Now Playing page and player bar syncs the loved state with Last.fm instantly.
- **Last.fm profile badge** in Settings → Server: shows your scrobble count and member since year once connected.
- ⚠️ **This feature is in beta.** Session management and edge cases are still being refined.

#### Similar Artists
- Artist detail pages now show a **Similar Artists** section below Top Tracks, sourced from Last.fm and filtered to artists actually present in your library. Shown as chip buttons — click to navigate directly to that artist's page.
- Requires Last.fm to be configured. Hidden when Last.fm is not connected or no library matches are found.

#### Statistics — Last.fm Stats
- New **Last.fm Stats** section on the Statistics page (requires Last.fm): top artists, albums, and tracks with proportional play-count bars.
- **Period filter**: switch between Last 7 Days, 1 Month, 3 Months, 6 Months, 12 Months, and Overall.
- **Recent Scrobbles**: last 20 scrobbled tracks with relative timestamps and a "Now Playing" badge for the currently active entry.
- **Genre Distribution removed**: replaced by the Last.fm stats sections.

#### Psychowave Theme *(Work in Progress)*
- New **Psychowave** theme: a deep purple/violet dark theme inspired by synthwave and retrowave aesthetics.
- ⚠️ **Still in active development** — colors and details will continue to be refined in upcoming releases.

#### Tooltip System — TooltipPortal
- All tooltips now use a **React portal** rendered into `document.body` at `z-index: 99999`. Replaces the previous CSS `::after` pseudo-element system.
- Fixes tooltip clipping inside `overflow: hidden` containers (player bar, queue panel, EQ).
- Fixes black OS-native tooltip boxes that appeared on native `title=` attributes — all converted to `data-tooltip`.
- Smart edge detection: tooltip flips position automatically when it would overflow the viewport.

#### Custom Select Dropdowns
- **Theme**, **Language**, and **EQ preset** selectors are now rendered as styled portal dropdowns — no more unstyled native `<select>` boxes.
- Supports option groups (EQ: Built-in Presets / Custom Presets), keyboard navigation, and click-outside-to-close.

### Changed

#### Fullscreen Player / Now Playing — Background
- **Ken Burns animation improved**: background image now has significantly more movement (±8% translate, `inset: -30%`) with a 90-second cycle — more cinematic without being distracting.
- **Color orbs removed** from both the Fullscreen Player and the Now Playing page. They caused noticeable GPU load especially on integrated graphics.

### Fixed

- **Live dropdown (Now Playing)**: Own playback was no longer reported to Navidrome after the Last.fm implementation removed the `reportNowPlaying` call. Both are now called independently on track start.
- **Sidebar: Now Playing button position when collapsed**: The button was appearing in the middle of the nav instead of just above the System section. Caused by a leftover `margin-top: auto` on the Statistics link that split the remaining flex space.

---

## [1.6.0] - 2026-03-19

> ⚠️ **Wichtiger Hinweis / Important Notice**
>
> **DE:** Der Bundle-Identifier der App wurde von `dev.psysonic.app` auf `dev.psysonic.player` geändert. **Alle gespeicherten Einstellungen (Server-Profile, Theme, EQ, Sprache usw.) gehen beim Update auf diese Version einmalig verloren** und müssen neu eingetragen werden. Zukünftige Updates sind davon nicht betroffen.
>
> **EN:** The app's bundle identifier has changed from `dev.psysonic.app` to `dev.psysonic.player`. **All saved settings (server profiles, theme, EQ, language, etc.) will be reset once when updating to this version** and need to be re-entered. Future updates are not affected.

### Added

#### Replay Gain
- **Replay Gain support** in the Rust audio engine. Gain and peak values from the Subsonic API are applied per-track at playback time, keeping loudness consistent across your library.
- Two modes selectable in Settings → Playback: **Track** (default) and **Album** gain.
- Peak limiting applied to prevent clipping: effective gain is capped at `1 / peak`.
- Volume slider preserves the gain ratio — `audio_set_volume` multiplies `base_volume × replay_gain_linear`.

#### Crossfade
- **Crossfade between tracks** (0.5 – 12 s, configurable in Settings → Playback).
- Old sink is volume-ramped to zero in 30 steps while the new track starts playing; old sink stored in `fading_out_sink` so a subsequent skip cancels the fade-out immediately.
- `audio_set_crossfade` Tauri command; synced to Rust on startup and on toggle.

#### Gapless Preloading *(Experimental — Alpha)*
- **Gapless playback**: when ≤ 30 s remain in the current track, the next track's audio is preloaded via `audio_preload` in the background.
- `audio_play` checks the preload cache first — if there is a URL match the download is skipped entirely, eliminating the gap between tracks.
- The old Sink is kept alive during the new track's download and decode phase; the Sink swap happens atomically after decoding is complete, fixing a subtle **start-of-track audio cut** that occurred regardless of gapless state.
- ⚠️ **This feature is experimental and still in active development.** It may not work correctly in all scenarios. Enable it in Settings → Playback at your own discretion.

#### Settings — Tab Navigation
- Settings reorganised into **5 horizontal tabs**: Playback, Library, Appearance, Server, About.
- Each tab groups related settings with a matching icon.

#### Artist Pages — "Also Featured On"
- Artist detail pages now show an **"Also Featured On"** section listing albums where the artist appears as a guest or featured performer (but is not the primary album artist).
- Implemented via `search3` filtered by `song.artistId`, excluding the artist's own albums.

#### Download Folder Modal
- When no download folder is configured and the user initiates a download (album or track), a **folder picker modal** now appears asking where to save.
- Includes a "Remember this folder" checkbox that writes the choice to Settings.
- Clear button added in Settings → Server to reset the saved download folder.

#### Changelog in Settings
- The full **Changelog** is now readable inside the app under Settings → About.
- Rendered as collapsible version entries; the current version is expanded by default.
- Inline Markdown (`**bold**`, `*italic*`, `` `code` ``) is rendered natively.

#### EQ as Player Bar Popup
- The Equalizer is now accessible directly from the **player bar** via a small EQ button, opening as a centred popup overlay — no need to navigate to Settings.

### Fixed

- **Bundle identifier warning**: changed `identifier` from `dev.psysonic.app` to `dev.psysonic.player` to avoid the macOS `.app` extension conflict warned by Tauri.
- **Version mismatch in releases**: `tauri.conf.json` version was out of sync with `package.json` and `Cargo.toml`, causing GitHub Actions to build release artefacts with the wrong version number. All four version sources (`package.json`, `Cargo.toml`, `tauri.conf.json`, `packages/aur/PKGBUILD`) are now kept in sync.

### Known Issues

- **FLAC seeking**: jumping to a position in a FLAC file via the waveform seekbar currently does not work. Seeking in MP3, OGG, and other formats is unaffected.

---

## [1.5.0] - 2026-03-18

### Added

#### 10-Band Graphic Equalizer
- Full **10-band graphic EQ** implemented entirely in the Rust audio engine using biquad peak filters (31 Hz – 16 kHz). Gains adjustable ±12 dB per band.
- EQ is processed in the audio pipeline via `EqSource<S>` — a custom `rodio::Source` wrapper that applies cascaded biquad filters in real-time.
- Filter coefficients update smoothly on every 1024-sample block without audio interruption.
- **Seek support**: `EqSource::try_seek()` implemented — filter state is reset on seek to prevent clicks/artefacts. This also **fixes waveform seek**, which had silently broken when the EQ was introduced (rodio returned `SeekError::NotSupported` without the impl).
- **10 built-in presets**: Flat, Bass Boost, Treble Boost, Rock, Pop, Jazz, Classical, Electronic, Vocal, Acoustic.
- Custom presets: save, name, and delete your own presets.
- EQ state persisted via `psysonic-eq` localStorage key (gains, enabled, active preset, custom presets).
- New `audio_set_eq` Tauri command; settings synced to Rust on startup via `eqStore.syncToRust()`.

#### Connection Indicator
- **LED indicator** in the header bar (green = connected, red = disconnected, pulsing = checking). Sits between the search bar and the Now Playing dropdown.
- Shows server name and LAN/WAN status next to the LED.
- **Offline overlay**: when the server is unreachable, a full-content-area overlay appears with a retry button.
- `useConnectionStatus` hook pings the active server periodically and exposes `status`, `isRetrying`, `retry`, `isLan`, and `serverName`.

#### Now Playing Page
- New `/now-playing` route and `NowPlayingPage` component — accessible from the sidebar.

### Fixed

#### Waveform Seek (Player Bar)
- **Drag out of canvas no longer breaks seeking**: `mousemove` and `mouseup` events are now registered on `window` (not the canvas element), so dragging fast across other elements still updates playback position correctly.
- **Stale closure fix**: `trackId` and `seek` function are kept in refs so the window-level handlers always see the current values.

### Changed

#### App Icon
- New app icon (`public/logo-psysonic.png`) across all platforms — Login page, Sidebar, Settings About section, README header, and all generated Tauri platform icons (Windows ICO, macOS ICNS, Linux PNGs, Android, iOS).

## [1.4.5] - 2026-03-17

### Changed

#### Artist Pages — External Links
- Last.fm and Wikipedia buttons now open in the **system browser** instead of an in-app window. The button label temporarily changes to "Opened in browser" / "Im Browser geöffnet" for 2.5 seconds as visual confirmation.

#### Queue Panel
- **Release year** added to the now-playing meta box, shown below the album name (when available).
- **Cover art enlarged** from 72 × 72 px to 90 × 90 px, aligned to the top of the meta block so it lines up with the song title.
- **Default width increased** from 300 px to 340 px.

## [1.4.4] - 2026-03-17

### Added

#### AUR Package
- Psysonic is now available on the **Arch User Repository** — Arch and CachyOS users can install via `yay -S psysonic` or `paru -S psysonic`. Builds from source using the system's own WebKitGTK, avoiding the EGL/Mesa compatibility issues that affected the AppImage on modern distros.

### Changed

#### App Icon
- New app icon across all platforms (Windows, macOS, Linux, Android, iOS).

#### Linux Distribution
- **AppImage removed**: The AppImage was fundamentally incompatible with non-Ubuntu distros (Arch, Fedora) due to bundled WebKitGTK conflicting with the system's Mesa/EGL. Linux users should use the `.deb` (Ubuntu/Debian), `.rpm` (Fedora/RHEL), or the new AUR package (Arch/CachyOS).

## [1.4.3] - 2026-03-16

### Fixed

#### Random Mix — Genre Mix
- **Second "Play All" button removed**: The genre mix section had a redundant play button below the super-genre selector. The top-right button is now context-aware — it plays the genre mix when one is active, otherwise the regular mix.
- **"Play All" disabled during genre mix loading**: The button now stays grayed out with a live progress counter (`n / 50`) until all songs are fully loaded. Clicking while the list was still building sent only the songs loaded so far.
- **Over-fetching fixed**: Genre mix previously fetched up to 100+ songs and sliced to 50 at the end. Now the matched genre list is capped at 50 (randomly sampled when more match) so the total fetch stays close to 50 with no wasted server I/O.
- **Regular mix cache-busting**: `getRandomSongs` requests now include a timestamp parameter, preventing browser/axios from returning a cached response and showing the same list on every remix.
- **Display/state mismatch on remix**: Clicking "Mischen" now clears the current list immediately, ensuring the spinner is shown and the displayed songs always match what "Play All" would send.

#### Queue Panel
- **Hover highlight lost on right-click**: Queue items now retain their hover highlight while a context menu is open for them (`.context-active` CSS class).
- **Song count and total duration**: The queue header now shows the number of tracks and total runtime below the title (e.g. `12 tracks · 47:32`).

#### Context Menu
- **"Favorite" option added for queue items**: Right-clicking a queue item now includes a "Favorite" option, consistent with the song context menu.

## [1.4.2] - 2026-03-16

### Fixed

#### Linux AppImage — Modern Distro Compatibility
- **Build upgraded to Ubuntu 24.04**: The AppImage was previously built on Ubuntu 22.04 with WebKitGTK 2.36. On modern distros (CachyOS, Arch, etc.) with Mesa 25.x, `eglGetDisplay(EGL_DEFAULT_DISPLAY)` returns `EGL_BAD_PARAMETER` and aborts immediately because newer Mesa no longer accepts implicit platform detection. Building on Ubuntu 24.04 bundles WebKitGTK 2.44 which uses the correct `eglGetPlatformDisplay` API.
- **`EGL_PLATFORM=x11` added to AppRun**: Additional safeguard that explicitly tells Mesa's EGL loader to use the X11 platform when the app is running under XWayland.

#### Shell — Update Link
- `shell:allow-open` capability now includes a URL scope (`https://**`), fixing the update toast link that silently did nothing in Tauri v2 without an explicit allow-list.

## [1.4.1] - 2026-03-16

### Fixed

#### Random Albums — Performance & Memory
- **Auto-refresh removed**: The 30-second auto-cycle timer caused 10 React state updates/second (progress bar interval) and a burst of 30 concurrent image fetches on every tick, eventually making the whole app unresponsive. The page now loads once on mount; use the manual refresh button to get a new selection.
- **Concurrent fetch limit**: Image fetches are now capped at 5 simultaneous network requests (was unlimited — 30 at once on every refresh).
- **Object URL memory leak**: The in-memory image cache now caps at 150 entries and revokes old object URLs via `URL.revokeObjectURL()` when evicting. Previously, object URLs accumulated without bound across the entire session.
- **Dangling state updates**: `useCachedUrl` now uses a cancellation flag — if a component unmounts while a fetch is in flight (e.g. during a grid refresh), the resolved URL is discarded instead of calling `setState` on an unmounted component.

#### i18n
- Page title "Neueste" on the New Releases page was hardcoded German. Now uses `t('sidebar.newReleases')`.

## [1.4.0] - 2026-03-16

### Added

#### Statistics Page — Upgraded
- **Library overview**: Four stat cards at the top showing total Artists, Albums, Songs, and Genres — counts derived from the library in parallel.
- **Recently Played**: Horizontal scroll row showing the last played albums with cover art.
- **Most Played**: Ranked list of the most frequently played tracks.
- **Highest Rated**: List of top-rated tracks by user star rating.
- **Genre Chart**: Visual bar chart of the top genres by song and album count.

#### Playlists Page — Redesigned
- Replaced the card grid with a clean list layout.
- **Sort buttons**: Sort by Name, Tracks, or Duration — click again to toggle ascending/descending.
- **Filter input**: Live search across playlist names.
- Play and delete buttons appear on row hover.

#### Favorites — Songs Section Upgraded
- Tracks now display in a full tracklist layout matching Album Detail: separate `#`, Title, Artist, and Duration columns with a header row.
- Artist name is clickable and navigates to the artist page.
- Right-click context menu on any track (Go to Album, Add to Queue, etc.).
- **"Add all to queue"** button (`btn btn-surface`) next to the section title.

#### Context Menu — Go to Album
- New **Go to Album** option (`Disc3` icon) added for `song` and `queue-item` context menu types.
- Only shown when the song has a known `albumId`.

#### Queue Panel — Meta Box
- Now shows: **Title** (no link) → **Artist** (linked to artist page) → **Album** (linked to album page).
- Removed year display and the old title→album link.

#### Random Mix — Hover Persistence
- Track row stays highlighted while its context menu is open via `.context-active` CSS class.
- Highlight is cleared automatically when the context menu closes.

#### Artist Cards — Redesigned
- `ArtistCardLocal` now matches `AlbumCard` exactly: no padding, full-width square cover via `aspect-ratio: 1`, name and meta below.
- Uses `CachedImage` with `coverArtCacheKey` for proper IndexedDB caching.
- Same `flex: 0 0 clamp(140px, 15vw, 180px)` sizing as album cards — artist cards are no longer oversized.

### Fixed

#### Random Albums — Cover Loading & Manual Refresh
- **Removed `renderKey`**: The album grid was fully remounted on every refresh, restarting all 30 IndexedDB image lookups from scratch. Grid is now stable — only data changes, images stay cached.
- **`loadingRef` guard**: Prevents concurrent fetch calls if the auto-cycle timer fires during a manual refresh.
- **Timer race condition**: Manual refresh now calls `clearTimers()` before `load()`, eliminating the race where the auto-cycle timer fired mid-load.

#### Favorites — Artist Navigation
- Arrow nav buttons in the Artists section now use the same CSS classes as the Albums section (`album-row-section`, `album-row-header`, `album-row-nav`) — consistent styling across both rows.

### Changed
- **AlbumDetail** refactored into a thin orchestrator. Logic extracted into `AlbumHeader` (`src/components/AlbumHeader.tsx`) and `AlbumTrackList` (`src/components/AlbumTrackList.tsx`).
- **German i18n**: "Queue" consistently translated as "Warteschlange" throughout — `queue.shuffle`, `favorites.enqueueAll`.

## [1.3.0] - 2026-03-15

### Added

#### Player Bar — Complete Redesign
- **Waveform seekbar**: Replaces the classic thin slider. A canvas-based waveform with 500 deterministic bars (seeded by `trackId`) fills the full available width. Played portion renders as a blue → mauve gradient with a soft glow; buffered range is slightly brighter; unplayed bars are dimmed to 28% opacity. Click or drag anywhere to seek.
- **New layout**: Single flex row — `[Cover + Track Info] [Transport Controls] [Waveform + Times] [Volume]`. More breathing room for the waveform; controls feel lighter and better proportioned.
- **Queue toggle relocated**: Moved from the bottom player bar to the top-right of the content header — consistent with the sidebar collapse button pattern. Uses `PanelRightClose` / `PanelRight` icons (same family as `PanelLeftClose` / `PanelLeft` in the sidebar).

#### Ambient Stage — MilkDrop Visualizer
- **Butterchurn integration**: Clicking the waveform icon (top-right of the fullscreen player) activates the MilkDrop visualizer powered by [butterchurn](https://github.com/jberg/butterchurn) + `butterchurn-presets`.
- A hidden `<audio>` element is routed through the Web Audio API `AnalyserNode` (not connected to `AudioDestinationNode` — completely silent). The Rust/rodio engine continues to handle actual audio output.
- Starts with a random preset; the shuffle button cycles through all available presets with a 2-second blend transition. Current preset name is shown in the top bar.
- When the visualizer is active, the blurred background, orbs, and overlay are replaced by the canvas.

#### Tracklist — Animated Equalizer Indicator
- The currently **playing** track shows three animated equalizer bars (CSS `scaleY` keyframe animation, staggered timing) instead of a static play icon.
- When **paused**, the static play icon is shown.
- Hovering any other track still shows a play icon.
- Track row alignment fixed: `align-items: center` on the grid row + `.track-num` as flex center — icons and track numbers are now perfectly vertically aligned with the song title.

#### Artist Pages — In-App Browser
- Last.fm and Wikipedia buttons now open a native **Tauri `WebviewWindow`** (1100 × 780, centered) instead of the system browser. Both sites load fully within the app and can be closed independently.
- Required new capabilities: `core:window:allow-create`, `core:webview:allow-create-webview-window`.

#### Update Checker
- Update check now runs **every 10 minutes** during runtime in addition to the initial check 1.5 s after launch.
- Version label in the update toast no longer includes a `v` prefix (shows `1.3.0` instead of `v1.3.0`).

#### Help Page
- New **Random Mix** section: explains the random mix, keyword filter, and super genre mix.
- Updated **Playback** section: waveform seekbar, MilkDrop visualizer, queue shuffle.
- Updated **Library** section: in-app browser for artist links.
- Updated queue entry to reflect the new toggle location.
- **Accordion styling**: open question and answer share a continuous 3 px accent stripe on the left; answer background uses `--bg-app` for clear contrast against the question's `--bg-card`.

### Fixed
- **Version in Settings** was hardcoded to `1.0.12`. Now imported from `package.json` at build time — same source as the sidebar update checker.
- **Hero / Discover duplicate albums**: Both sections previously fetched `random` independently, often showing the same albums. Now a single request fetches 20; `slice(0, 8)` goes to the Hero carousel and `slice(8)` to the Discover row.
- **Active track pulse too aggressive**: Changed from a `background: transparent` flash to a gentle `opacity: 0.6` fade over 3 s — significantly less distracting.

### Changed
- **Blacklist → Keyword Filter**: Renamed throughout UI and i18n (EN + DE) to better reflect that the filter matches genre, title, and album fields — not just genre tags.

## [1.2.0] - 2026-03-15

### Added

#### Rust Audio Engine (replaces Howler.js)
- **New native audio backend** built in Rust using [rodio](https://github.com/RustAudio/rodio). Audio is now decoded and played entirely in the Tauri backend — no more reliance on the WebView's `<audio>` element or GStreamer pipeline quirks.
- Tauri commands: `audio_play`, `audio_pause`, `audio_resume`, `audio_stop`, `audio_seek`, `audio_set_volume`.
- Frontend events: `audio:playing` (with duration), `audio:progress` (every 500 ms), `audio:ended`, `audio:error`.
- Generation counter (`AtomicU64`) ensures stale downloads from skipped tracks are cancelled immediately and do not emit events.
- Wall-clock position tracking (`seek_offset + elapsed`) instead of `sink.empty()` (unreliable in rodio 0.19 for VBR MP3). `audio:ended` fires after two consecutive ticks within 1 second of the track end — avoids false positives near the end without adding latency.
- Seek via `sink.try_seek()` — no pause/play cycle, no spurious `ended` events.
- Volume clamped to `[0.0, 1.0]` on every call.

#### Playback Persistence & Cold-Start Resume
- `currentTrack`, `queue`, `queueIndex`, and `currentTime` are now persisted to `localStorage` via Zustand `partialize`.
- On app restart with a previously loaded track, clicking Play resumes from the saved position without losing the queue.
- Position priority: server play queue position (if > 0) takes precedence over the locally saved value, so cross-device resume works correctly.

#### Random Mix — Genre Filter & Blacklist
- **Exclude audiobooks & radio plays** toggle: filters out songs whose genre, title, or album match a hardcoded list (`Hörbuch`, `Hörspiel`, `Audiobook`, `Spoken Word`, `Podcast`, `Krimi`, `Thriller`, `Speech`, `Fantasy`, `Comedy`, `Literature`, and more).
- **Custom genre blacklist**: add any genre keyword via the collapsible chip panel on the Random Mix page or in Settings → Random Mix. Persisted across sessions.
- **Clickable genre chips** in the tracklist: clicking an unblocked genre tag adds it to the blacklist instantly with 1.5 s visual feedback. Blocked genres are shown in red.
- Blacklist filter checks `song.genre`, `song.title`, and `song.album` to catch mislabelled tracks.

#### Random Mix — Super Genre Mix
- Nine pre-defined **Super Genres** (Metal, Rock, Pop, Electronic, Jazz, Classical, Hip-Hop, Country, World) appear as buttons, auto-generated from the server's genre list — only genres with at least one matching keyword are shown.
- Selecting a Super Genre fetches up to 50 songs distributed across all matched sub-genres in parallel, then shuffles the result.
- **Progressive rendering**: the tracklist appears as soon as the first genre request returns — users with large Metal/Rock libraries no longer stare at a spinner for the entire fetch. A small inline spinner next to the title indicates that more genres are still loading.
- **"Load 10 more"** button: fetches 10 additional songs from the same matched genres and appends them to the play queue.
- Random playlist is automatically hidden while a Genre Mix is active.
- Fetch timeout raised to **45 seconds** per genre request (was 15 s) and `Promise.allSettled` used so a single slow/failing genre does not abort the entire mix.

#### Queue Panel
- **Shuffle button** in the queue header: Fisher-Yates shuffles all queued tracks while keeping the currently playing track at position 0. Button is disabled when the queue has fewer than 2 entries.

#### UI / UX
- **LiveSearch keyboard navigation**: arrow keys navigate the dropdown, Enter selects the highlighted item or navigates to the full search results page, Escape closes the dropdown.
- **Multi-line tooltip support**: add `data-tooltip-wrap` attribute to any element with `data-tooltip` to enable line-wrapping (uses `white-space: pre-line` + `\n` in the string). Respects a 220 px max-width.
- **Genre column info icon** in Random Mix tracklist header: hover tooltip explains the clickable-genre-to-blacklist feature.
- **Update link** in the sidebar now uses Tauri Shell plugin `open()` to launch the system browser correctly — `<a target="_blank">` has no effect inside a Tauri WebView.

### Fixed
- **Songs skipping immediately** (root cause: Tauri v2 IPC maps Rust `snake_case` parameters to **camelCase** on the JS side — `duration_hint` must be `durationHint`). All `invoke()` calls updated.
- **Play button doing nothing after restart**: `currentTrack` was `null` after restart (not persisted). Fixed by adding it to `partialize`.
- **Position not restored after restart**: `initializeFromServerQueue` overwrote the local saved position with the server value even when the server reported 0. Now falls back to the localStorage value when the server position is 0.
- **Genre Mix blank on Metal/Rock**: a single timed-out genre request caused `Promise.all` to reject the entire mix. Replaced with `Promise.allSettled` + 45 s timeout; partial results are shown immediately.
- **Tooltip z-index**: tooltips in the main content area were rendered behind the queue panel. Fixed by giving `.main-content` `z-index: 1`, establishing a stacking context above the queue (which sits later in DOM order).
- **Sidebar title clipping**: "Psysonic" brand text was truncated at narrow viewport widths. Minimum sidebar width raised from 180 px to 200 px.

### Changed
- **Audio architecture**: Howler.js removed. All audio state (`isPlaying`, `isAudioPaused`, `currentTime`, `duration`) is now driven by Tauri events from the Rust engine rather than Howler callbacks.
- **Random Mix layout**: Filter/blacklist panel and Genre Mix buttons are now combined in a two-column card at the top of the page instead of being scattered across the page.
- **Hardcoded genre blacklist** extended with: `Fantasy`, `Comedy`, `Literature`.
- **`getRandomSongs`** now accepts an optional `timeout` parameter (default 15 s) so callers can pass a longer value for large-library scenarios.

## [1.0.12] - 2026-03-14

### Fixed
- **Seek Stop Bug**: Clicking the progress bar a second time no longer stops playback. Root cause: WebKit and GStreamer fire spurious `ended` events immediately after a direct `audioNode.currentTime` seek. A guard now checks `lastSeekAt` + playhead position to silently discard these false alarms.
- **Play/Pause Hang**: Rapidly double-clicking the play/pause button no longer freezes the audio pipeline. A 300 ms lock prevents a second toggle from issuing `pause→play` before GStreamer has finished the previous state transition.
- **Queue DnD (macOS / Windows)**: Drop target index is now calculated from the mouse `clientY` position at drop time instead of refs, eliminating the `dragend`-before-`drop` timing race on macOS WKWebView and Windows WebView2.

### Added
- **Live Now Playing navigation**: Clicking an entry in the Live dropdown now navigates to the corresponding album page.

### Changed
- **Hero blur**: Increased background blur in the Hero section for a more immersive look.

## [1.0.11] - 2026-03-14

### Added
- **Search Results Page**: Pressing Enter in the search bar now navigates to a dedicated full search results page showing artists, albums, and songs with proper column layout and headers.

### Fixed
- **Search Results Column Alignment**: Artist and album columns in the search results song list are now correctly aligned with their column headers.
- **Search Results Header Alignment**: Fixed column header labels not aligning with song row content (root cause: `auto`-width Format column was sized independently per grid row).

### Changed
- **Gapless Playback removed**: Removed the experimental gapless playback feature. It caused intermittent song skipping and beginning cutoffs and was not reliable enough to ship. Standard sequential playback is used instead.

### Known Issues
- ~~**Seeking**: Seeking may occasionally be unreliable, particularly on Linux/GStreamer.~~ Fixed in 1.0.12.
- ~~**Queue drag & drop (macOS / Windows)**: Queue reordering via drag & drop may not always work correctly on macOS and Windows.~~ Fixed in 1.0.12.

## [1.0.10] - 2026-03-14

### Added
- **Active Track Highlighting**: The currently playing song is highlighted in album tracklists with a subtle pulsing accent background and a play icon — persists when navigating away and returning.
- **Marquee Title in Fullscreen Player**: Long song titles now scroll smoothly as a marquee instead of being cut off.
- **Clickable Artist / Album in Player Bar**: Clicking the artist name navigates to the artist page; clicking the song title navigates to the album page. Same behaviour in the Queue panel's now-playing strip.
- **Linux App Menu Category**: Application now appears under **Multimedia** in desktop application menus (GNOME, KDE, etc.) instead of "Other".
- **Windows MSI Upgrade Support**: Added stable `upgradeCode` GUID so the MSI installer recognises previous versions and upgrades in-place without requiring manual uninstallation first.

### Fixed
- **Drag & Drop (macOS / Windows)**: Queue reordering now works correctly on macOS WKWebView and Windows WebView2. The previous fix cleared index refs synchronously in `onDragEnd`, which fires before `drop` on both platforms — refs are now cleared with a short delay so `onDropQueue` can read the correct source and destination indices.
- **Settings Dropdowns**: Language and theme selects now have a clearly visible border (was invisible against the card background).
- **Tracklist Format Column**: Removed file size and kHz from the format column — codec and bitrate only. Column moved to the far right, after duration. Width is now dynamic (`auto`).
- **`tauri.conf.json`**: Fixed invalid placement of `shortDescription`/`longDescription` (were incorrectly nested under `bundle.linux`, now at `bundle` level). Removed invalid `nsis.allowDowngrades` field.

### Changed
- **Favorites Icon**: Replaced the incorrect fork icon with a star icon in the Random Mix page, consistent with all other pages.
- **Sidebar**: Removed drag-to-resize handle. Width now adapts dynamically to the viewport via `clamp(180px, 15vw, 220px)`.
- **About Section**: Added "Developed with the support of Claude Code by Anthropic" credit. Fixed "weiterzugeben" wording in German MIT licence text.
- **Minimize to Tray**: Now disabled by default.

## [1.0.9] - 2026-03-13

### Added
- **Gapless Playback**: The next track's audio pipeline is silently pre-warmed before the current track ends, eliminating the gap between songs — especially noticeable on live albums and concept records.
- **Pre-caching**: Prefetched Howl instances are now actually reused for playback, giving near-instant track transitions instead of a new HTTP connection each time.
- **Buffered Progress Indicator**: The seek bar now shows a secondary fill indicating how much of the current track has been buffered by the browser — visible in both the Player Bar and Fullscreen Player.
- **Resume on Startup**: Pressing Play after launching the app now resumes the last track at the saved playback position instead of doing nothing.
- **Album Track Hover Play Button**: Hovering over a track number in Album Detail reveals a play button for quick single-click playback.
- **Ken Burns Background**: The Fullscreen Player background now slowly drifts and zooms (Ken Burns effect) for a more cinematic feel.
- **F11 Fullscreen**: Toggle native borderless fullscreen with F11.
- **Compact Queue Now-Playing**: The current track block in the Queue Panel is now a slim horizontal strip (72 px thumbnail) instead of a full-width cover, freeing up significantly more space for the queue list on smaller screens.

### Fixed
- **GStreamer Seek Stability**: Implemented a three-layer recovery system for Linux/GStreamer seek hangs: (1) seek queuing to prevent overlapping GStreamer seeks, (2) a 2-second watchdog that triggers automatic recovery if a seek never completes, (3) an 8-second hang detector that silently recreates the audio pipeline and resumes from the last known position if playback freezes entirely.
- **Fullscreen Player**: Removed drop shadow from cover art — looks cleaner on lighter artist backgrounds.

### Changed
- **Hero Section**: Increased height (300 → 360 px) and cover art size (180 → 220 px) to prevent long album titles from clipping.
- **Player Bar**: Controls and progress bar moved closer together for a more balanced layout.

## [1.0.8] - 2026-03-13

### Added
- **Ambient Stage**: Completely redesigned Fullscreen Player. Experience an immersive atmosphere with drifting color orbs, a "breathing" cover animation, and high-resolution artist backgrounds.
- **Improved Drag & Drop**: Rewritten Play Queue reordering for rock-solid reliability on macOS (WKWebView) and Windows (WebView2).

### Fixed
- **Linux Audio Stability**: Resolved playback stuttering when seeking under GStreamer by implementing a robust pause-seek-play sequence.
- **Data Integration**: Standardized `artistId` propagation across all track sources for better metadata consistency.

## [1.0.7] - 2026-03-13

### Added
- **Update Notifications**: Integrated a native update check system in the sidebar that notifies you when a new version is available on GitHub.
- **Improved Settings**: Refined layout and styling for a cleaner settings experience.

### Fixed
- **UI/UX Refinements**: Polished sidebar animations and layout for better visual consistency.
- **i18n**: Added missing translations for update notifications and system status.

## [1.0.6] - 2026-03-13

### Added
- **Extended Themes**: Selection expanded to 8 themes, including the complete Nord series (Nord, Snowstorm, Frost, Aurora).
- **Light Theme Support**: Enhanced readability for Hero and Fullscreen Player components when using light themes (Latte, Snowstorm).

### Fixed
- **Linux/Wayland Compatibility**: Fixed immediate crash on Wayland environments by forcing X11 backend for the AppImage.
- **Playback Stability**: Introduced seek debouncing to prevent audio stalls on Linux/GStreamer.
- **Windows Integration**: Improved drag-and-drop compatibility for systems using WebView2.

## [1.0.5] - 2026-03-12

### Added
- **Image Caching**: Integrated IndexedDB-based image caching for cover art and artist images, providing significantly faster loading times for frequently accessed items.
- **Improved Artist Discovery**: Faster scrolling in the Artists list using color-coded initial-based avatars for quick visual identification.
- **Random Albums**: New discovery page for exploring your library with random album selections.
- **Help & Documentation**: Added a dedicated help page for better user onboarding.

### Changed
- **Optimized UI**: Instant "Now Playing" status updates via local state filtering for a more responsive experience.
- **Enhanced Data Flow**: General performance improvements in server communication and state management.

## [1.0.4] - 2026-03-12

### Added
- **Album Downloads**: Support for downloading entire albums with real-time progress tracking.

### Fixed
- **Linux GPU Compatibility**: Patched AppImage to disable DMABUF renderer, fixing EGL/GPU crashes on older hardware.
- **CI/CD Reliability**: Optimized release workflow with split jobs for better stability across platforms.

## [1.0.3] - 2026-03-12

### Fixed
- **CI/CD Build**: Resolved build conflicts on Ubuntu 22.04 by removing redundant dev packages (`libunwind-dev`, gstreamer dev).
- **Linux AppImage**: Configured GStreamer bundling and verified runtime environment settings.

## [1.0.2] - 2026-03-11

### Fixed
- **Linux AppImage**: Integrated GStreamer bundling fix in CI/CD workflow.
- **CI/CD Reliability**: Set `APPIMAGE_EXTRACT_AND_RUN=1` to prevent FUSE-related issues.

## [1.0.1] - 2026-03-11

### Fixed
- **Optimized Codebase**: Integrated core fixes and performance improvements.
- **Improved Multi-Server Support**: Fixed edge cases in server switching and credential management.
- **Enhanced Security**: Switched to `crypto.getRandomValues()` for more robust auth salt generation.
- **Connection Reliability**: Added pre-verification for server connections to prevent state synchronization issues.
- **Linux Compatibility**: Applied workarounds for WebKitGTK compositing issues on Linux.

### Changed
- Repository maintenance and preparation for the 1.0.1 release.

## [1.0.0] - 2026-03-09

### Added
- **Initial Public Release**: The first stable release of Psysonic.
- **Subsonic/Navidrome API**: Full integration for browsing library, artists, albums, and playlists.
- **Audio Playback**: Modern audio engine powered by Howler.js with support for various codecs.
- **Queue Management**: Persistent play queue with drag-and-drop reordering and server-side synchronization.
- **Secured Credentials**: Industry-standard security using Tauri's encrypted store for authentication tokens.
- **Design System**: Premium aesthetics based on the Catppuccin palette (Mocha & Latte themes).
- **Multi-Language**: Full localization support for English and German.
- **Fullscreen Mode**: Dedicated immersive player view with high-res album art.
- **Last.fm Scrobbling**: Built-in support for track scrobbling to Last.fm via Navidrome.
- **System Integration**: Native tray icon support, minimize-to-tray, and global media key handling.
- **Intelligent Networking**: Automatic or manual switching between LAN (Local) and External (Internet) addresses.
- **Live Now Playing**: Real-time view of what other users or players are streaming on your server.
- **Search**: Fast, real-time search for songs, albums, and artists.

### Security
- **Hardened Sandbox**: Restricted filesystem permissions to only necessary download/cache directories.
- **API Lockdown**: Disabled global Tauri objects to mitigate XSS risks.
- **Credential Storage**: Replaced insecure `localStorage` with a native encrypted store.

### Fixed
- Fixed a memory leak in the track prefetching engine.
- Improved Error handling for unstable Subsonic server responses.
