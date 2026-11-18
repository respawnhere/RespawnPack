/*
 * RespawnPack · kernel/lib/assert.js — the prose-assertion helper the pack should have shipped.
 *
 * ⭐ THIS FILE IS DOGFOOD.md DF-007, IMPLEMENTED. That entry recorded seven hand-rolled drift-checks
 * failing in a single session — and, more damningly, an EIGHTH and NINTH produced while writing the
 * entry that documents the trap. Its verdict: "the pack should ship the assertion helper, not just the
 * checklist", because "a rule that has to be remembered gets violated by the person who just wrote it
 * down."
 *
 * The seven, and which function below answers each:
 *   1. `echo $?` after a pipe captured the wrong exit status .......... (caller discipline — see kernel CLI)
 *   2. `"old claim" not in text` — a self-correcting doc QUOTES what it retires ....... liveClause()
 *   3. same, on a superseded "next task" line ......................................... liveClause()
 *   4. `"A name absent…"` vs `"a name absent…"` — case mismatch ........................ normalise()
 *   5. `"Fewer than all five"` — the sentence WRAPPED across a line .................... normalise()
 *   6. relative-path grep across repos; `cd` had not persisted → 0 everywhere .......... (absolute paths)
 *   7. grep of a symbol map returned 0 for the VALID names too ........................ discriminates()
 *
 * ⛔ Six of the seven share one root cause: **asserting on the RENDERED SURFACE rather than the
 * content.** Markdown emphasis, capitalisation, line wrapping, and quotation-vs-assertion.
 *
 * ⛔ And the dangerous direction is not the false alarm. A false alarm costs a re-read. The identical
 * brittleness PASSING a broken file costs a claim — #6 and #7 were exactly that shape: a check
 * returning 0 that read as confirmation. Hence: never assert substring ABSENCE. Assert occurrence
 * count plus location, so a document may legitimately quote the claim it is retiring.
 */

/**
 * Strip the rendered surface so an assertion sees content.
 * Markdown emphasis, inline code, link syntax, non-breaking and smart punctuation, and — the one that
 * cost failure #5 — line wrapping, collapsed to single spaces.
 */
