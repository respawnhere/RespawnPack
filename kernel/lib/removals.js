/*
 * RespawnPack · kernel/lib/removals.js — the structured killed-feature contract (Scenario L).
 *
 * ⛔ WHAT THIS REPLACES. The installed baseline states an absolute — "⛔ killed features are never
 * re-added" — and the only thing behind it was `/savepoint` Step 3 telling an agent to remember to grep.
 * field run A proved what that is worth (RA-2/3): decision D-075 retired the magic gauntlet with
 * "Do not reintroduce either", and four of them plus an entire "Gauntlet Empowerment Rules" section sat
 * live and unmarked in `story/` — a directory the project's own anti-fork scanner never read, because it
 * globbed exactly one folder. The project had already written the general lesson down twice: "any
 * quantity defined in two places will fork; a constant that is not asserted is not constant." It had
 * never generalised it from constants to REMOVALS.
 *
 * ⭐ THE FOUR THINGS THAT MAKE THIS A CONTRACT RATHER THAN A GREP.
 *
 * 1. A REMOVAL IS A STRUCTURED ROW, not a ⛔ someone remembered to type. Each carries an id, the feature
 *    name, and the FORBIDDEN LIVE ASSERTIONS whose presence means it is back. Absent that list there is
 *    nothing to check and the row says so.
 *
 * 2. THE SCAN COVERS EVERY CONFIGURED LIVE-CONTENT DIRECTORY. Not `docs/`. Not one glob. A directory
 *    that is configured but unreadable is CANNOT_DETERMINE — the run-A failure was a blind spot that
 *    reported success, and a scanner that cannot see a directory must not imply it looked.
 *
 * 3. QUOTING A RETIREMENT IS NOT REINTRODUCING IT. This is the DF-007 lesson applied to removals: a
 *    document that retires a feature necessarily NAMES it, so substring presence is not evidence. Only
 *    a LIVE ASSERTION counts — a sentence that is not inside a history section, not a quotation, and
 *    does not itself retire the thing it names.
 *
 * 4. THE CHECK MUST BE SHOWN TO DISCRIMINATE. Every row is probed with a known-bad live assertion and a
 *    known-good retirement sentence before its verdict counts. A phrase so generic that both read the
 *    same makes that row UNVERIFIED, never clear — DF-007 #7 was a check returning zero for the valid
 *    names too, and its zero read as confirmation.
 *
 * ⛔ AND THE NARROWING, STATED RATHER THAN IMPLIED. This does not prove a feature is absent from a
 * codebase. It proves that no configured live-content file makes a forbidden ASSERTION, in the file
 * types configured, using the retirement vocabulary below. A reintroduction spelled in words no row
 * lists, or living in a directory nobody configured, or expressed in code rather than prose, is outside
 * what this can see — and `respawnpack removals` reports exactly which directories and extensions it
 * read so the boundary is inspectable rather than assumed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { OUTCOME, result, rollup } = require('./outcome.js');
const A = require('./assert.js');
// The shared digest module — see its header for why freshness logic lives under hooks/.
/*
 * ⛔ SOFT REQUIRE, BECAUSE DOCTOR MUST BE ABLE TO DESCRIBE ITS OWN BREAKAGE. `respawnpack.js` already
 * guarded its own require of this module — and that guard was UNREACHABLE, because this file is loaded
 * first and threw before it ran. A missing `hooks/_manifest.js` therefore killed `doctor` with a raw
 * MODULE_NOT_FOUND stack and zero rows, while three shipped surfaces said the case was handled. A
 * soft require in one file is not a soft require: every module on the path has to agree.
 *
 * `null` here is not "no digests" — callers must treat it as CANNOT_DETERMINE, never as "unchanged".
 *
 * ⛔ AND `catch { null }` NEVER SAW THE CASE THAT MATTERED — see kernel/lib/state.js's copy of this
 * note. A module that LOADS but no longer exports `compareDigestMap` never reaches a catch block; it
 * reaches the call site as a TypeError. `modhealth.probePath` returns a null module for that too, and
 * keeps the reason in `manifestHealth.detail` so the corpus verdict below can say WHICH kind of broken.
 */
const modhealth = require('./modhealth.js');
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_manifest.js');
const manifestHealth = modhealth.probePath(MANIFEST_PATH);
const manifest = manifestHealth.module;

const SCHEMA_VERSION = '1.0.0';
const REGISTRY_REL = path.join('docs', 'derived', 'state', 'removals.json');

/*
 * ⛔ THE SCANNING SEMANTICS CARRY A VERSION, SO A RECORDED VERDICT IS NEVER CARRIED FORWARD UNDER RULES
 * THAT NO LONGER PRODUCED IT. The incremental scan reuses a prior run's per-file findings for files whose
 * bytes have not changed. Those findings were computed by THIS code's notion of a live assertion — the
 * clause machinery, the retirement vocabulary, the history rules. If that notion changes, every recorded
 * finding is suspect even though the files did not move, so this constant is folded into the fingerprint
 * that decides whether a carry is allowed: bump it in the same commit that changes what a scan concludes,
 * and every target does a full scan at its next run rather than trusting a verdict a different checker drew.
 */
const SCAN_VERSION = 1;

// The two non-hex digest values hooks/_manifest.js records for a file it could not hash: ENOENT and a
// read failure. Named here because the incremental partition must never carry a file whose digest IS one
// of these — a digest that could not be taken is a read failure to surface, not proof of "unchanged".
const MANIFEST_ABSENT = 'ABSENT';
const MANIFEST_UNREADABLE = 'UNREADABLE';

/*
 * The retirement vocabulary, on top of assert.js's RETIRING_MARKERS. These are the phrases removal prose
 * actually uses, and they are listed HERE rather than added to the shared set so nothing else in the
 * pack changes meaning. A sentence containing one of these is history: it is talking ABOUT the removal.
 *
 * ⛔ This list is the contract a project's docs must write against. A retirement phrased in words that
 * appear nowhere below reads as a live assertion and will FAIL — which is the safe direction, and is why
 * `respawnpack removals` prints the vocabulary in its failure output rather than leaving an author to
 * guess why a sentence they consider historical was flagged.
 */
const REMOVAL_MARKERS = [
  '⛔', 'do not reintroduce', 'must not be reintroduced', 'not be re-added', 'never re-added',
  'was removed', 'were removed', 'has been removed', 'have been removed', 'removed in',
  'remains removed', 'stays removed', 'is gone', 'does not exist', 'is absent',
  'killed', 'cut in', 'dropped in', 'reverted in', 'rolled back', 'decommissioned', 'sunset',
];

/*
 * Headings whose sections are history BY CONSTRUCTION: the heading itself carries the retirement, so
 * the entries beneath it need not each repeat it (`## Removed in 0.3` over a bare bullet list).
 *
 * ⛔ `decisions` AND `decision log` WERE IN THIS SET, AND THAT WAS A HOLE IN THE CONTRACT'S FRONT DOOR.
 * Reproduced: one sentence, one file, one registry row. Under `## Features` the scan returns FAIL. Move
 * the identical sentence under `## Decisions` and it returns PASS. A decision log is not history — it is
 * a record of decisions, and most of them are CURRENT. It is also the single most likely place a
 * resurrection gets written down, because writing decisions down is what the file is for. Release
 * invariant 12 says this outright: suppress historical sections or retirement clauses, NOT the authority
 * file, and a cited accepted ADR stays scanned.
 *
 * The rest stay: a changelog, a migration note, an archive and a superseded/removed/retired/deprecated
 * heading each assert their own pastness in the heading, which is what earns the suppression. A live
 * decision recorded under one of those is still reachable by the clause-level machinery below, which is
 * what handles a retirement stated INSIDE a sentence rather than above a section.
 */
const HISTORY_HEADING = /^#{1,6}\s*(.*\b(removal|removals|removed|retired|retirement|deprecat\w*|changelog|change log|history|migration|superseded|archive|negative knowledge)\b.*)$/i;

const posix = (p) => String(p).replace(/\\/g, '/');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const portableAbsolute = (p) => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p);
const hasParentSegment = (p) => posix(p).split('/').includes('..');

/*
 * Resolve authority through the nearest existing ancestor. `realpath(abs)` alone cannot classify an
 * absent file below a symlinked parent: it returns ENOENT before revealing that creating the file
 * would write outside the project. The nearest ancestor exists precisely so its real target can prove
 * where the missing suffix would land.
 */
