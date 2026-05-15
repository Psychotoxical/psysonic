# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **🛡️ A note on safety investments:** Making sure Psysonic is trusted on every OS takes real money out of my pocket — an Apple Developer Account (now active, which is why macOS builds are signed + notarized for everyone starting with this release) and a Windows code-signing certificate (ordered, currently in validation). If you'd like to help cover those costs, you can chip in at [ko-fi.com/psychotoxic](https://ko-fi.com/psychotoxic) — completely voluntary, no pressure at all. Every bit helps keep Psysonic free and safe across Windows, macOS and Linux.
>
> **⚠️ Windows users:** This is one of the last releases with an unsigned Windows installer. Until the certificate clears validation, any SmartScreen or antivirus warning on the installer is a false positive — the binary itself is safe.
>
> **🎉 macOS users:** Starting with **v1.40.0**, Psysonic is signed + notarized and can **update itself silently**. No more DMG downloading and dragging to Applications — the updater fetches the signed `.app` bundle, verifies the signature, replaces the app in place, and relaunches. Just click "Install now" when the update notification appears.
>
> **📦 Version jump 1.34.x → 1.40.0:** The 1.34.x patch series was bumped a lot as each small feature landed. 1.40.0 consolidates the last few weeks of work — macOS signing + auto-updater, the Device-Sync overhaul, theme work and contrast audits — into a single coherent release. The next major bump (2.0.0) is planned once Windows code-signing + Windows auto-updater are active as well.


## [1.46.0] - 2026-05-05

## Under the Hood — Refactoring & Test Suite

