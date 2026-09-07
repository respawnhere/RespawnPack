/*
 * RespawnPack · adapters/providers/offload.test.mjs — the offload path across the three providers,
 * driven entirely against fakes.
 *
 * ⛔ NOTHING HERE REACHES A PROVIDER, AND THAT IS A PROPERTY OF THE SUITE RATHER THAN A HABIT. The three
 * ways out of this pack are faked at their own boundary and nowhere deeper: the Claude family through an
 * injected `runTurn` beside the REAL executable resolver, pointed by `RESPAWNPACK_CLAUDE_PATH` at a fake
 * claude script written into a temporary directory; the Codex family through an injected transport of
 * exactly the shape `rpc.createConnection` exposes, the way adapters/codex/app-server/supervisor.test.mjs
 * does it; and the OpenAI-compatible family through an injected `fetch` against
 * `https://api.example.invalid/v1`, a name RFC 2606 reserves and no resolver answers. No real `claude`
 * and no real `codex` is ever spawned. Unplug the network and this suite is unchanged.
 *
 * ⛔ AND NOTHING HERE READS A REAL KEY. The injected environment carries the sentinel below, which is
 * the apparatus of the redaction fence: a value that would be unmistakable if it ever appeared in the
 * receipt, in the answer file, on stdout, on stderr, or in any file under the target's runtime
 * directory. The fence greps all five (anti-drift item 52). One scenario has the fake host ECHO the
 * Authorization header back inside the answer, which is a thing real proxies do, so the fence proves a
 * mechanism rather than proving that we happened not to copy anything.
 *
 * ⛔ EVERY TARGET IS MATERIALISED, NEVER HAND-BUILT. `ops/_project-fixtures.mjs` is the one definition
 * of what a project archetype is, and the two this suite proves on are chosen for the fork they exercise
 * rather than for variety: `docs-only` carries an INSTALLED capability register under
 * docs/reference/models/, so the offload must read the target's; `ops-infra` carries none, so the
 * offload must fall back to this pack's own. The receipt says which in both cases, and the two registers
 * disagree about which model wins on purpose, so the assertion is about the ROUTE and not only about a
 * label the writer could have stamped either way.
 *
 * ⛔ THE COMMAND LINE IS EXERCISED THROUGH `main()`, WITH THE SAME FAKES. Spawning the CLI as a child
 * would reach the real probes: the real PATH scan for `claude`, and `where codex` for the app-server. A
 * suite that did that would pass or fail according to what happens to be installed on the machine
 * running it, which is the opposite of a test. `main()` takes its dependencies as an optional second
 * argument for exactly this, and the CLI entry point passes none.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { materialize } from '../../ops/_project-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures');
const require_ = createRequire(import.meta.url);

const offload = require_(path.join(HERE, 'offload.js'));
const envelopes = require_(path.join(HERE, 'envelopes.js'));
const turnClaude = require_(path.join(HERE, 'turn-claude.js'));
const turnCodex = require_(path.join(HERE, 'turn-codex.js'));
const claudeCliLib = require_(path.join(ROOT, 'adapters', 'claude-code', 'sdk-supervisor', 'cli.js'));
const routing = require_(path.join(ROOT, 'core', 'policy', 'routing.js'));

import { validate } from '../../schemas/validate.mjs';

const RECEIPT_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'offload-receipt.schema.json'), 'utf8'));
const PACK_REGISTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'spine', 'reference', 'models', 'capability-register.json'), 'utf8'));

// --- the fixture vocabulary --------------------------------------------------------------------------

/** The value that must never appear anywhere but one request header. Distinctive on purpose. */
const SENTINEL = 'sentinel-offload-key-do-not-print';
const ENV_NAME = 'OFFLOAD_TEST_API_KEY';
const BASE = 'https://api.example.invalid/v1';

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-offload-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };
const read = (p) => fs.readFileSync(p, 'utf8');
const golden = (name) => read(path.join(FIXTURES, name));

/** Every file under a directory, recursively. The redaction fence needs all of them, not the ones it guessed. */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * A target project, materialised from the shared archetype helper.
 *
 * `installedRegister` writes the standards copy the offload must prefer; `providers` writes the config
 * block the OpenAI-compatible family is declared in. Both are what a real target would carry, put there
 * the way a real target gets them rather than invented in a shape only this suite understands.
 */
function target(archetype, { installedRegister = null, providers = true } = {}) {
  const dir = tmp(archetype);
  materialize(archetype, dir, { git: false });
  if (installedRegister) {
    const p = path.join(dir, 'docs', 'reference', 'models', 'capability-register.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(installedRegister, null, 2)}\n`);
  }
  if (providers) {
    fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), `${JSON.stringify({
      providers: {
        minimax: { protocol: 'openai-compatible', baseUrl: BASE, apiKeyEnv: ENV_NAME, models: ['MiniMax-M3', 'MiniMax-M2.7'] },
      },
    }, null, 2)}\n`);
  }
  return dir;
}

/**
 * A register for the TARGET that disagrees with the pack's about which minimax model wins: MiniMax-M3
 * is removed, so a route that reads this file lands on MiniMax-M2.7 and a route that read the pack's
 * would land on MiniMax-M3. The date differs too, so both halves of "which file decided" are provable.
 */
function targetRegister() {
  const doc = JSON.parse(JSON.stringify(PACK_REGISTER));
  doc.asOf = '2026-01-09';
  doc.models = doc.models.filter((m) => m.id !== 'MiniMax-M3');
  return doc;
}

/** An input file inside the target, and the path to it. */
function unit(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

// --- the fake claude script, and a CLI whose resolver is the REAL one ---------------------------------

/**
 * A real file on disk that a real `resolveExecutable` finds. It is never spawned by this suite: the
 * injected `runTurn` below answers instead. It exists because the AVAILABILITY probe is a filesystem
 * question, and a probe answered by a fake resolver would prove the fake rather than the probe.
 */
function fakeClaudeScript(dir) {
  const p = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(p, [
    '#!/usr/bin/env node',
    "// A stand-in for the claude CLI. adapters/providers/offload.test.mjs resolves this file through the",
    '// REAL resolver and never spawns it; if it ever were spawned, it prints one ordinary stream-json turn.',
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-0001', model: 'fake' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'assistant', session_id: 'fake-0001', message: { id: 'msg_fake', model: 'fake', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'fake' }] } }) + '\\n');",
    '',
  ].join('\n'));
  return p;
}

const assistantLine = (text, usage) => JSON.stringify({
  type: 'assistant',
  session_id: 'offload-0001',
  message: { id: 'msg_offload', model: 'claude-sonnet-5', role: 'assistant', type: 'message', stop_reason: 'end_turn', usage, content: [{ type: 'text', text }] },
});
const initLine = () => JSON.stringify({ type: 'system', subtype: 'init', session_id: 'offload-0001', model: 'claude-sonnet-5', tools: [] });
const resultLine = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, result: text, session_id: 'offload-0001', usage: { input_tokens: 100, output_tokens: 10 }, modelUsage: {} });

