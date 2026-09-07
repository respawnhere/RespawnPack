/*
 * RespawnPack · kernel/lib/state.js — the durable state compiler.
 *
 * Reads the project's STRUCTURED sources and emits docs/derived/STATE.json: live facts only, counts
 * recomputed from rows, and an explicit record of what it could not determine.
 *
 * ⛔ THE FOUR FAILURES THIS ENCODES, each from a dogfood run:
 *
 * 1. COUNTS CARRIED FORWARD (DF-011). A savepoint reported success while GAPS.md said 50 holes / 110
 *    mapped / 66 conformant against an actual 48 / 112 / 62. Every one of those numbers existed in
 *    machine-readable form; not one was compared against it. So: nothing here ever copies a count.
 *    Counts are a function of rows, computed on every run.
 *
 * 2. HAND-AUTHORED GATE DENOMINATORS (recommendation R-4). A gate that enumerates its own convenient
 *    subset gets EASIER when a requirement is omitted — the arithmetic rewards forgetting. So a gate's
 *    denominator comes from the approved requirement source, and a declared id with no backing row is
 *    a FAIL, never a smaller denominator.
 *
 * 3. EVIDENCE THAT OUTLIVES ITS REVISION (R-6). Evidence bound to revision A kept crediting the
 *    project at revision B. Freshness is checked against the current source revision, in one shared
 *    loader, so an individual tool cannot forget the rule.
 *
 * 4. THE IMPLEMENTER QUALIFYING ITS OWN WORK (R-3). An implementation and its unit test encoded the
 *    same mistaken assumption; the passing test was promoted to a completion claim. High-risk rows
 *    therefore cannot reach `conformant` on implementer-qualified evidence — they stop at
 *    `candidate`, which is a real status and not a synonym for done.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { OUTCOME, result } = require('./outcome.js');
// One definition of "an input changed", shared with the boot path. See that file's header for why it
// lives under hooks/ — it is the only path both trees resolve identically, in the pack and installed.
/*
 * ⛔ SOFT REQUIRE, BECAUSE DOCTOR MUST BE ABLE TO DESCRIBE ITS OWN BREAKAGE. `respawnpack.js` already
 * guarded its own require of this module — and that guard was UNREACHABLE, because this file is loaded
 * first and threw before it ran. A missing `hooks/_manifest.js` therefore killed `doctor` with a raw
 * MODULE_NOT_FOUND stack and zero rows, while three shipped surfaces said the case was handled. A
 * soft require in one file is not a soft require: every module on the path has to agree.
 *
 * `null` here is not "no digests" — callers must treat it as CANNOT_DETERMINE, never as "unchanged".
 *
 * ⛔ AND `catch { null }` NEVER SAW THE CASE THAT MATTERED. A require only throws when the module fails
 * to LOAD. A `_manifest.js` that loaded without `compareManifest` sailed past this guard as a truthy
 * object and killed its readers with a TypeError at first call. `modhealth.probePath` returns a null
 * module for that too, so the four unloadable shapes and the invalid-contract shape all land in the same
 * CANNOT_DETERMINE branch the callers already had — and the reason survives in `manifestHealth.detail`
 * instead of being flattened away. (`modhealth.js` is a SIBLING in this directory, placed by the same
 * installer step; the cross-tree module under hooks/ is the one that needs the guard.)
 */
const modhealth = require('./modhealth.js');
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_manifest.js');
const manifestHealth = modhealth.probePath(MANIFEST_PATH);
const manifest = manifestHealth.module;
const removalsLib = require('./removals.js');
/*
 * The provenance contract (Class D), compiled here for the same reason the removal scan is: BOOT and
 * SAVEPOINT must read one verdict about where this project's copies came from, rather than each forming
 * its own. Required outright rather than probed, like `removals.js` and unlike `reconcile.js`: ADR-003's
 * table gates no profile on it, so every install carries it and its absence is damage, not a decision.
 */
const lineageLib = require('./lineage.js');
/*
 * ⛔ THE RECONCILER IS PROBED, NOT REQUIRED, BECAUSE A PROFILE MAY NOT HAVE INSTALLED IT (P3-K-14).
 *
 * ADR-003's rule table reads `kernel:R4 reconcile → n.a., not installed` under `light`, so
 * `install/install.js` places `lib/reconcile.js` only for the profiles that carry the reconciliation
 * contract. A hard `require('./reconcile.js')` here would have turned that absence into a
 * MODULE_NOT_FOUND raised out of the COMPILER — which every verb loads — so a `light` target would have
 * lost `savepoint`, `state`, `status` and `contract` alike, and doctor would have printed a stack trace
 * where anti-drift item 17 requires a row. The boundary moves first and the placement follows it.
 *
 * Same shape as `_manifest.js` above and for the same reason: `modhealth.probePath` hands back a module
 * only for OK, so absent, unparseable, throwing-at-load and loaded-without-`runReconciliation` all reach
 * `compile()` as one null and become the SAME named CANNOT_DETERMINE row rather than four crashes. That
 * row carries `domain: 'coverage'`, so under a declared `light` posture
 * `applicability.relaxCoverage()` answers it as NOT_APPLICABLE exactly as it already answers an
 * unconfigured one — and under every other posture it stays CANNOT_DETERMINE at exit 2, because a
 * reconciler that is missing where the profile expects it is breakage, not a decision.
 */
const RECONCILE_PATH = path.join(__dirname, 'reconcile.js');
const reconcileHealth = modhealth.probePath(RECONCILE_PATH);
const reconcileLib = reconcileHealth.module;
/*
 * ⛔ THE ONE PRODUCTION ACCEPTANCE BOUNDARY. Soft-required for the same reason as `_manifest.js`: a
 * missing shared module must produce a diagnosable CANNOT_DETERMINE, not a raw MODULE_NOT_FOUND stack
 * out of a compiler. It lives under hooks/ because the kernel can require from there and the hooks
 * cannot require from here — so `_runtime.readContract`, this compiler, `closeout` and `doctor` all
 * apply LITERALLY THE SAME acceptance rules, rather than four implementations that agree today.
 */
const ARTIFACT_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_artifact.js');
const artifactHealth = modhealth.probePath(ARTIFACT_PATH);
const artifact = artifactHealth.module;

const SCHEMA_VERSION = '1.0.0';
const STATE_DIR = path.join('docs', 'derived', 'state');
const STATE_FILE = path.join('docs', 'derived', 'STATE.json');

// Claim types, weakest to strongest (recommendation R-13). Recorded so a unit-test success can never be
// summarized as an end-to-end capability.
const CLAIM_TYPES = ['untriaged', 'inferred', 'source-inspected', 'unit-tested', 'served-boundary tested', 'real-engine qualified', 'owner-waived'];

