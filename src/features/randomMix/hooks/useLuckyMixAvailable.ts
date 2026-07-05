import { useAuthStore } from '@/store/authStore';

/**
 * Whether "Lucky Mix" should be exposed as a navigable menu/card entry.
 *
 * Single source of truth for the gate — previously this logic was inlined in
 * Sidebar, MobileMoreOverlay, RandomLanding, Settings/SidebarCustomizer, and
 * the sidebarNavReorder filter. All call sites share the same three-way
 * predicate:
 *   1. User hasn't hidden it via the Settings toggle.
 *   2. AudioMuse is enabled for the active server (feature depends on
 *      audiomuse-backed similar-track quality).
 *   3. An active server exists at all.
 *
 * Callers that additionally care about the "split vs hub" navigation mode
 * should combine this with `randomNavMode === 'separate'` explicitly — that's
 * an orthogonal UI placement concern, not an availability concern.
 */
export function isLuckyMixAvailable(args: {
  activeServerId: string | null | undefined;
  audiomuseByServer: Record<string, boolean>;
  showLuckyMixMenu: boolean;
}): boolean {
  const { activeServerId, audiomuseByServer, showLuckyMixMenu } = args;
  if (!showLuckyMixMenu) return false;
  if (!activeServerId) return false;
  return Boolean(audiomuseByServer[activeServerId]);
}

/**
 * React hook form — subscribes to the three authStore slices the predicate
 * depends on, so any user-facing change (toggle flip, server switch, AudioMuse
 * toggle on/off) re-renders the caller automatically.
 */
export function useLuckyMixAvailable(): boolean {
  const activeServerId    = useAuthStore(s => s.activeServerId);
  const audiomuseByServer = useAuthStore(s => s.audiomuseNavidromeByServer);
  const showLuckyMixMenu  = useAuthStore(s => s.showLuckyMixMenu);
  return isLuckyMixAvailable({ activeServerId, audiomuseByServer, showLuckyMixMenu });
}