function normalise(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')            // fenced code is not prose
    .replace(/`([^`]*)`/g, '$1')                 // inline code → its content
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // [label](url) → label
    .replace(/[*_~]{1,3}/g, '')                  // **bold** __underline__ ~~strike~~
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')            // en/em dashes → hyphen
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')                        // ← failure #5: a wrapped sentence is one sentence
    .trim();
}

const foldCase = (text) => normalise(text).toLowerCase(); // ← failure #4

/*
 * A line that RETIRES a claim necessarily contains it. DF-011 hit this on its first run: the checker
 * flagged three GOAL rows that had already been corrected, because a corrected row reads
 * `Superseded: *not started...*`. The claim is present as a QUOTATION, and a substring check cannot
 * tell an assertion from a quotation.
 *
 * These markers say "what follows is history, not the current verdict". Text after one is not live.
 */
const RETIRING_MARKERS = [
  'superseded', 'was:', 'formerly', 'previously', 'retired', 'withdrawn', 'corrected from',
  'no longer', 'used to say', 'obsolete', 'replaced by', 'struck', 'deprecated',
];

/**
 * The live clause of a line: everything before a retiring marker or a strikethrough.
 * Returns '' when the whole line is historical.
 */
function liveClause(line) {
  const raw = String(line);
  if (/^\s*~~[\s\S]*~~\s*$/.test(raw.trim())) return ''; // wholly struck through
  const lower = normalise(raw).toLowerCase();
  let cut = lower.length;
  for (const marker of RETIRING_MARKERS) {
    const i = lower.indexOf(marker);
    if (i >= 0 && i < cut) cut = i;
  }
  return normalise(raw).slice(0, cut).trim();
}

/**
 * Flatten a document into ONE searchable string of live clauses, keeping a map back to line numbers.
 *
 * ⛔ Why one string and not line-by-line: DF-007 failure #5 was an assertion on `"Fewer than all five"`
 * that missed because the sentence WRAPPED across a line. A per-line search reproduces that bug exactly
 * — the match never exists on any single line. Joining first is the fix; the offset map is what keeps
 * "plus location" honest afterwards.
 */
function liveDocument(text, { scope = 'live', caseSensitive = false } = {}) {
  const norm = caseSensitive ? normalise : foldCase;
  const lines = String(text).split(/\r?\n/);
  const spans = [];
  let joined = '';
  for (let i = 0; i < lines.length; i++) {
    const clause = scope === 'live' ? liveClause(lines[i]) : lines[i];
    const piece = norm(clause);
    if (!piece) continue;
    if (joined) joined += ' ';
    spans.push({ start: joined.length, end: joined.length + piece.length, line: i + 1, raw: lines[i] });
    joined += piece;
  }
  return { text: joined, spans, lines };
}

const lineAt = (spans, offset) => {
  const s = spans.find((x) => offset >= x.start && offset < x.end) || spans[spans.length - 1];
  return s || { line: 1, raw: '' };
};

/**
 * Every occurrence of `needle`, with its location. **Location matters as much as the count**: DF-007's
 * rule is "assert on occurrence count plus location, never on substring absence."
 * `scope: 'live'` (the default) ignores retired clauses; `scope: 'any'` searches everything.
 */
function occurrences(text, needle, opts = {}) {
  const { caseSensitive = false } = opts;
  const target = (caseSensitive ? normalise : foldCase)(needle);
  if (!target) return [];
  const doc = liveDocument(text, opts);
  const hits = [];
  let from = 0;
  for (;;) {
    const at = doc.text.indexOf(target, from);
    if (at < 0) break;
    const span = lineAt(doc.spans, at);
    hits.push({ line: span.line, column: at - span.start + 1, text: String(span.raw).trim().slice(0, 200) });
    from = at + target.length;
  }
  return hits;
}

/**
 * ⛔ A DISCRIMINATION TEST, NOT AN ASSERTION. DF-007 #7 was a grep that returned 0 for the disputed
 * symbols AND 0 for the valid ones — it discriminated nothing, and its zero read as confirmation.
 * A critical check must be shown to answer DIFFERENTLY for a known-good and a known-bad input before
 * its verdict is worth anything.
 *
 * Returns {ok, detail}. `ok: false` means the check is decoration and its result must be discarded.
 */
function discriminates(check, knownGood, knownBad) {
  let good, bad;
  try { good = check(knownGood); } catch (e) { return { ok: false, detail: `threw on the known-good control: ${e.message}` }; }
  try { bad = check(knownBad); } catch (e) { return { ok: false, detail: `threw on the known-bad control: ${e.message}` }; }
  const same = JSON.stringify(good) === JSON.stringify(bad);
  if (same) return { ok: false, detail: `returned the same answer (${JSON.stringify(good)}) for the known-good AND known-bad controls — it discriminates nothing`, good, bad };
  return { ok: true, detail: 'controls discriminate', good, bad };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * Numeric claims in prose, for comparison against the rows they were derived from. DF-011's whole cost
 * was five drift checks passing while every count in the handoff was stale — "not one was compared
 * against" the machine-readable artifact it came from.
 *
 * ⭐ LABEL-DRIVEN ON PURPOSE. An earlier version of this function guessed labels out of free prose with
 * a lazy regex, and produced things like `conformant rows today` — a label no source could ever be
 * matched against, so the claim was silently dropped and the check quietly examined less than it
 * appeared to. Callers pass the labels they can actually verify. Anything else is not a "claim we chose
 * not to check"; it is out of scope by construction, and the caller's `checked` count says so honestly.
 *
 * Reads live clauses only, joined (so a wrapped sentence still matches — DF-007 #5).
 */
function numericClaims(text, { labels = null } = {}) {
  const doc = liveDocument(text);
  const claims = [];
  const wanted = labels && labels.length
    ? labels
    : [...new Set([...doc.text.matchAll(/\d[\d,]*\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})/g)].map((m) => m[1]))];

  for (const label of wanted) {
    const lab = escapeRe(String(label).toLowerCase());
    // `<n> <label>` and `<label>: <n>` — the two shapes a rendered count actually takes.
    for (const re of [new RegExp(`(\\d[\\d,]*)\\s+${lab}\\b`, 'g'), new RegExp(`${lab}\\s*[:=]\\s*(\\d[\\d,]*)\\b`, 'g')]) {
      for (const m of doc.text.matchAll(re)) {
        const num = Number(String(m[1]).replace(/,/g, ''));
        if (!Number.isFinite(num)) continue;
        const span = lineAt(doc.spans, m.index);
        claims.push({ line: span.line, number: num, label: String(label).toLowerCase(), text: String(span.raw).trim().slice(0, 200) });
      }
    }
  }
  return claims;
}

module.exports = { normalise, foldCase, liveClause, liveDocument, occurrences, discriminates, numericClaims, RETIRING_MARKERS };
