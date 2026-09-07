/*
 * RespawnPack · adapters/codex/app-server/supervisor.test.mjs — the managed rollover, driven over a
 * fake transport that replays CAPTURED bytes.
 *
 * ⭐ WHAT THE FAKE REPLACES AND WHAT IT DOES NOT. It replaces the child process and nothing else: the
 * supervisor under test is the real one, the core machine is the real one, the journal and the receipts
 * are real files on disk, and the notification payloads are the ones `codex app-server` actually emitted
 * (fixtures/captured/). What is invented is invented deliberately, labelled synthetic in the manifest,
 * and stated as proving the READER — a compaction that never completed, an item redelivered, a threadId
 * that changed. Those inputs have to be answerable whether or not this host ever produces them.
 *
 * ⛔ AND EVERY REFUSAL IS PAIRED WITH THE ACCEPTANCE IT MUST BE DISTINGUISHED FROM. A check that halts
 * on an identity mismatch proves nothing unless the matching case passes through it; a capability rule
 * that always answers CANNOT_DETERMINE has not been shown to discriminate. Both halves are here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const core = require_(path.join(HERE, '..', '..', '..', 'core', 'index.js'));
const { createSupervisor, STEP, HOST, COMPACT_METHOD, isPersistedItemId, LATEST_HANDOFF_POINTER } = require_(path.join(HERE, 'supervisor.js'));
const caps = require_(path.join(HERE, 'capabilities.js'));
const shared = require_(path.join(HERE, '..', 'hooks', '_shared.js'));

const FIXTURES = path.join(HERE, 'fixtures');
const HOOKS_DIR = path.join(HERE, '..', 'hooks');
const { OUTCOME } = core.failures;
const { SUPPORT } = core.capabilities;

const readLines = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8').split(/\n/).filter(Boolean);
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-codex-sup-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };

const RESPONSES = readJSON('captured/04-responses.json');
const THREAD_ID = '019fd7a6-5e6b-72e2-908a-4f7d7201685d';
const TURN_ID = '019fd7a6-6044-7aa2-b0f9-e6e58a7f0c3e';
const COMPACT_LINES = readLines('captured/02-compaction.jsonl');
const TURN_LINES = readLines('captured/01-turn-lifecycle.jsonl');

// --- a fake transport ------------------------------------------------------------------------------
// It implements exactly the surface rpc.createConnection exposes to supervisor.js, and nothing more —
// so a supervisor that started using a new transport method would fail here rather than silently work
// in the tests and not in production.

function makeFakeConn(plan = {}) {
  const notifications = [];
  const listeners = new Set();
  const sent = [];
  let seq = 0;
  const conn = {
    sent, plan,
    async send(method, params, opts = {}) {
      sent.push({ method, params, opts });
      const spec = (plan.responses || {})[method];
      const emit = (plan.afterRequest || {})[method];
      const push = (lines) => { for (const raw of (typeof lines === 'function' ? lines(params) : lines) || []) pushNote(raw); };
      if (emit) push(emit);
      if (!spec) return { ok: false, kind: 'ERROR', id: seq += 1, detail: `no fake response for ${method}`, error: { code: -32601, message: 'no plan' } };
      if (typeof spec === 'function') return spec(params, opts);
      if (spec.error) return { ok: false, kind: 'ERROR', id: seq += 1, error: spec.error, detail: spec.error.message, raw: JSON.stringify({ id: seq, error: spec.error }) };
      if (spec.timeout) return { ok: false, kind: 'TIMEOUT', id: seq += 1, detail: 'no answer — an observation of a clock', waitedMs: opts.timeoutMs || 0 };
      const raw = JSON.stringify({ id: seq += 1, result: spec.result === undefined ? {} : spec.result });
      return { ok: true, id: seq, result: spec.result === undefined ? {} : spec.result, raw };
    },
    waitFor(predicate, { timeoutMs = 0, label = '', from = 0 } = {}) {
      const hit = notifications.slice(from).find((n) => { try { return predicate(n); } catch { return false; } });
      if (hit) return Promise.resolve({ ok: true, note: hit, fromBuffer: true });
      return Promise.resolve({ ok: false, kind: 'TIMEOUT', waitedMs: timeoutMs, detail: `${label} did not arrive within ${timeoutMs}ms — nothing about that is evidence of what the host did` });
    },
    since: (cursor) => notifications.slice(cursor),
    notificationCount: () => notifications.length,
    notifications: () => notifications.slice(),
    serverRequests: () => plan.serverRequests || [],
    approvalHalt: () => plan.approvalHalt || null,
    events: () => [], eventCount: () => 0, unparsed: () => [], tornTail: () => null,
    exit: () => null, stderr: () => '', closed: () => false, close() {}, rawLogPath: null,
    push: pushNote,
  };
  function pushNote(raw) {
    let params = null; let method = null;
    try { const o = JSON.parse(raw); method = o.method; params = o.params; } catch { /* a hostile line, kept */ }
    const note = { seq: notifications.length, method, params, raw, at: new Date().toISOString() };
    notifications.push(note);
    for (const fn of [...listeners]) fn(note);
  }
  return conn;
}

/** Notification lines for one ordinary turn, shaped exactly like the captured ones. */
function turnLines({ threadId = THREAD_ID, turnId, text = 'OK', inputTokens = 15703, window = 258400, status = 'completed' }) {
  return [
    JSON.stringify({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } }),
    JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1786029432, completedAt: null, durationMs: null } } }),
    JSON.stringify({ method: 'item/started', params: { item: { type: 'agentMessage', id: `msg_${turnId}`, text: '', phase: 'final_answer' }, threadId, turnId } }),
    JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', id: `msg_${turnId}`, text, phase: 'final_answer' }, threadId, turnId } }),
    JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { totalTokens: inputTokens + 5, inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }, last: { totalTokens: inputTokens + 5, inputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }, modelContextWindow: window } } }),
    JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [{ type: 'agentMessage', id: `msg_${turnId}`, text, phase: 'final_answer' }], itemsView: 'summary', status, error: null, startedAt: 1786029432, completedAt: 1786029436, durationMs: 3285 } } }),
  ];
}