/**
 * A Claude CLI surface whose RESOLVER is the production one and whose `runTurn` is a recording fake.
 * `calls` carries every invocation, so the `--tools ""` bound is asserted from what the turn module
 * actually asked for rather than from a comment about it.
 */
function claudeCli({ text = 'The Claude family answered.', code = 0, timedOut = false, spawnError = null, authFailed = false } = {}) {
  const calls = [];
  return {
    calls,
    resolveExecutable: claudeCliLib.resolveExecutable,
    buildTurnArgs: claudeCliLib.buildTurnArgs,
    async runTurn(opts) {
      calls.push(opts);
      const lines = [initLine()];
      if (authFailed) {
        lines.push(JSON.stringify({ type: 'assistant', session_id: 'offload-0001', error: 'authentication_failed', message: { id: 'm', model: 'x', role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: 'authentication_failed' }] } }));
      } else if (text) {
        lines.push(assistantLine(text, { input_tokens: 512, output_tokens: 31, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));
        lines.push(resultLine(text));
      }
      return {
        ok: code === 0 && !timedOut && !spawnError,
        code, signal: null, timedOut, spawnError,
        stdoutLines: lines, stdout: lines.join('\n'), stderr: code === 0 ? '' : 'the fake host wrote this to stderr',
        argv: ['fake-claude', ...claudeCliLib.buildTurnArgs(opts)],
        exePath: 'fake-claude', durationMs: 3,
      };
    },
  };
}

// --- the fake Codex transport ------------------------------------------------------------------------

/**
 * Exactly the surface `adapters/providers/turn-codex.js` uses, and nothing more, so a turn module that
 * started using a new transport method fails here rather than silently working in the tests and not in
 * production. The same discipline adapters/codex/app-server/supervisor.test.mjs states for its own fake.
 */
function fakeConn({ text = 'The Codex family answered.', approvalPolicy = 'never', sandbox = { type: 'readOnly', networkAccess: false }, turnStatus = 'completed', completes = true } = {}) {
  const notifications = [];
  const sent = [];
  const push = (o) => notifications.push({ seq: notifications.length, method: o.method, params: o.params, raw: JSON.stringify(o) });
  const conn = {
    sent,
    async send(method, params) {
      sent.push({ method, params });
      if (method === 'thread/start') {
        return { ok: true, result: { thread: { id: 'thr-1' }, approvalPolicy, sandbox }, raw: '{}' };
      }
      if (method === 'turn/start') {
        push({ method: 'turn/started', params: { threadId: 'thr-1', turn: { id: 'turn-1' } } });
        if (text) push({ method: 'item/completed', params: { threadId: 'thr-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'msg-1', text } } });
        push({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 640, outputTokens: 22 } } } });
        if (completes) {
          push({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: turnStatus, items: text ? [{ type: 'agentMessage', id: 'msg-1', text }] : [], error: null } } });
        }
        return { ok: true, result: { turn: { id: 'turn-1' } }, raw: '{}' };
      }
      return { ok: false, kind: 'ERROR', detail: `no fake response for ${method}` };
    },
    waitFor(predicate, { from = 0, timeoutMs = 0, label = '' } = {}) {
      const hit = notifications.slice(from).find((n) => { try { return predicate(n); } catch { return false; } });
      if (hit) return Promise.resolve({ ok: true, note: hit });
      return Promise.resolve({ ok: false, kind: 'TIMEOUT', waitedMs: timeoutMs, detail: `${label} did not arrive within ${timeoutMs}ms` });
    },
    since: (cursor) => notifications.slice(cursor),
    notificationCount: () => notifications.length,
    closed: false,
    close() { conn.closed = true; },
  };
  return conn;
}

const codexResolves = (dir) => () => ({ ok: true, codexJs: path.join(dir, 'fake-codex.js'), via: 'the offline suite', searched: [] });
const codexAbsent = () => ({ ok: false, detail: 'no codex.js could be resolved in this fixture', searched: [] });
const codexConnectTo = (conn) => async () => ({ ok: true, conn, initialize: { userAgent: 'fake' }, raw: '{}' });

// --- the fake fetch ----------------------------------------------------------------------------------

const response = (status, body, statusText = '') => ({ status, statusText, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length - 1); };
  fn.calls = calls;
  return fn;
}

const answers = (text = 'The OpenAI-compatible provider answered.') => fakeFetch(async () => response(200, {
  model: 'MiniMax-M3',
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1024, completion_tokens: 48 },
}));

