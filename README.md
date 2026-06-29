<div align="center">

  <img src="public/psysonic-inapp-logo.svg" alt="Psysonic Logo" width="320"/>

## A modern desktop client for self-hosted music libraries

**Fast. Native. Beautiful. Built for people who actually care about their music collection.**

Psysonic is built primarily for **Navidrome** and also works with **Gonic**, **Airsonic**, **LMS** and other Subsonic-compatible servers, depending on the features supported by your server.

<br>

<a href="https://github.com/Psychotoxical/psysonic/releases/latest"><img src="https://img.shields.io/github/v/release/Psychotoxical/psysonic?style=for-the-badge&label=Latest%20Release&color=8b5cf6" alt="Latest Release"></a> <a href="https://github.com/Psychotoxical/psysonic/stargazers"><img src="https://img.shields.io/github/stars/Psychotoxical/psysonic?style=for-the-badge&color=f59e0b" alt="GitHub Stars"></a> <a href="https://github.com/Psychotoxical/psysonic/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-22c55e?style=for-the-badge" alt="License GPLv3"></a> <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-v2-0f172a?style=for-the-badge&logo=tauri" alt="Tauri v2"></a>

<a href="https://discord.gg/AMnDRErm4u"><img src="https://img.shields.io/badge/Discord-Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord Community"></a> <a href="https://t.me/+GLBx1_xeH28xYTJi"><img src="https://img.shields.io/badge/Telegram-Community-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Community"></a> <a href="https://ko-fi.com/psychotoxic"><img src="https://img.shields.io/badge/Ko--fi-Support%20Psysonic-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Support Psysonic on Ko-fi"></a>

<a href="https://aur.archlinux.org/packages/psysonic"><img src="https://img.shields.io/badge/AUR-psysonic-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white" alt="AUR psysonic"></a> <a href="https://aur.archlinux.org/packages/psysonic-bin"><img src="https://img.shields.io/badge/AUR-psysonic--bin-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white" alt="AUR psysonic-bin"></a> <a href="https://psysonic.cachix.org"><img src="https://img.shields.io/badge/Cachix-psysonic.cachix.org-5277C3?style=for-the-badge&logo=nixos&logoColor=white" alt="Cachix"></a> <a href="https://github.com/microsoft/winget-pkgs/tree/master/manifests/p/Psychotoxical/Psysonic"><img src="https://img.shields.io/badge/WinGet-psysonic-blue?style=for-the-badge&logo=windows" alt="WinGet psysonic"></a>

<br><br>

**Available languages:** English, German, Spanish, French, Norwegian Bokmål, Dutch, Romanian, Russian, Chinese, Japanese, Hungarian and Polish.

More translations are added over time.

**No telemetry • Native performance • Navidrome-first • Community driven**

</div>

---

![Psysonic Screenshot](public/screenshot1.png)

---

## What is Psysonic?

Psysonic is a desktop music client for self-hosted music libraries. It is designed for people who want the freedom of their own server without giving up the comfort, polish and speed of a modern music app.

It is built with **Rust**, **Tauri v2** and **React**, with a strong focus on responsiveness, customization, practical music-library workflows and a user interface that does not require a manual before you can press play.

Psysonic is **optimized first and foremost for Navidrome**, and it leans into that on purpose: instead of being one more generic Subsonic client, it is **the Navidrome-first desktop client that does things no other client does.** Other Subsonic-compatible servers can work well too, but advanced features may depend on server-side support.

---

# ⭐ Key Features

These are the things that set Psysonic apart. To our knowledge, no comparable self-hosted desktop client ships them.

## 🪐 Orbit — Shared Listening

**Listen together, in sync, over your own server.**

Orbit brings real-time synchronized group listening into Psysonic. Start a session, invite people with a link, and everyone hears the same thing at the same time — with host-controlled playback, a shared queue and guest song suggestions.

The clever part: Orbit rides entirely on **your own Navidrome**. There is no external relay, no third-party service and no extra accounts. The session lives on your server, where it belongs. It is built for real-world music sharing without turning your self-hosted setup into a social-media circus.

<div align="left">
  <img src="public/orbit.png" alt="Orbit shared listening" width="520"/>
</div>

## ⚡ Local Library — Instant, and Almost Offline

**A local index of your whole collection, so the app stays fast no matter what your connection does.**

Psysonic keeps a local library of your collection's metadata right on your machine. Because the app already knows your tracks inside out, browsing, searching and starting playback are instant — even a 500 MB FLAC starts the moment you hit play, because nothing has to be fetched or parsed first.

It also means the connection to your server stops being a bottleneck. Even on a slow, flaky or distant link, Psysonic stays responsive and **behaves almost like an offline player**, whatever the network is doing.

And it's the foundation everything else is built on: the local library is what makes on-device analysis, smart audio and snappy navigation possible in the first place.

## 🧠 On-Device Audio Analysis

**One of the most powerful things Psysonic does — entirely on your own machine.**

Built on top of the local library, Psysonic analyzes your tracks locally — **loudness, waveform and tempo** — with no cloud service and no required server-side plugin. That analysis is what powers content-aware AutoDJ transitions, LUFS-based loudness normalization and playback-speed control.

