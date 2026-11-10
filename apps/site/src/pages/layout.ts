// The frame every page shares: a plain white page, system text, blue underlined links, a short list of links down the side
// (along the top on a phone). No web fonts, no trackers. The style is inline, so a page is one request.
//
// The grid: one centred column, 960 px at most. On a wide screen the left column (184 px) holds the links box and, below it,
// the sponsor box, at the same width; the page's words take the rest. Spacing comes in steps of 4, 8, 12, 16, 24 and 40 px,
// and the type in four sizes: 13 (small print), 15 (body), 17 (section heads), 22 (page titles).

export interface Page {
  /** The page's own name, before " · sickofpdfs". Null on the home page, whose title is just the name. */
  title: string | null;
  description?: string;
  /** Which side link is the current page. */
  current: 'home' | 'features' | 'privacy' | null;
  /** The page's content, already escaped. */
  main: string;
  /** Extra content under the links on a wide screen (below the page on a phone). */
  aside?: string;
  /** The page's own script, inlined. */
  script?: string;
}

export const STYLE = `
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:#fff;color:#111;font:15px/1.6 Verdana,Geneva,"DejaVu Sans",sans-serif}
a{color:#00c}
a:visited{color:#551a8b}
.page{box-sizing:border-box;max-width:960px;margin:0 auto;padding:24px 24px 64px;display:grid;grid-template-columns:184px minmax(0,1fr);grid-template-rows:auto 1fr;gap:0 40px;align-items:start}
.side{grid-column:1;grid-row:1;background:#e8e8e8;padding:12px 16px 16px}
.mark{margin:0;font-size:20px;font-weight:bold;line-height:1.3}
.mark a{color:#000;text-decoration:none}
.mark i{font-style:normal;background:#fde293;padding:0 1px}
.side hr{border:0;border-top:1px solid #bbb;margin:12px 0 8px}
.side ul{list-style:none;margin:0;padding:0}
.side li a,.side li span{display:block;padding:4px 0}
.side a{font-weight:bold}
.side [aria-current=page]{color:#000;font-weight:bold}
main{grid-column:2;grid-row:1/span 2;padding-top:12px;max-width:640px}
main p,main li,.sponsor p{text-wrap:pretty}
main p{margin:0 0 12px}
h1{font-size:22px;line-height:1.3;margin:0 0 16px}
h2{font-size:17px;line-height:1.3;margin:32px 0 12px}
h1+h2{margin-top:24px}
.lead{font-size:17px;line-height:1.5;text-wrap:balance}
ul.plain{margin:0 0 12px;padding-left:20px}
ul.plain li{margin:0 0 6px}
table{border-collapse:separate;border-spacing:2px;margin:0 -2px 12px}
th,td{padding:6px 16px;text-align:left;white-space:nowrap}
th{background:#fde293}
td{background:#eee}
.sponsor{grid-column:1;grid-row:2;margin-top:24px;border:1px solid #ccc;font-size:13px;line-height:1.5}
.sponsor h2{margin:0;padding:4px 16px;background:#e8e8e8;font-size:13px}
.sponsor .logo{display:block;width:124px;padding:16px}
.sponsor img{display:block;width:124px;height:16px}
.sponsor p{margin:0 16px 16px}
label{display:block;margin:0 0 4px}
.row{display:flex;gap:8px;max-width:400px}
.row input{flex:1;min-width:0;font:inherit;padding:0 8px;height:36px;box-sizing:border-box;border:1px solid #888}
.row button{font:inherit;padding:0 20px;height:36px}
#bot-check{margin-top:8px}
#bot-check:empty{display:none}
.status{min-height:1.6em;margin:8px 0 4px}
.status.err{color:#b3000c}
.small{font-size:13px;color:#444}
figure{margin:16px 0 24px}
figure img{display:block;width:100%;height:auto;border:1px solid #ccc}
figcaption{font-size:13px;color:#444;margin-top:8px}
@media (max-width:860px){
  .page{grid-template-columns:160px minmax(0,1fr);gap:0 32px;padding:16px 16px 48px}
}
@media (max-width:640px){
  body{font-size:16px}
  .page{display:block;padding:0 16px 40px}
  .side{display:flex;flex-wrap:wrap;align-items:center;gap:0 24px;margin:0 -16px 24px;padding:4px 16px}
  .mark{font-size:20px}
  .mark a{display:flex;align-items:center;min-height:44px}
  .side hr{display:none}
  .side ul{display:flex;flex-wrap:wrap;gap:0 16px;font-size:15px}
  .side li:first-child{display:none}
  .side li a,.side li span{display:flex;align-items:center;min-height:44px;padding:0}
  main{padding-top:0;max-width:none}
  h1{font-size:24px}
  h2{margin-top:32px}
  .lead{font-size:18px;text-wrap:pretty}
  table{width:calc(100% + 4px)}
  th,td{padding:10px 8px}
  .row{max-width:none}
  .row input,.row button{font-size:16px;height:44px}
  .sponsor{margin-top:40px;font-size:15px}
  .small{font-size:14px}
}
`.replace(/\n\s*/g, '');

/** Text for HTML: content or a quoted attribute value. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const LINKS = [
  { id: 'home', href: '/', text: 'Home' },
  { id: 'features', href: '/features', text: 'Features' },
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
