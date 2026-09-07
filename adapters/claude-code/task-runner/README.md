# claude-code / task-runner — one fresh session per task

Reads the project's task queue, **refuses to start** if the projection it would compose from is stale,
records a bounded delegation against the project, runs **exactly one fresh headless session** with
every protocol line kept verbatim, and then decides what that session achieved **out of band, in its
own process** — never by asking the session.

```
runner.js        queue reader, freshness refusal, prompt, the route, one turn, turn capture,
                 the out-of-band gates, the attestation, the receipt and the handoff
runner.test.mjs  77 tests, fixture-driven — no live CLI, and no authenticated host required
canary.js        the runner's own activation canary: a cheap --probe-only preflight, and the
                 full nonce-echo proof (the hooks-and-install audit §6, the core-adapters-ops audit §3)
canary.test.mjs  fixture-driven, no live CLI (see "The canary" below)
```

---

## The one thing to know before using it

**Exit 0 means two things and no third: every gate the runner ran passed, and the kernel holds a
`contract complete --met` attestation for every recorded acceptance criterion.**

It does **not** mean a criterion was verified. Nothing here can evaluate prose, so every criterion is
recorded with the evaluation `CANNOT_DETERMINE` and, separately, as attested or not. An attestation is
a claim the closing caller made under the kernel's own refusal of a partial close (`kernel/lib/closeout.js`
says the same thing about the record it archives); printing it as proof would manufacture exactly the
evidence this pack exists to refuse. The printed summary says which half is which on every run.

And the session's own word is never the proof. A transcript full of "all acceptance criteria met"
changes nothing: completion is decided from the gate results and the kernel's attestation record, and
from nothing else. A timeout, an exit code and elapsed time are never completion signals
(`core/lifecycle/evidence.js` `FORBIDDEN_PROOF_TOKENS`).

**"Could not run" never collapses into "failed."** A gate whose command does not exist, whose deadline
passed, or whose process could not be started is CANNOT_DETERMINE at exit 2 — not FAIL at exit 1. The
two get different repairs: a FAIL sends someone to the code, a CANNOT_DETERMINE sends them to the
toolchain, and answering the second with the first is how a missing binary becomes a re-planned task.

---

## What it does, in order

| # | Step | If it cannot |
|---|------|--------------|
| 1 | `--dir` names an existing directory | CANNOT_DETERMINE, exit 2 |
| 2 | **Freshness first.** `docs/derived/STATE.json` must be CURRENT against the revision chain and the compiler-input digests | CANNOT_DETERMINE, exit 2, **and nothing is written or spawned** |
| 3 | Read and accept `docs/derived/state/tasks.json` | CANNOT_DETERMINE, exit 2, naming ABSENT / MALFORMED / INVALID |
| 4 | Pick the first `ready` row whose `dependsOn` are all `done` | no runnable row: NOT_APPLICABLE, exit 0. A row named with `--task` that cannot run: CANNOT_DETERMINE, exit 2 |
| 5 | Probe the host with `claude --version` (no session, no cost) | CANNOT_DETERMINE, exit 2, **before any contract is opened** |
| 6 | `contract delegate --task <title> --acceptance <criteria>` against the project, as a child process | CANNOT_DETERMINE, exit 2, with the kernel's verbatim words |
| 7 | One turn through `cli.runTurn`, prompt on stdin, **no `--resume`** | see below |
| 8 | Write the turn verbatim to `.respawnpack/runtime/tasks/<task id>/turn-NNN.json` | CANNOT_DETERMINE, exit 2 |
| 9 | `stream.detectAuth` on the observed stream | unauthenticated: CANNOT_DETERMINE, exit 2, with the host's own sentence |
| 10 | **The gates**, as child processes in this process: `savepoint --verify` plus every declared `qualityGate` check | a failing check is FAIL, exit 1; one that could not run is CANNOT_DETERMINE, exit 2 |
| 11 | **The attestation**, read from `.respawnpack/runtime/contract.json` and `delegations.json` | an open, unreadable or unmatched contract is CANNOT_DETERMINE, exit 2 |
| 12 | **The handoff**, through `core/state/handoff.js` | CANNOT_DETERMINE, exit 2 — and the run says so |
| 13 | **The receipt**, `task-attempt-<id>-NNN.json`, created with `open(path,'wx')` | a path already taken is reported with the record it holds and NEVER overwritten: CANNOT_DETERMINE, exit 2 |

Step 2 is first on purpose. Starting a fresh session from a projection that no longer describes the
tree is a confident wrong answer, which is the failure the pack exists to prevent; and a refusal that
had already recorded a contract or created a turn directory would have changed the project it refused
to work in. Steps 10-13 are last for the mirror reason: they are the only steps that may say anything
about completion, and every one of them runs after the session has ended and reads the project rather
than the transcript.

The three `report` fields `gates`, `receipt` and `handoff` are `null` **only** for a run that refused
before the gates could run. `null` there says "no verdict exists", which a consumer cannot mistake for
agreement. A run that reaches step 10 fills all three, always — including when a gate could not run.

---

## The gates

