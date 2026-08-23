import {
  findSmartRuleField,
  findSmartRuleOperator,
  getSmartRuleOperatorsForField,
  isSmartRuleFieldAvailable,
  isSmartRuleNumberInBounds,
  resolveSmartPlaylistCapabilities,
  type SmartPlaylistCapabilities,
  type SmartRuleFieldDefinition,
  type SmartRuleFieldType,
} from './smartPlaylistFields';

export type SmartRulePath = `/${string}`;
export type SmartRuleCombinator = 'all' | 'any';

interface SmartRuleNodeBase {
  path: SmartRulePath;
  raw: unknown;
}

export interface SmartRuleGroupNode extends SmartRuleNodeBase {
  kind: 'group';
  combinator: SmartRuleCombinator;
  children: SmartRuleAstNode[];
}

export interface SmartRuleLeafNode extends SmartRuleNodeBase {
  kind: 'rule';
  operator: string;
  field: string;
  value: unknown;
}

export interface SmartRuleOpaqueNode extends SmartRuleNodeBase {
  kind: 'opaque';
}

export type SmartRuleAstNode = SmartRuleGroupNode | SmartRuleLeafNode | SmartRuleOpaqueNode;

export interface SmartRulesDocument {
  /** Exact object supplied by the server or JSON editor. Never normalized. */
  raw: Readonly<Record<string, unknown>>;
  /** Recursive editable view. Opaque nodes retain their exact raw value. */
  root: SmartRuleGroupNode | null;
  opaquePaths: SmartRulePath[];
}

const ROOT_OPTIONS = new Set(['sort', 'order', 'limit', 'limitPercent', 'offset']);
const UNRELEASED_ROOT_KEYS = new Set(['refreshDelay']);
const UNRELEASED_FIELD_NAMES = new Set([
  'albumdateadded',
  'albumdatemodified',
  'albumduration',
  'albumsongcount',
  'albumsize',
]);
const OMIT_FROM_EMISSION = Symbol('omit-from-smart-rules');

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function childPath(path: SmartRulePath, segment: string | number): SmartRulePath {
  const prefix = path === '/' ? '' : path;
  return `${prefix}/${escapePointerSegment(String(segment))}` as SmartRulePath;
}

function adaptNode(raw: unknown, path: SmartRulePath, opaquePaths: SmartRulePath[]): SmartRuleAstNode {
  const record = asRecord(raw);
  if (!record) {
    opaquePaths.push(path);
    return { kind: 'opaque', path, raw };
  }

  const keys = Object.keys(record);
  const groupKeys = keys.filter(key => key === 'all' || key === 'any');
  if (keys.length === 1 && groupKeys.length === 1 && Array.isArray(record[groupKeys[0]])) {
    const combinator = groupKeys[0] as SmartRuleCombinator;
    const groupPath = childPath(path, combinator);
    return {
      kind: 'group',
      combinator,
      path,
      raw,
      children: (record[combinator] as unknown[])
        .map((node, index) => adaptNode(node, childPath(groupPath, index), opaquePaths)),
    };
  }

  if (keys.length === 1) {
    const operator = keys[0];
    const fields = asRecord(record[operator]);
    const fieldKeys = fields ? Object.keys(fields) : [];
    if (fields && fieldKeys.length === 1) {
      const field = fieldKeys[0];
      return {
        kind: 'rule',
        operator,
        field,
        value: fields[field],
        path,
        raw,
      };
    }
  }

  opaquePaths.push(path);
  return { kind: 'opaque', path, raw };
}

/**
 * Creates a recursive AST without rewriting the source. Invalid and future
 * nodes become opaque, so a structured edit can patch around them losslessly.
 */
