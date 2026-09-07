/*
 * RespawnPack · hooks/_artifact.js — the ONE production boundary for reading and accepting a
 * machine-readable state artifact.
 *
 * ⛔ WHY IT LIVES UNDER hooks/ AND NOT IN THE KERNEL. The kernel can require from `hooks/`; `hooks/`
 * cannot require from the kernel, because the kernel sits at `kernel/lib/` in this repository and at
 * `.claude/respawnpack/lib/` on an installed target while the hooks sit at `.claude/hooks/`. That is
 * the same constraint that put `_manifest.js` here, and it is why this is a single shared module
 * rather than two that would drift.
 *
 * ⛔ THE TWO FAILURES THIS EXISTS TO END, both reproduced on a real installed target.
 *
 * 1. UNSUPPORTED AND STRUCTURALLY INVALID DOCUMENTS WERE CONSUMED. `requirements.json` declaring
 *    `schemaVersion: "999.0.0"` was read, contributed its requirement, and reported PASS at exit 0.
 *    `goal.json` at the same unsupported version was read AND ACTIVATED — its goal text, constraints,
 *    authority and FORBIDDEN ACTIONS all reached compiled state. And a goal whose `constraints` was
 *    the string `"not an array"` compiled into twelve single-character constraints, because a string
 *    spreads. Every one of those is a safety-bearing field derived from a document nothing had agreed
 *    to accept.
 *
 * 2. A TRANSIENT REPLACEMENT ERROR WAS READ AS AN ANSWER. On Windows a reader can observe the target
 *    of an in-flight atomic replacement as momentarily ABSENT or locked. Measured here: with six
 *    writers and four readers over three seconds, four of ~770 reads returned ENOENT while ~2000
 *    replacements landed. `readDurableState` mapped that null to `status: 'ABSENT'`, and
 *    `readContract` mapped it to a goal with no constraints and no forbidden actions — a present
 *    artifact reported as missing, and safety context silently dropped, from a race.
 *
 * ⭐ THE INVARIANT. Absent · transiently unavailable · unreadable · malformed · unsupported version ·
 * structurally invalid are SIX DISTINCT ANSWERS. Collapsing any two of them is how a fault becomes a
 * configuration state, or a race becomes a fact.
 */
const fs = require('fs');

/** The one supported artifact version. Kept in step with kernel/lib/state.js SCHEMA_VERSION by a fence. */
const SUPPORTED_VERSION = '1.0.0';

/*
 * ⛔ ENOENT IS IN THIS SET ON PURPOSE, AND IT IS THE SUBTLE ONE. "The file is not there" and "the file
 * is being replaced right now" are the same errno. Retrying is what separates them: a replacement
 * window is sub-millisecond, so a file that is still missing after a few retries is genuinely absent,
 * while one that appears is a file that was never gone.
 */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'EMFILE', 'ENFILE']);

/*
 * The retry budgets are DELIBERATELY ASYMMETRIC.
 *
 * ENOENT is the common, legitimate answer — most projects have no contract.json, no goal.json, no
 * removals registry — and it is on the boot path. So it gets a handful of very short retries: enough
 * to outlast a replacement window by orders of magnitude, cheap enough that an absent file costs a few
 * milliseconds at startup and nothing else.
 *
 * EPERM/EACCES/EBUSY mean the file DEFINITELY EXISTS and is momentarily locked (a concurrent reader
 * holding it, an antivirus scanner, an in-flight replacement). Giving up quickly there would report a
 * present artifact as unreadable, so those wait considerably longer before failing closed.
 */
const ABSENT_RETRIES = 4;
const ABSENT_PAUSE_MS = 3;
const LOCKED_DEADLINE_MS = 1000;
const LOCKED_PAUSE_MS = 5;

// A real pause with no async boundary: making these readers asynchronous would make every caller
// asynchronous, including hooks that must answer on stdout synchronously.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Read a file, separating absence from unavailability.
 *
 * @returns {{status:'OK'|'ABSENT'|'UNREADABLE', text:string|null, detail:string|null, attempts:number}}
 */
function readTextClassified(file) {
  const deadline = Date.now() + LOCKED_DEADLINE_MS;
  let attempts = 0, enoent = 0, lastCode = null;
  for (;;) {
    attempts += 1;
    try { return { status: 'OK', text: fs.readFileSync(file, 'utf8'), detail: null, attempts }; }
    catch (e) {
      const code = (e && e.code) || 'UNKNOWN';
      lastCode = code;
      if (!TRANSIENT.has(code)) {
        return { status: 'UNREADABLE', text: null, detail: `${code} — not a transient condition`, attempts };
      }
      if (code === 'ENOENT') {
        enoent += 1;
        if (enoent > ABSENT_RETRIES) {
          return { status: 'ABSENT', text: null, detail: `not present after ${attempts} attempt(s)`, attempts };
        }
        pause(ABSENT_PAUSE_MS);
        continue;
      }
      if (Date.now() > deadline) {
        return {
          status: 'UNREADABLE', text: null, attempts,
          detail: `${code} — the file EXISTS but stayed unreadable for ${LOCKED_DEADLINE_MS}ms across ${attempts} attempt(s). `
            + 'This is NOT the same as absent, and must never be treated as one.',
        };
      }
      pause(LOCKED_PAUSE_MS);
    }
  }
}

