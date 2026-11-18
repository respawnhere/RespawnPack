/*
 * RespawnPack · adapters/providers/turn-codex.js — one bounded turn on the OpenAI family, through the
 * Codex app-server transport the pack already speaks.
 *
 * Spec: the class audit Class G, "Providers" ("OpenAI through the existing Codex app-server transport
 * (`thread/start`, one `turn`, read-only sandbox, approval policy never), which uses the operator's
 * account sign-in and never a key").
 *
 * ⛔ THIS IS NOT adapters/codex/app-server/supervisor.js, AND THE DIFFERENCE IS DELIBERATE. That
 * supervisor manages a long conversation across compaction boundaries: it opens a machine under the
 * project directory, writes a journal, persists every turn window and stages handoffs. An offload is one
 * bounded unit of work with one receipt, so it takes the transport and nothing else. Running it through
 * the supervisor would leave a conversation directory and a journal inside a target that asked for one
 * answer, which is state a bounded unit has no business creating.
 *
 * ⛔ THE POLICY IS ASKED FOR AND THEN READ BACK, AND A HOST THAT CONTRADICTS IT IS REFUSED. `thread/start`
 * is sent with `sandbox: 'read-only'` and `approvalPolicy: 'never'`, and the thread's own answer carries
 * what it is actually running under. Those two settings are the whole of what makes an unattended turn
 * safe here, so "we asked for it" is not the same observation as "the host says it is in force" (the
 * supervisor's own words, and the same reason). A host that answers with a different approval policy or
 * a writable sandbox gets `kind: 'POLICY'` and no turn is started. A host that reports nothing at all is
 * recorded as having reported nothing and the turn proceeds, because the absence of a field is not a
 * statement that the policy was ignored, and refusing on it would make this module unusable against any
 * host version that does not echo it.
 *
 * ⛔ NO CREDENTIAL PASSES THROUGH THIS FILE. This family authenticates through the operator's own Codex
 * sign-in, held by the Codex CLI. Nothing here reads an environment variable holding a key, and there is
 * no parameter one could be passed in through. Anti-drift item 52 has nothing to bite on here, which is
 * the point of recording it: the one provider that holds a key is the OpenAI-compatible HTTP client, and
 * this is not it.
 *
 * ⛔ AND NO ELAPSED CLOCK IS A COMPLETION (anti-drift item 38). A `turn/completed` that never arrived is
 * `TIMEOUT` carrying the wait, never a turn that produced a short answer; a turn whose own status is not
 * `completed` is `TURN_FAILED` carrying the host's status; a completed turn with no assistant message is
 * `EMPTY`. Three findings, three repairs.
 */

'use strict';

const path = require('path');

const rpcLib = require(path.join(__dirname, '..', 'codex', 'app-server', 'rpc.js'));

/** This provider's own name on the receipt. */
const PROVIDER = 'codex-app-server';

/** The register family this module speaks for. */
const FAMILY = 'openai';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const TURN_STARTED_TIMEOUT_MS = 30 * 1000;

/** The policy one bounded, unattended offload runs under. Sent, then read back and checked. */
const SANDBOX = 'read-only';
const APPROVAL_POLICY = 'never';