**`savepoint --verify`** runs against the same kernel that recorded the delegation: the target's own
`.claude/respawnpack/respawnpack.js` when it has one, this pack's otherwise. It is one of the pack's
own verbs, so its exit code *is* the 0/1/2 outcome vocabulary and the row takes it directly.

**The project's own checks** come from `qualityGate.checks` in its `respawnpack.config.json`, each
spawned as its own child process. Exit 0 is PASS and any other exit is FAIL — `kernel/lib/gate.js`'s
own mapping, kept identical so the runner and `respawnpack gate` cannot reach different verdicts about
one project. A founder's `npm test` does not speak this pack's 0/1/2 vocabulary, so reading *its* exit
2 as CANNOT_DETERMINE would invent a claim the check never made.

An **undeclared** gate is not a passed one. Absent, empty, or opted out with no reason is
CANNOT_DETERMINE, which is `gate.js`'s NOT_CONFIGURED at the same exit 2. A declared opt-out *with* a
reason is NOT_APPLICABLE and does not stop a run from passing. This runner deliberately does **not**
inherit `gate.js`'s stack auto-detection: it runs what the project declared, so nothing it reports was
chosen by a guess about the build system.

A task row may switch either gate off with `gates.savepoint: false` / `gates.gate: false`; that row is
recorded NOT_APPLICABLE naming the queue as the source of the declaration. The schema has no per-gate
`reason` field today, so the declaration itself is the only justification on offer — a natural next
addition, and the reason the row prints where the declaration came from.

**`gates.only` is not implemented.** Scoping the gate to part of a project is **P4-K-08**. Until it
lands the runner records the request, runs the **full** gate, and says both in the report and in the
receipt. A guessed narrowing could skip the check that would have caught the defect; running more than
was asked cannot hide anything, running less silently can.

---

## The attestation

The runner requires one `contract complete --met` attestation per **recorded** criterion — recorded
meaning the list the kernel wrote when the delegation was opened, not the queue's copy of it.

It reads two documents, because one cannot answer the question alone. `.respawnpack/runtime/contract.json`
says whether the delegation is still open; closing one returns the runtime pointer to `collaborate`,
so it cannot say *which* criteria were restated. `.respawnpack/runtime/delegations.json` is the
attestation record itself. A session that ends with an **open** contract is CANNOT_DETERMINE — never
silently done, and never FAIL, because "stopped halfway" and "finished without attesting" are the same
observation from here.

Both are read through `core/_io.js`'s classifying boundary rather than `hooks/_runtime.js`
`readContract`. That reader degrades an unreadable file to `collaborate`, which is the conservative
answer for a hook and the dangerous one here: `collaborate` is exactly what a *closed* delegation looks
like, so degrading would turn a transient read failure into "the task was completed".

---

## The receipt and the handoff

The **receipt** is `.respawnpack/runtime/task-attempt-<task id>-<NNN>.json`, beside
`savepoint-attempt.json`, registered as the `task-attempt` schema family. It carries the gate rows,
the attestation, the handoff's fate and the outcome.

It is created with `open(path, 'wx')` and **never replaced** — anti-drift item 40 — which is the
difference from `savepoint-attempt.json`, whose one fixed name is rewritten wholesale by the next run.
So the attempt number lives in the **filename**, the way `stop-<sessionId>.json` and
`precompact-<sessionId>.json` already carry their subject, and it is the same number as the turn record
it describes: `task-attempt-T-1-003.json` pairs with `tasks/T-1/turn-003.json`. A second attempt gets
`-004`. A path that is already taken is reported with the record it holds and is never clobbered, and
the run degrades to CANNOT_DETERMINE — a verdict nobody could record is not a verdict that was
delivered.

The **handoff** is written through `core/state/handoff.js`: the same write-once document plus sibling
verification receipt `hooks/precompact-ledger-nudge.js` writes at PreCompact, so the next reader of an
incomplete task reads one format rather than a second one invented here. It carries the gate rows as
records in `verificationEvidence`, every failing or unrunnable gate and every unattested criterion in
`unresolvedQuestions`, and an `exactNextAction` that names what to fix. It is bound to the task
session's own context cycle; if the host reported no session id, no handoff is written and the run says
so, because a handoff that cannot name its conversation may not exist.

Its `git.uncommittedFiles` lists **distinct paths, not distinct tree-state keys**. `hooks/_runtime.js`
`treeState` keys its tree snapshot by bucket (`W:` unstaged diff, `S:` staged diff, `U:` untracked
content, `C:` current bytes), and one path legitimately sits under more than one bucket — a path that is
both staged and further modified, or one that simply has its `C:` content mirror alongside another
bucket key. Every key mapped to a path without de-duplicating counted such a path twice or more, which
silently halves `MAX_LISTED_FILES`'s budget for a real project: the 2026-09-03 dogfood run
(the field run of 2026-09-03, defect D1) saw six changed paths become twelve entries. The
list is now built from `new Set(...)` over the mapped paths, keeping first-occurrence order stable. The
bucket a path came from travels no further than this step: `schemas/rollover-handoff.schema.json` fences
the field to a plain array of strings, with no place to carry it even if it were kept.

