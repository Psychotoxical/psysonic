/**
 * Share feature — applying pasted entity/queue shares (server switch + resolve +
 * play/navigate) and enqueueing share-search results. The pure encode/decode/parse
 * and origin-label helpers live in `@/lib/share` (feature-free); these orchestrators
 * runtime-import offline/playback/orbit, so they are feature-scoped. Consumers import
 * deep paths (`@/features/share/...`); this barrel is documentation.
 */
export * from './applySharePaste';
export * from './enqueueShareSearchPayload';
