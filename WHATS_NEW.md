# What's New

User-facing release highlights for the in-app **What's New** screen. Maintainers refresh the
current line before promoting to `next` / `release`. Technical details and PR credits stay in
`CHANGELOG.md`.

Within each section, order by **user impact** (most noticeable first) — not PR merge order.
`CHANGELOG.md` keeps strict PR order inside Added / Changed / Fixed.


## [1.49.0]

## Highlights

### Play queue sync — pick up where you left off on another device

- Click the header connection indicator to **pull** the active server's play queue when it differs from yours; a yellow LED shows when browse and playback servers do not match.
- While paused or stopped, **idle auto-pull** checks every 10 seconds and applies server changes when you have been still for 30+ seconds.
- Queue **push** sends only tracks owned by the playback server, so mixed-server queues stay sane when you switch servers.
- Local queue edits while paused are no longer overwritten by auto-pull; pressing **Play** pushes your changes immediately, and the sync LED no longer flashes on every track during normal playback.

### AutoDJ — minimum pauses, maximum music

- New **AutoDJ** mode — a smart crossfade that blends tracks intelligently: it trims dead air, rides natural fades, and keeps handovers musical instead of abrupt. Its own button in the queue toolbar and its own entry under **Settings → Audio**, alongside Crossfade and Gapless — only one at a time. Off by default; classic **Crossfade** is unchanged.
- **Smooth skip** (on by default with AutoDJ) crossfades manual Next/Previous and track picks from where you are listening instead of hard-cutting; the play/pause button pulses while a blend is active.
- Cap how long overlaps may last: **Auto** (content-driven, up to 12 s) or **Limit** (slider 2–30 s) under **Settings → Audio → Track transitions**.

### Playlist folders — your playlists, organised

- Folders on the **Playlists** page and in the sidebar keep long lists tidy — group by mood, occasion, or anything you like. Drag playlists in, rename and collapse folders, or choose **Move to folder** from the right-click menu. Switch back to a flat list whenever you prefer.

### Settings — tidier and easier to scan

- Settings are grouped into clear, labelled panels so related options sit together — less hunting around. The **Native Hi-Res Playback** option now explains in plain language what it actually does.
- **Normalization** and **Track transitions** are now their own sections under **Settings → Audio**, and the queue options (display mode, toolbar, and Play-Next order) are gathered into one **Queue Settings** group under **Personalisation**.

### Japanese, Hungarian, and Polish — now in your language

- Psysonic is now available in **Japanese (日本語)**, **Hungarian (Magyar)**, and **Polish (Polski)** — pick any of them from the language menu on the **Settings** and **Login** screens.

### Theme store — spot updates, pick your style

- Version numbers on store themes and ones you have installed make it obvious when an update is ready.
- Filter for **animated** or **static** themes only — less scrolling when you already know the look you want.

### Hi-Res playback — smoother transitions between sample rates

- Under **Settings → Audio → Native Hi-Res**, choose a **blend rate** (44.1 / 88.2 / 96 kHz) for crossfade, AutoDJ, and gapless when adjacent tracks differ in sample rate — mixed 88.2 ↔ 44.1 kHz handovers no longer tear mid-transition.

### Artist artwork — richer home, artist, and fullscreen views

- Switch on **External Artwork Scraper** under **Settings → Integrations** to pull artist imagery from fanart.tv: a wide backdrop on the fullscreen player, a banner across the top of the artist page, and now the artist's backdrop behind the home screen's **mainstage** too. Off by default, your Navidrome covers stay in charge, and turning it back off removes the fetched images again.
- Choose which images each place uses as its background, and in what order — drag to reorder or switch a source off — right under the same setting. The mainstage also loads the next backdrops ahead of time so they appear without a blank gap.

### Equalizer — a profile per output device

- Turn on **Remember EQ per device** under **Settings → Audio** and Psysonic keeps a separate equalizer setup for each output — speakers, headphones, a USB DAC — and switches to the right one automatically when you change devices. Off by default.

### Orbit — everyone hears transitions the host chose

- In a shared **Orbit** session, the host's crossfade, gapless, or AutoDJ settings — including length and smooth skip — apply to all guests until you leave. Transition controls in **Settings → Audio** and the queue toolbar show as host-controlled while you are a guest.

### Themes — follow your system's light and dark mode

- The theme scheduler can now match your **system's light/dark setting** instead of a fixed clock: pick a light theme and a dark one, and Psysonic switches along with your OS. Choose **Time of Day** or **System Theme** under **Settings → Themes** — the existing time-based schedule is still there.

### Servers behind a reverse proxy — custom HTTP headers

- Per-server **custom HTTP headers** in **Settings → Servers** for Cloudflare Access, Pangolin, and similar gates — applied to library sync, playback, covers, offline download, and the rest without putting secrets in invite links.

## Fixed

### Playback and audio

- **Opus/Ogg** tracks no longer fight the seekbar while they are still loading — scrub to where you want to be and keep listening.
- The equalizer preset picker shows the active **AutoEQ** profile name again instead of going blank.

### Offline, Now Playing, and Navidrome

- The **Live** listener count in the header stays up to date even when the "Who is listening?" popover is closed.

### Browse and library

- Albums sorted by artist now list each artist's work A–Z by title — no more random order within a name.
- **Artist → Year** keeps artists grouped but walks through their albums chronologically, oldest first.
- Genres with no remaining tracks disappear after you retag and resync the library, without restarting the app.
- The **Artists** A–Z index matches Navidrome ignored articles — **The Beatles** lands under **B**, not **T**.
- **All Albums → Only compilations** and **Favorites** return the albums you expect instead of an empty or partial list.

### Player and playlists

- **Add to playlist** from the player bar adds the song you are hearing, not the whole album.
- On **Favorites**, bulk **Add to playlist** and **Play selected** / **Add selected to queue** act on every checked row.
- **Play Now** on a playlist in the right-click menu starts playback instead of only opening the list.

### Other

- **Orbit** sessions stay reliable on long listens — guests keep receiving updates, radio no longer pollutes the shared queue, and opening Psysonic on a second device does not delete a live session elsewhere.
- On the artist page, the header uses the fanart.tv background when no banner is available — the same image the fullscreen player already showed.
- **Windows:** Previous, Play/Pause, and Next are back when you hover the taskbar icon — and Play/Pause shows whether music is playing or paused.
- **macOS:** the dock icon matches native app sizing instead of looking oversized.
- **Linux:** **Niri** is recognised as a tiling compositor and gets the same custom title bar behaviour as Hyprland and Sway; the "new version available" popup reads clearly on setups where the background blur used to bleed through.


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
