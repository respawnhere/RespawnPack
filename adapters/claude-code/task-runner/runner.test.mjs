/*
 * RespawnPack · adapters/claude-code/task-runner/runner.test.mjs — the runner, driven offline.
 *
 * ⛔ WHY THIS SUITE NEVER TOUCHES A LIVE CLI. A suite that needed an authenticated host would be a
 * suite that goes red on a machine that is merely logged out, which is the same collapse of "could
 * not run" into "failed" the runner itself refuses. So the only thing faked is the process surface:
 * `runTurn` returns fixture bytes recorded from a real host, and everything downstream of the first
 * line of stdout — stream.js's observation, detectAuth, the turn record, the outcome — is production
 * code. `sdk-supervisor/supervisor.test.mjs`'s fake-CLI shape is reused verbatim so the two suites
 * cannot develop different ideas of what a turn looks like.
 *
 * ⛔ AND THE KERNEL IS NOT FAKED. `contract delegate` runs as a REAL child process against a REAL
 * throwaway git repository, because "the delegation was recorded" is a claim about the kernel's own
 * runtime pointer, and a fake that returned `{ok:true}` would prove only that the fake returns true.
 * Measured at ~130ms per call, which is what keeps this suite inside the fast tier.
 *
 * ⛔ AND SO IS THE ATTESTATION. `attesting()` below makes the FAKE SESSION do what a real one would:
 * it runs `contract complete --met` as a real kernel child process, once per recorded criterion, from
 * inside `runTurn`. The record the runner then reads back is the one the real closeout wrote — which
 * is the whole point, because the thing under test is "does the runner believe the KERNEL", and a
 * hand-written `delegations.json` would only prove it believes this file.
 *
 * ⭐ WHICH FIXTURE PROVES WHICH STATE, AND WHY THEY ARE NOT THE SAME FILE. All three files under
 * `sdk-supervisor/fixtures/captured/` are streams from an UNAUTHENTICATED host (MANIFEST.json records
 * when and how each was taken), so the captured set is the right evidence for the unauthenticated
 * state and cannot be evidence for a healthy one. The healthy turn therefore replays
 * `fixtures/synthetic/turn-light.jsonl`, which the manifest labels synthetic — a claim about what a
 * host WOULD say, sufficient to prove this reader is correct if it does, and never cited as capture.
 *
 * Nothing here touches the repository's own .respawnpack/; every run gets a temp project.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { validate } from '../../../schemas/validate.mjs';
import { materialize } from '../../../ops/_project-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const require_ = createRequire(import.meta.url);

const runner = require_(path.join(HERE, 'runner.js'));
const cliLib = require_(path.join(ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'cli.js'));
const manifest = require_(path.join(ROOT, 'hooks', '_manifest.js'));
// The shared runtime whose bucket keys the handoff's file list is derived from, and the contract
// source that declares its exports — both read directly by the P5-N-6c block near the end of this file.
const durable = require_(path.join(ROOT, 'hooks', '_runtime.js'));
const contracts = require_(path.join(ROOT, 'hooks', '_contracts.js'));
// P4-M-5: the same pure routing module the runner calls, so the route-state tests below compute their
// EXPECTED answer through the real function rather than hard-coding a model id that would go stale the
// next time the register's evidence changes.
const routing = require_(path.join(ROOT, 'core', 'policy', 'routing.js'));
const REAL_REGISTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'spine', 'reference', 'models', 'capability-register.json'), 'utf8'));

const FIXTURES = path.join(ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'fixtures');
const fixtureLines = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8').split('\n').filter((l) => l.length);

const HEALTHY = 'synthetic/turn-light.jsonl';
const UNAUTHENTICATED = 'captured/07-pathcli-test.jsonl';

const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

// =================================================================================================
// A throwaway project: a real git repository, a real task queue, and a STATE.json whose freshness is
// decided by the SAME hooks/_manifest.js the kernel's `status` and the SessionStart hook both use.
// =================================================================================================

/*
 * ⭐ WHY THE DEFAULT ROW DECLARES `gates.savepoint: false`. `savepoint --verify` on a throwaway
 * repository is structurally CANNOT_DETERMINE — kernel/schema.test.mjs asserts exactly that ("a bare
 * project's savepoint should be CANNOT_DETERMINE (exit 2)"), because nothing has been declared yet. A
 * fixture that left it on would prove only that a bare repo cannot pass a savepoint, and every state
 * below would collapse to exit 2. So the default row declares it off, the way a planner declares which
 * gates answer for a task — and one test BELOW turns it back on, against the same bare repo, so the
 * kernel gate is still proved to actually run as a real child process.
 */
const PASSING_CHECK = { name: 'unit', command: process.execPath, args: ['-e', 'process.exit(0)'] };
const FAILING_CHECK = { name: 'unit', command: process.execPath, args: ['-e', 'process.exit(1)'] };
const MISSING_CHECK = { name: 'unit', command: 'respawnpack-no-such-tool-exists', args: [] };

const taskRow = (over = {}) => ({
  id: 'T-1',
  title: 'Do the bounded thing',
  specPointer: 'PLAN.md decision 2.1',
  scope: { files: ['src/a.js'], dirs: ['src/'] },
  intent: 'Make the bounded thing true.',
  acceptance: ['the bounded thing is true', 'its test is green'],
  gates: { savepoint: false, gate: true },
  dependsOn: [],
  state: 'ready',
  risk: 'low',
  provenance: { createdBy: 'the planner', createdAt: '2026-09-03' },
  ...over,
});

function makeProject({
  tasks = [taskRow()], stale = false, queueDoc = undefined, omitQueue = false,
  checks = [PASSING_CHECK], qualityGate = undefined, omitConfig = false,
  // P3-I-2: a declared posture ({profile[, overrides]}) and/or projectType, merged into the config
  // written below — BEFORE the commit and the STATE.json manifest, so a project that declares either
  // stays CURRENT for the reason every other field here does. `configRaw`, when given, replaces the
  // whole file with its own bytes instead — the one way to build an UNREADABLE config fixture.
  posture = undefined, projectType = undefined, configRaw = undefined,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-task-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@respawnpack.test');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');

  fs.mkdirSync(path.join(dir, 'docs', 'derived', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'a throwaway project\n');
  if (!omitQueue) {
    const doc = queueDoc !== undefined ? queueDoc : { schemaVersion: '1.0.0', tasks };
    fs.writeFileSync(path.join(dir, 'docs', 'derived', 'state', 'tasks.json'), `${JSON.stringify(doc, null, 2)}\n`);
  }
  if (!omitConfig) {
    if (configRaw !== undefined) {
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), configRaw);
    } else {
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), `${JSON.stringify({
        qualityGate: qualityGate !== undefined ? qualityGate : { checks },
        ...(posture !== undefined ? { posture } : {}),
        ...(projectType !== undefined ? { projectType } : {}),
      }, null, 2)}\n`);
    }
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'the project');

  // Bound to HEAD and to the digests of the compiler inputs, exactly as a savepoint writes it.
  const head = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'docs', 'derived', 'STATE.json'), `${JSON.stringify({
    schemaVersion: '1.0.0', sourceRevision: head, sourceManifest: manifest.sourceManifest(dir), counts: {},
  }, null, 2)}\n`);

  if (stale) {
    // One more commit that is NOT a savepoint output, which is what makes the projection stale.
    fs.writeFileSync(path.join(dir, 'src.js'), 'moved on\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'work the projection does not describe');
  }
  return dir;
}

/*
 * ⭐ P4-M-5 · A PROJECT BUILT FROM ops/_project-fixtures.mjs's OWN ARCHETYPE TREE, NEVER A HAND-ROLLED
 * ONE. The class this task belongs to (the class audit "Model-aware orchestration") is proved on the
 * web-app shape (`greenfield-app`, a coding task routed to Claude with the model recorded) and the
 * docs-only shape (a class with no register to answer beyond the pack's own) — the same two archetypes
 * the audit names for this exact change. `materialize()` writes the real tree; this helper layers the
 * task queue, the declared config, an optional copy of the pack's own capability register at
 * `docs/reference/models/`, and the same STATE.json shortcut `makeProject()` above uses (a hand-composed
 * projection bound to the real commit and the real manifest, rather than a full kernel `state` compile)
 * so this suite stays in the fast tier.
 */
function makeArchetypeProject(kind, {
  tasks = [taskRow()], posture = undefined, projectType = undefined, withRegister = false, registerBytes = undefined,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-task-${kind}-`));
  materialize(kind, dir, { git: false });

  fs.mkdirSync(path.join(dir, 'docs', 'derived', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'derived', 'state', 'tasks.json'),
    `${JSON.stringify({ schemaVersion: '1.0.0', tasks }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), `${JSON.stringify({
    qualityGate: { notApplicable: true, reason: 'a materialised archetype fixture, not a real toolchain' },
    posture: posture !== undefined ? posture : { profile: 'standard' },
    projectType: projectType !== undefined ? projectType : kind,
  }, null, 2)}\n`);

  if (withRegister || registerBytes !== undefined) {
    const regDir = path.join(dir, 'docs', 'reference', 'models');
    fs.mkdirSync(regDir, { recursive: true });
    const bytes = registerBytes !== undefined
      ? registerBytes
      : fs.readFileSync(path.join(ROOT, 'spine', 'reference', 'models', 'capability-register.json'), 'utf8');
    fs.writeFileSync(path.join(regDir, 'capability-register.json'), bytes);
  }

  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@respawnpack.test');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'the project');

  const head = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'docs', 'derived', 'STATE.json'), `${JSON.stringify({
    schemaVersion: '1.0.0', sourceRevision: head, sourceManifest: manifest.sourceManifest(dir), counts: {},
  }, null, 2)}\n`);
  return dir;
}

// =================================================================================================
// The fake process surface — the same shape sdk-supervisor/supervisor.test.mjs uses, so the argv it
// records is built by cli.js's own buildTurnArgs rather than by this file's idea of one.
// =================================================================================================

function fakeCli({ lines = fixtureLines(HEALTHY), version = null, turnOverrides = null, duringTurn = null } = {}) {
  const calls = [];
  return {
    kind: 'fake',
    calls: () => calls,
    async runVersion(opts) {
      calls.push({ fn: 'runVersion', opts });
      return version || {
        ok: true, version: '2.1.205', versionLine: '2.1.205 (Claude Code)', stdout: '2.1.205 (Claude Code)\n',
        stderr: '', code: 0, exePath: 'C:/fake/claude.exe', exeSource: 'PATH', why: null,
      };
    },
    async runTurn(opts) {
      calls.push({ fn: 'runTurn', opts });
      // Whatever a real session would have DONE to the project, done here for the same reason the
      // kernel is not faked: the runner's next step reads the project, not this object.
      if (duringTurn) duringTurn(opts);
      const base = {
        ok: true, code: 0, signal: null, timedOut: false, spawnError: null,
        stdoutLines: lines.slice(), stdout: lines.join('\n'), stderr: '',
        argv: ['C:/fake/claude.exe', ...cliLib.buildTurnArgs(opts)],
        exePath: 'C:/fake/claude.exe', exeSource: 'fake',
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1,
      };
      return turnOverrides ? { ...base, ...turnOverrides(opts) } : base;
    },
  };
}

const KERNEL = path.join(ROOT, 'kernel', 'respawnpack.js');

/** The real `contract complete --met`, once per criterion — what a session that finished would run. */
function attest(dir, criteria) {
  const args = [KERNEL, 'contract', 'complete', '--dir', dir, '--json'];
  for (const c of criteria) args.push('--met', c);
  const r = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = JSON.parse(r);
  assert.equal(out.outcome, 'PASS', `the fixture attestation did not close the delegation: ${r}`);
  return out;
}

/** A fake session that attests every criterion the queue row declares, through the real kernel. */
const attesting = (criteria = taskRow().acceptance, over = {}) =>
  fakeCli({ duringTurn: (opts) => attest(opts.cwd, criteria), ...over });

const run = (dir, over = {}) => runner.runTask({ dir, cli: fakeCli(), ...over });
const runAttesting = (dir, criteria, over = {}) => runner.runTask({ dir, cli: attesting(criteria), ...over });

const turnFile = (dir, id, n = 1) => path.join(dir, '.respawnpack', 'runtime', 'tasks', id, `turn-${String(n).padStart(3, '0')}.json`);
const contractFile = (dir) => path.join(dir, '.respawnpack', 'runtime', 'contract.json');