const TURN_FAILURE = {
  NO_BINARY: 'NO_BINARY',       // no codex.js resolved, so nothing was spawned
  CONNECT: 'CONNECT',           // the app-server did not complete the initialize handshake
  POLICY: 'POLICY',             // the thread reported a policy this offload will not run under
  THREAD_START: 'THREAD_START', // thread/start did not answer, or answered with no thread id
  TURN_START: 'TURN_START',     // turn/start did not answer, or answered with no turn id
  TIMEOUT: 'TIMEOUT',           // turn/completed never arrived within the deadline
  TURN_FAILED: 'TURN_FAILED',   // the host's own turn status was not "completed"
  EMPTY: 'EMPTY',               // a completed turn carrying no assistant message
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The assistant text of one completed turn: the `agentMessage` items, in the order the host listed them. */
function agentText(turn, window) {
  const items = isObj(turn) && Array.isArray(turn.items) ? turn.items : [];
  const fromItems = items.filter((i) => isObj(i) && i.type === 'agentMessage' && typeof i.text === 'string').map((i) => i.text);
  if (fromItems.length) return fromItems.join('\n').trim();
  /*
   * The summary view of a turn may carry no items at all. The notification window is the other place
   * the same messages arrived, so it is read as a FALLBACK rather than as a second source of truth: a
   * host that reported items is believed about its own turn.
   */
  const fromWindow = (window || [])
    .filter((n) => n && n.method === 'item/completed' && isObj(n.params) && isObj(n.params.item)
      && n.params.item.type === 'agentMessage' && typeof n.params.item.text === 'string')
    .map((n) => n.params.item.text);
  return fromWindow.join('\n').trim();
}

/** Token usage for this turn, from the host's own `thread/tokenUsage/updated` for it. */
function usageFrom(window) {
  for (let i = (window || []).length - 1; i >= 0; i -= 1) {
    const n = window[i];
    if (!n || n.method !== 'thread/tokenUsage/updated' || !isObj(n.params)) continue;
    const last = isObj(n.params.tokenUsage) ? (n.params.tokenUsage.last || n.params.tokenUsage.total) : null;
    if (!isObj(last)) continue;
    const input = Number(last.inputTokens);
    const output = Number(last.outputTokens);
    return { input: Number.isFinite(input) ? input : null, output: Number.isFinite(output) ? output : null };
  }
  return { input: null, output: null };
}

/**
 * Does the observed policy contradict the one this offload asked for? Only a REPORTED disagreement
 * counts; an absent field is recorded and never read as a refusal.
 *
 * @returns {string|null} the disagreement in words, or null
 */
function policyDisagreement(observed) {
  if (!isObj(observed)) return null;
  if (typeof observed.approvalPolicy === 'string' && observed.approvalPolicy !== APPROVAL_POLICY) {
    return `the thread reports approvalPolicy ${JSON.stringify(observed.approvalPolicy)} and this offload asked for ${JSON.stringify(APPROVAL_POLICY)}`;
  }
  const sandbox = observed.sandbox;
  const type = isObj(sandbox) ? sandbox.type : sandbox;
  if (typeof type === 'string' && !/^read[-_]?only$/i.test(type)) {
    return `the thread reports a ${JSON.stringify(type)} sandbox and this offload asked for a read-only one`;
  }
  return null;
}

/**
 * Is a Codex turn reachable from this process?
 *
 * The block's own definition: the binary resolves AND `initialize` answers. Both halves run here, and
 * the connection is closed immediately — the handshake completes before any credential is used, so it
 * costs nothing and proves nothing about the sign-in, which is settled by the turn.
 *
 * @param {{resolveCodexJs?:Function, connect?:Function, env?:object, cwd?:string, handshake?:boolean}} opts
 * @returns {Promise<{ok:boolean, why:string, detail:object|null}>}
 */
async function probe({
  resolveCodexJs = rpcLib.resolveCodexJs,
  connect = rpcLib.connect,
  env = process.env,
  cwd = undefined,
  handshake = true,
} = {}) {
  const resolved = resolveCodexJs({ env });
  if (!resolved || !resolved.ok) {
    return { ok: false, why: (resolved && resolved.detail) || 'no codex.js could be resolved', detail: null };
  }
  if (!handshake) {
    return { ok: true, why: `a codex.js resolved via ${resolved.via}; the initialize handshake was not attempted`, detail: { via: resolved.via || null, handshake: false } };
  }
  const c = await connect({ codexJs: resolved.codexJs, cwd, env, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  if (!c || !c.ok) {
    try { if (c && c.conn) c.conn.close(); } catch { /* already gone */ }
    return { ok: false, why: `codex app-server resolved but did not complete the initialize handshake: ${(c && c.detail) || 'no answer'}`, detail: { via: resolved.via || null, handshake: false } };
  }
  try { c.conn.close(); } catch { /* already gone */ }
  return {
    ok: true,
    why: `a codex.js resolved via ${resolved.via} and answered the initialize handshake. The handshake completes before credentials are used, so it says nothing about the sign-in.`,
    detail: { via: resolved.via || null, handshake: true },
  };
}

/**
 * One bounded turn on a fresh thread, under a read-only sandbox with approvals off.
 *
 * @param {{prompt:string, model?:string|null, cwd?:string, timeoutMs?:number,
 *          resolveCodexJs?:Function, connect?:Function, env?:object}} opts
 * @returns {Promise<{ok:true, text, usage, model, kind:null, durationMs, policy}
 *                 | {ok:false, text:null, usage, model, kind, detail, durationMs, policy}>}
 */
async function runTurn({
  prompt,
  model = null,
  cwd = undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  resolveCodexJs = rpcLib.resolveCodexJs,
  connect = rpcLib.connect,
  env = process.env,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.length) {
    throw new Error('adapters/providers/turn-codex.js runTurn: `prompt` must be a non-empty string');
  }
  const startedAt = Date.now();
  const base = { text: null, usage: { input: null, output: null }, model: model || null, policy: null };
  const fail = (kind, detail, extra = {}) => ({ ok: false, ...base, ...extra, kind, detail, durationMs: Date.now() - startedAt });

  const resolved = resolveCodexJs({ env });
  if (!resolved || !resolved.ok) {
    return fail(TURN_FAILURE.NO_BINARY, `no codex.js could be resolved: ${(resolved && resolved.detail) || 'nothing on PATH'}`);
  }

  const c = await connect({ codexJs: resolved.codexJs, cwd, env, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  if (!c || !c.ok) {
    try { if (c && c.conn) c.conn.close(); } catch { /* already gone */ }
    return fail(TURN_FAILURE.CONNECT, `the initialize handshake did not complete: ${(c && c.detail) || 'no answer'}`);
  }
  const conn = c.conn;

  try {
    const params = { cwd, sandbox: SANDBOX, approvalPolicy: APPROVAL_POLICY, ...(model ? { model } : {}) };
    const started = await conn.send('thread/start', params, { timeoutMs: REQUEST_TIMEOUT_MS });
    if (!started.ok) {
      return fail(TURN_FAILURE.THREAD_START, `thread/start answered ${started.kind}: ${started.detail}`);
    }
    const threadId = started.result && started.result.thread && started.result.thread.id;
    if (typeof threadId !== 'string' || !threadId) {
      return fail(TURN_FAILURE.THREAD_START, 'thread/start returned no thread id, so there is no conversation this turn could belong to');
    }

    // The thread's OWN report of what it is running under, recorded before a single token is spent.
    const policy = {
      approvalPolicy: (started.result && started.result.approvalPolicy) || null,
      sandbox: (started.result && started.result.sandbox) || null,
    };
    const disagreement = policyDisagreement(started.result);
    if (disagreement) {
      return fail(TURN_FAILURE.POLICY, `${disagreement}. No turn was started: a bounded offload runs under a read-only sandbox with approvals off, and a host that says otherwise is refused rather than trusted.`, { policy });
    }

    const cursor = conn.notificationCount();
    const turnStart = await conn.send('turn/start', { threadId, input: [{ type: 'text', text: prompt }] }, { timeoutMs: REQUEST_TIMEOUT_MS });
    if (!turnStart.ok) {
      return fail(TURN_FAILURE.TURN_START, `turn/start answered ${turnStart.kind}: ${turnStart.detail}`, { policy });
    }
    const turnId = turnStart.result && turnStart.result.turn && turnStart.result.turn.id;
    if (typeof turnId !== 'string' || !turnId) {
      return fail(TURN_FAILURE.TURN_START, 'turn/start returned no turn id', { policy });
    }

    // `turn/start` answers with a stub before the turn is really running; the notification is the start.
    await conn.waitFor(
      (n) => n.method === 'turn/started' && isObj(n.params) && isObj(n.params.turn) && n.params.turn.id === turnId,
      { from: cursor, timeoutMs: TURN_STARTED_TIMEOUT_MS, label: `turn/started for ${turnId}` },
    );

    const done = await conn.waitFor(
      (n) => n.method === 'turn/completed' && isObj(n.params) && isObj(n.params.turn) && n.params.turn.id === turnId,
      { from: cursor, timeoutMs, label: `turn/completed for ${turnId}` },
    );
    const window = conn.since(cursor);
    const usage = usageFrom(window);

    if (!done.ok) {
      return fail(TURN_FAILURE.TIMEOUT, `${done.detail}. The turn may still be running on the host; nothing about an elapsed wait is evidence of what it produced.`, { policy, usage });
    }

    const turn = (done.note.params && done.note.params.turn) || {};
    if (turn.status && turn.status !== 'completed') {
      return fail(TURN_FAILURE.TURN_FAILED, `the host reported turn status ${JSON.stringify(turn.status)}${turn.error ? ` (${JSON.stringify(turn.error).slice(0, 200)})` : ''}`, { policy, usage });
    }

    const text = agentText(turn, window);
    if (!text) {
      return fail(TURN_FAILURE.EMPTY, 'the turn completed and carried no assistant message, so there is no answer. That is an answer with nothing in it, not a failure of the request.', { policy, usage });
    }

    return {
      ok: true,
      text,
      usage,
      model: model || null,
      kind: null,
      policy,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    try { conn.close(); } catch { /* already gone */ }
  }
}

module.exports = {
  PROVIDER, FAMILY, TURN_FAILURE, SANDBOX, APPROVAL_POLICY,
  DEFAULT_TIMEOUT_MS, agentText, usageFrom, policyDisagreement, probe, runTurn,
};
