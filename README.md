<div align="center">
  <img src="public/logo.png" alt="Psysonic Logo" width="200"/>
  <h1>Psysonic</h1>
  <p><strong>A modern, gorgeous, and blazing fast desktop client for Subsonic API compatible music servers (Navidrome, Gonic, etc.).</strong></p>
  
  <p>
    <a href="https://github.com/Psychotoxical/psysonic/releases/latest"><img alt="Latest Release" src="https://img.shields.io/github/v/release/Psychotoxical/psysonic?style=flat-square&color=8839ef"></a>
    <a href="https://github.com/Psychotoxical/psysonic/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Psychotoxical/psysonic?style=flat-square&color=cba6f7"></a>
    <a href="https://tauri.app/"><img alt="Built with Tauri" src="https://img.shields.io/badge/Built%20with-Tauri-242938?style=flat-square&logo=tauri"></a>
  </p>
</div>

---

Psysonic is a beautiful desktop music player built completely from the ground up for the modern era. Utilizing **Tauri v2** and **React**, it offers a native-feeling, lightweight, and incredibly fast experience with a stunning UI inspired by the [Catppuccin](https://github.com/catppuccin/catppuccin) aesthetic. 

Designed specifically for users hosting their own music via Navidrome or other Subsonic API servers, Psysonic aims to be the best way to interact with your personal library.

![Psysonic Screenshot](public/screenshot.png)

## ✨ Features

- 🎨 **Gorgeous UI**: Deeply integrated Catppuccin themes (Mocha & Latte) with smooth glassmorphism effects and micro-animations.
- ⚡ **Blazing Fast**: Built with Rust & Tauri, resulting in minimal RAM usage compared to typical Electron apps.
- 🌍 **Internationalization (i18n)**: Fully translated into English and German (v1.0.0).
- 📻 **Live "Now Playing"**: See what other users on your server are currently listening to in real-time.
- 🎵 **Last.fm Scrobbling**: Full integration for scrobbling your tracks via the Navidrome server.
- 💾 **Local Caching**: Fast loading times with customizable image caching thresholds.
- 💿 **Album & Artist Views**: Beautiful grid displays and detailed artist pages with related albums.
- 🎛️ **Queue Management**: Drag & drop support, playlist saving, and loading directly built into the queue. Server-side queue synchronization is fully supported.
- 🖥️ **Cross-Platform**: Available natively for Windows, macOS, and Linux.

## 🛡️ Security

With the **v1.0.0 Release**, Psysonic has been hardened for public use:
- **Secured Credentials**: Industry-standard security using Tauri's native encrypted store.
- **Hardened Sandbox**: Restricted filesystem permissions to only necessary directories.
- **Native Security**: Disabled global Tauri objects to significantly reduce XSS attack vectors.

## 📥 Installation

Navigate to the [Releases](https://github.com/Psychotoxical/psysonic/releases) page and download the installer for your operating system.

- **Windows**: `.exe` or `.msi`
- **macOS**: `.dmg` (Universal or Apple Silicon)
- **Linux**: `.AppImage` or `.deb`

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

Distributed under the MIT License. See `LICENSE` for more information.