// =================================================================================================
describe('state 1 — a ready task with a CURRENT projection', () => {
  test('starts, records the delegation, runs ONE fresh session, and keeps every line verbatim', async () => {
    const dir = makeProject();
    try {
      const lines = fixtureLines(HEALTHY);
      const cli = attesting(taskRow().acceptance, { lines });
      const r = await runner.runTask({ dir, cli });

      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.exitCode, 0);
      assert.equal(r.freshness.label, 'CURRENT');
      assert.equal(r.selection.picked, 'T-1');

      // The delegation was recorded by the REAL kernel, before the session…
      assert.equal(r.contract.recorded, true, r.contract.stderr || r.contract.stdout);
      assert.equal(r.contract.exitCode, 0);
      assert.deepEqual(r.contract.acceptance, ['the bounded thing is true', 'its test is green']);
      // …and the session closed it with the real `contract complete --met`, so runtime is back to
      // collaborate and the attestation is in the kernel's own archive, not in this file's idea of one.
      assert.equal(readJSON(contractFile(dir)).mode, 'collaborate');
      const archive = readJSON(path.join(dir, '.respawnpack', 'runtime', 'delegations.json'));
      assert.equal(archive.completed.length, 1);
      assert.equal(archive.completed[0].task, 'Do the bounded thing');
      assert.deepEqual(archive.completed[0].acceptance, ['the bounded thing is true', 'its test is green']);

      // Exactly one turn, and it was a FRESH session: no sessionId in, so no --resume out.
      const turns = cli.calls().filter((c) => c.fn === 'runTurn');
      assert.equal(turns.length, 1, 'a task runs exactly one turn in this half');
      assert.equal(turns[0].opts.sessionId, undefined);
      assert.equal(turns[0].opts.promptVia, 'stdin');
      assert.equal(turns[0].opts.cwd, dir);
      assert.equal(turns[0].opts.env.RESPAWNPACK_TASK_ID, 'T-1', 'the hooks P5-T-16c wires read this');

      // The bytes are kept, unmodified, where the spec says they are kept.
      const file = turnFile(dir, 'T-1');
      assert.equal(r.turn.file, file);
      assert.equal(r.turn.written, true);
      const doc = readJSON(file);
      assert.deepEqual(doc.lines, lines, 'the transcript is not verbatim');
      assert.equal(doc.kind, 'claude-cli-turn');
      assert.equal(doc.taskId, 'T-1');
      assert.equal(doc.sessionId, 'synth-0000-0000-0000-000000000001');
      assert.equal(r.turn.sessionId, doc.sessionId);
    } finally { rm(dir); }
  });

  test('the gates confirm the acceptance, every criterion is attested, and exit 0 says exactly that and no more', async () => {
    const dir = makeProject();
    try {
      const r = await runAttesting(dir);
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.exitCode, 0);

      // The three fields half a left null are filled, and the null sentinel is gone.
      assert.notEqual(r.gates, null);
      assert.notEqual(r.receipt, null);
      assert.notEqual(r.handoff, null);

      // The gates RAN — in this process, as child processes — and passed.
      assert.equal(r.gates.outcome, 'PASS');
      const ids = r.gates.checks.map((c) => c.id);
      assert.deepEqual(ids, ['savepoint --verify', 'qualityGate:unit']);
      assert.equal(r.gates.checks[0].outcome, 'NOT_APPLICABLE', 'the row declares gates.savepoint false');
      assert.equal(r.gates.checks[1].outcome, 'PASS');
      assert.equal(r.gates.checks[1].exitCode, 0);

      // Every recorded criterion is attested…
      assert.equal(r.gates.acceptance.outcome, 'PASS');
      assert.deepEqual(r.gates.acceptance.unattested, []);
      assert.deepEqual(r.gates.acceptance.attested, ['the bounded thing is true', 'its test is green']);

      // …and NOT ONE of them is claimed to have been verified.
      for (const row of r.gates.acceptance.evaluation) {
        assert.equal(row.attested, true);
        assert.equal(row.evaluation, 'CANNOT_DETERMINE',
          'a prose criterion was reported as machine-evaluated, which is the manufactured evidence this pack refuses');
      }
      assert.match(r.summary, /does NOT say any criterion was verified/);
      assert.match(r.summary, /an attestation is a claim, not a proof/);
    } finally { rm(dir); }
  });

  test('the receipt and the handoff are on disk, and the gate results are inside both', async () => {
    const dir = makeProject();
    try {
      const r = await runAttesting(dir);
      assert.equal(r.outcome, 'PASS', r.summary);

      // The receipt, beside savepoint-attempt.json, named for the attempt it describes.
      assert.equal(r.receipt.status, 'WRITTEN');
      assert.equal(r.receipt.path, path.join(dir, '.respawnpack', 'runtime', 'task-attempt-T-1-001.json'));
      const receipt = readJSON(r.receipt.path);
      assert.equal(receipt.kind, 'respawnpack-task-attempt');
      assert.equal(receipt.outcome, 'PASS');
      assert.equal(receipt.exitCode, 0);
      assert.equal(receipt.attempt, 1);
      assert.equal(receipt.turn.file, turnFile(dir, 'T-1'), 'the receipt does not point at the turn it describes');
      assert.deepEqual(receipt.gates.checks.map((c) => c.outcome), ['NOT_APPLICABLE', 'PASS']);
      assert.deepEqual(receipt.acceptance.unattested, []);

      // The handoff, through core/state/handoff.js, verified by its own sibling receipt.
      assert.equal(r.handoff.status, 'WRITTEN');
      assert.equal(r.handoff.verified, true);
      const handoff = readJSON(r.handoff.path);
      assert.equal(handoff.kind, 'rollover-handoff');
      assert.equal(handoff.identity.conversationId, 'synth-0000-0000-0000-000000000001');
      assert.equal(handoff.atomicActionId, 'T-1');
      assert.deepEqual(handoff.unresolvedQuestions, [], 'a passing run left an unresolved question');
      assert.deepEqual(handoff.verificationEvidence.map((e) => e.gate), ['savepoint --verify', 'qualityGate:unit']);
      assert.ok(exists(`${r.handoff.path.replace(/\.json$/, '')}.verified.json`),
        'the handoff has no verification receipt, so nothing proved the bytes read back');
    } finally { rm(dir); }
  });

  test('a second run writes turn-002 rather than overwriting the first run\'s evidence', async () => {
    const dir = makeProject();
    try {
      await run(dir);
      await run(dir);
      assert.ok(exists(turnFile(dir, 'T-1', 1)), 'the first turn record was destroyed');
      assert.ok(exists(turnFile(dir, 'T-1', 2)), 'the second run did not write its own record');
      // …and its receipt gets its own path, for the same reason and by the same number.
      assert.ok(exists(path.join(dir, '.respawnpack', 'runtime', 'task-attempt-T-1-001.json')));
      assert.ok(exists(path.join(dir, '.respawnpack', 'runtime', 'task-attempt-T-1-002.json')));
    } finally { rm(dir); }
  });

  test('the KERNEL gate really runs, and the verdict is the kernel\'s own rather than this runner\'s reading of it', async () => {
    /*
     * `gates.savepoint: true` against this fixture, whose STATE.json is written by hand rather than by
     * the compiler — so `state-writeback` genuinely FAILS when the kernel compiles fresh and compares
     * in memory. That is the point of turning it on here: the row below is a real child process's real
     * exit code, not a mapping this file arranged, and it proves the kernel gate is wired up at all.
     */
    const dir = makeProject({ tasks: [taskRow({ gates: { savepoint: true, gate: true } })] });
    try {
      const r = await runAttesting(dir);
      const sp = r.gates.checks.find((c) => c.id === 'savepoint --verify');
      assert.equal(sp.kind, 'kernel');
      assert.equal(sp.outcome, 'FAIL', `the kernel gate did not run or did not answer: ${sp.detail}`);
      assert.equal(sp.exitCode, 1, 'the row carries no exit code, so no child process answered');
      assert.match(sp.detail, /state-writeback FAIL/, 'the row does not name what the kernel actually reported');
      assert.equal(sp.command, process.execPath);
      assert.ok(sp.args.includes('savepoint') && sp.args.includes('--verify'),
        `the kernel was not invoked as \`savepoint --verify\`: ${sp.args.join(' ')}`);

      // The kernel's own verdict decides, and every criterion being attested does not soften it.
      assert.equal(r.gates.acceptance.outcome, 'PASS');
      assert.equal(r.outcome, 'FAIL', r.summary);
      assert.equal(r.exitCode, 1);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('state 2 — a stale STATE.json', () => {
  test('refuses at exit 2, in the same words `status` uses, and writes nothing at all', async () => {
    const dir = makeProject({ stale: true });
    try {
      const cli = fakeCli();
      const before = fs.readFileSync(path.join(dir, 'docs', 'derived', 'state', 'tasks.json'));
      const r = await runner.runTask({ dir, cli });

      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.equal(r.freshness.label, 'STALE');

      // The three lines an operator would next see from `status`, reproduced.
      assert.ok(r.summary.includes(runner.WITHHELD_LINE), r.summary);
      assert.ok(r.summary.includes(runner.REGENERATE_LINE), r.summary);
      assert.ok(r.summary.includes(runner.stateWarnLine('STALE', r.freshness.detail)), r.summary);
      assert.match(r.summary, /REFUSED TO START/);
      // P4-M-5: null is the sentinel for "no verdict exists" — a route chosen for a task that was
      // never selected would be a route for nobody, the same reading `tools` (also null here) carries.
      assert.equal(r.route, null, 'a refusal before a task was even selected should not have chosen a route');

      // ⛔ Nothing was spawned, nothing was recorded, nothing was written.
      assert.deepEqual(cli.calls(), [], 'a refusal reached the host');
      assert.equal(exists(path.join(dir, '.respawnpack', 'runtime', 'tasks')), false, 'a refusal wrote a turn directory');
      assert.equal(exists(contractFile(dir)), false, 'a refusal recorded a delegation');
      assert.deepEqual(fs.readFileSync(path.join(dir, 'docs', 'derived', 'state', 'tasks.json')), before);
    } finally { rm(dir); }
  });

  test('⛔ those words are checked against `cmdStatus` itself, not asserted about it', () => {
    // If `status` ever rewords its refusal, this fails here rather than teaching an operator that the
    // runner and the verb they run next disagree about the same condition.
    const kernel = fs.readFileSync(path.join(ROOT, 'kernel', 'respawnpack.js'), 'utf8');
    assert.ok(kernel.includes(runner.WITHHELD_LINE.trimStart()), 'kernel/respawnpack.js no longer prints the WITHHELD line');
    assert.ok(kernel.includes(runner.REGENERATE_LINE.trimStart()), 'kernel/respawnpack.js no longer prints the regenerate line');
    assert.ok(kernel.includes('⚠️ state  : ${fresh.label} — ${fresh.detail}'), 'kernel/respawnpack.js no longer prints the state-label line in this shape');
  });

  test('an absent STATE.json is CANNOT_DETERMINE too — there is no projection to start from', async () => {
    const dir = makeProject();
    try {
      fs.rmSync(path.join(dir, 'docs', 'derived', 'STATE.json'));
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.equal(r.freshness.label, 'ABSENT');
      assert.deepEqual(cli.calls(), []);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('state 3 — an unauthenticated host', () => {
  test('exits 2 with the host\'s verbatim words, leaves the task row untouched, and is never FAIL', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli({ lines: fixtureLines(UNAUTHENTICATED) });
      const queuePath = path.join(dir, 'docs', 'derived', 'state', 'tasks.json');
      const before = fs.readFileSync(queuePath);
      const r = await runner.runTask({ dir, cli });

      assert.equal(r.outcome, 'CANNOT_DETERMINE', 'an unauthenticated host must never be FAIL');
      assert.notEqual(r.outcome, 'FAIL');
      assert.equal(r.exitCode, 2);

      // The host's own sentence, from the captured stream, unedited.
      assert.equal(r.auth.failed, true);
      assert.equal(r.auth.verbatim, 'Not logged in · Please run /login');
      assert.ok(r.summary.includes('Not logged in · Please run /login'), r.summary);
      assert.match(r.summary, /CANNOT_DETERMINE, not FAIL/);

      // The queue is exactly as it was — this runner is not a writer of it (registry.json: writer null).
      assert.deepEqual(fs.readFileSync(queuePath), before);
      assert.equal(readJSON(queuePath).tasks[0].state, 'ready');

      // …and the evidence for the failure is still kept, because that is what it is evidence of.
      const doc = readJSON(turnFile(dir, 'T-1'));
      assert.deepEqual(doc.lines, fixtureLines(UNAUTHENTICATED));
    } finally { rm(dir); }
  });

  test('a timeout is CANNOT_DETERMINE and never a completion — the partial transcript is still kept', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli({ turnOverrides: () => ({ ok: false, code: null, timedOut: true }) });
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.match(r.summary, /the deadline .* passed/);
      assert.equal(r.turn.written, true, 'the partial transcript was not kept');
    } finally { rm(dir); }
  });

  test('a host that will not answer `--version` is CANNOT_DETERMINE before any contract is recorded', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli({ version: { ok: false, version: null, stdout: '', stderr: '', exePath: null, why: 'no `claude` executable was found on PATH' } });
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.ok(r.summary.includes('no `claude` executable was found on PATH'));
      assert.equal(exists(contractFile(dir)), false, 'a contract was opened for a session that never spawned');
      assert.equal(cli.calls().filter((c) => c.fn === 'runTurn').length, 0);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('selection', () => {
  test('a task whose dependsOn is not all done is passed over in favour of the next ready one', async () => {
    const dir = makeProject({
      tasks: [
        taskRow({ id: 'T-blocked', title: 'Waits on T-missing', dependsOn: ['T-missing'] }),
        taskRow({ id: 'T-runnable', title: 'Ready with a satisfied dependency', dependsOn: ['T-done'] }),
        taskRow({ id: 'T-done', title: 'Already finished', state: 'done' }),
      ],
    });
    try {
      const r = await runAttesting(dir);
      assert.equal(r.selection.picked, 'T-runnable');
      assert.deepEqual(r.selection.skipped, [{ id: 'T-blocked', why: 'dependsOn not done: T-missing' }]);
      assert.equal(r.outcome, 'PASS', r.summary);
    } finally { rm(dir); }
  });

  test('a dependsOn naming a row that is not in the queue is NOT satisfied — unknown is not done', () => {
    const sel = runner.selectTask({ tasks: [taskRow({ id: 'T-a', dependsOn: ['T-nowhere'] })] });
    assert.equal(sel.task, null);
    assert.deepEqual(sel.skipped, [{ id: 'T-a', why: 'dependsOn not done: T-nowhere' }]);
  });

  test('no ready task is NOT_APPLICABLE at exit 0, and the passed-over rows are printed', async () => {
    const dir = makeProject({
      tasks: [taskRow({ id: 'T-p', state: 'proposed' }), taskRow({ id: 'T-b', state: 'blocked' })],
    });
    try {
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'NOT_APPLICABLE');
      assert.equal(r.exitCode, 0, 'NOT_APPLICABLE exits 0 — "there was no work" is a complete answer');
      assert.match(r.summary, /skipped {2}T-p: state is "proposed", not "ready"/);
      assert.match(r.summary, /skipped {2}T-b: state is "blocked", not "ready"/);
      assert.deepEqual(cli.calls(), [], 'nothing should have been spawned');
      assert.equal(exists(contractFile(dir)), false);
    } finally { rm(dir); }
  });

  test('--task names a row directly, and refuses when that row is not runnable', async () => {
    const dir = makeProject({
      tasks: [taskRow({ id: 'T-1' }), taskRow({ id: 'T-2', state: 'blocked' })],
    });
    try {
      const picked = await run(dir, { taskId: 'T-2' });
      assert.equal(picked.outcome, 'CANNOT_DETERMINE');
      assert.match(picked.summary, /T-2 is "blocked", not "ready"/);

      const ok = await runAttesting(dir, undefined, { taskId: 'T-1' });
      assert.equal(ok.selection.picked, 'T-1');
      assert.equal(ok.outcome, 'PASS', ok.summary);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('the composed invocation', () => {
  test('⛔ never --bare, never the permission bypass, never --resume', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli });
      const planned = r.turn.plannedArgv;
      const actual = cli.calls().find((c) => c.fn === 'runTurn').opts;
      const built = cliLib.buildTurnArgs({ ...actual, promptVia: 'stdin' });

      for (const argv of [planned, built, r.turn.argv]) {
        assert.ok(!argv.includes('--bare'), `--bare reached the argv: ${argv.join(' ')}`);
        assert.ok(!argv.includes('--dangerously-skip-permissions'), `the permission bypass reached the argv: ${argv.join(' ')}`);
        assert.ok(!argv.includes('--resume'), `--resume reached the argv: ${argv.join(' ')}`);
      }
      // And it IS the headless stream-json shape the supervisor proved, plus the two things P5-N-6b and
      // P4-M-5 add and nothing else: the allow list (an untrusted workspace's settings are ignored) and
      // the routed model — computed the same way the runner computes it, never hard-coded, so a change
      // to the register's own evidence cannot make this fixture drift from what it actually asserts.
      const routedModel = routing.route('coding', REAL_REGISTER, { anthropic: { ok: true, why: 'x' } }, { requiresHooks: true }).model;
      assert.deepEqual(planned, ['--print', '--output-format', 'stream-json', '--verbose',
        '--model', routedModel,
        '--allowedTools', runner.DEFAULT_ALLOWED_TOOLS.join(',')]);
    } finally { rm(dir); }
  });

  test('…and the fence can actually fail: an argv carrying either flag, or a forbidden allow entry, is refused', () => {
    assert.equal(runner.assertArgvIsSafe(['--print', '--bare']).ok, false);
    assert.match(runner.assertArgvIsSafe(['--print', '--bare']).why, /skips hooks, CLAUDE\.md discovery and auto-memory/);
    assert.equal(runner.assertArgvIsSafe(['--print', '--dangerously-skip-permissions']).ok, false);
    assert.equal(runner.assertArgvIsSafe(['--print', '--resume', 'abc']).ok, false);
    assert.match(runner.assertArgvIsSafe(['--print', '--resume', 'abc']).why, /FRESH session by definition/);

    // The opt-in exists, is off by default, and only ever relaxes the one flag it names.
    assert.equal(runner.assertArgvIsSafe(['--dangerously-skip-permissions'], { allowDangerouslySkipPermissions: true }).ok, true);
    assert.equal(runner.assertArgvIsSafe(['--bare'], { allowDangerouslySkipPermissions: true }).ok, false);
    assert.equal(runner.parseArgs([]).allowDangerouslySkipPermissions, false, 'the bypass opt-in is not off by default');
    assert.equal(runner.parseArgs(['--allow-dangerously-skip-permissions']).allowDangerouslySkipPermissions, true);

    /*
     * ⛔ AND THE ALLOW LIST IS JUDGED ON THE ARGV TOO (P5-N-6b), under BOTH spellings the CLI accepts,
     * so a list threaded in by a caller that never went through resolveAllowedTools still meets the
     * floor. The permission bypass opt-in does not lift it: the two say different things, and "the
     * owner chose to skip prompts" was never "the owner chose to grant every shell command".
     */
    const safe = runner.DEFAULT_ALLOWED_TOOLS.join(',');
    assert.equal(runner.assertArgvIsSafe(['--print', '--allowedTools', safe]).ok, true, `the declared default is refused by its own fence: ${safe}`);
    assert.equal(runner.assertArgvIsSafe(['--print', '--allowedTools', 'Read,Bash']).ok, false);
    assert.match(runner.assertArgvIsSafe(['--print', '--allowedTools', 'Read,Bash']).why, /"Bash".*no program named/);
    assert.match(runner.assertArgvIsSafe(['--print', '--allowed-tools', 'Bash(*)']).why, /no program named/);
    assert.match(runner.assertArgvIsSafe(['--print', '--allowedTools', 'Bash(git push origin main)']).why, /grants a push/);
    assert.match(runner.assertArgvIsSafe(['--print', '--allowedTools', 'Bash(git push --force)']).why, /grants a push/);
    assert.match(runner.assertArgvIsSafe(['--print', '--allowedTools', 'Bash(rm -rf *)']).why, /forcing flag/);
    assert.equal(runner.assertArgvIsSafe(['--allowedTools', 'Bash(*)'], { allowDangerouslySkipPermissions: true }).ok, false,
      'the permission-bypass opt-in lifted the tool floor, which is not what it says');

    // The entry-level rule is one rule with two call sites, so the pure half is checked directly too.
    assert.equal(runner.forbiddenToolReason('Edit'), null);
    assert.equal(runner.forbiddenToolReason('Bash(git diff *)'), null);
    assert.equal(runner.forbiddenToolReason('BashOutput'), null, 'a read-only tool whose name starts with Bash was refused');
    assert.match(runner.forbiddenToolReason('Bash()'), /no program named/);
    assert.deepEqual(runner.allowedToolsIn(['--allowedTools', 'Read, Edit ,,Write']), ['Read', 'Edit', 'Write']);
  });

  test('the prompt carries the task record and the boot instruction, and no permission to self-certify', async () => {
    const dir = makeProject();
    try {
      const r = await run(dir, { dryRun: true });
      const p = r.prompt.text;
      for (const needle of ['/respawn', 'T-1', 'Do the bounded thing', 'PLAN.md decision 2.1',
        'Make the bounded thing true.', 'src/a.js', 'the bounded thing is true', 'its test is green']) {
        assert.ok(p.includes(needle), `the composed prompt is missing ${JSON.stringify(needle)}`);
      }
      assert.match(p, /Your own statement that the work is done is NOT the proof/);
      assert.match(p, /contract complete --met/);
    } finally { rm(dir); }
  });

  test('the option list and the parser agree in BOTH directions', () => {
    const help = runner.helpText();
    assert.ok(!help.includes("'use strict'"), 'the help text runs past the end of the header');

    // Every option the parser accepts is documented…
    const withValue = ['--dir', '--task', '--model', '--allowed-tools', '--permission-mode', '--timeout', '--kernel', '--claude-path', '--json'];
    const boolean = ['--dry-run', '--allow-dangerously-skip-permissions'];
    for (const opt of withValue) {
      assert.doesNotThrow(() => runner.parseArgs([opt, 'x']), `${opt} is documented and the parser rejects it`);
      assert.ok(help.includes(opt), `${opt} is accepted and undocumented`);
    }
    for (const opt of boolean) {
      assert.doesNotThrow(() => runner.parseArgs([opt]), `${opt} is documented and the parser rejects it`);
      assert.ok(help.includes(opt), `${opt} is accepted and undocumented`);
    }
    // …and an option nobody implemented is refused rather than silently ignored.
    assert.throws(() => runner.parseArgs(['--bare']), /unknown option/);
    assert.throws(() => runner.parseArgs(['--dangerously-skip-permissions']), /unknown option/,
      'the bypass must not be reachable as a bare flag; only the named opt-in exists');
  });

  test('the delegation argv is the kernel\'s own flag shape, built purely', () => {
    const argv = runner.buildContractArgs({ dir: 'C:/p', task: taskRow() });
    assert.deepEqual(argv, [
      'contract', 'delegate',
      '--task', 'Do the bounded thing',
      '--acceptance', 'the bounded thing is true;its test is green',
      '--dir', 'C:/p',
      '--json',
    ]);
  });

  test('a criterion containing the kernel\'s own separator refuses rather than recording two', async () => {
    const dir = makeProject({ tasks: [taskRow({ acceptance: ['a; and also b'] })] });
    try {
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.match(r.summary, /acceptance criterion\(s\) containing ";"/);
      assert.deepEqual(cli.calls(), []);
      assert.equal(exists(contractFile(dir)), false);
    } finally { rm(dir); }
  });
});

// =================================================================================================
/*
 * P5-N-6b · THE ALLOW LIST, AND WHY IT IS ON THE ARGV.
 *
 * The field run of 2026-09-03, defect D3: the first live run put its permissions in the
 * target's `.claude/settings.json`, and the host discarded every one of them because the workspace had
 * never accepted the trust dialog — telling nobody but the child's stderr. The session could Read, could
 * not Edit or Write the one file in its scope, and diagnosed the denial wrongly because the explanation
 * was on a channel it does not receive. `--allowedTools` is not gated by that dialog, so the list is
 * composed here from a declared source. Three states, and the floor that applies to all three.
 */
describe('the tool allow list — composed onto the argv, where the trust dialog does not reach', () => {
  const allowedToolsOf = (argv) => {
    const i = argv.indexOf('--allowedTools');
    return i < 0 ? null : argv[i + 1];
  };

  test('state 1 — a row with no `tools` gets the DECLARED DEFAULT, and the report, the delegation record and the receipt all carry it', async () => {
    const dir = makeProject();
    try {
      const cli = attesting();
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'PASS', r.summary);

      const expected = [...runner.DEFAULT_ALLOWED_TOOLS];
      assert.equal(r.tools.source, 'default');
      assert.deepEqual(r.tools.list, expected);
      assert.equal(r.tools.refused, null);

      // …on the argv, as ONE comma-joined value, which is how cli.js buildTurnArgs emits it.
      assert.equal(allowedToolsOf(r.turn.plannedArgv), expected.join(','));
      const opts = cli.calls().find((c) => c.fn === 'runTurn').opts;
      assert.deepEqual(opts.allowedTools, expected, 'the turn was run with a different list than the one planned');
      assert.equal(allowedToolsOf(r.turn.argv), expected.join(','));

      // …in the delegation record the runner keeps of what it opened…
      assert.deepEqual(r.contract.allowedTools, expected);
      assert.equal(r.contract.allowedToolsSource, 'default');

      // …and in the receipt on disk, which is where a reader of the verdict finds it.
      const receipt = readJSON(r.receipt.path);
      assert.equal(receipt.tools.source, 'default');
      assert.deepEqual(receipt.tools.allowed, expected);
      assert.equal(receipt.tools.trustRefused, null, 'the host said nothing about trust, and null is how that is said');
      assert.match(r.summary, /allowed   : Read, Edit, Write/);
    } finally { rm(dir); }
  });

  test('…and the declared default is the conservative one: no bare Bash, no push, no force, no install', () => {
    const list = [...runner.DEFAULT_ALLOWED_TOOLS];
    // It can do the job the composed prompt asks for.
    for (const needed of ['Read', 'Edit', 'Write']) assert.ok(list.includes(needed), `the default cannot ${needed}`);
    assert.ok(list.some((e) => e.includes('respawnpack.js contract')), 'the default cannot run the `contract` attestation the prompt instructs');
    for (const g of ['Bash(git status)', 'Bash(git diff *)', 'Bash(git log *)']) assert.ok(list.includes(g), `the default is missing read-only git: ${g}`);

    // And it grants nothing this pack refuses elsewhere. The floor is asserted against the default
    // itself, so a widening of the default cannot pass this suite without also passing the fence.
    for (const entry of list) assert.equal(runner.forbiddenToolReason(entry), null, `the declared default carries an entry its own fence refuses: ${entry}`);
    for (const forbidden of [/\bpush\b/i, /--force/i, /npm (i|install)/i, /pnpm add/i, /\bcommit\b/i, /\breset\b/i]) {
      assert.ok(!list.some((e) => forbidden.test(e)), `the declared default matches ${forbidden}, which no bounded task needs`);
    }
    assert.ok(!list.includes('Bash') && !list.includes('Bash(*)'), 'the declared default grants a shell with no program');
  });

  test('state 2 — a row that declares its own list composes EXACTLY that list, and nothing the default would have added', async () => {
    const declared = ['Read', 'Edit', 'Bash(git status)'];
    const dir = makeProject({ tasks: [taskRow({ tools: declared })] });
    try {
      const cli = attesting();
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'PASS', r.summary);

      assert.equal(r.tools.source, 'task-row');
      assert.deepEqual(r.tools.list, declared);
      assert.equal(allowedToolsOf(r.turn.plannedArgv), 'Read,Edit,Bash(git status)');

      // A row NARROWS as easily as it widens: this one asked for no Write, so no Write was granted.
      assert.ok(!r.tools.list.includes('Write'), 'a row that declared Read+Edit was given Write anyway');
      assert.ok(!allowedToolsOf(r.turn.plannedArgv).includes('Write'));
      assert.deepEqual(r.contract.allowedTools, declared);
      assert.equal(r.contract.allowedToolsSource, 'task-row');
      assert.deepEqual(readJSON(r.receipt.path).tools.allowed, declared);
      assert.equal(readJSON(r.receipt.path).tools.source, 'task-row');

      // And `--allowed-tools` on the command line still outranks the row, because the owner typed it.
      const r2 = await runner.runTask({ dir, cli: attesting(), allowedTools: ['Read'] });
      assert.equal(r2.tools.source, 'option');
      assert.deepEqual(r2.tools.list, ['Read']);
    } finally { rm(dir); }
  });

  test('state 3 — a row whose list carries a forbidden entry is refused BEFORE any process is spawned, at CANNOT_DETERMINE, naming the entry', async () => {
    const cases = [
      ['Bash', /no program named/],
      ['Bash(*)', /no program named/],
      ['Bash(git push *)', /grants a push/],
      ['Bash(rm -rf *)', /forcing flag/],
    ];
    for (const [entry, why] of cases) {
      const dir = makeProject({ tasks: [taskRow({ tools: ['Read', 'Edit', entry] })] });
      try {
        const cli = fakeCli();
        const r = await runner.runTask({ dir, cli });

        assert.equal(r.outcome, 'CANNOT_DETERMINE', `${entry}: ${r.summary}`);
        assert.equal(r.exitCode, 2, `${entry} is FAIL, and "this must not run" is not "this ran and failed"`);
        assert.ok(r.summary.includes(JSON.stringify(entry)), `the summary does not name the offending entry: ${r.summary}`);
        assert.match(r.summary, why);
        assert.equal(r.tools.refused.entry, entry);
        assert.match(r.tools.refused.why, why);

        // ⛔ NOTHING RAN. Not the version probe, not the delegation, not the session — a contract
        // opened for a session that never starts is a dangling obligation for the next reader.
        assert.deepEqual(cli.calls(), [], `${entry}: a process was started for a list the runner refuses`);
        assert.equal(exists(contractFile(dir)), false, `${entry}: a delegation was recorded anyway`);
        assert.equal(exists(turnFile(dir, 'T-1')), false, `${entry}: a turn record was written anyway`);
        assert.equal(r.contract, null);
        assert.equal(r.receipt, null);
      } finally { rm(dir); }
    }
  });

  test('a `tools` that is present but empty is refused by the queue reader, never read as "take the default"', async () => {
    const dir = makeProject({ tasks: [taskRow({ tools: [] })] });
    try {
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.match(r.queue.detail, /tools must be a non-empty array of strings/);
      assert.deepEqual(cli.calls(), []);
    } finally { rm(dir); }
  });

  test('the queue reader and schemas/tasks.schema.json agree about `tools` in both directions', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'tasks.schema.json'), 'utf8'));
    const field = schema.$defs.task.properties.tools;
    assert.ok(field, 'the schema no longer declares `tools`, so the reader accepts a field nobody documents');
    assert.equal(field.minItems, 1, 'the schema and the reader disagree about an empty list');
    assert.ok(!schema.$defs.task.required.includes('tools'), '`tools` became required, which is not additive');

    const doc = { schemaVersion: '1.0.0', tasks: [taskRow({ tools: ['Read'] })] };
    assert.equal(validate(doc, schema).valid, true, 'the schema rejects a row the reader accepts');
    assert.equal(runner.validateTaskQueue(doc).ok, true);
    const empty = { schemaVersion: '1.0.0', tasks: [taskRow({ tools: [] })] };
    assert.equal(validate(empty, schema).valid, false, 'the schema accepts an empty list the reader refuses');
    assert.equal(runner.validateTaskQueue(empty).ok, false);
  });

  test('the host\'s "has not been trusted" sentence is named in words, and changes no verdict', async () => {
    const TRUST = 'Ignoring 9 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. '
      + 'Run Claude Code interactively here once and accept the trust dialog.';
    const dir = makeProject();
    try {
      const r = await runner.runTask({ dir, cli: attesting(undefined, { turnOverrides: () => ({ stderr: `${TRUST}\n` }) }) });

      // The run is unaffected, which is the point of putting the list on the argv in the first place.
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.trust.detected, true);
      assert.equal(r.trust.verbatim, TRUST, 'the host\'s sentence was reworded rather than quoted');

      // It is named in WORDS where an operator reads, not left in the turn record for them to find.
      assert.match(r.summary, /has NOT been trusted/);
      assert.ok(r.summary.includes(TRUST), 'the summary does not carry the host\'s own sentence');
      assert.ok(r.ownerActions.some((a) => a.includes('trust dialog') && a.includes(TRUST)),
        `no owner action names the trust refusal: ${JSON.stringify(r.ownerActions)}`);
      assert.ok(r.claims.some((c) => c.name.includes('did not depend on the workspace\'s trust state') && c.outcome === 'PASS'));
      assert.equal(readJSON(r.receipt.path).tools.trustRefused, TRUST);

      // The bytes are still kept verbatim in the turn record, unchanged by any of this.
      assert.equal(readJSON(turnFile(dir, 'T-1')).stderr, `${TRUST}\n`);
    } finally { rm(dir); }
  });

  test('detectTrustRefusal is quiet when the host says nothing about trust — silence is not a claim of trust', () => {
    assert.deepEqual(runner.detectTrustRefusal(''), { detected: false, verbatim: null });
    assert.deepEqual(runner.detectTrustRefusal(null), { detected: false, verbatim: null });
    assert.deepEqual(runner.detectTrustRefusal('warning: something else entirely\n'), { detected: false, verbatim: null });
    const two = 'first line\nIgnoring 3 permissions.allow entries: this workspace has not been trusted.\nthird line';
    assert.equal(runner.detectTrustRefusal(two).detected, true);
    assert.equal(runner.detectTrustRefusal(two).verbatim, 'Ignoring 3 permissions.allow entries: this workspace has not been trusted.');
  });
});

