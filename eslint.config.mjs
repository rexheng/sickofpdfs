import { existsSync } from 'node:fs';
import css from '@eslint/css';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import sop from './tooling/eslint-plugin-sop/index.js';

// Spec-blind tests that run the real store import Task 28's files and its sqlite-wasm dependency, so until Task 28 exists their
// types cannot resolve and every line reports an unsafe-any error. They are linted again by themselves once store-api.ts is there.
// Delete this block when Task 28 has merged.
const needTask28 = existsSync(new URL('./apps/extension/src/store/store-api.ts', import.meta.url))
  ? []
  : [
      'apps/extension/src/store/{db,env,v1-data,v1-fixture}.spec-blind.ts',
      'apps/extension/src/store/opfs-peer.spec-blind.worker.ts',
      'apps/extension/src/store/{schema-v2,annotations}.spec-blind.test.ts',
      'apps/extension/src/store/durability.spec-blind.browser.test.ts',
      'apps/extension/src/viewer/annotations/stack.spec-blind.ts',
      'apps/extension/src/viewer/annotations/{no-lost-text,edit-draft}.spec-blind.test.ts',
    ];

export default defineConfig(
  globalIgnores([
    ...needTask28,
    '**/dist/**',
    '**/.output/**',
    '**/.wxt/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/.vitest-attachments/**',
    '.superpowers/**',
    'test-assets/**',
    // the throwaway Phase 0 package has its own tooling and is not part of the workspace
    'spikes/**',
    // research notes and third-party reference copies
    'docs/**',
  ]),

  // JavaScript and TypeScript
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,jsx}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['**/*.jsx'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },

  // Typed rules: they read types through the TypeScript project service, so every rule that needs type information
  // runs against the same tsconfig.json that `tsc --noEmit` checks.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // React hooks: the two classic rules (the React Compiler rules in the plugin's recommended set are not enabled)
  {
    files: ['**/*.{ts,tsx,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // CSS
  {
    files: ['**/*.css'],
    plugins: { css },
    language: 'css/css',
    extends: [css.configs.recommended],
    rules: {
      // Tokens are declared in packages/ui/src/tokens, not in the file that uses them, so ESLint cannot resolve a
      // var(--token) file by file. packages/ui/src/tokens/tokens.test.ts checks that every var(--x) is declared.
      'css/no-invalid-properties': ['error', { allowUnknownVariables: true }],
    },
  },

  // Design tokens: colours, lengths, fonts and shadows come from packages/ui/src/tokens (see the rule for the details)
  {
    files: ['**/*.css', '**/*.{jsx,tsx}'],
    plugins: { sop },
    rules: { 'sop/no-raw-design-values': 'error' },
  },
);
