#!/usr/bin/env node
/*
 * RespawnPack · adapters/codex/hooks/respawnpack-sessionstart.js — SessionStart hook: rehydration on
 * source==="compact", a minimal canary touch on every other source.
 *
 * ⭐ TWO LAYERS OF VALUE, DELIBERATELY SEPARATED, BECAUSE ONLY ONE OF THEM WORKS TODAY.
 *   Layer 1 — `core.handoff.consume()`. Depends ONLY on the verified/consumed receipt files
 *     respawnpack-precompact.js leaves beside the handoff document. Exactly-once, and independent of any
 *     core state-machine transition. This is what actually delivers the rehydrated context and enforces
 *     "never inject the same atomic action twice" — TODAY, in a hooks-only install.
 *   Layer 2 — `core.machine.apply('observe-completion' / 'verify-identity')`. The shared rollover state
 *     machine's OWN transition-gated protocol. It is attempted honestly on every firing, but in a
 *     hooks-only profile it will almost always come back REFUSED: the machine is still ACTIVE, because
 *     nothing in this profile can supply the CONTEXT_MEASUREMENT evidence 'checkpoint' requires to ever
 *     leave ACTIVE (see respawnpack-precompact.js's banner). That refusal is reported, never hidden — an
 *     adapter that quietly worked around the shared machine's own guard would be exactly the kind of
 *     unearned confidence core/ exists to refuse. Once an app-server-driven profile (W3b) shares this
 *     SAME on-disk journal and drives the machine through 'checkpoint' → 'request-compact', THIS hook's
 *     Layer-2 attempt starts succeeding for free, with no code change here.
 *
 * ⭐ THE IDENTITY COMPARISON IS DELIBERATELY NOT TAUTOLOGICAL. "Same conversation" has to compare against
 * something that was NOT looked up using the very id being verified, or the check always agrees with
 * itself. `_codex-last-active.json` is a project-level pointer written ONLY by PreCompact (recording the
 * session_id IT observed) and read ONLY here, against THIS firing's own observed session_id. If Codex
 * ever delivers SessionStart(compact) for a different session than the one that last ran PreCompact, this
 * is where that would be caught — expectedId != observedId, surfaced honestly rather than assumed away.
 *
 * ⛔ THE eventId FOR BOTH MACHINE TRANSITIONS IS THE HANDOFF ID, NOT A FRESH RANDOM VALUE. Codex gives
 * hook payloads no explicit "this specific delivery" identifier, so the most natural stable correlator
 * available is which handoff this firing is rehydrating: the SAME handoff → the SAME eventId → the core
 * machine's own duplicate-suppression (core/lifecycle/machine.js's NOOP path) recognises a redelivered
 * SessionStart(compact) exactly as conformance/fixtures/04-duplicate-session-start-compact.json does. A
 * genuinely NEW compaction always produces a NEW handoff id, so this does not collapse distinct rollovers.
 *
 * ⛔ OTHER SOURCES (startup|resume|clear) GET A CANARY TOUCH ONLY. Per the brief: do not recreate Claude's
 * STATE.json boot here. Codex targets get their spine boot from AGENTS.md (root-down concatenation, 32KiB
 * cap, per the open agent skills standard) — that is a documentation/packaging concern, not a hook, and
 * inventing a parallel injection path here would duplicate a decision the Claude adapter already owns for
 * ITS host. See adapters/codex/README.md.
 *
 * Contract: stdin = SessionStart JSON {source, session_id, cwd, ...}. On source==="compact" with
 * something to report: stdout {hookSpecificOutput:{hookEventName:"SessionStart", additionalContext}} —
 * mirroring Claude Code's documented envelope, UNVERIFIED against a live trusted Codex install (see
 * adapters/codex/README.md, "Template honesty"). Otherwise: NOTHING on stdout. Always exit 0.
 */
'use strict';
const shared = require('./_shared.js');
const { core } = shared;
const { KINDS } = core.evidence;

const CONTEXT_BUDGET = 1800;
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : (s || ''));

