// ESLint flat config.
//
//  * TypeScript sources (src, tests, tool configs) are linted with typescript-eslint's *type-aware*
//    recommended set (floating / misused promises, unsafe `any` flow, redundant assertions …) via the
//    TypeScript project service, plus a handful of cheap extra rules that have caught real bugs.
//  * Plain `.mjs` files (the e2e driver, this config) get the core recommended set only.
//  * Formatting is Prettier's job (`npm run format`); no stylistic rules are enabled here.
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist', 'node_modules', 'e2e/out', 'desktop'] },
  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-shadow': 'error',
      // `default:` counts as handling the remaining members of a union; a switch with neither a default
      // nor every case is an error, so adding a shape / joint type surfaces every switch that needs it.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },

  {
    // The scene sanitiser is the one place that deliberately touches untrusted, untyped JSON
    // (file import, autosave, share links): every value is read as `any` and immediately coerced
    // through num()/str()/oneOf()/clamp helpers, so the typed `Entity` it returns is safe.
    files: ['src/model/serialize.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  {
    files: ['**/*.mjs'],
    languageOptions: {
      // e2e `page.evaluate` callbacks run in the browser, so both global sets apply.
      globals: { ...globals.node, ...globals.browser },
    },
  },

  {
    // DT-40: the service worker template is a classic script that doubles as a CommonJS module for its unit tests.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.serviceworker } },
  },
);
