/*
 * RespawnPack · adapters/codex/app-server/rpc.js — the JSON-RPC 2.0 / JSONL transport for
 * `codex app-server`, and the one place the SERVER→CLIENT direction is answered.
 *
 * ⛔ `initialize` IS MANDATORY AND ITS ABSENCE IS SILENT-ISH. Captured live in this environment
 * (the live probe's raw log, 2026-08-06, codex-cli 0.146.0): a `thread/start` sent
 * before `initialize` answers
 *
 *     {"error":{"code":-32600,"message":"Not initialized"},"id":1}
 *
 * and the process then exits CLEANLY (code 0). A transport that treated "the child exited without
 * error" as anything but a failure would report a healthy shutdown for a handshake it never did. So
 * `connect()` performs the handshake itself and refuses to hand back a connection that has not
 * completed it.
 *
 * ⛔ AND THE SERVER ASKS THE CLIENT QUESTIONS. `ServerRequest` in the generated schema declares eleven
 * request methods the SERVER sends to US — five of them approvals (`execCommandApproval`,
 * `applyPatchApproval`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
 * `item/permissions/requestApproval`). With sandbox read-only and approvalPolicy "never" none were
 * observed, but "not observed" is not "cannot happen": an unanswered request hangs the turn forever,
 * and a reflexive `{}` reply is a shape the server is free to read as consent. Both are refused here.
 *
 *   DEFAULT_DENY answers each approval with the DECLARED denial shape, taken from the host's own
 *   schema — `{decision:{denied:{rejection:"…"}}}` (ExecCommandApprovalResponse.ReviewDecision), the
 *   elicitation with `{action:"decline"}`, a dynamic tool call with `{success:false,…}` — and every
 *   OTHER server request, including anything this table does not know, with a JSON-RPC *error*. An
 *   error is the only answer that cannot be mistaken for approval by a server whose success shape we
 *   would be guessing at.
 *
 * ⛔ EVERY DENIAL HALTS THE ROLLOVER, and that is the point rather than a limitation. An approval
 * prompt in the middle of an automatic compaction means the turn is doing something the managed
 * profile did not plan for; the supervisor stops and reports the request verbatim instead of
 * negotiating with it. The one exception is `currentTime/read`, which reads the CLIENT's clock, grants
 * nothing, and is answered normally — refusing it would fail a turn for no safety gain.
 *
 * ⛔ A TIMEOUT IS A TYPED NON-ANSWER, NEVER A RESULT. `send()` resolves — it does not reject — with
 * {ok:false, kind:'TIMEOUT'|'CLOSED'|'ERROR'}, so no caller can accidentally `await` its way into
 * treating an elapsed clock as a reply. core/lifecycle/evidence.js would refuse the word by name if
 * one tried to promote it into a completion record.
 *
 * ⛔ AND EVERY BYTE IS KEPT, IN ORDER, BEFORE IT IS INTERPRETED. `events` is the ordered log of every
 * line sent and received plus the lifecycle markers; `rawLogPath` streams the same thing to disk as it
 * happens, so a crash mid-rollover still leaves the transcript a reviewer needs. A line that does not
 * parse is RECORDED as unparsed and never guessed at — this is an EXPERIMENTAL host surface, and the
 * day it grows a shape this file does not know, that has to be visible rather than dropped.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ENV_CODEX_JS = 'RESPAWNPACK_CODEX_JS';

/** Why a send() did not produce a result. All typed; none is ever a completion. */
const SEND_FAILURE = {
  ERROR: 'ERROR',       // the server answered with a JSON-RPC error object
  TIMEOUT: 'TIMEOUT',   // no answer inside the deadline — an observation of a clock
  CLOSED: 'CLOSED',     // the pipe closed before an answer arrived
  REFUSED: 'REFUSED',   // this transport refused to send it (unknown method / malformed params)
};

/*
 * The server→client request methods, from the generated `ServerRequest.json`. Kept as a literal so an
 * unknown method is *recognisable as unknown* rather than silently falling through a default branch —
 * and so the offline suite can prove the table is answered exhaustively.
 */
