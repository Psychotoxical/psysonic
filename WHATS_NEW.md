# What's New

User-facing release highlights for the in-app **What's New** screen. Maintainers refresh the
current line before promoting to `next` / `release`. Technical details and PR credits stay in
`CHANGELOG.md`.

Within each section, order by **user impact** (most noticeable first) — not PR merge order.
`CHANGELOG.md` keeps strict PR order inside Added / Changed / Fixed.


## [1.50.0]

## Highlights

### Multi-library filter — browse across your libraries

- The sidebar library picker now supports **multi-select with priority ordering** — browse, search, genres, and album/artist detail views aggregate across the libraries you pick and de-duplicate shared items by priority.
- Cross-library matching normalises names per locale (German ß, Norwegian æ, French œ, Romanian ș/ț, Cyrillic ё/й); CJK titles are matched as-is.
- The Genres page and album browse genre filter list the full catalog on large libraries when **All libraries** is selected.

### Navidrome public share links — listen without logging in

- Paste or search a Navidrome **public share** URL (`/share/{id}`) to preview the shared track list, then play the full queue with no server account.
- Share playback stays isolated from your logged-in Navidrome queue — idle server play-queue pull cannot replace a share session while you are connected elsewhere.
- While a share queue is active, **Save Playlist** is hidden in the queue toolbar; **Share** copies the original Navidrome `/share/{id}` page URL.

### Fullscreen player — Minimal, Immersive, and Prism

- **Settings → Appearance → Fullscreen player style** now offers three looks: **Minimal** (the current sharp view), **Immersive** (artist photo/backdrop with rail or Apple-style scrolling lyrics), and **Prism** (full-bleed artist backdrop, glass lyrics panel, and a single glass control bar).
- In Immersive, **Show artist photo** and **Photo dimming** are configurable; Prism drives progress and the active lyric line from the cover-derived accent colour.

### Lyrics that follow the singer, word by word

- The **Server** lyrics source now highlights lyrics word by word as a track plays, so karaoke sync no longer needs the third-party YouLyPlus backend. It requires Navidrome 0.63 or newer and lyrics that carry word timing (TTML or Enhanced LRC files) — everything else keeps highlighting line by line. The requirements are spelled out under **Settings → Lyrics → Lyrics Sources**.
- Embedded Enhanced LRC no longer prints raw word timing codes in the lyric text; FLAC, Ogg Vorbis, Opus, and Speex files with synced lyrics in the `SYNCEDLYRICS` tag show embedded lyrics again.

### Player bar — build your own, plus shuffle

- **Settings → Personalisation → Player bar** now also hides the **stop button** and shows the **album name** under the artist (off by default; clicking it opens the album). Star rating, favourite, love, playback speed, equalizer, and mini player can be **dragged into any order** you like — the section is no longer behind **Advanced**.
- A **shuffle toggle** in the player bar shuffles the queue from the current track onwards while keeping the playing track in place; turning shuffle off restores the original order. It survives restarts and keeps Orbit guests in sync with the host. Hide the button from **Settings → Personalisation → Player bar** if you prefer.

### Track lists — optional album cover thumbnails

- Browse and queue track rows can show each track's **album** cover (per-disc art when the album has distinct disc covers).
- **Settings → Appearance** adds separate toggles for queue vs browse tracklists; playlist, Favorites, and album-detail grids gain a flex-resize handle on the title column when covers are shown.
- Album detail pages skip per-row cover thumbs when the album art is already shown above the list.

### Discord — Server cover art without exposing your login

- **Settings → Integrations → Discord → Cover art source** includes a **Server** option alongside **None** and **Apple Music**. It resolves artwork through the server's public album image link — never an authenticated URL that could expose your login credentials. Requires a publicly reachable server.

### Artists browse — album artists or track credits

- Toggle **Album artists** vs **Track artists** on the Artists page — album mode lists indexed album artists; track mode includes featured and guest performers from the local artist index. The choice persists across restarts like **Show artist images**.
- Artist name search no longer depends on query letter case for Cyrillic and other non-ASCII names when the local library index is enabled.

### Theme Store — what's new on each theme

- Each theme card has an expandable **What's new** with per-version release notes from the author — including non-visual fixes.
- Installed themes with an available update now appear at the top of the store list so you do not have to hunt for them.
- **Settings → System → Contributors** lists community theme authors in a **Themes** section alongside app contributors; author names refresh quietly from the store in the background.

### Italian and Bulgarian — now in your language

- Psysonic is now available in **Italian (Italiano)** and **Bulgarian (Български)** — pick either from the language menu on the **Settings** and **Login** screens.

### Start minimized to tray

- New **Start Minimized to Tray** toggle under **Settings → System → Behavior** — the next cold start keeps the main window hidden and Psysonic runs from the system tray until you show it from the tray icon. Requires **Show Tray Icon**; applies on the next launch only.
- Opening the main window from the tray after a cold start renders the sidebar and main content immediately — including on Linux tiling window managers — instead of leaving them invisible or blank until a restart.

