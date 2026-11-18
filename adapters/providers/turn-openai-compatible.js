/*
 * RespawnPack · adapters/providers/turn-openai-compatible.js — one bounded turn on any provider that
 * speaks the OpenAI chat-completions protocol, through the generic client task M-3 landed.
 *
 * Spec: the class audit Class G, "Providers" ("MiniMax and any future OpenAI-compatible provider
 * through `adapters/openai-compatible/client.js` with an injectable `fetch`").
 *
 * ⛔ THIS FILE ADDS NO SECOND WAY TO REACH A PROVIDER. It is a thin shape adapter: the project's own
 * `providers` block goes in, the client's `{ok,text,usage,kind}` comes back in the shape the other two
 * turn modules answer with. Every byte that touches the network, every failure classification and the
 * whole of the credential handling stay in `adapters/openai-compatible/client.js`, which is where
 * anti-drift item 52 is enforced mechanically. A second implementation here would be a second place for
 * that to be got wrong.
 *
 * ⛔ ANTI-DRIFT ITEM 52, RESTATED AS WHAT THIS FILE DOES NOT DO. It never reads `env[apiKeyEnv]`, never
 * holds a key in a local, never puts one in a return value and never names one in an error. It passes
 * the `env` MAP down to the client, which reads the variable inside the call that needs it. The one
 * question this module ever asks about the credential is whether the variable is set, and it asks it
 * through the client's own `describe()`, which answers `keyPresent: boolean` and nothing else.
 *
 * ⛔ AND THE PROVIDER BLOCK CARRIES A NAME, NEVER A VALUE. `schemas/project-config.schema.json` refuses
 * the five property names a key would most naturally be written under, so a block that reached this
 * module with a pasted value in it would already have failed validation. Nothing here re-checks that,
 * and nothing here would accept one: `createClient` takes `apiKeyEnv`, an environment variable NAME
 * matching a SHOUTING_SNAKE pattern, and there is no parameter a value could arrive through.
 */

'use strict';

const path = require('path');

const clientLib = require(path.join(__dirname, '..', 'openai-compatible', 'client.js'));

/** This provider's own name on the receipt. */
const PROVIDER = 'openai-compatible';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Re-exported so a caller reports the client's own failure vocabulary rather than a second copy. */
const TURN_FAILURE = clientLib.TURN_FAILURE;

/**
 * Build the client for one declared provider block.
 *
 * @param {{name:string, block:object, env?:object, fetchImpl?:Function, timeoutMs?:number}} opts
 */
function clientFor({ name, block, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return clientLib.createClient({
    name,
    baseUrl: block.baseUrl,
    apiKeyEnv: block.apiKeyEnv,
    models: block.models,
    protocol: block.protocol,
    fetch: fetchImpl,
    env,
    timeoutMs,
  });
}

/**
 * Is this provider reachable from this process?
 *
 * Cheap by construction: it opens no socket. The question is the one the block names, "the env variable
 * is set", and it is answered through the client's `describe()` so the presence check has exactly one
 * implementation in the pack.
 *
 * ⛔ A DECLARATION THAT IS ABSENT AND A VARIABLE THAT IS UNSET ARE DIFFERENT ANSWERS, and both are
 * reported in words. A project that declares no provider block for this family has decided not to reach
 * it, which is the state every project is in until an owner decides otherwise; a project that declares
 * one whose variable is unset has decided to reach it and not exported the key.
 *
 * @param {{name?:string, block:object|null, env?:object, fetchImpl?:Function}} opts
 * @returns {{ok:boolean, why:string, detail:object|null}}
 */
function probe({ name = null, block = null, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!block) {
    return {
      ok: false,
      why: `this project's respawnpack.config.json declares no openai-compatible provider block for ${name ? `"${name}"` : 'this family'}, so there is nothing to reach. A project with no provider block is in a legitimate state.`,
      detail: null,
    };
  }
  let described;
  try {
    described = clientFor({ name: name || 'provider', block, env, fetchImpl }).describe();
  } catch (e) {
    return { ok: false, why: `the declared provider block is not one this client can honour: ${e && e.message}`, detail: null };
  }
  if (!described.keyPresent) {
    return {
      ok: false,
      // The VARIABLE is named. Its value is not read here, and is never printed anywhere by this pack.
      why: `the environment variable ${described.apiKeyEnv}, which this project's provider block names, is unset or empty in this process. Export it in the shell that runs the pack.`,
      detail: { apiKeyEnv: described.apiKeyEnv, keyPresent: false },
    };
  }
  return {
    ok: true,
    why: `${described.apiKeyEnv} is set in this process. Presence is all that is checked: whether the key works is settled by the turn.`,
    detail: { apiKeyEnv: described.apiKeyEnv, keyPresent: true },
  };
}

/**
 * One bounded completion turn.
 *
 * @param {{prompt:string, system?:string|null, model?:string|null, name?:string, block:object,
 *          env?:object, fetchImpl?:Function, timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, text, usage, model, kind:null, durationMs}
 *                 | {ok:false, text:null, usage, model, kind, detail, durationMs}>}
 */
async function runTurn({
  prompt,
  system = null,
  model = null,
  name = 'provider',
  block,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.length) {
    throw new Error('adapters/providers/turn-openai-compatible.js runTurn: `prompt` must be a non-empty string');
  }
  if (!block) throw new Error('adapters/providers/turn-openai-compatible.js runTurn: no provider block was supplied');

  const client = clientFor({ name, block, env, fetchImpl, timeoutMs });
  const r = await client.runTurn({ model: model || block.models[0], prompt, system, timeoutMs });

  if (!r.ok) {
    return {
      ok: false,
      text: null,
      usage: { input: null, output: null },
      model: model || block.models[0] || null,
      kind: r.kind,
      // `detail` is the client's own, already scrubbed of the credential by `scrub()` before it left it.
      detail: r.detail,
      durationMs: r.durationMs,
    };
  }
  return {
    ok: true,
    text: r.text,
    usage: r.usage && typeof r.usage === 'object' ? { input: r.usage.input, output: r.usage.output } : { input: null, output: null },
    model: r.model || model || null,
    kind: null,
    durationMs: r.durationMs,
  };
}

module.exports = { PROVIDER, TURN_FAILURE, DEFAULT_TIMEOUT_MS, clientFor, probe, runTurn };
