/**
 * Wraps `render()` from @testing-library/react with the providers most
 * Psysonic components need: a router (for hooks like useNavigate / useParams)
 * and i18n (for components that call `useTranslation`).
 *
 * Tests that don't need a specific route can call `renderWithProviders(<X />)`.
 * Tests that need a specific URL pass `{ route: '/album/42' }`.
 */
import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';

interface WrapperOptions {
  route?: string;
}

function makeWrapper({ route = '/' }: WrapperOptions) {
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
  const { route, ...rest } = options;
  return render(ui, { wrapper: makeWrapper({ route }), ...rest });
}
