/*
 * RespawnPack · kernel/lib/modhealth.js — "does this module actually load, and does it still export the
 * contract its readers call?"
 *
 * ⛔ WHY IT EXISTS. `doctor` decided a shared hook module was ACTIVE by asking `fs.existsSync()`. On a
 * real installed target `_manifest.js` was left in place and edited into invalid JavaScript:
 *
 *     doctor                          → PASS, exit 0
 *     hook-lib:_manifest.js             ACTIVE
 *     hook:session-routing-nudge.js     ACTIVE
 *     the real SessionStart hook      → exit 1, SyntaxError loading _manifest.js
 *
 * "The file is there" is not "the module loads" — the same substitution as "files were copied" for "the
 * feature is active", which is the exact failure `doctor` was built to catch, made by `doctor` itself.
 *
 * ⛔ AND THE SOFT REQUIRES COLLAPSED FIVE STATES INTO ONE `null`. Every kernel reader of
 * `hooks/_manifest.js` guards its require with `catch { null }`. That is right for "keep running" and
 * wrong for "say what happened": absent, unparseable, and throwing-at-load all arrived as the same falsy
 * value — and a module that loaded WITHOUT `compareManifest` never went through the catch at all. It
 * arrived TRUTHY, and killed `doctor` with a raw `TypeError` at `respawnpack.js:310` having printed zero
 * rows. The one component whose job is describing breakage was the one that could not describe it.
 *
 * Five states, never four, and never a boolean:
 *   OK                loads, and every export its contract names is callable
 *   ABSENT            no file at that path
 *   INVALID_SYNTAX    present, and THIS FILE'S OWN SOURCE does not parse
 *   LOAD_ERROR        present and parseable, but it threw while loading — its own bad require, a
 *                     dependency that does not parse, or a module-scope throw of ANY error type
 *   INVALID_CONTRACT  loads, but an export its readers call is missing or is not a function
 *
 * ⛔ TWO QUESTIONS, ASKED SEPARATELY, IN ORDER. Parsing is settled by compiling this file; loading is
 * settled by evaluating it. They used to be one `catch` and an `instanceof SyntaxError`, which made the
 * classifier assert things about a file's source that its source did not support — see `compileSource`.
 *
 * ⛔ `module` IS NULL FOR EVERY NON-OK STATUS, INCLUDING INVALID_CONTRACT. The readers already treat a
 * null manifest as "the digests cannot be computed" — CANNOT_DETERMINE, never "unchanged". Handing back
 * a half-usable object would reopen the crash this closes, one call deeper.
 *
 * ⛔ THE CLAIM IS NARROWED TO WHAT A REQUIRE ACTUALLY PROVES. This loads the module in THIS process, so
 * it answers "does it load and export its contract" — not "does every function in it behave". A module
 * that did operational work at module scope would do that work here; the six shared modules this is
 * pointed at do not (a fixture asserts that a `doctor` run leaves an installed target byte-identical),
 * and a future module that did would have to be probed out-of-process instead.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OK = 'OK';
const ABSENT = 'ABSENT';
const INVALID_SYNTAX = 'INVALID_SYNTAX';
const LOAD_ERROR = 'LOAD_ERROR';
const INVALID_CONTRACT = 'INVALID_CONTRACT';
const STATUSES = [OK, ABSENT, INVALID_SYNTAX, LOAD_ERROR, INVALID_CONTRACT];

/*
 * ⛔ THE AUTHORITATIVE KERNEL SUBSYSTEM REGISTRY. ONE LIST, FOUR CONSUMERS, NO SECOND COPY.
 *
 * `doctor` took its kernel inventory from `readdirSync(kernelLibDir)`, so a DELETED subsystem did not
 * become BROKEN — it vanished from the report. Deleting `lib/gate.js` produced `→ PASS` at exit 0 with
 * no `kernel-lib:gate.js` row, while `gate --json` failed and told the user to run the doctor that had
 * just said nothing was wrong. That is the same absence error corrected for hooks one round earlier,
 * repeated one layer deeper: an inventory built from what is present cannot report an absence.
 *
 * And loadability was the whole check, so a subsystem could load having lost the function that makes
 * its feature work. `gate.js` without its `runGate` export reported `ACTIVE — present and loads` while
 * the real verb died on `TypeError: gateLib.runGate is not a function`.
 *
 * So each entry names the installed FILE and every export a PRODUCTION MODULE actually reads, with the
 * type it is read as. These are derived from real property accesses, not from memory, and a fence in
 * kernel/kernel.test.mjs re-derives them from the source and fails on any drift in either direction.
 *
 * ⛔ "EVERY EXPORT `respawnpack.js` READS" WAS THE WRONG SCOPE, AND IT SHIPPED A HOLE. The CLI is not the
 * only production consumer: kernel modules call each other. `closeout.js` calls
 * `stateLib.readGoalDocClassified` and `stateLib.SCHEMA_VERSION`; `removals.js` and `closeout.js` call
 * `assert.foldCase` and `assert.liveDocument`. None of those were declared, because the fence only ever
 * looked at one file. Reproduced on a real installed target at 6869874: removing ONLY
 * `readGoalDocClassified` from state.js gave `kernel-lib:state.js ACTIVE`, `kernel-lib:closeout.js
 * ACTIVE`, doctor PASS at exit 0 — while `contract complete` died on
 * `TypeError: stateLib.readGoalDocClassified is not a function`. The scope is now every production
 * module in both trees, and the fence derives its handles from require/lazyLib/probePath bindings.
 *
 * The same registry drives: the lazy subsystem loading in respawnpack.js, doctor's EXPECTED inventory,
 * the contract validation below, the diagnostics, and that fence. A second filename or export list
 * anywhere else is itself a defect, and the fence checks for one.
 *
 * ⛔ IT LIVES HERE ON PURPOSE — this file is already one of the three bootstrap files, so the registry
 * adds no fourth thing that must load before doctor can speak. See BOOTSTRAP below.
 */
