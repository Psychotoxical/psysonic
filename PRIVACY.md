# Privacy Policy

Psysonic is a self-hosted music player. It does not collect telemetry, analytics, or any data on its own. All data stays on your device or travels exclusively between your device and services you explicitly configure.

## Data sent to third-party services

All third-party integrations listed below are **opt-in**. Nothing is sent until you enable the respective feature.

### Your Subsonic / Navidrome server
Your server URL, username, and password are stored locally in the app's data directory. All playback and library requests go directly to your own server. Psysonic has no access to this data.

### Music Network (scrobble & enrichment services)
Psysonic can connect to one or more scrobble services in Settings → Integrations. Each service you connect is opt-in and independent; nothing is sent to a service you have not connected. Supported service classes:

- **Audioscrobbler / GNU FM services** — Last.fm, Libre.fm, Rocksky (AT Protocol), and any self-hosted GNU FM-compatible instance
- **ListenBrainz** — the public ListenBrainz.org service, or a self-hosted instance (e.g. Koito) via its ListenBrainz-compatible API
- **Maloja** — your own self-hosted Maloja server (native API or its ListenBrainz-compatible API)

To each connected service, Psysonic may send:
- **Scrobbles** — track title, artist, album, and timestamp when a song reaches 50% playback
- **Now Playing** — the currently playing track (title, artist, album), where the service supports it
- **Love / Unlove** — when you mark a track as loved, on services that support it

Additionally, the one service you choose as your **primary** is queried to enrich the UI (your loved tracks, similar artists, and listening stats). All requests go directly from your device to the service's own host — the public service's host (e.g. the [Last.fm API](https://www.last.fm/api), [ListenBrainz](https://listenbrainz.org)) or, for self-hosted services, the server URL you entered. Credentials (session keys / API tokens) are stored locally and never leave your device. You can disconnect any service at any time in Settings.

### LRCLIB (Lyrics)
When lyrics are fetched from LRCLIB, Psysonic sends the track title, artist, album, and duration to [lrclib.net](https://lrclib.net) as a search query. No account is required. This feature can be disabled in Settings → Lyrics.

### YouLyPlus (Lyrics)
If YouLyPlus mode is selected in Settings → Lyrics, Psysonic sends the track title, artist, album, duration, and ISRC (when available) to a community-operated [lyricsplus](https://github.com/ibratabian17/lyricsplus) backend to fetch word-synced karaoke lyrics. No account is required. Requests are routed through a list of public mirrors; the data they receive is limited to the search query above. This feature is disabled by default.

### NetEase Cloud Music (Lyrics)
If NetEase is enabled as a lyrics source in Settings → Lyrics, Psysonic sends the track artist and title to the NetEase Cloud Music API (via a Rust-side proxy request) to search for synced lyrics. No account is required. This feature is disabled by default.

### Apple Music / iTunes Search API
If "Use Apple Music covers for Discord" is enabled in Settings, Psysonic queries the [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) with the current track's artist and album name to find cover art. No Apple account is required. Apple's own privacy policy applies to these requests.

### Discord Rich Presence
If Discord is running and Rich Presence is not disabled, Psysonic connects to the local Discord client via its IPC socket to display the currently playing track. This data is sent to Discord and subject to [Discord's privacy policy](https://discord.com/privacy). No data is sent if Discord is not installed or not running.

## Data stored locally

The following data is stored exclusively on your device in the app's local storage directory and is never transmitted:

- Server profiles (URL, username, password)
- Scrobble service credentials (session keys / API tokens)
- Playback preferences, themes, keybindings, and all other settings
- Synced device manifests

## No telemetry

Psysonic contains no crash reporting, analytics, usage tracking, or any form of telemetry.

## Open source

Psysonic is fully open source under the [GNU General Public License v3.0](LICENSE). You can verify exactly what data is sent by reading the source code.
