/*
 * RespawnPack · hooks/_contracts.js — THE ONE AUTHORITATIVE MODULE-CONTRACT SOURCE.
 *
 * NOT A HOOK (leading underscore — the counts fence excludes these).
 *
 * ⛔ WHY THIS FILE EXISTS, AND WHY IT LIVES HERE.
 *
 * `doctor` validated every shared module against a typed contract and reported a violation as BROKEN.
 * The hooks did not: `_boot.need()` only LOADED a module, and `_boot.arm()` only caught THROWS. A
 * contract violation does not have to throw — and the reported P0 is the case that does not:
 *
 *     module.exports.HIDDEN_PROGRAM = { wrongType: true }     // _shell.js still loads perfectly
 *
 *     doctor                                   hook-lib:_shell.js BROKEN, hook:index-guard.js BROKEN
 *     index-guard, `bash -c "$CMD"`, healthy   permissionDecision "deny" at native exit 0
 *     index-guard, `bash -c "$CMD"`, damaged   NO decision, "index-ownership checks were skipped",
 *                                              native exit 0 — the protected command is ALLOWED
 *
 * `parsed.unsupportedKind === shell.HIDDEN_PROGRAM` simply became false and control fell into the
 * permissive branch. Nothing threw, so nothing caught it. The same shape is available to every kind of
 * contract damage: a number becomes NaN, a boolean flips a branch, a Set that is no longer a Set makes
 * `.has()` throw only if that line is reached, and a missing value reads as "not configured".
 *
 * ⭐ SO THE CONTRACT IS CHECKED BEFORE POLICY LOGIC CONSUMES THE MODULE, AGAINST THE SAME DECLARATION
 * DOCTOR USES. Not a copy of it — THE SAME ONE. Two lists agreeing today is how the runtime and the
 * report come to disagree tomorrow, which is the failure this whole program keeps finding.
 *
 * ⛔ IT LIVES IN hooks/ BECAUSE THAT IS THE ONLY DIRECTION THAT RESOLVES. The kernel can require from
 * `hooks/` — it already does, for `_manifest.js` and `_artifact.js` — and the hooks CANNOT require from
 * the kernel, because the kernel sits at `kernel/lib/` in this repository and at
 * `.claude/respawnpack/lib/` on an installed target. A contract source in the kernel would be
 * unreachable from the hooks that need it most.
 *
 * ⛔ AND THE PREVIOUS VERSION OF THIS PARAGRAPH WAS FALSE, WHICH IS WHY IT IS SPELLED OUT. It said this
 * file and `_boot.js` were "the two modules a hook reaches before anything can protect it, so a defect
 * in EITHER is a raw crash". That is not what the code does, and it has not been for some time.
 * `_boot.need()` requires THIS file inside a `try`, and every damage mode below was reproduced on a real
 * disposable installed target at de7a87a — absent, invalid syntax, throwing at module scope, missing
 * `CONTRACTS`, missing `validate` — with the SessionStart hook warning at native exit 0 and the index
 * guard DENYING at native exit 0. `_boot.js` caught every one of them. A file whose failure is caught is
 * not irreducible, and describing it as irreducible overstates the blast radius of its own breakage.
 *
 * ⭐ SO THE THREE ROLES ARE NAMED, AND THEY ARE NOT THE SAME ROLE.
 *
 *   `_boot.js`            THE IRREDUCIBLE HOOK BOOTSTRAP. Nothing catches it, because it IS the catcher.
 *                         Break it and the hook dies at its first invocation — the one place that phrase
 *                         is true, and a fixture asserts it stays true.
 *   `_contracts.js`       A PROTECTED, LOAD-BEARING CONTRACT SOURCE. Load-bearing because without it no
 *                         module contract can be checked at all; protected because `_boot.need()` catches
 *                         its failure and the hook enters its declared conservative posture.
 *   every other shared    PROTECTED DEPENDENCIES. Same protection, same posture, reached through the same
 *   module                `need()`.
 *
 * ⛔ WHICH LEAVES ONE THING `_boot.js` MUST CHECK ITSELF, AND EXACTLY ONE. The contract source cannot
 * validate itself — a `CONTRACTS` that is an array, or a `validate` that is a string, is not a document
 * the validator can be asked about, because the validator is the thing that is missing. So `_boot.js`
 * carries the SMALLEST bootstrap-interface check: the two members `_boot` itself calls, and nothing more.
 * The rest of this file's declared contract — `satisfies`, `typeOf`, `BOOT_BOUNDARY`, `CONTRACT_SOURCE`
 * and the registry itself — is validated by the ordinary self-check in `need()`, because once those two
 * members are usable this module is just another entry in `CONTRACTS`. Duplicating the registry into
 * `_boot.js` would recreate the two-lists-that-agree-until-one-moves failure one layer lower.
 *
 * That is still why this file has NO dependencies (not even Node builtins), no I/O, and no logic beyond a
 * type predicate: the smallest surface that can carry the declaration. `kernel/lib/modhealth.js`
 * soft-requires it and, when it cannot be read, doctor says the contract source is unavailable rather
 * than quietly reporting every module as merely loadable.
 */