/**
 * Read and parse a JSON artifact.
 *
 * @returns {{status:'OK'|'ABSENT'|'UNREADABLE'|'MALFORMED', doc:any, detail:string|null, attempts:number}}
 */
function readJSONClassified(file) {
  const r = readTextClassified(file);
  if (r.status !== 'OK') return { ...r, doc: null };
  try { return { status: 'OK', doc: JSON.parse(r.text), detail: null, attempts: r.attempts }; }
  catch (e) { return { status: 'MALFORMED', doc: null, detail: `not parseable JSON (${e.message})`, attempts: r.attempts }; }
}

// --- acceptance ------------------------------------------------------------------------------------

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const reject = (reason) => ({ ok: false, reason });
const ACCEPT = { ok: true, reason: null };

/*
 * ⛔ AN ABSENT schemaVersion IS ACCEPTED; A DIFFERENT ONE IS NOT.
 *
 * That asymmetry is the whole of "preserve legitimate legacy compatibility deliberately, without
 * letting legacy support become acceptance of arbitrary malformed modern documents". These files
 * predate the version field and real projects carry documents without it, so REQUIRING it would break
 * working installations to close a hole they do not have. A document that DECLARES a version this
 * kernel does not implement is a different thing entirely: its author is telling us, in the document,
 * that it means something we do not know how to read.
 */
function checkVersion(doc, artifact) {
  if (doc.schemaVersion === undefined || doc.schemaVersion === null) return ACCEPT;
  if (doc.schemaVersion === SUPPORTED_VERSION) return ACCEPT;
  return reject(`${artifact} declares schemaVersion ${JSON.stringify(doc.schemaVersion)}, and this kernel implements ${SUPPORTED_VERSION}. `
    + 'It is REFUSED rather than read on a best-effort basis: a document that says it means something else may mean anything.');
}

const arrayOfStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Every field of a goal whose type carries safety meaning, and what it must be. */
const GOAL_LIST_FIELDS = ['constraints', 'authority', 'forbidden', 'externalBlockers'];

/**
 * Accept or refuse a requirements document.
 * @returns {{ok:boolean, reason:string|null}}
 */
function validateRequirements(doc, artifact = 'requirements.json') {
  if (!isPlainObject(doc)) return reject(`${artifact} is ${Array.isArray(doc) ? 'an array' : typeof doc}, expected a JSON object`);
  const v = checkVersion(doc, artifact);
  if (!v.ok) return v;

  if (doc.requirements === undefined) return reject(`${artifact} has no \`requirements\` array — a denominator document that declares no rows cannot be a denominator`);
  if (!Array.isArray(doc.requirements)) return reject(`${artifact}: \`requirements\` is ${isPlainObject(doc.requirements) ? 'an object' : typeof doc.requirements}, expected an array`);
  for (const [i, r] of doc.requirements.entries()) {
    if (!isPlainObject(r)) return reject(`${artifact}: requirement ${i} is ${Array.isArray(r) ? 'an array' : typeof r}, expected an object`);
    if (typeof r.id !== 'string' || !r.id.trim()) return reject(`${artifact}: requirement ${i} has no string \`id\` — a row nothing can be keyed by cannot be counted, gated, or evidenced`);
    for (const f of ['blockedBy', 'dependsOn']) {
      if (r[f] !== undefined && !arrayOfStrings(r[f])) return reject(`${artifact}: ${r.id}.${f} must be an array of strings`);
    }
    if (r.mandatory !== undefined && typeof r.mandatory !== 'boolean') return reject(`${artifact}: ${r.id}.mandatory must be a boolean — anything else silently changes the denominator`);
  }
  if (doc.gates !== undefined) {
    if (!isPlainObject(doc.gates)) return reject(`${artifact}: \`gates\` is ${Array.isArray(doc.gates) ? 'an array' : typeof doc.gates}, expected an object`);
    for (const [id, g] of Object.entries(doc.gates)) {
      if (!isPlainObject(g)) return reject(`${artifact}: gate ${id} is not an object`);
      if (g.requires !== undefined && !arrayOfStrings(g.requires)) return reject(`${artifact}: gate ${id}.requires must be an array of strings`);
    }
  }
  return ACCEPT;
}

/**
 * Accept or refuse a goal document — modern (`goals`) or legacy flat (`goal` as a string).
 * @returns {{ok:boolean, reason:string|null}}
 */