export function parseSmartRulesDocument(input: unknown): SmartRulesDocument {
  const raw = asRecord(input) ?? {};
  const opaquePaths: SmartRulePath[] = [];
  const rootKeys = (['all', 'any'] as const).filter(key => Object.prototype.hasOwnProperty.call(raw, key));
  let root: SmartRuleGroupNode | null = null;

  if (rootKeys.length === 1 && Array.isArray(raw[rootKeys[0]])) {
    const combinator = rootKeys[0];
    const rootPath = `/${combinator}` as SmartRulePath;
    root = {
      kind: 'group',
      combinator,
      path: rootPath,
      raw: { [combinator]: raw[combinator] },
      children: (raw[combinator] as unknown[])
        .map((node, index) => adaptNode(node, childPath(rootPath, index), opaquePaths)),
    };
  } else {
    opaquePaths.push('/');
  }

  return { raw, root, opaquePaths };
}

/** Returns the canonical raw object unchanged. */
export function smartRulesDocumentToRaw(
  document: SmartRulesDocument,
): Readonly<Record<string, unknown>> {
  return document.raw;
}

function cloneContainer(value: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return [...value];
  const record = asRecord(value);
  if (record) return { ...record };
  throw new Error('Cannot patch through a non-container smart-rule value');
}

function pointerSegments(path: SmartRulePath): string[] {
  if (path === '/') return [];
  return path.slice(1).split('/').map(unescapePointerSegment);
}

function setAtPath(root: Record<string, unknown>, path: SmartRulePath, value: unknown): Record<string, unknown> {
  const segments = pointerSegments(path);
  if (segments.length === 0) {
    const next = asRecord(value);
    if (!next) throw new Error('Smart-rule document root must be an object');
    return next;
  }

  const output = { ...root };
  let sourceCursor: unknown = root;
  let targetCursor: Record<string, unknown> | unknown[] = output;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const sourceContainer = sourceCursor as Record<string, unknown> | unknown[];
    const sourceChild = sourceContainer[segment as keyof typeof sourceContainer];
    const targetChild = cloneContainer(sourceChild);
    targetCursor[segment as keyof typeof targetCursor] = targetChild as never;
    sourceCursor = sourceChild;
    targetCursor = targetChild;
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(targetCursor)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index > targetCursor.length) {
      throw new Error(`Invalid smart-rule array path: ${path}`);
    }
    if (index === targetCursor.length) targetCursor.push(value);
    else targetCursor[index] = value;
  } else {
    targetCursor[last] = value;
  }
  return output;
}

function removeAtPath(root: Record<string, unknown>, path: SmartRulePath): Record<string, unknown> {
  const segments = pointerSegments(path);
  if (segments.length === 0) throw new Error('Cannot remove the smart-rule document root');

  const output = { ...root };
  let sourceCursor: unknown = root;
  let targetCursor: Record<string, unknown> | unknown[] = output;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const sourceContainer = sourceCursor as Record<string, unknown> | unknown[];
    const sourceChild = sourceContainer[segment as keyof typeof sourceContainer];
    const targetChild = cloneContainer(sourceChild);
    targetCursor[segment as keyof typeof targetCursor] = targetChild as never;
    sourceCursor = sourceChild;
    targetCursor = targetChild;
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(targetCursor)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= targetCursor.length) {
      throw new Error(`Invalid smart-rule array path: ${path}`);
    }
    targetCursor.splice(index, 1);
  } else {
    delete targetCursor[last];
  }
  return output;
}

/** Immutable JSON-pointer patch used by the Advanced editor. */
export function setSmartRuleValue(
  document: SmartRulesDocument,
  path: SmartRulePath,
  value: unknown,
): SmartRulesDocument {
  return parseSmartRulesDocument(setAtPath(document.raw as Record<string, unknown>, path, value));
}

/** Immutable removal that leaves all sibling/opaque data untouched. */
export function removeSmartRuleValue(
  document: SmartRulesDocument,
  path: SmartRulePath,
): SmartRulesDocument {
  return parseSmartRulesDocument(removeAtPath(document.raw as Record<string, unknown>, path));
}