// =================================================================================================
/*
 * P3-I-2 · DERIVED TOOL ALLOW LISTS; A QUEUE ROW NARROWS ONLY.
 *
 * Class B, "intent over mechanics" (the class audit): a task session's
 * tools derive from the project's DECLARED posture and projectType, with the floor above as the safe
 * default, rather than one fixed list handed to every project regardless of shape. A queue row's own
 * `tools`, when present, may only NARROW what its own project derives — an entry outside the derived
 * set is refused, at the same position (before anything is spawned or recorded) the floor fence
 * already occupied. This replaces P5-N-6b's "present replaces the default" semantics on the owner's
 * stated direction (owner decision 21). Proved on three of the four archetypes
 * `ops/_project-fixtures.mjs` names (ops-infra, greenfield-app, docs-only) plus the undeclared case.
 */
describe('P3-I-2 · derived tool allow lists — a queue row narrows only', () => {
  test('deriveAllowedTools is pure, and the undeclared (and unrecognised) case equals DEFAULT_ALLOWED_TOOLS byte for byte — a fence, not a promise', () => {
    assert.deepEqual(runner.deriveAllowedTools({}).list, runner.DEFAULT_ALLOWED_TOOLS);
    assert.deepEqual(runner.deriveAllowedTools({ posture: null, projectType: null }).list, runner.DEFAULT_ALLOWED_TOOLS);
    assert.deepEqual(runner.deriveAllowedTools({ posture: 'strict', projectType: 'docs-only' }).list, runner.DEFAULT_ALLOWED_TOOLS);
    // An unrecognised projectType must read exactly like an undeclared one — resolveToolDerivation
    // below is what keeps an actually-unrecognised VALUE from ever reaching here, but the pure
    // function's own behaviour is checked directly so the "adds nothing" rule cannot drift.
    assert.deepEqual(runner.deriveAllowedTools({ posture: 'strict', projectType: 'banana' }).list, runner.DEFAULT_ALLOWED_TOOLS);
    assert.deepEqual(runner.deriveAllowedTools({ posture: 'standard', projectType: null }).list, runner.DEFAULT_ALLOWED_TOOLS);
  });

  test('`mature-product` shares `greenfield-app`\'s addition by construction, checked directly rather than only by the safety sweep', () => {
    const greenfield = runner.deriveAllowedTools({ posture: 'standard', projectType: 'greenfield-app' });
    const mature = runner.deriveAllowedTools({ posture: 'standard', projectType: 'mature-product' });
    assert.deepEqual(mature.list, greenfield.list, 'the two archetypes that share the Node-app shape derived different lists');
    for (const entry of runner.NODE_APP_ADDITIONS) assert.ok(mature.list.includes(entry), `mature-product is missing ${entry}`);
  });

  test('every derived combination — every posture x every declared, undeclared or unrecognised projectType — still passes assertArgvIsSafe', () => {
    const postures = ['light', 'standard', 'strict', null];
    const types = [...runner.KNOWN_PROJECT_TYPES, null, 'banana'];
    let checked = 0;
    for (const p of postures) {
      for (const t of types) {
        const d = runner.deriveAllowedTools({ posture: p, projectType: t });
        const argv = ['--print', '--allowedTools', d.list.join(',')];
        const safe = runner.assertArgvIsSafe(argv);
        assert.equal(safe.ok, true, `posture=${p} projectType=${t} derived an unsafe list: ${safe.why}`);
        for (const entry of d.list) assert.equal(runner.forbiddenToolReason(entry), null, `posture=${p} projectType=${t}: ${entry} fails its own fence`);
        checked += 1;
      }
    }
    assert.equal(checked, postures.length * types.length, 'not every combination was actually exercised');
  });

  test('state 1 — ops-infra under a declared `light`: the derived list carries the validators and the two git entries, and the report and receipt carry derivedFrom', async () => {
    const dir = makeProject({ posture: { profile: 'light' }, projectType: 'ops-infra' });
    try {
      const r = await runner.runTask({ dir, cli: attesting() });
      assert.equal(r.outcome, 'PASS', r.summary);

      for (const entry of [...runner.LIGHT_POSTURE_ADDITIONS, ...runner.OPS_INFRA_ADDITIONS]) {
        assert.ok(r.tools.list.includes(entry), `the derived list is missing ${entry}: ${r.tools.list.join(', ')}`);
      }
      assert.equal(r.tools.list.length, runner.DEFAULT_ALLOWED_TOOLS.length + runner.LIGHT_POSTURE_ADDITIONS.length + runner.OPS_INFRA_ADDITIONS.length);
      assert.equal(r.tools.source, 'default');
      assert.deepEqual(r.tools.derivedFrom, { posture: 'light', projectType: 'ops-infra' });
      assert.equal(r.tools.derivation.posture.source, 'DECLARED');

      const receipt = readJSON(r.receipt.path);
      assert.deepEqual(receipt.tools.derivedFrom, { posture: 'light', projectType: 'ops-infra' });
      assert.deepEqual(receipt.tools.allowed, r.tools.list);
    } finally { rm(dir); }
  });

  test('state 1b — a row adding `Bash(rm *)` (not individually forbidden, just outside what this project derives) is refused at exit 2 naming it, before anything is spawned or recorded', async () => {
    const dir = makeProject({
      posture: { profile: 'light' }, projectType: 'ops-infra',
      tasks: [taskRow({ tools: ['Read', 'Edit', 'Bash(git status)', 'Bash(rm *)'] })],
    });
    try {
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'CANNOT_DETERMINE', r.summary);
      assert.equal(r.exitCode, 2, '"this widens past what was derived" is not "this ran and failed"');
      // ⛔ Distinguishing THIS test from "state 3" above: `Bash(rm *)` carries no dash flag, so the
      // FLOOR fence (forbiddenToolReason) does not catch it — only the derived-set check does.
      assert.equal(runner.forbiddenToolReason('Bash(rm *)'), null,
        'this entry must not be caught by the floor fence — the point of this test is the subset check');
      assert.equal(r.tools.refused.entry, 'Bash(rm *)');
      assert.ok(r.summary.includes('Bash(rm *)'), `the summary does not name the offending entry: ${r.summary}`);
      assert.match(r.summary, /outside the list derived for this project/);
      assert.match(r.summary, /never widen it/);

      assert.deepEqual(cli.calls(), [], 'a process was started for a row this runner refuses');
      assert.equal(exists(contractFile(dir)), false, 'a delegation was recorded anyway');
      assert.equal(exists(turnFile(dir, 'T-1')), false, 'a turn record was written anyway');
      assert.equal(r.contract, null);
      assert.equal(r.receipt, null);
    } finally { rm(dir); }
  });

  test('state 2 — greenfield-app under a declared `standard`: a narrowing row (Read, Edit only) is accepted and the receipt shows the narrowed list with derivedFrom', async () => {
    const dir = makeProject({
      posture: { profile: 'standard' }, projectType: 'greenfield-app',
      tasks: [taskRow({ tools: ['Read', 'Edit'] })],
    });
    try {
      const r = await runner.runTask({ dir, cli: attesting() });
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.tools.source, 'task-row');
      assert.deepEqual(r.tools.list, ['Read', 'Edit']);
      assert.ok(!r.tools.list.includes('Write'), 'the row asked for no Write, and Write was granted anyway');
      assert.deepEqual(r.tools.derivedFrom, { posture: 'standard', projectType: 'greenfield-app' });

      const receipt = readJSON(r.receipt.path);
      assert.deepEqual(receipt.tools.allowed, ['Read', 'Edit']);
      assert.equal(receipt.tools.source, 'task-row');
      assert.deepEqual(receipt.tools.derivedFrom, { posture: 'standard', projectType: 'greenfield-app' });
    } finally { rm(dir); }
  });

  test('state 3 — docs-only under a declared `strict`: the floor exactly', async () => {
    const dir = makeProject({ posture: { profile: 'strict' }, projectType: 'docs-only' });
    try {
      const r = await runner.runTask({ dir, cli: attesting() });
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.deepEqual(r.tools.list, [...runner.DEFAULT_ALLOWED_TOOLS]);
      assert.deepEqual(r.tools.derivedFrom, { posture: 'strict', projectType: 'docs-only' });
    } finally { rm(dir); }
  });

  test('the undeclared case, through a real run: no respawnpack.config.json at all derives the floor byte for byte', async () => {
    // gates.gate:false: an ABSENT config also makes the SEPARATE, pre-existing qualityGate reader
    // CANNOT_DETERMINE ("declared no quality gate"), which is correct and unrelated to this test — the
    // derivation this test is about happens earlier, at step 4b, regardless of what the gate reads.
    const dir = makeProject({ omitConfig: true, tasks: [taskRow({ gates: { savepoint: false, gate: false } })] });
    try {
      const r = await runner.runTask({ dir, cli: attesting() });
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.deepEqual(r.tools.list, [...runner.DEFAULT_ALLOWED_TOOLS]);
      assert.deepEqual(r.tools.derivedFrom, { posture: 'strict', projectType: null });
      assert.equal(r.tools.derivation.posture.source, 'DEFAULTED');
    } finally { rm(dir); }
  });

  test('`--allowed-tools` widening on the command line is accepted and recorded as the owner\'s override, even past what this project derives', async () => {
    const dir = makeProject({ posture: { profile: 'strict' }, projectType: 'docs-only' });
    try {
      // Bash(npm test) is not in docs-only/strict's derived list — an owner-typed override may still ask for it.
      const widened = ['Read', 'Edit', 'Write', 'Bash(npm test)'];
      const r = await runner.runTask({ dir, cli: attesting(), allowedTools: widened });
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.tools.source, 'option');
      assert.deepEqual(r.tools.list, widened);
      // What this project WOULD have derived travels with the record regardless — the override just won.
      assert.deepEqual(r.tools.derivedFrom, { posture: 'strict', projectType: 'docs-only' });
      assert.deepEqual(readJSON(r.receipt.path).tools.derivedFrom, { posture: 'strict', projectType: 'docs-only' });
    } finally { rm(dir); }
  });

  test('an unreadable config derives the floor and the report says why', async () => {
    // gates.gate:false so the SEPARATE, pre-existing qualityGate reader — which also reads this file —
    // does not turn an unrelated malformed-config refusal into the story; this test is about the
    // derivation alone, which happens earlier, at step 4b, before that reader ever runs.
    const dir = makeProject({ configRaw: '{ not json', tasks: [taskRow({ gates: { savepoint: false, gate: false } })] });
    try {
      const r = await runner.runTask({ dir, cli: attesting() });
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.deepEqual(r.tools.list, [...runner.DEFAULT_ALLOWED_TOOLS]);
      assert.equal(r.tools.derivation.posture.source, 'UNREADABLE');
      assert.match(r.tools.derivation.posture.detail, /resolves to strict/);
      assert.match(r.tools.derivation.projectType.detail, /could not be read/);
    } finally { rm(dir); }
  });

  test('--dry-run prints the derivation and its source', async () => {
    const dir = makeProject({ posture: { profile: 'light' }, projectType: 'ops-infra' });
    try {
      const r = await runner.runTask({ dir, cli: fakeCli(), dryRun: true });
      assert.equal(r.outcome, 'NOT_APPLICABLE');
      assert.match(r.summary, /derived from: posture light \(DECLARED\), projectType ops-infra/);
    } finally { rm(dir); }
  });

  test('resolveToolDerivation reads projectType through the classified boundary, not a raw read — the config never installed still derives the floor', async () => {
    const dir = makeProject({ omitConfig: true });
    try {
      const d = runner.resolveToolDerivation(dir);
      assert.deepEqual(d.list, runner.DEFAULT_ALLOWED_TOOLS);
      assert.equal(d.posture.source, 'DEFAULTED');
      assert.equal(d.projectType.value, null);
      assert.equal(d.projectType.declared, null);
    } finally { rm(dir); }
  });

  test('the queue reader\'s schema, and the receipt\'s schema, both describe narrowing rather than replacing', () => {
    const tasksSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'tasks.schema.json'), 'utf8'));
    const toolsField = tasksSchema.$defs.task.properties.tools;
    assert.match(toolsField.description, /NARROW/i, 'the schema no longer says a row narrows the derived list');
    assert.doesNotMatch(toolsField.description, /replaces that default entirely/, 'the old "replaces" semantics is still documented');

    const attemptSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'task-attempt.schema.json'), 'utf8'));
    const receiptToolsField = attemptSchema.properties.tools;
    assert.ok(receiptToolsField.required.includes('derivedFrom'), 'the receipt schema does not require tools.derivedFrom');
    assert.deepEqual(receiptToolsField.properties.derivedFrom.properties.posture.enum, ['light', 'standard', 'strict']);
    assert.deepEqual(receiptToolsField.properties.derivedFrom.properties.projectType.enum, [null, ...runner.KNOWN_PROJECT_TYPES]);
  });
});

