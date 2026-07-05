/** True when running on Linux (WebKitGTK). Used to show the custom title bar. */
export const IS_LINUX = navigator.platform.toLowerCase().includes('linux');
/** True when running on macOS (WKWebView). */
export const IS_MACOS = navigator.platform.toLowerCase().includes('mac');
/** True when running on Windows (WebView2). */
export const IS_WINDOWS = navigator.platform.toLowerCase().includes('win');