/** A supervisor wired to a fake connection, with the machine already attached to THREAD_ID. */
async function supWith(plan, options = {}) {
  const projectDir = options.projectDir || tmp('run');
  const conn = makeFakeConn(plan);
  const sup = createSupervisor({
    projectDir, cwd: projectDir,
    // The REAL probe path runs: it resolves this script, reads its version through it, and only then
    // hands over to the injected transport. A fake that could not answer --version would make probe()
    // fail before anything under test ran.
    codexJs: path.join(FIXTURES, 'fake-app-server.js'),
    contextWindowTokens: options.contextWindowTokens ?? null,
    connect: async () => ({ ok: true, conn, initialize: JSON.parse(RESPONSES.initialize).result, raw: RESPONSES.initialize }),
    ...options.supervisor,
  });
  const probe = await sup.probe({ regenerateSchema: false });
  // Asserted HERE rather than left to surface as "no conversation is attached" twenty tests later: a
  // harness whose setup failed silently makes every downstream failure a lie about what broke.
  assert.equal(probe.outcome, OUTCOME.PASS, `the fake probe did not pass: ${probe.why}`);
  assert.equal(probe.authenticated, null, 'a handshake that runs before credentials are used must never report authentication');
  return { sup, conn, projectDir, probe };
}

const threadStartResult = JSON.parse(RESPONSES.threadStart).result;
const turnStartResultFor = (turnId) => ({ turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } });
const resumeResult = (approvalPolicy = 'never') => ({ thread: { id: THREAD_ID, sessionId: THREAD_ID }, approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false } });

const BASE_PLAN = (turnId = TURN_ID, opts = {}) => ({
  responses: {
    'thread/start': { result: threadStartResult },
    'turn/start': { result: turnStartResultFor(turnId) },
    'thread/resume': { result: resumeResult(opts.resumePolicy || 'never') },
    'turn/interrupt': { result: {} },
    [COMPACT_METHOD]: { result: {} },
  },
  afterRequest: {
    // `??` would be wrong here: `window: null` is the case under test, and nullish-coalescing would
    // quietly restore the default and make the null-denominator test measure a healthy row.
    'turn/start': turnLines({ turnId, inputTokens: opts.inputTokens ?? 15703, window: opts.window === undefined ? 258400 : opts.window, status: opts.turnStatus || 'completed' }),
    [COMPACT_METHOD]: opts.compactLines || COMPACT_LINES,
  },
});

// ---------------------------------------------------------------------------------------------

describe('measurement', () => {
  test('the captured healthy usage row measures 15703 input tokens against the host-published 258400 window', async () => {
    const { sup, projectDir } = await supWith(BASE_PLAN());
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const m = sup.measureContext();
    assert.equal(m.measurable, true, m.why || '');
    assert.equal(m.usedTokens, 15703);
    assert.equal(m.budget.source, 'host-reported');
    assert.ok(Math.abs(m.usedPercent - 6.0770123) < 1e-4, `expected ~6.077%, got ${m.usedPercent}`);
    assert.equal(m.record.source, 'documented-event');
    assert.equal(core.evidence.confidenceOf(m.record.source), 'HIGH', 'a published window and a published numerator are a HIGH-confidence reading');
    assert.equal(m.record.windowHostReported, true);
    assert.ok(m.record.raw.includes('modelContextWindow'), 'the verbatim host payload travels with the number');
    rm(projectDir);
  });

  test('THE POST-COMPACTION ROW IS CANNOT_DETERMINE, NOT 0% — five components at zero beside a non-zero total', async () => {
    const { sup, conn, projectDir } = await supWith(BASE_PLAN());
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    assert.equal(sup.measureContext().measurable, true, 'the healthy row must measure, or this test proves nothing about the broken one');

    // The captured compaction window carries exactly that row.
    for (const raw of COMPACT_LINES) conn.push(raw);
    const m = sup.measureContext({ usage: { turnId: '019fd7a6-6d1d-7300-9785-6b2d575187d4', tokenUsage: JSON.parse(COMPACT_LINES.find((l) => l.includes('tokenUsage'))).params.tokenUsage, raw: 'x' } });
    assert.equal(m.measurable, false);
    assert.equal(m.usedPercent, null, 'an unmeasured context is null — 0 would be silence at the final threshold');
    assert.equal(m.postCompactionRow, true);
    assert.match(m.why, /every component at 0/);
    rm(projectDir);
  });

  test('a null modelContextWindow has no denominator and is CANNOT_DETERMINE rather than a guessed capacity', async () => {
    const { sup, projectDir } = await supWith(BASE_PLAN(TURN_ID, { window: null }));
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const m = sup.measureContext();
    assert.equal(m.measurable, false);
    assert.match(m.why, /no denominator/);
    rm(projectDir);
  });

  test('an operator-configured window measures, and is never called host-reported', async () => {
    const { sup, projectDir } = await supWith(BASE_PLAN(TURN_ID, { window: null }), { contextWindowTokens: 18000 });
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const m = sup.measureContext();
    assert.equal(m.measurable, true);
    assert.equal(m.budget.source, 'operator-configured');
    assert.equal(m.record.windowHostReported, false);
    // The window is OURS here, so the measurement declares the tier that says so and core's own
    // "confirm anything that is not HIGH at the final threshold" rule fires. The adapter flag is kept
    // beside it as an independent second opinion, and the two are asserted to agree.
    assert.equal(m.record.source, 'documented-count-configured-window', 'an operator-supplied window was declared as a documented host reading');
    assert.equal(core.evidence.confidenceOf(m.record.source), 'MEDIUM');
    const ts = sup.thresholdState();
    assert.equal(ts.evaluation.fire.includes('final'), true, '15703/18000 = 87.2% must cross the 85% final threshold');
    assert.equal(ts.evaluation.requiresOperatorConfirmation, true, 'core did not require confirmation for a window it was told we supplied');
    assert.equal(ts.finalOnAssumedWindow, true, 'a final threshold on an operator-supplied denominator must be flagged, not silently trusted');
    assert.equal(ts.evaluation.requiresOperatorConfirmation, ts.finalOnAssumedWindow, 'core\'s rule and this adapter\'s flag disagree — one of them is wrong');
    rm(projectDir);
  });

  test('a tokenUsage event for a DIFFERENT thread inside our own turn window is ignored, not read', async () => {
    /*
     * ⛔ THE FOREIGN ROW IS PLACED LAST ON PURPOSE. The supervisor keeps the LATEST usage row, so a
     * filter that did not check threadId would take the 99999-token one and the assertion below would
     * fail. A version of this test that pushed the foreign row OUTSIDE the turn window could not have
     * failed at all — nothing outside a window is absorbed either way.
     */
    const foreign = readLines('synthetic/tokenusage-cases.jsonl').find((l) => l.includes('some-other-thread'));
    assert.ok(foreign.includes('99999'), 'the foreign fixture must carry a number nothing else could produce');
    const plan = BASE_PLAN();
    const lines = plan.afterRequest['turn/start'];
    plan.afterRequest['turn/start'] = [...lines.slice(0, -1), foreign, lines[lines.length - 1]];

    const { sup, projectDir } = await supWith(plan);
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const m = sup.measureContext();
    assert.equal(m.measurable, true, m.why || '');
    assert.equal(m.usedTokens, 15703, 'the measurement must come from OUR thread, not from whichever row arrived last');
    assert.equal(sup.usage().turnId, TURN_ID);
    rm(projectDir);
  });
});

