/*
 * RespawnPack · adapters/openai-compatible/client.test.mjs — the generic OpenAI-compatible client,
 * driven entirely against an INJECTED fetch and an INJECTED environment.
 *
 * ⛔ NOTHING HERE REACHES A HOST, AND THAT IS A PROPERTY OF THE SUITE RATHER THAN A HABIT. Every test
 * constructs the client with its own `fetch` and its own `env`; the base URL points at
 * `https://api.example.invalid/`, a name reserved by RFC 2606 that cannot resolve; and the one test
 * that asserts the request's shape asserts it from what the fake received. Unplug the network and this
 * suite is unchanged. `adapters/openai-compatible/probe.js` is the CLI that uses the REAL fetch, and
 * nothing in this file invokes it against a live host.
 *
 * ⛔ AND NOTHING HERE READS A REAL KEY. The injected environment carries the literal sentinel below,
 * which is the whole apparatus of the redaction fence: a value that would be unmistakable if it ever
 * appeared in a result, a thrown error, a probe report, or anywhere but the one request header it
 * belongs in. THE FENCE IS THE POINT OF THIS FILE (anti-drift item 52) — the state coverage exists so
 * that the fence has every state to search.
 *
 * The two-sidedness matters: it is not enough that the sentinel is absent from a result the client
 * built out of fields it chose. One scenario has the fake host ECHO the Authorization header back in
 * its response body, which is a thing real proxies do, and asserts the value is redacted rather than
 * carried — so the fence proves a mechanism (`scrub`) rather than proving that we happened not to copy
 * anything.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const require_ = createRequire(import.meta.url);

const client = require_(path.join(HERE, 'client.js'));
const probeCli = require_(path.join(HERE, 'probe.js'));
const core = require_(path.join(ROOT, 'core', 'index.js'));

const { OUTCOME } = core.failures;
const { createClient, TURN_FAILURE } = client;

// --- the fixture vocabulary --------------------------------------------------------------------------

/** The value that must never appear anywhere but one request header. Distinctive on purpose. */
const SENTINEL = 'sentinel-key-value-do-not-print';
const ENV_NAME = 'PROVIDER_TEST_API_KEY';
const BASE = 'https://api.example.invalid/v1';
const MODELS = ['test-model-a', 'test-model-b'];

const withKey = () => ({ [ENV_NAME]: SENTINEL, PATH: '/usr/bin' });
const withoutKey = () => ({ PATH: '/usr/bin' });