const SERVER_REQUEST_METHODS = [
  'execCommandApproval',
  'applyPatchApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'item/tool/call',
  'mcpServer/elicitation/request',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
];

const DENY_REASON = 'RespawnPack app-server supervisor is running an unattended rollover: it denies every '
  + 'approval by default and stops. Nothing about this rollover planned for an approval prompt.';

/**
 * The default-deny table. Each entry answers ONE declared server request.
 *
 * `halts:true` means the supervisor treats the request as an unplanned side effect and stops the
 * rollover — the denial keeps the SERVER unblocked, the halt keeps US from continuing as if nothing
 * had happened.
 */
const DEFAULT_DENY = {
  execCommandApproval: { halts: true, result: () => ({ decision: { denied: { rejection: DENY_REASON } } }) },
  applyPatchApproval: { halts: true, result: () => ({ decision: { denied: { rejection: DENY_REASON } } }) },
  'item/commandExecution/requestApproval': { halts: true, result: () => ({ decision: { denied: { rejection: DENY_REASON } } }) },
  'item/fileChange/requestApproval': { halts: true, result: () => ({ decision: { denied: { rejection: DENY_REASON } } }) },
  // PermissionsRequestApprovalResponse requires a GRANTED permission profile and declares no denial
  // variant, so there is no shape here that means "no". An error is the honest answer.
  'item/permissions/requestApproval': { halts: true, error: { code: -32001, message: `${DENY_REASON} (this request has no declared denial shape; refusing at the protocol level)` } },
  'item/tool/requestUserInput': { halts: true, error: { code: -32001, message: `${DENY_REASON} (no operator is present to answer a tool's question)` } },
  'item/tool/call': { halts: true, result: () => ({ success: false, contentItems: [{ type: 'inputText', text: DENY_REASON }] }) },
  'mcpServer/elicitation/request': { halts: true, result: () => ({ action: 'decline' }) },
  // Credentials and attestations are never minted by an unattended supervisor, in any shape.
  'account/chatgptAuthTokens/refresh': { halts: true, error: { code: -32001, message: 'RespawnPack never handles credentials. Re-authenticate Codex interactively and re-run.' } },
  'attestation/generate': { halts: true, error: { code: -32001, message: `${DENY_REASON} (attestations are not minted by an unattended supervisor)` } },
  // Reads OUR clock, grants nothing. Answering costs nothing and refusing would fail a turn for no gain.
  'currentTime/read': { halts: false, result: () => ({ currentTimeAt: Math.floor(Date.now() / 1000) }) },
};

// ---------------------------------------------------------------------------------------------
// executable resolution
// ---------------------------------------------------------------------------------------------

