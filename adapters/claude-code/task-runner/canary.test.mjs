/*
 * RespawnPack · adapters/claude-code/task-runner/canary.test.mjs — the task runner's own canary,
 * driven offline, the same way runner.test.mjs drives the runner.
 *
 * ⛔ THE KERNEL IS NOT FAKED, for the same reason runner.test.mjs gives: "the delegation was recorded"
 * and "the criteria were attested" are claims about the KERNEL's own records, and a fake that returned
 * `{ok:true}` would prove only that the fake returns true. `contract delegate` and `contract complete
 * --met` both run as real child processes against a real throwaway git repository that canary.js's own
 * `buildProject()` builds — which is itself under test here, not reimplemented a second time.
 *
 * ⛔ AND THE FIXTURE STREAMS ARE THE SAME ONES runner.test.mjs USES, for the reason its own header
 * gives: all three captured streams are from an UNAUTHENTICATED host, so the captured set is the right
 * evidence for that state and cannot be evidence for a healthy one — the healthy turn replays the
 * synthetic `turn-light.jsonl`.
 *
 * Nothing here touches the repository's own .respawnpack/; every run gets a temp project via
 * canary.js's buildProject(), removed in a `finally`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const require_ = createRequire(import.meta.url);

const canary = require_(path.join(HERE, 'canary.js'));
const runner = require_(path.join(HERE, 'runner.js'));
const cliLib = require_(path.join(ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'cli.js'));

const FIXTURES = path.join(ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'fixtures');
const fixtureLines = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8').split('\n').filter((l) => l.length);

const HEALTHY = 'synthetic/turn-light.jsonl';
const UNAUTHENTICATED = 'captured/07-pathcli-test.jsonl';

const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const KERNEL = path.join(ROOT, 'kernel', 'respawnpack.js');

// =================================================================================================
// The fake process surface — the SAME shape runner.test.mjs and sdk-supervisor/supervisor.test.mjs
// use, so the argv it records is built by cli.js's own buildTurnArgs rather than by this file's idea
// of one.
// =================================================================================================

function fakeCli({ lines = fixtureLines(HEALTHY), version = null, duringTurn = null } = {}) {
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
      if (duringTurn) duringTurn(opts);
      return {
        ok: true, code: 0, signal: null, timedOut: false, spawnError: null,
        stdoutLines: lines.slice(), stdout: lines.join('\n'), stderr: '',
        argv: ['C:/fake/claude.exe', ...cliLib.buildTurnArgs(opts)],
        exePath: 'C:/fake/claude.exe', exeSource: 'fake',
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1,
      };
    },
  };
}

/** The real `contract complete --met`, once per criterion — what a session that finished would run. */
function attest(dir, criteria) {
  const args = [KERNEL, 'contract', 'complete', '--dir', dir, '--json'];
  for (const c of criteria) args.push('--met', c);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// =================================================================================================
describe('state 1 — an echoing attestation passes', () => {
  test('the real kernel attests the token for real, and the canary reports PASS at exit 0', async () => {
    const token = canary.generateToken();
    const { dir } = canary.buildProject({ token });
    try {
      const cli = fakeCli({ duringTurn: (opts) => {
        const out = attest(opts.cwd, [token]);
        assert.equal(out.status, 0, `the fixture attestation did not close the delegation: ${out.stdout}${out.stderr}`);
      } });
      const r = await canary.runCanary({ projectDir: dir, token, cli });

      assert.equal(r.outcome, 'PASS', JSON.stringify(r.claims, null, 2));
      assert.equal(r.exitCode, 0);
      assert.equal(r.mode, 'full');
      assert.equal(r.token, token);

      const echoClaim = r.claims.find((c) => /echoes the generated token/.test(c.name));
      assert.ok(echoClaim, 'no claim named the echo check');
      assert.equal(echoClaim.outcome, 'PASS');
      assert.deepEqual(echoClaim.evidence.attested, [token]);

      // The kernel's own record is what decided this, and it is really there.
      assert.equal(r.runnerReport.gates.acceptance.contractStatus, 'ATTESTED');
      assert.deepEqual(r.runnerReport.gates.acceptance.attested, [token]);
      assert.equal(readJSON(path.join(dir, '.respawnpack', 'runtime', 'contract.json')).mode, 'collaborate');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('state 2 — a missing or wrong token fails', () => {
  test('no attestation at all (the session never ran `contract complete`) is FAIL, not CANNOT_DETERMINE', async () => {
    const token = canary.generateToken();
    const { dir } = canary.buildProject({ token });
    try {
      const r = await canary.runCanary({ projectDir: dir, token, cli: fakeCli() });
      assert.equal(r.outcome, 'FAIL', JSON.stringify(r.claims, null, 2));
      assert.equal(r.exitCode, 1);
      assert.notEqual(r.outcome, 'CANNOT_DETERMINE', 'a session that ran to completion and attested nothing is a settled fact, not an unknown one');

      const echoClaim = r.claims.find((c) => /echoes the generated token/.test(c.name));
      assert.equal(echoClaim.outcome, 'FAIL');
      assert.equal(r.runnerReport.gates.acceptance.contractStatus, 'OPEN');
    } finally { rm(dir); }
  });

  test('a wrong `--met` is refused by the kernel itself, leaves the contract open, and is FAIL', async () => {
    const token = canary.generateToken();
    const { dir } = canary.buildProject({ token });
    try {
      const cli = fakeCli({ duringTurn: (opts) => {
        const out = attest(opts.cwd, ['this is not the token the delegation recorded']);
        assert.equal(out.status, 1, `the kernel accepted a non-matching attestation: ${out.stdout}${out.stderr}`);
      } });
      const r = await canary.runCanary({ projectDir: dir, token, cli });
      assert.equal(r.outcome, 'FAIL', JSON.stringify(r.claims, null, 2));
      assert.equal(r.exitCode, 1);
      assert.equal(r.runnerReport.gates.acceptance.contractStatus, 'OPEN', 'the kernel refused the wrong attestation and left the contract open, as it should');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('state 3 — an unauthenticated host', () => {
  test('is CANNOT_DETERMINE at exit 2, with the host\'s verbatim words, and never FAIL', async () => {
    const token = canary.generateToken();
    const { dir } = canary.buildProject({ token });
    try {
      const r = await canary.runCanary({ projectDir: dir, token, cli: fakeCli({ lines: fixtureLines(UNAUTHENTICATED) }) });

      assert.equal(r.outcome, 'CANNOT_DETERMINE', JSON.stringify(r.claims, null, 2));
      assert.notEqual(r.outcome, 'FAIL');
      assert.equal(r.exitCode, 2);

      const authClaim = r.claims.find((c) => /was authenticated/.test(c.name));
      assert.ok(authClaim, 'no claim named the authentication check');
      assert.equal(authClaim.outcome, 'CANNOT_DETERMINE');
      assert.equal(authClaim.detail, 'Not logged in · Please run /login');
      assert.equal(r.runnerReport.auth.verbatim, 'Not logged in · Please run /login');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('⛔ the fence — the canary never reads transcript text as completion', () => {
  test('a transcript carrying the token and a confident claim, with no attestation, is FAIL', async () => {
    const token = canary.generateToken();
    const { dir } = canary.buildProject({ token });
    try {
      const boastful = fixtureLines(HEALTHY).map((line) => {
        const o = JSON.parse(line);
        if (o.type === 'assistant') {
          o.message.content = [{ type: 'text', text: `${token} — all acceptance criteria met. The task is complete and every gate passed.` }];
        }
        if (o.type === 'result') o.result = `${token} all acceptance criteria met`;
        return JSON.stringify(o);
      });
      // No `duringTurn` — the fake session never runs `contract complete`. The transcript CONTAINS the
      // real token and a confident claim of success; the kernel holds no attestation regardless.
      const r = await canary.runCanary({ projectDir: dir, token, cli: fakeCli({ lines: boastful }) });

      assert.equal(r.outcome, 'FAIL', JSON.stringify(r.claims, null, 2));
      assert.equal(r.exitCode, 1);
      assert.equal(r.runnerReport.gates.acceptance.contractStatus, 'OPEN');

      // The transcript IS kept (evidence of what happened), and none of the canary's own claims quote it.
      assert.ok(fs.existsSync(r.runnerReport.turn.file));
      assert.deepEqual(readJSON(r.runnerReport.turn.file).lines, boastful);
      for (const c of r.claims) {
        assert.ok(!String(c.detail).includes('all acceptance criteria met'), `a claim quoted the session's own text: ${c.detail}`);
      }
    } finally { rm(dir); }
  });

  test('evaluateAttempt reads only report.contract / report.turn.exit / report.auth / report.gates.acceptance', () => {
    // A structural fence on the source itself: the decision function must never dereference the turn's
    // captured lines or stdout — the fields that carry transcript TEXT rather than process facts.
    const src = fs.readFileSync(path.join(HERE, 'canary.js'), 'utf8');
    const body = src.slice(src.indexOf('function evaluateAttempt'), src.indexOf('// --- the two runs'));
    assert.ok(!/turn\.lines|stdoutLines|\.stdout\b/.test(body), 'evaluateAttempt appears to read transcript content, not just structural facts');
  });
});

// =================================================================================================
describe('evaluateAttempt — pure, direct', () => {
  const baseReport = (over = {}) => ({
    contract: { recorded: true },
    turn: { written: true, sessionId: 'sid-1', file: '/tmp/turn-001.json', exit: { code: 0, timedOut: false, spawnError: null }, durationMs: 42 },
    auth: { failed: false },
    gates: { acceptance: { contractStatus: 'ATTESTED', outcome: 'PASS', attested: ['tok-abc'], attestedAt: '2026-09-03T00:00:00.000Z', detail: 'ok' } },
    summary: 'a summary',
    ...over,
  });

  test('an echoing attestation is PASS', () => {
    const { claims, outcome } = canary.evaluateAttempt(baseReport(), 'tok-abc');
    assert.equal(outcome, 'PASS');
    assert.ok(claims.every((c) => c.outcome === 'PASS'));
  });

  test('a non-matching attested criterion is FAIL, not CANNOT_DETERMINE', () => {
    const report = baseReport({ gates: { acceptance: { contractStatus: 'OPEN', outcome: 'CANNOT_DETERMINE', attested: [], attestedAt: null, detail: 'still open' } } });
    const { outcome } = canary.evaluateAttempt(report, 'tok-abc');
    assert.equal(outcome, 'FAIL');
  });

  test('no recorded delegation at all is CANNOT_DETERMINE', () => {
    const report = baseReport({ contract: null, turn: null, gates: null });
    const { claims, outcome } = canary.evaluateAttempt(report, 'tok-abc');
    assert.equal(outcome, 'CANNOT_DETERMINE');
    assert.equal(claims[0].name, 'the runner recorded a delegation and captured one session turn');
  });

  test('an authentication failure is CANNOT_DETERMINE even when the turn exit code is 0', () => {
    const report = baseReport({ auth: { failed: true, verbatim: 'Not logged in · Please run /login', from: 'assistant' } });
    const { claims, outcome } = canary.evaluateAttempt(report, 'tok-abc');
    assert.equal(outcome, 'CANNOT_DETERMINE');
    const authClaim = claims.find((c) => /authenticated/.test(c.name));
    assert.equal(authClaim.detail, 'Not logged in · Please run /login');
  });

  test('a timed-out turn is CANNOT_DETERMINE, never FAIL — a timeout is not a completion signal', () => {
    const report = baseReport({ turn: { written: true, sessionId: 'sid-1', file: '/tmp/turn-001.json', exit: { code: null, timedOut: true, spawnError: null } } });
    const { outcome } = canary.evaluateAttempt(report, 'tok-abc');
    assert.equal(outcome, 'CANNOT_DETERMINE');
    assert.notEqual(outcome, 'FAIL');
  });

  test('case and whitespace around the token are folded, exactly as the kernel folds them', () => {
    const report = baseReport({ gates: { acceptance: { contractStatus: 'ATTESTED', outcome: 'PASS', attested: ['  TOK-ABC  '], attestedAt: 'now', detail: 'ok' } } });
    const { outcome } = canary.evaluateAttempt(report, 'tok-abc');
    assert.equal(outcome, 'PASS');
  });
});

// =================================================================================================
describe('--probe-only', () => {
  test('reuses the sdk-supervisor\'s own probe: a healthy handshake is PASS at exit 0', async () => {
    const r = await canary.runProbe({ cli: fakeCli() });
    assert.equal(r.mode, 'probe');
    assert.equal(r.outcome, 'PASS', JSON.stringify(r.claims, null, 2));
    assert.equal(r.exitCode, 0);
    assert.equal(r.probe.structural.compactCommandPresent, true);
  });

  test('an unauthenticated host is CANNOT_DETERMINE at exit 2 with the host\'s verbatim words', async () => {
    const r = await canary.runProbe({ cli: fakeCli({ lines: fixtureLines(UNAUTHENTICATED) }) });
    assert.equal(r.outcome, 'CANNOT_DETERMINE');
    assert.equal(r.exitCode, 2);
    assert.match(r.claims[0].detail, /Not logged in/);
  });

  test('never spawns a task session — only runVersion and the one handshake turn are called', async () => {
    const cli = fakeCli();
    await canary.runProbe({ cli });
    const fns = cli.calls().map((c) => c.fn);
    assert.deepEqual(fns, ['runVersion', 'runTurn']);
  });
});

// =================================================================================================
describe('the throwaway project canary.js builds', () => {
  test('buildProject installs a working kernel copy the runner\'s own resolveKernel finds first', () => {
    const token = canary.generateToken();
    const { dir, row } = canary.buildProject({ token });
    try {
      assert.equal(row.id, canary.TASK_ID);
      assert.deepEqual(row.acceptance, [token]);
      const installed = path.join(dir, '.claude', 'respawnpack', 'respawnpack.js');
      assert.ok(fs.existsSync(installed), 'the minimal kernel was not installed into .claude/respawnpack/');
      const resolved = runner.resolveKernel(dir, null);
      assert.equal(resolved.ok, true);
      assert.equal(resolved.path, installed, 'resolveKernel did not prefer the throwaway project\'s own installed kernel');
      // And it actually runs: `respawnpack.js contract delegate` against a project with no open contract
      // is a legitimate call; here we just prove the copy is executable Node, not a broken partial copy.
      const out = spawnSync(process.execPath, [installed, 'status', '--dir', dir, '--json'], { encoding: 'utf8' });
      assert.notEqual(out.status, null, `the installed kernel copy could not even be spawned: ${out.error}`);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('CLI surface', () => {
  test('parseArgs accepts --probe-only and refuses an unknown flag', () => {
    assert.equal(canary.parseArgs(['--probe-only']).probeOnly, true);
    assert.throws(() => canary.parseArgs(['--not-a-flag']));
  });

  test('generateToken is distinctive and prefixed', () => {
    const a = canary.generateToken();
    const b = canary.generateToken();
    assert.notEqual(a, b);
    assert.ok(a.startsWith(canary.TOKEN_PREFIX));
  });

  test('helpText documents every option parseArgs accepts', () => {
    const help = canary.helpText();
    for (const flag of ['--probe-only', '--project-dir', '--model', '--allowed-tools', '--permission-mode', '--timeout', '--kernel', '--claude-path', '--json']) {
      assert.ok(help.includes(flag), `helpText does not document ${flag}`);
    }
  });
});
