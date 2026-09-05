import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier/flat';
import nodePlugin from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

/**
 * Lint config for the fleet orchestration CLI in this directory ONLY.
 *
 * It cannot reach the clones: they live a level up, outside this package, and each carries
 * its own (very different) Angular config whose rules are versioned per branch. Type-checked
 * rules are on, which is affordable here because the whole CLI is a few hundred lines.
 */
export default defineConfig([
  globalIgnores(['node_modules/']),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  nodePlugin.configs['flat/recommended-module'],
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The CLI imports its own modules with an explicit `.ts` extension, because that is
      // what Node's type stripping resolves. eslint-plugin-n cannot see through it.
      'n/no-missing-import': 'off',
      // `process.exit` belongs in the entrypoint only; every command signals failure by
      // throwing a CliError instead.
      'n/no-process-exit': 'error',
      // A CLI is exactly the case where synchronous fs is the right call: every command is
      // a short sequential script, and async here would buy nothing but ceremony.
      'n/no-sync': 'off',
      'n/prefer-node-protocol': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // This codebase models everything as plain data, so `type` aliases read better than
      // interfaces and cannot be accidentally reopened by declaration merging.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // The entrypoint is the one place allowed to end the process.
    files: ['src/cli.ts'],
    rules: { 'n/no-process-exit': 'off' },
  },
  {
    /*
     * The suite under `test/`, run by `pnpm test` (`node --test`).
     *
     * `node:test`'s `test()` returns a promise that the RUNNER awaits, which is the whole point
     * of it -- so every top-level call is a floating promise by construction and the rule fires
     * once per test. `void test(...)` everywhere would be noise hiding the one place it might
     * ever matter, so the rule is off here and nowhere else.
     */
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  prettierConfig,
]);