// =================================================================================================
/*
 * ⛔ P4-M-5 · `taskClass` ON THE QUEUE ROW; THE RUNNER RECORDS ITS ROUTE. Class G, "model-aware
 * orchestration" (the class audit). Proved on the two archetypes the audit names for this change:
 * `greenfield-app` (a coding — here, security-testing — task routed to Claude with the model recorded)
 * and `docs-only` (no installed register, so the pack's own answers). Every fixture below is built with
 * `ops/_project-fixtures.mjs`'s `materialize()`, never a hand-made repository.
 */
describe('P4-M-5 · the route — which model a task session runs on, and why', () => {
  const available = { anthropic: { ok: true, why: 'test: reported available' } };

  test('a row declaring taskClass "security-testing" routes to what core.routing.route() picks, and the receipt carries it (greenfield-app, installed register)', async () => {
    const row = taskRow({ id: 'T-1', taskClass: 'security-testing' });
    const dir = makeArchetypeProject('greenfield-app', { tasks: [row], withRegister: true });
    try {
      const expected = routing.route('security-testing', REAL_REGISTER, available, { requiresHooks: true });
      const cli = attesting(row.acceptance);
      const r = await runner.runTask({ dir, cli });

      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.route.taskClass, 'security-testing');
      assert.equal(r.route.family, 'anthropic');
      assert.equal(r.route.model, expected.model, 'the runner\'s own route disagrees with core.routing.route() called on the same register');
      assert.equal(r.route.rating, expected.rating);
      assert.equal(r.route.effectiveModel, expected.model, 'no --model was passed, so the effective model should be the routed one');
      assert.equal(r.route.overridden, false);
      assert.equal(r.route.register.source, 'installed');
      assert.equal(r.route.register.path, path.join(dir, 'docs', 'reference', 'models', 'capability-register.json'));

      // The session's own argv actually carried the routed model.
      const turns = cli.calls().filter((c) => c.fn === 'runTurn');
      assert.equal(turns.length, 1);
      assert.equal(turns[0].opts.model, expected.model);

      // And the receipt, on disk, carries the same route.
      const receipt = readJSON(r.receipt.path);
      assert.equal(receipt.route.taskClass, 'security-testing');
      assert.equal(receipt.route.family, 'anthropic');
      assert.equal(receipt.route.model, expected.model);
      assert.equal(receipt.route.register.source, 'installed');
    } finally { rm(dir); }
  });

  test('a row with no declared taskClass routes as "coding" (docs-only, this pack\'s own register answers)', async () => {
    const row = taskRow({ id: 'T-1' });
    delete row.taskClass;
    const dir = makeArchetypeProject('docs-only', { tasks: [row] });
    try {
      const expected = routing.route('coding', REAL_REGISTER, available, { requiresHooks: true });
      const r = await runAttesting(dir, row.acceptance);

      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.route.taskClass, 'coding');
      assert.equal(r.route.family, 'anthropic');
      assert.equal(r.route.model, expected.model);
      assert.equal(r.route.register.source, 'pack', 'a docs-only fixture with no installed standards should fall back to the pack\'s own register');
      assert.equal(r.route.register.path, path.join(ROOT, 'spine', 'reference', 'models', 'capability-register.json'));

      const receipt = readJSON(r.receipt.path);
      assert.equal(receipt.route.taskClass, 'coding');
      assert.equal(receipt.route.register.source, 'pack');
    } finally { rm(dir); }
  });

  test('--model on the command line wins over the routed model, and the report and receipt both say so', async () => {
    // "extraction" is the class the real register rates claude-haiku-4-5-20251001 `preferred` on and no
    // other anthropic model above `unproven` — a deliberately different model from the override below,
    // so a bug that ignored the override would be caught by the model id disagreeing, not just a flag.
    const row = taskRow({ id: 'T-1', taskClass: 'extraction' });
    const dir = makeArchetypeProject('greenfield-app', { tasks: [row], withRegister: true });
    try {
      const routedOnly = routing.route('extraction', REAL_REGISTER, available, { requiresHooks: true });
      assert.notEqual(routedOnly.model, 'claude-opus-5', 'the fixture picked an override that happens to equal the routed model — the two states are indistinguishable');

      const cli = attesting(row.acceptance);
      const r = await runner.runTask({ dir, cli, model: 'claude-opus-5' });

      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.route.model, routedOnly.model, 'the ROUTED model should still be recorded, distinct from what actually ran');
      assert.equal(r.route.effectiveModel, 'claude-opus-5');
      assert.equal(r.route.overridden, true);
      assert.match(r.route.overriddenBy, /claude-opus-5/);
      assert.match(r.route.overriddenBy, /command line/);

      const turns = cli.calls().filter((c) => c.fn === 'runTurn');
      assert.equal(turns[0].opts.model, 'claude-opus-5', 'the session did not actually run on the owner\'s override');

      const receipt = readJSON(r.receipt.path);
      assert.equal(receipt.route.model, routedOnly.model);
      assert.equal(receipt.route.effectiveModel, 'claude-opus-5');
      assert.equal(receipt.route.overridden, true);
    } finally { rm(dir); }
  });

  test('an unknown taskClass is refused before any session starts — the nearest bypass to the schema fence', async () => {
    const dir = makeArchetypeProject('docs-only', { tasks: [taskRow({ id: 'T-1', taskClass: 'not-a-real-class' })] });
    try {
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli });

      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.equal(r.queue.status, 'INVALID');
      assert.match(r.queue.detail, /taskClass/);
      assert.match(r.queue.detail, /not-a-real-class/);
      // Every one of routing.TASK_CLASSES is named, so the refusal is actionable rather than a bare "no".
      for (const cls of routing.TASK_CLASSES) assert.match(r.queue.detail, new RegExp(cls));
      assert.deepEqual(cli.calls(), [], 'a queue this malformed must never reach the version probe or a turn');
    } finally { rm(dir); }
  });

  test('⛔ the route never names a non-Claude family, even when a register rates one preferred for the class (anti-drift item 54, at the runner\'s own wiring)', async () => {
    // A minimal register shaped like core/core.test.mjs's own miniRegister() helper — only the fields
    // route() actually reads — with openai rated `preferred` and anthropic merely `capable`.
    const crafted = {
      schemaVersion: '1.0.0', asOf: '2026-09-03',
      taskClasses: routing.TASK_CLASSES,
      families: [
        { id: 'anthropic', promptingPractice: 'docs/reference/models/prompting-anthropic.md' },
        { id: 'openai', promptingPractice: 'docs/reference/models/prompting-openai.md' },
      ],
      models: [
        { id: 'm-openai-preferred', family: 'openai', name: 'm-openai-preferred', status: 'current', ratings: { coding: { rating: 'preferred', evidence: [], why: 'test fixture' } } },
        { id: 'm-anthropic-capable', family: 'anthropic', name: 'm-anthropic-capable', status: 'current', ratings: { coding: { rating: 'capable', evidence: [], why: 'test fixture' } } },
      ],
    };
    const row = taskRow({ id: 'T-1', taskClass: 'coding' });
    const dir = makeArchetypeProject('greenfield-app', { tasks: [row], registerBytes: `${JSON.stringify(crafted, null, 2)}\n` });
    try {
      const r = await runAttesting(dir, row.acceptance);
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.route.family, 'anthropic', 'a hook-bearing task session routed to a family other than the hooked one');
      assert.equal(r.route.model, 'm-anthropic-capable', 'requiresHooks must restrict the CANDIDATE POOL, not just the winning family, before ranking runs');
      assert.notEqual(r.route.model, 'm-openai-preferred');
    } finally { rm(dir); }
  });

  test('a missing or unreadable register does not stop the run, and the receipt says so in words', async () => {
    const row = taskRow({ id: 'T-1' });
    const dir = makeArchetypeProject('docs-only', { tasks: [row], registerBytes: '{ not actually json' });
    try {
      const r = await runAttesting(dir, row.acceptance);
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.route.family, 'anthropic');
      assert.equal(r.route.model, null, 'no register could be read, so route() has nothing to rank and should fall back to the host default');
      assert.equal(r.route.rating, 'unproven');
      assert.equal(r.route.register.source, 'none');
      assert.ok(r.route.register.why && r.route.register.why.length > 10, 'the receipt does not say IN WORDS why no register answered');
      assert.match(r.route.register.why, /capability-register\.json/);

      const receipt = readJSON(r.receipt.path);
      assert.equal(receipt.route.register.source, 'none');
      assert.ok(receipt.route.register.why);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('resolveCapabilityRegisterPath / loadCapabilityRegister (P4-M-5)', () => {
  test('prefers the target\'s own installed copy over this pack\'s, and an explicit candidate list proves "neither resolves"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-register-'));
    try {
      const fromPack = runner.resolveCapabilityRegisterPath(dir);
      assert.equal(fromPack.source, 'pack');
      assert.equal(fromPack.path, path.join(ROOT, 'spine', 'reference', 'models', 'capability-register.json'));

      const installed = path.join(dir, 'docs', 'reference', 'models', 'capability-register.json');
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.writeFileSync(installed, '{"schemaVersion":"1.0.0"}\n');
      const fromInstalled = runner.resolveCapabilityRegisterPath(dir);
      assert.equal(fromInstalled.source, 'installed');
      assert.equal(fromInstalled.path, installed);

      // "neither resolves" — proved with an injected candidate list, the same way resolveKernel's own
      // explicit-override parameter is what makes its non-default paths testable.
      const neither = runner.resolveCapabilityRegisterPath(dir, [
        { path: path.join(dir, 'nope-a.json'), source: 'installed' },
        { path: path.join(dir, 'nope-b.json'), source: 'pack' },
      ]);
      assert.equal(neither.source, 'none');
      assert.equal(neither.path, null);
    } finally { rm(dir); }
  });

  test('loadCapabilityRegister degrades ABSENT and MALFORMED to the same register:null answer, each with its own why', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-register-load-'));
    try {
      const absent = runner.loadCapabilityRegister(dir, {
        candidates: [{ path: path.join(dir, 'nope.json'), source: 'installed' }],
      });
      assert.equal(absent.register, null);
      assert.equal(absent.source, 'none');
      assert.match(absent.why, /no capability register found/);

      const malformedPath = path.join(dir, 'malformed.json');
      fs.writeFileSync(malformedPath, '{ not json');
      const malformed = runner.loadCapabilityRegister(dir, {
        candidates: [{ path: malformedPath, source: 'installed' }],
      });
      assert.equal(malformed.register, null);
      assert.equal(malformed.source, 'none');
      assert.match(malformed.why, /could not be read as JSON/);
      assert.match(malformed.why, /malformed\.json/);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('--dry-run', () => {
  test('prints the composed prompt and spawns nothing — no host, no kernel, no turn record', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli, dryRun: true });
      assert.equal(r.outcome, 'NOT_APPLICABLE');
      assert.equal(r.exitCode, 0);
      assert.ok(r.summary.includes(r.prompt.text), 'the composed prompt was not printed');
      assert.match(r.summary, /nothing was spawned and no contract was recorded/);
      assert.deepEqual(cli.calls(), []);
      assert.equal(exists(contractFile(dir)), false);
      assert.equal(exists(path.join(dir, '.respawnpack', 'runtime', 'tasks')), false);
    } finally { rm(dir); }
  });

  test('a dry run still refuses on a stale projection — it is a dry run of a run that would not happen', async () => {
    const dir = makeProject({ stale: true });
    try {
      const r = await run(dir, { dryRun: true });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
    } finally { rm(dir); }
  });

  test('P4-M-5: prints the route beside the tool derivation', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli();
      const r = await runner.runTask({ dir, cli, dryRun: true });
      assert.equal(r.route.taskClass, 'coding', 'the default row declares no taskClass');
      assert.match(r.summary, /route \(coding\): anthropic/);
      assert.match(r.summary, /register: pack/, 'this pack\'s own checkout has no docs/reference/models/, so the pack fallback should be named');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('the queue reader', () => {
  const ok = (doc) => runner.validateTaskQueue(doc).ok;

  test('accepts the shape schemas/tasks.schema.json declares', () => {
    assert.equal(ok({ schemaVersion: '1.0.0', tasks: [taskRow()] }), true);
    assert.equal(ok({ schemaVersion: '1.0.0', tasks: [] }), true, 'an empty queue is a valid queue with no work');
  });

  test('refuses the three things the schema fences refuse, in the schema\'s own terms', () => {
    // Duplicate ids — the one rule tasks.schema.json says in prose it cannot express.
    const dup = runner.validateTaskQueue({ schemaVersion: '1.0.0', tasks: [taskRow({ id: 'X' }), taskRow({ id: 'X' })] });
    assert.equal(dup.ok, false);
    assert.match(dup.reason, /appears more than once/);

    // An empty acceptance list — the same refusal `contract delegate --acceptance` already makes.
    const empty = runner.validateTaskQueue({ schemaVersion: '1.0.0', tasks: [taskRow({ acceptance: [] })] });
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /non-empty array of strings/);

    // A state outside the enum.
    const bad = runner.validateTaskQueue({ schemaVersion: '1.0.0', tasks: [taskRow({ state: 'nearly' })] });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /state is "nearly"/);
  });

  test('a declared-but-unimplemented schemaVersion is refused rather than read anyway', () => {
    const r = runner.validateTaskQueue({ schemaVersion: '2.0.0', tasks: [] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /implements "1\.0\.0" only/);
  });

  test('an absent or malformed queue is CANNOT_DETERMINE at exit 2, with which one it was', async () => {
    const missing = makeProject({ omitQueue: true });
    try {
      const r = await run(missing);
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.equal(r.queue.status, 'ABSENT');
    } finally { rm(missing); }

    const broken = makeProject();
    try {
      fs.writeFileSync(path.join(broken, 'docs', 'derived', 'state', 'tasks.json'), '{ not json');
      const r = await run(broken);
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.queue.status, 'MALFORMED');
    } finally { rm(broken); }
  });
});

