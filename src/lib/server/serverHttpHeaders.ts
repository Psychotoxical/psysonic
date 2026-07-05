import type {
  CustomHeaderEntry,
  CustomHeadersApplyTo,
  CustomHeadersFieldError,
  CustomHeadersValidationResult,
  ServerProfile,
} from '@/store/authStoreTypes';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { normalizeServerBaseUrl, serverAddressEndpoints, type ServerEndpointKind } from '@/lib/server/serverEndpoint';

export const DEFAULT_CUSTOM_HEADERS_APPLY_TO: CustomHeadersApplyTo = 'public';

export const CUSTOM_HEADER_NAME_BLOCKLIST = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
]);

const MAX_CUSTOM_HEADERS = 16;
const MAX_HEADER_NAME_LEN = 256;
const MAX_HEADER_VALUE_LEN = 8192;

export function normalizeHeaderName(name: string): string {
  return name.trim();
}

export function requestBaseUrlFromHttpUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `http://${trimmed}`);
    parsed.search = '';
    parsed.hash = '';
    let path = parsed.pathname;
    const restIdx = path.indexOf('/rest/');
    if (restIdx >= 0 || path.endsWith('/rest')) {
      path = path.slice(0, restIdx >= 0 ? restIdx : path.length - '/rest'.length);
    } else {
      for (const seg of ['/api/', '/auth/'] as const) {
        const idx = path.indexOf(seg);
        if (idx >= 0) {
          path = path.slice(0, idx);
          break;
        }
      }
    }
    if (path.endsWith('/') && path.length > 1) path = path.replace(/\/+$/, '');
    parsed.pathname = path || '/';
    const origin = `${parsed.protocol}//${parsed.host}${path === '/' ? '' : path}`;
    return normalizeServerBaseUrl(origin);
  } catch {
    return normalizeServerBaseUrl(trimmed);
  }
}

export function validateCustomHeaders(
  headers: CustomHeaderEntry[] | undefined,
): CustomHeadersValidationResult {
  if (!headers?.length) return { ok: true };
  if (headers.length > MAX_CUSTOM_HEADERS) {
    return {
      ok: false,
      fieldErrors: [{ index: 0, field: 'name', messageKey: 'settings.customHeadersValidation.tooMany' }],
    };
  }
  const fieldErrors: CustomHeadersFieldError[] = [];
  const seen = new Set<string>();
  headers.forEach((row, index) => {
    const name = normalizeHeaderName(row.name);
    const value = row.value;
    if (!name) {
      fieldErrors.push({ index, field: 'name', messageKey: 'settings.customHeadersValidation.nameRequired' });
      return;
    }
    if (name.length > MAX_HEADER_NAME_LEN) {
      fieldErrors.push({ index, field: 'name', messageKey: 'settings.customHeadersValidation.nameTooLong' });
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      fieldErrors.push({ index, field: 'name', messageKey: 'settings.customHeadersValidation.crlf' });
    }
    if (CUSTOM_HEADER_NAME_BLOCKLIST.has(name.toLowerCase())) {
      fieldErrors.push({ index, field: 'name', messageKey: 'settings.customHeadersValidation.blocked' });
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      fieldErrors.push({ index, field: 'name', messageKey: 'settings.customHeadersValidation.duplicate' });
    }
    seen.add(key);
    if (value.length > MAX_HEADER_VALUE_LEN) {
      fieldErrors.push({ index, field: 'value', messageKey: 'settings.customHeadersValidation.valueTooLong' });
    }
  });
  if (fieldErrors.length) return { ok: false, fieldErrors };
  return { ok: true };
}

/** Non-empty custom header rows from a form editor → profile fields (or omit when empty). */
export function serverCustomHeadersFromForm(
  headers: CustomHeaderEntry[],
  applyTo: CustomHeadersApplyTo,
): Pick<ServerProfile, 'customHeaders' | 'customHeadersApplyTo'> | Record<string, never> {
  const rows = headers
    .map(h => ({ name: h.name.trim(), value: h.value }))
    .filter(h => h.name || h.value);
  if (!rows.length) return {};
  return { customHeaders: rows, customHeadersApplyTo: applyTo };
}

function headersRecord(entries: CustomHeaderEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of entries) {
    const name = normalizeHeaderName(row.name);
    if (!name) continue;
    out[name] = row.value;
  }
  return out;
}

export function headersForServerRequest(
  profile: Pick<
    ServerProfile,
    'url' | 'alternateUrl' | 'customHeaders' | 'customHeadersApplyTo'
  >,
  requestBaseUrl: string,
): Record<string, string> {
  if (!profile.customHeaders?.length) return {};
  const normalized = normalizeServerBaseUrl(requestBaseUrl);
  const endpoint = serverAddressEndpoints(profile).find(e => e.url === normalized);
  if (!endpoint) return {};
  const apply = profile.customHeadersApplyTo ?? DEFAULT_CUSTOM_HEADERS_APPLY_TO;
  if (apply === 'both' || apply === endpoint.kind) {
    return headersRecord(profile.customHeaders);
  }
  return {};
}

export type ServerHttpEndpointWire = {
  url: string;
  kind: ServerEndpointKind;
};

/** Payload for Rust registry sync — endpoint kinds from TS dual-address layer. */
export function serverHttpContextWireForProfile(
  server: Pick<
    ServerProfile,
    'id' | 'url' | 'alternateUrl' | 'customHeaders' | 'customHeadersApplyTo'
  >,
): {
  serverId: string;
  appServerId: string;
  endpoints: ServerHttpEndpointWire[];
  customHeaders: CustomHeaderEntry[];
  customHeadersApplyTo: CustomHeadersApplyTo;
} {
  return {
    serverId: serverIndexKeyForProfile(server),
    appServerId: server.id,
    endpoints: serverAddressEndpoints(server).map(e => ({ url: e.url, kind: e.kind })),
    customHeaders: server.customHeaders ?? [],
    customHeadersApplyTo: server.customHeadersApplyTo ?? DEFAULT_CUSTOM_HEADERS_APPLY_TO,
  };
}
