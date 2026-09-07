/*
 * RespawnPack · hooks/_exceptions.js — THE ONE READER OF THE PROJECT'S DECLARED EXCEPTIONS.
 *
 * NOT A HOOK (leading underscore — the counts fence excludes these).
 *
 * ⛔ WHY THIS FILE EXISTS. A guard fires on a subject the founder has already judged and accepted: the
 * AWS documentation example key quoted in a setup guide, a teardown script whose `rm -rf` targets a
 * scratch mount, a security write-up that quotes an injection payload, a build command with a `$(…)`
 * the reviewer has read. Before this module the founder's only moves were to switch the whole guard off
 * with an untracked `.respawnpack/<hook>.off` marker, to argue with the guard on every run, or to
 * rewrite the content. All three are worse than the hit: the first is reason-less and invisible in a
 * diff, the second trains a reader to ignore the guard, and the third edits the project to please a
 * tool. This module is the fourth move — one reviewed subject, named in the founder-owned tracked file,
 * with a reason, and still reported when it is lifted.
 *
 * ⭐ AN EXCEPTION NAMES A SUBJECT. IT NEVER NAMES A VERDICT, AND THAT IS THE LINE BETWEEN THIS GRAMMAR
 * AND `posture.overrides`. An override moves a rule's verdict for EVERY subject, which is why
 * `_posture.js` refuses one on any rule the anti-drift core fixes. An exception carves out ONE subject
 * and leaves the rule at `deny` for everything else, so it is accepted on rules the posture may never
 * reach — the security column included (anti-drift item 25 holds: the rule still fires on every other
 * subject, the declaration lives in the founder-owned file `index-guard`'s CONTROL_PLANE already
 * protects from a subagent, and the guard still prints what it saw).
 *
 * ⛔ AND IT LIVES IN hooks/ FOR THE REASON `_posture.js`, `_contracts.js` AND `_artifact.js` ALREADY
 * GIVE. The kernel can require from `hooks/` and does; the hooks CANNOT require from the kernel,
 * because the kernel sits at `kernel/lib/` in this repository and at `.claude/respawnpack/lib/` on an
 * installed target. A reader under `kernel/lib/` would be unreachable from the guards that need it most.
 *
 * ⭐ THE FOUR SOURCES ARE FOUR DIFFERENT FACTS, AND COLLAPSING ANY TWO IS THE BUG. They are
 * `_posture.js`'s four, for the same reasons, read through the same classified boundary:
 *
 *   DECLARED    the founder wrote a list and every entry is well formed.
 *   DEFAULTED   nobody wrote one. Resolves to NO exceptions, which is exactly what this pack has always
 *               done, and `doctor` still reports it differently from a list that is present and empty.
 *   UNREADABLE  the config is missing-but-locked, or is not parseable JSON. Resolves to NO exceptions
 *               AND SAYS SO. "Could not read the allowances" must never collapse into "everything is
 *               allowed" (anti-drift item 27's rule, applied to the other direction of the same file).
 *   INVALID     a list is declared and is wrong. Resolves to NO exceptions and names the entry and the
 *               reason. It is REFUSED WHOLE rather than partly honoured: a list where one entry is
 *               dropped in silence would leave a founder believing a hit was lifted that still fires,
 *               and — far worse — a list where the REFUSED entry is the malformed one would lift the
 *               entries around it on the strength of a document nobody could fully read.
 *
 * ⛔ AN EXPIRED ENTRY IS KEPT IN THE LIST AND MATCHES NOTHING. Dropping it at read time would make
 * `doctor` unable to say "you have three exceptions and one of them stopped working", which is the one
 * report that gets a stale allowance renewed or deleted. `allowed()` is the ONLY thing that decides
 * whether an entry applies, so iterating `resolved.exceptions` in a guard would be a second answer to
 * that question — do not.
 *
 * ⛔ WHAT THIS FILE DOES NOT DO, TODAY. No guard consults it in a decision path. This module is the
 * reader, the grammar and the table; the guards that read it land in E-1b (`secret-scan`), E-1c
 * (`injection-scan`), and E-1d (`shell-guard:catastrophe`, `push-guard:tier2`, `worktree-guard`,
 * `index-guard:unmodelled`), one at a time, each with its own discrimination test. Landing the reader
 * first is what makes those changes reviewable: the vocabulary is written down and fenced before any
 * guard changes what it denies.
 *
 * Depends on `./_artifact.js` for the classified read, so absent · transiently unavailable · unreadable
 * · malformed stay four distinct answers here exactly as they are there. Reading the config raw would
 * also have needed a `RAW_READS` classification in `kernel/schema.test.mjs`; reusing the boundary that
 * already exists is the cheaper and the more honest of the two.
 */