The **child's stderr** is bounded, the last 20 lines and then a 4000-character cap, and surfaced in
`report.turn.stderrSummary` on every run, plus in the printed summary whenever the outcome is not PASS,
with any truncation named rather than left silent. The full, unbounded capture still lives verbatim in
the turn record beside it; nothing about that changed. This exists because the same dogfood run's one
explanatory line, a permission and trust refusal, was on the child's stderr (defect D2) and reached
neither the report nor the printed summary before this fix, so an owner had to already know to open the
transcript file to find it. Stderr is surfaced as text for a person, never as a completion signal: the
same rule that governs stdout (`core/lifecycle/evidence.js` `FORBIDDEN_PROOF_TOKENS`, anti-drift item 38)
applies to it too, so nothing it says, however confident, can move a verdict.

---

## Refusals that are not failures

**An unauthenticated host is CANNOT_DETERMINE, never FAIL** (`sdk-supervisor/canary.js`'s rule,
unchanged). "Could not run" and "ran and failed" are different facts: a task marked FAIL gets
re-planned when what is owed is a login. The host's sentence is printed verbatim, the queue row is
left exactly as it was, and the stream is kept as the evidence of what happened.

A **timeout** is not an outcome either, and neither is an exit code. `cli.js` kills the child at the
deadline and returns whatever arrived; the runner records that, keeps the partial transcript, and
reports CANNOT_DETERMINE. It never reads a timeout, an exit code or elapsed time as a completion
signal (`core/lifecycle/evidence.js` `FORBIDDEN_PROOF_TOKENS`).

And the runner **never reads the session's own claim of success**. The only facts it takes from the
stream are the ones `stream.js` observes structurally: the new session's id, and whether the host said
it could not authenticate.

---

## What it never passes

**Never `--bare`.** It skips hooks, CLAUDE.md discovery and auto-memory, which *are* the anti-drift
core. **Never `--dangerously-skip-permissions` by default**; `--allow-dangerously-skip-permissions`
exists as the owner's own explicit choice and is off unless typed. **Never `--resume`**: omitting
`sessionId` is already how a fresh session starts.

These are not comments. `assertArgvIsSafe` inspects the composed argv and refuses to spawn if any of
the three reaches it, and `runner.test.mjs` asserts both that today's argv is clean and that the fence
actually rejects an argv carrying each flag.

The invocation is exactly the shape the sdk-supervisor already proved, plus the allow list the next
section is about:

```
claude --print --output-format stream-json --verbose --allowedTools <list>
```

plus whatever `--model` / `--permission-mode` the caller asked for, with the prompt on **stdin**
because a Windows argv dies at ~32767 characters and a task record plus its acceptance list is long.

---

## The tool allow list

**Every task session is told what it may use on the command line, not in the project's settings file.**
The flag is `--allowedTools` (the CLI also spells it `--allowed-tools`), whose own help reads *"Comma or
space-separated list of tool names to allow (e.g. `"Bash(git *) Edit"`)"*. It takes the same
permission-rule syntax as `permissions.allow` in `.claude/settings.json`, so the entries look identical;
the difference is which of the two the host will actually read.

**Why the argv and not the settings file.** The first live run of this runner
(the field run of 2026-09-03, defect D3) put six entries in the target's
`.claude/settings.json` and the host discarded all of them, because that workspace had never been opened
interactively and so had never accepted the trust dialog. It said so on the child's **stderr** and
nowhere else:

```
Ignoring 9 permissions.allow entries from .claude/settings.json: this workspace has not been
trusted. Run Claude Code interactively here once and accept the trust dialog, or set
projects["<path>"].hasTrustDialogAccepted: true in ~/.claude.json.
```

The session could `Read`, could not `Edit` or `Write` the one file in its scope, and could not see why,
because that sentence never enters the JSON stream. It guessed, reasonably and wrongly, that the rule
syntax was at fault. A freshly provisioned target is the exact case a task runner is pointed at, so a
permission scheme that quietly evaporates there is not a permission scheme. `--allowedTools` is not
gated by the trust dialog.

**The floor**, owned by `DEFAULT_ALLOWED_TOOLS` in `runner.js` and by nothing else:

| Entry | Why it is in |
|---|---|
| `Read`, `Edit`, `Write` | a task session that cannot edit the one file in its scope is defect D3 itself |
| `Bash(node .claude/respawnpack/respawnpack.js contract *)` | the composed prompt tells the session to attest with `contract complete --met`; an instruction it cannot carry out produces an unattested run for no reason. Scoped to the `contract` verb of the target's installed kernel, not to the kernel and not to node |
| `Bash(git status)`, `Bash(git diff *)`, `Bash(git log *)` | read-only git, the same three reads a fresh install already writes into `.claude/settings.json`, so a session can see what it changed |

**And what the floor deliberately leaves out:** no push, no `git commit`, no reset, clean or
checkout, no package install, no bare `Bash` and no `Bash(*)`. A task session earns its verdict from
gates this runner runs out of band in its own process, so nothing it could do to a remote, to the index
or to `node_modules` would make that verdict truer, and every one of those is a change nobody declared.

