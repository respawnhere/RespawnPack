#!/usr/bin/env node
/*
 * RespawnPack · precompact-ledger-nudge.js — PreCompact hook that makes a VERIFIED HANDOFF a HARD
 * PRECONDITION for compaction, and PERSISTS one at the one moment memory loss is guaranteed.
 *
 * ⛔ THE DEFECT THIS FILE ORIGINALLY EXISTED TO CORRECT (DOGFOOD.md DF-002). An earlier version returned
 *   {hookSpecificOutput: {hookEventName: "PreCompact", additionalContext: "…"}}
 * and field run B caught the runtime rejecting it verbatim:
 *   Compacted PreCompact [...] failed: Hook JSON output validation failed — (root): Invalid input
 * The published contract (code.claude.com/docs/en/hooks) lists `additionalContext` for SessionStart,
 * Setup, SubagentStart, UserPromptSubmit, UserPromptExpansion, PreToolUse, PostToolUse,
 * PostToolUseFailure, PostToolBatch, Stop and SubagentStop. **There is no PreCompact variant.**
 * PreCompact carries a top-level `decision`/`reason` and nothing else. DF-002 discipline still holds:
 * this hook NEVER emits `hookSpecificOutput`, on any path, including the block path below.
 *
 * ⭐ v0.2's ANSWER: PERSIST INSTEAD OF SPEAKING. It wrote a compaction handoff — revision, uncommitted
 * files, ledger presence, the session's own atomic-task note — to `.respawnpack/runtime/`, read it back,
 * and recorded whether the read-back verified. That schemaVersion 1.0.0 record (`precompact-handoff`) is
 * kept here, UNCHANGED, for one release: it has readers this pack does not control, and the v1 write
 * stays exactly as it always did.
 *
 * ⭐ v0.3's ANSWER, ADDED BESIDE IT: THE HARD PRECONDITION. v1's handoff was WRITTEN, then REWRITTEN to
 * stamp `readBackVerified: true`, then REWRITTEN AGAIN by the reader to stamp `consumedAt` — so the bytes
 * that were verified were never quite the bytes that were injected. `core/state/handoff.js`'s v2 document
 * is written ONCE, verified by a sibling receipt, and never rewritten. And unlike v1 — which reported an
 * unverified handoff as a softer warning — an UNVERIFIED v2 handoff now BLOCKS the compaction outright:
 * `decision:"block"` is the one channel PreCompact actually has, and R3 verified it (exit 2 / decision
 * block ⇒ compaction is skipped, not merely warned about). An operator who genuinely wants to compact
 * through the failure anyway sets RESPAWNPACK_ALLOW_UNSAVED_COMPACT=1, which downgrades the block to a
 * LOUD systemMessage saying state WILL be lost — the escape hatch is visible, never silent.
 *
 * ⭐ AND THE HOST-NEUTRAL ROLLOVER MACHINE (core/lifecycle/machine.js) IS WALKED, BEST-EFFORT, ALONGSIDE
 * THE PRECONDITION — NEVER AS PART OF IT. The precondition is scoped strictly to the v2 handoff's own
 * write+readback (see above); the machine's checkpoint → closeout → stage-handoff → verify-handoff →
 * request-compact chain is attempted with real evidence (a byte-proxy context measurement, a safe-boundary
 * record naming this hook as the mechanism, the handoff's own write/readback records, and a
 * COMPACT_REQUESTED record naming `operator-manual` or `host-auto-compact` per `trigger` — the interactive
 * profile does not invoke `/compact` itself, so the "request" it can honestly record is presenting one).
 * Reaching COMPACTING here is what lets `session-routing-nudge.js`'s SessionStart(compact) legally apply
 * `observe-completion` and `verify-identity` — which is what advances the context cycle and re-arms
 * `context-monitor.js`'s thresholds. If any step of the chain is REFUSED or HALTED, it is noted in the
 * systemMessage and the chain stops there; it never blocks compaction and never masks the v1/v2 outcome.
 *
 * Contract: stdin = PreCompact JSON {trigger, session_id, cwd}. Output: {systemMessage} on the normal
 * path, or top-level {decision:"block", reason, systemMessage} on the hard-precondition path. Exit 0
 * always — PreCompact's `decision` field, not the exit code, is what the host reads as a block.
 * ⛔ Never `hookSpecificOutput` on ANY path — see above.
 * ⭐ POSTURE (ADR-003): the handoff WRITE is fixed on in every posture; only `precompact:block` moves,
 * `advise` under `light` and `deny` under `standard` and `strict`. Under `light` an unverified handoff
 * therefore takes the same loud `systemMessage` the `RESPAWNPACK_ALLOW_UNSAVED_COMPACT=1` escape hatch
 * takes, naming the posture as the cause instead of the variable.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// Advisory: this hook writes a handoff record before compaction and enforces nothing BY EXIT CODE, so an
// unloadable dependency says why on stderr and exits 0 rather than failing the compaction with a stack.
// The hard precondition below is a DECISION the hook emits deliberately, not a crash-driven one.
const boot = require('./_boot.js');
boot.arm('advisory');
const rt = boot.need('./_runtime.js');
/*
 * ⛔ THE POSTURE READER, AND THE SPLIT IT IS ALLOWED TO ACT ON (ADR-003, P3-T-10b).
 *   `precompact:handoff-write`  everything above the decision: the v1 record, the v2 write-and-verify,
 *                               and the machine walk. FIXED — anti-drift item 23. `on` in all three
 *                               postures. A posture that skipped the WRITE would not be a looser
 *                               policy, it would be a compaction with nothing persisted.
 *   `precompact:block`          the `decision: "block"` an UNVERIFIED handoff earns. `advise` under
 *                               `light`, `deny` under `standard` and `strict`.
 * ⛔ AND THE `decision:"block"` CODE PATH BELOW IS NOT REMOVED, ONLY ITS USE IS NARROWED (anti-drift
 * item 23 again). `decision` is the ONLY channel PreCompact has — `hookSpecificOutput` is illegal here
 * (DF-002) — so deleting the branch would leave the two rigid postures with no way to refuse at all.
 */
