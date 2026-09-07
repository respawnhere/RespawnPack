# `kernel/`: the state kernel

The executable behind RespawnPack's load-bearing checks. It exists because two dogfood runs proved the
same thing from opposite directions: **a verification step that lives in prose is a verification step
that does not run.**

Installs to `.claude/respawnpack/`. Zero dependencies, Node built-ins only, Windows + Linux.

## What it is answering

| Evidence | What happened | What the kernel does about it |
|---|---|---|
| DF-011 | `/savepoint` reported success and passed all five drift checks while `GAPS.md` said 50/110/66 against an actual 48/112/62. Every one of those numbers existed in machine-readable form; **not one was compared against it.** | Renders the derived docs from `STATE.json`, then parses every number back out and verifies it against the rows it came from. Disagreement is a `FAIL`. |
| DF-007 | Seven hand-rolled drift-checks failed in one session. Six shared one cause, asserting on the **rendered surface** (emphasis, case, line wrapping, quotation-vs-assertion) instead of content. Two returned `0` and read as confirmation. | Ships the helper instead of the checklist: `normalise()` before matching · `occurrences()` returning count **plus location**, never substring absence · `liveClause()` so a doc may quote what it retires · `discriminates()` to reject a check that answers the same for known-good and known-bad. |
| RA-5 | `validating 9 file(s) (0 content object(s)) … clean: 0 errors`. A validator reported clean while asserting against nothing. | Four outcomes, not a boolean. Zero parsed claims is `CANNOT_DETERMINE`, with its **own exit code**. |
| R-4 | Gates decided completion from hand-authored subsets, so omitting a requirement made a gate *easier*. | Gate denominators come from the approved requirement source. A declared id with no backing row is `INCOMPLETE_MISSING_ROWS` and the denominator does **not** shrink. |
| R-6 | Evidence bound to revision A kept crediting the project at revision B. | One shared evidence loader, revision-bound, so an individual tool cannot forget the rule. Every rejection reason is recorded. |
| R-3 | An implementation and its unit test encoded the same mistaken assumption; the passing test became a completion claim. | A high-risk row cannot reach `conformant` on implementer-qualified or development-grade evidence. It stops at `candidate`, a real status, not a synonym for done. |
| DF-001 / DF-008 | Memory had two readers and no guaranteed writer, so the store stayed empty across days of work, and stayed empty after being hand-seeded. | `savepoint` emits structured `memoryProposals`, making capture a **declined** action rather than an omitted one. |
| Scenario N | `quality-gate.yml` ran four steps, each with its own "else echo skipping" branch. On a non-Node repo every one skipped and the job reported **green**, a workflow named "quality gate" announcing success having run zero checks. | `gate` computes an outcome instead of printing messages: **PASS** (≥1 configured check ran and passed) · **FAIL** (a configured check failed) · **CANNOT_DETERMINE**, labelled **NOT_CONFIGURED** (stack detected, nothing meaningful could run) or **COULD_NOT_RUN** on a row whose tool would not start · **NOT_APPLICABLE** (**declared**, never inferred). Exit 0/1/2/0. Better skip wording would not have fixed it: a skipped shell step exits 0, and prose in a log has no exit code. |

## Verbs

```bash
node .claude/respawnpack/respawnpack.js gate               # the quality gate, as a computation
node .claude/respawnpack/respawnpack.js readiness          # the production-readiness checklist, found from the tree and scaled by the declared posture
node .claude/respawnpack/respawnpack.js state              # compile docs/derived/STATE.json
node .claude/respawnpack/respawnpack.js savepoint --verify  # check-only: verify rendered claims + adapters; touches nothing on disk
node .claude/respawnpack/respawnpack.js savepoint --verify --write   # also rewrite STATE.json + the derived docs
node .claude/respawnpack/respawnpack.js savepoint --verify --only compile,render,verify   # a PARTIAL savepoint — see below
node .claude/respawnpack/respawnpack.js savepoint --verify --skip memory,adapters    # the same run, minus two stages
node .claude/respawnpack/respawnpack.js savepoint --verify --only compile,reconcile  # DF-005: the task list vs the project's own gap/gate records
node .claude/respawnpack/respawnpack.js lineage             # Class D: does every declared derivation still match the source it names?
node .claude/respawnpack/respawnpack.js aar                 # Class C: the After Action Report for a window, bottom line first; --write creates it
node .claude/respawnpack/respawnpack.js status              # short current-state summary
node .claude/respawnpack/respawnpack.js doctor              # installed / configured / unsupported / stale / SILENTLY INACTIVE
node .claude/respawnpack/respawnpack.js site                # build the project's own documents into .respawnpack/site/
node .claude/respawnpack/respawnpack.js site --serve 8080   # …and read them at http://127.0.0.1:8080/ (loopback only)
node .claude/respawnpack/respawnpack.js reconcile           # DEPRECATED alias for the line above — same rows, same exit code, prints a deprecation notice
```

**Exit codes are three-valued:** `0` PASS · `1` FAIL · `2` CANNOT_DETERMINE. Add `--json` for a
machine-readable result, and read the exit status directly, never through a pipe (DF-007 #1 was an
`echo $?` that captured `tail`'s status instead of the tool's).

It **never pushes**, and commits only when explicitly told to.

## The ten savepoint stages (`--only` / `--skip`)

`savepoint` is ten subsystems in one verb, and until P4-K-08 the only way to run fewer of them was to
type a different verb: `removals` for one, `reconcile` for another, nothing at all for the other seven.
The verb list was never the unit of scoping; the stage is. They run in this order:

| stage | what it does |
| --- | --- |
| `compile` | recompile `docs/derived/STATE.json` in memory from the structured sources (this is where the removal scan and the reconciliation actually run) |
| `writeback` | verify the compiled state against disk by digest, or, with `--write`, verify the write by reading it back |
| `render` | migrate a hand-authored derived doc, plan the NOTE budget, render the three derived docs (`docs/derived/CONTINUITY.md`, `GAPS.md` and `LESSONS.md`) and (with `--write`) write them, then fold the wave ledger |
| `verify` | check every rendered claim back against its source, and the generated block against a fresh render |
| `removals` | the killed-feature contract's per-row verdicts |
| `lineage` | the provenance contract: every declared derivation's marker, checked against the source it names |
| `reconcile` | DF-005: the task list against the project's own gap/gate records |
| `coverage` | which optional contracts this project has configured, declared not applicable, or not decided |
| `adapters` | the project's own validator adapters, with their discriminating controls |
| `memory` | candidate-memory capture and the memory proposals |

