# RespawnPack · Codex adapter — the app-server MANAGED profile (W3b)

The automatic, in-place Codex rollover. A supervisor owns a `codex app-server` thread over JSON-RPC 2.0
(JSONL on stdio), issues the turns itself, and therefore can stop at a boundary of its own choosing,
request `thread/compact/start`, watch the SAME thread for the documented completion item, verify the
thread identity survived, and continue — exactly once, with a handoff that was written and read back
before the compaction. Every step runs through `core/`'s host-neutral lifecycle machine; nothing in this
directory re-decides what that machine decides.

This is the sibling of `adapters/codex/hooks/` (W3a), not a replacement for it. In a hooks-only install
the operator types `/compact` and the pack watches. Here the pack IS the client.

## The live proof

**This is the first RespawnPack host profile whose activation canary could actually run.** Codex was
installed and authenticated on the machine this was built on, so it did:

```
node adapters/codex/app-server/canary.js --rollovers 3 --context-window 18000
```

Result, 2026-08-06, `codex-cli 0.146.0`, Windows 11, model `gpt-5.6-sol`, `modelContextWindow` 258400:

| what ran | observed |
| --- | --- |
| thread | `019fd836-2d07-7330-b018-d9059a2d348c`, `approvalPolicy "never"`, `sandbox {type:"readOnly", networkAccess:false}` |
| rollovers | **3 consecutive, in place, on that one thread** |
| context cycles | `0 → 1 → 2 → 3`, one advance per rollover, a fresh nonce each time |
| compaction evidence | three `contextCompaction` `item/started` → `item/completed` pairs, matching uuidv7 item ids, all on that threadId |
| identity | expected == observed on every rollover, each re-checked against a `thread/resume` |
| exactly-once | three receipts; a second claim on each handoff answered `ALREADY_CONSUMED` with a pointer to the first |
| injection | the model echoed the per-cycle nonce carried only by the handoff, all three times |
| latches | re-armed at every cycle advance, with nothing latched in the new cycle |
| outcome | **PASS**, exit 0 |

The complete event log and the structured report are checked in, digest-fenced, at
`fixtures/captured/05-live-canary-events.jsonl` and `fixtures/captured/06-live-canary-report.json`.
`supervisor.test.mjs` re-reads them and asserts the table above against the bytes, so this section cannot
drift away from what actually happened.

**What that run did NOT prove, stated plainly — two things.**

*The denominator was configured, not measured.* Thresholds ran against an OPERATOR-CONFIGURED 18000
tokens, not the model's real 258400-token window: filling a real window three times costs hours and
money, and the protocol is what was under test. Every measurement record from that run carries
`windowHostReported:false`, the report repeats the caveat in its own text, and `--context-window 0`
measures against the host's published window instead.

*Occupancy did not FALL across any of the three compactions.* The measured input was
**15625 → 15884 → 16107** tokens — rising, not shrinking. That is not a defect in the reading and not a
failed compaction: the thread's baseline (system prompt, instructions, tool definitions) is ~15.6k of
the 258400-token window, and a canary that opens a thread and immediately rolls it over has almost no
conversation for the summariser to compress. So this run proves the **rollover protocol** — request,
item, identity, exactly-once, cycle advance, re-armed latches — and it does **not** show that
compaction reduces occupancy on a genuinely full thread. Nothing in this adapter claims otherwise, and
`supervisor.test.mjs` asserts the rising numbers off the evidence so the claim cannot quietly soften.

## The spawn recipe

```js
spawn(process.execPath, [codexJs, 'app-server'], { cwd, env, stdio: ['pipe','pipe','pipe'], windowsHide: true })
```

`codexJs` is RESOLVED, never hardcoded and never the npm shim itself — the shim is a `.cmd`/`.ps1`
wrapper on Windows and putting a shell in the middle of a JSONL pipe adds one more thing that can mangle
a line. `rpc.resolveCodexJs()` tries, in order, and RECORDS every step including the misses:

