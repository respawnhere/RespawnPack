# RespawnPack · the OpenAI-compatible provider client

One generic HTTP client for **any** provider that speaks the OpenAI chat-completions protocol, plus a
cheap probe that checks a declared provider without spending anything. It is configured by name, base
URL, the **name** of an environment variable, and a model list. It is never configured by a key value.

This is the third provider surface in the pack, and the only one that holds a credential at all:

| provider | how the pack reaches it | how it authenticates |
| --- | --- | --- |
| Claude Code | `adapters/claude-code/sdk-supervisor/cli.js` (a headless CLI turn) | the operator's own sign-in |
| Codex | `adapters/codex/app-server/` (JSON-RPC over stdio) | the operator's own sign-in |
| any OpenAI-compatible host | this directory (HTTPS, injectable `fetch`) | an API key read from the environment at call time |

MiniMax is the first provider that speaks this protocol here. Nothing in `client.js` is MiniMax-shaped:
the base URL, the model ids and the variable name all live in the project's own configuration, and in
the worked example below.

## The configuration block

A project declares its providers in `respawnpack.config.json`, under `providers`, keyed by whatever it
calls each one. `schemas/project-config.schema.json` is the normative declaration and
`kernel/schema.test.mjs` fences it.

```json
{
  "providers": {
    "minimax": {
      "protocol": "openai-compatible",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "models": ["MiniMax-M3", "MiniMax-M2.7"],
      "note": "the international platform; the owner exports the variable in the shell that runs the pack"
    }
  }
}
```

Every value in that example is a published fact or a variable name, and every one of them is cited:

| field | where the value comes from |
| --- | --- |
| `baseUrl` | MiniMax's own OpenAI-compatible base URL, `https://api.minimax.io/v1`, so the chat endpoint is `POST https://api.minimax.io/v1/chat/completions` (platform.minimax.io/docs/api-reference/text-openai-api and .../docs/guides/text-generation, accessed 2026-09-03) |
| `apiKeyEnv` | a NAME this pack chose, matching the owner's direction in the owner's brief for the second run, item 6 |
| `models` | model name strings the vendor accepts on that interface: `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`, `MiniMax-M2.1`, `MiniMax-M2.1-highspeed`, `MiniMax-M2` (same pages, accessed 2026-09-03) |

The full research record, with the access date on every URL, is
`spine/reference/models/capability-evidence.md` section 3, which ships with the pack beside the
register and is not installed into a project.

The China-mainland platform serves the same protocol at a different host and issues region-bound keys,
so a project reaching it declares a second provider block with its own base URL and its own variable
name. That is exactly what the generic shape is for.

## The key, and where it lives

The key is the owner's. The pack never handles it, never asks for it, and never writes it.

```
# in the shell that runs the pack, and nowhere this repository tracks
export MINIMAX_API_KEY=...
```

Everything else follows from that one rule:

- The **config carries the variable's NAME**, so a project can be read, reviewed and committed with no
  credential anywhere in it. The schema refuses a property called `apiKey`, `api_key`, `key`, `token`
  or `secret` inside a provider block, by name, so the mistake fails in the editor rather than in the
  repository's history.
- The **value is read at call time**, from `env[apiKeyEnv]`, into a local. It is never assigned to a
  property of the client, never captured in a closure that outlives the call, and never logged. A
  client built while the variable was set answers `NO_KEY` once the variable goes away, which is only
  possible because nothing kept a copy.
- It travels in exactly **one place**: the `Authorization: Bearer` header of the request. `raw` carries
  the request body and the response body and no headers at all.
- Anything the client returns or throws is passed through a **redaction pass** first, so a value that
  came back from the outside (a proxy that echoes the request headers into an error body is a real
  thing) is replaced with a marker naming the variable rather than carried into a report.

`describe()` answers `keyPresent: true | false` and nothing more. That is the only question about the
key anything downstream of this directory ever needs to ask.

This is anti-drift item 52, and `client.test.mjs` proves it mechanically: every test injects an
environment carrying a distinctive sentinel value, and the fence serialises every result, every thrown
error and every probe report and asserts the sentinel appears in none of them, while asserting that the
request the fake `fetch` received carried it in the `Authorization` header and nowhere else.

## The client

```js
const { createClient } = require('./adapters/openai-compatible/client.js');

const provider = createClient({
  name: 'minimax',
  baseUrl: 'https://api.minimax.io/v1',
  apiKeyEnv: 'MINIMAX_API_KEY',
  models: ['MiniMax-M3'],
  // fetch and env default to the real ones; every test injects its own
});

const turn = await provider.runTurn({ model: 'MiniMax-M3', prompt: 'one sentence, please', maxTokens: 64 });
```

`runTurn` POSTs `<baseUrl>/chat/completions` with `{model, messages, max_tokens?, temperature?, stream:
false}` and answers one of two shapes:

```
{ok: true,  text, usage: {input, output}, model, raw, durationMs}
{ok: false, kind, detail, status, raw, durationMs}
```

