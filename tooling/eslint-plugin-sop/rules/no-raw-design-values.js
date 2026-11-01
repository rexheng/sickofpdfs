// sop/no-raw-design-values
//
// "Colours, fonts, icons and spacing come only from the shared token file, taken from Drive. A lint rule blocks
// raw values." The rule runs on two languages with one implementation:
//   - CSS (language "css/css" from @eslint/css): every declaration, including custom properties.
//   - JS/JSX/TSX: the static values of an inline `style={{ ... }}` object.
// Both feed a value, as a CSS syntax tree, to the same analysis. JSX strings are parsed with the CSS parser that
// @eslint/css uses.
//
// Allowed without a token: 0, 1px (hairlines), %, fr, auto, viewport units (vh, vw, ...), transparent, currentColor,
// inherit and none (plus the other CSS-wide keywords). Files under packages/ui/src/tokens/ are exempt: that is where the values are defined.
import { parse, toPlainObject } from '@eslint/css-tree';

const TOKENS_DIR = /(^|\/)packages\/ui\/src\/tokens\//u;

const GLOBAL_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

// rgb()/hsl()/... build a colour out of raw numbers. color-mix(), light-dark(), var() and calc() do not: they are
// checked through their arguments.
const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);

// The CSS named colours. `transparent` and `currentColor` are left out on purpose: they are allowed.
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod ' +
    'darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon ' +
    'darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray ' +
    'dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon ' +
    'lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon ' +
    'lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy ' +
    'oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip ' +
    'peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal ' +
    'thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

// Absolute and relative length units. Not listed, so allowed: `%`, `fr`, time, angle and resolution units, and the
// viewport units (vw, vh, vi, vb, vmin, vmax and their s/l/d variants), which are layout values, not design values.
const LENGTH_UNITS = new Set([
  'px', 'em', 'rem', 'ex', 'rex', 'cap', 'rcap', 'ch', 'rch', 'ic', 'ric', 'lh', 'rlh',
  'cm', 'mm', 'q', 'in', 'pt', 'pc',
  'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax',
]);

// Properties whose value can hold a named colour. Custom properties count, so a new token cannot be declared outside
// the token directory. Other properties (animation-name: red, grid-area: red) can use the same words for other things.
// The vendor prefix is removed from the name first, so -webkit-text-stroke is matched as text-stroke.
const COLOR_PROPERTY =
  /^(--.*|(.*-)?color|background(-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?|outline|fill|stroke|text-decoration|text-stroke|column-rule|caret)$/u;
const SHADOW_PROPERTIES = new Set(['box-shadow', 'text-shadow']);
const FONT_PROPERTIES = new Set(['font-family', 'font']);

// A custom property has no fixed meaning, so it is a font or a shadow when its name says so (`--ui-font`,
// `--card-shadow`, `--gm3-sys-elevation-2`) or when its value names a generic family (`Inter, sans-serif`).
// `--font-size-body: 14px` is a length, so it is not a font.
const FONT_NAME = /(^|-)(font|typeface|font-family)$/u;
const SHADOW_NAME = /(^|-)(shadow|elevation)(-|$)/u;
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'math', 'emoji', 'fangsong',
]);

// React appends "px" to a bare number, except for these properties (React's own unitless list).
const UNITLESS_PROPERTIES = new Set(
  (
    'animation-iteration-count aspect-ratio border-image-outset border-image-slice border-image-width box-flex ' +
    'box-flex-group box-ordinal-group column-count columns flex flex-grow flex-positive flex-shrink flex-negative ' +
    'flex-order font-weight grid-area grid-row grid-row-end grid-row-span grid-row-start grid-column grid-column-end ' +
    'grid-column-span grid-column-start line-clamp line-height opacity order orphans scale tab-size widows z-index zoom ' +
    'fill-opacity flood-opacity stop-opacity stroke-dasharray stroke-dashoffset stroke-miterlimit stroke-opacity ' +
    'stroke-width initial-letter'
  ).split(' '),
);

const isType = (node, type) => typeof node === 'object' && node !== null && node.type === type;
const lower = (text) => text.toLowerCase();

// -webkit-, -moz-, -ms- and -o- prefixes. React writes them as WebkitTextStroke and msBoxShadow, and kebab() turns those
// into -webkit-text-stroke and ms-box-shadow, so the leading dash is optional here.
const VENDOR_PREFIX = /^-?(webkit|moz|ms|o)-/u;
const unprefixed = (property) => lower(property).replace(VENDOR_PREFIX, '');