/** A host that echoes the request's own Authorization header back inside the answer, as proxies do. */
const echoesTheHeader = () => fakeFetch(async (url, init) => response(200, {
  model: 'MiniMax-M3',
  choices: [{ message: { role: 'assistant', content: `the host saw: ${init.headers.Authorization}` }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
}));

const refuses = (status, body) => fakeFetch(async () => response(status, body || { error: { message: 'no' } }, 'Refused'));

// --- dependency sets ---------------------------------------------------------------------------------

/** The three probes, wired so each family can be present or absent independently. */
function deps({ claude = null, codex = null, fetchImpl = null } = {}) {
  return {
    claudeCli: claude || claudeCli(),
    resolveCodexJs: codex || codexAbsent,
    codexConnect: codex ? codexConnectTo(fakeConn()) : undefined,
    codexHandshake: Boolean(codex),
    fetchImpl: fetchImpl || answers(),
  };
}

const envWithKey = (claudeScript = null) => ({
  [ENV_NAME]: SENTINEL,
  ...(claudeScript ? { RESPAWNPACK_CLAUDE_PATH: claudeScript } : {}),
  PATH: '',
  Path: '',
});

// =====================================================================================================
describe('the per-family prompt envelopes are golden files, not prose about a table', () => {
  const input = golden('envelope-input.md');

  for (const family of ['anthropic', 'openai', 'minimax']) {
    test(`the ${family} envelope matches its golden file byte for byte`, () => {
      const composed = envelopes.compose({ family, taskClass: 'review', input });
      assert.equal(composed.envelope, family);
      assert.equal(composed.fallback, false, `${family} was composed with the fallback envelope`);
      assert.equal(`${composed.text}\n`, golden(`envelope-review-${family}.txt`));
    });
  }

  test('a family the table does not profile gets the general envelope, and the prompt itself says so', () => {
    const composed = envelopes.compose({ family: 'a-maker-nobody-has-written-a-standard-for', taskClass: 'review', input });
    assert.equal(composed.envelope, 'general');
    assert.equal(composed.fallback, true);
    assert.match(composed.text, /general prompting envelope, which is the fallback/,
      'the fallback envelope does not disclose itself in the prompt, so only the receipt would know');
    assert.equal(`${composed.text}\n`, golden('envelope-review-general.txt'));
  });

  test('⛔ the four goldens are four DIFFERENT documents — a table that collapsed to one shape would pass every check above', () => {
    const texts = ['anthropic', 'openai', 'minimax', 'general'].map((f) => golden(`envelope-review-${f}.txt`));
    const unique = new Set(texts);
    assert.equal(unique.size, 4, 'two or more family envelopes are byte-identical, so the per-family table is doing nothing');
  });

  test('⛔ the comparison discriminates — a mutated golden fails it', () => {
    const composed = envelopes.compose({ family: 'anthropic', taskClass: 'review', input });
    const mutated = golden('envelope-review-anthropic.txt').replace('<material>', '<input>');
    assert.notEqual(`${composed.text}\n`, mutated, 'the golden comparison accepted a document the composer does not produce');
  });

  test('every task class has a brief, in the routing policy\'s own vocabulary and no other', () => {
    assert.deepEqual(Object.keys(envelopes.CLASS_BRIEF).sort(), [...routing.TASK_CLASSES].sort(),
      'the envelope table and core/policy/routing.js disagree about what the task classes are');
    for (const c of routing.TASK_CLASSES) {
      assert.ok(envelopes.compose({ family: 'anthropic', taskClass: c, input }).text.includes(`Task class: ${c}`));
    }
  });

  test('an unknown task class throws rather than composing a prompt nobody asked for', () => {
    assert.throws(() => envelopes.compose({ family: 'anthropic', taskClass: 'pentesting', input }), /unknown task class/);
  });
});

// =====================================================================================================
describe('the register: the target\'s installed standards first, this pack\'s own as the fallback', () => {
  test('docs-only WITH the standards installed routes from the TARGET register, and the receipt says so', async () => {
    const dir = target('docs-only', { installedRegister: targetRegister() });
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n\nOne paragraph.\n');
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: envWithKey(), deps: deps() });
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.receipt.register.source, 'target');
      // Recorded RELATIVE to the project, because that is where a reader of this receipt will look.
      assert.equal(r.receipt.register.path, 'docs/reference/models/capability-register.json');
      assert.equal(r.receipt.register.asOf, '2026-01-09', 'the receipt records a date the target register does not carry');
      // The route is the discriminator: this register does not carry MiniMax-M3 at all.
      assert.equal(r.receipt.route.model, 'MiniMax-M2.7',
        'the route landed on a model the TARGET register does not declare, so the pack copy decided after all');
    } finally { rm(dir); }
  });

  test('ops-infra with NO installed standards falls back to the pack register, and the receipt says so', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n\nOne paragraph.\n');
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: envWithKey(), deps: deps() });
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(r.receipt.register.source, 'pack');
      // Recorded ABSOLUTE, because the useful fact about the fallback is WHICH checkout decided.
      assert.equal(r.receipt.register.path, path.resolve(ROOT, 'spine/reference/models/capability-register.json').split(path.sep).join('/'));
      assert.equal(r.receipt.register.asOf, PACK_REGISTER.asOf);
      assert.equal(r.receipt.route.model, 'MiniMax-M3',
        'the pack register was named as the source and the route is not the one it produces');
    } finally { rm(dir); }
  });

  /*
   * ⛔ THE MECHANISM IS ARCHETYPE-INDEPENDENT, AND THAT IS CHECKED RATHER THAN CLAIMED. Nothing the
   * offload reads is a property of the project's language or shape: the register lives at a
   * pack-installed standards path, the provider block lives in respawnpack.config.json, and the receipt
   * lives under .respawnpack/runtime/. Two archetypes prove the register fork above; all four prove that
   * the fork is the ONLY thing that varies, so a fifth archetype would need no new code.
   */
  const SHARED_UNIT = '# The material\n\nIdentical across every archetype.\n';
  const SHARED_DIGEST = require_(path.join(ROOT, 'core', 'index.js')).io.digest(SHARED_UNIT);
  for (const archetype of ['docs-only', 'ops-infra', 'greenfield-app', 'mature-product']) {
    test(`the same offload behaves identically on the ${archetype} archetype`, async () => {
      const dir = target(archetype);
      try {
        const inFile = unit(dir, 'unit.md', SHARED_UNIT);
        const outFile = path.join(dir, 'answer.md');
        const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, outFile, env: envWithKey(), deps: deps() });
        assert.equal(r.outcome, 'PASS', r.summary);
        assert.equal(r.receipt.register.source, 'pack');
        assert.equal(r.receipt.route.model, 'MiniMax-M3');
        // The same bytes give the same id in every archetype, which is what makes the id a property of
        // the WORK rather than of the project it happened to be run against.
        assert.equal(r.receipt.input.digest, SHARED_DIGEST);
        assert.equal(r.receipt.id, offload.receiptId(SHARED_DIGEST, 'writing'));
        assert.equal(fs.existsSync(outFile), true);
        assert.equal(validate(JSON.parse(read(r.receiptPath)), RECEIPT_SCHEMA).valid, true);
      } finally { rm(dir); }
    });
  }

  test('⛔ a register that exists and cannot be read is CANNOT_DETERMINE, never a quiet fall through to the pack copy', async () => {
    const dir = target('docs-only');
    try {
      const p = path.join(dir, 'docs', 'reference', 'models', 'capability-register.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{ this is not json');
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: envWithKey(), deps: deps() });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.match(r.summary, /MALFORMED/);
      assert.equal(r.receiptWritten, false, 'a receipt was written for a run that never chose a route');
    } finally { rm(dir); }
  });
});

// =====================================================================================================
describe('the route reaches the receipt, and an unreachable family is skipped by name', () => {
  test('the whole route is recorded: family, model, rating, why, practice, alternatives and skipped', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: envWithKey(), deps: deps() });
      const route = r.receipt.route;
      assert.equal(route.family, 'minimax');
      assert.equal(route.model, 'MiniMax-M3');
      assert.equal(route.rating, 'capable');
      assert.match(route.why, /best-ranked available candidate/);
      assert.equal(route.practice, 'docs/reference/models/prompting-minimax.md');
      assert.ok(route.alternatives.some((a) => a.model === 'MiniMax-M2.7'), 'the candidate it beat is not recorded');
      assert.equal(r.receipt.envelope.name, 'minimax');
      assert.equal(r.receipt.envelope.fallback, false);
    } finally { rm(dir); }
  });

  test('⛔ an unavailable family is SKIPPED with the probe\'s own reason on the receipt, not silently dropped', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: envWithKey(), deps: deps() });
      const skipped = Object.fromEntries(r.receipt.route.skipped.map((s) => [s.family, s.why]));
      assert.ok(skipped.anthropic, 'the Claude family was unreachable and does not appear in the skipped list');
      assert.match(skipped.anthropic, /no `claude` executable was found on PATH/,
        'the skip reason is not the probe\'s own words');
      assert.ok(skipped.openai, 'the Codex family was unreachable and does not appear in the skipped list');
      assert.match(skipped.openai, /no codex\.js could be resolved/);
      // And the same evidence, in full, beside the route it was made from.
      const avail = Object.fromEntries(r.receipt.availability.map((a) => [a.family, a.ok]));
      assert.deepEqual(avail, { anthropic: false, openai: false, minimax: true });
    } finally { rm(dir); }
  });

  test('--family narrows the candidate set, and the families it excluded say so on the receipt', async () => {
    const dir = target('ops-infra');
    const script = fakeClaudeScript(dir);
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const cli = claudeCli();
      const r = await offload.runOffload({
        dir, taskClass: 'writing', inFile, family: 'anthropic',
        env: envWithKey(script), deps: deps({ claude: cli }),
      });
      assert.equal(r.receipt.route.family, 'anthropic', 'the caller named a family and the route ignored it');
      const skipped = Object.fromEntries(r.receipt.route.skipped.map((s) => [s.family, s.why]));
      assert.match(skipped.minimax, /restricted this offload to the family "anthropic" with --family/,
        'a family the caller excluded is recorded without the reason it was excluded');
      // The minimax family was genuinely REACHABLE, which is what makes this a restriction rather than
      // a coincidence: availability says yes and the route still did not consider it.
      assert.equal(r.receipt.availability.find((a) => a.family === 'minimax').ok, true);
    } finally { rm(dir); }
  });

  test('a route that settles on no model writes a receipt saying so, and spends nothing', async () => {
    const dir = target('ops-infra', { providers: false });
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const fetchImpl = answers();
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: {}, deps: deps({ fetchImpl }) });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.equal(r.receipt.route.model, null);
      assert.equal(r.receipt.provider.kind, offload.NO_ROUTE);
      assert.equal(r.receipt.provider.name, null);
      assert.equal(fetchImpl.calls.length, 0, 'a route that chose nothing still reached a provider');
      assert.equal(r.receiptWritten, true, 'the offload ran, chose nothing, and left no record of having done so');
    } finally { rm(dir); }
  });
});

