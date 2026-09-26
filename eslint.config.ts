/**
 * ESLint flat config.
 *
 * The same house style as the framework: 2-space indentation, single quotes, semicolons, K&R braces,
 * braces on every control statement, and trailing commas on multiline literals.
 */
import js from '@eslint/js';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['node_modules/', 'dist/', '**/*.js']),
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: {
      '@stylistic': stylistic,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/eol-last': ['error', 'always'],
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/comma-dangle': ['error', {
        arrays: 'always-multiline',
        objects: 'always-multiline',
        imports: 'always-multiline',
        exports: 'always-multiline',
        functions: 'never',
      }],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/keyword-spacing': 'error',
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/comma-spacing': 'error',
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/arrow-parens': ['error', 'always'],

      // a blank line either side of every block, and after a run of declarations, so a function
      // reads in steps rather than as one wall
      '@stylistic/padding-line-between-statements': ['error',
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
      ],
      'curly': ['error', 'all'],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-throw-literal': 'error',
      'no-implicit-coercion': 'error',
      'dot-notation': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
    },
  },
]);
