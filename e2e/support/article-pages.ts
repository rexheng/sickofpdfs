// Web pages with articles, for "Save this page to library" (spec R103), served by the fixture server under `/a/`. They are
// made up, but laid out the way real sites are: a Medium-style post, a news article with photographs and captions, a blog
// post with code blocks, lists and a table, a post that quotes a card number, and a sign-in page with no article. Each page carries the clutter a real page
// has (a site menu, share buttons, "more stories", a footer), which the article reader must leave out.
//
// Every picture comes from this server too (`/a/img/*`), drawn here, so nothing outside the fixture server is ever asked
// for. `/a/img/missing.jpg` is a picture that is not there (a 404), so a page has one picture that cannot be copied.
import { encode } from 'jpeg-js';

/** A made-up photograph, `w` by `h`: a sky, a sun and hills (or water), in the colours of `scene`. */
function photo(scene: 'dawn' | 'harbour' | 'field', w: number, h: number): Buffer {
  const data = Buffer.alloc(w * h * 4);
  const palette = {
    dawn: { top: [38, 64, 122], bottom: [246, 176, 128], sun: [255, 236, 190], land: [44, 52, 70] },
    harbour: { top: [116, 170, 214], bottom: [214, 232, 244], sun: [255, 250, 230], land: [32, 84, 120] },
    field: { top: [150, 196, 232], bottom: [236, 240, 222], sun: [255, 248, 214], land: [86, 132, 62] },
  }[scene];
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      let c = mix(palette.top, palette.bottom, Math.min(1, t * 1.3));
      const dx = x - w * 0.68;
      const dy = y - h * 0.42;
      const d = Math.sqrt(dx * dx + dy * dy) / (h * 0.11);
      if (d < 1) c = mix(c, palette.sun, 1 - d * d * 0.4);
      else if (d < 2.2) c = mix(c, palette.sun, (2.2 - d) / 4);
      const ridge = h * (0.66 + 0.05 * Math.sin(x / (w * 0.09)) + 0.03 * Math.sin(x / (w * 0.031) + 1));
      if (y > ridge) c = mix(palette.land, [10, 14, 20], Math.min(1, (y - ridge) / (h * 0.5)));
      const grain = ((x * 7919 + y * 104729) % 13) - 6;
      const o = (y * w + x) * 4;
      data[o] = Math.max(0, Math.min(255, c[0] + grain));
      data[o + 1] = Math.max(0, Math.min(255, c[1] + grain));
      data[o + 2] = Math.max(0, Math.min(255, c[2] + grain));
      data[o + 3] = 255;
    }
  }
  return Buffer.from(encode({ data, width: w, height: h }, 86).data);
}

/** A bar chart as SVG: a drawing, which the PDF keeps as a sharp PNG. */
const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360">
<rect width="720" height="360" fill="#ffffff"/>
<g font-family="Arial, sans-serif" font-size="16" fill="#444746">
<text x="40" y="36" font-size="20" fill="#1f1f1f">Rainfall by month (mm)</text>
${[62, 48, 55, 41, 38, 45, 52, 60, 58, 71, 80, 76]
  .map((v, i) => `<rect x="${60 + i * 52}" y="${320 - v * 3}" width="34" height="${v * 3}" rx="4" fill="#0b57d0"/><text x="${66 + i * 52}" y="342">${'JFMAMJJASOND'[i]}</text>`)
  .join('')}