/** The seven types a declared export may have. `object` means a PLAIN object — not null, not an array, not a Set. */
const TYPES = ['function', 'string', 'number', 'boolean', 'array', 'set', 'object'];

/**
 * Does a value satisfy a declared contract type?
 *
 * ⛔ `set` is its own type because `typeof new Set()` is `'object'`. Declared as an object, a Set
 * degraded to `{}` would pass while `REJECTED.has(...)` throws at the first call — a wrong-typed export
 * reported healthy, which is the class this file exists to close.
 */
function satisfies(value, want) {
  if (want === 'array') return Array.isArray(value);
  if (want === 'set') return value instanceof Set;
  if (want === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set);
  return typeof value === want; // function · string · number · boolean
}

/** What a value actually is, in the same vocabulary — so a diagnostic can name it. */
const typeOf = (v) => (Array.isArray(v) ? 'array' : v instanceof Set ? 'set' : v === null ? 'null' : typeof v);

/**
 * Every way `mod` fails `contract`, as readable clauses. Empty means the module satisfies its contract.
 * @returns {string[]}
 */
function validate(mod, contract) {
  if (!contract) return [];
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return ['the module exported nothing usable'];
  return Object.entries(contract)
    .filter(([name, want]) => !satisfies(mod[name], want))
    .map(([name, want]) => `${name} (want ${want}, got ${typeOf(mod[name])})`);
}

/*
 * ⛔ THE DECLARATION ITSELF — every shared module the installer ships, with the type each export is
 * read as. Every name here has at least one REAL production consumer, derived from property accesses in
 * `kernel/` and `hooks/` and fenced in both directions by kernel/kernel.test.mjs, which also rejects
 * computed access outright rather than skipping what it cannot extract. Comments are stripped before
 * that derivation runs, because prose naming a call site is not a call site.
 */
