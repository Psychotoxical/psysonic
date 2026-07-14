/**
 * Show the native window after the inline startup splash has painted.
 * When starting minimized to tray, hide the main window as early as possible
 * (visible:false may still map briefly on some Linux WMs before Rust eval).
 * __TAURI_INTERNALS__ may not exist yet when this script first runs.
 */
(function startupSplashReveal() {
  var MAX_ATTEMPTS = 60;

  function tryShowMainWindow() {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return false;
    internals.invoke('plugin:window|show', { label: 'main' }).catch(function () {});
    return true;
  }

  function tryHideMainWindow() {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return false;
    internals.invoke('plugin:window|hide', { label: 'main' }).catch(function () {});
    return true;
  }

  function reveal(attempt) {
    if (window.__psyStartMinimizedToTray) {
      if (tryHideMainWindow()) return;
      if (attempt >= MAX_ATTEMPTS) return;
      window.setTimeout(function () {
        reveal(attempt + 1);
      }, 50);
      return;
    }
    if (tryShowMainWindow()) return;
    if (attempt >= MAX_ATTEMPTS) return;
    window.setTimeout(function () {
      reveal(attempt + 1);
    }, 50);
  }

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      reveal(0);
    });
  });
})();
