#!/usr/bin/env node
/*
 * RespawnPack · adapters/codex/app-server/canary.js — the live activation canary: THREE CONSECUTIVE
 * IN-PLACE ROLLOVERS against a real `codex app-server`, or a typed reason why not.
 *
 * ⛔ THIS SCRIPT NEVER FABRICATES A RESULT. Every claim it prints is derived from an event it OBSERVED
 * in the host's own stream, and a claim it could not observe is CANNOT_DETERMINE — never a pass, never
 * a warning, never quietly omitted. In particular:
 *
 *   · an unresolvable or unauthenticated Codex ⇒ CANNOT_DETERMINE with the host's verbatim words;
 *   · a compaction whose contextCompaction item never arrived ⇒ CANNOT_DETERMINE, flagged as a no-op
 *     candidate and resolved as neither;
 *   · a handoff whose delivery the model did not echo back ⇒ CANNOT_DETERMINE for the INJECTION claim
 *     only. "The model did not repeat the nonce" and "the handoff was not delivered" are different facts.
 *   · a mid-way failure STOPS. There is no retry loop past a HALT — the typed failure and the raw log
 *     ARE the deliverable, and a canary that kept trying until something passed would prove nothing.
 *
 * ⭐ WHY THE DEFAULT RUN USES A SMALL CONFIGURED WINDOW. Filling a real 258400-token context three
 * times costs hours and real money, and it is not what this canary is for: the thing under test is the
 * PROTOCOL — request, item, identity, exactly-once, continuation, re-armed latches. So the thresholds
 * are measured against an operator-configured denominator by default, every report says so in its own
 * text, and the measurement records carry `windowHostReported:false`. The compaction, the identity
 * comparison and the receipt are real either way. Pass `--context-window 0` to measure against the
 * host's published modelContextWindow instead.
 *
 * ⛔ AND IT RUNS READ-ONLY, IN A TEMPORARY DIRECTORY, WITH approvalPolicy "never". A canary that could
 * write to the repository it is proving would be an unattended agent with commit rights.
 *
 * Usage:
 *   node adapters/codex/app-server/canary.js [options]
 *
 *   --rollovers <n>        consecutive rollovers to prove (default 3)
 *   --context-window <n>   token denominator the thresholds are measured against (default 18000; 0 = host-published)
 *   --pad-budget <n>       padding turns allowed per cycle (default 3)
 *   --pad-lines <n>        lines of deterministic padding per padding turn (default 200)
 *   --project-dir <path>   where rollover state is written (default: a fresh temp directory)
 *   --cwd <path>           working directory for the codex thread (default: a fresh temp directory)
 *   --codex-js <path>      the Codex entry script (default: RESPAWNPACK_CODEX_JS, then PATH)
 *   --model <name>         model for the thread
 *   --json <file>          write the structured report
 *   --events <file>        write the full JSONL event log
 *   --probe-only           run the probe and stop
 *
 * Exit: 0 PASS · 1 FAIL · 2 CANNOT_DETERMINE — core's own mapping, where CANNOT_DETERMINE has its own
 * code because a CI job that treats "could not tell" as "fine" will eventually ship one.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));
const { createSupervisor, STEP } = require('./supervisor.js');
const caps = require('./capabilities.js');

const { OUTCOME, rollup, exitCodeFor } = core.failures;

// --- arguments ------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    rollovers: 3, contextWindow: 18000, padBudget: 3, padLines: 200,
    projectDir: null, cwd: null, codexJs: null, model: null, json: null, events: null, probeOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--rollovers') out.rollovers = Number(next());
    else if (a === '--context-window') out.contextWindow = Number(next());
    else if (a === '--pad-budget') out.padBudget = Number(next());
    else if (a === '--pad-lines') out.padLines = Number(next());
    else if (a === '--project-dir') out.projectDir = next();
    else if (a === '--cwd') out.cwd = next();
    else if (a === '--codex-js') out.codexJs = next();
    else if (a === '--model') out.model = next();
    else if (a === '--json') out.json = next();
    else if (a === '--events') out.events = next();
    else if (a === '--probe-only') out.probeOnly = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${JSON.stringify(a)}`);
  }
  return out;
}

/** One checkable statement, its verdict, and the OBSERVATION it rests on. */
const claim = (name, outcome, detail, evidence = null) => ({ name, outcome, detail, evidence });

const log = (s) => process.stdout.write(`${s}\n`);

