#!/usr/bin/env node
/*
 * RespawnPack · adapters/claude-code/sdk-supervisor/canary.js — the live activation canary: THREE
 * CONSECUTIVE IN-PLACE ROLLOVERS, or a typed reason why not.
 *
 * ⛔ THIS SCRIPT NEVER FABRICATES A RESULT. Every claim it prints is derived from an event it OBSERVED
 * in the host's own stream, and a claim it could not observe is CANNOT_DETERMINE — never a pass, never
 * a warning, and never quietly omitted. In particular:
 *
 *   · an unauthenticated host ⇒ CANNOT_DETERMINE with the host's verbatim words and one owner action;
 *   · a compaction whose boundary never arrived ⇒ CANNOT_DETERMINE, not "probably fine";
 *   · a handoff whose delivery the model did not echo back ⇒ CANNOT_DETERMINE for the INJECTION claim,
 *     while the rollover's other claims keep whatever they earned. "The model did not repeat the
 *     nonce" and "the handoff was not delivered" are different facts.
 *
 * ⭐ WHY THE DEFAULT RUN USES A SMALL CONFIGURED BUDGET. Filling a real 1M window three times costs
 * hours and real money, and it is not what this canary is for: the thing under test is the PROTOCOL —
 * request, boundary, identity, exactly-once, continuation. So the threshold is measured against an
 * operator-configured budget by default, and every report says so in the claim's own text. The
 * compaction, the identity comparison and the receipt are real either way. Pass `--context-budget 0`
 * to measure against the host's published window (or the 1000000 default) instead.
 *
 * Usage:
 *   node adapters/claude-code/sdk-supervisor/canary.js [options]
 *
 *   --rollovers <n>          consecutive rollovers to prove (default 3)
 *   --context-budget <n>     token budget the thresholds are measured against (default 24000; 0 = host/default)
 *   --turn-budget <n>        padding turns allowed per cycle (default 15)
 *   --project-dir <path>     where rollover state is written (default: a fresh temp directory)
 *   --cwd <path>             working directory for the claude process (default: the project dir)
 *   --model <name>           --model passed to claude
 *   --claude-path <path>     the executable (default: RESPAWNPACK_CLAUDE_PATH, then PATH)
 *   --json <file>            write the full report as JSON
 *   --probe-only             run the probe and stop
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
const stream = require('./stream.js');
const caps = require('./capabilities.js');

const { OUTCOME, rollup, exitCodeFor } = core.failures;

// --- arguments ------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    rollovers: 3, contextBudget: 24000, turnBudget: 15,
    projectDir: null, cwd: null, model: null, claudePath: null, json: null, probeOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--rollovers') out.rollovers = Number(next());
    else if (a === '--context-budget') out.contextBudget = Number(next());
    else if (a === '--turn-budget') out.turnBudget = Number(next());
    else if (a === '--project-dir') out.projectDir = next();
    else if (a === '--cwd') out.cwd = next();
    else if (a === '--model') out.model = next();
    else if (a === '--claude-path') out.claudePath = next();
    else if (a === '--json') out.json = next();
    else if (a === '--probe-only') out.probeOnly = true;
    else if (a === '--help' || a === '-h') { out.help = true; }
    else throw new Error(`unknown option ${JSON.stringify(a)}`);
  }
  return out;
}

// --- claims ---------------------------------------------------------------------------------------

/** One checkable statement, its verdict, and the OBSERVATION it rests on. */
const claim = (name, outcome, detail, evidence = null) => ({ name, outcome, detail, evidence });

