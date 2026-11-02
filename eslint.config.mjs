import css from '@eslint/css';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import sop from './tooling/eslint-plugin-sop/index.js';



const LOCAL_ONLY_MESSAGE = 'The local-only store holds secrets. Only viewer and settings code may import it (ruling R14).';
const LOCAL_ONLY_IMPORT_PATTERN = { group: ['**/local-only', '**/local-only/**'], message: LOCAL_ONLY_MESSAGE };
const LOCAL_ONLY_SYNTAX = [
  { selector: "ImportExpression[source.type='Literal'][source.value=/local-only/]", message: LOCAL_ONLY_MESSAGE },
  { selector: "ImportExpression[source.type='TemplateLiteral']:has(TemplateElement[value.raw=/local-only/])", message: LOCAL_ONLY_MESSAGE },
  { selector: "CallExpression[callee.name='require'][arguments.0.value=/local-only/]", message: LOCAL_ONLY_MESSAGE },
  { selector: "TSImportType[argument.literal.value=/local-only/]", message: LOCAL_ONLY_MESSAGE },
];

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
    // third-party files the build copies in (onnxruntime-web's runtime, the tie-breaker model): not our code
    'apps/extension/public/ort/**',
    'apps/extension/public/models/**',
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

  // The secrets boundary (ruling R14). `apps/extension/src/local-only/` holds the API key and the sign-in token in their own
  // IndexedDB ("sop-local"). Only viewer and settings code may import it. Everything else under apps/extension/src and
  // packages/ is barred by default, so a new folder (backup, export, sync, a worker, a content script) is covered the
  // moment it exists. That covers the store worker, the offscreen document, the service worker, content scripts and the
  // test hooks. A folder that needs the key is added to the allowed list below on purpose, never the other way round.
  //
  // Both rules below REPLACE any other `no-restricted-imports` or `no-restricted-syntax` setting that a later block gives
  // the same files, so a later block that bars something else (the Anthropic SDK, in Phase 4) must repeat these entries
  // (LOCAL_ONLY_IMPORT_PATTERN and LOCAL_ONLY_SYNTAX).
  {
    files: ['apps/extension/src/**/*.{ts,tsx,js,mjs}', 'packages/**/*.{ts,tsx,js,mjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [LOCAL_ONLY_IMPORT_PATTERN] }],
      // import(), require() and import('...') in a type are not covered by no-restricted-imports.
      'no-restricted-syntax': ['error', ...LOCAL_ONLY_SYNTAX],
    },
  },
  {
    files: [
      'apps/extension/src/local-only/**',
      'apps/extension/src/viewer/**',
      'apps/extension/src/entrypoints/viewer/**',
      // Settings pages (Phase 3 library settings, Phase 4 Claude section)
      'apps/extension/src/library/settings/**',
      'apps/extension/src/claude-settings/**',
    ],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' },
  },
  // The backup (Phase 3, S13) never reaches the secrets store: no backup file may hold the key. Its folder is barred by the default
  // block above already; it is named here on purpose, with the Backup section, which sits in the settings folder that is allowed.
  // These entries come after the allowed list, so they win.
  {
    files: ['apps/extension/src/backup/**', 'apps/extension/src/store/backup-api.ts', 'apps/extension/src/library/settings/{Backup*,Restore*,use-backup}.{ts,tsx}', 'apps/extension/src/store/restore-api.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [LOCAL_ONLY_IMPORT_PATTERN] }],
      'no-restricted-syntax': ['error', ...LOCAL_ONLY_SYNTAX],
    },
  },

  // Design tokens: colours, lengths, fonts and shadows come from packages/ui/src/tokens (see the rule for the details)
  {
    files: ['**/*.css', '**/*.{jsx,tsx}'],
    plugins: { sop },
    rules: { 'sop/no-raw-design-values': 'error' },
  },
);