This is a deep, genuinely useful layer that most clients simply don't have, and because it runs locally, it works exactly the same whether you're fully online or barely connected.

## 🎧 AutoDJ — Content-Aware Crossfade

**A DJ that listens to the music, not a stopwatch.**

Most players do fixed-time crossfade: blend the last N seconds into the next N seconds, dead air and all. AutoDJ uses Psysonic's own audio analysis to **trim the silence at the edges of a track and blend out of the actual music** — for transitions that sound deliberate instead of mechanical. It is a standalone playback mode with smooth skip/interrupt handling and a configurable overlap.

## 🔗 Navidrome-Native, Deeply

**Not a generic Subsonic client wearing a Navidrome hat.**

Psysonic binds Navidrome's native capabilities directly: server-side smart-playlist create/edit, playback reporting and OpenSubsonic capability probing. Most clients in this space stay Subsonic-generic. Psysonic goes deeper, so Navidrome users get the features their server can actually deliver.

## 🎨 Community Theme Store

**A real marketplace for themes — installable and schedulable.**

Beyond a big set of built-in themes, Psysonic has a first-party theme registry: browse community themes, install them in-app, and let the **Theme Scheduler** switch looks automatically between day and night.

---

> ### Built to be trusted
>
> We take an enterprise-grade approach to development — continuously improving our automated testing and maintaining strict contracts between the backend and the frontend. Releases are cut from green CI, not vibes.

---

# ✨ More Highlights

Features that go well beyond the basics. Not all of these are unique to Psysonic, but few clients bring this many together.

## Audio & Loudness

* LUFS-based Smart Loudness Normalization
* ReplayGain support and loudness-aware playback
* 10-band Equalizer with presets
* AutoEQ headphone correction
* Per-device EQ and output optimization
* Adjustable playback speed

## Lyrics & Listening

* Synced lyrics with seek support, from multiple providers ([YouLy+](https://github.com/ibratabian17/YouLyPlus), LRCLIB, NetEase)
* Auto-scrolling sidebar lyrics and a fullscreen lyric mode
* Last.fm scrobbling, similar artists, loved tracks and listening stats
* Smart Radio sessions and an Infinite Queue
* [AudioMuse-AI](https://github.com/NeptuneHub/AudioMuse-AI) support for sonic-similarity discovery (requires an AudioMuse-AI server)

## Artwork & Visuals

* Optional external artist imagery via **fanart.tv** — opt-in, shown on the artist page, fullscreen player and home hero (Navidrome stays the canonical cover-art source)
* Cover art surfaced across the app, OS media controls and Discord Rich Presence

## Library & Playlists

* Smart Playlists
* Drag & drop playlist management
* Multi-select bulk actions

## Sharing

* Magic Strings sharing for albums, artists and queues
* Navidrome user-management helpers for fast account sharing

## Offline, Sync & Deployment

* Offline playback and downloads
* USB / portable sync
* LAN / remote auto-switching
* Custom HTTP headers for reverse-proxy-gated servers (e.g. Cloudflare Access, Pangolin)
* Backup and restore settings
* In-app auto updater

## Personalization & Accessibility

* Font customization and zoom controls
* Keybind remapping
* Colorblind-friendly theme options
* Keyboard-friendly navigation

## Power-User Extras

* CLI controls

---

# ✅ The Basics, Done Right

The things you simply expect from a serious music player — and Psysonic does them well.

* Gapless playback and crossfade
* Fast search across large libraries
* Browse albums, artists, tracks and genres
* Ratings
* Queue management
* Keyboard navigation
* Media key support
* Low memory usage and native performance compared to heavy web-first clients
* Built for large self-hosted collections

---

# Platforms

| OS      | Support                                                         |
| ------- | --------------------------------------------------------------- |
| Windows | Native installer / WinGet                                       |
| macOS   | Signed DMG                                                      |
| Linux   | AppImage / DEB / RPM / AUR (`psysonic`, `psysonic-bin`) / NixOS |

---

# Install

## Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Psychotoxical/psysonic/main/scripts/install.sh | sudo bash
```

Linux builds are also available through GitHub Releases, AUR and Cachix/Nix.

> **AppImage runs under X11/XWayland** — it pins `GDK_BACKEND=x11` for a stable WebKitGTK stack. For a native-Wayland launch, use the `.deb`, `.rpm`, AUR, or Nix packages, which follow your session's display server.

## Windows

Download the latest installer from the [GitHub Releases](https://github.com/Psychotoxical/psysonic/releases/latest).  
or,  
install via Windows Package Manager (WinGet):  
```powershell
winget install Psysonic
```

You can also browse and install it on [winstall.app](https://winstall.app/apps/Psychotoxical.Psysonic).

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

See [TELEMETRY.md](TELEMETRY.md) for the telemetry stance and [PRIVACY.md](PRIVACY.md) for how each opt-in integration handles data.

---

# Reviews

* [An independent review at falu.github.io](https://falu.github.io/2026/06/19/psysonic.html)

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