function renderHandoff(h) {
  const L = [];
  if (h.exactNextAction) L.push(`- exact next action: ${h.exactNextAction}`);
  if (h.atomicActionId) L.push(`- atomic action id: ${h.atomicActionId}`);
  if (h.git && h.git.head) L.push(`- HEAD at compaction: ${String(h.git.head).slice(0, 12)}`);
  if (h.git && h.git.uncommittedFiles && h.git.uncommittedFiles.length) {
    L.push(`- uncommitted at compaction (${h.git.uncommittedFiles.length}${h.git.uncommittedTruncated ? '+, truncated' : ''}): ${h.git.uncommittedFiles.slice(0, 10).join(', ')}`);
  }
  if (h.userConstraints && h.userConstraints.length) L.push(`- constraints: ${h.userConstraints.join(' · ')}`);
  if (h.unresolvedQuestions && h.unresolvedQuestions.length) L.push(`- unresolved: ${h.unresolvedQuestions.join(' · ')}`);
  // handoff.candidateMemories is IDS ONLY by design (core/state/handoff.js) — never the claim text, so
  // this never renders a candidate lead as though it were established.
  if (h.candidateMemories && h.candidateMemories.length) L.push(`- candidate memory ids (unverified leads, look them up before trusting): ${h.candidateMemories.join(', ')}`);
  return L.length ? L.join('\n') : '(the handoff carried no exact-next-action content — see adapters/codex/skills/respawn-rollover/SKILL.md for the savepoint-note step)';
}

function identityLine(expectedId, observedId, equal) {
  if (equal === true) return `Same conversation confirmed: ${observedId}.`;
  if (equal === false) return `⚠️ IDENTITY MISMATCH — RespawnPack last observed PreCompact for ${expectedId}, but this SessionStart(compact) reports ${observedId}. This may not be an in-place rollover; treat continuity as unverified.`;
  return `Identity could not be cross-checked (no prior PreCompact pointer recorded for this project) — observed session_id ${observedId}.`;
}

function attemptMachine(projectDir, sid, handoffId, input, expectedId, observedId, equal) {
  const opened = core.machine.open({ projectDir, host: shared.HOST, conversationId: sid });
  if (!opened.ok) {
    return `core rollover state machine could not be opened (${opened.failure.code}): ${opened.failure.recovery}`;
  }
  const m = opened.machine;
  const beforeIndex = m.cycleIndex();

  const completedEv = core.evidence.make(KINDS.COMPACT_COMPLETED, { signal: 'session_start_compact', raw: input });
  const rComplete = m.apply({ transition: 'observe-completion', eventId: handoffId, evidence: [completedEv] });

  // ⛔ P1-CT-11 RETRY GAP, FIXED HERE. A NOOP from observe-completion means only that THIS delivery did
  // not newly apply it — never that verify-identity already ran. A prior firing can apply
  // observe-completion (COMPACTING -> REHYDRATING) and then be killed before reaching the verify-identity
  // call below, leaving REHYDRATING parked with identity never checked. The old code `return`ed right
  // here on NOOP, which made that a PERMANENT gap: this hook is the only place verify-identity is
  // attempted, so the redelivered SessionStart(compact) that Codex actually gives us after a crash would
  // never retry it, and an in-place rollover would sit forever unverified — never reported verified
  // (fail-closed on that count), but also never reported honestly again after this one line. So NOOP now
  // falls through to the SAME verify-identity attempt the APPLIED branch always took, merely prefixed
  // with its own note. Falling through is safe even when identity WAS already verified by a prior
  // delivery: the machine's own eventId-keyed idempotency (`appliedByEvent`, durable in the on-disk
  // journal — core/lifecycle/machine.js) recognizes that verify-identity call as a duplicate of itself and
  // answers NOOP rather than re-deciding anything, so this never re-verifies, never flips a mismatch to a
  // match, and never fabricates a completion signal (core/lifecycle/evidence.js's FORBIDDEN_PROOF_TOKENS
  // stays untouched — nothing here treats this retry itself as proof of anything).
  let prefix = '';
  if (rComplete.status === 'NOOP') {
    prefix = 'core rollover state machine: duplicate observe-completion recognized as a no-op (already recorded). ';
  } else if (rComplete.status !== 'APPLIED') {
    return `core rollover state machine did not track this rollover (${rComplete.failure.code}): ${rComplete.failure.recovery} `
      + '(expected under the hooks-only profile — see adapters/codex/README.md).';
  }
  if (expectedId === null) {
    return `${prefix}core rollover state machine: no prior-conversation pointer exists yet to construct an identity-verification record, so verify-identity was not attempted.`;
  }

  const identEv = core.evidence.make(KINDS.IDENTITY_VERIFICATION, { expectedId, observedId, equal, raw: input });
  const rIdentity = m.apply({ transition: 'verify-identity', eventId: handoffId, evidence: [identEv] });
  if (rIdentity.status === 'APPLIED') {
    return `${prefix}core rollover state machine: verified in-place rollover, cycle ${beforeIndex} -> ${m.cycleIndex()}.`;
  }
  if (rIdentity.status === 'NOOP') {
    return `${prefix}core rollover state machine: duplicate verify-identity recognized as a no-op (cycle already advanced for this handoff).`;
  }
  return `${prefix}core rollover state machine refused verify-identity (${rIdentity.failure.code}): ${rIdentity.failure.recovery}`;
}