// =====================================================================================================
describe('the receipt is created once and never replaced', () => {
  test('it validates against schemas/offload-receipt.schema.json, from a real run', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const outFile = path.join(dir, 'answer.md');
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, outFile, env: envWithKey(), deps: deps() });
      const doc = JSON.parse(read(r.receiptPath));
      const v = validate(doc, RECEIPT_SCHEMA);
      assert.equal(v.valid, true, `the receipt this pack wrote does not conform to its own schema:\n  ${v.errors.join('\n  ')}`);
      assert.equal(doc.output.path.endsWith('answer.md'), true);
      assert.equal(doc.output.bytes, Buffer.byteLength(read(outFile), 'utf8'));
      assert.equal(doc.input.digest.length, 64);
    } finally { rm(dir); }
  });

  test('⛔ a second run of the SAME unit of work is refused, and the first receipt is untouched', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const first = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: envWithKey(), deps: deps() });
      assert.equal(first.outcome, 'PASS', first.summary);
      const before = read(first.receiptPath);

      const fetchImpl = answers('a DIFFERENT answer that must never replace the first');
      const second = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: envWithKey(), deps: deps({ fetchImpl }) });
      assert.equal(second.outcome, 'CANNOT_DETERMINE');
      assert.equal(second.exitCode, 2);
      assert.match(second.summary, /already exists and is never replaced/);
      assert.equal(read(first.receiptPath), before, 'the second run rewrote the first run\'s receipt');
      assert.equal(fetchImpl.calls.length, 0, 'the refused run still spent a turn on the provider');
    } finally { rm(dir); }
  });

  test('a DIFFERENT unit of work gets its own id and its own receipt', async () => {
    const dir = target('ops-infra');
    try {
      const a = await offload.runOffload({ dir, taskClass: 'writing', inFile: unit(dir, 'a.md', 'material A\n'), env: envWithKey(), deps: deps() });
      const b = await offload.runOffload({ dir, taskClass: 'writing', inFile: unit(dir, 'b.md', 'material B\n'), env: envWithKey(), deps: deps() });
      assert.notEqual(a.receiptPath, b.receiptPath);
      assert.equal(a.outcome, 'PASS');
      assert.equal(b.outcome, 'PASS');
      // The class is part of the id too, so the same bytes offloaded as a different class is a different unit.
      const c = await offload.runOffload({ dir, taskClass: 'review', inFile: path.join(dir, 'a.md'), env: envWithKey(), deps: deps() });
      assert.notEqual(c.receiptPath, a.receiptPath);
    } finally { rm(dir); }
  });

  test('⛔ the exclusive create is what refuses, not only the pre-flight check', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const digest = require_(path.join(ROOT, 'core', 'index.js')).io.digest(read(inFile));
      const id = offload.receiptId(digest, 'writing');
      const receiptPath = offload.receiptPathFor(dir, id);
      // Created AFTER the pre-flight check would have run and before the write: the state a concurrent
      // second offload leaves behind. Only O_EXCL can catch this one.
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      const claimed = '{"claimed":"by a concurrent run"}\n';
      const fetchImpl = fakeFetch(async () => { fs.writeFileSync(receiptPath, claimed); return response(200, { choices: [{ message: { content: 'answered' } }] }); });
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: envWithKey(), deps: deps({ fetchImpl }) });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.receiptWritten, false);
      assert.equal(read(receiptPath), claimed, 'the exclusive create overwrote a receipt another run had already claimed');
      assert.match(r.summary, /never replaced/);
    } finally { rm(dir); }
  });
});