const path = require('path');
const crypto = require('crypto');
const artifact = require('./_artifact.js');

/** The founder-owned file the exceptions are declared in. One spelling, read from here. */
const CONFIG_FILE = 'respawnpack.config.json';

/** The top-level key. Declared in `schemas/project-config.schema.json` under the same name. */
const CONFIG_KEY = 'exceptions';

/*
 * ⛔ THE TABLE OF RULES THAT HAVE A SUBJECT, AND WHICH SUBJECT EACH ONE HAS.
 *
 * A rule with no subject notion cannot be excepted at all: there is nothing for the exception to name,
 * so an entry aimed at one would read as accepted and lift nothing — the "a fence about nothing" shape
 * this pack refuses everywhere else. So an entry naming a rule this table does not carry is INVALID,
 * with "no subject notion" as the reason, rather than being carried along.
 *
 * ⛔ AND THE KINDS ARE PER RULE, NOT GLOBAL. `secret-scan` sees the added line AND the file it was added
 * to, so it accepts both a `fingerprint` and a `path`. `injection-scan` sees only where a tool result
 * came from, so a `fingerprint` there would name something the guard never computes — an exception that
 * could never match, which is worse than a refused one because it looks declared. The three
 * command-shaped rules see a command line and nothing else; `readiness` sees a checklist item id.
 *
 * `hooks/hooks.test.mjs` fences every key here against `hooks/_posture.js`'s own tables: each must be a
 * rule the anti-drift core fixes (`FIXED_IDS`), a rule the posture may relax (`RESOLVER`), or one of the
 * three ids that carry no posture row at all. An id that is none of those is a rule that does not exist.
 */
const EXCEPTION_RULES = {
  'secret-scan': ['fingerprint', 'path'],
  'injection-scan': ['path'],
  'shell-guard:catastrophe': ['command'],
  'push-guard:tier2': ['command'],
  'worktree-guard': ['path'],
  'index-guard:unmodelled': ['command'],
  readiness: ['item'],
};

/** Every subject kind this grammar knows, in the order a diagnostic lists them. */
const SUBJECT_KINDS = ['path', 'fingerprint', 'command', 'item'];

/** The two kinds that are digests rather than text, so a founder pastes what a guard printed. */
const DIGEST_KINDS = ['fingerprint', 'command'];

/** Exactly the fields an entry may carry. Anything else is a rejected entry, never a founder note. */
const ENTRY_FIELDS = ['id', 'rule', 'match', 'reason', 'declaredBy', 'declaredAt', 'expires'];

/** `sha256:` plus 64 lowercase hex characters — the one spelling `fingerprint()` below produces. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** A calendar day or a full ISO instant. Anything else is a date nobody can be sure they meant. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const shapeOf = (v) => (Array.isArray(v) ? 'an array' : v === null ? 'null' : `a ${typeof v}`);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nonEmptyString = (v) => typeof v === 'string' && Boolean(v.trim());

/**
 * The one spelling of a subject digest, so the string a guard PRINTS on a deny is byte-identical to the
 * string a founder pastes into the config.
 *
 * ⛔ THE NORMALISATION IS PART OF THE IDENTITY, NOT A CONVENIENCE. A secret re-indented, re-wrapped, or
 * moved between a tab and four spaces is the same secret, and a digest that changed with the whitespace
 * would silently expire the founder's own declaration on the next reformat — an allowance that stops
 * working for a reason nobody can see. Leading and trailing whitespace is dropped and every internal run
 * collapses to ONE space; nothing else is touched, because normalising case or punctuation would start
 * merging subjects that are genuinely different.
 *
 * @param {string} text the matched line, or the command as the guard saw it
 * @returns {string} `sha256:<64 lowercase hex>`
 */
