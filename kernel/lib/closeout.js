/*
 * RespawnPack · kernel/lib/closeout.js — the exit from autonomy.
 *
 * ⛔ WHAT WAS MISSING, AND WHY IT MATTERS AS MUCH AS THE ENTRANCE. Contracts could be ENTERED and
 * SUSPENDED and never mechanically COMPLETED. So: a finished delegation stayed in delegate mode across
 * sessions; a goal whose criteria had all become MET stayed the project's `ongoingGoalId` with runtime
 * still pointing at it; and nothing distinguished "still working" from "done and never closed". An
 * autonomy mode that cannot end is the mirror image of one that can be entered by inference — the pack
 * guarded the entrance and left the exit open.
 *
 * ⭐ ONE TRANSITION, CALLED BY EVERYTHING. The CLI, the prose-first path an agent follows without being
 * told a command, and any future caller all route through the two functions below. The durable/runtime
 * split is the same one the rest of the kernel keeps:
 *   docs/derived/state/goal.json   the durable contract and its HISTORY — archive, never delete
 *   .respawnpack/runtime/…         this machine's mode, its autonomy pointer, its bounded task
 *
 * ⛔ AND THE ASYMMETRY BETWEEN THE TWO CLOSURES IS DELIBERATE, because the two kinds of criteria are
 * different in kind and pretending otherwise would manufacture a guarantee:
 *
 *   GOAL completion is MECHANICAL. Its criteria are evaluated by the state compiler, and completion is
 *   REFUSED while any of them is UNMET or CANNOT_DETERMINE. A free-text criterion is legitimate and is
 *   simply not something a program may rule on in its own favour — so a goal written with free-text
 *   criteria can never be closed by this command, which is the correct and intended outcome.
 *
 *   DELEGATE completion is an ATTESTATION, and says so. A bounded task's acceptance criteria are prose
 *   the agent derived from a request; nothing here can evaluate them. What IS mechanical is that the
 *   caller must restate EVERY recorded criterion to close the task — `--met` per criterion, matched
 *   against the recorded list. That makes "I finished it" impossible to say in the abstract: you have
 *   to name what you are claiming. It is not proof, and the archive records it as an attestation.
 */
const path = require('path');

const { OUTCOME } = require('./outcome.js');
const stateLib = require('./state.js');
const modhealth = require('./modhealth.js');
const A = require('./assert.js');

const RUNTIME_REL = path.join('.respawnpack', 'runtime', 'contract.json');
const DELEGATION_LOG_REL = path.join('.respawnpack', 'runtime', 'delegations.json');
const MAX_ARCHIVED_DELEGATIONS = 50;

/*
 * ⛔ THE EXIT WROTE ITS STATE THROUGH `writeAtomic` AND READ IT BACK THROUGH `catch { return null }`.
 *
 * Both of this module's inputs — the runtime contract and the delegation archive — are replaced by
 * atomic rename. A reader can therefore observe either of them momentarily ABSENT or locked, which is
 * measured behaviour on Windows and the whole reason hooks/_artifact.js exists. This file bypassed it.
 *
 * Reproduced against 55bdb96, with ONE injected ENOENT on the first read of contract.json while an
 * OPEN delegation was being closed:
 *
 *     outcome PASS · alreadyClosed true · reported contract mode "collaborate"
 *     …and the runtime file on disk still said mode "delegate", delegation still open.
 *
 * That is an autonomy-EXIT failure of the same family as the entrance ones: the caller is told the
 * contract closed, and the next session resumes it. The archive had the identical shape — a transient
 * read failure became "no prior history", and the very next `writeAtomic` REPLACED the real archive
 * with a one-record file.
 *
 * ⭐ SO THE SIX ANSWERS ARE KEPT APART HERE TOO, and the asymmetry is deliberate:
 *   ABSENT runtime          ⇒ collaborate. That is what "no contract file" has always meant.
 *   TRANSIENT unavailability⇒ retried by the boundary, and the ACTUAL contract is recovered.
 *   UNREADABLE · MALFORMED  ⇒ CANNOT_DETERMINE. Never collaborate, never already-closed, never PASS.
 *   ABSENT archive          ⇒ empty history.
 *   UNREADABLE · MALFORMED archive ⇒ closeout ABORTS, and prior history is neither replaced nor truncated.
 * And nothing is written on any of the refusing paths — an input this module could not read is not an
 * input it may act on.
 */
