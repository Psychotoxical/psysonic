# What's New

User-facing release highlights for the in-app **What's New** screen. Maintainers refresh the
current line before promoting to `next` / `release`. Technical details and PR credits stay in
`CHANGELOG.md`.

Within each section, order by **user impact** (most noticeable first) — not PR merge order.
`CHANGELOG.md` keeps strict PR order inside Added / Changed / Fixed.


## [1.52.0]

## Highlights

### Offline downloads — resume safely on slow connections

- Original-quality downloads no longer fail merely because a slow server needs more than two minutes. Transfers can continue for as long as data keeps arriving.
- An interrupted download resumes from a verified partial file instead of starting over. Changed or unsafe responses discard the partial cleanly, while cancellation, disk-space reservations, and concurrent attempts remain protected.
- Album, artist, playlist, and favourites pins keep every server owner, survive restarts and server-address migrations, and stay cancelled when you remove them.

### Album catalogue — switch between cards and a detailed table

- **All Albums, New Releases**, and **Lossless** can switch independently between the familiar card grid and a table. Each page remembers its own choice.
- The table shows cover, title, artist, song count, year, duration, and date added, removes columns gracefully on narrower windows, and sorts from the title and year headers.
- Song counts, durations, and added dates now remain available across filtered album views. Albums added in the last two days also carry the new-release ribbon on the **All Albums** grid.

### Playlists — know what is yours and sort it everywhere

- When a server mixes your playlists with everyone else's public lists, the **Playlists** page and sidebar can separate your own, the ones you share, and the ones shared with you. The filter appears only when shared playlists exist.
- Sidebar playlists show their cover and song count, while playlists without artwork keep the simple list icon.
- Order the page and sidebar together by name, creation date, or song count. The choice is remembered and still works with folders and search.

### Artist pages — every track they perform on

- Artist pages now pair the familiar **Popular tracks** ranking with an **All tracks** tab containing every song that artist performs on, including compilations and guest appearances.
- The complete list is ordered by album, disc, and track number, supports sorting from every column, and lets you choose which metadata columns to show. It loads from the local index only when you open the tab, so the page remains quick to enter.

### Scrobbling — choose the threshold or send it now

- **Settings → Integrations → Music Network** now lets you choose a **25–90%** scrobble threshold; the default remains 50%.
- Advanced settings can add **Force scrobble** to the player bar and fullscreen player. It shows listening progress and can submit the current track immediately to the media server and every enabled Music Network destination.

### Full Ukrainian interface

- Ukrainian (**Українська**) is available from the language picker on the Login and Settings screens, with the full interface translated.
- Counts use the correct one, few, and many forms, and Ukrainian Cyrillic is folded consistently when matching the same release across several servers.

### Navidrome upgrades — keep local data intact

- When a newer Navidrome switches albums, artists, and tracks to canonical IDs, Psysonic safely migrates the local library, analysis results, offline downloads, cached covers, and saved app state before completing a full verification sync.
- The migration resumes after interruption and prevents playback, sync, imports, or background work from seeing a half-converted library. Navidrome 0.63.2 and older servers, and other Subsonic servers, continue as before.

## Improved

- Hovering a shortened card title or artist now reveals the complete text across album, artist, playlist, radio, song, and offline cards. The tooltip appears only when text is actually truncated and can be disabled under **Settings → Appearance → Display**.
- Album cards and the offline play button now use the selected language for screen-reader labels instead of always announcing a German word.
- **Windows:** update notices now wait 12 hours for WinGet moderation instead of two days, making new releases visible roughly a day and a half sooner without pointing at a version WinGet cannot install yet.
- Help now covers multi-server browsing, Timeline playback, per-address streaming quality, album tables, shared playlists, composers, the visualizer, themes, and background sources, while outdated answers and settings paths have been removed.

## Fixed

### Playback and audio

- Synced lyrics now follow playback continuously instead of lighting up inconsistently or nearly a second late. Every lyrics view uses the same position, including after seeking while paused.
- Tracks played in Psysonic update their play count and last played date as soon as the server records the scrobble, including native Navidrome connections.

### Browse and library

- Albums, queue rows, playlists, favourites, search results, Random Mix, and Home song cards no longer start dragging after a held press loses or replaces its original row.
- **Live Search** no longer shows the same artist, album, or song twice when the local index and server response use different forms of the same server identity.
- Navidrome background sync preserves structured multi-artist credits instead of collapsing them into one comma-joined name.
- The library selector can choose an individual music folder again after updating from Psysonic 1.50 to 1.51, with invalid saved scope repaired during startup.
- Album, artist, favourites, and playlist tracklists now show and sort by locally analysed BPM when it is available.
- Navidrome timestamps with negative UTC offsets populate **New Releases**, favourites, and last played dates again, with safe legacy values repaired gradually in the background.
- Standard, deluxe, remastered, and other physical versions of an album stay separate, while matching copies of the same version can still merge across servers.

### Other

- **Linux/KDE Plasma:** Space, F11, and other shortcuts work immediately after returning to Psysonic with Alt+Tab, without requiring an extra click inside the window.
- Turning off **Show Tray Icon** also disables tray-dependent minimise settings, and unsafe saved combinations are repaired so closing Psysonic cannot leave it hidden with no way to reopen it.
- Ukrainian settings descriptions include their full security, privacy, source, and playback warnings again.