---

## The derivation (P3-I-2)

**The session's tools DERIVE from the project's own declared posture and projectType — Class B,
"intent over mechanics" (the class audit).** A founder declares
*intent* once, in `respawnpack.config.json` (`posture`, three profiles; `projectType`, four
archetypes); the mechanics — here, which tools a task session may run — are derived from it rather
than set by a second, independent knob a planner has to keep in step by hand.

`deriveAllowedTools({posture, projectType})`, pure and exported from `runner.js`:

| Declaration | Adds |
|---|---|
| (the floor, always) | `DEFAULT_ALLOWED_TOOLS` above |
| posture `light` | `Bash(git add *)`, `Bash(git commit *)` — a relaxed posture may stage and commit its own work |
| projectType `ops-infra` | `Bash(terraform validate)`, `Bash(terraform fmt *)`, `Bash(ansible-lint *)`, `Bash(shellcheck *)` — read-only validators for that archetype's own toolchain |
| projectType `greenfield-app` or `mature-product` | `Bash(npm test)`, `Bash(npm run lint)`, `Bash(npm run build)` — the three scripts a Node project's own `package.json` already promises |
| posture `standard`/`strict`, projectType `docs-only` | nothing |

Postures and projectTypes compose: a `light` `ops-infra` project derives the floor plus both
additions. **An undeclared posture resolves the way `hooks/_posture.js`'s `resolve()` resolves it**
(DEFAULTED is `strict`, which adds nothing), **and an undeclared or unrecognised projectType adds
nothing**, so a project that declares neither derives the floor byte for byte — the migration
guarantee, checked as a fence in `runner.test.mjs` rather than promised in prose.

`resolveToolDerivation(dir)` is the I/O half: posture is read through `hooks/_posture.js`'s ONE
resolver, and `projectType` through the SAME classified boundary that resolver reads its own config
through (`hooks/_artifact.js`, never a raw read). A config that cannot be read derives the floor and
says why, exactly the way `hooks/_posture.js` already degrades its own resolution rather than guessing
wider from a fault.

---

**How a task row narrows it.** A queue row may declare its own `tools`
(`schemas/tasks.schema.json`, optional, narrowing only):

```json
{ "id": "T-2", "title": "correct the export heading",
  "tools": ["Read", "Edit", "Bash(git status)"] }
```

Present, it must be a **SUBSET of the list this project derives**: the effective list is the row's
own entries, so the row above gets no `Write` and no kernel call. An entry outside the derived set is
refused — at exit 2, naming the entry and the derived list, before anything is spawned and before the
delegation is recorded, the same position the freshness refusal already occupies (owner decision 21;
this replaces the field's original "present replaces the default" semantics). Absent, the derived list
applies. Never empty when present: a `tools: []` is a session that may use no tool at all, which is not
something a planner means, and accepting it would make "declared nothing" indistinguishable from
"took the derived list". The queue reader and the schema both refuse it. `--allowed-tools` on the
command line is the **owner's explicit override**, typed on the command line rather than derived, and
it may **widen** past what the project derives — a queue row cannot.

**The floor, which applies regardless of source.** `assertArgvIsSafe` refuses an entry that grants
`Bash` with no program (`Bash`, `Bash(*)`), that grants a **push**, or that grants a **forcing flag**
(`--force`, or a `-` cluster containing `f`, which is how `rm -rf` and `checkout -f` get past their own
refusals) — wherever the entry came from: the derivation, the queue row, the command line, or a future
caller. The refusal happens twice: once on the resolved list before any process is spawned, so the run
is CANNOT_DETERMINE at exit 2 with the offending entry named and no delegation recorded, and again on
the composed argv, so a list threaded in by a future caller meets the same floor. The permission-bypass
opt-in does not lift it. This is a floor rather than a sandbox: the host's own permission layer is what
enforces a rule, and the floor only guarantees that the three shapes with no legitimate use in a
bounded task cannot arrive by accident. `runner.test.mjs` proves every posture/projectType combination
the derivation can produce still passes this fence.

**What gets recorded.** The composed list, its source (`default`, `task-row` or `option`), and
`derivedFrom` — the `{posture, projectType}` this project's list was derived from, present regardless
of source — go into the report, into the runner's record of the delegation it opened
(`allowedToolsDerivedFrom`), and into the receipt (`schemas/task-attempt.schema.json`,
`tools.derivedFrom`), so a reader of a verdict can tell "could not write the file" from "was not
allowed to write the file", and can tell the floor from this project's own derivation without
re-deriving it. If the host's trust sentence appears on stderr, the runner names it in words in the
summary, in an owner action and in the receipt's `tools.trustRefused`. Neither changes any verdict,
because the session's tools came from the argv; they change what the operator is told. `--dry-run`
prints the derivation and its source alongside the composed prompt.

---

## The route (P4-M-5)

**The session's model is ROUTED, not guessed — Class G, "model-aware orchestration"
(the class audit).** A queue row may declare its own `taskClass`, one
of `core/policy/routing.js`'s eight classes (coding, review, security-testing, long-context, planning,
writing, research, extraction); a row that declares none routes as `coding`, the default
`resolveTaskRoute` applies — the same "absence is the ordinary case" reading `tools` already carries.