// Claim types that do not, on their own, qualify a high-risk requirement however green they are.
const DEV_ONLY_CLAIMS = new Set(['untriaged', 'inferred', 'source-inspected', 'unit-tested']);

// Routed through the retrying boundary for the same reason hooks/_runtime.js is: a transient
// replacement error must not be read as an absent artifact.
const readJSON = (p) => { const r = artifact ? artifact.readJSONClassified(p) : null; return r && r.status === 'OK' ? r.doc : null; };

/*
 * ⛔ ABSENT AND UNPARSEABLE ARE DIFFERENT ANSWERS, AND `readJSON` CANNOT TELL THEM APART.
 *
 * Both come back `null`, which meant a project whose requirements.json had been corrupted — a bad
 * merge, an interrupted write, a hand edit — compiled to `tracksRequirements: false`, `no approved
 * requirement source`, and exit 0. That is the sentence for a project that DELIBERATELY tracks no
 * denominator. The whole denominator vanished and the report read as a configuration choice.
 *
 * An absent file is a STATE. An unreadable one is a FAULT. Same shape on disk to `catch {}`, opposite
 * meanings to a reader.
 *
 * ⛔ THE FIRST FIX FOR THIS LIVED HERE, AS A SECOND LOCAL CLASSIFIER, AND THAT WAS THE DEFECT ONE
 * LAYER UP. It separated absent from unparseable for the COMPILER and left `readGoalDoc`,
 * `_runtime.readContract`, `closeout` and `doctor` each with their own rules — which is precisely how
 * an unsupported `goal.json` was refused nowhere and activated everywhere. The classification now
 * lives once, in `hooks/_artifact.js`, and every reader routes through it. `readJSON` below survives
 * only for documents that carry no acceptance contract at all.
 */

/*
 * ⛔ THE GOAL CONTRACT LIVES HERE, NOT IN RUNTIME STATE.
 *
 * An earlier cut of this work had TWO independent goal representations — `contract goal` wrote
 * .respawnpack/runtime/contract.json while the compiler read docs/derived/state/goal.json — and
 * nothing reconciled them. That is the precise failure ADR-001 exists to end, reintroduced by the
 * thing meant to fix it. The split now is by DURABILITY, not by topic:
 *   goal.json (tracked)      the durable contract — id, criteria, constraints, authority, forbidden
 *   contract.json (runtime)  which mode is active, which goal id, and which goal is suspended
 * So "collaborate for a minute" cannot destroy a goal, and a fresh clone still carries the contract.
 *
 * Legacy shape ({goal: "...", milestone, ...}) is read transparently: an existing project must not
 * have to migrate before its state compiles.
 */
function normalizeGoalDoc(raw) {
  const doc = raw || {};
  const goals = { ...(doc.goals || {}) };
  if (!Object.keys(goals).length && typeof doc.goal === 'string' && doc.goal.trim()) {
    goals['G-legacy'] = {
      id: 'G-legacy', goal: doc.goal,
      completion: Array.isArray(doc.completion) ? doc.completion : [],
      constraints: doc.constraints || [], authority: doc.authority || [], forbidden: doc.forbidden || [],
      externalBlockers: doc.externalBlockers || [], legacyShape: true,
    };
    if (!doc.activeGoalId) doc.activeGoalId = 'G-legacy';
  }
  return { ...doc, goals };
}

/*
 * Completion criteria, evaluated — not assumed.
 *
 * ⛔ Marking a goal complete because every mandatory row conformed is a DIFFERENT claim from the one
 * the owner made when they stated what "done" means. Field run B's whole failure mode was a
 * corrective milestone's arithmetic being reported as the project goal's completion, so the criteria
 * supplied through `contract goal --completion` are what decide this, and a criterion this compiler
 * cannot evaluate makes the goal CANNOT_DETERMINE — never complete.
 *
 * A free-text criterion is legitimate (some things only a human can judge). It is simply not
 * something a program may quietly rule in its own favour.
 */
function evaluateCriterion(raw, ctx) {
  const text = typeof raw === 'string' ? raw : (raw && raw.text) || JSON.stringify(raw);
  const spec = typeof raw === 'object' && raw ? raw : {};
  const norm = String(text).toLowerCase().trim();

  const met = (kind, detail) => ({ text, kind, status: 'MET', detail });
  const unmet = (kind, detail) => ({ text, kind, status: 'UNMET', detail });
  const unknown = (detail) => ({ text, kind: 'manual', status: 'CANNOT_DETERMINE', detail });

  const kind = spec.kind || (
    /^all[- ]mandatory[- ]conformant$/.test(norm) ? 'all-mandatory-conformant'
      : /^no[- ]open[- ]p0(\/p1)?$/.test(norm) ? (norm.includes('p1') ? 'no-open-p0p1' : 'no-open-p0')
        : /^gate[: ]/.test(norm) ? 'gate-complete'
          : /^owner[- ]confirmed/.test(norm) ? 'owner-confirmed' : null
  );

  if (kind === 'all-mandatory-conformant') {
    const { mandatory, conformant } = ctx.counts;
    return mandatory > 0 && conformant === mandatory
      ? met(kind, `${conformant}/${mandatory} mandatory conformant`)
      : unmet(kind, `${conformant}/${mandatory} mandatory conformant`);
  }
  if (kind === 'no-open-p0' || kind === 'no-open-p0p1') {
    const open = ctx.openP0P1.filter((id) => {
      const r = ctx.requirements.find((x) => x.id === id);
      return kind === 'no-open-p0p1' ? true : r && r.priority === 'P0';
    });
    return open.length ? unmet(kind, `still open: ${open.join(', ')}`) : met(kind, 'none open');
  }
  if (kind === 'gate-complete') {
    const id = spec.gate || String(text).split(/[: ]/)[1];
    const g = ctx.gates.find((x) => x.id === id);
    if (!g) return unknown(`no gate "${id}" in the approved source`);
    return g.status === 'COMPLETE' ? met(kind, `${id} complete`) : unmet(kind, `${id} is ${g.status}`);
  }
  if (kind === 'owner-confirmed') {
    const confirmed = (ctx.ownerConfirmations || []).some((c) => String(c.criterion || '').toLowerCase() === norm);
    return confirmed ? met(kind, 'owner confirmed') : unmet(kind, 'awaiting an explicit owner confirmation record');
  }
  return unknown('free-text criterion — only a human can judge this, so the compiler will not rule on it');
}

function gitRev(dir) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

