#!/usr/bin/env node
/*
 * RespawnPack · adapters/claude-code/task-runner/canary.js — the task runner's OWN activation canary:
 * does the runner correctly capture a REAL completion signal from the kernel, and nothing else.
 *
 * Spec: the hooks-and-install audit §6 (the fresh-session-per-task runner design, and the canary precedent at
 * sdk-supervisor/canary.js) and the core-adapters-ops audit §3 "The task runner's own canary".
 *
 * ⭐ WHAT THIS PROVES, PRECISELY. Not "the task is done" — a bounded task's acceptance criteria are
 * prose, and nothing here evaluates prose. It proves one narrower, checkable claim: when this runner
 * hands a spawned session a delegate contract whose single acceptance criterion is a token generated
 * fresh for this run, and that session later runs `contract complete --met "<token>"` for real, the
 * runner's own attestation-reading path (`readAttestation` in runner.js) reports it correctly. This is
 * `sdk-supervisor/canary.js`'s nonce-echo trick, applied to task COMPLETION rather than to HANDOFF
 * INJECTION: there the proof is the model echoing a nonce in free text (ambiguous, so a non-echo is
 * CANNOT_DETERMINE); here the proof is a structured, deliberate kernel record (unambiguous, so a
 * missing or wrong one is FAIL). See `evaluateAttempt` below for exactly where that split is decided.
 *
 * ⛔ THE RUNNER IS WHAT IS PROVED, NOT A PARALLEL PATH THAT LOOKS LIKE IT. This file never spawns a
 * session or records a delegation itself — it builds a throwaway project and a one-row task queue, then
 * calls `runner.runTask()`, the exact same exported function `runner.test.mjs` drives. If the runner's
 * own logic changes, this canary exercises the change; a second implementation here would not.
 *
 * ⛔ TWO MODES, ONE CHEAP AND ONE EXPENSIVE, AND THEY MUST NEVER BE CONFUSED.
 *
 *   --probe-only   Does `claude` resolve, authenticate, and enumerate `compact`? No task session, no
 *                  delegation, no kernel call — one short handshake turn, reusing the sdk-supervisor's
 *                  OWN resolution and probe code (`supervisor.js` `probe()`) rather than copying it.
 *                  Cheap: run this once per machine before ever considering the full run below.
 *
 *   (default)      THE FULL CANARY. Builds a throwaway git project with a minimal installed kernel,
 *                  generates a distinctive token, and runs the runner against it for real: one real
 *                  headless `claude` session, through `cli.js`/`stream.js` exactly as the runner always
 *                  uses them. Spends real tokens. This is an owner action, never something an unattended
 *                  agent working on this pack runs against the live CLI on its own.
 *
 * ⛔ THE CANARY NEVER READS THE TRANSCRIPT FOR A CLAIM OF SUCCESS (anti-drift item 38 —
 * `core/lifecycle/evidence.js` FORBIDDEN_PROOF_TOKENS — extended here to a second runner path).
 * `evaluateAttempt` below reads exactly four kinds of fact from the runner's report: whether a
 * delegation was recorded and a turn was captured (`report.contract`, `report.turn.written`), whether
 * the host authenticated (`report.auth`, the SAME structural `stream.detectAuth` fact the runner itself
 * decided on), whether the turn exited cleanly (`report.turn.exit`, a process fact, not text content),
 * and whether the KERNEL's own attestation archive echoes the token (`report.gates.acceptance`, read
 * from `.respawnpack/runtime/contract.json` and `delegations.json`, never from `report.turn.lines`). A
 * transcript that contains the token and a confident claim of success, with no attestation recorded,
 * is FAIL — proven directly in canary.test.mjs.
 *
 * ⛔ WHY A MISSING OR WRONG TOKEN IS FAIL HERE, WHEN `sdk-supervisor/canary.js`'S OWN NON-ECHO IS
 * CANNOT_DETERMINE. That canary's nonce lives in FREE TEXT the model may or may not repeat — "it did not
 * say the word back" is not "it did not receive the handoff", so the honest answer is undetermined. This
 * canary's token lives in a KERNEL RECORD that only exists if a `contract complete --met` call actually
 * ran and actually matched what was recorded (`kernel/lib/closeout.js` `completeDelegation` refuses
 * anything less, in full — no partial match, no fuzzy match). Once the session's turn has run to
 * completion (checked FIRST, and separately from this), whether that structured record exists and
 * matches is a settled fact, not a guess about what the model meant, so "missing" and "wrong" both earn
 * the more decisive verdict.
 *
 * ⛔ WHAT THIS FILE DOES NOT ADD TO THE CAPABILITY MATRIX, AND WHY. `conformance/capability-matrix.mjs`
 * and `core/policy/capabilities.js` are built around exactly seven ROLLOVER capabilities (probe,
 * measureContext, settleOrStop, requestCompact, observeCompact, injectHandoff, resume) for the v0.3
 * in-place-rollover design — `core/policy/capabilities.js`'s own header calls the list "the adapter
 * interface, verbatim from the v0.3 design. Every adapter answers for all seven." The task runner never
 * rolls a conversation over in place: every session is fresh, `--resume` is refused by
 * `runner.js`'s `assertArgvIsSafe`, and there is no compaction step anywhere in this design. None of the
 * seven capabilities describes what this canary proves (a one-shot completion-attestation echo), so
 * `core.capabilities.declare()` has no capability id this profile could legitimately claim without
 * widening that closed, anti-drift-adjacent enum for a single M-effort task — out of scope here. No row
 * is added; see the task's own final report for this call spelled out.
 *
 * Usage:
 *   node adapters/claude-code/task-runner/canary.js [options]
 *
 *   --probe-only             the cheap preflight only (see above). Exit 0/1/2, never spawns a session.
 *   --project-dir <path>     the throwaway project the full canary proves the runner against
 *                            (default: a fresh temp directory, git-initialized, with a minimal
 *                            installed kernel copied in from install/_sources.js's own file lists)
 *   --model <name>           --model for the one session
 *   --allowed-tools <a,b>    --allowedTools for the one session
 *   --permission-mode <m>    --permission-mode for the one session
 *   --timeout <ms>           deadline for the one turn (default: cli.js's DEFAULT_TIMEOUT_MS)
 *   --kernel <path>          the respawnpack.js to invoke (default: the throwaway project's own
 *                            installed copy, then this pack's own — runner.js's resolveKernel order)
 *   --claude-path <path>     the executable (default: RESPAWNPACK_CLAUDE_PATH, then PATH)
 *   --json <file>            write the full report as JSON
 *
 * Exit: 0 PASS · 1 FAIL · 2 CANNOT_DETERMINE.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PACK_ROOT = path.join(__dirname, '..', '..', '..');

const core = require(path.join(PACK_ROOT, 'core', 'index.js'));
const cliLib = require(path.join(PACK_ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'cli.js'));
const { createSupervisor } = require(path.join(PACK_ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'supervisor.js'));
const manifestLib = require(path.join(PACK_ROOT, 'hooks', '_manifest.js'));
const sources = require(path.join(PACK_ROOT, 'install', '_sources.js'));
const runner = require('./runner.js');

const { OUTCOME, exitCodeFor } = core.failures;

// --- the token -------------------------------------------------------------------------------------

const TOKEN_PREFIX = 'RP-TASK-CANARY-';
const TASK_ID = 'canary-echo';

/** A token distinctive enough that finding it anywhere but the kernel's own record would be news. */
function generateToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
}

