/**
 * Player bar visibility — persisted under `psysonic_player_bar_buttons`, **not** inside
 * `psysonic-auth`.
 *
 * **Where to put new preferences (deliberate split):**
 * - **`psysonic-auth`**: server profiles, credentials, audio/download/playback knobs,
 *   integrations, logging, etc. One large persisted blob with its own migration/rehydrate
 *   pipeline (`computeAuthStoreRehydration`).
 * - **Dedicated `psysonic_*` keys** (same family as `psysonic_queue_toolbar`, `psysonic_sidebar`,
 *   `psysonic_theme`, `psysonic_home`): small, **UI chrome / layout** slices. They stay easy
 *   to extend (merge new keys on rehydrate) without touching auth shape or backup risk
 *   for unrelated settings.
 */
export type PlayerBarButtonId =
  | 'starRating'
  | 'favorite'
  | 'lastfmLove'
  | 'equalizer'
  | 'miniPlayer';

export type PlayerBarButtonVisibility = Record<PlayerBarButtonId, boolean>;

export const DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY: PlayerBarButtonVisibility = {
  starRating: true,
  favorite: true,
  lastfmLove: true,
  equalizer: true,
  miniPlayer: true,
};

/** Merges persisted `visibility` with defaults; tolerates legacy/partial shapes. Pure. */
export function mergePlayerBarButtonVisibility(raw: unknown): PlayerBarButtonVisibility {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PLAYER_BAR_BUTTON_VISIBILITY;
  return {
    starRating: typeof v.starRating === 'boolean' ? v.starRating : d.starRating,
    favorite: typeof v.favorite === 'boolean' ? v.favorite : d.favorite,
    lastfmLove: typeof v.lastfmLove === 'boolean' ? v.lastfmLove : d.lastfmLove,
    equalizer: typeof v.equalizer === 'boolean' ? v.equalizer : d.equalizer,
    miniPlayer: typeof v.miniPlayer === 'boolean' ? v.miniPlayer : d.miniPlayer,
  };
}
