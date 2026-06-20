# What's New

User-facing release highlights for the in-app **What's New** screen. Maintainers refresh the
current line before promoting to `next` / `release`. Technical details and PR credits stay in
`CHANGELOG.md`.

Within each section, order by **user impact** (most noticeable first) — not PR merge order.
`CHANGELOG.md` keeps strict PR order inside Added / Changed / Fixed.


## [1.49.0]

## Highlights

### AutoDJ — minimum pauses, maximum music

- New **AutoDJ** mode — a smart crossfade that blends tracks intelligently. Each transition is shaped to fit the music: awkward gaps fade away, handovers feel natural, and you spend less time in silence between songs. It's now its own choice in **Settings → Audio** and its own button in the queue toolbar, sitting alongside Crossfade and Gapless — pick one at a time. Off by default; classic **Crossfade** is unchanged.

### Playlist folders — your playlists, organised

- Folders on the **Playlists** page and in the sidebar keep long lists tidy — group by mood, occasion, or anything you like. Drag playlists in, rename and collapse folders, or choose **Move to folder** from the right-click menu. Switch back to a flat list whenever you prefer.

### Theme store — spot updates, pick your style

- Version numbers on store themes and ones you have installed make it obvious when an update is ready.
- Filter for **animated** or **static** themes only — less scrolling when you already know the look you want.

### Settings — tidier and easier to scan

- Settings are grouped into clear, labelled panels so related options sit together — less hunting around. The **Native Hi-Res Playback** option now explains in plain language what it actually does.
- **Normalization** and **Track transitions** are now their own sections under **Settings → Audio**, and the queue options (display mode, toolbar, and Play-Next order) are gathered into one **Queue Settings** group under **Personalisation**.

### Japanese — now in your language

- Psysonic is now available in **Japanese (日本語)** — pick it from the language menu on the **Settings** and **Login** screens.

## Fixed

### Playback and audio

- **Opus/Ogg** tracks no longer fight the seekbar while they are still loading — scrub to where you want to be and keep listening.

### Player and playlists

- **Add to playlist** from the player bar adds the song you are hearing, not the whole album.

### Browse and library

- Albums sorted by artist now list each artist's work A–Z by title — no more random order within a name.
- **Artist → Year** keeps artists grouped but walks through their albums chronologically, oldest first.

### Windows

- **Windows:** Previous, Play/Pause, and Next are back when you hover the taskbar icon — and Play/Pause shows whether music is playing or paused.


## [1.48.1]

## Fixed

### Playback and audio

- Changing tracks — skipping, or the automatic advance at the end of a song — no longer freezes the interface for a few seconds: the progress bar and lyrics keep updating, and on **Windows** a change of output device now takes effect right away.
- Seeking an **Opus/Ogg** track — and then pressing **Stop** — no longer crashes the app.
- **macOS:** pausing or stopping playback and then unplugging headphones (or switching the output device) no longer makes playback restart — it stays paused or stopped.

### Offline, Now Playing, and Navidrome

- On large **Navidrome** libraries, background library sync no longer locks up database writes for minutes at a time, so play history, ratings, and other saves go through without long delays.

### Themes and integrations

- **Discord** Rich Presence shows the album cover again when a server profile has both a local and a public address.

### Other

- **Windows:** the system media controls (Quick Settings media tile, lock screen, and third-party flyouts) now show the album cover and display **Psysonic** with its icon instead of "Unknown application".
- **macOS:** closing the window with the red close button now respects **Minimize to Tray** — with it on, the window hides to the tray instead of quitting.



## [1.48.0]

## Highlights

### Offline listening

- When the server is unreachable, browse and detail pages show what you already have locally instead of empty errors — albums, artists, playlists, and cross-server favorites.
- Starred tracks, pinned albums, and playlists live under one **media** folder; browse them in **Offline Library** and see disk usage at a glance.
- **Favorites auto-sync** keeps loved songs on disk; pinned albums and playlists refresh when the library index updates.

### Music Network — scrobble beyond Last.fm

- **Settings → Integrations** now hosts a **Music Network**: connect **Last.fm**, **Libre.fm**, **ListenBrainz**, **Maloja**, **Rocksky**, **Koito**, or your own **GNU FM** instance — and scrobble to several at once.
- Pick a **primary** service for loved tracks, similar artists, and stats; other connections still receive scrobbles. Your existing Last.fm setup migrates automatically.
- A master switch turns the whole network on or off.

### Theme Store