// =====================================================================================================
describe('a turn that fails is CANNOT_DETERMINE at exit 2, carrying the provider\'s own kind', () => {
  const cases = [
    { label: 'the OpenAI-compatible host refuses the credential', kind: 'AUTH', build: () => ({ fetchImpl: refuses(401) }) },
    { label: 'the OpenAI-compatible host is out of quota', kind: 'QUOTA', build: () => ({ fetchImpl: refuses(429) }) },
    { label: 'the OpenAI-compatible host answers a body that is not a completion', kind: 'MALFORMED', build: () => ({ fetchImpl: fakeFetch(async () => response(200, { nothing: 'useful' })) }) },
    { label: 'the OpenAI-compatible host answers with no assistant text', kind: 'EMPTY', build: () => ({ fetchImpl: fakeFetch(async () => response(200, { choices: [] })) }) },
  ];

  for (const c of cases) {
    test(`${c.label} is exit 2 with kind ${c.kind}`, async () => {
      const dir = target('ops-infra');
      try {
        const inFile = unit(dir, 'unit.md', '# The material\n');
        const outFile = path.join(dir, 'answer.md');
        const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, outFile, env: envWithKey(), deps: deps(c.build()) });
        assert.equal(r.outcome, 'CANNOT_DETERMINE', r.summary);
        assert.equal(r.exitCode, 2, 'a provider that would not answer was reported as a failure of the work');
        assert.equal(r.receipt.provider.kind, c.kind);
        assert.ok(r.receipt.provider.detail && r.receipt.provider.detail.length > 20, 'the receipt carries a kind with no detail a reader could act on');
        assert.equal(fs.existsSync(outFile), false, 'a turn that produced nothing still wrote an answer file');
        assert.equal(r.receipt.output.digest, null);
      } finally { rm(dir); }
    });
  }

  test('an unset credential variable is NOT_AVAILABLE at the probe, so the family is never even routed to', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const fetchImpl = answers();
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, env: { PATH: '' }, deps: deps({ fetchImpl }) });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.receipt.provider.kind, offload.NO_ROUTE);
      assert.equal(fetchImpl.calls.length, 0, 'a family whose key is unset was still called');
      const why = r.receipt.availability.find((a) => a.family === 'minimax').why;
      assert.match(why, new RegExp(ENV_NAME), 'the availability row does not name the variable');
      assert.ok(!why.includes(SENTINEL), 'the availability row carries the value rather than the variable name');
    } finally { rm(dir); }
  });

  test('⛔ the exit code is never 1 — the schema has no spelling for a FAILED offload', () => {
    assert.deepEqual(RECEIPT_SCHEMA.properties.outcome.enum, ['PASS', 'CANNOT_DETERMINE']);
    assert.deepEqual(RECEIPT_SCHEMA.properties.exitCode.enum, [0, 2]);
    const doc = JSON.parse(read(path.join(ROOT, 'schemas', 'fixtures', 'offload-receipt', 'valid.json')));
    assert.equal(validate({ ...doc, outcome: 'FAIL', exitCode: 1 }, RECEIPT_SCHEMA).valid, false,
      'a receipt claiming the offload FAILED validates, so the rule is prose rather than a schema');
  });

  test('⛔ nothing retries on a second provider, and the receipt says so in words', async () => {
    const dir = target('ops-infra');
    const script = fakeClaudeScript(dir);
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const cli = claudeCli();
      // Both families REACHABLE, and the routed one refuses. A silent fallback would answer anyway,
      // because the other family is sitting right there with a working fake behind it.
      const r = await offload.runOffload({
        dir, taskClass: 'writing', inFile, family: 'minimax',
        env: envWithKey(script), deps: deps({ claude: cli, fetchImpl: refuses(429) }),
      });
      assert.equal(r.receipt.availability.find((a) => a.family === 'anthropic').ok, true,
        'the other family was unreachable, so this test could not have caught a fallback');
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.receipt.route.family, 'minimax');
      assert.equal(cli.calls.length, 0, 'the offload retried the failed work on another family without saying so');
      assert.equal(r.receipt.retry.attempted, false);
      assert.equal(r.receipt.retry.from, null);
      assert.equal(r.receipt.retry.to, null);
      assert.ok(r.receipt.retry.why.length > 40, 'the receipt records a bare false where the reason belongs');
    } finally { rm(dir); }
  });
});

// =====================================================================================================
describe('--dry-run spawns nothing and writes nothing', () => {
  test('the runtime directory and the --out file are untouched, and no provider was called', async () => {
    const dir = target('ops-infra');
    const script = fakeClaudeScript(dir);
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const outFile = path.join(dir, 'answer.md');
      const runtime = path.join(dir, '.respawnpack', 'runtime');
      const cli = claudeCli();
      const fetchImpl = answers();
      const conn = fakeConn();

      const r = await offload.runOffload({
        dir, taskClass: 'writing', inFile, outFile, dryRun: true,
        env: envWithKey(script),
        deps: { claudeCli: cli, resolveCodexJs: codexResolves(dir), codexConnect: codexConnectTo(conn), fetchImpl },
      });

      assert.equal(r.receiptWritten, false);
      assert.equal(fs.existsSync(runtime), false, 'the dry run created the runtime directory');
      assert.equal(fs.existsSync(outFile), false, 'the dry run wrote the answer file');
      assert.equal(cli.calls.length, 0, 'the dry run spawned a Claude turn');
      assert.equal(fetchImpl.calls.length, 0, 'the dry run called the HTTP provider');
      assert.deepEqual(conn.sent.map((s) => s.method), [], 'the dry run started a Codex thread');

      // It still did the useful part: the route and the composed prompt.
      assert.ok(r.route.family);
      assert.match(r.composed.text, /# The material/);
      assert.equal(r.exitCode, 0, 'a dry run that answered the question reported a failure');
    } finally { rm(dir); }
  });

  test('the printed dry run names the register, the route and the composed prompt', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, dryRun: true, env: envWithKey(), deps: deps() });
      const lines = [];
      offload.printDryRun(r, (s) => lines.push(String(s)));
      const out = lines.join('\n');
      assert.match(out, /register {2}.*pack/);
      assert.match(out, /class {6}writing/);
      assert.match(out, /family {5}minimax/);
      assert.match(out, /not written: this is a dry run/);
      assert.match(out, /--- composed prompt ---/);
      assert.ok(out.includes('# The material'), 'the dry run printed a route and not the prompt it would send');
    } finally { rm(dir); }
  });
});

// =====================================================================================================
describe('⛔ the redaction fence holds through the whole offload (anti-drift item 52)', () => {
  /** Every surface the sentinel could reach, greped rather than reasoned about. */
  async function fenceRun({ fetchImpl, outName = 'answer.md' }) {
    const dir = target('ops-infra');
    const inFile = unit(dir, 'unit.md', '# The material\n');
    const outFile = path.join(dir, outName);
    const stdout = [];
    const stderr = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a) => stdout.push(a.join(' '));
    console.error = (...a) => stderr.push(a.join(' '));
    let code;
    try {
      code = await offload.main(
        ['--dir', dir, '--class', 'writing', '--in', inFile, '--out', outFile],
        { deps: deps({ fetchImpl }), env: envWithKey() },
      );
    } finally { console.log = log; console.error = err; }
    return { dir, outFile, stdout: stdout.join('\n'), stderr: stderr.join('\n'), code };
  }

  test('an ordinary run leaves the sentinel in nothing: receipt, answer, stdout, stderr, runtime tree', async () => {
    const r = await fenceRun({ fetchImpl: answers() });
    try {
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const files = walk(path.join(r.dir, '.respawnpack'));
      assert.ok(files.length >= 1, 'no runtime file was written, so the fence swept an empty tree');
      for (const f of [...files, r.outFile]) {
        assert.ok(!read(f).includes(SENTINEL), `the injected key value reached ${f}`);
      }
      assert.ok(!r.stdout.includes(SENTINEL), 'the injected key value reached stdout');
      assert.ok(!r.stderr.includes(SENTINEL), 'the injected key value reached stderr');
    } finally { rm(r.dir); }
  });

  test('⛔ a host that ECHOES the Authorization header back is redacted, so the fence proves a mechanism', async () => {
    const r = await fenceRun({ fetchImpl: echoesTheHeader() });
    try {
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      const answer = read(r.outFile);
      assert.match(answer, /the host saw: Bearer <redacted: the value of OFFLOAD_TEST_API_KEY>/,
        'the echoed header did not come back redacted, so the answer carries whatever the host chose to say');
      assert.ok(!answer.includes(SENTINEL), 'the value a hostile host echoed reached the answer file');
      for (const f of walk(path.join(r.dir, '.respawnpack'))) {
        assert.ok(!read(f).includes(SENTINEL), `the echoed value reached ${f}`);
      }
      assert.ok(!r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL));
    } finally { rm(r.dir); }
  });

  test('⛔ the control: the sentinel IS in the injected environment, so the fence above is searching for something reachable', async () => {
    assert.equal(envWithKey()[ENV_NAME], SENTINEL);
    const r = await fenceRun({ fetchImpl: echoesTheHeader() });
    try {
      // The one place it legitimately travels: the request header the fake host received.
      const seen = read(r.outFile);
      assert.ok(seen.includes('the host saw:'), 'the echo scenario did not actually echo, so nothing was there to redact');
    } finally { rm(r.dir); }
  });

  test('a refused turn carries the provider\'s words onto the receipt without the value', async () => {
    const r = await fenceRun({ fetchImpl: refuses(401, { error: { message: `key ${SENTINEL} is not valid` } }) });
    try {
      assert.equal(r.code, 2);
      const files = walk(path.join(r.dir, '.respawnpack'));
      for (const f of files) assert.ok(!read(f).includes(SENTINEL), `a refusal quoting the key wrote it to ${f}`);
      assert.ok(!r.stderr.includes(SENTINEL), 'a refusal quoting the key printed it to stderr');
    } finally { rm(r.dir); }
  });
});