function fingerprint(text) {
  const normalised = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
  return `sha256:${crypto.createHash('sha256').update(normalised, 'utf8').digest('hex')}`;
}

/** POSIX separators, no leading `./` or `/`. Report strings and globs are compared in one spelling. */
const posix = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/*
 * ⛔ THE GLOB IS COMPILED, NOT SUBSTRING-MATCHED, BECAUSE `docs` MUST NOT MATCH `docs-internal/keys.md`.
 *
 * `*` and `?` stay inside one path segment; only `**` crosses them. A `**` followed by a separator is
 * the ZERO-or-more-segments form, so a glob of `docs`, `**`, `*.md` joined by slashes matches
 * `docs/a.md` as well as `docs/x/y.md` — a form that required at least one intermediate directory would
 * silently not cover the top level the founder was looking at. Everything else is escaped, so a `.` in
 * a filename is a literal dot and not "any character".
 */
function globToRegExp(glob) {
  const g = posix(glob);
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i += 1;
      if (g[i + 1] === '/') { i += 1; re += '(?:[^/]+/)*'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does one declared `match` value match the subject's value for the same kind?
 *
 * ⛔ A SUBJECT THAT DOES NOT CARRY THE KEY NEVER MATCHES. Not "matches trivially", which is what an
 * absent value would do under any is-it-equal-or-missing test: an exception declaring
 * `{fingerprint, path}` handed a subject with no `path` would lift every file, which is precisely the
 * whole-guard escape this grammar exists to replace.
 */
function matchesKind(kind, declared, subjectValue) {
  if (subjectValue === undefined || subjectValue === null || subjectValue === '') return false;
  if (kind === 'path') return globToRegExp(declared).test(posix(subjectValue));
  if (DIGEST_KINDS.includes(kind)) return String(subjectValue).trim().toLowerCase() === String(declared).toLowerCase();
  return String(subjectValue) === String(declared); // item — an id, compared exactly
}

/**
 * Has this entry expired?
 *
 * ⛔ FAIL-CLOSED ON THE BOUNDARY: an entry stops lifting AT the instant it names, and a date-only
 * `expires` is midnight UTC of that day. An allowance that outlived its declaration by a day is an
 * allowance nobody re-reviewed, and the direction that costs less is the one where the founder is asked
 * again a few hours early.
 */
function isExpired(entry, now = Date.now()) {
  if (!isPlainObject(entry) || entry.expires === undefined || entry.expires === null) return false;
  const at = Date.parse(entry.expires);
  return Number.isFinite(at) ? at <= now : true; // an unparseable date is treated as expired, never as forever
}

/** One resolution, in the one shape every caller reads. */
const frame = (exceptions, source, detail) => ({ exceptions, source, detail });

/**
 * A malformed declaration. Lifts NOTHING and carries the reason, because a run that quietly dropped one
 * entry would look identical to a run whose founder never wrote it.
 */
const invalid = (why) => frame([], 'INVALID',
  `${CONFIG_FILE} declares an INVALID \`${CONFIG_KEY}\` list (${why}) — the whole list is refused rather than partly honoured, `
  + 'so NO exception lifts anything until it is fixed');

/**
 * Accept or refuse one declared entry.
 * @returns {string|null} the reason it was refused, or null when it is well formed
 */
function refuse(entry, i) {
  const at = `\`${CONFIG_KEY}[${i}]\``;
  if (!isPlainObject(entry)) return `${at} is ${shapeOf(entry)}, expected an object {id, rule, match, reason}`;

  const extra = Object.keys(entry).filter((k) => !ENTRY_FIELDS.includes(k));
  if (extra.length) return `${at} carries ${extra.join(', ')}; an exception is exactly {${ENTRY_FIELDS.join(', ')}}`;

  if (!nonEmptyString(entry.id)) {
    return `${at} has no string \`id\`. The id is what a lifted hit is REPORTED under, so an entry nobody can name `
      + 'would lift a guard silently';
  }
  const named = `\`${CONFIG_KEY}[${i}]\` (${entry.id})`;

  if (!nonEmptyString(entry.rule)) return `${named} has no string \`rule\``;
  if (!has(EXCEPTION_RULES, entry.rule)) {
    return `${named} names the rule \`${entry.rule}\`, which has no subject notion — the rules that can be excepted are `
      + `${Object.keys(EXCEPTION_RULES).sort().join(', ')}. An exception on anything else would name no subject and lift nothing`;
  }
  const kinds = EXCEPTION_RULES[entry.rule];

  if (!isPlainObject(entry.match)) return `${named}.match is ${shapeOf(entry.match)}, expected an object naming the subject`;
  const keys = Object.keys(entry.match);
  if (!keys.length) {
    return `${named}.match names no subject. An exception with nothing to match would apply to every subject the rule sees, `
      + 'which is the whole-guard escape this grammar exists to replace';
  }
  for (const k of keys) {
    if (!SUBJECT_KINDS.includes(k)) return `${named}.match carries \`${k}\`, which is not a subject kind (${SUBJECT_KINDS.join(', ')})`;
    if (!kinds.includes(k)) {
      return `${named}.match carries \`${k}\`, and \`${entry.rule}\` has no such subject — it matches on ${kinds.join(', ')}. `
        + 'A key the guard never computes would be a condition that can never hold, which reads as declared and lifts nothing';
    }
    if (!nonEmptyString(entry.match[k])) return `${named}.match.${k} is ${shapeOf(entry.match[k])}, expected a non-empty string`;
    if (DIGEST_KINDS.includes(k) && !DIGEST_RE.test(entry.match[k])) {
      return `${named}.match.${k} is ${JSON.stringify(entry.match[k])}, and a ${k} is \`sha256:\` plus 64 lowercase hex characters — `
        + 'exactly the string the guard prints on the deny you are excepting';
    }
  }

  if (!nonEmptyString(entry.reason)) {
    return `${named} has no \`reason\`. An allowance nobody has to justify is an allowance nobody reviews, which is the rule `
      + 'this pack already enforces on every other opt-out it accepts';
  }
  if (entry.declaredBy !== undefined && !nonEmptyString(entry.declaredBy)) {
    return `${named}.declaredBy is ${shapeOf(entry.declaredBy)}, expected a non-empty string`;
  }
  for (const f of ['declaredAt', 'expires']) {
    if (entry[f] === undefined) continue;
    if (typeof entry[f] !== 'string' || !DATE_RE.test(entry[f]) || !Number.isFinite(Date.parse(entry[f]))) {
      return `${named}.${f} is ${JSON.stringify(entry[f])}, expected YYYY-MM-DD or a full ISO instant. A date nobody can parse `
        + 'would decide when an allowance stops working, and this reader will not guess at one';
    }
  }
  return null;
}

/**
 * Read the project's declared exceptions.
 *
 * @param {string} projectDir the project root
 * @returns {{exceptions:Array<Object>, source:'DECLARED'|'DEFAULTED'|'UNREADABLE'|'INVALID', detail:string}}
 */
function resolve(projectDir) {
  const file = path.join(String(projectDir == null ? '.' : projectDir), CONFIG_FILE);
  const read = artifact.readJSONClassified(file);

  if (read.status === 'ABSENT') {
    return frame([], 'DEFAULTED',
      `no ${CONFIG_FILE}, so no exception is declared — every guard fires on every subject, which is exactly what this pack has always done`);
  }
  if (read.status !== 'OK') {
    const what = read.status === 'MALFORMED' ? 'is not parseable JSON' : 'could not be read';
    return frame([], 'UNREADABLE',
      `${CONFIG_FILE} ${what} (${read.detail || read.status}) — the exception list is UNREADABLE and lifts nothing. `
      + 'Allowances that could not be read are never granted.');
  }

  const cfg = read.doc;
  if (!isPlainObject(cfg)) return invalid(`the file is ${shapeOf(cfg)}, expected a JSON object`);
  if (!has(cfg, CONFIG_KEY) || cfg[CONFIG_KEY] === undefined) {
    return frame([], 'DEFAULTED',
      `${CONFIG_FILE} declares no \`${CONFIG_KEY}\` key — every guard fires on every subject. Nobody has declared an exception here.`);
  }

  const declared = cfg[CONFIG_KEY];
  if (!Array.isArray(declared)) return invalid(`\`${CONFIG_KEY}\` is ${shapeOf(declared)}, expected an array of entries`);

  for (const [i, entry] of declared.entries()) {
    const why = refuse(entry, i);
    if (why) return invalid(why);
  }

  const now = Date.now();
  const expired = declared.filter((e) => isExpired(e, now));
  const ids = declared.map((e) => `${e.id} (${e.rule})`);
  return frame(declared.slice(), 'DECLARED',
    `${declared.length} declared (${expired.length} expired) in ${CONFIG_FILE}`
    + (declared.length ? `: ${ids.join(', ')}` : '')
    + (expired.length ? `. Expired and lifting nothing: ${expired.map((e) => `${e.id} (expired ${e.expires})`).join(', ')}` : ''));
}

/**
 * The first declared exception that lifts this subject for this rule, or null.
 *
 * Takes an already-resolved list rather than a project directory ON PURPOSE, exactly as
 * `_posture.verdict()` does: a guard resolves once per decision and then asks about each hit it found.
 * Re-reading the config per hit would let one decision answer from two reads of a file that can change
 * between them.
 *
 * ⛔ EVERY DECLARED KEY MUST MATCH — AND. `{fingerprint, path}` is "this line, in this file", not "this
 * line OR this file". An OR would let a founder who meant to except one documented key in one guide
 * except that key everywhere in the repository, which is a wider allowance than the one they reviewed.
 *
 * ⛔ AND AN EXPIRED ENTRY MATCHES NOTHING, WITHOUT AN ERROR. The expiry is the founder's own statement
 * that this allowance needed re-reading by then; honouring it afterwards would make `expires` a comment.
 *
 * @param {{exceptions:Array<Object>}} resolved a `resolve()` result
 * @param {string} rule the rule id the guard is deciding
 * @param {Object} subject the subject's keys, in this grammar's own vocabulary
 * @returns {Object|null} the entry that lifts it, or null
 */
function allowed(resolved, rule, subject) {
  const list = isPlainObject(resolved) && Array.isArray(resolved.exceptions) ? resolved.exceptions : [];
  if (!list.length || !nonEmptyString(rule) || !isPlainObject(subject)) return null;
  const now = Date.now();
  for (const entry of list) {
    if (!isPlainObject(entry) || entry.rule !== rule || !isPlainObject(entry.match)) continue;
    if (isExpired(entry, now)) continue;
    const keys = Object.keys(entry.match);
    if (!keys.length) continue;
    if (keys.every((k) => matchesKind(k, entry.match[k], subject[k]))) return entry;
  }
  return null;
}

module.exports = {
  CONFIG_FILE, CONFIG_KEY, EXCEPTION_RULES, SUBJECT_KINDS, DIGEST_KINDS, ENTRY_FIELDS,
  resolve, allowed, fingerprint, isExpired,
};
