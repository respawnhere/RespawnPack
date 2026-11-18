/*
 * RespawnPack · adapters/openai-compatible/client.js — ONE generic client for ANY provider that speaks
 * the OpenAI chat-completions protocol, configured by name, base URL, an environment variable's NAME
 * and a model list. Never by a key value.
 *
 * Spec: the class audit Class G ("Providers", "Canaries"); the owner's brief for the second run, item 6 (MiniMax through
 * a key the owner holds, read from the environment only, never from the repo, never from chat, never
 * written anywhere; one generic adapter for MiniMax and any future provider that speaks the protocol).
 *
 * ⛔ ANTI-DRIFT ITEM 52 IS THE WHOLE DESIGN OF THIS FILE, AND IT IS MECHANICAL RATHER THAN REVIEWED.
 * The key is read from `env[apiKeyEnv]` INSIDE the call that needs it, held in a local, put into one
 * request header, and dropped when the call returns. It is never assigned to a property of the client,
 * never captured in a closure that outlives the call, never logged, and never placed in `raw`, `detail`
 * or an error message. Two mechanisms hold that, not one:
 *
 *   1. `raw` carries the REQUEST BODY and the RESPONSE BODY and no headers at all. The header set is
 *      built at the call site and never stored, so there is no object for a later reader to walk into.
 *   2. `scrub()` walks every result and every message this file produces and replaces the key value,
 *      wherever it may have come from, with a marker naming the VARIABLE. That second belt exists
 *      because the string does not have to come from us: a proxy that echoes `Authorization` back in an
 *      error body, or a host whose `fetch` puts the request headers in the error it throws, would
 *      otherwise carry the credential into a report the pack writes to disk. A guarantee that depends
 *      on every remote host behaving is not a guarantee.
 *
 * `describe()` answers `keyPresent: boolean` and nothing else. Presence is a fact an operator needs;
 * the value is a fact nobody downstream of this file ever needs.
 *
 * ⛔ AND A TIMEOUT IS A TYPED NON-ANSWER, NEVER A RESULT (anti-drift item 38 —
 * core/lifecycle/evidence.js FORBIDDEN_PROOF_TOKENS, extended here to a third adapter). `runTurn`
 * RESOLVES, it does not reject, with `{ok:false, kind:'TIMEOUT'}` when the deadline passes, exactly as
 * adapters/codex/app-server/rpc.js `send()` does and for the same reason: a caller must not be able to
 * `await` its way into treating an elapsed clock as a reply. The request is genuinely cancelled through
 * an AbortController rather than abandoned, so a hung host costs one socket and not a process.
 *
 * ⛔ AND THE PROBE IS A PROBE (anti-drift items 2 and 41). It asks three cheap questions — is the
 * variable set, does the models list answer, is every configured model id in it — and it never requests
 * a completion, so it spends nothing. "Could not run" (no key, an unreachable host, a non-2xx answer, a
 * body in a shape this file does not know) is CANNOT_DETERMINE naming why; the ONE determined breach it
 * can report is a configured model the host's own list does not contain, which is a FAIL about the
 * declaration rather than about the weather. Nothing here declares a capability SUPPORTED.
 *
 * ⛔ ONE PROVIDER IS NOT SPECIAL-CASED. Everything MiniMax-shaped lives in the README's worked example
 * (base URL, model id strings, the variable NAME) and in the project's own config, never here. The one
 * table in this file that names vendor values is VENDOR_STATUS_QUOTA_CODES, and it is a documented
 * default for a documented ENVELOPE (`base_resp.{status_code,status_msg}`) that this protocol family
 * carries: any provider returning that envelope gets the same reading, and a code this table does not
 * know is reported by number as a body that is not a completion, never guessed into a success. See
 * spine/reference/models/capability-evidence.md §3.3 for the citation.
 */

'use strict';

const path = require('path');

const core = require(path.join(__dirname, '..', '..', 'core', 'index.js'));
const { OUTCOME, rollup } = core.failures;

/** The one protocol this client speaks. A config declaring anything else is not ours to run. */
const PROTOCOL = 'openai-compatible';