<line x1="50" y1="320" x2="690" y2="320" stroke="#c4c7c5" stroke-width="2"/>
</g></svg>`;

const IMAGES: Record<string, () => { type: string; body: Buffer }> = {
  '/a/img/dawn.jpg': () => ({ type: 'image/jpeg', body: photo('dawn', 2400, 1350) }),
  '/a/img/harbour.jpg': () => ({ type: 'image/jpeg', body: photo('harbour', 1600, 1067) }),
  '/a/img/field.jpg': () => ({ type: 'image/jpeg', body: photo('field', 1200, 800) }),
  '/a/img/chart.svg': () => ({ type: 'image/svg+xml', body: Buffer.from(CHART_SVG) }),
  '/a/img/avatar.jpg': () => ({ type: 'image/jpeg', body: photo('field', 64, 64) }),
};
const imageCache = new Map<string, { type: string; body: Buffer }>();

/** The picture at `path`, or null when there is none (`/a/img/missing.jpg` never is). */
export function articleImage(path: string): { type: string; body: Buffer } | null {
  const make = IMAGES[path];
  if (make === undefined) return null;
  let hit = imageCache.get(path);
  if (hit === undefined) {
    hit = make();
    imageCache.set(path, hit);
  }
  return hit;
}

const SITE_CSS = `
body { margin: 0; font: 18px/1.6 Georgia, serif; color: #242424; }
header.site, footer.site { font: 14px/1.4 Arial, sans-serif; padding: 16px 24px; background: #fafafa; border-bottom: 1px solid #eee; }
header.site nav a, footer.site a { margin-right: 16px; color: #555; }
main { max-width: 700px; margin: 32px auto; padding: 0 24px; }
figure { margin: 32px 0; } figure img { width: 100%; height: auto; } figcaption { font: 14px Arial, sans-serif; color: #6b6b6b; text-align: center; }
pre { background: #f2f2f2; padding: 16px; overflow-x: auto; font-size: 14px; }
aside, .share, .related { font: 14px Arial, sans-serif; color: #555; border-top: 1px solid #eee; padding-top: 12px; }
blockquote { border-left: 3px solid #242424; margin: 24px 0; padding-left: 20px; font-style: italic; }
table { border-collapse: collapse; } td, th { border-bottom: 1px solid #ddd; padding: 6px 12px; text-align: left; }
`;

function page(o: { title: string; head?: string; body: string }): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${o.title}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${SITE_CSS}</style>${o.head ?? ''}</head><body>${o.body}</body></html>`;
}

const MEDIUM = page({
  title: 'How to Read a Research Paper Without Drowning | by Ada Lovelace | Medium',
  head: `<meta property="og:site_name" content="Medium"><meta property="og:title" content="How to Read a Research Paper Without Drowning">
<meta name="author" content="Ada Lovelace"><meta property="article:published_time" content="2026-11-03T09:12:00.000Z">
<link rel="canonical" href="/a/medium-post">`,
  body: `<header class="site"><nav><a href="/a/medium-post">Medium</a><a href="#">Write</a><a href="#">Sign in</a><a href="#">Get started</a></nav></header>
<main><article>
<h1>How to Read a Research Paper Without Drowning</h1>
<div class="byline"><img class="avatar" src="/a/img/avatar.jpg" width="44" height="44" alt="Ada Lovelace"> <a rel="author" href="#">Ada Lovelace</a> · <a href="#">Follow</a><br><span>7 min read · Nov 3, 2026</span></div>
<div class="share"><button>Clap 1.2K</button> <button>Share</button> <button>Save</button></div>
<section>
<p>Most people read papers <em>front to back</em>, and most people give up by page three. I did too, for years. Then a supervisor showed me a method that turned a dreaded afternoon into twenty calm minutes, and it starts with the <strong>figures</strong>, not the words.</p>
<p>The method is not mine. It comes from <a href="/a/keshav-note">S. Keshav’s note “How to Read a Paper”</a>, which every new graduate student should be handed on their first day. Here is how I use it, with the changes that made it stick for me. 📚</p>
<figure><picture><source srcset="/a/img/dawn.jpg 2400w" type="image/jpeg"><img src="/a/img/dawn.jpg" alt="A calm sky at dawn over dark hills" width="680" height="383"></picture><figcaption>Reading a paper should feel like this: calm, with the shape of things clear before the details.</figcaption></figure>
<h2>The first pass: five minutes</h2>
<p>Read the title, the abstract and the introduction. Then read the section headings, and nothing else. Look at every figure and table, and read their captions. Read the conclusion. Glance at the references and tick off the ones you already know.</p>
<p>At the end of the first pass you should be able to answer the five Cs:</p>
<ol>
<li><strong>Category.</strong> What kind of paper is it? A measurement, an analysis of an existing system, a new idea?</li>
<li><strong>Context.</strong> Which other papers is it related to, and which theories does it build on?</li>
<li><strong>Correctness.</strong> Do the assumptions look valid?</li>
<li><strong>Contributions.</strong> What are the paper’s main claims?</li>
<li><strong>Clarity.</strong> Is it well written?</li>
</ol>
<blockquote><p>“If you cannot explain it simply, you do not understand it well enough.” Try to explain the paper to a friend after the first pass. If you can’t, you have found what to look for in the second.</p></blockquote>
<h2>The second pass: an hour</h2>
<p>Read with more care, but ignore the proofs. Jot down the key points, and make comments in the margins as you go. Mark the terms you don’t know and the papers you want to read next. They are the start of your own reading list, and they show you the shape of the field.</p>
<ul>
<li>Look hard at the figures, diagrams and graphs. Are the axes labelled? Are there error bars?</li>
<li>Note the references you have not read.
<ul><li>Some will be classics that everyone cites.</li><li>Some will be the paper’s real rivals.</li></ul></li>
<li>Summarise the main thrust in a few sentences, in your own words.</li>
</ul>
<h2>The third pass: rebuild it</h2>
<p>The third pass is for papers you must really understand, such as ones you will review or build on. Try to re-create the work: make the same assumptions, and see whether you reach the same results. It takes four or five hours for a beginner, and about an hour for an expert. It is also where you find the paper’s hidden weaknesses.</p>
<p>When a paper uses a formula such as <code>accuracy = correct / total</code>, work one example by hand. You will be surprised how often the definition in the text and the one in the code differ.</p>
<h3>A last tip</h3>
<p>Keep notes on every paper in one place, so you can search them later. That is exactly what a good reading tool should do for you.</p>
</section>
</article>
<div class="related"><h4>More from Ada Lovelace</h4><ul><li><a href="#">Ten things I wish I knew before my PhD</a></li><li><a href="#">Why your literature review is too long</a></li></ul></div>
</main>
<footer class="site"><a href="#">Help</a><a href="#">Status</a><a href="#">About</a><a href="#">Careers</a><a href="#">Privacy</a><a href="#">Terms</a></footer>`,
});

const NEWS = page({
  title: 'City’s new flood barrier passes its first big test - The Daily Chronicle',
  head: `<meta property="og:site_name" content="The Daily Chronicle"><meta name="author" content="Jane Smith and Tom Brown">
<meta property="article:published_time" content="2026-11-05T07:30:00Z"><meta property="og:type" content="article">`,
  body: `<header class="site"><nav><a href="#">The Daily Chronicle</a><a href="#">News</a><a href="#">Politics</a><a href="#">Business</a><a href="#">Science</a><a href="#">Sport</a><a href="#">Subscribe</a></nav></header>
<main><article>
<p class="kicker">Environment</p>
<h1>City’s new flood barrier passes its first big test</h1>
<p class="standfirst"><strong>Engineers say the £220m scheme held back a record tide on Tuesday night, but residents downstream want answers about the water that was diverted to them.</strong></p>
<p class="byline">By <a rel="author" href="#">Jane Smith</a> and <a rel="author" href="#">Tom Brown</a>, Environment correspondents · <time datetime="2026-11-05T07:30:00Z">5 November 2026</time></p>
<figure><img src="/a/img/harbour.jpg" alt="The harbour wall at high tide" width="700" height="467"><figcaption>The harbour wall at high tide on Tuesday evening. Photograph: Sam Patel/The Daily Chronicle</figcaption></figure>
<p>The city’s new tidal barrier faced its first real test on Tuesday night, when a storm surge pushed the river to its highest level in forty years. The gates closed at 7.42pm, and the water stopped two metres short of the old quay.</p>
<p>“It did exactly what it was designed to do,” said Dr Priya Raman, the engineer who led the project. “Ten years ago, that tide would have flooded the whole of the lower town.”</p>
<div class="ad">Advertisement</div>
<p>The barrier, which took six years to build, is made of eight steel gates, each the height of a four-storey building. When the tide rises above a set level, the gates swing up from the riverbed in about twenty minutes.</p>
<figure><img src="/a/img/missing.jpg" alt="A map of the barrier and the river" width="700" height="420"><figcaption>Where the water went: the barrier, the old quay and the marshes downstream.</figcaption></figure>
<h2>Questions downstream</h2>
<p>Not everyone is celebrating. In the villages below the barrier, several farmers say their fields flooded for the first time in memory. They believe water held back by the gates was pushed onto the marshes instead.</p>
<p>“We were told this would protect everyone,” said Martin Hughes, who farms 300 acres near the estuary. “My lower fields were under a foot of water by midnight.”</p>
<figure><img class="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/a/img/field.jpg" alt="Flooded fields near the estuary" width="700" height="467" loading="lazy"><figcaption>Fields near the estuary on Wednesday morning. Photograph: Martin Hughes</figcaption></figure>
<p>The Environment Agency said it would study the data from Tuesday night and publish its findings within a month. A spokesperson said the marshes were “designed to take some water” in extreme events, and that the barrier had reduced the total flooding across the region.</p>
<p>Councillors will discuss the barrier at a public meeting on 18 November. Residents can send questions in advance to <a href="mailto:barrier@example.org">barrier@example.org</a>.</p>
</article>
<aside class="related"><h3>Most read</h3><ol><li><a href="#">Bus fares to rise in January</a></li><li><a href="#">The best walks in the hills this winter</a></li><li><a href="#">Local bakery wins national prize</a></li></ol></aside>
<div class="share">Share this article: <a href="#">Email</a> <a href="#">Facebook</a> <a href="#">X</a></div>
</main>
<footer class="site"><a href="#">About us</a><a href="#">Contact</a><a href="#">Advertise</a><a href="#">Privacy policy</a><a href="#">Cookie settings</a></footer>`,
});

const BLOG = page({
  title: 'Cleaning messy CSV files with pandas — Notes from the lab',
  head: `<meta property="og:site_name" content="Notes from the lab"><meta name="author" content="Sam Okafor"><meta property="article:published_time" content="2026-10-28">`,
  body: `<header class="site"><nav><a href="#">Notes from the lab</a><a href="#">Archive</a><a href="#">Tags</a><a href="#">About</a><a href="#">RSS</a></nav></header>
<main><article>
<h1>Cleaning messy CSV files with pandas</h1>
<p class="meta">Posted on 28 October 2026 by Sam Okafor · Tags: python, data</p>
<p>Every dataset I have ever been given arrived as a CSV file, and every one of them was messy. This post walks through the five steps I now use every time, with the code. It assumes you know a little Python and have <code>pandas</code> installed.</p>
<h2>1. Read it without guessing</h2>
<p>Don’t let pandas guess the types. Read everything as text first, then convert the columns you understand:</p>
<pre><code class="language-python">import pandas as pd

df = pd.read_csv("survey.csv", dtype=str, keep_default_na=False)
print(df.shape)          # (1204, 17)
print(df.columns.tolist())
</code></pre>
<h2>2. Fix the column names</h2>
<p>Column names with spaces, capitals and stray punctuation make every later line harder to read. Clean them once:</p>
<pre><code class="language-python">df.columns = (
    df.columns.str.strip()
              .str.lower()
              .str.replace(r"[^a-z0-9]+", "_", regex=True)
              .str.strip("_")
)
</code></pre>
<h2>3. Decide what “missing” means</h2>
<p>A blank cell, <code>NA</code>, <code>n/a</code>, <code>-</code> and <code>999</code> can all mean “no answer”. Write the list down, and replace them all at once:</p>
<ul>
<li>Blank strings and whitespace</li>
<li>The text markers: <code>NA</code>, <code>N/A</code>, <code>none</code></li>
<li>Survey codes, which you must check in the codebook:
<ol><li><code>999</code>: refused to answer</li><li><code>998</code>: don’t know</li></ol></li>
</ul>
<h2>4. Convert the types</h2>
<p>Now convert, and let the errors show you the rows that need a look:</p>
<table><thead><tr><th>Column</th><th>Convert with</th><th>Watch out for</th></tr></thead>
<tbody><tr><td>age</td><td><code>pd.to_numeric</code></td><td>“42 years”, “forty”</td></tr>
<tr><td>date</td><td><code>pd.to_datetime</code></td><td>Day and month swapped</td></tr>
<tr><td>income</td><td><code>pd.to_numeric</code> after removing “£” and commas</td><td>Ranges such as “20–30k”</td></tr></tbody></table>
<figure><img src="/a/img/chart.svg" alt="Bar chart of rainfall by month" width="720" height="360"><figcaption>A quick plot is the fastest way to spot a value that is off by a factor of ten.</figcaption></figure>
<h2>5. Save a clean copy</h2>
<p>Finally, save the clean data under a new name, and never overwrite the original:</p>
<pre><code class="language-bash">$ python clean.py data/raw/survey.csv data/clean/survey.parquet
Read 1204 rows, wrote 1198 rows (6 dropped: no consent)
</code></pre>
<p>The full script is on the project page at https://example.org/notes-from-the-lab/2026/10/cleaning-messy-csv-files-with-pandas/clean.py if you want to copy it.</p>
</article>
<aside class="related"><h3>Related posts</h3><ul><li><a href="#">Plotting with seaborn in ten minutes</a></li><li><a href="#">Why I stopped using Excel for data</a></li></ul></aside>
<div class="comments"><h3>3 comments</h3><p>Great post, thanks!</p></div>
</main>
<footer class="site">© 2026 Sam Okafor · <a href="#">Licence</a></footer>`,
});

/** A post with a card number in it, so the save's check of every page finds one (R91, D9). */
const CARD_STORY = page({
  title: 'My card was copied at a cash machine. Here is what I learned - Money Notes',
  head: `<meta property="og:site_name" content="Money Notes"><meta name="author" content="Lee Carter"><meta property="article:published_time" content="2026-10-12">`,
  body: `<header class="site"><nav><a href="#">Money Notes</a><a href="#">Saving</a><a href="#">Banking</a></nav></header>
<main><article><h1>My card was copied at a cash machine. Here is what I learned</h1>
<p>Last month somebody copied my debit card at a cash machine in the station. I only noticed when my bank texted me about a payment I had not made. This is what happened next, and what I now do differently.</p>
<p>The bank's letter listed the card that was stopped: Visa debit 4111 1111 1111 1111, expiry 09/29. The new card came three days later, and the money was back in my account within a week.</p>
<h2>What I do now</h2>
<p>I cover the keypad with my other hand, every time. I use the machines inside the bank where I can, because they are harder to tamper with. And I have switched on the alerts for every payment, so I see a strange one within seconds rather than days.</p>
<p>If it happens to you, call the number on the back of your card at once, and ask the bank to send you the details of every payment in writing. Keep the letters: you may need them later.</p>
</article></main>`,
});

const SIGN_IN = page({
  title: 'Sign in - Workspace',
  body: `<main style="max-width:360px"><h1>Sign in</h1><form><label>Email <input type="email"></label><br><label>Password <input type="password"></label><br><button>Sign in</button></form><p><a href="#">Forgot your password?</a></p></main>`,
});

/** The article pages, by path. */
export const ARTICLE_PAGES: Record<string, string> = {
  '/a/medium-post': MEDIUM,
  '/a/news-article': NEWS,
  '/a/blog-code': BLOG,
  '/a/card-story': CARD_STORY,
  '/a/sign-in': SIGN_IN,
};