/*
 * ⛔ `sourceRevision` IS THE REVISION OF THE SOURCE THE STATE DESCRIBES — NOT "HEAD WHEN WE RAN".
 *
 * The two used to be the same string, and the documented closeout breaks the identity on purpose:
 * commit the work (W), savepoint, commit the derived docs (S). A compile at S that bound itself to S
 * described exactly the same source as the one committed at W while disagreeing with it on every
 * surface — the rendered "Source revision" line, evidence bound at W, and every reader comparing
 * `sourceRevision === HEAD`. So the binding is the nearest ancestor that is NOT a savepoint-only
 * commit, as `hooks/_manifest.js` defines it (the one definition every reader shares). A re-run at S
 * therefore reproduces the state compiled at W byte-for-byte (except `generatedAt`), which is what
 * "the savepoint commit changes no source" has to mean to be true.
 *
 * When the shared module is unavailable or cannot answer, the binding is HEAD — the strict answer,
 * never a guessed equivalence.
 */
function sourceRevisionsOf(dir) {
  if (manifest) {
    try {
      const r = manifest.sourceRevisions(dir);
      if (r && r.head) return r;
    } catch { /* fall through to the strict binding */ }
  }
  const head = gitRev(dir);
  return { head, effective: head, chain: head ? [head] : [], savepointOnly: [], truncated: false, detail: head ? `HEAD ${head.slice(0, 7)}` : 'no HEAD' };
}

/*
 * ⛔ WINDOWS ANSWERS "THIS TARGET IS MOMENTARILY BUSY" WITH A PERMISSION ERROR.
 *
 * `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)` returns ERROR_ACCESS_DENIED when the destination is
 * open at that instant — by a concurrent reader, by another writer's replacement, or by an antivirus
 * scanner walking the file the moment it appeared. Node surfaces it as EPERM, indistinguishable at
 * the call site from a permanent permission fault.
 *
 * Reproduced, not theorised: six writers racing one STATE.json killed a child outright with
 * `EPERM: operation not permitted, rename '…STATE.json.33148.tmp' -> '…STATE.json'` — an uncaught
 * throw out of a function whose whole job is to make a write survivable. This is the SAME lesson
 * hooks/_index-lease.js already recorded for lock CREATION, one syscall over, and it was not applied
 * here because it was learned there.
 *
 * Retrying weakens nothing. A genuine permission fault still fails, a few milliseconds later, with
 * the same error and the same preserved target.
 */
const REPLACE_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const REPLACE_DEADLINE_MS = 2000;

function replaceInPlace(tmp, file) {
  const deadline = Date.now() + REPLACE_DEADLINE_MS;
  for (;;) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      const code = (e && e.code) || 'UNKNOWN';
      if (!REPLACE_CONTENTION_CODES.has(code) || Date.now() > deadline) throw e;
      // Same bounded, dependency-free pause the lease uses: a real sleep without an async boundary,
      // because introducing one here would make every caller's write asynchronous.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
    }
  }
}

// Per-CALL uniqueness. See the temporary-name note in writeAtomic for why per-process is not enough.
let tmpSeq = 0;

