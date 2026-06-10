export function isDevChannelVersion(version: string): boolean {
  return /-dev(?:\b|$)/i.test(version.trim());
}

export function isWorkspaceReleaseNotesMode(version: string): boolean {
  return import.meta.env.DEV || isDevChannelVersion(version);
}