shared.installSafetyNet((e) => {
  shared.stderrLine(`unexpected error while rehydrating — ${(e && e.message) || e}; booting with nothing injected rather than risk a malformed output`);
  shared.exitSilently();
});

(async () => {
  const rawText = await shared.readStdin();
  const parsed = shared.parseInput(rawText);
  if (!parsed.ok) {
    shared.stderrLine(`stdin did not parse (${parsed.error}); booting with nothing injected`);
    shared.exitSilently();
    return;
  }
  const input = parsed.value;
  const projectDir = shared.projectDirOf(input);
  const sid = shared.sidOf(input);
  const source = shared.isNonEmptyString(input.source) ? input.source : null;

  shared.refreshCanary(projectDir, { event: `SessionStart:${source || 'unknown'}`, sessionId: sid, raw: input });

  if (source !== 'compact') {
    // Minimal routing/canary touch only, per the brief — Claude's STATE.json boot is that adapter's own
    // concern, and a Codex target's spine boot comes from AGENTS.md, not from this hook.
    shared.exitSilently();
    return;
  }

  if (!sid) {
    shared.emitAndExit({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'RespawnPack: SessionStart(source=compact) fired with no usable session_id, so no handoff could be located. If continuity was expected, check that this Codex build sends session_id on SessionStart.',
      },
    });
    return;
  }

  const dir = shared.conversationDir(projectDir, sid);
  const pointer = shared.readLatestHandoffPointer(dir);
  const lastActive = shared.readLastActive(projectDir);
  const expectedId = lastActive ? lastActive.conversationId : null;
  const observedId = sid;
  const equal = expectedId !== null ? (expectedId === observedId) : null;

  if (!pointer) {
    shared.emitAndExit({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: clip(
          `RespawnPack: no pending handoff was found for this conversation (${dir}). Nothing to rehydrate — `
          + 'either no PreCompact fired for this session, or its handoff could not be written (check the '
          + `PreCompact hook's stderr). ${identityLine(expectedId, observedId, equal)}`,
          CONTEXT_BUDGET,
        ),
      },
    });
    return;
  }

  const handoffId = pointer.handoffId;
  const consumeResult = core.handoff.consume(dir, handoffId, { consumerId: 'codex-sessionstart-hook', at: shared.nowISO() });
  const machineNote = attemptMachine(projectDir, sid, handoffId, input, expectedId, observedId, equal);

  let body;
  if (consumeResult.status === 'CONSUMED') {
    body = [
      `RespawnPack: rehydrated handoff ${handoffId}.`,
      identityLine(expectedId, observedId, equal),
      renderHandoff(consumeResult.handoff),
      machineNote,
    ].join('\n');
  } else if (consumeResult.status === 'ALREADY_CONSUMED') {
    // Pointer note only — never re-render the handoff content, which is exactly how the SAME atomic
    // action would be delivered twice.
    const first = consumeResult.receipt || {};
    body = `RespawnPack: handoff ${handoffId} was already consumed at ${first.consumedAt || 'an earlier time'} `
      + `by ${first.consumerId || 'an earlier delivery'}. Not re-injecting it. ${machineNote}`;
  } else {
    // REFUSED or CANNOT_DETERMINE — inject the failure and its recovery instruction verbatim, never
    // paraphrased, per core/policy/failures.js's own discipline.
    const f = consumeResult.failure;
    body = `RespawnPack: could not consume handoff ${handoffId} (${consumeResult.status} — ${f.code}): ${f.recovery} ${machineNote}`;
  }

  shared.emitAndExit({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: clip(body, CONTEXT_BUDGET) },
  });
})();
