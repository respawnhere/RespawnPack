#!/usr/bin/env node
/*
 * RespawnPack · adapters/codex/hooks/respawnpack-precompact.js — PreCompact hook: the veto that enforces
 * "no compact without a write+readback-verified handoff."
 *
 * ⭐ WHEN THIS HOOK VETOES, AND WHEN IT DOES NOT — TWO DIFFERENT KINDS OF "WE DON'T KNOW ENOUGH".
 *   stdin does not parse, or hook_event_name positively disagrees with PreCompact
 *     → exit 0, no veto. We do not even know this IS a compaction about to happen for a specific
 *       conversation, and a veto grounded in nothing would be noise at best and a permanent lockout at
 *       worst if the host's own plumbing were misbehaving project-wide.
 *   stdin parses AND names (or is silently assumed to be, by construction of how this hook is wired)
 *   PreCompact, but the handoff could not be written and read back
 *     → VETO. From here on the HARD INVARIANT applies: this is a real compaction about to discard
 *       context, so "we could not confirm a verified handoff" is enforced, not merely noted.
 * The escape hatch (`RESPAWNPACK_ALLOW_UNSAVED_COMPACT=1`) only ever applies to the SECOND case — it
 * downgrades a would-be veto to a loud warning. It cannot make the first case veto; it is not needed to.
 *
 * ⛔ THIS HOOK NEVER CALLS `core.machine.apply()`. The shared rollover state machine's own transition
 * table (core/lifecycle/states.js) requires a CONTEXT_MEASUREMENT record to leave ACTIVE at all (the
 * 'checkpoint' transition), and no field documented in a Codex hook payload carries usage or context-
 * window numbers — see adapters/codex/profile.js, where `measureContext` is declared NOT_SUPPORTED at
 * this layer for exactly that reason. Driving 'checkpoint' here would mean inventing a percentage this
 * hook cannot actually measure, which is precisely the "a number's provenance travels with it" discipline
 * core/lifecycle/evidence.js exists to enforce. So this hook uses `core.handoff.writeVerified` directly —
 * a leaf module the transition graph does not gate — and opens the machine ONLY to read a real,
 * core-tracked context-cycle id to bind the handoff to (see core/lifecycle/cycle.js). Nothing here
 * advances state. respawnpack-sessionstart.js is the file that later attempts the machine transitions,
 * honestly reporting when they are refused because this hook could not supply what they require.
 *
 * ⛔ RAW STDIN TRAVELS VERBATIM. Codex's PreCompact payload has no consolidated documented schema beyond
 * the common fields (session_id, cwd, hook_event_name, permission_mode, turn_id, transcript_path, model)
 * plus `trigger` (manual|auto per the matcher). The written handoff's `source.raw` stays null (v2 native
 * handoffs do not carry the triggering payload inline — see core/state/handoff.js), but the raw stdin
 * itself is never discarded: it is what the canary marker and the escape-hatch audit log both carry.
 *
 * Contract: stdin = PreCompact JSON. Veto = stdout {continue:false, reason} + exit 0. Otherwise: NOTHING
 * on stdout (see the header of adapters/codex/hooks/_shared.js's emitAndExit for why an unverified output
 * shape is a real risk — Claude Code's own PreCompact hook rejected `hookSpecificOutput` outright when it
 * used the wrong field; this hook stays silent on stdout unless the ONE documented output shape applies).
 * Always exit 0 — a hook that exits non-zero from this event is documented nowhere as a veto mechanism,
 * and might not even be read as one.
 */
'use strict';
const shared = require('./_shared.js');
const { core } = shared;

const ESCAPE_HATCH_ENV = 'RESPAWNPACK_ALLOW_UNSAVED_COMPACT';
const escapeHatchOn = () => process.env[ESCAPE_HATCH_ENV] === '1';

/** True once we know this really is a PreCompact firing for a specific, nameable conversation — see the
 * file banner for why the safety net's own behaviour depends on this. */
let sawGatingContext = false;
/** Set as soon as we have a real per-conversation directory, so a late failure can still leave an audit
 * trail of an escape-hatch override beside that conversation's other RespawnPack records. */
let conversationDirForAudit = null;

function auditEscapeHatch(reason, rawInput) {
  if (!conversationDirForAudit) return;
  shared.appendMarker(shared.escapeHatchLogPath(conversationDirForAudit), {
    kind: 'escape-hatch-used', env: ESCAPE_HATCH_ENV, reason, raw: rawInput || null,
  });
}