const SUBSYSTEMS = {
  state: {
    file: 'state.js',
    exports: {
      // SCHEMA_VERSION and readGoalDocClassified are read by closeout.js, never by respawnpack.js —
      // which is exactly why they were missing while a fence scoped to the CLI reported no drift.
      SCHEMA_VERSION: 'string', STATE_DIR: 'string', STATE_FILE: 'string', compile: 'function',
      read: 'function', readGoalDoc: 'function', readGoalDocClassified: 'function',
      write: 'function', writeAtomic: 'function', writeGoalDoc: 'function',
    },
  },
  render: {
    file: 'render.js',
    exports: {
      NOTE_CLOSE: 'string', NOTE_OPEN: 'string', driftFromGenerated: 'function',
      // The generated block's closing marker, read by respawnpack.js's wave-ledger fold (I-3): the folded
      // ledger goes INSIDE the generated block, just above this marker, so a render.js that spelled the
      // marker differently would put the fold outside the block driftFromGenerated compares.
      GEN_CLOSE: 'string',
      // Its opening twin, read by kernel/lib/aar.js (P2-O-2): an After Action Report is a derived
      // document like the other two, so it opens the SAME generated block rather than a report-shaped
      // imitation of one. Undeclared, a render.js that renamed the marker would leave the report
      // carrying a block no reader of the generated-block contract recognises (anti-drift item 7).
      GEN_OPEN: 'string',
      // The note budget, enforced out loud: savepoint plans the bounded NOTE block (to archive the full
      // text before the cut) and emits the `note:budget:<file>` row from it. A render.js that lost either
      // would truncate silently again — exactly the defect these two exports closed.
      noteBudgetCheck: 'function', planMigration: 'function', planNote: 'function',
      // planMigration's inverse — what makes `restore-derived` possible, and therefore what makes the
      // migration something anyone will run (field run §1: a one-way door stays shut, so exit 2 was permanent).
      planRestore: 'function',
      renderContinuity: 'function', renderGaps: 'function', verifyRendered: 'function',
      // P2-O-3, the lessons register — and it is declared as a PAIR on purpose. Its counts come from the
      // memory store rather than STATE.json, so `verifyRendered`'s `countMap(state)` could never check
      // them; a render.js that shipped `renderLessons` without `verifyLessons` would be a third derived
      // document full of numbers nothing compares against its source, which is DF-011 exactly.
      renderLessons: 'function', verifyLessons: 'function',
    },
  },
  // K-09 removed `EXIT`: the gate no longer carries an exit map of its own, so respawnpack.js reads
  // only the computation and takes the exit code from lib/outcome.js like every other verb.
  // P3-K-07b adds `POSTURE_ROW`, the ONE ADR-003 id this file carries (`kernel:R9`): respawnpack.js
  // takes the decision — it owns the single per-verb resolution — and asks gate.js which row it is
  // taking it about, rather than spelling `kernel:R9` a second time beside the call.
  gate: { file: 'gate.js', exports: { POSTURE_ROW: 'string', runGate: 'function' } },
  removals: {
    file: 'removals.js',
    exports: {
      readConfig: 'function', runRemovalScan: 'function',
      // The file-component normaliser, read by respawnpack.js's `render:` rows and by render.js's
      // `rendered-claims:`/`generated-block:`/`note:budget:` rows (BUG-2 / K-02) — one posix() rather
      // than a second copy growing in render.js.
      posix: 'function',
      /*
       * The containment trio, read by kernel/lib/lineage.js. removals.js's own header exports these so
       * that any other path-taking surface in the kernel reaches the SAME check instead of growing a
       * copy, and the provenance contract is exactly such a surface: every source `path` and every
       * derivation `target` is a project-relative string somebody typed, and one that resolves outside
       * the project through a symlink would let a "source of truth" live where the project does not own
       * it. They are declared here now because a real production module reads them; before P2-P-1 the
       * only caller was ops/sweep-scratch.mjs, which this fence's sweep does not reach.
       */
      containedResolution: 'function', hasParentSegment: 'function', portableAbsolute: 'function',
    },
  },
  /*
   * ⭐ CLASS D · THE PROVENANCE CONTRACT (P2-P-1). Not gated by any profile: ADR-003's table carries no
   * row for it, so every install places it and its absence is BROKEN in every profile — the same
   * position `living` and `memory` are in, and the reason neither of them carries a `postureRow` either.
   */
  lineage: {
    file: 'lineage.js',
    exports: {
      // checkLineage is read by BOTH state.js (to compile the STATE.json block) and respawnpack.js (the
      // verb, and the re-check a writing savepoint pays for); readLineage is read only by doctor, which
      // must be able to say whether a declaration EXISTS without recomputing a single source digest.
      checkLineage: 'function', readLineage: 'function',
      // seed (P2-P-2) and stamp (P2-P-3) are read only by respawnpack.js's own sub-verbs — `lineage seed`
      // and `lineage stamp` — never by state.js's compiler, which has no reason to propose or write.
      seed: 'function', stamp: 'function',
    },
  },
  /*
   * ⭐ CLASS C · OUTPUT SHAPED FOR A HUMAN (P2-O-2). Not gated by any profile, for the same reason
   * `lineage`, `living` and `memory` are not: ADR-003's rule table carries no row for it, so every
   * install places it and its absence is BROKEN everywhere. `compose` is the whole contract — the
   * report's paths, sections and window rules are this module's own business, and a caller that could
   * reach into them would be a second author of the same document.
   */
  aar: { file: 'aar.js', exports: { compose: 'function' } },
  closeout: {
    file: 'closeout.js',
    exports: {
      // `DELEGATION_LOG_REL` and `readDelegationArchive` are read by kernel/lib/aar.js, which reports
      // the closed delegations inside a window through the SAME classified reader the closure uses —
      // a report that read the archive its own way could disagree with the thing that wrote it about
      // whether a delegation was ever closed.
      DELEGATION_LOG_REL: 'string', readDelegationArchive: 'function',
      RUNTIME_REL: 'string', activeOf: 'function', completeDelegation: 'function',
      // ⛔ `readRuntimeClassified`, not `readRuntime`. The CLI reads the runtime contract through the
      // CLASSIFIED reader now, because the convenience shape cannot distinguish "no contract file" from
      // "a contract file that could not be read" — and reporting the second as the first is how an
      // unreadable file ends an autonomous run on paper while it continues in fact.
      completeGoal: 'function', readRuntimeClassified: 'function', writeRuntime: 'function',
    },
  },
  memory: { file: 'memory.js', exports: { distribution: 'function', probe: 'function' } },
  living: {
    file: 'living.js',
    exports: { CANARIES: 'array', enable: 'function', regenerate: 'function', reset: 'function', survey: 'function' },
  },
  // `foldCase` and `liveDocument` are read by closeout.js and removals.js — kernel-to-kernel calls the
  // CLI never makes, and therefore invisible to the old CLI-scoped fence.
  assert: { file: 'assert.js', exports: { discriminates: 'function', foldCase: 'function', liveDocument: 'function' } },
  reconcile: {
    // `readConfigClassified` is read by applicability.js: the applicability survey answers "has anybody
    // decided" from the DECLARATION alone and must not run a reconciliation to find out, so it needs the
    // classified reader rather than the verdict.
    file: 'reconcile.js',
    /*
     * ⛔ THE ONE SUBSYSTEM WHOSE PRESENCE IS A PROFILE'S DECISION (P3-K-14), AND THE ROW THAT DECIDES IT.
     *
     * ADR-003's rule table reads `kernel:R4 reconcile | n.a., not installed | advise | deny`, so
     * `install/install.js` places this file for `standard` and `strict` and not for `light`. `doctor`
     * therefore has to be able to tell "the profile did not install it" from "it is missing where the
     * profile expects it" — the first is a NOT_APPLICABLE row naming the posture, the second is BROKEN,
     * and collapsing them either way is a lie in one direction or the other.
     *
     * ⭐ THE ROW ID IS DECLARED, THE ANSWER IS DERIVED. Nothing here says which profiles place the file:
     * that is `hooks/_posture.js`'s cell for this row, asked at the point of use, exactly as
     * `install/_settings-manifest.js` derives an inert hook entry rather than listing one. A subsystem
     * with no `postureRow` is placed by every profile, and its absence is BROKEN in every profile — which
     * is why `living` and `memory` carry no key here: ADR-003's table gates neither.
     */
    postureRow: 'kernel:R4',
    exports: { readConfigClassified: 'function', runReconciliation: 'function', surveyReconciliation: 'function' },
  },
  /*
   * The browsable projection of a repository's documents (P3-O-4b). Two exports, because the verb reads
   * exactly two things: `buildSite` writes the pages under its output directory, and `serve` puts that
   * directory on the loopback interface. `renderMarkdown` — the module's third export, and the whole of
   * P3-O-4a — is deliberately NOT declared: `respawnpack.js` never calls it, and a contract entry with no
   * production call site is a fence about nothing, which the registry drift check in
   * kernel/kernel.test.mjs enforces in both directions. It joins this list on the day a verb reads it.
   */
  site: { file: 'site.js', exports: { buildSite: 'function', serve: 'function' } },
  applicability: {
    // `relaxCoverage` is read by respawnpack.js's savepoint: the coverage rows removals.js and
    // reconcile.js own are relaxed by the SAME survey that decided the rest, so ADR-003's posture
    // decision is taken once per verb rather than once per subsystem.
    // `relaxes` is the same decision for the four kernel rows that are NOT coverage rows — the gate's
    // no-build-system verdict, the NOTE budget, an unmigrated derived doc and an unknown --candidate
    // klass. It is exported so "which resolutions and which verdicts relax" has exactly one definition
    // rather than a second `new Set(['off','advise'])` growing in respawnpack.js (P3-K-07b).
    file: 'applicability.js',
    exports: { coverageChecks: 'function', relaxCoverage: 'function', relaxes: 'function', survey: 'function' },
  },
  /*
   * P2-Q-2. `POSTURE_ROW` is the ONE ADR-003 id this file carries (`kernel:readiness`), read the way
   * `gate.js`'s already is: respawnpack.js takes the decision — it owns the single per-verb posture
   * resolution — and asks readiness.js WHICH row it is taking it about, rather than spelling the id a
   * second time beside the call. Two readers reach `runReadiness`, the verb and doctor's row, and both
   * hand it the same already-decided posture and the same already-resolved exception list.
   */
  readiness: { file: 'readiness.js', exports: { POSTURE_ROW: 'string', runReadiness: 'function' } },
};

