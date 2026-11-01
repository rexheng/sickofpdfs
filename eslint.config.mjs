import css from '@eslint/css';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import sop from './tooling/eslint-plugin-sop/index.js';

export default defineConfig(
  globalIgnores([
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
  },

  // Design tokens: colours, lengths, fonts and shadows come from packages/ui/src/tokens (see the rule for the details)
  {
    files: ['**/*.css', '**/*.{jsx,tsx}'],
    plugins: { sop },
    rules: { 'sop/no-raw-design-values': 'error' },
  },
);