`resolveTaskRoute(dir, task)` reads whichever capability register answers — the target's own installed
`docs/reference/models/capability-register.json` first, else this pack's own
`spine/reference/models/capability-register.json`, resolved from the runner's own file location, else
neither, which is a real state and never a fault — and calls `core.routing.route()` with
`requiresHooks: true` **unconditionally**. A task session is always a hook-bearing Claude Code session
(anti-drift item 54): the routed `family` is always `HOOKED_FAMILY`, whatever the register rates
`preferred` for another family, and `requiresHooks` restricts the candidate *pool* before ranking runs,
not just the winning family — a register rating an `openai` model `preferred` for the row's class still
routes an `anthropic` model, never the higher-rated one.

**What gets recorded.** `model` is what `route()` chose; `effectiveModel` is what the session's
`--model` actually was — `model`, unless the owner typed `--model` on the runner's own command line, in
which case the owner's choice runs and `overridden`/`overriddenBy` say so. Both, plus `taskClass`,
`family`, `rating`, `why` and which register answered (`register.source`: `installed`, `pack` or
`none`, with `register.why` in words when it is `none`), go into the report and into the receipt
(`schemas/task-attempt.schema.json`, `route`; `family` is pinned there with `const: "anthropic"`, so a
future bug that forgot `requiresHooks: true` fails the schema, not just a runtime check). `--dry-run`
prints the route beside the tool derivation and spawns nothing.

**A missing or unreadable register never stops the run.** `loadCapabilityRegister` reads the register
with a plain, classified-at-this-file-level try/catch (`kernel/schema.test.mjs`'s `RAW_READS` names the
read and why: the register is a static reference file, never written concurrently, never mid-rename) —
ABSENT and UNREADABLE degrade to the same `register: null` answer `core.routing.route()` already has a
general fallback for, with `register.source: "none"` and `register.why` naming which.

---

## Usage

```bash
node adapters/claude-code/task-runner/runner.js --dir <project> [--task <id>] [--dry-run]
```

| Option | Meaning |
|---|---|
| `--dir <path>` | the project whose queue is read (default: `CLAUDE_PROJECT_DIR`, then cwd) |
| `--task <id>` | run this row instead of the first ready one; it must still be ready with its `dependsOn` done |
| `--dry-run` | compose the prompt, print it, spawn nothing, record nothing |
| `--model <name>` | overrides the row's ROUTED model (P4-M-5); the report and receipt say the route was overridden and by what |
| `--permission-mode`, `--timeout <ms>` | passed to the one turn |
| `--allowed-tools <a,b>` | the session's `--allowedTools`, outranking the row's `tools` and the derived list, and the only source that may WIDEN past what the project derives; every entry is still fenced |
| `--kernel <path>` | the `respawnpack.js` to invoke (default: the target's installed kernel, then this pack's) |
| `--claude-path <path>` | the executable (default: `RESPAWNPACK_CLAUDE_PATH`, then PATH) |
| `--json <file>` | write the full report |
| `--allow-dangerously-skip-permissions` | the owner's own choice, off by default |

Exit: **0** PASS or NOT_APPLICABLE · **1** FAIL · **2** CANNOT_DETERMINE.

---

## The task record

One row of `docs/derived/state/tasks.json` (`schemas/tasks.schema.json`, registry family
`task-queue`). The document is **authored by the planner**; this pack has no writer for it and this
runner never writes it, which is why a refused or unauthenticated run leaves the row exactly as it was.

The runner validates the document **procedurally**, the way `hooks/_artifact.js` validates
`requirements.json` and `goal.json`, rather than by loading `schemas/validate.mjs`: that validator's
own header says the procedural loaders are the production validators, and `schemas/` is never
installed to a target. The rules are the schema's, field for field, plus the one rule the schema says
in prose it cannot express — ids are unique.

One extra refusal lives here and nowhere else: an acceptance criterion containing a **semicolon** is
refused, because `contract delegate --acceptance` splits on `;`. Recording it would change what the
queue said, and the "one `--met` per recorded criterion" rule above would then owe an attestation for a
criterion nobody wrote.

---

## The prompt

Carries the pack's boot instruction (`/respawn` first), the verified freshness of the projection, and
the task record: id, title, spec pointer, risk, intent, scope, and every acceptance criterion with the
exact `contract complete --met` line that attests it. It ends by telling the session plainly that its
own statement of completion is not proof and will not be read as one.

It does **not** yet carry the STATE facts or the CONTINUITY note that the hooks-and-install audit §6 also names —
composing those into this prompt is still unclaimed work in this tree. **P5-T-16c has landed the piece
that used to block it**, though: `session-routing-nudge.js` no longer injects its full boot block inside
a task session, so a later change that does compose STATE/CONTINUITY here would no longer double the boot
budget against a hook that also injects them, or risk the two disagreeing. `session-routing-nudge.js`
still records the tree baseline unconditionally either way (anti-drift item 18, which this runner
depends on), and `stop-savepoint.js` now withholds `decision:"block"` for the same variable, on the same
reasoning this doc gives step 4 above: a headless `--print` turn has no human to act on a held stop, and
this runner already runs the real savepoint gate itself once the turn ends.