/*
 * The three files that load before anything can report on them. A defect in one of these is a raw
 * crash, not a row, and that is stated rather than papered over — see kernel/README.md. They are named
 * here so doctor can label them instead of quietly reporting them like any other file.
 */
const BOOTSTRAP = ['respawnpack.js', 'outcome.js', 'modhealth.js'];

/**
 * Installed filename → the ADR-003 row whose `n.a.` cell means "this profile does not install it".
 * DERIVED from the registry above, so the gated set has exactly one declaration and a reader cannot
 * disagree with it (P3-K-14). Empty of everything but the subsystems ADR-003's table actually gates.
 */
const PROFILE_GATED = Object.fromEntries(
  Object.values(SUBSYSTEMS).filter((s) => s.postureRow).map((s) => [s.file, s.postureRow]),
);

/*
 * ⛔ THE SHARED-MODULE CONTRACTS ARE NOT DECLARED HERE. THEY ARE READ FROM THE ONE SOURCE THE HOOKS
 * CAN ALSO READ.
 *
 * They used to live in this file, and the hooks had no access to them — so `doctor` validated a typed
 * contract while `_boot.need()` only checked that the module LOADED. Reproduced at c398416:
 * `_shell.HIDDEN_PROGRAM` retyped to an object left doctor reporting `hook-lib:_shell.js BROKEN` and
 * `hook:index-guard.js BROKEN` while the live guard ALLOWED `bash -c "$CMD"` — a healthy DENY turned
 * into a bypass. Two declarations would only have agreed until one of them moved.
 *
 * `hooks/` is the one direction that resolves: the kernel already requires `_manifest.js` and
 * `_artifact.js` from there, and the hooks cannot require from the kernel at all.
 *
 * ⛔ SOFT-REQUIRED, AND ITS ABSENCE IS REPORTED RATHER THAN ABSORBED. This file is a bootstrap file and
 * must be able to describe its own breakage, so it does not die when the contract source is missing —
 * but it must not silently fall back to "loadability is the whole claim" either, because that is the
 * exact weakening this program has now corrected twice. `contractSource.ok` is false, every contract
 * lookup returns null, and `doctor` emits an explicit row saying every shared-module verdict below is
 * loadability-only.
 */