describe('the turn/interrupt race', () => {
  test('an interrupt before turn/started is REFUSED by this supervisor rather than sent into the captured -32600', async () => {
    const plan = BASE_PLAN();
    // No turn/started notification: the exact window the host answers "no active turn to interrupt" in.
    plan.afterRequest['turn/start'] = [];
    const { sup, conn, projectDir } = await supWith(plan);
    await sup.startThread();
    const started = await sup.startTurn({ prompt: 'count slowly' });
    assert.equal(started.status, STEP.OK);
    assert.equal(started.startedObserved, false);

    const i = await sup.interruptTurn({ turnId: started.turnId });
    assert.equal(i.status, STEP.REFUSED);
    assert.match(i.why, /no active turn to interrupt/);
    assert.equal(conn.sent.filter((s) => s.method === 'turn/interrupt').length, 0, 'the interrupt must never reach the wire before turn/started');
    rm(projectDir);
  });

  test('after turn/started the same interrupt IS sent, and the turn settles as interrupted', async () => {
    const plan = BASE_PLAN('turn-int');
    plan.afterRequest['turn/start'] = [
      JSON.stringify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: 'turn-int', status: 'inProgress' } } }),
    ];
    const { sup, conn, projectDir } = await supWith(plan);
    await sup.startThread();
    const started = await sup.startTurn({ prompt: 'count slowly' });
    assert.equal(started.startedObserved, true);

    const i = await sup.interruptTurn({ turnId: 'turn-int' });
    assert.equal(i.status, STEP.OK);
    assert.equal(conn.sent.filter((s) => s.method === 'turn/interrupt').length, 1);

    conn.push(JSON.stringify({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: 'turn-int', items: [], status: 'interrupted', error: null, durationMs: 25 } } }));
    const done = await sup.awaitTurn({ turnId: 'turn-int' });
    assert.equal(done.turnStatus, 'interrupted');
    const b = await sup.settleOrStop();
    assert.equal(b.status, STEP.OK, 'an interrupted turn IS a boundary — the host reported it settled');
    rm(projectDir);
  });
});

describe('boundaries', () => {
  test('a turn whose completion never arrived produces no boundary', async () => {
    const plan = BASE_PLAN();
    plan.afterRequest['turn/start'] = [JSON.stringify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: TURN_ID } } })];
    const { sup, projectDir } = await supWith(plan);
    await sup.startThread();
    const t = await sup.turn({ prompt: 'hi' });
    assert.equal(t.status, STEP.CANNOT_DETERMINE);
    assert.match(t.why, /nothing about that is evidence/);
    const b = await sup.settleOrStop();
    assert.equal(b.status, STEP.CANNOT_DETERMINE);
    rm(projectDir);
  });

  test('a turn the host reported FAILED is not a boundary', async () => {
    const { sup, projectDir } = await supWith(BASE_PLAN(TURN_ID, { turnStatus: 'failed' }));
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const b = await sup.settleOrStop();
    assert.equal(b.status, STEP.CANNOT_DETERMINE);
    assert.match(b.why, /"failed"/);
    rm(projectDir);
  });
});