// --- a minimal installed kernel, so a REAL session following the composed prompt's literal command ---
// --- (`node .claude/respawnpack/respawnpack.js contract complete --met ...`) actually finds one -------

/**
 * Copy one file named in install/_sources.js's KERNEL_FILES or CORE_FILES (source-relative, prefixed
 * `kernel/` or `core/`) into `<projectDir>/.claude/<destRoot>/...`, stripping that prefix — the SAME
 * mapping `install/install.js` uses to place a real target's kernel, so this throwaway project looks
 * like an installed one rather than like a second, hand-rolled idea of what a kernel needs.
 */
function copyInstalled(rel, treePrefix, destRoot, projectDir) {
  const stripped = rel.replace(new RegExp(`^${treePrefix}/`), '');
  const src = path.join(PACK_ROOT, ...rel.split('/'));
  const dest = path.join(projectDir, '.claude', destRoot, ...stripped.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * Copy a whole tree, minus its own test files, preserving structure. Used for `hooks/`, which
 * `install/_sources.js` places as a single unit (its SOURCE_TREES entry) rather than as a curated
 * per-file list the way KERNEL_FILES/CORE_FILES are — so this mirrors that same "whole tree" choice
 * instead of hand-picking a subset the next kernel change could silently outgrow.
 */
function copyTree(srcDir, destDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.includes('.test.')) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) { copyTree(src, dest); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/**
 * `.claude/respawnpack/`, `.claude/core/` and `.claude/hooks/`, siblings, exactly as `install.js`
 * places them. `kernel/respawnpack.js`'s own `require('../core/index.js')` is what makes the first two
 * need to be siblings; `kernel/lib/state.js`, `closeout.js`, `removals.js` and `modhealth.js` each
 * resolve a `path.resolve(__dirname, '..', '..', 'hooks', '_manifest.js' | '_artifact.js' |
 * '_contracts.js')` of their own (and `respawnpack.js` resolves `_manifest.js` / `_posture.js`
 * directly), so a kernel copy with no installed `hooks/` reports `contract complete`/`contract
 * delegate` as CANNOT_DETERMINE ("the shared artifact boundary hooks/_artifact.js is unavailable") —
 * a fail-closed refusal, not a crash, but one that would make every canary run CANNOT_DETERMINE for a
 * reason that has nothing to do with what this canary proves.
 *
 * The kernel/core file lists are reused from install/_sources.js rather than re-typed here, for the
 * same reason that file gives for being the one list with two consumers: a third hand-written copy is
 * a coincidence, not a guarantee.
 */
function installMinimalKernel(projectDir) {
  for (const rel of sources.KERNEL_FILES) copyInstalled(rel, 'kernel', 'respawnpack', projectDir);
  for (const rel of sources.CORE_FILES) copyInstalled(rel, 'core', 'core', projectDir);
  copyTree(path.join(PACK_ROOT, 'hooks'), path.join(projectDir, '.claude', 'hooks'));
}

// --- the throwaway project ---------------------------------------------------------------------------

/**
 * A real git repository, a one-row task queue whose SOLE acceptance criterion is `token`, and a
 * STATE.json bound to HEAD so the runner's freshness check reports CURRENT — the same shape
 * `runner.test.mjs`'s `makeProject()` builds, plus the minimal installed kernel above.
 *
 * Both gates are declared off (`gates: {savepoint:false, gate:false}`): this canary proves the
 * attestation-echo path, not a project's own build tooling, and a gate outcome must not be able to
 * change PASS into FAIL for a claim it has nothing to do with.
 *
 * @returns {{dir:string, row:object}}
 */
function buildProject({ token, projectDir = null } = {}) {
  const dir = projectDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rp-task-canary-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'canary@respawnpack.test');
  git('config', 'user.name', 'respawnpack-task-runner-canary');
  git('config', 'commit.gpgsign', 'false');

  fs.mkdirSync(path.join(dir, 'docs', 'derived', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'a throwaway project, built to prove the task runner\'s own canary\n');

  const row = {
    id: TASK_ID,
    title: 'Echo the task-runner canary token',
    specPointer: 'adapters/claude-code/task-runner/canary.js',
    intent: 'Attest the single acceptance criterion, verbatim, via `contract complete --met`.',
    scope: { files: [], dirs: [] },
    acceptance: [token],
    gates: { savepoint: false, gate: false },
    dependsOn: [],
    state: 'ready',
    risk: 'low',
    provenance: { createdBy: 'adapters/claude-code/task-runner/canary.js', createdAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(dir, 'docs', 'derived', 'state', 'tasks.json'),
    `${JSON.stringify({ schemaVersion: '1.0.0', tasks: [row] }, null, 2)}\n`);

  installMinimalKernel(dir);

  git('add', '-A');
  git('commit', '-q', '-m', 'the task-runner canary project');

  const head = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'docs', 'derived', 'STATE.json'), `${JSON.stringify({
    schemaVersion: '1.0.0', sourceRevision: head, sourceManifest: manifestLib.sourceManifest(dir), counts: {},
  }, null, 2)}\n`);

  return { dir, row };
}

// --- claims ----------------------------------------------------------------------------------------

const claim = (name, outcome, detail, evidence = null) => ({ name, outcome, detail, evidence });

/**
 * Decide PASS / FAIL / CANNOT_DETERMINE from the runner's OWN report, and from nothing else.
 *
 * Four questions, asked in the order that keeps each one meaningful:
 *   1. Did the runner get as far as a captured turn against a recorded delegation at all? If not, the
 *      runner's own refusal (freshness, queue, selection, host reachability, an unsafe argv) is why,
 *      and its own summary already says so in the words `runner.test.mjs` fences.
 *   2. Was the host authenticated? Checked BEFORE the exit code, because a host can answer an
 *      authentication failure and still exit 0 — the same order `runner.js` step 9 uses.
 *   3. Did the turn run to completion at all (no timeout, no spawn error, exit 0)? A turn that did not
 *      finish proves nothing about the echo either way (anti-drift item 38: never a completion signal).
 *   4. ONLY THEN: does the kernel's own attestation archive echo the token? This is the one claim that
 *      may answer FAIL, because by this point the session has had its whole turn and the only question
 *      left is a settled fact about a structured record, not a guess about unfinished work.
 *
 * @returns {{claims:Array<object>, outcome:string}}
 */
function evaluateAttempt(runnerReport, token) {
  const claims = [];
  const { contract, turn, auth } = runnerReport;

  const reached = Boolean(contract && contract.recorded && turn && turn.written);
  if (!reached) {
    claims.push(claim('the runner recorded a delegation and captured one session turn',
      OUTCOME.CANNOT_DETERMINE, runnerReport.summary));
    return { claims, outcome: OUTCOME.CANNOT_DETERMINE };
  }
  claims.push(claim('the runner recorded a delegation and captured one session turn', OUTCOME.PASS,
    `session ${turn.sessionId || '(the host reported no id)'}, transcript kept verbatim at ${turn.file}`));

  if (auth && auth.failed) {
    claims.push(claim('the host was authenticated for this session', OUTCOME.CANNOT_DETERMINE,
      auth.verbatim, { from: auth.from, phrase: auth.phrase || null }));
    return { claims, outcome: OUTCOME.CANNOT_DETERMINE };
  }
  claims.push(claim('the host was authenticated for this session', OUTCOME.PASS,
    'no authentication failure was observed structurally in the stream'));

  const completed = Boolean(turn.exit && turn.exit.code === 0 && !turn.exit.timedOut && !turn.exit.spawnError);
  if (!completed) {
    claims.push(claim('the session ran to completion', OUTCOME.CANNOT_DETERMINE, runnerReport.summary));
    return { claims, outcome: OUTCOME.CANNOT_DETERMINE };
  }
  claims.push(claim('the session ran to completion', OUTCOME.PASS,
    `exit 0${Number.isFinite(turn.durationMs) ? ` in ${turn.durationMs}ms` : ''}`));

  const acceptance = runnerReport.gates && runnerReport.gates.acceptance;
  const folded = runner.foldCriterion(token);
  const echoed = Boolean(acceptance
    && acceptance.contractStatus === 'ATTESTED'
    && acceptance.outcome === OUTCOME.PASS
    && Array.isArray(acceptance.attested)
    && acceptance.attested.some((a) => runner.foldCriterion(a) === folded));

  if (echoed) {
    claims.push(claim('the kernel\'s own `contract complete --met` attestation echoes the generated token',
      OUTCOME.PASS,
      `archived at ${acceptance.attestedAt}, matching the token exactly (case and whitespace folded)`,
      { attested: acceptance.attested }));
    return { claims, outcome: OUTCOME.PASS };
  }
  claims.push(claim('the kernel\'s own `contract complete --met` attestation echoes the generated token',
    OUTCOME.FAIL,
    `the session ran to completion and the kernel's own record does not echo the token: ${
      acceptance ? acceptance.detail : 'the runner recorded no attestation read at all'}`,
    { contractStatus: acceptance ? acceptance.contractStatus : null }));
  return { claims, outcome: OUTCOME.FAIL };
}

// --- the two runs ------------------------------------------------------------------------------------

function log(s) { process.stdout.write(`${s}\n`); }

/**
 * `--probe-only` — reuse the sdk-supervisor's OWN resolution and probe code (`supervisor.js` `probe()`)
 * rather than copying it. One short handshake turn, no task session, no delegation, no kernel call.
 */
async function runProbe({ cli = cliLib.realCli, claudePath = null, model = null, projectDir = null, env = process.env } = {}) {
  const startedAt = new Date().toISOString();
  const dir = projectDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rp-task-canary-probe-'));
  const sup = createSupervisor({ projectDir: dir, cwd: dir, cli, claudePath, model, env, tools: '' });

  const probe = await sup.probe({ handshake: true });
  const claims = [claim('claude resolves, authenticates, and enumerates `compact`', probe.outcome,
    probe.outcome === OUTCOME.PASS
      ? `claude ${probe.version} at ${probe.exePath}; the init message enumerated ${probe.structural.slashCommandCount} slash command(s) and "compact" is among them`
      : probe.why,
    { verbatim: probe.verbatim || null, structural: probe.structural || null })];

  const outcome = probe.outcome;
  return {
    kind: 'respawnpack-task-runner-canary-probe',
    mode: 'probe',
    startedAt,
    endedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, projectDir: dir },
    probe,
    claims,
    outcome,
    exitCode: exitCodeFor(outcome),
    ownerAction: probe.outcome === OUTCOME.PASS ? null : (probe.ownerAction || null),
  };
}

