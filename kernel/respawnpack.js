#!/usr/bin/env node
/*
 * RespawnPack · kernel/respawnpack.js — the executable the pack was missing.
 *
 * ⛔ WHY IT EXISTS. `/savepoint`'s drift-check was the pack's most valuable step and its least specified
 * (DOGFOOD.md DF-007): Step 3 listed WHAT to check and named no mechanism, so every session hand-rolled
 * one, and seven hand-rolled checks failed in a single session — two of them by returning zero and
 * reading as confirmation. Meanwhile DF-011 caught a savepoint reporting success while every count in
 * the handoff was a day stale. A prose checklist cannot fix either. An executable can.
 *
 * Verbs:
 *   state              compile docs/derived/STATE.json from the structured sources
 *   savepoint          regenerate state (verified by digest read-back), render the derived docs,
 *                      verify every rendered claim against its source, run configured validator
 *                      adapters, capture evidence-backed candidate memories, and exit non-zero on
 *                      FAIL. Verification is ALWAYS ON — --verify is accepted as an explicit no-op
 *                      for compatibility. (--write to actually rewrite STATE.json and the rendered
 *                      docs; default is check-only and leaves the tree untouched, creating
 *                      STATE.json only when there is none to verify against.)
 *   status             a short current-state summary for a human
 *   removals           scan configured live content for a LIVE assertion reintroducing a killed feature
 *   doctor             what is installed, configured, unsupported, stale, or SILENTLY INACTIVE
 *   memory candidates  list/promote/reject candidate memories captured by savepoint — a lead never
 *                      becomes a fact without an explicit, audited promotion (core/memory/candidates.js)
 *
 * ⭐ EXIT CODES ARE THREE-VALUED, DELIBERATELY. 0 pass · 1 FAIL · 2 CANNOT_DETERMINE. A caller that
 * cannot tell "the check failed" from "the check could not run" will eventually treat the second as
 * success — which is the entire class of defect this file exists to end. And `--json` prints a machine-
 * readable result, so a caller never has to parse prose (or, per DF-007 #1, read `$?` through a pipe
 * and capture the wrong process's status).
 *
 * ⛔ It NEVER pushes. It commits only when explicitly told to (--commit).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { OUTCOME, result, rollup, exitCodeFor } = require('./lib/outcome.js');
// Same module the SessionStart hook and the state compiler use — one digest implementation, three readers.
/*
 * ⛔ DOCTOR MUST NOT DIE BEFORE IT CAN DESCRIBE ITS OWN BREAKAGE. This was a hard require, so deleting
 * `_manifest.js` killed the process with a raw MODULE_NOT_FOUND stack before a single row printed —
 * the one component whose job is reporting what is broken was the one that could not report it. A
 * null here becomes a CANNOT_DETERMINE freshness row instead (see stateFreshness).
 *
 * ⛔ AND THE `catch { null }` THAT REPLACED IT STILL HAD A HOLE THE SIZE OF THE ORIGINAL BUG. It fires
 * only when the require THROWS, so a `_manifest.js` that loaded WITHOUT `compareManifest` passed
 * straight through it and died at line 310 with a raw TypeError and, again, zero rows. `modhealth`
 * classifies all five states and hands back a module only for OK — see kernel/lib/modhealth.js.
 */
const modhealth = require('./lib/modhealth.js');
const MANIFEST_PATH = path.resolve(__dirname, '..', 'hooks', '_manifest.js');
const manifestHealth = modhealth.probePath(MANIFEST_PATH);
const manifestLib = manifestHealth.module;

/*
 * ⛔ THE POSTURE READER, REACHED THE SAME WAY AND FOR THE SAME REASON. ADR-003 puts the one reader of
 * `respawnpack.config.json`'s `posture` key at `hooks/_posture.js`, NOT at `kernel/lib/posture.js`, and
 * records that as final: the kernel can require from `hooks/` and the hooks cannot require from the
 * kernel, whose path differs between this repository and an installed target. So doctor reaches it
 * across the ONE relative path both layouts share, probed rather than hard-required — a reader that
 * will not load must become a row, not a stack trace that kills the report before it prints.
 *
 * `postureLib` is the only handle in the kernel, and `resolvedPosture()` below is the only thing that
 * calls it — once per verb. Since P3-K-10 two readers share that one resolution: doctor's posture row,
 * which reports the declaration, and `applicability`'s posture layer, which reads ADR-003's cell for
 * each day-one coverage row. A target whose install predates ADR-003 has no `_posture.js` beside the
 * kernel at all, `postureHealth` says so, and every relaxation is unavailable rather than defaulted.
 */
const POSTURE_PATH = path.resolve(__dirname, '..', 'hooks', '_posture.js');
const postureHealth = modhealth.probePath(POSTURE_PATH);
const postureLib = postureHealth.module;

/*
 * ⛔ THE EXCEPTION READER, REACHED THE SAME WAY AND FOR THE SAME REASON (P1-E-1a). One tracked
 * exception grammar in `respawnpack.config.json`, read by one shared module, so a guard that lifts a
 * hit and `doctor` that reports the lift can never disagree about what was declared. It sits beside
 * `_posture.js` under `hooks/` on the identical argument: the kernel can require from `hooks/`, and the
 * hooks cannot require from the kernel, whose path differs between this repository and an installed
 * target.
 *
 * `exceptionsLib` is the only handle in the kernel, and only `doctor`'s `exceptions` row reads it
 * here; the guards consume the reader in hooks/ (E-1b to E-1d). A reader that will not load must become a
 * row and not a stack trace, so it is probed rather than hard-required, exactly like the posture.
 */
const EXCEPTIONS_PATH = path.resolve(__dirname, '..', 'hooks', '_exceptions.js');
const exceptionsHealth = modhealth.probePath(EXCEPTIONS_PATH);
const exceptionsLib = exceptionsHealth.module;

/*
 * Every shared hook module THIS file reaches across the tree boundary, derived from the constants the
 * probes above already use rather than written down a second time. `doctor` folds it into the shared
 * module inventory, because a module only the kernel reads has a dependent that a hook-only dependency
 * walk cannot see — and an inventory that cannot see a dependent cannot report it broken either.
 *
 * ⛔ AND IT STAYS HERE RATHER THAN MOVING INTO `modhealth.CROSS_TREE`, WHICH P3-K-07b RE-EXAMINED AND
 * DECIDED AGAINST. The two tables look alike and answer different questions.
 *
 *   `modhealth.CROSS_TREE` is the EDGE TABLE for `dependencyGraph()`, whose nodes are exactly the files
 *   in `kernel/lib/` and `hooks/` (`addAll(kernelLibDir, …)`, `addAll(hookDir, …)`). This file is in
 *   neither directory, so it is not a node: a `'respawnpack.js': […]` key there would be an edge whose
 *   FROM node the graph never contains. `dependencyGraph` would not read it, `transitiveDeps` would not
 *   walk it, and doctor's `requiredLibs` closure would still have to fold these paths in by hand — a
 *   declaration that changes no behaviour, which is precisely the "a fence about nothing" shape that
 *   table's own fence refuses in the other direction. It is also excluded on purpose one level up:
 *   `modhealth.BOOTSTRAP` names `respawnpack.js`, because a defect in it is a raw crash and not a row.
 *
 *   This list answers "which shared hook modules does THIS PROCESS itself reach", which is what puts
 *   `_posture.js` in the inventory at all: it is the first shared module NO hook reads, so a closure
 *   walked from the hooks on disk would have left it with no row.
 *
 * What the move WOULD have bought — a fence, so the list cannot rot — is bought directly instead:
 * `kernel/kernel.test.mjs` re-derives this array from the real `path.resolve(…, 'hooks', 'x.js')` sites
 * in this file and fails in BOTH directions, the same way it already does for `modhealth.CROSS_TREE`.
 */
const KERNEL_CROSS_TREE = [MANIFEST_PATH, POSTURE_PATH, EXCEPTIONS_PATH];

/*
 * ⛔ core/ IS SOFT-REQUIRED, THE SAME WAY hooks/precompact-ledger-nudge.js ALREADY DEPENDS ON IT.
 * W5 wires savepoint's automatic candidate-memory capture and the new `memory` verb onto
 * core/memory/candidates.js, and savepoint's STATE.json write gains a read-back verify built on
 * core/_io.js's canonicalDigest. Neither is part of the three-file bootstrap above (respawnpack.js,
 * outcome.js, modhealth.js) — every OTHER verb must still run with core/ absent or broken, so a
 * missing/unloadable core/ degrades only the few features that need it, to a named CANNOT_DETERMINE
 * check or verb refusal, rather than killing the process. `core` is `null` on any failure; every call
 * site below checks it first.
 */
let core = null;
try { core = require('../core/index.js'); } catch { core = null; }

/*
 * ⛔ THE MINIMAL BOOTSTRAP, STATED RATHER THAN ASSUMED — AND IT IS NOT EVERYTHING.
 *
 * The previous round wrapped each of doctor's row-producing blocks in a `section()` guard and recorded
 * that "one exploding component cannot silence the report". That was true INSIDE `cmdDoctor()` and
 * false before it: every subsystem the guard protects was hard-required at the top of this file, so a
 * corrupt installed `lib/memory.js` killed the process during module load — before argv was parsed,
 * before a row existed, before the guard could run. A guard placed after the failure guards nothing.
 *
 * So the requires below are LAZY and go through `modhealth`. Touching a subsystem inside a guarded
 * section now produces a named BROKEN row instead of a startup stack trace.
 *
 * ⛔ WHAT CANNOT DIAGNOSE ITSELF, EXACTLY. Three files load before any of this can help, and a defect
 * in one of them is still a raw crash:
 *
 *     kernel/respawnpack.js    the entry point — it cannot report its own parse failure
 *     kernel/lib/outcome.js    the outcome vocabulary and exit-code mapping every row is expressed in
 *     kernel/lib/modhealth.js  the classifier that decides what BROKEN means
 *
 * That is the whole bootstrap, and the claim is bounded to it. Nothing here says every internal file is
 * recoverable, because three of them are not. `hooks/_manifest.js` is deliberately NOT in this set: it
 * lives in the other installed directory and is probed, never required outright.
 */
/*
 * ⛔ THE FILENAMES AND THEIR CONTRACTS ARE NOT LISTED HERE. They live in `modhealth.SUBSYSTEMS` — one
 * registry, used by this lazy loader, by doctor's expected inventory, by the contract validation and by
 * the drift fence. A second list in this file is exactly the kind of thing that goes stale silently, so
 * the fence in kernel/kernel.test.mjs asserts that no kernel library filename appears here beyond the
 * two bootstrap requires above.
 */
const libFile = (name) => modhealth.SUBSYSTEMS[name].file;
const libHealthCache = new Map();
function libHealth(name) {
  if (!libHealthCache.has(name)) {
    libHealthCache.set(name, modhealth.probePath(path.join(__dirname, 'lib', libFile(name))));
  }
  return libHealthCache.get(name);
}
/*
 * A lazy handle. Every existing call site (`stateLib.read(...)`, `livingLib.CANARIES`) is unchanged;
 * the load happens on first property access, and a subsystem that cannot load throws a sentence rather
 * than a stack. Doctor's `section()` turns that sentence into a row; every other verb reports it and
 * exits non-zero, because a verb whose engine is missing has not established anything either.
 */
function lazyLib(name) {
  return new Proxy({}, {
    get(_t, prop) {
      const h = libHealth(name);
      if (!h.module) {
        const err = new Error(`kernel subsystem lib/${libFile(name)} could not be loaded — ${h.detail}`);
        err.respawnpackLib = libFile(name);
        throw err;
      }
      return h.module[prop];
    },
  });
}
const stateLib = lazyLib('state');
const render = lazyLib('render');
const gateLib = lazyLib('gate');
const removalsLib = lazyLib('removals');
const lineageLib = lazyLib('lineage');
const aarLib = lazyLib('aar');
const closeout = lazyLib('closeout');
const memoryLib = lazyLib('memory');
const livingLib = lazyLib('living');
const assertLib = lazyLib('assert');
const reconcileLib = lazyLib('reconcile');
const applicabilityLib = lazyLib('applicability');
const readinessLib = lazyLib('readiness');
const siteLib = lazyLib('site');

const argv = process.argv.slice(2);
const verb = argv[0];
const flag = (name) => argv.includes(name);
const valueOf = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
// Repeatable flags — same shape as `contract delegate --met` below, generalised for `--candidate`.
const allValuesOf = (name) => argv.reduce((acc, a, i) => (a === name && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const DIR = path.resolve(valueOf('--dir', process.env.CLAUDE_PROJECT_DIR || process.cwd()));
const JSON_OUT = flag('--json');

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function config() {
  const cfg = readJSON(path.join(DIR, 'respawnpack.config.json')) || {};
  return cfg.state || {};
}

/*
 * ⛔ ONE POSTURE CONSULT PER VERB, RESOLVED HERE AND PASSED DOWN — NEVER ONE PER ROW.
 *
 * This process runs exactly one verb, so a module-level memo IS "once per verb": `doctor` reads the
 * same resolution for its posture row and for its onboarding rows, and `savepoint` hands one object to
 * `applicability` for every row it classifies. Re-reading `respawnpack.config.json` per row would let a
 * single run answer from two reads of a file that can change between them, and would make "which
 * posture decided this row" unanswerable after the fact.
 *
 * ⛔ AND AN ABSENT READER BEHAVES EXACTLY AS TODAY. On a target installed before ADR-003 there is no
 * `hooks/_posture.js` beside the kernel, `postureHealth` says so, and this returns null — which every
 * consumer reads as "nothing relaxes". A damaged reader lands in the same place, and doctor's own
 * posture row is what says the installation is damaged rather than unopinionated.
 *
 * ⛔ AND A FIXED ID NEVER REACHES THE RESOLVER. `hooks/_posture.js` deliberately has NO KEY for the
 * anti-drift core's ids, so an override on one is INVALID rather than ignored; the wrapper below keeps
 * the kernel from asking in the first place. The only ids the kernel asks about are
 * `applicability.POSTURE_ROWS`' five, `kernel:R6`, `gate.js`'s `kernel:R9` and the three in
 * `KERNEL_POSTURE_ROWS` below — ten rows, none of them in that set — fenced from SOURCE in
 * kernel/kernel.test.mjs, so a future consult of a fixed id fails the fence rather than the audit.
 */
let postureResolution;
function resolvedPosture() {
  if (postureResolution !== undefined) return postureResolution;
  postureResolution = null;
  if (postureLib) {
    try { postureResolution = postureLib.resolve(DIR) || null; } catch { postureResolution = null; }
  }
  return postureResolution;
}

/**
 * The verb's one posture policy: `{profile, source, verdict(id)}`, or null when nothing may relax.
 *
 * Memoized as well as `resolvedPosture()` is, so a verb that consults the posture at four different
 * sites holds ONE object rather than four wrappers around one resolution. That is not a performance
 * argument — the resolution underneath is already cached — it is so that "which policy decided this
 * row" has a single answer with a single identity for the whole process.
 */
let posturePolicyMemo;
function posturePolicy() {
  if (posturePolicyMemo !== undefined) return posturePolicyMemo;
  const resolved = resolvedPosture();
  posturePolicyMemo = resolved ? {
    profile: resolved.profile,
    source: resolved.source,
    verdict: (id) => postureLib.verdict(resolved, id),
  } : null;
  return posturePolicyMemo;
}

/*
 * ⛔ ONE EXCEPTION CONSULT PER VERB, FOR THE REASON THE POSTURE HAS ONE. `hooks/_exceptions.js` is the
 * ONE reader of the project's declared exceptions, and its own header says `allowed()` is the only
 * thing that decides whether an entry applies. Two readers in one process is how `doctor`'s row and the
 * `readiness` verb come to disagree about a list that changed between them, so the resolution is taken
 * once and both read it. An absent or damaged reader answers null, which every consumer reads as "no
 * exception lifts anything" — the fail-closed direction, and the one `resolvedPosture()` already takes.
 */
let exceptionResolution;
function resolvedExceptions() {
  if (exceptionResolution !== undefined) return exceptionResolution;
  exceptionResolution = null;
  if (exceptionsLib) {
    try { exceptionResolution = exceptionsLib.resolve(DIR) || null; } catch { exceptionResolution = null; }
  }
  return exceptionResolution;
}

/**
 * The declared exception that lifts one subject, or null. The rule id and the subject vocabulary are
 * the grammar's own; nothing here iterates `resolved.exceptions`, because `allowed()` is the one thing
 * allowed to decide whether an entry applies (expiry included).
 */
function exceptionFor(rule, subject) {
  const resolved = resolvedExceptions();
  if (!resolved || !exceptionsLib) return null;
  try { return exceptionsLib.allowed(resolved, rule, subject) || null; } catch { return null; }
}

/**
 * The profile that deliberately did not install the subsystem `row` governs, or null.
 *
 * ⛔ A SUBSYSTEM A PROFILE NEVER PLACED IS NOT A BROKEN ONE (P3-K-14). ADR-003's `kernel:R4` cell reads
 * "n.a., not installed" under `light`, and `modhealth.PROFILE_GATED` names the files that cell decides.
 * Without this, `doctor` on a `light` target would report `kernel-lib:reconcile.js BROKEN — MISSING` and
 * exit 1 forever: a red row for a file the founder's own declaration asked the installer to leave out.
 *
 * ⛔ AND IT IS NOT ROUTED THROUGH `applicability.relaxes()`, WHICH IS THE SAME QUESTION ONLY IF YOU
 * SQUINT. That predicate answers "does this posture relax a row's OUTCOME" (`off`/`advise`); this one
 * answers "did this posture decline to install a FILE" (`n.a.`), which `applicability.js` deliberately
 * keeps out of `RELAXING` because it needs an authored reason and an inference-free absence. Reaching it
 * through the lazy handle would also make doctor's whole kernel-lib inventory depend on
 * `applicability.js` loading — so damaging that one subsystem would delete every kernel-lib row instead
 * of turning one of them red, which is the "an inventory that cannot report an absence" defect the
 * section below exists to end.
 *
 * DECLARED only, like every other relaxation: DEFAULTED, UNREADABLE and INVALID all resolve to `strict`,
 * whose cell is `deny`, so a target that never chose a posture reaches exactly today's answer.
 */
function omittedByProfile(row) {
  const p = posturePolicy();
  if (!row || !p || p.source !== 'DECLARED') return null;
  return p.verdict(row) === 'n.a.' ? p.profile : null;
}

/**
 * The same question about a subsystem THIS process would have to load: the profile that left it out, or
 * null. ABSENT only — a subsystem that is present and damaged is damaged in every posture, and a
 * declaration must never be allowed to excuse one.
 */
function omittedSubsystem(name) {
  const s = modhealth.SUBSYSTEMS[name];
  if (!s || !s.postureRow || libHealth(name).status !== modhealth.ABSENT) return null;
  return omittedByProfile(s.postureRow);
}

/*
 * ⛔ THE THREE ADR-003 ROWS THIS FILE OWNS, AND WHY THEY ARE NOT COVERAGE ROWS.
 *
 * P3-K-10 relaxed the six rows the applicability survey owns (`kernel:R1`–`R6`) and deliberately left
 * four alone, because none of them is a coverage row and pretending otherwise would have put one fact
 * under two authorities. `kernel:R9` belongs to kernel/lib/gate.js (see its POSTURE_ROW). These three
 * are built here, in `savepoint`:
 *
 *   R15  the `note:budget:<file>` row — the NOTE block is over budget (kernel/lib/render.js).
 *   R16  a hand-authored derived doc not yet migrated, on a verify-only run.
 *   R17  a `--candidate` klass outside the four this pack recognises.
 *
 * They relax by ADR-003's mechanism (a), exactly as `applicability.relaxedCheck()` applies it: the row
 * is still built, still printed, still carries its original reason FIRST in `detail`, and only its
 * outcome moves — to PASS with `checked: 1` and a `postureRelaxed`/`postureRule` pair naming the
 * profile and the ADR row that answered it. Nothing here changes what an outcome MEANS (anti-drift
 * item 3), and nothing here touches doctor's GREEN set or `outcome.js`'s exit map.
 *
 * ⛔ AND `checked: 1` IS A REAL SUBJECT IN ALL THREE. R15 measured the NOTE block, R16 read the file
 * and classified its shape, R17 parsed the argument it is rejecting. None of them is the zero-work PASS
 * `result()` refuses; where the subject count really would have been zero — the gate's no-build-system
 * branch — the relaxation is NOT_APPLICABLE instead, and gate.js says why.
 */
const KERNEL_POSTURE_ROWS = {
  noteBudget: 'kernel:R15',
  unmigratedDoc: 'kernel:R16',
  candidateKlass: 'kernel:R17',
};

/**
 * Does the verb's one posture relax `id`?
 *
 * `applicability.relaxes()` is the ONE definition of which resolutions (DECLARED only) and which
 * verdicts (`off`, `advise`) relax, so nothing here respells it. It is reached through the lazy handle,
 * and a broken `applicability.js` therefore answers FALSE rather than throwing: the same fail-closed
 * rule `resolvedPosture()` already applies to a damaged posture reader. A relaxation that cannot be
 * decided is unavailable, never assumed, and `doctor` is the verb whose job it is to say the subsystem
 * is broken. Without this, `gate` — which needs no applicability row of its own — would have started
 * refusing to run because a module it does not otherwise use would not load.
 */
function postureRelaxes(id) {
  try { return applicabilityLib.relaxes(posturePolicy(), id); } catch { return false; }
}

/**
 * One non-coverage kernel row, relaxed by the verb's ONE declared posture.
 *
 * ⛔ A ROW THAT ALREADY PASSED IS RETURNED UNTOUCHED. A posture answers for a refusal; rewriting a PASS
 * would attach a relaxation to a row that never needed one, which is the tag-nobody-earned failure the
 * P3-K-10 fixtures already assert against.
 *
 * @param {Object} row the row as its own producer built it
 * @param {string|null} id the ADR-003 rule id, or null when this row is not one of the relaxable ones
 * @param {{when?:boolean}} [opts] `when: false` narrows a cell whose ADR entry says more than one word
 */
function postureRelaxed(row, id, { when = true } = {}) {
  if (!row || !id || !when || row.outcome === OUTCOME.PASS) return row;
  if (!postureRelaxes(id)) return row;
  const policy = posturePolicy();
  const meta = { ...row };
  delete meta.outcome; delete meta.check; delete meta.detail; delete meta.checked;
  return result(OUTCOME.PASS, row.check,
    `${row.detail} Reported rather than refused: the declared \`${policy.profile}\` posture relaxes this row to an advisory (ADR-003 ${id}).`,
    { ...meta, checked: 1, postureRelaxed: policy.profile, postureRule: id });
}

/*
 * DF-005. The harness task list and the project's own gap/gate records drift independently, wrong in
 * both directions at once. The comparison lives in kernel/lib/reconcile.js; `savepoint` runs it whether
 * or not anybody types this verb — a check that has to be remembered is the check that was not run on
 * the day it mattered.
 *
 * ⛔ K-12: AN ALIAS FOR `savepoint --only compile,reconcile`, NOT A SECOND CALLER OF THE RUNNER. This
 * used to call `reconcileLib.runReconciliation(DIR)` itself — a second call site the savepoint
 * `reconcile` STAGE could silently drift away from. It now reads `reconciliation` off
 * `stateLib.compile(DIR)`, the exact field the stage reads, so the two mechanisms cannot disagree by
 * construction; kernel/kernel.test.mjs fences the source for this.
 *
 * ⛔ AND IT DELIBERATELY SKIPS `applicabilityLib.relaxCoverage`, WHICH THE STAGE APPLIES. That call is
 * what lets a DECLARED `standard`/`strict` posture advise or deny an unconfigured reconciliation
 * (ADR-003 kernel:R4) — measured on a `standard`-postured, unconfigured fixture: relaxed, this verb
 * would exit 0 where it exits 2 today. Folding that in would move this verb's exit code for every
 * already-postured project the day this alias shipped, over a declaration this verb's own contract
 * never mentioned — the forged green anti-drift item 3 refuses. So the alias reports the UNRELAXED
 * verdict, byte-identical to what it always has; the posture-aware row is what `savepoint --only
 * compile,reconcile` is for.
 */
function cmdReconcile() {
  console.error('  ⚠️  `reconcile` is deprecated: it now runs as `savepoint --only compile,reconcile` and stays only as an alias. Script against `savepoint --only compile,reconcile` directly.');
  const { reconciliation: r } = stateLib.compile(DIR);
  return {
    outcome: r.status === 'DRIFT' ? OUTCOME.FAIL : (OUTCOME[r.status] || OUTCOME.CANNOT_DETERMINE),
    reconciliation: r.status, why: r.why, counts: r.counts, rows: r.rows, checks: r.checks,
  };
}

/*
 * VALIDATOR ADAPTERS. Project-specific truth belongs to the project: one project's
 * `tools/validate.py` and another's `tools/verify_docs.py --verify` know things this pack never will. The
 * generic pack's job is to CALL them and INTERPRET the result honestly — not to reimplement them badly.
 *
 * Declared in respawnpack.config.json:
 *   "state": { "adapters": [
 *      { "name": "verify-docs", "command": "python", "args": ["tools/verify_docs.py", "--verify"],
 *        "critical": true,
 *        "controls": { "good": ["--self-test-good"], "bad": ["--self-test-bad"] } } ] }
 *
 * ⭐ `critical: true` demands CONTROLS. A critical validator that has not been shown to answer
 * differently for a known-good and a known-bad input is treated as CANNOT_DETERMINE and its verdict is
 * discarded — DF-007 #7 was exactly a check that returned the same answer for both and was believed.
 */
function runAdapter(a) {
  const label = `adapter:${a.name}`;
  const run = (args) => {
    try {
      const out = execFileSync(a.command, args, { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: a.timeoutMs || 300000 });
      return { code: 0, out };
    } catch (e) {
      if (e.code === 'ENOENT') return { code: null, out: '', missing: true };
      return { code: typeof e.status === 'number' ? e.status : 1, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };

  const main = run(a.args || []);
  if (main.missing) {
    return result(OUTCOME.CANNOT_DETERMINE, label, `command not found: ${a.command} — declared but not installed, so this check did not run`, { checked: 0 });
  }

  if (a.critical) {
    if (!a.controls || !a.controls.good || !a.controls.bad) {
      return result(OUTCOME.CANNOT_DETERMINE, label,
        'declared critical but ships no known-good/known-bad controls — an unproven critical check is decoration, not evidence', { checked: 0, exitCode: main.code });
    }
    const probe = assertLib.discriminates((args) => run(args).code, a.controls.good, a.controls.bad);
    if (!probe.ok) {
      return result(OUTCOME.CANNOT_DETERMINE, label, `controls do not discriminate — ${probe.detail}. Verdict discarded.`, { checked: 0, exitCode: main.code });
    }
  }

  const detail = String(main.out).trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 500);
  return main.code === 0
    ? result(OUTCOME.PASS, label, detail || 'exit 0', { checked: 1, exitCode: 0 })
    : result(OUTCOME.FAIL, label, detail || `exit ${main.code}`, { checked: 1, exitCode: main.code });
}

/*
 * ⭐ CANDIDATE MEMORIES (W5). Savepoint is the GUARANTEED capture point: every FAIL/CANNOT_DETERMINE
 * check it runs, every newly-stated goal constraint, and every operator-supplied root-cause/fix pair
 * becomes a candidate memory — evidence-backed, provenance-carrying, and NEVER auto-promoted. See
 * core/memory/candidates.js for the record/audit machinery and the wall it draws between a lead and
 * a fact; everything below is a thin, host-side wrapper over that module's public API plus the ONE
 * thing it deliberately does not do — writing a PROMOTED candidate into memory/graph/<type>/<slug>.md,
 * the file-backed canonical entity memory/knowledge-graph.md already documents.
 *
 * ⛔ SAVEPOINT NEVER INFERS A CONCLUSION FROM A DIFF (ADR-001). Findings are captured from the checks
 * savepoint itself already ran (evidence = the check's own id/detail + STATE.json); constraints are
 * captured from the goal contract savepoint already compiled; a root-cause/fix pair is captured ONLY
 * when the operator states one, via `--candidate "kind:text"` — reconstructing one from a diff is
 * exactly the failure this pack exists to prevent.
 *
 * ⛔ THE STORE IS NAMED HERE, NOT INHERITED. core/memory/candidates.js was scaffolded for a
 * per-conversation RUNTIME caller and appends a `memory` leaf to whatever directory it is handed; W5
 * repurposed it for a DURABLE, TRACKED, project-wide store (candidates are project knowledge-in-waiting,
 * not machine runtime) and, having no way to say so, passed DIR and accepted where the leaf landed —
 * records directly in `memory/`, mixed in with the memory ENGINE's own tracked markdown. W6a gave the
 * module an exact-directory form, so this names the store outright: `memory/candidates/<id>.json` with
 * the audit journal at `memory/candidates/audit.jsonl`, one directory whose whole contents are this one
 * family, listable and reviewable without a filename convention deciding what belongs to whom. See
 * schemas/registry.json's `candidate-memory` family and memory/README.md.
 */
const MEMORY_KLASSES = ['finding', 'decision', 'constraint', 'root-cause-fix'];
// The exact-directory form, so the leaf is this caller's decision and not a default it inherited.
const memoryStoreDir = () => ({ dir: path.join(DIR, 'memory', 'candidates') });
const graphDir = () => path.join(DIR, 'memory', 'graph');

/** Dedup key for a candidate's semantic content — the same claim+klass is the same lead, captured once. */
function candidateDigest(claim, klass) {
  return core.io.canonicalDigest({ claim: String(claim), klass: String(klass) });
}

/** Every digest already in the store, so a run's captures dedupe against history AND against each other. */
function existingCandidateDigests() {
  const listed = core.candidates.list(memoryStoreDir());
  const records = listed.status === 'OK' ? listed.records.slice() : [];
  return { records, digests: new Set(records.map((r) => candidateDigest(r.claim, r.klass))) };
}

/**
 * Capture one candidate if its content digest is new; return the EXISTING id, deduped, if it is not.
 * `seen` is mutated so later calls in the same run see earlier ones.
 */
function captureCandidateOnce(seen, claim, klass, provenanceRest, evidencePaths) {
  const d = candidateDigest(claim, klass);
  if (seen.digests.has(d)) {
    const dup = seen.records.find((r) => candidateDigest(r.claim, r.klass) === d);
    return { id: dup ? dup.id : null, deduped: true };
  }
  const r = core.candidates.capture(memoryStoreDir(), { claim: String(claim), klass, provenance: { ...provenanceRest, evidencePaths } });
  if (!r.ok) return { id: null, deduped: false, error: r.reason };
  seen.digests.add(d);
  seen.records.push(r.record);
  return { id: r.record.id, deduped: false };
}

/*
 * decision #2a/#2c/#2b — the three evidence-backed capture sources, run every savepoint.
 *   findings.byCheck / .byFile   Map<check-or-file, candidateId> — feeds memoryProposals() below
 *   all                          [{id, klass, claim, source}]  — every NEWLY captured candidate (not deduped)
 *   operatorErrors               [{error}]  — a malformed/invalid --candidate arg
 */
function runCandidateCapture(state, checks) {
  if (!core) {
    return {
      available: false, findings: { byCheck: new Map(), byFile: new Map() }, all: [], operatorErrors: [],
      note: 'core/ (the host-neutral rollover core) could not be loaded, so no candidate memory was captured this run',
    };
  }
  const seen = existingCandidateDigests();
  const revision = String(state.sourceRevision || 'no-revision');
  const base = { by: 'savepoint', sourceKind: 'savepoint', cycleId: revision, conversationId: null, host: null };
  const all = [];

  const byCheck = new Map();
  for (const c of checks) {
    if (c.outcome !== OUTCOME.FAIL && c.outcome !== OUTCOME.CANNOT_DETERMINE) continue;
    /*
     * ⛔ AND AN UNDECIDED CONTRACT IS CAPTURED LIKE ANY OTHER BLOCKER, DELIBERATELY. The first instinct
     * was to skip coverage rows here as onboarding noise. That was wrong twice: capture is deduped on
     * content digest, so an unanswered contract is recorded ONCE rather than every session, and the
     * review step's whole discipline (Step 2c of /savepoint: promote, reject, or defer, but never
     * silently) is exactly what an undecided contract needs. Filing it as a lead is what stops "nobody
     * has decided" from quietly becoming "nobody will".
     */
    // A row marked ephemeral (e.g. note:budget) already archives its full content elsewhere; auto-capturing
    // it as a candidate memory would be duplication, not a new lead. The operator's own --candidate path
    // (below) is untouched by this — the skip applies only to this automatic mint from checks[].
    if (c.ephemeral) continue;
    const claim = `${c.check}: ${c.detail}`;
    const r = captureCandidateOnce(seen, claim, 'finding', base, [stateLib.STATE_FILE]);
    if (r.id) { byCheck.set(c, r.id); if (!r.deduped) all.push({ id: r.id, klass: 'finding', claim, source: 'check' }); }
  }
  const byFile = new Map();
  for (const rej of (state.evidence && state.evidence.rejected) || []) {
    if (!rej.reason.startsWith('stale revision')) continue;
    const claim = `evidence ${rej.file} stopped counting: ${rej.reason}`;
    const r = captureCandidateOnce(seen, claim, 'finding', base, [`${stateLib.STATE_DIR}/evidence/${rej.file}`]);
    if (r.id) { byFile.set(rej.file, r.id); if (!r.deduped) all.push({ id: r.id, klass: 'finding', claim, source: 'stale-evidence' }); }
  }
  for (const text of state.constraints || []) {
    if (!text) continue;
    const r = captureCandidateOnce(seen, text, 'constraint', base, [`${stateLib.STATE_DIR}/goal.json`]);
    if (r.id && !r.deduped) all.push({ id: r.id, klass: 'constraint', claim: String(text), source: 'goal-constraint' });
  }

  const operatorErrors = [];
  for (const raw of allValuesOf('--candidate')) {
    const idx = raw.indexOf(':');
    if (idx <= 0) { operatorErrors.push({ error: `malformed --candidate "${raw}" — expected "kind:text"` }); continue; }
    const klass = raw.slice(0, idx).trim();
    const text = raw.slice(idx + 1).trim();
    /*
     * ⛔ ONLY THIS ONE OF THE FOUR OPERATOR ERRORS CARRIES AN ADR-003 ROW. `kernel:R17` is "a klass
     * outside the four", and it is the only one of these with a false-positive class worth relaxing:
     * an operator guessing `reference`, `note` or `todo` wrote a real lead in a slightly wrong word.
     * A malformed `--candidate` with no colon, an empty claim, and a capture that failed outright are
     * not that shape and stay FAIL in every posture — an id the resolver is never asked about.
     */
    if (!MEMORY_KLASSES.includes(klass)) { operatorErrors.push({ error: `--candidate kind "${klass}" is not one of ${MEMORY_KLASSES.join(', ')} — the form is --candidate "kind:text"`, rule: KERNEL_POSTURE_ROWS.candidateKlass }); continue; }
    if (!text) { operatorErrors.push({ error: `--candidate "${raw}" has no claim text` }); continue; }
    const r = captureCandidateOnce(seen, text, klass, { by: 'operator', sourceKind: 'operator', cycleId: revision, conversationId: null, host: null }, []);
    if (!r.id) { operatorErrors.push({ error: r.error || `--candidate "${raw}" could not be captured` }); continue; }
    if (!r.deduped) all.push({ id: r.id, klass, claim: text, source: 'operator' });
  }

  return { available: true, findings: { byCheck, byFile }, all, operatorErrors };
}

/*
 * decision #4/#1 — promotion's ONE side effect beyond the store: the canonical entity, file-backed
 * per memory/knowledge-graph.md (`memory/graph/<type>/<slug>.md`; frontmatter carries aliases +
 * relations; W5 extends it with the promotion's own provenance — promotedFrom/promotedAt/verifiedBy/
 * promotedBy — so a reader can trace a canonical fact back to the candidate and the stated
 * verification that earned it, without a second store to keep in sync).
 *
 * ⛔ A CANDIDATE MUST NOT SILENTLY FORK INTO TWO ENTITIES. core/memory/candidates.js's promote() is
 * idempotent at the RECORD level (a repeat is a recorded no-op); this write must not turn that into a
 * SECOND, DIFFERENT entity on a repeat with a different --as. findExistingPromotion() scans the graph
 * for a prior `promotedFrom: <id>` before writing — the SAME target is a harmless idempotent re-write,
 * a DIFFERENT target is refused rather than quietly creating parallel truth.
 */
function graphSlugSafe(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function findExistingPromotion(id, intendedFile) {
  const root = graphDir();
  if (!fs.existsSync(root)) return null;
  const marker = `promotedFrom: ${id}`;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const found = walk(p); if (found) return found; }
      else if (e.isFile() && e.name.endsWith('.md')) {
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { /* unreadable — cannot be claimed as a conflict either */ }
        if (text.includes(marker) && path.resolve(p) !== path.resolve(intendedFile)) return path.relative(DIR, p);
      }
    }
    return null;
  };
  return walk(root);
}

const yamlString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;

function writeGraphEntity(type, slug, rec, { verifiedBy, by }) {
  const safeType = graphSlugSafe(type);
  const safeSlug = graphSlugSafe(slug);
  if (!safeType || !safeSlug || safeType !== type || safeSlug !== slug) {
    return { ok: false, detail: `--as must be lowercase kebab-case "type/slug" (got "${type}/${slug}")` };
  }
  const dir = path.join(graphDir(), safeType);
  const file = path.join(dir, `${safeSlug}.md`);

  const conflict = findExistingPromotion(rec.id, file);
  if (conflict) {
    // ⛔ A DELIBERATE REFUSAL, NOT AN ENGINE FAILURE. Distinct from the catch{} below: nothing here
    // could not be determined — the graph was read successfully and says a different target was
    // already chosen. That is FAIL (a real disagreement), never CANNOT_DETERMINE.
    return { ok: false, refused: true, detail: `candidate ${rec.id} was already promoted to ${conflict} — promote again with the SAME --as to confirm, or edit that file directly to move it` };
  }

  // ⛔ promotedAt IS THE STORE'S OWN VERIFICATION TIMESTAMP, NOT "now" — same reasoning as the caller
  // reading verifiedBy/by off `rec.verification` rather than this invocation's args: a repeat with the
  // SAME target must re-write byte-for-byte the same frontmatter, or "idempotent" is only true of the
  // store and not of the file a reader actually opens. BUG-5: this used to fall back to
  // `new Date().toISOString()` whenever `rec.verification.at` was absent (a legacy or hand-edited record
  // can be `verificationState: 'verified'` with no `.at` — core/memory/candidates.js's validate() does
  // not police the shape of `.verification`), which computed a NEW value on every call and silently
  // broke exactly the property this comment claims. There is no honest way to make THAT case idempotent
  // — a fallback clock reading differs on every invocation by definition — so this REFUSES instead of
  // writing an entity whose repeat would disagree with itself.
  const promotedAt = rec.verification && rec.verification.at;
  if (!promotedAt) {
    return { ok: false, refused: true, detail: `candidate ${rec.id} has no verification.at recorded — promotion cannot be written idempotently without it` };
  }
  const frontLines = [
    '---',
    `id: ${type}:${slug}`,
    'aliases: []',
    'relations: []',
    `promotedFrom: ${rec.id}`,
    `promotedAt: ${promotedAt}`,
    `verifiedBy: ${yamlString(verifiedBy)}`,
  ];
  if (by) frontLines.push(`promotedBy: ${yamlString(by)}`);
  frontLines.push('---', '');
  const body = [
    `# ${slug}`,
    '',
    `**Klass:** ${rec.klass}`,
    '',
    '## Observation',
    rec.claim,
    '',
    '## Provenance',
    `- captured by \`${rec.provenance.by || 'an unrecorded author'}\` in cycle \`${rec.provenance.cycleId}\` at ${rec.provenance.at}`,
    `- verified: ${verifiedBy}`,
    '',
  ].join('\n');

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${frontLines.join('\n')}\n${body}`);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, detail: `${(e && e.code) || 'ERROR'}: ${(e && e.message) || e}` };
  }
}

/*
 * ⭐ THE LESSONS REGISTER'S SOURCE (P2-O-3). `kernel/lib/render.js` opens no file — kernel/schema.test.mjs
 * asserts it contains no `readFileSync`, because a renderer that reads the filesystem is a renderer whose
 * output cannot be produced from arguments in a test. So the store is read HERE and handed over as rows.
 *
 * ⛔ THREE STATES, NOT TWO, AND THE THIRD ONE IS THE WHOLE POINT (anti-drift item 5). A directory that
 * does not exist is a real, counted ZERO and says which directory. A file that exists and cannot be read
 * is NOT a zero: the count is withheld and the register says so, because "we found nothing" and "we could
 * not look" must not render the same document. Both halves carry their own status, so an unreadable
 * candidate store never suppresses the promoted-lesson rows and vice versa.
 *
 * ⛔ THE CANDIDATE HALF GOES THROUGH core/memory/candidates.js's `list()`, WHICH IS THE CLASSIFIED
 * BOUNDARY (core/_io.js readJSONClassified) AND ALREADY THE ONE THIS FILE USES FOR CAPTURE AND REVIEW.
 * Reading `memory/candidates/*.json` raw here would be a new unclassified raw JSON read
 * (kernel/schema.test.mjs's RAW_READS sweep) and a second interpretation of a store that already has one.
 * The graph half is markdown, not a registered artifact family, and is read the same way
 * findExistingPromotion() above already reads it.
 */
const GRAPH_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const APPLIES_TO_SKILL = /applies-to\|skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** One frontmatter scalar, unquoted. Deliberately not a YAML parser: the writer above emits flat scalars. */
function frontValue(front, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(front);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw || raw === '[]' || raw === 'null') return null;
  return raw.replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * The one-line observation a register row shows. `writeGraphEntity` puts it under `## Observation`; a
 * hand-authored entity (the file backend is a supported way to write one — memory/knowledge-graph.md)
 * may not have that heading, so the first non-heading, non-metadata body line is the fallback.
 */
function firstObservation(body) {
  const lines = String(body).split(/\r?\n/);
  const idx = lines.findIndex((l) => /^##\s+Observation\s*$/i.test(l.trim()));
  const from = idx >= 0 ? lines.slice(idx + 1) : lines;
  for (const l of from) {
    const t = l.trim();
    if (!t || t.startsWith('#') || t.startsWith('<!--') || /^\*\*Klass:\*\*/.test(t)) continue;
    return t.replace(/^[-*]\s+/, '');
  }
  return null;
}

/** Every promoted entity under memory/graph/, or the reason there is no list. */
function readGraphEntities() {
  const root = graphDir();
  const rel = removalsLib.posix(path.relative(DIR, root)) || 'memory/graph';
  if (!fs.existsSync(root)) return { status: 'ABSENT', entities: [], reason: `\`${rel}/\` does not exist in this project` };
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) files.push(p);
    }
  };
  try { walk(root); } catch (e) { return { status: 'UNREADABLE', entities: [], reason: `\`${rel}/\` could not be listed (${(e && e.code) || 'ERROR'})` }; }

  const entities = [];
  for (const p of files) {
    const fileRel = removalsLib.posix(path.relative(DIR, p));
    let text;
    // ⛔ AN UNREADABLE ENTITY STOPS THE WHOLE COUNT, IT DOES NOT SHRINK IT. Skipping it would render a
    // number smaller than the truth and label it verified — a count nobody could establish, presented
    // as one that was.
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return { status: 'UNREADABLE', entities: [], reason: `\`${fileRel}\` could not be read (${(e && e.code) || 'ERROR'})` }; }
    const fm = GRAPH_FRONTMATTER.exec(text);
    const front = fm ? fm[1] : '';
    const body = fm ? text.slice(fm[0].length) : text;
    const parts = fileRel.split('/');
    const slug = path.basename(p, '.md');
    const type = parts.length >= 2 ? parts[parts.length - 2] : 'entity';
    entities.push({
      id: frontValue(front, 'id') || `${type}:${slug}`,
      file: fileRel,
      observation: firstObservation(body),
      promotedAt: frontValue(front, 'promotedAt'),
      promotedFrom: frontValue(front, 'promotedFrom'),
      // Truncated to ONE line here rather than in the renderer: the stated verification can be a
      // paragraph, and a register row is a pointer at the entity, not a copy of it.
      verifiedBy: frontValue(front, 'verifiedBy'),
      skills: [...new Set([...front.matchAll(APPLIES_TO_SKILL)].map((m) => m[1]))],
    });
  }
  entities.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { status: 'OK', entities, reason: null };
}

