/**
 * Show the native window after the inline startup splash has painted.
 * When starting minimized to tray, hide the main window as early as possible
 * (visible:false may still map briefly on some Linux WMs before this script).
 * __TAURI_INTERNALS__ may not exist yet when this script first runs.
 */
(function startupSplashReveal() {
  var MAX_ATTEMPTS = 60;

  function tryRevealMainWindow(hidden) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return false;
    internals.invoke('prepare_main_window_for_reveal', {
      useCustomTitlebar: !!window.__psyUseCustomTitlebar,
    }).then(function (isTilingWm) {
      window.__psyIsTilingWm = !!isTilingWm;
    }).catch(function () {}).then(function () {
      var command = hidden ? 'plugin:window|hide' : 'plugin:window|show';
      return internals.invoke(command, { label: 'main' });
    }).catch(function () {});
    return true;
  }

  function reveal(attempt) {
    if (window.__psyStartMinimizedToTray) {
      if (tryRevealMainWindow(true)) return;
      if (attempt >= MAX_ATTEMPTS) return;
      window.setTimeout(function () {
        reveal(attempt + 1);
      }, 50);
      return;
    }
    if (tryRevealMainWindow(false)) return;
    if (attempt >= MAX_ATTEMPTS) return;
    window.setTimeout(function () {
      reveal(attempt + 1);
    }, 50);
  }

  if (window.__psyStartMinimizedToTray) {
    // Mark this synchronously, before React mounts. This deliberately does
    // not set the CSS animation-pause attribute: entrance animations may
    // still mount while the native window is hidden.
    window.__psyHidden = true;
    try {
      sessionStorage.setItem('psy-startup-tray-handled', '1');
    } catch (_err) {}
    reveal(0);
    return;
  }

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      reveal(0);
    });
  });
})();
