/*
 * RespawnPack · adapters/claude-code/sdk-supervisor/supervisor.test.mjs — the rollover loop, driven
 * offline against a fake process surface.
 *
 * ⛔ WHY OFFLINE IS THE BULK OF THE PROOF. The live canary in this environment cannot authenticate, so
 * a suite that only ran live would prove nothing at all. Instead the REAL protocol bytes — including
 * the captured failed compaction whose result envelope says `is_error:false, subtype:"success"` — are
 * replayed through the REAL supervisor and the REAL core state machine. The only thing faked is
 * `spawn`. Everything downstream of the first line of stdout is production code.
 *
 * ⛔ AND THE FAKE MUST BE ABLE TO FAIL. Each behaviour is asserted with its opposite beside it: a
 * boundary advances the cycle exactly once AND a redelivered boundary advances nothing; a verified
 * handoff permits the compaction AND an unverified one prevents the process from being spawned at all;
 * a PASS canary declares SUPPORTED AND today's real canary does not.
 *
 * Nothing here touches the repository's own .respawnpack/; every supervisor gets a temp projectDir.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

const { createSupervisor, STEP } = require_(path.join(HERE, 'supervisor.js'));
const stream = require_(path.join(HERE, 'stream.js'));
const caps = require_(path.join(HERE, 'capabilities.js'));
const cliLib = require_(path.join(HERE, 'cli.js'));
const core = require_(path.join(HERE, '..', '..', '..', 'core', 'index.js'));

const FIXTURES = path.join(HERE, 'fixtures');
const fixtureLines = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8').split('\n').filter((l) => l.length);

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-sup-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const SYNTH_SESSION = 'synth-0000-0000-0000-000000000001';
const CAPTURED_SESSION = '3b11b63e-fa6b-45de-89f9-04df1056e042';

// =================================================================================================
// The fake process surface. It simulates a host, not a transcript: context GROWS with each turn and
// SHRINKS when a compaction actually completes, so "three consecutive rollovers" is three real
// threshold crossings rather than three replays of one scripted answer.
// =================================================================================================

function turnLines({ sessionId, used, contextWindow = 200000, text = 'ok', seq }) {
  const id = (tag) => `${tag}-${String(seq).padStart(4, '0')}`;
  const modelUsage = contextWindow
    ? { 'claude-sonnet-4-5-20250929': { inputTokens: used, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.1, contextWindow, maxOutputTokens: 64000 } }
    : {};
  return [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: '/fake', session_id: sessionId, tools: [], mcp_servers: [], model: 'claude-sonnet-4-5-20250929', permissionMode: 'default', slash_commands: ['compact', 'clear', 'context'], apiKeySource: 'none', claude_code_version: '2.1.205', capabilities: ['interrupt_receipt_v1'], uuid: id('init') }),
    JSON.stringify({ type: 'assistant', message: { id: id('msg'), model: 'claude-sonnet-4-5-20250929', role: 'assistant', type: 'message', stop_reason: 'end_turn', usage: { input_tokens: used, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' }, content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: sessionId, uuid: id('asst') }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 100, duration_api_ms: 90, num_turns: 1, result: text, session_id: sessionId, total_cost_usd: 0.1, usage: { input_tokens: used, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20, service_tier: 'standard' }, modelUsage, permission_denials: [], uuid: id('res') }),
  ];
}

function compactSuccessLines({ sessionId, preTokens, postTokens, seq }) {
  const id = (tag) => `${tag}-${String(seq).padStart(4, '0')}`;
  return [
    JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId, uuid: id('st') }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: preTokens, post_tokens: postTokens, duration_ms: 8000 }, session_id: sessionId, uuid: id('bnd') }),
    JSON.stringify({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId, uuid: id('st2') }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 8100, duration_api_ms: 8000, num_turns: 1, result: 'Context compacted.', session_id: sessionId, total_cost_usd: 0.01, usage: { input_tokens: postTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10, service_tier: 'standard' }, modelUsage: {}, permission_denials: [], uuid: id('res') }),
  ];
}

/**
 * @param compact  'success' | string[] (fixture lines, replayed verbatim) | (n) => string[]
 */
function makeFakeCli({
  sessionId = SYNTH_SESSION,
  startTokens = 30000,
  growth = 50000,
  afterCompactTokens = 20000,
  contextWindow = 200000,
  compact = 'success',
  version = null,
  turnOverrides = null,
} = {}) {
  const calls = [];
  let used = startTokens;
  let seq = 0;
  let compactions = 0;

  const cli = {
    kind: 'fake',
    calls: () => calls,
    used: () => used,
    async runVersion(opts) {
      calls.push({ fn: 'runVersion', opts });
      return version || { ok: true, version: '2.1.205', versionLine: '2.1.205 (Claude Code)', stdout: '2.1.205 (Claude Code)\n', stderr: '', code: 0, exePath: 'C:/fake/claude.exe', exeSource: 'PATH', why: null };
    },
    async runTurn(opts) {
      seq += 1;
      calls.push({ fn: 'runTurn', opts, seq });
      const isCompact = opts.prompt === '/compact';
      let lines;
      if (isCompact) {
        compactions += 1;
        if (Array.isArray(compact)) lines = compact.slice();
        else if (typeof compact === 'function') lines = compact(compactions, { sessionId, used, seq });
        else {
          lines = compactSuccessLines({ sessionId, preTokens: used, postTokens: afterCompactTokens, seq });
          used = afterCompactTokens;
        }
      } else {
        // The prompt is echoed when it carries an injection nonce, which is how the canary — and the
        // test below — turn "we prepended a handoff" into "the model received it".
        const nonce = /RP-INJECT-[0-9a-f]{8,}/.exec(String(opts.prompt || ''));
        const text = nonce ? nonce[0] : 'ok';
        used = Math.min(contextWindow ? contextWindow - 1000 : 1e9, used + growth);
        lines = turnLines({ sessionId, used, contextWindow, text, seq });
      }
      const base = {
        ok: true, code: 0, signal: null, timedOut: false, spawnError: null,
        stdoutLines: lines, stdout: lines.join('\n'), stderr: '',
        argv: ['C:/fake/claude.exe', ...cliLib.buildTurnArgs(opts)], exePath: 'C:/fake/claude.exe', exeSource: 'fake',
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1,
      };
      return turnOverrides ? { ...base, ...turnOverrides(opts, seq) } : base;
    },
  };
  return cli;
}