1. `RESPAWNPACK_CODEX_JS` (absolute path to `codex.js`),
2. `where` / `which codex` → if the hit is already a `.js`, use it,
3. → otherwise `<dir of the shim>/node_modules/@openai/codex/bin/codex.js` (the npm layout),
4. → otherwise the first `…codex.js` path parsed out of the shim's own text.

On the machine this was built on, step 3 wins:
`C:\home\user\.npm\node_modules\@openai\codex\bin\codex.js`.

Then, **before anything else**, `initialize` — it is mandatory:

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"clientInfo":{"name":"…","version":"…"},"capabilities":{"experimentalApi":true}}}
```

A request sent before it answers `-32600 "Not initialized"` **and the process then exits with code 0**.
A transport that read a clean exit as anything but a failure would report a healthy shutdown for a
handshake it never completed.

## Protocol facts this adapter is built on

All captured live; the bytes are in `fixtures/captured/` and the MANIFEST says which file shows what.

- **The compaction ack is not the completion.** `thread/compact/start` answers `{}` immediately. The
  compaction then runs as its OWN TURN (new turnId, same threadId) and the only completion evidence is
  the `contextCompaction` item reaching `item/completed`. That item never carries more than `{id,type}`
  — there is no pre/post token metadata to corroborate it with. The deprecated `thread/compacted`
  notification does not fire on this build.
- **An ack plus a `turn/completed` with no item is COMPLETION_UNOBSERVED, flagged as a no-op candidate,
  and resolved as neither.** A genuine no-op compaction has never been observed on this host, so "the
  host declined" and "the item was not emitted" cannot be told apart from here. Inventing the
  distinction is exactly the guess this pack refuses. (A ~15.7k/258.4k thread compacted FOR REAL in
  ~1.8s, so the no-op branch is not a hypothetical worth optimising for either.)
- **Occupancy is CANNOT_DETERMINE for one turn after a compaction.**
  `thread/tokenUsage/updated` carries `total` (cumulative) and `last` (the most recent request). On the
  compaction turn, `total` is UNCHANGED while `last` reports `totalTokens: 4511` with all five component
  counters at **0**. Nothing may be derived from that row; it is not a context that emptied. The
  numerator is `last.inputTokens` (`cachedInputTokens` is a SUBSET of it, not an addition) and the
  denominator is `modelContextWindow`, which this host PUBLISHES — the thing the Claude profile has to
  assume. When it is `null` there is no denominator and occupancy is CANNOT_DETERMINE, never a guess.
- **`approvalPolicy` is NOT persisted across an app-server restart. `sandbox` IS.** A `thread/resume`
  that did not re-pass it came back `"approvalPolicy":"on-request"` on a thread started `"never"`, while
  the sandbox stayed `readOnly`. So **every** `thread/resume` in this adapter re-passes the whole policy
  set, and the identity check reads the policy back off the response as proof the re-pass took.
- **Live item ids are uuidv7; a resumed thread renumbers its items `item-1`, `item-2`, …** Nothing may
  be correlated across a cold resume by item id, so an id of that shape is recognised and refused as an
  event id (the turn id is used instead). Two compactions colliding on one event key would make the
  second a silent no-op on the machine's duplicate index.
- **The `turn/interrupt` race.** `turn/start` answers immediately with an `inProgress` stub; the turn is
  not interruptible until the `turn/started` NOTIFICATION fires. An interrupt sent in that window
  answers `-32600 "no active turn to interrupt"`; sent after it, the turn settles cleanly as
  `"interrupted"`. This adapter therefore waits for the notification and REFUSES to send into the race
  rather than retrying into an error it could not tell apart from "the turn is already over".
- **Unsolicited traffic must be tolerated, not interpreted.** `mcpServer/startupStatus/updated`,
  `account/rateLimits/updated`, `remoteControl/status/changed`, `thread/status/changed`,
  `thread/goal/cleared`, and methods this build has not grown yet. `thread/started` fires LAZILY on the
  first turn, never on `thread/start` — waiting for it there would hang forever.

## The server→client direction, and why every approval halts

`ServerRequest.json` declares **eleven** request methods the server sends to the client, five of them
approvals. With sandbox read-only and `approvalPolicy "never"` none were observed in any live run — and
"not observed" is not "cannot happen". An unanswered request hangs the turn forever, and a reflexive
`{}` reply is a shape the server is free to read as consent. So `rpc.js` ships a typed default-deny
table built from the host's own schema:

| request | answer |
| --- | --- |
| `execCommandApproval`, `applyPatchApproval`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | `{"decision":{"denied":{"rejection":"…"}}}` — the declared `ReviewDecision` denial |
| `mcpServer/elicitation/request` | `{"action":"decline"}` |
| `item/tool/call` | `{"success":false, …}` |
| `item/permissions/requestApproval`, `item/tool/requestUserInput`, `account/chatgptAuthTokens/refresh`, `attestation/generate` | a JSON-RPC **error**: these have no declared denial shape (a permissions response is a GRANT), and refusing at the protocol level is the only answer that cannot be misread as approval |
| anything undeclared | a JSON-RPC error, same reasoning |
| `currentTime/read` | answered normally — it reads OUR clock and grants nothing |

Every one of them except the clock read **halts the rollover** and records the request verbatim. An
approval prompt in the middle of an automatic compaction means the turn is doing something the managed
profile did not plan for; the supervisor stops rather than negotiating with it.

## ⛔ Two Codex surfaces, two vocabularies. Do not unify them.

`codex exec --json` and `codex app-server` describe the same events in **different spellings**, and both
are captured:

| | `codex exec --json` | `codex app-server` |
| --- | --- | --- |
| event names | **dot-case**: `thread.started`, `turn.started`, `item.completed`, `turn.completed` | **slash-case**: `thread/started`, `turn/started`, `item/completed`, `turn/completed` |
| usage fields | **snake_case**: `input_tokens`, `cached_input_tokens`, `reasoning_output_tokens` | **camelCase**: `inputTokens`, `cachedInputTokens`, `reasoningOutputTokens` |
| item ids | `item_0` | uuidv7 live, `item-N` after a cold resume |
| window size | not reported | `modelContextWindow` |
| compaction | no request method | `thread/compact/start` + the `contextCompaction` item |

A normaliser that mapped one onto the other would be inventing an equivalence neither surface states, and
would silently paper over the day one of them changes. This adapter speaks **only** the app-server
vocabulary; anything reading `codex exec` output must speak its own.

## The EXPERIMENTAL surface, and what this adapter does about it

`initialize` must pass `capabilities.experimentalApi: true`, and the request inventory is a moving
target. Rather than pin a copy that goes stale, `probe()` regenerates the host's own schema on every
supervisor start:

```
node <codexJs> app-server generate-json-schema --experimental --out <projectDir>/.respawnpack/runtime/rollover/_codex-app-server-schema
```

…loads `ClientRequest.json` from it (127 methods on 0.146.0), and validates every outbound request
against it: an undeclared method is REFUSED before it reaches the wire, a missing required param is
refused, an extra param is reported as drift and sent anyway. If `thread/compact/start`, `turn/start`,
`thread/start`, `thread/resume` or `turn/interrupt` ever stops being declared, `probe()` returns FAIL
naming the method — a typed finding instead of a mystery hang.

## Interplay with the hooks profile (`adapters/codex/hooks/`)

Both profiles write to the SAME on-disk rollover state: `core.machine.conversationDir(projectDir,
'codex', conversationId)` is keyed by host and conversation id, not by which profile is writing. Two
consequences, both tested:

- `stageHandoff()` here also writes `latest-handoff.json`, the per-conversation pointer
  `adapters/codex/hooks/_shared.js` reads. Handoff ids are random, so without it a SessionStart hook
  firing into this runtime directory would have no way to discover which document to consume.
- `respawnpack-sessionstart.js`'s banner claims its Layer-2 machine attempt "starts succeeding for free"
  once an app-server-driven profile drives the same journal through `checkpoint → request-compact`.
  `supervisor.test.mjs` proves it: it walks THIS supervisor to `COMPACTING`, spawns that hook as a real
  child process with a synthetic `SessionStart(compact)` payload, and asserts the hook reports
  `verified in-place rollover, cycle 0 -> 1` and that the shared journal really moved. The control is
  beside it — the same hook against a hooks-only machine still reports the honest
  `ILLEGAL_TRANSITION` refusal, because a check that answers the same way in both situations is checking
  nothing.

## Files

```
adapters/codex/app-server/
  rpc.js                  JSONL framing, dispatch, executable resolution, schema load/validate,
                          the default-deny server→client responder, the mandatory handshake
  supervisor.js           the rollover loop over core's machine: probe · measureContext · settleOrStop ·
                          requestCompact · observeCompact · verifyIdentity · injectHandoff · resume
  capabilities.js         the profile's declarations, generated from a canary and never from the target
  canary.js               THE LIVE PROOF — N consecutive in-place rollovers, or a typed reason why not
  rpc.test.mjs            29 tests: framing across chunk boundaries, torn tails, typed non-answers,
                          the responder table, resolution, the outbound validator, the raw log
  supervisor.test.mjs     the rollover over a fake transport replaying captured bytes, the recorded
                          live evidence, the capability rules, and the hooks-profile interop proof
  fixtures/
    MANIFEST.json         which fixture is CAPTURED and which is SYNTHETIC, with digests
    fake-app-server.js    a scripted stand-in, used only by rpc.test.mjs — never cited as the host
    captured/             what `codex app-server` actually said, including the live canary's own log
    synthetic/            what this adapter must answer correctly whether or not the host produces it
