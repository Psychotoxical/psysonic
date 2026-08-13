import md5 from 'md5';

const BASE62_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const U128_MAX = (1n << 128n) - 1n;

function decodeBase62(value: string): bigint | null {
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE62_DIGITS.indexOf(character);
    if (digit < 0) return null;
    decoded = decoded * 62n + BigInt(digit);
  }
  return decoded;
}

function encodeBase62(value: bigint): string {
  let remaining = value;
  const encoded = Array<string>(22).fill('0');
  let index = encoded.length;
  while (remaining > 0n) {
    index -= 1;
    encoded[index] = BASE62_DIGITS[Number(remaining % 62n)]!;
    remaining /= 62n;
  }
  return encoded.join('');
}

function hexToBigInt(value: string): bigint | null {
  if (!/^[0-9a-fA-F]{32}$/.test(value)) return null;
  return BigInt(`0x${value}`);
}

/** Exact TypeScript port of Navidrome's uniform canonical-ID migration helper. */
export function canonicalNavidromeId(value: string): string {
  let decoded: bigint | null = null;
  if (value.length === 22) {
    decoded = decodeBase62(value);
    if (decoded === null) return value;
    if (decoded <= U128_MAX) return value;
    decoded = hexToBigInt(md5(value));
  } else if (value.length === 32) {
    decoded = hexToBigInt(value);
  } else if (
    value.length === 36
    && value[8] === '-'
    && value[13] === '-'
    && value[18] === '-'
    && value[23] === '-'
  ) {
    decoded = hexToBigInt(value.replace(/-/g, ''));
  }
  return decoded === null ? value : encodeBase62(decoded);
}

function splitUpdateToken(value: string): [string, string | null] {
  const separator = value.lastIndexOf('_');
  if (separator < 0) return [value, null];
  const token = value.slice(separator + 1);
  return token.length > 0 && /^[0-9a-fA-F]+$/.test(token)
    ? [value.slice(0, separator), token]
    : [value, null];
}

/** Rewrite only the entity-bearing payload of a Navidrome artwork ID. */
export function canonicalNavidromeArtworkId(value: string): string {
  const prefix = ['mf-', 'al-', 'ar-', 'pl-', 'dc-', 'ra-']
    .find(candidate => value.startsWith(candidate));
  if (!prefix) return canonicalNavidromeId(value);

  const [payload, updateToken] = splitUpdateToken(value.slice(prefix.length));
  let rewritten = canonicalNavidromeId(payload);
  if (prefix === 'dc-') {
    const separator = payload.indexOf(':');
    rewritten = separator < 0
      ? payload
      : `${canonicalNavidromeId(payload.slice(0, separator))}${payload.slice(separator)}`;
  }
  return `${prefix}${rewritten}${updateToken ? `_${updateToken}` : ''}`;
}