- Browse and install community themes from **Settings → Themes** — search, dark/light filter, full-size previews, and sort by popularity or date.
- Six palettes ship with the app; everything else installs on demand and works offline after the first download.
- **Now Playing** follows every theme cleanly, including light palettes.
- Import a theme from a local `.zip` when you have a package from a friend or your own design.
- The sidebar nudges you when an installed theme has an update; one-click update from the theme card.

### Fullscreen player

- Rebuilt for much lower CPU and memory use: a calm, sharp fullscreen view with album art, waveform seekbar, up-next queue, synced lyrics, ratings, and a clock that follows your **Clock format** setting.
- The song title no longer shows a leading track number, and descenders (g, j, p, q, y) are no longer clipped.

### Live — richer now playing on Navidrome 0.62+

- On servers with OpenSubsonic **playbackReport** (Navidrome ≥ 0.62), **Live** shows who is playing or paused, how far into the track they are, and playback speed when another client sends it — with smooth position updates between refreshes.
- In **Who is listening?**, each listener shows a small status dot (playing, paused, or idle) instead of a vague “minutes ago” line.

### Queue — Timeline mode

- A third queue layout keeps the current track in the middle with history above and up next below — great for long listening sessions. Cycle the header control or pick it in **Settings → Personalisation → Queue display**.

### Settings → Servers

- Each card shows the server software and version (e.g. **Navidrome 0.62.0**) under the name, with a cleaner two-line layout and compact actions.
- Navidrome **0.62+** shows a green **AudioMuse-AI** badge when the plugin is detected — no manual toggle on current Navidrome.

### Sidebar — pin Now Playing to the top

- New **Settings → Sidebar** toggle moves **Now Playing** to the top of the sidebar instead of the bottom (off by default).

### Startup

- A themed loading splash appears while the app starts — colours follow your active theme, including community palettes.

## Improved

- Audio decoding runs on **Symphonia 0.6**; streams start sooner and recover from stalls without restarting the player.
- The **Preload Next Track** toggle under **Settings → Storage → Buffering** is gone — playback no longer waits on that extra RAM prefetch. Gapless, crossfade, and Hot Cache behave as before.
- New **Semitones** playback-speed strategy (±12 st, 0.1 step) with two-decimal speed readout; optional fine steps in **Settings → Audio → Advanced**.

## Fixed

### Playback and audio

- **Windows:** the app no longer keeps the audio device open while idle, so the system can sleep when music is not playing.
- **macOS:** steady playback stutter from background device polling is gone on the default output path.
- After a long pause, the seekbar shows the saved position immediately and the next **Play** resumes without an audible blip at track start.
- **Stop** keeps the real waveform on the seekbar instead of falling back to flat bars.

### Offline, Now Playing, and Navidrome

- Now Playing cards (**from this album**, discography, most played) stay populated during cached and offline playback instead of blanking out on track change.
- Navidrome **Show in Now Playing** and play-count scrobbles work when audio plays from hot cache, offline pins, or auto-synced favorites.
- Mixed-server queues still report to the correct Navidrome server.

### Themes and integrations

- Self-hosted Music Network targets (Koito, Maloja, custom GNU FM with a pasted token) scrobble again — reconnect once if you connected before this fix.
- Favoriting from the player bar, fullscreen player, or shortcuts updates the star in track lists and playlists immediately.
- Discord Rich Presence shows album art again when covers come from the server.
- Focus rings and dropdown borders follow the active theme consistently.

### Browse and library

- Tracks tagged with several genres in one field (e.g. `Metal/Ambient/Experimental`) match **each genre** again in browse, filters, and search.
- **All Albums → Only compilations** returns results for common tagging patterns.
- Album grids show the album artist on compilations instead of a random track artist.
- Song rails (**Random Picks**, **Discover Songs**, etc.) link each name in multi-artist credits separately.
- **Artist → Top Tracks** play works even when the artist page has no albums loaded yet.
- **Home → Most Played** no longer jumps the page when you load more albums.
- **Mainstage** hero backdrop stays in sync when you skip albums quickly.

### Other

- **Linux:** the `curl | bash` auto-installer works again.
- **Linux:** internet radio no longer appears twice in the desktop now-playing overlay.
- On Navidrome **0.62+**, add/edit/delete radio stations is shown only to admin accounts; everyone can still play and favourite stations.
- **Linux custom title bar:** pick window button styles (dots, flat, pill, and more) and optionally hide minimize in **Settings → Appearance**.
- The active server card under **Settings → Servers** draws a complete border on all sides.

## Under the hood

- Navidrome **0.62+** auto-detects **AudioMuse-AI** and routes Instant Mix / Lucky Mix through the smarter API when the plugin is present — older Navidrome keeps the manual toggle you already know.