describe('the compaction verdict', () => {
  /** Walk a fresh supervisor to COMPACTING and return the requestCompact result. */
  async function toCompacting(plan, options = {}) {
    const ctx = await supWith(plan, { contextWindowTokens: 18000, ...options });
    await ctx.sup.startThread();
    await ctx.sup.turn({ prompt: 'hi' });
    const ts = ctx.sup.thresholdState();
    const boundary = await ctx.sup.settleOrStop();
    const staged = ctx.sup.stageHandoff({ measurementRecord: ts.measurement.record, boundaryRecord: boundary.record, fields: { exactNextAction: 'do the thing' } });
    assert.equal(staged.status, STEP.OK, staged.why || '');
    const req = await ctx.sup.requestCompact();
    return { ...ctx, ts, staged, req };
  }

  test('the captured contextCompaction pair IS the completion, and the {} ack is not', async () => {
    const { sup, req, projectDir } = await toCompacting(BASE_PLAN());
    assert.deepEqual(req.ack, {}, 'the host acknowledges with an empty object');
    const o = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(o.status, STEP.OK, o.why || '');
    assert.equal(o.completed.signal, 'codex_context_compaction');
    assert.equal(o.completed.itemId, '019fd7a6-6d92-7593-9c3b-05ab4f14545a');
    assert.equal(o.pairObserved, true, 'the item/started and item/completed ids must match');
    assert.equal(sup.machine().state(), 'REHYDRATING');
    rm(projectDir);
  });

  test('an ack plus a turn/completed with NO item is COMPLETION_UNOBSERVED and a no-op CANDIDATE — never resolved either way', async () => {
    const plan = BASE_PLAN();
    plan.afterRequest[COMPACT_METHOD] = readLines('synthetic/compact-ack-without-item.jsonl');
    const { sup, req, projectDir } = await toCompacting(plan);
    const o = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(o.status, STEP.HALTED);
    assert.equal(o.failure.code, 'COMPLETION_UNOBSERVED');
    assert.equal(o.failure.outcome, OUTCOME.CANNOT_DETERMINE, 'this is not a FAIL — nothing observed says the compaction did not happen');
    assert.equal(o.noopCandidate, true);
    assert.match(o.failure.detail, /CANNOT_DETERMINE/);
    rm(projectDir);
  });

  test('an item that started and never completed is COMPLETION_UNOBSERVED and is NOT a no-op candidate', async () => {
    const plan = BASE_PLAN();
    plan.afterRequest[COMPACT_METHOD] = readLines('synthetic/compact-started-never-completed.jsonl');
    const { sup, req, projectDir } = await toCompacting(plan);
    const o = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(o.status, STEP.HALTED);
    assert.equal(o.failure.code, 'COMPLETION_UNOBSERVED');
    assert.equal(o.noopCandidate, false, 'half a pair is a different fact from no pair at all');
    rm(projectDir);
  });

  test('a compaction turn the host reported FAILED is COMPACT_REQUEST_REFUSED, not a non-observation', async () => {
    const plan = BASE_PLAN();
    plan.afterRequest[COMPACT_METHOD] = [
      JSON.stringify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: 'ct-1' } } }),
      JSON.stringify({ method: 'turn/completed', params: { threadId: THREAD_ID, turn: { id: 'ct-1', status: 'failed', error: { message: 'compaction unavailable' } } } }),
    ];
    const { sup, req, projectDir } = await toCompacting(plan);
    const o = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(o.status, STEP.HALTED);
    assert.equal(o.failure.code, 'COMPACT_REQUEST_REFUSED');
    assert.equal(o.failure.outcome, OUTCOME.FAIL, 'the host SAID it failed — that is an observation, not an absence of one');
    rm(projectDir);
  });

  test('a redelivered item/completed is a recorded NO-OP: nothing advances twice', async () => {
    const plan = BASE_PLAN();
    plan.afterRequest[COMPACT_METHOD] = readLines('synthetic/compact-duplicate-item.jsonl');
    const { sup, req, projectDir } = await toCompacting(plan);
    const first = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(first.status, STEP.OK);
    const again = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(again.status, STEP.NOOP);
    assert.equal(again.noopKind, 'duplicate-event');
    assert.equal(sup.machine().state(), 'REHYDRATING', 'a duplicate must leave the state exactly where the first application left it');
    rm(projectDir);
  });

  test('a post-resume item id (item-3) never becomes the event id — the turn id is used instead', async () => {
    assert.equal(isPersistedItemId('item-3'), true);
    assert.equal(isPersistedItemId('019fd7a6-6d92-7593-9c3b-05ab4f14545a'), false);
    const plan = BASE_PLAN();
    plan.afterRequest[COMPACT_METHOD] = readLines('synthetic/compact-persisted-item-id.jsonl');
    const { sup, req, projectDir } = await toCompacting(plan);
    const o = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(o.status, STEP.OK);
    assert.equal(o.completed.itemIdIsPersistedStyle, true);
    assert.match(o.hostEventId, /^turn:/, 'a renumbered item id would collide two compactions on one event key');
    rm(projectDir);
  });

  test('a contextCompaction item for a DIFFERENT thread halts on IDENTITY_MISMATCH', async () => {
    const plan = BASE_PLAN();
    plan.afterRequest[COMPACT_METHOD] = readLines('synthetic/compact-identity-changed.jsonl');
    const { sup, req, projectDir } = await toCompacting(plan);
    // The item is not on our thread, so it is not even a completion for THIS conversation.
    const o = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(o.status, STEP.HALTED);
    assert.equal(o.verdict.offThreadCount, 2, 'the off-thread items must be counted, not silently ignored');

    // And when the item IS on our thread but the id differs, the identity guard is what halts.
    const other = await toCompacting(BASE_PLAN());
    const ok = other.sup.observeCompact({ window: other.req.window, waitedMs: other.req.waitedMs, turnCompleted: other.req.turnCompleted, compactTurnId: other.req.compactTurnId });
    assert.equal(ok.status, STEP.OK);
    const ident = await other.sup.verifyIdentity({ expectedId: 'a-different-thread-id', observedId: THREAD_ID, hostEventId: ok.hostEventId, resumeCheck: false });
    assert.equal(ident.status, STEP.HALTED);
    assert.equal(ident.failure.code, 'IDENTITY_MISMATCH');
    rm(projectDir); rm(other.projectDir);
  });

  test('thread/compact/start is NEVER sent from a state without a verified handoff', async () => {
    const { sup, conn, projectDir } = await supWith(BASE_PLAN());
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const r = await sup.requestCompact();
    assert.equal(r.status, STEP.REFUSED);
    assert.equal(r.failure.code, 'ILLEGAL_TRANSITION');
    assert.equal(r.sent, false);
    assert.equal(conn.sent.filter((s) => s.method === COMPACT_METHOD).length, 0,
      'the transition is applied BEFORE the request is sent, so a refused transition means nothing reached the host');
    rm(projectDir);
  });
});