function isUnreleasedLeaf(record: Record<string, unknown>): boolean {
  const operatorKeys = Object.keys(record);
  if (operatorKeys.length !== 1 || operatorKeys[0] === 'all' || operatorKeys[0] === 'any') return false;
  const fields = asRecord(record[operatorKeys[0]]);
  const fieldKeys = fields ? Object.keys(fields) : [];
  return fieldKeys.length === 1 && UNRELEASED_FIELD_NAMES.has(fieldKeys[0].toLowerCase());
}

function cloneForEmission(
  value: unknown,
  atRoot = false,
  ruleNode = false,
): unknown | typeof OMIT_FROM_EMISSION {
  if (Array.isArray(value)) {
    return value
      .map(item => cloneForEmission(item, false, ruleNode))
      .filter(item => item !== OMIT_FROM_EMISSION);
  }
  const record = asRecord(value);
  if (!record) return value;
  if (ruleNode && isUnreleasedLeaf(record)) return OMIT_FROM_EMISSION;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (atRoot && UNRELEASED_ROOT_KEYS.has(key)) continue;
    const emitted = cloneForEmission(child, false, key === 'all' || key === 'any');
    if (emitted !== OMIT_FROM_EMISSION) output[key] = emitted;
  }
  return output;
}

/**
 * Builds the save payload. Unknown released/future JSON is retained; explicitly
 * unreleased root options are held in the document but never sent.
 */
export function emitSmartRulesDocument(document: SmartRulesDocument): Record<string, unknown> {
  return cloneForEmission(document.raw, true) as Record<string, unknown>;
}

export type SmartRuleValidationSeverity = 'error' | 'warning';

export interface SmartRuleValidationIssue {
  code:
    | 'root_required'
    | 'root_conflict'
    | 'empty_group'
    | 'invalid_group'
    | 'invalid_rule'
    | 'unknown_operator'
    | 'unsupported_operator'
    | 'unknown_field'
    | 'unsupported_field'
    | 'invalid_value'
    | 'self_reference'
    | 'invalid_option'
    | 'unsupported_option'
    | 'opaque_path';
  severity: SmartRuleValidationSeverity;
  path: SmartRulePath;
  message: string;
  blocksStructuredEdit: boolean;
}

export interface ValidateSmartRulesOptions {
  currentPlaylistId?: string;
  capabilities?: SmartPlaylistCapabilities;
  customFields?: readonly SmartRuleFieldDefinition[];
}

function issue(
  issues: SmartRuleValidationIssue[],
  value: Omit<SmartRuleValidationIssue, 'blocksStructuredEdit'> & { blocksStructuredEdit?: boolean },
): void {
  issues.push({ blocksStructuredEdit: true, ...value });
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function isValidSmartRuleDate(value: unknown): boolean {
  return validDate(value);
}

function formatOperatorLabel(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function validScalar(value: unknown, type: SmartRuleFieldType): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date':
      return validDate(value);
    case 'playlist':
    case 'string':
      return typeof value === 'string';
  }
}

function validateRuleValue(
  operator: string,
  field: SmartRuleFieldDefinition,
  value: unknown,
): boolean {
  const canonicalOperator = findSmartRuleOperator(operator)?.name;
  if (!canonicalOperator) return true;
  if (canonicalOperator === 'isMissing' || canonicalOperator === 'isPresent') {
    return typeof value === 'boolean';
  }
  if (canonicalOperator === 'inTheLast' || canonicalOperator === 'notInTheLast') {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
  }
  if (canonicalOperator === 'before' || canonicalOperator === 'after') return validDate(value);
  if (canonicalOperator === 'gt' || canonicalOperator === 'lt') {
    return typeof value === 'number' && Number.isFinite(value) && isSmartRuleNumberInBounds(value, field);
  }
  if (canonicalOperator === 'contains' || canonicalOperator === 'notContains'
    || canonicalOperator === 'startsWith' || canonicalOperator === 'endsWith') {
    return typeof value === 'string' && value.length > 0;
  }
  if (canonicalOperator === 'inTheRange') {
    if (!Array.isArray(value) || value.length !== 2) return false;
    if (!validScalar(value[0], field.type) || !validScalar(value[1], field.type)) return false;
    if (field.type === 'number'
      && (!isSmartRuleNumberInBounds(value[0], field) || !isSmartRuleNumberInBounds(value[1], field))) {
      return false;
    }
    return value[0] <= value[1];
  }
  if (field.type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
    return isSmartRuleNumberInBounds(value, field);
  }
  return validScalar(value, field.type);
}

