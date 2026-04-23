import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';

const WindowVisibilityContext = createContext(false);

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

export function WindowVisibilityProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(isWindowHidden);
  const hiddenRef = useRef(hidden);

  useEffect(() => {
    hiddenRef.current = isWindowHidden();
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      const interval = hiddenRef.current ? 1000 : 500;
      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (cancelled) return;
        const current = isWindowHidden();
        if (current !== hiddenRef.current) {
          hiddenRef.current = current;
          setHidden(current);
        }
        schedule();
      }, interval);
    };

    schedule();
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, []);

  return (
    <WindowVisibilityContext.Provider value={hidden}>
      {children}
    </WindowVisibilityContext.Provider>
  );
}

export function useWindowVisibility() {
  return useContext(WindowVisibilityContext);
}
