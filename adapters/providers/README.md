# RespawnPack · the offload path

Carry **one bounded, hookless unit of work** to whichever model family the dated evidence and this
machine's reachability agree on, write the answer to a file, and leave a receipt saying which model
answered and why it was chosen.

```
node adapters/providers/offload.js --dir <project> --class <taskClass> --in <file> \
     [--out <file>] [--family <f>] [--model <m>] [--dry-run]
```

This is a **pack-side tool**. It runs from a pack checkout and is pointed at a target; nothing here is
installed into a project, the same way `adapters/claude-code/task-runner/` and
`adapters/codex/app-server/` are not.

## An offload is not a session

Anti-drift item 54 draws the line and this directory is the far side of it.

| | a task session | an offload |
| --- | --- | --- |
| what it is | a Claude Code session with the pack's hooks armed | one turn, no tools, no follow-up |
| who runs it | `adapters/claude-code/task-runner/` | this directory |
| where it can go | the Claude family, always | wherever the evidence and reachability agree |
| what it leaves | a task-attempt receipt, a handoff, commits | one answer and one offload receipt |

Work that needs the hooks is never offloaded. That is why `runOffload()` defaults `requiresHooks` to
false and the command line has no flag that could set it: a caller that genuinely needs the hooks is
running a session, not an offload. The option exists on the function because
`core/policy/routing.js` takes it, and because a caller that does pass it must get the hooked family
and nothing else, which is a property worth being able to test rather than assert.

## What one run does

1. **Reads the capability register.** The target's own `docs/reference/models/capability-register.json`
   first, this pack's `spine/reference/models/capability-register.json` second. A register that exists
   and cannot be read stops the run rather than falling through to the other copy, because routing from
   a file the operator did not mean to use is worse than not routing at all. The receipt records which
   one decided, its path and its `asOf` date.
2. **Runs three cheap probes**, one per family. None of them spends a token.
3. **Asks `core/policy/routing.js`** with the register and those answers. That module probes nothing and
   opens nothing; every fact it acts on is gathered here and handed in as data.
4. **Composes the prompt** with the routed family's envelope from `envelopes.js`.
5. **Runs exactly one turn** through the chosen provider.
6. **Writes the answer** to `--out`, or to stdout when there is no `--out`.
7. **Writes the receipt** to `<project>/.respawnpack/runtime/offload-<id>.json` with `open(path,'wx')`.

## The three providers

| family | module | how it is reached | how it authenticates |
| --- | --- | --- | --- |
| `anthropic` | `turn-claude.js` | `adapters/claude-code/sdk-supervisor/cli.js`, one headless turn with `--tools ""` | the operator's own sign-in |
| `openai` | `turn-codex.js` | the Codex app-server transport, one thread under a read-only sandbox with `approvalPolicy: never` | the operator's own sign-in |
| `minimax` and any other OpenAI-compatible host | `turn-openai-compatible.js` | `adapters/openai-compatible/client.js` over HTTPS | an API key read from the environment at call time |

All three answer the same shape: `{ok, text, usage, model, kind, durationMs}`, with `kind` null on a turn
that produced text and the provider's **own** failure word otherwise. The words are not bucketed into a
shared vocabulary on the way out, because a `NO_KEY`, an `AUTH`, a `TIMEOUT` and an `EMPTY` get four
different repairs and a receipt that said "failed" to all four would send every reader to the code.

### The probes

| family | the question | what it costs |
| --- | --- | --- |
| `anthropic` | does a `claude` executable resolve | a filesystem walk, no child process |
| `openai` | does a `codex.js` resolve, and does `initialize` answer | one handshake that completes before credentials are used |
| `minimax` | is the environment variable the project's provider block names set | one map lookup |

None of them proves a sign-in. A path that exists is not a credential that works, and saying otherwise
would be the unearned inference `core/policy/capabilities.js` refuses when it downgrades a support claim
with no canary. Whether the credential works is settled by the turn, and reported as the turn's own kind.

## The envelopes

`envelopes.js` holds one prompt envelope per family, distilled from
`spine/reference/models/prompting-*.md`. Anthropic gets XML-tagged sections with the long input first and
the question last; OpenAI gets lean developer-role markdown organised by headers; MiniMax gets bold
labels, an explicit output contract and explicit permission to refuse. A family the table does not
profile gets the **general** envelope, whose own first lines tell the model it is being addressed through
the shared fallback rather than through practice written for it, so a reader of the prompt and a reader
of the receipt learn the same thing.

`fixtures/` holds one golden file per family, composed from one fixed input. A change to any envelope is
a visible diff there rather than a silent change in what every offload since has actually asked for.

## The receipt

`schemas/offload-receipt.schema.json` is the normative declaration and `kernel/schema.test.mjs` captures
a real one from a real run of this path. It carries the register that decided, the availability rows the
probes produced **before** anything was spent, the whole route including the candidates it beat and the
families it skipped with each one's reason, the envelope, the provider's own failure kind, the usage the
host reported, the duration, and the digests of the input and the output.

Three things it deliberately does **not** carry: the composed prompt, the raw exchange, and any header
set. The input and the output are identified by digest, which is what an auditor needs and what a leaked
credential cannot hide inside.

**Never overwritten, and the id is derived rather than generated.** `offload-<id>.json` is created with
`O_EXCL`, and `<id>` comes from the input digest and the task class. A random id would have made every
run a new path and the exclusivity a formality; a derived one means the same unit of work against the
same project lands on the same path, so a repeat is refused rather than recorded twice with two answers
and no way to tell which one the operator acted on.

## Outcomes

**Exit 0** when the turn produced text. **Exit 2** for everything else: no route, an unreachable
provider, a refused credential, an elapsed deadline, an empty answer, a receipt id already taken. There
is no exit 1, and the schema has no spelling for a `FAIL` outcome. A provider that would not answer says
nothing about whether the work could be done, and answering the second question with the first is how a
missing binary becomes a re-planned task.

**Nothing retries on a second provider.** A failed turn stops. The receipt's `retry` block records that
in words, with the `from` and `to` fields a fallback would have to fill in, so adding one would be a
visible change to the record rather than an invisible change in behaviour.

## The credential rule

Anti-drift item 52: the key is read from the environment at call time and is never written, logged or
echoed by this pack. `offload.js` never reads `env[apiKeyEnv]` at all. It hands the environment **map**
down to `adapters/openai-compatible/client.js`, which reads the variable inside the request that needs
it, puts it in one header, scrubs its own results, and drops it when the call returns. The only fact
about a credential that reaches a receipt is the **name** of the variable, in an availability row that
says whether it was set.

`offload.test.mjs` proves that on bytes rather than by reading the code: an injected environment carries
a sentinel value, and every run greps the receipt, the answer file, stdout, stderr and every file under
the target's runtime directory for it. One scenario has the fake host echo the `Authorization` header
back inside the answer, which is a thing real proxies do, so the fence proves a mechanism rather than
proving that we happened not to copy anything.

## What this does not prove

No live call has ever been made through this path, by anything, at any point. Every test injects
`fetch`, a fake claude CLI beside a fake claude script, and a fake Codex transport; no real `claude` and
no real `codex` is ever spawned. The base URL in the fixtures is `api.example.invalid`, which cannot
resolve. A bounded live probe that actually spends tokens on a model is the owner's action.