const ARTIFACT_PATH = path.resolve(__dirname, '..', '..', 'hooks', '_artifact.js');
const artifactHealth = modhealth.probePath(ARTIFACT_PATH);
const artifact = artifactHealth.module;

/*
 * ⛔ AND A BOUNDARY THAT IS NOT THERE IS NOT A BOUNDARY THAT SAID "ABSENT". `probePath` yields a null
 * module for every unloadable shape AND for a module that loads without the exports its readers call,
 * so the one thing this must not do is fall back to reading the file itself.
 */
function classifiedJSON(file) {
  if (!artifact || typeof artifact.readJSONClassified !== 'function') {
    return {
      status: 'UNREADABLE',
      doc: null,
      detail: `the shared artifact boundary hooks/_artifact.js is unavailable (${artifactHealth.detail || artifactHealth.status}) — `
        + 'nothing may be concluded about runtime state without it',
    };
  }
  return artifact.readJSONClassified(file);
}

/*
 * ⛔ AND THE SAME QUESTION ABOUT THE OTHER MODULE THIS ONE CALLS ACROSS.
 *
 * `_artifact.js` was guarded here and `state.js` was not, which is the same gap one dependency over.
 * Reproduced on a real installed target at 6869874: removing ONLY `readGoalDocClassified` from
 * `.claude/respawnpack/lib/state.js` left doctor reporting `kernel-lib:state.js ACTIVE`,
 * `kernel-lib:closeout.js ACTIVE` and PASS at exit 0, while `contract complete` died on
 * `TypeError: stateLib.readGoalDocClassified is not a function` — a RAW crash out of the one transition
 * whose entire job is to refuse safely.
 *
 * A closure whose engine is missing has not established anything, so it says CANNOT_DETERMINE and
 * writes nothing. The declared registry is the list, so a state.js API added later is covered here the
 * day it is declared rather than the day someone remembers this function.
 */
/*
 * ⛔ EVERY ACCESS HERE IS WRITTEN OUT LITERALLY, and that is not style. A `stateLib[name]` loop would
 * be shorter and would be a COMPUTED property access — invisible to the registry drift fence, which
 * cannot extract what it cannot read. This function exists to close a contract hole; writing it in the
 * one form the contract fence is blind to would have opened a second one inside the repair.
 */
const stateApiNeeds = () => [
  ['SCHEMA_VERSION', stateLib.SCHEMA_VERSION, 'string'],
  ['STATE_DIR', stateLib.STATE_DIR, 'string'],
  ['compile', stateLib.compile, 'function'],
  ['readGoalDocClassified', stateLib.readGoalDocClassified, 'function'],
  ['writeAtomic', stateLib.writeAtomic, 'function'],
  ['writeGoalDoc', stateLib.writeGoalDoc, 'function'],
];