/** Every candidate record, or the reason there is no list. */
function readCandidateRecords() {
  const rel = 'memory/candidates';
  if (!core) {
    return { status: 'UNREADABLE', records: [], reason: 'core/ (the host-neutral rollover core) could not be loaded, so the candidate store could not be read' };
  }
  let listed;
  try { listed = core.candidates.list(memoryStoreDir()); }
  catch (e) { return { status: 'UNREADABLE', records: [], reason: `\`${rel}/\` could not be listed (${(e && e.message) || e})` }; }
  if (listed.status !== 'OK') return { status: 'ABSENT', records: [], reason: `\`${rel}/\` does not exist in this project` };
  if ((listed.unreadable || []).length) {
    const named = listed.unreadable.slice(0, 3).map((u) => `${u.file} (${u.why})`).join(', ');
    return { status: 'UNREADABLE', records: listed.records, reason: `${listed.unreadable.length} record(s) in \`${rel}/\` could not be read: ${named}` };
  }
  return { status: 'OK', records: listed.records, reason: null };
}

/** The snapshot render.js's renderLessons/verifyLessons take. Read fresh per call — a count is derived every time. */
function lessonsStore(state) {
  return {
    generatedAt: state && state.generatedAt,
    graph: readGraphEntities(),
    candidates: readCandidateRecords(),
    // The store's own word for an unverified lead, carried rather than re-spelled: core/memory/candidates.js
    // is the one owner of that label and a second copy in the renderer is how it drifts.
    unverifiedMarker: core ? core.candidates.UNVERIFIED_MARKER : null,
  };
}

const renderLessonsFrom = (state, existing) => render.renderLessons(existing, lessonsStore(state));

/*
 * ⛔ THE REGISTER PROJECTS A STORE THIS VERB ITSELF WRITES TO, AND A RUN THAT LEFT IT BEHIND WOULD BE
 * PUBLISHING A DOCUMENT IT KNOWS IS WRONG.
 *
 * The `memory` stage captures candidate memories — in `--write` AND in verify-only runs, because
 * savepoint is the guaranteed capture point (anti-drift item 11) — and it runs LAST, after the render
 * and verify stages. So a run that captures one new lead leaves `docs/derived/LESSONS.md` one behind
 * the store it counts, and the NEXT run FAILs on a document that was correct when it was written. That
 * is not a hypothetical: it turns every savepoint that records a new finding into a guaranteed failure
 * of the following one, and "the project ships in a state where success is unreachable" is the exact
 * complaint the 2026-08-07 field run made about the migration gate — it "trains the operator to ignore it".
 *
 * ⛔ SO THE STAGE THAT CHANGED THE STORE KEEPS THE PROJECTION IN STEP, AND IT IS BOUNDED THREE WAYS:
 *   1. only when this run actually CAPTURED something and the counts therefore actually moved;
 *   2. only when the register was ALREADY IN STEP before the capture — on a verify-only run a check
 *      must never repair a document it has just reported as wrong, so a stale or hand-edited register
 *      is left exactly as it is and its FAIL row stands, naming `--write` as the fix;
 *   3. only when both the `render` and `memory` stages ran; a scoped savepoint that skipped either
 *      establishes nothing here and writes nothing.
 * A verify-only run reaching condition 2 has ALREADY written to the tree — the candidate records
 * themselves are tracked files under `memory/candidates/` — so this is the projection of writes that
 * just happened, not a new class of side effect, and it is reported as its own row rather than done
 * quietly. This is the same reasoning BUG-3 uses for re-running the removal scan after the render:
 * a stage that changed the tree does not get to report on the tree as it was.
 */
function refreshLessonsRegister(t, preStore, state, wroteDocs) {
  const abs = path.join(DIR, t.file);
  const existing = readText(abs);
  if (existing === null) return null; // nothing on disk to keep in step
  const postStore = lessonsStore(state);
  const asRendered = render.renderLessons(existing, preStore);
  const fresh = render.renderLessons(existing, postStore);
  if (fresh === asRendered) return null; // the capture moved no count this document states

  if (!wroteDocs) {
    const inStep = render.driftFromGenerated(existing, asRendered, t.file);
    if (inStep.outcome !== OUTCOME.PASS) return null; // condition 2: never repair what this run just failed
  }
  try { stateLib.writeAtomic(abs, fresh); } catch (e) {
    return result(OUTCOME.CANNOT_DETERMINE, `register:refresh:${removalsLib.posix(t.file)}`,
      `this run captured candidate memories and ${removalsLib.posix(t.file)} could not be re-rendered to match them (${(e && e.message) || e}) — the register now under-reports the store; \`savepoint --write\` regenerates it.`, { checked: 0 });
  }
  return result(OUTCOME.PASS, `register:refresh:${removalsLib.posix(t.file)}`,
    `this run captured candidate memories, so ${removalsLib.posix(t.file)} was re-rendered from the store as this run leaves it — the register counts what is there now, not what was there before the capture. It was in step beforehand; a stale or hand-edited register is never repaired this way.`,
    { checked: 1 });
}

// --- the wave-ledger fold -----------------------------------------------------------------------

/*
 * ⛔ THE LEDGER HAD A WRITER, TWO DETECTORS, AND NO READER (I-3).
 *
 * `hooks/spawn-guard.js` creates `.respawnpack/wave-ledger.md` and appends a line per subagent
 * dispatch. Its own header, `skills/savepoint/SKILL.md` and `hooks/README.md` all state that
 * `/savepoint` folds it into the derived docs and DELETES it. Nothing in `kernel/` or `hooks/` ever
 * read it: the file grew for the life of the project, and `precompact-ledger-nudge.js`'s
 * `ledgerBehindHead` plus `session-routing-nudge.js` warned about a ledger behind HEAD forever. A
 * promise with no mechanism is the shape this kernel exists to refuse, so here is the mechanism.
 *
 * ⛔ AND IT IS GUARDED BY TRACKED-NESS, BECAUSE THE UNQUALIFIED FOLD WOULD DELETE OWNER-AUTHORED WORK.
 * On an installed TARGET, `install/install.js` gitignores `.respawnpack/` wholesale, so the ledger
 * there is genuinely mid-run scratch and the promise is true. In RespawnPack's OWN repository
 * `.gitignore` deliberately un-ignores this one path and the file is a tracked, hand-written, 306-line
 * maintainer document. So: fold and delete an UNTRACKED ledger; a TRACKED one is reported
 * NOT_APPLICABLE and never touched. Anything that cannot be classified — no git, an unreadable ledger,
 * a write that throws — is CANNOT_DETERMINE and leaves the file exactly where it was. The one thing
 * this code must never do is delete a ledger it could not prove was scratch.
 *
 * ⛔ NOTHING IS TRUNCATED. The fold is the ledger's permanent home and the ledger is deleted after it,
 * so a bounded fold would be a silent deletion — the exact failure render.js's note budget was
 * rewritten to stop. Every dispatch group and every line of the current state travels.
 */
const WAVE_LEDGER_REL = path.join('.respawnpack', 'wave-ledger.md');
const CONTINUITY_REL = path.join('docs', 'derived', 'CONTINUITY.md');
const DERIVED_CHANGELOG_REL = path.join('docs', 'derived', 'CHANGELOG.md');

/*
 * The folded ledger lives in its OWN marked block INSIDE the generated block — machine-owned, so it is
 * never written into the hand-authored NOTE the founder owns, and carried forward verbatim by every
 * later render, so `render.driftFromGenerated` keeps comparing equal. Without the carry-forward the
 * very next `--verify` would report the document this fold just wrote as stale or hand-edited.
 */
const LEDGER_OPEN = '<!-- RESPAWNPACK:WAVE-LEDGER — folded from .respawnpack/wave-ledger.md -->';
const LEDGER_CLOSE = '<!-- /RESPAWNPACK:WAVE-LEDGER -->';

/** The span of a marked block, by index rather than by regex — the markers contain regex metacharacters. */
function sliceBlock(text, open, close) {
  const s = String(text || '');
  const a = s.indexOf(open);
  if (a < 0) return null;
  const b = s.indexOf(close, a + open.length);
  if (b < 0) return null;
  return { start: a, end: b + close.length, body: s.slice(a + open.length, b) };
}

/** Put `body` in the fold block of `text`, replacing an existing one, otherwise just above GEN_CLOSE. */
function withLedgerBlock(text, body) {
  const s = String(text);
  const block = `${LEDGER_OPEN}${body}${LEDGER_CLOSE}`;
  const here = sliceBlock(s, LEDGER_OPEN, LEDGER_CLOSE);
  if (here) return s.slice(0, here.start) + block + s.slice(here.end);
  const at = s.lastIndexOf(render.GEN_CLOSE);
  // A doc with no generated block has never been rendered; appending is the honest fallback and the
  // migration path (planMigration) owns the rest.
  if (at < 0) return `${s.replace(/\s*$/, '')}\n\n${block}\n`;
  return `${s.slice(0, at)}${block}\n\n${s.slice(at)}`;
}

/** Carry a previously folded block from the doc on disk into a fresh render of it. */
function carryLedgerFold(fresh, existing) {
  const prior = sliceBlock(existing, LEDGER_OPEN, LEDGER_CLOSE);
  return prior ? withLedgerBlock(fresh, prior.body) : fresh;
}

/*
 * CONTINUITY's renderer, wrapped so the fold block survives every later render. BOTH callers use it —
 * `savepoint`'s writing loop and `state`'s read-only staleness report — because a CONTINUITY.md
 * carrying a fold block would read as stale to whichever of the two did not carry it forward, which is
 * the K-05 seam reopened one path wider.
 *
 * ⛔ Both render-target lists below stay literal, and spell `path.join('docs', 'derived',
 * 'CONTINUITY.md')` out, because `counts-fence.test.mjs` parses that list OUT OF THIS SOURCE to hold
 * README.md's `/savepoint` claim to it. A path constant there would blind the fence, and so would this
 * sentence if it quoted the declaration the fence anchors on.
 */
const renderContinuityFolded = (state, existing) => carryLedgerFold(render.renderContinuity(state, existing), existing);

/**
 * Is this repo-relative path tracked by git? Three answers, because two would collapse "git says no"
 * into "git could not say", and only the first of those is safe to delete on.
 * @returns {'YES'|'NO'|'UNKNOWN'}
 */
function gitTracks(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: DIR, stdio: ['ignore', 'ignore', 'ignore'] });
    return 'YES';
  } catch (e) {
    // 1 = in a repository, not in the index. Anything else (128 outside a repo, ENOENT with no git on
    // PATH) is an answer nobody got, and is never read as "untracked".
    return e && e.status === 1 ? 'NO' : 'UNKNOWN';
  }
}

/*
 * The ledger's shape, as `hooks/spawn-guard.js` writes it and an orchestrator hand-edits it:
 *
 *   # Wave ledger
 *   > header prose
 *   - `<ISO>` · dispatch #N in flight · **<type>** — <what> · session <id>
 *     - the outcome, added by hand as the wave lands
 *   ## Current state
 *   - free prose
 *
 * A DISPATCH GROUP is one dispatch line plus every line under it until the next dispatch or heading —
 * that grouping is what makes "one changelog line per wave, not per raw ledger line" possible. A group
 * with no lines under it means "started, fate unrecorded", which is exactly what a resume needs, so it
 * is folded as that rather than dropped.
 */
function parseWaveLedger(text) {
  const groups = [];
  const currentState = [];
  let group = null;
  let inCurrentState = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^#{1,6}\s/.test(line)) {
      inCurrentState = /^#{1,6}\s+current state\b/i.test(line);
      group = null; // a heading ends a group; an outcome line never lives under a different section
      continue;
    }
    if (inCurrentState) { currentState.push(line); continue; }
    if (/·\s*dispatch\s*#/i.test(line)) { group = { dispatch: line.trim(), outcomes: [] }; groups.push(group); continue; }
    if (group && line.trim()) group.outcomes.push(line.trim().replace(/^[-*]\s+/, ''));
  }
  while (currentState.length && !currentState[0].trim()) currentState.shift();
  while (currentState.length && !currentState[currentState.length - 1].trim()) currentState.pop();
  return { groups, currentState };
}

/** One changelog line for one dispatch group. Tolerant of hand-editing: every field degrades, none throws. */
function changelogLineFor(group) {
  const when = (/`([^`]+)`/.exec(group.dispatch) || [])[1] || null;
  const day = when && /^\d{4}-\d{2}-\d{2}/.test(when) ? when.slice(0, 10) : null;
  const type = (/\*\*([^*]+)\*\*/.exec(group.dispatch) || [])[1] || 'agent';
  const after = group.dispatch.split(/\*\*[^*]*\*\*/).slice(1).join('');
  const what = after.replace(/^[\s—-]+/, '').replace(/\s*·\s*session\s+\S+\s*$/i, '').trim();
  const outcome = group.outcomes.length ? group.outcomes.join('; ') : 'outcome not recorded in the ledger';
  return `- wave: **${type}**${what ? ` — ${what}` : ''}${day ? ` (dispatched ${day})` : ''} — ${outcome}`;
}

/** The block body folded into CONTINUITY.md's generated block. */
function ledgerFoldSection(parsed, whenISO, { carriedDispatches = [] } = {}) {
  const unresolved = parsed.groups.filter((g) => !g.outcomes.length).length;
  const L = ['', '', '## Current state — folded from the wave ledger', ''];
  L.push(`_Folded from \`${removalsLib.posix(WAVE_LEDGER_REL)}\` at ${whenISO}, which was then deleted: it is mid-run scratch and this is its permanent home._`);
  L.push('');
  if (parsed.currentState.length) for (const line of parsed.currentState) L.push(line);
  else L.push('- the ledger recorded no "Current state" section');
  L.push('');
  L.push(`- ${parsed.groups.length} dispatch group(s) folded, of which ${unresolved} carried no recorded outcome ("started, fate unrecorded")`);
  if (carriedDispatches.length) {
    // No derived changelog to append to, so the dispatch lines come here instead. Deleting the ledger
    // with nowhere for them to land would be the silent deletion this whole fold refuses.
    L.push('');
    L.push(`_No \`${removalsLib.posix(DERIVED_CHANGELOG_REL)}\` exists in this project, so the dispatch lines are folded here:_`);
    L.push('');
    for (const line of carriedDispatches) L.push(line);
  }
  L.push('');
  return L.join('\n');
}

/*
 * Where the folded lines belong in the derived changelog: the END OF THE MOST RECENT ENTRY, which in
 * the newest-first form `/savepoint` Step 1 writes is the first `##` section. A file with no entry
 * heading at all takes them at the end, which is the only other place they could honestly go.
 */