const SHIM_JS_RE = /["']?([A-Za-z]:[\\/][^"'\r\n]*?codex\.js|\/[^"'\r\n]*?codex\.js)["']?/;

/**
 * Find the Codex CLI's `codex.js` entry point.
 *
 * ⛔ NOT A HARDCODED PATH, AND NOT `codex` ON PATH EITHER. The app-server is started as
 * `node <codex.js> app-server`, not through the npm shim: the shim is a `.cmd`/`.ps1` wrapper on
 * Windows, spawning it would need a shell, and a shell in the middle of a JSONL pipe is one more thing
 * that can mangle a line. So the shim is RESOLVED to the script it wraps, and every step of the
 * resolution is recorded — a supervisor that could not say WHICH executable it drove would produce
 * evidence nobody could reproduce.
 *
 * @returns {{ok:true, codexJs, via, searched}|{ok:false, searched, detail, ownerAction}}
 */
function resolveCodexJs({ env = process.env, exists = fs.existsSync, which = defaultWhich } = {}) {
  const searched = [];

  const override = env && env[ENV_CODEX_JS];
  if (override) {
    searched.push({ step: `env ${ENV_CODEX_JS}`, candidate: override, found: Boolean(exists(override)) });
    if (exists(override)) return { ok: true, codexJs: override, via: `env ${ENV_CODEX_JS}`, searched };
  }

  const hits = which('codex');
  searched.push({ step: 'which/where codex', candidate: hits.join(' · ') || '(nothing on PATH)', found: hits.length > 0 });

  for (const hit of hits) {
    if (/\.js$/i.test(hit)) {
      searched.push({ step: 'PATH entry is already a script', candidate: hit, found: Boolean(exists(hit)) });
      if (exists(hit)) return { ok: true, codexJs: hit, via: 'PATH (script)', searched };
      continue;
    }
    // The npm layout: the shim sits beside `node_modules/@openai/codex/bin/codex.js`.
    const sibling = path.join(path.dirname(hit), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    searched.push({ step: 'npm sibling of the shim', candidate: sibling, found: Boolean(exists(sibling)) });
    if (exists(sibling)) return { ok: true, codexJs: sibling, via: 'npm shim sibling', searched };

    // Last resort: read the shim and take the path it points at. Shims are generated text, not a
    // contract — which is why this is tried after the layout and reported when it is what worked.
    try {
      const text = fs.readFileSync(hit, 'utf8');
      const m = SHIM_JS_RE.exec(text);
      if (m && exists(m[1])) {
        searched.push({ step: 'path parsed out of the shim text', candidate: m[1], found: true });
        return { ok: true, codexJs: m[1], via: 'shim text', searched };
      }
      if (m) searched.push({ step: 'path parsed out of the shim text', candidate: m[1], found: false });
    } catch { /* not readable as text; nothing to parse */ }
  }

  return {
    ok: false,
    searched,
    detail: 'no codex.js could be resolved from the environment override, PATH, the npm layout or the shim text',
    ownerAction: `Install the Codex CLI (npm i -g @openai/codex), or point ${ENV_CODEX_JS} at the absolute path of its bin/codex.js.`,
  };
}

/** `where` on Windows, `which -a` elsewhere. A lookup failure is an empty list, never a throw. */
function defaultWhich(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const args = process.platform === 'win32' ? [name] : ['-a', name];
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

/** `node <codex.js> --version`. Typed, never thrown. */
function readVersion({ codexJs, nodeExe = process.execPath, cwd = null, env = process.env } = {}) {
  try {
    const out = execFileSync(nodeExe, [codexJs, '--version'], {
      encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: cwd || undefined, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, version: out.trim(), raw: out };
  } catch (e) {
    return { ok: false, version: null, raw: `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`, detail: (e && e.message) || String(e) };
  }
}

/**
 * Regenerate the protocol schema the host itself publishes, and load the outbound request inventory.
 *
 * ⭐ WHY A SUPERVISOR REGENERATES A SCHEMA IT DOES NOT ENFORCE FULLY. `codex app-server
 * generate-json-schema --experimental` costs one subprocess and answers, for free, the question this
 * profile's biggest risk turns on: has the EXPERIMENTAL surface moved under us? Validating the handful
 * of requests this adapter sends against the host's own declaration turns "a mystery hang" into
 * "thread/compact/start is no longer a declared method", which is a typed probe finding.
 *
 * @returns {{ok:boolean, dir, methods:string[]|null, params:object|null, detail:string|null}}
 */
function regenerateSchema({ codexJs, nodeExe = process.execPath, outDir, cwd = null, env = process.env, timeoutMs = 60000 } = {}) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    execFileSync(nodeExe, [codexJs, 'app-server', 'generate-json-schema', '--experimental', '--out', outDir], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, cwd: cwd || undefined, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { ok: false, dir: outDir, methods: null, params: null, detail: `the schema could not be generated: ${(e && e.message) || e}` };
  }
  return loadClientRequestSchema(path.join(outDir, 'ClientRequest.json'));
}

/**
 * Read `ClientRequest.json` into {method → {required, properties}}. Deliberately shallow: this is a
 * drift detector, not a JSON-Schema implementation. It answers "is this method still declared" and
 * "does this params object still carry the keys the host says are required", which is exactly the
 * class of change that otherwise presents as a hang.
 */
function loadClientRequestSchema(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return { ok: false, dir: path.dirname(file), methods: null, params: null, detail: `${file}: ${(e && e.message) || e}` };
  }
  const defs = doc.definitions || {};
  const params = {};
  const methods = [];
  for (const variant of doc.oneOf || []) {
    const m = variant.properties && variant.properties.method;
    const name = m && (Array.isArray(m.enum) ? m.enum[0] : m.const);
    if (typeof name !== 'string') continue;
    methods.push(name);
    const ref = variant.properties.params && variant.properties.params.$ref;
    const defName = typeof ref === 'string' ? ref.replace('#/definitions/', '') : null;
    const def = defName ? defs[defName] : null;
    params[name] = def
      ? { required: Array.isArray(def.required) ? def.required.slice() : [], properties: Object.keys(def.properties || {}) }
      : { required: [], properties: [] };
  }
  if (!methods.length) {
    return { ok: false, dir: path.dirname(file), methods: null, params: null, detail: `${file} declared no request methods — the schema shape has changed` };
  }
  return { ok: true, dir: path.dirname(file), methods, params, detail: null };
}

/**
 * Check one outbound request against the loaded schema.
 * @returns {{ok:true, unknownParams:string[]}|{ok:false, why:string}}
 */
function validateOutbound(schema, method, params) {
  if (!schema || !schema.ok) return { ok: true, unknownParams: [], unchecked: true };
  if (!schema.methods.includes(method)) {
    return { ok: false, why: `${method} is not a declared ClientRequest method in this build's own schema — the EXPERIMENTAL surface has moved` };
  }
  const spec = schema.params[method] || { required: [], properties: [] };
  const supplied = params && typeof params === 'object' ? Object.keys(params) : [];
  const missing = spec.required.filter((k) => !supplied.includes(k));
  if (missing.length) return { ok: false, why: `${method} requires ${missing.join(', ')} and this call supplies ${supplied.join(', ') || 'nothing'}` };
  // Unknown keys are REPORTED, not refused: sending one is harmless, and a params set that has grown
  // is information about drift rather than a reason to stop.
  return { ok: true, unknownParams: spec.properties.length ? supplied.filter((k) => !spec.properties.includes(k)) : [] };
}

// ---------------------------------------------------------------------------------------------
// the connection
// ---------------------------------------------------------------------------------------------

const nowISO = () => new Date().toISOString();

/**
 * Spawn `codex app-server` and frame its stdout as JSONL.
 *
 * The connection is USABLE BEFORE `initialize` only so the handshake itself can be sent; every other
 * caller should go through `connect()`, which performs it.
 */
function createConnection({
  codexJs,
  nodeExe = process.execPath,
  cwd,
  env = process.env,
  requestTimeoutMs = 60000,
  responder = null,
  rawLogPath = null,
  schema = null,
  onEvent = null,
  now = nowISO,
} = {}) {
  const state = {
    seq: 0,
    idCounter: 1,
    pending: new Map(),
    notifications: [],
    serverRequests: [],
    unparsed: [],
    events: [],
    listeners: new Set(),
    closed: false,
    exit: null,
    spawnError: null,
    stderr: [],
    tornTail: null,
    approvalHalt: null,   // the FIRST denied server request, which is what stops a rollover
    initialized: false,
    initializeResult: null,
    rawLogDropped: 0,      // lines that arrived after the raw log ended — lost, but counted, never silent
    rawLogError: null,
  };

  let rawLog = null;
  let rawLogEnded = false;
  if (rawLogPath) {
    try {
      fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
      rawLog = fs.createWriteStream(rawLogPath, { flags: 'a' });
      // A write attempted after the stream has ended surfaces as an ASYNC `error` event, not a thrown
      // exception — record()'s own writableEnded/destroyed guard below covers the ordinary case, but an
      // UNLISTENED `error` event is an UNCAUGHT EXCEPTION regardless of that guard (an fd-level error,
      // e.g. the disk or the pipe itself going away, does not ask the guard first). Recorded, never thrown.
      rawLog.on('error', (e) => { state.rawLogError = (e && e.message) || String(e); });
    } catch { rawLog = null; /* the log is evidence, not a dependency */ }
  }

  /** Idempotent: the log ends exactly once, whichever teardown path — close event or explicit close() —
   * gets there first. */
  function endRawLog() {
    if (!rawLog || rawLogEnded) return;
    rawLogEnded = true;
    try { rawLog.end(); } catch { /* already gone */ }
  }

  function record(kind, fields) {
    state.seq += 1;
    const ev = { seq: state.seq, at: now(), kind, ...fields };
    state.events.push(ev);
    // The in-memory record stays complete even when the disk copy cannot be: a line that arrives after
    // the raw log has ended (Windows can deliver a stdio `data` event after `exit` and before `close`)
    // is DROPPED rather than written — writing to an ended stream is exactly the
    // ERR_STREAM_WRITE_AFTER_END that used to take the whole process down (CI run 33712716187). The
    // drop is COUNTED so the loss is visible rather than silent.
    if (rawLog) {
      if (rawLog.writableEnded || rawLog.destroyed) {
        state.rawLogDropped += 1;
      } else {
        try { rawLog.write(`${JSON.stringify(ev)}\n`); }
        catch { state.rawLogDropped += 1; /* the pipe is gone */ }
      }
    }
    if (onEvent) { try { onEvent(ev); } catch { /* a reporter must not break a rollover */ } }
    return ev;
  }

  const child = spawn(nodeExe, [codexJs, 'app-server'], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  record('spawn', { nodeExe, codexJs, cwd, pid: child.pid || null });

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      handleLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { state.stderr.push(String(chunk)); record('stderr', { text: String(chunk) }); });
  child.on('error', (e) => {
    state.spawnError = (e && e.message) || String(e);
    record('spawn-error', { detail: state.spawnError });
    settleAllPending(SEND_FAILURE.CLOSED, `the child process could not be started: ${state.spawnError}`);
  });
  child.on('exit', (code, signal) => {
    state.closed = true;
    state.exit = { code, signal };
    // A torn final line is DETECTABLE and is reported; it is never parsed on the guess that it looked
    // complete. Same discipline as core/_io.js's readLinesClassified.
    if (buf.length) { state.tornTail = buf; record('torn-tail', { raw: buf }); buf = ''; }
    record('exit', { code, signal });
    // The raw log is NOT ended here. On Windows `exit` can fire before the stdio pipes have drained, so
    // a stdout/stderr `data` event still on its way in would then write to an already-ended stream —
    // this is CI run 33712716187. `close` (below) fires only once every stdio stream is truly done; that
    // is the honest end of the evidence, not `exit`.
    settleAllPending(SEND_FAILURE.CLOSED, `the app-server exited (code ${code}, signal ${signal}) before answering`);
  });
  child.on('close', () => { endRawLog(); });

  function settleAllPending(kind, detail) {
    for (const [id, p] of state.pending) {
      state.pending.delete(id);
      p.settle({ ok: false, kind, id: Number(id), detail, raw: null });
    }
  }

  function handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      state.unparsed.push({ raw: line, reason: (e && e.message) || String(e) });
      record('recv-unparsed', { raw: line, reason: (e && e.message) || String(e) });
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      state.unparsed.push({ raw: line, reason: 'a JSON-RPC message must be an object' });
      record('recv-unparsed', { raw: line, reason: 'a JSON-RPC message must be an object' });
      return;
    }
    record('recv', { raw: line, method: msg.method || null, id: msg.id === undefined ? null : msg.id });

    // A RESPONSE: has an id AND a result/error.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = state.pending.get(String(msg.id));
      if (!p) { record('orphan-response', { raw: line }); return; }
      state.pending.delete(String(msg.id));
      if (msg.error !== undefined) {
        p.settle({ ok: false, kind: SEND_FAILURE.ERROR, id: msg.id, error: msg.error, raw: line, detail: (msg.error && msg.error.message) || 'the server answered with an error' });
      } else {
        p.settle({ ok: true, id: msg.id, result: msg.result, raw: line });
      }
      return;
    }

    // A SERVER→CLIENT REQUEST: has a method AND an id.
    if (msg.method !== undefined && msg.id !== undefined) { answerServerRequest(msg, line); return; }

    // A NOTIFICATION.
    if (msg.method !== undefined) {
      const note = { seq: state.notifications.length, method: msg.method, params: msg.params, raw: line, at: now() };
      state.notifications.push(note);
      for (const fn of [...state.listeners]) { try { fn(note); } catch { /* a listener must not break the pipe */ } }
      return;
    }

    state.unparsed.push({ raw: line, reason: 'neither a response, a request nor a notification' });
    record('recv-unparsed', { raw: line, reason: 'neither a response, a request nor a notification' });
  }

  function answerServerRequest(msg, line) {
    const decide = responder || defaultResponder;
    let answer;
    try { answer = decide(msg); } catch (e) {
      answer = { error: { code: -32001, message: `the responder itself failed: ${(e && e.message) || e}` }, halts: true, why: 'responder threw' };
    }
    const entry = {
      method: msg.method, id: msg.id, params: msg.params, raw: line, at: now(),
      answered: answer.error ? { error: answer.error } : { result: answer.result },
      halts: Boolean(answer.halts), why: answer.why || null, known: SERVER_REQUEST_METHODS.includes(msg.method),
    };
    state.serverRequests.push(entry);
    record('server-request', entry);
    writeLine(answer.error ? { jsonrpc: '2.0', id: msg.id, error: answer.error } : { jsonrpc: '2.0', id: msg.id, result: answer.result });
    if (entry.halts && !state.approvalHalt) state.approvalHalt = entry;
  }

  /** The table above, with an unknown method refused rather than defaulted into a success shape. */
  function defaultResponder(msg) {
    const spec = DEFAULT_DENY[msg.method];
    if (!spec) {
      return {
        error: { code: -32601, message: `RespawnPack does not answer ${msg.method}: it is not a server request this supervisor knows, and guessing a success shape could read as consent.` },
        halts: true,
        why: `undeclared server→client request ${msg.method}`,
      };
    }
    if (spec.error) return { error: spec.error, halts: spec.halts, why: `default-deny (${msg.method})` };
    return { result: spec.result(), halts: spec.halts, why: spec.halts ? `default-deny (${msg.method})` : `answered (${msg.method})` };
  }

  function writeLine(obj) {
    const line = JSON.stringify(obj);
    record('send', { raw: line, method: obj.method || null, id: obj.id === undefined ? null : obj.id });
    try { child.stdin.write(`${line}\n`); return { ok: true }; }
    catch (e) { record('send-error', { detail: (e && e.message) || String(e) }); return { ok: false, detail: (e && e.message) || String(e) }; }
  }

  /**
   * Send a request and get a TYPED answer. Never rejects.
   * @returns {Promise<{ok:true,id,result,raw}|{ok:false,kind,id,error?,detail,raw}>}
   */
  function send(method, params, { timeoutMs = requestTimeoutMs } = {}) {
    const check = validateOutbound(schema, method, params);
    if (!check.ok) {
      const refusal = { ok: false, kind: SEND_FAILURE.REFUSED, id: null, detail: check.why, raw: null };
      record('send-refused', refusal);
      return Promise.resolve(refusal);
    }
    if (check.unknownParams && check.unknownParams.length) {
      record('schema-note', { method, unknownParams: check.unknownParams, detail: 'params the host schema does not declare — sent anyway, reported as drift' });
    }
    if (state.closed) {
      return Promise.resolve({ ok: false, kind: SEND_FAILURE.CLOSED, id: null, detail: 'the app-server is no longer running', raw: null });
    }

    const id = state.idCounter; state.idCounter += 1;
    return new Promise((resolve) => {
      let done = false;
      const settle = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => {
        state.pending.delete(String(id));
        // A deadline is a fact about the clock. It is returned as one and named as one.
        settle({ ok: false, kind: SEND_FAILURE.TIMEOUT, id, detail: `no answer to ${method} within ${timeoutMs}ms — this is an observation of a clock, not of a result`, raw: null, waitedMs: timeoutMs });
      }, timeoutMs);
      state.pending.set(String(id), { settle, method });
      const w = writeLine({ jsonrpc: '2.0', id, method, params });
      if (!w.ok) { state.pending.delete(String(id)); settle({ ok: false, kind: SEND_FAILURE.CLOSED, id, detail: w.detail, raw: null }); }
    });
  }

  /**
   * Wait for a notification matching `predicate`.
   *
   * ⛔ THE BUFFER IS SEARCHED FIRST, AND THAT IS LOAD-BEARING. `turn/started` can arrive before the
   * caller that needs it has finished awaiting the `turn/start` RESPONSE — a listener-only wait would
   * miss it and then time out on something that already happened.
   */
  function waitFor(predicate, { timeoutMs = requestTimeoutMs, label = 'a notification', from = 0 } = {}) {
    const existing = state.notifications.slice(from).find((n) => safePredicate(predicate, n));
    if (existing) return Promise.resolve({ ok: true, note: existing, fromBuffer: true });
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); state.listeners.delete(listener); resolve(r); };
      const listener = (n) => { if (safePredicate(predicate, n)) finish({ ok: true, note: n, fromBuffer: false }); };
      const timer = setTimeout(() => finish({
        ok: false, kind: state.closed ? SEND_FAILURE.CLOSED : SEND_FAILURE.TIMEOUT, waitedMs: timeoutMs,
        detail: `${label} did not arrive within ${timeoutMs}ms — nothing about that is evidence of what the host did`,
      }), timeoutMs);
      state.listeners.add(listener);
    });
  }

  const safePredicate = (p, n) => { try { return Boolean(p(n)); } catch { return false; } };

  /** Notifications since a cursor, so a caller can slice out exactly one turn's window. */
  const since = (cursor) => state.notifications.slice(cursor);

  function close() {
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
    // The caller's own timeout/teardown path: do not wait for the child's `close` to arrive on its
    // own — a hung app-server that never drains its stdio must not leave the log open forever.
    // Idempotent with the `close` handler above, whichever of the two gets there first.
    endRawLog();
  }

  return {
    child, send, waitFor, since, close, writeLine,
    events: () => state.events.slice(),
    eventCount: () => state.events.length,
    notifications: () => state.notifications.slice(),
    notificationCount: () => state.notifications.length,
    serverRequests: () => state.serverRequests.slice(),
    unparsed: () => state.unparsed.slice(),
    stderr: () => state.stderr.join(''),
    tornTail: () => state.tornTail,
    exit: () => state.exit,
    spawnError: () => state.spawnError,
    closed: () => state.closed,
    approvalHalt: () => state.approvalHalt,
    initialized: () => state.initialized,
    initializeResult: () => state.initializeResult,
    markInitialized: (result) => { state.initialized = true; state.initializeResult = result; },
    rawLogDropped: () => state.rawLogDropped,
    rawLogError: () => state.rawLogError,
    rawLogPath,
    schema,
  };
}