// =====================================================================================================
describe('⛔ hook-bearing work never leaves the Claude family (anti-drift item 54)', () => {
  test('requiresHooks routes to the hooked family even when another is available and better rated', async () => {
    const dir = target('ops-infra');
    const script = fakeClaudeScript(dir);
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const cli = claudeCli();
      const fetchImpl = answers();
      const r = await offload.runOffload({
        dir, taskClass: 'writing', inFile, requiresHooks: true,
        env: envWithKey(script), deps: deps({ claude: cli, fetchImpl }),
      });
      assert.equal(r.receipt.route.family, routing.HOOKED_FAMILY);
      assert.match(r.receipt.route.why, /requiresHooks restricted routing to anthropic/);
      assert.equal(fetchImpl.calls.length, 0, 'hook-bearing work reached a hookless provider');
      assert.equal(cli.calls.length, 1);
    } finally { rm(dir); }
  });

  test('⛔ the nearest bypass fails: --model naming a model in another family does not pull hooked work off Claude', async () => {
    const dir = target('ops-infra');
    const script = fakeClaudeScript(dir);
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const cli = claudeCli();
      const fetchImpl = answers();
      const r = await offload.runOffload({
        dir, taskClass: 'writing', inFile, requiresHooks: true, model: 'MiniMax-M3',
        env: envWithKey(script), deps: deps({ claude: cli, fetchImpl }),
      });
      assert.equal(r.receipt.route.family, routing.HOOKED_FAMILY);
      assert.notEqual(r.receipt.route.model, 'MiniMax-M3');
      assert.equal(fetchImpl.calls.length, 0, 'an explicit --model carried hook-bearing work off the hooked family');
    } finally { rm(dir); }
  });

  test('the control: WITHOUT requiresHooks the very same call routes to the other family', async () => {
    const dir = target('ops-infra');
    const script = fakeClaudeScript(dir);
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const cli = claudeCli();
      const r = await offload.runOffload({
        dir, taskClass: 'writing', inFile, model: 'MiniMax-M3',
        env: envWithKey(script), deps: deps({ claude: cli }),
      });
      assert.equal(r.receipt.route.model, 'MiniMax-M3',
        'the requiresHooks tests above prove nothing if the unrestricted call routes to Claude anyway');
      assert.equal(cli.calls.length, 0);
    } finally { rm(dir); }
  });

  test('an offload never sets requiresHooks itself, and the command line has no flag that could', () => {
    const src = read(path.join(HERE, 'offload.js'));
    assert.match(src, /requiresHooks = false/, 'the offload no longer defaults requiresHooks to false');
    assert.ok(!/--requires-hooks/.test(src), 'the command line grew a flag for hook-bearing work, which an offload is not');
    const args = offload.parseArgs(['--dir', 'x', '--class', 'writing', '--in', 'y', '--requires-hooks']);
    assert.deepEqual(args.unknown, ['--requires-hooks'], 'an unrecognised flag was accepted rather than reported');
  });
});

// =====================================================================================================
describe('the Claude turn is bounded: no tools, and the stream is where the answer comes from', () => {
  test('⛔ the turn asks for `--tools ""`, which is what makes an offload not a session', async () => {
    const dir = target('ops-infra');
    const script = fakeClaudeScript(dir);
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const cli = claudeCli();
      await offload.runOffload({ dir, taskClass: 'writing', inFile, family: 'anthropic', env: envWithKey(script), deps: deps({ claude: cli }) });
      assert.equal(cli.calls.length, 1);
      assert.equal(cli.calls[0].tools, '', 'the offload did not disable tools, so it can read and write files');
      const argv = claudeCliLib.buildTurnArgs(cli.calls[0]);
      const i = argv.indexOf('--tools');
      assert.ok(i >= 0 && argv[i + 1] === '', `the composed argv does not carry an empty --tools: ${argv.join(' ')}`);
      assert.equal(cli.calls[0].promptVia, 'stdin', 'the prompt went on the command line rather than through stdin');
    } finally { rm(dir); }
  });

  test('⛔ the bypass: `tools: null` would omit the flag entirely and leave the default tool set armed', () => {
    const argv = claudeCliLib.buildTurnArgs({ prompt: 'x', tools: null });
    assert.equal(argv.includes('--tools'), false,
      'buildTurnArgs no longer distinguishes null from "", so passing the empty string is no longer meaningful');
  });

  test('the answer is the assistant text and the usage is the host\'s own', async () => {
    const dir = target('ops-infra');
    const script = fakeClaudeScript(dir);
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const outFile = path.join(dir, 'answer.md');
      const cli = claudeCli({ text: 'A bounded answer from the hooked family.' });
      const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, outFile, family: 'anthropic', env: envWithKey(script), deps: deps({ claude: cli }) });
      assert.equal(r.outcome, 'PASS', r.summary);
      assert.equal(read(outFile), 'A bounded answer from the hooked family.');
      assert.equal(r.receipt.provider.name, turnClaude.PROVIDER);
      assert.equal(r.receipt.usage.input, 512);
      assert.equal(r.receipt.usage.output, 31);
    } finally { rm(dir); }
  });

  const claudeFailures = [
    { label: 'a host that reported an authentication failure', kind: 'AUTH', opts: { authFailed: true } },
    { label: 'a turn killed at the deadline', kind: 'TIMEOUT', opts: { timedOut: true } },
    { label: 'a non-zero exit', kind: 'EXIT_9', opts: { code: 9 } },
    { label: 'a clean exit with no assistant text', kind: 'EMPTY', opts: { text: '' } },
  ];
  for (const c of claudeFailures) {
    test(`${c.label} is exit 2 with kind ${c.kind}`, async () => {
      const dir = target('ops-infra');
      const script = fakeClaudeScript(dir);
      try {
        const inFile = unit(dir, 'unit.md', '# The material\n');
        const r = await offload.runOffload({ dir, taskClass: 'writing', inFile, family: 'anthropic', env: envWithKey(script), deps: deps({ claude: claudeCli(c.opts) }) });
        assert.equal(r.outcome, 'CANNOT_DETERMINE');
        assert.equal(r.exitCode, 2);
        assert.equal(r.receipt.provider.kind, c.kind);
      } finally { rm(dir); }
    });
  }
});

