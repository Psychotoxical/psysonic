import { canonicalNavidromeArtworkId } from '@/lib/server/navidromeCanonicalId';

const COVER_DB_NAME = 'psysonic-img-cache';
const COVER_STORE_NAME = 'images';
const LYRICS_DB_NAME = 'psysonic-lyrics-cache';
const LYRICS_STORE_NAME = 'lyrics';

type CoverRecord = {
  key: string;
  blob?: Blob;
  timestamp?: number;
  [key: string]: unknown;
};

export type NavidromeCoverIdbBatch = {
  cursorKey: string | null;
  upperKey: string | null;
  processed: number;
  moved: number;
  merged: number;
  done: boolean;
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let created = false;
    const request = indexedDB.open(name);
    request.onupgradeneeded = event => {
      created = event.oldVersion === 0;
    };
    request.onsuccess = () => {
      const database = request.result;
      if (!created) {
        resolve(database);
        return;
      }
      database.close();
      const deletion = indexedDB.deleteDatabase(name);
      deletion.onsuccess = () => resolve(null);
      deletion.onerror = () => reject(deletion.error ?? new Error(`Could not remove empty ${name}`));
      deletion.onblocked = () => reject(new Error(`Could not remove blocked empty ${name}`));
    };
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${name}`));
    request.onblocked = () => reject(new Error(`Could not open blocked ${name}`));
  });
}

export function canonicalNavidromeCoverIdbKey(
  key: string,
  serverIndexKey: string,
): string | null {
  const prefix = `${serverIndexKey}:cover:`;
  if (!key.startsWith(prefix)) return null;
  const tail = key.slice(prefix.length);
  const kindSeparator = tail.indexOf(':');
  const tierSeparator = tail.lastIndexOf(':');
  if (kindSeparator <= 0 || tierSeparator <= kindSeparator + 1 || tierSeparator === tail.length - 1) {
    return null;
  }
  const kind = tail.slice(0, kindSeparator);
  if (kind !== 'album' && kind !== 'artist') return null;
  const entityId = tail.slice(kindSeparator + 1, tierSeparator);
  const canonicalEntityId = canonicalNavidromeArtworkId(entityId);
  return `${prefix}${kind}:${canonicalEntityId}:${tail.slice(tierSeparator + 1)}`;
}

async function collectLegacyCoverKeys(
  database: IDBDatabase,
  serverIndexKey: string,
  afterKey: string | null,
  upperKey: string,
  limit: number,
): Promise<{ keys: string[]; hasMore: boolean }> {
  const transaction = database.transaction(COVER_STORE_NAME, 'readonly');
  const store = transaction.objectStore(COVER_STORE_NAME);
  const range = afterKey
    ? IDBKeyRange.bound(afterKey, upperKey, true, false)
    : IDBKeyRange.upperBound(upperKey);
  const keys: string[] = [];
  let hasMore = false;
  await new Promise<void>((resolve, reject) => {
    const request = store.openKeyCursor(range);
    request.onerror = () => reject(request.error ?? new Error('Could not scan cover cache'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const key = String(cursor.key);
      const canonical = canonicalNavidromeCoverIdbKey(key, serverIndexKey);
      if (canonical && canonical !== key) {
        if (keys.length >= limit) {
          hasMore = true;
          resolve();
          return;
        }
        keys.push(key);
      }
      cursor.continue();
    };
  });
  await transactionDone(transaction);
  return { keys, hasMore };
}

function validBlob(record: CoverRecord | undefined): boolean {
  return record?.blob instanceof Blob && record.blob.size > 0;
}

function destinationRecord(source: CoverRecord, destination: CoverRecord | undefined, key: string): CoverRecord {
  if (!destination) return { ...source, key };
  const sourceValid = validBlob(source);
  const destinationValid = validBlob(destination);
  const sourceTimestamp = typeof source.timestamp === 'number' ? source.timestamp : 0;
  const destinationTimestamp = typeof destination.timestamp === 'number' ? destination.timestamp : 0;
  if (sourceValid && (!destinationValid || sourceTimestamp > destinationTimestamp)) {
    return { ...destination, ...source, key };
  }
  return { ...source, ...destination, key };
}

/** Snapshot the final transformable source key after cover writers have drained. */
export async function inspectNavidromeCoverIdbUpperKey(
  serverIndexKey: string,
): Promise<string | null> {
  const database = await openExistingDatabase(COVER_DB_NAME);
  if (!database) return null;
  try {
    if (!database.objectStoreNames.contains(COVER_STORE_NAME)) return null;
    const transaction = database.transaction(COVER_STORE_NAME, 'readonly');
    const store = transaction.objectStore(COVER_STORE_NAME);
    let upperKey: string | null = null;
    await new Promise<void>((resolve, reject) => {
      const request = store.openKeyCursor();
      request.onerror = () => reject(request.error ?? new Error('Could not inspect cover cache'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const key = String(cursor.key);
        const canonical = canonicalNavidromeCoverIdbKey(key, serverIndexKey);
        if (canonical && canonical !== key) upperKey = key;
        cursor.continue();
      };
    });
    await transactionDone(transaction);
    return upperKey;
  } finally {
    database.close();
  }
}

/** Move one bounded set of cover records in a single readwrite transaction. */
export async function migrateNavidromeCoverIdbBatch(args: {
  serverIndexKey: string;
  cursorKey: string | null;
  upperKey: string | null;
  limit?: number;
}): Promise<NavidromeCoverIdbBatch> {
  const limit = args.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Cover IndexedDB migration limit must be between 1 and 1000');
  }
  if (!args.upperKey) {
    return { cursorKey: args.cursorKey, upperKey: null, processed: 0, moved: 0, merged: 0, done: true };
  }
  const database = await openExistingDatabase(COVER_DB_NAME);
  if (!database) {
    return { cursorKey: args.upperKey, upperKey: args.upperKey, processed: 0, moved: 0, merged: 0, done: true };
  }
  try {
    if (!database.objectStoreNames.contains(COVER_STORE_NAME)) {
      return { cursorKey: args.upperKey, upperKey: args.upperKey, processed: 0, moved: 0, merged: 0, done: true };
    }
    const selection = await collectLegacyCoverKeys(
      database,
      args.serverIndexKey,
      args.cursorKey,
      args.upperKey,
      limit,
    );
    if (selection.keys.length === 0) {
      return {
        cursorKey: args.upperKey,
        upperKey: args.upperKey,
        processed: 0,
        moved: 0,
        merged: 0,
        done: true,
      };
    }

    const transaction = database.transaction(COVER_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(COVER_STORE_NAME);
    let moved = 0;
    let merged = 0;
    for (const sourceKey of selection.keys) {
      const destinationKey = canonicalNavidromeCoverIdbKey(sourceKey, args.serverIndexKey);
      if (!destinationKey || destinationKey === sourceKey) continue;
      const source = await requestResult(store.get(sourceKey)) as CoverRecord | undefined;
      if (!source) continue;
      const destination = await requestResult(store.get(destinationKey)) as CoverRecord | undefined;
      await requestResult(store.put(destinationRecord(source, destination, destinationKey)));
      await requestResult(store.delete(sourceKey));
      if (destination) merged += 1;
      else moved += 1;
    }
    await transactionDone(transaction);
    return {
      cursorKey: selection.keys[selection.keys.length - 1] ?? args.cursorKey,
      upperKey: args.upperKey,
      processed: selection.keys.length,
      moved,
      merged,
      done: !selection.hasMore,
    };
  } finally {
    database.close();
  }
}

export async function verifyNavidromeCoverIdb(serverIndexKey: string): Promise<void> {
  const upperKey = await inspectNavidromeCoverIdbUpperKey(serverIndexKey);
  if (upperKey) throw new Error(`Legacy cover IndexedDB key remains: ${upperKey}`);
}

/** Lyrics are derived; remove affected owner prefixes instead of preserving stale IDs. */
export async function invalidateNavidromeLyricsIdb(owners: readonly string[]): Promise<void> {
  const prefixes = owners.filter(Boolean).map(owner => `${owner}:`);
  if (prefixes.length === 0) return;
  const database = await openExistingDatabase(LYRICS_DB_NAME);
  if (!database) return;
  try {
    if (!database.objectStoreNames.contains(LYRICS_STORE_NAME)) return;
    const transaction = database.transaction(LYRICS_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(LYRICS_STORE_NAME);
    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor();
      request.onerror = () => reject(request.error ?? new Error('Could not invalidate lyrics cache'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const key = String(cursor.key);
        if (prefixes.some(prefix => key.startsWith(prefix))) cursor.delete();
        cursor.continue();
      };
    });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