function foldIntoChangelog(existing, lines, whenISO) {
  const s = String(existing);
  const block = `\n<!-- folded from ${removalsLib.posix(WAVE_LEDGER_REL)} at ${whenISO} -->\n${lines.join('\n')}\n`;
  const first = s.search(/^##\s+/m);
  if (first < 0) return `${s.replace(/\s*$/, '')}\n${block}`;
  const rest = s.slice(first + 1);
  const next = rest.search(/^##\s+/m);
  const at = next < 0 ? s.length : first + 1 + next;
  return `${s.slice(0, at).replace(/\s*$/, '')}\n${block}\n${s.slice(at)}`;
}

/*
 * The `wave-ledger` check row, and the ONLY place the ledger is ever deleted.
 *
 * ⛔ THE DELETE IS GATED ON THE RUN'S OWN VERDICT. `settled` is the rollup of every other check in this
 * savepoint, so a run that was already blocked folds nothing, appends nothing and deletes nothing — and
 * says exactly that, as CANNOT_DETERMINE ("the fold could not run"), never as a FAIL of its own and
 * never as a PASS. That keeps a blocked savepoint's exit code the one its blockers earned.
 *
 * The row's four other states: absent ⇒ no row at all; tracked ⇒ NOT_APPLICABLE; present, untracked and
 * unfolded ⇒ FAIL naming `--write`; unclassifiable ⇒ CANNOT_DETERMINE with the file untouched.
 */
function waveLedgerCheck({ write, settled }) {
  const abs = path.join(DIR, WAVE_LEDGER_REL);
  const rel = removalsLib.posix(WAVE_LEDGER_REL);
  if (!fs.existsSync(abs)) return null; // no ledger, no claim about one

  const tracked = gitTracks(WAVE_LEDGER_REL);
  if (tracked === 'YES') {
    return result(OUTCOME.NOT_APPLICABLE, 'wave-ledger',
      `${rel} is TRACKED by git, so this repository keeps it on purpose — it is a maintainer document, not the mid-run scratch the fold is for. Nothing was folded and nothing was deleted. (An installed target gitignores .respawnpack/ wholesale, and there the same file is folded and deleted.)`);
  }
  if (tracked === 'UNKNOWN') {
    return result(OUTCOME.CANNOT_DETERMINE, 'wave-ledger',
      `${rel} is present but git could not say whether it is tracked (no repository here, or no git on PATH), so it could not be told apart from a tracked maintainer document. Nothing was folded and nothing was deleted.`, { checked: 0 });
  }

  const text = readText(abs);
  if (text === null) {
    return result(OUTCOME.CANNOT_DETERMINE, 'wave-ledger',
      `${rel} is present but could not be read, so nothing could be folded out of it. It was left exactly where it is.`, { checked: 0 });
  }

  const parsed = parseWaveLedger(text);
  if (!parsed.groups.length && !parsed.currentState.length) {
    return result(OUTCOME.NOT_APPLICABLE, 'wave-ledger',
      `${rel} carries no dispatch group and no "Current state" section — there is nothing to fold, so nothing was folded and the file was left in place.`);
  }

  const subjects = parsed.groups.length + (parsed.currentState.length ? 1 : 0);
  if (!write) {
    return result(OUTCOME.FAIL, 'wave-ledger',
      `${rel} is present, untracked and unfolded (${parsed.groups.length} dispatch group(s)). A verify is not a write, so nothing was changed — run \`savepoint --write\` to fold it into the derived docs and delete it.`, { checked: subjects });
  }
  if (exitCodeFor(settled) !== 0) {
    return result(OUTCOME.CANNOT_DETERMINE, 'wave-ledger',
      `${rel} was NOT folded and NOT deleted: this savepoint was already blocked (${settled}) before writeback, and the fold is gated on the run that would have carried it. Clear the blocking checks and re-run \`savepoint --write\`.`, { checked: 0 });
  }

  const when = new Date().toISOString();
  const contAbs = path.join(DIR, CONTINUITY_REL);
  const cont = readText(contAbs);
  if (cont === null) {
    return result(OUTCOME.CANNOT_DETERMINE, 'wave-ledger',
      `${rel} was left in place: ${removalsLib.posix(CONTINUITY_REL)} could not be read, so the ledger's current state had nowhere to be folded to. A ledger is only ever deleted once its contents have landed.`, { checked: 0 });
  }

  const lines = parsed.groups.map(changelogLineFor);
  const clAbs = path.join(DIR, DERIVED_CHANGELOG_REL);
  const changelog = readText(clAbs);
  const toChangelog = changelog !== null && lines.length > 0;
  const writes = [
    { abs: contAbs, text: withLedgerBlock(cont, ledgerFoldSection(parsed, when, { carriedDispatches: toChangelog ? [] : lines })) },
  ];
  if (toChangelog) writes.push({ abs: clAbs, text: foldIntoChangelog(changelog, lines, when) });

  try {
    // The rendered docs are written first and the ledger is removed last, so a failure anywhere leaves
    // the ledger on disk and the next run folds it again — never the other way round.
    for (const w of writes) stateLib.writeAtomic(w.abs, w.text);
    fs.rmSync(abs);
  } catch (e) {
    return result(OUTCOME.CANNOT_DETERMINE, 'wave-ledger',
      `the fold of ${rel} could not be completed (${(e && e.message) || e}). The ledger was NOT deleted; re-run \`savepoint --write\` once the cause is fixed.`, { checked: 0 });
  }
  const where = !lines.length
    ? 'it carried no dispatch group'
    : toChangelog
      ? `${lines.length} dispatch group(s) appended to the most recent entry of ${removalsLib.posix(DERIVED_CHANGELOG_REL)}`
      : `${lines.length} dispatch group(s) folded into ${removalsLib.posix(CONTINUITY_REL)}, because this project has no ${removalsLib.posix(DERIVED_CHANGELOG_REL)} to append them to`;
  return result(OUTCOME.PASS, 'wave-ledger',
    `folded ${rel} and deleted it: ${where}, and its current state folded into the generated block of ${removalsLib.posix(CONTINUITY_REL)}. Outcomes inside a ledger are recorded by hand, so what is folded is what somebody wrote, not what this run observed.`,
    { checked: subjects });
}

// --- verbs ------------------------------------------------------------------------------------

/*
 * ⛔ REPORT-ONLY, ON PURPOSE (K-05 / I-11). `cmdState()` compiles and writes STATE.json and NOTHING
 * ELSE — rendering CONTINUITY.md/GAPS.md and writing them is `savepoint --write`'s job alone
 * (state.js's DF-005 comment: "state itself stays a compile step and does not fail a project for an
 * unconfigured contract"). That split had a hole: `/respawn` Step 0 tells the model to run plain
 * `state` when STATE.json looks stale, and a fresh STATE.json said nothing about CONTINUITY.md or
 * GAPS.md still describing yesterday — the compile step passed silently while the documents a reader
 * actually opens stayed wrong.
 *
 * This runs the SAME drift check `savepoint` uses (`render.driftFromGenerated`) against each rendered
 * target, read-only, in memory — no write, and no render path other than the one `cmdSavepoint`'s own
 * `targets` loop already owns. A disagreement is REPORTED, never turned into `state`'s own FAIL: that
 * would flip the exit code for every project with a stale render, which is `savepoint`'s call to make,
 * not a silent compile step's. So every non-PASS verdict here is downgraded to CANNOT_DETERMINE and
 * its detail names `savepoint --write` as the fix; a fresh match pushes nothing at all, so the common
 * case stays exactly as quiet as it was before this existed.
 */
function renderStalenessChecks(state, revisions) {
  const equivalentRevisions = (revisions && revisions.chain) || [];
  const targets = [
    { file: path.join('docs', 'derived', 'CONTINUITY.md'), render: renderContinuityFolded },
    { file: path.join('docs', 'derived', 'GAPS.md'), render: render.renderGaps },
    { file: path.join('docs', 'derived', 'LESSONS.md'), render: renderLessonsFrom },
  ];
  const rows = [];
  for (const t of targets) {
    const existing = readText(path.join(DIR, t.file));
    if (existing === null) continue; // nothing rendered here yet — savepoint's migration/creation story owns that, not this report
    const fresh = t.render(state, existing);
    const verdict = render.driftFromGenerated(existing, fresh, t.file, { equivalentRevisions });
    if (verdict.outcome === OUTCOME.PASS) continue; // fresh docs stay quiet
    rows.push(result(OUTCOME.CANNOT_DETERMINE, verdict.check,
      `${verdict.detail} \`state\` only compiles STATE.json and never renders or writes the docs — run \`savepoint --write\` to regenerate this one.`,
      { checked: verdict.checked }));
  }
  return rows;
}

function cmdState() {
  const { state, findings, revisions } = stateLib.compile(DIR);
  const file = stateLib.write(DIR, state);
  // The exit-governing outcome is rolled up from the COMPILE findings only, exactly as before this
  // fix — a stale render is reported below but must never change `state`'s own exit code.
  const outcome = rollup(findings.length ? findings : [result(OUTCOME.PASS, 'compile', 'state compiled')]);
  const reported = [...findings, ...renderStalenessChecks(state, revisions)];
  return { outcome, findings: reported, wrote: path.relative(DIR, file), state };
}

/*
 * ⛔ A VERIFY IS NOT A WRITE — AND FOR A LONG TIME IT WAS ONE.
 *
 * `savepoint --verify` without `--write` is documented as check-only, and it rewrote STATE.json on every
 * run regardless. Harmless while `sourceRevision` always equalled HEAD; the moment the documented
 * closeout put HEAD one savepoint commit past the state (commit work W → savepoint → commit docs as S),
 * a verify-only run at S rebound the committed STATE.json to S and left the tree dirty with a change
 * nobody asked for — the operator's fix was `git checkout -- docs/derived/STATE.json`, every session.
 *
 * So: with --write, the write is verified by digest read-back exactly as before. Without it, the fresh
 * compile is held in memory and compared against what is ON DISK — `generatedAt` excluded, since that
 * is the one field that changes when nothing has — and the disk copy is never touched. Agreement is
 * PASS; disagreement is FAIL naming `--write` as the fix, because a committed STATE.json that no longer
 * matches its source is a stale document presented as current, which is the whole DF-011 shape.
 *
 * ⛔ THE ONE VERIFY-ONLY WRITE LEFT IS CREATION. A project with no STATE.json at all has nothing to
 * verify against and nothing a reader could boot from; materialising it is not rewriting anything. A
 * STATE.json that EXISTS but cannot be read is neither — it is reported, and `--write` regenerates it.
 */
function stateWritebackCheck(state, write) {
  const file = path.join(DIR, stateLib.STATE_FILE);
  const exists = fs.existsSync(file);

  if (!write && exists) {
    // Verify-only against an existing file: nothing below this line writes.
    if (!core) {
      return result(OUTCOME.CANNOT_DETERMINE, 'state-writeback',
        'core/ (the host-neutral rollover core) could not be loaded, so STATE.json on disk could not be compared to a fresh compile by digest — nothing was written (verify-only run)', { checked: 0 });
    }
    const onDisk = stateLib.read(DIR);
    if (!onDisk) {
      return result(OUTCOME.CANNOT_DETERMINE, 'state-writeback',
        `${stateLib.STATE_FILE} exists but could not be read, so it could not be verified against a fresh compile — nothing was written (verify-only run); \`savepoint --write\` regenerates it`, { checked: 0 });
    }
    const durableDigest = (s) => { const { generatedAt, ...rest } = s; return core.io.canonicalDigest(rest); };
    const fresh = durableDigest(state), disk = durableDigest(onDisk);
    return fresh === disk
      ? result(OUTCOME.PASS, 'state-writeback', `STATE.json on disk agrees with a fresh compile, verified by digest (${fresh.slice(0, 12)}) — left untouched (verify-only run)`, { checked: 1 })
      : result(OUTCOME.FAIL, 'state-writeback',
        `${stateLib.STATE_FILE} on disk does not match a fresh compile (disk ${disk.slice(0, 12)}, fresh ${fresh.slice(0, 12)}) — it is stale or was hand-edited. Nothing was written: run \`savepoint --write\` to regenerate it.`, { checked: 1 });
  }

  /*
   * ⭐ decision #5 — THE OPERATIONAL HANDOFF GETS THE SAME DISCIPLINE precompact-ledger-nudge.js
   * already applies to its own handoff: verify the write by reading it back before trusting it. A
   * savepoint that reports success over a write nobody confirmed is DF-011's shape one layer up — a
   * stale document presented as current — so a failed or disagreeing read-back is FAIL, never silent.
   * Digest, not a field spot-check: STATE.json is the whole compiled document, and core/_io.js's
   * canonicalDigest is stable-key (property order is an accident of construction, not a real
   * disagreement), so a reformatting is not reported as drift where there is none.
   */
  const created = !write; // verify-only with nothing on disk: creation, stated as such
  stateLib.write(DIR, state);
  if (!core) {
    // Written exactly as before; what is missing is the ability to PROVE the write, which is reported
    // rather than assumed — the same answer this check always gave without core/.
    return result(OUTCOME.CANNOT_DETERMINE, 'state-writeback',
      'core/ (the host-neutral rollover core) could not be loaded, so the STATE.json write could not be verified by digest', { checked: 0 });
  }
  const writtenDigest = core.io.canonicalDigest(state);
  const readBack = stateLib.read(DIR);
  const readBackDigest = readBack ? core.io.canonicalDigest(readBack) : null;
  return readBackDigest === writtenDigest
    ? result(OUTCOME.PASS, 'state-writeback', `STATE.json ${created ? 'did not exist and was created; the write is' : 'write'} verified by digest (${writtenDigest.slice(0, 12)})`, { checked: 1 })
    : result(OUTCOME.FAIL, 'state-writeback', readBack
      ? `STATE.json was written but reads back different content than what was written (wrote ${writtenDigest.slice(0, 12)}, read ${String(readBackDigest).slice(0, 12)}) — a savepoint must not report success over an unverified write`
      : 'STATE.json write could not be read back at all after writing', { checked: 1 });
}

/*
 * ⛔ THE TEN STAGES, NAMED — BECAUSE THE VERB LIST WAS NEVER THE UNIT OF SCOPING (the kernel audit §2.1).
 *
 * `savepoint` is ten subsystems in a trenchcoat, and until now the only way to run fewer of them was
 * to type a different verb: `removals` for one of them, `reconcile` for another, and nothing at all for
 * the other seven. That is why every "make it lighter" request the pack has received turned into a
 * proposal to delete a verb. The unit those requests actually wanted is the stage, so here it is.
 *
 * ⛔ AND A PARTIAL RUN CAN NEVER BE MISTAKEN FOR A FULL ONE. Every stage that does NOT run emits a
 * NOT_APPLICABLE row saying it was skipped BY REQUEST, the receipt records the whole set, and the text
 * output leads its verdict with a PARTIAL SAVEPOINT line. `--skip` is a scoping flag, not a silencer:
 * the risk it carries is exactly that a caller uses it to forge a green, which is why the skip is
 * printed rather than inferred from a shorter list of rows. Anti-drift item 14 applies per stage —
 * skipping `removals` on a tree with a populated registry prints the skip and never prints PASS.
 *
 * ⛔ THE ORDER IS THE RUN ORDER, and `checks[]` keeps it. A reader scanning a scoped run's rows sees
 * the skipped stages in the position they would have occupied, not collected in a footnote.
 */
/*
 * ⛔ `lineage` SITS BESIDE `removals`, AND THAT IS WHERE IT BELONGS. Both are contracts about knowledge
 * the project declared and the tree has to keep — one negative (this feature is gone), one about
 * provenance (this copy came from that source). Both read the tree the render has just written, and
 * both are NOT_APPLICABLE at exit 0 when a project has declared nothing (owner decision 22).
 */
const SAVEPOINT_STAGES = ['compile', 'writeback', 'render', 'verify', 'removals', 'lineage', 'reconcile', 'coverage', 'adapters', 'memory'];

/*
 * ⛔ `compile` IS NOT OPTIONAL, AND ASKING FOR THAT IS A REFUSAL RATHER THAN A NARROWER RUN. Every
 * stage after it reads the freshly compiled state: the writeback compares it, the render renders it,
 * the removals and reconcile rows are the compiler's own scans, the coverage survey classifies what it
 * found and the memory capture keys candidates on its revision. A savepoint that skipped the compile
 * would be reporting on whatever STATE.json happened to be lying on disk — which is precisely the
 * stale-projection-presented-as-current shape (DF-011) the whole verb exists to refuse.
 */
const SAVEPOINT_REQUIRED_STAGES = ['compile'];

/*
 * THE DEFAULT STAGE SET PER POSTURE PROFILE, IN ONE PLACE.
 *
 * ⛔ ALL TEN IN EVERY PROFILE, DELIBERATELY. ADR-003 (a development record)
 * assigns no savepoint stage to a profile: its rule table relaxes which OUTCOME a row returns, and a
 * profile that quietly ran fewer stages would be changing what an outcome MEANS (anti-drift item 3)
 * rather than changing a verdict. So the table below is uniform on purpose, and it exists as a table
 * anyway so that the day an ADR does assign a shorter default there is exactly one place to write it
 * and one place for a reader to look. An unknown or absent profile falls back to all ten.
 */
const SAVEPOINT_STAGE_DEFAULTS = {
  light: SAVEPOINT_STAGES,
  standard: SAVEPOINT_STAGES,
  strict: SAVEPOINT_STAGES,
};
const defaultSavepointStages = (profile) => SAVEPOINT_STAGE_DEFAULTS[profile] || SAVEPOINT_STAGES;

/**
 * Every `--only`/`--skip` value, comma-split and trimmed. Repeating the flag composes, as `--candidate`
 * does. A value that is itself a flag (`savepoint --only --write`) is NOT swallowed as a stage name:
 * the argument was omitted, and reporting that is more useful than reporting `--write` as an unknown
 * stage.
 */
const stageNamesOf = (name) => allValuesOf(name)
  .filter((v) => !String(v).startsWith('--'))
  .flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);

/**
 * Resolve which of the ten stages this invocation runs.
 *
 * Returns `{requested, ran, skipped, scoped}` — or `{refusal}`, in which case the caller runs NOTHING.
 * `requested` is what the caller asked for (the profile default, narrowed by `--only`, then reduced by
 * `--skip`); `ran` is what actually executed. They are recorded separately rather than collapsed
 * because "was it asked for" and "did it happen" are different questions, and a receipt that answered
 * only the first would be the same conflation `scopeApplied: null` exists to avoid in the task runner.
 *
 * ⛔ AN UNKNOWN STAGE NAME REFUSES INSTEAD OF BEING IGNORED. A typo'd `--only remvoals` that silently
 * ran all ten would be harmless; a typo'd `--skip remvoals` that silently ran all ten would be too —
 * but a typo'd name that silently matched NOTHING in an `--only` list would run nothing and report
 * success over it. One rule for both, at exit 2, naming the valid set: a scope nobody can resolve is a
 * scope, not a default.
 */
function resolveSavepointStages() {
  const asked = { only: stageNamesOf('--only'), skip: stageNamesOf('--skip') };
  const valid = `valid stages are ${SAVEPOINT_STAGES.join(', ')}`;
  for (const flagName of ['--only', '--skip']) {
    if (argv.includes(flagName) && !asked[flagName.slice(2)].length) {
      return { refusal: `${flagName} needs a comma-separated stage list and was given none — ${valid}. Nothing ran.` };
    }
  }
  const unknown = [...new Set([...asked.only, ...asked.skip])].filter((s) => !SAVEPOINT_STAGES.includes(s));
  if (unknown.length) {
    return { refusal: `unknown savepoint stage ${unknown.map((s) => `\`${s}\``).join(', ')} — ${valid}. Nothing ran: a scope naming a stage this kernel does not have is refused rather than rounded down to the full run.` };
  }

  const scoped = Boolean(asked.only.length || asked.skip.length);
  const base = asked.only.length
    ? SAVEPOINT_STAGES.filter((s) => asked.only.includes(s))
    : defaultSavepointStages((posturePolicy() || {}).profile);
  const requested = base.filter((s) => !asked.skip.includes(s));

  const missing = SAVEPOINT_REQUIRED_STAGES.filter((s) => !requested.includes(s));
  if (missing.length) {
    return {
      refusal: `the ${missing.map((s) => `\`${s}\``).join(', ')} stage is required by every stage after it and this scope omits it — `
        + 'a savepoint that skipped the compile would report on whatever STATE.json was already on disk, which is the stale projection this verb exists to catch. '
        + `It is never implied: name it, so the scope you typed is the scope that ran. Write \`--only ${[...missing, ...requested].join(',')}\`, or drop it from --skip. Nothing ran. (${valid}.)`,
    };
  }
  return {
    scoped,
    requested,
    ran: requested.slice(),
    skipped: SAVEPOINT_STAGES.filter((s) => !requested.includes(s)),
  };
}

function cmdSavepoint() {
  const write = flag('--write');
  const stages = resolveSavepointStages();
  /*
   * ⛔ A REFUSED SCOPE WRITES NO RECEIPT. `savepoint-attempt.json` records that a savepoint was
   * ATTEMPTED and how it went; a scope this kernel could not resolve never became an attempt, and
   * overwriting a real earlier receipt with one would erase the blocker set the Stop hook is keyed on.
   */
  if (stages.refusal) {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE,
      error: stages.refusal,
      checks: [result(OUTCOME.CANNOT_DETERMINE, 'savepoint:stages', stages.refusal, { checked: 0, subject: 'the requested stage scope' })],
      /*
       * No `stages` field, deliberately: a refusal resolved no scope, and reporting one with ten
       * entries under `skipped` would describe a partial RUN where there was no run at all. The
       * refusal row says what was wrong and `validStages` says what would have been accepted.
       */
      validStages: SAVEPOINT_STAGES.slice(),
    };
  }
  const runs = (name) => stages.ran.includes(name);
  /** The NOT_APPLICABLE row a stage that did not run leaves in its own place in `checks[]`. */
  const skipRow = (name, extra = {}) => result(OUTCOME.NOT_APPLICABLE, `stage:${name}`,
    `the \`${name}\` stage was SKIPPED BY REQUEST — this savepoint is partial and establishes nothing about ${name}.`
    + `${extra.note ? ` ${extra.note}` : ''} Ran: ${stages.ran.join(', ') || '(nothing)'}.`,
    { subject: `savepoint stage ${name}`, label: 'SKIPPED_BY_REQUEST', skippedByRequest: true, ...(extra.domain ? { domain: extra.domain } : {}) });

  const checks = [];
  const { state, findings, revisions, removalsScan, lineageScan, reconciliation } = stateLib.compile(DIR);
  checks.push(...findings);
  if (runs('writeback')) checks.push(stateWritebackCheck(state, write));
  else checks.push(skipRow('writeback'));
  // Every revision that describes the same source as HEAD — the generated-block check below may treat a
  // revision line naming any of them as equivalent, and nothing outside them.
  const equivalentRevisions = (revisions && revisions.chain) || [];

  // Render, then verify what was rendered. Render-and-trust would reproduce DF-011 with extra steps:
  // the point is not that a generator exists, it is that the OUTPUT is checked against the source.
  const targets = [
    { file: path.join('docs', 'derived', 'CONTINUITY.md'), render: renderContinuityFolded },
    { file: path.join('docs', 'derived', 'GAPS.md'), render: render.renderGaps },
    /*
     * ⛔ THE THIRD TARGET IS FULLY GENERATED, AND THAT IS WHY IT CARRIES `fullyGenerated` RATHER THAN A
     * MIGRATION STORY (P2-O-3). CONTINUITY.md and GAPS.md exist in every project that adopts this kernel
     * as documents somebody wrote by hand, so their first `--write` archives an original and imports its
     * prose (planMigration/planRestore above). LESSONS.md has no hand-authored predecessor anywhere: it
     * is a projection of `memory/graph/**` and `memory/candidates/`, so on a target without one the
     * first `--write` simply CREATES it, there is nothing to archive and nothing `restore-derived` could
     * put back. The flag exists so the loop can SAY that in its own row instead of leaving the operator
     * to infer it from a file appearing.
     */
    {
      file: path.join('docs', 'derived', 'LESSONS.md'),
      fullyGenerated: true,
      // ONE store snapshot for the whole loop (see lessonsPre below): the renderer and the verifier
      // must see the same rows, or `verify` would be checking a document against a store that moved
      // between rendering it and reading it back.
      render: (st, existing) => render.renderLessons(existing, lessonsPre || lessonsStore(st)),
      verify: (text, st, opts) => render.verifyLessons(text, lessonsPre || lessonsStore(st), opts),
      /*
       * ⛔ THIS TARGET'S ROWS ARE `ephemeral`, FOR THE REASON note:budget's ARE. A candidate memory
       * minted from "the register says 0 candidate leads and the store says 2" is a lead ABOUT THE SIZE
       * OF THE LEAD STORE: recording it grows the store, which changes the claim, so the next run mints
       * a different one and the dedup on content digest can never catch it. It is also duplication —
       * the disagreement is already stated in this row and already visible in the register itself. The
       * row keeps its FAIL and its exit code; only the automatic capture is skipped.
       */
      ephemeralRows: true,
    },
  ];
  const migrations = [];
  /*
   * ⛔ THE TWO STAGES SHARE ONE LOOP, AND `wroteDocs` IS THE ONE FACT BOTH READ. `render` owns the
   * migration, the note budget and the WRITE; `verify` owns checking the rendered claims back against
   * the state. So on a `--write` run that skipped `render`, nothing is archived, nothing is rewritten
   * and nothing is deleted — and `verify` then checks WHAT IS ON DISK, which is what it always checks
   * when this run did not write. Every `!write` below became `!wroteDocs` for exactly that reason: the
   * condition always meant "this run did not rewrite these documents", and on a full run the two are
   * the same value.
   */
  const renderRan = runs('render');
  const verifyRan = runs('verify');
  const wroteDocs = write && renderRan;
  // The one memory-store snapshot this run renders and verifies the lessons register against, taken
  // BEFORE the memory stage can capture anything into it. refreshLessonsRegister() compares it against
  // the post-capture store afterwards, which is how "this run's own capture moved the counts" is told
  // apart from "somebody hand-edited the register".
  const lessonsPre = (renderRan || verifyRan) ? lessonsStore(state) : null;
  if (!renderRan) checks.push(skipRow('render', { note: 'Nothing was archived, rendered or written.' }));
  for (const t of (renderRan || verifyRan) ? targets : []) {
    const abs = path.join(DIR, t.file);
    let existing = readText(abs);
    if (existing === null && !write) {
      // BUG-2 / K-02: the file component is normalised to forward slashes at construction, because
      // `t.file` was built with `path.join` and carries the host separator on Windows. Only the id
      // changes here — `t.file` itself stays untouched for every other use in this loop (path.join,
      // path.basename, the detail text below), so nothing but the check id's spelling is affected.
      if (renderRan) checks.push(result(OUTCOME.NOT_APPLICABLE, `render:${removalsLib.posix(t.file)}`, 'not present in this project'));
      continue;
    }

    /*
     * ⛔ CREATION IS ANNOUNCED, NOT INFERRED FROM A FILE APPEARING (P2-O-3). A fully-generated target
     * with nothing on disk is CREATED by this run rather than migrated — the row says so, and says why
     * there is no archive: unlike CONTINUITY.md and GAPS.md there is no hand-authored original, so
     * `restore-derived` has nothing to put back and the absence of an archive is not a missing safeguard.
     */
    if (existing === null && wroteDocs && t.fullyGenerated) {
      checks.push(result(OUTCOME.PASS, `render:${removalsLib.posix(t.file)}`,
        `CREATED by this --write run: ${removalsLib.posix(t.file)} did not exist and is rendered in full from its source, so nothing was archived and nothing was overwritten. It carries no migration or restore story — there is no hand-authored original for \`restore-derived\` to put back, and a later run simply re-renders it.`,
        { checked: 1 }));
    }

    /*
     * Migration BEFORE render, and never silently. A hand-authored doc is archived verbatim and its
     * prose imported into the protected NOTE block; without --write this is a PREVIEW that changes
     * nothing, so nobody discovers the rewrite by finding their file replaced.
     */
    const plan = render.planMigration(existing, path.basename(t.file));
    if (plan.needed) {
      migrations.push({ file: t.file, ...plan, applied: wroteDocs });
      if (wroteDocs) {
        const archiveAbs = path.join(DIR, plan.archiveRel);
        if (!fs.existsSync(archiveAbs)) stateLib.writeAtomic(archiveAbs, existing); // never clobber an earlier archive
        existing = `${render.NOTE_OPEN}\n${plan.note}\n${render.NOTE_CLOSE}\n`; // seed the note the renderer preserves
      } else {
        /*
         * BUG-2 / K-02: same normalisation, same reason — id only, detail text (which never names
         * `t.file`) is unchanged.
         *
         * ⛔ ADR-003 kernel:R16, AND THE HALF OF ITS CELL THAT IS ALREADY TRUE. The `light` cell reads
         * "advise, and auto-migrate". The auto-migration is the branch ABOVE this one and it already
         * happens, in every posture, on `--write`. It is NOT extended to a verify-only run, and that is
         * deliberate rather than an omission: `--verify` never modifies the tree (anti-drift item 4),
         * and a posture is only ever allowed to change which outcome a check returns. So what relaxes
         * here is the outcome of the row a verify-only run prints — the permanent exit 2 the kernel audit's
         * R16 names as the rigidity — while the door out of it stays exactly one `--write` away, which
         * is what the row still says.
         */
        if (renderRan) {
          checks.push(postureRelaxed(result(OUTCOME.CANNOT_DETERMINE, `render:${removalsLib.posix(t.file)}`,
            `hand-authored file not yet migrated — run with --write to archive it to ${plan.archiveRel} and import its prose into the protected NOTE block. Nothing was changed.`, { checked: 0 }),
          KERNEL_POSTURE_ROWS.unmigratedDoc));
        }
        continue; // do not verify claims in prose the kernel does not own yet
      }
    }

    /*
     * ⛔ THE NOTE BUDGET IS ENFORCED OUT LOUD (render.js planNote). A note over budget used to come back
     * from --write cut to 1,200 chars mid-word with no marker, no row, and a PASS. The bounded note is
     * planned here with the same name the renderer uses, so the marker the render writes and the archive
     * this writes name the same file. Archive FIRST: if that write throws, the doc below is never
     * rewritten and the full note stays where it was — the failure mode is "nothing changed", never "the
     * note is gone". Content-addressed name, so an archive that already exists is this same note.
     */
    const notePlan = render.planNote(existing, path.basename(t.file), state);
    if (notePlan.overflow && wroteDocs) {
      const noteArchiveAbs = path.join(DIR, notePlan.archiveRel);
      if (!fs.existsSync(noteArchiveAbs)) stateLib.writeAtomic(noteArchiveAbs, `${notePlan.full}\n`);
    }
    /*
     * ⛔ ADR-003 kernel:R15, AND ITS CELL CARRIES A QUALIFIER THAT IS PART OF THE CELL, NOT A GLOSS.
     * `light` reads `advise`; `standard` reads "advise on --verify"; `strict` denies. So a WRITING
     * savepoint under `standard` still FAILs on an over-budget note: the note was cut and the full text
     * archived, which is a thing that HAPPENED to this tree, and downgrading that to an advisory would
     * report the cut as though it did not matter. A verify-only run has cut nothing yet and previews
     * what `--write` would do, so it advises. `light` advises in both, which is its whole point.
     *
     * The narrowing is spelled here rather than read out of the resolver's `qualifiers` prose, because
     * `verdict()` returns a word and a prose qualifier is not a decision procedure — and
     * kernel/kernel.test.mjs pins the two against each other so they cannot drift apart silently.
     */
    if (renderRan) {
      checks.push(postureRelaxed(render.noteBudgetCheck(notePlan, { file: t.file, write: wroteDocs }),
        KERNEL_POSTURE_ROWS.noteBudget,
        { when: !wroteDocs || (posturePolicy() || {}).profile === 'light' }));
    }

    const fresh = t.render(state, existing);
    if (wroteDocs) { stateLib.writeAtomic(abs, fresh); }
    const text = wroteDocs ? fresh : (existing || fresh);
    if (verifyRan) {
      // A target may bring its own verifier when its numbers do not come from STATE.json — the lessons
      // register's counts are the memory store's rows, so `countMap(state)` could never check them. The
      // PAIR is what is extended, never the render half alone (anti-drift item 7).
      const rows = [t.verify ? t.verify(text, state, { file: t.file }) : render.verifyRendered(text, state, { file: t.file })];
      if (!wroteDocs && existing !== null && !plan.needed) rows.push(render.driftFromGenerated(existing, fresh, t.file, { equivalentRevisions }));
      // `ephemeralRows` (see the target list) marks a row whose automatic capture would be a candidate
      // memory about the candidate store's own size. The verdict is untouched; only the mint is skipped.
      for (const row of rows) checks.push(t.ephemeralRows ? { ...row, ephemeral: true } : row);
    }
  }
  if (!verifyRan) checks.push(skipRow('verify', { note: 'No rendered claim was checked back against its source.' }));

  /*
   * The killed-feature contract runs INSIDE savepoint, not beside it: "regenerate the derived docs and
   * check them" has always been the moment a resurrected feature would surface, and until Scenario L
   * that step was an agent remembering to grep.
   *
   * ⛔ BUG-3, AND THE ONE RUN WHERE SHARING THE SCAN WOULD FORGE A GREEN. `stateLib.compile(DIR)` above
   * already ran `removalsLib.runRemovalScan` once to derive `state.removals`, and `removalsScan` is
   * that same scan's full result — so on a VERIFY-ONLY run these are its per-row checks rather than a
   * second invocation of an identical scan over an identical tree, which is the ~50% of `savepoint
   * --verify` wall time BUG-3 is about.
   *
   * ⛔ BUT A `--write` RUN IS NOT THE SAME TREE. The render loop above has just REGENERATED
   * docs/derived/CONTINUITY.md and docs/derived/GAPS.md, and those sit inside the directories a normal
   * `state.removals.liveContentDirs` names — this pack's own is `["."]`. compile()'s scan ran BEFORE
   * that render, so reusing it on a writing run judges a tree that no longer exists. Measured on a
   * fixture whose only forbidden phrase reaches markdown through the render (a requirement titled after
   * a retired capability, rendered into CONTINUITY.md:35): scanning the pre-render tree returned PASS
   * and exit 0 where the post-render scan returns FAIL and exit 1. A writing savepoint therefore scans
   * the docs it just wrote, exactly as it did before BUG-3 — the saving is real only where the tree
   * genuinely did not move.
   *
   * ⛔ AND A RE-SCAN THAT THROWS IS STILL "COULD NOT RUN", NEVER "FAILED". The row built here is the
   * same shape, id and wording `stateLib.compileRemovals` builds for the identical fault, so the two
   * paths cannot disagree and the verify and write modes report a broken scan the same way — exit 2,
   * not the runner's catch-all FAIL. Rebuilt rather than reusing `removalsScan.checks`, because those
   * describe the PRE-render tree: handing them back after a scan that did not complete would be the
   * stale green this whole block exists to prevent.
   *
   * ⛔ AND `--only` NEVER REINTRODUCES THE SECOND SCAN. The re-scan is keyed on `wroteDocs`, not on
   * `--write`, because what makes the pre-render scan stale is the RENDER having written markdown into
   * a scanned directory — so a `--write` run that skipped `render` wrote nothing, the compiler's scan
   * still describes this tree, and it is reused. Every scope therefore scans at most as often as the
   * full run does, and `savepoint --verify` under any scope still scans exactly once.
   */
  let removalRows = null;
  if (runs('removals')) {
    if (wroteDocs) {
      try { removalRows = removalsLib.runRemovalScan(DIR).checks; }
      catch (e) { removalRows = [result(OUTCOME.CANNOT_DETERMINE, 'removals', `the removal scan could not run: ${e.message}`, { checked: 0 })]; }
    } else {
      removalRows = removalsScan.checks;
    }
  }

  /*
   * ⛔ THE POSTURE IS RESOLVED ONCE, HERE, BEFORE THE FIRST COVERAGE ROW IS PUSHED. `coverageChecks`
   * runs the survey that decides every relaxation (config-and-filesystem only, no scan, no subprocess),
   * so computing it up here rather than at its own push site below costs nothing and gives the removals
   * and reconcile rows the SAME single decision instead of a second consult each. See ADR-003 and
   * kernel/lib/applicability.js's posture-layer header for what may relax and what may not.
   *
   * ⛔ AND IT IS COMPUTED FOR THE STAGES THAT NEED IT, NOT ONLY FOR ITS OWN. The `coverage` STAGE is
   * the pushing of `coverage.checks`; the SURVEY underneath it is what relaxes the removals and
   * reconcile rows and what the `applicability` report is built from. So it is computed whenever any of
   * the three run, and skipped entirely when none do — a scope that asks for none of them gets a null
   * survey and an empty applicability report rather than a fabricated one.
   */
  const needsSurvey = runs('removals') || runs('reconcile') || runs('coverage');
  const coverage = needsSurvey ? applicabilityLib.coverageChecks(DIR, posturePolicy()) : null;

  // Bound rather than spread inline: the registry fence in kernel/kernel.test.mjs derives the exports a
  // production module reads, and a `...handle.member(…)` spread hides the access from that derivation.
  if (removalRows) {
    const removalsRows = applicabilityLib.relaxCoverage(removalRows, coverage.survey);
    checks.push(...removalsRows);
  } else {
    /*
     * ⛔ ANTI-DRIFT ITEM 14, PER STAGE. A tree with a populated `removals.json` whose scan was skipped
     * reports THAT, at NOT_APPLICABLE-by-request — never PASS, and never the silence of a shorter row
     * list. `removals` is never green on a scan that did not happen, and a skip is a scan that did not
     * happen.
     */
    checks.push(skipRow('removals', { note: 'The killed-feature contract was not evaluated: no live-content directory was scanned for a reintroduced retired feature, whatever the registry holds.' }));
  }

  /*
   * ⭐ CLASS D · THE PROVENANCE CONTRACT RUNS INSIDE savepoint, beside the killed-feature scan and for
   * the same reason: "regenerate the derived docs and check them" is the moment a copy that has drifted
   * from its source would surface, and a check that has to be remembered is the one nobody ran on the
   * day it mattered.
   *
   * ⛔ AND IT RE-RUNS ON A WRITING SAVEPOINT, ON THE REMOVALS RULE RATHER THAN THE RECONCILE ONE. The
   * reconciliation is reused unconditionally because its sources are `json`/`adapter`/`requirements` and
   * the render writes only markdown. A lineage TARGET may be markdown — the docs-only archetype's whole
   * shape is a document copied from a template — and a glob target such as `docs/**` matches
   * `docs/derived/CONTINUITY.md`, which the render loop above has just rewritten. Reusing the pre-render
   * scan there would judge a tree that no longer exists, so the writing path pays for a second check.
   * It is cheap in a way the removal scan is not: this reads the DECLARED targets and their sources, not
   * every file in a configured directory.
   *
   * ⛔ AND A RE-CHECK THAT THROWS IS "COULD NOT RUN", NEVER "FAILED". Same shape, id and wording
   * `stateLib.compileLineage` builds for the identical fault, so verify and write cannot report a broken
   * check differently.
   */
  if (runs('lineage')) {
    if (wroteDocs) {
      try { checks.push(...lineageLib.checkLineage(DIR).checks); }
      catch (e) { checks.push(result(OUTCOME.CANNOT_DETERMINE, 'lineage', `the provenance check could not run: ${e.message}`, { checked: 0 })); }
    } else {
      checks.push(...lineageScan.checks);
    }
  } else {
    /*
     * ⛔ ANTI-DRIFT ITEM 14'S RULE, PER STAGE, HERE TOO. A tree with a populated `lineage.json` whose
     * check was skipped reports THAT, at NOT_APPLICABLE-by-request — never PASS, and never the silence
     * of a shorter row list. A marker that was not verified is not a marker that was believed.
     */
    checks.push(skipRow('lineage', { note: 'No declared derivation was verified: no marker was read and no source digest was recomputed, whatever the lineage declaration holds.' }));
  }

  /*
   * ⛔ DF-005 RUNS HERE, NOT ONLY BEHIND ITS OWN VERB. "The harness task list and the project's
   * gap/gate records drift independently, wrong in both directions at once" is not a thing anyone
   * goes looking for — it is a thing that is true for months while every surface reads confidently.
   * A reconciliation that has to be remembered is the one that was not run on the day it mattered,
   * so savepoint runs it whether or not `reconcile` is ever typed.
   *
   * ⛔ BUG-3, SAME FIX AND, UNLIKE REMOVALS, ON EVERY RUN: `reconciliation` here is the exact result
   * `stateLib.compile(DIR)` already produced via `reconcileLib.runReconciliation(dir)` to derive
   * `state.reconciliation` — not a second call, in either mode. The asymmetry with the removals scan
   * just above is not an oversight and is what makes it safe: a reconcile source is declared `json`,
   * `adapter` or `requirements` (`kernel/lib/reconcile.js` `loadSource`), never a markdown document,
   * and the render loop above writes nothing but markdown, so `--write` cannot move a source this
   * comparison reads. The removals scan reads exactly the markdown the render writes, which is why it
   * alone re-runs there.
   */
  if (runs('reconcile')) {
    const reconcileRows = applicabilityLib.relaxCoverage(reconciliation.checks, coverage.survey);
    checks.push(...reconcileRows);
  } else {
    checks.push(skipRow('reconcile', { note: 'The task list and the project\'s own gap/gate records were not compared.' }));
  }

  /*
   * ⛔ THE TWO CONTRACTS NOTHING WAS ASKING ABOUT. `routeSource` and `codeTruth` are read by
   * /savepoint's own drift steps and by no kernel check, so an unset one produced no verdict at all —
   * and the installer's `<set ROUTE_SOURCE>` template made "unset" look answered. A step told to
   * enumerate that literal matches zero routes, finds zero orphans, and reports no drift. This is the
   * only producer of their applicability rows; every other subsystem tags its own. See
   * kernel/lib/applicability.js.
   */
  if (runs('coverage')) checks.push(...coverage.checks);
  else checks.push(skipRow('coverage', { domain: 'coverage', note: 'Which optional contracts this project has decided about was not surveyed.' }));

  if (runs('adapters')) {
    for (const a of (config().adapters || [])) checks.push(runAdapter(a));
  } else {
    checks.push(skipRow('adapters', { note: 'No project validator was invoked, so nothing this project knows about itself was consulted.' }));
  }

  /*
   * ⭐ decision #2 — CANDIDATE-MEMORY CAPTURE, MECHANICAL NOW (DF-001 / DF-008, extended in W5). The
   * pack had two documented memory READERS and no guaranteed writer, so after days of work the store
   * held nothing — and stayed empty even after being hand-seeded, "because hand-patching a symptom
   * leaves the missing writer exactly where it was." Capture used to stop at a PROSE PROMPT
   * (memoryProposals, below); it now also writes real, evidence-backed, unpromoted candidate records
   * via core/memory/candidates.js — so a captured lead exists whether or not anyone reads the prose.
   * Promotion is never automatic; the operator's job (Step 2c of /savepoint) is reviewing
   * `respawnpack memory candidates` and promoting/rejecting/deferring, each an explicit decision.
   */
  const memoryRan = runs('memory');
  const captured = memoryRan ? runCandidateCapture(state, checks) : { available: false, all: [], operatorErrors: [], findings: { byCheck: new Map(), byFile: new Map() } };
  if (memoryRan && !captured.available) {
    checks.push(result(OUTCOME.CANNOT_DETERMINE, 'memory-capture', captured.note, { checked: 0 }));
  } else if (memoryRan) {
    // ADR-003 kernel:R17 rides on `e.rule`, which only the unknown-klass branch sets — see
    // runCandidateCapture(). Every other operator error passes `undefined` and is returned untouched.
    for (const e of captured.operatorErrors) {
      checks.push(postureRelaxed(result(OUTCOME.FAIL, 'memory-capture:operator', e.error, { checked: 0 }), e.rule || null));
    }
  } else {
    /*
     * ⛔ AND AN OPERATOR-SUPPLIED `--candidate` IS NAMED RATHER THAN DROPPED IN SILENCE. It is the one
     * input to this verb that exists only to be written down, so a scope that skips the stage that
     * writes it has discarded something the caller typed — and a discarded input the caller is not told
     * about is the same class of quiet as a skipped check nobody printed.
     */
    const dropped = allValuesOf('--candidate').length;
    checks.push(skipRow('memory', {
      note: 'No candidate memory was captured and no memory entry was proposed.'
        + (dropped ? ` ${dropped} \`--candidate\` argument(s) were supplied to this run and NONE was recorded.` : ''),
    }));
  }

  /*
   * ⭐ THE MEMORY PROPOSAL (DF-001 / DF-008). The pack had two documented memory READERS and no
   * guaranteed writer, so after days of work the store held nothing — and stayed empty even after
   * being hand-seeded, "because hand-patching a symptom leaves the missing writer exactly where it
   * was." DF-008's sharper fix: savepoint must PROPOSE memory writes so capture becomes a DECLINED
   * action rather than an omitted one. An unwritten memory should require someone to say no.
   *
   * The proposal is emitted as structured output here; the /savepoint skill presents it for
   * acceptance. This CLI does not write memory itself — it makes skipping it visible. Each proposal
   * now also carries the `candidateId` of the real record runCandidateCapture() already wrote for it
   * (when core/ is available), so "decline it" and "reject it" can point at the same durable object.
   */
  const proposals = memoryRan ? memoryProposals(state, checks, captured.findings) : [];

  // The lessons register counts the store the stage above just wrote to — see refreshLessonsRegister
  // for why the run that changed it is the run that keeps its projection in step, and for the three
  // conditions that bound the write.
  if (memoryRan && renderRan && lessonsPre && (captured.all || []).length) {
    const t = targets.find((x) => x.fullyGenerated);
    const row = t && refreshLessonsRegister(t, lessonsPre, state, wroteDocs);
    if (row) checks.push(row);
  }

  /*
   * ⛔ THE WAVE-LEDGER FOLD RUNS LAST, AND ONLY OVER A RUN THAT EARNED IT (I-3). It is the one `--write`
   * side effect that DELETES something, so it is gated on the rollup of every other check in this
   * savepoint: a blocked run leaves the ledger exactly where it is and reports that it could not run.
   * See waveLedgerCheck() for the tracked-ness guard that keeps this repository's own ledger safe.
   *
   * ⛔ AND IT BELONGS TO `render`, BECAUSE THE FOLD'S DESTINATION IS THE RENDERED DOCS. It writes one
   * changelog line and the ledger's state into the generated blocks and then deletes the file; a run
   * that did not render has nowhere to put either, so a scope that skipped `render` leaves the ledger
   * exactly where it is and says nothing about it. On a full run `wroteDocs === write`, so this call is
   * unchanged.
   */
  const ledgerRow = renderRan ? waveLedgerCheck({ write: wroteDocs, settled: rollup(checks) }) : null;
  if (ledgerRow) checks.push(ledgerRow);

  /*
   * ⛔ TWO VERDICTS, BECAUSE ONE ANSWERED TWO QUESTIONS AND THEREFORE ANSWERED NEITHER.
   *
   * A Claude Code dogfood installed the pack on a fresh repository and got a single flat
   * CANNOT_DETERMINE. It was true: nothing had been declared, so several checks could not run. It was
   * also unreadable — indistinguishable from a repository whose generator was broken, whose writeback
   * disagreed, or whose declared scan was pointed at nothing. The recommended repairs on offer were to
   * normalize CANNOT_DETERMINE into a healthy terminal state, or to relax the zero-work guards until
   * something went green. Both are the defect this kernel exists to refuse.
   *
   *   INTEGRITY  did the machinery work — compilation, the verified writeback, the rendered claims, the
   *              adapters, and every check whose subject this project HAS declared?
   *   COVERAGE   which optional contracts are configured, which are declared not applicable, and which
   *              is nobody has decided about yet?
   *
   * ⛔ AND THE PROCESS EXIT IS STILL THE WORSE OF THE TWO. Splitting the REPORT is the fix; splitting
   * the exit code would be the manufactured green, one indirection further out. A structurally healthy
   * repository with unresolved contracts now says exactly that instead of reading as broken — and it
   * still does not exit 0, because it is still not release-ready. `outcome` remains rollup(checks) by
   * construction, so no consumer of the old field can disagree with the new pair (release invariant 2).
   */
  const integrityChecks = checks.filter((c) => c.domain !== 'coverage');
  const coverageChecks = checks.filter((c) => c.domain === 'coverage');
  const verdicts = { integrity: rollup(integrityChecks), coverage: rollup(coverageChecks) };
  const outcome = rollup(checks);
  recordSavepointAttempt(outcome, checks, revisions, stages);
  return {
    outcome, verdicts, checks, applicability: coverage ? coverage.survey.rows : [],
    stages: { requested: stages.requested, ran: stages.ran, skipped: stages.skipped },
    revisions: revisions ? { head: revisions.head, sourceRevision: state.sourceRevision, savepointOnlyCommits: revisions.savepointOnly.length, detail: revisions.detail } : null,
    onboardingComplete: coverage ? coverage.survey.onboardingComplete : null, unresolved: coverage ? coverage.survey.unresolved : [],
    memoryProposals: proposals, migrations, wrote: wroteDocs ? targets.map((t) => t.file) : [],
    capturedCandidates: captured.available ? captured.all : [],
  };
}

