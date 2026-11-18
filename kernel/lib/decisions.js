/*
 * RespawnPack · kernel/lib/decisions.js — the decision shard: parse a DECISIONS.md monolith into one
 * file per decision, and read the shard back as the rendered index's source (B2).
 *
 * ⛔ WHY A SHARD. `docs/DECISIONS.md` is append-only and grows without bound (a live target reached
 * 230 KB / 84 entries, about 695 B each), and `/respawn` reads it whole at every boot. One file per
 * decision under `docs/decisions/` plus a rendered, verified INDEX turns that into the MEMORY.md index
 * pattern: the boot reads an index of one line per decision and opens the one shard it needs on demand.
 *
 * ⛔ THE PARSER NEVER GUESSES. A hand-authored monolith carries variation — a heading with extra spaces,
 * a status wrapped in `**bold**`, a `superseded by D-xxx` tail, a trailing `· owner ruling` segment — and
 * the splitter tolerates exactly that. But a heading it cannot resolve to (id, date, status) is a REFUSAL
 * that names the entry by heading and line, in a dry run or a write alike, and nothing is written: a
 * monolith half-split into a tree the kernel then renders from is worse than one left whole. The one
 * thing carried verbatim is the entry's BODY, so no prose a human wrote is reinterpreted.
 *
 * This module OPENS files (readShard reads the shard directory for the compiler); render.js does not, by
 * fence. The monolith parser takes TEXT, so the verb owns the one read of docs/DECISIONS.md.
 */
const fs = require('fs');
const path = require('path');

const DECISIONS_DIR = path.join('docs', 'decisions');
const INDEX_REL = path.join('docs', 'DECISIONS.md');
const ARCHIVE_REL = path.join('docs', '_archive', 'DECISIONS.md');
// The exact status vocabulary spine/DECISIONS.md declares. A heading whose status word is outside this
// set is a refusal, not a guess — the same discipline the removal registry's schemaVersion check uses.
const STATUS_VOCAB = ['accepted', 'proposed', 'deprecated', 'superseded'];
// The entry heading's own separator is an em-dash; the format owns it, so the parser matches it verbatim
// (and the index re-emits it). The field separator between title, date and status is U+00B7.
const EM_DASH = '—';
const MIDDLE_DOT = '·';

const posix = (p) => String(p).replace(/\\/g, '/');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/*
 * ⛔ THE SLUG IS graphSlugSafe's RULE, STATED ONCE MORE DELIBERATELY. kernel/respawnpack.js's
 * writeGraphEntity derives a graph slug exactly this way (lowercase, non-alphanumeric runs to a single
 * dash, trimmed, capped at 120). The shard filename reuses that rule so a decision slug and a graph slug
 * cannot be two different notions of "safe"; a test pins the two against each other.
 */