`kind` is one of:

| kind | when |
| --- | --- |
| `NO_KEY` | the variable the config names is unset or empty. The detail names the VARIABLE. No request is made. |
| `AUTH` | HTTP 401 or 403 |
| `QUOTA` | HTTP 402 or 429, or a 2xx carrying a documented envelope code that means quota or balance |
| `HTTP_<status>` | any other non-2xx, with the status in the name |
| `TIMEOUT` | the deadline passed and the request was aborted |
| `NETWORK` | `fetch` threw before an answer arrived |
| `MALFORMED` | a 2xx body that is not a chat completion, or one carrying an envelope code with no known meaning |
| `EMPTY` | a 2xx in the documented shape carrying no assistant text |

Two of those deserve their own paragraph.

**`TIMEOUT` is a typed non-answer, never a result.** `runTurn` resolves rather than rejecting, exactly
as `adapters/codex/app-server/rpc.js` does, so no caller can `await` its way into treating an elapsed
clock as a reply. The detail says so in words: an observation of a clock is not evidence that the
request failed and not evidence that it succeeded. This is anti-drift item 38, and
`core/lifecycle/evidence.js` would refuse the word by name if anything tried to promote it into a
completion record.

**A 200 is checked on two surfaces, not one.** A host in this protocol family can answer HTTP 200 and
still carry a refusal in a `base_resp` envelope, where `status_code` 0 means success. The client reads
both. Three envelope codes have a documented meaning the client acts on, and it names the number in
every case:

| code | documented meaning | how the client reports it |
| --- | --- | --- |
| 1002 | rate limit | `QUOTA` |
| 1008 | insufficient balance | `QUOTA` |
| 2056 | usage quota exceeded | `QUOTA` |
| anything else non-zero | unknown to this client | `MALFORMED`, naming the number |

Source: platform.minimax.io/docs/api-reference/errorcode and .../api-reference/text-post, accessed
2026-09-03, recorded in the evidence file named above. An unrecognised code is never guessed into a
success: a body this client cannot read is not read as an answer.

## The probe

```
node adapters/openai-compatible/probe.js --dir <project> --provider minimax [--json]
```

It asks three cheap questions and requests no completion, so a run costs one small GET:

1. Is the environment variable the block names set in this process?
2. Does `GET <baseUrl>/models` answer 2xx?
3. Is every model id the block declares in the list that endpoint returned?

Exit codes are the pack's own: `0` PASS, `1` FAIL, `2` CANNOT_DETERMINE.

**Only one thing here can be a FAIL**, and that is deliberate (anti-drift item 2). A configured model
the host's own list does not contain is a determined disagreement between the declaration and the
provider, so it fails and the row names the model. Everything else that stops the probe short is
CANNOT_DETERMINE with the reason: an unset variable, an unreachable host, a non-2xx answer (including a
401, because a credential this process could not use here and now says nothing settled about the
declaration), a body in a shape this client cannot parse, a directory that is not there, a config that
will not parse, no `providers` map, a provider nobody declared, or a block for a protocol this adapter
does not speak. "Could not run" never collapses into "failed".

## What the client refuses

At construction, before anything can reach a host:

- a `baseUrl` that is not `https`, because a credential travels on that connection;
- an `apiKeyEnv` that is not an environment variable NAME, which is also the shape an accidentally
  pasted value would have;
- an empty `models` list, because a provider with no models is one nothing can route to;
- a `protocol` other than `openai-compatible`, because a protocol with no adapter is a provider
  nothing can reach;
- no `fetch` at all, rather than silently reaching for a global one that may or may not exist.

At the schema level, in a project's own configuration, a provider block refuses any property named
`apiKey`, `api_key`, `key`, `token` or `secret`, and refuses unknown properties outright.

## What this does not prove

- **No live call has been made.** Every test in `client.test.mjs` injects its own `fetch` and its own
  environment; the base URL in the fixtures is `api.example.invalid`, which cannot resolve. Unplug the
  network and the suite is unchanged. Nothing in the pack's suites runs `probe.js` against a real host.
- **Nothing here has spoken to MiniMax.** The base URL, the model ids and the error codes are read from
  vendor documentation, dated and cited; they have not been exercised. A bounded live probe that
  actually spends tokens on a model is the **owner's** action, per the owner's brief for the second run, item 7, and it is
  the one thing that would turn these citations into observations.
- **The vendor-code table is a documented default, not a discovery mechanism.** A provider in this
  family that uses different codes gets `MALFORMED` naming the number, which is honest and is not the
  same as understanding it.
- **This adapter routes nothing.** Choosing which provider and which model a unit of work goes to is
  `core/policy/routing.js`; carrying a bounded unit of work to a provider and writing a receipt for it
  is `adapters/providers/offload.js`. This directory is the transport and its canary, and nothing here
  declares a capability SUPPORTED.
- **Nothing is installed to a target by this adapter.** It runs from the pack checkout, like the task
  runner does; `install/_sources.js` does not place it, and `schemas/` never ships.