describe('identity and the approvalPolicy re-pass', () => {
  test('thread/resume re-passes the whole policy set, and the response is read back as proof it took', async () => {
    const { sup, conn, projectDir } = await supWith(BASE_PLAN());
    await sup.startThread();
    const r = await sup.resumeThread();
    assert.equal(r.status, STEP.OK);
    const resume = conn.sent.find((s) => s.method === 'thread/resume');
    assert.equal(resume.params.approvalPolicy, 'never', 'approvalPolicy does not survive a restart, so every resume must re-pass it');
    assert.equal(resume.params.sandbox, 'read-only');
    assert.equal(r.policyRepassHeld, true);
    rm(projectDir);
  });

  test('a resume that comes back on-request is reported as a re-pass that did NOT hold', async () => {
    const { sup, projectDir } = await supWith(BASE_PLAN(TURN_ID, { resumePolicy: 'on-request' }));
    await sup.startThread();
    const r = await sup.resumeThread();
    assert.equal(r.status, STEP.OK);
    assert.equal(r.policyRepassHeld, false, 'the captured gotcha: a thread started "never" answered "on-request" after a restart');
    rm(projectDir);
  });

  test('a resume that answers a DIFFERENT thread id overrides the item comparison and halts', async () => {
    const plan = BASE_PLAN();
    plan.responses['thread/resume'] = { result: { thread: { id: 'someone-elses-thread' }, approvalPolicy: 'never' } };
    const { sup, projectDir } = await supWith(plan, { contextWindowTokens: 18000 });
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const ts = sup.thresholdState();
    const b = await sup.settleOrStop();
    sup.stageHandoff({ measurementRecord: ts.measurement.record, boundaryRecord: b.record, fields: {} });
    const req = await sup.requestCompact();
    const o = sup.observeCompact({ window: req.window, waitedMs: req.waitedMs, turnCompleted: req.turnCompleted, compactTurnId: req.compactTurnId });
    assert.equal(o.status, STEP.OK);
    const ident = await sup.verifyIdentity({ expectedId: THREAD_ID, observedId: THREAD_ID, hostEventId: o.hostEventId });
    assert.equal(ident.status, STEP.HALTED, 'two observations that disagree are never resolved in this adapter\'s favour');
    assert.equal(ident.failure.code, 'IDENTITY_MISMATCH');
    rm(projectDir);
  });
});

describe('the whole rollover', () => {
  test('a complete in-place rollover advances the cycle exactly once, re-arms the latches, and delivers the handoff once', async () => {
    const plan = BASE_PLAN();
    const { sup, conn, projectDir } = await supWith(plan, { contextWindowTokens: 18000 });
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });

    const ts = sup.thresholdState();
    assert.equal(ts.evaluation.fire.includes('final'), true, '15703/18000 = 87.2% must cross the final threshold on its own');
    const cycleZero = sup.machine().cycleId();

    // The continuation turn needs its own id, so the second turn/start answers a different one.
    let turnCall = 0;
    conn.plan.responses['turn/start'] = () => {
      turnCall += 1;
      const id = `cont-${turnCall}`;
      for (const raw of turnLines({ turnId: id, text: 'RP-ECHO', inputTokens: 4000 })) conn.push(raw);
      return { ok: true, id: 99, result: turnStartResultFor(id), raw: JSON.stringify({ result: turnStartResultFor(id) }) };
    };
    conn.plan.afterRequest['turn/start'] = [];

    const r = await sup.rollover({ handoffFields: { exactNextAction: 'Reply with exactly: RP-ECHO', atomicActionId: 'act-1' }, nextPrompt: 'go' });
    assert.equal(r.status, STEP.OK, r.why || JSON.stringify(r.failure || {}));
    assert.equal(r.rolled, true);
    assert.equal(r.cycleBefore.index, 0);
    assert.equal(r.cycleAfter.index, 1);
    assert.equal(sup.machine().state(), 'ACTIVE');

    // The handoff went out exactly once, and the receipt on disk says who took it.
    const second = core.handoff.consume(sup.dir(), r.handoffId, { consumerId: 'test-second-attempt' });
    assert.equal(second.status, 'ALREADY_CONSUMED');
    assert.ok(r.injectedPrompt.includes('Reply with exactly: RP-ECHO'));
    assert.ok(r.injectedPrompt.includes('<respawnpack-handoff'));

    // The latch record ON DISK still belongs to the cycle that fired it — the rollover wrote it before
    // requesting the compaction, which is what stops a re-fire against a context that never got smaller.
    const onDisk = core.thresholds.readLatches(sup.dir());
    assert.equal(onDisk.status, 'OK');
    assert.equal(onDisk.record.cycleId, cycleZero);
    assert.deepEqual(Object.keys(onDisk.record.latched).sort(), ['advisory', 'checkpoint', 'final']);

    // …and the latches re-arm for the NEW cycle as a CONSEQUENCE of the keying, not as a special case.
    const l = sup.latches();
    assert.equal(l.rearmed, true);
    assert.deepEqual(Object.keys(l.record.latched), []);

    // The interop pointer the Codex hooks profile reads.
    assert.equal(fs.existsSync(path.join(sup.dir(), LATEST_HANDOFF_POINTER)), true);
    rm(projectDir);
  });

  test('the continuation is sent exactly once per cycle, and a second attempt in the same cycle is a NO-OP', async () => {
    const { sup, conn, projectDir } = await supWith(BASE_PLAN(), { contextWindowTokens: 18000 });
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    let n = 0;
    conn.plan.responses['turn/start'] = () => {
      n += 1; const id = `c-${n}`;
      for (const raw of turnLines({ turnId: id, inputTokens: 4000 })) conn.push(raw);
      return { ok: true, id: 1, result: turnStartResultFor(id), raw: '{}' };
    };
    conn.plan.afterRequest['turn/start'] = [];
    const first = await sup.continueOnce({ prompt: 'go' });
    assert.equal(first.sent, true);
    const again = await sup.continueOnce({ prompt: 'go' });
    assert.equal(again.status, STEP.NOOP);
    assert.equal(again.sent, false);
    assert.match(again.why, /already sent/);
    rm(projectDir);
  });

  test('a denied server→client approval stops the rollover before anything is requested', async () => {
    const plan = BASE_PLAN();
    plan.approvalHalt = { method: 'execCommandApproval', id: 42, raw: '{"id":42,"method":"execCommandApproval"}', halts: true };
    const { sup, conn, projectDir } = await supWith(plan, { contextWindowTokens: 18000 });
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const r = await sup.rollover({ force: true });
    assert.equal(r.status, STEP.HALTED);
    assert.equal(r.phase, 'approval-denied');
    assert.equal(conn.sent.filter((s) => s.method === COMPACT_METHOD).length, 0);
    rm(projectDir);
  });

  test('an unmeasured context refuses to roll over rather than reading itself as 0%', async () => {
    const { sup, projectDir } = await supWith(BASE_PLAN(TURN_ID, { window: null }));
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });
    const r = await sup.rollover();
    assert.equal(r.status, STEP.CANNOT_DETERMINE);
    assert.match(r.why, /unmeasured context is CANNOT_DETERMINE, never 0%/);
    rm(projectDir);
  });
});