**By [@cucadmuh](https://github.com/cucadmuh) + [@Psychotoxical](https://github.com/Psychotoxical)**

Alongside the user-facing changes, this release closes out a large engineering effort that touched almost every corner of the codebase. None of it changes how Psysonic behaves — it changes how fast and how safely the next features can land.

* **Backend → Cargo workspace.** The Rust backend was lifted out of a single crate into five focused domain crates — audio, analysis, sync/offline, integrations and core. See *Backend — Cargo workspace with 5 domain crates* under **Changed** below for the full breakdown.
* **Frontend modularization.** The largest "god-module" components, stores and stylesheets were broken into small, single-purpose files, shared helpers were deduplicated, and the i18n locale and CSS bundles were split per namespace. See *Frontend — large modules split into focused files* under **Changed** below for the full breakdown.
* **Automated test suite.** Psysonic now ships with a real test suite on both sides — `cargo test` across the Rust workspace and a Vitest suite on the frontend — backed by per-file coverage gates in CI that block a merge when a hot-path file regresses below threshold. Playback, queue, auth, the offline cache, the API layer and the core UI components are now pinned by characterization tests.

Foundational work: faster reviews, narrower diffs, and a safety net under the parts of the app that matter most.

## Added

### HTTP — gzip + brotli decompression for the Rust-side clients

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#704](https://github.com/Psychotoxical/psysonic/pull/704)**

* Every HTTP client on the Rust side now advertises `Accept-Encoding` and transparently decodes compressed responses. The JSON-heavy endpoints — Navidrome native `/api`, Bandsintown, Radio-Browser, Last.fm — were the gap: the WebView's `axios` calls were already compressed, the Rust clients were not. Earlier curl measurements put the wire savings on those payloads at roughly **76–93 %**.
* Implementation is a dependency-feature change only (`gzip` + `brotli` on `reqwest`) — no behaviour change beyond smaller transfers, and no extra cost on the clients that fetch already-compressed audio.

### Queue Toolbar — customizable button order + per-button visibility

**By [@kveld9](https://github.com/kveld9), PR [#534](https://github.com/Psychotoxical/psysonic/pull/534)**

* **Settings → Personalisation** grows a new **Queue Toolbar** section. Drag-and-drop reorders the toolbar buttons; a per-button toggle hides individual entries; a **Separator** item can be placed anywhere to break the row into visual groups. A **Reset** button restores the default layout.
* Persistence via a new `queueToolbarStore` (Zustand + localStorage), so the layout survives restarts.
* Behaviour-preserving default: `[Shuffle] [Save] [Load] [Share] [Clear] | [Gapless] [Crossfade] [Infinite]` — same buttons in the same order as before.
* Auto-hides the toolbar when no real button is visible (a lone Separator no longer takes up space on its own).
* i18n coverage across all 9 locales.

### Orbit — in-app diagnostics popover with copyable event log

**By [@Psychotoxical](https://github.com/Psychotoxical), prompted by reports from nzxl + RavingGrob, PR [#524](https://github.com/Psychotoxical/psysonic/pull/524)**

* New **Activity-icon** button in the Orbit session bar opens a diagnostics popover. Live mini-display (role, host vs. guest track, position, drift, state-age) updates once a second; below it, a scrolling **event log textarea** is fed by a 200-entry in-memory ring buffer.
* **Copy** + **Clear** buttons. Copy drops formatted `[ISO] [scope] body` lines on the clipboard — paste straight into a Discord bug report.
* Instrumentation lands at every previously-silent decision point in the guest tick (`initial-sync`, `track-change` followed / diverged, `play-pause-flip`) plus host state pushes, so the "stopped after the first song" Orbit symptom is now diagnosable from the buffer alone.
* Events are also bridged to the existing `frontend_debug_log` command when **Settings → Logging** is on Debug, so power users still get the same data in `psysonic-logs-*.log` for offline triage.
* i18n: full `orbit.diag.*` namespace across all 9 locales (EN + DE native; RO native; ES / FR / NB / NL / RU / ZH first-pass, polish welcome).

### Player Bar — album context menu on song title right-click

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#512](https://github.com/Psychotoxical/psysonic/pull/512)**

* Right-clicking the **track title** in the player bar now opens the same album context menu that album cards expose — open, play next, enqueue, go to artist, favorite, rate, share, download, add to playlist.
* Mirrors the existing left-click on the title (which already navigates to the album) and is suppressed during radio playback and previews.

### Settings — OpenDyslexic font option for dyslexic readers

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#507](https://github.com/Psychotoxical/psysonic/pull/507)**

* Next step on the accessibility track after the colour-side work (WCAG contrast audits across every theme, dedicated colour-vision-deficiency theme variants for protanopia / deuteranopia / tritanopia): a dyslexia-friendly **OpenDyslexic** font option in the existing font picker.
* OpenDyslexic uses a heavier weighted baseline and asymmetric glyph shapes — `b`/`d`, `p`/`q` never mirror, italics are differentiated forms rather than slanted regulars — which many dyslexic readers find easier to track than a typical sans.
* Bundled locally via `@fontsource/opendyslexic` (SIL OFL, freely redistributable). No CDN dependency. The Settings picker grew an optional **subtitle** field on font entries so the OpenDyslexic row carries a "dyslexia-friendly · no RU/ZH support" hint without cluttering the other 14 fonts.
* **Latin, Latin-extended and Cyrillic.** Chinese (ZH) falls back to the system font when OpenDyslexic is selected; the subtitle calls that out upfront. Subtitle text is translated in all 9 locales.

### Lossless Albums — rail on Home + dedicated page + sidebar entry

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#506](https://github.com/Psychotoxical/psysonic/pull/506)**

* New **Lossless Albums** browse mode: a rail under "Most Played" on Home and a dedicated infinite-scroll **`/lossless-albums`** page with full Albums-page header parity (selection mode + Enqueue / Add Offline / Download ZIPs).
* Detection walks Navidrome's native `/api/song?_sort=bit_depth&_order=DESC` and dedupes to album ids along the way, stopping when the cursor crosses into lossy or runs out. Restricted to containers that are **always lossless** (`flac`, `wav`, `aiff`/`aif`, `dsf`/`dff`, `ape`, `wv`, `shn`, `tta`) — `m4a` and `wma` are intentionally excluded because they can carry both lossless and lossy codecs and Navidrome's `codec` field isn't reliable enough to disambiguate.
* Streaming load: albums stream into the page progressively as each internal fetch completes (`onProgress` callback) instead of blocking on the full `loadMore`.
* New sidebar entry **Lossless** (Gem icon), visible by default.
* i18n coverage across all 9 locales for the new strings (sidebar / home / page subtitle / empty / unsupported). RU and ZH are machine-translation quality, flagged for a polish pass.

### Song Info — absolute file path on Navidrome servers

**By [@Psychotoxical](https://github.com/Psychotoxical), suggested by volcs0, PR [#504](https://github.com/Psychotoxical/psysonic/pull/504)**

* The **Path** row in the Song Info dialog now shows the **absolute server-side filesystem path** of a track on Navidrome servers. Subsonic's `getSong` only ever returned a relative path (or nothing at all on Navidrome), which is why the row was effectively empty before. A new native-API call (`/api/song/{id}`) runs in parallel with `getSong`; on non-Navidrome servers the dialog falls back to whatever the Subsonic response carried.



### Discord — album cover art from your own server

**By [@Sayykii](https://github.com/Sayykii), PR [#462](https://github.com/Psychotoxical/psysonic/pull/462)**

* Discord Rich Presence can now show **album artwork from your own server** via the Subsonic `getAlbumInfo2` endpoint (requires the server to be publicly reachable).
* New cover-source picker under Discord Rich Presence settings: **None** (app icon only), **Server**, or **Apple Music**. Mutually exclusive.
* Fresh installs default to **Server** for opt-in-friendly cover art with no third-party data leak. Existing users keep their previous Apple-covers preference via migration.

### Queue — preserve "Play Next" insertion order (toggle)

**By [@Psychotoxical](https://github.com/Psychotoxical), suggested by [@Sayykii](https://github.com/Sayykii), PR [#464](https://github.com/Psychotoxical/psysonic/pull/464)**

* New optional toggle in Settings → Audio → Playback ("Preserve Play Next order"). When on, multiple "Play Next" insertions **queue up behind each other** instead of the latest one bumping earlier picks down. Default off — existing behaviour unchanged.
* Side-benefit: single-song "Play Next" now goes through the unified `enqueueAt` path and gets undo + server-sync support that the album path already had.

### Library — "favorites only" filter on Albums, Artists and Advanced Search

**By [@Psychotoxical](https://github.com/Psychotoxical), suggested by [@lilgringo](https://github.com/lilgringo), PR [#466](https://github.com/Psychotoxical/psysonic/pull/466)**

* New star-toggle button in the toolbars of **Albums**, **Artists** and **Advanced Search** that flips the visible list to favourites-only.
* Filter state is ephemeral per page (not persisted) so users don't come back to a half-empty library and wonder where their content went.
* Reads star state live from in-memory overrides — toggling a favourite from a context menu updates the visible list immediately, no refetch.

### Search — artist photos in live and mobile results

**By [@cucadmuh](https://github.com/cucadmuh), PR [#470](https://github.com/Psychotoxical/psysonic/pull/470)**

* **Live search** and the **mobile search overlay** now load **artist images** for rows in the **Artists** section via the same **`getCoverArt` / image-cache path** as album art (**`coverArt`** when present, otherwise the **artist id** where the server supports it), with a **fallback icon** when art is missing or fails.
* **Mobile** artist hits use a **round** thumbnail next to **square** album art so the two result types read clearly at a glance.

### Artist page — group albums by release type

**By [@Sayykii](https://github.com/Sayykii), PR [#471](https://github.com/Psychotoxical/psysonic/pull/471)**

* Albums on the artist page can now be **grouped into sections** by their OpenSubsonic `releaseTypes` (Album, EP, Single, Compilation, Live, Soundtrack, Remix). Section order is deterministic across languages, with unknown types appended at the end.
* Falls back to the previous flat list when the server doesn't return `releaseTypes` or all albums share the default Album type — no behaviour change for non-OpenSubsonic servers.
* Section headers are localised in all 9 supported languages.

### Library — Browse by Composer

**By [@Psychotoxical](https://github.com/Psychotoxical), suggested by mmourez ([issue #465](https://github.com/Psychotoxical/psysonic/issues/465)), PR [#487](https://github.com/Psychotoxical/psysonic/pull/487)**

* New **Composers** library section listing every artist credited as composer on at least one track, with a detail page showing all works they hold in that role. Aimed at classical-music libraries where the recording artist is the orchestra and the composer tag carries Bach / Mozart / Chopin.
* Uses Navidrome's native API (`/api/artist?_filters={"role":"composer"}` for the listing, `/api/album?_filters={"role_composer_id":"…"}` for the works) — Subsonic `getArtist` only walks AlbumArtist relations and returns zero albums for composer-only credits, so the native path is the only one that works. Requires **Navidrome 0.55+**; older / pure-Subsonic servers see a one-line capability banner.
* Music-folder scope is honoured: role queries pass Navidrome's `library_id` filter so per-folder browsing matches the Albums / Artists pages. Bio + Last.fm portrait stay stable across scope changes.
* **Composers are a first-class share entity.** `psysonic2-` links with `k=composer` paste to `/composer/:id`; the Share button on the detail page and the right-click menu both copy a `composer` link.
* Sidebar entry is **off by default** (classical-music use case is a niche) — toggle in Settings → Sidebar.

### Home — "Because you listened" recommendation rail

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#489](https://github.com/Psychotoxical/psysonic/pull/489), [#493](https://github.com/Psychotoxical/psysonic/pull/493)**

* New Home rail that surfaces albums **similar to one of your favourite artists** — Spotify-style "Because you listened to …" recommendations.
* Anchor pool round-robin merges **Most Played**, **Recently Played** and **Favorites** (deduped per artist), so the per-mount rotation lands on a different listening *mode* each visit instead of walking only the top-played list. Pool size **12** lets the cursor visit all three sources before wrapping. Within each anchor, `getArtistInfo` returns up to **12** similar artists; the rail randomly samples **6** of them and surfaces **3** albums (one random per matching artist) that exist on your server.
* Anchor rotation is **per-server**: switching servers keeps independent rotation state instead of aliasing one server's anchor id onto the next server's pool. The rail also renders on fresh servers that have no frequent-play history yet, as long as they have starred or recently played items. Zero extra API calls — all three seed lists are already in the Home initial fetch.
* **Responsive layout:** **3** cards in one row on 2K-class screens, **2** cards in one row at 1080p (the orphan third card on a second row is hidden via container query), and all **3** stacked vertically on truly narrow / mobile widths.
* Toggleable in the Home customizer like every other rail; respects the existing performance flags ("Disable rail artwork", "Disable Home album rows").

### Romanian (ro) translation

**By [@MihaiCatalin120](https://github.com/MihaiCatalin120), PR [#663](https://github.com/Psychotoxical/psysonic/pull/663)**

* Complete Romanian (`ro`) locale for navigation, player, playlists, settings, help, and errors.
* Psysonic now ships in **nine** UI languages: English, German, Spanish, French, Dutch, Norwegian Bokmål, Russian, Chinese (Simplified), and Romanian.

### Search — queue pasted share links from Live Search and mobile search

**By [@cucadmuh](https://github.com/cucadmuh), inspired by [@DanielWTE](https://github.com/DanielWTE)'s [PR #551](https://github.com/Psychotoxical/psysonic/pull/551), PR [#716](https://github.com/Psychotoxical/psysonic/pull/716)**

* Pasting a `psysonic2-` share link into **Live Search** or the **mobile search overlay** shows a dedicated share row: track and queue links **enqueue** (append) instead of replacing the queue like global paste does; album, artist, and composer links preview metadata **without switching the active server**, then navigate on confirm.
* Queue share links expose a **Preview** action that opens a scrollable track list (resolved lazily against the share server) before **Add to queue** (Live Search / mobile search) or **Play queue** (global Ctrl+V paste).
* Shared tracks and queues resolve against the matching saved server via explicit credentials; `orbitBulkGuard` applies before bulk enqueue.
* i18n: `search.share*` keys across all 9 locales.

### Settings — Advanced Mode toggle + playlist page layout

**By [@kveld9](https://github.com/kveld9) + [@Psychotoxical](https://github.com/Psychotoxical), PR [#556](https://github.com/Psychotoxical/psysonic/pull/556)**

* **Advanced Mode.** A new toggle in the Settings header reveals advanced sub-sections across all tabs. Sub-sections marked advanced are hidden by default and labelled with a small badge when shown — community-contributed options that do not necessarily reflect the design philosophy of the Psysonic maintainers, kept available but out of the way. The three current advanced sub-sections live under **Personalisation**: Artist page sections, Queue Toolbar, and the new Playlist page layout.
* **Playlist page layout.** New sub-section that hides individual elements on the playlist page: **Add Songs**, **Import CSV**, **Download ZIP**, **Cache Offline**, and the **Suggestions** rail at the bottom. Persisted via a new `playlistLayoutStore` (Zustand + localStorage); all toggles on by default so existing playlists look unchanged.
* **One-time migration:** if you had previously opened the per-tab Advanced group or customised any of the three sub-sections, Advanced Mode is auto-enabled on first launch — your existing tweaks stay visible.
* i18n: `settings.advancedMode`, `settings.advancedModeTooltip`, `settings.advancedBadge`, and `settings.playlistLayout*` across all 9 locales.

### Offline Library — show cached albums from all servers

**By [@cucadmuh](https://github.com/cucadmuh), PR [#719](https://github.com/Psychotoxical/psysonic/pull/719)**

* **Offline Library** lists every cached album across all saved servers, not only the currently active one. Cover art loads from each album's source server; play and enqueue switch to that server when needed.
* Sidebar entry, mobile **More** menu, disconnect auto-navigation, and the offline banner treat **any** cached content as available offline. With multiple servers, cards show which server the album came from.

### Settings → Personalisation — player bar layout

**By [@kveld9](https://github.com/kveld9) + [@Psychotoxical](https://github.com/Psychotoxical), inspired by [@kveld9](https://github.com/kveld9)'s [PR #627](https://github.com/Psychotoxical/psysonic/pull/627), PR [#TBD](https://github.com/Psychotoxical/psysonic)**

* New sub-section that hides individual controls in the player bar: **Star rating**, **Favorite (heart)**, **Last.fm love**, **Equalizer**, **Mini player**. Last.fm love is still only shown when a Last.fm session exists; the overflow row only renders when either Equalizer or Mini player is enabled. Persisted via a new `playerBarLayoutStore` (Zustand + localStorage, same `items[{id, visible}]` pattern as the queue toolbar and playlist layout); all toggles on by default.
* Lives under the **Advanced** group in Personalisation (only visible when the global Advanced Mode toggle is on).
* i18n: `settings.playerBar*` across all 9 locales.

## Changed

### Backend — Cargo workspace with 5 domain crates (Rust refactor)

**By [@cucadmuh](https://github.com/cucadmuh) + [@Psychotoxical](https://github.com/Psychotoxical), PR [#532](https://github.com/Psychotoxical/psysonic/pull/532)**

* The Rust backend was lifted out of a single `psysonic` crate into a **Cargo workspace** with five domain crates: `psysonic-core` (logging + ports), `psysonic-analysis` (waveform + LUFS cache + admin commands), `psysonic-audio` (engine, decode, sources, codec, stream sub-modules, audio Tauri commands), `psysonic-syncfs` (offline + hot cache + downloads + USB/SD sync), `psysonic-integration` (Discord rich-presence, Navidrome native API, Last.fm scrobbling, internet-radio browsing, Bandsintown). The top `psysonic` crate keeps only the Tauri-shell wiring.
* `lib.rs` shrank from ~1000+ LOC to **454 LOC**, retaining only Tauri-shell concerns (setup hook, plugin registration, window events, tray builder).
* The Audio→Analysis circular-dependency loop is broken via two `Arc<dyn Fn(&str) -> bool>` closures registered in `lib.rs:setup`, avoiding what would have been a 32-callsite migration to `State<Arc<AudioEngine>>`.
* **No user-visible behaviour change.** Automated parity check confirmed **121/121 Tauri commands** resolve identically vs. the pre-refactor tree; `cargo check --workspace` and `cargo clippy --workspace --all-targets` are clean; smoke tests pass on Linux, Windows, and macOS.
* Foundation work — per-domain bug fixes and features now ship with much narrower diff scope (this release's Orbit batch + waveform fixes were the first to benefit).

### Frontend — large modules split into focused files (React/TypeScript refactor)

**By [@cucadmuh](https://github.com/cucadmuh) + [@Psychotoxical](https://github.com/Psychotoxical)**

* The frontend counterpart to the backend workspace split: across roughly a hundred follow-up PRs, the largest "god-module" page components, stores and stylesheets were broken into small, single-purpose files. The biggest offenders — `QueuePanel`, `FullscreenPlayer`, `MiniPlayer`, `PlayerBar`, `AppShell`, `AlbumTrackList`, the context menu, the waveform seekbar and `utils/orbit.ts` among them — each went from one oversized file to a folder of focused components, hooks and helpers.
* Shared logic that had been copy-pasted across call sites — duration / byte formatters, sanitizers, clock helpers, shuffle and dedupe routines — was consolidated into single `utils/` helpers, and the remaining `utils/` files were grouped into topic folders.
* The monolithic `i18n` locale files and the global CSS bundles (`theme.css`, `components.css`, `layout.css`, `tracks.css`) were split per namespace / per section, so editing one feature's strings or styles no longer means touching a multi-thousand-line file.
* **No user-visible behaviour change.** Every step was a pure code move verified by `tsc`, the Vitest suite and a production build; the new automated test suite (see *Under the Hood* above) was built out alongside the refactor specifically to pin behaviour while files were in motion.
* Foundation work — same payoff as the backend split: feature and bug-fix diffs now land with far narrower scope, and the frontend's hottest paths are covered by tests.

### Settings — collapse-by-default cleanup, font picker without dropdown, OpenDyslexic at top

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#508](https://github.com/Psychotoxical/psysonic/pull/508)**

* Every Settings sub-section now boots **collapsed**. Audio Device, Lyrics Sources, Last.fm, Sidebar, Random Mix, Offline Dir, Theme, Keybindings and Language used to auto-expand on first render — each tab felt like a wall of controls before the user had even looked for something specific. Click the section header to open what you actually need.
* **ThemePicker** no longer auto-expands the group containing the active theme. The blue dot in the group header already surfaces which group holds it.
* **Font picker** lost its inner dropdown button. Opening the Font sub-section now reveals the full font list directly; one click sets the font.
* **OpenDyslexic** moves to the top of the font list so dyslexic readers don't scroll past 14 sans-serifs to find their option.

### Settings — language picker uses endonyms

**By [@Psychotoxical](https://github.com/Psychotoxical), suggested by cucadmuh, PR [#514](https://github.com/Psychotoxical/psysonic/pull/514)**

* The Settings language picker now shows each language **written in itself** — `English`, `Deutsch`, `Español`, `Français`, `Nederlands`, `Norsk`, `Русский`, `中文`, `Română` — same nine labels in every locale instead of translating each name into the current UI language.
* A native speaker can recognise their own language regardless of which UI language is currently active; same convention used by Wikipedia and most OS-level language pickers.
* Filled in `languageEs` for the six locales (de/fr/nl/nb/ru/zh) where it was missing — the Spanish entry was previously falling back to `'Spanish'` from `en.ts` on every non-EN/non-ES UI.

### Dependencies — npm / Cargo refresh and rodio 0.22

**By [@cucadmuh](https://github.com/cucadmuh), PR [#463](https://github.com/Psychotoxical/psysonic/pull/463)**

* Bumped **frontend** and **Tauri / Rust** dependencies across the workspace (`package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`).
* Playback stack migrated to **rodio 0.22** with corresponding updates in decode, sources, engine, device I/O and related modules.

### Build — lazy-loaded routes and Vite chunk warnings

**By [@cucadmuh](https://github.com/cucadmuh), PR [#463](https://github.com/Psychotoxical/psysonic/pull/463)**

* Heavier app **routes** are loaded **lazily** so the initial JS bundle stays smaller (`App.tsx` and related entry wiring).
* Restored **default Vite `chunkSizeWarningLimit`** behaviour so oversized chunks are reported again during production builds (`vite.config.ts`).

### UI — cover cache, mainstage rails, and smoother virtual lists

**By [@cucadmuh](https://github.com/cucadmuh), PR [#468](https://github.com/Psychotoxical/psysonic/pull/468)**

* **Image cache:** **Network fetches** share a small concurrency pool; **IndexedDB** hits are no longer queued behind remote downloads. **Debounced** disk eviction avoids hammering storage during fast cover scrolling. Related **shared blob URL** / hot-path fixes for thumbnails.
* **Mainstage & rails:** **Horizontal rows** use **reworked artwork windowing** (higher initial budgets, extra slack ahead of the viewport, **no budget reset** when “load more” extends the list). **Duplicate album/song IDs** from the API are **deduped** for stable React reconciliation. **CachedImage** handles **already-decoded / cache-hit** images cleanly; rail **Album / song cards** load covers **eagerly** to reduce **blank art** while scrubbing sideways.
* **Virtualised lists:** **Albums**, **Artists** (list mode), and the **Tracks** virtual song browser **derive** **TanStack Virtual `overscan`** from the **measured scroll viewport** (~ **one screen** of extra rows above and below) instead of a tiny fixed cushion.
* **Library & chrome:** assorted **scroll / layout** improvements on **Artist detail**, **Playlists**, **Most played**; smaller touch-ups to **Mini player**, **Live search**, **Album header**, and **dynamic colour** extraction used by player / album surfaces.

### Covers / image cache — parallel fetch + downscale, registry guard, search slot hints

**By [@cucadmuh](https://github.com/cucadmuh), PR [#470](https://github.com/Psychotoxical/psysonic/pull/470)**

* When a **pixel size** misses **disk** but **another size** of the same **`cover:id` is already cached**, **remote `getCoverArt`** and **client JPEG downscale** run in **parallel**; the **first good blob wins** and the other side **aborts** (network + downscale **signals**).
* **Sibling key reads** use **one IndexedDB readonly transaction** instead of many separate transactions.
* **`COVER_ART_REGISTERED_SIZES`** centralises known **`getCoverArt` widths** for **invalidation** and sibling lookup; **`coverArtRegisteredSizes.test.ts`** (**Vitest**) keeps **literal** `coverArtCacheKey(_, n)` call sites in **`src`** in sync with that list.
* **`downscaleCoverBlob`** respects **AbortSignal** through **`canvas.toBlob`**.
* **`CachedImage`:** **`fetchQueueBias`** gives **artist** search thumbs **higher network-slot priority** than **album** thumbs when the pool is saturated; **`observeRootMargin`** defaults **wider** so **priority** updates **earlier** ahead of the scroll viewport.

### Settings — adding a server no longer switches to it

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#475](https://github.com/Psychotoxical/psysonic/pull/475)**

* When you add a new server from **Settings → Servers**, the new entry now appears in the server picker but **your current active server stays active** — playback, queue and library view are no longer interrupted.
* The login screen on `/login` is unchanged: signing in there still selects the chosen server.

### Most Played — quick actions, real context menu, prominent plays badge

**By [@Psychotoxical](https://github.com/Psychotoxical), suggested by nzxl, PR [#482](https://github.com/Psychotoxical/psysonic/pull/482)**

* Each album row now shows always-visible **Play** and **Enqueue** quick-action buttons, reusing the same flows as `AlbumCard` (Play kicks the fade-out replace-and-play, Enqueue appends the album's songs to the queue end).
* **Right-click** on an album row now opens the standard album context menu (Play / Add to queue / Play next / Add to playlist / Go to artist) instead of firing a hidden direct-play action; right-click on a Top Artists card opens the artist context menu.
* The **play count** moved from a small right-aligned column to a localized **pill right next to the album title** — `11 plays` (en), `11× gespielt` (de) — since the play count is the central datum on this page.

### Multi-select — Shift+Click range selection on grid pages

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#484](https://github.com/Psychotoxical/psysonic/pull/484)**

* In multi-select mode on **Albums**, **Random Albums**, **New Releases** and **Playlists**, holding **Shift** while clicking a second card now selects every item between the anchor (last clicked) and the click target — the standard OS-level pattern. Range expansion follows the user-visible order, so filters and sort affect what gets included.
* Plain click still toggles a single item and moves the anchor to it; behaviour without Shift is unchanged.

### Help — full rewrite with live search and 10 cleanly-themed sections

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#485](https://github.com/Psychotoxical/psysonic/pull/485)**

* Help page rebuilt from scratch: dropped entries the UI itself answers, consolidated natural groupings, and added entries for features that didn't exist yet when the original Q/A list was written (**Orbit**, **Magic Strings**, **LUFS**, **Mini Player**, **Smart Playlists**, **Track Preview**, **Search**, **Statistics**, **Tracks** hub, **Genre Browser**, **Discord**, **Bandsintown**, **Multi-select**, **Sidebar/Home/Artist customization**, **Sleep Timer**, **Open Source Licenses**). 45 focused entries across **10 themed sections**.
* New **live in-page search**: case-insensitive substring across every Q+A, sections without hits collapse out, matches auto-expand so the answer is visible without clicking. × button clears the query.
* Translated to all **9 supported locales** (en, de, fr, nl, zh, nb, ru, es, ro). Russian and Chinese are at machine-translation quality and would benefit from a polish pass by the original locale maintainers.

### Community themes — redesign pass

**By [@kveld9](https://github.com/kveld9), PR [#490](https://github.com/Psychotoxical/psysonic/pull/490)**

* Removed five themes that overlapped or felt strenuous on the eyes: **Amber Night**, **Ice Blue**, **Monochrome**, **Phosphor Green**, **Rose Dark**.
* Added eight new dark themes covering the colour families people most commonly ask for: **Obsidian Black**, **Carbon Grey**, **Volcanic Dark**, **Forest Green**, **Violet Haze**, **Copper Oxide**, **Sakura Night**, **Obsidian Gold**.
* Light polish on the existing **AMOLED Black Pure** surface variables so card surfaces no longer collapse onto a pure-black background that read as a single flat slab.

### Covers / image cache — `useCachedUrl` tied to `cacheKey`; `CachedImage` load gate

**By [@cucadmuh](https://github.com/cucadmuh), PR [#695](https://github.com/Psychotoxical/psysonic/pull/695)**

* **`useCachedUrl`** only returns a shared blob URL when it still matches the **current** `cacheKey`, so a track change does not paint one frame with the **previous** track's object URL after refcount handling (player bar, queue header cover, Now Playing / mobile paths on the hook).
* **`CachedImage`** clears the opacity **load** gate in **`useLayoutEffect`** when `cacheKey` changes so the first paint after a swap cannot briefly show the new `src` at full opacity before the gate runs.

### Library card grids — virtualization + configurable column cap

**By [@cucadmuh](https://github.com/cucadmuh), PR [#711](https://github.com/Psychotoxical/psysonic/pull/711)**

* **`VirtualCardGrid`** centralises responsive album-style card layouts: column count from container width with a **user-configurable maximum**, **TanStack Virtual** row windows, and shared **`cardGridLayout`** helpers (gap, minimum tile width, row-height estimates per card type).
* Rolled out across the main **card-grid library surfaces** — **Albums**, **Random Albums**, **New Releases**, **Lossless Albums**, **Playlists**, **Composers**, **Composer detail**, **Genre detail**, **Label albums**, **Album detail** (similar / same-artist rails), **Artist detail** (album / appearance / compilation grids), **Internet Radio**, **Offline Library** (albums + playlists), and **Artists** grid mode (virtual rows driven by the same column metrics).
* **Settings → Appearance → Library card grids:** persisted **maximum columns** (**4–12**, default **6**) with translated copy calling out **performance** trade-offs. Settings search index updated.

## Removed

### Settings — Animations 3-state setting under Seekbar Style

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#495](https://github.com/Psychotoxical/psysonic/pull/495)**

* The **Animations** 3-state setting (Full / Reduced / Static) under **Settings > Appearance > Seekbar Style** is gone. The newer perf-flag system and per-feature performance work cover the expensive animation paths more directly: marquee scrolling can be disabled via `perfFlags.disableMarqueeScroll` (Sidebar toggle), global CSS animations via the html-level `data-perf-disable-animations` switch, and seekbar performance is handled by the newer per-feature toggles.
* Anyone who had `'reduced'` or `'static'` selected silently lands on the normal animation path on first launch after upgrade — the persist layer strips the obsolete field, no user-facing prompt.

## Fixed

### Mixes — rating filter and Lucky Mix queue fill

**By [@cucadmuh](https://github.com/cucadmuh), PR [#714](https://github.com/Psychotoxical/psysonic/pull/714)**

* **Settings → Ratings → filter by rating** now applies reliably across **Lucky Mix**, **Random Mix**, **Instant Mix** (context menu + CLI), and infinite-queue top-ups: entity ratings are refreshed after **`setRating`**, unrated artists/albums are no longer negative-cached for seven minutes, optimistic UI stars are honored, and artist/album stars from **`getArtist`** / **`getAlbum`** override misleading OpenSubsonic refs on song payloads.
* **Random Mix** applies the rating filter even when audiobook exclusion is off (previously skipped in that path).
* **Lucky Mix** reports the real queue length in the success toast and keeps filling until **`playerStore.queue`** reaches the target (up to 50), instead of counting track ids before **`enqueue`** completed or stopping pool fill when the unfiltered candidate pool was large enough.

### Statistics / playlists — duration totals rounded to the nearest minute again

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#710](https://github.com/Psychotoxical/psysonic/pull/710)**

* Aggregate duration labels (album and playlist totals, total playtime in **Statistics**) could read up to ~59 s short and round the wrong way at the hour boundary — a 59:30 total showed **"59 m"** instead of **"1 h 0 m"**. A `format` helper consolidation had switched the shared formatter from rounding to truncating; the round-to-nearest-minute behaviour is restored.

### Artists — infinite scroll after first page

**By [@cucadmuh](https://github.com/cucadmuh), PR [#709](https://github.com/Psychotoxical/psysonic/pull/709)**

* The **Artists** page only mounts the bottom **`IntersectionObserver`** sentinel after **`getArtists`** finishes, while **`useArtistsInfiniteScroll`** subscribed in an effect keyed only on **`loadMore`**. Unlike **Albums**, that callback does not depend on **`loading`**, so its identity did not change when the sentinel first appeared — the observer never attached and **`visibleCount`** never grew past the first batch. The hook now uses a **callback ref** (subscribe on mount, disconnect on unmount) and sets **`root`** to **`#app-main-scroll-viewport`** so intersection matches the real scroll container.

### Playback — track no longer clipped at the end with gapless and crossfade off

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#708](https://github.com/Psychotoxical/psysonic/pull/708)**

* With **gapless and crossfade both disabled**, the last up to **~1 second** of every track was cut off. The progress task ended playback on the **Subsonic duration hint**, which is floored to whole seconds, while the decoded audio almost always runs slightly longer — so the tail was lost. It now ends on the **sample-accurate** source-exhaustion signal that gapless already relies on. The duration-hint timer is kept only as the crossfade trigger (which must fire early) and as a watchdog for sources that never signal exhaustion — **no change** to gapless or crossfade behaviour.

### Settings — contributors list sorted chronologically

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#700](https://github.com/Psychotoxical/psysonic/pull/700)**

* The **Settings → System → Contributors** list rendered in raw insertion order, so the original maintainer (since v1.0.0) showed up last and the hand-maintained ordering drifted as new entries were appended. It is now sorted on render — ascending by the app version a contributor first appeared in, tie-broken by their first-contribution PR number — so it stays correct no matter where new entries land in the source list.

### Internet Radio — Add / Edit station modal no longer clipped on empty library

**By [@cucadmuh](https://github.com/cucadmuh), thanks to voidboywannabe for the report on the Psysonic Discord, PR [#699](https://github.com/Psychotoxical/psysonic/pull/699)**

* **Add Station** / **Edit** now mount **`RadioEditModal`** with **`createPortal(..., document.body)`** (same layering approach as **Search Directory**). Previously the overlay lived under nested **`.content-body`** with **`contain: paint`**, so on an **empty** station list the fixed overlay was **painted inside a short box** and looked cropped; after the first station the layout was tall enough that the bug was easy to miss.

### Now Playing — stable list keys on dashboard cards (duplicate React `key` warnings)

**By [@cucadmuh](https://github.com/cucadmuh), PR [#703](https://github.com/Psychotoxical/psysonic/pull/703)**

* **Similar artists**, the **track list inside the in-player album card**, and **Top songs** can all include **more than one row with the same Subsonic `id`** (server payloads are not always strictly deduped). Those lists used **`key={id}`**, which triggered **duplicate `key`** warnings in React devtools and made reconciliation depend on row order. Keys now combine **`id` with the list index** — rendering only; **no queue or playback change**.

### Search — hide duplicate artist hits with zero albums

**By [@cucadmuh](https://github.com/cucadmuh), thanks to zunoz for the report on the Psysonic Discord, PR [#697](https://github.com/Psychotoxical/psysonic/pull/697)**

* Subsonic **`search3`** sometimes returns extra **artist** rows that duplicate a real name but list **0 albums** (server-side indexing noise). **`search()`** now strips artists whose **`albumCount` is exactly `0`**. Rows with **no** `albumCount` field are kept so strict or legacy servers are unchanged.
* Applies everywhere **`search()`** is used: header live search, mobile overlay, search results page, advanced search free-text query, and hooks that call **`search()`** (e.g. similarity fallbacks).

### Offline downloads — the cancel button works again + the sidebar toast keeps its size

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#694](https://github.com/Psychotoxical/psysonic/pull/694)**

* **The ✕ on the sidebar download toast now actually cancels the download.** It was only dropping not-yet-started tracks between batches of 8 — for an album of 8 or fewer tracks the check never ran a second time, so the click did nothing, and in-flight transfers ran to completion regardless. Cancellation now reaches the Rust side: a new `cancel_offline_downloads` command flips a per-download flag that `download_track_offline` checks after acquiring its slot and on every streamed chunk, so an in-progress transfer aborts mid-file (its `.part` file is cleaned up). The frontend also drops every job for the cancelled album immediately, so the toast disappears at once instead of lingering on stuck "downloading" rows. Tracks that had already finished before the cancel are kept rather than orphaned on disk.
* **The download progress toast no longer gets squished when the main window is small.** It lives in the sidebar's vertical flex column and was missing `flex-shrink: 0`, so a short window compressed it; the label now also ellipsis-truncates on a narrow sidebar instead of overflowing.

### Orbit — guest playback fixes

**By [@Psychotoxical](https://github.com/Psychotoxical), reported by nzxl + RavingGrob, PR [#525](https://github.com/Psychotoxical/psysonic/pull/525)**

* **All local queue-extension paths are suppressed for the entire Orbit session lifecycle**, not just while the session is `active`. Radio top-up, infinite-queue top-up, queue-exhaustion fallback, and the proactive "≤ 2 auto-tracks ahead" topper all refuse to extend the local queue while role is host or guest and phase is `starting` / `joining` / `active`. Even fetch promises that were already in flight re-check at resolution time, so a click-Join racing with a fetch can't pop the bulk-add modal *after* the join completes. Without this lockout the guest got a "Add 5 tracks to the Orbit queue?" prompt on track-end (offering to inject unrelated suggestions into the host's shared queue) and the local queue silently drifted off the host's playlist.
* **Natural track-end no longer reads as "the guest manually paused"** — the divergence check in the guest pull tick now distinguishes the two via the player's `currentTime` (which `handleAudioEnded` resets to 0, while a real pause leaves it mid-track). Without the discriminator the guest sat silent on every host-driven track change that arrived in the 0–2.5 s window after the guest's own track had ended.
* **Initial-sync and Catch Up both now wait for the audio engine to actually report playing before seeking** (up to 5 s on initial-sync, 4 s on Catch Up). The previous timeout-and-fire approach would drop a seek onto a not-yet-ready engine, where it silently no-oped — guest played from 0:00 while believing they were synced. The visible symptom was "I clicked Catch Up and the song jumped 50 % forward": the second click finally caught the engine ready, so the seek that should have happened on join finally landed.
* **Catch Up button no longer flickers and no longer changes the bar height.** Drift is computed from a noisy signal (guest's `currentTime` updates in coarse chunks while host's position is extrapolated linearly), so the diff swings ±5 s on a normal session even when sync is fine — and the button popping in/out shifted the whole Orbit bar up and down because it was 6 px taller than the other action buttons. Visibility is now debounced (must stay over the threshold for ≥ 3 s before the button appears) and the button matches the 26 px height of its neighbours so the bar's vertical layout is stable.
* **Double-clicking the inline play button on an album-track row now suggests/enqueues to the host's queue**, matching the existing double-click-on-row behaviour. Previously the button stopped propagation on click, so its double-click never reached the row's orbit-aware handler — clicking it twice just bounced the "double-click to add" hint toast.
* **Track preview is now hidden + blocked during an Orbit session.** The preview path runs through the same Rust audio engine as the shared playback, so starting a preview as a guest would clobber the host's track in the local player. The preview button is hidden across all surfaces (album / artist / favourites / playlist / random-mix track lists) via a global `[data-orbit-active]` CSS rule, and `previewStore.startPreview` no-ops as a defensive guard for keyboard shortcuts and any programmatic callers.
* **Audio reliably starts on join, even after a slow first cold-start** (PR [#526](https://github.com/Psychotoxical/psysonic/pull/526)). Two cases were leaving the guest silent on join: (a) the initial sync's 5 s ready-poll timed out (slow Navidrome warmup), the next pull tick took the cheap "track already loaded" shortcut and fired `seek` + `resume` on a stuck engine — both no-oped against a track that never started; (b) `playTrack`'s optimistic `isPlaying: true` write masked a later `audio_play` rejection, so the guest tick recorded a "successful" sync but the engine had silently fallen back to paused. Both are now handled: the shortcut is gated on engine state matching the host's expected state, and a recovery check at the top of the pull tick resets the anchor whenever the engine is paused while the host is still playing the same track — the next 500 ms fast-poll fires a fresh `playTrack` and audio kicks in.
* **Catch Up button stays clickable on high-latency sessions** (PR [#527](https://github.com/Psychotoxical/psysonic/pull/527)). On a real-world high-latency session the genuine drift fluctuates between ~1 s and ~8 s in lockstep with both sides' chunked `currentTime` updates — the previous single-stage debounce hid the button as soon as drift briefly dipped below 3 s even though the baseline drift was still 5–8 s, so the button "appeared and vanished too fast to click". Two-stage hysteresis now: show after drift > 3 s for 3 s, hide only after drift < 1 s for 1 s.
* **Initial-sync seek visually sticks on join** (PR [#528](https://github.com/Psychotoxical/psysonic/pull/528)). On join the waveform briefly showed the host's live position then snapped back to 0:00 with audio playing from the start — the post-`playTrack` poll fired `applyMirror`'s seek against `playTrack`'s optimistic `isPlaying: true`, before the Tauri `audio_play` had actually produced any samples. The seek's store update landed (waveform at 70 %) but the `audio_seek` debounced behind it no-oped on the not-ready engine, and the engine's first progress events from 0:00 overwrote the optimistic position. Now the poll waits for `currentTime > 0.1` before applying the seek, and `applyMirror` defers the play-state mirror by 200 ms so the seek's invoke wins the IPC ordering race against pause/resume.
* **Host single-track plays no longer wipe the Orbit queue** (PR [#529](https://github.com/Psychotoxical/psysonic/pull/529)). A `playTrack(track, [track])` call from any UI that passes an explicit 1-track replacement queue (e.g. OfflineLibrary's "Play this album" on a single-track album) slipped past the orbit bulk-guard (which only fires for `queue.length > 1`) and replaced the host's `playerStore.queue`. Since the host's queue *is* the shared Orbit queue, that one click destroyed every accepted guest suggestion + every upcoming track. Now intercepted: when role is host and the incoming queue is a single track, append + jump instead of replacing.
* **Host pause / resume reaches guests immediately** (PR [#537](https://github.com/Psychotoxical/psysonic/pull/537), reported by xrexy on Discord). The host previously pushed state only on a 2.5 s timer; combined with the guest's 2.5 s poll plus network latency, a `pause` could take up to ~5 s to land — long enough for the guest to noticeably run past the host. The host now also pushes state on every `isPlaying` flip, in addition to the timer. Non-flip ticks are unchanged, so baseline traffic stays the same.
* **Guest seekbar is read-only inside an Orbit session** (PR [#537](https://github.com/Psychotoxical/psysonic/pull/537), reported by xrexy on Discord). Drag / click / wheel / hover are all disabled on the waveform while you're a guest; the bar shows as dimmed with a `not-allowed` cursor so the disabled state is unambiguous. Previously a guest seek would jump the local player and either snap back at the next host poll (inconsistent UX) or push the guest into a diverged state where Catch Up was the only way back. Hosts and non-orbit users see no change.

### Context menu — render above the floating player bar

**By [@Psychotoxical](https://github.com/Psychotoxical), reported by Prymz, PR [#522](https://github.com/Psychotoxical/psysonic/pull/522)**

* The main context menu wrapper carried an inline `zIndex: 999` that overrode the stylesheet's `z-index: 10000`, and the floating player bar sits at `z-index: 1000`. Right-clicking a track near the bottom of the screen with the floating bar enabled cut off the bottom of the menu (issue [#521](https://github.com/Psychotoxical/psysonic/issues/521)).
* Inline override removed; the stylesheet rule wins so the menu always paints above the floating bar. Submenus inherit the parent menu's stacking context and follow.

### Home — Because-you-listened rail compact in narrow layouts

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#520](https://github.com/Psychotoxical/psysonic/pull/520)**

* When the rail container drops below the 2-card threshold (≈ 696 px — sidebar + queue both open, mini, etc.), the home **Because-you-listened** section now switches to the standard `AlbumRow` layout instead of stretching the hero-style cards to full width. The narrow path inherits the rail's existing perf tuning (artwork budget, viewport windowing, scroll paging).
* Wide layouts (>= 696 px) keep the existing 3-up hero cards with the "Similar to X" pill, album metadata, and album release-type pills — full-screen view is unchanged.
* Detection runs through a single `ResizeObserver` on the rail wrapper. The wide path adds zero extra renders.

### Security — Tauri patch for IPC origin-confusion (GHSA-7gmj-67g7-phm9)

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#509](https://github.com/Psychotoxical/psysonic/pull/509)**

* Bumped Tauri **2.11.0 → 2.11.1** to pick up the upstream patch for [GHSA-7gmj-67g7-phm9](https://github.com/advisories/GHSA-7gmj-67g7-phm9) — older Tauri versions had an **origin-confusion** bug that could let a remote-origin page loaded inside the webview invoke local-only IPC commands. Severity **medium**. Psysonic exposes a number of file-system and credential-bearing IPC commands (downloads, Navidrome native API, audio engine), so closing the gate is worth the bump.
* Lockfile-only refresh; `Cargo.toml` was already unlocked at `tauri = "2"`. Full Tauri family (build / codegen / macros / runtime / runtime-wry / utils) bumped together at matching patch level.

### Hot cache, HTTP streaming replay, and queue source indicator

**By [@cucadmuh](https://github.com/cucadmuh), PR [#463](https://github.com/Psychotoxical/psysonic/pull/463)**

* **`stream_completed_cache`** is **no longer cleared** on **`audio_stop`**, so a fully buffered ranged download is not thrown away when the queue ends; starting the same track again can reuse **RAM** or **hot-disk** data instead of running a full **HTTP ranged** fetch from scratch (when hot cache is enabled and promotion succeeds).
* **Same-track `playTrack`** and **cold `resume`** after **`audio:ended`** (engine not in paused-loaded state) **await hot-cache promote** so `resolvePlaybackUrl` can switch to **`psysonic-local://`** before the next **`audio_play`**.
* **Ranged HTTP** sources merge format hints from the URL tail, **`Content-Type`**, **`Content-Disposition`** filename, and Subsonic **`song.suffix`** (IPC **`streamFormatSuffix`**). A bounded **Range** probe runs only when hints are still missing. Generic **`video/mp4`** **Content-Type** is not treated as an audio-container hint.
* **SQLite analysis:** skip redundant **CPU seeds** when **waveform and loudness** rows already exist; emit **`analysis:waveform-updated`** only after a real DB **upsert**, not on cache-hit no-ops. Ranged / legacy download tasks re-check **playback generation** after awaits before writing the completed-stream slot.
* **Queue panel** source icon (**stream / hot cache / offline**) now updates on **resume**, **queue-undo restore**, and **gapless `audio:track_switched`**, not only when **`playTrack`** runs.
* **TypeScript / robustness:** non-null **`activeServerId`** bindings for promote IPC; **`.catch`** on the same-track **promote → play** promise chain with generation guard and prefetch-reset on failure.

### Sidebar — New Releases read state under storage cap

**By [@cucadmuh](https://github.com/cucadmuh), PR [#463](https://github.com/Psychotoxical/psysonic/pull/463)**

* When persisted “seen” release IDs hit the **500-id cap**, **fresh reads are merged** at the front of the capped set so **unread badges** do not come back incorrectly (`mergeSeenNewReleaseIdsCap`).

### Windows — tray double-click

**By [@cucadmuh](https://github.com/cucadmuh), PR [#463](https://github.com/Psychotoxical/psysonic/pull/463)**

* **Double-click** on the tray icon opens (or focuses) the main window without a spurious **context-menu** interaction; tray module import cleanup.

### Playback stability — preview seekbar, sleep/wake recovery, and card-hover jitter

**By [@cucadmuh](https://github.com/cucadmuh), PR [#476](https://github.com/Psychotoxical/psysonic/pull/476)**

* **Preview seekbar:** while Rust preview playback pauses the main sink, the main seekbar no longer extrapolates forward, and preview end no longer causes a brief forward jump before snapping back.
* **Sleep/wake audio recovery:** added post-sleep output reopen hooks for **Windows** (power notifications) and **Linux** (logind `PrepareForSleep` wake signal), plus a guarded fallback watchdog path and richer runtime diagnostics.
* **False-positive mitigation:** the watchdog now arms only after a long poll gap (sleep/resume-like condition) and logs arm/clear/trigger decisions, reducing unexpected stream reopens during normal playback.
* **Card hover stability:** removed vertical lift on album/artist/base cards to avoid pointer-edge pulsation, kept artwork zoom smooth, and dropped per-card GPU layer hints that could regress software-composited Linux paths.

### Analysis queue control — prune stale backfill jobs and cap warmup window

**By [@cucadmuh](https://github.com/cucadmuh), PR [#480](https://github.com/Psychotoxical/psysonic/pull/480)**

* Added a queue-prune path for pending analysis work so stale `http_backfill` / `cpu_seed` jobs are dropped when tracks leave the active playback queue.
* Limited loudness backfill warmup to the current track plus the next 5 tracks, reducing runaway analysis scheduling from large bulk queue updates.
* Added debug counters for prune results to make queue-pressure behavior visible during diagnostics.

### Sidebar — Playlists icon and hover hitbox in collapsed mode

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#481](https://github.com/Psychotoxical/psysonic/pull/481)**

* The **Playlists** icon in the collapsed sidebar was **off-centre** and had a **wider hover background** than every other item, because it still rendered through the expanded-mode wrapper (with `padding-right` and a `flex: 1` main link to fit the expand-toggle). Collapsed mode now reuses the **standard nav-link path** — same hitbox, same alignment as Artists, Albums, Favorites, etc.

### Tracklist — drop now-playing pulse + EQ-bar animations

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#488](https://github.com/Psychotoxical/psysonic/pull/488)**

* The currently-playing track in any tracklist (**AlbumDetail**, **ArtistDetail**, **PlaylistDetail**, **Favorites**, **RandomMix**) ran an **`opacity` pulse** on the entire row plus three **`transform` keyframe** EQ-bar siblings — both compositor properties, but on **WebKitGTK without compositing** (Linux + NVIDIA proprietary + `WEBKIT_DISABLE_COMPOSITING_MODE=1`) every animated row falls back to a full **software repaint** of the subtree per frame. On AlbumDetail the combined cost held the WebProcess at **~80 % CPU** for the duration of playback; CPU dropped immediately on pause/stop.
* `.track-row.active` keeps the **accent-tinted background** but no longer pulses. The "now playing" indicator becomes a single Lucide **`AudioLines` icon** (one SVG per active row instead of three animated spans). Cleanup: dead `track-pulse` + `eq-bounce` keyframes and a duplicate, shadowed `.eq-bar` block in `theme.css`.

### Radio — queue navigation, dedup, and similar-first variety

**By [@Psychotoxical](https://github.com/Psychotoxical), reported by netherguy4, PR [#503](https://github.com/Psychotoxical/psysonic/pull/503)**

* **Queue navigation through duplicates**: `playTrack` re-resolved the active slot via `findIndex(... .id === ...)`, which returns the **first** matching id. Reaching a track's second occurrence snapped `queueIndex` back to the earlier slot — highlight visibly jumped and the next auto-advance played the wrong follow-up. `next()`, `previous()`, the `audio:ended` repeat-one path, queue-row click and the queue-item Play Now now pass an explicit target index through `playTrack`.
* **Queue duplicates**: `enqueueRadio` didn't dedupe incoming tracks; the `next()` top-up deduped against the live queue but trimmed the played tail down to **5 history entries**, so songs heard a few advances ago could be re-added by a later Last.fm / topSongs response; and the `.filter(...)` pass admitted intra-batch repeats (top + similar overlap is common) because it read the dedup set before mutating it. A radio-session-scoped seen-set, reset on artist change and `clearQueue`, closes all three paths.
* **Variety**: Starting Radio on a track no longer queues five top tracks of the seed artist before any similar-artist material plays. The seed path and both top-up paths lead with similar songs and only fall back to top tracks when similar comes back empty (no Last.fm / small library).

### Track preview — volume slider ignored during preview

**By [@Psychotoxical](https://github.com/Psychotoxical), reported by netherguy4, PR [#502](https://github.com/Psychotoxical/psysonic/pull/502)**

* The Rust **preview sink** had its volume set **once at preview start** and was never updated afterwards — `audio_set_volume` only ramps the **main sink**. Slider drags during preview therefore had no audible effect on the preview level.
* With **loudness normalization** on (default `-4.5 dB` pre-analysis attenuation), even a 100 % slider produced `1.0 × 0.596 × 0.891 ≈ 53 %` at the speaker, matching the reporter's "fixed at around 50 %" observation.
* New `audio_preview_set_volume` command and a `playerStore` subscription in the frontend keep the preview sink in lock-step with the slider while a preview is in flight (settings tweaks during preview are intentionally not synced — preview windows are short).

### Tray — broken navigation after restoring via desktop / start-menu shortcut

**By [@Psychotoxical](https://github.com/Psychotoxical), reported by netherguy4, PR [#501](https://github.com/Psychotoxical/psysonic/pull/501)**

* When the main window was closed to the tray and then re-opened via the **desktop / start-menu shortcut** (instead of the tray icon), the window came back but the **next navigation rendered a blank page**. Restoring via the **tray icon** worked correctly.
* Root cause: closing to the tray injects a "pause rendering" snippet that sets `data-psy-native-hidden="true"` on `<html>` and pauses every CSS animation. The tray-icon restore path injects the matching "resume rendering" snippet before showing the window — the second-launch restore path (handled by the **single-instance plugin**) was **missing that step**, so route wrappers using `.animate-fade-in` (`animation: fadeIn … both`, starts at `opacity: 0`) stayed frozen invisible.
* Fix: mirror the tray-icon restore path and resume rendering before `show()` in the single-instance callback. Both restore paths are now consistent.

### Player UI — broken album-art icon when switching tracks

**By [@cucadmuh](https://github.com/cucadmuh), PR [#695](https://github.com/Psychotoxical/psysonic/pull/695)**

* Fixes issue [#606](https://github.com/Psychotoxical/psysonic/issues/606): the small cover in the **player bar** (and other `CachedImage` surfaces) no longer flashes the browser **broken-image** placeholder for a split second when skipping tracks or changing the current queue item.

### Album & player — split OpenSubsonic album credits and performers

**By [@cucadmuh](https://github.com/cucadmuh), PR [#696](https://github.com/Psychotoxical/psysonic/pull/696)**

* Album detail **header** shows **multiple album artists** when the server sends OpenSubsonic **`albumArtists`** on the album or on child songs — each name links to its artist page instead of only the first id (issue [#552](https://github.com/Psychotoxical/psysonic/issues/552)).
* **Player bar**, **mobile now playing**, and **mini player** copy **`artists`** through **`songToTrack`** so multi-performer tracks get **per-artist** links like the album tracklist column.

### Multi-server — queue playback stays on the source server when browsing another library

**By [@cucadmuh](https://github.com/cucadmuh), PR [#717](https://github.com/Psychotoxical/psysonic/pull/717)**

* With a non-empty queue from server **A**, switching the active server to **B** no longer breaks playback: streams, hot-cache prefetch, seek/resume, and MPRIS cover art use **`queueServerId`** (persisted with the queue).
* **Cover art** in the queue panel, player bar, mini/fullscreen/mobile players, and Now Playing loads from the queue server when it differs from the browsed server.
* **Artist/album links** from the player, queue, Now Playing, and mini player switch back to the queue server before navigating; **queue** and **player-bar album** context menus pin API actions to that server as well.
* Opening **Now Playing** (sidebar, mobile route, or queue info panel) switches to the queue server before Subsonic metadata loads, with per-server fetch caches so artist/album cards do not show the wrong library.
* **Scrobble**, **now-playing report**, and **savePlayQueue** sync use the queue server as well; removing that server profile clears `queueServerId`; the mini-player bridge receives `queueServerId`; enqueue/play-next from another browsed server is blocked with a toast.

### UI — selectstart blocker no longer throws on Text node targets

**By [@cucadmuh](https://github.com/cucadmuh), PR [#718](https://github.com/Psychotoxical/psysonic/pull/718)**

* The global **`selectstart`** handler assumed `event.target` was always an **`Element`**. Starting selection inside text (e.g. Now Playing **`[data-selectable]`** copy) could pass a **Text** node and crash with **`target.closest is not a function`**. The handler now resolves Text nodes to their parent element before applying allow/deny rules.

## [1.45.0] - 2026-05-04

## Added

### Themes — Kanagawa, Atom One and 1984 Palettes

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#390](https://github.com/Psychotoxical/psysonic/pull/390)**

Open Source Classics gains three new theme families: **Kanagawa**, **Atom One** and **1984**, adding nine new themes in total.

* **Kanagawa:** Wave, Dragon and Lotus
* **Atom One:** Dark and Light
* **1984:** Default, Cyberpunk, Light and Orwell

Each theme defines the full token set, including background, accent, text, Catppuccin compatibility, waveform, status and select-arrow tokens. This lets login, queue sidebar and subpages inherit the palette cleanly without component-specific overrides.

The theme picker now groups Open Source Classics by family with dedicated family headings. Theme scheduler dropdown labels are also family-prefixed, making it clearer which palette family a scheduled theme belongs to.

### Audio Preview — Rust Preview Engine and Tracklist Rollout

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#392](https://github.com/Psychotoxical/psysonic/pull/392), [#394](https://github.com/Psychotoxical/psysonic/pull/394)**

Psysonic now has a native Rust-powered preview engine for tracklist previews. Instead of using a separate HTML5 audio path, previews run through a parallel `rodio` sink on the existing output stream, with dedicated Tauri commands and engine events for preview start, progress and end.

When a preview starts, the main player pauses and only resumes automatically if it was playing beforehand. Starting normal playback, radio playback, resume or stop actions cancels any active preview first, so preview audio and main playback cannot overlap.

The new preview UI is rolled out across the main tracklist surfaces:

* **Albums**
* **Playlist detail** including suggestions
* **Favorites**
* **Artist detail** top tracks
* **Random Mix** genre and filtered-song lists

Track numbers now stay stable on hover, while dedicated inline Play and Preview buttons handle playback actions from the title cell. Active playing rows keep the equalizer bars, including on hover; active paused rows fall back to a static accent-colored track number. `SongRow` is intentionally left untouched in this pass.

Settings → Audio now includes a preview section with a master toggle, configurable start position, configurable duration and per-location toggles. Users can keep previews enabled on discovery-heavy surfaces while hiding them on owned-content views. The preview progress ring follows the configured duration automatically.

Preview state is mirrored through a new `previewStore`, giving the UI one reliable source of truth for preview progress, active state and the currently previewing track metadata.

While a preview is playing, the player bar mirrors the previewed track with cover, title, artist, a dedicated Preview label and an accent top border. Actions that would otherwise target the queued track, such as rating, fullscreen hint and album/artist links, are suppressed during preview playback.

The main play button also reflects preview state with a stop-style preview control and progress ring. Its behavior matches the inline preview buttons: stopping the preview resumes the main player only if it was already playing before. The smaller Stop button uses silent preview stop semantics, cancelling the preview and leaving the main player paused so Stop always means silence.

Spacebar stops an active preview, media keys are ignored during previews, and tray actions cancel the preview before continuing with the requested player action.

Play Next in the context menu now uses a double-chevron icon, making it visually distinct from the Preview button.

The feature includes updated i18n coverage across all supported locales, including the new player-bar preview labels.

### Tray — Now Playing Tooltip and Localized Menu Labels

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#395](https://github.com/Psychotoxical/psysonic/pull/395), closes [#383](https://github.com/Psychotoxical/psysonic/issues/383)**

The system tray now reflects the current playback state more clearly. On Windows and macOS, the tray tooltip shows the currently playing track as `Artist – Title` on play, pause and track changes, falling back to `Psysonic` when nothing is playing.

On Linux, where AppIndicator does not expose a hover-tooltip API, the same now-playing text is shown as a disabled entry at the top of the tray menu instead.

Tray menu labels are now localized across all supported languages, including Play/Pause, Next/Previous, Show/Hide, Exit and the Linux-only empty-state label. The frontend updates the tray labels on startup and whenever the app language changes, without rebuilding the tray icon.

### Sidebar Discovery Indicators

**By [@cucadmuh](https://github.com/cucadmuh), PR [#397](https://github.com/Psychotoxical/psysonic/pull/397)**

Sidebar navigation now includes a dedicated unread indicator for **New Releases**, with persistence per server/library scope and delayed mark-as-seen behavior after opening the New Releases page.

Albums added within the last 48 hours now receive a localized **New** badge in both album cards and album detail header.

### Adaptive Header Controls

**By [@cucadmuh](https://github.com/cucadmuh), PR [#397](https://github.com/Psychotoxical/psysonic/pull/397)**

The top header behavior was reworked for narrow widths: search, Live and Orbit controls now compress in a deterministic order with improved stability in edge-width ranges.

### Waveform Wheel Seeking

**By [@cucadmuh](https://github.com/cucadmuh), PR [#397](https://github.com/Psychotoxical/psysonic/pull/397)**

Waveform mouse-wheel seeking now uses fixed step-based jumps with debounce smoothing for more predictable navigation and less jitter during rapid scrolling.

### Queue Panel — Position Counter, Tri-State Duration Toggle, Collapsible Now Playing, EQ Indicator

**By [@kveld9](https://github.com/kveld9), PR [#419](https://github.com/Psychotoxical/psysonic/pull/419)**

The queue panel got a sweep of UX refinements. The header now shows the current position as `(N/M)` next to the queue title for at-a-glance context.

The clickable duration label in the header rotates through **three** modes per click instead of two: total queue time, remaining time, and **estimated end-of-queue clock time** (e.g. `· 02:10`). ETA updates every 30 seconds, is formatted in the user's locale, and is visually highlighted with the accent colour while playing.

A new chevron next to the queue title **collapses the Now Playing section and queue toolbar**, and the collapsed state is persisted across restarts, so users who treat the queue as a pure list can keep it that way.

The currently playing row in the queue list is now indicated by **animated equalizer bars** to the left of the track title; the bars freeze in place when playback is paused. The previous small play icon next to the title is removed since the EQ bars carry the same signal more clearly.

### Queue — Drag Outside to Remove

**By [@cucadmuh](https://github.com/cucadmuh), PR [#420](https://github.com/Psychotoxical/psysonic/pull/420)**

You can remove a track from the play queue by dragging its row **outside** the queue sidebar (main window) or outside the mini player’s queue list. Drop targets still support reordering when you release inside the queue area.

The drag ghost shows a **trash** affordance only while the cursor is outside the queue bounds; inside the queue it behaves as a normal reorder drag. The mouse-event `psy-drop` path now carries cursor coordinates so removal can be detected when the drop target is not the queue panel itself.

### Statistics — Shareable Top-Albums Card

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#425](https://github.com/Psychotoxical/psysonic/pull/425)**

Statistics page can now export your most-played albums as a shareable PNG, accessible via a share icon next to the **Most Played Albums** section header. Three aspect ratios for different platforms (Story 9:16, Square 1:1, Twitter Card 16:9), three grid sizes (3×3, 4×4, 5×5), with each cover carrying a thin info strip showing rank + play count.

The card pulls the wordmark and accent color directly from the active theme, so a Catppuccin export looks Catppuccin and a Nord export looks Nord. Cover art reuses the existing IndexedDB cache, so no extra Subsonic round-trips on repeat exports. The header label is hardcoded English ("Top Albums") so a shared image stays legible to followers regardless of their language.

Saving uses the native OS save dialog — no silent dump into Downloads, the user picks the path each time. Data source is local-only (Subsonic `getAlbumList(frequent)`); Last.fm is intentionally not used. There is no time-window selector because Navidrome's API exposes only cumulative play counts, not per-event play history.

### Shortcuts — Action Registry, Dynamic CLI Help, New Input Targets

**By [@cucadmuh](https://github.com/cucadmuh), PR [#435](https://github.com/Psychotoxical/psysonic/pull/435)**

Shortcut, keyboard, global-hotkey, mini-window and CLI inputs are now all routed through one TypeScript action registry — a single source of truth for what an action does, how it's labelled, and which input transports can fire it. CLI `--player help` is generated dynamically from the registry, so command coverage stays in sync with the action set automatically.

Nine new input actions were added (requested by zunoz on Discord): start search, start advanced search, toggle sidebar, mute, open / toggle equalizer, toggle repeat, open Now Playing, show lyrics, favorite current track. Help is bound to **F1** by default and hidden from the Settings input list; existing users get the F1 binding back-filled into their persisted keybindings on next launch.

Translations for the new action labels follow in a separate i18n nachhol-PR (de, fr, nl, zh, nb, ru, es).

### Settings — 3-State Animation Mode (Full / Reduced / Static)

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#441](https://github.com/Psychotoxical/psysonic/pull/441), suggested by harumscarum on Telegram**

The boolean **Reduce animations** toggle in **Settings → Appearance** is now a three-state picker matching the ReplayGain Auto/Track/Album pattern:

- **Full** (default for new users): native frame rate, marquee scrolls normally.
- **Reduced** (default for users who had the legacy toggle on): 30 fps cap on the animated seekbar wave; the player title marquee runs at half speed.
- **Static**: the rAF loop driving the animated seekbar is disabled entirely — the seekbar repaints from the ~2 Hz `audio:progress` heartbeat only. The player title/artist no longer scroll; long names are truncated with an ellipsis. Lowest GPU/CPU cost of the three.

Existing users with `reducedAnimations: true` are migrated 1:1 to **Reduced** on first launch; everyone else lands on **Full**. The picker is in the same place as before. A contextual hint below the picker explains what the selected mode does.

### Tracks — Highly Rated Rail and Per-Card Star Display

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#443](https://github.com/Psychotoxical/psysonic/pull/443), prompted by Foxhunter-de in discussion [#442](https://github.com/Psychotoxical/psysonic/discussions/442)**

The Tracks page gets a new **Highly Rated** rail above Random Pick, surfacing your top-rated tracks (sorted by rating, descending). The rail auto-hides on non-Navidrome servers and on libraries with no rated tracks yet. The standard reroll button forces a fresh fetch.

Every song card across the app whose rating is greater than zero now shows a small five-star row below the artist line, filled to the rating value. Read-only display — rating is still done via the row's context menu or the Now Playing star widget.

Backed by an opt-in 60 s in-memory cache for `ndListSongs` (used only by the new rail; paginated browsing is unaffected). The cache is cleared automatically when you rate a track, switch server, or click the rail's reroll button.

### Random Mix — Playlist Size Selector and Filter Panel Cleanup

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#445](https://github.com/Psychotoxical/psysonic/pull/445), prompted by Foxhunter-de in discussion [#442](https://github.com/Psychotoxical/psysonic/discussions/442)**

Random Mix can now build longer mixes. A new playlist-size picker (50 / 75 / 100 / 125 / 150) sits at the top of the filter panel. Clicking a size button immediately reloads the current mix at the new count — Genre Mix and All Songs both honored, no extra Remix click needed. The choice is persisted across restarts.

The filter panel layout was tightened up at the same time: two sub-headings (**MIX SETTINGS** and **EXCLUSIONS**) with a divider between them, and a slightly larger panel-level header so the visual hierarchy reads cleanly. A small italic note below MIX SETTINGS explains that large mix sizes may return fewer unique tracks if the server's random pool runs short.

Under the hood, `fetchRandomMixSongsUntilFull` now scales batch size, max-batch ceiling and dup-streak budget with the requested target — so a 150-track mix can finish in a single round-trip on most libraries instead of stalling out at ~120.

### UI — Bulk Entity Ratings, Random Albums Multi-Select, Album New Badge

**By [@cucadmuh](https://github.com/cucadmuh), PR [#446](https://github.com/Psychotoxical/psysonic/pull/446)**

Multi-album and multi-artist **context menus** now include a shared star-rating row for the current selection (mixed ratings show empty until you set a value; keyboard navigation supported), with new aria-label strings across locales. **Random Albums** passes the active selection into each **AlbumCard** so the same bulk context menu works from the roll grid. The album **New** badge moves to the **top-right** of the cover and **stacks** with the offline badge so the two no longer overlap.

### NixOS — Flake: X11-wrapped default vs session GDK

**By [@cucadmuh](https://github.com/cucadmuh), PR [#447](https://github.com/Psychotoxical/psysonic/pull/447)**

The flake exposes two Linux installables: **`psysonic`** / **`default`** pins **`GDK_BACKEND=x11`** for a stable GTK/WebKit stack on mixed Wayland setups; **`psysonic-gdk-session`** drops that override so GDK follows the session (native Wayland where the stack supports it). **[nixos-install.md](nixos-install.md)** documents trade-offs and **zsh-safe** quoting for `nix run 'github:…#…'` URLs.

### Linux / WebKit — performance probe, progress IPC, and UI isolation

**By [@cucadmuh](https://github.com/cucadmuh), PR [#452](https://github.com/Psychotoxical/psysonic/pull/452)**

* **Performance Probe** — Modal at **Ctrl+Shift+D** (sidebar logo is decorative only). Collapsible Phase 1/2 and an open-by-default Phase 3 for the toggles used most in profiling. Flags persist in `localStorage`, map to `data-perf-*` on the document root, and can disable targeted subsystems (shell/network hooks, mainstage sections, PlayerBar waveform only, live progress UI, rail artwork, and similar) to isolate WebKit/WebProcess CPU on Linux.
* **Approximate live CPU (Linux)** — Tauri command reading `/proc` (including WebKit helper process names) for rough host CPU share while the probe is open.
* **`getPlaybackProgressSnapshot` / `subscribePlaybackProgress`** — Live time, seekbars, lyrics, and related UI subscribe without writing every progress tick into the persisted player store.
* **Perf telemetry gating** — Hot-path counters (`audioProgressEvents`, `waveformDraws`, `homeCommits`) increment in development builds always, and in production only while the Performance Probe is open, avoiding extra global writes during normal playback.
* **`audio:progress` (Rust)** — Throttled by minimum interval and position delta, with immediate emit on pause transitions, to reduce IPC during playback.
* **Persisted player store** — `currentTime` / `progress` / `buffered` commits are coarse-grained; live UI reads the snapshot channel instead.
* **`WaveformSeek`** — Same **`<canvas>`** **2D `fillRect`** bar renderer as before (not pre-rendered bitmap layers). Progress is fed from the snapshot channel; sparse backend ticks are bridged with prediction/smoothing and a capped repaint cadence; animated preview ticks no longer stop solely because the window lost focus while still visible; static styles stay aligned with external seeks while **paused** by syncing the visual progress ref to the snapshot when the interpolation `rAF` loop is not running.
* **MPRIS** — Position updates while playing use the snapshot channel on a conservative cadence; play/pause transitions send **snapshot** time (not coarse store `currentTime`). Removed the redundant store-driven position branch that could push stale values after timeline coarsening.
* **Home / card artwork** — Album and song cards always use **`CachedImage`** for covers; removed unused `directImageSrc` plumbing from `Home`, `AlbumRow`, `SongRail`, `AlbumCard`, and `SongCard`.
* **Tracks** — Highly Rated and Random Mix **`SongRail`** rows enable the same horizontal **artwork windowing** defaults as Home.
* **Hero** — Auto-advance respects visibility in the app scroll viewport, pauses when the window is blurred, and recovers after returning on-screen or on focus/visibility changes.
* **Home `AlbumRow` / `SongRail`** — Artwork visibility budget uses real card geometry so covers fill the viewport without requiring an initial horizontal scroll nudge.
* **Server switch menu** — Portaled with fixed coordinates so it stacks above the sidebar.
* **Linux / Nix** — `PSYSONIC_ALLOW_NATIVE_GDK` skips the default `GDK_BACKEND=x11` pin when using the `gdk-session` wrapper; `tauri:dev` no longer forces `GDK_BACKEND` over `nix develop` defaults.



## Fixed

- **Settings → Audio no longer blanks the app on macOS** *(Issue [#382](https://github.com/Psychotoxical/psysonic/issues/382), PR [#384](https://github.com/Psychotoxical/psysonic/pull/384), by [@Psychotoxical](https://github.com/Psychotoxical))*: Fixed a macOS-only crash where opening Settings → Audio could turn the whole app into a blank window. The Equalizer canvas now waits until it has valid layout dimensions before drawing, and redraws automatically once the section is visible.

- **Polish** *(PR [#397](https://github.com/Psychotoxical/psysonic/pull/397), by [@cucadmuh](https://github.com/cucadmuh))*: multiple branch-local interaction fixes around sidebar drag/drop behavior, Live dropdown layering, queue-resize handle behavior during scroll/overlay-scrollbar interaction, and now-playing narrow-layout stability.

- **Track preview audio in sync with progress ring; huge files no longer abort** *(Issue [#421](https://github.com/Psychotoxical/psysonic/issues/421), PR [#423](https://github.com/Psychotoxical/psysonic/pull/423), by [@Psychotoxical](https://github.com/Psychotoxical))*: Previews used to start audio about 25 % into the preview window on mid-track starts because `Sink::try_seek` ran in parallel with `sink.append` while the 30 s `take_duration` cap was already counting wall-clock from append. The seek now runs on the bare source before append, and the progress-ring animation only starts once the engine actually emits `audio:preview-start` — a small loading spinner is shown during the download/decode/seek warmup. The preview HTTP-client timeout was raised from 30 s to 5 min, so multi-hundred-megabyte Hi-Res files no longer abort the download mid-fetch.

- **Windows playback stutter under GPU load** *(Issue [#334](https://github.com/Psychotoxical/psysonic/issues/334), PR [#426](https://github.com/Psychotoxical/psysonic/pull/426), by [@Psychotoxical](https://github.com/Psychotoxical))*: Audio could stutter and crackle on Windows whenever another app put GPU/CPU pressure on the system (browser, 3D apps, games). The WASAPI render thread is now promoted to MMCSS "Pro Audio" via `AvSetMmThreadCharacteristicsW`, so it survives priority contention from competing graphics work. Reproed and validated under a Half-Life parallel-load stresstest. Companion mitigations for high-GPU situations: cosmetic UI animations now pause when the window loses OS focus, and a new **Reduce animations** toggle in **Settings → Appearance** caps animated seekbar styles (pulsewave, particletrail, liquidfill, retrotape) to 30 fps for users on GPU-constrained machines (off by default).

- **Linux dev — sidebar and main content invisible after HMR** *(PR [#434](https://github.com/Psychotoxical/psysonic/pull/434), by [@Psychotoxical](https://github.com/Psychotoxical))*: The `data-app-blurred="true"` CSS rule introduced in #426 used a `*` selector to pause every animation while the window was unfocused. On WebKitGTK + no-compositing this triggered a stale rendering bug after Vite hot-reloads — the sidebar and main content stayed unpainted until any user interaction nudged a re-render. The rule now targets only the concrete heaviest infinite animations (eq bars, marquees, now-playing dot pulse, fullscreen mesh blob / portrait, `.spin`); release builds are unchanged in behaviour.

- **Mono playback (right channel only) after natural track end with gapless OFF** *(PR [#439](https://github.com/Psychotoxical/psysonic/pull/439), by [@Psychotoxical](https://github.com/Psychotoxical))*: When gapless playback was disabled and a track ended naturally, the next track could play only on the right channel for the rest of its duration. The 500 ms track-separation silence prepended in this exact transition was built with `Zero + take_duration`, whose integer-nanosecond math at 44.1 kHz / 2 ch leaks half a frame (44103 samples instead of 44100), shifting the next source's L/R parity in the device frame stream. Replaced with a frame-aligned `SamplesBuffer`. Manual skip and album-first-play were unaffected because they bypass the silence prepend. Independently identified by xrexy on Discord while the diagnosis was landing here.



## [1.44.0] - 2026-04-29

## Highlights

- **Orbit Listening Sessions** — synchronized multi-user listening for Psysonic users, including host/guest roles, queue mirroring, track suggestions, participant strip, host-presence handling and full in-app help.
- **Loudness Normalization** — EBU R128 / LUFS analysis with persistent cache, configurable target level and improved waveform data from the same analysis pass.
- **Now Playing Dashboard** — a richer, customizable dashboard with draggable and resizable cards, artist context, album tracklist, credits, tour dates and discography.
- **Tracks Hub** — a new full-library track-level view with random discovery, searchable browsing and Navidrome-native sorting.
- **Smart Playlists** — first-class Navidrome smart playlist creation, editing and management directly inside the Playlists page.
- **Share Links / Magic Strings** — share servers, tracks, albums, artists and queues through Psysonic magic strings.
- **Lucky Mix** — instant AudioMuse-powered mixes based on listening history, ratings and similar-song discovery.
- **Settings Overhaul** — cleaner tab structure, accordion sections, in-page search and better grouping of integrations and personalization options.
- **Playlist Suggestion Preview** — audition playlist suggestions with 30-second previews, explicit play-next controls and deliberate add-to-playlist actions.


---

## Added / New Features

### Orbit — Multi-User Listen-Together

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#304](https://github.com/Psychotoxical/psysonic/pull/304)**

Orbit introduces synchronized listening sessions for multiple Psysonic users. A host starts a session, shares a magic-string invite, and guests can join to mirror the host's queue, current track and playback position.

Guests can suggest individual tracks instead of replacing the full queue. Hosts can approve suggestions manually or enable auto-approve. Orbit also includes a live participant strip in the queue, per-guest mute, host-presence detection, automatic handling of stalled sessions and a detailed 9-section in-app help modal.

Orbit is integrated across Psysonic's interactive song surfaces, including Tracks Hub, Albums, Playlists, Random Mix, Favorites, Artist pages, Search and Advanced Search. When a session is active, song actions are routed through Orbit so guests suggest tracks and hosts enqueue them correctly.

The feature includes full i18n coverage across all supported locales and end-to-end documentation in `ORBIT.md`.

> Available in **1.44 RC1**.

### Loudness Normalization — EBU R128 / LUFS

**By [@cucadmuh](https://github.com/cucadmuh) and [@Psychotoxical](https://github.com/Psychotoxical), PRs [#315](https://github.com/Psychotoxical/psysonic/pull/315), [#317](https://github.com/Psychotoxical/psysonic/pull/317), [#326](https://github.com/Psychotoxical/psysonic/pull/326), [#333](https://github.com/Psychotoxical/psysonic/pull/333)**

Psysonic now supports integrated-loudness analysis using LUFS and applies per-track gain so material mastered at different levels lines up more consistently at a user-chosen target loudness.

Analysis results are cached in SQLite, so cold-cache analysis happens once per track and later playback reuses the stored measurement without repeating the heavy analysis work. The available LUFS targets are `-16`, `-14`, `-12` and `-10 LUFS`, with `-12 LUFS` as the default.

Normalization now lives in one section under Settings → Audio → Normalization, with Off, ReplayGain and LUFS as mutually exclusive modes.

Until a track has a stored LUFS measurement, Psysonic applies pre-analysis attenuation using a `-14 LUFS` reference calibration in storage, while the active target is reflected as an effective dB value in both the audio engine and the UI. Legacy saved values are migrated on rehydrate.

Follow-up work stabilized the LUFS analysis loop, serialized CPU-heavy seed and analysis work, kept queue target, pre-trim and ReplayGain IPC in sync when the target or pre-analysis state changes, including reseeding when analysis was cleared but waveform cache data still existed, and refined queue/settings behavior and copy.

The same analysis path now also provides richer waveform data through mixed mean/peak waveform bins without requiring a second full decode.

### Now Playing — Customizable Info Dashboard

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#266](https://github.com/Psychotoxical/psysonic/pull/266), [#267](https://github.com/Psychotoxical/psysonic/pull/267)**

The Now Playing page has been rebuilt from a flat card list into a two-column info dashboard focused on context, metadata and discovery.

The page now includes a richer cover hero, release-age information, technical badges, Last.fm love state, lyrics toggle, star rating and per-user play count. The dashboard can show a sliding-window album tracklist, top songs by the same artist, OpenSubsonic credits, artist biography, discography and Bandsintown tour dates.

Cards are draggable and resizable, and the layout is persisted per user. The implementation also includes memoized cards and TTL caches for song metadata, artist info, top songs, discography, Bandsintown and Last.fm data to avoid unnecessary refetching during same-artist playback.

### Tracks — Full Library Hub Page

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#300](https://github.com/Psychotoxical/psysonic/pull/300), closes [#299](https://github.com/Psychotoxical/psysonic/issues/299)**

Psysonic now has a dedicated Tracks page between All Albums and Build a Mix. Instead of browsing only through albums, users can explore the library directly at track level.

The page includes a rerollable “Track of the moment” hero, a random-pick rail and a virtualized, paginated browse list with search. On Navidrome, browsing uses the native `/api/song?_sort=title&_order=ASC` endpoint for proper A–Z sorting, with a graceful fallback for non-Navidrome servers.

A new `enqueueAndPlay()` helper appends a track to the queue and jumps to it instead of replacing the queue.

### Genres — Tag Cloud Refactor

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#311](https://github.com/Psychotoxical/psysonic/pull/311)**

The Genres page has been redesigned as a compact, flowing tag cloud. This replaces the previous large SVG-card grid, which could freeze the WebKitGTK renderer on large libraries.

Genre pills are sized by album count, use deterministic palette colors and open instantly even with hundreds of genres. Pagination is no longer needed.

### Now Playing Info Tab in Queue Panel

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#244](https://github.com/Psychotoxical/psysonic/pull/244)**

The right-side queue panel now includes a third tab next to Queue and Lyrics. The new Info tab shows context for the currently playing track.

It includes an artist card with biography and image from Subsonic `getArtistInfo`, song contributors from OpenSubsonic metadata, and optional Bandsintown tour dates. Bandsintown integration is opt-in and includes privacy information when disabled.

### Discover Songs Rail on Mainstage

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#301](https://github.com/Psychotoxical/psysonic/pull/301)**

The Home page now includes a new Discover Songs rail, surfacing fresh track-level recommendations alongside the existing album-focused sections.

### ReplayGain — Auto Mode

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#242](https://github.com/Psychotoxical/psysonic/pull/242)**

ReplayGain now has an Auto mode. Psysonic automatically chooses album gain when the current queue is a contiguous album and track gain for shuffled or mixed playback.

This removes the need to manually switch normalization behavior between full-album listening and mixed queues.

### Settings — Refactor, Accordions and Search

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#259](https://github.com/Psychotoxical/psysonic/pull/259), [#263](https://github.com/Psychotoxical/psysonic/pull/263), [#264](https://github.com/Psychotoxical/psysonic/pull/264), closes [#257](https://github.com/Psychotoxical/psysonic/issues/257)**

Settings have been reorganized into clearer thematic tabs: Servers, Library, Audio, Lyrics, Appearance, Personalisation, Integrations, Input, Storage, System and Users.

Tabs are now split into accordion sections for a calmer landing view. A new in-page search can expand matching sections automatically, search across tabs, support keyboard navigation and flash matching results.

Integrations such as Last.fm, Discord, Bandsintown and Now-Playing Share now live together in the Integrations tab. Sidebar, Artist and Home customizers live under Personalisation. Contributors are shown in a dedicated System section.

### Playlists — Suggestion Preview UX

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#365](https://github.com/Psychotoxical/psysonic/pull/365)**

Playlist suggestions introduce a dedicated preview workflow for auditioning recommended songs before adding them to a playlist or sending them to the queue.

Each suggestion includes a 30-second preview action with an animated progress ring. Previews play through a separate HTML5 audio element: the main player pauses during the preview, resumes when the preview ends, and cancels cleanly when playback is controlled manually.

An explicit Play Next button inserts the suggestion after the current queue item and starts playback there. Double-clicking a suggestion row adds it to the playlist, matching the existing plus button, while single-clicking the row intentionally does nothing to avoid accidental actions.

Adding a suggestion preserves the playlist scroll position. The preview path is also built to behave reliably on WebKitGTK and applies LUFS pre-analysis attenuation when loudness normalization is enabled, so previews stay closer to normal playback volume.

The feature includes updated i18n coverage across all supported locales.

### Artist Page — User-Configurable Sections

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#254](https://github.com/Psychotoxical/psysonic/pull/254), closes [#252](https://github.com/Psychotoxical/psysonic/issues/252) from [@bcorporaal](https://github.com/bcorporaal)**

The Artist Detail page now lets users reorder and hide/show individual sections such as Top Songs, Albums, Similar Artists and Bio.

The layout is persisted per user and can be configured from Settings → Personalisation.

### Album Enqueue Actions

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#256](https://github.com/Psychotoxical/psysonic/pull/256), closes [#253](https://github.com/Psychotoxical/psysonic/issues/253) from [@bcorporaal](https://github.com/bcorporaal)**

Album covers now include an Enqueue hover action next to Play. Album context menus and the multi-select toolbar also gained Enqueue actions.

All three actions append to the existing queue instead of replacing it.

### Playlists — Bulk Delete and Duplicate Confirmation

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#290](https://github.com/Psychotoxical/psysonic/pull/290), [#329](https://github.com/Psychotoxical/psysonic/pull/329)**

The Playlists page now includes a bulk-delete action while in selection mode. When adding a song that already exists in a playlist, Psysonic now asks for confirmation instead of silently adding a duplicate.

### Search — Unified SongRow and Paginated Song Results

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#303](https://github.com/Psychotoxical/psysonic/pull/303)**

Search results, Advanced Search and the Tracks Hub now share one `SongRow` component.

Song results in search pages are paginated with infinite scroll instead of being limited to a single capped batch.

### Login — Language Picker

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#328](https://github.com/Psychotoxical/psysonic/pull/328)**

The login page now includes a language picker so first-run users can choose their language before they have a server profile where that preference can be saved.

### Lucky Mix

**By [@cucadmuh](https://github.com/cucadmuh), PRs [#278](https://github.com/Psychotoxical/psysonic/pull/278), [#332](https://github.com/Psychotoxical/psysonic/pull/332)**

Lucky Mix builds an instant queue from listening history, ratings and AudioMuse similar-song batches. It skips low-rated tracks, honors the active library scope and can be cancelled while building.

The feature appears in the sidebar, mobile overlay and Mix landing page when AudioMuse is available. Follow-up work corrected the rating filter against Navidrome's OpenSubsonic rating fields.

### Library Deep Links — `psysonic2-` Share Scheme

**By [@cucadmuh](https://github.com/cucadmuh), PR [#261](https://github.com/Psychotoxical/psysonic/pull/261)**

Psysonic can now share tracks, albums, artists and queues through `psysonic2-` magic strings. Pasting one into the app switches to the matching server and plays or navigates to the shared item.

Queue links resolve tracks in chunks and report how many tracks could be played or skipped when the receiving server is missing items.

### Magic-String Server Invites and Navidrome Admin Sharing

**By [@cucadmuh](https://github.com/cucadmuh), PR [#258](https://github.com/Psychotoxical/psysonic/pull/258)**

Navidrome admins can generate a `psysonic1-` invite string that pre-fills the add-server form for another user. The add-user dialog also validates library access so non-admin users cannot be saved without any libraries.

### Sleep Timer — Circular Ring UI

**By [@cucadmuh](https://github.com/cucadmuh), PR [#272](https://github.com/Psychotoxical/psysonic/pull/272)**

The sleep timer and delayed-start UI now use a circular progress ring around the play/pause button, with an in-button countdown and redesigned timer modal.

The updated UI works across PlayerBar, FullscreenPlayer and MobilePlayerView.

### Queue — Undo/Redo with Hotkeys

**By [@cucadmuh](https://github.com/cucadmuh), PR [#331](https://github.com/Psychotoxical/psysonic/pull/331)**

Queue edits can now be undone and redone with Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z. Queue snapshots include order, current track, playback position, play/pause state and scroll offset.

Restoring a snapshot preserves playback when possible and resyncs the audio engine when needed.

### Sidebar — Long-Press Drag to Reorder

**By [@cucadmuh](https://github.com/cucadmuh), PR [#269](https://github.com/Psychotoxical/psysonic/pull/269)**

Sidebar items can now be reordered by long-press dragging. Dropping an item outside the sidebar hides it, using the same hidden-state model as the Settings customizer.

### Playlists — Navidrome Smart Playlists

**By [@cucadmuh](https://github.com/cucadmuh), PR [#289](https://github.com/Psychotoxical/psysonic/pull/289), proposed by bequbed on Discord**

Navidrome smart playlists are now managed directly inside the Playlists page. Users can create, edit and delete smart playlists using the same flow as regular playlists, with a dedicated rule editor for smart playlist parameters.

Smart playlists have distinct icons and support filters such as genre include/exclude, year ranges, ratings and metadata rules.

### Song Info — Copy Fields via Double-Click

**By [@cucadmuh](https://github.com/cucadmuh), PR [#323](https://github.com/Psychotoxical/psysonic/pull/323)**

Double-clicking any field in the Song Info modal copies that value to the clipboard.

### Mobile UI Overhaul

**By [@kilyabin](https://github.com/kilyabin), PR [#238](https://github.com/Psychotoxical/psysonic/pull/238)**

A broad pass over mobile and narrow-viewport layouts, including the sidebar drawer, player view, queue, search and detail pages.

### Logging — Runtime Levels and Debug Export

**By [@cucadmuh](https://github.com/cucadmuh), PR [#241](https://github.com/Psychotoxical/psysonic/pull/241)**

Settings now allow switching between `info` and `debug` log levels at runtime. Users can also export the current debug log for bug reports.

### CLI — Logs Subcommand

**By [@cucadmuh](https://github.com/cucadmuh), PR [#337](https://github.com/Psychotoxical/psysonic/pull/337)**

The `psysonic` CLI now includes a `logs` subcommand with `tail` and `--follow` support.

---

## Changed / Improved

### Performance Suite

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#245](https://github.com/Psychotoxical/psysonic/pull/245), [#246](https://github.com/Psychotoxical/psysonic/pull/246), [#247](https://github.com/Psychotoxical/psysonic/pull/247), [#248](https://github.com/Psychotoxical/psysonic/pull/248), [#249](https://github.com/Psychotoxical/psysonic/pull/249), [#250](https://github.com/Psychotoxical/psysonic/pull/250), [#251](https://github.com/Psychotoxical/psysonic/pull/251)**

A coordinated performance pass improved several expensive areas of the app:

- Search thumbnails now use `CachedImage` to reduce redundant image loading.
- Device Sync parallelizes `getAlbum` calls when syncing artist sources.
- Album infinite-scroll prefetching starts earlier for smoother scrolling.
- Resolved lyrics are persisted to IndexedDB and survive app restarts.
- Rarely used pages are lazy-loaded and vendor chunks are split.
- Artist list filtering and grouping are memoized.
- Genre sorting and rendering were optimized, later replaced by the new tag-cloud layout.

### Navidrome Admin API Resilience

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#260](https://github.com/Psychotoxical/psysonic/pull/260)**

The Navidrome admin REST client is more resilient against flaky upstream behavior. Psysonic now forces HTTP/1.1 for these calls, requires TLS 1.2+, retries transient errors and shows a cleaner UI retry surface instead of raw error toasts.

### Linux Audio Device Selection

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#288](https://github.com/Psychotoxical/psysonic/pull/288)**

On Linux, Psysonic now prefers `pipewire` and then `pulse` before falling back to the default CPAL device resolution.

This avoids cases where the default device resolves to a null sink on PipeWire-based systems. Explicit user device selection in Settings is still respected.

### Tauri Devtools Behavior

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#307](https://github.com/Psychotoxical/psysonic/pull/307), [#310](https://github.com/Psychotoxical/psysonic/pull/310)**

Devtools no longer auto-open during development and are disabled in production builds. In dev builds, they can still be opened with Ctrl+Shift+I.

### Dependency Updates

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#306](https://github.com/Psychotoxical/psysonic/pull/306)**

Updated `rustls-webpki` and `postcss`.

### Subsonic HTTP User-Agent Alignment

**By [@cucadmuh](https://github.com/cucadmuh), PR [#235](https://github.com/Psychotoxical/psysonic/pull/235)**

Rust-side HTTP requests now send the same User-Agent as the main WebView requests, helping servers, rate limiters and reverse proxies identify Psysonic consistently.

---

## Fixed Since Preview / RC

### Cross-Device Resume Position

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#318](https://github.com/Psychotoxical/psysonic/pull/318)**

Server-side play-queue position could remain at the start of a long track if the app was closed without a seek or track change. Psysonic now flushes queue position through a playback heartbeat, on pause and through shared quit paths.

### Image Cache Blob URL Lifetime

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#313](https://github.com/Psychotoxical/psysonic/pull/313), [#321](https://github.com/Psychotoxical/psysonic/pull/321)**

The shared blob URL cache could revoke an image URL while another component still used it, causing `blob:` load errors. Cover URLs are now reference-counted and only revoked after the last consumer unmounts.

### Queue Scroll Context

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#314](https://github.com/Psychotoxical/psysonic/pull/314)**

Clicking a track in the queue no longer snaps the queue list back to the current now-playing position when the user is browsing elsewhere in the queue.

### Mini Player Saved Position

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#280](https://github.com/Psychotoxical/psysonic/pull/280)**

Saved mini-player coordinates are now checked against the current monitor layout. If the saved monitor no longer exists, the position is discarded instead of opening the mini player off-screen.

### Mini Player Volume Popover

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#279](https://github.com/Psychotoxical/psysonic/pull/279)**

The mini-player volume popover is now portal-rendered so it can no longer be clipped by the mini-player window bounds.

### Gapless Volume Handling

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#277](https://github.com/Psychotoxical/psysonic/pull/277)**

Volume changes prepared for the next gapless track are now deferred until the actual transition, preventing them from affecting the still-playing track.

### Search Context Menu and Live Search Behavior

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#298](https://github.com/Psychotoxical/psysonic/pull/298), [#302](https://github.com/Psychotoxical/psysonic/pull/302)**

Live-search clicks now enqueue and play correctly, right-clicking repositions the existing context menu instead of opening a second one, and artist/album rows in search results now support the expected context menu behavior.

### Server Switch Playback and Home Refresh

**By [@Psychotoxical](https://github.com/Psychotoxical), PRs [#262](https://github.com/Psychotoxical/psysonic/pull/262), [#291](https://github.com/Psychotoxical/psysonic/pull/291)**

Switching servers no longer tears down playback when the same track is still cached locally. The Home page also refreshes correctly after changing the active server.

### Queue Panel Persistence and LUFS Cleanup

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#336](https://github.com/Psychotoxical/psysonic/pull/336)**

The queue panel's open/closed state is now persisted across restarts. A dead loudness-store binding left over from the LUFS branch was removed.

### Toolbar Icons

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#284](https://github.com/Psychotoxical/psysonic/pull/284), closes [#274](https://github.com/Psychotoxical/psysonic/issues/274)**

The Gapless and Infinite Queue toolbar icons now match their actions correctly.

### Pointer Gesture Performance Regression

**By [@cucadmuh](https://github.com/cucadmuh) and [@Psychotoxical](https://github.com/Psychotoxical), PRs [#281](https://github.com/Psychotoxical/psysonic/pull/281), [#282](https://github.com/Psychotoxical/psysonic/pull/282), [#283](https://github.com/Psychotoxical/psysonic/pull/283)**

A short-lived performance spike caused by overlapping pointer gestures was fixed after an initial patch, revert and clean re-landing.

### pingWithCredentials Diagnostics

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#312](https://github.com/Psychotoxical/psysonic/pull/312)**

Credential ping failures are now logged instead of failing silently, making server/auth issues easier to diagnose from debug logs.

### Fullscreen WebKitGTK Halo

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#239](https://github.com/Psychotoxical/psysonic/pull/239)**

The fullscreen mesh-blob background no longer shows a faint halo ring on WebKitGTK.

### Custom Titlebar Glyphs

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#243](https://github.com/Psychotoxical/psysonic/pull/243)**

The macOS-style traffic-light glyphs in the custom titlebar are now hidden at rest and only appear on hover.

### Discord Rich Presence Diagnostics

**By [@Psychotoxical](https://github.com/Psychotoxical), PR [#330](https://github.com/Psychotoxical/psysonic/pull/330)**

Debug-only logging was added for the Discord Rich Presence IPC path to make connection issues easier to inspect.

### Streaming Seek UI Freeze

**By [@cucadmuh](https://github.com/cucadmuh), PR [#236](https://github.com/Psychotoxical/psysonic/pull/236), closes [#218](https://github.com/Psychotoxical/psysonic/issues/218)**

Seeking on streaming tracks no longer blocks the render thread or causes the progress indicator to snap back during the pending seek.

### Windows WebView2 Hidden-Window Activity

**By [@peri4ko](https://github.com/peri4ko), PR [#273](https://github.com/Psychotoxical/psysonic/pull/273), follow-up by [@Psychotoxical](https://github.com/Psychotoxical), PR [#276](https://github.com/Psychotoxical/psysonic/pull/276)**

Hidden Windows WebView2 windows now pause more UI work while hidden, including CSS animations and selected periodic tasks.

### Linux Wayland Drag Ghost

**By [@cucadmuh](https://github.com/cucadmuh), PR [#268](https://github.com/Psychotoxical/psysonic/pull/268)**

Wayland drag operations no longer leave GTK drag proxies or PsyDnD ghost elements behind after drag end or cancel.

### Queue Panel Resize Handle

**By [@cucadmuh](https://github.com/cucadmuh), PR [#324](https://github.com/Psychotoxical/psysonic/pull/324)**

The queue panel resize handle is no longer blocked by the main page scroll hit-test area at certain viewport widths.

### Album Queueing and Smart Playlist Targets

**By [@cucadmuh](https://github.com/cucadmuh), PR [#322](https://github.com/Psychotoxical/psysonic/pull/322)**

Queueing a full album after the current track now behaves reliably. Smart playlists are also filtered out of manual “Add to playlist” target lists.

### Analysis Cache Logging

**By [@cucadmuh](https://github.com/cucadmuh), PR [#320](https://github.com/Psychotoxical/psysonic/pull/320)**

Waveform path logging in the analysis cache now reports the correct LUFS pipeline state.

### UI Overlay and Scroll Fixes

**By [@cucadmuh](https://github.com/cucadmuh), PR [#255](https://github.com/Psychotoxical/psysonic/pull/255)**

Overlay-scrollbar state reporting, column-resizer hit testing and Linux mini-player mouse-wheel scrolling were improved.


### Contributors

- [@cucadmuh](https://github.com/cucadmuh) — Loudness Normalization headline (#315), LUFS stabilisation (#326), Lucky Mix (#278), Queue undo/redo (#331), Sleep Timer ring UI (#272), Library deep links (#261), Magic-string invites (#258), CLI logs subcommand (#337), runtime log levels + debug log export (#241), smart playlists workflow (#289), several streaming + UI fixes.
- [@Psychotoxical](https://github.com/Psychotoxical) — Orbit (#304), Now-Playing dashboard (#266 / #267), Tracks Hub (#300), Genres tag-cloud (#311), Settings refactor (#259), perf suite (#245–#251), and most of the cross-device + admin-API hardening work.
- [@peri4ko](https://github.com/peri4ko) — Windows WebView2 idle hooks (#273).
- [@kilyabin](https://github.com/kilyabin) — Mobile UI overhaul (#238).

## [1.43.0] - 2026-04-20

### Added

- **User Management — admin-gated tab in Settings** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: When the active server is Navidrome and the logged-in user is an admin, Settings gets a new "Users" tab. Lists every user with username, display name, email, last-access timestamp and assigned libraries. Add / edit / delete via Navidrome's native REST API (`/api/user`) using a Bearer token obtained from `/auth/login` — the Subsonic API doesn't expose this, so non-Navidrome servers don't get the tab.

- **User Management — per-user library assignment** *(by [@Psychotoxical](https://github.com/Psychotoxical), PR [#222](https://github.com/Psychotoxical/psysonic/pull/222))*: Mirrors the Navidrome web client. Non-admin users get a checkbox picker showing every library on the server; the picker is hidden for admins (Navidrome auto-grants them access to all libraries). Inline validation prevents saving a non-admin with zero libraries.

- **User Management — last-access timestamp per user** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Each row shows when the user was last active, formatted as a localised relative time (`vor 5 Min.`, `2h ago`, etc.) using `Intl.RelativeTimeFormat`. Tooltip carries the absolute timestamp. Users who have never logged in show "Never".

- **Seekable streaming + instant local playback — first cut** *(by [@Psychotoxical](https://github.com/Psychotoxical) and [@cucadmuh](https://github.com/cucadmuh))*: New `RangedHttpSource` + `LocalFileSource` audio backends. Seek operations on remote tracks now issue HTTP `Range` requests instead of restarting the stream from byte 0, and locally cached files start playing instantly without going through the HTTP path at all. WaveformSeek commits the seek on mouseup (not during drag), and progress ticks during a drag are ignored so the playhead doesn't jitter back and forth. **Note:** the underlying seek/buffer behaviour is not fully sorted yet — expect follow-up changes in the next releases as edge cases (slow proxies, partial-content retries, codec-specific quirks) get ironed out.

- **Mini player — queue-style meta block, action toolbar, vertical volume slider** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The mini's right column gets a richer track-info block matching the queue panel's styling. A dedicated action toolbar (love / queue / context menu) sits below the transport. The horizontal volume slider is replaced by a tall vertical one on the right edge for a more compact footprint.

- **Settings — compact spacing pass + row hover affordance** *(by [@Psychotoxical](https://github.com/Psychotoxical), PR [#223](https://github.com/Psychotoxical/psysonic/pull/223))*: Section margins, card padding and divider spacing all tightened — every Settings tab fits more content per viewport. Each toggle row gains a subtle accent-tinted hover background that bleeds to the card edges so the active row is visually obvious.

- **Floating player bar — toggleable variant** *(by [@kveld9](https://github.com/kveld9), PR [#216](https://github.com/Psychotoxical/psysonic/pull/216))*: Settings → Appearance → "Floating player bar" turns the player bar into a floating, rounded panel that sits above the page content with a margin around all four edges. Off by default. Solid background, works with every theme.

- **Floating player bar — liquid-glass look on macOS and Windows** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: When the floating bar is enabled, macOS and Windows users get a gentler glass-effect background (subtle blur + tint) on top of @kveld9's solid variant. Linux keeps the solid look — WebKitGTK's `backdrop-filter` cost is too high for an always-visible panel. A new `data-platform` attribute on `<html>` is the generic platform-gate that other CSS can hook into.

- **NVIDIA proprietary driver — DMA-BUF auto-disabled on Linux** *(by [@kveld9](https://github.com/kveld9), PR [#217](https://github.com/Psychotoxical/psysonic/pull/217), refactored by [@Psychotoxical](https://github.com/Psychotoxical))*: Detects the NVIDIA proprietary driver at startup and sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` for the WebKitGTK process, avoiding rendering glitches that show up specifically on that combo. Confirmed via blind A/B testing — only the proprietary driver is targeted; Nouveau / AMD / Intel are not touched.

- **Lyrics — cubic ease-out scroll animator** *(by [@kilyabin](https://github.com/kilyabin), PRs [#214](https://github.com/Psychotoxical/psysonic/pull/214) / [#215](https://github.com/Psychotoxical/psysonic/pull/215))*: The lyrics auto-scroll animation is replaced by a smoother cubic ease-out curve (renamed internally from `springScroll` to `easeScroll`). Active line transitions are noticeably less jerky on long line-spacing changes.

- **Fullscreen lyrics — fade bottom edge of plain lyrics scroll viewport** *(by [@kilyabin](https://github.com/kilyabin))*: Plain (unsynced) lyrics in the fullscreen player now fade out at the bottom of the scroll viewport via a `mask-image` gradient, matching the existing fade on the synced-lyrics overlay.

### Fixed

- **Mini player — main window minimises on open + width cap on non-tiling WMs** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Opening the mini now reliably minimises the main window (previously hit-or-miss on some WMs), and the mini's width is capped on non-tiling Linux WMs so it doesn't open larger than its intended footprint when the user's WM hands it the full screen.

- **Artist page — Top Songs continues playback past the last track** *(by [@kveld9](https://github.com/kveld9), PR [#220](https://github.com/Psychotoxical/psysonic/pull/220))*: Playing a song from the Artist page's Top Songs row no longer stops after the row's last track — the queue continues into the surrounding context as intended.

- **Padding fixes across several pages** *(by [@kveld9](https://github.com/kveld9), PR [#221](https://github.com/Psychotoxical/psysonic/pull/221))*: Layout polish, mostly aligning content to the page-level container padding instead of the inner card padding.

- **Jayfin theme — WCAG AA contrast fixes for nav + primary buttons** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Hover and active states on the Jayfin theme's sidebar nav items and primary buttons now pass WCAG AA contrast against the underlying background.

- **Lyrics — sidebar lyrics with YouLy+ source render as a single line** *(by [@kilyabin](https://github.com/kilyabin))*: Lines from the YouLyrics+ source were being split across multiple visual lines in the QueuePanel lyrics pane. Now collapse onto one line as intended.

- **Settings → Lyrics Sources — drag-and-drop survives mode toggle** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Reordering lyrics sources via drag-and-drop no longer resets when toggling the synced-vs-plain mode.

- **Folder browser — auto-contrast text on selected row** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Selected rows in the folder browser now compute text colour from the row's background luminance, so light themes don't paint white-on-white text.

- **Titlebar — theme-independent traffic-lights + song pill** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The macOS-style traffic-lights and the now-playing pill in the titlebar use fixed colours instead of theme tokens, so they stay legible on every theme without needing per-theme overrides.

### Reverted

- **Reverted: fs-player WebKitGTK CPU-cut patch** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: An earlier perf patch in the Fullscreen Player that disabled compositing under WebKitGTK turned out to cause animation regressions in real-world use. Reverted; the original code path is back.

### Changed

- **AudioMuse toggle — Alpha badge dropped** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The AudioMuse-AI integration has been stable for several releases; the "Alpha" tag in Settings → Server is removed.

## [1.42.1] - 2026-04-19

> **🚨 Critical bug fix for Windows users.** On 1.42.0, opening the mini player on Windows could stall Tauri's event loop: the mini would appear as a blank white window, neither the main window nor the mini could be closed, and the only way out was killing the process via Task Manager. **Please update immediately if you're on Windows 1.42.0.** macOS and Linux were not affected.

### Fixed

- **Mini player no longer hangs the app on Windows** *([@Psychotoxical](https://github.com/Psychotoxical))*: Creating the second WebView2 webview lazily from the `open_mini_player` invoke handler reliably froze the app on Windows — the mini opened blank, both windows became unresponsive, and the user had to kill the process from Task Manager. The builder + `main.minimize()` combo racing against WebView2's first paint was the trigger. The mini webview is now pre-built hidden in Tauri's `.setup()` on Windows, so the first open is a pure show/hide instead of creation + minimize. `open_mini_player` is simpler on all platforms, the minimize-main dance around show/hide is skipped on Windows, and Windows also goes back to the native window decorations (the earlier `decorations: false` mini titlebar was part of the hang surface).
- **Mini player syncs immediately on first open** *([@Psychotoxical](https://github.com/Psychotoxical))*: With the mini pre-created on Windows, the mount-time `mini:ready` event could race past the main window's bridge listener and leave the mini without a snapshot when the user actually opened it. The mini now also re-emits `mini:ready` on every window focus, so opening the mini always triggers a fresh sync regardless of startup ordering.

### Added

- **Optional “Preload mini player” setting on Linux + macOS** *([@Psychotoxical](https://github.com/Psychotoxical))*: Settings → General → App behaviour. Off by default. When enabled, the mini player window is built hidden at app start so the first open is instant instead of waiting a few seconds for WebKit to boot + React to hydrate + the bridge snapshot to arrive. Costs one extra WebKit process in the background permanently (~50–100 MB RAM). Windows always preloads regardless of this toggle — it's how we work around the hang above, not an opt-in feature there.

## [1.42.0] - 2026-04-19

> **🛠️ Note on the 1.41.0 jump:** The 1.41.0 tag exists as an internal Draft release on GitHub — it was used to wire up and verify the Cachix substituter pipeline and never went public. **1.42.0 is the first public release after 1.40.0** and consolidates everything that was prepared for 1.41.0 plus the work landed on top in the days since.
>
> **❄️ Cachix is live for NixOS users.** The `psysonic.cachix.org` substituter is now actually fed by every release. Earlier 1.40.x runs were silently skipping the cache push (see *Fixed* below), so the first user to ask for a given output paid the full compile cost. Starting with 1.42.0, `nix run github:Psychotoxical/psysonic` and the NixOS module both pull the prebuilt closure straight from Cachix — no local Rust + symphonia + libopus build required.

### Added

- **Mini player — feature-complete second cut** *(Issue [#162](https://github.com/Psychotoxical/psysonic/issues/162), by [@Psychotoxical](https://github.com/Psychotoxical))*: The early-alpha mini from the internal 1.41.0 prep gets the rest of the workflow it was missing.
  - **Expandable queue panel** with full track list, search-style overlay scrollbar (no width-eating gutter), drag-to-reorder using the existing PsyDnD system, and a localized right-click context menu (Play now / Remove from queue / Open album / Go to artist / Favorite / Song info — all forwarded to the main window via Tauri events so the source-of-truth playerStore stays consistent).
  - **Custom in-page titlebar** on Windows + Linux with a drag region, the current track title and the queue / pin / open-main / close action icons. macOS keeps the native traffic-lights titlebar so the system look is preserved. The lower toolbar from the alpha is gone — its four buttons live in the titlebar now.
  - **Persistent geometry**: window position, expanded-queue height and queue-open state all survive an app restart. Position is written to `<app_config_dir>/mini_player_pos.json` on every move (throttled), and re-applied after each show — Linux WMs (Mutter/KWin) re-centre hidden windows on show, so without re-applying the position would be lost on the second open.
  - **User-bindable keyboard shortcut** in Settings → Shortcuts (`open-mini-player`, default unbound). The same chord toggles between main and mini regardless of which window has focus.
  - **Layout polish**: cover shrinks 112 → 84 px, the right column gets title / artist / transport in a single block, progress + toolbar take full width.
  - **Live theme / font / language sync**: changes in the main window propagate to an open mini via the shared localStorage `storage` event — no need to close + re-open the mini after rebinding a shortcut or switching themes.
  - **Always-on-top reliability fix**: WMs that silently ignore `set_always_on_top(true)` when the flag is "already true" (KWin, certain Mutter releases) get a forced false → true cycle so the constraint is actually re-evaluated. The frontend also re-asserts the pin state on mount and on focus, so the user no longer has to click the pin button twice for it to stick.

- **Player bar — click-to-toggle duration / remaining time** *(contributed by [@kveld9](https://github.com/kveld9), PR [#212](https://github.com/Psychotoxical/psysonic/pull/212))*: Click the time read-out in the player bar to swap between total duration (`3:45`) and remaining time (`-2:34`). Updates live, persisted to `themeStore.showRemainingTime`. A small swap icon (⇄) and hover highlight signal the interaction.

- **Queue — ReplayGain in tech strip, expandable badge** *(Issue [#195](https://github.com/Psychotoxical/psysonic/issues/195), originally by [@cucadmuh](https://github.com/cucadmuh) in PRs [#196](https://github.com/Psychotoxical/psysonic/pull/196) / [#201](https://github.com/Psychotoxical/psysonic/pull/201) — UX iteration by [@Psychotoxical](https://github.com/Psychotoxical) on cucadmuh's feedback)*: Tracks with ReplayGain metadata now show a small `RG ⌄` pill at the end of the codec/bitrate/sample-rate strip. Hover reveals the values via tooltip; click expands a second line ("ReplayGain · T -8.9 dB · A -11.0 dB · Peak 0.998") that is persisted across sessions. Hides itself for tracks without RG metadata.

- **Changelog — sidebar banner + dedicated `/whats-new` page** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The auto-popup modal that nagged the user on first launch after each update is replaced by a discreet sidebar banner. Clicking it opens a full `/whats-new` page that renders the latest CHANGELOG section in app — no separate Markdown viewer, no broken links to GitHub.

- **Favorites — genre column + Top Favorite Artists row** *(Issue [#87](https://github.com/Psychotoxical/psysonic/issues/87), by [@Psychotoxical](https://github.com/Psychotoxical))*: The Favorites tracklist now has a toggleable Genre column (alongside the existing Album column and multi-genre filter). A new horizontally scrolling "Top Favorite Artists" row sits between Radio Stations and Songs, aggregated from starred tracks and sorted by star count. Clicking an artist card narrows the song list to that artist.

- **Compilation filter on All Albums** *(Issue [#65](https://github.com/Psychotoxical/psysonic/issues/65), by [@Psychotoxical](https://github.com/Psychotoxical))*: A tri-state toggle in the Albums page header (All / Only compilations / Hide compilations) that reads the OpenSubsonic `isCompilation` tag exposed by Navidrome 0.61+. Client-side filter, no additional server calls. Translated into all 8 supported locales.

- **Sticky header on Albums, New Releases, Artists** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The header row with search/sort/genre/year controls now pins to the top while scrolling, so filters stay reachable without jumping back up. Works the same on all three browse pages.

- **Device Sync — album artist on both panels** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Album entries in both the library (left) and on-device (right) panels now display `Album · Artist` inline, so sampler discs and self-titled albums are no longer guesswork. Playlists unchanged.

- **NixOS — first-class flake install guide** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PRs [#209](https://github.com/Psychotoxical/psysonic/pull/209) / [#210](https://github.com/Psychotoxical/psysonic/pull/210))*: A new top-level `nixos-install.md` walks through adding Psysonic as a flake input, installing via `environment.systemPackages` / `home.packages`, and wiring up the public `psysonic.cachix.org` substituter so every NixOS user pulls prebuilt binaries. README links to it directly.

- **README — AppImage in the Linux install options + Cachix badge** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The Linux install section now lists AppImage alongside `.deb`, `.rpm`, AUR and Nix flakes. A Cachix badge on the README header signals that NixOS users get prebuilt binaries.

### Changed

- **Genre filter — portal popover** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The inline tagbox + dropdown (capped at 60 entries, ate header space when expanded) is replaced by a compact button that opens a portal-rendered popover with a search field and the full scrollable list of genres. Selected genres sort to the top. Used on Albums, New Releases, Random Albums and Favorites.

- **Year filter — portal popover** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The From/To number inputs in the Albums header became a single button with a popover mirroring the genre filter pattern. When the filter is active, the button shows the range (e.g. `2020–2024`) in accent colour.

- **Sort picker — portal dropdown** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The two sort buttons on Albums (`A–Z (Album)`, `A–Z (Artist)`) collapse into one dropdown button showing the current choice. Generic `SortDropdown` component, reusable for other pages.

- **Device Sync — album/playlist meta inline** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: `BrowserRow` renders secondary info inline with a `·` separator in muted colour instead of a separate right-aligned column, matching the on-device panel's format.

- **README — Arch/AUR fold-up** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The Arch / AUR install instructions are folded into the Linux install section so the README stops scrolling forever.

### Fixed

- **Player bar — black-flash on WebKitGTK** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Linux users occasionally saw the entire player bar paint fully black for one frame when an unrelated layer elsewhere on the page invalidated. `contain: layout paint` makes the bar its own paint boundary so it can no longer be pulled into a surrounding dirty rect. No-op on platforms that don't exhibit the flash (Wayland-with-GPU, Chromium webviews on Windows / macOS).

- **Player bar — time-toggle tooltip uses the in-app TooltipPortal** *(follow-up to PR [#212](https://github.com/Psychotoxical/psysonic/pull/212), by [@Psychotoxical](https://github.com/Psychotoxical))*: The new time-swap control was rendering the native browser `title=` tooltip (unstyled OS popup, ignored by every other control). Switched to `data-tooltip="…"` so it matches every other player-bar tooltip.

- **Fullscreen player — lyrics menu toggle + readability** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Re-clicking the mic icon now actually closes the lyrics settings panel instead of the outside-click handler closing it and the click re-opening it — the trigger button is excluded from the outside-check. The panel itself is now a solid surface (no backdrop blur, near-opaque background, higher-contrast button text) so settings remain readable over the busy fullscreen background.

- **i18n — ArtistCardLocal album count** *(contributed by [@cucadmuh](https://github.com/cucadmuh))*: Local artist cards were rendering the album count with hardcoded German (`Album` / `Alben`). Switched to the existing plural-aware `artists.albumCount` key which already covers all 8 locales including Russian Slavic plurals.

- **Release CI — Cachix never receiving the psysonic closure** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: `cachix-action` installs its post-build hook via `NIX_USER_CONF_FILES`, but the Determinate Nix daemon that runs the actual builds reads the system nix.conf — so the hook never fired. Only a couple of early prep paths ever reached the cache, never the compiled `psysonic` output. The release workflow now pushes the full closure explicitly after `nix build`; Cachix dedupes against paths already present, so redundancy is cheap.

### Contributors

- [@kveld9](https://github.com/kveld9) — click-to-toggle duration / remaining time in the player bar.
- [@cucadmuh](https://github.com/cucadmuh) — i18n fix for ArtistCardLocal, ReplayGain UX feedback that drove the expandable badge, NixOS install guide, README polish.

---

## [1.40.0] - 2026-04-18

### Added

- **macOS — signed and notarized builds** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: macOS releases are now signed with a Developer ID Application certificate and notarized by Apple. Gatekeeper no longer shows the "app from unidentified developer" dialog; the DMG opens and runs with a single click on both Apple Silicon and Intel Macs. Signing + notarization happens in CI on every release.

- **macOS — in-app auto-update** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The Tauri Updater plugin is now active on macOS. When a new release is available, clicking **Install now** in the notification modal downloads the signed `.app.tar.gz` bundle, verifies its minisign signature against the bundled public key, replaces `/Applications/Psysonic.app` in place, and relaunches the app — all in one click, no Gatekeeper re-approval, no manual DMG handling. The modal shows trust badges ("Notarized by Apple" + "Signature verified"), a 3-second restart countdown after install with a manual "Restart now" option, and hides redundant buttons during each download/install phase. Windows and Linux continue to use the existing "download installer / point to folder" flow until their signing pipelines are wired up.

- **WebKitGTK wheel scroll mode (Linux)** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#207](https://github.com/Psychotoxical/psysonic/pull/207))*: The Linux build now defaults to WebKitGTK's native smooth (kinetic) wheel scrolling and exposes a toggle in Settings → General to fall back to classic linear line-by-line scroll. Existing installs are migrated to smooth scrolling once, after which the toggle is fully user-controlled.

### Changed

- **Device Sync — fixed naming scheme + playlist folders** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The user-configurable filename template is gone. Every sync now writes files under a single, non-negotiable scheme:
  - Album / artist sources: `{AlbumArtist}/{Album}/{TrackNum:02d} - {Title}.{ext}`
  - Playlist sources: `Playlists/{PlaylistName}/{Index:02d} - {Artist} - {Title}.{ext}` plus a self-contained `.m3u8` that references sibling filenames.

  **Why:** different OSes normalised separators and special characters differently, so the same library synced from macOS and then plugged into a Windows machine appeared "different" and re-downloaded every album. The fixed scheme ends that forever.

  **Playlist folders instead of the album tree:** playlists used to be scattered across the album structure as `.m3u8` references. For playlists with 40 artists that meant 40 new folders on the stick. Now every playlist is one self-contained folder; the `.m3u8` sits inside it and references siblings, so you can copy the whole folder anywhere.

  **Migration for existing sticks:** a "Reorganize existing files…" button on the Device Sync page reads the legacy template from the v1 manifest, computes per-track rename pairs, detects collisions, and executes atomic `fs::rename`s. Empty directories left behind are cleaned up automatically. Playlist tracks synced under the old scheme are left for the next sync to re-download into the new playlist folder, rather than being force-moved.

  **Album-Artist fallback:** libraries without an albumArtist tag fall back to the track artist — "Unknown Artist" is only ever a last-resort placeholder.

### Fixed

- **WCAG contrast audit — Middle-Earth theme** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Raised `--warning`, `--border`, `--text-muted`, `--positive`, and multiple component-level overrides (connection indicators, nav section labels, lyrics status, queue duration, player time, glass-panel muted text) to AA thresholds on all background variants. The warm bronze / aged-parchment palette is preserved — no cool tones introduced.

- **WCAG contrast audit — Nucleo theme** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Darkened `--warning`, `--border`, `--text-muted`, and `--positive` tokens to reach AA on the warm cream palette; added a component-level override for the column resize grip (default `--ctp-surface1` was 1.08:1 on the card background, effectively invisible) using the new `--border` token at 2px width. Brass-and-parchment aesthetic preserved.

### Contributors

- **PR [#205](https://github.com/Psychotoxical/psysonic/pull/205)** — Apple Music-style scrolling lyrics with spring-physics scroll, by [@kilyabin](https://github.com/kilyabin).
- **PR [#206](https://github.com/Psychotoxical/psysonic/pull/206)** — Golos Text + Unbounded fonts with Cyrillic support, by [@kilyabin](https://github.com/kilyabin).
- **PR [#207](https://github.com/Psychotoxical/psysonic/pull/207)** — WebKitGTK wheel scroll mode toggle, by [@cucadmuh](https://github.com/cucadmuh).

All three now credited in Settings → About.

---

## [1.34.13] - 2026-04-17

### Added

- **YouLyPlus — word-by-word synced lyrics (karaoke)** *(Issue [#172](https://github.com/Psychotoxical/psysonic/issues/172), by [@Psychotoxical](https://github.com/Psychotoxical))*: Settings → Lyrics now exposes a mode toggle between the existing **Standard** pipeline (Server tags + LRCLIB + Netease, configurable order) and a new **YouLyPlus** mode that fetches karaoke-style word-sync lyrics from the public `lyricsplus` aggregator (Apple Music / Spotify / Musixmatch / QQ Music). When a track has no YouLyPlus entry the app silently falls back to the Standard pipeline, so obscure titles still resolve. Active word highlighting in both the sidebar Lyrics pane and the Fullscreen Player. Five backend mirrors are tried on network failure; no API keys on the user side — subscription costs are borne by the lyricsplus operator.

- **Static-only lyrics option** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: A new toggle renders synced lyrics as plain static text — no auto-scroll, no word highlighting — for users who prefer to read rather than follow. Works in both Standard and YouLyPlus modes.

- **Discord Rich Presence — collapsible advanced options** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The *Fetch covers from Apple Music* toggle and the *Custom text templates* form are now tucked under a single collapsible **Advanced Discord options** header (default collapsed) that only appears when Discord Rich Presence is enabled. Reduces vertical noise in Settings → General for the common case.

### Fixed

- **macOS — spurious microphone permission prompt (real fix)** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The 1.34.12 attempt of removing `NSMicrophoneUsageDescription` did not actually suppress the prompt — on modern macOS, TCC fires at AudioUnit instantiation time, not at Info.plist level. Root cause: `cpal` (via `rodio`) instantiates an `AUHAL` output unit (`IOType::HalOutput`), which macOS classifies as input-capable even for playback-only apps. Psysonic now ships a vendored `cpal 0.15.3` at `src-tauri/patches/cpal-0.15.3/` wired via `[patch.crates-io]`; the patch forces `IOType::DefaultOutput` for all output streams, which never touches input and never triggers the mic dialog. **Tradeoff:** per-device output selection is a no-op on macOS — the stream always follows the system default (change via System Settings → Sound or the menu-bar speaker icon). Matches the behaviour of Apple Music and Spotify on macOS. Settings surfaces this with an explanatory notice on macOS and hides the device picker there.

---

## [1.34.12] - 2026-04-17

### Added

- **Playback source indicator in Queue** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#201](https://github.com/Psychotoxical/psysonic/pull/201))*: The current-track tech strip in the Queue panel now shows a **source badge** indicating how the track was loaded: `stream` (live from server), `preloaded` (buffered before playback), or `cache` (served from local hot cache). Preload tracking is wired through the Rust audio engine so the badge reflects actual playback origin, not just current state.

- **ReplayGain metadata in Queue tech strip** *(Issue [#195](https://github.com/Psychotoxical/psysonic/issues/195), contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#196](https://github.com/Psychotoxical/psysonic/pull/196))*: The current-track tech strip now shows track and album ReplayGain values alongside bitrate and format when the file contains gain tags.

- **Discord Rich Presence enhancements** *(contributed by [@kveld9](https://github.com/kveld9), PR [#198](https://github.com/Psychotoxical/psysonic/pull/198))*: Discord Rich Presence received several improvements: dead/unused fields removed, the `{paused}` placeholder that Discord does not support was dropped, and a `timeChanged` invoke loop that fired redundantly on every progress tick was eliminated. The DRP timer is now accurate and stable.

- **Context menu in Search results** *(contributed by [@kveld9](https://github.com/kveld9), PR [#191](https://github.com/Psychotoxical/psysonic/pull/191))*: Song rows in the Search panel now support the full right-click context menu (Play, Queue, Playlist, etc.) — previously search results were click-only with no context actions.

- **Spotify CSV playlist import** *(contributed by [@kveld9](https://github.com/kveld9), PR [#190](https://github.com/Psychotoxical/psysonic/pull/190))*: Playlists exported from Spotify as CSV can now be imported directly into Psysonic. Tracks are matched by ISRC when available, with title/artist fallback. Unmatched tracks are listed in a report after import. Duplicate checking is done before writing.

- **CLI completions and expanded player controls** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#187](https://github.com/Psychotoxical/psysonic/pull/187))*: The `psysonic` CLI gains shell completions for bash/fish/zsh/elvish, new subcommands for library browsing and audio device listing, a server switcher command, and an opaque play-ID scheme for stable track references. The tray icon on Linux no longer requires `libayatana-appindicator` / `libindicator` — it falls back gracefully when the library is absent.

- **Albums and Playlists header redesign** *(contributed by [@kveld9](https://github.com/kveld9), PR [#186](https://github.com/Psychotoxical/psysonic/pull/186))*: The header sections on the Albums and Playlists pages have been redesigned for a cleaner, more consistent layout.

- **Favorites page redesign** *(contributed by [@kveld9](https://github.com/kveld9), PR [#184](https://github.com/Psychotoxical/psysonic/pull/184))*: The Favorites page has been overhauled with sortable columns, a gender filter, an age range filter, and additional metadata columns.

- **Split Mix navigation mode** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: A new toggle in Settings switches the Mix section between a single **Build a Mix** hub entry and **two separate sidebar entries** — Random Mix and Random Albums — for users who prefer direct access. Navigation items are now defined in `src/config/navItems.ts`; the toggle is stored as `randomNavMode` in authStore.

- **Device Sync improvements** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Device Sync received several updates: a JSON manifest is now written to the device root on every sync (and read back automatically when the device is mounted); a **Cancel** button interrupts a running sync cleanly; a font picker was added to the sync page; sync status display was fixed; and the filename template builder now works correctly on all platforms.

- **Radio — ICY StreamTitle forwarded to MPRIS** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: While playing internet radio, the current song title parsed from ICY `StreamTitle` metadata is now forwarded to MPRIS `xesam:title` on Linux so that the track name appears in desktop notification shells and media controls.

- **Help page — expanded coverage** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Added missing help sections covering Device Sync, Internet Radio, CLI usage, Playlists, Infinite Queue, Lyrics sources, Audio device selection, Backup & Restore, and Now Playing details.

- **Tracklist column reset and privacy policy** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: A reset button in the tracklist column picker restores the default column set. The Device Sync page received a cross-platform filename template fix. A privacy policy page was added documenting data usage for Last.fm, LRCLIB, NetEase, and Discord.

### Fixed

- **Streaming playback stability** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#200](https://github.com/Psychotoxical/psysonic/pull/200))*: Several edge cases in the Rust audio engine around stream start, mid-track seeking, and track transitions were hardened. Cache promotion (moving a preloaded track into the hot cache) is now safer under concurrent access. Stream decoder errors during transitions no longer leave the engine in a stuck state.

- **CSV import reliability** *(contributed by [@kveld9](https://github.com/kveld9), PR [#199](https://github.com/Psychotoxical/psysonic/pull/199))*: The CSV import pipeline now guards the `ISRC` field type before calling `toUpperCase`, preventing a crash on rows with numeric or null ISRC values. The playlist public/private toggle in the edit modal (accidentally removed during a post-merge fix) is restored.

- **Tracklist column picker** *(contributed by [@kveld9](https://github.com/kveld9), PR [#188](https://github.com/Psychotoxical/psysonic/pull/188) and PR [#192](https://github.com/Psychotoxical/psysonic/pull/192))*: Fixed a column picker overflow where the dropdown was clipped by the tracklist container. Also fixed column toggle state and alignment issues in the picker UI. An `overflow-x: visible` regression introduced in PR #188 was subsequently reverted.

- **macOS — spurious microphone permission prompt** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Removed `NSMicrophoneUsageDescription` from `Info.plist`. It was inherited from an earlier Tauri template but Psysonic never uses the microphone; its presence caused macOS to show a permission dialog on first launch.

- **Device Sync — auto-import and disconnect cleanup** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The sync manifest is now automatically imported when the Device Sync page is opened if a device with a manifest is already mounted. The sync file list is cleared when the device is disconnected.

- **Audio — streaming decoder log labels** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#201](https://github.com/Psychotoxical/psysonic/pull/201))*: Rust log lines from the streaming decoder are now tagged with the source type, making it easier to distinguish stream vs. local decode paths in debug output.

- **Theme — Latte and GTA readability** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Improved contrast and text readability in the Catppuccin Latte and GTA themes.

- **i18n — missing `common.play` key** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: Added the `common.play` translation key to all 8 locales; it was missing after PR #186 which introduced its usage.

### Removed

- **Waveform seekbar — realtime waveform style** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The `realtime_waveform` CSS class and its associated style block were removed. This style was applied during live streaming and produced a low-quality rendering mode that was no longer needed after the streaming architecture improvements.

---

*Thank you to everyone who contributed to this release:*
*[@cucadmuh](https://github.com/cucadmuh) for the playback source indicator, ReplayGain in the tech strip, streaming stability hardening, and CLI improvements — four substantial PRs.*
*[@kveld9](https://github.com/kveld9) for the CSV import, search context menu, Discord RP enhancements, Favorites redesign, and header redesign — a very productive cycle.*

---

## [1.34.11] - 2026-04-14

### Added

- **Opus audio playback** *(Issue [#180](https://github.com/Psychotoxical/psysonic/issues/180), contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#183](https://github.com/Psychotoxical/psysonic/pull/183))*: Psysonic can now decode Opus audio natively via `symphonia-adapter-libopus`, which bundles and compiles libopus from source. Previously `.opus` files were sent to the server for transcoding — a workaround that never worked reliably. Native decoding is now used directly; the server is no longer involved. Note: building from source requires `cmake` to be installed (see README).

- **Device Sync — synchronise your library to USB and SD card players** *(Issue [#161](https://github.com/Psychotoxical/psysonic/issues/161), by [@Psychotoxical](https://github.com/Psychotoxical))*: A fully overhauled Device Sync page lets you copy music from your Navidrome library to any mounted USB drive or SD card. Browse albums via live search (300 ms debounce) or a random album selection. Choose a filename template (Artist/Album/Track format), pick a target folder, and review a pre-sync summary showing files to add, files to delete, and available space — including a warning if the device would run out of space after accounting for pending deletions. Already-synced files are detected and skipped automatically so incremental syncs are fast.

- **3 visual toggles** *(contributed by [@kveld9](https://github.com/kveld9), PR [#181](https://github.com/Psychotoxical/psysonic/pull/181))*: Three new toggles in Settings → Appearance:
  - **Cover art background** — enables/disables the blurred album art background in Album Detail and the Hero section.
  - **Playlist cover photo** — shows/hides the cover collage at the top of Playlist Detail pages.
  - **Show bitrate badge** — toggles the bitrate label displayed on tracks in the queue and track lists.

- **8 community themes** *(contributed by [@kveld9](https://github.com/kveld9), PR [#182](https://github.com/Psychotoxical/psysonic/pull/182))*: A new **Community** theme group appears directly below Psysonic Themes in the Theme Picker, containing eight new themes: **AMOLED Black Pure** (pure black for OLED), **Monochrome Dark** (grayscale), **Amber Night** (warm golden amber), **Phosphor Green** (classic terminal green), **Midnight Blue** (deep blue), **Rose Dark** (pink/rose accents), **Sepia Dark** (warm cream sepia), and **Ice Blue** (cool cyan). Psysonic now ships with 75 themes across 9 groups.

### Fixed

- **HTTPS streaming failures and server URL trailing slash** *(Issue [#178](https://github.com/Psychotoxical/psysonic/issues/178), by [@Psychotoxical](https://github.com/Psychotoxical) with fix ported from PR [#179](https://github.com/Psychotoxical/psysonic/pull/179) by [@kveld9](https://github.com/kveld9))*: Two bugs that broke HTTPS server connections are now fixed. A trailing slash in the configured server URL caused double-slash stream URLs (`//rest/stream.view`) that reverse proxies like Caddy would reject, and also caused album browsing to return 0 results. Additionally, `reqwest` now loads the OS native certificate store alongside Mozilla's root store — fixing HTTPS streaming failures when the server certificate is signed by a local CA (e.g. Caddy's internal CA) that is trusted in the system keychain but not in Mozilla's bundle.

- **Server display in Settings** *(by [@Psychotoxical](https://github.com/Psychotoxical))*: The server list in Settings → Servers now shows the URL and username on separate lines instead of a single truncated `username@url` string. Protocol prefixes (`http://`, `https://`) are stripped for cleaner display. HTTPS connections show a green lock icon.

### Changed

- **Waveform seekbar — live theme updates** *(contributed by [@kveld9](https://github.com/kveld9), PR [#182](https://github.com/Psychotoxical/psysonic/pull/182))*: The canvas-based seekbar now listens for `data-theme` attribute changes via `MutationObserver` and redraws immediately with the new theme colours. Switching themes no longer requires an app restart to update the waveform.

---

*Thank you to everyone who contributed to this release:*
*[@cucadmuh](https://github.com/cucadmuh) for implementing native Opus decoding — a long-requested feature that finally makes `.opus` libraries fully playable.*
*[@kveld9](https://github.com/kveld9) for three PRs in one release: the SSL/trailing-slash fix, visual customisation toggles, and eight new community themes with a live waveform update fix.*

---

## [1.34.10] - 2026-04-13

### Added

- **AppImage bundle for Linux** + X11/XWayland enforcement on all Linux packages: CI now builds `.AppImage` in addition to `.deb` and `.rpm`. `GDK_BACKEND=x11` and `WEBKIT_DISABLE_COMPOSITING_MODE=1` are set automatically at startup on all Linux packages — WebKitGTK on Wayland is unstable. Both environment variables are still overridable by setting them before launch.

- **Audio output device selection** *(Issue [#169](https://github.com/Psychotoxical/psysonic/issues/169))*: Settings → Audio now shows a dropdown of all available output devices. The current OS default is pinned at the top with a label; a Refresh button re-enumerates silently. A device watcher detects hot-plug events and emits `audio:device-reset` after ~9 s of consecutive misses, preventing false positives on busy ALSA devices. On Linux, technical ALSA prefixes are stripped for display (`sysdefault:CARD=U192k` → `U192k`).

- **Vision Dark & Vision Navy — colorblind-safe themes** *(Issue [#166](https://github.com/Psychotoxical/psysonic/issues/166))*: Two new themes using a Purple & Gold palette designed to be safe for Deuteranopia, Protanopia, and Tritanopia. Vision Dark pairs near-black `#0D0B12` with Gold `#FFD700` (~14.7:1 WCAG AAA); Vision Navy uses deep navy `#0A1628` + Gold (~14.5:1 WCAG AAA). Both appear under a new **Accessibility** group in the Theme Picker. These themes are a first step toward proper colorblind support and will be revised and expanded in upcoming releases — structural improvements such as secondary indicators and pattern/shape cues are still on the roadmap.

- **Folder Browser — per-column filter & Shift+Enter queue append** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#165](https://github.com/Psychotoxical/psysonic/pull/165))*: Press Ctrl+F to open a filter field for the active Folder Browser column. Focus hands off cleanly between the filter input and the row list. Clearing a parent-column selection clears all right-side filters automatically. Press Shift+Enter on a filtered track list to **append** the visible tracks to the queue without replacing it.

- **Keybindings — in-app modifier chords** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#167](https://github.com/Psychotoxical/psysonic/pull/167))*: In-app keybindings now support Ctrl/Alt/Shift+Key chords in addition to bare keys. The settings capture flow uses `buildInAppBinding`; the runtime handler uses `matchInAppBinding` and skips any chord already claimed as a global shortcut. Bare-key bindings still match without modifiers. Additionally, the seek forward/backward shortcuts now correctly interpret the configured value as seconds — previously the value was treated as a 0–1 progress fraction.

- **Playlist management enhancements** *(contributed by [@kveld9](https://github.com/kveld9), PR [#168](https://github.com/Psychotoxical/psysonic/pull/168))*: Multi-select context-menu actions for Albums, Artists, and Playlists now include a bulk **Add to Playlist** submenu. The sidebar playlist section is now collapsible. The Artists page gains infinite scroll via `IntersectionObserver`. Submenus flip upward automatically when they would overflow the viewport bottom. A **Remove from Playlist** entry is now available in the Playlist Detail context menu.

### Fixed

- **Fullscreen Player — animation overhead in no-compositing mode** *(contributed by [@kilyabin](https://github.com/kilyabin), PR [#175](https://github.com/Psychotoxical/psysonic/pull/175))*: In software-rendering mode (`WEBKIT_DISABLE_COMPOSITING_MODE=1`) the mesh blob pan animations are now stopped (static gradients are preserved), the portrait drift animation is stopped, and `box-shadow` is removed from the seekbar played bar. The seekbar played bar width changes on every playback tick; triggering a full shadow repaint in software mode caused significant CPU overhead.

- **Folder Browser — arrow keys with modifier keys** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#174](https://github.com/Psychotoxical/psysonic/pull/174))*: Column and list arrow-key handling is now skipped when any modifier key is held, preventing conflicts with browser focus navigation and OS-level shortcuts. Modifier detection uses both `nativeEvent` and `getModifierState` for WebKit/WebView2 compatibility.

- **Audio output device — Linux stability** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#176](https://github.com/Psychotoxical/psysonic/pull/176))*: Pinned ALSA/cpal device IDs now stay stable when enumeration temporarily omits the active sink or returns an equivalent name. The Linux device-watcher no longer clears the pin based solely on missing list entries — only macOS and Windows treat repeated absence as "device unplugged". The Settings refresh flow calls `canonicalize` and refetches the list; an i18n label is now shown when the active device is no longer in the enumerated list.

- **Login — server URL field** *(Issue [#171](https://github.com/Psychotoxical/psysonic/issues/171))*: The placeholder text in the Add Server form was previously a hardcoded English string. It is now fully localised and clarifies that `https://` URLs are accepted.

- **Offline mode — non-blocking banner** *(Issue [#170](https://github.com/Psychotoxical/psysonic/issues/170))*: The full-screen blocking overlay shown when Psysonic starts without a cached library is replaced with a slim banner at the top of the content area. The banner includes a direct link to Server Settings so the user can fix the connection without navigating manually.

---

*Special thanks to everyone who contributed to this release:*
*[@cucadmuh](https://github.com/cucadmuh) for the significant Folder Browser improvements,  the modifier-chord keybindings and and the Linux audio stability fixes — four PRs in one release cycle, remarkable.*
*[@kilyabin](https://github.com/kilyabin) for continuing to hunt down no-compositing performance issues.*
*[@kveld9](https://github.com/kveld9) for the playlist management overhaul.*

---

## [1.34.9] - 2026-04-12

### Added

- **Multi-select in Playlist Detail & Favorites** *(Issue [#157](https://github.com/Psychotoxical/psysonic/issues/157))*: The same Ctrl/Cmd+Click multi-select system that was previously exclusive to album track lists is now available everywhere. Hold Ctrl (or ⌘ on macOS) to enter select mode, Shift+Click to range-select, click the header checkbox to toggle all. Selected tracks can be dragged as a group directly into the queue. A bulk action bar appears with **Add to Playlist** and **Clear selection** options. Works in Playlist Detail (main tracklist) and in the Favorites song list.

- **"Open Artist" in context menu**: Song context menus now show an **Open Artist** entry directly below **Open Album**, navigating to the artist detail page. Previously only accessible via the tracklist artist link.

- **"Add to Playlist" for Artists**: The context menu for artists now includes an **Add to Playlist** submenu. Psysonic fetches all albums from the artist and collects every track, then forwards them to the playlist picker — identical to the existing album-level submenu.

- **Infinite queue — Instant Mix strategy** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#163](https://github.com/Psychotoxical/psysonic/pull/163))*: When Infinite Queue is enabled, Psysonic now builds the upcoming track list using the same artist-driven logic as Instant Mix. It fetches **Top Songs** and **Similar Songs** for the current track's artist, shuffles and deduplicates the pool, and only falls back to fully random songs when no artist-driven candidates are available. This results in much more coherent listening sessions that stay close to your current musical context.

- **Fullscreen Player — appearance settings** *(contributed by [@kilyabin](https://github.com/kilyabin), PR [#156](https://github.com/Psychotoxical/psysonic/pull/156))*: Settings → Appearance → Fullscreen Player now offers a toggle to show/hide the artist portrait and a 0–80 % dimming slider for the background portrait.

- **Build a Mix hub** *(contributed by [@kilyabin](https://github.com/kilyabin), PR [#155](https://github.com/Psychotoxical/psysonic/pull/155))*: The previous *Random Mix* and *Random Albums* sidebar entries have been merged into a single **Build a Mix** page (Wand icon) at `/random`. A landing card lets you choose between *Mix by Tracks* and *Mix by Albums*. Old routes remain fully functional.

- **Spanish translation** *(contributed by [@Kveld9](https://github.com/Kveld9), PR [#159](https://github.com/Psychotoxical/psysonic/pull/159))*: Complete Spanish (es) locale with 964 translated strings. Psysonic now ships in 8 languages: English, German, French, Dutch, Chinese, Norwegian, Russian, and Spanish.

- **Column-header sorting for Albums & Playlists** *(contributed by [@Kveld9](https://github.com/Kveld9), PR [#160](https://github.com/Psychotoxical/psysonic/pull/160))*: Track lists in Album Detail and Playlist Detail now support click-to-sort directly on the column headers. Three-click cycle: ascending → descending → natural order. Sortable columns: Title, Artist, Album, Favourite, Rating, Duration. The active column is shown bold with a ▲/▼ indicator.

- **Folder Browser — keyboard navigation & context menus** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#158](https://github.com/Psychotoxical/psysonic/pull/158))*: Full keyboard navigation in the Folder Browser with arrow keys, Enter to open, and Ctrl+Enter to open the context menu. Context menus for all row types include keyboard-operable submenus and star-rating control via arrow keys. The now-playing path is visually emphasized and updates live. Adaptive column layout prioritizes right-side visibility for deep directory trees. A new configurable *Open Folder Browser* keybinding is available in Settings → Keyboard.

- **PLS/M3U playlist resolution for Internet Radio**: Stations configured with a `.pls` or `.m3u`/`.m3u8` URL (e.g. SomaFM, schizoid.in) are now resolved to their first direct stream URL before playback. ICY metadata fetching also auto-resolves playlist URLs. Previously these stations would fail to play or show no track info.

- **Lyrics sources — configurable order & per-source toggle**: The old *Server First* toggle has been replaced with a full drag-to-reorder list in Settings → General. Three sources — **Server** (embedded/OpenSubsonic), **LRCLIB**, and **Netease Cloud Music** — can each be individually enabled or disabled, and their priority order is fully customisable. Embedded SYLT tags from local files always win unconditionally.

- **ReplayGain Pre-Gain & Fallback** *(audio)*: Two new sliders in Settings → Audio → ReplayGain:
  - **Pre-Gain** (0–+6 dB): added on top of every ReplayGain-tagged track for users who prefer a louder default.
  - **Fallback Gain** (−6–0 dB): applied to untagged tracks and internet radio streams, preventing volume jumps when switching between tagged and untagged content.

- **Context-aware Remix button in Build a Mix**: When a genre filter is active, the Remix button now re-fetches the same genre instead of resetting to the full library pool. An *All Songs* chip is available as the first genre option to return to the global mix without leaving the page.

- **AlbumTrackList multi-select & psyDnD** *(tracklist polish)*: Album track lists now support full multi-select with Ctrl/Cmd+Click, Shift+Click range selection, and drag-to-queue for multiple tracks simultaneously. The `TrackRow` component is `React.memo` with fine-grained Zustand selectors, so only the toggled row re-renders on selection change (O(1)).

- **Mute/unmute restores previous volume**: The mute button in the player bar now restores the volume to its level before muting instead of always jumping to 70 %.

### Fixed

- **Statistics — accurate counts for large libraries**: The statistics page was previously capped at 10 pages (≈ 5,000 albums), causing incorrect totals on larger libraries. The pagination loop now runs until the server returns a partial page, regardless of library size. Sort type changed to `alphabeticalByName` for stable pagination.

- **Statistics — Artists count tooltip**: The Artists card now shows a tooltip (dotted underline, cursor: help) explaining that the count reflects album artists only — a Subsonic API limitation. Featured or guest artists who do not have their own album are not counted. The tooltip is localised in all 8 languages.

- **Artists page — alphabet navigation hover effect**: The A–Z filter buttons had inline styles that prevented `:hover` CSS from applying. Buttons are now styled via `.artists-alpha-btn` CSS class with an accent-coloured hover highlight and a subtle glow ring.

- **Hot Cache — eviction & prefetch budget**: Eviction now correctly keeps only the current and next track; prefetch fetches up to five tracks when under the size cap but always fetches the immediate next; the previous current track is given a grace period until the debounce fires; eviction runs immediately on MB limit or folder changes; the cap is re-read after each download completes. Live disk usage is now shown on the Audio settings page.

- **Hot Cache + Preload — mutual exclusion on rehydration**: Users who had both Hot Cache and Preload enabled before the mutual-exclusion rule was introduced will have both automatically reset to off on first launch, preventing a conflicting state.

- **Fullscreen Player — Linux compositing performance** *(contributed by [@kilyabin](https://github.com/kilyabin), PR [#156](https://github.com/Psychotoxical/psysonic/pull/156))*: A new `no_compositing_mode` Tauri command detects Linux software-rendering mode and adds an `html.no-compositing` class, which swaps GPU-only CSS effects (`backdrop-filter`, `filter`, `mask-image`) for software-friendly equivalents throughout the fullscreen player.

- **Fullscreen Player — long lyric lines wrapping**: Long words in lyric lines now wrap correctly instead of overflowing the container.

- **Russian locale** *(contributed by [@kilyabin](https://github.com/kilyabin), PR [#148](https://github.com/Psychotoxical/psysonic/pull/148))*: Numerous translation improvements across the application, replacing machine-translated or awkward phrasings with natural Russian.

- **npm audit vulnerabilities**: Updated `axios` and `vite` to address reported security advisories.

### Changed

- **"Remove from Queue" context menu item** now has a **Trash** icon, matching the destructive action style of other delete operations.
- **Playlist Detail — filter-mode drag**: Rows in a filtered/sorted playlist view can now be dragged to the queue as single songs (previously dragging was disabled entirely in filter mode).
- **Infinite queue deduplication**: Tracks already present in the queue are excluded from the candidate pool, preventing the same song from appearing twice in a row during Infinite Queue sessions.

### Contributors

Thank you to everyone who contributed to **v1.34.9**:

- [@cucadmuh](https://github.com/cucadmuh) — Infinite queue via Instant Mix strategy (PR [#163](https://github.com/Psychotoxical/psysonic/pull/163)), Folder Browser keyboard navigation & context menus (PR [#158](https://github.com/Psychotoxical/psysonic/pull/158))
- [@kilyabin](https://github.com/kilyabin) — Fullscreen Player performance & appearance settings (PR [#156](https://github.com/Psychotoxical/psysonic/pull/156)), Build a Mix hub (PR [#155](https://github.com/Psychotoxical/psysonic/pull/155)), Russian locale improvements (PR [#148](https://github.com/Psychotoxical/psysonic/pull/148))
- [@Kveld9](https://github.com/Kveld9) — Spanish translation (PR [#159](https://github.com/Psychotoxical/psysonic/pull/159)), Column-header sorting (PR [#160](https://github.com/Psychotoxical/psysonic/pull/160))

A huge thank you to all three of you — your contributions have made this one of the most feature-packed patch releases yet. Psysonic keeps getting better because of people like you. 🙌

---

## [1.34.8] - 2026-04-10

### Added

- **Netease Cloud Music Lyrics** *(opt-in)*: Netease Cloud Music can now be enabled in Settings → General as a last-resort lyrics fallback. It only fires when neither the server nor LRCLIB return results — the existing lyrics chain is completely unaffected. Particularly useful for Asian and international music. Chinese metadata lines (作词/作曲/编曲 etc.) are automatically stripped from the LRC output.

- **Navidrome AudioMuse-AI Integration** *(contributed by [@cucadmuh](https://github.com/cucadmuh), PR [#147](https://github.com/Psychotoxical/psysonic/pull/147))*: Psysonic now  supports [AudioMuse-AI](https://github.com/cucadmuh/audiomuse-ai) if it is active on the Navidrome server and uses it for Random Mix, Similar Artists, and Instant Mix. No configuration required — Psysonic keeps its existing behavior when AudioMuse is unavailable. Also includes an Instant Mix probe, ping identity, and improved UX for AudioMuse-specific actions.

- **ICY metadata & AzuraCast radio** *(contributed by [@nisrael](https://github.com/nisrael), PR [#146](https://github.com/Psychotoxical/psysonic/pull/146))*: Internet radio now displays live track metadata from ICY streams. AzuraCast stations are supported with extended now-playing information.

- **Automatic audio device switching**: Psysonic now detects newly connected or changed audio output devices and switches to them automatically — no app restart required.

### Fixed

- **Multi-artist tracks**: Tracks with multiple artists (OpenSubsonic `artists[]` field, e.g. semicolon-separated entries) now display each artist individually. Artists with their own profile page are clickable links; artists without one appear as plain text. Separated by `·`.

- **Gapless + Preload Gate**: The gapless chain and the preload gate now run on separate paths. Previously both could fire simultaneously, causing a brief black flash on track change.

- **Replay Gain — missing album gain**: When no album gain tag is present, Psysonic now correctly falls back to track gain instead of skipping gain correction entirely.

- **Statistics — music library scope**: Genre insights now respect the currently selected music library. Fetch results are cached to avoid redundant server requests. Playback durations are displayed in localized units.

- **Russian locale**: "Most Played" in the sidebar, home page, and page title now uses «Популярное».

### Changed

- **"Reset to defaults" buttons** in Settings → Input are now styled as warning buttons (red border).
- **Lyrics button** removed from the player bar (redundant with the queue panel tab).
- **Icons**: Advanced search now uses the `TextSearch` icon; artist bio button now uses `Highlighter`.
- **Album chip** in the album detail header is now opaque across all themes.
- **Hot Cache and Hi-Res Audio**: Alpha badges removed — both features are production-ready.
- **CPU optimisations**: Next-track buffering and preload settings have been consolidated into a unified control.

### Theme Fixes

- **Middle Earth**: Removed vertical stripe pattern from sidebar; improved queue artist contrast on hover; fixed album detail artist colour, bio text, and "Read more" link readability; "Next Tracks" divider label is now lighter.
- **Toy Tale**: Fixed sidebar section labels (System/Library), queue tab buttons (Lyrics/Queue), inactive artist text, and "Next Tracks" divider label — all were too dark to read.
- **Tetrastack**: Raised all purple and blue palette values (`#a020f0` → `#c070ff`, `#0060f0` → `#4090ff`); raised `--text-muted` from `#3a3a6a` to `#7878b8` — affected settings descriptions, artist names in tracklists, and queue labels.
- **Horde & Alliance**: Removed repeating horizontal line pattern from sidebar.

### Contributors

Thank you to everyone who contributed to this release:

- [@cucadmuh](https://github.com/cucadmuh) — AudioMuse-AI Navidrome integration (PR [#147](https://github.com/Psychotoxical/psysonic/pull/147))
- [@sorensiimSalling](https://github.com/sorensiimSalling) — ICY metadata & AzuraCast radio support (PR [#146](https://github.com/Psychotoxical/psysonic/pull/146))

You make Psysonic better. 🙌

---

## [1.34.7] - 2026-04-09

### Added

- **Windows — Taskbar Thumbnail Toolbar**: Prev / Play-Pause / Next media buttons now appear in the Windows taskbar thumbnail preview (the popup that appears when hovering over the taskbar icon). Buttons emit the same `media:*` events as the tray menu and souvlaki. The Play/Pause icon swaps in real-time as playback state changes.

- **Windows — High-quality taskbar icons**: The taskbar thumbnail toolbar icons are now loaded from embedded `.ico` assets (`play.ico`, `pause.ico`, `prev.ico`, `next.ico`) via `CreateIconFromResourceEx`, replacing the previous monochrome GDI drawing code. All four icons are properly cleaned up on window destruction.

- **Professional update modal**: The in-app updater now shows a polished modal with the full release changelog, a **Skip this version** option, and an OS-aware direct download button (`.dmg` on macOS, `.exe` on Windows, `.deb`/`.rpm` on Linux) as a fallback if the auto-update fails. The modal is fully localised in all 7 supported languages.

- **Self-hosted fonts — no internet required**: All 10 UI fonts are now shipped as WOFF2 files bundled into the app via `@fontsource-variable` npm packages. The previous Google Fonts CDN dependency has been removed entirely — Psysonic now renders correctly with no internet connection and without any external requests on startup.

- **Help — 11 new FAQ entries**: The Help page covers previously undocumented features across Ratings (how to rate songs/albums/artists, removing a rating, Skip-to-1★, rating filter for mixes), Folder Browser, Theme Scheduler, UI Scale, Seekbar styles, AutoEQ, Replay Gain, Hot Cache, and offline playlist caching. All 7 locales updated.

### Fixed

- **Embedded lyrics (MP3 & FLAC)**: A new `get_embedded_lyrics` Tauri command reads lyrics tags directly from local files — `SYLT`/`USLT` frames for MP3 (via the `id3` crate) and `SYNCEDLYRICS`/`LYRICS` tags for FLAC (via `lofty`). Additionally: the LRC parser now correctly handles timestamps without fractional seconds (e.g. `[01:23]`), and the Subsonic structured-lyrics parser now accepts both `synced` and `issynced` field names for compatibility with different server versions.

- **Linux — player bar disappearing at high zoom / small window sizes**: All `grid-template-rows` definitions now use `minmax(0, 1fr)` instead of bare `1fr`, and the `min-height: 720px` constraint on the app shell has been removed. The player bar no longer gets pushed off-screen when the window is small or the UI scale is above 100 %.

- **Windows — "Open folder" in Settings crashing**: The Settings page uses a Rust `open_folder` command instead of the Tauri `shell:open` API, which was blocked by the capability scope on Windows for local paths.

- **macOS — Artist Radio crashing WKWebView after ~10 minutes**: Storing `currentTime` in the persisted Zustand state caused up to ~1,200 synchronous `localStorage.setItem` calls per radio session, eventually crashing the WKWebView SQLite backend. `currentTime` has been removed from the persist partializer. Old played radio tracks are also now trimmed from the queue (keeping the last 5) to cap the localStorage payload during queue top-up.

- **Artist Radio — predictable track order**: The initial Artist Radio queue is now shuffled via Fisher-Yates, so positions 2+ draw from similar-artist tracks in a random order rather than always playing the server's top-5 tracks in sequence.

- **Internet Radio — stall / buffering recovery**: Stall events on the HTML5 `<audio>` element now trigger automatic reconnection (up to 5 retries), recovering from transient network interruptions without requiring a manual restart.

- **Corrupt MP3s — VLC-style frame tolerance**: The audio decoder now tolerates up to 100 consecutive bad frames before giving up (previously 3), matching VLC's behavior for files with invalid `main_data` offset frames. Frame-drop log messages are suppressed in release builds.

- **Statistics — album/song totals respect selected music library**: Album and track counts on the Statistics page were previously derived from `getGenres()`, which is not scoped to the active music folder. Both counts are now derived from the same paginated `getAlbumList` pass used for playtime, with the same 5,000-album cap and a `≥` prefix when capped. *(PR [#138](https://github.com/Psychotoxical/psysonic/pull/138) by [@cucadmuh](https://github.com/cucadmuh))*

- **Fullscreen — resize grips visible in native fullscreen**: Resize grips are now hidden whenever the window enters native fullscreen on all platforms (previously only tracked on Linux). An initial check on mount also catches windows that start in a maximized or fullscreen state.

- **Albums page — year filter input height**: The "From year" / "To year" inputs in the Albums filter bar now match the height and font size of adjacent buttons, fixing the mixed-height row introduced in v1.34.4.

- **Russian locale — missing lyrics-source strings**: The `lyricsServerFirst` and related settings strings were not translated in the Russian locale. *(PR [#140](https://github.com/Psychotoxical/psysonic/pull/140) by [@kilyabin](https://github.com/kilyabin))*

### Contributors

Thank you to everyone who contributed to this release:

- [@cucadmuh](https://github.com/cucadmuh) — Statistics music-folder scope fix (PR [#138](https://github.com/Psychotoxical/psysonic/pull/138))
- [@kilyabin](https://github.com/kilyabin) — Russian locale lyrics strings (PR [#140](https://github.com/Psychotoxical/psysonic/pull/140))

---

## [1.34.6] - 2026-04-08

> I'm sorry this is already the third release today — every time we shipped a critical fix, another critical issue surfaced. Hopefully this one holds. 🤞

### 🚨 Critical Fix

- **ZIP downloads no longer freeze the UI**: All ZIP downloads (Album Detail, Playlist Detail, Albums, New Releases, Random Albums) previously buffered the entire file in the JS heap via `fetch + blob + arrayBuffer`, which caused the app to become completely unresponsive for large downloads (e.g. a 600-song, 7 GB playlist). Downloads now stream directly to disk via the Rust backend (`invoke('download_zip')`), matching the existing single-album download behavior. Progress is shown in the download overlay (bottom right).

- **Offline cache downloads no longer freeze the UI**: Caching a large playlist (600+ songs) triggered up to ~1,200 synchronous `localStorage.setItem` calls as Zustand's `persist` middleware wrote on every state update. Transient download job state has been moved to a new non-persisted store (`offlineJobStore`), reducing localStorage writes for an entire download to **2** regardless of playlist size.

### Added

- **Playlist offline toggle**: When a playlist is already cached offline, clicking the cache button now removes it from the offline cache (shown with a red trash icon) instead of re-downloading it.

### Fixed

- **Home page — "Recently Added" section title** now links to `/new-releases` instead of `/albums`.

---

## [1.34.5] - 2026-04-08

### 🚨 Critical Fix

- **Massive API request flood fixed** *(closes [#133](https://github.com/Psychotoxical/psysonic/issues/133))*: Psysonic was generating 15,000+ background requests per day, filling reverse-proxy access logs (Traefik, nginx) and in some cases crashing the proxy entirely. Four root causes identified and resolved:
  - **Now Playing polling**: Was firing every 10 seconds unconditionally — even when minimized or the dropdown was closed. Now only polls while the dropdown is open, and respects the Page Visibility API to pause immediately when the window is hidden.
  - **Connection check interval**: Reduced from every 30 seconds to every **120 seconds** (4× reduction).
  - **Queue sync debounce**: Increased from 1.5 s to **5 s**, preventing request bursts when skipping rapidly through tracks.
  - **Rating prefetch cache**: Artist and album ratings are now cached in memory for **7 minutes**. Repeated page loads (Random Albums, Random Mix) no longer re-fetch ratings that were just retrieved.

### Added

- **Theme Scheduler** *(Settings → Appearance)*: Automatically switches the active theme at configurable times of day. Two time slots (e.g. a light theme during the day, a dark one at night). English locale displays hours in 12-hour AM/PM format; all other languages use 24-hour format.

- **Theme Scheduler hint**: When the scheduler is active, a notice appears at the top of the Theme Picker explaining why manually selecting a theme has no immediate effect.

- **UI Scale** *(Settings → Appearance)*: Adjust the global interface scale (80 % – 125 %) without changing the system font size.

- **Folder Browser**: New sidebar section with Miller-columns directory navigation. Browse the server's music folder tree and play or queue folders directly.

- **Seekbar — Waveform fade edges**: The Waveform seekbar style now fades out at both ends, giving it a cleaner, less abrupt look.

- **Cover art fallback logo**: When a cover art image fails to load (broken URL, server error), the Psysonic logo is shown as a placeholder instead of a broken image icon.

- **Tiling WM support** *(PR [#134](https://github.com/Psychotoxical/psysonic/pull/134))*: On tiling window managers (Hyprland, Sway, i3, bspwm, AwesomeWM, etc.) the custom title bar is automatically hidden — the WM manages window decorations. The title bar toggle in Settings is also hidden on tiling WMs. Detection is based on environment variables (`HYPRLAND_INSTANCE_SIGNATURE`, `SWAYSOCK`, `I3SOCK`, `XDG_CURRENT_DESKTOP`).

### Changed

- **Custom title bar disabled by default**: New installations start with the native OS title bar. Existing users keep their saved preference.

### Fixed

- **Custom title bar (Linux) — drag & resize**: Window dragging via the title bar now works correctly (missing Tauri `core:window:allow-start-dragging` capability was silently blocking it). CSS resize grips are now shown at the bottom corners to compensate for the removed native GTK grips. The title bar no longer misplaces itself when the window is resized to a small width (mobile-grid layout now includes the title bar row).

- **Fullscreen Player — accent color delay**: The dynamic accent color extracted from album artwork now appears in ~200–300 ms instead of up to 18 seconds. The previous implementation queued the cover fetch behind up to 5 concurrent image loads via the app-wide image cache. It now fetches the cover directly and independently. The extracted color is also cached per cover ID, so switching between tracks on the same album is instant.

- **Artist Detail page — slow initial render** *(closes [#132](https://github.com/Psychotoxical/psysonic/issues/132))*: Artist info and biography are now fetched independently of the main artist data, so the page renders immediately and the bio fades in once available. Previously, a slow `getArtistInfo` response blocked the entire page from rendering.

- **Seekbar — Pulse Wave & Retro Tape styles**: Pulse Wave no longer leaves a stray connecting line at the playhead position. Retro Tape's rolling wheel is now anchored at the playhead instead of the center of the bar.

- **Statistics — Top Rated Songs/Artists sections removed**: These sections were incorrectly added in v1.34.4 and have been removed. All other rating features from that release remain fully intact.

---

## [1.34.4] - 2026-04-08

### Added

- **Entity ratings** *(PR [#130](https://github.com/Psychotoxical/psysonic/pull/130))*: Full star-rating support (1–5 ★) for songs, albums, and artists via the OpenSubsonic `setRating` API. Ratings are shown and editable in the album track list, artist detail page, and the Favorites song list. A new shared `StarRating` component is used consistently across all surfaces. Requires an OpenSubsonic-compatible server (e.g. Navidrome ≥ 0.53).

- **Song ratings — context menu & player bar**: Songs can additionally be rated directly from the **right-click context menu** and from the **player bar** (below the artist name), with optimistic updates reflected immediately across all views.

- **Skip-to-1★** *(PR [#130](https://github.com/Psychotoxical/psysonic/pull/130))*: Automatically assigns a 1-star rating to a song after it has been manually skipped a configurable number of consecutive times. This skip count threshold can be enabled and adjusted in Settings → Ratings.

- **Mix minimum rating filter** *(PR [#130](https://github.com/Psychotoxical/psysonic/pull/130))*: Random Mix and Home Quick Mix can now be filtered by minimum rating per entity type (song / album / artist). Configure thresholds in Settings → Ratings.

- **Statistics — Top Rated Songs & Artists**: New "Top Rated Songs" and "Top Rated Artists" sections on the Statistics page, derived from starred items with a `userRating > 0`. Lists update live as ratings are changed without a page reload.

- **Seekbar styles — 5 new styles**: Added Neon Glow, Pulse Wave, Particle Trail, Liquid Fill, and Retro Tape. Animated styles run a dedicated `requestAnimationFrame` loop. The style picker in Settings shows an animated live preview for each style.

- **Custom title bar (Linux)**: Optional custom title bar with now-playing display (song title + artist, live-updating). Replaces the native GTK decoration when enabled. Automatically hides in native fullscreen (F11). Can be toggled in Settings → Appearance.

- **Album multi-select**: Albums, New Releases, and Random Albums pages now support multi-select mode. Selected albums can be batch-queued or enqueued.

- **Most Played — compilation filter**: New toggle on the Most Played page to hide compilation artists from the Top Artists list.

- **Scroll reset on navigation**: The content area now scrolls back to the top automatically on every route change.

### Fixed

- **Backup**: The `psysonic_home` key is now included in the settings backup export.

### i18n

- New keys for seekbar styles, entity ratings, rating sections (Settings + Statistics), and entity rating support added to all 7 languages (EN, DE, FR, NL, ZH, NB, RU).

---

## [1.34.3] - 2026-04-07

### Added

- **Most Played page** *(closes [#86](https://github.com/Psychotoxical/psysonic/issues/86))*: New dedicated page accessible via the sidebar (TrendingUp icon, `/most-played`). Shows **Top Artists** (ranked by total play count, derived by aggregating album play counts per artist) and a paginated **Top Albums** list with cover art, play count, sort toggle (most/fewest first), and a Load More button.

- **Playlist ZIP download** *(closes [#127](https://github.com/Psychotoxical/psysonic/issues/127))*: Download (ZIP) button in the playlist hero header — same UX as album download. Uses the Subsonic `/rest/download.view` endpoint with the playlist ID, shows a progress bar during transfer, and remembers the last used folder.

- **Fullscreen Player — adaptive accent color**: Extracts the most vibrant pixel from the current album cover (8×8 Canvas downscale, max-HSL-saturation) and applies a WCAG 4.5:1-compliant accent as `--dynamic-fs-accent`. Song title, play button, seekbar, active states, background mesh blobs, and cover art glow all transition smoothly to the extracted color. Resets to the theme accent when the player closes.

- **Dracula theme**: Added to the Open Source Classics group.

- **Discord Rich Presence — Apple Music cover opt-in**: iTunes artwork lookup is now disabled by default. A new toggle in Settings → Integrations ("Fetch covers from Apple Music for Discord") must be explicitly enabled — it sends artist and album name to Apple's search API to find cover art for the Discord profile.

- **Discord Rich Presence — Paused state**: When playback is paused, the Discord presence now shows "Paused" as the status text.

### Fixed

- **M4A playback — older iTunes-purchased files**: Files with an embedded MJPEG cover-art stream and an `iTunSMPB` gapless tag now play correctly. The Symphonia isomp4 patch skips malformed trak atoms gracefully; `parse_gapless_info` now searches for the `" 00000000 "` sentinel to skip the 16-byte binary `data`-atom header, correctly extracting encoder delay and total sample count.

### i18n

- New keys for the Most Played page, playlist download, and Discord Apple Music opt-in added to all 7 languages (EN, DE, FR, NL, ZH, NB, RU).

---

## [1.34.2] - 2026-04-07

### Added

- **M4A / ALAC / AAC-LC support** *(closes [#51](https://github.com/Psychotoxical/psysonic/issues/51))*: Apple Lossless (ALAC) and AAC-LC files in M4A containers are now decoded natively by the Rust audio engine (Symphonia) without requiring server-side transcoding.

- **Per-server music folder filter** *(PR [#125](https://github.com/Psychotoxical/psysonic/pull/125) by [@cucadmuh](https://github.com/cucadmuh))*: Users with multiple music libraries on their Navidrome server can now scope browsing to a single folder. A dropdown in the sidebar (visible only when more than one library exists) lets you pick a folder or switch back to "All Libraries". The selection is persisted per server and automatically resets to "All" if the selected folder is no longer available.

- **Hi-Res / Bit-Perfect Playback** *(Alpha)*: New opt-in toggle in Settings → Playback. When enabled, the audio output stream is re-opened at the file's native sample rate (e.g. 88.2 kHz, 96 kHz) — bypassing rodio's internal resampler for a bit-perfect signal path. Disabled by default (safe 44.1 kHz mode). Includes ALSA/PipeWire underrun hardening: scaled quantum size, 500 ms sink pre-fill at high rates, and scheduler priority escalation only when needed.

- **Hot Playback Cache** *(Alpha, PR [#123](https://github.com/Psychotoxical/psysonic/pull/123) by [@cucadmuh](https://github.com/cucadmuh))*: Configurable on-disk prefetch cache for the next track in the queue. Reduces playback latency on slow or metered connections. Toggle and directory can be configured in Settings → Storage.

### Changed

- **Fullscreen Player — info block reworked**: The track title is now the dominant element (large, bold, accent color) and sits above the artist name (small, muted). Matches community feedback on visual hierarchy.

- **Fullscreen lyrics — line wrapping**: Long lyric lines now wrap onto a second line instead of being truncated. Slot height increased from 3.6 vh to 6 vh to accommodate two-line entries without breaking rail positioning.

- **Update notifications**: Removed the Tauri auto-updater (in-app download and install). The app now shows a simple dismissible toast when a newer version is detected on GitHub, with direct links to the [GitHub Releases page](https://github.com/Psychotoxical/psysonic/releases/latest) and the [Psysonic website](https://psysonic.psychotoxic.eu/#downloads). No signing keys, no update manifests.

### Fixed

- **Standard mode CPU usage**: Playing a 44.1 kHz MP3 with Hi-Res disabled no longer triggers an unnecessary audio device re-open on every track start. MSS read-ahead buffer reduced from 4 MB to 512 KB for standard-rate files. Background prefetch is now throttled by 8 s to avoid competing with playback startup. Combined, these changes reduce idle CPU from ~6–10 % to ~2–3 % on a modern machine.

- **Hi-Res toggle — stream rate not restored**: Toggling Hi-Res off while a track was playing at 88.2 or 96 kHz left the output stream at the high rate for subsequent tracks. The device's default rate is now restored on the next play.

- **Fullscreen lyrics — CPU spikes on line transitions**: Animating `font-weight` in CSS triggered a full layout reflow on every animation frame. Removed `font-weight` from the transition list; active-line emphasis now uses `transform: scaleX(1.015)` (compositor-only). Added `contain: layout style` to the overlay to isolate reflows from the rest of the page.

### i18n

- New keys for Hi-Res playback settings and music folder filter added to all 7 languages (EN, DE, FR, NL, ZH, NB, RU).

---

## [1.34.1] - 2026-04-06

### Added

- **Fullscreen Player — Synced Lyrics Overlay**: Synced lyrics are now displayed directly in the Fullscreen Player as an animated 5-line rail with a soft fade mask at the top and bottom edges. Click any visible line to seek to that position. Toggle the overlay on/off with the new microphone icon button next to the heart — preference is persisted.

  > **Note:** The overlay currently requires synced (timestamped) lyrics. Support for unsynced lyrics in the Fullscreen Player is planned for a future release.

- **Embedded Lyrics & LRC support**: The app now fetches lyrics from two sources using the shared `useLyrics` hook (used by both the Lyrics Pane and the Fullscreen overlay):
  - **Server-embedded lyrics** via the OpenSubsonic `getLyricsBySongId` endpoint — reads timestamped or plain lyrics baked directly into the audio file's tags (Navidrome 0.53+).
  - **LRCLIB** — external LRC lookup as fallback (or primary, configurable in Settings → Playback).
  Both sources share a module-level cache so switching between the Lyrics Pane and the Fullscreen Player never triggers a second network request.

- **Artist Image Upload**: A camera overlay now appears when hovering the artist portrait on the Artist page. Clicking it opens a file picker and uploads the image directly to your server.

  > **Requires `EnableArtworkUpload = true`** in your Navidrome configuration (new option in Navidrome [#5110](https://github.com/navidrome/navidrome/issues/5110) / [#5198](https://github.com/navidrome/navidrome/issues/5198) — default: `true`). The same requirement applies to the existing Radio Station cover upload.

- **Discord Rich Presence — Album Cover Art**: Album artwork is now displayed in Discord's Rich Presence card. Because Subsonic cover URLs require authentication (and can't be accessed by Discord directly), artwork is fetched from the iTunes Search API using a 3-strategy search (exact → relaxed → track-title fallback), cached for 1 hour, and passed as a direct URL to Discord. Falls back to the static Psysonic asset when no match is found.
- **Nightfox themes** *(PR [#112](https://github.com/Psychotoxical/psysonic/pull/112) by [@nisrael](https://github.com/nisrael))*: Six themes from the [nightfox.nvim](https://github.com/EdenEast/nightfox.nvim) palette have been added to the **Open Source Classics** group — Dawnfox, Dayfox, Nightfox, Nordfox, Carbonfox, and Terafox.
- **Auto-install script** *(PR [#121](https://github.com/Psychotoxical/psysonic/pull/121) by [@kilyabin](https://github.com/kilyabin))*: `install.sh` now supports Debian/Ubuntu (`.deb`) and RHEL/Fedora (`.rpm`) — automatically detects the distro, downloads the correct package from the latest release, and installs it.

### Changed

- **Fullscreen Player — performance overhaul**:
  - `FsArt` (cover art) and `FsLyrics` are now isolated `memo` components — unrelated state changes no longer trigger their re-renders.
  - Cover crossfade uses an `onLoad` DOM event instead of `new Image()` preloading. This avoids a React batching edge case where both state updates were flushed together and the browser never saw the `opacity: 0` starting state, preventing the CSS transition from firing.
  - `useCachedUrl(..., true)` passes the raw URL as an immediate fallback — the image starts fetching from the network instantly while IndexedDB resolves the blob in the background.
  - Lyrics slot height is stored in a `useRef` and updated only on `resize` — eliminates repeated `window.innerHeight` layout reads on every render.
  - Mouse-move handler is throttled to 200 ms.
- **Artist page — biography**: The bio text is now collapsed by default with a *Read more* / *Show less* toggle button, keeping the page layout clean for artists with long bios.
- **Settings — Logout button**: Moved from the System tab to the bottom of the Server tab, styled as a danger button (red outline → red fill on hover).

### Fixed

- **Gapless playback — manual skip** *(PR [#119](https://github.com/Psychotoxical/psysonic/pull/119) by [@cucadmuh](https://github.com/cucadmuh))*: When the next track had already been gapless-pre-chained into the Sink, a manual skip would not interrupt it — the pre-chained track continued playing at full volume from the old Sink after the fade-out. The chain is now matched by stream identity so user-initiated playback always takes precedence.
- **Radio / Artist cover cache**: `invalidateCoverArt` is now called after every cover upload and delete, so the old image is evicted from the local cache immediately.
- **Queue auto-scroll**: The active track now scrolls reliably into view; eliminated unnecessary component re-renders caused by unstable selector references.
- **macOS TLS** *(PR [#114](https://github.com/Psychotoxical/psysonic/pull/114) by [@nisrael](https://github.com/nisrael))*: Switched `reqwest` from `native-tls` (macOS Security framework) to `rustls-tls` (statically linked). The native backend was returning *bad protocol version* when connecting to HTTPS music servers, silently preventing playback.

### i18n

- **Russian translation improvements** *(PR [#120](https://github.com/Psychotoxical/psysonic/pull/120) by [@kilyabin](https://github.com/kilyabin))*: Extensive phrasing refinements across the entire Russian locale.
- New keys (`fsLyricsToggle`, embedded lyrics settings) added to all 7 languages (EN, DE, FR, NL, ZH, NB, RU).

---

## [1.34.0] - 2026-04-06

### Added

- **Mobile UI — Early Preview** ⚠️ — After multiple requests from the community, an initial mobile layout is shipping in this release. **This is a very early work-in-progress** — expect rough edges, missing features, and layouts that still need a lot of polish. Feedback is very welcome! Join the [Discord](https://discord.gg/ckVPGPMS) to share your thoughts.
  - Sidebar and queue panel are hidden on mobile; a sticky **Bottom Navigation Bar** replaces them with quick access to Mainstage, Albums, Now Playing, and Search.
  - **Mobile Player View** (`/now-playing`) — Full-screen ambient player with dynamic album-art-based background color, large cover art, track metadata line, and playback controls.
  - **Mobile Search Overlay** — Full-screen search with recent search history, category chips (Albums, Artists, Genres), and grouped results.
  - **Mobile Album Header** — Compact two-row icon button layout (Play + Queue primary, Favorite + Bio + Download + Offline secondary).
  - **Mobile Tracklist** — Simplified track rows; disc headers preserved for multi-disc albums.
  - **Mobile Hero / Carousel** — Blurred-background-only layout with circular Play + Queue buttons.
- **Russian 2 translation** *(PR [#107](https://github.com/Psychotoxical/psysonic/pull/107) by [@kilyabin](https://github.com/kilyabin))*: A second Russian translation alongside the existing one from [@cucadmuh](https://github.com/cucadmuh) *(PR [#106](https://github.com/Psychotoxical/psysonic/pull/106))*. Both are selectable in Settings → Appearance as **Russian** and **Russian 2**. Since the maintainer neither speaks nor reads Russian, **community feedback is essential here** — please vote on the [Discord](https://discord.gg/ckVPGPMS) or via GitHub which translation feels more natural so we can retire the weaker one in a future release.
- **Clickable Mainstage section headers** — "Zuletzt hinzugefügt", "Entdecken", "Künstler entdecken", and "Persönliche Favoriten" now navigate to their respective pages on click, with a `ChevronRight` indicator and accent-color hover effect.

### Fixed

- **macOS network playback** *(Issue [#108](https://github.com/Psychotoxical/psysonic/issues/108))*: Added `com.apple.security.network.client` to `Entitlements.plist` and disabled the app sandbox for unsigned/ad-hoc builds. Without this, macOS silently blocked outbound TCP connections from the Rust audio engine, causing the player to skip through every track without playing anything.
- **Auto-updater** *(under observation)*: Fixed an incorrect signature in the auto-generated `latest.json` — the CI was writing the public key as the signature value. The updater now receives a correctly signed manifest. **Note:** Due to OS-level restrictions on macOS (Gatekeeper) and Windows (SmartScreen) for unsigned apps, it is not yet certain whether the in-app updater will reliably work on these platforms. Manual installation from the Releases page remains the safe fallback.

### Changed

- All new i18n keys added to all 8 languages (EN, DE, FR, NL, ZH, NB, RU, RU2).

## [1.33.0] - 2026-04-06

### Added

- **Norwegian (Bokmål) translation** *(PR [#101](https://github.com/Psychotoxical/psysonic/pull/101) by [@zz5zz](https://github.com/zz5zz))*: Psysonic is now fully translated into Norwegian Bokmål — selectable in Settings → Appearance.
- **Configurable next-track preload** *(Issue [#102](https://github.com/Psychotoxical/psysonic/issues/102))*: A new setting in Settings → Playback controls when Psysonic starts buffering the next track. Three modes available:
  - **Balanced** (default) — begins buffering 30 s before the end of the current track (previous behaviour).
  - **Early** — begins buffering after just 5 s of playback, maximising reliability on slow connections.
  - **Custom** — set the exact threshold (5 – 120 s before the end) via a slider.
- **Tray icon visibility toggle**: A new toggle in Settings → App Behavior lets you show or hide the system tray icon. When disabled, the icon is fully removed from the notification area / menu bar.

### Changed

- **Fullscreen Player — complete redesign**: The Ambient Stage has been rebuilt from the ground up.
  - **Animated mesh background**: A GPU-only animated dark gradient mesh replaces the static blurred cover art background — smooth, performant, no layout repaints.
  - **Artist portrait**: The right half of the screen now shows the artist's image (loaded from the server), crossfading smoothly on every track change. Falls back to the album cover if no artist image is available.
  - **Bottom seekbar**: The seekbar is now pinned to the very bottom edge, spanning the full width, with elapsed and remaining timestamps above it.
  - **Heart button**: You can now star/unstar the currently playing track directly from the Fullscreen Player without leaving the view.
  - Removed the marquee-scrolling title in favour of a large, wrapping typographic layout.
- **Star buttons** — all star/favourite buttons across the app (Player Bar, Album Header, Album Tracklist, Queue Panel) now use the CSS class `.is-starred` instead of inline color overrides, making them trivially themeable.

### Fixed

- **macOS — HTTP audio streams**: Added `NSAppTransportSecurity` / `NSAllowsArbitraryLoads` to `Info.plist`. Without this, App Transport Security silently blocked HTTP radio streams and non-HTTPS Navidrome servers from loading audio in WKWebView on macOS.

---

## [1.32.0] - 2026-04-05 — *The Big Easter Update* 🐣

### Added

- **Custom Offline Storage Directory (#95)**: You can now specify a custom directory for the offline library in Settings → Storage & Downloads. This is perfect for offloading your internal drive to an SD card or external HDD.
- **Robust Volume Handling**: The app now automatically detects if a configured external storage medium is missing and provides a clear "Volume not found" notification instead of failing silently or attempting to download to a non-existent path.
- **Internet Radio — full release**: The Radio page is now accessible from the sidebar. Complete UI rewrite to a card-based layout (cover art, name, edit/homepage buttons) consistent with the Playlists look. Covers can be uploaded or removed via a hover menu directly on the card.
- **Internet Radio — Edit Modal**: A dedicated modal lets you change station name, stream URL, and homepage URL, and upload or remove cover art.
- **Internet Radio — Radio Browser directory** *(via [radio-browser.info](https://www.radio-browser.info))*: Discover new stations directly inside Psysonic. Top stations by vote are shown as suggestions; a debounced search finds stations by name. Favicon images can be imported as cover art in one click.
- **Settings — Backup & Restore**: Export all your settings (servers, theme, font, keybindings, EQ preset, sidebar order) to a single JSON file and import them on another machine or after a reinstall. Available in Settings → Storage.
- **Albums — Year Range Filter**: A From/To year input now appears in the Albums toolbar alongside the existing genre filter. Filtering by year and by genre can be combined; clearing both inputs returns to the default view.
- **Statistics — Library Insights** *(requested via [#88](https://github.com/Psychotoxical/psysonic/issues/88))*:
  - **Total Playtime** card: computed in the background by paginating your full album list (up to 5 000 albums). Shows `≥ Xh Ym` if the library is larger.
  - **Genre Insights**: Top 10 genres ranked by song count with proportional progress bars.
  - **Format Distribution**: Codec breakdown from a random 500-track sample — shows format name and percentage.
- **Playlist Detail — Cover Upload**: Change or remove a playlist's cover image via the hover menu that appears on the hero artwork — no external tool needed.
- **Tracklist columns — Playlists & Favorites** *(work in progress)*: PlaylistDetail and Favorites now support the same resizable, configurable column system introduced in v1.31.0 for Album tracklists. Column widths and visibility are persisted independently per page. The feature is still being refined.

### Changed

- **Crossfade — fine-grained control**: The crossfade duration slider now ranges from 0.1 s to 10 s in 0.1 s steps (previously 1 s minimum, 0.5 s steps). The current value is shown with one decimal place.
- **Settings — Storage tab redesign**: The "Offline Library" section now has a short description and includes Cache settings. The "Downloads" section is now labelled "ZIP Export & Archiving". Both sections have been visually consolidated.
- **Artists page — Load More button** *(reported via [#90](https://github.com/Psychotoxical/psysonic/issues/90))*: The button is now styled as `btn-primary` with a `ChevronDown` icon and proper spacing. Previously it was an unstyled ghost button with no visual affordance.
- **Tracklist layout consistency**: The Play-button column is now uniformly 60 px and the title column uses `minmax(150px, 1fr)` across all list views — Search Results, Artist Detail, Random Mix, and Advanced Search now match the Album tracklist layout.
- **Internet Radio — HTML5 playback**: Radio now streams via the browser's native `<audio>` element instead of a custom Rust pipeline. This improves compatibility with AAC/MP3/HLS streams.
- **AppUpdater — error visibility** *(experimental, still in progress)*: Update failures are now shown inside the update card rather than silently logged. Auto-update remains experimental — a direct GitHub Releases link is always shown as a fallback.
- **Queue panel — radio drag**: Dragging a radio station card onto the queue is now silently rejected instead of causing an error.

### Fixed

- **PlayerBar stuck on Radio info**: Switching from an Internet Radio station to a regular track no longer leaves the station name and cover in the player bar. `playTrack` now clears `currentRadio` state and stops the audio element immediately.
- **Radio favourite icon**: The heart icon is now correctly used for favourite radio stations on both the Internet Radio page and the Favourites page. It was incorrectly showing a star.
- **Offline track deletion — orphaned directories**: Deleting a cached track now removes empty parent directories up to the configured base directory. Uses `std::fs::remove_dir` (safe — only removes empty directories) to avoid accidental data loss.

---

## [1.31.0] - 2026-04-04

> **Note:** This is likely the last update for the coming week — taking a short break. See you on the other side. ☀️

### Added

- **AutoEQ — 10-Band Parametric Equalizer**: Full parametric EQ with 10 adjustable bands, bypass toggle, and pre-gain control. AutoEQ presets are loaded directly from the AutoEQ GitHub repository — search for your headphone model and apply a community-measured correction curve with one click.
- **Internet Radio — infrastructure** *(work in progress, not yet released)*: The full backend for Internet Radio playback is in place — a dedicated Rust `RadioBuffer` streaming pipeline in the audio engine, Subsonic API integration (`getInternetRadioStations`, create/update/delete), and a `playRadio` action in the player store. The UI page exists but the feature is **not yet accessible** from the sidebar — it will be enabled once the experience is polished.
- **Tracklist columns — resizable & configurable** *(experimental)*: Album tracklist columns can now be resized by dragging the dividers between header cells, similar to a spreadsheet. A column visibility picker (chevron button at the top right) lets you show or hide individual columns. The `#` column is fixed-width. Column widths and visibility are persisted in localStorage. The feature works but is still being refined.
- **Genre column in album tracklist**: Albums that have genre tags per track now show a Genre column in the tracklist.
- **Sidebar auto-migration**: New sidebar items (e.g. Internet Radio) are automatically appended to existing persisted sidebar configurations on first launch — no more missing entries after updates.

### Changed

- **Discord Rich Presence**: Activity type is now `Listening` instead of the default `Playing`. The artist field no longer has the "by " prefix — Discord's layout makes the context clear without it. Album name is shown as a tooltip on the cover icon.
- **Clickable artist names everywhere**: Artist names in Album Cards, Favorites, Random Mix, Playlist Detail, and Artist Detail tracklists are now clickable links that navigate to the artist page.
- **Duration format supports hours**: Tracks and albums longer than 60 minutes are now displayed as `H:MM:SS` instead of overflowing minutes (e.g. `75:03` → `1:15:03`).
- **Format column**: Codec label no longer includes the "kbps" suffix or the `·` separator — cleaner and fits the narrower column better (e.g. `FLAC 1411` instead of `FLAC · 1411 kbps`).
- **Now Playing sidebar link**: No longer permanently styled as an active menu item. It now only shows the accent background when you are actually on the Now Playing page; at all other times it is distinguished only by its accent text colour.
- **Paused-state indicator in tracklist**: When the currently active track is paused, a dimmed play icon is shown in the `#` column instead of a blank space — making it clear which track is loaded even when playback is stopped.
- **Text selection disabled**: Text can no longer be accidentally selected anywhere in the player by click-dragging or pressing Ctrl+A. Standard input fields are unaffected.
- **Settings — button styles**: "Test connection", "Add server", and "Pick download folder" buttons are now `btn-surface` (with a subtle border) instead of the borderless `btn-ghost` — clearer affordance.
- **Settings — Behavior section icon**: Replaced the generic `Sliders` icon with `AppWindow` for the Behavior section header.
- **`btn-surface` border**: The surface button variant now has a 1 px border that brightens on hover — consistent with the card and input visual language.
- **Queue panel minimum width**: Increased from 250 px to 310 px to prevent layout overflow when the codec/bitrate overlay is visible.
- **Server compatibility hint**: A short note below the Servers section header in Settings clarifies which Subsonic-compatible servers are supported.

### Fixed

- **Tracklist `#` column header alignment**: The "Select all" checkbox and the `#` symbol in the header now use the same internal layout as the row cells — ensuring alignment with individual checkboxes and track numbers at all window sizes.
- **Column resize dividers**: The visible 2 px divider line is now placed in the gap between columns rather than inside the cell, so header labels appear visually centred between their dividers.
- **Internet Radio sidebar link hidden**: The navigation entry is temporarily removed until the feature is ready for release. The underlying code remains in place and will be re-enabled without any migration required.

---

## [1.30.0] - 2026-04-03

### Added

- **Bulk offline download — Playlists & Artist discographies** *(requested by [@Apollosport](https://github.com/Apollosport), [#54](https://github.com/Psychotoxical/psysonic/issues/54))*: Download an entire playlist or a full artist discography for offline use in one click. Progress is tracked per album on the Artist page ("Caching… 2/5 albums").
- **Offline Library filter tabs**: The Offline Library now has four filter tabs — All, Albums, Playlists, and Discographies. The Discographies tab groups albums under their respective artist with section headings.
- **Discord Rich Presence** *(requested by [@Bewenben](https://github.com/Bewenben), [#49](https://github.com/Psychotoxical/psysonic/issues/49))* (opt-in): Psysonic can now update your Discord status with the currently playing track, artist, and a live elapsed timer. Toggle in Settings → General → "Discord Rich Presence".
- **Artist images on Artists page** *(reported by [@Apollosport](https://github.com/Apollosport), [#53](https://github.com/Psychotoxical/psysonic/issues/53))* (opt-in): Artist avatars on the Artists overview can now show the actual artist image from the server instead of the coloured initial. Toggle in Settings → General → "Show artist images". Off by default to preserve performance on large libraries.
- **Image lazy loading**: Cover art and artist images across all pages now load lazily via `IntersectionObserver` (300 px pre-fetch margin), significantly reducing initial page render time on large libraries.

### Fixed

- **Crossfade triggers on manual track skip** *(reported by [@netherguy4](https://github.com/netherguy4), [#35](https://github.com/Psychotoxical/psysonic/issues/35))*: Manually clicking Next/Prev or selecting a track from the queue no longer triggers the crossfade transition. Crossfade now only fires on natural track end.
- **Playlist offline cache showing individual album cards**: Caching a playlist offline previously created one card per album group in the Offline Library. The playlist is now stored as a single cohesive entry.
- **Image cache abort handling**: Aborted image fetches no longer prevented the cached result from being written to IndexedDB, causing covers to reload on every page visit.

### Changed

- **Queue tech strip**: Removed genre from the codec/bitrate overlay strip in the Queue panel — genre strings frequently caused layout overflow.
- **"Save discography offline" label**: The Artist page offline button now reads "Save discography offline" instead of "Download discography" to avoid confusion with a ZIP export.
- **Update toast (Win/Mac)**: The update notification now includes a disclaimer that auto-update is still in development, and always shows a direct GitHub Releases download link alongside the install button as a fallback.
- **Facebook theme overhaul**: Improved grey text contrast, opaque album chip and back button, readable Queue/Lyrics tab labels.

---

## [1.29.0] - 2026-04-02

### Added

- **Radio: instant start + background enrichment** *(requested by [@netherguy4](https://github.com/netherguy4))*: Artist Radio now starts immediately from fast local `getTopSongs` results. `getSimilarSongs2` (Last.fm-dependent, slow) continues in the background and silently enriches the queue once it resolves — no waiting before the first song.
- **OGG/Vorbis playback** *(contributed by [@JulianNymark](https://github.com/JulianNymark), [PR #42](https://github.com/Psychotoxical/psysonic/pull/42))*: Added `symphonia-format-ogg` — `.ogg` files now play natively without server-side transcoding.
- **Click-to-seek in synced lyrics** *(contributed by [@nisarg-78](https://github.com/nisarg-78), [PR #38](https://github.com/Psychotoxical/psysonic/pull/38))*: Clicking any line in the synced lyrics pane seeks directly to that timestamp.
- **Volume scroll wheel** *(contributed by [@nisarg-78](https://github.com/nisarg-78), [PR #38](https://github.com/Psychotoxical/psysonic/pull/38))*: Scrolling the mouse wheel over the volume slider adjusts volume in ±5 % steps.
- **Lyrics visual states** *(contributed by [@nisarg-78](https://github.com/nisarg-78), [PR #38](https://github.com/Psychotoxical/psysonic/pull/38))*: Synced lyrics lines now show three distinct visual states — active (highlighted), completed (muted), upcoming (neutral).
- **Themed audio error toasts** *(contributed by [@JulianNymark](https://github.com/JulianNymark), [PR #43](https://github.com/Psychotoxical/psysonic/pull/43) / [PR #44](https://github.com/Psychotoxical/psysonic/pull/44))*: Unsupported formats and decode failures are now surfaced as themed in-app toast notifications with human-readable messages instead of silent failures.

### Fixed

- **Auto-updater endless loop on macOS / Windows**: The single-instance plugin was killing the relaunching process before it could start. Hopefully fixed by exiting the old process first (releasing the lock) and spawning the new process via a shell-based delayed restart.
- **Radio queue stacking**: Clicking "Start Radio" multiple times no longer appends unlimited duplicate batches — each click replaces the pending Radio section cleanly.
- **Start Radio keeps current song playing**: Triggering Radio while a song is playing no longer stops and restarts the current track.
- **Radio proactive loading with songs missing `artistId`**: `getSimilarSongs2` results frequently lack `artistId`. A `currentRadioArtistId` module variable now persists the original artist ID as fallback, so proactive loading always fires correctly.
- **Seek audio glitch after lyrics click**: Any seek ≥ 100 ms into a track no longer causes a brief fade-from-zero. `EqualPowerFadeIn` now only resets to zero-gain for seeks to the track start.

### Changed

- **Infinite Queue: 5 tracks at a time** (was 25): Proactive loading fetches 5 tracks when ≤ 2 remain, keeping the queue lean without interruption.
- **Queue section order is now explicit**: Manual tracks → Radio (with `— Radio —` separator) → Infinite Queue auto-added tracks (with `— Auto —` separator). Manually enqueued songs always appear before auto-managed sections.

### Contributors

Thanks to [@nisarg-78](https://github.com/nisarg-78) and [@JulianNymark](https://github.com/JulianNymark) for their first contributions in this release.
Special thanks to [@netherguy4](https://github.com/netherguy4) for continued feature ideas and feedback.

---

## [1.28.0] - 2026-04-02

### Added

- **Infinite Queue** *(requested by [@netherguy4](https://github.com/netherguy4))*: When the queue runs out with Repeat off, Psysonic automatically appends 25 random tracks (optionally filtered by the last-played track's genre) so playback never stops. Toggle in Settings → Audio → "Infinite Queue". Auto-added tracks appear below a divider in the Queue panel.
- **Start Radio plays immediately** *(requested by [@netherguy4](https://github.com/netherguy4))*: "Start Radio" from the song/queue context menu now starts the seed track instantly while similar and top tracks load in the background — no waiting for the fetch to complete before music plays.

### Fixed

- **Single-click to play everywhere** *(reported by [@netherguy4](https://github.com/netherguy4))*: Song rows in Album Detail, Playlist Detail, Artist Detail (Top Tracks), Favorites, and Random Mix previously required a double-click. All rows now play on a single click. The track-number cell and the full row are both click targets; buttons and links inside the row still work independently.
- **Artist page Play All / Shuffle used Top Tracks only** *(reported by [@smirnoffjr](https://github.com/smirnoffjr))*: "Play All" and "Shuffle" on the Artist detail page only sent the loaded top songs to the queue, not the full discography. Now fetches all albums in parallel and plays songs in chronological album order with correct track-number ordering within each album. Buttons show a spinner while albums are loading.
- **Last.fm icon clipped in player bar**: The Last.fm logo button in the player bar was cut off on the right side. Fixed by correcting the SVG `viewBox` from `0 0 24 24` to `0 0 26 22` to match the actual path extents.
- **Playlist empty state UX** *(reported by [@netherguy4](https://github.com/netherguy4))*: Empty playlists (on creation, or after deleting all tracks) now show an "Add your first song" CTA button that opens the search panel directly, rather than a plain text message with no action.
- **Playlist search rows required "+" button click** *(reported by [@netherguy4](https://github.com/netherguy4))*: Search result rows in the song search panel now add the song on a full-row click — the separate "+" button was redundant and easy to miss.
- **Large playlist performance**: Playlists with hundreds of songs would freeze during mouse movement. Root cause: `hoveredSongId` state triggered a full React re-render of every row on every `mouseenter`/`mouseleave` event. Fixed by removing the JS hover state and replacing it with a CSS `.track-row:hover .bulk-check` rule. Also memoized `songs.map(songToTrack)` and the `existingIds` set to avoid recomputation per render. Same fix applied to `AlbumTrackList`.

---

## [1.27.4] - 2026-04-02

### Added

- **In-App Auto-Update** *(requested by [@netherguy4](https://github.com/netherguy4))*: Psysonic now checks for new releases automatically on startup (3 s delay). On macOS and Windows a native install-and-relaunch flow is available directly in the app — no browser needed. On Linux, a download link to the GitHub release page is shown instead (AppImage is not built due to WebKitGTK incompatibility with Arch/Fedora). The updater uses Tauri's signed updater plugin with minisign signatures verified against a bundled public key.
- **Configurable Home Page**: Users can now choose which sections appear on the home page. A new "Home Page" block in Settings → Library lets you toggle each section individually (Featured, Recently Added, Discover, Discover Artists, Recently Played, Personal Favorites, Most Played) with a reset-to-default button. Hidden sections are skipped entirely.
- **Consistent icon language** *(requested by [@netherguy4](https://github.com/netherguy4))*: Favorites (local star/heart) now use a filled Heart icon everywhere — Player Bar, Album Detail, Artist Detail, Tracklist, Context Menu. Last.fm love always uses the Last.fm logo. Previously the two were mixed up in several places.

### Fixed

- **Radio broken from context menu** *(reported by [@netherguy4](https://github.com/netherguy4))*: "Start Radio" in the track and queue-item context menus had no effect. The handler was passing the artist name as the artist ID to `getSimilarSongs2`, which returned an empty result — so no tracks were queued and no error was shown. Now correctly passes `song.artistId`.
- **Album Detail hero background not loading**: The blurred album art background in Album Detail only appeared after a track change, never on first visit. Root cause: `buildCoverArtUrl` was called without `useMemo`, generating a new salt on every re-render — causing `useCachedUrl` to cancel and restart its fetch endlessly. Fixed by memoising both the URL and cache key on `album.coverArt`. Same fix applied to Hero and Playlist Detail backgrounds.
- **CI: auto-update signing pipeline**: Signing keys were not being passed correctly during the build, and macOS `.sig` files were uploaded with a generic name the manifest generator couldn't match. Fixed the post-build signing step to upload arch-specific names (`Psysonic_aarch64.app.tar.gz.sig`, `Psysonic_x64.app.tar.gz.sig`). First release where the in-app updater is fully functional on macOS and Windows.
- **CI: Windows NSIS upload**: The release workflow was not correctly uploading Windows artifacts. Resolved by letting `tauri-action` handle NSIS bundle detection and upload directly — it only searches for what was actually built, so there is no MSI conflict with `--bundles nsis` builds.
- **CI: npm + Cargo caching** *(contributed by [@netherguy4](https://github.com/netherguy4))*: Added `actions/cache` for npm and `Swatinem/rust-cache` for Cargo across all build jobs. Warm-cache builds will be significantly faster on subsequent releases.
- **Linux/AUR build: ring linker error**: Builds on Arch/CachyOS failed with `rust-lld: undefined symbol: ring_core_*` after the Tauri updater was added. Arch's `rust` package bakes `-fuse-ld=lld` into the default rustflags; ring's C/asm objects are incompatible with lld. Fixed via `.cargo/config.toml` — forces `cc` as linker driver with `-fuse-ld=bfd` to override the hardcoded lld flag. Added `clang` to the AUR `makedepends` (required by ring's bindgen step).

---

## [1.26.1] - 2026-04-01

### Fixed

- **Background flickering in Hero, Album Detail and Playlist Detail**: Blurred hero backgrounds were flickering for up to 20 seconds on first visit. Root cause: `useCachedUrl` with the default `fallbackToFetch = true` immediately returned the raw server URL, causing the background to render twice — once with the HTTP URL (triggering a server fetch) and again when the IndexedDB blob was ready. Fixed by passing `fallbackToFetch = false` in all three locations so the background only renders once the blob is cached.

---

## [1.26.0] - 2026-04-01

### Added

- **Favorite button in Player Bar** *(requested by [@halfkey](https://github.com/halfkey))*: A star icon button now sits next to the Last.fm heart in the player bar. Clicking it toggles the favorite/unfavorite state for the currently playing track with an optimistic UI update — no page reload needed. Uses the same `starredOverrides` mechanism as the album tracklist for instant feedback.
- **Bulk Select for song lists**: Multi-select support in Album tracklist and Playlist detail. A checkbox fades in to the left of the track number on hover. Selecting one or more tracks activates the bulk action bar at the top with two actions: **Add to Playlist** (opens the playlist picker submenu) and **Remove from Playlist** (Playlist detail only). Shift-click selects a range; the header checkbox selects / deselects all. CSS uses `color-mix` for the selection highlight, compatible with all 60 themes.
- **Song Info modal**: Right-clicking any song and choosing "Song Info" opens a metadata panel fetched live via `getSong`. Displays: title, artist, album, album artist, year, genre, duration, track number; format, bitrate, sample rate, bit depth, channels (Mono / Stereo), file size; file path; and Replay Gain values (track / album gain + peak) when present. Closes with Escape or a click on the backdrop.
- **Recently Played section on Home page**: A new "Recently Played" album row appears on the Home page between the hero carousel and the Discover section, powered by the `getAlbumList('recent')` endpoint.
- **"Now Playing" visibility toggle in Settings**: New opt-in toggle in Settings → Behavior ("Show activity in Now Playing"). When disabled (default), `reportNowPlaying` is not called, so no activity is reported to the Navidrome "Now Playing" feed. Useful for users who share a server.

### Fixed

- **Queue cover art not updating**: After a track change the queue panel cover art often stayed on the previous album or took a long time to update. Root cause: `useCachedUrl` and `CachedImage` were not resetting their resolved URL when the `cacheKey` changed. Fixed by resetting `resolved` to `''` before each async cache fetch and basing `CachedImage`'s `loaded` state on `useEffect([cacheKey])` instead of a render-time comparison.
- **Fullscreen Player background flickering**: The blurred background briefly showed a blank frame when switching tracks because the new image div was added to the DOM before the blob URL was ready. Fixed in `FsBg` by preloading the image via `new Image()` before inserting the layer, and using `useCachedUrl(..., false)` for the crossfade background so the raw URL is never used as a fallback during transitions.
- **Playlist card delete confirmation not visible**: The confirm state only changed the icon colour, which was barely noticeable over the red button. Replaced with a size expansion (24 px → 30 px), an inset white ring, and a pulsing `delete-confirm-pulse` animation that alternates between two shades of red.
- **Gruvbox Light Soft — back button and badge**: The album detail back-arrow and album badge were invisible against the warm light background. Added explicit colour overrides for `.album-detail-back` and `.album-detail-badge` in the gruvbox-light-soft theme.

### Changed

- **`buildStreamUrl` signature**: Removed the unused `suffix` parameter. Opus transcoding (`format=flac`) is now handled in `playerStore.playTrack` via `track.suffix` check, keeping the URL builder stateless.

---

## [1.25.1] - 2026-04-01

### Fixed

- **Single-instance enforcement** *(reported by [@netherguy4](https://github.com/netherguy4))*: Re-launching the app while it was already running (including minimized to tray) would spawn a new independent process, leading to playback conflicts and state divergence. Integrated `tauri-plugin-single-instance` — subsequent launches are intercepted, the existing window is shown, unminimized, and focused instead.

---

## [1.25.0] - 2026-04-01

### Added

- **System Tray** *(requested by [@jackbot](https://github.com/jackbot) and [@thecyanide](https://github.com/thecyanide))*: Functional tray icon with context menu — Play / Pause, Previous Track, Next Track, Show / Hide, and Exit Psysonic. Left-clicking the tray icon toggles window visibility. The tray icon is built via `TrayIconBuilder` in Rust so menu events are properly wired.
- **Minimize to Tray** *(requested by [@jackbot](https://github.com/jackbot) and [@thecyanide](https://github.com/thecyanide))*: New toggle in Settings → Behavior. When enabled, closing the window hides it to the tray instead of exiting. The close button behaviour is intercepted in Rust (`prevent_close` + `window:close-requested` event) and the JS side decides hide vs. exit based on the user setting.
- **Sidebar Customization** *(requested by [@lighthous3d](https://github.com/lighthous3d))*: New section in Settings → Appearance. All library and system nav items can be shown/hidden via a toggle switch and reordered by dragging the grip handle. Order and visibility are persisted across sessions (`psysonic_sidebar` in localStorage). Fixed items (Now Playing, Settings) are listed as non-configurable below the list.
- **Playlist cover art**: Playlist cards on the Playlists overview page now display the server-generated cover image (Navidrome's `coverArt` field on the playlist object) via the IndexedDB image cache. Falls back to the ListMusic icon when no cover is available.

### Fixed

- **Cover image flickering**: `buildCoverArtUrl()` generates a new random auth salt on every call, causing `useCachedUrl` to re-trigger on every render and produce a rapid re-fetch loop. Fixed by wrapping all `buildCoverArtUrl` / `coverArtCacheKey` calls in `useMemo` with the cover ID as dependency in `ArtistCardLocal`, `QueuePanel`, `FullscreenPlayer`, `Hero`, and `PlaylistDetail`.
- **DnD text selection**: Dragging a grip handle in the Sidebar Customizer (and any future `useDragSource` consumer) would select all text on the page during the threshold detection phase. Fixed by calling `e.preventDefault()` in `useDragSource`'s `onMouseDown` handler before the drag threshold is reached.
- **Sidebar Customization DnD on Linux**: The initial implementation used the HTML5 Drag & Drop API, which always shows a forbidden cursor on WebKitGTK and does not fire drop events reliably. Rewritten to use the existing psy-drag mouse-event system (`useDragSource` / `psy-drop` custom event), consistent with the Queue panel.

---

## [1.24.0] - 2026-03-31

### Added

- **Playlist Management** *(requested by [@adirav02](https://github.com/adirav02))*: Full playlist management feature:
  - **Playlists overview page** (`/playlists`): card grid showing all server playlists with cover collage, song count and duration. Inline "New Playlist" creation (Enter to confirm, Escape to cancel). Two-click delete confirmation directly on the card.
  - **Playlist detail page** (`/playlists/:id`): hero area with 2×2 album cover collage and blurred background (matching Album Detail style), full tracklist with drag-and-drop reordering, star ratings, codec labels, per-row delete button, and context menu.
  - **Song search**: "Add Songs" button opens an inline search panel with debounced server search, thumbnail, artist · album info, and a round add button (accent on hover). Duplicate songs already in the playlist are filtered from results.
  - **Suggestions**: "Suggested Songs" section below the tracklist loads similar songs via `getSimilarSongs2` based on the first artist in the playlist. Refresh button to load a new batch. Same tracklist layout as search results.
  - **Context menu — Add to Playlist**: "Add to Playlist" submenu available on all song/album/queue-item context menus. Playlists sorted by most recently used. "New Playlist" inline create at the top of the submenu. Submenu flips left when near the right viewport edge.
  - **Sidebar**: Playlists navigation entry added between Favorites and Statistics.
  - **Recently used playlist tracking**: `playlistStore` (persisted) tracks the last 50 used playlist IDs for the context menu sort order.

### Fixed

- **Resampling — first track played at native sample rate** *(reported by [@sorensiimSalling](https://github.com/sorensiimSalling))*: `current_sample_rate` was initialized to `44100`, causing every track to be resampled down to 44.1 kHz on playback start. Initializing to `0` disables resampling until the actual track rate is known.
- **Resampling — no application-level resampling for any track**: `target_rate` in `audio_play` and `audio_chain_next` is now always `0`. Previously, tracks after the first were resampled to match the first track's sample rate. Rodio handles conversion to the output device rate internally; every track now plays at its native sample rate.
- **Playlist hero background flickering**: The blurred hero background in Playlist Detail flickered on every render because `buildCoverArtUrl()` generates a new random salt on every call, causing `useCachedUrl` to re-trigger in a loop. The fetch URL and cache key are now `useMemo`-stabilised.
- **Input focus double border**: The playlist name and song search inputs used a `search-input` class that had no CSS definition, falling back to browser defaults. The global `:focus-visible` rule then added a second outline on top of the browser's own focus ring. Switched to the `.input` class which sets `outline: none` and uses `border-color` + glow on focus.

### Changed

- **Playlist search panel**: Redesigned with `surface-2` background, `radius-lg`, slide-down open animation, 36 px thumbnails, artist · album subtitle line, and a round icon add-button (accent colour on hover) replacing the generic `btn-surface` button.

---

## [1.23.0] - 2026-03-30

### Added

- **Advanced Search**: New dedicated page (`/search/advanced`) reachable via the filter icon in the search bar. Supports free-text search combined with genre filter (dropdown from server), year range (from/to), and result-type toggle (All / Artists / Albums / Songs). Search logic: text query uses `search3` with client-side genre/year filtering; genre-only uses `getAlbumsByGenre` + random songs from that genre; year-only uses `getAlbumList(byYear)`. Results show in the standard ArtistRow / AlbumRow / tracklist layout with drag-to-queue and context menu support.
- **Genre Mix — Server-native genres**: The Genre Mix panel in Random Mix now shows the top 20 genres from the server sorted by song count, instead of hardcoded keyword-based "Super Genre" groups. Only genres with at least one song and no audiobook keywords are shown. Clicking a badge fetches up to 50 random songs from exactly that genre.
- **Genre Mix — Shuffle button**: A ↺ button appears when the server has more than 20 genres. Clicking it picks a fresh random selection of 20 from all available genres, replacing the current badges without triggering a search.
- **Favorites — Play All**: "Play All" button (primary style) added next to "Add all to queue" in the Favorites → Songs section. Starts playback immediately from the first favorited song.
- **Playlist Load — Append mode**: The playlist load modal now has two action buttons per playlist: ▶ replaces the queue and starts playback (previous behavior), ≡+ appends all tracks to the existing queue without interrupting playback.

### Fixed

- **Replay Gain** *(contributed by [@trbn1](https://github.com/trbn1))*: Replay Gain metadata (track gain, album gain, peaks) is now correctly propagated to the audio engine across all track-construction sites via the new `songToTrack()` helper. Previously tracks built inline missed the `replayGain` field, causing the engine to apply 0 dB gain regardless of tags.

### Changed

- **Genre Mix description**: Panel subtitle updated to explain that badges represent the top 20 genres by song count and that clicking loads a random mix from that genre.
- **Random Mix — Filter panel**: Added a short descriptive hint below the "Filters" heading explaining that genre tags and artist names in the tracklist are clickable to add them to the blacklist.
- **Playlist Load modal**: Width increased from 400 px to 560 px (90 vw cap) so long playlist names are readable without truncation.
- **Settings — Contributors**: Contributors section is now a collapsible table. Each entry shows the contributor's GitHub avatar, `@username` (linked to their profile), a version badge, and a bullet list of their specific contributions. [@trbn1](https://github.com/trbn1) added for Replay Gain fix (PR #9).

### Theme Fixes

- **Powerslave**: Album card play button no longer flickers between gradient and flat accent color on hover — explicit `:hover` gradient override added. Sidebar stripe pattern replaced with soft radial-gradient cloud wisps.

---

## [1.22.0] - 2026-03-30

### Added

- **Queue — Active Playlist Tracking** *(Beta)* ⚠️: The queue now remembers which playlist was last loaded or saved. The playlist name appears as a subtitle below the queue title. The save button smart-saves: if an active playlist is set, it updates that playlist directly without opening a modal. If no playlist is active, the save modal opens as before.
- **Queue — Themed Delete Confirmation** *(Beta)* ⚠️: Deleting a playlist now shows a styled in-app confirmation dialog matching the current theme, replacing the unstyled native browser `confirm()` dialog.
- **Queue — Load Modal Live Filter** *(Beta)* ⚠️: The playlist load modal now has a live filter input at the top — typing narrows the playlist list in real time.
- **Drag & Drop — Precise Insertion** *(Beta)* ⚠️: Songs and albums dragged into the queue can now be dropped at any position between existing items. A blue insertion line shows exactly where the track will land. Previously all drops appended to the end of the queue.
- **Drag & Drop — Slim Ghost** *(Beta)* ⚠️: The drag ghost is now a compact single-line chip (cover thumbnail + title) instead of the full album card or track row. Consistent for both song and album drags.

### Fixed

- **Seek flash after debounce** *(contributed by [@nullobject](https://github.com/nullobject))*: After a seek the waveform briefly flashed back to the pre-seek position when the Rust `audio:progress` event arrived before the seek completed. A `seekTarget` guard now blocks stale progress ticks until the engine catches up.
- **Waveform seekbar jitter** *(contributed by [@nullobject](https://github.com/nullobject))*: The seekbar width changed on every progress tick because player time updates caused the waveform canvas container to reflow. The canvas now has an explicit stable width so time label changes no longer affect its layout.
- **Drag & Drop — text selection and grid auto-scroll during drag**: Dragging album cards or track rows caused the browser to begin a text selection and auto-scroll grid rows horizontally. All drag `onMouseDown` handlers now call `preventDefault()` and the DragDropContext uses `{ passive: false }` to suppress selection during mouse moves.
- **Drag & Drop — forbidden cursor on KDE Plasma**: Replaced the HTML5 `dragstart`/`dragend` system with a pure mouse-event DnD pipeline (`DragDropContext`). The WebKitGTK forbidden-cursor artefact on KDE Plasma no longer appears during drags.

### Changed

- **Settings — Contributors**: [@nullobject](https://github.com/nullobject) added for seek & waveform fixes.

### Theme Fixes

- **Powerslave**: Connection indicators (Last.fm / Server name) dimmed to match sidebar tone. Back button in album details now white on dark overlay. Tech strip (codec/bitrate) in queue uses dark Nile-blue background instead of sandstone. Artist name in album hero changed to Nile-blue `#050E19`.
- **North Park**: Back button in album details now visible (was dark brown on dark overlay).
- **Dark Side of the Moon**: Album detail year/genre/info brightened from `#555555` to `#888888`. Connection indicators brightened for legibility on near-black sidebar.

---

## [1.21.0] - 2026-03-29

### Added

- **What's New modal**: On first launch after an update, a changelog popup appears showing the current version's release notes. Can be permanently dismissed via checkbox, or re-enabled in Settings → About.
- **New theme category — Famous Albums**: A dedicated group for album-art-inspired themes.
- **Theme — Dark Side of the Moon (inspired)** *(Famous Albums)* ⚠️ **Beta**: Void-black everywhere, the iconic prism spectrum rainbow as a 2 px top border on the player bar, spectrum-violet accent `#9B30FF`, white track name (the input light beam).
- **Theme — Powerslave (inspired)** *(Famous Albums)* ⚠️ **Beta**: Sun-bleached sandstone main area, deep Nile-sky blue sidebar and player bar, pharaoh gold accent `#C8960C`. Blue–gold duality mirrors the album artwork's vivid azure sky against the Egyptian temple gold.
- **Theme — North Park** *(Series)* ⚠️ **Beta**: South Park-inspired. Construction-paper cream main area, Colorado mountain-blue `#1B3D6E` sidebar, Kenny orange `#FF8C00` accent, flat no-gradient buttons.

### Changed

- **AlbumTrackList — artist column always visible**: The artist column is now shown on all albums, not only Various Artists compilations. Useful for albums with guest artists or featuring credits where track-level artist differs from the album artist.
- **Tracklist column widths — more flexible**: Title and artist columns now use `minmax` fr units (`1.5fr` / `1fr`) instead of fixed sizes, so the artist column moves naturally closer to the title on wide viewports and never clips on narrow ones.

### Fixed

- **Settings — changelog toggle alignment**: The "Show What's New on update" toggle was rendering below its label instead of beside it.

---

## [1.20.0] - 2026-03-29

### Added

- **Chinese language (zh)**: Full UI translation contributed by [@jiezhuo](https://github.com/jiezhuo). Language can be selected in Settings → General.
- **Genres page** *(requested by [@grillonbleu](https://github.com/grillonbleu))*: New page (sidebar: Tags icon) showing all server genres as coloured cards — icon watermark, genre name, album count. Cards are sorted by album count descending and deterministically colour-coded from the Catppuccin palette. Clicking a card opens the album list for that genre. Navigating back restores the previous scroll position.
- **Genre filter on Albums, New Releases, Random Albums** *(requested by [@grillonbleu](https://github.com/grillonbleu))*: A multi-select genre combobox in the page header lets you filter any of these views to one or more genres. Chips show selected genres; backspace removes the last one; clicking outside collapses the filter automatically when nothing is selected. In filter mode, results are fetched in parallel across all selected genres and deduped client-side.
- **Settings — Contributors**: A new "Contributors" row in the About section credits community translators.

### Changed

- **Theme — W10** *(Operating Systems)*: New Windows 10 Fluent Design light theme. Clean white content area, flat light-grey `#F3F3F3` navigation pane, near-black `#1C1C1C` taskbar player bar with a Windows-blue `#0078D4` accent stripe, flat buttons without gradients (4 px radius). Sharp, unmistakably W10 — distinct from the glass-era W7/Vista and the rounded-corner W11.
- **ThemePicker — Windows themes sorted by release year**: W3.1 → W98 → WXP → Wista → W7 → W10 → W11.
- **Playlists page — removed**: The dedicated Playlists page has been removed. Playlists remain fully accessible via the Queue panel (Save / Load buttons in the toolbar).

### Fixed

- **FLAC seeking** *(Rust audio engine)*: `rodio`'s internal `ReadSeekSource` hardcodes `byte_len() → None`, which caused the symphonia FLAC demuxer to reject all seek attempts (it validates seek byte offsets against the total stream length). Replaced `rodio::Decoder` with a direct symphonia pipeline (`SizedDecoder`) that wraps the audio bytes in a `SizedCursorSource` providing the correct `byte_len()`. FLAC seeking now works regardless of whether the file has an embedded SEEKTABLE.
- **Genre missing in Queue meta box when playing from album card**: `playAlbum()` (used by the play button on all album cards) mapped song-level genre only — which Navidrome does not always return per song. Now falls back to the album-level genre from `getAlbum`. Same fallback applied to all three play/enqueue handlers in `AlbumDetail`.
- **Logo gradient CSS variables**: Sidebar logo gradient now uses `--logo-color-start` / `--logo-color-end` with fallbacks, allowing themes with dark sidebars to override the gradient colours.

---

## [1.19.0] - 2026-03-27

### Added

- **Offline storage full warning**: When caching an album would exceed the configured storage limit, a dismissible warning banner appears directly on the album page with quick links to the Offline Library and Settings.
- **Offline Mode — Help section**: New section in the Help page covering cache setup, playback, and troubleshooting for offline use.

### Changed

- **Windows installer — NSIS**: Switched from WiX/MSI to NSIS (`currentUser` install mode). Upgrades install in-place without requiring an uninstall first.
- **Tray icon — removed**: The system tray icon and its menu have been removed. Media keys and OS media controls (added in v1.17.0) make the tray redundant. The "Minimize to tray" setting has been removed accordingly. The app now always exits cleanly on window close.
- **Settings — cache label**: "Max. Image Cache Size" renamed to "Max. Storage Size" to reflect that the limit now covers both image cache and offline tracks.
- **Cover art — fade-in on load**: `CachedImage` now fades album art in (150 ms) instead of popping in abruptly. The image starts transparent and becomes visible once fully loaded, preventing layout flicker on slow connections.
- **Scrollbar auto-hide**: Scrollbar thumbs are hidden when content is not being scrolled and fade in on hover or while actively scrolling. System-style themes (W98, Muma Jukebox, Luna Teal, W3.1, DOS) retain always-visible scrollbars.
- **Help page — two-column layout**: Sections now flow in CSS columns (masonry layout) instead of a rigid two-column grid, making better use of available space.
- **Theme picker — preview corrections**: Updated colour swatches for T-800 (red accent, was cyan), WnAmp (yellow accent, was green), TetraStack (darker navy background), NightCity 2077 (darker blue-tinted background).
- **Theme overhaul — Grand Theft Audio, NightCity 2077**: Detailed per-element styling added — active queue item, hover states, track rows, artist/playlist rows, settings tabs, connection indicators, and more. Both themes are now fully consistent across all UI sections.
- **Theme refinements — Lambda 17, T-800, TetraStack, Muma Jukebox**: Targeted fixes for connection indicators, hover colours, active states, and contrast throughout.

### Fixed

- **AlbumDetail — hero background flicker on hover**: Moving the mouse over songs in the track list caused the blurred hero background to reload on every hover. Moving `hoveredSongId` state into `AlbumTrackList` prevents the parent from re-rendering.
- **AlbumDetail — context menu loses row highlight**: Right-clicking a song caused the hover highlight to disappear. The row now stays highlighted while its context menu is open (`.context-active` pattern — consistent with Queue and Random Mix).
- **Muma Jukebox — hero readability**: The "Album" chip and meta info text below the artist name had insufficient contrast. Both are now legible.
- **Muma Jukebox — waveform colours**: Waveform now uses orange (played) and cyan (buffered) to match the theme's colour scheme.

---

## [1.18.0] - 2026-03-27

### Added

- **Offline Mode *(Beta — tested on CachyOS only)***: Albums can now be cached for offline playback via the new "Cache Offline" button in the album header. Cached albums are accessible in the new **Offline Library** page. On launch without internet, the app automatically navigates there if cached content is available — no blocking overlay. A slim non-blocking banner shows while in offline mode. Offline tracks are removed when clearing the cache.
- **Settings — Cache section improvements**: Live usage display (image cache + offline tracks). Adjustable limit now goes up to 5 GB. When the limit is reached, the oldest image cache entries are evicted automatically (offline albums are not auto-removed). "Clear Cache" button with confirmation removes both image cache and all offline albums.
- **MPRIS — Seek support**: The Plasma (and other MPRIS2-compatible) seekbar now works correctly. Seek and SetPosition events from the OS are forwarded to the audio engine. Position is synced every 500 ms while playing so the OS overlay stays accurate.
- **Lyrics caching**: Fetched lyrics are cached in memory for the session. Switching between Queue and Lyrics tabs no longer re-fetches from lrclib.net.
- **2 New Themes** *(Movies)*:
  - **Barb & Ken** — Barbie dreamhouse universe. Deep magenta dark, polka-dot sidebar, glitter shimmer animation on track name, Ken powder blue for artist name and volume slider.
  - **Toy Tale** — Toy Story. Dark warm toy-chest brown main, Andy's iconic cloud-wallpaper sky-blue sidebar, Woody sheriff-star gold track name, Buzz Lightyear purple for active queue item and volume slider.

### Changed

- **Hero carousel — background crossfade**: The blurred background no longer flickers when switching albums. The last resolved URL is held until the new one is ready, so the old background stays visible until the new one loads.
- **AlbumDetail — Download hint**: Removed the inline hint text from the album header. The explanation (server zips first — may take a moment) is now in the Help FAQ.

### Fixed

- **Performance — Home page scroll**: `AlbumCard` subscribed to two large Zustand record objects (`tracks`, `albums`) per card — 96+ selector calls across a typical home page. Replaced with a single boolean selector per card. Added `React.memo` to prevent re-renders when parent rows reload.
- **Middle Earth theme — active queue item contrast**: Track title was invisible (dark text on dark background). Fixed to bright gold. Tech info bar text also corrected.

---

## [1.17.2] - 2026-03-26

### Fixed

- **Player bar disappears when window is resized small**: On Linux (and some Windows configurations), the window manager ignores the `minHeight` constraint, allowing the window to be dragged smaller than intended. The CSS grid's `1fr` row has an implicit `min-height: auto`, meaning it refuses to shrink below the min-content height of the sidebar/main/queue children — this pushed the total grid height beyond `100vh` and scrolled the player bar out of view. Fixed by adding `min-height: 0` to `.sidebar`, `.main-content`, and `.queue-panel`, and `overflow: hidden` to `.app-shell` as a safety net.
- **Media keys on Windows (SMTC)**: souvlaki's Windows backend requires a valid Win32 HWND to hook into the existing message loop rather than spinning up its own. Passing `hwnd: None` caused a crash on startup (v1.17.0). Now retrieves the main window's HWND via `app.get_webview_window("main").hwnd()` and passes it to `PlatformConfig`. Falls back to disabled gracefully if the HWND cannot be obtained.

---

## [1.17.1] - 2026-03-25

### Fixed

- **Windows crash on startup**: souvlaki SMTC init in `setup()` requires a valid HWND and a running COM message loop, neither of which exists at that point. Media controls are disabled on Windows until init can be properly deferred post-window. All other functionality unaffected.

---

## [1.17.0] - 2026-03-25

### Added

- **Media Keys & OS Media Controls** *(experimental)*: Initial integration via [souvlaki](https://github.com/Sinono3/souvlaki) — MPRIS2 on Linux, Now Playing on macOS, SMTC on Windows. Track metadata (title, artist, album, cover art) and playback state are pushed to the OS media overlay in real time. On Linux, init is skipped gracefully if no D-Bus session is present. This feature is still under active development and observation — behaviour may vary across desktop environments and OS versions.
- **Random Mix — Artist Blacklist**: Artist names are now included in the keyword blacklist filter. Clickable artist chips in the tracklist let you add an artist to the blacklist with one click — same UX as the existing genre chips.
- **Favorites — Remove Song**: Each song row in Favorites now has an inline X button to remove the track from favorites instantly (optimistic UI, server unstar happens in the background).
- **3 New Themes**:
  - *Games*: **Horde** — Durotar blood-red earth, iron-plate sidebar, forge-fire gold glow on track name.
  - *Games*: **Alliance** — Stormwind deep navy, cathedral stone columns, paladin holy-light glow, gold sidebar trim and nav accent.
  - *Operating Systems*: **W11** — Windows 11 Fluent Design dark mode. Mica-style sidebar, clean neutral palette, taskbar-inspired player bar. No gradients — faithful to the minimal Fluent aesthetic.

### Changed

- **Theme renames**: Cobalt Media → **WinMedPlayer**, Onyx Cinema → **P-DVD**, Navy Jukebox → **MuMa Jukebox**.
- **NowPlayingDropdown**: Username / player name row now uses `--text-secondary` for improved readability across all themes.

### Fixed

- **Performance — App-wide interaction lag**: Removed `[data-theme='X'] * { font-family: ... !important }` universal selectors from several themes (DOS, Unix, and others). The browser places universal selectors in the "universal bucket" and checks them against every DOM node on every style recalculation — measurably sluggish with 500–1000+ elements even when the affected theme is not active. `font-family` is now set on the theme root block (inherits to children) with a targeted `button, input, textarea, select` override for elements that don't inherit font.
- **Performance — Scroll jank**: Removed `repeating-linear-gradient` / `repeating-radial-gradient` from `.app-shell` in DOS, Unix, GW1, Morpheus, Aqua Quartz, and others. WebKitGTK with `WEBKIT_DISABLE_COMPOSITING_MODE=1` (always set by the AUR wrapper) has no GPU compositing — fine-pitch repeating patterns on the full-viewport background re-rasterize every scroll frame. Patterns are now applied only to `.sidebar` and `.player-bar`, which never scroll.
- **Contrast — 29 themes**: Audited all themes against WCAG AA. Fixed `--text-muted` and `--text-secondary` values in 29 themes that had insufficient contrast ratios (< 3.5:1). Affects Catppuccin (all four variants), Gruvbox (all six), Nord variants, GW1, Heisenberg, Ice and Fire, Spider-Tech, Morpheus, Hill Valley 85, Dune, and others.

### Removed

- **Theme**: Azerothian Gold removed from the Games group.

---

## [1.16.0] - 2026-03-24

### Added

- **15 New Themes** across multiple categories:
  - *Operating Systems*: **Aqua Quartz** — Mac OS X Aqua (skeuomorphic jelly buttons, brushed aluminium player bar, pinstripe background, blue Source List sidebar, authentic `#3876f7` accent)
  - *Movies*: **Spider-Tech** (Spider-Man navy/red), **T-800** (Terminator Skynet blue), **B-Runner** (Blade Runner 2049 amber), **Hill Valley 85** (Back to the Future)
  - *Games*: **TetraStack** (Tetris 8-bit, cyan, grid background, 0px radii)
  - *Series*: **Turtle Power** (TMNT turtle green, brick tile sidebar)
  - *Social Media* (new group): **Insta** (Instagram dark pink), **ReadIt** (Reddit dark orange-red), **The Book** (Facebook light, blue sidebar)
  - *Operating Systems*: **W3.1** (Windows 3.1, light silver/teal, 0px radii, inset bevels)
  - *Mediaplayer*: **Jayfin** (Jellyfin-inspired — deep black, purple `#AA5CC3` primary, cyan `#00A4DC` secondary, brand gradient on player bar and progress fill)
- **Aqua Quartz — Full Skeuomorphic Polish**: All button variants (`.btn-surface`, `.btn-ghost`, `.hero-play-btn`, `.album-card-details-btn`, `.queue-round-btn`) now have the authentic Aqua jelly gradient. Sidebar sports the iconic blue Source List gradient with white icons and a white pill for the active nav link.

### Changed

- **W98 Theme — Complete Overhaul**: Rebuilt from scratch with authentic Windows 98 design language: correct `#d4d0c8` warm-gray button face (not flat `#c0c0c0`), full 4-layer 3D bevel on all panels and buttons (raised default, sunken on press), song title displays in the iconic navy→light-blue title bar gradient, progress bar is a sunken white trough with navy fill, 16px styled scrollbar, all hover/active states consistently navy `#000080` + white text.
- **Theme Picker — Alphabetical Order**: All theme groups and themes within groups are now sorted alphabetically.
- **Theme Picker — Group Rename**: "Psysonic Themes — Mediaplayer" renamed to "Mediaplayer".
- **Sidebar + Queue Toggle Buttons**: Queue toggle button now uses the theme accent color (icon + hover).

### Fixed

- **AlbumDetail — Genre not propagating**: Playing via the album detail Play All / Enqueue All buttons now correctly includes the track genre in the constructed Track objects, making it show up in the Queue strip.
- **W98 — Theme Accordion active state**: Open category headers are now navy with white text instead of black-on-navy.
- **Aqua Quartz — Sidebar section labels**: "Library" / "System" labels now render in white on the blue sidebar.
- **W98 — Connection indicators**: Server name and Last.fm username in the header are now black (`#000000`) on the warm-gray background for full readability.

### Removed

- **Themes**: Removed **Pandora**, **Order of the Phoenix**, and **Imperial Sith** — too similar to other better-executed themes in their respective groups.

---

## [1.15.0] - 2026-03-23

### Added

- **Queue — Genre · Format · Bitrate Strip**: The meta box above the queue now shows a full-width frosted strip with Genre, audio format, and bitrate (e.g. `Electronic · FLAC · 1411 kbps`). Genre is sourced directly from track metadata and is now propagated through all 11 track construction sites across the codebase.
- **Lyrics — Accent Color Highlight**: The active synced lyrics line is now highlighted in the theme accent color instead of bold+larger text. Eliminates layout jumps caused by the font-weight change pushing lines to wrap.

### Fixed

- **Sidebar — Collapse Button**: The collapse button now correctly sits on the right border of the sidebar, straddling the dividing line between sidebar and main content, and is always visible.

### Changed

- **Queue — Tech Info**: Codec/bitrate badge replaced by the new full-width Genre · Format · Bitrate strip at the top of the meta box.

---

## [1.14.0] - 2026-03-22

### Critical Fixes

- **Prebuffer Flood — 300 simultaneous downloads eliminated**: The audio engine was spawning up to 300 concurrent HTTP download requests during prebuffering, causing network saturation of ~200 Mbit/s and significant CPU load. The root cause was unbounded parallel preload logic in the Rust engine. Fixed: the engine now buffers intelligently with a single controlled preload per track. Network usage dropped to under 100 kbit/s during normal playback.
- **Gapless Playback — fully stable**: Gapless transitions now work correctly end-to-end. Previously, edge cases in the sample-accurate handoff between tracks caused audio glitches or silence between songs.
- **Crossfade — fully stable**: The equal-power crossfade (sin/cos envelope) is now reliable across all track transitions. Previous instability was caused by race conditions in the fade-out trigger and Sink lifecycle management.
- **Now Playing Page — performance**: The Now Playing page no longer causes sustained CPU spikes. Heavy re-renders triggered by frequent `audio:progress` events (previously every 500 ms with wall-clock drift) are resolved — progress is now driven by an atomic sample counter at 100 ms intervals with no layout thrashing.

### Fixed

- **Volume — Clipping at 100%**: Audible distortion at maximum volume eliminated. A `MASTER_HEADROOM` constant of −1 dB (`0.891`) is now applied to all volume calculations, preventing inter-sample peaks from 0 dBFS masters and EQ biquad ripple from clipping.
- **Seek — Display Desync**: Seeking while paused could cause the time display to jump to the new position while audio continued from the old one. `CountingSource::try_seek` now only resets the sample counter after confirming the seek succeeded.
- **Gapless + Crossfade — Mutual Exclusion**: Both modes can no longer be active simultaneously. Enabling one auto-disables the other (Queue toolbar + Settings). Running both simultaneously caused a glitch where Song 2, gapless-chained inside the Sink, would play at full volume after Song 1's crossfade completed.
- **Now Playing — About the Artist**: The "About the Artist" card is now hidden when no biography is available. Artist images that fail to load are silently hidden instead of showing a broken image placeholder.

### Added

- **Waveform — Hover Tooltip**: Hovering over the waveform seekbar shows a floating time label above the cursor. Hidden when no track is loaded or the cursor leaves.
- **Hero & Album Detail — Format Badge**: Audio format (FLAC, MP3, OGG, …) now shown alongside Year, Genre, and Track Count in the hero meta row on the Home page and in the Album Detail header.
- **Help — FLAC Seeking**: New FAQ entry explaining that FLAC files without an embedded SEEKTABLE cannot be seeked, with instructions for adding one via `flac` or `metaflac`.

### Changed

- **Queue — Tech Info**: Codec/bitrate badge moved from the frosted-glass cover overlay into the top-right corner of the meta box. Album artwork is no longer obscured.

---

## [1.13.0] - 2026-03-22

### Added

- **SVG Logo**: The Psysonic wordmark is now an inline SVG with a theme-adaptive gradient (`--accent` → `--ctp-blue`), matching the app's visual identity across all 47 themes. The collapsed sidebar shows a standalone P-icon with the same gradient.
- **Player Bar — Marquee**: Song title and artist name scroll smoothly when the text overflows the fixed-width track info area, pause briefly, then jump back and repeat.
- **Player Bar — Volume Tooltip**: A floating percentage label appears above the volume slider on hover and updates live while dragging.

### Changed

- **Sidebar — Collapse button**: Moved from the brand header to a small circular hover-tab on the right edge of the sidebar. Hidden until you hover over the sidebar, keeping the logo area uncluttered.
- **Player Bar — Layout**: Track info area is now a fixed 320 px width. Waveform section has increased margins on both sides for better visual separation between controls, waveform, and volume.
- **Settings**: Server tab is now the default when opening Settings.
- **Crossfade**: Experimental badge removed — considered stable.
- **Help page**: Added entries for Lyrics, Configurable Keybindings, and Font Picker. Theme count corrected to 47 themes across 7 groups.

### Fixed

- **Global shortcuts — double-fire**: Pressing a global shortcut (e.g. `Ctrl+Alt+→`) was triggering the action twice. Root cause: `on_shortcut()` in `tauri_plugin_global_shortcut` accumulates handlers per shortcut across JS HMR reloads. Fixed with a Rust-side `ShortcutMap` state that makes `register_global_shortcut` idempotent.
- **W98 theme**: Comprehensive contrast fixes across all interactive elements — hover states, buttons, queue items, settings panels, and toggles now use silver-grey (`#e0e0e0`) text on navy (`#000080`) backgrounds.
- **Help page**: Removed orphaned translation key that was rendering as raw text under the Playback section.

### Beta

- **Global Shortcuts** (Settings → Global Shortcuts): System-wide keyboard shortcuts that trigger playback actions while Psysonic is in the background. Functional on all platforms, but edge cases with certain key combinations or OS-level conflicts may still occur.

---

## [1.12.0] - 2026-03-22

### Added

- **Synchronized Lyrics**: Lyrics pane integrated into the Queue sidebar, powered by [LRCLIB](https://lrclib.net) — no API key required. Shows time-synced lyrics with auto-scroll and active-line highlighting; falls back to plain text when synced lyrics are unavailable. Access via the microphone icon in the player bar, fullscreen player, or Now Playing page.

#### 15 New Themes

**Games** (new group — 6 themes):
- **Ascalon**: Dark stone fantasy inspired by Guild Wars 1. Near-black base, gold accent (`#d4af37`).
- **Azerothian Gold**: World of Warcraft inspired. Charcoal base, warm gold accent (`#c19e67`).
- **Grand Theft Audio**: GTA-inspired night city aesthetic. Pure black base, green accent (`#57b05a`).
- **Lambda 17**: Half-Life inspired. Deep blue-black base, amber accent (`#ff9d00`).
- **NightCity 2077**: Cyberpunk 2077 inspired. Near-total black base, neon yellow accent (`#FCEE0A`).
- **V-Tactical**: Battlefield inspired. Gunmetal base, burnt orange accent (`#ff8a00`).

**Series** (new group — 3 themes):
- **A Theme of Ice and Fire**: Game of Thrones inspired. Cold dark navy base, ice blue accent (`#70a1ff`).
- **D'oh-matic**: The Simpsons inspired. Cream/yellow light base, blue accent (`#1F75FE`).
- **Heisenberg**: Breaking Bad inspired. Dark desaturated green base, crystal blue accent (`#3fe0ff`).

**Movies** (2 additions):
- **Imperial Sith**: Star Wars dark side. Pure black base, red accent (`#e60000`).
- **Order of the Phoenix**: Harry Potter inspired. Deep charcoal base, ember-orange accent (`#e63900`).

**Operating Systems** (1 addition):
- **W98**: Windows 98 teal desktop aesthetic. Classic teal background, silver card, navy accent (`#000080`).

### Changed

- **Last.fm integration**: Promoted out of beta — scrobbling, Now Playing, love/unlove, Similar Artists, and top stats are considered stable.
- **Crossfade**: No longer marked experimental. Stable on Windows and Linux; macOS under observation.
- **Gapless playback**: Experimental badge removed — considered stable.
- **Theme picker — groups reorganised**: Catppuccin, Nord, and Retro (Gruvbox) merged into a single **Open Source Classics** group. Streaming themes (Spotless, DZR, Cupertino Beats) moved into **Psysonic Themes — Mediaplayer**. The app now ships **47 themes** across **7 groups**.
- **Tokyo Night themes removed**: `tokyo-night`, `tokyo-night-storm`, and `tokyo-night-light` retired to make room for the new groups.
- **Settings — tab order**: Reordered to Server → Appearance → Playback → Library → Shortcuts → About.
- **Settings — Theme picker**: "Betriebssysteme" group renamed to "Operating Systems".

### Fixed

- **Text selection on double-click**: Double-clicking song titles or anywhere in the UI no longer accidentally selects text. `user-select: none` applied globally; re-enabled for bio/description text areas.
- **Middle Earth theme — star buttons**: Active favourite star in the album tracklist and album header was barely visible (gold on parchment, ~1.4:1 contrast). Both active and inactive states now use darker brown tones with proper contrast.
- **Middle Earth theme — play button hover**: Hovering the primary play/pause button no longer makes the icon invisible (gold icon on gold background).

## [1.11.0] - 2026-03-22

### Added

#### Five New Themes — Movies
- **Middle Earth**: Warm parchment light theme. Cream/beige background, dark ebony player and sidebar, gold accent (`#d4af37`). Georgia serif for track names, subtle noise texture.
- **Morpheus**: Pure black terminal aesthetic inspired by The Matrix. Phosphor green accent (`#00ff41`), monospace font.
- **Pandora**: Deep bioluminescent navy inspired by Avatar. Cyan accent (`#00f2ff`), large radii, glow effects.
- **Stark HUD**: Near-black tactical HUD inspired by Iron Man. Cyan accent, JetBrains Mono, uppercase track name.
- **Blade**: Deep black with blood-red accent (`#b30000`). Sharp radii, uppercase track name.
- All five themes in a new **Movies** group in the theme picker.

### Changed

- **Settings — tab order**: Reordered to Server → Appearance → Playback → Library → Shortcuts → About.
- **Settings — Appearance**: Language selector moved to the top of the tab, above Theme and Font.
- **Settings — Theme picker**: "Betriebssysteme" group renamed to "Operating Systems".
- **Default font**: Changed from Inter to **Lexend** for new installations.
- **Gapless playback**: Experimental badge removed — gapless is now considered stable.
- **Now Playing — background**: Ken Burns animation (40 s, subtle scale + translate). Background blur increased to eliminate JPEG block artefacts at high blur values.
- **Now Playing — Similar Artists**: Tag cloud redesigned into 2 rows with varied font sizes and vertical offsets for a natural look.
- **Statistics**: "Now Playing" indicator rendered as a styled badge matching the app's badge style.

## [1.10.0] - 2026-03-22

### Added

#### Three New Themes (Streaming Series)
- **Spotless**: Flat dark theme inspired by modern music streaming. Pitch-black sidebar (`#000000`), dark-grey app background (`#121212`), Spotify-green accent (`#1ED760`). White play button, green hover on primary actions.
- **DZR**: Flat light theme inspired by Deezer's modern redesign. White base, light-grey sidebar (`#F5F5F7`), purple accent (`#A238FF`). Crisp typography, large rounded radii.
- **Cupertino Beats**: Apple Music-inspired dark theme. Near-black base (`#1c1c1e`), frosted-glass sidebar and player bar with heavy `backdrop-filter`, red accent (`#fa243c`). Active nav links styled with `accent-dim` background.
- All three themes added to the **Psysonic Themes — Mediaplayer** group in the theme picker.

### Fixed

- **Favourite/Unfavourite toggle**: Right-clicking a song, album, or artist that is already starred now shows "Remove from Favourites" and calls `unstar()` correctly. Previously always showed "Add to Favourites" regardless of starred state.
  - `Track` interface gained `starred?: string` — propagated via `songToTrack()` and all inline track-object construction sites.
  - `starredOverrides: Record<string, boolean>` added to `playerStore` — updated immediately on star/unstar so the context menu and tracklist star icons reflect changes without a page reload.
- **Home page — Artist Discovery**: Replaced card grid (which loaded artist images and caused performance issues) with lightweight pill-buttons — same `artist-ext-link` style as the "Similar Artists" section on artist pages. No image loading, instant render.
- **Now Playing page**: Queue sidebar is no longer automatically hidden when entering the Now Playing page. It now behaves like all other pages and respects the user's current queue visibility setting.
- **Random Mix filter panel**: Background now correctly uses `--bg-card` instead of the undefined `--bg-elevated` token, which caused the panel to render transparent in most themes.

### Changed

- **Home page layout**: Section order is now: Recently Added → Discover → Artist Discovery → Starred → Most Played.

## [1.9.0] - 2026-03-21

### Added

#### Three New Themes
- **Neon Drift**: Deep midnight-blue background (`#12132c`) with electric cyan accent (`#00f2ff`) — subtle synthwave/cyberpunk aesthetic. Glowing player track name, cyan-glow nav active state, neon-lit primary buttons, glowing range slider thumb.
- **Cupertino Light**: macOS Ventura-inspired light theme. Clean white base, Apple-grey sidebar (`#f2f2f7`), Apple blue accent (`#0071e3`). Frosted-glass sidebar and player bar with `backdrop-filter: blur`. Solid blue pill nav active (white text, no left border).
- **Cupertino Dark**: macOS Ventura-inspired dark theme. Space Grey base (`#1e1e1f`), dark frosted sidebar, vibrant blue accent (`#007aff`). Same pill nav active as Cupertino Light. Solid blue Play/Pause button with glow.

#### New Theme Group: Betriebssysteme
- OS-aesthetic themes are now consolidated into one group: **Cupertino Light**, **Cupertino Dark**, **Aero Glass**, **Luna Teal**.
- **Psysonic Themes** and **Psysonic Themes — Mediaplayer** moved to the top of the theme picker.

#### Configurable Keybindings
- New `keybindingsStore` with 10 bindable actions: Play/Pause, Next, Previous, Volume Up/Down, Seek ±10 s, Toggle Queue, Fullscreen Player, Native Fullscreen.
- Rebind any action in **Settings → Keybindings** — click the key badge, press any key, saved immediately to `localStorage`.
- Defaults: `Space` = Play/Pause, `F11` = Native Fullscreen. All other actions unbound by default.

#### Font Picker
- 10 UI fonts selectable in **Settings → Appearance**: Inter, Outfit, DM Sans, Nunito, Rubik, Space Grotesk, Figtree, Manrope, Plus Jakarta Sans, Lexend.
- Persisted in `localStorage` (`psysonic_font`), applied via `data-font` attribute on `<html>`.

#### Home Page — Instant Play
- **Album cards**: "Details" button replaced with a **Play** button — clicking plays the album immediately with a smooth 700 ms fade-out of the current track.
- **Hero**: "Play Album" button now starts playback directly (with fade-out) instead of navigating to the album detail page.
- Fade-out implemented via `playAlbum.ts` utility: fades volume to 0 over 700 ms, restores volume in the store (no Rust side-effect) before handing off to `playTrack`.

#### Now Playing Page — Layout & Readability
- **3-column hero layout**: album cover + info (left, `flex: 1`) — EQ bars (centre, fixed width) — tag cloud (right, `flex: 1`). EQ bars are now truly centred regardless of content length on either side.
- **Background**: increased brightness from `0.25` to `0.55`, reduced overlay opacity from `0.55` to `0.38` — background art is now visible instead of near-black.
- **Text contrast**: track times, card links (artist/album), and section title opacity all increased for better readability on the blurred background.

### Changed

#### Theme Renames — Trademark-Safe Names
All media-player and OS-themed theme IDs and labels have been renamed to avoid potential trademark conflicts:

| Old Name | New Name |
|---|---|
| Classic Winamp | WnAmp |
| Musicmatch Jukebox | Navy Jukebox |
| WMP8 Classic | Cobalt Media |
| PowerDVD Classic | Onyx Cinema |
| Win7 Aero | Aero Glass |
| WinXP Luna | Luna Teal |

> **Note**: If you had one of these themes selected, your preference will reset to Mocha on first launch. Re-select your preferred theme in Settings.

### Fixed

- **Linux — ALSA underruns**: `PIPEWIRE_LATENCY` (`4096/48000` ≈ 85 ms) and `PULSE_LATENCY_MSEC` (`85`) are now set before audio stream creation, reducing the frequency of ALSA `snd_pcm_recover` underrun events on PipeWire systems. Existing user-set values are respected.

---

## [1.8.0] - 2026-03-21

### Added

#### Three New Themes
- **Poison**: Dark charcoal background (`#1a1a1a`) with phosphor green (`#1bd655`) accent — high-contrast, industrial aesthetic. LCD glow text-shadow on the now-playing track name.
- **Nucleo**: Warm brass/cream light theme inspired by vintage hi-fi equipment. Warm white cards, gold/amber accents, brushed-metal bevel buttons, and a warm LCD glow on the player track name. `color-scheme: light`.
- **Classic Winamp**: Cool gray-blue dark theme (`#2b2b3a`) channelling the classic Winamp 2.x skin. Yellow primary accent (`#d4cc46`), orange volume slider override (`--volume-accent: #de9b35`), Courier New monospace font with bright-green LCD glow for the track name.

#### Psychowave Theme — Major Overhaul
- Psychowave recoloured from loud neon pink/purple to a refined deep violet palette: background `#161428`, accent `#a06ae0`. All neon colours replaced with muted, tasteful variants. No longer marked as WIP.

#### ThemePicker Redesign
- Themes reorganised into semantic groups: **Catppuccin**, **Nord**, **Retro** (formerly Gruvbox), **Tokyo Night**, and a new **Psysonic Themes** section (Classic Winamp, Poison, Nucleo, Psychowave). The separate *Experimental* group is removed.
- "Gruvbox" renamed to **Retro**.

#### Image Lightbox
- Clicking the **album cover** on an Album Detail page or the **artist avatar** on an Artist Detail page opens a full-screen lightbox showing the high-resolution image (up to 2000 px). Click outside or press Escape to close.
- Both use a shared `CoverLightbox` component — consistent behaviour across the app.

#### Queue Toolbar — Complete Redesign
- The queue panel now has a **centred icon toolbar** with round buttons (border-radius 50%, solid accent fill when active):
  - **Shuffle** — Fisher-Yates shuffle, keeps current track at position 0
  - **Save** — save queue as playlist
  - **Load** — load a playlist into the queue
  - **Clear** — remove all tracks from the queue
  - **Gapless** (∞ icon) — toggle gapless playback on/off
  - **Crossfade** (≋ icon) — toggle crossfade on/off; when inactive, clicking enables crossfade *and* opens a popover slider
- **Crossfade popover**: a small overlay below the Crossfade button with a range slider (1–10 s) to configure the fade duration. Clicking the active Crossfade button disables crossfade and closes the popover. Closes on outside click.
- **Queue header**: title enlarged to 16 px/700, track count and total duration shown inline next to the title in accent colour. Close (×) button removed.
- **Tech info overlay**: codec and bitrate displayed as a frosted glass badge (`backdrop-filter: blur(4px)`) overlaid on the bottom edge of the cover art image.

#### French & Dutch Translations
- Full UI translation added for **French** (`fr`) and **Dutch** (`nl`) — all namespaces covered.
- Language selector in Settings now lists all four languages sorted alphabetically (Dutch, English, French, German).

#### Help Page — Layout & Content Update
- **2-column grid layout** for the accordion — makes better use of horizontal space on widescreen displays.
- New Q&A entry: **Crossfade & Gapless** (Playback section) — explains what each feature does, how to enable them, and their experimental status.
- Updated entries: Themes (reflects all 21 themes), Languages (4 languages), Scrobbling (direct Last.fm), System browser links, Linux distribution (no AppImage).

#### Settings — Experimental Labels
- Crossfade and Gapless toggles in Settings → Playback now show an **"Experimental"** badge next to their label.

### Fixed

- **Now Playing dropdown — refresh button**: The refresh icon spin was applied to the entire button, blocking clicks during the animation. Spin state is now separate from the background poll loading state — the button is always clickable, and the icon spins for a minimum of 600 ms for clear visual feedback.
- **Crossfade popover positioning**: Popover was overflowing the right edge of the viewport. Now right-aligned relative to the Crossfade button and positioned below it.

---

## [1.7.2] - 2026-03-20

### Fixed

- **Last.fm**: Stability improvements for the authentication flow and session handling.
- **Settings**: Minor display fixes in the Last.fm profile badge.

---

## [1.7.1] - 2026-03-20

### Fixed

- **Build**: TypeScript errors in Settings.tsx and Statistics.tsx that broke the release build.

---

## [1.7.0] - 2026-03-20

### Added

#### Last.fm Integration *(Beta)*
- **Direct Last.fm scrobbling**: Tracks are scrobbled directly via the Last.fm API at 50% playback — no longer routed through Navidrome. Configure in Settings → Server with your Last.fm username and password.
- **Now Playing updates**: Last.fm receives the currently playing track in real time.
- **Love / Unlove**: Heart button in the Now Playing page and player bar syncs the loved state with Last.fm instantly.
- **Last.fm profile badge** in Settings → Server: shows your scrobble count and member since year once connected.
- ⚠️ **This feature is in beta.** Session management and edge cases are still being refined.

#### Similar Artists
- Artist detail pages now show a **Similar Artists** section below Top Tracks, sourced from Last.fm and filtered to artists actually present in your library. Shown as chip buttons — click to navigate directly to that artist's page.
- Requires Last.fm to be configured. Hidden when Last.fm is not connected or no library matches are found.

#### Statistics — Last.fm Stats
- New **Last.fm Stats** section on the Statistics page (requires Last.fm): top artists, albums, and tracks with proportional play-count bars.
- **Period filter**: switch between Last 7 Days, 1 Month, 3 Months, 6 Months, 12 Months, and Overall.
- **Recent Scrobbles**: last 20 scrobbled tracks with relative timestamps and a "Now Playing" badge for the currently active entry.
- **Genre Distribution removed**: replaced by the Last.fm stats sections.

#### Psychowave Theme *(Work in Progress)*
- New **Psychowave** theme: a deep purple/violet dark theme inspired by synthwave and retrowave aesthetics.
- ⚠️ **Still in active development** — colors and details will continue to be refined in upcoming releases.

#### Tooltip System — TooltipPortal
- All tooltips now use a **React portal** rendered into `document.body` at `z-index: 99999`. Replaces the previous CSS `::after` pseudo-element system.
- Fixes tooltip clipping inside `overflow: hidden` containers (player bar, queue panel, EQ).
- Fixes black OS-native tooltip boxes that appeared on native `title=` attributes — all converted to `data-tooltip`.
- Smart edge detection: tooltip flips position automatically when it would overflow the viewport.

#### Custom Select Dropdowns
- **Theme**, **Language**, and **EQ preset** selectors are now rendered as styled portal dropdowns — no more unstyled native `<select>` boxes.
- Supports option groups (EQ: Built-in Presets / Custom Presets), keyboard navigation, and click-outside-to-close.

### Changed

#### Fullscreen Player / Now Playing — Background
- **Ken Burns animation improved**: background image now has significantly more movement (±8% translate, `inset: -30%`) with a 90-second cycle — more cinematic without being distracting.
- **Color orbs removed** from both the Fullscreen Player and the Now Playing page. They caused noticeable GPU load especially on integrated graphics.

### Fixed

- **Live dropdown (Now Playing)**: Own playback was no longer reported to Navidrome after the Last.fm implementation removed the `reportNowPlaying` call. Both are now called independently on track start.
- **Sidebar: Now Playing button position when collapsed**: The button was appearing in the middle of the nav instead of just above the System section. Caused by a leftover `margin-top: auto` on the Statistics link that split the remaining flex space.

---

## [1.6.0] - 2026-03-19

> ⚠️ **Wichtiger Hinweis / Important Notice**
>
> **DE:** Der Bundle-Identifier der App wurde von `dev.psysonic.app` auf `dev.psysonic.player` geändert. **Alle gespeicherten Einstellungen (Server-Profile, Theme, EQ, Sprache usw.) gehen beim Update auf diese Version einmalig verloren** und müssen neu eingetragen werden. Zukünftige Updates sind davon nicht betroffen.
>
> **EN:** The app's bundle identifier has changed from `dev.psysonic.app` to `dev.psysonic.player`. **All saved settings (server profiles, theme, EQ, language, etc.) will be reset once when updating to this version** and need to be re-entered. Future updates are not affected.

### Added

#### Replay Gain
- **Replay Gain support** in the Rust audio engine. Gain and peak values from the Subsonic API are applied per-track at playback time, keeping loudness consistent across your library.
- Two modes selectable in Settings → Playback: **Track** (default) and **Album** gain.
- Peak limiting applied to prevent clipping: effective gain is capped at `1 / peak`.
- Volume slider preserves the gain ratio — `audio_set_volume` multiplies `base_volume × replay_gain_linear`.

#### Crossfade
- **Crossfade between tracks** (0.5 – 12 s, configurable in Settings → Playback).
- Old sink is volume-ramped to zero in 30 steps while the new track starts playing; old sink stored in `fading_out_sink` so a subsequent skip cancels the fade-out immediately.
- `audio_set_crossfade` Tauri command; synced to Rust on startup and on toggle.

#### Gapless Preloading *(Experimental — Alpha)*
- **Gapless playback**: when ≤ 30 s remain in the current track, the next track's audio is preloaded via `audio_preload` in the background.
- `audio_play` checks the preload cache first — if there is a URL match the download is skipped entirely, eliminating the gap between tracks.
- The old Sink is kept alive during the new track's download and decode phase; the Sink swap happens atomically after decoding is complete, fixing a subtle **start-of-track audio cut** that occurred regardless of gapless state.
- ⚠️ **This feature is experimental and still in active development.** It may not work correctly in all scenarios. Enable it in Settings → Playback at your own discretion.

#### Settings — Tab Navigation
- Settings reorganised into **5 horizontal tabs**: Playback, Library, Appearance, Server, About.
- Each tab groups related settings with a matching icon.

#### Artist Pages — "Also Featured On"
- Artist detail pages now show an **"Also Featured On"** section listing albums where the artist appears as a guest or featured performer (but is not the primary album artist).
- Implemented via `search3` filtered by `song.artistId`, excluding the artist's own albums.

#### Download Folder Modal
- When no download folder is configured and the user initiates a download (album or track), a **folder picker modal** now appears asking where to save.
- Includes a "Remember this folder" checkbox that writes the choice to Settings.
- Clear button added in Settings → Server to reset the saved download folder.

#### Changelog in Settings
- The full **Changelog** is now readable inside the app under Settings → About.
- Rendered as collapsible version entries; the current version is expanded by default.
- Inline Markdown (`**bold**`, `*italic*`, `` `code` ``) is rendered natively.

#### EQ as Player Bar Popup
- The Equalizer is now accessible directly from the **player bar** via a small EQ button, opening as a centred popup overlay — no need to navigate to Settings.

### Fixed

- **Bundle identifier warning**: changed `identifier` from `dev.psysonic.app` to `dev.psysonic.player` to avoid the macOS `.app` extension conflict warned by Tauri.
- **Version mismatch in releases**: `tauri.conf.json` version was out of sync with `package.json` and `Cargo.toml`, causing GitHub Actions to build release artefacts with the wrong version number. All four version sources (`package.json`, `Cargo.toml`, `tauri.conf.json`, `packages/aur/PKGBUILD`) are now kept in sync.

### Known Issues

- **FLAC seeking**: jumping to a position in a FLAC file via the waveform seekbar currently does not work. Seeking in MP3, OGG, and other formats is unaffected.

---

## [1.5.0] - 2026-03-18

### Added

#### 10-Band Graphic Equalizer
- Full **10-band graphic EQ** implemented entirely in the Rust audio engine using biquad peak filters (31 Hz – 16 kHz). Gains adjustable ±12 dB per band.
- EQ is processed in the audio pipeline via `EqSource<S>` — a custom `rodio::Source` wrapper that applies cascaded biquad filters in real-time.
- Filter coefficients update smoothly on every 1024-sample block without audio interruption.
- **Seek support**: `EqSource::try_seek()` implemented — filter state is reset on seek to prevent clicks/artefacts. This also **fixes waveform seek**, which had silently broken when the EQ was introduced (rodio returned `SeekError::NotSupported` without the impl).
- **10 built-in presets**: Flat, Bass Boost, Treble Boost, Rock, Pop, Jazz, Classical, Electronic, Vocal, Acoustic.
- Custom presets: save, name, and delete your own presets.
- EQ state persisted via `psysonic-eq` localStorage key (gains, enabled, active preset, custom presets).
- New `audio_set_eq` Tauri command; settings synced to Rust on startup via `eqStore.syncToRust()`.

#### Connection Indicator
- **LED indicator** in the header bar (green = connected, red = disconnected, pulsing = checking). Sits between the search bar and the Now Playing dropdown.
- Shows server name and LAN/WAN status next to the LED.
- **Offline overlay**: when the server is unreachable, a full-content-area overlay appears with a retry button.
- `useConnectionStatus` hook pings the active server periodically and exposes `status`, `isRetrying`, `retry`, `isLan`, and `serverName`.

#### Now Playing Page
- New `/now-playing` route and `NowPlayingPage` component — accessible from the sidebar.

### Fixed

#### Waveform Seek (Player Bar)
- **Drag out of canvas no longer breaks seeking**: `mousemove` and `mouseup` events are now registered on `window` (not the canvas element), so dragging fast across other elements still updates playback position correctly.
- **Stale closure fix**: `trackId` and `seek` function are kept in refs so the window-level handlers always see the current values.

### Changed

#### App Icon
- New app icon (`public/logo-psysonic.png`) across all platforms — Login page, Sidebar, Settings About section, README header, and all generated Tauri platform icons (Windows ICO, macOS ICNS, Linux PNGs, Android, iOS).

## [1.4.5] - 2026-03-17

### Changed

#### Artist Pages — External Links
- Last.fm and Wikipedia buttons now open in the **system browser** instead of an in-app window. The button label temporarily changes to "Opened in browser" / "Im Browser geöffnet" for 2.5 seconds as visual confirmation.

#### Queue Panel
- **Release year** added to the now-playing meta box, shown below the album name (when available).
- **Cover art enlarged** from 72 × 72 px to 90 × 90 px, aligned to the top of the meta block so it lines up with the song title.
- **Default width increased** from 300 px to 340 px.

## [1.4.4] - 2026-03-17

### Added

#### AUR Package
- Psysonic is now available on the **Arch User Repository** — Arch and CachyOS users can install via `yay -S psysonic` or `paru -S psysonic`. Builds from source using the system's own WebKitGTK, avoiding the EGL/Mesa compatibility issues that affected the AppImage on modern distros.

### Changed

#### App Icon
- New app icon across all platforms (Windows, macOS, Linux, Android, iOS).

#### Linux Distribution
- **AppImage removed**: The AppImage was fundamentally incompatible with non-Ubuntu distros (Arch, Fedora) due to bundled WebKitGTK conflicting with the system's Mesa/EGL. Linux users should use the `.deb` (Ubuntu/Debian), `.rpm` (Fedora/RHEL), or the new AUR package (Arch/CachyOS).

## [1.4.3] - 2026-03-16

### Fixed

#### Random Mix — Genre Mix
- **Second "Play All" button removed**: The genre mix section had a redundant play button below the super-genre selector. The top-right button is now context-aware — it plays the genre mix when one is active, otherwise the regular mix.
- **"Play All" disabled during genre mix loading**: The button now stays grayed out with a live progress counter (`n / 50`) until all songs are fully loaded. Clicking while the list was still building sent only the songs loaded so far.
- **Over-fetching fixed**: Genre mix previously fetched up to 100+ songs and sliced to 50 at the end. Now the matched genre list is capped at 50 (randomly sampled when more match) so the total fetch stays close to 50 with no wasted server I/O.
- **Regular mix cache-busting**: `getRandomSongs` requests now include a timestamp parameter, preventing browser/axios from returning a cached response and showing the same list on every remix.
- **Display/state mismatch on remix**: Clicking "Mischen" now clears the current list immediately, ensuring the spinner is shown and the displayed songs always match what "Play All" would send.

#### Queue Panel
- **Hover highlight lost on right-click**: Queue items now retain their hover highlight while a context menu is open for them (`.context-active` CSS class).
- **Song count and total duration**: The queue header now shows the number of tracks and total runtime below the title (e.g. `12 tracks · 47:32`).

#### Context Menu
- **"Favorite" option added for queue items**: Right-clicking a queue item now includes a "Favorite" option, consistent with the song context menu.

## [1.4.2] - 2026-03-16

### Fixed

#### Linux AppImage — Modern Distro Compatibility
- **Build upgraded to Ubuntu 24.04**: The AppImage was previously built on Ubuntu 22.04 with WebKitGTK 2.36. On modern distros (CachyOS, Arch, etc.) with Mesa 25.x, `eglGetDisplay(EGL_DEFAULT_DISPLAY)` returns `EGL_BAD_PARAMETER` and aborts immediately because newer Mesa no longer accepts implicit platform detection. Building on Ubuntu 24.04 bundles WebKitGTK 2.44 which uses the correct `eglGetPlatformDisplay` API.
- **`EGL_PLATFORM=x11` added to AppRun**: Additional safeguard that explicitly tells Mesa's EGL loader to use the X11 platform when the app is running under XWayland.

#### Shell — Update Link
- `shell:allow-open` capability now includes a URL scope (`https://**`), fixing the update toast link that silently did nothing in Tauri v2 without an explicit allow-list.

## [1.4.1] - 2026-03-16

### Fixed

#### Random Albums — Performance & Memory
- **Auto-refresh removed**: The 30-second auto-cycle timer caused 10 React state updates/second (progress bar interval) and a burst of 30 concurrent image fetches on every tick, eventually making the whole app unresponsive. The page now loads once on mount; use the manual refresh button to get a new selection.
- **Concurrent fetch limit**: Image fetches are now capped at 5 simultaneous network requests (was unlimited — 30 at once on every refresh).
- **Object URL memory leak**: The in-memory image cache now caps at 150 entries and revokes old object URLs via `URL.revokeObjectURL()` when evicting. Previously, object URLs accumulated without bound across the entire session.
- **Dangling state updates**: `useCachedUrl` now uses a cancellation flag — if a component unmounts while a fetch is in flight (e.g. during a grid refresh), the resolved URL is discarded instead of calling `setState` on an unmounted component.

#### i18n
- Page title "Neueste" on the New Releases page was hardcoded German. Now uses `t('sidebar.newReleases')`.

## [1.4.0] - 2026-03-16

### Added

#### Statistics Page — Upgraded
- **Library overview**: Four stat cards at the top showing total Artists, Albums, Songs, and Genres — counts derived from the library in parallel.
- **Recently Played**: Horizontal scroll row showing the last played albums with cover art.
- **Most Played**: Ranked list of the most frequently played tracks.
- **Highest Rated**: List of top-rated tracks by user star rating.
- **Genre Chart**: Visual bar chart of the top genres by song and album count.

#### Playlists Page — Redesigned
- Replaced the card grid with a clean list layout.
- **Sort buttons**: Sort by Name, Tracks, or Duration — click again to toggle ascending/descending.
- **Filter input**: Live search across playlist names.
- Play and delete buttons appear on row hover.

#### Favorites — Songs Section Upgraded
- Tracks now display in a full tracklist layout matching Album Detail: separate `#`, Title, Artist, and Duration columns with a header row.
- Artist name is clickable and navigates to the artist page.
- Right-click context menu on any track (Go to Album, Add to Queue, etc.).
- **"Add all to queue"** button (`btn btn-surface`) next to the section title.

#### Context Menu — Go to Album
- New **Go to Album** option (`Disc3` icon) added for `song` and `queue-item` context menu types.
- Only shown when the song has a known `albumId`.

#### Queue Panel — Meta Box
- Now shows: **Title** (no link) → **Artist** (linked to artist page) → **Album** (linked to album page).
- Removed year display and the old title→album link.

#### Random Mix — Hover Persistence
- Track row stays highlighted while its context menu is open via `.context-active` CSS class.
- Highlight is cleared automatically when the context menu closes.

#### Artist Cards — Redesigned
- `ArtistCardLocal` now matches `AlbumCard` exactly: no padding, full-width square cover via `aspect-ratio: 1`, name and meta below.
- Uses `CachedImage` with `coverArtCacheKey` for proper IndexedDB caching.
- Same `flex: 0 0 clamp(140px, 15vw, 180px)` sizing as album cards — artist cards are no longer oversized.

### Fixed

#### Random Albums — Cover Loading & Manual Refresh
- **Removed `renderKey`**: The album grid was fully remounted on every refresh, restarting all 30 IndexedDB image lookups from scratch. Grid is now stable — only data changes, images stay cached.
- **`loadingRef` guard**: Prevents concurrent fetch calls if the auto-cycle timer fires during a manual refresh.
- **Timer race condition**: Manual refresh now calls `clearTimers()` before `load()`, eliminating the race where the auto-cycle timer fired mid-load.

#### Favorites — Artist Navigation
- Arrow nav buttons in the Artists section now use the same CSS classes as the Albums section (`album-row-section`, `album-row-header`, `album-row-nav`) — consistent styling across both rows.

### Changed
- **AlbumDetail** refactored into a thin orchestrator. Logic extracted into `AlbumHeader` (`src/components/AlbumHeader.tsx`) and `AlbumTrackList` (`src/components/AlbumTrackList.tsx`).
- **German i18n**: "Queue" consistently translated as "Warteschlange" throughout — `queue.shuffle`, `favorites.enqueueAll`.

## [1.3.0] - 2026-03-15

### Added

#### Player Bar — Complete Redesign
- **Waveform seekbar**: Replaces the classic thin slider. A canvas-based waveform with 500 deterministic bars (seeded by `trackId`) fills the full available width. Played portion renders as a blue → mauve gradient with a soft glow; buffered range is slightly brighter; unplayed bars are dimmed to 28% opacity. Click or drag anywhere to seek.
- **New layout**: Single flex row — `[Cover + Track Info] [Transport Controls] [Waveform + Times] [Volume]`. More breathing room for the waveform; controls feel lighter and better proportioned.
- **Queue toggle relocated**: Moved from the bottom player bar to the top-right of the content header — consistent with the sidebar collapse button pattern. Uses `PanelRightClose` / `PanelRight` icons (same family as `PanelLeftClose` / `PanelLeft` in the sidebar).

#### Ambient Stage — MilkDrop Visualizer
- **Butterchurn integration**: Clicking the waveform icon (top-right of the fullscreen player) activates the MilkDrop visualizer powered by [butterchurn](https://github.com/jberg/butterchurn) + `butterchurn-presets`.
- A hidden `<audio>` element is routed through the Web Audio API `AnalyserNode` (not connected to `AudioDestinationNode` — completely silent). The Rust/rodio engine continues to handle actual audio output.
- Starts with a random preset; the shuffle button cycles through all available presets with a 2-second blend transition. Current preset name is shown in the top bar.
- When the visualizer is active, the blurred background, orbs, and overlay are replaced by the canvas.

#### Tracklist — Animated Equalizer Indicator
- The currently **playing** track shows three animated equalizer bars (CSS `scaleY` keyframe animation, staggered timing) instead of a static play icon.
- When **paused**, the static play icon is shown.
- Hovering any other track still shows a play icon.
- Track row alignment fixed: `align-items: center` on the grid row + `.track-num` as flex center — icons and track numbers are now perfectly vertically aligned with the song title.

#### Artist Pages — In-App Browser
- Last.fm and Wikipedia buttons now open a native **Tauri `WebviewWindow`** (1100 × 780, centered) instead of the system browser. Both sites load fully within the app and can be closed independently.
- Required new capabilities: `core:window:allow-create`, `core:webview:allow-create-webview-window`.

#### Update Checker
- Update check now runs **every 10 minutes** during runtime in addition to the initial check 1.5 s after launch.
- Version label in the update toast no longer includes a `v` prefix (shows `1.3.0` instead of `v1.3.0`).

#### Help Page
- New **Random Mix** section: explains the random mix, keyword filter, and super genre mix.
- Updated **Playback** section: waveform seekbar, MilkDrop visualizer, queue shuffle.
- Updated **Library** section: in-app browser for artist links.
- Updated queue entry to reflect the new toggle location.
- **Accordion styling**: open question and answer share a continuous 3 px accent stripe on the left; answer background uses `--bg-app` for clear contrast against the question's `--bg-card`.

### Fixed
- **Version in Settings** was hardcoded to `1.0.12`. Now imported from `package.json` at build time — same source as the sidebar update checker.
- **Hero / Discover duplicate albums**: Both sections previously fetched `random` independently, often showing the same albums. Now a single request fetches 20; `slice(0, 8)` goes to the Hero carousel and `slice(8)` to the Discover row.
- **Active track pulse too aggressive**: Changed from a `background: transparent` flash to a gentle `opacity: 0.6` fade over 3 s — significantly less distracting.

### Changed
- **Blacklist → Keyword Filter**: Renamed throughout UI and i18n (EN + DE) to better reflect that the filter matches genre, title, and album fields — not just genre tags.

## [1.2.0] - 2026-03-15

### Added

#### Rust Audio Engine (replaces Howler.js)
- **New native audio backend** built in Rust using [rodio](https://github.com/RustAudio/rodio). Audio is now decoded and played entirely in the Tauri backend — no more reliance on the WebView's `<audio>` element or GStreamer pipeline quirks.
- Tauri commands: `audio_play`, `audio_pause`, `audio_resume`, `audio_stop`, `audio_seek`, `audio_set_volume`.
- Frontend events: `audio:playing` (with duration), `audio:progress` (every 500 ms), `audio:ended`, `audio:error`.
- Generation counter (`AtomicU64`) ensures stale downloads from skipped tracks are cancelled immediately and do not emit events.
- Wall-clock position tracking (`seek_offset + elapsed`) instead of `sink.empty()` (unreliable in rodio 0.19 for VBR MP3). `audio:ended` fires after two consecutive ticks within 1 second of the track end — avoids false positives near the end without adding latency.
- Seek via `sink.try_seek()` — no pause/play cycle, no spurious `ended` events.
- Volume clamped to `[0.0, 1.0]` on every call.

#### Playback Persistence & Cold-Start Resume
- `currentTrack`, `queue`, `queueIndex`, and `currentTime` are now persisted to `localStorage` via Zustand `partialize`.
- On app restart with a previously loaded track, clicking Play resumes from the saved position without losing the queue.
- Position priority: server play queue position (if > 0) takes precedence over the locally saved value, so cross-device resume works correctly.

#### Random Mix — Genre Filter & Blacklist
- **Exclude audiobooks & radio plays** toggle: filters out songs whose genre, title, or album match a hardcoded list (`Hörbuch`, `Hörspiel`, `Audiobook`, `Spoken Word`, `Podcast`, `Krimi`, `Thriller`, `Speech`, `Fantasy`, `Comedy`, `Literature`, and more).
- **Custom genre blacklist**: add any genre keyword via the collapsible chip panel on the Random Mix page or in Settings → Random Mix. Persisted across sessions.
- **Clickable genre chips** in the tracklist: clicking an unblocked genre tag adds it to the blacklist instantly with 1.5 s visual feedback. Blocked genres are shown in red.
- Blacklist filter checks `song.genre`, `song.title`, and `song.album` to catch mislabelled tracks.

#### Random Mix — Super Genre Mix
- Nine pre-defined **Super Genres** (Metal, Rock, Pop, Electronic, Jazz, Classical, Hip-Hop, Country, World) appear as buttons, auto-generated from the server's genre list — only genres with at least one matching keyword are shown.
- Selecting a Super Genre fetches up to 50 songs distributed across all matched sub-genres in parallel, then shuffles the result.
- **Progressive rendering**: the tracklist appears as soon as the first genre request returns — users with large Metal/Rock libraries no longer stare at a spinner for the entire fetch. A small inline spinner next to the title indicates that more genres are still loading.
- **"Load 10 more"** button: fetches 10 additional songs from the same matched genres and appends them to the play queue.
- Random playlist is automatically hidden while a Genre Mix is active.
- Fetch timeout raised to **45 seconds** per genre request (was 15 s) and `Promise.allSettled` used so a single slow/failing genre does not abort the entire mix.

#### Queue Panel
- **Shuffle button** in the queue header: Fisher-Yates shuffles all queued tracks while keeping the currently playing track at position 0. Button is disabled when the queue has fewer than 2 entries.

#### UI / UX
- **LiveSearch keyboard navigation**: arrow keys navigate the dropdown, Enter selects the highlighted item or navigates to the full search results page, Escape closes the dropdown.
- **Multi-line tooltip support**: add `data-tooltip-wrap` attribute to any element with `data-tooltip` to enable line-wrapping (uses `white-space: pre-line` + `\n` in the string). Respects a 220 px max-width.
- **Genre column info icon** in Random Mix tracklist header: hover tooltip explains the clickable-genre-to-blacklist feature.
- **Update link** in the sidebar now uses Tauri Shell plugin `open()` to launch the system browser correctly — `<a target="_blank">` has no effect inside a Tauri WebView.

### Fixed
- **Songs skipping immediately** (root cause: Tauri v2 IPC maps Rust `snake_case` parameters to **camelCase** on the JS side — `duration_hint` must be `durationHint`). All `invoke()` calls updated.
- **Play button doing nothing after restart**: `currentTrack` was `null` after restart (not persisted). Fixed by adding it to `partialize`.
- **Position not restored after restart**: `initializeFromServerQueue` overwrote the local saved position with the server value even when the server reported 0. Now falls back to the localStorage value when the server position is 0.
- **Genre Mix blank on Metal/Rock**: a single timed-out genre request caused `Promise.all` to reject the entire mix. Replaced with `Promise.allSettled` + 45 s timeout; partial results are shown immediately.
- **Tooltip z-index**: tooltips in the main content area were rendered behind the queue panel. Fixed by giving `.main-content` `z-index: 1`, establishing a stacking context above the queue (which sits later in DOM order).
- **Sidebar title clipping**: "Psysonic" brand text was truncated at narrow viewport widths. Minimum sidebar width raised from 180 px to 200 px.

### Changed
- **Audio architecture**: Howler.js removed. All audio state (`isPlaying`, `isAudioPaused`, `currentTime`, `duration`) is now driven by Tauri events from the Rust engine rather than Howler callbacks.
- **Random Mix layout**: Filter/blacklist panel and Genre Mix buttons are now combined in a two-column card at the top of the page instead of being scattered across the page.
- **Hardcoded genre blacklist** extended with: `Fantasy`, `Comedy`, `Literature`.
- **`getRandomSongs`** now accepts an optional `timeout` parameter (default 15 s) so callers can pass a longer value for large-library scenarios.

## [1.0.12] - 2026-03-14

### Fixed
- **Seek Stop Bug**: Clicking the progress bar a second time no longer stops playback. Root cause: WebKit and GStreamer fire spurious `ended` events immediately after a direct `audioNode.currentTime` seek. A guard now checks `lastSeekAt` + playhead position to silently discard these false alarms.
- **Play/Pause Hang**: Rapidly double-clicking the play/pause button no longer freezes the audio pipeline. A 300 ms lock prevents a second toggle from issuing `pause→play` before GStreamer has finished the previous state transition.
- **Queue DnD (macOS / Windows)**: Drop target index is now calculated from the mouse `clientY` position at drop time instead of refs, eliminating the `dragend`-before-`drop` timing race on macOS WKWebView and Windows WebView2.

### Added
- **Live Now Playing navigation**: Clicking an entry in the Live dropdown now navigates to the corresponding album page.

### Changed
- **Hero blur**: Increased background blur in the Hero section for a more immersive look.

## [1.0.11] - 2026-03-14

### Added
- **Search Results Page**: Pressing Enter in the search bar now navigates to a dedicated full search results page showing artists, albums, and songs with proper column layout and headers.

### Fixed
- **Search Results Column Alignment**: Artist and album columns in the search results song list are now correctly aligned with their column headers.
- **Search Results Header Alignment**: Fixed column header labels not aligning with song row content (root cause: `auto`-width Format column was sized independently per grid row).

### Changed
- **Gapless Playback removed**: Removed the experimental gapless playback feature. It caused intermittent song skipping and beginning cutoffs and was not reliable enough to ship. Standard sequential playback is used instead.

### Known Issues
- ~~**Seeking**: Seeking may occasionally be unreliable, particularly on Linux/GStreamer.~~ Fixed in 1.0.12.
- ~~**Queue drag & drop (macOS / Windows)**: Queue reordering via drag & drop may not always work correctly on macOS and Windows.~~ Fixed in 1.0.12.

## [1.0.10] - 2026-03-14

### Added
- **Active Track Highlighting**: The currently playing song is highlighted in album tracklists with a subtle pulsing accent background and a play icon — persists when navigating away and returning.
- **Marquee Title in Fullscreen Player**: Long song titles now scroll smoothly as a marquee instead of being cut off.
- **Clickable Artist / Album in Player Bar**: Clicking the artist name navigates to the artist page; clicking the song title navigates to the album page. Same behaviour in the Queue panel's now-playing strip.
- **Linux App Menu Category**: Application now appears under **Multimedia** in desktop application menus (GNOME, KDE, etc.) instead of "Other".
- **Windows MSI Upgrade Support**: Added stable `upgradeCode` GUID so the MSI installer recognises previous versions and upgrades in-place without requiring manual uninstallation first.

### Fixed
- **Drag & Drop (macOS / Windows)**: Queue reordering now works correctly on macOS WKWebView and Windows WebView2. The previous fix cleared index refs synchronously in `onDragEnd`, which fires before `drop` on both platforms — refs are now cleared with a short delay so `onDropQueue` can read the correct source and destination indices.
- **Settings Dropdowns**: Language and theme selects now have a clearly visible border (was invisible against the card background).
- **Tracklist Format Column**: Removed file size and kHz from the format column — codec and bitrate only. Column moved to the far right, after duration. Width is now dynamic (`auto`).
- **`tauri.conf.json`**: Fixed invalid placement of `shortDescription`/`longDescription` (were incorrectly nested under `bundle.linux`, now at `bundle` level). Removed invalid `nsis.allowDowngrades` field.

### Changed
- **Favorites Icon**: Replaced the incorrect fork icon with a star icon in the Random Mix page, consistent with all other pages.
- **Sidebar**: Removed drag-to-resize handle. Width now adapts dynamically to the viewport via `clamp(180px, 15vw, 220px)`.
- **About Section**: Added "Developed with the support of Claude Code by Anthropic" credit. Fixed "weiterzugeben" wording in German MIT licence text.
- **Minimize to Tray**: Now disabled by default.

## [1.0.9] - 2026-03-13

### Added
- **Gapless Playback**: The next track's audio pipeline is silently pre-warmed before the current track ends, eliminating the gap between songs — especially noticeable on live albums and concept records.
- **Pre-caching**: Prefetched Howl instances are now actually reused for playback, giving near-instant track transitions instead of a new HTTP connection each time.
- **Buffered Progress Indicator**: The seek bar now shows a secondary fill indicating how much of the current track has been buffered by the browser — visible in both the Player Bar and Fullscreen Player.
- **Resume on Startup**: Pressing Play after launching the app now resumes the last track at the saved playback position instead of doing nothing.
- **Album Track Hover Play Button**: Hovering over a track number in Album Detail reveals a play button for quick single-click playback.
- **Ken Burns Background**: The Fullscreen Player background now slowly drifts and zooms (Ken Burns effect) for a more cinematic feel.
- **F11 Fullscreen**: Toggle native borderless fullscreen with F11.
- **Compact Queue Now-Playing**: The current track block in the Queue Panel is now a slim horizontal strip (72 px thumbnail) instead of a full-width cover, freeing up significantly more space for the queue list on smaller screens.

### Fixed
- **GStreamer Seek Stability**: Implemented a three-layer recovery system for Linux/GStreamer seek hangs: (1) seek queuing to prevent overlapping GStreamer seeks, (2) a 2-second watchdog that triggers automatic recovery if a seek never completes, (3) an 8-second hang detector that silently recreates the audio pipeline and resumes from the last known position if playback freezes entirely.
- **Fullscreen Player**: Removed drop shadow from cover art — looks cleaner on lighter artist backgrounds.

### Changed
- **Hero Section**: Increased height (300 → 360 px) and cover art size (180 → 220 px) to prevent long album titles from clipping.
- **Player Bar**: Controls and progress bar moved closer together for a more balanced layout.

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
