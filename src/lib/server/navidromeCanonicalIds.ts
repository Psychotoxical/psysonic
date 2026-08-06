import md5 from 'md5';

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_U128 = (1n << 128n) - 1n;
const confirmedOwners = new Set<string>();

export function canonicalizeNavidromeId(value: string): string {
  if (value.length === 22) {
    let parsed = 0n;
    for (const character of value) {
      const digit = BASE62.indexOf(character);
      if (digit < 0) return value;
      parsed = parsed * 62n + BigInt(digit);
      if (parsed > MAX_U128) return encodeCanonicalHex(md5(value));
    }
    return value;
  }
  if (/^[0-9a-fA-F]{32}$/.test(value)) return encodeCanonicalHex(value);
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    return encodeCanonicalHex(value.replace(/-/g, ''));
  }
  return value;
}

function encodeCanonicalHex(hex: string): string {
  let value = BigInt(`0x${hex}`);
  const encoded = Array<string>(22).fill('0');
  for (let index = encoded.length - 1; index >= 0 && value > 0n; index -= 1) {
    encoded[index] = BASE62[Number(value % 62n)];
    value /= 62n;
  }
  return encoded.join('');
}

export function activateCanonicalNavidromeOwners(owners: Iterable<string>): void {
  for (const owner of owners) {
    if (owner) confirmedOwners.add(owner);
  }
}

export function deactivateCanonicalNavidromeOwners(owners: Iterable<string>): void {
  for (const owner of owners) confirmedOwners.delete(owner);
}

export function canonicalizeConfirmedNavidromeId(owner: string, value: string): string {
  return confirmedOwners.has(owner) ? canonicalizeNavidromeId(value) : value;
}

export function canonicalizeConfirmedOwnedKey(key: string): string {
  const owner = [...confirmedOwners]
    .sort((a, b) => b.length - a.length)
    .find(candidate => key.startsWith(`${candidate}:`));
  if (!owner) return key;
  return `${owner}:${canonicalizeNavidromeId(key.slice(owner.length + 1))}`;
}