function slugSafe(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

/** Strip markdown emphasis and backticks from a heading segment so `**proposed**` reads as `proposed`. */
const unemphasise = (s) => String(s).replace(/[*_`]/g, '').trim();

/**
 * Parse one `### D-NNN — <title> · <date> · <status> [· ⛔ removal]` heading.
 * Returns { id, title, date, status, removal } on success, or { error } naming what could not be read.
 * `null` when the line is not a decision heading at all (a `D-NNN`/`D-00X` placeholder, ordinary prose).
 */
function parseHeading(line) {
  const m = new RegExp(`^#{3,6}\\s+(D-\\d+)\\s+${EM_DASH}\\s+(.+?)\\s*$`).exec(String(line));
  if (!m) return null; // not a decision heading (placeholder id, or prose) — the caller skips it
  const id = m[1];
  const rest = m[2];
  const segs = rest.split(MIDDLE_DOT);
  const dateIdx = segs.findIndex((s) => DATE_RE.test(s.trim()));
  if (dateIdx < 0) return { error: `heading has no \`YYYY-MM-DD\` date segment` };
  const title = segs.slice(0, dateIdx).join(MIDDLE_DOT).trim();
  if (!title) return { error: `heading has no title between the em-dash and the date` };
  const date = segs[dateIdx].trim();
  // The status is the first segment AFTER the date whose first word is a known status vocabulary word —
  // so `superseded by D-012`, `**proposed**` and `accepted (cost record)` all resolve, and a trailing
  // `· owner ruling · ⛔ removal` never shadows the real status.
  let status = null;
  for (let i = dateIdx + 1; i < segs.length; i += 1) {
    const first = unemphasise(segs[i]).split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
    if (STATUS_VOCAB.includes(first)) { status = first; break; }
  }
  if (!status) return { error: `heading declares no status (one of ${STATUS_VOCAB.join(', ')}) after the date` };
  const removal = segs.some((s) => /⛔|\bremoval\b/i.test(s));
  return { id, title, date, status, removal };
}

/*
 * A body carries a removal when any `⛔ Removal`/`⛔ Removal —` line sits in it, not only in the heading.
 * HTML comments are stripped first: spine/DECISIONS.md ships a trailing `<!-- Example removal entry: … -->`
 * that a real monolith keeps, and it lands in the LAST entry's verbatim body — so without this the final
 * decision would be mis-flagged as a removal by a comment that is template scaffolding, not its content.
 */
const bodyDeclaresRemoval = (body) => /⛔\s*\**\s*removal\b/i.test(stripComments(body));
const stripComments = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '');

/**
 * parseMonolith — split a DECISIONS.md monolith into entries, verbatim bodies, refusing the whole run on
 * the first entry it cannot resolve. Returns { ok: true, entries } or { ok: false, error, id, line }.
 *
 * An entry's BODY is every line from its heading up to the next decision heading (or EOF), trimmed of
 * trailing blank lines — carried verbatim, because reinterpreting a human's prose is the guess this
 * refuses to make. Content before the first heading (the preamble, the schema, the how-to-use note) is
 * not an entry; the monolith is archived whole, so that text is never lost.
 */
function parseMonolith(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  // Index every decision heading first, so a body runs exactly to the next one.
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const h = parseHeading(lines[i]);
    if (h === null) continue;
    if (h.error) return { ok: false, error: h.error, id: (/(D-\d+)/.exec(lines[i]) || [])[1] || null, line: i + 1, heading: lines[i].trim() };
    heads.push({ ...h, index: i, line: i + 1 });
  }
  const entries = [];
  const seenIds = new Map();
  const seenSlugs = new Map();
  for (let k = 0; k < heads.length; k += 1) {
    const h = heads[k];
    const end = k + 1 < heads.length ? heads[k + 1].index : lines.length;
    const body = lines.slice(h.index, end).join('\n').replace(/\s+$/, '');
    if (seenIds.has(h.id)) {
      return { ok: false, error: `duplicate id ${h.id} — the same id also appears at line ${seenIds.get(h.id)}; two files cannot share one id, so nothing was written`, id: h.id, line: h.line, heading: lines[h.index].trim() };
    }
    seenIds.set(h.id, h.line);
    const slug = slugSafe(h.title);
    if (seenSlugs.has(slug)) {
      const prior = seenSlugs.get(slug);
      return { ok: false, error: `slug collision: ${h.id} and ${prior.id} both reduce to the slug "${slug || '(empty)'}", so their index links would be ambiguous — rename one title; nothing was written`, id: h.id, line: h.line, heading: lines[h.index].trim() };
    }
    seenSlugs.set(slug, { id: h.id, line: h.line });
    entries.push({
      id: h.id, title: h.title, date: h.date, status: h.status,
      removal: h.removal || bodyDeclaresRemoval(body),
      supersedes: supersedesOf(body), supersededBy: '',
      slug, body, line: h.line,
      file: posix(path.join(DECISIONS_DIR, `${h.id}-${slug}.md`)),
    });
  }
  return { ok: true, entries };
}

/** Best-effort: the `- Supersedes / Superseded-by:` value, minus a bare em-dash placeholder. Never guessed. */
function supersedesOf(body) {
  const m = /^\s*-\s*Supersedes\s*\/\s*Superseded-by:\s*(.+?)\s*$/im.exec(String(body));
  if (!m) return '';
  const v = m[1].trim();
  return v === EM_DASH || v === '-' || v === '' ? '' : v;
}

const yamlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;

/** The frontmatter + verbatim body for one shard file. id/date/status are bare tokens; title is quoted. */
function shardText(entry) {
  const L = ['---'];
  L.push(`id: ${entry.id}`);
  L.push(`date: ${entry.date}`);
  L.push(`status: ${entry.status}`);
  L.push(`title: ${yamlString(entry.title)}`);
  L.push(`removal: ${entry.removal ? 'true' : 'false'}`);
  L.push(`supersedes: ${yamlString(entry.supersedes || '')}`);
  L.push(`supersededBy: ${yamlString(entry.supersededBy || '')}`);
  L.push('---');
  L.push('');
  L.push(entry.body);
  L.push('');
  return L.join('\n');
}

/** The banner the archived monolith carries so a reader knows it is frozen history, not live truth. */
function archiveBanner(generatedAt) {
  const day = String(generatedAt || new Date().toISOString()).slice(0, 10);
  return `<!-- ARCHIVED ${day} — this monolith was split into docs/decisions/ by \`respawnpack migrate decisions\`. `
    + `The live, rendered index is docs/DECISIONS.md. Do not edit; archive, never delete (spine rule 5). -->`;
}

/* ---- the shard reader: the compiled index's source, and the staleness report's ------------------- */

/** Pull `key: value` pairs out of a leading `---`…`---` frontmatter block. Quotes stripped, nothing else. */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return { fm: null, body: String(text || '') };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

/** The first decision heading inside a shard body — the half the frontmatter is cross-checked against. */
function headingOf(body) {
  for (const line of String(body || '').split(/\r?\n/)) {
    const h = parseHeading(line);
    if (h && !h.error) return h;
  }
  return null;
}

/**
 * readShard — the shard directory as the index's source. Returns a store snapshot the renderer and
 * verifier share (the LESSONS register's shape): { status, records, reason }. `records` are sorted by a
 * numeric reading of the id so a fresh render reproduces the index byte-for-byte.
 *
 * Each record carries the frontmatter fields the index renders AND the heading it parsed from the body,
 * so `verifyDecisions` can FAIL a shard whose frontmatter contradicts its own heading — the DF-011 pair,
 * one directory over: the index is rendered from the frontmatter and checked back against the body.
 */
function readShard(dir) {
  const abs = path.join(dir, DECISIONS_DIR);
  let names;
  try { names = fs.readdirSync(abs); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'ABSENT', records: [], reason: `no ${posix(DECISIONS_DIR)}/ directory — this project has not been migrated to the decision shard` };
    return { status: 'UNREADABLE', records: [], reason: `${posix(DECISIONS_DIR)}/ could not be read (${e.code || e.message})` };
  }
  const records = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const rel = posix(path.join(DECISIONS_DIR, name));
    let text;
    try { text = fs.readFileSync(path.join(abs, name), 'utf8'); }
    catch (e) { return { status: 'UNREADABLE', records: [], reason: `${rel} could not be read (${e.code || e.message})` }; }
    const { fm, body } = parseFrontmatter(text);
    const head = headingOf(body);
    const id = (fm && fm.id) || (head && head.id) || name.replace(/\.md$/, '');
    const date = (fm && fm.date) || (head && head.date) || '';
    const title = (fm && fm.title) || (head && head.title) || '';
    const status = (fm && fm.status) || (head && head.status) || '';
    const removal = fm ? fm.removal === 'true' : Boolean(head && head.removal);
    // The contradiction the index verify FAILs on: a frontmatter that disagrees with the body's own
    // heading. Checked only when both exist — a shard with no frontmatter or no heading is reported as
    // its own mismatch so it can never pass as silently consistent.
    let mismatch = null;
    if (!fm) mismatch = `${rel} has no \`---\` frontmatter block`;
    else if (!head) mismatch = `${rel} frontmatter has no matching \`### ${id}\` heading in its body`;
    else {
      const diffs = [];
      if (fm.id && head.id && fm.id !== head.id) diffs.push(`id ${fm.id} vs heading ${head.id}`);
      if (fm.date && head.date && fm.date !== head.date) diffs.push(`date ${fm.date} vs heading ${head.date}`);
      if (fm.status && head.status && fm.status !== head.status) diffs.push(`status ${fm.status} vs heading ${head.status}`);
      if (diffs.length) mismatch = `${rel} frontmatter contradicts its heading (${diffs.join('; ')})`;
    }
    records.push({ id, date, title, status, removal, file: rel, mismatch });
  }
  records.sort((a, b) => (idNum(a.id) - idNum(b.id)) || a.id.localeCompare(b.id) || a.file.localeCompare(b.file));
  // ⛔ ONE ID, ONE FILE. Two files that claim the same decision id (a retried split under a renamed title,
  // a hand copy) are each internally consistent, so the per-file mismatch check passes them; they are
  // collected here so verifyDecisions can FAIL on them by id and file, and `migrate` can refuse on them.
  const byId = new Map();
  for (const r of records) byId.set(r.id, [...(byId.get(r.id) || []), r.file]);
  const duplicates = [...byId].filter(([, files]) => files.length > 1).map(([id, files]) => ({ id, files }));
  return { status: 'OK', records, reason: null, duplicates };
}

