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
const path = require('path');

/** The one supported artifact version. Kept in step with kernel/lib/state.js SCHEMA_VERSION by a fence. */
const SUPPORTED_VERSION = '1.0.0';

/*
 * ⛔ THE LOCKED SET — the codes that mean the open failed while the file is THERE. EPERM/EACCES/EBUSY
 * are the file held open at that instant (a concurrent reader, an antivirus scanner, an in-flight
 * replacement); EMFILE/ENFILE are an exhausted descriptor table, nothing to do with the file at all.
 * All five are momentary, so they are waited out, bounded, and fail closed to UNREADABLE — never to
 * ABSENT. ENOENT is NOT here on purpose: it is answered by observation, not by waiting. See below.
 */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE']);

/*
 * ⛔ ENOENT IS THE SUBTLE ONE, AND IT IS NO LONGER ANSWERED BY SLEEPING. "The file is not there" and
 * "the file is being replaced right now" are the same errno. The reader used to tell them apart by
 * waiting — a handful of 3 ms pauses, on the theory that a replacement window is sub-millisecond, so a
 * file still missing afterwards is gone. On Windows that wait was the whole cost: `Atomics.wait` cannot
 * resolve below the ~15.6 ms system timer tick, so each 3 ms pause rounded up to a tick and a genuinely
 * ABSENT artifact cost ~62 ms per read. That is paid on every hook's boot path, which reads several
 * absent artifacts (contract, cycle, latches, savepoint attempt), for nothing a cheaper check cannot buy.
 *
 * So ENOENT is separated by observation, not a sleep. `writeAtomic` replaces through `MoveFileEx`, so
 * the ENOENT a reader sees is a failed OPEN during the swap. The first cut of this reasoning claimed the
 * destination NAME stays resolvable throughout the swap, so a single `statSync` with no pause could
 * settle absence: if the name resolves it is a window, if the name is gone too the file is genuinely
 * absent. The ABSOLUTE form of that claim was FALSE, the same way state.js's own "never absent" contract
 * was. On a loaded Windows CI runner, six writers racing one target drove the pack reader to report
 * ABSENT dozens of times for a file that existed the whole 2.5 s — the un-resolvable instant of the
 * MoveFileEx is NOT sub-stat-wide under that load, so statSync landed inside it too.
 *
 * So absence is now settled by TWO observations, still with no blind sleep on the quiet path:
 *   1. a few back-to-back statSync probes (ABSENT_STAT_PROBES), no pause — if any resolves it is a
 *      window and the read is retried at once (the ABSENT_RETRIES-bounded loop below);
 *   2. if every probe ENOENTs too, one `readdirSync` of the parent for a `${basename}.*.tmp` sibling —
 *      the temp `writeAtomic` publishes through (kernel/lib/state.js). Such a sibling is POSITIVE
 *      evidence a replacement is landing on THIS target right now, so the ENOENT is "not there YET", not
 *      "not there": the reader waits the window out (bounded by LOCKED_DEADLINE_MS) and fails closed to
 *      UNREADABLE, NEVER to ABSENT. With no sibling the file is genuinely gone and ABSENT is returned in
 *      one attempt with no pause and no readdir cost beyond that single scan, so the boot path that reads
 *      several absent artifacts (contract, cycle, latches, savepoint attempt) stays cheap.
 * The window retries are still bounded by ABSENT_RETRIES so a pathological reader that always ENOENTs on
 * open yet always stats cannot loop forever — it fails closed to UNREADABLE, not ABSENT.
 */
const ABSENT_RETRIES = 4;
// How many back-to-back statSync probes answer one ENOENT before the sibling-temp check decides. A
// single probe let a false ABSENT through under real contention (kernel/concurrency.test.mjs); a few
// back-to-back probes (no timer wait) clear the brief single-writer instant where neither the consumed
// temp nor the published name resolves, while the sibling-temp check below carries the multi-writer case.
const ABSENT_STAT_PROBES = 3;
const LOCKED_DEADLINE_MS = 1000;
const LOCKED_PAUSE_MS = 5;

// A real pause with no async boundary: making these readers asynchronous would make every caller
// asynchronous, including hooks that must answer on stdout synchronously. Used ONLY for the locked wait
// now — absence is settled by statSync, which is why an absent read no longer pays a timer tick.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Does the file's name resolve right now? A few (bounded) back-to-back statSync probes with no pause
// separate a replacement window — the name still resolves — from a genuine absence. A non-ENOENT stat
// error means the file is there but momentarily locked for stat too, so the caller retries the read and
// meets the locked path on its own terms rather than being mistaken for absent.
function nameResolves(file) {
  for (let i = 0; i < ABSENT_STAT_PROBES; i += 1) {
    try { fs.statSync(file); return true; }
    catch (e) { if (!e || e.code !== 'ENOENT') return true; }
  }
  return false;
}