function stateApiUnavailable() {
  const missing = stateApiNeeds()
    .filter(([, value, want]) => !modhealth.satisfies(value, want))
    .map(([name, value, want]) => `${name} (want ${want}, got ${modhealth.typeOf(value)})`);
  return missing.length ? missing.join('; ') : null;
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * This machine's interaction contract, CLASSIFIED.
 *
 * @returns {{status:'OK'|'ABSENT'|'UNREADABLE'|'MALFORMED', contract:object|null, detail:string|null}}
 *   `contract` is `{}` for ABSENT — a genuinely missing file IS collaborate — and null for every
 *   disposition on which nothing may be concluded.
 */
function readRuntimeClassified(dir) {
  const r = classifiedJSON(path.join(dir, RUNTIME_REL));
  if (r.status === 'ABSENT') return { status: 'ABSENT', contract: {}, detail: null };
  if (r.status !== 'OK') {
    return { status: r.status, contract: null, detail: r.detail || `${RUNTIME_REL}: ${r.status.toLowerCase()}` };
  }
  // A present file whose top level is not an object cannot be a contract, and reading `.mode` off an
  // array or a string would silently answer `undefined` — which spells collaborate.
  if (!isPlainObject(r.doc)) {
    return {
      status: 'MALFORMED',
      contract: null,
      detail: `${RUNTIME_REL} is ${Array.isArray(r.doc) ? 'an array' : r.doc === null ? 'null' : typeof r.doc}, expected a JSON object`,
    };
  }
  return { status: 'OK', contract: r.doc, detail: null };
}

/**
 * The contract object, with a genuinely absent file meaning collaborate.
 *
 * ⛔ IT THROWS ON UNREADABLE OR MALFORMED RATHER THAN RETURNING `{}`, and that is the whole correction.
 * `{}` is indistinguishable from "no contract file", so any caller that takes this shape and does not
 * ask about the disposition is one transient rename away from reporting collaborate. Callers that must
 * report the disposition use `readRuntimeClassified`; callers that cannot proceed without an answer get
 * a loud one instead of a plausible one.
 */
function readRuntime(dir) {
  const r = readRuntimeClassified(dir);
  if (r.status === 'OK' || r.status === 'ABSENT') return r.contract;
  const e = new Error(`the runtime contract at ${RUNTIME_REL} is ${r.status} — ${r.detail}`);
  e.runtimeStatus = r.status;
  e.runtimeDetail = r.detail;
  throw e;
}

/**
 * The delegation archive, CLASSIFIED. Absent ⇒ empty history; anything else that is not OK ⇒ the
 * caller must abort, because the next write REPLACES this file wholesale.
 *
 * @returns {{status:'OK'|'UNREADABLE'|'MALFORMED', history:Array|null, detail:string|null}}
 */
function readDelegationArchive(dir) {
  const r = classifiedJSON(path.join(dir, DELEGATION_LOG_REL));
  if (r.status === 'ABSENT') return { status: 'OK', history: [], detail: null };
  if (r.status !== 'OK') {
    return { status: r.status, history: null, detail: r.detail || `${DELEGATION_LOG_REL}: ${r.status.toLowerCase()}` };
  }
  if (!isPlainObject(r.doc)) {
    return {
      status: 'MALFORMED',
      history: null,
      detail: `${DELEGATION_LOG_REL} is ${Array.isArray(r.doc) ? 'an array' : r.doc === null ? 'null' : typeof r.doc}, expected a JSON object`,
    };
  }
  /*
   * ⛔ A PRESENT-BUT-NON-ARRAY `completed` IS MALFORMED, NOT EMPTY. The old expression
   * `Array.isArray(log && log.completed) ? log.completed : []` treated a corrupted archive as one with
   * no history — and then wrote the file back, so the corruption was answered by DELETING what it had
   * corrupted. A file with no `completed` key at all is a different thing: that is an empty archive.
   */
  if (r.doc.completed !== undefined && !Array.isArray(r.doc.completed)) {
    return {
      status: 'MALFORMED',
      history: null,
      detail: `${DELEGATION_LOG_REL}: \`completed\` is ${isPlainObject(r.doc.completed) ? 'an object' : typeof r.doc.completed}, expected an array — `
        + 'replacing it would destroy the archive it failed to read',
    };
  }
  return { status: 'OK', history: Array.isArray(r.doc.completed) ? r.doc.completed : [], detail: null };
}

/** The refusal both closures return when an input they must have could not be read. */
const cannotRead = (what, status, detail) => ({
  outcome: OUTCOME.CANNOT_DETERMINE,
  error: `${what} is ${status} — ${detail}. Nothing was changed.\n`
    + 'An input this command could not read is not an input it may act on: reporting a closed contract here would '
    + 'tell the caller autonomy ended while the next session resumes it. Repair or restore the file, then retry.',
  runtimeStatus: status,
});

/**
 * The refusal both closures return when a MODULE they call across is unavailable — structured, naming
 * the dependency, and never a raw TypeError out of the autonomy exit.
 */
function dependencyUnavailable() {
  const stateMissing = stateApiUnavailable();
  if (stateMissing) {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE,
      error: `the kernel subsystem lib/state.js is missing an API closeout calls: ${stateMissing}. Nothing was changed.\n`
        + 'Run `doctor` — it reports kernel-lib:state.js as BROKEN and names this same export. A closure whose engine '
        + 'is missing has not established anything, so it refuses rather than crashing partway through.',
      brokenDependency: 'lib/state.js',
    };
  }
  if (!artifact || typeof artifact.readJSONClassified !== 'function') {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE,
      error: `the shared artifact boundary hooks/_artifact.js is unavailable (${artifactHealth.detail || artifactHealth.status}). Nothing was changed.\n`
        + 'Run `doctor` — it reports hook-lib:_artifact.js as BROKEN and names the same missing export. Runtime state '
        + 'cannot be read without it, and a contract nobody could read is not a contract that closed.',
      brokenDependency: 'hooks/_artifact.js',
    };
  }
  return null;
}

