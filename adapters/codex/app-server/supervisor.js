/*
 * RespawnPack · adapters/codex/app-server/supervisor.js — the Codex MANAGED profile: a supervisor that
 * owns a `codex app-server` thread and rolls it over IN PLACE, through the host-neutral core.
 *
 * ⭐ WHAT "MANAGED" BUYS HERE, stated against the hooks profile it sits beside (adapters/codex/hooks/).
 * In a hooks-only install the operator types `/compact` and the pack watches; nothing in a hook can make
 * an interactive Codex compact itself, and respawnpack-precompact.js says so in its own banner. Here the
 * supervisor IS the client: it issues `turn/start`, so it can stop at a boundary of its own choosing,
 * request the compaction through `thread/compact/start`, watch the SAME thread for the documented
 * completion item, and continue. Automatic, in place, with the threadId preserved.
 *
 * ⛔ EVERY STEP GOES THROUGH core/lifecycle/machine.js, AND NOTHING HERE RE-DECIDES WHAT IT DECIDES.
 * `thread/compact/start` is not sent unless `request-compact` was APPLIED — which the machine allows
 * only from HANDOFF_VERIFIED, which it reaches only on a read-back comparison of two digests:
 *
 *     const applied = m.apply({transition:'request-compact', …});
 *     if (applied.status !== 'APPLIED') return …;   // ← thread/compact/start is never sent
 *
 * ⛔ THE ACK IS NOT THE COMPLETION. `thread/compact/start` answers `{}` IMMEDIATELY — captured live
 * (the live probe's raw log): `{"id":4,"result":{}}` arrives before any work happens.
 * The compaction then runs as its OWN TURN on the same thread and the ONLY completion evidence is the
 * `contextCompaction` item reaching `item/completed`. An ack plus a `turn/completed` with NO such item
 * is recorded as COMPLETION_UNOBSERVED and flagged as a no-op candidate — CANNOT_DETERMINE which,
 * because a real no-op was never observed in this environment and inventing the distinction would be
 * exactly the guess this pack exists to refuse. The deprecated `thread/compacted` notification does not
 * fire on this build and is not waited for.
 *
 * ⛔ OCCUPANCY IS UNKNOWABLE FOR ONE TURN AFTER A COMPACTION, AND SAYS SO. `thread/tokenUsage/updated`
 * on the compaction turn carries `total` UNCHANGED (it is cumulative) and a `last` block whose five
 * component counters are all 0 while `totalTokens` is 4511 — captured verbatim. Any percentage derived
 * from that row would be fiction, so measureContext returns CANNOT_DETERMINE until the next turn
 * publishes a real one. core/policy/thresholds.js already forbids reading an absent measurement as 0%.
 *
 * ⛔ approvalPolicy IS NOT PERSISTED ACROSS AN APP-SERVER RESTART — sandbox IS. Captured: a
 * `thread/resume` that did not re-pass it came back `"approvalPolicy":"on-request"` on a thread started
 * with `"never"`. So every `thread/resume` in this file re-passes the whole policy set, and the identity
 * check reads the policy back off the response as PROOF the re-pass took.
 *
 * ⛔ AND EVENT IDS ARE THE HOST'S OWN LIVE IDS, NEVER POST-RESUME ONES. A resumed thread renumbers its
 * items `item-1`, `item-2`, … — captured — so an id of that shape is recognised and refused as an event
 * id, falling back to the turn id. Correlating a rollover across a cold resume by item id would silently
 * collide two different compactions on the machine's duplicate index.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');

const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));
const rpc = require('./rpc.js');

const { io, machine, evidence, thresholds, handoff, consumable, failures, cycle } = core;
const { OUTCOME } = failures;

const HOST = evidence.HOSTS.CODEX;
const CONVERSATION_ID_FIELD = 'threadId';
const COMPACT_METHOD = 'thread/compact/start';
const COMPLETION_SIGNAL = 'codex_context_compaction'; // declared in core/lifecycle/evidence.js

/*
 * The measurement source is decided by the DENOMINATOR, not by the numerator alone. `last.inputTokens`
 * comes from a documented EVENT either way; what changes is whether the window under it was published
 * by the host (`modelContextWindow`) or supplied by the operator. core declares a tier for the second
 * case — `documented-count-configured-window`, MEDIUM — whose whole content is "the count is the
 * host's, the window is ours", which is exactly what an operator override makes true. This host is the
 * one that USUALLY publishes its window, so the HIGH branch is the common one here; the override branch
 * is not a rarity worth rounding off, because it is the branch that ends with a session stopped on our
 * arithmetic.
 */
const MEASUREMENT_SOURCE = 'documented-event';                                // core maps this to HIGH
const CONFIGURED_WINDOW_SOURCE = 'documented-count-configured-window';        // …and this to MEDIUM
const measurementSource = (budget) => (budget && budget.hostReported ? MEASUREMENT_SOURCE : CONFIGURED_WINDOW_SOURCE);

/** Results this module returns. Distinct from core's OUTCOME on purpose: these describe an ATTEMPT. */
const STEP = { OK: 'OK', REFUSED: 'REFUSED', HALTED: 'HALTED', NOOP: 'NOOP', CANNOT_DETERMINE: 'CANNOT_DETERMINE' };

/** The per-conversation pointer the Codex HOOKS profile reads. Written here so a hooks-installed target
 * can rehydrate from a rollover this supervisor staged — the two profiles share one runtime directory
 * by design (adapters/codex/hooks/_shared.js writes the same file from PreCompact). */
const LATEST_HANDOFF_POINTER = 'latest-handoff.json';

const nowISO = () => new Date().toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A resumed thread renumbers items `item-N`. Such an id is stable across nothing and must never key an event. */
const isPersistedItemId = (id) => typeof id === 'string' && /^item-\d+$/.test(id);

/**
 * Build a supervisor. `projectDir` is REQUIRED and never defaulted: a supervisor that fell back to
 * process.cwd() would write rollover state into whatever repository happened to be current.
 */