function supervisorOn(projectDir, cli, extra = {}) {
  return createSupervisor({ projectDir, cli, env: {}, tools: '', ...extra });
}

/** Pad until the final threshold fires (bounded, so a broken measurement cannot loop forever). */
async function padToFinal(sup, max = 12) {
  for (let i = 0; i < max; i += 1) {
    const ts = sup.thresholdState();
    if (ts.evaluation.fire.includes('final')) return ts;
    await sup.turn({ prompt: `pad ${i}`, label: 'pad' });
  }
  throw new Error('the final threshold never fired within the padding budget');
}

// =================================================================================================
describe('construction', () => {
  test('projectDir is required — a supervisor never guesses which project it is rolling over', () => {
    assert.throws(() => createSupervisor({}), /projectDir is required/);
  });
});

// =================================================================================================
describe('three consecutive rollovers', () => {
  test('each one advances the cycle exactly once, verifies identity, and delivers the handoff', async () => {
    const dir = tmp('three');
    try {
      const cli = makeFakeCli({});
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start', label: 'first' });
      assert.equal(sup.sessionId(), SYNTH_SESSION);
      assert.equal(sup.machine().cycleIndex(), 0);

      const nonces = [];
      for (let i = 0; i < 3; i += 1) {
        await padToFinal(sup);
        const nonce = `RP-INJECT-${'abcdef01'}${i}${i}`;
        nonces.push(nonce);
        const r = await sup.rollover({
          handoffFields: { atomicActionId: `atomic-${i}`, exactNextAction: `Reply with exactly: ${nonce}`, userConstraints: ['no new dependencies'] },
          nextPrompt: 'continue the atomic action',
        });
        assert.equal(r.status, STEP.OK, `rollover ${i}: ${r.why || (r.failure && r.failure.detail)}`);
        assert.equal(r.rolled, true);
        assert.equal(r.cycleAfter.index, i + 1, `rollover ${i} did not advance the cycle exactly once`);
        assert.notEqual(r.cycleAfter.id, r.cycleBefore.id);
        assert.equal(r.identity.observedId, SYNTH_SESSION);
        assert.equal(r.compaction.verdict, 'COMPLETED');
        assert.equal(r.compaction.signal, 'compact_boundary');
        assert.equal(r.continuation.sent, true);
      }

      assert.equal(sup.machine().cycleIndex(), 3, 'three rollovers did not produce three cycles');
      assert.equal(sup.machine().state(), 'ACTIVE');
      assert.equal(sup.machine().halted(), null);
      assert.equal(sup.machine().counts().noops, 0, 'something was applied twice');

      // The journal is the record, and it was read back off disk.
      const applied = sup.machine().rows().filter((row) => row.kind === 'transition').map((row) => row.transition);
      const oneRollover = ['checkpoint', 'closeout', 'stage-handoff', 'verify-handoff', 'request-compact', 'observe-completion', 'verify-identity'];
      assert.deepEqual(applied, [...oneRollover, ...oneRollover, ...oneRollover]);

      // …and the model actually RECEIVED each handoff: the continuation prompt carried it, and the
      // fake echoed the nonce that only the handoff contained.
      const continues = cli.calls().filter((c) => c.fn === 'runTurn' && String(c.opts.prompt || '').includes('<respawnpack-handoff'));
      assert.equal(continues.length, 3);
      nonces.forEach((n, i) => {
        assert.ok(continues[i].opts.prompt.includes(n), `continuation ${i} did not carry the handoff's exactNextAction`);
        assert.ok(continues[i].opts.prompt.includes('no new dependencies'), 'the user constraints were not delivered');
        assert.ok(continues[i].opts.prompt.includes('continue the atomic action'), 'the caller\'s own prompt was dropped');
      });
    } finally { rm(dir); }
  });

  test('every compaction was requested against the SAME session id, with --resume', async () => {
    const dir = tmp('resume');
    try {
      const cli = makeFakeCli({});
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      await sup.rollover({ handoffFields: { exactNextAction: 'continue' }, nextPrompt: 'go' });

      const compactCalls = cli.calls().filter((c) => c.fn === 'runTurn' && c.opts.prompt === '/compact');
      assert.equal(compactCalls.length, 1);
      assert.equal(compactCalls[0].opts.sessionId, SYNTH_SESSION);
      const argv = cliLib.buildTurnArgs(compactCalls[0].opts);
      assert.ok(argv.includes('--resume'), 'the compaction was not dispatched into the existing conversation');
      assert.equal(argv[argv.indexOf('--resume') + 1], SYNTH_SESSION);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('the compaction is never requested without a verified handoff', () => {
  test('requestCompact from ACTIVE is REFUSED and NO process is spawned', async () => {
    const dir = tmp('unverified');
    try {
      const cli = makeFakeCli({});
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      assert.equal(sup.machine().state(), 'ACTIVE');

      const r = await sup.requestCompact();
      assert.equal(r.status, STEP.REFUSED);
      assert.equal(r.spawned, false, 'the /compact turn was spawned from a state the machine refused');
      assert.equal(r.failure.code, 'ILLEGAL_TRANSITION');
      assert.equal(cli.calls().filter((c) => c.opts && c.opts.prompt === '/compact').length, 0,
        'a compaction was requested of the host even though the machine refused the transition');
      assert.equal(sup.machine().state(), 'ACTIVE', 'a refusal moved the state');
    } finally { rm(dir); }
  });

  test('…and from HANDOFF_VERIFIED it is APPLIED and the process IS spawned (the control half)', async () => {
    const dir = tmp('verified');
    try {
      const cli = makeFakeCli({});
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      const ts = await padToFinal(sup);
      const boundary = sup.settleOrStop();
      const staged = sup.stageHandoff({ measurementRecord: ts.measurement.record, boundaryRecord: boundary.record, fields: { exactNextAction: 'x' } });
      assert.equal(staged.status, STEP.OK, staged.why);
      assert.equal(sup.machine().state(), 'HANDOFF_VERIFIED');

      const r = await sup.requestCompact();
      assert.equal(r.status, STEP.OK);
      assert.equal(r.spawned, true);
      assert.equal(cli.calls().filter((c) => c.opts && c.opts.prompt === '/compact').length, 1);
    } finally { rm(dir); }
  });

  test('a handoff whose bytes changed after verification is refused at consume time', async () => {
    const dir = tmp('tamper');
    try {
      const cli = makeFakeCli({});
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      const ts = await padToFinal(sup);
      const boundary = sup.settleOrStop();
      const staged = sup.stageHandoff({ measurementRecord: ts.measurement.record, boundaryRecord: boundary.record, fields: { exactNextAction: 'x' } });
      fs.appendFileSync(core.handoff.pathFor(sup.dir(), staged.handoff.handoffId), '\n');

      const injected = sup.injectHandoff({ handoffId: staged.handoff.handoffId });
      assert.equal(injected.status, STEP.REFUSED);
      assert.equal(injected.failure.code, 'HANDOFF_CHANGED_SINCE_VERIFICATION');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('the captured failure — a compaction that did not happen must not read as one', () => {
  test('the real failed-compact stream HALTS with COMPACT_REQUEST_REFUSED and carries compact_error', async () => {
    const dir = tmp('failed');
    try {
      const cli = makeFakeCli({ sessionId: CAPTURED_SESSION, compact: fixtureLines('captured/04-compact-attempt1.jsonl') });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });

      assert.equal(r.status, STEP.HALTED);
      assert.equal(r.rolled, false);
      assert.equal(r.failure.code, 'COMPACT_REQUEST_REFUSED');
      assert.equal(r.failure.outcome, 'FAIL');
      assert.match(r.compactError, /Failed to authenticate/);
      assert.equal(sup.machine().state(), 'HALTED');
      assert.equal(sup.machine().cycleIndex(), 0, 'a failed compaction advanced the context cycle');
      assert.match(r.failure.recovery, /verified handoff is still on disk and unconsumed/);
    } finally { rm(dir); }
  });

  test('the handoff is NOT consumed by a failed compaction, and stays consumable', async () => {
    const dir = tmp('failed-handoff');
    try {
      const cli = makeFakeCli({ sessionId: CAPTURED_SESSION, compact: fixtureLines('captured/04-compact-attempt1.jsonl') });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'the thing that was interrupted' }, nextPrompt: 'go' });
      assert.equal(r.status, STEP.HALTED);

      const pending = sup.pendingHandoff();
      assert.ok(pending, 'the verified handoff was cleared by a failure');
      const inspected = core.consumable.inspect(core.handoff.consumedPathFor(sup.dir(), pending.handoffId));
      assert.equal(inspected.status, 'FRESH', 'a failed compaction consumed the handoff');

      // It is still on disk, still verified, and a deliberate transfer can still claim it exactly once.
      const claimed = core.handoff.consume(sup.dir(), pending.handoffId, { consumerId: 'operator' });
      assert.equal(claimed.status, 'CONSUMED');
      assert.equal(claimed.handoff.exactNextAction, 'the thing that was interrupted');
    } finally { rm(dir); }
  });

  test('the verbatim stream is on disk, unmodified, and the halt points at it', async () => {
    const dir = tmp('verbatim');
    try {
      const captured = fixtureLines('captured/04-compact-attempt1.jsonl');
      const cli = makeFakeCli({ sessionId: CAPTURED_SESSION, compact: captured });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });

      assert.ok(r.turnFile, 'the halt does not say where the bytes are');
      const doc = readJSON(r.turnFile);
      assert.deepEqual(doc.lines, captured, 'the persisted turn is not the host\'s own bytes');
      assert.equal(doc.label, 'compact');
      assert.ok(r.failure.detail.includes(r.turnFile), 'the halt detail does not carry the path to the evidence');
      assert.ok(r.failure.detail.includes('is_error'), 'the halt does not record the envelope that disagreed');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('the other verdicts', () => {
  test('a no-op compaction returns to ACTIVE in the SAME cycle, with the latches still latched', async () => {
    const dir = tmp('noop');
    try {
      const cli = makeFakeCli({ compact: fixtureLines('synthetic/compact-noop.jsonl') });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const cycleBefore = sup.machine().cycleId();
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });

      assert.equal(r.status, STEP.NOOP);
      assert.equal(r.rolled, false);
      assert.equal(r.verdict.verdict, 'NOOP');
      assert.equal(r.verdict.hostResult, 'Not enough messages to compact.');
      assert.equal(sup.machine().state(), 'ACTIVE');
      assert.equal(sup.machine().cycleIndex(), 0, 'a declined compaction advanced the cycle');
      assert.equal(sup.machine().cycleId(), cycleBefore);
      assert.equal(sup.machine().halted(), null, 'a typed non-failure was treated as a failure');

      // The latches survive BECAUSE the cycle did not advance — the checkpoint does not re-fire
      // against a context that never got smaller.
      const l = sup.latches();
      assert.equal(l.rearmed, false, 'the latches re-armed after a compaction that did not happen');
      assert.deepEqual(Object.keys(l.record.latched).sort(), ['advisory', 'checkpoint', 'final']);

      // …and the handoff is untouched, so the next attempt must re-verify it.
      assert.ok(sup.pendingHandoff());
      assert.equal(core.consumable.inspect(core.handoff.consumedPathFor(sup.dir(), sup.pendingHandoff().handoffId)).status, 'FRESH');
    } finally { rm(dir); }
  });

  test('an identity change after compaction HALTS — a replacement session is not an in-place rollover', async () => {
    const dir = tmp('identity');
    try {
      const cli = makeFakeCli({ compact: fixtureLines('synthetic/compact-identity-changed.jsonl') });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });

      assert.equal(r.status, STEP.HALTED);
      assert.equal(r.failure.code, 'IDENTITY_MISMATCH');
      assert.equal(sup.machine().cycleIndex(), 0, 'the cycle advanced into a different conversation');
      assert.match(r.failure.recovery, /REPLACEMENT session/);
      assert.equal(core.consumable.inspect(core.handoff.consumedPathFor(sup.dir(), sup.pendingHandoff().handoffId)).status, 'FRESH',
        'the handoff was delivered into a conversation that is not the one it belongs to');
    } finally { rm(dir); }
  });

  test('contradictory signals are CANNOT_DETERMINE, not a completion', async () => {
    const dir = tmp('contradictory');
    try {
      const cli = makeFakeCli({ compact: fixtureLines('synthetic/compact-contradictory.jsonl') });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });

      assert.equal(r.status, STEP.HALTED);
      assert.equal(r.failure.code, 'COMPLETION_UNOBSERVED');
      assert.equal(r.failure.outcome, 'CANNOT_DETERMINE');
      assert.equal(sup.machine().cycleIndex(), 0);
    } finally { rm(dir); }
  });

  test('a silent stream is COMPLETION_UNOBSERVED even though its envelope says success', async () => {
    const dir = tmp('silent');
    try {
      const cli = makeFakeCli({ compact: fixtureLines('synthetic/compact-unobserved.jsonl') });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });
      assert.equal(r.status, STEP.HALTED);
      assert.equal(r.failure.code, 'COMPLETION_UNOBSERVED');
      assert.match(r.failure.recovery, /NOT evidence that compaction failed and NOT evidence that it succeeded/);
    } finally { rm(dir); }
  });

  test('a KILLED compaction turn is never a completion — the clock is not a boundary', async () => {
    const dir = tmp('timeout');
    try {
      const cli = makeFakeCli({
        compact: [],
        turnOverrides: (opts) => (opts.prompt === '/compact' ? { ok: false, code: null, signal: 'SIGTERM', timedOut: true, stdoutLines: [] } : {}),
      });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });
      assert.equal(r.status, STEP.HALTED);
      assert.equal(r.failure.code, 'COMPLETION_UNOBSERVED');
      assert.equal(r.verdict.reason, 'stream-closed');
      assert.equal(sup.machine().cycleIndex(), 0);
    } finally { rm(dir); }
  });

  test('a redelivered boundary is a NOOP — nothing advances twice', async () => {
    const dir = tmp('dup');
    try {
      const cli = makeFakeCli({ compact: fixtureLines('synthetic/compact-duplicate-boundary.jsonl') });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });
      assert.equal(r.status, STEP.OK);
      assert.equal(sup.machine().cycleIndex(), 1, 'a stream carrying the boundary twice advanced the cycle twice');

      // Now hand the SAME completion back, as a redelivery would. The observation is rebuilt from the
      // bytes this supervisor persisted, which also shows the turn record is enough to re-derive a
      // verdict without re-running anything.
      const compactTurn = sup.turns().find((t) => t.label === 'compact');
      const replayed = stream.observe(readJSON(compactTurn.file).lines);
      assert.equal(stream.compactVerdict(replayed, {}).verdict, 'COMPLETED');

      const again = sup.observeCompact({ observation: replayed, waitedMs: 10, expectedSessionId: SYNTH_SESSION });
      assert.equal(again.status, STEP.NOOP);
      assert.equal(again.noopKind, 'duplicate-event');
      assert.equal(sup.machine().cycleIndex(), 1, 'a redelivered completion advanced the cycle');
      assert.ok(sup.machine().counts().noops >= 1, 'the duplicate was not recorded as a no-op');

      // Control: the CONTINUATION turn is a different occurrence with no boundary at all, and it must
      // not be read as a redelivery of anything.
      const after = sup.observeCompact({ observation: sup.lastObservation(), waitedMs: 10, expectedSessionId: SYNTH_SESSION });
      assert.equal(after.status, STEP.HALTED);
      assert.equal(after.failure.code, 'COMPLETION_UNOBSERVED');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('settleOrStop — a boundary is the host\'s own result message', () => {
  test('a killed turn yields no boundary record', async () => {
    const dir = tmp('settle-killed');
    try {
      const cli = makeFakeCli({ turnOverrides: () => ({ timedOut: true, ok: false, code: null }) });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      const s = sup.settleOrStop();
      assert.equal(s.status, STEP.CANNOT_DETERMINE);
      assert.equal(s.settled, false);
      assert.match(s.why, /killed/);
    } finally { rm(dir); }
  });

  test('a turn with no result message yields no boundary record', async () => {
    const dir = tmp('settle-noresult');
    try {
      const cli = makeFakeCli({ turnOverrides: () => ({ stdoutLines: [JSON.stringify({ type: 'system', subtype: 'init', session_id: SYNTH_SESSION, slash_commands: ['compact'], uuid: 'i' })] }) });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      const s = sup.settleOrStop();
      assert.equal(s.settled, false);
      assert.match(s.why, /no result message/);
    } finally { rm(dir); }
  });

  test('a resumed turn that answers from a DIFFERENT conversation is a fork, and yields no boundary', async () => {
    const dir = tmp('settle-fork');
    try {
      let n = 0;
      const cli = makeFakeCli({
        turnOverrides: (opts, seq) => {
          n += 1;
          // The second turn answers from another session id — what --fork-session would produce, and
          // what a supervisor that never compared would never notice.
          return n === 2 ? { stdoutLines: turnLines({ sessionId: 'forked-session-0002', used: 40000, seq, text: 'ok' }) } : {};
        },
      });
      const sup = supervisorOn(dir, cli);
      await sup.turn({ prompt: 'start' });
      const t2 = await sup.turn({ prompt: 'second' });

      assert.ok(t2.identityDrift, 'a forked answer was not noticed');
      assert.equal(t2.identityDrift.expected, SYNTH_SESSION);
      assert.equal(t2.identityDrift.observed, 'forked-session-0002');
      const s = sup.settleOrStop();
      assert.equal(s.settled, false);
      assert.match(s.why, /fork, not a boundary/);
    } finally { rm(dir); }
  });

  test('a completed turn yields a boundary record carrying the verbatim result line (the control half)', async () => {
    const dir = tmp('settle-ok');
    try {
      const cli = makeFakeCli({});
      const sup = supervisorOn(dir, cli);
      const t = await sup.turn({ prompt: 'start' });
      const s = sup.settleOrStop();
      assert.equal(s.settled, true);
      assert.equal(s.record.mechanism, 'headless-turn-result');
      assert.equal(s.record.raw, t.turn.stdoutLines[t.turn.stdoutLines.length - 1]);
      assert.equal(core.evidence.validate(s.record).ok, true);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('exactly once', () => {
  test('a crash after verification leaves the handoff consumable — exactly once, by whoever gets there first', async () => {
    const dir = tmp('crash');
    try {
      const cli = makeFakeCli({});
      const sup1 = supervisorOn(dir, cli, { consumerId: 'supervisor-1' });
      await sup1.turn({ prompt: 'start' });
      const ts = await padToFinal(sup1);
      const boundary = sup1.settleOrStop();
      const staged = sup1.stageHandoff({ measurementRecord: ts.measurement.record, boundaryRecord: boundary.record, fields: { exactNextAction: 'resume the interrupted thing' } });
      assert.equal(staged.status, STEP.OK);

      // …crash. A brand-new supervisor over the same project and the same conversation.
      const sup2 = supervisorOn(dir, makeFakeCli({}), { consumerId: 'supervisor-2' });
      const attached = sup2.attach(SYNTH_SESSION);
      assert.equal(attached.status, STEP.OK);
      assert.equal(attached.opened.restored, true, 'the machine did not restore from the journal');
      assert.equal(sup2.machine().state(), 'HANDOFF_VERIFIED', 'the restored machine forgot that its handoff was verified');
      assert.equal(sup2.machine().verifiedHandoff().handoffId, staged.handoff.handoffId);

      const first = sup2.injectHandoff({ handoffId: staged.handoff.handoffId, nextPrompt: 'go' });
      assert.equal(first.status, STEP.OK);
      assert.equal(first.consumed, true);
      assert.ok(first.prompt.includes('resume the interrupted thing'));

      // A third arrival — and the original supervisor — both learn who got there first.
      const sup3 = supervisorOn(dir, makeFakeCli({}), { consumerId: 'supervisor-3' });
      sup3.attach(SYNTH_SESSION);
      const second = sup3.injectHandoff({ handoffId: staged.handoff.handoffId, nextPrompt: 'go' });
      assert.equal(second.status, STEP.NOOP);
      assert.equal(second.alreadyConsumed, true);
      assert.equal(second.firstConsumption.consumerId, 'supervisor-2');

      const third = sup1.injectHandoff({ handoffId: staged.handoff.handoffId, nextPrompt: 'go' });
      assert.equal(third.status, STEP.NOOP);
      assert.equal(third.firstConsumption.consumerId, 'supervisor-2');
    } finally { rm(dir); }
  });

  test('the continuation is sent once per cycle, and a second supervisor will not repeat it', async () => {
    const dir = tmp('continue');
    try {
      const cli = makeFakeCli({});
      const sup = supervisorOn(dir, cli, { consumerId: 'supervisor-1' });
      await sup.turn({ prompt: 'start' });
      await padToFinal(sup);
      const r = await sup.rollover({ handoffFields: { exactNextAction: 'x' }, nextPrompt: 'go' });
      assert.equal(r.continuation.sent, true);

      const before = cli.calls().filter((c) => c.fn === 'runTurn').length;
      const again = await sup.continueOnce({ prompt: 'go again' });
      assert.equal(again.status, STEP.NOOP);
      assert.equal(again.sent, false);
      assert.equal(cli.calls().filter((c) => c.fn === 'runTurn').length, before, 'a duplicate continuation reached the host');
      assert.equal(again.firstConsumption.consumerId, 'supervisor-1');

      // A NEW cycle gets its own continuation — the receipt is keyed on the cycle, not the session.
      await padToFinal(sup);
      const r2 = await sup.rollover({ handoffFields: { exactNextAction: 'y' }, nextPrompt: 'go' });
      assert.equal(r2.continuation.sent, true, 'the second cycle\'s continuation was suppressed as a duplicate of the first');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('the turn record', () => {
  test('every turn is on disk with the host\'s lines verbatim, before anything interprets them', async () => {
    const dir = tmp('turns');
    try {
      const cli = makeFakeCli({});
      const sup = supervisorOn(dir, cli);
      const t1 = await sup.turn({ prompt: 'start', label: 'first' });
      const t2 = await sup.turn({ prompt: 'second' });

      const files = fs.readdirSync(path.join(sup.dir(), 'turns')).sort();
      assert.deepEqual(files, ['turn-001.json', 'turn-002.json']);
      const doc1 = readJSON(path.join(sup.dir(), 'turns', 'turn-001.json'));
      assert.deepEqual(doc1.lines, t1.turn.stdoutLines);
      assert.equal(doc1.label, 'first');
      assert.equal(doc1.sessionId, SYNTH_SESSION);
      assert.ok(doc1.argv.includes('stream-json'));
      // The prompt itself is recorded by DIGEST, not verbatim: a turn record is an evidence artefact,
      // and a handoff-carrying prompt would put the whole context back on disk a second time.
      assert.equal(doc1.promptDigest, core.io.digest('start'));
      assert.equal(readJSON(path.join(sup.dir(), 'turns', 'turn-002.json')).lines.length, t2.turn.stdoutLines.length);
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('probe', () => {
  test('the captured auth failure is CANNOT_DETERMINE, and the structural facts survive it', async () => {
    const dir = tmp('probe-auth');
    try {
      const cli = makeFakeCli({ sessionId: CAPTURED_SESSION, turnOverrides: () => ({ stdoutLines: fixtureLines('captured/01-baseline.jsonl') }) });
      const sup = supervisorOn(dir, cli);
      const p = await sup.probe();
      assert.equal(p.outcome, 'CANNOT_DETERMINE');
      assert.equal(p.installed, true);
      assert.equal(p.authenticated, false);
      assert.equal(p.version, '2.1.205');
      assert.equal(p.structural.initSeen, true);
      assert.equal(p.structural.compactCommandPresent, true, 'the slash-command enumeration was lost with the auth failure');
      assert.equal(p.structural.claudeCodeVersion, '2.1.223');
      assert.match(p.verbatim.authMessage, /OAuth session expired/);
      assert.match(p.ownerAction, /\/login/);
      assert.ok(p.verbatim.lines.length, 'the probe kept none of the host\'s bytes');
    } finally { rm(dir); }
  });

  test('a healthy host PASSES (the control half)', async () => {
    const dir = tmp('probe-ok');
    try {
      const sup = supervisorOn(dir, makeFakeCli({}));
      const p = await sup.probe();
      assert.equal(p.outcome, 'PASS');
      assert.equal(p.authenticated, true);
      assert.equal(p.structural.compactCommandPresent, true);
    } finally { rm(dir); }
  });

  test('a host with no "compact" command FAILS — there is no documented mechanism to request one', async () => {
    const dir = tmp('probe-nocompact');
    try {
      const cli = makeFakeCli({
        turnOverrides: () => ({
          stdoutLines: [
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['clear', 'model'], claude_code_version: '9.9.9', uuid: 'i' }),
            JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', uuid: 'r' }),
          ],
        }),
      });
      const sup = supervisorOn(dir, cli);
      const p = await sup.probe();
      assert.equal(p.outcome, 'FAIL');
      assert.match(p.why, /"compact" is not among them/);
    } finally { rm(dir); }
  });

  test('a missing executable is reported as NOT INSTALLED, which is a different owner action', async () => {
    const dir = tmp('probe-missing');
    try {
      const cli = makeFakeCli({ version: { ok: false, version: null, stdout: '', stderr: '', exePath: null, why: 'no `claude` executable was found on PATH', searched: ['a', 'b'] } });
      const sup = supervisorOn(dir, cli);
      const p = await sup.probe();
      assert.equal(p.outcome, 'CANNOT_DETERMINE');
      assert.equal(p.installed, false);
      assert.match(p.ownerAction, /Install Claude Code|RESPAWNPACK_CLAUDE_PATH/);
    } finally { rm(dir); }
  });
});

// =================================================================================================
// P1-CT-5 — a nonexistent `cwd` must not collapse into the same diagnosis as a missing executable.
//
// ⛔ WHY THIS DRIVES THE REAL cli.js, NOT THE FAKE. The bug is an OS-level fact: on Windows, spawning
// with a `cwd` that does not exist fails with errno -4058 (ENOENT) — the SAME code a genuinely
// missing executable produces — so `runVersion`'s unguarded `why` read "claude --version exited
// -4058" and `runTurn`'s `spawnError` read "ENOENT: spawn <exePath> ENOENT", both blaming the
// executable. The fake `cli` used everywhere else in this file never reaches real spawn(), so it
// cannot see this collapse — only the real module can.
//
// `process.execPath` stands in for `claudePath`: it is a real, resolvable file (so
// resolveExecutable succeeds and the test isolates the cwd check), and it is never actually spawned
// — a refused cwd short-circuits before spawn() is reached either way.
describe('cli.js — runVersion/runTurn refuse a bad cwd before spawning', () => {
  const fakeExe = process.execPath;

  test('a nonexistent cwd is refused up front, naming the DIRECTORY — not the executable', async () => {
    const missing = path.join(os.tmpdir(), `rp-p1ct5-missing-${process.pid}-${Date.now()}`);
    assert.equal(fs.existsSync(missing), false, 'the fixture path must not exist for this test to mean anything');

    const v = await cliLib.runVersion({ claudePath: fakeExe, cwd: missing, timeoutMs: 5000 });
    assert.equal(v.ok, false);
    assert.match(v.why, /the project directory does not exist/);
    assert.ok(v.why.includes(missing), 'the message names the missing directory');
    assert.doesNotMatch(v.why, /-4058|ENOENT|did not answer/, 'the old ENOENT-collapsed wording must be gone');

    const t = await cliLib.runTurn({ claudePath: fakeExe, cwd: missing, prompt: 'hi', timeoutMs: 5000 });
    assert.equal(t.ok, false);
    assert.match(t.spawnError, /the project directory does not exist/);
    assert.ok(t.spawnError.includes(missing), 'the message names the missing directory');
    assert.doesNotMatch(t.spawnError, /-4058|ENOENT/, 'the old ENOENT-collapsed wording must be gone');
  });

  test('a cwd that exists but is a FILE, not a directory, is refused the same way', async () => {
    const dir = tmp('p1ct5-file-cwd');
    const filePath = path.join(dir, 'not-a-directory.txt');
    try {
      fs.writeFileSync(filePath, 'x');
      const v = await cliLib.runVersion({ claudePath: fakeExe, cwd: filePath, timeoutMs: 5000 });
      assert.equal(v.ok, false);
      assert.match(v.why, /the project directory is not a directory/);
      assert.ok(v.why.includes(filePath), 'the message names the offending path');

      const t = await cliLib.runTurn({ claudePath: fakeExe, cwd: filePath, prompt: 'hi', timeoutMs: 5000 });
      assert.equal(t.ok, false);
      assert.match(t.spawnError, /the project directory is not a directory/);
    } finally { rm(dir); }
  });
});

// =================================================================================================
// P1-N-2 — probe()'s ownerAction must CONSUME cli.js's own cwd diagnosis (d669844's `checkCwd`),
// not recompose its own executable-oriented advice off `version.exePath` alone.
//
// ⛔ WHY THIS KEYS ON checkCwd, NOT ON version.why TEXT. d669844 exported `checkCwd` from cli.js for
// exactly this: the SAME pure fs.statSync check runVersion/runTurn already ran, callable again by a
// caller that needs to know whether the cwd — not the executable — was the reason a version check
// failed. Pattern-matching `version.why` would work today but re-couples this file to wording cli.js
// is free to change; keying on `cliLib.checkCwd(...).ok` cannot drift from it, because it IS it.
//
// `process.execPath` stands in for `claudePath` exactly as in the P1-CT-5 block above: a real,
// resolvable file, so `resolveExecutable` succeeds and the only way `version.ok` is still false is
// the cwd check this task makes probe() consume.
describe('probe() ownerAction — consumes cli.js\'s cwd diagnosis instead of blaming the executable', () => {
  test('a nonexistent cwd: ownerAction names the DIRECTORY, not the executable', async () => {
    const dir = tmp('p1n2-missing-cwd');
    const missing = path.join(os.tmpdir(), `rp-p1n2-missing-${process.pid}-${Date.now()}`);
    assert.equal(fs.existsSync(missing), false, 'the fixture path must not exist for this test to mean anything');
    try {
      const sup = createSupervisor({ projectDir: dir, claudePath: process.execPath, env: {}, tools: '' });
      const p = await sup.probe({ handshake: false, probeCwd: missing });
      assert.equal(p.outcome, 'CANNOT_DETERMINE');
      assert.equal(p.installed, true, 'the executable resolved fine — this must not read as "not installed"');
      assert.match(p.ownerAction, /the project directory does not exist/);
      assert.ok(p.ownerAction.includes(missing), 'the owner action names the missing directory');
      assert.doesNotMatch(p.ownerAction, /did not answer|run it by hand/i, 'the executable-blaming wording must be gone once the real cause is the directory');
    } finally { rm(dir); }
  });

  test('nearest bypass — a genuinely missing executable (cwd is fine) keeps the existing advice, unchanged', async () => {
    const dir = tmp('p1n2-missing-exe');
    try {
      const cli = makeFakeCli({
        version: { ok: false, version: null, stdout: '', stderr: '', exePath: null, why: 'no `claude` executable was found on PATH', searched: ['a', 'b'] },
      });
      const sup = supervisorOn(dir, cli);
      const p = await sup.probe();
      assert.equal(p.installed, false);
      assert.equal(p.ownerAction, 'Install Claude Code, or point RESPAWNPACK_CLAUDE_PATH at the executable.', 'unrelated to the cwd fix — must stay byte-for-byte');
    } finally { rm(dir); }
  });

  test('nearest bypass — a successful probe carries no ownerAction at all', async () => {
    const dir = tmp('p1n2-probe-ok');
    try {
      const sup = supervisorOn(dir, makeFakeCli({}));
      const p = await sup.probe();
      assert.equal(p.outcome, 'PASS');
      assert.equal('ownerAction' in p, false, 'a successful probe carries nothing for an operator to act on');
    } finally { rm(dir); }
  });
});

// =================================================================================================
describe('capability declarations — the canary, not the target', () => {
  const authCanary = caps.canaryFromProbe({
    outcome: 'CANNOT_DETERMINE',
    why: 'the host answered an authentication failure',
    version: '2.1.205',
    exePath: 'C:/fake/claude.exe',
    structural: { initSeen: true, compactCommandPresent: true },
    verbatim: { authMessage: 'Not logged in · Please run /login', stderr: '', lines: ['{"type":"system"}'] },
  });

  test('today\'s canary downgrades every capability to CANNOT_DETERMINE, and says why in the host\'s words', () => {
    const m = caps.matrix(authCanary);
    assert.equal(m.profile, 'claude-code/sdk-supervisor');
    assert.equal(m.rolloverCapable, false);
    assert.equal(m.unmet.length, 7, 'a capability was claimed on a canary that did not pass');
    for (const d of m.declarations) {
      assert.equal(d.support, 'CANNOT_DETERMINE', `${d.capability} was declared ${d.support}`);
      assert.match(d.why, /did not pass|no activation canary/);
      assert.ok(d.mechanism, `${d.capability} declares no mechanism`);
      assert.match(d.why, /a target is not an observation/);
    }
    assert.equal(m.outcome, 'CANNOT_DETERMINE');
    assert.deepEqual(m.undeclared, []);
  });

  test('a PASSING canary declares the target support (the control half — the rule can say yes)', () => {
    const passing = { ran: true, kind: 'claude-code-sdk-supervisor-activation', observedAt: new Date().toISOString(), outcome: 'PASS', raw: '{"boundary":"observed"}' };
    const m = caps.matrix(passing);
    assert.equal(m.rolloverCapable, true, 'a passing canary still could not produce a capable profile');
    assert.deepEqual(m.unmet, []);
    const byCap = Object.fromEntries(m.declarations.map((d) => [d.capability, d]));
    assert.equal(byCap.requestCompact.support, 'SUPPORTED');
    assert.equal(byCap.measureContext.support, 'SUPPORTED_WITH_LIMITATIONS');
    assert.ok(byCap.measureContext.limitations.length, 'a hedge with no named limitation is a SUPPORTED claim in disguise');
    assert.equal(byCap.measureContext.downgraded, false);
  });

  test('THE GAP CORE NOW CLOSES: a canary\'s VERDICT is read, and this adapter no longer compensates', () => {
    /*
     * This test used to pin the gap: handed straight to core, a well-formed record of a FAILED run
     * produced a SUPPORTED declaration, because `canaryUsable` reads shape and nothing read the verdict.
     * This adapter compensated by never forwarding a non-PASS canary — and so did the interactive
     * profile, the Codex app-server profile and the Pi profile, four files solving one missing rule.
     * W6a moved the rule into `declare()`; what this pins now is the FIX, from both directions.
     */
    // 1. Core refuses it DIRECTLY. Nothing in this adapter is involved in the refusal any more.
    const direct = core.capabilities.declare({ capability: 'requestCompact', support: 'SUPPORTED', canary: authCanary, mechanism: 'x' });
    assert.equal(direct.support, 'CANNOT_DETERMINE', 'core accepted a canary that recorded a failed run as proof of a working capability');
    assert.equal(direct.declaredSupport, 'SUPPORTED', 'the refused claim must stay visible on the declaration');
    assert.match(direct.why, /CANNOT_DETERMINE/, 'the downgrade does not name the verdict the canary actually recorded');

    // 2. The SHAPE gate still passes on this same record — which is why shape alone was never enough,
    //    and what makes the refusal above a verdict check rather than a re-run of the shape check.
    assert.equal(core.capabilities.canaryUsable(authCanary).ok, true);

    // 3. And this profile's own path agrees, now by delegation rather than by a guard of its own: the
    //    declaration is core's downgrade, enriched with the target and the offline proof.
    const mine = caps.declareOne('requestCompact', authCanary);
    assert.equal(mine.support, 'CANNOT_DETERMINE');
    assert.equal(mine.downgraded, true, 'the adapter is still short-circuiting instead of letting core downgrade the claim');
    assert.match(mine.why, /authentication failure/, 'the host\'s own words no longer travel with the refusal');
    assert.match(mine.why, /Proven offline against fixtures/);
  });

  test('the plan is recorded and is never a declaration', () => {
    for (const [cap, t] of Object.entries(caps.TARGET)) {
      assert.ok(core.capabilities.CAPABILITIES.includes(cap), `${cap} is not one of core's seven`);
      assert.ok(t.support && t.mechanism, `${cap}'s target is incomplete`);
    }
    assert.equal(Object.keys(caps.TARGET).length, core.capabilities.CAPABILITIES.length,
      'a capability has no recorded target, so the matrix would have no denominator for it');
    // core's own refusal, restated for this profile: a plan cannot be promoted.
    const fromPlan = core.capabilities.fromPlan('claude-code/sdk-supervisor', 'requestCompact');
    assert.equal(fromPlan.support, 'CANNOT_DETERMINE');
  });

  test('a canary with no verbatim payload is refused even when it claims to have passed', () => {
    const hollow = { ran: true, kind: 'activation', observedAt: new Date().toISOString(), outcome: 'PASS', raw: '' };
    const d = caps.declareOne('requestCompact', hollow);
    assert.equal(d.support, 'CANNOT_DETERMINE');
    assert.equal(d.downgraded, true);
    assert.match(d.why, /verbatim/);
  });
});
