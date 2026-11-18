/*
 * RespawnPack · adapters/claude-code/sdk-supervisor/stream.test.mjs — the protocol reader, the
 * measurement, and the fixture manifest that keeps CAPTURED and SYNTHETIC apart.
 *
 * ⛔ THE CENTRAL CONTROL PAIR OF THIS FILE. A compaction verdict function that returned COMPLETED for
 * everything would pass a suite built only from the success fixture. So the same function is run
 * against the REAL captured bytes of a compaction that FAILED — whose result envelope says
 * `is_error:false, subtype:"success"` — and the two answers are asserted to DIFFER. Then both envelopes
 * are mutated and the verdicts are asserted NOT to move, which is the only way to show that the
 * envelope is not what the verdict is reading.
 *
 * Nothing here touches the repository's own .respawnpack/; the temp-dir fixtures write under os.tmpdir().
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

const stream = require_(path.join(HERE, 'stream.js'));
const measureLib = require_(path.join(HERE, 'measure.js'));
const cliLib = require_(path.join(HERE, 'cli.js'));
const core = require_(path.join(HERE, '..', '..', '..', 'core', 'index.js'));

const FIXTURES = path.join(HERE, 'fixtures');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'MANIFEST.json'), 'utf8'));

const readLines = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8').split('\n').filter((l) => l.length);
const observeFixture = (rel) => stream.observe(readLines(rel));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-sdksup-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };

// =================================================================================================
describe('fixture manifest — captured and synthetic are different claims', () => {
  const onDisk = [];
  for (const dir of ['captured', 'synthetic']) {
    for (const f of fs.readdirSync(path.join(FIXTURES, dir)).sort()) onDisk.push(`${dir}/${f}`);
  }

  test('every fixture on disk is declared, and every declaration exists', () => {
    const declared = MANIFEST.fixtures.map((f) => f.file).sort();
    assert.deepEqual(onDisk.slice().sort(), declared,
      'a fixture that is not in the manifest has no recorded origin — and an origin is the difference between evidence and an illustration');
  });

  test('the recorded digest is the digest on disk — a captured fixture cannot be edited into agreement with the code that reads it', () => {
    for (const f of MANIFEST.fixtures) {
      const buf = fs.readFileSync(path.join(FIXTURES, f.file));
      assert.equal(sha256(buf), f.sha256, `${f.file}: bytes changed since it was recorded — re-record it deliberately, and say why`);
      assert.equal(buf.length, f.bytes, `${f.file}: byte count drifted from the manifest`);
    }
  });

  test('every synthetic fixture carries the marker IN BAND, and no captured one does', () => {
    for (const f of MANIFEST.fixtures) {
      const first = readLines(f.file)[0];
      const marked = first.includes('__respawnpack_synthetic__');
      if (f.origin === 'synthetic') {
        assert.equal(marked, true, `${f.file}: a synthetic fixture must say so in its own first line, not only in a manifest a reader may not open`);
        assert.equal(f.provesReaderNotHost, true, `${f.file}: a synthetic fixture proves the reader, and the manifest has to say that`);
        assert.ok(f.whyNotCaptured, `${f.file}: a synthetic fixture must say why it could not be captured`);
      } else {
        assert.equal(marked, false, `${f.file}: a captured fixture carries the synthetic marker — one of the two labels is wrong`);
        assert.ok(f.capturedFrom, `${f.file}: a captured fixture must name where it was captured from`);
      }
    }
  });

  test('the manifest declares at least one of each kind — a manifest with no captured fixtures would be a manifest of illustrations', () => {
    const kinds = new Set(MANIFEST.fixtures.map((f) => f.origin));
    assert.ok(kinds.has('captured-live'), 'no captured fixture is declared');
    assert.ok(kinds.has('synthetic'), 'no synthetic fixture is declared');
  });
});

// =================================================================================================
describe('parseLine — what cannot be read is reported, never dropped', () => {
  test('a protocol line parses and classifies', () => {
    const p = stream.parseLine('{"type":"system","subtype":"init","session_id":"s1"}');
    assert.equal(p.ok, true);
    assert.equal(p.kind, stream.MSG.INIT);
  });

  test('a non-JSON line is refused WITH its bytes and a reason', () => {
    const p = stream.parseLine('Warning: something on stdout that is not protocol');
    assert.equal(p.ok, false);
    assert.match(p.reason, /not JSON/);
    assert.equal(p.raw, 'Warning: something on stdout that is not protocol');
  });

  test('a JSON array is not a protocol message', () => {
    const p = stream.parseLine('[1,2,3]');
    assert.equal(p.ok, false);
    assert.match(p.reason, /array/);
  });

  test('an object with no declared type is UNRECOGNISED — counted, not interpreted', () => {
    assert.equal(stream.classify({ hello: 'world' }), stream.MSG.UNRECOGNISED);
    assert.equal(stream.classify({ type: 'system', subtype: 'some_future_thing' }), stream.MSG.OTHER_SYSTEM);
  });
});

// =================================================================================================
describe('captured/01-baseline — the init message is readable before credentials are', () => {
  const obs = observeFixture('captured/01-baseline.jsonl');

  test('structural facts survive an unauthenticated run', () => {
    assert.ok(obs.init, 'no init message');
    assert.equal(obs.init.session_id, '3b11b63e-fa6b-45de-89f9-04df1056e042');
    assert.equal(obs.init.claude_code_version, '2.1.223');
    const cmds = stream.supportsCompactCommand(obs);
    assert.equal(cmds.ok, true);
    assert.equal(cmds.present, true, 'the slash-command set does not contain "compact"');
  });

  test('the auth failure is read from what the host SAID, not from apiKeySource', () => {
    assert.equal(obs.init.apiKeySource, 'none', 'the fixture no longer carries the field this check is about');
    assert.equal(obs.auth.failed, true);
    assert.equal(obs.auth.from, 'assistant.error');
    assert.match(obs.auth.verbatim, /OAuth session expired/);
  });

  test('apiKeySource alone is NOT an auth verdict (control: the same value with no failure reads as fine)', () => {
    const healthy = stream.observe([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'none', slash_commands: ['compact'] }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' }),
    ]);
    assert.equal(healthy.auth.failed, false, 'apiKeySource:"none" was read as an authentication failure — it is not one');
  });

  test('the probe harness\'s own __probe_error__ line is counted as foreign, not interpreted', () => {
    assert.equal(obs.unrecognised.length, 1, 'the foreign line was silently absorbed');
    assert.ok(obs.unrecognised[0].raw.includes('__probe_error__'));
  });

  test('an all-zero usage block is the ABSENCE of a measurement, not a measurement of zero', () => {
    const u = stream.latestUsage(obs);
    assert.equal(u.ok, false);
    assert.equal(u.usedTokens, null);
    assert.match(u.why, /all-zero/);
  });
});

// =================================================================================================
describe('captured/07-pathcli — slash_commands and capabilities are OPEN, version-dependent sets', () => {
  const a = observeFixture('captured/01-baseline.jsonl');   // bundled 2.1.223
  const b = observeFixture('captured/07-pathcli-test.jsonl'); // PATH 2.1.205

  test('the executable override is observable in the stream', () => {
    assert.equal(a.init.claude_code_version, '2.1.223');
    assert.equal(b.init.claude_code_version, '2.1.205');
  });

  test('two builds of the same host disagree about their own command and capability sets', () => {
    assert.notDeepEqual(a.init.slash_commands, b.init.slash_commands,
      'the two builds now enumerate identical slash commands — if that is real, the "open set" caution can be relaxed deliberately');
    assert.notDeepEqual(a.init.capabilities, b.init.capabilities);
    // …and "compact" is in BOTH, which is why the capability is claimed at all.
    assert.equal(stream.supportsCompactCommand(a).present, true);
    assert.equal(stream.supportsCompactCommand(b).present, true);
  });

  test('a second spelling of the auth failure is recognised', () => {
    assert.equal(b.auth.failed, true);
    assert.match(b.auth.verbatim, /Not logged in/);
  });

  test('a build without "compact" is reported as such (control — the check can say no)', () => {
    const noCompact = stream.observe([JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['clear', 'model'] })]);
    const r = stream.supportsCompactCommand(noCompact);
    assert.equal(r.present, false);
    assert.match(r.why, /is not among them/);
  });
});

// =================================================================================================
describe('THE EVIDENCE CONTRACT — a failed compaction returns a success result', () => {
  const failed = observeFixture('captured/04-compact-attempt1.jsonl');
  const succeeded = observeFixture('synthetic/compact-success.jsonl');

  test('the captured failure really does carry is_error:false and subtype:"success" (anchored in the bytes)', () => {
    assert.ok(failed.result, 'no result message in the captured failure');
    assert.equal(failed.result.msg.is_error, false, 'the fixture no longer shows the trap this module exists for');
    assert.equal(failed.result.msg.subtype, 'success');
    assert.equal(failed.result.msg.num_turns, 0);
    assert.equal(failed.boundaries.length, 0, 'a compaction that did not happen emitted no boundary');
  });

  test('the verdict on the captured failure is FAILED, with the host\'s own error carried verbatim', () => {
    const v = stream.compactVerdict(failed, { waitedMs: 1200 });
    assert.equal(v.verdict, stream.VERDICT.FAILED);
    assert.match(v.compactError, /Failed to authenticate/);
    assert.equal(v.sawCompactingStatus, true, 'the "compacting" status is part of what makes this a failed ATTEMPT rather than nothing at all');
    assert.deepEqual(v.resultEnvelope, { subtype: 'success', is_error: false, num_turns: 0 },
      'the disagreeing envelope is recorded on the verdict so a reader can see it was not consulted');
  });

  test('the verdict on a boundary stream is COMPLETED — and the two answers DIFFER (the control pair)', () => {
    const good = stream.compactVerdict(succeeded, { waitedMs: 9200 });
    const bad = stream.compactVerdict(failed, { waitedMs: 1200 });
    assert.equal(good.verdict, stream.VERDICT.COMPLETED);
    assert.equal(good.signal, 'compact_boundary');
    assert.notEqual(good.verdict, bad.verdict,
      'the verdict function answers identically for a real failure and a real success — it discriminates nothing');
  });

  test('compact_metadata is carried typed BESIDE the verbatim line, never instead of it', () => {
    const v = stream.compactVerdict(succeeded, {});
    assert.equal(v.metadata.trigger, 'manual');
    assert.equal(v.metadata.preTokens, 174312);
    assert.equal(v.metadata.postTokens, 21884);
    assert.equal(v.metadata.durationMs, 9142);
    assert.ok(v.metadata.preservedMessages, 'preserved_messages was dropped');
    assert.ok(String(v.raw).includes('"subtype":"compact_boundary"'), 'the raw boundary line is not carried');
  });

  test('a missing post_tokens stays NULL — an absent field is not a context that compacted to nothing', () => {
    const partial = stream.observe([JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 1000 }, session_id: 's', uuid: 'u' })]);
    const v = stream.compactVerdict(partial, {});
    assert.equal(v.verdict, stream.VERDICT.COMPLETED);
    assert.equal(v.metadata.postTokens, null);
  });

  test('MUTATING THE RESULT ENVELOPE MOVES NOTHING — in both directions', () => {
    // Make the failure's envelope look like an error…
    const failLines = readLines('captured/04-compact-attempt1.jsonl').map((l) => {
      const m = JSON.parse(l);
      if (m.type === 'result') { m.is_error = true; m.subtype = 'error_during_execution'; }
      return JSON.stringify(m);
    });
    assert.equal(stream.compactVerdict(stream.observe(failLines), {}).verdict, stream.VERDICT.FAILED,
      'the verdict moved when only the result envelope changed — the envelope is load-bearing, and it must not be');

    // …and the success's envelope look like a failure.
    const okLines = readLines('synthetic/compact-success.jsonl').map((l) => {
      const m = JSON.parse(l);
      if (m.type === 'result') { m.is_error = true; m.subtype = 'error_during_execution'; m.result = 'something went wrong'; }
      return JSON.stringify(m);
    });
    assert.equal(stream.compactVerdict(stream.observe(okLines), {}).verdict, stream.VERDICT.COMPLETED,
      'a real compact_boundary stopped counting because the envelope was rewritten');
  });

  test('NOOP is the host\'s own words, and the failure text does not match them (control)', () => {
    const noop = stream.compactVerdict(observeFixture('synthetic/compact-noop.jsonl'), {});
    assert.equal(noop.verdict, stream.VERDICT.NOOP);
    assert.equal(noop.hostResult, 'Not enough messages to compact.');
    const failedVerdict = stream.compactVerdict(failed, {});
    assert.notEqual(failedVerdict.verdict, stream.VERDICT.NOOP,
      'the no-op phrase matched an error message — a loose pattern turns a failure into a benign non-event');
  });

  test('a boundary AND a failure is CONTRADICTORY — not resolved in the adapter\'s favour', () => {
    const v = stream.compactVerdict(observeFixture('synthetic/compact-contradictory.jsonl'), {});
    assert.equal(v.verdict, stream.VERDICT.CONTRADICTORY);
    assert.match(v.detail, /disagree/);
    assert.notEqual(v.verdict, stream.VERDICT.COMPLETED);
  });

  test('no signal at all is UNOBSERVED, and the clock travels with it as a fact about the clock', () => {
    const v = stream.compactVerdict(observeFixture('synthetic/compact-unobserved.jsonl'), { waitedMs: 60000 });
    assert.equal(v.verdict, stream.VERDICT.UNOBSERVED);
    assert.equal(v.reason, 'no-signal');
    assert.equal(v.waitedMs, 60000);
    assert.equal(v.boundaryCount, 0);

    const dead = stream.compactVerdict(stream.observe([]), { waitedMs: 100 });
    assert.equal(dead.verdict, stream.VERDICT.UNOBSERVED);
    assert.equal(dead.reason, 'stream-closed');
  });

  test('a redelivered boundary is visible as a redelivery (same uuid, twice)', () => {
    const dup = observeFixture('synthetic/compact-duplicate-boundary.jsonl');
    assert.equal(dup.boundaries.length, 2);
    assert.equal(dup.boundaries[0].msg.uuid, dup.boundaries[1].msg.uuid,
      'the duplicate fixture no longer repeats one uuid, so it no longer models a redelivery');
    assert.equal(stream.compactVerdict(dup, {}).verdict, stream.VERDICT.COMPLETED);
  });

  test('the identity-changed stream still COMPLETES — the identity check is a separate question, and that is the point', () => {
    const changed = observeFixture('synthetic/compact-identity-changed.jsonl');
    const v = stream.compactVerdict(changed, {});
    assert.equal(v.verdict, stream.VERDICT.COMPLETED);
    assert.equal(v.sessionId, 'synth-0000-0000-0000-000000000099');
    assert.notEqual(v.sessionId, 'synth-0000-0000-0000-000000000001');
  });
});

// =================================================================================================
describe('the core taxonomy refuses a clock offered as completion', () => {
  for (const forbidden of ['timeout', 'process_exit', 'elapsed_10s', 'assumed_complete']) {
    test(`signal ${JSON.stringify(forbidden)} is a PROOF_SUBSTITUTION_ATTEMPT`, () => {
      const rec = core.evidence.make(core.evidence.KINDS.COMPACT_COMPLETED, { signal: forbidden, raw: { type: 'nothing' } });
      const v = core.evidence.validate(rec);
      assert.equal(v.ok, false);
      assert.equal(v.failure.code, 'PROOF_SUBSTITUTION_ATTEMPT');
    });
  }
  test('…and compact_boundary is accepted (control — a check that refuses everything discriminates nothing)', () => {
    const rec = core.evidence.make(core.evidence.KINDS.COMPACT_COMPLETED, { signal: 'compact_boundary', raw: { type: 'system', subtype: 'compact_boundary' } });
    assert.equal(core.evidence.validate(rec).ok, true);
  });
});

// =================================================================================================
describe('measurement — the numerator is published, the denominator often is not', () => {
  test('a host-reported window gives an exact occupancy', () => {
    const m = measureLib.measure({ observation: observeFixture('synthetic/turn-heavy.jsonl'), env: {} });
    assert.equal(m.measurable, true);
    assert.equal(m.usedTokens, 174312);
    assert.equal(m.budget.tokens, 200000);
    assert.equal(m.budget.source, measureLib.BUDGET_SOURCE.HOST_REPORTED);
    assert.equal(m.budget.hostReported, true);
    assert.equal(Number(m.usedPercent.toFixed(3)), 87.156);
  });

  test('no reported window falls back to the ASSUMED default, and says so in the record', () => {
    const m = measureLib.measure({ observation: observeFixture('synthetic/turn-light.jsonl'), env: {} });
    assert.equal(m.usedTokens, 12000);
    assert.equal(m.budget.tokens, measureLib.DEFAULT_BUDGET_TOKENS);
    assert.equal(m.budget.source, measureLib.BUDGET_SOURCE.ASSUMED_DEFAULT);
    assert.equal(m.usedPercent, 1.2); // 12000 of the ASSUMED 1M default
    assert.equal(m.record.budgetSource, 'assumed-default');
    assert.equal(m.record.windowHostReported, false);
    assert.match(m.budget.why, /ASSUMED/);
  });

  test('an operator-configured budget beats the default and loses to the host', () => {
    const light = observeFixture('synthetic/turn-light.jsonl');
    const configured = measureLib.measure({ observation: light, env: { [measureLib.BUDGET_ENV]: '1000000' } });
    assert.equal(configured.budget.tokens, 1000000);
    assert.equal(configured.budget.source, measureLib.BUDGET_SOURCE.OPERATOR_CONFIGURED);
    assert.equal(configured.usedPercent, 1.2);

    const heavy = observeFixture('synthetic/turn-heavy.jsonl');
    const hostWins = measureLib.measure({ observation: heavy, env: { [measureLib.BUDGET_ENV]: '1000000' } });
    assert.equal(hostWins.budget.tokens, 200000, 'the operator override outranked the host\'s own published window');
    assert.equal(hostWins.budget.source, measureLib.BUDGET_SOURCE.HOST_REPORTED);
  });

  test('an unmeasurable turn is CANNOT_DETERMINE — not 0%, and it produces no evidence record', () => {
    const m = measureLib.measure({ observation: observeFixture('captured/01-baseline.jsonl'), env: {} });
    assert.equal(m.measurable, false);
    assert.equal(m.usedPercent, null);
    assert.equal(m.record, null);
    const ev = measureLib.evaluate({ measurement: m, latchRecord: core.thresholds.emptyLatches('c0') });
    assert.equal(ev.evaluation.measurable, false);
    assert.equal(ev.evaluation.outcome, 'CANNOT_DETERMINE');
    assert.deepEqual(ev.evaluation.fire, [], 'an unmeasured context fired a threshold');
  });

  test('the measurement record is a valid core evidence record, with the raw payload kept', () => {
    const m = measureLib.measure({ observation: observeFixture('synthetic/turn-heavy.jsonl'), env: {} });
    const v = core.evidence.validate(m.record);
    assert.equal(v.ok, true, v.failure && v.failure.detail);
    assert.equal(m.record.source, 'documented-api');
    assert.ok(m.record.raw && m.record.raw.usage, 'the verbatim usage block is not on the record');
    assert.equal(m.record.raw.usage.input_tokens, 140000);
  });

  test('thresholds fire on the heavy turn and not on the light one', () => {
    const heavy = measureLib.measure({ observation: observeFixture('synthetic/turn-heavy.jsonl'), env: {} });
    const light = measureLib.measure({ observation: observeFixture('synthetic/turn-light.jsonl'), env: {} });
    const fresh = () => core.thresholds.emptyLatches('cycle-1');

    const h = measureLib.evaluate({ measurement: heavy, latchRecord: fresh() });
    assert.deepEqual(h.evaluation.fire, ['advisory', 'checkpoint', 'final']);
    assert.equal(h.windowAssumed, false);
    assert.equal(h.finalOnAssumedWindow, false);
    assert.equal(h.requiresOperatorConfirmation, false, 'a HOST-REPORTED window at 87% needs no hedge');

    const l = measureLib.evaluate({ measurement: light, latchRecord: fresh() });
    assert.deepEqual(l.evaluation.fire, []);
  });

  test('an ASSUMED window that fires `final` is FLAGGED — the assumption does not borrow the numerator\'s confidence', () => {
    /*
     * The heavy turn's OCCUPANCY, re-expressed against the assumed default rather than its token count.
     * Removing `modelUsage` is what drops the denominator to the assumed default; the ×5 on the usage is
     * what keeps the RATIO at the heavy turn's 87.156%, which is the only property this test needs — it
     * is about what happens when `final` fires on a window we supplied, not about any particular number
     * of tokens. Before the default moved 200000 → 1000000 the unscaled count happened to give that
     * ratio; leaving it unscaled would have quietly turned an 87% measurement into a 17% one, firing
     * nothing and testing nothing.
     */
    const SCALE = measureLib.DEFAULT_BUDGET_TOKENS / 200000;
    const lines = readLines('synthetic/turn-heavy.jsonl').map((l) => {
      const m = JSON.parse(l);
      if (m.type === 'result') m.modelUsage = {};
      // Both carriers: the assistant turn's nested `message.usage` (what observe() reads for the
      // numerator) and the result line's top-level `usage`. Scaling only one leaves the other stale.
      for (const u of [m.usage, m.message && m.message.usage]) {
        if (!u) continue;
        for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
          if (typeof u[k] === 'number') u[k] *= SCALE;
        }
      }
      return JSON.stringify(m);
    });
    const m = measureLib.measure({ observation: stream.observe(lines), env: {} });
    assert.equal(m.budget.source, measureLib.BUDGET_SOURCE.ASSUMED_DEFAULT);

    /*
     * ⭐ THE FLAG IS NOW A CONTROL, NOT THE MECHANISM. core has a declared tier for this exact ratio —
     * a documented count over a window we supplied — so the measurement DECLARES it and core's own
     * "confirm anything that is not HIGH at the final threshold" rule does the work. `windowAssumed` /
     * `finalOnAssumedWindow` are still computed here, independently, from the budget rather than the
     * confidence; asserting that the two agree is what would catch either one drifting.
     */
    assert.equal(m.record.source, 'documented-count-configured-window', 'an assumed denominator was declared as a documented API reading');
    assert.equal(core.evidence.confidenceOf(m.record.source), 'MEDIUM');

    const ev = measureLib.evaluate({ measurement: m, latchRecord: core.thresholds.emptyLatches('cycle-1') });
    assert.ok(ev.evaluation.fire.includes('final'));
    assert.equal(ev.evaluation.confidence, 'MEDIUM');
    assert.equal(ev.evaluation.requiresOperatorConfirmation, true,
      'core did not require confirmation on its own, so the adapter flag below is the only thing standing between an assumed number and a stopped session');
    assert.equal(ev.windowAssumed, true);
    assert.equal(ev.finalOnAssumedWindow, true);
    assert.equal(ev.requiresOperatorConfirmation, true,
      'the final threshold fired on an assumed denominator and nothing said so');
    // The two answers must agree: core's rule and the adapter's independent flag.
    assert.equal(ev.evaluation.requiresOperatorConfirmation, ev.finalOnAssumedWindow);
  });

  test('an OPERATOR-CONFIGURED window is the same claim as an assumed one: the window is ours either way', () => {
    const light = observeFixture('synthetic/turn-light.jsonl');
    const configured = measureLib.measure({ observation: light, env: { [measureLib.BUDGET_ENV]: '200000' } });
    assert.equal(configured.budget.source, measureLib.BUDGET_SOURCE.OPERATOR_CONFIGURED);
    assert.equal(configured.record.source, 'documented-count-configured-window');
    // …and the known-good half: a window the HOST published keeps the numerator's own standing.
    const hostReported = measureLib.measure({ observation: observeFixture('synthetic/turn-heavy.jsonl'), env: {} });
    assert.equal(hostReported.budget.source, measureLib.BUDGET_SOURCE.HOST_REPORTED);
    assert.equal(hostReported.record.source, 'documented-api');
    assert.equal(core.evidence.confidenceOf(hostReported.record.source), 'HIGH');
  });

  test('latching one threshold stops it re-firing, and the cycle id is what re-arms it', () => {
    const heavy = measureLib.measure({ observation: observeFixture('synthetic/turn-heavy.jsonl'), env: {} });
    let record = core.thresholds.emptyLatches('cycle-1');
    record = core.thresholds.latch(record, 'advisory', { atPercent: 60 });
    const ev = measureLib.evaluate({ measurement: heavy, latchRecord: record });
    assert.deepEqual(ev.evaluation.fire, ['checkpoint', 'final']);

    const next = core.thresholds.forCycle(record, 'cycle-2');
    assert.equal(next.rearmed, true);
    const rearmed = measureLib.evaluate({ measurement: heavy, latchRecord: next.record });
    assert.deepEqual(rearmed.evaluation.fire, ['advisory', 'checkpoint', 'final']);
  });
});

