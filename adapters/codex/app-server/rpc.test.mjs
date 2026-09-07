/*
 * RespawnPack · adapters/codex/app-server/rpc.test.mjs — the transport, driven as a black box.
 *
 * Every framing test spawns a REAL child process (fixtures/fake-app-server.js) rather than calling the
 * line handler directly, because the defects this layer actually has live at the chunk boundary: a
 * reader that is only ever handed whole lines cannot fail the way a pipe makes it fail. `splitBytes: 3`
 * in the plans below is not decoration — it forces every reply to arrive across many `data` events.
 *
 * The BYTES those plans replay are the captured ones under fixtures/captured/, so the shapes under test
 * are the host's even though the sender is not. What is synthetic is labelled synthetic in the manifest
 * and can only ever prove that this READER is correct, never that the host does something.
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
const rpc = require_(path.join(HERE, 'rpc.js'));

const FIXTURES = path.join(HERE, 'fixtures');
const FAKE = path.join(FIXTURES, 'fake-app-server.js');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'MANIFEST.json'), 'utf8'));

const readLines = (rel) => fs.readFileSync(path.join(FIXTURES, rel), 'utf8').split(/\n/).filter(Boolean);
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-codex-rpc-${tag}-`));

const CAPTURED_RESPONSES = readJSON('captured/04-responses.json');
const TURN_LINES = readLines('captured/01-turn-lifecycle.jsonl');
const COMPACT_LINES = readLines('captured/02-compaction.jsonl');

/** Spawn the fake with a plan. Always `splitBytes:3` unless a test says otherwise. */
function fake(plan, options = {}) {
  return rpc.createConnection({
    codexJs: FAKE,
    cwd: options.cwd || HERE,
    env: { ...process.env, RP_FAKE_PLAN: JSON.stringify({ splitBytes: 3, ...plan }) },
    requestTimeoutMs: options.requestTimeoutMs || 8000,
    responder: options.responder || null,
    schema: options.schema || null,
    rawLogPath: options.rawLogPath || null,
  });
}

const resultOf = (rawLine) => JSON.parse(rawLine).result;

// ---------------------------------------------------------------------------------------------

describe('fixtures', () => {
  test('the manifest lists exactly the fixture files on disk', () => {
    const walk = (d, prefix) => fs.readdirSync(path.join(FIXTURES, d))
      .filter((f) => !f.startsWith('.'))
      .map((f) => `${prefix}${f}`);
    const onDisk = [...walk('captured', 'captured/'), ...walk('synthetic', 'synthetic/')].sort();
    const declared = MANIFEST.fixtures.map((f) => f.file).sort();
    assert.deepEqual(declared, onDisk, 'every fixture must be declared, and every declaration must exist');
  });

  test('the recorded digest is the digest on disk — a captured fixture cannot be edited into agreement with the code that reads it', () => {
    for (const f of MANIFEST.fixtures) {
      const buf = fs.readFileSync(path.join(FIXTURES, f.file));
      assert.equal(buf.length, f.bytes, `${f.file}: size changed since it was recorded`);
      assert.equal(sha256(buf), f.sha256, `${f.file}: bytes changed since it was recorded — re-record it deliberately, and say why`);
    }
  });

  test('every fixture declares its origin, and a synthetic one says what it cannot prove', () => {
    for (const f of MANIFEST.fixtures) {
      assert.ok(['captured-live', 'synthetic'].includes(f.origin), `${f.file}: unknown origin ${f.origin}`);
      if (f.origin === 'captured-live') {
        assert.ok(f.capturedFrom, `${f.file}: a captured fixture must say where it came from`);
      } else {
        assert.equal(f.provesReaderNotHost, true, `${f.file}: a synthetic fixture must say it proves the reader, not the host`);
        assert.ok(f.whyNotCaptured, `${f.file}: a synthetic fixture must say why it is not captured`);
      }
    }
    // A manifest with only one kind in it would make the distinction decorative.
    const kinds = new Set(MANIFEST.fixtures.map((f) => f.origin));
    assert.equal(kinds.size, 2, 'the manifest must contain both captured and synthetic fixtures, or the distinction is doing no work');
  });
});

