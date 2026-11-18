/*
 * RespawnPack · adapters/claude-code/sdk-supervisor/supervisor.js — the MANAGED profile: a supervisor
 * that owns a Claude Code conversation and rolls it over IN PLACE, through the host-neutral core.
 *
 * ⭐ WHAT "MANAGED" BUYS, stated against the interactive profile it sits beside. In an interactive
 * session a hook can measure, warn, and refuse — but it cannot make the client compact itself, so the
 * operator types `/compact` and the pack watches. Here the supervisor IS the client: it issues the
 * turns, so it can stop at a boundary of its own choosing, request the compaction through the
 * documented slash command, watch the same conversation's stream for the documented completion, and
 * continue. Automatic, in place, with the session id preserved.
 *
 * ⛔ EVERY STEP GOES THROUGH core/lifecycle/machine.js, AND NOTHING HERE RE-DECIDES WHAT THAT MACHINE
 * DECIDES. The compaction request is not sent unless `request-compact` was APPLIED — which the machine
 * only allows from HANDOFF_VERIFIED, which it only reaches on a read-back comparison of two digests.
 * The invariant is therefore structural, not a rule this file remembers to follow:
 *
 *     const applied = m.apply({transition:'request-compact', …});
 *     if (applied.status !== 'APPLIED') return …;   // ← the /compact turn is never spawned
 *     await cli.runTurn({prompt:'/compact', …});
 *
 * ⛔ THE COMPLETION EVIDENCE IS THE CONTROL-FLOW MESSAGE, NEVER THE RESULT ENVELOPE. See stream.js: a
 * compaction that FAILED returns `is_error:false, subtype:"success"`. That is captured, real, and in
 * this repository's fixtures.
 *
 * ⛔ A TIMEOUT, AN EXIT AND A CLOSED PIPE ARE NOT COMPLETIONS. They produce COMPACT_UNOBSERVED and a
 * CANNOT_DETERMINE halt. core/lifecycle/evidence.js would refuse them by name if this file tried.
 *
 * ⛔ AND THE BYTES ARE KEPT. Every turn is written to <conversationDir>/turns/turn-NNN.json with the
 * host's lines VERBATIM before any of them is interpreted. The core journal records DECISIONS and
 * carries the evidence records of applied transitions; halts and refusals do not carry evidence
 * payloads, so the turn files are what a later reviewer re-reads to check this adapter's reading.
 *
 * ⛔ v0.3 DOES NOT INTERRUPT A TURN. A turn boundary is the host's own `result` message. If a turn is
 * in flight when the final threshold is crossed, the supervisor WAITS for it — mid-stream interruption
 * would need the control protocol's interrupt request, whose settling semantics are not verified here,
 * and "we told it to stop" is not the same observation as "it stopped".
 */

'use strict';

const path = require('path');
const crypto = require('crypto');

const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));
const stream = require('./stream.js');
const measureLib = require('./measure.js');
const cliLib = require('./cli.js');

const { io, machine, evidence, thresholds, handoff, consumable, failures } = core;
const { OUTCOME } = failures;

const HOST = evidence.HOSTS.CLAUDE_CODE;
const CONVERSATION_ID_FIELD = 'session_id';
const COMPACT_PROMPT = '/compact';

/** Results this module returns. Distinct from core's OUTCOME on purpose: these describe an ATTEMPT. */
const STEP = {
  OK: 'OK',
  REFUSED: 'REFUSED',
  HALTED: 'HALTED',
  NOOP: 'NOOP',
  CANNOT_DETERMINE: 'CANNOT_DETERMINE',
};

const nowISO = () => new Date().toISOString();

/**
 * Build a supervisor. `projectDir` is REQUIRED and never defaulted: a supervisor that fell back to
 * process.cwd() would write rollover state into whatever repository happened to be current — including
 * this one, while its own tests were running.
 */
