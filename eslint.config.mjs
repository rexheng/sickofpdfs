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

// Phase 4 (plan §3): only the viewer's Claude client talks to Anthropic. Every other file is barred from the SDK, so the key is
// read in one place and every request goes through one door (viewer/claude/client.ts). These entries are added to the
// local-only ones in each block below, because a later block's `no-restricted-imports` replaces an earlier one's (carried
// requirement): dropping LOCAL_ONLY_IMPORT_PATTERN or LOCAL_ONLY_SYNTAX here would silently open the secrets boundary.
const SDK_MESSAGE = 'Only apps/extension/src/viewer/claude/client.ts may import the Anthropic SDK (plan §3).';
const SDK_IMPORT_PATTERN = { group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/**'], message: SDK_MESSAGE };
const SDK_SYNTAX = [
  { selector: "ImportExpression[source.type='Literal'][source.value=/^@anthropic-ai\\/sdk/]", message: SDK_MESSAGE },
  { selector: "CallExpression[callee.name='require'][arguments.0.value=/^@anthropic-ai\\/sdk/]", message: SDK_MESSAGE },
  { selector: "TSImportType[argument.literal.value=/^@anthropic-ai\\/sdk/]", message: SDK_MESSAGE },
];
const SDK_CLIENT = 'apps/extension/src/viewer/claude/client.ts';

// Spec R103: the extension never reads a page on its own. chrome.scripting may be called only from the toolbar menu's click path:
// the menu (webclip/ActionMenu.tsx) puts the page script in, and webclip/make-pdf.ts reads the article's pictures through it.
// The rule catches the usual spellings: `chrome.scripting`, `chrome['scripting']`, `const { scripting } = chrome`, and any
// `.executeScript(`. Lint can still be got round (a name built at run time), so the build checks the bundle too
// (apps/extension/scripts/check-scripting.mjs): only the popup and the save-page tab may hold it.
const SCRIPTING_MESSAGE = 'Only webclip/ActionMenu.tsx and webclip/make-pdf.ts may use chrome.scripting, from the toolbar menu click (spec R103).';
const SCRIPTING_NAME = '/^(?:scripting|executeScript|registerContentScripts|updateContentScripts)$/';
const SCRIPTING_SYNTAX = [
  { selector: `MemberExpression[property.name=${SCRIPTING_NAME}]`, message: SCRIPTING_MESSAGE },
  { selector: `MemberExpression[computed=true][property.value=${SCRIPTING_NAME}]`, message: SCRIPTING_MESSAGE },
  { selector: `MemberExpression[computed=true] > TemplateLiteral.property > TemplateElement[value.cooked=${SCRIPTING_NAME}]`, message: SCRIPTING_MESSAGE },
  { selector: `ObjectPattern > Property[key.name=${SCRIPTING_NAME}]`, message: SCRIPTING_MESSAGE },
  { selector: `ObjectPattern > Property[key.value=${SCRIPTING_NAME}]`, message: SCRIPTING_MESSAGE },
];
const SCRIPTING_FILES = ['apps/extension/src/webclip/ActionMenu.tsx', 'apps/extension/src/webclip/make-pdf.ts'];
// Those two files are the click path: only the popup and the save-page tab bring them in, and never by a dynamic import (a page
// that imported make-pdf.ts could read the pictures of any tab it names).
const CLICK_PATH_MESSAGE = 'Only the popup (entrypoints/popup/main.tsx) and the save-page tab (webclip/SavePage.tsx) may import webclip/ActionMenu.tsx or webclip/make-pdf.ts, and never with import() (spec R103).';
const CLICK_PATH_MODULE = '/(?:^|\\/)(?:ActionMenu|make-pdf)(?:\\.[jt]sx?)?$/';
// (An import() of a name built at run time is not caught here; the build check is.)
const CLICK_PATH_DYNAMIC = [
  { selector: `ImportExpression[source.value=${CLICK_PATH_MODULE}]`, message: CLICK_PATH_MESSAGE },
  { selector: `ImportExpression > TemplateLiteral.source > TemplateElement[value.cooked=/(?:ActionMenu|make-pdf)/]`, message: CLICK_PATH_MESSAGE },
];
const CLICK_PATH_SYNTAX = [
  ...CLICK_PATH_DYNAMIC,
  { selector: `ImportDeclaration[source.value=${CLICK_PATH_MODULE}]`, message: CLICK_PATH_MESSAGE },
  { selector: `ExportNamedDeclaration[source.value=${CLICK_PATH_MODULE}]`, message: CLICK_PATH_MESSAGE },
  { selector: `ExportAllDeclaration[source.value=${CLICK_PATH_MODULE}]`, message: CLICK_PATH_MESSAGE },
];
const CLICK_PATH_IMPORTERS = ['apps/extension/src/entrypoints/popup/main.tsx', 'apps/extension/src/webclip/SavePage.tsx'];

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/.output/**',
    '**/.wxt/**',
    '**/.wrangler/**', // wrangler dev's own build output
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/.vitest-attachments/**',
    // Wrangler's local state and temporary bundles
    '**/.wrangler/**',
    '.superpowers/**',
    'test-assets/**',
    // third-party files the build copies in (onnxruntime-web's runtime, the tie-breaker model): not our code
    'apps/extension/public/ort/**',
    'apps/extension/public/models/**',
    // the phone app's Android project: Gradle files and the web build copied into it
    'apps/mobile/android/**',
    // the throwaway Phase 0 package has its own tooling and is not part of the workspace
    'spikes/**',
    // research notes and third-party reference copies
    'docs/**',
    // the launch video's local snapshot of arXiv's page (not committed)
    'apps/video/fixtures/**',
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
    files: ['apps/extension/src/**/*.{ts,tsx,js,mjs}', 'apps/mobile/src/**/*.{ts,tsx,js,mjs}', 'apps/cloud/web/src/**/*.{ts,tsx,js,mjs}', 'packages/**/*.{ts,tsx,js,mjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [LOCAL_ONLY_IMPORT_PATTERN, SDK_IMPORT_PATTERN] }],
      // import(), require() and import('...') in a type are not covered by no-restricted-imports.
      'no-restricted-syntax': ['error', ...LOCAL_ONLY_SYNTAX, ...SDK_SYNTAX, ...SCRIPTING_SYNTAX, ...CLICK_PATH_SYNTAX],
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
    // The secrets store is allowed here; the SDK still is not (only the client below may import it).
    rules: { 'no-restricted-imports': ['error', { patterns: [SDK_IMPORT_PATTERN] }], 'no-restricted-syntax': ['error', ...SDK_SYNTAX, ...SCRIPTING_SYNTAX, ...CLICK_PATH_SYNTAX] },
  },
  // The one door to Anthropic: it reads the key (getSecret) and imports the SDK.
  {
    files: [SDK_CLIENT],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': ['error', ...SCRIPTING_SYNTAX, ...CLICK_PATH_SYNTAX] },
  },
  // The backup (Phase 3, S13) never reaches the secrets store: no backup file may hold the key. Its folder is barred by the default
  // block above already; it is named here on purpose, with the Backup section, which sits in the settings folder that is allowed.
  // These entries come after the allowed list, so they win.
  {
    files: ['apps/extension/src/backup/**', 'apps/extension/src/store/backup-api.ts', 'apps/extension/src/library/settings/{Backup*,Restore*,use-backup}.{ts,tsx}', 'apps/extension/src/store/restore-api.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [LOCAL_ONLY_IMPORT_PATTERN, SDK_IMPORT_PATTERN] }],
      'no-restricted-syntax': ['error', ...LOCAL_ONLY_SYNTAX, ...SDK_SYNTAX, ...SCRIPTING_SYNTAX, ...CLICK_PATH_SYNTAX],
    },
  },
  // CA7 (CL10): the service worker's cloud token broker needs the sign-in token, so it may import exactly the two cloud files of
  // local-only/ (which reach only db.ts). Everything else in local-only/, the secrets store above all, stays barred for it. The
  // Android app's broker (mobile round 3) is the same door on the phone, with the same rule.
  {
    files: ['apps/extension/src/background/cloud-broker.ts', 'apps/mobile/src/platform/cloud-broker.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '(^|/)local-only(/(?!(cloud-auth|cloud-forget)$).*)?$', message: LOCAL_ONLY_MESSAGE }, SDK_IMPORT_PATTERN] }],
      'no-restricted-syntax': ['error', ...LOCAL_ONLY_SYNTAX, ...SDK_SYNTAX, ...SCRIPTING_SYNTAX, ...CLICK_PATH_SYNTAX],
    },
  },
  // ...and those cloud files never import the secrets store (they touch only `cloud_token` and the Forget queue).
  {
    files: ['apps/extension/src/local-only/{db,cloud-auth,cloud-forget}.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/secrets-store', '**/secrets-store.*'], message: 'The cloud token broker never reads the secrets store (contracts CA7).' }, SDK_IMPORT_PATTERN] }],
    },
  },
  // The two files that may use chrome.scripting (the secrets and SDK bars stay as they are for them).
  {
    files: SCRIPTING_FILES,
    rules: {
      'no-restricted-imports': ['error', { patterns: [LOCAL_ONLY_IMPORT_PATTERN, SDK_IMPORT_PATTERN] }],
      'no-restricted-syntax': ['error', ...LOCAL_ONLY_SYNTAX, ...SDK_SYNTAX, ...CLICK_PATH_DYNAMIC],
    },
  },
  // The two files that bring the click path in (statically: never with a dynamic import).
  {
    files: CLICK_PATH_IMPORTERS,
    rules: { 'no-restricted-syntax': ['error', ...LOCAL_ONLY_SYNTAX, ...SDK_SYNTAX, ...SCRIPTING_SYNTAX, ...CLICK_PATH_DYNAMIC] },
  },

  // Design tokens: colours, lengths, fonts and shadows come from packages/ui/src/tokens (see the rule for the details)
  {
    files: ['**/*.css', '**/*.{jsx,tsx}'],
    plugins: { sop },
    rules: { 'sop/no-raw-design-values': 'error' },
  },

  // The launch video (apps/video): a fixed 1920 × 1080 canvas drawn by Remotion, not product UI, so it measures in pixels. Remotion's
  // easing functions are passed as plain functions (Easing.out(Easing.cubic)).
  {
    files: ['apps/video/src/**/*.{ts,tsx}'],
    rules: { 'sop/no-raw-design-values': 'off', '@typescript-eslint/unbound-method': 'off' },
  },
);
