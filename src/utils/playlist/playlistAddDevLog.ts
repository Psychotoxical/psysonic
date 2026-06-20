/** Temporary dev-only traces for playlist add debugging — remove when root cause is found. */
const PREFIX = '[psysonic][playlist-add]';

export function playlistAddDevLog(label: string, payload: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  console.debug(PREFIX, label, payload);
}
