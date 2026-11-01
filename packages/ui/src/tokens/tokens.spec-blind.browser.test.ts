// Spec-blind browser test for Task 13: the dark viewer-chrome set is reached through the same token import,
// by setting data-theme="dark" on the viewer root (interface: "CSS: import '@sop/ui/tokens.css'; set data-theme=dark").
import { describe, expect, it } from 'vitest';
import { computedRgb, declaredCustomProperties } from '../../test/token-probe.spec-blind';
import './tokens.css';

describe('tokens.css light and dark sets', () => {
  it('data-theme="dark" on a root switches to the dark viewer-chrome values (viewer canvas #1b1b1b)', () => {
    const light = document.documentElement;
    const dark = document.createElement('div');
    dark.setAttribute('data-theme', 'dark');
    document.body.append(dark);

    const names = declaredCustomProperties();
    const lightValues = names.map((name) => computedRgb(light, name));
    const darkValues = names.map((name) => computedRgb(dark, name));

    // Light root shows Drive's primary #0b57d0 and never the dark canvas.
    expect(lightValues).toContain('rgb(11, 87, 208)');
    expect(lightValues).not.toContain('rgb(27, 27, 27)');
    // The dark root shows the viewer canvas, and a good number of tokens change between the two roots.
    expect(darkValues).toContain('rgb(27, 27, 27)');
    const changed = names.filter((_, i) => lightValues[i] !== darkValues[i]);
    expect(changed.length).toBeGreaterThanOrEqual(5);
  });
});