function containedResolution(projectDir, candidate) {
  const project = path.resolve(projectDir);
  const abs = path.resolve(candidate);
  if (!inside(project, abs)) return { ok: false, kind: 'lexical' };
  let realProject;
  try { realProject = fs.realpathSync(project); }
  catch (e) { return { ok: false, kind: 'unresolved', error: e }; }
  let probe = abs;
  for (;;) {
    try { fs.lstatSync(probe); break; }
    catch (e) {
      if (!e || e.code !== 'ENOENT') return { ok: false, kind: 'unresolved', error: e };
      const parent = path.dirname(probe);
      if (parent === probe) return { ok: false, kind: 'unresolved', error: e };
      probe = parent;
    }
  }
  let realProbe;
  try { realProbe = fs.realpathSync(probe); }
  catch (e) { return { ok: false, kind: 'unresolved', error: e }; }
  const realCandidate = path.resolve(realProbe, path.relative(probe, abs));
  if (!inside(realProject, realCandidate)) return { ok: false, kind: 'symlink' };
  return { ok: true, exists: probe === abs, realPath: realCandidate };
}

// --- configuration --------------------------------------------------------------------------------

const DEFAULT_EXTENSIONS = ['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'];
const DEFAULT_EXCLUDE = ['node_modules', '.git', '.respawnpack', 'docs/derived/_archive'];
/*
 * ⛔ B2 · THE DECISION SHARD AND THE CANONICAL ARCHIVE ARE HISTORY BY CONSTRUCTION, LIKE DECISIONS.md.
 * `docs/decisions/` holds one file per decision — a removal file names the killed feature and why it must
 * not return, which is a record of a killing, not a reintroduction. `docs/_archive/` holds the monolith
 * `migrate decisions` splits out (spine rule 5). Both are pack-owned paths, so they are built-in history
 * the same way `.git`/`node_modules` are built-in exclusions — merged with the founder's declared
 * historyPaths below, not seeded into their config (which would re-open the installer's legacy-block
 * detection). Without this, every removal shard file becomes a false live hit the day it is written.
 *
 * ⛔ THE ARCHIVE PATH IS `docs/_archive`, WIDER THAN DEFAULT_EXCLUDE's `docs/derived/_archive`, ON PURPOSE:
 * it is the exact directory `migrate decisions --write` writes the split monolith to (decisions.js
 * ARCHIVE_REL), a canonical doc's archive at the top of `docs/`, not the derived tree. A savepoint output
 * under `docs/derived/_archive/` is a separate thing the narrower exclude already covered; this names the
 * canonical archive the verb creates so the monolith it preserves verbatim never reads as a live hit.
 */
const DEFAULT_HISTORY_PATHS = ['docs/decisions', 'docs/_archive'];

/**
 * Directories that are vendored or machine-generated WHEREVER they appear — matched by NAME at any
 * depth, not by path prefix.
 *
 * ⛔ WHY A SECOND MECHANISM RATHER THAN MORE ENTRIES IN DEFAULT_EXCLUDE. `exclude` is a PATH-PREFIX
 * list, so the `node_modules` entry above excludes exactly ONE directory: the top-level one. A
 * monorepo keeps its dependencies one level down, under each package's own `node_modules`, which
 * that rule never touched — so a scan of `.` walked every vendored README, and any dependency
 * whose prose happens to assert a
 * forbidden phrase produced a FAIL naming a file the project does not own and cannot edit. That is
 * not a hypothetical: it is what made `liveContentDirs: ['.']` unsafe to recommend, which in turn is
 * why the installer shipped the too-narrow `['docs']` that scanned almost nothing.
 *
 * ⛔ AND WHY THIS LIST STAYS SHORT. Over-excluding BUILDS the blind spot this whole contract exists
 * to close, and a directory nobody scans is the run-A defect with better intentions. Only
 * names that cannot plausibly hold a project's own live prose belong here; anything arguable —
 * `vendor`, `build`, `dist`, `third_party` — stays the project's own `exclude` decision, made
 * explicitly and visibly in its config.
 */
const VENDOR_DIR_NAMES = new Set(['node_modules', '.git', '__pycache__']);
const MAX_FILE_BYTES = Number(process.env.RESPAWNPACK_REMOVAL_MAX_FILE_BYTES) || 2 * 1024 * 1024;

/**
 * Read the removal configuration. `configured` is false when a project has declared no live-content
 * directories — which is a state, not a pass (see `runRemovalScan`).
 */
