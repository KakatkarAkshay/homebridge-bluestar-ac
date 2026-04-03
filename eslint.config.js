import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**'],
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        Buffer: 'readonly',
        clearTimeout: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
      sourceType: 'module',
    },
  },
  {
    rules: {
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': ['error', { 'classes': false, 'enums': false }],
      '@typescript-eslint/no-unused-vars': ['error', { 'caughtErrors': 'none' }],
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