/** `var(--x)`, or a var() whose fallback is made of token references and keywords only. */
function isTokenReference(node) {
  if (!isType(node, 'Function') || lower(node.name) !== 'var') return false;
  return node.children.every(
    (child) =>
      isType(child, 'Operator') ||
      (isType(child, 'Identifier') && (child.name.startsWith('--') || lower(child.name) === 'none' || GLOBAL_KEYWORDS.has(lower(child.name)))) ||
      isTokenReference(child),
  );
}

/** A comma-separated list in which every item is a token reference, `none` or a CSS-wide keyword. */
function isTokenList(children) {
  const items = [[]];
  for (const child of children) {
    if (isType(child, 'Operator') && child.value === ',') items.push([]);
    else items.at(-1).push(child);
  }
  return items.every(
    ([only, ...rest]) =>
      only !== undefined &&
      rest.length === 0 &&
      (isTokenReference(only) || (isType(only, 'Identifier') && (lower(only.name) === 'none' || GLOBAL_KEYWORDS.has(lower(only.name))))),
  );
}

/** True when a generic font family (sans-serif, monospace, ...) appears anywhere in the value. */
function hasGenericFamily(nodes) {
  return nodes.some(
    (node) =>
      (isType(node, 'Identifier') && GENERIC_FAMILIES.has(lower(node.name))) ||
      (Array.isArray(node.children) && hasGenericFamily(node.children)),
  );
}

function describeNode(node) {
  switch (node.type) {
    case 'Hash':
      return `#${node.value}`;
    case 'Function':
      return `${node.name}()`;
    case 'Identifier':
      return node.name;
    case 'Dimension':
      return `${node.value}${node.unit}`;
    default:
      return node.value ?? node.type;
  }
}

/**
 * Checks one declaration value.
 * @param {string} property CSS property name (kebab-case, as written).
 * @param {{ type: string, children?: unknown[], value?: string }} value css-tree `Value` (or `Raw`) node.
 * @param {(messageId: string, data: Record<string, string>, node: object) => void} report
 */
function checkValue(property, value, report) {
  const custom = property.startsWith('--');
  const name = custom ? lower(property) : unprefixed(property);
  const children = valueChildren(value);
  if (children === null) return;

  // A shadow or a font is a list of parts, so it is judged as a whole: one report per declaration.
  const isShadow = SHADOW_PROPERTIES.has(name) || (custom && SHADOW_NAME.test(name));
  const isFont = FONT_PROPERTIES.has(name) || (custom && (FONT_NAME.test(name) || hasGenericFamily(children)));
  if (isShadow && !isTokenList(children)) {
    report('rawShadow', { property }, value);
    return;
  }
  if (isFont && !isTokenList(children)) {
    report('rawFont', { property }, value);
    return;
  }

  const namedColorsApply = COLOR_PROPERTY.test(name);
  const visit = (nodes) => {
    for (const node of nodes) {
      switch (node.type) {
        case 'Hash':
          report('rawColor', { property, value: describeNode(node) }, node);
          break;
        case 'Identifier':
          if (namedColorsApply && NAMED_COLORS.has(lower(node.name))) report('rawColor', { property, value: node.name }, node);
          break;
        case 'Dimension':
          if (LENGTH_UNITS.has(lower(node.unit)) && !isZeroOrHairline(node)) {
            report('rawLength', { property, value: describeNode(node) }, node);
          }
          break;
        case 'Function':
          if (COLOR_FUNCTIONS.has(lower(node.name))) report('rawColor', { property, value: describeNode(node) }, node);
          else if (lower(node.name) === 'drop-shadow') report('rawShadow', { property }, node);
          else visit(node.children);
          break;
        case 'Raw': {
          const inner = valueChildren(node);
          if (inner) visit(inner);
          break;
        }
        default:
          if (Array.isArray(node.children)) visit(node.children);
      }
    }
  };
  visit(children);
}