const CONTRACTS_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_contracts.js');
let contractSource = { ok: true, detail: null };
/*
 * ⛔ THE HANDLE IS BOUND ONCE AND NAMED DISTINCTIVELY, AND BOTH OF THOSE ARE DELIBERATE. The registry
 * drift fence derives contract consumers by finding `<handle>.<prop>` — so re-binding through an
 * intermediate hides accesses from it (`typeOf` went unseen for exactly that reason), and a one-letter
 * handle collides with every unrelated local of the same name (`c.map` in `normaliseContract` below was
 * read as an access on this module). A fence that cannot see a call site cannot police it.
 */
let contractSrc = null;
try {
  contractSrc = require(CONTRACTS_PATH);
  /*
   * ⛔ `!contractSrc.CONTRACTS` WAS A TRUTHINESS TEST WHERE A TYPE WAS REQUIRED, AND THE WHOLE FILE
   * EXISTS BECAUSE THAT SUBSTITUTION IS NOT SAFE. Reproduced at de7a87a on a real installed target:
   * `module.exports.CONTRACTS = ['not','an','object']` is TRUTHY, so this guard passed, `SHARED` became
   * an array, `{ ...SHARED }` spread it to `{0:…,1:…,2:…}`, `contractFor()` returned null for every real
   * module — and doctor reported every shared module ACTIVE on loadability alone, at `→ PASS`, exit 0,
   * WITHOUT the "contracts are unavailable" row that exists to say the claim just got weaker. The report
   * and the runtime degraded together and neither said so. The same shape as the wrong-typed
   * `HIDDEN_PROGRAM` this file's own header describes, in the file that describes it.
   */
  /*
   * ⛔ EVERY ACCESS WRITTEN OUT LITERALLY, ON PURPOSE. The registry drift fence in kernel/kernel.test.mjs
   * derives this file's contract consumers by finding `contractSrc.<prop>`, and REFUSES a computed
   * `contractSrc[name]` rather than skipping it — an access a fence cannot see is an access it cannot
   * police. A tidy `['satisfies','typeOf','validate'].filter(n => …contractSrc[n]…)` was written here
   * first and the fence rejected it, which is the fence doing its job.
   */
  // Ordered so nothing is dereferenced before it has been established. A module is free to
  // `module.exports = null`, and answering that with a raw TypeError would bury the real diagnosis.
  if (!contractSrc || typeof contractSrc !== 'object') throw new Error('it exported nothing usable');
  if (contractSrc.CONTRACTS === null || typeof contractSrc.CONTRACTS !== 'object' || Array.isArray(contractSrc.CONTRACTS)) {
    throw new Error(`CONTRACTS is ${Array.isArray(contractSrc.CONTRACTS) ? 'an array' : `a ${contractSrc.CONTRACTS === null ? 'null' : typeof contractSrc.CONTRACTS}`}, not the declaration object every lookup indexes`);
  }
  const missing = [
    typeof contractSrc.satisfies !== 'function' ? 'satisfies' : null,
    typeof contractSrc.typeOf !== 'function' ? 'typeOf' : null,
    typeof contractSrc.validate !== 'function' ? 'validate' : null,
  ].filter(Boolean);
  if (missing.length) throw new Error(`it loads but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not callable`);
} catch (e) {
  contractSource = {
    ok: false,
    detail: `hooks/_contracts.js could not be used (${(e && e.message) || e}) — the shared-module contracts are UNAVAILABLE, `
      + 'so every shared module below is reported on loadability alone. That is a strictly weaker claim than usual.',
  };
  contractSrc = null;
}