function createSupervisor(options = {}) {
  const {
    projectDir,
    cwd = null,
    codexJs = null,
    nodeExe = process.execPath,
    env = process.env,
    sandbox = 'read-only',
    approvalPolicy = 'never',
    model = null,
    requestTimeoutMs = 60000,
    turnStartedTimeoutMs = 30000,
    turnTimeoutMs = 180000,
    compactTimeoutMs = 180000,
    contextWindowTokens = null,   // operator override of the DENOMINATOR; provenance travels with it
    thresholdConfig = null,
    consumerId = null,
    connect = rpc.connect,        // injectable so the offline suite drives this exact code
    rawLogPath = null,
    now = nowISO,
    onEvent = null,
  } = options;

  if (typeof projectDir !== 'string' || !projectDir) {
    throw new Error('createSupervisor: projectDir is required — this supervisor never guesses which project it is rolling over');
  }

  const state = {
    conn: null,
    threadId: null,
    threadStart: null,
    machine: null,
    dir: null,
    turnSeq: 0,
    turns: [],
    lastTurn: null,
    inFlight: null,          // { turnId, startedObserved, cursor, label }
    usage: null,             // the latest thread/tokenUsage/updated for THIS thread
    compactionTurnIds: new Set(),
    pendingHandoff: null,
    probeResult: null,
    rollovers: [],
    schema: null,
    resolution: null,
  };

  const myConsumerId = consumerId || `codex-app-server:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  const emit = (kind, payload) => { if (onEvent) { try { onEvent(kind, payload); } catch { /* a reporter must not break a rollover */ } } };

  // ---------------------------------------------------------------------------------------------
  // turn capture — the verbatim record, written BEFORE anything is interpreted
  // ---------------------------------------------------------------------------------------------

  function persistTurn(label, fields) {
    state.turnSeq += 1;
    const seq = String(state.turnSeq).padStart(3, '0');
    const doc = {
      kind: 'codex-app-server-turn',
      seq: state.turnSeq, label, at: now(),
      threadId: state.threadId,
      turnId: fields.turnId || null,
      status: fields.status || null,
      promptDigest: io.digest(fields.prompt === undefined ? '' : String(fields.prompt)),
      promptBytes: Buffer.byteLength(fields.prompt === undefined ? '' : String(fields.prompt), 'utf8'),
      request: fields.request || null,
      response: fields.response || null,
      // VERBATIM notification lines for this turn's window, in arrival order.
      lines: (fields.window || []).map((n) => n.raw),
      methods: (fields.window || []).map((n) => n.method),
      timedOut: Boolean(fields.timedOut),
      detail: fields.detail || null,
    };
    const file = state.dir ? path.join(state.dir, 'turns', `turn-${seq}.json`) : null;
    let written = { ok: false, detail: 'no conversation directory yet' };
    if (file) written = io.writeAtomicJSON(file, doc);
    const record = { seq: state.turnSeq, label, file, written: written.ok, digest: written.digest || null, doc };
    state.turns.push(record);
    emit('turn', record);
    return record;
  }

  // ---------------------------------------------------------------------------------------------
  // probe
  // ---------------------------------------------------------------------------------------------

  /**
   * probe — resolve the executable, read its version, regenerate the protocol schema, and complete the
   * mandatory handshake. Every failure is a typed CANNOT_DETERMINE carrying the host's own words.
   *
   * ⛔ IT DOES NOT TAKE A MODEL TURN, AND THEREFORE DOES NOT PROVE AUTHENTICATION. `initialize` answers
   * before credentials are used (its result is a user-agent string, a codex home and a platform), so
   * `authenticated` stays null here and is settled by the first COMPLETED turn. Reporting a green probe
   * as "authenticated" would be the same unearned inference core/policy/capabilities.js refuses when it
   * downgrades a support claim with no canary.
   */
  async function probe({ regenerateSchema = true } = {}) {
    const resolved = codexJs
      ? { ok: true, codexJs, via: 'caller-supplied', searched: [{ step: 'option codexJs', candidate: codexJs, found: true }] }
      : rpc.resolveCodexJs({ env });
    state.resolution = resolved;

    if (!resolved.ok) {
      const result = {
        outcome: OUTCOME.CANNOT_DETERMINE, installed: false, authenticated: null, version: null, codexJs: null,
        resolution: resolved, why: resolved.detail, verbatim: { searched: resolved.searched }, ownerAction: resolved.ownerAction,
      };
      state.probeResult = result; emit('probe', result); return result;
    }

    const version = rpc.readVersion({ codexJs: resolved.codexJs, nodeExe, cwd: cwd || projectDir, env });
    if (!version.ok) {
      const result = {
        outcome: OUTCOME.CANNOT_DETERMINE, installed: true, authenticated: null, version: null, codexJs: resolved.codexJs,
        resolution: resolved, why: `\`node ${resolved.codexJs} --version\` did not answer: ${version.detail}`,
        verbatim: { stdio: version.raw }, ownerAction: `Run \`node ${resolved.codexJs} --version\` by hand and resolve what it reports.`,
      };
      state.probeResult = result; emit('probe', result); return result;
    }

    let schema = null;
    if (regenerateSchema) {
      schema = rpc.regenerateSchema({
        codexJs: resolved.codexJs, nodeExe, cwd: cwd || projectDir, env,
        outDir: path.join(projectDir, cycle.RUNTIME_SUBDIR, '_codex-app-server-schema'),
      });
      state.schema = schema && schema.ok ? schema : null;
    }

    const opened = await connect({
      codexJs: resolved.codexJs, nodeExe, cwd: cwd || projectDir, env,
      requestTimeoutMs, schema: state.schema, rawLogPath, onEvent: (ev) => emit('rpc', ev),
    });
    if (!opened.ok) {
      const result = {
        outcome: OUTCOME.CANNOT_DETERMINE, installed: true, authenticated: null, version: version.version,
        codexJs: resolved.codexJs, resolution: resolved,
        schema: schema ? { ok: schema.ok, dir: schema.dir, methods: schema.methods ? schema.methods.length : 0, detail: schema.detail } : null,
        why: `the mandatory \`initialize\` handshake did not complete (${opened.kind}): ${opened.detail}`,
        verbatim: opened.verbatim, ownerAction: opened.ownerAction,
      };
      state.probeResult = result; emit('probe', result); return result;
    }

    state.conn = opened.conn;
    const schemaKnows = !schema || !schema.ok
      ? null
      : [COMPACT_METHOD, 'turn/start', 'thread/start', 'thread/resume', 'turn/interrupt'].filter((m) => !schema.methods.includes(m));

    const result = {
      outcome: schemaKnows && schemaKnows.length ? OUTCOME.FAIL : OUTCOME.PASS,
      installed: true,
      // Settled by the first COMPLETED turn, not by a handshake that runs before credentials are used.
      authenticated: null,
      version: version.version,
      codexJs: resolved.codexJs,
      resolution: resolved,
      initialize: opened.initialize,
      schema: schema ? { ok: schema.ok, dir: schema.dir, methods: schema.methods ? schema.methods.length : 0, detail: schema.detail, missing: schemaKnows } : null,
      why: schemaKnows && schemaKnows.length
        ? `this build's own schema no longer declares ${schemaKnows.join(', ')} — the EXPERIMENTAL app-server surface has moved`
        : null,
      verbatim: { initialize: opened.raw, version: version.raw },
      observedAt: now(),
      ownerAction: schemaKnows && schemaKnows.length
        ? 'Re-read the regenerated schema under .respawnpack/runtime/rollover/_codex-app-server-schema/ and update this adapter to the methods the build declares.'
        : null,
    };
    state.probeResult = result; emit('probe', result); return result;
  }

  // ---------------------------------------------------------------------------------------------
  // thread lifecycle
  // ---------------------------------------------------------------------------------------------

  /** Open (or restore) the machine for a thread id. Idempotent. */
  function attach(threadId) {
    if (typeof threadId !== 'string' || !threadId) {
      return { status: STEP.CANNOT_DETERMINE, why: 'the host exposed no thread id, so there is no conversation to attach to' };
    }
    if (state.machine && state.threadId === threadId) return { status: STEP.OK, machine: state.machine, dir: state.dir, reopened: false };
    const opened = machine.open({ projectDir, host: HOST, conversationId: threadId });
    if (!opened.ok) return { status: STEP.CANNOT_DETERMINE, failure: opened.failure, why: opened.failure.detail };
    state.machine = opened.machine;
    state.threadId = threadId;
    state.dir = opened.machine.dir;
    emit('attach', { threadId, dir: state.dir, opened: opened.opened });
    return { status: STEP.OK, machine: opened.machine, dir: state.dir, opened: opened.opened, reopened: Boolean(opened.opened.restored) };
  }

  /** The policy set, in one place, so `thread/start` and every `thread/resume` cannot disagree. */
  const policyParams = () => ({ cwd: cwd || projectDir, sandbox, approvalPolicy, ...(model ? { model } : {}) });

  async function startThread() {
    if (!state.conn) return { status: STEP.CANNOT_DETERMINE, why: 'probe() has not established a connection' };
    const r = await state.conn.send('thread/start', policyParams(), { timeoutMs: requestTimeoutMs });
    if (!r.ok) return { status: STEP.CANNOT_DETERMINE, why: `thread/start answered ${r.kind}: ${r.detail}`, raw: r.raw || null, error: r.error || null };
    const threadId = r.result && r.result.thread && r.result.thread.id;
    if (typeof threadId !== 'string' || !threadId) {
      return { status: STEP.CANNOT_DETERMINE, why: 'thread/start returned no thread id, so there is no conversation identity to roll over', raw: r.raw };
    }
    state.threadStart = r.result;
    const a = attach(threadId);
    if (a.status !== STEP.OK) return a;
    // ⭐ The thread's OWN report of the policy it is running under. Recorded rather than assumed: the
    // sandbox and approval policy are what make an unattended rollover safe, and "we asked for it" is
    // not the same observation as "the host says it is in force".
    return {
      status: STEP.OK, threadId, raw: r.raw,
      observedPolicy: { approvalPolicy: r.result.approvalPolicy || null, sandbox: r.result.sandbox || null, model: r.result.model || null },
      sessionId: (r.result.thread && r.result.thread.sessionId) || null,
      path: (r.result.thread && r.result.thread.path) || null,
    };
  }

  /**
   * thread/resume, WITH the policy re-passed. See the banner: approvalPolicy does not survive a restart,
   * so a resume that omitted it would silently re-arm interactive approvals mid-rollover.
   */
  async function resumeThread({ threadId = state.threadId } = {}) {
    if (!state.conn) return { status: STEP.CANNOT_DETERMINE, why: 'probe() has not established a connection' };
    if (!threadId) return { status: STEP.CANNOT_DETERMINE, why: 'there is no thread id to resume' };
    const r = await state.conn.send('thread/resume', { threadId, ...policyParams() }, { timeoutMs: requestTimeoutMs });
    if (!r.ok) return { status: STEP.CANNOT_DETERMINE, why: `thread/resume answered ${r.kind}: ${r.detail}`, raw: r.raw || null, error: r.error || null };
    const observedId = r.result && r.result.thread && r.result.thread.id;
    return {
      status: STEP.OK, observedId: observedId || null, raw: r.raw,
      observedPolicy: { approvalPolicy: r.result.approvalPolicy || null, sandbox: r.result.sandbox || null },
      policyRepassHeld: r.result.approvalPolicy === approvalPolicy,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // turns — start and settle are SEPARATE, because the interrupt race lives between them
  // ---------------------------------------------------------------------------------------------

  /**
   * Send `turn/start` and wait for the `turn/started` NOTIFICATION.
   *
   * ⛔ THE RESPONSE IS NOT THE START. `turn/start` answers immediately with a stub whose status is
   * "inProgress"; the turn is not interruptible until the `turn/started` notification has fired.
   * Captured live: `turn/interrupt` sent between the two answers
   * `{"error":{"code":-32600,"message":"no active turn to interrupt"}}`. Waiting for the notification is
   * the whole discipline, so it is done HERE rather than remembered at each call site.
   */
  async function startTurn({ prompt, label = 'turn' }) {
    if (!state.conn) return { status: STEP.CANNOT_DETERMINE, why: 'probe() has not established a connection' };
    if (!state.threadId) return { status: STEP.CANNOT_DETERMINE, why: 'no thread has been started' };
    const cursor = state.conn.notificationCount();
    const r = await state.conn.send('turn/start', {
      threadId: state.threadId, input: [{ type: 'text', text: String(prompt) }],
    }, { timeoutMs: requestTimeoutMs });
    if (!r.ok) return { status: STEP.CANNOT_DETERMINE, why: `turn/start answered ${r.kind}: ${r.detail}`, raw: r.raw || null, error: r.error || null, cursor };
    const turnId = r.result && r.result.turn && r.result.turn.id;
    if (typeof turnId !== 'string' || !turnId) {
      return { status: STEP.CANNOT_DETERMINE, why: 'turn/start returned no turn id', raw: r.raw, cursor };
    }
    const started = await state.conn.waitFor(
      (n) => n.method === 'turn/started' && isObj(n.params) && isObj(n.params.turn) && n.params.turn.id === turnId,
      { from: cursor, timeoutMs: turnStartedTimeoutMs, label: `turn/started for ${turnId}` },
    );
    state.inFlight = { turnId, cursor, label, prompt, request: r.raw, startedObserved: Boolean(started.ok), startedRaw: started.ok ? started.note.raw : null };
    emit('turn-started', { turnId, observed: Boolean(started.ok) });
    return {
      status: STEP.OK, turnId, cursor, raw: r.raw,
      startedObserved: Boolean(started.ok),
      startedDetail: started.ok ? null : started.detail,
    };
  }

  /** Wait for `turn/completed` for one turn, and persist the whole window verbatim. */
  async function awaitTurn({ turnId = state.inFlight && state.inFlight.turnId, timeoutMs = turnTimeoutMs } = {}) {
    if (!state.conn) return { status: STEP.CANNOT_DETERMINE, why: 'probe() has not established a connection' };
    if (!turnId) return { status: STEP.CANNOT_DETERMINE, why: 'no turn is in flight' };
    const flight = state.inFlight && state.inFlight.turnId === turnId ? state.inFlight : { turnId, cursor: 0, label: 'turn', prompt: '', request: null };
    const done = await state.conn.waitFor(
      (n) => n.method === 'turn/completed' && isObj(n.params) && isObj(n.params.turn) && n.params.turn.id === turnId,
      { from: flight.cursor, timeoutMs, label: `turn/completed for ${turnId}` },
    );
    const window = state.conn.since(flight.cursor);
    absorbUsage(window);

    if (!done.ok) {
      const record = persistTurn(flight.label, { turnId, prompt: flight.prompt, request: flight.request, window, timedOut: true, detail: done.detail });
      // A killed wait is not a settled turn. state.inFlight is DELIBERATELY left set: the turn may still
      // be running on the host, and pretending otherwise is how a supervisor starts a second one.
      return { status: STEP.CANNOT_DETERMINE, turnId, why: done.detail, waitedMs: done.waitedMs, record, window };
    }

    const turn = done.note.params.turn || {};
    state.inFlight = null;
    state.lastTurn = {
      turnId, status: turn.status || null, items: Array.isArray(turn.items) ? turn.items : [],
      error: turn.error || null, durationMs: num(turn.durationMs), raw: done.note.raw,
      threadId: done.note.params.threadId || null, window,
    };
    const record = persistTurn(flight.label, {
      turnId, prompt: flight.prompt, request: flight.request, response: done.note.raw, status: turn.status || null, window,
    });
    emit('turn-completed', { turnId, status: turn.status || null });
    return { status: STEP.OK, turnId, turnStatus: turn.status || null, turn, raw: done.note.raw, record, window };
  }

  /** One complete turn. The common case; the split above exists for the interrupt path and the tests. */
  async function turn({ prompt, label = 'turn', timeoutMs = turnTimeoutMs }) {
    const started = await startTurn({ prompt, label });
    if (started.status !== STEP.OK) return started;
    const done = await awaitTurn({ turnId: started.turnId, timeoutMs });
    return { ...done, startedObserved: started.startedObserved };
  }

  /**
   * Interrupt the in-flight turn — and REFUSE to try before the start notification was observed.
   *
   * That refusal is the captured race made structural: the host answers -32600 to an interrupt sent in
   * the window between the `turn/start` response and the `turn/started` notification, and a supervisor
   * that retried into that error would eventually read it as "the turn is already over".
   */
  async function interruptTurn({ turnId = state.inFlight && state.inFlight.turnId } = {}) {
    if (!state.conn) return { status: STEP.CANNOT_DETERMINE, why: 'probe() has not established a connection' };
    if (!turnId) return { status: STEP.CANNOT_DETERMINE, why: 'no turn is in flight to interrupt' };
    const flight = state.inFlight && state.inFlight.turnId === turnId ? state.inFlight : null;
    if (!flight || !flight.startedObserved) {
      return {
        status: STEP.REFUSED, turnId,
        why: 'turn/started has not been observed for this turn. Interrupting now is the captured race that answers '
          + '-32600 "no active turn to interrupt"; this supervisor waits for the notification instead of sending into it.',
      };
    }
    const r = await state.conn.send('turn/interrupt', { threadId: state.threadId, turnId }, { timeoutMs: requestTimeoutMs });
    if (!r.ok) return { status: STEP.CANNOT_DETERMINE, turnId, why: `turn/interrupt answered ${r.kind}: ${r.detail}`, error: r.error || null, raw: r.raw || null };
    return { status: STEP.OK, turnId, raw: r.raw };
  }

  // ---------------------------------------------------------------------------------------------
  // measurement
  // ---------------------------------------------------------------------------------------------

  /** Keep the latest tokenUsage for THIS thread. Notifications for other threads are ignored, not read. */
  function absorbUsage(window) {
    for (const n of window || []) {
      if (n.method !== 'thread/tokenUsage/updated') continue;
      if (!isObj(n.params) || n.params.threadId !== state.threadId) continue;
      state.usage = { turnId: n.params.turnId || null, tokenUsage: n.params.tokenUsage || null, raw: n.raw, at: n.at };
    }
  }

  /**
   * measureContext — occupancy from `thread/tokenUsage/updated`, with the denominator's provenance.
   *
   * NUMERATOR: `last.inputTokens` — the input side of the most recent request, which IS the occupied
   * part of the window. (`cachedInputTokens` is a subset of it, not an addition: the captured row reads
   * inputTokens 15703 / cachedInputTokens 11008 / outputTokens 5 / totalTokens 15708.)
   * DENOMINATOR: `modelContextWindow`, which this host PUBLISHES — the thing the Claude profile has to
   * assume. When an operator overrides it, that is recorded and the override is never called host-reported.
   */
  function measureContext({ usage = state.usage, observedAt = null } = {}) {
    if (!usage || !isObj(usage.tokenUsage)) {
      return { measurable: false, usedPercent: null, record: null, why: 'no thread/tokenUsage/updated has been observed for this thread yet' };
    }
    const tu = usage.tokenUsage;
    const last = isObj(tu.last) ? tu.last : null;
    if (!last) {
      return { measurable: false, usedPercent: null, record: null, why: 'the tokenUsage payload carried no `last` block', raw: usage.raw };
    }

    // ⛔ THE POST-COMPACTION ROW. Five component counters at 0 beside a non-zero total is not a context
    // that emptied; it is a row that does not describe a request. Captured verbatim on the compaction
    // turn. Nothing is derived from it.
    const components = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
    const allZero = components.every((k) => Number(last[k] || 0) === 0);
    if (allZero && Number(last.totalTokens || 0) > 0) {
      return {
        measurable: false, usedPercent: null, record: null, raw: usage.raw, postCompactionRow: true,
        why: `the latest tokenUsage row for turn ${usage.turnId} reports totalTokens ${last.totalTokens} with every component at 0 — the shape this host emits on a compaction turn. `
          + 'Occupancy is CANNOT_DETERMINE until the next turn publishes a real row; it is not 0%.',
      };
    }
    if (state.compactionTurnIds.has(usage.turnId)) {
      return {
        measurable: false, usedPercent: null, record: null, raw: usage.raw, postCompactionRow: true,
        why: `the latest tokenUsage row belongs to compaction turn ${usage.turnId}; occupancy is CANNOT_DETERMINE until the next model turn publishes one`,
      };
    }

    const usedTokens = num(last.inputTokens);
    if (usedTokens === null) {
      return { measurable: false, usedPercent: null, record: null, raw: usage.raw, why: 'the `last` block carried no numeric inputTokens' };
    }

    const hostWindow = num(tu.modelContextWindow);
    const override = num(contextWindowTokens);
    const budget = override && override > 0
      ? { tokens: override, source: 'operator-configured', hostReported: false, why: `the operator configured a ${override}-token window; the host published ${hostWindow === null ? 'none' : hostWindow}` }
      : (hostWindow && hostWindow > 0
        ? { tokens: hostWindow, source: 'host-reported', hostReported: true, why: `the host published modelContextWindow=${hostWindow} on its own tokenUsage event` }
        : null);

    if (!budget) {
      return {
        measurable: false, usedPercent: null, record: null, raw: usage.raw,
        why: 'the host published modelContextWindow: null and no operator window is configured, so there is no denominator. '
          + 'An occupancy with a guessed capacity is an estimate wearing a reading; this returns CANNOT_DETERMINE instead.',
      };
    }

    const usedPercent = Math.min(100, (usedTokens / budget.tokens) * 100);
    const record = evidence.make(evidence.KINDS.CONTEXT_MEASUREMENT, {
      source: measurementSource(budget),
      usedPercent,
      // The HOST's id for the turn this number was read from — what makes a redelivered measurement
      // recognisable as one. An id minted here would be a counter of ours.
      turnUuid: usage.turnId || null,
      usedTokens,
      budgetTokens: budget.tokens,
      budgetSource: budget.source,
      windowHostReported: budget.hostReported,
      parts: {
        inputTokens: num(last.inputTokens), cachedInputTokens: num(last.cachedInputTokens),
        cacheWriteInputTokens: num(last.cacheWriteInputTokens), outputTokens: num(last.outputTokens),
        reasoningOutputTokens: num(last.reasoningOutputTokens), totalTokens: num(last.totalTokens),
      },
      mechanism: 'codex app-server: thread/tokenUsage/updated, last.inputTokens over modelContextWindow',
      raw: usage.raw,
      ...(observedAt ? { observedAt } : {}),
    });
    return { measurable: true, usedPercent, usedTokens, budget, record, raw: usage.raw, why: null };
  }

  /** The cycle's latch record, re-armed automatically when the cycle changed. */
  function latches() {
    const read = thresholds.readLatches(state.dir);
    const forCycle = thresholds.forCycle(read.status === 'OK' ? read.record : null, state.machine.cycleId());
    return { ...forCycle, readStatus: read.status };
  }

  function latchFired(ts) {
    if (!ts || !ts.evaluation || !ts.evaluation.fire.length) return { ok: true, latched: [] };
    const l = latches();
    let record = l.record;
    for (const name of ts.evaluation.fire) record = thresholds.latch(record, name, { atPercent: ts.measurement.usedPercent });
    const w = thresholds.writeLatches(state.dir, record);
    return { ok: w.ok, latched: Object.keys(record.latched), detail: w.detail || null };
  }

  function thresholdState({ usage = state.usage } = {}) {
    const m = measureContext({ usage });
    const l = latches();
    const normalized = thresholds.normalize(thresholdConfig);
    if (!normalized.ok) return { measurement: m, latch: l, ok: false, why: normalized.reason, evaluation: { fire: [], crossed: [] } };
    const source = measurementSource(m.budget);
    const evaluation = thresholds.evaluate({
      usedPercent: m.measurable ? m.usedPercent : null,
      source,
      thresholds: normalized.thresholds,
      record: l.record,
    });
    const windowAssumed = Boolean(m.measurable && m.budget && !m.budget.hostReported);
    return {
      ok: true, measurement: m, latch: l, thresholds: normalized.thresholds, source, evaluation, windowAssumed,
      /*
       * core flags a non-HIGH confidence at `final`, and the source above is MEDIUM exactly when the
       * denominator was operator-supplied — so core already covers this. The flag stays as an
       * INDEPENDENT second opinion computed from the budget rather than from the confidence, reported
       * beside core's answer so a suite can assert the two agree. Both say "the number about to stop
       * the session is not fully measured"; the day they disagree, one of them is wrong.
       */
      finalOnAssumedWindow: windowAssumed && evaluation.fire.includes('final'),
      requiresOperatorConfirmation: evaluation.requiresOperatorConfirmation || (windowAssumed && evaluation.fire.includes('final')),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // boundary
  // ---------------------------------------------------------------------------------------------

  /**
   * settleOrStop — reach a boundary without duplicating work.
   *
   * The boundary is the host's own `turn/completed`. A turn still in flight is settled first — by
   * interrupt when the caller asks and the start notification was observed, otherwise by WAITING. A turn
   * whose completion never arrived produces no boundary and gets none invented for it.
   */
  async function settleOrStop({ interrupt = false, timeoutMs = turnTimeoutMs } = {}) {
    if (state.inFlight) {
      if (interrupt) {
        const i = await interruptTurn({ turnId: state.inFlight.turnId });
        if (i.status === STEP.REFUSED) return { status: STEP.CANNOT_DETERMINE, settled: false, why: i.why };
        if (i.status !== STEP.OK) return { status: STEP.CANNOT_DETERMINE, settled: false, why: i.why };
      }
      const done = await awaitTurn({ turnId: state.inFlight.turnId, timeoutMs });
      if (done.status !== STEP.OK) return { status: STEP.CANNOT_DETERMINE, settled: false, why: done.why };
    }
    const t = state.lastTurn;
    if (!t) return { status: STEP.CANNOT_DETERMINE, settled: false, why: 'no turn has been run, so no boundary has been reported' };
    if (t.status !== 'completed' && t.status !== 'interrupted') {
      return {
        status: STEP.CANNOT_DETERMINE, settled: false, turnStatus: t.status,
        why: `the last turn ended with status ${JSON.stringify(t.status)}${t.error ? ` (${JSON.stringify(t.error)})` : ''}, which is not a boundary this profile will build a rollover on`,
      };
    }
    if (t.threadId && state.threadId && t.threadId !== state.threadId) {
      return {
        status: STEP.CANNOT_DETERMINE, settled: false,
        why: `the completed turn reports threadId ${t.threadId} while this supervisor is driving ${state.threadId} — that is a fork, not a boundary`,
      };
    }
    const record = evidence.make(evidence.KINDS.SAFE_BOUNDARY, {
      mechanism: 'app-server-turn-completed',
      detail: `the host emitted turn/completed for ${t.turnId} with status ${t.status}; no new turn has been started`,
      threadId: t.threadId || state.threadId,
      turnId: t.turnId,
      turnUuid: t.turnId,
      raw: t.raw,
      observedAt: now(),
    });
    return { status: STEP.OK, settled: true, record, turnId: t.turnId, turnStatus: t.status };
  }

  // ---------------------------------------------------------------------------------------------
  // handoff staging
  // ---------------------------------------------------------------------------------------------

  function stageHandoff({ measurementRecord, boundaryRecord, fields = {} }) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };

    const cp = m.apply({ transition: 'checkpoint', eventId: eventIdFor('measure', measurementRecord), evidence: [measurementRecord] });
    if (cp.status !== 'APPLIED' && cp.status !== 'NOOP') return stepFrom(cp, 'checkpoint');

    const co = m.apply({ transition: 'closeout', eventId: eventIdFor('boundary', boundaryRecord), evidence: [boundaryRecord] });
    if (co.status !== 'APPLIED' && co.status !== 'NOOP') return stepFrom(co, 'closeout');

    const record = handoff.build({
      identity: { host: HOST, conversationId: state.threadId, conversationIdField: CONVERSATION_ID_FIELD },
      contextCycleId: m.cycleId(),
      ...fields,
    });

    const w = handoff.writeVerified(state.dir, record);
    if (!w.ok) {
      const halted = m.apply({ transition: 'halt', eventId: `handoff-write:${record.handoffId}`, failureCode: w.failure.code, detail: w.failure.detail });
      return { status: STEP.HALTED, failure: w.failure, halt: halted, why: w.failure.detail };
    }

    const staged = m.apply({ transition: 'stage-handoff', eventId: `staged:${record.handoffId}`, evidence: [w.evidence.written] });
    if (staged.status !== 'APPLIED' && staged.status !== 'NOOP') return stepFrom(staged, 'stage-handoff');

    const verified = m.apply({ transition: 'verify-handoff', eventId: `verified:${record.handoffId}`, evidence: [w.evidence.readback] });
    if (verified.status !== 'APPLIED' && verified.status !== 'NOOP') return stepFrom(verified, 'verify-handoff');

    // ⭐ THE INTEROP POINTER. Handoff ids are random, so a Codex SessionStart hook firing into this same
    // runtime directory has no way to discover which document to consume without it. Writing it here is
    // what makes a hooks-installed target able to rehydrate a rollover this supervisor staged — the same
    // file adapters/codex/hooks/_shared.js writes from PreCompact, in the same place, by design.
    const pointer = io.writeAtomicJSON(path.join(state.dir, LATEST_HANDOFF_POINTER), {
      schemaVersion: '1.0.0', kind: 'codex-latest-handoff-pointer',
      handoffId: record.handoffId, cycleIdAtWrite: m.cycleId(), writtenAt: now(),
      writtenBy: 'adapters/codex/app-server/supervisor.js',
    });

    state.pendingHandoff = { handoffId: record.handoffId, handoffPath: w.handoffPath, writtenDigest: w.writtenDigest, document: record, pointerWritten: pointer.ok };
    emit('handoff-verified', state.pendingHandoff);
    return { status: STEP.OK, handoff: state.pendingHandoff, state: m.state() };
  }

  // ---------------------------------------------------------------------------------------------
  // the compaction
  // ---------------------------------------------------------------------------------------------

  /**
   * requestCompact — apply the transition FIRST, then send `thread/compact/start`, then collect the
   * compaction turn's window. The ordering is the enforcement of "no compaction without a verified
   * handoff": from any state but HANDOFF_VERIFIED the apply is REFUSED and nothing is ever sent.
   */
  async function requestCompact({ requestId = null, timeoutMs = compactTimeoutMs } = {}) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    if (!state.conn) return { status: STEP.CANNOT_DETERMINE, why: 'probe() has not established a connection' };

    const rid = requestId || `cr_${crypto.randomBytes(6).toString('hex')}`;
    const requested = evidence.make(evidence.KINDS.COMPACT_REQUESTED, {
      mechanism: 'app-server-thread-compact',
      mechanismDetail: `${COMPACT_METHOD} {threadId:"${state.threadId}"} over the app-server JSON-RPC transport`,
      command: COMPACT_METHOD,
      requestId: rid,
      threadId: state.threadId,
      // The verbatim REQUEST. The host's ack is carried on the observation below, where it belongs.
      raw: { method: COMPACT_METHOD, params: { threadId: state.threadId }, at: now() },
      observedAt: now(),
    });

    const applied = m.apply({ transition: 'request-compact', eventId: `compact-req:${rid}`, evidence: [requested] });
    if (applied.status !== 'APPLIED') return { ...stepFrom(applied, 'request-compact'), sent: false, requestId: rid };

    const cursor = state.conn.notificationCount();
    const t0 = Date.now();
    const ack = await state.conn.send(COMPACT_METHOD, { threadId: state.threadId }, { timeoutMs: requestTimeoutMs });
    if (!ack.ok) {
      const detail = `${COMPACT_METHOD} answered ${ack.kind}: ${ack.detail}`;
      const halted = m.apply({ transition: 'halt', eventId: `compact-refused:${rid}`, failureCode: 'COMPACT_REQUEST_REFUSED', detail });
      return { status: STEP.HALTED, sent: true, requestId: rid, failure: halted.failure, machineResult: halted, why: detail, ackRaw: ack.raw || null };
    }

    // ⛔ THE ACK IS `{}` AND MEANS ONLY THAT THE CALL WAS ACCEPTED. What is waited for is the compaction
    // TURN completing on this thread; the wait's expiry is recorded as a clock reading, never a verdict.
    const done = await state.conn.waitFor(
      (n) => n.method === 'turn/completed' && isObj(n.params) && n.params.threadId === state.threadId,
      { from: cursor, timeoutMs, label: `the compaction turn's turn/completed on ${state.threadId}` },
    );
    const window = state.conn.since(cursor);
    absorbUsage(window);
    const waitedMs = Date.now() - t0;

    const compactTurnId = done.ok && isObj(done.note.params.turn) ? done.note.params.turn.id : null;
    if (compactTurnId) state.compactionTurnIds.add(compactTurnId);
    const record = persistTurn('compact', {
      turnId: compactTurnId, prompt: '', request: JSON.stringify({ method: COMPACT_METHOD, params: { threadId: state.threadId } }),
      response: done.ok ? done.note.raw : null, status: done.ok && isObj(done.note.params.turn) ? done.note.params.turn.status : null,
      window, timedOut: !done.ok, detail: done.ok ? null : done.detail,
    });

    return {
      status: STEP.OK, sent: true, requestId: rid, waitedMs, window, record,
      ackRaw: ack.raw, ack: ack.result,
      turnCompleted: done.ok ? done.note : null,
      turnCompletedDetail: done.ok ? null : done.detail,
      compactTurnId,
    };
  }

  /**
   * observeCompact — the verdict, and the ONLY place a compaction is called complete.
   *
   * COMPLETED requires a `contextCompaction` item reaching `item/completed` ON THIS THREAD. Everything
   * else — an ack with no item, an item that started and never completed, a wait that expired — is
   * COMPLETION_UNOBSERVED, which is CANNOT_DETERMINE and halts. A `turn/completed` with no item is
   * additionally flagged as a NO-OP CANDIDATE and explicitly NOT resolved: a genuine no-op has never
   * been observed on this host, so "the host declined" and "the item was not emitted" cannot be told
   * apart from here, and inventing the distinction is exactly the guess this pack refuses.
   */
  function observeCompact({ window = [], waitedMs = null, expectedThreadId = state.threadId, turnCompleted = null, compactTurnId = null } = {}) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };

    const items = (window || []).filter((n) => (n.method === 'item/started' || n.method === 'item/completed')
      && isObj(n.params) && isObj(n.params.item) && n.params.item.type === 'contextCompaction');
    const onThread = items.filter((n) => n.params.threadId === expectedThreadId);
    const offThread = items.filter((n) => n.params.threadId !== expectedThreadId);
    const startedItems = onThread.filter((n) => n.method === 'item/started');
    const completedItems = onThread.filter((n) => n.method === 'item/completed');

    const verdict = {
      startedCount: startedItems.length,
      completedCount: completedItems.length,
      offThreadCount: offThread.length,
      turnStatus: turnCompleted && isObj(turnCompleted.params) && isObj(turnCompleted.params.turn) ? turnCompleted.params.turn.status : null,
      methods: (window || []).map((n) => n.method),
      ackObserved: true,
    };
    emit('compact-verdict', verdict);

    // A compaction turn the host FAILED is a refusal, not a non-observation.
    if (verdict.turnStatus === 'failed') {
      const detail = `the compaction turn ${compactTurnId} completed with status "failed"${turnCompleted && turnCompleted.params.turn && turnCompleted.params.turn.error ? `: ${JSON.stringify(turnCompleted.params.turn.error)}` : ''}`;
      const halted = m.apply({ transition: 'halt', eventId: `compact-failed:${compactTurnId || io.digest(String(verdict.methods))}`, failureCode: 'COMPACT_REQUEST_REFUSED', detail });
      return { status: STEP.HALTED, verdict, failure: halted.failure, machineResult: halted, why: detail, turnFile: lastTurnFile() };
    }

    if (completedItems.length) {
      const note = completedItems[completedItems.length - 1];
      const itemId = note.params.item.id;
      const pairObserved = startedItems.some((s) => s.params.item.id === itemId);
      // ⛔ A PERSISTED-STYLE ITEM ID NEVER KEYS AN EVENT. `item-3` is what a resumed thread renumbers to;
      // two different compactions on two different threads would collide on it.
      const synthetic = isPersistedItemId(itemId);
      const hostEventId = synthetic ? `turn:${compactTurnId || 'unknown'}` : `item:${itemId}`;

      const completed = evidence.make(evidence.KINDS.COMPACT_COMPLETED, {
        signal: COMPLETION_SIGNAL,
        mechanism: 'app-server contextCompaction item/completed',
        threadId: note.params.threadId,
        turnId: note.params.turnId || compactTurnId || null,
        itemId,
        itemIdIsPersistedStyle: synthetic,
        pairObserved,
        durationMs: Number.isFinite(waitedMs) ? waitedMs : null,
        // Verbatim: both halves of the pair when both were seen, so a later reader can re-check the
        // pairing rather than take this record's word for it.
        raw: JSON.stringify({ started: startedItems.map((s) => s.raw), completed: completedItems.map((c) => c.raw), turnCompleted: turnCompleted ? turnCompleted.raw : null }),
        observedAt: now(),
      });

      const applied = m.apply({ transition: 'observe-completion', eventId: `boundary:${hostEventId}`, evidence: [completed] });
      if (applied.status === 'NOOP') {
        // A REDELIVERED item. The machine recognised it and returned the original result; nothing
        // advances twice. This is why the host's own item id is the event id rather than a counter.
        return { status: STEP.NOOP, noopKind: 'duplicate-event', verdict, duplicateOf: applied.duplicateOf, original: applied.original, machineResult: applied };
      }
      if (applied.status !== 'APPLIED') return { ...stepFrom(applied, 'observe-completion'), verdict };

      return { status: STEP.OK, verdict, completed, hostEventId, itemId, pairObserved, compactTurnId: compactTurnId || note.params.turnId || null };
    }

    // --- nothing was observed --------------------------------------------------------------------
    const noopCandidate = Boolean(turnCompleted) && startedItems.length === 0;
    const reason = turnCompleted
      ? 'no-signal'
      : (waitedMs === null ? 'no-signal' : 'stream-closed');
    const detail = turnCompleted
      ? `the host acknowledged ${COMPACT_METHOD} and completed a turn on this thread WITHOUT emitting a contextCompaction item. `
        + 'That is either a no-op compaction or a completion this adapter did not observe; a real no-op has never been observed on this host, '
        + `so which one it is is CANNOT_DETERMINE. Verbatim window: ${lastTurnFile() || 'not persisted'}`
      : `the compaction turn's turn/completed never arrived within ${waitedMs}ms — an observation of a clock, not of a compaction. `
        + `${startedItems.length} contextCompaction item/started and 0 item/completed were seen. Verbatim window: ${lastTurnFile() || 'not persisted'}`;

    const unobserved = evidence.make(evidence.KINDS.COMPACT_UNOBSERVED, {
      reason,
      waitedMs: Number.isFinite(waitedMs) ? waitedMs : -1,
      noopCandidate,
      detail,
      raw: JSON.stringify({ methods: verdict.methods, lines: (window || []).map((n) => n.raw), turnCompleted: turnCompleted ? turnCompleted.raw : null }),
      observedAt: now(),
    });
    const halted = m.apply({
      transition: 'halt',
      eventId: `compact-unobserved:${io.digest(String(compactTurnId || verdict.methods.join(',')))}`,
      failureCode: 'COMPLETION_UNOBSERVED', detail,
    });
    return { status: STEP.HALTED, verdict, unobserved, noopCandidate, failure: halted.failure, machineResult: halted, turnFile: lastTurnFile() };
  }

  const lastTurnFile = () => (state.turns.length ? state.turns[state.turns.length - 1].file : null);

  /**
   * verifyIdentity — EMPIRICALLY, per rollover, from TWO independent observations: the threadId the host
   * put on the compaction item, and a `thread/resume` re-check that re-passes the policy.
   *
   * The resume half is not decoration. It is the only check that would notice a host quietly answering
   * from a different thread after a compaction, and it doubles as the proof that re-passing
   * approvalPolicy took — the response reports the policy the thread is actually running under.
   */
  async function verifyIdentity({ expectedId = state.threadId, observedId = null, hostEventId = 'identity', rawParts = null, resumeCheck = true } = {}) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };

    let resume = null;
    if (resumeCheck) {
      const r = await resumeThread({ threadId: expectedId });
      resume = r.status === STEP.OK
        ? { status: 'OK', observedId: r.observedId, policyRepassHeld: r.policyRepassHeld, observedPolicy: r.observedPolicy, raw: r.raw }
        : { status: 'CANNOT_DETERMINE', observedId: null, why: r.why, raw: r.raw || null };
    }

    // The item's threadId is the primary observation. A resume that DISAGREES overrides it to false —
    // two observations that disagree are never resolved in this adapter's favour.
    let equal = observedId === null ? null : observedId === expectedId;
    if (resume && resume.status === 'OK' && resume.observedId && resume.observedId !== expectedId) equal = false;

    const record = evidence.make(evidence.KINDS.IDENTITY_VERIFICATION, {
      expectedId: String(expectedId || ''),
      observedId: observedId || null,
      equal,
      field: CONVERSATION_ID_FIELD,
      tag: hostEventId,
      resumeCheck: resume,
      raw: JSON.stringify({ observedOnItem: rawParts || null, resume: resume ? resume.raw : null }),
      observedAt: now(),
    });

    if (!expectedId) {
      return { status: STEP.CANNOT_DETERMINE, why: 'there is no expected thread id to compare against', record, resume };
    }

    const applied = m.apply({ transition: 'verify-identity', eventId: `identity:${hostEventId}`, evidence: [record] });
    if (applied.status === 'NOOP') return { status: STEP.NOOP, duplicateOf: applied.duplicateOf, machineResult: applied, observedId, resume };
    if (applied.status !== 'APPLIED') return { ...stepFrom(applied, 'verify-identity'), observedId, record, resume };

    emit('identity-verified', { expectedId, observedId, cycleId: m.cycleId(), policyRepassHeld: resume ? resume.policyRepassHeld : null });
    return {
      status: STEP.OK, observedId, record, resume,
      cycleAdvanced: applied.cycleAdvanced === true, cycleId: m.cycleId(), cycleIndex: m.cycleIndex(), machineResult: applied,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // injection and the exactly-once continue
  // ---------------------------------------------------------------------------------------------

  /**
   * injectHandoff — claim the verified handoff EXACTLY ONCE and render it for the next prompt.
   *
   * ⛔ CLAIM FIRST, THEN SEND. The receipt is created before the continuation goes out, so a crash in
   * that window LOSES a delivery rather than DUPLICATING one. That direction is deliberate: a lost
   * delivery is recoverable by reading the receipt, a duplicated atomic action is not recoverable at all.
   */
  function injectHandoff({ handoffId = state.pendingHandoff && state.pendingHandoff.handoffId, nextPrompt = '' } = {}) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    if (!handoffId) return { status: STEP.CANNOT_DETERMINE, why: 'there is no verified handoff to inject' };

    const r = handoff.consume(state.dir, handoffId, { consumerId: myConsumerId });
    m.journalConsumption({ handoffId, status: r.status, consumerId: myConsumerId, receiptPath: r.receiptPath || null, cycleId: m.cycleId() });

    if (r.status === 'ALREADY_CONSUMED') {
      emit('handoff-already-consumed', r);
      return {
        status: STEP.NOOP, consumed: false, alreadyConsumed: true,
        firstConsumption: r.firstConsumption, receiptPath: r.receiptPath,
        why: `handoff ${handoffId} was already consumed by ${r.firstConsumption && r.firstConsumption.consumerId} at ${r.firstConsumption && r.firstConsumption.consumedAt}; it is not delivered a second time`,
      };
    }
    if (r.status !== 'CONSUMED') {
      return { status: r.status === 'REFUSED' ? STEP.REFUSED : STEP.CANNOT_DETERMINE, failure: r.failure, why: r.failure && r.failure.detail };
    }

    state.pendingHandoff = null;
    const prompt = `${render(r.handoff)}\n\n${nextPrompt}`.trim();
    emit('handoff-consumed', { handoffId, receiptPath: r.receiptPath });
    return { status: STEP.OK, consumed: true, handoff: r.handoff, receipt: r.receipt, receiptPath: r.receiptPath, prompt };
  }

  /**
   * The continuation, sent EXACTLY ONCE per context cycle. The cycle id is the key and it is the right
   * one: a compacted thread keeps its threadId, so a receipt keyed on the thread would block the second
   * rollover's continuation as a duplicate of the first.
   */
  async function continueOnce({ prompt, label = 'continue' }) {
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    const cycleId = m.cycleId();
    const receiptPath = machine.receiptPathFor(state.dir, `continue-${cycleId}`);
    const claim = consumable.consume(receiptPath, {
      subjectId: `continue:${cycleId}`, consumerId: myConsumerId,
      note: 'the post-rollover continuation prompt for this context cycle',
      extra: { cycleId, promptDigest: io.digest(String(prompt || '')) },
    });
    if (claim.status === 'ALREADY_CONSUMED') {
      return {
        status: STEP.NOOP, sent: false, receiptPath, firstConsumption: claim.firstConsumption,
        why: `the continuation for cycle ${cycleId} was already sent by ${claim.firstConsumption && claim.firstConsumption.consumerId}; this supervisor will not send it twice`,
      };
    }
    if (claim.status !== 'CONSUMED') return { status: STEP.CANNOT_DETERMINE, failure: claim.failure, why: claim.failure && claim.failure.detail };

    const ran = await turn({ prompt, label });
    return { status: ran.status, sent: true, receiptPath, ...ran };
  }

  /** The handoff as text. IDS ONLY for candidate memories — an unverified lead must not read as a fact. */
  function render(doc) {
    const lines = [];
    lines.push(`<respawnpack-handoff schema="${doc.schemaVersion}" handoff="${doc.handoffId}" cycle="${doc.contextCycleId}">`);
    lines.push('This thread was compacted in place by RespawnPack. What follows was written and read back');
    lines.push('BEFORE the compaction, and is delivered exactly once.');
    lines.push('');
    lines.push(`EXACT NEXT ACTION: ${doc.exactNextAction || '(none was recorded — re-derive it from the facts below before acting)'}`);
    if (doc.atomicActionId) lines.push(`ATOMIC ACTION: ${doc.atomicActionId}`);
    lines.push(`GIT HEAD: ${doc.git.head || 'unknown'}`);
    if (doc.git.uncommittedFiles.length) {
      lines.push(`UNCOMMITTED (${doc.git.uncommittedFiles.length}${doc.git.uncommittedTruncated ? '+, truncated' : ''}): ${doc.git.uncommittedFiles.join(', ')}`);
    }
    if (doc.userConstraints.length) { lines.push('USER CONSTRAINTS:'); doc.userConstraints.forEach((c) => lines.push(`  · ${c}`)); }
    if (doc.verificationEvidence.length) { lines.push('VERIFIED THIS CYCLE:'); doc.verificationEvidence.forEach((e) => lines.push(`  · ${typeof e === 'string' ? e : JSON.stringify(e)}`)); }
    if (doc.unresolvedQuestions.length) { lines.push('UNRESOLVED:'); doc.unresolvedQuestions.forEach((q) => lines.push(`  · ${q}`)); }
    if (doc.candidateMemories.length) lines.push(`CANDIDATE MEMORIES (ids only — unverified leads, not facts): ${doc.candidateMemories.join(', ')}`);
    lines.push('</respawnpack-handoff>');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------------------------
  // the rollover
  // ---------------------------------------------------------------------------------------------

  /**
   * One complete rollover: checkpoint → closeout → staged+verified handoff → thread/compact/start →
   * observed contextCompaction item → verified identity → consumed handoff → exactly-one continuation.
   *
   * Nothing here decides that a rollover happened; the machine's cycle advance does, and this reports it.
   */
  async function rollover({ handoffFields = {}, nextPrompt = '', force = false } = {}) {
    const started = now();
    const m = state.machine;
    if (!m) return { status: STEP.CANNOT_DETERMINE, why: 'no conversation is attached' };
    if (m.halted()) return { status: STEP.HALTED, failure: m.halted(), why: 'this rollover halted; nothing resumes past a halt' };
    if (state.conn && state.conn.approvalHalt && state.conn.approvalHalt()) {
      const req = state.conn.approvalHalt();
      const detail = `the host asked this client to approve ${req.method} mid-run; RespawnPack denied it by default and stops. Verbatim request: ${req.raw}`;
      const halted = m.apply({ transition: 'halt', eventId: `approval:${req.method}:${req.id}`, failureCode: 'COMPACT_REQUEST_REFUSED', detail });
      return { status: STEP.HALTED, rolled: false, phase: 'approval-denied', failure: halted.failure, approvalRequest: req, why: detail };
    }

    const ts = thresholdState();
    if (!force && !ts.evaluation.fire.includes('final')) {
      return {
        status: STEP.CANNOT_DETERMINE, rolled: false,
        why: ts.measurement.measurable
          ? `occupancy is ${ts.measurement.usedPercent.toFixed(1)}% and the final threshold (${ts.thresholds.final}%) has not fired in this cycle — pass force:true to roll over anyway`
          : `context is unmeasured (${ts.measurement.why}), and an unmeasured context is CANNOT_DETERMINE, never 0%`,
        thresholdState: ts,
      };
    }

    const boundary = await settleOrStop();
    if (boundary.status !== STEP.OK) return { status: boundary.status, rolled: false, why: boundary.why, phase: 'settle', thresholdState: ts };

    const measurement = ts.measurement.record || measureContext().record;
    if (!measurement) {
      return {
        status: STEP.CANNOT_DETERMINE, rolled: false, phase: 'checkpoint',
        why: 'there is no context measurement to checkpoint on. A forced rollover still needs a measurement record, because the machine gates the checkpoint on one.',
        thresholdState: ts,
      };
    }

    const staged = stageHandoff({ measurementRecord: measurement, boundaryRecord: boundary.record, fields: handoffFields });
    if (staged.status !== STEP.OK) return { ...staged, rolled: false, phase: 'stage-handoff' };

    // ⭐ LATCH WHAT FIRED, KEYED ON THE CYCLE. A rollover advances the cycle and core's forCycle re-arms
    // every threshold as a consequence of the keying rather than as a special case anyone remembers.
    latchFired(ts);

    const cycleBefore = { id: m.cycleId(), index: m.cycleIndex() };
    const expectedThreadId = state.threadId;

    const requested = await requestCompact();
    if (requested.status !== STEP.OK) return { ...requested, rolled: false, phase: 'request-compact', cycleBefore };

    const observed = observeCompact({
      window: requested.window, waitedMs: requested.waitedMs, expectedThreadId,
      turnCompleted: requested.turnCompleted, compactTurnId: requested.compactTurnId,
    });
    if (observed.status !== STEP.OK) return { ...observed, rolled: false, phase: 'observe-compact', cycleBefore };

    const identity = await verifyIdentity({
      expectedId: expectedThreadId,
      observedId: observed.completed.threadId || null,
      hostEventId: observed.hostEventId,
      rawParts: observed.completed.raw,
    });
    if (identity.status !== STEP.OK) return { ...identity, verdict: observed.verdict, rolled: false, phase: 'verify-identity', cycleBefore };

    const injected = injectHandoff({ handoffId: staged.handoff.handoffId, nextPrompt });
    if (injected.status !== STEP.OK) {
      return { ...injected, rolled: true, phase: 'inject-handoff', cycleBefore, cycleAfter: { id: m.cycleId(), index: m.cycleIndex() }, identity, compaction: observed.verdict };
    }

    const continued = await continueOnce({ prompt: injected.prompt });
    const result = {
      status: continued.status === STEP.OK ? STEP.OK : continued.status,
      rolled: true, phase: 'complete',
      startedAt: started, endedAt: now(),
      cycleBefore, cycleAfter: { id: m.cycleId(), index: m.cycleIndex() },
      identity, compaction: observed.verdict, completed: observed.completed,
      handoffId: staged.handoff.handoffId, receiptPath: injected.receiptPath,
      continuation: continued, injectedPrompt: injected.prompt,
      compactTurnId: observed.compactTurnId || requested.compactTurnId || null,
    };
    state.rollovers.push(result);
    emit('rollover', result);
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------

  /**
   * A host occurrence's id: the host's own id when it gave one, otherwise the digest of its bytes.
   * NEVER a counter of ours — the machine suppresses duplicates on this id ACROSS cycles.
   */
  function eventIdFor(prefix, record) {
    if (record && typeof record.turnUuid === 'string' && record.turnUuid && !isPersistedItemId(record.turnUuid)) return `${prefix}:${record.turnUuid}`;
    const text = record && record.raw !== undefined ? (typeof record.raw === 'string' ? record.raw : JSON.stringify(record.raw)) : String(Math.random());
    return `${prefix}:${io.digest(text).slice(0, 32)}`;
  }

  function stepFrom(applied, transition) {
    if (applied.status === 'HALTED') return { status: STEP.HALTED, transition, failure: applied.failure, machineResult: applied, why: applied.failure && applied.failure.detail };
    if (applied.status === 'REFUSED') return { status: STEP.REFUSED, transition, failure: applied.failure, machineResult: applied, why: applied.failure && applied.failure.detail };
    return { status: STEP.CANNOT_DETERMINE, transition, machineResult: applied, why: `the machine answered ${applied.status} for ${transition}` };
  }

  function close() { if (state.conn) { try { state.conn.close(); } catch { /* already gone */ } } }

  return {
    // capabilities
    probe, measureContext, settleOrStop, requestCompact, observeCompact, verifyIdentity, injectHandoff,
    // orchestration
    attach, startThread, resumeThread, startTurn, awaitTurn, turn, interruptTurn, stageHandoff, continueOnce,
    rollover, thresholdState, latches, latchFired, render, close,
    // introspection — read-only views for reports and tests
    threadId: () => state.threadId,
    dir: () => state.dir,
    machine: () => state.machine,
    connection: () => state.conn,
    turns: () => state.turns.slice(),
    rollovers: () => state.rollovers.slice(),
    usage: () => (state.usage ? { ...state.usage } : null),
    pendingHandoff: () => (state.pendingHandoff ? { ...state.pendingHandoff } : null),
    probeResult: () => state.probeResult,
    schema: () => state.schema,
    resolution: () => state.resolution,
    inFlight: () => (state.inFlight ? { ...state.inFlight } : null),
    consumerId: () => myConsumerId,
    options: () => ({ projectDir, cwd: cwd || projectDir, sandbox, approvalPolicy, model, contextWindowTokens, thresholdConfig, turnTimeoutMs, compactTimeoutMs }),
  };
}

module.exports = {
  createSupervisor, STEP, HOST, CONVERSATION_ID_FIELD, COMPACT_METHOD, COMPLETION_SIGNAL,
  MEASUREMENT_SOURCE, LATEST_HANDOFF_POINTER, isPersistedItemId,
};
