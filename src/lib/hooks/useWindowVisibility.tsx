import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';

const WindowVisibilityContext = createContext(false);
const WindowBlurredContext = createContext(false);

/**
 * Tracks whether the Tauri window is hidden.
 *
 * On Windows WebView2, `visibilitychange` and `blur`/`focus` events do not
 * fire when `win.hide()` is called. We fall back to polling `document.hidden`
 * OR-ed with `window.__psyHidden` (set from Rust before/after `win.hide()` /
 * `show()`) — the latter is the reliable signal on WebView2 where
 * `document.hidden` may stay false. Adaptive interval: slow while hidden
 * (minimize wakeups), 500 ms while visible (catch show without burning CPU).
 */
function isWindowHidden() {
  return document.hidden || !!window.__psyHidden;
}

function isWindowBlurred() {
  return !document.hasFocus();
}

export function WindowVisibilityProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(isWindowHidden);
  const [blurred, setBlurred] = useState(isWindowBlurred);
  const hiddenRef = useRef(hidden);
  const blurredRef = useRef(blurred);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const update = () => {
      const currentHidden = isWindowHidden();
      if (currentHidden !== hiddenRef.current) {
        hiddenRef.current = currentHidden;
        setHidden(currentHidden);
      }
      const currentBlurred = isWindowBlurred();
      if (currentBlurred !== blurredRef.current) {
        blurredRef.current = currentBlurred;
        setBlurred(currentBlurred);
      }
    };

    const schedule = () => {
      if (cancelled) return;
      const interval = hiddenRef.current ? 1000 : 500;
      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (cancelled) return;
        update();
        schedule();
      }, interval);
    };

    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    update();
    schedule();
    return () => {
      cancelled = true;
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, []);

  return (
    <WindowVisibilityContext.Provider value={hidden}>
      <WindowBlurredContext.Provider value={blurred}>
        {children}
      </WindowBlurredContext.Provider>
    </WindowVisibilityContext.Provider>
  );
}

// Companion hook intentionally co-located with WindowVisibilityProvider in this
// small context module; HMR-only rule does not warrant a separate file.
// eslint-disable-next-line react-refresh/only-export-components
export function useWindowVisibility() {
  return useContext(WindowVisibilityContext);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWindowBlurred() {
  return useContext(WindowBlurredContext);
}
