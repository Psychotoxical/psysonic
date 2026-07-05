/**
 * Mini player feature — the compact always-on-top mini-player window UI
 * (controls, meta, queue, titlebar, toolbar, context menu) plus the main↔mini
 * IPC bridge. The webview entry shell (`app/MiniPlayerApp`) stays in `app/` and
 * renders this feature's default export.
 */
export { default } from './components/MiniPlayer';
export { initMiniPlayerBridgeOnMain } from './utils/miniPlayerBridge';
