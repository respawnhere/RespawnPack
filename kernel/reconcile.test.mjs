/*
 * RespawnPack · kernel/reconcile.test.mjs — DF-005 acceptance fixtures.
 *
 * ⛔ THE FINDING, IN ITS OWN WORDS. "The harness task list and the project's gap/gate records drift
 * independently, WRONG IN BOTH DIRECTIONS AT ONCE." Not one list lagging another — two lists each
 * holding items the other has never heard of, while every surface reading either one reports
 * confidently.
 *
 * The literal acceptance fixture is the first test below. It injects a task with no project record
 * AND a project record with no task, in the SAME run, and requires the failure to name BOTH sets.
 * A reconciliation that walks one direction finds half of this and reads as thorough — which is why
 * "compare only task → project" is one of the six mutations this unit had to kill.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const KERNEL = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(KERNEL, 'respawnpack.js');
const require_ = createRequire(import.meta.url);
const reconcileLib = require_(path.join(KERNEL, 'lib', 'reconcile.js'));
const stateLib = require_(path.join(KERNEL, 'lib', 'state.js'));

const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };
const cli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--dir', dir, '--json'], { encoding: 'utf8', timeout: 120000 });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};

function repo(requirements = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-df005-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'd@respawnpack.test'); git('config', 'user.name', 'DF005');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  const sd = path.join(dir, stateLib.STATE_DIR);
  fs.mkdirSync(path.join(sd, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'requirements.json'), JSON.stringify({ schemaVersion: '1.0.0', requirements, gates: {} }, null, 2));
  fs.writeFileSync(path.join(sd, 'goal.json'), '{}');
  git('add', '-A'); git('commit', '--quiet', '-m', 'init');
  return dir;
}

/** A project with a declared JSON task source and a declared JSON project-record source. */
function reconcileProject({ tasks, records, extra = {}, ignore, requirements = [{ id: 'R-1', title: 'one', mandatory: true }] } = {}) {
  const dir = repo(requirements);
  if (tasks !== undefined) fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ schemaVersion: '1.0.0', tasks }, null, 2));
  if (records !== undefined) fs.writeFileSync(path.join(dir, 'gaps.json'), JSON.stringify({ schemaVersion: '1.0.0', gaps: records }, null, 2));
  fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({
    state: {
      removals: { notApplicable: 'fixture: this project has retired nothing' },
      reconcile: {
        tasks: { kind: 'json', path: 'tasks.json', pointer: 'tasks' },
        project: { kind: 'json', path: 'gaps.json', pointer: 'gaps' },
        ...(ignore ? { ignore } : {}),
        ...extra,
      },
    },
  }, null, 2));
  return dir;
}

const run = (dir) => reconcileLib.runReconciliation(dir);
const classes = (r) => [...new Set(r.rows.map((x) => x.klass))].sort();