/*
 * ⛔ "ATTEMPTED AND BLOCKED" HAD NO WAY TO BE RECORDED, SO IT LOOKED IDENTICAL TO "NEVER TRIED".
 *
 * the 2026-08-07 field run §4: the Stop hook fires "run /savepoint", savepoint exits 2, and the hook fires again on
 * the next turn because the tree is still changing — which in a long session it does constantly. The
 * hook's own escape hatch ("if the savepoint is already done, stop again") is keyed on an unchanged
 * delta fingerprint, and in an eight-hour session the delta is never unchanged for long. So the loop
 * guard was real and never got to apply, and the operator was told to run a command that could not
 * succeed, once per turn, indefinitely.
 *
 * This is the missing half: savepoint leaves a receipt EVERY run, including — especially — the runs it
 * could not complete. The receipt records WHICH checks blocked it, not merely that something did,
 * because that is what decides whether a later nag is new information. Fixing one blocker changes the
 * digest and re-arms the hook; another turn of unrelated file churn does not.
 *
 * ⛔ IT IS A RECEIPT, NOT A PASS. Nothing here suppresses the non-zero exit, alters an outcome, or lets
 * a blocked savepoint be reported as a successful one. The only thing it changes is whether the SAME
 * unactionable instruction is repeated on the next turn.
 *
 * ⭐ AND IT NAMES THE SOURCE IT VERIFIED. `sourceRevision` is the revision the compiled state was bound
 * to and `head` is where the run happened. The Stop hook reads the first: once a savepoint has PASSED
 * against a source and the only thing that has moved since is the commit of its own output, the
 * closeout is done, and asking for it again ("HEAD moved W→S") was the defect observed on 2026-08-23.
 * An older receipt without the field simply never qualifies — the nag is the conservative default.
 */
const SAVEPOINT_ATTEMPT_REL = path.join('.respawnpack', 'runtime', 'savepoint-attempt.json');

function recordSavepointAttempt(outcome, checks, revisions, stages) {
  try {
    /*
     * ⛔ A PARTIAL RUN OFFERS NO `sourceRevision`, AND THAT IS THE WHOLE SAFETY OF `--skip`.
     *
     * `hooks/stop-savepoint.js:179` reads exactly two fields to decide the closeout is DONE and go
     * quiet: `exitCode === 0` and a `sourceRevision` inside HEAD's savepoint-only chain. A scoped run
     * can legitimately exit 0 having checked two stages out of ten, so if it published that pair it
     * would retire the nag for a savepoint that never happened — `--skip` forging a green one layer
     * out, in the one reader that acts on this file.
     *
     * So the CLAIM is withheld, not caveated: the same discipline `stateFreshness` applies to counts
     * (anti-drift item 5). Nothing is hidden — `stages` beside it records exactly what ran and what did
     * not, `head` still records where the run happened, and the schema already says a receipt with no
     * `sourceRevision` simply never qualifies, so the nag stays on by default. The reader needs no edit.
     */
    const partial = Boolean(stages && stages.skipped.length);

    /*
     * `label` rides along ONLY when the emitting row has one (K-09, additive). It is the subsystem's own
     * richer word — NOT_CONFIGURED, COULD_NOT_RUN — and carrying it means an advisory can name a blocker
     * the way the subsystem named it instead of flattening every non-pass to the shared outcome. It
     * changes nothing else: `blockerDigest` below is keyed on `check|outcome` alone, so a label can never
     * re-arm the Stop hook, and hooks/stop-savepoint.js — the receipt's only reader — reads neither.
     */
    const blockers = checks
      .filter((c) => c.outcome === OUTCOME.FAIL || c.outcome === OUTCOME.CANNOT_DETERMINE)
      .map((c) => ({
        check: c.check,
        outcome: c.outcome,
        detail: String(c.detail || '').slice(0, 300),
        ...(c.label ? { label: String(c.label) } : {}),
      }));
    const digest = crypto.createHash('sha256')
      .update(blockers.map((b) => `${b.check}|${b.outcome}`).sort().join('\n'))
      .digest('hex').slice(0, 32);
    stateLib.writeAtomic(path.join(DIR, SAVEPOINT_ATTEMPT_REL), `${JSON.stringify({
      at: new Date().toISOString(),
      sessionId: process.env.CLAUDE_SESSION_ID || null,
      outcome,
      exitCode: outcome === OUTCOME.PASS || outcome === OUTCOME.NOT_APPLICABLE ? 0 : outcome === OUTCOME.FAIL ? 1 : 2,
      blockerDigest: digest,
      blockers,
      stages: stages ? { requested: stages.requested, ran: stages.ran, skipped: stages.skipped } : undefined,
      sourceRevision: partial ? null : ((revisions && revisions.effective) || null),
      head: (revisions && revisions.head) || null,
    }, null, 2)}\n`);
  } catch { /* a receipt that cannot be written must never fail the savepoint it is describing */ }
}

function memoryProposals(state, checks, captured) {
  const byCheck = (captured && captured.byCheck) || new Map();
  const byFile = (captured && captured.byFile) || new Map();
  const out = [];
  for (const c of checks) {
    if (c.outcome !== OUTCOME.FAIL) continue;
    out.push({
      type: 'gotcha',
      symptom: c.detail,
      check: c.check,
      rootCause: null,          // ← filled by the session; a proposal with a null root cause is a prompt, not a record
      failedApproach: null,
      workingApproach: null,
      applicability: `project ${path.basename(DIR)} at revision ${String(state.sourceRevision).slice(0, 7)}`,
      evidencePath: stateLib.STATE_FILE,
      revision: state.sourceRevision,
      candidateId: byCheck.get(c) || null,
    });
  }
  for (const r of (state.evidence && state.evidence.rejected) || []) {
    if (!r.reason.startsWith('stale revision')) continue;
    out.push({
      type: 'gotcha', symptom: `evidence ${r.file} stopped counting: ${r.reason}`,
      rootCause: 'evidence is revision-bound; the source moved',
      workingApproach: 're-run the qualifying battery at the current revision',
      applicability: 'any revision-bound evidence artifact', evidencePath: `${stateLib.STATE_DIR}/evidence/${r.file}`,
      revision: state.sourceRevision,
      candidateId: byFile.get(r.file) || null,
    });
  }
  return out;
}

/*
 * `removals` — the killed-feature contract as its own verb (Scenario L).
 *
 * It exists separately from `savepoint` because the two answer different questions and one of them is
 * cheap: "has anything reintroduced a retired feature" is worth running on a diff, in CI, or before a
 * merge, without regenerating and verifying every derived document. The VERDICT is identical either way
 * — both call `runRemovalScan` — which is the point: boot, savepoint and this verb cannot disagree.
 */
function cmdRemovals() {
  const scan = removalsLib.runRemovalScan(DIR);
  return {
    outcome: scan.outcome,
    checks: scan.checks,
    rows: scan.rows,
    // `alwaysExcluded` is reported because coverage nobody mentions reads as coverage that happened —
    // these are dropped at every depth regardless of config, so the boundary stays inspectable.
    scanned: {
      directories: scan.cfg.liveContentDirs,
      extensions: scan.cfg.extensions,
      files: scan.corpus.files.length,
      alwaysExcluded: [...removalsLib.VENDOR_DIR_NAMES],
    },
    notScanned: scan.corpus.skipped,
    unreadable: scan.corpus.unreadable,
  };
}

/*
 * The provenance declaration's path, as a REPORT STRING — forward slashes, never path.join, the same
 * rule DOCTOR_SUBJECT follows and for the same reason (BUG-4 was a doctor row that mixed separators on
 * Windows because it composed one from a joined path). `kernel/lib/lineage.js` owns where the file
 * actually is; this is what a reader is shown.
 */
const LINEAGE_DECLARATION = 'docs/derived/state/lineage.json';

/*
 * `lineage` — the provenance report (Class D).
 *
 * ⛔ IT REPORTS, IT DOES NOT WRITE. Reading the declaration and verifying the markers is all this verb
 * does in P2-P-1: `lineage seed` (P2-P-2) proposes the sources a repository already has and `lineage
 * stamp` (P2-P-3) writes a marker, and both are separate tasks precisely so a reporting verb cannot
 * quietly acquire a writing mode. The exit code is the rollup of the same rows the savepoint stage
 * pushes, so the verb and the stage can never disagree about the same tree.
 */
function cmdLineage() {
  // `lineage seed` and `lineage stamp` are separate modes, the way `contract`'s and `memory`'s sub-verbs
  // are: read before any branch decides anything, positional and never confused with a flag.
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  if (sub === 'seed') return cmdLineageSeed();
  if (sub === 'stamp') return cmdLineageStamp(argv[2] && !argv[2].startsWith('--') ? argv[2] : null);
  if (sub) return { outcome: OUTCOME.FAIL, error: `unknown "lineage" mode "${sub}" — expected seed, stamp, or no mode for the provenance report` };

  const scan = lineageLib.checkLineage(DIR);
  const doc = (scan.read && scan.read.doc) || null;
  return {
    outcome: scan.outcome,
    checks: scan.checks,
    declaration: { path: LINEAGE_DECLARATION, status: scan.read.status, detail: scan.read.detail },
    counts: scan.block.counts,
    // The declared inventory, so a reader can see WHAT was checked rather than only how it went. The
    // markers and digests stay in the rows: this is the contract, not the evidence.
    sources: doc ? doc.sources.map((s) => ({ id: s.id, kind: s.kind, at: s.path || s.url })) : [],
    derivations: doc ? doc.derivations.map((d) => ({ id: d.id, target: d.target, from: d.from, how: d.how, neverFrom: d.neverFrom || [], required: d.required === true })) : [],
  };
}

/*
 * `lineage seed` — propose the sources a repository already has (P2-P-2). This is detection, never
 * inference into a verdict: kernel/lib/lineage.js's `seed()` walks the tree for evidence files and
 * returns a proposal that is always a valid `docs/derived/state/lineage.json` document with
 * `derivations: []` — which file derives from which is the founder's own knowledge, and nothing here
 * guesses it.
 */
function cmdLineageSeed() {
  const { proposal, evidence } = lineageLib.seed(DIR);
  const count = proposal.sources.length;

  if (!count) {
    return {
      outcome: OUTCOME.PASS, mode: 'seed', proposal, evidence, count: 0, wrote: null,
      note: 'nothing at this project\'s root or one level down matches a known provenance evidence file '
        + '(a Terraform root, ansible.cfg or an inventory file, a compose file, kustomization.yaml, Pulumi.yaml, '
        + 'an OpenAPI/Swagger document, a Prisma or SQL schema, or package.json) — there is nothing to propose'
        + `${flag('--write') ? ', so --write wrote nothing' : ''}.`,
    };
  }

  if (flag('--write')) {
    /*
     * ⛔ "NO LINEAGE FILE EXISTS" MEANS EXACTLY WHAT readLineage's ABSENT MEANS, NOT "IS EMPTY" OR "IS
     * VALID". A file this pack cannot parse, or one declaring a schemaVersion it does not implement, is
     * still a founder's own file sitting at that path — overwriting it with a proposal because this
     * pack could not read it is the same mistake as any other tool that treats "I could not read yours"
     * as permission to write its own. Only ABSENT — no file at all — clears the way.
     */
    const read = lineageLib.readLineage(DIR);
    if (read.status !== 'ABSENT') {
      return {
        outcome: OUTCOME.CANNOT_DETERMINE, mode: 'seed', proposal, evidence, count, wrote: null,
        error: `${LINEAGE_DECLARATION} already exists (${read.status}) — refusing to overwrite a founder's own declaration with a `
          + 'proposal. Remove it first, or merge this proposal into it by hand.',
      };
    }
    const abs = path.join(DIR, ...LINEAGE_DECLARATION.split('/'));
    stateLib.writeAtomic(abs, `${JSON.stringify(proposal, null, 2)}\n`);
    return { outcome: OUTCOME.PASS, mode: 'seed', proposal, evidence, count, wrote: LINEAGE_DECLARATION };
  }

  return { outcome: OUTCOME.PASS, mode: 'seed', proposal, evidence, count, wrote: null };
}

/*
 * `lineage stamp` — write the provenance marker (P2-P-3). The one writing mode of this verb that touches
 * a file OTHER than the declaration itself: the target the founder or the builder just cloned, copied,
 * migrated or generated. The CLI-argument checks below (a target given at all, `--from` given at all) are
 * usage errors and stay FAIL like every other verb's missing-required-flag refusal
 * (`cmdMemoryCandidatesPromote`'s `--as`/`--verified-by` is the precedent); the semantic refusals — an
 * unknown source, a `neverFrom` source, a target outside the project or absent — are
 * `kernel/lib/lineage.js`'s own job, because they are verdicts about THIS tree, not about how the command
 * was typed, and its `stamp()` already carries the CANNOT_DETERMINE/FAIL split that a top-level `error`
 * string cannot.
 */
function cmdLineageStamp(target) {
  if (!target) return { outcome: OUTCOME.FAIL, mode: 'stamp', error: 'stamp requires a target: lineage stamp <target> --from <sourceId> [--sidecar]' };
  const from = valueOf('--from', null);
  if (!from) return { outcome: OUTCOME.FAIL, mode: 'stamp', error: 'stamp requires --from <sourceId> — the declared source this file was derived from' };
  const r = lineageLib.stamp(DIR, { target, from, sidecar: flag('--sidecar') });
  return { mode: 'stamp', ...r };
}

/*
 * `aar` — the After Action Report (Class C: output shaped for a human's attention).
 *
 * ⛔ IT COMPOSES FROM RECORDS AND DECIDES NOTHING. Every section of the report is copied out of
 * something the pack already wrote down: the compiled state at each end of the window, the commits,
 * the derived changelog, the savepoint receipt, the candidate journal, the delegation archive. The
 * composition rules — counts WITHHELD when a state was not current for its own revision, a candidate
 * shown as an unverified lead, an unreadable input surfacing as an owner action inside the report —
 * live in kernel/lib/aar.js, so the verb and the goal-completion trigger cannot end up with two ideas
 * of what a report says.
 *
 * ⛔ AND PREVIEW IS THE DEFAULT, LIKE EVERY OTHER WRITE IN THIS KERNEL. Without `--write` the document
 * is printed and nothing is created. With it, an existing report at the same path is a REFUSAL naming
 * the file at exit 2, never an overwrite: a report is a record of what was known at a moment, and
 * regenerating one in place would replace a human's note and a colleague's citation with a second
 * opinion about the same window.
 */
function cmdAar() {
  return aarLib.compose(DIR, {
    since: valueOf('--since', null),
    until: valueOf('--until', null),
    title: valueOf('--title', null),
    write: flag('--write'),
  });
}

/*
 * `restore-derived` — the way back out of the migration, which is what makes the way in usable.
 *
 * ⛔ THE DEFECT THIS CLOSES IS NOT A BUG, IT IS AN UNTAKEN ACTION. the 2026-08-07 field run §1: `savepoint --verify`
 * could never return 0 in that project, because two of its checks were waiting on a migration that
 * archives CONTINUITY.md/GAPS.md and rewrites them. That is "not something an agent should do unprompted
 * at session end, so it never happens, so exit 2 persists forever." The migration was already safe —
 * verbatim archive, never clobbered, idempotent — but nothing could state that safety in the only
 * currency that convinces anyone: an undo.
 *
 * ⛔ PREVIEW BY DEFAULT, LIKE EVERY OTHER WRITE IN THIS KERNEL. Bare `restore-derived <file>` reports
 * what WOULD be replaced and with how many bytes; `--write` performs it. Without that split this verb
 * would be a second one-way door pointed the other way.
 *
 * ⛔ AND THE ARCHIVE SURVIVES A RESTORE. archive-never-delete is not a rule about migrations, it is a
 * rule about archives — so restoring leaves docs/derived/_archive/<name>.pre-kernel.md exactly where it
 * is. A restore followed by a re-migration finds the same original still sitting there, which is the
 * property that makes both directions repeatable rather than a single undo charge.
 */
const RESTORABLE = new Map([
  ['CONTINUITY.md', path.join('docs', 'derived', 'CONTINUITY.md')],
  ['GAPS.md', path.join('docs', 'derived', 'GAPS.md')],
]);

function cmdRestoreDerived() {
  const asked = argv[1] && !argv[1].startsWith('--') ? path.basename(argv[1]) : null;
  const write = flag('--write');

  if (!asked || !RESTORABLE.has(asked)) {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE,
      error: `name the derived doc to restore — one of ${[...RESTORABLE.keys()].join(', ')}. ` +
        'Usage: restore-derived CONTINUITY.md [--write]',
      restorable: [...RESTORABLE.keys()],
    };
  }

  const rel = RESTORABLE.get(asked);
  const abs = path.join(DIR, rel);
  const plan = render.planRestore(asked, null, null); // for archiveRel only — the read happens next
  const archiveAbs = path.join(DIR, plan.archiveRel);
  const real = render.planRestore(asked, readText(archiveAbs), readText(abs));

  if (!real.possible) {
    return { outcome: OUTCOME.CANNOT_DETERMINE, file: rel, archive: real.archiveRel, error: real.reason };
  }

  if (!write) {
    return {
      outcome: OUTCOME.PASS, file: rel, archive: real.archiveRel, applied: false,
      detail: `PREVIEW ONLY — nothing was written. \`restore-derived ${asked} --write\` would replace ` +
        `${rel} (${real.replacedBytes} bytes) with the archived original (${real.restoredBytes} bytes). ` +
        real.note,
      wouldRestoreBytes: real.restoredBytes, wouldReplaceBytes: real.replacedBytes,
    };
  }

  stateLib.writeAtomic(abs, real.text);
  return {
    outcome: OUTCOME.PASS, file: rel, archive: real.archiveRel, applied: true,
    detail: `restored ${rel} from ${real.archiveRel} (${real.restoredBytes} bytes, replacing ${real.replacedBytes}). ` +
      'The archive was NOT deleted — re-running savepoint --verify --write will migrate it again from the same original.',
    restoredBytes: real.restoredBytes, replacedBytes: real.replacedBytes,
  };
}

/*
 * `living` — the living-skill lifecycle, for the canaries that have one (owner decision OD-1).
 *
 * ⛔ OPT-IN, AND ONLY THREE. A default install activates nothing: `living status` on a fresh target
 * reports every canary as a STATIC skill, which is a complete supported state rather than a missing
 * feature. The claim is narrowed to exactly `debug`, `savepoint` and `knowledge` because those are the
 * ones the lifecycle is proven on — the alternative was manufacturing twenty baselines to make a
 * sentence true, which the owner refused and which would have been the same overclaim with more files.
 */
function cmdLiving() {
  const sub = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'status';
  const name = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
  const targets = name ? [name] : livingLib.CANARIES;

  if (sub === 'status') {
    /*
     * ⛔ HONOUR THE ARGUMENT THE HELP TEXT ADVERTISES. `living [status|enable|regenerate|reset] [<skill>]`
     * promises a per-skill form, and `enable`/`regenerate`/`reset` all honour theirs — `status` silently
     * ignored it and surveyed all three canaries, so `living status knowledge` answered about `debug` too.
     * A command that quietly widens its own scope is a small version of the same failure as a check that
     * reports on something other than what it was asked about.
     */
    // `survey()` spreads `{ name }` over the result, so the row's `name` is the bare canary name — the
    // status object's own `living:<n>` label is overwritten by it. Matching the wrong one filtered
    // everything away and left `checks[0]` undefined, which three fixtures caught immediately.
    const rows = livingLib.survey(DIR).filter((r) => !name || r.name === name);
    if (name && !rows.length) {
      return { outcome: OUTCOME.FAIL, error: `"${name}" is not one of the living-skill canaries (${livingLib.CANARIES.join(', ')})` };
    }
    return { outcome: rollup(rows), checks: rows, canaries: livingLib.CANARIES };
  }
  if (!name && sub !== 'regenerate') {
    return { outcome: OUTCOME.FAIL, error: `living ${sub} needs a skill name — one of ${livingLib.CANARIES.join(', ')}` };
  }
  const run = (n) => (sub === 'enable' ? livingLib.enable(DIR, n)
    : sub === 'reset' ? livingLib.reset(DIR, n)
      : sub === 'regenerate' ? livingLib.regenerate(DIR, n, { write: flag('--write') })
        : null);
  const checks = targets.map(run).filter(Boolean);
  if (!checks.length) return { outcome: OUTCOME.FAIL, error: `unknown living subcommand "${sub}" — expected status | enable | regenerate | reset` };
  return { outcome: rollup(checks), checks, canaries: livingLib.CANARIES };
}

/*
 * ⛔ FRESHNESS IS CONTENT-BOUND, AND EVERY READER OWES THE SAME CHECK.
 *
 * Phase 2d replaced revision-only currency with `sourceManifest` digests because a revision match says
 * nothing about UNCOMMITTED edits to the compiler's inputs. The SessionStart hook adopted it. These two
 * verbs did not: `doctor` compared `sourceRevision === HEAD` and printed `CURRENT`, and `status` read
 * STATE.json raw and returned PASS unconditionally — so with a modified requirements.json the hook said
 * "STALE — WITHHELD" and, in the same tree, `status` printed counts as fact and `doctor` said PASS.
 * That is DF-011's shape (a stale count presented as current) inside the layer built to end it, and it
 * is exactly what the durability boundary warns about: asserting on the writer and the reader
 * separately proves neither. One helper now, used by both, so a third reader cannot drift alone.
 */
