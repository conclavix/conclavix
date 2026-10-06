import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 15],
      'no-console': 'error',
    },
  },
  {
    files: ['apps/web/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['deploy/mongo/**/*.js'],
    languageOptions: {
      globals: {
        db: 'writable',
        rs: 'readonly',
        quit: 'readonly',
        sleep: 'readonly',
        load: 'readonly',
        print: 'readonly',
      },
    },
  },
  {
    files: ['**/test/**', '**/*.test.ts'],
    rules: { 'max-lines-per-function': 'off' },
  },
);
