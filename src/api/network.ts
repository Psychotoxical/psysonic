import { invoke } from '@tauri-apps/api/core';

/**
 * Resolve a hostname (or `host:port`) to a deduped list of IP-address strings
 * via the Rust `resolve_host_addresses` command. IPv4 + IPv6 returned in one
 * list; order is whatever the OS resolver hands back.
 *
 * **Form-hint only.** Used by the add/edit-server form to suggest whether
 * the entered address is LAN-only (→ hint to add a public second address)
 * or public-only (→ hint to add a local one). The actual connect path runs
 * `pingWithCredentials` against the URL — not against the resolved IPs.
 *
 * Lookup failure / DNS hiccup → empty array (UI shows no hint, by design;
 * a transient DNS error must not block save).
 */
export async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const trimmed = hostname.trim();
  if (!trimmed) return [];
  try {
    return await invoke<string[]>('resolve_host_addresses', { hostname: trimmed });
  } catch {
    return [];
  }
}