/** An environment variable NAME, which is all a config may ever carry about a credential. */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const DEFAULT_TIMEOUT_MS = 120 * 1000;   // a completion can be slow; the deadline exists to bound a HANG
const PROBE_TIMEOUT_MS = 30 * 1000;      // a models list is one small GET

/*
 * Verbatim has a ceiling, and hitting it is REPORTED — the same rule core/lifecycle/evidence.js states
 * for its own payloads. A capped body that does not say it was capped reads as complete.
 */
const MAX_RAW_BYTES = 64 * 1024;

/*
 * ⛔ THE DOCUMENTED DEFAULTS, AND THE ONLY VENDOR VALUES IN THIS FILE. A host in this protocol family
 * may answer HTTP 200 and still carry a refusal in a `base_resp` envelope (`status_code` "0" means
 * success), so a 2xx is checked on BOTH surfaces. These three codes are the ones whose documented
 * meaning is "you cannot spend right now", which is what `QUOTA` names on the HTTP side as 402 and 429:
 *
 *   1002  rate limit          "Please retry your requests later."
 *   1008  insufficient balance "Please check your account balance."
 *   2056  usage quota exceeded "Wait for next 5-hour resource window"
 *
 * Source: platform.minimax.io/docs/api-reference/errorcode and .../api-reference/text-post, recorded
 * with their access date in the evidence file named in this header. A non-zero code that is NOT here is
 * still not a completion: it is reported as MALFORMED naming the number, because this file does not
 * know what it means and a body it cannot read is never read as an answer.
 */
const VENDOR_STATUS_QUOTA_CODES = new Map([
  [1002, 'rate limit'],
  [1008, 'insufficient balance'],
  [2056, 'usage quota exceeded'],
]);

/** Failure kinds. `HTTP_<status>` is computed, so it is not in this table; every other kind is fixed. */
const TURN_FAILURE = {
  NO_KEY: 'NO_KEY',         // the variable the config names is unset or empty
  AUTH: 'AUTH',             // 401 or 403
  QUOTA: 'QUOTA',           // 402, 429, or a documented vendor code meaning quota/balance
  TIMEOUT: 'TIMEOUT',       // the deadline passed — an observation of a clock, never a completion
  NETWORK: 'NETWORK',       // fetch threw before an answer arrived
  MALFORMED: 'MALFORMED',   // a 2xx body that is not the documented shape
  EMPTY: 'EMPTY',           // a 2xx in the documented shape carrying no assistant text
};

// --- redaction ---------------------------------------------------------------------------------------

/**
 * Replace every occurrence of `secret` in every string reachable from `value` with a marker naming the
 * VARIABLE. Structure is preserved so a reader still sees the shape of what came back.
 *
 * ⛔ AN EMPTY SECRET SCRUBS NOTHING. Replacing '' would rewrite every string in the document, so the
 * no-key path returns its result untouched — which is correct, because there was no value to leak.
 */
function scrub(value, secret, envName, ancestors = new WeakSet(), depth = 0) {
  if (!secret) return value;
  const marker = `<redacted: the value of ${envName}>`;
  if (typeof value === 'string') return value.split(secret).join(marker);
  if (!value || typeof value !== 'object') return value;
  // A cap that returns a MARKER, never the untouched subtree: a walk that gives up must not hand back
  // the very bytes it exists to rewrite.
  if (depth > 32) return '<depth limit>';
  if (ancestors.has(value)) return '<circular>';
  ancestors.add(value); // an ANCESTOR set, not a visited set: a shared sibling is not a cycle
  const out = Array.isArray(value)
    ? value.map((v) => scrub(v, secret, envName, ancestors, depth + 1))
    : Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [scrub(k, secret, envName, ancestors, depth + 1), scrub(v, secret, envName, ancestors, depth + 1)]));
  ancestors.delete(value);
  return out;
}

// --- config ------------------------------------------------------------------------------------------

/**
 * Refuse a configuration this client cannot honestly run, at CONSTRUCTION rather than at the first call.
 * Every message names the field; none can name a value from the environment, because none is read here.
 */
