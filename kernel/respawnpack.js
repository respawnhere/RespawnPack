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
 *                      docs; default is check-only for those, but still records the attempt under
 *                      .respawnpack/runtime/, captures failing checks as candidate leads under
 *                      memory/candidates/, may re-render LESSONS.md to count them, and creates
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
const os = require('os'); // home dir for the host auto-memory default location (memory candidates mirror)
const { execFileSync, spawnSync } = require('child_process');

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
 * ⭐ D2 · THE REVIEW-FRESHNESS BOUNDARY, REACHED THE SAME WAY AND FOR THE SAME REASON. `review-receipt`
 * computes the tree identity through hooks/_runtime.js's `treeState` (the one the Stop and SessionStart
 * hooks compare, so the writer and the checker cannot disagree about what "the tree" is) and reads the
 * receipt back through hooks/_artifact.js's classifying boundary (as kernel/lib/closeout.js reads the
 * runtime contract). Both resolve across the ONE relative path both layouts share, probed rather than
 * hard-required, and both are folded into KERNEL_CROSS_TREE below so doctor can report their health.
 */
const REVIEW_RECEIPT_REL = path.join('.respawnpack', 'runtime', 'review-receipt.json');
const RUNTIME_PATH = path.resolve(__dirname, '..', 'hooks', '_runtime.js');
const runtimeHealth = modhealth.probePath(RUNTIME_PATH);
const runtimeLib = runtimeHealth.module;
const ARTIFACT_PATH = path.resolve(__dirname, '..', 'hooks', '_artifact.js');
const artifactHealth = modhealth.probePath(ARTIFACT_PATH);
const artifactLib = artifactHealth.module;

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
const KERNEL_CROSS_TREE = [MANIFEST_PATH, POSTURE_PATH, EXCEPTIONS_PATH, RUNTIME_PATH, ARTIFACT_PATH];

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
const decisionsLib = lazyLib('decisions');
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
    // DECLARED-only, exactly like `omittedByProfile`: a target that never chose a posture resolves to
    // `strict`, which retires no hook, so `lockdown`/`worktree-guard` stay wired-and-ACTIVE there. The
    // `typeof` guard keeps an older installed `_posture.js` (one without the table) from crashing doctor.
    retiresHook: (hook) => (resolved.source === 'DECLARED' && typeof postureLib.hookRetiredBy === 'function'
      ? postureLib.hookRetiredBy(hook, resolved.profile) : null),
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
 * ⛔ G17 · OPERATIONAL RECORDS (decision 50, option A). Two records the spine did not ship and the field
 * invented for itself: an APPEND-ONLY ops log of what was DONE and how it turned out, and an INCIDENT
 * LIBRARY of a signature, its cause and its fix. The single-sourcing rule binds both - an action and its
 * result are owned by the log, an incident's signature/cause/fix by the library, a lesson by the graph
 * (promoted FROM an incident and citing its id) - and everything else may only POINT by id. The log is
 * machine-local (under .respawnpack/, gitignored) because it is session-and-autonomy state; the incident
 * library is tracked because an incident is project knowledge. Both reuse core/_io.js's two append/atomic
 * primitives and its classified readers; neither is a projection, so the HANDOFF view points at them and
 * never copies a fix body.
 */
const OPS_LOG_REL = path.join('.respawnpack', 'ops-log.jsonl');
const OPS_LOG_SCHEMA_VERSION = '1.0.0';
const INCIDENTS_DIR_REL = path.join('memory', 'incidents');
const INCIDENT_SCHEMA_VERSION = '1.0.0';
// The memo's "one line": a field over this, or one spanning lines, is refused before anything is written.
const OPS_FIELD_MAX = 1000;
const INCIDENT_ID_RE = /^inc_[0-9a-f]{16}$/;

/*
 * ⛔ G17 R1 · THE APPEND MUTEX. appendLine alone makes two honest appenders (two `log` verbs, or a `log`
 * during a `savepoint --write`) both read head H, both seal a row with prevDigest H, and land them in
 * order - so the second reads as a SPLICE, the chain is BROKEN at a row nobody rewrote, --repair-tail
 * refuses (it is corruption, not a torn tail), and every later append is refused. That is an undisclosed
 * way to brick the log the precedent journals (catches, candidate-audit) do not have, because they carry
 * no chain. The fix serialises the read-head-then-append window under an exclusive lock, the index-lease
 * precedent one directory over (_index-lease.js:34,438-527): a portable CAS, a bounded wait, a conservative
 * stale window with a NAMED reclaim, and a fail-closed refusal that never writes.
 */
const OPS_LOG_LOCK_REL = path.join('.respawnpack', 'ops-log.lock');
// A held lock is waited on for at most this long before the append is refused - the window is a read plus
// one appendLine, milliseconds, so a second honest appender almost always lands inside it.
const OPS_LOCK_WAIT_MS = 1000;
// A lock older than this had a holder that died mid-append (the window is milliseconds). Conservative on
// purpose, well past the wait and the index-lease's own 5 s: reclaiming a live holder's lock is the
// corruption the lock exists to stop, so a slow-but-live writer is waited out and refused, never reclaimed.
const OPS_LOCK_STALE_MS = 10000;

const opsLogPath = () => path.join(DIR, OPS_LOG_REL);
const opsLogLockPath = () => path.join(DIR, OPS_LOG_LOCK_REL);
const incidentsDir = () => path.join(DIR, INCIDENTS_DIR_REL);
const incidentPath = (id) => path.join(incidentsDir(), `${core.io.safeSegment(id)}.json`);
const opsRefusal = (verb, detail) => ({ outcome: OUTCOME.FAIL, verb, error: detail });
const opsCoreUnavailable = (verb) => (core ? null : {
  outcome: OUTCOME.CANNOT_DETERMINE, verb,
  error: 'core/ (the host-neutral rollover core) could not be loaded, so the ops log and incident library are unavailable - see doctor\'s kernel-lib rows',
});

/** The current source revision, resolved the way the savepoint resolves it (nearest non-savepoint ancestor). */
function currentSourceRevision() {
  try { const r = manifestLib && manifestLib.sourceRevisions(DIR); if (r && r.effective) return String(r.effective); }
  catch { /* fall through to the strict answer below */ }
  return 'no-revision';
}

/** The chain seal of one row: canonicalDigest of the row WITHOUT its own `digest` field. */
function opsRowDigest(row) {
  const { digest, ...rest } = row; // eslint-disable-line no-unused-vars
  return core.io.canonicalDigest(rest);
}

/**
 * Read the ops log and classify it. A parse failure or a broken seal ANYWHERE BUT THE TAIL is corruption,
 * reported and never skipped; a torn TAIL is reported as its own fact and the file is NOT repaired here.
 * @returns {{status:'ABSENT'|'UNREADABLE'|'OK'|'TORN'|'BROKEN', rows:object[], head:string|null, tornTail:string|null, firstBreak:object|null, detail?:string}}
 */
function readOpsLog() {
  const r = core.io.readLinesClassified(opsLogPath());
  if (r.status === 'ABSENT') return { status: 'ABSENT', rows: [], head: null, tornTail: null, firstBreak: null };
  if (r.status !== 'OK') return { status: 'UNREADABLE', rows: [], head: null, tornTail: null, firstBreak: null, detail: r.detail };
  const rows = [];
  let prev = null;
  for (let i = 0; i < r.lines.length; i += 1) {
    let obj;
    try { obj = JSON.parse(r.lines[i]); }
    catch (e) {
      return { status: 'BROKEN', rows, head: prev, tornTail: r.tornTail,
        firstBreak: { row: i + 1, reason: `row ${i + 1} is not parseable JSON (${String(e.message).slice(0, 120)}) - corruption before the tail, refused and never skipped` } };
    }
    if (obj.digest !== opsRowDigest(obj)) {
      return { status: 'BROKEN', rows, head: prev, tornTail: r.tornTail,
        firstBreak: { row: i + 1, digest: obj.digest || null, reason: `row ${i + 1}'s digest does not match its content - it was rewritten in place` } };
    }
    if ((obj.prevDigest || null) !== prev) {
      return { status: 'BROKEN', rows, head: prev, tornTail: r.tornTail,
        firstBreak: { row: i + 1, digest: obj.digest, reason: `row ${i + 1}'s prevDigest does not seal the previous row - a row was spliced or removed` } };
    }
    rows.push(obj);
    prev = obj.digest;
  }
  if (r.tornTail) return { status: 'TORN', rows, head: prev, tornTail: r.tornTail, firstBreak: null };
  return { status: 'OK', rows, head: prev, tornTail: null, firstBreak: null };
}

const opsPause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);

/**
 * Take the ops-log append lock, or report that it could not be taken. The lock serialises the
 * read-head-then-append window so two honest appenders cannot both seal one head and splice the chain.
 * A held lock is waited on for OPS_LOCK_WAIT_MS; a lock older than OPS_LOCK_STALE_MS had a holder that
 * died and is reclaimed (NAMED back to the caller, never silently); a lock that never clears refuses.
 * @returns {{ok:true, reclaimedFrom:string|null} | {ok:false, detail:string}}
 */
// An exclusive-create failure that is a Windows delete-pending window (a lock another writer just
// released), not a fault: EPERM, EACCES or EBUSY on the create itself.
function lockCreateTransient(r) {
  return /^(EPERM|EACCES|EBUSY):/.test(String(r && r.detail));
}
function acquireOpsLock() {
  const lock = opsLogLockPath();
  const holder = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  const deadline = Date.now() + OPS_LOCK_WAIT_MS;
  let reclaimedFrom = null;
  for (;;) {
    const r = core.io.createExclusive(lock, holder);
    if (r.status === 'CREATED') return { ok: true, reclaimedFrom };
    // A non-contention error (a read-only tree, a missing parent) is not something a wait can fix: fail
    // closed. But on Windows a lock file another writer just unlinked sits DELETE-PENDING for a moment,
    // and an exclusive create in that window fails EPERM/EACCES/EBUSY, not EEXIST: that is contention,
    // so it waits inside the same bounded window, and a real permission fault still refuses after it.
    if (r.status !== 'EXISTS') {
      if (!lockCreateTransient(r) || Date.now() > deadline) return { ok: false, detail: `the ops-log lock \`${OPS_LOG_LOCK_REL}\` could not be created (${r.detail}) - the append was refused, nothing written` };
      opsPause();
      continue;
    }
    let age = null;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; }
    catch { /* vanished between the CAS and the stat: pure contention, retry at once */ }
    if (age !== null && age > OPS_LOCK_STALE_MS) {
      // The holder died mid-append. Reclaim it, and REMEMBER the reclaim so the result can name it.
      try { fs.unlinkSync(lock); } catch { /* another appender reclaimed it first */ }
      reclaimedFrom = `a stale \`${OPS_LOG_LOCK_REL}\` lock ${Math.round(age / 1000)}s old (older than the ${OPS_LOCK_STALE_MS / 1000}s stale window - its holder had died)`;
      continue;
    }
    if (Date.now() > deadline) {
      return { ok: false, detail: `the ops-log lock \`${OPS_LOG_LOCK_REL}\` is held by another writer and did not clear within ${OPS_LOCK_WAIT_MS}ms - the append was refused, nothing written` };
    }
    opsPause();
  }
}

/** Release the append lock. Best-effort: an already-reclaimed or never-created lock is not an error. */
function releaseOpsLock() {
  try { fs.unlinkSync(opsLogLockPath()); } catch { /* already reclaimed, or this call never created it */ }
}

/**
 * Append one sealed row UNDER the append lock. Refuses over a torn tail or a broken chain, naming the
 * fault (never silently skipping it), and refuses when the lock cannot be taken (never writing unlocked).
 */
function appendOpsRow(fields) {
  const lk = acquireOpsLock();
  if (!lk.ok) return { ok: false, blocked: 'lock', detail: lk.detail };
  try {
    const r = appendOpsRowLocked(fields);
    return r.ok ? { ...r, reclaimedFrom: lk.reclaimedFrom } : r;
  } finally {
    releaseOpsLock();
  }
}
// The append itself, for a caller that ALREADY holds the lock (the repair holds it end to end).
function appendOpsRowLocked(fields) {
  {
    const log = readOpsLog();
    if (log.status === 'UNREADABLE') return { ok: false, blocked: 'unreadable', detail: log.detail, log };
    if (log.status === 'TORN') return { ok: false, blocked: 'torn', detail: `a torn tail of ${Buffer.byteLength(log.tornTail, 'utf8')} byte(s) blocks the append - repair it with \`log --repair-tail --by "<who>"\``, log };
    if (log.status === 'BROKEN') return { ok: false, blocked: 'broken', detail: log.firstBreak.reason, log };
    const row = {
      schemaVersion: OPS_LOG_SCHEMA_VERSION,
      at: new Date().toISOString(),
      by: fields.by, action: fields.action, result: fields.result,
      refs: fields.refs || [],
      cycleId: fields.cycleId || 'no-revision',
      prevDigest: log.head || null,
    };
    row.digest = opsRowDigest(row);
    const w = core.io.appendLine(opsLogPath(), JSON.stringify(row));
    return w.ok ? { ok: true, row, log } : { ok: false, blocked: 'write', detail: w.detail, log };
  }
}

/** The chain verdict in the pack's four outcomes, shared by `log --verify`, `log --list` and doctor. */
function opsChainSummary(log) {
  if (log.status === 'ABSENT') return { outcome: OUTCOME.NOT_APPLICABLE, detail: 'no ops log on this machine' };
  if (log.status === 'UNREADABLE') return { outcome: OUTCOME.CANNOT_DETERMINE, detail: `the ops log could not be read: ${log.detail}` };
  if (log.status === 'BROKEN') return { outcome: OUTCOME.FAIL, detail: `the chain breaks at ${log.firstBreak.reason}` };
  if (!log.rows.length) return { outcome: OUTCOME.NOT_APPLICABLE, detail: 'the ops log is empty' };
  const tornBytes = log.status === 'TORN' ? Buffer.byteLength(log.tornTail, 'utf8') : 0;
  return {
    outcome: OUTCOME.PASS,
    detail: `${log.rows.length} row(s), head ${String(log.head).slice(0, 12)}`
      + (tornBytes ? `; a torn tail of ${tornBytes} byte(s) is present - \`log --repair-tail --by "<who>"\` records its discard (a read never repairs the file)` : ''),
  };
}

/** The frozen snapshot HANDOFF renders from - null when there is no log, so the section says so. */
function opsLogSnapshot() {
  const log = readOpsLog();
  if (log.status === 'ABSENT' || log.status === 'UNREADABLE' || !log.rows.length) return null;
  const last = log.rows[log.rows.length - 1];
  return { rows: log.rows.length, head: log.head, last: { action: String(last.action), result: String(last.result), at: String(last.at) } };
}

/** Read one incident record through the classifying boundary. An id that cannot name a file is "not found". */
function readIncident(id) {
  if (!INCIDENT_ID_RE.test(String(id || ''))) return { status: 'ABSENT' };
  const r = core.io.readJSONClassified(incidentPath(id));
  if (r.status !== 'OK') return { status: r.status, detail: r.detail };
  return { status: 'OK', record: r.doc };
}

/** Every incident in memory/incidents/, read live through the classifying boundary. */
function listIncidents() {
  let files;
  try { files = fs.readdirSync(incidentsDir()).filter((f) => /^inc_[0-9a-f]{16}\.json$/.test(f)); }
  catch { return { outcome: OUTCOME.NOT_APPLICABLE, incidents: [], unreadable: [] }; }
  if (!files.length) return { outcome: OUTCOME.NOT_APPLICABLE, incidents: [], unreadable: [] };
  const incidents = [], unreadable = [];
  for (const f of files.sort()) {
    const r = core.io.readJSONClassified(path.join(incidentsDir(), f));
    if (r.status === 'OK' && r.doc) incidents.push(r.doc);
    else unreadable.push({ file: f, status: r.status, detail: r.detail || null });
  }
  return { outcome: incidents.length ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE, incidents, unreadable };
}

/** The open incident ids HANDOFF lists, read live (the file moves only by a verb, as the lessons counts do). */
function openIncidentsLive() {
  const listed = listIncidents();
  const open = listed.incidents.filter((i) => i && i.status === 'open' && typeof i.id === 'string');
  return { ids: open.map((i) => i.id).sort(), total: open.length };
}

/*
 * `log` - append one operations-log row, or read the tail, or verify the chain, or repair a torn tail.
 * Every row seals the one before it; an action with no author or result is refused before anything is
 * written (G6's rule); a field over one line or 1,000 characters is refused (the memo's "one line").
 */
function cmdLog() {
  const unavailable = opsCoreUnavailable('log');
  if (unavailable) return unavailable;
  const by = (valueOf('--by', '') || '').trim();

  if (flag('--repair-tail')) {
    if (!by) return opsRefusal('log', '`--repair-tail` requires `--by "<who>"` - a repair with no author is refused, so the repair itself is attributed');
    // ⛔ RC 0.4.0 · THE REPAIR HOLDS THE APPEND LOCK END TO END. Reading, truncating and recording the
    // repair row used to run unlocked (the lock was taken only inside the final append), so another
    // writer could slip in between, and a refused append left the torn bytes already gone with nothing
    // recording their discard. Now the lock is taken first and held through the whole repair, and if the
    // repair row cannot be recorded the ORIGINAL bytes are put back, so a failed repair changes nothing.
    const lk = acquireOpsLock();
    if (!lk.ok) return opsRefusal('log', `the repair was refused and the log left byte-identical: ${lk.detail}`);
    try {
      const log = readOpsLog();
      if (log.status === 'ABSENT') return { outcome: OUTCOME.NOT_APPLICABLE, verb: 'log', mode: 'repair-tail', detail: 'there is no ops log on this machine, so there is no torn tail to repair' };
      if (log.status === 'UNREADABLE') return opsRefusal('log', `the ops log could not be read: ${log.detail}`);
      if (log.status === 'BROKEN') return opsRefusal('log', `the chain is broken at ${log.firstBreak.reason} - this is corruption, not a torn tail, and --repair-tail does not touch a sealed row`);
      if (log.status !== 'TORN') return { outcome: OUTCOME.NOT_APPLICABLE, verb: 'log', mode: 'repair-tail', detail: `the ops log has no torn tail to repair (${log.rows.length} row(s), chain intact)` };
      const discarded = log.tornTail;
      const discardedDigest = core.io.digest(discarded);
      // Discard the torn tail by truncating the file to its last newline (sealed rows all end in one; the
      // torn tail is the bytes after it). truncateSync removes exactly those bytes and replaces nothing by
      // rename, so there is no rename window and no sealed row is touched. Then record the repair as a row.
      const raw = fs.readFileSync(opsLogPath());
      const lastNl = raw.lastIndexOf(0x0a);
      fs.truncateSync(opsLogPath(), lastNl >= 0 ? lastNl + 1 : 0);
      const r = appendOpsRowLocked({ by, action: 'ops-log repair-tail', result: discardedDigest, refs: [], cycleId: currentSourceRevision() });
      if (!r.ok) {
        let restored = false;
        try { fs.writeFileSync(opsLogPath(), raw); restored = fs.readFileSync(opsLogPath()).equals(raw); } catch { /* reported below */ }
        return opsRefusal('log', restored
          ? `the repair row could not be recorded (${r.detail}), so the original bytes were restored and the torn tail (digest ${discardedDigest.slice(0, 12)}) is still in place; nothing changed - re-run the repair`
          : `the repair row could not be recorded (${r.detail}) AND the original bytes could not be restored; the discarded torn tail was ${JSON.stringify(discarded)} (digest ${discardedDigest})`);
      }
      return { outcome: OUTCOME.PASS, verb: 'log', mode: 'repair-tail', discarded, discardedDigest, digest: r.row.digest, rows: log.rows.length + 1, reclaimedFrom: lk.reclaimedFrom };
    } finally {
      releaseOpsLock();
    }
  }

  if (flag('--verify')) {
    const log = readOpsLog();
    const s = opsChainSummary(log);
    return {
      outcome: s.outcome, verb: 'log', mode: 'verify', detail: s.detail,
      rows: log.rows.length, head: log.head,
      torn: log.status === 'TORN' ? { bytes: Buffer.byteLength(log.tornTail, 'utf8') } : null,
      firstBreak: log.firstBreak || null,
    };
  }

  const action = (valueOf('--action', '') || '').trim();
  const resultText = (valueOf('--result', '') || '').trim();
  const refs = allValuesOf('--ref');

  if (flag('--list') || !action) {
    const log = readOpsLog();
    const s = opsChainSummary(log);
    return { outcome: s.outcome, verb: 'log', mode: 'list', detail: s.detail, tail: log.rows.slice(-20), rows: log.rows.length, head: log.head, firstBreak: log.firstBreak || null };
  }

  const problems = [];
  if (!by) problems.push('`--by "<who>"` is required and non-empty - an action with no author is refused before anything is written');
  if (!resultText) problems.push('`--result "<outcome>"` is required and non-empty - an action with no result is refused');
  for (const [name, v] of [['--action', action], ['--result', resultText], ['--by', by]]) {
    if (!v) continue;
    if (v.length > OPS_FIELD_MAX) problems.push(`${name} is ${v.length} characters, over the ${OPS_FIELD_MAX}-character one-line limit`);
    if (/[\r\n]/.test(v)) problems.push(`${name} spans more than one line - the ops log is one line per row`);
  }
  for (const rf of refs) { if (rf.length > OPS_FIELD_MAX || /[\r\n]/.test(rf)) problems.push('a `--ref` is over the one-line limit'); }
  if (problems.length) return opsRefusal('log', `refused, nothing written: ${problems.join('; ')}`);

  const r = appendOpsRow({ by, action, result: resultText, refs, cycleId: currentSourceRevision() });
  if (!r.ok) {
    if (r.blocked === 'torn') return opsRefusal('log', r.detail);
    if (r.blocked === 'lock') return opsRefusal('log', r.detail);
    if (r.blocked === 'broken') return opsRefusal('log', `the chain is broken and must be examined before appending (run \`log --verify\`): ${r.detail}`);
    return opsRefusal('log', `the row could not be appended: ${r.detail}`);
  }
  return { outcome: OUTCOME.PASS, verb: 'log', mode: 'append', digest: r.row.digest, rows: r.log.rows.length + 1, head: r.row.digest, reclaimed: r.reclaimedFrom || null };
}

/*
 * `incident` - author one incident claim (signature, cause, fix), list them, or close one. `--new` mints a
 * root-cause-fix candidate in the same call whose claim names the incident by ID and never carries the fix
 * body, so the fix lives once (here) and a promoted lesson cites the id. The only edit a verb makes to an
 * existing record is `--close` (status, closedAt, closedBy); signature, cause and fix are never rewritten.
 */
function cmdIncident() {
  const unavailable = opsCoreUnavailable('incident');
  if (unavailable) return unavailable;
  const by = (valueOf('--by', '') || '').trim();

  const closeId = valueOf('--close', null);
  if (closeId) {
    if (!by) return opsRefusal('incident', '`--close` requires `--by "<who>"`');
    const r = readIncident(closeId);
    if (r.status === 'ABSENT') return opsRefusal('incident', `no incident \`${closeId}\` in memory/incidents/ - an unknown id is refused`);
    if (r.status !== 'OK') return { outcome: OUTCOME.CANNOT_DETERMINE, verb: 'incident', error: `incident \`${closeId}\` could not be read: ${r.detail}` };
    const inc = r.record;
    if (inc.status === 'fixed') return { outcome: OUTCOME.PASS, verb: 'incident', mode: 'close', id: inc.id, idempotent: true, detail: `incident ${inc.id} was already fixed - idempotent no-op` };
    const closed = { ...inc, status: 'fixed', closedAt: new Date().toISOString(), closedBy: by };
    const w = core.io.writeAtomicJSON(incidentPath(inc.id), closed);
    if (!w.ok) return { outcome: OUTCOME.CANNOT_DETERMINE, verb: 'incident', error: `incident ${inc.id} could not be written: ${w.detail}` };
    return { outcome: OUTCOME.PASS, verb: 'incident', mode: 'close', id: inc.id, idempotent: false, detail: `incident ${inc.id} closed (status: fixed)` };
  }

  if (flag('--new')) {
    const signature = (valueOf('--signature', '') || '').trim();
    const cause = (valueOf('--cause', '') || '').trim();
    const fix = (valueOf('--fix', '') || '').trim();
    const statusArg = valueOf('--status', 'open');
    const logRefs = allValuesOf('--log-ref');
    const problems = [];
    if (!signature) problems.push('`--signature` is required and non-empty');
    if (!cause) problems.push('`--cause` is required and non-empty');
    if (!fix) problems.push('`--fix` is required and non-empty');
    if (!by) problems.push('`--by "<who>"` is required and non-empty');
    if (statusArg !== 'open' && statusArg !== 'fixed') problems.push('`--status` must be open or fixed');
    if (problems.length) return opsRefusal('incident', `refused, nothing written: ${problems.join('; ')}`);

    const revision = currentSourceRevision();
    const id = `inc_${crypto.randomBytes(8).toString('hex')}`;
    const evidence = [path.posix.join('memory', 'incidents', `${id}.json`)];
    // ⛔ RC 0.4.0 · ALL OR NOTHING. The candidate's id is minted up front so the INCIDENT is written first,
    // already naming it; only then is the candidate captured under that id. A failed incident write
    // therefore leaves no candidate pointing at a missing record, and a failed capture rolls the incident
    // back, so a failed creation leaves nothing behind and a re-run starts clean. The claim names the
    // incident by id and carries the signature's first sentence, NEVER the fix body.
    const candidateId = `cm_${crypto.randomBytes(8).toString('hex')}`;
    const claim = `root-cause-fix: incident ${id} (${core.candidates.firstSentence(signature)})`;
    const record = {
      schemaVersion: INCIDENT_SCHEMA_VERSION, kind: 'incident', id,
      signature, cause, fix, status: statusArg,
      provenance: { by, at: new Date().toISOString(), cycleId: revision },
      logRefs, candidateId,
    };
    const w = core.io.writeAtomicJSON(incidentPath(id), record);
    if (!w.ok) return { outcome: OUTCOME.CANNOT_DETERMINE, verb: 'incident', error: `the incident could not be written, so nothing was created (no candidate either): ${w.detail}` };
    const cap = core.candidates.capture(memoryStoreDir(), { id: candidateId, claim, klass: 'root-cause-fix', provenance: { by, sourceKind: 'operator', cycleId: revision, conversationId: null, host: null, evidencePaths: evidence } });
    if (!cap.ok) {
      let rolledBack = true;
      try { fs.unlinkSync(incidentPath(id)); } catch (e) { rolledBack = e.code === 'ENOENT'; }
      return {
        outcome: OUTCOME.CANNOT_DETERMINE, verb: 'incident', id, candidateId: null,
        error: rolledBack
          ? `the root-cause-fix candidate could not be written (${cap.reason}), so the incident was rolled back and nothing was created; re-run the same command once the store is writable`
          : `the root-cause-fix candidate could not be written (${cap.reason}) and the incident ${id} could not be rolled back; delete memory/incidents/${id}.json before re-running`,
      };
    }
    return { outcome: OUTCOME.PASS, verb: 'incident', mode: 'new', id, candidateId, candidateError: null, record };
  }

  const listed = listIncidents();
  const open = listed.incidents.filter((i) => i && i.status === 'open');
  const fixed = listed.incidents.filter((i) => i && i.status === 'fixed');
  return { outcome: listed.outcome, verb: 'incident', mode: 'list', open, fixed, unreadable: listed.unreadable };
}

const SAVEPOINT_WRITEBACK_MARKER_REL = path.join('.respawnpack', 'runtime', 'state-writeback-fail.json');

/*
 * ⛔ G4 · A ONE-OFF state-writeback FAIL IS NOISE; A PERSISTING ONE IS A LEAD, FILED ONCE. The field saw
 * `state-writeback` leads dominate a project's rejected candidates because a single transient disagreement
 * (a verify between a write and its docs commit, a half-applied edit) minted one every run. The row itself
 * is still reported and the exit code is still 1 on the FIRST run — nothing is withheld — but the automatic
 * CANDIDATE waits for the SAME disagreement to survive a second consecutive run, keyed on the durable digest
 * pair the check carries. A run that PASSes, or FAILs with a different pair, clears the marker so a resolved
 * disagreement never files late. Dedup on content digest then keeps a persisting FAIL to a single lead.
 *
 * ⛔ A VERIFY-ONLY RUN MAY WRITE THIS MARKER. It is runtime state under `.respawnpack/runtime/` — the same
 * place the Stop hook already writes, excluded from the scanned corpus (DEFAULT_EXCLUDE) and gitignored on
 * installed targets — not a derived document, so writing it does not make a verify a document write.
 */
function stateWritebackMintDecision(checks) {
  const abs = path.join(DIR, SAVEPOINT_WRITEBACK_MARKER_REL);
  const wb = checks.find((c) => c.check === 'state-writeback');
  if (!wb) return false; // the writeback stage was skipped: leave any marker untouched and mint nothing here
  if (wb.outcome !== OUTCOME.FAIL) {
    // A PASS (the disagreement is gone) OR a CANNOT_DETERMINE (the check could not run) both BREAK the
    // consecutive-FAIL streak: "two consecutive runs" means two in a row with nothing non-FAIL between,
    // so either clears the marker and a later FAIL starts its own count.
    try { fs.rmSync(abs, { force: true }); } catch { /* already absent */ }
    return false;
  }
  const pair = wb.writebackPair || wb.detail || 'unknown';
  // Plain text, not JSON: the marker is one opaque identity string, read back only here. A transient read
  // failure (an absent or mid-rename marker) reads as "no prior" and simply restarts the two-run count —
  // it can never file a false lead or clear a real one — so a classifying boundary would buy nothing.
  let prior = null;
  try { prior = fs.readFileSync(abs, 'utf8').trim(); } catch { prior = null; }
  if (prior && prior === pair) return true; // second (or later) consecutive FAIL, same pair → file it
  // First occurrence, or a DIFFERENT pair (a changed disagreement): record this run's pair and wait.
  try { stateLib.writeAtomic(abs, `${pair}\n`); }
  catch { /* best effort: a marker we could not write just means the next FAIL re-starts the count */ }
  return false;
}

const DECISION_HEADING = /^###\s+(D-\d+)\s*[—–-]\s*(.+?)\s*·.*$/;

/*
 * The decisions a lead might already duplicate, read through kernel/lib/decisions.js so a MIGRATED
 * project (B2: a shard under `docs/decisions/`, each file's frontmatter carrying id/title/status/removal)
 * and an UNMIGRATED one (the `docs/DECISIONS.md` monolith, parsed by its `### D-NNN — <title> · <date> ·
 * <status>` heading shape) yield the SAME durable set. Without this a migrated project would read an
 * empty set and re-open every decision duplicate silently. Each record names the file a reader opens: the
 * shard file (`docs/decisions/D-NNN-<slug>.md`) on a migrated tree, `docs/DECISIONS.md D-NNN` otherwise.
 * A SUPERSEDED decision is NOT a durable record — a fresh lead may legitimately re-raise it — and the
 * shard reader never looks under `docs/_archive/`. Markdown throughout (readShard reads the shard dir;
 * the monolith parser takes TEXT), so no classified JSON reader and no RAW_READS row (that sweep is for
 * `JSON.parse(readFileSync(...))`).
 */
function readDecisionTitles(dir) {
  const out = [];
  const shard = decisionsLib.readShard(dir);
  if (shard.status === 'OK' && shard.records.length) {
    for (const r of shard.records) {
      if (r.title && r.status !== 'superseded') out.push({ id: r.id, title: r.title, ref: r.file });
    }
    return out;
  }
  // No shard directory: the unmigrated monolith stays valid. Prefer decisions.js's own parser, and fall
  // back to the tolerant heading scan if it refuses a monolith whole (a pre-B2 file the stricter parser
  // rejects still contributes its decision titles rather than silently contributing none).
  let text;
  try { text = fs.readFileSync(path.join(dir, decisionsLib.INDEX_REL), 'utf8'); } catch { return out; }
  const parsed = decisionsLib.parseMonolith(text);
  if (parsed.ok) {
    for (const e of parsed.entries) {
      if (e.title && e.status !== 'superseded') out.push({ id: e.id, title: e.title, ref: `${decisionsLib.INDEX_REL} ${e.id}` });
    }
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = DECISION_HEADING.exec(line.trim());
    if (m) out.push({ id: m[1], title: m[2].trim(), ref: `${decisionsLib.INDEX_REL} ${m[1]}` });
  }
  return out;
}

/*
 * ⛔ THE DURABLE RECORDS A LEAD MIGHT ALREADY LIVE IN (D4). "recoverable from code, tests or docs"
 * means, for this pack: (1) the knowledge graph, (2) the decisions document, (3) the removal registry
 * and (4) the requirement rows — each read through a reader this file ALREADY has, so the rule adds no
 * new raw read and travels unchanged to a document project (its decisions and removals are about
 * documents). Code and tests are NOT grepped: this pack cannot search them semantically and must not
 * pretend to; what a test or a comment states is covered here only where it is ALSO an evidence-backed
 * requirement row or a removal. A `_retracted/` entity is deliberately NOT a durable record — a
 * retracted lesson is exactly the thing a fresh lead may legitimately raise again.
 */
function durableRecords(state) {
  const records = [];
  const graph = readGraphEntities();
  if (graph.status === 'OK') {
    for (const e of graph.entities) {
      /*
       * ⛔ G7 · A SUPERSEDED (RELATION-DERIVED) GRAPH ENTITY IS STILL A DURABLE RECORD, AND THIS IS THE ONE
       * SITE THAT DECIDES IT. G7's supersession is a RENDER marker (the knowledge stays in the graph, just
       * marked), so a lead duplicating a superseded entity is still "already recorded" and D4 rejects it
       * naming that entity. That is deliberately UNLIKE the two exclusions already here: a `_retracted/`
       * entity is skipped (a retraction invites re-raising), and a superseded DECISION is dropped by
       * readDecisionTitles. The rule that wins for the graph: present-but-superseded stays durable; only a
       * move under `_retracted/` removes an entity from this set.
       */
      if (/(^|\/)_retracted\//.test(e.file)) continue;
      const title = String(e.id || '').split(':').slice(1).join(':') || e.id;
      const strings = [title, ...(e.observation ? [core.candidates.firstSentence(e.observation)] : []), ...(e.aliases || [])];
      records.push({ ref: e.file, kind: 'graph-entity', file: path.join(DIR, e.file), strings });
    }
  }
  for (const d of readDecisionTitles(DIR)) {
    records.push({ ref: d.ref, kind: 'decision', strings: [d.title] });
  }
  // The removal registry, compiled into state.killedFeatures: the feature name identifies the durable
  // row. Matched by name only — the registry IS the record, so a name hit counts even without a phrase.
  for (const k of (state.killedFeatures || [])) {
    if (k && k.feature) records.push({ ref: `removals registry · "${k.feature}"`, kind: 'removal', strings: [k.feature] });
  }
  for (const r of (state.requirements || [])) {
    if (r && r.id) records.push({ ref: `${stateLib.STATE_FILE} · requirement ${r.id}`, kind: 'requirement', strings: [r.id, r.title].filter(Boolean) });
  }
  return records;
}

const OBSERVATIONS_HEADING = '## Observations';

/*
 * True once the entity already cites every one of the lead's evidence paths, so nothing is new to add (D4).
 *
 * ⛔ A CITATION IS AN ITEM OF AN `(evidence: ...)` SEGMENT, NOT ANY MENTION OF THE PATH (G18 round 1). The
 * old whole-text token read counted a path cited wherever it stood as a token anywhere in the file, so a
 * bare prose line that happened to name the exact path (a seed Observation sentence) suppressed the fold:
 * the original D4 defect survived for that shape. The only shape that counts as a citation is an item of an
 * `(evidence: a, b, c)` segment, the exact shape appendEntityObservation writes (joined with `, `), read
 * from anywhere in the file. promote (writeGraphEntity) writes the canonical `## Observation` as the claim
 * with NO evidence token of its own, so the `(evidence: ...)` segments are the only citation shape here. A
 * path named in any other prose is NOT a citation. Each item is compared by exact string equality, never a
 * prefix or a substring, so a near-miss path (a trailing character or a directory prefix) does not cite the
 * lead's path. Idempotence holds because a fold writes `(evidence: ...)`: the next savepoint with the same
 * evidence finds it cited and appends nothing.
 */
function entityCitesEvidence(text, evidencePaths) {
  if (!(evidencePaths || []).length) return false;
  const cited = new Set();
  for (const m of String(text).matchAll(/\(evidence:\s*([^)]*)\)/g)) {
    for (const item of m[1].split(', ')) { const t = item.trim(); if (t) cited.add(t); }
  }
  return evidencePaths.every((p) => cited.has(p));
}

/*
 * ⛔ A MATCHING AUTOMATIC LEAD WITH NEW EVIDENCE GROWS THE ENTITY, IT DOES NOT MINT A TWIN (D4). The
 * graph's own convention is to extend an entity with observations rather than spawn a near-duplicate
 * (memory/knowledge-graph.md). So one dated line goes under `## Observations`; the canonical first
 * observation (`## Observation`) is left alone, so the register row — which shows the first observation
 * — does not move, and the entity's frontmatter gains nothing (G7 owns asOf and relations). Idempotent
 * on the evidence: a second update with the same evidence finds its line and appends nothing.
 */
function appendEntityObservation(absFile, claim, evidencePaths, whenISO) {
  let text;
  try { text = fs.readFileSync(absFile, 'utf8'); } catch { return { updated: false }; }
  if (entityCitesEvidence(text, evidencePaths)) return { updated: false, alreadyCited: true };
  const day = String(whenISO).slice(0, 10);
  const ev = (evidencePaths || []).length ? ` (evidence: ${evidencePaths.join(', ')})` : '';
  const line = `- ${day}: re-observed by savepoint — ${claim}${ev}`;
  const lines = text.split(/\r?\n/);
  const hdr = lines.findIndex((l) => l.trim() === OBSERVATIONS_HEADING);
  if (hdr < 0) {
    text = `${text.replace(/\s*$/, '')}\n\n${OBSERVATIONS_HEADING}\n${line}\n`;
  } else {
    let end = lines.length;
    for (let i = hdr + 1; i < lines.length; i++) { if (/^##\s/.test(lines[i])) { end = i; break; } }
    while (end > hdr + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(end, 0, line);
    text = lines.join('\n');
  }
  try { fs.writeFileSync(absFile, text); invalidateGraphSnapshot(); return { updated: true }; }
  catch { return { updated: false }; }
}

/*
 * ⛔ THE QUALIFICATION GATE FOR AN AUTOMATIC CAPTURE (D4). A deduped lead is linked as today. A NEW
 * claim is first checked against the durable records: no match mints it as a lead (unchanged); a match
 * on a graph entity with NEW evidence grows that entity and mints nothing; any other match is captured
 * and immediately REJECTED in the same run, naming the record a reader can open — so the audit shows
 * the lead was seen and where it lives, and no reviewer is handed a decision that was already made.
 */
function captureAutomatic(ctx, claim, klass, evidencePaths) {
  const { seen, durable, base, when, rejected, updates, pendingFolds, write } = ctx;
  const d = candidateDigest(claim, klass);
  if (seen.digests.has(d)) {
    const dup = seen.records.find((r) => candidateDigest(r.claim, r.klass) === d);
    return { id: dup ? dup.id : null, deduped: true, open: !!(dup && dup.verificationState === 'candidate') };
  }
  const match = core.candidates.qualifyClaim(claim, durable);
  if (match) {
    if (match.kind === 'graph-entity') {
      const target = durable.find((r) => r.kind === 'graph-entity' && r.ref === match.ref);
      if (target && target.file) {
        let text = '';
        try { text = fs.readFileSync(target.file, 'utf8'); } catch { text = ''; }
        if (!entityCitesEvidence(text, evidencePaths)) {
          /*
           * ⛔ GROWING THE ENTITY IS A WRITE INTO THE CURATED GRAPH, SO IT HAPPENS ON --write ONLY. The
           * graph is authored by a deliberate `promote` and a `--write` savepoint; a bare `--verify` is
           * read-only against it by the same contract that makes `--verify` re-check the derived docs
           * without rewriting them. On a verify the fold is not performed and nothing is minted, but the
           * pending fold is recorded so the lead is not dropped silently: the next `--write` performs it.
           * A match with NO new evidence falls through to capture-then-reject below, which DOES write the
           * candidates store — a verify already does exactly that for every automatic capture, so the
           * asymmetry is deliberate: a verify may write its own lead store, never the curated graph.
           */
          if (!write) { pendingFolds.push({ ref: match.ref, claim }); return { id: null, deduped: false, open: false, pendingFold: true }; }
          const upd = appendEntityObservation(target.file, claim, evidencePaths, when);
          if (upd.updated) {
            core.candidates.appendAudit(memoryStoreDir(), { action: 'observation-added', entity: match.ref, claim });
            updates.push({ ref: match.ref, claim });
            return { id: null, deduped: false, open: false, updated: true };
          }
        }
      }
    }
    const cap = captureCandidateOnce(seen, claim, klass, base, evidencePaths);
    if (cap.id && !cap.deduped) {
      core.candidates.reject(memoryStoreDir(), cap.id, { by: 'savepoint', reason: `already recorded: ${match.ref}` });
      rejected.push({ id: cap.id, claim, ref: match.ref });
    }
    return { id: cap.id, deduped: cap.deduped, open: false, rejectedRef: match.ref };
  }
  const cap = captureCandidateOnce(seen, claim, klass, base, evidencePaths);
  return { id: cap.id, deduped: cap.deduped, open: !!(cap.id && !cap.deduped), error: cap.error };
}

/*
 * decision #2a/#2c/#2b — the three evidence-backed capture sources, run every savepoint.
 *   findings.byCheck / .byFile   Map<check-or-file, candidateId> — feeds memoryProposals() below
 *   all                          [{id, klass, claim, source}]  — every NEWLY captured OPEN lead (not deduped,
 *                                 not auto-rejected as already recorded, not folded into an entity)
 *   operatorErrors               [{error}]  — a malformed/invalid --candidate arg
 *   rejectedDuplicates / observationUpdates  — D4's two "already recorded" outcomes, for the receipt
 */
function runCandidateCapture(state, checks, { write = false } = {}) {
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
  // D4: the durable records an automatic lead is qualified against, gathered once for this run. The
  // `write` flag gates the entity fold: a verify never authors the graph (see captureAutomatic).
  const rejected = [], updates = [], pendingFolds = [];
  const ctx = { seen, durable: durableRecords(state), base, when: new Date().toISOString(), rejected, updates, pendingFolds, write };
  // G4: whether this run's state-writeback FAIL has persisted long enough to file a lead (see above).
  const mintWriteback = stateWritebackMintDecision(checks);

  const byCheck = new Map();
  for (const c of checks) {
    if (c.outcome !== OUTCOME.FAIL && c.outcome !== OUTCOME.CANNOT_DETERMINE) continue;
    // G4: a first-time state-writeback FAIL is reported (the row and exit code stand) but not yet filed.
    if (c.check === 'state-writeback' && c.outcome === OUTCOME.FAIL && !mintWriteback) continue;
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
    // ⛔ G4 · A ROW MAY CARRY A STABLE `candidateClaim` SO A PERSISTING FAIL FILES ONE LEAD, NOT A STREAM.
    // `state-writeback`'s detail names the disk and fresh digests, which move when the register refresh
    // below rewrites LESSONS.md on a bare verify — so keying the lead on the detail minted a NEW,
    // non-deduped lead every time the digest shifted (the loop this task closes, one layer in). The row
    // supplies a stable claim that omits the volatile digests, so the same persisting disagreement dedups
    // to a single filed lead; the FAIL row and the exit code, with the digests, are untouched.
    const claim = c.candidateClaim || `${c.check}: ${c.detail}`;
    // D4: an open lead is linked for the prose proposal and counted; an already-recorded one is
    // rejected (or folded into its entity) inside captureAutomatic and is NOT linked or counted here.
    const r = captureAutomatic(ctx, claim, 'finding', [stateLib.STATE_FILE]);
    if (r.open) { byCheck.set(c, r.id); if (!r.deduped) all.push({ id: r.id, klass: 'finding', claim, source: 'check' }); }
  }
  const byFile = new Map();
  for (const rej of (state.evidence && state.evidence.rejected) || []) {
    if (!rej.reason.startsWith('stale revision')) continue;
    const claim = `evidence ${rej.file} stopped counting: ${rej.reason}`;
    const r = captureAutomatic(ctx, claim, 'finding', [`${stateLib.STATE_DIR}/evidence/${rej.file}`]);
    if (r.open) { byFile.set(rej.file, r.id); if (!r.deduped) all.push({ id: r.id, klass: 'finding', claim, source: 'stale-evidence' }); }
  }
  /*
   * A live goal constraint is NOT auto-captured as a candidate. A candidate memory is a LEAD,
   * something not yet recorded anywhere durable; a goal constraint is already durable, tracked and
   * verified at its source (docs/derived/state/goal.json, read by every contract check), so minting
   * it here would only add a second copy of a known fact that a reviewer has to reject by hand (the
   * field saw nine such candidates rejected as "already durable in goal.json"). The deliberate
   * operator path below (--candidate "constraint:...") is untouched: a human choosing to file a
   * constraint as a lead is the operator's call, even when its text matches the goal.
   */

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
    if (!r.deduped) {
      // D4: a deliberate operator capture is NEVER filtered. If it resembles a durable record, the
      // savepoint says so (a note the human decides on), but the lead is captured exactly as today.
      const match = core.candidates.qualifyClaim(text, ctx.durable);
      const entry = { id: r.id, klass, claim: text, source: 'operator' };
      if (match) entry.resembles = match.ref;
      all.push(entry);
    }
  }

  return {
    available: true, findings: { byCheck, byFile }, all, operatorErrors,
    rejectedDuplicates: rejected, observationUpdates: updates, pendingFolds,
    storeChanged: all.length > 0 || rejected.length > 0,
  };
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

function writeGraphEntity(type, slug, rec, { verifiedBy, by, relations = [], asOf = null, ruleTag = null, world = null }) {
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
  /*
   * ⛔ G7 · relations AND asOf ARE GRAPH-ONLY FIELDS THE STORE DOES NOT CARRY, SO A REPEAT READS THEM
   * BACK OFF THE ENTITY IT ALREADY WROTE — the same reason verifiedBy is read off the store, extended to
   * the two fields this task adds. A first promotion takes relations from --relates/--supersedes and asOf
   * from --as-of (defaulting asOf to promotedAt); a repeat to the SAME target preserves whatever the first
   * write recorded, so the file a reader opens never changes under a second promote. A genuine change is a
   * direct edit of the file, exactly as the conflict refusal above already says, and asOf never comes from
   * the clock (the promotedAt rule above, extended to asOf).
   */
  let relationsList = (relations || []).slice();
  let asOfValue = asOf || promotedAt;
  // G15 · ruleTag is a graph-only field (script|reader|both) the store does not carry, so a repeat reads
  // it back off the entity it already wrote — the same idempotence rule relations and asOf follow.
  let ruleTagValue = ruleTag;
  // G8 · the three binding fields, defaulting to the flags passed in; a repeat reads them back off the
  // entity (below) exactly as relations/asOf are, so the file stays byte-identical and nothing is
  // re-resolved from the clock or a moved HEAD on a second promote.
  let worldKind = world && world.kind;
  let worldValue = world && world.value;
  let worldLocator = world ? (world.locator || '') : null;
  try {
    const prior = fs.readFileSync(file, 'utf8');
    const fm = GRAPH_FRONTMATTER.exec(prior);
    const front = fm ? fm[1] : '';
    if (frontValue(front, 'promotedFrom') === rec.id) {
      relationsList = frontList(front, 'relations');
      asOfValue = frontValue(front, 'asOf') || promotedAt;
      ruleTagValue = frontValue(front, 'ruleTag') || ruleTag;
      worldKind = frontValue(front, 'worldRevisionKind');
      worldValue = frontValue(front, 'worldRevision');
      worldLocator = worldKind && worldValue ? (frontValue(front, 'worldRevisionLocator') || '') : null;
    }
  } catch { /* no prior entity at this path: a first promotion, keep the flags/defaults above */ }

  const frontLines = [
    '---',
    `id: ${type}:${slug}`,
    'aliases: []',
    `relations: [${relationsList.join(', ')}]`,
    `promotedFrom: ${rec.id}`,
    `promotedAt: ${promotedAt}`,
    `asOf: ${asOfValue}`,
    `verifiedBy: ${yamlString(verifiedBy)}`,
  ];
  // Only a bound entity carries the three fields; an unbound one writes none, so "absent" and "present"
  // stay distinct on disk. The locator line is always written for a binding (empty for a bare commit).
  if (worldKind && worldValue) {
    frontLines.push(`worldRevisionKind: ${worldKind}`);
    frontLines.push(`worldRevision: ${worldValue}`);
    frontLines.push(`worldRevisionLocator: ${worldLocator || ''}`);
  }
  if (by) frontLines.push(`promotedBy: ${yamlString(by)}`);
  // G15 · a `rule` entity records which gate half its confirmed rule rides (script|reader|both). Only a
  // rule promotion sets it, so a gotcha/infra/decision entity's frontmatter is byte-for-byte unchanged.
  if (ruleTagValue) frontLines.push(`ruleTag: ${ruleTagValue}`);
  frontLines.push('---', '');
  // ⛔ G7 · **Klass:** IS THE --as TYPE, NOT THE CANDIDATE'S KLASS. The field saw ~30 lessons filed under
  // gotcha/ still saying "Klass: finding", because promotion wrote the candidate's capture klass here and
  // --as never rewrote it. The entity now says what it IS (the type it was promoted as); the capture klass
  // is kept as a provenance line so nothing is lost.
  const body = [
    `# ${slug}`,
    '',
    `**Klass:** ${type}`,
    '',
    '## Observation',
    rec.claim,
    '',
    '## Provenance',
    `- captured as: ${rec.klass}`,
    `- captured by \`${rec.provenance.by || 'an unrecorded author'}\` in cycle \`${rec.provenance.cycleId}\` at ${rec.provenance.at}`,
    `- verified: ${verifiedBy}`,
    '',
  ].join('\n');

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${frontLines.join('\n')}\n${body}`);
    // A7: a new entity makes any memoised graph snapshot stale, so the next readGraphEntities re-reads.
    invalidateGraphSnapshot();
    // G7 · return the relations/asOf ACTUALLY on disk (the read-back values on a repeat), so the caller
    // never reports an edge a repeat did not write. G8 · the binding actually written, for the same reason.
    return { ok: true, file, relations: relationsList, asOf: asOfValue,
      world: worldKind && worldValue ? { kind: worldKind, value: worldValue, locator: worldLocator || '' } : null };
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

/** An inline frontmatter list `key: [a, b, c]`, unquoted. Empty for `[]` or an absent key. */
function frontList(front, key) {
  const m = new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\]`, 'm').exec(front);
  if (!m || !m[1].trim()) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^"([\s\S]*)"$/, '$1')).filter(Boolean);
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

/*
 * ⛔ ONE GRAPH READ PER INVOCATION (A7). The register's render AND verify paths, plus the pre- and
 * post-capture snapshots `cmdSavepoint` takes, each asked for the graph, so `savepoint` opened every
 * entity 8 times and `state` 4 times, for a list that is IDENTICAL on every call within one CLI run.
 * It is identical because the only writer of memory/graph in this process is `writeGraphEntity`
 * (promotion), which clears this memo, and no verb reads the register AFTER promoting in the same run.
 * So the first read is memoised and every later one returns the same snapshot. Only the GRAPH is cached:
 * `readCandidateRecords` is never memoised, because candidate CAPTURE mutates that store mid-savepoint
 * and `refreshLessonsRegister` must see the moved count.
 */
let graphSnapshot = null;
const invalidateGraphSnapshot = () => { graphSnapshot = null; };
function readGraphEntities() {
  if (!graphSnapshot) graphSnapshot = readGraphEntitiesUncached();
  return graphSnapshot;
}

/** Every promoted entity under memory/graph/, or the reason there is no list. */
function readGraphEntitiesUncached() {
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
      aliases: frontList(front, 'aliases'),
      // G7 · the schema's typed edges (`verb|dst-id`) and the as-of date the renderer derives supersession
      // and staleness from. Parsed through the same flat-scalar readers aliases and promotedAt use.
      relations: frontList(front, 'relations'),
      asOf: frontValue(front, 'asOf'),
      promotedAt: frontValue(front, 'promotedAt'),
      promotedFrom: frontValue(front, 'promotedFrom'),
      // G8 · the world-revision binding (the commit, doc digest or estate serial the lesson was true in),
      // parsed through the same flat-scalar reader every other field uses. Absent fields leave null, which
      // render.js/doctor read as "unbound"; a present-but-bad field is classified "malformed" there.
      worldRevisionKind: frontValue(front, 'worldRevisionKind'),
      worldRevision: frontValue(front, 'worldRevision'),
      worldRevisionLocator: frontValue(front, 'worldRevisionLocator'),
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

// G7 · the stale horizon this project declares (memory.staleHorizonDays), handed to the renderer on the
// store so render.js stays file-free. An absent or non-numeric value is left for render.js to default;
// read through the same pinned config reader the posture and mirror lookups use.
function configStaleHorizon() {
  const cfg = readJSON(path.join(DIR, 'respawnpack.config.json')) || {};
  const v = cfg.memory && cfg.memory.staleHorizonDays;
  return Number.isFinite(v) ? v : undefined;
}

// G8 · raw HEAD (git rev-parse HEAD; null with no repository or no commits). Used ONLY to bind a lesson to
// the commit a `--world commit` promotion is standing on. The CURRENT-revision comparison does NOT read raw
// HEAD (see currentRevisionsFor): after a documented closeout HEAD is a savepoint-only commit above the work
// the lesson was true in, so the comparison uses the EFFECTIVE source revision instead. Run here, not in the
// renderer, because render.js opens no file and runs no subprocess (the schema fence).
function headRevision() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

/** The first non-empty, trimmed line of a text, or null — an estate source's current serial. */
function firstNonEmptyLine(text) {
  for (const l of String(text == null ? '' : text).split(/\r?\n/)) { const t = l.trim(); if (t) return t; }
  return null;
}

// G8 · a document binding compares CONTENT, not line endings: fold CRLF to LF before digesting at capture
// AND at compare (the pack's one EOL-normalisation rule, install/_sources.js G1), so a cross-machine or
// autocrlf checkout that flipped line endings is not read as a move while any other byte change still is.
const docDigestOf = (text) => core.io.digest(String(text).replace(/\r\n/g, '\n'));

// G8 · the source-revision walk (effective + chain), resolved the way the compile resolves it, or null when
// the state subsystem cannot answer. Wrapped so a doctor / bare-verify read of a bound commit degrades to
// UNDETERMINABLE rather than throwing out of a count.
function sourceRevisionsOrNull() {
  try { return stateLib.sourceRevisionsOf(DIR); } catch { return null; }
}

/*
 * ⛔ G8 · THE CURRENT REVISIONS A BOUND LESSON IS COMPARED AGAINST, RESOLVED ONCE PER INVOCATION AND
 * WITHOUT NETWORK, then handed to render.js on the store the way staleHorizonDays and generatedAt are — so
 * the renderer still opens no file. Each bound document and each estate source is read ONLY if an entity
 * binds to it, through the SAME classified reader capture and review use (never a new raw read, and never in
 * the renderer). A value that could not be read is null, never a guess: "behind" is then undeterminable,
 * never a silent "current" (the honest infra degrade).
 *
 * ⛔ THE COMMIT IS THE EFFECTIVE SOURCE REVISION, NOT RAW HEAD — AND IS COMPARED BY CHAIN MEMBERSHIP. The
 * default binding is the candidate's cycleId = state.sourceRevision = sourceRevisionsOf(dir).effective (the
 * nearest ancestor of HEAD that is not a savepoint-only commit). After every documented closeout HEAD is a
 * savepoint-only commit sitting ABOVE that, so a raw `git rev-parse HEAD` compare would read every
 * default-bound lesson BEHIND although its source had not moved — the exact lag stateFreshness fixed with
 * `chain.includes(...)`. So the current commit is the effective revision and the equivalence class travels
 * on the store as `commitChain`; a binding is CURRENT when its value is in that chain. The walk is REUSED
 * from the compile when the caller has it (the savepoint path hands `revisions` in), and otherwise resolved
 * once through sourceRevisionsOf (doctor, a bare verify) — never a second `git rev-parse`.
 */
function currentRevisionsFor(graph, revisions) {
  const entities = graph && graph.status === 'OK' ? graph.entities : [];
  const docs = {}, estates = {};
  const notes = [];
  let needCommit = false;
  for (const e of entities) {
    const kind = e.worldRevisionKind, loc = e.worldRevisionLocator;
    if (kind === 'commit') { needCommit = true; continue; }
    if (kind === 'docDigest' && loc && !(loc in docs)) {
      const r = core ? core.io.readTextClassified(path.join(DIR, loc)) : { status: 'UNREADABLE', detail: 'core unavailable' };
      docs[loc] = r.status === 'OK' ? docDigestOf(r.text) : null;
      if (docs[loc] === null) notes.push(`the bound document ${loc} could not be read (${r.detail || r.status})`);
    } else if (kind === 'estateRevision' && loc && !(loc in estates)) {
      const r = core ? core.io.readTextClassified(path.join(DIR, loc)) : { status: 'UNREADABLE', detail: 'core unavailable' };
      estates[loc] = r.status === 'OK' ? firstNonEmptyLine(r.text) : null;
      if (estates[loc] === null) notes.push(`the estate source ${loc} is absent or has no non-empty line`);
    }
  }
  let commit = null, commitChain = [];
  if (needCommit) {
    const revs = (revisions && Array.isArray(revisions.chain)) ? revisions : sourceRevisionsOrNull();
    commit = (revs && revs.effective) || null;
    commitChain = (revs && revs.chain) || [];
    if (commit === null) notes.push('no commit revision could be read (not a git repository, or no commits yet)');
  }
  return { commit, commitChain, docs, estates, note: notes.length ? notes.join('; ') : null };
}

/**
 * The snapshot render.js's renderLessons/verifyLessons take. Read fresh per call — a count is derived every
 * time. `revisions` is the compile's own source-revision walk when the caller has it (the savepoint path),
 * so the current-commit resolution is reused rather than re-walked.
 */
function lessonsStore(state, revisions) {
  const graph = readGraphEntities();
  return {
    generatedAt: state && state.generatedAt,
    graph,
    candidates: readCandidateRecords(),
    // The store's own word for an unverified lead, carried rather than re-spelled: core/memory/candidates.js
    // is the one owner of that label and a second copy in the renderer is how it drifts.
    unverifiedMarker: core ? core.candidates.UNVERIFIED_MARKER : null,
    // G7 · the register's stale-by-horizon list reads this (default and disable live in render.js).
    staleHorizonDays: configStaleHorizon(),
    // G8 · the current revisions the behind comparison and `bound to` column read, resolved without network.
    currentRevisions: currentRevisionsFor(graph, revisions),
  };
}

const renderLessonsFrom = (state, existing, revisions) => render.renderLessons(existing, lessonsStore(state, revisions));

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
function refreshLessonsRegister(t, preStore, state, wroteDocs, revisions) {
  const abs = path.join(DIR, t.file);
  const existing = readText(abs);
  if (existing === null) return null; // nothing on disk to keep in step
  const postStore = lessonsStore(state, revisions);
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
 *   # Wave ledger               the TITLE: spawn-guard's own `#` heading. Boilerplate the fold
 *   > header prose              replaces with its own heading, so it is accounted for, not reproduced.
 *   - `<ISO>` · dispatch #N in flight · **<type>** — <what> · session <id>
 *     - the outcome, added by hand as the wave lands
 *   ## Current state            folded first, under the fold's own heading
 *   - free prose
 *   ## Progress log             ANY other heading an orchestrator keeps is a SECTION, carried under
 *   - more free prose           its own (demoted) heading rather than dropped (the G3 field loss).
 *
 * A DISPATCH GROUP is one dispatch line plus every line under it until the next dispatch or heading —
 * that grouping is what makes "one changelog line per wave, not per raw ledger line" possible. A group
 * with no lines under it means "started, fate unrecorded", which is exactly what a resume needs, so it
 * is folded as that rather than dropped.
 *
 * Every non-blank line lands in exactly one bucket: the title, the blockquote preamble, a Current
 * state line, a dispatch line, an outcome line, a section heading, a section line, or `uncarried`; and
 * `counts` tallies them, so "nothing was dropped" is a sum a test can check, not a hope. `uncarried` is
 * a non-blank line that fit no bucket (a stray line before the first dispatch is the obvious case); its
 * presence is what refuses the delete downstream, because a fold that cannot account for its whole
 * input must not destroy it. The TITLE is the ledger's own top-level (`#`) heading; the BLOCKQUOTE is
 * spawn-guard's preamble above all content; both are machine boilerplate the fold's heading replaces.
 */
function parseWaveLedger(text) {
  const groups = [];
  const currentState = [];
  const sections = [];   // every heading other than Current state, with the prose beneath it, in order
  const uncarried = [];  // non-blank lines that fit no bucket; the evidence the fold could not place them
  const counts = { title: 0, blockquote: 0, currentState: 0, dispatch: 0, outcome: 0, sectionHeading: 0, sectionLine: 0, uncarried: 0 };
  let group = null;
  let inCurrentState = false;
  let section = null;    // the open non-Current-state section, or null between them
  let sawTitle = false;
  let inPreamble = true; // the title and the auto-generated blockquote, both above the first content
  // G18 · a fenced code block is LITERAL content: its lines (and the ``` or ~~~ delimiters themselves)
  // are carried as prose of whatever section is open, never read as a heading or a `· dispatch #` group.
  // `fenceOpenLine` remembers where an UNTERMINATED fence began, reported so the fold keeps the ledger
  // rather than swallowing everything after a stray ``` into one section silently.
  let inFence = false;
  let fenceOpenLine = 0;
  let n = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    n += 1;
    const line = raw.replace(/\s+$/, '');
    const blank = !line.trim();
    const fenceDelim = /^\s*(`{3,}|~{3,})/.test(line);
    if (fenceDelim) { inFence = !inFence; if (inFence) fenceOpenLine = n; inPreamble = false; }
    const literal = inFence || fenceDelim; // a fenced line, or the delimiter itself, is not markup
    if (!literal && /^#{1,6}\s/.test(line)) {
      group = null; // a heading ends a dispatch group and any open section both
      if (/^#{1,6}\s+current state\b/i.test(line)) { inCurrentState = true; section = null; inPreamble = false; counts.currentState += 1; continue; }
      inCurrentState = false;
      if (/^#\s/.test(line) && !sawTitle) { sawTitle = true; section = null; counts.title += 1; continue; } // the ledger's own title
      section = { heading: line.trim(), lines: [] };
      sections.push(section);
      inPreamble = false;
      counts.sectionHeading += 1;
      continue;
    }
    if (!literal && inPreamble && /^\s*>/.test(line)) { if (!blank) counts.blockquote += 1; continue; } // the auto-generated preamble
    if (inPreamble && blank) continue;
    if (inCurrentState) { currentState.push(line); if (!blank) counts.currentState += 1; continue; }
    if (!literal && /·\s*dispatch\s*#/i.test(line)) { group = { dispatch: line.trim(), outcomes: [] }; groups.push(group); inPreamble = false; counts.dispatch += 1; continue; }
    if (group) { if (blank) continue; group.outcomes.push(line.trim().replace(/^[-*]\s+/, '')); counts.outcome += 1; continue; }
    if (section) { section.lines.push(line); if (!blank) counts.sectionLine += 1; continue; }
    if (blank) continue;
    inPreamble = false;
    uncarried.push({ line: line.trim(), lineNumber: n });
    counts.uncarried += 1;
  }
  const trimEdges = (arr) => {
    while (arr.length && !arr[0].trim()) arr.shift();
    while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
  };
  trimEdges(currentState);
  for (const s of sections) trimEdges(s.lines);
  // G18 · an unterminated fence never closed, so the parser could not know where the fenced block ended:
  // report WHERE it opened so the fold keeps the ledger and names it, rather than deleting a file it could
  // not structure. Not counted against the bucket sum, since every real line was still carried into a bucket.
  return { groups, currentState, sections, uncarried, counts, unterminatedFence: inFence ? fenceOpenLine : null };
}

/** Non-blank lines of a ledger, counted straight from the text: the independent total the buckets must sum to. */
const nonBlankLines = (text) => String(text).split(/\r?\n/).filter((l) => l.trim()).length;

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
function ledgerFoldSection(parsed, whenISO, { carriedDispatches = [], kept = false } = {}) {
  const unresolved = parsed.groups.filter((g) => !g.outcomes.length).length;
  // A carried heading is demoted one level so the fold's own `##` stays the top of its section.
  const demote = (h) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(h);
    return m ? `${'#'.repeat(Math.min(6, m[1].length + 1))} ${m[2]}` : `### ${h}`;
  };
  const fate = kept
    ? 'and kept on disk, because some of its lines could not be placed (see the wave-ledger row below)'
    : 'which was then deleted: it is mid-run scratch and this is its permanent home';
  const L = ['', '', '## Current state — folded from the wave ledger', ''];
  L.push(`_Folded from \`${removalsLib.posix(WAVE_LEDGER_REL)}\` at ${whenISO}, ${fate}._`);
  L.push('');
  if (parsed.currentState.length) for (const line of parsed.currentState) L.push(line);
  // The sentence belongs to a ledger with no state AND nothing else to carry. A Progress log the
  // orchestrator kept by hand IS something else to carry, so it stands in rather than being masked.
  else if (!parsed.sections.length) L.push('- the ledger recorded no "Current state" section');
  for (const s of parsed.sections) {
    L.push('');
    L.push(demote(s.heading));
    L.push('');
    for (const line of s.lines) L.push(line);
  }
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
  if (!parsed.groups.length && !parsed.currentState.length && !parsed.sections.length) {
    return result(OUTCOME.NOT_APPLICABLE, 'wave-ledger',
      `${rel} carries no dispatch group, no "Current state" section and no other heading, so there is nothing to fold: nothing was folded and the file was left in place.`);
  }

  const subjects = parsed.groups.length + (parsed.currentState.length ? 1 : 0) + parsed.sections.length;
  const accounting = { ...parsed.counts, nonBlank: nonBlankLines(text) };
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

  /*
   * A ledger the fold could not fully account for is KEPT, so nothing in it is destroyed: an `uncarried`
   * line that fit no section, OR an unterminated code fence (G18) whose missing close means the parser
   * could not be sure where the fenced block ended. What could be carried still lands in CONTINUITY, whose
   * fold block is REPLACED, never appended, so re-running is idempotent; but the dispatch lines are NOT
   * appended to the changelog on this path: that append is not idempotent, and the fix-and-re-run the row
   * asks for would duplicate them. They stay in the kept ledger until a clean fold carries them once.
   */
  const unterminated = Boolean(parsed.unterminatedFence);
  const uncarried = parsed.uncarried.length > 0 || unterminated;
  const lines = parsed.groups.map(changelogLineFor);
  const clAbs = path.join(DIR, DERIVED_CHANGELOG_REL);
  const changelog = readText(clAbs);
  const toChangelog = !uncarried && changelog !== null && lines.length > 0;
  const writes = [
    { abs: contAbs, text: withLedgerBlock(cont, ledgerFoldSection(parsed, when, { carriedDispatches: toChangelog ? [] : lines, kept: uncarried })) },
  ];
  if (toChangelog) writes.push({ abs: clAbs, text: foldIntoChangelog(changelog, lines, when) });

  try {
    // The rendered docs are written first and the ledger is removed last, so a failure anywhere leaves
    // the ledger on disk and the next run folds it again, never the other way round. An unaccounted
    // ledger is never removed, so no uncarried line can leave with it.
    for (const w of writes) stateLib.writeAtomic(w.abs, w.text);
    if (!uncarried) fs.rmSync(abs);
  } catch (e) {
    return result(OUTCOME.CANNOT_DETERMINE, 'wave-ledger',
      `the fold of ${rel} could not be completed (${(e && e.message) || e}). The ledger was NOT deleted; re-run \`savepoint --write\` once the cause is fixed.`, { checked: 0 });
  }
  if (uncarried) {
    const parts = [];
    if (parsed.uncarried.length) {
      const named = parsed.uncarried.map((u) => `line ${u.lineNumber}: "${u.line.slice(0, 80)}"`).join('; ');
      parts.push(`${parsed.uncarried.length} line(s) fell outside every section the fold understands (${named})`);
    }
    if (unterminated) parts.push(`a code fence opened at line ${parsed.unterminatedFence} was never closed, so the fenced block's extent cannot be proven`);
    return result(OUTCOME.CANNOT_DETERMINE, 'wave-ledger',
      `${rel} was folded into ${removalsLib.posix(CONTINUITY_REL)} but NOT deleted: ${parts.join('; and ')}, so it cannot prove it accounted for the whole file. Nothing was lost: what could be carried was, and the rest stays in the kept ledger. Fix the issue(s), then re-run \`savepoint --write\`.`,
      { checked: subjects, accounting });
  }
  const where = !lines.length
    ? 'it carried no dispatch group'
    : toChangelog
      ? `${lines.length} dispatch group(s) appended to the most recent entry of ${removalsLib.posix(DERIVED_CHANGELOG_REL)}`
      : `${lines.length} dispatch group(s) folded into ${removalsLib.posix(CONTINUITY_REL)}, because this project has no ${removalsLib.posix(DERIVED_CHANGELOG_REL)} to append them to`;
  return result(OUTCOME.PASS, 'wave-ledger',
    `folded ${rel} and deleted it: ${where}, and its current state and ${parsed.sections.length} other section(s) folded into the generated block of ${removalsLib.posix(CONTINUITY_REL)}. Outcomes inside a ledger are recorded by hand, so what is folded is what somebody wrote, not what this run observed.`,
    { checked: subjects, accounting });
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
function renderStalenessChecks(state, revisions, decisionsScan) {
  const equivalentRevisions = (revisions && revisions.chain) || [];
  const targets = [
    { file: path.join('docs', 'derived', 'CONTINUITY.md'), render: renderContinuityFolded },
    { file: path.join('docs', 'derived', 'GAPS.md'), render: render.renderGaps },
    // G8 · hand the compile's own source-revision walk to the lessons render, so the current-commit
    // resolution is reused rather than re-walked (one git walk per `state` run, the same one above).
    { file: path.join('docs', 'derived', 'LESSONS.md'), render: (st, existing) => renderLessonsFrom(st, existing, revisions) },
  ];
  const rows = [];
  const staleRow = (verdict) => result(OUTCOME.CANNOT_DETERMINE, verdict.check,
    `${verdict.detail} \`state\` only compiles STATE.json and never renders or writes the docs — run \`savepoint --write\` to regenerate this one.`,
    { checked: verdict.checked });
  for (const t of targets) {
    const existing = readText(path.join(DIR, t.file));
    if (existing === null) continue; // nothing rendered here yet — savepoint's migration/creation story owns that, not this report
    const fresh = t.render(state, existing);
    const verdict = render.driftFromGenerated(existing, fresh, t.file, { equivalentRevisions });
    if (verdict.outcome === OUTCOME.PASS) continue; // fresh docs stay quiet
    rows.push(staleRow(verdict));
  }
  // B2 · the decision index, reported only when the shard exists AND docs/DECISIONS.md is a rendered
  // index (not an unsplit monolith, which `migrate decisions` owns, not this report).
  const decFile = path.join('docs', 'DECISIONS.md');
  const existing = readText(path.join(DIR, decFile));
  const hasShard = decisionsScan && decisionsScan.status === 'OK' && (decisionsScan.records || []).length > 0;
  if (hasShard && existing !== null && existing.includes(render.GEN_OPEN)) {
    const fresh = render.renderDecisions(existing, { ...decisionsScan, generatedAt: state.generatedAt });
    const verdict = render.driftFromGenerated(existing, fresh, decFile, { equivalentRevisions });
    if (verdict.outcome !== OUTCOME.PASS) rows.push(staleRow(verdict));
  }
  return rows;
}

function cmdState() {
  const { state, findings, revisions, removalsScan, decisionsScan } = stateLib.compile(DIR);
  // Beside STATE.json: the corpus record the next incremental scan reads as its prior (B3), written
  // FIRST so the digest STATE.json records is over the bytes now on disk (the same binding savepoint's
  // writeback stage records, so a `state` run and a `savepoint` run leave STATE.json agreeing with
  // corpus.json the same way).
  if (removalsScan && removalsScan.corpusRecord) stateLib.writeCorpus(DIR, removalsScan.corpusRecord);
  if (state.removals && typeof state.removals === 'object') {
    state.removals.corpusDigest = removalsScan && removalsScan.corpusRecord
      ? stateLib.corpusDigestOfRecord(removalsScan.corpusRecord) : stateLib.corpusDigestOnDisk(DIR);
  }
  const file = stateLib.write(DIR, state);
  // The exit-governing outcome is rolled up from the COMPILE findings only, exactly as before this
  // fix — a stale render is reported below but must never change `state`'s own exit code.
  const outcome = rollup(findings.length ? findings : [result(OUTCOME.PASS, 'compile', 'state compiled')]);
  const reported = [...findings, ...renderStalenessChecks(state, revisions, decisionsScan)];
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
function stateWritebackCheck(state, write, corpusRecord) {
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
    /*
     * `removals.lastFullScanAt` is excluded alongside `generatedAt`. A `savepoint --verify --full`
     * legitimately re-derives a fresh stamp it must NOT persist (a verify never writes), so comparing it
     * fresh-against-disk would manufacture a FAIL over the one value the verify is correct not to move.
     * The durable stamp advances only on a `--write`. The record this timestamp attests (the corpus
     * manifest and per-file findings) now lives in docs/derived/state/corpus.json and is digested into
     * `removals.corpusDigest`, which stays in the comparison — so the exclusion cannot soften the
     * forged-prior check, and a hand edit to corpus.json still FAILs this row through that one line.
     */
    const durableDigest = (s) => {
      // `handoff` (D3) is excluded alongside `generatedAt`: it is a WRITE-TIME snapshot of volatile tree
      // facts, so the compiler never produces it and a fresh verify compile carries none; comparing it
      // fresh-against-disk would manufacture a FAIL over the one field a verify is correct not to move.
      const { generatedAt, handoff, ...rest } = s;
      if (rest.removals && typeof rest.removals === 'object') rest.removals = { ...rest.removals, lastFullScanAt: null };
      return core.io.canonicalDigest(rest);
    };
    // Bind corpus.json by the digest of its bytes ON DISK NOW — so a hand edit to it disagrees with the
    // digest STATE.json recorded at the last --write. The verify writes nothing; it only reads the file.
    if (state.removals && typeof state.removals === 'object') state.removals.corpusDigest = stateLib.corpusDigestOnDisk(DIR);
    const fresh = durableDigest(state), disk = durableDigest(onDisk);
    return fresh === disk
      ? result(OUTCOME.PASS, 'state-writeback', `STATE.json on disk agrees with a fresh compile, verified by digest (${fresh.slice(0, 12)}) — left untouched (verify-only run)`, { checked: 1 })
      : result(OUTCOME.FAIL, 'state-writeback',
        `${stateLib.STATE_FILE} on disk does not match a fresh compile (disk ${disk.slice(0, 12)}, fresh ${fresh.slice(0, 12)}) — it is stale or was hand-edited. Nothing was written: run \`savepoint --write\` to regenerate it.`,
        // `writebackPair` IDENTIFIES this FAIL for the two-run mint marker; `candidateClaim` is the STABLE
        // text the filed lead carries, with the volatile digests dropped so a persisting FAIL dedups to one
        // lead even as the register refresh shifts the fresh digest between verify runs (see runCandidateCapture).
        { checked: 1, writebackPair: `${disk}:${fresh}`, candidateClaim: `state-writeback: ${stateLib.STATE_FILE} on disk is stale or was hand-edited and does not match a fresh compile — run \`savepoint --write\` to regenerate it.` });
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
  // Beside STATE.json, on the same run, from the same scan (B3). corpus.json lands FIRST so the digest
  // STATE.json records is over the exact bytes now on disk; a verify-only run against an existing file
  // returned above and wrote nothing. The digest is recorded whether or not a record was produced
  // (ABSENT when the scan threw and wrote no file), so STATE.json always vouches for the file's state.
  if (corpusRecord) stateLib.writeCorpus(DIR, corpusRecord);
  if (state.removals && typeof state.removals === 'object') {
    state.removals.corpusDigest = corpusRecord ? stateLib.corpusDigestOfRecord(corpusRecord) : stateLib.corpusDigestOnDisk(DIR);
  }
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
      : 'STATE.json write could not be read back at all after writing',
    { checked: 1, writebackPair: `${writtenDigest}:${readBackDigest || 'unreadable'}`, candidateClaim: 'state-writeback: STATE.json was written but could not be verified by read-back — the write did not land as intended.' });
}

/*
 * ⛔ G4 · STATE.json RECORDS THE DOCUMENTS THE RENDER WROTE, ON THE SAME RUN.
 *
 * STATE.json is persisted at the `writeback` stage, BEFORE `render`. But `render`, the register refresh,
 * and the wave-ledger fold all rewrite documents that live in the scanned corpus, so when `docs/derived/`
 * is a live-content directory the committed corpus manifest describes the PRE-render tree. After a
 * `--write` that MOVED any of their content (a bumped LESSONS count, a re-rendered body), the next bare
 * `--verify` compiled a different corpus digest and FAILed `state-writeback` over a change this run made,
 * and one `--write` never converged. This re-persists STATE.json's three compared fields so the FINAL
 * tree is what a later verify is measured against. It re-digests the render targets from their on-disk
 * bytes through the SAME stamp-blind `corpusManifest` the compiler uses (so the generation stamp stays
 * out, and no second `runRemovalScan` is spent — the scan-count fence stays at two), patches only the
 * entries the corpus already holds (a project that does not scan `docs/derived/` has none, so this is a
 * no-op there), and carries the post-render scan's real per-file findings (so a reintroduced killed
 * feature the render itself wrote is still recorded, BUG-3, rather than papered over). The re-persist is
 * verified by a digest read-back, exactly as the `writeback` write is, and it writes only when a document
 * actually moved, so a no-op `--write` adds no row and no second write.
 */
function persistConvergedState(state, note = '') {
  stateLib.write(DIR, state);
  if (!core) {
    return result(OUTCOME.CANNOT_DETERMINE, 'state-writeback:converge',
      'core/ could not be loaded, so the reconciling STATE.json write could not be verified by digest', { checked: 0 });
  }
  const wrote = core.io.canonicalDigest(state);
  const back = stateLib.read(DIR);
  const backDigest = back ? core.io.canonicalDigest(back) : null;
  return backDigest === wrote
    ? result(OUTCOME.PASS, 'state-writeback:converge',
      `STATE.json re-persisted so its corpus manifest matches the documents this run rendered, verified by digest read-back (${wrote.slice(0, 12)}) — a following bare \`--verify\` now agrees with this write.${note}`, { checked: 1 })
    : result(OUTCOME.FAIL, 'state-writeback:converge', back
      ? `STATE.json was re-persisted to match the rendered documents but reads back different content (wrote ${wrote.slice(0, 12)}, read ${String(backDigest).slice(0, 12)})`
      : 'the reconciling STATE.json write could not be read back at all', { checked: 1 });
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

/*
 * ⭐ D3 · THE VOLATILE FACTS THE HANDOFF RENDER NEEDS, computed HERE because kernel/lib/render.js opens
 * no file. The mode is the runtime contract's (read through hooks/_runtime.js, best-effort — an absent
 * or unreadable one leaves it null and the Current-task section still renders from the durable goal).
 * "Files touched" is the session's tree delta against the recorded baseline; with no baseline for this
 * session it lists the current uncommitted files instead and SAYS so, never an empty delta (the
 * precompact record's `uncommittedFiles` is the precedent). "Verify commands" are the project's own
 * declared validator adapters plus the pack's own `savepoint --verify`, LISTED as commands, never run.
 */
const HANDOFF_FILES_CAP = 25;

function handoffVerifyCommands() {
  const cmds = [];
  for (const a of (config().adapters || [])) {
    if (!a || typeof a.command !== 'string' || !a.command.trim()) continue;
    const argStr = Array.isArray(a.args) ? a.args.join(' ') : '';
    cmds.push(`${a.command}${argStr ? ` ${argStr}` : ''}`.trim().slice(0, 200));
  }
  // The pack's own verify is always a valid command for this project; dedupe so a config that happens to
  // declare it is not listed twice.
  cmds.push('node .claude/respawnpack/respawnpack.js savepoint --verify');
  return [...new Set(cmds)];
}

function handoffFilesTouched() {
  if (!runtimeLib || typeof runtimeLib.treeState !== 'function' || typeof runtimeLib.pathOf !== 'function') {
    return { source: 'unavailable', shown: [], total: 0, truncated: false };
  }
  let ts;
  try { ts = runtimeLib.treeState(DIR); } catch { ts = null; }
  if (!ts) return { source: 'unavailable', shown: [], total: 0, truncated: false };
  const sid = process.env.CLAUDE_SESSION_ID || null;
  let files = null;
  let headMoved = false;
  if (sid && typeof runtimeLib.sessionDelta === 'function') {
    let delta = null;
    try { delta = runtimeLib.sessionDelta(DIR, sid, ts); } catch { delta = null; }
    // CANNOT_DETERMINE means there was no baseline for this session; fall through to the uncommitted list
    // rather than report a delta nobody could compute.
    if (delta && delta.status !== 'CANNOT_DETERMINE') { files = delta.files || []; headMoved = Boolean(delta.headMoved); }
  }
  const source = files !== null ? 'session-delta' : 'uncommitted';
  if (files === null) files = [...new Set(Object.keys(ts.files).map(runtimeLib.pathOf))].sort();
  /*
   * ⛔ THE HANDOFF'S FILES-TOUCHED EXCLUDES THE SAVEPOINT'S OWN OUTPUTS, AND THAT IS WHAT MAKES IT
   * IDEMPOTENT. A `--write` regenerates docs/derived/** (this document among them) and may write a
   * candidate under memory/candidates/**, so a list computed before the write would omit them while a
   * later `--verify` computed over the post-write tree would include them — the block would differ from a
   * fresh render and FAIL generated-block for a change the savepoint itself made. Dropping the pack's own
   * derived outputs keeps the list to the SESSION'S work (which is what "files touched" means to the next
   * session) and leaves it unchanged across the write that renders the handoff.
   */
  files = files.filter((f) => !f.startsWith('docs/derived/') && !f.startsWith('memory/candidates/'));
  return { source, total: files.length, truncated: files.length > HANDOFF_FILES_CAP, shown: files.slice(0, HANDOFF_FILES_CAP), headMoved };
}

// The runtime contract mode for the handoff's Current-task section. Runtime, best-effort: an absent or
// unreadable contract.json leaves it null and the section still renders from the durable goal.
function handoffMode() {
  if (runtimeLib && typeof runtimeLib.readContract === 'function') {
    try { const ctr = runtimeLib.readContract(DIR); return ctr && ctr.mode ? ctr.mode : null; } catch { return null; }
  }
  return null;
}

// The short id a write stamps on its frozen files-touched snapshot, stable for the same delta at the same
// source so a no-op re-write keeps the same HANDOFF.md body and a real change refreshes it.
function handoffWriteCycle(filesTouched, sourceRevision) {
  return crypto.createHash('sha256').update(JSON.stringify({ ft: filesTouched, src: sourceRevision || null })).digest('hex').slice(0, 8);
}

// D3: HANDOFF.md's byte ceiling, the inner bound the renderer enforces before the 1,500-word outer bound,
// so a busy project's handoff cannot quietly bust the boot budget. Default 1,600 B — on the merged tree
// the example's boot set has ~1,815 B of headroom under the 32,000 B ceiling with HANDOFF removed, so
// 1,600 keeps the WORST case (HANDOFF at its cap) under the ceiling with margin, proven at the cap by
// skills/respawn/boot-set.test.mjs. Overridable by `state.handoffByteCap`; a non-positive or non-number
// value is ignored and the default holds.
const HANDOFF_BYTE_CAP = 1600;
function handoffByteCap() {
  const v = config().handoffByteCap;
  return Number.isFinite(v) && v > 0 ? v : HANDOFF_BYTE_CAP;
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
  // `--full` forces the removal scan to carry nothing and re-derive every finding from the tree, both in
  // the compiler's scan and in the post-render re-scan below. The default stays incremental.
  const removalsFull = flag('--full');
  const { state, findings, revisions, removalsScan, lineageScan, reconciliation, decisionsScan } = stateLib.compile(DIR, { removalsFull });
  checks.push(...findings);

  const renderRan = runs('render');
  const verifyRan = runs('verify');
  const wroteDocs = write && renderRan;
  /*
   * ⛔ D3 · THE HANDOFF'S VOLATILE FACTS ARE FROZEN AT WRITE TIME INTO STATE.json, BEFORE the writeback
   * stage persists it, so a later `--verify` renders docs/derived/HANDOFF.md from this snapshot and never
   * calls `treeState` (the ~300 ms warm / seconds-cold read A5's cheap verify must not pay again). A
   * writing render computes the files-touched delta ONCE here; a `--write` that skipped render carries the
   * last full write's snapshot forward so the writeback write does not drop it; a verify computes nothing.
   * The snapshot is excluded from `state-writeback`'s durable digest, so a fresh compile (which carries no
   * handoff) still agrees with the on-disk STATE.json that does.
   */
  let handoffData = null;
  if (wroteDocs) {
    const ft = handoffFilesTouched();
    // G17: the ops-log snapshot is frozen here with the files-touched delta, BEFORE the savepoint appends
    // its own row (below) - so a later --verify renders the same count a fresh render would. Omitted when
    // there is no log, so HANDOFF says "no ops log on this machine" and STATE.json gains no bytes for it.
    const opsSnap = core ? opsLogSnapshot() : null;
    state.handoff = { writeCycle: handoffWriteCycle(ft, state.sourceRevision), filesTouched: ft, ...(opsSnap ? { opsLog: opsSnap } : {}) };
  } else if (write) {
    const frozen = (stateLib.read(DIR) || {}).handoff;
    if (frozen) state.handoff = frozen;
  }
  if (renderRan || verifyRan) {
    // On a writing run the frozen snapshot is the one just injected into `state`; on a verify it is the one
    // on disk. Either way HANDOFF.md renders from it, so render and verify see the identical files-touched.
    const frozen = (write ? state : (stateLib.read(DIR) || {})).handoff || null;
    handoffData = {
      mode: handoffMode(),
      filesTouched: (frozen && frozen.filesTouched) || { source: 'unavailable', shown: [], total: 0, truncated: false },
      verifyCommands: handoffVerifyCommands(),
      writeCycle: (frozen && frozen.writeCycle) || null,
      byteCap: handoffByteCap(),
      // The log count is the FROZEN snapshot (write and verify agree); the open incidents are read LIVE
      // from memory/incidents/ (tracked, moved only by a verb, the way the lessons counts are read).
      opsLog: (frozen && frozen.opsLog) || null,
      openIncidents: core ? openIncidentsLive() : { ids: [], total: 0 },
    };
  }

  if (runs('writeback')) checks.push(stateWritebackCheck(state, write, removalsScan.corpusRecord));
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
      render: (st, existing) => render.renderLessons(existing, lessonsPre || lessonsStore(st, revisions)),
      verify: (text, st, opts) => render.verifyLessons(text, lessonsPre || lessonsStore(st, revisions), opts),
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
    /*
     * ⛔ D3 · THE FOURTH TARGET IS THE POINTER-FIRST HANDOFF, FULLY GENERATED LIKE LESSONS. It has no
     * hand-authored predecessor and NO NOTE block of its own — its generated block points at CONTINUITY's
     * note, one note not two — so the first `--write` CREATES it and there is nothing to migrate. Its
     * volatile facts (the contract mode, the files-touched delta, the project's verify commands) are
     * computed once into `handoffData` and handed to the renderer, which opens no file. Its one numeric
     * claim is the TRUE next-unblocked count, verified back against STATE.json by the default
     * verifyRendered exactly as CONTINUITY's is; a hand edit to the block FAILs `generated-block`.
     */
    {
      file: path.join('docs', 'derived', 'HANDOFF.md'),
      fullyGenerated: true,
      noNote: true,
      render: (st) => render.renderHandoff(handoffData, st),
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
  // The one memory-store snapshot this run renders and verifies the lessons register against, taken
  // BEFORE the memory stage can capture anything into it. refreshLessonsRegister() compares it against
  // the post-capture store afterwards, which is how "this run's own capture moved the counts" is told
  // apart from "somebody hand-edited the register". (renderRan/verifyRan/wroteDocs and the D3 handoff
  // snapshot are resolved above, before the writeback stage that persists the snapshot into STATE.json.)
  const lessonsPre = (renderRan || verifyRan) ? lessonsStore(state, revisions) : null;
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
    // A target with `noNote` (HANDOFF.md) carries no NOTE block of its own — its generated block points
    // at CONTINUITY's note — so there is no note budget to enforce or report for it.
    if (renderRan && !t.noNote) {
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

  /*
   * ⛔ B2 · THE DECISION INDEX IS A FOURTH RENDERED, VERIFIED DOCUMENT, BUT NOT A MEMBER OF THE LOOP
   * ABOVE — and that is deliberate. Its source is the shard directory (decisionsScan), not STATE.json;
   * and the generic loop's planMigration would archive a `docs/DECISIONS.md` monolith into a NOTE block,
   * which is NOT the structured split the format needs. The monolith is split only by `migrate decisions`,
   * so here the index is rendered and verified ONLY when the shard exists, and a monolith is never
   * overwritten — it is named, with the verb that migrates it.
   */
  if ((renderRan || verifyRan) && decisionsScan) {
    const decFile = path.join('docs', 'DECISIONS.md');
    const decId = removalsLib.posix(decFile);
    const abs = path.join(DIR, decFile);
    const existing = readText(abs);
    const store = { ...decisionsScan, generatedAt: state.generatedAt };
    const hasShard = store.status === 'OK' && (store.records || []).length > 0;
    const isRendered = existing !== null && existing.includes(render.GEN_OPEN);
    if (!hasShard) {
      // A monolith present but unsplit is a VALID legacy state, not a defect: the shard is an opt-in the
      // `migrate decisions` verb adopts, so this is NOT_APPLICABLE (exit 0) with a hint, never a
      // CANNOT_DETERMINE that would flip a passing project to a failing savepoint on upgrade. A project
      // with no decisions at all, or an already-rendered empty index, leaves nothing to say here.
      if (renderRan && existing !== null && !isRendered) {
        checks.push(result(OUTCOME.NOT_APPLICABLE, `render:${decId}`,
          'docs/DECISIONS.md is a monolith, not yet split into the decision shard — run `respawnpack migrate decisions --write` to adopt docs/decisions/ and a verified index. The monolith is valid as is; savepoint never rewrites it, so nothing was changed and the index is not verified here.'));
      }
    } else if (existing !== null && !isRendered) {
      // The shard exists AND docs/DECISIONS.md is still a hand-authored monolith (an interrupted
      // `migrate decisions --write`, or files authored by hand): refuse to overwrite it rather than
      // silently clobber a founder's file. archive-never-delete. The migrate verb resumes the split.
      if (renderRan) checks.push(result(OUTCOME.CANNOT_DETERMINE, `render:${decId}`,
        `docs/decisions/ holds ${store.records.length} shard file(s) but docs/DECISIONS.md is not a rendered index, so the split is not complete. Run \`migrate decisions --write\`: it archives the monolith, writes the missing shard files, and refuses on any file that does not match the monolith. savepoint will not overwrite a hand-authored file, so nothing was changed.`, { checked: 0 }));
    } else {
      const notePlan = render.planNote(existing || '', 'DECISIONS.md', state);
      if (notePlan.overflow && wroteDocs) {
        const noteArchiveAbs = path.join(DIR, notePlan.archiveRel);
        if (!fs.existsSync(noteArchiveAbs)) stateLib.writeAtomic(noteArchiveAbs, `${notePlan.full}\n`);
      }
      if (renderRan) checks.push(postureRelaxed(render.noteBudgetCheck(notePlan, { file: decFile, write: wroteDocs }),
        KERNEL_POSTURE_ROWS.noteBudget, { when: !wroteDocs || (posturePolicy() || {}).profile === 'light' }));
      const fresh = render.renderDecisions(existing, store);
      if (wroteDocs) stateLib.writeAtomic(abs, fresh);
      const text = wroteDocs ? fresh : (existing || fresh);
      if (verifyRan) {
        checks.push(render.verifyDecisions(text, store, { file: decFile }));
        if (!wroteDocs && existing !== null) checks.push(render.driftFromGenerated(existing, fresh, decFile, { equivalentRevisions }));
      }
    }
  }
  if (!verifyRan) checks.push(skipRow('verify', { note: 'No rendered claim was checked back against its source.' }));

  /*
   * ⛔ D3 · THE HOST MEMORY POINTER RIDES WITH THE RENDER. A `--write` that rendered HANDOFF.md also
   * refreshes the ONE `project` line in the host's auto memory pointing at it, so a fresh session finds
   * the handoff from the index the host reads first. Idempotent (byte-identical when nothing changed, one
   * line ever), three-valued like C3's mirror (PASS / NOT_APPLICABLE when no auto memory directory exists
   * / CANNOT_DETERMINE at the host cap with the file still written), and NEVER reached by a verify-only
   * run — a verify never writes. A fault here is reported beside the render rows, never a reason to fail a
   * real savepoint. The line is a POINTER: it names what the handoff is for, never any project content.
   */
  if (wroteDocs) {
    let mem;
    // A host write fault is clamped to NOT_APPLICABLE for the same reason the cap is (writeHandoffMemoryLine):
    // a machine-local projection that could not be written must never decide the PROJECT's verdict, so it
    // cannot turn an all-PASS savepoint into a non-zero exit.
    try { mem = writeHandoffMemoryLine(); }
    catch (e) { mem = { outcome: 'NOT_APPLICABLE', detail: `the host handoff-memory pointer could not be written (${(e && e.code) || (e && e.message) || e}); the handoff is in the repository regardless` }; }
    // `ephemeral`: a host-memory note is not a durable lead — auto-capturing it would grow the store with a
    // candidate about the host's own memory file. Only PASS and NOT_APPLICABLE are possible here; neither
    // fails the savepoint, so the project verdict never hinges on the host's memory directory.
    checks.push(result(OUTCOME[mem.outcome] || OUTCOME.NOT_APPLICABLE, 'handoff-memory', mem.detail, { checked: mem.outcome === 'PASS' ? 1 : 0, ephemeral: true }));
  }

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
   * the docs it just wrote.
   *
   * ⛔ AND THE RE-SCAN IS INCREMENTAL, WHICH IS HOW A5 "DROPS THE POST-WRITE RE-SCAN" HONESTLY. The
   * compiler's scan (`removalsScan`) is handed back as the prior, so the re-scan re-parses only the files
   * whose digest moved since it ran — which is exactly the three documents the render just wrote — and
   * carries every other file's findings by digest. The second full walk the review measured is gone; what
   * remains costs the rendered docs, and the BUG-3 fixture still FAILs because CONTINUITY.md is one of the
   * files the digest proves changed and therefore re-parses. Dropping the re-scan outright would reopen
   * the forged green this block exists to close.
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
  let removalsFreshness = null;
  // G4: the post-render scan's verdict (manifest + per-file findings), reused to re-persist STATE.json's
  // corpus block against the FINAL tree below — never a second runRemovalScan (the scan-count fence).
  let postRenderScan = null;
  if (runs('removals')) {
    if (wroteDocs) {
      // A `--write` savepoint is the enforcement moment the contract is built around (it regenerated the
      // derived docs and re-scans the tree it just wrote), so a refusal here is recorded with `record: true`
      // (D6 review MEDIUM 1). A `--verify` run reuses the compiler's read-only scan below and records nothing.
      try {
        // The compiler's own scan is the prior (B3: its corpus record, not the slimmed verdict), so the
        // re-scan re-parses only the files the render just wrote and carries the rest by digest.
        const rescanPrior = { ...(removalsScan.corpusRecord || {}), lastFullScanAt: removalsScan.lastFullScanAt || null };
        const rescan = removalsLib.runRemovalScan(DIR, rescanPrior, { full: removalsFull, record: true });
        removalRows = rescan.checks;
        removalsFreshness = { carried: rescan.carriedFiles, of: rescan.corpus.files.length, lastFullScanAt: rescan.lastFullScanAt };
        postRenderScan = rescan;
      } catch (e) { removalRows = [result(OUTCOME.CANNOT_DETERMINE, 'removals', `the removal scan could not run: ${e.message}`, { checked: 0 })]; }
    } else {
      removalRows = removalsScan.checks;
      removalsFreshness = { carried: removalsScan.carriedFiles, of: removalsScan.scannedFiles, lastFullScanAt: removalsScan.lastFullScanAt };
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
  const captured = memoryRan ? runCandidateCapture(state, checks, { write }) : { available: false, all: [], operatorErrors: [], findings: { byCheck: new Map(), byFile: new Map() } };
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
  if (memoryRan && renderRan && lessonsPre && captured.storeChanged) {
    const t = targets.find((x) => x.fullyGenerated);
    const row = t && refreshLessonsRegister(t, lessonsPre, state, wroteDocs, revisions);
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
   * ⛔ G4 · CONVERGE THE CORPUS RECORD WITH THE DOCUMENTS THIS RUN WROTE (see persistConvergedState). Runs
   * LAST, after every document write above (render, the register refresh, the ledger fold), on a writing
   * run whose post-render scan succeeded. Re-digests the render targets from their final bytes, re-parses
   * the findings of any that moved, writes the refreshed record to docs/derived/state/corpus.json through
   * B3's writer and records its digest in STATE.json, and re-persists STATE.json — only when a document
   * actually moved, so a single `--write` converges and the next bare `--verify` PASSes `state-writeback`
   * even after a content change. No-op when `docs/derived/` is not scanned (none of these files are in the
   * corpus) and when nothing moved (a clean re-render reproduces the same corpus bytes).
   */
  if (wroteDocs && postRenderScan && postRenderScan.manifest && postRenderScan.manifest.inputs) {
    // B2 · the decision index joins the stamp-blind converge list. It normally sits in historyPaths (not
    // scanned, so never in manifest.inputs and filtered out here), but a project that scans it converges
    // it the same way, or the G4 loop reopens for its `_Generated` stamp. D3's HANDOFF.md joins for the
    // same reason (its own `_Generated` stamp).
    const genRels = ['docs/derived/CONTINUITY.md', 'docs/derived/GAPS.md', 'docs/derived/LESSONS.md', 'docs/DECISIONS.md', 'docs/derived/HANDOFF.md']
      .filter((r) => r in postRenderScan.manifest.inputs);
    if (genRels.length) {
      const freshGen = removalsLib.corpusManifest(DIR, genRels); // stamp-blind, via hooks/_manifest.js; not a scan
      const convergedManifest = { algorithm: 'sha256', inputs: { ...postRenderScan.manifest.inputs, ...(freshGen ? freshGen.inputs : {}) } };
      const convergedFindings = { ...(postRenderScan.corpusFindings || {}) };
      // ⛔ A GENERATED DOC WHOSE BYTES MOVED AFTER THE SCAN (the wave-ledger fold writes CONTINUITY; the
      // register refresh rewrites LESSONS) must have its FINDINGS re-parsed too, not just its manifest
      // digest refreshed. Carrying the pre-fold findings beside the post-fold digest would hand A5 a
      // byte-identical file with a stale "clear", so a killed-feature phrase the fold wrote would read
      // clean until a `--full`. Re-parse only the files that actually changed, with the scan's own active
      // phrases (removalsLib.corpusFindingsFor is a parse, not a scan), so manifest and findings agree.
      const changed = genRels.filter((r) => (postRenderScan.manifest.inputs[r] || null) !== ((freshGen && freshGen.inputs[r]) || null));
      // Occurrences the re-parse records that this run's removals verdict did NOT print, because the fold
      // wrote them AFTER the post-render scan. The verdict was true as of its scan, so these are reported
      // here as a note on the converge row (not a FAIL), and the NEXT savepoint carries them into a verdict.
      const addedByDoc = [];
      if (changed.length) {
        const reparsed = removalsLib.corpusFindingsFor(DIR, changed);
        for (const r of changed) {
          const list = reparsed[r] || [];
          if (list.length) convergedFindings[r] = list; else delete convergedFindings[r];
          const priorKeys = new Set((postRenderScan.corpusFindings[r] || []).map((h) => `${h.phrase}@${h.line}`));
          const added = list.filter((h) => !priorKeys.has(`${h.phrase}@${h.line}`));
          if (added.length) addedByDoc.push({ rel: removalsLib.posix(r), count: added.length });
        }
      }
      /*
       * ⛔ B3 · THE CONVERGED RECORD LANDS IN corpus.json, NOT STATE.json. B3 relocated the corpus manifest
       * and findings out of STATE.json into docs/derived/state/corpus.json, bound by a one-line
       * `removals.corpusDigest` over that file's bytes. So converge writes the refreshed record through B3's
       * own writer, recomputes the digest over the exact bytes it lands, records only that digest in
       * STATE.json, and re-persists STATE.json — leaving the manifest and findings OUT of the projection
       * exactly as a fresh compile does. A fresh compile then reads the converged corpus.json and
       * `state-writeback` agrees; the fold re-parse (corpusFindingsFor, above) rides in the same record.
       */
      if (!state.removals || typeof state.removals !== 'object') state.removals = {};
      const convergedRecord = { corpusManifest: convergedManifest, corpusFindings: convergedFindings, rowsFingerprint: postRenderScan.rowsFingerprint || null };
      const convergedDigest = stateLib.corpusDigestOfRecord(convergedRecord);
      // Only when the record actually moved since the writeback stage recorded it (a doc's body changed):
      // a no-op `--write` re-renders to a byte-identical corpus and this is skipped, no extra write or row.
      if (state.removals.corpusDigest !== convergedDigest) {
        stateLib.writeCorpus(DIR, convergedRecord);
        state.removals.corpusDigest = convergedDigest;
        /*
         * ⛔ G18 · A RENDER THAT CREATED A FILE THE PRE-RENDER COMPILE NEVER SCANNED. On the first `--write`
         * of a checkout that never carried D3's HANDOFF.md or B3's own corpus.json, the compile scanned a
         * tree WITHOUT them and froze `removals.scannedFiles`/`why` from that smaller corpus; the render then
         * CREATED both inside the scanned directory, so a bare `--verify` straight after re-compiles a larger
         * corpus and FAILed `state-writeback` until a second write. The post-render scan already walked the
         * FINAL tree, so the file-set fields are re-derived from it here (never a third scan, so the fence
         * stays at two) exactly as `compileRemovals` derives them, so the converged STATE.json matches the tree a
         * following verify sees. A content change to an existing doc already converges through the digest above.
         */
        state.removals.why = postRenderScan.checks.map((c) => c.detail).slice(0, 6);
        state.removals.scannedFiles = postRenderScan.corpus.files.length;
        state.removals.notScanned = postRenderScan.corpus.skipped;
        state.removals.unreadable = postRenderScan.corpus.unreadable;
        const total = addedByDoc.reduce((n, x) => n + x.count, 0);
        const note = total
          ? ` The record now carries ${total} live occurrence(s) of a retired feature written AFTER this run's scan (${addedByDoc.map((x) => `${x.count} in ${x.rel}`).join(', ')}); this run's removals verdict predates them, so the next \`savepoint\` reports them.`
          : '';
        checks.push(persistConvergedState(state, note));
      }
    }
  }

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

  /*
   * ⛔ G17 · THE SAVEPOINT'S OWN OPS-LOG ROW SEALS THE LOG AT EVERY WRITE, AND NEVER DECIDES THE VERDICT.
   * Once per `savepoint --write` run that reached its rollup and rendered, after the outcome is taken so
   * the row records the exact rollup the run exits with. The append's own result rides BESIDE the verdict
   * as `ops-log:append`, NOT in `checks` - a machine-local record never decides the project's verdict, the
   * same rule the host handoff-memory line follows. A bare --verify never writes; a --write that skipped
   * render says so with a skip row. This is also the seal that closes the disclosed chain limit: a rewrite
   * of the previous last row (with its own digest recomputed) is caught the moment this row seals it.
   */
  let opsLogAppend = null;
  if (write && renderRan && core) {
    const r = appendOpsRow({
      by: 'savepoint', action: 'savepoint --write', result: outcome,
      refs: (state.handoff && state.handoff.writeCycle) ? [state.handoff.writeCycle] : [],
      cycleId: String(state.sourceRevision || 'no-revision'),
    });
    opsLogAppend = r.ok
      ? result(OUTCOME.PASS, 'ops-log:append', `recorded this run as one ops-log row (digest ${String(r.row.digest).slice(0, 12)}); the log now seals ${r.log.rows.length + 1} row(s)${r.reclaimedFrom ? ` (reclaimed ${r.reclaimedFrom})` : ''}`, { checked: 1, subject: '.respawnpack/ops-log.jsonl', domain: 'integrity' })
      : result(OUTCOME.NOT_APPLICABLE, 'ops-log:append', `the savepoint's ops-log row was NOT written (${r.blocked === 'torn' ? 'a torn tail blocks the append - repair with `log --repair-tail --by "<who>"`' : r.detail}). This is machine-local and does not change the project's verdict.`, { subject: '.respawnpack/ops-log.jsonl', domain: 'integrity' });
  } else if (write && !renderRan) {
    opsLogAppend = result(OUTCOME.NOT_APPLICABLE, 'ops-log:append', 'the `render` stage was SKIPPED, so no ops-log row was written for this partial run.', { subject: '.respawnpack/ops-log.jsonl', domain: 'integrity' });
  }

  recordSavepointAttempt(outcome, checks, revisions, stages);
  return {
    outcome, verdicts, checks, opsLogAppend, applicability: coverage ? coverage.survey.rows : [],
    stages: { requested: stages.requested, ran: stages.ran, skipped: stages.skipped },
    revisions: revisions ? { head: revisions.head, sourceRevision: state.sourceRevision, savepointOnlyCommits: revisions.savepointOnly.length, detail: revisions.detail } : null,
    onboardingComplete: coverage ? coverage.survey.onboardingComplete : null, unresolved: coverage ? coverage.survey.unresolved : [],
    memoryProposals: proposals, migrations, wrote: wroteDocs ? targets.map((t) => t.file) : [],
    capturedCandidates: captured.available ? captured.all : [],
    // D4: the three "already recorded" outcomes, so the receipt shows the lead was seen, not dropped.
    autoRejectedDuplicates: captured.available ? (captured.rejectedDuplicates || []) : [],
    observationUpdates: captured.available ? (captured.observationUpdates || []) : [],
    // A verify defers the entity fold to the next --write rather than authoring the graph on a read-only run.
    pendingObservationFolds: captured.available ? (captured.pendingFolds || []) : [],
    removalsFreshness,
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
  /*
   * Incremental against the recorded verdict, exactly as the savepoint stage is: a prior STATE.json lets
   * the scan re-parse only the documents whose bytes moved since it was written and carry the rest. An
   * absent or unusable STATE.json is a full scan. The verdict is identical either way, which is the whole
   * point — boot, savepoint and this verb cannot disagree about the same tree.
   */
  // `--full` carries nothing and re-derives every finding from the tree: the attestation that the
  // recorded verdict is honest, since an incremental run trusts the prior STATE.json's findings.
  //
  // The `removals` verb is an ENFORCEMENT run (a human or CI asking "is anything reintroduced", and it
  // exits nonzero when it is, and `hooks/pre-push` reaches it through `removals --full`), so a refusal
  // here is a real catch and is recorded (`record: true`, D6 review MEDIUM 1). The read-only callers
  // (boot, `state`, `doctor`) pass no `record`, so they never write.
  const full = flag('--full');
  let prior = null;
  try { const st = stateLib.read(DIR); prior = (st && st.removals) || null; } catch { prior = null; }
  const scan = removalsLib.runRemovalScan(DIR, prior, { full, record: true });
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
      // How much of this verdict was carried from the prior vs re-derived now, and when it was last
      // fully re-derived. `--full` makes `carried` 0 and stamps `lastFullScanAt`.
      carried: scan.carriedFiles,
      lastFullScanAt: scan.lastFullScanAt,
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
  // Decision 34: an installer-seeded posture is DECLARED but unchosen — a distinct, visible green word so
  // "the installer declared standard" never reads as "a founder chose standard". Same exit as CONFIGURED.
  'DECLARED-BY-INSTALLER': OUTCOME.PASS,
  CURRENT: OUTCOME.PASS,
  COMPLETE: OUTCOME.PASS,
  INSTALLED: OUTCOME.PASS,
  NOT_CONFIGURED: OUTCOME.NOT_APPLICABLE,
  NOT_APPLICABLE: OUTCOME.NOT_APPLICABLE,
  UNSUPPORTED: OUTCOME.NOT_APPLICABLE,
  BROKEN: OUTCOME.FAIL,
  // G6 · the candidate ledger's integrity rows speak two words of their own: an ANOMALY is a broken
  // promise (a verification that points at no entity, a backlog over the configured threshold) and FAILs;
  // WITHIN_LIMITS is an allowed state reported WITH its count (unvouched entities, legacy authorless
  // verdicts, a stale-open backlog under the threshold), green like CONFIGURED. Both map to an outcome
  // already in the exit table, so no second exit map appears.
  ANOMALY: OUTCOME.FAIL,
  WITHIN_LIMITS: OUTCOME.PASS,
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
  // G6 · the candidate-ledger anomalies are integrity rows (the projection against the store it is
  // compiled from), the same domain as state:STATE.json — a whole-id match, so the `memory:` family's
  // install rows (skill, distribution, legacy-index, ledger) are untouched and stay `install`.
  'memory:verified-without-entity': 'integrity',
  'memory:entity-without-lineage': 'integrity',
  'memory:verdicts-without-author': 'integrity',
  'memory:open-older-than-sessions': 'integrity',
  // G15 · the versioned rules file against the store that confirms it — the same integrity domain as the
  // ledger rows above: a forged confirmation line, a version bumped ahead of its newest confirmed rule, or
  // an unversioned rules file is the projection disagreeing with the source that should back it.
  'rules:unconfirmed-line': 'integrity',
  'rules:version-ahead': 'integrity',
  'rules:unversioned': 'integrity',
  // G17 · the operational records' rows are integrity rows (a record against the chain or the library it
  // is read from), whole-id matches so the `ops-log:`/`incidents:` families carry no install siblings.
  'ops-log:chain': 'integrity',
  'ops-log:silent': 'integrity',
  'incidents:incomplete': 'integrity',
  'incidents:inlined-fix': 'integrity',
  // G8 · the world-revision binding rows are integrity rows too — the graph against the revisions it claims
  // to have been true in — the same domain as state:STATE.json and the G6 ledger anomalies above.
  'memory:behind-revision': 'integrity',
  'memory:revision-undeterminable': 'integrity',
  'memory:binding-malformed': 'integrity',
  'memory:infra-reverify': 'integrity',
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
  // G6 · the ledger rows look at the candidate store and the graph, named by path rather than restated.
  'memory:ledger': 'memory/candidates/',
  'memory:verified-without-entity': 'memory/candidates/',
  'memory:entity-without-lineage': 'memory/graph/',
  'memory:verdicts-without-author': 'memory/candidates/',
  'memory:open-older-than-sessions': 'memory/candidates/',
  // G15 · the rules-file integrity rows look at the versioned rules file; the emitted row carries the exact
  // file it found, this default names the primary of the two loaded locations for a reader scanning the map.
  'rules:unconfirmed-line': 'docs/reference/wordsmith-rules.md',
  'rules:version-ahead': 'docs/reference/wordsmith-rules.md',
  'rules:unversioned': 'docs/reference/wordsmith-rules.md',
  // G17 · the ops log is machine-local under .respawnpack/; the incident library is tracked under memory/.
  // The bare family keys are the subjects a section-throw BROKEN row inherits.
  'ops-log': '.respawnpack/ops-log.jsonl',
  'ops-log:chain': '.respawnpack/ops-log.jsonl',
  'ops-log:silent': '.respawnpack/ops-log.jsonl',
  'incidents': 'memory/incidents/',
  'incidents:incomplete': 'memory/incidents/',
  'incidents:inlined-fix': 'memory/incidents/',
  // G8 · the world-revision binding rows look at the promoted entities under memory/graph/.
  'memory:behind-revision': 'memory/graph/',
  'memory:revision-undeterminable': 'memory/graph/',
  'memory:binding-malformed': 'memory/graph/',
  'memory:infra-reverify': 'memory/graph/',
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
  // G16 · the pack-version row reads the version the installer recorded in the receipt and cross-checks it
  // against the CLAUDE.md managed-block opener — both named here by their own file.
  'install:pack-version': '.respawnpack/install-receipt.json',
  // D1 · the large-tree scoping rows: the written families live in settings.json; the preview, the LSP
  // recommendation and the "nothing detected" verdict are read from the install receipt.
  scoping: '.respawnpack/install-receipt.json',
  'scoping:deny': '.claude/settings.json',
  'scoping:excludes': '.claude/settings.json',
  'scoping:worktree': '.claude/settings.json',
  'scoping:lsp': '.respawnpack/install-receipt.json',
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
  'knowledge': ['performance'],
  'docs-only': ['performance'],
  'ops-infra': ['performance'],
  'greenfield-app': [],
  'mature-product': [],
};

/*
 * ⛔ G16 · THE CLAUDE.md MANAGED-BLOCK OPENER VERSION, READ WITH THE KERNEL'S OWN REGEX. install.js stamps
 * the pack version into the opener (`<!-- RESPAWNPACK:BEHAVIOR v<version>`, its own `BLOCK_VERSION_RE`) and
 * does not travel into an installed target, so the kernel cannot borrow that regex; it keeps a byte-identical
 * copy here. A fence in kernel/kernel.test.mjs reads BOTH files as TEXT and proves the two sources are equal,
 * the same cross-tree technique the hook-path constants use, so a change to one that is not mirrored fails
 * loudly rather than letting `doctor` read a block the installer never wrote.
 */
const CLAUDE_BLOCK_VERSION_RE = /^<!-- RESPAWNPACK:BEHAVIOR v(\S+)/m;

function cmdDoctor() {
  /*
   * ⛔ `doctor --onboarding`: THE BOOT-SET PROJECTION /respawn STEP 2 READS, AND ONLY THAT (B1).
   *
   * Step 2 used to run `doctor --json` WHOLE — the full install inventory, every hook, lib, skill and
   * adapter row — and read exactly two things out of it: the onboarding verdict and the applicability
   * survey. On the worked example that payload is ~25 KB per boot, almost all of it rows Step 2 never
   * looks at. This verb computes the survey ALONE, through the SAME `coverageChecks` the savepoint
   * coverage stage runs (config and filesystem only — no scan, no subprocess, no install inventory), so
   * its rows are byte-identical to the `applicability` the full `doctor --json` reports and can never
   * quietly disagree with it. The outcome mirrors doctor's own onboarding row (COMPLETE → PASS, else
   * CANNOT_DETERMINE), so the projection and the full verb agree on the exit code as well as the rows.
   */
  if (flag('--onboarding')) {
    const survey = applicabilityLib.coverageChecks(DIR, posturePolicy()).survey;
    return {
      onboarding: true,
      outcome: survey.onboardingComplete ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE,
      onboardingComplete: survey.onboardingComplete,
      unresolved: survey.unresolved,
      applicability: survey.rows,
    };
  }
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
  const hookPolicy = posturePolicy();
  /*
   * ⛔ A HOOK THE PROFILE LEFT INERT IS NOT SILENTLY INACTIVE EITHER (C2, decision 32). `websearch-freshness`
   * and `mcp-reaper` carry one switchable rule each; under a DECLARED `standard` or `light` that rule is
   * `off`, so `install/_settings-manifest.js`'s `isInert` drops the whole hook from `settings.json`. Unlike
   * `lockdown`/`worktree-guard` (RETIRED_HOOKS, a PLACEMENT table the resolver cannot express) this leaves
   * through the resolver's own `off`, and it is POSTURE-DERIVED here for the same reason `retiresHook` is:
   * the receipt's `settingsRetired` records only a profile-FLIP removal, so a FRESH relaxed install (which
   * never placed the hook to begin with) leaves it empty and could not answer. The rule ids a hook consults
   * are read from its own source the same way `postureOf` reads `boot.arm` below — a literal
   * `verdict(<resolution>, '<id>')` — and the hook is inert when it consults at least one and every one
   * resolves `off`. A hook that consults a FIXED id gets `deny` back (never `off`), so a fixed-rule hook is
   * never classed inert, and a hook that consults none falls through to the ordinary wired/unwired answer.
   */
  const consultedRules = (h) => {
    let src = '';
    try { src = fs.readFileSync(path.join(hookDir, h), 'utf8'); } catch { return []; }
    const ids = []; const re = /\bverdict\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*'([^']+)'/g; let m;
    while ((m = re.exec(src))) ids.push(m[1]);
    return [...new Set(ids)];
  };
  const inertUnderPosture = (h) => {
    // DECLARED only (like `retiresHook`): a DEFAULTED/UNREADABLE/INVALID posture resolves to `strict`,
    // whose column has no `off` cell for any shipped hook, so the verdict test below already excludes it —
    // and strict composes every hook, so an inert-and-unwired hook under strict cannot arise.
    if (isWired(h) || !hookPolicy || hookPolicy.source !== 'DECLARED') return null;
    const ids = consultedRules(h);
    return ids.length && ids.every((id) => hookPolicy.verdict(id) === 'off') ? hookPolicy.profile : null;
  };
  for (const h of expectedHooks) {
    const v = hookVerdict(h);
    if (!v.ok) {
      add(`hook:${h}`, 'BROKEN', `${isWired(h) ? 'wired in .claude/settings.json, but ' : 'on disk, but '}${v.detail}`);
      continue;
    }
    /*
     * ⛔ RETIRED BY PROFILE IS NOT SILENTLY INACTIVE (C1, decision 32). `lockdown` and `worktree-guard`
     * are placed on disk under every profile but WIRED only under `strict`; under a DECLARED `standard`
     * or `light` the host covers the editor boundary (isolation worktree + the deny rules), so the hook
     * being unwired is the declaration working, not an install to repair. Asked before SILENTLY INACTIVE
     * for the same reason the kernel-lib NOT_APPLICABLE branch is: it is the narrower case of "unwired".
     */
    const retiredFor = !isWired(h) && hookPolicy ? hookPolicy.retiresHook(h) : null;
    if (retiredFor) {
      add(`hook:${h}`, 'NOT_APPLICABLE',
        `on disk and valid but NOT wired under the declared \`${retiredFor}\` posture (decision 32) — this profile `
        + 'hands the editor boundary to the host (isolation worktree and the permissions.deny rules), so its absence '
        + 'from settings.json is the posture working rather than a guard that will never run. It wires and denies under `strict`.');
      continue;
    }
    const inertFor = inertUnderPosture(h);
    if (inertFor) {
      add(`hook:${h}`, 'NOT_APPLICABLE',
        `on disk and valid but NOT wired under the declared \`${inertFor}\` posture (decision 32) — every rule this `
        + 'hook carries resolves `off` under this profile, so the installer composed settings.json without it. Its '
        + 'absence is the posture working rather than a guard that will never run; it composes and runs under `strict`.');
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
    // DECLARED splits in two: a founder's own choice is CONFIGURED; one the installer seeded (decision 34,
    // `seededBy: installer`) is DECLARED-BY-INSTALLER — both green, kept apart because "nobody chose" and
    // "chose it" are different facts and the installer's seed is the first, not the second.
    const status = p.source === 'DECLARED'
      ? (p.seededBy === 'installer' ? 'DECLARED-BY-INSTALLER' : 'CONFIGURED')
      : p.source === 'DEFAULTED' ? 'NOT_CONFIGURED' : 'BROKEN';
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
        'no projectType declared, the managed block composes in full; declare one of knowledge, docs-only, ops-infra, greenfield-app, '
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
   * ⛔ D1 · LARGE-TREE SCOPING. One row per emitted family, read from the install receipt (what the pack
   * OWNS) checked against settings.json (what is actually there). PASS when a written family's rules are
   * present; a `scoping:preview` NOT_APPLICABLE line when a preview exists and nothing was written, so a
   * reader knows the preview is there to apply; and a single `scoping` NOT_APPLICABLE row naming the
   * two-signal rule when no directory was ever named. The receipt is read through the same classified
   * `readJSON` the settings files use. doctor restates the two-signal rule rather than requiring
   * install/_scoping.js, which does not travel into an installed target.
   */
  section('scoping', () => {
    const receipt = readJSON(path.join(DIR, '.respawnpack', 'install-receipt.json')) || {};
    const denyRules = (settings && settings.permissions && Array.isArray(settings.permissions.deny)) ? settings.permissions.deny : [];
    const wt = (settings && settings.worktree && typeof settings.worktree === 'object') ? settings.worktree : {};
    const excl = Array.isArray(settings && settings.claudeMdExcludes) ? settings.claudeMdExcludes : [];
    const wtSym = Array.isArray(wt.symlinkDirectories) ? wt.symlinkDirectories : [];
    const wtSparse = Array.isArray(wt.sparsePaths) ? wt.sparsePaths : [];
    const ownedDeny = Array.isArray(receipt.permissionsDeny) ? receipt.permissionsDeny.filter((r) => typeof r === 'string' && /^Read\(/.test(r)) : [];
    const ownedExcl = Array.isArray(receipt.claudeMdExcludes) ? receipt.claudeMdExcludes.filter((r) => typeof r === 'string') : [];
    const ownedSym = Array.isArray(receipt.worktreeSymlinkDirectories) ? receipt.worktreeSymlinkDirectories.filter((r) => typeof r === 'string') : [];
    const ownedSparse = Array.isArray(receipt.worktreeSparsePaths) ? receipt.worktreeSparsePaths.filter((r) => typeof r === 'string') : [];
    const lsp = Array.isArray(receipt.lspRecommended) ? receipt.lspRecommended.filter((l) => l && typeof l === 'object') : [];
    const lspText = lsp.map((l) => `${l.language} → ${l.plugin || 'no official plugin'}`).join(', ');
    const TWO_SIGNAL = 'the two-signal rule (a conventional or gitignored directory name AND large-or-binary by a cheap measure)';
    const wrote = ownedDeny.length || ownedExcl.length || ownedSym.length || ownedSparse.length;
    if (!wrote) {
      if (receipt.scopingPreview) {
        add('scoping', 'NOT_APPLICABLE',
          `large-tree scoping is a PREVIEW only — the installer named directories by ${TWO_SIGNAL} and wrote nothing; re-run the install with --write-settings to apply it`
          + `${lspText ? `. LSP recommendation: ${lspText}` : ''}`);
      } else {
        add('scoping', 'NOT_APPLICABLE',
          `no asset or generated directory was named by ${TWO_SIGNAL}, so no Read deny, claudeMdExcludes or worktree key was emitted`);
      }
      return;
    }
    const familyRow = (id, owned, present, label) => {
      if (!owned.length) return;
      const missing = owned.filter((r) => !present.includes(r));
      if (missing.length) {
        add(id, 'BROKEN', `${label}: the install receipt owns ${owned.length} rule(s) but ${missing.length} are missing from .claude/settings.json (${missing.join(', ')}) — a hand edit or an interrupted merge`);
      } else {
        add(id, 'ACTIVE', `${label}: ${owned.length} pack rule(s), each present in .claude/settings.json; uninstall removes exactly these`);
      }
    };
    familyRow('scoping:deny', ownedDeny, denyRules, 'permissions.deny Read rules (a Read deny also blocks Edit and Write)');
    familyRow('scoping:excludes', ownedExcl, excl, 'claudeMdExcludes');
    familyRow('scoping:worktree', [...ownedSym, ...ownedSparse], [...wtSym, ...wtSparse], 'worktree.symlinkDirectories/sparsePaths');
    if (lsp.length) add('scoping:lsp', 'NOT_CONFIGURED', `LSP code-intelligence plugin is a recommendation only — the pack never writes enabledPlugins, so it is for you to install: ${lspText}`);
  });

  /*
   * ⛔ G16 · THE INSTALL RECEIPT'S PACK VERSION, CROSS-CHECKED AGAINST THE CLAUDE.md BLOCK. The installer
   * records the release that laid the files into the receipt (`packVersion`, schemaVersion 4) AND into the
   * CLAUDE.md managed-block opener; a half-applied upgrade leaves the two disagreeing. This row reads both
   * through the kernel's own readers — the receipt through `readJSON`, the block through
   * `CLAUDE_BLOCK_VERSION_RE` (install.js does not travel into a target, so the kernel keeps its own copy,
   * fenced equal to the installer's in kernel/kernel.test.mjs). No receipt at all is NOT_APPLICABLE (the
   * pre-receipt wording); a receipt without the field is NOT_CONFIGURED naming the upgrade that records it;
   * a non-string or a value disagreeing with the block is BROKEN naming both. A hand edit of the receipt's
   * version to a value the block does not carry is the bypass and reads BROKEN.
   */
  section('install:pack-version', () => {
    const receiptPath = path.join(DIR, '.respawnpack', 'install-receipt.json');
    if (!fs.existsSync(receiptPath)) {
      add('install:pack-version', 'NOT_APPLICABLE',
        'no .respawnpack/install-receipt.json — this target predates the receipt, so there is no recorded pack version to check');
      return;
    }
    const receipt = readJSON(receiptPath) || {};
    const blockText = readText(path.join(DIR, 'CLAUDE.md')) || '';
    const blockVersion = (blockText.match(CLAUDE_BLOCK_VERSION_RE) || [])[1] || null;
    if (!('packVersion' in receipt)) {
      add('install:pack-version', 'NOT_CONFIGURED',
        'the install receipt carries no `packVersion` — an install older than the pack-version field (before schemaVersion 4). `upgrade.js` records it on the next upgrade; nothing is wrong here');
      return;
    }
    const pv = receipt.packVersion;
    if (typeof pv !== 'string' || !pv.trim()) {
      add('install:pack-version', 'BROKEN',
        `the install receipt's \`packVersion\` is ${JSON.stringify(pv)}, not a non-empty string — the receipt was hand-edited or written by a broken installer`);
      return;
    }
    if (!blockVersion) {
      add('install:pack-version', 'BROKEN',
        `the install receipt records pack version ${pv} but no CLAUDE.md managed-block opener (\`<!-- RESPAWNPACK:BEHAVIOR v… -->\`) was found to cross-check it against — the block was stripped, or the install never wrote one. Re-run the installer`);
      return;
    }
    if (pv !== blockVersion) {
      add('install:pack-version', 'BROKEN',
        `the install receipt records pack version ${pv} but the CLAUDE.md managed block's opener records ${blockVersion} — a half-applied upgrade (one moved, the other did not), or a hand-edited receipt. Re-run the installer to bring them into step`);
      return;
    }
    add('install:pack-version', 'INSTALLED',
      `pack version ${pv} recorded in the install receipt and matched in the CLAUDE.md managed block's opener`);
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
    // Incremental against the recorded verdict (the as-used scan), so the row can report how much of the
    // verdict was carried from the prior and when it was last fully re-derived. `removals --full` is the
    // independent re-derivation that does not trust the prior STATE.json.
    let prior = null;
    try { const st = stateLib.read(DIR); prior = (st && st.removals) || null; } catch { prior = null; }
    const scan = removalsLib.runRemovalScan(DIR, prior);
    const cfg = removalsLib.readConfig(DIR);
    add('removals:contract',
      !cfg.configured ? 'NOT_CONFIGURED'
        : scan.outcome === 'FAIL' ? 'BROKEN'
          : scan.outcome === 'CANNOT_DETERMINE' ? 'UNSUPPORTED' : 'ACTIVE',
      !cfg.configured
        ? 'no state.removals.liveContentDirs in respawnpack.config.json — nothing scans for reintroduced killed features here'
        : `${scan.rows.length} removal row(s) over ${scan.corpus.files.length} file(s) in ${cfg.liveContentDirs.join(', ')} — ${scan.outcome}. `
          + `${scan.carriedFiles} of ${scan.corpus.files.length} file(s) carried from the prior verdict; last full scan ${scan.lastFullScanAt || 'never'}; \`removals --full\` re-derives every finding from the tree`);
  });

  /*
   * ⛔ WHAT THE PACK RECORDS ABOUT ITS OWN CATCHES (review 2026-09-23 §3). `.respawnpack/runtime/catches.jsonl`
   * gains one line whenever the freshness check withholds, the removal contract refuses, or secret-scan
   * or push-guard denies — so an owner can tell a guard that earns its cost from one that only costs. It
   * is machine-local and gitignored, so its ABSENCE on another clone proves nothing (the sentence aar.js
   * uses for the savepoint receipt): absent is NOT_CONFIGURED, never a fault. A line that does not parse
   * is BROKEN naming the line, while the good lines are still counted — a malformed tail must not erase
   * the record that a guard fired.
   *
   * ⛔ READ LINE BY LINE, NOT WHOLE. This is JSONL: one `readFileSync`, then `JSON.parse` per line, the
   * two deliberately on separate statements. So this is not the single-expression raw read
   * kernel/schema.test.mjs fences, and there is no atomic-replacement window to miss either — the file is
   * only ever appended to, never replaced by rename.
   */
  section('catches', () => {
    /*
     * doctor parses catches.jsonl ITSELF rather than calling hooks/_runtime.js `readCatches`, and the
     * duplication is deliberate (D6 review LOW 4, declined with cause). Requiring `_runtime.js` here
     * would drag in `_manifest.js` and `_artifact.js`, which it loads at module scope, and COUPLE this
     * read to their health: a corrupt `_manifest.js` would turn the catches row BROKEN though reading an
     * append-only JSONL file needs neither module (the install test "a shared module PRESENT but
     * unloadable is BROKEN" reproduces exactly that false FAIL). So this is the same hook/kernel
     * tree-split duplication the pack already keeps for `recordCatch` (its kernel twin is in
     * kernel/lib/removals.js) and `writeAtomic`/`atomicWriteJSON`. It is JSONL, read line by line, so the
     * single-statement raw read kernel/schema.test.mjs fences is never formed — and the file is only ever
     * appended to, never rename-replaced, so there is no atomic-replacement window to miss. doctor only
     * READS here; it never writes the counter.
     */
    const file = path.join(DIR, '.respawnpack', 'runtime', 'catches.jsonl');
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') {
        add('catches', 'NOT_CONFIGURED', 'no catch has been recorded on this machine (machine-local; its absence on another clone proves nothing)', '.respawnpack/runtime/catches.jsonl');
        return;
      }
      add('catches', 'BROKEN', `.respawnpack/runtime/catches.jsonl could not be read: ${(e && e.code) || (e && e.message) || 'unknown error'}`, '.respawnpack/runtime/catches.jsonl');
      return;
    }
    const totals = {};
    const bad = [];
    let good = 0;
    let first = null;
    let last = null;
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { bad.push(i + 1); continue; }
      if (!rec || typeof rec !== 'object' || typeof rec.guard !== 'string' || typeof rec.event !== 'string') { bad.push(i + 1); continue; }
      good += 1;
      totals[rec.guard] = (totals[rec.guard] || 0) + 1;
      if (typeof rec.at === 'string') {
        if (!first || rec.at < first) first = rec.at;
        if (!last || rec.at > last) last = rec.at;
      }
    }
    const byGuard = Object.keys(totals).sort().map((g) => `${g}: ${totals[g]}`).join(', ') || 'none';
    const span = first ? `, first ${first}, last ${last}` : '';
    if (bad.length) {
      add('catches', 'BROKEN',
        `.respawnpack/runtime/catches.jsonl has ${bad.length} unparseable line(s) at line ${bad.join(', ')}; ${good} good line(s) counted (${byGuard})${span}. Fix or remove the named line(s).`,
        '.respawnpack/runtime/catches.jsonl');
      return;
    }
    add('catches', 'ACTIVE', `${good} catch(es) recorded on this machine (${byGuard})${span}, machine-local`, '.respawnpack/runtime/catches.jsonl');
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
   * ⛔ THE MEMORY ROW USED TO ASK `which rmem` AND THEN PROBE AN MCP ENGINE, AND NEITHER IS A QUESTION
   * ANYMORE. The memory engine was retired with `--with-memory` (decision 33), so there is one backend
   * and no server to prove reachable: this reports the file backend directly (the register, the graph
   * and the candidate store), with no probe.
   *
   * File-backed memory is not a degraded state. It is the zero-setup default, and it reports ACTIVE.
   * A `memory/.index/` left by the retired engine is the user's own database: the pack never deletes it,
   * and names it once here as a legacy artifact the owner may remove.
   */
  section('memory:distribution', () => {
    const dist = memoryLib.distribution(DIR);
    add('memory:distribution', 'ACTIVE', dist.detail);
    if (fs.existsSync(path.join(DIR, 'memory', '.index'))) {
      add('memory:legacy-index', 'NOT_APPLICABLE',
        'memory/.index/ is the retired engine\'s PGLite database — the pack never touches it. It is yours to delete if you no longer want it.');
    }
  });

  /*
   * ⛔ G6 · THE CANDIDATE LEDGER'S INTEGRITY ROWS — ONE PER NON-ZERO ANOMALY, NEVER A ROW FOR A ZERO. The
   * outcome is decided per anomaly: an orphan verification (verified, no entity) is a broken promise and
   * FAILs; lineage-less entities and authorless legacy verdicts are allowed states reported WITH their
   * count (the register lists the unvouched ones, and a verdict's author cannot be reconstructed); a
   * stale-open backlog FAILs only when it exceeds the configured `memory.staleOpenLeadFailAt`, and PASSes
   * with its count below it. An absent store is the existing NOT_APPLICABLE, copied from memory:legacy-index
   * above — not a zero nobody could count, and not a fault.
   */
  section('memory:ledger', () => {
    if (!core) { add('memory:ledger', 'NOT_APPLICABLE', 'core/ could not be loaded, so the candidate ledger could not be computed — see the kernel-lib rows above'); return; }
    const led = ledgerReport();
    if (led.store.candidates === 'ABSENT' && led.store.graph === 'ABSENT') {
      add('memory:ledger', 'NOT_APPLICABLE', 'no candidate store or graph in this project — there is no ledger to check');
      return;
    }
    if (led.store.candidates === 'UNREADABLE') {
      add('memory:ledger', 'BROKEN', `the candidate store could not be read, so the ledger is not established: ${led.store.candidatesReason || 'no reason recorded'}`);
      return;
    }
    const c = led.counts, a = led.anomalies;
    const tail = (key) => `${a[key].shown.slice(0, 8).join(', ')}${a[key].more || a[key].shown.length > 8 ? ` … (${c[key]} total)` : ''}`;
    if (c['verified-without-entity'] > 0) {
      add('memory:verified-without-entity', 'ANOMALY',
        `${c['verified-without-entity']} verified candidate(s) promoted nothing into memory/graph/ — a verification that points at no entity is a broken promise: ${tail('verified-without-entity')}`);
    }
    if (c['entity-without-lineage'] > 0) {
      add('memory:entity-without-lineage', 'WITHIN_LIMITS',
        `${c['entity-without-lineage']} entit(ies) under memory/graph/ carry no promotedFrom (hand-authored or legacy) — allowed: the register lists them as unvouched, never as verified lessons`);
    }
    if (c['verdicts-without-author'] > 0) {
      add('memory:verdicts-without-author', 'WITHIN_LIMITS',
        `${c['verdicts-without-author']} decided record(s) carry a verdict with no author (captured before the author rule) — allowed, counted not repaired: an author cannot be reconstructed after the fact`);
    }
    if (c['open-older-than-sessions'] > 0) {
      const fail = c['open-older-than-sessions'] > led.staleOpenLeadFailAt;
      add('memory:open-older-than-sessions', fail ? 'ANOMALY' : 'WITHIN_LIMITS',
        `${c['open-older-than-sessions']} open lead(s) have sat unreviewed past ${led.staleOpenLeadSessions} savepoint cycle(s)`
          + `${fail ? ` — over the configured failAt of ${led.staleOpenLeadFailAt}; review them` : ` (within the configured failAt of ${led.staleOpenLeadFailAt})`}`
          + `. Review with \`memory candidates --ledger\`.`);
    }
  });

  /*
   * ⛔ G15 · THE VERSIONED RULES FILE, CHECKED AGAINST THE STORE THAT CONFIRMS IT. One row per non-zero
   * finding, each naming its files and slugs, never a bare count; no row for a clean file and none for a
   * project with no rules file (the same shape as the ledger section above). A forged confirmation and a
   * version run ahead of the ledger FAIL (ANOMALY); an unversioned rules file is reported WITHIN_LIMITS.
   */
  section('rules', () => {
    const rep = rulesIntegrityReport();
    if (!rep.anyFile) return;
    const bounded = (arr, fmt) => `${arr.slice(0, 8).map(fmt).join('; ')}${arr.length > 8 ? ` … (${arr.length} total)` : ''}`;
    if (rep.unconfirmed.length) {
      add('rules:unconfirmed-line', 'ANOMALY',
        `${rep.unconfirmed.length} rule line(s) claim a confirmation the store does not back — a forged confirmation: `
          + bounded(rep.unconfirmed, (u) => `${u.rel} rule:${u.slug} (${u.candidateId}) — ${u.reason}`),
        rep.unconfirmed[0].rel);
    }
    if (rep.versionAhead.length) {
      add('rules:version-ahead', 'ANOMALY',
        `${rep.versionAhead.length} rules file(s) carry a version bumped with no confirmed candidate behind it; promote the correction, or set the version back: `
          + bounded(rep.versionAhead, (v) => `${v.rel} version ${v.version} is ahead of its newest confirmed rule (v${v.highest})`),
        rep.versionAhead[0].rel);
    }
    if (rep.unversioned.length) {
      add('rules:unversioned', 'WITHIN_LIMITS',
        `${rep.unversioned.length} rules file(s) in the two loaded locations carry no parseable version — the skills apply them but report them unversioned, and they lose to any versioned file: `
          + bounded(rep.unversioned, (r) => r),
        rep.unversioned[0]);
    }
  });

  /*
   * ⛔ G17 · THE OPS LOG'S CHAIN, AND WHETHER IT HAS GONE SILENT. `ops-log:chain` verifies the append-only
   * seal every `log --verify` does: ACTIVE with the count and head when it holds, BROKEN naming the FIRST
   * bad row (a rewrite or a splice is not append-only), WITHIN_LIMITS naming a torn tail with its remedy
   * when that is the only fault, NOT_APPLICABLE when there is no log on this machine. `ops-log:silent` is
   * advisory: it reports (never FAILs) when the newest `memory.staleOpenLeadSessions` savepoint rows at the
   * tail carry no operator row between them. Each names its entities; neither is a bare count.
   */
  section('ops-log', () => {
    if (!core) return; // the kernel-lib rows already report a core/ that will not load
    const log = readOpsLog();
    if (log.status === 'ABSENT') { add('ops-log:chain', 'NOT_APPLICABLE', 'no ops log on this machine - there is no chain to check (machine-local, gitignored)'); return; }
    if (log.status === 'UNREADABLE') { add('ops-log:chain', 'BROKEN', `the ops log could not be read: ${log.detail}`); return; }
    if (log.status === 'BROKEN') { add('ops-log:chain', 'BROKEN', `the ops log is not append-only at ${log.firstBreak.reason} - refused, never skipped`); return; }
    if (log.status === 'TORN') {
      add('ops-log:chain', 'WITHIN_LIMITS', `${log.rows.length} row(s) sealed (head ${String(log.head).slice(0, 12)}); a torn tail of ${Buffer.byteLength(log.tornTail, 'utf8')} byte(s) is present - \`log --repair-tail --by "<who>"\` records its discard`);
    } else if (!log.rows.length) {
      add('ops-log:chain', 'NOT_APPLICABLE', 'the ops log is empty - no rows to verify');
    } else {
      add('ops-log:chain', 'ACTIVE', `${log.rows.length} row(s) sealed and verified, head ${String(log.head).slice(0, 12)}`);
    }
    if (log.status === 'OK' || log.status === 'TORN') {
      const N = ledgerConfig().staleOpenLeadSessions;
      const spIdx = log.rows.map((r, i) => (r.by === 'savepoint' ? i : -1)).filter((i) => i >= 0);
      if (spIdx.length >= N) {
        const window = log.rows.slice(spIdx[spIdx.length - N]);
        if (!window.some((r) => r.by !== 'savepoint')) {
          add('ops-log:silent', 'WITHIN_LIMITS', `the log has recorded no operator action across ${N} savepoint cycle(s) - the newest ${N} savepoint rows at the tail carry no operator row between them (advisory, never a FAIL)`);
        }
      }
    }
  });

  /*
   * ⛔ G17 · THE INCIDENT LIBRARY'S TWO INTEGRITY ROWS. `incidents:incomplete` names every incident file
   * that lacks a signature, cause or fix, or fails its shape (an unreadable/malformed file included) -
   * WITHIN_LIMITS, bounded like the ledger rows. `incidents:inlined-fix` names an incident whose FIX BODY
   * has been copied into a candidate claim (any state), CONTINUITY's NOTE block, or a graph entity's
   * observations under memory/graph/** (the memo's third single-sourcing leg: a lesson promoted from an
   * incident cites its id and never copies the fix, so a promoted or hand-authored entity carrying the fix
   * body is the duplicate), by the literal containment rule qualifyClaim uses (40 characters or more)
   * instead of pointing at the incident id - ANOMALY, because the fix must live once. The incident's own
   * minted candidate never matches: its claim carries the id, not the body; a RETRACTED entity is skipped,
   * because a retracted lesson is exactly the thing a fresh lead may legitimately raise again. Both rows
   * are absent when there is nothing to report.
   */
  section('incidents', () => {
    if (!core) return;
    const listed = listIncidents();
    if (listed.outcome === OUTCOME.NOT_APPLICABLE && !listed.unreadable.length) return; // no incident library here
    const incomplete = listed.unreadable.map((u) => `${u.file} (${u.status})`);
    for (const inc of listed.incidents) {
      const reasons = ['signature', 'cause', 'fix'].filter((k) => !(typeof inc[k] === 'string' && inc[k].trim())).map((m) => `no ${m}`);
      if (!(typeof inc.id === 'string' && INCIDENT_ID_RE.test(inc.id))) reasons.push('malformed id');
      if (inc.status !== 'open' && inc.status !== 'fixed') reasons.push('invalid status');
      if (reasons.length) incomplete.push(`${inc.id || '(no id)'}: ${reasons.join(', ')}`);
    }
    if (incomplete.length) {
      add('incidents:incomplete', 'WITHIN_LIMITS', `${incomplete.length} incident file(s) lack a signature, cause or fix, or fail their shape: ${incomplete.slice(0, 8).join('; ')}${incomplete.length > 8 ? ` … (${incomplete.length} total)` : ''}`);
    }
    const sources = [];
    const cl = core.candidates.list(memoryStoreDir());
    if (cl.status === 'OK') for (const rec of cl.records) sources.push({ id: rec.id, label: `candidate ${rec.id}`, text: rec.claim });
    const cont = readText(path.join(DIR, 'docs', 'derived', 'CONTINUITY.md'));
    const note = cont ? render.rawNote(cont) : '';
    if (note) sources.push({ id: 'CONTINUITY.md', label: "CONTINUITY.md's NOTE block", text: note });
    // The graph entities' observations: a promoted lesson cites the incident id, never copies the fix. A
    // retracted entity is excluded on the same rule D4 and the register already apply to _retracted/.
    const graph = readGraphEntities();
    if (graph.status === 'OK') {
      for (const e of graph.entities) {
        if (/(^|\/)_retracted\//.test(e.file)) continue;
        const text = readText(path.join(DIR, e.file));
        if (!text) continue;
        const fm = GRAPH_FRONTMATTER.exec(text);
        const body = fm ? text.slice(fm[0].length) : text; // the observations, not the frontmatter
        sources.push({ id: e.file, label: `graph entity ${e.id} (${e.file})`, text: body });
      }
    }
    const dups = [];
    for (const inc of listed.incidents) {
      if (!(typeof inc.fix === 'string' && inc.fix.trim())) continue;
      for (const s of sources) {
        if (s.id === inc.candidateId) continue; // the incident's own candidate names the id, not the body
        if (core.candidates.qualifyClaim(s.text, [{ ref: inc.id, kind: 'incident', strings: [inc.fix] }])) dups.push(`${inc.id} in ${s.label}`);
      }
    }
    if (dups.length) {
      add('incidents:inlined-fix', 'ANOMALY', `${dups.length} place(s) carry an incident's fix body instead of pointing at its id - the fix lives once, in the incident file: ${dups.slice(0, 8).join('; ')}${dups.length > 8 ? ` … (${dups.length} total)` : ''}`);
    }
  });

  /*
   * ⛔ G8 · THE WORLD-REVISION BINDING ROWS — IS EACH VOUCHED LESSON STILL TRUE OF A WORLD THAT HAS MOVED?
   * "Behind" is advisory (WITHIN_LIMITS, never a FAIL): a behind lesson is a re-verify trigger, not a
   * verdict. A bound lesson whose current revision could NOT be read is CANNOT_DETERMINE (exit 2, never a
   * silent PASS — the honest infra degrade). A present-but-malformed binding is named. An estate binding
   * whose promotion cycle is more than the stale-open threshold old is flagged for re-verification, because
   * the pack cannot see the live estate. An unbound or retracted entity is in none of these rows.
   */
  section('memory:revision', () => {
    if (!core) return; // the ledger section above already reported core/ unavailable
    const store = lessonsStore(null);
    if (!(store.graph && store.graph.status === 'OK')) return; // the ledger/distribution rows cover an absent/unreadable graph
    const b = render.analyzeBindings(store);
    const bounded = (items) => `${items.slice(0, 8).join(', ')}${items.length > 8 ? ` … (${items.length} total)` : ''}`;
    if (b.behind.length) {
      add('memory:behind-revision', 'WITHIN_LIMITS',
        `${b.behind.length} vouched lesson(s) are bound to a revision the current tree has moved past — advisory, re-verify before acting (behind is a trigger, not a verdict): `
          + bounded(b.behind.map((x) => `${x.entity.id} (${x.kind}: bound ${String(x.value).slice(0, 7)}, now ${x.current === null ? '?' : String(x.current).slice(0, 7)})`)));
    }
    if (b.undeterminable.length) {
      // A label absent from DOCTOR_OUTCOME falls through to CANNOT_DETERMINE (exit 2) — the owner's "never a
      // silent PASS" for a bound lesson whose current revision could not be read.
      add('memory:revision-undeterminable', 'UNDETERMINABLE',
        `${b.undeterminable.length} bound vouched lesson(s) could not be compared against a current revision: `
          + bounded(b.undeterminable.map((x) => `${x.entity.id} (${x.reason})`)));
    }
    if (b.malformed.length) {
      add('memory:binding-malformed', 'WITHIN_LIMITS',
        `${b.malformed.length} vouched lesson(s) carry binding fields that are present but malformed — named, never counted current: `
          + bounded(b.malformed.map((x) => `${x.entity.id} (${x.reason})`)));
    }
    // Infra re-verify cadence, measured in savepoint cycles (not the clock), the way the ledger ages an
    // open lead: an estate-bound lesson whose promotion cycle is older than the stale-open threshold. An
    // estate-bound lesson whose promotion cycle is NOT on record (hand-authored, or a promotedFrom naming a
    // candidate no longer in the store) cannot be aged at all; it is named here as "not aged" rather than
    // dropped silently, so a reader learns the cadence check could not see it. The serial comparison above
    // still applies to it, so it is never falsely counted current.
    const cfg = ledgerConfig();
    const { ageOfCycle } = cycleAgeMap(Array.isArray(store.candidates.records) ? store.candidates.records : []);
    const recById = new Map((Array.isArray(store.candidates.records) ? store.candidates.records : []).map((r) => [r.id, r]));
    const estateBound = [...b.current, ...b.behind, ...b.undeterminable].filter((x) => x.kind === 'estateRevision');
    const infraStale = []; const notAged = [];
    for (const x of estateBound) {
      const rec = recById.get(x.entity.promotedFrom);
      if (!rec) { notAged.push(x.entity.id); continue; }
      const cycles = ageOfCycle(rec.provenance && rec.provenance.cycleId);
      if (cycles > cfg.staleOpenLeadSessions) infraStale.push({ id: x.entity.id, cycles });
    }
    infraStale.sort((p, q) => q.cycles - p.cycles || String(p.id).localeCompare(String(q.id)));
    notAged.sort();
    if (infraStale.length || notAged.length) {
      const parts = [];
      if (infraStale.length) parts.push(`${infraStale.length} estate-bound vouched lesson(s) were promoted more than ${cfg.staleOpenLeadSessions} savepoint cycle(s) ago — the pack cannot see the live estate; re-verify against it: ` + bounded(infraStale.map((x) => `${x.id} (${x.cycles} cycles)`)));
      if (notAged.length) parts.push(`${notAged.length} not aged (no promotion cycle on record): ${bounded(notAged)}`);
      add('memory:infra-reverify', 'WITHIN_LIMITS', parts.join('; '));
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

  /*
   * One parser for every list-valued contract flag, so --completion, --acceptance and --met all read
   * the same two ways: repeated flags accumulate in order, and a single value splits on ';'. The field
   * saw six repeated --completion flags recorded as one (valueOf read only the first occurrence) and a
   * ';'-joined criterion that itself held a ';' break into three. A bare ';' is always a separator; an
   * escaped '\;' is always a literal ';' kept inside one criterion. Trimmed, with empty fragments dropped.
   */
  const splitCriteria = (value) => {
    const out = [];
    let cur = '';
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '\\' && value[i + 1] === ';') { cur += ';'; i += 1; continue; }
      if (value[i] === ';') { out.push(cur); cur = ''; continue; }
      cur += value[i];
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  };
  const criteria = (name) => allValuesOf(name).flatMap(splitCriteria);
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
    // `--met` reads the same two ways as --acceptance: repeated flags, or one ';'-joined string.
    const met = criteria('--met');
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
    // The parsed attestation count rides beside the closure so a caller sees what `--met` was read as.
    if (target === 'delegate') {
      const closed = closeout.completeDelegation(DIR, { met, evidence, note });
      return { ...closed, criteriaCount: met.length };
    }

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
    const acceptance = criteria('--acceptance');
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
      authority: criteria('--authority'),
      forbidden: criteria('--forbidden'),
      activeGoalId: null,
      suspendedGoalId: activeOf(cur) || cur.suspendedGoalId || null, // a delegation does not cancel a goal either
      // ⛔ The interaction mode in force when this delegation opened, so its CLOSE restores that mode
      // rather than inferring one from the suspended goal. A delegation opened from collaborate (autonomy
      // already suspended) must close back to collaborate, not resume goal-mode autonomy nobody re-granted.
      priorMode: cur.mode === 'goal' ? 'goal' : 'collaborate',
    };
    setRuntime(c);
    return { outcome: OUTCOME.PASS, contract: c, criteriaCount: acceptance.length, note: 'bounded task — this finishes and stops; it does not become an autonomous scheduler' };
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
    const completion = criteria('--completion');
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
      constraints: criteria('--constraints'),
      authority: criteria('--authority'),
      forbidden: criteria('--forbidden'),
      externalBlockers: criteria('--blockers'),
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
      criteriaCount: completion.length,
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
    return { outcome: OUTCOME.FAIL, error: `unknown "memory" noun "${noun || ''}" — expected "candidates" (memory candidates [--ledger|promote <id>|reject <id>])` };
  }
  // G6 · `--ledger` is a report over the whole store, not an action on one candidate, so it is read as a
  // flag before the action dispatch (`memory candidates --ledger`).
  if (flag('--ledger')) return cmdMemoryCandidatesLedger();
  const action = argv[2] && !argv[2].startsWith('--') ? argv[2] : 'list';
  if (action === 'list') return cmdMemoryCandidatesList();
  if (action === 'promote') return cmdMemoryCandidatesPromote(argv[3] && !argv[3].startsWith('--') ? argv[3] : null);
  if (action === 'reject') return cmdMemoryCandidatesReject(argv[3] && !argv[3].startsWith('--') ? argv[3] : null);
  // G16 · the dev-side receiver for a `feedback --export` package: lands each record as a candidate.
  if (action === 'import') return cmdMemoryCandidatesImport(argv[3] && !argv[3].startsWith('--') ? argv[3] : null);
  return { outcome: OUTCOME.FAIL, error: `unknown "memory candidates" action "${action}" — expected list | promote <id> | reject <id> | import <file>` };
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

/*
 * ⛔ THE HOST AUTO-MEMORY MIRROR (decision 33). The graph entity under memory/graph/** is the RECORD;
 * this is a PROJECTION of a promoted lesson into Claude Code's own auto memory, so a fresh session's
 * MEMORY.md index points at the lesson without reading the project. It is a projection, not a second
 * store: it can be ABSENT (no auto memory for this project), WITHHELD (the index is at the host's
 * documented cap) or STALE, and says which. The promotion's verdict stays on the GRAPH write; the
 * mirror's outcome is reported beside it, so a mirror that could not be written never turns a real
 * promotion into a failure.
 *
 * ⛔ NOTHING THE PACK DID NOT WRITE IS TOUCHED. The pack finds its own files and index lines by a tag
 * (the memory file name, always `respawnpack-*`), and never rewrites a line a human or the host wrote.
 * The host does not DOCUMENT recognising files another program wrote, beyond their being plain Markdown,
 * so this is a convention the docs permit, not a contract.
 */

// The host loads MEMORY.md's first 200 lines or 25 KB, whichever comes first (Claude Code docs, read
// 2026-10-09). An index line that would push the file past either is not added.
const AUTO_MEMORY_MAX_LINES = 200;
const AUTO_MEMORY_MAX_BYTES = 25 * 1024;

// Encode a project root the way the host names its per-project memory directory: each path separator
// and the drive colon becomes a single '-' (C:\work\project -> C--work-project). Verbatim the
// host's own convention, so the pack and the host resolve the same directory for the same project.
function encodeProjectDirName(abs) {
  return String(abs).replace(/[\\/:]/g, '-');
}

/*
 * Resolve the host auto-memory directory in the documented order. Returns { dir, source }; the directory
 * is NOT created here, because whether it exists is the caller's gate (an absent one is NOT_APPLICABLE).
 *   1. RESPAWNPACK_AUTO_MEMORY_DIR — an environment override, for tests and probes only.
 *   2. autoMemoryDirectory from .claude/settings.json, then .claude/settings.local.json, then the user's
 *      ~/.claude/settings.json — a relative value resolved against the PROJECT ROOT, not the cwd; policy
 *      scopes are deliberately not read.
 *   3. ~/.claude/projects/<encoded>/memory/ with the host's encoding of the project root's absolute path.
 */
function resolveAutoMemoryDir() {
  const env = process.env.RESPAWNPACK_AUTO_MEMORY_DIR;
  if (env && env.trim()) return { dir: path.resolve(env.trim()), source: 'RESPAWNPACK_AUTO_MEMORY_DIR' };
  const scopes = [
    { file: path.join(DIR, '.claude', 'settings.json'), label: 'project settings.json' },
    { file: path.join(DIR, '.claude', 'settings.local.json'), label: 'project settings.local.json' },
    { file: path.join(os.homedir(), '.claude', 'settings.json'), label: 'user settings.json' },
  ];
  for (const s of scopes) {
    // readJSON is the pinned host-config reader (schema.test RAW_READS); a missing or unparseable file
    // is "not set here", never a fault.
    const doc = readJSON(s.file);
    const v = doc && typeof doc.autoMemoryDirectory === 'string' ? doc.autoMemoryDirectory.trim() : '';
    if (v) return { dir: path.resolve(DIR, v), source: `autoMemoryDirectory (${s.label})` };
  }
  return {
    dir: path.join(os.homedir(), '.claude', 'projects', encodeProjectDirName(path.resolve(DIR)), 'memory'),
    source: 'default ~/.claude/projects/<encoded>/memory',
  };
}

const mirrorFileNameFor = (type, slug) => `respawnpack-${graphSlugSafe(type)}-${graphSlugSafe(slug)}.md`;

// Atomic text write: a temp file beside the target, then rename, so an interrupted write leaves the
// prior file intact. One site for the memory file, the MEMORY.md read-modify-write and the G15 rules file.
// The temp name is per CALL (pid, a sequence and random bytes), the core/_io.js rule: a pid-only name is
// shared by every write one process makes. A failed write removes its own temp and rethrows the real error,
// so a refused rename never leaves a `.rp-tmp-` file beside the target.
let atomicTmpSeq = 0;
function atomicWriteText(file, text) {
  const tmp = `${file}.rp-tmp-${process.pid}-${(atomicTmpSeq += 1)}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw e;
  }
}

const oneLine = (s) => String(s == null ? '' : s).replace(/\r?\n/g, ' ').trim();
const yamlScalar = (s) => `"${oneLine(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The pack's OWN MEMORY.md line, matched by the full host-format shape anchored at line start, never a
// substring: a user line that merely mentions a respawnpack-*.md name in prose must never be read as
// ours, so it is neither counted as already-present on a promote nor removed on a reject.
function packMirrorLineRe(fileName) {
  return new RegExp(`^- \\[[^\\]]*\\]\\(${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\) \\u2014 `);
}

/*
 * Write one mirror memory file and add at most one index line. Returns an outcome-shaped record for the
 * `mirror` field beside the promotion's graph verdict. Idempotent: a repeat rewrites the same bytes and
 * adds no second line, because the file name is deterministic from the entity and the index line is
 * tagged by that name.
 */
function writeAutoMemoryMirror({ type, slug, claim, verification, entityRel, candidateId }) {
  const { dir, source } = resolveAutoMemoryDir();
  if (!fs.existsSync(dir)) {
    return { outcome: 'NOT_APPLICABLE', source, dir,
      detail: `auto memory not present for this project (${source}) — nothing was written or created` };
  }
  const fileName = mirrorFileNameFor(type, slug);
  const title = `${type}/${slug}`;
  const descr = oneLine(claim);
  const body = [
    '---',
    `name: ${fileName.replace(/\.md$/, '')}`,
    `description: ${yamlScalar(descr)}`,
    'metadata:',
    '  type: reference',
    `  source: ${entityRel}`,
    `  respawnpack: ${candidateId}`,
    '---',
    '',
    `# ${title}`,
    '',
    'A RespawnPack mirror of a promoted lesson. The record is the graph entity below, not this file.',
    '',
    `- Entity: \`${entityRel}\``,
    `- Claim: ${descr}`,
    `- Verified by: ${oneLine(verification)}`,
    `- Candidate: ${candidateId}`,
    '',
    'Open the entity file for the full observation and provenance.',
    '',
  ].join('\n');
  atomicWriteText(path.join(dir, fileName), body);

  // The index line, in the host's own format (em-dash kept verbatim), tagged by the file name.
  const indexPath = path.join(dir, 'MEMORY.md');
  let existing = '';
  try { existing = fs.readFileSync(indexPath, 'utf8'); } catch { existing = ''; }
  const line = `- [${title}](${fileName}) — ${descr}`;
  const packLine = packMirrorLineRe(fileName);
  if (existing.split(/\r?\n/).some((l) => packLine.test(l))) {
    return { outcome: 'PASS', source, dir, file: fileName, lineAdded: false,
      detail: `mirror refreshed: ${fileName} rewritten, its MEMORY.md line already present` };
  }
  const appended = existing.length && !existing.endsWith('\n') ? `${existing}\n${line}\n` : `${existing}${line}\n`;
  const lineCount = appended.replace(/\n$/, '').split('\n').length;
  if (lineCount > AUTO_MEMORY_MAX_LINES || Buffer.byteLength(appended, 'utf8') > AUTO_MEMORY_MAX_BYTES) {
    return { outcome: 'CANNOT_DETERMINE', source, dir, file: fileName, capped: true, lineAdded: false,
      detail: `the memory file ${fileName} was written, but MEMORY.md is at the host cap (200 lines / 25 KB) so no index line was added — the entry is reachable on demand, not from the index` };
  }
  atomicWriteText(indexPath, appended);
  return { outcome: 'PASS', source, dir, file: fileName, lineAdded: true,
    detail: `wrote ${fileName} and added one line to MEMORY.md (${source})` };
}

/*
 * Remove the mirror a prior promotion of this candidate wrote: the memory file whose frontmatter
 * `respawnpack:` names the id, and the one MEMORY.md line tagged by that file's name. Every other line
 * is kept verbatim. NOT_APPLICABLE when no mirror exists for the id.
 */
function removeAutoMemoryMirror(candidateId) {
  const { dir, source } = resolveAutoMemoryDir();
  if (!fs.existsSync(dir)) {
    return { outcome: 'NOT_APPLICABLE', source, dir, detail: `auto memory not present (${source}) — no mirror to remove` };
  }
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { outcome: 'NOT_APPLICABLE', source, dir, detail: `auto memory directory unreadable (${source}) — no mirror removed` }; }
  const idRe = new RegExp(`^\\s*respawnpack:\\s*${String(candidateId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  let target = null;
  for (const n of entries) {
    if (!/^respawnpack-.*\.md$/.test(n)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    if (idRe.test(text)) { target = n; break; }
  }
  if (!target) return { outcome: 'NOT_APPLICABLE', source, dir, detail: `no mirror for ${candidateId} in the host auto memory — nothing to remove` };
  try { fs.rmSync(path.join(dir, target), { force: true }); } catch { /* best effort */ }
  const indexPath = path.join(dir, 'MEMORY.md');
  let existing = null;
  try { existing = fs.readFileSync(indexPath, 'utf8'); } catch { existing = null; }
  let lineRemoved = false;
  if (existing !== null) {
    const packLine = packMirrorLineRe(target);
    // ⛔ C3 (G18) · DROP ONLY THE MIRROR LINE, LEAVE EVERY OTHER BYTE. Splitting on `/\r?\n/` and
    // re-joining with one chosen ending rewrote every surviving line to that ending: on a MEMORY.md with
    // mixed endings it normalised them all to CRLF, so the file's content was identical but its bytes were
    // not. Here each line keeps its OWN terminator (the capturing split pairs content with its ending), so
    // a mixed-ending index rejected once is byte-identical except for the removed line and its terminator.
    const tokens = existing.split(/(\r\n|\n|\r)/); // [content, eol, content, eol, …, lastContent]
    const out = [];
    for (let i = 0; i < tokens.length; i += 2) {
      if (packLine.test(tokens[i])) { lineRemoved = true; continue; } // drop the line AND its own terminator
      out.push(tokens[i] + (tokens[i + 1] || ''));
    }
    if (lineRemoved) atomicWriteText(indexPath, out.join(''));
  }
  return { outcome: 'PASS', source, dir, file: target, lineRemoved,
    detail: `removed the mirror ${target}${lineRemoved ? ' and its MEMORY.md line' : ' (no MEMORY.md line to remove)'}` };
}

// G7 · the schema's six typed edges (memory/knowledge-graph.md). Anything else is refused by name.
const RELATION_VERBS = ['depends-on', 'causes', 'fixed-by', 'supersedes', 'relates-to', 'applies-to'];
// An entity id: "<type>/<slug>" or "<type>:<slug>", both halves lowercase kebab-case. A bare token with
// no separator (e.g. "not-a-slug") is malformed — that is what distinguishes an id from a stray word.
const RELATION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*[/:][a-z0-9]+(?:-[a-z0-9]+)*$/;

/*
 * ⛔ G7 · PARSE --relates/--supersedes INTO THE SCHEMA'S LIST FORM, REFUSING A BAD ONE BY NAME. Each entry
 * becomes `verb|dst-id` with the id's separator normalised to a colon so it matches an entity's own `id:
 * <type>:<slug>` (and so a derived supersession finds its target). An unknown verb or a malformed id is an
 * error the caller refuses with BEFORE the store is touched; a well-formed id that names no existing
 * entity is accepted (the schema allows forward references) and reported, never refused.
 */
function parseRelations(relatesRaw, supersedesRaw) {
  const relations = [];
  const specs = [
    ...relatesRaw.map((raw) => ({ raw, verb: null })),
    ...supersedesRaw.map((raw) => ({ raw, verb: 'supersedes' })), // sugar for --relates supersedes|<id>
  ];
  for (const { raw, verb: implied } of specs) {
    let verb, idRaw;
    if (implied) { verb = implied; idRaw = String(raw).trim(); }
    else {
      const bar = String(raw).indexOf('|');
      if (bar <= 0) return { error: `--relates must be "<verb>|<id>" (got "${raw}")` };
      verb = raw.slice(0, bar).trim();
      idRaw = raw.slice(bar + 1).trim();
    }
    if (!RELATION_VERBS.includes(verb)) return { error: `unknown relation verb "${verb}" — the schema's verbs are ${RELATION_VERBS.join(', ')}` };
    if (!RELATION_ID_RE.test(idRaw)) return { error: `malformed relation id "${idRaw}" — expected "<type>/<slug>" or "<type>:<slug>" in lowercase kebab-case` };
    relations.push(`${verb}|${idRaw.replace('/', ':')}`);
  }
  return { relations };
}

/*
 * ⛔ D3 · THE HANDOFF POINTER, ONE PROJECT LINE, NOT A FILE PER SAVEPOINT. A `savepoint --write`
 * registers a single memory file `respawnpack-handoff.md` (frontmatter `metadata.type: project`,
 * `metadata.source: docs/derived/HANDOFF.md`) and ONE index line in the host's format, tagged by that
 * file name and rewritten in place on every write. Idempotent by construction: the body is deterministic
 * from the project, so a repeat rewrites the same bytes, and the index line is matched by its full
 * host-format shape (packMirrorLineRe), so it is added once and never duplicated. The three outcomes are
 * C3's: PASS, NOT_APPLICABLE when no auto memory directory exists (nothing created), CANNOT_DETERMINE at
 * the host cap with the file still written. Nothing the pack did not write is touched: a user's own
 * MEMORY.md line that merely mentions the file name in prose does not match the anchored shape, so it is
 * neither read as ours nor rewritten. The line carries the POINTER sentence only — the content is in the
 * repository, and the host directory is machine-local and outside version control.
 */
const HANDOFF_MEMORY_FILE = 'respawnpack-handoff.md';

function writeHandoffMemoryLine() {
  const { dir, source } = resolveAutoMemoryDir();
  if (!fs.existsSync(dir)) {
    return { outcome: 'NOT_APPLICABLE', source, dir,
      detail: `host auto memory not present for this project (${source}) — no handoff pointer was written or created` };
  }
  const project = path.basename(path.resolve(DIR));
  const descr = `RespawnPack handoff for ${project}: read docs/derived/HANDOFF.md first, before CONTINUITY.`;
  const body = [
    '---',
    `name: ${HANDOFF_MEMORY_FILE.replace(/\.md$/, '')}`,
    `description: ${yamlScalar(descr)}`,
    'metadata:',
    '  type: project',
    '  source: docs/derived/HANDOFF.md',
    '---',
    '',
    `# ${project} — RespawnPack handoff`,
    '',
    'Read `docs/derived/HANDOFF.md` first for the current task, next unblocked work, open blockers, files',
    'touched and the verify commands. It is a generated projection kept in the repository; this note is only',
    'the pointer to it. The operator prose is the NOTE block in `docs/derived/CONTINUITY.md`.',
    '',
  ].join('\n');
  atomicWriteText(path.join(dir, HANDOFF_MEMORY_FILE), body);

  const indexPath = path.join(dir, 'MEMORY.md');
  let existing = '';
  try { existing = fs.readFileSync(indexPath, 'utf8'); } catch { existing = ''; }
  const line = `- [${project} handoff](${HANDOFF_MEMORY_FILE}) — ${descr}`;
  const packLine = packMirrorLineRe(HANDOFF_MEMORY_FILE);
  if (existing.split(/\r?\n/).some((l) => packLine.test(l))) {
    return { outcome: 'PASS', source, dir, file: HANDOFF_MEMORY_FILE, lineAdded: false,
      detail: `handoff pointer refreshed: ${HANDOFF_MEMORY_FILE} rewritten, its MEMORY.md line already present` };
  }
  const appended = existing.length && !existing.endsWith('\n') ? `${existing}\n${line}\n` : `${existing}${line}\n`;
  const lineCount = appended.replace(/\n$/, '').split('\n').length;
  if (lineCount > AUTO_MEMORY_MAX_LINES || Buffer.byteLength(appended, 'utf8') > AUTO_MEMORY_MAX_BYTES) {
    // At the host cap: the handoff FILE is still written; only the index line is withheld. This is a
    // machine-local condition, so it is NOT_APPLICABLE (never CANNOT_DETERMINE): a full host MEMORY.md
    // must never turn an all-PASS savepoint into a non-zero verdict about the PROJECT.
    return { outcome: 'NOT_APPLICABLE', source, dir, file: HANDOFF_MEMORY_FILE, capped: true, lineAdded: false,
      detail: `${HANDOFF_MEMORY_FILE} was written, but MEMORY.md is at the host cap (200 lines / 25 KB) so no index line was added — the handoff is reachable on demand, not from the index` };
  }
  atomicWriteText(indexPath, appended);
  return { outcome: 'PASS', source, dir, file: HANDOFF_MEMORY_FILE, lineAdded: true,
    detail: `wrote ${HANDOFF_MEMORY_FILE} and added one handoff line to MEMORY.md (${source})` };
}

/*
 * ⛔ G15 · CORRECTIONS BECOME RULES — the versioned rules file a `--as rule/<slug>` promotion writes into.
 *
 * G10 shipped the mechanics a rule rides: a project's versioned rules file wins over the shipped
 * writing-standards.md in the skills' loaded text, each rule carries a [script]/[reader]/[both] tag, and a
 * different agent reads before sign-off. This is the write half: an audited promotion is the confirmation,
 * and it appends the confirmed rule to the file the SKILLS read, bumping its version by one. The precedence
 * these helpers implement — the highest `version:` among the two loaded locations wins, an unversioned file
 * loses to any versioned one — is the SAME rule skills/wordsmith/SKILL.md states for reading; it lives once,
 * here, so the kernel writes to exactly the file the skill would load.
 */
const DOCS_RULES_REL = 'docs/reference/wordsmith-rules.md';
const RULES_TAGS = ['script', 'reader', 'both'];
const rulesLocationsMsg = () =>
  `a rules file must be one of the two locations the skills load: ${DOCS_RULES_REL}, or a .claude/rules/writing*.md`;

/** Every rules file that exists in the two loaded locations, as absolute paths (docs/reference first). */
function listRulesFiles() {
  const out = [];
  const docs = path.join(DIR, 'docs', 'reference', 'wordsmith-rules.md');
  if (fs.existsSync(docs)) out.push(docs);
  const rulesDir = path.join(DIR, '.claude', 'rules');
  try {
    for (const name of fs.readdirSync(rulesDir).sort()) {
      if (/^writing.*\.md$/.test(name)) out.push(path.join(rulesDir, name));
    }
  } catch { /* no .claude/rules/ directory: only the docs location can exist */ }
  return out;
}

/** The frontmatter `version:` or a body `Version:` line, whichever comes first — the skill's own precedence key. */
function findRulesVersionLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(version|Version):[ \t]*(\S.*?)?[ \t]*$/.exec(lines[i]);
    if (m) return { lineIndex: i, key: m[1], value: (m[2] || '').trim() };
  }
  return null;
}

/** An integer `N` or a dotted `a.b`, or null when neither — the only two shapes a bump is defined for. */
function parseVersionValue(v) {
  if (/^\d+$/.test(v)) return { parts: [parseInt(v, 10)], dotted: false };
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (m) return { parts: [parseInt(m[1], 10), parseInt(m[2], 10)], dotted: true };
  return null;
}
const bumpVersionValue = (v) => {
  const p = parseVersionValue(v);
  if (!p) return null;
  return p.dotted ? `${p.parts[0]}.${p.parts[1] + 1}` : String(p.parts[0] + 1);
};
/** Negative/zero/positive like a comparator; null when either side is unparseable. A bare `N` reads as `N.0`. */
function compareVersionValues(a, b) {
  const pa = parseVersionValue(a), pb = parseVersionValue(b);
  if (!pa || !pb) return null;
  const amaj = pa.parts[0], amin = pa.parts[1] || 0;
  const bmaj = pb.parts[0], bmin = pb.parts[1] || 0;
  return amaj !== bmaj ? amaj - bmaj : amin - bmin;
}

/** Is this absolute path one of the two locations a rules file is allowed to be written to? */
function isAllowedRulesPath(absPath) {
  const rel = removalsLib.posix(path.relative(DIR, absPath));
  return rel === DOCS_RULES_REL || /^\.claude\/rules\/writing[^/]*\.md$/.test(rel);
}

/** Among existing rules files, the one the skill would load: highest version, versioned over unversioned, docs first. */
function pickHighestVersionRulesFile(absFiles) {
  const scored = absFiles.map((abs) => {
    let text = ''; try { text = fs.readFileSync(abs, 'utf8'); } catch { /* unreadable ranks as unversioned */ }
    const vl = findRulesVersionLine(text.split(/\r?\n/));
    const v = vl ? parseVersionValue(vl.value) : null;
    const rel = removalsLib.posix(path.relative(DIR, abs));
    return { abs, rel, v, isDocs: rel === DOCS_RULES_REL };
  });
  scored.sort((a, b) => {
    if (!!a.v !== !!b.v) return a.v ? -1 : 1;
    if (a.v && b.v) {
      const maj = b.v.parts[0] - a.v.parts[0]; if (maj) return maj;
      const min = (b.v.parts[1] || 0) - (a.v.parts[1] || 0); if (min) return min;
    }
    if (a.isDocs !== b.isDocs) return a.isDocs ? -1 : 1;
    return a.rel.localeCompare(b.rel);
  });
  return scored[0].abs;
}

/** The header a freshly created rules file carries: the three mechanics, `version: 1`, an empty `## Rules`. */
function newRulesFileText(pathsArg) {
  const out = ['---', 'version: 1'];
  if (pathsArg && pathsArg.trim()) {
    out.push('paths:');
    for (const g of pathsArg.trim().split(/\s+/)) out.push(`  - "${g}"`);
  }
  out.push('---', '',
    '# Project writing rules',
    '',
    'These rules win over the shipped docs/reference/writing-standards.md on any contradiction (G10). Each '
      + 'rule carries a [script], [reader] or [both] tag: a [script] rule is gated by the project\'s own '
      + 'script, a [reader] rule needs a read, and a different agent reads the [reader] and [both] rules before '
      + 'sign-off. The pack appends a confirmed rule below through `respawnpack memory candidates promote --as '
      + 'rule/<slug>`; a version bumped with no confirmed candidate behind it is flagged by `doctor`.',
    '',
    '## Rules',
    '');
  return `${out.join('\n')}\n`;
}

/*
 * ⛔ THE WITHDRAWN-RULE RECORD. A retraction (any rejection that proceeds) removes the confirmed line from
 * the rules file, so the skills stop loading its instruction, and records the removal in a
 * `## Withdrawn rules` section that carries NO rule text: `- rule <n> withdrawn (rule:<slug>, withdrawn
 * v<version>, <candidate id>): <reason>`. The stamp keeps doctor's version-ahead arithmetic honest (the bump
 * the withdrawal made has a line behind it) and keeps rule <n> from being reused by a later promotion.
 */
const WITHDRAWN_RULES_HEADING = '## Withdrawn rules';
const WITHDRAWN_HEADING_RE = /^##\s+Withdrawn rules\s*$/i;
const withdrawnStampRe = () => /\(rule:([a-z0-9][a-z0-9-]*),\s*withdrawn v(\d+(?:\.\d+)?),\s*([^)]+?)\)/g;
const confirmedStampRe = () => /\(rule:([a-z0-9][a-z0-9-]*),\s*confirmed v(\d+(?:\.\d+)?),\s*([^)]+?)\)/g;

/** The next rule number = one past the highest already numbered or withdrawn, so a removed line never collides. */
function nextRuleNumber(lines) {
  let max = 0;
  for (const l of lines) {
    const m = /^(\d+)\.\s/.exec(l) || /^- rule (\d+) withdrawn\b/.exec(l);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/** Insert one rule line at the end of the `## Rules` section, creating the section at EOF when absent. */
function insertRuleLine(lines, ruleLine, headingRe = /^##\s+Rules\s*$/i, heading = '## Rules') {
  const out = lines.slice();
  const rulesIdx = out.findIndex((l) => headingRe.test(l));
  if (rulesIdx < 0) {
    let end = out.length;
    while (end > 0 && out[end - 1].trim() === '') end--;
    return [...out.slice(0, end), '', heading, ruleLine, ''];
  }
  let secEnd = out.length;
  for (let i = rulesIdx + 1; i < out.length; i++) { if (/^##\s+/.test(out[i])) { secEnd = i; break; } }
  let at = secEnd;
  while (at - 1 > rulesIdx && out[at - 1].trim() === '') at--;
  out.splice(at, 0, ruleLine);
  return out;
}

/*
 * ⛔ THE PLAN IS COMPUTED BEFORE THE STORE IS TOUCHED, SO EVERY REFUSAL LEAVES NOTHING WRITTEN. A bad
 * --rules-file, a new .claude/rules/ file with no --paths, or an unparseable version is returned as an
 * error here; the caller promotes only after this succeeds, so a refusal never half-confirms a candidate.
 * The actual write runs AFTER the graph entity exists (the candidate is then genuinely verified), but the
 * bytes are decided here. The caller holds the rules-file lock (acquireRulesLock) from before this plan
 * until after the write, so no other process changes the file in between: two concurrent promotions are
 * serialised and the second plans from the file the first wrote, never from the same stale base.
 */
function planRulesFileWrite({ slug, tag, candidateId, ruleText, rulesFileArg, pathsArg }) {
  let targetAbs;
  if (rulesFileArg) {
    targetAbs = path.resolve(DIR, rulesFileArg);
    if (!isAllowedRulesPath(targetAbs)) {
      return { ok: false, error: `--rules-file ${rulesFileArg} is not an allowed rules location — ${rulesLocationsMsg()}` };
    }
  } else {
    const existing = listRulesFiles();
    targetAbs = existing.length ? pickHighestVersionRulesFile(existing) : path.join(DIR, 'docs', 'reference', 'wordsmith-rules.md');
  }
  const targetRel = removalsLib.posix(path.relative(DIR, targetAbs));
  const underClaudeRules = /^\.claude\/rules\//.test(targetRel);
  const isNew = !fs.existsSync(targetAbs);
  if (isNew && underClaudeRules && !(pathsArg && pathsArg.trim())) {
    return { ok: false, error: `a new .claude/rules/ rule file loads on every session boot, so it must be created with --paths "<glob>" to scope it (0 B at boot); or target ${DOCS_RULES_REL}` };
  }

  let base, eol;
  if (isNew) {
    base = newRulesFileText(underClaudeRules ? pathsArg : null);
    eol = '\n';
  } else {
    try { base = fs.readFileSync(targetAbs, 'utf8'); }
    catch (e) { return { ok: false, error: `the rules file ${targetRel} could not be read (${(e && e.code) || 'ERROR'})` }; }
    eol = /\r\n/.test(base) ? '\r\n' : '\n';
  }

  const lines = base.split(/\r?\n/);
  const vLine = findRulesVersionLine(lines);
  if (!vLine || !parseVersionValue(vLine.value)) {
    return { ok: false, error: `the rules file ${targetRel} has ${vLine ? `an unparseable version "${vLine.value}"` : 'no version: line'} to bump — set an integer or a.b version first; nothing was written` };
  }
  const oldVersion = vLine.value;
  const newVersion = bumpVersionValue(oldVersion);

  // Idempotent by the `(rule:<slug>` marker, NOT by PROMOTED vs ALREADY_VERIFIED: a repeat whose line is
  // already present writes nothing and never bumps a second time; a repeat whose line was hand-deleted
  // writes it back exactly once.
  const bootNote = underClaudeRules && !/^paths:/m.test(base)
    ? `${targetRel} has no paths: frontmatter, so the host loads it on every session boot; scope it with a paths: glob to spend 0 B at boot`
    : null;
  // The marker is the CONFIRMED form: a `(rule:<slug>, withdrawn v...)` record of an earlier retraction
  // carries no instruction, so a later promotion of the same slug still writes its line.
  if (new RegExp(`\\(rule:${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},\\s*confirmed v`).test(base)) {
    return { ok: true, targetAbs, targetRel, willWrite: false, oldVersion, newVersion: oldVersion, bootNote };
  }

  const line = `${nextRuleNumber(lines)}. [${tag}] ${oneLine(ruleText)} (rule:${slug}, confirmed v${newVersion}, ${candidateId})`;
  lines[vLine.lineIndex] = `${vLine.key}: ${newVersion}`;
  const newText = insertRuleLine(lines, line).join(eol);
  return { ok: true, targetAbs, targetRel, willWrite: true, isNew, oldVersion, newVersion, line, newText, bootNote };
}

/*
 * ⛔ THE RULES-FILE LOCK. Planning a rules write reads the file and the write replaces it whole, so two
 * processes that plan from the same bytes lose one rule to the second rename (two concurrent promotions both
 * said PASS and the file held one line). Every rules-file read-plan-write runs under this exclusive lock, the
 * ops-log append mutex's pattern (acquireOpsLock) on its own lock file so neither ever waits on the other: a
 * portable compare-and-swap, a bounded wait, a conservative stale window with a NAMED reclaim, and a
 * fail-closed refusal that writes nothing. The ops-log functions are left exactly as they are.
 */
const RULES_LOCK_REL = path.join('.respawnpack', 'rules-file.lock');
// The held window is one promotion's store, graph and rules writes (milliseconds), so a second promotion
// almost always lands inside this wait; a whole loaded CLI process is still well inside it.
const RULES_LOCK_WAIT_MS = 3000;
// A lock older than this had a holder that died mid-write. Far past the wait, so a slow but live holder is
// waited out and refused, never reclaimed.
const RULES_LOCK_STALE_MS = 30000;
const rulesLockPath = () => path.join(DIR, RULES_LOCK_REL);
const rulesLockRelPosix = () => removalsLib.posix(RULES_LOCK_REL);

/** @returns {{ok:true, reclaimedFrom:string|null} | {ok:false, detail:string}} */
function acquireRulesLock(what) {
  const lock = rulesLockPath();
  const holder = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), what });
  const deadline = Date.now() + RULES_LOCK_WAIT_MS;
  let reclaimedFrom = null;
  for (;;) {
    const r = core.io.createExclusive(lock, holder);
    if (r.status === 'CREATED') return { ok: true, reclaimedFrom };
    if (r.status !== 'EXISTS') {
      // the same Windows delete-pending window as the ops-log lock (lockCreateTransient): wait it out
      if (!lockCreateTransient(r) || Date.now() > deadline) return { ok: false, detail: `the rules-file lock \`${rulesLockRelPosix()}\` could not be created (${r.detail}) - the ${what} was refused, nothing written` };
      opsPause();
      continue;
    }
    let age = null;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; }
    catch { /* vanished between the CAS and the stat: pure contention, retry at once */ }
    if (age !== null && age > RULES_LOCK_STALE_MS) {
      try { fs.unlinkSync(lock); } catch { /* another writer reclaimed it first */ }
      reclaimedFrom = `a stale \`${rulesLockRelPosix()}\` lock ${Math.round(age / 1000)}s old (older than the ${RULES_LOCK_STALE_MS / 1000}s stale window - its holder had died)`;
      continue;
    }
    if (Date.now() > deadline) {
      return { ok: false, detail: `the rules-file lock \`${rulesLockRelPosix()}\` is held by another writer and did not clear within ${RULES_LOCK_WAIT_MS}ms - the ${what} was refused, nothing written` };
    }
    opsPause();
  }
}

/** Release the rules-file lock. Best-effort: an already-reclaimed lock is not an error. */
function releaseRulesLock() {
  try { fs.unlinkSync(rulesLockPath()); } catch { /* already reclaimed, or never created */ }
}

/*
 * ⛔ G15 · A RETRACTED RULE STOPS BEING AN INSTRUCTION. Plan, per rules file in the two loaded locations,
 * the removal of every `(rule:<slug>, confirmed v<n>, <id>)` line naming this candidate, one version bump
 * per changed file, and the withdrawal record (no rule text) under `## Withdrawn rules`. A file with no such
 * line is not planned at all, so a repeat plans nothing: no second record and no second bump. An unreadable
 * file or an unparseable version is an error, never a silent skip, because skipping it would leave the
 * instruction active. The caller holds the rules-file lock across this plan and the writes.
 */
function planRulesWithdrawal(candidateId, reason) {
  const plans = [];
  for (const abs of listRulesFiles()) {
    const rel = removalsLib.posix(path.relative(DIR, abs));
    let base;
    try { base = fs.readFileSync(abs, 'utf8'); }
    catch (e) { return { ok: false, rel, error: `the rules file ${rel} could not be read (${(e && e.code) || 'ERROR'})` }; }
    const eol = /\r\n/.test(base) ? '\r\n' : '\n';
    const lines = base.split(/\r?\n/);
    const hits = [];
    lines.forEach((l, i) => {
      const re = confirmedStampRe(); let m;
      while ((m = re.exec(l))) if (m[3].trim() === candidateId) { hits.push({ i, slug: m[1], n: (/^(\d+)\.\s/.exec(l) || [])[1] || null }); break; }
    });
    if (!hits.length) continue;
    const vLine = findRulesVersionLine(lines);
    if (!vLine || !parseVersionValue(vLine.value)) {
      return { ok: false, rel, error: `the rules file ${rel} carries a confirmed line for ${candidateId} but ${vLine ? `an unparseable version "${vLine.value}"` : 'no version: line'} to bump - set an integer or a.b version, then re-run` };
    }
    const oldVersion = vLine.value;
    const newVersion = bumpVersionValue(oldVersion);
    lines[vLine.lineIndex] = `${vLine.key}: ${newVersion}`;
    const drop = new Set(hits.map((h) => h.i));
    let out = lines.filter((_, i) => !drop.has(i));
    const records = hits.map((h) => `- rule ${h.n || '?'} withdrawn (rule:${h.slug}, withdrawn v${newVersion}, ${candidateId}): ${oneLine(reason).replace(/[()]/g, '')}`);
    for (const rec of records) out = insertRuleLine(out, rec, WITHDRAWN_HEADING_RE, WITHDRAWN_RULES_HEADING);
    plans.push({ abs, rel, oldVersion, newVersion, slugs: hits.map((h) => h.slug), records, newText: out.join(eol) });
  }
  return { ok: true, plans };
}

/** Is there any confirmed line naming this candidate? A cheap unlocked probe, so most rejections take no lock. */
function rulesFilesNameCandidate(candidateId) {
  for (const abs of listRulesFiles()) {
    let text = ''; try { text = fs.readFileSync(abs, 'utf8'); } catch { return true; } // unreadable: let the locked plan name it
    const re = confirmedStampRe(); let m;
    while ((m = re.exec(text))) if (m[3].trim() === candidateId) return true;
  }
  return false;
}

/** One IO error as `CODE: message`, without repeating the code Node already puts at the front of the message. */
const ioCause = (e) => { const code = (e && e.code) || 'ERROR'; const msg = String((e && e.message) || e); return msg.startsWith(code) ? msg : `${code}: ${msg}`; };

/** Quote one CLI argument for a printed retry command. */
const cliArg = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

/*
 * ⛔ G15 · THE RULES FILE'S INTEGRITY, FOR doctor. Three questions, each file-and-store checked so a hand
 * edit is a named row rather than a silent honouring:
 *   unconfirmed-line  a `(rule:<slug>, confirmed v<n>, <id>)` line whose candidate is not verified in the
 *                     store, or whose rule:<slug> entity is absent or retracted — a forged confirmation.
 *   version-ahead     a file carrying >=1 pack-written line whose `version:` runs ahead of its newest
 *                     confirmed rule or withdrawal record: a version bumped with no promotion behind it.
 *   unversioned       a rules file in the two locations with no parseable version — applied by the skill
 *                     but reported unversioned, stated here where doctor is read.
 * A file with NO pack-written line is the project's own hand-kept file (G10) and earns neither anomaly; a
 * project with no rules file earns nothing. Candidate verification is only asserted when the store AND the
 * graph could be read: an unreadable store is CANNOT_DETERMINE, so it never forges an anomaly.
 */
function rulesIntegrityReport() {
  const files = listRulesFiles();
  const unconfirmed = [], versionAhead = [], unversioned = [];
  const cands = readCandidateRecords();
  const graph = readGraphEntities();
  const storeKnown = cands.status === 'OK' || cands.status === 'ABSENT';
  const graphKnown = graph.status === 'OK' || graph.status === 'ABSENT';
  const verifiedIds = new Set((cands.status === 'OK' ? cands.records : []).filter((r) => r.verificationState === 'verified').map((r) => r.id));
  const liveRuleSlugs = new Set((graph.status === 'OK' ? graph.entities : [])
    .filter((e) => !ledgerIsRetracted(e.file) && /^rule:/.test(String(e.id || '')))
    .map((e) => String(e.id).slice('rule:'.length)));
  const packLineRe = /\(rule:([a-z0-9][a-z0-9-]*),\s*confirmed v(\d+(?:\.\d+)?),\s*([^)]+?)\)/g;

  for (const abs of files) {
    const rel = removalsLib.posix(path.relative(DIR, abs));
    let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const vLine = findRulesVersionLine(text.split(/\r?\n/));
    const fileVersion = vLine && parseVersionValue(vLine.value) ? vLine.value : null;
    if (!fileVersion) unversioned.push(rel);

    const packLines = [];
    let m; packLineRe.lastIndex = 0;
    while ((m = packLineRe.exec(text))) packLines.push({ slug: m[1], confirmedV: m[2], candidateId: m[3].trim() });

    if (storeKnown && graphKnown) {
      for (const pl of packLines) {
        const candOk = verifiedIds.has(pl.candidateId);
        const entOk = liveRuleSlugs.has(pl.slug);
        if (candOk && entOk) continue;
        const reason = !candOk && !entOk ? 'candidate not verified and rule entity absent/retracted'
          : !candOk ? 'candidate not verified in the store' : 'rule entity absent or retracted';
        unconfirmed.push({ rel, slug: pl.slug, candidateId: pl.candidateId, reason });
      }
    }
    // A withdrawal record's stamp is a pack-written version too: the bump a retraction made has a line
    // behind it, so it is never read as a version run ahead of the ledger.
    const stamps = packLines.map((pl) => pl.confirmedV);
    { const wre = withdrawnStampRe(); let w; while ((w = wre.exec(text))) stamps.push(w[2]); }
    if (stamps.length && fileVersion) {
      let highest = null;
      for (const v of stamps) if (highest === null || compareVersionValues(v, highest) > 0) highest = v;
      if (highest !== null && compareVersionValues(fileVersion, highest) > 0) {
        versionAhead.push({ rel, version: fileVersion, highest });
      }
    }
  }
  return { anyFile: files.length > 0, unconfirmed, versionAhead, unversioned };
}

/*
 * ⛔ G15 · A RULE PROMOTION RUNS WHOLE UNDER THE RULES-FILE LOCK. The plan reads the file before the store
 * is touched and the write replaces it after the entity exists, so the lock spans both: a second concurrent
 * promotion waits, then plans from the file the first one wrote (its own number, one more bump), instead
 * of renaming over it. A lock that never clears refuses the promotion as FAIL with nothing written, so the
 * same command simply runs again. Every other `--as` type takes no lock.
 */
function cmdMemoryCandidatesPromote(id) {
  const as = valueOf('--as', null);
  if (!id || !as || !/^rule\/./.test(as) || !core) return promoteCandidate(id);
  const lk = acquireRulesLock('promotion');
  if (!lk.ok) return { outcome: OUTCOME.FAIL, status: 'RULES_LOCKED', id, error: `${lk.detail}. Re-run the same promote once the other writer has finished.` };
  try {
    const r = promoteCandidate(id);
    if (lk.reclaimedFrom && r && typeof r === 'object') r.rulesLockReclaimed = lk.reclaimedFrom;
    return r;
  } finally { releaseRulesLock(); }
}

function promoteCandidate(id) {
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
  // G6 · the verdict's author is mandatory, checked before anything is written. `--verified-by` is WHAT
  // proved it; `--by` is WHO made the call, and a verdict with no author cannot be reviewed. Refused
  // here so a promotion without it writes neither the store, the graph entity nor the host mirror.
  if (!by || !by.trim()) {
    return { outcome: OUTCOME.FAIL, error: 'promote requires --by "<who>" — the author of this verdict. A promotion with no recorded author cannot be reviewed; the /savepoint review step names it.' };
  }

  // G7 · relations and asOf are validated BEFORE the store is touched, so a bad verb/id or date leaves
  // nothing written. asOf defaults to promotedAt inside writeGraphEntity when --as-of is absent.
  const rel = parseRelations(allValuesOf('--relates'), allValuesOf('--supersedes'));
  if (rel.error) return { outcome: OUTCOME.FAIL, error: rel.error };
  const relations = rel.relations;
  const asOfRaw = valueOf('--as-of', null);
  if (asOfRaw && (!/^\d{4}-\d{2}-\d{2}/.test(asOfRaw) || !Number.isFinite(Date.parse(asOfRaw)))) {
    return { outcome: OUTCOME.FAIL, error: `--as-of must be an ISO date (YYYY-MM-DD), got "${asOfRaw}"` };
  }
  const asOf = asOfRaw || null;

  /*
   * ⛔ G8 · THE WORLD BINDING IS RESOLVED AND VALIDATED BEFORE THE STORE IS TOUCHED (the G7 rule). A bad
   * flag, a missing document or an estate without its source leaves nothing written. The three forms:
   *   --world commit[:<sha>]            a code project — HEAD now, or the named 40-hex commit
   *   --world doc:<path>                a knowledge project — the digest of the file's bytes, read classified
   *   --world estate:<serial> --estate-source <path>   a live estate — the serial, bound to the tracked file
   * With no --world, the entity is bound to commit:<the candidate's cycleId> when that cycleId is a commit
   * sha (savepoint already records it), and left unbound otherwise — decided after promote() from the record.
   */
  const worldRaw = valueOf('--world', null);
  const estateSource = valueOf('--estate-source', null);
  let world = null; // { kind, value, locator } | null; null here means "fall to the cycleId default"
  if (worldRaw) {
    if (worldRaw === 'commit' || worldRaw.startsWith('commit:')) {
      const sha = worldRaw === 'commit' ? headRevision() : worldRaw.slice('commit:'.length).trim();
      if (worldRaw === 'commit' && !sha) return { outcome: OUTCOME.FAIL, error: '--world commit needs a repository with a commit to bind to; none was found. Pass --world commit:<sha> or omit --world. Nothing was written.' };
      if (!/^[0-9a-f]{40}$/.test(sha)) return { outcome: OUTCOME.FAIL, error: `--world commit:<sha> needs a 40-hex commit sha, got "${sha}". Nothing was written.` };
      world = { kind: 'commit', value: sha, locator: '' };
    } else if (worldRaw.startsWith('doc:')) {
      const rel = worldRaw.slice('doc:'.length).trim();
      if (!rel) return { outcome: OUTCOME.FAIL, error: '--world doc:<path> needs a repository-relative path. Nothing was written.' };
      const r = core ? core.io.readTextClassified(path.join(DIR, rel)) : null;
      if (!r || r.status !== 'OK') return { outcome: OUTCOME.FAIL, error: `--world doc:${rel} must name a readable file under the project (${r ? r.status : 'core unavailable'}); nothing was written.` };
      // Digest the CRLF-folded content (docDigestOf), the same fold the compare uses, so a later checkout
      // on the other side of git's EOL normalisation is not read as a move.
      world = { kind: 'docDigest', value: docDigestOf(r.text), locator: removalsLib.posix(rel) };
    } else if (worldRaw.startsWith('estate:')) {
      const serial = worldRaw.slice('estate:'.length).trim();
      if (!serial) return { outcome: OUTCOME.FAIL, error: '--world estate:<serial> needs a serial value. Nothing was written.' };
      if (!estateSource) return { outcome: OUTCOME.FAIL, error: '--world estate:<serial> requires --estate-source <path> — the tracked file whose first non-empty line is the current serial. Nothing was written.' };
      const r = core ? core.io.readTextClassified(path.join(DIR, estateSource)) : null;
      if (!r || r.status !== 'OK') return { outcome: OUTCOME.FAIL, error: `--estate-source ${estateSource} must name a readable file under the project (${r ? r.status : 'core unavailable'}); nothing was written.` };
      world = { kind: 'estateRevision', value: serial, locator: removalsLib.posix(estateSource) };
    } else {
      return { outcome: OUTCOME.FAIL, error: `--world must be commit[:<sha>], doc:<path> or estate:<serial> (with --estate-source), got "${worldRaw}". Nothing was written.` };
    }
  } else if (estateSource) {
    return { outcome: OUTCOME.FAIL, error: '--estate-source is only meaningful with --world estate:<serial>. Nothing was written.' };
  }

  // A forward reference is allowed but reported: the reviewer decides whether the target should exist.
  const existingIds = (() => { const g = readGraphEntities(); return g.status === 'OK' ? new Set(g.entities.map((e) => e.id)) : new Set(); })();
  const relationNotes = relations
    .filter((r) => !r.startsWith('applies-to|') && !existingIds.has(r.split('|')[1]))
    .map((r) => `relation target not found: ${r.split('|')[1]}`);

  const read = core.candidates.read(memoryStoreDir(), id);
  if (read.status === 'ABSENT') return { outcome: OUTCOME.FAIL, error: `no candidate ${id} in this store` };
  if (read.status !== 'OK') return { outcome: OUTCOME.CANNOT_DETERMINE, error: `candidate ${id} could not be read (${read.detail || read.status})` };
  // Structurally unreachable via the public API — capture()/read() already refuse an invalid klass
  // through validate() — named explicitly rather than trusted silently, in case that invariant weakens.
  if (!core.candidates.KLASSES.includes(read.record.klass)) {
    return { outcome: OUTCOME.FAIL, error: `candidate ${id} has klass "${read.record.klass}", outside the promotable set (${core.candidates.KLASSES.join(', ')})` };
  }

  /*
   * ⛔ G7 · A FUTURE asOf POISONS THE REGISTER, SO IT IS REFUSED CLOCK-FREE BEFORE THE STORE IS TOUCHED.
   * The staleness reference is the NEWEST asOf across the vouched set (render.js), so a lesson dated in the
   * future would become that reference and age every other lesson by the gap. The upper bound is the
   * candidate's OWN recorded time — its verification time if already promoted, else its capture time — not
   * `new Date()`: a lesson cannot be as-of a date it was not yet known, and reading a stored timestamp
   * keeps the clock out of it. Refused here, before promote(), so a rejection leaves the store and the
   * mirror exactly as they were.
   */
  if (asOf) {
    const bound = (read.record.verification && read.record.verification.at) || read.record.provenance.at;
    if (Date.parse(asOf) > Date.parse(bound)) {
      return { outcome: OUTCOME.FAIL, error: `--as-of ${asOf} is later than the candidate's recorded time (${bound}) — a lesson cannot be as-of a date it was not yet known; nothing was written` };
    }
  }

  const slashAt = as.indexOf('/');
  const type = as.slice(0, slashAt);
  const slug = as.slice(slashAt + 1);

  /*
   * ⛔ G15 · PROMOTING AS A `rule` ALSO WRITES THE VERSIONED RULES FILE, AND ITS REFUSALS ARE CHECKED NOW,
   * BEFORE THE STORE IS TOUCHED. The tag defaults to `reader`; a bad --tag, a --rules-file outside the two
   * loaded locations, a new .claude/rules/ file without --paths, or an unparseable version is refused here
   * so a rejection leaves the store, the graph entity and the rules file exactly as they were. Any klass
   * may be promoted as a rule (a `constraint` is the usual one); the capture klass stays on the provenance
   * line. --tag/--rules-file/--paths are ignored for every other type.
   */
  const isRule = type === 'rule';
  let ruleTag = null, rulesPlan = null;
  if (isRule) {
    const tagArg = valueOf('--tag', null);
    if (tagArg && !RULES_TAGS.includes(tagArg)) {
      return { outcome: OUTCOME.FAIL, error: `--tag must be one of ${RULES_TAGS.join(', ')} (got "${tagArg}")` };
    }
    ruleTag = tagArg || 'reader';
    rulesPlan = planRulesFileWrite({
      slug, tag: ruleTag, candidateId: id, ruleText: read.record.claim,
      rulesFileArg: valueOf('--rules-file', null), pathsArg: valueOf('--paths', null),
    });
    if (!rulesPlan.ok) return { outcome: OUTCOME.FAIL, error: rulesPlan.error };
  }

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
  // G8 · with no --world, bind to the candidate's capture cycle when that cycle names a commit (the
  // savepoint already records cycleId: <sourceRevision>), and leave unbound otherwise. The capture side
  // is unchanged: the candidate's provenance is the binding's source. A repeat reads the stored fields
  // back off the entity (writeGraphEntity), so this derivation never fights an existing binding.
  let defaultedWorld = false;
  if (!world) {
    const cycleId = promoted.record.provenance && promoted.record.provenance.cycleId;
    if (cycleId && /^[0-9a-f]{40}$/.test(cycleId)) { world = { kind: 'commit', value: cycleId, locator: '' }; defaultedWorld = true; }
  }
  const graph = writeGraphEntity(type, slug, promoted.record, {
    verifiedBy: recordedVerification.note || (recordedVerification.evidencePaths || [])[0] || verifiedBy,
    by: recordedVerification.by,
    relations,
    asOf,
    ruleTag: isRule ? ruleTag : null,
    world,
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
  const entityRel = path.relative(DIR, graph.file).split(path.sep).join('/');

  // The graph entity is the record and is written. Mirror it into the host's auto memory as a
  // projection; a mirror fault is reported beside the verdict, never a reason to fail a real promotion.
  let mirror;
  try {
    mirror = writeAutoMemoryMirror({
      type, slug, claim: promoted.record.claim,
      verification: recordedVerification.note || (recordedVerification.evidencePaths || [])[0] || verifiedBy,
      entityRel, candidateId: id,
    });
  } catch (e) {
    mirror = { outcome: 'CANNOT_DETERMINE', detail: `the host auto-memory mirror could not be written: ${(e && e.code) || (e && e.message) || e}` };
  }

  // G7 · report the relations ACTUALLY on disk, not the flags typed this run. A repeat to an already
  // promoted entity keeps the file's existing relations (the idempotent read-back above), so returning
  // the flag-derived list would claim edges this run did not write. On a repeat the forward-reference
  // report is also dropped (no flags were applied) and a note says the flags were ignored.
  const result = {
    outcome: OUTCOME.PASS, status: promoted.status, id, entity: `${type}/${slug}`,
    file: entityRel,
    alreadyPromoted: promoted.status === 'ALREADY_VERIFIED',
    relations: graph.relations,
    // G8 · the binding ACTUALLY on disk (read back on a repeat), and why it is what it is.
    world: graph.world,
    worldNote: graph.world
      ? (defaultedWorld ? `bound to commit:${graph.world.value.slice(0, 7)} from the candidate's capture cycle (no --world given)` : null)
      : 'left unbound: no --world given and the candidate\'s capture cycle is not a commit sha',
    mirror,
  };
  if (promoted.status === 'ALREADY_VERIFIED') {
    if (relations.length) result.relationsIgnored = 'candidate already promoted — --relates/--supersedes were ignored and the entity\'s existing relations kept; edit the file to change them';
  } else if (relationNotes.length) {
    result.relationNotes = relationNotes;
  }

  /*
   * ⛔ G15 · THE RULES FILE IS WRITTEN AFTER THE ENTITY, so the confirmed line references a rule:<slug>
   * that genuinely exists. The bytes were decided pre-store (rulesPlan); a write runs only when the line
   * naming this slug is absent, so a repeat whose line is present is `rulesFileUnchanged` with no second
   * bump. A rules-file IO fault is NOT a PASS: the rule exists as an entity but is not yet an instruction
   * the skills load, so the promotion is CANNOT_DETERMINE naming the file, the cause and the exact command
   * to re-run. That retry finds the store ALREADY_VERIFIED, rewrites the same entity bytes, and writes the
   * line once with one bump, because the failed write changed nothing in the rules file.
   */
  if (isRule && rulesPlan) {
    result.ruleTag = ruleTag;
    if (rulesPlan.willWrite) {
      try {
        fs.mkdirSync(path.dirname(rulesPlan.targetAbs), { recursive: true });
        atomicWriteText(rulesPlan.targetAbs, rulesPlan.newText);
        result.rulesFile = rulesPlan.targetRel;
        result.ruleLine = rulesPlan.line;
        result.rulesVersion = { from: rulesPlan.oldVersion, to: rulesPlan.newVersion };
        if (rulesPlan.bootNote) result.rulesBootNote = rulesPlan.bootNote;
      } catch (e) {
        const opt = (f) => { const v = valueOf(f, null); return v ? ` ${f} ${cliArg(v)}` : ''; };
        const retry = `respawnpack memory candidates promote ${id} --as ${as} --verified-by ${cliArg(verifiedBy)} --by ${cliArg(by)}`
          + `${opt('--tag')}${opt('--rules-file')}${opt('--paths')}`;
        const cause = ioCause(e);
        result.outcome = OUTCOME.CANNOT_DETERMINE;
        result.rulesFile = rulesPlan.targetRel;
        result.rulesFileError = `the entity was written, but the rules file could not be: ${cause}`;
        result.retry = retry;
        result.error = `candidate ${id} is promoted and its entity \`${entityRel}\` is written, but the rules file \`${rulesPlan.targetRel}\` could not be written (${cause}), so rule:${slug} is NOT yet an instruction the skills load. The rules file is unchanged. Fix the cause, then re-run exactly: ${retry} (the retry writes the line once with one version bump).`;
      }
    } else {
      result.rulesFile = rulesPlan.targetRel;
      result.rulesFileUnchanged = true;
      result.rulesVersion = { from: rulesPlan.oldVersion, to: rulesPlan.oldVersion };
    }
  }
  return result;
}

/*
 * ⛔ G6 · THE GRAPH ENTITY A PROMOTION OF THIS CANDIDATE WROTE, LIVE AND RETRACTED TRACKED SEPARATELY.
 * A rejection of a verified candidate must not strand the entity it minted (the field saw cm_0dea19
 * rejected while `graph/gotcha/state-cmd-skips-renders.md` still cited it). This locates the entity by
 * `promotedFrom: <id>` the way findExistingPromotion does, but reports whether the hit is LIVE (under
 * memory/graph/<type>/) or already RETRACTED (under _retracted/), so the caller can refuse, retract, or
 * report a second retraction as a no-op.
 */
function findPromotedEntity(id) {
  const root = graphDir();
  if (!fs.existsSync(root)) return { live: null, retracted: null };
  const marker = `promotedFrom: ${id}`;
  let live = null, retracted = null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      let text = ''; try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (!text.includes(marker)) continue;
      const rel = removalsLib.posix(path.relative(DIR, p));
      if (/(^|\/)_retracted\//.test(rel)) { if (!retracted) retracted = rel; }
      else if (!live) live = rel;
    }
  };
  walk(root);
  return { live, retracted };
}

// G6 · lower-case, `/`→`:`, trailing separator stripped — the same collapse render.js's normalizeTargetId
// makes, so a dangling-relation report matches an entity id written in any of the schema's accepted forms.
const normalizeEntityId = (s) => String(s).trim().toLowerCase().replace(/\//g, ':').replace(/[:/]+$/, '');

/*
 * ⛔ G6 · A RETRACTION DOES NOT REACH INTO ANOTHER ENTITY'S FILE. An entity that other entities relate to
 * is retracted all the same; the relations that named it are REPORTED as dangling, never rewritten, so no
 * second file is mutated by one candidate's rejection. Read live entities only (a relation from an
 * already-retracted entity is not a live dangling edge).
 */
function relationsPointingAt(targetId) {
  const g = readGraphEntities();
  if (g.status !== 'OK') return [];
  const want = normalizeEntityId(targetId);
  const out = [];
  for (const e of g.entities) {
    if (/(^|\/)_retracted\//.test(e.file)) continue;
    if (normalizeEntityId(e.id) === want) continue;
    for (const rel of (e.relations || [])) {
      const dst = String(rel).split('|')[1];
      if (dst && normalizeEntityId(dst) === want) out.push({ from: e.id, relation: rel });
    }
  }
  return out;
}

// G6 · the three keys a retraction adds to the moved entity's frontmatter, inserted before the closing
// `---`; the body is left exactly as it was. A hand-authored entity with no frontmatter gains one.
function addRetractionFrontmatter(text, { retractedAt, retractedBy, retractedReason }) {
  const add = [`retractedAt: ${retractedAt}`, `retractedBy: ${yamlString(retractedBy)}`, `retractedReason: ${yamlString(retractedReason)}`];
  const fm = GRAPH_FRONTMATTER.exec(text);
  if (!fm) return `---\n${add.join('\n')}\n---\n\n${text}`;
  return `${text.slice(0, fm.index)}---\n${fm[1]}\n${add.join('\n')}\n---${text.slice(fm.index + fm[0].length)}`;
}

/*
 * ⛔ G6 · RETRACTION MOVES AND MARKS, IT NEVER DELETES (anti-drift: a removal is recorded, never erased).
 * The live entity is relocated to memory/graph/_retracted/<type>/<slug>.md with retractedAt/By/Reason
 * added to its frontmatter and the body untouched; the original is removed only AFTER the retracted copy
 * is on disk, so an interrupted move leaves the live entity intact rather than losing it. readGraphEntities
 * still READS _retracted/ (the ledger counts it); the register and D4's durable records skip it, because a
 * retracted lesson is exactly the thing a fresh lead may legitimately raise again.
 */
function retractGraphEntity(entityRel, { by, reason }) {
  const src = path.join(DIR, entityRel);
  let text;
  try { text = fs.readFileSync(src, 'utf8'); }
  catch (e) { return { outcome: 'CANNOT_DETERMINE', entity: entityRel, detail: `the entity file could not be read, so it was not retracted: ${(e && e.code) || e}` }; }
  const fm = GRAPH_FRONTMATTER.exec(text);
  const entityId = (fm && frontValue(fm[1], 'id')) || normalizeEntityId(entityRel.split('/').slice(2).join(':').replace(/\.md$/, ''));
  const dangling = relationsPointingAt(entityId);
  const tail = entityRel.split('/').slice(2);           // <type>/<slug>.md, below memory/graph/
  const destRel = `memory/graph/_retracted/${tail.join('/')}`;
  const dest = path.join(DIR, 'memory', 'graph', '_retracted', ...tail);
  const retractedAt = new Date().toISOString();
  const marked = addRetractionFrontmatter(text, { retractedAt, retractedBy: by, retractedReason: reason });
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, marked);                      // G6 retraction write site (schema.test WRITE_SITES)
  } catch (e) {
    return { outcome: 'CANNOT_DETERMINE', entity: entityRel, detail: `the retracted copy could not be written, so the live entity was left in place: ${(e && e.code) || e}` };
  }
  try { fs.rmSync(src, { force: true }); } catch { /* the retracted copy is written; a stray original is reported, never silently trusted */ }
  invalidateGraphSnapshot();
  return { outcome: 'RETRACTED', entity: entityRel, retractedTo: destRel, retractedAt, dangling };
}

function cmdMemoryCandidatesReject(id) {
  if (!id) return { outcome: OUTCOME.FAIL, error: 'reject requires a candidate id: memory candidates reject <id> --why "<reason>" [--by "<who>"] [--retract]' };
  const why = valueOf('--why', null);
  const by = valueOf('--by', null);
  const retract = flag('--retract');
  if (!why || !why.trim()) return { outcome: OUTCOME.FAIL, error: 'reject requires --why "<reason>" — an unexplained rejection cannot be reviewed' };
  // G6 · same author rule as promote: a verdict with no recorded author cannot be reviewed.
  if (!by || !by.trim()) return { outcome: OUTCOME.FAIL, error: 'reject requires --by "<who>" — the author of this verdict. A rejection with no recorded author cannot be reviewed.' };

  /*
   * ⛔ G6 · A REJECTION MUST NEVER LEAVE A VERIFIED CANDIDATE'S ENTITY LIVE WITHOUT SAYING SO. If this
   * candidate is still verified and its graph entity is live, the operator chooses: --retract moves the
   * entity under _retracted/, its absence REFUSES the whole rejection naming the file (the store is left
   * untouched, so a reviewer decides deliberately rather than silently stranding a withdrawn lesson). The
   * found entity is read BEFORE reject() changes the record's state.
   */
  const read = core.candidates.read(memoryStoreDir(), id);
  const wasVerified = read.status === 'OK' && read.record.verificationState === 'verified';
  const found = findPromotedEntity(id);
  if (wasVerified && found.live && !retract) {
    return {
      outcome: OUTCOME.FAIL, status: 'REFUSED', id, entity: found.live,
      error: `candidate ${id} is VERIFIED and its graph entity \`${found.live}\` is still live; rejecting it would leave the entity asserting a lesson the store has withdrawn — the exact defect this gate refuses. Re-run with --retract to move the entity under memory/graph/_retracted/ with the reason, or edit the entity file directly. Nothing was changed.`,
    };
  }

  /*
   * ⛔ G15 · A REJECTION THAT PROCEEDS WITHDRAWS THE RULE'S ACTIVE INSTRUCTION, FIRST. A `(rule:<slug>,
   * confirmed v<n>, <id>)` line naming this candidate is what the skills load as an instruction; leaving it
   * after the candidate is rejected (and its entity retracted) keeps the withdrawn rule in force and doctor
   * flags it as a forged confirmation. It is removed under the rules-file lock with one bump per changed
   * file and a text-free withdrawal record, BEFORE the entity moves or the store changes: a lock or write
   * failure here is reported with nothing changed anywhere, and the same command completes it. A repeat finds
   * no confirmed line and writes nothing, so a retry never adds a second record or a second bump.
   */
  let rulesWithdrawal = null;
  if (core && read.status === 'OK' && rulesFilesNameCandidate(id)) {
    const lk = acquireRulesLock('rejection');
    if (!lk.ok) return { outcome: OUTCOME.FAIL, status: 'RULES_LOCKED', id, error: `${lk.detail}. Re-run the same reject once the other writer has finished.` };
    try {
      const plan = planRulesWithdrawal(id, why);
      const retry = `respawnpack memory candidates reject ${id} --why ${cliArg(why)} --by ${cliArg(by)}${retract ? ' --retract' : ''}`;
      if (!plan.ok) {
        return { outcome: OUTCOME.CANNOT_DETERMINE, status: 'RULES_WITHDRAWAL_FAILED', id, rulesFile: plan.rel, retry,
          error: `candidate ${id} was NOT rejected: its confirmed rule line could not be withdrawn (${plan.error}), and rejecting it anyway would leave the rule an active instruction. Nothing was changed. Fix the cause, then re-run exactly: ${retry}` };
      }
      const done = [];
      for (const p of plan.plans) {
        try { atomicWriteText(p.abs, p.newText); }
        catch (e) {
          const cause = ioCause(e);
          return { outcome: OUTCOME.CANNOT_DETERMINE, status: 'RULES_WITHDRAWAL_FAILED', id, rulesFile: p.rel, retry, rulesWithdrawn: done,
            error: `candidate ${id} was NOT rejected: the rules file \`${p.rel}\` could not be written (${cause}), so rule:${p.slugs.join(', rule:')} is still an active instruction there. That file is unchanged${done.length ? ` (${done.map((d) => d.rulesFile).join(', ')} already withdrawn)` : ''}; the store and the entity were not touched. Fix the cause, then re-run exactly: ${retry}` };
        }
        done.push({ rulesFile: p.rel, slugs: p.slugs, rulesVersion: { from: p.oldVersion, to: p.newVersion }, records: p.records });
      }
      rulesWithdrawal = { outcome: 'WITHDRAWN', files: done };
      if (lk.reclaimedFrom) rulesWithdrawal.rulesLockReclaimed = lk.reclaimedFrom;
    } finally { releaseRulesLock(); }
  }

  /*
   * ⛔ G6 · WHEN RETRACTING A LIVE ENTITY, MOVE IT BEFORE THE STORE COMMITS THE REJECTION. The reject and
   * the entity move are not one transaction, so order decides which partial state a mid-operation IO
   * failure can leave. If the `_retracted/` write cannot land AFTER the record is already rejected, the
   * candidate would be rejected with its entity still live — the exact defect this gate forbids, and the
   * first draft returned PASS over it. So the move goes FIRST: a move that does not land REFUSES the whole
   * rejection as CANNOT_DETERMINE naming the entity and leaves the store untouched (nothing rejected),
   * never a silent success over a stranded entity.
   */
  let retraction = null;
  if (retract && wasVerified && found.live) {
    retraction = retractGraphEntity(found.live, { by, reason: why });
    if (retraction.outcome !== 'RETRACTED') {
      return {
        outcome: OUTCOME.CANNOT_DETERMINE, status: 'RETRACTION_FAILED', id, entity: found.live, retraction, ...(rulesWithdrawal ? { rulesWithdrawal } : {}),
        error: `candidate ${id} was NOT rejected: its live graph entity \`${found.live}\` could not be moved under memory/graph/_retracted/ (${retraction.detail || 'the retraction did not land'}). Rejecting it anyway would strand the entity asserting a withdrawn lesson, so ${rulesWithdrawal ? 'the store and the entity were not changed (its rule line was already withdrawn; the same command completes the rest)' : 'nothing was changed'}.`,
      };
    }
  }

  const r = core.candidates.reject(memoryStoreDir(), id, { by, reason: why });
  if (r.status === 'REFUSED' || r.status === 'CANNOT_DETERMINE') {
    return { outcome: r.status === 'CANNOT_DETERMINE' ? OUTCOME.CANNOT_DETERMINE : OUTCOME.FAIL, error: r.reason, status: r.status, retraction, ...(rulesWithdrawal ? { rulesWithdrawal } : {}) };
  }

  // G6 · the remaining --retract outcomes, none of which moved a live entity — reported NOT_APPLICABLE
  // with a reason, never an error: an entity already under _retracted/ is a no-op, a plain lead or a
  // verified-without-entity promotion has nothing to move, and a live entity whose record this call did
  // not transition from verified is not this rejection's to retract.
  if (retract && !retraction) {
    if (found.retracted && !found.live) retraction = { outcome: 'NOT_APPLICABLE', entity: found.retracted, detail: `the entity for ${id} is already retracted at \`${found.retracted}\` — nothing to move` };
    else if (!found.live && !found.retracted) retraction = { outcome: 'NOT_APPLICABLE', detail: `${id} has no promoted graph entity, so there is nothing to retract` };
    else retraction = { outcome: 'NOT_APPLICABLE', detail: `${id} was not verified by this rejection, so its entity (if any) is not this rejection's to retract` };
  }

  // The mirror follows the store: a rejection removes the host auto-memory projection if a prior
  // promotion wrote one (NOT_APPLICABLE when none exists). A retraction removes it through this same path.
  let mirror;
  try { mirror = removeAutoMemoryMirror(id); }
  catch (e) { mirror = { outcome: 'CANNOT_DETERMINE', detail: `the host auto-memory mirror could not be removed: ${(e && e.code) || (e && e.message) || e}` }; }
  return { outcome: OUTCOME.PASS, status: r.status, id, alreadyRejected: r.status === 'ALREADY_REJECTED', retraction, mirror, ...(rulesWithdrawal ? { rulesWithdrawal } : {}) };
}

const LEDGER_DAY_MS = 24 * 60 * 60 * 1000;
// G6 · the two config keys beside G7's staleHorizonDays. `staleOpenLeadSessions` is how old (in savepoint
// cycles the store has seen) an OPEN lead must be to count as stale; `staleOpenLeadFailAt` is how many
// such leads doctor tolerates before the row FAILs (below it the row PASSes with the count — a backlog is
// a count, neglect is a failure, and a default of 0 that FAILs on a single aged lead would train the
// operator to ignore the row, the trap G4 closed). Read through the same pinned config reader posture uses.
const LEDGER_DEFAULTS = { staleOpenLeadSessions: 3, staleOpenLeadFailAt: 10 };
function ledgerConfig() {
  const cfg = readJSON(path.join(DIR, 'respawnpack.config.json')) || {};
  const m = (cfg && cfg.memory) || {};
  const pick = (v, d) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  return {
    staleOpenLeadSessions: pick(m.staleOpenLeadSessions, LEDGER_DEFAULTS.staleOpenLeadSessions),
    staleOpenLeadFailAt: pick(m.staleOpenLeadFailAt, LEDGER_DEFAULTS.staleOpenLeadFailAt),
  };
}

const ledgerIsRetracted = (file) => /(^|\/)_retracted\//.test(String(file || ''));
const ledgerAuthored = (v) => typeof v === 'string' && v.trim().length > 0;

/*
 * ⛔ G6/G8 · A RECORD'S AGE IN SAVEPOINT CYCLES, CLOCK-FREE AGAINST THE STORE. The age of a cycle is the
 * number of distinct cycle ids whose EARLIEST capture time is newer than that cycle's own — so two runs
 * over the same store agree, never the wall clock. Extracted so the ledger's stale-open row and G8's
 * infra-reverify doctor row age a candidate the SAME way (decision 50), rather than two copies drifting.
 */
function cycleAgeMap(records) {
  const firstSeen = new Map();
  for (const rec of records) {
    const c = rec.provenance && rec.provenance.cycleId;
    const at = Date.parse((rec.provenance && rec.provenance.at) || '');
    if (!c || !Number.isFinite(at)) continue;
    if (!firstSeen.has(c) || at < firstSeen.get(c)) firstSeen.set(c, at);
  }
  const ageOfCycle = (cycleId) => {
    const t = firstSeen.get(cycleId);
    if (t === undefined) return 0;
    let newer = 0; for (const tt of firstSeen.values()) if (tt > t) newer++;
    return newer;
  };
  return { ageOfCycle, firstSeen };
}

/*
 * ⛔ G6 · THE CANDIDATE LEDGER, DERIVED FROM THE SAME TWO STORES THE REGISTER READS — ONE TRUST STORE, TWO
 * WRITE PATHS (the 2026-10-05 field report). Every count is recomputed from the candidate records and the graph
 * entities on each call, never cached and never stored, so the ledger cannot quietly go stale. The
 * anomalies are the gaps between the two paths the field measured: a verified candidate that promoted
 * nothing (verified-without-entity), an entity nobody promoted (entity-without-lineage, G7's unvouched
 * set), a verdict with no author (verdicts-without-author), an entity whose lineage names a candidate that
 * is not in the store (lineage-target-missing — a forged promotedFrom, which must NOT inflate the promoted
 * count), a retracted entity, and an open lead that has sat unreviewed across more savepoint cycles than
 * the project tolerates (open-older-than-sessions). A lead's age is counted in CYCLES the store has seen
 * since its own capture cycle, with the wall-clock days reported beside it: a date comparison against the
 * store, not the clock, so two runs over the same store agree.
 */
function ledgerReport() {
  const cands = readCandidateRecords();
  const graph = readGraphEntities();
  const cfg = ledgerConfig();
  const records = Array.isArray(cands.records) ? cands.records : [];
  const entities = graph.status === 'OK' ? graph.entities : [];
  const live = entities.filter((e) => !ledgerIsRetracted(e.file));

  const verified = records.filter((r) => r.verificationState === 'verified');
  const rejected = records.filter((r) => r.verificationState === 'rejected');
  const open = records.filter((r) => r.verificationState === 'candidate');

  const candIds = new Set(records.map((r) => r.id));
  const promotedFromSet = new Set(live.map((e) => e.promotedFrom).filter(Boolean));
  const promoted = live.filter((e) => e.promotedFrom && candIds.has(e.promotedFrom));
  const lineageTargetMissing = live.filter((e) => e.promotedFrom && !candIds.has(e.promotedFrom));
  const lineageless = live.filter((e) => !e.promotedFrom);
  const verifiedWithoutEntity = verified.filter((r) => !promotedFromSet.has(r.id));
  const retractedEntities = entities.filter((e) => ledgerIsRetracted(e.file));
  const verdictsWithoutAuthor = records.filter((r) => {
    if (r.verificationState === 'verified') return !(r.verification && ledgerAuthored(r.verification.by));
    if (r.verificationState === 'rejected') return !(r.rejection && ledgerAuthored(r.rejection.by));
    return false;
  });

  // Age in cycles: distinct savepoint cycle ids whose EARLIEST capture time is newer than this lead's own
  // cycle. The newest cycle's leads are age 0; a lead from the oldest cycle is as old as the store is deep.
  const { ageOfCycle } = cycleAgeMap(records);
  const now = Date.now();
  const ageCycles = (rec) => ageOfCycle(rec.provenance && rec.provenance.cycleId);
  const staleOpen = open
    .map((rec) => ({ id: rec.id, cycleId: rec.provenance && rec.provenance.cycleId, cycles: ageCycles(rec),
      days: Math.max(0, Math.floor((now - Date.parse((rec.provenance && rec.provenance.at) || '')) / LEDGER_DAY_MS)) }))
    .filter((x) => x.cycles > cfg.staleOpenLeadSessions)
    .sort((a, b) => b.cycles - a.cycles || b.days - a.days || String(a.id).localeCompare(String(b.id)));

  const CAP = render.GENERATED_ROW_CAP;
  const bound = (items) => ({ count: items.length, shown: items.slice(0, CAP), more: Math.max(0, items.length - CAP) });
  const anomalies = {
    'verified-without-entity': bound(verifiedWithoutEntity.map((r) => r.id)),
    'entity-without-lineage': bound(lineageless.map((e) => e.file)),
    'verdicts-without-author': bound(verdictsWithoutAuthor.map((r) => r.id)),
    'lineage-target-missing': bound(lineageTargetMissing.map((e) => e.file)),
    retracted: bound(retractedEntities.map((e) => e.file)),
    'open-older-than-sessions': bound(staleOpen),
  };
  const counts = {
    verified: verified.length, rejected: rejected.length, open: open.length, promoted: promoted.length,
    'verified-without-entity': verifiedWithoutEntity.length,
    'entity-without-lineage': lineageless.length,
    'verdicts-without-author': verdictsWithoutAuthor.length,
    'lineage-target-missing': lineageTargetMissing.length,
    retracted: retractedEntities.length,
    'open-older-than-sessions': staleOpen.length,
  };
  return {
    counts, anomalies,
    staleOpenLeadSessions: cfg.staleOpenLeadSessions, staleOpenLeadFailAt: cfg.staleOpenLeadFailAt,
    store: { candidates: cands.status, graph: graph.status, candidatesReason: cands.reason || null, graphReason: graph.reason || null },
  };
}

/*
 * ⛔ G6 · `memory candidates --ledger` — the review's first command. It prints the verified/rejected/open
 * counts and the promoted total, then one line per non-zero anomaly naming the ids or files it found,
 * bounded by B3's render cap with an exact "N more" line, so a hundred authorless verdicts do not flood
 * the screen and an operator still sees the exact total. It is a REPORT: PASS when the store could be
 * read, CANNOT_DETERMINE when the candidate store could not (a count nobody could establish is never a
 * pass). The headline counts never hide the open leads — the field saw "83 promoted + 28 rejected" hide
 * 18 open leads — so open and open-older-than-sessions are first-class counts here and in the register.
 */
function cmdMemoryCandidatesLedger() {
  if (!core) return { outcome: OUTCOME.CANNOT_DETERMINE, error: 'core/ (the host-neutral rollover core) could not be loaded, so no candidate ledger could be computed — run `doctor`.' };
  const ledger = ledgerReport();
  const outcome = ledger.store.candidates === 'UNREADABLE' ? OUTCOME.CANNOT_DETERMINE : OUTCOME.PASS;
  return { outcome, ledger };
}

/*
 * ============================================================================================
 * ⛔ G16 · THE INBOUND FEEDBACK CHANNEL. `feedback --export` packages a project's PACK-DIRECTED records
 * (its candidates, graph entities and decisions that name a pack identifier) without its operational
 * detail, behind a mechanical redaction fence and an owner PREVIEW; `memory candidates import <file>` is
 * the dev-side receiver that lands each exported record as a CANDIDATE — never a lesson, never a graph
 * entity — authored `import:<projectId>`, through the same audited gate every other lead travels. The
 * verb never pushes, never sends anything anywhere, and never reads the host's auto memory.
 * ============================================================================================
 */
const FEEDBACK_EXPORT_SCHEMA_VERSION = '1.0.0';
const FEEDBACK_ID_REL = path.join('.respawnpack', 'feedback-id');

// The pack-owned path prefixes a record may name to count as pack-directed. These ARE the pack's own
// layout, in both the source tree and an installed target, so they are a constant rather than derived.
const PACK_PATH_PREFIXES = [
  'hooks/', 'kernel/', 'install/', 'skills/', 'spine/', 'core/',
  '.claude/respawnpack/', '.claude/hooks/', '.claude/skills/', '.claude/rules/respawnpack/', '.respawnpack/',
];
/*
 * ⛔ ROUND 2 · THE ARTEFACTS THE PACK ITSELF WRITES INTO A PROJECT (not its source trees). The round-1
 * prefix list named only the pack's SOURCE layout, so the dev checkout's own records, whose claims and
 * rejections name the derived state the savepoint minted (`docs/derived/STATE.json` is the pack's single
 * most common finding; D4's rejections cite `docs/derived/state/goal.json`), were blocked by the fence as
 * non-pack filesystem paths, keeping the pack's own findings from leaving. These are the paths the pack
 * CREATES and NAMES inside any project, so a record naming one is pack-directed and the fence lets it pass.
 * Two shapes: a plain prefix (everything under it is a pack artefact), and a `bare` prefix whose tail must
 * carry no PROJECT SLUG, because a decision file's slug (`D-017-dominion-rename`) and a graph node's slug
 * (`gotcha/ashfall-compact`) ARE the project's own vocabulary; so only the bare prefix, a decision id, or
 * a `<type>/` segment is exempt. A drive-letter or rooted path stays blocked by blockedPath regardless.
 */
const PACK_ARTEFACT_PREFIXES = ['docs/derived/', 'memory/candidates/', 'memory/incidents/'];
const PACK_ARTEFACT_FILES = new Set(['docs/DECISIONS.md']);
const PACK_ARTEFACT_BARE = [
  // a decision shard path with no slug: `docs/decisions/`, or the bare id `docs/decisions/D-017[.md]`
  { prefix: 'docs/decisions/', tail: /^(?:[Dd]-\d+(?:\.md)?)?$/ },
  // a graph path: the bare prefix `memory/graph/` or a single `<type>/` segment, never a node slug
  { prefix: 'memory/graph/', tail: /^(?:[a-z][a-z-]*\/?)?$/ },
];
// The pack-artefact prefix (or exact file) a normalised path names, or null. Only the pack's OWN project
// artefacts, never its source trees (the existing substring rule in matchIdentifiers already covers those).
function packArtefactPrefix(norm) {
  for (const p of PACK_ARTEFACT_PREFIXES) if (norm.startsWith(p)) return p;
  if (PACK_ARTEFACT_FILES.has(norm)) return norm;
  for (const b of PACK_ARTEFACT_BARE) if (norm.startsWith(b.prefix) && b.tail.test(norm.slice(b.prefix.length))) return b.prefix;
  return null;
}
function isPackArtefactPath(norm) {
  return PACK_PATH_PREFIXES.some((p) => norm.startsWith(p)) || packArtefactPrefix(norm) !== null;
}
// The path-like tokens in a string, each with its normalised forward-slash form (a leading ./ or ../ and
// wrapping punctuation stripped). Shared by the fence (blockedPath) and the classifier (matchIdentifiers),
// so both judge a Windows-form path exactly as a forward-slash one.
const PATH_TOKEN_RE = /(?:\.{1,2}[\\/])?[^\s/\\]+[\\/][^\s]+/g;
function pathTokens(s) {
  const out = [];
  for (const m of String(s).matchAll(PATH_TOKEN_RE)) {
    const tok = m[0];
    const norm = tok.replace(/\\/g, '/').replace(/^[^A-Za-z0-9._]+/, '').replace(/^\.{1,2}\//, '').replace(/[)\]}>,.;:'"`]+$/, '');
    out.push({ tok, norm });
  }
  return out;
}
/*
 * ⛔ THE SOURCE OF A PACK REFERENCE IS VALIDATED BEFORE ANYTHING IS MINED FROM IT. Each word of a text
 * (split on whitespace, commas and semicolons) that carries a path separator, with wrapping punctuation
 * stripped and `\` normalised to `/`. A word that is ROOTED (a drive letter anywhere, a leading `/`, `\`
 * or `~`, a UNC `//`), climbs (`..`), or is a URL names a PRIVATE location: its tail is never a pack
 * reference, so `/home/<user>/acme/.respawnpack/runtime` cannot become an exportable
 * `.respawnpack/runtime` by stripping its prefix. Only a word that is WHOLLY a pack-relative path counts.
 */
function pathWords(s) {
  const out = [];
  for (const w of String(s == null ? '' : s).split(/[\s,;]+/)) {
    if (!w) continue;
    const norm = w.replace(/\\/g, '/').replace(/^[(\[{<'"`]+/, '').replace(/[)\]}>'"`.:]+$/, '');
    if (!norm.includes('/')) continue;
    out.push({ word: w, norm: norm.replace(/^\.\//, ''), rooted: isPrivateLocation(norm) });
  }
  return out;
}
function isPrivateLocation(norm) {
  return /^[/~]/.test(norm) || /^[A-Za-z]:/.test(norm) || /(?:^|[^A-Za-z0-9])[A-Za-z]:\//.test(norm)
    || /(?:^|\/)\.\.(?:\/|$)/.test(norm) || norm.includes('://');
}
// An evidence path is kept only when it is WHOLLY a pack file reference (anchored, not rooted, no `..`).
function isPackEvidencePath(p) {
  const t = String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return !!t && !isPrivateLocation(t) && PACK_FILE_ANCHORED.test(t);
}
const POSTURE_PROFILE_NAMES = ['strict', 'standard', 'light'];
// The install receipt's own keys (install.js's receipt literal). A record naming one of these is talking
// about what the installer placed. Static because install.js does not travel into a target to be read.
const RECEIPT_KEY_NAMES = [
  'schemaVersion', 'packVersion', 'adapters', 'settingsWiring', 'settingsHooks', 'settingsHooksFounder', 'settingsRetired',
  'kernelRetired', 'placed', 'permissionsDeny', 'claudeMdExcludes', 'worktreeSymlinkDirectories',
  'worktreeSparsePaths', 'lspRecommended', 'scopingPreview', 'scopingBlock',
];

/*
 * ⛔ THE NINE SECRET SHAPES hooks/secret-scan.js KNOWS, COPIED BYTE-FOR-BYTE. The kernel does not require
 * a hook module (secret-scan.js arms a deny guard at require time), so the fence is the kernel's own
 * table; kernel/kernel.test.mjs proves this list stays at least as strict as secret-scan.js's PATTERNS.
 */
const SECRET_SHAPES = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, name: 'private key' },
  { re: /\bsk_live_[0-9a-zA-Z]{16,}/, name: 'Stripe live secret key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS access key id' },
  { re: /\baws_secret_access_key\b\s*[:=]/i, name: 'AWS secret access key' },
  { re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/, name: 'GitHub token' },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/, name: 'Slack token' },
  { re: /\bAIza[0-9A-Za-z_\-]{30,}\b/, name: 'Google API key' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/, name: 'JWT' },
  { re: /(?:api[_-]?key|secret|password|passwd|token|client[_-]?secret)\s*[:=]\s*['"][^'"\n]{8,}['"]/i, name: 'generic secret assignment' },
];

// File-extension-looking final labels that are NOT a domain TLD, so `writing-standards.md` and
// `package.json` are not mistaken for hostnames by the domain shape below.
const DOMAIN_EXT_SKIP = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonl', 'md', 'markdown',
  'txt', 'yml', 'yaml', 'sh', 'bash', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'html', 'htm',
  'css', 'scss', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'lock', 'toml', 'ini', 'cfg', 'conf', 'log',
  'csv', 'tsv', 'xml', 'pdf', 'map', 'env', 'example', 'sample', 'base', 'snippet']);

/*
 * ⛔ MAJOR-2 · THE PACK'S OWN DOTTED CONFIG KEYS ARE NOT HOSTNAMES. A token like `state.reconcile` or
 * `state.removals.liveContentDirs` has the SHAPE of a domain, but its first label is a pack config head
 * and it ends in a pack field name, never a public suffix. A hostname that merely borrows a pack word as
 * its first label (`state.corp.example.net`) still ends in a public suffix and is a domain. These two
 * sets let the domain fence tell them apart without a dictionary.
 */
const PACK_DOTTED_HEADS = new Set([
  // the config top-level keys (schemas/project-config.schema.json) and the verbs that can head a key
  'respawnpack', 'installedat', 'upgradedat', 'routesource', 'opstargets', 'codetruth', 'extras', 'note',
  'qualitygate', 'state', 'posture', 'projecttype', 'providers', 'memory', 'exceptions',
  'savepoint', 'status', 'doctor', 'contract', 'gate', 'readiness', 'removals', 'lineage', 'aar',
  'living', 'reconcile', 'feedback', 'site', 'migrate',
]);
// Common public suffixes. The list need only be good enough to recognise a borrowed-head hostname; a pack
// config key never ends in one of these.
const PUBLIC_SUFFIXES = new Set([
  'com', 'net', 'org', 'io', 'dev', 'co', 'uk', 'us', 'edu', 'gov', 'mil', 'info', 'biz', 'app', 'ai',
  'cloud', 'me', 'tv', 'cn', 'jp', 'de', 'fr', 'eu', 'in', 'ca', 'au', 'nl', 'ru', 'it', 'es', 'xyz',
]);
// Pack-coined word identifiers that are NOT English words, so they may be named in plain prose and still
// count as a pack mention (MAJOR-1). Every other verb/config/profile word must appear in a command shape.
const PACK_COINED = new Set(['respawnpack', 'respawn', 'savepoint', 'aar']);

// A run of 20+ token characters, containing at least one digit, spanning at least two character classes,
// with Shannon entropy at or above HIGH_ENTROPY_BITS bits per character. The digit and the class-span
// requirements keep long English words and camelCase identifiers out of the net; the threshold is stated
// so a later change to it is a deliberate one, not a drift.
const HIGH_ENTROPY_BITS = 3.0;
function shannonBits(str) {
  const freq = Object.create(null);
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let h = 0; const n = str.length;
  for (const k in freq) { const p = freq[k] / n; h -= p * Math.log2(p); }
  return h;
}
function charClassCount(str) {
  let c = 0;
  if (/[a-z]/.test(str)) c++;
  if (/[A-Z]/.test(str)) c++;
  if (/[0-9]/.test(str)) c++;
  if (/[^A-Za-z0-9]/.test(str)) c++;
  return c;
}
// The pack's own high-entropy shapes are not leaked secrets: a hex digest (12-64 chars), a candidate id
// (cm_ + 16 hex), an incident id (inc_ + 16 hex), a date-stamped doc name (SITE-NOTES-2026-10-05) or a
// date / the head of an ISO timestamp. Each is named here so the fence does not block the pack's vocabulary.
function isPackTokenShape(t) {
  return /^[0-9a-fA-F]{12,64}$/.test(t)
    || /^cm_[0-9a-f]{16}$/i.test(t)
    || /^inc_[0-9a-f]{16}$/i.test(t)
    || /^[A-Z][A-Z-]*-\d{4}-\d{2}-\d{2}$/.test(t)
    || /^\d{4}-\d{2}-\d{2}(?:T\d{2})?$/.test(t);
}
function highEntropyToken(s) {
  // Strip pack paths and file:line references first (they are pack vocabulary, never a secret), then judge
  // the remainder, exempting the pack's own high-entropy token shapes one by one (MAJOR-2).
  const stripped = String(s).replace(PACK_FILE_RE, ' ').replace(/\S+:\d+(?:-\d+)?/g, ' ');
  for (const m of stripped.matchAll(/[A-Za-z0-9+=_-]{20,}/g)) {
    const t = m[0];
    if (!/[0-9]/.test(t)) continue;
    if (charClassCount(t) < 2) continue;
    if (isPackTokenShape(t)) continue;
    if (shannonBits(t) >= HIGH_ENTROPY_BITS) return t;
  }
  return null;
}
// A filesystem path that is NOT under a pack prefix: a drive letter, a backslash-separated path, or a
// forward-slash path with an internal separator whose first component is not a pack prefix. A bare
// slash-command (`/wordsmith`, no internal separator) is deliberately NOT a path.
function blockedPath(s) {
  let m = /\b[A-Za-z]:[\\/][^\s]*/.exec(s); if (m) return m[0];      // C:\... or C:/... (a rooted drive path)
  // A rooted POSIX path (/etc/x, or /docs/derived/x) is an absolute project/system path, not a pack-relative
  // artefact, so it stays blocked whatever follows (round 2); a bare slash-command (/wordsmith) has no
  // internal separator and is not a path.
  m = /(?:^|\s)(\/[^\s/\\]+[\\/][^\s]+)/.exec(s); if (m) return m[1].replace(/[)\]}>,.;:'"`]+$/, '');
  // A relative backslash OR forward-slash path, judged by ONE rule: normalise `\` to `/`, strip wrapping
  // punctuation, then exempt anything that names a pack artefact (a source tree, or a file the pack itself
  // writes into a project: docs/derived/, the decision shard, memory/candidates|graph|incidents). The
  // backslash and forward-slash forms are judged alike (MINOR-4), so a Windows-form pack path passes too.
  for (const { tok, norm } of pathTokens(s)) {
    if (isPackArtefactPath(norm)) continue; // a pack file:line or a pack artefact is allowed
    return tok;
  }
  return null;
}
function blockedDomain(s) {
  for (const m of String(s).matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,})\b/gi)) {
    const full = m[0];
    const tld = m[1].toLowerCase();
    if (DOMAIN_EXT_SKIP.has(tld)) continue;              // a filename like foo.md or pkg.json
    if (/^\d+(?:\.\d+)+$/.test(full)) continue;          // a version number
    // A dotted PACK config key or file name (state.reconcile, state.removals.liveContentDirs) begins with
    // a pack head and does NOT end in a public suffix; a hostname that merely borrows a pack word as its
    // first label (state.corp.example.net) still ends in a public suffix and is a domain (MAJOR-2).
    const head = full.split('.')[0].toLowerCase();
    if (PACK_DOTTED_HEADS.has(head) && !PUBLIC_SUFFIXES.has(tld)) continue;
    return full;
  }
  return null;
}

/*
 * ⛔ THE REDACTION FENCE. A free-text field is REFUSED when it contains a non-pack filesystem path, an
 * IPv4 or IPv6 shape, a hostname or domain shape, an email, a URL, a high-entropy token, or any of the
 * nine secret-scan shapes. Returns the FIRST shape found and the matched text; the caller quotes nothing
 * of a blocked value beyond its first three characters. The fence catches SHAPES, not meaning: a secret
 * written as prose passes, which is why the owner preview is the last sight of what leaves.
 */
function redactionFence(text) {
  const s = String(text == null ? '' : text);
  for (const p of SECRET_SHAPES) { const m = p.re.exec(s); if (m) return { blocked: true, kind: `secret (${p.name})`, at: m[0] }; }
  let m = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.exec(s); if (m) return { blocked: true, kind: 'email', at: m[0] };
  m = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i.exec(s); if (m) return { blocked: true, kind: 'URL', at: m[0] };
  m = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(s); if (m) return { blocked: true, kind: 'IPv4', at: m[0] };
  m = /(?:[0-9A-Fa-f]{1,4}:){3,}[0-9A-Fa-f]{0,4}|[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{1,4}){3,}/.exec(s); if (m) return { blocked: true, kind: 'IPv6', at: m[0] };
  // a COMPRESSED IPv6 address (`::1`, `fe80::1`, `2001:db8::1`, `[::1]:8080`): a `::` run with at least one
  // hex group beside it, not glued to a word (so `Foo::Bar` and `std::vector` are not addresses)
  for (const mm of s.matchAll(/(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?(?![0-9A-Za-z:])/g)) {
    if (mm[0] !== '::') return { blocked: true, kind: 'IPv6', at: mm[0] };
  }
  const pb = blockedPath(s); if (pb) return { blocked: true, kind: 'non-pack path', at: pb };
  const db = blockedDomain(s); if (db) return { blocked: true, kind: 'hostname/domain', at: db };
  const he = highEntropyToken(s); if (he) return { blocked: true, kind: 'high-entropy token', at: he };
  return { blocked: false };
}

/*
 * ⛔ ROUND 2 · THE SAVEPOINT'S OWN CHECK IDS, READ FROM THE CODE (never a hand list). A savepoint finding
 * leads with the id of the check that minted it (`state-writeback: docs\derived\STATE.json ...`), so the
 * id itself is a pack identifier. The kernel and its lib modules emit every check as `result(OUTCOME.X,
 * '<id>', ...)` or `result(OUTCOME.X, \`<id>:${...}\`, ...)`, so this scan recovers the base ids (the
 * dynamic `:<file>` tail is dropped). Cached: the export/import path is the only caller, and the sources
 * do not change within a process. A missing file degrades to the ids recovered from the files that read.
 */
let CHECK_IDS_CACHE = null;
function collectCheckIds() {
  if (CHECK_IDS_CACHE) return CHECK_IDS_CACHE;
  const ids = new Set();
  const re = /result\(\s*OUTCOME\.[A-Z_]+\s*,\s*['"`]([a-z][a-z0-9-]*(?::[a-z0-9-]+)*)/g;
  const files = [__filename];
  try { const libDir = path.join(__dirname, 'lib'); for (const f of fs.readdirSync(libDir)) if (f.endsWith('.js')) files.push(path.join(libDir, f)); } catch { /* lib/ absent on a stripped install */ }
  for (const f of files) {
    try { const src = fs.readFileSync(f, 'utf8'); for (const mm of src.matchAll(re)) ids.add(mm[1]); } catch { /* unreadable file contributes nothing */ }
  }
  CHECK_IDS_CACHE = ids;
  return ids;
}

/*
 * ⛔ THE PACK-IDENTIFIER MANIFEST, BUILT AT RUN TIME AND CATEGORISED. Each category carries its own
 * matching rule in matchIdentifiers because what counts as "naming the pack" differs by shape: a pack
 * path or a `family:member` doctor row is never a word, but a verb or a config key often IS an English
 * word (`state`, `contract`, `memory`, `gate`, `site`), so one that is a word is matched only in a
 * COMMAND SHAPE, never as bare prose (MAJOR-1). The verb keys, the installed hook basenames (the target's
 * `.claude/hooks/*.js` and the kernel's own sibling hooks dir), the `family:member` doctor rows, the pack
 * path prefixes, the receipt keys, the posture profiles, the config keys (the target's own plus the
 * schema's when readable), and the savepoint's own check ids (round 2).
 */
function packManifest() {
  const m = {
    verbs: new Set(), hooks: new Set(), doctorRows: new Set(), pathPrefixes: [...PACK_PATH_PREFIXES],
    receiptKeys: new Set(RECEIPT_KEY_NAMES), profiles: new Set(POSTURE_PROFILE_NAMES),
    configKeys: new Set(), coined: new Set(PACK_COINED), checkIds: new Set(collectCheckIds()),
  };
  for (const v of Object.keys(VERBS)) {
    m.verbs.add(v);
    // a verb that is not a plain English word (a hyphenated or coined one) may be named in plain prose
    if (/[-_0-9A-Z]/.test(v) || PACK_COINED.has(v)) m.coined.add(v);
  }
  for (const hd of [path.join(DIR, '.claude', 'hooks'), path.join(__dirname, '..', 'hooks')]) {
    try { for (const f of fs.readdirSync(hd)) if (f.endsWith('.js')) m.hooks.add(f.replace(/\.js$/, '')); } catch { /* absent layout */ }
  }
  // only doctor rows in `family:member` form (they carry a `:`, so they never appear in prose by accident)
  for (const k of [...Object.keys(DOCTOR_SUBJECT), ...Object.keys(DOCTOR_DOMAIN)]) if (k.includes(':')) m.doctorRows.add(k);
  const add1 = (v) => { const sv = String(v == null ? '' : v).trim(); if (sv) m.configKeys.add(sv); };
  const cfg = readJSON(path.join(DIR, 'respawnpack.config.json')) || {};
  for (const k of Object.keys(cfg)) add1(k);
  try {
    const sch = readJSON(path.join(__dirname, '..', 'schemas', 'project-config.schema.json'));
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.properties) for (const k of Object.keys(node.properties)) { add1(k); walk(node.properties[k]); }
      for (const key of ['items', 'additionalProperties']) { const c = node[key]; if (c && typeof c === 'object') walk(c); }
      for (const key of ['oneOf', 'anyOf', 'allOf']) { if (Array.isArray(node[key])) node[key].forEach(walk); }
    };
    if (sch) walk(sch);
  } catch { /* schemas/ is not installed on a target; the target's own config keys still contribute */ }
  return m;
}

const reEsc = (id) => String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/*
 * The pack identifiers a set of texts NAMES, each category by its own rule (MAJOR-1):
 *  - a pack path prefix: a substring anywhere (it is never a word);
 *  - a `family:member` doctor row: its literal form anywhere (it carries a `:`);
 *  - a coined word (respawnpack, savepoint, aar, a hyphenated verb): a token anywhere;
 *  - a verb that is an English word: only in a COMMAND shape — after `respawnpack`/`respawnpack.js`, as
 *    the first word of a `--flag` sequence (`savepoint --verify`), or inside backticks;
 *  - a config key: only in its dotted form (`memory.staleHorizonDays`) or inside backticks;
 *  - a posture profile: only beside `posture` or inside backticks;
 *  - a receipt key: only inside backticks;
 *  - a pack artefact path (docs/derived/, the decision shard, memory/candidates|graph|incidents): a path
 *    token that isPackArtefactPath, so a record naming only the derived state the pack minted is pack-
 *    directed (round 2);
 *  - a savepoint check id: in its `id:` shape at a finding's head (`state-writeback:`) when the id is not a
 *    bare English word (it carries a hyphen or colon), or inside backticks for any id (round 2).
 * So a knowledge project's canon prose ("the state of the border", "a memory of the old capital") names
 * no pack identifier, while the pack's own findings still do. The owner preview is the backstop either way.
 */
function matchIdentifiers(texts, m) {
  const hay = (texts || []).filter(Boolean).join('\n');
  if (!hay) return [];
  const matched = new Set();
  const haySlash = hay.replace(/\\/g, '/'); // a pack path in Windows form (kernel\...) is still a pack path
  const backticks = [...hay.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  const wb = (id, s) => new RegExp(`(?<![A-Za-z0-9_])${reEsc(id)}(?![A-Za-z0-9_])`).test(s);
  const inBacktick = (id) => backticks.some((sp) => wb(id, sp));
  // a path counts only when the WHOLE word is pack-relative: a rooted or climbing word is a private
  // location, so its tail never makes a record pack-directed
  for (const { norm, rooted } of pathWords(haySlash)) {
    if (rooted) continue;
    for (const p of m.pathPrefixes) if (norm.startsWith(p)) matched.add(p);
    const pre = packArtefactPrefix(norm); if (pre) matched.add(pre);
  }
  for (const id of m.checkIds || []) {
    // a hyphen/colon check id may head a finding as `id:`; a bare-word id matches only inside backticks
    const idColon = /[-:]/.test(id) && new RegExp(`(?<![A-Za-z0-9_])${reEsc(id)}:`).test(hay);
    if (idColon || inBacktick(id)) matched.add(id);
  }
  for (const d of m.doctorRows) if (wb(d, hay)) matched.add(d);
  for (const c of m.coined) if (wb(c, hay)) matched.add(c);
  for (const v of m.verbs) {
    if (m.coined.has(v)) continue; // a coined verb already matched anywhere above
    const e = reEsc(v);
    const afterCli = new RegExp(`(?<![A-Za-z0-9_])respawnpack(?:\\.js)?\\s+${e}(?![A-Za-z0-9_])`).test(hay);
    const flagHead = new RegExp(`(?<![A-Za-z0-9_])${e}\\s+--[A-Za-z]`).test(hay);
    if (afterCli || flagHead || inBacktick(v)) matched.add(v);
  }
  for (const k of m.configKeys) {
    const e = reEsc(k);
    const dotted = new RegExp(`(?<![A-Za-z0-9_])${e}(?=\\.[A-Za-z])|(?<=[A-Za-z0-9_]\\.)${e}(?![A-Za-z0-9_])`).test(hay);
    if (dotted || inBacktick(k)) matched.add(k);
  }
  for (const pr of m.profiles) {
    const e = reEsc(pr);
    const besidePosture = new RegExp(`posture[^A-Za-z0-9]{0,4}${e}(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])${e}[^A-Za-z0-9]{0,4}posture`, 'i').test(hay);
    if (besidePosture || inBacktick(pr)) matched.add(pr);
  }
  for (const rk of m.receiptKeys) if (inBacktick(rk)) matched.add(rk);
  return [...matched].sort();
}

// The mechanical evidence tokens found in a record's text: a pack file:line, an exit code, and the
// matched word-ish manifest identifiers. Everything else is dropped (counted separately from evidencePaths).
const PACK_FILE_RE = /(?:hooks|kernel|install|skills|spine|core)\/[A-Za-z0-9_.\/-]+(?::\d+(?:-\d+)?)?|\.claude\/(?:respawnpack|hooks|skills|rules)\/[A-Za-z0-9_.\/-]+|\.respawnpack\/[A-Za-z0-9_.\/-]+/g;
// ⛔ A pack file reference is taken only from a word that is WHOLLY a pack-relative path (pathWords), and
// an evidence path only when it is one in full (isPackEvidencePath), so no private prefix is ever stripped
// off to leave an exportable tail.
function mechanicalEvidence(record, identifiers) {
  const tokens = new Set();
  for (const text of [record.claim, record.rejectionReason, record.observation]) {
    if (!text) continue;
    for (const { norm, rooted } of pathWords(text)) if (!rooted && PACK_FILE_ANCHORED.test(norm)) tokens.add(norm);
    for (const m of String(text).matchAll(/\bexit(?: code)? [012]\b/gi)) tokens.add(m[0].toLowerCase());
  }
  for (const p of record.evidencePaths || []) {
    if (isPackEvidencePath(p)) tokens.add(String(p).trim().replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  for (const id of identifiers) if (!id.includes('/')) tokens.add(id);
  return [...tokens].sort();
}

// The allowed MECHANICAL evidence token shapes — the only strings `evidence` may carry (MAJOR-3). Both the
// exporter's mechanicalEvidence() and the importer's fence recognise exactly this set, so a round-trip
// cannot smuggle a hostname, a project path or a secret through the evidence array. A token is mechanical
// when it is a pack file:line/path, an exit code, a hex digest, a candidate/incident id, or a word-ish
// identifier that is actually in the manifest (a verb, a hook, a `family:member` doctor row, a posture, a
// config key, a receipt key, a coined word, or a savepoint check id (round 2, so a check id the exporter
// may emit as an identifier round-trips).
const PACK_FILE_ANCHORED = /^(?:(?:hooks|kernel|install|skills|spine|core)\/[A-Za-z0-9_.\/-]+(?::\d+(?:-\d+)?)?|\.claude\/(?:respawnpack|hooks|skills|rules)\/[A-Za-z0-9_.\/-]+|\.respawnpack\/[A-Za-z0-9_.\/-]+)$/;
function isMechanicalEvidenceToken(tok, m) {
  const t = String(tok == null ? '' : tok).trim();
  if (!t) return false;
  if (PACK_FILE_ANCHORED.test(t)) return !isPrivateLocation(t);
  if (/^exit(?: code)? [0-9]+$/i.test(t)) return true;
  if (/^[0-9a-fA-F]{12,64}$/.test(t)) return true;
  if (/^cm_[0-9a-f]{16}$/i.test(t) || /^inc_[0-9a-f]{16}$/i.test(t)) return true;
  return m.verbs.has(t) || m.hooks.has(t) || m.doctorRows.has(t) || m.configKeys.has(t)
    || m.profiles.has(t) || m.receiptKeys.has(t) || m.coined.has(t) || (m.checkIds && m.checkIds.has(t));
}

// The machine author CLASS of a verdict, never a person's name: savepoint | operator | closeout |
// adapter | import, else `other`.
const MACHINE_AUTHOR_CLASSES = new Set(['savepoint', 'operator', 'closeout', 'adapter', 'import']);
function capturedByClass(by) {
  const b = String(by == null ? '' : by).trim();
  if (!b) return 'other';
  if (b.startsWith('import:')) return 'import';
  return MACHINE_AUTHOR_CLASSES.has(b) ? b : 'other';
}

/* The three classified record sources the kernel already reads, flattened to one common shape. */
function gatherFeedbackSources() {
  const out = [];
  const cands = readCandidateRecords();
  for (const r of (cands.records || [])) {
    out.push({
      kind: 'candidate', sourceId: r.id, klass: r.klass, verificationState: r.verificationState,
      claimRaw: r.claim || null, rejectionReasonRaw: (r.rejection && r.rejection.reason) || null,
      observationRaw: null, retracted: null,
      evidencePaths: (r.provenance && r.provenance.evidencePaths) || [],
      by: (r.provenance && r.provenance.by) || null, at: (r.provenance && r.provenance.at) || null, slug: null, aliases: [],
    });
  }
  const graph = readGraphEntities();
  for (const e of (graph.status === 'OK' ? graph.entities : [])) {
    out.push({
      kind: 'entity', sourceId: e.id, klass: null, verificationState: null,
      claimRaw: null, rejectionReasonRaw: null, observationRaw: e.observation || null,
      retracted: /(^|\/)_retracted\//.test(String(e.file || '')), evidencePaths: [],
      by: null, at: e.promotedAt || e.asOf || null,
      slug: String(e.id || '').split(':').slice(1).join(':') || e.id, aliases: e.aliases || [],
    });
  }
  for (const d of readDecisionTitles(DIR)) {
    out.push({
      kind: 'decision', sourceId: d.id, klass: null, verificationState: null,
      claimRaw: d.title || null, rejectionReasonRaw: null, observationRaw: null, retracted: null,
      evidencePaths: [], by: null, at: null, slug: null, aliases: [],
    });
  }
  return out;
}

/* Classify one source record as pack-directed, reduce it to the allow-listed schema, and fence it. */
function classifyAndReduce(src, manifest) {
  // an evidence path that is not wholly a pack-relative path (a rooted, climbing or project path) is
  // dropped BEFORE classification, so it can neither make the record pack-directed nor seed evidence
  const evidencePaths = (src.evidencePaths || []).filter((p) => isPackEvidencePath(p));
  const dropped = (src.evidencePaths || []).filter((p) => String(p).trim() && !isPackEvidencePath(p)).length;
  const searchTexts = [src.claimRaw, src.rejectionReasonRaw, src.observationRaw, src.sourceId, src.slug,
    ...(src.aliases || []), ...evidencePaths].filter(Boolean);
  const identifiers = matchIdentifiers(searchTexts, manifest);
  const first = (s) => (s ? core.candidates.firstSentence(s) : null);
  const claim = first(src.claimRaw);
  const rejectionReason = first(src.rejectionReasonRaw);
  const observation = first(src.observationRaw);
  const evidence = mechanicalEvidence({ claim: src.claimRaw, rejectionReason: src.rejectionReasonRaw, observation: src.observationRaw, evidencePaths }, identifiers);
  const record = {
    kind: src.kind,
    sourceId: src.sourceId,
    klass: src.kind === 'candidate' ? src.klass : null,
    verificationState: src.kind === 'candidate' ? src.verificationState : null,
    identifiers,
    claim,
    rejectionReason,
    observation,
    retracted: src.kind === 'entity' ? !!src.retracted : null,
    evidence,
    capturedBy: capturedByClass(src.by),
    at: src.at ? String(src.at).slice(0, 10) : null,
  };
  return { packDirected: identifiers.length > 0, record, fenceHits: fenceRecordFields(record), dropped };
}

// ⛔ EVERY FIELD A FEEDBACK RECORD SERIALIZES PASSES THE FENCE, not only its free text: the ids, the
// class words, the date, each identifier and each evidence token. The exporter and the importer share
// this one function, so a field the package carries cannot be left out of the policy on either side.
const FENCED_SCALAR_FIELDS = ['kind', 'sourceId', 'klass', 'verificationState', 'claim', 'rejectionReason', 'observation', 'capturedBy', 'at'];
function fenceRecordFields(rec) {
  const hits = [];
  const one = (field, val) => {
    if (typeof val !== 'string' || !val) return;
    const f = redactionFence(val);
    if (f.blocked) hits.push({ field, kind: f.kind, prefix: String(f.at).slice(0, 3) });
  };
  for (const field of FENCED_SCALAR_FIELDS) one(field, rec[field]);
  for (const id of (Array.isArray(rec.identifiers) ? rec.identifiers : [])) one('identifiers', id);
  for (const ev of (Array.isArray(rec.evidence) ? rec.evidence : [])) one('evidence', ev);
  return hits;
}

// The machine-local export id: sixteen random bytes as hex, minted once at the first export into
// .respawnpack/feedback-id (gitignored like the receipt). Every export from one INSTALL carries the same
// id; a clone mints its own. `read` never writes (so a preview stays read-only); `mint` writes atomically.
function readFeedbackProjectId() {
  try { const t = fs.readFileSync(path.join(DIR, FEEDBACK_ID_REL), 'utf8').trim(); return /^[0-9a-f]{32}$/.test(t) ? t : null; }
  catch { return null; }
}
function mintFeedbackProjectId() {
  const id = crypto.randomBytes(16).toString('hex');
  const abs = path.join(DIR, FEEDBACK_ID_REL);
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); stateLib.writeAtomic(abs, `${id}\n`); }
  catch { /* machine-local: an id we could not persist is simply re-minted on the next export */ }
  return id;
}

function cmdFeedback() {
  if (!core) return { outcome: OUTCOME.CANNOT_DETERMINE, error: 'core/ (the host-neutral rollover core) could not be loaded, so no feedback export could be built — run `doctor`.' };
  if (!flag('--export')) {
    return { outcome: OUTCOME.FAIL, error: 'feedback has one subcommand: `feedback --export [--out <path>] [--drop <sourceId>]`. It packages this project\'s pack-directed records without its operational detail and PREVIEWS what would leave; it never sends anything anywhere.' };
  }
  const manifest = packManifest();
  const sources = gatherFeedbackSources();
  const dropSet = new Set(allValuesOf('--drop'));

  const included = [], excluded = [], blocked = [];
  let fieldsDropped = 0;
  for (const s of sources) {
    const c = classifyAndReduce(s, manifest);
    if (!c.packDirected) { excluded.push({ sourceId: s.sourceId, kind: s.kind, reason: 'not pack-directed — its claim, evidence, rejection reason, id/slug and observation name no pack identifier' }); continue; }
    if (dropSet.has(s.sourceId)) { excluded.push({ sourceId: s.sourceId, kind: s.kind, reason: 'dropped by --drop' }); continue; }
    if (c.fenceHits.length) { blocked.push({ sourceId: s.sourceId, kind: s.kind, fields: c.fenceHits }); continue; }
    included.push(c.record);
    fieldsDropped += c.dropped;
  }

  const receipt = readJSON(path.join(DIR, '.respawnpack', 'install-receipt.json')) || {};
  const packVersion = (typeof receipt.packVersion === 'string' && receipt.packVersion.trim()) ? receipt.packVersion : null;
  const receiptSchemaVersion = Number.isFinite(receipt.schemaVersion) ? receipt.schemaVersion : null;
  const cfg = readJSON(path.join(DIR, 'respawnpack.config.json')) || {};
  const projectType = (typeof cfg.projectType === 'string' && cfg.projectType) ? cfg.projectType : null;
  const pol = posturePolicy();
  const posture = pol && pol.profile ? pol.profile : null;

  const writeRequested = flag('--out');
  const outArg = valueOf('--out', null);
  const outPathGiven = outArg && !outArg.startsWith('--') ? outArg : null;

  const counts = { considered: sources.length, included: included.length, excluded: sources.length - included.length, fieldsDropped };

  if (!writeRequested) {
    const projectId = readFeedbackProjectId();
    const provenance = { packVersion, receiptSchemaVersion, projectType, posture, projectId, exportedAt: new Date().toISOString() };
    return {
      outcome: OUTCOME.PASS, mode: 'preview', provenance, counts, included, excluded, blocked,
      importsAs: packVersion ? 'verifiable' : 'CANNOT_DETERMINE',
      note: `PREVIEW only — nothing written. Pass --out <path> to write the package (default .respawnpack/runtime/feedback-export-<date>.json).`
        + `${projectId ? '' : ' A projectId will be minted into .respawnpack/feedback-id on the first --out export.'}`
        + `${packVersion ? '' : ' The install receipt carries no packVersion, so the receiver will read this export as CANNOT_DETERMINE until this target is upgraded.'}`
        + `${blocked.length ? ` ${blocked.length} pack-directed record(s) have a field the redaction fence blocked; --out will REFUSE until each is --drop'd or its source record edited.` : ''}`,
    };
  }

  if (blocked.length) {
    return {
      outcome: OUTCOME.FAIL, mode: 'export',
      error: `the redaction fence blocked a field in ${blocked.length} pack-directed record(s); nothing was written. Pass --drop <sourceId> for each, or edit the source record, then re-run. Blocked: `
        + blocked.map((b) => `${b.sourceId} (${b.fields.map((f) => `${f.field}: ${f.kind} "${f.prefix}…"`).join('; ')})`).join(', '),
      counts, included, excluded, blocked,
    };
  }

  let projectId = readFeedbackProjectId();
  if (!projectId) projectId = mintFeedbackProjectId();
  const provenance = { packVersion, receiptSchemaVersion, projectType, posture, projectId, exportedAt: new Date().toISOString() };
  const pkg = { schemaVersion: FEEDBACK_EXPORT_SCHEMA_VERSION, kind: 'feedback-export', provenance, counts, records: included };
  const dateStr = provenance.exportedAt.slice(0, 10);
  const outRel = outPathGiven || path.join('.respawnpack', 'runtime', `feedback-export-${dateStr}.json`);
  const outAbs = path.isAbsolute(outRel) ? outRel : path.join(DIR, outRel);
  try { fs.mkdirSync(path.dirname(outAbs), { recursive: true }); } catch { /* best effort; writeAtomic reports a real failure */ }
  const packageText = `${JSON.stringify(pkg, null, 2)}\n`;
  stateLib.writeAtomic(outAbs, packageText);
  return { outcome: OUTCOME.PASS, mode: 'export', wrote: outAbs, provenance, counts, included, excluded, blocked: [] };
}

// The releases this receiving checkout can match a packVersion against: its own VERSION, and every
// `## [x.y.z]` heading in its CHANGELOG.md. A checkout with neither cannot verify a version at all.
function knownReleases() {
  const rels = new Set();
  const v = readText(path.join(DIR, 'VERSION'));
  if (v && v.trim()) rels.add(v.trim());
  const cl = readText(path.join(DIR, 'CHANGELOG.md'));
  if (cl) for (const m of cl.matchAll(/^##\s*\[(\d+\.\d+\.\d+)\]/gm)) rels.add(m[1]);
  return rels;
}
// The receiving checkout's current source revision, resolved the way the savepoint resolves it, with the
// same `no-revision` fallback — so an imported lead's cycleId ages in the ledger like any captured one.
function receivingRevision() {
  try { const r = manifestLib.sourceRevisions(DIR); const vv = r && (r.effective || r.head); if (vv) return String(vv); }
  catch { /* not a repo, or git unavailable */ }
  return 'no-revision';
}

function feedbackPackageShapeError(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return 'not a JSON object';
  if (pkg.schemaVersion !== FEEDBACK_EXPORT_SCHEMA_VERSION) return `schemaVersion ${JSON.stringify(pkg.schemaVersion)}, expected ${FEEDBACK_EXPORT_SCHEMA_VERSION}`;
  if (pkg.kind !== 'feedback-export') return `kind ${JSON.stringify(pkg.kind)}, expected feedback-export`;
  if (!Array.isArray(pkg.records)) return 'records is not an array';
  for (const rec of pkg.records) {
    if (!rec || typeof rec !== 'object') return 'a record is not an object';
    if (!['candidate', 'entity', 'decision'].includes(rec.kind)) return `a record has kind ${JSON.stringify(rec.kind)}, not candidate|entity|decision`;
    if (typeof rec.sourceId !== 'string' || !rec.sourceId) return 'a record has no sourceId';
    // evidence, when present, must be an array of strings — the import fences every element (MAJOR-3)
    if ('evidence' in rec && rec.evidence != null
      && (!Array.isArray(rec.evidence) || rec.evidence.some((x) => typeof x !== 'string'))) {
      return `record ${rec.sourceId} has an evidence that is not an array of strings`;
    }
    if ('identifiers' in rec && rec.identifiers != null
      && (!Array.isArray(rec.identifiers) || rec.identifiers.some((x) => typeof x !== 'string'))) {
      return `record ${rec.sourceId} has identifiers that are not an array of strings`;
    }
  }
  return null;
}

/*
 * ⛔ G16 · `memory candidates import <file>` — the dev-side receiver. It reads the package through the
 * classified boundary, validates its shape, RE-RUNS the redaction fence on every free-text field (a
 * record failing it is REFUSED by name, not imported — a forged or hand-edited export), verifies the
 * provenance, and lands each remaining record as a CANDIDATE in this checkout's own store through
 * captureCandidateOnce, so a second import of the same package appends nothing. An unverifiable
 * provenance (absent or torn block, an unknown packVersion) imports every record with a
 * `provenance unverified: ` prefix and CANNOT_DETERMINE; a verified import is PASS; any refused record
 * makes the outcome FAIL. Nothing an import writes is ever a graph entity or a lesson.
 */
function cmdMemoryCandidatesImport(file) {
  if (!core) return { outcome: OUTCOME.CANNOT_DETERMINE, error: 'core/ (the host-neutral rollover core) could not be loaded, so no feedback package could be imported — run `doctor`.' };
  if (!file) return { outcome: OUTCOME.FAIL, error: 'import requires a package path: memory candidates import <file>' };
  const abs = path.isAbsolute(file) ? file : path.resolve(file);
  const read = core.io.readJSONClassified(abs);
  if (read.status === 'ABSENT') return { outcome: OUTCOME.FAIL, error: `no feedback package at ${abs}` };
  if (read.status !== 'OK') return { outcome: OUTCOME.CANNOT_DETERMINE, error: `${abs} could not be read (${read.detail || read.status})` };
  const pkg = read.doc;
  const shapeErr = feedbackPackageShapeError(pkg);
  if (shapeErr) return { outcome: OUTCOME.FAIL, error: `${abs} is not a valid feedback-export package: ${shapeErr}` };

  const prov = pkg.provenance;
  const provWellFormed = !!prov && typeof prov === 'object'
    && typeof prov.exportedAt === 'string' && Number.isFinite(Date.parse(prov.exportedAt))
    && typeof prov.projectId === 'string' && /^[0-9a-f]{32}$/.test(prov.projectId)
    && typeof prov.receiptSchemaVersion === 'number';
  const rels = knownReleases();
  const packVersionKnown = !!prov && typeof prov.packVersion === 'string' && rels.has(prov.packVersion);
  const cannotVerifyReleases = rels.size === 0;
  const verified = provWellFormed && !cannotVerifyReleases && packVersionKnown;
  const verifyDetail = !provWellFormed ? 'the provenance block is absent or torn'
    : cannotVerifyReleases ? 'this checkout declares no VERSION and no CHANGELOG ## [x.y.z] headings, so it cannot match any packVersion'
      : !packVersionKnown ? `packVersion ${JSON.stringify(prov.packVersion)} matches no release this checkout knows (its VERSION or a CHANGELOG ## [x.y.z] heading)`
        : 'verified against this checkout\'s known releases';

  const manifest = packManifest();
  const refused = [], toImport = [];
  for (const rec of pkg.records) {
    // every serialized field is fenced (fenceRecordFields), the same policy the exporter applied
    const hits = fenceRecordFields(rec);
    // ⛔ MAJOR-3 · the evidence array is fenced too. Every element must be a mechanical token shape the
    // exporter emits AND pass the redaction fence; a forged package that hides a hostname or a secret in
    // `evidence` (the exporter never does) is REFUSED by name here, so nothing of it lands in the store.
    for (const ev of (Array.isArray(rec.evidence) ? rec.evidence : [])) {
      if (typeof ev !== 'string') { hits.push({ field: 'evidence', kind: 'not a string', prefix: '' }); continue; }
      if (redactionFence(ev).blocked) continue; // already named by fenceRecordFields
      if (!isMechanicalEvidenceToken(ev, manifest)) hits.push({ field: 'evidence', kind: 'not a mechanical token', prefix: String(ev).slice(0, 3) });
    }
    if (hits.length) { refused.push({ sourceId: rec.sourceId, fields: hits }); continue; }
    toImport.push(rec);
  }

  const revision = receivingRevision();
  const pid = (prov && prov.projectId) || 'unknown';
  // the provenance strings land in each lead's claim, so they pass the same fence (a forged package's
  // value that does not is replaced, never copied into this store)
  const provStr = (v) => (typeof v === 'string' && v && !redactionFence(v).blocked ? v : (v ? 'withheld' : 'unknown'));
  const pv = provStr(prov && prov.packVersion);
  const posture = provStr(prov && prov.posture);
  const ptype = provStr(prov && prov.projectType);
  const seen = existingCandidateDigests();
  const landed = [];
  for (const rec of toImport) {
    const klass = rec.kind === 'candidate'
      ? (core.candidates.KLASSES.includes(rec.klass) ? rec.klass : 'finding')
      : rec.kind === 'entity' ? 'finding' : 'decision';
    const coreClaim = (typeof rec.claim === 'string' && rec.claim) ? rec.claim
      : (typeof rec.observation === 'string' ? rec.observation : '');
    const evTokens = Array.isArray(rec.evidence) ? rec.evidence.filter((x) => typeof x === 'string' && x.trim()) : [];
    const bracket = `[${rec.kind} from project ${pid}, pack ${pv}, posture ${posture}, type ${ptype}] `;
    const prefix = verified ? bracket : `provenance unverified: ${bracket}`;
    const claimText = `${prefix}${coreClaim}${evTokens.length ? ` (evidence: ${evTokens.join(', ')})` : ''}`;
    const r = captureCandidateOnce(seen, claimText, klass, { by: `import:${pid}`, sourceKind: 'adapter', cycleId: revision, conversationId: null, host: null }, evTokens);
    landed.push({ sourceId: rec.sourceId, id: r.id || null, deduped: !!r.deduped, error: r.error || null, klass });
  }

  // ⛔ RC 0.4.0 · a record whose candidate write failed did NOT land, so the import is INCOMPLETE and
  // never PASS. A re-run of the same package is the recovery: every record that did land dedupes by its
  // content digest, and only the failed ones are written.
  const failed = landed.filter((l) => l.error);
  const outcome = (refused.length || failed.length) ? OUTCOME.FAIL : (verified ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE);
  return {
    outcome,
    ...(failed.length ? { error: `the import is INCOMPLETE: ${failed.length} of ${toImport.length} record(s) could not be written (${failed[0].error}). Re-run \`memory candidates import ${file}\` once the store is writable; the records that did land dedupe, so nothing is duplicated.` } : {}),
    import: {
      file: abs, verified, verifyDetail, projectId: pid, packVersion: (prov && prov.packVersion) || null,
      cycleId: revision, considered: pkg.records.length,
      imported: landed.filter((l) => l.id && !l.deduped).length,
      deduped: landed.filter((l) => l.deduped).length,
      failed: failed.length, incomplete: failed.length > 0,
      refused, landed,
    },
  };
}

/*
 * ⛔ A REVIEW'S VERDICT IS A FACT ABOUT THE TREE IT JUDGED, AND NOTHING RE-CHECKED IT BEFORE THE SHIP.
 *
 * the 2026-10-05 field report: a long-lived judgement drifts from reality and the next step
 * trusts it anyway. `/review` reports "clean" against a working tree; a commit or an edit then moves
 * that tree, and `/ship` reads "review clean" from memory. This records WHICH tree the review judged,
 * HEAD plus a digest of hooks/_runtime.js's treeState, so the ship can refuse when either has moved and
 * name the stale review by its timestamp.
 *
 * ⛔ IT PROVES A REVIEW VERB RAN AGAINST THIS TREE, NOT THAT THE REVIEW WAS GOOD. And it is MACHINE-LOCAL
 * by construction: the receipt lives under .respawnpack/runtime/ (gitignored), so a receipt from another
 * clone does not exist, and an absent one is "never reviewed on this machine", never "stale".
 *
 * ⭐ ONE treeState, TWO CALLERS. The writer and the checker both reach hooks/_runtime.js through the
 * SAME boundary the Stop and SessionStart hooks compare the tree with, so they cannot disagree about
 * what "the tree" is, the exact mistake this check exists to catch. The receipt is read back through
 * hooks/_artifact.js's classifying boundary (as closeout.js reads the runtime contract), so absent,
 * unreadable and malformed stay three distinct answers instead of one quiet null. The module handles
 * (RUNTIME_PATH, ARTIFACT_PATH, REVIEW_RECEIPT_REL) are defined up top beside the other cross-tree
 * probes, because KERNEL_CROSS_TREE references them before this point.
 */

// The identity a review judges: HEAD, plus a sha256 over the CONTENT IDENTITY hooks/_runtime.js's
// diffStates compares, not the raw bucket keys. Per path the digest is its C: content when there is one
// and otherwise its sorted W:/S:/U: bucket digests (a deletion has only the latter). This is the exact
// collapse _runtime.js's contentIdentity() makes, rebuilt here from the one thing it exports (treeState
// + pathOf) because the kernel must not add an export to _runtime.js. Collapsing to content is what
// removes the 563-file false positive A3's field run measured: a zero-byte `git add` moves a path from
// U:/W: to S: without changing its content, so the receipt must not read that as the tree changing, or
// it would disagree with the Stop hook's own diffStates about the same tree. Untracked content is still
// part of the identity (as a C: content digest); .respawnpack/ is excluded by isSelfPath, and the walk
// is exactly as precise as treeState, blind spots included. Returns the disposition when _runtime.js
// will not load or the directory is not a repo, so the caller keeps "cannot tell" apart from "stale".
function reviewTreeIdentity(dir) {
  if (!runtimeLib || typeof runtimeLib.treeState !== 'function' || typeof runtimeLib.pathOf !== 'function') {
    return { status: 'CANNOT_DETERMINE', detail: `hooks/_runtime.js is unavailable (${runtimeHealth.detail || runtimeHealth.status}) — the tree identity cannot be computed through its own boundary` };
  }
  const ts = runtimeLib.treeState(dir);
  if (!ts) return { status: 'NOT_A_REPO', detail: 'this is not a git repository, so there is no tree for a review to be a fact about' };
  const byPath = new Map();
  for (const [k, v] of Object.entries(ts.files)) {
    const p = runtimeLib.pathOf(k);
    if (!byPath.has(p)) byPath.set(p, { content: null, buckets: [] });
    if (k.startsWith('C:')) byPath.get(p).content = v; else byPath.get(p).buckets.push(v);
  }
  const entries = [...byPath.keys()].sort().map((p) => {
    const rec = byPath.get(p);
    return `${p}=${rec.content !== null ? `C:${rec.content}` : `B:${rec.buckets.slice().sort().join('|')}`}`;
  }).join('\n');
  const treeDigest = crypto.createHash('sha256').update(entries).digest('hex');
  return { status: 'OK', head: ts.head, treeDigest };
}

// The receipt on disk, CLASSIFIED — absent, unreadable and malformed are kept apart because a review's
// freshness is exactly the place a collapsed read ("no usable record") would read as "stale" and nag,
// or as "fine" and ship. A present file whose head/treeDigest/judgedAt are not the shapes the ship will
// compare is MALFORMED, not a stale match.
function readReviewReceiptClassified(dir) {
  if (!artifactLib || typeof artifactLib.readJSONClassified !== 'function') {
    return { status: 'UNREADABLE', detail: `hooks/_artifact.js is unavailable (${artifactHealth.detail || artifactHealth.status}) — the receipt cannot be read through its own boundary` };
  }
  const r = artifactLib.readJSONClassified(path.join(dir, REVIEW_RECEIPT_REL));
  if (r.status !== 'OK') return { status: r.status, detail: r.detail || `${REVIEW_RECEIPT_REL}: ${r.status.toLowerCase()}` };
  const d = r.doc;
  const wellFormed = d && typeof d === 'object' && !Array.isArray(d)
    && typeof d.treeDigest === 'string' && /^[0-9a-f]{64}$/.test(d.treeDigest)
    && (d.head === null || (typeof d.head === 'string' && /^[0-9a-f]{40}$/.test(d.head)))
    && typeof d.judgedAt === 'string';
  if (!wellFormed) return { status: 'MALFORMED', detail: `${REVIEW_RECEIPT_REL} is present but missing or malformed head/treeDigest/judgedAt — nothing can be concluded about which tree it judged` };
  return { status: 'OK', receipt: d };
}

/*
 * ⛔ RC 0.4.0 · THE RECEIPT IS BOUND TO THE EXACT CONTENT A COMMIT WOULD CARRY, NOT ONLY TO A DIGEST.
 * treeState's digest sees working-tree bytes (the first MiB of each file) and swallows git failures into
 * empty buckets, so it can neither see that the INDEX holds different bytes than the reviewed working
 * tree (stage version Z, edit the file back to the reviewed Y: the digest still matches, and the commit
 * carries Z) nor tell a complete snapshot from a partial one. The receipt therefore also records
 * `contentTree`: the git tree object of the whole reviewed content, built in a TEMPORARY copy of the
 * index brought to the working tree with `git add -A` (every byte hashed by git itself, .gitignore
 * honoured, untracked content and deletions included, `.respawnpack/` left out as treeState leaves it).
 * Every git step's exit status is checked: if git cannot produce the complete snapshot, the answer is
 * CANNOT_DETERMINE ("cannot verify the review"), never a digest over whatever it managed to read.
 * `--check --staged` (what /ship runs after staging, right before `git commit`) then compares the index
 * itself against that tree: every path the commit changes must carry exactly the reviewed bytes.
 */
function reviewGit(cwd, args, env) {
  const r = spawnSync('git', args, {
    cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 512 * 1024 * 1024, windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}${r.stderr && r.stderr.length ? `: ${String(r.stderr).trim().split(/\r?\n/).filter((l) => !/^warning:/.test(l)).join(' ').slice(0, 200)}` : ''}`;
    return { ok: false, detail: `git ${args.join(' ')} failed (${why})` };
  }
  return { ok: true, out: r.stdout.toString('utf8') };
}
const REVIEW_SELF_DIR = '.respawnpack';
function reviewRepoLayout(dir) {
  const top = reviewGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, detail: top.detail };
  // ⛔ WHERE THE PROJECT SITS IN THE REPOSITORY COMES FROM GIT, NEVER FROM COMPARING TWO PATH SPELLINGS.
  // git reports the top in its own canonical spelling (the long Windows name, a junction or symlink
  // resolved), while DIR may be an 8.3 short name or a link path, so path.relative() between them
  // produced `../../RUNNER~1/...` on the Windows CI runner and git rejected the exclusion as outside
  // the repository. `--show-prefix` is git's own answer: '' at the root, 'sub/dir/' below it.
  const pre = reviewGit(dir, ['rev-parse', '--show-prefix']);
  if (!pre.ok) return { ok: false, detail: pre.detail };
  const prefix = pre.out.replace(/\r?\n$/, '');
  return { ok: true, top: top.out.trim(), prefix, selfPrefix: `${prefix}${REVIEW_SELF_DIR}/` };
}
function reviewContentTree(dir) {
  const cannot = (d) => ({ status: 'CANNOT_DETERMINE', detail: `git could not produce a complete snapshot of the working tree, so the review cannot be verified: ${d}` });
  const lay = reviewRepoLayout(dir);
  if (!lay.ok) return cannot(lay.detail);
  // git's own absolute spelling of the index (a worktree's lives under the common dir), never derived here
  const idx = reviewGit(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  if (!idx.ok) return cannot(idx.detail);
  const realIndex = path.resolve(idx.out.trim());
  const tmpIndex = path.join(os.tmpdir(), `rp-review-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // a copy of the real index keeps git's stat cache, so an unchanged file is not re-hashed
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    else { const e = reviewGit(dir, ['read-tree', '--empty'], env); if (!e.ok) return cannot(e.detail); }
    // run at the repository top so the snapshot covers the whole working tree even when the project is a
    // subdirectory: the commit carries the whole index, so the review must be about all of it
    // ⛔ NO EXCLUDE PATHSPEC ON THE ADD. git refuses any pathspec that names an IGNORED path (exit 1, "the
    // following paths are ignored"), and an installed target gitignores .respawnpack/, so an exclude naming
    // it failed every snapshot once the directory existed. Stage everything, then drop this project's
    // .respawnpack/ from the temporary index by a LITERAL path relative to the top (git's own prefix).
    const self = lay.selfPrefix.replace(/\/$/, '');
    const add = reviewGit(lay.top, ['add', '-A', '--', '.'], env);
    if (!add.ok) return cannot(add.detail);
    const rmSelf = reviewGit(lay.top, ['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', `:(literal)${self}`], env);
    if (!rmSelf.ok) return cannot(rmSelf.detail);
    const wt = reviewGit(dir, ['write-tree'], env);
    if (!wt.ok) return cannot(wt.detail);
    const tree = wt.out.trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) return cannot(`git write-tree returned ${JSON.stringify(tree.slice(0, 80))}`);
    return { status: 'OK', contentTree: tree };
  } catch (e) {
    return cannot(e.message);
  } finally {
    for (const f of [tmpIndex, `${tmpIndex}.lock`]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  }
}
// Parse `-z` git listings into Map(path -> "mode oid").
function parseLsFilesStage(out) {
  const m = new Map(), unmerged = new Set();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t'); const [mode, oid, stage] = rec.slice(0, tab).split(' '); const p = rec.slice(tab + 1);
    if (stage !== '0') { unmerged.add(p); continue; }
    m.set(p, `${mode} ${oid}`);
  }
  return { map: m, unmerged };
}
function parseLsTree(out) {
  const m = new Map();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t'); const [mode, , oid] = rec.slice(0, tab).split(' ');
    m.set(rec.slice(tab + 1), `${mode} ${oid}`);
  }
  return m;
}
// The staged paths whose index entry is not the reviewed tree's entry (a staged deletion of a reviewed
// path, or a staged path the review never saw, both count). CANNOT_DETERMINE when any listing fails or
// the reviewed tree object is gone from this repository (gc can prune an unreferenced tree).
function stagedAgainstReview(dir, contentTree) {
  const cannot = (d) => ({ status: 'CANNOT_DETERMINE', detail: `the staged content cannot be compared with the reviewed content, so the review cannot be verified: ${d}` });
  const lay = reviewRepoLayout(dir);
  if (!lay.ok) return cannot(lay.detail);
  const has = reviewGit(lay.top, ['cat-file', '-e', `${contentTree}^{tree}`]);
  if (!has.ok) return cannot(`the reviewed tree ${contentTree.slice(0, 12)} is no longer in this repository (${has.detail}); re-review`);
  const changed = reviewGit(lay.top, ['diff', '--cached', '--name-only', '-z', '--no-renames']);
  if (!changed.ok) return cannot(changed.detail);
  const ls = reviewGit(lay.top, ['ls-files', '-s', '-z']);
  if (!ls.ok) return cannot(ls.detail);
  const rv = reviewGit(lay.top, ['ls-tree', '-r', '-z', '--full-tree', contentTree]);
  if (!rv.ok) return cannot(rv.detail);
  const staged = parseLsFilesStage(ls.out);
  const reviewed = parseLsTree(rv.out);
  const paths = changed.out.split('\0').filter(Boolean);
  const mismatched = [], selfStaged = [];
  let considered = 0;
  for (const p of paths) {
    // ⛔ a staged path under this project's .respawnpack/ WOULD be committed, but the reviewed snapshot
    // leaves .respawnpack/ out, so no review ever saw its bytes: it is named and refused, never skipped
    if (p.startsWith(lay.selfPrefix)) { selfStaged.push(p); continue; }
    considered++;
    if (staged.unmerged.has(p)) { mismatched.push(p); continue; }
    if ((staged.map.get(p) || null) !== (reviewed.get(p) || null)) mismatched.push(p);
  }
  return { status: 'OK', staged: considered, mismatched, selfStaged };
}

/*
 * `review-receipt` — the tree a review judged, recorded on `--write` and re-checked on `--check`.
 * Two modes, one identity function. `--write` is what `/review`'s Step 4 runs; `--check` (the default)
 * is what `/ship`'s pre-ship gate runs beside the readiness gate; `--check --staged` is what /ship runs
 * after staging, right before the commit. `readiness` and `gate` are untouched.
 */
function cmdReviewReceipt() {
  const sh = (h) => (h ? String(h).slice(0, 10) : '(no commit)');
  const id = reviewTreeIdentity(DIR);

  if (flag('--write')) {
    if (id.status !== 'OK') {
      return { outcome: OUTCOME.CANNOT_DETERMINE, mode: 'write', detail: `cannot record a review receipt: ${id.detail}` };
    }
    const ct = reviewContentTree(DIR);
    if (ct.status !== 'OK') {
      return { outcome: OUTCOME.CANNOT_DETERMINE, mode: 'write', detail: `cannot record a review receipt: ${ct.detail}` };
    }
    const verdict = valueOf('--verdict', 'clean');
    if (verdict !== 'clean' && verdict !== 'findings') {
      return { outcome: OUTCOME.FAIL, mode: 'write', detail: `--verdict must be clean or findings, not ${JSON.stringify(verdict)}` };
    }
    const lensesArg = valueOf('--lenses', null);
    const lenses = lensesArg ? lensesArg.split(';').map((s) => s.trim()).filter(Boolean) : [];
    const note = valueOf('--note', null);
    const judgedAt = new Date().toISOString();
    stateLib.writeAtomic(path.join(DIR, REVIEW_RECEIPT_REL), `${JSON.stringify({
      schemaVersion: stateLib.SCHEMA_VERSION, head: id.head, treeDigest: id.treeDigest, contentTree: ct.contentTree,
      judgedAt, verdict, lenses, note,
    }, null, 2)}\n`);
    return {
      outcome: OUTCOME.PASS, mode: 'write', wrote: REVIEW_RECEIPT_REL.split(path.sep).join('/'),
      head: id.head, treeDigest: id.treeDigest, contentTree: ct.contentTree, verdict, judgedAt,
      detail: `recorded a ${verdict} review of HEAD ${sh(id.head)} (tree digest ${id.treeDigest.slice(0, 12)}, content tree ${ct.contentTree.slice(0, 12)}) at ${judgedAt} (machine-local)`,
    };
  }

  const staged = flag('--staged');
  const mode = staged ? 'check-staged' : 'check';
  // --check (the default). The identity must be computable first: a tree that is not a repository, or a
  // boundary that will not load, is CANNOT_DETERMINE — the ship cannot clear a review it cannot evaluate.
  if (id.status !== 'OK') {
    return { outcome: OUTCOME.CANNOT_DETERMINE, mode, receipt: null, detail: id.detail };
  }
  const rr = readReviewReceiptClassified(DIR);
  if (rr.status === 'ABSENT') {
    return { outcome: OUTCOME.CANNOT_DETERMINE, mode, receipt: null, detail: 'no review receipt on this machine — this tree has never been reviewed here (machine-local; its absence on another clone proves nothing)' };
  }
  if (rr.status !== 'OK') {
    return { outcome: OUTCOME.CANNOT_DETERMINE, mode, receipt: null, detail: `the review receipt could not be read: ${rr.detail}` };
  }
  const receipt = rr.receipt;
  const summary = { head: receipt.head, treeDigest: receipt.treeDigest, contentTree: receipt.contentTree || null, judgedAt: receipt.judgedAt, verdict: receipt.verdict };
  const contentTreeOk = typeof receipt.contentTree === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.contentTree);
  if (!contentTreeOk) {
    return { outcome: OUTCOME.CANNOT_DETERMINE, mode, receipt: summary, detail: `the review of ${receipt.judgedAt} recorded no content tree (it predates content binding), so what a commit would carry cannot be matched to it; re-review this tree to record a fresh receipt` };
  }
  const headMoved = receipt.head !== id.head;

  if (staged) {
    // ⛔ the exact content the commit will carry: every staged path must hold the reviewed bytes
    if (headMoved) {
      return { outcome: OUTCOME.FAIL, mode, receipt: summary, moved: ['HEAD'], head: id.head,
        detail: `the review of ${receipt.judgedAt} judged HEAD ${sh(receipt.head)}; HEAD is now ${sh(id.head)}. This review is stale; re-review before committing.` };
    }
    const sa = stagedAgainstReview(DIR, receipt.contentTree);
    if (sa.status !== 'OK') return { outcome: OUTCOME.CANNOT_DETERMINE, mode, receipt: summary, detail: sa.detail };
    if (sa.mismatched.length || sa.selfStaged.length) {
      const list = (xs) => xs.slice(0, 10).join(', ') + (xs.length > 10 ? ` and ${xs.length - 10} more` : '');
      const why = [];
      if (sa.mismatched.length) why.push(`the staged content differs from what the review of ${receipt.judgedAt} judged in ${sa.mismatched.length} path(s): ${list(sa.mismatched)}`);
      if (sa.selfStaged.length) why.push(`${sa.selfStaged.length} staged path(s) under ${REVIEW_SELF_DIR}/ would be committed, and the reviewed snapshot leaves ${REVIEW_SELF_DIR}/ out, so no review saw them: ${list(sa.selfStaged)}`);
      return { outcome: OUTCOME.FAIL, mode, receipt: summary, moved: ['the staged content'], mismatched: sa.mismatched, selfStaged: sa.selfStaged, head: id.head,
        detail: `${why.join('; and ')}. The commit would carry bytes no review saw; stage exactly the reviewed content (unstage any ${REVIEW_SELF_DIR}/ path), or re-review.` };
    }
    return { outcome: OUTCOME.PASS, mode, receipt: summary, moved: [], staged: sa.staged, head: id.head,
      detail: sa.staged
        ? `all ${sa.staged} staged path(s) carry exactly the bytes the ${receipt.verdict} review of ${receipt.judgedAt} judged`
        : `nothing is staged against HEAD ${sh(id.head)}, so a commit would carry no unreviewed content` };
  }

  const ct = reviewContentTree(DIR);
  if (ct.status !== 'OK') return { outcome: OUTCOME.CANNOT_DETERMINE, mode, receipt: summary, detail: ct.detail };
  const treeMoved = receipt.treeDigest !== id.treeDigest || receipt.contentTree !== ct.contentTree;
  if (!headMoved && !treeMoved) {
    return {
      outcome: OUTCOME.PASS, mode: 'check', receipt: summary, moved: [], head: id.head, treeDigest: id.treeDigest, contentTree: ct.contentTree,
      detail: `the ${receipt.verdict} review of ${receipt.judgedAt} judged HEAD ${sh(receipt.head)}, and the tree still matches it`,
    };
  }
  const moved = [];
  const since = [];
  if (headMoved) { moved.push('HEAD'); since.push(`HEAD moved from ${sh(receipt.head)} to ${sh(id.head)}`); }
  // The digest is the CONTENT identity, so a difference here is a content change, never a bare index move.
  if (treeMoved) { moved.push('the working tree'); since.push('the working tree content changed'); }
  return {
    outcome: OUTCOME.FAIL, mode: 'check', receipt: summary, moved, head: id.head, treeDigest: id.treeDigest, contentTree: ct.contentTree,
    detail: `the review of ${receipt.judgedAt} judged HEAD ${sh(receipt.head)}; since then ${since.join(' and ')}. This review is stale; re-review this tree before shipping.`,
  };
}

/*
 * ⛔ B2 · `migrate decisions [--write]` — split a DECISIONS.md monolith into one file per decision.
 *
 * The shape follows the derived-doc auto-migration precedent (kernel:R16): a DRY RUN by default that
 * previews the exact per-entry plan the write performs, and `--write` to apply. It REFUSES the whole run
 * on the first entry it cannot resolve, naming it by heading and line, in a dry run or a write alike, and
 * writes NOTHING — a monolith half-split into a tree the kernel then renders from is worse than one left
 * whole. A project with no monolith is NOT_APPLICABLE and changes nothing. The monolith is ARCHIVED
 * verbatim (spine rule 5), never deleted; the index is rendered in its place by the same
 * render.renderDecisions the savepoint uses, so the next savepoint reproduces it.
 *
 * ⛔ COMPLETE MEANS THE INDEX WAS RENDERED. A migration counts as complete only once docs/DECISIONS.md
 * carries the generated block, and writing it is the LAST step of a write. So a run interrupted after
 * some shard files (the monolith still in place, no generated block) is not "already migrated": a retry
 * compares every shard file with the monolith entry it came from, leaves an identical one alone, writes
 * the missing ones, and refuses, writing nothing, on a file that conflicts with the monolith, a file the
 * monolith does not hold, or two files claiming one id. The write order keeps the monolith recoverable at
 * every step: the archive first (confirmed by reading it back), then the shard files, then the index,
 * rendered and verified in memory before it replaces the monolith. An archive path that already holds a
 * DIFFERENT monolith is never overwritten and never mistaken for this one: the archive goes to the next
 * free `docs/_archive/DECISIONS-<n>.md` instead, and a retry finds its own copy again by content.
 */
function decisionArchiveFor(monolith) {
  const base = decisionsLib.ARCHIVE_REL;
  for (let n = 1; n <= 100; n += 1) {
    const rel = n === 1 ? base : base.replace(/\.md$/, `-${n}.md`);
    const abs = path.join(DIR, rel);
    if (!fs.existsSync(abs)) return { rel, present: false };
    if (decisionsLib.archiveHolds(readText(abs), monolith)) return { rel, present: true };
  }
  return null;
}

function cmdMigrate() {
  const what = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
  const write = flag('--write');
  if (what !== 'decisions') {
    return { outcome: OUTCOME.CANNOT_DETERMINE, error: `name what to migrate: the one supported target is \`decisions\` (got ${what ? JSON.stringify(what) : 'nothing'}). Usage: migrate decisions [--write]`,
      checks: [result(OUTCOME.CANNOT_DETERMINE, 'migrate', 'no migration target named', { checked: 0 })] };
  }
  const indexRel = decisionsLib.INDEX_REL;
  const indexAbs = path.join(DIR, indexRel);
  const shardRel = decisionsLib.DECISIONS_DIR;
  const monolith = readText(indexAbs);
  const na = (detail) => ({ outcome: OUTCOME.NOT_APPLICABLE, checks: [result(OUTCOME.NOT_APPLICABLE, 'migrate:decisions', detail)], plan: null });
  const refuse = (msg, refusal) => ({ outcome: OUTCOME.CANNOT_DETERMINE, error: msg,
    checks: [result(OUTCOME.CANNOT_DETERMINE, 'migrate:decisions', msg, { checked: 0 })], plan: { write, entries: [], refusal } });
  if (monolith === null) return na(`no ${indexRel} in this project — there is no decision monolith to split. Nothing was changed.`);
  const existingShard = decisionsLib.readShard(DIR);
  const shardRecords = existingShard.status === 'OK' ? existingShard.records : [];
  const dupDetail = decisionsLib.describeDuplicates(existingShard.duplicates);
  // Already migrated: docs/DECISIONS.md is a rendered index, which is the step a write performs last.
  if (monolith.includes(render.GEN_OPEN)) {
    if (dupDetail) {
      const msg = `${indexRel} is a rendered index, but \`${shardRel}/\` holds more than one file for one decision id (${dupDetail}). Keep one file per id; \`savepoint --verify\` FAILs the index until then. Nothing was changed.`;
      return { outcome: OUTCOME.FAIL, error: msg, checks: [result(OUTCOME.FAIL, 'migrate:decisions', msg, { checked: shardRecords.length })], plan: null };
    }
    if (shardRecords.length) {
      return na(`already migrated — ${indexRel} is a rendered index and \`${shardRel}/\` holds ${shardRecords.length} decision file(s). \`migrate decisions\` splits a monolith once; it changes nothing on a migrated tree. Nothing was changed.`);
    }
    return na(`${indexRel} is already a rendered index (it carries a generated block) and \`${shardRel}/\` is empty — nothing to split. Nothing was changed.`);
  }
  if (existingShard.status === 'UNREADABLE') {
    return refuse(`cannot split ${indexRel}: ${existingShard.reason}, so the files already there cannot be compared with the monolith. NOTHING was written.`, { reason: existingShard.reason });
  }

  const parsed = decisionsLib.parseMonolith(monolith);
  if (!parsed.ok) {
    const where = `${parsed.error} at line ${parsed.line}${parsed.heading ? ` (heading: ${JSON.stringify(parsed.heading)})` : ''}`;
    const msg = `cannot split ${indexRel} — ${where}. The splitter never guesses, so the whole run is refused and NOTHING was written. Fix the entry by hand and re-run.`;
    return { outcome: OUTCOME.CANNOT_DETERMINE, error: msg, checks: [result(OUTCOME.CANNOT_DETERMINE, 'migrate:decisions', msg, { checked: 0 })], plan: { write, entries: [], refusal: { id: parsed.id, line: parsed.line, heading: parsed.heading || null, reason: parsed.error } } };
  }

  const entries = parsed.entries;
  // ⛔ A MONOLITH THAT PARSES TO ZERO REAL DECISIONS IS NOT_APPLICABLE, NOT A FAILED PASS. A file carrying
  // only the template's `D-NNN`/`D-00X` placeholders (no `### D-<digits>` heading) parses clean but has
  // nothing to split; returning a PASS with checked:0 would trip the zero-work guard ("PASS requires
  // checked > 0") and read as broken, so there is nothing to migrate and we say so.
  if (!entries.length) {
    return na(`${indexRel} parses to no decisions — it carries only placeholder headings (no \`### D-NNN\` entry with digits). There is nothing to split. Nothing was changed.`);
  }

  // ⛔ AN INTERRUPTED RUN IS RESUMED, NEVER TRUSTED. Every file already in the shard must be exactly the
  // file this monolith produces; anything else is a conflict the splitter will not guess its way past.
  const lf = (s) => String(s).replace(/\r\n/g, '\n');
  const conflicts = [];
  if (dupDetail) conflicts.push(`more than one file claims one decision id (${dupDetail})`);
  const present = [];
  for (const e of entries) {
    const onDisk = readText(path.join(DIR, e.file));
    if (onDisk !== null) {
      if (lf(onDisk) === lf(decisionsLib.shardText(e))) present.push(e.file);
      else conflicts.push(`${e.file} exists but is not the monolith's ${e.id} entry (line ${e.line})`);
    }
    for (const r of shardRecords) if (r.id === e.id && r.file !== e.file) conflicts.push(`${r.file} already claims ${e.id}, which the monolith splits to ${e.file}`);
  }
  const monolithIds = new Set(entries.map((e) => e.id));
  for (const r of shardRecords) if (!monolithIds.has(r.id)) conflicts.push(`${r.file} (${r.id}) is not an entry of the monolith`);
  if (conflicts.length) {
    return refuse(`cannot complete the split of ${indexRel}: \`${shardRel}/\` already holds files that do not match the monolith: ${conflicts.join(' · ')}. The splitter never guesses, so NOTHING was written and the monolith is unchanged. Move the conflicting file(s) aside, or reconcile them with the monolith, and re-run.`,
      { reason: 'the shard conflicts with the monolith', conflicts });
  }
  const archive = decisionArchiveFor(monolith);
  if (!archive) {
    return refuse(`cannot split ${indexRel}: ${decisionsLib.ARCHIVE_REL} and its -2 to -100 variants all hold a different file, so the monolith has nowhere to be archived without overwriting one. NOTHING was written.`, { reason: 'no free archive path' });
  }

  const removals = entries.filter((e) => e.removal).length;
  const archiveRel = archive.rel;
  // ⛔ THE PLAN IS IDENTICAL IN BOTH MODES — the dry run previews exactly what the write performs (G1).
  const plan = { write, entries: entries.map((e) => ({ id: e.id, file: e.file, removal: e.removal })), archiveRel, indexRel, present };
  const resumed = present.length ? ` ${present.length} of the ${entries.length} shard file(s) are already present from an interrupted run and identical to the monolith, so they are left alone.` : '';
  const archiveNote = archive.present
    ? `keep the verbatim archive of ${indexRel} already at ${archiveRel}`
    : `archive ${indexRel} verbatim to ${archiveRel}${archiveRel !== decisionsLib.ARCHIVE_REL ? ` (${decisionsLib.ARCHIVE_REL} already holds a different monolith, which is kept)` : ''}`;

  if (!write) {
    return { outcome: OUTCOME.PASS, plan,
      checks: [result(OUTCOME.PASS, 'migrate:decisions',
        `PREVIEW ONLY — nothing was written. \`migrate decisions --write\` would split ${entries.length} entr(ies) into ${shardRel}/ (${removals} removal${removals === 1 ? '' : 's'}, marked ⛔), ${archiveNote} (archive, never delete), and render a verified index in its place.${resumed}`,
        { checked: entries.length })] };
  }

  // --write: the archive first (read back before anything else moves), then the missing shard files,
  // then the index, rendered and verified in memory before it replaces the monolith.
  const wrote = [];
  const archiveAbs = path.join(DIR, archiveRel);
  if (!archive.present) { stateLib.writeAtomic(archiveAbs, `${decisionsLib.archiveBanner(new Date().toISOString())}\n${monolith}`); wrote.push(archiveRel); }
  const stop = (msg) => ({ outcome: OUTCOME.FAIL, error: msg, plan, wrote,
    checks: [result(OUTCOME.FAIL, 'migrate:decisions', msg, { checked: entries.length })] });
  if (!decisionsLib.archiveHolds(readText(archiveAbs), monolith)) {
    return stop(`the archive at ${archiveRel} does not read back as this monolith, so ${indexRel} was left as it is (no shard file and no index was written). Re-run once the archive path is writable.`);
  }
  fs.mkdirSync(path.join(DIR, shardRel), { recursive: true });
  for (const e of entries) {
    if (present.includes(e.file)) continue;
    stateLib.writeAtomic(path.join(DIR, e.file), decisionsLib.shardText(e)); wrote.push(e.file);
  }
  const store = { ...decisionsLib.readShard(DIR), generatedAt: new Date().toISOString() };
  const seededNote = `${render.NOTE_OPEN}\n_Split from ${indexRel} by \`migrate decisions\`; the original monolith is archived verbatim at ${archiveRel}. Author new decisions as files under ${shardRel}/._\n${render.NOTE_CLOSE}\n`;
  const indexText = render.renderDecisions(seededNote, store);
  const recs = store.status === 'OK' ? store.records : [];
  const missing = entries.filter((e) => !recs.some((r) => r.id === e.id && r.file === e.file)).map((e) => e.file);
  const verdict = render.verifyDecisions(indexText, store, { file: indexRel });
  if (missing.length || recs.length !== entries.length || verdict.outcome !== OUTCOME.PASS) {
    const why = missing.length ? `missing after the write: ${missing.join(', ')}`
      : recs.length !== entries.length ? `the shard holds ${recs.length} file(s) for ${entries.length} entr(ies)` : verdict.detail;
    return stop(`the shard written under ${shardRel}/ does not verify against the monolith (${why}), so ${indexRel} was left as the monolith and the migration is NOT complete. The monolith is archived at ${archiveRel}; fix the shard and re-run \`migrate decisions --write\`.`);
  }
  stateLib.writeAtomic(indexAbs, indexText);
  wrote.push(indexRel);
  return { outcome: OUTCOME.PASS, plan, wrote,
    checks: [result(OUTCOME.PASS, 'migrate:decisions',
      `split ${entries.length} entr(ies) into ${shardRel}/ (${removals} removal${removals === 1 ? '' : 's'}, marked ⛔), ${archive.present ? `kept the verbatim archive already at ${archiveRel}` : `archived ${indexRel} verbatim to ${archiveRel}`}, and rendered a verified index in its place.${resumed} A \`savepoint --verify\` now checks the index against the shard.`,
      { checked: entries.length })] };
}

// --- dispatch ---------------------------------------------------------------------------------

const VERBS = { state: cmdState, savepoint: cmdSavepoint, status: cmdStatus, doctor: cmdDoctor, contract: cmdContract, gate: cmdGate, readiness: cmdReadiness, removals: cmdRemovals, lineage: cmdLineage, aar: cmdAar, living: cmdLiving, reconcile: cmdReconcile, memory: cmdMemory, feedback: cmdFeedback, site: cmdSite, migrate: cmdMigrate, 'restore-derived': cmdRestoreDerived, 'review-receipt': cmdReviewReceipt, log: cmdLog, incident: cmdIncident };

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
                       run is check-only for the derived docs: the fresh compile is verified IN
                       MEMORY against the STATE.json on disk (created only if absent), but the
                       run still records its attempt (.respawnpack/runtime/savepoint-attempt.json),
                       captures failing checks as candidate leads under memory/candidates/, and
                       may re-render LESSONS.md to count them.
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
  migrate decisions [--write]
                       split a docs/DECISIONS.md monolith into one file per decision under
                       docs/decisions/, and render a verified index in its place. Preview by default;
                       --write applies. It REFUSES the whole run on the first entry it cannot resolve
                       to (id, date, status), naming it by heading and line, in a dry run or a write
                       alike, and writes nothing. The monolith is archived verbatim to docs/_archive/
                       (never deleted). A second run, or a project with no monolith, is NOT_APPLICABLE.
  status               short current-state summary
  doctor               what is installed, configured, unsupported, stale, or silently inactive —
                       including an "onboarding" row that says COMPLETE or INCOMPLETE, and an
                       "applicability" survey naming every optional contract nobody has decided yet
       --onboarding    print ONLY the applicability survey — the boot projection /respawn Step 2 reads.
                       Text is one line per contract (its state, basis and remedy); --json is
                       { onboardingComplete, unresolved, applicability }, the applicability rows
                       byte-identical to the full doctor's. Computed by the same coverageChecks, so it
                       costs no scan and never disagrees with doctor. Exit mirrors the onboarding row:
                       0 COMPLETE, 2 anything undecided.
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
  memory candidates import <file>
                       G16 · import a \`feedback --export\` package from another project. Each record
                       lands as a CANDIDATE (never a lesson, never a graph entity), authored
                       import:<projectId>, through the same audited gate every lead travels; a second
                       import of the same package appends nothing. The redaction fence is re-run on every
                       free-text field and a record that fails it is REFUSED by name (a forged export).
                       PASS when the provenance verifies; CANNOT_DETERMINE (every lead prefixed
                       "provenance unverified") when the provenance block is absent, torn, or names a
                       packVersion this checkout cannot match; FAIL when any record is refused.
  feedback --export [--out <path>] [--drop <sourceId>]
                       G16 · package this project's PACK-DIRECTED records (candidates, graph entities and
                       decisions that name a pack identifier) without its operational detail, behind a
                       mechanical redaction fence. Without --out it PREVIEWS exactly what would leave
                       (every included record in full, every excluded one with its reason) and writes
                       nothing. With --out it writes the package atomically (default
                       .respawnpack/runtime/feedback-export-<date>.json, gitignored), but REFUSES (exit 1,
                       nothing written) while any included record has a field the fence blocked, until the
                       owner passes --drop <sourceId> for it or edits the source. It never sends anything
                       anywhere and never reads the host's auto memory.
  review-receipt [--check]
                       re-check the recorded review against the tree right now. PASS when a receipt
                       exists and HEAD, the working-tree digest and the complete content tree still
                       match what it judged; FAIL, naming the receipt and which of HEAD or the working
                       tree moved, when either differs; CANNOT_DETERMINE when no receipt exists (never
                       reviewed on this machine, machine-local, so its absence on another clone proves
                       nothing), the receipt is unreadable, malformed or predates content binding, the
                       tree is not a repository, or git cannot produce a complete snapshot. The tree
                       identity is HEAD plus a sha256 over hooks/_runtime.js's per-path digests, plus the
                       git tree object of the whole reviewed content (untracked content included).
                       \`/ship\`'s pre-ship gate runs this; a re-review clears a FAIL. It proves a review
                       verb ran against THIS tree, not that the review was good.
                 --check --staged
                       what \`/ship\` runs after staging, right before \`git commit\`: PASS only when HEAD
                       is the reviewed HEAD and every staged path carries exactly the reviewed bytes;
                       FAIL naming each staged path whose bytes the review never saw, including any
                       staged path under .respawnpack/ (the snapshot leaves it out); CANNOT_DETERMINE
                       when the comparison cannot be made (no receipt, no content tree, a git failure,
                       or the reviewed tree object pruned).
                 --write [--verdict clean|findings] [--lenses "<a;b>"] [--note "..."]
                       record the receipt for the tree as it is now (HEAD, the digest, the content
                       tree, the verdict and the lenses) at .respawnpack/runtime/review-receipt.json
                       (machine-local, atomic); CANNOT_DETERMINE and nothing written when git cannot
                       produce a complete snapshot.
                       \`/review\`'s Step 4 runs this once the review is done.
  log                  the append-only operations log (G17), .respawnpack/ops-log.jsonl, one JSON row
                       per line sealed in a prevDigest chain. MACHINE-LOCAL - gitignored, never travels
                       in a clone.
       --action "<what was done>" --result "<outcome>" --by "<who>" [--ref <id>]...
                       append one row and print its digest. All three are required and non-empty (an
                       action with no author or result is refused before anything is written); a value
                       over 1,000 characters or spanning lines is refused (the memo's "one line").
       --list          print the last twenty rows and the chain verdict (the default with no --action).
       --verify        walk the whole file: PASS with the row count and head digest; FAIL naming the
                       FIRST row where the chain breaks (a rewrite or a splice is corruption, refused
                       and never skipped); a torn TAIL is reported by count as its own fact - a read
                       never repairs the file. Limit: a rewrite of the LAST row that also recomputes its
                       own digest is caught only when the next row (the savepoint's, every write) seals it.
       --repair-tail --by "<who>"   discard a torn tail after printing it, then append a row recording
                       the repair, so the repair is itself in the log. It never touches a sealed row.
  incident             the incident library (G17), memory/incidents/<id>.json - one authored claim each
                       (signature, cause, fix). TRACKED, committed to the repository.
       --new --signature "..." --cause "..." --fix "..." --by "<who>" [--log-ref <digest>]... [--status open|fixed]
                       write the record and, in the same call, mint one \`root-cause-fix\` candidate whose
                       claim names the incident by id and NEVER carries the fix body. Each of the three
                       texts and the author is required and non-empty.
       --list          print the open and fixed incidents (id, status, signature).
       --close <id> --by "<who>"   set status to fixed with closedAt/closedBy - the only edit a verb
                       makes to an existing record. A repeat is an idempotent no-op; an unknown id is refused.
  contract             show the active interaction contract
  contract collaborate clear it — collaborate is the default and needs no command
  contract delegate    --task "..." --acceptance "a;b" [--authority "..."] [--forbidden "..."]
                       acceptance is REQUIRED — a bounded task with no definition of done is an
                       unbounded one with a shorter description. Derive the criteria from what the
                       user already said; ask only when the ambiguity changes what you build.
                       Each list flag takes either one ";"-joined value OR repeated flags
                       (--acceptance a --acceptance b); write "\;" for a literal ";" inside a criterion.
  contract goal        --goal "..." --completion "a;b" [--constraints "..."] [--authority "..."]
                       [--forbidden "..."] [--id G-1] | --resume
                       goal mode REQUIRES a stated goal and stated completion criteria — it is never
                       inferred from a task being difficult. --completion and the other list flags take
                       one ";"-joined value OR repeated flags; "\;" is a literal ";" inside a criterion.
  contract complete [delegate|goal]
                       close the named contract and end autonomy. Idempotent. Without a target it
                       closes whatever is open — and --met always means delegate, so retrying a
                       delegation closure cannot land on the goal it just restored.
                       delegate: --met "<criterion>" once per RECORDED acceptance criterion (or one
                                 ";"-joined --met value). Every one must be restated; this is an
                                 ATTESTATION and is archived as one.
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
} else if (JSON_OUT && !(verb === 'doctor' && out.onboarding)) {
  // `doctor --onboarding --json` prints its own narrow shape in the doctor branch below, not the whole
  // `out`; everything else that takes --json prints its result object here.
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
    // Echo how many criteria the flags parsed into, so a miscount (the field's one-criterion bug) is seen.
    if (typeof out.criteriaCount === 'number') console.log(`  parsed criteria: ${out.criteriaCount}`);
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
  if (out.onboarding) {
    // B1 · the boot projection, in the two shapes /respawn Step 2 uses. `--json` carries the survey
    // rows byte-identical to the full `doctor --json`'s `applicability.rows`, plus the verdict and the
    // undecided list, for the per-contract AskUserQuestion loop. The default TEXT form is one line per
    // contract — its state, how it got there (basis), and the remedy that resolves it — and deliberately
    // NOT the row's `detail`: a project's verbose not-applicable reasons live there, and carrying them is
    // what made the full doctor the payload Step 2 could not afford.
    if (JSON_OUT) {
      console.log(JSON.stringify({ onboardingComplete: out.onboardingComplete, unresolved: out.unresolved, applicability: out.applicability }, null, 2));
    } else {
      for (const r of out.applicability) console.log(`  ${String(r.state).padEnd(14)} ${String(r.subsystem).padEnd(13)} [${r.basis}] ${r.remedy}`);
      console.log(`\n  → onboarding ${out.onboardingComplete ? 'COMPLETE' : `INCOMPLETE — ${out.unresolved.length} undecided: ${out.unresolved.join(', ')}`}`);
    }
  } else {
    // Doctor's own richer word leads each line, exactly as it always did — SILENTLY INACTIVE and STALE
    // are what an operator needs in order to act, and flattening them to CANNOT_DETERMINE on screen would
    // spend the diagnostic precision `label` exists to keep. The text output is therefore unchanged; the
    // shared `outcome` beside it in --json is the one the exit code came from, and it is the last line.
    for (const r of out.rows) console.log(`  ${r.label.padEnd(18)} ${r.check.padEnd(34)} ${r.detail}`);
    console.log(`\n  → ${out.outcome}`);
  }
} else if (verb === 'removals') {
  for (const c of out.checks) console.log(`  ${c.outcome.padEnd(18)} ${c.check}: ${c.detail}`);
  console.log(`\n  scanned: ${out.scanned.files} file(s) matching ${out.scanned.extensions.join(' ')} under ${out.scanned.directories.join(', ') || '(nothing configured)'}`);
  if (typeof out.scanned.carried === 'number') {
    console.log(`  ${out.scanned.carried} of ${out.scanned.files} file(s) carried from the prior verdict; last full scan ${out.scanned.lastFullScanAt || 'never'} (\`--full\` re-derives every finding from the tree)`);
  }
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
} else if (verb === 'migrate') {
  if (out.error) console.error(`  ${out.error}`);
  for (const c of out.checks || []) console.log(`  ${c.outcome.padEnd(18)} ${c.check}: ${c.detail}`);
  if (out.plan && out.plan.entries && out.plan.entries.length) {
    console.log(`\n  ${out.plan.write ? 'SPLIT' : 'PLAN'} — ${out.plan.entries.length} decision file(s)${out.plan.write ? ' written' : ' would be written'}:`);
    for (const e of out.plan.entries) console.log(`    ${e.removal ? '⛔' : '  '} ${e.id} → ${e.file}`);
    console.log(`    monolith ${out.plan.write ? 'archived to' : 'would be archived to'} ${out.plan.archiveRel}; index ${out.plan.write ? 'rendered at' : 'would be rendered at'} ${out.plan.indexRel}`);
  }
  if (out.wrote && out.wrote.length) console.log(`  wrote: ${out.wrote.length} file(s)`);
  console.log(`\n  → ${out.outcome}`);
  process.exit(exitCodeFor(out.outcome));
} else if (verb === 'review-receipt') {
  if (out.wrote) console.log(`  wrote: ${out.wrote}`);
  console.log(`\n  → ${out.outcome}: ${out.detail}`);
  // A review nobody can re-check is not a review the ship may trust, so the refusal says so out loud.
  if (out.outcome === 'CANNOT_DETERMINE' && (out.mode === 'check' || out.mode === 'check-staged')) {
    console.log('  ⛔ NOT a pass. An absent, unreadable or unlocatable receipt establishes nothing about whether this tree was reviewed.');
  }
} else if (verb === 'memory') {
  if (out.error) console.error(`  ${out.error}`);
  else if (out.import) {
    const im = out.import;
    console.log(`  imported from ${im.file}`);
    console.log(`  provenance: ${im.verified ? 'VERIFIED' : 'UNVERIFIED'} — ${im.verifyDetail}`);
    console.log(`  ${im.considered} record(s) considered · ${im.imported} landed as candidate(s) · ${im.deduped} already present · ${im.refused.length} refused`);
    for (const r of im.refused) console.log(`  REFUSED ${r.sourceId}: ${r.fields.map((f) => `${f.field} (${f.kind} "${f.prefix}…")`).join('; ')} — the redaction fence blocked a field; not imported`);
    if (!im.verified) console.log('  ⛔ every imported lead carries the "provenance unverified" prefix and is an unverified lead until an audited promote; none was dropped.');
  }
  else if (out.ledger) {
    const L = out.ledger, c = L.counts;
    console.log(`  verified: ${c.verified}  ·  rejected: ${c.rejected}  ·  open: ${c.open}  ·  promoted: ${c.promoted}`);
    const anomalyOrder = [
      ['verified-without-entity', 'verified candidate(s) that promoted nothing — a broken promise'],
      ['entity-without-lineage', 'graph entit(ies) with no promotedFrom — unvouched, allowed'],
      ['verdicts-without-author', 'decided record(s) whose verdict has no author — legacy, counted not repaired'],
      ['lineage-target-missing', 'entit(ies) whose promotedFrom names no candidate in the store — not counted as promoted'],
      ['retracted', 'entit(ies) moved under memory/graph/_retracted/'],
      ['open-older-than-sessions', `open lead(s) older than ${L.staleOpenLeadSessions} savepoint cycle(s)`],
    ];
    let any = false;
    for (const [key, label] of anomalyOrder) {
      if (c[key] === 0) continue;
      any = true;
      const a = L.anomalies[key];
      const items = key === 'open-older-than-sessions' ? a.shown.map((x) => `${x.id} (${x.cycles} cycles, ${x.days}d)`) : a.shown;
      console.log(`  ${String(c[key]).padStart(4)}  ${label}`);
      for (const it of items) console.log(`        · ${it}`);
      if (a.more > 0) console.log(`        · …and ${a.more} more`);
    }
    if (!any) console.log('  no anomalies — every verdict has an author, every verified lead has an entity, every entity has lineage, no lead is stale');
    if (L.store.candidates !== 'OK' && L.store.candidates !== 'ABSENT') console.log(`  ⛔ the candidate store: ${L.store.candidatesReason || L.store.candidates}`);
  }
  else if (out.candidates) {
    for (const c of out.candidates) console.log(`  ${c.verificationState.padEnd(10)} ${c.klass.padEnd(14)} ${c.id}  ${c.claim.slice(0, 90)}`);
    console.log(`\n  ${out.candidates.length} candidate(s) — candidate: ${out.counts.candidate} · verified: ${out.counts.verified} · rejected: ${out.counts.rejected}`);
    for (const u of out.unreadable) console.log(`  UNREADABLE: ${u.file || JSON.stringify(u)}`);
  } else if (out.entity) {
    console.log(`  ${out.id} → ${out.entity} (${out.file})${out.alreadyPromoted ? ' [already promoted — idempotent no-op]' : ''}`);
  } else if ('alreadyRejected' in out) {
    console.log(`  ${out.id} rejected${out.alreadyRejected ? ' [already rejected — idempotent no-op]' : ''}`);
    if (out.retraction && out.retraction.outcome === 'RETRACTED') {
      console.log(`  ⛔ retracted ${out.retraction.entity} → ${out.retraction.retractedTo}`);
      for (const d of (out.retraction.dangling || [])) console.log(`     dangling relation left as-is: ${d.from} ${d.relation}`);
    } else if (out.retraction && out.retraction.outcome && out.retraction.outcome !== 'RETRACTED') {
      console.log(`  retract ${out.retraction.outcome}: ${out.retraction.detail || ''}`);
    }
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
} else if (verb === 'log') {
  if (out.error) console.error(`  ${out.error}`);
  else if (out.mode === 'append') {
    console.log(`  appended · digest ${out.digest} · ${out.rows} row(s) sealed`);
    if (out.reclaimed) console.log(`  reclaimed ${out.reclaimed}`);
  }
  else if (out.mode === 'repair-tail') {
    if (out.discarded !== undefined) {
      console.log(`  discarded torn tail (digest ${out.discardedDigest}): ${String(out.discarded).slice(0, 120)}`);
      console.log(`  recorded the repair · digest ${out.digest} · ${out.rows} row(s) sealed`);
    } else console.log(`  ${out.detail}`);
  } else if (out.mode === 'verify') {
    console.log(`  ${out.detail}`);
    if (out.firstBreak) console.log(`  ⛔ first bad row: ${out.firstBreak.reason}`);
  } else { // list
    for (const r of out.tail || []) console.log(`  ${String(r.at).slice(0, 19)}  ${String(r.by).padEnd(12)} ${r.action} → ${r.result}${(r.refs && r.refs.length) ? `  [${r.refs.join(', ')}]` : ''}`);
    console.log(`\n  ${out.detail}`);
    if (out.firstBreak) console.log(`  ⛔ first bad row: ${out.firstBreak.reason}`);
  }
  console.log(`\n  → ${out.outcome}`);
} else if (verb === 'incident') {
  if (out.error) console.error(`  ${out.error}`);
  else if (out.mode === 'new') {
    console.log(`  authored ${out.id} (status: ${out.record.status})`);
    if (out.candidateId) console.log(`  minted root-cause-fix candidate ${out.candidateId} - names the incident by id, not the fix body`);
    else if (out.candidateError) console.log(`  the root-cause-fix candidate was NOT minted: ${out.candidateError}`);
  } else if (out.mode === 'close') console.log(`  ${out.detail}`);
  else { // list
    for (const i of out.open || []) console.log(`  open   ${i.id}  ${String(i.signature).slice(0, 100)}`);
    for (const i of out.fixed || []) console.log(`  fixed  ${i.id}  ${String(i.signature).slice(0, 100)}`);
    if (!(out.open || []).length && !(out.fixed || []).length) console.log('  no incidents in memory/incidents/');
    for (const u of out.unreadable || []) console.log(`  UNREADABLE: ${u.file} (${u.status})`);
  }
  console.log(`\n  → ${out.outcome}`);
} else if (verb === 'feedback') {
  if (out.error) console.error(`  ${out.error}`);
  if (out.counts) {
    console.log(`  ${out.counts.considered} record(s) considered · ${out.counts.included} included · ${out.counts.excluded} excluded · ${out.counts.fieldsDropped} evidence field(s) dropped`);
    const p = out.provenance || {};
    console.log(`  provenance: pack ${p.packVersion || '(none — receiver reads CANNOT_DETERMINE)'} · receipt schema ${p.receiptSchemaVersion ?? '(none)'} · type ${p.projectType || '(none)'} · posture ${p.posture || '(none)'} · project ${p.projectId || '(minted on --out export)'}`);
    for (const r of out.included || []) {
      console.log(`  INCLUDE ${r.kind} ${r.sourceId} [${r.identifiers.join(', ')}]: ${(r.claim || r.observation || '').slice(0, 90)}${r.evidence.length ? ` (evidence: ${r.evidence.join(', ')})` : ''}`);
    }
    for (const r of out.excluded || []) console.log(`  EXCLUDE ${r.kind} ${r.sourceId}: ${r.reason}`);
    for (const b of out.blocked || []) console.log(`  BLOCKED ${b.kind} ${b.sourceId}: ${b.fields.map((f) => `${f.field} (${f.kind} "${f.prefix}…")`).join('; ')}`);
    if (out.wrote) console.log(`\n  wrote: ${out.wrote}`);
    else if (out.mode === 'preview') console.log(`\n  ${out.note}`);
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
    for (const c of out.capturedCandidates) console.log(`    · [${c.klass}] ${c.id}: ${String(c.claim).slice(0, 90)}${c.resembles ? ` (resembles ${c.resembles} — your call)` : ''}`);
  }
  // D4: leads the qualification rule already settled, so the receipt shows they were seen, not dropped.
  if (out.autoRejectedDuplicates && out.autoRejectedDuplicates.length) {
    console.log(`\n  ${out.autoRejectedDuplicates.length} lead(s) auto-rejected as already recorded (no review needed):`);
    for (const d of out.autoRejectedDuplicates) console.log(`    · ${d.ref}`);
  }
  if (out.observationUpdates && out.observationUpdates.length) {
    console.log(`\n  ${out.observationUpdates.length} existing entit(ies) grew an observation instead of minting a twin:`);
    for (const u of out.observationUpdates) console.log(`    · ${u.ref}`);
  }
  if (out.pendingObservationFolds && out.pendingObservationFolds.length) {
    console.log(`\n  ${out.pendingObservationFolds.length} existing entit(ies) have a new observation to fold on the next \`savepoint --write\` (a verify does not author the graph):`);
    for (const f of out.pendingObservationFolds) console.log(`    · ${f.ref}`);
  }
  // The incremental scan's freshness, so a verdict that was mostly carried from the prior, or never
  // fully re-derived, is visible here rather than only inside STATE.json. `--full` forces a full re-scan.
  if (out.removalsFreshness) {
    const f = out.removalsFreshness;
    console.log(`\n  removals: ${f.carried} of ${f.of} file(s) carried from the prior verdict; last full scan ${f.lastFullScanAt || 'never'}`);
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
  // G17: the savepoint's own ops-log row rides BESIDE the verdict, never inside it - a machine-local
  // record that reports whether it landed but never moves the exit code.
  if (out.opsLogAppend) console.log(`\n  ops log: ${out.opsLogAppend.detail}`);
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
