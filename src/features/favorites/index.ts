/**
 * Favorites feature — the Favorites page (starred songs/artists + favourite
 * radio stations) and its data/selection/filtering hooks. The `Favorites` page
 * is lazy-loaded by the router via its deep path, so it is not re-exported here.
 *
 * Note: the offline integration layer (`utils/offline/favorites*`,
 * `store/favoritesOfflineSyncStore`) stays in the offline layer — the offline
 * core imports it, so it cannot live under this feature without inverting the
 * core→feature dependency.
 */
export { useFavoritesData } from './hooks/useFavoritesData';
export { useFavoritesSelection } from './hooks/useFavoritesSelection';
export { useFavoritesOfflineStatus } from './hooks/useFavoritesOfflineStatus';