The runner sets `RESPAWNPACK_TASK_ID` on the child's environment now, which is the variable those two
hooks read (P5-T-16c).

---

## Where the bytes are

```
<project>/.respawnpack/runtime/tasks/<task id>/turn-001.json      the transcript, verbatim
<project>/.respawnpack/runtime/task-attempt-<task id>-001.json    the verdict
<project>/.respawnpack/runtime/rollover/claude-code-<sid>/ho_*.json   the handoff + its receipt
```

The turn record is the same `claude-cli-turn` shape `sdk-supervisor/supervisor.js` writes: the argv,
the prompt's digest and byte count, the exit, and `lines` — the protocol lines **verbatim**, only the
line terminator removed. A second run writes `turn-002.json` and `task-attempt-<id>-002.json`; it never
overwrites the first run's evidence.

`.respawnpack/` is gitignored on an installed target, so this is machine-local scratch, not durable
project truth.

---

## The canary

`canary.js` proves one narrow, checkable claim about the runner above: when it hands a spawned session
a delegate contract whose single acceptance criterion is a token generated fresh for the run, and that
session later runs `contract complete --met "<token>"` for real, the runner's own attestation reading
reports it correctly. It never spawns a session or records a delegation itself; it builds a throwaway
project and calls `runner.runTask()`, the same exported function `runner.test.mjs` drives, so the
runner is what gets proved rather than a second path that looks like it.

Two modes:

- **`--probe-only`.** Does `claude` resolve, authenticate, and enumerate `compact`? One short handshake
  turn, reusing the sdk-supervisor's own `supervisor.js` `probe()` rather than copying it. No task
  session, no delegation, no kernel call. Cheap, and safe to run once per machine.
- **The full canary (default).** Builds a throwaway git project with a minimal installed kernel (copied
  from `install/_sources.js`'s own `KERNEL_FILES` and `CORE_FILES`, so the project looks like an
  installed target rather than a second hand-rolled idea of one), generates the token, and runs the
  task runner against it for real, end to end, through one real headless `claude` session. This spends
  real tokens and is an owner action: an unattended session working on this pack runs `--probe-only`
  only and leaves the full run for a human to decide to spend.

Exit 0 PASS, 1 FAIL, 2 CANNOT_DETERMINE, the same map as the runner. The verdict comes from exactly
four facts read off the runner's own report, in this order: whether a delegation was recorded and a
turn was captured at all; whether the host authenticated (checked before the exit code, because a host
can answer an authentication failure and still exit 0); whether the turn ran to completion (a timeout
or a nonzero exit proves nothing about the echo either way); and only then, whether the kernel's own
attestation archive echoes the token. The canary never reads `report.turn.lines` or any other transcript
text for this decision, only `report.contract`, `report.turn.exit`, `report.auth` and
`report.gates.acceptance` (which is itself read from `.respawnpack/runtime/contract.json` and
`delegations.json`, the kernel's own records).

A missing or wrong token is **FAIL**, not CANNOT_DETERMINE, once the session has run to completion.
This is a deliberate difference from `sdk-supervisor/canary.js`'s own nonce-echo trick: that nonce lives
in free text a model may or may not repeat, so a non-echo is undetermined; this token lives in a
structured kernel record that only exists if `contract complete --met` actually ran and actually
matched what was recorded, so once the turn has finished, whether that record exists and matches is a
settled fact rather than a guess. The runner's own refusals (a stale projection, an unreachable host,
an unsafe composed argv) still propagate as CANNOT_DETERMINE, carrying the runner's own words.

This canary does not add a row to `conformance/CAPABILITY-MATRIX.md`. That matrix and
`core/policy/capabilities.js` are built around exactly seven rollover capabilities (probe,
measureContext, settleOrStop, requestCompact, observeCompact, injectHandoff, resume) for the in-place
rollover design; the task runner never rolls a conversation over in place, so none of the seven
describes what this canary proves, and `declare()` has no capability id this profile could legitimately
claim.

```bash
node adapters/claude-code/task-runner/canary.js --probe-only
node adapters/claude-code/task-runner/canary.js               # the full proof; spends real tokens
```

| Option | Meaning |
|---|---|
| `--probe-only` | the cheap preflight only; never spawns a task session |
| `--project-dir <path>` | the throwaway project (default: a fresh temp directory, built fresh) |
| `--model`, `--allowed-tools`, `--permission-mode`, `--timeout <ms>` | passed to the one session |
| `--kernel <path>` | the `respawnpack.js` to invoke (default: the throwaway project's own installed copy, then this pack's) |
| `--claude-path <path>` | the executable (default: `RESPAWNPACK_CLAUDE_PATH`, then PATH) |
| `--json <file>` | write the full report |

