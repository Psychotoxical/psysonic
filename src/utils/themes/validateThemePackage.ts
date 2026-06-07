import allowedTokens from './contract/allowed-tokens.json';
import { validateThemeCss } from './themeInjection';
import { FIXED_THEMES } from '../../components/settings/fixedThemes';

/**
 * Full theme-package validation for locally imported themes (a .zip holding
 * manifest.json + theme.css). This is the in-app mirror of the repo CI
 * contract check (`scripts/validate-theme.mjs`): it enforces the exact same
 * manifest schema and CSS token whitelist, using a byte-identical copy of
 * `schema/allowed-tokens.json` and the schema's own field patterns.
 *
 * Layering: `validateThemeCss` (themeInjection) is the security/containment
 * guard — it guarantees the CSS is a single, scoped, at-rule-free rule with
 * data-URI-only `url()`. Once that holds, the declaration list is a flat
 * `prop: value;` sequence we can extract safely (no nesting) and check against
 * the contract here. The same `validateThemeCss` runs again at injection time,
 * so a theme that slips past this is still contained at the boundary.
 */

const noMeta = (o: Record<string, unknown>): string[] =>
  Object.keys(o || {}).filter((k) => !k.startsWith('$'));

const CORE = noMeta(allowedTokens.core as Record<string, unknown>);
const ALLOWED = new Set([
  ...CORE,
  ...noMeta(allowedTokens.optional as Record<string, unknown>),
  ...noMeta(allowedTokens.granular as Record<string, unknown>),
]);
const DATA_URI_TOKENS = new Set(allowedTokens.dataUriTokens as string[]);
const SCHEME_VALUES = new Set(allowedTokens.colorScheme.values as string[]);
const BUILTIN_IDS = new Set(FIXED_THEMES.map((f) => f.id));

// Field patterns copied verbatim from schema/manifest.schema.json so the
// in-app check stays identical to CI without bundling a JSON-schema engine.
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AUTHOR_RE = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const APP_VER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MANIFEST_KEYS = new Set([
  'id', 'name', 'author', 'version', 'description', 'mode', 'tags', 'minAppVersion',
]);

export interface ValidatedTheme {
  id: string;
  name: string;
  author: string;
  version: string;
  description: string;
  mode: 'dark' | 'light';
  tags?: string[];
  css: string;
}

export type ValidateResult =
  | { ok: true; theme: ValidatedTheme }
  | { ok: false; errors: string[] };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The declarations inside the single `[data-theme='<id>']` rule, or null. */
function ruleBody(css: string, id: string): string | null {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const sel = `\\[data-theme=(['"])${escapeRegExp(id)}\\1\\]`;
  const m = stripped.match(new RegExp(`^${sel}\\s*\\{([^{}]*)\\}$`));
  return m ? m[2] : null;
}

/**
 * Split a flat declaration body on top-level `;` only — never inside `()` or a
 * quoted string, so a `url("data:image/svg+xml;...")` value (the `;` in the
 * MIME type / SVG) stays intact.
 */