function writeRuntime(dir, c) {
  stateLib.writeAtomic(path.join(dir, RUNTIME_REL), JSON.stringify({ ...c, setAt: new Date().toISOString() }, null, 2));
  return c;
}

/** `goalId` is the pre-2d spelling of `activeGoalId` and is still resolved. */
const activeOf = (c) => c.activeGoalId || c.goalId || null;

/**
 * Where runtime should land once a contract closes.
 *
 * ⛔ A SUSPENDED GOAL IS RESTORED, NOT DISCARDED. Collaborate is the default the pack returns to, but a
 * delegation that suspended an ongoing goal has to hand it back when it finishes — otherwise "transitions
 * are free and cheap" is false in the one direction that costs someone their context. Autonomy is
 * resumed only onto a goal this machine had ALREADY entered explicitly; nothing here can start one.
 */
function restoreTarget(runtime, goalDoc) {
  const suspended = runtime.suspendedGoalId || null;
  if (suspended && goalDoc.goals && goalDoc.goals[suspended] && !goalDoc.goals[suspended].completedAt) {
    return { mode: 'goal', activeGoalId: suspended, suspendedGoalId: null, restored: suspended };
  }
  return { mode: 'collaborate', activeGoalId: null, suspendedGoalId: null, restored: null };
}

// --- delegation ------------------------------------------------------------------------------------

/**
 * Close a bounded delegation.
 * `met` is the list of acceptance criteria the caller is attesting to; it must cover every recorded one.
 */
