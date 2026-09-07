/*
 * RespawnPack · core/core.test.mjs — unit fixtures for the host-neutral rollover core.
 *
 * Each block asserts a BEHAVIOUR the v0.3 design names, not an implementation detail that happens to
 * produce it. Where a check could pass by agreeing with everything, it ships with the known-bad half
 * beside it — the rule this program keeps re-learning is that a check answering identically for a
 * known-good and a known-bad input has proven it runs, not that it can detect anything.
 *
 * Nothing here touches the repository's own .respawnpack/; every fixture writes under os.tmpdir().
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { validate as schemaValidate } from '../schemas/validate.mjs';

const CORE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CORE);
const require_ = createRequire(import.meta.url);
const core = require_(path.join(CORE, 'index.js'));

const { io, machine, states, evidence, journal, cycle, consumable, failures, capabilities, thresholds, handoff, candidates, routing } = core;

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-core-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const at = (s) => `2026-08-06T${s}.000Z`;
const ev = {
  measure: (pct = 86, source = 'documented-api') => ({ kind: 'context-measurement', source, usedPercent: pct, raw: { used_percent: pct }, observedAt: at('10:00:00') }),
  boundary: () => ({ kind: 'safe-boundary', mechanism: 'unblocked-stop-hook', raw: { hook_event_name: 'Stop', stop_hook_active: false }, observedAt: at('10:00:01') }),
  requested: () => ({ kind: 'compact-requested', mechanism: 'sdk-slash-command', raw: { command: '/compact' }, observedAt: at('10:00:02') }),
  completed: (signal = 'compact_boundary') => ({ kind: 'compact-completed', signal, raw: { type: 'system', subtype: signal }, observedAt: at('10:00:03') }),
  identity: (expected, observed = expected, equal = true) => ({ kind: 'identity-verification', expectedId: expected, observedId: observed, equal, raw: { session_id: observed }, observedAt: at('10:00:04') }),
  noop: () => ({ kind: 'compact-noop', hostResult: 'Not enough messages to compact.', raw: { type: 'result', subtype: 'success', result: 'Not enough messages to compact.' }, observedAt: at('10:00:03') }),
};

function handoffFields(m, conversationId, host = 'claude-code') {
  return {
    identity: { host, conversationId, conversationIdField: 'session_id' },
    contextCycleId: m.cycleId(),
    atomicActionId: 'unit-fixture',
    exactNextAction: 'continue the unit fixture',
    git: { head: '466ed95', uncommittedFiles: [], sessionDelta: { status: 'UNCHANGED', files: [], headMoved: false } },
    userConstraints: [], unresolvedQuestions: [], candidateMemories: [],
  };
}

/** Drive a fresh machine to HANDOFF_VERIFIED, returning the machine, its dir and the handoff. */
function toVerified(projectDir, conversationId = 'sess_unit', host = 'claude-code') {
  const opened = machine.open({ projectDir, host, conversationId });
  assert.equal(opened.ok, true, `the machine would not open: ${opened.failure && opened.failure.code}`);
  const m = opened.machine;
  assert.equal(m.apply({ transition: 'checkpoint', eventId: 'm1', evidence: [ev.measure()] }).status, 'APPLIED');
  assert.equal(m.apply({ transition: 'closeout', eventId: 'b1', evidence: [ev.boundary()] }).status, 'APPLIED');
  const rec = handoff.build(handoffFields(m, conversationId, host));
  const w = handoff.writeVerified(m.dir, rec);
  assert.equal(w.ok, true, `the handoff would not verify: ${w.failure && w.failure.code}`);
  assert.equal(m.apply({ transition: 'stage-handoff', eventId: 'w1', evidence: [w.evidence.written] }).status, 'APPLIED');
  assert.equal(m.apply({ transition: 'verify-handoff', eventId: 'r1', evidence: [w.evidence.readback] }).status, 'APPLIED');
  return { m, dir: m.dir, handoff: rec, write: w };
}