// Is a `writeAtomic` replacement landing on this exact target right now? It publishes through a sibling
// named `${file}.<pid>.<seq>.<hex>.tmp` (kernel/lib/state.js), so while any `${basename}.*.tmp` sibling
// exists a write is in flight and an ENOENT that even statSync cannot resolve is a window, not absence.
// ⛔ THIS DUPLICATES state.js's temp-name convention on purpose: hooks/ cannot require the kernel (see the
// file header), so the one shape is asserted to stay in step by a fence in kernel/concurrency.test.mjs.
// Fail-open: if the directory cannot be enumerated we do NOT claim a write is in flight, which preserves
// the one-attempt, no-wait absent answer on the quiet boot path rather than inventing a stall.
function writeInFlight(file) {
  const base = path.basename(file);
  let entries;
  try { entries = fs.readdirSync(path.dirname(file)); }
  catch { return false; }
  for (const name of entries) {
    if (name.length > base.length + 4 && name.startsWith(`${base}.`) && name.endsWith('.tmp')) return true;
  }
  return false;
}

/**
 * Read a file, separating absence from unavailability.
 *
 * @returns {{status:'OK'|'ABSENT'|'UNREADABLE', text:string|null, detail:string|null, attempts:number}}
 */
function readTextClassified(file) {
  const deadline = Date.now() + LOCKED_DEADLINE_MS;
  let attempts = 0, windows = 0;
  for (;;) {
    attempts += 1;
    try { return { status: 'OK', text: fs.readFileSync(file, 'utf8'), detail: null, attempts }; }
    catch (e) {
      const code = (e && e.code) || 'UNKNOWN';
      if (code === 'ENOENT') {
        // "Not there", or "being replaced right now"? Back-to-back stats, then a sibling-temp scan,
        // tell them apart — see the ENOENT note above.
        if (!nameResolves(file)) {
          if (!writeInFlight(file)) {
            // No temp sibling. But the temp may have been renamed ONTO the destination between the last
            // stat and the scan (it vanished because the replacement just finished), so look at the
            // destination once more before answering: if it resolves now, retry the read as a window.
            if (!nameResolves(file)) {
              // No replacement in flight and still no name: genuinely gone, one attempt, no pause.
              return { status: 'ABSENT', text: null, detail: `not present after ${attempts} attempt(s)`, attempts };
            }
            windows += 1;
            if (windows > ABSENT_RETRIES) {
              return {
                status: 'UNREADABLE', text: null, attempts,
                detail: `ENOENT on every open across ${attempts} attempt(s) while statSync kept seeing the file. `
                  + 'It EXISTS and must never be treated as absent.',
              };
            }
            continue; // the replacement completed between the checks: read the published file now
          }
          // A `writeAtomic` temp sibling is present: a replacement is landing on this target now, so the
          // ENOENT is a window even though statSync could not catch it. Wait it out like the locked path
          // and fail closed to UNREADABLE — a present-but-replacing file must NEVER be called absent.
          if (Date.now() > deadline) {
            return {
              status: 'UNREADABLE', text: null, attempts,
              detail: `ENOENT with a replacement in flight (a sibling temp present) for ${LOCKED_DEADLINE_MS}ms across ${attempts} attempt(s). `
                + 'A write is landing on this target; this is NOT absence.',
            };
          }
          pause(LOCKED_PAUSE_MS);
          continue; // not there YET — out-wait the replacement, never answer ABSENT while a write lands
        }
        windows += 1;
        if (windows > ABSENT_RETRIES) {
          // The name keeps resolving yet every open ENOENTs: the file demonstrably EXISTS, so this is
          // not absence. Fail closed as unreadable rather than inventing a missing artifact.
          return {
            status: 'UNREADABLE', text: null, attempts,
            detail: `ENOENT on every open across ${attempts} attempt(s) while statSync kept seeing the file. `
              + 'It EXISTS and must never be treated as absent.',
          };
        }
        continue; // a replacement window is sub-millisecond: retry at once, no timer wait
      }
      if (!TRANSIENT.has(code)) {
        return { status: 'UNREADABLE', text: null, detail: `${code} — not a transient condition`, attempts };
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
  readTextClassified, readJSONClassified, writeInFlight,
  validateRequirements, validateGoalDoc,
  loadContract, loadRequirements, loadGoalDoc,
};
