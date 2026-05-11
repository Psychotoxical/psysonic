/**
 * Wraps `render()` from @testing-library/react with the providers most
 * Psysonic components need: a router (for hooks like useNavigate / useParams)
 * and i18n (for components that call `useTranslation`).
 *
 * Tests that don't need a specific route can call `renderWithProviders(<X />)`.
 * Tests that need a specific URL pass `{ route: '/album/42' }`.
 *
 * **i18n language is pinned to `en` by default.** This keeps `getByText` /
 * `getByRole({ name })` selectors stable regardless of the developer's local
 * language preference. A test that wants to assert against a non-English
 * translation can pass `{ language: 'de' }`. See `src/test/README.md` for
 * the rationale (rule 5a from the pre-refactor testing plan, 2026-05-11).
 */
import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';

interface WrapperOptions {
  route?: string;
  language?: string;
}

function makeWrapper({ route = '/', language = 'en' }: WrapperOptions) {
  if (i18n.language !== language) {
    // Translations are bundled inline in `src/i18n.ts`, so changeLanguage
    // resolves synchronously — safe to ignore the returned promise.
    void i18n.changeLanguage(language);
  }
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </I18nextProvider>
    );
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options: WrapperOptions & Omit<RenderOptions, 'wrapper'> = {},
): RenderResult {
  const { route, language, ...rest } = options;
  return render(ui, { wrapper: makeWrapper({ route, language }), ...rest });
}