function validatePlaylistRule(
  record: Record<string, unknown>,
  operator: string,
  path: SmartRulePath,
  options: ValidateSmartRulesOptions,
  issues: SmartRuleValidationIssue[],
): void {
  const value = asRecord(record[operator]);
  if (!value || Object.keys(value).length !== 1 || typeof value.id !== 'string' || !value.id.trim()) {
    issue(issues, {
      code: 'invalid_value',
      severity: 'error',
      path: childPath(path, operator),
      message: 'Playlist membership rules require exactly one non-empty id field.',
    });
    return;
  }
  if (options.currentPlaylistId && value.id === options.currentPlaylistId) {
    issue(issues, {
      code: 'self_reference',
      severity: 'error',
      path: childPath(childPath(path, operator), 'id'),
      message: 'A smart playlist cannot reference itself directly.',
    });
  }
}

function validateExpression(
  raw: unknown,
  path: SmartRulePath,
  options: ValidateSmartRulesOptions,
  capabilities: SmartPlaylistCapabilities,
  issues: SmartRuleValidationIssue[],
): void {
  const record = asRecord(raw);
  if (!record) {
    issue(issues, {
      code: 'invalid_rule',
      severity: 'error',
      path,
      message: 'Each rule must be an object.',
    });
    return;
  }
  const keys = Object.keys(record);
  const groupKeys = keys.filter(key => key === 'all' || key === 'any');
  if (groupKeys.length > 0) {
    if (keys.length !== 1 || groupKeys.length !== 1 || !Array.isArray(record[groupKeys[0]])) {
      issue(issues, {
        code: 'invalid_group',
        severity: 'error',
        path,
        message: 'A nested group must contain exactly one all or any array.',
      });
      return;
    }
    const group = record[groupKeys[0]] as unknown[];
    const groupPath = childPath(path, groupKeys[0]);
    if (group.length === 0) {
      issue(issues, {
        code: 'empty_group',
        severity: 'error',
        path: groupPath,
        message: 'Rule groups cannot be empty.',
      });
    }
    group.forEach((node, index) => {
      validateExpression(node, childPath(groupPath, index), options, capabilities, issues);
    });
    return;
  }

  if (keys.length !== 1) {
    issue(issues, {
      code: 'invalid_rule',
      severity: 'error',
      path,
      message: 'Each leaf rule must contain exactly one operator.',
    });
    return;
  }

  const operatorName = keys[0];
  const operator = findSmartRuleOperator(operatorName);
  if (!operator) {
    issue(issues, {
      code: 'unknown_operator',
      severity: 'warning',
      path: childPath(path, operatorName),
      message: `Unknown operator "${operatorName}" is preserved for JSON editing.`,
    });
    return;
  }
  if ((operator.name === 'inPlaylist' || operator.name === 'notInPlaylist')) {
    if (!capabilities.playlistReferences) {
      issue(issues, {
        code: 'unsupported_operator',
        severity: 'warning',
        path: childPath(path, operatorName),
        message: `${operator.name} is not available on this Navidrome version.`,
      });
    }
    validatePlaylistRule(record, operatorName, path, options, issues);
    return;
  }

  const fields = asRecord(record[operatorName]);
  if (!fields || Object.keys(fields).length !== 1) {
    issue(issues, {
      code: 'invalid_rule',
      severity: 'error',
      path: childPath(path, operatorName),
      message: 'Each operator must contain exactly one field.',
    });
    return;
  }

  const fieldName = Object.keys(fields)[0];
  const fieldPath = childPath(childPath(path, operatorName), fieldName);
  if (UNRELEASED_FIELD_NAMES.has(fieldName.toLowerCase())) {
    issue(issues, {
      code: 'unsupported_field',
      severity: 'warning',
      path: fieldPath,
      message: `Field "${fieldName}" is not present in a released Navidrome version and will not be emitted.`,
    });
    return;
  }
  const field = findSmartRuleField(fieldName, options.customFields);
  if (!field) {
    issue(issues, {
      code: 'unknown_field',
      severity: 'warning',
      path: fieldPath,
      message: `Unknown field "${fieldName}" needs an explicit custom type for structured editing.`,
    });
    return;
  }
  if (!isSmartRuleFieldAvailable(field, capabilities)) {
    issue(issues, {
      code: 'unsupported_field',
      severity: 'warning',
      path: fieldPath,
      message: `Field "${fieldName}" is not available on this Navidrome version.`,
    });
    return;
  }
  const allowed = getSmartRuleOperatorsForField(field, capabilities).some(item => item.name === operator.name);
  if (!allowed) {
    issue(issues, {
      code: 'unsupported_operator',
      severity: 'error',
      path: childPath(path, operatorName),
      message: `${formatOperatorLabel(operator.name)} is not supported for field "${fieldName}".`,
    });
    return;
  }
  if (!validateRuleValue(operatorName, field, fields[fieldName])) {
    issue(issues, {
      code: 'invalid_value',
      severity: 'error',
      path: fieldPath,
      message: `Invalid ${field.type} value for ${formatOperatorLabel(operator.name)}.`,
    });
  }
}