describe('capability declarations', () => {
  test('a PASSING canary declares the profile\'s target support', () => {
    const canary = { ran: true, kind: 'codex-app-server-supervisor-activation', observedAt: '2026-08-06T00:00:00.000Z', outcome: OUTCOME.PASS, raw: '{"threadId":"x"}' };
    const m = caps.matrix(canary);
    assert.equal(m.rolloverCapable, true);
    const byCap = Object.fromEntries(m.declarations.map((d) => [d.capability, d]));
    assert.equal(byCap.requestCompact.support, SUPPORT.SUPPORTED);
    assert.equal(byCap.observeCompact.support, SUPPORT.SUPPORTED_WITH_LIMITATIONS);
    assert.ok(byCap.observeCompact.limitations.length, 'a limitation must be NAMED or the hedge is a SUPPORTED claim in disguise');
    assert.deepEqual(m.downgraded, []);
  });

  test('a canary that RAN and did not pass declares nothing — the shape check alone would have promoted it', () => {
    const canary = { ran: true, kind: 'codex-app-server-supervisor-activation', observedAt: '2026-08-06T00:00:00.000Z', outcome: OUTCOME.CANNOT_DETERMINE, why: 'the compaction item never arrived', raw: '{"x":1}' };
    // The control, kept from when this adapter held the guard itself: the SHAPE check passes on this
    // record. It is now the proof that core's refusal below is a VERDICT check and not the shape check
    // running twice.
    assert.equal(core.capabilities.canaryUsable(canary).ok, true, 'core checks the SHAPE, and this shape is fine — which is why a verdict check had to exist somewhere');
    // And core is where it exists: handed straight to declare(), this canary is refused with no help
    // from this adapter at all.
    const direct = core.capabilities.declare({ capability: 'requestCompact', support: SUPPORT.SUPPORTED, canary, mechanism: 'thread/compact/start' });
    assert.equal(direct.support, SUPPORT.CANNOT_DETERMINE, 'core promoted a canary that recorded a failed run');
    assert.match(direct.why, /CANNOT_DETERMINE/, 'core\'s downgrade does not name the verdict the canary recorded');

    const m = caps.matrix(canary);
    assert.equal(m.rolloverCapable, false);
    for (const d of m.declarations) {
      assert.equal(d.support, SUPPORT.CANNOT_DETERMINE, `${d.capability} was declared ${d.support} on a canary that did not pass`);
      assert.match(d.why, /did not pass/);
      assert.match(d.why, /the compaction item never arrived/, 'the host\'s own reason must survive into the declaration');
    }
  });

  test('with no canary at all, every capability is CANNOT_DETERMINE and says what it proved offline', () => {
    const m = caps.matrix(null);
    assert.equal(m.rolloverCapable, false);
    for (const d of m.declarations) assert.match(d.why, /Proven offline against fixtures/);
  });
});

/*
 * ⛔ THE LIVE EVIDENCE, RE-READ FROM THE BYTES.
 *
 * The canary ran for real against codex-cli 0.146.0 and its event log and report are checked in. A
 * README paragraph describing that run would rot the first time someone re-ran it with different
 * options — so the claims are derived from the recorded bytes here, and the README's own table is
 * fenced against them in both directions: the sentence must still MATCH (a reword fails here rather
 * than silently disabling the check) and it must still AGREE with the evidence.
 */
