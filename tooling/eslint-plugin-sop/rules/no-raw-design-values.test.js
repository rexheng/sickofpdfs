// ESLint RuleTester on Vitest. CSS cases use the language "css/css" from @eslint/css; JSX cases use the
// default JavaScript language with JSX switched on.
import css from '@eslint/css';
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import rule from './no-raw-design-values.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const cssTester = new RuleTester({ plugins: { css }, language: 'css/css' });
const jsxTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
});

const TOKENS_FILE = 'packages/ui/src/tokens/tokens.css';

cssTester.run('no-raw-design-values', rule, {
  valid: [
    'a { color: var(--gm3-sys-color-primary); padding: var(--space-2); border-bottom: 1px solid var(--drive-row-divider); margin: 0; width: 100%; }',
    { code: ':root { --gm3-sys-color-primary: #0b57d0; --row-h: 48px; }', filename: TOKENS_FILE },
    // the token file itself is exempt, whatever it declares
    { code: 'a { color: #0b57d0; padding: 8px; font-family: Arial; box-shadow: 0 1px 2px #000 }', filename: TOKENS_FILE },
    { code: ':root { --x: #fff }', filename: '/work/repo/packages/ui/src/tokens/tokens-dark.css' },
    // allowed without tokens
    'a { color: transparent; background: currentColor; border-color: inherit; box-shadow: none; outline: none }',
    'a { margin: 0px; padding: 0 0 0 0; top: auto; height: auto; flex: 1 1 0 }',
    'a { grid-template-columns: 1fr 2fr; width: calc(100% - var(--space-2)); border: 1px solid var(--drive-row-divider) }',
    'a { border-top-width: 1px; border-image-width: 1 }',
    // viewport units are layout values, not design values
    'a { height: 100vh; min-height: 100dvh; max-height: 100svh; width: 100vw; inset-block-start: 10lvh; font-size: var(--x); padding: 5vmin 5vmax }',
    // not lengths, colours or fonts
    'a { opacity: 0.5; z-index: 2; line-height: 1.5; font-weight: 500; transition: opacity 200ms ease; transform: rotate(45deg) }',
    'a { font-family: var(--gm3-sys-font-family-body); font: var(--gm3-sys-typescale-body-medium); font-size: var(--gm3-sys-font-size-body) }',
    'a { box-shadow: var(--gm3-sys-elevation-2); text-shadow: var(--shadow-text) }',
    'a { fill: currentColor; stroke: var(--gm3-sys-color-outline); background-image: url(#clip) }',
    'a { color: var(--gm3-sys-color-primary, var(--gm3-sys-color-secondary)) }',
    // declaration values that merely look like a named colour or a length in an unrelated property
    'a { animation-name: red; grid-area: red; counter-reset: orange 8 }',
    '@media (min-width: 600px) { a { color: var(--gm3-sys-color-primary) } }',
  ],
  invalid: [
    { code: 'a { color: #0b57d0 }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { background: rgb(0 0 0) }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { color: red }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { padding: 8px }', errors: [{ messageId: 'rawLength' }] },
    { code: 'a { font-family: Arial }', errors: [{ messageId: 'rawFont' }] },
    { code: 'a { box-shadow: 0 1px 2px var(--x) }', errors: [{ messageId: 'rawShadow' }] },
    // more raw colour forms
    { code: 'a { color: rgba(0, 0, 0, 0.5) }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { color: hsl(210 50% 40%) }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { color: oklch(0.5 0.1 200) }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { border: 1px solid #ccc }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { background: linear-gradient(to right, rebeccapurple, var(--x)) }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { color: var(--x, #fff) }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { color: color-mix(in srgb, #fff 50%, var(--x)) }', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { accent-color: RED }', errors: [{ messageId: 'rawColor' }] },
    // more raw lengths
    { code: 'a { margin: 0 auto 1rem }', errors: [{ messageId: 'rawLength' }] },
    { code: 'a { margin: 8px 12px }', errors: [{ messageId: 'rawLength' }, { messageId: 'rawLength' }] },
    { code: 'a { width: calc(100% - 8px) }', errors: [{ messageId: 'rawLength' }] },
    { code: 'a { min-height: calc(100vh - 8px) }', errors: [{ messageId: 'rawLength' }] },
    { code: 'a { font-size: 14px }', errors: [{ messageId: 'rawLength' }] },
    { code: 'a { border-bottom: 2px solid var(--drive-row-divider) }', errors: [{ messageId: 'rawLength' }] },
    { code: 'a { border-radius: 0.5px }', errors: [{ messageId: 'rawLength' }] },
    // more raw fonts
    { code: "a { font-family: 'Google Sans', sans-serif }", errors: [{ messageId: 'rawFont' }] },
    { code: 'a { font-family: system-ui }', errors: [{ messageId: 'rawFont' }] },
    { code: 'a { font: var(--gm3-sys-typescale-body-medium), Arial }', errors: [{ messageId: 'rawFont' }] },
    // more raw shadows (one report per declaration, not one per number or colour inside it)
    { code: 'a { box-shadow: 0 1px 2px rgba(0 0 0 / 0.3) }', errors: [{ messageId: 'rawShadow' }] },
    { code: 'a { text-shadow: 1px 1px #000 }', errors: [{ messageId: 'rawShadow' }] },
    { code: 'a { box-shadow: var(--a), 0 2px 4px var(--b) }', errors: [{ messageId: 'rawShadow' }] },
    { code: 'a { filter: drop-shadow(0 1px 2px var(--x)) }', errors: [{ messageId: 'rawShadow' }] },
    // outside the token directory
    { code: ':root { --x: #fff }', filename: 'packages/ui/src/components/Button.module.css', errors: [{ messageId: 'rawColor' }] },
    { code: 'a { color: #fff }', filename: 'packages/ui/src/tokens-extra/a.css', errors: [{ messageId: 'rawColor' }] },
  ],
});

jsxTester.run('no-raw-design-values', rule, {
  valid: [
    "<div style={{ width: '100%', color: 'var(--gm3-sys-color-on-surface)' }} />",
    { code: "<div style={{ color: '#fff', padding: 12 }} />", filename: 'packages/ui/src/tokens/theme.tsx' },
    "<div style={{ margin: 0, padding: '0', opacity: 0.5, zIndex: 3, flex: 1, lineHeight: 1.5, fontWeight: 500 }} />",
    "<div style={{ borderBottom: '1px solid var(--drive-row-divider)', borderWidth: 1, height: 'auto', gridTemplateColumns: '1fr 2fr' }} />",
    "<div style={{ background: 'transparent', color: 'currentColor', boxShadow: 'none' }} />",
    "<div style={{ height: '100vh', minWidth: '50vw' }} />",
    "<div style={{ fontFamily: 'var(--gm3-sys-font-family-body)', boxShadow: 'var(--gm3-sys-elevation-2)' }} />",
    // not the style attribute, not an inline object, or not static: out of scope
    "<div className={{ color: '#fff' }} data-x={{ padding: 12 }} />",
    '<div style={styles.row} />',
    "<div style={{ ...base, [key]: '#fff', color: tone }} />",
  ],
  invalid: [
    { code: "<div style={{ color: '#fff' }} />", errors: [{ messageId: 'rawColor' }] },
    { code: '<div style={{ padding: 12 }} />', errors: [{ messageId: 'rawLength' }] },
    { code: "<div style={{ backgroundColor: 'rgb(0 0 0)' }} />", errors: [{ messageId: 'rawColor' }] },
    { code: "<div style={{ border: '1px solid red' }} />", errors: [{ messageId: 'rawColor' }] },
    { code: "<div style={{ marginTop: '8px' }} />", errors: [{ messageId: 'rawLength' }] },
    { code: "<div style={{ 'padding-left': 4 }} />", errors: [{ messageId: 'rawLength' }] },
    { code: '<div style={{ width: `calc(100% - 8px)` }} />', errors: [{ messageId: 'rawLength' }] },
    { code: "<div style={{ fontFamily: 'Arial' }} />", errors: [{ messageId: 'rawFont' }] },
    { code: "<div style={{ boxShadow: '0 1px 2px #000' }} />", errors: [{ messageId: 'rawShadow' }] },
    { code: "<div style={{ color: dark ? '#fff' : 'var(--x)' }} />", errors: [{ messageId: 'rawColor' }] },
    {
      code: "<div style={{ color: '#fff', padding: 12, fontFamily: 'Arial' }} />",
      errors: [{ messageId: 'rawColor' }, { messageId: 'rawLength' }, { messageId: 'rawFont' }],
    },
    { code: "<div style={{ color: '#fff' }} />", filename: 'packages/ui/src/components/Chip.tsx', errors: [{ messageId: 'rawColor' }] },
  ],
});