function splitDeclarations(body: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { if (depth > 0) depth--; cur += ch; continue; }
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function validateThemePackage(manifestText: string, css: string): ValidateResult {
  const errors: string[] = [];

  // ---- manifest ----
  let m: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, errors: ['manifest.json must be a JSON object'] };
    }
    m = parsed as Record<string, unknown>;
  } catch (e) {
    return { ok: false, errors: [`manifest.json is not valid JSON: ${(e as Error).message}`] };
  }

  for (const k of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(k)) errors.push(`manifest has an unknown property "${k}"`);
  }

  const str = (k: string): string | null => (typeof m[k] === 'string' ? (m[k] as string) : null);

  const id = str('id');
  if (id === null) errors.push('manifest.id is required and must be a string');
  else {
    if (!ID_RE.test(id) || id.length < 2 || id.length > 48) {
      errors.push('manifest.id must be lowercase kebab-case, 2–48 chars');
    }
    if (BUILTIN_IDS.has(id)) errors.push(`manifest.id "${id}" collides with a built-in theme`);
  }

  const name = str('name');
  if (name === null) errors.push('manifest.name is required and must be a string');
  else if (name.length < 1 || name.length > 50) errors.push('manifest.name must be 1–50 chars');

  const author = str('author');
  if (author === null) errors.push('manifest.author is required and must be a string');
  else if (!AUTHOR_RE.test(author)) errors.push('manifest.author must be a GitHub handle (no leading @)');

  const version = str('version');
  if (version === null) errors.push('manifest.version is required and must be a string');
  else if (!SEMVER_RE.test(version)) errors.push('manifest.version must be a SemVer string (e.g. 1.0.0)');

  const description = str('description');
  if (description === null) errors.push('manifest.description is required and must be a string');
  else if (description.length < 1 || description.length > 200) errors.push('manifest.description must be 1–200 chars');

  const mode = str('mode');
  if (mode === null) errors.push('manifest.mode is required and must be a string');
  else if (mode !== 'dark' && mode !== 'light') errors.push('manifest.mode must be "dark" or "light"');

  if (m.tags !== undefined) {
    const tags = m.tags;
    if (!Array.isArray(tags)) errors.push('manifest.tags must be an array');
    else {
      if (tags.length > 8) errors.push('manifest.tags allows at most 8 items');
      if (new Set(tags).size !== tags.length) errors.push('manifest.tags must be unique');
      for (const tag of tags) {
        if (typeof tag !== 'string' || !TAG_RE.test(tag) || tag.length > 24) {
          errors.push(`manifest.tags has an invalid tag: ${JSON.stringify(tag)}`);
        }
      }
    }
  }

  if (m.minAppVersion !== undefined) {
    if (typeof m.minAppVersion !== 'string' || !APP_VER_RE.test(m.minAppVersion)) {
      errors.push('manifest.minAppVersion must be a version like 1.2.3');
    }
  }

  // ---- css ----
  // The selector check needs a valid id; if the id is bad, skip the CSS rule
  // checks (they would all fail for the wrong reason) but keep the manifest
  // errors above.
  const idForCss = id && ID_RE.test(id) ? id : null;
  if (idForCss === null) {
    errors.push('theme.css cannot be validated until manifest.id is valid');
    return { ok: false, errors };
  }

  if (validateThemeCss(css, idForCss) == null) {
    errors.push(
      `theme.css must be exactly one safe [data-theme='${idForCss}'] rule (no @-rules, no foreign/global selectors, url() may only be a data: URI)`,
    );
    return { ok: false, errors };
  }

  const body = ruleBody(css, idForCss);
  if (body === null) {
    // Should not happen once validateThemeCss passed, but stay defensive.
    errors.push('theme.css declarations could not be read');
    return { ok: false, errors };
  }

  const seen = new Set<string>();
  let scheme: string | null = null;
  for (const decl of splitDeclarations(body)) {
    const idx = decl.indexOf(':');
    if (idx < 0) { errors.push(`malformed declaration: "${decl}"`); continue; }
    const prop = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();

    if (prop === 'color-scheme') {
      scheme = value;
      if (!SCHEME_VALUES.has(value)) errors.push(`color-scheme must be one of ${[...SCHEME_VALUES].join(' | ')} (got: ${value})`);
      continue;
    }
    if (!prop.startsWith('--')) { errors.push(`only custom properties and color-scheme are allowed (found: ${prop})`); continue; }
    if (!ALLOWED.has(prop)) { errors.push(`token ${prop} is not in the contract whitelist`); continue; }
    if (seen.has(prop)) errors.push(`token ${prop} is declared more than once`);
    seen.add(prop);

    const urls = value.toLowerCase().match(/url\(([^)]*)\)/g) || [];
    for (const u of urls) {
      if (!/url\(\s*["']?\s*data:/.test(u)) errors.push(`${prop}: only url(data:...) is allowed`);
      else if (!DATA_URI_TOKENS.has(prop)) errors.push(`${prop}: data-URI values are only allowed on ${[...DATA_URI_TOKENS].join(', ')}`);
    }
  }

  if (scheme === null) errors.push('color-scheme is required in theme.css');
  if (mode && scheme && mode !== scheme) errors.push(`manifest.mode "${mode}" must match theme.css color-scheme "${scheme}"`);
  for (const t of CORE) {
    if (!seen.has(t)) errors.push(`missing required core token ${t}`);
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    theme: {
      id: id as string,
      name: name as string,
      author: author as string,
      version: version as string,
      description: description as string,
      mode: mode as 'dark' | 'light',
      ...(Array.isArray(m.tags) ? { tags: m.tags as string[] } : {}),
      css,
    },
  };
}