// =====================================================================================================
describe('the Codex turn is bounded: a read-only sandbox with approvals off', () => {
  async function codexRun(connOpts = {}, runOpts = {}) {
    const dir = target('ops-infra');
    const conn = fakeConn(connOpts);
    const inFile = unit(dir, 'unit.md', '# The material\n');
    const outFile = path.join(dir, 'answer.md');
    const r = await offload.runOffload({
      dir, taskClass: 'writing', inFile, outFile, family: 'openai',
      env: envWithKey(),
      deps: { claudeCli: claudeCli(), resolveCodexJs: codexResolves(dir), codexConnect: codexConnectTo(conn), fetchImpl: answers() },
      ...runOpts,
    });
    return { dir, conn, r, outFile };
  }

  test('⛔ thread/start carries sandbox read-only and approvalPolicy never', async () => {
    const { dir, conn, r, outFile } = await codexRun();
    try {
      assert.equal(r.outcome, 'PASS', r.summary);
      const start = conn.sent.find((s) => s.method === 'thread/start');
      assert.ok(start, 'no thread was started');
      assert.equal(start.params.sandbox, turnCodex.SANDBOX);
      assert.equal(start.params.approvalPolicy, turnCodex.APPROVAL_POLICY);
      assert.equal(start.params.cwd, dir, 'the thread was started somewhere other than the target');
      assert.equal(read(outFile), 'The Codex family answered.');
      assert.equal(r.receipt.provider.name, turnCodex.PROVIDER);
      assert.equal(r.receipt.usage.input, 640);
      assert.equal(conn.closed, true, 'the transport was left open after a bounded turn');
    } finally { rm(dir); }
  });

  test('⛔ the bypass: a host that reports approvals ON is refused, and no turn is started', async () => {
    const { dir, conn, r } = await codexRun({ approvalPolicy: 'on-request' });
    try {
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.equal(r.exitCode, 2);
      assert.equal(r.receipt.provider.kind, turnCodex.TURN_FAILURE.POLICY);
      assert.match(r.receipt.provider.detail, /approvalPolicy "on-request"/);
      assert.equal(conn.sent.some((s) => s.method === 'turn/start'), false, 'a turn ran under a policy this offload refuses');
    } finally { rm(dir); }
  });

  test('⛔ the other half of the bypass: a WRITABLE sandbox is refused the same way', async () => {
    const { dir, conn, r } = await codexRun({ sandbox: { type: 'workspaceWrite', networkAccess: false } });
    try {
      assert.equal(r.receipt.provider.kind, turnCodex.TURN_FAILURE.POLICY);
      assert.match(r.receipt.provider.detail, /workspaceWrite/);
      assert.equal(conn.sent.some((s) => s.method === 'turn/start'), false);
    } finally { rm(dir); }
  });

  test('a host that reports NO policy at all is recorded rather than refused', async () => {
    const { dir, r } = await codexRun({ approvalPolicy: null, sandbox: null });
    try {
      assert.equal(r.outcome, 'PASS', 'an absent field was read as a statement that the policy was ignored');
    } finally { rm(dir); }
  });

  test('a turn that never completes is TIMEOUT, and one the host marks failed is TURN_FAILED', async () => {
    const a = await codexRun({ completes: false });
    try {
      assert.equal(a.r.receipt.provider.kind, turnCodex.TURN_FAILURE.TIMEOUT);
    } finally { rm(a.dir); }
    const b = await codexRun({ turnStatus: 'failed' });
    try {
      assert.equal(b.r.receipt.provider.kind, turnCodex.TURN_FAILURE.TURN_FAILED);
    } finally { rm(b.dir); }
  });

  test('a completed turn carrying no assistant message is EMPTY, not a silent success', async () => {
    const { dir, r, outFile } = await codexRun({ text: '' });
    try {
      assert.equal(r.receipt.provider.kind, turnCodex.TURN_FAILURE.EMPTY);
      assert.equal(fs.existsSync(outFile), false);
    } finally { rm(dir); }
  });
});

// =====================================================================================================
describe('the three availability probes: all present, one absent, all absent', () => {
  async function availability(depsIn, env) {
    const dir = target('ops-infra');
    try {
      const register = JSON.parse(read(path.join(ROOT, 'spine', 'reference', 'models', 'capability-register.json')));
      const providers = offload.readProviders({ dir });
      const { rows } = await offload.buildAvailability({ register, dir, providers, env, deps: depsIn });
      return Object.fromEntries(rows.map((r) => [r.family, r]));
    } finally { rm(dir); }
  }

  test('all three present', async () => {
    const dir = tmp('probe-all');
    try {
      const script = fakeClaudeScript(dir);
      const rows = await availability(
        { claudeCli: claudeCli(), resolveCodexJs: codexResolves(dir), codexConnect: codexConnectTo(fakeConn()), fetchImpl: answers() },
        envWithKey(script),
      );
      assert.deepEqual(Object.keys(rows).sort(), ['anthropic', 'minimax', 'openai']);
      for (const [family, row] of Object.entries(rows)) assert.equal(row.ok, true, `${family} was reported unreachable: ${row.why}`);
      assert.match(rows.openai.why, /answered the initialize handshake/);
    } finally { rm(dir); }
  });

  test('one absent: the other two are unaffected, and the reason is the probe\'s own', async () => {
    const dir = tmp('probe-one');
    try {
      const script = fakeClaudeScript(dir);
      const rows = await availability(
        { claudeCli: claudeCli(), resolveCodexJs: codexAbsent, fetchImpl: answers() },
        envWithKey(script),
      );
      assert.equal(rows.anthropic.ok, true);
      assert.equal(rows.minimax.ok, true);
      assert.equal(rows.openai.ok, false);
      assert.match(rows.openai.why, /no codex\.js could be resolved/);
    } finally { rm(dir); }
  });

  test('⛔ a Codex binary that resolves and does NOT answer the handshake is unavailable, not available', async () => {
    const dir = tmp('probe-handshake');
    try {
      const rows = await availability(
        { claudeCli: claudeCli(), resolveCodexJs: codexResolves(dir), codexConnect: async () => ({ ok: false, detail: 'the app-server exited during the handshake', conn: null }), fetchImpl: answers() },
        envWithKey(),
      );
      assert.equal(rows.openai.ok, false, 'a binary that resolved was read as a provider that answers');
      assert.match(rows.openai.why, /did not complete the initialize handshake/);
    } finally { rm(dir); }
  });

  test('all three absent: three unavailable rows, each with its own reason, and no route', async () => {
    const rows = await availability({ claudeCli: claudeCli(), resolveCodexJs: codexAbsent, fetchImpl: answers() }, { PATH: '' });
    assert.deepEqual(Object.values(rows).map((r) => r.ok), [false, false, false]);
    assert.equal(new Set(Object.values(rows).map((r) => r.why)).size, 3, 'three unreachable families were given one shared reason');
  });

  test('the Claude probe resolves a real file and spawns nothing', async () => {
    const dir = tmp('probe-claude');
    try {
      const script = fakeClaudeScript(dir);
      assert.equal(fs.existsSync(script), true);
      const present = turnClaude.probe({ cli: claudeCli(), env: { RESPAWNPACK_CLAUDE_PATH: script, PATH: '' } });
      assert.equal(present.ok, true);
      const absent = turnClaude.probe({ cli: claudeCli(), env: { RESPAWNPACK_CLAUDE_PATH: path.join(dir, 'not-there.js'), PATH: '' } });
      assert.equal(absent.ok, false);
      assert.match(absent.why, /does not exist/);
    } finally { rm(dir); }
  });
});

