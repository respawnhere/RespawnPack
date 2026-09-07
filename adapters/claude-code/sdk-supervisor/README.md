# claude-code / sdk-supervisor — the MANAGED profile

An automatic **in-place rollover**: a supervisor that owns a Claude Code conversation, measures how full
it is, stops at a boundary, writes and verifies a handoff, asks the *same* conversation to `/compact`,
watches for the documented completion, checks the conversation identity did not change, delivers the
handoff exactly once, and continues.

Every step runs through the host-neutral machine in `core/` — this directory contains no lifecycle
rules of its own. It contains a protocol reader, a process surface, a measurement, and the wiring
between them.

```
stream.js        the stream-json reader and THE COMPACTION EVIDENCE CONTRACT
cli.js           executable resolution, exact argv, one headless turn, captured verbatim
measure.js       occupancy: a published numerator over a denominator that often is not
supervisor.js    the rollover loop over core/lifecycle/machine.js
capabilities.js  what this profile may claim, gated on the canary that actually ran
canary.js        the live proof: three consecutive rollovers, or a typed reason why not
fixtures/        captured live streams + clearly-labelled synthetic ones (see MANIFEST.json)
```

---

## The one thing to know before reading the code

**A failed compaction returns a success result.** From the real bytes in
`fixtures/captured/04-compact-attempt1.jsonl` — a `/compact` that did not happen:

```jsonc
{"type":"system","subtype":"status","status":"compacting", …}
{"type":"system","subtype":"status","status":null,"compact_result":"failed",
 "compact_error":"Error during compaction: Failed to authenticate: …"}
…
{"is_error":false, …, "subtype":"success", "num_turns":0, "type":"result"}
```

`is_error:false`. `subtype:"success"`. A supervisor that keyed completion on the result envelope — the
obvious field to key it on — would record a compaction that never occurred, advance its context cycle,
consume its handoff, and continue into a session whose context was never reduced.

So the verdict is keyed on the control-flow messages and **never** on `result.subtype` / `is_error`:

| verdict | what was observed | what happens |
|---|---|---|
| `COMPLETED` | a `compact_boundary` system message | `observe-completion` → `verify-identity`; the cycle advances once |
| `FAILED` | `compact_result:"failed"` (+ `compact_error`) | halt `COMPACT_REQUEST_REFUSED` (FAIL); the handoff stays unconsumed |
| `NOOP` | no boundary, and the host's own *"Not enough messages to compact."* | `noop-return`; **no** cycle advance, latches survive, handoff untouched |
| `CONTRADICTORY` | a boundary **and** a failure | halt `COMPLETION_UNOBSERVED` (CANNOT_DETERMINE) |
| `UNOBSERVED` | none of the above; a closed pipe, a killed turn, silence | halt `COMPLETION_UNOBSERVED` (CANNOT_DETERMINE) |

A timeout, a process exit and an elapsed delay are observations of a clock. They are never converted
into a completion — `core/lifecycle/evidence.js` refuses them by name if this adapter ever tries.

---

## Which surface, and why

The documented control surfaces are the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) and the
**Claude Code CLI** headless stream-json mode that the SDK itself drives. This adapter uses the CLI:

1. **The pack has no dependencies and installs by copying files.** There is no root `package.json` by
   design. A supervisor that required the npm SDK would need a `node_modules` tree on every target.
2. **The SDK drives this exact protocol.** Its transport is
   `claude --print --output-format stream-json --verbose` over a pipe. The fixtures in
   `fixtures/captured/` were recorded *through* the SDK and are byte-for-byte the CLI's own stream.
   There is no second protocol here.