/** `D-001 in a.md and b.md` lines for a readShard duplicates list, one per id. */
const describeDuplicates = (dups) => (dups || []).map((d) => `${d.id} in ${d.files.join(' and ')}`).join(' · ');

/*
 * Whether an archive file already holds THIS monolith verbatim: the banner line `migrate` writes, then the
 * monolith's exact text (line endings normalised, so a checkout that rewrote LF to CRLF still matches).
 * Anything else at the archive path is a DIFFERENT monolith, and is never overwritten.
 */
function archiveHolds(archiveText, monolith) {
  if (archiveText == null || monolith == null) return false;
  const lf = (s) => String(s).replace(/\r\n/g, '\n');
  const a = lf(archiveText);
  if (!a.startsWith('<!-- ARCHIVED ')) return false;
  return a.slice(a.indexOf('\n') + 1) === lf(monolith);
}

/** The numeric part of a `D-NNN` id, for a chronological index order; a non-numeric id sorts last. */
const idNum = (id) => { const m = /(\d+)/.exec(String(id || '')); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; };

module.exports = {
  parseMonolith, readShard, shardText, archiveBanner, archiveHolds, describeDuplicates, slugSafe, parseHeading, parseFrontmatter, headingOf,
  DECISIONS_DIR: posix(DECISIONS_DIR), INDEX_REL: posix(INDEX_REL), ARCHIVE_REL: posix(ARCHIVE_REL),
  STATUS_VOCAB, posix,
};
