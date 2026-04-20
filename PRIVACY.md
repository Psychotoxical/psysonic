# Privacy Policy

Psysonic is a self-hosted music player. It does not collect telemetry, analytics, or any data on its own. All data stays on your device or travels exclusively between your device and services you explicitly configure.

## Data sent to third-party services

All third-party integrations listed below are **opt-in**. Nothing is sent until you enable the respective feature.

### Your Subsonic / Navidrome server
Your server URL, username, and password are stored locally in the app's data directory. All playback and library requests go directly to your own server. Psysonic has no access to this data.

### Last.fm
If you connect a Last.fm account in Settings, Psysonic sends:
- **Scrobbles** — track title, artist, album, and timestamp when a song reaches 50% playback
- **Now Playing** — the currently playing track (title, artist, album)
- **Love / Unlove** — when you mark a track as loved or unloved

All requests go to the [Last.fm API](https://www.last.fm/api). Your Last.fm credentials are stored locally and never leave your device. You can disconnect your account at any time in Settings.

### LRCLIB (Lyrics)
When lyrics are fetched from LRCLIB, Psysonic sends the track title, artist, album, and duration to [lrclib.net](https://lrclib.net) as a search query. No account is required. This feature can be disabled in Settings → Lyrics.

### YouLyPlus (Lyrics)
If YouLyPlus mode is selected in Settings → Lyrics, Psysonic sends the track title, artist, album, duration, and ISRC (when available) to a community-operated [lyricsplus](https://lyricsplus.prjktla.my.id) backend to fetch word-synced karaoke lyrics. No account is required. Requests are routed through a list of public mirrors; the data they receive is limited to the search query above. This feature is disabled by default.

### NetEase Cloud Music (Lyrics)
If NetEase is enabled as a lyrics source in Settings → Lyrics, Psysonic sends the track artist and title to the NetEase Cloud Music API (via a Rust-side proxy request) to search for synced lyrics. No account is required. This feature is disabled by default.

### Apple Music / iTunes Search API
If "Use Apple Music covers for Discord" is enabled in Settings, Psysonic queries the [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) with the current track's artist and album name to find cover art. No Apple account is required. Apple's own privacy policy applies to these requests.

### Discord Rich Presence
If Discord is running and Rich Presence is not disabled, Psysonic connects to the local Discord client via its IPC socket to display the currently playing track. This data is sent to Discord and subject to [Discord's privacy policy](https://discord.com/privacy). No data is sent if Discord is not installed or not running.

## Data stored locally

The following data is stored exclusively on your device in the app's local storage directory and is never transmitted:

- Server profiles (URL, username, password)
- Last.fm session key
- Playback preferences, themes, keybindings, and all other settings
- Synced device manifests

## No telemetry

Psysonic contains no crash reporting, analytics, usage tracking, or any form of telemetry.

## Open source

Psysonic is fully open source under the [GNU General Public License v3.0](LICENSE). You can verify exactly what data is sent by reading the source code.
