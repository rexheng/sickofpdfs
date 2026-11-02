// Topics, tag suggestions and related readings (spec R92). Pure and synchronous: no clock, no random, no network. Everything works on
// meaning vectors (the model's output) and the title and abstract words they came from.
//
// What this file promises:
// - `clusterTopics` gives the same topics for the same readings in any order: the readings are sorted by id first, ties are broken by
//   position in that order, and a topic's `key` is a hash of its sorted member ids, so the same members always have the same key.
// - A topic needs at least MIN_TOPIC_SIZE readings, and there is no topic at all until the library has TOPIC_MIN_DOCS readings.
//   A reading that fits nowhere stays out. A reading may be in up to MAX_TOPICS_PER_DOC topics.
// - `suggestTags` only offers a tag the owner has given to at least TAG_MIN_DOCS readings (the 3-reading rule), never one in
//   `removed`, and at most MAX_SUGGESTIONS.
// - `related` is the closest readings by meaning, never the reading itself.
//
// The thresholds were picked by measuring the real model on the 22 learning PDFs of the filter's fixtures (categorise-report.md).
// A bad vector (empty, not finite, all zero) is left out of everything rather than failing.

export interface Doc {
  id: string;
  vector: Float32Array;
  text: { title: string; abstract: string };
}

export interface Topic {
  /** Stable for the same member set: a hash of the sorted member ids. */
  key: string;
  docIds: string[];
  /** The two most telling words, Title Case, joined by " · ". */
  name: string;
}

/** No topic is made until the library holds this many readings. */
export const TOPIC_MIN_DOCS = 6;
/** The fewest readings in a topic. */
export const MIN_TOPIC_SIZE = 2;
/** Two groups of readings are joined while their average closeness (cosine) is at least this. */
export const MERGE_SIMILARITY = 0.28;
/** A reading that is not in a topic joins it anyway when its average closeness to the topic's readings is at least this. */
export const ATTACH_SIMILARITY = 0.22;
/** The most topics one reading is in. */
export const MAX_TOPICS_PER_DOC = 3;
/** The owner must have given a tag to this many readings before it is suggested (the 3-reading rule). */
export const TAG_MIN_DOCS = 3;
/** A tag is suggested when the reading's average closeness to the 3 nearest readings that carry it is at least this. */
export const SUGGEST_SIMILARITY = 0.25;
/** The most tags suggested for one reading. */
export const MAX_SUGGESTIONS = 3;
/** Words in a topic's name. */
export const TOPIC_NAME_WORDS = 2;

// ---- vectors ---------------------------------------------------------------------------------------------------------------------

interface Unit {
  id: string;
  v: Float32Array;
  text: Doc['text'];
}

/** A copy of the vector scaled to length 1, or null when it cannot be used (empty, not finite, all zero). */
function unitOf(vector: Float32Array): Float32Array | null {
  if (!(vector instanceof Float32Array) || vector.length === 0) return null;
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    const x = vector[i];
    if (!Number.isFinite(x)) return null;
    norm += x * x;
  }
  if (!(norm > 0)) return null;
  const scale = 1 / Math.sqrt(norm);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i]) * scale;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]) * (b[i]);
  return s;
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The usable readings, one per id, sorted by id. */
function prepare(docs: readonly Doc[]): Unit[] {
  const seen = new Set<string>();
  const out: Unit[] = [];
  for (const d of [...docs].sort((a, b) => byCode(a.id, b.id))) {
    if (typeof d?.id !== 'string' || d.id === '' || seen.has(d.id)) continue;
    const v = unitOf(d.vector);
    if (v === null) continue;
    seen.add(d.id);
    out.push({ id: d.id, v, text: d.text ?? { title: '', abstract: '' } });
  }
  return out;
}

// ---- grouping ---------------------------------------------------------------------------------------------------------------------

/**
 * Average-linkage grouping: start with every reading alone and keep joining the two closest groups (the average cosine between their
 * members) while that closeness is at least `threshold`. Returns groups of indexes, each sorted, the groups sorted by first index.
 * Memory is n squared floats and time about n squared; a library of 2,000 readings takes a second or so.
 */
