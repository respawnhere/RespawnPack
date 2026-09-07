/*
 * RespawnPack · kernel/kernel.test.mjs — acceptance fixtures for the state kernel.
 *
 * These are not unit tests of convenience. Each `describe` block reproduces a REQUIRED ACCEPTANCE
 * SCENARIO from the hardening brief, which in turn came from an observed dogfood failure. Where a
 * scenario names a specific behavior ("savepoint fails", "gate becomes incomplete, never easier"), the
 * assertion is on that behavior, not on an implementation detail that happens to produce it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import * as stateLib from './lib/state.js';
import * as render from './lib/render.js';
import * as removalsLib from './lib/removals.js';
import { OUTCOME, result, verdictFromCount, rollup, exitCodeFor } from './lib/outcome.js';
import { normalise, liveClause, occurrences, discriminates, numericClaims } from './lib/assert.js';
// P2-P-2: the written proposal is checked against its declared schema the same way a founder's own
// tooling would, rather than trusting the writer to have gotten its own contract right.
import { validate } from '../schemas/validate.mjs';
/*
 * ⛔ THE PROJECT ARCHETYPES COME FROM THE ONE SHARED HELPER (P1-F-0), NOT FROM A FIFTH HAND-ROLLED
 * VOCABULARY. P2-P-1's fixtures below are ops-infra, greenfield-app, docs-only and mature-product trees
 * materialised by ops/_project-fixtures.mjs, so "an ops-infra repository" means the same thing in this
 * suite as it does in every other one.
 */
// The one shared vocabulary for "what does a docs-only / ops-infra / greenfield-app project look like"
// (task F-0). P2-O-3's register fixtures are real archetypes rather than a fourth hand-rolled tree, so
// the claim being tested is about a CLASS of project and not about one shape.
// P2-I-3 / P2-Q-2: the four project archetypes, materialised deterministically; AWS_EXAMPLE_KEY is the
// fixture's own sample credential, so a secret-scan case never types a real-looking key of its own.
import { materialize, materialize as materializeProject, materialize as materializeFixture, AWS_EXAMPLE_KEY } from '../ops/_project-fixtures.mjs';

const KERNEL = path.dirname(fileURLToPath(import.meta.url));
// The candidate store's own module: P2-O-3's fixtures build records with it, and assert on ITS
// unverified-lead marker rather than a second copy of the string typed into this file.
const candidatesLib = createRequire(import.meta.url)('../core/memory/candidates.js');
const CLI = path.join(KERNEL, 'respawnpack.js');
// P2-K-13: `sweep-scratch` moved out of the kernel into its own ops script — see the relocation
// describe block below and ops/sweep-scratch.mjs's own header.
const OPS_SWEEP_SCRATCH = path.join(path.dirname(KERNEL), 'ops', 'sweep-scratch.mjs');

// --- fixture helpers ------------------------------------------------------------------------------

function project({ requirements = [], gates = {}, evidence = [], goal = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-kernel-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'k@respawnpack.test'); git('config', 'user.name', 'Kernel');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'init');

  const sd = path.join(dir, stateLib.STATE_DIR);
  fs.mkdirSync(path.join(sd, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'requirements.json'), JSON.stringify({ schemaVersion: '1.0.0', denominatorVersion: 'test-1', requirements, gates }, null, 2));
  fs.writeFileSync(path.join(sd, 'goal.json'), JSON.stringify(goal, null, 2));
  for (const e of evidence) fs.writeFileSync(path.join(sd, 'evidence', e.file), JSON.stringify(e.body, null, 2));
  /*
   * ⛔ THE KILLED-FEATURE CONTRACT IS DECLARED NOT APPLICABLE HERE, EXPLICITLY (Scenario L). A base
   * fixture has retired nothing, and saying so is a one-line decision. Leaving it unconfigured would
   * make every savepoint in this file CANNOT_DETERMINE — which is the CORRECT verdict for a project
   * where nothing enforces "killed features are never re-added", and is exactly why the declaration is
   * required rather than inferred. Scenario L's own fixtures overwrite this config with a real one.
   */
  /*
   * ⛔ AND DF-005 RECONCILIATION IS DECLARED NOT APPLICABLE FOR THE SAME REASON. A base fixture has no
   * task system, and an unconfigured reconciliation is CANNOT_DETERMINE — the correct verdict for a
   * project where nothing compares the task list to the gap records, and precisely why the opt-out has
   * to be DECLARED with a reason rather than inferred from finding no task file. The DF-005 fixtures
   * overwrite this with a real configuration.
   */
  /*
   * ⛔ AND SO ARE THE TWO DRIFT-CHECK SOURCES, FOR THE THIRD TIME AND THE SAME REASON. `routeSource` and
   * `codeTruth` were bare keys with no way to say "this project has none", so an absent one had no
   * verdict at all and an older installer's `<set ROUTE_SOURCE>` template read as an answer. They are
   * now the same three-state contract as the two above: an absent key is UNDECIDED and blocks release
   * readiness, so a base fixture declares them rather than leaving every savepoint in this file
   * CANNOT_DETERMINE. Scenario O's fixtures overwrite this config to exercise the states directly.
   */
  /*
   * ⛔ AND qualityGate, FOR THE FOURTH TIME AND THE SAME REASON (P-004). It takes the identical
   * {notApplicable, reason} opt-out state.removals and state.reconcile already use, and an absent key is
   * UNDECIDED exactly like the other three — so a base fixture declares it too, rather than leaving every
   * doctor call in this file reporting onboarding INCOMPLETE for a contract nothing here is testing.
   * Scenario O's and Scenario P's fixtures overwrite this config to exercise the states directly.
   */
  fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({
    routeSource: { notApplicable: true, reason: 'base fixture: this project serves no routes' },
    codeTruth: { notApplicable: true, reason: 'base fixture: no token, copy or schema source outranks prose here' },
    qualityGate: { notApplicable: true, reason: 'base fixture: quality checks are outside the scope of these tests' },
    state: {
      removals: { notApplicable: 'base fixture: this project has retired nothing' },
      reconcile: { notApplicable: true, reason: 'base fixture: this project has no task system to reconcile against' },
    },
  }, null, 2));
  return { dir, head: () => git('rev-parse', 'HEAD').trim(), git };
}

// A well-formed, fully-controlled evidence artifact. Tests mutate ONE field to isolate a rejection.
const evidence = (rev, reqs, over = {}) => ({
  schemaVersion: '1.0.0', tool: 'fixture', toolVersion: '1.0.0',
  sourceRevision: rev, buildRevision: rev, project: 'fixture', timestamp: '2026-08-03T00:00:00Z',
  requirements: reqs, verdict: 'pass', channel: 'served', claimType: 'served-boundary tested',
  positiveControl: { ran: true, passed: true }, negativeControl: { ran: true, detected: true },
  nonClaims: ['does not cover the admin route'], qualifiedBy: 'independent', ...over,
});

const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };
const cli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--dir', dir, '--json'], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};
// Same shape as `cli`, driving ops/sweep-scratch.mjs directly — it takes no verb argument.
const opsSweepScratch = (dir, ...args) => {
  const r = spawnSync(process.execPath, [OPS_SWEEP_SCRATCH, ...args, '--dir', dir, '--json'], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};

/*
 * ⭐ P2-P-1 · THE ROW EVERY FIXTURE THAT DECLARES NO PROVENANCE NOW CARRIES.
 *
 * `lineage` is the tenth savepoint stage, and a project with no `docs/derived/state/lineage.json` gets a
 * NOT_APPLICABLE row rather than silence — the same discipline every other declared-or-not contract in
 * this kernel follows, and the exact row owner decision 22 requires so that no installed target's exit
 * code moves on upgrade. It is spelled ONCE here because three separate byte-identical row captures
 * below assert on it, and three hand-typed copies of one string is the drift this pack keeps arguing
 * against. Written out in full, not built from the module, so a change to the wording of a row a reader
 * sees still has to be made deliberately in this file.
 */
const LINEAGE_UNDECLARED_ROW = {
  outcome: 'NOT_APPLICABLE',
  check: 'lineage:declaration',
  detail: 'no docs/derived/state/lineage.json — this project declares no provenance, so nothing here is claimed about where its copies come from. Declare sources and derivations there to have them verified.',
  checked: null,
  subject: 'docs/derived/state/lineage.json',
};

// --- the four-outcome contract --------------------------------------------------------------------

describe('four-outcome contract · zero parsed claims is never a pass', () => {
  test('a checker that examined nothing returns CANNOT_DETERMINE', () => {
    const v = verdictFromCount({ check: 'x', checked: 0, failures: [], subject: 'nothing' });
    assert.equal(v.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(v.detail, /agrees with everything/);
  });

  test('the shared constructor refuses PASS with an explicit zero count', () => {
    assert.throws(() => result(OUTCOME.PASS, 'empty', 'nothing ran', { checked: 0 }), /zero work cannot pass/);
    assert.doesNotThrow(() => result(OUTCOME.PASS, 'non-counting', 'a binary check ran'));
    assert.doesNotThrow(() => result(OUTCOME.PASS, 'counting', 'one subject checked', { checked: 1 }));
  });

  test('CANNOT_DETERMINE gets its own exit code, distinct from FAIL and PASS', () => {
    assert.equal(exitCodeFor(OUTCOME.PASS), 0);
    assert.equal(exitCodeFor(OUTCOME.FAIL), 1);
    assert.equal(exitCodeFor(OUTCOME.CANNOT_DETERMINE), 2);
  });

  test('rollup takes the worst outcome; CANNOT_DETERMINE outranks PASS', () => {
    assert.equal(rollup([{ outcome: 'PASS' }, { outcome: 'CANNOT_DETERMINE' }]), 'CANNOT_DETERMINE');
    assert.equal(rollup([{ outcome: 'CANNOT_DETERMINE' }, { outcome: 'FAIL' }]), 'FAIL');
    assert.equal(rollup([]), 'CANNOT_DETERMINE', 'having run nothing determines nothing');
  });
});

// --- the DF-007 assertion helper ------------------------------------------------------------------

describe('DF-007 · the assertion helper, against the seven failures that produced it', () => {
  test('#4 case mismatch: "A name absent" vs "a name absent"', () => {
    assert.equal(occurrences('A name absent from the map', 'a name absent').length, 1);
  });

  test('#5 a sentence wrapped across a line is still one sentence', () => {
    assert.equal(occurrences('...text says Fewer than\nall five are covered', 'fewer than all five').length, 1);
  });

  test('markdown emphasis does not hide content', () => {
    assert.equal(normalise('**bold** and `code` and [link](http://x)'), 'bold and code and link');
    assert.equal(occurrences('the **gauntlet** is live', 'the gauntlet is live').length, 1);
  });

  test('#2/#3 a doc may QUOTE the claim it retires — the retraction is not an assertion', () => {
    const corrected = 'G2 passes. Superseded: *not started* (was wrong for a day).';
    assert.equal(occurrences(corrected, 'not started', { scope: 'live' }).length, 0,
      'the retired phrase sits after a retiring marker and must not count as a live assertion');
    assert.equal(occurrences(corrected, 'not started', { scope: 'any' }).length, 1,
      'but it is still findable when you explicitly ask for any occurrence');
  });

  test('a genuinely live claim is still caught (the known-bad control for the check above)', () => {
    assert.equal(occurrences('G2 — not started', 'not started').length, 1);
  });

  test('#7 a check that answers the same for known-good and known-bad is rejected', () => {
    const nonDiscriminating = () => 0;              // the symbol grep that returned 0 for valid names too
    const discriminating = (s) => (s === 'bad' ? 1 : 0);
    assert.equal(discriminates(nonDiscriminating, 'good', 'bad').ok, false);
    assert.equal(discriminates(discriminating, 'good', 'bad').ok, true);
  });

  test('liveClause returns nothing for a wholly struck-through line', () => {
    assert.equal(liveClause('~~this whole row is retired~~'), '');
  });

  test('numeric claims are read from live clauses only', () => {
    // The DF-011 shape verbatim: a corrected row necessarily QUOTES the count it retires.
    const claims = numericClaims('62 conformant rows today. Superseded: 66 conformant rows.', { labels: ['conformant rows'] });
    assert.equal(claims.length, 1, 'the retired 66 must not be read as a live claim');
    assert.equal(claims[0].number, 62);
  });

  test('a numeric claim split across a line break is still one claim', () => {
    const claims = numericClaims('the register holds 48\nmandatory requirements in total', { labels: ['mandatory requirements'] });
    assert.equal(claims.length, 1, 'line wrapping hid the claim — DF-007 #5 all over again');
    assert.equal(claims[0].number, 48);
  });
});

// --- Scenario E -----------------------------------------------------------------------------------

describe('Scenario E · a stale count in derived prose fails savepoint', () => {
  test('inject a plausible stale count → FAIL; restore → PASS', () => {
    const p = project({
      requirements: [
        { id: 'R-1', title: 'one', mandatory: true },
        { id: 'R-2', title: 'two', mandatory: true },
        { id: 'R-3', title: 'three', mandatory: true },
      ],
    });
    try {
      const ev = path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'e1.json');
      fs.writeFileSync(ev, JSON.stringify(evidence(p.head(), ['R-1'])));

      // Render the truth first.
      let r = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(r.code, 0, `expected a clean savepoint, got ${r.code}: ${r.stdout}${r.stderr}`);

      const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      const truth = fs.readFileSync(cont, 'utf8');
      assert.match(truth, /1 conformant/, 'sanity: the rendered doc should state the real count');

      // The DF-011 injection: a plausible integer, exactly the kind judgement skims past.
      fs.writeFileSync(cont, truth.replace('1 conformant', '3 conformant'));

      r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 1, 'savepoint reported success while the handoff was stale — this is DF-011');
      const failed = r.json.checks.filter((c) => c.outcome === 'FAIL');
      assert.ok(failed.some((c) => /says 3 conformant, source says 1/.test(c.detail)),
        `expected the disagreement to be named; got ${JSON.stringify(failed)}`);

      // Restore and it passes again — the known-good control for this very check.
      fs.writeFileSync(cont, truth);
      r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 0, 'restoring the true count must clear the failure, or the check discriminates nothing');
    } finally { rm(p.dir); }
  });

  test('a derived doc with no parseable claims returns CANNOT_DETERMINE, not MATCH', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const v = render.verifyRendered('# Continuity\n\nNothing numeric here at all.\n', stateLib.compile(p.dir).state, { file: 'CONTINUITY.md' });
      assert.equal(v.outcome, OUTCOME.CANNOT_DETERMINE);
      assert.equal(v.checked, 0);
    } finally { rm(p.dir); }
  });

  /*
   * ⛔ THE ONE CASE WHERE "NO CLAIMS" IS A COMPLETE ANSWER — AND THE PAIR THAT KEEPS IT HONEST.
   *
   * A documentation-only repository (that target's exact shape: no requirements.json) compiles a state whose
   * every count is a legitimate zero, and the renderer omits zero-valued lines, so the document
   * truthfully carries no numeric claims. Reporting CANNOT_DETERMINE there left `savepoint --verify`
   * unable to return 0 for such a project no matter what its owner did — field run §1's "success is
   * unreachable, so the honest outcome of every savepoint is blocked" surviving every other fix.
   *
   * The test ABOVE is the control this one needs: same empty document, but a state carrying a non-zero
   * count, and it must still be CANNOT_DETERMINE. That is the case where the renderer's labels and this
   * verifier's labels have drifted and a document full of unchecked numbers would sail through. Without
   * the pair, "relax when nothing parsed" would be indistinguishable from deleting the check.
   */
  test('no claims AND an all-zero state is NOT_APPLICABLE — a non-zero state with no claims still is not', () => {
    const empty = project({ requirements: [] });
    try {
      const state = stateLib.compile(empty.dir).state;
      const v = render.verifyRendered('# Continuity\n\nNothing numeric here at all.\n', state, { file: 'CONTINUITY.md' });
      assert.equal(v.outcome, OUTCOME.NOT_APPLICABLE,
        'a docs-only project could never reach exit 0 — nothing it can do makes a document assert a count its state does not have');
      assert.equal(v.checked, 0, 'NOT_APPLICABLE must not claim to have checked anything');
      assert.match(v.detail, /every count in the compiled state is zero/, 'the verdict must say which of the two empty cases this is');

      // The discriminating half: one non-zero count and the same empty document is undetermined again.
      const drifted = { ...state, counts: { ...(state.counts || {}), mandatory: 3 } };
      assert.equal(render.verifyRendered('# Continuity\n\nNothing numeric here at all.\n', drifted, { file: 'CONTINUITY.md' }).outcome,
        OUTCOME.CANNOT_DETERMINE,
        'a state with real counts and a document that parsed none of them is label drift — relaxing THAT would delete the check');
    } finally { rm(empty.dir); }
  });
});

// --- Scenario F -----------------------------------------------------------------------------------

describe('Scenario F · a shared mistaken assumption survives dev checks and is rejected by qualification', () => {
  test('high-risk row with implementer-qualified unit-test evidence stops at candidate', () => {
    const p = project({ requirements: [{ id: 'R-HIGH', title: 'auth boundary', mandatory: true, risk: 'high' }] });
    try {
      // The implementation and its unit test encode the same defect. Both are green.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'dev.json'),
        JSON.stringify(evidence(p.head(), ['R-HIGH'], { claimType: 'unit-tested', qualifiedBy: 'implementer' })));

      const { state } = stateLib.compile(p.dir);
      const r = state.requirements.find((x) => x.id === 'R-HIGH');
      assert.equal(r.status, 'candidate', 'the implementing context qualified its own high-risk work');
      assert.match(r.why, /independent qualification required/);
      assert.equal(state.counts.conformant, 0, 'a candidate must not be counted as conformant');
    } finally { rm(p.dir); }
  });

  test('the same row becomes conformant once independently qualified', () => {
    const p = project({ requirements: [{ id: 'R-HIGH', mandatory: true, risk: 'high' }] });
    try {
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'ind.json'),
        JSON.stringify(evidence(p.head(), ['R-HIGH'], { qualifiedBy: 'independent', claimType: 'served-boundary tested' })));
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.requirements.find((x) => x.id === 'R-HIGH').status, 'conformant');
    } finally { rm(p.dir); }
  });

  test('a low-risk row does NOT require independent qualification — ceremony scales with risk', () => {
    const p = project({ requirements: [{ id: 'R-LOW', mandatory: true, risk: 'normal' }] });
    try {
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'dev.json'),
        JSON.stringify(evidence(p.head(), ['R-LOW'], { claimType: 'unit-tested', qualifiedBy: 'implementer' })));
      assert.equal(stateLib.compile(p.dir).state.requirements[0].status, 'conformant');
    } finally { rm(p.dir); }
  });
});

// --- Scenario G -----------------------------------------------------------------------------------

describe('Scenario G · evidence stops counting when the revision moves', () => {
  test('evidence passing at revision A contributes zero at revision B', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const revA = p.head();
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'a.json'), JSON.stringify(evidence(revA, ['R-1'])));
      assert.equal(stateLib.compile(p.dir).state.counts.conformant, 1, 'sanity: fresh evidence counts');

      fs.writeFileSync(path.join(p.dir, 'src.ts'), 'export const changed = true;\n');
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'advance to revision B');

      const { state } = stateLib.compile(p.dir);
      assert.equal(state.counts.conformant, 0, 'stale evidence kept crediting the project after the source moved');
      assert.equal(state.counts.staleEvidence, 1);
      assert.match(state.evidence.rejected[0].reason, /stale revision/);
    } finally { rm(p.dir); }
  });

  test('the shared loader rejects unbound, claimless, malformed and non-discriminating evidence', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const rev = p.head();
      const dir = path.join(p.dir, stateLib.STATE_DIR, 'evidence');
      fs.writeFileSync(path.join(dir, 'unbound.json'), JSON.stringify(evidence(rev, ['R-1'], { sourceRevision: undefined })));
      fs.writeFileSync(path.join(dir, 'claimless.json'), JSON.stringify(evidence(rev, [])));
      fs.writeFileSync(path.join(dir, 'malformed.json'), '{ not json');
      fs.writeFileSync(path.join(dir, 'nocontrol.json'), JSON.stringify(evidence(rev, ['R-1'], { negativeControl: { ran: true, detected: false } })));
      fs.writeFileSync(path.join(dir, 'partial.json'), JSON.stringify(evidence(rev, ['R-1'], { partial: true })));
      fs.writeFileSync(path.join(dir, 'unknownschema.json'), JSON.stringify(evidence(rev, ['R-1'], { schemaVersion: '9.9.9' })));

      const reasons = stateLib.compile(p.dir).state.evidence.rejected.map((r) => r.reason).join(' | ');
      for (const expected of [/unbound/, /names no requirements/, /malformed/, /controls do not discriminate/, /partial battery/, /unknown schemaVersion/]) {
        assert.match(reasons, expected);
      }
      assert.equal(stateLib.compile(p.dir).state.counts.conformant, 0);
    } finally { rm(p.dir); }
  });
});

// --- Scenario H -----------------------------------------------------------------------------------

describe('Scenario H · omitting a mandatory row makes a gate incomplete, never easier', () => {
  test('removing a declared requirement row fails the gate instead of shrinking the denominator', () => {
    const reqs = [
      { id: 'R-1', mandatory: true, gate: 'G1' },
      { id: 'R-2', mandatory: true, gate: 'G1' },
      { id: 'R-3', mandatory: true, gate: 'G1' },
    ];
    const gates = { G1: { title: 'gate one', requires: ['R-1', 'R-2', 'R-3'] } };
    const p = project({ requirements: reqs, gates });
    try {
      const rev = p.head();
      for (const id of ['R-1', 'R-2', 'R-3']) {
        fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', `${id}.json`), JSON.stringify(evidence(rev, [id])));
      }
      let g = stateLib.compile(p.dir).state.gates[0];
      assert.equal(g.status, 'COMPLETE');
      assert.equal(g.denominator, 3);

      // Now omit R-3 from the evaluator's input — the exact move R-4 forbids.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'requirements.json'),
        JSON.stringify({ schemaVersion: '1.0.0', requirements: reqs.filter((r) => r.id !== 'R-3'), gates }));

      const { state, findings } = stateLib.compile(p.dir);
      g = state.gates[0];
      assert.equal(g.status, 'INCOMPLETE_MISSING_ROWS', 'omission made the gate PASS more easily');
      assert.equal(g.denominator, 3, 'the denominator must come from the approved source, not from surviving rows');
      assert.deepEqual(g.missingRows, ['R-3']);
      assert.ok(findings.some((f) => f.outcome === 'FAIL' && f.check === 'gate:G1'));
    } finally { rm(p.dir); }
  });
});

// --- Scenario I -----------------------------------------------------------------------------------

describe('Scenario I · blockers stop dependent work only', () => {
  test('two blocked mandatory requirements, one ready → the scheduler picks the ready one', () => {
    const p = project({
      requirements: [
        { id: 'R-1', title: 'needs a vendor key', mandatory: true, blockedBy: ['vendor API key not provisioned'], missingAuthority: 'owner must provision the key' },
        { id: 'R-2', title: 'depends on R-1', mandatory: true, dependsOn: ['R-1'] },
        { id: 'R-3', title: 'ready to go', mandatory: true },
      ],
      goal: { goal: 'ship the toolkit' },
    });
    try {
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.projectBlocked, false, 'one blocked item is not a blocked project');
      const next = state.nextUnblockedWork.map((n) => n.id);
      assert.deepEqual(next, ['R-3'], `scheduler should choose only the ready task; got ${next}`);
      assert.ok(state.transitivelyBlocked.includes('R-2'), 'a dependent of a blocked row is blocked too');
      assert.equal(state.blockers[0].missingAuthority, 'owner must provision the key', 'the exact missing authority must be recorded');
    } finally { rm(p.dir); }
  });

  test('when every mandatory row is blocked, the project IS blocked', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true, blockedBy: ['external'] }] });
    try {
      assert.equal(stateLib.compile(p.dir).state.projectBlocked, true);
    } finally { rm(p.dir); }
  });
});

// --- milestone vs goal ----------------------------------------------------------------------------

describe('milestone completion is not goal completion', () => {
  test('a complete milestone with outstanding mandatory work leaves the goal incomplete', () => {
    const p = project({
      requirements: [{ id: 'R-1', mandatory: true }, { id: 'R-2', mandatory: true }],
      goal: { goal: 'the whole project', milestone: 'corrective wave 3', milestoneComplete: true },
    });
    try {
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'a.json'), JSON.stringify(evidence(p.head(), ['R-1'])));
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.milestoneComplete, true);
      assert.equal(state.goalComplete, false, 'a corrective milestone was reported as the project goal — the run-B confusion');

      const md = render.renderContinuity(state, null);
      assert.match(md, /Project goal:.*⏳ not complete/);
      assert.match(md, /Active milestone:.*✅ complete/);
    } finally { rm(p.dir); }
  });
});

// --- counts are derived ---------------------------------------------------------------------------

describe('counts are a function of rows, never carried forward', () => {
  test('adding a row changes every rendered count without anyone editing prose', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const before = render.renderContinuity(stateLib.compile(p.dir).state, null);
      assert.match(before, /1 mandatory requirements/);

      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'requirements.json'),
        JSON.stringify({ schemaVersion: '1.0.0', requirements: [{ id: 'R-1', mandatory: true }, { id: 'R-2', mandatory: true }] }));

      const after = render.renderContinuity(stateLib.compile(p.dir).state, null);
      assert.match(after, /2 mandatory requirements/);
      assert.equal(render.verifyRendered(after, stateLib.compile(p.dir).state).outcome, OUTCOME.PASS);
    } finally { rm(p.dir); }
  });

  test('the human note survives regeneration; the generated block does not', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const s = stateLib.compile(p.dir).state;
      const first = render.renderContinuity(s, null);
      const withNote = first.replace('_(no human note)_', 'Waiting on the vendor key before R-1 can move.');
      const second = render.renderContinuity(s, withNote);
      assert.match(second, /Waiting on the vendor key/, 'a derived doc that cannot carry a human note gets hand-edited anyway');
    } finally { rm(p.dir); }
  });

  test('a hand-edit inside the generated block is detected (RA-4)', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const s = stateLib.compile(p.dir).state;
      const good = render.renderContinuity(s, null);
      assert.equal(render.driftFromGenerated(good, good, 'CONTINUITY.md').outcome, OUTCOME.PASS);
      const tampered = good.replace('1 mandatory requirements', '7 mandatory requirements');
      assert.equal(render.driftFromGenerated(tampered, good, 'CONTINUITY.md').outcome, OUTCOME.FAIL);
    } finally { rm(p.dir); }
  });
});

// --- migration ------------------------------------------------------------------------------------

describe('migration · adopting the kernel must not destroy a hand-authored handoff', () => {
  const LEGACY = '# CONTINUITY\n\nWe are mid-refactor on the export path. Do not touch the billing\n' +
    'adapter until the vendor confirms the schema. Ask Priya before regenerating fixtures.\n';

  test('without --write it is a PREVIEW: nothing is changed, and the check says CANNOT_DETERMINE', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      fs.mkdirSync(path.dirname(cont), { recursive: true });
      fs.writeFileSync(cont, LEGACY);

      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(fs.readFileSync(cont, 'utf8'), LEGACY, 'a check-only run rewrote a hand-authored file');
      assert.ok(r.json.migrations.some((m) => !m.applied), 'the preview must be reported, not silently skipped');
      const c = r.json.checks.find((x) => x.check.includes('CONTINUITY.md'));
      assert.equal(c.outcome, 'CANNOT_DETERMINE', 'the kernel must not claim to have verified prose it does not own');
    } finally { rm(p.dir); }
  });

  test('with --write the original is archived verbatim and its prose lands in the protected NOTE', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      fs.mkdirSync(path.dirname(cont), { recursive: true });
      fs.writeFileSync(cont, LEGACY);

      cli(p.dir, 'savepoint', '--verify', '--write');

      const archive = path.join(p.dir, 'docs', 'derived', '_archive', 'CONTINUITY.pre-kernel.md');
      assert.equal(fs.readFileSync(archive, 'utf8'), LEGACY, 'archive-never-delete is the pack’s own rule');

      const now = fs.readFileSync(cont, 'utf8');
      assert.match(now, /mid-refactor on the export path/, 'the human prose must survive into the NOTE block');
      assert.match(now, /Ask Priya/);
      assert.match(now, /CONTINUITY\.pre-kernel\.md/, 'the note must point at the full original');
      assert.match(now, /RESPAWNPACK:GENERATED/, 'and the file is now kernel-rendered');
    } finally { rm(p.dir); }
  });

  test('migration is idempotent — a second --write archives nothing new and keeps the note', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      fs.mkdirSync(path.dirname(cont), { recursive: true });
      fs.writeFileSync(cont, LEGACY);

      cli(p.dir, 'savepoint', '--verify', '--write');
      const afterFirst = fs.readFileSync(cont, 'utf8');
      const archiveAfterFirst = fs.readFileSync(path.join(p.dir, 'docs', 'derived', '_archive', 'CONTINUITY.pre-kernel.md'), 'utf8');

      const second = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(second.json.migrations.length, 0, 'a migrated file must not be migrated again');
      assert.equal(fs.readFileSync(path.join(p.dir, 'docs', 'derived', '_archive', 'CONTINUITY.pre-kernel.md'), 'utf8'), archiveAfterFirst,
        're-running must never clobber the archived original');
      assert.match(fs.readFileSync(cont, 'utf8'), /mid-refactor on the export path/, 'the note must survive regeneration');
      // Only the generation timestamp may differ between the two renders.
      assert.equal(
        afterFirst.replace(/_Generated [^_]*_/, ''),
        fs.readFileSync(cont, 'utf8').replace(/_Generated [^_]*_/, ''),
      );
    } finally { rm(p.dir); }
  });

  /*
   * ⛔ THE MIGRATION HAD TO BECOME A DOOR, NOT A ONE-WAY DOOR — and the tests above are exactly why
   * that was not obvious. They prove the migration is careful: verbatim archive, never clobbered,
   * idempotent. It was still, in the field, never run. the 2026-08-07 field run §1: "`savepoint --verify --write`
   * performs a one-way migration … That is not something an agent should do unprompted at session end,
   * so it never happens, so exit 2 persists forever." Every safety property above was real and none of
   * them was legible as an undo, which is the only form of reassurance that actually moves anyone.
   */
  test('restore-derived puts the pre-kernel original back, previews first, and keeps the archive', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      const archive = path.join(p.dir, 'docs', 'derived', '_archive', 'CONTINUITY.pre-kernel.md');
      fs.mkdirSync(path.dirname(cont), { recursive: true });
      fs.writeFileSync(cont, LEGACY);
      cli(p.dir, 'savepoint', '--verify', '--write');
      const migrated = fs.readFileSync(cont, 'utf8');
      assert.match(migrated, /RESPAWNPACK:GENERATED/, 'precondition: the file is kernel-rendered before we undo it');

      // 1. Preview changes nothing and reports both byte counts, so the cost of the undo is known first.
      const preview = cli(p.dir, 'restore-derived', 'CONTINUITY.md');
      assert.equal(preview.json.outcome, 'PASS');
      assert.equal(preview.json.applied, false);
      assert.equal(fs.readFileSync(cont, 'utf8'), migrated, 'a preview wrote to the file — the undo became its own one-way door');
      assert.match(preview.json.detail, /PREVIEW ONLY/);
      assert.equal(preview.json.wouldRestoreBytes, LEGACY.length, 'the preview must say how many bytes come back');

      // 2. --write restores the original byte-for-byte.
      const applied = cli(p.dir, 'restore-derived', 'CONTINUITY.md', '--write');
      assert.equal(applied.json.outcome, 'PASS');
      assert.equal(applied.json.applied, true);
      assert.equal(fs.readFileSync(cont, 'utf8'), LEGACY, 'the restore did not reproduce the hand-authored original exactly');

      // 3. The archive survives, so this is repeatable rather than a single undo charge.
      assert.equal(fs.readFileSync(archive, 'utf8'), LEGACY, 'restoring deleted the archive — archive-never-delete runs in both directions');
      cli(p.dir, 'savepoint', '--verify', '--write');
      assert.match(fs.readFileSync(cont, 'utf8'), /mid-refactor on the export path/, 're-migrating after a restore must find the same original');
    } finally { rm(p.dir); }
  });

  test('restore-derived refuses a file with no archive, and an unknown name, without writing', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      fs.mkdirSync(path.dirname(cont), { recursive: true });
      fs.writeFileSync(cont, LEGACY);

      // Never migrated → nothing archived → there is no original to put back, and saying so beats
      // "restored" over a file the kernel never touched.
      const noArchive = cli(p.dir, 'restore-derived', 'CONTINUITY.md', '--write');
      assert.equal(noArchive.json.outcome, 'CANNOT_DETERMINE');
      assert.match(noArchive.json.error, /never migrated/);
      assert.equal(fs.readFileSync(cont, 'utf8'), LEGACY, 'a refused restore still wrote to the file');

      const unknown = cli(p.dir, 'restore-derived', 'PRODUCT.md', '--write');
      assert.equal(unknown.json.outcome, 'CANNOT_DETERMINE');
      assert.match(unknown.json.error, /CONTINUITY\.md/, 'the refusal must name what IS restorable');
    } finally { rm(p.dir); }
  });
});

// --- the note budget ------------------------------------------------------------------------------

/*
 * ⛔ THE NOTE BUDGET USED TO BE A SILENT CUT. On a real target (2026-08-16) a ~4,500-char note in the
 * protected NOTE block came back from `savepoint --write` at exactly 1,200 chars, mid-word, five bullets
 * gone — no marker, no console line, no `checks[]` row, and the savepoint reported PASS. render.js's own
 * header says "nothing is silently lost"; the one function carrying the human's words broke it. These
 * fixtures pin the corrected contract: the budget stays, the overflow is visible in the block, archived
 * verbatim, and reported as a `note:budget` FAIL — and the two nearest bypasses (a note exactly at budget;
 * a note measured in UTF-16 units that a naive cut would split through a surrogate pair) behave.
 */
describe('note budget · an over-budget NOTE block is never cut silently', () => {
  const NOTE_RE = new RegExp(`${render.NOTE_OPEN}([\\s\\S]*?)${render.NOTE_CLOSE}`);
  const noteOf = (doc) => { const m = NOTE_RE.exec(doc); return m ? m[1].trim() : null; };
  const wrap = (note) => `${render.NOTE_OPEN}\n${note}\n${render.NOTE_CLOSE}\n`;
  // ⛔ THE LITERAL IS DELIBERATE. `budget` is the budget as shipped, so each test's FIRST assertion — the
  // one that names the defect — fails on the pre-fix module at the silent cut itself, not at a missing
  // export. The first test fences the literal against what render.js exports, once the defect is proven.
  const budget = 1200;
  // A realistic over-budget note: many prose bullets, no numeric claim under a label the verifier knows,
  // so the only thing under test is the budget. ~4.8k chars, four times the budget.
  const BIG = Array.from({ length: 30 }, (_, i) =>
    `- bullet ${i + 1}: the quick brown fox jumps over the lazy dog while the .gitignore entry waits for review and nobody notices a truncation that happens mid-word`).join('\n');
  const MARKER_RE = /…\[note truncated at (\d+) chars — (\d+) chars dropped; full text archived to (docs\/derived\/_archive\/CONTINUITY\.note-overflow-\d{4}-\d{2}-\d{2}-[0-9a-f]{12}\.md)\]$/;
  // The check is named after the target's path as savepoint joins it, so the separator is the platform's.
  const noteRow = (checks, name) => checks.find((c) => c.check.startsWith('note:budget:') && c.check.endsWith(name));
  // A kernel-rendered CONTINUITY.md carrying `note` — rendered first so the note is the ONLY variable and
  // the migration path (which owns legacy files) never enters.
  const writeRendered = (dir, note) => {
    const cont = path.join(dir, 'docs', 'derived', 'CONTINUITY.md');
    fs.mkdirSync(path.dirname(cont), { recursive: true });
    fs.writeFileSync(cont, render.renderContinuity(stateLib.compile(dir).state, null).replace('_(no human note)_', note));
    return cont;
  };

  test('the original defect: an over-budget note is not returned as a bare slice — the block ends in a marker naming the budget, the drop and the archive', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const s = stateLib.compile(p.dir).state;
      assert.ok(BIG.length > budget * 3, 'precondition: the fixture note is well over budget');
      const doc = render.renderContinuity(s, wrap(BIG));
      const note = noteOf(doc);
      // The pre-fix behavior, stated as the forbidden outcome: `.slice(0, NOTE_BUDGET)` and nothing else.
      assert.notEqual(note, BIG.slice(0, budget), 'the note came back as a bare slice at the budget — mid-word, no marker, the silent cut');
      assert.ok(note.length <= budget, `the bounded note is ${note.length} chars — the budget is ${budget}, not a suggestion`);
      const m = MARKER_RE.exec(note);
      assert.ok(m, `the block must END in the visible marker; got …${JSON.stringify(note.slice(-160))}`);
      assert.equal(Number(m[1]), budget, 'the marker names the budget it enforced');

      assert.equal(render.NOTE_BUDGET, budget, 'render.js must export the budget it enforces, and it must be the one this block tests');
      const plan = render.planNote(wrap(BIG), 'CONTINUITY.md', s);
      assert.equal(plan.overflow, true);
      assert.equal(note, plan.text, 'the renderer writes exactly the planned text — the plan is what savepoint reports and archives from');
      assert.equal(plan.full, BIG, 'the plan carries the FULL note verbatim for the caller to archive');
      assert.equal(Number(m[2]), plan.dropped, 'the marker states the exact number of chars dropped');
      assert.equal(plan.kept + plan.dropped, BIG.length, 'kept + dropped is the whole note — nothing unaccounted for');
      assert.equal(note.slice(0, plan.kept), BIG.slice(0, plan.kept), 'what was kept is verbatim');
      assert.equal(m[3], plan.archiveRel, 'the marker names the archive the caller will write');
      assert.equal(render.noteBudgetCheck(plan, { file: 'docs/derived/CONTINUITY.md' }).outcome, OUTCOME.FAIL);

      // Stable under regeneration: the bounded note reads back as within budget, so the marker never
      // eats itself on the next run and no second archive is planned.
      const again = render.planNote(doc, 'CONTINUITY.md', s);
      assert.equal(again.overflow, false, 'a re-render of the bounded note must not truncate it again');
      assert.equal(noteOf(render.renderContinuity(s, doc)), note, 'a second render leaves the bounded note byte-identical');
    } finally { rm(p.dir); }
  });

  test('savepoint: --verify reports note:budget FAIL before anything is cut; --write archives the full note verbatim, marks the block, and still reports FAIL', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const cont = writeRendered(p.dir, BIG);
      const before = fs.readFileSync(cont, 'utf8');
      const archiveDir = path.join(p.dir, 'docs', 'derived', '_archive');
      const overflowArchives = () => (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((f) => f.includes('.note-overflow-')) : []);

      // 1. --verify: told, and nothing touched.
      const verify = cli(p.dir, 'savepoint', '--verify');
      const row = noteRow(verify.json.checks, 'CONTINUITY.md');
      assert.ok(row, 'savepoint --verify emitted no note:budget row for CONTINUITY.md at all — the operator is told nothing');
      assert.equal(row.outcome, 'FAIL', 'an over-budget note must never read as PASS');
      assert.match(row.detail, new RegExp(`\\b${BIG.length} chars\\b`), 'the row states the note’s actual length');
      assert.match(row.detail, /note-overflow-/, 'the row names where --write would archive the full text');
      assert.notEqual(verify.json.outcome, 'PASS');
      assert.equal(fs.readFileSync(cont, 'utf8'), before, 'a check-only run rewrote the document');
      assert.deepEqual(overflowArchives(), [], 'a check-only run wrote an archive');

      // 2. --write: the full note is archived BEFORE the bounded doc lands, and the row still fails.
      const written = cli(p.dir, 'savepoint', '--verify', '--write');
      const wrow = noteRow(written.json.checks, 'CONTINUITY.md');
      assert.ok(wrow, 'savepoint --write emitted no note:budget row for CONTINUITY.md');
      assert.equal(wrow.outcome, 'FAIL', 'the write that cut the note must not report the cut as a pass');
      const rel = /(docs\/derived\/_archive\/CONTINUITY\.note-overflow-[\w-]+\.md)/.exec(wrow.detail);
      assert.ok(rel, `the write row must name the archive; got: ${wrow.detail}`);
      assert.equal(fs.readFileSync(path.join(p.dir, rel[1]), 'utf8'), `${BIG}\n`, 'the archive is the full note, verbatim');
      const now = noteOf(fs.readFileSync(cont, 'utf8'));
      assert.ok(now.length <= budget, 'the written block is within budget');
      assert.match(now, MARKER_RE, 'the written block ends in the visible marker');
      assert.ok(now.includes(rel[1]), 'the marker in the document names the same archive the row does');
      assert.equal(overflowArchives().length, 1);
      const gaps = noteRow(written.json.checks, 'GAPS.md');
      assert.equal(gaps && gaps.outcome, 'PASS', 'a doc whose note fits gets a PASS row — the check visibly ran there too');

      // 3. The next run: the bounded note fits, so it passes, and the archive is left exactly as written.
      const archived = fs.readFileSync(path.join(p.dir, rel[1]), 'utf8');
      const again = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(noteRow(again.json.checks, 'CONTINUITY.md').outcome, 'PASS');
      assert.equal(overflowArchives().length, 1, 'a re-run must not archive again — nothing overflowed');
      assert.equal(fs.readFileSync(path.join(p.dir, rel[1]), 'utf8'), archived, 'archive-never-delete: the archive is untouched');
      assert.match(noteOf(fs.readFileSync(cont, 'utf8')), MARKER_RE, 'the marker survives regeneration like any other note text');
    } finally { rm(p.dir); }
  });

  test('nearest bypass: a note exactly at budget passes untouched; one char over is reported and marked', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const s = stateLib.compile(p.dir).state;
      const at = 'x'.repeat(budget);
      const over = 'x'.repeat(budget + 1);
      // Through the renderer first (the pre-fix API): at budget both versions agree; one over, the old
      // one returned `over.slice(0, 1200)` — indistinguishable from `at` — and that is the bypass.
      assert.equal(noteOf(render.renderContinuity(s, wrap(at))), at, 'a note at budget renders verbatim, no marker');
      const overNote = noteOf(render.renderContinuity(s, wrap(over)));
      assert.notEqual(overNote, at, 'one char over the budget rendered exactly like a note AT budget — the cut left no trace');
      assert.match(overNote, MARKER_RE);

      const atPlan = render.planNote(wrap(at), 'CONTINUITY.md', s);
      assert.equal(atPlan.overflow, false, 'exactly at budget is within budget');
      const atRow = render.noteBudgetCheck(atPlan, { file: 'docs/derived/CONTINUITY.md' });
      assert.equal(atRow.outcome, OUTCOME.PASS);
      assert.match(atRow.detail, new RegExp(`${budget}/${budget}`));

      const overPlan = render.planNote(wrap(over), 'CONTINUITY.md', s);
      assert.equal(overPlan.overflow, true, 'one char over is over');
      assert.ok(overPlan.dropped >= 1);
      assert.equal(render.noteBudgetCheck(overPlan, { file: 'docs/derived/CONTINUITY.md' }).outcome, OUTCOME.FAIL);
    } finally { rm(p.dir); }
  });

  test('nearest bypass: the budget is UTF-16 units, and the cut never splits a surrogate pair', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const s = stateLib.compile(p.dir).state;
      // 600 emoji are 600 code points but 1,200 UTF-16 units — exactly the budget; 601 are over it.
      assert.equal('😀'.repeat(600).length, budget, 'precondition: an astral character is two UTF-16 units');
      // The naive cut this guards against: slicing at the budget through a pair leaves a lone surrogate,
      // and the pre-fix renderer did exactly that to `'a' + 600 emoji` (1,201 units).
      assert.equal(('a' + '😀'.repeat(600)).slice(0, budget).isWellFormed(), false, 'precondition: a bare slice CAN split a pair');
      assert.equal(noteOf(render.renderContinuity(s, wrap('a' + '😀'.repeat(600)))).isWellFormed(), true,
        'the rendered note contains a lone surrogate — the cut split a pair, and the file will carry U+FFFD');

      assert.equal(render.planNote(wrap('😀'.repeat(600)), 'GAPS.md', s).overflow, false);
      assert.equal(render.planNote(wrap('😀'.repeat(601)), 'GAPS.md', s).overflow, true, 'the budget is String.length, not code points');
      // Both parities of the cut point, so the back-off is exercised whatever the marker’s own length is.
      for (const prefix of ['', 'a', 'ab', 'abc']) {
        const full = prefix + '😀'.repeat(900);
        const plan = render.planNote(wrap(full), 'GAPS.md', s);
        assert.equal(plan.overflow, true);
        assert.equal(plan.text.isWellFormed(), true, `prefix ${JSON.stringify(prefix)}: the bounded note contains a lone surrogate`);
        assert.ok(plan.text.length <= budget, `prefix ${JSON.stringify(prefix)}: bounded note is ${plan.text.length} units`);
        assert.equal(plan.kept + plan.dropped, full.length, 'kept + dropped closes the arithmetic');
        assert.equal(plan.text.slice(0, plan.kept), full.slice(0, plan.kept), 'the kept prefix is verbatim');
        assert.equal(noteOf(render.renderGaps(s, wrap(full))).isWellFormed(), true, 'and the rendered GAPS block is well-formed too');
      }
    } finally { rm(p.dir); }
  });

  test('migration excerpt path: the seeded note fits the budget with its archive-naming trailer intact, and is not cut again on first render', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      // Long enough that the excerpt must be cut: ~2.3k chars of prose against a 1,200 budget.
      const legacy = `# CONTINUITY\n\n${Array.from({ length: 40 }, (_, i) => `- item ${i + 1}: ${'hand-authored prose '.repeat(2)}`).join('\n')}\n`;
      const plan = render.planMigration(legacy, 'CONTINUITY.md');
      assert.ok(plan.needed);

      const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      fs.mkdirSync(path.dirname(cont), { recursive: true });
      fs.writeFileSync(cont, legacy);
      const r = cli(p.dir, 'savepoint', '--verify', '--write');
      const now = noteOf(fs.readFileSync(cont, 'utf8'));
      // The defect, first: the pre-fix seed was 1,308 chars for a 1,200 budget, and the first render cut it
      // through the sentence that names the archive — so what landed in the file was not what was seeded.
      assert.equal(now, plan.note, 'the first render must carry the seeded note untouched — the migration is not allowed to be truncated by the budget it was sized for');
      assert.match(now, /CONTINUITY\.pre-kernel\.md` — archive, never delete\. Edit this NOTE block; everything below the GENERATED marker is rewritten/, 'the reversibility sentence survived');
      assert.ok(plan.note.length <= budget, `the seeded note is ${plan.note.length} chars — over budget, so the first render would cut it`);
      assert.match(plan.note, /…\n\n_\(Migrated from the hand-authored CONTINUITY\.md/, 'the excerpt is marked as cut, and the trailer follows it');
      assert.ok(plan.note.endsWith('rewritten from `docs/derived/STATE.json`.)_'), 'the trailer — the sentence that names the archive — is intact');
      assert.equal(plan.note.isWellFormed(), true);
      assert.equal(noteRow(r.json.checks, 'CONTINUITY.md').outcome, 'PASS', 'a correctly sized seed leaves nothing for the budget to cut');
      const archiveDir = path.join(p.dir, 'docs', 'derived', '_archive');
      assert.deepEqual(fs.readdirSync(archiveDir), ['CONTINUITY.pre-kernel.md'], 'exactly the pre-kernel archive — no overflow archive was needed');
    } finally { rm(p.dir); }
  });
});

// --- adapters + doctor ----------------------------------------------------------------------------

describe('validator adapters and doctor report honestly', () => {
  test('a declared-but-missing adapter is CANNOT_DETERMINE, never a silent pass', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), JSON.stringify({
        state: { adapters: [{ name: 'ghost', command: 'definitely-not-a-real-binary-xyz', args: ['--verify'] }] },
      }));
      const r = cli(p.dir, 'savepoint', '--verify');
      const a = r.json.checks.find((c) => c.check === 'adapter:ghost');
      assert.equal(a.outcome, 'CANNOT_DETERMINE');
      assert.match(a.detail, /command not found/);
      assert.equal(r.code, 2, 'a run containing a check that could not run must not exit 0');
    } finally { rm(p.dir); }
  });

  test('a critical adapter with no controls is CANNOT_DETERMINE — an unproven critical check is decoration', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), JSON.stringify({
        state: { adapters: [{ name: 'crit', command: process.execPath, args: ['-e', 'process.exit(0)'], critical: true }] },
      }));
      const r = cli(p.dir, 'savepoint', '--verify');
      const a = r.json.checks.find((c) => c.check === 'adapter:crit');
      assert.equal(a.outcome, 'CANNOT_DETERMINE');
      assert.match(a.detail, /ships no known-good\/known-bad controls/);
    } finally { rm(p.dir); }
  });

  test('a critical adapter WITH discriminating controls is trusted', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), JSON.stringify({
        state: {
          adapters: [{
            name: 'crit', command: process.execPath, args: ['-e', 'process.exit(0)'], critical: true,
            controls: { good: ['-e', 'process.exit(0)'], bad: ['-e', 'process.exit(3)'] },
          }],
        },
      }));
      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.json.checks.find((c) => c.check === 'adapter:crit').outcome, 'PASS');
    } finally { rm(p.dir); }
  });

  test('doctor flags a hook that is on disk but not wired — present is not active', () => {
    const p = project({ requirements: [] });
    try {
      fs.mkdirSync(path.join(p.dir, '.claude', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, '.claude', 'hooks', 'ghost-hook.js'), '// never wired\n');
      fs.writeFileSync(path.join(p.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
      const r = cli(p.dir, 'doctor');
      const row = r.json.rows.find((x) => x.check === 'hook:ghost-hook.js');
      assert.equal(row.label, 'SILENTLY INACTIVE');
      assert.equal(r.code, 2);
    } finally { rm(p.dir); }
  });

  test('a project with no requirement source is NOT_CONFIGURED, not failing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-bare-'));
    try {
      const r = cli(dir, 'doctor');
      assert.equal(r.json.rows.find((x) => x.check === 'state:requirements').label, 'NOT_CONFIGURED');
      assert.notEqual(r.code, 1, 'a project that opted out of requirement tracking has not failed anything');
    } finally { rm(dir); }
  });

  test('doctor spells the state:requirements and state:evidence paths POSIX-only, never mixing \\ and / (BUG-4)', () => {
    const p = project({ requirements: [] });
    try {
      const r = cli(p.dir, 'doctor');
      const reqRow = r.json.rows.find((x) => x.check === 'state:requirements');
      const evRow = r.json.rows.find((x) => x.check === 'state:evidence');
      // corrected: POSIX-spelled — on this Windows machine, stateLib.STATE_DIR is a path.join and would
      // read back `docs\derived\state/requirements.json` (mixed) before the fix.
      assert.doesNotMatch(reqRow.detail, /\\/, `state:requirements mixed path separators: ${reqRow.detail}`);
      assert.doesNotMatch(evRow.detail, /\\/, `state:evidence mixed path separators: ${evRow.detail}`);
      assert.match(reqRow.detail, /^docs\/derived\/state\/requirements\.json /);
      assert.match(evRow.detail, /^docs\/derived\/state\/evidence\/ /);

      // bypass: a doctor row with no STATE_DIR-derived path in its detail is untouched by the posix() wrap.
      const stateJsonRow = r.json.rows.find((x) => x.check === 'state:STATE.json');
      assert.equal(stateJsonRow.detail, 'never compiled — run `node .claude/respawnpack/respawnpack.js state`');
    } finally { rm(p.dir); }
  });
});

// --- the interaction contract ---------------------------------------------------------------------

describe('interaction contracts · collaborate is the default and goal is never inferred', () => {
  test('a project with no contract file is in collaborate mode', () => {
    const p = project({ requirements: [] });
    try {
      const r = cli(p.dir, 'contract');
      assert.equal(r.json.contract.mode, 'collaborate');
      assert.match(r.json.contract.source, /default/);
      assert.equal(r.code, 0, 'the default costs nothing and fails nothing');
    } finally { rm(p.dir); }
  });

  test('goal mode REFUSES without a stated goal and stated completion criteria', () => {
    const p = project({ requirements: [] });
    try {
      let r = cli(p.dir, 'contract', 'goal');
      assert.equal(r.code, 1);
      assert.match(r.json.error, /never inferred/);

      // A goal with no definition of done is the configuration that manufactures completion claims.
      r = cli(p.dir, 'contract', 'goal', '--goal', 'make it good');
      assert.equal(r.code, 1, 'a goal without completion criteria must be refused');
      assert.match(r.json.error, /--completion/);

      assert.equal(cli(p.dir, 'contract').json.contract.mode, 'collaborate', 'a refused entry must not half-apply');
    } finally { rm(p.dir); }
  });

  test('goal mode records goal, completion, constraints, forbidden actions and the host limitation', () => {
    const p = project({ requirements: [] });
    try {
      const r = cli(p.dir, 'contract', 'goal',
        '--goal', 'qualify every gate against the real engine',
        '--completion', 'all 9 gates conformant;no P0 open',
        '--constraints', 'no schema edits;owner approves migrations',
        '--forbidden', 'git push;deleting owner data');
      assert.equal(r.code, 0);
      const c = r.json.contract;
      assert.equal(c.mode, 'goal');
      assert.deepEqual(c.completion, ['all 9 gates conformant', 'no P0 open']);
      assert.deepEqual(c.forbidden, ['git push', 'deleting owner data']);
      assert.deepEqual(c.contextStages, { checkpoint: 60, closeout: 75, handoff: 85 });
      assert.match(c.hostNote, /No hook can create a session/,
        'the pack must not imply it can start a fresh session when it cannot');
    } finally { rm(p.dir); }
  });

  test('delegate is bounded: it requires a task AND recorded acceptance criteria', () => {
    const p = project({ requirements: [] });
    try {
      assert.equal(cli(p.dir, 'contract', 'delegate').code, 1, 'delegate without a task is meaningless');

      // ⛔ The docs said "a bounded task with acceptance criteria" while the CLI accepted none. A
      // bounded task with no definition of done is an unbounded one with a shorter description.
      const noCriteria = cli(p.dir, 'contract', 'delegate', '--task', 'add the export button');
      assert.equal(noCriteria.code, 1, 'an empty acceptance list made the "bounded" claim false');
      assert.match(noCriteria.json.error, /Derive the obvious criteria/,
        'the fix must not become a user interrogation — the agent derives them from the request');

      const r = cli(p.dir, 'contract', 'delegate', '--task', 'add the export button', '--acceptance', 'csv downloads;column order preserved');
      assert.equal(r.json.contract.mode, 'delegate');
      assert.deepEqual(r.json.contract.acceptance, ['csv downloads', 'column order preserved']);
      assert.match(r.json.note, /does not become an autonomous scheduler/);
    } finally { rm(p.dir); }
  });
});

describe('prose-first activation is instructed in the SHIPPED baseline', () => {
  // The CLI existing is not the promise. The promise is that a user speaking plainly gets the right
  // mode without knowing a command exists — which depends on the installed baseline saying so.
  const baseline = fs.readFileSync(path.join(KERNEL, '..', 'templates', 'CLAUDE.md'), 'utf8');
  const standard = fs.readFileSync(path.join(KERNEL, '..', 'spine', 'reference', 'behavior-standards.md'), 'utf8');

  test('the installed CLAUDE.md block tells the agent to record delegate and goal itself', () => {
    assert.match(baseline, /collaborate/i);
    assert.match(baseline, /contract delegate/, 'the baseline must name how delegate is recorded');
    assert.match(baseline, /contract goal/, 'the baseline must name how goal is recorded');
    assert.match(baseline, /never type|never make the user|without.*command/i, 'the user must not have to learn the CLI');
  });

  test('it forbids inferring autonomy from difficulty, in both the block and the standard', () => {
    for (const [name, text] of [['templates/CLAUDE.md', baseline], ['behavior-standards.md', standard]]) {
      assert.match(text, /not (a grant of autonomy|infer)|Never infer|Difficulty is not consent/i,
        `${name} must forbid inferring goal mode from size or difficulty`);
    }
  });

  test('it requires acceptance criteria to be DERIVED, not interrogated out of the user', () => {
    assert.match(baseline, /[Dd]erive the acceptance criteria/);
    assert.match(baseline, /only when the ambiguity would materially change/i);
  });

  test('it requires announcing activation, suspension and completion', () => {
    assert.match(baseline, /\*\*activates\*\*[\s\S]{0,200}\*\*suspends\*\*[\s\S]{0,200}\*\*finishes\*\*/,
      'the baseline must tell the agent to say one line at each autonomy transition');
  });

  test('transitions are free — goal mode can be left for collaborate mid-flight', () => {
    const p = project({ requirements: [] });
    try {
      cli(p.dir, 'contract', 'goal', '--goal', 'g', '--completion', 'done');
      assert.equal(cli(p.dir, 'contract').json.contract.mode, 'goal');
      cli(p.dir, 'contract', 'collaborate');
      assert.equal(cli(p.dir, 'contract').json.contract.mode, 'collaborate',
        'a goal-mode user must be able to pause autonomy and collaborate on a decision');
    } finally { rm(p.dir); }
  });

  test('the contract the CLI writes is the one the hooks read', () => {
    const p = project({ requirements: [] });
    try {
      cli(p.dir, 'contract', 'goal', '--goal', 'ship it', '--completion', 'green');
      // hooks/_runtime.js resolves the same path; this is the seam between the two layers, so assert it
      // rather than assuming two files that "look the same" are the same file.
      const written = JSON.parse(fs.readFileSync(path.join(p.dir, '.respawnpack', 'runtime', 'contract.json'), 'utf8'));
      assert.equal(written.mode, 'goal');
    } finally { rm(p.dir); }
  });
});

describe('the CLI→hook seam · what the CLI writes, the hooks must resolve', () => {
  // ⛔ A REGRESSION INTRODUCED BY THE FIX ONE PHASE EARLIER. Phase 2d renamed the runtime pointer from
  // `goalId` to `activeGoalId` in the CLI and left `readContract()` resolving only `goalId`. Nothing
  // failed: the hooks still reported mode=goal, so every suite stayed green while the goal text,
  // completion criteria, constraints, authority and FORBIDDEN ACTIONS silently stopped reaching the
  // session. A renamed field with two writers and one reader is a seam, and a seam needs a test that
  // crosses it — asserting on the CLI's output and the hook's input separately proves neither.
  const readContract = createRequire(import.meta.url)('../hooks/_runtime.js').readContract;

  test('goal entered through the real CLI resolves fully through the hooks reader', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const r = cli(p.dir, 'contract', 'goal', '--id', 'G-1',
        '--goal', 'ship the export path',
        '--completion', 'all-mandatory-conformant;no-open-p0',
        '--constraints', 'no billing edits',
        '--authority', 'may edit src/',
        '--forbidden', 'git push;deleting owner data');
      assert.equal(r.code, 0);

      const c = readContract(p.dir);
      assert.equal(c.mode, 'goal');
      assert.equal(c.goal, 'ship the export path', 'the hooks resolved no goal text — a GOAL banner with no goal');
      assert.deepEqual(c.completion, ['all-mandatory-conformant', 'no-open-p0']);
      assert.deepEqual(c.constraints, ['no billing edits']);
      assert.deepEqual(c.authority, ['may edit src/']);
      assert.deepEqual(c.forbidden, ['git push', 'deleting owner data'],
        'forbidden actions are the highest-consequence field on this seam and were not reaching the session');
    } finally { rm(p.dir); }
  });

  test('the legacy `goalId` spelling still resolves — an existing runtime file must not go dark', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship it', '--completion', 'all-mandatory-conformant', '--forbidden', 'git push');
      // Rewrite the runtime file in the pre-2d shape, as a mid-upgrade machine would still have it.
      const f = path.join(p.dir, '.respawnpack', 'runtime', 'contract.json');
      fs.writeFileSync(f, JSON.stringify({ mode: 'goal', goalId: 'G-1', suspendedGoalId: null }));

      const c = readContract(p.dir);
      assert.equal(c.goal, 'ship it', 'a runtime file written before the rename stopped resolving');
      assert.deepEqual(c.forbidden, ['git push']);
    } finally { rm(p.dir); }
  });

  test('delegate resolves its task and acceptance through the same reader', () => {
    const p = project({ requirements: [] });
    try {
      cli(p.dir, 'contract', 'delegate', '--task', 'add the export button', '--acceptance', 'csv downloads;column order preserved');
      const c = readContract(p.dir);
      assert.equal(c.mode, 'delegate');
      assert.equal(c.task, 'add the export button');
      assert.deepEqual(c.acceptance, ['csv downloads', 'column order preserved']);
    } finally { rm(p.dir); }
  });
});

describe('goal state has ONE owner · durable contract vs runtime pointer', () => {
  test('the goal contract is written to the TRACKED goal.json, not to runtime state', () => {
    const p = project({ requirements: [] });
    try {
      const r = cli(p.dir, 'contract', 'goal', '--id', 'G-1',
        '--goal', 'qualify every gate', '--completion', 'all-mandatory-conformant',
        '--constraints', 'no schema edits', '--forbidden', 'git push');
      assert.equal(r.code, 0);

      const durable = JSON.parse(fs.readFileSync(path.join(p.dir, stateLib.STATE_DIR, 'goal.json'), 'utf8'));
      assert.equal(durable.goals['G-1'].goal, 'qualify every gate');
      assert.deepEqual(durable.goals['G-1'].forbidden, ['git push']);

      // The project's lifecycle field is durable; the machine's autonomy pointer is runtime.
      assert.equal(durable.ongoingGoalId, 'G-1', 'which goal the PROJECT pursues is durable, tracked truth');

      // Runtime holds a POINTER, not a copy — two copies is the "many representations, no owner"
      // problem this whole program exists to end.
      const runtime = JSON.parse(fs.readFileSync(path.join(p.dir, '.respawnpack', 'runtime', 'contract.json'), 'utf8'));
      assert.equal(runtime.activeGoalId, 'G-1');
      assert.equal(runtime.goal, undefined, 'runtime must not carry a second copy of the goal text');
    } finally { rm(p.dir); }
  });

  test('collaborate suspends AUTONOMY; goal → collaborate → goal is cheap and lossless', () => {
    const p = project({ requirements: [] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'the big one', '--completion', 'all-mandatory-conformant');
      const back = cli(p.dir, 'contract', 'collaborate');
      assert.equal(back.json.contract.suspendedGoalId, 'G-1', 'autonomy must be resumable without re-stating the goal');
      assert.ok(fs.existsSync(path.join(p.dir, stateLib.STATE_DIR, 'goal.json')), 'the durable contract must not be deleted');
      assert.equal(stateLib.readGoalDoc(p.dir).ongoingGoalId, 'G-1', 'the PROJECT still has an ongoing goal — only this machine stepped back');

      const resumed = cli(p.dir, 'contract', 'goal', '--resume');
      assert.equal(resumed.code, 0);
      assert.equal(resumed.json.contract.activeGoalId, 'G-1');
      assert.equal(resumed.json.contract.goal, 'the big one', 'the resumed goal must carry its original text');
    } finally { rm(p.dir); }
  });

  test('the compiler reads the same goal the contract wrote — one representation, not two', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'unify the state', '--completion', 'all-mandatory-conformant');
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.ongoingGoalId, 'G-1');
      assert.equal(state.goal, 'unify the state');
      assert.equal('mode' in state, false, 'interaction mode is a session fact and must not enter durable state');
    } finally { rm(p.dir); }
  });

  test('a legacy goal.json ({goal: "..."}) still compiles — no forced migration', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }], goal: { goal: 'the old shape', milestone: 'm1' } });
    try {
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.goal, 'the old shape');
      assert.equal(state.milestone, 'm1');
    } finally { rm(p.dir); }
  });
});

describe('the durable/runtime boundary · STATE.json is durable project facts ONLY', () => {
  // ⛔ The compiler used to read .respawnpack/runtime/contract.json and write `mode`, `suspendedGoal`
  // and `delegatedTask` into the TRACKED STATE.json. That put machine-specific, gitignored session
  // state into a durable artifact — the exact durability split ADR-001 decision 2 exists to hold — and
  // its `runtimeContract.goalId || goalDoc.activeGoalId` fallback made a suspended goal read as active.
  const RUNTIME_KEYS = ['mode', 'suspendedGoal', 'delegatedTask', 'goalId'];

  test('goal → collaborate → compile: the goal is ONGOING, not simultaneously active and suspended', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship it', '--completion', 'all-mandatory-conformant');
      cli(p.dir, 'contract', 'collaborate');
      const { state } = stateLib.compile(p.dir);

      assert.equal(state.ongoingGoalId, 'G-1', 'the project still has an ongoing goal — collaborate suspends autonomy, not the goal');
      assert.equal(state.goal, 'ship it');
      for (const k of RUNTIME_KEYS) {
        assert.equal(k in state, false, `durable STATE.json carries runtime key "${k}" — that is gitignored machine state in a tracked artifact`);
      }
    } finally { rm(p.dir); }
  });

  test('delegate → compile: a bounded delegation never reaches durable state', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'delegate', '--task', 'add the export button', '--acceptance', 'csv downloads');
      const { state } = stateLib.compile(p.dir);
      for (const k of RUNTIME_KEYS) assert.equal(k in state, false, `delegation leaked "${k}" into tracked state`);
    } finally { rm(p.dir); }
  });

  test('a fresh clone sees the ongoing goal but defaults to collaborate — autonomy never travels', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship it', '--completion', 'all-mandatory-conformant');
      // Simulate the clone: goal.json is tracked and arrives; .respawnpack/ is gitignored and does not.
      fs.rmSync(path.join(p.dir, '.respawnpack'), { recursive: true, force: true });

      const { state } = stateLib.compile(p.dir);
      assert.equal(state.ongoingGoalId, 'G-1', 'the durable goal contract must survive a clone');
      assert.equal(state.goal, 'ship it');

      const c = cli(p.dir, 'contract');
      assert.equal(c.json.contract.mode, 'collaborate', 'a clone must not inherit autonomy from another machine');
    } finally { rm(p.dir); }
  });

  test('two machines in different modes produce byte-equivalent durable state', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship it', '--completion', 'all-mandatory-conformant');
      const asGoal = stateLib.compile(p.dir).state;
      cli(p.dir, 'contract', 'delegate', '--task', 'something else', '--acceptance', 'it works');
      const asDelegate = stateLib.compile(p.dir).state;
      cli(p.dir, 'contract', 'collaborate');
      const asCollab = stateLib.compile(p.dir).state;

      const durable = (s) => { const { generatedAt, ...rest } = s; return JSON.stringify(rest); };
      assert.equal(durable(asGoal), durable(asDelegate), 'runtime mode changed a TRACKED artifact — two machines would fight over it in git');
      assert.equal(durable(asGoal), durable(asCollab));
    } finally { rm(p.dir); }
  });

  test('completion is still evaluated for the ongoing goal while autonomy is suspended', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship it', '--completion', 'all-mandatory-conformant');
      cli(p.dir, 'contract', 'collaborate');
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence(p.head(), ['R-1'])));
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.goalCompletion.status, 'MET', 'suspending autonomy must not stop the project goal being assessed');
      assert.equal(state.goalComplete, true);
    } finally { rm(p.dir); }
  });
});

describe('freshness is CONTENT-bound, not only revision-bound', () => {
  // ⛔ `sourceRevision === HEAD` says nothing about UNCOMMITTED edits to the compiler's inputs — and
  // every input here is a file someone edits before committing. A projection declared CURRENT while its
  // own source has changed underneath it is the confident-stale-number failure in a new place.
  const freshness = async (dir) => {
    const rt = await import('../hooks/_runtime.js').then((m) => m.default || m);
    return rt.readDurableState(dir);
  };

  test('an UNCOMMITTED edit to requirements.json makes STATE stale', async () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      stateLib.write(p.dir, stateLib.compile(p.dir).state);
      assert.equal((await freshness(p.dir)).status, 'CURRENT', 'sanity: freshly compiled state is current');

      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'requirements.json'),
        JSON.stringify({ schemaVersion: '1.0.0', requirements: [{ id: 'R-1', mandatory: true }, { id: 'R-2', mandatory: true }] }));

      const r = await freshness(p.dir);
      assert.equal(r.status, 'STALE', 'HEAD had not moved, so a revision-only check called this current while the count was already wrong');
      assert.match(r.detail, /requirements\.json/, 'the report must name which input changed');
    } finally { rm(p.dir); }
  });

  test('an UNCOMMITTED edit to the goal contract makes STATE stale', async () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship it', '--completion', 'all-mandatory-conformant');
      stateLib.write(p.dir, stateLib.compile(p.dir).state);
      assert.equal((await freshness(p.dir)).status, 'CURRENT');

      const doc = stateLib.readGoalDoc(p.dir);
      doc.goals['G-1'].completion = ['all-mandatory-conformant', 'owner-confirmed sign-off'];
      stateLib.writeGoalDoc(p.dir, doc);

      assert.equal((await freshness(p.dir)).status, 'STALE', 'the completion criteria changed and the projection did not notice');
    } finally { rm(p.dir); }
  });

  test('an added or edited evidence artifact makes STATE stale', async () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      stateLib.write(p.dir, stateLib.compile(p.dir).state);
      assert.equal((await freshness(p.dir)).status, 'CURRENT');
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'new.json'), JSON.stringify(evidence(p.head(), ['R-1'])));
      assert.equal((await freshness(p.dir)).status, 'STALE', 'a new evidence artifact changes every conformance count');
    } finally { rm(p.dir); }
  });

  test('a STATE with no source manifest is CANNOT_DETERMINE, never CURRENT', async () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const s = stateLib.compile(p.dir).state;
      delete s.sourceManifest;
      stateLib.write(p.dir, s);
      const r = await freshness(p.dir);
      assert.equal(r.status, 'CANNOT_DETERMINE', 'unable to check is not the same as checked and fine');
    } finally { rm(p.dir); }
  });

  test('an unreadable / malformed manifest is CANNOT_DETERMINE', async () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const s = stateLib.compile(p.dir).state;
      s.sourceManifest = 'not an object';
      stateLib.write(p.dir, s);
      assert.equal((await freshness(p.dir)).status, 'CANNOT_DETERMINE');
    } finally { rm(p.dir); }
  });

  test('a committed-and-unchanged tree stays CURRENT — the known-good control', async () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      stateLib.write(p.dir, stateLib.compile(p.dir).state);
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'commit the state');
      // HEAD moved, so recompile at the new revision — then nothing changes and it must read CURRENT.
      stateLib.write(p.dir, stateLib.compile(p.dir).state);
      assert.equal((await freshness(p.dir)).status, 'CURRENT', 'if this cannot say CURRENT it discriminates nothing');
    } finally { rm(p.dir); }
  });
});

/*
 * ⛔ THE ONE KEY THAT IS NOT A COMPILER INPUT (ADR-003, P3-T-09b) — the kernel-side twin.
 *
 * `respawnpack.config.json` is a compiler input and every byte of it was digested, so declaring
 * `"posture": {"profile": "light"}` — a choice about how loudly a rule speaks, which changes no count,
 * no gate verdict and no rendered line — marked STATE.json STALE and withheld every number. The digest
 * now drops `MANIFEST_EXCLUDED` from a parsed copy and hashes a canonical serialization instead.
 *
 * Mirrored from hooks/hooks.test.mjs deliberately. The manifest is ONE module with two callers — the
 * compiler here, the boot path there — and a freshness rule proved on only one side is a rule whose
 * halves are free to drift apart. Same four assertions, driven through the real compiler and the real
 * comparison rather than through a hook's rendered text.
 */
describe('the `posture` key is elided from the config digest · one exclusion, and its fence', () => {
  const freshness = async (dir) => (await import('../hooks/_runtime.js').then((m) => m.default || m)).readDurableState(dir);
  const manifest = createRequire(import.meta.url)('../hooks/_manifest.js');
  const CONFIG = 'respawnpack.config.json';
  const configPath = (dir) => path.join(dir, CONFIG);
  const configDigest = (dir) => manifest.sourceManifest(dir).inputs[CONFIG];
  const amendConfig = (dir, over) => {
    const cfg = JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
    fs.writeFileSync(configPath(dir), JSON.stringify({ ...cfg, ...over }, null, 2));
  };

  test('defect · declaring a posture marked STATE.json STALE and withheld every count', async () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      stateLib.write(p.dir, stateLib.compile(p.dir).state);
      assert.equal((await freshness(p.dir)).status, 'CURRENT', 'sanity: freshly compiled state is current');

      amendConfig(p.dir, { posture: { profile: 'light' } });
      const r = await freshness(p.dir);
      assert.equal(r.status, 'CURRENT',
        `choosing a posture changes no count, no gate verdict and no rendered line, and it marked the whole projection stale: ${r.detail || ''}`);
    } finally { rm(p.dir); }
  });

  test('corrected · two configs differing only in `posture` produce the same config digest', () => {
    const a = project({ requirements: [] });
    const b = project({ requirements: [] });
    try {
      amendConfig(b.dir, {
        posture: { profile: 'light', overrides: { 'push-guard:tier1': { verdict: 'off', reason: 'solo repo, every push reviewed at the PR' } } },
      });
      assert.equal(configDigest(a.dir), configDigest(b.dir), 'the posture declaration still moved the digest of a compiler input');
      assert.equal(manifest.sourceManifest(a.dir).manifestVersion, 2,
        'a v2 rule has to say it is v2, or the v1 clause below has nothing to key on');
    } finally { rm(a.dir); rm(b.dir); }
  });

  test('nearest bypass · a config differing in `posture` AND `qualityGate` still digests differently', () => {
    const a = project({ requirements: [] });
    const b = project({ requirements: [] });
    try {
      amendConfig(b.dir, { posture: { profile: 'light' }, qualityGate: { command: 'npm test' } });
      assert.notEqual(configDigest(a.dir), configDigest(b.dir),
        'the exclusion smuggled a compiler-input edit past freshness — a quality-gate change rode in beside the posture key');
    } finally { rm(a.dir); rm(b.dir); }
  });

  test('the v1 clause · a manifest recorded with no `manifestVersion` still reads CURRENT, and STALE when an input changed', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      // Exactly what 0.3.0 recorded: no version field, and the config digested by its RAW BYTES. Built
      // from the bytes here rather than off sourceManifest, or the assertion would pass vacuously.
      const v1 = manifest.sourceManifest(p.dir);
      delete v1.manifestVersion;
      v1.inputs[CONFIG] = crypto.createHash('sha256').update(fs.readFileSync(configPath(p.dir))).digest('hex');

      assert.equal(manifest.compareManifest(v1, p.dir).status, 'CURRENT',
        'a canonical digest never equals the raw-byte digest, so without the v1 clause every live target reads STALE at once');

      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'requirements.json'),
        JSON.stringify({ schemaVersion: '1.0.0', requirements: [{ id: 'R-1', mandatory: true }, { id: 'R-2', mandatory: true }] }));
      const after = manifest.compareManifest(v1, p.dir);
      assert.equal(after.status, 'STALE', 'the compatibility clause must not blunt the check it keeps compatible');
      assert.deepEqual(after.changed, ['docs/derived/state/requirements.json']);
    } finally { rm(p.dir); }
  });
});

/*
 * ⛔ THE SAVEPOINT REVISION LAG (observed on a real target, 2026-08-23).
 *
 * The documented closeout — commit the work (W), `savepoint --verify --write`, commit the derived docs
 * as `docs(savepoint): regen at W` (S) — leaves HEAD one commit past the revision STATE.json describes.
 * Every reader compared `sourceRevision === HEAD` literally, so the state a savepoint had just verified
 * read as STALE at every boot; a verify-only run rebound STATE.json to S and dirtied the tree; and the
 * generated-block check FAILed with the revision line as the only difference.
 *
 * Three verdicts the fix must keep apart: HEAD is the bound revision (CURRENT, the control); HEAD is the
 * bound revision plus savepoint-only commits (CURRENT, the fix); HEAD is anything else (STALE, as before).
 * The fixtures commit real paths and let the shipped walk classify them.
 */
describe('savepoint revision lag · the savepoint commit describes the same source as the work it saved', () => {
  const freshness = async (dir) => (await import('../hooks/_runtime.js').then((m) => m.default || m)).readDurableState(dir);
  const manifest = createRequire(import.meta.url)('../hooks/_manifest.js');
  const commitAll = (p, msg) => { p.git('add', '-A'); p.git('commit', '--quiet', '-m', msg); return p.head(); };
  const posixCheck = (r, id) => (r.json.checks || []).find((c) => String(c.check).replace(/\\/g, '/') === id);
  const stateBytes = (p) => fs.readFileSync(path.join(p.dir, stateLib.STATE_FILE), 'utf8');

  /** Work committed at W, a passing savepoint written against W — the state the closeout produces. */
  function savedAtW() {
    const p = project({ requirements: [{ id: 'R-1', title: 'one', mandatory: true }] });
    fs.writeFileSync(path.join(p.dir, '.gitignore'), '.respawnpack/\n');
    const W = commitAll(p, 'work');
    const r = cli(p.dir, 'savepoint', '--verify', '--write');
    assert.equal(r.code, 0, `the seeding savepoint must pass, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.equal(stateLib.read(p.dir).sourceRevision, W, 'sanity: the seeded state is bound to W');
    return { p, W };
  }

  test('sourceRevisions · the shared walk classifies exactly the savepoint\'s own output as source-neutral', () => {
    const { p, W } = savedAtW();
    try {
      assert.deepEqual(manifest.sourceRevisions(p.dir).chain, [W], 'at W the chain is W alone');

      const S = commitAll(p, `docs(savepoint): regen at ${W.slice(0, 7)}`);
      let r = manifest.sourceRevisions(p.dir);
      assert.equal(r.effective, W, 'the savepoint commit is not the source — the work commit beneath it is');
      assert.deepEqual(r.chain, [S, W]);
      assert.equal(r.savepointOnly.length, 1);

      // A candidate-memory commit is savepoint output too (Step 2c writes memory/candidates/).
      fs.mkdirSync(path.join(p.dir, 'memory', 'candidates'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'memory', 'candidates', 'audit.jsonl'), '{"event":"captured"}\n');
      const C = commitAll(p, 'memory: candidates');
      r = manifest.sourceRevisions(p.dir);
      assert.equal(r.effective, W);
      assert.deepEqual(r.chain, [C, S, W]);

      // An empty commit changes no source either.
      p.git('commit', '--quiet', '--allow-empty', '-m', 'trigger ci');
      assert.equal(manifest.sourceRevisions(p.dir).effective, W, 'an empty commit is not a source change');

      // A compiler input under docs/derived/state/ IS a source change, even though it sits under docs/derived/.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'requirements.json'), JSON.stringify({ schemaVersion: '1.0.0', requirements: [{ id: 'R-1', mandatory: true }, { id: 'R-2', mandatory: true }] }));
      const D = commitAll(p, 'add a requirement');
      r = manifest.sourceRevisions(p.dir);
      assert.equal(r.effective, D, 'a denominator change must end the walk');
      assert.deepEqual(r.chain, [D]);

      // Real work ends it too, and a merge commit is never savepoint-only.
      fs.writeFileSync(path.join(p.dir, 'src.txt'), 'code\n');
      const X = commitAll(p, 'code');
      assert.deepEqual(manifest.sourceRevisions(p.dir).chain, [X]);
      p.git('checkout', '--quiet', '-b', 'side', S);
      fs.writeFileSync(path.join(p.dir, 'docs', 'derived', 'GAPS.md'), fs.readFileSync(path.join(p.dir, 'docs', 'derived', 'GAPS.md'), 'utf8') + '\n');
      commitAll(p, 'docs: side');
      p.git('checkout', '--quiet', 'main');
      p.git('merge', '--quiet', '--no-ff', '--no-edit', 'side');
      const M = p.head();
      assert.deepEqual(manifest.sourceRevisions(p.dir).chain, [M], 'a merge has two parents and is never walked through');
    } finally { rm(p.dir); }
  });

  test('sourceRevisions · the walk is bounded, and truncation binds strictly to HEAD', () => {
    const { p, W } = savedAtW();
    try {
      const S = commitAll(p, `docs(savepoint): regen at ${W.slice(0, 7)}`);
      const r = manifest.sourceRevisions(p.dir, { limit: 1 });
      assert.equal(r.truncated, true);
      assert.equal(r.effective, S, 'when the walk cannot reach a source-bearing commit it must bind to HEAD, never guess deeper');
      assert.deepEqual(r.chain, [S, W], 'the verified prefix is still the equivalence class — every entry was classified');
      assert.equal(manifest.sourceRevisions(p.dir, { limit: 0 }).effective, S);
    } finally { rm(p.dir); }
  });

  test('case 1 · clean match — compile, status and doctor at the bound revision read CURRENT', async () => {
    const { p, W } = savedAtW();
    try {
      assert.equal((await freshness(p.dir)).status, 'CURRENT');
      const st = cli(p.dir, 'status');
      assert.equal(st.json.outcome, OUTCOME.PASS, st.json.text);
      assert.match(st.json.text, new RegExp(`@ ${W.slice(0, 7)}`));
      const row = cli(p.dir, 'doctor').json.rows.find((x) => x.check === 'state:STATE.json');
      assert.equal(row.label, 'CURRENT', row.detail);
      assert.doesNotMatch(row.detail, /savepoint-only/, 'no lag to report at the bound revision');
    } finally { rm(p.dir); }
  });

  test('case 2 · savepoint-only lag — verify-only at S passes, leaves STATE.json untouched, and every reader says CURRENT', async () => {
    const { p, W } = savedAtW();
    try {
      const S = commitAll(p, `docs(savepoint): regen at ${W.slice(0, 7)}`);
      const before = stateBytes(p);
      assert.equal(p.git('status', '--porcelain').trim(), '', 'sanity: clean tree after the savepoint commit');

      const v = cli(p.dir, 'savepoint', '--verify');
      assert.equal(v.code, 0, `a savepoint that changed no source must verify clean at its own commit, got ${v.code}: ${JSON.stringify(v.json && v.json.checks.filter((c) => c.outcome !== 'PASS'))}`);
      const gen = posixCheck(v, 'generated-block:docs/derived/CONTINUITY.md');
      assert.equal(gen.outcome, OUTCOME.PASS, `the generated block's only possible difference was the revision line: ${gen.detail}`);
      const wb = posixCheck(v, 'state-writeback');
      assert.equal(wb.outcome, OUTCOME.PASS, wb.detail);
      assert.match(wb.detail, /left untouched/, 'a verify-only run must say it did not write');
      assert.equal(stateBytes(p), before, 'verify-only rewrote STATE.json — the side effect that forced `git checkout -- docs/derived/STATE.json`');
      assert.equal(p.git('status', '--porcelain').trim(), '', 'verify-only dirtied the tree');
      assert.equal(v.json.revisions.head, S);
      assert.equal(v.json.revisions.sourceRevision, W);

      // A --write re-run at S rebinds to W, not S: the revision line and every count are byte-identical.
      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(w.code, 0);
      assert.equal(stateLib.read(p.dir).sourceRevision, W, 'the compile at S must bind to the source it describes');
      const cont = fs.readFileSync(path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md'), 'utf8');
      assert.match(cont, new RegExp(`\\*\\*Source revision:\\*\\* \`${W}\``));
      // LESSONS.md joins the two: it carries the same `_Generated <at>._` stamp OUTSIDE its generated
      // block, for the same reason (a timestamp inside the block would make every run differ from a
      // fresh render), so a no-op --write moves that line and nothing else in it.
      assert.equal(p.git('diff', '--name-only').trim().split(/\r?\n/).filter((f) => f && !/STATE\.json|CONTINUITY\.md|LESSONS\.md/.test(f)).length, 0,
        'only the generatedAt stamps may change on a no-op --write');

      assert.equal((await freshness(p.dir)).status, 'CURRENT');
      const st = cli(p.dir, 'status');
      assert.equal(st.json.outcome, OUTCOME.PASS, 'status withheld its rows over the savepoint commit');
      const row = cli(p.dir, 'doctor').json.rows.find((x) => x.check === 'state:STATE.json');
      assert.equal(row.label, 'CURRENT', row.detail);
      assert.match(row.detail, /differs from it only by 1 savepoint-only commit/, 'doctor must state the lag it is accepting');
    } finally { rm(p.dir); }
  });

  test('case 2 · evidence bound at the savepoint commit still qualifies — the closeout must not retire what it verified', () => {
    const { p, W } = savedAtW();
    try {
      const S = commitAll(p, `docs(savepoint): regen at ${W.slice(0, 7)}`);
      // A battery run AFTER the savepoint commit binds to HEAD = S. The source it tested is W's.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence(S, ['R-1'])));
      const atS = stateLib.compile(p.dir).state;
      assert.equal(atS.sourceRevision, W);
      assert.equal(atS.counts.conformant, 1, `evidence bound to the savepoint commit was rejected: ${JSON.stringify(atS.evidence.rejected)}`);
      // And evidence bound at W still counts at S.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence(W, ['R-1'])));
      assert.equal(stateLib.compile(p.dir).state.counts.conformant, 1);
      // Evidence bound to a revision OUTSIDE the chain is still stale.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', ['R-1'])));
      const stale = stateLib.compile(p.dir).state;
      assert.equal(stale.counts.conformant, 0);
      assert.equal(stale.counts.staleEvidence, 1);
    } finally { rm(p.dir); }
  });

  test('case 3 · real drift — a code commit on top of the savepoint is STALE everywhere, and verify-only names it without writing', async () => {
    const { p, W } = savedAtW();
    try {
      commitAll(p, `docs(savepoint): regen at ${W.slice(0, 7)}`);
      fs.writeFileSync(path.join(p.dir, 'src.txt'), 'more work\n');
      const X = commitAll(p, 'more work');
      const before = stateBytes(p);

      const f = await freshness(p.dir);
      assert.equal(f.status, 'STALE', 'real work after the savepoint must still read as stale');
      assert.match(f.detail, new RegExp(`describes ${W.slice(0, 7)}, HEAD is ${X.slice(0, 7)}`));
      assert.equal(cli(p.dir, 'status').json.outcome, OUTCOME.CANNOT_DETERMINE, 'status must withhold over real drift');
      assert.equal(cli(p.dir, 'doctor').json.rows.find((x) => x.check === 'state:STATE.json').label, 'STALE');

      const v = cli(p.dir, 'savepoint', '--verify');
      assert.equal(v.code, 1, 'a stale STATE.json on disk is a FAIL, not something to overwrite quietly');
      const wb = posixCheck(v, 'state-writeback');
      assert.equal(wb.outcome, OUTCOME.FAIL, wb.detail);
      assert.match(wb.detail, /--write/, 'the FAIL must name the fix');
      assert.equal(posixCheck(v, 'generated-block:docs/derived/CONTINUITY.md').outcome, OUTCOME.FAIL, 'a revision line naming a commit outside the chain is a real disagreement');
      assert.equal(stateBytes(p), before, 'verify-only must not touch a STATE.json that exists — stale or not');

      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(w.code, 0, `--write is the fix: ${JSON.stringify(w.json && w.json.checks.filter((c) => c.outcome !== 'PASS'))}`);
      assert.equal(stateLib.read(p.dir).sourceRevision, X);
    } finally { rm(p.dir); }
  });

  test('verify-only CREATES a missing STATE.json (nothing to verify against) and says so', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      assert.ok(!fs.existsSync(path.join(p.dir, stateLib.STATE_FILE)), 'sanity: no state yet');
      const r = cli(p.dir, 'savepoint', '--verify');
      const wb = r.json.checks.find((c) => c.check === 'state-writeback');
      assert.equal(wb.outcome, OUTCOME.PASS, wb.detail);
      assert.match(wb.detail, /did not exist and was created/);
      assert.ok(fs.existsSync(path.join(p.dir, stateLib.STATE_FILE)), 'a first verify must leave a state for the next boot to read');
      // A second verify-only run now finds it and leaves it alone.
      const bytes = fs.readFileSync(path.join(p.dir, stateLib.STATE_FILE), 'utf8');
      const again = cli(p.dir, 'savepoint', '--verify');
      assert.match(again.json.checks.find((c) => c.check === 'state-writeback').detail, /left untouched/);
      assert.equal(fs.readFileSync(path.join(p.dir, stateLib.STATE_FILE), 'utf8'), bytes);
    } finally { rm(p.dir); }
  });

  test('generated-block · a revision line may differ only INSIDE the equivalence class the caller names', () => {
    const state = { sourceRevision: 'a'.repeat(40), counts: { mandatory: 1, conformant: 0, candidate: 0, unevidenced: 1, waived: 0, blocked: 0, total: 1, staleEvidence: 0 }, tracksRequirements: true, generatedAt: 'x' };
    const atA = render.renderContinuity(state, '');
    const atB = render.renderContinuity({ ...state, sourceRevision: 'b'.repeat(40) }, '');
    const A = 'a'.repeat(40), B = 'b'.repeat(40);
    assert.equal(render.driftFromGenerated(atA, atB, 'CONTINUITY.md').outcome, OUTCOME.FAIL, 'with no equivalence stated, a different revision is drift');
    assert.equal(render.driftFromGenerated(atA, atB, 'CONTINUITY.md', { equivalentRevisions: [B, A] }).outcome, OUTCOME.PASS, 'both revisions in the class → the same source');
    assert.equal(render.driftFromGenerated(atA, atB, 'CONTINUITY.md', { equivalentRevisions: [B] }).outcome, OUTCOME.FAIL, 'the on-disk revision outside the class → stale');
    assert.equal(render.driftFromGenerated(atA, atB, 'CONTINUITY.md', { equivalentRevisions: [A] }).outcome, OUTCOME.FAIL, 'the fresh revision outside the class → stale');
    // Equivalence never excuses a hand-edited number.
    const tampered = atA.replace('0 conformant', '5 conformant');
    assert.equal(render.driftFromGenerated(tampered, atB, 'CONTINUITY.md', { equivalentRevisions: [B, A] }).outcome, OUTCOME.FAIL);
  });
});

/*
 * ⛔ BUG-2 / K-02 — CHECK IDS EMBEDDED THE HOST PATH SEPARATOR, SO THE DIGEST DID TOO.
 *
 * `render:<file>`, `rendered-claims:<file>`, `generated-block:<file>` and `note:budget:<file>` are all
 * built from `t.file`, which respawnpack.js constructs with `path.join('docs', 'derived', ...)`. On
 * Windows that bakes a backslash into the id — `render:docs\derived\CONTINUITY.md` — while every
 * committed fixture (`schemas/fixtures/savepoint-attempt/valid.json`, `fixtures.gen.mjs`) and
 * `hooks/hooks.test.mjs` spell the POSIX form. `recordSavepointAttempt`'s `blockerDigest` is a sha256 of
 * the blockers' `check` strings, so the identical blocker set digested differently by platform. The fix
 * normalises the file component to forward slashes at each id's construction, reusing `removals.js`'s
 * `posix()` (already exported for K-01's containment trio) rather than growing a second copy — and
 * touches only the id: row order, outcome and detail text are untouched.
 */
describe('check ids · platform-stable regardless of path.sep (BUG-2 / K-02)', () => {
  test('render:, rendered-claims:, generated-block: and note:budget: are all POSIX-spelled, never the host separator', () => {
    const p = project();
    try {
      // Neither derived doc exists yet, so `render:<file>` fires NOT_APPLICABLE for both targets — the
      // exact construction BUG-2 reproduced (t.file, built by path.join, embedded straight into the id).
      const first = cli(p.dir, 'savepoint', '--verify');
      assert.equal(first.code, 0);
      const contRender = first.json.checks.find((c) => c.check.startsWith('render:') && /CONTINUITY\.md$/.test(c.check));
      const gapsRender = first.json.checks.find((c) => c.check.startsWith('render:') && /GAPS\.md$/.test(c.check));
      assert.ok(contRender && gapsRender, 'sanity: both render: rows must be present');
      assert.equal(contRender.check, 'render:docs/derived/CONTINUITY.md', 'the id must be POSIX-spelled regardless of path.sep');
      assert.equal(gapsRender.check, 'render:docs/derived/GAPS.md');

      // Render both, then verify again against the just-written, already-kernel-rendered docs — this is
      // where note:budget:, rendered-claims: and generated-block: fire (render.js's three id sites).
      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(w.code, 0, `seeding --write must pass: ${JSON.stringify((w.json && w.json.checks || []).filter((c) => c.outcome !== 'PASS'))}`);
      const second = cli(p.dir, 'savepoint', '--verify');
      assert.equal(second.code, 0, `re-verify must pass cleanly: ${JSON.stringify((second.json && second.json.checks || []).filter((c) => c.outcome !== 'PASS'))}`);

      for (const file of ['CONTINUITY.md', 'GAPS.md']) {
        for (const prefix of ['note:budget:', 'rendered-claims:', 'generated-block:']) {
          const id = `${prefix}docs/derived/${file}`;
          const row = second.json.checks.find((c) => c.check === id);
          assert.ok(row, `expected exactly "${id}" among: ${second.json.checks.map((c) => c.check).join(', ')}`);
          assert.equal(row.outcome, 'PASS', row.detail);
        }
      }
    } finally { rm(p.dir); }
  });

  /*
   * The pinned digest below was derived OFFLINE, from the exact formula `recordSavepointAttempt` uses in
   * kernel/respawnpack.js: sha256 of the blockers' `${check}|${outcome}` lines, sorted and joined by
   * "\n", hex-encoded and truncated to 32 chars. This fixture's only blocker is a hand-authored
   * CONTINUITY.md the kernel has never migrated — `render:docs/derived/CONTINUITY.md` CANNOT_DETERMINE
   * — so the POSIX-spelled input to sha256 is the single line
   * "render:docs/derived/CONTINUITY.md|CANNOT_DETERMINE", and:
   *   node -e "console.log(require('crypto').createHash('sha256')
   *     .update('render:docs/derived/CONTINUITY.md|CANNOT_DETERMINE').digest('hex').slice(0,32))"
   * prints 00604d6d6142d9ef05c5882cbe886c1c. Before this fix, this exact fixture on this Windows machine
   * produced a1631245a9b62f706c575005068a80b7 instead — the identical blocker, digested from its
   * backslash-spelled id — which is precisely the platform-dependence this test closes.
   */
  const PINNED_BLOCKER_DIGEST = '00604d6d6142d9ef05c5882cbe886c1c';

  test('the receipt blockerDigest for a fixed blocker set is a pinned, platform-stable constant', () => {
    const p = project();
    try {
      fs.mkdirSync(path.join(p.dir, 'docs', 'derived'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md'), '# My hand-written continuity doc\n\nSome prose.\n');

      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 2, 'a hand-authored, unmigrated CONTINUITY.md must block on CANNOT_DETERMINE');
      const blockers = r.json.checks.filter((c) => c.outcome === 'FAIL' || c.outcome === 'CANNOT_DETERMINE');
      assert.deepEqual(blockers.map((c) => c.check), ['render:docs/derived/CONTINUITY.md'],
        'sanity: this fixture must produce exactly this one blocker, or the pinned digest below is not comparable');

      const receipt = JSON.parse(fs.readFileSync(path.join(p.dir, '.respawnpack', 'runtime', 'savepoint-attempt.json'), 'utf8'));
      assert.equal(receipt.blockerDigest, PINNED_BLOCKER_DIGEST,
        'the blockerDigest for this exact blocker set must match the constant derived above from the POSIX spelling');
      assert.equal(receipt.blockers[0].check, 'render:docs/derived/CONTINUITY.md');
    } finally { rm(p.dir); }
  });

  test('nearest bypass: a check with no file component is unchanged; a nested path is normalised at every segment', () => {
    const p = project();
    try {
      const r = cli(p.dir, 'savepoint', '--verify');
      const wb = r.json.checks.find((c) => c.check === 'state-writeback');
      assert.ok(wb, 'sanity: state-writeback row missing');
      assert.equal(wb.check, 'state-writeback', 'a check with no `:<file>` component carries no file to normalise, and must be untouched by the fix');
    } finally { rm(p.dir); }

    // The shared posix() helper itself: every backslash must be replaced, not just the first, so a
    // multi-level Windows-style path normalises completely rather than partially.
    assert.equal(removalsLib.posix('docs\\derived\\state\\x.json'), 'docs/derived/state/x.json');
    assert.equal(removalsLib.posix('a\\b\\c\\d\\e.md'), 'a/b/c/d/e.md');
    // Already-POSIX and mixed-separator inputs stay correct / are fully normalised too.
    assert.equal(removalsLib.posix('docs/derived/state/x.json'), 'docs/derived/state/x.json');
    assert.equal(removalsLib.posix('docs/derived\\state/x.json'), 'docs/derived/state/x.json');
  });
});

/*
 * ⛔ K-05 / I-11 — `state` COMPILES STATE.json AND SAYS NOTHING ABOUT THE DOCS THAT STILL DESCRIBE
 * YESTERDAY. `/respawn` Step 0 tells the model to run plain `state` (never `savepoint --write`) when
 * STATE.json looks stale, and before this fix a fresh STATE.json next to a hand-tampered CONTINUITY.md
 * reported a silent PASS: `cmdState()` never looked at the rendered docs at all. `savepoint` already
 * runs `render.driftFromGenerated` for exactly this; `state` now runs the SAME check, read-only,
 * against each rendered target, and reports a disagreement as a `generated-block:<file>` row instead
 * of staying quiet. The row is always CANNOT_DETERMINE, never FAIL: making it FAIL would flip `state`'s
 * own exit code for every project with a stale render, which is `savepoint`'s call to make, not a
 * silent compile step's (the kernel audit K-05's risk note).
 */
describe('state · reports rendered-doc staleness instead of silently passing (K-05 / I-11)', () => {
  // A clean savepoint --write, matching the BUG-2 seeding pattern above: fully rendered CONTINUITY.md
  // and GAPS.md, both with a generated block that agrees with the state that produced them.
  function freshFixture() {
    const p = project();
    const w = cli(p.dir, 'savepoint', '--verify', '--write');
    assert.equal(w.code, 0, `seeding savepoint must pass: ${JSON.stringify((w.json && w.json.checks || []).filter((c) => c.outcome !== 'PASS'))}`);
    return p;
  }

  test('fresh docs stay quiet: a clean savepoint --write leaves state with no generated-block row', () => {
    const p = freshFixture();
    try {
      const r = cli(p.dir, 'state');
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const rows = r.json.findings.filter((c) => c.check.startsWith('generated-block:'));
      assert.deepEqual(rows, [], `a freshly-rendered project must report no generated-block row, got: ${JSON.stringify(rows)}`);
      assert.equal(r.json.wrote.replace(/\\/g, '/'), 'docs/derived/STATE.json');
    } finally { rm(p.dir); }
  });

  test('a stale generated block is reported as CANNOT_DETERMINE naming savepoint --write, and state never touches the doc or its own exit code', () => {
    const p = freshFixture();
    try {
      const contPath = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      const rendered = fs.readFileSync(contPath, 'utf8');
      const stale = rendered.replace('## Goal', '## Goal (hand-edited after the last savepoint)');
      assert.notEqual(stale, rendered, 'sanity: the fixture must actually change the generated block');
      fs.writeFileSync(contPath, stale);

      const r = cli(p.dir, 'state');
      assert.equal(r.code, 0, "a stale render is report-only — it must never flip state's own exit code");
      const row = r.json.findings.find((c) => c.check === 'generated-block:docs/derived/CONTINUITY.md');
      assert.ok(row, `expected a generated-block row among: ${r.json.findings.map((c) => c.check).join(', ')}`);
      assert.equal(row.outcome, OUTCOME.CANNOT_DETERMINE, "stale is downgraded from driftFromGenerated's native FAIL — state reports, it does not gate");
      assert.match(row.detail, /savepoint --write/, 'the row must name the fix');
      assert.equal(fs.readFileSync(contPath, 'utf8'), stale, 'state must never rewrite the rendered doc it just reported on');

      // Nearest bypass: the remedy the row names actually clears it.
      const w = cli(p.dir, 'savepoint', '--write');
      assert.equal(w.code, 0, `savepoint --write must regenerate cleanly: ${JSON.stringify((w.json && w.json.checks || []).filter((c) => c.outcome !== 'PASS'))}`);
      const clean = cli(p.dir, 'state');
      assert.equal(clean.json.findings.filter((c) => c.check === 'generated-block:docs/derived/CONTINUITY.md').length, 0,
        'after savepoint --write regenerates the doc, a following state must report it clean again');
    } finally { rm(p.dir); }
  });

  test('no generated block yet (a hand-authored, never-rendered doc) is CANNOT_DETERMINE naming the migration', () => {
    const p = project();
    try {
      fs.mkdirSync(path.join(p.dir, 'docs', 'derived'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md'), '# My hand-written continuity doc\n\nSome prose.\n');

      const r = cli(p.dir, 'state');
      assert.equal(r.code, 0, "a never-rendered doc is report-only too — it must not flip state's own exit code either");
      const row = r.json.findings.find((c) => c.check === 'generated-block:docs/derived/CONTINUITY.md');
      assert.ok(row, `expected a generated-block row among: ${r.json.findings.map((c) => c.check).join(', ')}`);
      assert.equal(row.outcome, OUTCOME.CANNOT_DETERMINE);
      assert.match(row.detail, /never been rendered/, 'must name the actual cause');
      assert.match(row.detail, /savepoint --write/, 'must name the migration path forward');
    } finally { rm(p.dir); }
  });
});

describe('goal completion is decided by the STATED CRITERIA, not by the denominator', () => {
  const conformAll = (p, ids) => {
    for (const id of ids) {
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', `${id}.json`), JSON.stringify(evidence(p.head(), [id])));
    }
  };

  test('every mandatory row conformant does NOT complete a goal whose criteria are unmet', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }], gates: { G9: { requires: ['R-1'] } } });
    try {
      // A criterion the compiler CAN evaluate, and which is not satisfied by row conformance alone.
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship', '--completion', 'all-mandatory-conformant;owner-confirmed sign-off');
      conformAll(p, ['R-1']);
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.counts.conformant, state.counts.mandatory, 'sanity: the denominator IS satisfied');
      assert.equal(state.goalComplete, false, 'the denominator completed the goal behind the owner’s stated criteria');
      assert.equal(state.goalCompletion.status, 'UNMET');
      assert.ok(state.goalCompletion.criteria.some((c) => c.kind === 'owner-confirmed' && c.status === 'UNMET'));
    } finally { rm(p.dir); }
  });

  test('all criteria met → complete', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship', '--completion', 'all-mandatory-conformant;no-open-p0');
      conformAll(p, ['R-1']);
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.goalComplete, true);
      assert.equal(state.goalCompletion.status, 'MET');
    } finally { rm(p.dir); }
  });

  test('a free-text criterion is CANNOT_DETERMINE — the compiler will not rule in its own favour', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship', '--completion', 'the editor feels good to use');
      conformAll(p, ['R-1']);
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.goalComplete, false);
      assert.equal(state.goalCompletion.status, 'CANNOT_DETERMINE');
      assert.match(state.cannotDetermine.join(' '), /goal completion/);
    } finally { rm(p.dir); }
  });

  test('a gate criterion tracks the gate, and an omitted row keeps the goal incomplete', () => {
    const reqs = [{ id: 'R-1', mandatory: true, gate: 'G9' }, { id: 'R-2', mandatory: true, gate: 'G9' }];
    const gates = { G9: { requires: ['R-1', 'R-2'] } };
    const p = project({ requirements: reqs, gates });
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship', '--completion', 'gate:G9');
      conformAll(p, ['R-1', 'R-2']);
      assert.equal(stateLib.compile(p.dir).state.goalComplete, true);

      // Scenario H composed with completion: dropping a row must not make the GOAL easier either.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'requirements.json'),
        JSON.stringify({ schemaVersion: '1.0.0', requirements: [reqs[0]], gates }));
      const { state } = stateLib.compile(p.dir);
      assert.equal(state.goalComplete, false, 'omitting a mandatory row completed the goal');
      assert.equal(state.gates[0].status, 'INCOMPLETE_MISSING_ROWS');
    } finally { rm(p.dir); }
  });
});

// --- Scenario N -----------------------------------------------------------------------------------

describe('Scenario N · a gate that ran zero checks is never green', () => {
  const gate = createRequire(import.meta.url)('./lib/gate.js');

  // A bare project directory — no git, no state kernel. The gate must work on any repo.
  const bare = (files = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-gate-'));
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    }
    return dir;
  };
  // Injected exec keeps the OUTCOME LOGIC testable without pytest/cargo/go on the runner. A gate whose
  // own tests skip would be this very defect reproducing one level up.
  const execAll = (code) => () => ({ ran: true, code, output: `stub exit ${code}` });
  const execMissing = () => ({ ran: false, why: 'command not found: stub' });

  test('a Node project with scripts that pass → PASS', () => {
    const dir = bare({ 'package.json': { name: 'x', scripts: { lint: 'x', test: 'x' } } });
    try {
      const r = gate.runGate(dir, { exec: execAll(0) });
      assert.equal(r.outcome, OUTCOME.PASS);
      assert.equal(r.label, 'PASS');
      assert.equal(r.ran, 2);
      assert.equal(exitCodeFor(r.outcome), 0);
    } finally { rm(dir); }
  });

  test('a Node project whose test script fails → FAIL', () => {
    const dir = bare({ 'package.json': { name: 'x', scripts: { test: 'x' } } });
    try {
      const r = gate.runGate(dir, { exec: execAll(1) });
      assert.equal(r.outcome, OUTCOME.FAIL);
      assert.equal(r.label, 'FAIL');
      assert.equal(exitCodeFor(r.outcome), 1);
    } finally { rm(dir); }
  });

  test('⛔ a Node project with NO scripts → NOT_CONFIGURED, not green', () => {
    // The original defect in its own habitat: four steps, four skips, exit 0.
    const dir = bare({ 'package.json': { name: 'x' } });
    try {
      const r = gate.runGate(dir, { exec: execAll(0) });
      assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
      assert.equal(r.label, 'NOT_CONFIGURED');
      assert.notEqual(exitCodeFor(r.outcome), 0, 'a gate that skipped every check reported success');
      assert.equal(r.ran, 0);
      assert.match(r.why, /no meaningful check is configured/);
    } finally { rm(dir); }
  });

  test('⛔ a PYTHON project → detected, and never green-with-zero-checks', () => {
    // The exact case from the evidence map: the installer detects Python, the Node-shaped gate skips
    // everything and reports green.
    const dir = bare({ 'pyproject.toml': '[project]\nname = "thing"\n' });
    try {
      const r = gate.runGate(dir, { exec: execAll(0) });
      assert.ok(r.profiles.some((p) => p.id === 'python'), 'Python was not detected at all');
      assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
      assert.equal(r.label, 'NOT_CONFIGURED');
      assert.notEqual(exitCodeFor(r.outcome), 0);
      assert.match(r.why, /python/);
    } finally { rm(dir); }
  });

  test('a Python project WITH ruff and pytest configured → PASS', () => {
    const dir = bare({ 'pyproject.toml': '[project]\nname = "t"\n[tool.ruff]\n[tool.pytest.ini_options]\n' });
    try {
      const r = gate.runGate(dir, { exec: execAll(0) });
      assert.equal(r.outcome, OUTCOME.PASS, 'a properly configured Python project must be able to pass — the known-good control');
      assert.ok(r.checks.some((c) => c.name === 'lint' && c.bin === 'ruff'));
      assert.ok(r.checks.some((c) => c.name === 'test' && c.bin === 'pytest'));
    } finally { rm(dir); }
  });

  test('⛔ an EMPTY project → NOT_CONFIGURED, and explicitly not NOT_APPLICABLE', () => {
    const dir = bare({ 'README.md': '# nothing here\n' });
    try {
      const r = gate.runGate(dir, { exec: execAll(0) });
      assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
      assert.equal(r.label, 'NOT_CONFIGURED');
      assert.notEqual(r.outcome, OUTCOME.NOT_APPLICABLE, 'finding nothing was treated as a declaration that nothing is needed');
      assert.match(r.why, /NOT_CONFIGURED, not NOT_APPLICABLE/);
      assert.notEqual(exitCodeFor(r.outcome), 0);
    } finally { rm(dir); }
  });

  test('an explicitly opted-out project → NOT_APPLICABLE, and that one IS green', () => {
    const dir = bare({ 'respawnpack.config.json': { qualityGate: { notApplicable: true, reason: 'docs-only repository' } } });
    try {
      const r = gate.runGate(dir, { exec: execAll(0) });
      assert.equal(r.outcome, OUTCOME.NOT_APPLICABLE);
      assert.equal(r.label, 'NOT_APPLICABLE');
      assert.equal(r.declared, true, 'NOT_APPLICABLE must be a declaration, never an inference');
      assert.equal(exitCodeFor(r.outcome), 0, 'a declared opt-out is legitimately green — someone took responsibility for it');
      assert.match(r.why, /docs-only repository/);
    } finally { rm(dir); }
  });

  test('⛔ a configured check whose tool is missing → NOT_CONFIGURED even when others passed', () => {
    // A declared gate that could not execute is an unanswered question. Answering it "fine" because a
    // sibling check went green is the same defect with extra steps.
    const dir = bare({ 'package.json': { name: 'x', scripts: { lint: 'x', test: 'x' } } });
    try {
      let call = 0;
      const exec = () => (++call === 1 ? { ran: true, code: 0, output: 'ok' } : execMissing());
      const r = gate.runGate(dir, { exec });
      assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
      assert.equal(r.label, 'NOT_CONFIGURED');
      assert.match(r.why, /could not run/);
      assert.notEqual(exitCodeFor(r.outcome), 0);
    } finally { rm(dir); }
  });

  test('a FAILING check outranks an unrunnable one — a real failure is never downgraded', () => {
    const dir = bare({ 'package.json': { name: 'x', scripts: { lint: 'x', test: 'x' } } });
    try {
      let call = 0;
      const exec = () => (++call === 1 ? { ran: true, code: 2, output: 'lint broke' } : execMissing());
      assert.equal(gate.runGate(dir, { exec }).outcome, OUTCOME.FAIL);
    } finally { rm(dir); }
  });

  test('a monorepo one level down is planned per root', () => {
    const dir = bare({
      'backend/pyproject.toml': '[project]\nname="b"\n[tool.pytest.ini_options]\n',
      'frontend/package.json': { name: 'f', scripts: { build: 'x' } },
    });
    try {
      const r = gate.runGate(dir, { exec: execAll(0) });
      assert.equal(r.outcome, OUTCOME.PASS);
      assert.ok(r.checks.some((c) => c.root === 'backend' && c.name === 'test'));
      assert.ok(r.checks.some((c) => c.root === 'frontend' && c.name === 'build'));
    } finally { rm(dir); }
  });

  test('an explicit check list overrides detection — a Makefile project is a real project', () => {
    const dir = bare({ 'Makefile': 'test:\n\techo ok\n' });
    try {
      const r = gate.runGate(dir, {
        config: { checks: [{ name: 'test', command: 'make', args: ['test'] }] },
        exec: execAll(0),
      });
      assert.equal(r.outcome, OUTCOME.PASS);
      assert.equal(r.ran, 1);
    } finally { rm(dir); }
  });

  test('the CLI reports the outcome and exits non-zero on a zero-check run', () => {
    const dir = bare({ 'package.json': { name: 'x' } });
    try {
      const r = spawnSync(process.execPath, [CLI, 'gate', '--dir', dir, '--json'], { encoding: 'utf8' });
      const j = JSON.parse(r.stdout);
      assert.equal(j.outcome, 'CANNOT_DETERMINE');
      assert.equal(j.label, 'NOT_CONFIGURED');
      assert.equal(r.status, 2, 'the CI job must fail on a gate that established nothing');
    } finally { rm(dir); }
  });

  test('the CLI exits 0 for a declared opt-out', () => {
    const dir = bare({ 'respawnpack.config.json': { qualityGate: { notApplicable: true, reason: 'prose only' } } });
    try {
      const r = spawnSync(process.execPath, [CLI, 'gate', '--dir', dir, '--json'], { encoding: 'utf8' });
      assert.equal(JSON.parse(r.stdout).outcome, 'NOT_APPLICABLE');
      assert.equal(r.status, 0);
    } finally { rm(dir); }
  });

  test('end to end with the real runner: a genuinely passing and a genuinely failing script', () => {
    // One test that does NOT inject exec, so the spawn path itself is covered rather than assumed.
    const ok = bare({ 'package.json': { name: 'x', scripts: { test: 'node -e "process.exit(0)"' } } });
    const bad = bare({ 'package.json': { name: 'x', scripts: { test: 'node -e "process.exit(1)"' } } });
    try {
      assert.equal(gate.runGate(ok).outcome, OUTCOME.PASS);
      assert.equal(gate.runGate(bad).outcome, OUTCOME.FAIL);
    } finally { rm(ok); rm(bad); }
  });

  /*
   * ⛔ K-09 · THE UNIFICATION MUST NOT MOVE A SINGLE EXIT CODE (anti-drift item 3).
   *
   * The gate used to own a second exit map — `gate.EXIT` — beside `outcome.js`'s `exitCodeFor`. Two
   * tables for one meaning agreed only because somebody kept them agreeing, and the day they stopped,
   * a caller would have read "could not run" as "failed" or, far worse, as success. Deleting the
   * duplicate is only safe if it is DEMONSTRATED that nothing moved, which a test asserting today's
   * behaviour against itself cannot do.
   *
   * So `exitBefore` below is not derived from the code under test: it is the process exit code each
   * recipe produced on the unmodified tree at 10c150d, captured by running `gate --json` on each one
   * before the change and pinned here. `labelBefore` is the word that run printed. A future edit that
   * re-points a label at a different outcome fails here, naming the recipe.
   *
   * Every recipe drives the REAL CLI, and the two that must actually execute something use this
   * process's own node binary rather than a package manager, so all four outcomes are reachable on a
   * runner with no toolchain installed — the alternative is a gate test that skips, which is Scenario
   * N reproducing one level up.
   */
  const EXIT_TABLE = [
    {
      what: 'a declared check that runs and exits 0',
      files: { 'respawnpack.config.json': { qualityGate: { checks: [{ name: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] }] } } },
      labelBefore: 'PASS', outcome: 'PASS', exitBefore: 0,
    },
    {
      what: 'a declared check that runs and exits 1',
      files: { 'respawnpack.config.json': { qualityGate: { checks: [{ name: 'test', command: process.execPath, args: ['-e', 'process.exit(1)'] }] } } },
      labelBefore: 'FAIL', outcome: 'FAIL', exitBefore: 1,
    },
    {
      what: 'a Node project with no scripts — detected, nothing runnable',
      files: { 'package.json': { name: 'x' } },
      labelBefore: 'NOT_CONFIGURED', outcome: 'CANNOT_DETERMINE', exitBefore: 2,
    },
    {
      what: 'a declared opt-out with a reason',
      files: { 'respawnpack.config.json': { qualityGate: { notApplicable: true, reason: 'a documentation-only repository' } } },
      labelBefore: 'NOT_APPLICABLE', outcome: 'NOT_APPLICABLE', exitBefore: 0,
    },
  ];

  test('⛔ K-09 · outcome→exit for the gate verb, on all four outcomes, unchanged from before the unification', () => {
    for (const row of EXIT_TABLE) {
      const dir = bare(row.files);
      try {
        const r = spawnSync(process.execPath, [CLI, 'gate', '--dir', dir, '--json'], { encoding: 'utf8' });
        const j = JSON.parse(r.stdout);
        assert.equal(r.status, row.exitBefore,
          `${row.what}: exited ${r.status}, but the same recipe exited ${row.exitBefore} before the vocabulary was unified — K-09 moved an exit code`);
        assert.equal(j.outcome, row.outcome, `${row.what}: mapped to ${j.outcome}, not ${row.outcome}`);
        assert.equal(j.label, row.labelBefore, `${row.what}: lost the gate's own word (${row.labelBefore}), which is the whole reason \`label\` exists`);
        assert.equal(j.exitCode, exitCodeFor(j.outcome),
          `${row.what}: the verdict document's exitCode disagrees with exitCodeFor — the artifact CI uploads is not the code CI got`);
        assert.equal(j.exitCode, r.status, `${row.what}: the process exited ${r.status} while the verdict claims ${j.exitCode}`);
      } finally { rm(dir); }
    }
  });

  test('⛔ K-09 · a NOT_CONFIGURED gate still exits 2, and says CANNOT_DETERMINE with label NOT_CONFIGURED', () => {
    // Anti-drift item 12: a reason-less opt-out is never accepted. The word an operator reads is still
    // NOT_CONFIGURED — "you declared an opt-out and did not justify it" — while the code that decides
    // CI is the shared CANNOT_DETERMINE, at the exit 2 it has always had.
    const dir = bare({ 'respawnpack.config.json': { qualityGate: { notApplicable: true } } });
    try {
      const r = spawnSync(process.execPath, [CLI, 'gate', '--dir', dir, '--json'], { encoding: 'utf8' });
      const j = JSON.parse(r.stdout);
      assert.equal(r.status, 2, 'an unjustified opt-out reported something other than "I could not tell"');
      assert.equal(j.outcome, 'CANNOT_DETERMINE');
      assert.equal(j.label, 'NOT_CONFIGURED');
      assert.notEqual(j.outcome, 'FAIL', 'an incomplete declaration was reported as a broken gate, which is a claim nobody measured');
      assert.match(j.why, /an opt-out nobody has to justify is an opt-out nobody reviews/);
      assert.equal(j.ran, 0);
    } finally { rm(dir); }
  });

  test('⛔ K-09 · a partial gate with one COULD_NOT_RUN still refuses, and names the run that could not run', () => {
    /*
     * Anti-drift item 13: the gate is never green on a check that could not run. One check passes for
     * real and one names a binary that does not exist, so the run has a genuine green beside a genuine
     * unknown — the exact shape where "well, something passed" is tempting.
     */
    const dir = bare({
      'respawnpack.config.json': {
        qualityGate: {
          checks: [
            { name: 'lint', command: process.execPath, args: ['-e', 'process.exit(0)'] },
            { name: 'test', command: 'respawnpack-no-such-binary-x9', args: [] },
          ],
        },
      },
    });
    try {
      const r = spawnSync(process.execPath, [CLI, 'gate', '--dir', dir, '--json'], { encoding: 'utf8' });
      const j = JSON.parse(r.stdout);
      assert.equal(r.status, 2, 'a gate with an unrunnable check reported something other than "I could not tell"');
      assert.equal(j.outcome, 'CANNOT_DETERMINE');
      assert.equal(j.label, 'NOT_CONFIGURED');

      const passed = j.checks.find((c) => c.check === 'gate:.:lint');
      const unrunnable = j.checks.find((c) => c.check === 'gate:.:test');
      assert.equal(passed.outcome, 'PASS', 'the control did not pass, so this fixture is not the partial-gate shape');
      assert.equal(unrunnable.outcome, 'CANNOT_DETERMINE');
      assert.equal(unrunnable.label, 'COULD_NOT_RUN', 'the row lost the word that separates "the tool is missing" from "the check disagreed"');
      assert.notEqual(unrunnable.outcome, 'FAIL', 'a check that never started was reported as one that ran and failed');
      assert.equal(unrunnable.checked, 0, 'a check that could not start reported having examined something');

      // ⛔ NAMED, not merely counted: the verdict must say WHICH run could not run, or the operator is
      // told the gate is unanswered without being told what to install.
      assert.match(j.why, /1 configured check\(s\) could not run/);
      assert.match(j.why, /\.:test/);
      assert.match(j.why, /respawnpack-no-such-binary-x9/);
    } finally { rm(dir); }
  });

  test('⛔ K-09 · gate.js defines no RANK or EXIT of its own, and every gate row carries the seven contract fields', () => {
    // Half one, read off the source: the private tables are gone, not merely unused. A re-introduced
    // RANK or EXIT is a second vocabulary growing back, which is what K-09 removed.
    const src = fs.readFileSync(path.join(KERNEL, 'lib', 'gate.js'), 'utf8');
    for (const table of ['RANK', 'EXIT', 'GATE']) {
      assert.doesNotMatch(src, new RegExp(`^const ${table}\\s*=`, 'm'),
        `kernel/lib/gate.js declares ${table} again — the gate has grown back a vocabulary of its own, and two tables for one meaning agree only until they do not`);
    }
    assert.equal(gate.EXIT, undefined, 'kernel/lib/gate.js still exports EXIT, so a caller can still take an exit code from somewhere other than exitCodeFor');
    assert.equal(gate.RANK, undefined, 'kernel/lib/gate.js still exports RANK');
    assert.equal(gate.GATE, undefined, 'kernel/lib/gate.js still exports GATE');

    /*
     * Half two, read off a REAL run rather than the source: both row shapes the gate can emit — one
     * that ran and one that was never configured — carry the whole contract. A row missing `domain` or
     * `subject` still validates as prose and still prints, which is exactly how a field that nothing
     * asserts on quietly stops being emitted.
     */
    const dir = bare({
      'package.json': { name: 'x', scripts: { lint: 'x' } }, // `test`/`typecheck`/`build` unconfigured
    });
    try {
      const r = gate.runGate(dir, { exec: execAll(0) });
      assert.ok(r.checks.length >= 2, 'the fixture did not produce both a configured and an unconfigured row');
      assert.ok(r.checks.some((c) => c.label === 'PASS') && r.checks.some((c) => c.label === 'NOT_CONFIGURED'),
        'both row shapes must appear, or this fence covers one of them');
      for (const c of r.checks) {
        for (const field of ['outcome', 'check', 'detail', 'checked', 'domain', 'subject', 'label']) {
          assert.ok(Object.prototype.hasOwnProperty.call(c, field),
            `${c.check || c.name}: the row has no "${field}" — the gate no longer emits the shared row contract`);
        }
        assert.equal(c.domain, 'gate');
        assert.equal(c.check, `gate:${c.root}:${c.name}`, 'the check id is no longer the stable gate:<root>:<name> parameterisation');
        assert.equal(c.outcome, gate.LABEL_OUTCOME[c.label], `${c.check}: label ${c.label} did not map through LABEL_OUTCOME`);
        assert.ok(c.subject, `${c.check}: emitted no subject, so the row does not say what it looked at`);
      }
    } finally { rm(dir); }
  });
});

// --- Scenario Q-1 -----------------------------------------------------------------------------------

/*
 * ⛔ Q-1 · GATE PRESETS FOUND BY DETECTION (the second run's task list, P2-Q-1).
 *
 * `detectProfiles` knew four stacks — Node, Python, Go, Rust — and nothing about infrastructure code,
 * shell, containers or documentation repositories, which are three of the four archetypes the pack is
 * actually installed into (the class audit Class E). This block proves the six additions the same
 * way Scenario N proves the original four: PLANNING only, on real archetype fixtures from
 * `ops/_project-fixtures.mjs` (never hand-rolled trees standing in for what a real project looks like),
 * with a synthetic PATH injected through `env` so "is this tool configured" never depends on what this
 * machine or this CI runner happens to have installed. No test here spawns a real linter.
 */
describe('Q-1 · quality gate presets found by detection', () => {
  const gate = createRequire(import.meta.url)('./lib/gate.js');

  let q1Seq = 0;
  const tmp = (label) => { q1Seq += 1; return fs.mkdtempSync(path.join(os.tmpdir(), `rp-gate-q1-${label}-${q1Seq}-`)); };
  // A controlled, EMPTY PATH: a directory with nothing in it, never the real machine's PATH — so
  // "configured: false" here can only mean the fixture genuinely lacks the tool, never that this
  // developer's or this runner's own machine happens not to have it installed.
  const emptyPathEnv = () => ({ PATH: tmp('emptypath') });
  // A controlled PATH carrying exactly one fake binary — proves the "or the binary resolves" half of
  // `configured` without requiring the real tool to be installed anywhere.
  const pathWithFakeBin = (name) => {
    const binDir = tmp(`fakebin-${name}`);
    fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n');
    return { PATH: binDir };
  };
  const fakeLocalBin = (dir, root, name) => {
    const binDir = path.join(dir, root, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n');
    return path.join(binDir, name);
  };

  test('ops-infra (plus a Dockerfile the shared fixture does not ship) detects terraform, ansible, shell and docker, and plans their commands', () => {
    const dir = tmp('ops-infra');
    try {
      materializeFixture('ops-infra', dir, { git: false });
      // ops/_project-fixtures.mjs's ops-infra archetype carries a docker-compose.yml, deliberately not a
      // Dockerfile (see its own header note): added here, locally, only to prove the docker planner —
      // ops/_project-fixtures.mjs itself is out of this task's scope.
      fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM alpine:3.19\n');

      const ids = gate.detectProfiles(dir).map((p) => p.id);
      for (const id of ['terraform', 'ansible', 'shell', 'docker']) {
        assert.ok(ids.includes(id), `${id} was not detected: ${ids.join(', ')}`);
      }

      const planned = gate.planChecks(dir, {}, emptyPathEnv());
      const fmt = planned.find((c) => c.name === 'fmt');
      const validate = planned.find((c) => c.name === 'validate');
      assert.equal(fmt.configured, true, '*.tf existing is itself terraform fmt\'s configuration, the way go.mod is for go vet');
      assert.deepEqual(fmt.args, ['fmt', '-check', '-recursive']);
      assert.equal(validate.configured, true);
      assert.deepEqual(validate.args, ['validate']);

      // ansible-lint's OWN config is `.ansible-lint`, distinct from `ansible.cfg` (which proves the
      // Ansible STACK, not that ansible-lint specifically is set up) — the fixture ships the former and
      // not the latter, so this is the honest "planned, not configured" row; ansible-lint's own
      // configured/not-configured pair follows exactly the shellcheck logic proved below.
      const ansibleLint = planned.find((c) => c.name === 'ansible-lint');
      assert.ok(ansibleLint, 'ansible-lint was not planned at all');
      assert.equal(ansibleLint.profile, 'ansible');

      const shellcheck = planned.find((c) => c.name === 'shellcheck');
      assert.equal(shellcheck.configured, true, '.shellcheckrc exists, so shellcheck should be configured');
      assert.deepEqual(shellcheck.args, ['scripts/teardown.sh'], 'shellcheck must run over the files detection actually found, not a glob');

      const hadolint = planned.find((c) => c.name === 'hadolint');
      assert.ok(hadolint, 'hadolint was not planned at all, even with a Dockerfile present');
      assert.equal(hadolint.profile, 'docker');
    } finally { rm(dir); }
  });

  test('shellcheck is configured when .shellcheckrc exists', () => {
    const dir = tmp('ops-infra-shellcheckrc');
    try {
      materializeFixture('ops-infra', dir, { git: false });
      const shellcheck = gate.planChecks(dir, {}, emptyPathEnv()).find((c) => c.name === 'shellcheck');
      assert.equal(shellcheck.configured, true);
    } finally { rm(dir); }
  });

  test('⛔ without .shellcheckrc and without the binary on a controlled empty PATH, shellcheck is NOT configured, naming both absences', () => {
    const dir = tmp('ops-infra-no-shellcheckrc');
    try {
      materializeFixture('ops-infra', dir, { git: false });
      fs.rmSync(path.join(dir, '.shellcheckrc'));
      const shellcheck = gate.planChecks(dir, {}, emptyPathEnv()).find((c) => c.name === 'shellcheck');
      assert.equal(shellcheck.configured, false, 'no config and no binary must never be dressed up as configured');
      assert.match(shellcheck.why, /\.shellcheckrc/, 'the reason does not name the missing config file');
      assert.match(shellcheck.why, /PATH/, 'the reason does not name the missing binary');
    } finally { rm(dir); }
  });

  test('shellcheck is configured again once the binary alone resolves on a controlled PATH — the OR half of the rule', () => {
    const dir = tmp('ops-infra-bin-only');
    try {
      materializeFixture('ops-infra', dir, { git: false });
      fs.rmSync(path.join(dir, '.shellcheckrc'));
      const shellcheck = gate.planChecks(dir, {}, pathWithFakeBin('shellcheck')).find((c) => c.name === 'shellcheck');
      assert.equal(shellcheck.configured, true, 'a resolvable binary alone must be enough — the config and the binary are each sufficient on their own');
    } finally { rm(dir); }
  });

  test('greenfield-app with a lint script plans it exactly as before — unchanged', () => {
    const dir = tmp('greenfield-lint-script');
    try {
      materializeFixture('greenfield-app', dir, { git: false });
      const lint = gate.planChecks(dir, {}, emptyPathEnv()).find((c) => c.name === 'lint');
      assert.equal(lint.configured, true);
      assert.equal(lint.bin, 'npm');
      assert.deepEqual(lint.args, ['run', 'lint']);
    } finally { rm(dir); }
  });

  test('greenfield-app without a lint script, with .eslintrc.json and a fake local eslint binary, plans ESLint', () => {
    const dir = tmp('greenfield-eslint-bin');
    try {
      materializeFixture('greenfield-app', dir, { git: false });
      const pkgPath = path.join(dir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      delete pkg.scripts.lint;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      const bin = fakeLocalBin(dir, '.', 'eslint');

      const lint = gate.planChecks(dir, {}, emptyPathEnv()).find((c) => c.name === 'lint');
      assert.equal(lint.configured, true, 'an .eslintrc.json plus a local eslint binary must plan lint');
      assert.equal(lint.bin, bin);
      assert.deepEqual(lint.args, ['.']);
    } finally { rm(dir); }
  });

  test('⛔ greenfield-app without a lint script and without the fake binary does NOT plan ESLint, despite .eslintrc.json existing', () => {
    const dir = tmp('greenfield-eslint-nobin');
    try {
      materializeFixture('greenfield-app', dir, { git: false });
      const pkgPath = path.join(dir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      delete pkg.scripts.lint;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      // .eslintrc.json is still there — materialize wrote it — and no node_modules/.bin/eslint this time.

      const lint = gate.planChecks(dir, {}, emptyPathEnv()).find((c) => c.name === 'lint');
      assert.equal(lint.configured, false, 'a config with no locally installed tool is not a check anyone can run');
      assert.match(lint.why, /eslint/i, 'the reason does not name the missing eslint binary');
    } finally { rm(dir); }
  });

  test('docs-only plans markdownlint only with a fake local binary', () => {
    const dir = tmp('docs-only-mdlint-bin');
    try {
      materializeFixture('docs-only', dir, { git: false });
      const bin = fakeLocalBin(dir, '.', 'markdownlint');

      const mdlint = gate.planChecks(dir, {}, emptyPathEnv()).find((c) => c.name === 'markdownlint');
      assert.ok(mdlint, 'markdownlint was not planned at all');
      assert.equal(mdlint.configured, true);
      assert.equal(mdlint.bin, bin);
    } finally { rm(dir); }
  });

  test('⛔ docs-only without a local markdownlint binary is NOT configured, despite .markdownlint.json existing', () => {
    const dir = tmp('docs-only-mdlint-nobin');
    try {
      materializeFixture('docs-only', dir, { git: false });
      const mdlint = gate.planChecks(dir, {}, emptyPathEnv()).find((c) => c.name === 'markdownlint');
      assert.ok(mdlint, 'markdownlint was not planned at all');
      assert.equal(mdlint.configured, false, 'an npm-ecosystem tool\'s config alone is never enough — see resolveLocalBin');
      assert.match(mdlint.why, /markdownlint/);
    } finally { rm(dir); }
  });

  test('a tree with none of the new evidence detects nothing new and stays NOT_CONFIGURED at exit 2', () => {
    const dir = tmp('nothing-new');
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), '# nothing here\n');
      const ids = gate.detectProfiles(dir).map((p) => p.id);
      assert.deepEqual(ids, [], `detected profiles on a plain README-only tree: ${ids.join(', ')}`);

      const r = gate.runGate(dir, { exec: () => ({ ran: true, code: 0, output: '' }) });
      assert.equal(r.label, 'NOT_CONFIGURED');
      assert.equal(exitCodeFor(r.outcome), 2);
    } finally { rm(dir); }
  });

  test('shell detection skips *.sh inside node_modules and .git, and still finds a genuine root-level script', () => {
    const dir = tmp('shell-exclusions');
    try {
      fs.mkdirSync(path.join(dir, 'node_modules', 'somedep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'somedep', 'install.sh'), '#!/bin/sh\necho hi\n');
      fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit.sh'), '#!/bin/sh\necho hi\n');

      const before = gate.detectProfiles(dir).map((p) => p.id);
      assert.ok(!before.includes('shell'), `shell was detected from inside node_modules or .git: ${before.join(', ')}`);

      fs.writeFileSync(path.join(dir, 'deploy.sh'), '#!/bin/sh\necho hi\n');
      const after = gate.detectProfiles(dir).map((p) => p.id);
      assert.ok(after.includes('shell'), 'a genuine root-level .sh file was not detected once one existed');
    } finally { rm(dir); }
  });

  test('a custom checks list still overrides detection, even when ops-infra evidence is present', () => {
    const dir = tmp('ops-infra-custom-checks');
    try {
      materializeFixture('ops-infra', dir, { git: false });
      const planned = gate.planChecks(dir, {
        checks: [{ name: 'custom-test', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      }, emptyPathEnv());
      assert.equal(planned.length, 1, `a declared checks list must fully replace detection, got: ${planned.map((c) => c.name).join(', ')}`);
      assert.equal(planned[0].name, 'custom-test');
      assert.equal(planned[0].configured, true);
    } finally { rm(dir); }
  });

  // The vocabulary fence itself lives in counts-fence.test.mjs and in the K-09 block above (gate.EXIT /
  // gate.RANK / gate.GATE stay undefined, LABEL_OUTCOME stays exactly five keys); nothing in Q-1 adds a
  // sixth outcome word, so this proves the mapping is still exactly what it was rather than re-asserting
  // the fence.
  test('Q-1 adds no new outcome label — LABEL_OUTCOME still maps exactly PASS, FAIL, NOT_APPLICABLE, NOT_CONFIGURED, COULD_NOT_RUN', () => {
    assert.deepEqual(Object.keys(gate.LABEL_OUTCOME).sort(),
      ['COULD_NOT_RUN', 'FAIL', 'NOT_APPLICABLE', 'NOT_CONFIGURED', 'PASS']);
  });
});

/*
 * ⛔ K-09, THE DOCTOR HALF (P4-K-09b) — THE SECOND PRIVATE EXIT MAP, AND WHY REMOVING IT MOVED NOTHING.
 *
 * `doctor` spoke a twelve-word vocabulary of its own — ACTIVE, SILENTLY INACTIVE, STALE, UNSUPPORTED —
 * and collapsed it into an exit code through a hardcoded `GREEN` allowlist. That allowlist was the
 * kernel's LAST verdict-to-exit table beside `exitCodeFor`, and it is the same hazard the gate's `EXIT`
 * was: two maps for one meaning agree only while somebody keeps them agreeing, and the failure when
 * they stop is a caller reading "I could not tell" as "fine". The words themselves were never the
 * problem — they are the diagnosis an operator acts on — so they survive as `label`, and only the
 * second exit map is gone.
 *
 * ⛔ EVERY NUMBER BELOW WAS READ OFF THE UNMODIFIED TREE AT cb30211, BEFORE THE FIRST EDIT, and pinned
 * here as a literal. A test that asserted today's behaviour against today's code could not tell a
 * preserved exit code from a moved one. The same capture also compared 354 rows across 14 kernel and
 * install fixtures for `check == old component` and `label == old status`; these are its two ends —
 * every verb's exit on an undecided project and on a fully decided one.
 */
describe('K-09 · doctor speaks the shared vocabulary, and not one exit code moved', () => {
  /** A bare git repository, optionally carrying a respawnpack.config.json — the capture's own fixture. */
  const doctorFixture = (config = null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-k09doctor-'));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'k@respawnpack.test'); git('config', 'user.name', 'Kernel');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    if (config !== null) fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify(config, null, 2));
    git('add', '-A'); git('commit', '--quiet', '-m', 'init');
    return dir;
  };
  const DECIDED = {
    routeSource: { notApplicable: true, reason: 'a library with no web surface' },
    codeTruth: { notApplicable: true, reason: 'no token, copy or schema source outranks the prose here' },
    qualityGate: { notApplicable: true, reason: 'no build system is configured for this fixture' },
    state: {
      removals: { notApplicable: true, reason: 'no capability has been retired yet' },
      reconcile: { notApplicable: true, reason: 'this project has no structured task source' },
    },
  };

  //                                   undecided        fully decided
  const EXIT_BEFORE = {
    state: [0, 0],
    'savepoint --verify': [2, 0],
    'savepoint --write': [2, 0],
    status: [0, 0],
    doctor: [2, 0],
    gate: [2, 0],
    removals: [2, 0],
    reconcile: [2, 0],
    living: [1, 1],
    'memory candidates': [0, 0],
    contract: [0, 0],
    'restore-derived CONTINUITY.md': [2, 2],
    'not-a-verb': [1, 1],
  };
  const OUTCOME_BEFORE = {
    state: ['NOT_APPLICABLE', 'NOT_APPLICABLE'],
    'savepoint --verify': ['CANNOT_DETERMINE', 'PASS'],
    'savepoint --write': ['CANNOT_DETERMINE', 'PASS'],
    status: ['PASS', 'PASS'],
    doctor: ['CANNOT_DETERMINE', 'PASS'],
    gate: ['CANNOT_DETERMINE', 'NOT_APPLICABLE'],
    removals: ['CANNOT_DETERMINE', 'NOT_APPLICABLE'],
    reconcile: ['CANNOT_DETERMINE', 'NOT_APPLICABLE'],
    living: ['FAIL', 'FAIL'],
    'memory candidates': ['PASS', 'PASS'],
    contract: ['PASS', 'PASS'],
    'restore-derived CONTINUITY.md': ['CANNOT_DETERMINE', 'CANNOT_DETERMINE'],
    'not-a-verb': [null, null], // prints usage and emits no outcome; exits 1 (anti-drift item 17)
  };

  test('⛔ K-09 · the table: outcome→exit for EVERY verb, unchanged from before the unification', () => {
    const configs = [null, DECIDED];
    for (const [verb, codes] of Object.entries(EXIT_BEFORE)) {
      configs.forEach((config, i) => {
        const dir = doctorFixture(config);
        try {
          const r = cli(dir, ...verb.split(' '));
          assert.equal(r.code, codes[i],
            `${verb} on the ${i ? 'fully decided' : 'undecided'} fixture exited ${r.code}, but the same recipe exited `
            + `${codes[i]} before the vocabulary was unified — K-09 moved an exit code`);
          const before = OUTCOME_BEFORE[verb][i];
          const now = r.json && typeof r.json.outcome === 'string' ? r.json.outcome : null;
          assert.equal(now, before, `${verb}: reported ${now}, not the ${before} it reported before the unification`);
          // ⛔ And the exit came from the ONE map, not from a right-looking number reached another way
          // (anti-drift items 1 and 2). A verb that emits an outcome must exit exactly exitCodeFor(it).
          if (now) {
            assert.equal(r.code, exitCodeFor(now),
              `${verb}: reported ${now} and exited ${r.code} — a second exit map has appeared`);
          }
        } finally { rm(dir); }
      });
    }
  });

  test('⛔ K-09 · a SILENTLY INACTIVE hook still PRINTS that word, and still rolls up to CANNOT_DETERMINE at exit 2', () => {
    /*
     * The row this whole verb exists for: a hook present on disk and wired nowhere. "Present" is not
     * "active", and the three-word phrase is what tells an operator which of the two they have. Losing
     * it to a flat CANNOT_DETERMINE would spend the precision that made doctor grow a private
     * vocabulary in the first place — which is why `label` exists and why it is asserted on the TEXT
     * output too, not only in --json.
     */
    const p = project({ requirements: [] });
    try {
      fs.mkdirSync(path.join(p.dir, '.claude', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, '.claude', 'hooks', 'idle-hook.js'), '// never wired\n');
      fs.writeFileSync(path.join(p.dir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));

      const r = cli(p.dir, 'doctor');
      const row = r.json.rows.find((x) => x.check === 'hook:idle-hook.js');
      assert.ok(row, 'the unwired hook got no row at all — an inventory that cannot report an inertness reports nothing');
      assert.equal(row.label, 'SILENTLY INACTIVE', 'doctor lost the word that separates a wired hook from an inert one');
      assert.equal(row.outcome, OUTCOME.CANNOT_DETERMINE,
        'a hook nobody wired was classified as something other than "this has established nothing"');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE', 'the row did not reach the verdict — the rollup is not reading it');
      assert.equal(r.code, 2, 'SILENTLY INACTIVE used to exit 2 through the GREEN set and must still exit 2 through the outcome');

      // The human-readable report is where an operator actually meets the word.
      const text = spawnSync(process.execPath, [CLI, 'doctor', '--dir', p.dir], { encoding: 'utf8' });
      assert.match(text.stdout, /SILENTLY INACTIVE {2,}hook:idle-hook\.js/,
        'the printed report no longer leads the line with doctor\'s own word');
    } finally { rm(p.dir); }
  });

  test('⛔ K-09 · a BROKEN subsystem is still a FAIL row at a non-zero exit, and still not a stack trace', () => {
    /*
     * Anti-drift item 17, unchanged by the vocabulary: a kernel subsystem that will not load is a row,
     * never a traceback, and BROKEN is the one word that maps to FAIL. Exit 1 rather than 2 is the
     * distinction the whole four-outcome contract exists to keep — "this is broken" is not "I could not
     * tell", and collapsing them is what makes an operator stop reading either.
     */
    const p = project({ requirements: [] });
    try {
      const hooks = path.join(p.dir, '.claude', 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, 'probe-hook.js'), "require('./_broken-lib.js');\n");
      fs.writeFileSync(path.join(hooks, '_broken-lib.js'), 'this is not valid javascript (((\n');
      fs.writeFileSync(path.join(p.dir, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/probe-hook.js' }] }] } }));

      const r = cli(p.dir, 'doctor');
      const broken = (r.json.rows || []).filter((x) => x.label === 'BROKEN');
      assert.ok(broken.length, 'a subsystem that cannot load produced no BROKEN row');
      for (const row of broken) {
        assert.equal(row.outcome, OUTCOME.FAIL, `${row.check}: BROKEN is the one word that means FAIL, and it did not map there`);
      }
      assert.equal(r.json.outcome, 'FAIL');
      assert.equal(r.code, 1, 'a broken subsystem must exit 1 — "broken" and "could not tell" are different answers with different codes');
      assert.notEqual(r.code, 2, 'a real breakage was reported as an unanswered question');
      assert.doesNotMatch(r.stderr, /^\s+at\s/m, 'doctor printed a raw stack instead of a row (anti-drift item 17)');
    } finally { rm(p.dir); }
  });

  test('⛔ K-09 · every doctor row carries the seven contract fields, and the green set is expressed ONCE, in outcomes', () => {
    /*
     * ⛔ HALF ONE, READ OFF THE SOURCE: the private allowlist is GONE, not merely unused, and there is
     * exactly one table classifying doctor's words. A second one — or a revived `GREEN` — is the
     * duplicate exit map growing back.
     */
    const src = fs.readFileSync(CLI, 'utf8');
    assert.doesNotMatch(src, /const GREEN\s*=/,
      'kernel/respawnpack.js declares a GREEN set again — doctor has grown back a second verdict-to-exit map beside exitCodeFor');
    assert.equal((src.match(/^const DOCTOR_OUTCOME\s*=/gm) || []).length, 1,
      'doctor\'s word classification is declared somewhere other than exactly once, so two places now decide what a word means');
    assert.match(src, /const worst = rollup\(rows\);/,
      'doctor no longer derives its verdict from the shared rollup, which is the only thing that keeps its exit map from drifting');

    /*
     * ⛔ HALF TWO, READ OFF REAL RUNS: the mapping the table claims is the mapping the rows carry, and
     * the fallthrough really is CANNOT_DETERMINE. Restated here rather than imported, deliberately —
     * a fence that read the table under test would agree with any re-classification somebody made.
     */
    const MAPPING = {
      ACTIVE: 'PASS', CONFIGURED: 'PASS', CURRENT: 'PASS', COMPLETE: 'PASS', INSTALLED: 'PASS',
      NOT_CONFIGURED: 'NOT_APPLICABLE', NOT_APPLICABLE: 'NOT_APPLICABLE', UNSUPPORTED: 'NOT_APPLICABLE',
      BROKEN: 'FAIL',
    };
    const FIELDS = ['outcome', 'check', 'detail', 'checked', 'domain', 'subject', 'label'];
    const seen = new Set();
    for (const config of [null, DECIDED, { posture: { profile: 'light' } }]) {
      const dir = doctorFixture(config);
      try {
        const rows = cli(dir, 'doctor').json.rows || [];
        assert.ok(rows.length, 'doctor emitted no rows at all, so this fence covers nothing');
        for (const row of rows) {
          for (const field of FIELDS) {
            assert.ok(Object.prototype.hasOwnProperty.call(row, field),
              `${row.check || row.label}: the row has no "${field}" — doctor no longer emits the shared row contract`);
          }
          assert.equal(row.outcome, MAPPING[row.label] || 'CANNOT_DETERMINE',
            `${row.check}: the word ${row.label} maps to ${row.outcome}, which is not what the contract says it means`);
          assert.ok(['integrity', 'coverage', 'install', 'gate'].includes(row.domain), `${row.check}: domain ${row.domain} is outside the four`);
          assert.ok(row.subject, `${row.check}: emitted no subject, so the row does not say what it looked at`);
          assert.equal(row.checked, 1, `${row.check}: a doctor row is one component's verdict and must report having examined it`);
          seen.add(row.label);
        }
      } finally { rm(dir); }
    }
    // The fence must actually span the mapping, or it is asserting a tautology over one word.
    for (const word of ['ACTIVE', 'NOT_CONFIGURED', 'UNDECIDED']) {
      assert.ok(seen.has(word), `no fixture here produced a ${word} row, so that branch of the mapping is unfenced`);
    }
    assert.ok(seen.size >= 4, `only ${seen.size} distinct word(s) appeared across three fixtures — this fence is not discriminating`);
  });
});

// --- the memory writer ----------------------------------------------------------------------------

describe('DF-001 / DF-008 · memory capture is a declined action, not an omitted one', () => {
  test('savepoint proposes structured memory entries when something failed', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'a.json'), JSON.stringify(evidence('deadbeefdeadbeef', ['R-1'])));
      const r = cli(p.dir, 'savepoint', '--verify');
      const props = r.json.memoryProposals;
      assert.ok(props.length, 'nothing proposed — capture stayed an omitted action, which is exactly DF-008');
      const stale = props.find((m) => /stopped counting/.test(m.symptom));
      assert.ok(stale, 'a stale-evidence rejection is a durable, retrievable lesson');
      for (const field of ['symptom', 'applicability', 'evidencePath', 'revision']) {
        assert.ok(field in stale, `proposal is missing ${field}`);
      }
    } finally { rm(p.dir); }
  });
});

// --- W5 · candidate memories ------------------------------------------------------------------------
//
// core/memory/candidates.js owns the record/audit machinery (see core/core.test.mjs for its own unit
// coverage); these fixtures wire it from `savepoint` and the new `memory` verb the same way every other
// scenario in this file exercises a kernel verb — through the real CLI, on a real temp project, reading
// the real files it wrote. The store is the PROJECT's tracked `memory/candidates/` directory, named
// outright by the kernel through core/memory/candidates.js's exact-directory form (see the comment
// above runCandidateCapture() in kernel/respawnpack.js) rather than inherited from the module's default
// `memory` leaf — so these paths are asserted here, not derived from the module that writes them.

describe('W5 · savepoint captures evidence-backed candidate memories, mechanically', () => {
  const memDir = (dir) => path.join(dir, 'memory', 'candidates');
  const readCandidates = (dir) => {
    let names = [];
    try { names = fs.readdirSync(memDir(dir)).filter((f) => f.startsWith('cm_') && f.endsWith('.json')); } catch { /* none yet */ }
    return names.map((n) => JSON.parse(fs.readFileSync(path.join(memDir(dir), n), 'utf8')));
  };
  const readAudit = (dir) => {
    try { return fs.readFileSync(path.join(memDir(dir), 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return []; }
  };
  /** Scenario E's exact recipe for a guaranteed, real FAIL check: render truth, then corrupt it. */
  function makeFailingProject() {
    const p = project({ requirements: [{ id: 'R-1', title: 'one', mandatory: true }] });
    let r = cli(p.dir, 'savepoint', '--verify', '--write');
    assert.equal(r.code, 0, `expected a clean savepoint to seed the fixture, got ${r.code}: ${r.stdout}${r.stderr}`);
    const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
    const truth = fs.readFileSync(cont, 'utf8');
    fs.writeFileSync(cont, truth.replace('0 conformant', '3 conformant'));
    return p;
  }

  test('the STATE.json write is verified by digest — a named PASS check, not silent', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const r = cli(p.dir, 'savepoint', '--verify');
      const c = r.json.checks.find((x) => x.check === 'state-writeback');
      assert.ok(c, 'no state-writeback check was emitted at all — the read-back verify did not run');
      assert.equal(c.outcome, 'PASS', `expected a verified write, got ${c.outcome}: ${c.detail}`);
      assert.match(c.detail, /verified by digest/);
    } finally { rm(p.dir); }
  });

  test('a FAIL check becomes a `finding` candidate, with provenance, and memoryProposals carries its id', () => {
    const p = makeFailingProject();
    try {
      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 1, 'the seeded drift must FAIL savepoint, or this fixture proves nothing');

      const failCheck = r.json.checks.find((c) => c.outcome === 'FAIL');
      assert.ok(failCheck, 'sanity: the fixture produced no FAIL check');
      const captured = r.json.capturedCandidates.filter((c) => c.klass === 'finding');
      assert.ok(captured.length, 'no finding candidate was captured from a real FAIL check');

      const onDisk = readCandidates(p.dir);
      const rec = onDisk.find((x) => x.id === captured[0].id);
      assert.ok(rec, `captured candidate ${captured[0].id} has no file on disk`);
      assert.equal(rec.verificationState, 'candidate', 'a freshly captured candidate must not start promoted');
      assert.equal(rec.klass, 'finding');
      assert.equal(rec.verification, null);
      assert.equal(rec.rejection, null);
      // provenance: capturedBy / revision / sourceCheck-or-at (decision #2's shape, mapped onto the
      // module's real fields — see the comment above runCandidateCapture()).
      assert.equal(rec.provenance.by, 'savepoint');
      assert.equal(rec.provenance.sourceKind, 'savepoint');
      assert.ok(rec.provenance.cycleId && rec.provenance.cycleId.length > 0, 'no revision recorded as cycleId');
      assert.ok(rec.provenance.at, 'no capture timestamp recorded');
      assert.ok(rec.provenance.evidencePaths.some((e) => /STATE\.json/.test(e)), 'the finding carries no evidence path back to STATE.json');

      const proposal = r.json.memoryProposals.find((m) => m.candidateId === captured[0].id);
      assert.ok(proposal, 'memoryProposals does not carry the candidateId for a check it also proposed prose for');

      const audit = readAudit(p.dir);
      assert.ok(audit.some((a) => a.action === 'capture' && a.id === captured[0].id), 'the capture was not audited');
    } finally { rm(p.dir); }
  });

  test('capture is deduped on content digest — the SAME persisting failure is not re-captured on a second run', () => {
    const p = makeFailingProject();
    try {
      const first = cli(p.dir, 'savepoint', '--verify');
      assert.equal(first.code, 1);
      const before = readCandidates(p.dir).length;
      assert.ok(before > 0, 'sanity: nothing was captured on the first run');

      const second = cli(p.dir, 'savepoint', '--verify');
      assert.equal(second.code, 1, 'the same uncorrected drift must still FAIL the second run');
      const after = readCandidates(p.dir).length;
      assert.equal(after, before, `a second run of the SAME failure created ${after - before} new candidate file(s) — capture is not deduped`);
      assert.equal(second.json.capturedCandidates.length, 0, 'the second run reported freshly-captured candidates for a failure already on record');

      // And the SECOND run's memoryProposals still points at the FIRST run's candidate — a dedup
      // that loses the link would silently orphan the review surface from the prose prompt.
      const firstId = readCandidates(p.dir).find((c) => c.klass === 'finding').id;
      assert.ok(second.json.memoryProposals.some((m) => m.candidateId === firstId), 'the deduped proposal lost its candidateId on the second run');
    } finally { rm(p.dir); }
  });

  test('a newly-stated goal constraint becomes a `constraint` candidate', () => {
    const p = project({
      requirements: [{ id: 'R-1', mandatory: true }],
      goal: { goal: 'ship the thing', completion: ['all-mandatory-conformant'], constraints: ['no pushes', 'no secrets in code'] },
    });
    try {
      const r = cli(p.dir, 'savepoint', '--verify');
      const constraints = readCandidates(p.dir).filter((c) => c.klass === 'constraint');
      assert.ok(constraints.some((c) => c.claim === 'no pushes'), 'the "no pushes" constraint was not captured');
      assert.ok(constraints.some((c) => c.claim === 'no secrets in code'), 'the "no secrets in code" constraint was not captured');
      for (const c of constraints) {
        assert.equal(c.verificationState, 'candidate');
        assert.ok(c.provenance.evidencePaths.some((e) => /goal\.json/.test(e)), `constraint ${c.id} carries no evidence path back to goal.json`);
      }
      assert.equal(r.json.capturedCandidates.filter((c) => c.klass === 'constraint').length, 2, 'the legacy goal shape duplicates its constraints — dedup must still land on exactly 2 distinct candidates');
    } finally { rm(p.dir); }
  });

  test('an operator-supplied --candidate becomes a root-cause-fix candidate; savepoint never infers one from a diff', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const r = cli(p.dir, 'savepoint', '--verify', '--candidate',
        'root-cause-fix:the retry loop starved under three readers because the lease read had no lock; fixed by widening the lock scope');
      const rcf = readCandidates(p.dir).find((c) => c.klass === 'root-cause-fix');
      assert.ok(rcf, 'the operator-supplied root-cause-fix was not captured');
      assert.match(rcf.claim, /widening the lock scope/);
      assert.equal(rcf.provenance.by, 'operator');
      assert.equal(rcf.provenance.sourceKind, 'operator');
      assert.ok(r.json.capturedCandidates.some((c) => c.id === rcf.id), 'the operator candidate is missing from this run\'s capturedCandidates');
    } finally { rm(p.dir); }
  });

  test('a malformed or invalid --candidate is refused, loudly, and FAILS the savepoint', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const badKind = cli(p.dir, 'savepoint', '--candidate', 'not-a-real-kind:some text');
      assert.equal(badKind.code, 1, 'an invalid --candidate kind did not fail the savepoint');
      assert.ok(badKind.json.checks.some((c) => c.check === 'memory-capture:operator' && /not-a-real-kind/.test(c.detail)));

      const noColon = cli(p.dir, 'savepoint', '--candidate', 'just some text with no kind prefix');
      assert.equal(noColon.code, 1, 'a --candidate with no "kind:" prefix did not fail the savepoint');
    } finally { rm(p.dir); }
  });

  // --- I-7 / P1-K-06 · the memory klass vocabulary is discoverable where the operator reaches for it ---
  //
  // The rejection itself was already correct, tested behaviour: an unknown --candidate klass FAILs the
  // savepoint via a memory-capture:operator row (the test above). The gap findings-the kernel audit I-7 found
  // was DISCOVERABILITY — the four valid klasses were named only reactively, after a wrong guess, and
  // `--help` never showed them beside the flag at all. The fix touches message text only: the rejection
  // names the offending klass first and the four valid ones right after, in the one fixed order
  // MEMORY_KLASSES itself declares (`finding, decision, constraint, root-cause-fix`), and repeats the
  // exact `--candidate "kind:text"` form; `--help` lists the same four, in the same order, beside the
  // flag. No klass becomes acceptable that was not already acceptable, and no exit code moves.

  test('an unknown --candidate klass is rejected naming itself first, the four valid klasses right after in a fixed order, and the correct form', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const r = cli(p.dir, 'savepoint', '--candidate', 'reference:a citation, not a lead');
      assert.equal(r.code, 1, 'an unknown --candidate klass did not fail the savepoint — acceptance must not change');
      const row = r.json.checks.find((c) => c.check === 'memory-capture:operator');
      assert.ok(row, 'no memory-capture:operator row was emitted for the unknown klass');
      assert.equal(row.outcome, 'FAIL', 'the row for an unknown klass must still be FAIL, not something weaker');

      const offendingAt = row.detail.indexOf('"reference"');
      const validListAt = row.detail.indexOf('finding, decision, constraint, root-cause-fix');
      assert.ok(offendingAt >= 0, `the rejected klass is not named in the error: ${row.detail}`);
      assert.ok(validListAt > offendingAt,
        `the four valid klasses do not immediately follow the offending klass, in the fixed finding/decision/constraint/root-cause-fix order: ${row.detail}`);
      assert.match(row.detail, /--candidate "kind:text"/, `the error does not repeat the correct --candidate form: ${row.detail}`);
    } finally { rm(p.dir); }
  });

  test('--candidate --help lists the four valid klasses beside the flag, in the same fixed order as the rejection message', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const r = cli(p.dir, '--help');
      assert.match(r.stdout, /--candidate "kind:text"[\s\S]{0,200}kind is one of finding\|decision\|constraint\|root-cause-fix/,
        `--help does not list the four klasses, in the fixed finding/decision/constraint/root-cause-fix order, beside the --candidate flag: ${r.stdout}`);
    } finally { rm(p.dir); }
  });

  test('two well-formed --candidate flags of different klasses both land in one run, regardless of order', () => {
    const claimA = 'the retry storm started after the third consecutive 503';
    const claimB = 'retry backoff will be capped at five attempts';
    for (const [firstKlass, secondKlass] of [['finding', 'decision'], ['decision', 'finding']]) {
      const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
      try {
        const r = cli(p.dir, 'savepoint', '--verify',
          '--candidate', `${firstKlass}:${claimA}`,
          '--candidate', `${secondKlass}:${claimB}`);
        const recs = readCandidates(p.dir);
        const first = recs.find((c) => c.klass === firstKlass && c.claim === claimA);
        const second = recs.find((c) => c.klass === secondKlass && c.claim === claimB);
        assert.ok(first, `the FIRST --candidate (${firstKlass}) was dropped when it came first — order [${firstKlass}, ${secondKlass}]`);
        assert.ok(second, `the SECOND --candidate (${secondKlass}) was dropped when it came second — order [${firstKlass}, ${secondKlass}]`);
        assert.ok(r.json.capturedCandidates.some((c) => c.id === first.id), 'the first candidate is missing from capturedCandidates');
        assert.ok(r.json.capturedCandidates.some((c) => c.id === second.id), 'the second candidate is missing from capturedCandidates');
      } finally { rm(p.dir); }
    }
  });

  // --- I-5 / P1-K-04 · ephemeral checks are not auto-captured as candidate memories -----------------
  //
  // note:budget:<file> FAILs whenever a human NOTE overflows NOTE_BUDGET (see the "note budget" describe
  // block above), and the FULL note is already archived verbatim right there by noteBudgetCheck's own
  // caller in cmdSavepoint. Before this fix, the loop above captured EVERY FAIL/CANNOT_DETERMINE row in
  // checks[] with no exception, so an over-budget note minted a SECOND, permanent copy of itself in
  // memory/candidates/ — duplication, not a new lead. The fix marks the note:budget row `ephemeral: true`
  // (render.js's noteBudgetCheck) and adds `if (c.ephemeral) continue;` to the loop above — nothing else:
  // the row still prints, the savepoint still FAILs with the same exit code, and the operator's own
  // `--candidate` (the loop below, entirely separate) stays a live path regardless.

  /**
   * A kernel-rendered CONTINUITY.md whose human NOTE is one char over NOTE_BUDGET — the "note budget"
   * describe block's own recipe (render fresh with no note, then substitute the placeholder), kept local
   * here so this block does not reach into that describe's scope. One mandatory requirement, no gates, no
   * evidence — the same shape makeFailingProject() starts from, already proven clean above — so the ONLY
   * check this fixture FAILs is note:budget:<file>.
   */
  function makeNoteOverflowProject() {
    const p = project({ requirements: [{ id: 'R-1', title: 'one', mandatory: true }] });
    const cont = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
    fs.mkdirSync(path.dirname(cont), { recursive: true });
    const overBudget = 'x'.repeat(render.NOTE_BUDGET + 1);
    fs.writeFileSync(cont, render.renderContinuity(stateLib.compile(p.dir).state, null).replace('_(no human note)_', overBudget));
    return p;
  }

  test('ephemeral: an over-budget NOTE still FAILs the savepoint with the same exit code and still prints its row, but mints no candidate', () => {
    const p = makeNoteOverflowProject();
    try {
      const r = cli(p.dir, 'savepoint', '--verify');
      const row = r.json.checks.find((c) => c.check.startsWith('note:budget:') && c.check.endsWith('CONTINUITY.md'));
      assert.ok(row, 'sanity: the fixture produced no note:budget row for CONTINUITY.md — this fixture proves nothing');
      assert.equal(row.outcome, 'FAIL', 'sanity: the fixture note must be over budget');
      assert.equal(r.code, 1, 'a note:budget FAIL must still fail the savepoint, exactly like any other FAIL');

      // The defect (I-5): every FAIL/CANNOT_DETERMINE row used to mint a `finding` candidate, note:budget
      // included, even though its full text is already archived verbatim beside it. Pre-fix this fails,
      // because a finding candidate naming note:budget IS present in both places checked below.
      const minted = r.json.capturedCandidates.filter((c) => c.klass === 'finding' && c.claim.startsWith('note:budget:'));
      assert.equal(minted.length, 0, 'a note:budget row minted a finding candidate in capturedCandidates — the note is already archived verbatim, so this is duplication, not a new lead');
      assert.ok(!readCandidates(p.dir).some((c) => c.claim.startsWith('note:budget:')), 'a note:budget candidate reached memory/candidates/ on disk');
    } finally { rm(p.dir); }
  });

  test('ephemeral rows are the only thing skipped: a non-ephemeral FAIL is still captured exactly as before', () => {
    const p = makeFailingProject();
    try {
      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 1, 'the seeded requirements drift must FAIL savepoint, or this fixture proves nothing');
      const failCheck = r.json.checks.find((c) => c.outcome === 'FAIL');
      assert.ok(failCheck, 'sanity: the fixture produced no FAIL check');
      assert.ok(!failCheck.ephemeral, 'sanity: this fixture\'s FAIL must be a real, non-ephemeral one, or it is not testing what it claims');
      const captured = r.json.capturedCandidates.filter((c) => c.klass === 'finding');
      assert.ok(captured.length, 'a non-ephemeral FAIL row was not captured — the ephemeral skip has overreached');
      assert.ok(readCandidates(p.dir).some((c) => c.id === captured[0].id), 'the non-ephemeral candidate never reached memory/candidates/ on disk');
    } finally { rm(p.dir); }
  });

  test('an operator --candidate is captured regardless of any ephemeral rows in the same run', () => {
    const p = makeNoteOverflowProject();
    try {
      const r = cli(p.dir, 'savepoint', '--verify', '--candidate', 'finding:the operator saw something the checks did not');
      const ephemeralRow = r.json.checks.find((c) => c.check.startsWith('note:budget:') && c.check.endsWith('CONTINUITY.md'));
      assert.equal(ephemeralRow && ephemeralRow.outcome, 'FAIL', 'sanity: the ephemeral row must still be present and FAILing in this run');

      const op = readCandidates(p.dir).find((c) => c.claim === 'the operator saw something the checks did not');
      assert.ok(op, 'the operator --candidate was not captured while an ephemeral row was present in the same run');
      assert.equal(op.provenance.by, 'operator');
      assert.ok(r.json.capturedCandidates.some((c) => c.id === op.id), 'the operator candidate is missing from this run\'s capturedCandidates');
      assert.ok(!r.json.capturedCandidates.some((c) => c.claim.startsWith('note:budget:')), 'sanity: the ephemeral row must still mint nothing alongside the operator candidate');
    } finally { rm(p.dir); }
  });
});

describe('W5 · `memory candidates` is the review surface — promote/reject are explicit, audited, idempotent', () => {
  const graphFile = (dir, type, slug) => path.join(dir, 'memory', 'graph', type, `${slug}.md`);

  function projectWithOneCandidate() {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    const r = cli(p.dir, 'savepoint', '--candidate', 'finding:a hunch nobody has verified yet');
    const id = r.json.capturedCandidates.find((c) => c.klass === 'finding').id;
    return { ...p, id };
  }

  test('`memory candidates` lists what savepoint captured, with per-state counts', () => {
    const p = projectWithOneCandidate();
    try {
      const r = cli(p.dir, 'memory', 'candidates');
      assert.equal(r.code, 0);
      assert.equal(r.json.outcome, 'PASS');
      assert.ok(r.json.candidates.some((c) => c.id === p.id));
      assert.equal(r.json.counts.candidate, 1);
      assert.equal(r.json.counts.verified, 0);
      assert.equal(r.json.counts.rejected, 0);

      // decision #3, made concrete in the review surface itself (not just proven absent from the
      // two injection hooks elsewhere): every row's `lead` is core.candidates.renderForRecall()'s
      // OWN output, so an agent reading this list is handed the labeled sentence, not raw claim text.
      const row = r.json.candidates.find((c) => c.id === p.id);
      assert.ok(row.lead.startsWith('UNVERIFIED LEAD'), `an unverified candidate's lead was not labeled: ${row.lead}`);
      assert.match(row.lead, /NOT established/);
    } finally { rm(p.dir); }
  });

  test('promote REFUSES without --verified-by, and without --as — an unstated verification is the exact failure mode', () => {
    const p = projectWithOneCandidate();
    try {
      const noAs = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--verified-by', 'checked it');
      assert.equal(noAs.code, 1);
      assert.match(noAs.json.error, /--as/);

      const noVerify = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/x');
      assert.equal(noVerify.code, 1);
      assert.match(noVerify.json.error, /--verified-by/);

      const emptyVerify = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/x', '--verified-by', '   ');
      assert.equal(emptyVerify.code, 1, 'whitespace-only --verified-by must be refused the same as absent');

      // NEVER auto-promoted: every refusal above must have left the candidate exactly as captured.
      const rec = JSON.parse(fs.readFileSync(path.join(p.dir, 'memory', 'candidates', `${p.id}.json`), 'utf8'));
      assert.equal(rec.verificationState, 'candidate');
    } finally { rm(p.dir); }
  });

  test('promote writes memory/graph/<type>/<slug>.md with promotedFrom/verifiedBy in its frontmatter, and verifies', () => {
    const p = projectWithOneCandidate();
    try {
      const r = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/a-verified-hunch', '--verified-by', 'reproduced twice, root cause confirmed', '--by', 'reviewer');
      assert.equal(r.code, 0, `promote was refused: ${JSON.stringify(r.json)}`);
      assert.equal(r.json.status, 'PROMOTED');
      assert.equal(r.json.entity, 'gotcha/a-verified-hunch');

      const gf = graphFile(p.dir, 'gotcha', 'a-verified-hunch');
      assert.ok(fs.existsSync(gf), 'the promoted entity was not written to memory/graph/');
      const text = fs.readFileSync(gf, 'utf8');
      assert.match(text, new RegExp(`promotedFrom: ${p.id}`));
      assert.match(text, /verifiedBy: "reproduced twice, root cause confirmed"/);
      assert.match(text, /promotedBy: "reviewer"/);

      const rec = JSON.parse(fs.readFileSync(path.join(p.dir, 'memory', 'candidates', `${p.id}.json`), 'utf8'));
      assert.equal(rec.verificationState, 'verified');
      assert.deepEqual(rec.verification.evidencePaths, ['reproduced twice, root cause confirmed']);
    } finally { rm(p.dir); }
  });

  test('promote is idempotent: the SAME --as twice is a recorded no-op, and the frontmatter keeps the FIRST verification', () => {
    const p = projectWithOneCandidate();
    try {
      const first = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/idempotent-case', '--verified-by', 'first verification text');
      assert.equal(first.code, 0);
      assert.equal(first.json.status, 'PROMOTED');
      assert.equal(first.json.alreadyPromoted, false);

      const second = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/idempotent-case', '--verified-by', 'a DIFFERENT text typed the second time');
      assert.equal(second.code, 0);
      assert.equal(second.json.status, 'ALREADY_VERIFIED');
      assert.equal(second.json.alreadyPromoted, true);

      const text = fs.readFileSync(graphFile(p.dir, 'gotcha', 'idempotent-case'), 'utf8');
      assert.match(text, /verifiedBy: "first verification text"/, 'the repeat OVERWROTE the graph entity with new text — a repeat must be a no-op pointing at the first');
      assert.doesNotMatch(text, /DIFFERENT text/);

      const audit = readAuditRows(p.dir);
      const actions = audit.filter((a) => a.id === p.id).map((a) => a.action);
      assert.deepEqual(actions, ['capture', 'promote', 'promote-noop'], 'the retry was not recorded as a no-op pointing at the first');
    } finally { rm(p.dir); }
  });

  test('promote repeat writes a BYTE-IDENTICAL graph file when verification.at is present (BUG-5 control: the plain case is unchanged)', () => {
    const p = projectWithOneCandidate();
    try {
      const first = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/byte-identical-case', '--verified-by', 'checked it once');
      assert.equal(first.code, 0, `promote was refused: ${JSON.stringify(first.json)}`);
      const gf = graphFile(p.dir, 'gotcha', 'byte-identical-case');
      const textAfterFirst = fs.readFileSync(gf, 'utf8');

      const second = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/byte-identical-case', '--verified-by', 'checked it once');
      assert.equal(second.code, 0, `the repeat was refused: ${JSON.stringify(second.json)}`);
      assert.equal(second.json.status, 'ALREADY_VERIFIED');
      const textAfterSecond = fs.readFileSync(gf, 'utf8');

      assert.equal(textAfterSecond, textAfterFirst,
        'a repeat promote rewrote different bytes even though verification.at was present and unchanged — "idempotent" is only true of the store, not of the file a reader opens');
    } finally { rm(p.dir); }
  });

  test('promote REFUSES to write a graph entity — on two separate calls — when the stored record has no verification.at, instead of silently falling back to a fresh timestamp (BUG-5)', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      /*
       * The previously unstated condition: a record whose verificationState is already 'verified' but
       * whose `.verification` object carries no `.at` — a legacy or hand-edited store, since
       * core/memory/candidates.js's validate() polices verificationState but never the shape of
       * `.verification` itself. core.candidates.promote() hits its ALREADY_VERIFIED branch immediately
       * and returns this record UNCHANGED, so calling `memory candidates promote` against it calls
       * writeGraphEntity with `rec.verification.at` absent on EVERY call — exercising the condition twice.
       */
      const id = 'cm_legacy_no_at';
      const candidatesDir = path.join(p.dir, 'memory', 'candidates');
      fs.mkdirSync(candidatesDir, { recursive: true });
      fs.writeFileSync(path.join(candidatesDir, `${id}.json`), JSON.stringify({
        schemaVersion: '2.0.0', kind: 'candidate-memory', id,
        claim: 'a candidate verified before verification.at was ever recorded',
        klass: 'finding',
        provenance: { by: 'tester', at: '2026-01-01T00:00:00.000Z', cycleId: 'c1', conversationId: null, host: null, sourceKind: 'operator', evidencePaths: [] },
        verificationState: 'verified',
        verification: { by: 'tester', evidencePaths: ['legacy evidence'], note: 'legacy verification, no .at' },
        rejection: null, supersededBy: null,
      }, null, 2));

      const gf = graphFile(p.dir, 'gotcha', 'legacy-no-at');

      const first = cli(p.dir, 'memory', 'candidates', 'promote', id, '--as', 'gotcha/legacy-no-at', '--verified-by', 'checked it');
      assert.equal(first.code, 1, `a record with no verification.at was promoted instead of refused: ${JSON.stringify(first.json)}`);
      assert.match(first.json.error, /verification\.at/, 'the refusal does not name the missing field');
      assert.ok(!fs.existsSync(gf), 'a graph entity was written for a record with no stable verification.at');

      // Called again: the store is untouched by a refusal, so the SAME condition holds — and the honest
      // behaviour must be the SAME both times. That consistency is what "idempotent" now means for this
      // case: never a silent new Date() on one call and a different one on the next.
      const second = cli(p.dir, 'memory', 'candidates', 'promote', id, '--as', 'gotcha/legacy-no-at', '--verified-by', 'checked it');
      assert.equal(second.code, 1);
      assert.equal(second.json.error, first.json.error, 'two refusals under the same unstated condition produced different details');
      assert.ok(!fs.existsSync(gf));
    } finally { rm(p.dir); }
  });

  test('a DIFFERENT --as on an already-promoted candidate is REFUSED, not silently forked into a second entity', () => {
    const p = projectWithOneCandidate();
    try {
      const first = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/original-slug', '--verified-by', 'v1');
      assert.equal(first.code, 0);

      const second = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/a-different-slug', '--verified-by', 'v2');
      assert.equal(second.code, 1, 'promoting the same id to a different entity must FAIL, not silently fork it');
      assert.match(second.json.error, /already promoted to/);

      assert.ok(fs.existsSync(graphFile(p.dir, 'gotcha', 'original-slug')));
      assert.ok(!fs.existsSync(graphFile(p.dir, 'gotcha', 'a-different-slug')), 'a second, forked graph entity was created for one candidate');
    } finally { rm(p.dir); }
  });

  test('reject requires --why, is idempotent, and a rejected candidate can never be promoted', () => {
    const p = projectWithOneCandidate();
    try {
      const noWhy = cli(p.dir, 'memory', 'candidates', 'reject', p.id);
      assert.equal(noWhy.code, 1);
      assert.match(noWhy.json.error, /--why/);

      const first = cli(p.dir, 'memory', 'candidates', 'reject', p.id, '--why', 'contradicted by a later run');
      assert.equal(first.code, 0);
      assert.equal(first.json.status, 'REJECTED');

      const second = cli(p.dir, 'memory', 'candidates', 'reject', p.id, '--why', 'trying again');
      assert.equal(second.code, 0);
      assert.equal(second.json.status, 'ALREADY_REJECTED');

      const promote = cli(p.dir, 'memory', 'candidates', 'promote', p.id, '--as', 'gotcha/x', '--verified-by', 'y');
      assert.equal(promote.code, 1, 'a REJECTED candidate was promoted');
      assert.match(promote.json.error, /rejected/);
      assert.ok(!fs.existsSync(graphFile(p.dir, 'gotcha', 'x')), 'a graph entity was written for a refused promotion');
    } finally { rm(p.dir); }
  });

  test('promote refuses an unknown candidate id, and reports which state (ABSENT is FAIL, not CANNOT_DETERMINE)', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const r = cli(p.dir, 'memory', 'candidates', 'promote', 'cm_does_not_exist', '--as', 'gotcha/x', '--verified-by', 'y');
      assert.equal(r.code, 1);
      assert.match(r.json.error, /no candidate cm_does_not_exist/);
    } finally { rm(p.dir); }
  });

  function readAuditRows(dir) {
    return fs.readFileSync(path.join(dir, 'memory', 'candidates', 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
});

describe('W5 · a candidate is never injected as established fact — the ONE surface this task touches', () => {
  /*
   * decision #3: nothing auto-injects candidates today. The two context-injection points that exist
   * (SessionStart's durable-state summary and PreCompact's handoff) are grep-fenced here so a future
   * change that starts reading memory/*.json into either cannot do so without ALSO carrying the
   * unverified-lead label core/memory/candidates.js's renderForRecall() already enforces — silently
   * wiring a raw candidate claim into an injected context is exactly the failure this fence exists to
   * catch before it ships.
   */
  const src = (rel) => fs.readFileSync(path.join(path.dirname(KERNEL), rel), 'utf8');

  /*
   * ⛔ P2-O-3 NARROWED THIS FENCE, AND THE NARROWING IS THE PART TO READ.
   *
   * It used to ban every read of the candidate store from the boot hook. The boot block now cites the
   * lessons register — "N verified · M candidates awaiting review" — which is a COUNT, and a count is
   * the one thing the store can contribute to an injected context without contributing a claim: it
   * carries no candidate's text, so there is nothing for `renderForRecall`'s label to be attached to,
   * and its whole purpose is to send a person to review the leads rather than to state one as a fact.
   *
   * So the ban moves from "may not read" to "may not read a CLAIM", which is what the fence was always
   * protecting, and it gets teeth it did not have before: the door is exactly `core.candidates.list`
   * (never a hand-rolled read of `cm_*.json`, never `read()` of a single record), the only field taken
   * off a record is `verificationState`, and `.claim` — the text `renderForRecall` exists to label — may
   * not appear at all. A future change that starts injecting a candidate's words still fails here.
   */
  test('SessionStart may COUNT candidate memories, and may never inject one as a claim', () => {
    const text = src('hooks/session-routing-nudge.js');
    assert.doesNotMatch(text, /memory[\\/]cm_|candidates\.read\(/,
      'hooks/session-routing-nudge.js opens candidate records itself — the store has one reader (core/memory/candidates.js) and the boot hook reaches it through core.candidates.list, never around it');
    assert.doesNotMatch(text, /\.claim\b/,
      'hooks/session-routing-nudge.js now reads a candidate\'s CLAIM TEXT — any injected surface that shows one must render it through core/memory/candidates.js\'s renderForRecall(), which is the only path that carries the unverified-lead label. A count is not a claim; this is.');
    assert.match(text, /core\.candidates\.list\(/,
      'the boot line no longer counts leads through the store\'s own reader — if the citation was removed, remove this fence with it rather than leaving it asserting nothing');
    assert.match(text, /verificationState/,
      'the count must still be of `candidate`-state records specifically: counting every record would report rejected and promoted leads as awaiting review');
  });

  test('PreCompact carries handoff ids only, never candidate claim text', () => {
    const text = src('hooks/precompact-ledger-nudge.js');
    assert.doesNotMatch(text, /memory[\\/]cm_|candidates\.(list|read)\(|core\.candidates/,
      'hooks/precompact-ledger-nudge.js now reads candidate memories directly — the same labeling requirement applies');
  });

  test('renderForRecall is the ONLY candidate-rendering path this pack ships, and it is used wherever a claim is shown', () => {
    // A second, unlabeled renderer anywhere in kernel/ or hooks/ is how the marker gets dropped —
    // core/memory/candidates.js's own header says this outright ("there is deliberately no
    // `renderRaw`"). This asserts no SECOND implementation of that idea exists in the trees this task
    // can touch.
    for (const dir of ['kernel', 'hooks']) {
      for (const f of fs.readdirSync(path.join(path.dirname(KERNEL), dir), { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.js')) continue;
        const text = src(path.posix.join(dir, f.name));
        assert.doesNotMatch(text, /UNVERIFIED LEAD/,
          `${dir}/${f.name} hand-rolls the unverified-lead marker instead of calling core.candidates.renderForRecall — a second implementation is how the label drifts from the one in core/memory/candidates.js`);
      }
    }
  });
});

// --- Scenario L · the structured killed-feature contract -------------------------------------------
//
// OVERCLAIMS #8: the installed baseline states "⛔ killed features are never re-added" as an absolute,
// and until now the enforcement was an agent remembering to grep. field run A proved the cost
// (RA-2/3): decision D-075 retired the magic gauntlet with "Do not reintroduce either", and four of
// them plus a whole "Gauntlet Empowerment Rules" section sat live in `story/` — a directory the
// project's anti-fork scanner never read, because it globbed exactly one folder.
//
// The fixture below is that case, reconstructed. The field-run repository itself is EVIDENCE and
// is never touched: its shape is copied, its files are not.

/** A project whose live content spans more than one directory — the run-A blind-spot shape. */
function removalProject({ removals = null, config = {}, files = {} } = {}) {
  const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(p.dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), JSON.stringify({ state: { removals: config } }, null, 2));
  if (removals !== null) {
    fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify(removals, null, 2));
  }
  return p;
}

const GAUNTLET_ROW = {
  schemaVersion: '1.0.0',
  removals: [{
    id: 'D-075', feature: 'magic gauntlet', risk: 'high',
    reason: 'retired: two overlapping progression systems',
    forbidden: ['magic gauntlet', 'gauntlet empowerment'],
  }],
};

describe('Scenario L · a killed feature reintroduced OUTSIDE the primary docs folder fails', () => {
  test('the literal run-A case: a live assertion in story/ is caught, and named with its location', () => {
    const p = removalProject({
      removals: GAUNTLET_ROW,
      config: { liveContentDirs: ['docs', 'story'] },
      files: {
        'docs/PRODUCT.md': '# Product\n\nOrdinary content with nothing retired in it.\n',
        'story/07_Weapons.md': '# Weapons\n\nThe launch roster ships four magic gauntlets.\n\n## Gauntlet Empowerment Rules\n\nEmpowerment scales with tier.\n',
      },
    });
    try {
      const r = cli(p.dir, 'removals');
      assert.equal(r.json.outcome, 'FAIL', 'a live reintroduction outside docs/ was not caught');
      assert.equal(r.code, 1, 'FAIL must have its own exit code');
      const fail = r.json.checks.find((c) => c.check === 'removals:D-075');
      assert.ok(fail, 'the failing check must be keyed on the removal id, not on a file');
      assert.match(fail.detail, /story\/07_Weapons\.md:\d+/, 'the failure must name file and line, not just "found"');
      assert.match(fail.detail, /magic gauntlet/);
    } finally { rm(p.dir); }
  });

  test('a scanner reading only the primary docs folder would have MISSED it — the discriminating control', () => {
    // Without this pair the test above proves the scanner works, not that COVERAGE is what fixed it.
    const files = {
      'docs/PRODUCT.md': '# Product\n\nNothing retired here.\n',
      'story/07_Weapons.md': '# Weapons\n\nThe launch roster ships four magic gauntlets.\n',
    };
    const narrow = removalProject({ removals: GAUNTLET_ROW, config: { liveContentDirs: ['docs'] }, files });
    const wide = removalProject({ removals: GAUNTLET_ROW, config: { liveContentDirs: ['docs', 'story'] }, files });
    try {
      assert.equal(cli(narrow.dir, 'removals').json.outcome, 'PASS', 'the narrow scan is the run-A defect and must reproduce it');
      assert.equal(cli(wide.dir, 'removals').json.outcome, 'FAIL', 'widening the configured directories is what catches it');
    } finally { rm(narrow.dir); rm(wide.dir); }
  });

  test('vendored trees are excluded BY NAME at any depth — the fix that makes scanning `.` safe', () => {
    /*
     * ⛔ THE BUG. `exclude` is a PATH-PREFIX list, so its default `node_modules` entry excluded exactly
     * ONE directory: the top-level one. A monorepo keeps dependencies under each package's own
     * node_modules, one level down, which that rule never matched. Scanning `.` therefore walked every
     * vendored README and FAILED on a dependency's prose — a file the project does not own, cannot
     * edit, and cannot make pass. That is why the installer shipped `['docs']`, which scanned almost
     * nothing; this is the fix that makes default-open safe.
     */
    const p = removalProject({
      removals: GAUNTLET_ROW,
      config: { liveContentDirs: ['.'] },
      files: {
        'packages/app/node_modules/dep/README.md': 'The magic gauntlet is enabled by default.\n',
        'docs/PRODUCT.md': 'The magic gauntlet is enabled by default.\n',
      },
    });
    try {
      const r = cli(p.dir, 'removals').json;
      assert.equal(r.outcome, 'FAIL', 'the project\'s own live assertion must still be caught');
      const files = r.rows.flatMap((row) => (row.hits || []).map((h) => h.file));
      assert.deepEqual(files, ['docs/PRODUCT.md'],
        `a nested node_modules was scanned: ${JSON.stringify(files)} — an unfixable FAIL on vendored prose trains operators to ignore this check`);
      assert.ok(r.scanned.alwaysExcluded.includes('node_modules'),
        'the always-excluded names must be REPORTED — coverage nobody mentions reads as coverage that happened');
    } finally { rm(p.dir); }
  });

  test('a configured directory that cannot be read is CANNOT_DETERMINE, never a quiet skip', () => {
    const p = removalProject({
      removals: GAUNTLET_ROW,
      config: { liveContentDirs: ['docs', 'story', 'does-not-exist'] },
      files: { 'docs/PRODUCT.md': '# Product\n', 'story/a.md': '# Story\n' },
    });
    try {
      const r = cli(p.dir, 'removals');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE', 'a blind spot reported success');
      assert.equal(r.code, 2);
      const cd = r.json.checks.find((c) => c.check === 'removals:corpus');
      assert.match(cd.detail, /does-not-exist/, 'the unreadable location must be named');
    } finally { rm(p.dir); }
  });

  test('an effectively empty corpus never passes after extensions, exclusions, or blank roots', () => {
    const cases = [
      ['nonmatching extensions', { liveContentDirs: ['docs'], extensions: ['.never'] }, 'CANNOT_DETERMINE'],
      ['everything explicitly excluded', { liveContentDirs: ['docs'], exclude: ['docs'] }, 'CANNOT_DETERMINE'],
      ['blank root is malformed', { liveContentDirs: [''] }, 'CANNOT_DETERMINE'],
    ];
    for (const [label, config, expected] of cases) {
      const p = removalProject({ removals: GAUNTLET_ROW, config, files: { 'docs/PRODUCT.md': '# Product\n' } });
      try {
        const r = cli(p.dir, 'removals');
        assert.equal(r.json.outcome, expected, `${label} produced ${r.json.outcome}`);
        assert.notEqual(r.json.outcome, 'PASS', `${label} checked zero files and passed`);
        assert.equal(rollup(r.json.checks), r.json.outcome, `${label}: checks and canonical outcome disagree`);
      } finally { rm(p.dir); }
    }
  });

  test('a file that fails during the read phase reaches checks AND the canonical outcome', () => {
    const p = removalProject({ removals: GAUNTLET_ROW, config: { liveContentDirs: ['docs'] }, files: { 'docs/PRODUCT.md': '# Product\n' } });
    const require_ = createRequire(import.meta.url);
    const cjsFs = require_('fs');
    const removalsLib = require_('./lib/removals.js');
    const original = cjsFs.readFileSync;
    try {
      cjsFs.readFileSync = function injectedReadFailure(file, ...args) {
        if (String(file).endsWith(`${path.sep}docs${path.sep}PRODUCT.md`)) {
          const e = new Error('injected EACCES after collection'); e.code = 'EACCES'; throw e;
        }
        return original.call(this, file, ...args);
      };
      const scan = removalsLib.runRemovalScan(p.dir);
      assert.equal(scan.outcome, 'CANNOT_DETERMINE');
      assert.equal(rollup(scan.checks), scan.outcome, 'savepoint consumes checks, so they must carry the same verdict');
      assert.ok(scan.checks.some((c) => c.check === 'removals:corpus' && /PRODUCT\.md/.test(c.detail)),
        'the late file-read failure never reached the checks savepoint consumes');
    } finally { cjsFs.readFileSync = original; rm(p.dir); }
  });

  test('a configured root symlink and registry path cannot escape project authority', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-removals-outside-'));
    fs.writeFileSync(path.join(outside, 'external.md'), 'The magic gauntlet is enabled. EXTERNAL_SENTINEL\n');
    fs.writeFileSync(path.join(outside, 'registry.json'), JSON.stringify(GAUNTLET_ROW));
    const linked = removalProject({ removals: GAUNTLET_ROW, config: { liveContentDirs: ['linked'] }, files: {} });
    const externalRegistry = removalProject({ removals: GAUNTLET_ROW, config: { registry: '../outside.json', liveContentDirs: ['docs'] }, files: { 'docs/PRODUCT.md': '# Product\n' } });
    const missingThroughLink = removalProject({ removals: null, config: { registry: 'authority/removals.json', liveContentDirs: ['docs'] }, files: { 'docs/PRODUCT.md': '# Product\n' } });
    try {
      fs.symlinkSync(outside, path.join(linked.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      const rootScan = cli(linked.dir, 'removals');
      assert.equal(rootScan.json.outcome, 'CANNOT_DETERMINE');
      assert.doesNotMatch(JSON.stringify(rootScan.json), /EXTERNAL_SENTINEL/, 'the scan disclosed prose outside the project');

      const reg = cli(externalRegistry.dir, 'removals');
      assert.equal(reg.json.outcome, 'CANNOT_DETERMINE');
      assert.match(reg.json.checks[0].detail, /outside the project|project-relative/);

      fs.symlinkSync(outside, path.join(missingThroughLink.dir, 'authority'), process.platform === 'win32' ? 'junction' : 'dir');
      const absent = cli(missingThroughLink.dir, 'removals');
      assert.equal(absent.json.outcome, 'CANNOT_DETERMINE');
      assert.match(absent.json.checks[0].detail, /outside the project.*symlink|symlink.*outside the project/i,
        'an absent authority below an external symlink was misclassified as an ordinary missing in-project file');
    } finally { rm(linked.dir); rm(externalRegistry.dir); rm(missingThroughLink.dir); rm(outside); }
  });

  /*
   * ⛔ ROWS WITH NOWHERE TO SCAN IS A BREACH, NOT AN UNKNOWN — and the pair below is what makes that
   * claim discriminating rather than decorative. The the 2026-08-07 field run (§2) found this check
   * reporting CANNOT_DETERMINE against a config with no `state` key at all, and named the cost exactly:
   * "A guarantee that silently no-ops is worse than no guarantee." CANNOT_DETERMINE is the verdict
   * operators learn to scroll past; a project that has WRITTEN DOWN its killed features and enforces
   * none of them has a determined problem, and has to be told so in the one word that stops a release.
   */
  test('removal rows with no configured directories FAIL; the same emptiness with no rows only CANNOT_DETERMINE', () => {
    const withRows = removalProject({ removals: GAUNTLET_ROW, config: {}, files: { 'docs/PRODUCT.md': '# Product\n' } });
    const noRows = removalProject({ removals: null, config: {}, files: { 'docs/PRODUCT.md': '# Product\n' } });
    try {
      // Rows exist and nothing reads them → the contract is stated and unkept.
      const r = cli(withRows.dir, 'removals');
      assert.equal(r.json.outcome, 'FAIL', 'recorded removals that nothing scans were reported as merely undetermined');
      assert.equal(r.code, 1, 'FAIL must carry its own exit code — 2 is the one that gets ignored');
      const fail = r.json.checks.find((c) => c.check === 'removals:config');
      assert.match(fail.detail, /1 removal row\(s\)/, 'the failure must count the rows it is speaking for');
      assert.match(fail.detail, /liveContentDirs/, 'and must name the key that fixes it');

      // Nothing configured AND nothing claimed → no promise is outstanding, so nothing is broken.
      const n = cli(noRows.dir, 'removals');
      assert.equal(n.json.outcome, 'CANNOT_DETERMINE', 'an unconfigured project with no removals is not a failure');
      assert.equal(n.code, 2);
    } finally { rm(withRows.dir); rm(noRows.dir); }
  });

  test('what was NOT scanned is always reported — a silent coverage cap reads as coverage', () => {
    const p = removalProject({
      removals: GAUNTLET_ROW,
      config: { liveContentDirs: ['docs'], historyPaths: ['docs/DECISIONS.md'] },
      files: {
        'docs/PRODUCT.md': '# Product\n',
        'docs/DECISIONS.md': '# Decisions\n\nD-075 retires the magic gauntlet. Do not reintroduce either.\n',
      },
    });
    try {
      const r = cli(p.dir, 'removals');
      assert.ok(r.json.notScanned.some((s) => /DECISIONS\.md/.test(s)), 'a declared history path must be reported as not scanned');
      assert.equal(r.json.outcome, 'PASS', 'the decision register naming the feature is not a reintroduction');
    } finally { rm(p.dir); }
  });
});

describe('Scenario L · naming a retired feature is not reintroducing it', () => {
  const control = (body) => removalProject({
    removals: GAUNTLET_ROW,
    config: { liveContentDirs: ['docs'] },
    files: { 'docs/PRODUCT.md': body },
  });

  test('history, quotation, migration notes and retirement sentences all PASS', () => {
    const cases = {
      'a retirement sentence': '# Product\n\nThe magic gauntlet was removed in D-075.\n',
      'a relative retirement with a retired continuation': '# Product\n\nThe magic gauntlet, which was removed in D-075, remains removed.\n',
      'multiple retired continuations stay historical': '# Product\n\nThe magic gauntlet, which was removed in D-075, remains removed and is gone.\n',
      'a parenthetical retirement with a retired continuation': '# Product\n\nThe magic gauntlet (removed in D-075) is gone.\n',
      'an explicit prohibition': '# Product\n\nDo not reintroduce the magic gauntlet.\n',
      'a superseded row': '# Product\n\nGauntlet empowerment — superseded by the tier system.\n',
      'a blockquote quotation': '# Product\n\n> The launch roster ships four magic gauntlets.\n\nThat line is from the 2025 draft.\n',
      'a history section': '# Product\n\n## Removed features\n\nThe launch roster shipped four magic gauntlets.\n',
      'a changelog section': '# Product\n\n## Changelog\n\nDropped the magic gauntlet.\n',
      'a decision record': '# Product\n\n## Decisions\n\nD-075 killed the magic gauntlet.\n',
      'a migration note': '# Product\n\n## Migration\n\nProjects using the magic gauntlet should move to tiers.\n',
      'fenced code': '# Product\n\n```\nlegacy.magic_gauntlet = true\n```\n',
      'a struck line': '# Product\n\n~~The magic gauntlet is available.~~\n',
    };
    for (const [label, body] of Object.entries(cases)) {
      const p = control(body);
      try {
        const r = cli(p.dir, 'removals');
        assert.equal(r.json.outcome, 'PASS', `${label} was treated as a reintroduction: ${JSON.stringify(r.json.checks)}`);
      } finally { rm(p.dir); }
    }
  });

  test('…and a live assertion in the SAME documents still fails — the known-bad half', () => {
    const cases = {
      'a plain assertion': '# Product\n\nThe magic gauntlet is available at tier 3.\n',
      'a heading is not a shield': '# Product\n\n## Removed features\n\nOld stuff.\n\n## Roster\n\nShips four magic gauntlets.\n',
      'a second sentence after a retirement': '# Product\n\nThe old UI was removed. The magic gauntlet is back by popular demand.\n',
      'an unrelated retirement in the same sentence': '# Product\n\nThe magic gauntlet is enabled while the old UI was removed.\n',
      'a relative retirement followed by a live predicate': '# Product\n\nThe magic gauntlet, which was removed in D-075, is enabled again.\n',
      'a parenthetical retirement followed by a live predicate': '# Product\n\nThe magic gauntlet (removed in D-075) is enabled again.\n',
      'a live continuation cannot hide behind a later retirement': '# Product\n\nThe magic gauntlet, which was removed in D-075, is enabled again but remains removed.\n',
      'a live continuation cannot hide after a renewed retirement': '# Product\n\nThe magic gauntlet, which was removed in D-075, remains removed but is enabled again.\n',
      'a parenthetical mixed continuation is still live': '# Product\n\nThe magic gauntlet (removed in D-075) is enabled again although it remains removed.\n',
      'a leading historical adjective that does not retire the feature': '# Product\n\nPreviously optional, the magic gauntlet is now enabled.\n',
      'a wrapped sentence': '# Product\n\nThe roster ships four magic\ngauntlets at launch.\n',
    };
    for (const [label, body] of Object.entries(cases)) {
      const p = control(body);
      try {
        assert.equal(cli(p.dir, 'removals').json.outcome, 'FAIL', `${label} was allowed through`);
      } finally { rm(p.dir); }
    }
  });

  test('a renamed alias is only caught when the registry lists it — stated, not implied', () => {
    // ⛔ Honesty fixture. The contract detects the phrases a row DECLARES. A synonym nobody wrote down
    // is outside what this can see, and the narrowed claim in the docs says exactly that.
    const undeclared = control('# Product\n\nThe arcane mitt is available at tier 3.\n');
    try {
      assert.equal(cli(undeclared.dir, 'removals').json.outcome, 'PASS',
        'the scan cannot detect a phrase no row lists — if this fails, the claim in the docs is wrong');
    } finally { rm(undeclared.dir); }

    const declared = removalProject({
      removals: { schemaVersion: '1.0.0', removals: [{ ...GAUNTLET_ROW.removals[0], forbidden: ['magic gauntlet', 'arcane mitt'] }] },
      config: { liveContentDirs: ['docs'] },
      files: { 'docs/PRODUCT.md': '# Product\n\nThe arcane mitt is available at tier 3.\n' },
    });
    try {
      assert.equal(cli(declared.dir, 'removals').json.outcome, 'FAIL', 'declaring the alias must make it enforceable');
    } finally { rm(declared.dir); }
  });
});

describe('Scenario L · empty or unproven configuration is never a pass', () => {
  /*
   * The registry is EMPTY here on purpose. This test's subject is "nobody configured this", and field run §2
   * split that from its louder sibling: rows recorded with nothing scanning them is now a FAIL, not an
   * undetermined check, because the project has stated a guarantee it is provably not keeping. Both
   * halves are asserted together in "removal rows with no configured directories FAIL" above; this one
   * keeps the quieter half honest — a project that has claimed nothing has broken nothing, and must not
   * be escalated into a failure just because its config is bare.
   */
  test('no configured live-content directory AND no rows is CANNOT_DETERMINE, not NOT_APPLICABLE', () => {
    const p = removalProject({ removals: null, config: {}, files: { 'docs/PRODUCT.md': '# Product\n' } });
    try {
      const r = cli(p.dir, 'removals');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE', 'an unconfigured contract reported a clean bill of health');
      assert.equal(r.code, 2);
      assert.match(r.json.checks[0].detail, /NOTHING enforces/);
    } finally { rm(p.dir); }
  });

  test('NOT_APPLICABLE requires a DECLARED reason — current and legacy forms agree', () => {
    for (const config of [
      { notApplicable: true, reason: 'this project has retired nothing' },
      { notApplicable: 'legacy: this project has retired nothing' },
    ]) {
      const p = removalProject({ config, files: {} });
      try {
        const r = cli(p.dir, 'removals');
        assert.equal(r.json.outcome, 'NOT_APPLICABLE');
        assert.equal(r.code, 0, 'a DECLARED not-applicable is legitimately green');
        assert.match(r.json.checks[0].detail, /retired nothing/);
      } finally { rm(p.dir); }
    }
  });

  test('malformed config and malformed registry rows are CANNOT_DETERMINE, never absent or a crash', () => {
    const badConfig = removalProject({ removals: GAUNTLET_ROW, config: { liveContentDirs: ['docs'] }, files: { 'docs/PRODUCT.md': '# Product\n' } });
    const badRow = removalProject({ removals: { schemaVersion: '1.0.0', removals: [null] }, config: { liveContentDirs: ['docs'] }, files: { 'docs/PRODUCT.md': '# Product\n' } });
    try {
      fs.writeFileSync(path.join(badConfig.dir, 'respawnpack.config.json'), '{ broken json');
      const c = cli(badConfig.dir, 'removals');
      assert.equal(c.json.outcome, 'CANNOT_DETERMINE');
      assert.match(c.json.checks[0].detail, /not parseable JSON/);

      const row = cli(badRow.dir, 'removals');
      assert.equal(row.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(row.code, 2, 'a schema-invalid row must not throw into the CLI-wide FAIL handler');
      assert.match(row.json.checks[0].detail, /row 0 is not an object/);
    } finally { rm(badConfig.dir); rm(badRow.dir); }
  });

  test('configured directories with an empty or absent registry is CANNOT_DETERMINE', () => {
    for (const removals of [null, { schemaVersion: '1.0.0', removals: [] }]) {
      const p = removalProject({ removals, config: { liveContentDirs: ['docs'] }, files: { 'docs/PRODUCT.md': '# Product\n' } });
      try {
        assert.equal(cli(p.dir, 'removals').json.outcome, 'CANNOT_DETERMINE',
          'an empty registry is a check with nothing to check, not a pass');
      } finally { rm(p.dir); }
    }
  });

  test('a row with no forbidden phrase, and a phrase that discriminates nothing, both stop at unverified', () => {
    const p = removalProject({
      removals: {
        schemaVersion: '1.0.0',
        removals: [
          { id: 'D-1', feature: 'no phrases', risk: 'high', forbidden: [] },
          { id: 'D-2', feature: 'self-retiring phrase', risk: 'high', forbidden: ['was removed'] },
        ],
      },
      config: { liveContentDirs: ['docs'] },
      files: { 'docs/PRODUCT.md': '# Product\n\nOrdinary text.\n' },
    });
    try {
      const r = cli(p.dir, 'removals');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      const byId = Object.fromEntries(r.json.rows.map((x) => [x.id, x]));
      assert.equal(byId['D-1'].status, 'unverified');
      assert.match(byId['D-1'].why, /no forbidden live assertions/);
      assert.equal(byId['D-2'].status, 'unverified', 'a phrase that is itself retirement vocabulary can never match, and its zero would read as confirmation');
    } finally { rm(p.dir); }
  });

  test('a HIGH-RISK row with one unprovable phrase stops at unverified even when the others are clear', () => {
    const p = removalProject({
      removals: {
        schemaVersion: '1.0.0',
        removals: [
          { id: 'D-H', feature: 'high risk', risk: 'high', forbidden: ['magic gauntlet', 'was removed'] },
          { id: 'D-N', feature: 'normal risk', risk: 'normal', forbidden: ['magic gauntlet', 'was removed'] },
        ],
      },
      config: { liveContentDirs: ['docs'] },
      files: { 'docs/PRODUCT.md': '# Product\n\nOrdinary text.\n' },
    });
    try {
      const rows = Object.fromEntries(cli(p.dir, 'removals').json.rows.map((x) => [x.id, x]));
      assert.equal(rows['D-H'].status, 'unverified', 'a partial battery was promoted to a completion claim');
      assert.equal(rows['D-N'].status, 'unverified', 'risk cannot turn an unproven phrase into a checked one');
    } finally { rm(p.dir); }
  });
});

describe('Scenario L · boot and savepoint agree, and the verdict carries its own freshness', () => {
  test('savepoint FAILS on a reintroduction, and the same scan reaches STATE.json', () => {
    const p = removalProject({
      removals: GAUNTLET_ROW,
      config: { liveContentDirs: ['docs'] },
      files: { 'docs/PRODUCT.md': '# Product\n\nShips four magic gauntlets.\n' },
    });
    try {
      const sp = cli(p.dir, 'savepoint', '--verify');
      assert.equal(sp.json.outcome, 'FAIL', 'savepoint passed while a killed feature was live');
      assert.ok(sp.json.checks.some((c) => c.check === 'removals:D-075'));

      const state = JSON.parse(fs.readFileSync(path.join(p.dir, stateLib.STATE_FILE), 'utf8'));
      const row = state.killedFeatures.find((k) => k.id === 'D-075');
      assert.equal(row.status, 'violated', 'boot state must carry the same verdict savepoint reported');
      assert.ok(row.violations.length, 'and the locations, so a session can act on it');
      assert.equal(state.removals.status, 'FAIL');
    } finally { rm(p.dir); }
  });

  test('the verdict goes STALE when a scanned file changes, without making the row counts stale', () => {
    const p = removalProject({
      removals: GAUNTLET_ROW,
      config: { liveContentDirs: ['docs'] },
      files: { 'docs/PRODUCT.md': '# Product\n\nOrdinary text.\n' },
    });
    try {
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'base');
      cli(p.dir, 'state');
      const rt = createRequire(import.meta.url)('../hooks/_runtime.js');

      const before = rt.readDurableState(p.dir);
      assert.equal(before.status, 'CURRENT', 'the control: a committed, unchanged tree is CURRENT');
      assert.equal(before.state.removals.corpusFreshness, 'CURRENT');

      fs.writeFileSync(path.join(p.dir, 'docs', 'PRODUCT.md'), '# Product\n\nShips four magic gauntlets.\n');
      const after = rt.readDurableState(p.dir);
      assert.equal(after.state.removals.corpusFreshness, 'STALE',
        'the removal verdict kept claiming "clear" about files that had changed underneath it');
      assert.equal(after.status, 'CURRENT',
        'and a doc edit must NOT invalidate the row counts — that is why the corpus has its own manifest');
    } finally { rm(p.dir); }
  });

  test('editing the REGISTRY does make the whole projection stale — it is a compiler input', () => {
    const p = removalProject({
      removals: GAUNTLET_ROW,
      config: { liveContentDirs: ['docs'] },
      files: { 'docs/PRODUCT.md': '# Product\n\nOrdinary text.\n' },
    });
    try {
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'base');
      cli(p.dir, 'state');
      const rt = createRequire(import.meta.url)('../hooks/_runtime.js');
      assert.equal(rt.readDurableState(p.dir).status, 'CURRENT');

      const reg = path.join(p.dir, stateLib.STATE_DIR, 'removals.json');
      const doc = JSON.parse(fs.readFileSync(reg, 'utf8'));
      doc.removals.push({ id: 'D-076', feature: 'second thing', forbidden: ['second thing'] });
      fs.writeFileSync(reg, JSON.stringify(doc, null, 2));

      const after = rt.readDurableState(p.dir);
      assert.equal(after.status, 'STALE', 'a changed removal registry left the projection reading as current');
      assert.match(after.detail, /removals\.json/);
    } finally { rm(p.dir); }
  });

  test('a configured custom registry is a freshness input, not only the default path', () => {
    const p = removalProject({
      removals: GAUNTLET_ROW,
      config: { registry: 'custom/removals.json', liveContentDirs: ['docs'] },
      files: { 'docs/PRODUCT.md': '# Product\n\nOrdinary text.\n' },
    });
    try {
      fs.mkdirSync(path.join(p.dir, 'custom'), { recursive: true });
      fs.renameSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), path.join(p.dir, 'custom', 'removals.json'));
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'custom registry');
      cli(p.dir, 'state');
      const rt = createRequire(import.meta.url)('../hooks/_runtime.js');
      assert.equal(rt.readDurableState(p.dir).status, 'CURRENT');

      const reg = path.join(p.dir, 'custom', 'removals.json');
      const doc = JSON.parse(fs.readFileSync(reg, 'utf8'));
      doc.removals.push({ id: 'D-076', feature: 'second thing', forbidden: ['second thing'] });
      fs.writeFileSync(reg, JSON.stringify(doc, null, 2));
      const after = rt.readDurableState(p.dir);
      assert.equal(after.status, 'STALE', 'editing the configured registry left custom-path negative knowledge CURRENT');
      assert.match(after.detail, /custom\/removals\.json/);
    } finally { rm(p.dir); }
  });

  test('doctor reports the contract per install, so an unenforced absolute is visible', () => {
    const off = removalProject({ config: {}, files: {} });
    const on = removalProject({
      removals: GAUNTLET_ROW, config: { liveContentDirs: ['docs'] },
      files: { 'docs/PRODUCT.md': '# Product\n\nOrdinary text.\n' },
    });
    try {
      const rowOf = (r) => r.json.rows.find((x) => x.check === 'removals:contract');
      assert.equal(rowOf(cli(off.dir, 'doctor')).label, 'NOT_CONFIGURED');
      assert.match(rowOf(cli(off.dir, 'doctor')).detail, /nothing scans for reintroduced killed features/);
      assert.equal(rowOf(cli(on.dir, 'doctor')).label, 'ACTIVE');
    } finally { rm(off.dir); rm(on.dir); }
  });
});

// --- P4-N-10 · render.js's own "Killed features" bullet must not self-trigger the scan -------------
//
// Found dogfooding K-03 (788f298): renderContinuity() puts each retired feature's own name into an
// ordinary bulleted sentence — `- \`id\` — feature name` — under the heading "## ⛔ Killed features —
// do not reintroduce". That heading carried none of HISTORY_HEADING's vocabulary (removal/removed/
// retired/…/negative knowledge), so blankHistoryLines() never marked the bullets as history, and a
// registry row whose forbidden phrase sits inside its own feature name read as a LIVE assertion of the
// very thing it retires. Reproduced against this repo's own docs/derived/state/removals.json (outside
// this suite, read-only): R-003 ("plugin architecture", "second repository"), R-004 ("degraded
// fallback") and R-006 ("HEAD~1..HEAD") all self-trigger the instant docs/derived is scanned.
//
// The fix is the heading text alone: it now reads "(negative knowledge)", the exact phrase
// spine/PRODUCT.md's own "Killed features (negative knowledge)" section already uses and the one
// HISTORY_HEADING already recognises. No change to removals.js, no new vocabulary, no widening of what
// counts as history anywhere else the scanner runs.
describe('Scenario L · P4-N-10 — the rendered "Killed features" bullet must not self-trigger the scan', () => {
  const FORBIDDEN = 'plugin architecture';
  const FEATURE = `the legacy ${FORBIDDEN}`;
  const NOTE_RE = new RegExp(`${render.NOTE_OPEN}([\\s\\S]*?)${render.NOTE_CLOSE}`);

  // A registry row shaped like this repo's real R-003: the forbidden phrase is a literal substring of
  // the feature's own name, and docs/derived — where the kernel writes CONTINUITY.md — is itself a
  // scanned live-content directory, exactly as the finding describes.
  function fixture() {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    const cfgPath = path.join(p.dir, 'respawnpack.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.state.removals = { liveContentDirs: ['docs/derived'] };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      removals: [{ id: 'D-090', feature: FEATURE, risk: 'normal', reason: 'fixture: retired for P4-N-10', forbidden: [FORBIDDEN] }],
    }, null, 2));
    return p;
  }

  /*
   * Render CONTINUITY.md through the real pipeline and place it where the scanner will find it — the
   * same idiom the note-budget fixtures above use for a single file, extended to TWO renders because a
   * truly empty docs/derived scans zero files and (correctly, per the "empty corpus never passes" rule
   * above) reports CANNOT_DETERMINE with every row unclassified, so killedFeatures would be empty and
   * the bullet under test would never be rendered at all. Seeding GAPS.md first — which does not depend
   * on killedFeatures — gives the compile that renders CONTINUITY.md a non-empty corpus to classify the
   * registry row against, exactly as a project's SECOND `savepoint --write` would see its own first
   * render already on disk.
   */
  function seedContinuity(dir) {
    const derived = path.join(dir, 'docs', 'derived');
    fs.mkdirSync(derived, { recursive: true });
    fs.writeFileSync(path.join(derived, 'GAPS.md'), render.renderGaps(stateLib.compile(dir).state, null));
    const text = render.renderContinuity(stateLib.compile(dir).state, null);
    fs.writeFileSync(path.join(derived, 'CONTINUITY.md'), text);
    return text;
  }

  // (1) THE DEFECT. Against pre-fix render.js this fails: the rendered bullet contains "plugin
  // architecture" in an ordinary sentence, nothing marks it historical, and `removals` reports it violated.
  test('the defect: a registry row whose forbidden phrase sits inside its own feature name renders into a bullet the scan must not treat as live', () => {
    const p = fixture();
    try {
      const text = seedContinuity(p.dir);
      assert.ok(text.includes(FORBIDDEN), 'precondition: the rendered bullet must actually contain the forbidden phrase, or this fixture proves nothing');

      const r = cli(p.dir, 'removals');
      assert.equal(r.json.outcome, 'PASS', `render.js's own bullet was scanned as a live reintroduction of the feature it names: ${JSON.stringify(r.json.rows)}`);
      assert.ok(r.json.checks.some((c) => c.check === 'removals:clear'), 'the row must read as clear, not merely absent from a failure list');
      assert.ok(!r.json.checks.some((c) => c.check === 'removals:D-090'), 'a clear row gets no per-id check at all — one appearing here means it was NOT clear');
    } finally { rm(p.dir); }
  });

  // (2) CORRECTED. The same fixture through the full savepoint pipeline: PASS end to end, and a second
  // render of the same state reproduces the generated block byte-for-byte — the fix must not cost the
  // digest-stable writeback the drift check depends on.
  test('corrected: savepoint --verify PASSes with the doc already on disk, and re-rendering is byte-identical', () => {
    const p = fixture();
    try {
      const first = seedContinuity(p.dir);
      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 0, `savepoint --verify: ${JSON.stringify((r.json && r.json.checks || []).filter((c) => c.outcome !== 'PASS'))}`);
      assert.equal(r.json.outcome, 'PASS');

      const second = render.renderContinuity(stateLib.compile(p.dir).state, first);
      assert.equal(render.driftFromGenerated(first, second, 'CONTINUITY.md').outcome, OUTCOME.PASS,
        'a fresh render must reproduce the same generated block byte-for-byte');
    } finally { rm(p.dir); }
  });

  // (3) NEAREST BYPASS. The fix must not blind the scan to a REAL reintroduction:
  //   (a) a live sentence OUTSIDE the generated block (the free-form NOTE) still FAILs;
  //   (b) a hand-edit INSIDE the generated block, under the now-history-recognised heading, is no
  //       longer the removals scan's job to catch — and IS still caught, by the generated-block drift
  //       check, which compares the whole block byte-for-byte regardless of what changed inside it.
  test('nearest bypass: a reintroduction outside the generated block still FAILs; one hand-edited inside it is still caught by drift', () => {
    const p = fixture();
    try {
      const rendered = seedContinuity(p.dir);

      const withNote = rendered.replace(NOTE_RE, `${render.NOTE_OPEN}\nWe re-enabled the ${FORBIDDEN} and it is live and enabled by default.\n${render.NOTE_CLOSE}`);
      assert.notEqual(withNote, rendered, 'sanity: the NOTE block must actually change');
      fs.writeFileSync(path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md'), withNote);
      const outside = cli(p.dir, 'removals');
      assert.equal(outside.json.outcome, 'FAIL', 'a live reintroduction outside the generated block must still be caught');
      const violated = outside.json.rows.find((row) => row.id === 'D-090');
      assert.equal(violated && violated.status, 'violated');

      const bullet = `- \`D-090\` — ${FEATURE}`;
      const tampered = rendered.replace(bullet, `${bullet}, freshly re-enabled and live`);
      assert.notEqual(tampered, rendered, 'sanity: the generated block must actually change');
      fs.writeFileSync(path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md'), tampered);
      const inside = cli(p.dir, 'removals');
      assert.equal(inside.json.outcome, 'PASS',
        'documenting the accepted boundary: a section under a recognised history heading is invisible to the removals scan by design, including a hand-edit made there');

      const fresh = render.renderContinuity(stateLib.compile(p.dir).state, null);
      assert.equal(render.driftFromGenerated(tampered, fresh, 'CONTINUITY.md').outcome, OUTCOME.FAIL,
        'the generated-block drift check must still catch a hand-edit inside the generated block, since the removals scan alone no longer does');
    } finally { rm(p.dir); }
  });
});

// --- BUG-3 · the removal scan and the reconciliation run ONCE per savepoint ------------------------
//
// `state.js` compile() already runs both `removalsLib.runRemovalScan` and `reconcileLib.runReconciliation`
// to derive `state.removals` / `state.reconciliation` — and used to keep only their summary verdicts,
// discarding the per-row `checks` those scans produced. `cmdSavepoint` then invoked BOTH scans a SECOND
// time to get the rows it actually pushes onto its own `checks[]`. Same function, same tree, same
// process, paid for twice: on a 2,000-file / 24 MB corpus this measured as ~50% of `savepoint --verify`
// wall time. The fix returns the scans' full results from compile() so savepoint reuses them.

/*
 * A project with a REAL removals registry (GAUNTLET_ROW) and a REAL reconcile config, so a shared scan
 * has substantive rows to share for BOTH contracts — not just an unconfigured coverage row. `productBody`
 * lets a test introduce (or omit) a live reintroduction of the killed feature.
 *
 * `configured: false` is the OTHER state the shared result has to survive: no `removals.json` and no
 * `liveContentDirs`, so the scan reports the `removals:config` CANNOT_DETERMINE coverage row instead of
 * a verdict on any file. Sharing a row must not change an unconfigured contract into a configured one
 * (anti-drift 14) — the reconcile side stays configured either way so one axis moves at a time.
 */
function bug3Fixture(productBody = '# Product\n\nOrdinary content, nothing retired.\n', { configured = true } = {}) {
  const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
  fs.mkdirSync(path.join(p.dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, 'docs', 'PRODUCT.md'), productBody);
  if (configured) fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify(GAUNTLET_ROW, null, 2));
  fs.writeFileSync(path.join(p.dir, 'tasks.json'), JSON.stringify({ schemaVersion: '1.0.0', tasks: [{ id: 'R-1', status: 'open' }] }, null, 2));
  fs.writeFileSync(path.join(p.dir, 'gaps.json'), JSON.stringify({ schemaVersion: '1.0.0', gaps: [{ id: 'R-1', status: 'open' }] }, null, 2));
  fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), JSON.stringify({
    routeSource: { notApplicable: true, reason: 'fixture: serves no routes' },
    codeTruth: { notApplicable: true, reason: 'fixture: no code-truth source' },
    qualityGate: { notApplicable: true, reason: 'fixture: no quality gate' },
    state: {
      removals: configured ? { liveContentDirs: ['docs'] } : {},
      reconcile: {
        tasks: { kind: 'json', path: 'tasks.json', pointer: 'tasks' },
        project: { kind: 'json', path: 'gaps.json', pointer: 'gaps' },
      },
    },
  }, null, 2));
  return p;
}

/**
 * The index at which `run` appears in `rows` as a CONTIGUOUS, IN-ORDER, field-for-field identical
 * block, or -1. Rows are compared as serialised JSON rather than by id, because "the rows are the same
 * rows" is the whole claim — an id match would pass on a row whose detail, `checked` or outcome moved.
 */
function indexOfRowRun(rows, run) {
  const hay = rows.map((r) => JSON.stringify(r));
  const needle = run.map((r) => JSON.stringify(r));
  if (!needle.length) return -1;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    if (needle.every((n, j) => n === hay[i + j])) return i;
  }
  return -1;
}

describe('BUG-3 · the removal scan and the reconciliation run ONCE per savepoint', () => {
  /*
   * A require-time seam, not a production change: preload a tiny CommonJS script (via node's `-r`) that
   * requires the two scan modules by the SAME absolute path `state.js` (`require('./removals.js')`) and
   * `respawnpack.js` (`lazyLib` → `modhealth.probePath` → `require(abs)`) resolve to, and wraps their
   * exported `runRemovalScan` / `runReconciliation` to count calls before returning the real result. Node
   * caches a module by resolved absolute path, so whichever of the two files requires it AFTER the
   * preload gets back the SAME (now-wrapped) exports object — one counter, however many requirers there
   * turn out to be. Counts are reported back to this (parent) process on `exit`, via a file named by an
   * env var, since `cli()` runs the kernel as a real child process.
   */
  const countPreloadSource = [
    "'use strict';",
    'const fs = require(\'fs\');',
    `const removalsLib = require(${JSON.stringify(path.join(KERNEL, 'lib', 'removals.js'))});`,
    `const reconcileLib = require(${JSON.stringify(path.join(KERNEL, 'lib', 'reconcile.js'))});`,
    'const counts = { removals: 0, reconcile: 0 };',
    'const origScan = removalsLib.runRemovalScan;',
    'removalsLib.runRemovalScan = function (...a) { counts.removals += 1; return origScan.apply(this, a); };',
    'const origRecon = reconcileLib.runReconciliation;',
    'reconcileLib.runReconciliation = function (...a) { counts.reconcile += 1; return origRecon.apply(this, a); };',
    'process.on(\'exit\', () => {',
    '  const out = process.env.RESPAWNPACK_TEST_SCAN_COUNT_FILE;',
    '  if (!out) return;',
    '  try { fs.writeFileSync(out, JSON.stringify(counts)); } catch { /* best effort — the test reports a missing file itself */ }',
    '});',
  ].join('\n');

  /**
   * Run the CLI with the counting preload attached; returns the usual `cli()` shape plus `.counts`.
   * Both the preload script and the count file live under one mkdtemp'd directory removed at the end of
   * the call, so this leaves nothing behind — the same convention `project()`'s `rm(p.dir)` callers use.
   */
  const scanCounts = (dir, ...args) => {
    const countDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-bug3-count-'));
    const preload = path.join(countDir, 'preload.cjs');
    const countFile = path.join(countDir, 'counts.json');
    fs.writeFileSync(preload, countPreloadSource);
    const r = spawnSync(process.execPath, ['-r', preload, CLI, ...args, '--dir', dir, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, RESPAWNPACK_TEST_SCAN_COUNT_FILE: countFile },
    });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
    let counts = null; try { counts = JSON.parse(fs.readFileSync(countFile, 'utf8')); } catch { /* left null */ }
    rm(countDir);
    return { code: r.status, json, counts, stdout: r.stdout, stderr: r.stderr };
  };

  // (1) THE ORIGINAL DEFECT, AS A FAILING ASSERTION AGAINST PRE-FIX CODE. Against the code before this
  // fix, `removalsLib.runRemovalScan` and `reconcileLib.runReconciliation` are each called once inside
  // `stateLib.compile()` and once more directly by `cmdSavepoint` — this asserts exactly one of each.
  test('savepoint --verify invokes the removal scan and the reconciliation exactly once each', () => {
    const p = bug3Fixture();
    try {
      const r = scanCounts(p.dir, 'savepoint', '--verify');
      assert.ok(r.counts, `the counting preload never reported back — stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.equal(r.counts.removals, 1,
        `the removal scan ran ${r.counts.removals} time(s) for one savepoint — compile() and cmdSavepoint must share one scan, not each run their own`);
      assert.equal(r.counts.reconcile, 1,
        `the reconciliation ran ${r.counts.reconcile} time(s) for one savepoint — compile() and cmdSavepoint must share one run, not each run their own`);
      assert.equal(r.json.outcome, 'PASS', 'the fixture itself must be a clean pass, or the counts above are not testing the common case');
    } finally { rm(p.dir); }
  });

  // (2) CORRECTED: STATE.json and the --json check rows are unaffected by SHARING the scan — captured
  // from a real run of this exact fixture recipe against the pre-fix code (kept in the task scratch dir)
  // and confirmed byte-identical to the post-fix run below, except for the state-writeback digest, which
  // is bound to each fixture instance's own git commit and legitimately differs between ANY two runs.
  test('STATE.json and the savepoint --json check rows are exactly what a single shared scan should produce', () => {
    const p = bug3Fixture();
    try {
      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 0);
      assert.equal(r.json.outcome, 'PASS');

      const [writeback, ...rest] = r.json.checks;
      assert.equal(writeback.check, 'state-writeback');
      assert.equal(writeback.outcome, 'PASS');
      assert.match(writeback.detail, /^STATE\.json did not exist and was created; the write is verified by digest \([0-9a-f]{12}\)$/,
        'the digest value itself is bound to this fixture\'s own git commit and is asserted only for shape');

      // Forward slashes, not path.join: check ids are POSIX-spelled on every platform (BUG-2 / K-02), so
      // the expected literal below must be too, rather than picking up the host separator on Windows.
      const CONTINUITY = 'docs/derived/CONTINUITY.md';
      const GAPS = 'docs/derived/GAPS.md';
      // P2-O-3's third render target. It joins the pinned capture as one more NOT_APPLICABLE row on a
      // fixture that has no derived docs at all — the pin is about what a SHARED SCAN reports, and a new
      // render target is not a change to that.
      const LESSONS = 'docs/derived/LESSONS.md';
      assert.deepEqual(rest, [
        { outcome: 'NOT_APPLICABLE', check: `render:${CONTINUITY}`, detail: 'not present in this project', checked: null },
        { outcome: 'NOT_APPLICABLE', check: `render:${GAPS}`, detail: 'not present in this project', checked: null },
        { outcome: 'NOT_APPLICABLE', check: `render:${LESSONS}`, detail: 'not present in this project', checked: null },
        { outcome: 'PASS', check: 'removals:clear', detail: '1 removal(s) with no live assertion across 1 file(s) in docs', checked: 1 },
        LINEAGE_UNDECLARED_ROW,
        { outcome: 'PASS', check: 'reconcile', detail: '1 task record(s) and 1 project record(s) agree', checked: 2 },
        { outcome: 'NOT_APPLICABLE', check: 'routes:config', detail: 'declared not applicable: fixture: serves no routes', checked: null, domain: 'coverage', applicability: 'NOT_APPLICABLE' },
        { outcome: 'NOT_APPLICABLE', check: 'codeTruth:config', detail: 'declared not applicable: fixture: no code-truth source', checked: null, domain: 'coverage', applicability: 'NOT_APPLICABLE' },
      ], 'checks[] must be byte-identical (bar the writeback digest) to a captured pre-fix run on this same fixture recipe — sharing the scan result must not change what either contract reports');

      // STATE.json, compiled from the SAME single scan, must agree with checks[] rather than reflect a
      // second, separately-timed scan of its own.
      const state = JSON.parse(fs.readFileSync(path.join(p.dir, stateLib.STATE_FILE), 'utf8'));
      assert.equal(state.removals.status, 'PASS');
      assert.equal(state.removals.scannedFiles, 1);
      assert.equal(state.reconciliation.status, 'PASS');
    } finally { rm(p.dir); }
  });

  // (3) NEAREST BYPASS: sharing the rows must not be able to swallow a verdict. A removal scan that
  // reports FAIL still fails the savepoint with the same row and the same exit code — even though (per
  // test 1's mechanism, exercised again here) the scan still runs only once.
  test('a FAIL from the removal scan still fails savepoint with the same row and exit code, scanned once', () => {
    const p = bug3Fixture('# Product\n\nShips four magic gauntlets.\n');
    try {
      const r = scanCounts(p.dir, 'savepoint', '--verify');
      assert.ok(r.counts, `the counting preload never reported back — stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.equal(r.counts.removals, 1, 'a FAIL fixture must still scan exactly once — sharing rows is not conditional on the verdict');

      assert.equal(r.json.outcome, 'FAIL');
      assert.equal(r.code, 1, 'a FAIL savepoint must exit 1 — a swallowed verdict would read as CANNOT_DETERMINE (2) or PASS (0), never this');

      const failRows = r.json.checks.filter((c) => c.check === 'removals:D-075');
      assert.equal(failRows.length, 1, 'the violation must appear exactly once in checks[] — sharing the scan result must not duplicate or drop it');
      assert.equal(failRows[0].outcome, 'FAIL');
      assert.match(failRows[0].detail, /magic gauntlet/);

      // And STATE.json — compiled from the SAME single scan — must not disagree with checks[].
      const state = JSON.parse(fs.readFileSync(path.join(p.dir, stateLib.STATE_FILE), 'utf8'));
      assert.equal(state.removals.status, 'FAIL');
      const killed = state.killedFeatures.find((k) => k.id === 'D-075');
      assert.ok(killed, 'STATE.json must still list the violated killed feature');
      assert.equal(killed.status, 'violated');
    } finally { rm(p.dir); }
  });

  /*
   * THE THREE STATES OF THE SHARED RESULT, ASSERTED AGAINST THE DIRECT VERBS RATHER THAN A LITERAL.
   * The two tests above pin the rows against a captured expectation; these pin them against the OTHER
   * PRODUCER of the same rows in the same tree — `removals` and `reconcile` invoked as their own verbs
   * — so "savepoint reuses the compiler's scan" and "the verbs cannot disagree" are one assertion.
   * The direct verbs run FIRST: `savepoint` bootstraps STATE.json and captures candidate memories, and
   * a scan compared against a tree the comparison itself changed proves nothing.
   */
  const sharedRowsMatchTheDirectVerbs = (p) => {
    const removals = cli(p.dir, 'removals');
    const reconcile = cli(p.dir, 'reconcile');
    const sp = cli(p.dir, 'savepoint', '--verify');
    assert.ok(removals.json && removals.json.checks.length, 'the removals verb reported no rows at all — nothing is being compared');
    assert.ok(reconcile.json && reconcile.json.checks.length, 'the reconcile verb reported no rows at all — nothing is being compared');

    const remAt = indexOfRowRun(sp.json.checks, removals.json.checks);
    const recAt = indexOfRowRun(sp.json.checks, reconcile.json.checks);
    assert.notEqual(remAt, -1,
      `savepoint's checks[] does not contain the removals verb's rows verbatim and in order.\n  verb:      ${JSON.stringify(removals.json.checks)}\n  savepoint: ${JSON.stringify(sp.json.checks)}`);
    assert.notEqual(recAt, -1,
      `savepoint's checks[] does not contain the reconcile verb's rows verbatim and in order.\n  verb:      ${JSON.stringify(reconcile.json.checks)}\n  savepoint: ${JSON.stringify(sp.json.checks)}`);
    assert.ok(remAt < recAt, 'the killed-feature rows must still precede the reconciliation rows — the shared result must not reorder checks[]');
    return sp;
  };

  test('a CONFIGURED scan folds into savepoint as exactly the rows the removals and reconcile verbs report', () => {
    const p = bug3Fixture();
    try {
      const sp = sharedRowsMatchTheDirectVerbs(p);
      assert.equal(sp.json.outcome, 'PASS');
      assert.equal(sp.code, 0);
      assert.ok(sp.json.checks.some((c) => c.check === 'removals:clear' && c.checked === 1),
        'the configured scan must report a real file count, or this fixture is not exercising a configured contract');
    } finally { rm(p.dir); }
  });

  test('an UNCONFIGURED scan folds in the same way — a shared row never upgrades it to a verdict', () => {
    const p = bug3Fixture(undefined, { configured: false });
    try {
      const sp = sharedRowsMatchTheDirectVerbs(p);
      /*
       * Anti-drift 14: an unconfigured killed-feature contract is CANNOT_DETERMINE and exit 2, whether
       * the row travelled through the compiler or came straight off the verb. A shared result that
       * quietly became a PASS here would be the forged green the whole contract exists to refuse.
       */
      const row = sp.json.checks.find((c) => c.check === 'removals:config');
      assert.ok(row, 'the unconfigured coverage row must still be present in savepoint checks[]');
      assert.equal(row.outcome, 'CANNOT_DETERMINE');
      assert.equal(row.checked, 0);
      assert.equal(sp.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(sp.code, 2, 'could-not-run is exit 2, never 0 and never 1');
      assert.ok(!sp.json.checks.some((c) => c.check === 'removals:clear'),
        'an unconfigured contract must not also emit the configured all-clear row');
    } finally { rm(p.dir); }
  });

  /**
   * Run the CLI with `removalsLib.runRemovalScan` replaced by a thrower, using the same require-time
   * preload seam as `scanCounts` above (node caches by resolved absolute path, so `state.js` and
   * `respawnpack.js` both get the wrapped exports). This is how a scan that dies mid-walk — an
   * unreadable tree, a corpus that moved under it — reaches both call sites at once.
   */
  const throwingScan = (dir, ...args) => {
    const preloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-bug3-throw-'));
    const preload = path.join(preloadDir, 'preload.cjs');
    fs.writeFileSync(preload, [
      "'use strict';",
      `const removalsLib = require(${JSON.stringify(path.join(KERNEL, 'lib', 'removals.js'))});`,
      "removalsLib.runRemovalScan = function () { throw new Error('the corpus walk exploded'); };",
    ].join('\n'));
    const r = spawnSync(process.execPath, ['-r', preload, CLI, ...args, '--dir', dir, '--json'], { encoding: 'utf8' });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
    rm(preloadDir);
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };

  for (const mode of ['--verify', '--write']) {
    test(`a scan that THROWS produces the CANNOT_DETERMINE row exactly once, not twice (savepoint ${mode})`, () => {
      const p = bug3Fixture();
      try {
        const r = throwingScan(p.dir, 'savepoint', mode);
        assert.ok(r.json && Array.isArray(r.json.checks),
          `a throwing scan must still produce a checks[] payload, not a runner-level error envelope — got: ${r.stdout.slice(0, 400)}`);

        /*
         * ⛔ EXACTLY ONE. `stateLib.compileRemovals` catches the throw and builds this row; before the
         * shared result existed, `cmdSavepoint` then invoked the scan again, and the obvious wrong fix
         * to that is to push BOTH the compiler's row and a re-scan's. One fault, one row.
         */
        const rows = r.json.checks.filter((c) => c.check === 'removals');
        assert.equal(rows.length, 1,
          `the removal-scan-could-not-run row appeared ${rows.length} time(s) — one fault must produce one row`);
        assert.equal(rows[0].outcome, 'CANNOT_DETERMINE');
        assert.equal(rows[0].checked, 0);
        assert.match(rows[0].detail, /the removal scan could not run: the corpus walk exploded/);

        // And "could not run" never collapses into "failed" (anti-drift 2), in either mode.
        assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
        assert.equal(r.code, 2, 'a scan that could not run is exit 2, not the runner\'s catch-all 1');
      } finally { rm(p.dir); }
    });
  }

  /*
   * ⛔ THE ONE RUN WHERE SHARING WOULD FORGE A GREEN, AS A REGRESSION FIXTURE. `savepoint --write`
   * REGENERATES docs/derived/CONTINUITY.md inside a configured `liveContentDirs`, so the compiler's
   * pre-render scan describes a tree that no longer exists by the time the rows are reported. Here the
   * forbidden phrase exists ONLY as a requirement title in requirements.json — a .json file no scan
   * reads — and reaches scannable markdown solely through the render. Sharing the pre-render scan
   * returned PASS/exit 0 on this fixture; the post-render scan returns FAIL/exit 1.
   */
  test('a --write run scans the docs it just wrote: a killed feature the RENDER introduces still fails', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true, title: 'Restore the magic gauntlet progression path' }] });
    try {
      fs.mkdirSync(path.join(p.dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'docs', 'PRODUCT.md'), '# Product\n\nOrdinary content, nothing retired.\n');
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify(GAUNTLET_ROW, null, 2));
      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), JSON.stringify({
        routeSource: { notApplicable: true, reason: 'fixture: serves no routes' },
        codeTruth: { notApplicable: true, reason: 'fixture: no code-truth source' },
        qualityGate: { notApplicable: true, reason: 'fixture: no quality gate' },
        state: { removals: { liveContentDirs: ['docs'] }, reconcile: { notApplicable: true, reason: 'fixture: no task system' } },
      }, null, 2));

      // The discriminating control: nothing scannable says it yet, so a verify-only run is honestly clear.
      const before = cli(p.dir, 'savepoint', '--verify');
      assert.equal(before.json.checks.find((c) => c.check === 'removals:clear').outcome, 'PASS',
        'the pre-render tree must be genuinely clear, or the --write assertion below proves nothing');

      const written = scanCounts(p.dir, 'savepoint', '--write');
      assert.ok(written.counts, `the counting preload never reported back — stdout: ${written.stdout}\nstderr: ${written.stderr}`);
      assert.equal(written.counts.removals, 2,
        'a writing savepoint pays for the scan twice ON PURPOSE: once in the compiler for STATE.json, once after the render for the rows it reports');
      assert.equal(written.counts.reconcile, 1,
        'the reconciliation is still shared on a writing run — its sources are json/adapter/requirements, which the render cannot move');

      const rendered = fs.readFileSync(path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md'), 'utf8');
      assert.match(rendered, /magic gauntlet/, 'the render must actually put the retired phrase into a scanned document');
      const fail = written.json.checks.find((c) => c.check === 'removals:D-075');
      assert.ok(fail, `--write scanned the pre-render tree and never saw the doc it wrote: ${JSON.stringify(written.json.checks)}`);
      assert.equal(fail.outcome, 'FAIL');
      assert.match(fail.detail, /CONTINUITY\.md:\d+/, 'the failure must name the rendered file it was found in');
      assert.equal(written.code, 1, 'a live reintroduction is exit 1 whether prose or a render put it there');
    } finally { rm(p.dir); }
  });

  /*
   * THE SOURCE FENCE. The behavioural tests above can only observe the counts a fixture happens to
   * exercise; this reads `cmdSavepoint`'s own body and pins the shape the saving depends on, so a later
   * edit that quietly reinstates a second reconciliation, or drops the post-render re-scan, fails here
   * rather than in whichever project first pays for it.
   */
  test('cmdSavepoint reuses the compiler\'s scans and never runs its own reconciliation', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    const start = src.indexOf('function cmdSavepoint()');
    assert.notEqual(start, -1, 'cmdSavepoint is gone or was renamed — every claim below is about nothing');
    const end = src.indexOf('\nfunction ', start + 1);
    assert.notEqual(end, -1, 'could not find the end of cmdSavepoint');
    /*
     * Comments stripped before counting: this body EXPLAINS both scans at length, and prose naming
     * `runReconciliation` is not a call to it. Block comments and whole-line `//` comments only, which
     * is every comment in this function — a cleverer stripper would be a parser nobody asked for.
     */
    const body = src.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    assert.match(body, /checks\.push\(\.\.\.reconciliation\.checks\)|relaxCoverage\(reconciliation\.checks,/,
      'savepoint must fold in the reconciliation compile() already ran');
    assert.equal((body.match(/runReconciliation\(/g) || []).length, 0,
      'savepoint invoked runReconciliation itself — that is the second run BUG-3 removed; the compiler already ran it');
    assert.match(body, /removalRows = removalsScan\.checks/,
      'savepoint must reuse the compiler\'s removal scan on a run that did not rewrite the tree');
    assert.equal((body.match(/runRemovalScan\(/g) || []).length, 1,
      'savepoint must call runRemovalScan exactly once, and only for the post-render re-scan');
    /*
     * P4-K-08 renamed this guard from `write` to `wroteDocs` and did not weaken it. `wroteDocs` is
     * `write && renderRan`, so it is TRUE in exactly the case the old guard named — a run that
     * rewrote the derived docs — and FALSE for the new one it also has to cover: a `--write` run
     * scoped with `--skip render`, which wrote nothing, so the compiler's scan still describes this
     * tree and re-scanning it would be the second scan BUG-3 removed. The fence pins the definition
     * too, so the name cannot be rebound to something looser without failing here.
     */
    assert.match(body, /const wroteDocs = write && renderRan;/,
      '`wroteDocs` is no longer `write && renderRan` — the re-scan guard below is pinned to that meaning, and a looser one reinstates the double scan');
    assert.match(body, /if \(wroteDocs\) \{\s*try \{ removalRows = removalsLib\.runRemovalScan\(DIR\)\.checks; \}/,
      'the one remaining scan call must stay guarded by `wroteDocs` — an unconditional call is the double scan again, and an unguarded one turns a broken scan into a FAIL instead of CANNOT_DETERMINE');
  });

  /*
   * P4-K-08 · `--only` MUST NOT REINTRODUCE THE SCAN BUG-3 REMOVED. The scoping flags gave the re-scan
   * guard a second input (`renderRan`), which is exactly the shape that quietly restores a double scan:
   * every scope that includes `removals` is checked here, verify and write alike.
   */
  test('P4-K-08 · no scope reintroduces a second removal scan', () => {
    const p = bug3Fixture();
    try {
      for (const [args, expected, why] of [
        [['savepoint', '--verify'], 1, 'the unscoped verify baseline'],
        [['savepoint', '--verify', '--only', 'compile,removals'], 1, 'a scope that asks for the removals rows and nothing that writes'],
        [['savepoint', '--verify', '--skip', 'render'], 1, 'skipping the render leaves the compiler\'s scan describing this tree'],
        // `--write --skip render` wrote nothing, so the pre-render scan is still current: ONE scan,
        // where an unscoped `--write` legitimately pays for two.
        [['savepoint', '--write', '--skip', 'render'], 1, 'a writing run that rendered nothing must not re-scan a tree it did not move'],
        [['savepoint', '--write'], 2, 'an unscoped writing run still re-scans the docs it just wrote'],
      ]) {
        const r = scanCounts(p.dir, ...args);
        assert.ok(r.counts, `the counting preload never reported back for ${args.join(' ')} — stdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert.equal(r.counts.removals, expected, `${args.join(' ')} scanned ${r.counts.removals} time(s), expected ${expected}: ${why}`);
        assert.equal(r.counts.reconcile, 1, `${args.join(' ')} ran the reconciliation ${r.counts.reconcile} time(s) — it is always the compiler's`);
      }
    } finally { rm(p.dir); }
  });
});

// --- P4-K-08 · `savepoint --only` / `--skip`, the ten named stages ----------------------------------
//
// ⛔ THE VERB LIST WAS NEVER THE UNIT OF SCOPING (the kernel audit §2.1). `savepoint` is ten subsystems in a
// trenchcoat, and the only way to run fewer of them was to type a different verb — `removals` for one,
// `reconcile` for another, nothing at all for the other seven. Naming the stages and filtering them is
// what every "make it lighter" request was actually asking for.
//
// ⛔ AND THE RISK IS THE WHOLE DESIGN. `--skip` is a flag a caller could use to forge a green, so every
// stage that does not run leaves a NOT_APPLICABLE row saying it was SKIPPED BY REQUEST, the receipt
// records the set, and the text output leads its verdict with a PARTIAL SAVEPOINT line. Anti-drift item
// 14 applies per stage: a skipped `removals` on a tree with a populated registry is never a PASS.

describe('P4-K-08 · savepoint --only / --skip', () => {
  const STAGES = ['compile', 'writeback', 'render', 'verify', 'removals', 'lineage', 'reconcile', 'coverage', 'adapters', 'memory'];
  const receiptOf = (dir) => {
    const f = path.join(dir, '.respawnpack', 'runtime', 'savepoint-attempt.json');
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  };
  const rmReceipt = (dir) => { try { fs.rmSync(path.join(dir, '.respawnpack', 'runtime', 'savepoint-attempt.json')); } catch { /* absent */ } };

  /*
   * STATE 1 · A FULL RUN IS UNCHANGED.
   *
   * The rows below were captured from the UNMODIFIED tree at 9726e85, before `--only`/`--skip` existed,
   * on this same `bug3Fixture` recipe — the pack's most substantive kernel fixture, with a real removals
   * registry and a real reconcile configuration so every stage has something to say. They are asserted
   * field-for-field: adding a scoping mechanism must not move one byte of what an unscoped savepoint
   * reports, and a diff here is the regression, not a re-baseline.
   */
  test('a full run is byte-identical to the pre-scoping capture, and no stage row appears', () => {
    const p = bug3Fixture();
    try {
      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 0);
      assert.equal(r.json.outcome, 'PASS');

      const [writeback, ...rest] = r.json.checks;
      assert.equal(writeback.check, 'state-writeback');
      assert.equal(writeback.outcome, 'PASS');
      // The digest is bound to this fixture instance's own git commit and differs between ANY two runs.
      assert.match(writeback.detail, /^STATE\.json did not exist and was created; the write is verified by digest \([0-9a-f]{12}\)$/);

      const CONTINUITY = 'docs/derived/CONTINUITY.md';
      const GAPS = 'docs/derived/GAPS.md';
      // P2-O-3's third render target. It joins the pinned capture as one more NOT_APPLICABLE row on a
      // fixture that has no derived docs at all — the pin is about what a SHARED SCAN reports, and a new
      // render target is not a change to that.
      const LESSONS = 'docs/derived/LESSONS.md';
      assert.deepEqual(rest, [
        { outcome: 'NOT_APPLICABLE', check: `render:${CONTINUITY}`, detail: 'not present in this project', checked: null },
        { outcome: 'NOT_APPLICABLE', check: `render:${GAPS}`, detail: 'not present in this project', checked: null },
        { outcome: 'NOT_APPLICABLE', check: `render:${LESSONS}`, detail: 'not present in this project', checked: null },
        { outcome: 'PASS', check: 'removals:clear', detail: '1 removal(s) with no live assertion across 1 file(s) in docs', checked: 1 },
        LINEAGE_UNDECLARED_ROW,
        { outcome: 'PASS', check: 'reconcile', detail: '1 task record(s) and 1 project record(s) agree', checked: 2 },
        { outcome: 'NOT_APPLICABLE', check: 'routes:config', detail: 'declared not applicable: fixture: serves no routes', checked: null, domain: 'coverage', applicability: 'NOT_APPLICABLE' },
        { outcome: 'NOT_APPLICABLE', check: 'codeTruth:config', detail: 'declared not applicable: fixture: no code-truth source', checked: null, domain: 'coverage', applicability: 'NOT_APPLICABLE' },
      ], 'an unscoped savepoint\'s checks[] must be byte-identical (bar the writeback digest) to the pre-P4-K-08 capture');

      assert.ok(!r.json.checks.some((c) => String(c.check).startsWith('stage:')),
        'a full run must emit NO skipped-stage row — the scoping machinery is inert when nothing was scoped');
      assert.deepEqual(r.json.stages, { requested: STAGES, ran: STAGES, skipped: [] });
      assert.deepEqual(receiptOf(p.dir).stages, { requested: STAGES, ran: STAGES, skipped: [] });
      assert.match(receiptOf(p.dir).sourceRevision, /^[0-9a-f]{40}$/,
        'a FULL run still offers its sourceRevision — that is the claim only a partial run withholds');
    } finally { rm(p.dir); }
  });

  /*
   * STATE 2 · A SCOPED RUN NAMES EVERY STAGE IT DID NOT RUN, AND THE RECEIPT RECORDS THE SET.
   *
   * Asserted as a total: for every one of the ten, either it ran or there is a row saying it was
   * skipped BY REQUEST. "The output is shorter" is precisely the reading that would let a partial run
   * pass for a full one, so absence is never allowed to be the report.
   */
  test('a scoped run reports EVERY skipped stage as NOT_APPLICABLE-by-request', () => {
    const p = bug3Fixture();
    try {
      const r = cli(p.dir, 'savepoint', '--verify', '--only', 'compile,writeback,render,verify');
      const ran = ['compile', 'writeback', 'render', 'verify'];
      const skipped = ['removals', 'lineage', 'reconcile', 'coverage', 'adapters', 'memory'];
      assert.deepEqual(r.json.stages, { requested: ran, ran, skipped });

      for (const name of skipped) {
        const row = r.json.checks.find((c) => c.check === `stage:${name}`);
        assert.ok(row, `the \`${name}\` stage was skipped and left no row — a shorter list of rows is not a report`);
        assert.equal(row.outcome, 'NOT_APPLICABLE', `\`${name}\` was skipped and must never be reported as anything but NOT_APPLICABLE`);
        assert.equal(row.label, 'SKIPPED_BY_REQUEST');
        assert.equal(row.skippedByRequest, true);
        assert.match(row.detail, /SKIPPED BY REQUEST/);
      }
      for (const name of ran) {
        assert.equal(r.json.checks.some((c) => c.check === `stage:${name}`), false,
          `\`${name}\` ran and must NOT carry a skipped-stage row`);
      }

      // The receipt is the durable half of the same statement.
      const receipt = receiptOf(p.dir);
      assert.deepEqual(receipt.stages, { requested: ran, ran, skipped });
      /*
       * ⛔ AND THE PARTIAL RECEIPT WITHHOLDS ITS `sourceRevision`. hooks/stop-savepoint.js reads exactly
       * `exitCode === 0` plus a `sourceRevision` inside HEAD's chain to decide the closeout is DONE and
       * go quiet. A scoped run can exit 0 having checked four stages of ten, so publishing that pair
       * would retire the nag for a savepoint that never happened — `--skip` forging a green in the one
       * reader that acts on this file. The claim is withheld; `stages` beside it hides nothing.
       */
      assert.equal(receipt.sourceRevision, null,
        'a PARTIAL run must not offer the sourceRevision the Stop hook reads as "the closeout is done"');
      assert.match(receipt.head, /^[0-9a-f]{40}$/, 'where the run happened is still recorded — only the CLAIM is withheld');

      // And the text output says it at the summary, where a reader quotes the verdict from.
      const text = spawnSync(process.execPath, [CLI, 'savepoint', '--verify', '--only', 'compile,writeback,render,verify', '--dir', p.dir], { encoding: 'utf8' });
      assert.match(text.stdout, /PARTIAL SAVEPOINT/);
      assert.match(text.stdout, /SKIPPED BY REQUEST: removals, lineage, reconcile, coverage, adapters, memory/);
    } finally { rm(p.dir); }
  });

  /*
   * STATE 3 · AN UNKNOWN STAGE REFUSES RATHER THAN SILENTLY RUNNING EVERYTHING.
   *
   * Both flags, because the failure modes differ and both are wrong: a typo'd `--skip` name that was
   * ignored would run a stage the caller asked to drop, and a typo'd `--only` name that was ignored
   * would match nothing and report success over a run of nothing.
   */
  test('an unknown stage name refuses at exit 2, names the valid set, and runs nothing', () => {
    const p = bug3Fixture();
    try {
      for (const args of [['--only', 'remvoals'], ['--skip', 'memroy'], ['--only', 'compile,notastage']]) {
        rmReceipt(p.dir);
        const r = cli(p.dir, 'savepoint', '--verify', ...args);
        assert.equal(r.code, 2, `${args.join(' ')} must exit 2 — a scope this kernel cannot resolve is CANNOT_DETERMINE, never a full run`);
        assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
        const row = r.json.checks.find((c) => c.check === 'savepoint:stages');
        assert.ok(row, 'the refusal must be a row, not only an exit code');
        assert.match(row.detail, /unknown savepoint stage/);
        for (const s of STAGES) assert.match(row.detail, new RegExp(`\\b${s}\\b`), `the refusal must name \`${s}\` among the valid stages`);
        assert.deepEqual(r.json.validStages, STAGES);

        // NOTHING RAN: no stage row, no verdicts, and — the durable half — no receipt was written over
        // whatever the last real attempt left behind.
        assert.equal(r.json.checks.length, 1, 'a refused scope must produce exactly the refusal row and no check of any stage');
        assert.equal(r.json.stages, undefined, 'a refusal resolved no scope, so it must not report one');
        assert.equal(receiptOf(p.dir), null, 'a refused scope never became an attempt and must not overwrite the receipt');
      }
    } finally { rm(p.dir); }
  });

  /*
   * THE DEPENDENCY REFUSAL. `compile` is what every later stage reads; a savepoint without it would be
   * reporting on whatever STATE.json was already lying on disk, which is DF-011's shape. It is refused
   * rather than implied, so the scope that was typed is the scope that ran.
   */
  test('a scope that omits the required `compile` stage refuses rather than running on stale state', () => {
    const p = bug3Fixture();
    try {
      // Seed a real STATE.json, so "runs on stale state" is a thing that could actually have happened.
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      for (const args of [['--skip', 'compile'], ['--only', 'render,verify'], ['--only', 'compile', '--skip', 'compile']]) {
        const r = cli(p.dir, 'savepoint', '--verify', ...args);
        assert.equal(r.code, 2, `${args.join(' ')} must refuse at exit 2`);
        const row = r.json.checks.find((c) => c.check === 'savepoint:stages');
        assert.match(row.detail, /`compile` stage is required by every stage after it/);
        assert.match(row.detail, /Nothing ran/);
        assert.equal(r.json.checks.length, 1);
      }
      // And the fix the refusal names is one that works.
      const fixed = cli(p.dir, 'savepoint', '--verify', '--only', 'compile,render,verify');
      assert.notEqual(fixed.code, 2, 'the scope the refusal tells you to write must actually run');
      assert.deepEqual(fixed.json.stages.ran, ['compile', 'render', 'verify']);
    } finally { rm(p.dir); }
  });

  /*
   * ⛔ ANTI-DRIFT ITEM 14, PER STAGE. `removals` is never green on a scan that did not happen, and a
   * skip is a scan that did not happen. This fixture has a POPULATED registry and a configured
   * live-content directory — the state where a full run prints `removals:clear PASS` — so a skip that
   * reported PASS, or reported nothing, would be the forged green the whole contract exists to refuse.
   */
  test('⛔ item 14 · skipping `removals` on a populated registry prints the skip and never a PASS', () => {
    const p = bug3Fixture();
    try {
      assert.equal(cli(p.dir, 'savepoint', '--verify').json.checks.some((c) => c.check === 'removals:clear' && c.outcome === 'PASS'), true,
        'the unscoped run must print the configured all-clear PASS, or this fixture is not exercising a configured contract');

      const r = cli(p.dir, 'savepoint', '--verify', '--skip', 'removals');
      assert.equal(r.json.checks.some((c) => String(c.check).startsWith('removals:')), false,
        'a skipped removals stage must emit NO killed-feature row at all — least of all the all-clear one');
      const row = r.json.checks.find((c) => c.check === 'stage:removals');
      assert.equal(row.outcome, 'NOT_APPLICABLE');
      assert.notEqual(row.outcome, 'PASS');
      assert.match(row.detail, /killed-feature contract was not evaluated/);
      assert.deepEqual(receiptOf(p.dir).stages.skipped, ['removals'],
        'the receipt must record the skip, so a later reader cannot mistake this for a scan that came back clean');
    } finally { rm(p.dir); }
  });

  /*
   * ⛔ AND A `--candidate` HANDED TO A RUN THAT SKIPS `memory` IS NAMED, NOT DROPPED IN SILENCE. It is
   * the one input to this verb whose only purpose is to be written down; discarding it quietly is the
   * same class of quiet as a skipped check nobody printed.
   */
  test('a --candidate dropped by --skip memory is named in the skip row', () => {
    const p = bug3Fixture();
    try {
      const r = cli(p.dir, 'savepoint', '--verify', '--skip', 'memory', '--candidate', 'finding:something learned');
      const row = r.json.checks.find((c) => c.check === 'stage:memory');
      assert.match(row.detail, /1 `--candidate` argument\(s\) were supplied to this run and NONE was recorded/);
      assert.deepEqual(r.json.capturedCandidates, []);
    } finally { rm(p.dir); }
  });

  /*
   * ⛔ THE THREE PLACES THE STAGE NAMES ARE WRITTEN MUST AGREE. The list lives in the kernel source, is
   * printed by `--help`, and is documented in skills/savepoint/SKILL.md — three copies of one fact, and
   * the pack's own argument is that hand-carried lists rot. Read from the RUNNING help output rather
   * than from its source template, so a broken interpolation fails here too.
   */
  test('⛔ the ten stage names agree across the kernel source, the help text and SKILL.md', () => {
    const ROOT_DIR = path.dirname(KERNEL);
    const src = fs.readFileSync(CLI, 'utf8');
    const declared = /const SAVEPOINT_STAGES = \[([^\]]+)\]/.exec(src);
    assert.ok(declared, 'SAVEPOINT_STAGES is gone or was renamed — the other two copies now fence nothing');
    const fromCode = declared[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.deepEqual(fromCode, STAGES, 'the kernel\'s stage list moved; this suite, the help text and SKILL.md all name the old one');

    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout;
    const helpLine = /run a SUBSET of the ten stages, comma-separated:\s*\n\s*([a-z, ]+)\./.exec(help);
    assert.ok(helpLine, `\`respawnpack --help\` no longer lists the stages where this fence reads them:\n${help.slice(0, 800)}`);
    assert.deepEqual(helpLine[1].split(',').map((s) => s.trim()), STAGES,
      'the help text and the kernel disagree about which stages exist');

    const skill = fs.readFileSync(path.join(ROOT_DIR, 'skills', 'savepoint', 'SKILL.md'), 'utf8');
    const skillLine = /<!-- savepoint-stages -->\s*\n(.+)/.exec(skill);
    assert.ok(skillLine, 'skills/savepoint/SKILL.md no longer carries its `<!-- savepoint-stages -->` marker and the stage list under it');
    assert.deepEqual([...skillLine[1].matchAll(/`([a-z]+)`/g)].map((m) => m[1]), STAGES,
      'SKILL.md and the kernel disagree about which stages exist');
  });
});

// --- P4-K-12 · `reconcile` merges into `savepoint --only compile,reconcile` ------------------------
//
// P4-K-08 named `reconcile` one of the ten savepoint stages; this closes the second implementation the
// standalone verb still carried. `cmdReconcile` used to call `reconcileLib.runReconciliation(DIR)`
// itself — a call site the stage's own read of `stateLib.compile(DIR).reconciliation` could silently
// drift away from. It now reads that same field, so the alias and the stage report from one
// computation, and the verb becomes a documented, deprecated alias rather than a second mechanism.
//
// ⛔ THE ALIAS DOES NOT APPLY `applicabilityLib.relaxCoverage`, WHICH THE STAGE DOES. That call is what
// lets a DECLARED `standard`/`strict` posture advise or deny an unconfigured reconciliation (ADR-003
// kernel:R4). Captured from the UNMODIFIED tree: a `standard`-postured, unconfigured fixture exits 2
// through `reconcile` and would exit 0 through a relaxed alias. Folding relaxation in would have moved
// this verb's exit code for every already-postured project the day this shipped, over a declaration the
// verb's own contract never mentioned, so the alias stays unrelaxed — see cmdReconcile()'s own comment.

describe('P4-K-12 · reconcile merges into savepoint --only compile,reconcile', () => {
  const STAGES = ['compile', 'writeback', 'render', 'verify', 'removals', 'lineage', 'reconcile', 'coverage', 'adapters', 'memory'];

  /*
   * THE CAPTURED ROW, asserted as a literal. `bug3Fixture()` declares a real reconcile source pair
   * (tasks.json/gaps.json) that agree, so this is the SAME row P4-K-08's own capture pins two describe
   * blocks up — one more reason a divergence here is a regression, not a re-baseline.
   */
  const AGREE_ROW = { outcome: 'PASS', check: 'reconcile', detail: '1 task record(s) and 1 project record(s) agree', checked: 2 };

  /*
   * STATE 1 · THE ALIAS. Rows and exit code identical to the standalone verb's captured output, on both
   * a PASS and a DRIFT fixture, plus the one line naming the replacement — to STDERR, so a script
   * reading `--json` off stdout is never touched by it.
   */
  test('the alias reports the identical rows and exit code, plus one deprecation line naming the replacement', () => {
    const p = bug3Fixture();
    try {
      const r = cli(p.dir, 'reconcile');
      assert.equal(r.code, 0);
      assert.equal(r.json.outcome, 'PASS');
      assert.deepEqual(r.json.checks, [AGREE_ROW],
        'the alias\'s rows must be byte-identical to the pre-K-12 capture of the standalone verb');
      assert.match(r.stderr, /deprecated/i, 'the alias must print a deprecation notice');
      assert.match(r.stderr, /savepoint --only compile,reconcile/, 'the notice must name the replacement');
      assert.doesNotMatch(r.stdout, /deprecated/i, 'the notice must go to stderr, never into the --json stdout a script parses');

      // DRIFT: rewrite the project side so the two declared sources disagree.
      fs.writeFileSync(path.join(p.dir, 'gaps.json'), JSON.stringify({ schemaVersion: '1.0.0', gaps: [{ id: 'R-1', status: 'closed' }] }, null, 2));
      const d = cli(p.dir, 'reconcile');
      assert.equal(d.code, 1, 'a DRIFT reconciliation must still exit 1 through the alias, exactly as it always has');
      assert.equal(d.json.outcome, 'FAIL');
      assert.deepEqual(d.json.checks, [{ outcome: 'FAIL', check: 'reconcile', detail: '1 task record(s) and 1 project record(s) DISAGREE — STATUS_CONFLICT: R-1', checked: 2 }]);
      assert.match(d.stderr, /deprecated/i);
    } finally { rm(p.dir); }
  });

  /*
   * STATE 2 · THE SCOPED FORM. `savepoint --only compile,reconcile` reaches the SAME row through the
   * stage rather than the alias — `compile` is required (P4-K-08), so it is the minimal scope that
   * reproduces today's reconcile rows.
   */
  test('the scoped form `savepoint --only compile,reconcile` produces the same reconciliation row as the alias', () => {
    const p = bug3Fixture();
    try {
      const scoped = cli(p.dir, 'savepoint', '--verify', '--only', 'compile,reconcile');
      const row = scoped.json.checks.find((c) => c.check === 'reconcile');
      assert.deepEqual(row, AGREE_ROW, 'the scoped form\'s reconcile row must match the captured row field-for-field');

      const alias = cli(p.dir, 'reconcile');
      assert.deepEqual(alias.json.checks, [row], 'the alias and the scoped form must report the identical row, not merely an equal one');
    } finally { rm(p.dir); }
  });

  /*
   * STATE 3 · AN UNKNOWN `--only` VALUE REFUSES. Naming `reconcile` in an otherwise-invalid scope must
   * not carve out an exception: the refusal P4-K-08 built still owns this, unconditionally.
   */
  test('an unknown --only value refuses even when `reconcile` is named alongside it', () => {
    const p = bug3Fixture();
    try {
      const r = cli(p.dir, 'savepoint', '--verify', '--only', 'compile,reconcile,notastage');
      assert.equal(r.code, 2);
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      const row = r.json.checks.find((c) => c.check === 'savepoint:stages');
      assert.ok(row, 'the refusal must be a row, not only an exit code');
      assert.match(row.detail, /unknown savepoint stage `notastage`/);
      for (const s of STAGES) assert.match(row.detail, new RegExp(`\\b${s}\\b`), `the refusal must name \`${s}\` among the valid stages`);
      assert.equal(r.json.checks.length, 1, 'a refused scope must produce exactly the refusal row and no check of any stage');
    } finally { rm(p.dir); }
  });

  /*
   * THE FENCE · THE ALIAS AND THE SCOPED FORM SHARE ONE IMPLEMENTATION, DERIVED FROM SOURCE. The three
   * tests above would keep passing even if `cmdReconcile` called the runner a second time and happened
   * to agree today; the shape is asserted too, so a future edit that reintroduces the second call site
   * fails here even on a tree where the two still happen to compute the same answer.
   */
  test('fence · cmdReconcile no longer calls the reconciliation runner directly', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    const fn = /function cmdReconcile\(\)\s*\{[\s\S]*?\n\}/.exec(src);
    assert.ok(fn, 'cmdReconcile() is gone or was renamed — this fence pins nothing');
    assert.doesNotMatch(fn[0], /reconcileLib\.runReconciliation/,
      'cmdReconcile calls the reconciliation runner directly again — the alias and the savepoint stage can silently disagree once more');
    assert.match(fn[0], /stateLib\.compile\(DIR\)/,
      'cmdReconcile no longer derives its result from stateLib.compile(DIR), the field the savepoint stage reads');
  });
});

// --- the contract CLOSEOUT lifecycle ---------------------------------------------------------------
//
// ⛔ THE EXIT THE PACK NEVER BUILT. Contracts could be entered and suspended and never mechanically
// COMPLETED, so a finished delegation stayed in delegate mode across sessions, a goal whose criteria had
// all become MET stayed the project's ongoingGoalId, and nothing distinguished "still working" from
// "done and never closed". An autonomy mode that cannot end is the mirror of one that can be entered by
// inference: the pack guarded the entrance and left the exit open.

const goalFixture = (over = {}) => ({
  requirements: [{ id: 'R-1', mandatory: true, priority: 'P2' }],
  ...over,
});

/** Enter a goal whose criteria the compiler can actually evaluate, then make them true. */
function goalProject({ completion = 'all-mandatory-conformant', conformant = false } = {}) {
  const p = project(goalFixture());
  cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship the thing', '--completion', completion);
  if (conformant) {
    const rev = p.head();
    fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence(rev, ['R-1'])));
  }
  return p;
}

describe('closeout · a delegation closes on a restated definition of done, and not otherwise', () => {
  test('every recorded criterion must be attested; a missing one refuses and names it', () => {
    const p = project();
    try {
      cli(p.dir, 'contract', 'delegate', '--task', 'fix the parser', '--acceptance', 'tests pass;docs updated');
      const short = cli(p.dir, 'contract', 'complete', '--met', 'tests pass');
      assert.equal(short.json.outcome, 'FAIL', 'a delegation closed without its full definition of done');
      assert.match(short.json.error, /docs updated/, 'the refusal must name what was not attested');
      assert.equal(cli(p.dir, 'contract').json.contract.mode, 'delegate', 'a refused closure must change nothing');

      const full = cli(p.dir, 'contract', 'complete', '--met', 'Tests Pass', '--met', 'docs   updated', '--evidence', 'suite 12/12');
      assert.equal(full.json.outcome, 'PASS', `a correct attestation was refused: ${full.json.error}`);
      assert.equal(full.json.contract.mode, 'collaborate', 'delegate mode outlived the task');
    } finally { rm(p.dir); }
  });

  test('the closure is archived as an ATTESTATION, in the archive’s own words', () => {
    const p = project();
    try {
      cli(p.dir, 'contract', 'delegate', '--task', 'fix the parser', '--acceptance', 'tests pass');
      cli(p.dir, 'contract', 'complete', '--met', 'tests pass', '--evidence', 'suite 12/12', '--note', 'no regressions');
      const log = JSON.parse(fs.readFileSync(path.join(p.dir, '.respawnpack', 'runtime', 'delegations.json'), 'utf8'));
      const rec = log.completed[log.completed.length - 1];
      assert.equal(rec.task, 'fix the parser');
      assert.deepEqual(rec.acceptance, ['tests pass']);
      assert.equal(rec.evidence, 'suite 12/12');
      assert.match(rec.attestation, /claim, not a proof/,
        'the archive must not call an attestation a verification — that is the manufactured-evidence failure');
    } finally { rm(p.dir); }
  });

  test('the bounded task and its acceptance list are CLEARED, not left behind', () => {
    const p = project();
    try {
      cli(p.dir, 'contract', 'delegate', '--task', 'fix the parser', '--acceptance', 'tests pass');
      cli(p.dir, 'contract', 'complete', '--met', 'tests pass');
      const c = cli(p.dir, 'contract').json.contract;
      assert.equal(c.mode, 'collaborate');
      assert.ok(!c.task, 'the finished task is still recorded as the open one');
      assert.ok(!c.acceptance || !c.acceptance.length, 'the finished acceptance list survived the closure');
    } finally { rm(p.dir); }
  });

  test('a delegation stacked on a goal RESTORES that goal when it finishes', () => {
    const p = goalProject();
    try {
      cli(p.dir, 'contract', 'delegate', '--task', 'a detour', '--acceptance', 'detour done');
      assert.equal(cli(p.dir, 'contract').json.contract.suspendedGoalId, 'G-1', 'the delegation must suspend, never destroy');
      const done = cli(p.dir, 'contract', 'complete', '--met', 'detour done');
      assert.equal(done.json.contract.mode, 'goal', 'the suspended goal was not restored');
      assert.equal(done.json.contract.activeGoalId, 'G-1');
      assert.match(done.json.note, /resumed|G-1/);
    } finally { rm(p.dir); }
  });

  test('closing twice is idempotent — a retry after a crashed turn must not undo anything', () => {
    const p = goalProject();
    try {
      cli(p.dir, 'contract', 'delegate', '--task', 'a detour', '--acceptance', 'detour done');
      cli(p.dir, 'contract', 'complete', '--met', 'detour done');
      const again = cli(p.dir, 'contract', 'complete', '--met', 'detour done');
      assert.equal(again.json.outcome, 'PASS');
      assert.equal(again.json.alreadyClosed, true);
      assert.equal(cli(p.dir, 'contract').json.contract.activeGoalId, 'G-1',
        'the second closure clobbered the goal the first one restored');
    } finally { rm(p.dir); }
  });
});

describe('closeout · a goal closes only when every STATED criterion is mechanically MET', () => {
  test('UNMET refuses, names the criterion, and changes nothing', () => {
    const p = goalProject({ conformant: false });
    try {
      const r = cli(p.dir, 'contract', 'complete');
      assert.equal(r.json.outcome, 'FAIL');
      assert.equal(r.code, 1);
      assert.match(r.json.error, /UNMET/);
      assert.equal(stateLib.readGoalDoc(p.dir).ongoingGoalId, 'G-1', 'a refused closure archived the goal anyway');
      assert.equal(cli(p.dir, 'contract').json.contract.mode, 'goal', 'a refused closure ended autonomy anyway');
    } finally { rm(p.dir); }
  });

  test('CANNOT_DETERMINE refuses too — a criterion nobody can evaluate is not one that was met', () => {
    const p = goalProject({ completion: 'the owner is happy with the result' });
    try {
      const r = cli(p.dir, 'contract', 'complete');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.code, 2, 'refusing-because-unknowable must not share an exit code with refusing-because-unmet');
      assert.match(r.json.error, /CANNOT_DETERMINE/);
      assert.equal(stateLib.readGoalDoc(p.dir).ongoingGoalId, 'G-1');
    } finally { rm(p.dir); }
  });

  test('completion is NOT inferred from the requirement denominator alone', () => {
    /*
     * ⛔ THE RUN-B FAILURE, MECHANIZED. "Every mandatory row conformed" and "the goal the owner stated is
     * done" are different claims. A goal whose criteria are free text stays unclosable even when every
     * row in the project is conformant — which is the correct outcome, not a bug to route around.
     */
    const p = goalProject({ completion: 'ship it and feel good about it', conformant: true });
    try {
      const state = cli(p.dir, 'state').json.state;
      assert.equal(state.counts.conformant, state.counts.mandatory, 'sanity: every mandatory row must be conformant here');
      assert.equal(cli(p.dir, 'contract', 'complete').json.outcome, 'CANNOT_DETERMINE',
        'a full denominator closed a goal whose stated criteria were never evaluated');
    } finally { rm(p.dir); }
  });

  test('every criterion MET: archived with evidence, pointers cleared, autonomy ended', () => {
    const p = goalProject({ conformant: true });
    try {
      const r = cli(p.dir, 'contract', 'complete', '--evidence', 'qualified on CI run 42');
      assert.equal(r.json.outcome, 'PASS', `a met goal would not close: ${r.json.error}`);

      const doc = stateLib.readGoalDoc(p.dir);
      const g = doc.goals['G-1'];
      assert.ok(g.completedAt, 'no completedAt recorded');
      assert.equal(g.qualifiedRevision, p.head(), 'the closure must record WHICH revision qualified it');
      assert.equal(g.completionEvidence.evidence, 'qualified on CI run 42');
      assert.ok(g.completionEvidence.criteria.every((c) => c.status === 'MET'), 'per-criterion evidence is missing');
      assert.ok(!doc.ongoingGoalId, 'the project still points at a completed goal');
      assert.ok(doc.completedGoalIds.includes('G-1'));
      assert.ok(doc.goals['G-1'].goal, 'ARCHIVE, never delete — the contract itself must survive');

      const c = cli(p.dir, 'contract').json.contract;
      assert.equal(c.mode, 'collaborate', 'autonomy did not end');
      assert.ok(!c.activeGoalId && !c.suspendedGoalId, 'a runtime pointer survived the closure');
    } finally { rm(p.dir); }
  });

  test('a completed goal does not reappear as ongoing — not on compile, not on boot, not via --resume', () => {
    const p = goalProject({ conformant: true });
    try {
      cli(p.dir, 'contract', 'complete');
      const state = cli(p.dir, 'state').json.state;
      assert.equal(state.ongoingGoalId, null, 'the compiler resurrected a completed goal');
      assert.equal(state.goal, null);

      const resumed = cli(p.dir, 'contract', 'goal', '--resume');
      assert.equal(resumed.json.outcome, 'FAIL', '--resume re-entered autonomy on finished work');

      // A fresh session: runtime removed entirely, as a new machine or a fresh clone would see it.
      fs.rmSync(path.join(p.dir, '.respawnpack'), { recursive: true, force: true });
      const rt = createRequire(import.meta.url)('../hooks/_runtime.js');
      assert.equal(rt.readContract(p.dir).mode, 'collaborate', 'a fresh boot inherited autonomy from a closed goal');
      assert.equal(cli(p.dir, 'state').json.state.ongoingGoalId, null);
    } finally { rm(p.dir); }
  });

  test('closing a goal twice is idempotent, and a legacy-shaped goal document still closes', () => {
    const p = goalProject({ conformant: true });
    try {
      cli(p.dir, 'contract', 'complete');
      const again = cli(p.dir, 'contract', 'complete');
      assert.equal(again.json.outcome, 'PASS');
      assert.equal(again.json.alreadyClosed, true);
    } finally { rm(p.dir); }

    // Migration: the pre-2d spelling (`activeGoalId` on the goal document) must close the same way.
    const legacy = project(goalFixture());
    try {
      const rev = legacy.head();
      fs.writeFileSync(path.join(legacy.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence(rev, ['R-1'])));
      fs.writeFileSync(path.join(legacy.dir, stateLib.STATE_DIR, 'goal.json'), JSON.stringify({
        schemaVersion: '1.0.0', activeGoalId: 'G-old',
        goals: { 'G-old': { id: 'G-old', goal: 'legacy', completion: ['all-mandatory-conformant'] } },
      }, null, 2));
      const r = cli(legacy.dir, 'contract', 'complete');
      assert.equal(r.json.outcome, 'PASS', `a legacy-shaped goal could not be closed: ${r.json.error}`);
      const doc = stateLib.readGoalDoc(legacy.dir);
      assert.ok(!doc.ongoingGoalId && !doc.activeGoalId, 'the legacy pointer survived the closure');
    } finally { rm(legacy.dir); }
  });

  test('closing an ongoing goal while autonomy is SUSPENDED still works, and clears both pointers', () => {
    const p = goalProject({ conformant: true });
    try {
      cli(p.dir, 'contract', 'collaborate'); // suspend — the goal stays the project's ongoing one
      assert.equal(cli(p.dir, 'contract').json.contract.suspendedGoalId, 'G-1');
      const r = cli(p.dir, 'contract', 'complete');
      assert.equal(r.json.outcome, 'PASS', `a suspended-but-ongoing goal could not be closed: ${r.json.error}`);
      const c = cli(p.dir, 'contract').json.contract;
      assert.ok(!c.suspendedGoalId, 'suspendedGoalId still pointed at the goal that just completed — `--resume` would re-enter it');
    } finally { rm(p.dir); }
  });
});

/*
 * ⛔ THE EXIT READ ITS OWN INPUTS THROUGH `catch { return null }` WHILE WRITING THEM WITH writeAtomic.
 *
 * Reproduced against 55bdb96 before any of this existed. ONE injected ENOENT — a single atomic-rename
 * window, which is measured behaviour on Windows, not a hypothetical — on the first read of
 * contract.json while an OPEN delegation was being closed produced:
 *
 *     outcome PASS · alreadyClosed true · reported contract mode "collaborate"
 *     …and the runtime file still said "delegate". The delegation was still open.
 *
 * The caller is told autonomy ended; the next session resumes it. The delegation ARCHIVE had the same
 * shape one file over: a transient read failure became "no prior history", and the very next write
 * REPLACED the real archive with a single record.
 *
 * These fixtures inject deterministically at the syscall, because the race they describe cannot be
 * scheduled — and a fixture that waits for a real rename window is a fixture that passes by not
 * reproducing anything.
 */
describe('closeout · a rename window is not an answer about the contract', () => {
  const require_ = createRequire(import.meta.url);
  const cjsFs = require_('fs');
  const closeout = require_('./lib/closeout.js');

  /*
   * Inject at `fs.readFileSync` on the CommonJS module object — the same technique
   * kernel/concurrency.test.mjs uses for `renameSync`, and it works for the same reason: every reader
   * in the pack captures the MODULE, not the function.
   *
   * ⛔ SCOPED BY BASENAME, AND `times` IS EXACT. An unscoped patch would also fail the reads of
   * goal.json and requirements.json that these paths make, and the test would then pass for a reason
   * it never stated. `times: Infinity` is the PERSISTENT case; a finite count is the transient one.
   */
  function injectRead(basename, code, times, fn) {
    const real = cjsFs.readFileSync;
    let fired = 0;
    cjsFs.readFileSync = function readFileSync(p, ...rest) {
      if (typeof p === 'string' && path.basename(p) === basename && fired < times) {
        fired += 1;
        const e = new Error(`${code}: injected at ${p}`);
        e.code = code;
        throw e;
      }
      return real.call(this, p, ...rest);
    };
    try { return { value: fn(), fired: () => fired }; } finally { cjsFs.readFileSync = real; }
  }

  const RUNTIME = path.join('.respawnpack', 'runtime', 'contract.json');
  const ARCHIVE = path.join('.respawnpack', 'runtime', 'delegations.json');
  const bytes = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

  /** A project with an OPEN delegation, written the way the CLI writes it. */
  function delegated({ acceptance = ['tests pass'], suspendedGoalId = null } = {}) {
    const p = project(goalFixture());
    fs.mkdirSync(path.join(p.dir, '.respawnpack', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(p.dir, RUNTIME), JSON.stringify({
      mode: 'delegate', task: 'fix the parser', acceptance, activeGoalId: null, suspendedGoalId,
    }, null, 2));
    return p;
  }

  // --- 1 · a transient window is retried, and the REAL contract is recovered ------------------------

  test('an open delegate + ONE injected ENOENT still closes normally, archives, and lands in the right mode', () => {
    const p = delegated();
    try {
      const { value: r, fired } = injectRead('contract.json', 'ENOENT', 1,
        () => closeout.completeDelegation(p.dir, { met: ['tests pass'], evidence: 'suite 12/12' }));

      assert.equal(fired(), 1, 'the fixture injected nothing — it cannot have proven anything');
      assert.equal(r.outcome, 'PASS', `a recoverable rename window refused a legitimate closure: ${r.error}`);
      assert.notEqual(r.alreadyClosed, true, 'THE REPRODUCED FAILURE: an open delegation was reported already closed');
      assert.equal(r.contract.mode, 'collaborate');

      const after = JSON.parse(fs.readFileSync(path.join(p.dir, RUNTIME), 'utf8'));
      assert.equal(after.mode, 'collaborate',
        'the caller was told the contract closed while the file on disk still said delegate — the autonomy-exit failure itself');

      const log = JSON.parse(fs.readFileSync(path.join(p.dir, ARCHIVE), 'utf8'));
      assert.equal(log.completed.length, 1, 'the attestation was not archived');
      assert.equal(log.completed[0].evidence, 'suite 12/12');
    } finally { rm(p.dir); }
  });

  test('…and the mode it lands in is the RESTORED goal, not collaborate, when the delegation suspended one', () => {
    const p = goalProject();
    try {
      cli(p.dir, 'contract', 'delegate', '--task', 'a detour', '--acceptance', 'detour done');
      const { value: r, fired } = injectRead('contract.json', 'ENOENT', 1,
        () => closeout.completeDelegation(p.dir, { met: ['detour done'] }));

      assert.equal(fired(), 1);
      assert.equal(r.outcome, 'PASS', `${r.error}`);
      assert.equal(r.contract.mode, 'goal', 'a transient read cost the suspended goal its restoration');
      assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, RUNTIME), 'utf8')).activeGoalId, 'G-1');
    } finally { rm(p.dir); }
  });

  // --- 2 · persistent unavailability is a FAULT, and faults change nothing --------------------------

  test('persistently unavailable runtime state is CANNOT_DETERMINE, and no closeout file changes', () => {
    const p = delegated();
    try {
      const before = bytes(path.join(p.dir, RUNTIME));
      /*
       * EPERM, not ENOENT, and the difference IS the design: a file that stays missing is genuinely
       * ABSENT (test 6). EPERM/EACCES/EBUSY mean the file DEFINITELY EXISTS and is locked, so the
       * boundary waits and then fails closed rather than inventing an absence.
       */
      const { value: r } = injectRead('contract.json', 'EPERM', Infinity,
        () => closeout.completeDelegation(p.dir, { met: ['tests pass'] }));

      assert.equal(r.outcome, 'CANNOT_DETERMINE', 'an unreadable contract produced a verdict about the contract');
      assert.notEqual(r.outcome, 'PASS');
      assert.notEqual(r.alreadyClosed, true);
      assert.match(r.error, /UNREADABLE/);

      assert.equal(bytes(path.join(p.dir, RUNTIME)), before, 'a refused closure rewrote the contract anyway');
      assert.equal(bytes(path.join(p.dir, ARCHIVE)), null, 'a refused closure archived an attestation anyway');
    } finally { rm(p.dir); }
  });

  test('the same fault in completeGoal refuses too — it must not reach the already-closed branch', () => {
    const p = goalProject({ conformant: true });
    try {
      const { value: r } = injectRead('contract.json', 'EPERM', Infinity, () => closeout.completeGoal(p.dir, {}));
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(stateLib.readGoalDoc(p.dir).ongoingGoalId, 'G-1', 'a refused goal closure archived the goal anyway');
    } finally { rm(p.dir); }
  });

  // --- 3 · malformed is not collaborate ------------------------------------------------------------

  test('MALFORMED runtime state is CANNOT_DETERMINE — never collaborate, and never a closed contract', () => {
    const p = delegated();
    try {
      fs.writeFileSync(path.join(p.dir, RUNTIME), '{ "mode": "delegate", oops');
      const before = bytes(path.join(p.dir, RUNTIME));

      const r = closeout.completeDelegation(p.dir, { met: ['tests pass'] });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.match(r.error, /MALFORMED/);
      assert.notEqual(r.alreadyClosed, true);
      assert.equal(bytes(path.join(p.dir, RUNTIME)), before, 'a malformed contract was overwritten by the command that could not read it');

      /*
       * ⛔ AND INSPECTION MUST AGREE WITH CLOSURE. These were two different readers: `contract` used a
       * raw one and would print collaborate for a file it could not parse, while `contract complete`
       * acted on something else. One interpretation, or the report and the action describe two projects.
       */
      const look = cli(p.dir, 'contract');
      assert.equal(look.json.outcome, 'CANNOT_DETERMINE', 'inspection reported a verdict on an unreadable contract');
      assert.notEqual(look.json.contract && look.json.contract.mode, 'collaborate');
      assert.equal(cli(p.dir, 'contract', 'complete', '--met', 'tests pass').json.outcome, 'CANNOT_DETERMINE');
    } finally { rm(p.dir); }
  });

  // --- 4 · history survives a transient archive read -----------------------------------------------

  test('existing history + ONE injected transient archive failure keeps every prior record and appends exactly one', () => {
    const p = delegated({ acceptance: ['third task done'] });
    try {
      const prior = [
        { task: 'first', acceptance: ['a'], attestedAt: '2026-08-01T00:00:00.000Z' },
        { task: 'second', acceptance: ['b'], attestedAt: '2026-08-02T00:00:00.000Z' },
      ];
      fs.writeFileSync(path.join(p.dir, ARCHIVE), JSON.stringify({ schemaVersion: '1.0.0', completed: prior }, null, 2));

      const { value: r, fired } = injectRead('delegations.json', 'ENOENT', 1,
        () => closeout.completeDelegation(p.dir, { met: ['third task done'] }));

      assert.equal(fired(), 1, 'nothing was injected, so nothing about a transient archive read was tested');
      assert.equal(r.outcome, 'PASS', `${r.error}`);

      const log = JSON.parse(fs.readFileSync(path.join(p.dir, ARCHIVE), 'utf8'));
      assert.equal(log.completed.length, 3, 'a transient read of the archive TRUNCATED it — the destructive-replacement failure');
      assert.deepEqual(log.completed.slice(0, 2).map((c) => c.task), ['first', 'second'], 'prior attestations were lost');
      assert.equal(log.completed[2].task, 'fix the parser');
    } finally { rm(p.dir); }
  });

  // --- 5 · a persistently unreadable archive aborts, and truncates nothing --------------------------

  test('a persistently unavailable archive changes NEITHER the archive NOR the runtime contract', () => {
    const p = delegated();
    try {
      const prior = { schemaVersion: '1.0.0', completed: [{ task: 'first', acceptance: ['a'] }] };
      fs.writeFileSync(path.join(p.dir, ARCHIVE), JSON.stringify(prior, null, 2));
      const archiveBefore = bytes(path.join(p.dir, ARCHIVE));
      const runtimeBefore = bytes(path.join(p.dir, RUNTIME));

      const { value: r } = injectRead('delegations.json', 'EBUSY', Infinity,
        () => closeout.completeDelegation(p.dir, { met: ['tests pass'] }));

      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.match(r.error, /archive/i);
      assert.equal(bytes(path.join(p.dir, ARCHIVE)), archiveBefore, 'prior attestations were replaced by a closure that could not read them');
      assert.equal(bytes(path.join(p.dir, RUNTIME)), runtimeBefore,
        'the contract was closed while its attestation was never archived — a delegation closed with no record it ever happened');
    } finally { rm(p.dir); }
  });

  test('a MALFORMED archive aborts too, rather than answering corruption by deleting it', () => {
    const p = delegated();
    try {
      fs.writeFileSync(path.join(p.dir, ARCHIVE), JSON.stringify({ schemaVersion: '1.0.0', completed: 'not an array' }));
      const before = bytes(path.join(p.dir, ARCHIVE));
      const r = closeout.completeDelegation(p.dir, { met: ['tests pass'] });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(bytes(path.join(p.dir, ARCHIVE)), before,
        'a `completed` that was not an array read as empty history and was then overwritten — corruption answered by destruction');
    } finally { rm(p.dir); }
  });

  // --- 6 · a genuinely absent file still means collaborate -----------------------------------------

  test('a genuinely ABSENT runtime file still means collaborate — the retry must not invent a fault', () => {
    const p = project(goalFixture());
    try {
      assert.ok(!fs.existsSync(path.join(p.dir, RUNTIME)), 'fixture precondition: no contract file');

      const cls = closeout.readRuntimeClassified(p.dir);
      assert.equal(cls.status, 'ABSENT', 'the default experience became a fault — collaborate is the ABSENCE of a file');
      assert.deepEqual(cls.contract, {});

      const r = closeout.completeDelegation(p.dir, { met: ['whatever'] });
      assert.equal(r.outcome, 'PASS');
      assert.equal(r.alreadyClosed, true, 'closing nothing must stay the idempotent no-op it always was');
      assert.equal(r.contract.mode, 'collaborate');

      const look = cli(p.dir, 'contract');
      assert.equal(look.json.outcome, 'PASS');
      assert.equal(look.json.contract.mode, 'collaborate');
      assert.match(look.json.contract.source, /default/);
    } finally { rm(p.dir); }
  });

  test('the `readRuntime` convenience shape THROWS on a fault rather than answering `{}`', () => {
    /*
     * ⛔ `{}` IS INDISTINGUISHABLE FROM "NO CONTRACT FILE", which is precisely why the old reader could
     * report collaborate for a fault. This export survives for callers outside the pack, so the shape
     * that made the failure possible is fenced here: absent still yields `{}`, and a fault is loud.
     */
    const p = delegated();
    try {
      const { value } = injectRead('contract.json', 'EPERM', Infinity, () => {
        try { return { threw: false, got: closeout.readRuntime(p.dir) }; }
        catch (e) { return { threw: true, status: e.runtimeStatus, message: e.message }; }
      });
      assert.equal(value.threw, true, `an unreadable contract was answered with ${JSON.stringify(value.got)} — a fault dressed as a mode`);
      assert.equal(value.status, 'UNREADABLE');
    } finally { rm(p.dir); }

    const empty = project(goalFixture());
    try {
      assert.deepEqual(closeout.readRuntime(empty.dir), {}, 'a genuinely absent contract must still be the silent default');
    } finally { rm(empty.dir); }
  });

  // --- 7 · the fixtures above actually kill the reader they were written for ------------------------

  /*
   * ⛔ A FIXTURE THAT CANNOT FAIL PROVES NOTHING, AND THIS PROGRAM HAS CAUGHT THAT SHAPE REPEATEDLY. So
   * the raw reader is RESTORED — into a real copy of the tree, loaded as a real module — and the
   * scenario from test 1 is run against it. If the mutant closes cleanly, the fixtures above are
   * decorative and this fails instead.
   */
  test('restoring the raw `catch { return null }` reader reproduces the original failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-mutant-'));
    const p = delegated();
    try {
      fs.cpSync(path.join(KERNEL, 'lib'), path.join(root, 'kernel', 'lib'), { recursive: true });
      fs.cpSync(path.join(KERNEL, '..', 'hooks'), path.join(root, 'hooks'), { recursive: true });

      const mutantPath = path.join(root, 'kernel', 'lib', 'closeout.js');
      const src = fs.readFileSync(mutantPath, 'utf8');
      assert.match(src, /readRuntimeClassified/, 'the classified reader is gone; this mutation is about nothing');

      // The exact pre-fix spellings: a raw null-collapsing reader, and `{}` for anything it cannot read.
      const mutated = src
        .replace(
          /function readRuntimeClassified\(dir\) \{[\s\S]*?\n\}/,
          'function readRuntimeClassified(dir) {\n'
          + "  try { return { status: 'OK', contract: JSON.parse(require('fs').readFileSync(path.join(dir, RUNTIME_REL), 'utf8')), detail: null }; }\n"
          + "  catch { return { status: 'ABSENT', contract: {}, detail: null }; }\n}",
        )
        .replace(
          /function readDelegationArchive\(dir\) \{[\s\S]*?\n\}/,
          'function readDelegationArchive(dir) {\n'
          + "  let log = null; try { log = JSON.parse(require('fs').readFileSync(path.join(dir, DELEGATION_LOG_REL), 'utf8')); } catch { log = null; }\n"
          + "  return { status: 'OK', history: Array.isArray(log && log.completed) ? log.completed : [], detail: null };\n}",
        );
      assert.notEqual(mutated, src, 'the mutation did not apply — the kill-check would pass vacuously');
      fs.writeFileSync(mutantPath, mutated);

      const mutant = createRequire(path.join(root, 'kernel', 'lib', 'x.js'))('./closeout.js');
      const { value: r, fired } = injectRead('contract.json', 'ENOENT', 1,
        () => mutant.completeDelegation(p.dir, { met: ['tests pass'] }));

      assert.equal(fired(), 1);
      assert.equal(r.outcome, 'PASS', 'the mutant did not even reach the failure — the mutation is wrong, not the fixture');
      assert.equal(r.alreadyClosed, true,
        'restoring the raw reader NO LONGER reproduces the reported failure, so the fixtures above are not what is holding it closed');
      assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, RUNTIME), 'utf8')).mode, 'delegate',
        'the mutant left runtime correct, which means test 1 would pass against the broken reader too');
    } finally { rm(p.dir); rm(root); }
  });
});

describe('closeout · the prose-first baseline instructs the exit, not just the entrance', () => {
  test('the shipped behavioral baseline tells the agent to CLOSE a finished contract and announce it', () => {
    const claude = fs.readFileSync(path.join(KERNEL, '..', 'templates', 'CLAUDE.md'), 'utf8');
    const standards = fs.readFileSync(path.join(KERNEL, '..', 'spine', 'reference', 'behavior-standards.md'), 'utf8');
    for (const [name, text] of [['templates/CLAUDE.md', claude], ['behavior-standards.md', standards]]) {
      const flat = text.replace(/\s+/g, ' ').toLowerCase();
      assert.match(flat, /contract complete/, `${name} never mentions the closeout transition`);
      assert.match(flat, /refus|cannot be closed|will not close/,
        `${name} must say that a goal whose criteria are unmet or unknowable REFUSES to close`);
    }
  });
});

// --- living skills · the canary lifecycle (OD-1) ---------------------------------------------------
//
// OVERCLAIMS #1 and #2: README advertised "living skills that learn from a persistent memory engine"
// and living-skills.md said EVERY owned skill had two forms. The tree said 9 of 20 shipped a
// SKILL.base.md, ZERO .skill-meta.json existed anywhere, and nothing generated an overlay, detected
// drift or reset one. The owner refused both halves of the obvious binary — do not manufacture twenty
// baselines, do not drop the idea — so the lifecycle is proven on three canaries and every claim is
// narrowed to exactly those.

const livingLib = createRequire(import.meta.url)('./lib/living.js');

/** A project with the three canaries on disk and a memory entity keyed to one of them. */
function livingProject({ lessons = [], skills = livingLib.CANARIES } = {}) {
  const p = project();
  for (const name of skills) {
    const d = path.join(p.dir, '.claude', 'skills', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), `# /${name}\n\nThe authored skill body.\n`);
  }
  for (const l of lessons) {
    const f = path.join(p.dir, 'memory', 'graph', 'gotcha', `${l.id.replace(/[^a-z0-9-]/gi, '-')}.md`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, [
      '---',
      `id: ${l.id}`,
      `confidence: ${l.confidence}`,
      `observed_at: ${l.observedAt}`,
      `relations: [${(l.relations || []).join(', ')}]`,
      ...(l.negative ? ['negative: true'] : []),
      '---',
      '',
      `## Symptom`,
      l.text,
      '',
    ].join('\n'));
  }
  return p;
}

const LESSON = (over = {}) => ({
  id: 'gotcha:tls-mismatch', confidence: 0.9, observedAt: '2026-05-01T00:00:00Z',
  relations: ['applies-to|skill:debug'], text: 'the redis scheme changed in v3', ...over,
});

describe('living skills · the claim is exactly three canaries, and it is opt-in', () => {
  test('a default project has NO living skill, and says so as a supported state', () => {
    const p = livingProject();
    try {
      const r = cli(p.dir, 'living', 'status');
      assert.equal(r.json.outcome, 'NOT_APPLICABLE', 'a default install silently activated a living rewrite');
      assert.deepEqual(r.json.canaries, ['debug', 'savepoint', 'knowledge']);
      for (const c of r.json.checks) {
        assert.match(c.detail, /STATIC skill/, 'a skill without living machinery must read as complete, not missing');
      }
      for (const name of livingLib.CANARIES) {
        assert.ok(!fs.existsSync(path.join(p.dir, '.claude', 'skills', name, '.skill-meta.json')));
        assert.ok(!fs.existsSync(path.join(p.dir, '.claude', 'skills', name, 'SKILL.base.md')));
      }
    } finally { rm(p.dir); }
  });

  test('a non-canary and a vendor skill are refused, by name, with the reason', () => {
    const p = livingProject({ skills: [...livingLib.CANARIES, 'build'] });
    try {
      const r = cli(p.dir, 'living', 'enable', 'build');
      assert.equal(r.json.outcome, 'FAIL');
      assert.match(r.json.checks[0].detail, /not one of the living-skill canaries/);
      assert.ok(!fs.existsSync(path.join(p.dir, '.claude', 'skills', 'build', 'SKILL.base.md')),
        'a refused enable must not leave a baseline behind');
    } finally { rm(p.dir); }
  });

  test('enable FREEZES what is on disk — it does not author a baseline', () => {
    const p = livingProject();
    try {
      const body = fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.md'), 'utf8');
      assert.equal(cli(p.dir, 'living', 'enable', 'debug').json.outcome, 'PASS');
      const base = fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.base.md'), 'utf8');
      assert.equal(base.replace(/\s*$/, ''), body.replace(/\s*$/, ''),
        'the baseline must BE the authored skill, captured — not something new');
      const meta = JSON.parse(fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', '.skill-meta.json'), 'utf8'));
      for (const f of ['schemaVersion', 'baseHash', 'overlayBudgetLines', 'enabledAt']) assert.ok(meta[f] != null, `meta is missing ${f}`);
      assert.equal(cli(p.dir, 'living', 'status', 'debug').json.checks[0].outcome, 'PASS');
    } finally { rm(p.dir); }
  });

  test('enable never overwrites an existing baseline with an already-living form', () => {
    const p = livingProject();
    try {
      const d = path.join(p.dir, '.claude', 'skills', 'debug');
      fs.writeFileSync(path.join(d, 'SKILL.base.md'), '# /debug\n\nTHE REAL BASE.\n');
      fs.writeFileSync(path.join(d, 'SKILL.md'), '# /debug\n\nTHE REAL BASE.\n\n## Learned (living)\n- drifted\n');
      cli(p.dir, 'living', 'enable', 'debug');
      assert.match(fs.readFileSync(path.join(d, 'SKILL.base.md'), 'utf8'), /THE REAL BASE/);
      assert.ok(!/drifted/.test(fs.readFileSync(path.join(d, 'SKILL.base.md'), 'utf8')),
        'the fallback became a copy of the thing it is a fallback FROM');
    } finally { rm(p.dir); }
  });
});

describe('living skills · the overlay is derived, traceable and budgeted', () => {
  test('every learned line carries date, confidence and source; an unkeyed lesson never appears', () => {
    const p = livingProject({
      lessons: [
        LESSON(),
        LESSON({ id: 'gotcha:unrelated', relations: ['applies-to|skill:savepoint'], text: 'not for debug' }),
        LESSON({ id: 'gotcha:unkeyed', relations: [], text: 'keyed to nothing' }),
      ],
    });
    try {
      cli(p.dir, 'living', 'enable', 'debug');
      assert.equal(cli(p.dir, 'living', 'regenerate', 'debug', '--write').json.outcome, 'PASS');
      const live = fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.md'), 'utf8');
      assert.match(live, /## Learned \(living\)/);
      assert.match(live, /\[2026-05-01 · conf:0\.90 · memory\/graph\/gotcha\/[^\]]+\] the redis scheme changed in v3/,
        'a learned line must carry its date, confidence AND source path');
      assert.ok(!/not for debug/.test(live), "another skill's lesson leaked onto this overlay");
      assert.ok(!/keyed to nothing/.test(live), 'an unkeyed entity appeared on an overlay it is not traceable to');
      assert.match(live, /The authored skill body/, 'the base must survive verbatim underneath');
    } finally { rm(p.dir); }
  });

  test('regeneration is DETERMINISTIC and the budget reports what it dropped', () => {
    const many = Array.from({ length: 15 }, (_, i) => LESSON({
      id: `gotcha:l${String(i).padStart(2, '0')}`, confidence: 0.5, observedAt: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      text: `lesson number ${i}`,
    }));
    const p = livingProject({ lessons: many });
    try {
      cli(p.dir, 'living', 'enable', 'debug');
      const first = cli(p.dir, 'living', 'regenerate', 'debug', '--write');
      const a = fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.md'), 'utf8');
      cli(p.dir, 'living', 'regenerate', 'debug', '--write');
      const b = fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.md'), 'utf8');
      assert.equal(a, b, 'two regenerations over the same memory produced different bytes');
      assert.match(first.json.checks[0].detail, /over budget and NOT included/,
        'a silent cap reads as "this is everything we know"');
      assert.equal((a.match(/^- \[/gm) || []).length, livingLib.DEFAULT_BUDGET_LINES);
    } finally { rm(p.dir); }
  });

  test('zero keyed entities after filtering is CANNOT_DETERMINE and writes no empty overlay', () => {
    const cases = [
      ['only the installed .gitkeep', []],
      ['only an unrelated entity', [LESSON({ id: 'gotcha:unrelated', relations: ['applies-to|skill:savepoint'] })]],
      ['only an unkeyed entity', [LESSON({ id: 'gotcha:unkeyed', relations: [] })]],
    ];
    for (const [label, lessons] of cases) {
      const p = livingProject({ lessons });
      try {
        if (!lessons.length) {
          const root = path.join(p.dir, 'memory', 'graph');
          fs.mkdirSync(root, { recursive: true });
          fs.writeFileSync(path.join(root, '.gitkeep'), '');
        }
        cli(p.dir, 'living', 'enable', 'debug');
        const skill = path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.md');
        const before = fs.readFileSync(skill, 'utf8');
        const r = cli(p.dir, 'living', 'regenerate', 'debug', '--write');
        assert.equal(r.json.outcome, 'CANNOT_DETERMINE', `${label} produced ${r.json.outcome}`);
        assert.equal(r.code, 2, `${label} escaped as a CLI-wide FAIL instead of the four-outcome verdict`);
        assert.match(r.json.checks[0].detail, /zero checked subjects cannot pass/);
        assert.equal(fs.readFileSync(skill, 'utf8'), before, `${label} wrote a manufactured empty overlay`);
      } finally { rm(p.dir); }
    }
  });

  test('an unreadable memory source is CANNOT_DETERMINE, never an empty overlay', () => {
    const p = livingProject({ lessons: [LESSON()] });
    try {
      cli(p.dir, 'living', 'enable', 'debug');
      cli(p.dir, 'living', 'regenerate', 'debug', '--write');
      fs.rmSync(path.join(p.dir, 'memory'), { recursive: true, force: true });
      const r = cli(p.dir, 'living', 'regenerate', 'debug', '--write');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.match(r.json.checks[0].detail, /NOT regenerated/);
      assert.match(fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.md'), 'utf8'), /redis scheme/,
        'the previous overlay was replaced with an empty one on an unreadable source');
    } finally { rm(p.dir); }
  });

  test('regenerate without --write changes nothing', () => {
    const p = livingProject({ lessons: [LESSON()] });
    try {
      cli(p.dir, 'living', 'enable', 'debug');
      const before = fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.md'), 'utf8');
      assert.equal(cli(p.dir, 'living', 'regenerate', 'debug').json.outcome, 'PASS');
      assert.equal(fs.readFileSync(path.join(p.dir, '.claude', 'skills', 'debug', 'SKILL.md'), 'utf8'), before);
    } finally { rm(p.dir); }
  });
});

describe('living skills · drift is detected, and reset restores the real base', () => {
  test('a hand-edited living form, a changed base, a missing base and broken metadata are all caught', () => {
    const d = (p) => path.join(p.dir, '.claude', 'skills', 'debug');

    const edited = livingProject({ lessons: [LESSON()] });
    try {
      cli(edited.dir, 'living', 'enable', 'debug');
      cli(edited.dir, 'living', 'regenerate', 'debug', '--write');
      fs.writeFileSync(path.join(d(edited), 'SKILL.md'), '# /debug\n\nSOMEONE REWROTE THE BODY.\n');
      const r = cli(edited.dir, 'living', 'status', 'debug');
      assert.equal(r.json.checks[0].outcome, 'FAIL');
      assert.match(r.json.checks[0].detail, /hand-edited outside the overlay/);
    } finally { rm(edited.dir); }

    const movedBase = livingProject();
    try {
      cli(movedBase.dir, 'living', 'enable', 'debug');
      fs.appendFileSync(path.join(d(movedBase), 'SKILL.base.md'), '\nan un-recorded intent change\n');
      assert.match(cli(movedBase.dir, 'living', 'status', 'debug').json.checks[0].detail, /WRITE-ONCE canonical/);
    } finally { rm(movedBase.dir); }

    const noBase = livingProject();
    try {
      cli(noBase.dir, 'living', 'enable', 'debug');
      fs.rmSync(path.join(d(noBase), 'SKILL.base.md'));
      assert.match(cli(noBase.dir, 'living', 'status', 'debug').json.checks[0].detail, /guaranteed-good floor is gone/);
    } finally { rm(noBase.dir); }

    const badMeta = livingProject();
    try {
      cli(badMeta.dir, 'living', 'enable', 'debug');
      fs.writeFileSync(path.join(d(badMeta), '.skill-meta.json'), '{ not json');
      assert.equal(cli(badMeta.dir, 'living', 'status', 'debug').json.checks[0].outcome, 'CANNOT_DETERMINE');
      fs.writeFileSync(path.join(d(badMeta), '.skill-meta.json'), JSON.stringify({ schemaVersion: '1.0.0' }));
      assert.match(cli(badMeta.dir, 'living', 'status', 'debug').json.checks[0].detail, /missing "baseHash"/);
    } finally { rm(badMeta.dir); }
  });

  test('reset restores the base, archives the overlay, and leaves the source memory intact', () => {
    const p = livingProject({ lessons: [LESSON()] });
    try {
      const d = path.join(p.dir, '.claude', 'skills', 'debug');
      cli(p.dir, 'living', 'enable', 'debug');
      cli(p.dir, 'living', 'regenerate', 'debug', '--write');
      assert.match(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'), /redis scheme/);

      const r = cli(p.dir, 'living', 'reset', 'debug');
      assert.equal(r.json.outcome, 'PASS');
      const after = fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8');
      assert.equal(after.replace(/\s*$/, ''), fs.readFileSync(path.join(d, 'SKILL.base.md'), 'utf8').replace(/\s*$/, ''));
      assert.ok(!/Learned \(living\)/.test(after), 'the overlay survived a reset');
      assert.ok(fs.readdirSync(d).some((f) => /^SKILL\.overlay\./.test(f)), 'the overlay was destroyed rather than archived');

      // The source memory is untouched, so the next regeneration re-proposes it.
      assert.ok(fs.existsSync(path.join(p.dir, 'memory', 'graph', 'gotcha', 'gotcha-tls-mismatch.md')),
        'reset destroyed the source memory it exists to preserve');
      cli(p.dir, 'living', 'regenerate', 'debug', '--write');
      assert.match(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'), /redis scheme/,
        'after a reset, regeneration must be able to re-propose the same lesson');
      assert.equal(cli(p.dir, 'living', 'status', 'debug').json.checks[0].outcome, 'PASS');
    } finally { rm(p.dir); }
  });

  test('doctor reports which skills are living HERE, and the count is the narrowed claim', () => {
    const p = livingProject({ lessons: [LESSON()] });
    try {
      const rowOf = () => cli(p.dir, 'doctor').json.rows.find((r) => r.check === 'skills:living');
      assert.equal(rowOf().label, 'NOT_CONFIGURED');
      assert.match(rowOf().detail, /STATIC here/);
      cli(p.dir, 'living', 'enable', 'debug');
      cli(p.dir, 'living', 'regenerate', 'debug', '--write');
      assert.equal(rowOf().label, 'ACTIVE');
      assert.match(rowOf().detail, /1 of 3 canaries living \(debug\)/);
    } finally { rm(p.dir); }
  });
});

// ----------------------------------------------------------------------------------------------
/*
 * Unit 7 · the final truth audit's P0s, as fixtures.
 *
 * Every one of these was found by READING the shipped claim and then running it, not by a failing
 * test — because in each case no test existed. That is the pattern worth naming: the three defects
 * below each sat under a green suite, and each would have kept sitting there, because the suites
 * asserted that the mechanism worked and never that the CLAIM about it was true.
 *
 *   · `upgrade` unlinked an enabled skill's SKILL.md, the installer re-laid the pack copy, and
 *     `living status` then said PASS · overlay 0/12 line(s). Every check it ran was true. The lines
 *     a founder's memory graph produced were gone and nothing anywhere said so.
 *   · `doctor` — the command README.md points at for per-install truth — iterated a HARDCODED pair
 *     of shared modules, so deleting `_shell.js` left it printing ACTIVE for an index-guard that
 *     dies on MODULE_NOT_FOUND at its first invocation.
 *   · `status` read STATE.json raw and returned PASS unconditionally, and `doctor` compared
 *     revisions only. In one tree the SessionStart hook said STALE — WITHHELD while both of these
 *     printed the counts as fact. Phase 2d's content-bound freshness had exactly one consumer.
 */
describe('Unit 7 · the truth audit\'s P0s', () => {
  test('doctor derives its shared-module set from disk — deleting ANY required lib is BROKEN, not ACTIVE', () => {
    const { dir } = project();
    const hooks = path.join(dir, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    /*
     * A hook requiring a lib that itself requires a second lib: the walk must be transitive, since a
     * module reached only through another module is just as fatal at load time.
     *
     * ⛔ THE STUB NAMES ARE DELIBERATELY UNREGISTERED. They used to borrow `_shell.js`, and once the
     * shared modules gained declared contracts this two-line stub was correctly reported
     * INVALID_CONTRACT — a real fence firing on a fake module, which would have made this fixture fail
     * for a reason it is not about. Unregistered names get loadability-only, which is exactly the claim
     * under test here: that the SET is derived from disk, transitively. Contract-checking of the real
     * shared modules is proven on an installed target in install/install.test.mjs.
     */
    fs.writeFileSync(path.join(hooks, 'index-guard.js'), "const a = require('./_fixture-lib.js');\n");
    fs.writeFileSync(path.join(hooks, '_fixture-lib.js'), "const b = require('./_deep.js');\n");
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/index-guard.js' }] }] },
    }, null, 2));

    const withAll = () => {
      fs.writeFileSync(path.join(hooks, '_deep.js'), 'module.exports = {};\n');
      return cli(dir, 'doctor');
    };
    const good = withAll();
    const goodRows = (good.json.rows || []).filter((r) => r.check.startsWith('hook-lib:'));
    assert.ok(goodRows.some((r) => r.check === 'hook-lib:_fixture-lib.js'), 'the directly-required lib must be reported at all');
    assert.ok(goodRows.some((r) => r.check === 'hook-lib:_deep.js'), 'a TRANSITIVELY required lib must be reported too');
    assert.ok(goodRows.every((r) => r.detail.includes('present')), 'with every lib on disk nothing is broken');

    fs.unlinkSync(path.join(hooks, '_fixture-lib.js'));
    const bad = cli(dir, 'doctor');
    const row = (bad.json.rows || []).find((r) => r.check === 'hook-lib:_fixture-lib.js');
    assert.ok(row, 'the missing lib must still be reported — silence is the defect');
    assert.match(row.detail, /MISSING/, 'a lib an installed hook requires and cannot load is MISSING, not present');
    // ⭐ The discriminating half. Before this fix the two runs were INDISTINGUISHABLE: identical rows,
    // identical overall verdict, because '_shell.js' was not in the hardcoded list at all.
    assert.notDeepEqual(
      (bad.json.rows || []).map((r) => `${r.check}=${r.detail}`),
      (good.json.rows || []).map((r) => `${r.check}=${r.detail}`),
      'doctor must answer differently when a required module is gone',
    );
    rm(dir);
  });

  test('status WITHHOLDS counts when a compiler input changed without a commit — not PASS with fresh-looking numbers', () => {
    const { dir, head } = project({
      requirements: [{ id: 'R-1', title: 'one', mandatory: true }],
      evidence: [{ file: 'e.json', body: null }],
    });
    // Compile and persist STATE.json at a clean tree, then edit an input WITHOUT committing.
    const compiled = cli(dir, 'state');
    assert.equal(compiled.code, 0, 'the fixture must compile before the staleness half means anything');
    const fresh = cli(dir, 'status');
    assert.equal(fresh.code, 0, 'a state built from the current inputs is current');

    const reqs = path.join(dir, stateLib.STATE_DIR, 'requirements.json');
    const doc = JSON.parse(fs.readFileSync(reqs, 'utf8'));
    doc.requirements.push({ id: 'R-2', title: 'added after the build', mandatory: true });
    fs.writeFileSync(reqs, JSON.stringify(doc, null, 2));
    assert.equal(head(), head(), 'the revision has NOT moved — that is the whole point of this fixture');

    const stale = cli(dir, 'status');
    assert.equal(stale.code, 2, 'an uncommitted change to a compiler input makes the counts undeterminable, not wrong-but-green');
    assert.match(stale.stdout, /WITHHELD/, 'withheld rather than caveated — a number printed beside a warning is still quoted');
    assert.doesNotMatch(stale.stdout, /rows +: \d+\/\d+/, 'no count may appear at all while the state is stale');

    const doc2 = cli(dir, 'doctor');
    const row = (doc2.json.rows || []).find((r) => r.check === 'state:STATE.json');
    assert.match(row.label + row.detail, /STALE|changed/i, 'doctor must see the same staleness the hook and status see');
    rm(dir);
  });
});

/*
 * ⛔ THE CLASSIFIER BEHIND "PRESENT IS NOT LOADED" (kernel/lib/modhealth.js).
 *
 * The end-to-end proof is in `install/install.test.mjs`, on a real installed target, because that is
 * where the claim lives. This block pins the five states themselves — including two the installed
 * matrix cannot reach cleanly:
 *
 *   · a module that EXISTS but whose own `require` is missing. A classifier that read `MODULE_NOT_FOUND`
 *     off the error would call that ABSENT and send the reader looking for a file sitting right there.
 *   · `module` being null for INVALID_CONTRACT. That single property is what turned the reported crash
 *     (a truthy module missing `compareManifest`, TypeError at respawnpack.js:310, zero rows printed)
 *     into the CANNOT_DETERMINE branch every caller already had.
 */
describe('Unit 7 corrections · module health separates five states, never four', () => {
  const modhealth = createRequire(import.meta.url)('./lib/modhealth.js');
  const CONTRACT = ['sourceManifest', 'compareManifest', 'digestMap', 'compareDigestMap'];

  // A fresh directory and a unique basename per case: Node caches a successful require, so reusing a
  // path would let one case answer for the next.
  let seq = 0;
  const write = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-modhealth-'));
    const abs = path.join(dir, `m${seq += 1}.js`);
    if (body !== null) fs.writeFileSync(abs, body);
    return abs;
  };
  const full = 'module.exports = { sourceManifest(){}, compareManifest(){}, digestMap(){}, compareDigestMap(){} };\n';

  test('a healthy module is OK and hands back the loaded module', () => {
    const h = modhealth.probe(write(full), CONTRACT);
    assert.equal(h.status, modhealth.OK);
    assert.equal(typeof h.module.compareManifest, 'function', 'OK must be the only status that yields a usable module');
    assert.match(h.detail, /present/);
  });

  test('an absent module is ABSENT, and says MISSING', () => {
    const h = modhealth.probe(write(null), CONTRACT);
    assert.equal(h.status, modhealth.ABSENT);
    assert.match(h.detail, /MISSING/);
    assert.equal(h.module, null);
  });

  test('a present but unparseable module is INVALID_SYNTAX — not absent, not fine', () => {
    const h = modhealth.probe(write('this is not valid javascript (((\n'), CONTRACT);
    assert.equal(h.status, modhealth.INVALID_SYNTAX);
    assert.match(h.detail, /INVALID JAVASCRIPT/);
    assert.equal(h.module, null);
  });

  test('a module that throws at load is LOAD_ERROR, and the message survives', () => {
    const h = modhealth.probe(write("throw new Error('boom at module scope');\n"), CONTRACT);
    assert.equal(h.status, modhealth.LOAD_ERROR);
    assert.match(h.detail, /THREW WHILE LOADING/);
    assert.match(h.detail, /boom at module scope/, 'a diagnostic that drops the reason is a status, not a diagnosis');
  });

  /*
   * ⛔ PARSING AND EVALUATING ARE DIFFERENT QUESTIONS, AND `instanceof SyntaxError` ANSWERS NEITHER.
   * The classifier caught the require and read the ERROR TYPE: any SyntaxError meant "the parser
   * rejected it". Two ordinary things are then reported as a lie about the file's own source — a
   * perfectly parseable module that CHOOSES to throw a SyntaxError at runtime, and a module that parses
   * fine but requires something that does not. The fix is to stop inferring: compile the source to
   * settle parsing, and only then evaluate to settle loading.
   */
  test('a parseable module that THROWS a SyntaxError is LOAD_ERROR — the parser accepted it', () => {
    const h = modhealth.probe(write("throw new SyntaxError('runtime failure');\n"), CONTRACT);
    assert.equal(h.status, modhealth.LOAD_ERROR,
      'the error TYPE is not evidence about the source: this file parses, so its parser did not reject it');
    assert.doesNotMatch(h.detail, /the parser rejected it/, 'the diagnostic asserted something demonstrably untrue about the file');
    assert.match(h.detail, /runtime failure/);
  });

  test("a syntax error in a DEPENDENCY does not prove the root module failed to parse", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-modhealth-dep-'));
    fs.writeFileSync(path.join(dir, 'dep.js'), 'this is not valid javascript (((\n');
    const root = path.join(dir, 'root.js');
    fs.writeFileSync(root, "require('./dep.js');\nmodule.exports = {};\n");
    const h = modhealth.probe(root, []);
    assert.equal(h.status, modhealth.LOAD_ERROR,
      'root.js parses perfectly; blaming its own syntax sends the reader to edit the wrong file');
    assert.match(h.detail, /dep\.js/, 'and the diagnostic must name the file that actually failed');
  });

  test('a shebang does not make a module unparseable — the parse step must strip what Node strips', () => {
    const h = modhealth.probe(write("#!/usr/bin/env node\nmodule.exports = { sourceManifest(){}, compareManifest(){}, digestMap(){}, compareDigestMap(){} };\n"), CONTRACT);
    assert.equal(h.status, modhealth.OK, 'every shipped hook starts with a shebang; rejecting one would fail 7 of them at once');
  });

  test("a module whose OWN require is missing is LOAD_ERROR, never ABSENT — the file is right there", () => {
    const h = modhealth.probe(write("require('./nope-does-not-exist.js');\n"), CONTRACT);
    assert.equal(h.status, modhealth.LOAD_ERROR,
      'classifying on MODULE_NOT_FOUND alone reports a file that exists as missing');
    assert.match(h.detail, /THREW WHILE LOADING/);
  });

  test('a module that loads but has lost an export is INVALID_CONTRACT, and yields NO module', () => {
    const h = modhealth.probe(write('module.exports = { sourceManifest(){}, digestMap(){}, compareDigestMap(){} };\n'), CONTRACT);
    assert.equal(h.status, modhealth.INVALID_CONTRACT);
    assert.match(h.detail, /compareManifest/, 'the row must name the export that is gone');
    assert.equal(h.module, null,
      'this is the whole correction: a half-usable module is what killed doctor with a TypeError at first call');
  });

  test('an export present but not callable is INVALID_CONTRACT too', () => {
    const h = modhealth.probe(write('module.exports = { sourceManifest(){}, compareManifest: 42, digestMap(){}, compareDigestMap(){} };\n'), CONTRACT);
    assert.equal(h.status, modhealth.INVALID_CONTRACT);
    assert.equal(h.module, null);
  });

  test('a module with no declared contract is probed for loadability only — a smaller claim, honestly made', () => {
    const abs = write('module.exports = {};\n');
    assert.equal(modhealth.contractFor(abs), null, 'a file this pack does not ship declares no contract');
    const h = modhealth.probePath(abs);
    assert.equal(h.status, modhealth.OK);
    assert.doesNotMatch(h.detail, /contract/, 'it must not claim to have checked a contract it does not have');
  });

  test('a Set declared as a Set is satisfied; a plain object in its place is INVALID_CONTRACT', () => {
    /*
     * `_artifact.REJECTED` is a Set, and `typeof new Set()` is 'object'. Declared as `object` it would
     * accept a `{}` with no `.has`, which is a wrong-typed export reported ACTIVE — the exact class this
     * round exists to close, arriving through the type system instead of through a missing name.
     */
    assert.equal(modhealth.satisfies(new Set(), 'set'), true);
    assert.equal(modhealth.satisfies({}, 'set'), false, 'a plain object passed as a Set');
    assert.equal(modhealth.satisfies(new Set(), 'object'), false, 'a Set must not satisfy a plain-object contract either');
    assert.equal(modhealth.typeOf(new Set()), 'set', 'the diagnostic must name what it actually found');
  });

  /*
   * ⛔ THE REGISTRY IS ONLY AUTHORITATIVE IF IT CANNOT DRIFT FROM THE CALL SITES — AND THE CALL SITES
   * ARE NOT ONLY `respawnpack.js`.
   *
   * The previous fence compared the registry against property accesses in the CLI alone. That scope was
   * the hole: kernel modules call each other, so `closeout.js` reading `stateLib.readGoalDocClassified`
   * and `stateLib.SCHEMA_VERSION`, and `removals.js` reading `assert.foldCase` and `assert.liveDocument`,
   * were all undeclared while the fence reported no drift. Reproduced on a real installed target at
   * 6869874: state.js minus `readGoalDocClassified` gave doctor PASS at exit 0 while `contract complete`
   * died on a raw TypeError.
   *
   * So the sweep is now every production module in BOTH trees, against BOTH registries, in both
   * directions — and handles are derived from the actual binding forms (require, lazyLib, and the
   * `modhealth.probePath(...).module` shape the cross-tree boundary uses) rather than listed here.
   */
  describe('registry ↔ call sites · bidirectional, whole-tree', () => {
    const ROOT_DIR = path.dirname(KERNEL);
    const require_ = createRequire(import.meta.url);
    const PROD = (() => {
      const out = [];
      for (const d of ['kernel', 'kernel/lib', 'hooks']) {
        for (const f of fs.readdirSync(path.join(ROOT_DIR, d), { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith('.js')) out.push(path.posix.join(d, f.name));
        }
      }
      return out;
    })();

    /*
     * ⛔ COMMENTS ARE STRIPPED BEFORE ANYTHING IS DERIVED. Last round a comment I had written naming
     * `closeout.readRuntime` satisfied this fence as though it were a call site — a contract met by
     * prose. Documentation cannot keep a contract entry alive, and cannot create one either.
     */
    const codeOf = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /** Every local identifier in `rel` bound to the module `target`, by any binding form the pack uses. */
    function handlesFor(rel, target) {
      const text = codeOf(rel);
      const base = esc(target.replace(/\.js$/, ''));
      const out = new Set();
      /*
       * Any assignment whose require names this file — `const x = require('./x.js')`, and also
       * `contracts = require(path.join(__dirname, '_contracts.js'))`, which the old `[^)]*` pattern
       * could not match because of the inner closing paren. Bounded to one line so it cannot run away.
       */
      for (const m of text.matchAll(new RegExp(`(?:(?:const|let|var)\\s+)?(\\w+)\\s*=\\s*require\\([^;\\n]*${base}\\.js'[^;\\n]*\\)`, 'g'))) out.add(m[1]);
      // `H = require(CONST)` where CONST is a path constant resolving to this file. The declaration
      // keyword is OPTIONAL: a handle declared `let x = null` and assigned later is still a binding,
      // and requiring the keyword made modhealth's own contract-source handle invisible.
      for (const m of text.matchAll(/(?:(?:const|let|var)\s+)?(\w+)\s*=\s*require\((\w+)\)/g)) {
        if (new RegExp(`(?:const|let|var)\\s+${m[2]}\\s*=[^;\\n]*${base}\\.js'`).test(text)) out.add(m[1]);
      }
      // ⛔ The bootstrap-boundary spelling. Every hook with shared dependencies binds through
      // `boot.need('./x.js')` rather than a bare require, and a derivation that knew only `require`
      // would report those modules as having no consumers at all.
      for (const m of text.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*\\w+\\.need\\('\\./${base}\\.js'\\)`, 'g'))) out.add(m[1]);
      for (const m of text.matchAll(/const\s+(\w+)\s*=\s*lazyLib\('(\w+)'\)/g)) if (`${m[2]}.js` === target) out.add(m[1]);
      // The cross-tree shape: probePath(CONST).module, where CONST resolves to this file.
      for (const m of text.matchAll(/const\s+(\w+)\s*=\s*(\w+)\.module;/g)) {
        const dm = new RegExp(`const\\s+${m[2]}\\s*=\\s*modhealth\\.probePath\\((\\w+)\\)`).exec(text);
        if (dm && new RegExp(`const\\s+${dm[1]}\\s*=[^;]*${base}\\.js'`).test(text)) out.add(m[1]);
      }
      return [...out];
    }

    /** Every property read off `target` anywhere in the production trees. */
    function accessesOf(target) {
      const props = new Set();
      const consumers = [];
      for (const rel of PROD) {
        if (path.basename(rel) === target) continue; // a module is not its own consumer
        const text = codeOf(rel);
        const hs = handlesFor(rel, target);
        let hit = false;
        for (const h of hs) {
          for (const m of text.matchAll(new RegExp(`(?<![\\w$./\\\\-])${h}\\.([A-Za-z_$][\\w$]*)`, 'g'))) { props.add(m[1]); hit = true; }
          // ⛔ A computed access cannot be extracted, so it must not exist silently. Asserted on a
          // boolean, not on the file text — a failure here must print the sentence, not the module.
          assert.equal(new RegExp(`(?<![\\w$./\\\\-])${h}\\[`).test(text), false,
            `${rel}: computed property access \`${h}[…]\` on ${target} cannot be checked against the registry. `
            + 'Write the accesses out literally, or classify it explicitly — never leave it unverified.');
        }
        const inline = new RegExp(`require\\([^)]*${esc(target.replace(/\.js$/, ''))}\\.js'\\)\\.([A-Za-z_$][\\w$]*)`, 'g');
        for (const m of text.matchAll(inline)) { props.add(m[1]); hit = true; }
        if (hit) consumers.push(rel);
      }
      return { props: [...props].sort(), consumers };
    }

    test('every kernel subsystem export read by ANY production module is declared, and every declared entry is read', () => {
      for (const [key, s] of Object.entries(modhealth.SUBSYSTEMS)) {
        const { props, consumers } = accessesOf(s.file);
        assert.ok(consumers.length, `no production module binds ${s.file} — the derivation lost its handle, so this fence covers nothing`);
        assert.deepEqual(props, Object.keys(s.exports).sort(),
          `${s.file}: production modules read [${props}] but modhealth.SUBSYSTEMS.${key} declares `
          + `[${Object.keys(s.exports).sort()}] (consumers: ${consumers.join(', ')}). Add the export, or remove the entry whose call site is gone.`);
      }
    });

    test('⛔ every SHIPPED shared hook module has a declared contract matching its real consumers', () => {
      // The set is read off the hooks directory, never listed here: a new shared module is covered the
      // day it is added rather than the day someone remembers this test.
      const shipped = fs.readdirSync(path.join(ROOT_DIR, 'hooks'))
        .filter((f) => f.startsWith('_') && f.endsWith('.js')).sort();
      assert.deepEqual(shipped, Object.keys(modhealth.SHARED).sort(),
        'the shipped shared modules and modhealth.SHARED disagree — a shipped module with real consumers may not be loadability-only');

      for (const [file, declared] of Object.entries(modhealth.SHARED)) {
        const { props, consumers } = accessesOf(file);
        assert.ok(consumers.length, `no production module binds ${file} — the derivation lost its handle, so this fence covers nothing`);
        assert.deepEqual(props, Object.keys(declared).sort(),
          `${file}: production modules read [${props}] but modhealth.SHARED declares [${Object.keys(declared).sort()}] `
          + `(consumers: ${consumers.join(', ')}). Add the export, or remove the entry whose call site is gone.`);
      }
    });

    test('⛔ every SHIPPED kernel lib is registered or is a named bootstrap file — none may be loadability-only', () => {
      /*
       * The symmetric half of the shared-module check. `registered ∪ present` lets doctor REPORT an
       * unregistered file, but it reports it on loadability alone — which is the exemption for a file
       * somebody else dropped in, not for one this pack ships. Without this, a new kernel subsystem
       * could be added, shipped, and consumed while its contract went undeclared: exactly how
       * `readGoalDocClassified` came to be uncheckable.
       */
      const shipped = fs.readdirSync(path.join(ROOT_DIR, 'kernel', 'lib')).filter((f) => f.endsWith('.js')).sort();
      const registered = Object.values(modhealth.SUBSYSTEMS).map((s) => s.file);
      const unaccounted = shipped.filter((f) => !registered.includes(f) && !modhealth.BOOTSTRAP.includes(f));
      assert.deepEqual(unaccounted, [],
        'these kernel libs are shipped but declare no contract, so doctor can only say they load:\n  '
        + `${unaccounted.join('\n  ')}\nRegister them in modhealth.SUBSYSTEMS, or name them in BOOTSTRAP with the reason.`);

      // And nothing is registered that is not shipped — a contract for a file nobody installs.
      const phantom = registered.filter((f) => !shipped.includes(f));
      assert.deepEqual(phantom, [], `the registry declares contracts for files the pack does not ship: ${phantom.join(', ')}`);
    });

    /*
     * ⛔ THE CROSS-TREE EDGES ARE THE ONES NO DERIVATION CAN SEE, SO THEY ARE THE ONES THAT ROT.
     *
     * Sibling edges stay derived from source. The kernel reaches the hook tree by resolving the one
     * relative path both layouts share and probing it — `path.resolve(__dirname, '..', '..', 'hooks',
     * 'x.js')` — and no `require('./…')` regex sees that. Doctor was blind to exactly those edges, so
     * `kernel-lib:state.js` stayed ACTIVE while the boundary it depends on was BROKEN one section up.
     *
     * Both directions: a production cross-tree dependency that is not declared FAILS, and a declared
     * edge whose call site is gone FAILS.
     */
    test('⛔ modhealth.CROSS_TREE matches the real cross-tree dependencies exactly, both ways', () => {
      const KERNEL_FILES = fs.readdirSync(path.join(ROOT_DIR, 'kernel', 'lib')).filter((f) => f.endsWith('.js'));
      const derived = {};
      for (const f of KERNEL_FILES) {
        const text = codeOf(path.posix.join('kernel/lib', f));
        // The one spelling the kernel uses to reach the hook tree, in both layouts.
        const hits = [...new Set([...text.matchAll(/'hooks',\s*'([_\w.-]+\.js)'/g)].map((m) => m[1]))].sort();
        if (hits.length) derived[f] = hits;
      }
      const declared = Object.fromEntries(Object.entries(modhealth.CROSS_TREE).map(([k, v]) => [k, [...v].sort()]));
      assert.deepEqual(declared, derived,
        'modhealth.CROSS_TREE disagrees with the cross-tree requires actually in kernel/lib. A production dependency that '
        + 'is not declared here is invisible to doctor — which is the defect this model exists to close — and a declared '
        + 'edge with no call site is a fence about nothing.');

      // Every declared target must be a module that actually exists in the hook tree.
      const shipped = new Set(fs.readdirSync(path.join(ROOT_DIR, 'hooks')).filter((f) => f.endsWith('.js')));
      for (const [from, tos] of Object.entries(modhealth.CROSS_TREE)) {
        for (const to of tos) assert.ok(shipped.has(to), `CROSS_TREE declares ${from} → ${to}, and ${to} is not shipped`);
      }
    });

    /*
     * ⛔ P-029 · A KERNEL SUBSYSTEM THE INSTALLER DOES NOT PLACE IS BROKEN ON EVERY TARGET, AND NOTHING
     * WAS CHECKING THAT DIRECTION.
     *
     * `install/_sources.js` KERNEL_FILES was fenced one way only: `install/uninstall.test.mjs`'s preflight
     * sweep proves every DECLARED file exists in the pack. Nothing proved the converse — that every
     * kernel lib the pack SHIPS is declared — so adding a subsystem and forgetting the one line in
     * `_sources.js` produced a pack that never installs it, a doctor row reading `kernel-lib:<file>
     * BROKEN` on every target, and a green suite here. Noticed while adding `lib/lineage.js` (P2-P-1),
     * which had to be added to that list by hand with nothing to catch the omission.
     *
     * Both directions, both derived: `kernel/lib/` from disk, KERNEL_FILES from the module. The
     * entrypoint is asserted separately because it is the one KERNEL_FILES entry that is not under
     * `lib/`, and a derivation that silently dropped it would leave a target with no `respawnpack.js`.
     */
    test('⛔ install/_sources.js KERNEL_FILES names EVERY shipped kernel lib, and only shipped ones', () => {
      const sources = require_(path.join(ROOT_DIR, 'install', '_sources.js'));
      const shipped = fs.readdirSync(path.join(ROOT_DIR, 'kernel', 'lib')).filter((f) => f.endsWith('.js')).sort();
      const declared = sources.KERNEL_FILES
        .filter((f) => f.startsWith('kernel/lib/')).map((f) => f.slice('kernel/lib/'.length)).sort();
      assert.ok(shipped.length >= 10, `only ${shipped.length} kernel lib(s) found — the derivation is not reaching the tree`);
      assert.deepEqual(declared, shipped,
        'install/_sources.js KERNEL_FILES disagrees with kernel/lib/ on disk. A shipped subsystem this list omits is never '
        + 'installed, so every target reports it BROKEN; a declared file the pack does not ship aborts every upgrade at preflight.');
      assert.ok(sources.KERNEL_FILES.includes('kernel/respawnpack.js'),
        'KERNEL_FILES no longer names the entrypoint, so a target would receive a lib directory and nothing to run it');
    });

    test('the dependency graph keys are unambiguous across both trees', () => {
      // `dependencyGraph` is keyed by basename, which is only sound while the two trees share no name.
      const kernelNames = fs.readdirSync(path.join(ROOT_DIR, 'kernel', 'lib')).filter((f) => f.endsWith('.js'));
      const hookNames = fs.readdirSync(path.join(ROOT_DIR, 'hooks')).filter((f) => f.endsWith('.js'));
      const clash = kernelNames.filter((f) => hookNames.includes(f));
      assert.deepEqual(clash, [],
        'a filename exists in BOTH trees, so the basename-keyed dependency graph would merge two different modules '
        + 'into one node. Rename one, or key the graph by tree+basename.');
    });

    test('⛔ an unregistered cross-tree dependency is caught — the fence is not decorative', () => {
      // Drop a real declared edge and the comparison above must stop holding.
      const mutant = { ...modhealth.CROSS_TREE, 'state.js': ['_manifest.js'] };
      const derivedState = [...new Set([...codeOf('kernel/lib/state.js').matchAll(/'hooks',\s*'([_\w.-]+\.js)'/g)].map((m) => m[1]))].sort();
      assert.notDeepEqual(mutant['state.js'].sort(), derivedState,
        'removing _artifact.js from the declared state.js edges did NOT change the comparison — the derivation is not '
        + 'reaching the real cross-tree require, so the fence would pass over an unregistered dependency');
    });

    /*
     * ⛔ ONE CONTRACT SOURCE, PROVEN BY IDENTITY — NOT BY TWO LISTS THAT HAPPEN TO AGREE.
     *
     * `doctor` validated a typed contract while `boot.need()` only checked that a module LOADED, and the
     * gap between those two answers was the reported P0: a wrong-typed `_shell.HIDDEN_PROGRAM` reported
     * BROKEN by doctor and ALLOWED by the live guard. Fixing that by giving `_boot.js` its own copy of
     * the declaration would have set up the same divergence one refactor later.
     *
     * Reference identity is the assertion, because deep equality is exactly what a stale copy still
     * passes on the day it is written.
     */
    test('⛔ the runtime and doctor read the SAME contract object, not two copies of it', () => {
      const contracts = require_(path.join(ROOT_DIR, 'hooks', '_contracts.js'));
      assert.equal(modhealth.SHARED, contracts.CONTRACTS,
        'modhealth.SHARED is not the very object hooks/_contracts.js exports. A structurally equal COPY passes deep '
        + 'equality on the day it is made and diverges silently afterwards — which is how the runtime came to allow '
        + 'what doctor called broken.');
      assert.equal(modhealth.satisfies, contracts.satisfies, 'the type predicate must be the one implementation, not a second');
      assert.equal(modhealth.typeOf, contracts.typeOf, 'the type namer must be the one implementation, not a second');
      assert.equal(modhealth.contractSource.ok, true, `the contract source is not usable: ${modhealth.contractSource.detail}`);

      // Watched failing: a structurally identical copy must NOT satisfy the identity check.
      const copy = JSON.parse(JSON.stringify(contracts.CONTRACTS));
      assert.deepEqual(copy, contracts.CONTRACTS, 'sanity: the copy really is structurally equal');
      assert.notEqual(copy, contracts.CONTRACTS,
        'a structural copy satisfied the identity comparison — then the assertion above cannot detect duplication');
    });

    test('⛔ hooks/_boot.js validates the contract itself — the runtime cannot be left checking loadability only', () => {
      const boot = fs.readFileSync(path.join(ROOT_DIR, 'hooks', '_boot.js'), 'utf8');
      assert.match(boot, /_contracts\.js/, 'hooks/_boot.js no longer reads the contract source at all');
      assert.match(boot, /contracts\.validate\(/, 'hooks/_boot.js no longer validates a loaded module against its contract');
      // The claim the previous round made and could not keep must not come back.
      assert.doesNotMatch(boot, /net[^.]*catches (missing|wrong)/i,
        'the process-level net is being described as a contract validator again — it only sees violations that throw');
    });

    test('every declared type matches the type the module actually exports', () => {
      // A contract that says `function` for something exported as a string would make the probe reject a
      // healthy install — a fence that fails closed on the truth is its own defect.
      for (const [file, declared] of Object.entries(modhealth.CONTRACTS)) {
        const rel = file.startsWith('_') ? `hooks/${file}` : `kernel/lib/${file}`;
        const mod = require_(path.join(ROOT_DIR, rel));
        for (const [name, want] of Object.entries(declared)) {
          assert.ok(modhealth.satisfies(mod[name], want),
            `${file}.${name} is declared ${want} but the module exports ${modhealth.typeOf(mod[name])}`);
        }
      }
    });

    test('the lazy handles and the subsystem registry still agree exactly', () => {
      const src = fs.readFileSync(path.join(KERNEL, 'respawnpack.js'), 'utf8');
      const handles = [...src.matchAll(/const (\w+) = lazyLib\('(\w+)'\);/g)].map((m) => m[2]);
      assert.ok(handles.length >= 8, `only ${handles.length} lazy subsystem handles found — the declaration form must have changed; update this fence with it`);
      assert.deepEqual(handles.sort(), Object.keys(modhealth.SUBSYSTEMS).sort(),
        'the lazy handles and the registry disagree — a subsystem removed from one while the other still names it is exactly the drift this registry exists to prevent');
    });

    /*
     * ⛔ AND THE FENCE IS WATCHED FAILING. Deleting `_artifact.js`'s contract entry is the precise
     * regression that shipped: it returns the module to loadability-only, which is how a shared library
     * missing `loadRequirements` reported ACTIVE while `state` died on a TypeError.
     */
    test('deleting the _artifact.js contract entry is caught — the fence is not decorative', () => {
      const shipped = fs.readdirSync(path.join(ROOT_DIR, 'hooks'))
        .filter((f) => f.startsWith('_') && f.endsWith('.js')).sort();
      const mutant = { ...modhealth.SHARED };
      delete mutant['_artifact.js'];
      assert.notDeepEqual(shipped, Object.keys(mutant).sort(),
        'removing _artifact.js from the shared registry did NOT break the shipped-vs-declared comparison, so that assertion is not what is holding the contract in place');

      // And the same for a kernel entry the CLI never reads — the Case B shape.
      const stateExports = { ...modhealth.SUBSYSTEMS.state.exports };
      delete stateExports.readGoalDocClassified;
      const { props } = accessesOf('state.js');
      assert.notDeepEqual(props, Object.keys(stateExports).sort(),
        'dropping readGoalDocClassified from the state contract did NOT change the comparison — the whole-tree derivation is not reaching closeout.js');
    });
  });

  /*
   * ⛔ AND THERE MUST BE EXACTLY ONE FILENAME REGISTRY. `respawnpack.js` used to carry its own
   * `KERNEL_LIBS` map beside the contracts in modhealth — two lists, one of which was going to go stale.
   * Prose may name a file (the ⛔ notes do, constantly); a string LITERAL in code is a list forming.
   */
  test('no second kernel-filename registry exists outside modhealth', () => {
    const code = fs.readFileSync(path.join(KERNEL, 'respawnpack.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
      .replace(/^\s*\/\/.*$/gm, ' ');      // line comments
    const literals = [...code.matchAll(/['"]([^'"\n]*\.js)['"]/g)].map((m) => m[1]);
    const registered = new Set(Object.values(modhealth.SUBSYSTEMS).map((s) => s.file));
    const strays = literals.filter((l) => registered.has(l.split('/').pop()));
    assert.deepEqual(strays, [],
      `respawnpack.js names kernel subsystem file(s) as string literals: ${strays.join(', ')}. The registry in modhealth.SUBSYSTEMS is the only place a kernel filename belongs`);
    // The bootstrap requires are the deliberate exception, and they must still be there.
    assert.match(code, /require\('\.\/lib\/outcome\.js'\)/, 'the outcome bootstrap require is gone');
    assert.match(code, /require\('\.\/lib\/modhealth\.js'\)/, 'the modhealth bootstrap require is gone');
  });

  test('the declared contract names every function its readers actually call', () => {
    // Two-sided: the contract cannot quietly shrink to whatever still passes. Each name below must be
    // called somewhere in the tree, and every cross-tree call must be in the contract.
    const called = new Set();
    for (const rel of ['respawnpack.js', 'lib/state.js', 'lib/removals.js', '../hooks/_runtime.js']) {
      const src = fs.readFileSync(path.join(KERNEL, rel), 'utf8');
      for (const m of src.matchAll(/\bmanifest(?:Lib)?\.(\w+)\s*\(/g)) called.add(m[1]);
    }
    assert.ok(called.size >= 3, 'the call scan found almost nothing — the pattern it matches must have changed');
    for (const name of called) {
      // Contracts are name→type maps now (the constants matter as much as the functions), so the
      // membership question is asked of the keys.
      assert.ok(Object.keys(modhealth.CONTRACTS['_manifest.js']).includes(name),
        `${name}() is called on the shared manifest but is not in its contract — an unchecked export is one doctor will call ACTIVE`);
    }
  });
});

/*
 * ⛔ P2-K-13 — the relocation's own risk, proven both directions. `sweep-scratch` moved from a kernel
 * verb (`kernel/respawnpack.js`) to a standalone script (`ops/sweep-scratch.mjs`); the failure mode a
 * move like this invites is a script that silently did not land, or a verb that silently still answers
 * from the old address. Both are asserted directly, not inferred from the tests below passing.
 */
describe('sweep-scratch relocation (P2-K-13) · gone from the kernel, present in ops/', () => {
  test('the defect this move could introduce: the kernel refuses `sweep-scratch` as an unknown verb, same exit code every unknown verb gets', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const r = cli(p.dir, 'sweep-scratch', '--into', 'research');
      assert.equal(r.code, 1, 'an unknown verb must exit 1 (R26) — sweep-scratch must not still answer from kernel/respawnpack.js');
      assert.equal(r.json, null, 'an unknown verb prints the help text, not JSON, regardless of --json');
      assert.match(r.stdout, /respawnpack <verb>/, 'the unknown-verb path falls through to the usage banner');
      assert.doesNotMatch(r.stdout, /sweep-scratch/, 'the removed verb must not still be listed in --help');
    } finally { rm(p.dir); }
  });

  test('the corrected address: ops/sweep-scratch.mjs exists and runs standalone, with no verb argument', () => {
    assert.ok(fs.existsSync(OPS_SWEEP_SCRATCH), 'ops/sweep-scratch.mjs must exist after the move — this is the file the tests below actually drive');
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      const r = opsSweepScratch(p.dir);
      assert.equal(r.code, 0);
      assert.equal(r.json.outcome, 'NOT_APPLICABLE', 'a project with no .respawnpack/scratch/ is NOT_APPLICABLE, exactly as the kernel verb reported it');
    } finally { rm(p.dir); }
  });
});

/*
 * ⛔ the 2026-08-07 field run §3 — the sweep, not the sandbox.
 *
 * The report says subagent writes landed in `.respawnpack/scratch/<agentId>/` "silently", nearly losing
 * ~2.4 MB of research. One correction it could not make from the outside: this pack's guard does not do
 * that — hooks/index-guard.js DENIES an out-of-scratch subagent write with a named reason. Whatever
 * relocated those files was not RespawnPack, so this tool does not pretend to fix the guard.
 *
 * What IS this pack's to fix is the recovery, and that is where the measurable damage happened: a
 * `cp -n` sweep run while agents were still writing produced `01-hunting-methodology.md` at 46 KB of a
 * real 203 KB, and missed seven files, because "file exists at destination" read as success.
 *
 * The sizes below are the reported ones. The middle case is the whole point of the tool: a source
 * SMALLER than its destination must be refused — not skipped (which is what cp -n did) and not applied
 * (which would be the same truncation from the other direction).
 *
 * ⛔ P2-K-13: driven through `ops/sweep-scratch.mjs` (`opsSweepScratch` below), not the kernel CLI — the
 * verb moved out of the kernel; see the relocation describe block further down for the move itself.
 */
describe('sweep-scratch · byte size is the verdict, not existence (field run §3)', () => {
  const KB = 1024;
  const scratchProject = () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    const put = (rel, bytes) => {
      const abs = path.join(p.dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'X'.repeat(bytes));
    };
    put('.respawnpack/scratch/agent_a/01-hunting-methodology.md', 203 * KB); // complete
    put('.respawnpack/scratch/agent_b/partial.md', 46 * KB);                 // still being written
    put('research/partial.md', 203 * KB);                                    // already complete at the destination
    return p;
  };

  test('a smaller source over a larger destination is REFUSED, and the destination is untouched', () => {
    const p = scratchProject();
    try {
      const preview = opsSweepScratch(p.dir, '--into', 'research');
      assert.equal(preview.json.applied, false, 'a bare sweep wrote files — a recovery tool must be readable before it acts');
      const refused = preview.json.files.find((f) => f.to.endsWith('partial.md'));
      assert.equal(refused.action, 'REFUSE', 'the 46 KB-over-203 KB case was not refused — this is the exact reported truncation');
      assert.equal(refused.srcBytes, 46 * KB);
      assert.equal(refused.destBytes, 203 * KB);

      const applied = opsSweepScratch(p.dir, '--into', 'research', '--write');
      assert.equal(fs.statSync(path.join(p.dir, 'research', 'partial.md')).size, 203 * KB,
        'the complete destination file was overwritten by a partial source');
      assert.equal(applied.json.outcome, 'FAIL', 'a refused file must make the whole sweep non-passing — a quiet skip is how this was missed');
      assert.equal(applied.json.totals.refused, 1);
    } finally { rm(p.dir); }
  });

  test('the safe files DO move, byte-exact, and scratch is never emptied', () => {
    const p = scratchProject();
    try {
      const r = opsSweepScratch(p.dir, '--into', 'research', '--write');
      const landed = path.join(p.dir, 'research', '01-hunting-methodology.md');
      assert.equal(fs.statSync(landed).size, 203 * KB, 'the complete file did not arrive intact');
      assert.equal(r.json.totals.moved, 1);
      assert.equal(r.json.totals.movedBytes, 203 * KB, 'the report must state bytes moved — a file count is what made a 46 KB file look like a success');

      assert.ok(fs.existsSync(path.join(p.dir, '.respawnpack', 'scratch', 'agent_a', '01-hunting-methodology.md')),
        'the sweep deleted its own source — a sweep that removes its evidence cannot be checked afterwards');
    } finally { rm(p.dir); }
  });

  test('it refuses to guess the destination, and says so rather than sweeping somewhere plausible', () => {
    const p = scratchProject();
    try {
      const r = opsSweepScratch(p.dir);
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.match(r.json.error, /--into/, 'the refusal must name the flag that resolves it');
      assert.ok(fs.existsSync(path.join(p.dir, '.respawnpack', 'scratch', 'agent_a', '01-hunting-methodology.md')));
    } finally { rm(p.dir); }
  });

  test('two agents targeting one destination are BOTH refused — the sweep will not pick a winner', () => {
    /*
     * Each file is planned independently, so two helpers that both wrote `notes.md` both plan a clean
     * MOVE, and applying them in order silently destroys the first. That is the same class of loss as
     * the 46 KB truncation with a different cause, and it is not an ordering question: size settles a
     * truncated copy of ONE file and says nothing about two different files sharing a name.
     */
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      for (const a of ['agent_a', 'agent_b']) {
        const abs = path.join(p.dir, '.respawnpack', 'scratch', a, 'notes.md');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `${a} notes — must not be destroyed by the other\n`);
      }

      const r = opsSweepScratch(p.dir, '--into', 'out', '--write');
      assert.equal(r.json.files.length, 2);
      assert.deepEqual(r.json.files.map((f) => f.action), ['REFUSE', 'REFUSE'],
        'a colliding pair was swept — whichever landed second destroyed the first');
      assert.equal(r.json.outcome, 'FAIL');
      assert.match(r.json.files[0].why, /agent_a, agent_b|agent_b, agent_a/, 'the refusal must name every agent involved');
      assert.equal(fs.existsSync(path.join(p.dir, 'out', 'notes.md')), false, 'nothing may be written when the outcome is a collision');

      // And both originals are still in scratch, so the operator can resolve it by hand.
      for (const a of ['agent_a', 'agent_b']) {
        assert.ok(fs.existsSync(path.join(p.dir, '.respawnpack', 'scratch', a, 'notes.md')), `${a}'s file was consumed by a refused sweep`);
      }
    } finally { rm(p.dir); }
  });
});

/*
 * ⛔ BUG-1 (the kernel audit, HIGH, security-adjacent; fixed by fa3307f, P1-K-01). `--into` reached
 * `path.join(DIR, into, childRel)` with no containment check at all: a `..`-relative value copied bytes
 * to a directory OUTSIDE the project and sweep-scratch reported PASS; an absolute value produced a
 * nonsense concatenated path that FAILed on a confusing ENOENT naming a destination the tool never
 * targeted. Every other path-taking surface in the kernel guards this — removals.js's
 * `portableAbsolute`/`hasParentSegment`/`containedResolution` and reconcile.js's identical trio.
 * sweep-scratch alone had none. The fix reuses removals.js's guard trio (exported for this) rather than
 * growing a third copy of it — these four tests are P1-K-01's own, driven through `ops/sweep-scratch.mjs`
 * after P2-K-13 moved the tool out of the kernel; the containment behavior did not change, only the
 * address. The first test below is also the "nearest bypass" state: `--into ../outside --write` refused,
 * nothing written.
 */
describe('sweep-scratch --into · containment inside the project (BUG-1)', () => {
  const leakProject = () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    const abs = path.join(p.dir, '.respawnpack', 'scratch', 'agent_a', 'leak.md');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'leaked content\n');
    return p;
  };

  test('the original defect: a `..`-relative --into is refused, exit 2, and nothing lands outside the project — in preview AND with --write', () => {
    const p = leakProject();
    const outsideName = `escape-${path.basename(p.dir)}`;
    const outside = path.join(p.dir, '..', outsideName);
    const into = `../${outsideName}`;
    try {
      // Preview mode must refuse too, so the printed plan never shows an out-of-tree destination as
      // something --write would apply.
      const preview = opsSweepScratch(p.dir, '--into', into);
      assert.equal(preview.json.outcome, 'CANNOT_DETERMINE', 'a `..`-relative --into was not refused in preview');
      assert.equal(preview.code, 2);
      assert.match(preview.json.error, /--into/, 'the refusal must name the --into flag');
      assert.match(preview.json.error, new RegExp(outsideName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'the refusal must name the offending value');
      assert.equal(fs.existsSync(outside), false, 'a bare preview must not create the out-of-tree destination');

      const applied = opsSweepScratch(p.dir, '--into', into, '--write');
      assert.equal(applied.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(applied.code, 2, 'a `..`-relative --into must exit 2, not the 0 this defect used to report as PASS');
      assert.equal(fs.existsSync(outside), false, 'sweep-scratch wrote outside the project it was asked to sweep');
      assert.ok(fs.existsSync(path.join(p.dir, '.respawnpack', 'scratch', 'agent_a', 'leak.md')),
        'a refused sweep must leave scratch untouched');
    } finally { rm(p.dir); rm(outside); }
  });

  test('the corrected case: a contained --into still sweeps, exactly as before', () => {
    const p = leakProject();
    try {
      // A NESTED, not-yet-existing destination: the nearest-existing-ancestor resolution must walk up
      // to the project root and still call it contained, the same as removals.js's own registry path.
      const r = opsSweepScratch(p.dir, '--into', 'out/dir', '--write');
      assert.equal(r.json.outcome, 'PASS');
      assert.equal(r.code, 0);
      assert.ok(fs.existsSync(path.join(p.dir, 'out', 'dir', 'leak.md')), 'a project-relative --into stopped sweeping');
    } finally { rm(p.dir); }
  });

  test('the nearest bypass: an in-project path that is a symlink (junction on Windows) to outside the project is refused', () => {
    /*
     * Windows: created as a directory JUNCTION, the same fallback kernel.test.mjs's own removals
     * containment test ("a configured root symlink and registry path cannot escape project authority")
     * and removals.js's own fixtures use — junction creation needs no elevated privilege, unlike a real
     * symlink on Windows. Confirmed on this machine before writing this test.
     */
    const p = leakProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-sweep-outside-'));
    const linkPath = path.join(p.dir, 'linked');
    try {
      fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      const r = opsSweepScratch(p.dir, '--into', 'linked', '--write');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.code, 2);
      assert.match(r.json.error, /symlink/i,
        'a symlink escape must be named as such — the lexical check alone would have called this "linked" contained');
      assert.equal(fs.readdirSync(outside).length, 0, 'sweep-scratch wrote through the symlink to outside the project');
      assert.ok(fs.existsSync(path.join(p.dir, '.respawnpack', 'scratch', 'agent_a', 'leak.md')),
        'a refused sweep must leave scratch untouched');
    } finally { rm(p.dir); rm(outside); }
  });

  test('an absolute --into refuses with the same containment reason, not the previous confusing ENOENT', () => {
    const p = leakProject();
    const absoluteOutside = path.join(os.tmpdir(), `rp-sweep-absolute-${path.basename(p.dir)}`);
    try {
      const r = opsSweepScratch(p.dir, '--into', absoluteOutside, '--write');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.code, 2);
      assert.doesNotMatch(r.json.error, /ENOENT/,
        'an absolute --into must be refused by the containment check, not fail on a raw filesystem error naming a path the tool never targeted');
      assert.match(r.json.error, /--into/);
      assert.equal(fs.existsSync(absoluteOutside), false);
    } finally { rm(p.dir); }
  });
});

// --- Scenario O -------------------------------------------------------------------------------------
//
// ⛔ THE DOGFOOD THAT PRODUCED THIS BLOCK. A Claude Code run installed the pack into a fresh repository
// and drove the whole loop. Every kernel check was honest and the result was unusable: removals,
// reconcile and requirements each reported CANNOT_DETERMINE because nobody had declared anything, and
// savepoint rolled that into one flat CANNOT_DETERMINE indistinguishable from a broken generator, a
// disagreeing writeback, or a scan pointed at nothing. The two repairs on offer were both the defect
// this kernel exists to refuse: normalize CANNOT_DETERMINE into a healthy terminal state, or relax the
// zero-work guards until something went green.
//
// The five fixtures below pin the third answer — an explicit applicability state per optional contract —
// at the five repository shapes that distinguish it from either of those two. Each carries the
// discriminating control that a weakened implementation would also pass.

/** A repository with an arbitrary respawnpack.config.json and no seeded state files. */
function bareProject(config = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-onboard-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'k@respawnpack.test'); git('config', 'user.name', 'Kernel');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  if (config !== null) fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify(config, null, 2));
  git('add', '-A'); git('commit', '--quiet', '-m', 'init');
  return { dir, git };
}

/** Every optional contract answered: two configured, the rest declared not applicable WITH reasons. */
const FULLY_DECIDED = {
  routeSource: { notApplicable: true, reason: 'a library with no web surface' },
  codeTruth: { notApplicable: true, reason: 'no token, copy or schema source outranks the prose here' },
  qualityGate: { notApplicable: true, reason: 'no build system is configured for this fixture' },
  state: {
    removals: { notApplicable: true, reason: 'no capability has been retired yet' },
    reconcile: { notApplicable: true, reason: 'this project has no structured task source' },
  },
};

const onboardingRow = (r) => (r.json.rows || []).find((x) => x.check === 'onboarding');
const coverageOf = (r) => (r.json.checks || []).filter((c) => c.domain === 'coverage');

describe('Scenario O · onboarding state is explicit, and an unfinished one is neither green nor broken', () => {
  test('O1 · an EMPTY GREENFIELD repository reports integrity PASS and coverage CANNOT_DETERMINE, at exit 2', () => {
    const p = bareProject(); // no respawnpack.config.json at all
    try {
      const r = cli(p.dir, 'savepoint');
      assert.equal(r.json.verdicts.integrity, 'PASS',
        'the machinery works on a greenfield repo, and reporting it as broken is what sent the dogfood looking for something to weaken');
      assert.equal(r.json.verdicts.coverage, 'CANNOT_DETERMINE',
        'nothing has been decided, so coverage cannot be determined — this is the state that must stay expressible');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.code, 2, 'the exit stays the WORSE of the two verdicts: splitting the report is the fix, splitting the exit code would be the manufactured green');
      assert.equal(r.json.onboardingComplete, false);
      assert.deepEqual([...r.json.unresolved].sort(), ['codeTruth', 'qualityGate', 'reconcile', 'removals', 'routes'],
        'every optional contract with no answer must be NAMED, or the operator is told something is wrong and not what');

      // ⛔ THE CONTROL. Absence must not be inferred into NOT_APPLICABLE anywhere in the coverage set:
      // that inference is the whole failure, and it would make this fixture pass while breaking the rule.
      const inferred = coverageOf(r).filter((c) => c.outcome === 'NOT_APPLICABLE' && c.check !== 'requirements');
      assert.deepEqual(inferred, [], 'a contract nobody declared was reported NOT_APPLICABLE — NOT_APPLICABLE is only ever DECLARED');
    } finally { rm(p.dir); }
  });

  test('O2 · an EXPLICIT MINIMAL repository — every contract declared not applicable, with reasons — PASSES at exit 0', () => {
    const p = bareProject(FULLY_DECIDED);
    try {
      const r = cli(p.dir, 'savepoint');
      assert.equal(r.json.verdicts.coverage, 'NOT_APPLICABLE',
        'a project that answered every question with a stated reason has resolved its coverage');
      assert.equal(r.json.outcome, 'PASS');
      assert.equal(r.code, 0, 'a structurally healthy repository whose contracts are all validly not-applicable must be able to reach exit 0, or the only way out of CANNOT_DETERMINE is to weaken a check');
      assert.equal(r.json.onboardingComplete, true);
      for (const c of coverageOf(r)) {
        assert.notEqual(c.outcome, 'CANNOT_DETERMINE', `${c.check} is still undetermined in a fully-declared project`);
      }
    } finally { rm(p.dir); }
  });

  test('O2 control · the SAME declarations without reasons do NOT pass — an opt-out nobody justifies is not an opt-out', () => {
    const p = bareProject({
      routeSource: { notApplicable: true },
      codeTruth: { notApplicable: true },
      state: { removals: { notApplicable: true }, reconcile: { notApplicable: true } },
    });
    try {
      const r = cli(p.dir, 'savepoint');
      assert.equal(r.json.verdicts.coverage, 'CANNOT_DETERMINE',
        'reason-less opt-outs passed — without this control, O2 proves only that the word notApplicable is honoured, not that the reason is');
      assert.equal(r.code, 2);
      assert.equal(r.json.onboardingComplete, false, 'a project that cannot justify its opt-outs has not finished onboarding');
    } finally { rm(p.dir); }
  });

  test('O3 · a MATURE CONFIGURED product — every contract pointed at a real source — passes, and the checks really ran', () => {
    const p = project({ requirements: [{ id: 'R-1', title: 'export works', mandatory: true }] });
    try {
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify(GAUNTLET_ROW, null, 2));
      fs.mkdirSync(path.join(p.dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'docs', 'PRODUCT.md'), '# Product\n\nOrdinary live content with nothing retired in it.\n');
      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), JSON.stringify({
        routeSource: 'app/**/page.tsx',
        codeTruth: ['src/tokens.ts'],
        qualityGate: { notApplicable: true, reason: 'quality checks are tracked in the harness, not in this pack' },
        state: {
          removals: { registry: 'docs/derived/state/removals.json', liveContentDirs: ['docs'] },
          reconcile: { notApplicable: true, reason: 'tracked in the harness, not in a structured source' },
        },
      }, null, 2));
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'configure');

      const r = cli(p.dir, 'savepoint');
      assert.equal(r.json.onboardingComplete, true, 'a fully configured product still reads as unfinished');
      assert.equal(r.json.outcome, 'PASS');
      assert.equal(r.code, 0);

      // ⛔ AND THE CONFIGURED CONTRACT ACTUALLY RAN. A coverage row saying "configured" while the scan
      // examined nothing is the empty-validator shape with a nicer label on it.
      const scan = r.json.checks.find((c) => c.check.startsWith('removals:') && c.checked > 0);
      assert.ok(scan, 'nothing in the removal contract reports a positive checked count, so "configured" here means only that a key exists');
    } finally { rm(p.dir); }
  });

  test('O4 · a repository with its FIRST RETIRED CAPABILITY moves from undecided to configured, and enforces it', () => {
    const p = project({ requirements: [{ id: 'R-1', mandatory: true }] });
    try {
      fs.mkdirSync(path.join(p.dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'docs', 'PRODUCT.md'), '# Product\n\nNothing retired here yet.\n');
      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), JSON.stringify({
        ...FULLY_DECIDED,
        state: { ...FULLY_DECIDED.state, removals: { registry: 'docs/derived/state/removals.json', liveContentDirs: ['docs'] } },
      }, null, 2));

      // BEFORE: the scan is configured and the project has retired nothing, and has not said so.
      const before = cli(p.dir, 'doctor');
      assert.equal(onboardingRow(before).label, 'INCOMPLETE',
        'a configured scan over an empty registry claimed a guarantee with no subject behind it');

      // The project states its baseline: nothing retired yet, deliberately. That is a decision.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify({
        schemaVersion: '1.0.0', removals: [], emptyBaseline: 'no capability has been retired yet; this baseline is deliberately empty',
      }, null, 2));
      const declared = cli(p.dir, 'savepoint');
      assert.equal(declared.code, 0, 'a declared-empty retirement baseline must be a passing state, or the only escape is to un-configure the scan');

      // AFTER: the first real retirement lands. The contract was already on, so it is enforced now.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify(GAUNTLET_ROW, null, 2));
      fs.writeFileSync(path.join(p.dir, 'docs', 'PRODUCT.md'), '# Product\n\nThe launch roster ships four magic gauntlets.\n');
      const after = cli(p.dir, 'removals');
      assert.equal(after.json.outcome, 'FAIL', 'the first retired capability was recorded and its reintroduction was NOT caught');
      assert.equal(after.code, 1);

      // ⛔ THE CONTROL. A stale baseline note must not survive the arrival of real rows and go on
      // suppressing them — the row set is the contract the moment there is one.
      fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify({
        ...GAUNTLET_ROW, emptyBaseline: 'left over from before anything was retired',
      }, null, 2));
      const stale = cli(p.dir, 'removals');
      assert.equal(stale.json.outcome, 'FAIL', 'a leftover emptyBaseline suppressed a registry that has real rows in it');
    } finally { rm(p.dir); }
  });

  test('O5 control · an UNPARSEABLE config is INVALID, not "no key here" — absent and malformed stay distinct', () => {
    /*
     * The two contracts with no reader of their own would otherwise report "no routeSource in
     * respawnpack.config.json", which sends the founder to add a key to a file nothing can read.
     */
    const p = bareProject(FULLY_DECIDED);
    try {
      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), '{ this is not json');
      const r = cli(p.dir, 'savepoint');
      const rows = r.json.applicability.filter((x) => x.subsystem === 'routes' || x.subsystem === 'codeTruth');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.state, 'INVALID', `${row.subsystem} reported ${row.state} against an unparseable config`);
        assert.equal(row.basis, 'malformed', `${row.subsystem} classified an unreadable file as an absent key`);
      }
      assert.equal(r.code, 2, 'a project whose configuration cannot be read has not established anything');
    } finally { rm(p.dir); }
  });

  test('O5 · INCOMPLETE ONBOARDING stays CANNOT_DETERMINE — a leftover installer template is not a value', () => {
    /*
     * The literal strings older installers seeded. /savepoint's routes step enumerates routeSource
     * against FEATURES-PAGES.md; handed this template it globs zero routes, finds zero orphans in both
     * directions, and reports no drift. A check that matches nothing agrees with everything.
     */
    const p = bareProject({
      ...FULLY_DECIDED,
      routeSource: '<set ROUTE_SOURCE>',
      codeTruth: '<set CODE_TRUTH: token/copy/schema source paths>',
    });
    try {
      const r = cli(p.dir, 'savepoint');
      assert.equal(r.json.verdicts.coverage, 'CANNOT_DETERMINE', 'an installer template was accepted as configuration');
      assert.equal(r.code, 2);
      assert.deepEqual([...r.json.unresolved].sort(), ['codeTruth', 'routes']);

      const row = r.json.applicability.find((x) => x.subsystem === 'routes');
      assert.equal(row.state, 'INVALID', 'a leftover template is INVALID, not UNDECIDED: somebody started, and telling them they never did is the wrong instruction');
      assert.equal(row.basis, 'template');

      // ⛔ And the nearest bypass: the same template one wrapper out, inside the list form.
      const wrapped = bareProject({ ...FULLY_DECIDED, codeTruth: ['<set CODE_TRUTH: token/copy/schema source paths>'] });
      try {
        const w = cli(wrapped.dir, 'savepoint');
        const wr = w.json.applicability.find((x) => x.subsystem === 'codeTruth');
        assert.equal(wr.state, 'INVALID', 'a template inside a list was accepted as configuration — the same silent green, one wrapper out');
        assert.equal(wr.basis, 'template');
        assert.equal(w.code, 2);
      } finally { rm(wrapped.dir); }

      const d = cli(p.dir, 'doctor');
      assert.equal(onboardingRow(d).label, 'INCOMPLETE', 'doctor must say onboarding is incomplete rather than leaving the founder to infer it from amber rows');
      assert.equal(d.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(d.code, 2, 'an install nobody finished answering for has not established that it is ready');

      // ⛔ THE CONTROL. The SAME repository with real values differs only in those two strings, and must
      // pass — otherwise this fixture proves the run is red, not that the template is what made it red.
      const q = bareProject({ ...FULLY_DECIDED, routeSource: 'app/**/page.tsx', codeTruth: 'src/tokens.ts' });
      try {
        const ok = cli(q.dir, 'savepoint');
        assert.equal(ok.json.verdicts.coverage, 'PASS', 'two configured contracts must roll coverage up to PASS, not merely stop blocking it');
        assert.equal(ok.code, 0, 'real values in the same two keys did not clear the coverage verdict');
        assert.equal(onboardingRow(cli(q.dir, 'doctor')).label, 'COMPLETE');
      } finally { rm(q.dir); }
    } finally { rm(p.dir); }
  });
});

// --- P3-N-2 · the day-one twin: today's exit codes on a bare, just-installed target, pinned -----------
//
// ⛔ WHY THIS EXISTS, AND HOW IT DIFFERS FROM SCENARIO O1 ABOVE. install/install.test.mjs's freeze test
// pins the BYTES install.js writes for a target with no posture key; this pins the other half hard
// constraint 1 promises — "today's exit codes" (the rework task list, §1 item 35; the posture design note §6) — for the
// three verbs a founder runs first. O1 above proves the same STORY (nothing decided, exit 2, named
// rather than inferred) on a hand-built fixture with NO respawnpack.config.json at all. This proves it
// again on the artifact install.js actually leaves behind, which is a different shape: the installer
// SEEDS state.removals (a real registry path and liveContentDirs) rather than omitting the key, and
// leaves state.reconcile / routeSource / codeTruth / qualityGate genuinely undecided. That it lands on
// the same outcome is worth pinning in its own right, not assumed from O1's bare-config case.
//
// Every id and count below was read off a REAL run of savepoint/doctor/gate against install.js's own
// output on this tree, per this task's brief to "verify the exact ids on the current tree and pin what
// you observe, naming any difference from the block" — not copied from the task brief that named them.
// It differs from that brief in exactly one place: the brief names the removals coverage row
// `removals:config`; the kernel actually emits `removals:registry` (the registry file exists and is
// configured, it is simply empty — see kernel/lib/removals.js's CANNOT_DETERMINE-on-empty-registry rule,
// anti-drift item 14). The row asserted below is the one observed, `removals:registry`.
const INSTALL_JS = path.join(path.dirname(KERNEL), 'install', 'install.js');

/**
 * A target exactly as `install/install.js` leaves it: a real git repo, freshly installed, never
 * savepoint/doctor/gate'd before. Each test below gets its OWN fresh copy from this — chaining verbs on
 * one shared directory is NOT equivalent and was checked, not assumed: `savepoint` writes
 * docs/derived/STATE.json as a side effect the first time it runs (and, observed directly, running
 * `savepoint` twice on one fixture changes its exit code from 2 to 1 once the installed tree is
 * committed in between), so a doctor/gate call made AFTER an earlier verb's first run is no longer
 * observing "day one". Giving every verb its own untouched fixture is what makes "day one" mean the
 * FIRST invocation rather than "whichever invocation happens to run first in file order".
 */
function installedDayOneFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-dayone-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'k@respawnpack.test'); git('config', 'user.name', 'Kernel');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'init');
  const installed = spawnSync(process.execPath, [INSTALL_JS, dir], { encoding: 'utf8' });
  assert.equal(installed.status, 0, `install.js must succeed against a bare fixture: ${installed.stdout}\n${installed.stderr}`);
  return dir;
}

describe("P3-N-2 · the day-one twin — today's exit codes on a just-installed target, pinned", () => {
  test('savepoint exits 2 with exactly four CANNOT_DETERMINE coverage rows on a freshly installed target', () => {
    const dir = installedDayOneFixture();
    try {
      const r = cli(dir, 'savepoint');
      assert.equal(r.code, 2, 'today, a freshly installed target with nothing yet decided must exit 2 on savepoint');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');

      const coverage = (r.json.checks || []).filter((c) => c.domain === 'coverage');
      const cannotDetermine = coverage.filter((c) => c.outcome === 'CANNOT_DETERMINE').map((c) => c.check).sort();
      assert.deepEqual(cannotDetermine, ['codeTruth:config', 'reconcile', 'removals:registry', 'routes:config'].sort(),
        "the four coverage rows a fresh install leaves undecided — see this section's header comment for "
        + 'the one place this differs from the task brief (removals:registry, not removals:config)');

      // requirements is the fifth coverage row and it is NOT one of the four above: a fresh install has
      // no docs/derived/state/requirements.json at all, which reports NOT_APPLICABLE, not undecided.
      const requirementsRow = coverage.find((c) => c.check === 'requirements');
      assert.ok(requirementsRow, 'a requirements coverage row must still be present, even as NOT_APPLICABLE');
      assert.equal(requirementsRow.outcome, 'NOT_APPLICABLE');

      assert.deepEqual([...r.json.unresolved].sort(), ['codeTruth', 'qualityGate', 'reconcile', 'removals', 'routes'],
        'qualityGate has no coverage-domain check of its own (gate.js owns that contract, not the savepoint '
        + 'coverage survey) but it must still be named among the unresolved optional contracts');
    } finally { rm(dir); }
  });

  test('doctor exits 2 with onboarding INCOMPLETE and exactly five UNDECIDED rows on a freshly installed target', () => {
    const dir = installedDayOneFixture();
    try {
      const r = cli(dir, 'doctor');
      assert.equal(r.code, 2, 'today, a freshly installed target with nothing yet decided must exit 2 on doctor');
      assert.equal(onboardingRow(r).label, 'INCOMPLETE');

      const undecided = (r.json.rows || []).filter((row) => row.label === 'UNDECIDED').map((row) => row.check).sort();
      assert.deepEqual(undecided, [
        'onboarding:codeTruth', 'onboarding:qualityGate', 'onboarding:reconcile', 'onboarding:removals', 'onboarding:routes',
      ].sort(), 'the five UNDECIDED onboarding rows a fresh install leaves for the founder to answer');
    } finally { rm(dir); }
  });

  test('gate exits 2 NOT_CONFIGURED on a freshly installed target', () => {
    const dir = installedDayOneFixture();
    try {
      const r = cli(dir, 'gate');
      assert.equal(r.code, 2,
        'today, a freshly installed target with no recognized build system and no declared opt-out must exit 2 on gate');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.json.label, 'NOT_CONFIGURED', 'K-09: the shared outcome carries the exit code, the gate\'s own word carries the diagnosis');
    } finally { rm(dir); }
  });
});

// --- P3-K-10 · the day-one coverage rows relax behind the declared posture key -----------------------
//
// ⛔ WHAT THESE PROVE, AND WHAT THEY REFUSE TO PROVE. ADR-003's rule table says which kernel rows a
// posture may relax and to what; this section is that table made executable. Two mechanisms, and
// NEITHER changes what an outcome means (anti-drift item 3): a relaxed R1/R2/R5 row keeps its state and
// its reason and merely stops refusing, and R3/R4 become NOT_APPLICABLE only where the absence needs no
// inference. Everything else in the four-outcome contract is exactly where it was.
//
// ⛔ THREE STATES PER SUBSYSTEM, BECAUSE TWO WOULD PASS VACUOUSLY. "Light relaxes it" is only half a
// claim: a wiring that relaxed EVERYTHING would satisfy it. So each relaxable contract is exercised
// undecided (advisory under light and standard), INVALID (refused in every profile — somebody answered
// and got it wrong, and no posture answers for that), and CONFIGURED (enforced in every profile, and
// never wearing a postureRelaxed tag it did not earn).

/** A config declaring one posture, over whatever else the case needs. */
const postured = (profile, over = {}) => ({ posture: { profile }, ...over });
const relaxedNames = (r) => (r.json.checks || []).filter((c) => c.postureRelaxed).map((c) => c.check).sort();
const rowFor = (r, subsystem) => (r.json.applicability || []).find((x) => x.subsystem === subsystem);
const checkFor = (r, name) => (r.json.checks || []).find((c) => c.check === name);

/** A registry the killed-feature contract would really enforce, and one it cannot. */
const registryAt = (dir, doc) => {
  fs.mkdirSync(path.join(dir, stateLib.STATE_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, stateLib.STATE_DIR, 'removals.json'), JSON.stringify(doc, null, 2));
};

/*
 * The five relaxable contracts, each in the three states, declared once so no case is exercised in two
 * of them and none in the third. `enforced` is what a CONFIGURED row must still produce in EVERY
 * profile — a real verdict of its own, never a posture-relaxed one.
 */
const RELAXABLE = [
  {
    subsystem: 'removals', check: 'removals:config',
    invalid: { state: { removals: { notApplicable: true } } },
    configured: { state: { removals: { liveContentDirs: ['docs'], registry: 'docs/derived/state/removals.json' } } },
    seed: (dir) => { fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docs', 'PRODUCT.md'), '# Product\n\nNothing retired here.\n'); registryAt(dir, GAUNTLET_ROW); },
  },
  {
    subsystem: 'reconcile', check: 'reconcile',
    invalid: { state: { reconcile: { notApplicable: true } } },
    configured: { state: { reconcile: { tasks: { kind: 'json', path: 'tasks.json', pointer: 'tasks' }, project: { kind: 'json', path: 'gaps.json', pointer: 'gaps' } } } },
    seed: (dir) => {
      fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ tasks: [] }, null, 2));
      fs.writeFileSync(path.join(dir, 'gaps.json'), JSON.stringify({ gaps: [] }, null, 2));
    },
  },
  { subsystem: 'routes', check: 'routes:config', invalid: { routeSource: { notApplicable: true } }, configured: { routeSource: 'app/**/page.tsx' } },
  { subsystem: 'codeTruth', check: 'codeTruth:config', invalid: { codeTruth: '' }, configured: { codeTruth: 'src/tokens.ts' } },
  // qualityGate is the row with no coverage check of its own by design (gate.js owns that contract), so
  // its three states are read off the survey row and doctor's onboarding row rather than off savepoint.
  { subsystem: 'qualityGate', check: null, invalid: { qualityGate: { notApplicable: true } }, configured: { qualityGate: { checks: [{ name: 'lint', run: 'true' }] } } },
];

describe('P3-K-10 · the day-one coverage rows relax behind the declared posture, and only those', () => {
  test('the bare fixture reaches savepoint exit 0 under a declared light, with every relaxed row still printed', () => {
    const p = bareProject(postured('light'));
    try {
      const r = cli(p.dir, 'savepoint');
      assert.equal(r.code, 0, 'a declared `light` posture must drop the day-one refusal to exit 0 — this is the whole task');
      assert.equal(r.json.outcome, 'PASS');
      assert.equal(r.json.verdicts.coverage, 'PASS');
      assert.equal(r.json.verdicts.integrity, 'PASS', 'the machinery half must be untouched by a posture');

      // ⛔ RELAXED IS NOT HIDDEN. Every row a strict run would have printed is still here.
      assert.deepEqual(relaxedNames(r), ['codeTruth:config', 'reconcile', 'removals:config', 'routes:config'],
        'the four rows a fresh project cannot answer on day one must each still appear, each naming the posture that relaxed it');
      for (const c of coverageOf(r).filter((x) => x.postureRelaxed)) {
        assert.equal(c.postureRelaxed, 'light', `${c.check} did not record WHICH posture relaxed it`);
        assert.match(c.postureRule, /^kernel:R[1-4]$/, `${c.check} did not record which ADR-003 row it read`);
      }
      // R1/R2 are mechanism (a): a visible PASS over one inspected declaration, never a zero-subject one.
      for (const name of ['routes:config', 'codeTruth:config']) {
        assert.equal(checkFor(r, name).outcome, 'PASS');
        assert.equal(checkFor(r, name).checked, 1, `${name} relaxed to a PASS that admits it examined nothing`);
      }
      // R3/R4 are mechanism (b): NOT_APPLICABLE, with a reason that names the posture out loud.
      for (const name of ['removals:config', 'reconcile']) {
        assert.equal(checkFor(r, name).outcome, 'NOT_APPLICABLE');
        assert.match(checkFor(r, name).detail, /declared `light` posture/, `${name} went not-applicable without an authored reason naming the posture`);
      }
      assert.deepEqual([...r.json.unresolved].sort(), [], 'a posture that answered every open contract must say so');
      assert.equal(r.json.onboardingComplete, true);
    } finally { rm(p.dir); }
  });

  test('doctor reaches exit 0 under light with onboarding COMPLETE, and prints every relaxed row anyway', () => {
    const p = bareProject(postured('light'));
    try {
      const d = cli(p.dir, 'doctor');
      assert.equal(d.code, 0, 'doctor must reach exit 0 under a declared light — through the row outcomes, never through a private green list');
      assert.equal(onboardingRow(d).label, 'COMPLETE');
      const rows = (d.json.rows || []).filter((x) => x.check.startsWith('onboarding:'));
      assert.deepEqual(rows.map((x) => x.check).sort(),
        ['onboarding:codeTruth', 'onboarding:qualityGate', 'onboarding:reconcile', 'onboarding:removals', 'onboarding:routes'],
        'a relaxed contract that stops printing its row is a contract the founder can no longer see');
      for (const row of rows) {
        assert.ok(['NOT_CONFIGURED', 'NOT_APPLICABLE'].includes(row.label), `${row.check} reported ${row.label}`);
        assert.match(row.detail, /`light` posture/, `${row.check} did not say which posture answered it`);
      }
      assert.equal((d.json.rows || []).find((x) => x.check === 'posture').label, 'CONFIGURED');
    } finally { rm(p.dir); }
  });

  test('standard relaxes the same four rows, and strict reproduces today exactly', () => {
    const light = bareProject(postured('light'));
    const standard = bareProject(postured('standard'));
    const strict = bareProject(postured('strict'));
    try {
      const s = cli(standard.dir, 'savepoint');
      assert.equal(s.code, 0, 'ADR-003 gives standard `advise` on R1-R6, so day one is exit 0 with visible rows there too');
      assert.deepEqual(relaxedNames(s), ['codeTruth:config', 'reconcile', 'removals:config', 'routes:config']);
      // ⛔ THE DISCRIMINATION. light and standard must not be the same wiring wearing two names: under
      // standard R3/R4 stay UNDECIDED and merely advise, where light answers them NOT_APPLICABLE.
      for (const name of ['removals:config', 'reconcile']) {
        assert.equal(checkFor(s, name).outcome, 'PASS', `${name} under standard must advise, not be declared not applicable`);
        assert.equal(checkFor(s, name).checked, 1);
        assert.equal(checkFor(cli(light.dir, 'savepoint'), name).outcome, 'NOT_APPLICABLE',
          `${name} answered the same under light and standard — a cell that cannot discriminate is a cell nobody is reading`);
      }

      const t = cli(strict.dir, 'savepoint');
      assert.equal(t.code, 2, 'strict is defined as exactly what 0.3.0 does');
      assert.deepEqual(relaxedNames(t), [], 'strict relaxed something');
      assert.deepEqual([...t.json.unresolved].sort(), ['codeTruth', 'qualityGate', 'reconcile', 'removals', 'routes']);
    } finally { rm(light.dir); rm(standard.dir); rm(strict.dir); }
  });

  test('⛔ R3 is mandatory in every profile once a removals.json with rows exists', () => {
    const p = bareProject(postured('light'));
    try {
      registryAt(p.dir, GAUNTLET_ROW);
      const r = cli(p.dir, 'savepoint');
      /*
       * Observed on this tree, and it differs from the task brief in one place worth naming: the brief
       * says "still exits 2", and removals.js answers rows-recorded-and-nothing-enforcing-them with FAIL
       * at exit 1 — a determined breach rather than an undetermined check. Either way it is non-zero and
       * unrelaxed, which is the claim; the code asserted is the one this tree actually produces.
       */
      assert.equal(r.code, 1, 'a registry with rows and no liveContentDirs must stay non-zero under light');
      assert.equal(r.json.outcome, 'FAIL');
      assert.ok(!relaxedNames(r).includes('removals:config'), 'the killed-feature contract was relaxed while it had rows to enforce');
      assert.ok(!checkFor(r, 'removals:config').postureRelaxed);
      assert.deepEqual([...r.json.unresolved].sort(), ['removals'], 'the one contract no posture may answer must stay named');
    } finally { rm(p.dir); }
  });

  test('⛔ a present-but-EMPTY removals.json is refused under light too — "the registry is empty" is not "there is no registry"', () => {
    const p = bareProject(postured('light'));
    try {
      registryAt(p.dir, { schemaVersion: '1.0.0', removals: [] });
      const r = cli(p.dir, 'savepoint');
      assert.equal(r.code, 2, 'light may answer R3 only where the absence is inference-free, and a file that exists is not an absence');
      assert.equal(checkFor(r, 'removals:config').outcome, 'CANNOT_DETERMINE');
      assert.ok(!checkFor(r, 'removals:config').postureRelaxed);
    } finally { rm(p.dir); }
  });

  test('⛔ a CONFIGURED removal contract with no liveContentDirs is never relaxed either (anti-drift item 14)', () => {
    // The other half of item 14's sentence: an unconfigured contract may become advisory, a CONFIGURED
    // one that scanned nothing never PASSes. Registry configured, nothing recorded in it, under light.
    const p = bareProject(postured('light', { state: { removals: { liveContentDirs: ['docs'], registry: 'docs/derived/state/removals.json' } } }));
    try {
      fs.mkdirSync(path.join(p.dir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'docs', 'PRODUCT.md'), '# Product\n');
      const r = cli(p.dir, 'savepoint');
      assert.equal(r.code, 2, 'a configured scan over an empty registry passed under light — that is the empty-validator shape');
      assert.equal(checkFor(r, 'removals:registry').outcome, 'CANNOT_DETERMINE');
      assert.ok(!checkFor(r, 'removals:registry').postureRelaxed);
    } finally { rm(p.dir); }
  });

  test("⛔ an installer's `<set ROUTE_SOURCE>` stays INVALID and non-zero under light, standard and strict alike", () => {
    for (const profile of ['light', 'standard', 'strict']) {
      const p = bareProject(postured(profile, { routeSource: '<set ROUTE_SOURCE>' }));
      try {
        const r = cli(p.dir, 'savepoint');
        assert.equal(r.code, 2, `${profile} accepted a leftover installer template as an answer`);
        assert.equal(rowFor(r, 'routes').state, 'INVALID', `${profile} reported the template as UNDECIDED, and a posture answers only for UNDECIDED`);
        assert.equal(rowFor(r, 'routes').basis, 'template');
        assert.ok(!checkFor(r, 'routes:config').postureRelaxed, `${profile} relaxed an INVALID declaration`);
        assert.ok(r.json.unresolved.includes('routes'), `${profile} stopped naming the invalid row as unresolved`);
        if (profile !== 'strict') {
          assert.deepEqual([...r.json.unresolved].sort(), ['routes'],
            `${profile} relaxed every OTHER row and still refused — the template must be the one thing outstanding`);
        }
      } finally { rm(p.dir); }
    }
  });

  test('three states · UNDECIDED is advisory under light AND standard, for every relaxable contract', () => {
    for (const profile of ['light', 'standard']) {
      const p = bareProject(postured(profile));
      try {
        const r = cli(p.dir, 'savepoint');
        assert.equal(r.code, 0, `${profile}: an undecided day-one project must not refuse`);
        for (const c of RELAXABLE) {
          const row = rowFor(r, c.subsystem);
          assert.ok(row, `${profile}: the ${c.subsystem} row stopped being surveyed — relaxing is not deleting`);
          assert.equal(row.postureRelaxed, profile, `${profile}: the ${c.subsystem} row was not relaxed`);
          if (c.check) assert.ok(['PASS', 'NOT_APPLICABLE'].includes(checkFor(r, c.check).outcome));
        }
      } finally { rm(p.dir); }
    }
  });

  test('three states · INVALID is refused in EVERY profile — a posture answers for silence, never for a wrong answer', () => {
    for (const c of RELAXABLE) {
      for (const profile of ['light', 'standard', 'strict']) {
        const p = bareProject(postured(profile, c.invalid));
        try {
          const r = cli(p.dir, 'savepoint');
          const row = rowFor(r, c.subsystem);
          assert.equal(row.state, 'INVALID', `${profile}/${c.subsystem}: a malformed declaration was not classified INVALID`);
          assert.ok(!row.postureRelaxed, `${profile}/${c.subsystem}: an INVALID declaration was relaxed by a posture`);
          assert.ok(r.json.unresolved.includes(c.subsystem), `${profile}/${c.subsystem}: the invalid contract was not named as unresolved`);
          assert.equal(r.json.onboardingComplete, false, `${profile}/${c.subsystem}: onboarding read as finished with an INVALID contract in it`);
          /*
           * ⛔ DOCTOR IS THE SURFACE THAT COVERS ALL FIVE. `qualityGate` deliberately has no
           * `domain: 'coverage'` row in savepoint — gate.js owns that contract and a savepoint row could
           * only report "a checks array exists" — so savepoint already exits 0 on a fixture whose ONLY
           * defect is an invalid qualityGate, today and before this task. That is unchanged here; the
           * refusal it is checked against is doctor's, which reads every row.
           */
          assert.notEqual(cli(p.dir, 'doctor').code, 0, `${profile}/${c.subsystem}: an INVALID declaration reached exit 0 on doctor`);
          if (c.check) assert.notEqual(r.code, 0, `${profile}/${c.subsystem}: an INVALID declaration reached exit 0 on savepoint`);
        } finally { rm(p.dir); }
      }
    }
  });

  test('three states · a CONFIGURED contract is enforced in every profile and never wears a postureRelaxed tag', () => {
    for (const c of RELAXABLE) {
      for (const profile of ['light', 'standard', 'strict']) {
        const p = bareProject(postured(profile, c.configured));
        try {
          if (c.seed) c.seed(p.dir);
          const r = cli(p.dir, 'savepoint');
          const row = rowFor(r, c.subsystem);
          assert.equal(row.state, 'CONFIGURED', `${profile}/${c.subsystem}: a real declaration stopped reading as configured`);
          assert.ok(!row.postureRelaxed, `${profile}/${c.subsystem}: a configured contract was tagged as relaxed by a posture`);
          if (!c.check) continue;
          /*
           * A configured contract stops producing a `<subsystem>:config` row and starts producing its
           * OWN — `removals:D-075`, the reconciliation's verdict — so the claim is over the prefix: the
           * subsystem still reports, and no row of its own is wearing a posture's tag.
           */
          const own = (r.json.checks || []).filter((x) => x.check === c.subsystem || x.check.startsWith(`${c.subsystem}:`));
          assert.ok(own.length, `${profile}/${c.subsystem}: a configured contract produced no check of its own at all`);
          assert.deepEqual(own.filter((x) => x.postureRelaxed), [],
            `${profile}/${c.subsystem}: a configured contract's own check claimed a relaxation it did not need`);
        } finally { rm(p.dir); }
      }
    }
  });

  test('⛔ a configured removal contract still FAILS on a reintroduced killed feature under light', () => {
    // The sharpest form of "configured is enforced in every profile": the contract does not merely stay
    // configured, it still catches the thing it exists to catch, at the same exit code, under the
    // loosest posture the pack offers.
    const p = bareProject(postured('light', { state: { removals: { liveContentDirs: ['docs'], registry: 'docs/derived/state/removals.json' } } }));
    try {
      fs.mkdirSync(path.join(p.dir, 'docs'), { recursive: true });
      registryAt(p.dir, GAUNTLET_ROW);
      fs.writeFileSync(path.join(p.dir, 'docs', 'PRODUCT.md'), '# Product\n\nThe launch roster ships four magic gauntlets.\n');
      const r = cli(p.dir, 'removals');
      assert.equal(r.json.outcome, 'FAIL', 'a killed feature was reintroduced and light let it through');
      assert.equal(r.code, 1);
    } finally { rm(p.dir); }
  });

  test('⛔ postureRelaxed appears ONLY on a row a posture actually relaxed, and detail still carries the original reason', () => {
    const p = bareProject(postured('light', { routeSource: 'app/**/page.tsx' }));
    try {
      const r = cli(p.dir, 'savepoint');
      // routes is configured here, so it must be the one coverage row with no tag.
      assert.ok(!checkFor(r, 'routes:config').postureRelaxed, 'a configured row was tagged relaxed');
      assert.deepEqual(relaxedNames(r), ['codeTruth:config', 'reconcile', 'removals:config']);

      // ⛔ AND THE REASON SURVIVES THE RELAXATION. A row that passes without saying what it could not
      // determine is a row that stopped reporting, which is not what a profile was allowed to buy.
      const strictRun = cli(bareProject().dir, 'savepoint');
      const original = checkFor(strictRun, 'codeTruth:config').detail;
      const relaxedDetail = checkFor(r, 'codeTruth:config').detail;
      const reason = original.split('. ')[0];
      assert.ok(relaxedDetail.includes(reason),
        `the relaxed row dropped its original reason.\n  original: ${original}\n  relaxed:  ${relaxedDetail}`);
      assert.match(relaxedDetail, /reported rather than refused/);
    } finally { rm(p.dir); }
  });

  test('⛔ DEFAULTED, UNREADABLE and INVALID postures all relax nothing — only a DECLARED light or standard does', () => {
    const cases = [
      ['DEFAULTED (a config with no posture key)', () => bareProject({})],
      ['INVALID (unknown profile)', () => bareProject(postured('loose'))],
      ['INVALID (override on a fixed id)', () => bareProject({ posture: { profile: 'light', overrides: { 'kernel:R21': { verdict: 'off', reason: 'no' } } } })],
      ['INVALID (override with no reason)', () => bareProject({ posture: { profile: 'light', overrides: { 'kernel:R1': { verdict: 'off' } } } })],
    ];
    for (const [label, make] of cases) {
      const p = make();
      try {
        const r = cli(p.dir, 'savepoint');
        assert.equal(r.code, 2, `${label}: relaxed the day-one rows`);
        assert.deepEqual(relaxedNames(r), [], `${label}: something was relaxed by a posture nobody validly declared`);
      } finally { rm(p.dir); }
    }
    // UNREADABLE is its own fixture: the config exists and cannot be parsed at all.
    const broken = bareProject({});
    try {
      fs.writeFileSync(path.join(broken.dir, 'respawnpack.config.json'), '{ this is not json');
      const r = cli(broken.dir, 'savepoint');
      assert.equal(r.code, 2, 'an unreadable config became the loosest policy — "could not read it" must never mean light');
      assert.deepEqual(relaxedNames(r), []);
    } finally { rm(broken.dir); }
  });

  test('⛔ the resolver is never asked about a fixed id — the kernel row table and _posture.FIXED_IDS are disjoint', () => {
    const req = createRequire(import.meta.url);
    const applicability = req('./lib/applicability.js');
    const posture = req(path.join(path.dirname(KERNEL), 'hooks', '_posture.js'));
    const asked = [...Object.values(applicability.POSTURE_ROWS), applicability.POSTURE_ONBOARDING];
    const fixed = asked.filter((id) => posture.FIXED_IDS.includes(id));
    assert.deepEqual(fixed, [],
      `the kernel asks the resolver about ${fixed.join(', ')}, which the anti-drift core fixes in every posture. `
      + 'A rule with no key cannot be reached by an override; asking about one is how that guarantee is lost.');
    // Both directions: every id the kernel asks about must be one the resolver actually carries, or the
    // consult answers `deny` forever and the relaxation is wired to nothing.
    const missing = asked.filter((id) => !Object.prototype.hasOwnProperty.call(posture.RESOLVER, id));
    assert.deepEqual(missing, [], `the kernel asks about ${missing.join(', ')}, which hooks/_posture.js's RESOLVER does not carry`);
  });

  test('⛔ an installed target with NO posture reader beside the kernel behaves exactly as today', () => {
    /*
     * The migration case that has no config to declare it: a target installed before ADR-003 has no
     * `hooks/_posture.js` at all. `modhealth.probePath` reports it, `postureLib` is null, and every
     * relaxation must be unavailable rather than defaulted. Run from a COPY of both trees with that one
     * file deleted, because "the reader is absent" is not the same input as "the reader said strict".
     */
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-noposture-'));
    const p = bareProject(postured('light'));
    try {
      fs.cpSync(KERNEL, path.join(tree, 'kernel'), { recursive: true });
      fs.cpSync(path.join(path.dirname(KERNEL), 'hooks'), path.join(tree, 'hooks'), { recursive: true });
      fs.rmSync(path.join(tree, 'hooks', '_posture.js'));
      const run = spawnSync(process.execPath, [path.join(tree, 'kernel', 'respawnpack.js'), 'savepoint', '--dir', p.dir, '--json'], { encoding: 'utf8' });
      let json = null; try { json = JSON.parse(run.stdout); } catch { /* left null */ }
      assert.ok(json, `the kernel must still RUN with no posture reader beside it, not die: ${run.stderr.slice(0, 600)}`);
      assert.equal(run.status, 2, 'a declared light with no reader to read it must behave as strict, which is exit 2 here');
      assert.deepEqual((json.checks || []).filter((c) => c.postureRelaxed), [],
        'a relaxation happened with no posture reader installed — the kernel is deciding a policy it cannot read');
    } finally { rm(tree); rm(p.dir); }
  });

  /*
   * ⛔ THE TWIN OF THE FREEZE TEST, ON THE ROW SET RATHER THAN ON THE BYTES. install/install.test.mjs
   * pins what install.js WRITES for a target with no posture key; P3-N-2's twin above pins the exit
   * codes an installed target then produces. This pins the third thing P3-K-10 could have moved without
   * either of those noticing: the savepoint check rows themselves, on the bare day-one fixture, with no
   * posture key present. Every field below was captured from the tree at the base commit BEFORE this
   * task's first edit and compared after — the exit codes and rows were identical, and this is that
   * comparison kept as a test rather than as a note.
   */
  test('P3-K-10 twin · with no posture key, the bare day-one savepoint rows are exactly what the base commit produced', () => {
    const p = bareProject(); // no respawnpack.config.json at all — nothing to declare a posture in
    try {
      const r = cli(p.dir, 'savepoint');
      assert.equal(r.code, 2);
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.deepEqual(r.json.verdicts, { integrity: 'PASS', coverage: 'CANNOT_DETERMINE' });
      const rows = (r.json.checks || [])
        .map((c) => `${c.check}|${c.outcome}|${String(c.checked)}|${String(c.domain ?? null)}`).sort();
      assert.deepEqual(rows, [
        'codeTruth:config|CANNOT_DETERMINE|0|coverage',
        /*
         * ⭐ P2-P-1 · THE ONE ROW ADDED SINCE THIS CAPTURE, AND THE PROOF THAT IT MOVES NOTHING. The
         * tenth stage emits a NOT_APPLICABLE row on a project that declares no provenance, which is the
         * rank that never makes an aggregate worse — so the exit code, the two verdicts, the unresolved
         * list and `onboardingComplete` asserted around it are all still the base commit's values. That
         * is exactly what owner decision 22 required of a new contract landing on live targets, and it
         * is checked here rather than claimed.
         */
        'lineage:declaration|NOT_APPLICABLE|null|null',
        'reconcile|CANNOT_DETERMINE|0|coverage',
        'removals:config|CANNOT_DETERMINE|0|coverage',
        'render:docs/derived/CONTINUITY.md|NOT_APPLICABLE|null|null',
        'render:docs/derived/GAPS.md|NOT_APPLICABLE|null|null',
        'render:docs/derived/LESSONS.md|NOT_APPLICABLE|null|null',
        'requirements|NOT_APPLICABLE|null|coverage',
        'routes:config|CANNOT_DETERMINE|0|coverage',
        'state-writeback|PASS|1|null',
      ].sort(), 'the day-one row set moved for a project that declared no posture — that is the one thing Phase 3 promised could not happen');
      assert.deepEqual((r.json.checks || []).filter((c) => c.postureRelaxed), [],
        'a project with no posture key carried a postureRelaxed row');
      assert.deepEqual([...r.json.unresolved].sort(), ['codeTruth', 'qualityGate', 'reconcile', 'removals', 'routes']);
      assert.equal(r.json.onboardingComplete, false);
    } finally { rm(p.dir); }
  });
});

// --- P3-K-07b · the kernel resolver table, the no-key-for-a-fixed-id fence, and the exit map ---------
//
// ⛔ WHAT P3-K-10 LEFT, AND WHY IT WAS LEFT. K-10 relaxed the six rows the applicability survey owns
// (ADR-003 `kernel:R1`–`R6`) and deliberately stopped there, because the remaining four relaxable kernel
// rows are not coverage rows and pretending otherwise would have put one fact under two authorities:
//
//   R9   the gate's "no recognized build system found" verdict          kernel/lib/gate.js
//   R15  the `note:budget:<file>` row                                   render.noteBudgetCheck, pushed by savepoint
//   R16  a hand-authored derived doc not yet migrated, verify-only      savepoint's render loop
//   R17  a `--candidate` klass outside the four                         savepoint's operator-error rows
//
// This section is ADR-003's table for those four, made executable, plus the three fences the task is
// actually FOR: the resolver is asked about exactly the relaxable ids and never about a fixed one, the
// resolver has no key for a fixed id in either direction, and outcome-to-exit is unchanged on every
// verb in every profile.
//
// ⛔ THREE STATES PER ROW, PLUS A NEIGHBOUR. "Light relaxes it" is half a claim — a wiring that relaxed
// everything would satisfy it — so each row is exercised under light, under standard, under strict, and
// beside the nearest refusal that must NOT move: R9 beside a detected-but-unconfigured stack and beside
// a partial gate (`kernel:R10`, fixed), R17 beside the three operator errors that are not R17.

/** Every NUMBERED ADR-003 kernel row this kernel may ask the resolver about. Ten, and no eleventh. */
const RELAXABLE_KERNEL_IDS = [
  'kernel:R1', 'kernel:R2', 'kernel:R3', 'kernel:R4', 'kernel:R5',
  'kernel:R6', 'kernel:R9', 'kernel:R15', 'kernel:R16', 'kernel:R17',
];

/*
 * ⛔ AND THE KERNEL ROWS THAT ARRIVED BY AMENDMENT, KEPT SEPARATE FROM THE NUMBERED TEN ON PURPOSE.
 *
 * ADR-003's rule table is carried VERBATIM from the reconciled specification and is not rewritten, so a
 * row added after the fact arrives as a dated amendment beneath it and is spelled with a WORD rather
 * than an `R<n>` — minting an `R29` would put a row in the verbatim table the specification never
 * carried. `kernel:readiness` (P2-Q-2) is the first. The two lists are kept apart because the fence
 * above derives the numbered set from source with a `kernel:R\d+` regex, which cannot see a word id: a
 * single merged list would have to loosen that regex, and a loosened regex is how `kernel:R21` becomes
 * askable. Every id here must still be in the resolver and out of `FIXED_IDS`, asserted below.
 */
const AMENDED_KERNEL_IDS = ['kernel:readiness'];

const postureLib = createRequire(import.meta.url)(path.join(path.dirname(KERNEL), 'hooks', '_posture.js'));

/** A fixture whose CONTINUITY.md is kernel-rendered and whose NOTE block is over budget (R15). */
function overBudgetNoteProject(config) {
  const p = bareProject(config);
  // Render once, so the doc carries a GENERATED block: an UNMIGRATED doc short-circuits the render loop
  // before the budget row is ever built, which is R16's branch and not this one.
  cli(p.dir, 'savepoint', '--write');
  const doc = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const text = fs.readFileSync(doc, 'utf8');
  fs.writeFileSync(doc, text.replace(
    new RegExp(`${esc(render.NOTE_OPEN)}[\\s\\S]*?${esc(render.NOTE_CLOSE)}`),
    `${render.NOTE_OPEN}\n${'note text over the budget. '.repeat(220)}\n${render.NOTE_CLOSE}`));
  return p;
}

/** A fixture whose docs/derived/CONTINUITY.md is hand-authored and has never been migrated (R16). */
function unmigratedDocProject(config) {
  const p = bareProject(config);
  fs.mkdirSync(path.join(p.dir, 'docs', 'derived'), { recursive: true });
  fs.writeFileSync(path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md'),
    '# Continuity\n\nProse a human wrote before this kernel existed.\n');
  return p;
}

describe('P3-K-07b · kernel:R9 — the gate with no build system, relaxed only where the absence is a fact', () => {
  test('light · NOT_APPLICABLE at exit 0, with the empty search still reported and the posture named', () => {
    const p = bareProject(postured('light'));
    try {
      const r = cli(p.dir, 'gate');
      assert.equal(r.code, 0, 'a declared `light` posture must drop the no-build-system refusal to exit 0');
      assert.equal(r.json.outcome, 'NOT_APPLICABLE');
      assert.equal(r.json.label, 'NOT_APPLICABLE');
      assert.equal(r.json.postureRelaxed, 'light', 'the relaxed verdict did not record WHICH posture answered it');
      assert.equal(r.json.postureRule, 'kernel:R9', 'the relaxed verdict did not record which ADR-003 row it read');
      /*
       * ⛔ RELAXED IS NOT HIDDEN, AND IT IS NOT PASS. The original reason is still the first thing in
       * `why`, and the outcome is NOT_APPLICABLE rather than PASS because this branch ran zero commands
       * — a gate reporting green having run nothing is the defect gate.js exists to end.
       */
      assert.match(r.json.why, /no recognized build system found/);
      assert.match(r.json.why, /declared `light` posture/);
      assert.equal(r.json.ran, 0, 'a relaxed gate must still admit it ran nothing');
    } finally { rm(p.dir); }
  });

  test('standard and strict · today\'s exit 2 NOT_CONFIGURED, byte-for-byte the same as no posture at all', () => {
    const base = bareProject({});
    let baseline;
    try { const r = cli(base.dir, 'gate'); baseline = { code: r.code, outcome: r.json.outcome, label: r.json.label, why: r.json.why }; }
    finally { rm(base.dir); }
    assert.deepEqual({ code: baseline.code, outcome: baseline.outcome, label: baseline.label },
      { code: 2, outcome: 'CANNOT_DETERMINE', label: 'NOT_CONFIGURED' });

    for (const profile of ['standard', 'strict']) {
      const p = bareProject(postured(profile));
      try {
        const r = cli(p.dir, 'gate');
        assert.deepEqual({ code: r.code, outcome: r.json.outcome, label: r.json.label, why: r.json.why }, baseline,
          `${profile} moved the gate's no-build-system verdict; ADR-003 reads \`deny\` in both columns`);
        assert.ok(!r.json.postureRelaxed, `${profile} tagged the verdict as posture-relaxed`);
      } finally { rm(p.dir); }
    }
  });

  test('⛔ neighbour · a DETECTED stack with nothing configured stays NOT_CONFIGURED under light', () => {
    // R9 is "found no build system". "Found one and it configured nothing" is a different branch, is
    // not in ADR-003's table at all, and is therefore fixed.
    const p = bareProject(postured('light'));
    try {
      fs.writeFileSync(path.join(p.dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2));
      const r = cli(p.dir, 'gate');
      assert.equal(r.code, 2, 'light relaxed a branch ADR-003 never gave it');
      assert.equal(r.json.label, 'NOT_CONFIGURED');
      assert.ok(!r.json.postureRelaxed);
    } finally { rm(p.dir); }
  });

  test('⛔ neighbour · a PARTIAL gate (kernel:R10, fixed in every posture) stays NOT_CONFIGURED under light', () => {
    /*
     * The sharpest neighbour: a configured check that could not START. ADR-003 fixes `kernel:R10` —
     * `hooks/_posture.js` has NO KEY for it — and the reason is that discarding the passes is the whole
     * point: a gate that could not execute has not established that anything is green.
     */
    const p = bareProject(postured('light', {
      qualityGate: { checks: [{ name: 'lint', command: 'rp-p3k07b-not-a-real-binary', args: [] }] },
    }));
    try {
      const r = cli(p.dir, 'gate');
      assert.equal(r.code, 2, 'light turned a gate that could not run into something green');
      assert.equal(r.json.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.json.label, 'NOT_CONFIGURED');
      assert.ok(!r.json.postureRelaxed, 'a fixed row was tagged as posture-relaxed');
    } finally { rm(p.dir); }
  });

  test('⛔ a broken applicability.js makes the relaxation unavailable, and does not stop `gate` running', () => {
    /*
     * `applicability.relaxes()` is the one definition of which resolutions and which verdicts relax, so
     * `gate` reaches for it — a module it otherwise never uses. Reaching for it must not make the verb
     * refuse when that module will not load: the consult is fail-closed, the same way a damaged posture
     * reader already is, so the relaxation becomes UNAVAILABLE rather than assumed and the gate answers
     * its own question exactly as a `strict` run would. `doctor` is the verb that says the subsystem is
     * broken; `gate` is not, and it did not report on this module before either.
     */
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-noapplicability-'));
    const p = bareProject(postured('light'));
    try {
      fs.cpSync(KERNEL, path.join(tree, 'kernel'), { recursive: true });
      fs.cpSync(path.join(path.dirname(KERNEL), 'hooks'), path.join(tree, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'kernel', 'lib', 'applicability.js'), 'this is not javascript(((\n');
      const run = spawnSync(process.execPath,
        [path.join(tree, 'kernel', 'respawnpack.js'), 'gate', '--dir', p.dir, '--json'], { encoding: 'utf8' });
      let json = null; try { json = JSON.parse(run.stdout); } catch { /* left null */ }
      assert.ok(json, `\`gate\` must still RUN with a broken applicability.js, not die: ${run.stderr.slice(0, 600)}`);
      assert.equal(run.status, 2, 'a relaxation that could not be decided was granted, or the verb refused outright');
      assert.equal(json.label, 'NOT_CONFIGURED');
      assert.ok(!json.postureRelaxed);
    } finally { rm(tree); rm(p.dir); }
  });

  test('⛔ a gate that really ran is untouched by the posture, in both directions', () => {
    // A real PASS stays PASS with no relaxation tag, and a real FAIL stays FAIL at exit 1 under light.
    const cases = [
      ['PASS', ['-e', ''], 0, 'PASS'],
      ['FAIL', ['-e', 'process.exit(3)'], 1, 'FAIL'],
    ];
    for (const [label, args, code, outcome] of cases) {
      const p = bareProject(postured('light', {
        qualityGate: { checks: [{ name: 'test', command: process.execPath, args }] },
      }));
      try {
        const r = cli(p.dir, 'gate');
        assert.equal(r.code, code, `light moved a gate that really ran (${label})`);
        assert.equal(r.json.outcome, outcome);
        assert.ok(!r.json.postureRelaxed, `a gate that ran ${label} was tagged posture-relaxed`);
      } finally { rm(p.dir); }
    }
  });
});

describe('P3-K-07b · kernel:R15 — the NOTE budget, and the qualifier that is part of its cell', () => {
  /*
   * ADR-003's cell: light `advise`, standard "advise on --verify", strict `deny`. The qualifier is the
   * decision, not a gloss: a WRITING savepoint under `standard` has already cut the note and archived
   * the full text, and reporting that as an advisory would report the cut as though it did not matter.
   */
  const NOTE_ROW = 'note:budget:docs/derived/CONTINUITY.md';
  const CASES = [
    ['light', '--verify', 0, 'PASS', 'light'],
    ['light', '--write', 0, 'PASS', 'light'],
    ['standard', '--verify', 0, 'PASS', 'standard'],
    ['standard', '--write', 1, 'FAIL', null],
    ['strict', '--verify', 1, 'FAIL', null],
    ['strict', '--write', 1, 'FAIL', null],
  ];
  for (const [profile, mode, code, outcome, relaxedBy] of CASES) {
    test(`three states · ${profile} ${mode} → exit ${code}, the row is ${outcome}`, () => {
      const p = overBudgetNoteProject(postured(profile));
      try {
        const r = cli(p.dir, 'savepoint', mode);
        const row = checkFor(r, NOTE_ROW);
        assert.ok(row, `the ${NOTE_ROW} row must still be printed — a relaxation hides nothing`);
        assert.equal(row.outcome, outcome, `${profile} ${mode}: ${row.detail}`);
        assert.equal(row.postureRelaxed ?? null, relaxedBy);
        if (relaxedBy) {
          assert.equal(row.postureRule, 'kernel:R15');
          assert.equal(row.checked, 1, 'the relaxed row must still name a real subject: the NOTE block it measured');
          assert.match(row.detail, /over the 1200-char budget/, 'the relaxed row dropped its original reason');
          assert.match(row.detail, /Reported rather than refused/);
        }
        assert.equal(r.code, code, `${profile} ${mode} exited ${r.code}`);
      } finally { rm(p.dir); }
    });
  }

  test('⛔ a note WITHIN budget is never tagged relaxed, in any profile', () => {
    for (const profile of ['light', 'standard', 'strict']) {
      const p = bareProject(postured(profile));
      try {
        cli(p.dir, 'savepoint', '--write');
        const r = cli(p.dir, 'savepoint', '--verify');
        const row = checkFor(r, NOTE_ROW);
        assert.ok(row && row.outcome === 'PASS', `${profile}: the within-budget row should be a plain PASS`);
        assert.ok(!row.postureRelaxed, `${profile}: a row that never refused was tagged as relaxed by a posture`);
      } finally { rm(p.dir); }
    }
  });
});

describe('P3-K-07b · kernel:R16 — an unmigrated derived doc, and the --write that is not touched', () => {
  const RENDER_ROW = 'render:docs/derived/CONTINUITY.md';
  const CASES = [['light', 0, 'PASS', 'light'], ['standard', 2, 'CANNOT_DETERMINE', null], ['strict', 2, 'CANNOT_DETERMINE', null]];
  for (const [profile, code, outcome, relaxedBy] of CASES) {
    test(`three states · ${profile} savepoint --verify → exit ${code}, the row is ${outcome}`, () => {
      const p = unmigratedDocProject(postured(profile));
      try {
        const r = cli(p.dir, 'savepoint', '--verify');
        const row = checkFor(r, RENDER_ROW);
        assert.ok(row, 'the unmigrated-doc row must still be printed');
        assert.equal(row.outcome, outcome, `${profile}: ${row.detail}`);
        assert.equal(row.postureRelaxed ?? null, relaxedBy);
        if (relaxedBy) {
          assert.equal(row.postureRule, 'kernel:R16');
          assert.equal(row.checked, 1);
          assert.match(row.detail, /hand-authored file not yet migrated/, 'the relaxed row dropped its original reason');
          assert.match(row.detail, /run with --write/, 'the relaxed row stopped naming the way out of the state it reports');
        }
        assert.equal(r.code, code);
      } finally { rm(p.dir); }
    });
  }

  test('⛔ --verify STILL modifies nothing under light — the posture relaxed the row, not the write', () => {
    /*
     * ADR-003's `light` cell reads "advise, and auto-migrate". The auto-migration already happens on
     * `--write`, in every posture. It is deliberately NOT extended to a verify-only run: `--verify`
     * never modifies the tree (anti-drift item 4), and a posture may only change which outcome a check
     * returns. This is that promise, measured on the bytes.
     */
    const p = unmigratedDocProject(postured('light'));
    try {
      const doc = path.join(p.dir, 'docs', 'derived', 'CONTINUITY.md');
      const before = fs.readFileSync(doc, 'utf8');
      const archiveDir = path.join(p.dir, 'docs', 'derived', '_archive');
      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 0);
      assert.equal(fs.readFileSync(doc, 'utf8'), before,
        'a relaxed verify-only run rewrote the hand-authored doc — a posture must never buy itself a write');
      assert.equal(fs.existsSync(archiveDir), false, 'a relaxed verify-only run archived something');
      assert.deepEqual(r.json.migrations.map((m) => m.applied), [false],
        'the migration must still be a PREVIEW on a verify-only run, in every posture');
    } finally { rm(p.dir); }
  });

  test('⛔ --write still migrates and says so, in every posture — the half of the cell that was already true', () => {
    for (const profile of ['light', 'standard', 'strict']) {
      const p = unmigratedDocProject(postured(profile));
      try {
        const r = cli(p.dir, 'savepoint', '--write');
        assert.deepEqual(r.json.migrations.map((m) => m.applied), [true], `${profile}: --write did not migrate`);
        assert.ok(fs.existsSync(path.join(p.dir, 'docs', 'derived', '_archive', 'CONTINUITY.pre-kernel.md')),
          `${profile}: the pre-kernel original was not archived verbatim`);
      } finally { rm(p.dir); }
    }
  });
});

describe('P3-K-07b · kernel:R17 — an unknown --candidate klass, and the three errors that are not it', () => {
  const CASES = [['light', 0, 'PASS', 'light'], ['standard', 0, 'PASS', 'standard'], ['strict', 1, 'FAIL', null]];
  for (const [profile, code, outcome, relaxedBy] of CASES) {
    test(`three states · ${profile} --candidate "reference:…" → exit ${code}, the row is ${outcome}`, () => {
      const p = bareProject(postured(profile, FULLY_DECIDED));
      try {
        const r = cli(p.dir, 'savepoint', '--candidate', 'reference:the changelog says so');
        const row = checkFor(r, 'memory-capture:operator');
        assert.ok(row, 'the operator row must still be printed — a rejected candidate is never silent');
        assert.equal(row.outcome, outcome, `${profile}: ${row.detail}`);
        assert.equal(row.postureRelaxed ?? null, relaxedBy);
        if (relaxedBy) {
          assert.equal(row.postureRule, 'kernel:R17');
          assert.equal(row.checked, 1, 'the relaxed row must still name a real subject: the argument it parsed');
          assert.match(row.detail, /is not one of finding, decision, constraint, root-cause-fix/,
            'the relaxed row dropped the four valid klasses, which is the whole discoverability fix I-7 landed');
        }
        assert.equal(r.code, code);
      } finally { rm(p.dir); }
    });
  }

  test('⛔ neighbours · the three operator errors that are NOT kernel:R17 stay FAIL under light', () => {
    // A malformed argument, an empty claim and a capture that failed are not "an operator guessed the
    // wrong word". They carry no rule id at all, so the resolver is never asked about them.
    for (const arg of ['nocolonhere', 'finding:', 'finding:   ']) {
      const p = bareProject(postured('light', FULLY_DECIDED));
      try {
        const r = cli(p.dir, 'savepoint', '--candidate', arg);
        const row = checkFor(r, 'memory-capture:operator');
        assert.ok(row, `--candidate ${JSON.stringify(arg)} produced no operator row at all`);
        assert.equal(row.outcome, 'FAIL', `light relaxed --candidate ${JSON.stringify(arg)}, which is not kernel:R17`);
        assert.ok(!row.postureRelaxed);
        assert.equal(r.code, 1);
      } finally { rm(p.dir); }
    }
  });

  test('⛔ a WELL-FORMED candidate is still captured under every posture — the relaxation buys no silence', () => {
    for (const profile of ['light', 'standard', 'strict']) {
      const p = bareProject(postured(profile, FULLY_DECIDED));
      try {
        const r = cli(p.dir, 'savepoint', '--candidate', 'finding:a real lead, correctly spelled');
        assert.ok(!checkFor(r, 'memory-capture:operator'), `${profile}: a valid candidate produced an operator error`);
        assert.ok((r.json.capturedCandidates || []).some((c) => c.klass === 'finding' && c.claim.startsWith('a real lead')),
          `${profile}: the valid candidate was not captured`);
      } finally { rm(p.dir); }
    }
  });
});

describe('P3-K-07b · the fences — no key for a fixed id, and nothing asked that is not relaxable', () => {
  const ROOT_DIR = path.dirname(KERNEL);
  /** Comments stripped first: an id named in prose is not a consult. */
  const codeOf = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const KERNEL_SOURCES = ['kernel/respawnpack.js',
    ...fs.readdirSync(path.join(ROOT_DIR, 'kernel', 'lib')).filter((f) => f.endsWith('.js')).map((f) => `kernel/lib/${f}`)];

  /** Every `kernel:R<n>` id this kernel names in EXECUTABLE code, derived rather than listed. */
  const askedIds = () => {
    const out = new Set();
    for (const rel of KERNEL_SOURCES) for (const m of codeOf(rel).matchAll(/'(kernel:R\d+)'/g)) out.add(m[1]);
    return [...out].sort();
  };

  test('⛔ the ids the kernel asks about are EXACTLY ADR-003\'s ten relaxable kernel rows, derived from source', () => {
    /*
     * ⛔ THE DELIVERABLE. A resolver that CAN be asked about `kernel:R21` is a resolver that will
     * eventually be asked, so the fence is on the asking side and it is derived: adding a consult of a
     * fixed id anywhere in kernel/ fails this without anyone remembering to update a list.
     */
    assert.deepEqual(askedIds(), [...RELAXABLE_KERNEL_IDS].sort(),
      'the set of ADR-003 kernel rows this kernel consults has changed. Ten rows are relaxable; every other '
      + 'kernel row is the anti-drift core or a build-time fence, and asking about one is how that guarantee is lost.');
  });

  test('⛔ nothing the kernel asks about is in _posture.FIXED_IDS, and the resolver carries every one', () => {
    const asked = askedIds();
    const fixed = asked.filter((id) => postureLib.FIXED_IDS.includes(id));
    assert.deepEqual(fixed, [], `the kernel asks the resolver about ${fixed.join(', ')}, which the anti-drift core fixes in every posture`);
    const missing = asked.filter((id) => !Object.prototype.hasOwnProperty.call(postureLib.RESOLVER, id));
    assert.deepEqual(missing, [], `the kernel asks about ${missing.join(', ')}, which hooks/_posture.js's RESOLVER does not carry`);
  });

  test('⛔ the resolver table has NO KEY for any fixed id — kernel rows and hook rows alike, both directions', () => {
    /*
     * ⛔ NO KEY IS STRONGER THAN "DEFAULTS TO deny". A rule with no key cannot be reached by an override
     * at all, so the refusal is UNAVAILABLE rather than merely discouraged (ADR-003, "The rows that are
     * fixed in every posture"). Both directions: a fixed id that gained a key fails, and a key that is
     * also declared fixed fails.
     */
    const keyed = postureLib.FIXED_IDS.filter((id) => Object.prototype.hasOwnProperty.call(postureLib.RESOLVER, id));
    assert.deepEqual(keyed, [], `hooks/_posture.js's RESOLVER carries a key for the FIXED id(s) ${keyed.join(', ')}`);

    // And the kernel half of it named on its own, because that is the half this task fences.
    const kernelFixed = postureLib.FIXED_IDS.filter((id) => id.startsWith('kernel:'));
    assert.equal(kernelFixed.length, 16, 'the anti-drift core names sixteen fixed KERNEL rows; the count moved');
    for (const id of kernelFixed) {
      assert.equal(Object.prototype.hasOwnProperty.call(postureLib.RESOLVER, id), false, `${id} is fixed and the resolver has a key for it`);
      assert.equal(RELAXABLE_KERNEL_IDS.includes(id), false, `${id} is fixed and this file lists it as relaxable`);
    }

    // Every kernel row the resolver DOES carry is one this kernel is allowed to ask about: the ten
    // numbered rows of ADR-003's verbatim table, plus every row a dated amendment added beneath it.
    const carried = Object.keys(postureLib.RESOLVER).filter((id) => id.startsWith('kernel:')).sort();
    assert.deepEqual(carried, [...RELAXABLE_KERNEL_IDS, ...AMENDED_KERNEL_IDS].sort(),
      'hooks/_posture.js carries a kernel row the kernel never consults, or is missing one it does');

    /*
     * ⛔ AN AMENDED ROW IS HELD TO EXACTLY THE SAME TWO RULES AS A NUMBERED ONE. A row that reached the
     * resolver without an ADR amendment, or that is also in the fixed set, is the drift the separate
     * list exists to make visible rather than to excuse.
     */
    const ADR = path.join(path.dirname(KERNEL), 'docs', 'hardening', 'ADR-003-posture-profiles.md');
    for (const id of AMENDED_KERNEL_IDS) {
      assert.equal(Object.prototype.hasOwnProperty.call(postureLib.RESOLVER, id), true, `${id} is listed as amended and the resolver does not carry it`);
      assert.equal(postureLib.FIXED_IDS.includes(id), false, `${id} is both switchable and fixed — one of the two lists is wrong`);
      assert.equal(RELAXABLE_KERNEL_IDS.includes(id), false, `${id} is in both kernel-row lists, so one of the two fences covers nothing`);
      if (!fs.existsSync(ADR)) continue; // the ADR is a development artifact, absent from the published package
      assert.match(fs.readFileSync(ADR, 'utf8'), new RegExp(`\\*\\*Amendment,[\\s\\S]{0,4000}\`${id}\``),
        `${id} is in the resolver with no dated amendment in ADR-003 that adds it. A row nobody recorded is a policy nobody reviewed.`);
    }
  });

  test('⛔ kernel:R15\'s narrowing in respawnpack.js and its qualifier in the resolver cannot drift apart', () => {
    // The code narrows `standard` to verify-only runs. The table records that narrowing as prose. If the
    // ADR cell is ever widened, this fails rather than leaving the code quietly stricter than the table.
    assert.match(postureLib.RESOLVER['kernel:R15'].qualifiers.standard, /--verify/,
      "ADR-003's kernel:R15 qualifier no longer narrows `standard` to --verify, and respawnpack.js still does");
    /*
     * P4-K-08 renamed `write` to `wroteDocs` at this call site and did not widen the narrowing.
     * `wroteDocs` is `write && renderRan`, so `!wroteDocs` is TRUE for every run the old `!write` was
     * true for, plus the one case P4-K-08 introduced: a `--write` run scoped with `--skip render`,
     * which cut no note because it rendered nothing — a preview, exactly like `--verify`, which is the
     * state ADR-003's `standard` cell advises on.
     */
    assert.match(codeOf('kernel/respawnpack.js'), /when:\s*!wroteDocs\s*\|\|\s*\(posturePolicy\(\)\s*\|\|\s*\{\}\)\.profile === 'light'/,
      'the kernel:R15 narrowing is no longer spelled at the note-budget call site, so the qualifier above fences nothing');
    assert.match(codeOf('kernel/respawnpack.js'), /const wroteDocs = write && renderRan;/,
      '`wroteDocs` is no longer `write && renderRan`, so the narrowing above no longer means "this run cut nothing"');
  });

  test('⛔ KERNEL_CROSS_TREE matches respawnpack.js\'s real cross-tree reads exactly, both ways', () => {
    /*
     * ⛔ WHY THIS LIVES HERE RATHER THAN IN modhealth.CROSS_TREE, WHICH P3-K-07b RE-EXAMINED.
     * `modhealth.CROSS_TREE` is the edge table for `dependencyGraph()`, whose nodes are the files in
     * kernel/lib and hooks. `respawnpack.js` is in neither directory and is named in
     * `modhealth.BOOTSTRAP` on purpose, so a key for it there would be an edge whose FROM node the graph
     * never contains: read by nothing, walked by nothing, a fence about nothing. What the move would
     * have bought is bought directly instead — this test, in the shape of the CROSS_TREE fence above.
     */
    const text = codeOf('kernel/respawnpack.js');
    const reached = [...new Set([...text.matchAll(/'hooks',\s*'([_\w.-]+\.js)'/g)].map((m) => m[1]))].sort();
    const listed = /const KERNEL_CROSS_TREE\s*=\s*\[([^\]]*)\]/.exec(text);
    assert.ok(listed, 'KERNEL_CROSS_TREE is no longer an array literal, so it cannot be derived from source');
    const declared = listed[1].split(',').map((s) => s.trim()).filter(Boolean).map((name) => {
      const m = new RegExp(`const\\s+${name}\\s*=\\s*path\\.resolve\\([^;]*'hooks',\\s*'([_\\w.-]+\\.js)'\\)`).exec(text);
      assert.ok(m, `KERNEL_CROSS_TREE names ${name}, which is not a constant resolving into the hook tree`);
      return m[1];
    }).sort();
    assert.deepEqual(declared, reached,
      'KERNEL_CROSS_TREE disagrees with the hook modules respawnpack.js actually resolves. A module only the '
      + 'kernel reads has a dependent no hook-side walk can see, so an unlisted one gets no doctor row at all — '
      + 'which is the silent inactivity this verb exists to catch, committed by the verb.');
    const shipped = new Set(fs.readdirSync(path.join(ROOT_DIR, 'hooks')).filter((f) => f.endsWith('.js')));
    for (const f of declared) assert.ok(shipped.has(f), `KERNEL_CROSS_TREE declares ${f}, and ${f} is not shipped`);
  });
});

describe('P3-K-07b · one resolution per verb, and every id asked is a relaxable one — observed, not read', () => {
  /*
   * ⛔ THE SOURCE FENCE ABOVE PROVES WHICH IDS ARE WRITTEN DOWN. THIS PROVES WHICH ARE ASKED.
   *
   * A copy of both trees with `hooks/_posture.js` wrapped so every `resolve()` and every `verdict(id)`
   * appends a line to a log. That is the only way to see the RUNTIME shape of the consult: that one verb
   * resolves the config exactly once no matter how many rows read it, and that no row ever hands the
   * resolver a KERNEL id outside ADR-003's relaxable ten. A row that asked about `kernel:R21` would pass
   * every static fence in this file and fail this one.
   *
   * ⛔ P2-I-3 ADDS ONE NAMED EXCEPTION, NOT A WIDER HOLE. `doctor`'s `subagents` row also asks about
   * `spawn-guard:ceiling` — a HOOK-side resolver row, not a `kernel:R<n>` one — for VISIBILITY, to report
   * what spawn-guard would do, never to relax a kernel check. The test below allows exactly that one id,
   * and only when the verb is `doctor`; every other verb, and every other id, still fails it.
   */
  function instrumentedTree() {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-postureprobe-'));
    fs.cpSync(KERNEL, path.join(tree, 'kernel'), { recursive: true });
    fs.cpSync(path.join(path.dirname(KERNEL), 'hooks'), path.join(tree, 'hooks'), { recursive: true });
    const target = path.join(tree, 'hooks', '_posture.js');
    fs.appendFileSync(target, [
      '',
      '// TEST INSTRUMENTATION (kernel.test.mjs, P3-K-07b) — appended to a COPY, never to the shipped file.',
      "const __log = (line) => { try { require('fs').appendFileSync(process.env.RP_POSTURE_LOG, line + '\\n'); } catch { /* ignore */ } };",
      'const __resolve = module.exports.resolve;',
      'const __verdict = module.exports.verdict;',
      "module.exports.resolve = (d) => { __log('resolve'); return __resolve(d); };",
      "module.exports.verdict = (r, id) => { __log('verdict ' + id); return __verdict(r, id); };",
      '',
    ].join('\n'));
    return tree;
  }

  const VERBS = [['state'], ['savepoint', '--verify'], ['savepoint', '--write'], ['status'], ['doctor'],
    ['gate'], ['readiness'], ['removals'], ['reconcile'], ['living'], ['memory', 'candidates'], ['contract']];

  test('every verb resolves the posture AT MOST ONCE, and never asks about an id outside the relaxable ten', () => {
    const tree = instrumentedTree();
    try {
      for (const args of VERBS) {
        const p = overBudgetNoteProject(postured('light'));
        const log = path.join(p.dir, '.posture-log');
        try {
          const run = spawnSync(process.execPath,
            [path.join(tree, 'kernel', 'respawnpack.js'), ...args, '--dir', p.dir, '--json'],
            { encoding: 'utf8', env: { ...process.env, RP_POSTURE_LOG: log } });
          assert.ok(run.status !== null, `${args.join(' ')} did not run at all: ${run.stderr.slice(0, 400)}`);
          const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
          const resolves = lines.filter((l) => l === 'resolve').length;
          assert.ok(resolves <= 1,
            `\`${args.join(' ')}\` read respawnpack.config.json's posture ${resolves} times. One verb, one resolution: two reads of a `
            + 'file that can change between them makes "which posture decided this row" unanswerable after the fact.');
          const asked = [...new Set(lines.filter((l) => l.startsWith('verdict ')).map((l) => l.slice('verdict '.length)))];
          const forbidden = asked.filter((id) => postureLib.FIXED_IDS.includes(id));
          assert.deepEqual(forbidden, [], `\`${args.join(' ')}\` asked the resolver about the FIXED id(s) ${forbidden.join(', ')}`);
          /*
           * P2-I-3: `doctor` alone also asks about `spawn-guard:ceiling` now, for its new `subagents`
           * row. That id is a HOOK-side resolver row, never a `kernel:R<n>` one, and doctor asks it for
           * VISIBILITY — reporting what spawn-guard would do — never to relax a kernel check, so it is
           * excluded from `RELAXABLE_KERNEL_IDS` itself on purpose and allowed here, for `doctor` only.
           */
          const allowedNonKernel = args[0] === 'doctor' ? ['spawn-guard:ceiling'] : [];
          /*
           * P2-Q-2: `kernel:readiness` is a kernel row added to ADR-003's table by a dated amendment
           * rather than by number, so it is allowed here for exactly the two callers that own it — the
           * `readiness` verb, and `doctor`'s `readiness` row, which resolves the same decision so the
           * count it prints is the one the verb would compute.
           */
          const amended = ['doctor', 'readiness'].includes(args[0]) ? AMENDED_KERNEL_IDS : [];
          const stray = asked.filter((id) => !RELAXABLE_KERNEL_IDS.includes(id) && !allowedNonKernel.includes(id) && !amended.includes(id));
          assert.deepEqual(stray, [], `\`${args.join(' ')}\` asked the resolver about ${stray.join(', ')}, which is not one of ADR-003's relaxable kernel rows`);
        } finally { rm(p.dir); }
      }
    } finally { rm(tree); }
  });

  test('the instrumentation is not decorative — savepoint really does reach the resolver', () => {
    // A probe that observed nothing would satisfy every assertion above vacuously.
    const tree = instrumentedTree();
    const p = overBudgetNoteProject(postured('light'));
    const log = path.join(p.dir, '.posture-log');
    try {
      spawnSync(process.execPath, [path.join(tree, 'kernel', 'respawnpack.js'), 'savepoint', '--verify', '--dir', p.dir, '--json'],
        { encoding: 'utf8', env: { ...process.env, RP_POSTURE_LOG: log } });
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      assert.equal(lines.filter((l) => l === 'resolve').length, 1, 'savepoint did not resolve the posture at all');
      const asked = new Set(lines.filter((l) => l.startsWith('verdict ')).map((l) => l.slice('verdict '.length)));
      for (const id of ['kernel:R1', 'kernel:R15']) assert.ok(asked.has(id), `savepoint never consulted ${id}`);
    } finally { rm(p.dir); rm(tree); }
  });
});

describe('P3-K-07b · the table test — outcome-to-exit is exactly the existing map, every verb, every profile', () => {
  /*
   * ⛔ CAPTURED FROM THE UNMODIFIED TREE BEFORE THE FIRST EDIT, THEN ASSERTED AS LITERALS.
   *
   * Every number below was read off a real run of the kernel at this task's base commit and re-read
   * after the change; they are identical in every cell but one. That one is ADR-003 `kernel:R9` under a
   * declared `light` posture, which is the change this task exists to make, and it is marked.
   *
   * Two claims, not one: the exit CODE of each cell, and that the code is exactly
   * `exitCodeFor(outcome)` — so a future verb cannot reach a right-looking exit code through a second
   * mapping (anti-drift items 1 and 2). `unknown-verb` prints usage and emits no outcome; it exits 1
   * because an unknown verb exits 1 (anti-drift item 17), and that is asserted as itself.
   */
  const PROFILE_CONFIG = {
    'none-declared': {},
    light: { posture: { profile: 'light' } },
    standard: { posture: { profile: 'standard' } },
    strict: { posture: { profile: 'strict' } },
    INVALID: { posture: { profile: 'loose' } },
    unreadable: { posture: { profile: 'light' } }, // overwritten with unparseable bytes below
  };
  const PROFILES = Object.keys(PROFILE_CONFIG);

  //                             none  light  std  strict  INVALID  unreadable
  const EXPECTED = {
    state: [0, 0, 0, 0, 0, 0],
    'savepoint --verify': [2, 0, 0, 2, 2, 2],
    'savepoint --write': [2, 0, 0, 2, 2, 2],
    status: [0, 0, 0, 0, 0, 0],
    doctor: [2, 0, 0, 2, 1, 1],
    gate: [2, 0, 2, 2, 2, 2], // ← the ONE cell P3-K-07b moves: ADR-003 kernel:R9, `light` only (was 2)
    removals: [2, 2, 2, 2, 2, 2],
    reconcile: [2, 2, 2, 2, 2, 2],
    living: [1, 1, 1, 1, 1, 1],
    'memory candidates': [0, 0, 0, 0, 0, 0],
    contract: [0, 0, 0, 0, 0, 0],
    'restore-derived CONTINUITY.md': [2, 2, 2, 2, 2, 2],
    'not-a-verb': [1, 1, 1, 1, 1, 1],
  };

  for (const [verb, codes] of Object.entries(EXPECTED)) {
    test(`${verb} · ${PROFILES.map((p, i) => `${p}=${codes[i]}`).join(' ')}`, () => {
      PROFILES.forEach((profile, i) => {
        const p = bareProject(PROFILE_CONFIG[profile]);
        try {
          if (profile === 'unreadable') fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), '{ this is not json');
          const r = cli(p.dir, ...verb.split(' '));
          assert.equal(r.code, codes[i], `${verb} under ${profile} exited ${r.code}, not ${codes[i]}`);
          if (r.json && typeof r.json.outcome === 'string') {
            assert.equal(r.code, exitCodeFor(r.json.outcome),
              `${verb} under ${profile} reported ${r.json.outcome} and exited ${r.code} — a second exit map has appeared`);
          }
        } finally { rm(p.dir); }
      });
    });
  }

  test('⛔ every profile that is not a validly DECLARED one lands on today\'s numbers exactly', () => {
    // The migration guarantee, read off the table above rather than argued: DEFAULTED, INVALID and
    // UNREADABLE differ from `strict` only where a BROKEN doctor row makes the difference visible.
    for (const [verb, codes] of Object.entries(EXPECTED)) {
      const [none, , , strict, invalid, unreadable] = codes;
      assert.equal(none, strict, `${verb}: an absent posture key must be exactly \`strict\``);
      if (verb !== 'doctor') {
        assert.equal(invalid, strict, `${verb}: an INVALID posture must behave as strict`);
        assert.equal(unreadable, strict, `${verb}: an UNREADABLE posture must behave as strict — "could not read it" is never the loosest policy`);
      }
    }
    // doctor is the exception, and it is the RIGHT direction: a posture nobody can read is a BROKEN row
    // at exit 1, which is stricter than exit 2, never looser.
    assert.deepEqual(EXPECTED.doctor.slice(4), [1, 1],
      'doctor must report an INVALID or UNREADABLE posture as BROKEN — a silently ignored posture is the same class of lie as a silently loosened guard');
  });
});

/*
 * ⛔ THE OVER-CLAIM THIS FENCE EXISTS TO END (P-004, docs/derived/state/pairs.json). Scenario O's five
 * fixtures above exercise the STATES of each optional contract; this checks that the SET of contracts
 * is complete. schemas/project-config.schema.json declares the {notApplicable, reason} opt-out shape at
 * SIX places — routeSource, codeTruth and qualityGate at the top level, state.removals and
 * state.reconcile nested under state, with routeSource/codeTruth reached through
 * `$defs/declaredSourceOrOptOut` — plus `requirements`, which resolves from whether
 * docs/derived/state/requirements.json EXISTS rather than from a config opt-out, and is exempted below
 * rather than silently unaccounted for.
 *
 * applicability.js's survey() used to hardcode five subsystem blocks with nothing deriving them from the
 * schema. `qualityGate` declared the identical opt-out shape and had no row, so a project that never
 * decided about its quality gate was indistinguishable from one whose gate had simply found nothing —
 * and doctor printed "all 5 optional contracts are decided" while a sixth sat undecided and invisible.
 *
 * A set-diff cannot be satisfied by two agreeing-but-stale lists, so BOTH sides are DERIVED rather than
 * listed: side A by walking the schema's actual `properties`/`$ref`/`anyOf` structure (never a hardcoded
 * key list — a fixture below proves the walk finds a freshly-added nested opt-out it was never told
 * about), side B from a live `applicability.survey()` call. Modelled on the bidirectional style of the
 * modhealth registry fence above (search "every kernel subsystem export read by ANY production module is
 * declared"): a schema block with no subsystem row fails, and a subsystem row with no schema block fails
 * unless it is named as exempt.
 */
describe('applicability survey ↔ schema opt-outs · bidirectional (P-004)', () => {
  const applicability = createRequire(import.meta.url)('./lib/applicability.js');
  const ROOT_DIR = path.dirname(KERNEL);
  const SCHEMA_PATH = path.join(ROOT_DIR, 'schemas', 'project-config.schema.json');

  // This schema only ever points at its own #/$defs/*, so a fragment walk is the whole of $ref support
  // this needs — a second schema family with a different $ref shape would have to extend this, not use it.
  function resolveRef(root, node) {
    if (node && typeof node === 'object' && typeof node.$ref === 'string') {
      const m = /^#\/(.+)$/.exec(node.$ref);
      if (m) {
        let cur = root;
        for (const seg of m[1].split('/')) cur = cur && cur[seg];
        return cur || null;
      }
    }
    return node;
  }

  /**
   * Does this schema node declare {notApplicable, reason} as SIBLING properties, either directly or one
   * `$ref`/`anyOf`/`oneOf`/`allOf` branch away? Depth-bounded rather than cycle-detected: this schema has
   * no self-referencing $defs, and a bound is the cheap version of the same safety.
   */
  function declaresOptOut(root, node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return false;
    const resolved = resolveRef(root, node);
    if (!resolved || typeof resolved !== 'object') return false;
    if (resolved.properties && resolved.properties.notApplicable && resolved.properties.reason) return true;
    for (const branchKey of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(resolved[branchKey])) {
        for (const branch of resolved[branchKey]) if (declaresOptOut(root, branch, depth + 1)) return true;
      }
    }
    return false;
  }

  /**
   * Every dotted property path in `schemaDoc` whose own schema declares a notApplicable opt-out —
   * WALKED from `properties` at every depth, never listed, so a future opt-out is found the day its
   * schema block is written rather than the day someone remembers to update a hardcoded list, which is
   * the exact gap this fence exists to close one layer up.
   */
  function schemaOptOutKeys(schemaDoc) {
    const found = [];
    function walk(node, prefix, depth) {
      if (!node || typeof node !== 'object' || depth > 6) return;
      const resolved = resolveRef(schemaDoc, node);
      if (!resolved || typeof resolved !== 'object' || !resolved.properties) return;
      for (const [key, propSchema] of Object.entries(resolved.properties)) {
        const dotted = prefix ? `${prefix}.${key}` : key;
        if (declaresOptOut(schemaDoc, propSchema)) found.push(dotted);
        walk(propSchema, dotted, depth + 1);
      }
    }
    walk(schemaDoc, '', 0);
    return found.sort();
  }

  // schema-key -> subsystem. The only place the two vocabularies — the founder-facing config key, and
  // applicability.js's internal subsystem name — are bridged, so a rename on either side fails loudly
  // here instead of silently opening a gap between them.
  const DECLARED = {
    routeSource: 'routes',
    codeTruth: 'codeTruth',
    qualityGate: 'qualityGate',
    'state.removals': 'removals',
    'state.reconcile': 'reconcile',
  };
  /*
   * `requirements` resolves from whether docs/derived/state/requirements.json EXISTS, never from a
   * respawnpack.config.json opt-out — kernel/lib/applicability.js's survey() says so explicitly (search
   * "THIS ROW REPORTS kernel/lib/state.js's VERDICT"). There is no {notApplicable, reason} shape for it
   * to decline, so it has no schema block to point at; it is named here rather than left silently
   * unaccounted for by the reverse direction below.
   */
  const EXEMPT = { requirements: 'a file-presence contract, not a config opt-out' };

  test('every schema-declared notApplicable opt-out has a survey() subsystem row, and every subsystem row traces back to a schema opt-out or is exempted — P-004', () => {
    const schemaKeys = schemaOptOutKeys(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));

    // ⛔ THE POSITIVE CONTROL. Without this, every assertion below could be passing vacuously over an
    // empty set — a walk that silently finds nothing is indistinguishable from a walk that agrees with
    // everything, which is precisely the zero-subject shape this pack's own doctrine refuses elsewhere.
    assert.ok(schemaKeys.length >= 5,
      `schemaOptOutKeys found only [${schemaKeys.join(', ')}] in ${SCHEMA_PATH} — the walk lost one of `
      + 'routeSource/codeTruth/qualityGate/state.removals/state.reconcile');

    // schema -> survey. A schema block with no DECLARED entry is invisible to doctor's onboarding count
    // — the exact P-004 over-claim this fence exists to end.
    for (const key of schemaKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(DECLARED, key),
        `schemas/project-config.schema.json declares a notApplicable opt-out at "${key}" with no entry in `
        + 'DECLARED — applicability.survey() cannot be reporting onboarding as complete for a contract it has never heard of.');
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-applicability-fence-'));
    try {
      const subsystems = applicability.survey(dir).rows.map((r) => r.subsystem);

      // DECLARED -> schema, and DECLARED -> survey. An entry for a key the schema no longer declares, or
      // for a subsystem survey() no longer emits, is a fence about nothing.
      for (const [key, subsystem] of Object.entries(DECLARED)) {
        assert.ok(schemaKeys.includes(key),
          `DECLARED maps "${key}" -> ${subsystem}, but schemas/project-config.schema.json no longer declares a notApplicable opt-out there`);
        assert.ok(subsystems.includes(subsystem),
          `DECLARED maps "${key}" -> ${subsystem}, but applicability.survey().rows has no "${subsystem}" row`);
      }

      // survey -> (DECLARED ∪ EXEMPT). Every row survey() actually emits must be named on one of the two
      // lists — a subsystem invented with neither is answering a question the schema never asked, and
      // doctor would count it toward "N optional contracts" with nothing here to justify the count.
      const mappedSubsystems = new Set(Object.values(DECLARED));
      for (const subsystem of subsystems) {
        assert.ok(mappedSubsystems.has(subsystem) || Object.prototype.hasOwnProperty.call(EXEMPT, subsystem),
          `applicability.survey() reports a "${subsystem}" row that is neither in DECLARED nor EXEMPT — `
          + 'name the schema key it resolves from, or exempt it here with a stated reason.');
      }
      assert.ok(subsystems.includes('requirements'), 'the fixed requirements row is gone — the EXEMPT entry for it is now stale');
    } finally { rm(dir); }
  });

  test('the schema walk is a WALK, not a disguised list — a freshly-added nested opt-out is found unprompted', () => {
    // ⛔ THE DISCRIMINATING CONTROL. Without this, schemaOptOutKeys could be five string literals wearing
    // a function, and every assertion above would still pass. Planting a SIXTH opt-out nowhere named in
    // this file and requiring the walk to find it anyway is what proves the derivation is real.
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    schema.properties.state.properties.plantedForThisTestOnly = {
      type: 'object', properties: { notApplicable: { type: 'boolean' }, reason: { type: 'string' } },
    };
    assert.ok(schemaOptOutKeys(schema).includes('state.plantedForThisTestOnly'),
      'the walk did not find an opt-out planted at a path no code here names — it is reading a fixed shape, not the schema');
  });
});

// --- Scenario P -------------------------------------------------------------------------------------
//
// ⛔ ONE CONTRACT, THREE IMPLEMENTATIONS, AND THE WEAKEST WAS THE ONE THAT ARGUED HARDEST FOR IT.
//
// `qualityGate`, `state.removals` and `state.reconcile` all take the same declared opt-out —
// `notApplicable: true` beside a reason. removals.js and reconcile.js each refuse the reason-less form
// outright. gate.js accepted it, returned NOT_APPLICABLE at exit 0, and left a parenthetical scold in a
// field nothing reads — while gate.js's own header is where the rule is stated most emphatically:
// NOT_APPLICABLE is only ever DECLARED, and the project taking it "takes responsibility for the claim."
//
// A set-diff cannot see this: all three keys are present in the schema and all three loaders exist. The
// disagreement is behavioural, so the fence has to be a SHARED TEST VECTOR — one input through all three
// implementations, asserting they answer alike. That is the only shape that catches an N-way semantic
// divergence, and it is why this block is a scenario of its own rather than another row in a table.

describe('Scenario P · one declared-opt-out contract, and all three loaders answer it alike', () => {
  const REASONLESS = { notApplicable: true };            // the shape under test: declared, unjustified
  const JUSTIFIED = { notApplicable: true, reason: 'this project genuinely has none' };

  test('P1 · a reason-less opt-out is REFUSED by all three, and never reaches a passing exit', () => {
    const p = bareProject({ qualityGate: REASONLESS, state: { removals: REASONLESS, reconcile: REASONLESS } });
    try {
      const answers = {
        qualityGate: cli(p.dir, 'gate'),
        removals: cli(p.dir, 'removals'),
        reconcile: cli(p.dir, 'reconcile'),
      };
      for (const [name, r] of Object.entries(answers)) {
        assert.notEqual(r.code, 0,
          `${name} accepted an opt-out with no reason and exited 0 — an opt-out nobody has to justify is an opt-out nobody reviews`);
        assert.notEqual(r.json.outcome, 'NOT_APPLICABLE',
          `${name} reported NOT_APPLICABLE for an unjustified opt-out; only a DECLARED-with-reason opt-out may reach it`);
      }
      // ⛔ AND THEY AGREE. Three separate non-zero exits would still be three different contracts.
      assert.equal(new Set(Object.values(answers).map((r) => r.code)).size, 1,
        `the three loaders disagree on the same input: ${JSON.stringify(Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.code])))}`);
    } finally { rm(p.dir); }
  });

  test('P1 control · the SAME opt-out WITH a reason is accepted by all three, at exit 0', () => {
    // Without this the test above would pass against a build that simply refuses every opt-out, which
    // would break the one escape hatch a genuinely minimal project has.
    const p = bareProject({
      ...FULLY_DECIDED,
      qualityGate: JUSTIFIED,
      state: { removals: JUSTIFIED, reconcile: JUSTIFIED },
    });
    try {
      for (const verb of ['gate', 'removals', 'reconcile']) {
        const r = cli(p.dir, verb);
        assert.equal(r.code, 0, `${verb} refused a properly justified opt-out: ${r.json && r.json.why}`);
        assert.equal(r.json.outcome, 'NOT_APPLICABLE', `${verb} did not reach NOT_APPLICABLE on a declared, justified opt-out`);
      }
    } finally { rm(p.dir); }
  });
});

/*
 * ⛔ THE DECISION LOG WAS A HOLE IN THE CONTRACT'S FRONT DOOR (release invariant 12).
 *
 * `HISTORY_HEADING` blanks a section whose heading asserts its own pastness, so `## Removed in 0.3` over
 * a bare bullet list does not have to repeat the retirement on every line. `decisions` and `decision log`
 * were in that set — and a decision log is not history. It is a record of decisions, most of them
 * CURRENT, and it is the single most likely place a resurrection gets written down, because writing
 * decisions down is what the file is for. Reproduced before the fix: one sentence, one file, one registry
 * row — FAIL under `## Features`, PASS under `## Decisions`.
 *
 * The table below is the whole discrimination in one place: the defect, its nearest bypass, and the three
 * shapes that must NOT become false positives. Without the last three, removing the headings entirely
 * would also pass this test while breaking every honest changelog in every target.
 */
describe('Scenario Q · a decision log is a record of decisions, not a history exemption', () => {
  const CASES = [
    { label: 'an ordinary heading', body: '## Features\n\nThe roster ships four magic gauntlets.\n', expect: 'FAIL', why: 'the base control — if this ever passes, the scanner is broken outright' },
    { label: '## Decisions', body: '## Decisions\n\nThe roster ships four magic gauntlets.\n', expect: 'FAIL', why: 'THE DEFECT: a live reintroduction under a decision heading passed the scan' },
    { label: '## Decision Log', body: '## Decision Log\n\nThe roster ships four magic gauntlets.\n', expect: 'FAIL', why: 'the nearest bypass — the same exemption under the other spelling' },
    { label: '## Removed in 0.3', body: '## Removed in 0.3\n\n- magic gauntlet\n', expect: 'PASS', why: 'a heading that carries the retirement still exempts its bare entries, or every honest changelog becomes a failure' },
    { label: '## Changelog', body: '## Changelog\n\n- magic gauntlet\n', expect: 'PASS', why: 'same, for the other historical-by-construction heading' },
    { label: 'a real decision entry', body: '## Decisions\n\nD-003: the magic gauntlet was removed in 0.3.\n', expect: 'PASS', why: 'a genuine retirement recorded in the decision log must still pass, by the CLAUSE-level machinery rather than by blanking the section' },
  ];

  for (const c of CASES) {
    test(`Q · ${c.label} → ${c.expect}`, () => {
      const p = removalProject({
        removals: GAUNTLET_ROW,
        config: { registry: 'docs/derived/state/removals.json', liveContentDirs: ['docs'] },
        files: { 'docs/PRODUCT.md': `# Product\n\n${c.body}` },
      });
      try {
        const r = cli(p.dir, 'removals');
        assert.equal(r.json.outcome, c.expect, `${c.label}: ${c.why}`);
      } finally { rm(p.dir); }
    });
  }
});

/*
 * ⛔ I-3 · THE WAVE LEDGER HAD A WRITER, TWO DETECTORS, AND NO READER.
 *
 * `hooks/spawn-guard.js` creates `.respawnpack/wave-ledger.md` and appends a line per subagent
 * dispatch; its own header, `skills/savepoint/SKILL.md` and `hooks/README.md` all promise that
 * `/savepoint` folds it into the derived docs and DELETES it. Nothing did. The file grew for the life
 * of the project and `precompact-ledger-nudge.js`'s `ledgerBehindHead` warned about it forever.
 *
 * ⛔ AND THE UNQUALIFIED FIX WOULD HAVE EATEN THIS REPOSITORY'S OWN 306-LINE LEDGER. On an installed
 * TARGET `install/install.js` gitignores `.respawnpack/` wholesale, so the ledger there really is
 * mid-run scratch; in THIS repo `.gitignore` deliberately un-ignores it and it is a tracked,
 * hand-written maintainer document. So the fold is guarded by TRACKED-NESS, and that guard is what the
 * third block below exists to hold down.
 */
describe('I-3 · savepoint folds the wave ledger, and tracked-ness is what decides', () => {
  const LEDGER_REL = '.respawnpack/wave-ledger.md';
  const CONT_REL = 'docs/derived/CONTINUITY.md';
  const CL_REL = 'docs/derived/CHANGELOG.md';
  const manifest = createRequire(import.meta.url)('../hooks/_manifest.js');

  // The shape spawn-guard actually writes: a header, one line per dispatch, hand-added outcome lines
  // beneath some of them, and a "Current state" section the orchestrator maintains by hand.
  const LEDGER = [
    '# Wave ledger',
    '',
    '> Auto-appended by `.claude/hooks/spawn-guard.js` on every subagent dispatch, so a compaction or',
    '> crash mid-wave is resumable. `/savepoint` folds it into the derived docs and DELETES it.',
    '',
    '- `2026-09-02T10:00:00.000Z` · dispatch #1 in flight · **explorer** — map the auth module · session abcd1234',
    '  - landed: three findings, commits aaaaaaa..bbbbbbb',
    '- `2026-09-02T10:05:00.000Z` · dispatch #2 in flight · **builder** — write the CSV writer · session abcd1234',
    '',
    '## Current state',
    '',
    '- the CSV writer is half-done; the reader is untouched',
    '',
  ].join('\n');

  const put = (dir, rel, body) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  const has = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
  const text = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
  const ledgerRow = (r) => (r.json.checks || []).find((c) => c.check === 'wave-ledger');
  const generatedBlock = (s) => s.slice(s.indexOf(render.GEN_OPEN), s.indexOf(render.GEN_CLOSE));

  /** A project whose first `savepoint --write` already passed, with a ledger placed for the next run. */
  function seeded({ tracked = false, ledger = LEDGER, changelog = true } = {}) {
    const p = project();
    if (tracked) {
      // Committed BEFORE the seeding savepoint, so HEAD (and the revision the state binds to) already
      // contains it — the shape this repository itself is in.
      put(p.dir, LEDGER_REL, ledger);
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'track the maintainer ledger');
    }
    const first = cli(p.dir, 'savepoint', '--verify', '--write');
    assert.equal(first.code, 0, `the seeding savepoint must pass: ${first.stdout}${first.stderr}`);
    if (changelog) put(p.dir, CL_REL, '# CHANGELOG\n\n## 2026-09-02 — this session\n\n- the work the session did\n\n## 2026-09-01 — the session before\n\n- older work\n');
    if (!tracked) put(p.dir, LEDGER_REL, ledger);
    return p;
  }

  // --- 1. the defect ------------------------------------------------------------------------------
  test('the defect · an untracked ledger used to survive savepoint --write untouched', () => {
    const p = seeded();
    try {
      assert.ok(has(p.dir, LEDGER_REL), 'sanity: the fixture places a ledger');
      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(w.code, 0, `the fold must not break a passing savepoint: ${JSON.stringify((w.json && w.json.checks || []).filter((c) => c.outcome !== 'PASS'))}`);
      assert.equal(has(p.dir, LEDGER_REL), false,
        'the ledger survived `savepoint --write` — the fold-and-delete every doc surface promises has no mechanism');
    } finally { rm(p.dir); }
  });

  // --- 2. corrected --------------------------------------------------------------------------------
  test('corrected · --write appends one changelog line per dispatch group, folds the current state into the generated block, deletes the ledger, and reports PASS', () => {
    const p = seeded();
    try {
      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(w.code, 0, w.stdout + w.stderr);

      const row = ledgerRow(w);
      assert.ok(row, `expected a wave-ledger row among: ${(w.json.checks || []).map((c) => c.check).join(', ')}`);
      assert.equal(row.outcome, OUTCOME.PASS);
      assert.match(row.detail, /CHANGELOG\.md/, 'the row must name what it folded the dispatch lines into');
      assert.match(row.detail, /CONTINUITY\.md/, 'the row must name where the current state went');

      const cl = text(p.dir, CL_REL);
      assert.match(cl, /explorer/, "the first dispatch group's line must reach the derived changelog");
      assert.match(cl, /builder/, "the second dispatch group's line must reach the derived changelog");
      assert.match(cl, /three findings/, 'a dispatch group carries its recorded outcome with it');
      assert.match(cl, /outcome not recorded/i, 'a dispatch with no recorded outcome must say so, not silently read as done');
      const firstEntry = cl.slice(cl.indexOf('## 2026-09-02'), cl.indexOf('## 2026-09-01'));
      assert.match(firstEntry, /explorer/, "the lines belong to THIS session's entry, not the end of the file");

      const cont = text(p.dir, CONT_REL);
      assert.match(generatedBlock(cont), /the CSV writer is half-done/,
        "the ledger's current state must land INSIDE the generated block, never in the hand-written NOTE");
      assert.equal(has(p.dir, LEDGER_REL), false, 'a folded ledger is deleted — it is scratch, never a second source of truth');

      // The fold is carried forward by later renders, or the next --verify would report the document
      // it just wrote as hand-edited.
      const again = cli(p.dir, 'savepoint', '--verify');
      assert.equal(again.code, 0, `a verify after a fold must stay clean: ${JSON.stringify((again.json && again.json.checks || []).filter((c) => c.outcome !== 'PASS' && c.outcome !== 'NOT_APPLICABLE'))}`);
      assert.equal(ledgerRow(again), undefined, 'with the ledger gone there is nothing to report — an absent ledger yields no row');
      assert.match(generatedBlock(text(p.dir, CONT_REL)), /the CSV writer is half-done/, 'a later --write must not drop the folded block');
    } finally { rm(p.dir); }
  });

  test('corrected · --verify without --write leaves the ledger alone and FAILs naming --write', () => {
    const p = seeded();
    try {
      const before = text(p.dir, LEDGER_REL);
      const v = cli(p.dir, 'savepoint', '--verify');
      assert.equal(v.code, 1, 'a present, unfolded, untracked ledger is a FAIL, not a silent pass');
      const row = ledgerRow(v);
      assert.ok(row, 'the verify-only run must still report the ledger');
      assert.equal(row.outcome, OUTCOME.FAIL);
      assert.match(row.detail, /--write/, 'the row must name the remedy');
      assert.equal(text(p.dir, LEDGER_REL), before, 'a verify is not a write — the ledger must be byte-identical');
    } finally { rm(p.dir); }
  });

  // --- 3. the nearest bypasses ---------------------------------------------------------------------
  test('bypass · a TRACKED ledger is never folded and never deleted — it is a maintainer document the repo keeps on purpose', () => {
    const p = seeded({ tracked: true });
    try {
      const before = text(p.dir, LEDGER_REL);
      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(w.code, 0, w.stdout + w.stderr);

      const row = ledgerRow(w);
      assert.ok(row, 'a tracked ledger is still reported — silence would read as "there is no ledger"');
      assert.equal(row.outcome, OUTCOME.NOT_APPLICABLE, 'tracked is a decided non-applicability, not a failure and not a pass');
      assert.match(row.detail, /track/i, 'the row must say WHY it did nothing');
      assert.equal(text(p.dir, LEDGER_REL), before, 'the tracked ledger must be byte-identical after --write');
      assert.doesNotMatch(text(p.dir, CONT_REL), /the CSV writer is half-done/, 'nothing from a tracked ledger is folded');
      assert.doesNotMatch(text(p.dir, CL_REL), /explorer/, 'nothing from a tracked ledger reaches the changelog either');
    } finally { rm(p.dir); }
  });

  test('bypass · no ledger at all yields no row', () => {
    const p = project();
    try {
      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(w.code, 0, w.stdout + w.stderr);
      assert.equal(ledgerRow(w), undefined, 'a project with no ledger must not be told about one');
    } finally { rm(p.dir); }
  });

  test('bypass · a savepoint blocked by another check folds nothing, deletes nothing, and never reports it folded', () => {
    const p = seeded();
    try {
      // A NOTE over the 1,200-char budget is a real FAIL under --write, so the run reaches writeback
      // already blocked. Any other blocker would do; this one is deterministic.
      const cont = text(p.dir, CONT_REL);
      put(p.dir, CONT_REL, cont.replace('_(no human note)_', 'x'.repeat(render.NOTE_BUDGET + 200)));
      const before = text(p.dir, LEDGER_REL);

      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.notEqual(w.code, 0, 'sanity: the fixture must actually block the run');
      const row = ledgerRow(w);
      assert.ok(row, 'a blocked run must still say what it did NOT do to the ledger');
      assert.notEqual(row.outcome, OUTCOME.PASS, 'a blocked savepoint must never report the ledger folded');
      assert.equal(row.outcome, OUTCOME.CANNOT_DETERMINE, 'the fold could not run — that is not the same as the fold failing');
      assert.equal(text(p.dir, LEDGER_REL), before, 'the ledger must survive a blocked run byte-for-byte');
      assert.doesNotMatch(text(p.dir, CL_REL), /explorer/, 'nothing is appended to the changelog by a blocked run');
    } finally { rm(p.dir); }
  });

  test('bypass · a savepoint commit that also deletes the ledger still classifies as savepoint-only', () => {
    const p = project();
    try {
      // This repository's own shape: everything under .respawnpack/ is ignored EXCEPT the ledger.
      put(p.dir, '.gitignore', '.respawnpack/*\n!.respawnpack/wave-ledger.md\n');
      put(p.dir, LEDGER_REL, LEDGER);
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'work, with a tracked ledger');
      const W = p.head();

      const w = cli(p.dir, 'savepoint', '--verify', '--write');
      assert.equal(w.code, 0, w.stdout + w.stderr);
      assert.equal(ledgerRow(w).outcome, OUTCOME.NOT_APPLICABLE, 'sanity: the fold never removes a tracked ledger itself');

      // A tracked ledger only ever leaves by a hand that decided to remove it — and that removal lands
      // in the same commit as the savepoint's own output.
      fs.rmSync(path.join(p.dir, ...LEDGER_REL.split('/')));
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', `docs(savepoint): regen at ${W.slice(0, 7)}`);

      const r = manifest.sourceRevisions(p.dir);
      assert.equal(r.effective, W, 'a savepoint commit that carries the folded ledger away is not a source change');
      assert.equal(r.savepointOnly.length, 1);
    } finally { rm(p.dir); }
  });
});

/*
 * ⛔ P3-T-09a · DOCTOR'S POSTURE ROW — three states, and the one that must NOT be green.
 *
 * ADR-003 gives a project three postures in one key of `respawnpack.config.json` and defines `strict`
 * as exactly what 0.3.0 does, so an absent key resolves to strict and an existing target sees no
 * change. Doctor's job here is to report the DECLARATION, and the three states are not
 * interchangeable:
 *
 *   CONFIGURED      a posture is declared and well formed. Green.
 *   NOT_CONFIGURED  nobody declared one. Green, and STILL a different row from CONFIGURED: "nobody
 *                   chose" and "chose strict" produce identical behaviour today and are different
 *                   facts, and a report that blurs them cannot say what changed on the day one of them
 *                   moves.
 *   BROKEN          the declaration is INVALID or the config is unreadable. NOT green. The resolver has
 *                   already failed closed to strict, so nothing is loosened by the fault; this row is
 *                   what stops a founder believing they are running `light` while the pack runs strict.
 *
 * The exit-code claim is the load-bearing half: a VALID posture must leave doctor's exit code exactly
 * where it was with no posture at all, because this task adds a reader and a row and changes no verdict
 * anywhere. P3-N-2's day-one twin above pins the same promise from the other end.
 */
describe('doctor · the posture row (P3-T-09a) · CONFIGURED, NOT_CONFIGURED, BROKEN', () => {
  const postureRow = (r) => (r.json.rows || []).find((x) => x.check === 'posture');

  /** Rewrite the base fixture's config with `posture` set to `value`, or removed when undefined. */
  const withPosture = (dir, value) => {
    const file = path.join(dir, 'respawnpack.config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === undefined) delete cfg.posture; else cfg.posture = value;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  };

  test('a declared posture is CONFIGURED, names the profile and its overrides, and does not move the exit code', () => {
    const p = project();
    try {
      const before = cli(p.dir, 'doctor');
      assert.equal(postureRow(before).label, 'NOT_CONFIGURED', 'precondition: the base fixture declares no posture');

      withPosture(p.dir, { profile: 'light', overrides: { 'push-guard:tier1': { verdict: 'off', reason: 'solo repo, every push reviewed at the PR' } } });
      const after = cli(p.dir, 'doctor');
      const row = postureRow(after);
      assert.equal(row.label, 'CONFIGURED');
      assert.match(row.detail, /light/, 'the row must name the posture that was declared');
      assert.match(row.detail, /push-guard:tier1 → off \(solo repo/, 'an override is reported WITH its reason, or the reason requirement buys nothing a reader can see');

      assert.equal(after.code, before.code,
        'declaring a valid posture changed doctor\'s exit code. P3-T-09a adds a reader and a row and must change no verdict anywhere');
      assert.equal(after.json.outcome, before.json.outcome);
    } finally { rm(p.dir); }
  });

  test('an absent key is NOT_CONFIGURED, green, and distinct from a declared strict', () => {
    const p = project();
    try {
      const absent = cli(p.dir, 'doctor');
      assert.equal(absent.code, 0, 'the base fixture is green, so an absent posture must not be what makes it red');
      const row = postureRow(absent);
      assert.equal(row.label, 'NOT_CONFIGURED');
      assert.match(row.detail, /strict/, 'the row must say what an absent key resolves to');

      withPosture(p.dir, { profile: 'strict' });
      const chosen = cli(p.dir, 'doctor');
      assert.equal(chosen.code, 0, 'choosing strict explicitly is the same behaviour and must stay green');
      assert.equal(postureRow(chosen).label, 'CONFIGURED',
        'a project that CHOSE strict reports the same row as one that never chose — the two facts have been collapsed');
    } finally { rm(p.dir); }
  });

  test('an INVALID posture is BROKEN and NOT green, for each of the three malformed shapes', () => {
    /*
     * ⛔ THE THIRD SHAPE IS THE ONE WORTH THE FIXTURE. An override on a rule that is fixed in every
     * posture is REFUSED rather than ignored — a founder who believes they turned `secret-scan` off has
     * to be told they did not, and a green row would tell them they did.
     */
    const shapes = [
      ['an unknown profile', { profile: 'paranoid' }],
      ['a reason-less override', { profile: 'light', overrides: { 'mcp-reaper': { verdict: 'off' } } }],
      ['an override on a fixed id', { profile: 'light', overrides: { 'secret-scan': { verdict: 'off', reason: 'no secrets here' } } }],
    ];
    for (const [what, value] of shapes) {
      const p = project();
      try {
        withPosture(p.dir, value);
        const r = cli(p.dir, 'doctor');
        const row = postureRow(r);
        assert.equal(row.label, 'BROKEN', `${what} must be BROKEN`);
        assert.match(row.detail, /INVALID/, `${what}: the row must say the declaration is invalid`);
        assert.notEqual(r.code, 0, `${what} left doctor green — an invalid posture that reports as healthy is the fault wearing the costume of a decision`);
      } finally { rm(p.dir); }
    }
  });

  test('an unparseable config makes the row BROKEN rather than silently reporting a posture nobody declared', () => {
    const p = project();
    try {
      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), '{ "posture": { "profile": "light" ');
      const r = cli(p.dir, 'doctor');
      const row = postureRow(r);
      assert.equal(row.label, 'BROKEN');
      assert.match(row.detail, /UNREADABLE|not parseable/i, 'the row must name the config as unreadable');
      assert.match(row.detail, /strict/, 'and say that it resolved to strict — "could not read the policy" is never "the loosest policy"');
      assert.notEqual(row.label, 'NOT_CONFIGURED',
        'an unreadable config reported as NOT_CONFIGURED would be a fault indistinguishable from a project that declared nothing');
    } finally { rm(p.dir); }
  });
});

/*
 * ⛔ P1-E-1a · DOCTOR'S EXCEPTIONS ROW — three states, and the one that must NOT be green.
 *
 * A declared exception carves ONE reviewed subject out of a guard that has one. The whole grammar rests
 * on the allowance staying visible, so it gets a row for the reason the posture does: an allowance
 * nobody can see is the untracked `.respawnpack/<hook>.off` marker with better manners.
 *
 *   CONFIGURED      at least one exception is declared and the list is well formed. Green, and it
 *                   carries BOTH counts: an expired entry lifts nothing, so a project can sit for
 *                   months with a guard firing on a subject its founder believes is excepted.
 *   NOT_CONFIGURED  nothing is lifted here. Green. Unlike the posture row this is keyed on the LIST
 *                   BEING EMPTY rather than on the source, because an absent key and a present empty
 *                   list are the same fact: no subject is lifted anywhere.
 *   BROKEN          the list is INVALID or the config is unreadable. NOT green. The reader has already
 *                   refused the whole list, so nothing is loosened by the fault; this row is what stops
 *                   a founder believing a hit is excepted while the guard still denies it.
 *
 * The exit-code claim is the load-bearing half: a VALID list must leave doctor's exit code exactly
 * where it was with no key at all, because this task adds a reader and a row and changes no verdict
 * anywhere. The guards that consume the reader landed after this row, in E-1b to E-1d.
 */
describe('doctor · the exceptions row (P1-E-1a) · CONFIGURED, NOT_CONFIGURED, BROKEN', () => {
  const exceptionsRow = (r) => (r.json.rows || []).find((x) => x.check === 'exceptions');
  const excLib = createRequire(import.meta.url)(path.join(path.dirname(KERNEL), 'hooks', '_exceptions.js'));

  /** Rewrite the base fixture's config with `exceptions` set to `value`, or removed when undefined. */
  const withExceptions = (dir, value) => {
    const file = path.join(dir, 'respawnpack.config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value === undefined) delete cfg.exceptions; else cfg.exceptions = value;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  };

  test('a declared list is CONFIGURED, names both counts, and does not move the exit code', () => {
    const p = project();
    try {
      const before = cli(p.dir, 'doctor');
      assert.equal(exceptionsRow(before).label, 'NOT_CONFIGURED', 'precondition: the base fixture declares no exceptions');

      withExceptions(p.dir, [
        {
          id: 'aws-doc-example-key',
          rule: 'secret-scan',
          match: { fingerprint: excLib.fingerprint('the example key line, quoted in the setup guide'), path: 'docs/aws-setup.md' },
          reason: 'the AWS documentation example key quoted in the setup guide',
          declaredBy: 'owner',
        },
        {
          id: 'stale-scratch', rule: 'worktree-guard', match: { path: 'scratch/**' },
          reason: 'the scratch mount is disposable', expires: '2020-01-01',
        },
      ]);
      const after = cli(p.dir, 'doctor');
      const row = exceptionsRow(after);
      assert.equal(row.label, 'CONFIGURED');
      assert.match(row.detail, /2 declared \(1 expired\)/,
        'the row must carry BOTH counts: an expired exception lifts nothing, and "2 declared" alone hides the one that stopped working');
      assert.match(row.detail, /aws-doc-example-key \(secret-scan\)/, 'the row must name each declared exception and the rule it lifts');
      assert.match(row.detail, /stale-scratch/, 'the row must name the entry that expired, or the count is unactionable');
      assert.equal(row.domain, 'coverage', 'the exceptions row answers a DECISION question, like the posture and onboarding rows');
      assert.equal(row.subject, 'respawnpack.config.json', 'the row must say what it looked at, and that is the declaration');

      assert.equal(after.code, before.code,
        'declaring a valid exception changed doctor\'s exit code. P1-E-1a adds a reader and a row and must change no verdict anywhere');
      assert.equal(after.json.outcome, before.json.outcome);
    } finally { rm(p.dir); }
  });

  test('an absent key and a present empty list are both NOT_CONFIGURED and green', () => {
    const p = project();
    try {
      const absent = cli(p.dir, 'doctor');
      assert.equal(absent.code, 0, 'the base fixture is green, so an absent exceptions key must not be what makes it red');
      const row = exceptionsRow(absent);
      assert.equal(row.label, 'NOT_CONFIGURED');
      assert.match(row.detail, /no `exceptions` key/, 'the row must say what it actually read');

      withExceptions(p.dir, []);
      const empty = cli(p.dir, 'doctor');
      assert.equal(empty.code, 0, 'a declared but empty list must stay green');
      assert.equal(exceptionsRow(empty).label, 'NOT_CONFIGURED',
        'a list that lifts nothing is not configured — reporting it CONFIGURED would claim an allowance that does not exist');
    } finally { rm(p.dir); }
  });

  test('an INVALID list is BROKEN and NOT green, for each of the five malformed shapes', () => {
    /*
     * ⛔ ONE FIXTURE PER SHAPE. A row that merely said "invalid" would leave a founder with a config to
     * re-read line by line, and the whole point of refusing the list rather than dropping an entry is
     * that the refusal can name what was wrong.
     */
    const shapes = [
      ['an entry with no reason', [{ id: 'a', rule: 'secret-scan', match: { path: 'docs/a.md' } }], /reason/],
      ['a rule with no subject notion', [{ id: 'a', rule: 'lockdown', match: { path: 'docs/a.md' }, reason: 'r' }], /no subject notion/],
      ['a match with no subject', [{ id: 'a', rule: 'secret-scan', match: {}, reason: 'r' }], /names no subject/],
      ['a subject kind the rule lacks', [{ id: 'a', rule: 'injection-scan', match: { command: `sha256:${'a'.repeat(64)}` }, reason: 'r' }], /has no such subject/],
      ['a malformed expires', [{ id: 'a', rule: 'secret-scan', match: { path: 'docs/a.md' }, reason: 'r', expires: 'soon' }], /YYYY-MM-DD/],
    ];
    for (const [what, value, expected] of shapes) {
      const p = project();
      try {
        withExceptions(p.dir, value);
        const r = cli(p.dir, 'doctor');
        const row = exceptionsRow(r);
        assert.equal(row.label, 'BROKEN', `${what} must be BROKEN`);
        assert.match(row.detail, /INVALID/, `${what}: the row must say the declaration is invalid`);
        assert.match(row.detail, expected, `${what}: the row must name what was wrong, not merely that something was`);
        assert.notEqual(r.code, 0, `${what} left doctor green — a refused allowance that reports as healthy is the fault wearing the costume of a decision`);
      } finally { rm(p.dir); }
    }
  });

  test('a list that is not an array, and an unparseable config, are both BROKEN rather than reported as nothing declared', () => {
    const p = project();
    try {
      withExceptions(p.dir, { 'aws-key': true });
      const notArray = cli(p.dir, 'doctor');
      assert.equal(exceptionsRow(notArray).label, 'BROKEN');
      assert.match(exceptionsRow(notArray).detail, /expected an array/);
      assert.notEqual(notArray.code, 0);

      fs.writeFileSync(path.join(p.dir, 'respawnpack.config.json'), '{ "exceptions": [ { "id": "x" ');
      const r = cli(p.dir, 'doctor');
      const row = exceptionsRow(r);
      assert.equal(row.label, 'BROKEN');
      assert.match(row.detail, /UNREADABLE|not parseable/i, 'the row must name the config as unreadable');
      assert.notEqual(row.label, 'NOT_CONFIGURED',
        'an unreadable config reported as NOT_CONFIGURED would be a fault indistinguishable from a project that declared nothing');
    } finally { rm(p.dir); }
  });

  /*
   * ⛔ THE MODULE-CONTRACT FENCE, NAMED FOR THIS MODULE. The two-directional derivations live in the
   * registry-drift describe above and now cover `_exceptions.js` like every other shipped shared module;
   * what is asserted HERE is the pair of facts that make that coverage possible at all, because both
   * are easy to omit and neither fails loudly on its own: the module has a contract entry (without one
   * a shipped module is reported on loadability alone), and the kernel's own cross-tree list names it
   * (without that, a module only the kernel reads gets no doctor row and no degradation coverage).
   */
  test('⛔ _exceptions.js is a registered shared module the kernel declares that it reaches', () => {
    assert.ok(modhealthLib.SHARED['_exceptions.js'],
      'hooks/_exceptions.js ships with no declared contract, so doctor could only say that it loads — the exemption for an unregistered file is for files this pack does not ship');
    // `allowed` and `fingerprint` joined at E-1b: secret-scan.js is the first guard to consult them
    // (resolve() alone was doctor's whole reading). E-1c and E-1d consult the same two members, so this
    // stays the final shape; `EXCEPTION_RULES` has no production consumer yet and is still absent.
    assert.deepEqual(Object.keys(modhealthLib.SHARED['_exceptions.js']), ['resolve', 'allowed', 'fingerprint'],
      'the declared contract must be exactly what production reads today: doctor calls resolve(), and secret-scan.js (E-1b) calls allowed() and fingerprint() for every HIGH hit');

    const src = fs.readFileSync(path.join(KERNEL, 'respawnpack.js'), 'utf8');
    assert.match(src, /const KERNEL_CROSS_TREE = \[[^\]]*EXCEPTIONS_PATH[^\]]*\]/,
      'kernel/respawnpack.js reaches hooks/_exceptions.js but does not list it in KERNEL_CROSS_TREE, so doctor would give it no row at all');
  });
});

/*
 * ⛔ P2-I-3 · DOCTOR'S projectType AND subagents ROWS — intent over mechanics, made visible in one place.
 *
 * Class B ("Visibility", the class audit): a founder declares intent — a project type, a posture — and
 * the mechanics that follow should be readable in one place rather than requiring a reader to open
 * install.js or hooks/spawn-guard.js to find out what their declaration actually does. These two rows
 * are that place, sitting beside the posture and exceptions rows above in respawnpack.js on purpose.
 *
 * Fixtures come from ops/_project-fixtures.mjs's four archetypes (materialize()) rather than a
 * hand-rolled tree per test — docs-only, ops-infra and greenfield-app are all exercised below, which is
 * the "prove on more than one project" half of the class's own design rule.
 */
describe('P2-I-3 · doctor rows for intent', () => {
  const ROOT_DIR = path.dirname(KERNEL);
  const codeOf = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

  const projectTypeRow = (r) => (r.json.rows || []).find((x) => x.check === 'projectType');
  const subagentsRow = (r) => (r.json.rows || []).find((x) => x.check === 'subagents');
  /** Fresh config for a fixture materialize() never writes one for. No merge needed — nothing to lose. */
  const writeConfig = (dir, value) => fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify(value, null, 2));
  /** The same marker `node .claude/hooks/spawn-guard.js --strict-on` would leave behind. */
  const writeMarker = (dir) => {
    fs.mkdirSync(path.join(dir, '.respawnpack'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.respawnpack', 'spawn-guard.strict'), '2026-01-01T00:00:00.000Z\n');
  };
  const fixture = (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-i3-${kind}-`));
    materialize(kind, dir);
    return dir;
  };

  /*
   * ⛔ THE TWO SOURCE FENCES. Both rows restate a fact the task's own design ruled out reading live:
   * install.js executes real side effects at require time (no `module.exports`, no `require.main`
   * guard), and spawn-guard.js's ceiling formula, marker path and DECLARED-only rule are its own small
   * expressions, not exported members doctor could import. Both are read as SOURCE TEXT instead — never
   * a require of either file — the same technique the KERNEL_CROSS_TREE fence above uses.
   */
  test('⛔ DOCTOR_PROJECT_TYPE_DROPS matches install.js\'s real PROJECT_TYPE_DROPS, read from source rather than required', () => {
    const extractDrops = (text, constName) => {
      const m = new RegExp(`const ${constName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(text);
      assert.ok(m, `${constName} is no longer an object literal in the expected shape`);
      const out = {};
      for (const row of m[1].matchAll(/'([\w-]+)':\s*\[([^\]]*)\]/g)) {
        out[row[1]] = [...row[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      }
      return out;
    };
    const installReal = extractDrops(codeOf('install/install.js'), 'PROJECT_TYPE_DROPS');
    const doctorCopy = extractDrops(codeOf('kernel/respawnpack.js'), 'DOCTOR_PROJECT_TYPE_DROPS');
    assert.deepEqual(doctorCopy, installReal,
      'kernel/respawnpack.js\'s restated project-type drop table has drifted from install/install.js\'s real '
      + 'PROJECT_TYPE_DROPS — the projectType row would name the wrong sections, or the wrong types, as dropped');
    assert.deepEqual(Object.keys(installReal).sort(), ['docs-only', 'greenfield-app', 'mature-product', 'ops-infra'],
      'install.js\'s four known project types moved; this fence and the fixtures below assume exactly these four');
  });

  test('⛔ the subagents row\'s ceiling formula, marker path and DECLARED-only deny rule match hooks/spawn-guard.js\'s source', () => {
    const src = codeOf('hooks/spawn-guard.js');
    assert.match(src, /const CEILING = Number\(process\.env\.RESPAWNPACK_SPAWN_CEILING\) \|\| 8;/,
      'spawn-guard.js\'s ceiling formula changed; the doctor row restates it and would now print the wrong number');
    assert.match(src, /path\.join\(dir,\s*'\.respawnpack',\s*'spawn-guard\.strict'\)/,
      'spawn-guard.js no longer checks the marker at .respawnpack/spawn-guard.strict; the doctor row checks the wrong path');
    assert.match(src, /stance\.source === 'DECLARED' && ruleVerdict === 'deny'/,
      'spawn-guard.js\'s DECLARED-only hard-deny condition changed; the doctor row would report denied/advised backwards');
  });

  describe('the projectType row · CONFIGURED, NOT_CONFIGURED, BROKEN', () => {
    test('CONFIGURED on ops-infra names the dropped section, and does not move the exit code', () => {
      const dir = fixture('ops-infra');
      try {
        const before = cli(dir, 'doctor');
        assert.equal(projectTypeRow(before).label, 'NOT_CONFIGURED', 'precondition: materialize() writes no respawnpack.config.json at all');

        writeConfig(dir, { projectType: 'ops-infra' });
        const after = cli(dir, 'doctor');
        const row = projectTypeRow(after);
        assert.equal(row.label, 'CONFIGURED');
        assert.match(row.detail, /WITHOUT the performance section/, 'the row must name the section ops-infra drops');
        assert.equal(row.domain, 'coverage', 'projectType answers a DECISION question, like posture and exceptions');
        assert.equal(row.subject, 'respawnpack.config.json');

        assert.equal(after.code, before.code, 'declaring a valid, known projectType must not move doctor\'s exit code');
        assert.equal(after.json.outcome, before.json.outcome);

        const rows = after.json.rows || [];
        assert.equal(rows.filter((x) => x.check === 'projectType').length, 1, 'the one-row-per-component fence: exactly one projectType row');
        assert.ok(!rows.some((x) => x.check.startsWith('doctor:row-collision:')), 'no row-collision row was produced');
      } finally { rm(dir); }
    });

    test('NOT_CONFIGURED on greenfield-app when the config declares no projectType key', () => {
      const dir = fixture('greenfield-app');
      try {
        writeConfig(dir, { posture: { profile: 'standard' } }); // a real config, deliberately with no projectType key
        const r = cli(dir, 'doctor');
        const row = projectTypeRow(r);
        assert.equal(row.label, 'NOT_CONFIGURED');
        assert.match(row.detail, /no projectType declared/);
        assert.match(row.detail, /docs-only, ops-infra, greenfield-app, mature-product/);
      } finally { rm(dir); }
    });

    test('BROKEN on docs-only when projectType is declared and is not one of the four known values', () => {
      const dir = fixture('docs-only');
      try {
        writeConfig(dir, { projectType: 'webapp' });
        const r = cli(dir, 'doctor');
        const row = projectTypeRow(r);
        assert.equal(row.label, 'BROKEN');
        assert.match(row.detail, /"webapp"/);
        assert.match(row.detail, /docs-only, ops-infra, greenfield-app, mature-product/);
        assert.notEqual(r.code, 0, 'an unknown projectType left doctor green — the installer refused this exact declaration');
      } finally { rm(dir); }
    });
  });

  describe('the subagents row · ACTIVE, with the DECLARED-only deny rule (owner decisions 26, 28)', () => {
    test('a DECLARED strict posture on docs-only is a hard DENY above the ceiling', () => {
      const dir = fixture('docs-only');
      try {
        writeConfig(dir, { posture: { profile: 'strict' } });
        const row = subagentsRow(cli(dir, 'doctor'));
        assert.equal(row.label, 'ACTIVE');
        assert.match(row.detail, /ceiling \d+/);
        assert.match(row.detail, /deny under strict \(DECLARED\)/);
        assert.match(row.detail, /marker absent/);
        assert.match(row.detail, /DENIED/);
      } finally { rm(dir); }
    });

    test('a DEFAULTED posture on docs-only (nobody declared one) is only ADVISED, though the raw verdict is still deny', () => {
      const dir = fixture('docs-only'); // materialize() writes no respawnpack.config.json at all
      try {
        const row = subagentsRow(cli(dir, 'doctor'));
        assert.equal(row.label, 'ACTIVE');
        assert.match(row.detail, /deny under strict \(DEFAULTED\)/,
          'the raw table verdict is still deny for the strict profile a DEFAULTED source resolves to — only the real effect differs');
        assert.match(row.detail, /ADVISED/, 'a DEFAULTED strict must not read as a hard deny — only a DECLARED strict or the marker denies');
      } finally { rm(dir); }
    });

    test('the marker present under a DECLARED light posture on docs-only is a DENY, though light\'s own verdict is only advise', () => {
      const dir = fixture('docs-only');
      try {
        writeConfig(dir, { posture: { profile: 'light' } });
        writeMarker(dir);
        const row = subagentsRow(cli(dir, 'doctor'));
        assert.equal(row.label, 'ACTIVE');
        assert.match(row.detail, /advise under light \(DECLARED\)/, 'the raw verdict under light is advise, named honestly even though the marker denies anyway');
        assert.match(row.detail, /marker present/);
        assert.match(row.detail, /DENIED/, 'the marker alone must force a hard deny, even though light\'s own verdict is advise');
      } finally { rm(dir); }
    });

    test('the marker toggling denyMode does not move doctor\'s exit code by itself — both states are ACTIVE', () => {
      const dir = fixture('greenfield-app');
      try {
        writeConfig(dir, { posture: { profile: 'light' } });
        const before = cli(dir, 'doctor');
        assert.equal(subagentsRow(before).label, 'ACTIVE');
        assert.match(subagentsRow(before).detail, /ADVISED/);

        writeMarker(dir);
        const after = cli(dir, 'doctor');
        assert.equal(subagentsRow(after).label, 'ACTIVE');
        assert.match(subagentsRow(after).detail, /DENIED/);

        assert.equal(after.code, before.code,
          'the marker moved the subagents row\'s verdict from advised to denied, and both are ACTIVE — the row itself never '
          + 'moves the exit code, only the fact it reports');
        assert.equal(after.json.outcome, before.json.outcome);

        const rows = after.json.rows || [];
        assert.equal(rows.filter((x) => x.check === 'subagents').length, 1, 'the one-row-per-component fence: exactly one subagents row');
        assert.ok(!rows.some((x) => x.check.startsWith('doctor:row-collision:')), 'no row-collision row was produced');
      } finally { rm(dir); }
    });
  });

  test('an unreadable respawnpack.config.json yields the rows doctor already gives for that case, not a crash', () => {
    const dir = fixture('docs-only');
    try {
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), '{ "projectType": ');
      const r = cli(dir, 'doctor');
      assert.ok(r.json, 'doctor must still print a full JSON report on a malformed config, not die on it');
      assert.equal(projectTypeRow(r).label, 'NOT_CONFIGURED',
        'an unparseable config is read as nothing declared — install.js\'s own rule for this file, not a refusal');
      const sa = subagentsRow(r);
      assert.equal(sa.label, 'ACTIVE',
        'the subagents row must still print — _posture.js resolves an unreadable config to strict/UNREADABLE on its own, '
        + 'and doctor\'s existing posture row is what reports the damage');
      assert.match(sa.detail, /\(UNREADABLE\)/);
      assert.match(sa.detail, /ADVISED/, 'UNREADABLE never arms the hard deny by itself, same as DEFAULTED');
    } finally { rm(dir); }
  });
});

// --- P3-K-14 · the profile-gated kernel libs, and the boundary that had to move before them ----------
//
// ⛔ WHAT THIS SECTION IS FOR. ADR-003's rule table reads `kernel:R4 reconcile | n.a., not installed |
// advise | deny`, so `install/install.js` now places `lib/reconcile.js` for `standard` and `strict` and
// not for `light`. Until this task that cell could never be true — every install laid all thirteen
// kernel files — and `kernel/lib/applicability.js` and `kernel/lib/state.js` BOTH hard-required the
// module at load. Un-placing it before moving those two would have turned a founder's own declaration
// into a MODULE_NOT_FOUND raised out of the compiler every verb loads: a stack trace where anti-drift
// item 17 requires a row. So the boundary moved first, and this is what holds it.
//
// THREE STATES, and the middle one is the whole task:
//   present            the row is classified from the declaration exactly as it always was
//   absent BY PROFILE  NOT_APPLICABLE, authored, naming the posture and ADR-003's row — and the
//                      reconciliation check savepoint folds in relaxes with it
//   absent ANYWAY      INVALID under a posture that carries the contract. A profile may decide a
//                      contract does not apply here; it may not excuse a missing subsystem

// The subsystem registry, read from source: which files a profile may withhold is DERIVED from it
// (`PROFILE_GATED`), so this section is covered the day another subsystem joins that set.
const modhealthLib = createRequire(import.meta.url)('./lib/modhealth.js');

/** kernel/lib/ and hooks/ copied where the kernel's own `../../hooks` resolution still finds them. */
function kernelTreeCopy(missing = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-libgate-'));
  fs.cpSync(path.join(KERNEL, 'lib'), path.join(dir, 'kernel', 'lib'), { recursive: true });
  fs.cpSync(path.join(path.dirname(KERNEL), 'hooks'), path.join(dir, 'hooks'), { recursive: true });
  for (const f of missing) fs.rmSync(path.join(dir, 'kernel', 'lib', f));
  return dir;
}

/*
 * Survey a project through a COPIED kernel, OUT OF PROCESS. A module this suite has already imported
 * cannot be un-required, so an in-process probe would answer from Node's cache and report a subsystem
 * that is no longer there — the same reason install.test.mjs spawns a fresh doctor per damage mode. The
 * posture is resolved and handed down exactly as `kernel/respawnpack.js` does it: once, from
 * `hooks/_posture.js`, never re-read per row.
 */
function surveyThrough(treeDir, projectDir) {
  const script = `
    const applicability = require(process.argv[1]);
    const stateLib = require(process.argv[2]);
    const postureLib = require(process.argv[3]);
    const dir = process.argv[4];
    const resolved = postureLib.resolve(dir);
    const policy = { profile: resolved.profile, source: resolved.source, verdict: (id) => postureLib.verdict(resolved, id) };
    const surveyed = applicability.survey(dir, policy);
    const compiled = stateLib.compile(dir);
    const relaxed = applicability.relaxCoverage(compiled.reconciliation.checks, surveyed);
    console.log(JSON.stringify({
      row: surveyed.rows.find((r) => r.subsystem === 'reconcile'),
      unresolved: surveyed.unresolved,
      reconcileCheck: relaxed.find((c) => c.check === 'reconcile'),
      stateReconciliation: compiled.state.reconciliation,
    }));
  `;
  const lib = (f) => path.join(treeDir, 'kernel', 'lib', f);
  const r = spawnSync(process.execPath, [
    '-e', script,
    lib('applicability.js'), lib('state.js'), path.join(treeDir, 'hooks', '_posture.js'), projectDir,
  ], { encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null; the caller asserts on it */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

describe('P3-K-14 · a kernel subsystem a profile does not install', () => {
  test('present · the reconcile row is classified from the declaration, and says NOT-CARRIED rather than NOT-INSTALLED', () => {
    const tree = kernelTreeCopy();
    for (const profile of postureLib.PROFILES) {
      const p = bareProject(postured(profile));
      try {
        const r = surveyThrough(tree, p.dir);
        assert.ok(r.json, `${profile}: the survey produced no output. exit=${r.code} stderr=${r.stderr.slice(0, 400)}`);
        assert.match(r.json.row.detail, /declares no task source/,
          `${profile}: the row stopped reading the declaration it exists to read`);
        if (profile === 'light') {
          /*
           * ⛔ THE DISCRIMINATION THIS TASK TURNS ON. K-10 already answered this row under `light` — the
           * profile does not CARRY the contract — and that held with the file sitting right there. The new
           * state is the file being GONE, and it must not be reachable by rewording: the two rows read
           * NOT_APPLICABLE alike, and only one of them says the subsystem was not installed.
           */
          assert.equal(r.json.row.state, 'NOT_APPLICABLE');
          assert.equal(r.json.row.postureRelaxed, 'light');
          assert.match(r.json.row.detail, /does not carry the task\/record reconciliation/);
          assert.doesNotMatch(r.json.row.detail, /does not install/,
            'a row about an INSTALLED subsystem claimed the profile had not installed it');
        } else {
          // `standard` advises and `strict` refuses (ADR-003), which is K-10's mechanism (a) and (none):
          // either way the row's own STATE is untouched, because it is still true that nobody decided.
          assert.equal(r.json.row.state, 'UNDECIDED',
            `${profile}: with the subsystem installed and no state.reconcile declared, the honest answer is still that nobody decided`);
          assert.doesNotMatch(r.json.row.detail, /does not install/,
            `${profile}: a row about an INSTALLED subsystem claimed the profile had not installed it`);
          assert.equal(r.json.reconcileCheck.outcome, profile === 'standard' ? OUTCOME.PASS : OUTCOME.CANNOT_DETERMINE,
            `${profile}: the reconciliation check is not what ADR-003's cell says it should be`);
        }
      } finally { rm(p.dir); }
    }
    rm(tree);
  });

  test('absent by profile · NOT_APPLICABLE, naming the posture and ADR-003 kernel:R4, and the check relaxes with it', () => {
    const tree = kernelTreeCopy(['reconcile.js']);
    const p = bareProject(postured('light'));
    try {
      const r = surveyThrough(tree, p.dir);
      assert.ok(r.json, `the survey produced no output — an absent subsystem must never take the survey down with it. exit=${r.code} stderr=${r.stderr.slice(0, 400)}`);
      assert.equal(r.json.row.state, 'NOT_APPLICABLE');
      assert.equal(r.json.row.basis, 'declared',
        'what was declared is the POSTURE, in a tracked file — the row must not claim an inferred absence');
      assert.equal(r.json.row.postureRelaxed, 'light', 'the row did not record WHICH posture answered it');
      assert.equal(r.json.row.postureRule, 'kernel:R4', 'the row did not record which ADR-003 row it read');
      assert.match(r.json.row.detail, /does not install the reconciliation subsystem/,
        "the authored reason must say the profile did not install it — ADR-003's qualifier is \"never inferred from an absent task source\"");
      assert.ok(!r.json.unresolved.includes('reconcile'), 'a row the posture answered still counted as unresolved onboarding');

      /*
       * ⛔ AND THE CHECK SAVEPOINT FOLDS IN MOVES WITH IT. The compiler cannot know an absence was
       * CHOSEN, so it emits CANNOT_DETERMINE tagged `domain: 'coverage'`; `relaxCoverage` is the one seam
       * that applies the survey's decision to it. Without this half a `light` savepoint would still exit
       * 2 over a subsystem the founder's own declaration asked not to have.
       */
      assert.equal(r.json.reconcileCheck.outcome, OUTCOME.NOT_APPLICABLE);
      assert.equal(r.json.reconcileCheck.postureRelaxed, 'light');
      assert.equal(r.json.stateReconciliation.status, 'CANNOT_DETERMINE',
        'STATE.json records what the COMPILER found, which is that it could not run one. The posture answers the CHECK; compiled state is not rewritten to agree with it');
    } finally { rm(p.dir); rm(tree); }
  });

  test('absent anyway · INVALID under a posture that carries the contract, and nothing relaxes it', () => {
    const tree = kernelTreeCopy(['reconcile.js']);
    for (const profile of ['standard', 'strict']) {
      const p = bareProject(postured(profile));
      try {
        const r = surveyThrough(tree, p.dir);
        assert.ok(r.json, `${profile}: the survey produced no output. exit=${r.code} stderr=${r.stderr.slice(0, 400)}`);
        assert.equal(r.json.row.state, 'INVALID',
          `${profile}: a subsystem missing where the profile expects it is breakage, not a decision`);
        assert.equal(r.json.row.basis, 'unloadable');
        assert.ok(!r.json.row.postureRelaxed, `${profile} relaxed a row ADR-003 gives it no cell for`);
        assert.ok(r.json.unresolved.includes('reconcile'), `${profile}: a damaged install read as fully onboarded`);
        assert.equal(r.json.reconcileCheck.outcome, OUTCOME.CANNOT_DETERMINE,
          `${profile}: the reconciliation check went green over a subsystem that is not there`);
      } finally { rm(p.dir); }
    }
    rm(tree);
  });

  /*
   * ⛔ THE FENCE THE RISK ACTUALLY NEEDED, DERIVED FROM SOURCE. Both readers reached `reconcile.js` with
   * a bare `require('./reconcile.js')` at module scope, and either one restored would put the
   * MODULE_NOT_FOUND back — silently, because every test above still passes on a tree where the file is
   * present. So the SHAPE is asserted as well as the behaviour: no kernel module hard-requires a gated
   * subsystem at load, and both readers bind it through the probe that classifies its five states.
   */
  test('fence · no kernel module hard-requires the gated subsystem at load, and both readers probe it', () => {
    const gated = Object.keys(modhealthLib.PROFILE_GATED);
    assert.ok(gated.length, 'modhealthLib.PROFILE_GATED is empty — this fence would pass over nothing');
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const file of gated) {
      for (const f of fs.readdirSync(path.join(KERNEL, 'lib')).filter((x) => x.endsWith('.js') && x !== file)) {
        const code = strip(fs.readFileSync(path.join(KERNEL, 'lib', f), 'utf8'));
        assert.equal(new RegExp(`^const [\\w$]+ = require\\('\\./${file.replace('.', '\\.')}'\\)`, 'm').test(code), false,
          `kernel/lib/${f} hard-requires ${file} at module scope. A profile may not install it (ADR-003 ${modhealthLib.PROFILE_GATED[file]}), `
          + 'and a require that throws turns that declaration into a stack trace out of every verb that loads this module');
      }
    }
    for (const reader of ['applicability.js', 'state.js']) {
      const code = strip(fs.readFileSync(path.join(KERNEL, 'lib', reader), 'utf8'));
      assert.match(code, /const reconcileHealth = modhealth\.probePath\(RECONCILE_PATH\)/,
        `kernel/lib/${reader} no longer probes the reconciler through modhealth — absent, unparseable, throwing and contract-violating would stop being four answers`);
      assert.match(code, /const reconcileLib = reconcileHealth\.module/,
        `kernel/lib/${reader} takes the module from somewhere other than the probe, so a non-OK status could hand back a half-usable object`);
    }
  });
});

// --- P2-P-1 · the provenance contract (Class D) -----------------------------------------------------
//
// ⛔ THE CLASS, NOT THE INSTANCE. The owner's own case is a range's Guacamole configuration cloned from
// the TEMPLATE box instead of the per-range box, and it is one instance of a class: anything cloned,
// copied, migrated or regenerated has a source, and a project usually has an opinion about which source
// is the truth. So the fixtures below are three different project archetypes from
// ops/_project-fixtures.mjs, not three variations of one — ops-infra (an inventory and a derived config),
// greenfield-app (an OpenAPI document and a generated client), docs-only (a template and a copy).
//
// ⛔ AND A MARKER IS VERIFIED, NEVER TRUSTED (anti-drift item 55). Every PASS below is a marker whose
// recorded digest was recomputed from the source on disk; the "the source moved" and "stale digest"
// cases are the same marker after the source changed, and they FAIL.

describe('P2-P-1 · the provenance contract: a declared lineage, a verified marker, a savepoint stage', () => {
  const lineageLib = createRequire(import.meta.url)(path.join(KERNEL, 'lib', 'lineage.js'));
  const manifestLib = createRequire(import.meta.url)(path.join(path.dirname(KERNEL), 'hooks', '_manifest.js'));

  const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

  /**
   * One project archetype, with the pack's five optional contracts DECIDED so that `onboarding` is
   * COMPLETE and a savepoint can reach exit 0 — which is what makes the exit-code guarantee below
   * (a project with no lineage declaration is unaffected by this contract) a claim about lineage
   * rather than about a fixture that was never green.
   */
  function lineageFixture(kind, lineage = null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-lineage-${kind}-`));
    materializeProject(kind, dir, { git: false });
    const sd = path.join(dir, stateLib.STATE_DIR);
    fs.mkdirSync(path.join(sd, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'requirements.json'), JSON.stringify({ schemaVersion: '1.0.0', denominatorVersion: 'lineage-1', requirements: [{ id: 'R-1', mandatory: true }], gates: {} }, null, 2));
    fs.writeFileSync(path.join(sd, 'goal.json'), '{}\n');
    if (lineage) fs.writeFileSync(path.join(sd, 'lineage.json'), `${JSON.stringify(lineage, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({
      routeSource: { notApplicable: true, reason: 'lineage fixture: this project serves no routes' },
      codeTruth: { notApplicable: true, reason: 'lineage fixture: no code-truth source' },
      qualityGate: { notApplicable: true, reason: 'lineage fixture: quality checks are outside these tests' },
      state: {
        removals: { notApplicable: 'lineage fixture: this project has retired nothing' },
        reconcile: { notApplicable: true, reason: 'lineage fixture: no task system to reconcile against' },
      },
    }, null, 2));
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'lineage@respawnpack.test'); git('config', 'user.name', 'Lineage');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A'); git('commit', '--quiet', '-m', 'fixture');
    return dir;
  }

  /** Write `rel` with the marker line the pack's own module spells, naming `sourceId` at `sourceRel`'s digest. */
  const stampInto = (dir, rel, sourceId, sourceRel, body) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# ${lineageLib.MARKER.prefix} ${sourceId}@sha256:${sha(path.join(dir, ...sourceRel.split('/')))}\n${body}`);
  };

  const rowOf = (json, id) => (json.checks || []).find((c) => c.check === `lineage:${id}`);

  // The ops-infra declaration, in the shape the owner's own case has: the per-range inventory is the
  // truth, the template box must NEVER be, and the guac config is generated from the first.
  const opsLineage = (over = {}) => ({
    schemaVersion: '1.0.0',
    sources: [
      { id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' },
      { id: 'template-inventory', kind: 'template', path: 'inventory/template.yml', authority: 'source-of-truth' },
    ],
    derivations: [{ id: 'guac-config', target: 'config/guac/range.conf', from: ['range-inventory'], how: 'generate', neverFrom: ['template-inventory'], ...over }],
  });

  /*
   * STATE 1 · THE CORRECTED CASE. ops-infra, the config generated from the per-range inventory and
   * stamped with that inventory's current digest. PASS at exit 0 through both the verb and the stage.
   */
  test('ops-infra · a config stamped from the per-range inventory PASSes, through the verb and the stage alike', () => {
    const dir = lineageFixture('ops-infra', opsLineage());
    try {
      stampInto(dir, 'config/guac/range.conf', 'range-inventory', 'inventory/range.yml', 'guacd_hostname: range-host-1\n');
      const v = cli(dir, 'lineage');
      assert.equal(v.code, 0, `the verb must pass: ${JSON.stringify(v.json && v.json.checks)}`);
      assert.equal(rowOf(v.json, 'guac-config').outcome, 'PASS');
      assert.equal(rowOf(v.json, 'guac-config').checked, 1, 'a PASS must say how many files it actually read');
      assert.deepEqual(v.json.counts, { sources: 2, derivations: 1, pass: 1, fail: 0, undetermined: 0 });

      // The stage reports the identical row — one computation behind two surfaces, never two opinions.
      const s = cli(dir, 'savepoint', '--verify');
      assert.deepEqual(rowOf(s.json, 'guac-config'), rowOf(v.json, 'guac-config'),
        'the savepoint stage and the `lineage` verb must report the same row for the same tree');
    } finally { rm(dir); }
  });

  /*
   * STATE 2 · THE DEFECT, AND IT IS THE OWNER'S OWN. The config is stamped from the TEMPLATE box. It
   * parses, it has a perfectly good marker, and it is wrong — so the detail has to name BOTH the source
   * the marker claims and the source the derivation declares, or the reader has to open three files.
   */
  test('ops-infra · the guac case · a marker naming a neverFrom source FAILs and names both sources', () => {
    const dir = lineageFixture('ops-infra', opsLineage());
    try {
      stampInto(dir, 'config/guac/range.conf', 'template-inventory', 'inventory/template.yml', 'guacd_hostname: template-host\n');
      const v = cli(dir, 'lineage');
      assert.equal(v.code, 1, 'a copy taken from the source the project declared it must never come from is a FAIL, not an open question');
      const row = rowOf(v.json, 'guac-config');
      assert.equal(row.outcome, 'FAIL');
      assert.match(row.detail, /template-inventory/, 'the detail must name the source the MARKER claimed');
      assert.match(row.detail, /range-inventory/, 'the detail must name the source the DERIVATION declares');
      assert.match(row.detail, /NEVER/, 'the detail must say the marker named a forbidden source rather than merely an unexpected one');
      assert.equal(v.json.counts.fail, 1);
      assert.deepEqual(v.json.checks.filter((c) => c.outcome === 'PASS'), [], 'nothing about this tree may report a pass');
    } finally { rm(dir); }
  });

  /*
   * STATE 3 · THE SOURCE MOVED. The marker is CORRECT about which source it came from, which is exactly
   * why a check that only compared ids would report this tree clean. The digest is the half that makes
   * a marker a claim rather than a comment.
   */
  test('ops-infra · a correct marker whose source has since changed FAILs as "the source moved"', () => {
    const dir = lineageFixture('ops-infra', opsLineage());
    try {
      stampInto(dir, 'config/guac/range.conf', 'range-inventory', 'inventory/range.yml', 'guacd_hostname: range-host-1\n');
      assert.equal(cli(dir, 'lineage').code, 0, 'sanity: it must pass BEFORE the source moves, or this test proves nothing');

      fs.appendFileSync(path.join(dir, 'inventory', 'range.yml'), '    range-host-3:\n      ansible_host: 10.0.0.13\n');
      const v = cli(dir, 'lineage');
      assert.equal(v.code, 1);
      const row = rowOf(v.json, 'guac-config');
      assert.equal(row.outcome, 'FAIL');
      assert.match(row.detail, /the source moved since the derivation/);
      assert.match(row.detail, /sha256:[0-9a-f]{12} and it is now sha256:[0-9a-f]{12}/, 'both digests must be shown, or the reader cannot tell which end changed');
    } finally { rm(dir); }
  });

  /*
   * STATE 4 · THE NEAREST BYPASS TO A FAILURE: NO TARGET AT ALL. A partial checkout, a tree that was
   * never generated here, and a file somebody deleted look identical from inside this check, so the
   * default is the weaker answer — and `required: true` is how a project says it is not one of those.
   */
  test('ops-infra · an absent target is CANNOT_DETERMINE, and FAIL only when the derivation declares it required', () => {
    const open = lineageFixture('ops-infra', opsLineage());
    try {
      const v = cli(open, 'lineage');
      assert.equal(v.code, 2, 'a target that is not there and not declared required is undetermined, never a failure and never a pass');
      const row = rowOf(v.json, 'guac-config');
      assert.equal(row.outcome, 'CANNOT_DETERMINE');
      assert.equal(row.checked, 0);
      assert.match(row.detail, /"required": true/, 'the row must name the declaration that would turn this into a breach');
    } finally { rm(open); }

    const strict = lineageFixture('ops-infra', opsLineage({ required: true }));
    try {
      const v = cli(strict, 'lineage');
      assert.equal(v.code, 1, 'a REQUIRED target that is absent is a breach of a stated contract, which is FAIL');
      assert.equal(rowOf(v.json, 'guac-config').outcome, 'FAIL');
      assert.match(rowOf(v.json, 'guac-config').detail, /required/);
    } finally { rm(strict); }
  });

  /*
   * A SECOND ARCHETYPE, A DIFFERENT SHAPE OF THE SAME CLASS. greenfield-app: `openapi.yaml` is the
   * truth and a generated client is derived from it, through a GLOB target rather than one path —
   * because one unmarked file in a generated tree is the case a per-file declaration would never catch.
   */
  const webLineage = () => ({
    schemaVersion: '1.0.0',
    sources: [{ id: 'api-schema', kind: 'schema', path: 'openapi.yaml', authority: 'source-of-truth' }],
    derivations: [{ id: 'generated-client', target: 'src/generated/**/*.js', from: ['api-schema'], how: 'generate' }],
  });

  test('greenfield-app · a generated client with a STALE digest FAILs, and every file under the glob is read', () => {
    const dir = lineageFixture('greenfield-app', webLineage());
    try {
      stampInto(dir, 'src/generated/client.js', 'api-schema', 'openapi.yaml', 'export const paths = ["/health"];\n');
      stampInto(dir, 'src/generated/models/user.js', 'api-schema', 'openapi.yaml', 'export const User = {};\n');
      const clean = cli(dir, 'lineage');
      assert.equal(clean.code, 0, `sanity: both generated files must pass first: ${JSON.stringify(clean.json && clean.json.checks)}`);
      assert.equal(rowOf(clean.json, 'generated-client').checked, 2, 'a glob target must read EVERY matching file, not the first one');

      // The schema moves and only ONE of the two generated files is regenerated. The row must still fail.
      fs.appendFileSync(path.join(dir, 'openapi.yaml'), '  /metrics:\n    get:\n      responses:\n        "200":\n          description: ok\n');
      stampInto(dir, 'src/generated/client.js', 'api-schema', 'openapi.yaml', 'export const paths = ["/health","/metrics"];\n');
      const v = cli(dir, 'lineage');
      assert.equal(v.code, 1);
      const row = rowOf(v.json, 'generated-client');
      assert.equal(row.outcome, 'FAIL');
      assert.match(row.detail, /models\/user\.js/, 'the stale file must be named');
      assert.doesNotMatch(row.detail, /generated\/client\.js records/, 'the file that WAS regenerated must not be reported as stale');
      assert.equal(row.checked, 2, 'the row still describes both files — a failure is not a smaller denominator');
    } finally { rm(dir); }
  });

  /*
   * A THIRD ARCHETYPE. docs-only: a customer document copied from a template, with NO marker at all —
   * the commonest state of every copy that has ever been made, and the one the remedy has to be written
   * for. It is CANNOT_DETERMINE (nobody said where it came from), never FAIL (nobody said it was wrong).
   */
  test('docs-only · a copy with no marker is CANNOT_DETERMINE, and the remedy tells you to declare one', () => {
    const dir = lineageFixture('docs-only', {
      schemaVersion: '1.0.0',
      sources: [{ id: 'guide-template', kind: 'template', path: 'docs/guide.md', authority: 'source-of-truth' }],
      derivations: [{ id: 'customer-guide', target: 'docs/customers/acme.md', from: ['guide-template'], how: 'copy' }],
    });
    try {
      fs.mkdirSync(path.join(dir, 'docs', 'customers'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'docs', 'customers', 'acme.md'), '# Acme guide\n\nRead this guide before making a change.\n');
      const v = cli(dir, 'lineage');
      assert.equal(v.code, 2, 'a copy nobody stamped is undetermined: nothing here says it is wrong, and nothing says it is right');
      const row = rowOf(v.json, 'customer-guide');
      assert.equal(row.outcome, 'CANNOT_DETERMINE');
      assert.match(row.detail, /records no provenance in its first 40 lines/);
      assert.match(row.detail, /declare the marker with `respawnpack lineage stamp docs\/customers\/acme\.md --from guide-template`/,
        'the remedy must be the exact command that fixes it, naming the file and the source');
    } finally { rm(dir); }
  });

  /*
   * ⛔ A SIDECAR IS THE SAME CLAIM IN ANOTHER FILE, AND A URL SOURCE IS AN HONEST BLIND SPOT. The first
   * is what a binary or generated tree uses; the second is a source whose bytes this pack cannot fetch,
   * because it makes no network call — so it says so rather than passing or failing on a guess.
   */
  test('a sidecar marker is read like an inline one, and a URL source is CANNOT_DETERMINE naming why', () => {
    const dir = lineageFixture('greenfield-app', {
      schemaVersion: '1.0.0',
      sources: [
        { id: 'api-schema', kind: 'schema', path: 'openapi.yaml', authority: 'source-of-truth' },
        { id: 'upstream', kind: 'schema', url: 'https://example.invalid/openapi.yaml', authority: 'source-of-truth' },
      ],
      derivations: [
        { id: 'binary-bundle', target: 'dist/bundle.bin', from: ['api-schema'], how: 'generate' },
        { id: 'vendored', target: 'vendor/upstream.json', from: ['upstream'], how: 'copy' },
      ],
    });
    try {
      fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist', 'bundle.bin'), Buffer.from([0, 1, 2, 3, 255]));
      fs.writeFileSync(path.join(dir, 'dist', `bundle.bin${lineageLib.MARKER.sidecarSuffix}`),
        `${JSON.stringify({ sourceId: 'api-schema', sourceDigest: sha(path.join(dir, 'openapi.yaml')), stampedAt: '2026-09-03T00:00:00.000Z' }, null, 2)}\n`);
      fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
      stampInto(dir, 'vendor/upstream.json', 'upstream', 'openapi.yaml', '{}\n');

      const v = cli(dir, 'lineage');
      assert.equal(rowOf(v.json, 'binary-bundle').outcome, 'PASS', 'a sidecar is a marker: a file with no comment syntax must still be able to carry one');
      const url = rowOf(v.json, 'vendored');
      assert.equal(url.outcome, 'CANNOT_DETERMINE', 'a source this pack cannot fetch must not be reported as verified OR as broken');
      assert.match(url.detail, /makes no network call/);
      assert.equal(v.code, 2);
    } finally { rm(dir); }
  });

  /*
   * ⛔ A DECLARATION WITH NO DERIVATION IS A CHECK WITH NOTHING TO CHECK, and the three states around it
   * are the whole of what "declared" can mean: absent (NOT_APPLICABLE), present and empty
   * (CANNOT_DETERMINE), present and unusable (CANNOT_DETERMINE, naming the refusal).
   */
  test('a declaration with sources and ZERO derivations is CANNOT_DETERMINE, not a pass', () => {
    const dir = lineageFixture('ops-infra', {
      schemaVersion: '1.0.0',
      sources: [{ id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' }],
      derivations: [],
    });
    try {
      const v = cli(dir, 'lineage');
      assert.equal(v.code, 2);
      const row = (v.json.checks || []).find((c) => c.check === 'lineage:declared');
      assert.ok(row, 'a declaration with no derivations must leave a row, not silence');
      assert.equal(row.outcome, 'CANNOT_DETERMINE');
      assert.equal(row.checked, 0);
      assert.deepEqual(v.json.counts, { sources: 1, derivations: 0, pass: 0, fail: 0, undetermined: 1 });
    } finally { rm(dir); }
  });

  test('a declaration this kernel cannot read is CANNOT_DETERMINE and derives NOTHING from it', () => {
    for (const [label, doc, expected] of [
      ['an unimplemented schemaVersion', { schemaVersion: '9.9.9', sources: [], derivations: [] }, /declares schemaVersion "9\.9\.9"/],
      ['a source with both a path and a url', { schemaVersion: '1.0.0', sources: [{ id: 's', kind: 'doc', path: 'a.md', url: 'https://x.invalid/a', authority: 'source-of-truth' }], derivations: [] }, /exactly one of `path` or `url`/],
      ['a derivation with an empty from list', { schemaVersion: '1.0.0', sources: [], derivations: [{ id: 'd', target: 'a.md', from: [], how: 'copy' }] }, /non-empty `from` array/],
      ['a duplicate source id', { schemaVersion: '1.0.0', sources: [{ id: 's', kind: 'doc', path: 'a.md', authority: 'source-of-truth' }, { id: 's', kind: 'doc', path: 'b.md', authority: 'source-of-truth' }], derivations: [] }, /declared twice/],
    ]) {
      const dir = lineageFixture('docs-only', doc);
      try {
        const v = cli(dir, 'lineage');
        assert.equal(v.code, 2, `${label}: a declaration that EXISTS and cannot be used is never a pass`);
        const row = (v.json.checks || []).find((c) => c.check === 'lineage:declaration');
        assert.equal(row.outcome, 'CANNOT_DETERMINE', label);
        assert.match(row.detail, expected, label);
        assert.match(row.detail, /NOTHING was derived from it/, `${label}: a refused document must contribute nothing, and say so`);
        assert.deepEqual(v.json.sources, [], `${label}: no source may be reported from a refused document`);
        assert.deepEqual(v.json.derivations, [], `${label}: no derivation may be reported from a refused document`);
      } finally { rm(dir); }
    }
  });

  /*
   * ⛔ THE EXIT-CODE GUARANTEE (owner decision 22). This is the condition the whole decision was taken
   * under: a project with no lineage declaration — which is every installed target on the day this ships
   * — must be exactly where it was. The stage is NOT_APPLICABLE at exit 0, the doctor row is
   * NOT_CONFIGURED (green), and `onboarding` stays COMPLETE on a fixture whose six contracts are decided.
   */
  test('⛔ no declaration at all: the stage is NOT_APPLICABLE at exit 0, doctor is NOT_CONFIGURED, onboarding stays COMPLETE', () => {
    const dir = lineageFixture('mature-product', null);
    try {
      const s = cli(dir, 'savepoint', '--verify');
      assert.equal(s.code, 0, `a project that declares no provenance must be untouched by this contract: ${JSON.stringify((s.json || {}).checks)}`);
      const row = (s.json.checks || []).find((c) => c.check === 'lineage:declaration');
      assert.ok(row, 'the absence must be a ROW, not silence — a contract nobody mentioned reads as one that passed');
      assert.equal(row.outcome, 'NOT_APPLICABLE');
      assert.equal(row.domain, undefined, 'this row is not in the applicability survey, so filing it under `coverage` would put one decision under two authorities');
      assert.equal(s.json.onboardingComplete, true, 'a new contract must not make a finished onboarding unfinished — that is the reversal owner decision 22 refused');
      assert.equal(s.json.unresolved.length, 0);

      const d = cli(dir, 'doctor');
      const doctorRow = (d.json.rows || []).find((c) => c.check === 'lineage');
      assert.ok(doctorRow, 'doctor must carry a lineage row even when nothing is declared');
      assert.equal(doctorRow.label, 'NOT_CONFIGURED');
      assert.equal(doctorRow.outcome, 'NOT_APPLICABLE', 'NOT_CONFIGURED is green, which is what keeps every installed target at the exit code it had');
      assert.equal(doctorRow.subject, 'docs/derived/state/lineage.json', 'the subject must be the declaration, not respawnpack.config.json — there is nothing about lineage in the config');
      assert.match(doctorRow.detail, /Declare `sources` and `derivations` there/, 'a NOT_CONFIGURED row must carry the remedy');
      assert.equal(d.code, 0);
    } finally { rm(dir); }
  });

  test('doctor · a declaration that is present reports CONFIGURED with counts, and an unusable one is BROKEN', () => {
    const ok = lineageFixture('ops-infra', opsLineage());
    try {
      const d = cli(ok, 'doctor');
      const row = (d.json.rows || []).find((c) => c.check === 'lineage');
      assert.equal(row.label, 'CONFIGURED');
      assert.match(row.detail, /1 derivation\(s\) from 2 declared source\(s\)/, 'the row must carry the counts a reader would otherwise run the verb for');
    } finally { rm(ok); }

    const broken = lineageFixture('ops-infra', opsLineage());
    try {
      fs.writeFileSync(path.join(broken, stateLib.STATE_DIR, 'lineage.json'), '{ not json at all\n');
      const d = cli(broken, 'doctor');
      const row = (d.json.rows || []).find((c) => c.check === 'lineage');
      assert.equal(row.label, 'BROKEN', 'a declaration that exists and cannot be parsed is a fault, not an answer');
      assert.equal(row.outcome, 'FAIL');
      assert.equal(d.code, 1);
    } finally { rm(broken); }
  });

  /*
   * ⛔ THE TENTH STAGE BEHAVES LIKE THE OTHER NINE. `--only` reaches it, `--skip` prints the skip, and a
   * skipped stage establishes nothing — anti-drift item 14's rule, applied to a contract that would
   * otherwise be silently absent from a scoped run's shorter row list.
   */
  test('the tenth stage · --only reaches it, and --skip prints the skip rather than a shorter list', () => {
    const dir = lineageFixture('ops-infra', opsLineage());
    try {
      stampInto(dir, 'config/guac/range.conf', 'template-inventory', 'inventory/template.yml', 'guacd_hostname: template-host\n');

      const only = cli(dir, 'savepoint', '--verify', '--only', 'compile,lineage');
      assert.equal(only.code, 1, '`--only compile,lineage` must reach the failing derivation');
      assert.equal(rowOf(only.json, 'guac-config').outcome, 'FAIL');
      assert.deepEqual(only.json.stages.ran, ['compile', 'lineage']);
      assert.ok(only.json.stages.skipped.includes('removals'));

      const skipped = cli(dir, 'savepoint', '--verify', '--skip', 'lineage');
      assert.equal(skipped.json.checks.some((c) => String(c.check).startsWith('lineage:')), false,
        'a skipped lineage stage must emit NO provenance row at all — least of all a passing one');
      const stageRow = skipped.json.checks.find((c) => c.check === 'stage:lineage');
      assert.equal(stageRow.outcome, 'NOT_APPLICABLE');
      assert.equal(stageRow.label, 'SKIPPED_BY_REQUEST');
      assert.match(stageRow.detail, /No declared derivation was verified/);
      assert.equal(skipped.code, 0, 'the FAIL was not reported, because the stage did not run — which is exactly why the skip is printed');
      assert.deepEqual(skipped.json.stages.skipped, ['lineage']);
    } finally { rm(dir); }
  });

  /*
   * ⛔ THE BLOCK TRAVELS IN STATE.json, THE MARKERS DO NOT. Same rule as `reconciliation` — a boot path
   * may summarise an established provenance failure without any hook opening a project's derived files.
   */
  test('the compiled STATE.json carries the verdict, its counts and a bounded failing list, and no marker', () => {
    const dir = lineageFixture('ops-infra', opsLineage());
    try {
      stampInto(dir, 'config/guac/range.conf', 'template-inventory', 'inventory/template.yml', 'guacd_hostname: template-host\n');
      assert.equal(cli(dir, 'state').code, 0, 'compiling state is not a gate; the verdict travels and savepoint is what judges');
      const state = JSON.parse(fs.readFileSync(path.join(dir, stateLib.STATE_FILE), 'utf8'));
      assert.deepEqual(state.lineage, {
        status: 'FAIL',
        counts: { sources: 2, derivations: 1, pass: 0, fail: 1, undetermined: 0 },
        failing: ['guac-config'],
        failingTruncated: false,
      });
      assert.doesNotMatch(JSON.stringify(state.lineage), /sha256|template-inventory@/, 'no marker, digest or file list may travel in the compiled document');
    } finally { rm(dir); }

    // And the untracked shape carries it too: a repository with no requirement denominator is exactly
    // the shape that copies documents from templates.
    const docsOnly = lineageFixture('docs-only', null);
    try {
      fs.rmSync(path.join(docsOnly, stateLib.STATE_DIR, 'requirements.json'));
      assert.equal(cli(docsOnly, 'state').code, 0);
      const untracked = JSON.parse(fs.readFileSync(path.join(docsOnly, stateLib.STATE_FILE), 'utf8'));
      assert.equal(untracked.tracksRequirements, false);
      assert.equal(untracked.lineage.status, 'NOT_APPLICABLE');
      assert.deepEqual(untracked.lineage.failing, []);
    } finally { rm(docsOnly); }
  });

  /*
   * ⛔ THE MANIFEST COMPATIBILITY CLAUSE, FROM THE KERNEL SIDE (anti-drift item 6). Adding an input to
   * the shared manifest must not change the digest for an unchanged project — so an older STATE.json
   * recorded before `lineage.json` joined INPUT_FILES stays CURRENT while the file is absent, goes STALE
   * the moment it appears, and a config-only edit still goes STALE, which is the nearest bypass.
   */
  test('⛔ item 6 · an older manifest with no lineage key reads CURRENT while absent, STALE once it appears', () => {
    const dir = lineageFixture('ops-infra', null);
    try {
      const older = manifestLib.sourceManifest(dir);
      assert.ok('docs/derived/state/lineage.json' in older.inputs, 'the key must be in the CURRENT manifest, or this test proves nothing');
      delete older.inputs['docs/derived/state/lineage.json']; // exactly what a pre-P2-P-1 kernel recorded
      assert.equal(manifestLib.compareManifest(older, dir).status, 'CURRENT',
        'without the clause, every installed target reads STALE at its next boot over a file that does not exist and never did');

      fs.writeFileSync(path.join(dir, stateLib.STATE_DIR, 'lineage.json'), `${JSON.stringify(opsLineage(), null, 2)}\n`);
      const after = manifestLib.compareManifest(older, dir);
      assert.equal(after.status, 'STALE', 'the clause must not blunt the check it keeps compatible: a declaration APPEARING is a change');
      assert.deepEqual(after.changed, ['docs/derived/state/lineage.json']);
    } finally { rm(dir); }
  });

  test('⛔ item 6 · nearest bypass · a config-only change still reads STALE under the same clause', () => {
    const dir = lineageFixture('ops-infra', null);
    try {
      const older = manifestLib.sourceManifest(dir);
      delete older.inputs['docs/derived/state/lineage.json'];
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'respawnpack.config.json'), 'utf8'));
      cfg.qualityGate = { command: 'npm test' }; // a real compiler input, changed
      fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify(cfg, null, 2));
      const after = manifestLib.compareManifest(older, dir);
      assert.equal(after.status, 'STALE', 'the clause is scoped to keys that are UNRECORDED and ABSENT; a recorded key that changed is untouched by it');
      assert.deepEqual(after.changed, ['respawnpack.config.json']);
    } finally { rm(dir); }
  });
});

// --- P2-P-2 · lineage seed (Class D) ------------------------------------------------------------------
//
// ⛔ A PROPOSAL, NEVER A DERIVATION. `seed` finds the files a project's truth usually lives in and
// writes each as a `sources[]` row — it never guesses which file derives from which, because that link
// is the founder's own knowledge and not something a directory listing can recover. Fixtures are three
// archetypes from ops/_project-fixtures.mjs, the same vocabulary P2-P-1's suite above uses.

describe('P2-P-2 · lineage seed: propose the sources a repository already has', () => {
  const lineageLib = createRequire(import.meta.url)(path.join(KERNEL, 'lib', 'lineage.js'));
  const LINEAGE_SCHEMA = JSON.parse(fs.readFileSync(path.join(path.dirname(KERNEL), 'schemas', 'lineage.schema.json'), 'utf8'));
  const LINEAGE_JSON_REL = ['docs', 'derived', 'state', 'lineage.json'];

  const fixture = (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-lineage-seed-${kind}-`));
    materializeProject(kind, dir, { git: false });
    return dir;
  };

  /*
   * STATE 1 · OPS-INFRA. Five archetypes of evidence in one tree: a Terraform root found by content
   * (not merely by extension — variables.tf sits right beside the two that qualify and proposes
   * nothing on its own), ansible.cfg, both inventory files, and the compose file. Each row's own note
   * and the parallel `evidence` entry must agree, so a reader never has to cross-reference the two.
   */
  test('ops-infra · proposes the Terraform root, ansible.cfg, both inventory files and the compose file, each with its evidence', () => {
    const dir = fixture('ops-infra');
    try {
      const v = cli(dir, 'lineage', 'seed');
      assert.equal(v.code, 0, `seed must succeed on a plain tree: ${JSON.stringify(v.json)}`);
      assert.equal(v.json.count, 5);
      assert.equal(v.json.proposal.sources.length, 5);
      assert.deepEqual(v.json.proposal.derivations, [], 'seed never proposes a derivation');

      const byId = new Map(v.json.proposal.sources.map((s) => [s.id, s]));
      assert.deepEqual([...byId.keys()].sort(), ['ansible', 'docker-compose', 'inventory-range', 'inventory-template', 'terraform-root']);

      assert.equal(byId.get('terraform-root').kind, 'iac');
      assert.equal(byId.get('terraform-root').path, '.', 'the Terraform source is the DIRECTORY, not one of its files');
      assert.match(byId.get('terraform-root').note, /backend\.tf/, 'the note must name which file actually carried the terraform { block');
      assert.doesNotMatch(byId.get('terraform-root').note, /variables\.tf/, 'variables.tf declares neither block and must not be cited as evidence');

      assert.equal(byId.get('ansible').kind, 'iac');
      assert.equal(byId.get('ansible').path, 'ansible.cfg');
      assert.equal(byId.get('inventory-range').kind, 'inventory');
      assert.equal(byId.get('inventory-range').path, 'inventory/range.yml');
      assert.equal(byId.get('inventory-template').kind, 'inventory');
      assert.equal(byId.get('inventory-template').path, 'inventory/template.yml');
      assert.equal(byId.get('docker-compose').kind, 'iac');
      assert.equal(byId.get('docker-compose').path, 'docker-compose.yml');

      for (const s of v.json.proposal.sources) {
        assert.equal(s.authority, 'source-of-truth');
        assert.match(s.note, /^proposed by lineage seed from /, `${s.id}'s note must carry the required prefix`);
      }

      // Every proposed row has a matching evidence entry naming the same id, kind and path.
      const proposedEvidence = v.json.evidence.filter((e) => e.status === 'proposed');
      assert.equal(proposedEvidence.length, 5);
      for (const s of v.json.proposal.sources) {
        const e = proposedEvidence.find((x) => x.id === s.id);
        assert.ok(e, `no evidence row for proposed source ${s.id}`);
        assert.equal(e.path, s.path);
        assert.equal(e.kind, s.kind);
      }
    } finally { rm(dir); }
  });

  /*
   * STATE 2 · GREENFIELD-APP. A different shape of the same class: no Terraform, no Ansible — an
   * OpenAPI document, a Prisma schema one level down, and the package manifest at the root.
   */
  test('greenfield-app · proposes OpenAPI, Prisma and the manifest', () => {
    const dir = fixture('greenfield-app');
    try {
      const v = cli(dir, 'lineage', 'seed');
      assert.equal(v.code, 0);
      assert.equal(v.json.count, 3);
      const byId = new Map(v.json.proposal.sources.map((s) => [s.id, s]));
      assert.deepEqual([...byId.keys()].sort(), ['openapi', 'package', 'prisma-schema']);
      assert.equal(byId.get('openapi').kind, 'schema');
      assert.equal(byId.get('openapi').path, 'openapi.yaml');
      assert.equal(byId.get('package').kind, 'schema');
      assert.equal(byId.get('package').path, 'package.json');
      assert.match(byId.get('package').note, /manifest/);
      assert.equal(byId.get('prisma-schema').kind, 'schema');
      assert.equal(byId.get('prisma-schema').path, 'prisma/schema.prisma');
      assert.equal(byId.get('package').path === 'package-lock.json', false, 'the lockfile is not the manifest and must never be proposed');
    } finally { rm(dir); }
  });

  /*
   * STATE 3 · DOCS-ONLY. Nothing here matches a known evidence file. An empty proposal is printed and
   * exits 0 SAYING SO — never silence — and `--write` over nothing to propose writes no file either,
   * for the same reason: there is nothing here to declare.
   */
  test('docs-only · proposes nothing and exits 0 saying so, and --write there writes no file', () => {
    const dir = fixture('docs-only');
    try {
      const v = cli(dir, 'lineage', 'seed');
      assert.equal(v.code, 0);
      assert.deepEqual(v.json.proposal, { schemaVersion: '1.0.0', sources: [], derivations: [] });
      assert.deepEqual(v.json.evidence, []);
      assert.equal(v.json.count, 0);
      assert.ok(v.json.note && v.json.note.length > 20, 'an empty proposal must say why, not print silence');

      const w = cli(dir, 'lineage', 'seed', '--write');
      assert.equal(w.code, 0);
      assert.equal(w.json.wrote, null);
      assert.match(w.json.note, /wrote nothing/);
      assert.equal(fs.existsSync(path.join(dir, ...LINEAGE_JSON_REL)), false, '--write over an empty proposal must write no file');
    } finally { rm(dir); }
  });

  /*
   * ⛔ THE HONEST NEXT STATE. A written proposal validates against the pack's own declared schema — not
   * merely against this kernel's procedural reader — and reads back with zero derivations, which is
   * CANNOT_DETERMINE at `lineage:declared`: sources alone establish nothing about any file, exactly as
   * P2-P-1's own "sources with zero derivations" test already proves for a hand-authored declaration.
   * Seeding a project is the first half of the contract, never a finished one.
   */
  test('--write on ops-infra writes a document that validates against schemas/lineage.schema.json, and reads back with zero derivations', () => {
    const dir = fixture('ops-infra');
    try {
      const v = cli(dir, 'lineage', 'seed', '--write');
      assert.equal(v.code, 0, `--write on a fresh tree must succeed: ${JSON.stringify(v.json)}`);
      assert.equal(v.json.wrote, 'docs/derived/state/lineage.json');

      const abs = path.join(dir, ...LINEAGE_JSON_REL);
      const written = JSON.parse(fs.readFileSync(abs, 'utf8'));
      const validated = validate(written, LINEAGE_SCHEMA);
      assert.deepEqual(validated.errors, [], 'the written proposal must validate against the declared schema');
      assert.equal(validated.valid, true);
      assert.deepEqual(written.derivations, [], 'seed never proposes a derivation — that link is the founder\'s own knowledge');
      assert.equal(written.sources.length, 5);

      const read = lineageLib.readLineage(dir);
      assert.equal(read.status, 'OK', `readLineage must accept what seed wrote: ${read.detail}`);
      assert.equal(read.doc.derivations.length, 0);

      // And the honest next state: zero derivations is CANNOT_DETERMINE at `lineage:declared`, not a pass.
      const check = cli(dir, 'lineage');
      assert.equal(check.code, 2);
      const row = (check.json.checks || []).find((c) => c.check === 'lineage:declared');
      assert.ok(row, 'a freshly seeded, derivation-less declaration must still leave a row, not silence');
      assert.equal(row.outcome, 'CANNOT_DETERMINE');
    } finally { rm(dir); }
  });

  /*
   * ⛔ NEVER OVERWRITE A FOUNDER'S OWN FILE. `--write` refuses at exit 2 the moment ANY file already
   * sits at the declared path — this is a proposal tool, and clobbering a human's declaration because
   * this pack had one of its own to offer is exactly the mistake this contract exists to keep out of a
   * tool's hands (kernel/lib/lineage.js's own header, on the founder-authored class this file belongs
   * to). The refusal must name the file, and the file itself must be untouched, byte for byte.
   */
  test('--write refuses when a lineage file already exists, naming it, and leaves it byte-identical', () => {
    const dir = fixture('ops-infra');
    try {
      const sd = path.join(dir, ...LINEAGE_JSON_REL.slice(0, -1));
      fs.mkdirSync(sd, { recursive: true });
      const existing = `${JSON.stringify({ schemaVersion: '1.0.0', sources: [], derivations: [] }, null, 2)}\n`;
      fs.writeFileSync(path.join(sd, 'lineage.json'), existing);

      const v = cli(dir, 'lineage', 'seed', '--write');
      assert.equal(v.code, 2, 'a --write that would overwrite a founder\'s own declaration must refuse rather than clobber it');
      assert.equal(v.json.wrote, null);
      assert.match(v.json.error, /docs\/derived\/state\/lineage\.json/, 'the refusal must name the existing file');
      assert.match(v.json.error, /already exists/);

      assert.equal(fs.readFileSync(path.join(sd, 'lineage.json'), 'utf8'), existing, 'the existing file must be untouched, byte for byte');
    } finally { rm(dir); }
  });

  /*
   * ⛔ TWO CANDIDATES, ONE ID, UNTIL THEY ARE NOT. `inventory/hosts.yml` and `inventory/hosts.ini` both
   * drop their extension to `inventory/hosts` — proving the id space is genuinely disambiguated rather
   * than merely never having collided in the archetypes above.
   */
  test('ids are unique when two candidate paths would collide (inventory/hosts.yml and inventory/hosts.ini)', () => {
    const dir = fixture('ops-infra');
    try {
      fs.writeFileSync(path.join(dir, 'inventory', 'hosts.yml'), 'all:\n  hosts: {}\n');
      fs.writeFileSync(path.join(dir, 'inventory', 'hosts.ini'), '[all]\n');
      const v = cli(dir, 'lineage', 'seed');
      assert.equal(v.code, 0);
      const ids = v.json.proposal.sources.map((s) => s.id);
      assert.equal(new Set(ids).size, ids.length, 'no two proposed sources may share an id');
      assert.ok(ids.includes('inventory-hosts'), `expected the base id among ${JSON.stringify(ids)}`);
      assert.ok(ids.includes('inventory-hosts-2'), `expected a disambiguated second id among ${JSON.stringify(ids)}`);
      const byId = new Map(v.json.proposal.sources.map((s) => [s.id, s]));
      assert.equal(byId.get('inventory-hosts').path, 'inventory/hosts.ini', 'sorts before .yml, so it claims the base id first');
      assert.equal(byId.get('inventory-hosts-2').path, 'inventory/hosts.yml');
    } finally { rm(dir); }
  });

  /*
   * ⛔ NEVER SILENTLY DROPPED. A symlinked directory is never followed — nothing behind it is even
   * listed, let alone proposed — and a candidate this walk cannot read (a directory shaped like a
   * Terraform file, which fails through the identical catch a real permission fault would) is reported
   * rather than vanishing. The real Terraform root beside both must still be found.
   */
  test('a symlinked directory and an unreadable candidate are both reported in evidence as skipped, never silently dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-lineage-seed-skip-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-lineage-seed-outside-'));
    try {
      fs.writeFileSync(path.join(dir, 'main.tf'), 'terraform {\n}\n');
      fs.mkdirSync(path.join(dir, 'broken.tf')); // a directory shaped like a Terraform file: unreadable as text
      fs.mkdirSync(path.join(outside, 'inventory'));
      fs.writeFileSync(path.join(outside, 'inventory', 'decoy.yml'), 'all:\n  hosts: {}\n');
      fs.symlinkSync(path.join(outside, 'inventory'), path.join(dir, 'inventory'), process.platform === 'win32' ? 'junction' : 'dir');

      const v = cli(dir, 'lineage', 'seed');
      assert.equal(v.code, 0, `a candidate that cannot be used must not fail the whole run: ${JSON.stringify(v.json)}`);

      // The real Terraform root is still found and proposed, from the file that actually qualifies.
      const tf = v.json.proposal.sources.find((s) => s.id === 'terraform-root');
      assert.ok(tf, 'the real main.tf must still be found and proposed');
      assert.match(tf.note, /main\.tf/);
      assert.doesNotMatch(tf.note, /broken\.tf/, 'a candidate that could not be read must not be cited as evidence for a row it did not support');

      // Nothing behind the symlink was ever read, let alone proposed.
      assert.equal(v.json.proposal.sources.some((s) => s.path.includes('decoy')), false, 'seed must never read through a symlink');
      assert.equal(v.json.proposal.sources.some((s) => s.id.startsWith('inventory')), false, 'the linked directory must not be treated as an inventory/ source');

      // And both are visible in evidence, not silently dropped.
      const linked = v.json.evidence.find((e) => e.path === 'inventory');
      assert.ok(linked, 'the symlinked directory must appear in evidence');
      assert.equal(linked.status, 'skipped');
      assert.match(linked.detail, /symlink/);

      const broken = v.json.evidence.find((e) => e.path === 'broken.tf');
      assert.ok(broken, 'the unreadable candidate must appear in evidence');
      assert.equal(broken.status, 'skipped');
      assert.match(broken.detail, /could not be read/);
    } finally { rm(dir); rm(outside); }
  });
});

// --- P2-P-3 · lineage stamp (Class D) -----------------------------------------------------------------
//
// ⛔ THE MARKER'S OWN WRITER, PROVEN ACROSS EVERY COMMENT SYNTAX IT CLAIMS TO SPEAK. P2-P-1's
// `checkLineage` reads a marker; `stamp` is what makes one true in the first place, in the target's own
// comment grammar chosen by extension, on real fixture files from ops/_project-fixtures.mjs — never a
// hand-typed filename that merely happens to end the right way.
describe('P2-P-3 · lineage stamp: the marker\'s own writer, across every comment syntax it claims', () => {
  const lineageLib = createRequire(import.meta.url)(path.join(KERNEL, 'lib', 'lineage.js'));

  const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

  const fixture = (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-lineage-stamp-${kind}-`));
    materializeProject(kind, dir, { git: false });
    return dir;
  };

  /** Write docs/derived/state/lineage.json directly — the founder's own step, never this pack's. */
  const writeLineage = (dir, doc) => {
    const sd = path.join(dir, 'docs', 'derived', 'state');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'lineage.json'), `${JSON.stringify(doc, null, 2)}\n`);
  };

  const rowOf = (json, id) => (json.checks || []).find((c) => c.check === `lineage:${id}`);
  const countMarkers = (text) => (text.match(/respawnpack-derived-from:/g) || []).length;

  /*
   * STATE 1 · `#`, ON A REAL CONFIG FILE, THROUGH THE FULL LIFECYCLE. ops-infra's ansible.cfg is stamped
   * from the range inventory, a derivation is declared covering it, and this ONE tree proves both the
   * comment form and anti-drift item 55 at once: `checkLineage` PASSes on the freshly recorded digest and
   * FAILs the moment the source it names moves — a marker naming the right id is not enough.
   */
  test('# on ansible.cfg (ops-infra): stamp writes it, checkLineage PASSes, and FAILs once the source moves', () => {
    const dir = fixture('ops-infra');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' }],
        derivations: [{ id: 'ansible-copy', target: 'ansible.cfg', from: ['range-inventory'], how: 'copy' }],
      });
      const before = fs.readFileSync(path.join(dir, 'ansible.cfg'), 'utf8');
      const digest = sha(path.join(dir, 'inventory', 'range.yml'));

      const r = lineageLib.stamp(dir, { target: 'ansible.cfg', from: 'range-inventory' });
      assert.equal(r.outcome, 'PASS', JSON.stringify(r.checks));
      assert.equal(r.wrote, 'ansible.cfg');
      assert.equal(r.marker.sourceId, 'range-inventory');
      assert.equal(r.marker.digest, digest);
      assert.match(r.checks[0].detail, new RegExp(digest), 'the report must name the digest it recorded');

      const after = fs.readFileSync(path.join(dir, 'ansible.cfg'), 'utf8');
      assert.equal(after, `# respawnpack-derived-from: range-inventory@sha256:${digest}\n${before}`,
        'the # form is inserted as a new first line, and the original content follows byte for byte');

      const v = cli(dir, 'lineage');
      assert.equal(v.code, 0, JSON.stringify(v.json));
      assert.equal(rowOf(v.json, 'ansible-copy').outcome, 'PASS');

      fs.appendFileSync(path.join(dir, 'inventory', 'range.yml'), '    range-host-3:\n      ansible_host: 10.0.0.13\n');
      const v2 = cli(dir, 'lineage');
      assert.equal(v2.code, 1);
      assert.equal(rowOf(v2.json, 'ansible-copy').outcome, 'FAIL');
      assert.match(rowOf(v2.json, 'ansible-copy').detail, /the source moved since the derivation/);
    } finally { rm(dir); }
  });

  /*
   * STATE 2 · THE SHEBANG. scripts/teardown.sh's `#!/usr/bin/env bash` must stay line one; the marker is
   * inserted as line two, never ahead of it and never replacing it.
   */
  test('the shebang case: scripts/teardown.sh (ops-infra) keeps its #! on line one, the marker on line two', () => {
    const dir = fixture('ops-infra');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' }],
        derivations: [],
      });
      const before = fs.readFileSync(path.join(dir, 'scripts', 'teardown.sh'), 'utf8').split(/\r?\n/);
      assert.equal(before[0], '#!/usr/bin/env bash', 'sanity: the fixture must actually start with a shebang');

      const r = lineageLib.stamp(dir, { target: 'scripts/teardown.sh', from: 'range-inventory' });
      assert.equal(r.outcome, 'PASS');

      const after = fs.readFileSync(path.join(dir, 'scripts', 'teardown.sh'), 'utf8').split(/\r?\n/);
      assert.equal(after[0], '#!/usr/bin/env bash', 'the shebang must stay the first line');
      assert.match(after[1], /^# respawnpack-derived-from: range-inventory@sha256:[0-9a-f]{64}$/, 'the marker must be the SECOND line, right after the shebang');
      assert.equal(after[2], before[1], 'every original line after the shebang must simply shift down by one');
    } finally { rm(dir); }
  });

  /*
   * STATE 3 · `//`, ON src/health.js (greenfield-app). Its first line is an ordinary // comment, not a
   * directive, so the marker becomes the new first line and that comment moves down.
   */
  test('// on src/health.js (greenfield-app), stamped from the OpenAPI document', () => {
    const dir = fixture('greenfield-app');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'api-schema', kind: 'schema', path: 'openapi.yaml', authority: 'source-of-truth' }],
        derivations: [],
      });
      const before = fs.readFileSync(path.join(dir, 'src', 'health.js'), 'utf8');
      const digest = sha(path.join(dir, 'openapi.yaml'));

      const r = lineageLib.stamp(dir, { target: 'src/health.js', from: 'api-schema' });
      assert.equal(r.outcome, 'PASS');
      assert.equal(r.marker.digest, digest);

      const after = fs.readFileSync(path.join(dir, 'src', 'health.js'), 'utf8');
      assert.equal(after, `// respawnpack-derived-from: api-schema@sha256:${digest}\n${before}`);
    } finally { rm(dir); }
  });

  /*
   * STATE 4 · `<!-- -->`, ON docs/guide.md (docs-only), stamped from the project's own README.
   */
  test('<!-- --> on docs/guide.md (docs-only), stamped from README.md', () => {
    const dir = fixture('docs-only');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'readme', kind: 'doc', path: 'README.md', authority: 'source-of-truth' }],
        derivations: [],
      });
      const before = fs.readFileSync(path.join(dir, 'docs', 'guide.md'), 'utf8');
      const digest = sha(path.join(dir, 'README.md'));

      const r = lineageLib.stamp(dir, { target: 'docs/guide.md', from: 'readme' });
      assert.equal(r.outcome, 'PASS');

      const after = fs.readFileSync(path.join(dir, 'docs', 'guide.md'), 'utf8');
      assert.equal(after, `<!-- respawnpack-derived-from: readme@sha256:${digest} -->\n${before}`);
    } finally { rm(dir); }
  });

  /*
   * STATE 5 · `--`, ON migrations/001.sql (mature-product) — the web-app shape plus a release history,
   * so it still carries openapi.yaml to stamp from.
   */
  test('-- on migrations/001.sql (mature-product)', () => {
    const dir = fixture('mature-product');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'api-schema', kind: 'schema', path: 'openapi.yaml', authority: 'source-of-truth' }],
        derivations: [],
      });
      const before = fs.readFileSync(path.join(dir, 'migrations', '001.sql'), 'utf8');
      const digest = sha(path.join(dir, 'openapi.yaml'));

      const r = lineageLib.stamp(dir, { target: 'migrations/001.sql', from: 'api-schema' });
      assert.equal(r.outcome, 'PASS');

      const after = fs.readFileSync(path.join(dir, 'migrations', '001.sql'), 'utf8');
      assert.equal(after, `-- respawnpack-derived-from: api-schema@sha256:${digest}\n${before}`);
    } finally { rm(dir); }
  });

  /*
   * STATE 6 · THE SIDECAR, FOR AN EXTENSION THIS MODULE DOES NOT KNOW. package-lock.json is plain JSON —
   * only .json5 carries a // grammar — so stamp takes the sidecar, and the lockfile's own bytes, which a
   * generic-comment insertion would have corrupted as JSON, are never touched.
   */
  test('the sidecar: package-lock.json (greenfield-app), an unknown extension, is never touched', () => {
    const dir = fixture('greenfield-app');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'api-schema', kind: 'schema', path: 'openapi.yaml', authority: 'source-of-truth' }],
        derivations: [],
      });
      const before = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
      const digest = sha(path.join(dir, 'openapi.yaml'));

      const r = lineageLib.stamp(dir, { target: 'package-lock.json', from: 'api-schema' });
      assert.equal(r.outcome, 'PASS');
      assert.equal(r.wrote, 'package-lock.json.lineage.json');
      assert.equal(r.marker.where, 'package-lock.json.lineage.json');

      assert.equal(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), before,
        'the lockfile itself must be untouched — a sidecar carries the marker, never the file');
      const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json.lineage.json'), 'utf8'));
      assert.equal(sidecar.sourceId, 'api-schema');
      assert.equal(sidecar.sourceDigest, digest);
      assert.ok(sidecar.stampedAt, 'the sidecar must carry stampedAt — the one place this module records a timestamp at all');
    } finally { rm(dir); }
  });

  test('--sidecar forces the sidecar even on a file with a known comment syntax, through the verb', () => {
    const dir = fixture('ops-infra');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' }],
        derivations: [],
      });
      const before = fs.readFileSync(path.join(dir, 'ansible.cfg'), 'utf8');
      const v = cli(dir, 'lineage', 'stamp', 'ansible.cfg', '--from', 'range-inventory', '--sidecar');
      assert.equal(v.code, 0, JSON.stringify(v.json));
      assert.equal(v.json.wrote, 'ansible.cfg.lineage.json');
      assert.equal(fs.readFileSync(path.join(dir, 'ansible.cfg'), 'utf8'), before, '--sidecar must leave the commentable file untouched');
      assert.ok(fs.existsSync(path.join(dir, 'ansible.cfg.lineage.json')));
    } finally { rm(dir); }
  });

  /*
   * STATE 7 · REPLACE, NEVER DUPLICATE. Re-stamping ansible.cfg from a SECOND declared source must
   * REPLACE the marker line in place — not add a second one — and record the second call's source.
   */
  test('re-stamping the same target REPLACES the marker line rather than adding a second one', () => {
    const dir = fixture('ops-infra');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [
          { id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' },
          { id: 'playbook', kind: 'iac', path: 'playbooks/site.yml', authority: 'source-of-truth' },
        ],
        derivations: [],
      });
      const first = lineageLib.stamp(dir, { target: 'ansible.cfg', from: 'range-inventory' });
      assert.equal(first.outcome, 'PASS');
      assert.equal(countMarkers(fs.readFileSync(path.join(dir, 'ansible.cfg'), 'utf8')), 1);

      const second = lineageLib.stamp(dir, { target: 'ansible.cfg', from: 'playbook' });
      assert.equal(second.outcome, 'PASS');
      const twiceStamped = fs.readFileSync(path.join(dir, 'ansible.cfg'), 'utf8');
      assert.equal(countMarkers(twiceStamped), 1, 'a second stamp must REPLACE the marker line, never add a second one');
      assert.match(twiceStamped, /respawnpack-derived-from: playbook@sha256:/, 'the replaced marker must name the SECOND call\'s source');
      assert.doesNotMatch(twiceStamped, /respawnpack-derived-from: range-inventory@sha256:/, 'the FIRST marker must be gone, not merely superseded in meaning');
      assert.equal((twiceStamped.match(/\[defaults\]/g) || []).length, 1, 'the file\'s own original content must still be present exactly once');
    } finally { rm(dir); }
  });

  /*
   * STATE 8 · AN UNKNOWN SOURCE ID IS REFUSED, NAMING THE DECLARED IDS, AND WRITES NOTHING.
   */
  test('an unknown source id is refused, CANNOT_DETERMINE, naming the declared ids', () => {
    const dir = fixture('ops-infra');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' }],
        derivations: [],
      });
      const before = fs.readFileSync(path.join(dir, 'ansible.cfg'), 'utf8');
      const r = lineageLib.stamp(dir, { target: 'ansible.cfg', from: 'no-such-source' });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.wrote, null);
      assert.equal(r.marker, null);
      assert.match(r.checks[0].detail, /no-such-source/);
      assert.match(r.checks[0].detail, /range-inventory/, 'the refusal must name the id(s) that ARE declared');
      assert.equal(fs.readFileSync(path.join(dir, 'ansible.cfg'), 'utf8'), before, 'a refused stamp must write nothing');
    } finally { rm(dir); }
  });

  /*
   * STATE 9 · THE GUAC CASE ITSELF. A source the derivation covering this target declares `neverFrom` is
   * refused, FAIL, naming the derivation — before a byte is written.
   */
  test('a neverFrom source is refused, FAIL, naming the derivation, and nothing is written', () => {
    const dir = fixture('ops-infra');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [
          { id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' },
          { id: 'template-inventory', kind: 'template', path: 'inventory/template.yml', authority: 'source-of-truth' },
        ],
        derivations: [{ id: 'guac-config', target: 'config/guac/range.conf', from: ['range-inventory'], how: 'generate', neverFrom: ['template-inventory'] }],
      });
      fs.mkdirSync(path.join(dir, 'config', 'guac'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config', 'guac', 'range.conf'), 'guacd_hostname: placeholder\n');

      const r = lineageLib.stamp(dir, { target: 'config/guac/range.conf', from: 'template-inventory' });
      assert.equal(r.outcome, 'FAIL');
      assert.equal(r.wrote, null);
      assert.match(r.checks[0].detail, /guac-config/);
      assert.match(r.checks[0].detail, /template-inventory/);
      assert.match(r.checks[0].detail, /neverFrom/);
      assert.equal(fs.readFileSync(path.join(dir, 'config', 'guac', 'range.conf'), 'utf8'), 'guacd_hostname: placeholder\n',
        'a refused stamp must write nothing, not even a partial marker');
    } finally { rm(dir); }
  });

  /*
   * STATE 10 · A TARGET OUTSIDE THE PROJECT, AND A TARGET THAT DOES NOT EXIST, ARE BOTH CANNOT_DETERMINE.
   */
  test('a target outside the project root, and a target that does not exist, are both refused, CANNOT_DETERMINE', () => {
    const dir = fixture('ops-infra');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [{ id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' }],
        derivations: [],
      });
      const outside = lineageLib.stamp(dir, { target: '../escape.txt', from: 'range-inventory' });
      assert.equal(outside.outcome, 'CANNOT_DETERMINE');
      assert.match(outside.checks[0].detail, /could not be resolved inside the project/);

      const missing = lineageLib.stamp(dir, { target: 'does/not/exist.txt', from: 'range-inventory' });
      assert.equal(missing.outcome, 'CANNOT_DETERMINE');
      assert.match(missing.checks[0].detail, /does not exist/);
    } finally { rm(dir); }
  });

  /*
   * STATE 11 · THE VERB'S EXIT CODES: PASS 0, FAIL 1 (neverFrom), CANNOT_DETERMINE 2 (unknown source),
   * and a usage error (no target, no --from) is FAIL, matching every other verb's missing-flag refusal.
   */
  test('the verb\'s exit codes: PASS 0, FAIL 1, CANNOT_DETERMINE 2, and missing arguments FAIL', () => {
    const dir = fixture('ops-infra');
    try {
      writeLineage(dir, {
        schemaVersion: '1.0.0',
        sources: [
          { id: 'range-inventory', kind: 'inventory', path: 'inventory/range.yml', authority: 'source-of-truth' },
          { id: 'template-inventory', kind: 'template', path: 'inventory/template.yml', authority: 'source-of-truth' },
        ],
        derivations: [{ id: 'guac-config', target: 'config/guac/range.conf', from: ['range-inventory'], how: 'generate', neverFrom: ['template-inventory'] }],
      });
      fs.mkdirSync(path.join(dir, 'config', 'guac'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config', 'guac', 'range.conf'), 'guacd_hostname: placeholder\n');

      assert.equal(cli(dir, 'lineage', 'stamp', 'ansible.cfg', '--from', 'range-inventory').code, 0);
      assert.equal(cli(dir, 'lineage', 'stamp', 'config/guac/range.conf', '--from', 'template-inventory').code, 1);
      assert.equal(cli(dir, 'lineage', 'stamp', 'ansible.cfg', '--from', 'no-such-id').code, 2);

      const noTarget = cli(dir, 'lineage', 'stamp');
      assert.equal(noTarget.code, 1);
      assert.match(noTarget.json.error, /requires a target/);
      const noFrom = cli(dir, 'lineage', 'stamp', 'ansible.cfg');
      assert.equal(noFrom.code, 1);
      assert.match(noFrom.json.error, /requires --from/);
    } finally { rm(dir); }
  });

  /*
   * SEED THEN STAMP COMPOSE. `lineage seed` proposes sources from evidence; the founder adds a
   * derivation by hand — never this pack's job, per P2-P-1's and P2-P-2's own headers — and `stamp` then
   * works against exactly that seeded source, closing the loop `checkLineage` verifies.
   */
  test('seed then stamp compose: seed proposes a source, the founder declares a derivation, stamp works against it', () => {
    const dir = fixture('ops-infra');
    try {
      const seeded = cli(dir, 'lineage', 'seed', '--write');
      assert.equal(seeded.code, 0, JSON.stringify(seeded.json));
      assert.equal(seeded.json.wrote, 'docs/derived/state/lineage.json');
      const sourceIds = seeded.json.proposal.sources.map((s) => s.id);
      assert.ok(sourceIds.includes('inventory-range'), `expected seed to propose inventory-range among ${JSON.stringify(sourceIds)}`);

      const lineagePath = path.join(dir, 'docs', 'derived', 'state', 'lineage.json');
      const doc = JSON.parse(fs.readFileSync(lineagePath, 'utf8'));
      doc.derivations.push({ id: 'guac-config', target: 'config/guac/range.conf', from: ['inventory-range'], how: 'generate' });
      fs.writeFileSync(lineagePath, `${JSON.stringify(doc, null, 2)}\n`);
      fs.mkdirSync(path.join(dir, 'config', 'guac'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config', 'guac', 'range.conf'), 'guacd_hostname: range-host-1\n');

      const stamped = cli(dir, 'lineage', 'stamp', 'config/guac/range.conf', '--from', 'inventory-range');
      assert.equal(stamped.code, 0, JSON.stringify(stamped.json));

      const verified = cli(dir, 'lineage');
      assert.equal(verified.code, 0, JSON.stringify(verified.json));
      assert.equal(rowOf(verified.json, 'guac-config').outcome, 'PASS');
    } finally { rm(dir); }
  });
});

// --- P2-O-3 · the lessons register -----------------------------------------------------------------
//
// ⭐ CLASS C, "output shaped for a human's attention". The pack promoted lessons into
// `memory/graph/<type>/<slug>.md` and parked leads in `memory/candidates/*.json`, and nothing ever
// rendered either as something a person reads — the field feedback measured the cost at thirteen
// unreviewed candidates accumulating across sessions. `docs/derived/LESSONS.md` is that register, and
// it is held to the SAME contract as the other two derived docs (anti-drift item 7): generated block,
// protected NOTE, note budget, drift check, and — the half that matters — every count parsed back out
// of the rendered prose and compared against the rows it came from (DF-011).
//
// ⛔ ITS NUMBERS DO NOT COME FROM STATE.json, WHICH IS WHY THE PAIR IS EXTENDED RATHER THAN REUSED.
// `verifyRendered` checks against `countMap(state)`; these counts are the memory store's own rows, so
// `verifyLessons` is the same function over the same three labels with the store as its source. A
// renderer without a verifier would have been a third document full of unchecked integers.
//
// Every fixture below is a real project archetype from ops/_project-fixtures.mjs (task F-0), because
// the claim is about a CLASS of project and not about one shape: greenfield-app carries a populated
// store, ops-infra one promoted gotcha wired to a skill, docs-only no memory at all.
describe('P2-O-3 · the lessons register — rendered, verified, and cited at boot', () => {
  const LESSONS_REL = 'docs/derived/LESSONS.md';
  const lessonsPath = (dir) => path.join(dir, 'docs', 'derived', 'LESSONS.md');
  const readLessons = (dir) => fs.readFileSync(lessonsPath(dir), 'utf8');
  const rowFor = (r, check) => (r.json.checks || []).find((c) => c.check === check);
  const claimsRow = (r) => rowFor(r, `rendered-claims:${LESSONS_REL}`);

  /**
   * A real archetype tree with a memory store in it. The pack is never installed on top: this exercises
   * the KERNEL against a founder's own repository, which is what a target actually looks like.
   *
   * The config declares the four optional contracts not applicable for the same reason `project()` above
   * does — an undecided contract is legitimately CANNOT_DETERMINE, and leaving four of them undecided
   * would make every savepoint here exit 2 for reasons that have nothing to do with the register.
   */
  function archetype(kind, { graph = [], candidates = [] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-o3-${kind}-`));
    materialize(kind, dir);
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({
      routeSource: { notApplicable: true, reason: 'register fixture: this project serves no routes' },
      codeTruth: { notApplicable: true, reason: 'register fixture: no token, copy or schema source outranks prose here' },
      qualityGate: { notApplicable: true, reason: 'register fixture: quality checks are outside the scope of these tests' },
      state: {
        removals: { notApplicable: 'register fixture: this project has retired nothing' },
        reconcile: { notApplicable: true, reason: 'register fixture: this project has no task system to reconcile against' },
      },
    }, null, 2));
    for (const e of graph) {
      const d = path.join(dir, 'memory', 'graph', e.type);
      fs.mkdirSync(d, { recursive: true });
      // The exact frontmatter kernel/respawnpack.js's writeGraphEntity() emits on a promotion, plus the
      // `relations` shape memory/knowledge-graph.md documents — written here rather than produced by a
      // promotion so the fixture states its own inputs.
      fs.writeFileSync(path.join(d, `${e.slug}.md`), [
        '---', `id: ${e.type}:${e.slug}`, 'aliases: []',
        `relations: [${(e.skills || []).map((s) => `applies-to|skill:${s}`).join(', ')}]`,
        `promotedFrom: ${e.from || 'cm_seeded'}`, `promotedAt: ${e.at || '2026-08-01T00:00:00.000Z'}`,
        `verifiedBy: ${JSON.stringify(e.verifiedBy || 'reproduced on a disposable target')}`,
        '---', '', `# ${e.slug}`, '', `**Klass:** ${e.klass || 'finding'}`, '',
        '## Observation', e.observation, '',
      ].join('\n'));
    }
    if (candidates.length) fs.mkdirSync(path.join(dir, 'memory', 'candidates'), { recursive: true });
    for (const c of candidates) {
      // Built through the store's OWN module, so a schema change there breaks this fixture instead of
      // silently leaving it testing a shape the pack no longer writes.
      const rec = {
        ...candidatesLib.build({
          claim: c.claim, klass: c.klass || 'finding', id: c.id, at: '2026-08-01T00:00:00.000Z',
          provenance: { by: 'savepoint', cycleId: 'fixture-revision', sourceKind: 'savepoint', evidencePaths: [] },
        }),
        ...(c.state === 'rejected'
          ? { verificationState: 'rejected', rejection: { by: 'fixture', at: '2026-08-02T00:00:00.000Z', reason: 'turned out wrong', previousState: 'candidate' } }
          : {}),
      };
      fs.writeFileSync(path.join(dir, 'memory', 'candidates', `${rec.id}.json`), JSON.stringify(rec, null, 2));
    }
    git('add', '-A'); git('commit', '--quiet', '-m', 'fixture memory');
    return { dir, git, head: () => git('rev-parse', 'HEAD').trim() };
  }

  const TWO_LESSONS = [
    { type: 'gotcha', slug: 'redis-tls-mismatch', observation: 'the pooler rejects a plain connection once TLS is on', skills: ['debug'], verifiedBy: 'reproduced twice against staging' },
    { type: 'infra', slug: 'media-plane', observation: 'the media plane runs in eu-west-1 only', skills: [] },
  ];
  const THREE_LEADS = [
    { id: 'cm_lead0001', claim: 'the export route times out above 10k rows' },
    { id: 'cm_lead0002', claim: 'the CI cache key ignores the lockfile' },
    { id: 'cm_lead0003', claim: 'health checks pass while the worker is wedged' },
  ];

  // --- state 1 · a populated store, on the greenfield-app archetype ---------------------------------
  test('greenfield-app · savepoint --write CREATES the register, renders a row per promoted entity, and verifies its three counts', () => {
    const p = archetype('greenfield-app', { graph: TWO_LESSONS, candidates: THREE_LEADS });
    try {
      assert.equal(fs.existsSync(lessonsPath(p.dir)), false, 'sanity: the archetype ships no derived docs');
      const w = cli(p.dir, 'savepoint', '--write');
      assert.equal(w.code, 0, `a clean archetype must savepoint clean: ${JSON.stringify(((w.json && w.json.checks) || []).filter((c) => c.outcome !== 'PASS' && c.outcome !== 'NOT_APPLICABLE'))}`);

      // ⛔ CREATION IS ANNOUNCED, NOT INFERRED FROM A FILE APPEARING. The register is fully generated, so
      // it has no hand-authored predecessor to archive and nothing `restore-derived` could put back —
      // the row has to SAY that, or an operator reads a missing archive as a missing safeguard.
      const created = rowFor(w, `render:${LESSONS_REL}`);
      assert.equal(created.outcome, 'PASS', `the creation was not reported: ${JSON.stringify(created)}`);
      assert.match(created.detail, /CREATED by this --write run/);
      assert.match(created.detail, /no migration or restore story/);

      const doc = readLessons(p.dir);
      assert.match(doc, /- \*\*verified lessons:\*\* 2/, 'the row count must be rendered under the label the verifier knows');
      assert.match(doc, /- \*\*candidate leads:\*\* 3/);
      assert.match(doc, /- \*\*rejected leads:\*\* 0/);
      for (const [id, obs, skill] of [
        ['gotcha:redis-tls-mismatch', 'the pooler rejects a plain connection once TLS is on', '`/debug`'],
        ['infra:media-plane', 'the media plane runs in eu-west-1 only', null],
      ]) {
        const row = doc.split(/\r?\n/).find((l) => l.includes(`\`${id}\``));
        assert.ok(row, `no register row for ${id}`);
        assert.ok(row.includes(obs), `${id}'s row does not carry its first observation line`);
        assert.ok(row.includes('2026-08-01T00:00:00.000Z'), `${id}'s row does not carry promotedAt`);
        if (skill) assert.ok(row.includes(skill), `${id} has an applies-to|skill: relation that the register does not show`);
      }
      assert.match(doc, /reproduced twice against staging/, 'verifiedBy — the stated verification that earned the promotion — is what makes a row a lesson rather than an assertion');
      // Item 11: the queue is presented as leads, in the store's OWN vocabulary, never as lessons.
      assert.match(doc, new RegExp(candidatesLib.UNVERIFIED_MARKER), 'the candidate queue is not labelled with the store\'s unverified-lead marker');
      assert.match(doc, /promote, reject, or defer/, 'the register must name the review action, or the count is a statistic nobody acts on');

      // The DF-011 half: the numbers were parsed back out and compared to the store's rows.
      const v = claimsRow(cli(p.dir, 'savepoint', '--verify'));
      assert.equal(v.outcome, 'PASS', v.detail);
      assert.equal(v.checked, 3, `all three labelled counts must be checked, not a subset: ${v.detail}`);
    } finally { rm(p.dir); }
  });

  test('greenfield-app · a hand-edited count inside the generated block FAILs verify, naming the label and both numbers', () => {
    const p = archetype('greenfield-app', { graph: TWO_LESSONS, candidates: THREE_LEADS });
    try {
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      const truth = readLessons(p.dir);
      // A plausible integer, exactly the kind a careful re-read skims past — Scenario E's injection,
      // one document over.
      fs.writeFileSync(lessonsPath(p.dir), truth.replace('**candidate leads:** 3', '**candidate leads:** 0'));

      const r = cli(p.dir, 'savepoint', '--verify');
      assert.equal(r.code, 1, 'a register that under-reports the review queue passed savepoint — this is DF-011 on the third document');
      const v = claimsRow(r);
      assert.equal(v.outcome, 'FAIL');
      assert.match(v.detail, /says 0 candidate leads, the memory store says 3/, `the disagreement must name the label and both numbers: ${v.detail}`);
      assert.equal(rowFor(r, `generated-block:${LESSONS_REL}`).outcome, 'FAIL', 'the hand-edit inside the generated block must also be caught as drift');

      // The known-good control: restoring clears it, so the check discriminates rather than always firing.
      fs.writeFileSync(lessonsPath(p.dir), truth);
      assert.equal(claimsRow(cli(p.dir, 'savepoint', '--verify')).outcome, 'PASS', 'restoring the true count must clear the failure');
    } finally { rm(p.dir); }
  });

  test('greenfield-app · the human NOTE survives a re-render; the generated block does not', () => {
    const p = archetype('greenfield-app', { graph: TWO_LESSONS, candidates: THREE_LEADS });
    try {
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      const noted = readLessons(p.dir).replace('_(no human note)_', 'The redis gotcha is the one that keeps biting new joiners.');
      fs.writeFileSync(lessonsPath(p.dir), noted);

      // Promote a third entity between the two renders: the block must move, the note must not.
      fs.mkdirSync(path.join(p.dir, 'memory', 'graph', 'compat'), { recursive: true });
      fs.writeFileSync(path.join(p.dir, 'memory', 'graph', 'compat', 'windows-paths.md'),
        '---\nid: compat:windows-paths\naliases: []\nrelations: []\npromotedFrom: cm_x\npromotedAt: 2026-08-03T00:00:00.000Z\nverifiedBy: "seen on two machines"\n---\n\n# windows-paths\n\n## Observation\nbackslashes reach the check ids without posix()\n');

      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      const after = readLessons(p.dir);
      assert.match(after, /The redis gotcha is the one that keeps biting new joiners\./, 'the protected NOTE block was lost across a regeneration');
      assert.match(after, /- \*\*verified lessons:\*\* 3/, 'the generated block did not pick up the new entity');
      assert.match(after, /compat:windows-paths/);
      assert.equal(claimsRow(cli(p.dir, 'savepoint', '--verify')).outcome, 'PASS');
    } finally { rm(p.dir); }
  });

  // --- state 2 · one promoted gotcha wired to a skill, on the ops-infra archetype -------------------
  test('ops-infra · a promoted gotcha with an applies-to|skill: relation shows the skill it became a rule for', () => {
    const p = archetype('ops-infra', {
      graph: [{ type: 'gotcha', slug: 'terraform-state-lock', observation: 'a killed apply leaves the state lock held and the next run hangs', skills: ['debug'], verifiedBy: 'unlocked by hand twice' }],
    });
    try {
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      const doc = readLessons(p.dir);
      assert.match(doc, /- \*\*verified lessons:\*\* 1/);
      // The point of the column: a lesson that BECAME a rule (the living-skill overlay reads the same
      // relation) is visible as one, rather than being a file somebody has to go looking for.
      const row = doc.split(/\r?\n/).find((l) => l.includes('gotcha:terraform-state-lock'));
      assert.ok(row && row.includes('`/debug`'), `the applies-to|skill:debug relation is not shown on the row: ${row}`);
      // A store with no candidate directory at all is a real, counted zero on that half only.
      assert.match(doc, /- \*\*candidate leads:\*\* 0/);
      assert.equal(claimsRow(cli(p.dir, 'savepoint', '--verify')).outcome, 'PASS');
    } finally { rm(p.dir); }
  });

  // --- state 3 · no memory at all, on the docs-only archetype ---------------------------------------
  test('docs-only · no memory anywhere renders an HONEST empty register whose zeros are still checked', () => {
    const p = archetype('docs-only');
    try {
      assert.equal(fs.existsSync(path.join(p.dir, 'memory')), false, 'sanity: the docs-only archetype has no memory store');
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      const doc = readLessons(p.dir);

      /*
       * ⛔ THE EMPTY REGISTER MUST STILL STATE ITS ZEROS, AND THAT IS A DELIBERATE DIFFERENCE FROM
       * verifyRendered's NOT_APPLICABLE branch. A document that rendered no count at all would parse
       * zero claims, and zero parsed claims is CANNOT_DETERMINE — "we could not look" — which is the
       * wrong answer for a project that provably has nothing. Three explicit zeros make "nothing has
       * been learned yet" a CHECKED fact rather than an absence.
       */
      for (const label of ['verified lessons', 'candidate leads', 'rejected leads']) {
        assert.match(doc, new RegExp(`\\*\\*${label}:\\*\\* 0`), `the empty register omits the ${label} count, which would make it unverifiable`);
      }
      assert.match(doc, /does not exist in this project/, 'an absent directory is a counted zero WITH its reason, not a bare zero');
      assert.doesNotMatch(doc, /_withheld/, 'nothing is withheld here: the directories are absent, which is an answer');

      const v = claimsRow(cli(p.dir, 'savepoint', '--verify'));
      assert.equal(v.outcome, 'PASS', v.detail);
      assert.equal(v.checked, 3, 'the zeros must be CHECKED claims, or an empty register is a document nobody verified');
    } finally { rm(p.dir); }
  });

  // --- the third state of every count: could not be established -------------------------------------
  test('greenfield-app · an unreadable candidate record withholds the counts and makes the row CANNOT_DETERMINE, never zero', () => {
    const p = archetype('greenfield-app', { graph: TWO_LESSONS, candidates: THREE_LEADS });
    try {
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      fs.writeFileSync(path.join(p.dir, 'memory', 'candidates', 'cm_torn0001.json'), '{ "kind": "candidate-memory", ');

      const w = cli(p.dir, 'savepoint', '--write');
      const doc = readLessons(p.dir);
      assert.match(doc, /- \*\*candidate leads:\*\* _withheld/, 'an unreadable record printed a count anyway');
      assert.match(doc, /- \*\*rejected leads:\*\* _withheld/);
      assert.match(doc, /cm_torn0001\.json/, 'the withholding must name the record it could not read');
      assert.doesNotMatch(doc, /- \*\*candidate leads:\*\* 0/, '"we could not look" was rendered as "we found nothing" — the exact substitution the four-outcome vocabulary exists to stop');
      // The readable half is still reported: one unreadable file does not blank the whole document.
      assert.match(doc, /- \*\*verified lessons:\*\* 2/);

      const v = claimsRow(w);
      assert.equal(v.outcome, 'CANNOT_DETERMINE', `a partially-verifiable register reported as verified: ${JSON.stringify(v)}`);
      assert.match(v.detail, /could not be read/);
      assert.equal(w.code, 2, 'a register nobody could fully check must not exit 0');
    } finally { rm(p.dir); }
  });

  // --- the staleness report and the self-inflicted-drift guard --------------------------------------
  test('greenfield-app · `state` names the register in its staleness report, and never renders or writes it', () => {
    const p = archetype('greenfield-app', { graph: TWO_LESSONS, candidates: THREE_LEADS });
    try {
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      const before = readLessons(p.dir);
      // Promote another entity WITHOUT re-rendering: the register on disk now describes an older store.
      fs.writeFileSync(path.join(p.dir, 'memory', 'graph', 'infra', 'queue.md'),
        '---\nid: infra:queue\naliases: []\nrelations: []\npromotedFrom: cm_q\npromotedAt: 2026-08-04T00:00:00.000Z\nverifiedBy: "read off the console"\n---\n\n# queue\n\n## Observation\nthe queue is a single partition\n');

      const s = cli(p.dir, 'state');
      const row = (s.json.findings || []).find((c) => c.check === `generated-block:${LESSONS_REL}`);
      assert.ok(row, `state did not report the stale register: ${JSON.stringify((s.json.findings || []).map((c) => c.check))}`);
      assert.equal(row.outcome, 'CANNOT_DETERMINE', 'state must REPORT a stale render, never turn it into its own FAIL — that is savepoint\'s call');
      assert.match(row.detail, /savepoint --write/, 'the report must name the fix');
      assert.equal(readLessons(p.dir), before, '`state` rewrote a derived doc — it compiles STATE.json and nothing else');
    } finally { rm(p.dir); }
  });

  /*
   * ⛔ THE REGISTER PROJECTS A STORE SAVEPOINT ITSELF WRITES TO, AND THAT IS A TRAP IF NOBODY CLOSES IT.
   * The `memory` stage captures candidate memories — in verify-only runs too — and runs AFTER render and
   * verify. So a run that captures one new lead would leave the register one behind and the NEXT run
   * would FAIL on a document that was correct when it was written: a savepoint that records a finding
   * would guarantee the failure of the following one, which is the "success is unreachable" trap the
   * 2026-08-07 field run says trains an operator to ignore the tool. The run that changed the store
   * keeps its projection in step, and only ever a register that was in step to begin with.
   */
  test('greenfield-app · a run that captures a new lead leaves the register in step, so the next verify is not failed by its own capture', () => {
    const p = archetype('greenfield-app', { graph: TWO_LESSONS, candidates: THREE_LEADS });
    try {
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      assert.match(readLessons(p.dir), /- \*\*candidate leads:\*\* 3/);

      // A run that captures a fourth lead. The operator path is used deliberately: it captures WITHOUT
      // any check failing, so this isolates "the run wrote to the store" from "the run failed" — the
      // trap fires on a savepoint that was otherwise completely clean.
      const capturing = cli(p.dir, 'savepoint', '--verify', '--candidate', 'finding:the export route drops rows above 10k');
      assert.equal(capturing.code, 0, `sanity: this run must otherwise be clean: ${JSON.stringify((capturing.json.checks || []).filter((c) => c.outcome !== 'PASS' && c.outcome !== 'NOT_APPLICABLE'))}`);
      assert.equal((capturing.json.capturedCandidates || []).length, 1, 'sanity: this run captured no new lead, so it is not exercising the trap');
      const refresh = rowFor(capturing, `register:refresh:${LESSONS_REL}`);
      assert.ok(refresh && refresh.outcome === 'PASS', `the register was left behind the store this run wrote to: ${JSON.stringify(refresh)}`);
      assert.match(readLessons(p.dir), /- \*\*candidate leads:\*\* 4/, 'the refresh did not actually re-render the register');

      // …and the register's own rows never mint a candidate ABOUT the size of the candidate store,
      // which is a lead that changes every time it is recorded and so can never dedupe.
      assert.deepEqual((capturing.json.capturedCandidates || []).filter((c) => c.claim.includes('LESSONS.md')), [],
        'a row about the register minted a candidate memory in the store the register counts');

      // THE POINT: the very next run is clean. Before the refresh existed this returned exit 1 on a
      // register that was correct when it was written, and every capturing savepoint condemned the next.
      const after = cli(p.dir, 'savepoint', '--verify');
      assert.equal(claimsRow(after).outcome, 'PASS', `the register was stale on the run after a capture: ${claimsRow(after).detail}`);
      assert.equal(after.code, 0, 'a savepoint that captured a lead made the following savepoint unable to return 0');
    } finally { rm(p.dir); }
  });

  /*
   * ⛔ THE SHIPPED TEMPLATE IS CHECKED AGAINST THE RENDERER, NOT LEFT TO LOOK RIGHT. `spine/derived/`
   * is what a target's `docs/derived/` starts as, and a template whose markers were spelled by hand can
   * drift from the ones `render.js` writes without anything noticing: the first savepoint would then
   * treat it as a hand-authored document, archive it, and import an empty placeholder into the
   * protected NOTE block as though it were somebody's prose. So the markers are compared to the
   * renderer's own constants, and the note round-trips through the same reader savepoint uses.
   */
  test('the shipped spine/derived/LESSONS.md template is spelled with the renderer\'s own markers', () => {
    const template = fs.readFileSync(path.join(path.dirname(KERNEL), 'spine', 'derived', 'LESSONS.md'), 'utf8');
    for (const marker of [render.GEN_OPEN, render.GEN_CLOSE, render.NOTE_OPEN, render.NOTE_CLOSE]) {
      assert.ok(template.includes(marker), `the template does not carry the renderer's ${marker.slice(0, 40)}… marker`);
    }
    assert.match(template, /DERIVED — do not hand-edit/, 'the template lost the banner every derived doc carries');
    // It ships CARRYING a generated block, so the first savepoint REPLACES it rather than migrating it.
    // A template with no generated block would be indistinguishable from a hand-authored predecessor.
    assert.notEqual(render.driftFromGenerated(template, template, 'LESSONS.md').outcome, OUTCOME.CANNOT_DETERMINE,
      'the template has no generated block, so the first savepoint --write would treat it as a hand-authored document and archive it');
    assert.equal(render.rawNote(template), '_(no human note)_', 'the template\'s NOTE block is not readable by the reader savepoint uses on it');
  });

  test('greenfield-app · a verify-only run never REPAIRS a register it has just reported as wrong', () => {
    const p = archetype('greenfield-app', { graph: TWO_LESSONS, candidates: THREE_LEADS });
    try {
      assert.equal(cli(p.dir, 'savepoint', '--write').code, 0);
      const handEdited = readLessons(p.dir).replace('**verified lessons:** 2', '**verified lessons:** 9');
      fs.writeFileSync(lessonsPath(p.dir), handEdited);
      // A run that also captures something: without the "was it in step" guard, the refresh would
      // silently overwrite the hand-edit this same run just FAILed on.
      const r = cli(p.dir, 'savepoint', '--verify', '--candidate', 'finding:a lead the operator typed in');
      assert.equal(claimsRow(r).outcome, 'FAIL');
      assert.equal(readLessons(p.dir), handEdited, 'a check-only run rewrote the document it had just reported as wrong');
      assert.equal(rowFor(r, `register:refresh:${LESSONS_REL}`), undefined, 'a refresh row was emitted for a register that was never in step');
    } finally { rm(p.dir); }
  });
});

/*
 * P2-O-2 · THE AFTER ACTION REPORT (Class C: output shaped for a human's attention).
 *
 * Three archetypes, because the claim is about a CLASS and not about one repository shape:
 *   mature-product  a real window: two source commits, two savepoints, candidates, a closed goal
 *   docs-only       the honest short report, which says what it does not have instead of padding
 *   greenfield-app  a goal that REFUSES to close, which must write no report at all
 *
 * The load-bearing assertions are the refusals, not the prose: counts WITHHELD rather than caveated
 * when a committed STATE.json did not describe its own revision (anti-drift item 5), a candidate shown
 * as an unverified lead (item 11), a second write refused rather than overwriting (this task's own
 * contract), and the report never moving a goal closure in either direction (item 9).
 */
describe('P2-O-2 · after action reports', () => {
  const AAR_DIR = path.join('docs', 'derived', 'aar');
  const candidatesLib = createRequire(import.meta.url)(path.join(path.dirname(KERNEL), 'core', 'memory', 'candidates.js'));

  /** The pack's five optional contracts DECIDED, so a savepoint here is about this task and not about onboarding. */
  const aarConfig = () => JSON.stringify({
    routeSource: { notApplicable: true, reason: 'aar fixture: this project serves no routes' },
    codeTruth: { notApplicable: true, reason: 'aar fixture: no code-truth source' },
    qualityGate: { notApplicable: true, reason: 'aar fixture: quality checks are outside these tests' },
    state: {
      removals: { notApplicable: 'aar fixture: this project has retired nothing' },
      reconcile: { notApplicable: true, reason: 'aar fixture: no task system to reconcile against' },
    },
  }, null, 2);

  function aarFixture(kind, { requirements = [{ id: 'R-1', mandatory: true, priority: 'P2' }] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-aar-${kind}-`));
    materializeProject(kind, dir, { git: false });
    const sd = path.join(dir, stateLib.STATE_DIR);
    fs.mkdirSync(path.join(sd, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'requirements.json'), JSON.stringify({ schemaVersion: '1.0.0', denominatorVersion: 'aar-1', requirements, gates: {} }, null, 2));
    fs.writeFileSync(path.join(sd, 'goal.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), aarConfig());
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'aar@respawnpack.test'); git('config', 'user.name', 'AAR');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A'); git('commit', '--quiet', '-m', 'chore: fixture');
    return { dir, git, head: () => git('rev-parse', 'HEAD').trim() };
  }

  /*
   * ⛔ A SAVEPOINT COMMIT, COMMITTED THE WAY THE DOCUMENTED CLOSEOUT COMMITS ONE: the RENDERED outputs
   * only. `docs/derived/state/` is a compiler INPUT, so sweeping it in here would make the commit
   * source-touching and the state committed above it would correctly stop describing its own revision,
   * which is the very distinction these fixtures exercise on purpose rather than by accident.
   */
  function savepointCommit(p) {
    cli(p.dir, 'savepoint', '--write');
    for (const rel of ['docs/derived/STATE.json', 'docs/derived/CONTINUITY.md', 'docs/derived/GAPS.md', 'memory/candidates']) {
      if (fs.existsSync(path.join(p.dir, rel))) p.git('add', '--', rel);
    }
    p.git('commit', '--quiet', '-m', 'chore: savepoint');
    return p.head();
  }

  const reportsIn = (dir) => {
    try { return fs.readdirSync(path.join(dir, AAR_DIR)).filter((f) => f.endsWith('.md')).sort(); }
    catch { return []; }
  };

  /**
   * The mature-product window: savepoint S1, two source commits, savepoint S2, two candidates of which
   * one is promoted. Both S1 and S2 carry a STATE.json that describes its own revision, so a window
   * from S1 to S2 is the case where counts may legitimately be printed.
   */
  function matureWindow() {
    const p = aarFixture('mature-product');
    const s1 = savepointCommit(p);

    fs.appendFileSync(path.join(p.dir, 'src', 'health.js'), '\nexport const ready = () => true;\n');
    p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'feat: report readiness beside health');
    const c1 = p.head();
    fs.appendFileSync(path.join(p.dir, 'docs', 'README.md'), '\nReadiness is reported at /ready.\n');
    p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'docs: describe the readiness endpoint');
    const c2 = p.head();

    const store = { dir: path.join(p.dir, 'memory', 'candidates') };
    const kept = candidatesLib.capture(store, { claim: 'the readiness probe races the pool warm-up', klass: 'finding', provenance: { cycleId: 'cyc-aar-1', by: 'fixture', evidencePaths: [] } });
    const promotedRec = candidatesLib.capture(store, { claim: 'the health route must never touch the database', klass: 'constraint', provenance: { cycleId: 'cyc-aar-1', by: 'fixture', evidencePaths: ['src/health.js'] } });

    // Evidence bound to c2 and deliberately NOT committed: committing it under docs/derived/state/
    // would make the savepoint commit source-touching.
    fs.writeFileSync(path.join(p.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence(c2, ['R-1'])));
    const s2 = savepointCommit(p);

    // Promoted AFTER the savepoint commit, because promotion also writes memory/graph/, which is not a
    // savepoint output and would make the commit source-touching if it were swept in.
    const promo = cli(p.dir, 'memory', 'candidates', 'promote', promotedRec.record.id, '--as', 'constraint/health-no-db', '--verified-by', 'read src/health.js at c2');
    assert.equal(promo.code, 0, `the fixture's promotion must succeed: ${promo.stderr || JSON.stringify(promo.json)}`);
    return { p, s1, c1, c2, s2, keptId: kept.record.id, promotedId: promotedRec.record.id };
  }

  // --- STATE 1 · the full window, with counts, commits and candidates -----------------------------
  test('mature-product · both ends current: BLUF first, counts present, commits grouped, the kept candidate an unverified lead', () => {
    const f = matureWindow();
    try {
      const r = cli(f.p.dir, 'aar', '--since', f.s1, '--until', f.s2, '--title', 'Readiness phase', '--write');
      assert.equal(r.json.wrote, `docs/derived/aar/${r.json.window.untilDate}-readiness-phase.md`,
        `the report path is not the documented one: ${JSON.stringify(r.json.checks)}`);
      const doc = fs.readFileSync(path.join(f.p.dir, r.json.wrote), 'utf8');

      // BLUF FIRST. Not "somewhere near the top": the first `## ` section after the banner and title.
      assert.equal(/^##\s+(.*)$/m.exec(doc)[1], 'Bottom line', 'the first section of the report is not the bottom line');
      assert.ok(doc.indexOf('DERIVED') < doc.indexOf('## Bottom line'), 'the banner must precede the bottom line');
      assert.ok(doc.includes(render.GEN_OPEN) && doc.includes(render.GEN_CLOSE), 'the whole report must sit in a generated block');
      assert.ok(doc.includes(render.NOTE_OPEN) && doc.includes(render.NOTE_CLOSE), 'the human NOTE block is missing');

      // Counts, because BOTH committed states describe their own revisions.
      assert.equal(r.json.checks.find((c) => c.check === 'aar:state:start').outcome, 'PASS');
      assert.equal(r.json.checks.find((c) => c.check === 'aar:state:end').outcome, 'PASS');
      assert.match(doc, /\d+ mandatory requirements, of which \d+ conformant/, 'a current state must contribute its counts');
      assert.doesNotMatch(doc, /WITHHELD/, 'nothing may be withheld when both ends describe their own revisions');

      // The window is stated, including which rule chose each end.
      assert.match(doc, new RegExp(`- \\*\\*Window since:\\*\\* \`${f.s1}\``));
      assert.match(doc, new RegExp(`- \\*\\*Window until:\\*\\* \`${f.s2}\``));
      assert.match(doc, /named by --since/);

      // The commits, grouped by their conventional prefix.
      assert.match(doc, /\*\*feat\*\* \(1\)/);
      assert.match(doc, /report readiness beside health/);
      assert.match(doc, /describe the readiness endpoint/);

      // ⛔ ITEM 11 · the candidate that stayed a candidate is a LEAD, and the promoted one is not
      // presented as one. A report is where a lead becomes visible, never where it becomes true.
      const keptLine = doc.split('\n').find((l) => l.includes(f.keptId) && l.startsWith('- **'));
      assert.ok(keptLine, `the kept candidate ${f.keptId} does not appear in the report`);
      assert.match(keptLine, /UNVERIFIED LEAD/, 'a candidate nobody promoted was not marked an unverified lead');
      assert.ok(doc.split('\n').some((l) => l.includes(f.promotedId) && l.includes('PROMOTED')),
        'the promoted candidate must be shown as promoted, on the journal own word and not on the report guess');
      assert.match(doc, /races the pool warm-up/, 'the claim behind a candidate must be readable without opening a second file');

      // Machine-local records are LABELLED, so a reader on another clone cannot read their absence as silence.
      assert.match(doc, /machine-local/i);
      assert.match(doc, /## Owner actions/);
    } finally { rm(f.p.dir); }
  });

  // --- STATE 2 · a stale end WITHHOLDS, and a second write refuses ---------------------------------
  test('mature-product · a start revision whose state is stale for it WITHHOLDS the counts, never caveats them', () => {
    const f = matureWindow();
    try {
      // c1 is a SOURCE commit: the STATE.json committed there is the one S1 wrote, bound to the commit
      // before c1, so it does not describe c1 and its counts are not printable.
      const r = cli(f.p.dir, 'aar', '--since', f.c1, '--until', f.s2, '--title', 'Stale start');
      const start = r.json.checks.find((c) => c.check === 'aar:state:start');
      assert.equal(start.outcome, 'CANNOT_DETERMINE', 'a state that does not describe its own revision is undetermined, never a pass');
      assert.equal(r.code, 2, 'the exit of the verb follows the rollup of its own rows');
      assert.match(r.json.document, /WITHHELD/, 'the word the reader has to see is missing');
      const startSection = r.json.document.split('### End')[0].split('### Start')[1];
      assert.match(startSection, /\*\*Counts WITHHELD\.\*\*/, 'the stale end must withhold rather than print with a warning');
      assert.doesNotMatch(startSection, /mandatory requirements, of which/, 'a withheld end printed its counts anyway');
      // The END is still current, so the report is not degraded wholesale by one bad end.
      assert.equal(r.json.checks.find((c) => c.check === 'aar:state:end').outcome, 'PASS');
      assert.match(r.json.document.split('### End')[1], /mandatory requirements, of which/);
    } finally { rm(f.p.dir); }
  });

  test('mature-product · a second --write for the same window refuses at exit 2 and leaves the file byte-identical', () => {
    const f = matureWindow();
    try {
      const first = cli(f.p.dir, 'aar', '--since', f.s1, '--until', f.s2, '--title', 'Readiness phase', '--write');
      const rel = first.json.wrote;
      assert.ok(rel, 'the first write must land, or this test proves nothing');
      const before = fs.readFileSync(path.join(f.p.dir, rel));

      const second = cli(f.p.dir, 'aar', '--since', f.s1, '--until', f.s2, '--title', 'Readiness phase', '--write');
      assert.equal(second.code, 2, 'a refusal to overwrite is CANNOT_DETERMINE at exit 2, not a silent success and not a FAIL');
      assert.equal(second.json.wrote, null);
      const row = second.json.checks.find((c) => c.check === 'aar:write');
      assert.equal(row.outcome, 'CANNOT_DETERMINE');
      assert.match(row.detail, new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the refusal must name the file it refused to replace');
      assert.deepEqual(fs.readFileSync(path.join(f.p.dir, rel)), before, 'the existing report was modified by a run that said it refused');
      assert.deepEqual(reportsIn(f.p.dir), [path.basename(rel)], 'the refusal must not write a second file either');
    } finally { rm(f.p.dir); }
  });

  // --- STATE 3 · the goal-completion trigger, and the two ways it writes nothing --------------------
  test('mature-product · a successful `contract complete goal` writes the report and names it; --no-aar does not', () => {
    const withReport = aarFixture('mature-product');
    try {
      cli(withReport.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship readiness', '--completion', 'all-mandatory-conformant');
      fs.writeFileSync(path.join(withReport.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence(withReport.head(), ['R-1'])));
      const r = cli(withReport.dir, 'contract', 'complete');
      assert.equal(r.json.outcome, 'PASS', `the goal must close, or the trigger is untested: ${r.json.error}`);
      assert.ok(r.json.aar && r.json.aar.wrote, `the close reported no report path: ${JSON.stringify(r.json.aar)}`);
      const doc = fs.readFileSync(path.join(withReport.dir, r.json.aar.wrote), 'utf8');
      assert.match(doc, /# After Action Report . ship readiness/, 'the report must be titled with the goal that closed');
      assert.equal(/^##\s+(.*)$/m.exec(doc)[1], 'Bottom line');
    } finally { rm(withReport.dir); }

    const skipped = aarFixture('mature-product');
    try {
      cli(skipped.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship readiness', '--completion', 'all-mandatory-conformant');
      fs.writeFileSync(path.join(skipped.dir, stateLib.STATE_DIR, 'evidence', 'e.json'), JSON.stringify(evidence(skipped.head(), ['R-1'])));
      const r = cli(skipped.dir, 'contract', 'complete', '--no-aar');
      assert.equal(r.json.outcome, 'PASS', `--no-aar must not change whether the goal closes: ${r.json.error}`);
      assert.equal(r.json.aar, undefined, '--no-aar still produced a report record');
      assert.deepEqual(reportsIn(skipped.dir), [], '--no-aar wrote a report anyway');
      assert.ok(!stateLib.readGoalDoc(skipped.dir).ongoingGoalId, 'the goal must still be closed and archived');
    } finally { rm(skipped.dir); }
  });

  test('greenfield-app · a goal that REFUSES to close writes no report, and the refusal is unchanged', () => {
    const p = aarFixture('greenfield-app');
    try {
      cli(p.dir, 'contract', 'goal', '--id', 'G-1', '--goal', 'ship the app', '--completion', 'all-mandatory-conformant');
      // No evidence: R-1 is unevidenced, so goalCompletion is UNMET and item 9 refuses.
      const r = cli(p.dir, 'contract', 'complete');
      assert.equal(r.json.outcome, 'FAIL', 'an unmet criterion must still refuse the close');
      assert.equal(r.code, 1);
      assert.equal(r.json.aar, undefined, 'a refused close produced a report record');
      assert.deepEqual(reportsIn(p.dir), [], 'a refused close wrote a report, and a report may never accompany a refusal');
      assert.equal(stateLib.readGoalDoc(p.dir).ongoingGoalId, 'G-1', 'the refused goal must still be the ongoing one');
    } finally { rm(p.dir); }
  });

  // --- STATE 4 · the honest short report, and an input that could not be read ----------------------
  test('docs-only · no goal and no candidates still writes a real report that says so, at exit 0', () => {
    const p = aarFixture('docs-only', { requirements: [] });
    try {
      const s1 = savepointCommit(p);
      fs.appendFileSync(path.join(p.dir, 'docs', 'guide.md'), '\nA further paragraph.\n');
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'docs: extend the guide');
      const s2 = savepointCommit(p);

      const r = cli(p.dir, 'aar', '--since', s1, '--until', s2, '--title', 'Docs pass', '--write');
      assert.equal(r.code, 0, `an absent record is a fact about the project, not an undetermined check: ${JSON.stringify(r.json.checks)}`);
      const doc = fs.readFileSync(path.join(p.dir, r.json.wrote), 'utf8');
      assert.equal(/^##\s+(.*)$/m.exec(doc)[1], 'Bottom line');
      assert.match(doc, /No project goal was on record/, 'the short report must say what it does not have');
      assert.match(doc, /keeps no `memory\/candidates\/audit\.jsonl`/, 'an absent journal must be stated, not omitted');
      assert.match(doc, /Nothing here is waiting on you\./, 'a report with no unreadable input must say its owner-actions section is empty');
      assert.match(doc, /extend the guide/, 'the commits in the window must still be listed');
      assert.equal(r.json.checks.find((c) => c.check === 'aar:candidates').outcome, 'NOT_APPLICABLE');
    } finally { rm(p.dir); }
  });

  test('docs-only · an unreadable candidate journal is a CANNOT_DETERMINE row INSIDE the owner-actions section, and the rest is written', () => {
    const p = aarFixture('docs-only', { requirements: [] });
    try {
      const s1 = savepointCommit(p);
      fs.appendFileSync(path.join(p.dir, 'docs', 'guide.md'), '\nAnother paragraph.\n');
      p.git('add', '-A'); p.git('commit', '--quiet', '-m', 'docs: extend the guide again');
      const s2 = savepointCommit(p);

      // A directory where the journal belongs: readable path, unreadable file, which is EISDIR on every
      // platform this pack runs on. "Could not read it" must never collapse into "there was nothing".
      const journal = path.join(p.dir, 'memory', 'candidates', 'audit.jsonl');
      fs.rmSync(journal, { force: true });
      fs.mkdirSync(journal, { recursive: true });

      const r = cli(p.dir, 'aar', '--since', s1, '--until', s2, '--title', 'Broken journal', '--write');
      assert.equal(r.code, 2, 'an unreadable input is CANNOT_DETERMINE, not a pass');
      assert.ok(r.json.wrote, 'the report must still be written: an unreadable input shortens a report, it does not cancel one');
      const doc = fs.readFileSync(path.join(p.dir, r.json.wrote), 'utf8');
      const ownerActions = doc.split('## Owner actions')[1];
      assert.ok(ownerActions, 'the owner-actions section is missing');
      assert.match(ownerActions, /aar:candidates/, 'the unreadable input is not reported where a human would look for it');
      assert.match(doc, /extend the guide again/, 'the rest of the report must still be composed');
      assert.match(doc, /The one thing to know: 1 input could not be read/, 'the bottom line must lead with the gap, not bury it');
    } finally { rm(p.dir); }
  });

  // --- the shared vocabulary, held equal from source ------------------------------------------------
  /*
   * ⛔ THE WINDOW IS BOUNDED IN UTC, THE CLOCK THE JOURNAL KEEPS. The first release bounded it by the
   * committer's LOCAL calendar day (`git show --date=short`) while every row it reads is stamped
   * `toISOString()`, so from 20:00 in the committer's zone a lead captured minutes before the closing
   * savepoint sat on "the 4th" in the journal and outside a window that ended on "the 3rd", and the
   * report said no candidate was captured. Found on the merged tree the evening it was merged, by the
   * mature-product test above, which had passed all afternoon. The commits below carry an explicit
   * -04:00 offset so the case reproduces on a runner in any zone, and the journal is written by hand
   * because a capture stamps the wall clock, which is the one thing this test must not depend on.
   */
  test('⛔ the window is bounded in UTC, so a lead captured after 20:00 in the committer zone is still inside the savepoint that closed it', () => {
    for (const kind of ['greenfield-app', 'ops-infra']) {
      const p = aarFixture(kind);
      try {
        const gitAt = (iso, ...a) => execFileSync('git', a, { cwd: p.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso } });
        fs.appendFileSync(path.join(p.dir, 'README.md'), '\nevening work\n');
        gitAt('2026-09-03T20:30:00-04:00', 'add', '-A');
        gitAt('2026-09-03T20:30:00-04:00', 'commit', '--quiet', '-m', 'chore: start of the evening');
        const s1 = p.head();
        // The local day of that commit is the 3rd on every machine (git renders the recorded offset);
        // its UTC day is the 4th. The defect state is exactly "the report chose the first".
        assert.equal(p.git('show', '-s', '--format=%cd', '--date=short', s1).trim(), '2026-09-03', 'the fixture must sit on the evening side of the day boundary');

        const store = path.join(p.dir, 'memory', 'candidates');
        fs.mkdirSync(store, { recursive: true });
        const scratch = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rp-aar-utc-')) };
        const rec = candidatesLib.capture(scratch, { claim: `${kind}: the evening lead`, klass: 'finding', provenance: { cycleId: 'cyc-utc', by: 'fixture', evidencePaths: [] } }).record;
        rm(scratch.dir);
        const early = 'cm_utc00000000early', late = 'cm_utc000000000late';
        for (const [id, at] of [[rec.id, '2026-09-04T00:35:00.000Z'], [early, '2026-09-03T23:59:59.999Z'], [late, '2026-09-05T00:00:00.001Z']]) {
          fs.writeFileSync(path.join(store, `${id}.json`), `${JSON.stringify({ ...rec, id, provenance: { ...rec.provenance, at } }, null, 2)}\n`);
        }
        fs.writeFileSync(path.join(store, 'audit.jsonl'), [
          { at: '2026-09-03T23:59:59.999Z', action: 'capture', id: early, klass: 'finding', cycleId: 'cyc-utc', by: 'fixture' },
          { at: '2026-09-04T00:35:00.000Z', action: 'capture', id: rec.id, klass: 'finding', cycleId: 'cyc-utc', by: 'fixture' },
          { at: '2026-09-05T00:00:00.001Z', action: 'capture', id: late, klass: 'finding', cycleId: 'cyc-utc', by: 'fixture' },
        ].map((r) => JSON.stringify(r)).join('\n') + '\n');
        gitAt('2026-09-03T20:40:00-04:00', 'add', '-A');
        gitAt('2026-09-03T20:40:00-04:00', 'commit', '--quiet', '-m', 'chore: the closing savepoint of the evening');
        const s2 = p.head();

        const r = cli(p.dir, 'aar', '--since', s1, '--until', s2, '--title', 'Evening window', '--write');
        assert.equal(r.json && r.json.window && r.json.window.sinceDate, '2026-09-04', `${kind}: the window must open on the UTC day of the since commit: ${JSON.stringify(r.json && r.json.window)}`);
        assert.equal(r.json.window.untilDate, '2026-09-04', `${kind}: the window must close on the UTC day of the until commit`);
        assert.equal(r.json.wrote, 'docs/derived/aar/2026-09-04-evening-window.md', `${kind}: the report is filed under the UTC day it closed on`);
        const doc = fs.readFileSync(path.join(p.dir, r.json.wrote), 'utf8');
        const lines = doc.split('\n');
        assert.ok(lines.some((l) => l.includes(rec.id) && l.includes(candidatesLib.UNVERIFIED_MARKER)), `${kind}: the lead captured at 00:35Z on the 4th must be inside the window that closed at 00:40Z on the 4th`);
        assert.match(doc, /the evening lead/, `${kind}: its claim must be readable in the report`);
        assert.equal(r.json.checks.find((c) => c.check === 'aar:candidates').outcome, 'PASS');
        // The nearest bypasses: a row a millisecond before the UTC day opened, and one a millisecond
        // after it closed, are outside it. The bound moved to UTC; it did not widen.
        assert.ok(!lines.some((l) => l.includes(early)), `${kind}: a row before the UTC day of the since commit is outside the window`);
        assert.ok(!lines.some((l) => l.includes(late)), `${kind}: a row after the UTC day of the until commit is outside the window`);
        assert.match(doc, /committer dates, UTC/, `${kind}: the report must say which clock its dates are in`);
      } finally { rm(p.dir); }
    }
  });

  test('⛔ the unverified-lead phrase in the report is the ONE core/memory/candidates.js exports', () => {
    assert.equal(candidatesLib.UNVERIFIED_MARKER, 'UNVERIFIED LEAD');
    const src = fs.readFileSync(path.join(KERNEL, 'lib', 'aar.js'), 'utf8');
    const declared = /const UNVERIFIED_MARKER = '([^']+)';/.exec(src);
    assert.ok(declared, 'kernel/lib/aar.js no longer declares the marker as a literal, so re-aim this fence rather than deleting it');
    assert.equal(declared[1], candidatesLib.UNVERIFIED_MARKER,
      'the report calls a candidate something different from what the module that owns the wall calls it, and two vocabularies for one rule is how a lead becomes a finding');
  });
});

/*
 * ⛔ P2-Q-2 · THE READINESS CHECKLIST, SCALED BY POSTURE — quality by DETECTION, in four archetypes.
 *
 * Class E (the class audit, "A readiness checklist by posture"): a project's release readiness
 * should be FOUND from the tree and the declarations, not asserted in a skill's prose. `/ship` Step 1
 * used to be a paragraph, and a paragraph has no exit code — so the questions a release turns on were
 * asked by whoever happened to remember them.
 *
 * ⛔ THE FIXTURES ARE THE FOUR ARCHETYPES, AND THAT IS THE POINT RATHER THAN THOROUGHNESS. The readiness
 * question is a DIFFERENT question in each: ops-infra is asked for a remote state backend and vaulted
 * inventories, greenfield-app for a health route, a lockfile and error tracking, docs-only for an index
 * and a link check, and the mature product for all of the general ones at once. A mechanism proved on
 * one shape would be a mechanism tuned to one shape.
 *
 * THREE STATES PER MECHANISM, on real CLI runs rather than on the module:
 *   PASS              the item finds its evidence; under a relaxing posture a FAIL is reported and the
 *                     verb still exits 0, with the reason it would have failed still first in `detail`
 *   FAIL              the evidence is removed and the verb exits 1 under a DECLARED strict
 *   CANNOT_DETERMINE  a tree nothing was recognised in — `readiness:applicable`, exit 2, never green
 * plus the neighbour that must NOT move: an exception lifts exactly one item, in every posture, and
 * lifts nothing else.
 */
describe('P2-Q-2 · the readiness checklist', () => {
  const readinessLib = createRequire(import.meta.url)('./lib/readiness.js');
  const Q2_ROOT = path.dirname(KERNEL);

  const fixture = (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rp-q2-${kind}-`));
    materialize(kind, dir);
    return dir;
  };
  const put = (dir, rel, body) => {
    const abs = path.join(dir, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  const configure = (dir, value) => put(dir, 'respawnpack.config.json', `${JSON.stringify(value, null, 2)}\n`);
  const rowsOf = (r) => Object.fromEntries((r.json.checks || []).map((c) => [c.check, c]));
  const row = (r, id) => rowsOf(r)[`readiness:${id}`];

  /*
   * The general items a founder closes once and never thinks about again, written on top of an
   * archetype so a per-archetype test can assert on its OWN item at the VERB's exit code rather than
   * only on a row. Without this the ops-infra strict run exits 1 whether or not the backend is there,
   * and the discrimination the test claims would be vacuous.
   */
  const closeTheGeneralItems = (dir, extra = {}) => {
    put(dir, 'README.md', '# fixture\n\nWhat this is and how to run it.\n');
    put(dir, 'LICENSE', 'MIT License\n');
    put(dir, '.gitignore', 'node_modules/\n.env\n');
    put(dir, '.github/CODEOWNERS', '* @fixture-owner\n');
    put(dir, '.github/workflows/ci.yml', 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n');
    put(dir, '.github/workflows/respawnpack-security.yml', 'name: respawnpack-security\non: [push]\njobs:\n  secret-scan:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: gitleaks/gitleaks-action@v2\n');
    configure(dir, {
      respawnpack: '0.3.0',
      qualityGate: { checks: [{ name: 'test', command: 'true' }] },
      ...extra,
    });
  };

  // --- ops-infra ---------------------------------------------------------------------------------

  test("PASS · ops-infra under a DECLARED strict: the fixture's backend.tf satisfies remote-state-backend and the verb exits 0", () => {
    const dir = fixture('ops-infra');
    try {
      closeTheGeneralItems(dir, { posture: { profile: 'strict' } });
      const r = cli(dir, 'readiness');
      const be = row(r, 'remote-state-backend');
      assert.ok(be, `remote-state-backend is not a row on a Terraform tree: ${Object.keys(rowsOf(r)).join(', ')}`);
      assert.equal(be.outcome, OUTCOME.PASS, be.detail);
      assert.match(be.detail, /backend\.tf/, 'the PASS must name the evidence it found, not merely report agreement');
      assert.equal(be.checked > 0, true, 'a PASS that examined nothing is the zero-work green outcome.js refuses');
      // Every applicable row PASSes, so the VERB's exit code is what the next assertion can move.
      const failing = (r.json.checks || []).filter((c) => c.outcome !== OUTCOME.PASS && c.outcome !== OUTCOME.NOT_APPLICABLE);
      assert.deepEqual(failing.map((c) => `${c.check}: ${c.detail}`), [], 'the topped-up ops-infra fixture must have every applicable item met');
      assert.equal(r.code, 0, `a fully-met checklist under strict must exit 0: ${r.stdout.slice(0, 400)}`);
      // The Ansible items are real rows on this tree too, and they examined the inventories.
      assert.equal(row(r, 'vaulted-inventory').outcome, OUTCOME.PASS);
      assert.ok(row(r, 'vaulted-inventory').checked >= 2, 'the two fixture inventories must each have been examined');
    } finally { rm(dir); }
  });

  test('FAIL · the same tree with the backend block removed FAILs the row and the verb, at exit 1', () => {
    const dir = fixture('ops-infra');
    try {
      closeTheGeneralItems(dir, { posture: { profile: 'strict' } });
      put(dir, 'backend.tf', 'terraform {\n  required_version = ">= 1.5.0"\n}\n');
      const r = cli(dir, 'readiness');
      const be = row(r, 'remote-state-backend');
      assert.equal(be.outcome, OUTCOME.FAIL, be.detail);
      assert.match(be.detail, /state lives only on the machine that ran apply/, 'the FAIL must say what is wrong');
      assert.match(be.detail, /Declare a remote backend/, 'and it must carry the remedy, or the reader has to go and find out');
      assert.equal(r.code, 1, 'a FAIL row under a DECLARED strict must fail the verb');
      assert.equal(r.json.outcome, OUTCOME.FAIL);
      assert.deepEqual(r.json.wouldFail, ['remote-state-backend'], 'exactly one item moved — the neighbours must not have shifted with it');
    } finally { rm(dir); }
  });

  test('PASS (relaxed) · the same broken tree under a declared `standard`: the same FAIL row, the verb exits 0, the detail names strict', () => {
    const dir = fixture('ops-infra');
    try {
      closeTheGeneralItems(dir, { posture: { profile: 'standard' } });
      put(dir, 'backend.tf', 'terraform {\n  required_version = ">= 1.5.0"\n}\n');
      const r = cli(dir, 'readiness');
      const be = row(r, 'remote-state-backend');
      assert.ok(be, 'the relaxed row must still be REPORTED — relaxing is not hiding (anti-drift item 3)');
      assert.equal(be.outcome, OUTCOME.PASS, 'under `advise` the outcome moves and only the outcome');
      assert.equal(be.postureRelaxed, 'standard');
      assert.equal(be.postureRule, readinessLib.POSTURE_ROW);
      assert.match(be.detail, /^no `backend/, 'the relaxed row must OPEN with the reason it would have failed, not with the posture');
      assert.match(be.detail, /relaxes this row to an advisory/);
      assert.equal(r.code, 0, 'a declared `standard` reports the finding rather than refusing on it');
      assert.match(r.json.why, /would FAIL under `strict`/, "the verdict must say what strict's answer would have been");
      assert.deepEqual(r.json.relaxed, ['remote-state-backend']);
      // The same rows, in the same order, as the strict run: only the outcome column moved.
      configure(dir, { respawnpack: '0.3.0', qualityGate: { checks: [{ name: 'test', command: 'true' }] }, posture: { profile: 'strict' } });
      const strict = cli(dir, 'readiness');
      assert.deepEqual((strict.json.checks || []).map((c) => c.check), (r.json.checks || []).map((c) => c.check),
        '`advise` reported a different SET of rows than `deny` — the posture may change which outcome a row returns, never which rows exist');
    } finally { rm(dir); }
  });

  test('NOT_APPLICABLE (tier) · under a declared `light` the full-tier item is still a ROW, naming the profile, and is never silently absent', () => {
    const dir = fixture('ops-infra');
    try {
      closeTheGeneralItems(dir, { posture: { profile: 'light' } });
      put(dir, 'backend.tf', 'terraform {\n  required_version = ">= 1.5.0"\n}\n');
      const r = cli(dir, 'readiness');
      const be = row(r, 'remote-state-backend');
      assert.ok(be, 'a full-tier item vanished under `light` — an item that is never a row is the silent skip anti-drift item 12 refuses');
      assert.equal(be.outcome, OUTCOME.NOT_APPLICABLE);
      assert.match(be.detail, /not asked under the declared `light` posture/, 'the row must name the declaration that scoped it out');
      assert.match(be.detail, /kernel:readiness/, 'and the ADR row that decided it');
      assert.match(be.detail, /Declare `standard` or `strict`/, 'and how to have it asked for real');
      assert.equal(r.json.tier, 'essential');
      assert.equal(r.code, 0);
      // The essential tier really did run: at least one item was examined, so this is not a zero-work pass.
      assert.ok((r.json.checks || []).some((c) => c.outcome === OUTCOME.PASS && c.checked > 0), 'the essential tier produced no examined row at all');
    } finally { rm(dir); }
  });

  test("EXCEPTION · a declared readiness exception lifts exactly that item, in every posture, under its own id and reason", () => {
    const dir = fixture('ops-infra');
    const exception = {
      id: 'RANGE-1',
      rule: 'readiness',
      match: { item: 'remote-state-backend' },
      reason: 'the range is disposable and its state is rebuilt from scratch on every teardown',
    };
    try {
      put(dir, 'backend.tf', 'terraform {\n  required_version = ">= 1.5.0"\n}\n');
      for (const profile of ['light', 'standard', 'strict']) {
        closeTheGeneralItems(dir, { posture: { profile }, exceptions: [exception] });
        const r = cli(dir, 'readiness');
        const be = row(r, 'remote-state-backend');
        assert.equal(be.outcome, OUTCOME.NOT_APPLICABLE, `${profile}: an exception must lift the item in EVERY posture, strict included`);
        assert.match(be.detail, /^allowed by exception RANGE-1: the range is disposable/, `${profile}: the lift must be reported under the entry's own id and reason`);
        assert.equal(be.exception, 'RANGE-1');
        assert.equal(r.code, 0, `${profile}: the lifted item must not fail the verb`);
        // ⛔ THE NEIGHBOUR. The exception names ONE item; every other row must be exactly what it was.
        assert.ok(row(r, 'no-plaintext-creds'), `${profile}: the sibling row disappeared with the excepted one`);
        assert.equal(row(r, 'vaulted-inventory').outcome, profile === 'light' ? OUTCOME.NOT_APPLICABLE : OUTCOME.PASS,
          `${profile}: the exception changed a row it does not name`);
      }
      // And the NEAREST miss must not lift: an id that is not this item's.
      closeTheGeneralItems(dir, {
        posture: { profile: 'strict' },
        exceptions: [{ ...exception, id: 'RANGE-2', match: { item: 'remote-state-backends' } }],
      });
      const near = cli(dir, 'readiness');
      assert.equal(row(near, 'remote-state-backend').outcome, OUTCOME.FAIL,
        'an exception naming a NEIGHBOURING id lifted the item — a reader that lifts on a near miss is the whole-guard escape with better manners');
      assert.equal(near.code, 1);
    } finally { rm(dir); }
  });

  test('FAIL · no-plaintext-creds finds the AWS example key in a terraform.tfvars, and names the file and the pattern', () => {
    const dir = fixture('ops-infra');
    try {
      closeTheGeneralItems(dir, { posture: { profile: 'strict' } });
      const clean = cli(dir, 'readiness');
      assert.equal(row(clean, 'no-plaintext-creds').outcome, OUTCOME.PASS,
        'precondition: the fixture inventories carry no credential, so the FAIL below is caused by the file this test adds');

      put(dir, 'terraform.tfvars', `access_key = "${AWS_EXAMPLE_KEY}"\n`);
      const r = cli(dir, 'readiness');
      const creds = row(r, 'no-plaintext-creds');
      assert.equal(creds.outcome, OUTCOME.FAIL, creds.detail);
      assert.match(creds.detail, /terraform\.tfvars \(AWS access key id\)/, 'the FAIL must name the file and which pattern matched');
      assert.match(creds.detail, /rotate it/, 'and the remedy, because a committed key stays in the history');
      assert.equal(r.code, 1);
    } finally { rm(dir); }
  });

  // --- greenfield-app ----------------------------------------------------------------------------

  test('greenfield-app · health-route and lockfile PASS from the fixture; error-tracking FAILs with its remedy rather than a guess', () => {
    const dir = fixture('greenfield-app');
    try {
      configure(dir, { respawnpack: '0.3.0', posture: { profile: 'standard' } });
      const r = cli(dir, 'readiness');
      const detected = r.json.detected || {};
      assert.equal(detected.node, 'package.json', `the Node shape was not detected: ${JSON.stringify(detected)}`);

      const health = row(r, 'health-route');
      assert.equal(health.postureRelaxed, undefined, 'health-route PASSed on its own evidence, so no relaxation may be attached to it');
      assert.equal(health.outcome, OUTCOME.PASS, health.detail);
      assert.match(health.detail, /src\/health\.js/);

      const lock = row(r, 'lockfile');
      assert.equal(lock.outcome, OUTCOME.PASS, lock.detail);
      assert.match(lock.detail, /package-lock\.json/);

      /*
       * ⛔ ABSENT IS A FAIL, NEVER A SHRUG. Under `standard` the row is relaxed to PASS for the ROLLUP,
       * and `wouldFail` is what records that strict would have refused — the finding survives the
       * relaxation, which is the whole of anti-drift item 3.
       */
      assert.ok(r.json.wouldFail.includes('error-tracking'), `error-tracking must be a finding: ${JSON.stringify(r.json.wouldFail)}`);
      const err = row(r, 'error-tracking');
      assert.match(err.detail, /^no error reporter/, 'the relaxed row must open with the reason it would have failed');
      assert.match(err.detail, /Wire an error reporter \(Sentry, Bugsnag, Rollbar, OpenTelemetry\)/, 'and carry the remedy');
      assert.equal(err.postureRelaxed, 'standard');
      assert.equal(r.code, 0, '`standard` reports rather than refuses');

      // And under a declared strict the same finding refuses.
      configure(dir, { respawnpack: '0.3.0', posture: { profile: 'strict' } });
      const strict = cli(dir, 'readiness');
      assert.equal(row(strict, 'error-tracking').outcome, OUTCOME.FAIL);
      assert.equal(strict.code, 1);
    } finally { rm(dir); }
  });

  // --- docs-only ---------------------------------------------------------------------------------

  test('docs-only · index-page and link-check PASS, and nothing Node-shaped is a row at all', () => {
    const dir = fixture('docs-only');
    try {
      configure(dir, { respawnpack: '0.3.0', posture: { profile: 'standard' } });
      const r = cli(dir, 'readiness');
      assert.deepEqual(Object.keys(r.json.detected || {}), ['docs'],
        `a documentation repository must be detected as docs and nothing else: ${JSON.stringify(r.json.detected)}`);

      assert.equal(row(r, 'index-page').outcome, OUTCOME.PASS);
      assert.match(row(r, 'index-page').detail, /docs\/index\.md/);
      assert.equal(row(r, 'link-check').outcome, OUTCOME.PASS);
      assert.match(row(r, 'link-check').detail, /\.markdownlint\.json/);

      /*
       * ⛔ AN ITEM THAT DOES NOT APPLY IS NOT A ROW. A docs tree asked for a lockfile, a health route or
       * a migrations directory is a checklist its reader learns to skip — and a NOT_APPLICABLE row for
       * each would be four lines of noise saying nothing a reader can act on.
       */
      for (const id of ['lockfile', 'health-route', 'migrations-dir', 'error-tracking', 'remote-state-backend', 'vaulted-inventory', 'no-plaintext-creds']) {
        assert.equal(row(r, id), undefined, `${id} is a row on a documentation repository, where it can never be satisfied`);
      }
      assert.ok(row(r, 'readme'), 'the general items still apply to a documentation repository');
    } finally { rm(dir); }
  });

  // --- mature-product ----------------------------------------------------------------------------

  test('mature-product under strict · every applicable row PASSes and the verb exits 0, and the four gaps it started with were real', () => {
    const dir = fixture('mature-product');
    try {
      /*
       * ⛔ THE CONTROL FIRST. Asserting "everything passes" on a tree that was topped up is vacuous
       * unless the top-up closed findings that were genuinely there, so the four gaps the archetype
       * ships with are named BEFORE they are closed.
       */
      configure(dir, { respawnpack: '0.3.0', posture: { profile: 'strict' } });
      const before = cli(dir, 'readiness');
      assert.deepEqual([...before.json.wouldFail].sort(), ['env-ignored', 'error-tracking', 'readme', 'secret-scan-ci'],
        `the mature-product archetype's real readiness gaps moved: ${JSON.stringify(before.json.wouldFail)}`);
      assert.equal(before.code, 1);
      // The items it DOES ship satisfied are found from its own files, not from the top-up below.
      for (const [id, evidence] of [['license', /LICENSE/], ['ci-workflow', /ci\.yml/], ['codeowners-filled', /@fixture-owner/],
        ['migrations-dir', /migrations\//], ['test-command', /test/], ['lockfile', /package-lock\.json/], ['health-route', /src\/health\.js/]]) {
        assert.equal(row(before, id).outcome, OUTCOME.PASS, `${id}: ${row(before, id).detail}`);
        assert.match(row(before, id).detail, evidence, `${id} passed without naming the evidence it found`);
      }

      put(dir, 'README.md', '# mature product\n\nWhat this is and how to run it.\n');
      put(dir, '.gitignore', 'node_modules/\n.env\n');
      put(dir, '.github/workflows/respawnpack-security.yml', 'name: respawnpack-security\non: [push]\njobs:\n  secret-scan:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: gitleaks/gitleaks-action@v2\n');
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      pkg.dependencies = { '@sentry/node': '^8.0.0' };
      put(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);

      const r = cli(dir, 'readiness');
      const notPassing = (r.json.checks || []).filter((c) => c.outcome !== OUTCOME.PASS);
      assert.deepEqual(notPassing.map((c) => `${c.check}: ${c.detail}`), [], 'a production-ready mature product must have no unmet applicable item under strict');
      assert.equal(r.json.outcome, OUTCOME.PASS);
      assert.equal(r.code, 0, r.stdout.slice(0, 400));
      assert.deepEqual(r.json.relaxed, [], 'nothing may be relaxed under strict — a PASS here must be earned, not declared');
      assert.ok(r.json.applicable >= 11, `only ${r.json.applicable} items applied to the richest archetype`);
    } finally { rm(dir); }
  });

  // --- CANNOT_DETERMINE --------------------------------------------------------------------------

  test('CANNOT_DETERMINE · an empty directory is readiness:applicable at exit 2, never a pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-q2-empty-'));
    try {
      const r = cli(dir, 'readiness');
      assert.deepEqual((r.json.checks || []).map((c) => c.check), ['readiness:applicable'],
        'a tree nothing was recognised in must produce exactly the one row that says so');
      assert.equal(r.json.outcome, OUTCOME.CANNOT_DETERMINE);
      assert.equal(r.json.checks[0].checked, 0);
      assert.equal(r.code, 2, 'zero applicable items must exit 2 — "I recognised nothing" is not "this is ready" (anti-drift item 1)');
      assert.match(r.json.why, /not a pass/i);

      // And a DECLARED light does not turn it green: a posture answers an unasked question, not an empty one.
      configure(dir, { respawnpack: '0.3.0', posture: { profile: 'light' } });
      const light = cli(dir, 'readiness');
      assert.equal(light.code, 2, 'a declared `light` made an unrecognisable tree green — the zero-work pass this whole contract exists to refuse');
    } finally { rm(dir); }
  });

  test('CANNOT_DETERMINE · a manifest an item needed and could not parse is never relaxed, in ANY posture', () => {
    /*
     * ⛔ ANTI-DRIFT ITEM 13, AT THE ROW LEVEL, AND IT IS THE ONE THING A POSTURE MAY NOT ANSWER FOR.
     * `light` and `standard` relax a FAIL; relaxing an unanswered question would be the gate reporting
     * green on a check that could not run. A `package.json` that is THERE and will not parse is not a
     * project without a test command: the Node shape was detected from the file existing, so "it is
     * there and I could not read it" is a third state, and `test-command` is essential-tier so every
     * profile asks it.
     */
    /*
     * The richest archetype, with its four real gaps closed, so the ONLY thing left for the verdict to
     * be about is the manifest nobody could parse. On a tree that also had FAIL rows the exit would be
     * 1 — a real failure outranks an unanswered question — and this test would prove nothing about the
     * unanswered one.
     */
    const dir = fixture('mature-product');
    try {
      put(dir, 'README.md', '# mature product\n\nWhat this is and how to run it.\n');
      put(dir, '.gitignore', 'node_modules/\n.env\n');
      put(dir, '.github/workflows/respawnpack-security.yml', 'name: respawnpack-security\non: [push]\njobs:\n  secret-scan:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: gitleaks/gitleaks-action@v2\n');
      put(dir, 'package.json', '{ "name": "broken", not json\n');
      for (const profile of ['light', 'standard', 'strict']) {
        // Deliberately NO `qualityGate.checks` entry named test: that declaration would answer
        // `test-command` from the config and the manifest would never be reached.
        configure(dir, { respawnpack: '0.3.0', posture: { profile } });
        const r = cli(dir, 'readiness');
        assert.equal((r.json.detected || {}).node, 'package.json', `${profile}: the Node shape must still be detected from the file being there`);
        const tc = row(r, 'test-command');
        assert.equal(tc.outcome, OUTCOME.CANNOT_DETERMINE, `${profile}: a check that could not run was reported as ${tc.outcome}`);
        assert.match(tc.detail, /present and could not be parsed/, `${profile}: the row must say the file was there and unreadable, not that the command is missing`);
        assert.equal(tc.postureRelaxed, undefined, `${profile}: a posture relaxed an unanswered question`);
        assert.equal(r.code, 2, `${profile}: a run carrying an unrunnable check must exit 2, not 0 and not 1`);
        assert.match(r.json.why, /could not be checked/, `${profile}: the verdict must lead with the unanswered question, not with the failures beneath it`);
      }
      // The control: the same tree with a parseable manifest answers the same item PASS.
      put(dir, 'package.json', `${JSON.stringify({ name: 'ok', scripts: { test: 'node --test' } }, null, 2)}\n`);
      configure(dir, { respawnpack: '0.3.0', posture: { profile: 'strict' } });
      assert.equal(row(cli(dir, 'readiness'), 'test-command').outcome, OUTCOME.PASS,
        'the manifest is the only thing that changed, so this item must answer for itself again');
    } finally { rm(dir); }
  });

  // --- the doctor row ----------------------------------------------------------------------------

  test('doctor · the readiness row reports the count in its three states, and stays green while the verb refuses', () => {
    const rich = fixture('mature-product');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-q2-doctor-empty-'));
    try {
      const readinessRow = (r) => (r.json.rows || []).find((x) => x.check === 'readiness');

      // ACTIVE, with the count, under a DEFAULTED (strict) posture.
      configure(rich, { respawnpack: '0.3.0' });
      const d1 = readinessRow(cli(rich, 'doctor'));
      assert.ok(d1, 'doctor grew no readiness row');
      assert.equal(d1.label, 'ACTIVE');
      assert.equal(d1.outcome, OUTCOME.PASS, 'the row reports an inventory; the VERB is what exits 1 on an unmet item');
      assert.match(d1.detail, /items, 4 failing under `strict` \(full tier\)/, d1.detail);
      assert.equal(d1.domain, 'gate');
      assert.equal(d1.subject, '.');
      assert.equal(d1.checked, 1);

      // ACTIVE, with the tier and the profile, under a declared light.
      configure(rich, { respawnpack: '0.3.0', posture: { profile: 'light' } });
      const d2 = readinessRow(cli(rich, 'doctor'));
      assert.match(d2.detail, /failing under `light` \(essential tier/, d2.detail);
      assert.match(d2.detail, /outside this tier/, 'the row must say how many items this profile is not asking for');
      assert.match(d2.detail, /reports them rather than failing on them/);

      // NOT_CONFIGURED where nothing applies — different from "checked and fine".
      const d3 = readinessRow(cli(bare, 'doctor'));
      assert.equal(d3.label, 'NOT_CONFIGURED');
      assert.equal(d3.outcome, OUTCOME.NOT_APPLICABLE);
      assert.match(d3.detail, /no readiness item applies here/);
    } finally { rm(rich); rm(bare); }
  });

  test('doctor · a readiness.js that will not load is a BROKEN ROW, not a stack trace (anti-drift item 17)', () => {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-q2-broken-'));
    const target = fixture('greenfield-app');
    try {
      fs.cpSync(KERNEL, path.join(tree, 'kernel'), { recursive: true });
      fs.cpSync(path.join(Q2_ROOT, 'hooks'), path.join(tree, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'kernel', 'lib', 'readiness.js'), 'this is not valid javascript (((\n');
      const r = spawnSync(process.execPath, [path.join(tree, 'kernel', 'respawnpack.js'), 'doctor', '--dir', target, '--json'], { encoding: 'utf8' });
      let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
      assert.ok(json, `doctor must still print a report with a broken subsystem beside it: ${r.stderr.slice(0, 400)}`);
      const broken = (json.rows || []).filter((x) => x.label === 'BROKEN').map((x) => x.check);
      assert.ok(broken.includes('readiness') || broken.includes('kernel-lib:readiness.js'),
        `a broken readiness.js produced no BROKEN row: ${JSON.stringify(broken)}`);
      assert.doesNotMatch(r.stderr, /^\s+at\s/m, 'doctor printed a raw stack instead of a row');
      // And the verb itself refuses with a named dependency rather than a traceback.
      const verb = spawnSync(process.execPath, [path.join(tree, 'kernel', 'respawnpack.js'), 'readiness', '--dir', target, '--json'], { encoding: 'utf8' });
      let vjson = null; try { vjson = JSON.parse(verb.stdout); } catch { /* left null */ }
      assert.ok(vjson, 'the readiness verb sprayed a stack instead of reporting that its engine will not load');
      assert.equal(vjson.brokenDependency, 'lib/readiness.js');
      assert.equal(verb.status, 1);
    } finally { rm(tree); rm(target); }
  });

  // --- the fences --------------------------------------------------------------------------------

  test("⛔ the credential patterns are exactly hooks/secret-scan.js's HIGH set, read from that hook's source", () => {
    /*
     * ⛔ TWO ANSWERS TO "WHAT IS A CREDENTIAL" IS THE TWO-LISTS FAILURE THIS PACK KEEPS FINDING.
     * `hooks/secret-scan.js` exports `check` and `context` and NOT its pattern table, so there is
     * nothing to require — the source is read instead, exactly as the PROJECT_TYPE_DROPS fence above
     * reads install.js. A HIGH pattern added to the guard without one here would leave this checklist
     * quietly narrower than the thing it is modelled on.
     */
    const src = fs.readFileSync(path.join(Q2_ROOT, 'hooks', 'secret-scan.js'), 'utf8');
    const block = /const PATTERNS = \[([\s\S]*?)\n\];/.exec(src);
    assert.ok(block, 'hooks/secret-scan.js no longer declares PATTERNS as an array literal — re-aim this fence rather than deleting it');
    const high = [...block[1].matchAll(/\{\s*re:\s*(\/(?:\\.|\[[^\]]*\]|[^/])+\/[a-z]*),\s*sev:\s*'HIGH',\s*name:\s*'([^']+)'/g)]
      .map((m) => ({ source: m[1], name: m[2] }));
    assert.ok(high.length >= 7, `only ${high.length} HIGH patterns extracted — the fence is not reaching the hook`);
    assert.deepEqual(
      readinessLib.CREDENTIAL_PATTERNS.map((p) => ({ source: String(p.re), name: p.name })),
      high,
      'kernel/lib/readiness.js and hooks/secret-scan.js disagree about which patterns are HIGH-severity credentials. '
      + 'One would then find a key in a tfvars that the other misses in a diff, which is the two-lists failure this fence exists for.');
  });

  test('⛔ the two items with real parsing discriminate against their nearest misses, on greenfield-app', () => {
    /*
     * ⛔ THE TWO ITEMS THAT PARSE RATHER THAN LOOK. Everything else asks whether a path exists; these
     * two read a file and decide what it says, so each one has a NEAREST MISS that a sloppy match would
     * accept. `.env.local` is a perfectly good gitignore line that leaves `.env` tracked, and a
     * CODEOWNERS full of patterns with a placeholder owner routes review to nobody. A check that
     * accepted either would be reporting agreement having looked at the wrong thing.
     */
    const dir = fixture('greenfield-app');
    try {
      const only = (id) => {
        const r = readinessLib.runReadiness(dir, {});
        return r.checks.find((c) => c.check === `readiness:${id}`);
      };
      for (const [body, expected, why] of [
        ['node_modules/\n.env\n', OUTCOME.PASS, 'the plain rule'],
        ['/.env\n', OUTCOME.PASS, 'anchored to the root'],
        ['**/.env\n', OUTCOME.PASS, 'at any depth'],
        ['.env*\n', OUTCOME.PASS, 'the prefix form'],
        ['*.env\n', OUTCOME.PASS, 'the suffix form'],
        ['.env.local\n', OUTCOME.FAIL, 'a NEIGHBOUR of .env, which leaves .env itself tracked'],
        ['!.env\n', OUTCOME.FAIL, 'a NEGATION, which un-ignores the very path this item asks about'],
        ['node_modules/\n', OUTCOME.FAIL, 'a gitignore that says nothing about it'],
      ]) {
        put(dir, '.gitignore', body);
        assert.equal(only('env-ignored').outcome, expected, `env-ignored on ${JSON.stringify(body)} (${why})`);
      }

      for (const [body, expected, why] of [
        ['* @fixture-owner\n', OUTCOME.PASS, 'a real handle'],
        ['*.js dev@example.org\n', OUTCOME.PASS, 'an email owner'],
        ['/src @acme/platform-team\n', OUTCOME.PASS, 'a team handle'],
        ['# owners\n* @your-org\n', OUTCOME.FAIL, 'the placeholder the installer templates teach'],
        ['* @TODO\n', OUTCOME.FAIL, 'a TODO standing in for an owner'],
        ['*.js\n*.md\n', OUTCOME.FAIL, 'patterns with no owner at all'],
        ['# nothing here\n', OUTCOME.FAIL, 'comments only'],
      ]) {
        put(dir, '.github/CODEOWNERS', body);
        assert.equal(only('codeowners-filled').outcome, expected, `codeowners-filled on ${JSON.stringify(body)} (${why})`);
      }
    } finally { rm(dir); }
  });

  test('⛔ every item declares a tier, an applies, a check and a remedy, and every id is unique', () => {
    const seen = new Set();
    for (const item of readinessLib.ITEMS) {
      assert.match(item.id, /^[a-z][a-z0-9-]*$/, `${item.id} is not a stable lower-case id`);
      assert.equal(seen.has(item.id), false, `${item.id} is declared twice — one of the two rows would be unreachable`);
      seen.add(item.id);
      assert.ok(readinessLib.TIERS.includes(item.tier), `${item.id} declares tier ${JSON.stringify(item.tier)}`);
      assert.equal(typeof item.applies, 'function', `${item.id} has no applies()`);
      assert.equal(typeof item.check, 'function', `${item.id} has no check()`);
      assert.ok(item.remedy && item.remedy.length > 30,
        `${item.id}'s remedy is a label, not an instruction — a finding a reader cannot act on is a finding they learn to skip`);
    }
    // The set the ADR amendment, the README and /ship all describe.
    assert.deepEqual([...seen].sort(), [
      'ci-workflow', 'codeowners-filled', 'env-ignored', 'error-tracking', 'health-route', 'index-page',
      'license', 'link-check', 'lockfile', 'migrations-dir', 'no-plaintext-creds', 'readme',
      'remote-state-backend', 'secret-scan-ci', 'test-command', 'vaulted-inventory',
    ], "the item set moved. Update ADR-003's amendment, kernel/README.md, README.md and skills/ship/SKILL.md in the same change");
  });

  test('⛔ every archetype produces at least one row and no item ever throws on any of them', () => {
    // The derivation runs over real trees rather than a mock: an item whose applies() reads a field the
    // context does not carry is a crash in the verb, not a failing row.
    for (const kind of ['docs-only', 'ops-infra', 'greenfield-app', 'mature-product']) {
      const dir = fixture(kind);
      try {
        for (const posture of [null,
          { profile: 'light', rule: readinessLib.POSTURE_ROW, verdict: 'advise' },
          { profile: 'standard', rule: readinessLib.POSTURE_ROW, verdict: 'advise' }]) {
          const r = readinessLib.runReadiness(dir, { posture });
          assert.ok(r.checks.length > 0, `${kind}: no rows at all`);
          for (const c of r.checks) {
            assert.ok(['PASS', 'FAIL', 'CANNOT_DETERMINE', 'NOT_APPLICABLE'].includes(c.outcome), `${kind}: ${c.check} returned ${c.outcome}`);
            assert.equal(c.domain, 'gate', `${kind}: ${c.check} is filed under a domain nothing reads`);
            assert.ok(c.detail && c.detail.length > 20, `${kind}: ${c.check} carries no readable detail`);
          }
        }
      } finally { rm(dir); }
    }
  });
});
