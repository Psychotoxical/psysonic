import { useAuthStore } from '@/store/authStore';

/** Resolved user media root `M` (empty → Rust default `{app_data}/media/`). */
export function getMediaDir(): string | null {
  const dir = useAuthStore.getState().mediaDir?.trim();
  return dir || null;
}