// =================================================================================================
describe('the process surface — the exact invocation, asserted rather than described', () => {
  test('a turn is --print --output-format stream-json --verbose, and --verbose is not optional', () => {
    const args = cliLib.buildTurnArgs({});
    assert.deepEqual(args, ['--print', '--output-format', 'stream-json', '--verbose']);
  });

  test('a resumed turn carries --resume <sessionId>', () => {
    const args = cliLib.buildTurnArgs({ sessionId: 'sess-1', model: 'haiku', tools: '', permissionMode: 'plan' });
    assert.deepEqual(args, ['--print', '--output-format', 'stream-json', '--verbose', '--resume', 'sess-1', '--model', 'haiku', '--tools', '', '--permission-mode', 'plan']);
  });

  test('the prompt is NOT in argv by default — a handoff would hit the Windows command-line limit', () => {
    const big = 'x'.repeat(40000);
    assert.equal(cliLib.buildTurnArgs({ prompt: big }).includes(big), false);
    assert.equal(cliLib.buildTurnArgs({ prompt: 'hi', promptVia: 'argv' }).includes('hi'), true);
  });

  test('an explicit executable that does not exist is refused by name', () => {
    const r = cliLib.resolveExecutable({ claudePath: path.join(os.tmpdir(), 'definitely-not-here-claude.exe'), env: {} });
    assert.equal(r.ok, false);
    assert.match(r.why, /does not exist/);
  });

  test('the PATH scan finds a claude on PATH, and reports what it searched when it does not', () => {
    const dir = tmp('path');
    try {
      const isWin = process.platform === 'win32';
      const exe = path.join(dir, isWin ? 'claude.exe' : 'claude');
      fs.writeFileSync(exe, '#!/bin/sh\necho 0.0.0\n');
      const found = cliLib.resolveExecutable({ env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
      assert.equal(found.ok, true, found.why);
      // The extension is spelled as PATHEXT spells it (".EXE"), which is the same file on a
      // case-insensitive filesystem and is what a Windows PATH scan legitimately produces.
      assert.equal(found.path.toLowerCase(), exe.toLowerCase());
      assert.equal(found.source, 'PATH');
      assert.equal(found.needsShell, false);

      const missing = cliLib.resolveExecutable({ env: { PATH: path.join(dir, 'nope'), PATHEXT: '.EXE' } });
      assert.equal(missing.ok, false);
      assert.ok(missing.searched.length, 'a failed scan reported nothing about where it looked');
    } finally { rm(dir); }
  });

  test('RESPAWNPACK_CLAUDE_PATH is the documented override, and it wins over PATH', () => {
    const dir = tmp('env');
    try {
      const onPath = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
      const override = path.join(dir, 'other-claude.exe');
      fs.writeFileSync(onPath, 'x');
      fs.writeFileSync(override, 'x');
      const r = cliLib.resolveExecutable({ env: { PATH: dir, PATHEXT: '.EXE', RESPAWNPACK_CLAUDE_PATH: override } });
      assert.equal(r.path, override);
      assert.equal(r.source, 'RESPAWNPACK_CLAUDE_PATH');
    } finally { rm(dir); }
  });

  test('a .cmd shim is flagged as needing a shell rather than being spawned directly', () => {
    const dir = tmp('cmd');
    try {
      const shim = path.join(dir, 'claude.cmd');
      fs.writeFileSync(shim, '@echo off\n');
      const r = cliLib.resolveExecutable({ claudePath: shim, env: {}, platform: 'win32' });
      assert.equal(r.ok, true);
      assert.equal(r.needsShell, true);
      assert.match(r.note, /cmd/);
      const posix = cliLib.resolveExecutable({ claudePath: shim, env: {}, platform: 'linux' });
      assert.equal(posix.needsShell, false, 'a .cmd is only a shim on Windows');
    } finally { rm(dir); }
  });
});