/**
 * THE FULL CANARY. Builds (or reuses) a throwaway project, generates (or reuses) a token, runs the
 * task runner against it for real through `runner.runTask()`, and scores the attempt per
 * `evaluateAttempt`. Spends real tokens when `cli` is the real one — an owner action, never something
 * this file, or an unattended session working on this pack, decides to do on its own.
 */
async function runCanary({
  cli = cliLib.realCli,
  kernel = runner.realKernel,
  kernelPath = null,
  claudePath = null,
  model = null,
  allowedTools = null,
  permissionMode = null,
  timeoutMs = cliLib.DEFAULT_TIMEOUT_MS,
  projectDir = null,
  token = null,
  env = process.env,
} = {}) {
  const startedAt = new Date().toISOString();
  const tok = token || generateToken();
  const dir = projectDir || buildProject({ token: tok }).dir;

  const runnerReport = await runner.runTask({
    dir, taskId: TASK_ID, cli, kernel, kernelPath, claudePath, model, allowedTools, permissionMode, timeoutMs, env,
  });

  const { claims, outcome } = evaluateAttempt(runnerReport, tok);
  return {
    kind: 'respawnpack-task-runner-canary',
    mode: 'full',
    startedAt,
    endedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    projectDir: dir,
    token: tok,
    runnerReport,
    claims,
    outcome,
    exitCode: exitCodeFor(outcome),
  };
}

