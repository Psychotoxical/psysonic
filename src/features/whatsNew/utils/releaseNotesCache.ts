import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { isTauri } from '@tauri-apps/api/core';

const CACHE_DIR = 'release-notes';

function cacheRelPath(version: string): string {
  const safe = version.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `${CACHE_DIR}/${safe}.md`;
}

export async function readReleaseNotesCache(version: string): Promise<string | null> {
  if (!isTauri()) return null;
  const path = cacheRelPath(version);
  try {
    if (!(await exists(path, { baseDir: BaseDirectory.AppData }))) return null;
    const text = (await readTextFile(path, { baseDir: BaseDirectory.AppData })).trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function writeReleaseNotesCache(version: string, body: string): Promise<void> {
  if (!isTauri()) return;
  const path = cacheRelPath(version);
  try {
    await mkdir(CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
    await writeTextFile(path, body, { baseDir: BaseDirectory.AppData });
  } catch {
    // cache is best-effort
  }
}