describe('DF-005 · the task list and the project records', () => {
  test('⛔ THE ACCEPTANCE FIXTURE: drift in BOTH directions at once, and the failure names BOTH sets', () => {
    const dir = reconcileProject({
      tasks: [
        { id: 'T-1', title: 'shared work', status: 'open' },
        { id: 'T-ONLY-TASK', title: 'a task nobody wrote a gap for', status: 'open' },
      ],
      records: [
        { id: 'T-1', title: 'shared work', status: 'open' },
        { id: 'G-ONLY-PROJECT', title: 'a gap no task tracks', status: 'open' },
      ],
    });
    try {
      const r = run(dir);
      assert.equal(r.status, 'DRIFT', `expected DRIFT with disagreement in both directions, got ${r.status}: ${r.why}`);

      // Both classes present. This is the assertion a one-directional implementation cannot pass.
      assert.deepEqual(classes(r), ['PROJECT_RECORD_WITHOUT_TASK', 'TASK_WITHOUT_PROJECT_RECORD']);
      assert.match(r.why, /T-ONLY-TASK/, 'the failure did not name the task with no project record');
      assert.match(r.why, /G-ONLY-PROJECT/, 'the failure did not name the project record with no task');

      // And the agreeing row is NOT reported — a reconciliation that flags everything discriminates nothing.
      assert.equal(r.rows.some((x) => x.id === 'T-1'), false, 'the row both sides agree on was reported as drift');
      assert.deepEqual(r.counts, { tasks: 2, project: 2, drift: 2 });

      const c = r.checks[0];
      assert.equal(c.outcome, 'FAIL');
      assert.equal(c.checked, 4, 'the check must report how many records it actually compared');
    } finally { rm(dir); }
  });

  test('agreement is PASS — without this control, DRIFT everywhere would look correct', () => {
    const dir = reconcileProject({
      tasks: [{ id: 'T-1', title: 'a', status: 'open' }, { id: 'T-2', title: 'b', status: 'done' }],
      records: [{ id: 'T-1', title: 'a', status: 'open' }, { id: 'T-2', title: 'b', status: 'closed' }],
    });
    try {
      const r = run(dir);
      assert.equal(r.status, 'PASS', `two agreeing sources did not PASS: ${r.why}`);
      assert.equal(r.counts.drift, 0);
      assert.equal(r.checks[0].outcome, 'PASS');
      // `done` and `closed` are two words for one state, and the default vocabulary knows it.
      assert.match(r.why, /2 task record\(s\) and 2 project record\(s\) agree/);
    } finally { rm(dir); }
  });

  test('a status conflict on the SAME identifier is its own class', () => {
    const dir = reconcileProject({ tasks: [{ id: 'T-1', status: 'done' }], records: [{ id: 'T-1', status: 'open' }] });
    try {
      const r = run(dir);
      assert.equal(r.status, 'DRIFT');
      assert.deepEqual(classes(r), ['STATUS_CONFLICT']);
      assert.match(r.why, /STATUS_CONFLICT: T-1/);
      assert.match(r.rows[0].detail, /closed in the task source and open in the project records/);
    } finally { rm(dir); }
  });

  test('a duplicate identifier is drift, because every comparison against it is ambiguous', () => {
    const dir = reconcileProject({
      tasks: [{ id: 'T-1', status: 'open' }, { id: 'T-1', status: 'done' }],
      records: [{ id: 'T-1', status: 'open' }],
    });
    try {
      const r = run(dir);
      assert.equal(r.status, 'DRIFT');
      assert.ok(classes(r).includes('DUPLICATE_ID'), `expected DUPLICATE_ID, got ${classes(r)}`);
      assert.match(r.rows.find((x) => x.klass === 'DUPLICATE_ID').detail, /appears more than once/);
    } finally { rm(dir); }
  });

  test('⛔ ZERO records is CANNOT_DETERMINE on either side — never agreement', () => {
    for (const [label, spec] of [
      ['zero tasks', { tasks: [], records: [{ id: 'G-1', status: 'open' }] }],
      ['zero project records', { tasks: [{ id: 'T-1', status: 'open' }], records: [] }],
      ['zero on both sides', { tasks: [], records: [] }],
    ]) {
      const dir = reconcileProject(spec);
      try {
        const r = run(dir);
        assert.equal(r.status, 'CANNOT_DETERMINE', `${label} yielded ${r.status}, not CANNOT_DETERMINE`);
        assert.ok(classes(r).includes('ZERO_RECORDS'), `${label}: the ZERO_RECORDS class was not named`);
        assert.equal(r.checks[0].checked, 0, `${label}: a check that compared nothing must report checked: 0`);
        assert.match(r.why, /is not agreement/, `${label}: the reason did not say why emptiness is not agreement`);
      } finally { rm(dir); }
    }
  });

  test('an unreadable or absent DECLARED source is CANNOT_DETERMINE, never a quiet skip', () => {
    for (const [label, mutate, expected] of [
      ['a declared file that does not exist', (d) => fs.rmSync(path.join(d, 'tasks.json')), /does not exist/],
      ['a declared file that is not JSON', (d) => fs.writeFileSync(path.join(d, 'tasks.json'), '{ not json'), /not parseable JSON/],
      ['a pointer that resolves to nothing', (d) => fs.writeFileSync(path.join(d, 'tasks.json'), JSON.stringify({ schemaVersion: '1.0.0', other: [] })), /nothing at pointer/],
      ['a pointer that is not an array', (d) => fs.writeFileSync(path.join(d, 'tasks.json'), JSON.stringify({ schemaVersion: '1.0.0', tasks: { 'T-1': {} } })), /expected an array of records/],
    ]) {
      const dir = reconcileProject({ tasks: [{ id: 'T-1', status: 'open' }], records: [{ id: 'T-1', status: 'open' }] });
      try {
        mutate(dir);
        const r = run(dir);
        assert.equal(r.status, 'CANNOT_DETERMINE', `${label} yielded ${r.status}`);
        assert.match(r.why, expected, `${label}: the reason did not say what went wrong`);
        assert.ok(classes(r).includes('SOURCE_UNREADABLE'), `${label}: the SOURCE_UNREADABLE class was not named`);
      } finally { rm(dir); }
    }
  });

  test('declared JSON sources cannot escape project authority lexically or through symlinks', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-df005-outside-'));
    fs.writeFileSync(path.join(outside, 'tasks.json'), JSON.stringify({
      schemaVersion: '1.0.0', tasks: [{ id: 'T-1', status: 'open' }],
    }));
    for (const [label, sourcePath, link] of [
      ['absolute path', path.join(outside, 'tasks.json'), false],
      ['parent traversal', '../tasks.json', false],
      ['symlinked parent', 'authority/tasks.json', true],
    ]) {
      const dir = reconcileProject({ tasks: [{ id: 'T-1', status: 'open' }], records: [{ id: 'T-1', status: 'open' }] });
      try {
        if (link) fs.symlinkSync(outside, path.join(dir, 'authority'), process.platform === 'win32' ? 'junction' : 'dir');
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'respawnpack.config.json'), 'utf8'));
        cfg.state.reconcile.tasks.path = sourcePath;
        fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify(cfg, null, 2));
        const r = run(dir);
        assert.equal(r.status, 'CANNOT_DETERMINE', `${label} source was trusted`);
        assert.match(r.why, /outside the project|project-relative|symlink/i, `${label} did not name its authority failure: ${r.why}`);
        assert.ok(classes(r).includes('SOURCE_UNREADABLE'));
      } finally { rm(dir); }
    }
    rm(outside);
  });

  test('an unsupported schemaVersion is its own class, and never passes silently', () => {
    const dir = reconcileProject({ tasks: [{ id: 'T-1', status: 'open' }], records: [{ id: 'T-1', status: 'open' }] });
    try {
      fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ schemaVersion: '9.9.9', tasks: [{ id: 'T-1', status: 'open' }] }));
      const r = run(dir);
      assert.equal(r.status, 'CANNOT_DETERMINE');
      assert.ok(classes(r).includes('UNSUPPORTED_SCHEMA_VERSION'), `expected UNSUPPORTED_SCHEMA_VERSION, got ${classes(r)}`);
      assert.match(r.why, /9\.9\.9/, 'the refusal did not name the version it could not support');
    } finally { rm(dir); }
  });

  test('an unmapped status is UNDETERMINED — it is never assumed to be open or closed', () => {
    const dir = reconcileProject({
      tasks: [{ id: 'T-1', status: 'somebody-invented-this' }],
      records: [{ id: 'T-1', status: 'open' }],
    });
    try {
      const r = run(dir);
      assert.equal(r.status, 'CANNOT_DETERMINE', 'an unrecognised status was silently resolved to one side or the other');
      assert.match(r.why, /somebody-invented-this/);
      assert.match(r.why, /Declare it in openStatuses\/closedStatuses/);
    } finally { rm(dir); }
  });

  test('a native status vocabulary is declarable, and then the two sides agree', () => {
    const dir = reconcileProject({
      tasks: [{ id: 'T-1', status: 'shipped' }],
      records: [{ id: 'T-1', status: 'verified' }],
      extra: { closedStatuses: ['shipped', 'verified'] },
    });
    try {
      assert.equal(run(dir).status, 'PASS', 'a declared vocabulary was not honoured');
    } finally { rm(dir); }
  });

  test('an excluded identifier is explicit and AUDITABLE — reported, never hidden', () => {
    const dir = reconcileProject({
      tasks: [{ id: 'T-1', status: 'open' }, { id: 'T-SKIP', status: 'open' }],
      records: [{ id: 'T-1', status: 'open' }],
      ignore: [{ id: 'T-SKIP', reason: 'tracked in the upstream vendor tracker, not here' }],
    });
    try {
      const r = run(dir);
      assert.equal(r.status, 'PASS', `the declared exclusion did not take effect: ${r.why}`);
      const excluded = r.rows.filter((x) => x.klass === 'EXCLUDED_ID');
      assert.equal(excluded.length, 1, 'the exclusion applied but was never reported — a silent exclusion is an unaudited one');
      assert.match(excluded[0].detail, /tracked in the upstream vendor tracker/);
    } finally { rm(dir); }
  });

  test('an exclusion with NO reason still applies but says so, so the gap stays visible', () => {
    const dir = reconcileProject({
      tasks: [{ id: 'T-1', status: 'open' }, { id: 'T-SKIP', status: 'open' }],
      records: [{ id: 'T-1', status: 'open' }],
      ignore: [{ id: 'T-SKIP' }],
    });
    try {
      assert.match(run(dir).rows.find((x) => x.klass === 'EXCLUDED_ID').detail, /NO reason given/);
    } finally { rm(dir); }
  });

  test('NOT_CONFIGURED and NOT_APPLICABLE are different answers, and neither is PASS', () => {
    const unconfigured = repo();
    try {
      fs.writeFileSync(path.join(unconfigured, 'respawnpack.config.json'), JSON.stringify({ state: { removals: { notApplicable: 'x' } } }));
      const r = run(unconfigured);
      assert.equal(r.status, 'NOT_CONFIGURED');
      assert.equal(r.configured, false);
      assert.equal(r.checks[0].outcome, 'CANNOT_DETERMINE', 'an unconfigured reconciliation reported something other than CANNOT_DETERMINE');
      assert.match(r.checks[0].detail, /not a passing one/);
    } finally { rm(unconfigured); }

    /*
     * ⛔ A PRESENT-BUT-EMPTY KEY IS THE SAME ANSWER, and it used to be a worse one. `"reconcile": {}` —
     * what a founder writes when they start filling this in, and what the installer now seeds as a
     * visible placeholder — fell through to the loaders and returned "a declared source could not be
     * read or interpreted · tasks: no source declared · project: no source declared". That is false
     * twice: nothing was declared, and nothing failed to read. The founder who began configuring got a
     * more confusing answer than the one who ignored it entirely.
     */
    for (const shape of [{}, { note: 'a seeded placeholder that declares nothing' }]) {
      const empty = repo();
      try {
        fs.writeFileSync(path.join(empty, 'respawnpack.config.json'), JSON.stringify({ state: { reconcile: shape } }));
        const e = run(empty);
        assert.equal(e.status, 'NOT_CONFIGURED', `${JSON.stringify(shape)} must read as unconfigured, not as a failed load`);
        assert.doesNotMatch(e.why, /could not be read or interpreted/, 'an empty key reported a read failure for sources that were never declared');
        assert.match(e.checks[0].detail, /not a passing one/, 'the honest guidance must survive — it is the whole value of the branch');
        assert.equal(reconcileLib.surveyReconciliation(empty).state, 'NOT_CONFIGURED', 'doctor called an unconfigured key BROKEN');
      } finally { rm(empty); }
    }

    // ⛔ ONE side declared is NOT that case: a real half-configuration must still name what is missing.
    const half = repo();
    try {
      fs.writeFileSync(path.join(half, 'respawnpack.config.json'),
        JSON.stringify({ state: { reconcile: { tasks: { kind: 'json', path: 'tasks.json' } } } }));
      assert.equal(run(half).status, 'CANNOT_DETERMINE', 'a half-configured reconciliation was waved through as merely unconfigured');
    } finally { rm(half); }

    for (const [label, text, expected] of [
      ['a null source key', JSON.stringify({ state: { reconcile: { tasks: null } } }), /tasks: no source declared/],
      ['malformed JSON', '{ not json', /not parseable JSON/],
      ['notApplicable plus sources', JSON.stringify({ state: { reconcile: { notApplicable: true, reason: 'conflict', tasks: {}, project: {} } } }), /cannot declare notApplicable and source/],
    ]) {
      const malformed = repo();
      try {
        fs.writeFileSync(path.join(malformed, 'respawnpack.config.json'), text);
        const m = run(malformed);
        assert.equal(m.status, 'CANNOT_DETERMINE', `${label} was misclassified as unconfigured or applicable`);
        assert.match(m.why, expected);
        assert.equal(reconcileLib.surveyReconciliation(malformed).state, 'BROKEN', `${label} was not reported broken by doctor`);
      } finally { rm(malformed); }
    }

    const declared = repo();
    try {
      fs.writeFileSync(path.join(declared, 'respawnpack.config.json'),
        JSON.stringify({ state: { reconcile: { notApplicable: true, reason: 'a documentation repository with no task system' } } }));
      const r = run(declared);
      assert.equal(r.status, 'NOT_APPLICABLE');
      assert.match(r.why, /a documentation repository/);
    } finally { rm(declared); }

    const unjustified = repo();
    try {
      fs.writeFileSync(path.join(unjustified, 'respawnpack.config.json'), JSON.stringify({ state: { reconcile: { notApplicable: true } } }));
      assert.equal(run(unjustified).status, 'CANNOT_DETERMINE',
        'an opt-out with no reason was honoured — an opt-out nobody has to justify is one nobody reviews');
    } finally { rm(unjustified); }
  });

  test('the kernel offers its OWN requirements as a project-record source, so the common case needs no adapter', () => {
    const dir = repo([{ id: 'R-1', title: 'one', mandatory: true }, { id: 'R-2', title: 'two', mandatory: true }]);
    try {
      fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ schemaVersion: '1.0.0', tasks: [{ id: 'R-1', status: 'open' }] }));
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({
        state: {
          removals: { notApplicable: 'fixture' },
          reconcile: { tasks: { kind: 'json', path: 'tasks.json', pointer: 'tasks' }, project: { kind: 'requirements' } },
        },
      }));
      const r = run(dir);
      assert.equal(r.status, 'DRIFT');
      assert.deepEqual(classes(r), ['PROJECT_RECORD_WITHOUT_TASK']);
      assert.match(r.why, /R-2/, 'the requirement with no task was not named');
    } finally { rm(dir); }
  });

  test('an unsupported source KIND is refused by name, not silently ignored', () => {
    const dir = repo();
    try {
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({
        state: { reconcile: { tasks: { kind: 'jira' }, project: { kind: 'requirements' } } },
      }));
      const r = run(dir);
      assert.equal(r.status, 'CANNOT_DETERMINE');
      assert.match(r.why, /unsupported source kind "jira"/);
      assert.equal(reconcileLib.surveyReconciliation(dir).state, 'UNSUPPORTED');
    } finally { rm(dir); }
  });

  test('a project adapter supplies its own format, and a critical one without controls is DISCARDED', () => {
    const dir = repo();
    try {
      const tool = path.join(dir, 'tasks-tool.js');
      fs.writeFileSync(tool, 'if(process.argv.includes("--self-test-bad"))process.exit(3);'
        + 'process.stdout.write(JSON.stringify({schemaVersion:"1.0.0",tasks:[{id:"T-1",status:"open"}]}));');
      const cfgWith = (adapter) => fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({
        state: {
          removals: { notApplicable: 'fixture' },
          reconcile: { tasks: adapter, project: { kind: 'json', path: 'gaps.json', pointer: 'gaps' } },
        },
      }));
      fs.writeFileSync(path.join(dir, 'gaps.json'), JSON.stringify({ schemaVersion: '1.0.0', gaps: [{ id: 'T-1', status: 'open' }] }));

      // A working, non-critical adapter: its output is consumed.
      cfgWith({ kind: 'adapter', command: process.execPath, args: [tool], pointer: 'tasks' });
      assert.equal(run(dir).status, 'PASS', 'a working adapter was not consumed');

      // Critical, NO controls: verdict discarded, exactly as the validator adapters do.
      cfgWith({ kind: 'adapter', command: process.execPath, args: [tool], pointer: 'tasks', critical: true });
      const noControls = run(dir);
      assert.equal(noControls.status, 'CANNOT_DETERMINE');
      assert.match(noControls.why, /declared critical but ships no known-good\/known-bad controls/);

      // Critical WITH discriminating controls: consumed again. ⛔ Without this control the previous
      // assertion would be satisfied by an implementation that discards EVERY critical adapter.
      cfgWith({
        kind: 'adapter', command: process.execPath, args: [tool], pointer: 'tasks', critical: true,
        controls: { good: [tool], bad: [tool, '--self-test-bad'] },
      });
      assert.equal(run(dir).status, 'PASS', 'a critical adapter WITH working controls was still discarded');

      // Controls that answer the same for good and bad: discarded (DF-007 #7).
      cfgWith({
        kind: 'adapter', command: process.execPath, args: [tool], pointer: 'tasks', critical: true,
        controls: { good: [tool], bad: [tool] },
      });
      assert.match(run(dir).why, /controls do not discriminate/);
    } finally { rm(dir); }
  });

  test('an adapter that fails or prints garbage is CANNOT_DETERMINE, never an empty task list', () => {
    const dir = repo();
    try {
      const tool = path.join(dir, 'broken.js');
      fs.writeFileSync(path.join(dir, 'gaps.json'), JSON.stringify({ schemaVersion: '1.0.0', gaps: [{ id: 'T-1', status: 'open' }] }));
      const cfgWith = () => fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({
        state: {
          removals: { notApplicable: 'fixture' },
          reconcile: {
            tasks: { kind: 'adapter', command: process.execPath, args: [tool], pointer: 'tasks' },
            project: { kind: 'json', path: 'gaps.json', pointer: 'gaps' },
          },
        },
      }));
      cfgWith();

      fs.writeFileSync(tool, 'process.exit(4);');
      assert.match(run(dir).why, /adapter exited 4/, 'a failing adapter did not report its exit code');
      assert.equal(run(dir).status, 'CANNOT_DETERMINE');

      fs.writeFileSync(tool, 'process.stdout.write("not json at all");');
      assert.match(run(dir).why, /did not print parseable JSON/);

      fs.rmSync(tool);
      assert.match(run(dir).why, /adapter exited 1|did not print parseable JSON|command not found/);
      assert.equal(run(dir).status, 'CANNOT_DETERMINE', 'a missing adapter was treated as a project with no tasks');
    } finally { rm(dir); }
  });

  test('doctor answers "is it wired up", which is not the same question as "do they agree"', () => {
    const dir = reconcileProject({
      tasks: [{ id: 'T-1', status: 'open' }, { id: 'T-2', status: 'open' }],
      records: [{ id: 'T-1', status: 'open' }],
    });
    try {
      /*
       * Configured and running, even though the lists DISAGREE — the row reads ACTIVE with the verdict
       * beside it. Reporting BROKEN here would conflate a working check with a failing project, which
       * is how a project fixes its doctor row by deleting the check.
       */
      const s = reconcileLib.surveyReconciliation(dir);
      assert.equal(s.state, 'ACTIVE');
      assert.equal(s.verdict, 'DRIFT');

      fs.rmSync(path.join(dir, 'tasks.json'));
      assert.equal(reconcileLib.surveyReconciliation(dir).state, 'BROKEN', 'a declared source that vanished did not read as BROKEN');

      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({ state: {} }));
      assert.equal(reconcileLib.surveyReconciliation(dir).state, 'NOT_CONFIGURED');
    } finally { rm(dir); }
  });

  test('doctor SHIPS the row on a real run, in every one of its four states', () => {
    const dir = reconcileProject({ tasks: [{ id: 'T-1', status: 'open' }], records: [{ id: 'T-1', status: 'open' }] });
    try {
      const rowOf = () => (cli(dir, 'doctor').json.rows || []).find((r) => r.check === 'reconcile:tasks');
      assert.ok(rowOf(), 'doctor emits no reconcile:tasks row at all');
      assert.equal(rowOf().label, 'ACTIVE');

      fs.rmSync(path.join(dir, 'gaps.json'));
      assert.equal(rowOf().label, 'BROKEN');

      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({ state: { reconcile: { tasks: { kind: 'jira' }, project: { kind: 'requirements' } } } }));
      assert.equal(rowOf().label, 'UNSUPPORTED');

      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({ state: {} }));
      assert.equal(rowOf().label, 'NOT_CONFIGURED');
    } finally { rm(dir); }
  });

  test('reconciliation runs inside SAVEPOINT and its verdict reaches STATE.json', () => {
    const dir = reconcileProject({
      tasks: [{ id: 'T-1', status: 'open' }, { id: 'T-ONLY-TASK', title: 'a task nobody wrote a gap for', status: 'open' }],
      records: [{ id: 'T-1', status: 'open' }, { id: 'G-ONLY-PROJECT', status: 'open' }],
    });
    try {
      const sp = cli(dir, 'savepoint');
      assert.notEqual(sp.code, 0, 'savepoint passed a project whose task list and gap records disagree');
      const failed = (sp.json.checks || []).find((c) => c.check === 'reconcile');
      assert.ok(failed, 'savepoint produced no reconcile check at all — the comparison is a command nobody runs');
      assert.equal(failed.outcome, 'FAIL');
      assert.match(failed.detail, /T-ONLY-TASK/);
      assert.match(failed.detail, /G-ONLY-PROJECT/);

      // And the VERDICT reaches the compiled projection, so boot can summarise it.
      const st = JSON.parse(fs.readFileSync(path.join(dir, stateLib.STATE_FILE), 'utf8'));
      assert.equal(st.reconciliation.status, 'DRIFT');
      assert.deepEqual(st.reconciliation.counts, { tasks: 2, project: 2, drift: 2 });

      /*
       * ⛔ THE RECORDS THEMSELVES DO NOT TRAVEL. Boot may summarise an ESTABLISHED drift; injecting a
       * project's own task rows into a session as truth is the very thing this comparison exists to
       * catch someone doing.
       */
      const raw = fs.readFileSync(path.join(dir, stateLib.STATE_FILE), 'utf8');
      assert.doesNotMatch(raw, /a task nobody wrote a gap for/, 'task record CONTENT leaked into the durable projection');
      assert.deepEqual(Object.keys(st.reconciliation).sort(), ['counts', 'driftIds', 'driftTruncated', 'status', 'why']);
    } finally { rm(dir); }
  });

  test('the standalone verb reports the same verdict with its own exit code', () => {
    const dir = reconcileProject({ tasks: [{ id: 'T-1', status: 'open' }], records: [{ id: 'T-1', status: 'open' }] });
    try {
      const ok = cli(dir, 'reconcile');
      assert.equal(ok.code, 0, `an agreeing project did not exit 0: ${ok.stderr || ok.stdout}`);
      assert.equal(ok.json.reconciliation, 'PASS');

      fs.writeFileSync(path.join(dir, 'gaps.json'), JSON.stringify({ schemaVersion: '1.0.0', gaps: [] }));
      const undetermined = cli(dir, 'reconcile');
      assert.equal(undetermined.code, 2, 'zero project records did not exit 2 (CANNOT_DETERMINE)');
      assert.equal(undetermined.json.reconciliation, 'CANNOT_DETERMINE');

      fs.writeFileSync(path.join(dir, 'gaps.json'), JSON.stringify({ schemaVersion: '1.0.0', gaps: [{ id: 'G-9', status: 'open' }] }));
      const drift = cli(dir, 'reconcile');
      assert.equal(drift.code, 1, 'established drift did not exit 1');
      assert.equal(drift.json.reconciliation, 'DRIFT');
    } finally { rm(dir); }
  });

  test('no project-specific path is hard-coded into the generic kernel', () => {
    /*
     * The pack ships to strangers. A path belonging to any one project baked in here would be wrong
     * for everybody else AND invisible, because it would simply match nothing and report a clean
     * project. The generic kernel owns invocation and outcome semantics; the project owns its format.
     */
    const src = fs.readFileSync(path.join(KERNEL, 'lib', 'reconcile.js'), 'utf8');
    for (const forbidden of ['validate.py', 'verify_docs', 'verify-docs', 'tools/']) {
      assert.doesNotMatch(src, new RegExp(forbidden),
        `reconcile.js names ${forbidden} — the generic kernel must not carry any one project's paths, not even the documentation's example ones`);
    }
    // And it reads its configuration from the project, rather than looking for well-known filenames.
    assert.match(src, /respawnpack\.config\.json/, 'reconcile.js no longer reads project configuration at all');
    assert.doesNotMatch(src, /readdirSync/, 'reconcile.js discovers sources from disk — a source must be DECLARED, or its absence cannot be reported');
  });
});
