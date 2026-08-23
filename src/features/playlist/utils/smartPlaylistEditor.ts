import {
  buildSmartRulesPayload,
  defaultSmartFilters,
  type BuildSmartRulesOptions,
  type SmartFilters,
} from './playlistsSmart';
import { projectSmartRulesToBasic } from './smartPlaylistBasicProjection';
import {
  emitSmartRulesDocument,
  parseSmartRulesDocument,
  smartRulesDocumentToRaw,
  validateSmartRulesDocument,
  type SmartRulePath,
  type SmartRulesDocument,
} from './smartPlaylistRules';

export type SmartEditorMode = 'basic' | 'advanced' | 'json';

export interface SmartEditorSession {
  mode: SmartEditorMode;
  filters: SmartFilters;
  document: SmartRulesDocument;
  comment: string;
  public: boolean;
  owner: string;
  lastEvaluatedAt: string | null;
  evaluatedAt: string | null;
  updatedAt: string | null;
  jsonDraft: string;
  jsonError: string | null;
  basicBlockedPaths: SmartRulePath[];
}

export interface CreateSmartEditorSessionInput {
  name?: string;
  rules?: unknown;
  comment?: string;
  public?: boolean;
  owner?: string;
  lastEvaluatedAt?: string | null;
  evaluatedAt?: string | null;
  updatedAt?: string | null;
  allGenres?: string[];
}

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

function prettyRules(document: SmartRulesDocument): string {
  return JSON.stringify(smartRulesDocumentToRaw(document), null, 2);
}

export function createSmartEditorSession(
  input: CreateSmartEditorSessionInput = {},
): SmartEditorSession {
  const name = input.name ?? '';
  const hasRules = input.rules !== undefined;
  const document = parseSmartRulesDocument(
    hasRules
      ? input.rules
      : buildSmartRulesPayload({ ...defaultSmartFilters, name }),
  );
  const projection = projectSmartRulesToBasic(document, name, { allGenres: input.allGenres });
  const filters = projection.ok ? projection.filters : { ...defaultSmartFilters, name };
  return {
    mode: projection.ok ? 'basic' : 'advanced',
    filters,
    document,
    comment: input.comment ?? '',
    public: input.public ?? false,
    owner: input.owner ?? '',
    lastEvaluatedAt: input.lastEvaluatedAt ?? null,
    evaluatedAt: input.evaluatedAt ?? null,
    updatedAt: input.updatedAt ?? null,
    jsonDraft: prettyRules(document),
    jsonError: null,
    basicBlockedPaths: projection.ok ? [] : projection.unsupportedPaths,
  };
}

export function syncSessionFromBasicFilters(
  session: SmartEditorSession,
  filters: SmartFilters,
  options?: BuildSmartRulesOptions,
): SmartEditorSession {
  const document = parseSmartRulesDocument(buildSmartRulesPayload(filters, options));
  return {
    ...session,
    filters,
    document,
    jsonDraft: prettyRules(document),
    jsonError: null,
    basicBlockedPaths: [],
  };
}

export function requestSmartEditorMode(
  session: SmartEditorSession,
  mode: SmartEditorMode,
  options?: BuildSmartRulesOptions,
): SmartEditorSession {
  const source = session.mode === 'basic' && mode !== 'basic'
    ? syncSessionFromBasicFilters(session, session.filters, options)
    : session;
  if (mode === 'basic') {
    const projection = projectSmartRulesToBasic(source.document, source.filters.name, options);
    if (!projection.ok) {
      return {
        ...source,
        mode: source.mode === 'json' ? 'json' : 'advanced',
        basicBlockedPaths: projection.unsupportedPaths,
      };
    }
    return {
      ...source,
      mode: 'basic',
      filters: projection.filters,
      basicBlockedPaths: [],
      jsonError: null,
    };
  }
  if (mode === 'json') {
    return {
      ...source,
      mode: 'json',
      jsonDraft: prettyRules(source.document),
      jsonError: null,
    };
  }
  return { ...source, mode: 'advanced' };
}

