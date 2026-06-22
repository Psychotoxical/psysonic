/**
 * Redact secrets and partially mask remote server hostnames in PsyLab log lines.
 * Mirrors `psysonic_core::log_sanitize` (defense in depth for lines already buffered).
 */

const SENSITIVE_QUERY_KEYS = new Set([
  't', 's', 'p', 'token', 'password', 'passwd', 'secret', 'api_key', 'apikey',
  'access_token', 'refresh_token', 'auth',
]);

const SENSITIVE_KV_KEYS = [
  'password', 'passwd', 'token', 'secret', 'api_key', 'apikey',
  'access_token', 'refresh_token', 'authorization', 'auth',
  'cookie', 'x-api-key', 'cf-access-client-secret', 'cf-access-client-id', 'x-auth-token',
];

/** Gate / reverse-proxy header names — redact any `x-pangolin-*` prefix. */
const PANGOLIN_HEADER_RE = /(\bx-pangolin-[a-z0-9-]+\s*[:=]\s*)(\S+)/gi;

function isIpv4LanLiteral(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isIpv6LanHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === '::1') return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return isIpv4LanLiteral(dotted[1]!);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (hexMapped) {
    const v1 = parseInt(hexMapped[1]!, 16);
    const v2 = parseInt(hexMapped[2]!, 16);
    const ipv4 = `${(v1 >> 8) & 0xff}.${v1 & 0xff}.${(v2 >> 8) & 0xff}.${v2 & 0xff}`;
    return isIpv4LanLiteral(ipv4);
  }
  return false;
}

function isLanHost(host: string): boolean {
  const stripped = host.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (!stripped || stripped === 'localhost' || stripped.endsWith('.local')) return true;
  if (stripped.includes(':')) return isIpv6LanHostname(stripped);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(stripped)) return isIpv4LanLiteral(stripped);
  return false;
}

function maskPublicIpv4(ip: string): string {
  const parts = ip.split('.');
  if (parts.length !== 4) return '***';
  return `${parts[0]}.*.*.${parts[3]}`;
}

function maskHostname(host: string): string {
  const stripped = host.replace(/^\[|\]$/g, '');
  if (isLanHost(stripped)) return host;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(stripped)) return maskPublicIpv4(stripped);
  if (stripped.includes(':')) return '[ipv6-redacted]';

  const parts = stripped.split('.');
  if (parts.length === 0) return '***';

  const first = parts[0]!;
  const maskedFirst = first.length <= 2
    ? '*'.repeat(Math.max(1, first.length))
    : `${first.slice(0, 2)}${'*'.repeat(Math.min(4, Math.max(1, first.length - 2)))}`;

  return parts.length === 1 ? maskedFirst : `${maskedFirst}.${parts.slice(1).join('.')}`;
}

function splitHostPort(hostport: string): [string, string | null] {
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']:');
    if (end !== -1) return [hostport.slice(0, end + 1), hostport.slice(end + 2)];
    return [hostport, null];
  }
  const colon = hostport.lastIndexOf(':');
  if (colon > 0) {
    const host = hostport.slice(0, colon);
    const port = hostport.slice(colon + 1);
    if (/^\d+$/.test(port) && !host.includes(':')) return [host, port];
  }
  return [hostport, null];
}

function splitHostPath(rest: string): [string, string] {
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end !== -1) return [rest.slice(0, end + 1), rest.slice(end + 1)];
  }
  const slash = rest.indexOf('/');
  if (slash === -1) return [rest, ''];
  return [rest.slice(0, slash), rest.slice(slash)];
}

function redactQueryString(query: string): string {
  return query.split('&').map(pair => {
    const eq = pair.indexOf('=');
    const key = (eq === -1 ? pair : pair.slice(0, eq)).trim().toLowerCase();
    if (SENSITIVE_QUERY_KEYS.has(key)) {
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      return `${rawKey}=REDACTED`;
    }
    return pair;
  }).join('&');
}

function splitTrailingPunct(raw: string): [string, string] {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1]!;
    if (ch === ')' || ch === ']' || ch === ',') {
      end -= 1;
      continue;
    }
    break;
  }
  return [raw.slice(0, end), raw.slice(end)];
}

function redactUrl(raw: string): string {
  const [url, suffix] = splitTrailingPunct(raw);
  const schemeEnd = url.indexOf('://');
  if (schemeEnd === -1) return raw;

  let out = url.slice(0, schemeEnd + 3);
  let rest = url.slice(schemeEnd + 3);

  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    out += '***@';
    rest = rest.slice(at + 1);
  }

  const [hostport, path] = splitHostPath(rest);
  const [host, port] = splitHostPort(hostport);
  out += maskHostname(host);
  if (port) out += `:${port}`;

  const q = path.indexOf('?');
  if (q === -1) {
    out += path;
  } else {
    out += path.slice(0, q + 1);
    out += redactQueryString(path.slice(q + 1));
  }

  return out + suffix;
}

function redactBearerTokens(line: string): string {
  const marker = 'Bearer ';
  let s = line;
  let searchFrom = 0;
  while (true) {
    const idx = s.indexOf(marker, searchFrom);
    if (idx === -1) break;
    const start = idx + marker.length;
    const tail = s.slice(start);
    const endRel = tail.search(/[\s"')\]]/);
    const end = endRel === -1 ? s.length : start + endRel;
    if (end > start) {
      s = `${s.slice(0, start)}REDACTED${s.slice(end)}`;
    }
    searchFrom = start + 'REDACTED'.length;
  }
  return s;
}

function redactPangolinHeaders(line: string): string {
  return line.replace(PANGOLIN_HEADER_RE, '$1REDACTED');
}

function redactSensitiveKeyValues(line: string): string {
  let out = line;
  for (const key of SENSITIVE_KV_KEYS) {
    for (const sep of [':', '='] as const) {
      const needle = `${key}${sep}`;
      const lower = out.toLowerCase();
      let searchFrom = 0;
      while (true) {
        const rel = lower.indexOf(needle, searchFrom);
        if (rel === -1) break;
        const idx = rel;
        let valStart = idx + needle.length;
        while (out[valStart] === ' ') valStart += 1;
        const tail = out.slice(valStart);
        const endRel = tail.search(/[\s&,;)]/);
        const end = endRel === -1 ? out.length : valStart + endRel;
        if (end > valStart) {
          out = `${out.slice(0, valStart)}REDACTED${out.slice(end)}`;
        }
        searchFrom = valStart + 'REDACTED'.length;
        if (searchFrom >= out.length) break;
      }
    }
  }
  return out;
}

function redactUrlsInText(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const http = line.startsWith('http://', i);
    const https = line.startsWith('https://', i);
    const schemeLen = http ? 7 : https ? 8 : 0;
    if (schemeLen > 0) {
      const start = i;
      i += schemeLen;
      while (i < line.length) {
        const c = line[i]!;
        if (/\s/.test(c) || c === '"' || c === "'" || c === '>') break;
        if ((c === ')' || c === ']' || c === ',') && i + 1 < line.length) {
          const next = line[i + 1]!;
          if (/\s/.test(next) || next === '"' || next === "'") break;
        }
        i += 1;
      }
      out += redactUrl(line.slice(start, i));
    } else {
      out += line[i];
      i += 1;
    }
  }
  return out;
}

export function sanitizeLogLine(line: string): string {
  return redactUrlsInText(redactSensitiveKeyValues(redactPangolinHeaders(redactBearerTokens(line))));
}
