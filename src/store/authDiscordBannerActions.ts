// src/store/authDiscordBannerActions.ts

import type { AuthState } from './authStoreTypes';

export interface DiscordBannerActions {
  dismissDiscordBanner: () => void;
  addDiscordBannerUsageMs: (deltaMs: number) => void;
}

export const createDiscordBannerActions = (
  set: (fn: (state: AuthState) => Partial<AuthState>) => void
): DiscordBannerActions => ({
  dismissDiscordBanner: () =>
    set(() => ({ discordBannerDismissed: true })),

  addDiscordBannerUsageMs: deltaMs =>
    set(state => ({
      discordBannerAccumulatedUsageMs: state.discordBannerAccumulatedUsageMs + deltaMs,
    })),
});