export function applySmartEditorJson(
  session: SmartEditorSession,
  jsonText: string,
  options?: BuildSmartRulesOptions,
): SmartEditorSession {
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const document = parseSmartRulesDocument(parsed);
    const projection = projectSmartRulesToBasic(document, session.filters.name, options);
    return {
      ...session,
      document,
      jsonDraft: prettyRules(document),
      jsonError: null,
      filters: projection.ok ? projection.filters : session.filters,
      basicBlockedPaths: projection.ok ? [] : projection.unsupportedPaths,
      mode: projection.ok || session.mode !== 'basic' ? session.mode : 'advanced',
    };
  } catch (error) {
    return {
      ...session,
      jsonDraft: jsonText,
      jsonError: error instanceof Error ? error.message : 'Invalid JSON',
    };
  }
}

/** Rules currently shown in the active editor page, including unsaved JSON. */
export function previewRulesFromSession(
  session: SmartEditorSession,
  options?: BuildSmartRulesOptions,
): Record<string, unknown> {
  if (session.mode === 'json') {
    const parsed = JSON.parse(session.jsonDraft) as unknown;
    return emitSmartRulesDocument(parseSmartRulesDocument(parsed));
  }
  if (session.mode === 'basic') {
    return emitSmartRulesDocument(parseSmartRulesDocument(
      buildSmartRulesPayload(session.filters, options),
    ));
  }
  return emitSmartRulesDocument(session.document);
}

export function hasEmptySmartCriteria(document: SmartRulesDocument): boolean {
  return validateSmartRulesDocument(document).some(issue =>
    issue.severity === 'error' && (issue.code === 'root_required' || issue.code === 'empty_group'),
  );
}

function droppedPaths(
  sent: unknown,
  persisted: unknown,
  path: SmartRulePath = '/',
): SmartRulePath[] {
  if (equalJson(sent, persisted)) return [];
  if (persisted === undefined) return [path];
  if (Array.isArray(sent)) {
    if (!Array.isArray(persisted)) return [path];
    const paths: SmartRulePath[] = [];
    sent.forEach((value, index) => {
      paths.push(...droppedPaths(
        value,
        persisted[index],
        `${path === '/' ? '' : path}/${index}` as SmartRulePath,
      ));
    });
    return paths;
  }
  const sentRecord = asRecord(sent);
  const persistedRecord = asRecord(persisted);
  if (sentRecord && persistedRecord) {
    return Object.keys(sentRecord).flatMap(key => droppedPaths(
      sentRecord[key],
      persistedRecord[key],
      `${path === '/' ? '' : path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}` as SmartRulePath,
    ));
  }
  return equalJson(sent, persisted) ? [] : [path];
}

export function comparePersistedSmartRules(
  sent: Record<string, unknown>,
  persisted: Record<string, unknown> | undefined,
): SmartRulePath[] {
  if (!persisted) return ['/'];
  return [...new Set(droppedPaths(sent, persisted))];
}

export interface SmartSortRow {
  field: string;
  direction: '+' | '-';
}

export function parseSmartSortRows(sort: unknown): SmartSortRow[] {
  if (typeof sort !== 'string' || !sort.trim()) return [];
  return sort.split(',')
    .map(token => token.trim())
    .filter(Boolean)
    .map(token => ({
      direction: token.startsWith('-') ? '-' as const : '+' as const,
      field: token.replace(/^[+-]/, ''),
    }))
    .filter(row => row.field);
}

export function emitSmartSortRows(rows: SmartSortRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  return rows.map(row => `${row.direction}${row.field}`).join(',');
}

export function defaultSmartRuleLeaf(): Record<string, unknown> {
  return { contains: { title: '' } };
}

export function defaultSmartRuleGroup(): Record<string, unknown> {
  return { all: [defaultSmartRuleLeaf()] };
}