`--only a,b` narrows the run to those stages and `--skip a,b` drops them; both are comma-separated and
both may be repeated. **Every posture profile's default is all ten.** ADR-003 assigns no stage to a
profile, because a profile changes which outcome a row returns and never which checks ran.

⛔ **A partial run can never be mistaken for a full one.** Every stage that did not run emits a
`stage:<name>` row at `NOT_APPLICABLE` whose detail reads **SKIPPED BY REQUEST**, the text output leads
its verdict with a `PARTIAL SAVEPOINT` line, and the receipt records `stages: {requested, ran, skipped}`.
The exit code follows the rows that ran, which is the reason the skips are printed rather than inferred
from a shorter list. Anti-drift item 14 holds per stage: skipping `removals` on a tree with a populated
registry prints the skip and **never** a `PASS`, because a scan that did not happen is not a clean scan.

⛔ **A partial run withholds its `sourceRevision` from the receipt.** `hooks/stop-savepoint.js` reads
exactly `exitCode === 0` plus a `sourceRevision` inside HEAD's chain to conclude the closeout is done. A
scoped run can exit 0 having checked two stages of ten, so it does not offer that pair. The claim is
withheld, not caveated, the same discipline `stateFreshness` applies to counts. Nothing is hidden:
`stages` records exactly what ran and `head` still records where.

⛔ **`compile` is required and is never implied.** Every later stage reads the freshly compiled state, so
`--skip compile` (or an `--only` set omitting it) is **refused at exit 2**, rather than run against
whatever `STATE.json` was already on disk. An **unknown stage name is refused at exit 2** too, naming the
valid set; nothing runs and no receipt is written.

## The `check`/`outcome` row contract

Every row every verb emits, `savepoint`, `removals`, `lineage`, `reconcile`, `living`, `gate` and
`doctor` alike,
is built by `result()` (`kernel/lib/outcome.js:34-47`) and shaped
`{ outcome, check, detail, checked, ...extra }`. There is no `id` field, no `status` field and no
`component` field on any of these arrays; do not read for any of them.

- **`outcome`** is the four-value vocabulary: `PASS` · `FAIL` · `CANNOT_DETERMINE` · `NOT_APPLICABLE`.
- **`check`** is the stable, parameterised id, `<subsystem>[:<parameter>]`: for example
  `rendered-claims:docs/derived/CONTINUITY.md`, `memory-capture:operator`, `note:budget:<file>`.
- **`detail`** is the human-readable explanation of the verdict.
- **`checked`** counts how many subjects the row actually examined, `null` when a check declares no
  subject count. The one rule `result()` enforces: a `PASS` whose `checked` is present must be a
  positive finite number, so a check that examined nothing cannot pass silently.
- **`domain`** says which question the row answers, from `integrity` · `coverage` · `install` · `gate`.
  Never a severity and never a softener: it groups rows, it does not rank them. A domain outside those
  four is refused by `result()`, because a misspelled tag files a row under a heading nothing reads.
- **`subject`** is *what* the row looked at: the file, the command, the declaration.
- **`label`** is the emitting subsystem's own richer word for the same verdict (`NOT_CONFIGURED`,
  `COULD_NOT_RUN`). A **display** field, and only that: nothing derives an exit code, a rollup or a
  refusal from it. It exists so that unifying the vocabularies costs no diagnostic precision, and that
  precision is why `gate` and `doctor` grew private vocabularies, and it was worth keeping.

`domain`, `subject` and `label` ride along only when the emitting check supplies them, so a row's key
set stays exactly what its author chose to say.

`rollup(checks)` (`kernel/lib/outcome.js:65-67`) is the single verdict authority: the worst outcome among
a set of rows wins, with no averaging, and `rollup([])` is `CANNOT_DETERMINE`, because running nothing
determines nothing. Every verb that reports one verdict computes it by calling `rollup` over its own
`checks[]`; `cmdSavepoint`'s `outcome` is exactly `rollup(checks)`.

Exit codes are the same split everywhere (`exitCodeFor`, `kernel/lib/outcome.js:74-76`): `PASS` and
`NOT_APPLICABLE` exit `0`, `FAIL` exits `1`, `CANNOT_DETERMINE` exits `2`. "Could not run" never
collapses into "failed".

A row may also carry `ephemeral: true`, for example `note:budget:<file>` (`kernel/lib/render.js`), when
its full content is already archived verbatim elsewhere. `ephemeral` changes nothing about the outcome or
the exit code; it only means that when the row is `FAIL`, `runCandidateCapture` (`kernel/respawnpack.js`)
skips it instead of minting a candidate memory, because capturing it would duplicate the archive rather
than record a new lead.

**`gate` and `doctor` both emit this shape, and neither keeps an exit map of its own.** Each holds one
table mapping its own richer word to a shared outcome; the exit code comes from `exitCodeFor` like every
other verb's. Neither mapping moved a single exit code when it replaced the private table it came from.

A **gate** row is `{ outcome, check, detail, checked, domain, subject, label }` with the check's own
planning facts (`name`, `profile`, `root`, `configured`, `bin`, `args`) beside it: `check` is
`gate:<root>:<name>`, `domain` is `gate`, and `label` carries the gate's own word. The mapping
(`kernel/lib/gate.js` `LABEL_OUTCOME`) is `PASS` → `PASS`, `FAIL` → `FAIL`, `NOT_APPLICABLE` →
`NOT_APPLICABLE`, and both `NOT_CONFIGURED` and the row-only `COULD_NOT_RUN` → `CANNOT_DETERMINE`, at
the exit 2 they always had.

A **doctor** row is the same seven fields: `check` is the component identifier it always was
(`hook:index-guard.js`, `state:STATE.json`, `onboarding:removals`), `label` is doctor's own word,
`checked` is 1 because a doctor row is one component's verdict, `subject` is the project-relative path
the row inspected (`.claude/hooks/index-guard.js`) or the declaration that decides it
(`respawnpack.config.json`), never a restatement of the id, and `domain` is `install` except for
`state:STATE.json`, which is `integrity`, and the decision rows (`onboarding*`, `posture`, `exceptions`,
`projectType`, `state:requirements`, `state:evidence`, `removals:contract`, `lineage`, `reconcile:tasks`), which
are `coverage`. `subagents` stays `install`: there is no declare-or-not state for a ceiling that always
applies, so it reads like a hook row (`ACTIVE`/`BROKEN`) rather than joining that list.
The mapping (`kernel/respawnpack.js` `DOCTOR_OUTCOME`) reproduces the old `GREEN` allowlist exactly:

- `ACTIVE`, `CONFIGURED`, `CURRENT`, `COMPLETE`, `INSTALLED` → `PASS`
- `NOT_CONFIGURED`, `NOT_APPLICABLE`, `UNSUPPORTED` → `NOT_APPLICABLE`, green, and still not a claim
  that anything WORKS: each means the check had no subject here
- `BROKEN` → `FAIL`
- everything else → `CANNOT_DETERMINE`, at the exit 2 it had. The fallthrough is the point: `SILENTLY
  INACTIVE`, `STALE`, `UNKNOWN`, `INCOMPLETE`, `UNDECIDED` and `INVALID` are absent on purpose, and so is
  the next word somebody adds, until they classify it deliberately.

Doctor still prints its own word at the head of each line, because that word is the diagnosis an
operator acts on; the `outcome` beside it in `--json` is the one the exit code came from.

## The declared posture, and which rows it can move

The kernel reads the project's `posture` block through `hooks/_posture.js`, the same one reader the
hooks use, reached cross-tree because the kernel may require from `hooks/` and not the other way round.
`doctor` carries a `posture` row naming the profile and where it came from. A profile changes **which
outcome a row returns**, never what an outcome means and never the 0/1/2 exit map, and never which
checks ran: ADR-003 assigns no savepoint stage to a profile.

**Ten kernel rows are reachable at all**, and each is asked for by its `kernel:R<n>` id:

- **Six coverage rows** the applicability survey owns, `R1` (routes), `R2` (`codeTruth`), `R3`
  (an unconfigured removals contract), `R4` (reconciliation), `R5` (the quality gate) and `R6`
  (onboarding). Under `light` or `standard` these return `PASS` with `checked: 1` and a recorded
  `postureRelaxed` marker instead of `CANNOT_DETERMINE`. `R3` and `R4` instead return
  `NOT_APPLICABLE` with an authored reason naming the posture, and only where the absence is free of
  inference: no registry file at all, or `reconcile.js` not installed by the profile. The moment a
  `removals.json` with rows exists, `R3` is mandatory in every profile.
- **Four non-coverage rows.** `R9` is the quality gate that found no build system, `NOT_APPLICABLE`
  under `light` and `NOT_CONFIGURED` otherwise; it is the one that does not relax to `PASS`, because
  that branch ran zero commands and `result()` refuses a `PASS` whose `checked` is zero anyway. `R15`
  is the over-budget NOTE, relaxed under `light` in both modes and under `standard` only on a
  verify-only run, because a writing savepoint has already cut the note. `R16` is a hand-authored
  derived doc not yet migrated, relaxed under `light`. `R17` is a `--candidate` klass outside the four,
  relaxed under `light` and `standard`.

**And one row arrives by amendment rather than by number.** `kernel:readiness` is the production-readiness
checklist (`readiness`, below), added to ADR-003's rule table by a dated amendment because the accepted
table is carried verbatim and is not rewritten to admit a later row. It reads `advise` under `light` and
`standard` and `deny` under `strict`, and it is the one relaxable row whose id is a word rather than an
`R<n>`.

**The reason is never lost.** A relaxed row keeps its explanation in `detail`: the empty search is
reported first, ahead of the posture that answered it. A relaxation is a different verdict on the same
finding, not a silence.

**Everything else is unreachable by construction.** `hooks/_posture.js` carries **no key** for the
sixteen fixed kernel rows, so an override naming one makes the whole declaration invalid rather than
being quietly discarded. The nine whose relaxation would forge a green (`R10` to `R14`, `R18`, `R21`,
`R22`, `R24`) and the seven with no false-positive class at all (`R7`, `R8`, `R19`, `R20`, `R23`,
`R25`, `R26`) are both in that set. `R27` and `R28` are build-time schema fences over this pack's own
registry, with no runtime column for a posture to speak about.

## The declared exceptions, and their doctor row

Beside `posture` sits a second, independent declaration in the same founder-owned
`respawnpack.config.json`: a tracked `exceptions` array, each entry naming one reviewed SUBJECT a guard
already denies, never the guard's verdict (ADR-004, a development record). The kernel
reaches `hooks/_exceptions.js` cross-tree the same way it reaches `hooks/_posture.js`, and `doctor` carries
a coverage-domain `exceptions` row subject to `respawnpack.config.json`: NOT_CONFIGURED when the list is
absent or empty (keyed on the list being empty rather than on the source, unlike the `posture` row,
because "nobody declared" and "declared nothing" are the same fact here), CONFIGURED naming the count and
every id read, and BROKEN when the list is UNREADABLE or INVALID or the reader itself could not be
loaded. An entry that has expired is kept in the count rather than dropped, so the row can say "3 declared
(1 expired)" instead of leaving a founder to believe a stale allowance still lifts something. This row
moves nothing else: no kernel row and no fixed hook rule is reachable through it, exactly as `posture`
cannot reach one either.

## The declared project type, and the subagent ceiling (P2-I-3)

Two more rows sit beside `posture` and `exceptions`, for the same reason: a founder's declaration and
the mechanics it drives should be readable in one report, not something a reader has to reconstruct from
`install/install.js` or `hooks/spawn-guard.js` by hand (Class B, "intent over mechanics").

**`projectType`** reports what `respawnpack.config.json`'s `projectType` key drops from CLAUDE.md's
managed block — the ONE thing that key does today. `CONFIGURED <type>` names the section(s) the installer
drops for it (`docs-only` and `ops-infra` drop `performance`; `greenfield-app` and `mature-product` drop
nothing and compose the block in full). `NOT_CONFIGURED` is an absent key or an unparseable config alike
— install.js's own rule for `projectType` is that a config nobody could read is a THIRD state, not a
refusal, so the block composes exactly as it does for a project that declared nothing. `BROKEN` is a
declared value outside the four the installer knows, because the installer already refused to write the
block over it; a green row here would call that refusal a default. The drop table respawnpack.js prints
from (`DOCTOR_PROJECT_TYPE_DROPS`) is a RESTATEMENT of install.js's own `PROJECT_TYPE_DROPS`, not a live
read of it — install.js is a script with side effects from its first lines, not a library, so requiring
it would run an install rather than import a table. `kernel/kernel.test.mjs` fences the restatement
against install.js's real table from source text instead, so the two cannot drift apart silently.