// =================================================================================================
describe('the kernel is reached the way the hooks reach it', () => {
  test('resolveKernel prefers the target\'s own installed kernel over this pack\'s', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-kern-'));
    try {
      const packKernel = runner.resolveKernel(dir);
      assert.equal(packKernel.ok, true);
      assert.equal(packKernel.path, path.join(ROOT, 'kernel', 'respawnpack.js'));

      const installed = path.join(dir, '.claude', 'respawnpack', 'respawnpack.js');
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      fs.writeFileSync(installed, '// a target\'s own kernel\n');
      assert.equal(runner.resolveKernel(dir).path, installed);

      // An explicit override wins over both.
      assert.equal(runner.resolveKernel(dir, packKernel.path).path, packKernel.path);
    } finally { rm(dir); }
  });

  test('the Windows batch-shim technique is still where this runner copied it from', () => {
    /*
     * runner.js cannot require kernel/lib/gate.js (the kernel is a child process to it, never a
     * library), so its spawn is a deliberate second copy of gate.js's. This is what keeps the copy
     * traceable to the file that argues for it: if the original moves or is rewritten, the duplicate
     * stops being "the same technique, applied twice" and becomes folklore nobody can check.
     */
    const gate = fs.readFileSync(path.join(ROOT, 'kernel', 'lib', 'gate.js'), 'utf8');
    for (const needle of ['windowsVerbatimArguments', 'PATHEXT', "'/d', '/s', '/c'"]) {
      assert.ok(gate.includes(needle), `kernel/lib/gate.js no longer contains ${needle} — the runner's copy of its spawn has lost its source`);
    }
    assert.equal(typeof runner.resolveBin, 'function');
  });

  test('a kernel that refuses the delegation is CANNOT_DETERMINE, never FAIL — the task did not run', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli();
      const refusing = {
        kind: 'fake',
        run: () => ({ ok: false, code: 1, stdout: '{"outcome":"FAIL","error":"delegate requires --acceptance"}', stderr: '', json: null, argv: [], kernelPath: 'fake', why: '`contract delegate` exited 1' }),
      };
      const r = await runner.runTask({ dir, cli, kernel: refusing });
      assert.equal(r.outcome, 'CANNOT_DETERMINE', 'a task that never started must not be reported as failed');
      assert.equal(r.exitCode, 2);
      assert.match(r.summary, /was NOT recorded/);
      assert.match(r.summary, /No session was started and the task row is untouched/);
      assert.equal(cli.calls().filter((c) => c.fn === 'runTurn').length, 0);
    } finally { rm(dir); }
  });
});