function assertConfig({ name, baseUrl, apiKeyEnv, models, protocol }) {
  const bad = (why) => { throw new Error(`openai-compatible client: ${why}`); };
  if (typeof name !== 'string' || !name.trim()) bad('`name` must be a non-empty provider name');
  if (protocol !== undefined && protocol !== PROTOCOL) bad(`\`protocol\` must be "${PROTOCOL}", got ${JSON.stringify(protocol)}`);
  if (typeof baseUrl !== 'string' || !/^https:\/\/\S+$/.test(baseUrl)) {
    bad('`baseUrl` must be an https URL — a credential travels on this connection, so plaintext is refused rather than warned about');
  }
  if (typeof apiKeyEnv !== 'string' || !ENV_NAME_RE.test(apiKeyEnv)) {
    bad(`\`apiKeyEnv\` must be an environment variable NAME matching ${ENV_NAME_RE} — the config carries the NAME, never a value`);
  }
  if (!Array.isArray(models) || !models.length || models.some((m) => typeof m !== 'string' || !m.trim())) {
    bad('`models` must be a non-empty array of model id strings');
  }
}

const trimSlash = (u) => String(u).replace(/\/+$/, '');

/**
 * Read the key from the environment. Called INSIDE each operation, never at construction, and the
 * value returned is held in a local by the caller and dropped when that call returns.
 */
function readKey(env, apiKeyEnv) {
  const raw = env && typeof env[apiKeyEnv] === 'string' ? env[apiKeyEnv] : '';
  return raw.trim(); // a trailing newline from `export $(cat file)` is the classic silent 401
}

// --- rows ---------------------------------------------------------------------------------------------

/**
 * One probe row, in the shared shape: a name, one of core/policy/failures.js's four outcomes, a detail
 * a reader can act on, and optional structured evidence. `adapters/claude-code/task-runner/canary.js`
 * `claim()` is the precedent; the vocabulary and the rollup are core's, not a second copy.
 */
const check = (name, outcome, detail, evidence = null) => ({ name, outcome, detail, evidence });

// --- the client ----------------------------------------------------------------------------------------

/**
 * @param {{name:string, baseUrl:string, apiKeyEnv:string, models:string[], protocol?:string,
 *          fetch?:Function, env?:object, timeoutMs?:number}} config
 * @returns {{runTurn:Function, probe:Function, describe:Function}}
 */
