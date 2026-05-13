<div align="center">

  <img src="public/psysonic-inapp-logo.svg" alt="Psysonic Logo" width="320"/>

## A modern desktop client for self-hosted music libraries

**Fast. Native. Beautiful. Built for people who actually care about their music collection.**

Psysonic is built primarily for **Navidrome** and also works with **Gonic**, **Airsonic**, **LMS** and other Subsonic-compatible servers, depending on the features supported by your server.

<br>

<a href="https://github.com/Psychotoxical/psysonic/releases/latest"><img src="https://img.shields.io/github/v/release/Psychotoxical/psysonic?style=for-the-badge&label=Latest%20Release&color=8b5cf6" alt="Latest Release"></a> <a href="https://github.com/Psychotoxical/psysonic/stargazers"><img src="https://img.shields.io/github/stars/Psychotoxical/psysonic?style=for-the-badge&color=f59e0b" alt="GitHub Stars"></a> <a href="https://github.com/Psychotoxical/psysonic/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-22c55e?style=for-the-badge" alt="License GPLv3"></a> <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-v2-0f172a?style=for-the-badge&logo=tauri" alt="Tauri v2"></a>

<a href="https://discord.gg/AMnDRErm4u"><img src="https://img.shields.io/badge/Discord-Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord Community"></a> <a href="https://t.me/+GLBx1_xeH28xYTJi"><img src="https://img.shields.io/badge/Telegram-Community-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Community"></a> <a href="https://ko-fi.com/psychotoxic"><img src="https://img.shields.io/badge/Ko--fi-Support%20Psysonic-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Support Psysonic on Ko-fi"></a>

<a href="https://aur.archlinux.org/packages/psysonic"><img src="https://img.shields.io/badge/AUR-psysonic-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white" alt="AUR psysonic"></a> <a href="https://aur.archlinux.org/packages/psysonic-bin"><img src="https://img.shields.io/badge/AUR-psysonic--bin-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white" alt="AUR psysonic-bin"></a> <a href="https://psysonic.cachix.org"><img src="https://img.shields.io/badge/Cachix-psysonic.cachix.org-5277C3?style=for-the-badge&logo=nixos&logoColor=white" alt="Cachix"></a>

<br><br>

**Available languages:** English, German, Spanish, French, Norwegian Bokmål, Dutch, Romanian, Russian and Chinese.

More translations are added over time.

**No telemetry • Native performance • Navidrome-first • Community driven**

</div>

---

![Psysonic Screenshot](public/screenshot1.png)

---

> [!WARNING]
> Psysonic is under active development. Bugs and rough edges can happen, and features may change as the project evolves.

## What is Psysonic?

Psysonic is a desktop music client for self-hosted music libraries. It is designed for people who want the freedom of their own server without giving up the comfort, polish and speed of a modern music app.

It is built with **Rust**, **Tauri v2** and **React**, with a strong focus on responsiveness, customization, practical music-library workflows and a user interface that does not require a manual before you can press play.

Psysonic is **optimized first and foremost for Navidrome**. Other Subsonic-compatible servers can work well too, but advanced features may depend on server-side support.

---

# Highlights

## Playback & Queue

* Gapless playback
* Crossfade
* ReplayGain support
* LUFS-based Smart Loudness Normalization
* [AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI) support
* Infinite Queue
* Smart Radio sessions
* Fast and responsive playback handling
* Low memory usage compared to heavy web-first clients

## Audio Tools

* 10-band Equalizer
* Equalizer presets
* AutoEQ headphone correction
* Per-device optimization
* Loudness-aware playback options

## Library Management

* Fast search across large libraries
* Albums, artists, tracks and genres
* Ratings support
* Multi-select bulk actions
* Drag & drop playlist management
* Smart Playlists
* Built for large self-hosted collections

## Lyrics & Discovery

* Synced lyrics with seek support
* Lyrics provider support: [YouLy+](https://github.com/ibratabian17/YouLyPlus), LRCLIB and NetEase
* Auto-scrolling sidebar lyrics
* Fullscreen lyric mode
* Last.fm scrobbling
* Similar artists
* Loved tracks and listening stats

## Sharing & Social Listening

* Magic Strings sharing:

  * share albums, artists and queues
  * Navidrome user management helpers
  * fast account sharing
* Orbit shared listening sessions:

  * host-controlled synchronized playback
  * session invites via link
  * guest song suggestions
  * real-time queue interaction

## Personalization & Accessibility

* Large theme collection
* Catppuccin and Nord inspired styles
* Glassmorphism effects
* Font customization
* Zoom controls
* Keybind remapping
* Theme Scheduler for automatic day/night switching
* Colorblind-friendly theme options
* Keyboard-friendly navigation

## Power User Extras

* CLI controls
* USB / portable sync
* Backup and restore settings
* In-app auto updater
* LAN / remote auto switching

---

<div align="left">
  <img src="public/orbit.png" alt="Shared listening feature banner" width="520"/>
</div>

Orbit brings synchronized shared listening sessions directly into Psysonic.

Start a session, invite others with a link and listen together with host-controlled playback, shared queue interaction and guest song suggestions. It is built for real-world music sharing without turning your self-hosted setup into a social-media circus.

---

# Platforms

| OS      | Support                                                         |
| ------- | --------------------------------------------------------------- |
| Windows | Native installer                                                |
| macOS   | Signed DMG                                                      |
| Linux   | AppImage / DEB / RPM / AUR (`psysonic`, `psysonic-bin`) / NixOS |

---

# Install

## Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Psychotoxical/psysonic/main/scripts/install.sh | sudo bash
```

Linux builds are also available through GitHub Releases, AUR and Cachix/Nix.

## Windows

Download the latest installer from the [GitHub Releases](https://github.com/Psychotoxical/psysonic/releases/latest).

## macOS

Download the signed DMG from the [GitHub Releases](https://github.com/Psychotoxical/psysonic/releases/latest).

---

# Development

Contributor expectations (PRs, CI, Tauri boundary, UI): [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/Psychotoxical/psysonic.git
cd psysonic
npm install
npm run tauri:dev
```

Build release:

```bash
npm run tauri:build
```

---

# Privacy

Psysonic is built for self-hosted music collections. Your library is yours.

* No telemetry
* No spyware nonsense
* No analytics harvesting
* No hidden tracking

---

# Community & Support

Join the community, report bugs, suggest features, share themes and help shape the future of Psysonic.

* [Discord](https://discord.gg/AMnDRErm4u)
* [Telegram](https://t.me/+GLBx1_xeH28xYTJi)
* [GitHub Issues](https://github.com/Psychotoxical/psysonic/issues)
* [Support Psysonic on Ko-fi](https://ko-fi.com/psychotoxic)

---

# License

Psysonic is licensed under the **GNU GPL v3.0**.

---

## Forks and Attribution

Psysonic is free and open-source software under the GPLv3. You are welcome to fork it, modify it and build upon it under the terms of the license.

If you publish a modified or rebranded version, please make it clear that your project is based on Psysonic and preserve proper attribution to the original project.

That is not about preventing forks. Forks are part of open source. It is about being honest with users and contributors about where the work comes from.

Features, design work and implementation ideas developed in Psysonic should not be presented as unrelated original work in downstream projects.

---

<div align="center">

## Own your music. Enjoy the client too.

**Psysonic brings a modern desktop experience to self-hosted music libraries.**

</div>