function groupBySimilarity(units: readonly Unit[], threshold: number): number[][] {
  const n = units.length;
  const sim = new Float32Array(n * n);
  // The vectors in one flat array, so the n-squared pass reads memory in a straight line.
  const dim = (units[0]).v.length;
  const flat = new Float32Array(n * dim);
  const usable = units.map((u) => u.v.length === dim);
  units.forEach((u, i) => {
    if (usable[i]) flat.set(u.v, i * dim);
  });
  for (let i = 0; i < n; i++) {
    const ai = i * dim;
    for (let j = i + 1; j < n; j++) {
      const bj = j * dim;
      let s = 0;
      for (let k = 0; k < dim; k++) s += (flat[ai + k]) * (flat[bj + k]);
      sim[i * n + j] = s;
      sim[j * n + i] = s;
    }
  }
  const size = new Int32Array(n).fill(1);
  const alive = new Uint8Array(n).fill(1);
  const members: number[][] = units.map((_, i) => [i]);
  // For each group, its closest partner with a higher index and how close. Kept up to date as groups join.
  const bestJ = new Int32Array(n).fill(-1);
  const bestS = new Float64Array(n).fill(-Infinity);
  const rescan = (i: number): void => {
    let bj = -1;
    let bs = -Infinity;
    for (let j = i + 1; j < n; j++) {
      if (alive[j] !== 1) continue;
      const s = sim[i * n + j];
      if (s > bs) {
        bs = s;
        bj = j;
      }
    }
    bestJ[i] = bj;
    bestS[i] = bs;
  };
  for (let i = 0; i < n; i++) rescan(i);

  for (;;) {
    // The closest pair overall; ties go to the lower index.
    let a = -1;
    let top = -Infinity;
    for (let i = 0; i < n; i++) {
      if (alive[i] === 1 && (bestS[i]) > top) {
        top = bestS[i];
        a = i;
      }
    }
    if (a < 0 || top < threshold) break;
    const b = bestJ[a];
    // Join b into a: the new closeness to every other group is the size-weighted average.
    const sa = size[a];
    const sb = size[b];
    for (let k = 0; k < n; k++) {
      if (alive[k] !== 1 || k === a || k === b) continue;
      const s = (sa * (sim[a * n + k]) + sb * (sim[b * n + k])) / (sa + sb);
      sim[a * n + k] = s;
      sim[k * n + a] = s;
    }
    size[a] = sa + sb;
    members[a] = [...(members[a]), ...(members[b])];
    alive[b] = 0;
    members[b] = [];
    rescan(a);
    for (let k = 0; k < n; k++) if (alive[k] === 1 && k !== a && (bestJ[k] === a || bestJ[k] === b || (k < a && (sim[k * n + a]) > (bestS[k])))) rescan(k);
  }
  return members.filter((m) => m.length > 0).map((m) => [...m].sort((x, y) => x - y));
}

// ---- keys -------------------------------------------------------------------------------------------------------------------------

/** A 64-bit FNV-1a hash of the text, as 16 hex characters. Not a secret and not a checksum for safety: just a stable short name. */
function hash64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** The key of a topic with these members: the same members give the same key, whatever the order they are listed in. */
export function topicKey(docIds: readonly string[]): string {
  return hash64([...docIds].sort(byCode).join('\n'));
}

// ---- names ------------------------------------------------------------------------------------------------------------------------

const STOP_WORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each ' +
    'few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our ' +
    'ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what ' +
    'when where which while who whom why will with would you your yours yourself ' +
    // words that open every paper, lecture and book
    'abstract introduction chapter chapters lecture lectures notes note paper papers article articles section sections figure figures table tables page pages edition version ' +
    'draft preprint university universities institute department school press journal proceedings conference volume number working report reports series course courses ' +
    'et al etc eg ie via per using use used uses based new one two three first second however thus therefore hence may might must shall upon within without among across ' +
    'show shows shown showing study studies present presents presented propose proposes proposed describe describes approach approaches result results method methods ' +
    'work works problem problems case cases example examples well often many much make makes made like need needs given provide provides different various several ' +
    'general introduction overview part parts contents preface foreword acknowledgments references appendix copyright rights reserved http https www com org pdf doi arxiv ' +
    'can cannot able even still yet since whether either neither both each every add third fourth fifth available free online book books reader readers read ' +
    'lecturer lecturers instructor instructors professor prof dr mr ms mrs'
  ).split(/\s+/),
);