`canary.test.mjs` drives all of this offline: the kernel is real (a real `git init`, a real `contract
delegate`, a real `contract complete --met`), and only the `claude` process itself is faked, replaying
the same fixture streams `runner.test.mjs` uses. See "Tests" below.

---

## Tests

```bash
node --test adapters/claude-code/task-runner/runner.test.mjs
node --test adapters/claude-code/task-runner/canary.test.mjs
```

Both are registered in `ops/suite-counts.mjs`'s `SUITES` and, because neither needs a live CLI, in the
derived fast tier.

`runner.test.mjs` runs in about 68 seconds, up from about 57 before the route's own tests (P4-M-5)
landed, about 24 before the derivation's own tests (P3-I-2) landed and about 8 before the gates
landed — the difference each time is real child processes: a `git init` fixture, a `contract
delegate`, a `contract complete --met` and the gate commands themselves, per test. `canary.test.mjs`
measures about 7 seconds for 19 tests, on the same machine, with the same per-test cost (its own
`git init`, `contract delegate` and `contract complete --met`, plus copying a minimal installed kernel).

**Starting a session** is proved against the sdk-supervisor's own fixture files. The unauthenticated
state replays `fixtures/captured/07-pathcli-test.jsonl` — a real host really saying
`Not logged in · Please run /login`. The healthy turn replays `fixtures/synthetic/turn-light.jsonl`,
because **all three** captured streams are from an unauthenticated host (`fixtures/MANIFEST.json`
records which is which), so the captured set is the right evidence for the unauthenticated state and
cannot be evidence for a healthy one.

**What a session achieved** is proved in three states, none of them faked: gates confirm the acceptance
and every criterion is attested ⇒ exit 0, with the receipt and handoff on disk carrying the gate rows;
a gate fails ⇒ exit 1, with the handoff naming which gate and why; the session ends with an open,
unattested contract ⇒ exit 2, with the receipt listing the unattested criteria. Beside them: a
`qualityGate` command that does not exist yields CANNOT_DETERMINE and exit 2, never FAIL; a receipt
path that is already taken is never overwritten; and a transcript containing `FORBIDDEN_PROOF_TOKEN`
plus a confident "all acceptance criteria met" is not accepted as completion when no attestation
record exists.

**The handoff's file list and the child's stderr** (the field run of 2026-09-03, defects
D1 and D2) are proved directly: a path both staged and further modified appears once in
`uncommittedFiles`, with the count matching the distinct set; a 31-line stderr capped at the
20-line/4000-character bound reaches both the JSON report and the printed summary with the truncation
recorded, while the turn record keeps the full capture untouched; and a forbidden-proof-token success
claim written to stderr reaches the report as text while changing no outcome, the same fence the
boastful-transcript test above proves for stdout.

The kernel is **not** faked, in either half: `contract delegate` and `contract complete --met` both run
as real child processes against a real throwaway git repository, because "the delegation was recorded"
and "the criteria were attested" are claims about the kernel's own records, and a fake returning
`{ok:true}` would prove only that the fake returns true. The gates are real child processes too.

**The allow list** is proved in three states of its own: a row with no `tools` composes the derived
list onto the argv and the report, the delegation record and the receipt all carry it; a row that
declares its own list composes exactly that list, with nothing the derived list would have added; and a
row carrying `Bash`, `Bash(*)`, `Bash(git push *)` or `Bash(rm -rf *)` is refused at CANNOT_DETERMINE and
exit 2 with the entry named, before the version probe, the delegation or the session exists. Beside
them: the floor is asserted to pass its own fence and to contain no push, force, install or commit; the
queue reader and the schema are checked to agree about `tools` in both directions; and the host's trust
sentence is proved to reach the summary, an owner action and the receipt while changing no verdict.

**The derivation (P3-I-2)** is proved on three of the four archetypes `ops/_project-fixtures.mjs` names
plus the undeclared case: ops-infra under a declared `light` derives the floor plus the validators and
the two git entries, and a row adding `Bash(rm *)` — safe-shaped, so the floor fence alone would miss
it — is refused at exit 2 naming it, with no delegation recorded and no turn file written; greenfield-app
under a declared `standard` accepts a narrowing row (`Read`, `Edit` only) and the receipt shows the
narrowed list with `derivedFrom`; docs-only under a declared `strict` derives the floor exactly; and the
undeclared case, through a real run with no `respawnpack.config.json` at all, derives
`DEFAULT_ALLOWED_TOOLS` byte for byte — a fence, so the migration guarantee is checked rather than
promised. Beside them: `--allowed-tools` widening past what a project derives is accepted and recorded
as the owner's override; every combination `deriveAllowedTools` can produce, across every posture and
every declared, undeclared or unrecognised projectType, is proved to still pass `assertArgvIsSafe`; an
unreadable config is proved to derive the floor with the report naming why; and `--dry-run` is proved to
print the derivation and its source.

