/**
 * Composers feature — the composer overview (`Composers`) and per-composer
 * works (`ComposerDetail`) browse pages, their browse-filter / scroll-restore /
 * navigation hooks, and the composer browse-session store. The pages are
 * lazy-loaded by the router via their deep paths, so they are not re-exported
 * here. Only the live-search scope predicate is consumed cross-feature.
 */
export { isComposersBrowsePath } from './store/composerBrowseSessionStore';