const SHARED = (contractSrc && contractSrc.CONTRACTS) || {};

/*
 * The hook tree's IRREDUCIBLE bootstrap — one file. A defect in it is a raw crash, because it is what
 * makes the rest safe. This used to read `['_contracts.js', '_boot.js']` here and in the source, and the
 * second entry was false: `_boot.need()` catches a broken contract source and the hook degrades. The
 * consequence was not cosmetic — `install/install.test.mjs` SKIPS this set in its degradation sweep, so
 * naming `_contracts.js` here excused the contract source from the matrix that proves it degrades.
 */
const HOOK_BOOTSTRAP = (contractSrc && contractSrc.BOOT_BOUNDARY) || ['_boot.js'];

/**
 * The protected, load-bearing contract source. Read from the declaration so `doctor` and this file agree
 * on which component owns the contract-source verdict, rather than spelling the name in three places.
 */
const CONTRACT_SOURCE = (contractSrc && contractSrc.CONTRACT_SOURCE) || '_contracts.js';

/*
 * ⛔ THE ONE DEPENDENCY MODEL, SPANNING BOTH INSTALLED TREES.
 *
 * Doctor walked `require('./x.js')` edges to decide whether a module's DEPENDENTS are broken, and that
 * regex is complete for siblings and blind to everything else. The kernel does not reach the hook tree
 * by `require('./…')` — it resolves across the one relative path both layouts share and probes it:
 *
 *     const ARTIFACT_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_artifact.js');
 *     const artifact = modhealth.probePath(ARTIFACT_PATH).module;
 *
 * So on a real installed target at 30a6ec5, `_artifact.js` minus `loadRequirements` gave
 * `hook-lib:_artifact.js BROKEN` and every dependent HOOK broken, beside `kernel-lib:state.js ACTIVE`
 * and `kernel-lib:closeout.js ACTIVE` — while the real `state` verb refused at exit 2 because that same
 * boundary was unavailable. Doctor and the verb disagreed about the same file.
 *
 * ⭐ DERIVATION WHERE DERIVATION WORKS, DECLARATION ONLY WHERE IT CANNOT. Sibling edges stay derived
 * from source in BOTH trees — a list of those would be the hand-maintained copy that drifts. Only the
 * cross-tree edges, which no sibling regex can see, are declared; `kernel/kernel.test.mjs` re-derives
 * them from the real `path.resolve(..., 'hooks', 'x.js')` sites and fails in BOTH directions, so an
 * unregistered production dependency and a stale declared edge are each a failure.
 *
 * `dependencyGraph()` below is the single consumer-facing model. Doctor uses it for both trees; nothing
 * else walks requires.
 */