function readConfig(dir) {
  const empty = (error = null) => ({
    registry: REGISTRY_REL, notApplicable: null, liveContentDirs: [], extensions: DEFAULT_EXTENSIONS,
    historyPaths: [], exclude: [...DEFAULT_EXCLUDE], configured: false, error,
  });
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, 'respawnpack.config.json'), 'utf8')); }
  catch (e) { return e && e.code === 'ENOENT' ? empty() : empty(`respawnpack.config.json is unreadable or not parseable JSON (${e.message})`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return empty('respawnpack.config.json must contain a JSON object');
  const state = doc.state === undefined ? {} : doc.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return empty('respawnpack.config.json state must be an object');
  const r = state.removals === undefined ? {} : state.removals;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return empty('state.removals must be an object');

  const errors = [];
  const stringArray = (key, fallback = []) => {
    if (!own(r, key)) return fallback;
    if (!Array.isArray(r[key]) || r[key].some((v) => typeof v !== 'string')) {
      errors.push(`state.removals.${key} must be an array of strings`); return fallback;
    }
    const values = r[key].map((v) => v.trim());
    if (values.some((v) => !v)) errors.push(`state.removals.${key} entries must be non-empty strings`);
    if (key !== 'extensions' && values.some((v) => portableAbsolute(v) || hasParentSegment(v))) {
      errors.push(`state.removals.${key} entries must be project-relative with no parent traversal`);
    }
    return values.filter(Boolean);
  };
  const liveContentDirs = stringArray('liveContentDirs');
  const extensions = stringArray('extensions', DEFAULT_EXTENSIONS);
  const historyPaths = stringArray('historyPaths');
  const declaredExclude = stringArray('exclude');
  let registry = REGISTRY_REL;
  if (own(r, 'registry')) {
    if (typeof r.registry !== 'string' || !r.registry.trim() || portableAbsolute(r.registry.trim()) || hasParentSegment(r.registry.trim())) {
      errors.push('state.removals.registry must be a non-empty project-relative string with no parent traversal');
    } else registry = r.registry.trim();
  }

  /*
   * The current opt-out shape matches reconciliation and the quality gate: boolean + reason. A legacy
   * reason string remains supported because target config is founder-owned data, and the schema declares
   * both forms so the production loader and the normative declaration describe the same language.
   */
  let notApplicable = null;
  if (typeof r.notApplicable === 'string') {
    if (r.notApplicable.trim()) notApplicable = r.notApplicable.trim();
    else errors.push('state.removals.notApplicable cannot be a blank string');
  } else if (r.notApplicable === true) {
    if (typeof r.reason === 'string' && r.reason.trim()) notApplicable = r.reason.trim();
    else errors.push('state.removals.notApplicable is true but no non-empty reason is declared');
  } else if (r.notApplicable !== undefined && r.notApplicable !== false) {
    errors.push('state.removals.notApplicable must be boolean or a legacy reason string');
  }

  return {
    registry, notApplicable, liveContentDirs,
    extensions: extensions.length ? extensions : DEFAULT_EXTENSIONS,
    historyPaths: [...DEFAULT_HISTORY_PATHS, ...historyPaths], exclude: [...DEFAULT_EXCLUDE, ...declaredExclude],
    configured: liveContentDirs.length > 0,
    error: errors.length ? errors.join('; ') : null,
  };
}

/** Read the removal registry. Returns {rows, status, reason}. */
function readRegistry(dir, cfg) {
  const project = path.resolve(dir);
  const abs = path.resolve(project, cfg.registry);
  if (!inside(project, abs)) {
    return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} resolves outside the project — an external file cannot be the project's removal authority` };
  }
  const resolved = containedResolution(project, abs);
  if (!resolved.ok) {
    if (resolved.kind === 'symlink') {
      return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} resolves outside the project through a symlink — an external file cannot be the project's removal authority` };
    }
    if (resolved.kind === 'lexical') {
      return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} resolves outside the project — an external file cannot be the project's removal authority` };
    }
    return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} could not be resolved (${(resolved.error && (resolved.error.code || resolved.error.message)) || 'unknown error'})` };
  }
  if (!resolved.exists) return { rows: [], status: 'ABSENT', reason: `no ${posix(cfg.registry)}` };
  let raw;
  try { raw = fs.readFileSync(resolved.realPath, 'utf8'); }
  catch (e) { return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} could not be read (${e.code || e.message})` }; }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} is not parseable JSON (${e.message})` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} must contain a JSON object` };
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} declares schemaVersion ${JSON.stringify(doc.schemaVersion)}, expected ${SCHEMA_VERSION}` };
  }
  if (!Array.isArray(doc.removals)) {
    return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} has no "removals" array` };
  }
  const bad = doc.removals.findIndex((r) => !r || typeof r !== 'object' || Array.isArray(r));
  if (bad !== -1) {
    return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} removal row ${bad} is not an object` };
  }
  /*
   * ⛔ "THIS PROJECT HAS RETIRED NOTHING YET" HAD NO WAY TO BE SAID, SO IT WAS SPELLED THE SAME AS
   * "NOBODY SET THIS UP". A greenfield install seeds liveContentDirs and no rows, and the only honest
   * verdict for an empty registry was CANNOT_DETERMINE — permanently, because the state that would
   * clear it is a retirement the project has not made yet. The founder's two escapes were both wrong:
   * un-configure the scan they will need on the first retirement, or let a red check become furniture.
   *
   * `emptyBaseline` is the third answer, and it is a STRING THAT IS THE REASON so it cannot be declared
   * without justifying it. It says the retirement baseline is established and deliberately empty, which
   * is a claim someone made and can be reviewed — not an absence the scanner inferred. It applies ONLY
   * to a genuinely empty `removals` array: the moment a row lands, the rows are the contract and this
   * field is ignored, so a stale baseline note cannot suppress a real registry.
   */
  const emptyBaseline = typeof doc.emptyBaseline === 'string' && doc.emptyBaseline.trim() ? doc.emptyBaseline.trim() : null;
  if (doc.emptyBaseline !== undefined && !emptyBaseline) {
    return { rows: [], status: 'CANNOT_DETERMINE', reason: `${posix(cfg.registry)} declares emptyBaseline with no reason — a baseline nobody has to justify is a baseline nobody reviews` };
  }
  return { rows: doc.removals, status: 'PASS', reason: null, emptyBaseline };
}

// --- what counts as a live assertion ---------------------------------------------------------------

/**
 * Blank the lines that are history BY POSITION, preserving line numbers so a hit still reports where.
 * Two rules, both checkable: a markdown blockquote is a quotation, and a section under a history
 * heading is history until the next heading of the same or shallower depth.
 */
function blankHistoryLines(text) {
  const lines = String(text).split(/\r?\n/);
  const out = new Array(lines.length).fill('');
  let historyDepth = 0; // 0 = not in a history section
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; } // fenced code is not prose either
    if (inFence) continue;

    const heading = /^(#{1,6})\s/.exec(raw);
    if (heading) {
      const depth = heading[1].length;
      if (HISTORY_HEADING.test(raw.trim())) { historyDepth = depth; continue; }
      if (historyDepth && depth <= historyDepth) historyDepth = 0; // the history section ended
      continue; // a heading is a label, not an assertion
    }
    if (historyDepth) continue;                    // inside a history section
    if (/^\s*>/.test(raw)) continue;               // a blockquote is a quotation
    // A wholly struck-through line is retracted text — the same rule assert.liveClause() applies, which
    // this scan does not otherwise inherit because it works at sentence rather than line granularity.
    if (/^\s*~~[\s\S]*~~\s*$/.test(raw.trim())) continue;
    out[i] = raw;
  }
  return out.join('\n');
}

const RETIRING = [...A.RETIRING_MARKERS, ...REMOVAL_MARKERS].map((m) => m.toLowerCase());

/** Does this span of text talk ABOUT a retirement rather than assert the thing? */
const retiresSomething = (sentence) => RETIRING.some((m) => sentence.includes(m));

/*
 * ⛔ CLAUSE GRANULARITY, BECAUSE A WHOLE-SENTENCE TEST SUPPRESSES ASSERTIONS IT NEVER READ.
 *
 * `retiresSomething(sentence)` skipped the ENTIRE sentence if a retirement marker appeared anywhere in
 * it, so a marker attached to one subject silently exonerated every other phrase sharing the sentence:
 *
 *     "The plugin loader is enabled while the old UI was removed."   → zero hits
 *     "Previously optional, the plugin loader is now enabled."       → zero hits
 *
 * Both are live reintroductions. The first is retired prose about something ELSE; the second retires
 * only the word "optional". A reintroduction could be hidden from this scanner by writing it beside any
 * unrelated retirement — and the failure direction is silent PASS, which is the one that costs.
 *
 * A retirement scopes to its CLAUSE, so that is the unit. Splitting on punctuation and the coordinators
 * that join independent clauses gets the two cases above right without hand-parsing English.
 *
 * ⭐ THE RELATIVE-CLAUSE CARVE-OUT, which the naive version of this fix gets wrong:
 *     "The magic gauntlet, which was removed in D-075, is gone."
 * The marker sits in the FOLLOWING clause, attached backwards to the noun. Without this, correct
 * historical prose in the commonest shape English has for it would FAIL — and a check that fires on
 * correct writing is one operators learn to scroll past.
 */
const CLAUSE_SPLIT = /(,|;|:|—|–|\(|\)|\bwhile\b|\bwhereas\b|\balthough\b|\bthough\b|\bbut\b|\band\b|\byet\b)/g;
const RELATIVE_OPENER = /^[\s,]*(which|that|who|whose)\b/;

/** Offsets of clause starts within `sentence`, ending with sentence.length. */
function clauseBounds(sentence) {
  const b = [0];
  for (const m of sentence.matchAll(CLAUSE_SPLIT)) b.push(m.index + m[0].length);
  b.push(sentence.length);
  return b;
}

/**
 * Is the occurrence at `at` (length `len`) inside a clause that retires it — directly, or via a
 * trailing relative clause?
 *
 * ⛔ THE REGION IS THE CLAUSES THE OCCURRENCE **SPANS**, NOT THE ONE IT STARTS IN. A forbidden phrase
 * may itself contain a clause delimiter, and this pack ships one: `200,000-token window`. Attributing
 * it to the clause holding its first character split the phrase from its own retirement, so the
 * synthesized known-GOOD control ("… was removed in R-001 and must not be reintroduced") registered as
 * a live hit, the row stopped discriminating, and R-001 fell to `unverified`. The per-row probe caught
 * it on the first self-scan, which is the entire reason that probe exists.
 */
function clauseRetires(sentence, bounds, at, len) {
  const idxOf = (pos) => { let i = 0; while (i < bounds.length - 2 && pos >= bounds[i + 1]) i++; return i; };
  const iStart = idxOf(at);
  const iEnd = idxOf(at + Math.max(0, len - 1));
  if (retiresSomething(sentence.slice(bounds[iStart], bounds[iEnd + 1]))) return true;
  if (iEnd + 2 < bounds.length) {
    const nextStart = bounds[iEnd + 1];
    const next = sentence.slice(nextStart, bounds[iEnd + 2]);
    const parenthetical = sentence[nextStart - 1] === '(';
    if ((RELATIVE_OPENER.test(next) || parenthetical) && retiresSomething(next)) {
      /*
       * The attached clause retires the noun only if the sentence ends there or the continuation also
       * says it remains retired. Otherwise `X, which was removed, is enabled` is a live assertion —
       * the closest bypass to clause scoping, and the false-PASS direction. Authors can use the printed
       * retirement vocabulary (`remains removed`, `is gone`, …) to make the good case explicit.
       */
      const remainder = sentence.slice(bounds[iEnd + 2]);
      if (!remainder.trim()) return true;
      /*
       * Every continuation clause must remain historical. Looking for one retirement word anywhere in
       * the remainder let a contradictory live predicate hide beside it in either order:
       * `X, which was removed, is enabled but remains removed` and
       * `X, which was removed, remains removed but is enabled` both disappeared. A marker scopes only
       * to the clause that carries it; mixed continuations are deliberately loud so authors split
       * unrelated subjects into their own sentence instead of buying ambiguity with punctuation.
       */
      const rb = clauseBounds(remainder);
      const continuations = rb.slice(0, -1).map((start, i) => remainder.slice(start, rb[i + 1]).trim()).filter(Boolean);
      if (continuations.length && continuations.every(retiresSomething)) return true;
    }
  }
  return false;
}

/**
 * Occurrences of `phrase` in live assertions only, with line locations.
 *
 * ⛔ SENTENCE GRANULARITY, NOT LINE GRANULARITY. `liveClause()` cuts a whole LINE at its first retiring
 * marker, which is right for a status row and wrong here: "We removed the old UI. The magic gauntlet is
 * back." would have had everything after "removed" treated as history. Sentences are the unit at which
 * a retirement actually scopes. Joining first (via liveDocument) keeps DF-007 #5 fixed — a sentence that
 * WRAPPED across two lines is still one sentence — and the span map is what keeps "plus location" honest.
 */
function liveOccurrences(text, phrase) {
  const needle = A.foldCase(phrase);
  if (!needle) return [];
  const doc = A.liveDocument(blankHistoryLines(text), { scope: 'any' });
  const lower = doc.text.toLowerCase();
  const hits = [];

  // Sentence boundaries over the JOINED text, so offsets still map back through doc.spans.
  const bounds = [0];
  for (const m of lower.matchAll(/[.!?;]+\s+/g)) bounds.push(m.index + m[0].length);
  bounds.push(lower.length);

  for (let b = 0; b < bounds.length - 1; b++) {
    const start = bounds[b];
    const end = bounds[b + 1];
    const sentence = lower.slice(start, end);
    if (!sentence.includes(needle)) continue;
    const cb = clauseBounds(sentence);
    let from = 0;
    for (;;) {
      const at = sentence.indexOf(needle, from);
      if (at < 0) break;
      // Per OCCURRENCE, not per sentence: a marker elsewhere in the sentence retires something else.
      if (clauseRetires(sentence, cb, at, needle.length)) { from = at + needle.length; continue; }
      const abs = start + at;
      const span = doc.spans.find((s) => abs >= s.start && abs < s.end) || doc.spans[doc.spans.length - 1];
      hits.push({
        line: span ? span.line : 1,
        text: String(span ? span.raw : sentence).trim().slice(0, 200),
      });
      from = at + needle.length;
    }
  }
  return hits;
}

// --- the corpus -----------------------------------------------------------------------------------

const isExcluded = (rel, cfg) => {
  // Vendored/generated by NAME, at any depth — see VENDOR_DIR_NAMES for why this is not an `exclude` entry.
  if (posix(rel).split('/').some((seg) => VENDOR_DIR_NAMES.has(seg))) return true;
  return cfg.exclude.some((x) => {
    const p = posix(x).replace(/\/+$/, '');
    return rel === p || rel.startsWith(`${p}/`);
  });
};

const isHistoryPath = (rel, cfg) => cfg.historyPaths.some((x) => {
  const p = posix(x).replace(/\/+$/, '');
  return rel === p || rel.startsWith(`${p}/`);
});

/**
 * Every scannable file under the configured live-content directories.
 *
 * ⛔ AN UNREADABLE OR MISSING CONFIGURED DIRECTORY IS CANNOT_DETERMINE. The run-A defect was a scanner
 * that read one directory and reported success for the whole project; a scanner that silently skips a
 * directory someone configured is the same failure with better intentions.
 */
function collectCorpus(dir, cfg) {
  const files = [];
  const skipped = [];
  const unreadable = [];
  const exts = cfg.extensions.map((e) => String(e).toLowerCase());
  // Resolved once: the containment test below compares REAL paths on both sides (see the note there).
  let realProject;
  try { realProject = fs.realpathSync(path.resolve(dir)); } catch { realProject = path.resolve(dir); }

  for (const declared of cfg.liveContentDirs) {
    const rootRel = posix(declared).replace(/\/+$/, '');
    const rootAbs = path.resolve(dir, rootRel);
    // A configured directory outside the project is a configuration error, not a silent skip.
    const rel = posix(path.relative(path.resolve(dir), rootAbs));
    if (rel.startsWith('../') || path.isAbsolute(rel)) {
      unreadable.push(`${rootRel} (resolves outside the project)`);
      continue;
    }
    let stat;
    try { stat = fs.statSync(rootAbs); }
    catch (e) { unreadable.push(`${rootRel} (${e.code || e.message})`); continue; }
    if (!stat.isDirectory()) { unreadable.push(`${rootRel} (not a directory)`); continue; }
    /*
     * ⛔ CONTAINMENT IS CHECKED ON THE **REAL** PATH, BECAUSE THE LEXICAL CHECK ABOVE IS NOT ONE.
     * `path.relative` compares strings, so a configured root that IS a symlink pointing outside the
     * project passes it — `linked` is lexically inside `dir` — and then `statSync` and the walk both
     * FOLLOW the link. External prose was read and reported with its file path and line content, from
     * a directory the project does not own.
     *
     * The walk already refuses to follow symlinked CHILDREN; the configured root was simply never
     * subjected to the same rule. Both sides are resolved because the project directory itself is
     * often a symlink (macOS `/tmp`, and any checkout reached through one), and comparing a real path
     * against a lexical one would then reject every root in a legitimate tree.
     */
    let realRoot;
    try { realRoot = fs.realpathSync(rootAbs); }
    catch (e) { unreadable.push(`${rootRel} (${e.code || e.message})`); continue; }
    const realRel = posix(path.relative(realProject, realRoot));
    if (realRel === '..' || realRel.startsWith('../') || path.isAbsolute(realRel)) {
      unreadable.push(`${rootRel} (resolves outside the project — a symlink to ${posix(realRoot)}; the scanner does not follow links out of the tree)`);
      continue;
    }

    const walk = (absDir, relDir) => {
      let entries;
      try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
      catch (e) { unreadable.push(`${relDir || rootRel} (${e.code || e.message})`); return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (isExcluded(childRel, cfg)) continue;
        const childAbs = path.join(absDir, entry.name);
        if (entry.isSymbolicLink()) {
          const note = `${childRel} (symlink — not followed; its content cannot be established)`;
          skipped.push(note); unreadable.push(note); continue;
        }
        if (entry.isDirectory()) { walk(childAbs, childRel); continue; }
        if (!entry.isFile()) continue;
        if (!exts.includes(path.extname(entry.name).toLowerCase())) continue;
        if (isHistoryPath(childRel, cfg)) { skipped.push(`${childRel} (declared a history path)`); continue; }
        let size = 0;
        try { size = fs.statSync(childAbs).size; } catch (e) { unreadable.push(`${childRel} (${e.code || e.message})`); continue; }
        if (size > MAX_FILE_BYTES) {
          const note = `${childRel} (${size} bytes, over the ${MAX_FILE_BYTES}-byte scan limit)`;
          skipped.push(note); unreadable.push(note); continue;
        }
        files.push(childRel);
      }
    };
    walk(rootAbs, rootRel === '.' ? '' : rootRel);
  }

  return { files: [...new Set(files)].sort(), skipped, unreadable };
}

/**
 * Content digests of the scanned corpus, so a later reader can tell whether the verdict it is looking at
 * still describes the files that produced it. Kept SEPARATE from the compiler's sourceManifest on
 * purpose: editing a doc invalidates the removal verdict, and must not invalidate the row counts too.
 *
 * ⛔ DELEGATED, NOT REIMPLEMENTED. The boot path recomputes this from `hooks/_manifest.js` — the one
 * module the pack tree and an installed target both resolve identically — so writer and reader cannot
 * drift into two definitions of "changed".
 */
const corpusManifest = (dir, files) => (manifest ? manifest.digestMap(dir, files) : null);

/** Is a recorded corpus manifest still true of the tree? CURRENT · STALE · CANNOT_DETERMINE. */
const compareCorpus = (recorded, dir) => (manifest
  ? manifest.compareDigestMap(recorded, dir)
  // The detail names WHICH kind of broken — missing, unparseable, throwing, or exporting the wrong
  // API. "is missing" was one of four answers printed for all four.
  : { status: 'CANNOT_DETERMINE', detail: `hooks/_manifest.js: ${manifestHealth.detail} — the corpus digests cannot be computed` });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Keys sorted at every depth so a reformat of the registry does not look like a content change; array
// order is content and is kept. The same canonical rule hooks/_manifest.js uses for the config digest.
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

/**
 * A fingerprint of everything that decides a per-row verdict EXCEPT the corpus content: the registry rows
 * (ids, phrases, controls, risk) and the scanning semantics version. A carried finding is only trusted
 * when this is unchanged, so an added or edited row — anything that changes what any phrase would detect —
 * forces a full scan rather than reusing a verdict drawn against different rows.
 */
const rowsFingerprint = (rows) => sha256(canonicalJSON({ scan: SCAN_VERSION, rows: rows || [] }));

/*
 * ⛔ THE CORPUS RECORD, RELOCATED OUT OF STATE.json (B3). The per-file digests (`corpusManifest`) and
 * live-assertion occurrences (`corpusFindings`) the incremental scan reads as its prior used to sit
 * inside STATE.json's `removals` — ~93 bytes per prose file, most of a 138 KB projection at scale. They
 * move to docs/derived/state/corpus.json, beside STATE.json, and the compiled projection keeps only a
 * one-line `corpusDigest` over this record: a fresh compile reproduces the record from the tree, so a
 * hand edit to corpus.json makes that digest disagree with STATE.json's and FAILs state-writeback. The
 * reader below is a raw read and is classified in kernel/schema.test.mjs's RAW_READS — safe because any
 * read failure yields a null prior, which the scan treats as a full scan (never a false "unchanged").
 */
const CORPUS_REL = path.join('docs', 'derived', 'state', 'corpus.json');

function readCorpusRecord(dir) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, CORPUS_REL), 'utf8')); }
  catch { return null; } // absent / unreadable / malformed → a null prior, i.e. a full scan
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  return { corpusManifest: doc.corpusManifest || null, corpusFindings: doc.corpusFindings || null, rowsFingerprint: doc.rowsFingerprint || null };
}

/** The three prior fields pulled from a scan result — the shape the next run reads back. */
const corpusRecordOf = (scan) => ({
  corpusManifest: (scan && scan.manifest) || null,
  corpusFindings: (scan && scan.corpusFindings) || null,
  rowsFingerprint: (scan && scan.rowsFingerprint) || null,
});

// --- the scan -------------------------------------------------------------------------------------

/**
 * ⛔ THE PER-ROW DISCRIMINATION PROBE, AND EXACTLY WHAT IT PROVES.
 *
 * A forbidden phrase is only worth checking if the scanner answers DIFFERENTLY for an ASSERTION of it
 * and a RETIREMENT of it. `magic gauntlet` passes. `was removed` does not: it is itself part of the
 * retirement vocabulary, so every sentence containing it is treated as history and the phrase can never
 * match anything — a check that returns zero for the known-bad control too, which is precisely the
 * DF-007 #7 shape whose zero read as confirmation. A row that fails this probe is UNVERIFIED, never
 * clear.
 *
 * ⛔ AND WHAT IT DOES NOT PROVE, so nobody reads more into it. It establishes that a phrase is
 * DETECTABLE and NOT SELF-RETIRING. It cannot establish that a phrase is well CHOSEN: a phrase so
 * generic that it appears in innocent prose will produce a real, loud FAIL naming file and line, and
 * fixing that is an authoring decision this contract deliberately does not try to make for a project.
 *
 * The controls are synthesised from the row rather than hand-authored, because they test the CHECKER,
 * not the project: they assert nothing about whether the feature is really gone. A project may still
 * override them when its own prose is the thing in question.
 */
function probeRow(row, phrase) {
  const controls = (row.controls && typeof row.controls === 'object') ? row.controls : {};
  const bad = controls.bad || `The ${phrase} is available and enabled by default.`;
  const good = controls.good || `The ${phrase} was removed in ${row.id || 'this decision'} and must not be reintroduced.`;
  return A.discriminates((text) => liveOccurrences(text, phrase).length > 0, good, bad);
}

/*
 * ⛔ THE ONE PLACE A REGISTRY BECOMES A PLAN, so the scan and any per-file re-parse agree on which phrases
 * are active (discriminating) and in what order. `rowPlans` drives the per-row verdict; `activePhrases` is
 * the deduped, order-preserving list the per-file parse walks, so a finding list reconstructed from a
 * subset of files is byte-identical to the one a full scan would have recorded for them.
 */
function planRows(reg) {
  const rowPlans = [];
  const activePhrases = [];
  const activeSet = new Set();
  for (const raw of reg.rows) {
    const id = String(raw.id || '').trim();
    const feature = String(raw.feature || '').trim();
    const phrases = (Array.isArray(raw.forbidden) ? raw.forbidden : []).map((p) => String(p).trim()).filter(Boolean);
    const risk = raw.risk === 'high' ? 'high' : 'normal';
    if (!id || !feature) {
      rowPlans.push({ terminal: { id: id || '(unnamed)', feature, status: 'unverified', why: 'the row states no id and/or feature name', hits: [], risk } });
      continue;
    }
    if (!phrases.length) {
      rowPlans.push({ terminal: { id, feature, status: 'unverified', why: 'the row lists no forbidden live assertions, so there is nothing to detect', hits: [], risk } });
      continue;
    }
    const nonDiscriminating = [];
    const discriminating = new Set();
    for (const phrase of phrases) {
      const probe = probeRow(raw, phrase);
      if (!probe.ok) { nonDiscriminating.push(`"${phrase}" — ${probe.detail}`); continue; }
      discriminating.add(phrase);
      if (!activeSet.has(phrase)) { activeSet.add(phrase); activePhrases.push(phrase); }
    }
    rowPlans.push({ id, feature, risk, phrases, discriminating, nonDiscriminating });
  }
  return { rowPlans, activePhrases };
}

/*
 * ⛔ G4 · RE-PARSE A HANDFUL OF FILES' FINDINGS, NOT A WHOLE SCAN. The writing savepoint re-persists
 * STATE.json against the documents the render and the wave-ledger fold wrote; a document the fold changed
 * AFTER the post-render scan needs its per-file findings recomputed so the recorded manifest and findings
 * describe the SAME bytes — otherwise A5's incremental carry trusts a stale "clear" for a file whose bytes
 * moved, and a killed-feature phrase the fold wrote would read clean until a `--full`. This parses the
 * named files (the generated docs only) with the SAME active phrases the scan uses, so a carried finding is
 * identical to a full re-parse. It is a PARSE, not a scan: it never touches `runRemovalScan`, so the
 * scan-count fence is unmoved. Returns `{ rel: [{phrase, line, text}] }` with an entry per named file (an
 * empty list where the file now has no live occurrence, so a caller can clear a stale finding).
 */
function corpusFindingsFor(dir, relPaths) {
  const out = {};
  const cfg = readConfig(dir);
  if (cfg.error || cfg.notApplicable || !cfg.configured) return out;
  const reg = readRegistry(dir, cfg);
  if (reg.status !== 'PASS' || !reg.rows.length) return out;
  const { activePhrases } = planRows(reg);
  for (const rel of relPaths || []) {
    const key = posix(rel);
    let text;
    try { text = fs.readFileSync(path.join(dir, ...key.split('/')), 'utf8'); } catch { continue; }
    const list = [];
    for (const phrase of activePhrases) {
      for (const h of liveOccurrences(text, phrase)) list.push({ phrase, line: h.line, text: h.text });
    }
    out[key] = list;
  }
  return out;
}

/**
 * Run the removal scan.
 * Returns {outcome, checks, rows, corpus, cfg, manifest, corpusFindings, rowsFingerprint} — `outcome`
 * is the four-outcome verdict.
 *
 * ⛔ THE SCAN IS INCREMENTAL AGAINST THE LAST VERDICT, AND THE DIGEST IS THE ONLY ARBITER OF "CHANGED".
 * `prior` is the previous run's recorded corpus record (docs/derived/state/corpus.json, read by the
 * compiler; or the compiler's own scan a writing savepoint hands back after the render) carrying
 * `{ corpusManifest, corpusFindings, rowsFingerprint }` plus `lastFullScanAt`. The parse of a corpus file
 * into live-assertion occurrences is the ~half of savepoint
 * the review measured; the digest of a file is not. So this digests every corpus file (hooks/_manifest.js,
 * the one definition of "changed" writer and boot both resolve), re-parses only files whose digest differs
 * from the recorded one and files the recorded manifest never held, and carries the recorded per-file
 * findings for every file whose bytes are unchanged. The per-row verdict is rebuilt from the union of
 * carried and freshly-parsed findings, so it is identical to a full scan of the same tree.
 *
 * Every carry is fenced in the safe direction: a changed file is always re-parsed (its digest moved); an
 * absent, unusable, or CANNOT_DETERMINE recorded manifest means a full scan, never "unchanged"; a changed
 * registry — anything `rowsFingerprint` covers — means a full scan; a file whose digest cannot be taken is
 * re-read so its read failure is reported with its real errno; a file that vanished drops out of the
 * verdict.
 *
 * ⛔ WHAT A CARRY TRUSTS, AND WHAT IT DOES NOT. The sha256 proves the bytes are the ones the prior judged;
 * it does NOT prove the prior judged them honestly. The carried occurrences come from the prior corpus
 * record in docs/derived/state/corpus.json, a tracked derived record, so a corpus.json whose
 * `corpusFindings` was hand-forged to record a file's current digest with empty findings carries a false
 * "clear" — a forged derived record, which lies outside what this scan can establish. The corpus record's
 * integrity (bound into STATE.json by the digest of corpus.json's bytes) is the trust root here.
 * `opts.full` forces a scan that carries nothing and re-derives every finding from the tree; `hooks/pre-push` (opted in) and
 * the `--full` flag use it as the attestation that the recorded verdict is honest. The result reports
 * `carriedFiles` and `lastFullScanAt` so an operator can see how much of a verdict was trusted from the
 * prior and when it was last fully re-derived.
 *
 * ⛔ `opts.record` IS OFF BY DEFAULT, AND THAT IS THE POINT (D6 review MEDIUM 1). The same scan runs on
 * READ paths (boot, `state`, `doctor`'s `removals:contract` row, `savepoint --verify`) and on the
 * ENFORCEMENT paths that act on a refusal (the `removals` verb, which `hooks/pre-push` reaches through
 * `removals --full`, and the `savepoint --write` re-scan). Recording on every scan would count
 * re-observations of ONE standing violation as many catches, and would give `doctor` a write on a read.
 * So only an enforcing caller passes `{ record: true }`; a read never does, and `doctor` never writes.
 */
function runRemovalScan(dir, prior = null, opts = {}) {
  const cfg = readConfig(dir);
  const checks = [];
  const reg = readRegistry(dir, cfg);

  /*
   * ⛔ EMPTY CONFIGURATION CANNOT SPELL PASS. Zero live-content directories, or zero removal rows, means
   * this check examined nothing — and "examined nothing" is the state the kernel's four-outcome contract
   * exists to keep distinguishable from "found nothing wrong". A project that genuinely has no removals
   * still gets NOT_APPLICABLE only by DECLARING it, never by leaving the registry empty.
   */
  /*
   * `domain: 'coverage'` on the branches below is not a severity change and never softens one. Every
   * outcome here is exactly what it was. The tag says WHICH QUESTION the row answers — "has anybody
   * decided whether this contract applies here" rather than "did the contract hold" — so savepoint can
   * report the two separately instead of flattening a fresh repository's unanswered questions into the
   * same undifferentiated CANNOT_DETERMINE as a genuinely broken scan. See kernel/lib/applicability.js.
   */
  if (cfg.error) {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'removals:config',
      `${cfg.error}. Malformed configuration is not the same state as absent configuration, and is never a pass.`, { checked: 0, domain: 'coverage' }));
    return { outcome: OUTCOME.CANNOT_DETERMINE, checks, rows: [], corpus: { files: [], skipped: [], unreadable: [] }, cfg };
  }
  if (cfg.notApplicable) {
    checks.push(result(OUTCOME.NOT_APPLICABLE, 'removals:config',
      `declared not applicable: ${cfg.notApplicable}`, { checked: 0, domain: 'coverage' }));
    return { outcome: OUTCOME.NOT_APPLICABLE, checks, rows: [], corpus: { files: [], skipped: [], unreadable: [] }, cfg };
  }
  /*
   * ⛔ "NOBODY CONFIGURED THIS" AND "SOMEBODY WROTE ROWS AND NOTHING READS THEM" ARE NOT THE SAME
   * FAILURE, AND COLLAPSING THEM COST A GUARANTEE. The the 2026-08-07 field run (§2) found this check
   * reporting CANNOT_DETERMINE against a config with no `state` key at all, and named the consequence
   * exactly: "A guarantee that silently no-ops is worse than no guarantee." Both branches below are
   * still non-passing, so neither can spell success — but they carry different verdicts because they
   * ask different things of the reader:
   *
   *   • registry EMPTY or ABSENT + no dirs → CANNOT_DETERMINE. Nothing has been set up and nothing has
   *     been claimed. There is no promise outstanding, so there is nothing to have broken.
   *
   *   • registry HAS ROWS + no dirs → FAIL. Someone recorded killed features and every one of them is
   *     unenforced: the rows assert a guarantee the scanner cannot deliver because it is pointed at
   *     nothing. That is not an undetermined check, it is a determined breach of a stated contract —
   *     and CANNOT_DETERMINE is the outcome operators learn to scroll past, which is how a check like
   *     this stays broken for a whole project's lifetime.
   *
   * Read BEFORE the registry's own status branches below, because a row count is exactly what
   * distinguishes the two, and `readRegistry` does not depend on liveContentDirs to produce one.
   */
  if (!cfg.configured) {
    const advice =
      'Declare the directories that hold live content in state.removals.liveContentDirs, or declare ' +
      'state.removals.notApplicable with a reason.';
    if (reg.status === 'PASS' && reg.rows.length) {
      checks.push(result(OUTCOME.FAIL, 'removals:config',
        `${reg.rows.length} removal row(s) are recorded in ${posix(cfg.registry)} and NONE of them is enforced: ` +
        'no state.removals.liveContentDirs in respawnpack.config.json, so the killed-feature scan read zero ' +
        `directories. Every row here is a guarantee this project is currently not keeping. ${advice}`, { checked: 0 }));
      return { outcome: OUTCOME.FAIL, checks, rows: [], corpus: { files: [], skipped: [], unreadable: [] }, cfg };
    }
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'removals:config',
      'no state.removals.liveContentDirs in respawnpack.config.json — NOTHING enforces the "killed features are never ' +
      `re-added" rule in this project, and nothing was scanned. ${advice} ` +
      'An unconfigured contract is not a passing one.', { checked: 0, domain: 'coverage' }));
    return { outcome: OUTCOME.CANNOT_DETERMINE, checks, rows: [], corpus: { files: [], skipped: [], unreadable: [] }, cfg };
  }
  if (reg.status === 'CANNOT_DETERMINE') {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'removals:registry', reg.reason, { checked: 0 }));
    return { outcome: OUTCOME.CANNOT_DETERMINE, checks, rows: [], corpus: { files: [], skipped: [], unreadable: [] }, cfg };
  }
  if (reg.status === 'ABSENT' || !reg.rows.length) {
    // A registry that EXISTS and declares its emptiness deliberately is a decision; an absent one, or a
    // present one that says nothing, is still a check with nothing to check.
    if (reg.status === 'PASS' && reg.emptyBaseline) {
      checks.push(result(OUTCOME.NOT_APPLICABLE, 'removals:registry',
        `${posix(cfg.registry)} declares an empty retirement baseline: ${reg.emptyBaseline}. `
        + 'The scan stays configured, so the first recorded removal is enforced the day it lands.', { checked: 0, domain: 'coverage' }));
      return { outcome: OUTCOME.NOT_APPLICABLE, checks, rows: [], corpus: { files: [], skipped: [], unreadable: [] }, cfg };
    }
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'removals:registry',
      `${reg.reason || 'the removal registry is empty'} — live-content directories are configured, so a scan was expected. `
      + 'An empty registry is not a clean bill of health: it is a check with nothing to check. Record the first removal, '
      + 'or declare `"emptyBaseline": "<why this project has retired nothing yet>"` in the registry.', { checked: 0, domain: 'coverage' }));
    return { outcome: OUTCOME.CANNOT_DETERMINE, checks, rows: [], corpus: { files: [], skipped: [], unreadable: [] }, cfg };
  }

  const corpus = collectCorpus(dir, cfg);
  if (corpus.skipped.length) {
    // ⛔ NEVER A SILENT CAP. Anything the scan declined to read is named, because coverage nobody
    // mentioned reads as coverage that happened.
    checks.push(result(OUTCOME.NOT_APPLICABLE, 'removals:skipped',
      `not scanned: ${corpus.skipped.join('; ')}`, { checked: 0 }));
  }

  /*
   * ⛔ THE INCREMENTAL PARTITION. Digest every corpus file through the shared manifest module — the one
   * definition of "changed" the writer here and the boot path both resolve — then split the corpus into
   * files that must be re-parsed and files whose bytes match the recorded verdict and can carry their
   * findings. A digest that could not be taken is NOT a carry: it is read below so the read failure
   * surfaces with its real errno, exactly as a full read reported it.
   */
  const currentMap = manifest ? corpusManifest(dir, corpus.files) : null;
  const fingerprint = rowsFingerprint(reg.rows);
  const recordedManifest = prior && prior.corpusManifest && prior.corpusManifest.algorithm === 'sha256'
    && prior.corpusManifest.inputs && typeof prior.corpusManifest.inputs === 'object' ? prior.corpusManifest : null;
  const recordedFindings = prior && prior.corpusFindings && typeof prior.corpusFindings === 'object'
    && !Array.isArray(prior.corpusFindings) ? prior.corpusFindings : null;
  // A carry needs the digests, the per-file findings AND an unchanged registry. Any one absent, or a
  // recorded manifest that is not usable, is a full scan — never a guess of "unchanged". `opts.full`
  // forces a full scan that carries nothing, the attestation that the recorded verdict is honest.
  const canCarry = !opts.full && !!(currentMap && recordedManifest && recordedFindings && prior.rowsFingerprint === fingerprint);

  const texts = new Map();   // the files re-parsed this run, each read once
  const carried = [];        // files proven byte-identical by digest, findings reused
  for (const rel of corpus.files) {
    const digest = currentMap ? currentMap.inputs[rel] : undefined;
    if (canCarry && own(recordedManifest.inputs, rel) && digest === recordedManifest.inputs[rel]
      && digest !== MANIFEST_ABSENT && digest !== MANIFEST_UNREADABLE) {
      carried.push(rel);
      continue;
    }
    // Changed, new, or un-digestable: read it. A read failure is reported with its errno, never carried.
    try { texts.set(rel, fs.readFileSync(path.join(dir, rel), 'utf8')); }
    catch (e) { corpus.unreadable.push(`${rel} (${e.code || e.message})`); }
  }

  /*
   * ⛔ THE STAMP IS GATED ON A COMPLETED FULL PASS, NOT ON ZERO CARRY. Zero carry is necessary but not
   * sufficient: a run can carry nothing and still not have scanned the whole set — an empty corpus, a
   * file over MAX_FILE_BYTES (skipped, so its note lands in `corpus.unreadable`), or an unreadable file
   * among readable ones all reach here with `carriedFiles` 0 while part of the set was never read.
   * Stamping "now" for those would attest a full re-derivation that did not happen, and doctor/savepoint
   * would then show a recent "last full scan" over a CANNOT_DETERMINE verdict. So the stamp moves only
   * when nothing was carried AND the corpus was non-empty AND nothing was skipped-as-unreadable; a
   * deliberately excluded history path sits in `skipped` only, not `unreadable`, so it does not block the
   * stamp. Otherwise the prior's stamp (or null) stands, and a never-fully-scanned verdict reads "never".
   * The field stays writeback-safe because an incremental run (carry > 0) never advances it.
   */
  const carriedFiles = carried.length;
  const fullyRescanned = carriedFiles === 0 && corpus.files.length > 0 && corpus.unreadable.length === 0;
  const lastFullScanAt = fullyRescanned
    ? new Date().toISOString()
    : ((prior && typeof prior.lastFullScanAt === 'string' && prior.lastFullScanAt) || null);

  /*
   * ⛔ THE UNREADABLE CHECK IS EMITTED **AFTER** THE READ LOOP, AND THAT ORDERING IS THE WHOLE FIX.
   * It used to run immediately after collectCorpus, so it saw only the failures collection found —
   * a directory that would not stat. A file that collected fine and then failed to READ (EACCES is
   * the common one) appended to `corpus.unreadable` further down, where no check would ever see it.
   *
   * The consequence was the exact silent green this module exists to prevent, and it was invisible
   * because the two halves disagreed: `outcome` counted `corpus.unreadable` and correctly said
   * CANNOT_DETERMINE, while `checks` — the ONLY thing `savepoint` consumes — contained nothing but
   * `PASS removals:clear`. A rolled-up savepoint therefore reported PASS over a corpus it had failed
   * to read. Anything that reads verdicts from checks rather than from outcome saw a clean bill of
   * health. One list is now built from both phases, and one check reports it.
   */
  if (corpus.unreadable.length) {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'removals:corpus',
      `configured live-content location(s) could not be read: ${corpus.unreadable.join('; ')}. ` +
      'A directory or file the scanner cannot see is a blind spot, and a blind spot that reports success is the ' +
      'exact run-A defect this contract exists to close.', { checked: corpus.files.length }));
  }

  /*
   * ⛔ A CONFIGURED SCAN THAT MATCHED ZERO FILES CANNOT SPELL PASS — the four-outcome contract's
   * single most important rule, and this module was breaking it in its own hot path.
   *
   * With no files, `texts` is empty, every row finds no occurrence, every row is therefore marked
   * `clear`, and the function returned **PASS with checked: 0**. Three ordinary misconfigurations
   * reached it: an `extensions` list matching nothing in the tree, an `exclude` covering the whole
   * corpus, and `liveContentDirs: ['']`. Each is a check that examined nothing reporting that it
   * found nothing wrong — which is precisely the sentence this file's header calls the defect.
   *
   * Registry rows EXIST here (the branches above returned already), so this is not "nothing to
   * check". It is rows that could not be checked, which is CANNOT_DETERMINE and never a pass.
   */
  if (!corpus.files.length) {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'removals:corpus',
      `${reg.rows.length} removal row(s) are recorded, and the configured scan matched ZERO files: ` +
      `${cfg.liveContentDirs.join(', ')} yielded nothing with extensions ${cfg.extensions.join(' ')}` +
      `${cfg.exclude.length ? ` after exclusions (${cfg.exclude.join(', ')})` : ''}. ` +
      'Check the directories, the extension list and the exclusions. An empty corpus is not a clean ' +
      'bill of health: no row here was checked against anything.', { checked: 0 }));
    return { outcome: OUTCOME.CANNOT_DETERMINE, checks, rows: [], corpus, cfg, manifest: currentMap, corpusFindings: {}, rowsFingerprint: fingerprint, carriedFiles, lastFullScanAt };
  }

  /*
   * ⛔ THE DISCRIMINATION PROBE IS PER-ROW AND RUNS EVERY TIME; ONLY THE CORPUS PARSE IS INCREMENTAL.
   * `probeRow` reads the row's own synthesized controls, not the corpus, so it is O(rows) and recomputed
   * in full on every run — what the carry below skips is the O(rows x files) parse of UNCHANGED documents,
   * never the proof that each phrase still tells an assertion from a retirement.
   */
  const { rowPlans, activePhrases } = planRows(reg);

  /*
   * ⛔ OCCURRENCES PER (file, phrase): carried from the recorded findings for a file proven unchanged by
   * digest, freshly parsed for a changed or new file. A fresh parse happens once per active phrase per
   * file rather than once per row, which cannot change the result — `liveOccurrences` is a pure function
   * of the text and the phrase — and the reconstruction below walks phrases and files in the SAME order a
   * full scan did, so every row object is byte-identical to the full-scan form.
   */
  const occOf = new Map(); // rel -> Map(phrase -> [{line, text}])
  for (const rel of carried) {
    const grouped = new Map();
    for (const h of (Array.isArray(recordedFindings[rel]) ? recordedFindings[rel] : [])) {
      if (!h || typeof h !== 'object') continue;
      if (!grouped.has(h.phrase)) grouped.set(h.phrase, []);
      grouped.get(h.phrase).push({ line: h.line, text: h.text });
    }
    occOf.set(rel, grouped);
  }
  for (const [rel, text] of texts) {
    const grouped = new Map();
    for (const phrase of activePhrases) {
      const occ = liveOccurrences(text, phrase);
      if (occ.length) grouped.set(phrase, occ.map((h) => ({ line: h.line, text: h.text })));
    }
    occOf.set(rel, grouped);
  }

  const rows = [];
  for (const plan of rowPlans) {
    if (plan.terminal) { rows.push(plan.terminal); continue; }
    const { id, feature, risk, phrases, discriminating, nonDiscriminating } = plan;
    const hits = [];
    for (const phrase of phrases) {
      if (!discriminating.has(phrase)) continue;
      for (const rel of corpus.files) {
        const occ = occOf.get(rel);
        const found = occ && occ.get(phrase);
        if (found) for (const h of found) hits.push({ file: rel, phrase, line: h.line, text: h.text });
      }
    }

    if (nonDiscriminating.length === phrases.length) {
      rows.push({ id, feature, status: 'unverified', why: `no forbidden phrase discriminates: ${nonDiscriminating.join('; ')}`, hits: [], risk });
      continue;
    }
    if (hits.length) {
      rows.push({ id, feature, status: 'violated', why: `${hits.length} live assertion(s) reintroduce this feature`, hits, risk, nonDiscriminating });
      continue;
    }
    /*
     * ⛔ ANY PARTIALLY UNPROVEN ROW STOPS AT `unverified`. Risk changes review ceremony, not whether a
     * phrase was actually checked; calling the normal-risk half clear still promotes a partial battery
     * to a completion claim.
     */
    if (nonDiscriminating.length) {
      rows.push({ id, feature, status: 'unverified', why: `row with unprovable phrase(s): ${nonDiscriminating.join('; ')}`, hits: [], risk, nonDiscriminating });
      continue;
    }
    rows.push({ id, feature, status: 'clear', why: `no live assertion in ${corpus.files.length} scanned file(s)`, hits: [], risk, nonDiscriminating });
  }

  /*
   * The per-file findings this run leaves for the next: the union of carried and freshly-parsed hits,
   * keyed by file, only the files that have at least one. The next run carries these for any file whose
   * digest still matches. The compiler persists them to docs/derived/state/corpus.json (B3).
   */
  const corpusFindings = {};
  for (const rel of corpus.files) {
    const occ = occOf.get(rel);
    if (!occ || !occ.size) continue;
    const list = [];
    for (const [phrase, found] of occ) for (const h of found) list.push({ phrase, line: h.line, text: h.text });
    if (list.length) corpusFindings[rel] = list;
  }
  // The compiler keys the next run's prior on these through corpusRecordOf; B3 persists them to
  // docs/derived/state/corpus.json rather than into STATE.json's verdict.

  const violated = rows.filter((r) => r.status === 'violated');
  const unverified = rows.filter((r) => r.status === 'unverified');

  for (const r of violated) {
    const where = r.hits.slice(0, 5).map((h) => `${h.file}:${h.line} ("${h.phrase}")`).join(', ');
    checks.push(result(OUTCOME.FAIL, `removals:${r.id}`,
      `"${r.feature}" is asserted live in ${r.hits.length} place(s): ${where}${r.hits.length > 5 ? ` (+${r.hits.length - 5} more)` : ''}. ` +
      'If one of these is meant to be history, say so in its own sentence using the retirement vocabulary ' +
      `(${REMOVAL_MARKERS.slice(0, 5).join(', ')}, …), put it under a history heading, quote it as a blockquote, ` +
      'or declare its file in state.removals.historyPaths.', { checked: corpus.files.length }));
  }

  /*
   * The removal contract's refusal is a catch worth recording (review 2026-09-23 §3): a reintroduced
   * killed feature is the one thing this scan exists to stop, and the pack kept no trace of catching it.
   * One line is appended per ENFORCING scan that refuses (`opts.record === true`) — never per violated row, so
   * two reintroductions in one scan still read as one refusal, never on a read-only scan, and never on a
   * clear or unverified result. A line therefore means "an enforcement run refused a reintroduction",
   * not "a boot or a doctor re-observed a standing one".
   *
   * ⛔ THE KERNEL-TREE TWIN OF hooks/_runtime.js `recordCatch`, kept in lockstep with it. The hooks
   * cannot require the kernel, and this module loads long before it could reach a hook reader, so the
   * append is spelled here directly — the same tree split that keeps `writeAtomic`/`atomicWriteJSON` in
   * both trees. Best-effort and fail-open: a counter that cannot be written must never change the FAIL
   * the scan already reached. One JSON line under 4 KB through `fs.appendFileSync` is atomic enough for a
   * record nothing in this module reads back; `doctor` and `aar` are its only readers.
   */
  if (opts.record && violated.length) {
    try {
      const rec = {
        at: new Date().toISOString(),
        guard: 'removals',
        event: 'refuse',
        reason: `${violated.length} killed feature(s) reintroduced: ${violated.map((r) => r.id).join(', ')}`.slice(0, 160),
      };
      if (process.env.CLAUDE_SESSION_ID) rec.sessionId = String(process.env.CLAUDE_SESSION_ID);
      const catchesFile = path.join(dir, '.respawnpack', 'runtime', 'catches.jsonl');
      fs.mkdirSync(path.dirname(catchesFile), { recursive: true });
      fs.appendFileSync(catchesFile, `${JSON.stringify(rec)}\n`);
    } catch { /* best-effort counter; the removal FAIL stands whether or not it lands */ }
  }

  for (const r of unverified) {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, `removals:${r.id}`, `"${r.feature || r.id}" could not be checked — ${r.why}`, { checked: 0 }));
  }
  const clear = rows.filter((r) => r.status === 'clear');
  if (clear.length) {
    checks.push(result(OUTCOME.PASS, 'removals:clear',
      `${clear.length} removal(s) with no live assertion across ${corpus.files.length} file(s) in ${cfg.liveContentDirs.join(', ')}`,
      { checked: corpus.files.length }));
  }

  /*
   * One outcome authority: savepoint consumes `checks`, so the standalone result must be their rollup,
   * never a separately reconstructed opinion that can disagree with its caller.
   */
  const outcome = rollup(checks);
  return { outcome, checks, rows, corpus, cfg, manifest: currentMap, corpusFindings, rowsFingerprint: fingerprint, carriedFiles, lastFullScanAt };
}

