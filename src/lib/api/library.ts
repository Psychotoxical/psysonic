/**
 * Typed wrappers around the `library_*` Tauri commands (spec §7.1) plus
 * subscribers for `library:sync-progress` / `library:sync-idle` events (§7.2).
 *
 * Formerly one thin file (cucadmuh's PR-5 kickoff Q1); split by concern under
 * `library/` for the ~500 LOC ceiling. This barrel keeps `@/lib/api/library` as
 * the single import point, so the Settings UI (LibraryTab) and every other
 * consumer are unchanged. The private server-id↔index-key helpers live in
 * `library/internal` and are intentionally not re-exported.
 */
export * from './library/dto';
export * from './library/reads';
export * from './library/sync';
export * from './library/stats';
export * from './library/events';