/** A fake `fetch` that records every call and answers from `handler`. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, signal: init && init.signal });
    return handler(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

/** A minimal Response: exactly the three members `client.js` touches. */
const response = (status, body, statusText = '') => ({
  status,
  statusText,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const completion = (text = 'the answer', model = 'test-model-a') => ({
  id: 'chatcmpl-0001',
  object: 'chat.completion',
  model,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

const make = (over = {}) => createClient({
  name: 'testprovider',
  baseUrl: BASE,
  apiKeyEnv: ENV_NAME,
  models: MODELS.slice(),
  env: withKey(),
  fetch: fakeFetch(() => response(200, completion())),
  ...over,
});

const ask = (c) => c.runTurn({ model: 'test-model-a', prompt: 'hello' });

// --- the scenario table the redaction fence sweeps -----------------------------------------------------

/*
 * Every state the client can reach, each producing a result (or a throw) the fence below serialises and
 * searches. Kept as data rather than as a comment so a state added to the client and to the tests but
 * NOT to this list is a visible omission rather than an invisible one: the fence's own coverage test
 * asserts the kinds this table reaches against `TURN_FAILURE`.
 */
const SCENARIOS = [
  {
    name: 'a healthy completion',
    kind: null,
    build: () => make({ fetch: fakeFetch(() => response(200, completion())) }),
  },
  {
    name: 'HTTP 401',
    kind: TURN_FAILURE.AUTH,
    build: () => make({ fetch: fakeFetch(() => response(401, { error: { message: 'invalid api key', type: 'authentication_error' } }, 'Unauthorized')) }),
  },
  {
    name: 'HTTP 403',
    kind: TURN_FAILURE.AUTH,
    build: () => make({ fetch: fakeFetch(() => response(403, { error: { message: 'forbidden' } }, 'Forbidden')) }),
  },
  {
    name: 'HTTP 402',
    kind: TURN_FAILURE.QUOTA,
    build: () => make({ fetch: fakeFetch(() => response(402, { error: { message: 'payment required' } }, 'Payment Required')) }),
  },
  {
    name: 'HTTP 429',
    kind: TURN_FAILURE.QUOTA,
    build: () => make({ fetch: fakeFetch(() => response(429, { error: { message: 'slow down' } }, 'Too Many Requests')) }),
  },
  {
    name: 'HTTP 500',
    kind: 'HTTP_500',
    build: () => make({ fetch: fakeFetch(() => response(500, 'upstream exploded', 'Internal Server Error')) }),
  },
  {
    name: 'a 200 carrying the documented insufficient-balance envelope code',
    kind: TURN_FAILURE.QUOTA,
    build: () => make({ fetch: fakeFetch(() => response(200, { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } })) }),
  },
  {
    name: 'a 200 carrying the documented quota-exceeded envelope code',
    kind: TURN_FAILURE.QUOTA,
    build: () => make({ fetch: fakeFetch(() => response(200, { base_resp: { status_code: 2056, status_msg: 'usage quota exceeded' } })) }),
  },
  {
    name: 'a 200 carrying an envelope code this client has no meaning for',
    kind: TURN_FAILURE.MALFORMED,
    build: () => make({ fetch: fakeFetch(() => response(200, { base_resp: { status_code: 9999, status_msg: 'something new' } })) }),
  },
  {
    name: 'a malformed 2xx body',
    kind: TURN_FAILURE.MALFORMED,
    build: () => make({ fetch: fakeFetch(() => response(200, { id: 'chatcmpl-0002', object: 'chat.completion' })) }),
  },
  {
    name: 'an empty choices array',
    kind: TURN_FAILURE.EMPTY,
    build: () => make({ fetch: fakeFetch(() => response(200, { ...completion(), choices: [] })) }),
  },
  {
    name: 'a choice with no assistant text',
    kind: TURN_FAILURE.EMPTY,
    build: () => make({ fetch: fakeFetch(() => response(200, { ...completion(), choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] })) }),
  },
  {
    name: 'a timeout',
    kind: TURN_FAILURE.TIMEOUT,
    timeoutMs: 25,
    build: () => make({
      timeoutMs: 25,
      fetch: fakeFetch((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      })),
    }),
  },
  {
    name: 'a network throw',
    kind: TURN_FAILURE.NETWORK,
    build: () => make({ fetch: fakeFetch(() => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); }) }),
  },
  {
    name: 'a body that will not read',
    kind: TURN_FAILURE.NETWORK,
    build: () => make({ fetch: fakeFetch(() => ({ status: 200, statusText: 'OK', text: async () => { throw new Error('stream closed early'); } })) }),
  },
  {
    name: 'no key set',
    kind: TURN_FAILURE.NO_KEY,
    build: () => make({ env: withoutKey() }),
  },
  {
    name: 'a whitespace-only key',
    kind: TURN_FAILURE.NO_KEY,
    build: () => make({ env: { [ENV_NAME]: '   \n' } }),
  },
  {
    /*
     * ⛔ THE ONE THAT PROVES A MECHANISM RATHER THAN AN ABSENCE. A real proxy can echo the request
     * headers into an error body. The client did not put the value there, so a fence that only checked
     * fields the client chooses would pass here while the credential sat in `raw`.
     */
    name: 'a host that echoes the Authorization header back in its body',
    kind: TURN_FAILURE.MALFORMED,
    echoes: true,
    build: () => make({
      fetch: fakeFetch((_url, init) => response(200, {
        error: { message: 'debug: received headers', received: { authorization: init.headers.Authorization } },
      })),
    }),
  },
];

const runScenario = async (s) => ask(s.build());

// --- helpers for the fence -----------------------------------------------------------------------------

/** Every key name reachable from `value`, at any depth. */
function keyNames(value, out = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 24) return out;
  if (Array.isArray(value)) { for (const v of value) keyNames(v, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(value)) { out.add(k); keyNames(v, out, depth + 1); }
  return out;
}