/*
 * ⭐ WHAT writeAtomic GUARANTEES — stated in full, because a half-written STATE.json would be read as
 * truth by the next session, and because the previous one-line comment ("Atomic write") invited
 * callers to assume three guarantees it does not give.
 *
 *   ✅ ATOMIC REPLACEMENT OF CONTENT. Any read that SUCCEEDS returns exactly one writer's payload,
 *      whole. There is no instant at which the target is truncated or half-filled, and no read has
 *      ever observed a mixture of two payloads under contention.
 *
 *   ⛔ BUT NOT ATOMIC AVAILABILITY, AND THE ABSOLUTE FORM OF THIS CLAIM WAS FALSE.
 *      This contract used to read "a reader sees the previous file whole or the new file whole; there
 *      is no instant at which the target is absent". An external gate falsified it on Windows: five
 *      runs of the contention fixture produced one `read:EPERM` and nine `read:ENOENT`. Reproduced
 *      here at four ENOENT in ~770 reads while ~2000 replacements landed. `MoveFileEx` does not
 *      guarantee that a concurrent OPEN succeeds, and `fs.readFileSync` does not open with
 *      FILE_SHARE_DELETE. So an arbitrary reader CAN see the target momentarily absent or locked.
 *
 *      What was wrong was the claim, not the mechanism — no torn or mixed content was observed in any
 *      run, before or after. The claim is narrowed to what the primitive gives, and the old-or-new
 *      guarantee is DELIVERED ONE LAYER UP: every RespawnPack reader goes through
 *      `hooks/_artifact.js`, which retries the transient codes and so separates "not there" from
 *      "not there YET". A reader outside this pack gets content atomicity and must handle EPERM,
 *      EACCES, EBUSY and ENOENT itself.
 *   ✅ LAST-COMPLETED-WRITER WINS. Under concurrency the survivor is exactly one writer's payload,
 *      entire. WHICH writer is undefined; that it is not a blend of two is the guarantee.
 *   ✅ A FAILURE BEFORE REPLACEMENT PRESERVES THE PRIOR TARGET BYTE-FOR-BYTE, and leaves no temporary
 *      behind. Nothing is removed until a complete replacement exists.
 *
 *   ❌ NOT A MERGE. A concurrent writer's payload is LOST, not combined. Anything doing
 *      read-modify-write needs a lock as well — hooks/_index-lease.js `withLock` is the one in this
 *      pack. Atomicity of the WRITE is not atomicity of the UPDATE, and the spawn counter is the
 *      standing example of a caller that needs both.
 *   ❌ NOT A TRANSACTIONAL MULTI-FILE UPDATE. Two files written by two calls can be observed in any
 *      combination. There is no cross-file barrier here and none is implied anywhere that calls this.
 *   ❌ NOT A PROMISE THAT EVERY WRITE LANDS. On Windows a rename over a destination another process
 *      currently holds open is refused, and `fs.readFileSync` does not open with FILE_SHARE_DELETE —
 *      so under SUSTAINED concurrent reading the bounded retry below can exhaust and this THROWS.
 *      Measured, not assumed: three unpaced reader processes starve six writers indefinitely, while
 *      the same six writers with no reader all succeed. The failure is loud and the prior file is
 *      intact, which is the whole design; but a caller that needs the write to land must handle the
 *      throw, and no atomic-replace primitive available here can remove that case on that platform.
 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  /*
   * ⛔ THE TEMPORARY NAME IS PER-CALL, NOT PER-PROCESS. `${file}.${process.pid}.tmp` reads as unique
   * — pids ARE distinct among live processes — and that is exactly the trap: it makes the name a
   * function of the PROCESS rather than of the CALL. Anything that shares a pid shares the buffer,
   * so two writers truncate and fill one file, the winner publishes a MIXTURE, and the loser's
   * rename dies on ENOENT. Sequence plus randomness costs nothing and deletes the class.
   */
  const tmp = `${file}.${process.pid}.${(tmpSeq += 1)}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    replaceInPlace(tmp, file);
  } catch (e) {
    /*
     * ⛔ AND CLEAN UP. Every failed write used to leave its temporary beside the target — inside
     * docs/derived/, a directory the project TRACKS. A disk-full or permission fault therefore did
     * not merely fail, it accreted, one file per attempt, into a committed tree. The prior target is
     * already safe (nothing was removed), so the only thing left is not to litter. Best-effort:
     * failing to remove a temporary must never mask the real error, which is what the caller needs.
     */
    try { fs.unlinkSync(tmp); } catch { /* already gone, or unremovable — either way, report the REAL failure */ }
    throw e;
  }
}

/*
 * The shared evidence loader (R-6). Every rejection reason is explicit and recorded — an artifact that
 * silently contributes nothing is indistinguishable from one that was never written.
 */
/*
 * `sameSource` is every revision that describes the current source — `currentRevision` plus the
 * savepoint-only chain above it. A battery run at the savepoint commit tested exactly the code the
 * work commit holds; rejecting it as "stale" would make the one commit the closeout REQUIRES retire
 * the evidence the closeout just verified. Omitted, the set is the single revision: strict.
 */
function loadEvidence(dir, currentRevision, equivalentRevisions = null) {
  const evDir = path.join(dir, STATE_DIR, 'evidence');
  const accepted = [], rejected = [];
  const sameSource = new Set([currentRevision, ...(Array.isArray(equivalentRevisions) ? equivalentRevisions : [])].filter(Boolean));
  let files = [];
  try { files = fs.readdirSync(evDir).filter((f) => f.endsWith('.json')); } catch { return { accepted, rejected, present: false }; }

  for (const f of files) {
    const p = path.join(evDir, f);
    const e = readJSON(p);
    const reject = (why) => rejected.push({ file: f, reason: why });

    if (!e) { reject('malformed — not parseable JSON'); continue; }
    if (e.schemaVersion !== SCHEMA_VERSION) { reject(`unknown schemaVersion ${JSON.stringify(e.schemaVersion)} (expected ${SCHEMA_VERSION})`); continue; }
    if (!Array.isArray(e.requirements) || !e.requirements.length) { reject('names no requirements — evidence that claims nothing cannot support anything'); continue; }
    if (!e.sourceRevision) { reject('unbound — no sourceRevision, so it cannot be known what it tested'); continue; }
    if (currentRevision && !sameSource.has(e.sourceRevision)) {
      reject(`stale revision — evidence is bound to ${String(e.sourceRevision).slice(0, 7)}, current source is ${String(currentRevision).slice(0, 7)}`);
      continue;
    }
    if (!e.verdict) { reject('no verdict'); continue; }
    if (e.verdict !== 'pass') { reject(`verdict is ${e.verdict}`); continue; }

    // ⛔ Controls that do not discriminate (DF-007 #7). A battery whose negative control never fired
    // proves the harness runs, not that it can detect anything.
    const pc = e.positiveControl, nc = e.negativeControl;
    if (!pc || !nc) { reject('missing positive and/or negative control'); continue; }
    if (pc.passed !== true || nc.detected !== true) {
      reject('controls do not discriminate — the known-good control did not pass and/or the known-bad control was not detected');
      continue;
    }
    if (e.partial === true) { reject('partial battery — reported separately, never promoted to gate completion'); continue; }
    if (e.claimType && !CLAIM_TYPES.includes(e.claimType)) { reject(`unknown claimType ${JSON.stringify(e.claimType)}`); continue; }

    accepted.push({ ...e, file: f });
  }
  return { accepted, rejected, present: true };
}

/*
 * Per-requirement status. The distinction that matters is `conformant` vs `candidate`: a high-risk row
 * whose only evidence came from the context that implemented it is a CANDIDATE. That is the seeded
 * shared-defect scenario, and calling it anything else is how field run B promoted a passing test that
 * encoded the same mistake as the code.
 */
function statusFor(req, evidence) {
  const mine = evidence.filter((e) => e.requirements.includes(req.id));
  if (req.waived) return { status: 'waived', why: `owner-waived: ${req.waived}`, evidence: [] };
  if (!mine.length) return { status: 'unevidenced', why: 'no fresh qualifying evidence', evidence: [] };

  const highRisk = req.risk === 'high' || req.priority === 'P0' || req.priority === 'P1';
  const independent = mine.filter((e) => e.qualifiedBy === 'independent');
  const strong = mine.filter((e) => !DEV_ONLY_CLAIMS.has(e.claimType));

  if (highRisk && !independent.length) {
    return {
      status: 'candidate',
      why: 'high-risk: evidence exists but was produced by the implementing context — independent qualification required before this can be conformant',
      evidence: mine.map((e) => e.file),
    };
  }
  if (highRisk && !strong.length) {
    return {
      status: 'candidate',
      why: `high-risk: only development-grade claims present (${[...new Set(mine.map((e) => e.claimType))].join(', ')}) — a unit-test success is not an end-to-end capability`,
      evidence: mine.map((e) => e.file),
    };
  }
  return { status: 'conformant', why: `qualified by ${mine.length} artifact(s)`, evidence: mine.map((e) => e.file) };
}

/**
 * Compile durable state. Returns { state, findings, revisions, removalsScan, lineageScan, reconciliation }
 * — findings are outcome-shaped so the caller can fail the run rather than write a state file that
 * quietly disagrees with its sources. `removalsScan` (from compileRemovals, `.checks` included),
 * `lineageScan` (from compileLineage, `.checks` included) and `reconciliation` (the raw
 * runReconciliation() result, `.checks` included) are the full results of the three scans this function
 * already had to run to compile `state.removals` / `state.lineage` / `state.reconciliation` — returned
 * so a caller that also needs their per-row checks (savepoint) does not have to invoke any of them a
 * second time. See the BUG-3 note on cmdSavepoint in respawnpack.js.
 */
/*
 * The killed-feature contract (Scenario L), compiled into durable state so BOOT and SAVEPOINT read the
 * same verdict instead of each forming its own opinion.
 *
 * ⛔ THE VERDICT CARRIES ITS OWN FRESHNESS. It is a function of the scanned live content, which is NOT a
 * compiler input — so `sourceManifest` cannot speak for it, and presenting yesterday's "clear" beside
 * today's docs would be the confident-stale-claim failure in a new place. `corpusManifest` records
 * exactly which files produced the verdict and what they contained; a reader recomputes it and reports
 * STALE rather than repeating a conclusion it cannot stand behind.
 */
function compileRemovals(dir, revision) {
  let scan;
  try { scan = removalsLib.runRemovalScan(dir); }
  catch (e) {
    return {
      verdict: { status: 'CANNOT_DETERMINE', why: `the removal scan threw (${e.message})`, rows: [], scannedFiles: 0 },
      killedFeatures: [], checks: [result(OUTCOME.CANNOT_DETERMINE, 'removals', `the removal scan could not run: ${e.message}`, { checked: 0 })],
    };
  }
  const killedFeatures = scan.rows.map((r) => ({
    id: r.id, feature: r.feature, status: r.status, risk: r.risk,
    ...(r.status === 'violated' ? { violations: r.hits.slice(0, 20) } : {}),
  }));
  return {
    verdict: {
      status: scan.outcome,
      why: scan.checks.map((c) => c.detail).slice(0, 6),
      scannedFiles: scan.corpus.files.length,
      scannedDirs: scan.cfg.liveContentDirs,
      extensions: scan.cfg.extensions,
      notScanned: scan.corpus.skipped,
      unreadable: scan.corpus.unreadable,
      scannedAtRevision: revision,
      corpusManifest: scan.manifest || null,
    },
    killedFeatures,
    checks: scan.checks,
  };
}

/*
 * The provenance verdict, compiled into durable state so BOOT and SAVEPOINT read one answer.
 *
 * ⛔ THE BLOCK TRAVELS, THE ROWS DO NOT — the same split DF-005 forced on reconciliation, for the same
 * reason. STATE.json carries the outcome, the counts and a BOUNDED list of the derivations that are not
 * passing, and never the marker text, the digests or the file lists. A boot path may then summarise an
 * ESTABLISHED provenance failure without any hook opening a project's derived files.
 *
 * ⛔ AND A SCAN THAT THREW IS "COULD NOT RUN", NEVER "FAILED". Same shape, same wording, same id as the
 * savepoint stage builds for the identical fault, so the two paths cannot disagree about a broken check.
 */
function compileLineage(dir) {
  try {
    const scan = lineageLib.checkLineage(dir);
    return { block: scan.block, checks: scan.checks, outcome: scan.outcome };
  } catch (e) {
    const why = `the provenance check could not run: ${e.message}`;
    return {
      block: { status: OUTCOME.CANNOT_DETERMINE, counts: { sources: 0, derivations: 0, pass: 0, fail: 0, undetermined: 0 }, failing: [], failingTruncated: false },
      checks: [result(OUTCOME.CANNOT_DETERMINE, 'lineage', why, { checked: 0 })],
      outcome: OUTCOME.CANNOT_DETERMINE,
    };
  }
}

/** The one sentence `cannotDetermine` carries for an undecided provenance verdict, built from its rows. */
const lineageWhy = (lineage) => `provenance: ${(lineage.checks.find((c) => c.outcome === OUTCOME.CANNOT_DETERMINE) || {}).detail || 'the provenance check could not conclude'}`;

/**
 * The reconciliation result when the reconciler itself could not be used — absent because a profile did
 * not place it, or present and unusable. One shape, so every reader downstream (`state.reconciliation`,
 * `savepoint`'s fold, `--json`) is handed the same object it always was.
 *
 * ⛔ IT IS CANNOT_DETERMINE, NEVER NOT_APPLICABLE, AND THIS FILE IS THE WRONG PLACE TO DECIDE OTHERWISE.
 * The compiler knows the module is missing; it does not know whether that absence was CHOSEN. That is
 * the posture's answer and it is given one layer up, by `applicability`'s survey, where the declaration
 * is read — so the row leaves here as "could not be determined", carrying `domain: 'coverage'` so the
 * one seam that applies a declared posture can relax it, and nothing here infers a decision from a file
 * that is not on disk.
 */
function reconciliationUnavailable(detail) {
  const why = `the reconciliation subsystem could not be used: ${detail}`;
  return {
    status: 'CANNOT_DETERMINE', configured: false, rows: [], counts: { tasks: 0, project: 0, drift: 0 }, why,
    checks: [result(OUTCOME.CANNOT_DETERMINE, 'reconcile', why, { checked: 0, domain: 'coverage' })],
  };
}

function compile(dir) {
  const findings = [];
  // `revisions.chain` travels out with the result so `savepoint` can hand the same equivalence class to
  // the generated-block check — one git walk per run, and one answer shared by everything in it.
  const revisions = sourceRevisionsOf(dir);
  const revision = revisions.effective;
  const unavailable = { status: 'UNREADABLE', doc: null, detail: `the acceptance boundary hooks/_artifact.js could not be loaded (${artifactHealth.detail || artifactHealth.status}) — nothing can be accepted without it` };
  const reqRead = artifact ? artifact.loadRequirements(path.join(dir, STATE_DIR, 'requirements.json')) : unavailable;
  const goalRead = artifact ? artifact.loadGoalDoc(path.join(dir, STATE_DIR, 'goal.json')) : unavailable;
  const reqDoc = reqRead.doc;

  /*
   * ⛔ A REJECTED GOAL DOCUMENT CONTRIBUTES NOTHING — NOT EVEN THE PARTS THAT LOOKED FINE.
   *
   * Reproduced on a real installed target before this existed: `goal.json` at `schemaVersion:
   * "999.0.0"` was read and ACTIVATED, putting its goal text, constraints, authority and forbidden
   * actions into compiled state; and `"constraints": "not an array"` compiled into twelve
   * single-character constraints, because a string spreads. Both reported PASS at exit 0.
   *
   * So the empty document is substituted for a rejected one. It is not a repair — no goal, no
   * milestone, no constraints, no authority, no forbidden actions and no killed features are derived —
   * and the refusal is recorded as CANNOT_DETERMINE so the verb exits 2 and names the artifact.
   */
  const goalRejected = artifact ? artifact.REJECTED.has(goalRead.status) : true;
  if (goalRejected) {
    findings.push(result(OUTCOME.CANNOT_DETERMINE, 'goal-contract',
      `${goalRead.detail || 'the goal contract could not be read'} — NOTHING was derived from it: no goal, no constraints, no authority, no forbidden actions.`, { checked: 0 }));
  }
  const goalDoc = normalizeGoalDoc(goalRejected ? {} : goalRead.doc);
  const removals = compileRemovals(dir, revision);
  const lineage = compileLineage(dir);
  /*
   * DF-005 runs INSIDE the compiler, for the same reason the removal scan does: "compare the task list
   * against the project's records" has always been the moment that drift would surface, and leaving it
   * as a separate verb makes it the check nobody ran on the day it mattered. Its findings reach
   * `savepoint` through the same `findings` array; `state` itself stays a compile step and does not
   * fail a project for an unconfigured contract.
   */
  const reconciliation = reconcileLib
    ? reconcileLib.runReconciliation(dir)
    : reconciliationUnavailable(reconcileHealth.detail || reconcileHealth.status);
  const driftIds = reconciliation.rows.filter((r) => r.id && r.klass !== 'EXCLUDED_ID').map((r) => `${r.klass}:${r.id}`);
  /*
   * ⛔ THE REGISTRY WINS OVER THE HAND-LISTED FIELD. `goal.json.killedFeatures` was a list someone typed
   * and nothing checked; the registry rows are the ones that were actually scanned for. Both are surfaced
   * when both exist — a legacy entry with no registry row is genuinely unenforced, and quietly dropping
   * it would hide that.
   */
  const legacyKilled = (goalDoc.killedFeatures || []).filter(
    (k) => !removals.killedFeatures.some((r) => r.id === (k && k.id)),
  ).map((k) => ({ ...k, status: 'unverified', why: 'listed in goal.json with no row in the removal registry — nothing scans for it' }));
  const killedFeatures = [...removals.killedFeatures, ...legacyKilled];

  /*
   * ⛔ THE COMPILER READS NO RUNTIME STATE. It used to consult
   * .respawnpack/runtime/contract.json and write `mode`, `goalId`, `suspendedGoal` and
   * `delegatedTask` into the TRACKED STATE.json — putting gitignored, machine-specific session state
   * into a durable artifact, so two developers in different modes would produce different tracked
   * files and fight over them in git. Its `runtimeContract.goalId || goalDoc.activeGoalId` fallback
   * also made a *suspended* goal read as active, so the same goal appeared both at once.
   *
   * The split that holds: the PROJECT has an ongoing goal (durable, tracked, survives a clone); a
   * SESSION has an interaction mode and an autonomy pointer (runtime, gitignored, never travels).
   * SessionStart composes the two at injection time — see hooks/session-routing-nudge.js. Autonomy is
   * never inherited from another machine, and completion is still assessed for the ongoing goal while
   * autonomy is suspended.
   */
  const ongoingGoalId = goalDoc.ongoingGoalId || goalDoc.activeGoalId || null; // activeGoalId = legacy spelling
  const ongoingGoal = (ongoingGoalId && goalDoc.goals[ongoingGoalId]) || null;

  if (!reqDoc) {
    /*
     * ⛔ SIX ANSWERS, NOT TWO. ABSENT is a project that deliberately tracks no denominator: it is
     * NOT_APPLICABLE and exits 0. Every other answer means the denominator EXISTS and could not be
     * used — unreadable through a transient fault that outlasted its retries, malformed, declaring a
     * version this kernel does not implement, or structurally wrong — and each is CANNOT_DETERMINE at
     * exit 2, because a count derived from a document nothing accepted would be invented.
     *
     * Reproduced before this existed: `requirements.json` at `schemaVersion: "999.0.0"` was consumed,
     * contributed its requirement to `counts.mandatory`, and reported PASS at exit 0.
     */
    const rel = `${STATE_DIR}/requirements.json`.replace(/\\/g, '/');
    const absent = reqRead.status === 'ABSENT';
    const why = absent
      ? `no ${rel} — this project tracks no requirement denominator`
      : `${rel} EXISTS and was refused: ${reqRead.detail}. This is NOT the same as tracking no requirements — the denominator is present and unusable, so NO count was computed and none was guessed.`;
    /*
     * ONLY THE ABSENT BRANCH IS A COVERAGE QUESTION. "This project tracks no denominator" is an
     * applicability answer; "the denominator is here and unusable" is an integrity fault, and tagging
     * the second would file a real breakage under the heading operators read as still-to-be-decided.
     * The tag changes neither outcome — see kernel/lib/applicability.js.
     */
    findings.push(absent
      ? result(OUTCOME.NOT_APPLICABLE, 'requirements', why, { domain: 'coverage' })
      : result(OUTCOME.CANNOT_DETERMINE, 'requirements', why, { checked: 0 }));
    return {
      state: {
        schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), sourceRevision: revision,
        tracksRequirements: false,
        cannotDetermine: [
          absent ? 'no approved requirement source' : why,
          ...(goalRejected ? [`goal contract REFUSED: ${goalRead.detail} — no goal, constraints, authority or forbidden actions were derived`] : []),
        ],
        sourceManifest: manifest ? manifest.sourceManifest(dir) : null,
        ongoingGoalId, goal: ongoingGoal ? ongoingGoal.goal : null,
        goalComplete: false,
        goalCompletion: { status: 'CANNOT_DETERMINE', criteria: [], why: 'no approved requirement source to evaluate criteria against' },
        milestone: goalDoc.milestone || null,
        currentAtomicTask: goalDoc.currentAtomicTask || null,
        constraints: [...(goalDoc.constraints || []), ...((ongoingGoal && ongoingGoal.constraints) || [])],
        forbidden: (ongoingGoal && ongoingGoal.forbidden) || [],
        killedFeatures,
        removals: removals.verdict,
        // Present in BOTH shapes: a project with no requirement denominator can still have a task
        // source that drifts, and omitting the block here would make the untracked shape silently
        // unable to report it. The provenance block is here for the identical reason — a docs-only
        // repository with no denominator is exactly the shape that copies documents from templates.
        lineage: lineage.block,
        reconciliation: { status: reconciliation.status, why: reconciliation.why, counts: reconciliation.counts, driftIds: driftIds.slice(0, 20), driftTruncated: driftIds.length > 20 },
      },
      findings,
      revisions,
      // The scans already ran above to produce `removals`/`lineage`/`reconciliation` in this same
      // tracksRequirements: false state — handed back whole (BUG-3) so a caller needing their per-row
      // checks, not just the summary verdict folded into `state`, never has to invoke a scan again.
      removalsScan: removals,
      lineageScan: lineage,
      reconciliation,
    };
  }

  const rows = Array.isArray(reqDoc.requirements) ? reqDoc.requirements : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { accepted, rejected, present } = loadEvidence(dir, revision, revisions.chain);

  if (!present) findings.push(result(OUTCOME.CANNOT_DETERMINE, 'evidence', `no ${STATE_DIR}/evidence/ directory — every requirement is unevidenced by default, which is a state, not a pass`));

  // Per-requirement status, derived — never read from a status field someone typed.
  const requirements = rows.map((r) => {
    const s = statusFor(r, accepted);
    const blockers = (r.blockedBy || []).filter(Boolean);
    return {
      id: r.id, title: r.title || '', mandatory: r.mandatory !== false,
      risk: r.risk || 'normal', priority: r.priority || null, gate: r.gate || null,
      status: s.status, why: s.why, evidence: s.evidence,
      blockedBy: blockers,
      claimTypes: [...new Set(accepted.filter((e) => e.requirements.includes(r.id)).map((e) => e.claimType || 'untriaged'))],
    };
  });

  const count = (pred) => requirements.filter(pred).length; // ⭐ every count below is a function of rows
  const counts = {
    total: requirements.length,
    mandatory: count((r) => r.mandatory),
    conformant: count((r) => r.status === 'conformant'),
    candidate: count((r) => r.status === 'candidate'),
    unevidenced: count((r) => r.status === 'unevidenced'),
    waived: count((r) => r.status === 'waived'),
    blocked: count((r) => r.blockedBy.length),
    staleEvidence: rejected.filter((x) => x.reason.startsWith('stale revision')).length,
  };

  /*
   * Gates. The denominator comes from the APPROVED source (reqDoc.gates[<id>].requires), and a declared
   * id with no backing row makes the gate incomplete. Omission must never improve a score — that is the
   * whole point of R-4, and the arithmetic here is deliberately arranged so it cannot.
   */
  const gates = Object.entries(reqDoc.gates || {}).map(([id, g]) => {
    const declared = Array.isArray(g.requires) ? g.requires : [];
    const missingRows = declared.filter((rid) => !byId.has(rid));
    const denominator = declared.length; // ← declared, NOT the rows that happen to exist
    const conformant = declared.filter((rid) => {
      const r = requirements.find((x) => x.id === rid);
      return r && (r.status === 'conformant' || r.status === 'waived');
    }).length;
    const complete = denominator > 0 && missingRows.length === 0 && conformant === denominator;
    return {
      id, title: g.title || '', denominator, conformant, complete,
      missingRows,
      status: missingRows.length ? 'INCOMPLETE_MISSING_ROWS' : complete ? 'COMPLETE' : 'INCOMPLETE',
      note: missingRows.length
        ? `${missingRows.length} declared requirement(s) have no row in the approved source (${missingRows.join(', ')}) — the gate is incomplete, and the denominator is NOT reduced`
        : null,
    };
  });

  for (const g of gates) {
    if (g.missingRows.length) findings.push(result(OUTCOME.FAIL, `gate:${g.id}`, g.note, { checked: g.denominator }));
  }

  /*
   * Blockers are SCOPED (R-7). A blocked requirement stops itself and whatever depends on it — not the
   * project. "One item in the current prompt is blocked" is not "the project is blocked", and the two
   * were repeatedly conflated in field run B.
   */
  const blockedIds = new Set(requirements.filter((r) => r.blockedBy.length).map((r) => r.id));
  const transitivelyBlocked = new Set(blockedIds);
  for (let pass = 0; pass < rows.length; pass++) {
    let grew = false;
    for (const r of rows) {
      if (transitivelyBlocked.has(r.id)) continue;
      if ((r.dependsOn || []).some((d) => transitivelyBlocked.has(d))) { transitivelyBlocked.add(r.id); grew = true; }
    }
    if (!grew) break;
  }

  const nextUnblocked = requirements
    .filter((r) => r.mandatory && r.status !== 'conformant' && r.status !== 'waived' && !transitivelyBlocked.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, status: r.status }));

  const allMandatoryBlocked = counts.mandatory > 0 && nextUnblocked.length === 0 &&
    requirements.some((r) => r.mandatory && transitivelyBlocked.has(r.id));

  /*
   * ⛔ GOAL COMPLETION IS DECIDED BY THE STATED CRITERIA, NOT BY THE DENOMINATOR.
   * "Every mandatory row conformed" and "the goal the owner stated is done" are different claims, and
   * conflating them is how an autonomous run manufactures a completion. A goal with no criteria, or
   * with one this compiler cannot evaluate, is CANNOT_DETERMINE — never complete.
   */
  const critCtx = { counts, requirements, gates, openP0P1: [], ownerConfirmations: goalDoc.ownerConfirmations || [] };
  critCtx.openP0P1 = requirements.filter((r) => (r.priority === 'P0' || r.priority === 'P1') && r.status !== 'conformant' && r.status !== 'waived').map((r) => r.id);
  const criteria = ongoingGoal ? (ongoingGoal.completion || []).map((c) => evaluateCriterion(c, critCtx)) : [];
  const goalCompletion = !ongoingGoal
    ? { status: 'NOT_APPLICABLE', criteria: [], why: 'no active goal' }
    : !criteria.length
      ? { status: 'CANNOT_DETERMINE', criteria: [], why: 'the goal states no completion criteria — a goal whose author never said what "done" means cannot be declared done' }
      : criteria.some((c) => c.status === 'CANNOT_DETERMINE')
        ? { status: 'CANNOT_DETERMINE', criteria, why: `${criteria.filter((c) => c.status === 'CANNOT_DETERMINE').length} criterion/criteria need a human judgement` }
        : criteria.every((c) => c.status === 'MET')
          ? { status: 'MET', criteria, why: 'every stated completion criterion is met' }
          : { status: 'UNMET', criteria, why: `${criteria.filter((c) => c.status !== 'MET').length} criterion/criteria not yet met` };

  const state = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: 'respawnpack state — GENERATED, never hand-edit',
    sourceRevision: revision,
    // Content digests of every compiler input, so freshness survives an UNCOMMITTED edit. A revision
    // alone answers "has anyone committed?", which is not the question this file's readers are asking.
    sourceManifest: manifest ? manifest.sourceManifest(dir) : null,
    tracksRequirements: true,
    denominatorVersion: reqDoc.denominatorVersion || null,

    // Milestone and goal are separate fields on purpose: field run B repeatedly reported a corrective
    // milestone's completion as the project goal's completion.
    ongoingGoalId,
    goal: ongoingGoal ? ongoingGoal.goal : null,
    forbidden: (ongoingGoal && ongoingGoal.forbidden) || [],
    authority: (ongoingGoal && ongoingGoal.authority) || [],
    milestone: goalDoc.milestone || null,
    goalComplete: goalCompletion.status === 'MET',
    goalCompletion,
    milestoneComplete: goalDoc.milestoneComplete === true,

    counts,
    requirements,
    gates,
    openP0P1: requirements.filter((r) => (r.priority === 'P0' || r.priority === 'P1') && r.status !== 'conformant' && r.status !== 'waived').map((r) => r.id),
    blockers: requirements.filter((r) => r.blockedBy.length).map((r) => ({ id: r.id, blockedBy: r.blockedBy, missingAuthority: (byId.get(r.id) || {}).missingAuthority || null })),
    transitivelyBlocked: [...transitivelyBlocked].sort(),
    projectBlocked: allMandatoryBlocked,
    currentAtomicTask: goalDoc.currentAtomicTask || null,
    nextUnblockedWork: nextUnblocked,
    lastQualified: (() => {
      const stamps = accepted.map((e) => e.timestamp).filter(Boolean).sort();
      return stamps.length ? { revision, at: stamps[stamps.length - 1] } : null;
    })(),
    evidence: { accepted: accepted.length, rejected },
    constraints: [...(goalDoc.constraints || []), ...((ongoingGoal && ongoingGoal.constraints) || [])],
    killedFeatures,
    removals: removals.verdict,
    /*
     * Class D. The provenance verdict, its counts, and a bounded list of the derivations that are not
     * passing — never the markers, the digests or the file lists. Same rule as the reconciliation block
     * directly below, and see compileLineage() above for why the records stay out of the document.
     */
    lineage: lineage.block,
    /*
     * ⛔ THE VERDICT TRAVELS, THE RECORDS DO NOT (DF-005). STATE.json carries the reconciliation
     * OUTCOME and its counts, and never the task or gap rows themselves. SessionStart may then
     * summarise an ESTABLISHED drift without any hook reading a project's task file — which would be
     * injecting unverified project records into a session as though they were truth, the precise
     * thing this comparison exists to catch someone doing.
     */
    reconciliation: { status: reconciliation.status, why: reconciliation.why, counts: reconciliation.counts, driftIds: driftIds.slice(0, 20), driftTruncated: driftIds.length > 20 },
    cannotDetermine: [
      ...(revision ? [] : ['source revision unknown — not a git repository, so no evidence can be revision-bound']),
      ...(present ? [] : ['no evidence directory']),
      ...(goalCompletion.status === 'CANNOT_DETERMINE' ? [`goal completion: ${goalCompletion.why}`] : []),
      ...(removals.verdict.status === OUTCOME.CANNOT_DETERMINE ? [`killed features: ${[].concat(removals.verdict.why)[0] || 'the removal scan could not conclude'}`] : []),
      ...(lineage.block.status === OUTCOME.CANNOT_DETERMINE ? [lineageWhy(lineage)] : []),
      ...(reconciliation.status === 'CANNOT_DETERMINE' ? [`task reconciliation: ${reconciliation.why}`] : []),
      ...(goalRejected ? [`goal contract REFUSED: ${goalRead.detail} — no goal, constraints, authority or forbidden actions were derived`] : []),
    ],
  };

  /*
   * ⛔ THE REMOVAL VERDICT IS RECORDED HERE AND ENFORCED IN `savepoint`, NOT IN `state`.
   *
   * `state` COMPILES a projection; `savepoint --verify` is the verb that decides whether the project
   * passes. Rolling the killed-feature verdict into `state`'s own outcome would make `respawnpack state`
   * exit non-zero on every project that has not configured the contract — turning a compile step into a
   * gate, and training people to ignore the exit code of both. The verdict still travels in STATE.json,
   * so SessionStart surfaces exactly what savepoint would report and the two cannot disagree.
   */
  /*
   * ⛔ THE RECONCILIATION VERDICT IS RECORDED HERE AND ENFORCED IN `savepoint` — the same split the
   * removal contract uses, and for the same reason. Rolling it into `state`'s own outcome would make
   * `respawnpack state` exit non-zero on every project that has not configured a task source, turning
   * a compile step into a gate. `savepoint` is where a project is judged.
   */
  /*
   * ⛔ BUG-3: `removals` AND `reconciliation` ALREADY COST THE SCAN. `cmdSavepoint` used to fold only
   * the summary verdicts above into `state` and then re-invoke `removalsLib.runRemovalScan(dir)` /
   * `reconcileLib.runReconciliation(dir)` A SECOND TIME to get the per-row checks it actually pushes
   * onto its own `checks[]` — discarding this function's own scan output and paying for an identical
   * scan of an identical tree in the identical process. Measured on a 2,000-file / 24 MB corpus: the
   * removal scan alone costs ~1.5 s and reconciliation's cost is comparable, so the double-scan was
   * ~50% of `savepoint --verify` wall time on a content-heavy project. Returned whole here — the same
   * objects `state.removals` / `state.reconciliation` were already derived from — so a caller can take
   * `.checks` without invoking either scan again.
   */
  return { state, findings, revisions, removalsScan: removals, lineageScan: lineage, reconciliation };
}

const goalPath = (dir) => path.join(dir, STATE_DIR, 'goal.json');

/** Read the durable goal document (normalized, legacy shape tolerated). */
/**
 * The goal contract, through the SAME acceptance boundary the compiler uses.
 *
 * ⛔ `closeout.js` and the `contract` verbs read the goal through here, so an unsupported or
 * structurally invalid document cannot be refused by the compiler and then quietly accepted by the
 * thing that CLOSES a goal or enters one. `readGoalDocClassified` exposes the disposition for callers
 * that must report it; `readGoalDoc` keeps the old shape and yields the EMPTY document on refusal —
 * never a partially trusted one.
 */
function readGoalDocClassified(dir) {
  if (!artifact) {
    return { status: 'UNREADABLE', doc: normalizeGoalDoc({}), detail: `the acceptance boundary hooks/_artifact.js could not be loaded (${artifactHealth.detail || artifactHealth.status})` };
  }
  const r = artifact.loadGoalDoc(goalPath(dir));
  const rejected = artifact.REJECTED.has(r.status);
  return { status: r.status, rejected, doc: normalizeGoalDoc(rejected ? {} : r.doc), detail: r.detail };
}
function readGoalDoc(dir) { return readGoalDocClassified(dir).doc; }

/** Write the durable goal document. Tracked, atomic, never written from a hook. */
function writeGoalDoc(dir, doc) {
  writeAtomic(goalPath(dir), JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...doc }, null, 2) + '\n');
  return goalPath(dir);
}

function write(dir, state) {
  const file = path.join(dir, STATE_FILE);
  writeAtomic(file, JSON.stringify(state, null, 2) + '\n');
  return file;
}

function read(dir) { return readJSON(path.join(dir, STATE_FILE)); }

module.exports = {
  compile, write, read, loadEvidence, statusFor, evaluateCriterion, normalizeGoalDoc,
  readGoalDoc, readGoalDocClassified, writeGoalDoc, goalPath,
  SCHEMA_VERSION, STATE_DIR, STATE_FILE, CLAIM_TYPES, writeAtomic,
};