describe('the recorded live canary evidence', () => {
  const report = readJSON('captured/06-live-canary-report.json');
  const events = readLines('captured/05-live-canary-events.jsonl').map((l) => JSON.parse(l));
  const recvd = events.filter((e) => e.kind === 'recv').map((e) => { try { return JSON.parse(e.raw); } catch { return null; } }).filter(Boolean);

  test('it records THREE consecutive in-place rollovers on ONE thread, and the machine said so', () => {
    assert.equal(report.outcome, OUTCOME.PASS);
    assert.equal(report.exitCode, 0);
    assert.equal(report.rollovers.length, 3);
    assert.equal(report.machine.state, 'ACTIVE');
    assert.equal(report.machine.cycleIndex, 3);
    assert.equal(report.machine.halted, null);
    const indices = report.rollovers.map((r) => [r.cycleBefore.index, r.cycleAfter.index]);
    assert.deepEqual(indices, [[0, 1], [1, 2], [2, 3]], 'one cycle advance per rollover, no skips and no double-advances');
    const nonces = report.rollovers.map((r) => r.cycleAfter.id.split(':').pop());
    assert.equal(new Set(nonces).size, 3, 'every cycle mints a FRESH nonce — an index alone would repeat across a restart');
  });

  test('every compaction it claims is a contextCompaction item/started → item/completed pair on that same threadId', () => {
    const tid = report.threadId;
    const items = recvd.filter((m) => (m.method === 'item/started' || m.method === 'item/completed')
      && m.params && m.params.item && m.params.item.type === 'contextCompaction');
    assert.equal(items.length, 6, `expected three started/completed pairs, found ${items.length} contextCompaction events`);
    for (const r of report.rollovers) {
      assert.equal(isPersistedItemId(r.itemId), false, 'a live item id is a uuidv7, never the item-N form a resume renumbers to');
      const mine = items.filter((m) => m.params.item.id === r.itemId);
      assert.equal(mine.length, 2, `item ${r.itemId} must appear exactly twice — started and completed`);
      assert.deepEqual(mine.map((m) => m.method).sort(), ['item/completed', 'item/started']);
      for (const m of mine) assert.equal(m.params.threadId, tid, 'a completion on another thread is not this thread being compacted');
    }
    assert.equal(new Set(report.rollovers.map((r) => r.itemId)).size, 3, 'three distinct compactions, not one observed three times');
  });

  test('every thread/compact/start was acknowledged with an empty object, and the ack was never the completion', () => {
    const sends = events.filter((e) => e.kind === 'send' && e.method === COMPACT_METHOD);
    assert.equal(sends.length, 3, `the log holds ${sends.length} compaction requests; the report claims 3 rollovers`);
    for (const s of sends) {
      const answer = recvd.find((m) => m.id === s.id && m.result !== undefined);
      assert.deepEqual(answer.result, {}, 'the whole answer is {} — which is why the item, not the ack, is the completion evidence');
    }
  });

  test('the transport read everything: no unparsed line, no torn tail, and no server→client request arrived', () => {
    assert.deepEqual(report.transport.unparsed, []);
    assert.equal(report.transport.tornTail, null);
    assert.ok(report.transport.notifications > 100, `only ${report.transport.notifications} notifications — too few for three rollovers`);
    assert.deepEqual(report.serverRequests, [],
      'no approval was requested under sandbox read-only + approvalPolicy never. Observed — and still not proof that none can arrive, which is why the default-deny table exists');
  });

  test('the capability matrix in the report was generated from THAT run, and nothing was downgraded', () => {
    assert.equal(report.capabilityMatrix.profile, caps.PROFILE);
    assert.equal(report.capabilityMatrix.rolloverCapable, true);
    assert.deepEqual(report.capabilityMatrix.unmet, []);
    assert.deepEqual(report.capabilityMatrix.downgraded, []);
    for (const d of report.capabilityMatrix.declarations) {
      assert.notEqual(d.support, SUPPORT.CANNOT_DETERMINE, `${d.capability} is CANNOT_DETERMINE in a report whose outcome is PASS`);
      assert.equal(d.canary.outcome, OUTCOME.PASS, 'a declaration must rest on the canary that passed, not on the target');
    }
  });

  test('the evidence shows occupancy RISING across the three compactions, and nothing claims otherwise', () => {
    /*
     * ⛔ THE CLAIM THIS RUN CANNOT MAKE. 15625 → 15884 → 16107 input tokens: the thread's baseline
     * (system prompt, instructions, tools) is ~15.6k and a canary that rolls over immediately gives the
     * summariser almost nothing to compress. The protocol is proven; "compaction reduces occupancy on a
     * full thread" is not, and the README has to keep saying so.
     */
    const used = report.rollovers.map((r) => r.usedTokens);
    assert.equal(used.length, 3);
    const fell = used.some((v, i) => i > 0 && v < used[i - 1]);
    assert.equal(fell, false,
      `occupancy fell somewhere in ${JSON.stringify(used)} — if a later run DOES show compaction shrinking the context, that is a stronger claim and the README must be rewritten to make it, not left understating the evidence`);
    const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
    assert.ok(readme.includes(used.join(' → ')), `the README must state the measured tokens (${used.join(' → ')}) it is drawing this limitation from`);
    assert.match(readme, /does \*\*not\*\* show that\s*\ncompaction reduces occupancy|not show that compaction reduces occupancy/,
      'the README no longer states that this run does not show compaction reducing occupancy — deleting the sentence does not close the gap');
  });

  test('the run stayed inside its budget and said what it did NOT measure', () => {
    const modelTurns = report.rollovers.reduce((n, r) => n + r.padTurns + 2, 1); // pads + compaction + continuation, plus the opening turn
    assert.ok(modelTurns <= 18, `the canary took ${modelTurns} model turns; the budget for this proof is ~18`);
    assert.match(report.budgetNote, /OPERATOR-CONFIGURED/);
    for (const r of report.rollovers) {
      assert.equal(r.budgetSource, 'operator-configured',
        'the occupancy percentages in this run are against a configured denominator, and the report must not present them as a reading of the real window');
    }
  });

  test("the README's live-proof table still matches the evidence", () => {
    const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
    // The mechanism half first: if the evidence is ever deleted, the README claim must come BACK to
    // being unproven rather than this fence going on policing a sentence about nothing.
    assert.ok(fs.existsSync(path.join(FIXTURES, 'captured', '05-live-canary-events.jsonl')),
      'the live event log is gone — the README\'s "live proof" section has to be rewritten, and this fence with it');

    const count = /\*\*(\d+) consecutive, in place/.exec(readme);
    assert.ok(count, 'README.md: the rollover-count claim could not be found — if it was reworded, update this fence with it');
    assert.equal(Number(count[1]), report.rollovers.length);

    assert.ok(readme.includes(report.threadId), 'the README names a threadId that is not the one in the evidence');
    assert.ok(readme.includes(report.environment.codexVersion), `the README does not name the host build the run used (${report.environment.codexVersion})`);
    assert.ok(readme.includes('0 → 1 → 2 → 3'), 'the README no longer states the cycle indices the evidence records');
    assert.ok(readme.includes(String(report.options.contextWindow)), 'the README must name the configured denominator the percentages are against');
    assert.match(readme, /did NOT prove/, 'the README must keep saying what the run did not measure — deleting that sentence does not close the gap');
  });
});