const PAD_BLOCK = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: deterministic padding for the RespawnPack rollover canary; this text carries no instructions and no facts.`).join('\n');

function log(s) { process.stdout.write(`${s}\n`); }

// --- the run --------------------------------------------------------------------------------------

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 40).join('\n')); return 0; }

  const startedAt = new Date().toISOString();
  const projectDir = opts.projectDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rp-sdk-canary-'));
  const report = {
    kind: 'respawnpack-activation-canary',
    profile: caps.PROFILE,
    startedAt,
    endedAt: null,
    environment: { node: process.version, platform: process.platform, projectDir, cwd: opts.cwd || projectDir },
    options: { rollovers: opts.rollovers, contextBudget: opts.contextBudget, turnBudget: opts.turnBudget, model: opts.model },
    probe: null,
    budgetNote: opts.contextBudget > 0
      ? `Thresholds were measured against an OPERATOR-CONFIGURED budget of ${opts.contextBudget} tokens, not the model's real context window. The compaction, the identity comparison and the exactly-once delivery are real; "the final threshold fires at the real window" is NOT what this run measured. Use --context-budget 0 for that.`
      : 'Thresholds were measured against the host-published window when it was available, and against the 1000000 default otherwise.',
    rollovers: [],
    claims: [],
    outcome: null,
    exitCode: null,
    ownerActions: [],
  };

  const sup = createSupervisor({
    projectDir,
    cwd: opts.cwd || projectDir,
    model: opts.model,
    claudePath: opts.claudePath,
    tools: '',                                   // a padding turn has no business touching the filesystem
    contextBudgetTokens: opts.contextBudget > 0 ? opts.contextBudget : null,
    consumerId: `canary:${process.pid}:${crypto.randomBytes(3).toString('hex')}`,
  });

  // --- 1. probe -----------------------------------------------------------------------------------
  log('RespawnPack · claude-code/sdk-supervisor activation canary');
  log(`  project dir: ${projectDir}`);
  log('  probing…');

  const probe = await sup.probe();
  report.probe = probe;
  report.environment.claudeVersion = probe.version || null;
  report.environment.exePath = probe.exePath || null;

  if (probe.outcome !== OUTCOME.PASS) {
    report.claims.push(claim(
      'the configured integration is active',
      probe.outcome,
      probe.why,
      { verbatim: probe.verbatim, structural: probe.structural || null },
    ));
    report.ownerActions.push(probe.ownerAction);
    return finish(report, opts, sup, probe);
  }

  report.claims.push(claim('the configured integration is active', OUTCOME.PASS,
    `claude ${probe.version} at ${probe.exePath}; the init message enumerated ${probe.structural.slashCommandCount} slash commands and "compact" is among them`,
    { structural: probe.structural }));

  if (opts.probeOnly) return finish(report, opts, sup, probe);

  // --- 2. open the conversation -------------------------------------------------------------------
  log('  opening a conversation…');
  const first = await sup.turn({ prompt: 'Reply with exactly: RESPAWNPACK-CANARY-READY', label: 'open' });
  if (!first.sessionId) {
    report.claims.push(claim('a supervised conversation was opened', OUTCOME.CANNOT_DETERMINE,
      'the host reported no session id on the opening turn, so there is no conversation identity to roll over',
      { lines: first.turn.stdoutLines }));
    report.ownerActions.push('Run the same invocation by hand and see what the host reports; the argv is in the turn record under the project dir.');
    return finish(report, opts, sup, probe);
  }
  report.claims.push(claim('a supervised conversation was opened', OUTCOME.PASS, `session ${first.sessionId}`, { sessionId: first.sessionId }));
  log(`  session ${first.sessionId}`);

  // --- 3. N consecutive rollovers -----------------------------------------------------------------
  for (let i = 0; i < opts.rollovers; i += 1) {
    log(`  rollover ${i + 1}/${opts.rollovers}: padding…`);
    const entry = { index: i, claims: [], padTurns: 0, thresholdFired: false, cycleBefore: null, cycleAfter: null };
    report.rollovers.push(entry);

    // pad until the final threshold fires, or the turn budget runs out
    let ts = sup.thresholdState();
    while (!ts.evaluation.fire.includes('final') && entry.padTurns < opts.turnBudget) {
      await sup.turn({ prompt: `Reply with exactly: PAD-${i}-${entry.padTurns}\n\n${PAD_BLOCK}`, label: `pad-${i}-${entry.padTurns}` });
      entry.padTurns += 1;
      ts = sup.thresholdState();
    }
    entry.thresholdFired = ts.evaluation.fire.includes('final');
    entry.occupancy = ts.measurement.measurable ? Number(ts.measurement.usedPercent.toFixed(2)) : null;
    entry.budgetSource = ts.measurement.budget ? ts.measurement.budget.source : null;

    entry.claims.push(entry.thresholdFired
      ? claim('the final threshold fired on a measured context', OUTCOME.PASS,
        `${entry.occupancy}% of a ${entry.budgetSource} budget after ${entry.padTurns} padding turns`,
        { evaluation: ts.evaluation, budget: ts.measurement.budget })
      : claim('the final threshold fired on a measured context', OUTCOME.CANNOT_DETERMINE,
        `the turn budget (${opts.turnBudget}) ran out at ${entry.occupancy === null ? 'an unmeasured context' : `${entry.occupancy}%`}; the rollover below was FORCED, so nothing here says a threshold would have fired on its own`,
        { evaluation: ts.evaluation }));

    const nonce = `RP-INJECT-${crypto.randomBytes(5).toString('hex')}`;
    entry.nonce = nonce;
    log(`  rollover ${i + 1}/${opts.rollovers}: compacting…`);

    const r = await sup.rollover({
      force: !entry.thresholdFired,
      handoffFields: {
        atomicActionId: `canary-rollover-${i}`,
        exactNextAction: `Reply with exactly: ${nonce}`,
        userConstraints: ['this is an automated canary; take no action other than the exact next action'],
        verificationEvidence: [`padding turns in this cycle: ${entry.padTurns}`],
      },
      nextPrompt: 'Follow the exact next action above and nothing else.',
    });
    entry.result = summarise(r);
    entry.cycleBefore = r.cycleBefore || null;
    entry.cycleAfter = r.cycleAfter || null;

    // --- the claims, each from an observed event -------------------------------------------------
    if (r.status === STEP.HALTED) {
      entry.claims.push(claim('the compaction completed', r.failure.outcome, `${r.failure.code}: ${r.failure.detail}`, { turnFile: r.turnFile || null }));
      report.ownerActions.push(r.failure.recovery);
      entry.claims.push(claim('the conversation identity survived', OUTCOME.CANNOT_DETERMINE, 'the rollover stopped before the identity could be compared'));
      entry.claims.push(claim('exactly one context cycle was entered', OUTCOME.CANNOT_DETERMINE, 'no cycle advanced'));
      entry.claims.push(claim('the verified handoff was delivered exactly once', OUTCOME.CANNOT_DETERMINE, 'the handoff was not consumed; it is still on disk and unclaimed'));
      break;
    }
    if (r.status === STEP.NOOP) {
      entry.claims.push(claim('the compaction completed', OUTCOME.CANNOT_DETERMINE,
        `the host declined to compact ("${r.verdict && r.verdict.hostResult}") and emitted no boundary. That is a typed non-failure, not a rollover.`));
      report.ownerActions.push('The host had nothing to compact. Re-run with more padding turns (--turn-budget) or a smaller --context-budget.');
      break;
    }
    if (r.status !== STEP.OK) {
      entry.claims.push(claim('the compaction completed', OUTCOME.CANNOT_DETERMINE, r.why || `the rollover answered ${r.status}`));
      break;
    }

    entry.claims.push(claim('the compaction completed', OUTCOME.PASS,
      `the host emitted compact_boundary (trigger ${r.compaction.metadata.trigger}, pre_tokens ${r.compaction.metadata.preTokens}, post_tokens ${r.compaction.metadata.postTokens})`,
      { raw: r.compaction.raw }));

    entry.claims.push(r.identity.observedId === first.sessionId
      ? claim('the conversation identity survived', OUTCOME.PASS, `expected and observed session_id are both ${r.identity.observedId}`, { record: r.identity.record })
      : claim('the conversation identity survived', OUTCOME.FAIL, `expected ${first.sessionId}, observed ${r.identity.observedId}`, { record: r.identity.record }));

    entry.claims.push(r.cycleAfter.index === r.cycleBefore.index + 1
      ? claim('exactly one context cycle was entered', OUTCOME.PASS, `cycle ${r.cycleBefore.index} → ${r.cycleAfter.index} (${r.cycleAfter.id})`)
      : claim('exactly one context cycle was entered', OUTCOME.FAIL, `cycle went ${r.cycleBefore.index} → ${r.cycleAfter.index}`));

    // Exactly-once, checked against the RECEIPT on disk rather than against our own memory of it.
    const receipt = core.io.readJSONClassified(r.receiptPath);
    const secondAttempt = core.handoff.consume(sup.dir(), r.handoffId, { consumerId: 'canary-second-attempt' });
    entry.claims.push(receipt.status === 'OK' && secondAttempt.status === 'ALREADY_CONSUMED'
      ? claim('the verified handoff was delivered exactly once', OUTCOME.PASS,
        `the receipt names ${receipt.doc.consumerId} at ${receipt.doc.consumedAt}, and a second claim was refused with a pointer to it`,
        { receipt: receipt.doc })
      : claim('the verified handoff was delivered exactly once', OUTCOME.FAIL,
        `receipt read ${receipt.status}; a second claim answered ${secondAttempt.status}`, { receipt: receipt.doc || null }));

    // Injection, proved by an ECHO the model could only have produced from the handoff's own text.
    const echoed = String((r.continuation && r.continuation.observation && stream.allAssistantText(r.continuation.observation)) || '');
    entry.claims.push(echoed.includes(nonce)
      ? claim('the handoff reached the next context cycle', OUTCOME.PASS, `the model echoed ${nonce}, which appeared nowhere but in the handoff`, { echo: echoed.slice(0, 200) })
      : claim('the handoff reached the next context cycle', OUTCOME.CANNOT_DETERMINE,
        `the continuation prompt carried the handoff, and the model did not echo ${nonce}. "It did not repeat the nonce" is not "it did not receive it" — this claim is undetermined, not failed.`,
        { echo: echoed.slice(0, 200) }));

    log(`  rollover ${i + 1}/${opts.rollovers}: cycle ${r.cycleBefore.index} → ${r.cycleAfter.index}, identity ${r.identity.observedId === first.sessionId ? 'held' : 'CHANGED'}`);
  }

  // A run that stopped early has not proven consecutiveness, and says so rather than averaging.
  const completed = report.rollovers.filter((e) => e.result && e.result.status === STEP.OK).length;
  report.claims.push(completed === opts.rollovers
    ? claim(`${opts.rollovers} CONSECUTIVE rollovers`, OUTCOME.PASS, `${completed} of ${opts.rollovers} completed in one conversation`)
    : claim(`${opts.rollovers} CONSECUTIVE rollovers`, OUTCOME.CANNOT_DETERMINE, `${completed} of ${opts.rollovers} completed; the run stopped early`));

  return finish(report, opts, sup, probe);
}