const posture = boot.need('./_posture.js');

// core/ is the host-neutral rollover core — see context-monitor.js's identical note. A missing or broken
// core/ must not break the v1 write above it (byte-for-byte compatibility for one release), so it is
// loaded defensively and every use of it below is wrapped so a core failure degrades to "v2 was not
// attempted" rather than crashing the hook or corrupting the v1 record.
let core = null;
try { core = require('../core/index.js'); } catch { core = null; }

const MAX_LISTED_FILES = 60; // a handoff, not a tree dump
const BYTE_BUDGET = Number(process.env.RESPAWNPACK_CONTEXT_BUDGET_BYTES) || 10000000; // same default as context-monitor.js

/*
 * ⛔ "COULD NOT READ THE POLICY" IS SAID OUT LOUD — ON stderr, NEVER INTO THE DECISION. An UNREADABLE or
 * INVALID declaration resolves to `strict` inside `_posture.js`, so an unverified handoff blocks exactly
 * as it does for a project that declared nothing: the OUTPUT of a broken config is the output of no
 * config, which is what makes "strict is today" checkable. The fact still has to go somewhere, because a
 * run that quietly fell back looks identical to a run that was told to be strict — so it goes to stderr,
 * where `_boot.js` already reports a hook running degraded and where it cannot alter the block reason.
 */
function sayIfUnreadable(resolved) {
  if (resolved.source !== 'UNREADABLE' && resolved.source !== 'INVALID') return;
  try { process.stderr.write(`RespawnPack precompact-ledger-nudge: ${resolved.detail}\n`); } catch { /* stderr is gone */ }
}

function readLedger(dir) {
  try { return fs.readFileSync(path.join(dir, '.respawnpack', 'wave-ledger.md'), 'utf8'); } catch { return null; }
}