function validateRootOptions(
  raw: Readonly<Record<string, unknown>>,
  capabilities: SmartPlaylistCapabilities,
  customFields: readonly SmartRuleFieldDefinition[],
  issues: SmartRuleValidationIssue[],
): void {
  if (Object.prototype.hasOwnProperty.call(raw, 'limit')) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit <= 0) {
      issue(issues, {
        code: 'invalid_option',
        severity: 'error',
        path: '/limit',
        message: 'limit must be a positive integer.',
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'limitPercent')) {
    if (typeof raw.limitPercent !== 'number' || !Number.isInteger(raw.limitPercent)
      || raw.limitPercent < 1 || raw.limitPercent > 100) {
      issue(issues, {
        code: 'invalid_option',
        severity: 'error',
        path: '/limitPercent',
        message: 'limitPercent must be an integer from 1 to 100.',
      });
    } else if (!capabilities.percentageLimit) {
      issue(issues, {
        code: 'unsupported_option',
        severity: 'warning',
        path: '/limitPercent',
        message: 'Percentage limits require Navidrome 0.61 or newer.',
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'limit')
    && Object.prototype.hasOwnProperty.call(raw, 'limitPercent')) {
    issue(issues, {
      code: 'invalid_option',
      severity: 'error',
      path: '/limitPercent',
      message: 'Use either limit or limitPercent; a fixed limit otherwise silently takes precedence.',
    });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'offset')
    && (typeof raw.offset !== 'number' || !Number.isInteger(raw.offset) || raw.offset < 0)) {
    issue(issues, {
      code: 'invalid_option',
      severity: 'error',
      path: '/offset',
      message: 'offset must be a non-negative integer.',
    });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'order')
    && (typeof raw.order !== 'string' || !/^(asc|desc)$/i.test(raw.order))) {
    issue(issues, {
      code: 'invalid_option',
      severity: 'error',
      path: '/order',
      message: 'Legacy order must be asc or desc.',
    });
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'sort')) {
    if (typeof raw.sort !== 'string' || !raw.sort.trim()) {
      issue(issues, {
        code: 'invalid_option',
        severity: 'error',
        path: '/sort',
        message: 'sort must be a non-empty comma-separated string.',
      });
    } else {
      const sortFields = raw.sort.split(',').map(value => value.trim()).filter(Boolean);
      if (sortFields.length > 1 && !capabilities.multiSort) {
        issue(issues, {
          code: 'unsupported_option',
          severity: 'warning',
          path: '/sort',
          message: 'Multiple sort fields require Navidrome 0.57 or newer.',
        });
      }
      for (const token of sortFields) {
        const fieldName = token.replace(/^[+-]/, '');
        const field = findSmartRuleField(fieldName, customFields);
        if (!field || field.sortable === false) {
          issue(issues, {
            code: field ? 'invalid_option' : 'unknown_field',
            severity: field ? 'error' : 'warning',
            path: '/sort',
            message: field
              ? `Field "${fieldName}" cannot be used for sorting.`
              : `Unknown sort field "${fieldName}" is preserved for JSON editing.`,
          });
        } else if (!isSmartRuleFieldAvailable(field, capabilities)) {
          issue(issues, {
            code: 'unsupported_field',
            severity: 'warning',
            path: '/sort',
            message: `Sort field "${fieldName}" is not available on this Navidrome version.`,
          });
        }
      }
    }
  }

  for (const key of Object.keys(raw)) {
    if (key === 'all' || key === 'any' || ROOT_OPTIONS.has(key)) continue;
    issue(issues, {
      code: UNRELEASED_ROOT_KEYS.has(key) ? 'unsupported_option' : 'opaque_path',
      severity: 'warning',
      path: childPath('/', key),
      message: UNRELEASED_ROOT_KEYS.has(key)
        ? `${key} is not present in a released Navidrome version and will not be emitted.`
        : `Unknown root property "${key}" is preserved for JSON editing.`,
    });
  }
}