### Square corners — a sharper, boxier look

- New **Square Corners** toggle under **Settings → Appearance → Visual Options → Display** strips the rounded corners off cards and cover art across the app — handy when a theme's rounding does not suit your album covers. Off by default; buttons, inputs, and dialogs keep the theme's corners.

## Improved

- With **Remember EQ per device** on and **System Default** selected, the equalizer now keys profiles to the active OS default output and switches when that default changes outside the app (Windows sound settings, Stream Deck, PipeWire / `wpctl`, and similar). **Linux:** when PipeWire has already moved the stream to the new default, the device watcher skips a redundant reopen to avoid a post-switch stutter. **Windows:** release builds no longer freeze on the loading splash; audio output devices use stable backend IDs with clearer labels, and device-change detection works again after upgrade.

## Fixed

### Playback and audio

- Playing a song from a playlist no longer shows the track's own cover in Now Playing when the album page would show album art — Now Playing consistently uses the album cover.
- ReplayGain applies when stream or queue metadata resolves late; gapless auto-advance no longer leaves the playbar on the previous track.
- Pausing a large queue behind a reverse proxy (e.g. Nginx) no longer snaps playback back to an earlier track — Navidrome saves via POST when supported, and a failed save no longer lets idle auto-pull overwrite your queue.
- Internet Radio equalizer presets and slider changes now apply to live stations — not just library tracks.

### Offline, Now Playing, and Navidrome

- Desktop builds no longer get stuck showing "offline" when WebKitGTK leaves `navigator.onLine` at `false` while the server is reachable — the app confirms with a real server probe instead.
- When browsing offline, Artists, Albums, Tracks, and Genres list only content with on-disk bytes — pins, favorites-auto saves, and hot-cache playback — instead of the full server or local index catalog.

### Themes and integrations

- Connecting a scrobble service in **Settings → Integrations → Music Network** now shows the underlying error alongside the generic network message, so a bad URL or rejected token is easier to tell apart from a reachability problem on your machine.
- Horizontal album rails in themes with drop shadows no longer clip card shadows at the edges — scroll arrows keep working without theme authors overriding rail overflow.

### Browse and library

- Adding tracks to a playlist no longer fails past ~341 songs — writes go to the server in batches, and large-playlist edits are faster.
- Queue rows far from the playing track no longer stay stuck on a "…" placeholder — the queue loads details for whatever you scroll to, in the desktop panel, mobile drawer, and fullscreen **Up next** overlay.
- The year filter on **All Albums** no longer clamps on every keystroke while you type a four-digit year — it commits on blur, Enter, or outside click.
- Starring an album on the detail page fills the heart immediately and keeps it filled after reload; album-level stars and ratings reconcile consistently across browse and Favorites.
- Renamed artists no longer linger as ghost entries that open to "Artist not found"; album artist links and cover tiles in **Random Albums** stay consistent after resync.
- Custom playlist and internet radio covers uploaded in Navidrome show again on cards and detail headers.
- Sorting albums by artist now follows the name shown on each row — featured-guest releases no longer land under the wrong artist in **Artist / Year** order.

### Other

- Servers behind a custom HTTP header gate (Cloudflare Access, Pangolin, and similar) now work for the full app — add-server errors stay on the form with a clear reason, browse and detail views load natively behind the gate, streaming and covers carry the header reliably, and returning to a LAN address upgrades the connection automatically when both LAN and public endpoints are configured.
- Modal dialogs now announce their title to screen readers when they open.
- **Windows:** **Who is listening?** no longer shows `psysonic/undefined` as the client id.


## [1.49.0]

## Highlights

### Play queue sync — pick up where you left off on another device

- Click the header connection indicator to **pull** the active server's play queue when it differs from yours; a yellow LED shows when browse and playback servers do not match.
- While paused or stopped, **idle auto-pull** checks every 10 seconds and applies server changes when you have been still for 30+ seconds.
- Queue **push** sends only tracks owned by the playback server, so mixed-server queues stay sane when you switch servers.
- Local queue edits while paused are no longer overwritten by auto-pull; pressing **Play** pushes your changes immediately, and the sync LED no longer flashes on every track during normal playback.
- After the last track ends with repeat off, idle pull no longer rewinds to an earlier server position — the queue stays where playback finished.

### AutoDJ — minimum pauses, maximum music

- New **AutoDJ** mode — a smart crossfade that blends tracks intelligently: it trims dead air, rides natural fades, and keeps handovers musical instead of abrupt. Its own button in the queue toolbar and its own entry under **Settings → Audio**, alongside Crossfade and Gapless — only one at a time. Off by default; classic **Crossfade** is unchanged.
- **Smooth skip** (on by default with AutoDJ) crossfades manual Next/Previous and track picks from where you are listening instead of hard-cutting; the play/pause button pulses while a blend is active.
- Cap how long overlaps may last: **Auto** (content-driven, up to 12 s) or **Limit** (slider 2–30 s) under **Settings → Audio → Track transitions**.
- The last track in the queue plays through to the end instead of being trimmed when nothing follows.

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