// --- CLI ----------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    probeOnly: false, projectDir: null, model: null, allowedTools: null, permissionMode: null,
    timeoutMs: null, kernelPath: null, claudePath: null, json: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i += 1];
    if (a === '--probe-only') out.probeOnly = true;
    else if (a === '--project-dir') out.projectDir = next();
    else if (a === '--model') out.model = next();
    else if (a === '--allowed-tools') out.allowedTools = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--permission-mode') out.permissionMode = next();
    else if (a === '--timeout') out.timeoutMs = Number(next());
    else if (a === '--kernel') out.kernelPath = next();
    else if (a === '--claude-path') out.claudePath = next();
    else if (a === '--json') out.json = next();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown option ${JSON.stringify(a)}`);
  }
  return out;
}

/** The header, up to and not including the line that closes it — found by its end, not a line count. */
function helpText() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '*/');
  return lines.slice(1, end > 0 ? end : 80).join('\n');
}

function printReport(report) {
  log(`RespawnPack · claude-code/task-runner canary (${report.mode})`);
  for (const c of report.claims) log(`  [${c.outcome}] ${c.name} — ${c.detail}`);
  if (report.projectDir) log(`  project: ${report.projectDir}`);
  if (report.token) log(`  token: ${report.token}`);
  log(`  → ${report.outcome}`);
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    process.stderr.write(`  ${e.message}\n  Run with --help for the option list.\n`);
    return exitCodeFor(OUTCOME.CANNOT_DETERMINE);
  }
  if (opts.help) { process.stdout.write(`${helpText()}\n`); return 0; }

  const report = opts.probeOnly
    ? await runProbe({ claudePath: opts.claudePath, model: opts.model, projectDir: opts.projectDir })
    : await runCanary({
      claudePath: opts.claudePath, model: opts.model, allowedTools: opts.allowedTools,
      permissionMode: opts.permissionMode, kernelPath: opts.kernelPath, projectDir: opts.projectDir,
      ...(Number.isFinite(opts.timeoutMs) && opts.timeoutMs !== null ? { timeoutMs: opts.timeoutMs } : {}),
    });

  printReport(report);

  if (opts.json) {
    const w = core.io.writeAtomicJSON(opts.json, report);
    if (!w.ok) process.stderr.write(`  the report could not be written to ${opts.json}: ${w.detail}\n`);
    else log(`  report: ${opts.json}`);
  }
  return report.exitCode;
}

module.exports = {
  TOKEN_PREFIX, TASK_ID,
  generateToken, installMinimalKernel, buildProject,
  claim, evaluateAttempt,
  runProbe, runCanary,
  parseArgs, helpText, main,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      log('  OUTCOME: CANNOT_DETERMINE');
      log(`    the canary itself threw — ${(e && e.stack) || e}`);
      process.exitCode = exitCodeFor(OUTCOME.CANNOT_DETERMINE);
    });
}
