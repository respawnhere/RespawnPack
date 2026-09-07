/*
 * RespawnPack · conformance/conformance.test.mjs — the lifecycle traces, replayed through the real machine.
 *
 * ⛔ THE SUITE'S FIRST JOB IS TO PROVE THE RUNNER CAN FAIL. A conformance harness that reports green for
 * every input has demonstrated that it executes, not that it detects anything — field run B's symbol
 * check returned 0 for the VALID names too, and read as confirmation both times. So before any fixture
 * is trusted, a known-good trace is mutated in one expectation and the mismatch is REQUIRED to appear,
 * a known-bad trace is mutated the same way, and a trace is stripped of one evidence record to prove
 * the machine — not the runner — is what refuses it.
 *
 * ⛔ AND THE FIXTURE SET IS DECLARED, NOT DISCOVERED. `REQUIRED_SCENARIOS` is the denominator, checked in
 * BOTH directions: a required scenario with no file fails, and a file naming no required scenario fails.
 * An inventory built from readdir cannot report an absence, which is the finding this program has made
 * twice already in two other directories.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as matrix from './capability-matrix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const runner = require_(path.join(HERE, 'runner.js'));
const core = require_(path.join(HERE, '..', 'core', 'index.js'));

const FIXTURE_DIR = path.join(HERE, 'fixtures');

// The scenarios the W1 brief requires, by id. Adding a fixture means adding it here on purpose.
const REQUIRED_SCENARIOS = [
  'success-full-rollover',
  'crash-between-verified-and-compacting',
  'duplicate-completion-event',
  'duplicate-session-start-compact',
  'observe-timeout-cannot-determine',
  'handoff-readback-mismatch',
  'noop-compact',
  'identity-mismatch-after-compact',
  'unverified-handoff-injection-refused',
  'timeout-as-completion-control-pair',
];

const CLASSES = new Set(['known-good', 'known-bad', 'control-pair']);

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-conf-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };

const fixtures = runner.loadFixtures(FIXTURE_DIR);

function run(trace) {
  const dir = tmp(trace.id.slice(0, 12));
  try { return runner.replay(trace, { projectDir: dir }); }
  finally { rm(dir); }
}

// Every fixture is replayed ONCE, into its own throwaway project, and every block below reads the same
// observed record. Re-replaying per assertion would make the suite four times slower and — worse —
// allow two blocks to disagree about what a fixture did.
const REPLAYS = fixtures.map(({ file, trace }) => ({ file, trace, result: run(trace) }));

// ---------------------------------------------------------------------------------------------
describe('the fixture set is declared, and every fixture is well formed', () => {
  test('required scenarios and fixture files agree in both directions', () => {
    const ids = fixtures.map((f) => f.trace.id).sort();
    assert.deepEqual(ids, [...REQUIRED_SCENARIOS].sort(),
      `conformance/fixtures/ and REQUIRED_SCENARIOS disagree. on disk only: ${ids.filter((i) => !REQUIRED_SCENARIOS.includes(i))}; `
      + `required only: ${REQUIRED_SCENARIOS.filter((i) => !ids.includes(i))}`);
  });

  test('every fixture declares a class, a reason and at least one step', () => {
    for (const { file, trace } of fixtures) {
      assert.ok(CLASSES.has(trace.class), `${file}: class ${JSON.stringify(trace.class)} is not one of ${[...CLASSES].join(', ')}`);
      assert.ok(trace.why && trace.why.length > 80, `${file}: "why" is a label, not a reason — a fixture that cannot say what it protects will be deleted by the next person who finds it inconvenient`);
      assert.ok(Array.isArray(trace.steps) && trace.steps.length, `${file}: no steps`);
      assert.ok(trace.expect && Object.keys(trace.expect).length, `${file}: no expectations — a trace that asserts nothing passes for any machine`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('⛔ the runner discriminates — the control pair for the harness itself', () => {
  test('a known-good trace passes, and the SAME trace with one expectation flipped fails', () => {
    const good = fixtures.find((f) => f.trace.id === 'success-full-rollover').trace;
    const asIs = run(good);
    assert.equal(asIs.ok, true, `the known-good control did not pass: ${asIs.mismatches.join(' | ')}`);

    const mutated = JSON.parse(JSON.stringify(good));
    mutated.expect.finalState = 'HALTED';
    const flipped = run(mutated);
    assert.equal(flipped.ok, false, 'the runner accepted a trace whose declared final state was wrong — it cannot fail, so its passes mean nothing');
    assert.match(flipped.mismatches.join(' '), /expected finalState/);
  });

  test('a known-bad trace lands where it says, and moving its halt code fails', () => {
    const bad = fixtures.find((f) => f.trace.id === 'identity-mismatch-after-compact').trace;
    assert.equal(run(bad).ok, true);

    const mutated = JSON.parse(JSON.stringify(bad));
    mutated.expect.haltCode = 'COMPLETION_UNOBSERVED';
    const moved = run(mutated);
    assert.equal(moved.ok, false, 'the runner agreed with the wrong halt code');
    assert.match(moved.mismatches.join(' '), /expected haltCode/);
  });

  test('removing one evidence record makes the MACHINE refuse — the refusal is not the runner being strict', () => {
    const good = fixtures.find((f) => f.trace.id === 'success-full-rollover').trace;
    const stripped = JSON.parse(JSON.stringify(good));
    const step = stripped.steps.find((s) => s.transition === 'observe-completion');
    step.evidence = [];
    const r = run(stripped);
    assert.equal(r.ok, false);
    const observed = r.observed.steps.find((s) => s.transition === 'observe-completion');
    assert.equal(observed.status, 'REFUSED');
    assert.equal(observed.failure, 'EVIDENCE_MISSING',
      'a transition with no evidence was allowed through, which makes every evidence gate in the table decorative');
  });
});

// ---------------------------------------------------------------------------------------------
describe('every declared trace replays as declared', () => {
  for (const { file, trace, result } of REPLAYS) {
    test(`${trace.id} (${trace.class}) — ${trace.title}`, () => {
      assert.deepEqual(result.mismatches, [], `${file} did not replay as declared:\n  ${result.mismatches.join('\n  ')}`);
    });
  }
});

// ---------------------------------------------------------------------------------------------
describe('⛔ the class contract — a known-bad trace that passes is not a fixture, it is a hole', () => {
  test('every known-bad trace lands in HALTED with FAIL or CANNOT_DETERMINE', () => {
    const bad = REPLAYS.filter((f) => f.trace.class === 'known-bad');
    assert.ok(bad.length >= 4, `only ${bad.length} known-bad fixture(s) — a conformance set made of happy paths cannot fail`);
    for (const { file, result: r } of bad) {
      assert.equal(r.observed.finalState, 'HALTED', `${file}: a known-bad trace ended in ${r.observed.finalState}`);
      assert.ok(['FAIL', 'CANNOT_DETERMINE'].includes(r.observed.outcome),
        `${file}: a known-bad trace reported ${r.observed.outcome}`);
      assert.ok(r.observed.recovery && r.observed.recovery.length > 40,
        `${file}: the halt carries no actionable recovery instruction — a failure code with no instruction is a label`);
      assert.equal(r.observed.cycleAdvances, 0, `${file}: a failed rollover advanced the context cycle`);
    }
    // Both halt outcomes are represented: a set that only ever produces FAIL never exercises the
    // CANNOT_DETERMINE branch, which is the one an adapter is most likely to read as a FAIL.
    const outcomes = new Set(bad.map((f) => f.result.observed.outcome));
    assert.deepEqual([...outcomes].sort(), ['CANNOT_DETERMINE', 'FAIL']);
  });

  test('every known-good trace ends outside HALTED and reports PASS', () => {
    const good = REPLAYS.filter((f) => f.trace.class === 'known-good');
    assert.ok(good.length >= 4, `only ${good.length} known-good fixture(s) — with no happy path, a machine that refuses everything would pass`);
    for (const { file, result: r } of good) {
      assert.notEqual(r.observed.finalState, 'HALTED', `${file}: a known-good trace halted`);
      assert.equal(r.observed.outcome, 'PASS', `${file}: a known-good trace reported ${r.observed.outcome}`);
    }
  });

  test('every control-pair trace both REFUSES and APPLIES the same transition', () => {
    const pairs = REPLAYS.filter((f) => f.trace.class === 'control-pair');
    assert.ok(pairs.length, 'no control-pair fixture exists, so nothing proves a refusal is attributable to the evidence rather than to the machine being closed');
    for (const { file, result: r } of pairs) {
      const byTransition = {};
      for (const s of r.observed.steps.filter((x) => x.do === 'apply')) {
        byTransition[s.transition] = byTransition[s.transition] || new Set();
        byTransition[s.transition].add(s.status);
      }
      const discriminating = Object.entries(byTransition).filter(([, set]) => set.has('REFUSED') && set.has('APPLIED'));
      assert.ok(discriminating.length,
        `${file}: no transition was both refused and applied, so the trace does not discriminate — it only shows that something was rejected`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the invariants the traces exist to protect, asserted by name', () => {
  /*
   * ⛔ EVERY SWEEP BELOW COUNTS WHAT IT EXAMINED AND REFUSES A ZERO. A loop over rows that match nothing
   * agrees with everything: "no trace reached COMPACTING wrongly" is trivially true of a fixture set in
   * which nothing reaches COMPACTING at all, and that is exactly how a passing sweep stops meaning
   * anything the day a fixture is renamed.
   */
  const rowsOf = (r) => r.observed.rows || [];

  test('no trace reaches COMPACTING without a verified handoff recorded first', () => {
    let examined = 0;
    for (const { file, result: r } of REPLAYS) {
      for (const row of rowsOf(r).filter((x) => x.kind === 'transition' && x.to === 'COMPACTING')) {
        examined += 1;
        assert.equal(row.from, 'HANDOFF_VERIFIED', `${file}: entered COMPACTING from ${row.from}`);
        assert.ok(row.verifiedHandoff && row.verifiedHandoff.equal === true,
          `${file}: entered COMPACTING with no read-back verification on the record`);
      }
    }
    assert.ok(examined >= 6, `only ${examined} entries into COMPACTING were examined — the sweep is not reaching the fixtures`);
  });

  test('no trace reaches REHYDRATING without a declared completion signal', () => {
    const declared = new Set(Object.keys(core.evidence.COMPLETION_SIGNALS));
    let examined = 0;
    for (const { file, result: r } of REPLAYS) {
      for (const row of rowsOf(r).filter((x) => x.kind === 'transition' && x.to === 'REHYDRATING')) {
        examined += 1;
        const completion = (row.evidence || []).find((e) => e.kind === 'compact-completed');
        assert.ok(completion, `${file}: entered REHYDRATING with no completion record`);
        assert.ok(declared.has(completion.signal), `${file}: entered REHYDRATING on the undeclared signal ${completion.signal}`);
      }
    }
    assert.ok(examined >= 5, `only ${examined} entries into REHYDRATING were examined`);
  });

  test('no trace returns to ACTIVE without an identity record whose ids are present and equal', () => {
    let examined = 0;
    for (const { file, result: r } of REPLAYS) {
      for (const row of rowsOf(r).filter((x) => x.kind === 'transition' && x.to === 'ACTIVE')) {
        examined += 1;
        const id = (row.evidence || []).find((e) => e.kind === 'identity-verification');
        assert.ok(id, `${file}: returned to ACTIVE from ${row.from} with no identity-verification record`);
        assert.equal(id.equal, true, `${file}: returned to ACTIVE on an identity record claiming equal=${id.equal}`);
        assert.equal(id.expectedId, id.observedId, `${file}: returned to ACTIVE with ${id.expectedId} != ${id.observedId}`);
      }
    }
    assert.ok(examined >= 6, `only ${examined} returns to ACTIVE were examined — including the no-op return, which is the one most likely to skip the check`);
  });

  test('every evidence record on every applied transition kept its verbatim host payload', () => {
    let examined = 0;
    for (const { file, result: r } of REPLAYS) {
      for (const row of rowsOf(r).filter((x) => x.kind === 'transition')) {
        for (const e of row.evidence || []) {
          if (!core.evidence.HOST_OBSERVED.has(e.kind)) continue;
          examined += 1;
          assert.ok(e.raw !== undefined && e.raw !== null && e.raw !== '',
            `${file}: a ${e.kind} record reached the journal with no raw host payload — the typed wrapper is all that would survive a host renaming a field`);
        }
      }
    }
    assert.ok(examined >= 30, `only ${examined} host-observed records were examined`);
  });

  test('a handoff is never consumed twice, and the loser is told who won', () => {
    let examinedFirst = 0, examinedSecond = 0;
    for (const { trace, result: r } of REPLAYS) {
      const consumed = (r.observed.consumptions || []).filter((c) => c.status === 'CONSUMED');
      examinedFirst += consumed.length;
      assert.ok(consumed.length <= 1, `${trace.id}: ${consumed.length} successful consumptions of one handoff`);
      for (const c of (r.observed.consumptions || []).filter((x) => x.status === 'ALREADY_CONSUMED')) {
        examinedSecond += 1;
        assert.equal(c.pointsToFirst, true, `${trace.id}: a second consumer was told "already consumed" with no pointer to the first consumption`);
      }
    }
    assert.ok(examinedFirst >= 3, `only ${examinedFirst} first consumptions were examined`);
    assert.ok(examinedSecond >= 1, 'no fixture ever attempted a SECOND consumption, so the exactly-once claim is untested here');
  });
});