**`subagents`** reports `hooks/spawn-guard.js`'s own two inputs — `_posture.verdict(resolved,
'spawn-guard:ceiling')` and the `.respawnpack/spawn-guard.strict` marker — as `ACTIVE ceiling <N> ·
<verdict> under <profile> (<source>) · marker <present|absent>`, then a plain sentence naming whether a
dispatch above the ceiling would actually be DENIED or only ADVISED today. Those two can disagree on
purpose (owner decisions 26, 28): `_posture.verdict` answers `deny` for the `strict` profile regardless
of why the resolution landed there, but spawn-guard's hard deny arms only from a genuine **DECLARED**
strict — `DEFAULTED`, `UNREADABLE` and `INVALID` all resolve to the same `strict` profile for every
*other* reader's fail-closed reasons, and leave this ceiling exactly as advisory as it was before a
posture existed to declare. The marker is the one thing that tightens regardless of source: present, it
forces a deny under any posture, and nothing loosens a declared strict back to advisory. There is no
declare-or-not state here — a ceiling always applies, at 8 or at `RESPAWNPACK_SPAWN_CEILING` — so the row
reads `ACTIVE`/`BROKEN` like a hook row rather than joining `posture`'s three-way trio. The ceiling
formula, the marker path and the DECLARED-only condition are restated from spawn-guard.js's own source
for the same reason `projectType`'s table is: they are small expressions in a hook file, not exported
members doctor could import, and `kernel/kernel.test.mjs` fences all three against that source directly.

Neither row moves an exit code by declaring or changing what it reports — both are green
(`ACTIVE`/`CONFIGURED`/`NOT_CONFIGURED`) in every state but `BROKEN`, which follows doctor's usual
convention for a declared-and-wrong value.

## The readiness checklist (`readiness`, P2-Q-2)

`gate` asks whether this project's own checks pass. `readiness` asks the question one layer out: are the
things a releasable repository has actually here. Sixteen items, each with an id, a tier and a remedy,
and **each one FOUND from the tree rather than declared**: a README, a CI workflow, a test command,
secret scanning in CI, a filled CODEOWNERS, a LICENSE, a lockfile, ignored env files, plus the
archetype's own — a Terraform remote state backend, no plaintext credential in a `*.tfvars` or an
inventory, vaulted inventories, a health route, a migrations directory, error tracking, a documentation
index and a link check.

**An item that does not apply here is not a row.** Four archetypes install this pack and the readiness
question is a different question in each: a remote backend is meaningless in a documentation tree and a
link check is meaningless in a Terraform one. `applies(ctx)` decides from the evidence in the tree —
`package.json`, `*.tf`, an inventory, a `Dockerfile`, a `*.sh`, a markdown-only tree — using this
module's own detection rather than `gate.js`'s planners, because "what can I run here" and "what kind of
repository is this" are different questions and a docs tree has an answer to only one of them.

**Zero applicable items is `CANNOT_DETERMINE`, never a pass.** A tree nothing was recognised in has not
been found ready; it has been found unrecognisable, and `readiness:applicable` is the row that says so
at exit 2.

**The declared posture scales the list.** ADR-003's `kernel:readiness` reads `advise` under `light` and
`standard` and `deny` under `strict`. Under `deny` the full list runs and a `FAIL` fails the verb. Under
`advise` `light` asks the essential tier and `standard` the full one; **every row is still printed**, a
`FAIL` becomes `PASS` with `postureRelaxed` and the reason it would have failed still first in `detail`,
and the verdict line says how many items would fail under `strict`. A full-tier item under `light` is
still a row — `NOT_APPLICABLE`, naming the profile and the ADR row that scoped it out — because an item
that vanished would be the silent skip this kernel refuses everywhere else. A check that could not run
stays `CANNOT_DETERMINE` in every posture: a posture answers for a question nobody asked, never for a
file nobody could read.

**An item is excepted by name, in the one grammar that carries one.** `{"rule": "readiness", "match":
{"item": "error-tracking"}, "reason": "…"}` in `respawnpack.config.json`'s `exceptions` list, read by
`hooks/_exceptions.js`. The row becomes `NOT_APPLICABLE` with `allowed by exception <id>: <reason>`, in
**every** posture including `strict`, and the remedy is still printed. There is deliberately no
`readiness.skip` key, no marker file and no `--skip` flag: a second opt-out grammar is a second thing to
review, and the one that gets reviewed is the one the diff carries.

`doctor` carries a `readiness` row saying how many items apply and how many are failing under the
current profile; it is `ACTIVE` (green) even when items fail, because doctor answers "is this
installation sound" and the verb is what exits 1 on an unmet item. `NOT_CONFIGURED` is the row for a
tree with no applicable items. `/ship` Step 1 cites the verb as the pre-ship gate.

## What a project provides

All optional. A project that tracks no requirements gets `NOT_APPLICABLE`, not a failure.

```
docs/derived/state/requirements.json   the APPROVED denominator: requirement rows + gate declarations
docs/derived/state/evidence/*.json     revision-bound qualifying artifacts
docs/derived/state/goal.json           goal, milestone, constraints, killed features, current atomic task
docs/derived/STATE.json                ← GENERATED. Never hand-edit.
```

Project-specific validators are **called, not reimplemented**. one project's `tools/validate.py` and
another's `tools/verify_docs.py --verify` know things this pack never will:

```json
{ "state": { "adapters": [
  { "name": "verify-docs", "command": "python", "args": ["tools/verify_docs.py", "--verify"],
    "critical": true,
    "controls": { "good": ["--self-test-good"], "bad": ["--self-test-bad"] } } ] } }
```

⭐ `critical: true` **demands controls**. A critical validator that cannot be shown to answer differently
for a known-good and a known-bad input has its verdict discarded as `CANNOT_DETERMINE`. DF-007 #7 was
exactly a check that returned the same answer for both and was believed anyway.

The quality gate (`gate`, above) finds its own presets the same way, from evidence already in a
project's tree, never asserted: Terraform (`*.tf` at a root, planning `terraform fmt -check -recursive`
and `terraform validate`, plus `tflint` only when `.tflint.hcl` says the project has adopted it), Ansible
(`ansible.cfg`, or a playbook beside an inventory directory, planning `ansible-lint`), shell (`*.sh`
outside `node_modules` and `.git`, planning `shellcheck` over the files found), Docker (`Dockerfile*`,
planning `hadolint` over the Dockerfiles found), Kubernetes (`kustomization.yaml`, planning `kubeconform`
when it is on PATH, else `kubectl kustomize`) and documentation (`.markdownlint*`, planning
`markdownlint`) join Node, Python, Go and Rust. A check is `configured: true` when the tool's own config
file exists at the root **or** its binary resolves on PATH: `ansible-lint`, `shellcheck` and `hadolint`
accept either; ESLint/Prettier (Node's fallback when there is no `lint` script) and `markdownlint` need
**both** their config and a local `node_modules/.bin/` binary, because an npm-ecosystem tool is a
devDependency, not a system package that one config file alone proves installed. Neither half is ever
inferred: a config with no working tool stays `configured: false`, naming both absences, never
`COULD_NOT_RUN` dressed as a gate.

## Task reconciliation (DF-005)

The harness task list and a project's own gap/gate records **drift independently, wrong in both
directions at once**: a task nobody wrote a gap for, and a gap no task tracks, coexisting while every
surface that reads either one reports confidently. `savepoint --only compile,reconcile` compares them,
and an unscoped `savepoint` runs the comparison whether or not either verb is ever typed; its verdict is
compiled into `STATE.json`, and `doctor` carries a `reconcile:tasks` row.

⛔ **`reconcile` is now an alias for `savepoint --only compile,reconcile` (K-12), not a second caller of
the comparison.** It prints one deprecation line to stderr naming the replacement, then reports the
identical rows and exit code: both read `reconciliation` off the same `stateLib.compile(DIR)`, so the
two mechanisms cannot compute two different answers to "do the lists agree." The alias deliberately
reports the **unrelaxed** verdict, though, because `savepoint`'s stage additionally lets a DECLARED
`standard`/`strict` posture advise or deny an unconfigured reconciliation (ADR-003 kernel:R4), and
folding that into the alias would have moved its exit code for every already-postured project the day
this shipped, over a declaration the alias's own contract never mentioned. Script against `savepoint
--only compile,reconcile` directly; `reconcile` keeps working either way.

The pack assumes **no task system**. Both sides are declared, using the same adapter philosophy as the
validators, and `requirements` reads the kernel's own approved denominator, so the common case needs no
adapter at all:

```json
{ "state": { "reconcile": {
  "tasks":   { "kind": "json", "path": "docs/tasks.json", "pointer": "tasks" },
  "project": { "kind": "requirements" },
  "ignore":  [ { "id": "T-9", "reason": "tracked in the upstream vendor tracker" } ] } } }
```

Source kinds are `requirements`, `json` (a declared project-relative file plus a dotted pointer) and
`adapter` (the project's own tool, whose JSON is interpreted, never reimplemented). JSON sources must
remain inside project authority after realpath; absolute paths, parent traversal, and symlink escapes
are `CANNOT_DETERMINE`, not data the project silently trusts. Statuses map through
`openStatuses` / `closedStatuses`; an **unmapped** word is never guessed, because guessing "probably
open" lets a typo silently close a gap.

⛔ **Reading zero task records, or zero project records, can never be `PASS`.** Two empty lists agree
perfectly and mean nothing was checked. Outcomes: `PASS` · `DRIFT` (exit 1, naming every drifting
identifier by class) · `NOT_CONFIGURED` · `NOT_APPLICABLE` (**declared, with a reason**) ·
`CANNOT_DETERMINE`. A declared exclusion is always **reported**, because a silent exclusion is an unaudited
one, and boot summarises an established drift **without** the project's task records themselves ever
entering the durable projection.

## Declared schemas

Every machine-readable state artifact this pack writes or reads has a declared JSON Schema under
[`schemas/`](../schemas/) in the pack repository, with [`schemas/registry.json`](../schemas/registry.json)
mapping each family to its schema, path pattern, durability, writer and readers.

⛔ **They are not installed into a target, and they are not a second validator.** The procedural loaders
in `lib/` remain the production validators; the schemas are normative declarations verified by this
repo's own tests, so the zero-dependency runtime gains nothing to carry and no second interpretation of
any format exists. What the schemas answer is the question procedural validation cannot: not "did this
loader accept this document" but "what *is* the format".

## What `doctor` can and cannot diagnose about itself

`doctor` reports on installed artifacts, and three files load before it can report on anything. A defect
in one of these is a raw crash, not a row, and nothing here claims otherwise:

| file | why it cannot be diagnosed |
|---|---|
| `respawnpack.js` | the entry point, which cannot report its own parse failure |
| `lib/outcome.js` | the outcome vocabulary and exit-code mapping every row is expressed in |
| `lib/modhealth.js` | the classifier that decides what BROKEN means |

**That is the whole bootstrap.** Every other kernel subsystem (`state`, `render`, `gate`, `removals`,
`lineage`, `aar`, `closeout`, `memory`, `living`, `assert`, `reconcile`, `applicability`, `readiness`, `site`) is loaded lazily through
`modhealth`, so a corrupt one is a named `BROKEN` row with the rest of the report intact.
`hooks/_manifest.js` is deliberately outside the bootstrap too: it lives in the other installed
directory and is probed, never required outright.

**One subsystem may be absent on purpose, and that is a different row from a broken one.** The installer
places 17 kernel files under `strict` and `standard` and 16 under `light`: ADR-003's rule table reads
`kernel:R4 reconcile → n.a., not installed` in the `light` column, so a project that declares that
posture does not receive `lib/reconcile.js`. `doctor` reports it as `NOT_APPLICABLE`, naming the profile and the ADR row that withheld it, in the `kernel-lib:`, `reconcile:tasks` and
`onboarding:reconcile` rows alike, and `savepoint` reports the reconciliation coverage row as
NOT_APPLICABLE rather than refusing. The same file missing under a posture that carries the contract is
`BROKEN` exactly as before, at exit 1. `lib/living.js` and `lib/memory.js` are **not** gated: ADR-003's
table carries no row for either, and ADR-002 puts file-backed memory in the core, so both are placed
under every posture. `lib/state.js` and `lib/applicability.js` therefore probe the reconciler through
`modhealth` instead of requiring it, so an absence a profile chose can never arrive as a stack trace.

⛔ **The previous version of this guarantee was stated one layer too broadly.** Each of doctor's blocks
was wrapped in a guard, and that guard sat *after* the unconditional top-of-file requires it was meant
to protect, so a corrupt installed `lib/memory.js` killed the process during module load, before argv
was parsed and before a row existed. A guard placed after the failure guards nothing.

Two other narrowings worth knowing when reading a report:

- **Hooks are compiled, never evaluated.** A shared library does nothing at module scope, so loading it
  is a safe way to ask whether it loads. A hook is operational (it reads stdin and emits allow/deny
  decisions), so its verdict is its own source parsing plus the health of every module it transitively
  requires. A hook whose module scope throws only when *executed* is reported ACTIVE, and establishing
  otherwise would mean running it.
- **The expected hook set is the union of the installed wiring and the hooks directory.** Neither alone
  suffices: a directory listing cannot report a deleted file, and the wiring cannot see an installed
  hook nothing references. Only commands naming a file inside `.claude/hooks/` count, so a target's own
  tooling (`node tools/theirs.js`, an npx call) is never turned into a RespawnPack failure.

## The browsable record (`site`): a projection, served on loopback

`site` builds the project's own tracked documents into a static site and, with `--serve`, puts it on
`127.0.0.1`. Inputs are every `.md` under `docs/` and `memory/graph/` plus the root `README.md`, which
is what carries the derived documents, the AARs under `docs/derived/aar/` and the lessons register along
with everything else. Output goes under `--out`, default `.respawnpack/site/`, which is gitignored.

- **It is a projection, and that is the whole design.** The build reads tracked documents and writes only
  under its output directory: it edits no tracked file, offers no editing surface, and is rebuilt rather
  than amended. There is no wiki and no second place a fact could live. An `--out` inside a directory the
  build reads (`docs/`, `memory/graph/`) or one that contains the project is **refused** at exit 1 with
  the reason; an `--out` outside the project is allowed, which is what the flag is for. A page whose
  document has been deleted is removed on the next build, so the output can never carry a document the
  repository does not have.
- **A rebuild of an unchanged tree is byte-identical.** Nothing written carries a timestamp, an absolute
  path or a machine-dependent ordering, which is what makes two builds comparable and what forbids the
  renderer from reading a clock.
- **The dashboard obeys the freshness rule every reader obeys.** `state.html` never opens
  `docs/derived/STATE.json`; it asks `hooks/_runtime.js`'s `readDurableState`, the same two-part
  revision-and-content check the SessionStart hook, `status` and `doctor` share. **CURRENT** renders the
  goal, the milestone, the counts, the blockers and the next unblocked work. **STALE**,
  **CANNOT_DETERMINE** and an absent projection each render the banner with its reason and **withhold
  every number** — withheld, never caveated, because a number printed beside a warning is still a number
  the next reader quotes. The verb's `state:STATE.json` row is CANNOT_DETERMINE in exactly those cases,
  the same verdict `status` returns from the same reader.
- **One stylesheet, inline in every page.** System fonts (nothing is downloaded), an 80-character
  measure, table and code styling, and a print rule that drops the navigation. No stylesheet file is
  written, so a page saved or mailed on its own still reads.
- **Diagrams are drawn by the reader's browser, from one pinned script.** A Mermaid fence renders as a
  `<pre class="mermaid">` block plus a collapsed `<details>` holding its source, and the page loads one
  pinned CDN URL — a constant in `lib/site.js`, emitted **only** on pages that carry a diagram, with a
  `<noscript>` note beside it. The pack never fetches it and vendors nothing (owner decision 20), so a
  reader offline loses the picture and keeps the diagram's source.
- **`--serve` binds `127.0.0.1` and nothing else.** Not `0.0.0.0`, not `::`, not `localhost` (which can
  resolve to `::1`): any other host is refused before a socket exists. It answers GET and HEAD only,
  serves the output directory read-only with the right content types, refuses path traversal in every
  spelling, executes nothing, reads nothing outside the output directory, prints its URL, and stops on
  Ctrl-C. `--serve` takes an optional port; `0` (the default) asks the OS for a free one.

## Maturity

`implemented and behavior-tested`. `kernel/kernel.test.mjs` (429 tests) runs on both CI platforms and
reproduces acceptance scenarios C, E, F, G, H, I, K, L, N, O, P and Q from real dogfood failures. That count is
mechanically fenced by `counts-fence.test.mjs`, because it has now drifted seven times: 32 claimed
against 38, 49 against 64, 64 against 67, 67 against 81, 81 against 97, 97 against 110, 110 against 121.
Every time, the fence caught it. Inside the layer whose whole argument is that hand-carried numbers rot,
they kept rotting, which is the case for the fence, not against it.

## Living skills (`living`): three canaries, opt-in

`lib/living.js` implements the lifecycle `spine/reference/living-skills.md` had documented and nobody
had built: enable, regenerate, drift-detect, reset. It is **opt-in per project** and proven on exactly
`debug`, `savepoint` and `knowledge`. Every other skill is a **STATIC skill**, a complete supported
state, not a missing feature.

⛔ **No manufactured baselines.** Enabling FREEZES the skill already on disk as its `SKILL.base.md`;
the pack ships no new baseline files. ⛔ **The overlay is derived or it is nothing**: every learned line
traces to a memory entity declaring `applies-to|skill:<name>` and carries that entity's date, confidence
and source path. Regeneration is deterministic and budget-capped, and what the budget dropped is
reported. An unreadable memory source is `CANNOT_DETERMINE` and leaves the previous overlay alone.
"We found nothing" and "we could not look" must not render the same document.

## The exit from autonomy (`contract complete`)

`lib/closeout.js` is the transition the pack never had. Contracts could be ENTERED and SUSPENDED and
never mechanically COMPLETED, so a finished delegation stayed in delegate mode across sessions and a
goal whose criteria had all become MET stayed the project's `ongoingGoalId`. The asymmetry between the
two closures is deliberate, because the two kinds of criteria are different in kind:

- **Goal completion is mechanical.** It is REFUSED while any stated criterion is `UNMET` *or*
  `CANNOT_DETERMINE`, with distinct exit codes. A goal written with free-text criteria therefore cannot
  be closed by this command, which is the correct outcome, not a gap. On success the contract is archived with
  its qualifying revision and per-criterion evidence; only `ongoingGoalId` is cleared.
- **Delegate completion is an attestation, and is recorded as one.** Acceptance criteria are prose
  nothing here can evaluate. What *is* mechanical: every recorded criterion must be restated with
  `--met`, so "I finished it" cannot be said in the abstract.

A delegation that suspended a goal hands it back when it closes; `--met` always means `delegate`, so an
idempotent retry cannot land on the goal it just restored.

## The killed-feature contract (`removals`)

`lib/removals.js` is Scenario L: the structured removal contract that "⛔ killed features are never
re-added" never had behind it. A removal is a row with an id and the **forbidden live assertions** whose
presence means it is back; the scan reads **every configured live-content directory** (the
run-A defect was a scanner that globbed one folder and reported success for the project); and
naming a retirement is not making one, so a history section, a blockquote, a struck line, a declared
history path, and a sentence using the retirement vocabulary all pass. Every row is probed with a
known-bad and a known-good control before its verdict counts, and a row whose phrase cannot discriminate
stops at `unverified`, never `clear`.

⛔ **Declared, never inferred.** Zero configured directories or an empty registry is `CANNOT_DETERMINE`,
not a pass. A project with genuinely nothing retired says so with
`"removals": { "notApplicable": true, "reason": "<why>" }`, exactly as reconciliation and the quality gate require. Legacy configs that stored the reason directly in `notApplicable` remain readable. `respawnpack doctor` reports the contract per install, so an unenforced absolute is
visible rather than assumed.

## The provenance contract (`lineage`)

`lib/lineage.js` is Class D: anything cloned, copied, migrated or regenerated has a source, and a project
usually has an opinion about which source is the truth. `docs/derived/state/lineage.json` is where that
opinion is written down, by the founder or the planner and never by this pack: `sources` (an id, a `kind`
among inventory, iac, template, schema, dataset and doc, a `path` or a `url`, and `authority:
source-of-truth`) and `derivations` (an id, a target path or glob, the source ids it may come `from`, a
`how` among clone, copy, migrate and generate, an optional `neverFrom` list and an optional `required`).

⛔ **A marker is verified, never trusted.** A derived file records its own provenance as
`respawnpack-derived-from: <sourceId>@sha256:<digest of the source at derivation time>`, anywhere in its
first 40 lines in whatever comment syntax it uses, or in a `<target>.lineage.json` sidecar for a binary
or generated tree. `lineage` recomputes the digest from the source on disk, so "it says it came from the
inventory" is not evidence and "it says so, and the inventory still hashes to what it recorded" is. A
glob target checks every matching file, because one unmarked file in a generated tree is the whole point.

Per derivation, `lineage:<id>` is **FAIL** when a marker names a source the derivation declares it must
never come from (the detail names both the source the marker claimed and the sources the derivation
allows), or when the source has moved since the derivation; **CANNOT_DETERMINE** when the target is
absent and not `required`, when the marker is missing or unparseable, when the source cannot be read, or
when the source is a URL this pack cannot digest without a network call it never makes; and **FAIL** for
an absent target the derivation declares `required`.

⛔ **No declaration at all is `NOT_APPLICABLE`, at exit 0, and it is not a seventh onboarding contract.**
`doctor` reports `NOT_CONFIGURED` with the remedy, the savepoint stage emits a `lineage:declaration` row
saying so rather than nothing at all, and `onboarding` stays whatever it was. Making an absent declaration UNDECIDED would flip every installed target's
onboarding row to INCOMPLETE on upgrade and move exit codes under `strict`, which is a new contract
retroactively failing projects that have never heard of it. Adding the row to `lib/applicability.js` is
the reversal, on the day it should be asked in the interview.

⛔ **`lineage seed` proposes, and never infers a verdict.** It scans the project root and one level down
for the files a project's truth usually lives in: a Terraform root (a directory whose `*.tf` files
declare a `terraform {` or `provider "` block), an Ansible control config and its inventories
(`ansible.cfg`; every file under `inventory/`, or named `hosts*`), compose files, a Kustomize overlay, a
Pulumi project, an OpenAPI or Swagger document, a Prisma or SQL schema, and the Node package manifest.
Each is proposed as a `sources[]` row with a stable id, its `kind`, and a `note` naming the evidence that
proposed it. It never proposes a `derivations[]` row: which file derives from which is the founder's own
knowledge, not something a directory listing can recover, so a proposal's `derivations` is always `[]`.
`respawnpack lineage seed` prints the proposal, the evidence per row and the count; a repository with
nothing to propose says so at exit 0. `--write` writes it to `docs/derived/state/lineage.json` only when
no such file exists yet, atomically, and refuses at exit 2, naming the existing file, otherwise: this
never overwrites a founder's own declaration. A symlinked or unreadable candidate is reported in the
evidence as skipped, never silently dropped.

⛔ **`lineage stamp <target> --from <sourceId> [--sidecar]` writes the marker `seed` never does.** It
refuses, before a byte moves: a `from` naming no source `docs/derived/state/lineage.json` declares
(**CANNOT_DETERMINE**, naming the ids that ARE declared); a `from` any derivation covering `<target>`
lists in its `neverFrom` (**FAIL**, naming that derivation — the guac case, caught here rather than only
reported after the fact); a `<target>` that does not resolve inside the project or does not exist yet
(**CANNOT_DETERMINE** — stamp records where a file came from, so the file has to exist first). Anything
else writes: a one-line comment in `<target>`'s own syntax, chosen by extension (`#` for sh/py/rb/yml/
toml/tf/tfvars/ini/cfg/conf/env, `//` for js/ts/go/rs/java/c/cpp/json5, `<!-- -->` for md/html/xml/svg,
`--` for sql/lua/hs, `/* */` for css/scss), inserted after a shebang or a first-line XML/DOCTYPE directive
when one is there, else at the top; an extension this module does not know, or `--sidecar`, writes a
`<target>.lineage.json` sidecar instead, `{sourceId, sourceDigest, stampedAt}`. Both forms go through the
kernel's `writeAtomic`. **An existing marker for the same target is REPLACED, never duplicated** — the
same `MARKER.lines` window `checkLineage` scans is the window `stamp` searches before deciding whether to
insert or overwrite in place. The report names the digest it recorded, the one `checkLineage` will
recompute against on every later run.

**Also not implemented here:** the goal-mode task scheduler and stack-aware CI selection.

## The After Action Report (`aar`)

`lib/aar.js` is Class C: the pack writes down a great deal that is true and asks a person to reassemble
it themselves. This verb assembles it instead, into one document with its bottom line in the first
paragraph, and composes nothing it did not read somewhere: the compiled state at each end of the window,
the commits, the derived changelog entries dated inside it, and (labelled machine-local, because they
live under `.respawnpack/` and describe this machine) the last savepoint receipt, the candidate journal
and the delegation archive.

**The window.** `--until` defaults to HEAD. `--since` defaults to the `until` revision recorded by the
newest report already under `docs/derived/aar/`, else the base of the current savepoint-only commit
chain, else the root commit. Every one of those defaults is stated in the document, because a window
nobody can explain is a report about an unknown period.

⛔ **Counts are withheld, never caveated** (anti-drift item 5). An end's numbers appear only where the
`STATE.json` committed at that revision describes that revision: its own `sourceRevision` reached
through savepoint-only commits and nothing else, classified by `hooks/_manifest.js`'s own
`isSavepointOutput` rather than a second copy of the rule. This is the revision half of freshness and
the document says so; the compiler-input digests need the working tree and stay `savepoint`'s job.

⛔ **A candidate is an unverified lead** (anti-drift item 11). The report is where a captured lead
becomes visible, never where it becomes true, and there is no promotion path through this verb.

⛔ **An input that could not be read is a row inside the report.** The composition records
CANNOT_DETERMINE, writes everything else, and puts the row in the document's own owner-actions section.
A report that quietly composed around a corrupt journal would be shorter and wrong where nobody could
see it.

**Writing.** Preview is the default. `--write` creates `docs/derived/aar/<until-date>-<slug>.md` with
the DERIVED banner, the whole report inside one generated block, and an empty NOTE block at the foot for
the human (anti-drift item 7). A report already at that path is a REFUSAL at exit 2 naming the file: a
report records what was known at a moment, and a second opinion about the same window belongs in a
second file.

**The trigger.** `contract complete goal` calls it with the goal's title after a SUCCESSFUL close and
reports the path; `--no-aar` skips it. A goal closing is the one phase end this pack can name without
inference (owner decision 23). It can never move the closure in either direction: a refused close
writes nothing at all, an idempotent retry that closed nothing writes nothing, and a report that could
not be written rides back as its own row while the closure keeps its own verdict (anti-drift item 9).

**Also not implemented here:** the goal-mode task scheduler and stack-aware CI selection. The
task runner in `adapters/claude-code/task-runner/` is not that scheduler: it runs from a RespawnPack
checkout against a target, decides completion from its own gates plus this kernel's attestation record,
and is installed into no target.

## Boot ownership

The kernel is the **boot source**, not a checker beside one:

- `docs/derived/STATE.json` is what SessionStart injects and what `/respawn` reads first, after
  validating `sourceRevision` against HEAD. A stale projection is announced as stale; it is never
  presented as current.
- **The savepoint's own commit is not drift.** The documented closeout commits the regenerated docs
  *on top of* the work they describe (`docs(savepoint): regen at <W>`), so HEAD is always one commit
  past `sourceRevision` afterwards. `sourceRevision` is therefore bound to the nearest ancestor of
  HEAD that is **not savepoint-only** (a single-parent commit touching only `docs/derived/**` or
  `memory/candidates/**` and nothing under `docs/derived/state/`, the compiler inputs), and every
  reader (boot, `status`, `doctor`, the Stop hook, evidence binding, the generated-block check)
  treats HEAD and that ancestor as the same source. One definition, in `hooks/_manifest.js`
  `sourceRevisions()`, bounded to 16 commits and strict on truncation. Any commit that touches
  anything else ends the walk and is `STALE` exactly as before.
- `docs/derived/CONTINUITY.md` contributes only its `RESPAWNPACK:NOTE` block, the sentence a human
  wrote. Numbers come from the structured source.
- `docs/derived/LESSONS.md` is the third render target: the **lessons register**, a projection of the
  memory store rather than of `STATE.json`. It renders one row per entity promoted into
  `memory/graph/<type>/<slug>.md` — the id, its first observation, `promotedAt`, the `verifiedBy` that
  earned the promotion, and the skills its `applies-to|skill:` relations name — then the counts of
  candidate and rejected leads in `memory/candidates/`, under the labels `verified lessons`,
  `candidate leads` and `rejected leads`. Because those numbers are not in `STATE.json`, `verify`
  checks them with `render.js`'s `verifyLessons` rather than `verifyRendered`: the DF-011 pair is
  extended, never half-applied. An absent memory directory is a counted zero that names itself; a
  record that cannot be read withholds the count instead of printing one. The file is fully
  generated, so a project without one gets it CREATED by the first `--write` and it carries no
  migration or `restore-derived` story. A run that CAPTURES a candidate memory re-renders the
  register afterwards, so the stage that changed the store never leaves its projection behind — but
  only when the register was in step to begin with, since a check-only run must not repair a
  document it has just reported as wrong.
- A verified compaction handoff is injected at the next SessionStart and **marked consumed**, so it is
  neither lost nor re-injected forever.
- Goal state has one owner: the durable contract (id, criteria, constraints, authority, forbidden) lives
  in `docs/derived/state/goal.json` along with the project's `ongoingGoalId`; runtime holds only the
  mode, this machine's `activeGoalId`, and any `suspendedGoalId`. The compiler reads **no** runtime
  state, so two machines in different modes produce byte-equivalent tracked output and a fresh clone
  sees the ongoing goal while defaulting to collaborate. `contract collaborate` **suspends autonomy**,
  never deletes the goal.
- Freshness is content-bound: `STATE.json` carries a `sourceManifest` of sha256 digests over every
  compiler input, and boot recomputes it. `CURRENT` requires the revision **and** every digest to
  agree; a changed input is `STALE`, a missing or malformed manifest is `CANNOT_DETERMINE`. When state
  is not current, volatile claims are withheld rather than caveated.
- Goal completion is decided by the **stated criteria**, not by the requirement denominator. A criterion
  the compiler cannot evaluate makes completion `CANNOT_DETERMINE`. Free text is legitimate, it is just
  not something a program may rule on in its own favour.

Adopting the kernel is safe on an existing project: the first `savepoint --write` archives a
hand-authored `CONTINUITY.md`/`GAPS.md` verbatim to `docs/derived/_archive/<name>.pre-kernel.md`,
imports its prose into the protected NOTE block, and is idempotent. Without `--write` it is a preview
that changes nothing, including `STATE.json`, which a verify-only run compiles **in memory** and
compares against the copy on disk (`generatedAt` excluded) rather than rewriting: agreement is
`state-writeback PASS … left untouched`, disagreement is a FAIL that names `--write` as the fix, and
the only verify-only write is creating a `STATE.json` that does not exist yet.

The NOTE block is **bounded, never silently**: `NOTE_BUDGET` is 1,200 chars (UTF-16 units, a note, not
a second handoff document). A note over budget makes `savepoint` emit a `note:budget:<file>` **FAIL**
in `--verify` before anything is cut, naming the length and where the full text would go. `--write`
keeps the first chars, ends the block with a visible marker (inside the budget, so a re-render is
stable):

```
…[note truncated at 1200 chars — N chars dropped; full text archived to …]
```

and archives the whole note verbatim to `docs/derived/_archive/<name>.note-overflow-<day>-<digest>.md` **before** the bounded
document is written. The next run passes once the block fits. The migration seed above is sized to fit
the same budget with its archive-naming trailer intact.