function completeDelegation(dir, { met = [], evidence = null, note = null } = {}) {
  /*
   * ⛔ THE DISPOSITION IS SETTLED BEFORE ANY BRANCH THAT COULD REPORT SUCCESS. Asking `runtime.mode`
   * first is what produced the reproduced failure: an unreadable contract answers `undefined`, which
   * falls straight into the idempotent already-closed branch and returns PASS.
   */
  // ⛔ BEFORE ANY READ, ANY BRANCH AND ANY WRITE: can this module still call the modules it needs?
  const unavailable = dependencyUnavailable();
  if (unavailable) return unavailable;

  const rt = readRuntimeClassified(dir);
  if (rt.status !== 'OK' && rt.status !== 'ABSENT') return cannotRead(`the runtime contract at ${RUNTIME_REL}`, rt.status, rt.detail);
  const runtime = rt.contract;

  /*
   * ⛔ AND THE GOAL DOCUMENT THROUGH THE SAME ACCEPTANCE BOUNDARY THE COMPILER USES. `readGoalDoc`
   * substitutes the EMPTY document for a rejected one, which here means `restoreTarget` finds no
   * suspended goal and lands on collaborate — a goal silently dropped by a document nobody could read.
   * An ABSENT goal.json is not rejected and still means exactly what it always did: no goals.
   */
  const goalRead = stateLib.readGoalDocClassified(dir);
  if (goalRead.rejected) return cannotRead(`the goal document at ${stateLib.STATE_DIR}/goal.json`, goalRead.status, goalRead.detail);
  const goalDoc = goalRead.doc;

  // ⛔ IDEMPOTENT. Closing a task that is already closed is not an error and must not undo anything —
  // a retry after a crashed turn is the ordinary case, and making it fail would train people to force.
  if (runtime.mode !== 'delegate') {
    return {
      outcome: OUTCOME.PASS, alreadyClosed: true,
      contract: { mode: runtime.mode || 'collaborate', activeGoalId: activeOf(runtime), suspendedGoalId: runtime.suspendedGoalId || null },
      note: `no bounded delegation is open (mode is ${runtime.mode || 'collaborate'}) — nothing to close, and nothing was changed`,
    };
  }

  const recorded = Array.isArray(runtime.acceptance) ? runtime.acceptance : [];
  if (!recorded.length) {
    return { outcome: OUTCOME.CANNOT_DETERMINE, error: 'the open delegation records no acceptance criteria, so there is nothing to attest to. This should be impossible — `contract delegate` refuses an empty list — and means the runtime file was hand-edited.' };
  }

  /*
   * ⛔ EVERY RECORDED CRITERION MUST BE RESTATED. Normalised comparison, because the criterion a caller
   * types back will differ in case, wrapping and markdown from the one that was recorded — that is
   * DF-007 #4 and #5, and rejecting a correct attestation over a capital letter would teach people to
   * pass whatever the error message wanted.
   */
  const norm = (s) => A.foldCase(String(s));
  const attested = new Set(met.map(norm).filter(Boolean));
  const missing = recorded.filter((c) => !attested.has(norm(c)));
  if (missing.length) {
    return {
      outcome: OUTCOME.FAIL,
      error: `${missing.length} acceptance criterion/criteria were not attested: ${missing.map((m) => `"${m}"`).join(', ')}. ` +
        'Restate each one you are claiming with --met "<criterion>". A bounded task closes when its stated ' +
        'definition of done is claimed criterion by criterion — not when someone decides it feels finished.',
      missing,
    };
  }
  const unknown = met.filter((m) => !recorded.some((c) => norm(c) === norm(m)));

  const record = {
    task: runtime.task || null,
    acceptance: recorded,
    attestedAt: new Date().toISOString(),
    // ⛔ Recorded as an ATTESTATION, in the archive's own vocabulary. Calling it "verified" here would
    // be the manufactured-evidence failure this whole program exists to remove.
    attestation: 'the closing caller restated every recorded acceptance criterion; this is a claim, not a proof',
    evidence: evidence || null,
    note: note || null,
    ...(unknown.length ? { alsoClaimed: unknown } : {}),
  };

  /*
   * ⛔ THE ARCHIVE IS READ — AND ITS AVAILABILITY SETTLED — BEFORE THE FIRST BYTE IS WRITTEN ANYWHERE.
   * This write REPLACES the file, so a read that failed and returned "no history" does not merely lose
   * the answer, it destroys the record. Aborting here leaves BOTH closeout files exactly as they were.
   */
  const archive = readDelegationArchive(dir);
  if (archive.status !== 'OK') {
    return {
      outcome: OUTCOME.CANNOT_DETERMINE,
      error: `the delegation archive at ${DELEGATION_LOG_REL} is ${archive.status} — ${archive.detail}. `
        + 'Nothing was changed, and no attestation was archived.\n'
        + 'Appending to history requires reading it first: writing this record now would replace every prior '
        + 'attestation with one that could not be checked against them. Repair or restore the archive, then retry.',
      archiveStatus: archive.status,
    };
  }
  const history = [...archive.history, record];
  stateLib.writeAtomic(path.join(dir, DELEGATION_LOG_REL),
    JSON.stringify({ schemaVersion: stateLib.SCHEMA_VERSION, completed: history.slice(-MAX_ARCHIVED_DELEGATIONS) }, null, 2) + '\n');

  const next = restoreTarget(runtime, goalDoc);
  writeRuntime(dir, { mode: next.mode, activeGoalId: next.activeGoalId, suspendedGoalId: next.suspendedGoalId });

  return {
    outcome: OUTCOME.PASS,
    completed: record,
    contract: { mode: next.mode, activeGoalId: next.activeGoalId, suspendedGoalId: next.suspendedGoalId },
    note: next.restored
      ? `delegation closed; the goal ${next.restored} it suspended is resumed, and autonomy is back where it was`
      : 'delegation closed; runtime is back to collaborate, which is the default and needs no command',
  };
}

// --- goal ------------------------------------------------------------------------------------------

/**
 * Close an ongoing goal.
 *
 * ⛔ REFUSES ON UNMET *AND* ON CANNOT_DETERMINE. The same refusal discipline that guards ENTRY has to
 * guard EXIT, or a free-text criterion becomes a way to declare victory: a goal nobody could evaluate
 * would be exactly as closable as one that genuinely finished. It also never infers completion from the
 * requirement denominator — "every mandatory row conformed" and "the goal the owner stated is done" are
 * different claims, and conflating them is how an autonomous run manufactures a completion.
 */