```

## Running the canary

```
node adapters/codex/app-server/canary.js --probe-only                 # resolve + version + schema + handshake, 0 model turns
node adapters/codex/app-server/canary.js                              # 3 rollovers, ~7 cheap model turns
node adapters/codex/app-server/canary.js --context-window 0 --pad-budget 40   # measure against the REAL window
```

Exit `0` PASS · `1` FAIL · `2` CANNOT_DETERMINE. It runs read-only, with `approvalPolicy "never"`, in a
fresh temp directory, and it never retries past a HALT: a mid-way failure's typed outcome and raw log
ARE the deliverable.

## Owner actions and known limits

1. **Review the checked-in evidence before publishing.** `fixtures/captured/05-…` and `06-…` are
   verbatim and unredacted — a redacted evidence log is not evidence — so they carry this machine's temp
   paths, the host's `codexHome`, the `userAgent`, and the `account/rateLimits/updated` rows the host
   emitted unsolicited (plan type and window usage). That is an owner call, not a code change.
2. **The window claim is unmeasured at the real denominator.** Re-run with `--context-window 0` and a
   larger `--pad-budget` if a "the final threshold fires at 85% of 258400" claim is wanted; it costs
   real tokens.
3. **No installer integration.** Nothing places these files into a target yet; that is the installer
   wave's job, as it is for `adapters/codex/hooks/`.
4. **`turn/interrupt` is implemented and unused by `rollover()`.** The supervisor holds the only handle
   and waits for its own turn to complete, so the interrupt path exists for callers that need it and is
   proved by tests rather than by the canary.
5. **One host, one build.** Everything above was observed on `codex-cli 0.146.0` / Windows 11 /
   `gpt-5.6-sol`. The app server is EXPERIMENTAL; `probe()`'s schema regeneration is what turns a
   version change into a typed finding rather than a surprise.