const CROSS_TREE = {
  'state.js': ['_manifest.js', '_artifact.js'],
  'removals.js': ['_manifest.js'],
  // The provenance contract reads its declaration, and every `.lineage.json` sidecar, through the same
  // classified boundary — absent, unreadable and malformed stay three answers rather than one.
  'lineage.js': ['_artifact.js'],
  /*
   * The After Action Report reads three hook-tree modules and each one answers a question it must not
   * answer for itself: `_manifest.js` decides whether a commit changed nothing but savepoint output
   * (the rule that says whether a past STATE.json described its own revision), `_runtime.js` owns the
   * savepoint receipt's shape, and `_artifact.js` is the classified boundary the candidate records are
   * read through. A broken one of these means a section of the report is missing, which is a doctor
   * row and a CANNOT_DETERMINE inside the document, never a silently shorter report.
   */
  'aar.js': ['_manifest.js', '_runtime.js', '_artifact.js'],
  'closeout.js': ['_artifact.js'],
  // ⛔ The site's dashboard reads the compiled state through `readDurableState` and never raw, so that
  // the page and the boot banner can never disagree about whether a projection is current (anti-drift
  // items 5 and 53). Declared here because that edge is a probed `path.resolve(…, 'hooks', …)` and no
  // require-graph walk can see it — which is exactly the blindness this table exists to end.
  'site.js': ['_runtime.js'],
  // ⛔ This file reads the ONE contract declaration from the hook tree, so a broken `_contracts.js`
  // genuinely breaks it — and doctor should say so rather than labelling it bootstrap and moving on.
  'modhealth.js': ['_contracts.js'],
};

/** Comments stripped first: a require named in prose is not an edge. */
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/*
 * ⛔ THE PACK HAS TWO SPELLINGS FOR A SIBLING EDGE, AND BOTH ARE EDGES.
 *
 * `require('./x.js')` is the plain one. Every hook with shared dependencies now uses the other —
 * `boot.need('./x.js')` — because a bare require of a module that cannot load kills the hook before it
 * can emit its conservative answer. A derivation that knew only the first would have reported that the
 * hooks depend on nothing but `_boot.js`, silently un-covering every shared module the moment the
 * bootstrap boundary was introduced. (Observed, not theorised: it did exactly that for one run.)
 */
function siblingRequires(dir, file) {
  let text = '';
  try { text = stripComments(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return []; }
  const out = new Set();
  for (const m of text.matchAll(/require\('\.\/([\w.-]+\.js)'\)/g)) out.add(m[1]);
  for (const m of text.matchAll(/\.need\('\.\/([\w.-]+\.js)'\)/g)) out.add(m[1]);
  return [...out];
}

/**
 * The complete dependency graph over both installed trees, keyed by basename.
 *
 * Basenames are unambiguous by construction: every shared hook module is `_`-prefixed and no kernel
 * subsystem is. `kernel/kernel.test.mjs` asserts that, so the day it stops being true this fails rather
 * than silently merging two nodes.
 *
 * @returns {Map<string,{file:string,tree:'kernel'|'hooks',dir:string,deps:string[]}>}
 */
function dependencyGraph({ kernelLibDir, hookDir }) {
  const graph = new Map();
  const addAll = (dir, tree, filter) => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && filter(f)); } catch { return; }
    for (const file of names) {
      graph.set(file, {
        file, tree, dir,
        deps: [...new Set([...siblingRequires(dir, file), ...(CROSS_TREE[file] || [])])],
      });
    }
  };
  if (kernelLibDir) addAll(kernelLibDir, 'kernel', () => true);
  // ⛔ HOOKS ARE NODES TOO, not just the shared modules under them. A graph that held only the
  // libraries could not answer "is this hook broken", which is the question the hook rows ask — and
  // for one run it answered ACTIVE for a hook whose boundary module would not parse.
  if (hookDir) addAll(hookDir, 'hooks', () => true);
  return graph;
}

