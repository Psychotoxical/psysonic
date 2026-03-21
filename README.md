<div align="center">
  <img src="public/logo-psysonic.png" alt="Psysonic Logo" width="200"/>
  <h1>Psysonic</h1>
  <p><strong>A modern, gorgeous, and blazing fast desktop client for Subsonic API compatible music servers (Navidrome, Gonic, etc.).</strong></p>
  
  <p>
    <a href="https://github.com/Psychotoxical/psysonic/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/Psychotoxical/psysonic?style=flat-square&color=8839ef"></a>
    <a href="https://github.com/Psychotoxical/psysonic/blob/main/LICENSE"><img alt="License: GPL v3" src="https://img.shields.io/badge/License-GPLv3-cba6f7?style=flat-square"></a>
    <a href="https://tauri.app/"><img alt="Built with Tauri" src="https://img.shields.io/badge/Built%20with-Tauri-242938?style=flat-square&logo=tauri"></a>
    <a href="https://aur.archlinux.org/packages/psysonic"><img alt="AUR" src="https://img.shields.io/aur/version/psysonic?style=flat-square&color=1793d1"></a>
  </p>
</div>

---

Psysonic is a beautiful desktop music player built completely from the ground up for the modern era. Utilizing **Tauri v2** and **React**, it offers a native-feeling, lightweight, and incredibly fast experience with a stunning UI inspired by the [Catppuccin](https://github.com/catppuccin/catppuccin) and [Nord](https://www.nordtheme.com/) aesthetics.

Designed specifically for users hosting their own music via Navidrome or other Subsonic API servers, Psysonic aims to be the best way to interact with your personal library.


![Psysonic Screenshot](public/screenshot.png)

## ✨ Features

- 🎨 **Gorgeous UI**: 30 deeply integrated themes across 7 groups — Catppuccin, Nord, Retro (Gruvbox), Tokyo Night, Betriebssysteme (Cupertino, Aero Glass, Luna Teal), and Psysonic originals (WnAmp, Poison, Nucleo, Neon Drift…) — with smooth glassmorphism effects and micro-animations.
- ⚡ **Blazing Fast**: Built with Rust & Tauri — native audio engine (rodio), minimal RAM usage compared to typical Electron apps.
- 🌍 **Internationalization (i18n)**: Fully translated into English, German, French, and Dutch.
- 📻 **Live "Now Playing"**: See what other users on your server are currently listening to in real-time.
- 🎵 **Last.fm Integration** *(Beta)*: Direct scrobbling, Now Playing updates, love/unlove, Similar Artists, and top stats — no Navidrome configuration required.
- 💾 **IndexedDB Caching**: Ultra-fast loading times with persistent IndexedDB image caching for cover art and artist images.
- 📀 **Album Downloads**: Support for downloading entire albums directly to your local machine.
- 💿 **Album & Artist Views**: Beautiful grid displays and detailed artist pages with related albums and color-coded initial avatars for fast browsing.
- 〰️ **Waveform Seekbar**: Canvas-based waveform with a blue-to-mauve gradient and glow effect — click or drag anywhere to seek.
- 🎛️ **Queue Management**: Drag & drop reordering, shuffle, playlist saving/loading, and server-side queue synchronization.
- ⌨️ **Configurable Keybindings**: Rebind any playback action (play/pause, next, seek, volume…) directly in Settings.
- 🔤 **Font Picker**: 10 UI fonts to choose from in Settings → Appearance.
- 🎼 **Random Mix**: Generate a random playlist from your entire library. Filter by keyword or pick a Super Genre (Metal, Rock, Electronic, Jazz…) for a focused mix with progressive loading.
- 🔄 **Update Notifications**: Built-in update checker (on startup + every 10 minutes) that notifies you when a new version is available on GitHub.
- 🖥️ **Cross-Platform**: Available natively for Windows, macOS, and Linux (including Wayland support).

## 🗺️ Roadmap

### ✅ Completed
- [x] Native Rust/rodio audio engine (replaces Howler.js)
- [x] 10-band graphic EQ with built-in and custom presets
- [x] Crossfade between tracks
- [x] Replay Gain (track + album mode)
- [x] Gapless playback *(experimental)*
- [x] Waveform seekbar
- [x] Last.fm scrobbling, Now Playing & love/unlove *(beta)*
- [x] Similar Artists via Last.fm, filtered to library
- [x] Statistics — Last.fm top charts & recent scrobbles
- [x] Multi-server support
- [x] IndexedDB image caching
- [x] Random Mix with keyword filter & Super Genre mix
- [x] 30 themes across 7 groups: Catppuccin, Nord, Retro (Gruvbox), Tokyo Night, Betriebssysteme, Psysonic originals, Psysonic Mediaplayer
- [x] Internationalization (English, German, French, Dutch)
- [x] AUR package (Arch / CachyOS)
- [x] Configurable keybindings
- [x] Font picker (10 UI fonts)

### 🚧 In Progress
- [ ] **Last.fm integration** — stabilising, moving out of beta
- [ ] **Gapless playback** — edge case stabilisation
- [ ] **Crossfade** — stability improvements

### 📋 Planned
- [ ] FLAC seeking fix
- [ ] General UI polish & visual refinement
- [ ] More languages

---

## ● Known Limitations

- **Linux (drag & drop cursor feedback)**: Due to a WebKitGTK limitation, the drag cursor does not reflect the drop operation type — it may appear as a "forbidden" symbol or show no indicator at all, depending on the desktop environment. Drag and drop itself works correctly.
- **FLAC seeking**: Jumping to a position in a FLAC file via the waveform seekbar currently does not work. Seeking in MP3, OGG, and other formats is unaffected. This is a known issue and will be investigated.

## 📥 Installation

Navigate to the [Releases](https://github.com/Psychotoxical/psysonic/releases) page and download the installer for your operating system.

- **Windows**: `.exe` or `.msi`
- **macOS**: `.dmg` (Universal or Apple Silicon)
- **Linux (Ubuntu/Debian)**: `.deb` from GitHub Releases
- **Linux (Fedora/RHEL)**: `.rpm` from GitHub Releases
- **Linux (Arch/CachyOS)**: AUR — `yay -S psysonic` or `paru -S psysonic`

> The AUR package builds from source using your system's own WebKitGTK — no bundled libs, no EGL/Mesa compatibility issues.

## 🚀 Getting Started

1. Download and install Psysonic.
2. Open the app and enter your Subsonic/Navidrome server details (URL, Username, Password).
3. If applicable, you can provide both an external URL and a local LAN IP. Psysonic allows you to quickly toggle between them in the Settings.
4. Enjoy your music!

## 🛠️ Development

If you want to build Psysonic from source or contribute to the project:

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/) (v1.75+)
- OS-specific build dependencies for Tauri (see the [Tauri prerequisites guide](https://tauri.app/v2/guides/getting-started/prerequisites)).

### Setup

```bash
# Clone the repository
git clone https://github.com/Psychotoxical/psysonic.git
cd psysonic

# Install node dependencies
npm install

# Run in development mode
npm run tauri:dev

# Build for production
npm run tauri:build
```

## 🤝 Contributing

Contributions are completely welcome! Whether it is translating the app into a new language, fixing a bug, or proposing a new feature.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

Distributed under the **GNU General Public License v3.0**. See `LICENSE` for more information.

This means: you are free to use, study, and modify Psysonic. If you distribute a modified version, you must release it under the same GPL v3 license and keep the original copyright notice intact. You may **not** incorporate this code into proprietary software.