function completeGoal(dir, { evidence = null, note = null } = {}) {
  const unavailable = dependencyUnavailable();
  if (unavailable) return unavailable;

  // Same order and the same reason as the delegation closure: an unreadable contract must not reach the
  // already-closed branch below, where `runtime.mode || 'collaborate'` would report a fault as a mode.
  const goalRead = stateLib.readGoalDocClassified(dir);
  if (goalRead.rejected) return cannotRead(`the goal document at ${stateLib.STATE_DIR}/goal.json`, goalRead.status, goalRead.detail);
  const goalDoc = goalRead.doc;

  const rt = readRuntimeClassified(dir);
  if (rt.status !== 'OK' && rt.status !== 'ABSENT') return cannotRead(`the runtime contract at ${RUNTIME_REL}`, rt.status, rt.detail);
  const runtime = rt.contract;

  const id = goalDoc.ongoingGoalId || goalDoc.activeGoalId || null;

  if (!id || !goalDoc.goals[id]) {
    // Idempotent: a goal already closed leaves no ongoingGoalId, so a retry is a no-op that says so.
    return {
      outcome: OUTCOME.PASS, alreadyClosed: true,
      contract: { mode: runtime.mode || 'collaborate' },
      note: 'no ongoing goal is recorded — nothing to close, and nothing was changed',
    };
  }

  const { state } = stateLib.compile(dir);
  const gc = state.goalCompletion || { status: 'CANNOT_DETERMINE', criteria: [], why: 'no completion assessment was produced' };

  if (gc.status !== 'MET') {
    const blocking = (gc.criteria || []).filter((c) => c.status !== 'MET');
    return {
      outcome: gc.status === 'UNMET' ? OUTCOME.FAIL : OUTCOME.CANNOT_DETERMINE,
      error: `goal ${id} cannot be completed: goalCompletion is ${gc.status} — ${gc.why}.\n` +
        (blocking.length
          ? `${blocking.map((c) => `  · ${c.status}: ${c.text}${c.detail ? ` (${c.detail})` : ''}`).join('\n')}\n`
          : '') +
        'A criterion this compiler cannot evaluate is not a criterion that has been met. Either satisfy it and ' +
        're-run, or record the human judgement it needs as an owner confirmation in the goal document — never ' +
        'close around it.',
      goalCompletion: gc,
    };
  }

  /*
   * ARCHIVE, NEVER DELETE. The goal row stays in goal.json with its completion evidence attached; only
   * the project's `ongoingGoalId` pointer is cleared. A later session can therefore still answer "what
   * was this project pursuing, and what decided that it was done".
   */
  const completedAt = new Date().toISOString();
  goalDoc.goals[id] = {
    ...goalDoc.goals[id],
    completedAt,
    qualifiedRevision: state.sourceRevision || null,
    completionEvidence: {
      criteria: (gc.criteria || []).map((c) => ({ text: c.text, kind: c.kind, status: c.status, detail: c.detail })),
      evidence: evidence || null,
      note: note || null,
      sourceManifest: state.sourceManifest || null,
    },
  };
  goalDoc.completedGoalIds = [...new Set([...(goalDoc.completedGoalIds || []), id])];
  delete goalDoc.ongoingGoalId;
  delete goalDoc.activeGoalId; // retire the pre-2d spelling on write
  stateLib.writeGoalDoc(dir, goalDoc);

  /*
   * ⛔ AND CLEAR BOTH RUNTIME POINTERS CONSISTENTLY. Leaving `suspendedGoalId` pointing at the goal that
   * just completed would let `contract goal --resume` re-enter autonomy on finished work — the exact
   * "a completed goal reappears as ongoing" failure the acceptance tests exist to catch, arriving
   * through the resume path instead of the compile path.
   */
  const cleared = {
    mode: 'collaborate',
    activeGoalId: null,
    suspendedGoalId: runtime.suspendedGoalId && runtime.suspendedGoalId !== id ? runtime.suspendedGoalId : null,
  };
  const next = restoreTarget(cleared, goalDoc);
  writeRuntime(dir, { mode: next.mode, activeGoalId: next.activeGoalId, suspendedGoalId: next.suspendedGoalId });

  return {
    outcome: OUTCOME.PASS,
    completed: { id, completedAt, qualifiedRevision: state.sourceRevision || null, criteria: gc.criteria },
    contract: { mode: next.mode, activeGoalId: next.activeGoalId, suspendedGoalId: next.suspendedGoalId },
    note: next.restored
      ? `goal ${id} completed and archived; the goal ${next.restored} it was stacked on is resumed`
      : `goal ${id} completed and archived at revision ${String(state.sourceRevision || 'unknown').slice(0, 7)}; ` +
        'autonomy has ended and runtime is back to collaborate. The contract stays in goal.json as history.',
  };
}

module.exports = {
  completeDelegation, completeGoal, readRuntime, readRuntimeClassified, readDelegationArchive,
  writeRuntime, restoreTarget, activeOf,
  RUNTIME_REL, DELEGATION_LOG_REL, MAX_ARCHIVED_DELEGATIONS,
};