describe('executable resolution', () => {
  test('the environment override wins and is reported as the reason', () => {
    const r = rpc.resolveCodexJs({ env: { [rpc.ENV_CODEX_JS]: 'C:/x/codex.js' }, exists: (p) => p === 'C:/x/codex.js', which: () => [] });
    assert.equal(r.ok, true);
    assert.equal(r.codexJs, 'C:/x/codex.js');
    assert.match(r.via, /env RESPAWNPACK_CODEX_JS/);
  });

  test('an override that does not exist is not used, and the attempt is still recorded', () => {
    const r = rpc.resolveCodexJs({ env: { [rpc.ENV_CODEX_JS]: 'C:/gone/codex.js' }, exists: () => false, which: () => [] });
    assert.equal(r.ok, false);
    assert.ok(r.searched.some((s) => s.candidate === 'C:/gone/codex.js' && s.found === false),
      'a candidate that was tried and missing must appear in the search record — an inventory built only from what was found cannot report an absence');
  });

  test('an npm shim resolves to the script beside it', () => {
    const sibling = path.join('C:/npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const r = rpc.resolveCodexJs({ env: {}, exists: (p) => p === sibling, which: () => ['C:/npm/codex.cmd'] });
    assert.equal(r.ok, true);
    assert.equal(r.codexJs, sibling);
    assert.equal(r.via, 'npm shim sibling');
  });

  test('nothing on PATH is a typed answer with an owner action, never a throw', () => {
    const r = rpc.resolveCodexJs({ env: {}, exists: () => false, which: () => [] });
    assert.equal(r.ok, false);
    assert.match(r.ownerAction, /RESPAWNPACK_CODEX_JS/);
  });
});

describe('the outbound schema check', () => {
  const schema = rpc.loadClientRequestSchema(path.join(FIXTURES, 'synthetic', 'client-request-schema.json'));

  test('the loader reads methods and their required params out of the ClientRequest shape', () => {
    assert.equal(schema.ok, true, schema.detail || '');
    assert.ok(schema.methods.includes('thread/compact/start'));
    assert.deepEqual(schema.params['thread/compact/start'].required, ['threadId']);
    assert.deepEqual(schema.params['turn/start'].required.slice().sort(), ['input', 'threadId']);
  });

  test('a method the build no longer declares is refused, and the refusal names the drift', () => {
    const r = rpc.validateOutbound(schema, 'thread/compacted', { threadId: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.why, /not a declared ClientRequest method/);
    assert.match(r.why, /EXPERIMENTAL/);
  });

  test('a missing required param is refused BEFORE the request is sent', () => {
    const r = rpc.validateOutbound(schema, 'turn/start', { threadId: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.why, /requires input/);
  });

  test('an undeclared EXTRA param is reported as drift and not refused — sending one is harmless, not knowing is not', () => {
    const r = rpc.validateOutbound(schema, 'thread/compact/start', { threadId: 'x', somethingNew: 1 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.unknownParams, ['somethingNew']);
  });

  test('with NO schema loaded every method passes, and the result says it was unchecked', () => {
    const r = rpc.validateOutbound(null, 'anything/at/all', {});
    assert.equal(r.ok, true);
    assert.equal(r.unchecked, true, 'an unchecked send must be distinguishable from a checked one that passed');
  });

  test('a malformed schema file is a typed load failure, not a crash', () => {
    const d = tmp('badschema');
    const f = path.join(d, 'ClientRequest.json');
    fs.writeFileSync(f, '{"oneOf": []}');
    const r = rpc.loadClientRequestSchema(f);
    assert.equal(r.ok, false);
    assert.match(r.detail, /declared no request methods/);
    fs.rmSync(d, { recursive: true, force: true });
  });
});

describe('JSONL framing', () => {
  test('a response reassembled across many chunk boundaries is still one message', async () => {
    const conn = fake({ responses: { initialize: { result: resultOf(CAPTURED_RESPONSES.initialize) } }, splitBytes: 3 });
    const r = await conn.send('initialize', { clientInfo: rpc.CLIENT_INFO });
    conn.close();
    assert.equal(r.ok, true);
    assert.equal(r.result.platformFamily, 'windows', 'the captured initialize result must survive being delivered three bytes at a time');
  });

  test('every captured notification of a real turn is framed, in order, and none is interpreted on the way in', async () => {
    const conn = fake({ responses: { 'turn/start': { result: resultOf(CAPTURED_RESPONSES.turnStart) } }, afterRequest: { 'turn/start': TURN_LINES }, splitBytes: 5 });
    const r = await conn.send('turn/start', { threadId: 't', input: [] });
    assert.equal(r.ok, true);
    const done = await conn.waitFor((n) => n.method === 'turn/completed', { timeoutMs: 8000, label: 'turn/completed' });
    conn.close();
    assert.equal(done.ok, true);
    const methods = conn.notifications().map((n) => n.method);
    assert.deepEqual(methods, TURN_LINES.map((l) => JSON.parse(l).method), 'the notification order must be the arrival order, with nothing dropped and nothing merged');
    assert.equal(conn.unparsed().length, 0);
    // The raw line is kept beside the parsed message — that is what a later reviewer re-reads.
    assert.equal(conn.notifications()[0].raw, TURN_LINES[0]);
  });

  test('an unparseable line, a JSON array and an orphan response are RECORDED rather than guessed at', async () => {
    const hostile = readLines('synthetic/transport-hostile.jsonl');
    const conn = fake({ prelude: hostile, responses: { ping: { result: {} } } });
    await conn.send('ping', {});
    conn.close();
    const reasons = conn.unparsed().map((u) => u.reason);
    assert.equal(conn.unparsed().length, 2, `expected the non-JSON line and the JSON array to be reported; got ${JSON.stringify(reasons)}`);
    assert.ok(reasons.some((r) => /Unexpected|JSON|token/i.test(r)));
    assert.ok(reasons.some((r) => /must be an object/.test(r)));
    // An unknown notification method is TOLERATED — kept, not refused. This surface grows shapes.
    assert.ok(conn.notifications().some((n) => n.method === 'somethingTheHostGrewLater/updated'));
    assert.ok(conn.events().some((e) => e.kind === 'orphan-response'), 'a response nobody is waiting for must be visible, not silently dropped');
  });

  test('a torn trailing line is reported as torn and is never parsed on the guess that it looked complete', async () => {
    const conn = fake({ responses: { ping: { result: { ok: true } } }, exitAfter: 'ping', tornTail: '{"method":"thread/status/cha' });
    const r = await conn.send('ping', {});
    assert.equal(r.ok, true);
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(conn.tornTail(), '{"method":"thread/status/cha');
    assert.equal(conn.notifications().length, 0, 'a torn tail must not become a notification');
    conn.close();
  });
});

describe('typed non-answers', () => {
  test('a JSON-RPC error is returned typed, never thrown, and carries the host error verbatim', async () => {
    const err = JSON.parse(CAPTURED_RESPONSES.turnInterruptBeforeStartedError).error;
    const conn = fake({ responses: { 'turn/interrupt': { error: err } } });
    const r = await conn.send('turn/interrupt', { threadId: 't', turnId: 'x' });
    conn.close();
    assert.equal(r.ok, false);
    assert.equal(r.kind, rpc.SEND_FAILURE.ERROR);
    assert.equal(r.error.code, -32600);
    assert.equal(r.error.message, 'no active turn to interrupt', 'the captured race error must survive the transport unaltered');
  });

  test('a request that is never answered resolves as TIMEOUT and names itself an observation of a clock', async () => {
    const conn = fake({ responses: { 'thread/compact/start': { silent: true } } }, { requestTimeoutMs: 300 });
    const r = await conn.send('thread/compact/start', { threadId: 't' }, { timeoutMs: 300 });
    conn.close();
    assert.equal(r.ok, false);
    assert.equal(r.kind, rpc.SEND_FAILURE.TIMEOUT);
    assert.match(r.detail, /observation of a clock/);
  });

  test('a child that exits mid-request settles it as CLOSED — a clean exit is not an answer', async () => {
    // The captured pre-handshake case: the host answers -32600 and then exits with code 0.
    const conn = fake({ responses: { first: { result: {} } }, exitAfter: 'first' });
    await conn.send('first', {});
    await new Promise((res) => setTimeout(res, 400));
    const r = await conn.send('second', {});
    conn.close();
    assert.equal(r.ok, false);
    assert.equal(r.kind, rpc.SEND_FAILURE.CLOSED);
  });

  test('a send refused by the schema check never reaches the wire', async () => {
    const schema = rpc.loadClientRequestSchema(path.join(FIXTURES, 'synthetic', 'client-request-schema.json'));
    const conn = fake({ responses: { 'thread/compact/start': { result: {} } } }, { schema });
    const r = await conn.send('thread/compact/start', {});
    conn.close();
    assert.equal(r.ok, false);
    assert.equal(r.kind, rpc.SEND_FAILURE.REFUSED);
    assert.equal(conn.events().filter((e) => e.kind === 'send').length, 0, 'a refused request must not be written to stdin');
  });
});

describe('the server→client direction', () => {
  test('every declared server request has an answer, and no answer is an accidental success shape', () => {
    for (const m of rpc.SERVER_REQUEST_METHODS) {
      const spec = rpc.DEFAULT_DENY[m];
      assert.ok(spec, `${m} is declared by the host schema and this transport has no answer for it — an unanswered request hangs the turn forever`);
      assert.equal(typeof spec.halts, 'boolean');
      assert.ok(spec.error || typeof spec.result === 'function', `${m} must answer with either a typed refusal or a declared denial shape`);
    }
    // Exactly one benign exception, and it must be the clock read.
    const nonHalting = rpc.SERVER_REQUEST_METHODS.filter((m) => rpc.DEFAULT_DENY[m].halts === false);
    assert.deepEqual(nonHalting, ['currentTime/read'],
      'every server request except the clock read must halt the rollover — an approval prompt mid-compaction is an unplanned side effect');
  });

  test('the approval denials use the DECLARED denial shape, not an empty result', () => {
    for (const m of ['execCommandApproval', 'applyPatchApproval', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      const r = rpc.DEFAULT_DENY[m].result();
      assert.ok(r.decision && r.decision.denied && typeof r.decision.denied.rejection === 'string',
        `${m} must answer {decision:{denied:{rejection}}} — the shape ExecCommandApprovalResponse.ReviewDecision declares. An empty {} is a shape the server is free to read as consent.`);
    }
    assert.deepEqual(rpc.DEFAULT_DENY['mcpServer/elicitation/request'].result(), { action: 'decline' });
    assert.equal(rpc.DEFAULT_DENY['item/tool/call'].result().success, false);
    // The one with no declared denial variant must refuse at the protocol level rather than grant.
    assert.ok(rpc.DEFAULT_DENY['item/permissions/requestApproval'].error, 'a permissions GRANT has no denial shape, so it must be refused as an error rather than answered');
  });

  test('a real approval request is denied on the wire, recorded verbatim, and raises the halt', async () => {
    const requests = readLines('synthetic/server-requests.jsonl');
    const conn = fake({ serverRequests: requests, responses: { ping: { result: {} } } });
    await conn.send('ping', {});
    await new Promise((res) => setTimeout(res, 200));
    const seen = conn.serverRequests();
    conn.close();

    assert.equal(seen.length, requests.length, 'every server request must be answered — an unanswered one hangs the turn');
    const exec = seen.find((s) => s.method === 'execCommandApproval');
    assert.deepEqual(exec.answered.result.decision.denied.rejection.slice(0, 20), rpc.DENY_REASON.slice(0, 20));
    assert.equal(exec.raw, requests[0], 'the request is kept verbatim, because what it asked for is the whole reason the rollover stops');

    const unknown = seen.find((s) => s.method === 'somethingEntirelyNew/requestApproval');
    assert.equal(unknown.known, false);
    assert.ok(unknown.answered.error, 'an undeclared server request must be refused with an error, never a guessed success shape');

    const clock = seen.find((s) => s.method === 'currentTime/read');
    assert.equal(clock.halts, false);
    assert.equal(typeof clock.answered.result.currentTimeAt, 'number');

    // The FIRST halting request is what stops the rollover, and it is the approval, not the clock.
    assert.equal(conn.approvalHalt().method, 'execCommandApproval');
  });

  test('a responder that throws still produces an answer rather than a hung turn', async () => {
    const conn = fake({ serverRequests: [JSON.stringify({ id: 7, method: 'execCommandApproval', params: {} })], responses: { ping: { result: {} } } },
      { responder: () => { throw new Error('boom'); } });
    await conn.send('ping', {});
    await new Promise((res) => setTimeout(res, 200));
    const seen = conn.serverRequests();
    conn.close();
    assert.equal(seen.length, 1);
    assert.match(seen[0].answered.error.message, /the responder itself failed/);
    assert.equal(seen[0].halts, true);
  });
});

describe('the handshake', () => {
  test('connect() completes initialize and hands back a usable connection', async () => {
    const r = await rpc.connect({
      codexJs: FAKE, cwd: HERE,
      env: { ...process.env, RP_FAKE_PLAN: JSON.stringify({ splitBytes: 3, responses: { initialize: { result: resultOf(CAPTURED_RESPONSES.initialize) } } }) },
    });
    assert.equal(r.ok, true);
    assert.equal(r.conn.initialized(), true);
    assert.equal(r.initialize.codexHome, 'C:\\Users\\user\\.codex');
    r.conn.close();
  });

  test('the captured "Not initialized" refusal is a typed handshake failure with an owner action, and the connection is closed', async () => {
    const err = JSON.parse(CAPTURED_RESPONSES.preInitThreadStartError).error;
    const r = await rpc.connect({
      codexJs: FAKE, cwd: HERE,
      env: { ...process.env, RP_FAKE_PLAN: JSON.stringify({ responses: { initialize: { error: err } } }) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.kind, rpc.SEND_FAILURE.ERROR);
    assert.equal(r.verbatim.error.message, 'Not initialized');
    assert.ok(r.ownerAction);
  });

  test('a handshake the host never answers before exiting is CLOSED, not a silent success', async () => {
    const r = await rpc.connect({
      codexJs: FAKE, cwd: HERE,
      env: { ...process.env, RP_FAKE_PLAN: JSON.stringify({ responses: { initialize: { silent: true } }, exitAfter: 'initialize' }) },
      initializeTimeoutMs: 3000,
    });
    assert.equal(r.ok, false);
    assert.ok([rpc.SEND_FAILURE.CLOSED, rpc.SEND_FAILURE.TIMEOUT].includes(r.kind));
    assert.match(r.detail, /exited|clock/);
  });
});

describe('the raw log', () => {
  test('every line in and out is streamed to disk as it happens, in order', async () => {
    const d = tmp('rawlog');
    const file = path.join(d, 'raw.jsonl');
    const conn = fake({ responses: { 'thread/compact/start': { result: {} } }, afterRequest: { 'thread/compact/start': COMPACT_LINES } }, { rawLogPath: file });
    await conn.send('thread/compact/start', { threadId: '019fd7a6-5e6b-72e2-908a-4f7d7201685d' });
    await conn.waitFor((n) => n.method === 'turn/completed', { timeoutMs: 8000, label: 'turn/completed' });
    conn.close();
    await new Promise((res) => setTimeout(res, 200));

    const rows = fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.length >= COMPACT_LINES.length + 2, `the raw log holds ${rows.length} rows; it must carry the spawn, the send and every received line`);
    assert.equal(rows[0].kind, 'spawn');
    const sent = rows.find((r) => r.kind === 'send');
    assert.match(sent.raw, /thread\/compact\/start/);
    const seqs = rows.map((r) => r.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'the log must be in arrival order');
    fs.rmSync(d, { recursive: true, force: true });
  });

  /*
   * ⛔ CI (GitHub Windows runner, run 33712716187) crashed this whole test process with
   * `ERR_STREAM_WRITE_AFTER_END` — `record()` wrote to `rawLog` after the `exit` handler had already
   * called `rawLog.end()`. On Windows a stdio `data` event can arrive AFTER `exit` and BEFORE `close`
   * (close fires only once every stdio pipe has drained; exit does not wait for that), so a second
   * `record()` — another stderr chunk, a straggling `recv` — lands on an ended stream. `.write()` after
   * `.end()` does not throw synchronously; it emits an ASYNC `error` on the stream, and an unlistened
   * `error` event is an uncaught exception, which is exactly `failureType: uncaughtException` in the
   * CI log. The real trigger is an OS pipe-timing race that this suite's own author found did not
   * reproduce even on Windows, six runs out of six — so the three tests below force the SAME race
   * deterministically, by reaching into the real child's own `stderr` stream and emitting a `data`
   * event by hand once the log has already ended, rather than hoping the OS reorders two pipes for us.
   */
  describe('write-after-end safety (CI run 33712716187, Windows, uncaughtException)', () => {
    test('the defect: a chunk arriving after the raw log has ended must not crash the process — it is dropped and counted, never thrown', async () => {
      const d = tmp('rawlog-late');
      const file = path.join(d, 'raw.jsonl');
      const conn = fake({ responses: { ping: { result: {} } }, exitAfter: 'ping' }, { rawLogPath: file });

      const exited = new Promise((resolve) => conn.child.once('exit', resolve));
      const r = await conn.send('ping', {});
      assert.equal(r.ok, true);
      await exited; // the child has exited ON ITS OWN; its own exit record already reached disk

      // React in the same turn `exit` fired in: close() ends the raw log SYNCHRONOUSLY (writableEnded
      // flips true immediately, before the stream has fully destroyed a moment later). That narrow
      // window is exactly what CI run 33712716187 hit on Windows: a stdio `data` event still arriving
      // between `exit` and `close` (the pipes had not drained yet, even though the process had already
      // exited) drove another record() call, writing to the now-ended stream. Forced here by hand,
      // deterministically, instead of hoping the OS races two pipes the same way twice. Confirmed by
      // hand against the pre-fix code: write() after end() does not throw synchronously, it raises an
      // ASYNC `error` on the stream, so an unlistened rawLog crashed the whole process one tick later
      // as an uncaught ERR_STREAM_WRITE_AFTER_END — at exactly the call site CI named, `record
      // (adapters/codex/app-server/rpc.js:323:32)`. `rawLogDropped()` is read only AFTER the emit and
      // the tick below, so — pre-fix — it is the crash itself that fails this test, not a stale read.
      conn.close();
      conn.child.stderr.emit('data', 'a stderr chunk that arrives after the raw log has ended\n');
      // The error surfaces on the next tick, never synchronously — give it one before trusting that
      // the process (and this test) is still standing.
      await new Promise((res) => setTimeout(res, 100));

      assert.equal(conn.rawLogDropped(), 1, 'the late write must be counted so the loss is visible, not silent');
      fs.rmSync(d, { recursive: true, force: true });
    });

    test('corrected: every pre-end line survives on disk, in order, the late write is counted, and the log closes exactly once', async () => {
      const d = tmp('rawlog-corrected');
      const file = path.join(d, 'raw.jsonl');
      const conn = fake({
        responses: { 'thread/compact/start': { result: {} } },
        afterRequest: { 'thread/compact/start': COMPACT_LINES },
        exitAfter: 'thread/compact/start',
      }, { rawLogPath: file });
      await conn.send('thread/compact/start', { threadId: '019fd7a6-5e6b-72e2-908a-4f7d7201685d' });
      await conn.waitFor((n) => n.method === 'turn/completed', { timeoutMs: 8000, label: 'turn/completed' });
      // No conn.close() here: the fake exits ON ITS OWN (exitAfter), so `exit` then `close` fire
      // naturally, exercising the fixed close-driven ending rather than the caller's explicit teardown.
      await new Promise((res) => setTimeout(res, 300));
      assert.ok(conn.exit(), 'precondition: the child exited on its own before we inspect the log');

      const before = fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(before.length >= COMPACT_LINES.length + 2, `the raw log holds ${before.length} rows; every line answered before exit must survive`);
      assert.equal(before[0].kind, 'spawn');
      const seqs = before.map((r) => r.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'still in arrival order');

      const droppedBefore = conn.rawLogDropped();
      assert.doesNotThrow(() => conn.child.stderr.emit('data', 'a chunk that arrives after close\n'));
      assert.equal(conn.rawLogDropped(), droppedBefore + 1, 'the late chunk must be counted, not silently absorbed');

      // A second, explicit close() — the caller's own teardown running after the log already ended
      // naturally — must be a harmless no-op: the log is closed EXACTLY once, whichever path gets there
      // first, and never reopened or duplicated.
      assert.doesNotThrow(() => conn.close());
      const after = fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(after, before, 'nothing was appended after the log ended — the dropped chunk never reached disk, and closing again changed nothing');

      fs.rmSync(d, { recursive: true, force: true });
    });

    test('nearest bypass: close() ends the raw log immediately, without waiting for the child\'s own close event — the existing streamed-to-disk test stays green', async () => {
      const d = tmp('rawlog-bypass');
      const file = path.join(d, 'raw.jsonl');
      // No exitAfter: the fake sits forever waiting on stdin, exactly like a hung app-server whose
      // stdio never drains on its own. The only thing that ends the log here is the caller's own
      // timeout/teardown path — the same close() a supervisor calls when it gives up waiting.
      const conn = fake({ responses: { ping: { result: {} } } }, { rawLogPath: file });
      await conn.send('ping', {});
      assert.equal(conn.exit(), null, 'precondition: the child has not exited on its own');

      conn.close();
      // No wait: the child's own exit/close has not necessarily fired yet. If ending the log still
      // depended on that event rather than on close() itself, this write would land on an open stream.
      const droppedBefore = conn.rawLogDropped();
      assert.doesNotThrow(() => conn.child.stderr.emit('data', 'after forced close, before the child is reaped\n'));
      assert.equal(conn.rawLogDropped(), droppedBefore + 1,
        'close() must end the log synchronously, so a write issued before the child is even reaped is still safely dropped and counted');

      await new Promise((res) => setTimeout(res, 300));
      const rows = fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(rows.some((r) => r.kind === 'spawn'));
      assert.ok(rows.some((r) => r.kind === 'send'));
      fs.rmSync(d, { recursive: true, force: true });
    });
  });
});
