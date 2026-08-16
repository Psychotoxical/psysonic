# What's New

User-facing release highlights for the in-app **What's New** screen. Maintainers refresh the
current line before promoting to `next` / `release`. Technical details and PR credits stay in
`CHANGELOG.md`.

Within each section, order by **user impact** (most noticeable first) — not PR merge order.
`CHANGELOG.md` keeps strict PR order inside Added / Changed / Fixed.


## [1.51.0]

## Highlights

### Simultaneous multi-server support

- Psysonic works with several music servers simultaneously — not by switching between them, but by bringing them together in one live library. Select music folders from every configured server in one priority-ordered scope.
- **Home, Albums, Artists, Composers, Genres, Favourites, Playlists, Folder Browser, Search, Most Played, Statistics**, and detail pages browse all selected servers as one catalogue.
- Matching tracks, albums, and artists are de-duplicated without losing their physical sources, so artwork, playback, metadata, favourites, ratings, playlists, sharing, offline pins, device sync, and Orbit still reach the correct server.
- Each server now syncs and reports reachability independently. An unavailable or still-indexing server no longer blocks the rest of the selected library.

### Streaming quality — per-address Navidrome profiles

- Saved Navidrome addresses can request the original stream or a **320–64 kbps** ceiling, with **Auto, MP3, Opus**, or **AAC** as the target format. LAN and public addresses can keep different profiles.
- Offline pins, synced favourites, and Hot Cache still preserve original files. Analysis remains anchored to the original fingerprint, so transcoded playback does not fragment one track into several identities.
- The quality badge in the queue, Now Playing, mobile player, and immersive fullscreen now shows the format Psysonic actually decoded, with the original format available in a tooltip.

### Audio visualizer — spectrum, scopes, and fullscreen views

- **Now Playing** and every fullscreen-player style can show a spectrum, oscilloscope, radial scope, or stereo field using cover-derived or theme colours, with an expanded window view.
- Configure sensitivity, response, frame rate, and peak markers under **Settings → Appearance → Visualizer**. Separate switches let you enable it for Now Playing, fullscreen, or both.
- Internet radio is supported while its equalizer audio graph is active.
- Narrow bass bands now move smoothly instead of forming flat plateaus, while their frequency positions remain accurate at standard and Hi-Res sample rates.

### Themes — local assets and easier discovery

- Themes can bundle local images and fonts for richer designs while remaining fully offline. Theme Store installs and imported `.zip` themes both support them.
- The store suggests a random theme from deeper in the catalogue and lets you pick another, making older themes easier to discover.
- Themes that require a newer Psysonic clearly say so instead of failing during installation or update.

### Artist credits — every artist is within reach

- Artist names are clickable in all fullscreen styles, the detached mini player, and the mobile layout.
- Joined credits such as “Primary feat. Guest” are separated into individual artist links across album headers and track lists, while names such as AC/DC stay intact.
- Artist pages again separate the main discography from **Also featured on**, group releases by type, and show biographies, Last.fm links, and compilations under the correct artist.

### Album details — artwork and ordering for every disc

- Multi-disc albums show each disc's own cover beside **CD N** when the server provides distinct artwork. The queue, mini-cover, and listener view use the same per-disc art on Navidrome.
- Playing a multi-disc album from its header now queues disc 1 in full before disc 2 instead of interleaving tracks by track number.

### Random Mix — combine several genres

- Select several genre chips to build one balanced random playlist instead of replacing the previous selection. Duplicate tracks are removed before playback.
- Selected genres remain visible while you browse another set of popular genres, and rapid changes keep only the newest mix.

### Timeline — replay from any point in listening history

- Right-click a past Timeline track and choose **Play from Here** to replay that occurrence, every later history entry, and the existing **Up Next** list in their original order, including mixed-server ownership.

### Audio controls — fade smoothly when pausing and resuming

- **Settings → Audio → Track transitions** can fade playback out before pausing and back in when resuming, with a configurable **0.1–2.0 second** duration. Rapid pause, resume, and stop actions cancel stale fades safely.

### Fullscreen player — volume everywhere