/*
 * Deterministic padding that occupies INPUT rather than provoking output. Filling the window from the
 * model's side would cost a delta notification per token and make the evidence log unreadable; filling
 * it from the prompt side costs one line. The text states plainly that it carries no instructions, so a
 * reader of the transcript is never left wondering whether the canary steered the model.
 */
const padBlock = (lines) => Array.from({ length: lines }, (_, i) =>
  `Line ${i + 1}: deterministic padding for the RespawnPack Codex app-server rollover canary; this line carries no instructions, no facts and no request, and exists only to occupy context window space.`).join('\n');

// --- the run --------------------------------------------------------------------------------------

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 52).join('\n')); return 0; }

  const startedAt = new Date().toISOString();
  const projectDir = opts.projectDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rp-codex-canary-'));
  const workCwd = opts.cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'rp-codex-work-'));
  const rawLogPath = path.join(projectDir, 'app-server-raw.jsonl');
  const PAD = padBlock(opts.padLines);

  const report = {
    kind: 'respawnpack-activation-canary',
    profile: caps.PROFILE,
    startedAt, endedAt: null,
    environment: { node: process.version, platform: process.platform, projectDir, cwd: workCwd, codexVersion: null, codexJs: null },
    options: { rollovers: opts.rollovers, contextWindow: opts.contextWindow, padBudget: opts.padBudget, padLines: opts.padLines, model: opts.model },
    budgetNote: opts.contextWindow > 0
      ? `Thresholds were measured against an OPERATOR-CONFIGURED denominator of ${opts.contextWindow} tokens, not the model's real context window. `
        + 'The compaction, the identity comparison, the exactly-once delivery and the cycle advance are real; "the final threshold fires at the real window" is NOT what this run measured. Use --context-window 0 for that.'
      : 'Thresholds were measured against the host-published modelContextWindow.',
    probe: null, threadId: null, observedPolicy: null,
    rollovers: [], claims: [], serverRequests: [],
    eventLog: null, rawLog: null,
    outcome: null, exitCode: null, firstProblem: null, ownerActions: [],
  };

  const sup = createSupervisor({
    projectDir, cwd: workCwd,
    codexJs: opts.codexJs, model: opts.model,
    sandbox: 'read-only', approvalPolicy: 'never',
    contextWindowTokens: opts.contextWindow > 0 ? opts.contextWindow : null,
    rawLogPath,
    consumerId: `codex-canary:${process.pid}:${crypto.randomBytes(3).toString('hex')}`,
  });

  try {
    // --- 1. probe ---------------------------------------------------------------------------------
    log('RespawnPack · codex/app-server activation canary');
    log(`  project dir: ${projectDir}`);
    log(`  thread cwd:  ${workCwd}`);
    log('  probing…');

    const probe = await sup.probe();
    report.probe = probe;
    report.environment.codexVersion = probe.version || null;
    report.environment.codexJs = probe.codexJs || null;

    if (probe.outcome !== OUTCOME.PASS) {
      report.claims.push(claim('the configured integration is active', probe.outcome, probe.why, { verbatim: probe.verbatim, resolution: probe.resolution }));
      if (probe.ownerAction) report.ownerActions.push(probe.ownerAction);
      return finish(report, opts, sup);
    }
    report.claims.push(claim('the configured integration is active', OUTCOME.PASS,
      `${probe.version} at ${probe.codexJs} (resolved via ${probe.resolution.via}); the mandatory initialize handshake completed and the host's own schema declares ${probe.schema ? probe.schema.methods : 0} request methods including thread/compact/start`,
      { initialize: probe.initialize, schema: probe.schema }));
    log(`  ${probe.version} · ${probe.codexJs}`);

    if (opts.probeOnly) return finish(report, opts, sup);

    // --- 2. open the thread -----------------------------------------------------------------------
    log('  starting a thread…');
    const thread = await sup.startThread();
    if (thread.status !== STEP.OK) {
      report.claims.push(claim('a supervised thread was started', OUTCOME.CANNOT_DETERMINE, thread.why, { raw: thread.raw || null }));
      report.ownerActions.push('Run `codex app-server` by hand from the same cwd, send initialize then thread/start, and read what it answers.');
      return finish(report, opts, sup);
    }
    report.threadId = thread.threadId;
    report.observedPolicy = thread.observedPolicy;
    report.claims.push(claim('a supervised thread was started', OUTCOME.PASS, `thread ${thread.threadId}`, { observedPolicy: thread.observedPolicy, sessionId: thread.sessionId }));

    // The unattended safety posture, read back off the host rather than assumed from what we asked for.
    const policyOk = thread.observedPolicy.approvalPolicy === 'never'
      && thread.observedPolicy.sandbox && thread.observedPolicy.sandbox.type === 'readOnly';
    report.claims.push(policyOk
      ? claim('the thread runs read-only with approvals disabled', OUTCOME.PASS,
        `the host reports approvalPolicy "${thread.observedPolicy.approvalPolicy}" and sandbox ${JSON.stringify(thread.observedPolicy.sandbox)}`, { observedPolicy: thread.observedPolicy })
      : claim('the thread runs read-only with approvals disabled', OUTCOME.FAIL,
        `the host reports ${JSON.stringify(thread.observedPolicy)}, which is not the unattended posture this canary asked for`, { observedPolicy: thread.observedPolicy }));
    log(`  thread ${thread.threadId} · approvalPolicy=${thread.observedPolicy.approvalPolicy} · sandbox=${thread.observedPolicy.sandbox && thread.observedPolicy.sandbox.type}`);

    log('  opening turn…');
    const first = await sup.turn({ prompt: 'Reply with exactly: RESPAWNPACK-CODEX-CANARY-READY', label: 'open' });
    if (first.status !== STEP.OK || first.turnStatus !== 'completed') {
      report.claims.push(claim('the host completed a real model turn (authentication)', OUTCOME.CANNOT_DETERMINE,
        first.status !== STEP.OK ? first.why : `the opening turn ended with status ${JSON.stringify(first.turnStatus)}`,
        { raw: first.raw || null, turn: first.turn || null }));
      report.ownerActions.push('Run `codex` interactively once in this environment and complete the login, then re-run this canary. RespawnPack never handles credentials.');
      return finish(report, opts, sup);
    }
    report.claims.push(claim('the host completed a real model turn (authentication)', OUTCOME.PASS,
      `turn ${first.turnId} completed; authentication is proven by a completed turn, not by the handshake`, { raw: first.raw }));

    // --- 3. N consecutive rollovers ---------------------------------------------------------------
    for (let i = 0; i < opts.rollovers; i += 1) {
      const entry = { index: i, claims: [], padTurns: 0, thresholdFired: false, cycleBefore: null, cycleAfter: null, latchesBefore: null, latchesAfter: null };
      report.rollovers.push(entry);

      // The latch record for the cycle we are about to roll over out of.
      const lb = sup.latches();
      entry.latchesBefore = { cycleId: lb.record.cycleId, latched: Object.keys(lb.record.latched), rearmed: lb.rearmed };

      log(`  rollover ${i + 1}/${opts.rollovers}: padding…`);
      let ts = sup.thresholdState();
      while (!ts.evaluation.fire.includes('final') && entry.padTurns < opts.padBudget) {
        const pad = await sup.turn({ prompt: `PAD-${i}-${entry.padTurns}\n${PAD}\n\nReply with exactly: PAD-OK`, label: `pad-${i}-${entry.padTurns}` });
        entry.padTurns += 1;
        if (pad.status !== STEP.OK) { entry.padFailure = pad.why; break; }
        ts = sup.thresholdState();
      }
      entry.thresholdFired = ts.evaluation.fire.includes('final');
      entry.occupancy = ts.measurement.measurable ? Number(ts.measurement.usedPercent.toFixed(2)) : null;
      entry.budgetSource = ts.measurement.budget ? ts.measurement.budget.source : null;
      entry.usedTokens = ts.measurement.measurable ? ts.measurement.usedTokens : null;

      entry.claims.push(entry.thresholdFired
        ? claim('the final threshold fired on a measured context', OUTCOME.PASS,
          `${entry.occupancy}% (${entry.usedTokens} input tokens over a ${entry.budgetSource} denominator) after ${entry.padTurns} padding turn(s)`,
          { evaluation: ts.evaluation, budget: ts.measurement.budget })
        : claim('the final threshold fired on a measured context', OUTCOME.CANNOT_DETERMINE,
          `the padding budget (${opts.padBudget}) ran out at ${entry.occupancy === null ? 'an unmeasured context' : `${entry.occupancy}%`}; the rollover below was FORCED, so nothing here says a threshold would have fired on its own`,
          { evaluation: ts.evaluation, why: ts.measurement.why || null }));

      const nonce = `RP-CODEX-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      entry.nonce = nonce;
      log(`  rollover ${i + 1}/${opts.rollovers}: compacting…`);

      const r = await sup.rollover({
        force: !entry.thresholdFired,
        handoffFields: {
          atomicActionId: `codex-canary-rollover-${i}`,
          exactNextAction: `Reply with exactly: ${nonce}`,
          userConstraints: ['this is an automated canary; take no action other than the exact next action'],
          verificationEvidence: [`padding turns in this cycle: ${entry.padTurns}`, `occupancy at rollover: ${entry.occupancy === null ? 'CANNOT_DETERMINE' : `${entry.occupancy}%`}`],
        },
        nextPrompt: 'Follow the exact next action above and nothing else.',
      });
      entry.result = { status: r.status, rolled: Boolean(r.rolled), phase: r.phase || null, why: r.why || null, failure: r.failure ? { code: r.failure.code, outcome: r.failure.outcome, detail: r.failure.detail } : null };
      entry.cycleBefore = r.cycleBefore || null;
      entry.cycleAfter = r.cycleAfter || null;
      entry.itemId = r.completed ? r.completed.itemId : null;
      entry.compactTurnId = r.compactTurnId || null;

      // ⛔ A HALT ENDS THE RUN. No retry, no second attempt, no "let's see if the next one works".
      if (r.status === STEP.HALTED) {
        entry.claims.push(claim('the compaction completed', r.failure.outcome, `${r.failure.code}: ${r.failure.detail}`, { verdict: r.verdict || null, turnFile: r.turnFile || null }));
        report.ownerActions.push(r.failure.recovery);
        entry.claims.push(claim('the conversation identity survived', OUTCOME.CANNOT_DETERMINE, 'the rollover stopped before the identity could be compared'));
        entry.claims.push(claim('exactly one context cycle was entered', OUTCOME.CANNOT_DETERMINE, 'no cycle advanced'));
        entry.claims.push(claim('the verified handoff was delivered exactly once', OUTCOME.CANNOT_DETERMINE, 'the handoff was not consumed; it is still on disk and unclaimed'));
        break;
      }
      if (r.status !== STEP.OK) {
        entry.claims.push(claim('the compaction completed', OUTCOME.CANNOT_DETERMINE, r.why || `the rollover answered ${r.status} in phase ${r.phase}`, { verdict: r.verdict || null }));
        break;
      }

      entry.claims.push(claim('the compaction completed', OUTCOME.PASS,
        `the host emitted a contextCompaction item/completed (item ${r.completed.itemId}, pair observed: ${r.completed.pairObserved}) on thread ${r.completed.threadId}; the immediate {} ack was not read as completion`,
        { raw: r.completed.raw }));

      entry.claims.push(r.identity.observedId === report.threadId
        ? claim('the conversation identity survived', OUTCOME.PASS,
          `expected and observed threadId are both ${r.identity.observedId}, and a thread/resume re-check with approvalPolicy re-passed answered ${r.identity.resume ? r.identity.resume.observedId : 'nothing'}`,
          { resume: r.identity.resume })
        : claim('the conversation identity survived', OUTCOME.FAIL, `expected ${report.threadId}, observed ${r.identity.observedId}`, { resume: r.identity.resume }));

      // The captured gotcha, re-proved live: approvalPolicy does not persist and must be re-passed.
      const resume = r.identity.resume;
      entry.claims.push(resume && resume.status === 'OK'
        ? (resume.policyRepassHeld
          ? claim('the re-passed approvalPolicy came back in force on resume', OUTCOME.PASS,
            `thread/resume reports approvalPolicy "${resume.observedPolicy.approvalPolicy}"`, { observedPolicy: resume.observedPolicy })
          : claim('the re-passed approvalPolicy came back in force on resume', OUTCOME.FAIL,
            `thread/resume re-passed "never" and the host reports "${resume.observedPolicy && resume.observedPolicy.approvalPolicy}"`, { observedPolicy: resume.observedPolicy }))
        : claim('the re-passed approvalPolicy came back in force on resume', OUTCOME.CANNOT_DETERMINE,
          `the resume re-check did not answer: ${resume ? resume.why : 'it was not run'}`));

      entry.claims.push(r.cycleAfter.index === r.cycleBefore.index + 1
        ? claim('exactly one context cycle was entered', OUTCOME.PASS, `cycle ${r.cycleBefore.index} → ${r.cycleAfter.index} (${r.cycleAfter.id})`)
        : claim('exactly one context cycle was entered', OUTCOME.FAIL, `cycle went ${r.cycleBefore.index} → ${r.cycleAfter.index}`));

      // Exactly-once, checked against the RECEIPT on disk rather than against our own memory of it.
      const receipt = core.io.readJSONClassified(r.receiptPath);
      const second = core.handoff.consume(sup.dir(), r.handoffId, { consumerId: 'canary-second-attempt' });
      entry.claims.push(receipt.status === 'OK' && second.status === 'ALREADY_CONSUMED'
        ? claim('the verified handoff was delivered exactly once', OUTCOME.PASS,
          `the receipt names ${receipt.doc.consumerId} at ${receipt.doc.consumedAt}, and a second claim was refused with a pointer to it`, { receipt: receipt.doc })
        : claim('the verified handoff was delivered exactly once', OUTCOME.FAIL,
          `receipt read ${receipt.status}; a second claim answered ${second.status}`, { receipt: receipt.doc || null }));

      // Injection, proved by an ECHO the model could only have produced from the handoff's own text.
      const echoed = continuationText(r.continuation);
      entry.claims.push(echoed.includes(nonce)
        ? claim('the handoff reached the next context cycle', OUTCOME.PASS, `the model echoed ${nonce}, which appeared nowhere but in the handoff`, { echo: echoed.slice(0, 240) })
        : claim('the handoff reached the next context cycle', OUTCOME.CANNOT_DETERMINE,
          `the continuation prompt carried the handoff and the model did not echo ${nonce}. "It did not repeat the nonce" is not "it did not receive it" — this claim is undetermined, not failed.`,
          { echo: echoed.slice(0, 240) }));

      // The re-arm, read off disk in the NEW cycle.
      const la = sup.latches();
      entry.latchesAfter = { cycleId: la.record.cycleId, latched: Object.keys(la.record.latched), rearmed: la.rearmed };
      entry.claims.push(la.rearmed && Object.keys(la.record.latched).length === 0
        ? claim('every threshold latch re-armed for the new cycle', OUTCOME.PASS,
          `the latch record moved from ${entry.latchesBefore.cycleId} to ${la.record.cycleId} and holds no latches`, { before: entry.latchesBefore, after: entry.latchesAfter })
        : claim('every threshold latch re-armed for the new cycle', OUTCOME.FAIL,
          `latches after the rollover: ${JSON.stringify(entry.latchesAfter)}`, { before: entry.latchesBefore, after: entry.latchesAfter }));

      log(`  rollover ${i + 1}/${opts.rollovers}: cycle ${r.cycleBefore.index} → ${r.cycleAfter.index}, identity ${r.identity.observedId === report.threadId ? 'held' : 'CHANGED'}, item ${r.completed.itemId}`);
    }

    // A run that stopped early has not proven consecutiveness, and says so rather than averaging.
    const completed = report.rollovers.filter((e) => e.result && e.result.status === STEP.OK).length;
    report.claims.push(completed === opts.rollovers
      ? claim(`${opts.rollovers} CONSECUTIVE in-place rollovers`, OUTCOME.PASS, `${completed} of ${opts.rollovers} completed on one thread (${report.threadId})`)
      : claim(`${opts.rollovers} CONSECUTIVE in-place rollovers`, OUTCOME.CANNOT_DETERMINE, `${completed} of ${opts.rollovers} completed; the run stopped early`));

    const indices = [0, ...report.rollovers.filter((e) => e.cycleAfter).map((e) => e.cycleAfter.index)];
    const monotone = indices.every((v, k) => v === k);
    report.claims.push(monotone && indices.length === opts.rollovers + 1
      ? claim('the context cycle advanced exactly once per rollover', OUTCOME.PASS, `cycle indices ${indices.join(' → ')}`)
      : claim('the context cycle advanced exactly once per rollover', completed === opts.rollovers ? OUTCOME.FAIL : OUTCOME.CANNOT_DETERMINE, `cycle indices ${indices.join(' → ')}`));

    return finish(report, opts, sup);
  } finally {
    sup.close();
  }
}

/** Whatever the model said on the continuation turn, from the completed turn's own items. */
function continuationText(continuation) {
  if (!continuation || !continuation.turn || !Array.isArray(continuation.turn.items)) return '';
  return continuation.turn.items
    .filter((it) => it && it.type === 'agentMessage' && typeof it.text === 'string')
    .map((it) => it.text).join('\n');
}

function finish(report, opts, sup) {
  const outcomes = report.claims.map((c) => c.outcome).concat(report.rollovers.flatMap((e) => e.claims.map((c) => c.outcome)));
  report.outcome = rollup(outcomes);
  report.exitCode = exitCodeFor(report.outcome);
  report.endedAt = new Date().toISOString();
  report.firstProblem = firstProblem(report);

  const conn = sup.connection();
  if (conn) {
    report.serverRequests = conn.serverRequests();
    report.transport = {
      notifications: conn.notificationCount(), events: conn.eventCount(),
      unparsed: conn.unparsed(), tornTail: conn.tornTail(), exit: conn.exit(),
      stderr: conn.stderr().slice(0, 4000),
      // Lines dropped because they arrived after the raw log had already ended (evidence lost, but
      // never silently — see rpc.js's record()). Non-zero here is itself a signal worth a human's eyes.
      rawLogDropped: conn.rawLogDropped(),
    };
    if (opts.events) {
      const lines = conn.events().map((e) => JSON.stringify(e)).join('\n');
      const w = core.io.writeAtomicText(opts.events, `${lines}\n`);
      report.eventLog = w.ok ? { file: opts.events, bytes: w.bytes, sha256: w.digest, events: conn.eventCount() } : { file: opts.events, error: w.detail };
    }
    if (conn.rawLogPath) {
      const raw = core.io.readTextClassified(conn.rawLogPath);
      report.rawLog = raw.status === 'OK'
        ? { file: conn.rawLogPath, bytes: Buffer.byteLength(raw.text), sha256: raw.digest }
        : { file: conn.rawLogPath, status: raw.status };
    }
  }

  // The capability matrix is generated from THIS run's canary — never from the target.
  const canary = caps.canaryFromReport(report);
  report.capabilityMatrix = caps.matrix(canary);
  report.machine = sup.machine()
    ? { state: sup.machine().state(), cycleIndex: sup.machine().cycleIndex(), counts: sup.machine().counts(), dir: sup.dir(), halted: sup.machine().halted() }
    : null;

  log('');
  log(`  OUTCOME: ${report.outcome}`);
  for (const c of report.claims) log(`    [${c.outcome}] ${c.name} — ${c.detail}`);
  for (const e of report.rollovers) {
    log(`    rollover ${e.index + 1}:`);
    for (const c of e.claims) log(`      [${c.outcome}] ${c.name} — ${c.detail}`);
  }
  if (report.serverRequests.length) {
    log('  SERVER→CLIENT REQUESTS (all default-denied):');
    for (const r of report.serverRequests) log(`    · ${r.method} → ${JSON.stringify(r.answered)}`);
  }
  log(`  NOTE: ${report.budgetNote}`);
  if (report.ownerActions.length) {
    log('  OWNER ACTION:');
    for (const a of [...new Set(report.ownerActions)]) log(`    · ${a}`);
  }
  log(`  capability matrix: rolloverCapable=${report.capabilityMatrix.rolloverCapable}, unmet=[${report.capabilityMatrix.unmet.join(', ')}]`);
  if (report.machine) log(`  rollover state: ${report.machine.dir} (state ${report.machine.state}, cycle ${report.machine.cycleIndex})`);
  if (report.eventLog) log(`  event log: ${report.eventLog.file} (${report.eventLog.events} events, ${report.eventLog.bytes} bytes, sha256 ${String(report.eventLog.sha256).slice(0, 16)}…)`);
  if (report.rawLog) log(`  raw log:   ${report.rawLog.file} (${report.rawLog.bytes} bytes, sha256 ${String(report.rawLog.sha256).slice(0, 16)}…)`);

  if (opts.json) {
    const w = core.io.writeAtomicJSON(opts.json, report);
    log(w.ok ? `  report: ${opts.json}` : `  report could NOT be written: ${w.detail}`);
  }
  return report.exitCode;
}

function firstProblem(report) {
  const all = report.claims.concat(report.rollovers.flatMap((e) => e.claims));
  const bad = all.find((c) => c.outcome !== OUTCOME.PASS);
  return bad ? `${bad.name}: ${bad.detail}` : null;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      // Even an unexpected throw is typed. An unhandled crash that exits 0 would be the worst outcome a
      // canary can have — a green run that observed nothing.
      log('  OUTCOME: CANNOT_DETERMINE');
      log(`    the canary itself failed: ${e && e.stack ? e.stack : e}`);
      process.exitCode = exitCodeFor(OUTCOME.CANNOT_DETERMINE);
    });
}

module.exports = { main, parseArgs, padBlock, continuationText };