/** The children of a `Value`; a `Raw` value (custom properties, unparsed text) is parsed on demand. */
function valueChildren(value) {
  if (isType(value, 'Value')) return value.children;
  if (isType(value, 'Raw')) {
    try {
      return parseValue(value.value)?.children ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Parses CSS value text into a plain-object tree (arrays for `children`, like the tree @eslint/css hands to rules). */
function parseValue(text) {
  const parsed = toPlainObject(parse(text, { context: 'value' }));
  return isType(parsed, 'Value') ? parsed : null;
}

function isZeroOrHairline(dimension) {
  const amount = Number(dimension.value);
  return amount === 0 || (amount === 1 && lower(dimension.unit) === 'px');
}

const kebab = (name) => name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/** Unwraps `{...} as Style`, `{...} satisfies Style` and `{...}!` (typescript-eslint nodes). */
function unwrap(expression) {
  let node = expression;
  while (node && (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression')) {
    node = node.expression;
  }
  return node;
}

export default {
  meta: {
    type: 'problem',
    languages: ['css/css', 'js/js'],
    docs: {
      description:
        'Disallow raw colours, lengths, fonts and shadows in CSS and in inline JSX styles; use the shared design tokens',
      recommended: false,
    },
    schema: [],
    messages: {
      rawColor: "Raw colour '{{value}}' in '{{property}}'. Use a colour token from packages/ui/src/tokens, such as var(--gm3-sys-color-primary).",
      rawLength:
        "Raw length '{{value}}' in '{{property}}'. Use a spacing or size token, such as var(--space-2). Without a token only 0, 1px, %, fr, auto and viewport units are allowed.",
      rawFont: "Raw font in '{{property}}'. Use a font token from packages/ui/src/tokens.",
      rawShadow: "Raw shadow in '{{property}}'. Use an elevation token from packages/ui/src/tokens.",
    },
  },

  create(context) {
    const filename = (context.filename ?? context.physicalFilename ?? '').replaceAll('\\', '/');
    if (TOKENS_DIR.test(filename)) return {};

    /** A JSX string: parse it as a CSS value and check it as the property's declaration value. */
    function checkText(property, text, at) {
      let parsed;
      try {
        parsed = parseValue(text);
      } catch {
        return; // not CSS we can read: leave it
      }
      if (parsed) checkValue(property, parsed, (messageId, data) => context.report({ node: at, messageId, data }));
    }

    /** A JSX number: React turns a bare number into px, so 12 is 12px. 0 and 1 (1px) are the allowed forms. */
    function checkNumber(property, amount, at) {
      if (amount === 0 || amount === 1) return;
      if (UNITLESS_PROPERTIES.has(unprefixed(property))) return;
      context.report({ node: at, messageId: 'rawLength', data: { property, value: `${amount}` } });
    }

    function checkStyleValue(property, node) {
      if (!node) return;
      switch (node.type) {
        case 'Literal':
          if (typeof node.value === 'string') checkText(property, node.value, node);
          else if (typeof node.value === 'number') checkNumber(property, node.value, node);
          break;
        case 'TemplateLiteral':
          // a template with ${...} holes is dynamic: only a fully static one can be judged
          if (node.expressions.length === 0) checkText(property, node.quasis.map((q) => q.value.cooked ?? '').join(''), node);
          break;
        case 'UnaryExpression':
          if ((node.operator === '-' || node.operator === '+') && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
            checkNumber(property, node.operator === '-' ? -node.argument.value : node.argument.value, node);
          }
          break;
        case 'ConditionalExpression':
          checkStyleValue(property, unwrap(node.consequent));
          checkStyleValue(property, unwrap(node.alternate));
          break;
        case 'LogicalExpression':
          checkStyleValue(property, unwrap(node.left));
          checkStyleValue(property, unwrap(node.right));
          break;
        default:
          break; // identifiers, calls, member accesses: not static, not judged
      }
    }

    return {
      // CSS: css-tree `Declaration` nodes
      Declaration(declaration) {
        checkValue(declaration.property, declaration.value, (messageId, data, node) => {
          context.report({ loc: node.loc ?? declaration.loc, messageId, data });
        });
      },

      // JSX: <el style={{ prop: 'value' }} />
      JSXAttribute(attribute) {
        if (attribute.name.type !== 'JSXIdentifier' || attribute.name.name !== 'style') return;
        if (attribute.value?.type !== 'JSXExpressionContainer') return;
        const styles = unwrap(attribute.value.expression);
        if (styles?.type !== 'ObjectExpression') return;

        for (const member of styles.properties) {
          if (member.type !== 'Property' || member.computed) continue;
          let key = null;
          if (member.key.type === 'Identifier') key = member.key.name;
          else if (member.key.type === 'Literal' && typeof member.key.value === 'string') key = member.key.value;
          if (key !== null) checkStyleValue(kebab(key), unwrap(member.value));
        }
      },
    };
  },
};