- **Minimal** and **Immersive** now include the same mute button and always-visible volume slider already available in **Prism**.

## Improved

- Large libraries do less repeated work while Home, Albums, Artists, New Releases, Lossless Albums, and Search mount, paginate, or restore. Useful content appears before non-visible enrichment and cover prefetching.
- Waveform, loudness, and enrichment reuse audio already loaded for playback, preload, cache, and local files instead of downloading the original again. Background analysis stays bounded while active playback takes priority.
- Back from an album opened through an artist or related release now returns to the page you just left, and a second Back restores the original browse page and state.
- **Highly Rated** reshuffles within each rating tier when rerolled instead of returning the same fixed selection.
- The dead **YouLyPlus** lyrics source has been removed. If it was your only enabled source, **LRCLIB** is switched on automatically; embedded and Navidrome word-by-word lyrics are unaffected.

## Fixed

### Playback and audio

- Gapless MP3 albums no longer insert encoder silence between tracks when the files provide standard delay and padding information.
- Surround tracks played through stereo speakers or headphones now mix every channel into the two you hear instead of dropping the centre, bass, and rear channels. Devices that support surround keep the original channel layout.
- **Linux:** playback remains smooth under heavy CPU load, and ALSA or PipeWire sample-rate negotiation no longer causes half-speed, double-speed, or pitch-shifted audio. Hi-Res and gapless playback advance the queue reliably.
- **Linux:** volume changes through desktop media controls now stay in sync with Psysonic in both directions.
- AIFF, AIF, and AIFC tracks now play from servers, local files, and caches, including servers without byte-range support.
- Resuming after a long pause no longer lets Now Playing run several tracks ahead of the audio.
- Adding a track to a queue you cleared now mounts and starts the first track immediately.

### Offline, Now Playing, and Navidrome

- Hot Cache prefetches every mixed-server queue item from its owning server and protects the current and next tracks without confusing identical IDs from another server.
- Albums and tracks deleted on the server retire from the local library reliably, while incomplete server responses no longer erase valid indexed data.
- Removing a server profile stops its background sync and clears its local library state when requested; shared profiles keep the common index.
- Freshly prepared offline tracks keep the correct sync time instead of appearing to date from 1970.

### Themes and integrations

- Orbit invites recognise server addresses with or without an entered protocol and match a configured second address, so valid guests are no longer refused.
- Music Network reports a clearer message when a VPN, proxy, captive portal, or service webpage blocks a scrobbling connection.

### Browse and library

- **New Releases** loads continuously on large libraries without the long pause or window lock-up, and duplicate physical copies no longer reappear in the freshness overlay.
- The **Artists** page no longer remains on an endless spinner for large selected libraries.
- Genre pages show accurate de-duplicated album counts for the full selected scope and load their first indexed page substantially faster.
- New Releases and Lossless Albums continue loading while you remain at the bottom instead of stalling after a few pages.
- Artist and compilation pages keep **Various Artists**, guest appearances, release groups, biographies, similar artists, and album-artist links attached to the right owner.
- The **Composers** letter bar includes **Other**, so names beginning with punctuation or non-Latin characters can be found again.

### Other

- The startup splash stays visible until initial content is ready, and startup window controls, close, tray Exit, mini-player restore, and second-instance focus actions are no longer lost during startup or reload.
- Internet radio keeps UTF-8 track titles readable, preserves station homepage URLs after editing, and no longer blanks packaged Linux builds.
- **Linux:** MangoWM is recognised as a tiling window manager; AppImage manager installs resolve the bundled icon correctly.
- Device-sync migration refuses paths that would escape the folder you selected and clearly reports a drive that disappears mid-migration.
- Psysonic has a refreshed app icon.
- Secondary buttons have visible outlines before hover, compact form actions stay aligned, and genre-page controls have clearer labels and spacing.

## Under the hood

- The local library index now keeps server ownership, music-folder scope, and cross-server identity separately, allowing combined catalogues without repeatedly merging full server responses in the UI.
- Interrupted large syncs resume through a durable invalidation journal, and affected databases repair stale query-planner statistics instead of entering a long CPU-heavy rebuild after restart.
