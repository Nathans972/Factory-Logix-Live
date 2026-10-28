// ESLint flat config for the whole workspace. Each package's `lint` script runs
// `eslint .` from its own folder, and ESLint finds this file by looking upward.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/dist/', '**/coverage/']),
  {
    files: ['**/*.{js,ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      // A leading underscore marks a parameter or binding as unused on purpose, and a
      // rest sibling (`const { password_hash: _hash, ...user } = row`) is how fields are dropped.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      // These three check readiness for the React Compiler, which this app doesn't use.
      // What they flag is deliberate here: Date.now() for "minutes ago" labels, refs that
      // hold the latest callback, and effects that sync local state from loaded data.
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);
