import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'deploy/**', 'docs/**', '.remember/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Skrypty node (.mjs) — globals node i dopuszczalny console.log (narzędzia CLI)
    files: ['tools/**/*.mjs', 'deploy/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', localStorage: 'readonly', document: 'readonly', window: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
