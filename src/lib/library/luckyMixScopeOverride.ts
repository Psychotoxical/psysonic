let scopeOverride: string | null = null;

export function getLuckyMixLibraryScopeOverride(): string | null {
  return scopeOverride;
}

export async function runWithLuckyMixLibraryScope<T>(
  libraryId: string,
  fn: () => Promise<T>,
): Promise<T> {
  scopeOverride = libraryId;
  try {
    return await fn();
  } finally {
    scopeOverride = null;
  }
}