const CLIENT_INFO = { name: 'respawnpack-app-server-supervisor', version: '0.3.1', title: 'RespawnPack Codex app-server supervisor' };

/**
 * Spawn AND handshake. The only entry point a supervisor should use.
 *
 * @returns {Promise<{ok:true, conn, initialize}|{ok:false, conn, kind, detail, verbatim, ownerAction}>}
 */
async function connect(options = {}) {
  const conn = createConnection(options);
  const r = await conn.send('initialize', {
    clientInfo: options.clientInfo || CLIENT_INFO,
    capabilities: { experimentalApi: true },
  }, { timeoutMs: options.initializeTimeoutMs || 30000 });

  if (!r.ok) {
    const verbatim = { response: r.raw || null, error: r.error || null, stderr: conn.stderr(), exit: conn.exit(), unparsed: conn.unparsed() };
    conn.close();
    return {
      ok: false, conn, kind: r.kind, detail: r.detail, verbatim,
      ownerAction: r.kind === SEND_FAILURE.CLOSED
        ? 'The app-server exited during the handshake. Run `codex app-server` by hand from the same directory and read what it prints.'
        : 'The `initialize` handshake did not answer. This surface is EXPERIMENTAL — regenerate the schema and compare before assuming a transport bug.',
    };
  }
  conn.markInitialized(r.result);
  return { ok: true, conn, initialize: r.result, raw: r.raw };
}

module.exports = {
  ENV_CODEX_JS, SEND_FAILURE, SERVER_REQUEST_METHODS, DEFAULT_DENY, DENY_REASON, CLIENT_INFO,
  resolveCodexJs, defaultWhich, readVersion, regenerateSchema, loadClientRequestSchema, validateOutbound,
  createConnection, connect,
};