// The ledger's last recorded commit endpoint, so the handoff can say whether HEAD has outrun it.
function lastLedgerHash(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\.\.([0-9a-f]{7,40})\b/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/*
 * ⛔ MERGE-CONFLICT BLIND SPOT IN `_runtime.js`'s treeState(), found by the W6c preservation battery.
 * treeState()'s per-file digests read `git diff` and split the output on the `diff --git ` header; an
 * ACTIVELY CONFLICTED path is emitted by git in COMBINED format instead (`diff --cc <path>`, no such
 * header at all — verified directly against real git output), so treeState() records NOTHING for it, at
 * the baseline snapshot and the current one alike. Reproduced directly: a repo with one file mid
 * merge-conflict (`git status` reporting `UU`) makes `treeState(dir).files === {}` for that path — so
 * uncommittedFiles and sessionDelta would silently omit the single dirtiest state a tracked file can be
 * in. That is exactly the "wrong-but-plausible" failure this hook's own handoff exists to prevent:
 * quieter than an honest CANNOT_DETERMINE, because it reads as a clean answer.
 *
 * Closed LOCALLY, without touching `_runtime.js` (core/ and every other hook depend on its existing
 * behavior): `git diff --name-only --diff-filter=U` is a second, independent, cheap source for "which
 * paths are unmerged RIGHT NOW" — a plain point-in-time fact that needs no baseline and is always safe to
 * fold into uncommittedFiles. sessionDelta gets the more conservative treatment below: whether a conflict
 * present now was ALSO present when the baseline was captured is unknowable from here (the baseline's own
 * snapshot has the identical blind spot), so a conflict downgrades sessionDelta to CANNOT_DETERMINE rather
 * than let a possibly-incomplete CHANGED/UNCHANGED verdict stand — the same discipline `_runtime.js`'s own
 * diffStates() states for its no-baseline case: "a check that cannot tell must say so."
 */
function unmergedPaths(dir) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: dir, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))].sort();
  } catch { return []; }
}

/** A single-snapshot context measurement for the machine's `checkpoint` evidence. Byte-proxy, honestly
 * labelled: this hook fires once and needs no more precision than the machine's 0–100 guard requires. */
function byteProxyMeasurement(tp) {
  let size = 0;
  if (typeof tp === 'string' && tp) { try { size = fs.statSync(tp).size; } catch { size = 0; } }
  const usedPercent = Math.max(0, Math.min(100, (size / BYTE_BUDGET) * 100));
  return core.evidence.make(core.evidence.KINDS.CONTEXT_MEASUREMENT, {
    source: 'byte-proxy', usedPercent, raw: { transcriptPath: tp || null, bytes: size },
  });
}

/**
 * Best-effort: open the machine and walk checkpoint → closeout → stage-handoff → verify-handoff →
 * request-compact using the handoff's own write/readback evidence. Returns a short human note describing
 * where the chain stopped, or null if it reached request-compact (COMPACTING) cleanly.
 */