function createSupervisor(options = {}) {
  const {
    projectDir,
    cwd = null,
    cli = cliLib.realCli,
    claudePath = null,
    model = null,
    tools = null,
    allowedTools = null,
    permissionMode = null,
    extraArgs = [],
    env = process.env,
    timeoutMs = cliLib.DEFAULT_TIMEOUT_MS,
    thresholdConfig = null,
    contextBudgetTokens = null,
    consumerId = null,
    now = nowISO,
    onEvent = null,
  } = options;

  if (typeof projectDir !== 'string' || !projectDir) {
    throw new Error('createSupervisor: projectDir is required — this supervisor never guesses which project it is rolling over');
  }

  const state = {
    sessionId: null,
    machine: null,
    dir: null,
    turnSeq: 0,
    turns: [],
    lastTurn: null,
    lastObservation: null,
    pendingHandoff: null,     // { handoffId, handoffPath, writtenDigest }
    lastDrift: null,          // set when a resumed turn answered from a different conversation
    probeResult: null,
    rollovers: [],
  };

  const myConsumerId = consumerId || `sdk-supervisor:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  const emit = (kind, payload) => { if (onEvent) { try { onEvent(kind, payload); } catch { /* a reporter must not break a rollover */ } } };

  // ---------------------------------------------------------------------------------------------
  // turn capture — the verbatim record, written BEFORE anything is interpreted
  // ---------------------------------------------------------------------------------------------

  function turnsDir() { return state.dir ? path.join(state.dir, 'turns') : null; }

  function persistTurn(label, turn, observation) {
    state.turnSeq += 1;
    const seq = String(state.turnSeq).padStart(3, '0');
    const doc = {
      kind: 'claude-cli-turn',
      seq: state.turnSeq,
      label,
      at: now(),
      argv: turn.argv || [],
      exePath: turn.exePath || null,
      promptDigest: io.digest(turn.__prompt === undefined ? '' : String(turn.__prompt)),
      promptBytes: Buffer.byteLength(turn.__prompt === undefined ? '' : String(turn.__prompt), 'utf8'),
      exit: { code: turn.code ?? null, signal: turn.signal ?? null, timedOut: Boolean(turn.timedOut), spawnError: turn.spawnError || null },
      durationMs: turn.durationMs ?? null,
      // VERBATIM. Not reformatted, not re-serialised from the parsed objects.
      lines: (turn.stdoutLines || []).slice(),
      stderr: turn.stderr || '',
      sessionId: observation ? stream.sessionIdOf(observation) : null,
      unparsedLines: observation ? observation.unparsed : [],
    };
    const file = turnsDir() ? path.join(turnsDir(), `turn-${seq}.json`) : null;
    let written = { ok: false, detail: 'no conversation directory yet' };
    if (file) written = io.writeAtomicJSON(file, doc);
    const record = { seq: state.turnSeq, label, file, written: written.ok, digest: written.digest || null, doc };
    state.turns.push(record);
    emit('turn', record);
    return record;
  }

  // ---------------------------------------------------------------------------------------------
  // the seven capabilities
  // ---------------------------------------------------------------------------------------------

  /**
   * probe — prove the configured integration is ACTIVE, and separate "not installed" from
   * "installed and not authenticated". Those are different owner actions.
   *
   * The init message is emitted BEFORE credentials are used, so the structural facts (version, the
   * slash-command set, whether `compact` is dispatchable) are readable even when the handshake then
   * fails to authenticate. Both halves are reported; neither is allowed to stand in for the other.
   */
  async function probe({ handshake = true, handshakePrompt = 'Reply with exactly: RESPAWNPACK-PROBE-OK', probeCwd = null } = {}) {
    const version = await cli.runVersion({ claudePath, env, cwd: probeCwd || cwd || projectDir });
    if (!version.ok) {
      // ⭐ P1-N-2 — CONSUME cli.js's OWN cwd DIAGNOSIS, NOT version.why AS TEXT. d669844 exported
      // `checkCwd` from cli.js precisely so a caller could re-ask "was the directory the problem?"
      // through the SAME pure fs.statSync check runVersion already ran, instead of guessing from
      // `version.exePath` alone — which is truthy whenever the executable resolved, regardless of
      // why the version check then failed, and previously blamed the executable for a missing cwd.
      const cwdCheck = cliLib.checkCwd(probeCwd || cwd || projectDir);
      const ownerAction = !cwdCheck.ok
        ? `${cwdCheck.why}. Create the directory, or correct the path this supervisor was given.`
        : version.exePath
          ? `\`${version.exePath} --version\` did not answer. Run it by hand and resolve what it reports.`
          : 'Install Claude Code, or point RESPAWNPACK_CLAUDE_PATH at the executable.';
      const result = {
        outcome: OUTCOME.CANNOT_DETERMINE,
        installed: Boolean(version.exePath),
        authenticated: null,
        version: null,
        exePath: version.exePath || null,
        why: version.why || 'the claude executable could not be run',
        verbatim: { stdout: version.stdout || '', stderr: version.stderr || '' },
        searched: version.searched || null,
        ownerAction,
      };
      state.probeResult = result;
      return result;
    }

    if (!handshake) {
      const result = {
        outcome: OUTCOME.CANNOT_DETERMINE,
        installed: true, authenticated: null, version: version.version, exePath: version.exePath,
        why: 'the version check passed and no handshake was run, so whether this integration can actually take a turn is unknown',
        verbatim: { stdout: version.stdout, stderr: version.stderr },
        ownerAction: 'run probe({handshake:true}) from an authenticated context',
      };
      state.probeResult = result;
      return result;
    }

    const turn = await cli.runTurn({
      cwd: probeCwd || cwd || projectDir, claudePath, env, timeoutMs: Math.min(timeoutMs, cliLib.PROBE_TIMEOUT_MS),
      prompt: handshakePrompt, promptVia: 'stdin', model, tools: tools === null ? '' : tools,
      allowedTools, permissionMode, extraArgs,
    });
    const obs = stream.observe(turn.stdoutLines || []);
    const compactCmd = stream.supportsCompactCommand(obs);

    const structural = {
      initSeen: Boolean(obs.init),
      sessionId: stream.sessionIdOf(obs),
      claudeCodeVersion: obs.init ? obs.init.claude_code_version || null : null,
      model: obs.init ? obs.init.model || null : null,
      apiKeySource: obs.init ? obs.init.apiKeySource || null : null,
      slashCommandCount: compactCmd.commands ? compactCmd.commands.length : 0,
      compactCommandPresent: compactCmd.present,
      capabilities: obs.init && Array.isArray(obs.init.capabilities) ? obs.init.capabilities.slice() : [],
    };

    if (obs.auth.failed) {
      const result = {
        outcome: OUTCOME.CANNOT_DETERMINE,
        installed: true,
        authenticated: false,
        version: version.version,
        exePath: version.exePath,
        structural,
        why: `the host answered, and what it answered was an authentication failure (${obs.auth.from}): ${obs.auth.verbatim}`,
        // Verbatim, from wherever the host put it. In this environment it arrived on STDOUT inside the
        // assistant message, not on stderr — so both are kept and neither is assumed.
        verbatim: { authMessage: obs.auth.verbatim, phrase: obs.auth.phrase, from: obs.auth.from, stderr: turn.stderr || '', lines: (turn.stdoutLines || []).slice() },
        ownerAction: 'Run `claude` interactively once in this environment and complete /login, then re-run this probe from that authenticated context. RespawnPack never handles credentials.',
      };
      state.probeResult = result;
      emit('probe', result);
      return result;
    }

    if (turn.timedOut || turn.spawnError || !obs.result) {
      const result = {
        outcome: OUTCOME.CANNOT_DETERMINE,
        installed: true, authenticated: null, version: version.version, exePath: version.exePath, structural,
        why: turn.timedOut
          ? `the handshake turn was still running at the ${Math.min(timeoutMs, cliLib.PROBE_TIMEOUT_MS)}ms deadline and was killed — a killed turn observes nothing`
          : (turn.spawnError || 'the handshake produced no result message'),
        verbatim: { stderr: turn.stderr || '', lines: (turn.stdoutLines || []).slice() },
        ownerAction: 'Run the same invocation by hand (the argv is in this record) and see what the host does.',
      };
      state.probeResult = result;
      emit('probe', result);
      return result;
    }

    const result = {
      outcome: compactCmd.present ? OUTCOME.PASS : OUTCOME.FAIL,
      installed: true,
      authenticated: true,
      version: version.version,
      exePath: version.exePath,
      structural,
      sessionId: structural.sessionId,
      why: compactCmd.present
        ? null
        : `this build dispatched ${structural.slashCommandCount} slash commands and "compact" is not among them, so there is no documented mechanism to request a compaction`,
      verbatim: { lines: (turn.stdoutLines || []).slice(), stderr: turn.stderr || '' },
      raw: obs.init ? JSON.stringify(obs.init) : (obs.result ? obs.result.raw : null),
      observedAt: now(),
    };
    state.probeResult = result;
    emit('probe', result);
    return result;
  }

  /** Open (or restore) the machine for a conversation id. Idempotent. */
  function attach(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { status: STEP.CANNOT_DETERMINE, why: 'the host exposed no session id, so there is no conversation to attach to' };
    }
    if (state.machine && state.sessionId === sessionId) return { status: STEP.OK, machine: state.machine, dir: state.dir, reopened: false };
    const opened = machine.open({ projectDir, host: HOST, conversationId: sessionId });
    if (!opened.ok) return { status: STEP.CANNOT_DETERMINE, failure: opened.failure, why: opened.failure.detail };
    state.machine = opened.machine;
    state.sessionId = sessionId;
    state.dir = opened.machine.dir;
    emit('attach', { sessionId, dir: state.dir, opened: opened.opened });
    return { status: STEP.OK, machine: opened.machine, dir: state.dir, opened: opened.opened, reopened: Boolean(opened.opened.restored) };
  }

  /**
   * Run one turn of the supervised conversation. The first call has no session to resume, so the id is
   * OBSERVED from what the host reports rather than dictated — which is also what makes the later
   * identity check a comparison of two observations instead of a comparison with our own assumption.
   */
  async function turn({ prompt, label = 'turn', resume = true, expectSessionId = undefined }) {
    const sessionId = resume ? (expectSessionId === undefined ? state.sessionId : expectSessionId) : null;
    const sessionIdBefore = state.sessionId;
    const raw = await cli.runTurn({
      cwd: cwd || projectDir, claudePath, env, timeoutMs,
      prompt, promptVia: 'stdin', sessionId, model, tools, allowedTools, permissionMode, extraArgs,
    });
    raw.__prompt = prompt;
    const observation = stream.observe(raw.stdoutLines || []);
    const observedSessionId = stream.sessionIdOf(observation);

    if (!state.machine && observedSessionId) attach(observedSessionId);
    const record = persistTurn(label, raw, observation);

    /*
     * ⛔ A RESUME THAT ANSWERS FROM A DIFFERENT CONVERSATION IS A FORK, AND IT IS SILENT. `--resume`
     * is documented to keep the session id and `--fork-session` is the documented way to change it,
     * but a supervisor that never compared would keep working — against the wrong conversation, with
     * the right handoff. The drift is REPORTED here and settleOrStop refuses to produce a boundary
     * from a drifted turn, so no rollover can be built on one. The compaction path keeps its own,
     * canonical check: the machine's identity guard.
     */
    const identityDrift = (sessionIdBefore && observedSessionId && observedSessionId !== sessionIdBefore)
      ? { expected: sessionIdBefore, observed: observedSessionId }
      : null;
    if (identityDrift) emit('identity-drift', { ...identityDrift, label });

    state.lastTurn = raw;
    state.lastObservation = observation;
    state.lastDrift = identityDrift;
    return { turn: raw, observation, sessionId: observedSessionId, record, identityDrift };
  }

  /** measureContext — usage over budget, with the budget's provenance attached. See measure.js. */
  function measureContext({ observation = state.lastObservation, observedAt = null } = {}) {
    if (!observation) return { measurable: false, usedPercent: null, why: 'no turn has been observed yet', record: null };
    return measureLib.measure({ observation, env, contextBudgetTokens, observedAt });
  }

  /** The cycle's latch record, re-armed automatically when the cycle changed. */
  function latches() {
    const read = thresholds.readLatches(state.dir);
    // An unreadable latch record is treated as ABSENT and the re-arm is REPORTED: a duplicate
    // checkpoint costs one extra handoff, while assuming "already latched" costs silence at 85%.
    const forCycle = thresholds.forCycle(read.status === 'OK' ? read.record : null, state.machine.cycleId());
    return { ...forCycle, readStatus: read.status };
  }

  /** Persist the latches for the thresholds that just fired, in the CURRENT cycle. */
  function latchFired(ts) {
    if (!ts || !ts.evaluation || !ts.evaluation.fire.length) return { ok: true, latched: [] };
    const l = latches();
    let record = l.record;
    for (const name of ts.evaluation.fire) record = thresholds.latch(record, name, { atPercent: ts.measurement.usedPercent });
    const w = thresholds.writeLatches(state.dir, record);
    return { ok: w.ok, latched: Object.keys(record.latched), detail: w.detail || null };
  }

  function thresholdState({ observation = state.lastObservation } = {}) {
    const m = measureContext({ observation });
    const l = latches();
    const ev = measureLib.evaluate({ measurement: m, latchRecord: l.record, thresholdConfig });
    return { measurement: m, latch: l, ...ev };
  }

  /**
   * settleOrStop — reach a boundary without duplicating work.
   *
   * In this profile a turn is one child process and the boundary is the host's own `result` message.
   * There is nothing to interrupt: the supervisor holds the only handle, and it does not issue the next
   * turn until this one has answered. A turn that was KILLED (deadline, crash) produces no boundary —
   * and gets none invented for it.
   */
  function settleOrStop({ turn: t = state.lastTurn, observation = state.lastObservation } = {}) {
    if (!t || !observation) return { status: STEP.CANNOT_DETERMINE, settled: false, why: 'no turn has been run' };
    if (state.lastDrift) {
      return {
        status: STEP.CANNOT_DETERMINE, settled: false, identityDrift: state.lastDrift,
        why: `the last turn answered from ${state.lastDrift.observed} while this supervisor is driving ${state.lastDrift.expected}. `
          + 'That is a fork, not a boundary — no rollover may be built on it.',
      };
    }
    if (t.timedOut) {
      return {
        status: STEP.CANNOT_DETERMINE, settled: false,
        why: `the turn was killed at the ${timeoutMs}ms deadline. A killed turn is not a settled turn, and the clock is not a boundary.`,
      };
    }
    if (!observation.result) {
      return {
        status: STEP.CANNOT_DETERMINE, settled: false,
        why: `the turn produced no result message (exit ${t.code}${t.signal ? `, signal ${t.signal}` : ''}), so the host never reported a boundary`,
      };
    }
    const record = evidence.make(evidence.KINDS.SAFE_BOUNDARY, {
      mechanism: 'headless-turn-result',
      detail: 'the host emitted the turn\'s result message and the process exited; no new model turn has been started',
      sessionId: observation.result.msg.session_id || null,
      raw: observation.result.raw,
      observedAt: now(),
    });
    return { status: STEP.OK, settled: true, record, resultUuid: observation.result.msg.uuid || null };
  }

  // ---------------------------------------------------------------------------------------------
  // handoff staging
  // ---------------------------------------------------------------------------------------------

  /**
   * Write the handoff, read it back, compare the digests, and walk the machine to HANDOFF_VERIFIED.
   * Called at the FINAL threshold — before the compaction, while there is still room to do it well.
   */
  function stageHandoff({ measurementRecord, boundaryRecord, fields = {} }) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };

    const measureEventId = eventIdFor('measure', measurementRecord);
    const cp = m.apply({ transition: 'checkpoint', eventId: measureEventId, evidence: [measurementRecord] });
    if (cp.status !== 'APPLIED' && cp.status !== 'NOOP') return stepFrom(cp, 'checkpoint');

    const boundaryEventId = eventIdFor('boundary', boundaryRecord);
    const co = m.apply({ transition: 'closeout', eventId: boundaryEventId, evidence: [boundaryRecord] });
    if (co.status !== 'APPLIED' && co.status !== 'NOOP') return stepFrom(co, 'closeout');

    const record = handoff.build({
      identity: { host: HOST, conversationId: state.sessionId, conversationIdField: CONVERSATION_ID_FIELD },
      contextCycleId: m.cycleId(),
      ...fields,
    });

    const w = handoff.writeVerified(state.dir, record);
    if (!w.ok) {
      const halted = m.apply({ transition: 'halt', eventId: `handoff-write:${record.handoffId}`, failureCode: w.failure.code, detail: w.failure.detail });
      return { status: STEP.HALTED, failure: w.failure, halt: halted, why: w.failure.detail };
    }

    const staged = m.apply({ transition: 'stage-handoff', eventId: `staged:${record.handoffId}`, evidence: [w.evidence.written] });
    if (staged.status !== 'APPLIED' && staged.status !== 'NOOP') return stepFrom(staged, 'stage-handoff');

    const verified = m.apply({ transition: 'verify-handoff', eventId: `verified:${record.handoffId}`, evidence: [w.evidence.readback] });
    if (verified.status !== 'APPLIED' && verified.status !== 'NOOP') return stepFrom(verified, 'verify-handoff');

    state.pendingHandoff = { handoffId: record.handoffId, handoffPath: w.handoffPath, writtenDigest: w.writtenDigest, document: record };
    emit('handoff-verified', state.pendingHandoff);
    return { status: STEP.OK, handoff: state.pendingHandoff, state: m.state() };
  }

  // ---------------------------------------------------------------------------------------------
  // the compaction
  // ---------------------------------------------------------------------------------------------

  /**
   * requestCompact — dispatch the documented `/compact` slash command into the SAME conversation.
   *
   * The transition is applied FIRST and the process is spawned only if the machine allowed it. That
   * ordering is the enforcement of "no compaction without a verified handoff": from any state other
   * than HANDOFF_VERIFIED the apply is REFUSED and no compaction is ever requested.
   */
  async function requestCompact({ requestId = null } = {}) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };

    const rid = requestId || `cr_${crypto.randomBytes(6).toString('hex')}`;
    const args = cliLib.buildTurnArgs({ sessionId: state.sessionId, model, tools, allowedTools, permissionMode, extraArgs });
    const requested = evidence.make(evidence.KINDS.COMPACT_REQUESTED, {
      mechanism: 'sdk-slash-command',
      mechanismDetail: `claude --print --output-format stream-json --verbose --resume ${state.sessionId} <<< "${COMPACT_PROMPT}"`,
      command: COMPACT_PROMPT,
      requestId: rid,
      sessionId: state.sessionId,
      // The verbatim REQUEST. The host's own acknowledgement — {"subtype":"status","status":"compacting"} —
      // arrives on the stream that follows and is carried on the completion record, where it belongs.
      raw: { argv: args, prompt: COMPACT_PROMPT, sessionId: state.sessionId, at: now() },
      observedAt: now(),
    });

    const applied = m.apply({ transition: 'request-compact', eventId: `compact-req:${rid}`, evidence: [requested] });
    if (applied.status !== 'APPLIED') {
      return { ...stepFrom(applied, 'request-compact'), spawned: false, requestId: rid };
    }

    const t0 = Date.now();
    const ran = await turn({ prompt: COMPACT_PROMPT, label: 'compact', resume: true });
    return { status: STEP.OK, spawned: true, requestId: rid, waitedMs: Date.now() - t0, ...ran };
  }

  /**
   * observeCompact — the three-way verdict, and the ONLY place a compaction is called complete.
   *
   * Returns the machine's answer, not a summary of it: COMPLETED walks observe-completion +
   * verify-identity (which advances the cycle), NOOP walks noop-return (which does not), and every
   * other verdict halts with the failure code whose recovery instruction fits it.
   */
  function observeCompact({ observation = state.lastObservation, waitedMs = null, expectedSessionId = state.sessionId } = {}) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    if (!observation) return { status: STEP.CANNOT_DETERMINE, why: 'no compaction turn has been observed' };

    const verdict = stream.compactVerdict(observation, { waitedMs });
    emit('compact-verdict', verdict);

    if (verdict.verdict === stream.VERDICT.COMPLETED) {
      const boundaryUuid = observation.boundary.msg.uuid || io.digest(observation.boundary.raw);
      const completed = evidence.make(evidence.KINDS.COMPACT_COMPLETED, {
        signal: 'compact_boundary',
        trigger: verdict.metadata.trigger,
        preTokens: verdict.metadata.preTokens,
        postTokens: verdict.metadata.postTokens,
        durationMs: verdict.metadata.durationMs,
        sessionId: verdict.sessionId,
        boundaryUuid,
        raw: verdict.raw,
        observedAt: now(),
      });
      const applied = m.apply({ transition: 'observe-completion', eventId: `boundary:${boundaryUuid}`, evidence: [completed] });
      if (applied.status === 'NOOP') {
        // A REDELIVERED boundary. The machine recognised it and returned the original result; nothing
        // advances twice. This is the duplicate-event contract, and it is why the host's own uuid is
        // the event id rather than a counter of ours.
        return { status: STEP.NOOP, noopKind: 'duplicate-event', verdict, duplicateOf: applied.duplicateOf, original: applied.original, machineResult: applied };
      }
      if (applied.status !== 'APPLIED') return { ...stepFrom(applied, 'observe-completion'), verdict };

      const identity = verifyIdentity({ expectedId: expectedSessionId, observation, boundaryUuid });
      return {
        status: identity.status,
        verdict, completed, identity,
        // The identity verdict IS the rollover's verdict from here, so its failure travels with it —
        // a caller that had to reach into `identity.failure` would eventually forget to.
        ...(identity.failure ? { failure: identity.failure } : {}),
        cycleAdvanced: identity.cycleAdvanced === true,
      };
    }

    if (verdict.verdict === stream.VERDICT.NOOP) {
      const resultUuid = (observation.result && observation.result.msg.uuid) || io.digest(String(verdict.raw));
      const noop = evidence.make(evidence.KINDS.COMPACT_NOOP, {
        hostResult: verdict.hostResult,
        sessionId: verdict.sessionId,
        raw: verdict.raw,
        observedAt: now(),
      });
      const identityRecord = identityEvidence({ expectedId: expectedSessionId, observation, tag: `noop:${resultUuid}` });
      if (!identityRecord.ok) return { ...identityRecord, verdict };
      const applied = m.apply({ transition: 'noop-return', eventId: `noop:${resultUuid}`, evidence: [noop, identityRecord.record] });
      if (applied.status === 'NOOP') return { status: STEP.NOOP, noopKind: 'duplicate-event', verdict, duplicateOf: applied.duplicateOf, machineResult: applied };
      if (applied.status !== 'APPLIED') return { ...stepFrom(applied, 'noop-return'), verdict };
      // The handoff stays UNCONSUMED and the cycle did not advance, so every latch survives and the
      // next attempt must re-verify. Nothing about a declined compaction is a rollover.
      return { status: STEP.NOOP, noopKind: 'compaction-declined', verdict, noop, machineResult: applied, cycleAdvanced: false, handoffStillPending: Boolean(state.pendingHandoff) };
    }

    // --- everything below is a failure or a non-observation ---------------------------------------
    const turnFile = state.turns.length ? state.turns[state.turns.length - 1].file : null;

    if (verdict.verdict === stream.VERDICT.FAILED) {
      const detail = `the host reported compact_result:"failed"${verdict.compactError ? `: ${verdict.compactError}` : ''}`
        + ` — while its result envelope said ${JSON.stringify(verdict.resultEnvelope)}. Verbatim stream: ${turnFile || 'not persisted'}`;
      const halted = m.apply({ transition: 'halt', eventId: `compact-failed:${io.digest(String(verdict.raw))}`, failureCode: 'COMPACT_REQUEST_REFUSED', detail });
      return { status: STEP.HALTED, verdict, failure: halted.failure, compactError: verdict.compactError || null, machineResult: halted, turnFile };
    }

    // CONTRADICTORY and UNOBSERVED are both CANNOT_DETERMINE: one has two signals that disagree, the
    // other has none. Neither is evidence that compaction did or did not happen.
    const unobserved = evidence.make(evidence.KINDS.COMPACT_UNOBSERVED, {
      reason: verdict.verdict === stream.VERDICT.CONTRADICTORY ? 'contradictory-signals' : (verdict.reason || 'no-signal'),
      waitedMs: Number.isFinite(waitedMs) ? waitedMs : -1,
      detail: verdict.detail,
      raw: verdict.raw || JSON.stringify(verdict),
      observedAt: now(),
    });
    const detail = `${verdict.detail} Verbatim stream: ${turnFile || 'not persisted'}`;
    const halted = m.apply({ transition: 'halt', eventId: `compact-unobserved:${io.digest(String(verdict.raw || ''))}`, failureCode: 'COMPLETION_UNOBSERVED', detail });
    return { status: STEP.HALTED, verdict, unobserved, failure: halted.failure, machineResult: halted, turnFile };
  }

  /** Build the identity record WITHOUT applying it — used by both the boundary and the no-op paths. */
  function identityEvidence({ expectedId, observation, tag }) {
    const observedId = stream.sessionIdOf(observation);
    const record = evidence.make(evidence.KINDS.IDENTITY_VERIFICATION, {
      expectedId: String(expectedId || ''),
      observedId: observedId || null,
      equal: observedId === null ? null : observedId === expectedId,
      field: CONVERSATION_ID_FIELD,
      tag,
      raw: observation.boundary ? observation.boundary.raw : (observation.result ? observation.result.raw : JSON.stringify({ session_ids: observation.sessionIds })),
      observedAt: now(),
    });
    if (!expectedId) {
      return { ok: false, status: STEP.CANNOT_DETERMINE, why: 'there is no expected session id to compare against — the supervisor never observed one', record };
    }
    return { ok: true, record, observedId };
  }

  /**
   * verifyIdentity — EMPIRICALLY, per rollover. Same-id-across-compaction is strongly evidenced in the
   * documentation and stated verbatim in none of it, so this compares two observations every time
   * rather than trusting that the last hundred rollovers agreed.
   */
  function verifyIdentity({ expectedId = state.sessionId, observation = state.lastObservation, boundaryUuid = null } = {}) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    const built = identityEvidence({ expectedId, observation, tag: boundaryUuid || 'identity' });
    if (!built.ok) return built;

    const eventId = `identity:${boundaryUuid || io.digest(built.record.raw)}`;
    const applied = m.apply({ transition: 'verify-identity', eventId, evidence: [built.record] });
    if (applied.status === 'NOOP') return { status: STEP.NOOP, duplicateOf: applied.duplicateOf, machineResult: applied, observedId: built.observedId };
    if (applied.status !== 'APPLIED') return { ...stepFrom(applied, 'verify-identity'), observedId: built.observedId, record: built.record };

    emit('identity-verified', { expectedId, observedId: built.observedId, cycleId: m.cycleId() });
    return {
      status: STEP.OK,
      observedId: built.observedId,
      cycleAdvanced: applied.cycleAdvanced === true,
      cycleId: m.cycleId(),
      cycleIndex: m.cycleIndex(),
      record: built.record,
      machineResult: applied,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // injection and the exactly-once continue
  // ---------------------------------------------------------------------------------------------

  /**
   * injectHandoff — claim the verified handoff EXACTLY ONCE and render it for the next prompt.
   *
   * ⛔ CLAIM FIRST, THEN SEND. The receipt is created before the continuation prompt goes out, which
   * means a crash in that window LOSES a delivery rather than DUPLICATING one. That is the deliberate
   * direction: the receipt names the handoff and its exactNextAction, so a lost delivery is recoverable
   * by reading it, while a duplicated atomic action is not recoverable at all.
   */
  function injectHandoff({ handoffId = state.pendingHandoff && state.pendingHandoff.handoffId, nextPrompt = '' } = {}) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    if (!handoffId) return { status: STEP.CANNOT_DETERMINE, why: 'there is no verified handoff to inject' };

    const r = handoff.consume(state.dir, handoffId, { consumerId: myConsumerId });
    m.journalConsumption({ handoffId, status: r.status, consumerId: myConsumerId, receiptPath: r.receiptPath || null, cycleId: m.cycleId() });

    if (r.status === 'ALREADY_CONSUMED') {
      emit('handoff-already-consumed', r);
      return {
        status: STEP.NOOP, consumed: false, alreadyConsumed: true,
        firstConsumption: r.firstConsumption, receiptPath: r.receiptPath,
        why: `handoff ${handoffId} was already consumed by ${r.firstConsumption && r.firstConsumption.consumerId} at ${r.firstConsumption && r.firstConsumption.consumedAt}; it is not delivered a second time`,
      };
    }
    if (r.status !== 'CONSUMED') {
      return { status: r.status === 'REFUSED' ? STEP.REFUSED : STEP.CANNOT_DETERMINE, failure: r.failure, why: r.failure && r.failure.detail };
    }

    state.pendingHandoff = null;
    const prompt = `${render(r.handoff)}\n\n${nextPrompt}`.trim();
    emit('handoff-consumed', { handoffId, receiptPath: r.receiptPath });
    return { status: STEP.OK, consumed: true, handoff: r.handoff, receipt: r.receipt, receiptPath: r.receiptPath, prompt };
  }

  /**
   * The continuation, sent EXACTLY ONCE per context cycle.
   *
   * The cycle id is the key, and it is the right one: a compacted conversation keeps its session id, so
   * a receipt keyed on the session would block the second rollover's continuation as a duplicate of the
   * first. A no-op compaction advances no cycle — and correspondingly has no continuation to send.
   */
  async function continueOnce({ prompt, label = 'continue' }) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    const cycleId = m.cycleId();
    const receiptPath = machine.receiptPathFor(state.dir, `continue-${cycleId}`);
    const claim = consumable.consume(receiptPath, {
      subjectId: `continue:${cycleId}`,
      consumerId: myConsumerId,
      note: 'the post-rollover continuation prompt for this context cycle',
      extra: { cycleId, promptDigest: io.digest(String(prompt || '')) },
    });
    if (claim.status === 'ALREADY_CONSUMED') {
      return {
        status: STEP.NOOP, sent: false, receiptPath,
        firstConsumption: claim.firstConsumption,
        why: `the continuation for cycle ${cycleId} was already sent by ${claim.firstConsumption && claim.firstConsumption.consumerId}; this supervisor will not send it twice`,
      };
    }
    if (claim.status !== 'CONSUMED') return { status: STEP.CANNOT_DETERMINE, failure: claim.failure, why: claim.failure && claim.failure.detail };

    const ran = await turn({ prompt, label });
    return { status: STEP.OK, sent: true, receiptPath, ...ran };
  }

  /** The handoff as text. IDS ONLY for candidate memories — an unverified lead must not read as a fact. */
  function render(doc) {
    const lines = [];
    lines.push(`<respawnpack-handoff schema="${doc.schemaVersion}" handoff="${doc.handoffId}" cycle="${doc.contextCycleId}">`);
    lines.push('This conversation was compacted in place by RespawnPack. What follows was written and');
    lines.push('read back BEFORE the compaction, and is delivered exactly once.');
    lines.push('');
    lines.push(`EXACT NEXT ACTION: ${doc.exactNextAction || '(none was recorded — re-derive it from the facts below before acting)'}`);
    if (doc.atomicActionId) lines.push(`ATOMIC ACTION: ${doc.atomicActionId}`);
    lines.push(`GIT HEAD: ${doc.git.head || 'unknown'}`);
    if (doc.git.uncommittedFiles.length) {
      lines.push(`UNCOMMITTED (${doc.git.uncommittedFiles.length}${doc.git.uncommittedTruncated ? '+, truncated' : ''}): ${doc.git.uncommittedFiles.join(', ')}`);
    }
    if (doc.userConstraints.length) { lines.push('USER CONSTRAINTS:'); doc.userConstraints.forEach((c) => lines.push(`  · ${c}`)); }
    if (doc.verificationEvidence.length) { lines.push('VERIFIED THIS CYCLE:'); doc.verificationEvidence.forEach((e) => lines.push(`  · ${typeof e === 'string' ? e : JSON.stringify(e)}`)); }
    if (doc.unresolvedQuestions.length) { lines.push('UNRESOLVED:'); doc.unresolvedQuestions.forEach((q) => lines.push(`  · ${q}`)); }
    if (doc.candidateMemories.length) lines.push(`CANDIDATE MEMORIES (ids only — unverified leads, not facts): ${doc.candidateMemories.join(', ')}`);
    lines.push('</respawnpack-handoff>');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------------------------
  // the rollover
  // ---------------------------------------------------------------------------------------------

  /**
   * One complete rollover: checkpoint → closeout → staged+verified handoff → /compact → observed
   * completion → verified identity → consumed handoff → exactly-one continuation.
   *
   * Every branch returns the OBSERVATION that caused it. Nothing here decides that a rollover happened;
   * the machine's cycle advance does, and this only reports it.
   */
  async function rollover({ handoffFields = {}, nextPrompt = '', force = false } = {}) {
    const started = now();
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    if (m.halted()) return { status: STEP.HALTED, failure: m.halted(), why: 'this rollover halted; nothing resumes past a halt' };

    const ts = thresholdState();
    if (!force && !ts.evaluation.fire.includes('final')) {
      return {
        status: STEP.CANNOT_DETERMINE, rolled: false,
        why: ts.measurement.measurable
          ? `occupancy is ${ts.measurement.usedPercent.toFixed(1)}% and the final threshold (${ts.thresholds.final}%) has not fired in this cycle — pass force:true to roll over anyway`
          : `context is unmeasured (${ts.measurement.why}), and an unmeasured context is CANNOT_DETERMINE, never 0%`,
        thresholdState: ts,
      };
    }

    const boundary = settleOrStop();
    if (boundary.status !== STEP.OK) return { status: boundary.status, rolled: false, why: boundary.why, thresholdState: ts };

    const measurement = ts.measurement.record || measureContext().record;
    if (!measurement) {
      return {
        status: STEP.CANNOT_DETERMINE, rolled: false,
        why: 'there is no context measurement to checkpoint on. A forced rollover still needs a measurement record, because the machine gates the checkpoint on one.',
      };
    }

    const staged = stageHandoff({ measurementRecord: measurement, boundaryRecord: boundary.record, fields: handoffFields });
    if (staged.status !== STEP.OK) return { ...staged, rolled: false, phase: 'stage-handoff' };

    // ⭐ LATCH WHAT FIRED, KEYED ON THE CYCLE. A no-op compaction advances no cycle, so these survive
    // and the checkpoint does not immediately re-fire against a context that never got smaller. A real
    // rollover advances the cycle, and core's forCycle re-arms every threshold as a consequence of the
    // keying rather than as a special case anyone has to remember.
    latchFired(ts);

    const cycleBefore = { id: m.cycleId(), index: m.cycleIndex() };
    const expectedSessionId = state.sessionId;

    const requested = await requestCompact();
    if (requested.status !== STEP.OK) return { ...requested, rolled: false, phase: 'request-compact', cycleBefore };

    const observed = observeCompact({ observation: requested.observation, waitedMs: requested.waitedMs, expectedSessionId });
    if (observed.status === STEP.HALTED) return { ...observed, rolled: false, phase: 'observe-compact', cycleBefore };
    if (observed.status === STEP.NOOP) {
      // A declined compaction. No cycle, no consumption, no continuation — and the latches survive, so
      // the checkpoint does not immediately re-fire against a context that never got smaller.
      return { ...observed, rolled: false, phase: 'observe-compact', cycleBefore, cycleAfter: { id: m.cycleId(), index: m.cycleIndex() }, startedAt: started, endedAt: now() };
    }
    if (observed.status !== STEP.OK) return { ...observed, rolled: false, phase: 'observe-compact', cycleBefore };

    const injected = injectHandoff({ handoffId: staged.handoff.handoffId, nextPrompt });
    if (injected.status !== STEP.OK) return { ...injected, rolled: true, phase: 'inject-handoff', cycleBefore, cycleAfter: { id: m.cycleId(), index: m.cycleIndex() } };

    const continued = await continueOnce({ prompt: injected.prompt });
    const result = {
      status: continued.status === STEP.OK ? STEP.OK : continued.status,
      rolled: true,
      phase: 'complete',
      startedAt: started,
      endedAt: now(),
      cycleBefore,
      cycleAfter: { id: m.cycleId(), index: m.cycleIndex() },
      identity: observed.identity,
      compaction: observed.verdict,
      handoffId: staged.handoff.handoffId,
      receiptPath: injected.receiptPath,
      continuation: continued,
      injectedPrompt: injected.prompt,
    };
    state.rollovers.push(result);
    emit('rollover', result);
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------

  /**
   * A host occurrence's id: the host's own uuid when it gave one, otherwise the digest of its bytes.
   *
   * ⛔ NEVER A COUNTER OF OURS. The machine suppresses duplicates on this id ACROSS cycles, so an id
   * that repeats would make the second rollover's checkpoint a no-op — and an id minted per call would
   * make a redelivered event apply twice. Both failures are silent, and the host's uuid avoids both.
   */
  function eventIdFor(prefix, record) {
    if (record && typeof record.turnUuid === 'string' && record.turnUuid) return `${prefix}:${record.turnUuid}`;
    const hostUuid = record && record.raw && typeof record.raw === 'object' && record.raw.uuid;
    if (typeof hostUuid === 'string' && hostUuid) return `${prefix}:${hostUuid}`;
    const text = record && record.raw !== undefined ? (typeof record.raw === 'string' ? record.raw : JSON.stringify(record.raw)) : String(Math.random());
    return `${prefix}:${io.digest(text).slice(0, 32)}`;
  }

  function stepFrom(applied, transition) {
    if (applied.status === 'HALTED') return { status: STEP.HALTED, transition, failure: applied.failure, machineResult: applied, why: applied.failure && applied.failure.detail };
    if (applied.status === 'REFUSED') return { status: STEP.REFUSED, transition, failure: applied.failure, machineResult: applied, why: applied.failure && applied.failure.detail };
    return { status: STEP.CANNOT_DETERMINE, transition, machineResult: applied, why: `the machine answered ${applied.status} for ${transition}` };
  }

  return {
    // capabilities
    probe, measureContext, settleOrStop, requestCompact, observeCompact, verifyIdentity, injectHandoff,
    // orchestration
    attach, turn, stageHandoff, continueOnce, rollover, thresholdState, latches, latchFired, render,
    // introspection — read-only views for reports and tests
    sessionId: () => state.sessionId,
    dir: () => state.dir,
    machine: () => state.machine,
    turns: () => state.turns.slice(),
    rollovers: () => state.rollovers.slice(),
    pendingHandoff: () => (state.pendingHandoff ? { ...state.pendingHandoff } : null),
    lastObservation: () => state.lastObservation,
    probeResult: () => state.probeResult,
    consumerId: () => myConsumerId,
    options: () => ({ projectDir, cwd: cwd || projectDir, model, tools, allowedTools, permissionMode, timeoutMs, thresholdConfig, contextBudgetTokens }),
  };
}

module.exports = { createSupervisor, STEP, HOST, COMPACT_PROMPT, CONVERSATION_ID_FIELD };