**The route (P4-M-5)** is proved on the two archetypes the audit names for this change, built with
`ops/_project-fixtures.mjs`'s `materialize()` rather than a hand-made repository: a `greenfield-app`
fixture carrying an installed register routes a row declaring `taskClass: "security-testing"` to
whatever `core.routing.route()` itself picks on that register, with the report, the argv the session
actually ran with, and the receipt all agreeing; a `docs-only` fixture with no installed register routes
an undeclared row as `coding`, answered by this pack's own register (`register.source: "pack"`). Beside
them: `--model` on the runner's own command line is proved to win over the routed model, with the
*routed* model still recorded distinct from the *effective* one and the receipt naming the override; an
unrecognised `taskClass` is refused by `validateTaskQueue` before the version probe or a turn exists,
naming every valid class; a hand-crafted register rating an `openai` model `preferred` is proved to
still route an `anthropic` model, because `requiresHooks` restricts the candidate pool before ranking
runs rather than only the winning family (anti-drift item 54, proved here at the runner's own wiring,
not only inside `core/policy/routing.js`'s own tests); and a missing or malformed installed register is
proved not to stop the run, with `register.source: "none"` and `register.why` naming which in words.
`resolveCapabilityRegisterPath` and `loadCapabilityRegister` are also proved directly: preferring an
installed copy over the pack's own, an injected candidate list proving "neither resolves", and ABSENT
and MALFORMED both degrading to the same `register: null` answer with their own `why`. `--dry-run` is
proved to print the route beside the tool derivation.

Four fences are checked against the tree rather than asserted about it: the refusal words are confirmed
still present in `kernel/respawnpack.js`'s `cmdStatus`; the forbidden-flag guard is shown to reject an
argv carrying each flag, and each forbidden allow entry under both spellings of the flag, with the
permission-bypass opt-in shown not to lift it; `kernel/lib/gate.js` is confirmed to still carry the
Windows batch-shim technique this runner copies; and `core/_io.js` is confirmed to still open the
receipt with `wx`.

`kernel/schema.test.mjs` captures a real receipt from a real run of this runner and validates it
against `schemas/task-attempt.schema.json` — deliberately from a run that did **not** pass, so the
`exitCode: null` a could-not-run gate writes is exercised rather than assumed. That capture also proves
`route`: the fixture task declares no `taskClass`, so the receipt's `route.taskClass` reads `coding` and
`route.register.source` reads `pack` (this checkout has no `docs/reference/models/`), and a second fence
in the same file checks `schemas/tasks.schema.json`'s `taskClass` enum against
`core/policy/routing.js`'s `TASK_CLASSES`, both directions, the same discipline the P4-M-2 fence already
keeps between that array and the capability register's own schema.

**`canary.test.mjs`** proves the canary in three states, fixture-driven, plus one fence: an echoing
attestation (a real `contract complete --met` against a real throwaway repo, via a fake session that
replays the healthy fixture) passes at exit 0; a missing attestation and a wrong one (refused by the
kernel itself) both fail at exit 1; the captured unauthenticated fixture is CANNOT_DETERMINE at exit 2
with the host's verbatim words. The fence: a transcript carrying the real token plus a confident claim
of success, with no attestation recorded, is still FAIL, checked both behaviourally and by reading
`evaluateAttempt`'s own source to confirm it never dereferences transcript text. A separate block
exercises `evaluateAttempt` directly against constructed reports (no child process, microseconds) to pin
each of its four branches, and `--probe-only` is proved against the same fixtures the full canary uses.

---

## Prerequisites and limits

- `task-runner/` itself is pack-repo-only today (`install/_sources.js`'s `ADAPTER_FILES` places
  `interactive/`, `sdk-supervisor/` and `statusline/` as of P5-CT-4, but `task-runner/` stays out of
  scope for that wave, decision 2.7), so this runner is driven from the pack checkout against a target
  `--dir`. It builds on the now-installed `sdk-supervisor/cli.js`/`stream.js` either way.
- Run tasks **serially**. `hooks/spawn-guard.js` keys its wave counter on `session_id` at the project
  root, so two concurrent task sessions hold separate counters under one root and neither
  `index-guard`'s wave check nor the other session can see the other's wave.
- `claude --bg` stays a v2 option. The foreground stream-json loop is the invocation every anti-drift
  guarantee in this pack already has proof against.
- **`gates.only` scoping is not implemented** (P4-K-08). The declaration is recorded and the full gate
  runs.
- **The hooks now know they are in a task session (P5-T-16c), narrowed only.** With `RESPAWNPACK_TASK_ID`
  set, `session-routing-nudge` injects a one-line task-scope reminder instead of its full boot block
  (still recording the tree baseline unconditionally) and `stop-savepoint` never emits
  `decision:"block"`, only the same detection message on `additionalContext`. Detection itself, and the
  baseline, are unaffected in either hook — the variable narrows what gets printed or held, never what
  gets checked. When the baseline this narrowing leans on cannot be read (no git repository, or a
  malformed record), both hooks fall back to their pre-P5-T-16c behaviour and say so on the channel each
  already uses for a degraded read.
- The receipt has no reader in this tree yet. The hooks-and-install audit §6 names `stop-savepoint` and the next
  session as the intended consumers; both of those (P5-T-16c, P5-CT-7) gate on the *contract* rather
  than on this receipt, so neither needs it to do its job.