// ---------------------------------------------------------------------------------------------
describe('⛔ the capability matrix is rendered from source, and the byte-equality fence can fail', () => {
  /*
   * capability-matrix.mjs calls the four live profile-declaration modules and renders
   * CAPABILITY-MATRIX.md from what they return today — never a hand-maintained table. The fence
   * below is the same discipline kernel/lib/render.js uses for CONTINUITY.md/GAPS.md: re-render from
   * source on every run and require the checked-in bytes to match exactly. And per the banner at the
   * top of this file, a comparator that can only ever agree has proven nothing — so the second test
   * tampers one real, load-bearing cell and requires the mismatch to appear.
   */
  const matrixPath = path.join(HERE, 'CAPABILITY-MATRIX.md');

  test('conformance/CAPABILITY-MATRIX.md is byte-identical to a fresh render of the four live profile modules', () => {
    const rendered = matrix.render();
    const onDisk = fs.readFileSync(matrixPath, 'utf8');
    assert.equal(rendered, onDisk,
      'conformance/CAPABILITY-MATRIX.md does not match a fresh render of capability-matrix.mjs — regenerate it '
      + '(node conformance/capability-matrix.mjs) and check in the result: either a declaration in one of the '
      + 'four profile modules changed underneath a stale checked-in file, or the checked-in file was hand-edited');
  });

  test('a tampered line in the checked-in matrix is caught — the byte-equality fence is not vacuous', () => {
    const onDisk = fs.readFileSync(matrixPath, 'utf8');
    const lines = onDisk.split('\n');

    // codex/app-server is the one profile with a real, checked-in PASSING canary, so its requestCompact
    // cell renders as a clean `SUPPORTED` with no "(declared ...)" annotation — the single unambiguous
    // spot in the whole table to flip one word and prove the fence would notice.
    const idx = lines.findIndex((l) => l.startsWith('| `requestCompact`'));
    assert.notEqual(idx, -1, 'the checked-in matrix no longer has a requestCompact row — if the render format changed, update this control with it');
    const original = lines[idx];
    const needle = '| `SUPPORTED` |';
    assert.equal(original.split(needle).length - 1, 1,
      'the requestCompact row no longer has exactly one bare `SUPPORTED` cell to tamper — update this control to match the current render');
    const tamperedLine = original.replace(needle, '| `NOT_SUPPORTED` |');
    assert.notEqual(tamperedLine, original, 'the tamper produced no change — the needle and its replacement no longer line up');
    const tampered = [...lines.slice(0, idx), tamperedLine, ...lines.slice(idx + 1)].join('\n');
    assert.notEqual(tampered, onDisk, 'the tamper produced a document identical to the checked-in one');

    const rendered = matrix.render();
    assert.equal(rendered, onDisk,
      'sanity check failed before the control could mean anything: the UNTAMPERED checked-in file must already '
      + 'match a fresh render, or a mismatch below would not be attributable to the tamper');
    assert.notEqual(tampered, rendered,
      'a hand-edited CAPABILITY-MATRIX.md with one support level flipped (codex/app-server requestCompact: '
      + 'SUPPORTED -> NOT_SUPPORTED) compared EQUAL to a fresh render — the byte-equality fence cannot fail, '
      + 'so its passes mean nothing');
  });
});