module.exports = {
  runRemovalScan, readConfig, readRegistry, collectCorpus, liveOccurrences, blankHistoryLines,
  corpusManifest, compareCorpus, probeRow, corpusFindingsFor,
  // B3 · the corpus record relocated to docs/derived/state/corpus.json. readCorpusRecord is the prior
  // reader; corpusRecordOf extracts the three fields from a scan result. STATE.json keeps a digest of
  // corpus.json's bytes (kernel/lib/state.js) so a hand edit to the file FAILs state-writeback.
  CORPUS_REL, readCorpusRecord, corpusRecordOf,
  SCHEMA_VERSION, REGISTRY_REL, REMOVAL_MARKERS, HISTORY_HEADING, DEFAULT_EXTENSIONS, VENDOR_DIR_NAMES,
  // The containment guard trio, exported so any other path-taking surface in the kernel can reuse the
  // SAME check rather than growing its own copy — reconcile.js still carries its own (pre-dates this
  // export); a caller outside this module is `ops/sweep-scratch.mjs` (BUG-1).
  portableAbsolute, hasParentSegment, containedResolution,
  // The file-component normaliser, exported so a parameterised check id can be spelled the same on every
  // platform (BUG-2 / K-02): `path.join` bakes the host separator into `render:<file>`,
  // `rendered-claims:<file>`, `generated-block:<file>` and `note:budget:<file>`, which made the id the
  // kernel emits on Windows differ from the POSIX spelling every fixture and doc commits to, and made
  // `savepoint`'s blockerDigest platform-dependent for an identical blocker set. Callers: respawnpack.js
  // (the `render:` rows) and render.js (the other three) — reused rather than re-implemented at either
  // call site.
  posix,
};