function stateFreshness(state) {
  if (!state) return { fresh: false, label: 'ABSENT', detail: 'no STATE.json' };
  if (!manifestLib) {
    // Which kind of broken, not just "missing": the projection is equally undeterminable whether the
    // module is absent, unparseable, throwing at load, or exporting the wrong API — but the reader
    // fixing it needs to know which. What must never happen is CURRENT. Checked FIRST now, because the
    // revision comparison below is the shared module's too: without it there is no equivalence class,
    // only a literal HEAD, and a literal HEAD is the savepoint-lag false STALE this file used to emit.
    return { fresh: false, label: 'CANNOT_DETERMINE', detail: `hooks/_manifest.js: ${manifestHealth.detail} — the content digests that decide freshness cannot be computed` };
  }
  /*
   * ⛔ THE REVISION CHECK IS CHAIN MEMBERSHIP, NOT EQUALITY. `sourceRevision === HEAD` called the state
   * STALE at every boot after the documented closeout committed the derived docs on top of the work it
   * described (see hooks/_manifest.js sourceRevisions). CURRENT-by-revision means HEAD reaches the
   * bound revision through savepoint-only commits and nothing else; any other HEAD is STALE as before.
   */
  const revs = manifestLib.sourceRevisions(DIR);
  if (!revs.head || !state.sourceRevision) return { fresh: false, label: 'CANNOT_DETERMINE', detail: 'no revision to compare against' };
  if (!revs.chain.includes(state.sourceRevision)) {
    return { fresh: false, label: 'STALE', detail: `built at ${String(state.sourceRevision).slice(0, 7)}, source is now ${String(revs.effective).slice(0, 7)}${revs.head !== revs.effective ? ` (HEAD ${String(revs.head).slice(0, 7)})` : ''} — regenerate` };
  }
  const m = manifestLib.compareManifest(state.sourceManifest, DIR);
  if (m.status !== 'CURRENT') return { fresh: false, label: m.status, detail: m.detail };
  const lag = revs.head !== state.sourceRevision
    ? ` — HEAD ${String(revs.head).slice(0, 7)} differs from it only by ${revs.savepointOnly.length} savepoint-only commit${revs.savepointOnly.length === 1 ? '' : 's'}`
    : '';
  return { fresh: true, label: 'CURRENT', detail: `current at ${String(state.sourceRevision).slice(0, 7)}${lag}` };
}

function cmdStatus() {
  const state = stateLib.read(DIR) || stateLib.compile(DIR).state;
  const fresh = stateFreshness(state);
  const c = state.counts || {};
  const lines = [];
  lines.push(`RespawnPack status — ${path.basename(DIR)} @ ${String(state.sourceRevision || 'unknown').slice(0, 7)}`);
  if (state.goal) lines.push(`  goal      : ${state.goal} ${state.goalComplete ? '(complete)' : '(in progress)'}`);
  if (state.milestone) lines.push(`  milestone : ${state.milestone} ${state.milestoneComplete ? '(complete)' : '(in progress)'}`);
  // Withheld, not caveated — the same choice the SessionStart hook makes, for the same reason: a number
  // printed beside a warning is still a number the next reader quotes.
  if (!fresh.fresh) {
    lines.push(`  ⚠️ state  : ${fresh.label} — ${fresh.detail}`);
    lines.push('  rows      : WITHHELD · blocked: WITHHELD · next: WITHHELD');
    lines.push('  Regenerate with `savepoint` (or `state compile`), then re-run status.');
    return { outcome: OUTCOME.CANNOT_DETERMINE, text: lines.join('\n'), state };
  }
  if (state.tracksRequirements) {
    lines.push(`  rows      : ${c.conformant}/${c.mandatory} mandatory conformant · ${c.candidate} candidate · ${c.unevidenced} unevidenced · ${c.waived} waived`);
    lines.push(`  blocked   : ${c.blocked} (project blocked: ${state.projectBlocked ? 'yes' : 'no'})`);
    lines.push(`  next      : ${(state.nextUnblockedWork || []).slice(0, 3).map((n) => n.id).join(', ') || '—'}`);
  } else {
    lines.push('  rows      : this project tracks no requirement denominator');
  }
  if ((state.cannotDetermine || []).length) lines.push(`  unknown   : ${state.cannotDetermine.join('; ')}`);
  return { outcome: OUTCOME.PASS, text: lines.join('\n'), state };
}

/*
 * `doctor` — what is installed, configured, unsupported, stale, or SILENTLY INACTIVE.
 *
 * The last category is the one that matters and the reason this verb exists: this pack has repeatedly
 * shipped things that were present and inert. A PreCompact hook wired correctly and speaking on a
 * channel that does not exist. A memory store with readers and no writer. "Files were copied" is not
 * "the feature is active", and nothing until now could tell the difference.
 */

/*
 * ⛔ THE ONE MAPPING TABLE, REPLACING DOCTOR'S PRIVATE `GREEN` SET (K-09, anti-drift item 1).
 *
 * Doctor spoke a twelve-word vocabulary and collapsed it into an exit code through a hardcoded allowlist
 * of "green" words — a SECOND place in the pack where a verdict became an exit, beside `exitCodeFor`.
 * Two maps for one meaning agree only for as long as somebody keeps them agreeing, and the day they
 * stop, "I could not tell" is read as "fine". So every row is now an `outcome.js` `result()` row, the
 * rollup is `rollup(rows)` like every other verb, and the twelve words survive as `label` — the richer
 * diagnostic word, which is the whole reason doctor grew a private vocabulary. Nothing routes an exit
 * code through a label.
 *
 * ⛔ AND THE TABLE IS AN ALLOWLIST, FOR EXACTLY THE REASON THE `GREEN` SET WAS ONE. A denylist greens
 * every word nobody remembered: `state:STATE.json UNKNOWN` — freshness could not be established AT ALL —
 * used to fall through to PASS at exit 0. Inverted here too: a word absent from this table is
 * CANNOT_DETERMINE, so the next word someone adds is "not established" until it is deliberately
 * classified. SILENTLY INACTIVE, STALE, UNKNOWN, INCOMPLETE, UNDECIDED and INVALID are all absent on
 * purpose, and each keeps the exit 2 it already had.
 *
 * ⛔ NOT_CONFIGURED, NOT_APPLICABLE AND UNSUPPORTED ARE `NOT_APPLICABLE`, NOT `PASS`. All three were
 * green before and all three stay green (`exitCodeFor` gives NOT_APPLICABLE the same 0 PASS has), but
 * none of them is a claim that something WORKS: "nothing is set up here", "this project declared it has
 * no subject", and "a declared source kind this kernel cannot examine" each mean the check had no
 * subject, which is precisely what NOT_APPLICABLE says. Calling them PASS would let a report whose every
 * row found nothing to look at roll up as an affirmative all-clear.
 *
 * ⛔ UNSUPPORTED IS THE ONE WORD WHERE THIS TABLE AND the kernel audit §2.2's LIST DISAGREE, AND THE EXIT CODE
 * WINS. §2.2 spells the fallthrough "everything else → CANNOT_DETERMINE", which would move UNSUPPORTED
 * from exit 0 to exit 2 — a real behaviour change on any target whose worst row is an unsupported
 * adapter or removals scan, and this task's contract is that no exit code moves. It stays green for the
 * reason the `GREEN` set gave: it is an INVENTORY fact about something declared and not examinable here,
 * and the adapter's own verdict is separately CANNOT_DETERMINE where it counts (the gate). Whether that
 * is the RIGHT verdict is a question about doctor's semantics, not about the vocabulary, and moving it
 * belongs to a task that says so.
 */
const DOCTOR_OUTCOME = {
  ACTIVE: OUTCOME.PASS,
  CONFIGURED: OUTCOME.PASS,
  CURRENT: OUTCOME.PASS,
  COMPLETE: OUTCOME.PASS,
  INSTALLED: OUTCOME.PASS,
  NOT_CONFIGURED: OUTCOME.NOT_APPLICABLE,
  NOT_APPLICABLE: OUTCOME.NOT_APPLICABLE,
  UNSUPPORTED: OUTCOME.NOT_APPLICABLE,
  BROKEN: OUTCOME.FAIL,
};

/*
 * WHICH QUESTION EACH DOCTOR ROW ANSWERS — `domain`, from outcome.js's four.
 *
 * Most of doctor is `install`: what the installer placed, and whether the target still carries it. Two
 * kinds of row are not, and mislabelling them would file them under a heading nothing reads:
 *   integrity  `state:STATE.json` — the projection against the source it was compiled from
 *   coverage   the DECISION rows — has anybody answered whether this contract applies to this project
 *              (`onboarding*`, `posture`, `state:requirements`, `state:evidence`, `removals:contract`,
 *              `lineage`,
 *              `reconcile:tasks`). The same question `applicability.js` tags `coverage` in savepoint.
 * A whole-id match is tried before the family, so `state:STATE.json` reaches `integrity` while its
 * `state:` siblings reach `coverage`, and `onboarding:<subsystem>` inherits `onboarding`'s answer.
 */
const DOCTOR_DOMAIN = {
  'state:STATE.json': 'integrity',
  'state:requirements': 'coverage',
  'state:evidence': 'coverage',
  'removals:contract': 'coverage',
  /*
   * `lineage` is a coverage row — "has anybody declared where this project's copies come from" — even
   * though owner decision 22 keeps it OUT of the applicability survey that decides onboarding. The two
   * are different questions: `domain` says which heading a reader should file the row under, and
   * `applicability.js` decides whether an undecided contract blocks release readiness. Filing it under
   * `install` would put a declaration question beside "what the installer placed", which is the one
   * thing it is not about.
   */
  lineage: 'coverage',
  'reconcile:tasks': 'coverage',
  onboarding: 'coverage',
  posture: 'coverage',
  exceptions: 'coverage',
  // P2-I-3: a declared-or-not fact about the project, the same class as posture and exceptions above —
  // `subagents` is deliberately NOT here. It has no declare-or-not state (a ceiling always applies) and
  // reads ACTIVE/BROKEN like a hook row, so it falls through to the 'install' default beneath it.
  projectType: 'coverage',
  // P2-Q-2: the readiness checklist asks the project's OWN quality question, the same one `gate` asks
  // one layer down, so it is a `gate` row and not a coverage one. Coverage is "has anybody DECIDED
  // whether this contract applies here"; this row is "how many of the items that do apply are met".
  readiness: 'gate',
};
const doctorDomain = (component) => DOCTOR_DOMAIN[component]
  ?? DOCTOR_DOMAIN[component.split(':')[0]]
  ?? 'install';

/*
 * WHAT EACH DOCTOR ROW LOOKED AT — `subject`, the project-relative path or declaration behind the id.
 *
 * ⛔ AND IT IS A PATH, NOT A RESTATEMENT OF THE ID. The obvious default — the identifier's parameter —
 * would give `state:requirements` the subject `requirements`, which tells a reader nothing the id did
 * not already say and dresses a fragment up as a fact. So the file families resolve to where the file
 * actually is (`hook:index-guard.js` to `.claude/hooks/index-guard.js`) and the decision rows resolve
 * to the declaration that decides them, which for every one of them is `respawnpack.config.json`.
 *
 * Spelled with forward slashes throughout, never path.join: these are report strings, and BUG-4 was a
 * doctor row that mixed `\` and `/` on Windows because it composed one from a joined path.
 */
const DOCTOR_SUBJECT_PREFIX = {
  hook: '.claude/hooks/',
  'hook-lib': '.claude/hooks/',
  'kernel-lib': '.claude/respawnpack/lib/',
  onboarding: null, // → the declaration below, not a path
};
const DOCTOR_SUBJECT = {
  'state:requirements': 'docs/derived/state/requirements.json',
  'state:evidence': 'docs/derived/state/evidence/',
  'state:STATE.json': 'docs/derived/STATE.json',
  'removals:contract': 'respawnpack.config.json',
  // The one decision row whose subject is NOT respawnpack.config.json: provenance is declared in its own
  // tracked document, not as a config key, so pointing a reader at the config would send them to a file
  // with nothing about it in it.
  lineage: LINEAGE_DECLARATION,
  'reconcile:tasks': 'respawnpack.config.json',
  onboarding: 'respawnpack.config.json',
  posture: 'respawnpack.config.json',
  exceptions: 'respawnpack.config.json',
  // P2-I-3: `subagents` resolves the SAME declaration posture does — its other two inputs, the ceiling
  // env var and the .respawnpack/spawn-guard.strict marker, are named in the row's own detail instead.
  projectType: 'respawnpack.config.json',
  subagents: 'respawnpack.config.json',
  /*
   * P2-Q-2: the readiness row's subject is the PROJECT TREE, not one file — its items are found from
   * the tree and the declarations together, and each item's own row in `readiness` names the evidence
   * it looked at. `.` is that tree in the project-relative spelling every other subject here uses.
   */
  readiness: '.',
  'skills:living': '.claude/skills/',
  'memory:skill': '.claude/skills/knowledge/',
  'memory:distribution': 'memory/',
  'memory:engine': 'memory/',
  /*
   * ⛔ NAMED ONE BY ONE RATHER THAN COMPOSED FROM THE ID, because composing gets them WRONG. The host
   * adapters do not live at `.claude/adapters/<id>`: they live two directories down under
   * `claude-code/`, and a subject that pointed a reader at a path with nothing in it would be worse
   * than no subject at all. `adapter:<name>` rows below are validator adapters the project declares,
   * which have no fixed location here, so those keep the declared name as their subject.
   */
  'host-adapter:claude-interactive-hooks': '.claude/adapters/claude-code/interactive/probe.js',
  'host-adapter:claude-sdk-supervisor': '.claude/adapters/claude-code/sdk-supervisor/supervisor.js',
  'host-adapter:claude-statusline': '.claude/adapters/claude-code/statusline/statusline.js',
};
const doctorSubject = (component) => {
  if (DOCTOR_SUBJECT[component]) return DOCTOR_SUBJECT[component];
  const at = component.indexOf(':');
  if (at < 0) return component;
  const family = component.slice(0, at);
  if (!(family in DOCTOR_SUBJECT_PREFIX)) return component.slice(at + 1);
  const prefix = DOCTOR_SUBJECT_PREFIX[family];
  return prefix === null ? 'respawnpack.config.json' : prefix + component.slice(at + 1);
};

/*
 * ⛔ RESTATED FROM install/install.js's PROJECT_TYPE_DROPS, NEVER REQUIRED FROM IT (P2-I-3).
 *
 * install.js is a SCRIPT, not a library: no `module.exports`, no `require.main` guard, and side effects
 * — file placement, a settings.json merge, `process.exit` on a bad flag — starting within its first
 * sixty lines. `require('../install/install.js')` from this process would not import a table, it would
 * RUN AN INSTALL against whatever `process.argv` and `process.cwd()` this process happens to have, which
 * is exactly what a read-only report must never do. Contrast `hooks/_posture.js` and `hooks/_exceptions.js`
 * above: those are reached cross-tree BECAUSE they are pure modules with no side effect at require time;
 * install.js is not one, so this table is restated rather than read live.
 *
 * Kept from drifting by `kernel/kernel.test.mjs`'s fence, which reads BOTH files as TEXT — never
 * requiring install.js either — and compares the two tables, the same technique `KERNEL_CROSS_TREE`
 * above uses for the hook-path constants.
 */
const DOCTOR_PROJECT_TYPE_DROPS = {
  'docs-only': ['performance'],
  'ops-infra': ['performance'],
  'greenfield-app': [],
  'mature-product': [],
};