/** Structural, semantic, field/operator, and server-version validation. */
export function validateSmartRulesDocument(
  document: SmartRulesDocument,
  options: ValidateSmartRulesOptions = {},
): SmartRuleValidationIssue[] {
  const issues: SmartRuleValidationIssue[] = [];
  const capabilities = options.capabilities ?? resolveSmartPlaylistCapabilities('0.63.2');
  const roots = (['all', 'any'] as const)
    .filter(key => Object.prototype.hasOwnProperty.call(document.raw, key));

  if (roots.length === 0) {
    issue(issues, {
      code: 'root_required',
      severity: 'error',
      path: '/',
      message: 'Exactly one non-empty all or any root is required.',
    });
  } else if (roots.length > 1) {
    issue(issues, {
      code: 'root_conflict',
      severity: 'error',
      path: '/',
      message: 'all and any cannot both be used at the root.',
    });
  } else if (!Array.isArray(document.raw[roots[0]])) {
    issue(issues, {
      code: 'invalid_group',
      severity: 'error',
      path: `/${roots[0]}`,
      message: 'The root group must be an array.',
    });
  } else {
    const rules = document.raw[roots[0]] as unknown[];
    if (rules.length === 0) {
      issue(issues, {
        code: 'empty_group',
        severity: 'error',
        path: `/${roots[0]}`,
        message: 'The root rule group cannot be empty.',
      });
    }
    rules.forEach((node, index) => {
      validateExpression(
        node,
        `/${roots[0]}/${index}` as SmartRulePath,
        options,
        capabilities,
        issues,
      );
    });
  }

  validateRootOptions(document.raw, capabilities, options.customFields ?? [], issues);
  return issues;
}

export function unsupportedSmartRulePaths(
  document: SmartRulesDocument,
  options: ValidateSmartRulesOptions = {},
): SmartRulePath[] {
  return [...new Set(
    validateSmartRulesDocument(document, options)
      .filter(item => item.blocksStructuredEdit)
      .map(item => item.path),
  )];
}