// ---------------------------------------------------------------------------------------------
describe('core/_io — the persistence primitives the crash-safety claims rest on', () => {
  test('an atomic write returns the digest of the BYTES, and the read-back agrees', () => {
    const d = tmp('io');
    try {
      const f = path.join(d, 'x.json');
      const w = io.writeAtomicJSON(f, { a: 1 });
      const r = io.readTextClassified(f);
      assert.equal(w.ok, true);
      assert.equal(r.digest, w.digest, 'a digest taken over the object rather than the bytes would still match after a truncated write');
    } finally { rm(d); }
  });

  test('a canonical digest is stable across key order — and changes when a value changes', () => {
    assert.equal(io.canonicalDigest({ a: 1, b: 2 }), io.canonicalDigest({ b: 2, a: 1 }));
    assert.notEqual(io.canonicalDigest({ a: 1 }), io.canonicalDigest({ a: 2 }), 'the known-bad control: a digest that ignores values agrees with everything');
  });

  test('a torn tail is detected whether it is half a line OR a whole line with no newline', () => {
    const d = tmp('io-tail');
    try {
      const f = path.join(d, 'j.jsonl');
      io.appendLine(f, '{"a":1}');
      io.appendLine(f, '{"b":2}');
      const whole = io.readLinesClassified(f);
      assert.equal(whole.lines.length, 2);
      assert.equal(whole.tornTail, null, 'the known-good control: an intact log reports no torn tail');

      fs.appendFileSync(f, '{"c":3');
      const torn = io.readLinesClassified(f);
      assert.equal(torn.lines.length, 2);
      assert.equal(torn.tornTail, '{"c":3');

      const f2 = path.join(d, 'j2.jsonl');
      fs.writeFileSync(f2, '{"a":1}\n{"b":2}');
      const noNewline = io.readLinesClassified(f2);
      assert.equal(noNewline.lines.length, 1);
      assert.equal(noNewline.tornTail, '{"b":2}', 'a complete-looking line whose newline never landed is the same crash, and must not be trusted');
    } finally { rm(d); }
  });

  test('createExclusive is a compare-and-swap: exactly one CREATED, every other EXISTS', () => {
    const d = tmp('io-excl');
    try {
      const f = path.join(d, 'r.json');
      assert.equal(io.createExclusive(f, '{"first":true}').status, 'CREATED');
      assert.equal(io.createExclusive(f, '{"second":true}').status, 'EXISTS');
      assert.equal(readJSON(f).first, true, 'the loser overwrote the winner, which is the whole failure the primitive exists to remove');
    } finally { rm(d); }
  });

  test('a path segment cannot escape, and cannot land on a Windows device name', () => {
    assert.equal(io.safeSegment('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(io.safeSegment('thr_abc/../x'), 'thr_abc_.._x');
    assert.equal(io.safeSegment('NUL'), 'NUL_');
    assert.equal(io.safeSegment('COM1'), 'COM1_');
    assert.equal(io.safeSegment(''), 'unknown');
  });
});

// ---------------------------------------------------------------------------------------------
describe('the failure taxonomy — every code carries an outcome and an instruction', () => {
  test('no code exists without a recovery sentence, and none is a label', () => {
    for (const [code, spec] of Object.entries(failures.FAILURES)) {
      assert.ok(['FAIL', 'CANNOT_DETERMINE'].includes(spec.outcome), `${code}: outcome ${spec.outcome}`);
      assert.equal(typeof spec.halts, 'boolean', `${code}: does not say whether it halts`);
      assert.ok(spec.recovery && spec.recovery.length > 60, `${code}: the recovery instruction is a label, not something an operator can do`);
    }
  });

  test('a timeout is CANNOT_DETERMINE and a mismatch is FAIL — the two are never the same answer', () => {
    assert.equal(failures.failure('COMPLETION_UNOBSERVED').outcome, 'CANNOT_DETERMINE');
    assert.equal(failures.failure('IDENTITY_MISMATCH').outcome, 'FAIL');
    assert.equal(failures.exitCodeFor('CANNOT_DETERMINE'), 2);
    assert.equal(failures.exitCodeFor('FAIL'), 1);
    assert.equal(failures.exitCodeFor('PASS'), 0);
  });

  test('constructing an unknown code throws rather than inventing a failure', () => {
    assert.throws(() => failures.failure('NOT_A_CODE'), /unknown rollover failure code/);
  });

  test('rollup takes the worst; having run nothing determines nothing', () => {
    assert.equal(failures.rollup(['PASS', 'CANNOT_DETERMINE']), 'CANNOT_DETERMINE');
    assert.equal(failures.rollup(['CANNOT_DETERMINE', 'FAIL']), 'FAIL');
    assert.equal(failures.rollup([]), 'CANNOT_DETERMINE');
  });
});

// ---------------------------------------------------------------------------------------------
describe('evidence — a clock is never a completion signal', () => {
  test('the control pair: a documented signal is accepted and a timeout wearing its clothes is refused', () => {
    const good = evidence.validate(ev.completed('compact_boundary'));
    assert.equal(good.ok, true, 'the known-good control was refused, so a refusal proves nothing');
    const bad = evidence.validate({ ...ev.completed('timeout_after_120s') });
    assert.equal(bad.ok, false);
    assert.equal(bad.failure.code, 'PROOF_SUBSTITUTION_ATTEMPT');
  });

  test('every forbidden token is caught, not just the first one', () => {
    for (const token of evidence.FORBIDDEN_PROOF_TOKENS) {
      const r = evidence.validate({ ...ev.completed(`compact_${token}_x`) });
      assert.equal(r.ok, false, `signal containing "${token}" was accepted as completion evidence`);
      assert.equal(r.failure.code, 'PROOF_SUBSTITUTION_ATTEMPT');
    }
  });

  test('declaring a timeout is legitimate — the same word in the reason field means the opposite', () => {
    const r = evidence.validate({ kind: 'compact-unobserved', reason: 'timeout', waitedMs: 120000, raw: { last: 'item/started' }, observedAt: at('10:02:00') });
    assert.equal(r.ok, true, 'compact-unobserved is how a timeout is CARRIED; refusing it would leave nowhere honest to put one');
  });

  test('an undeclared signal is CANNOT_DETERMINE, and a provisional one is flagged rather than promoted', () => {
    const unknown = evidence.validate(ev.completed('some_event_nobody_declared'));
    assert.equal(unknown.failure.code, 'COMPLETION_EVIDENCE_UNTYPED');
    // The known-BAD half: an EXPERIMENTAL surface's item is accepted and flagged, never promoted to the
    // standing of a settled one. `provisionalShape` is the reason here, not `documented:false` —
    // the event is published and what it carries may still change without notice.
    const codex = evidence.validate(ev.completed('codex_context_compaction'));
    assert.equal(codex.ok, true);
    assert.equal(codex.provisional, true, 'an EXPERIMENTAL app-server item passed as settled evidence because its NAME appears in a doc');
    // The known-good half, or the flag above would only prove that something is always flagged.
    const claude = evidence.validate(ev.completed('compact_boundary'));
    assert.equal(claude.provisional, false);
  });

  test('the provisional flag is derived from the declaration, for every declared signal, in both directions', () => {
    /*
     * Not a list of the provisional signals — a list drifts the moment one is added or re-graded, which
     * is exactly what happened to Pi's two when R5 verified the pages they were guessing at. The rule
     * itself is asserted against every entry in the table, so a new signal is covered on the day it is
     * declared.
     */
    const seen = { provisional: 0, settled: 0 };
    for (const [signal, spec] of Object.entries(evidence.COMPLETION_SIGNALS)) {
      const r = evidence.validate(ev.completed(signal));
      assert.equal(r.ok, true, `${signal} is declared and was refused`);
      const expected = spec.documented === false || spec.provisionalShape === true;
      assert.equal(r.provisional, expected, `${signal}: documented=${spec.documented} provisionalShape=${spec.provisionalShape} but provisional came back ${r.provisional}`);
      seen[expected ? 'provisional' : 'settled'] += 1;
      assert.ok(spec.note && spec.note.length > 20, `${signal} carries no note saying what it is or where it was verified`);
      assert.ok(Array.isArray(spec.hosts) && spec.hosts.length, `${signal} names no host`);
    }
    assert.ok(seen.provisional >= 1 && seen.settled >= 1,
      'the table has stopped containing both kinds, so this fence can no longer discriminate — it would pass on a constant');
  });

  test('Pi\'s two surfaces are two DECLARED signals, not one name doing double duty', () => {
    // R5 raw-verified both pages, so neither is provisional any more — and they stayed SEPARATE, because
    // an RPC compaction carried under the extension's name would report a surface nobody observed.
    const ext = evidence.COMPLETION_SIGNALS.pi_session_compact;
    const rpc = evidence.COMPLETION_SIGNALS.pi_compaction_end;
    assert.equal(ext.documented, true);
    assert.equal(rpc.documented, true);
    assert.match(ext.note, /extensions/);
    assert.match(rpc.note, /rpc/);
    assert.equal(evidence.validate(ev.completed('pi_session_compact')).provisional, false);
    assert.equal(evidence.validate(ev.completed('pi_compaction_end')).provisional, false);
  });

  test('a host-observed record with no verbatim payload is refused', () => {
    const stripped = { ...ev.measure() };
    delete stripped.raw;
    const r = evidence.validate(stripped);
    assert.equal(r.ok, false);
    assert.equal(r.failure.code, 'EVIDENCE_MALFORMED');
    assert.match(r.failure.detail, /verbatim host payload/);
  });

  test('a raw payload past the ceiling is truncated AND says so', () => {
    const big = 'x'.repeat(evidence.MAX_RAW_BYTES + 100);
    const rec = evidence.make(evidence.KINDS.COMPACT_COMPLETED, { signal: 'compact_boundary', raw: big });
    assert.equal(rec.rawTruncated, true);
    assert.equal(rec.rawBytes, evidence.MAX_RAW_BYTES + 100);
    assert.ok(rec.rawDigest, 'the digest is of the WHOLE payload, so a truncated record can still be matched against the original');
  });

  test('measurement confidence travels with the source, and an undeclared source has none', () => {
    assert.equal(evidence.confidenceOf('documented-api'), 'HIGH');
    assert.equal(evidence.confidenceOf('internal-format'), 'LOW');
    assert.equal(evidence.confidenceOf('byte-proxy'), 'PROXY');
    assert.equal(evidence.confidenceOf('vibes'), null);
  });

  test('a documented count over a window WE configured is its own tier, and it is not HIGH', () => {
    // The asymmetry three adapters each compensated for: the host published the numerator and no
    // denominator, so the ratio is half measured. Declaring it `documented-api` would let the
    // numerator's confidence stand for the whole fraction.
    assert.equal(evidence.confidenceOf('documented-count-configured-window'), 'MEDIUM');
    assert.notEqual(evidence.confidenceOf('documented-count-configured-window'), evidence.CONFIDENCE.HIGH);
    // And it is a real, accepted measurement source — not a name that merely fails to be HIGH.
    const r = evidence.validate({ ...ev.measure(72, 'documented-count-configured-window') });
    assert.equal(r.ok, true, 'the new tier is not accepted as a declared measurement source at all');
  });
});

// ---------------------------------------------------------------------------------------------
describe('the transition table is enumerable, and the suites fence it in both directions', () => {
  test('every transition names declared states and declared evidence kinds', () => {
    const kinds = new Set(Object.values(evidence.KINDS));
    for (const [name, t] of Object.entries(states.TRANSITIONS)) {
      assert.ok(t.from === '*' || states.isState(t.from), `${name}: from ${t.from} is not a declared state`);
      assert.ok(states.isState(t.to), `${name}: to ${t.to} is not a declared state`);
      for (const k of t.requires) assert.ok(kinds.has(k), `${name}: requires ${k}, which is not a declared evidence kind`);
      assert.ok(t.why && t.why.length > 40, `${name}: has no stated reason to exist`);
    }
  });

  test('the three gating invariants are in the TABLE, not only in prose', () => {
    assert.equal(states.TRANSITIONS['request-compact'].from, 'HANDOFF_VERIFIED');
    assert.ok(states.TRANSITIONS['observe-completion'].requires.includes('compact-completed'));
    assert.ok(states.TRANSITIONS['verify-identity'].requires.includes('identity-verification'));
    assert.ok(states.TRANSITIONS['noop-return'].requires.includes('identity-verification'),
      'returning to ACTIVE after a no-op still crosses the identity boundary, so it still needs the record');
    for (const [name, t] of Object.entries(states.TRANSITIONS)) {
      if (t.to === 'ACTIVE') assert.ok(t.requires.includes('identity-verification'), `${name} reaches ACTIVE without requiring an identity record`);
    }
  });

  test('HALTED is terminal: nothing declares it as a source state', () => {
    for (const [name, t] of Object.entries(states.TRANSITIONS)) {
      assert.notEqual(t.from, 'HALTED', `${name} runs out of HALTED, which makes a halt advisory`);
    }
  });

  test('every state except HALTED is the target of some transition or is the start state', () => {
    const targets = new Set(Object.values(states.TRANSITIONS).map((t) => t.to));
    for (const s of Object.values(states.STATES)) {
      assert.ok(targets.has(s) || s === 'ACTIVE', `${s} is declared and unreachable`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the journal — append-only, torn-tail recoverable, corruption refused', () => {
  test('the fold replays hand-built history without opening a file', () => {
    const c = { host: 'claude-code', conversationId: 's', index: 0, nonce: 'aa', cycleId: 'claude-code:s:0:aa' };
    const st = journal.fold([
      { kind: 'cycle-open', cycle: c, state: 'ACTIVE', seq: 1 },
      { kind: 'transition', to: 'CHECKPOINT', cycleId: c.cycleId, transitionKey: 'checkpoint:m1', eventKey: 'evt:checkpoint:m1', result: { ok: 1 }, seq: 2 },
      { kind: 'noop', seq: 3 },
    ]);
    assert.equal(st.state, 'CHECKPOINT');
    assert.equal(st.counts.transitions, 1);
    assert.equal(st.counts.noops, 1);
    assert.equal(st.appliedByEvent.get('evt:checkpoint:m1').ok, 1);
  });

  test('two different events advancing the same cycle index is a FORK, not a duplicate', () => {
    const c0 = { index: 0, nonce: 'a', cycleId: 'h:c:0:a' };
    const c1 = { index: 1, nonce: 'b', cycleId: 'h:c:1:b' };
    const c1b = { index: 1, nonce: 'z', cycleId: 'h:c:1:z' };
    const st = journal.fold([
      { kind: 'cycle-open', cycle: c0, state: 'ACTIVE' },
      { kind: 'transition', to: 'ACTIVE', cycleId: c0.cycleId, eventKey: 'evt:verify-identity:x', cycleAdvance: { from: c0, to: c1 } },
      { kind: 'transition', to: 'ACTIVE', cycleId: c0.cycleId, eventKey: 'evt:verify-identity:y', cycleAdvance: { from: c0, to: c1b } },
    ]);
    assert.match(st.fork, /advanced cycle index 0/);
  });

  test('a torn tail is repaired and recorded; the machine resumes at the last COMPLETE record', () => {
    const d = tmp('journal-tail');
    try {
      const { m } = toVerified(d);
      const jf = journal.journalPath(m.dir);
      fs.appendFileSync(jf, '{"kind":"transition","to":"COMPA');

      const again = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_unit' });
      assert.equal(again.ok, true);
      assert.equal(again.opened.tornTailDiscarded, true);
      assert.equal(again.machine.state(), 'HANDOFF_VERIFIED', 'the machine adopted a state from a record the crash never finished writing');

      const rows = again.machine.rows();
      assert.ok(rows.some((r) => r.kind === 'journal-repair'), 'the repair is not recorded, so the discard is invisible to anyone reading the log');
      // The repair must be a REWRITE, or the broken bytes sit mid-file and every later fold is corrupt.
      const third = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_unit' });
      assert.equal(third.ok, true, 'the second open failed, which means the torn tail was discarded in memory only');
      assert.equal(third.opened.tornTailDiscarded, false);
    } finally { rm(d); }
  });

  test('an unparseable record that is NOT the last line is corruption and is refused', () => {
    const d = tmp('journal-corrupt');
    try {
      const { m } = toVerified(d);
      const jf = journal.journalPath(m.dir);
      const lines = fs.readFileSync(jf, 'utf8').split('\n').filter(Boolean);
      lines.splice(1, 0, '{not json');
      fs.writeFileSync(jf, `${lines.join('\n')}\n`);

      const again = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_unit' });
      assert.equal(again.ok, false);
      assert.equal(again.failure.code, 'JOURNAL_CORRUPT');
      assert.equal(again.failure.outcome, 'CANNOT_DETERMINE');
    } finally { rm(d); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('context cycle identity', () => {
  test('a cycleId carries host, conversation, index and nonce', () => {
    const c = cycle.mint({ host: 'codex', conversationId: 'thr_1', index: 0 });
    assert.match(c.cycleId, /^codex:thr_1:0:[0-9a-f]{12}$/);
    assert.equal(c.provenance, 'minted');
  });

  test('advancing changes both the index and the nonce — an index alone repeats across a clone', () => {
    const a = cycle.mint({ host: 'codex', conversationId: 'thr_1', index: 0 });
    const b = cycle.advance(a);
    assert.equal(b.index, 1);
    assert.notEqual(b.nonce, a.nonce);
    assert.equal(b.provenance, 'advanced');
  });

  test('a cycle is persisted and READ BACK before it is used', () => {
    const d = tmp('cycle');
    try {
      const c = cycle.mint({ host: 'pi', conversationId: 'pi_1', index: 3 });
      const p = cycle.persist(d, c);
      assert.equal(p.ok, true);
      assert.equal(cycle.readPersisted(d).cycle.cycleId, c.cycleId);
    } finally { rm(d); }
  });

  test('a restart RESTORES the cycle verbatim; a lost record MINTS and says which it was', () => {
    const d = tmp('cycle-restart');
    try {
      const first = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_r' });
      assert.equal(first.opened.restored, false);
      assert.equal(first.machine.cycle().provenance, 'minted');
      const id = first.machine.cycleId();

      const second = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_r' });
      assert.equal(second.opened.restored, true, 'a restart is not a new cycle');
      assert.equal(second.machine.cycleId(), id, 'the nonce was re-minted on a plain restart, which orphans every artifact bound to it');
    } finally { rm(d); }
  });

  test('a cycle file AHEAD of the journal is discarded and rewritten from the log', () => {
    const d = tmp('cycle-ahead');
    try {
      const first = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_ahead' });
      const dir = first.machine.dir;
      const real = first.machine.cycleId();
      // The shape of a crash between the cycle write and the journal append.
      cycle.persist(dir, cycle.advance(first.machine.cycle()));

      const again = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_ahead' });
      assert.equal(again.ok, true);
      assert.equal(again.opened.cycleFileRewritten, true);
      assert.equal(again.machine.cycleId(), real, 'the machine adopted a cycle the journal never recorded');
    } finally { rm(d); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the exactly-once consumable', () => {
  test('first call wins; the second is told so AND told who won', () => {
    const d = tmp('consume');
    try {
      const p = path.join(d, 'x.consumed.json');
      const first = consumable.consume(p, { subjectId: 'ho_1', consumerId: 'injector-a' });
      const second = consumable.consume(p, { subjectId: 'ho_1', consumerId: 'injector-b' });
      assert.equal(first.status, 'CONSUMED');
      assert.equal(second.status, 'ALREADY_CONSUMED');
      assert.equal(second.firstConsumption.consumerId, 'injector-a',
        'a boolean "already consumed" turns a duplicate delivery into an unexplained one');
    } finally { rm(d); }
  });

  test('an unreadable receipt is CANNOT_DETERMINE — never a fresh one', () => {
    const d = tmp('consume-bad');
    try {
      const p = path.join(d, 'x.consumed.json');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(p, '{ not json');
      const r = consumable.consume(p, { subjectId: 'ho_1', consumerId: 'c' });
      assert.equal(r.status, 'CANNOT_DETERMINE');
      assert.equal(r.failure.code, 'HANDOFF_RECEIPT_UNREADABLE');
    } finally { rm(d); }
  });

  test('inspect looks without claiming', () => {
    const d = tmp('consume-inspect');
    try {
      const p = path.join(d, 'x.consumed.json');
      assert.equal(consumable.inspect(p).status, 'FRESH');
      consumable.consume(p, { subjectId: 's', consumerId: 'c' });
      assert.equal(consumable.inspect(p).status, 'CONSUMED');
    } finally { rm(d); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the machine — duplicates, guards and halts', () => {
  test('a literal double-apply is a recorded no-op returning the ORIGINAL result', () => {
    const d = tmp('dupe');
    try {
      const opened = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_d' });
      const m = opened.machine;
      const first = m.apply({ transition: 'checkpoint', eventId: 'm1', evidence: [ev.measure()] });
      const second = m.apply({ transition: 'checkpoint', eventId: 'm1', evidence: [ev.measure()] });
      assert.equal(first.status, 'APPLIED');
      assert.equal(second.status, 'NOOP');
      // The ORIGINAL result, not a fresh one: same transition, same target, same timestamp.
      assert.equal(second.original.transition, 'checkpoint');
      assert.equal(second.original.to, 'CHECKPOINT');
      assert.equal(second.original.at, first.at, 'the no-op returned a newly built result rather than the one the first application produced');
      assert.equal(m.counts().noops, 1);
      assert.ok(m.rows().some((r) => r.kind === 'noop'), 'the no-op is not in the journal, so a redelivery leaves no trace');
    } finally { rm(d); }
  });

  test('a duplicate replayed after a CRASH is still a no-op — dedupe survives the process', () => {
    const d = tmp('dupe-crash');
    try {
      const { m } = toVerified(d);
      const before = m.state();
      // Interleaved crash-recovery replay: a fresh machine, the same host event.
      const again = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_unit' }).machine;
      assert.equal(again.state(), before);
      const r = again.apply({ transition: 'verify-handoff', eventId: 'r1', evidence: [] });
      assert.equal(r.status, 'NOOP', 'a redelivery after recovery was applied a second time');
      assert.equal(r.original.transition, 'verify-handoff');
    } finally { rm(d); }
  });

  test('the duplicate that spans a cycle advance — the SessionStart(compact) case', () => {
    const d = tmp('dupe-advance');
    try {
      const { m } = toVerified(d);
      m.apply({ transition: 'request-compact', eventId: 'c1', evidence: [ev.requested()] });
      m.apply({ transition: 'observe-completion', eventId: 'ss1', evidence: [ev.completed()] });
      const first = m.apply({ transition: 'verify-identity', eventId: 'ss1', evidence: [ev.identity('sess_unit')] });
      assert.equal(first.status, 'APPLIED');
      assert.equal(m.cycleIndex(), 1);

      const dup = m.apply({ transition: 'verify-identity', eventId: 'ss1', evidence: [ev.identity('sess_unit')] });
      assert.equal(dup.status, 'NOOP', 'the redelivery arrived after the cycle moved, so a per-cycle key alone would have missed it');
      assert.equal(m.cycleIndex(), 1, 'the context cycle advanced twice on one observed compaction');
    } finally { rm(d); }
  });

  test('COMPACTING is unreachable from anywhere but HANDOFF_VERIFIED', () => {
    const d = tmp('guard-state');
    try {
      const m = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_g' }).machine;
      const r = m.apply({ transition: 'request-compact', eventId: 'c1', evidence: [ev.requested()] });
      assert.equal(r.status, 'REFUSED');
      assert.equal(r.failure.code, 'ILLEGAL_TRANSITION');
      assert.equal(m.state(), 'ACTIVE');
    } finally { rm(d); }
  });

  test('and a hand-forged HANDOFF_VERIFIED with no verification record is refused by the SECOND layer', () => {
    const d = tmp('guard-semantic');
    try {
      const m = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_f' }).machine;
      // Forge the state directly in the log — the only way to reach HANDOFF_VERIFIED without verifying.
      journal.append(m.dir, {
        kind: 'transition', seq: 99, at: at('10:00:00'), cycleId: m.cycleId(),
        transition: 'verify-handoff', transitionKey: 'verify-handoff:forged', eventKey: 'evt:verify-handoff:forged',
        from: 'ROLLOVER_PENDING', to: 'HANDOFF_VERIFIED', evidence: [], verifiedHandoff: null, result: { forged: true },
      });
      const again = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_f' }).machine;
      assert.equal(again.state(), 'HANDOFF_VERIFIED');
      const r = again.apply({ transition: 'request-compact', eventId: 'c1', evidence: [ev.requested()] });
      assert.equal(r.status, 'REFUSED');
      assert.equal(r.failure.code, 'HANDOFF_UNVERIFIED',
        'the state guard alone would have let this through, which is why the semantic guard is not redundant');
    } finally { rm(d); }
  });

  test('a readback record that claims equal:true above two different digests is not believed', () => {
    const d = tmp('readback-liar');
    try {
      const opened = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_rl' });
      const m = opened.machine;
      m.apply({ transition: 'checkpoint', eventId: 'm1', evidence: [ev.measure()] });
      m.apply({ transition: 'closeout', eventId: 'b1', evidence: [ev.boundary()] });
      const rec = handoff.build(handoffFields(m, 'sess_rl'));
      const w = handoff.writeVerified(m.dir, rec);
      m.apply({ transition: 'stage-handoff', eventId: 'w1', evidence: [w.evidence.written] });

      // The known-good half is every other fixture in this file; this is the adversarial half — a
      // wrapper asserting agreement above numbers that disagree, which is what an optimistic adapter
      // (or a hand-built journal) produces.
      const liar = { ...w.evidence.readback, readBackDigest: 'f'.repeat(64), equal: true };
      const r = m.apply({ transition: 'verify-handoff', eventId: 'r1', evidence: [liar] });
      assert.equal(r.status, 'HALTED');
      assert.equal(r.failure.code, 'HANDOFF_READBACK_MISMATCH');
      assert.match(r.failure.detail, /claims equal:true while its digests differ/);
    } finally { rm(d); }
  });

  test('an identity record that claims equal:true above two different ids is not believed', () => {
    const d = tmp('identity-liar');
    try {
      const { m } = toVerified(d);
      m.apply({ transition: 'request-compact', eventId: 'c1', evidence: [ev.requested()] });
      m.apply({ transition: 'observe-completion', eventId: 'b1', evidence: [ev.completed()] });
      const r = m.apply({ transition: 'verify-identity', eventId: 's1', evidence: [ev.identity('sess_unit', 'sess_other', true)] });
      assert.equal(r.status, 'HALTED');
      assert.equal(r.failure.code, 'IDENTITY_MISMATCH');
    } finally { rm(d); }
  });

  test('an unobservable identity is CANNOT_DETERMINE, and is not the same halt as a mismatch', () => {
    const d = tmp('identity-blind');
    try {
      const { m } = toVerified(d, 'sess_blind');
      m.apply({ transition: 'request-compact', eventId: 'c1', evidence: [ev.requested()] });
      m.apply({ transition: 'observe-completion', eventId: 'b1', evidence: [ev.completed()] });
      const r = m.apply({
        transition: 'verify-identity', eventId: 's1',
        evidence: [{ kind: 'identity-verification', expectedId: 'sess_blind', observedId: null, equal: null, raw: { note: 'the host exposed nothing' }, observedAt: at('10:00:05') }],
      });
      assert.equal(r.failure.code, 'IDENTITY_UNOBSERVABLE');
      assert.equal(r.failure.outcome, 'CANNOT_DETERMINE');
    } finally { rm(d); }
  });

  test('nothing resumes past a halt, including a halt', () => {
    const d = tmp('halted');
    try {
      const m = machine.open({ projectDir: d, host: 'claude-code', conversationId: 'sess_h' }).machine;
      m.apply({ transition: 'halt', eventId: 'h1', failureCode: 'COMPLETION_UNOBSERVED' });
      const after = m.apply({ transition: 'checkpoint', eventId: 'm1', evidence: [ev.measure()] });
      assert.equal(after.status, 'HALTED');
      assert.equal(m.state(), 'HALTED');
      assert.equal(m.outcome(), 'CANNOT_DETERMINE');
    } finally { rm(d); }
  });

  test('the journal stores the raw host payload VERBATIM beside the typed wrapper', () => {
    const d = tmp('verbatim');
    try {
      const m = machine.open({ projectDir: d, host: 'codex', conversationId: 'thr_v' }).machine;
      const raw = { method: 'thread/tokenUsage/updated', params: { someUndocumentedName: 41231 } };
      m.apply({ transition: 'checkpoint', eventId: 'm1', evidence: [{ kind: 'context-measurement', source: 'documented-event', usedPercent: 77, raw, observedAt: at('10:00:00') }] });
      const row = m.rows().find((r) => r.kind === 'transition');
      assert.deepEqual(row.evidence[0].raw, raw, 'the undocumented field names are the whole reason the payload is kept');
    } finally { rm(d); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the handoff — written once, verified by bytes, consumed once', () => {
  test('a real record conforms to core/state/rollover-handoff.schema.json, and a stray field does not', () => {
    const schema = readJSON(path.join(CORE, 'state', 'rollover-handoff.schema.json'));
    const d = tmp('handoff-schema');
    try {
      const { m, handoff: rec } = toVerified(d, 'sess_schema');
      const onDisk = readJSON(handoff.pathFor(m.dir, rec.handoffId));
      const good = schemaValidate(onDisk, schema);
      assert.equal(good.valid, true, `the real written handoff does not conform:\n  ${good.errors.join('\n  ')}`);

      const bad = schemaValidate({ ...onDisk, surprise: 1 }, schema);
      assert.equal(bad.valid, false, 'additionalProperties:false is doing no work, so the schema documents nothing');
    } finally { rm(d); }
  });

  test('write → read-back compares BYTES, and a tampered file fails the comparison', () => {
    const d = tmp('handoff-bytes');
    try {
      const { m, handoff: rec, write } = toVerified(d, 'sess_bytes');
      assert.equal(write.evidence.readback.equal, true);
      fs.appendFileSync(handoff.pathFor(m.dir, rec.handoffId), '\n{}\n');
      const now = io.readTextClassified(handoff.pathFor(m.dir, rec.handoffId));
      assert.notEqual(now.digest, write.writtenDigest);
    } finally { rm(d); }
  });

  test('consumption is exactly once, and the second consumer gets a pointer to the first', () => {
    const d = tmp('handoff-consume');
    try {
      const { m, handoff: rec } = toVerified(d, 'sess_consume');
      const first = handoff.consume(m.dir, rec.handoffId, { consumerId: 'injector-a' });
      const second = handoff.consume(m.dir, rec.handoffId, { consumerId: 'injector-b' });
      assert.equal(first.status, 'CONSUMED');
      assert.equal(first.handoff.exactNextAction, 'continue the unit fixture');
      assert.equal(second.status, 'ALREADY_CONSUMED');
      assert.equal(second.firstConsumption.consumerId, 'injector-a');
    } finally { rm(d); }
  });

  test('an unverified handoff is refused, and one that CHANGED since verification is refused differently', () => {
    const d = tmp('handoff-refuse');
    try {
      const { m, handoff: rec } = toVerified(d, 'sess_refuse');
      fs.rmSync(handoff.verifiedPathFor(m.dir, rec.handoffId));
      const unverified = handoff.consume(m.dir, rec.handoffId, { consumerId: 'x' });
      assert.equal(unverified.status, 'REFUSED');
      assert.equal(unverified.failure.code, 'HANDOFF_UNVERIFIED');
    } finally { rm(d); }
  });

  test('the TOCTOU window: verified, then edited, then offered for injection', () => {
    const d = tmp('handoff-toctou');
    try {
      const { m, handoff: rec } = toVerified(d, 'sess_toctou');
      const p = handoff.pathFor(m.dir, rec.handoffId);
      const doc = readJSON(p);
      doc.exactNextAction = 'do something nobody verified';
      io.writeAtomicJSON(p, doc);
      const r = handoff.consume(m.dir, rec.handoffId, { consumerId: 'x' });
      assert.equal(r.status, 'REFUSED');
      assert.equal(r.failure.code, 'HANDOFF_CHANGED_SINCE_VERIFICATION',
        'a receipt proves the file was right when it was written, not that it is right now');
    } finally { rm(d); }
  });

  test('a v1 precompact handoff migrates without inventing a next action', () => {
    const v1 = {
      schemaVersion: '1.0.0', kind: 'precompact-handoff', sessionId: 'sess_v1', trigger: 'auto',
      writtenAt: at('09:00:00'), head: 'abc1234', uncommittedFiles: ['a.js'], uncommittedTruncated: false,
      sessionDelta: { status: 'CHANGED', files: ['a.js'], headMoved: false },
      ledgerPresent: true, ledgerLastCommit: 'abc1234', ledgerBehindHead: true,
      atomicTask: 'finish the parser', contract: 'collaborate', readBackVerified: true,
    };
    const r = handoff.fromV1(v1, { host: 'claude-code', contextCycleId: 'claude-code:sess_v1:0:aabbccddeeff' });
    assert.equal(r.ok, true);
    assert.equal(r.handoff.exactNextAction, null, 'a migration that manufactured a next action would be reconstructing a conclusion from memory');
    assert.equal(r.handoff.atomicActionId, 'finish the parser');
    assert.equal(r.handoff.migratedFrom, '1.0.0');
    assert.deepEqual(r.handoff.source.raw, v1, 'the v1 record is the only copy of what that session recorded and must survive verbatim');
    assert.ok(r.handoff.unresolvedQuestions.some((q) => /wave-ledger/.test(q)), 'the v1 ledger warning was dropped in migration');
    assert.equal(handoff.validate(r.handoff).ok, true);

    const schema = readJSON(path.join(CORE, 'state', 'rollover-handoff.schema.json'));
    assert.equal(schemaValidate(r.handoff, schema).valid, true, 'the migrated shape is a real shape and must conform too');
  });

  test('a handoff with no contextCycleId is refused before it is written', () => {
    const d = tmp('handoff-invalid');
    try {
      const rec = handoff.build({ identity: { host: 'claude-code', conversationId: 's' } });
      const w = handoff.writeVerified(d, rec);
      assert.equal(w.ok, false);
      assert.match(w.failure.detail, /contextCycleId/);
    } finally { rm(d); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('thresholds re-arm PER CONTEXT CYCLE, never per session id', () => {
  test('the headline: the same session id, a new cycle, and every threshold armed again', () => {
    const sessionId = 'sess_same_id_across_compaction';
    const c0 = `claude-code:${sessionId}:0:aaaaaaaaaaaa`;
    const c1 = `claude-code:${sessionId}:1:bbbbbbbbbbbb`;

    let rec = thresholds.emptyLatches(c0);
    const first = thresholds.evaluate({ usedPercent: 86, source: 'documented-api', record: rec });
    assert.deepEqual(first.fire, ['advisory', 'checkpoint', 'final']);
    for (const n of first.fire) rec = thresholds.latch(rec, n, { atPercent: 86 });

    const again = thresholds.evaluate({ usedPercent: 88, source: 'documented-api', record: rec });
    assert.deepEqual(again.fire, [], 'a latched threshold fired twice inside one cycle');

    // The compaction happens. The SESSION ID DOES NOT CHANGE — that is the whole point.
    const rolled = thresholds.forCycle(rec, c1);
    assert.equal(rolled.rearmed, true);
    const afterRollover = thresholds.evaluate({ usedPercent: 86, source: 'documented-api', record: rolled.record });
    assert.deepEqual(afterRollover.fire, ['advisory', 'checkpoint', 'final'],
      'this is the v0.2 defect verbatim: a compacted session keeps its id, so a per-session latch never re-armed');
  });

  test('an unchanged cycle keeps its latches — which is why a no-op compaction cannot loop', () => {
    const c0 = 'claude-code:s:0:aaaaaaaaaaaa';
    const rec = thresholds.latch(thresholds.emptyLatches(c0), 'final', { atPercent: 86 });
    const same = thresholds.forCycle(rec, c0);
    assert.equal(same.rearmed, false);
    assert.deepEqual(thresholds.evaluate({ usedPercent: 99, source: 'documented-api', record: same.record }).fire, ['advisory', 'checkpoint']);
  });

  test('an unmeasured context is CANNOT_DETERMINE — not 0%, not 100%, and it fires nothing', () => {
    const rec = thresholds.emptyLatches('c');
    for (const bad of [null, undefined, NaN, 'lots']) {
      const r = thresholds.evaluate({ usedPercent: bad, source: 'documented-api', record: rec });
      assert.equal(r.measurable, false);
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.deepEqual(r.fire, []);
    }
    const good = thresholds.evaluate({ usedPercent: 61, source: 'documented-api', record: rec });
    assert.equal(good.measurable, true, 'the known-good control: a real measurement is still acted on');
    assert.deepEqual(good.fire, ['advisory']);
  });

  test('an undeclared measurement source is not acted on', () => {
    const r = thresholds.evaluate({ usedPercent: 99, source: 'a-number-i-liked', record: thresholds.emptyLatches('c') });
    assert.equal(r.outcome, 'CANNOT_DETERMINE');
    assert.deepEqual(r.fire, []);
  });

  test('the final threshold on a low-confidence number is flagged rather than presented as a reading', () => {
    const proxy = thresholds.evaluate({ usedPercent: 90, source: 'byte-proxy', record: thresholds.emptyLatches('c') });
    assert.equal(proxy.confidence, 'PROXY');
    assert.equal(proxy.requiresOperatorConfirmation, true);
    const documented = thresholds.evaluate({ usedPercent: 90, source: 'documented-api', record: thresholds.emptyLatches('c') });
    assert.equal(documented.requiresOperatorConfirmation, false, 'the known-good control: a documented reading needs no hedge');
  });

  test('EVERY non-HIGH source is confirmed at the final threshold — MEDIUM is not a partial exemption', () => {
    /*
     * Asserted over the whole declared table rather than over the tiers someone remembered: the rule is
     * `!== HIGH`, and a new tier must be covered by it on the day it is declared. MEDIUM is named
     * explicitly below because it is the one a reader would expect to be treated as "documented enough".
     */
    for (const [source, confidence] of Object.entries(evidence.SOURCE_CONFIDENCE)) {
      const r = thresholds.evaluate({ usedPercent: 90, source, record: thresholds.emptyLatches('c') });
      assert.equal(r.confidence, confidence, `${source} did not carry its declared confidence`);
      assert.deepEqual(r.fire, ['advisory', 'checkpoint', 'final'], `${source} did not reach the final threshold, so the confirmation rule was never exercised for it`);
      assert.equal(r.requiresOperatorConfirmation, confidence !== 'HIGH',
        `${source} (${confidence}) got the wrong answer at the final threshold`);
    }
    const medium = thresholds.evaluate({ usedPercent: 90, source: 'documented-count-configured-window', record: thresholds.emptyLatches('c') });
    assert.equal(medium.confidence, 'MEDIUM');
    assert.equal(medium.requiresOperatorConfirmation, true, 'a documented count over a window we chose stopped a session without asking');
  });

  test('threshold configuration must ascend and stay inside a percentage', () => {
    assert.equal(thresholds.normalize({}).ok, true);
    assert.equal(thresholds.normalize({ advisory: 80, checkpoint: 75, final: 85 }).ok, false);
    assert.equal(thresholds.normalize({ final: 120 }).ok, false);
    assert.equal(thresholds.normalize({ whatever: 10 }).ok, false);
  });

  test('latches persist and reload under the cycle they belong to', () => {
    const d = tmp('latch-io');
    try {
      thresholds.writeLatches(d, thresholds.latch(thresholds.emptyLatches('c0'), 'final', { atPercent: 88 }));
      const back = thresholds.readLatches(d);
      assert.equal(back.status, 'OK');
      assert.equal(thresholds.forCycle(back.record, 'c0').rearmed, false);
      assert.equal(thresholds.forCycle(back.record, 'c1').rearmed, true);
    } finally { rm(d); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('capability declarations — installing files is not proof', () => {
  const canary = { kind: 'hook-fired', ran: true, observedAt: at('10:00:00'), outcome: 'PASS', raw: { hook_event_name: 'SessionStart', source: 'compact' } };

  test('SUPPORTED without a canary is downgraded to CANNOT_DETERMINE, and says why', () => {
    const d = capabilities.declare({ capability: 'observeCompact', support: 'SUPPORTED' });
    assert.equal(d.support, 'CANNOT_DETERMINE');
    assert.equal(d.declaredSupport, 'SUPPORTED');
    assert.equal(d.downgraded, true);
    assert.match(d.why, /no activation canary/);
  });

  test('SUPPORTED with a canary stands — the known-good half of the pair', () => {
    const d = capabilities.declare({ capability: 'observeCompact', support: 'SUPPORTED', canary, mechanism: 'compact_boundary' });
    assert.equal(d.support, 'SUPPORTED');
    assert.equal(d.downgraded, false);
  });

  test('a canary with no verbatim payload, or that never ran, does not count', () => {
    for (const bad of [{ ...canary, raw: null }, { ...canary, ran: false }, { ...canary, observedAt: undefined }]) {
      const d = capabilities.declare({ capability: 'probe', support: 'SUPPORTED', canary: bad });
      assert.equal(d.support, 'CANNOT_DETERMINE');
    }
  });

  test('⛔ A CANARY THAT RAN IS NOT A CANARY THAT PASSED — the verdict is read, and it is named', () => {
    /*
     * The gap every adapter found on its own: `canaryUsable` reads SHAPE, and a well-formed record of a
     * FAILED run is perfectly well-shaped. Four adapter files each grew the same `outcome === PASS`
     * guard beside their call to declare(); the rule belongs here, once, where an adapter that forgets
     * it cannot over-claim by forgetting it.
     */
    for (const verdict of ['FAIL', 'CANNOT_DETERMINE', 'NOT_APPLICABLE']) {
      const ran = { ...canary, outcome: verdict };
      // The control half: this record passes the SHAPE gate on its own, which is why shape alone was
      // never enough. If this assertion ever flips, the test below stops proving what it claims.
      assert.equal(capabilities.canaryUsable(ran).ok, true, `a ${verdict} canary is no longer well-shaped, so the verdict rule is not what is being exercised`);
      const d = capabilities.declare({ capability: 'requestCompact', support: 'SUPPORTED', canary: ran, mechanism: 'x' });
      assert.equal(d.support, 'CANNOT_DETERMINE', `a canary whose verdict was ${verdict} produced a SUPPORTED declaration`);
      assert.equal(d.declaredSupport, 'SUPPORTED', 'the refused claim must still be visible, or the matrix cannot report what was attempted');
      assert.equal(d.downgraded, true);
      assert.match(d.why, new RegExp(verdict), 'the downgrade does not name the verdict the canary actually recorded');
    }
    // A verdict nobody declared is not a pass either — and neither is no verdict at all.
    const bogus = capabilities.declare({ capability: 'requestCompact', support: 'SUPPORTED', canary: { ...canary, outcome: 'ok' }, mechanism: 'x' });
    assert.equal(bogus.support, 'CANNOT_DETERMINE');
    assert.match(bogus.why, /"ok"/);
    const silent = { ...canary };
    delete silent.outcome;
    const noVerdict = capabilities.declare({ capability: 'requestCompact', support: 'SUPPORTED', canary: silent, mechanism: 'x' });
    assert.equal(noVerdict.support, 'CANNOT_DETERMINE', 'a canary that never said how it went was read as having passed');
    assert.match(noVerdict.why, /no verdict/);
    // And the known-good half, in both claim shapes, or the rule above only proves that everything is refused.
    assert.equal(capabilities.declare({ capability: 'requestCompact', support: 'SUPPORTED', canary, mechanism: 'x' }).support, 'SUPPORTED');
    assert.equal(capabilities.declare({ capability: 'requestCompact', support: 'SUPPORTED_WITH_LIMITATIONS', canary, mechanism: 'x', limitations: ['the operator runs /compact'] }).support, 'SUPPORTED_WITH_LIMITATIONS');
  });

  test('canaryVerdict is the OUTCOME vocabulary, crossing into SUPPORT once and only on PASS', () => {
    assert.equal(capabilities.canaryVerdict({ outcome: 'PASS' }).ok, true);
    assert.equal(capabilities.canaryVerdict({ outcome: 'PASS' }).verdict, 'PASS');
    assert.equal(capabilities.canaryVerdict({ outcome: 'CANNOT_DETERMINE' }).ok, false);
    assert.equal(capabilities.canaryVerdict({ outcome: 'CANNOT_DETERMINE' }).verdict, 'CANNOT_DETERMINE');
    assert.equal(capabilities.canaryVerdict(null).ok, false);
    // ⛔ SUPPORT.CANNOT_DETERMINE is NOT the canary's CANNOT_DETERMINE, and a canary carrying a SUPPORT
    // level instead of an outcome is a merged vocabulary, refused here rather than read as either.
    assert.equal(capabilities.canaryVerdict({ outcome: 'SUPPORTED' }).ok, false);
    assert.match(capabilities.canaryVerdict({ outcome: 'SUPPORTED' }).why, /is not one of/);
  });

  test('SUPPORTED_WITH_LIMITATIONS with no limitation named is a SUPPORTED claim wearing a hedge', () => {
    const bare = capabilities.declare({ capability: 'requestCompact', support: 'SUPPORTED_WITH_LIMITATIONS', canary });
    assert.equal(bare.support, 'CANNOT_DETERMINE');
    const named = capabilities.declare({ capability: 'requestCompact', support: 'SUPPORTED_WITH_LIMITATIONS', canary, limitations: ['the operator runs /compact; no hook output can make an unmanaged client compact itself'] });
    assert.equal(named.support, 'SUPPORTED_WITH_LIMITATIONS');
  });

  test('NOT_SUPPORTED and CANNOT_DETERMINE need a reason', () => {
    assert.equal(capabilities.declare({ capability: 'resume', support: 'NOT_SUPPORTED' }).support, 'CANNOT_DETERMINE');
    assert.equal(capabilities.declare({ capability: 'resume', support: 'NOT_SUPPORTED', why: 'the profile mints a new conversation on every run' }).support, 'NOT_SUPPORTED');
  });

  test('an undeclared capability is CANNOT_DETERMINE in the matrix, never absent from it', () => {
    const mx = capabilities.matrix('claude-code/hooks', [capabilities.declare({ capability: 'probe', support: 'SUPPORTED', canary })]);
    assert.equal(mx.declarations.length, capabilities.CAPABILITIES.length);
    assert.ok(mx.undeclared.includes('observeCompact'));
    assert.equal(mx.rolloverCapable, false);
    assert.equal(mx.outcome, 'CANNOT_DETERMINE');
  });

  test('a fully canaried profile is rolloverCapable, so the matrix is not merely pessimistic', () => {
    const all = capabilities.CAPABILITIES.map((c) => capabilities.declare({ capability: c, support: 'SUPPORTED', canary }));
    const mx = capabilities.matrix('claude-code/sdk-supervisor', all);
    assert.equal(mx.rolloverCapable, true);
    assert.equal(mx.outcome, 'PASS');
  });

  test('the PLANNED matrix can never become a declaration', () => {
    for (const profile of Object.keys(capabilities.PLANNED)) {
      for (const cap of capabilities.CAPABILITIES) {
        assert.equal(capabilities.fromPlan(profile, cap).support, 'CANNOT_DETERMINE', `${profile}/${cap} was declared from a plan`);
      }
    }
  });

  test('SUPPORT and OUTCOME are different enums that share exactly one name', () => {
    const shared = Object.keys(capabilities.SUPPORT).filter((k) => k in failures.OUTCOME);
    assert.deepEqual(shared, ['CANNOT_DETERMINE'],
      'the two vocabularies have started to merge, which is how "the probe passed" gets read as "the capability is supported"');
    assert.notEqual(capabilities.SUPPORT, failures.OUTCOME);
  });
});

// ---------------------------------------------------------------------------------------------
describe('candidate memories — a lead never becomes a fact by accident', () => {
  const provenance = (cycleId) => ({ by: 'unit-fixture', cycleId, conversationId: 'sess_mem', host: 'claude-code', sourceKind: 'savepoint', evidencePaths: [] });

  test('promotion requires evidence; without it the candidate stays a candidate', () => {
    const d = tmp('mem');
    try {
      const c = candidates.capture(d, { claim: 'the retry loop starves under three readers', klass: 'finding', provenance: provenance('c0') });
      assert.equal(c.ok, true);
      const refused = candidates.promote(d, c.record.id, { by: 'me' });
      assert.equal(refused.status, 'REFUSED');
      assert.match(refused.reason, /supporting evidence path/);
      assert.equal(candidates.read(d, c.record.id).record.verificationState, 'candidate');

      const ok = candidates.promote(d, c.record.id, { by: 'me', evidencePaths: ['kernel/concurrency.test.mjs'] });
      assert.equal(ok.status, 'PROMOTED', 'the known-good control: a promotion WITH evidence must succeed, or the check is just a refusal');
      assert.equal(ok.record.verificationState, 'verified');
    } finally { rm(d); }
  });

  test('promote and reject are idempotent, and the retry is still audited', () => {
    const d = tmp('mem-idem');
    try {
      const c = candidates.capture(d, { claim: 'x', klass: 'decision', provenance: provenance('c0') }).record;
      candidates.promote(d, c.id, { by: 'a', evidencePaths: ['e'] });
      const again = candidates.promote(d, c.id, { by: 'b', evidencePaths: ['e2'] });
      assert.equal(again.status, 'ALREADY_VERIFIED');
      assert.deepEqual(again.record.verification.evidencePaths, ['e'], 'the second promotion rewrote the first one');

      const audit = fs.readFileSync(candidates.auditPath(d), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(audit.map((r) => r.action), ['capture', 'promote', 'promote-noop']);
    } finally { rm(d); }
  });

  test('a rejected candidate cannot be promoted back by retrying promote()', () => {
    const d = tmp('mem-reject');
    try {
      const c = candidates.capture(d, { claim: 'y', klass: 'constraint', provenance: provenance('c0') }).record;
      assert.equal(candidates.reject(d, c.id, { by: 'a', reason: 'contradicted by the run at 466ed95' }).status, 'REJECTED');
      assert.equal(candidates.reject(d, c.id, { by: 'a', reason: 'again' }).status, 'ALREADY_REJECTED');
      const p = candidates.promote(d, c.id, { by: 'a', evidencePaths: ['e'] });
      assert.equal(p.status, 'REFUSED');
      assert.match(p.reason, /deliberate act with its own record/);
    } finally { rm(d); }
  });

  test('a rejection must state why', () => {
    const d = tmp('mem-why');
    try {
      const c = candidates.capture(d, { claim: 'z', klass: 'finding', provenance: provenance('c0') }).record;
      assert.equal(candidates.reject(d, c.id, { by: 'a' }).status, 'REFUSED');
    } finally { rm(d); }
  });

  test('recall marks every unverified lead and never renders a rejected one', () => {
    const d = tmp('mem-render');
    try {
      candidates.capture(d, { claim: 'a hunch nobody checked', klass: 'finding', provenance: provenance('c0') });
      const b = candidates.capture(d, { claim: 'a finding backed by a run', klass: 'finding', provenance: provenance('c0') }).record;
      const c = candidates.capture(d, { claim: 'a claim that was overturned', klass: 'finding', provenance: provenance('c0') }).record;
      candidates.promote(d, b.id, { by: 'a', evidencePaths: ['docs/evidence.md'] });
      candidates.reject(d, c.id, { by: 'a', reason: 'wrong' });

      const lines = candidates.renderForRecall(candidates.list(d).records);
      assert.equal(lines.length, 2);
      const unverified = lines.find((l) => l.includes('a hunch nobody checked'));
      assert.ok(unverified.startsWith(candidates.UNVERIFIED_MARKER), `an unverified candidate rendered as: ${unverified}`);
      assert.ok(lines.find((l) => l.includes('a finding backed by a run')).startsWith('VERIFIED'));
      assert.ok(!lines.some((l) => l.includes('overturned')));
    } finally { rm(d); }
  });

  test('the store\'s directory: the default leaf is unchanged, and the exact-dir form is the only way past it', () => {
    const d = tmp('mem-store');
    try {
      // The DEFAULT, byte-for-byte what every caller passing a string has always got.
      assert.equal(candidates.storeDir(d), path.join(d, 'memory'));
      assert.equal(candidates.auditPath(d), path.join(d, 'memory', 'audit.jsonl'));
      assert.equal(candidates.recordPath(d, 'cm_abc'), path.join(d, 'memory', 'cm_abc.json'));

      // The OPT-IN: this exact directory, with no leaf chosen on the caller's behalf.
      const exact = path.join(d, 'memory', 'candidates');
      assert.equal(candidates.storeDir({ dir: exact }), exact);
      assert.equal(candidates.auditPath({ dir: exact }), path.join(exact, 'audit.jsonl'));

      // And it is a real store, not just a path helper: a full capture → promote → list round trip
      // lands in the named directory and NOWHERE else.
      const c = candidates.capture({ dir: exact }, { claim: 'an exact-dir capture', klass: 'finding', provenance: provenance('c0') });
      assert.equal(c.ok, true, `capture into an exact dir failed: ${c.reason}`);
      assert.equal(path.dirname(c.file), exact);
      assert.equal(candidates.promote({ dir: exact }, c.record.id, { by: 'a', evidencePaths: ['e'] }).status, 'PROMOTED');
      assert.deepEqual(candidates.list({ dir: exact }).records.map((r) => r.id), [c.record.id]);
      assert.equal(fs.existsSync(path.join(exact, 'audit.jsonl')), true);
      // The known-bad half: the default store is EMPTY, so the leaf was genuinely not applied. Without
      // this the assertions above would also pass if the exact-dir form silently appended `memory`.
      assert.deepEqual(candidates.list(d).records, [], 'the exact-dir store also wrote through the default leaf');
      assert.equal(fs.existsSync(path.join(d, 'memory', 'audit.jsonl')), false);
    } finally { rm(d); }
  });

  test('a record conforms to core/memory/candidate-memory.schema.json, and a stray field does not', () => {
    const schema = readJSON(path.join(CORE, 'memory', 'candidate-memory.schema.json'));
    const d = tmp('mem-schema');
    try {
      const c = candidates.capture(d, { claim: 'a claim', klass: 'root-cause-fix', provenance: provenance('c0') }).record;
      assert.equal(schemaValidate(c, schema).valid, true, `the captured record does not conform:\n  ${schemaValidate(c, schema).errors.join('\n  ')}`);
      candidates.promote(d, c.id, { by: 'a', evidencePaths: ['e'] });
      const promoted = candidates.read(d, c.id).record;
      assert.equal(schemaValidate(promoted, schema).valid, true, 'the promoted shape is a real shape and must conform too');
      assert.equal(schemaValidate({ ...promoted, surprise: 1 }, schema).valid, false);
    } finally { rm(d); }
  });

  test('a memory with no cycle id is refused — it could not be audited against what was known then', () => {
    const d = tmp('mem-nocycle');
    try {
      const r = candidates.capture(d, { claim: 'x', klass: 'finding', provenance: { by: 'a' } });
      assert.equal(r.ok, false);
      assert.match(r.reason, /cycleId/);
    } finally { rm(d); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('⛔ the dependency arrow, fenced', () => {
  function coreFiles(dir = CORE, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) coreFiles(p, out);
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  }

  test('nothing under core/ requires from hooks/ or kernel/', () => {
    const files = coreFiles();
    assert.ok(files.length >= 10, `only ${files.length} core modules swept — a sweep that reaches nothing agrees with everything`);
    const offenders = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (/(^|\/)(hooks|kernel)\//.test(m[1])) offenders.push(`${path.relative(CORE, f)} → ${m[1]}`);
      }
    }
    assert.deepEqual(offenders, [],
      `core/ must not depend on a host tree: adapters and the kernel consume core/, never the reverse.\n  ${offenders.join('\n  ')}`);
  });

  test('core/ adds no npm dependency — every require is a builtin or a relative path', () => {
    const builtins = new Set(['fs', 'path', 'crypto', 'os', 'child_process', 'url', 'util', 'events', 'assert']);
    const offenders = [];
    for (const f of coreFiles()) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('node:') || builtins.has(spec)) continue;
        offenders.push(`${path.relative(CORE, f)} → ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `the repository is zero-dependency by design:\n  ${offenders.join('\n  ')}`);
  });

  test('every module core/index.js declares actually loads', () => {
    for (const [name, mod] of Object.entries(core)) {
      assert.equal(typeof mod, 'object', `core.${name} is not a module`);
      assert.ok(Object.keys(mod).length, `core.${name} exports nothing`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * routing (P4-M-2) — Class G, model-aware orchestration's routing axis. `route()` is a pure function of
 * a task class, a capability register and an availability map the CALLER gathered; core/ never probes a
 * host (anti-drift item 36) and this module never reads a clock or an environment variable (item 38's
 * "no timing or exit code is an input", applied one level up). The one rule this file exists to prove
 * above the others: anti-drift item 54 — routing never puts hook-bearing work on a hookless provider,
 * even when the register rates another family `preferred` for the class.
 */
describe('routing (P4-M-2)', () => {
  const REGISTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'spine', 'reference', 'models', 'capability-register.json'), 'utf8'));
  const ALL_AVAILABLE = Object.fromEntries(REGISTER.families.map((f) => [f.id, { ok: true, why: 'test: reported available' }]));

  /** A minimal register shaped like the real one, with only the fields route() actually reads. */
  function miniRegister(models, { taskClasses = routing.TASK_CLASSES, families } = {}) {
    return {
      schemaVersion: '1.0.0',
      asOf: '2026-09-03',
      taskClasses,
      families: families || [
        { id: 'anthropic', promptingPractice: 'docs/reference/models/prompting-anthropic.md' },
        { id: 'openai', promptingPractice: 'docs/reference/models/prompting-openai.md' },
        { id: 'minimax', promptingPractice: 'docs/reference/models/prompting-minimax.md' },
      ],
      models,
    };
  }

  /** A model rated on "coding" only — every other test class it carries no opinion on. */
  const rated = (id, family, rating, status = 'current') => ({
    id, family, name: id, status,
    ratings: { coding: { rating, evidence: [], why: 'test fixture' } },
  });

  test('every task class routes on the real register with every family available', () => {
    for (const cls of routing.TASK_CLASSES) {
      const r = routing.route(cls, REGISTER, ALL_AVAILABLE);
      assert.ok(r.family, `${cls}: no family in the result`);
      assert.ok(routing.RATINGS.includes(r.rating), `${cls}: rating "${r.rating}" is not one of RATINGS`);
      assert.equal(r.asOf, REGISTER.asOf, `${cls}: asOf did not come from the register`);
      assert.ok(Array.isArray(r.alternatives), `${cls}: alternatives is not an array`);
      assert.deepEqual(r.skipped, [], `${cls}: a family was skipped even though every family reports available`);
      assert.ok(typeof r.practice === 'string' && r.practice.length > 0, `${cls}: no prompting practice named`);
    }
  });

  test('preferred beats capable', () => {
    const register = miniRegister([rated('m-capable', 'anthropic', 'capable'), rated('m-preferred', 'anthropic', 'preferred')]);
    const r = routing.route('coding', register, { anthropic: { ok: true, why: 'ok' } });
    assert.equal(r.model, 'm-preferred');
    assert.equal(r.rating, 'preferred');
  });

  test('an unavailable family is skipped with its reason, and the next candidate is chosen', () => {
    const register = miniRegister([rated('m-openai', 'openai', 'preferred'), rated('m-anthropic', 'anthropic', 'capable')]);
    const r = routing.route('coding', register, {
      anthropic: { ok: true, why: 'CLI signed in' },
      openai: { ok: false, why: 'codex CLI not signed in' },
      minimax: { ok: false, why: 'MINIMAX_API_KEY not set' },
    });
    assert.equal(r.family, 'anthropic');
    assert.equal(r.model, 'm-anthropic');
    assert.deepEqual(r.skipped, [
      { family: 'openai', why: 'codex CLI not signed in' },
      { family: 'minimax', why: 'MINIMAX_API_KEY not set' },
    ]);
  });

  test('⛔ requiresHooks never leaves HOOKED_FAMILY even when another family is preferred (anti-drift item 54)', () => {
    const register = miniRegister([rated('m-openai-preferred', 'openai', 'preferred'), rated('m-anthropic-capable', 'anthropic', 'capable')]);
    const avail = { anthropic: { ok: true, why: 'ok' }, openai: { ok: true, why: 'ok' }, minimax: { ok: true, why: 'ok' } };
    const r = routing.route('coding', register, avail, { requiresHooks: true });
    assert.equal(r.family, routing.HOOKED_FAMILY);
    assert.equal(r.model, 'm-anthropic-capable');
    assert.match(r.why, /requiresHooks/, 'the result does not say hooks restricted the candidate set');
  });

  test('⛔ prefer cannot pull a hooked session off HOOKED_FAMILY (anti-drift item 54)', () => {
    const register = miniRegister([rated('m-openai-preferred', 'openai', 'preferred'), rated('m-anthropic-capable', 'anthropic', 'capable')]);
    const avail = { anthropic: { ok: true, why: 'ok' }, openai: { ok: true, why: 'ok' }, minimax: { ok: true, why: 'ok' } };
    const r = routing.route('coding', register, avail, { requiresHooks: true, prefer: 'm-openai-preferred' });
    assert.equal(r.family, routing.HOOKED_FAMILY);
    assert.notEqual(r.model, 'm-openai-preferred', 'an explicit prefer pulled a hooked session onto a hookless family');
  });

  test('a restricted model is never chosen unless prefer names it', () => {
    const register = miniRegister([rated('m-restricted', 'anthropic', 'preferred', 'restricted'), rated('m-capable', 'anthropic', 'capable')]);
    const avail = { anthropic: { ok: true, why: 'ok' } };

    const withoutPrefer = routing.route('coding', register, avail);
    assert.equal(withoutPrefer.model, 'm-capable', 'the restricted model was ranked despite carrying the better rating');

    const withPrefer = routing.route('coding', register, avail, { prefer: 'm-restricted' });
    assert.equal(withPrefer.model, 'm-restricted');
  });

  test('prefer wins over a higher-rated candidate, and the result names it as the caller\'s choice', () => {
    const register = miniRegister([rated('m-preferred', 'anthropic', 'preferred'), rated('m-capable', 'anthropic', 'capable')]);
    const r = routing.route('coding', register, { anthropic: { ok: true, why: 'ok' } }, { prefer: 'm-capable' });
    assert.equal(r.model, 'm-capable');
    assert.match(r.why, /prefer/i);
    assert.match(r.why, /caller/i);
  });

  test('status: legacy loses to current at the same rating', () => {
    const register = miniRegister([rated('m-legacy', 'anthropic', 'preferred', 'legacy'), rated('m-current', 'anthropic', 'preferred', 'current')]);
    const r = routing.route('coding', register, { anthropic: { ok: true, why: 'ok' } });
    assert.equal(r.model, 'm-current');
  });

  test('the fallback when nothing is available, with the practice path named', () => {
    const register = miniRegister([rated('m1', 'anthropic', 'preferred')], {
      families: [{ id: 'anthropic', promptingPractice: 'docs/reference/models/prompting-anthropic.md' }],
    });
    const r = routing.route('coding', register, { anthropic: { ok: false, why: 'not signed in' } });
    assert.equal(r.family, routing.HOOKED_FAMILY);
    assert.equal(r.model, null);
    assert.equal(r.rating, 'unproven');
    assert.equal(r.why, 'no available model carries evidence for coding; the general prompting practice applies');
    assert.equal(r.practice, 'docs/reference/models/prompting-anthropic.md');
    assert.deepEqual(r.skipped, [{ family: 'anthropic', why: 'not signed in' }]);
  });

  test('the fallback when nothing is rated for the class', () => {
    const register = miniRegister(
      [{ id: 'm1', family: 'anthropic', name: 'm1', status: 'current', ratings: {} }],
      { families: [{ id: 'anthropic', promptingPractice: 'docs/reference/models/prompting-anthropic.md' }] },
    );
    const r = routing.route('writing', register, { anthropic: { ok: true, why: 'ok' } });
    assert.equal(r.model, null);
    assert.equal(r.rating, 'unproven');
    assert.equal(r.why, 'no available model carries evidence for writing; the general prompting practice applies');
  });

  test('a register not carrying the class in its vocabulary returns the fallback naming the gap', () => {
    const register = miniRegister([rated('m1', 'anthropic', 'preferred')], {
      taskClasses: routing.TASK_CLASSES.filter((c) => c !== 'coding'),
    });
    const r = routing.route('coding', register, { anthropic: { ok: true, why: 'ok' } });
    assert.equal(r.model, null);
    assert.equal(r.family, routing.HOOKED_FAMILY);
    assert.match(r.why, /does not carry "coding"/);
  });

  test('no register at all returns the fallback naming the gap', () => {
    const r = routing.route('coding', null, {});
    assert.equal(r.model, null);
    assert.equal(r.family, routing.HOOKED_FAMILY);
    assert.match(r.why, /no capability register was supplied/);
    assert.equal(r.asOf, null);
  });

  test('an unknown task class throws, not an outcome', () => {
    assert.throws(() => routing.route('not-a-real-class', REGISTER, ALL_AVAILABLE), /unknown task class/);
  });

  test('the result shape is a stable golden object for one hand-built case', () => {
    const register = miniRegister([rated('m-preferred', 'anthropic', 'preferred'), rated('m-capable', 'openai', 'capable')]);
    const r = routing.route('coding', register, {
      anthropic: { ok: true, why: 'signed in' },
      openai: { ok: true, why: 'signed in' },
      minimax: { ok: false, why: 'no key' },
    });
    assert.deepEqual(r, {
      family: 'anthropic',
      model: 'm-preferred',
      rating: 'preferred',
      why: 'm-preferred is preferred (current) for coding, the best-ranked available candidate.',
      asOf: '2026-09-03',
      practice: 'docs/reference/models/prompting-anthropic.md',
      alternatives: [{ family: 'openai', model: 'm-capable', rating: 'capable', why: 'm-capable is capable (current)' }],
      skipped: [{ family: 'minimax', why: 'no key' }],
    });
  });

  test('core/policy/routing.js is pure: no fs, child_process, process.env or Date reference in its source', () => {
    const text = fs.readFileSync(path.join(CORE, 'policy', 'routing.js'), 'utf8');
    for (const token of ["require('fs')", 'require("fs")', 'child_process', 'process.env', 'Date']) {
      assert.ok(!text.includes(token), `core/policy/routing.js references "${token}", which a pure policy module must not`);
    }
  });
});
