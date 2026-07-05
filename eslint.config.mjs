import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `scripts/` (Node CI helpers) is intentionally ignored — this config targets the
  // browser `src/` tree. See `npm run lint:scripts` if scripts ever need a Node-globals lint pass.
  // `src/generated` holds machine-generated output (release-notes bundle,
  // tauri-specta `bindings.ts`) — not linted. `bindings.ts` is still type-checked
  // by tsc (the FE↔BE contract); its generated runtime helper uses `any`.
  { ignores: ['dist', 'coverage', 'src-tauri', 'research', 'scripts', 'src/generated'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // Promote deps to error at strict stage (wave 6+)
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