// =================================================================================================
/*
 * ⛔ THE THREE STATES THIS HALF OWNS. They are not the same three as the block above: those are about
 * whether a session could be STARTED, these are about what it ACHIEVED. Every one of them runs the
 * gates as real child processes in this test's own process tree, and reads the attestation back out
 * of the record the real `contract complete --met` wrote.
 */
describe('the out-of-band gates, the attestation, the receipt and the handoff', () => {
  test('a gate that FAILS is exit 1, and the handoff names which gate and why', async () => {
    const dir = makeProject({ checks: [FAILING_CHECK] });
    try {
      const r = await runAttesting(dir);
      assert.equal(r.outcome, 'FAIL', r.summary);
      assert.equal(r.exitCode, 1);

      const failed = r.gates.checks.find((c) => c.outcome === 'FAIL');
      assert.equal(failed.id, 'qualityGate:unit');
      assert.equal(failed.exitCode, 1);

      // ⛔ The attestation is COMPLETE here, and the run still fails. That is the whole point: the
      // session's claim that it finished is not what decides; the gates are.
      assert.equal(r.gates.acceptance.outcome, 'PASS');
      assert.deepEqual(r.gates.acceptance.unattested, []);

      // The handoff NAMES the gate, and does it as a row rather than as a sentence about one.
      const handoff = readJSON(r.handoff.path);
      assert.ok(handoff.unresolvedQuestions.some((q) => q.includes('gate FAILED: qualityGate:unit')),
        `the handoff does not name the failing gate: ${JSON.stringify(handoff.unresolvedQuestions)}`);
      assert.match(handoff.exactNextAction, /is NOT done: fix qualityGate:unit/);
      const row = handoff.verificationEvidence.find((e) => e.gate === 'qualityGate:unit');
      assert.equal(row.outcome, 'FAIL');
      assert.equal(row.exitCode, 1);

      // …and so do the receipt and the printed summary.
      assert.equal(readJSON(r.receipt.path).outcome, 'FAIL');
      assert.match(r.summary, /FAIL\s+qualityGate:unit/);
    } finally { rm(dir); }
  });

  test('a session that ends with an OPEN, unattested contract is exit 2, and the receipt lists what is unattested', async () => {
    const dir = makeProject();
    try {
      // The fake session does not attest — exactly what a session that stopped halfway leaves behind.
      const r = await run(dir);
      assert.equal(r.outcome, 'CANNOT_DETERMINE', r.summary);
      assert.equal(r.exitCode, 2, 'an open contract must never read as silently done');
      assert.notEqual(r.outcome, 'PASS');

      // Every gate passed, and the run is STILL not done — the two halves are independent.
      assert.equal(r.gates.outcome, 'PASS');
      assert.equal(r.gates.acceptance.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.gates.acceptance.contractStatus, 'OPEN');
      assert.deepEqual(r.gates.acceptance.attested, []);
      assert.deepEqual(r.gates.acceptance.unattested, ['the bounded thing is true', 'its test is green']);
      assert.equal(readJSON(contractFile(dir)).mode, 'delegate', 'the contract should still be open');

      const receipt = readJSON(r.receipt.path);
      assert.equal(receipt.outcome, 'CANNOT_DETERMINE');
      assert.equal(receipt.exitCode, 2);
      assert.equal(receipt.acceptance.outcome, 'CANNOT_DETERMINE');
      assert.deepEqual(receipt.acceptance.unattested, ['the bounded thing is true', 'its test is green']);
      assert.match(r.summary, /unattested: the bounded thing is true/);
    } finally { rm(dir); }
  });

  test('a partial attestation is CANNOT_DETERMINE too — the kernel refuses it, and the runner says which are missing', async () => {
    const dir = makeProject();
    try {
      /*
       * ⛔ The kernel REFUSES a partial `--met`, so a half-finished session cannot even close its
       * contract. This drives that refusal for real and proves the runner reports the same shape.
       */
      const partial = fakeCli({
        duringTurn: (opts) => {
          const out = spawnSync(process.execPath,
            [KERNEL, 'contract', 'complete', '--dir', opts.cwd, '--json', '--met', 'the bounded thing is true'],
            { encoding: 'utf8' });
          assert.equal(out.status, 1, `the kernel accepted a partial attestation: ${out.stdout}${out.stderr}`);
        },
      });
      const r = await runner.runTask({ dir, cli: partial });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.equal(r.gates.acceptance.contractStatus, 'OPEN', 'the kernel left the contract open, as it should');
      assert.deepEqual(r.gates.acceptance.unattested, ['the bounded thing is true', 'its test is green']);
    } finally { rm(dir); }
  });

  test('⛔ a gate that CANNOT RUN is CANNOT_DETERMINE at exit 2, never FAIL at exit 1 (anti-drift item 2)', async () => {
    const dir = makeProject({ checks: [MISSING_CHECK] });
    try {
      const r = await runAttesting(dir);
      const row = r.gates.checks.find((c) => c.id === 'qualityGate:unit');
      assert.equal(row.outcome, 'CANNOT_DETERMINE',
        'a missing tool was reported as a failing check — "could not run" and "ran and failed" get different repairs');
      assert.notEqual(row.outcome, 'FAIL');
      assert.equal(row.exitCode, null, 'a check that never ran cannot have an exit code');
      assert.match(row.detail, /command not found: respawnpack-no-such-tool-exists/);
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.notEqual(r.exitCode, 1);
    } finally { rm(dir); }
  });

  test('an undeclared, empty or unjustified quality gate is CANNOT_DETERMINE — finding nothing is not a pass', async () => {
    const cases = [
      ['no respawnpack.config.json at all', { omitConfig: true }],
      ['a config with no qualityGate key', { qualityGate: null }],
      ['an empty checks list', { qualityGate: { checks: [] } }],
      ['an opt-out with no reason', { qualityGate: { notApplicable: true } }],
    ];
    for (const [label, over] of cases) {
      const dir = makeProject(over);
      try {
        const r = await runAttesting(dir);
        const row = r.gates.checks.find((c) => c.id === 'qualityGate');
        assert.ok(row, `${label}: no qualityGate row was produced at all`);
        assert.equal(row.outcome, 'CANNOT_DETERMINE', `${label}: ${row.detail}`);
        assert.equal(r.exitCode, 2, label);
      } finally { rm(dir); }
    }
  });

  test('a DECLARED opt-out with a reason is NOT_APPLICABLE, and does not stop the run from passing', async () => {
    const dir = makeProject({ qualityGate: { notApplicable: true, reason: 'a docs-only fixture with no toolchain behind it' } });
    try {
      const r = await runAttesting(dir);
      const row = r.gates.checks.find((c) => c.id === 'qualityGate');
      assert.equal(row.outcome, 'NOT_APPLICABLE');
      assert.match(row.detail, /a docs-only fixture with no toolchain behind it/);
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.exitCode, 0);
    } finally { rm(dir); }
  });

  test('⛔ the receipt is written EXACTLY ONCE through the wx primitive — one already there is never overwritten', async () => {
    const dir = makeProject();
    try {
      // Someone (a crashed earlier attempt, a concurrent runner) already claimed this attempt's path.
      const taken = runner.receiptPathFor(dir, 'T-1', 1);
      fs.mkdirSync(path.dirname(taken), { recursive: true });
      fs.writeFileSync(taken, `${JSON.stringify({ kind: 'respawnpack-task-attempt', outcome: 'FAIL', at: 'earlier' }, null, 2)}\n`);
      const before = fs.readFileSync(taken, 'utf8');

      const r = await runAttesting(dir);
      assert.equal(r.receipt.status, 'ALREADY_WRITTEN');
      assert.equal(fs.readFileSync(taken, 'utf8'), before, 'the existing receipt was OVERWRITTEN');
      assert.match(r.receipt.detail, /was NOT overwritten/);
      assert.match(r.receipt.detail, /records "FAIL"/);

      // …and the run degrades: a verdict nobody could record is not a verdict that was delivered.
      assert.equal(r.outcome, 'CANNOT_DETERMINE', r.summary);
      assert.equal(r.exitCode, 2);
    } finally { rm(dir); }
  });

  test('the receipt path is created with wx, not chosen after a read — the primitive IS the decision', () => {
    // The claim above rests on the primitive, so the primitive is named here rather than assumed:
    // core/_io.js createExclusive opens with the exclusive flag, which is what item 40 requires.
    const ioSrc = fs.readFileSync(path.join(ROOT, 'core', '_io.js'), 'utf8');
    assert.ok(ioSrc.includes("fs.openSync(file, 'wx')"), "core/_io.js createExclusive no longer opens with 'wx'");
    assert.ok(fs.readFileSync(path.join(HERE, 'runner.js'), 'utf8').includes('io.createExclusive(file,'),
      'the runner no longer writes its receipt through the exclusive-create primitive');
  });

  test('⛔ a transcript claiming success proves nothing: a forbidden proof token and "all acceptance criteria met" move no verdict', async () => {
    const dir = makeProject();
    try {
      /*
       * The most confident possible session: it says it is done, in the words a reader most wants to
       * believe, and it plants the token core/lifecycle/evidence.js names as never-proof. It does NOT
       * run `contract complete --met`, so the kernel holds no attestation — and that is the only
       * thing that counts here.
       */
      const boastful = fixtureLines(HEALTHY).map((line) => {
        const o = JSON.parse(line);
        if (o.type === 'assistant') {
          o.message.content = [{ type: 'text', text: 'All acceptance criteria met. FORBIDDEN_PROOF_TOKEN: exit_code 0, elapsed 12s, no_error. The task is complete and every gate passed.' }];
        }
        if (o.type === 'result') o.result = 'All acceptance criteria met. FORBIDDEN_PROOF_TOKEN elapsed exit_code';
        return JSON.stringify(o);
      });
      const r = await runner.runTask({ dir, cli: fakeCli({ lines: boastful }) });

      assert.equal(r.outcome, 'CANNOT_DETERMINE', r.summary);
      assert.equal(r.exitCode, 2);
      assert.notEqual(r.outcome, 'PASS');
      assert.equal(r.gates.acceptance.contractStatus, 'OPEN');
      assert.deepEqual(r.gates.acceptance.attested, []);

      // The bytes are still KEPT — the transcript is evidence of what happened, just never of success.
      assert.deepEqual(readJSON(turnFile(dir, 'T-1')).lines, boastful);

      // And the runner says out loud what it did not read.
      const named = r.claims.find((c) => /decided from the gates and the kernel's attestation record only/.test(c.name));
      assert.ok(named, `the runner makes no claim about what it refused to read: ${r.claims.map((c) => c.name).join(' | ')}`);
      assert.equal(named.outcome, 'PASS');

      // Nothing the session said reached the receipt as a reason for anything.
      const receipt = fs.readFileSync(r.receipt.path, 'utf8');
      assert.ok(!receipt.includes('FORBIDDEN_PROOF_TOKEN'), "the session's own text reached the receipt");
      assert.ok(!/all acceptance criteria met/i.test(receipt), "the session's own success claim reached the receipt");
    } finally { rm(dir); }
  });

  test('the `gates.only` seam is RECORDED and not applied — an unimplemented narrowing never narrows', async () => {
    const dir = makeProject({ tasks: [taskRow({ gates: { savepoint: false, gate: true, only: ['test'] } })] });
    try {
      const r = await runAttesting(dir);
      assert.deepEqual(r.gates.scopeRequested, ['test']);
      assert.equal(r.gates.scopeApplied, null, 'a scope nobody implemented was reported as applied');
      // P4-K-08 landed `savepoint --only`/`--skip` and deliberately did NOT wire this seam to it:
      // `gates.only` names project gate ids and `--only` names savepoint stages, and mapping one onto
      // the other is a decision rather than plumbing. The note says so in the present tense.
      assert.match(r.gates.scopeNote, /this runner applies no gate scoping, so the FULL gate ran/);
      // Running MORE than was asked cannot hide a failure, so it does not change the verdict.
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(readJSON(r.receipt.path).gates.scopeRequested[0], 'test');
    } finally { rm(dir); }
  });

  test('an unreadable runtime contract is CANNOT_DETERMINE, never the closed one it resembles', async () => {
    const dir = makeProject();
    try {
      const corrupting = fakeCli({ duringTurn: (opts) => fs.writeFileSync(contractFile(opts.cwd), '{ not json') });
      const r = await runner.runTask({ dir, cli: corrupting });
      assert.equal(r.gates.acceptance.contractStatus, 'MALFORMED');
      assert.equal(r.gates.acceptance.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.deepEqual(r.gates.acceptance.attested, [],
        'an unreadable contract was read as an attested one — collaborate is exactly what a CLOSED delegation looks like');
    } finally { rm(dir); }
  });

  test('the receipt conforms to schemas/task-attempt.schema.json, which is what the registry declares', async () => {
    const dir = makeProject();
    try {
      const r = await runAttesting(dir);
      const doc = readJSON(r.receipt.path);
      const result = validate(doc, JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'task-attempt.schema.json'), 'utf8')));
      assert.equal(result.valid, true, `the receipt this runner writes does not match its own schema:\n  ${result.errors.join('\n  ')}`);
      assert.equal(doc.schemaVersion, runner.TASK_ATTEMPT_SCHEMA_VERSION);
    } finally { rm(dir); }
  });
});

