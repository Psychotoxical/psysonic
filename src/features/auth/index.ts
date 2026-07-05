/**
 * Auth feature — the server login / connection page (add server, test
 * credentials, custom HTTP headers, magic-string import). The page is
 * lazy-loaded by the auth shell via its deep path, so it is not re-exported
 * here.
 *
 * Stays OUT (global / shared, consumed by this feature, not owned): `authStore`
 * (the cross-cutting localStorage-backed server-profile store) and the
 * `utils/server/*` server-profile config helpers (also used by settings).
 */
export {};