/** Veto, or — with the escape hatch set — warn loudly and let compaction proceed unsaved. */
function decide(reason, rawInput) {
  if (escapeHatchOn()) {
    shared.stderrLine(
      `⚠️⚠️⚠️ COMPACTING WITHOUT A VERIFIED HANDOFF — ${reason} `
      + `${ESCAPE_HATCH_ENV}=1 is set, so RespawnPack is NOT vetoing. State captured since the last `
      + 'verified savepoint may be UNRECOVERABLE once this compaction completes.',
    );
    auditEscapeHatch(reason, rawInput);
    shared.exitSilently();
    return;
  }
  shared.stderrLine(`VETOING compaction — ${reason}`);
  shared.emitAndExit({
    continue: false,
    reason: `RespawnPack: ${reason} Fix the underlying problem and let the next PreCompact retry it, or `
      + `set ${ESCAPE_HATCH_ENV}=1 to compact anyway and accept the data-loss risk.`,
  });
}

shared.installSafetyNet((e) => {
  const detail = `an unexpected error interrupted the pre-compaction handoff — ${(e && e.message) || e}`;
  if (!sawGatingContext) {
    shared.stderrLine(`${detail}; not vetoing because a real PreCompact context for a specific conversation was never established`);
    shared.exitSilently();
    return;
  }
  decide(detail, null);
});

(async () => {
  const rawText = await shared.readStdin();
  const parsed = shared.parseInput(rawText);

  if (!parsed.ok) {
    shared.stderrLine(`stdin did not parse (${parsed.error}); not vetoing an event that cannot be confirmed as a real PreCompact firing`);
    shared.exitSilently();
    return;
  }
  const input = parsed.value;

  const eventName = shared.eventOf(input);
  if (eventName && eventName !== 'PreCompact') {
    shared.stderrLine(`fired under hook_event_name=${JSON.stringify(eventName)}, not "PreCompact"; this script only gates PreCompact, so doing nothing`);
    shared.exitSilently();
    return;
  }

  const projectDir = shared.projectDirOf(input);
  const sid = shared.sidOf(input);

  sawGatingContext = true;
  shared.refreshCanary(projectDir, { event: 'PreCompact', sessionId: sid, raw: input });

  if (!sid) {
    decide('PreCompact fired with no usable session_id, so RespawnPack cannot determine which conversation\'s handoff to write and verify — nothing was persisted for this compaction.', input);
    return;
  }

  // Open (or mint) the machine purely to obtain a real, core-tracked context-cycle id — see the file
  // banner for why no transition is ever applied here.
  const opened = core.machine.open({ projectDir, host: shared.HOST, conversationId: sid });
  if (!opened.ok) {
    decide(`the rollover cycle for this conversation could not be established (${opened.failure.code}): ${opened.failure.recovery}`, input);
    return;
  }
  const dir = opened.machine.dir;
  conversationDirForAudit = dir;
  const cycleId = opened.machine.cycleId();

  const note = shared.peekPendingNote(projectDir);
  const unresolvedQuestions = [...note.fields.unresolvedQuestions];
  if (!note.present) {
    unresolvedQuestions.push(
      'no pending savepoint note was found at .respawnpack/runtime/rollover/_codex-pending-note.json '
      + '(see adapters/codex/skills/respawn-rollover/SKILL.md) — exactNextAction and atomicActionId are unset for this handoff',
    );
  }
  if (note.dropped.length) {
    unresolvedQuestions.push(`the pending savepoint note had malformed field(s), dropped rather than trusted: ${note.dropped.join(', ')}`);
  }

  const record = core.handoff.build({
    identity: { host: shared.HOST, conversationId: sid, conversationIdField: 'session_id' },
    contextCycleId: cycleId,
    atomicActionId: note.fields.atomicActionId,
    exactNextAction: note.fields.exactNextAction,
    git: {
      head: shared.gitHead(projectDir),
      uncommittedFiles: shared.gitUncommittedFiles(projectDir),
      // No SessionStart-time baseline is captured at this layer yet (see adapters/codex/README.md,
      // "What W3b + the installer wave must pick up") — so a since-session delta is honestly
      // CANNOT_DETERMINE rather than approximated from a baseline this hook never recorded.
      sessionDelta: { status: 'CANNOT_DETERMINE', files: [], headMoved: false },
    },
    userConstraints: note.fields.userConstraints,
    unresolvedQuestions,
    candidateMemories: note.fields.candidateMemories,
    verificationEvidence: note.fields.verificationEvidence,
    source: { kind: 'native', raw: null },
  });

  const w = core.handoff.writeVerified(dir, record);
  if (!w.ok) {
    decide(`the handoff could not be written and read back cleanly (${w.failure.code}): ${w.failure.recovery}`, input);
    return;
  }

  shared.writeLatestHandoffPointer(dir, { handoffId: record.handoffId, cycleIdAtWrite: cycleId });
  shared.writeLastActive(projectDir, { conversationId: sid, handoffId: record.handoffId });
  shared.clearPendingNote(projectDir);

  shared.stderrLine(`handoff ${record.handoffId} written and read-back verified at ${w.handoffPath} (cycle ${cycleId})`);
  shared.exitSilently();
})();