function driveMachineChain(m, input, v2record, writeVerifiedResult) {
  const tag = v2record.handoffId;
  let step = m.apply({
    transition: 'checkpoint', eventId: `checkpoint:${tag}`, evidence: [byteProxyMeasurement(input.transcript_path)],
  });
  if (step.status !== 'APPLIED' && step.status !== 'NOOP') return noteFor('checkpoint', step);

  const boundary = core.evidence.make(core.evidence.KINDS.SAFE_BOUNDARY, {
    mechanism: 'precompact-hook-boundary',
    detail: 'PreCompact fires between model turns; no new model turn begins before this compaction',
    raw: input,
  });
  step = m.apply({ transition: 'closeout', eventId: `closeout:${tag}`, evidence: [boundary] });
  if (step.status !== 'APPLIED' && step.status !== 'NOOP') return noteFor('closeout', step);

  step = m.apply({ transition: 'stage-handoff', eventId: `staged:${tag}`, evidence: [writeVerifiedResult.evidence.written] });
  if (step.status !== 'APPLIED' && step.status !== 'NOOP') return noteFor('stage-handoff', step);

  step = m.apply({ transition: 'verify-handoff', eventId: `verified:${tag}`, evidence: [writeVerifiedResult.evidence.readback] });
  if (step.status !== 'APPLIED' && step.status !== 'NOOP') return noteFor('verify-handoff', step);

  const requested = core.evidence.make(core.evidence.KINDS.COMPACT_REQUESTED, {
    // The interactive profile never calls a compaction API itself — the operator does, or the host
    // auto-compacts on its own — so the mechanism names WHO, honestly, rather than claiming a slash
    // command this hook did not send.
    mechanism: input.trigger === 'manual' ? 'operator-manual' : 'host-auto-compact',
    raw: input,
  });
  step = m.apply({ transition: 'request-compact', eventId: `compact-req:${tag}`, evidence: [requested] });
  if (step.status !== 'APPLIED' && step.status !== 'NOOP') return noteFor('request-compact', step);
  return null; // reached COMPACTING (or NOOP'd a duplicate) cleanly
}

