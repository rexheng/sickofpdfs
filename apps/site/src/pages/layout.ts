// The frame every page shares: a plain white page, small system text, blue underlined links, a short list of links down the side
// (along the top on a phone). No web fonts, no pictures but the sponsor's logo, no trackers. The style is inline, so a page
// is one request.

export interface Page {
  /** The page's own name, before " · sickofpdfs". Null on the home page, whose title is just the name. */
  title: string | null;
  description?: string;
  /** Which side link is the current page. */
  current: 'home' | 'privacy' | null;
  /** The page's content, already escaped. */
  main: string;
  /** Extra content beside the main column on a wide screen (below it on a phone). */
  aside?: string;
  /** The page's own script, inlined. */
  script?: string;
}

export const STYLE = `
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:#fff;color:#000;font:13px/1.5 Verdana,Geneva,"DejaVu Sans",sans-serif}
.page{display:grid;grid-template-columns:132px minmax(0,42em) 200px;gap:0 24px;padding:10px;align-items:start}
.side{align-self:stretch;background:#e6e6e6;padding:8px 10px 14px}
.mark{margin:0;font-size:16px;font-weight:bold;line-height:1.4}
.mark a{color:#000;text-decoration:none}
.mark i{font-style:normal;background:#fde293;padding:0 1px}
.side hr{border:0;border-top:1px solid #b4b4b4;margin:7px 0 6px}
.side ul{list-style:none;margin:0;padding:0}
.side li{margin:2px 0}
.side a{font-weight:bold}
.side [aria-current=page]{color:#000;text-decoration:none}
main{padding-top:4px}
main p{margin:0 0 7px}
h1{font-size:17px;margin:0 0 10px}
h2{font-size:14px;margin:20px 0 7px}
ul.plain{margin:0 0 7px;padding-left:20px}
table{border-collapse:separate;border-spacing:1px;margin:0 -1px}
th,td{padding:4px 12px;text-align:center;white-space:nowrap}
th{background:#fde293}
td{background:#ececec}
.sponsor{border:1px solid #c4c4c4;margin-top:4px}
.sponsor h2{margin:0;padding:1px 8px;background:#e6e6e6;font-size:11px}
.sponsor .logo{display:block;width:124px;padding:16px}
.sponsor img{display:block;width:124px;height:16px}
.sponsor p{margin:0 16px 14px}
label{display:block;margin:0 0 3px}
.row{display:flex;gap:6px;max-width:24em}
.row input{flex:1;min-width:0;font:inherit;padding:3px 5px}
.row button{font:inherit;padding:3px 14px}
#bot-check{margin-top:8px}
#bot-check:empty{display:none}
.status{min-height:1.5em;margin:6px 0 4px}
.status.err{color:#b3000c}
.small{font-size:11px;color:#444}
@media (max-width:720px){
  body{font-size:15px}
  .page{display:block;padding:0 16px 28px}
  .side{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 20px;margin:0 -16px 14px;padding:8px 16px}
  .mark{font-size:18px}
  .side hr{display:none}
  .side ul{display:flex;flex-wrap:wrap;gap:0 16px}
  .side li{margin:0}
  .side li a,.side li span{display:inline-block;padding:4px 0}
  table{width:100%}
  th,td{padding:5px 8px}
  .row{max-width:none}
  .row input,.row button{font-size:16px;padding:6px 8px}
  .row button{padding:6px 16px}
  .sponsor{margin-top:24px}
  .small{font-size:13px}
}
`.replace(/\n\s*/g, '');

/** Text for HTML: content or a quoted attribute value. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const LINKS = [
  { id: 'home', href: '/', text: 'Home' },
  { id: null, href: '/#download', text: 'Download' },
  { id: null, href: '/#waitlist', text: 'Waitlist' },
  { id: 'privacy', href: '/privacy', text: 'Privacy' },
] as const;

export function renderPage(page: Page): string {
  const title = page.title ? `${page.title} · sickofpdfs` : 'sickofpdfs';
  const wordmark = '<a href="/">sickof<i>pdfs</i></a>';
  const links = LINKS.map((l) =>
    l.id !== null && l.id === page.current ? `<li><span aria-current="page">${l.text}</span></li>` : `<li><a href="${l.href}">${l.text}</a></li>`,
  ).join('');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${esc(title)}</title>`,
    page.description ? `<meta name="description" content="${esc(page.description)}">` : '',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    `<style>${STYLE}</style>`,
    '<div class="page">',
    // the home page's one heading is the name; on other pages the name is a link home and the page has its own heading
    `<header class="side">${page.current === 'home' ? `<h1 class="mark">${wordmark}</h1>` : `<p class="mark">${wordmark}</p>`}<hr><nav aria-label="Site"><ul>${links}</ul></nav></header>`,
    `<main>${page.main}</main>`,
    page.aside ?? '',
    '</div>',
    page.script ? `<script>${page.script}</script>` : '',
    '',
  ].join('\n');
}