// ---------------------------------------------------------------------------------------------
describe('createClient · a configuration it cannot honestly run is refused at construction', () => {
  test('a non-https base URL is refused, because a credential travels on that connection', () => {
    assert.throws(() => make({ baseUrl: 'http://api.example.invalid/v1' }), /baseUrl.*https/s);
  });

  test('an apiKeyEnv that is not an environment variable NAME is refused', () => {
    assert.throws(() => make({ apiKeyEnv: 'minimax_api_key' }), /apiKeyEnv.*NAME/s);
  });

  test('an empty model list is refused', () => {
    assert.throws(() => make({ models: [] }), /models.*non-empty/s);
  });

  test('a protocol this adapter does not speak is refused', () => {
    assert.throws(() => make({ protocol: 'anthropic-compatible' }), /protocol.*openai-compatible/s);
  });

  test('no fetch at all is refused rather than silently reaching a real host', () => {
    assert.throws(() => make({ fetch: null }), /no `fetch` was provided/);
  });

  test('⛔ nothing the constructor refuses can name a value from the environment', () => {
    // Every refusal above is about a DECLARED field. None reads env, so none can quote it — asserted
    // rather than assumed, because a message that interpolated the wrong local would still read fine.
    for (const bad of [{ baseUrl: 'http://x.invalid' }, { apiKeyEnv: 'lower_case' }, { models: [] }, { protocol: 'x' }, { fetch: null }]) {
      assert.throws(() => make(bad), (e) => {
        assert.equal(e.message.includes(SENTINEL), false, `a construction refusal quoted the key value: ${e.message}`);
        return true;
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('runTurn · the request it sends', () => {
  test('POSTs to <baseUrl>/chat/completions with the documented body and a Bearer header', async () => {
    const fetchImpl = fakeFetch(() => response(200, completion()));
    const c = make({ fetch: fetchImpl });
    await c.runTurn({ model: 'test-model-b', prompt: 'hello', system: 'be brief', maxTokens: 64, temperature: 0.2 });

    assert.equal(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, `${BASE}/chat/completions`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${SENTINEL}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      model: 'test-model-b',
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
      stream: false,
      max_tokens: 64,
      temperature: 0.2,
    });
  });

  test('a messages array is sent as given, and the model defaults to the first configured id', async () => {
    const fetchImpl = fakeFetch(() => response(200, completion()));
    const c = make({ fetch: fetchImpl });
    const messages = [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }];
    await c.runTurn({ messages });
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.deepEqual(body.messages, messages);
    assert.equal(body.model, MODELS[0]);
    assert.equal(body.stream, false);
    assert.equal('max_tokens' in body, false, 'an unset max_tokens must be omitted, not sent as null');
  });

  test('a trailing slash on the base URL does not produce a double slash in the path', async () => {
    const fetchImpl = fakeFetch(() => response(200, completion()));
    await ask(make({ baseUrl: `${BASE}/`, fetch: fetchImpl }));
    assert.equal(fetchImpl.calls[0].url, `${BASE}/chat/completions`);
  });

  test('a call with neither messages nor prompt is a caller error, and it names both options', async () => {
    await assert.rejects(() => make().runTurn({ model: 'test-model-a' }), /messages.*prompt/s);
  });
});

// ---------------------------------------------------------------------------------------------
describe('runTurn · a healthy completion', () => {
  test('reports the text, the usage, the model the host named, and a duration', async () => {
    const r = await ask(make({ fetch: fakeFetch(() => response(200, completion('the answer', 'test-model-a-0613'))) }));
    assert.equal(r.ok, true);
    assert.equal(r.text, 'the answer');
    assert.deepEqual(r.usage, { input: 11, output: 7 });
    assert.equal(r.model, 'test-model-a-0613', 'the model the HOST reported outranks the one that was asked for');
    assert.equal(Number.isFinite(r.durationMs) && r.durationMs >= 0, true);
    assert.equal('kind' in r, false, 'a successful turn carries no failure kind');
    assert.equal(r.raw.response.status, 200);
  });

  test('a content array of text parts is joined, so both documented content shapes answer', async () => {
    const doc = completion();
    doc.choices[0].message.content = [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }];
    const r = await ask(make({ fetch: fakeFetch(() => response(200, doc)) }));
    assert.equal(r.ok, true);
    assert.equal(r.text, 'part one part two');
  });

  test('a usage block the host omitted reads as null, never as zero', async () => {
    const doc = completion();
    delete doc.usage;
    const r = await ask(make({ fetch: fakeFetch(() => response(200, doc)) }));
    assert.deepEqual(r.usage, { input: null, output: null });
  });
});

// ---------------------------------------------------------------------------------------------
describe('runTurn · every typed non-answer, one state at a time', () => {
  for (const s of SCENARIOS.filter((x) => x.kind)) {
    test(`${s.name} → ${s.kind}`, async () => {
      const r = await runScenario(s);
      assert.equal(r.ok, false, `${s.name} must not report ok:true`);
      assert.equal(r.kind, s.kind);
      assert.equal(typeof r.detail === 'string' && r.detail.length > 20, true, 'every failure carries a detail a reader can act on');
      assert.equal(Number.isFinite(r.durationMs) && r.durationMs >= 0, true);
      assert.equal('text' in r, false, 'a failed turn carries no text');
    });
  }

  test('NO_KEY names the VARIABLE, never a value, and no request is made at all', async () => {
    const fetchImpl = fakeFetch(() => response(200, completion()));
    const r = await ask(make({ env: withoutKey(), fetch: fetchImpl }));
    assert.equal(r.kind, TURN_FAILURE.NO_KEY);
    assert.match(r.detail, new RegExp(ENV_NAME));
    assert.equal(r.status, null);
    assert.equal(fetchImpl.calls.length, 0, 'a client with no key must not open a connection to find that out');
  });

  test('AUTH carries the status and points at the variable to check', async () => {
    const r = await runScenario(SCENARIOS.find((s) => s.name === 'HTTP 401'));
    assert.equal(r.status, 401);
    assert.match(r.detail, new RegExp(ENV_NAME));
  });

  test('QUOTA from a documented envelope code NAMES the code and its meaning', async () => {
    const r = await runScenario(SCENARIOS.find((s) => s.name.includes('insufficient-balance')));
    assert.equal(r.kind, TURN_FAILURE.QUOTA);
    assert.equal(r.status, 200, 'the HTTP status was 200: a body-level refusal does not become a status-level one');
    assert.match(r.detail, /1008/);
    assert.match(r.detail, /insufficient balance/);
  });

  test('an envelope code with no known meaning is reported by NUMBER, never guessed into a success', async () => {
    const r = await runScenario(SCENARIOS.find((s) => s.name.includes('no meaning for')));
    assert.equal(r.kind, TURN_FAILURE.MALFORMED);
    assert.match(r.detail, /9999/);
  });

  test('an envelope code of 0 on a well-formed 2xx is a completion, not a refusal', async () => {
    const doc = { ...completion(), base_resp: { status_code: 0, status_msg: 'success' } };
    const r = await ask(make({ fetch: fakeFetch(() => response(200, doc)) }));
    assert.equal(r.ok, true);
    assert.equal(r.text, 'the answer');
  });

  test('HTTP_<status> is computed from the status the host actually sent', async () => {
    for (const status of [400, 404, 500, 503]) {
      const r = await ask(make({ fetch: fakeFetch(() => response(status, 'nope')) }));
      assert.equal(r.kind, `HTTP_${status}`);
      assert.equal(r.status, status);
    }
  });

  /*
   * ⛔ ANTI-DRIFT ITEM 38, IN THE ONE PLACE IT COULD BE LOST HERE. `runTurn` RESOLVES on a deadline
   * rather than rejecting, so the surrounding assertions have to prove the resolution is a NON-ANSWER
   * and not a quiet success: ok:false, the TIMEOUT kind, no text, and the detail saying in words that a
   * clock was observed rather than a result. And the request is genuinely cancelled: the signal the
   * fake received is aborted, so a hung host does not leak a socket per call.
   */
  test('⛔ a timeout is a typed non-answer, and the request is aborted through the AbortController', async () => {
    const s = SCENARIOS.find((x) => x.name === 'a timeout');
    const c = s.build();
    const started = Date.now();
    const r = await ask(c);
    assert.equal(r.ok, false);
    assert.equal(r.kind, TURN_FAILURE.TIMEOUT);
    assert.equal('text' in r, false);
    assert.equal(r.status, null);
    assert.match(r.detail, /observation of a clock/);
    assert.match(r.detail, /not evidence that it succeeded/);
    assert.equal(Date.now() - started >= 20, true, 'the deadline was not actually waited on');
  });

  test('⛔ the aborted signal is the client\'s own, so a hung host is cancelled rather than abandoned', async () => {
    let seen = null;
    const c = make({
      timeoutMs: 25,
      fetch: fakeFetch((_url, init) => {
        seen = init.signal;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }),
    });
    await ask(c);
    assert.ok(seen, 'the fake never received a signal');
    assert.equal(seen.aborted, true, 'the client did not abort the request it gave up on');
  });

  test('a fetch that throws is NETWORK and quotes the error, and is never confused with a timeout', async () => {
    const r = await runScenario(SCENARIOS.find((s) => s.name === 'a network throw'));
    assert.equal(r.kind, TURN_FAILURE.NETWORK);
    assert.match(r.detail, /fetch failed/);
    assert.doesNotMatch(r.detail, /clock/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('describe() · presence, never a value', () => {
  test('reports the declaration and keyPresent true when the variable is set', () => {
    const d = make().describe();
    assert.deepEqual(d, { name: 'testprovider', baseUrl: BASE, apiKeyEnv: ENV_NAME, models: MODELS, keyPresent: true });
  });

  test('keyPresent is false when the variable is unset, and false when it is whitespace', () => {
    assert.equal(make({ env: withoutKey() }).describe().keyPresent, false);
    assert.equal(make({ env: { [ENV_NAME]: '  ' } }).describe().keyPresent, false);
  });

  test('⛔ the whole description, serialised, carries no part of the value', () => {
    assert.equal(JSON.stringify(make().describe()).includes(SENTINEL), false);
  });

  test('the models array is a copy: a caller mutating it cannot change what the client will ask for', () => {
    const c = make();
    c.describe().models.push('smuggled-model');
    assert.deepEqual(c.describe().models, MODELS);
  });
});

// ---------------------------------------------------------------------------------------------
describe('probe() · three cheap questions, no completion, nothing spent', () => {
  const modelList = (ids) => response(200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

  test('an unset variable is CANNOT_DETERMINE naming the VARIABLE, and no request is made', async () => {
    const fetchImpl = fakeFetch(() => modelList(MODELS));
    const r = await make({ env: withoutKey(), fetch: fetchImpl }).probe();
    assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(r.checks[0].detail, new RegExp(ENV_NAME));
    assert.match(r.checks[0].detail, /never "failed"/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('a models list that answers 500 is CANNOT_DETERMINE naming the kind, never FAIL', async () => {
    const r = await make({ fetch: fakeFetch(() => response(500, 'upstream exploded', 'Internal Server Error')) }).probe();
    assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
    const row = r.checks.find((c) => c.name.includes('models list'));
    assert.equal(row.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(row.detail, /HTTP_500/);
    assert.equal(row.evidence.status, 500);
  });

  test('a 401 on the models list is still CANNOT_DETERMINE: a host that would not answer said nothing about the declaration', async () => {
    const r = await make({ fetch: fakeFetch(() => response(401, { error: { message: 'bad key' } }, 'Unauthorized')) }).probe();
    assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(r.checks.find((c) => c.name.includes('models list')).detail, /AUTH/);
  });

  test('a network throw is CANNOT_DETERMINE, and a timeout is CANNOT_DETERMINE', async () => {
    const thrown = await make({ fetch: fakeFetch(() => { throw new Error('ENOTFOUND'); }) }).probe();
    assert.equal(thrown.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(thrown.checks.at(-1).detail, /NETWORK/);

    const hung = await make({
      fetch: fakeFetch((_u, init) => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })),
    }).probe({ timeoutMs: 25 });
    assert.equal(hung.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(hung.checks.at(-1).detail, /TIMEOUT/);
  });

  test('a 2xx body that is not a model list is CANNOT_DETERMINE, never a refusal', async () => {
    const r = await make({ fetch: fakeFetch(() => response(200, { object: 'list', models: ['test-model-a'] })) }).probe();
    assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(r.checks.at(-1).detail, /never a refusal/);
  });

  test('⛔ a configured model the host does not list is FAIL, and the row NAMES it', async () => {
    const r = await make({ fetch: fakeFetch(() => modelList(['test-model-a', 'some-other-model'])) }).probe();
    assert.equal(r.outcome, OUTCOME.FAIL);
    const row = r.checks.at(-1);
    assert.equal(row.outcome, OUTCOME.FAIL);
    assert.match(row.detail, /"test-model-b"/);
    assert.deepEqual(row.evidence.missing, ['test-model-b']);
  });

  test('every configured model present is PASS, and NO completion was ever requested', async () => {
    const fetchImpl = fakeFetch(() => modelList([...MODELS, 'test-model-c']));
    const r = await make({ fetch: fetchImpl }).probe();
    assert.equal(r.outcome, OUTCOME.PASS);
    assert.deepEqual(r.checks.map((c) => c.outcome), [OUTCOME.PASS, OUTCOME.PASS, OUTCOME.PASS]);
    assert.equal(fetchImpl.calls.length, 1, 'a probe is ONE request');
    assert.equal(fetchImpl.calls[0].url, `${BASE}/models`);
    assert.equal(fetchImpl.calls[0].init.method, 'GET');
    assert.equal(fetchImpl.calls[0].init.body, undefined, 'a GET for a model list carries no body');
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${SENTINEL}`);
    for (const call of fetchImpl.calls) {
      assert.doesNotMatch(call.url, /chat\/completions/, 'the probe requested a completion, which would spend tokens');
    }
  });

  test('the probe reports the declaration it was built from, so a reader knows what was checked', async () => {
    const r = await make({ fetch: fakeFetch(() => modelList(MODELS)) }).probe();
    assert.equal(r.provider, 'testprovider');
    assert.equal(r.baseUrl, BASE);
    assert.equal(r.apiKeyEnv, ENV_NAME);
    assert.deepEqual(r.models, MODELS);
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔⛔ THE REDACTION FENCE (anti-drift item 52). Everything above exists so that these tests have every
 * state to search. Each one serialises a WHOLE object with JSON.stringify and asserts the sentinel is
 * nowhere in it: not in a detail, not in `raw`, not in an evidence blob, not in a key name.
 */
describe('⛔ the redaction fence · the key value appears in nothing but one request header', () => {
  test('every documented failure kind is reached by the scenario table this fence sweeps', () => {
    const reached = new Set(SCENARIOS.map((s) => s.kind).filter(Boolean));
    for (const kind of Object.values(TURN_FAILURE)) {
      assert.equal(reached.has(kind), true, `no scenario reaches ${kind}, so the fence never searches that result`);
    }
    assert.equal([...reached].some((k) => /^HTTP_\d+$/.test(k)), true, 'no scenario reaches a computed HTTP_<status> result');
    assert.equal(SCENARIOS.some((s) => !s.kind), true, 'no scenario reaches a SUCCESSFUL result, which is the one a reader would copy into a receipt');
  });

  for (const s of SCENARIOS) {
    test(`no part of the value survives into the result of: ${s.name}`, async () => {
      const r = await runScenario(s);
      const serialised = JSON.stringify(r);
      assert.equal(serialised.includes(SENTINEL), false,
        `the key value appears in the result of "${s.name}":\n${serialised}`);
      if (s.echoes) {
        assert.match(serialised, /<redacted: the value of PROVIDER_TEST_API_KEY>/,
          'the echoed header was neither carried nor redacted, so this scenario proves nothing about the mechanism');
      }
    });
  }

  test('the value the fake received sat ONLY in the Authorization header', async () => {
    const fetchImpl = fakeFetch(() => response(200, completion()));
    await make({ fetch: fetchImpl }).runTurn({ model: 'test-model-a', prompt: 'hello', system: 'be brief', maxTokens: 8 });
    const { url, init } = fetchImpl.calls[0];
    assert.equal(init.headers.Authorization, `Bearer ${SENTINEL}`, 'the header the request needs must carry the value');

    const withoutAuth = { ...init.headers };
    delete withoutAuth.Authorization;
    const everythingElse = JSON.stringify({ url, method: init.method, headers: withoutAuth, body: init.body });
    assert.equal(everythingElse.includes(SENTINEL), false,
      `the value reached the request outside the Authorization header:\n${everythingElse}`);
  });

  /*
   * The REQUEST half of `raw` is built by this client, so it can be held to an exact shape: three
   * fields, no header set, nothing for a receipt writer or a debugger three refactors from now to walk
   * into. The RESPONSE half is whatever the host sent, so it may legitimately contain a field called
   * `authorization` when the host echoed one back; that is why the VALUE there is redacted rather than
   * absent, which the per-scenario assertions above prove.
   */
  test('⛔ `raw.request` carries no headers at all, so there is nothing for a later reader to walk into', async () => {
    for (const s of SCENARIOS) {
      const r = await runScenario(s);
      if (!r.raw) continue;
      assert.equal(r.raw.request.headers, undefined, `${s.name}: raw.request grew a headers field`);
      const names = [...keyNames(r.raw.request)].map((k) => k.toLowerCase());
      assert.equal(names.includes('headers'), false, `${s.name}: raw.request carries a key named "headers"`);
      assert.equal(names.includes('authorization'), false, `${s.name}: raw.request carries a key named "authorization"`);
      assert.deepEqual(Object.keys(r.raw.request).sort(), ['body', 'method', 'url'],
        `${s.name}: raw.request carries something other than the url, the method and the body`);
      assert.equal(JSON.stringify(r.raw).includes(SENTINEL), false, `${s.name}: raw carries the key value`);
    }
  });

  test('no error the client THROWS quotes the value either', async () => {
    const thrown = [];
    const collect = async (fn) => { try { await fn(); } catch (e) { thrown.push(e); } };
    await collect(() => make().runTurn({ model: 'test-model-a' }));                 // neither messages nor prompt
    await collect(() => make().runTurn({ model: '', prompt: 'hi' }));               // an empty model id
    await collect(async () => make({ baseUrl: 'http://x.invalid' }));               // a refused construction
    await collect(async () => make({ apiKeyEnv: 'lower' }));
    await collect(async () => make({ fetch: null }));
    assert.equal(thrown.length, 5, 'a call this fence expects to throw stopped throwing');
    for (const e of thrown) {
      assert.equal(String(e && e.message).includes(SENTINEL), false, `a thrown error quoted the key value: ${e.message}`);
      assert.equal(String(e && e.stack).includes(SENTINEL), false, `a stack quoted the key value: ${e.stack}`);
    }
  });

  test('the probe\'s own output carries no part of the value, in every state', async () => {
    const states = [
      make({ env: withoutKey(), fetch: fakeFetch(() => response(200, { data: [] })) }),
      make({ fetch: fakeFetch(() => response(500, 'boom')) }),
      make({ fetch: fakeFetch(() => { throw new Error('ENOTFOUND'); }) }),
      make({ fetch: fakeFetch(() => response(200, { object: 'list', data: [{ id: 'test-model-a' }] })) }),
      make({ fetch: fakeFetch(() => response(200, { object: 'list', data: MODELS.map((id) => ({ id })) })) }),
    ];
    for (const c of states) {
      const serialised = JSON.stringify(await c.probe());
      assert.equal(serialised.includes(SENTINEL), false, `the probe leaked the key value:\n${serialised}`);
    }
  });

  test('⛔ and the probe REDACTS a value the host itself echoed back, rather than merely not copying one', async () => {
    // The host lists a model whose id contains the credential. Contrived on purpose: the point is that
    // the value reaches the probe's evidence from the OUTSIDE, where "we did not copy it" is no defence.
    const c = make({
      fetch: fakeFetch(() => response(200, { object: 'list', data: [...MODELS, `leaked-${SENTINEL}`].map((id) => ({ id })) })),
    });
    const r = await c.probe();
    assert.equal(r.outcome, OUTCOME.PASS);
    const serialised = JSON.stringify(r);
    assert.equal(serialised.includes(SENTINEL), false, `the probe carried an echoed value into its report:\n${serialised}`);
    assert.match(serialised, /<redacted: the value of PROVIDER_TEST_API_KEY>/);
  });

  test('scrub() replaces every occurrence, at every depth, including in a key name', () => {
    const doc = {
      a: `prefix ${SENTINEL} suffix`,
      b: [{ c: { d: [SENTINEL, `${SENTINEL}${SENTINEL}`] } }],
      [`k-${SENTINEL}`]: 'value',
    };
    const out = JSON.stringify(client.scrub(doc, SENTINEL, ENV_NAME));
    assert.equal(out.includes(SENTINEL), false);
    assert.equal((out.match(/<redacted: the value of PROVIDER_TEST_API_KEY>/g) || []).length, 5);
  });

  test('scrub() with an empty secret rewrites nothing, so the no-key path is not mangled', () => {
    const doc = { a: 'untouched', b: ['also untouched'] };
    assert.deepEqual(client.scrub(doc, '', ENV_NAME), doc);
  });

  test('scrub() survives a cycle and does not mistake a shared sibling for one', () => {
    const shared = { note: `see ${SENTINEL}` };
    const cyclic = { shared, again: shared };
    cyclic.self = cyclic;
    const out = client.scrub(cyclic, SENTINEL, ENV_NAME);
    assert.equal(out.self, '<circular>');
    assert.equal(out.shared.note, 'see <redacted: the value of PROVIDER_TEST_API_KEY>');
    assert.equal(out.again.note, 'see <redacted: the value of PROVIDER_TEST_API_KEY>',
      'a second reference to the same object was treated as a cycle, so half the document went unscrubbed');
  });

  test('the client holds no reference to the value between calls', async () => {
    // The key is read at CALL time: a client built while the variable is set answers NO_KEY once the
    // variable goes away, which is only possible if nothing captured the value.
    const env = withKey();
    const c = make({ env, fetch: fakeFetch(() => response(200, completion())) });
    assert.equal((await ask(c)).ok, true);
    delete env[ENV_NAME];
    const after = await ask(c);
    assert.equal(after.ok, false);
    assert.equal(after.kind, TURN_FAILURE.NO_KEY);
    assert.equal(c.describe().keyPresent, false);
    assert.equal(JSON.stringify(c).includes(SENTINEL), false);
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * ⛔ THE SECRET-SCAN FENCE. The four files this task adds are read line by line against the SAME
 * HIGH-severity patterns `hooks/secret-scan.js` blocks a commit on, imported from that file's own source
 * rather than re-typed — a second copy of the list would agree today and drift the day a pattern is
 * added. This is what keeps the README's worked example from carrying a key-shaped string, and it is
 * the reason the example spells an environment variable NAME and never a value.
 */
describe('⛔ no line of this adapter matches a HIGH-severity secret pattern', () => {
  const FILES = ['client.js', 'probe.js', 'README.md', 'client.test.mjs'];

  /** The HIGH rows of hooks/secret-scan.js's own PATTERNS array, parsed from its source. */
  function highPatterns() {
    const src = fs.readFileSync(path.join(ROOT, 'hooks', 'secret-scan.js'), 'utf8');
    const block = /const PATTERNS = \[([\s\S]*?)\n\];/.exec(src);
    assert.ok(block, 'hooks/secret-scan.js no longer declares PATTERNS as a literal array — re-aim this fence rather than deleting it');
    const rows = [...block[1].matchAll(/\{\s*re:\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*),\s*sev:\s*'(HIGH|MEDIUM)',\s*name:\s*'([^']+)'/g)]
      .map(([, body, flags, sev, name]) => ({ re: new RegExp(body, flags), sev, name }));
    assert.equal(rows.length >= 9, true, `only ${rows.length} pattern(s) parsed out of hooks/secret-scan.js — the extraction is broken, and a fence that matches nothing passes everything`);
    const high = rows.filter((r) => r.sev === 'HIGH');
    assert.equal(high.length >= 7, true, `only ${high.length} HIGH pattern(s) parsed — the extraction is broken`);
    return high;
  }

  test('the patterns are imported from hooks/secret-scan.js and actually match a known secret shape', () => {
    const high = highPatterns();
    // A control: a fence whose patterns matched nothing would pass every file for the wrong reason.
    const control = `AKIA${'A1B2C3D4E5F6G7H8'}`;
    assert.equal(high.some((p) => p.re.test(control)), true, 'the imported HIGH patterns match nothing, so this fence proves nothing');
  });

  for (const file of FILES) {
    test(`${file} carries no HIGH-severity secret on any line`, () => {
      const high = highPatterns();
      const hits = [];
      const lines = fs.readFileSync(path.join(HERE, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const p of high) if (p.re.test(line)) hits.push(`${file}:${i + 1} ${p.name}`);
      });
      assert.deepEqual(hits, [], `HIGH-severity secret pattern(s) in a file this task adds:\n  ${hits.join('\n  ')}`);
    });
  }

  test('the four files this task adds are all present and all scanned', () => {
    for (const file of FILES) assert.equal(fs.existsSync(path.join(HERE, file)), true, `${file} is missing, so the fence above scanned nothing for it`);
  });
});

// ---------------------------------------------------------------------------------------------
/*
 * The probe CLI's own refusals, driven through its exported functions rather than as a child process:
 * it is a reader of a project's config, and every way it can fail to reach the client is
 * CANNOT_DETERMINE. No project directory here is a real target; each is a temporary one this test wrote.
 */
describe('probe.js · reading one provider block out of a project config', () => {
  const os = require_('node:os');
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rp-oai-probe-'));
  const writeConfig = (dir, doc) => {
    fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), `${JSON.stringify(doc, null, 2)}\n`);
    return dir;
  };
  const block = () => ({ protocol: 'openai-compatible', baseUrl: BASE, apiKeyEnv: ENV_NAME, models: MODELS.slice() });

  test('a directory that does not exist is CANNOT_DETERMINE, never FAIL', async () => {
    const r = await probeCli.runProbe({ dir: path.join(tmp(), 'nope'), provider: 'testprovider', env: withKey() });
    assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(r.checks[0].detail, /does not exist/);
  });

  test('a config that will not parse is CANNOT_DETERMINE', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), '{ not json');
    const r = await probeCli.runProbe({ dir, provider: 'testprovider', env: withKey() });
    assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(r.checks[0].detail, /UNKNOWN/);
  });

  test('no providers map, and an undeclared provider, are each CANNOT_DETERMINE naming what IS declared', async () => {
    const none = await probeCli.runProbe({ dir: writeConfig(tmp(), { respawnpack: '0.3.0' }), provider: 'testprovider', env: withKey() });
    assert.equal(none.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(none.checks[0].detail, /no `providers` map/);

    const other = await probeCli.runProbe({
      dir: writeConfig(tmp(), { providers: { otherprovider: block() } }),
      provider: 'testprovider',
      env: withKey(),
    });
    assert.equal(other.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(other.checks[0].detail, /otherprovider/);
  });

  test('a block for another protocol is somebody else\'s adapter, not a failure of this one', async () => {
    const dir = writeConfig(tmp(), { providers: { testprovider: { ...block(), protocol: 'anthropic-compatible' } } });
    const r = await probeCli.runProbe({ dir, provider: 'testprovider', env: withKey() });
    assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(r.checks[0].detail, /anthropic-compatible/);
  });

  test('a block the client refuses is CANNOT_DETERMINE quoting the refusal, and never reaches a host', async () => {
    const fetchImpl = fakeFetch(() => response(200, { data: [] }));
    const dir = writeConfig(tmp(), { providers: { testprovider: { ...block(), baseUrl: 'http://api.example.invalid/v1' } } });
    const r = await probeCli.runProbe({ dir, provider: 'testprovider', env: withKey(), fetchImpl });
    assert.equal(r.outcome, OUTCOME.CANNOT_DETERMINE);
    assert.match(r.checks[0].detail, /https/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('a well-formed block runs the client\'s own probe, and the report names the config it read', async () => {
    const fetchImpl = fakeFetch(() => response(200, { object: 'list', data: MODELS.map((id) => ({ id })) }));
    const dir = writeConfig(tmp(), { providers: { testprovider: block() } });
    const r = await probeCli.runProbe({ dir, provider: 'testprovider', env: withKey(), fetchImpl });
    assert.equal(r.outcome, OUTCOME.PASS);
    assert.equal(r.configPath, path.join(dir, 'respawnpack.config.json'));
    assert.equal(fetchImpl.calls[0].url, `${BASE}/models`);
    assert.equal(JSON.stringify(r).includes(SENTINEL), false, 'the CLI report leaked the key value');
  });

  test('every outcome maps to the pack\'s own exit codes, and CANNOT_DETERMINE keeps its own', () => {
    const { exitCodeFor } = core.failures;
    assert.equal(exitCodeFor(OUTCOME.PASS), 0);
    assert.equal(exitCodeFor(OUTCOME.FAIL), 1);
    assert.equal(exitCodeFor(OUTCOME.CANNOT_DETERMINE), 2);
  });

  test('an unknown option is refused before anything runs, and --help prints the header', () => {
    assert.throws(() => probeCli.parseArgs(['--wat']), /unknown option/);
    assert.deepEqual(probeCli.parseArgs(['--dir', 'x', '--provider', 'p', '--json']), { dir: 'x', provider: 'p', json: true, timeoutMs: null, help: false });
    assert.match(probeCli.helpText(), /--provider/);
  });
});
