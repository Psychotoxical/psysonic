# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.8] - 2026-03-13

### Added
- **Ambient Stage**: Completely redesigned Fullscreen Player. Experience an immersive atmosphere with drifting color orbs, a "breathing" cover animation, and high-resolution artist backgrounds.
- **Improved Drag & Drop**: Rewritten Play Queue reordering for rock-solid reliability on macOS (WKWebView) and Windows (WebView2).

### Fixed
- **Linux Audio Stability**: Resolved playback stuttering when seeking under GStreamer by implementing a robust pause-seek-play sequence.
- **Data Integration**: Standardized `artistId` propagation across all track sources for better metadata consistency.

## [1.0.7] - 2026-03-13

### Added
- **Update Notifications**: Integrated a native update check system in the sidebar that notifies you when a new version is available on GitHub.
- **Improved Settings**: Refined layout and styling for a cleaner settings experience.

### Fixed
- **UI/UX Refinements**: Polished sidebar animations and layout for better visual consistency.
- **i18n**: Added missing translations for update notifications and system status.

## [1.0.6] - 2026-03-13

### Added
- **Extended Themes**: Selection expanded to 8 themes, including the complete Nord series (Nord, Snowstorm, Frost, Aurora).
- **Light Theme Support**: Enhanced readability for Hero and Fullscreen Player components when using light themes (Latte, Snowstorm).

### Fixed
- **Linux/Wayland Compatibility**: Fixed immediate crash on Wayland environments by forcing X11 backend for the AppImage.
- **Playback Stability**: Introduced seek debouncing to prevent audio stalls on Linux/GStreamer.
- **Windows Integration**: Improved drag-and-drop compatibility for systems using WebView2.

## [1.0.5] - 2026-03-12

### Added
- **Image Caching**: Integrated IndexedDB-based image caching for cover art and artist images, providing significantly faster loading times for frequently accessed items.
- **Improved Artist Discovery**: Faster scrolling in the Artists list using color-coded initial-based avatars for quick visual identification.
- **Random Albums**: New discovery page for exploring your library with random album selections.
- **Help & Documentation**: Added a dedicated help page for better user onboarding.

### Changed
- **Optimized UI**: Instant "Now Playing" status updates via local state filtering for a more responsive experience.
- **Enhanced Data Flow**: General performance improvements in server communication and state management.

## [1.0.4] - 2026-03-12

### Added
- **Album Downloads**: Support for downloading entire albums with real-time progress tracking.

### Fixed
- **Linux GPU Compatibility**: Patched AppImage to disable DMABUF renderer, fixing EGL/GPU crashes on older hardware.
- **CI/CD Reliability**: Optimized release workflow with split jobs for better stability across platforms.

## [1.0.3] - 2026-03-12

### Fixed
- **CI/CD Build**: Resolved build conflicts on Ubuntu 22.04 by removing redundant dev packages (`libunwind-dev`, gstreamer dev).
- **Linux AppImage**: Configured GStreamer bundling and verified runtime environment settings.

## [1.0.2] - 2026-03-11

### Fixed
- **Linux AppImage**: Integrated GStreamer bundling fix in CI/CD workflow.
- **CI/CD Reliability**: Set `APPIMAGE_EXTRACT_AND_RUN=1` to prevent FUSE-related issues.

## [1.0.1] - 2026-03-11

### Fixed
- **Optimized Codebase**: Integrated core fixes and performance improvements.
- **Improved Multi-Server Support**: Fixed edge cases in server switching and credential management.
- **Enhanced Security**: Switched to `crypto.getRandomValues()` for more robust auth salt generation.
- **Connection Reliability**: Added pre-verification for server connections to prevent state synchronization issues.
- **Linux Compatibility**: Applied workarounds for WebKitGTK compositing issues on Linux.

### Changed
- Repository maintenance and preparation for the 1.0.1 release.

## [1.0.0] - 2026-03-09

### Added
- **Initial Public Release**: The first stable release of Psysonic.
- **Subsonic/Navidrome API**: Full integration for browsing library, artists, albums, and playlists.
- **Audio Playback**: Modern audio engine powered by Howler.js with support for various codecs.
- **Queue Management**: Persistent play queue with drag-and-drop reordering and server-side synchronization.
- **Secured Credentials**: Industry-standard security using Tauri's encrypted store for authentication tokens.
- **Design System**: Premium aesthetics based on the Catppuccin palette (Mocha & Latte themes).
- **Multi-Language**: Full localization support for English and German.
- **Fullscreen Mode**: Dedicated immersive player view with high-res album art.
- **Last.fm Scrobbling**: Built-in support for track scrobbling to Last.fm via Navidrome.
- **System Integration**: Native tray icon support, minimize-to-tray, and global media key handling.
- **Intelligent Networking**: Automatic or manual switching between LAN (Local) and External (Internet) addresses.
- **Live Now Playing**: Real-time view of what other users or players are streaming on your server.
- **Search**: Fast, real-time search for songs, albums, and artists.

### Security
- **Hardened Sandbox**: Restricted filesystem permissions to only necessary download/cache directories.
- **API Lockdown**: Disabled global Tauri objects to mitigate XSS risks.
- **Credential Storage**: Replaced insecure `localStorage` with a native encrypted store.

### Fixed
- Fixed a memory leak in the track prefetching engine.
- Improved Error handling for unstable Subsonic server responses.