// =================================================================================================
/*
 * ⭐ P5-N-6a · TWO DEFECTS FROM THE FIRST LIVE DOGFOOD RUN (the field run of 2026-09-03).
 *
 * D1: `writeHandoff` built `git.uncommittedFiles` from `tree.files`'s bucket-prefixed KEYS
 * (`hooks/_runtime.js` treeState: `W:` unstaged diff, `S:` staged diff, `U:` untracked content, `C:`
 * current bytes) without de-duplicating by PATH, so a path in more than one bucket — the ordinary case
 * for anything both staged and further edited — was counted twice or more, silently halving
 * `core/state/handoff.js`'s `MAX_LISTED_FILES` budget on a real project.
 *
 * D2: the child's stderr was captured verbatim in the turn record (`persistTurn`) and nowhere else —
 * the printed summary and `report.ownerActions` said only "read the transcript". The dogfood run's one
 * explanatory line, a permission/trust refusal, was on that channel and stayed invisible.
 */
describe('the handoff\'s file list and the child\'s stderr (2026-09-03-task-runner.md)', () => {
  test('D1 — a path both modified and staged appears once in the handoff, and the count matches the distinct set', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli({
        duringTurn: (opts) => {
          // Stage an edit, then edit again without staging: README.md lands in the tree state's `W:`
          // AND `S:` buckets at once, plus its `C:` mirror — three keys for one path, the exact shape
          // that came out as twelve entries for six paths in the dogfood run.
          fs.appendFileSync(path.join(opts.cwd, 'README.md'), 'staged edit\n');
          execFileSync('git', ['-C', opts.cwd, 'add', 'README.md'], { stdio: 'ignore' });
          fs.appendFileSync(path.join(opts.cwd, 'README.md'), 'unstaged edit\n');
        },
      });
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.handoff.status, 'WRITTEN', r.handoff.detail);

      const handoff = readJSON(r.handoff.path);
      const files = handoff.git.uncommittedFiles;
      const occurrences = files.filter((f) => f === 'README.md').length;
      assert.equal(occurrences, 1,
        `README.md is both staged and modified and should appear once; appeared ${occurrences} times: ${JSON.stringify(files)}`);
      assert.equal(new Set(files).size, files.length,
        `the handoff's uncommittedFiles carries a duplicate: ${JSON.stringify(files)}`);
    } finally { rm(dir); }
  });

  test('D2 — the child\'s stderr reaches the report and the printed summary on a non-PASS exit, bounded with the truncation recorded', async () => {
    const dir = makeProject({ checks: [FAILING_CHECK] });
    try {
      const distinctive = 'Ignoring 9 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.';
      const filler = Array.from({ length: 30 }, (_, i) => `some routine diagnostic line ${i + 1}`);
      const longStderr = [...filler, distinctive].join('\n');
      const cli = attesting(taskRow().acceptance, { turnOverrides: () => ({ stderr: longStderr }) });

      const r = await runner.runTask({ dir, cli });
      assert.equal(r.outcome, 'FAIL', r.summary);
      assert.equal(r.exitCode, 1);

      // The JSON report carries a BOUNDED summary — never the full capture, which stays verbatim in
      // the turn record beside it.
      const stderrSummary = r.turn.stderrSummary;
      assert.ok(stderrSummary, 'the report carries no stderrSummary at all');
      assert.equal(stderrSummary.totalLines, filler.length + 1);
      assert.equal(stderrSummary.shownLines, 20);
      assert.equal(stderrSummary.truncated, true, 'a 31-line stderr capped at 20 lines should be reported truncated');
      assert.ok(stderrSummary.text.endsWith(distinctive),
        `the bounded summary does not end with the last (and most informative) line: ${stderrSummary.text}`);
      assert.equal(readJSON(r.turn.file).stderr, longStderr, 'the full capture in the turn record should stay verbatim');

      // And the printed summary, on this non-PASS exit, carries the same line and says it was truncated.
      assert.ok(r.summary.includes(distinctive), `the printed summary does not carry the host's stderr: ${r.summary}`);
      assert.match(r.summary, /host stderr \(last 20 of 31 line\(s\), truncated\)/);
    } finally { rm(dir); }
  });

  test('D2 — stderr claiming success is not read as a verdict either: a forbidden-proof-token line on stderr moves nothing', async () => {
    const dir = makeProject();
    try {
      const boastfulStderr = 'All acceptance criteria met. FORBIDDEN_PROOF_TOKEN: exit_code 0, elapsed 12s, '
        + 'no_error. The task is complete and every gate passed.';
      // No `contract complete --met` runs in this fake session — the point is that the stderr TEXT
      // alone, however confident, must not be what decides anything.
      const r = await runner.runTask({ dir, cli: fakeCli({ turnOverrides: () => ({ stderr: boastfulStderr }) }) });

      assert.equal(r.outcome, 'CANNOT_DETERMINE', r.summary);
      assert.notEqual(r.outcome, 'PASS');
      assert.equal(r.exitCode, 2);
      assert.equal(r.gates.acceptance.contractStatus, 'OPEN');
      assert.deepEqual(r.gates.acceptance.attested, []);

      // The bounded summary still carries the text, as evidence for a person, and it reaches the
      // printed summary too — surfacing it is exactly what D2 asked for…
      assert.equal(r.turn.stderrSummary.text, boastfulStderr);
      assert.equal(r.turn.stderrSummary.truncated, false, 'one short line should not be reported truncated');
      assert.ok(r.summary.includes('FORBIDDEN_PROOF_TOKEN'), 'the stderr text should still reach the printed summary as evidence');

      // …but nothing about what it CLAIMS moved the verdict: the runner still says out loud that
      // completion was decided from the gates and the kernel's attestation record only.
      const named = r.claims.find((c) => /decided from the gates and the kernel's attestation record only/.test(c.name));
      assert.ok(named, `the runner makes no claim about what it refused to read: ${r.claims.map((c) => c.name).join(' | ')}`);
      assert.equal(named.outcome, 'PASS');

      // Neither the receipt nor the handoff carries the session's own stderr text — the JSON report and
      // the printed summary are the only two places D2 asked for it; the handoff's `git.uncommittedFiles`
      // is schema-fenced to an array of strings with no field for it at all.
      assert.ok(!fs.readFileSync(r.receipt.path, 'utf8').includes('FORBIDDEN_PROOF_TOKEN'),
        "the session's stderr reached the receipt, which schemas/task-attempt.schema.json has no field for");
      assert.ok(!fs.readFileSync(r.handoff.path, 'utf8').includes('FORBIDDEN_PROOF_TOKEN'),
        "the session's stderr reached the handoff, which schemas/rollover-handoff.schema.json has no field for");
    } finally { rm(dir); }
  });
});