// Both halves, verbatim: `detail` is what happened THIS time, `recovery` is the fixed instruction for
// that failure code (core/policy/failures.js) — neither substitutes for the other.
function noteFor(transition, step) {
  const detail = step.failure ? `${step.failure.code}: ${step.failure.detail || 'no detail recorded'} — ${step.failure.recovery}` : `machine answered ${step.status}`;
  return `rollover machine: ${transition} ${step.status} — ${detail}`;
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }

  const dir = rt.projectDir(input);
  // ⛔ ONE RESOLUTION PER INVOCATION, taken where the pack's other hooks take their `.off` marker check,
  // and BEFORE the handoff is written — so the write cannot depend on the verdict, and so the decision
  // below reads the same declaration the whole invocation reads.
  const stance = posture.resolve(dir);
  const sid = String(input.session_id || 'unknown');
  // ⭐ COMPUTED ONCE (audit BUG-4 / task T-03). sessionDelta's own treeState(dir) used to be a second,
  // entirely redundant five-git-subprocess snapshot of the identical tree — nothing between this line and
  // the old call could have changed it. Passed through explicitly so both consumers read the same fact.
  const state = rt.treeState(dir);
  const delta = rt.sessionDelta(dir, sid, state);
  const ledger = readLedger(dir);

  // Whatever the session last declared it was working on. Written by /savepoint, the goal contract, or
  // by hand — evidence PATHS, never conclusions reconstructed from memory (R-9).
  const atomic = rt.readJSON(path.join(rt.runtimeDir(dir), `atomic-task-${sid.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`));

  // See unmergedPaths() above: fold in paths git itself calls unmerged (treeState() cannot see them),
  // and downgrade the delta verdict to CANNOT_DETERMINE rather than trust a possibly-incomplete one.
  const conflicted = state ? unmergedPaths(dir) : [];
  // ⭐ `rt.pathOf`, not a bucket-prefix slice spelled again here (P5-N-6c): `_runtime.js` owns the rule
  // that turns a `W:`/`S:`/`U:`/`C:` key into a path, and this hook reads it rather than restating it.
  const uncommitted = [...new Set([
    ...(state ? Object.keys(state.files).map(rt.pathOf) : []),
    ...conflicted,
  ])].sort();
  const sessionDeltaForRecord = conflicted.length
    ? { status: 'CANNOT_DETERMINE', files: [], headMoved: delta.headMoved }
    : { status: delta.status, files: delta.files, headMoved: delta.headMoved };

  // --- v1: schema and field semantics UNCHANGED, byte-for-byte — see the file banner. `uncommitted` and
  // `sessionDeltaForRecord` above are still exactly what their v0.2 field names always promised (which
  // paths are currently dirty; a delta verdict); the conflict fix only corrects VALUES treeState() could
  // not see at all, never the record's shape.
  const record = {
    schemaVersion: '1.0.0',
    kind: 'precompact-handoff',
    sessionId: sid,
    trigger: input.trigger || null,
    writtenAt: new Date().toISOString(),
    head: state ? state.head : null,
    uncommittedFiles: uncommitted.slice(0, MAX_LISTED_FILES),
    uncommittedTruncated: uncommitted.length > MAX_LISTED_FILES,
    sessionDelta: { status: sessionDeltaForRecord.status, files: sessionDeltaForRecord.files.slice(0, MAX_LISTED_FILES), headMoved: sessionDeltaForRecord.headMoved },
    ledgerPresent: ledger !== null,
    ledgerLastCommit: ledger ? lastLedgerHash(ledger) : null,
    ledgerBehindHead: Boolean(ledger && state && lastLedgerHash(ledger) && lastLedgerHash(ledger) !== state.head),
    atomicTask: atomic || null,
    contract: rt.readContract(dir).mode,
    readBackVerified: false,
  };

  const file = path.join(rt.runtimeDir(dir), `precompact-${sid.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  const wrote = rt.atomicWriteJSON(file, record);

  // ⭐ Verify the write before claiming it. A handoff that was never persisted is worse than none: the
  // resumed session trusts it. This is the same rule the pack applies to every other check — a step
  // that cannot prove it did anything must not report success.
  let verified = false;
  if (wrote) {
    const back = rt.readJSON(file);
    verified = Boolean(back && back.sessionId === sid && back.writtenAt === record.writtenAt);
    if (verified) rt.atomicWriteJSON(file, { ...record, readBackVerified: true });
  }

  const v1Msg = verified
    ? `v1 handoff persisted (${record.uncommittedFiles.length} uncommitted path(s), HEAD ${String(record.head).slice(0, 7)})` +
      `${record.ledgerBehindHead ? ' · wave-ledger is behind HEAD — append the completed wave' : ''}`
    : 'v1 handoff FAILED (runtime dir unwritable)';

  // --- v2: the hard precondition ---------------------------------------------------------------------
  let v2Msg, blockReason = null, machineNote = null;
  if (!core) {
    blockReason = 'RespawnPack: core/ (the host-neutral rollover core) could not be loaded, so no verified v2 ' +
      'handoff could be written or checked. Do NOT compact: repair the installation (core/index.js must be ' +
      'present and requireable beside hooks/), then retry. Set RESPAWNPACK_ALLOW_UNSAVED_COMPACT=1 to compact ' +
      'anyway and accept the loss of unsaved state.';
    v2Msg = 'v2 handoff NOT attempted (core/ failed to load)';
  } else {
    let m = null;
    let cycleId = `claude-code:${sid}:0:unestablished`;
    try {
      const opened = core.machine.open({ projectDir: dir, host: core.evidence.HOSTS.CLAUDE_CODE, conversationId: sid });
      if (opened.ok) { m = opened.machine; cycleId = m.cycleId(); }
      else machineNote = `rollover machine unavailable: ${opened.failure.code} — ${opened.failure.detail || ''}`;
    } catch (e) { machineNote = `rollover machine threw while opening: ${e && e.message}`; }

    const cdir = core.cycle.conversationDir(dir, core.evidence.HOSTS.CLAUDE_CODE, sid);
    const atomicText = atomic ? (typeof atomic === 'string' ? atomic : (atomic.task || JSON.stringify(atomic))) : null;
    const v2record = core.handoff.build({
      identity: { host: core.evidence.HOSTS.CLAUDE_CODE, conversationId: sid, conversationIdField: 'session_id' },
      contextCycleId: cycleId,
      exactNextAction: atomicText,
      git: {
        head: state ? state.head : null,
        uncommittedFiles: uncommitted,
        sessionDelta: sessionDeltaForRecord,
      },
      unresolvedQuestions: record.ledgerBehindHead
        ? ['.respawnpack/wave-ledger.md was BEHIND HEAD at compaction — a completed wave may be unrecorded']
        : [],
      source: { kind: 'native', raw: { trigger: input.trigger || null, sessionId: sid } },
    });

    let w;
    try { w = core.handoff.writeVerified(cdir, v2record); }
    catch (e) { w = { ok: false, failure: { code: 'HANDOFF_WRITE_FAILED', detail: `writeVerified threw: ${e && e.message}`, recovery: 'Repair the runtime directory and retry; do not compact until a verified handoff exists.' } }; }

    if (!w.ok) {
      const handoffPath = core.handoff.pathFor(cdir, v2record.handoffId);
      blockReason = `RespawnPack: the rollover handoff could not be written and verified at ${handoffPath} ` +
        `(${w.failure.code}: ${w.failure.detail || 'no detail'}). ${w.failure.recovery} Set ` +
        'RESPAWNPACK_ALLOW_UNSAVED_COMPACT=1 to compact anyway and accept the loss of unsaved state.';
      v2Msg = `v2 handoff FAILED: ${w.failure.code} — ${w.failure.detail || 'no detail'}`;
    } else {
      v2Msg = `v2 handoff ${v2record.handoffId} written and verified (cycle ${cycleId})`;
      if (m) {
        try { machineNote = driveMachineChain(m, input, v2record, w) || machineNote; }
        catch (e) { machineNote = `rollover machine chain threw: ${e && e.message}`; }
      }
    }
  }

  /*
   * ⛔ THE DECISION, AND EVERY INPUT TO IT IS ABOUT WHETHER TO REFUSE — NEVER ABOUT WHETHER TO WRITE.
   * Both the v1 record and the v2 write-and-verify are already done above, unconditionally, in every
   * posture (`precompact:handoff-write`, anti-drift item 23).
   *
   * ⛔ AND ON THIS HOOK `off` AND `advise` COLLAPSE, WHICH IS WORTH SAYING RATHER THAN HIDING. `off` is
   * "silent exit 0" everywhere else in ADR-003's vocabulary, and it is not reachable here: the
   * handoff-write report is fixed on and is emitted on EVERY PreCompact run, so this hook has no silent
   * exit to offer. A verdict that is not `deny` therefore means the same thing either way — compact, and
   * say loudly that unsaved state is going with it. ADR-003's table never asks for `off` on this rule;
   * only a founder override could, and it would get an honest advisory rather than a fabricated silence.
   */
  const allowUnsaved = process.env.RESPAWNPACK_ALLOW_UNSAVED_COMPACT === '1';
  sayIfUnreadable(stance);
  const blocks = posture.verdict(stance, 'precompact:block') === 'deny';
  if (blockReason && !allowUnsaved && blocks) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: blockReason,
      systemMessage: `RespawnPack: ${v1Msg}; ${v2Msg}${machineNote ? ` (${machineNote})` : ''} — COMPACTION BLOCKED, see reason.`,
    }));
    process.exit(0);
  }

  /*
   * The two ways a failed handoff still compacts, and each names its own cause. The environment variable
   * is checked first because it is the more specific fact: an operator who set it this run asked for
   * this outcome by hand, and reporting the posture instead would credit a standing policy for a
   * decision somebody just made. Both use the loud path — the escape hatch was never allowed to be
   * silent, and a posture downgrade is not allowed to be quieter than the escape hatch.
   */
  const escapeNote = !blockReason ? ''
    : allowUnsaved
      ? ' — ESCAPE HATCH RESPAWNPACK_ALLOW_UNSAVED_COMPACT=1 is set: compacting anyway. STATE WILL BE LOST.'
      : ` — THE DECLARED POSTURE (${stance.profile}) DOWNGRADES precompact:block TO AN ADVISORY (ADR-003): compacting anyway. STATE WILL BE LOST.`;
  process.stdout.write(JSON.stringify({
    systemMessage: `RespawnPack: ${v1Msg}; ${v2Msg}${machineNote ? ` (${machineNote})` : ''}${escapeNote}`,
  }));
  process.exit(0);
});
