<div align="center">
  <img src="public/psysonic-inapp-logo.svg" alt="Psysonic Logo" width="320"/>

## The Ultimate Desktop Client for Self-Hosted Music Libraries

**Fast. Beautiful. Native. Feature-packed.**
Built primarily for **Navidrome**. Also compatible with **Gonic**, **Airsonic**, **LMS** and other Subsonic-compatible servers with partial feature support.

<br>

<a href="https://github.com/Psychotoxical/psysonic/releases/latest"><img src="https://img.shields.io/github/v/release/Psychotoxical/psysonic?style=for-the-badge&label=Latest%20Release&color=8b5cf6" alt="Latest Release"></a> <a href="https://github.com/Psychotoxical/psysonic/stargazers"><img src="https://img.shields.io/github/stars/Psychotoxical/psysonic?style=for-the-badge&color=f59e0b" alt="GitHub Stars"></a> <a href="https://github.com/Psychotoxical/psysonic/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-22c55e?style=for-the-badge" alt="License GPLv3"></a> <a href="https://tauri.app/"><img src="https://img.shields.io/badge/Tauri-v2-0f172a?style=for-the-badge&logo=tauri" alt="Tauri v2"></a> <a href="https://discord.gg/AMnDRErm4u"><img src="https://img.shields.io/badge/Discord-Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord Community"></a> <a href="https://t.me/+GLBx1_xeH28xYTJi"><img src="https://img.shields.io/badge/Telegram-Community-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Community"></a> <a href="https://aur.archlinux.org/packages/psysonic"><img src="https://img.shields.io/badge/AUR-psysonic-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white" alt="AUR psysonic"></a> <a href="https://aur.archlinux.org/packages/psysonic-bin"><img src="https://img.shields.io/badge/AUR-psysonic--bin-1793d1?style=for-the-badge&logo=arch-linux&logoColor=white" alt="AUR psysonic-bin"></a> <a href="https://psysonic.cachix.org"><img src="https://img.shields.io/badge/Cachix-psysonic.cachix.org-5277C3?style=for-the-badge&logo=nixos&logoColor=white" alt="Cachix"></a>

<br><br>

**No telemetry • Native performance • Massive feature set • Community driven**

</div>

---

![Psysonic Screenshot](public/screenshot1.png)

---

> [!WARNING]
> Psysonic is under heavy active development. Bugs and rough edges are to be expected. We reserve the right to change, remove, or rework existing features at any time without prior notice.

## Server Compatibility

**Psysonic is optimized first and foremost for Navidrome.**

Many advanced functions integrate directly with Navidrome APIs for the best possible experience. Other Subsonic-compatible servers generally work well, but some features may be limited depending on server capabilities.

## Why Psysonic?

Most Subsonic clients feel like web wrappers.

**Psysonic does not.**

It is a true desktop experience built with **Rust**, **Tauri v2**, and **React** for users who care about speed, aesthetics, customization, and serious music library management.

If you host your own music, this is what the premium experience should feel like.

---

# Core Features

## Playback Engine

* Gapless playback
* Crossfade
* ReplayGain support
* Smart Loudness Normalization
* Infinite Queue
* Smart Radio sessions
* High responsiveness with low memory usage

## Audio Tools

* 10-band Equalizer
* Presets
* AutoEQ headphone correction
* Per-device optimization

## Library Power

* Lightning-fast search
* Albums / Artists / Tracks / Genres
* Ratings system
* Multi-select bulk actions
* Drag & drop playlist management
* Huge library friendly

## Lyrics & Discovery

* Synced lyrics with seek support
* Auto-scroll sidebar lyrics
* Fullscreen lyric mode
* Last.fm scrobbling
* Similar artists / love tracks / stats

## Personalization

* Huge theme collection
* Catppuccin / Nord inspired styles
* Glassmorphism effects
* Font customization
* Zoom controls
* Keybind remapping
* Theme Scheduler (day/night auto switch)

## Power User Extras

* CLI controls
* USB / portable sync
* Backup & restore settings
* In-app auto updater
* LAN / remote auto switching

---

# Orbit (Upcoming)

## Listen Together. In Sync. Soon.

Currently in final development and testing. Orbit will introduce synchronized shared listening sessions directly inside Psysonic.

* Host-controlled playback
* Join via link
* Shared listening sessions
* Guest song suggestions
* Real-time queue interaction

**Rolling out in an upcoming release. Community feedback will help shape the final experience.**

---

# Platforms

| OS      | Support                                                         |
| ------- | --------------------------------------------------------------- |
| Windows | Native Installer *(certificate pending)*                        |
| macOS   | Signed DMG                                                      |
| Linux   | AppImage / DEB / RPM / AUR (`psysonic`, `psysonic-bin`) / NixOS |

Supports **8 languages** and growing.

---

# Install

## Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Psychotoxical/psysonic/main/scripts/install.sh | sudo bash
```

## Windows

Download the latest installer from Releases.

> SmartScreen warnings may appear until the code-signing certificate is active.

## macOS

Download the signed DMG from Releases.

---

# Development

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

# Privacy First

* No telemetry
* No spyware nonsense
* No analytics harvesting
* Your library stays yours

---

# Community

Join Discord, report bugs, suggest features, share themes, shape the future.

---

# License

GNU GPL v3.0

---

<div align="center">

## Stop using boring music clients.

## Use Psysonic.

</div>
