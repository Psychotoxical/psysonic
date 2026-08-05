/**
 * Show the native window after the inline startup splash has painted.
 * When starting minimized to tray, hide the main window as early as possible
 * (visible:false may still map briefly on some Linux WMs before this script).
 * __TAURI_INTERNALS__ may not exist yet when this script first runs.
 */
(function startupSplashReveal() {
  var INTERNALS_MAX_ATTEMPTS = 60;
  var WINDOW_ACTION_MAX_ATTEMPTS = 3;
  var INVOKE_TIMEOUT_MS = 1500;

  function withTimeout(promise) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        var error = new Error('startup window invoke timed out');
        error.name = 'TimeoutError';
        reject(error);
      }, INVOKE_TIMEOUT_MS);
      promise.then(function (value) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      });
    });
  }

  function invokeWindowAction(internals, hidden, generation, attempt) {
    withTimeout(internals.invoke('window_lifecycle_startup_visibility', {
      hidden: hidden,
      generation: generation,
    })).catch(function (error) {
      // The invoke itself cannot be cancelled. Retrying after a timeout would
      // leave multiple visibility mutations in flight and allow stale results.
      if (error && error.name === 'TimeoutError') {
        console.error('[startup] failed to reveal the main window', error);
        return;
      }
      if (attempt >= WINDOW_ACTION_MAX_ATTEMPTS) {
        console.error('[startup] failed to reveal the main window', error);
        return;
      }
      window.setTimeout(function () {
        invokeWindowAction(internals, hidden, generation, attempt + 1);
      }, 100);
    });
  }

  function tryRevealMainWindow(hidden) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return false;
    // Prepare at most once. Repeating a timed-out native mutation can complete
    // out of order after React has already selected the final titlebar mode.
    var generation;
    withTimeout(internals.invoke('window_lifecycle_generation')).then(function (currentGeneration) {
      generation = currentGeneration;
      window.__psyLifecycleGeneration = generation;
      return withTimeout(internals.invoke('prepare_main_window_for_reveal', { generation: generation }));
    }).then(function (isTilingWm) {
      window.__psyIsTilingWm = !!isTilingWm;
    }).catch(function (error) {
      if (typeof generation === 'number') {
        console.warn('[startup] main-window preparation failed; using native fallback', error);
      } else {
        console.error('[startup] failed to acquire window lifecycle generation', error);
      }
    }).then(function () {
      if (typeof generation === 'number') {
        invokeWindowAction(internals, hidden, generation, 1);
      }
    });
    return true;
  }

  function reveal(attempt) {
    if (window.__psyStartMinimizedToTray) {
      if (tryRevealMainWindow(true)) return;
      if (attempt >= INTERNALS_MAX_ATTEMPTS) return;
      window.setTimeout(function () {
        reveal(attempt + 1);
      }, 50);
      return;
    }
    if (tryRevealMainWindow(false)) return;
    if (attempt >= INTERNALS_MAX_ATTEMPTS) return;
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

  // WebKitGTK suspends requestAnimationFrame while the native window is hidden.
  // A timer lets the deferred show run before the window has ever been mapped.
  window.setTimeout(function () {
    reveal(0);
  }, 0);
})();
