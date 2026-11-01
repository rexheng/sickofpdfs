// Helpers for the spec-blind browser tests (Task 13).
// The interface does not fix token NAMES, so these helpers find tokens by their VALUE.

const probe = document.createElement('span');
probe.setAttribute('aria-hidden', 'true');
document.body.append(probe);

/** Every custom property name declared by a loaded stylesheet, including inside @media and @supports blocks. */
export function declaredCustomProperties(): string[] {
  const names = new Set<string>();
  const walk = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if ('style' in rule) {
        for (const m of (rule as CSSStyleRule).style.cssText.matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
      }
      if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // a sheet we cannot read is not ours
    }
  }
  return [...names];
}

/** Turns any CSS colour (hex, rgb, named) into the rgb() spelling the browser reports. Non-colours come back unchanged. */
export function asRgb(value: string): string {
  if (!value) return value;
  probe.style.color = '';
  probe.style.color = value;
  return probe.style.color ? getComputedStyle(probe).color : value;
}

/** The value a custom property resolves to on this element, normalised with asRgb. */
export function computedRgb(scope: Element, name: string): string {
  return asRgb(getComputedStyle(scope).getPropertyValue(name).trim());
}

/** Every declared token name whose value, on this element, is the given rgb() colour. */
export function tokenNamesWithColour(scope: Element, rgb: string): string[] {
  return declaredCustomProperties().filter((name) => computedRgb(scope, name) === rgb);
}