function summarise(r) {
  return {
    status: r.status, rolled: Boolean(r.rolled), phase: r.phase || null,
    failure: r.failure ? { code: r.failure.code, outcome: r.failure.outcome, detail: r.failure.detail } : null,
    why: r.why || null,
  };
}

function finish(report, opts, sup, probe) {
  const outcomes = report.claims.map((c) => c.outcome)
    .concat(report.rollovers.flatMap((e) => e.claims.map((c) => c.outcome)));
  report.outcome = rollup(outcomes);
  report.exitCode = exitCodeFor(report.outcome);
  report.endedAt = new Date().toISOString();

  // The capability matrix is generated from THIS run's canary — never from the target.
  const canary = caps.canaryFromProbe({ ...probe, outcome: report.outcome, why: report.outcome === OUTCOME.PASS ? null : firstProblem(report) });
  report.capabilityMatrix = caps.matrix(canary);
  report.machine = sup.machine() ? { state: sup.machine().state(), cycleIndex: sup.machine().cycleIndex(), counts: sup.machine().counts(), dir: sup.dir() } : null;

  log('');
  log(`  OUTCOME: ${report.outcome}`);
  for (const c of report.claims) log(`    [${c.outcome}] ${c.name} — ${c.detail}`);
  for (const e of report.rollovers) {
    log(`    rollover ${e.index + 1}:`);
    for (const c of e.claims) log(`      [${c.outcome}] ${c.name} — ${c.detail}`);
  }
  if (report.budgetNote) log(`  NOTE: ${report.budgetNote}`);
  if (report.ownerActions.length) {
    log('  OWNER ACTION:');
    for (const a of [...new Set(report.ownerActions)]) log(`    · ${a}`);
  }
  log(`  capability matrix: rolloverCapable=${report.capabilityMatrix.rolloverCapable}, unmet=[${report.capabilityMatrix.unmet.join(', ')}]`);
  if (report.machine) log(`  rollover state: ${report.machine.dir}`);

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
      // Even an unexpected throw is typed. An unhandled crash that exits 0 would be the worst outcome
      // a canary can have — a green run that observed nothing.
      log(`  OUTCOME: CANNOT_DETERMINE`);
      log(`    the canary itself failed: ${e && e.stack ? e.stack : e}`);
      process.exitCode = exitCodeFor(OUTCOME.CANNOT_DETERMINE);
    });
}

module.exports = { main, parseArgs };