function validateGoalDoc(doc, artifact = 'goal.json') {
  if (!isPlainObject(doc)) return reject(`${artifact} is ${Array.isArray(doc) ? 'an array' : typeof doc}, expected a JSON object`);
  const v = checkVersion(doc, artifact);
  if (!v.ok) return v;

  if (doc.goals !== undefined) {
    if (!isPlainObject(doc.goals)) return reject(`${artifact}: \`goals\` is ${Array.isArray(doc.goals) ? 'an array' : typeof doc.goals}, expected an object keyed by goal id`);
    for (const [id, g] of Object.entries(doc.goals)) {
      if (!isPlainObject(g)) return reject(`${artifact}: goal ${id} is ${Array.isArray(g) ? 'an array' : typeof g}, expected an object`);
      if (g.goal !== undefined && typeof g.goal !== 'string') return reject(`${artifact}: ${id}.goal must be a string`);
      if (g.completion !== undefined && !Array.isArray(g.completion)) {
        return reject(`${artifact}: ${id}.completion is ${typeof g.completion}, expected an array. A string here would be read one CHARACTER at a time.`);
      }
      for (const f of GOAL_LIST_FIELDS) {
        if (g[f] !== undefined && !arrayOfStrings(g[f])) {
          return reject(`${artifact}: ${id}.${f} must be an array of strings, and is ${Array.isArray(g[f]) ? 'an array containing a non-string' : typeof g[f]}. `
            + `⛔ ${f} carries safety meaning: a string spreads into single characters, so "no pushes" would become eight constraints of one letter each and none of them would mean anything.`);
        }
      }
    }
  }

  // The LEGACY FLAT SHAPE, accepted deliberately and validated to the same standard.
  if (doc.goal !== undefined && typeof doc.goal !== 'string') return reject(`${artifact}: top-level \`goal\` must be a string (the legacy flat shape)`);
  if (doc.completion !== undefined && !Array.isArray(doc.completion)) return reject(`${artifact}: top-level \`completion\` must be an array`);
  for (const f of GOAL_LIST_FIELDS) {
    if (doc[f] !== undefined && !arrayOfStrings(doc[f])) {
      return reject(`${artifact}: top-level \`${f}\` must be an array of strings — it carries safety meaning and a string would spread into single characters`);
    }
  }
  for (const [f, pred, what] of [
    ['ownerConfirmations', Array.isArray, 'an array'],
    ['killedFeatures', Array.isArray, 'an array'],
    ['completedGoalIds', arrayOfStrings, 'an array of strings'],
    ['milestone', (x) => typeof x === 'string' || x === null, 'a string or null'],
    ['currentAtomicTask', (x) => typeof x === 'string' || x === null, 'a string or null'],
    ['milestoneComplete', (x) => typeof x === 'boolean', 'a boolean'],
    ['ongoingGoalId', (x) => typeof x === 'string' || x === null, 'a string or null'],
    ['activeGoalId', (x) => typeof x === 'string' || x === null, 'a string or null'],
  ]) {
    if (doc[f] !== undefined && !pred(doc[f])) return reject(`${artifact}: \`${f}\` must be ${what}`);
  }
  return ACCEPT;
}

/**
 * The whole boundary in one call: read, parse, and accept — or say precisely which of the six answers
 * this document produced, in words a reader can act on.
 *
 * @returns {{status:'OK'|'ABSENT'|'UNREADABLE'|'MALFORMED'|'UNSUPPORTED'|'INVALID', doc:any, detail:string|null}}
 */
function loadContract(file, validator, artifact) {
  const r = readJSONClassified(file);
  if (r.status !== 'OK') return { status: r.status, doc: null, detail: r.detail ? `${artifact}: ${r.detail}` : null };
  const v = validator(r.doc, artifact);
  if (v.ok) return { status: 'OK', doc: r.doc, detail: null };
  // A declared-but-unimplemented version is a different disposition from a broken shape: one is a
  // document from another era, the other is a document that is simply wrong.
  const unsupported = /declares schemaVersion/.test(v.reason);
  return { status: unsupported ? 'UNSUPPORTED' : 'INVALID', doc: null, detail: v.reason };
}

const loadRequirements = (file) => loadContract(file, validateRequirements, 'requirements.json');
const loadGoalDoc = (file) => loadContract(file, validateGoalDoc, 'goal.json');

/** The statuses on which NOTHING may be derived from the document. */
const REJECTED = new Set(['UNREADABLE', 'MALFORMED', 'UNSUPPORTED', 'INVALID']);

module.exports = {
  SUPPORTED_VERSION, TRANSIENT, REJECTED,
  readTextClassified, readJSONClassified,
  validateRequirements, validateGoalDoc,
  loadContract, loadRequirements, loadGoalDoc,
};
