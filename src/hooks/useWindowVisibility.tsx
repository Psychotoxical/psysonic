import {
  createContext,
  useContext,
  useState,
  useCallback,
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

  const scheduleCheck = useCallback(() => {
    const interval = hiddenRef.current ? 1000 : 200;
    const id = setTimeout(() => {
      const current = document.hidden;
      if (current !== hiddenRef.current) {
        hiddenRef.current = current;
        setHidden(current);
      }
      scheduleCheck();
    }, interval);
    return id;
  }, []);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = scheduleCheck();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [scheduleCheck]);

  return (
    <WindowVisibilityContext.Provider value={hidden}>
      {children}
    </WindowVisibilityContext.Provider>
  );
}

export function useWindowVisibility() {
  return useContext(WindowVisibilityContext);
}