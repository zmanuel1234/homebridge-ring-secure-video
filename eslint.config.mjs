// Shared ESLint setup for homebridge-brother-printer, homebridge-comelit-doorbell,
// homebridge-ir-patio-heater, homebridge-ring-secure-video and wyze-robovac-matterbridge: keep the
// copies the same apart from the "This repository" block.
//
// It checks for bugs, not formatting. The files in tsFiles get typescript-eslint's type-aware rules,
// mainly the promise checks: a promise that is neither awaited nor given a .catch() turns a
// failure into an unhandled rejection, which can stop the whole bridge.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ---- This repository ----
const tsFiles = ['**/*.ts'];
const ignores = ['lib/**', 'release-*/**', 'build/**', 'json-data/**', '.turbo/**', '.homebridge/**'];
const extra = [
  // The settings page runs in the browser.
  { files: ['homebridge-ui/public/**'], languageOptions: { globals: globals.browser } },
];
// -------------------------

export default tseslint.config(
  { ignores: ['node_modules/**', ...ignores] },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  {
    // Plain JavaScript (tests, scripts): ESLint's own recommended rules.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: tsFiles,
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Promises
      '@typescript-eslint/no-floating-promises': ['error', {
        // node:test runs test() and describe() itself; their promises need no handling.
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] }],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Not require-await: `async` without `await` is how a function turns its throws into
      // rejections for callers that use .catch().
      // Other likely bugs
      eqeqeq: ['error', 'smart'],
      'no-console': 'error', // log through the platform's logger
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
      }],
      // Consistency
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // Device APIs hand back loosely typed data; `any` is allowed where it's honest.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  ...extra,
);