/*
 * ⛔ THE CROSS-PROFILE PROOF. adapters/codex/hooks/respawnpack-sessionstart.js claims, in its own
 * banner, that "once an app-server-driven profile (W3b) shares this SAME on-disk journal and drives the
 * machine through 'checkpoint' → 'request-compact', THIS hook's Layer-2 attempt starts succeeding for
 * free, with no code change here." That is a claim about THIS adapter, made by a file this task may not
 * touch — so it is proved here, by driving the real supervisor to COMPACTING and then spawning the real
 * hook as a child process with a synthetic SessionStart(compact) payload, exactly as Codex would.
 */
describe('the hooks profile rehydrates a rollover this supervisor staged', () => {
  function runHook(name, { input, cwd }) {
    return spawnSync(process.execPath, [path.join(HOOKS_DIR, name)], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, RESPAWNPACK_ALLOW_UNSAVED_COMPACT: '' },
    });
  }

  test("the landed SessionStart hook's Layer-2 machine attempt reports APPLIED and advances the cycle", async () => {
    const projectDir = tmp('interop');
    const { sup } = await supWith(BASE_PLAN(), { projectDir, contextWindowTokens: 18000 });
    await sup.startThread();
    await sup.turn({ prompt: 'hi' });

    const ts = sup.thresholdState();
    const boundary = await sup.settleOrStop();
    const staged = sup.stageHandoff({
      measurementRecord: ts.measurement.record, boundaryRecord: boundary.record,
      fields: { exactNextAction: 'finish the app-server supervisor', atomicActionId: 'w3b-1', userConstraints: ['temp dirs only'] },
    });
    assert.equal(staged.status, STEP.OK, staged.why || '');
    const req = await sup.requestCompact();
    assert.equal(req.status, STEP.OK);
    assert.equal(sup.machine().state(), 'COMPACTING', 'the hook must find the machine mid-rollover, which is the whole point');

    // The project-level pointer PreCompact would have written. It is what makes the hook's identity
    // check non-tautological: it compares against a value NOT looked up using the id being verified.
    shared.writeLastActive(projectDir, { conversationId: THREAD_ID, handoffId: staged.handoff.handoffId });
    // The per-conversation pointer is written by the SUPERVISOR — that is the interop contract.
    assert.equal(fs.existsSync(path.join(sup.dir(), LATEST_HANDOFF_POINTER)), true);
    assert.equal(shared.readLatestHandoffPointer(sup.dir()).handoffId, staged.handoff.handoffId);

    const r = runHook('respawnpack-sessionstart.js', {
      cwd: projectDir,
      input: { hook_event_name: 'SessionStart', source: 'compact', session_id: THREAD_ID, cwd: projectDir },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;

    assert.match(ctx, /rehydrated handoff ho_/, 'the hook must consume the handoff this supervisor staged');
    assert.match(ctx, /Same conversation confirmed/);
    assert.match(ctx, /finish the app-server supervisor/, 'the exact next action must reach the next context cycle');
    assert.match(ctx, /verified in-place rollover, cycle 0 -> 1/,
      'THE CLAIM UNDER TEST: with an app-server-driven machine in COMPACTING, the hook\'s Layer-2 attempt applies observe-completion AND verify-identity, and the cycle advances');

    // …and it really did move the shared journal, not just say so.
    const reopened = core.machine.open({ projectDir, host: HOST, conversationId: THREAD_ID });
    assert.equal(reopened.machine.state(), 'ACTIVE');
    assert.equal(reopened.machine.cycleIndex(), 1);

    // A REDELIVERED SessionStart(compact) must not hand the same atomic action over twice.
    const again = runHook('respawnpack-sessionstart.js', {
      cwd: projectDir,
      input: { hook_event_name: 'SessionStart', source: 'compact', session_id: THREAD_ID, cwd: projectDir },
    });
    const ctx2 = JSON.parse(again.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx2, /was already consumed/);
    assert.doesNotMatch(ctx2, /finish the app-server supervisor/, 'the second firing must not re-render the handoff content — that is how one atomic action gets delivered twice');
    rm(projectDir);
  });

  test('without an app-server-driven machine the SAME hook reports the honest hooks-only refusal', () => {
    // The control. A hook that reported "verified in-place rollover" in BOTH situations would be
    // reporting nothing about the supervisor at all.
    const projectDir = tmp('hooksonly');
    const dir = shared.conversationDir(projectDir, THREAD_ID);
    const opened = core.machine.open({ projectDir, host: HOST, conversationId: THREAD_ID });
    assert.equal(opened.machine.state(), 'ACTIVE');
    const record = core.handoff.build({ identity: { host: HOST, conversationId: THREAD_ID, conversationIdField: 'threadId' }, contextCycleId: opened.machine.cycleId(), exactNextAction: 'x' });
    core.handoff.writeVerified(dir, record);
    shared.writeLatestHandoffPointer(dir, { handoffId: record.handoffId, cycleIdAtWrite: opened.machine.cycleId() });
    shared.writeLastActive(projectDir, { conversationId: THREAD_ID, handoffId: record.handoffId });

    const r = runHook('respawnpack-sessionstart.js', {
      cwd: projectDir,
      input: { hook_event_name: 'SessionStart', source: 'compact', session_id: THREAD_ID, cwd: projectDir },
    });
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /did not track this rollover \(ILLEGAL_TRANSITION\)/);
    assert.doesNotMatch(ctx, /verified in-place rollover/);
    rm(projectDir);
  });
});