3. **The SDK ships its own binary, and in this environment it is a different credential context.**
   Measured: the SDK spawned its bundled `claude` 2.1.223 (*"OAuth session expired and could not be
   refreshed"*) while the PATH `claude` is 2.1.205 — the binary the operator authenticated. Depending on
   the SDK means depending on whichever binary it bundles this week.
4. **`pathToClaudeCodeExecutable` has an exact equivalent**: the `claudePath` option, or the
   `RESPAWNPACK_CLAUDE_PATH` environment variable.

Two consequences worth stating:

- **The prompt travels on stdin, not in argv.** A rollover prompt carries an injected handoff, and a
  Windows command line dies at ~32767 characters — silently truncating the one message whose entire job
  is to be complete.
- **`--verbose` is not decoration.** Without it the stream-json output is summarised, and the
  control-flow messages this supervisor depends on are what get summarised away.

---

## Exact invocation

```js
const { createSupervisor } = require('./adapters/claude-code/sdk-supervisor/supervisor.js');

const sup = createSupervisor({
  projectDir: '/path/to/project',   // REQUIRED — rollover state lives under .respawnpack/runtime/rollover/
  cwd: '/path/to/project',          // working directory for the claude process (defaults to projectDir)
  model: 'sonnet',                  // optional
  tools: '',                        // optional: "" disables all tools for supervised turns
  contextBudgetTokens: null,        // optional: overrides the assumed window
  claudePath: null,                 // optional: else RESPAWNPACK_CLAUDE_PATH, else PATH
});

await sup.turn({ prompt: 'start the work' });        // the session id is OBSERVED, never dictated
// …work…
if (sup.thresholdState().evaluation.fire.includes('final')) {
  await sup.rollover({
    handoffFields: { atomicActionId: 'T-14', exactNextAction: 'finish the migration script' },
    nextPrompt: 'continue',
  });
}
```

The turns it spawns are, verbatim:

```
claude --print --output-format stream-json --verbose [--resume <session_id>] \
       [--model <m>] [--tools <t>] [--allowedTools a,b] [--permission-mode <p>]      # prompt on stdin
```

`projectDir` is required and never defaults: a supervisor that fell back to `process.cwd()` would write
rollover state into whatever repository happened to be current.

### The canary

```
node adapters/claude-code/sdk-supervisor/canary.js [--rollovers 3] [--context-budget 24000]
                                                   [--turn-budget 15] [--project-dir <path>]
                                                   [--model <m>] [--json <file>] [--probe-only]
```

Exit codes are core's: **0** PASS · **1** FAIL · **2** CANNOT_DETERMINE.

By default the thresholds are measured against a small operator-configured budget, because filling a
real 1M window three times costs hours and money and is not what is under test — the protocol is. The
report says so on the claim itself. `--context-budget 0` measures against the host's published window
(or the 1000000 default) instead.

---

## Prerequisites

- `claude` on PATH (or `RESPAWNPACK_CLAUDE_PATH`). Verified against **2.1.205** on Windows 11.
- **An authenticated context.** The supervisor never handles credentials. Run `claude` interactively
  once and complete `/login`; then run the canary from that context.
- Node 18+ (`node:test` for the suites). No npm dependencies, at any level.

---

## What is proven, and what is not

### Proven live, in this environment

- The executable resolves and answers: `claude 2.1.205` at `C:\Users\user\.local\bin\claude.EXE`.
- One real headless turn was spawned and its stream captured.
- The `init` message is emitted **before credentials are used**: session id, model, build version and a
  258-entry slash-command set — including `compact` — were all readable on an unauthenticated run.
- The canary exits `CANNOT_DETERMINE` (2) with the host's verbatim words and one owner action.

### NOT proven live — the blocker

**Authentication.** The host answers `Not logged in · Please run /login` (the PATH binary) and
`Failed to authenticate: OAuth session expired and could not be refreshed` (the SDK's bundled binary).
Credentials are outside this work's authority, so the following remain **CANNOT_DETERMINE** here:

- a populated `compact_boundary` message,
- the session id across a *real* compaction (it is unchanged across a *failed* one, observed 8/8),
- whether `ModelUsage.contextWindow` is populated at runtime.

Because of that, **every capability in `capabilities.js` is declared `CANNOT_DETERMINE`** — not
`SUPPORTED`. The design's *target* for this profile is recorded in the same file under `TARGET`, where
it cannot be mistaken for a declaration.

### Proven offline, against fixtures

`node --test adapters/claude-code/sdk-supervisor/*.test.mjs` replays the **real** protocol bytes through
the **real** supervisor and the **real** core machine. Only `spawn` is faked; everything downstream of
the first line of stdout is production code.

- three consecutive rollovers advance the cycle 0 → 1 → 2 → 3, one advance each;
- the captured failed compaction halts `COMPACT_REQUEST_REFUSED` and advances nothing;
- a redelivered `compact_boundary` (same host uuid) is a recorded NOOP;
- a no-op compaction returns to ACTIVE in the *same* cycle with its latches still latched;
- an identity change halts `IDENTITY_MISMATCH` and the handoff is not delivered;
- `requestCompact` from any state but `HANDOFF_VERIFIED` is refused **and no process is spawned**;
- a crash after verification leaves the handoff consumable exactly once, by whoever gets there first;
- the continuation is sent once per *cycle* (not per session — a compacted conversation keeps its id).

### Owner action to complete the live proof

> Run `claude` interactively in this environment, complete `/login`, then from that authenticated shell:
> `node adapters/claude-code/sdk-supervisor/canary.js --json canary.json`
> A PASS run regenerates the capability matrix with real declarations. Nothing else about this adapter
> changes; the declarations are generated from the canary, never edited by hand.

---

## Measurement: honest about the denominator

The numerator is published — `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of
the latest assistant message. The denominator usually is not. It is resolved in this order, and which
one was used travels with the number:

| source | where it comes from |
|---|---|
| `host-reported` | `modelUsage[…].contextWindow` on a result message |
| `operator-configured` | `RESPAWNPACK_CLAUDE_CONTEXT_BUDGET`, or `contextBudgetTokens` |
| `assumed-default` | 1000000 — a default, not a reading. Matches the window every current Opus and Sonnet has; a 200K model such as Haiku 4.5 reads too EMPTY against it, so configure it there |

core's threshold policy flags the `final` threshold whenever confidence is not HIGH, and the evidence
source the measurement declares says which case it is: `documented-api` (HIGH) when the host published
the window, `documented-count-configured-window` (MEDIUM) when it did not and we supplied one —
operator-configured and assumed-default alike, because both are a window of ours rather than the host's.
`measure.js` still computes `windowAssumed` / `finalOnAssumedWindow` independently from the budget and
reports them beside core's answer, so the two can be asserted to agree rather than one silently
replacing the other. An unmeasured context is `CANNOT_DETERMINE`: never 0% (silence at the final
threshold) and never 100% (a checkpoint every turn).

---

## Where the bytes are

- `<projectDir>/.respawnpack/runtime/rollover/claude-code-<session>/turns/turn-NNN.json` — every turn,
  with the host's lines **verbatim**, written before anything interprets them. The core journal records
  *decisions* and carries the evidence records of applied transitions; halts and refusals do not carry
  evidence payloads, so these files are what a later reviewer re-reads to check this adapter's reading.
  Prompts are recorded by digest, not verbatim — a handoff-carrying prompt would put the whole context
  back on disk a second time.
- `…/journal.jsonl`, `…/state.json`, `…/cycle.json`, `…/thresholds.json` — core's own state.
- `…/<handoffId>.json` / `.verified.json` / `.consumed.json` — the handoff, its verification receipt,
  and the O_EXCL receipt that makes delivery exactly-once.

## Known limits (v0.3)

- **No mid-turn interruption.** A turn boundary is the host's own `result` message. If a turn is in
  flight when the final threshold is crossed, the supervisor waits for it. Interrupting would need the
  control protocol's interrupt request, whose settling semantics are not verified here — and "we told it
  to stop" is not the same observation as "it stopped".
- **Claim-then-send.** The consumption receipt is created *before* the continuation prompt goes out, so
  a crash in that window loses a delivery rather than duplicating one. The receipt names the handoff and
  its `exactNextAction`, so a lost delivery is recoverable by reading it; a duplicated atomic action is
  not recoverable at all.
- **`slash_commands` and `capabilities` are open, version-dependent sets** — 2.1.205 and 2.1.223 disagree
  about their own. They are read from `init` on every probe, never assumed.
- **A resume that answers from a different conversation is a fork, and it is silent.** Every turn's
  `session_id` is compared with the one being driven; a drifted turn produces no safe-boundary record,
  so no rollover can be built on it. (The compaction path keeps its own canonical check — the machine's
  identity guard.)
- **One supervisor per conversation.** Two supervisors driving one session would race; the exactly-once
  receipts bound the damage but nothing here elects a leader.
