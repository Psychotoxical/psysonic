import {
  buildSmartRulesPayload,
  parseSmartRulesToFilters,
  type BuildSmartRulesOptions,
  type SmartFilters,
} from './playlistsSmart';
import {
  parseSmartRulesDocument,
  type SmartRulePath,
  type SmartRulesDocument,
} from './smartPlaylistRules';

export type BasicSmartRulesProjection =
  | {
    ok: true;
    filters: SmartFilters;
    document: SmartRulesDocument;
  }
  | {
    ok: false;
    document: SmartRulesDocument;
    unsupportedPaths: SmartRulePath[];
  };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equalJson(value, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key)
      && equalJson(leftRecord[key], rightRecord[key]));
}

function differingPaths(
  source: unknown,
  projected: unknown,
  path: SmartRulePath = '/',
): SmartRulePath[] {
  if (equalJson(source, projected)) return [];
  if (Array.isArray(source) && Array.isArray(projected)) {
    const paths: SmartRulePath[] = [];
    const length = Math.max(source.length, projected.length);
    for (let index = 0; index < length; index++) {
      paths.push(...differingPaths(
        source[index],
        projected[index],
        `${path === '/' ? '' : path}/${index}` as SmartRulePath,
      ));
    }
    return paths.length > 0 ? paths : [path];
  }
  const sourceRecord = asRecord(source);
  const projectedRecord = asRecord(projected);
  if (sourceRecord && projectedRecord) {
    const keys = new Set([...Object.keys(sourceRecord), ...Object.keys(projectedRecord)]);
    const paths: SmartRulePath[] = [];
    for (const key of keys) {
      paths.push(...differingPaths(
        sourceRecord[key],
        projectedRecord[key],
        `${path === '/' ? '' : path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}` as SmartRulePath,
      ));
    }
    return paths.length > 0 ? paths : [path];
  }
  return [path];
}

/**
 * Projects only documents the existing Basic editor can reproduce exactly.
 * Complex, legacy, custom, opaque, and option-bearing documents remain in
 * Advanced/JSON mode instead of being silently simplified.
 */
export function projectSmartRulesToBasic(
  input: SmartRulesDocument | Record<string, unknown>,
  playlistName: string,
  options?: BuildSmartRulesOptions,
): BasicSmartRulesProjection {
  const document = 'raw' in input && 'opaquePaths' in input
    ? input as SmartRulesDocument
    : parseSmartRulesDocument(input);
  const filters = parseSmartRulesToFilters(
    document.raw as Record<string, unknown>,
    playlistName,
  );
  const rebuilt = buildSmartRulesPayload(filters, options);
  const unsupportedPaths = differingPaths(document.raw, rebuilt);

  if (unsupportedPaths.length > 0) {
    return {
      ok: false,
      document,
      unsupportedPaths: [...new Set(unsupportedPaths)],
    };
  }
  return { ok: true, filters, document };
}