- Turn on **Remember EQ per device** under **Settings → Audio** and Psysonic keeps a separate equalizer setup for each output — speakers, headphones, a USB DAC — and switches to the right one automatically when you change devices, including when **System Default** is selected and the OS default output changes outside the app. Off by default.

### Orbit — everyone hears transitions the host chose

- In a shared **Orbit** session, the host's crossfade, gapless, or AutoDJ settings — including length and smooth skip — apply to all guests until you leave. Transition controls in **Settings → Audio** and the queue toolbar show as host-controlled while you are a guest.

### Themes — follow your system's light and dark mode

- The theme scheduler can now match your **system's light/dark setting** instead of a fixed clock: pick a light theme and a dark one, and Psysonic switches along with your OS. Choose **Time of Day** or **System Theme** under **Settings → Themes** — the existing time-based schedule is still there.

### Servers behind a reverse proxy — custom HTTP headers

- Per-server **custom HTTP headers** in **Settings → Servers** for Cloudflare Access, Pangolin, and similar gates — applied to library sync, playback, covers, offline download, and the rest without putting secrets in invite links.

### Album details — every genre, not just the first

- Album details now show **all** the genres a release spans: the main genre appears inline with a **+N** chip that opens the full, clickable list, each genre linking to its own page. Genres combine album and track tags and read from the local library index, so they work offline too.

### Compact buttons — switch to icon-only controls

- New **Compact buttons** option under **Settings → Appearance** switches the action and toolbar buttons between large labelled buttons and small icon-only ones — across album, artist and playlist headers, the shared browse toolbars, and the Most Played controls. Defaults to large; on phones the album header keeps its large touch targets.

### Playlists — sort by date added

- Sort a playlist by **Date added** (newest or oldest first), or by title, artist, album and the other columns, from a new sort dropdown in the playlist toolbar. The Subsonic API has no per-track "added on" date, so this follows the playlist's own order — servers add new tracks at the end, so newest-first puts your latest additions on top.

## Improved

- **macOS:** the window's title bar now follows the active theme instead of the grey system bar; the native window buttons stay in place, floating over the themed bar.
- Pressing **Play**, **Shuffle**, or **Add to queue** on a playlist starts playback without reloading the whole page with a spinner — editing the playlist still refreshes the list as before.
- Dragging sidebar items in **Settings → Personalisation → Sidebar** (or long-pressing in the sidebar itself) keeps each item exactly where you release it — no snap-back or off-by-one landing.

## Fixed

### Playback and audio

- **Timeline** mode keeps your session play-history strip when you **Play** an album or playlist; the current track stays pinned at the top, and replaying a history row inserts after the playing track instead of replacing the queue.
- **Opus/Ogg** tracks no longer fight the seekbar while they are still loading — scrub to where you want to be and keep listening.
- The equalizer preset picker shows the active **AutoEQ** profile name again instead of going blank.

### Offline, Now Playing, and Navidrome

- The **Live** listener count in the header stays up to date even when the "Who is listening?" popover is closed.

### Browse and library

- Album and artist covers — and the full-size view when you click a cover — open at full resolution again instead of looking soft or small.
- Albums sorted by artist now list each artist's work A–Z by title — no more random order within a name.
- **Artist → Year** keeps artists grouped but walks through their albums chronologically, oldest first.
- Genres with no remaining tracks disappear after you retag and resync the library, without restarting the app.
- The **Artists** A–Z index matches Navidrome ignored articles — **The Beatles** lands under **B**, not **T**.
- **All Albums → Only compilations** and **Favorites** return the albums you expect instead of an empty or partial list.

### Player and playlists

- **Add to playlist** from the player bar adds the song you are hearing, not the whole album.
- On **Favorites**, bulk **Add to playlist** and **Play selected** / **Add selected to queue** act on every checked row.
- **Play Now** on a playlist in the right-click menu starts playback instead of only opening the list.
- Playlists page header buttons wrap on narrow windows instead of clipping off-screen when the queue panel is open.

### Other

- **Orbit** sessions stay reliable on long listens — guests keep receiving updates, radio no longer pollutes the shared queue, and opening Psysonic on a second device does not delete a live session elsewhere.
- On the artist page, the header uses the fanart.tv background when no banner is available — the same image the fullscreen player already showed.
- **Windows:** Previous, Play/Pause, and Next are back when you hover the taskbar icon — and Play/Pause shows whether music is playing or paused.
- **macOS:** the dock icon matches native app sizing instead of looking oversized.
- **Linux:** **Niri** is recognised as a tiling compositor and gets the same custom title bar behaviour as Hyprland and Sway; the "new version available" popup reads clearly on setups where the background blur used to bleed through.

## Under the hood

- If a screen hits an unexpected error, the app now shows a small recoverable card (**Try again** / **Reload app**) and keeps playing, instead of the whole window going blank.


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