function createClient({
  name,
  baseUrl,
  apiKeyEnv,
  models,
  protocol = PROTOCOL,
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  assertConfig({ name, baseUrl, apiKeyEnv, models, protocol });
  if (typeof fetchImpl !== 'function') {
    throw new Error('openai-compatible client: no `fetch` was provided and this runtime has no global one — every test injects its own, and nothing here ever reaches a live host by accident');
  }
  const root = trimSlash(baseUrl);
  const declaredModels = models.slice();
  const defaultTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  /**
   * One HTTP exchange, cancelled at the deadline through an AbortController.
   *
   * Returns EITHER `{ok:true, status, bodyText, doc, truncated}` (any status the host answered, parsed
   * when the body was JSON) OR a typed non-answer `{ok:false, kind, detail}` for the two conditions
   * that are not answers at all: the clock ran out, or `fetch` threw.
   *
   * ⛔ `key` IS A PARAMETER, NOT A FIELD. It enters here, becomes one header, and leaves with the call.
   * The header object is never returned and never stored.
   */
  async function request({ url, method, key, body, deadlineMs }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    try {
      const init = {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetchImpl(url, init);
      const raw = typeof res.text === 'function' ? await res.text() : '';
      const text = typeof raw === 'string' ? raw : String(raw);
      const truncated = text.length > MAX_RAW_BYTES;
      const bodyText = truncated ? text.slice(0, MAX_RAW_BYTES) : text;
      let doc = null;
      try { doc = JSON.parse(text); } catch { doc = null; }
      return {
        ok: true,
        status: Number(res.status),
        statusText: typeof res.statusText === 'string' ? res.statusText : '',
        bodyText,
        truncated,
        doc,
      };
    } catch (e) {
      if (timedOut) {
        return {
          ok: false,
          kind: TURN_FAILURE.TIMEOUT,
          detail: `no answer from ${name} at ${url} within ${deadlineMs}ms, and the request was aborted. `
            + 'This is an observation of a clock, not of a result: it is not evidence that the request failed and not evidence that it succeeded.',
        };
      }
      return {
        ok: false,
        kind: TURN_FAILURE.NETWORK,
        detail: `the request to ${name} at ${url} threw before an answer arrived: ${(e && e.name) || 'Error'}: ${(e && e.message) || String(e)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The documented `base_resp` envelope, when the host sent one. `status_code` 0 is success; anything
   * else means the 200 is not a completion.
   *
   * @returns {{present:boolean, code:number|null, message:string|null}}
   */
  function vendorStatus(doc) {
    const env0 = doc && typeof doc === 'object' ? doc.base_resp : null;
    if (!env0 || typeof env0 !== 'object') return { present: false, code: null, message: null };
    const code = Number(env0.status_code);
    if (!Number.isFinite(code)) return { present: false, code: null, message: null };
    return { present: true, code, message: typeof env0.status_msg === 'string' ? env0.status_msg : null };
  }

  /** The assistant text of the first choice, in both content shapes the protocol carries. */
  function textOf(choice) {
    const message = choice && typeof choice === 'object' ? choice.message : null;
    if (!message || typeof message !== 'object') return null;
    const { content } = message;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((p) => p && typeof p === 'object' && typeof p.text === 'string')
        .map((p) => p.text);
      return parts.length ? parts.join('') : null;
    }
    return null;
  }

  const usageOf = (doc) => {
    const u = doc && typeof doc === 'object' ? doc.usage : null;
    const n = (v) => (Number.isFinite(v) ? v : null);
    return u && typeof u === 'object'
      ? { input: n(u.prompt_tokens), output: n(u.completion_tokens) }
      : { input: null, output: null };
  };

  /**
   * One completion turn.
   *
   * @param {{model?:string, messages?:Array, prompt?:string, system?:string, maxTokens?:number,
   *          temperature?:number, timeoutMs?:number}} opts
   * @returns {Promise<{ok:true, text, usage, model, raw, durationMs}
   *                 | {ok:false, kind, detail, status, raw, durationMs}>}
   */
  async function runTurn(opts = {}) {
    const startedAt = Date.now();
    const {
      model = declaredModels[0],
      messages = null,
      prompt = null,
      system = null,
      maxTokens = null,
      temperature = null,
      timeoutMs: perCall = null,
    } = opts;

    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('openai-compatible runTurn: `model` must be a non-empty model id (it defaults to the first configured model)');
    }
    let chat;
    if (Array.isArray(messages) && messages.length) {
      chat = system ? [{ role: 'system', content: system }, ...messages] : messages.slice();
    } else if (typeof prompt === 'string' && prompt.length) {
      chat = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
    } else {
      throw new Error('openai-compatible runTurn: pass either `messages` (a non-empty array) or `prompt` (a non-empty string)');
    }

    const requestBody = { model, messages: chat, stream: false };
    if (Number.isFinite(maxTokens)) requestBody.max_tokens = maxTokens;
    if (Number.isFinite(temperature)) requestBody.temperature = temperature;

    const url = `${root}/chat/completions`;
    const deadlineMs = Number.isFinite(perCall) && perCall > 0 ? perCall : defaultTimeoutMs;

    /*
     * `raw` carries the REQUEST BODY and the RESPONSE BODY. It carries NO HEADERS, by construction:
     * one of them is the credential, and a field that never exists cannot be walked into by a reporter,
     * a receipt writer or a debugger three refactors from now.
     */
    const rawOf = (response) => ({
      request: { url, method: 'POST', body: requestBody },
      response: response || null,
    });

    // ⛔ READ AT CALL TIME, HELD IN A LOCAL, NEVER ASSIGNED TO ANYTHING THAT SURVIVES THIS FUNCTION.
    const key = readKey(env, apiKeyEnv);
    const done = (r) => scrub({ ...r, durationMs: Date.now() - startedAt }, key, apiKeyEnv);

    if (!key) {
      return done({
        ok: false,
        kind: TURN_FAILURE.NO_KEY,
        detail: `the environment variable ${apiKeyEnv}, which this project's provider block names, is unset or empty in this process. `
          + `Export ${apiKeyEnv} in the shell that runs the pack. The value is never read from the repository, never asked for in a conversation, and never written anywhere by this pack.`,
        status: null,
        raw: rawOf(null),
      });
    }

    const r = await request({ url, method: 'POST', key, body: requestBody, deadlineMs });
    if (!r.ok) return done({ ok: false, kind: r.kind, detail: r.detail, status: null, raw: rawOf(null) });

    const response = {
      status: r.status,
      statusText: r.statusText,
      // A body over the ceiling is carried as CAPPED TEXT and says so, rather than as a parsed document
      // of unbounded size: core/lifecycle/evidence.js's rule, that a cap which does not announce itself
      // reads as complete, applies to a report this pack may write to disk.
      body: r.truncated ? r.bodyText : (r.doc !== null ? r.doc : r.bodyText),
      truncated: r.truncated,
    };
    const raw = rawOf(response);
    const fail = (kind, detail) => done({ ok: false, kind, detail, status: r.status, raw });

    if (r.status < 200 || r.status >= 300) {
      const vendor = vendorStatus(r.doc);
      const coda = vendor.present ? ` The body also carries the documented envelope code ${vendor.code}${vendor.message ? ` ("${vendor.message}")` : ''}.` : '';
      if (r.status === 401 || r.status === 403) {
        return fail(TURN_FAILURE.AUTH, `${name} refused the credential with HTTP ${r.status}. Check that ${apiKeyEnv} holds a key this provider issued and that it has not been rotated.${coda}`);
      }
      if (r.status === 402 || r.status === 429) {
        return fail(TURN_FAILURE.QUOTA, `${name} answered HTTP ${r.status}, which this protocol uses for ${r.status === 402 ? 'a balance that cannot cover the request' : 'a rate or quota limit'}. Nothing was spent and nothing was produced.${coda}`);
      }
      return fail(`HTTP_${r.status}`, `${name} answered HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}. The verbatim body is in \`raw.response.body\`.${coda}`);
    }

    // A 2xx is checked on BOTH surfaces: the status line AND the documented envelope, if one is present.
    const vendor = vendorStatus(r.doc);
    if (vendor.present && vendor.code !== 0) {
      const meaning = VENDOR_STATUS_QUOTA_CODES.get(vendor.code);
      const named = `code ${vendor.code}${vendor.message ? ` ("${vendor.message}")` : ''}`;
      if (meaning) {
        return fail(TURN_FAILURE.QUOTA, `${name} answered HTTP ${r.status} carrying the documented envelope ${named}, which means ${meaning}. A 200 with a non-zero envelope code is not a completion.`);
      }
      return fail(TURN_FAILURE.MALFORMED, `${name} answered HTTP ${r.status} carrying the documented envelope ${named}, which this client does not have a meaning for. A 200 with a non-zero envelope code is not a completion, and an unrecognised code is reported by number rather than guessed at.`);
    }

    if (!r.doc || typeof r.doc !== 'object' || Array.isArray(r.doc) || !Array.isArray(r.doc.choices)) {
      return fail(TURN_FAILURE.MALFORMED, `${name} answered HTTP ${r.status} with a body that is not a chat completion: no \`choices\` array. The verbatim body is in \`raw.response.body\`.`);
    }
    if (!r.doc.choices.length) {
      return fail(TURN_FAILURE.EMPTY, `${name} answered HTTP ${r.status} with an empty \`choices\` array, so there is no assistant text. This is an answer with nothing in it, not a failure of the request.`);
    }
    const text = textOf(r.doc.choices[0]);
    if (typeof text !== 'string' || !text.trim()) {
      return fail(TURN_FAILURE.EMPTY, `${name} answered HTTP ${r.status} with a choice carrying no assistant text${r.doc.choices[0] && r.doc.choices[0].finish_reason ? ` (finish_reason "${r.doc.choices[0].finish_reason}")` : ''}. This is an answer with nothing in it, not a failure of the request.`);
    }

    return done({
      ok: true,
      text,
      usage: usageOf(r.doc),
      model: typeof r.doc.model === 'string' && r.doc.model ? r.doc.model : model,
      raw,
    });
  }

  /**
   * The cheap canary. Three questions, no completion, nothing spent.
   *
   * @returns {Promise<{outcome:string, checks:Array<{name,outcome,detail,evidence}>, provider:string, baseUrl:string, apiKeyEnv:string}>}
   */
  async function probe({ timeoutMs: perCall = null } = {}) {
    const key = readKey(env, apiKeyEnv);
    const checks = [];
    const finish = () => scrub({
      provider: name,
      baseUrl: root,
      apiKeyEnv,
      models: declaredModels.slice(),
      checks,
      outcome: rollup(checks.map((c) => c.outcome)),
    }, key, apiKeyEnv);

    const NAME_SET = 'the environment variable the config names is set';
    if (!key) {
      checks.push(check(NAME_SET, OUTCOME.CANNOT_DETERMINE,
        `${apiKeyEnv} is unset or empty in this process, so nothing about ${name} could be checked. `
        + `Export ${apiKeyEnv} in the shell that runs the pack. An unset variable is "could not run", never "failed".`));
      return finish();
    }
    checks.push(check(NAME_SET, OUTCOME.PASS,
      `${apiKeyEnv} is set. Presence is all that is reported: the value is read into a local for the one request below and appears in nothing this probe returns.`));

    const url = `${root}/models`;
    const deadlineMs = Number.isFinite(perCall) && perCall > 0 ? perCall : PROBE_TIMEOUT_MS;
    const ANSWERS = "the provider's models list answers";
    const r = await request({ url, method: 'GET', key, deadlineMs });
    if (!r.ok) {
      checks.push(check(ANSWERS, OUTCOME.CANNOT_DETERMINE, `${r.kind}: ${r.detail}`, { kind: r.kind }));
      return finish();
    }
    if (r.status < 200 || r.status >= 300) {
      const kind = r.status === 401 || r.status === 403 ? TURN_FAILURE.AUTH
        : (r.status === 402 || r.status === 429 ? TURN_FAILURE.QUOTA : `HTTP_${r.status}`);
      checks.push(check(ANSWERS, OUTCOME.CANNOT_DETERMINE,
        `${kind}: GET ${url} answered HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ''}, so which models this host serves is UNKNOWN. `
        + 'A host that would not answer is not a statement about the declared configuration.',
        { kind, status: r.status }));
      return finish();
    }
    checks.push(check(ANSWERS, OUTCOME.PASS, `GET ${url} answered HTTP ${r.status}.`, { status: r.status }));

    const LISTED = "every configured model id is in the provider's own list";
    const rows = r.doc && typeof r.doc === 'object' && Array.isArray(r.doc.data) ? r.doc.data : null;
    if (!rows) {
      checks.push(check(LISTED, OUTCOME.CANNOT_DETERMINE,
        `GET ${url} answered HTTP ${r.status} with a body that is not a model list (no \`data\` array), so whether the configured ids exist could not be read. `
        + 'A body this client cannot parse is UNKNOWN, never a refusal.',
        { status: r.status }));
      return finish();
    }
    const served = rows.map((m) => (m && typeof m === 'object' ? m.id : m)).filter((id) => typeof id === 'string');
    const missing = declaredModels.filter((m) => !served.includes(m));
    if (missing.length) {
      checks.push(check(LISTED, OUTCOME.FAIL,
        `${name} lists ${served.length} model(s) and does not list ${missing.map((m) => `"${m}"`).join(', ')}, which this project's provider block declares. `
        + 'This is a determined disagreement between the declaration and the host, not a host that could not be reached.',
        { missing, served }));
      return finish();
    }
    checks.push(check(LISTED, OUTCOME.PASS,
      `all ${declaredModels.length} configured model id(s) appear in the ${served.length} the host lists.`, { served }));
    return finish();
  }

  /** Presence only. The value is never returned, never printed, and never carried into a receipt. */
  function describe() {
    return {
      name,
      baseUrl: root,
      apiKeyEnv,
      models: declaredModels.slice(),
      keyPresent: readKey(env, apiKeyEnv).length > 0,
    };
  }

  return { runTurn, probe, describe };
}

module.exports = {
  createClient,
  scrub,
  check,
  readKey,
  assertConfig,
  PROTOCOL,
  ENV_NAME_RE,
  TURN_FAILURE,
  VENDOR_STATUS_QUOTA_CODES,
  DEFAULT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  MAX_RAW_BYTES,
};
