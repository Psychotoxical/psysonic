import { COVER_ART_TIERS } from '@/cover/tiers';
import { COVER_ART_REGISTERED_SIZES } from '@/cover/coverArtRegisteredSizes';
import { invalidateCacheKey, STORE_NAME, openDB } from '@/cover';

const MIGRATION_FLAG = 'psysonic_cover_tier_idb_cleared_v1';

/**
 * One-time clear of legacy multi-size IndexedDB cover keys (spec §4 — no import).
 */
export async function runCoverIdbUpgradeMigration(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return;
  } catch {
    return;
  }

  const legacySizes = new Set<number>([
    ...COVER_ART_REGISTERED_SIZES,
    ...COVER_ART_TIERS,
  ]);

  try {
    const db = await openDB();
    const keys = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
      req.onerror = () => reject(req.error);
    });

    for (const key of keys) {
      if (!key.includes(':cover:')) continue;
      const tail = key.slice(key.lastIndexOf(':') + 1);
      const size = Number(tail);
      if (!Number.isFinite(size) || legacySizes.has(size)) {
        await invalidateCacheKey(key);
      }
    }
  } catch {
    /* best-effort */
  }

  try {
    localStorage.setItem(MIGRATION_FLAG, '1');
  } catch {
    /* ignore */
  }
}
