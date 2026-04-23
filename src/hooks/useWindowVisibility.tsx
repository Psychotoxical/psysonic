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
 * with an adaptive interval: fast checks while visible (to catch show quickly),
 * slow checks while hidden (to minimize CPU wakeups).
 */
export function WindowVisibilityProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(document.hidden);
  const hiddenRef = useRef(hidden);

  useEffect(() => {
    hiddenRef.current = document.hidden;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      const interval = hiddenRef.current ? 1000 : 200;
      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (cancelled) return;
        const current = document.hidden;
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
