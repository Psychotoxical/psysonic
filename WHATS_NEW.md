# What's New

User-facing release highlights for the in-app **What's New** screen. Maintainers refresh the
current line before promoting to `next` / `release`. Technical details and PR credits stay in
`CHANGELOG.md`.

## [1.48.0]

## Highlights

### Theme Store

- Browse and install community themes from **Settings → Themes** — search, dark/light filter, and full-size previews.
- Six palettes ship with the app; everything else installs on demand and works offline after the first download.
- Import a theme from a local `.zip` when you have a package from a friend or your own design.
- The sidebar nudges you when an installed theme has an update; one-click update from the theme card.

### Offline listening

- Starred tracks and pinned albums stay on disk under one **media** folder — browse them in **Offline Library**.
- Favorites can sync automatically; pinned albums and playlists refresh when the library index updates.
- When the server is unreachable, browse and detail pages show what you already have locally instead of empty errors.

### Fullscreen player

- Rebuilt for much lower CPU and memory use: a calm, sharp fullscreen view with album art, waveform seekbar, up-next queue, synced lyrics, ratings, and a clock.

### Queue — Timeline mode

- A third queue layout keeps the current track in the middle with history above and up next below — great for long listening sessions. Cycle the header control or pick it in **Settings → Personalisation → Queue display**.

### Sidebar

- Optional **Settings → Sidebar** toggle pins **Now Playing** to the top of the sidebar.

### Startup

- A themed loading splash appears while the app starts — colours follow your active theme, including community palettes.

### Settings → Servers

- Server cards are easier to scan: software version on the card, compact actions, and a green **AudioMuse-AI** badge on Navidrome 0.62+ when the plugin is detected.

## Improved

- Audio decoding runs on **Symphonia 0.6** for current and future codec fixes.
- **Settings → About** shows a clearer open-source licenses panel.

## Fixed

- Smoother playback and library behaviour across offline mode, theme switching, and server reconnect — see `CHANGELOG.md` for the full list.
