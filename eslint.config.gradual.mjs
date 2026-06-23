import eslint from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `scripts/` (Node CI helpers) is intentionally ignored — this config targets the browser `src/` tree.
  { ignores: ['dist', 'coverage', 'src-tauri', 'research', 'scripts'] },
  // This gradual baseline deliberately omits the React Compiler rules (set-state-in-effect, refs,
  // immutability, …) that the strict config enables. The per-line `eslint-disable-next-line` directives
  // those rules require therefore read as "unused" here, so unused-directive reporting is turned off for
  // this config only — the strict config keeps the default reporting and stays 0/0.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
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
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
