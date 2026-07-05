/**
 * Settings feature — the Settings page (lazy via the deep path `pages/Settings`)
 * and all its tabs/sections (servers, audio, input, library, lyrics, storage,
 * personalisation, integrations, system, the theme management UI, music-network
 * config, user management), plus the settings layout primitives.
 *
 * Cross-cutting state this feature consumes but does NOT own: `authStore` and its
 * `auth*SettingsActions` slices, the theme stores + theme infra utils, the
 * library-index sync hook, and `settingsCredits` — all live in the core/global
 * layer.
 *
 * Public surface (consumed by other features / app shell):
 */
export { default as SettingsSubSection } from './components/SettingsSubSection';
export { PlaybackRateControls } from './components/audio/PlaybackRateBlock';
export { CustomHttpHeadersEditor } from './components/CustomHttpHeadersEditor';