const WORD = /\p{L}[\p{L}\p{M}'’-]*\p{L}/gu;

/** Lower-case letters of a word with a plural or "ing" form folded, so "networks" and "network" count as one word. */
function stemOf(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return w;
}

/** The meaningful words of a text: letters only (numbers and codes are left out), at least 3 letters, no stop words. Keeps the surface form. */
function wordsOf(text: string): { stem: string; surface: string }[] {
  const out: { stem: string; surface: string }[] = [];
  for (const m of text.normalize('NFKC').matchAll(WORD)) {
    const surface = m[0].replace(/[’']/g, "'").toLowerCase();
    if (surface.length < 3 || STOP_WORDS.has(surface)) continue;
    const stem = stemOf(surface);
    if (STOP_WORDS.has(stem)) continue;
    out.push({ stem, surface });
  }
  return out;
}

const titleCase = (w: string): string => w.replace(/(^|[-'])(\p{L})/gu, (_m, pre: string, c: string) => pre + c.toUpperCase());

interface WordStats {
  /** The number of readings each word is in (the whole library). */
  df: Map<string, number>;
  /** The most used spelling of each word. */
  surface: Map<string, string>;
  /** Each reading's words and how often it uses them. */
  perDoc: Map<string, Map<string, number>>;
  /** The words of each reading's title. */
  inTitle: Map<string, Set<string>>;
  n: number;
}

function wordStats(units: readonly Unit[]): WordStats {
  const df = new Map<string, number>();
  const spelled = new Map<string, Map<string, number>>();
  const perDoc = new Map<string, Map<string, number>>();
  const inTitle = new Map<string, Set<string>>();
  for (const u of units) {
    const titleWords = wordsOf(u.text.title);
    inTitle.set(u.id, new Set(titleWords.map((w) => w.stem)));
    const words = [...titleWords, ...wordsOf(u.text.abstract)];
    const counts = new Map<string, number>();
    for (const w of words) {
      counts.set(w.stem, (counts.get(w.stem) ?? 0) + 1);
      const forms = spelled.get(w.stem) ?? new Map<string, number>();
      forms.set(w.surface, (forms.get(w.surface) ?? 0) + 1);
      spelled.set(w.stem, forms);
    }
    perDoc.set(u.id, counts);
    for (const stem of counts.keys()) df.set(stem, (df.get(stem) ?? 0) + 1);
  }
  const surface = new Map<string, string>();
  for (const [stem, forms] of spelled) {
    const best = [...forms].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || byCode(a[0], b[0]))[0];
    if (best) surface.set(stem, best[0]);
  }
  return { df, surface, perDoc, inTitle, n: units.length };
}

/**
 * The words that tell a topic apart: for each word, the share of the topic's readings that use it, times how rare it is in the whole
 * library (inverse document frequency), a little more when it is in the readings' titles. A word only one reading of the topic uses
 * does not describe the topic, so words used by two or more come first. Best first; ties by the word.
 */
function tellingWords(memberIds: readonly string[], stats: WordStats): string[] {
  const inTopic = new Map<string, number>();
  const titled = new Map<string, number>();
  for (const id of memberIds) {
    for (const stem of stats.perDoc.get(id)?.keys() ?? []) inTopic.set(stem, (inTopic.get(stem) ?? 0) + 1);
    for (const stem of stats.inTitle.get(id) ?? []) titled.set(stem, (titled.get(stem) ?? 0) + 1);
  }
  const shared = memberIds.length >= 2 ? 2 : 1;
  const scored: { stem: string; score: number; common: boolean }[] = [];
  for (const [stem, count] of inTopic) {
    const idf = Math.log((stats.n + 1) / ((stats.df.get(stem) ?? 0) + 1)) + 1;
    const titleShare = (titled.get(stem) ?? 0) / memberIds.length;
    scored.push({ stem, score: (count / memberIds.length) * idf * (1 + 0.5 * titleShare), common: count >= shared });
  }
  scored.sort((a, b) => Number(b.common) - Number(a.common) || b.score - a.score || byCode(a.stem, b.stem));
  return scored.map((s) => s.stem);
}

function nameOf(words: readonly string[], count: number, stats: WordStats): string {
  return words
    .slice(0, count)
    .map((stem) => titleCase(stats.surface.get(stem) ?? stem))
    .join(' · ');
}

// ---- topics -----------------------------------------------------------------------------------------------------------------------

/**
 * Groups readings that are close in meaning into topics. See the file's header for what is promised. `opts.minDocs` is the number of
 * readings the library must hold before any topic is made (default TOPIC_MIN_DOCS).
 */
export function clusterTopics(docs: Doc[], opts?: { minDocs?: number }): Topic[] {
  const minDocs = opts?.minDocs ?? TOPIC_MIN_DOCS;
  const units = prepare(docs);
  if (units.length < Math.max(minDocs, MIN_TOPIC_SIZE)) return [];

  const groups = groupBySimilarity(units, MERGE_SIMILARITY).filter((g) => g.length >= MIN_TOPIC_SIZE);
  if (groups.length === 0) return [];

  // Members of each group, then every other reading that is close enough joins too (at most MAX_TOPICS_PER_DOC topics each).
  const hard = groups.map((g) => g.map((i) => i));
  const joined = new Map<number, number[]>(); // reading index -> groups it is in
  hard.forEach((g, gi) => g.forEach((i) => joined.set(i, [gi])));
  units.forEach((u, i) => {
    const own = joined.get(i) ?? [];
    if (own.length >= MAX_TOPICS_PER_DOC) return;
    const candidates: { gi: number; mean: number }[] = [];
    hard.forEach((g, gi) => {
      if (own.includes(gi)) return;
      let total = 0;
      let count = 0;
      for (const j of g) {
        if (j === i) continue;
        total += dot(u.v, (units[j]).v);
        count += 1;
      }
      if (count > 0 && total / count >= ATTACH_SIMILARITY) candidates.push({ gi, mean: total / count });
    });
    candidates.sort((a, b) => b.mean - a.mean || a.gi - b.gi);
    for (const c of candidates.slice(0, MAX_TOPICS_PER_DOC - own.length)) own.push(c.gi);
    if (own.length > 0) joined.set(i, own);
  });
  const finalMembers: string[][] = hard.map(() => []);
  for (const [i, gs] of joined) for (const gi of gs) (finalMembers[gi]).push((units[i]).id);

  const stats = wordStats(units);
  const topics = finalMembers.map((ids) => {
    const docIds = [...ids].sort(byCode);
    return { key: topicKey(docIds), docIds, words: tellingWords(docIds, stats) };
  });
  // Biggest first, then by key, so the order does not depend on how the groups were found.
  topics.sort((a, b) => b.docIds.length - a.docIds.length || byCode(a.key, b.key));

  // Names are made in that order; a name already used gets one more word, and then a number, so no two topics read the same.
  const used = new Set<string>();
  return topics.map((t) => {
    let name = nameOf(t.words, TOPIC_NAME_WORDS, stats);
    for (let more = TOPIC_NAME_WORDS + 1; (name === '' || used.has(name)) && more <= TOPIC_NAME_WORDS + 2; more++) name = nameOf(t.words, more, stats) || name;
    if (name === '') name = 'Related readings';
    let unique = name;
    for (let i = 2; used.has(unique); i++) unique = `${name} (${i})`;
    used.add(unique);
    return { key: t.key, docIds: t.docIds, name: unique };
  });
}

// ---- tags -------------------------------------------------------------------------------------------------------------------------

/** How close a reading is to a tag's readings: the average of its 3 highest closeness values. Only for tags with at least 3 readings. */
function tagCloseness(v: Float32Array, vectors: readonly Float32Array[]): number | null {
  const sims: number[] = [];
  for (const raw of vectors) {
    const u = unitOf(raw);
    if (u !== null) sims.push(dot(v, u));
  }
  if (sims.length < TAG_MIN_DOCS) return null;
  sims.sort((a, b) => b - a);
  return (sims[0] + sims[1] + sims[2]) / 3;
}

/**
 * The tags the owner uses that suit this reading. `tagged` lists the owner's tags with the vectors of the readings that carry them
 * (this reading left out). A tag is suggested only when it has at least TAG_MIN_DOCS readings and this reading is close in meaning to
 * them. A tag in `removed` (the auto tags the owner took off this reading) is never suggested again. Best first, at most
 * MAX_SUGGESTIONS; a tie goes to the tag whose name sorts first. The strings returned are the `tag` values given.
 */
export function suggestTags(doc: Doc, tagged: { tag: string; vectors: Float32Array[] }[], removed: Set<string>): string[] {
  const v = unitOf(doc.vector);
  if (v === null) return [];
  const gone = new Set(removed);
  const scored: { tag: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const t of tagged) {
    if (typeof t?.tag !== 'string' || t.tag.trim() === '' || seen.has(t.tag)) continue;
    if (gone.has(t.tag)) continue;
    seen.add(t.tag);
    const score = tagCloseness(v, t.vectors);
    if (score !== null && score >= SUGGEST_SIMILARITY) scored.push({ tag: t.tag, score });
  }
  scored.sort((a, b) => b.score - a.score || byCode(a.tag.toLowerCase(), b.tag.toLowerCase()) || byCode(a.tag, b.tag));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.tag);
}

// ---- related ----------------------------------------------------------------------------------------------------------------------

/** The `n` readings (default 5) closest in meaning to `doc`, closest first, never `doc` itself. Ties go to the lower id. */
export function related(doc: Doc, all: Doc[], n = 5): string[] {
  const v = unitOf(doc.vector);
  if (v === null || !Number.isFinite(n) || n <= 0) return [];
  const scored: { id: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const other of all) {
    if (other.id === doc.id || seen.has(other.id)) continue;
    const u = unitOf(other.vector);
    if (u === null) continue;
    seen.add(other.id);
    scored.push({ id: other.id, score: dot(v, u) });
  }
  scored.sort((a, b) => b.score - a.score || byCode(a.id, b.id));
  return scored.slice(0, Math.floor(n)).map((s) => s.id);
}