/**
 * Every node `file` transitively depends on, within the graph. Edges pointing at nodes the graph does
 * not contain are dropped — a dependency on something not installed here is not this walk's claim.
 */
function transitiveDeps(graph, file) {
  const seen = new Set();
  const queue = [...((graph.get(file) || {}).deps || [])];
  while (queue.length) {
    const d = queue.shift();
    if (seen.has(d) || d === file) continue;
    seen.add(d);
    queue.push(...((graph.get(d) || {}).deps || []));
  }
  return seen;
}

/*
 * The contract a module owes its readers, keyed by installed basename. Both registries fold in, so
 * there is exactly one place a contract is written down.
 *
 * A module with NO entry — an extra file someone dropped into an installed directory — is probed for
 * LOADABILITY only. RespawnPack has declared no API for it, so claiming its exports are wrong would be
 * inventing a contract; a smaller claim honestly made, never a silent pass. That exemption is for files
 * this pack does not ship: a SHIPPED module with real consumers is registered above, and the fence
 * fails if one is not.
 */
const CONTRACTS = { ...SHARED };
for (const s of Object.values(SUBSYSTEMS)) CONTRACTS[s.file] = s.exports;

const contractFor = (file) => CONTRACTS[path.basename(file)] || null;

/*
 * ⛔ ONE IMPLEMENTATION OF THE SEVEN TYPES, IN THE SAME FILE AS THE DECLARATION THAT USES THEM.
 *
 * These used to be defined here as well as being needed by the hooks, and two predicates that agree
 * today are how a runtime check and a report come to disagree about what `set` means. They are imported
 * from the contract source, and the local fallbacks below run ONLY when that source is unavailable —
 * a state `contractSource.ok` already reports, and in which `CONTRACTS` is empty so nothing is
 * validated against a second opinion.
 */
const satisfies = contractSrc ? contractSrc.satisfies : ((value, want) => typeof value === want);
const typeOf = contractSrc ? contractSrc.typeOf : ((v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v));

/*
 * A contract may be written as a list of names (every one a callable) or as a name→type map. The list
 * form is kept because that is what a reader means by "these functions must exist", and normalising
 * here means a caller never has to know which form a given module declared.
 */
const normaliseContract = (c) => (Array.isArray(c)
  ? Object.fromEntries(c.map((n) => [n, 'function']))
  : (c || null));
const firstLine = (e) => String((e && e.message) || e).split(/\r?\n/)[0].trim().slice(0, 300);

/*
 * Which file actually blew up, when it was not this one. A dependency's SyntaxError surfaces through
 * the root's `require` carrying only its own message ("Unexpected identifier"), and a row that prints
 * that beside the ROOT's name reads as an accusation against a file that is perfectly fine. Node puts
 * the real location on the first line of the stack; if it names something other than the module being
 * probed, the row says so.
 */
function originOf(e, abs) {
  const first = String((e && e.stack) || '').split(/\r?\n/)[0].trim();
  const m = /^(.*\.(?:js|cjs|mjs)):\d+$/.exec(first);
  if (!m) return null;
  try { return path.resolve(m[1]) === path.resolve(abs) ? null : path.basename(m[1]); }
  catch { return null; }
}

/*
 * ⛔ PARSING IS A QUESTION YOU ASK THE PARSER, NOT ONE YOU INFER FROM AN ERROR TYPE.
 *
 * `probe` used to classify by catching the require and testing `e instanceof SyntaxError`. That reads
 * as reasonable and asserts something the evidence never supported, in two ordinary cases:
 *
 *   · a perfectly parseable module containing `throw new SyntaxError('...')` was reported as
 *     "INVALID JAVASCRIPT — the parser rejected it". The parser accepted it. The module chose to throw.
 *   · a module whose DEPENDENCY fails to parse throws that dependency's SyntaxError through the root's
 *     require, so the root was accused of a syntax error it does not have — sending whoever reads the
 *     row to open the wrong file.
 *
 * So the two questions are now asked separately, in order. `compileSource` COMPILES and never
 * evaluates, which settles parsing for this file and this file only; anything that then goes wrong
 * during evaluation is a LOAD_ERROR whatever type it wears.
 */