// =====================================================================================================
describe('the command line', () => {
  test('parseArgs reads every documented flag, and reports one it does not know', () => {
    const a = offload.parseArgs(['--dir', 'd', '--class', 'review', '--in', 'i', '--out', 'o', '--family', 'minimax', '--model', 'm', '--dry-run']);
    assert.deepEqual(a, { dir: 'd', taskClass: 'review', in: 'i', out: 'o', family: 'minimax', model: 'm', dryRun: true, help: false, unknown: [] });
    assert.deepEqual(offload.parseArgs(['--wat']).unknown, ['--wat']);
  });

  test('the help text names every flag the parser accepts, and the class vocabulary', () => {
    const help = offload.helpText();
    for (const flag of ['--dir', '--class', '--in', '--out', '--family', '--model', '--dry-run']) {
      assert.ok(help.includes(flag), `the help text does not mention ${flag}`);
    }
    for (const c of routing.TASK_CLASSES) assert.ok(help.includes(c), `the help text does not name the task class ${c}`);
  });

  test('a missing required flag is exit 2 and prints the help, never a stack trace', async () => {
    const out = [];
    const err = [];
    const log = console.log;
    const errFn = console.error;
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => err.push(a.join(' '));
    try {
      const code = await offload.main(['--dir', 'x']);
      assert.equal(code, 2, 'a missing flag was reported as a failure of the work rather than as could-not-determine');
      assert.match(out.join('\n'), /node adapters\/providers\/offload\.js --dir <project>/, 'the usage was not printed');
      assert.match(err.join('\n'), /--dir, --class and --in are all required/);
    } finally { console.log = log; console.error = errFn; }
  });

  test('an unknown task class is CANNOT_DETERMINE, and names the vocabulary', async () => {
    const dir = target('ops-infra');
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const r = await offload.runOffload({ dir, taskClass: 'pentesting', inFile, env: envWithKey(), deps: deps() });
      assert.equal(r.exitCode, 2);
      assert.match(r.summary, /unknown task class/);
      assert.match(r.summary, /security-testing/);
    } finally { rm(dir); }
  });

  test('an absent or empty input file is CANNOT_DETERMINE with the reason, not a turn on nothing', async () => {
    const dir = target('ops-infra');
    try {
      const missing = await offload.runOffload({ dir, taskClass: 'writing', inFile: path.join(dir, 'nope.md'), env: envWithKey(), deps: deps() });
      assert.equal(missing.exitCode, 2);
      assert.match(missing.summary, /ABSENT/);
      const empty = await offload.runOffload({ dir, taskClass: 'writing', inFile: unit(dir, 'empty.md', '   \n'), env: envWithKey(), deps: deps() });
      assert.equal(empty.exitCode, 2);
      assert.match(empty.summary, /is empty/);
    } finally { rm(dir); }
  });

  test('a project directory that does not exist is CANNOT_DETERMINE, never a crash', async () => {
    const r = await offload.runOffload({ dir: path.join(os.tmpdir(), 'rp-offload-no-such-dir-zzz'), taskClass: 'writing', inFile: 'x' });
    assert.equal(r.exitCode, 2);
    assert.match(r.summary, /does not exist/);
  });

  test('without --out the answer goes to stdout and the receipt records no output path', async () => {
    const dir = target('ops-infra');
    const out = [];
    const log = console.log;
    console.log = (...a) => out.push(a.join(' '));
    try {
      const inFile = unit(dir, 'unit.md', '# The material\n');
      const code = await offload.main(['--dir', dir, '--class', 'writing', '--in', inFile], { deps: deps(), env: envWithKey() });
      assert.equal(code, 0);
      assert.ok(out.join('\n').includes('The OpenAI-compatible provider answered.'));
      const receipt = JSON.parse(read(walk(path.join(dir, '.respawnpack', 'runtime'))[0]));
      assert.equal(receipt.output.path, null);
      assert.ok(receipt.output.digest, 'an answer that went to stdout was recorded with no digest');
    } finally { console.log = log; rm(dir); }
  });
});

// =====================================================================================================
describe('the registered family agrees with the writer', () => {
  test('the receipt path, the writer and the schema version all match schemas/registry.json', () => {
    const registry = JSON.parse(read(path.join(ROOT, 'schemas', 'registry.json')));
    const family = registry.families.find((f) => f.family === 'offload-receipt');
    assert.ok(family, 'the offload receipt is not a registered family');
    assert.equal(family.writer, 'adapters/providers/offload.js');
    assert.equal(family.durability, 'runtime');
    assert.equal(family.path, '.respawnpack/runtime/offload-<id>.json');
    assert.equal(RECEIPT_SCHEMA.properties.schemaVersion.const, offload.OFFLOAD_RECEIPT_SCHEMA_VERSION);
    // The path the writer actually builds, checked against the pattern the registry publishes.
    const built = offload.receiptPathFor('/project', 'writing-abc123').split(path.sep).join('/');
    assert.equal(built, '/project/.respawnpack/runtime/offload-writing-abc123.json');
  });

  test('every family this pack can route to has a turn module, and every turn module has a family', () => {
    const packFamilies = PACK_REGISTER.families.map((f) => f.id).sort();
    assert.deepEqual(Object.keys(offload.PROVIDERS).sort(), packFamilies,
      'the register declares a family the offload has no provider for, or the reverse');
  });

  test('⛔ this directory is pack-side only and is never installed into a target', () => {
    /*
     * The offload is pointed AT a target from a pack checkout, the way the task runner and the Codex
     * app-server already are. Installing it would put a tool that reaches model providers, and reads an
     * environment variable holding a credential, inside every project this pack touches. Checked
     * against the installer's own declared inventory rather than asserted in prose.
     */
    const sources = read(path.join(ROOT, 'install', '_sources.js'));
    assert.ok(!sources.includes('adapters/providers'),
      'install/_sources.js now names adapters/providers, so the offload would be copied into every target');
  });
});