const CONTRACTS = {
  // This file is a PROTECTED contract source, not an irreducible one: `_boot.need()` catches its
  // failure. Declared here so it is validated and reported exactly like any other shared module —
  // including by `need()`'s own self-check, which is what covers every member below except the two
  // `_boot.js` must check for itself.
  '_contracts.js': {
    BOOT_BOUNDARY: 'array', CONTRACT_SOURCE: 'string', CONTRACTS: 'object',
    satisfies: 'function', typeOf: 'function', validate: 'function',
  },
  // The irreducible bootstrap. Declared so doctor reports it like anything else; a defect in THIS one
  // is still a raw crash for a hook, which is the bounded limitation stated above.
  // degrade: read by hooks/dispatch.js (P4-T-15b), which degrades a whole PreToolUse group itself when a
  // check file is missing or the group is unknown; the other hooks reach it only through need()/arm().
  '_boot.js': { arm: 'function', need: 'function', observed: 'function', degrade: 'function' },

  '_runtime.js': {
    SPAWN_STALE_MS: 'number', alreadyStoppedOn: 'function', atomicWriteJSON: 'function',
    captureBaseline: 'function', markPrecompactConsumed: 'function', projectDir: 'function',
    projectRoot: 'function', readContract: 'function', readDurableState: 'function', readJSON: 'function',
    recordStop: 'function', runtimeDir: 'function', sessionDelta: 'function',
    // The savepoint receipt (field run §4). Load-bearing for stop-savepoint.js: without it the hook cannot
    // tell "never attempted" from "attempted and structurally blocked", and repeats an instruction
    // that cannot succeed once per turn. Declared so a broken one degrades the hook rather than
    // silently reverting it to the behaviour this fixed.
    readSavepointAttempt: 'function',
    // Read directly by stop-savepoint.js to tell "already said this about this blocker set" from a
    // fresh one — the branch key lives in the stop record, so the path has to be reachable.
    stopRecordPath: 'function',
    // The shared digest (P5-CT-7). stop-savepoint.js keys its delegation branch on the unattested
    // acceptance set the same way the blocked-savepoint branch keys on the kernel's blocker digest, and
    // it does so through THIS export rather than its own crypto call: a second hashing implementation
    // would be a second answer to "is this the same finding as last time", which is what the once-per-set
    // guard rests on. Declared, so a `_runtime.js` that lost it degrades the hook instead of leaving the
    // gate to hold a session on every turn.
    sha: 'function',
    // The one spelling of the bucket-key-to-path rule for `treeState().files`'s `W:`/`S:`/`U:`/`C:` keys.
    pathOf: 'function',
    takePrecompactHandoff: 'function', treeState: 'function', withLock: 'function',
  },
  '_cmd.js': {
    dequote: 'function', gitSubcommand: 'function', gitSubcommands: 'function', segments: 'function',
  },
  '_manifest.js': {
    sourceManifest: 'function', compareManifest: 'function', digestMap: 'function', compareDigestMap: 'function',
    // The one definition of "HEAD describes the same source as revision R" — read by the compiler to
    // bind `sourceRevision`, and by every freshness reader (boot, status, doctor, the Stop hook) to
    // compare against it. Undeclared, a `_manifest.js` that lost it would leave the compiler binding
    // strictly while doctor still called the module ACTIVE: the savepoint-lag false STALE, back, with
    // nothing reporting why.
    sourceRevisions: 'function',
    // The path half of the same rule, read by kernel/lib/aar.js (P2-O-2). `sourceRevisions` answers the
    // question from HEAD; an After Action Report has to ask it about a PAST revision — "did the
    // STATE.json committed there describe that revision" — and walks the commits itself. It classifies
    // each one through THIS export rather than a second copy of the prefix list, because two answers to
    // "is this commit savepoint-only" is exactly the drift the shared manifest exists to prevent.
    isSavepointOutput: 'function',
  },
  '_artifact.js': {
    REJECTED: 'set', loadGoalDoc: 'function', loadRequirements: 'function', readJSONClassified: 'function',
  },
  /*
   * The ONE reader of the project's declared posture (ADR-003). Its entry is SHORTER than the module's
   * export list, and that is this registry working as designed rather than an omission: the fence in
   * kernel/kernel.test.mjs compares a contract against the properties PRODUCTION MODULES ACTUALLY READ,
   * in both directions, so declaring `verdict` or `RESOLVER` today — while the only production consumer
   * is doctor's posture row, which calls `resolve` and nothing else — would be a contract entry with no
   * call site, which is a fence about nothing. `verdict` joins this entry on the day a rule consults it
   * (P3-K-10, P3-T-10a/b/c), and the fence is what makes that unforgettable rather than remembered.
   *
   * `verdict` joined at P3-K-10: `kernel/respawnpack.js` resolves the posture once per verb and asks
   * this module for each day-one coverage row's cell. `RESOLVER` and `FIXED_IDS` still have no
   * production consumer, so they are still absent — for the same reason, on the same rule.
   */
  '_posture.js': { resolve: 'function', verdict: 'function' },
  /*
   * The ONE reader of the project's declared exceptions (P1-E-1a), and its entry is STILL shorter than
   * the module's export list for the reason `_posture.js`'s is: the fence in kernel/kernel.test.mjs
   * compares a contract against the properties PRODUCTION MODULES ACTUALLY READ, in both directions, so
   * declaring `EXCEPTION_RULES` today — while no production consumer reads it — would be a contract
   * entry with no call site, which is a fence about nothing.
   *
   * `allowed` and `fingerprint` joined this entry at P1-E-1b: `secret-scan.js` resolves the list once
   * per decision (`ctx.exceptions`, a memoised getter beside `profile`) and asks `allowed()` about every
   * HIGH hit's `{path, fingerprint}` subject, printing `fingerprint()` of the added line in the deny
   * message so a founder can paste the exact string back into `respawnpack.config.json`. The remaining
   * consumers land in E-1c (`injection-scan`) and E-1d (the four command- and path-shaped rules), each
   * with its own discrimination test.
   * `injection-scan.js` (P1-E-1c) consults `allowed()` lazily, on its Read branch only, once a hit exists.
   * `shell-guard`, `push-guard`, `worktree-guard` and `index-guard` (P1-E-1d) fingerprint the subject in
   * front of them and ask the same two members whether the founder declared it.
   *
   * ⛔ AND THE OMISSIONS ARE THE ENTRY WORKING, NOT AN OVERSIGHT. `EXCEPTION_RULES`, `SUBJECT_KINDS`,
   * `DIGEST_KINDS`, `ENTRY_FIELDS` and `isExpired` have TEST and SCHEMA readers only; declaring them
   * would put five members in the contract that no shipped decision path would notice losing, which is
   * how a typed contract stops meaning anything. They join the day production reads one.
   */
  '_exceptions.js': { resolve: 'function', allowed: 'function', fingerprint: 'function' },
  '_shell.js': {
    // ⛔ THE REPORTED P0. A wrong-typed constant here silently un-guarded `bash -c "$CMD"`.
    HIDDEN_PROGRAM: 'string', parseProgram: 'function', redefinesExecution: 'function',
  },
  '_git-effect.js': { classify: 'function', intersectForeign: 'function' },
  '_index-lease.js': {
    acquire: 'function', confirm: 'function', foreignStates: 'function', indexIdentity: 'function',
    principal: 'function', recordOwned: 'function', release: 'function', releaseAll: 'function',
    // No `const lease = require(...)` binding anywhere — hooks/_runtime.js reaches it as
    // `require('./_index-lease.js').withLock(...)`, delegating so there is ONE lock implementation.
    withLock: 'function',
  },
};

/*
 * ⛔ THE IRREDUCIBLE SET, AND IT IS ONE FILE. This used to name two, and the second one was wrong: a
 * broken `_contracts.js` degrades every hook conservatively because `_boot.need()` catches it, which is
 * the opposite of irreducible. Consumers read this to decide which files must be EXCLUDED from a
 * degradation sweep — so listing a protected module here would have quietly excused it from the very
 * matrix that proves it degrades. It did, until this correction.
 */
const BOOT_BOUNDARY = ['_boot.js'];

/**
 * The protected, load-bearing contract source — this file. Named rather than spelled as a literal in
 * `modhealth.js` and `doctor`, so the one component whose row must be unique is identified from one place.
 */
const CONTRACT_SOURCE = '_contracts.js';

module.exports = { CONTRACTS, TYPES, BOOT_BOUNDARY, CONTRACT_SOURCE, satisfies, typeOf, validate };
