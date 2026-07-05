import { validateThemeCss } from '@/lib/themes/themeInjection';
import { FIXED_THEMES } from '@/lib/themes/fixedThemes';

/**
 * Validation for a locally imported theme package (a .zip holding manifest.json
 * + theme.css). Community themes are free-form, so this enforces two things:
 *
 *  1. the **manifest** is well-formed (the same field rules as the repo schema),
 *     and its id doesn't collide with a built-in theme, and
 *  2. the CSS passes the in-app **security floor** (`validateThemeCss`) — no
 *     network/scripts/breakout, data:-only `url()`, id-namespaced `@keyframes`.
 *
 * Quality, structure, animations and taste are deliberately NOT checked here:
 * store themes are vetted by maintainers, and sideloaded themes are installed
 * at the user's own risk (the import UI says so). The floor is the safety line.
 */

// Field patterns copied verbatim from the repo's schema/manifest.schema.json.
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AUTHOR_RE = /^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const APP_VER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MANIFEST_KEYS = new Set([
  'id', 'name', 'author', 'version', 'description', 'mode', 'tags', 'minAppVersion',
]);
const BUILTIN_IDS = new Set(FIXED_THEMES.map((f) => f.id));

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

  // ---- css security floor ----
  // Needs a valid id (the @keyframes namespace check is keyed on it).
  const idForCss = id && ID_RE.test(id) ? id : null;
  if (idForCss === null) {
    errors.push('theme.css cannot be validated until manifest.id is valid');
    return { ok: false, errors };
  }
  if (validateThemeCss(css, idForCss) == null) {
    errors.push(
      "theme.css failed the safety check — it may exceed the size limit, reach the network (only data: url() is allowed), use @import / @property / scripts, break out of its <style>, or define @keyframes not namespaced as \"" + idForCss + "-…\"",
    );
    return { ok: false, errors };
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