function sourceOf(abs) {
  // Strip what Node itself strips before compiling: a BOM, and the shebang seven shipped hooks carry.
  return fs.readFileSync(abs, 'utf8').replace(/^﻿/, '').replace(/^#![^\n]*\n/, '\n');
}

const CJS_WRAPPER = ['exports', 'require', 'module', '__filename', '__dirname'];

/**
 * Does THIS file's own source parse? Compiles under the CommonJS wrapper and never runs it.
 * Returns { status: ABSENT | INVALID_SYNTAX | OK, detail } — no evaluation, no side effects.
 * This is the only claim available for an artifact that must not be executed (see `probeSource`).
 */
function compileSource(abs) {
  if (!fs.existsSync(abs)) return { status: ABSENT, detail: 'MISSING — no file at that path' };
  let src;
  try { src = sourceOf(abs); }
  catch (e) { return { status: LOAD_ERROR, detail: `UNREADABLE — ${firstLine(e)}` }; }
  try {
    vm.compileFunction(src, CJS_WRAPPER, { filename: abs });
  } catch (e) {
    return { status: INVALID_SYNTAX, detail: `INVALID JAVASCRIPT — the parser rejected it: ${firstLine(e)}` };
  }
  return { status: OK, detail: 'present, and its own source parses' };
}

/**
 * Probe one module by ABSOLUTE path. `required` is the list of export names its readers call.
 * Returns { status, module, detail } — `module` is the loaded module only when status is OK.
 *
 * ⛔ THIS EVALUATES THE MODULE. Correct for a library, never for a hook — a hook reads stdin and emits
 * allow/deny decisions, and running one to ask whether it runs is not a diagnostic. Use `compileSource`
 * for anything operational.
 */
function probe(abs, required) {
  // Existence is checked FIRST so a MODULE_NOT_FOUND raised by a dependency THIS module requires is
  // never reported as "absent". The file is right there; sending the reader to look for a file that
  // exists is its own wrong answer.
  const parsed = compileSource(abs);
  if (parsed.status !== OK) return { status: parsed.status, module: null, detail: parsed.detail };

  let mod;
  try {
    mod = require(abs);
  } catch (e) {
    // Its own source already compiled, so whatever this is, it is not this file failing to parse —
    // not even when it IS a SyntaxError, which is exactly how a dependency's failure arrives here.
    const where = originOf(e, abs);
    return {
      status: LOAD_ERROR,
      module: null,
      detail: `THREW WHILE LOADING — ${(e && e.constructor && e.constructor.name) || 'Error'}${where ? ` in ${where}` : ''}: ${firstLine(e)}`,
    };
  }
  /*
   * ⛔ THE TYPE IS PART OF THE CONTRACT, NOT DECORATION. Checking only that a name is callable misses
   * the constants — `livingLib.CANARIES`, `stateLib.STATE_DIR`, `closeoutLib.RUNTIME_REL` — which are
   * read exactly as often and fail exactly as hard. A module that loads with `CANARIES` turned into a
   * string is no more usable than one that lost `runGate`, and both are determinate:
   * INVALID_CONTRACT, never "unknown".
   */
  const want = normaliseContract(required);
  if (want) {
    const bad = Object.entries(want)
      .filter(([k, t]) => !mod || !satisfies(mod[k], t))
      .map(([k, t]) => `${k} (want ${t}, got ${mod ? typeOf(mod[k]) : 'nothing'})`);
    if (bad.length) {
      return {
        status: INVALID_CONTRACT,
        module: null,
        detail: `INVALID EXPORTS — it loads, but ${bad.join('; ')}. RespawnPack reads ${Object.keys(want).join(', ')}`,
      };
    }
  }
  const names = want ? Object.keys(want) : [];
  return {
    status: OK,
    module: mod,
    detail: names.length
      ? `present, loads, and exports the contract its readers call (${names.join(', ')})`
      : 'present and loads',
  };
}

/** `probe` with the contract looked up from the file's basename. */
const probePath = (abs) => probe(abs, contractFor(abs));

module.exports = {
  probe, probePath, compileSource, contractFor, satisfies, typeOf,
  dependencyGraph, transitiveDeps, siblingRequires,
  CONTRACTS, SUBSYSTEMS, SHARED, CROSS_TREE, BOOTSTRAP, PROFILE_GATED, HOOK_BOOTSTRAP, CONTRACT_SOURCE, STATUSES,
  contractSource, CONTRACTS_PATH,
  OK, ABSENT, INVALID_SYNTAX, LOAD_ERROR, INVALID_CONTRACT,
};