function cmdDoctor() {
  const rows = [];
  let applicability = null; // filled by the onboarding section; null if that section itself threw
  const has = (rel) => fs.existsSync(path.join(DIR, rel));

  /*
   * ⛔ EXACTLY ONE ROW PER COMPONENT IDENTIFIER, ENFORCED HERE RATHER THAN HOPED FOR.
   *
   * Reproduced at de7a87a on a real disposable installed target, with `.claude/hooks/_contracts.js`
   * damaged five different ways:
   *
   *     hook-lib:_contracts.js  BROKEN  hooks/_contracts.js could not be used (…) — contracts UNAVAILABLE
   *     hook-lib:_contracts.js  ACTIVE  present, loads, and exports the contract its readers call
   *
   * TWO rows, same identifier, OPPOSITE verdicts, in four of the five cases. A reader looking a component
   * up gets whichever one they happen to read first, and a machine consumer that indexes by component
   * silently keeps the last. The cause is fixed below — the contract source now has ONE row that carries
   * both facts — and this is the structural fence that makes a future recurrence impossible to ship
   * quietly, because a collision becomes its own loud BROKEN row instead of a duplicate nobody counts.
   *
   * The FIRST row is kept, not the last: a component's own probe result is emitted before anything that
   * might annotate it, and silently overwriting a real verdict is the failure mode being closed.
   *
   * ⛔ AND THE FENCE SURVIVED THE VOCABULARY UNIFICATION UNCHANGED (anti-drift item 17). The identifier
   * it keys on is now spelled `check` rather than `component` and the word is `label` rather than
   * `status`, but it is the SAME identifier and the SAME collision, still a loud row rather than a
   * duplicate nobody counts. `doctorRow` is the only constructor: a row that skipped it would be the
   * one row in the report with no outcome, which is how a shape drifts back apart one caller at a time.
   */
  const seenComponents = new Map();
  /*
   * One component's verdict, in the shared row shape.
   *
   *   check    the stable component identifier, unchanged — `hook:index-guard.js`, `state:STATE.json`
   *   label    doctor's own richer word, unchanged — ACTIVE, SILENTLY INACTIVE, STALE, NOT_CONFIGURED
   *   outcome  what that word means to an exit code, via DOCTOR_OUTCOME
   *   subject  WHAT the row looked at: the file on disk, or the declaration that decides it. From
   *            `doctorSubject` above, which resolves a path rather than restating the identifier.
   *   checked  1 — doctor rows are one-component verdicts, and each one did examine its component.
   */
  const doctorRow = (component, label, detail, subject = null) => result(
    DOCTOR_OUTCOME[label] ?? OUTCOME.CANNOT_DETERMINE,
    component,
    detail,
    {
      checked: 1,
      domain: doctorDomain(component),
      subject: subject ?? doctorSubject(component),
      label,
    },
  );
  const add = (component, status, detail, subject = null) => {
    if (seenComponents.has(component)) {
      const first = seenComponents.get(component);
      rows.push(doctorRow(`doctor:row-collision:${component}`, 'BROKEN',
        `doctor emitted more than one row for \`${component}\` — kept "${first.label}: ${String(first.detail).slice(0, 120)}" and DISCARDED `
          + `"${status}: ${String(detail).slice(0, 120)}". Two verdicts for one component is a defect in this report, not in the target.`,
        component));
      return;
    }
    const row = doctorRow(component, status, detail, subject);
    seenComponents.set(component, row);
    rows.push(row);
  };

  /*
   * ⛔ AND ONE EXPLODING COMPONENT MUST NOT SILENCE THE WHOLE REPORT. Each guarded block below reaches
   * into a different subsystem, and on a broken install any of them can throw. An installed
   * `_manifest.js` that loaded WITHOUT `compareManifest` threw a TypeError out of `stateFreshness` and
   * took the run with it — after the hook rows had already been computed, so a report that existed was
   * never printed and the operator got a stack trace instead of a diagnosis. A throw is now a BROKEN
   * row naming the throw: loud (it rolls up to FAIL, exit 1), never swallowed, and every other
   * component still gets to speak.
   *
   * ⛔ THIS GUARD IS ONLY HALF THE ANSWER, AND THE OTHER HALF IS AT THE TOP OF THE FILE. A guard here
   * cannot help with a subsystem loaded before `cmdDoctor` is ever called, which is why the kernel
   * subsystems are lazy — see the bootstrap note beside `lazyLib`. Together they mean a broken
   * subsystem is a row; alone, this one protected a failure that had already killed the process.
   */
  const section = (label, fn) => {
    try { fn(); } catch (e) {
      add(label, 'BROKEN', `this check could not run — ${(e && e.constructor && e.constructor.name) || 'Error'}: ${String((e && e.message) || e).split(/\r?\n/)[0].slice(0, 300)}`);
    }
  };

  const settings = readJSON(path.join(DIR, '.claude', 'settings.json'));
  const wired = JSON.stringify((settings && settings.hooks) || {});
  const hookDir = path.join(DIR, '.claude', 'hooks');
  const kernelLibDir = path.join(DIR, '.claude', 'respawnpack', 'lib');
  const hooksOnDisk = fs.existsSync(hookDir) ? fs.readdirSync(hookDir).filter((f) => f.endsWith('.js') && !f.startsWith('_')) : [];

  /*
   * ⛔ ONE MODEL, BUILT ONCE, SPANNING BOTH INSTALLED TREES. Every dependency question below — which
   * shared modules the hooks reach, which hooks a broken module kills, which kernel subsystems a broken
   * one takes with it — is answered from this single graph. Sibling `require('./x.js')` edges are
   * derived from source in both trees; the cross-tree `probePath` edges the kernel uses to reach
   * `hooks/` are declared in modhealth.CROSS_TREE and fenced against source in both directions.
   */
  const depGraph = modhealth.dependencyGraph({ kernelLibDir, hookDir });

  /*
   * ⛔ AN INVENTORY BUILT FROM WHAT IS PRESENT CANNOT REPORT AN ABSENCE.
   *
   * The expected set used to be `readdirSync(hookDir)`. Delete a hook that settings.json still wires
   * and it did not become BROKEN — it became INVISIBLE. Doctor printed `→ PASS` at exit 0 with no row
   * for it at all, while the harness went on trying to run it at every matching event. That is the
   * silent-inactivity failure this verb exists to catch, committed by the verb.
   *
   * So the expected set is the UNION of two sources that each see what the other cannot: the installed
   * WIRING (authoritative about what will be invoked, and the only thing that can name a deleted file)
   * and the DIRECTORY (authoritative about what is installed but unwired). Neither is a list kept in
   * this file, so neither can drift from the installer.
   *
   * ⛔ AND ONLY COMMANDS THAT NAME A FILE INSIDE `.claude/hooks/` COUNT. A target legitimately wires its
   * own tooling — `node tools/their-own-script.js`, an npx invocation, a shell one-liner. Turning those
   * into missing-file rows would manufacture RespawnPack failures out of somebody else's setup, which
   * is how a diagnostic gets ignored on the day it is right.
   */
  const commands = [];
  (function collect(v) {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (v && typeof v === 'object') {
      if (typeof v.command === 'string') commands.push(v.command);
      Object.values(v).forEach(collect);
    }
  }((settings && settings.hooks) || {}));
  const HOOK_REF = /[\\/]hooks[\\/]([A-Za-z0-9._-]+\.js)\b/;
  const wiredHooks = new Set(commands.map((c) => (HOOK_REF.exec(c) || [])[1]).filter((n) => n && !n.startsWith('_')));
  // Wiring is read precisely where it can be; the raw-JSON substring stays as a widening fallback, so a
  // spelling this regex does not know still counts as wired rather than being called silently inactive.
  const isWired = (h) => wiredHooks.has(h) || wired.includes(h);
  const expectedHooks = [...new Set([...hooksOnDisk, ...wiredHooks])].sort();

  /*
   * ⛔ THE HOOK ROWS WAIT FOR THE LIBRARY RESOLUTION BELOW. They used to be emitted first, so deleting
   * `_shell.js` produced `ACTIVE  hook:index-guard.js` on one line and `BROKEN  hook-lib:_shell.js` on
   * another — the overall verdict was right and the row a reader looks up was still wrong. A hook that
   * cannot load is not ACTIVE, whatever settings.json says about it.
   */
  // Only report a missing shared module as BROKEN when a hook on disk actually requires it. A directory
  // of unrelated hooks is not broken for lacking RespawnPack's libraries, and a doctor that cries wolf
  // on someone else's setup gets ignored on the day it is right.
  //
  // ⛔ AND THE SET OF LIBRARIES IS READ OFF DISK, NEVER LISTED HERE. This loop used to iterate a
  // hardcoded ['_runtime.js', '_cmd.js']. index-guard.js requires './_shell.js', './_git-effect.js'
  // and './_index-lease.js'; delete any one of them and doctor printed `ACTIVE  hook:index-guard.js`
  // and an overall `→ PASS` for a hook that dies on MODULE_NOT_FOUND at its first invocation. Doctor
  // is the escape hatch README.md points at for per-install truth — a hardcoded pair means it tells
  // that truth only about the libraries someone remembered to add. The requires are transitive: a
  // library the hooks reach only through another library is just as fatal, so the walk is a closure.
  //
  // ⛔ THE CLAIM IS NARROWED TO WHAT THE DERIVATION ACTUALLY SEES. `modhealth.siblingRequires` matches
  // literal `require('./name.js')`. A backtick require, a concatenated path, or one reaching into a
  // subdirectory is INVISIBLE to it — so this reports "every shared module the installed hooks require
  // in the pack's own spelling", not "every module they can possibly load". No shipped hook uses
  // another spelling, which is why the walk is sound today and why a future hook that departed from
  // the convention would go unreported. The cross-tree edges the derivation cannot see are DECLARED in
  // modhealth.CROSS_TREE and folded into the same graph.
  /*
   * ⛔ AND A SHARED MODULE THIS PROCESS ITSELF READS IS A DEPENDENT TOO, WHICH IS THE HOLE `_posture.js`
   * OPENED. Every other shared module is reached by at least one hook, so a hook-only closure covered
   * them by accident; the posture reader is the first that only the KERNEL reads, and a closure walked
   * from `hooksOnDisk` alone would have left it with no row at all — the silent-inactivity failure this
   * verb exists to catch, committed by the verb, one module further out. The set is derived from the
   * very path constants the probes above use, so it cannot drift from what this file actually reaches.
   *
   * ⛔ AND ONLY WHEN THIS KERNEL'S OWN HOOK TREE IS THE ONE UNDER EXAMINATION, WHICH IS NOT THE SAME
   * QUESTION AS "does the target have a hooks directory". These constants resolve against `__dirname`,
   * so on an installed target they name `.claude/hooks/` and on the pack repo they name the repo's own
   * `hooks/` — a different tree from whatever `--dir` points at. Folding them in unconditionally turned
   * every fixture with an unrelated `.claude/hooks/` into a target with three missing libraries, which
   * is a manufactured RespawnPack failure out of somebody else's setup. The comparison below is exact:
   * the modules are inventoried only when the kernel being run IS the one installed beside them.
   */
  const requiredLibs = (() => {
    const seen = new Set();
    const fold = (name) => { for (const d of modhealth.transitiveDeps(depGraph, name)) if (d.startsWith('_')) seen.add(d); };
    for (const h of hooksOnDisk) fold(h);
    for (const abs of KERNEL_CROSS_TREE) {
      if (path.resolve(path.dirname(abs)) !== path.resolve(hookDir)) continue;
      seen.add(path.basename(abs));
      fold(path.basename(abs));
    }
    return [...seen].sort();
  })();
  /*
   * ⛔ AND "PRESENT" IS NOT "LOADS". This row asked `fs.existsSync()` and called the answer ACTIVE. On a
   * real installed target, `_manifest.js` left in place and edited into invalid JavaScript produced
   * `ACTIVE hook-lib:_manifest.js`, `ACTIVE hook:session-routing-nudge.js` and an overall `→ PASS` at
   * exit 0 — while the real SessionStart hook died with a SyntaxError at its first invocation. An
   * existence check cannot see a module that is present and unloadable, which is most of the ways a
   * module breaks after installation: a half-written file, a bad merge, an interrupted upgrade, an
   * edit. `modhealth` loads the INSTALLED artifact and separates absent · unparseable · throwing ·
   * wrong-exports · healthy, so the row says which one and the reader is not sent to look for a file
   * that is sitting right there.
   */
  /*
   * ⛔ IF THE CONTRACT SOURCE IS UNAVAILABLE, EVERY ROW BELOW IS A WEAKER CLAIM — AND SAYS SO.
   * `hooks/_contracts.js` is the one declaration both the hooks and this report validate against. When
   * it cannot be read, contracts are not checked at all, and reporting the resulting "it loads" as an
   * ordinary ACTIVE would be the quiet weakening this program has already corrected twice.
   */
  /*
   * ⛔ AND THE CONTRACT SOURCE GETS **ONE** ROW CARRYING BOTH FACTS, NOT TWO ROWS CONTRADICTING EACH
   * OTHER. It used to get an unconditional `add()` here AND another from the loop below, because
   * `_boot.js` requires it so it is in `requiredLibs` like anything else. On a real installed target that
   * printed `BROKEN` and `ACTIVE` for the same identifier — see the collision fence at the top of this
   * function, which now catches the class rather than this instance.
   *
   * The two facts are genuinely different questions and both belong in the row:
   *   · does the TARGET's `_contracts.js` load and satisfy its own declared contract  (probePath)
   *   · could THIS PROCESS use it to build the contract registry at all               (contractSource)
   * The second can fail while the first passes when doctor runs against a target other than its own
   * tree, and a row that reported only one of them would be confidently answering the wrong question.
   */
  const libHealthOf = (lib) => modhealth.probePath(path.join(hookDir, lib));
  const rawLibHealth = new Map(requiredLibs.map((lib) => [lib, libHealthOf(lib)]));
  const CONTRACT_SOURCE = modhealth.CONTRACT_SOURCE;

  /*
   * ⛔ AND THE ROW AND THE DEPENDENCY LOGIC READ **ONE** VERDICT, WHICH THE FIRST DRAFT OF THIS FIX DID
   * NOT — the fixture caught it. `probePath` looks a contract up in the registry, and when the contract
   * SOURCE is the broken thing there is no registry, so it falls back to loadability and answers OK. So
   * with `CONTRACTS` deleted, the `hook-lib:_contracts.js` row correctly read BROKEN (it also consults
   * `contractSource`) while `brokenLibs` — built from the probe alone — did not contain it, and every
   * dependent hook was reported ACTIVE. Doctor contradicting itself two sections apart is the identical
   * shape as the duplicate rows this unit exists to close; it just wore a different mask.
   *
   * `libHealth` below is the ONE verdict both consumers read. The contract source's entry folds in
   * whether this process could build a registry at all, so a row and a dependent hook cannot disagree.
   */
  const contractSourceHealth = () => {
    const probed = rawLibHealth.get(CONTRACT_SOURCE);
    if (modhealth.contractSource.ok) return probed;
    return {
      status: probed && probed.status !== modhealth.OK ? probed.status : modhealth.INVALID_CONTRACT,
      module: null,
      detail: probed && probed.status !== modhealth.OK
        ? `${probed.detail} · ${modhealth.contractSource.detail}`
        : modhealth.contractSource.detail,
    };
  };
  const libHealth = new Map(rawLibHealth);
  if (libHealth.has(CONTRACT_SOURCE)) libHealth.set(CONTRACT_SOURCE, contractSourceHealth());

  for (const lib of requiredLibs) {
    const h = libHealth.get(lib);
    const ok = h.status === modhealth.OK;
    if (lib === CONTRACT_SOURCE) {
      add(`hook-lib:${lib}`, ok ? 'ACTIVE' : 'BROKEN', ok
        ? `${h.detail} · the protected contract source: every shared-module verdict below is checked against it`
        : `${h.detail} · it is PROTECTED, not irreducible: hooks that need it enter their conservative posture rather than dying`);
      continue;
    }
    add(`hook-lib:${lib}`, ok ? 'ACTIVE' : 'BROKEN',
      ok ? h.detail : `${h.detail} · installed hooks require it and will fail to load`);
  }
  // A target whose hooks reach no shared module at all still deserves to hear that THIS process could
  // not build a contract registry — otherwise the weakened claim goes unstated for want of a consumer.
  if (!requiredLibs.includes(CONTRACT_SOURCE) && !modhealth.contractSource.ok) {
    add(`hook-lib:${CONTRACT_SOURCE}`, 'BROKEN', modhealth.contractSource.detail);
  }

  // Now the per-hook rows, with the library facts in hand. `requiresOf` walks the same transitive
  // closure the loop above did, so a hook broken only through a second-level module is reported too.
  // A hook is broken by a module it cannot LOAD, not only by one that is absent — same widening as the
  // rows above, and the reason a dependent hook must never stay ACTIVE while its library is unloadable.
  const brokenLibs = new Map([...libHealth].filter(([, h]) => h.status !== modhealth.OK));
  /*
   * ⛔ ONE DEPENDENCY MODEL, BOTH TREES — `modhealth.dependencyGraph`. This used to be a private regex
   * here and a second one in the kernel-lib section below, and BOTH were blind to the cross-tree
   * `probePath` edges the kernel actually uses to reach `hooks/`. Two walks that agreed by coincidence
   * is how `kernel-lib:state.js` stayed ACTIVE while the boundary it depends on was reported BROKEN one
   * section higher. Sibling edges are still derived from source; only the cross-tree ones are declared,
   * and both directions are fenced.
   */
  const requiresOf = (file) => [...modhealth.transitiveDeps(depGraph, file)];
  /*
   * ⛔ THE HOOK ARTIFACT ITSELF IS VALIDATED, NOT JUST THE LIBRARIES UNDER IT. Corrupting an installed
   * hook left doctor printing `ACTIVE` at `→ PASS`, exit 0, while running that hook died on a
   * SyntaxError: the libraries were probed and the hook was taken on faith because its filename was in
   * a directory listing.
   *
   * ⛔ A HOOK IS COMPILED, NEVER EVALUATED — and that is a deliberately smaller claim than the one made
   * for the shared modules. A library does nothing at module scope, so loading it is a safe way to ask
   * whether it loads. A hook is operational: it reads stdin and emits allow/deny decisions, and some
   * take real action. Running one to find out whether it runs is not a diagnostic, it is the side
   * effect. So a hook's verdict is its own source parsing plus the health of every shared module it
   * transitively requires — which is what "it will fail at its first invocation" is actually made of.
   *
   * NOT CLAIMED, and it follows from the same boundary: a hook whose module scope throws only when
   * EXECUTED is reported ACTIVE here. Establishing otherwise would mean invoking it.
   */
  /*
   * ⛔ "IT DIES AT ITS FIRST INVOCATION" WAS SAID OF EVERY BROKEN DEPENDENCY, AND IT IS TRUE OF EXACTLY
   * ONE. Reproduced at de7a87a with `.claude/hooks/_contracts.js` made invalid:
   *
   *     doctor  hook:index-guard.js            BROKEN … it dies at its first invocation
   *     doctor  hook:session-routing-nudge.js  BROKEN … it dies at its first invocation
   *     RUN     index-guard.js                 exit 0, permissionDecision "deny"
   *     RUN     session-routing-nudge.js       exit 0, valid SessionStart output, claims WITHHELD
   *
   * Neither died. Both entered the conservative posture `_boot.js` exists to give them. The row was
   * describing the world before the bootstrap boundary was built — and an operator reading it would go
   * looking for a crashed hook, or worse, conclude the guard was absent when it was actively denying.
   *
   * The hook is still BROKEN: it cannot do its job, and a DENY-on-everything guard is a broken guard.
   * What changes is the detail, which now says what actually happens. The posture is DERIVED from the
   * hook's own `boot.arm('…')` call — the same derive-don't-declare rule the dependency graph follows —
   * so a hook that does not enter through the boundary correctly gets the "dies" wording it has earned.
   */
  const POSTURE_EFFECT = {
    deny: 'it enters its conservative posture: an explicit DENY at native exit 0, because a guard whose policy machinery is unavailable has not established that anything is safe',
    'session-start': 'it enters its conservative posture: valid SessionStart output at native exit 0 warning that project state is unavailable and every claim is WITHHELD',
    advisory: 'it enters its conservative posture: it says why on stderr and exits 0 without a stack, having had nothing to enforce',
  };
  const postureOf = (h) => {
    let src = '';
    try { src = fs.readFileSync(path.join(hookDir, h), 'utf8'); } catch { return null; }
    // Both must be present: `need()` is what routes a dependency through the boundary, and `arm()` is
    // what chooses the posture. A hook with only one of them is not protected in the way this claims.
    if (!/\bboot\.need\(/.test(src)) return null;
    const m = /\bboot\.arm\(\s*'([a-z-]+)'\s*\)/.exec(src);
    return m && POSTURE_EFFECT[m[1]] ? m[1] : null;
  };
  const hookVerdict = (h) => {
    const own = modhealth.compileSource(path.join(hookDir, h));
    if (own.status !== modhealth.OK) return { ok: false, detail: own.detail };
    const broken = requiresOf(h).filter((l) => brokenLibs.has(l));
    if (broken.length) {
      const names = `it requires ${broken.join(', ')} which ${broken.length > 1 ? 'are' : 'is'} unloadable`;
      // The irreducible bootstrap is the one dependency nothing can catch — it IS the catcher. Reserve
      // the "dies" wording for it, and for a hook that never entered the boundary at all.
      const irreducible = broken.filter((l) => modhealth.HOOK_BOOTSTRAP.includes(l));
      const posture = postureOf(h);
      const effect = irreducible.length
        ? `${irreducible.join(', ')} is the irreducible hook bootstrap, so nothing can catch this — it dies at its first invocation`
        : posture ? POSTURE_EFFECT[posture]
          : 'it does not enter the bootstrap boundary (no boot.arm/boot.need), so nothing can catch this — it dies at its first invocation';
      return { ok: false, detail: `${names} — ${effect}. ${broken.map((l) => `${l}: ${brokenLibs.get(l).detail}`).join(' | ')}` };
    }
    return { ok: true };
  };
  for (const h of expectedHooks) {
    const v = hookVerdict(h);
    if (!v.ok) {
      add(`hook:${h}`, 'BROKEN', `${isWired(h) ? 'wired in .claude/settings.json, but ' : 'on disk, but '}${v.detail}`);
      continue;
    }
    add(`hook:${h}`, isWired(h) ? 'ACTIVE' : 'SILENTLY INACTIVE',
      isWired(h) ? 'on disk, its source parses, its shared modules load, and it is wired in settings.json'
        : 'on disk and valid but NOT wired in .claude/settings.json — it will never run');
  }

  /*
   * ⛔ THE KERNEL'S OWN SUBSYSTEMS ARE INSTALLED ARTIFACTS, AND NOTHING WAS REPORTING ON THEM. The
   * hooks and their shared modules were probed while the files doing the probing went unexamined — so a
   * corrupt `lib/memory.js` was a startup crash rather than a row. The set is read off the installed
   * kernel's own lib directory, never listed here, for the same reason the shared-module set is.
   */
  /*
   * ⛔ AND THIS INVENTORY WAS PRESENCE-DERIVED TOO — the hook lesson, one layer deeper. It read
   * `readdirSync(kernelLibDir)`, so deleting `lib/gate.js` did not make it BROKEN, it removed the row:
   * `→ PASS`, exit 0, nothing named, while `gate --json` failed and told the operator to run the doctor
   * that had just reported everything fine. A report that sends you to itself has to be able to answer.
   *
   * Expected = the REGISTERED subsystems (which can therefore be reported absent) ∪ whatever else is
   * actually in the directory (which can therefore be reported at all). Registered files get their full
   * declared contract; anything extra gets loadability only, because RespawnPack has declared no API
   * for it and inventing one would manufacture a failure out of somebody else's file.
   */
  section('kernel-libs', () => {
    const present = fs.existsSync(kernelLibDir) ? fs.readdirSync(kernelLibDir).filter((f) => f.endsWith('.js')) : [];
    // With no installed kernel at all there is nothing to report on — doctor run from the pack against
    // a target that never had one must not invent eight missing subsystems.
    if (!fs.existsSync(kernelLibDir)) return;
    const registered = Object.values(modhealth.SUBSYSTEMS).map((s) => s.file);
    const files = [...new Set([...registered, ...present])].sort();
    const health = new Map(files.map((f) => [f, modhealth.probePath(path.join(kernelLibDir, f))]));

    /*
     * ⛔ A CONSUMER OF A BROKEN DEPENDENCY IS NOT ACTIVE EITHER — AND THE DEPENDENCY MAY BE IN THE OTHER
     * TREE. The kernel tree gained the sibling walk last round, and it was still blind across the tree
     * boundary: `_artifact.js` minus `loadRequirements` gave `hook-lib:_artifact.js BROKEN` beside
     * `kernel-lib:state.js ACTIVE` and `kernel-lib:closeout.js ACTIVE`, while the real `state` verb
     * refused at exit 2 for that exact reason. Doctor and the verb disagreed about the same file.
     *
     * `libHealth` carries the hook-tree verdicts computed above, so one map answers for both trees and
     * the two sections cannot reach different conclusions about the same module.
     */
    const crossHealth = new Map();
    const healthOf = (d) => {
      if (health.has(d)) return health.get(d);
      if (libHealth.has(d)) return libHealth.get(d);
      // A hook-tree module the KERNEL depends on but no installed hook happens to require. The kernel
      // needs it either way, so it is probed rather than assumed fine — `libHealth` is populated from
      // what the HOOKS reach, which is a different question from what the kernel reaches.
      if (!d.startsWith('_')) return null;
      if (!crossHealth.has(d)) crossHealth.set(d, libHealthOf(d));
      return crossHealth.get(d);
    };

    for (const f of files) {
      const h = health.get(f);
      const boot = modhealth.BOOTSTRAP.includes(f);
      const known = registered.includes(f);
      /*
       * ⛔ ABSENT BY PROFILE IS A ROW, AND IT IS NOT BROKEN (P3-K-14). Asked before the BROKEN branch
       * because it is a NARROWER case of it: only a file ADR-003 gates, only when it is genuinely absent
       * (an unparseable or contract-violating one is damage under every posture, and falls through), and
       * only under a DECLARED posture whose cell for that row reads `n.a.`. Everything else — including a
       * missing subsystem on a target that declared nothing — keeps today's BROKEN row and today's exit 1.
       */
      const omittedFor = h.status === modhealth.ABSENT ? omittedByProfile(modhealth.PROFILE_GATED[f]) : null;
      if (omittedFor) {
        add(`kernel-lib:${f}`, 'NOT_APPLICABLE',
          `not installed by the declared \`${omittedFor}\` posture (ADR-003 ${modhealth.PROFILE_GATED[f]}) — this project asked for a profile that does not carry `
          + 'this subsystem, so its absence is the declaration working rather than an install to repair');
        continue;
      }
      if (h.status !== modhealth.OK) {
        add(`kernel-lib:${f}`, 'BROKEN', `${h.detail} · the kernel verb that uses it cannot run`);
        continue;
      }
      // It loads and exports its own contract — but something it calls across into may not, in EITHER tree.
      const brokenDeps = [...modhealth.transitiveDeps(depGraph, f)]
        .filter((d) => { const dh = healthOf(d); return dh && dh.status !== modhealth.OK; }).sort();
      if (brokenDeps.length) {
        add(`kernel-lib:${f}`, 'BROKEN',
          `it loads, but the module(s) it calls across into cannot be used: ${brokenDeps.join(', ')} · `
          + 'a module whose dependency is broken is not one a verb can run');
        continue;
      }
      add(`kernel-lib:${f}`, 'ACTIVE',
        `${h.detail}${boot ? ' · bootstrap — a defect here would have prevented this report' : known ? '' : ' · not a registered subsystem, so loadability is the whole claim'}`);
    }
  });

  section('state:requirements', () => {
    // BUG-4: STATE_DIR is a path.join (native separators, `\` on Windows) — spelled POSIX-only here via
    // removalsLib.posix() so this diagnostic row never mixes `\` and `/` in the path it tells an operator
    // to go look at. path.join(...) below still does the real, native-separator filesystem check.
    add('state:requirements', has(path.join(stateLib.STATE_DIR, 'requirements.json')) ? 'CONFIGURED' : 'NOT_CONFIGURED',
      `${removalsLib.posix(stateLib.STATE_DIR)}/requirements.json — the approved requirement denominator; without it no gate can be evaluated`);
    add('state:evidence', has(path.join(stateLib.STATE_DIR, 'evidence')) ? 'CONFIGURED' : 'NOT_CONFIGURED',
      `${removalsLib.posix(stateLib.STATE_DIR)}/evidence/ — revision-bound qualifying artifacts`);
  });

  section('state:STATE.json', () => {
    const st = stateLib.read(DIR);
    if (!st) add('state:STATE.json', 'NOT_CONFIGURED', 'never compiled — run `node .claude/respawnpack/respawnpack.js state`');
    else {
      const f = stateFreshness(st); // digest-bound, not revision-only — see stateFreshness()
      add('state:STATE.json', f.fresh ? 'CURRENT' : f.label === 'CANNOT_DETERMINE' ? 'UNKNOWN' : 'STALE', f.detail);
    }
  });

  section('adapters', () => {
    for (const a of (config().adapters || [])) {
      const v = runAdapter({ ...a, critical: false });
      add(`adapter:${a.name}`, v.outcome === OUTCOME.CANNOT_DETERMINE ? 'UNSUPPORTED' : 'ACTIVE', v.detail);
    }
  });

  /*
   * ⛔ HOST ADAPTERS: doctor reports the inventory, and earns ACTIVE only from a FIRED canary. The v0.3
   * rollover adapters install to .claude/adapters/<host>/ (install.js §3b). core/policy/capabilities.js's
   * rule holds here as everywhere: file presence is never activation evidence. So a placed adapter reads
   * INSTALLED — a green inventory fact that claims STRICTLY LESS than ACTIVE and is never mistaken for one
   * — and is promoted to ACTIVE only when the adapter's own activation canary passes for a real
   * conversation whose runtime artifact is on disk. The capability matrix keeps CANNOT_DETERMINE where
   * activation formally counts (conformance/), so this row can never over-claim what that matrix disowns.
   *
   * The installer places three Claude Code host adapters. The interactive profile's canary (probe.js)
   * reads THIS conversation's own SessionStart baseline; doctor has no ambient session, so it probes the
   * newest baseline on disk. No baseline → no conversation has exercised the hooks in this install yet →
   * INSTALLED, which is a healthy first state, not a failure. Codex/Pi join this section when the
   * installer places them (they carry recorded canary markers doctor can read without executing
   * anything); until then they are hand-installed and out of doctor's scope by construction.
   *
   * ⛔ P5-CT-4 ADDS TWO ROWS THAT NEVER REACH ACTIVE FROM HERE, BY DESIGN, NOT BY GAP. sdk-supervisor's
   * own activation canary (canary.js) spawns a real `claude` process and costs real tokens and wall
   * time — the adapter's own README names the live proof as an OWNER action — so this row's ceiling is
   * INSTALLED, earned by a LOADS check (the same in-process require doctor already does for every hook
   * and kernel lib above, mirroring §2g's core/ LOADS test in install.test.mjs) rather than a live run.
   * statusline carries a second, separate fact beside LOADS: whether `.claude/settings.json`'s single
   * `statusLine` slot actually names this file. That is a structural read, not a fired canary either —
   * the adapter's own README states there is no activation canary yet for the documented payload shape —
   * so the ceiling there is CONFIGURED (wired), never ACTIVE. Placed, loads, and wired are three
   * different, honestly separate facts, and none of the three is asserted from either of the others.
   */
  section('host-adapters', () => {
    const interactiveDir = path.join(DIR, '.claude', 'adapters', 'claude-code', 'interactive');
    const probePath = path.join(interactiveDir, 'probe.js');
    if (fs.existsSync(probePath)) {
      // Newest SessionStart baseline on disk, if any — the only session identity doctor can honestly hand
      // to a probe that refuses to infer one. mtime order, not filename order: the file name is a safeId
      // of the session, not a timestamp.
      const runtimeDir = path.join(DIR, '.respawnpack', 'runtime');
      let newest = null;
      try {
        newest = fs.readdirSync(runtimeDir)
          .filter((f) => /^session-.*\.json$/.test(f))
          .map((f) => ({ f, m: fs.statSync(path.join(runtimeDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0] || null;
      } catch { newest = null; }

      let status = 'INSTALLED';
      let detail = 'the Claude Code interactive rollover adapter is installed; no SessionStart baseline is on disk, so no conversation has exercised it in this install yet. File presence is never activation evidence — it earns ACTIVE only from a fired canary.';
      if (newest) {
        const baseline = readJSON(path.join(runtimeDir, newest.f));
        const sid = baseline && baseline.sessionId;
        if (sid) {
          // The installed, read-only canary. A load or execution throw becomes a BROKEN row via section() —
          // never a swallowed ACTIVE. This is the same in-process load doctor already does for every hook
          // and kernel lib above; probe() only reads files.
          const { probe } = require(probePath); // eslint-disable-line global-require, import/no-dynamic-require
          const r = probe({ projectDir: DIR, sessionId: sid });
          if (r && r.outcome === OUTCOME.PASS) {
            status = 'ACTIVE';
            detail = `activation canary PASSED for session ${sid} — ${r.why}`;
          } else {
            detail = `installed; the newest baseline (session ${sid}) did not prove activation — ${(r && r.why) || 'no verdict'}. Still INSTALLED, not broken.`;
          }
        }
      }
      add('host-adapter:claude-interactive-hooks', status, detail);
    } // else: not installed here → no row, exactly like the validator-adapters loop above

    // sdk-supervisor — LOADS only. Each check below gets its OWN try/catch (rather than letting a throw
    // reach section()'s outer catch) so a broken adapter names itself and never silences a sibling row
    // later in this same callback — the interactive block above is the one place a bare require is
    // still deliberately uncaught, per its own comment, because nothing follows it there.
    const supervisorPath = path.join(DIR, '.claude', 'adapters', 'claude-code', 'sdk-supervisor', 'supervisor.js');
    if (fs.existsSync(supervisorPath)) {
      try {
        const sup = require(supervisorPath); // eslint-disable-line global-require, import/no-dynamic-require
        if (sup && typeof sup.createSupervisor === 'function') {
          add('host-adapter:claude-sdk-supervisor', 'INSTALLED',
            'the managed-profile sdk-supervisor is installed and loads cleanly through its installed core/ dependency (cli.js, stream.js, measure.js, core/index.js all resolved). It earns ACTIVE only from its own live canary (canary.js) — real tokens, real wall time — which doctor never runs unattended; see the adapter README for the owner action that completes that proof.');
        } else {
          add('host-adapter:claude-sdk-supervisor', 'BROKEN', 'supervisor.js loaded but did not export createSupervisor — the installed copy does not match what this pack version expects');
        }
      } catch (e) {
        add('host-adapter:claude-sdk-supervisor', 'BROKEN', `supervisor.js is installed but failed to load — ${(e && e.constructor && e.constructor.name) || 'Error'}: ${String((e && e.message) || e).split(/\r?\n/)[0].slice(0, 200)}`);
      }
    }

    // statusline — LOADS, plus the settings-level opt-in fact kept strictly separate from placement.
    // `settings` was already read once, above, for the hook-wiring check; reused here rather than a
    // second parse of the same file.
    const statuslinePath = path.join(DIR, '.claude', 'adapters', 'claude-code', 'statusline', 'statusline.js');
    if (fs.existsSync(statuslinePath)) {
      try {
        const sl = require(statuslinePath); // eslint-disable-line global-require, import/no-dynamic-require
        if (!sl || typeof sl.statusLine !== 'function') {
          add('host-adapter:claude-statusline', 'BROKEN', 'statusline.js loaded but did not export statusLine — the installed copy does not match what this pack version expects');
        } else {
          const cmd = settings && settings.statusLine && settings.statusLine.command;
          const wiredHere = typeof cmd === 'string' && /adapters[\\/]claude-code[\\/]statusline[\\/]statusline\.js/.test(cmd);
          if (wiredHere) {
            add('host-adapter:claude-statusline', 'CONFIGURED',
              'installed and loads; the statusLine slot in .claude/settings.json names this file. A structural fact, not a fired canary — there is no activation canary yet proving the documented context-usage payload shape holds in this environment.');
          } else if (cmd) {
            add('host-adapter:claude-statusline', 'INSTALLED',
              `installed and loads, but NOT the active statusLine — .claude/settings.json's single statusLine slot names something else (${cmd}). RespawnPack never writes or overwrites that slot.`);
          } else {
            add('host-adapter:claude-statusline', 'INSTALLED',
              'installed and loads, but not opted in — .claude/settings.json has no statusLine entry. Placing the file is not activating it; see adapters/claude-code/statusline/README.md to wire it by hand.');
          }
        }
      } catch (e) {
        add('host-adapter:claude-statusline', 'BROKEN', `statusline.js is installed but failed to load — ${(e && e.constructor && e.constructor.name) || 'Error'}: ${String((e && e.message) || e).split(/\r?\n/)[0].slice(0, 200)}`);
      }
    }
  });

  /*
   * ⛔ THE POSTURE ROW — WHAT THIS PROJECT DECLARED, AND WHETHER ANYBODY DECLARED IT.
   *
   * ADR-003 gives a project three postures in one key of `respawnpack.config.json`, with `strict`
   * defined as exactly what 0.3.0 does and an absent key resolving to `strict`. That default is the
   * migration guarantee, so the row's job is to report the DECLARATION, not to guess an intent from it.
   *
   * ⛔ CONFIGURED AND NOT_CONFIGURED ARE BOTH GREEN, AND THEY ARE STILL DIFFERENT ROWS. "Nobody chose"
   * and "chose strict" produce identical behaviour today and are not the same fact: the first is a
   * project that has not been asked, the second is a project that answered. Collapsing them would make
   * the first flip silently the day someone edits the key, with no row that ever said what changed.
   *
   * ⛔ AND AN UNREADABLE OR INVALID DECLARATION IS BROKEN, NEVER GREEN. `_posture.resolve` already fails
   * closed to `strict` and says which, so nothing is loosened by the fault; this row is what makes the
   * fault visible instead of leaving a project running strict while its founder believes it is running
   * `light`. A silently-ignored posture is the same class of lie as a silently-loosened guard.
   *
   * This ROW still changes nothing: it reports the declaration. What now reads the same resolution is
   * the onboarding section below, through `applicability`'s posture layer (P3-K-10) — the hook rules
   * follow in P3-T-10a/b/c, one at a time.
   */
  section('posture', () => {
    if (!postureLib) {
      add('posture', 'BROKEN',
        `the one posture reader (hooks/_posture.js) is unusable: ${postureHealth.detail} — no posture can be read here, so `
        + 'every rule behaves as strict. This is a damaged installation, not a project that declared nothing.');
      return;
    }
    // The SAME resolution the onboarding rows below read — one consult per verb, not one per reader.
    const p = resolvedPosture();
    if (!p) {
      add('posture', 'BROKEN',
        'the one posture reader (hooks/_posture.js) loaded but could not resolve a posture for this project, so every '
        + 'rule behaves as strict. This is a damaged installation, not a project that declared nothing.');
      return;
    }
    const status = p.source === 'DECLARED' ? 'CONFIGURED' : p.source === 'DEFAULTED' ? 'NOT_CONFIGURED' : 'BROKEN';
    const overrides = Object.entries(p.overrides || {})
      .map(([id, o]) => `${id} → ${o.verdict} (${o.reason})`).sort();
    add('posture', status, overrides.length ? `${p.detail}. ${overrides.join('; ')}` : p.detail);
  });

  /*
   * ⛔ THE EXCEPTIONS ROW — WHAT THIS PROJECT LIFTED, AND WHETHER ANY OF IT STILL WORKS (P1-E-1a).
   *
   * A declared exception carves one reviewed SUBJECT out of a guard that has one, in the founder-owned
   * tracked file, with a reason. The whole grammar rests on the allowance staying visible, so it gets a
   * row for the same reason the posture does: an allowance nobody can see is the `.respawnpack/<hook>.off`
   * marker with better manners.
   *
   * ⛔ AND THE COUNT OF EXPIRED ENTRIES IS IN THE ROW, NOT ONLY THE COUNT OF DECLARED ONES. An expired
   * exception lifts nothing — `_exceptions.allowed()` refuses it — so a project can sit for months with
   * a guard firing on a subject its founder believes is excepted. "3 declared (1 expired)" is the line
   * that gets that entry renewed or deleted; "3 declared" is the line that hides it.
   *
   * ⛔ NOT_CONFIGURED IS KEYED ON THE LIST BEING EMPTY, NOT ON THE SOURCE — which is where this row
   * differs from the posture's on purpose. "Nobody wrote a posture" and "chose strict" are different
   * facts because they can diverge later; an absent `exceptions` key and a present empty list are the
   * SAME fact, because both mean no subject is lifted anywhere. `resolve()`'s own detail still names
   * which of the two it read.
   *
   * ⛔ AND AN UNREADABLE OR INVALID LIST IS BROKEN, NEVER GREEN. The reader has already refused the
   * whole list, so nothing is loosened by the fault; this row is what stops a founder believing a hit
   * is excepted while the guard still denies it. This ROW changes nothing else: the guards consume the
   * reader in hooks/, one at a time since E-1b to E-1d, and none of them reads this row.
   */
  section('exceptions', () => {
    if (!exceptionsLib) {
      add('exceptions', 'BROKEN',
        `the one exception reader (hooks/_exceptions.js) is unusable: ${exceptionsHealth.detail} — no declared exception can be `
        + 'read here, so every guard fires on every subject. This is a damaged installation, not a project that declared nothing.');
      return;
    }
    // The SAME resolution the `readiness` row below reads — one consult per verb, not one per reader.
    const x = resolvedExceptions();
    if (!x) {
      add('exceptions', 'BROKEN',
        'the one exception reader (hooks/_exceptions.js) loaded but could not resolve an exception list for this project, so '
        + 'every guard fires on every subject. This is a damaged installation, not a project that declared nothing.');
      return;
    }
    const readable = x.source === 'DECLARED' || x.source === 'DEFAULTED';
    const status = !readable ? 'BROKEN' : (x.exceptions || []).length ? 'CONFIGURED' : 'NOT_CONFIGURED';
    add('exceptions', status, x.detail);
  });

  /*
   * ⛔ THE PROJECT-TYPE ROW — WHAT THIS PROJECT DECLARED ITSELF TO BE (P2-I-3, Class B "Visibility").
   *
   * `install/install.js` reads `respawnpack.config.json`'s `projectType` for ONE purpose: which
   * CLAUDE.md sections to drop from the managed block (`DOCTOR_PROJECT_TYPE_DROPS` above, restated from
   * its `PROJECT_TYPE_DROPS`). Nothing else in the pack reads the key today. This row is the one place
   * that derivation is visible without opening install.js.
   *
   * ⛔ CONFIGURED, NOT_CONFIGURED AND BROKEN ARE THE SAME TRIO THE POSTURE ROW USES, FOR THE SAME REASON.
   * "Nobody declared a type" and "declared docs-only" are different facts and not the same green. An
   * UNKNOWN type is BROKEN, never NOT_CONFIGURED: the installer already REFUSED to write CLAUDE.md's
   * block over it, so a green row here would call a refusal a default.
   *
   * ⛔ AND AN UNPARSEABLE CONFIG IS NEITHER OF THOSE — it reads as NOT_CONFIGURED, on install.js's own
   * rule (see `DOCTOR_PROJECT_TYPE_DROPS`'s twin at install.js's PROJECT_TYPE_DROPS): "nothing was
   * declared that anyone could read" is a third state, not a refusal, so the block composes exactly as
   * it does for a target that wrote no key. `readJSON` — the SAME helper `config()` above already reads
   * this file through — collapses a malformed file to `null` here too, one boundary rather than a second
   * reader that could disagree with the first about what "unreadable" means.
   */
  section('projectType', () => {
    const cfg = readJSON(path.join(DIR, 'respawnpack.config.json'));
    const declared = cfg && Object.prototype.hasOwnProperty.call(cfg, 'projectType') ? cfg.projectType : undefined;
    if (declared === undefined) {
      add('projectType', 'NOT_CONFIGURED',
        'no projectType declared, the managed block composes in full; declare one of docs-only, ops-infra, greenfield-app, '
        + 'mature-product to drop the sections that cannot apply');
      return;
    }
    const drops = Object.prototype.hasOwnProperty.call(DOCTOR_PROJECT_TYPE_DROPS, declared) ? DOCTOR_PROJECT_TYPE_DROPS[declared] : null;
    if (!drops) {
      add('projectType', 'BROKEN',
        `respawnpack.config.json declares projectType ${JSON.stringify(declared)}, which is not one of `
        + `${Object.keys(DOCTOR_PROJECT_TYPE_DROPS).join(', ')} — install/install.js refuses to write CLAUDE.md's managed `
        + 'block for a type it does not know rather than guessing one; fix the value or remove the key');
      return;
    }
    add('projectType', 'CONFIGURED',
      drops.length
        ? `projectType \`${declared}\` is declared; the installer composes CLAUDE.md's managed block WITHOUT the `
          + `${drops.join(', ')} section(s), which cannot apply to this type`
        : `projectType \`${declared}\` is declared; every section applies to this type, so the installer composes the `
          + 'managed block in full — the same composition an undeclared project gets');
  });

  /*
   * ⛔ THE SUBAGENTS ROW — THE CEILING, ITS VERDICT, AND WHETHER A DISPATCH ABOVE IT ACTUALLY STOPS
   * (P2-I-3, owner decisions 26 and 28).
   *
   * `hooks/spawn-guard.js` computes this same pair on every dispatch — `_posture.verdict(resolved,
   * 'spawn-guard:ceiling')` beside the `.respawnpack/spawn-guard.strict` marker — and `spawn-guard:ceiling`
   * used to be "wired and read by no hook" per `hooks/README.md` before I-1 made it real. This row is
   * where a founder reads today's answer without dispatching an agent to find out the hard way.
   *
   * ⛔ THE RAW VERDICT AND THE REAL EFFECT ARE PRINTED SEPARATELY, ON PURPOSE. `_posture.verdict` answers
   * `deny` for the `strict` profile regardless of WHY the resolution is `strict` — DECLARED, DEFAULTED,
   * UNREADABLE and INVALID all share that profile. Only a genuine DECLARED strict arms spawn-guard's hard
   * deny; the other three sources resolve to `strict` for every OTHER reader's fail-closed reasons but
   * leave THIS ceiling advisory-only, exactly as it behaved before a posture existed to declare (see
   * spawn-guard.js's header). Printing `<verdict> under <profile> (<source>)` and then a plain sentence
   * about what actually happens is what keeps "the table says deny" from being misread as "this project
   * denies" when nobody declared anything.
   *
   * ⛔ THE MARKER ONLY EVER TIGHTENS. Present, it forces a hard deny under ANY posture — light, standard,
   * even an unreadable config — and nothing here can loosen a DECLARED strict back to advisory.
   *
   * ⛔ ACTIVE, NOT A CONFIGURED/NOT_CONFIGURED PAIR. There is nothing to declare-or-not here — a ceiling
   * always applies, at 8 or at `RESPAWNPACK_SPAWN_CEILING` — so this row reads like a hook row (ACTIVE or
   * BROKEN), not like posture's own three-way trio.
   */
  section('subagents', () => {
    if (!postureLib) {
      add('subagents', 'BROKEN',
        `the one posture reader (hooks/_posture.js) is unusable: ${postureHealth.detail} — spawn-guard:ceiling's verdict `
        + 'cannot be established here. This is a damaged installation, not a project that declared nothing.');
      return;
    }
    const p = resolvedPosture();
    if (!p) {
      add('subagents', 'BROKEN',
        'the one posture reader (hooks/_posture.js) loaded but could not resolve a posture for this project, so '
        + "spawn-guard:ceiling's verdict cannot be established here. This is a damaged installation, not a project that "
        + 'declared nothing.');
      return;
    }
    // hooks/spawn-guard.js's own ceiling formula and marker path, restated and fenced from its source —
    // see kernel/kernel.test.mjs's spawn-guard fence beside the PROJECT_TYPE_DROPS one above.
    const ceiling = Number(process.env.RESPAWNPACK_SPAWN_CEILING) || 8;
    const ruleVerdict = postureLib.verdict(p, 'spawn-guard:ceiling');
    const markerPresent = fs.existsSync(path.join(DIR, '.respawnpack', 'spawn-guard.strict'));
    // owner decisions 26/28: only a DECLARED strict arms the hard deny on its own; DEFAULTED, UNREADABLE
    // and INVALID all resolve `profile` to strict too but never tighten this ceiling by themselves.
    const postureDenies = p.source === 'DECLARED' && ruleVerdict === 'deny';
    const denyMode = markerPresent || postureDenies;
    const reasons = [];
    if (postureDenies) reasons.push(`the declared posture (\`${p.profile}\`) resolves spawn-guard:ceiling to deny`);
    if (markerPresent) reasons.push('.respawnpack/spawn-guard.strict is present');
    const why = denyMode
      ? `DENIED — ${reasons.join(' and ')}`
      : `ADVISED, not blocked — ${p.source === 'DECLARED'
        ? `the declared posture (\`${p.profile}\`) resolves spawn-guard:ceiling to ${ruleVerdict}, which is not deny`
        : `posture ${p.source} (\`${p.profile}\`) never tightens this ceiling by itself; only a DECLARED strict or the marker does`}`;
    add('subagents', 'ACTIVE',
      `ceiling ${ceiling} · ${ruleVerdict} under ${p.profile} (${p.source}) · marker ${markerPresent ? 'present' : 'absent'} — `
      + `a dispatch above the ceiling on this project today would be ${why}`);
  });

  /*
   * ⛔ THE READINESS ROW — HOW MANY ITEMS APPLY HERE, AND HOW MANY OF THEM ARE NOT MET (P2-Q-2).
   *
   * The verb is where a release gate reads the list; this row is where a founder learns the list EXISTS
   * for their project without running it, and learns the one number that decides whether `/ship` Step 1
   * will stop them. `n items, m failing under <profile>` is deliberately the whole line: which items and
   * why is the verb's job, and duplicating its rows here would put one fact under two authorities.
   *
   * ⛔ ACTIVE, NOT A PASS/FAIL VERDICT ON THE PROJECT. Doctor answers "is this INSTALLATION sound", and a
   * project with four unmet readiness items has a sound installation and unfinished work. Making a
   * failing item red here would move doctor's exit code for every target that upgrades into this row,
   * over a checklist doctor's own contract never mentioned — the behaviour change every posture consumer
   * in this file refuses. The verb exits 1 on the same finding, which is where that belongs.
   *
   * ⛔ AND NOTHING APPLYING IS NOT_CONFIGURED, WHICH IS DIFFERENT FROM EVERY ITEM PASSING. A tree this
   * checklist recognises nothing in has not been found ready; `readiness` itself reports that as
   * CANNOT_DETERMINE at exit 2, and doctor's own word for "there is nothing here to report on" is
   * NOT_CONFIGURED. Collapsing it into ACTIVE would be a green row for a checklist that asked nothing.
   *
   * A `readiness.js` that will not load lands in `section()`'s BROKEN row rather than a stack trace —
   * anti-drift item 17, the same guarantee every other lazily-loaded subsystem gets.
   */
  section('readiness', () => {
    const rule = readinessLib.POSTURE_ROW;
    const relaxes = postureRelaxes(rule);
    const posture = relaxes ? { profile: posturePolicy().profile, rule, verdict: posturePolicy().verdict(rule) } : null;
    const r = readinessLib.runReadiness(DIR, { posture, exception: (item) => exceptionFor('readiness', { item }) });
    const profile = posture ? posture.profile : 'strict';
    if (!r.applicable) {
      add('readiness', 'NOT_CONFIGURED',
        'no readiness item applies here: nothing in this tree was recognised as a Node, Terraform, Ansible, shell, container or '
        + 'documentation project, so there is no checklist to report on. `readiness` reports the same finding as CANNOT_DETERMINE, '
        + 'because a checklist that asked nothing has not established that this project is releasable.');
      return;
    }
    const lifted = r.excepted.length + r.notAsked.length;
    add('readiness', 'ACTIVE',
      `${r.applicable} items, ${r.wouldFail.length} failing under \`${profile}\` (${r.tier} tier`
      + `${lifted ? `, ${r.excepted.length} excepted by declaration and ${r.notAsked.length} outside this tier` : ''}) — `
      + `${r.wouldFail.length ? `${r.wouldFail.join(', ')}. ` : ''}`
      + `run \`readiness\` for the rows and the remedies${relaxes ? `; the declared \`${profile}\` posture reports them rather than failing on them` : ''}`);
  });

  /*
   * ⛔ "ONBOARDING WAS NEVER FINISHED" HAD NO ROW, SO IT WORE THE COSTUME OF A BROKEN PROJECT. Doctor
   * reported each optional contract separately and honestly — reconcile NOT_CONFIGURED, removals
   * UNSUPPORTED — and never said the one thing that explains all of them at once: nobody has been asked
   * yet. The founder read a page of amber and concluded the install was damaged. This row is the
   * question the others each answer a fifth of, and it is deliberately NOT in the green set: a project
   * with contracts nobody has decided about has not established that it is ready, and saying so is the
   * whole job of this verb.
   */
  /*
   * ⛔ AND A ROW A DECLARED POSTURE RELAXED IS STILL PRINTED, WITH THE POSTURE NAMED (ADR-003 kernel:R6).
   * Relaxing is not hiding: a `light` project sees the same list it would have seen under `strict`,
   * each row saying which posture answered it and what would configure it for real. `NOT_CONFIGURED` is
   * doctor's own existing word for "nobody configured this", already green, so the exit map at the
   * rollup below is untouched — the relaxation happened upstream, in the row's status.
   */
  section('onboarding', () => {
    const s = applicabilityLib.survey(DIR, posturePolicy());
    applicability = s;
    const relaxed = s.relaxed || [];
    add('onboarding', s.onboardingComplete ? 'COMPLETE' : 'INCOMPLETE',
      s.onboardingComplete
        ? `all ${s.rows.length} optional contracts are decided — ${s.rows.filter((r) => r.state === 'CONFIGURED').length} configured, `
          + `${s.rows.filter((r) => r.state === 'NOT_APPLICABLE' && !r.postureRelaxed).length} declared not applicable with a reason`
          + (relaxed.length ? `, ${relaxed.length} answered by the declared \`${s.posture.profile}\` posture: ${relaxed.join(', ')}` : '')
        : `${s.unresolved.length} of ${s.rows.length} optional contract(s) undecided: ${s.unresolved.join(', ')}. `
          + 'Run `/respawn` to resolve each one — configure it, or declare it not applicable with a reason. '
          + 'This is not a broken install and not a failure; it is an install nobody has finished answering for.');
    for (const r of s.rows) {
      if (!r.postureRelaxed && (r.state === 'CONFIGURED' || r.state === 'NOT_APPLICABLE')) continue;
      if (!r.postureRelaxed) { add(`onboarding:${r.subsystem}`, r.state, `${r.detail} — ${r.remedy}`); continue; }
      add(`onboarding:${r.subsystem}`, r.state === 'UNDECIDED' ? 'NOT_CONFIGURED' : r.state,
        `${r.detail} — ${r.postureDetail}. ${r.remedy}`);
    }
  });

  // The killed-feature contract: CONFIGURED / NOT_CONFIGURED / UNSUPPORTED, never a silent absence.
  // "Killed features are never re-added" was an absolute with nothing behind it; doctor now says per
  // install whether anything is actually enforcing it.
  section('removals:contract', () => {
    const scan = removalsLib.runRemovalScan(DIR);
    const cfg = removalsLib.readConfig(DIR);
    add('removals:contract',
      !cfg.configured ? 'NOT_CONFIGURED'
        : scan.outcome === 'FAIL' ? 'BROKEN'
          : scan.outcome === 'CANNOT_DETERMINE' ? 'UNSUPPORTED' : 'ACTIVE',
      !cfg.configured
        ? 'no state.removals.liveContentDirs in respawnpack.config.json — nothing scans for reintroduced killed features here'
        : `${scan.rows.length} removal row(s) over ${scan.corpus.files.length} file(s) in ${cfg.liveContentDirs.join(', ')} — ${scan.outcome}`);
  });

  /*
   * ⛔ THE PROVENANCE CONTRACT: IS ANYTHING DECLARED, AND CAN IT BE READ. That is doctor's question,
   * and it is deliberately NOT "do the markers verify" — the savepoint stage and the `lineage` verb
   * answer that one, over the same rows. Reading the DECLARATION rather than running the check is what
   * keeps the two apart: doctor must not recompute a source digest to say whether a project has
   * declared anything, any more than `reconcile:tasks` runs a reconciliation to say it is configured.
   *
   * ⛔ AND AN ABSENT DECLARATION IS NOT_CONFIGURED, WHICH IS GREEN (owner decision 22). Every installed
   * target has no lineage.json on the day this ships. NOT_CONFIGURED maps to NOT_APPLICABLE in
   * DOCTOR_OUTCOME, so no target's exit code moves on upgrade — the whole condition the decision was
   * taken under. A declaration that EXISTS and cannot be used is BROKEN, at exit 1, because that is a
   * fault rather than an answer.
   */
  section('lineage', () => {
    const read = lineageLib.readLineage(DIR);
    if (read.status === 'ABSENT') {
      add('lineage', 'NOT_CONFIGURED',
        `no ${LINEAGE_DECLARATION} — nothing here declares where this project's clones, copies, migrations or generated files came from, `
        + 'so nothing verifies that one of them still matches its source. Declare `sources` and `derivations` there to turn the contract on');
      return;
    }
    if (read.status !== 'OK') {
      add('lineage', 'BROKEN', `${read.detail || `${LINEAGE_DECLARATION} could not be used (${read.status})`} — no source and no derivation was read from it`);
      return;
    }
    const { sources, derivations } = read.doc;
    add('lineage', derivations.length ? 'CONFIGURED' : 'NOT_CONFIGURED',
      derivations.length
        ? `${derivations.length} derivation(s) from ${sources.length} declared source(s) — run \`lineage\` for the per-derivation verdicts`
        : `${LINEAGE_DECLARATION} declares ${sources.length} source(s) and no derivation, so no file's provenance is checked here yet`);
  });

  /*
   * DF-005 reconciliation. Doctor answers "is this wired up", which is a DIFFERENT question from
   * "do the lists agree" — answering the first with the second is exactly how a broken check reads as
   * a clean project. Hence the four states, and hence surveyReconciliation() rather than the verdict.
   */
  section('reconcile:tasks', () => {
    /*
     * ⛔ AND THE SUBSYSTEM ROW ANSWERS FIRST WHEN THE PROFILE LEFT IT OUT (P3-K-14). Touching the lazy
     * handle would throw "could not be loaded" and `section()` would print BROKEN — the stack trace
     * turned into a row, which is right for damage and wrong for a declaration. The kernel-libs section
     * above says the same thing about the same file; this says what it means for the CONTRACT.
     */
    const omittedFor = omittedSubsystem('reconcile');
    if (omittedFor) {
      add('reconcile:tasks', 'NOT_APPLICABLE',
        `the declared \`${omittedFor}\` posture does not install the reconciliation subsystem (ADR-003 ${modhealth.SUBSYSTEMS.reconcile.postureRow}), `
        + "so nothing here compares a task list against this project's own records. Declare `standard` or `strict` and re-run the installer to turn it back on");
      return;
    }
    const s = reconcileLib.surveyReconciliation(DIR);
    add('reconcile:tasks', s.state, s.detail);
  });

  /*
   * ⛔ THE LIVING-SKILL ROW SAYS WHICH SKILLS ARE LIVING HERE, not that the feature exists. README.md
   * advertised living skills for EVERY owned skill while zero .skill-meta.json existed anywhere; the
   * honest per-install answer is a count of canaries actually opted in, and STATIC is a complete state.
   */
  section('skills:living', () => {
    const rows = livingLib.survey(DIR);
    const live = rows.filter((r) => r.outcome === OUTCOME.PASS);
    const broken = rows.filter((r) => r.outcome === OUTCOME.FAIL || r.outcome === OUTCOME.CANNOT_DETERMINE);
    add('skills:living', broken.length ? 'BROKEN' : live.length ? 'ACTIVE' : 'NOT_CONFIGURED',
      broken.length ? broken.map((r) => `${r.name}: ${r.detail}`).join(' | ')
        : live.length ? `${live.length} of ${rows.length} canaries living (${live.map((r) => r.name).join(', ')}); the rest are STATIC skills, which is a supported state`
          : `all ${rows.length} canaries (${livingLib.CANARIES.join(', ')}) are STATIC here — opt in with "living enable <skill>". Every other skill is static by design.`);
  });

  const memDir = path.join(DIR, '.claude', 'skills', 'knowledge');
  add('memory:skill', fs.existsSync(memDir) ? 'ACTIVE' : 'NOT_CONFIGURED', 'the /knowledge skill');

  /*
   * ⛔ THE MEMORY ROW USED TO ASK `which rmem`, WHICH IS THE WRONG QUESTION IN BOTH DIRECTIONS. `rmem`
   * is the bin of a private, unpublished package; it was never going to be on PATH, and if it somehow
   * were, that would say nothing about whether THIS project's memory works. What replaces it is the
   * distribution this target actually has, and — for the engine — a REAL MCP handshake and a REAL
   * write/retrieve round trip through the recorded entry point (kernel/lib/memory.js).
   *
   * File-backed memory is not a degraded state. It is the zero-setup default, and it reports ACTIVE.
   */
  section('memory:distribution', () => {
    const dist = memoryLib.distribution(DIR);
    add('memory:distribution', dist.mode === 'file' ? 'ACTIVE' : (dist.entry && dist.registered ? 'ACTIVE' : 'BROKEN'), dist.detail);
    if (dist.mode === 'engine') {
      const v = memoryLib.probe(DIR);
      add('memory:engine', v.outcome === OUTCOME.PASS ? 'ACTIVE' : 'BROKEN', v.detail);
    } else {
      add('memory:engine', 'NOT_CONFIGURED', 'no engine installed — re-run the installer with --with-memory for semantic and graph-augmented recall');
    }
  });

  /*
   * ⛔ ONE ROLLUP, THE SAME ONE EVERY OTHER VERB USES (K-09, anti-drift items 1 and 2).
   *
   * This used to be a bespoke three-branch expression over a private `GREEN` allowlist — the second
   * verdict-to-exit map in the kernel. The allowlist itself was hard-won and is NOT discarded: it now
   * lives, word for word, in `DOCTOR_OUTCOME` above, where every green word maps to PASS or
   * NOT_APPLICABLE (both exit 0) and everything absent falls through to CANNOT_DETERMINE. What is gone
   * is the second exit map, not the classification.
   *
   * The original reasoning, kept because it is what the allowlist encodes: `state:STATE.json UNKNOWN`
   * means freshness could not be established AT ALL, and under the old denylist it fell through to PASS
   * at exit 0. "I could not tell" is not "fine". So a word must be classified to be green, and the next
   * word someone adds is CANNOT_DETERMINE until somebody deliberately says otherwise.
   *
   * `rollup` takes the worst outcome by outcome.js's RANK — FAIL beats CANNOT_DETERMINE beats PASS beats
   * NOT_APPLICABLE — which reproduces the old branches exactly: any BROKEN row is FAIL; otherwise any
   * unclassified word is CANNOT_DETERMINE; otherwise every row was green and the run exits 0.
   */
  const worst = rollup(rows);
  return { outcome: worst, rows, applicability };
}

/*
 * `contract` — set or read the interaction contract (ADR-001, decision 1).
 *
 * Three experiences, and the whole design rests on the boundary between them:
 *   collaborate  the DEFAULT. Prose works, no command required, ceremony matches the size of the
 *                change, read-only turns close nothing out. This is the absence of a file.
 *   delegate     one bounded task with acceptance criteria. Finishes, then stops. Does NOT become an
 *                indefinite autonomous scheduler.
 *   goal         explicit autonomous work under stated constraints.
 *
 * ⛔ GOAL MODE IS NEVER INFERRED. A task being hard is not consent. That principle is mechanized here
 * rather than asserted in prose: entering goal mode REQUIRES a stated goal and stated completion
 * criteria, and the command refuses without them. An autonomous loop whose author could not say what
 * "done" means is the exact configuration that produced a multi-day run ending in a manufactured
 * completion claim.
 *
 * The contract lives in ephemeral runtime state (.respawnpack/runtime/, gitignored). That is
 * deliberate: it must survive a session boundary — a goal continues across fresh sessions — but it is
 * machine-local operating state, never project truth to be committed.
 */
/*
 * ⛔ THE PHASE END IS THE ONE MOMENT THIS PACK CAN NAME WITHOUT INFERENCE (owner decision 23), AND IT
 * IS THE ONLY THING THAT TRIGGERS A REPORT AUTOMATICALLY. A goal closing is a fact the kernel already
 * established mechanically, one criterion at a time; "a session felt finished" is not, and no amount of
 * heuristics would make it one.
 *
 * ⛔ AND THE REPORT CAN NEVER MOVE THE CLOSURE, IN EITHER DIRECTION (anti-drift item 9). It runs ONLY
 * after a successful close, so a refused goal writes nothing at all; an already-closed idempotent
 * retry writes nothing either, because it closed nothing this time. When the write fails, the failure
 * rides back as its own row with its own outcome and the closure's own PASS is untouched: a goal that
 * genuinely met every stated criterion did not stop having done so because a markdown file could not
 * be created, and reporting it as CANNOT_DETERMINE would be a fresh false negative in a verb whose
 * whole job is to refuse false positives.
 */
function withGoalReport(closed) {
  if (closed.outcome !== OUTCOME.PASS || closed.alreadyClosed || flag('--no-aar')) return closed;
  const id = closed.completed && closed.completed.id;
  const goalDoc = stateLib.readGoalDoc(DIR);
  const title = (id && goalDoc.goals[id] && goalDoc.goals[id].goal) || (id ? `goal ${id}` : 'goal completed');
  let report;
  try {
    report = aarLib.compose(DIR, { title, write: true });
  } catch (e) {
    report = {
      outcome: OUTCOME.CANNOT_DETERMINE, wrote: null, path: null,
      checks: [result(OUTCOME.CANNOT_DETERMINE, 'aar:write', `the After Action Report could not be composed: ${(e && e.message) || e}. The goal closure above stands.`, { checked: 0 })],
    };
  }
  return {
    ...closed,
    aar: { outcome: report.outcome, wrote: report.wrote, path: report.path, checks: report.checks },
  };
}

function cmdContract() {
  const mode = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;

  /*
   * ⛔ INSPECTION AND CLOSURE READ THE CONTRACT THE SAME WAY, THROUGH THE SAME BOUNDARY, ONCE.
   *
   * This verb used to have TWO readers: a raw `readJSON` for the no-argument inspection, and the
   * closeout module's null-collapsing one for everything that acts. So `contract` could print "collaborate" for a file
   * that was merely mid-rename, and every SETTING path — collaborate, delegate, goal — took its
   * `suspendedGoalId` from a `{}` produced by the same collapse and silently dropped the goal it was
   * supposed to be suspending. `complete` took its TARGET from it, and closed the goal instead of the
   * delegation. One read, classified, before any branch decides anything.
   */
  const read = closeout.readRuntimeClassified(DIR);
  if (read.status !== 'OK' && read.status !== 'ABSENT') {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE,
      error: `the runtime contract at ${closeout.RUNTIME_REL} is ${read.status} — ${read.detail}. Nothing was changed.\n`
        + 'This is NOT collaborate. Collaborate is the absence of a contract file; this is a contract file that could '
        + 'not be read, and reporting the two as the same answer is how an unreadable file ends an autonomous run on paper '
        + 'while it continues in fact. Repair or remove the file, then retry.',
      contractStatus: read.status,
    };
  }
  const cur = read.contract;

  if (!mode) {
    return {
      outcome: OUTCOME.PASS,
      contract: read.status === 'ABSENT' ? { mode: 'collaborate', source: 'default (no contract file)' } : cur,
    };
  }

  const list = (v) => (v ? String(v).split(';').map((s) => s.trim()).filter(Boolean) : []);
  const setRuntime = (c) => closeout.writeRuntime(DIR, c);

  /*
   * ⛔ `complete` IS THE EXIT, AND THERE IS EXACTLY ONE OF IT. Both closures live in
   * kernel/lib/closeout.js so the CLI, the prose-first path an agent follows without being told a
   * command, and any future caller cannot end up with three subtly different ideas of what "done"
   * does to the runtime pointers.
   */
  if (mode === 'complete') {
    const evidence = valueOf('--evidence', null);
    const note = valueOf('--note', null);
    // `--met` is repeatable: one per acceptance criterion being attested.
    const met = argv.reduce((acc, a, i) => (a === '--met' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
    const runtime = cur; // the one classified read above — never a second, differently-interpreted one

    /*
     * ⛔ WHICH CONTRACT IS BEING CLOSED IS NEVER LEFT TO WHATEVER MODE HAPPENS TO BE ACTIVE. Closing a
     * delegation RESTORES the goal it suspended, so an idempotent retry of that same command — after a
     * crashed turn, which is the ordinary case — would arrive with runtime already back in goal mode
     * and close the GOAL instead. An explicit target, and `--met` implying `delegate` because that is
     * the only closure attestations belong to, makes the retry mean what it meant the first time.
     */
    const explicit = argv[2] === 'delegate' || argv[2] === 'goal' ? argv[2] : null;
    const target = explicit || (met.length ? 'delegate' : runtime.mode === 'delegate' ? 'delegate' : 'goal');
    if (target === 'delegate') return closeout.completeDelegation(DIR, { met, evidence, note });

    const closed = closeout.completeGoal(DIR, { evidence, note });
    return withGoalReport(closed);
  }

  /*
   * ⛔ COLLABORATE SUSPENDS A GOAL; IT DOES NOT DESTROY ONE. Deleting the contract on the way to
   * collaborate made goal → collaborate → goal an expensive, lossy round trip — the opposite of the
   * "transitions are free and cheap" property ADR-001 promises. The durable goal lives in
   * docs/derived/state/goal.json and is never touched here; runtime only stops pointing at it.
   */
  const activeOf = closeout.activeOf; // one definition, shared with the closeout transition

  if (mode === 'collaborate') {
    const suspending = activeOf(cur) || cur.suspendedGoalId || null;
    setRuntime({ mode: 'collaborate', activeGoalId: null, suspendedGoalId: suspending });
    return {
      outcome: OUTCOME.PASS,
      contract: { mode: 'collaborate', suspendedGoalId: suspending },
      note: suspending
        ? `autonomy suspended. The ONGOING goal ${suspending} is untouched — its contract lives in ${stateLib.STATE_DIR}/goal.json and still appears in durable state. Resume autonomy with: contract goal --resume`
        : 'collaborate is the default; nothing was suspended',
    };
  }

  if (mode === 'delegate') {
    const task = valueOf('--task', null);
    if (!task) return { outcome: OUTCOME.FAIL, error: 'delegate requires --task "<what to finish>"' };
    // ⛔ "A bounded task WITH ACCEPTANCE CRITERIA" was the documented claim while the CLI happily
    // accepted an empty list — a bounded task with no definition of done is just an unbounded one with
    // a shorter description. The agent may derive obvious criteria from the request without asking; it
    // may not record none.
    const acceptance = list(valueOf('--acceptance', ''));
    if (!acceptance.length) {
      return {
        outcome: OUTCOME.FAIL,
        error: 'delegate requires --acceptance "<criterion>;<criterion>" — what makes this task done. ' +
          'Derive the obvious criteria from the request rather than interrogating the user; only ask when ' +
          'the ambiguity would materially change the result.',
      };
    }
    const c = {
      mode: 'delegate', task, acceptance,
      authority: list(valueOf('--authority', '')),
      forbidden: list(valueOf('--forbidden', '')),
      activeGoalId: null,
      suspendedGoalId: activeOf(cur) || cur.suspendedGoalId || null, // a delegation does not cancel a goal either
    };
    setRuntime(c);
    return { outcome: OUTCOME.PASS, contract: c, note: 'bounded task — this finishes and stops; it does not become an autonomous scheduler' };
  }

  if (mode === 'goal') {
    const doc = stateLib.readGoalDoc(DIR);

    const ongoing = doc.ongoingGoalId || doc.activeGoalId || null;

    // Resume — re-point runtime autonomy at a goal the PROJECT is already pursuing. The goal never
    // went anywhere; only this machine's autonomy did.
    if (flag('--resume') || (!valueOf('--goal', null) && (cur.suspendedGoalId || ongoing))) {
      const id = valueOf('--id', cur.suspendedGoalId || ongoing);
      const g = doc.goals[id];
      if (!g) return { outcome: OUTCOME.FAIL, error: `no goal "${id}" recorded in ${stateLib.STATE_DIR}/goal.json — nothing to resume` };
      setRuntime({ mode: 'goal', activeGoalId: id, suspendedGoalId: null });
      return { outcome: OUTCOME.PASS, contract: { mode: 'goal', activeGoalId: id, goal: g.goal, completion: g.completion }, note: `autonomy resumed on the ongoing goal ${id}` };
    }

    const goal = valueOf('--goal', null);
    const completion = list(valueOf('--completion', ''));
    const missing = [];
    if (!goal) missing.push('--goal "<the large goal>"');
    if (!completion.length) missing.push('--completion "<criterion>;<criterion>"');
    if (missing.length) {
      return {
        outcome: OUTCOME.FAIL,
        error: `goal mode requires ${missing.join(' and ')}. Goal mode is never inferred — a task being ` +
          'hard is not consent, and an autonomous loop whose author cannot state what "done" means is ' +
          'the configuration that manufactures completion claims.',
      };
    }

    // The DURABLE half: tracked, portable, survives a clone. Written once, pointed at from runtime.
    const id = valueOf('--id', `G-${new Date().toISOString().slice(0, 10)}-${Object.keys(doc.goals).length + 1}`);
    doc.goals[id] = {
      id, goal, completion,
      constraints: list(valueOf('--constraints', '')),
      authority: list(valueOf('--authority', '')),
      forbidden: list(valueOf('--forbidden', '')),
      externalBlockers: list(valueOf('--blockers', '')),
      createdAt: new Date().toISOString(),
      contextStages: { checkpoint: 60, closeout: 75, handoff: 85 },
      hostNote: 'No hook can create a session. At the handoff stage this pack produces a VERIFIED handoff and says so — it does not claim a continuation that did not happen.',
    };
    // `ongoingGoalId` is the PROJECT's lifecycle field: what this project is pursuing, tracked and
    // portable. Runtime separately points this machine's autonomy at it.
    doc.ongoingGoalId = id;
    delete doc.activeGoalId; // retire the pre-2d spelling on write
    stateLib.writeGoalDoc(DIR, doc);
    setRuntime({ mode: 'goal', activeGoalId: id, suspendedGoalId: null });

    return {
      outcome: OUTCOME.PASS,
      contract: { mode: 'goal', activeGoalId: id, ...doc.goals[id] },
      note: `durable contract written to ${stateLib.STATE_DIR}/goal.json (tracked, travels with the repo); ` +
        `this machine's autonomy now points at ${id} via gitignored runtime state, so a clone sees the ongoing ` +
        'goal but starts in collaborate. Completion is decided by these criteria, not by the requirement denominator.',
    };
  }

  return { outcome: OUTCOME.FAIL, error: `unknown contract mode "${mode}" — expected collaborate | delegate | goal | complete` };
}

/*
 * `gate` — the quality gate as a computation. See kernel/lib/gate.js for why this is a program rather
 * than four YAML steps with skip branches: prose in a CI log has no exit code, and a skipped step
 * exits 0, which is how a workflow named "quality gate" reported green having run nothing.
 */
function cmdGate() {
  /*
   * ⛔ THE VERB'S ONE POSTURE CONSULT, TAKEN HERE AND HANDED DOWN ALREADY DECIDED (ADR-003 kernel:R9).
   *
   * `gate` is a one-row verb, so "once per verb" is literally once: the policy comes from the same
   * memoized resolution `savepoint` and `doctor` read, the relaxing predicate is the one
   * `applicability` owns, and the rule id is the one `gate.js` declares for the branch it governs.
   * gate.js is handed `{profile, rule}` or nothing — never the config, never the resolver — because
   * ADR-003 settled that there is exactly one reader of a project's posture and it lives in `hooks/`.
   */
  const rule = gateLib.POSTURE_ROW;
  const posture = postureRelaxes(rule) ? { profile: posturePolicy().profile, rule } : null;
  const r = gateLib.runGate(DIR, { posture });
  // K-09: one exit map for the whole pack. This used to read gate.js's own EXIT table, which agreed
  // with exitCodeFor only for as long as somebody kept the two tables agreeing.
  const out = { ...r, exitCode: exitCodeFor(r.outcome) };

  /*
   * ⛔ `--verdict-file` EXISTS SO THE GATE RUNS ONCE. The workflow used to invoke the gate a second
   * time to produce its artifact — which re-ran the project's tests and builds, could return a
   * different flaky verdict, published something that was not the run that decided CI, and needed a
   * `|| true` to avoid failing the job twice. Writing the verdict from THIS invocation removes the
   * reason to invoke it again. Preferred over `| tee` because it keeps the human-readable output in
   * the log, needs no `set -o pipefail`, and behaves identically on a runner with no POSIX shell.
   */
  const vf = valueOf('--verdict-file', null);
  if (vf) {
    try { stateLib.writeAtomic(path.resolve(DIR, vf), JSON.stringify(out, null, 2) + '\n'); }
    catch (e) { console.error(`  ⚠️ could not write the verdict file ${vf}: ${e.message}`); }
  }
  return out;
}

/*
 * `readiness` — the production-readiness checklist, found from the tree rather than asserted in prose.
 * See kernel/lib/readiness.js for why the items are DETECTED (four archetypes, four different
 * questions) and why an item that does not apply is not a row.
 */
function cmdReadiness() {
  /*
   * ⛔ THE VERB'S ONE POSTURE CONSULT, TAKEN HERE AND HANDED DOWN ALREADY DECIDED (ADR-003
   * `kernel:readiness`), exactly as `cmdGate` takes `kernel:R9`. `applicability.relaxes()` owns which
   * RESOLUTIONS relax (DECLARED only) and which VERDICTS do (`off`, `advise`); `_posture.verdict` owns
   * the word for this row under this profile. readiness.js is handed `{profile, rule, verdict}` or
   * nothing — never the config and never the resolver — because ADR-003 settled that a project's
   * posture has exactly one reader and it lives in `hooks/`.
   *
   * ⛔ AND NOTHING RELAXES WITHOUT A DECLARATION, so an undeclared, unreadable or invalid posture
   * reaches the full list with FAIL rows failing the verb: the same answer this checklist would have
   * given on the day it shipped, which is the migration guarantee every other posture consumer keeps.
   */
  const rule = readinessLib.POSTURE_ROW;
  const posture = postureRelaxes(rule)
    ? { profile: posturePolicy().profile, rule, verdict: posturePolicy().verdict(rule) }
    : null;
  const r = readinessLib.runReadiness(DIR, {
    posture,
    exception: (item) => exceptionFor('readiness', { item }),
  });
  return { ...r, exitCode: exitCodeFor(r.outcome) };
}

/*
 * `site` — this repository's own documents, browsable, and served on the loopback interface.
 *
 * ⛔ IT IS A PROJECTION AND NOTHING ELSE (anti-drift item 53). The build reads tracked documents and
 * writes only under `--out` (default `.respawnpack/site/`, which is gitignored); it edits no tracked
 * file, offers no editing surface, and is rebuilt rather than amended. `state.html` reads the compiled
 * state through `hooks/_runtime.js`'s `readDurableState` — the reader the SessionStart hook, `status`
 * and `doctor` already share — so a page that shows counts and a boot banner that withholds them can
 * never be looking at the same tree.
 *
 * ⛔ `--serve` IS THE ONE VERB THAT DOES NOT EXIT. Everything else in this file computes a verdict and
 * leaves; a viewer has to stay up until its operator stops it. The dispatch tail below therefore skips
 * `process.exit` when a server started, which is why the handle travels back on `serving` rather than
 * the verb blocking here: the rows are printed first, and the exit code of a run that is still running
 * is a question with no answer.
 */
function cmdSite() {
  const outArg = valueOf('--out', null);
  const serveIndex = argv.indexOf('--serve');
  const wantsServer = serveIndex >= 0;
  // `--serve` takes an OPTIONAL port, so the next token counts only when it is not another flag.
  const portArg = wantsServer && argv[serveIndex + 1] && !argv[serveIndex + 1].startsWith('--') ? argv[serveIndex + 1] : null;

  const built = siteLib.buildSite(DIR, outArg ? { out: outArg } : {});
  if (!wantsServer) return built;
  if (built.outcome === OUTCOME.FAIL) {
    return { ...built, error: 'the site did not build, so there is nothing to serve — fix the row above and re-run' };
  }
  /*
   * The promise is handed back rather than awaited: this function is called synchronously by the
   * dispatcher, and a rejected start must reach the same exit-1 path a thrown verb would.
   */
  return { ...built, serving: siteLib.serve({ out: built.out, port: portArg === null ? 0 : Number(portArg) }) };
}

/*
 * `memory` — candidate memories: automatic capture happens inside `savepoint`; this verb is the
 * REVIEW surface (decision #4). `respawnpack memory candidates` lists every captured lead with its
 * verificationState; `promote`/`reject` are the only two ways a lead ever changes state, and both are
 * explicit, audited, and idempotent — core/memory/candidates.js: a repeat is a recorded no-op pointing
 * at the first, never a second record. All three use the shared four-outcome exit codes.
 */
function cmdMemory() {
  if (!core) {
    return { outcome: OUTCOME.CANNOT_DETERMINE, error: 'core/ (the host-neutral rollover core) could not be loaded, so no candidate-memory operation could run — run `doctor`.' };
  }
  const noun = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  if (noun !== 'candidates') {
    return { outcome: OUTCOME.FAIL, error: `unknown "memory" noun "${noun || ''}" — expected "candidates" (memory candidates [promote <id>|reject <id>])` };
  }
  const action = argv[2] && !argv[2].startsWith('--') ? argv[2] : 'list';
  if (action === 'list') return cmdMemoryCandidatesList();
  if (action === 'promote') return cmdMemoryCandidatesPromote(argv[3] && !argv[3].startsWith('--') ? argv[3] : null);
  if (action === 'reject') return cmdMemoryCandidatesReject(argv[3] && !argv[3].startsWith('--') ? argv[3] : null);
  return { outcome: OUTCOME.FAIL, error: `unknown "memory candidates" action "${action}" — expected list | promote <id> | reject <id>` };
}

function cmdMemoryCandidatesList() {
  const r = core.candidates.list(memoryStoreDir());
  const records = r.status === 'OK' ? r.records : [];
  const counts = { candidate: 0, verified: 0, rejected: 0 };
  for (const rec of records) counts[rec.verificationState] = (counts[rec.verificationState] || 0) + 1;
  const sorted = records.slice().sort((a, b) => (a.provenance.at < b.provenance.at ? -1 : a.provenance.at > b.provenance.at ? 1 : 0));
  // decision #3 — every row carries the ACTUAL rendering this pack ships for recall, not a
  // re-description of it: core.candidates.renderForRecall() is the one path that prefixes an
  // unverified item with its marker (and omits a rejected one from recall entirely), so `lead` here
  // is exactly what an agent reading this list would be right to repeat, verbatim, to a human.
  const rows = sorted.map((rec) => ({
    id: rec.id, klass: rec.klass, verificationState: rec.verificationState, claim: rec.claim,
    capturedBy: rec.provenance.by, cycleId: rec.provenance.cycleId, at: rec.provenance.at,
    verifiedBy: rec.verification ? rec.verification.by : null,
    rejectedWhy: rec.rejection ? rec.rejection.reason : null,
    lead: rec.verificationState === 'rejected' ? null : core.candidates.renderForRecall([rec])[0],
  }));
  return {
    outcome: (r.unreadable && r.unreadable.length) ? OUTCOME.CANNOT_DETERMINE : OUTCOME.PASS,
    candidates: rows, counts, unreadable: r.unreadable || [],
  };
}

function cmdMemoryCandidatesPromote(id) {
  if (!id) return { outcome: OUTCOME.FAIL, error: 'promote requires a candidate id: memory candidates promote <id> --as <type>/<slug> --verified-by "<what proved it>"' };
  const as = valueOf('--as', null);
  const verifiedBy = valueOf('--verified-by', null);
  const by = valueOf('--by', null);
  if (!as || as.indexOf('/') <= 0 || as.endsWith('/')) {
    return { outcome: OUTCOME.FAIL, error: 'promote requires --as <type>/<slug> — the graph entity this becomes, e.g. --as gotcha/redis-retry-starvation' };
  }
  if (!verifiedBy || !verifiedBy.trim()) {
    return { outcome: OUTCOME.FAIL, error: 'promote requires --verified-by "<what proved it>" — promotion without a stated verification is the exact failure mode this gate exists to refuse' };
  }

  const read = core.candidates.read(memoryStoreDir(), id);
  if (read.status === 'ABSENT') return { outcome: OUTCOME.FAIL, error: `no candidate ${id} in this store` };
  if (read.status !== 'OK') return { outcome: OUTCOME.CANNOT_DETERMINE, error: `candidate ${id} could not be read (${read.detail || read.status})` };
  // Structurally unreachable via the public API — capture()/read() already refuse an invalid klass
  // through validate() — named explicitly rather than trusted silently, in case that invariant weakens.
  if (!core.candidates.KLASSES.includes(read.record.klass)) {
    return { outcome: OUTCOME.FAIL, error: `candidate ${id} has klass "${read.record.klass}", outside the promotable set (${core.candidates.KLASSES.join(', ')})` };
  }

  const slashAt = as.indexOf('/');
  const type = as.slice(0, slashAt);
  const slug = as.slice(slashAt + 1);

  const promoted = core.candidates.promote(memoryStoreDir(), id, { by, evidencePaths: [verifiedBy], note: verifiedBy });
  if (promoted.status === 'REFUSED' || promoted.status === 'CANNOT_DETERMINE') {
    return { outcome: promoted.status === 'CANNOT_DETERMINE' ? OUTCOME.CANNOT_DETERMINE : OUTCOME.FAIL, error: promoted.reason, status: promoted.status };
  }

  /*
   * ⛔ THE GRAPH WRITE USES WHAT THE STORE ACTUALLY RECORDED, NEVER RAW ARGS FROM THIS INVOCATION.
   * core/memory/candidates.js's promote() is idempotent at the record level — "the second promotion
   * rewrote the first one" is false, by its own test — and this write must not undo that one layer up.
   * If THIS call's --verified-by were used unconditionally, a repeat with DIFFERENT text would
   * silently mutate the canonical graph file while the store stayed on the first value: the graph and
   * the record would disagree about which promotion is real. Reading it back off `promoted.record`
   * means a genuine repeat (ALREADY_VERIFIED) re-writes the SAME bytes — a harmless idempotent no-op —
   * and only a first-time PROMOTED call ever writes the text just typed.
   */
  const recordedVerification = promoted.record.verification || { note: verifiedBy, by, evidencePaths: [verifiedBy] };
  const graph = writeGraphEntity(type, slug, promoted.record, {
    verifiedBy: recordedVerification.note || (recordedVerification.evidencePaths || [])[0] || verifiedBy,
    by: recordedVerification.by,
  });
  if (!graph.ok) {
    return {
      // refused: a real, deliberate conflict (a different --as already promoted) — FAIL.
      // anything else: an engine/IO fault after the store already committed — CANNOT_DETERMINE.
      outcome: graph.refused ? OUTCOME.FAIL : OUTCOME.CANNOT_DETERMINE,
      error: `candidate ${id} was promoted in the store but the graph entity could not be written: ${graph.detail}`,
      status: promoted.status,
    };
  }
  return {
    outcome: OUTCOME.PASS, status: promoted.status, id, entity: `${type}/${slug}`,
    file: path.relative(DIR, graph.file).split(path.sep).join('/'),
    alreadyPromoted: promoted.status === 'ALREADY_VERIFIED',
  };
}

function cmdMemoryCandidatesReject(id) {
  if (!id) return { outcome: OUTCOME.FAIL, error: 'reject requires a candidate id: memory candidates reject <id> --why "<reason>"' };
  const why = valueOf('--why', null);
  const by = valueOf('--by', null);
  if (!why || !why.trim()) return { outcome: OUTCOME.FAIL, error: 'reject requires --why "<reason>" — an unexplained rejection cannot be reviewed' };
  const r = core.candidates.reject(memoryStoreDir(), id, { by, reason: why });
  if (r.status === 'REFUSED' || r.status === 'CANNOT_DETERMINE') {
    return { outcome: r.status === 'CANNOT_DETERMINE' ? OUTCOME.CANNOT_DETERMINE : OUTCOME.FAIL, error: r.reason, status: r.status };
  }
  return { outcome: OUTCOME.PASS, status: r.status, id, alreadyRejected: r.status === 'ALREADY_REJECTED' };
}

// --- dispatch ---------------------------------------------------------------------------------

const VERBS = { state: cmdState, savepoint: cmdSavepoint, status: cmdStatus, doctor: cmdDoctor, contract: cmdContract, gate: cmdGate, readiness: cmdReadiness, removals: cmdRemovals, lineage: cmdLineage, aar: cmdAar, living: cmdLiving, reconcile: cmdReconcile, memory: cmdMemory, site: cmdSite, 'restore-derived': cmdRestoreDerived };

if (!verb || verb === '--help' || verb === '-h' || !VERBS[verb]) {
  console.log(`respawnpack <verb> [--dir <path>] [--json]

  state                compile docs/derived/STATE.json from the structured sources
  savepoint [--verify] regenerate state, verify the write by digest, verify every rendered claim
                       against its source, run adapters, and capture evidence-backed candidate
                       memories. Verification is ALWAYS ON; --verify is accepted as an explicit
                       no-op for compatibility — there is no flag that turns it off.
                       TWO VERDICTS: integrity (did the machinery work) and coverage (which
                       optional contracts are configured, declared not applicable, or still
                       undecided). The exit code is the worse of the two, so a project with
                       unresolved contracts reads as unfinished rather than as broken, and still
                       does not exit 0.
             --write   also rewrite STATE.json and the rendered derived docs. Without it the
                       run is check-only: the fresh compile is verified IN MEMORY against the
                       STATE.json on disk (created only if absent) and nothing on disk changes.
             --only <stages>  · --skip <stages>   run a SUBSET of the ten stages, comma-separated:
                       ${SAVEPOINT_STAGES.join(', ')}.
                       Every stage that does not run emits a NOT_APPLICABLE row saying it was SKIPPED
                       BY REQUEST, and the receipt records the set — a partial run can never be
                       mistaken for a full one, and a skipped check is never reported as a passing
                       one. \`compile\` is REQUIRED by every stage after it, so a scope that omits it
                       is refused rather than run against whatever STATE.json is already on disk. An
                       unknown stage name is refused too, and nothing runs.
             --candidate "kind:text"   (repeatable) record an operator-supplied candidate memory —
                       kind is one of ${MEMORY_KLASSES.join('|')}. This is how a
                       resolved root-cause/fix pair enters memory: savepoint never infers one from a
                       diff (ADR-001).
  restore-derived <CONTINUITY.md|GAPS.md> [--write]
                       put back the pre-kernel original that savepoint --write archived. This is what
                       makes the migration a door rather than a one-way door: a hand-authored derived
                       doc is archived verbatim to docs/derived/_archive/<name>.pre-kernel.md, and
                       this restores it. Preview by default; --write performs it. The archive is
                       never deleted, so migrate → restore → migrate all resolve to the same original.
  status               short current-state summary
  doctor               what is installed, configured, unsupported, stale, or silently inactive —
                       including an "onboarding" row that says COMPLETE or INCOMPLETE, and an
                       "applicability" survey naming every optional contract nobody has decided yet
  gate                 run the quality gate. Outcomes are the pack's four, and each row also carries
                       the gate's own word as its label: PASS · FAIL · NOT_APPLICABLE (declared only) ·
                       NOT_CONFIGURED and COULD_NOT_RUN, both CANNOT_DETERMINE.
                       Exit 0 PASS · 0 NOT_APPLICABLE · 1 FAIL · 2 CANNOT_DETERMINE.
                       A run that executed no meaningful check is NEVER green.
       --verdict-file <path>   write this run's verdict as JSON, so CI never has to invoke the
                               gate a second time to produce an artifact.
  readiness            the production-readiness checklist, FOUND from the tree rather than asserted:
                       a README, a CI workflow, a test command, secret scanning in CI, a filled
                       CODEOWNERS, a LICENSE, a lockfile, ignored env files, and the archetype's own
                       items (a Terraform remote backend, no plaintext credentials in a variable file
                       or inventory, vaulted inventories, a health route, migrations, error tracking,
                       a docs index and a link check). An item that does not apply here is not a row.
                       The declared posture SCALES it (ADR-003 kernel:readiness): \`light\` asks the
                       essential tier, \`standard\` the full list, both as advice with every row still
                       printed; \`strict\` asks the full list and a FAIL fails the verb. An item the
                       founder has judged is excepted by name in respawnpack.config.json's
                       \`exceptions\` list, with a reason, and the lift is reported in every posture.
                       Zero applicable items is CANNOT_DETERMINE, never a pass.
  living [status|enable|regenerate|reset] [<skill>]
                       the living-skill lifecycle, for the three canaries it is PROVEN on:
                       debug, savepoint, knowledge. Opt-in per project — a default install activates
                       nothing, and every other skill is a fully supported STATIC skill. The overlay is
                       derived only from memory entities keyed applies-to|skill:<name>, each line
                       carrying its date, confidence and source path. --write applies a regeneration.
  removals             the killed-feature contract: scan every configured live-content directory for a
                       LIVE assertion that reintroduces a retired feature. Quoting a retirement, a
                       history section, a blockquote and a declared history path do not count. Zero
                       configured directories or zero registry rows is NEVER a pass.
  lineage              the provenance contract: for every derivation this project DECLARES in
                       docs/derived/state/lineage.json, does the derived file record which source it
                       came from, is that source one the derivation allows, and does the source still
                       hash to what the marker recorded? A marker is verified, never trusted. A marker
                       naming a \`neverFrom\` source, or a source that has moved since, is FAIL. A missing
                       marker, an unreadable source and a URL source this pack cannot digest are each
                       CANNOT_DETERMINE naming why. No declaration at all is NOT_APPLICABLE at exit 0 —
                       it is not an onboarding contract and no target's exit code moves without one.
  lineage seed [--write]
                       propose the sources this project already has, by evidence file: a Terraform root
                       (a directory whose *.tf files declare a terraform { or provider " block), an
                       Ansible control config and its inventories, compose files, a Kustomize overlay, a
                       Pulumi project, an OpenAPI/Swagger document, a Prisma or SQL schema, and the Node
                       package manifest — never a derivation, which is the founder's own knowledge to
                       declare. Prints the proposed document, the evidence per row, and the count; a
                       repository with nothing to propose says so at exit 0.
             --write   write the proposal to docs/derived/state/lineage.json, ONLY when no such file
                       exists yet. Refuses at exit 2, naming the existing file, otherwise — this never
                       overwrites a founder's own declaration.
  lineage stamp <target> --from <sourceId> [--sidecar]
                       write the provenance marker into <target>, after you clone, copy, migrate or
                       generate it: a comment in its own syntax naming <sourceId> and that source's
                       current digest, in the form its extension implies (# // <!-- --> -- /* */); an
                       extension this pack does not know, or --sidecar, writes <target>.lineage.json
                       instead. Refuses an unknown source id or a target outside the project or that does
                       not exist yet, both CANNOT_DETERMINE; refuses a source any derivation covering the
                       target declares in neverFrom, FAIL, naming the derivation, before a byte is
                       written. An existing marker for the same target is REPLACED, never duplicated.
                       Prints the digest it recorded.
  aar [--since <rev>] [--until <rev>] [--title <t>] [--write]
                       the After Action Report: one document, bottom line first, composed from records
                       this project already keeps — the compiled state at each end of the window, the
                       commits, the derived changelog entries dated inside it, and (machine-local, and
                       labelled as such) the last savepoint receipt, the candidate journal, the
                       delegation archive and any task-attempt receipts. The window ends at HEAD unless
                       --until says otherwise, and starts at the last report's end, else at the base of
                       the current savepoint-only chain, else at the root commit; every default is
                       stated in the document. Counts are WITHHELD, never caveated, for an end whose
                       committed STATE.json did not describe that revision, and a candidate is an
                       unverified lead unless the journal records it promoted. Preview by default;
                       --write creates docs/derived/aar/<until-date>-<slug>.md and REFUSES at exit 2
                       rather than overwrite an existing report. \`contract complete goal\` writes one
                       after a successful close unless --no-aar.
  reconcile            DEPRECATED, an alias for savepoint --only compile,reconcile. DF-005: do the
                       harness task list and the project's own gap/gate records agree? Prints one
                       deprecation line naming the replacement; rows and exit code are unchanged. Script
                       against savepoint --only compile,reconcile directly.
  site [--out <dir>] [--serve [port]]
                       build this repository's own documents into a static site you can read: every
                       markdown file under docs/ and memory/graph/ plus the root README, one HTML page
                       each, with an index, a sidebar tree, breadcrumbs and a per-page outline, and a
                       state.html dashboard that reads STATE.json through the SAME freshness rule the
                       boot banner uses — CURRENT shows the counts, anything else shows the banner and
                       WITHHOLDS every number. It is a PROJECTION: it writes only under --out (default
                       .respawnpack/site/, gitignored), never edits a tracked file, and a rebuild of an
                       unchanged tree is byte-identical. An --out inside a directory the build READS is
                       refused; outside the project is allowed.
                       --serve binds 127.0.0.1 and nothing else (never 0.0.0.0, never ::), serves the
                       output read-only, refuses path traversal, and stops on Ctrl-C. Diagrams are drawn
                       by the reader's own browser from one pinned CDN script, on the pages that carry
                       one; nothing is downloaded by this pack, and every diagram's source is on the page.
  memory candidates    list captured candidate memories (id, klass, verificationState, claim) —
                       automatic capture happens inside savepoint; this is the review surface.
  memory candidates promote <id> --as <type>/<slug> --verified-by "<what proved it>" [--by "<who>"]
                       promote a candidate into memory/graph/<type>/<slug>.md. REFUSED without
                       --verified-by (an unstated verification is the exact failure mode this exists
                       to refuse), for a kind outside decision|constraint|finding|root-cause-fix, or
                       for an already-rejected candidate. Idempotent: promoting the same id to the
                       same --as twice is a recorded no-op; a DIFFERENT --as on an already-promoted
                       id is refused rather than silently forking the entity.
  memory candidates reject <id> --why "<reason>" [--by "<who>"]
                       reject a candidate. Idempotent; an unexplained rejection is refused.
  contract             show the active interaction contract
  contract collaborate clear it — collaborate is the default and needs no command
  contract delegate    --task "..." --acceptance "a;b" [--authority "..."] [--forbidden "..."]
                       acceptance is REQUIRED — a bounded task with no definition of done is an
                       unbounded one with a shorter description. Derive the criteria from what the
                       user already said; ask only when the ambiguity changes what you build.
  contract goal        --goal "..." --completion "a;b" [--constraints "..."] [--authority "..."]
                       [--forbidden "..."] [--id G-1] | --resume
                       goal mode REQUIRES a stated goal and stated completion criteria — it is never
                       inferred from a task being difficult
  contract complete [delegate|goal]
                       close the named contract and end autonomy. Idempotent. Without a target it
                       closes whatever is open — and --met always means delegate, so retrying a
                       delegation closure cannot land on the goal it just restored.
                       delegate: --met "<criterion>" once per RECORDED acceptance criterion. Every one
                                 must be restated; this is an ATTESTATION and is archived as one.
                       goal:     REFUSED unless every stated criterion is mechanically MET. UNMET or
                                 CANNOT_DETERMINE both refuse — a criterion nobody can evaluate is not
                                 a criterion that has been met. A SUCCESSFUL close also writes an After
                                 Action Report for the window and names the path; --no-aar skips it,
                                 and a report that could not be written is its own row and never
                                 reverses the close.
                       [--evidence "..."] [--note "..."] are archived with the closure.
                       A suspended goal is RESUMED when the contract stacked on it closes.

Exit: 0 PASS · 1 FAIL · 2 CANNOT_DETERMINE (a check that could not run is not a pass).
Never pushes. Commits only with --commit.`);
  process.exit(verb && !VERBS[verb] ? 1 : 0);
}

/*
 * ⛔ A VERB WHOSE ENGINE WILL NOT LOAD REPORTS THAT, RATHER THAN SPRAYING A STACK. `doctor` turns a
 * broken subsystem into a row; every other verb has nowhere to put one, and a raw stack trace is the
 * least useful thing to hand an operator whose install is damaged. The exit code is 1 — a verb that
 * could not run has not passed — and `--json` still gets JSON, because a caller parsing this must not
 * have to read prose to find out the run never happened.
 */
/*
 * ⛔ AND THE HINT MUST NAME THE DEPENDENCY, BECAUSE THE UNQUALIFIED VERSION WAS ONCE A LIE.
 *
 * "Run `doctor`" was printed unconditionally. On a real installed target at 6869874, with
 * `loadRequirements` removed from `.claude/hooks/_artifact.js`, `state` failed on a raw
 * `TypeError: artifact.loadRequirements is not a function` and sent the operator to a doctor that
 * reported `hook-lib:_artifact.js ACTIVE` and PASS at exit 0 — a report that sends you to itself has to
 * be able to answer. The contracts above are what make it answer; naming the module here is what lets a
 * fixture prove that the verb and the report are talking about the SAME broken dependency.
 */
const brokenDependencyOf = (e) => e && (e.respawnpackLib ? `lib/${e.respawnpackLib}` : e.brokenDependency) || null;

let out;
try {
  out = VERBS[verb]();
} catch (e) {
  const detail = `${(e && e.constructor && e.constructor.name) || 'Error'}: ${String((e && e.message) || e).split(/\r?\n/)[0]}`;
  const dep = brokenDependencyOf(e);
  const hint = dep
    ? `run \`doctor\` — it reports ${dep} as BROKEN and names the same missing export`
    : 'run `doctor` — it reports a broken subsystem as a row instead of dying on it';
  if (JSON_OUT) console.log(JSON.stringify({ outcome: 'FAIL', verb, error: detail, ...(dep ? { brokenDependency: dep } : {}), hint }, null, 2));
  else {
    console.error(`\n  → FAIL: \`${verb}\` could not run — ${detail}`);
    console.error(`  ${dep ? `Run \`doctor\`: it reports ${dep} as BROKEN and names the same missing export.` : 'Run `doctor`: it reports a broken subsystem as a row rather than dying on it.'}`);
  }
  process.exit(1);
}

/*
 * `gate` uses the SAME exit mapping as every other verb (K-09) — `exitCodeFor`, applied in cmdGate.
 * NOT_APPLICABLE is green ONLY because a human declared it; the gate's NOT_CONFIGURED is
 * CANNOT_DETERMINE at exit 2 and is never green.
 *
 * The gate's own richer word rides on `label`, and is what this block leads each line with: it is what
 * an operator needs in order to act (COULD_NOT_RUN sends you to install a tool, NOT_CONFIGURED sends
 * you to declare a check), and it is exactly the precision that made the gate grow a private
 * vocabulary. The shared `outcome` beside it is the one the exit code came from.
 */
if (verb === 'gate') {
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  else {
    for (const c of out.checks) console.log(`  ${c.label.padEnd(15)} ${c.check.padEnd(28)} ${c.detail || ''}`);
    console.log(`\n  → ${out.outcome}${out.label === out.outcome ? '' : ` (${out.label})`}: ${out.why}`);
    if (out.label === 'NOT_CONFIGURED') console.log('  ⛔ NOT a pass. A gate that ran no meaningful check has not established anything.');
  }
  process.exit(out.exitCode);
}

/*
 * `site` prints its rows like every other verb and then, when a server started, DOES NOT EXIT. The
 * verdict is printed before the server's own URL line so a reader sees what was built before being told
 * where to read it, and `serving` is stripped from `--json` because a Promise is not a result.
 */
if (verb === 'site') {
  const { serving, ...printable } = out;
  if (JSON_OUT) console.log(JSON.stringify(printable, null, 2));
  else {
    for (const c of printable.checks || []) console.log(`  ${c.outcome.padEnd(18)} ${c.check}: ${c.detail}`);
    if (printable.error) console.error(`  ${printable.error}`);
    console.log(`\n  → ${printable.outcome}`);
  }
  if (serving) {
    serving.catch((e) => {
      console.error(`\n  → FAIL: the site server could not start — ${String((e && e.message) || e).split(/\r?\n/)[0]}`);
      process.exit(1);
    });
  } else {
    process.exit(exitCodeFor(printable.outcome));
  }
}

if (verb === 'site') {
  // Printed by its own branch above. A `--serve` run is still running, so there is no exit to take.
} else if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else if (verb === 'status') {
  console.log(out.text);
} else if (verb === 'contract') {
  if (out.error) console.error(`  ${out.error}`);
  else {
    console.log(`  mode: ${out.contract.mode}`);
    for (const [k, v] of Object.entries(out.contract)) {
      if (k === 'mode' || !v || (Array.isArray(v) && !v.length)) continue;
      console.log(`  ${k}: ${Array.isArray(v) ? v.join(' · ') : typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    if (out.note) console.log(`\n  ${out.note}`);
    /*
     * The report rides BESIDE the closure's verdict, never inside it. A written report is a path the
     * operator can open; a failed one is printed as its own row so it is visible without being
     * mistaken for a problem with the goal that just closed.
     */
    if (out.aar) {
      if (out.aar.wrote) console.log(`\n  After Action Report: ${out.aar.wrote}`);
      else {
        console.log('\n  After Action Report: NOT written. The goal closure above stands.');
        for (const c of out.aar.checks || []) {
          if (c.outcome !== OUTCOME.PASS) console.log(`    ${c.outcome.padEnd(18)} ${c.check}: ${c.detail}`);
        }
      }
    }
  }
} else if (verb === 'aar') {
  for (const c of out.checks || []) console.log(`  ${c.outcome.padEnd(18)} ${c.check}: ${c.detail}`);
  // Without --write the document IS the output: printing it is what makes preview-by-default usable
  // rather than a way of finding out that a file you cannot see would have been fine.
  if (out.wrote) console.log(`\n  wrote: ${out.wrote}`);
  else if (out.document) console.log(`\n${out.document}`);
  console.log(`\n  → ${out.outcome}`);
} else if (verb === 'doctor') {
  // Doctor's own richer word leads each line, exactly as it always did — SILENTLY INACTIVE and STALE
  // are what an operator needs in order to act, and flattening them to CANNOT_DETERMINE on screen would
  // spend the diagnostic precision `label` exists to keep. The text output is therefore unchanged; the
  // shared `outcome` beside it in --json is the one the exit code came from, and it is the last line.
  for (const r of out.rows) console.log(`  ${r.label.padEnd(18)} ${r.check.padEnd(34)} ${r.detail}`);
  console.log(`\n  → ${out.outcome}`);
} else if (verb === 'removals') {
  for (const c of out.checks) console.log(`  ${c.outcome.padEnd(18)} ${c.check}: ${c.detail}`);
  console.log(`\n  scanned: ${out.scanned.files} file(s) matching ${out.scanned.extensions.join(' ')} under ${out.scanned.directories.join(', ') || '(nothing configured)'}`);
  // ⛔ Coverage nobody mentioned reads as coverage that happened.
  if (out.scanned.alwaysExcluded && out.scanned.alwaysExcluded.length) {
    console.log(`  always excluded, at any depth: ${out.scanned.alwaysExcluded.join(', ')}`);
  }
  for (const s of out.notScanned) console.log(`  not scanned: ${s}`);
  for (const u of out.unreadable) console.log(`  UNREADABLE: ${u}`);
  console.log(`\n  → ${out.outcome}`);
  if (out.outcome === 'CANNOT_DETERMINE') console.log('  ⛔ NOT a pass. A contract nobody configured has not established anything.');
  if (out.outcome === 'NOT_APPLICABLE') console.log('  Declared not applicable by this project — a stated decision, not an inferred one.');
  process.exit(exitCodeFor(out.outcome));
} else if (verb === 'readiness') {
  /*
   * ⛔ EVERY ROW IS PRINTED IN EVERY POSTURE, AND THE RELAXED ONES SAY SO. A `light` report is the same
   * list a `strict` report would have shown: the outcome column moved, the reason did not. Printing
   * only the failures would make the relaxation a silence, which is the thing anti-drift item 3 refuses.
   */
  for (const c of out.checks) console.log(`  ${c.outcome.padEnd(17)} ${c.check.padEnd(32)} ${c.detail || ''}`);
  console.log(`\n  → ${out.outcome}: ${out.why}`);
  if (out.outcome === 'CANNOT_DETERMINE') console.log('  ⛔ NOT a pass. A checklist that examined nothing has not established that this project is releasable.');
  process.exit(out.exitCode);
} else if (verb === 'memory') {
  if (out.error) console.error(`  ${out.error}`);
  else if (out.candidates) {
    for (const c of out.candidates) console.log(`  ${c.verificationState.padEnd(10)} ${c.klass.padEnd(14)} ${c.id}  ${c.claim.slice(0, 90)}`);
    console.log(`\n  ${out.candidates.length} candidate(s) — candidate: ${out.counts.candidate} · verified: ${out.counts.verified} · rejected: ${out.counts.rejected}`);
    for (const u of out.unreadable) console.log(`  UNREADABLE: ${u.file || JSON.stringify(u)}`);
  } else if (out.entity) {
    console.log(`  ${out.id} → ${out.entity} (${out.file})${out.alreadyPromoted ? ' [already promoted — idempotent no-op]' : ''}`);
  } else if ('alreadyRejected' in out) {
    console.log(`  ${out.id} rejected${out.alreadyRejected ? ' [already rejected — idempotent no-op]' : ''}`);
  }
  console.log(`\n  → ${out.outcome}`);
} else if (verb === 'lineage' && argv[1] === 'seed') {
  if (out.error) console.error(`  ${out.error}`);
  if (!out.count) {
    console.log(`  ${out.note}`);
  } else {
    console.log(JSON.stringify(out.proposal, null, 2));
    console.log('\n  evidence:');
    for (const e of out.evidence) {
      console.log(`  ${e.status.padEnd(9)} ${e.path}${e.id ? ` → ${e.id} (${e.kind})` : ''}: ${e.detail}`);
    }
    console.log(`\n  ${out.count} source(s) proposed${out.wrote ? `, written to ${out.wrote}` : ' (not written — pass --write)'}`);
  }
  console.log(`\n  → ${out.outcome}`);
} else {
  /*
   * The two verdicts are printed as two SECTIONS, not as one list with a label column. The dogfood
   * complaint was legibility, and a reader scanning a flat list re-derives the split every time — which
   * is the same work the flat CANNOT_DETERMINE was already making them do.
   */
  const coverageRows = (out.checks || []).filter((c) => c.domain === 'coverage');
  // A refusal (an unresolvable `--only`/`--skip` scope, a derived doc nobody named) has an `error` and
  // no rows worth reading — print it, rather than leaving the operator to infer it from a bare outcome.
  if (out.error && !(out.checks || []).length) console.error(`  ${out.error}`);
  for (const c of out.checks || out.findings || []) {
    if (c.domain === 'coverage') continue;
    console.log(`  ${c.outcome.padEnd(18)} ${c.check}: ${c.detail}`);
  }
  if (coverageRows.length) {
    console.log('\n  coverage — which optional contracts this project has decided about:');
    for (const c of coverageRows) console.log(`  ${c.outcome.padEnd(18)} ${c.check}: ${c.detail}`);
  }
  for (const m of out.migrations || []) {
    console.log(`\n  ${m.applied ? 'MIGRATED' : 'MIGRATION PREVIEW'} ${m.file} (${m.proseLines} prose line(s), ${m.originalBytes} bytes)`);
    console.log(`    original ${m.applied ? 'archived to' : 'would be archived to'} ${m.archiveRel} (verbatim, never deleted)`);
    console.log(`    its prose ${m.applied ? 'moved into' : 'would move into'} the protected NOTE block, which regeneration preserves`);
  }
  if (out.wrote && out.wrote.length) console.log(`  wrote: ${[].concat(out.wrote).join(', ')}`);
  // Only when HEAD sits on the savepoint's own commits: a reader who sees `sourceRevision` disagree
  // with `git rev-parse HEAD` should find the explanation here, not infer "stale".
  if (out.revisions && out.revisions.savepointOnlyCommits > 0) console.log(`  source revision: ${String(out.revisions.sourceRevision).slice(0, 7)} — ${out.revisions.detail}`);
  if (out.memoryProposals && out.memoryProposals.length) {
    console.log(`\n  ${out.memoryProposals.length} memory entr(ies) proposed from this session — accept or decline explicitly:`);
    for (const m of out.memoryProposals) console.log(`    · ${m.symptom}${m.candidateId ? ` (candidate ${m.candidateId})` : ''}`);
  }
  if (out.capturedCandidates && out.capturedCandidates.length) {
    console.log(`\n  ${out.capturedCandidates.length} candidate memor(ies) captured this run — review with \`memory candidates\`:`);
    for (const c of out.capturedCandidates) console.log(`    · [${c.klass}] ${c.id}: ${String(c.claim).slice(0, 90)}`);
  }
  /*
   * ⛔ THE PARTIAL BANNER, BECAUSE A ROW PER SKIP IS NOT THE SAME AS A HEADLINE. The rows above say
   * which stages were skipped; this says that the RUN was partial, next to the verdict a reader is
   * about to quote. Both, deliberately: the risk `--skip` carries is a scoped run being reported as a
   * savepoint, and that misreading happens at the summary line, not in the row list.
   */
  if (out.stages && out.stages.skipped.length) {
    console.log(`\n  ⛔ PARTIAL SAVEPOINT — ran: ${out.stages.ran.join(', ') || '(nothing)'}; SKIPPED BY REQUEST: ${out.stages.skipped.join(', ')}.`);
    console.log('  This is not a full savepoint. It establishes nothing about the skipped stages, and the receipt records the set.');
  }
  if (out.verdicts) {
    console.log(`\n  → integrity: ${out.verdicts.integrity}  ·  coverage: ${out.verdicts.coverage}`);
    if (out.verdicts.integrity === OUTCOME.PASS && out.verdicts.coverage === OUTCOME.CANNOT_DETERMINE) {
      console.log(`  The machinery works. What is unresolved is which optional contracts apply here: ${(out.unresolved || []).join(', ')}.`);
      console.log('  Run `/respawn` to decide each one. Until then this project is not release-ready, and that is why the exit is not 0.');
    }
  }
  console.log(`\n  → ${out.outcome}`);
}

// `site` has already exited (no server) or is deliberately still running (a server on loopback).
if (verb !== 'site') process.exit(exitCodeFor(out.outcome));
