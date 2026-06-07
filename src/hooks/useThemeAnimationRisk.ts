import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { IS_LINUX } from '../utils/platform';

/**
 * Whether animated themes may raise CPU load on this setup — Linux with the
 * Nvidia WebKit quirk active (recorded at startup) or compositing forced off.
 * The store / theme cards show a warning on animated themes when this is true.
 *
 * Fetched once and cached for the process (read-once, per the Tauri-boundary
 * rule). Always false off Linux, so the `invoke` is skipped there.
 */
let cached: boolean | null = null;

export function useThemeAnimationRisk(): boolean {
  const [risk, setRisk] = useState(cached ?? false);

  useEffect(() => {
    if (cached !== null) {
      setRisk(cached);
      return;
    }
    if (!IS_LINUX) {
      cached = false;
      return;
    }
    let alive = true;
    const p = invoke<boolean>('theme_animation_risk');
    // Guard the mocked-in-tests case where invoke isn't a real promise.
    if (p && typeof (p as Promise<boolean>).then === 'function') {
      (p as Promise<boolean>)
        .then((v) => {
          cached = !!v;
          if (alive) setRisk(cached);
        })
        .catch(() => {
          cached = false;
        });
    }
    return () => {
      alive = false;
    };
  }, []);

  return risk;
}