// =================================================================================================
/*
 * ⭐ P5-N-6c · ONE SPELLING OF THE BUCKET-KEY-TO-PATH RULE.
 *
 * P5-N-6a fixed defect D1 (the field run of 2026-09-03) where it bit, in this file's
 * handoff, by wrapping the mapped keys in a `new Set(...)`. What it left behind was the reason the
 * defect was writable at all: the two-character truncation that turns `W:src.js` into `src.js` was spelled
 * inline HERE and again in `hooks/precompact-ledger-nudge.js`, while `hooks/_runtime.js` — which
 * defines the buckets — had the same rule as a private `pathOf`. Three copies of a rule is three
 * places for it to be got wrong, and only one of them had a test. `pathOf` is now exported and
 * declared, both consumers read it, and the two tests below hold each half of that: the derived list
 * is exactly the distinct set of dirty paths, and neither consumer carries the slice any more.
 */
describe('the bucket-key-to-path rule has one owner (P5-N-6c)', () => {
  test('the handoff lists each dirty path exactly once across every bucket shape — staged-then-modified and untracked alike', async () => {
    const dir = makeProject();
    try {
      const cli = fakeCli({
        duringTurn: (opts) => {
          // Stage an edit and then edit again without staging: README.md lands in `S:`, `W:` and its
          // `C:` mirror at once. `docs/derived/STATE.json` is already the other shape — makeProject
          // writes it AFTER the commit, so it is untracked, which is `U:` plus its own `C:` mirror.
          // Five bucket keys, two paths, and the handoff must say two.
          fs.appendFileSync(path.join(opts.cwd, 'README.md'), 'staged edit\n');
          execFileSync('git', ['-C', opts.cwd, 'add', 'README.md'], { stdio: 'ignore' });
          fs.appendFileSync(path.join(opts.cwd, 'README.md'), 'unstaged edit\n');
        },
      });
      const r = await runner.runTask({ dir, cli });
      assert.equal(r.handoff.status, 'WRITTEN', r.handoff.detail);

      /*
       * ⭐ THE PREMISE IS MEASURED, NOT ASSUMED. A fixture that quietly stopped producing a path in
       * more than one bucket would leave both assertions below trivially true, and a de-duplication
       * test that cannot fail is worse than none. So the buckets are read from the same module the
       * runner reads, through the same `pathOf`, and named.
       */
      const keys = Object.keys(durable.treeState(dir).files);
      const bucketsOf = (p) => keys.filter((k) => durable.pathOf(k) === p).map((k) => k.slice(0, 2)).sort();
      assert.deepEqual(bucketsOf('README.md'), ['C:', 'S:', 'W:'],
        `the fixture no longer puts README.md in three buckets, so the multi-bucket half of this test is vacuous: ${JSON.stringify(keys)}`);
      assert.deepEqual(bucketsOf('docs/derived/STATE.json'), ['C:', 'U:'],
        `the fixture no longer leaves STATE.json untracked, so the untracked half of this test is vacuous: ${JSON.stringify(keys)}`);

      // D1's own assertion, kept: no path is counted twice…
      const files = readJSON(r.handoff.path).git.uncommittedFiles;
      assert.equal(new Set(files).size, files.length,
        `the handoff's uncommittedFiles carries a duplicate: ${JSON.stringify(files)}`);
      // …and the stronger one it could not make: the list IS the distinct set, in full. "No duplicates"
      // would still hold for a list that had silently gained a bucket prefix or lost a path.
      assert.deepEqual([...files].sort(), ['README.md', 'docs/derived/STATE.json'],
        `uncommittedFiles is not the distinct set of the fixture's dirty paths: ${JSON.stringify(files)}`);
    } finally { rm(dir); }
  });

  /*
   * ⭐ THE FENCE, DERIVED FROM SOURCE. The test above proves the list is right today; this one is what
   * stops the rule being re-spelled a third time somewhere no fixture watches. Two-sided, in the
   * pack's usual shape: the definition must still be exported AND declared (drop either and
   * `boot.need()` stops covering the hook), and each consumer must both NOT carry the slice and DO
   * name the shared function — so inlining it again under a different variable fails here too.
   */
  test('neither consumer spells the slice, both read pathOf, and _runtime.js exports what _contracts.js declares', () => {
    assert.equal(typeof durable.pathOf, 'function', 'hooks/_runtime.js no longer exports pathOf');
    assert.equal(durable.pathOf('W:docs/derived/GAPS.md'), 'docs/derived/GAPS.md',
      'pathOf no longer strips exactly the two-character bucket prefix, which is the rule both consumers now delegate to it');
    assert.equal(contracts.CONTRACTS['_runtime.js'].pathOf, 'function',
      'hooks/_contracts.js no longer declares pathOf — undeclared, a _runtime.js that lost it would degrade precompact-ledger-nudge.js silently rather than be caught at need()');

    for (const [rel, binding] of [
      ['adapters/claude-code/task-runner/runner.js', 'durable.pathOf'],
      ['hooks/precompact-ledger-nudge.js', 'rt.pathOf'],
    ]) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!src.includes('k.slice(2)'),
        `${rel} spells the bucket-key slice itself again; the rule belongs to hooks/_runtime.js's pathOf, and a private copy of it is how defect D1 (the field run of 2026-09-03) was writable`);
      assert.ok(src.includes(binding),
        `${rel} no longer reads ${binding}; if the module binding was renamed, re-aim this fence rather than letting it stop checking`);
    }
  });
});
