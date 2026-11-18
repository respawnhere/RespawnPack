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
node .claude/respawnpack/respawnpack.js savepoint --verify  # check-only for the rendered docs; still records its attempt and captures failing checks as candidate leads (see "Without `--write`" below)
node .claude/respawnpack/respawnpack.js savepoint --verify --write   # also rewrite STATE.json + the derived docs
node .claude/respawnpack/respawnpack.js savepoint --verify --only compile,render,verify   # a PARTIAL savepoint — see below
node .claude/respawnpack/respawnpack.js savepoint --verify --skip memory,adapters    # the same run, minus two stages
node .claude/respawnpack/respawnpack.js savepoint --verify --only compile,reconcile  # DF-005: the task list vs the project's own gap/gate records
node .claude/respawnpack/respawnpack.js lineage             # Class D: does every declared derivation still match the source it names?
node .claude/respawnpack/respawnpack.js review-receipt --check   # is the recorded review still about THIS tree? (what /ship's pre-ship gate runs)
node .claude/respawnpack/respawnpack.js review-receipt --check --staged   # does the index carry exactly the reviewed bytes? (what /ship runs right before committing)
node .claude/respawnpack/respawnpack.js review-receipt --write   # record HEAD + the tree digest + the content tree a review judged (what /review's Step 4 runs)
node .claude/respawnpack/respawnpack.js migrate decisions          # B2: PREVIEW splitting a docs/DECISIONS.md monolith into docs/decisions/
node .claude/respawnpack/respawnpack.js migrate decisions --write  # …and apply it: one file per decision, the monolith archived, a rendered index in its place
node .claude/respawnpack/respawnpack.js aar                 # Class C: the After Action Report for a window, bottom line first; --write creates it
node .claude/respawnpack/respawnpack.js log --action "..." --result "..." --by "..."   # G17: append one append-only ops-log row (.respawnpack/ops-log.jsonl, machine-local)
node .claude/respawnpack/respawnpack.js log --verify        # …walk the prevDigest chain: PASS/FAIL naming the first bad row, a torn tail reported
node .claude/respawnpack/respawnpack.js incident --new --signature "..." --cause "..." --fix "..." --by "..."   # G17: author one incident (memory/incidents/, tracked) + mint a root-cause-fix candidate naming it by id
node .claude/respawnpack/respawnpack.js incident --list     # …the open and fixed incidents; --close <id> --by "..." marks one fixed (the only edit a verb makes)
node .claude/respawnpack/respawnpack.js status              # short current-state summary
node .claude/respawnpack/respawnpack.js doctor              # installed / configured / unsupported / stale / SILENTLY INACTIVE
node .claude/respawnpack/respawnpack.js doctor --onboarding # ONLY the applicability survey — the boot projection /respawn Step 2 reads
node .claude/respawnpack/respawnpack.js site                # build the project's own documents into .respawnpack/site/
node .claude/respawnpack/respawnpack.js site --serve 8080   # …and read them at http://127.0.0.1:8080/ (loopback only)
node .claude/respawnpack/respawnpack.js feedback --export   # G16: PREVIEW this project's pack-directed feedback (nothing written)
node .claude/respawnpack/respawnpack.js feedback --export --out pkg.json   # …write the package once the preview is clean (REFUSES on a fence-blocked field)
node .claude/respawnpack/respawnpack.js memory candidates import pkg.json  # G16 (dev side): land each exported record as a CANDIDATE
node .claude/respawnpack/respawnpack.js reconcile           # DEPRECATED alias for the line above — same rows, same exit code, prints a deprecation notice
```

**Exit codes are three-valued:** `0` PASS · `1` FAIL · `2` CANNOT_DETERMINE. Add `--json` for a
machine-readable result, and read the exit status directly, never through a pipe (DF-007 #1 was an
`echo $?` that captured `tail`'s status instead of the tool's).

It **never pushes**, and commits only when explicitly told to.

## The decision shard (B2)

`docs/DECISIONS.md` is append-only and grows without bound. A live target reached 230 KB over 84 entries, and `/respawn` read it whole at every boot. It is now the **MEMORY.md index pattern**: one file per decision under `docs/decisions/D-NNN-<slug>.md`, and `docs/DECISIONS.md` is a GENERATED index over them (id, date, title, status, a ⛔ mark for a removal, a link to the file), rendered by `kernel/lib/render.js` and **verified by the savepoint exactly like `CONTINUITY`/`GAPS`/`LESSONS`**: a hand-edit inside the generated block FAILs `generated-block:docs/DECISIONS.md`, and the index's counts are parsed back out and checked against the shard (`rendered-claims:docs/DECISIONS.md`). The index is bounded under 8 KB (B3); over that it carries the top rows (removals first, then most recent) and a "N more in `docs/decisions/`" line. `STATE.json.decisions` carries the count and the removal ids a boot reads. The compiler reads the shard, so `state` reports a stale index and the savepoint verifies it.

A shard file is frontmatter then the entry body verbatim:

```
---
id: D-003
date: 2026-06-18
status: accepted          # accepted · proposed · deprecated · superseded
title: "AI task suggestions retired"
removal: true             # a removal file; the index marks it ⛔
supersedes: ""
supersededBy: ""
---
### D-003 — AI task suggestions retired · 2026-06-18 · accepted · ⛔ removal
- Decision: …
- ⛔ Removal: <what this kills + why it must NOT return>
```

The removal scan treats `docs/decisions/**` and `docs/_archive/**` as history (built-in), so a killed-feature phrase inside a decision file is a record of a killing, never a live reintroduction; a `removals.json` row may carry an optional `decision: D-NNN` pointer at its decision file.

`migrate decisions [--write]` splits an existing monolith: a DRY RUN by default that previews the exact per-entry plan the write performs, and `--write` to apply (one file per entry, the monolith archived verbatim to `docs/_archive/DECISIONS.md`, a rendered index in its place). It **refuses the whole run** on the first entry it cannot resolve to an id, date and status, naming it by heading and line, in a dry run or a write alike, and writes nothing. A duplicate id, a missing status, an unparseable heading or a slug collision all refuse. A migration is complete only once `docs/DECISIONS.md` is the rendered index, which a write does last: it archives the monolith first (read back before anything else moves), then writes the shard files, then renders and verifies the index in memory before it replaces the monolith. A run interrupted before that is resumed by the next one, which leaves a shard file identical to its monolith entry alone, writes the missing ones, and refuses, writing nothing, on a file that differs from its entry, a file the monolith does not hold, or two files claiming one id. An archive path that already holds a different file is never overwritten: the monolith goes to the next free `docs/_archive/DECISIONS-<n>.md`. A second run over a completed migration, or a project with no monolith, is `NOT_APPLICABLE`. Two shard files claiming one decision id FAIL `rendered-claims:docs/DECISIONS.md` in `savepoint --verify`, naming the id and both files.

## The ten savepoint stages (`--only` / `--skip`)

`savepoint` is ten subsystems in one verb, and until P4-K-08 the only way to run fewer of them was to
type a different verb: `removals` for one, `reconcile` for another, nothing at all for the other seven.
The verb list was never the unit of scoping; the stage is. They run in this order:

| stage | what it does |
| --- | --- |
| `compile` | recompile `docs/derived/STATE.json` in memory from the structured sources (this is where the removal scan and the reconciliation actually run) |
| `writeback` | verify the compiled state against disk by digest, or, with `--write`, verify the write by reading it back |
| `render` | migrate a hand-authored derived doc, plan the NOTE budget, render the derived docs (`docs/derived/CONTINUITY.md`, `GAPS.md`, `LESSONS.md` and `HANDOFF.md`) plus the decision index (`docs/DECISIONS.md`, B2, when the shard exists) and (with `--write`) write them, refresh the host handoff-memory pointer, then fold the wave ledger |
| `verify` | check every rendered claim back against its source, and the generated block against a fresh render |
| `removals` | the killed-feature contract's per-row verdicts: `compile`'s scan is reused on a run that rewrote nothing, and a writing run re-scans after `render` incrementally, over only the rendered docs, which are the only files the render moved (A5) |
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

⛔ **The savepoint's own ops-log row (G17) is appended after the rollup, and never decides the verdict.**
Once per `savepoint --write` that reached its rollup and rendered, the savepoint appends one
`.respawnpack/ops-log.jsonl` row (`by: savepoint`, `action: savepoint --write`, `result:` the rollup the
run exits with) - the seal that closes the ops-log chain's last-row limit at every write. The append's own
result rides beside the verdict as an `ops-log:append` row and is **not** in the checks the exit code rolls
up, the same rule the host handoff-memory pointer follows: a machine-local record never moves the project's
verdict (PASS, or NOT_APPLICABLE when the append could not land, a torn tail blocks it, or `render` was
skipped). A bare `--verify` never writes a row.

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

`runCandidateCapture` auto-captures from two evidence sources (a `FAIL`/`CANNOT_DETERMINE` check and a
piece of evidence that went stale) plus the operator's own `--candidate "kind:text"`. A live goal
constraint is deliberately not among them: it already lives durably in `docs/derived/state/goal.json`,
read by every contract check, so minting it as a candidate would only add a second copy of a known fact
for a reviewer to reject by hand, which is the opposite of a lead. An operator who still wants one filed
can say so with `--candidate "constraint:..."`.

The same reasoning generalises to every other durable record (D4). Before an AUTOMATIC capture mints a
lead, `runCandidateCapture` qualifies its claim against the records the project already holds, gathered
by `durableRecords()` through readers this file already has: the knowledge graph, the decisions
(through `kernel/lib/decisions.js` — the `docs/decisions/` shard on a migrated project, the
`docs/DECISIONS.md` monolith's `### D-NNN` headings otherwise, so both states give the same set and a
superseded decision is excluded), the removal registry (the compiled `state.killedFeatures` names) and
the requirement rows in `STATE.json`.
Code and tests are NOT searched: the pack cannot read them semantically and will not pretend to, so that
corpus is covered only where a fact is also an evidence row or a removal. The match is the pack's
deliberately dumb one, stated once in `core/memory/candidates.js` as `qualifyClaim()`: the normalised
claim equal to, or a long containment (at least forty characters) of, a record's text, never fuzzier,
because a false "already recorded" silently drops a lead. A match that is a graph entity carrying NEW
evidence folds into that entity as one dated `## Observations` line and mints nothing; any other match is
captured then rejected in the same run with the reason `already recorded: <record>`; a `_retracted/`
entity is not a durable record; and the operator path is never filtered, only annotated with any record
it resembles.

### `memory candidates promote` / `reject`, and the host auto-memory mirror

`memory candidates list` is the review surface; `promote <id> --as <type>/<slug> --verified-by "<what>"`
and `reject <id> --why "<reason>"` are the only two ways a lead changes state, each explicit and audited.
`promote` writes the canonical graph entity (`memory/graph/<type>/<slug>.md`) **and** mirrors one line into
Claude Code's own auto memory `MEMORY.md`; `reject` removes that mirror. The graph entity is the record;
the mirror is a projection, and its outcome rides beside the verdict in the result's `mirror` field without
changing it; the promotion's PASS is on the graph write, always. The mirror has the three states the
anti-drift core demands: `NOT_APPLICABLE` when no auto memory directory exists for this project (nothing is
created), `CANNOT_DETERMINE` when adding the index line would push `MEMORY.md` past the host's 200-line or
25 KB cap (the memory file is still written, so the entry is reachable on demand), and `PASS` when one
`respawnpack-<type>-<slug>.md` file and one index line are written. The directory is resolved from
`RESPAWNPACK_AUTO_MEMORY_DIR` (tests and probes), else `autoMemoryDirectory` (project, then local, then user
settings; a relative value against the project root), else `~/.claude/projects/<encoded>/memory/`. A second
promotion of the same candidate rewrites the same bytes and adds no second line; a rejection removes the file
and only the index line tagged by its name, never a line a human or the host wrote. The host does not document
recognising files another program wrote, so the mirror is a convention the docs permit, not a contract.

**`promote` and `reject` both require `--by "<who>"` (G6), and a rejection retracts or refuses.** A verdict
with no author cannot be reviewed, so a blank or absent `--by` is refused at both CLI sites and in the core
before anything is written, never defaulted to null; the savepoint's automatic duplicate rejections pass
`by: savepoint`, a valid machine author. Rejecting a candidate whose graph entity is still live is the
operator's choice by flag: `--retract` moves the entity to `memory/graph/_retracted/<type>/<slug>.md` with
`retractedAt`/`retractedBy`/`retractedReason` added to its frontmatter (body untouched) and removes the
mirror line; its absence REFUSES the rejection naming the entity file. `readGraphEntities` reads
`_retracted/` so the ledger counts it, while the register and D4's `durableRecords` skip it.

**`promote --as rule/<slug>` also writes the versioned rules file (G15, decision 50).** A correction an
owner states is captured as a `constraint` candidate like any lead; confirming it `--as rule/<slug>` writes
the graph entity as always AND appends the confirmed rule to the project's versioned rules file the
`/wordsmith` and `/review` skills load. `--tag script|reader|both` (default `reader`) records which gate
half the rule rides, written as `ruleTag` on the entity and `[<tag>]` on the rule line. `--rules-file
<path>` must be one of the two loaded locations (`docs/reference/wordsmith-rules.md` or a
`.claude/rules/writing*.md`) or is refused naming them; absent, the kernel picks the existing file with the
highest `version:` (the skill's own precedence, so the loaded and the written file are the same), else
creates `docs/reference/wordsmith-rules.md`. A NEW `.claude/rules/` file is created only with `--paths
"<glob>"` (its `paths:` frontmatter, so it costs 0 B at boot); an existing unscoped one is appended to with
a printed boot-cost note. The rule is `N. [<tag>] <text> (rule:<slug>, confirmed v<newVersion>, <candidate
id>)` and `version:` is bumped (`N`→`N+1`, `a.b`→`a.(b+1)`, a body `Version:` line treated the same; an
unparseable version is refused, nothing written). The whole file is rewritten atomically with every other
byte and its CRLF preserved. A repeat to the same `--as` rewrites the file only when the `(rule:<slug>`
marker is absent (idempotent by that marker, never a second line or a second bump); the result reports
`rulesFile`, `ruleLine` and the version change, or `rulesFileUnchanged`. The whole promotion runs under an
exclusive rules-file lock (`.respawnpack/rules-file.lock`, the ops-log mutex's pattern on its own file: a
3 s bounded wait, a 30 s stale window with a named reclaim), so two concurrent promotions are serialised and
each plans from the file the other wrote; a lock that never clears refuses the promotion (FAIL, nothing
written). A rules-file write that fails after the entity is written is `CANNOT_DETERMINE` (exit 2), never
PASS: the error names the file, the cause and the exact command to re-run (also in `retry`), the rules file
is unchanged, and the retry writes the line once with one bump. **A rejection withdraws the rule.** Any
`reject` that proceeds (with `--retract` for a live entity) first removes every `(rule:<slug>, confirmed
v<n>, <id>)` line naming the candidate under the same lock, bumps each changed file once, and records
`- rule <n> withdrawn (rule:<slug>, withdrawn v<new>, <id>): <reason>` under `## Withdrawn rules` with no
rule text, so the skills stop loading the instruction; the result carries `rulesWithdrawal`. A withdrawn
number is never reused, and a repeat finds no confirmed line and writes nothing. A failed withdrawal is
`CANNOT_DETERMINE` with the store and the entity untouched, naming the file and the retry. No new hook:
the per-call wall does not move, and the estate's command-pattern stop stays a later opt-in task.

**`memory candidates --ledger` (text and `--json`)** recomputes, from the candidate records and the graph
on every call, the verified / rejected / open counts plus promoted (live entities whose `promotedFrom`
resolves to a candidate), then one line per anomaly naming its ids or files bounded by B3's render cap
with an exact "N more": `verified-without-entity` (a verified candidate that promoted nothing — a broken
promise), `entity-without-lineage` (a live entity with no `promotedFrom`, G7's unvouched set),
`verdicts-without-author` (a legacy verdict with no `by`), `lineage-target-missing` (a `promotedFrom`
naming no candidate — not counted as promoted), `retracted`, and `open-older-than-sessions` (an open lead
older than `memory.staleOpenLeadSessions` savepoint cycles, counted in cycles with the wall-clock days
beside it). `doctor` carries one `integrity` row per NON-ZERO anomaly, copying the memory section's
NOT_APPLICABLE shape for an absent store and emitting no row for a zero: an orphan verification FAILs (a
broken promise), lineage-less entities and authorless legacy verdicts PASS with their count (both allowed
and stated, never repaired), and the stale-open backlog FAILs only when it exceeds the configured
threshold. **Two config keys live beside G7's `memory.staleHorizonDays`:** `memory.staleOpenLeadSessions`
(default 3) is how old in savepoint cycles an open lead must be to count as stale, and
`memory.staleOpenLeadFailAt` (default 10) is how many stale-open leads `doctor` tolerates before its row
FAILs — a default of 0 that FAILed on a single aged lead would train the operator to ignore the row.

**The rules-file integrity rows (G15), `integrity` domain, same one-row-per-finding shape as the ledger.**
`doctor` reads the two loaded rules locations and emits, each naming its files and slugs rather than a bare
count: `rules:unconfirmed-line` (ANOMALY, FAIL) for a `(rule:<slug>, confirmed v<n>, <id>)` line whose
candidate is not `verified` in the store or whose `rule:<slug>` entity is absent or retracted: a forged
confirmation; `rules:version-ahead` (ANOMALY, FAIL) for a rules file carrying at least one pack-written
line whose `version:` runs ahead of its newest `confirmed v<n>` or `withdrawn v<n>` stamp: a version bumped
with no promotion or withdrawal behind it; and `rules:unversioned` (WITHIN_LIMITS, PASS) for a rules file with no parseable version. A file with
no pack-written line is the project's own hand-kept file and earns neither anomaly; a project with no rules
file earns no row. Candidate verification is asserted only when the store and the graph could both be read,
so an unreadable store is never read as a forgery.

### `feedback --export` and `memory candidates import` (G16, the inbound feedback channel)

`feedback --export` packages the records a project holds **about the pack's behaviour** so they can reach
the dev side without the project's operational detail. It is the mechanism that replaces a hand-assembled
field archive. Selection is **mechanical**: a record is PACK-DIRECTED when its claim, evidence paths,
rejection reason, entity id or slug, or first observation names at least one identifier in the pack
manifest the verb builds at run time (the verb keys, the installed hook names, the `doctor` row ids, the
pack-owned path prefixes, the receipt keys, the posture profile names, and the config keys the schema
declares), and the matched identifiers are listed on each exported record. An identifier that is also an
English word (`state`, `contract`, `memory`, a posture name) is matched ONLY in a command shape (after
`respawnpack`/`respawnpack.js`, inside backticks, as the first word of a `--flag` sequence, in its dotted
form for a config key, or beside `posture` for a profile), so a knowledge project's canon prose ("the
state of the border", "a memory of the old capital") names no pack identifier and never leaves; a pack
path, a hook name, a `family:member` doctor row and a coined verb (`savepoint`) are not words and match
anywhere. The three record sources are the
ones the kernel already reads through classified readers: every candidate (any `verificationState`, a
rejected lead's reason being a field), every graph entity (retracted ones marked), and the decision records.
Host auto-memory notes and `.claude/rules/` files are **out of scope** (prose with no mechanical identity).
Each selected record is reduced to the allow-listed schema and nothing else, and every free-text field
(claim, rejection reason, observation) passes a **redaction fence** that refuses a non-pack filesystem
path, an IP, a hostname or domain shape, an email, a URL, a high-entropy token (20+ mixed-class characters
with a digit, Shannon entropy at or above 3.0 bits per character), or any of `hooks/secret-scan.js`'s nine
secret shapes, naming the field and quoting nothing of the blocked value past its first three characters.
The fence exempts the pack's OWN vocabulary so it does not block the records worth exporting: a dotted
config key (`state.reconcile`, `state.removals.liveContentDirs`) is not read as a hostname, a hex digest, a
`cm_`/`inc_` id, a date-stamped doc name and a `file:line` are not read as high-entropy tokens, and a pack
path in Windows (`\`) form is recognised the same as in `/` form.
The verb PREVIEWS exactly what would leave and writes nothing without `--out`. With `--out` it REFUSES
(exit 1, nothing written) while any included record has a fence-blocked field, until the owner passes
`--drop <sourceId>` for it or edits the source. The package is `.respawnpack/runtime/feedback-export-<date>.json`
(gitignored), a registered schema family frozen at `schemaVersion 1.0.0`, and its `provenance.projectId` is
sixteen random bytes minted once into `.respawnpack/feedback-id` (machine-local), so a receiver correlates
exports from one install without learning anything about the project. ⛔ The fence catches **shapes, not
meaning**: a secret written as prose passes, so the preview is the owner's last sight of what leaves; the
pack file a record names is a **lead, not a cause**; and `packVersion` is the receipt's self-report, which a
hand edit can forge, so the receiver verifies it rather than trusting it.

`memory candidates import <file>` is the **dev-side receiver**. It reads the package through the classified
boundary, validates the shape, **re-runs the fence** on every free-text field AND on every `evidence`
token (which must also be one of the mechanical shapes the exporter emits: a record failing either is
REFUSED by name and not imported, the FAIL outcome), verifies the provenance (`exportedAt` parseable,
`projectId` 32 hex, `receiptSchemaVersion` a number, and `packVersion` matched to a release this checkout
knows, its own `VERSION` or a `## [x.y.z]` CHANGELOG heading), and lands each remaining record as a
**candidate** through the same `captureCandidateOnce` gate, so a second import of the same package appends
nothing. An import is authored `import:<projectId>`, `sourceKind: adapter`, with the receiving checkout's
current source revision as its `cycleId` (so the ledger ages it like any captured lead), and its claim is
prefixed `[<kind> from project <projectId>, pack <packVersion>, posture <profile>, type <projectType>] `.
Nothing an import writes is ever a graph entity or a lesson: it lands `verificationState: candidate` and is
marked `UNVERIFIED LEAD` on recall until an audited `promote --by`. A verified import is **PASS**. An
**unverifiable** provenance (an absent or torn block, or a `packVersion` this checkout cannot match) imports
every lead with the prefix `provenance unverified: ` at **CANNOT_DETERMINE**, never dropped and never
promoted, and any refused record makes the outcome **FAIL** with the refusals named.

### The `install:pack-version` doctor row (G16)

Beside the `scoping` section, `doctor` reads the install receipt's `packVersion` (schemaVersion 4) and
cross-checks it against the CLAUDE.md managed-block opener (the kernel keeps its own copy of the opener
regex, fenced equal to the installer's, because `install.js` does not travel into a target): `INSTALLED`
with the version when the receipt's `packVersion` is a non-empty string and equals the block's;
`NOT_CONFIGURED` when the receipt carries no `packVersion` (an install older than the field, which
`upgrade.js` records on the next upgrade); `BROKEN` when it is present but not a string, or disagrees with
the block (a half-applied upgrade, named with both values); `NOT_APPLICABLE` when there is no receipt at
all. A hand edit of the receipt's version to a value the block does not carry reads `BROKEN`.

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
`state:STATE.json`, the candidate-ledger anomaly rows (G6) and the operational-record rows (G17,
`ops-log:chain`, `ops-log:silent`, `incidents:incomplete`, `incidents:inlined-fix`), which are
`integrity`, and the decision rows (`onboarding*`, `posture`, `exceptions`,
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

### What the pack recorded about its own catches (`catches` row)

`doctor` carries a `catches` row reading `.respawnpack/runtime/catches.jsonl`, the append-only,
machine-local, gitignored record of every time a guard withheld, refused or denied (review 2026-09-23
§3): the freshness check, the removal contract, `secret-scan` and `push-guard` each append one line when
they fire, and nothing on a pass. The row is `ACTIVE` with per-guard totals and the first and last
timestamp when the file parses, `NOT_CONFIGURED` ("no catch has been recorded on this machine") when it
is absent (its absence on another clone proves nothing, the same sentence the savepoint receipt uses),
and `BROKEN` naming an unparseable line while still counting the good ones. It proves a guard fired, not
that firing was right. The file is JSONL, so `doctor` reads it line by line (one `readFileSync`, then a
`JSON.parse` per line) rather than through the atomic-replacement boundary: it is only ever appended to,
never replaced by rename, so there is no transient window for a reader to miss.

### The operational-record rows (`ops-log:*`, `incidents:*`, G17)

`doctor` carries four `integrity` rows over the ops log and the incident library (decision 50), each
naming its entities, none a bare count:

- `ops-log:chain` walks `.respawnpack/ops-log.jsonl`'s `prevDigest` chain the way `log --verify` does:
  `ACTIVE` with the row count and head digest when it holds, `BROKEN` naming the FIRST bad row (a rewrite
  or a splice is not append-only), `WITHIN_LIMITS` naming a torn tail with the `log --repair-tail` remedy
  when that is the only fault, and `NOT_APPLICABLE` when there is no log on this machine.
- `ops-log:silent` is advisory (never a `FAIL`): `WITHIN_LIMITS` when the newest `memory.staleOpenLeadSessions`
  savepoint rows at the tail carry no operator row between them - "the log has recorded no operator action
  across N savepoint cycles" - and absent otherwise.
- `incidents:incomplete` is `WITHIN_LIMITS` naming every `memory/incidents/<id>.json` that lacks a
  signature, cause or fix, or fails its shape (an unreadable or malformed file included), bounded with an
  exact "(N total)"; absent when none.
- `incidents:inlined-fix` is `ANOMALY` naming the incident and the duplicate when a candidate claim (any
  state), CONTINUITY's NOTE block, or a graph entity's observations under `memory/graph/**` carry an
  incident's FIX BODY by the literal containment rule `qualifyClaim` uses (forty characters or more) rather
  than pointing at the id (the memo's third single-sourcing leg: a lesson promoted from an incident cites
  its id and never copies the fix). The incident's own minted candidate never matches - its claim carries
  the id, not the body - and a RETRACTED entity is skipped, because a retracted lesson may legitimately be
  raised again; absent when none.

Both files are read through `core/_io.js`'s classifying reader (the ops log line by line, so a torn tail
is detected on read; each incident through `readJSONClassified`), never repaired by a read.

⛔ **The append is serialised by a lock, and that lock binds only the pack's own writers (G17 R1).** The
`log` verb and the savepoint take an exclusive lock (`core/_io.js` `createExclusive`, a portable
compare-and-swap) on `.respawnpack/ops-log.lock` for the read-head-then-append window, so two honest
appenders (two `log` verbs, or a `log` during a `savepoint --write`) cannot both seal a row against the
same head and splice the chain. A held lock is waited on for a bounded second and then the append is
REFUSED naming the lock (the verb FAILs; the savepoint's `ops-log:append` row reads `NOT_APPLICABLE` with
the reason and the exit code does not move); a lock whose holder died is reclaimed only when it is older
than a conservative stale window, and the reclaim is NAMED in the result, never silent. The lock binds the
pack's own writers only: an outside editor appending to the file by hand is not bound by it and can still
break the chain, which `ops-log:chain` then names. And `--repair-tail` is given nothing new - it discards a
torn TAIL only and never re-seals a broken chain, because re-sealing a splice would launder a rewrite; a
broken chain stays corruption for a human to examine.

### Large-tree scoping rows (`scoping*`, D1)

`doctor` reports what the installer's large-tree scoping emitted, reading the install receipt (what the
pack OWNS) against `.claude/settings.json` (what is there). When the installer named no asset or generated
directory, a single `scoping` row is `NOT_APPLICABLE` naming the two-signal rule (a conventional or
gitignored directory name AND large-or-binary by a cheap measure); when it previewed but wrote nothing,
that one row is `NOT_APPLICABLE` saying a preview exists and how to apply it, and it carries the LSP
recommendation. When `--write-settings` wrote the scoping, there is one row per family — `scoping:deny`
(the `Read(<dir>/**)` rules, a `Read` deny also blocking `Edit`/`Write`), `scoping:excludes`
(`claudeMdExcludes`) and `scoping:worktree` (`symlinkDirectories`/`sparsePaths`) — each `ACTIVE` when the
receipt's rules are present and `BROKEN` when a hand edit dropped one, plus a `scoping:lsp` row that is
`NOT_CONFIGURED` because the pack recommends the plugin and never writes `enabledPlugins`. `doctor`
restates the two-signal rule rather than requiring `install/_scoping.js`, which does not travel into an
installed target; it reads the receipt through the same classified `readJSON` the settings files use.

## The declared posture, and which rows it can move

The kernel reads the project's `posture` block through `hooks/_posture.js`, the same one reader the
hooks use, reached cross-tree because the kernel may require from `hooks/` and not the other way round.
`doctor` carries a `posture` row naming the profile and where it came from. A profile changes **which
outcome a row returns**, never what an outcome means and never the 0/1/2 exit map, and never which
checks ran: ADR-003 assigns no savepoint stage to a profile.

The `posture` row's status names the SOURCE: `CONFIGURED` for a founder's own declared profile,
`NOT_CONFIGURED` for `DEFAULTED` (no key, so nobody chose — resolves to `strict`), `BROKEN` for an
`UNREADABLE` or `INVALID` one, and `DECLARED-BY-INSTALLER` (decision 34) for a posture the installer
seeded on a fresh install (`seededBy: installer`) that nobody has chosen yet. The last is green, the same
exit `CONFIGURED` gives, and is kept distinct on purpose: "the installer seeded `standard`" and "a founder
chose `standard`" are different facts, and so is the `DEFAULTED` strict an existing unconfigured target
still shows. The onboarding rows a `knowledge` install seeds read `declared not applicable by the
installer (projectType knowledge): <reason>`, so a type-driven opt-out is legible apart from a human's.

**`doctor --onboarding` — the applicability survey alone, for the boot (B1).** `/respawn` Step 2 used to
run `doctor --json` whole and read two things out of ~25 KB: the onboarding verdict and the applicability
survey. `doctor --onboarding` prints only that survey — the default text is one line per contract (its
`state`, `basis` and `remedy`, never the verbose `detail`); `--json` is `{ onboardingComplete, unresolved,
applicability }`, the `applicability` rows byte-identical to the full `doctor --json`'s. It is computed by
the **same `coverageChecks`** the savepoint coverage stage runs — config and file system only, no scan, no
subprocess, none of doctor's install inventory — so it can never disagree with `doctor` and it earns the
boot its time back (on the audit fixture, ~230 ms versus ~1,840 ms for the full verb). The exit mirrors the
onboarding row: `0` COMPLETE, `2` anything still undecided — and a project with no config reports its
undecided rows as the survey does, never an empty array presented as complete.

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
docs/derived/HANDOFF.md                ← GENERATED. The pointer-first handoff /respawn reads first.
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
`decisions`, `lineage`, `aar`, `closeout`, `memory`, `living`, `assert`, `reconcile`, `applicability`, `readiness`, `site`) is loaded lazily through
`modhealth`, so a corrupt one is a named `BROKEN` row with the rest of the report intact.
`hooks/_manifest.js` is deliberately outside the bootstrap too: it lives in the other installed
directory and is probed, never required outright.

**One subsystem may be absent on purpose, and that is a different row from a broken one.** The installer
places 18 kernel files under `strict` and `standard` and 17 under `light`: ADR-003's rule table reads
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

`implemented and behavior-tested`. `kernel/kernel.test.mjs` (669 tests) runs on both CI platforms and
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

Closing a delegation restores the interaction mode that was in force when it opened, recorded as
`priorMode`. A delegation opened under active autonomy hands its suspended goal back and resumes in
`goal` mode; a delegation opened from `collaborate` (autonomy already suspended) returns to `collaborate`
with the goal still suspended, and resumes only on an explicit `contract goal --resume`. Closing a
bounded task never silently re-grants autonomy nobody asked for. A runtime an older pack wrote has no
`priorMode`, and its absence is read as `collaborate`, so an upgrade mid-delegation cannot escalate
either. `--met` always means `delegate`, so an idempotent retry cannot land on the goal.

Every list-valued contract flag (`--completion`, `--acceptance`, `--met`, and the goal's `--constraints`,
`--authority`, `--forbidden`, `--blockers`) reads one of two ways, interchangeably: a single `";"`-joined
value, or the flag repeated once per criterion. A bare `";"` is always a separator; write `"\;"` for a
literal `";"` inside a criterion. There is nothing to refuse and nothing that silently fragments: the
escape settles both cases, and a repeated flag no longer records only its first occurrence. Entering a
contract echoes the parsed `criteriaCount` so a miscount is visible at the moment it happens rather than
when a close later cannot match the recorded list.

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

⛔ **The scan is incremental, and the digest is the only arbiter (A5).** Parsing a document into
live-assertion occurrences is the cost the review measured at ~half of `savepoint --verify`; the sha256 of
its bytes is not. So the scan digests every live-content file through `hooks/_manifest.js` (the one
definition of "changed" the writer and boot both resolve), re-parses only the files whose digest differs
from the last recorded verdict and the files that verdict never held, and carries the recorded per-file
findings for everything proven byte-identical. The verdict is identical to a full scan of the same tree.
Every carry is fenced in the safe direction: a changed file is always re-parsed; an added or edited
registry row (anything the recorded `rowsFingerprint` covers), an absent or unusable recorded manifest,
and a digest that no longer matches the tree each force a full scan, never a guess of "unchanged". The
prior (`corpusManifest`, the per-file digests; `corpusFindings`, the per-file occurrences; and
`rowsFingerprint`) lives in **`docs/derived/state/corpus.json`** (B3 relocated it out of
`STATE.json.removals`, where at scale it was ~93 bytes per prose file). `STATE.json.removals` keeps the
verdict, the counts and the durable `lastFullScanAt` stamp, plus a one-line **`corpusDigest`**: a sha256
of `corpus.json`'s bytes, recorded at write time, so the projection still vouches for a file it no longer
contains. `corpus.json` is a savepoint OUTPUT (`hooks/_manifest.js` `isSavepointOutput` lists it by name,
so committing it stays savepoint-only), never a compiler input. STATE.json itself STAYS pretty-printed:
it is a tracked file founders read and diff, so this relocation and the `nextUnblockedWork` bound are the
slimming, not a whitespace cut. On the audit fixture that takes STATE.json from about 150 KB to about
82 KB at 200 requirements, about 21 KB over the review's 60 KB target; the remaining bytes are the
requirement rows' own fields, and moving the ones a boot never reads to a corpus-style sibling is a third
mechanism parked as an open owner decision. On a writing
savepoint the compiler's pre-render corpus record is handed to the post-render re-scan as its prior, so
that re-scan costs only the three rendered documents rather than a second full walk (see BUG-3 in
`respawnpack.js`). The push-time scan
in `hooks/pre-push` is opt-in through `RESPAWNPACK_PREPUSH_REMOVALS=1`; it runs on every `savepoint` regardless.

⛔ **What a carry trusts, and the attestation (A5).** The sha256 proves the bytes are the ones the prior
judged; it does not prove the prior judged them honestly. The carried findings are trusted from the prior
`corpus.json`, a tracked derived record, so a forged prior (a `corpus.json` recording a file's current
digest with empty findings) is a forged derived record and lies outside this scan's guarantee: the corpus
record's integrity is the trust root, bound into `STATE.json` by `corpusDigest`, which `state-writeback`
verifies. A hand edit to `corpus.json` that a fresh scan reproduces into its record FAILs through that
digest; the stronger remedy is `--full`, on the `removals` verb and on `savepoint` (both modes): it carries nothing
and re-derives every finding from the tree, and `hooks/pre-push` runs it when opted in, because a push is
the moment to spend that trust. The verdict records `lastFullScanAt` (durable; it moves only when a run
both carried nothing AND actually scanned the whole readable set, so an empty corpus, an over-cap file or
an unreadable one leaves it unchanged rather than attesting a pass that did not happen), and `doctor`'s
`removals:contract` row and `savepoint`'s output report "N of M file(s) carried from the prior verdict;
last full scan T (or never)", so a verdict never fully re-derived is visible. A `savepoint --verify --full`
re-derives the stamp live but never persists it (a verify never writes), so it is excluded from the
state-writeback comparison; the durable stamp advances only on a `--write`.

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

## Review freshness (`review-receipt`)

A review's verdict is a fact about the exact tree it judged, and nothing used to re-check it before the
next step trusted it (the 2026-10-05 field report). `/review`'s Step 4 runs `review-receipt
--write`, which records HEAD plus a sha256 over the **content identity** `hooks/_runtime.js`'s
`diffStates` compares (each path's `C:` content digest, collapsing the `W:`/`S:`/`U:` buckets; a
deletion keeps its bucket digests), to `.respawnpack/runtime/review-receipt.json`, with the verdict and
the lenses that ran. Digesting the content rather than the raw bucket keys is deliberate: a zero-byte
`git add` moves a path from `U:`/`W:` to `S:` without changing a byte, and a receipt keyed on the
buckets would read that index move as the tree changing, disagreeing with the Stop hook's own
`diffStates` about the same tree (A3's 563-file field run). `/ship`'s pre-ship gate runs `review-receipt
--check`, which recomputes both and returns **PASS** when a receipt exists and HEAD and the working-tree
content still match it, **FAIL** when either moved (naming the stale review's timestamp and whether HEAD
or the working-tree content changed), and **CANNOT_DETERMINE** when no receipt exists, it is unreadable
or malformed, or the tree is not a repository. The writer and the checker share one `treeState`, so they
cannot disagree about what "the tree" is.

⛔ **The receipt is bound to the exact content a commit would carry.** The digest alone could not see
the index: stage one version of a file, edit it back to the reviewed bytes, and the working-tree digest
still matches while the commit carries the staged version. So `--write` also records `contentTree`, the
git tree object of the whole reviewed content, built in a temporary copy of the index brought to the
working tree with `git add -A` (git hashes every byte, `.gitignore` is honoured, `.respawnpack/` is left
out as `treeState` leaves it, and the real index is never touched). `--check` compares it too, and
`/ship` runs `review-receipt --check --staged` after staging and right before `git commit`: PASS only
when HEAD is the reviewed HEAD and every staged path carries exactly the reviewed bytes, FAIL naming each
path that does not. A staged path under the project's own `.respawnpack/` is refused by name too: the
snapshot leaves that directory out, so no review saw its bytes. Where the project sits inside the
repository comes from `git rev-parse --show-prefix` (empty at the root, `apps/site/` below it), never
from comparing two spellings of a path, so an 8.3 short name or a junction or symlink cannot misplace
the exclusion; and the snapshot never names `.respawnpack/` on `git add`, because git refuses a
pathspec naming an ignored path and an installed target gitignores it. Every git step's exit status is checked, so when git cannot produce a complete
snapshot (an unreadable file, an embedded repository with no commit, a pruned reviewed tree) the answer
is CANNOT_DETERMINE, "cannot verify the review", never a digest over whatever was readable. A receipt
written before this field existed is CANNOT_DETERMINE until a re-review records a fresh one.

⛔ **The working-tree digest is exactly as precise as `treeState`, blind spots included.** Untracked content is part
of the identity (as a `C:` content digest), but A3 bounds the untracked walk at 500 paths (name and size
beyond that, and a wholly untracked directory too large to walk is carried as one entry with its count),
so a same-size change to an untracked file past the cap is not seen by the digest any more than the Stop
hook sees it; the content tree, which git builds from every byte, has no such cap.

⛔ **Machine-local, and that is load-bearing.** The receipt lives under `.respawnpack/runtime/`, which the
installer gitignores, so a receipt from another clone does not exist by construction, and an absent one
is "never reviewed on this machine", a CANNOT_DETERMINE and never a pass, not "stale". It is also
**worktree-local**: it is written beside the worktree's own `.respawnpack/runtime/`, so a `/ship` run from
a different checkout of the same repository reads "never reviewed here" and reviews there, which is the
right answer, a review of one worktree is not a review of another. And it proves a review verb ran
against this tree, never that the review was good.

## The After Action Report (`aar`)

`lib/aar.js` is Class C: the pack writes down a great deal that is true and asks a person to reassemble
it themselves. This verb assembles it instead, into one document with its bottom line in the first
paragraph, and composes nothing it did not read somewhere: the compiled state at each end of the window,
the commits, the derived changelog entries dated inside it, and (labelled machine-local, because they
live under `.respawnpack/` and describe this machine) the last savepoint receipt, the candidate journal,
the delegation archive, and the guard-catch totals from `.respawnpack/runtime/catches.jsonl` (review
2026-09-23 §3: how many times the freshness check, the removal contract, `secret-scan` and `push-guard`
each withheld, refused or denied on this machine). The catch totals ride the machine-local gates block
beside the savepoint receipt, read through the same `hooks/_runtime.js` boundary, and like every
machine-local record their absence on another clone proves nothing.

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

- `docs/derived/STATE.json` is what SessionStart injects and what `/respawn` validates first (its
  `sourceRevision` against HEAD). A stale projection is announced as stale; it is never presented as
  current. The first DOCUMENT `/respawn` reads is `docs/derived/HANDOFF.md` (below), before CONTINUITY.
- `docs/derived/HANDOFF.md` is the **pointer-first handoff** (D3), the fourth render target and the first
  document a session reads. It renders six sections from the state the kernel already knows at `--write`
  — the current task (the contract mode, goal and atomic task), the next unblocked work with its TRUE
  `counts.nextUnblocked`, the open blockers, the files touched this session, the project's verify
  commands (the declared validator adapters plus `savepoint --verify`, listed, never run), and the
  **operations** (G17): a pointer to `.respawnpack/ops-log.jsonl` and `memory/incidents/`, the ops log's
  row count and last action from a frozen snapshot, and the open incident ids - each opening
  with where the complete record lives. It is a PROJECTION, never a third record: it points at STATE.json,
  goal.json, the precompact record, CONTINUITY, the ops log and the incident library rather than copying
  them (the Operations section carries a count and ids, never a result or a fix body). It has no NOTE block
  of its own; its generated block points at CONTINUITY's note (one note, not two). **The files-touched and
  ops-log sections are WRITE-TIME SNAPSHOTS.** `savepoint --write` computes the delta once - the session's
  tree delta against the baseline through `hooks/_runtime.js`'s `sessionDelta`, or, when this session has
  no baseline, the uncommitted files bounded and truncated with the count, never an empty delta, and
  always minus the savepoint's own `docs/derived/**` and `memory/candidates/**` outputs - and freezes it,
  with the ops log's row count and last action, into `STATE.json.handoff`
  (`{ writeCycle, filesTouched, opsLog? }`) under a short cycle id named in the files-touched heading. The
  open incidents are read LIVE on both write and verify (the library moves only by a verb, the way the
  lessons counts are read). A later `--verify` renders the files-touched and ops-log sections FROM that
  snapshot and never calls `treeState`, so the savepoint's own ops-log row (appended after the render) and
  any operator row between writes never make a verify disagree with a fresh render, and the
  live tree moving between a write and a verify cannot make the generated block disagree with a fresh
  render (and a verify pays none of `treeState`'s cost). `state-writeback` excludes `handoff` from its
  durable digest, since a fresh compile carries none. It is bounded to a **byte cap** (default 1,600 B,
  overridable by `state.handoffByteCap`) as the inner bound and 1,500 words as the outer one, cutting its
  longest list with a "N more in STATE.json" line and never a pointer, so a busy project cannot bust the
  boot budget unseen. Its one numeric claim (next unblocked) is verified back against STATE.json by
  `verifyRendered`, its generated block against a fresh render; a hand edit FAILs. Like LESSONS it is fully
  generated — created by the first `--write`, re-rendered after, with no migration or `restore-derived`
  story — and its volatile `_Generated` stamp is stripped from the corpus digest (`hooks/_manifest.js`) so
  a bare `--verify` straight after a `--write` stays idempotent. **The `state` verb's read-only staleness
  report covers CONTINUITY/GAPS/LESSONS only; HANDOFF.md is deliberately not among them, because its
  files-touched is a write-time snapshot that only `savepoint --write` refreshes.** A `--write` that
  renders it also refreshes **one** `project` line in the host's native auto-memory `MEMORY.md` pointing at
  it (a `respawnpack-handoff.md` memory file plus one index line, rewritten in place, idempotent), with two
  outcomes that never fail the savepoint: PASS, and NOT_APPLICABLE when no auto-memory directory exists OR
  when the host's 200-line / 25 KB cap or a write fault withholds the index line (the memory file is still
  written) — a machine-local projection must never decide the project's verdict, so it is NOT_APPLICABLE
  rather than CANNOT_DETERMINE. `uninstall.js` removes the pointer (the file and the anchored line, a
  user's own lines kept; NOT_APPLICABLE when no directory resolves). The line carries the pointer sentence
  only, never project content, and a `--verify` never touches the memory directory: only a writing run updates the pointer.
  The host is not documented to read another program's memory file, so the line is a convention, not a
  contract.
- **The savepoint's own commit is not drift.** The documented closeout commits the regenerated docs
  *on top of* the work they describe (`docs(savepoint): regen at <W>`), so HEAD is always one commit
  past `sourceRevision` afterwards. `sourceRevision` is therefore bound to the nearest ancestor of
  HEAD that is **not savepoint-only** (a single-parent commit touching only `docs/derived/**` or
  `memory/candidates/**` and nothing under `docs/derived/state/` (the compiler inputs) except
  `docs/derived/state/corpus.json`, which B3 made a savepoint OUTPUT listed by name), and every
  reader (boot, `status`, `doctor`, the Stop hook, evidence binding, the generated-block check)
  treats HEAD and that ancestor as the same source. One definition, in `hooks/_manifest.js`
  `sourceRevisions()`, bounded to 16 commits and strict on truncation. Any commit that touches
  anything else ends the walk and is `STALE` exactly as before.
- `docs/derived/CONTINUITY.md` contributes only its `RESPAWNPACK:NOTE` block, the sentence a human
  wrote. Numbers come from the structured source. Its generated block is **bounded** (B3): it carries the
  counts and the bounded `nextUnblockedWork` list with the TRUE `counts.nextUnblocked` total beside it,
  never the whole list. `docs/derived/GAPS.md` renders the top `GENERATED_ROW_CAP` requirement rows by
  priority (failing mandatory first, then blocked, then the rest) and a "N more in STATE.json" line; the
  whole set stays in `STATE.json` and the count line is over all of it, so no row is dropped and every
  verify check still binds. A hand edit to the "N more" count differs from a fresh render and FAILs
  `generated-block`.
- `docs/derived/LESSONS.md` is the third render target: the **lessons register**, a projection of the
  memory store rather than of `STATE.json`. It renders one row per VOUCHED entity promoted into
  `memory/graph/<type>/<slug>.md` — the id, its first observation, `promotedAt`, the `verifiedBy` that
  earned the promotion, and the skills its `applies-to|skill:` relations name — then the counts of
  candidate and rejected leads in `memory/candidates/`, under the labels `verified lessons`,
  `candidate leads` and `rejected leads`. Because those numbers are not in `STATE.json`, `verify`
  checks them with `render.js`'s `verifyLessons` rather than `verifyRendered`: the DF-011 pair is
  extended, never half-applied. **G7 added three derived views over the same rows, each with its own
  verified count:** an entity any other entity carries a `supersedes|<id>` relation to renders
  `superseded by <id>` (derived, not stored, so its file is never rewritten; a chain shows only the
  latest as current and a cycle is named); entities with no `verifiedBy` render in a `## Unvouched`
  section with their path, excluded from the verified table and its count (`verified lessons` is now the
  vouched entities only); and a `## Stale by horizon` list carries lessons whose `asOf` (defaulting to
  `promotedAt`) is older than the project's `memory.staleHorizonDays` (default 180, `0` disables it with
  a NOTE), measured against the store's newest date rather than the clock so the generated block never
  drifts on time. **G14 clamps that reference against future `asOf` dates:** the newest vouched date is
  dropped (and the next-newest used) when it stands more than the horizon beyond the next-newest REMAINING
  vouched date and the entity has no alibi, and the drop REPEATS newest first so a chain of forged future
  dates is cleared, not only the newest. The alibi is a parseable `promotedAt` within the horizon of the
  `asOf` (the clock-free signal that the date is a legitimately recent lesson, not a future typo), so a
  recent lesson stays the reference; a vouched entity with no parseable `promotedAt` has NO alibi and is
  clamped on the gap alone, because promotion always writes `promotedAt` and its absence means a
  hand-authored file. Each excluded entity is named in the stale section as a verified claim. This closes a
  future `asOf` over a past or missing `promotedAt`, and chains of them, but NOT a forged pair whose `asOf`
  and `promotedAt` are both set to the same future date: without a clock that pair is indistinguishable
  from a legitimately recent lesson, and a clock inside the verified block is what G4 forbids, so the
  forged pair evades the clamp and ages its siblings; G19 renders an unverified line beside the stamp (the lines beside the stamp, below) naming any vouched entity whose effective date lies after the render clock, so the forged pair is visible without a clock entering the verified block. Promotion guards the door. `promote` writes `**Klass:**` from `--as`, `relations` from `--relates`/`--supersedes`,
  and `asOf` from `--as-of`; a repeat to the same target is byte-identical (those fields come from the
  store or the entity on disk, never the clock). An absent memory directory is a counted zero that names itself; a
  record that cannot be read withholds the count instead of printing one. The file is fully
  generated, so a project without one gets it CREATED by the first `--write` and it carries no
  migration or `restore-derived` story. A run that CAPTURES a candidate memory re-renders the
  register afterwards, so the stage that changed the store never leaves its projection behind — but
  only when the register was in step to begin with, since a check-only run must not repair a
  document it has just reported as wrong. `memory/graph/**` is read **once per invocation**:
  `readGraphEntities` memoises its result (invalidated when a promotion writes a new entity), because
  the graph cannot change within one CLI run, so the pre-capture snapshot and the post-capture
  re-render share the one read; the candidate half is never memoised, because capture moves it mid-run
  and the re-render must count the moved store.
  document it has just reported as wrong. "In step" is **stamp-blind**: the `_Generated <time>._`
  line lives outside the generated block that check compares, so a register whose only difference
  from a fresh render is its timestamp still counts as in step: it is neither rewritten every run for
  the stamp alone nor left failing on it. **LESSONS.md carries three unverified lines there, beside the
  stamp and outside the generated block.** G14's age line, `_Newest vouched lesson dated N day(s) before
  this render..._` (or `_No vouched lesson carries a date._`), has N computed from the render clock so a
  dormant project shows its dormancy without a clock inside the verified block. G8's behind line (below)
  reports how many vouched lessons are bound to a revision the current tree has moved past. G19's
  future-dated line renders only when a vouched entity's effective date lies after the render clock, `_N
  vouched lesson(s) dated AFTER this render...: `<id>` (<date>), ..._`, naming the entities newest first and
  bounded at eight, so a forged pair that evades the clock-free clamp is still visible. Like the stamp each
  is a clock reading, never a claim: `verifyRendered`/`verifyLessons` never check them and the corpus digest
  strips them (`hooks/_manifest.js`), so a bare `--verify` after a `--write` stays idempotent. **G8 binds a
  lesson to the revision of the world it was true in.** Promotion takes `[--world commit[:<sha>] |
  doc:<path> | estate:<serial> --estate-source <path>]` (every flag validated before the store is touched,
  the G7 rule; with no `--world` a lesson is bound to `commit:<the candidate's cycleId>` when that cycle is
  a sha, else left unbound), writing three flat frontmatter fields read back byte-identically on a repeat.
  The table gains a `bound to` column (a verified claim derived from those fields, so a hand edit FAILs
  `generated-block`), and a third unverified line beside the stamp reports how many vouched lessons are
  **behind** the current revision, computed WITHOUT network (a commit binding against the EFFECTIVE source
  revision, by chain membership, so a savepoint-only commit above the work does not read it behind; a
  document binding against the file's current digest; an estate binding against the tracked source file's
  first line). It is a live reading like the age line, never checked and stripped from the corpus digest, so a
  HEAD or a bound file that moves between a `--write` and a bare `--verify` never fails the register.
  `doctor` carries `memory:behind-revision` (advisory), `memory:binding-malformed` (advisory),
  `memory:revision-undeterminable` (CANNOT_DETERMINE, exit 2, so a bound revision that cannot be read is
  never a silent PASS) and `memory:infra-reverify` (an estate-bound lesson promoted more than
  `memory.staleOpenLeadSessions` savepoint cycles ago, or named "not aged" when its promotion cycle is not
  on record (hand-authored, or a lineage target no longer in the store)). What it does NOT prove: behind is
  a re-verify trigger, never that a lesson is wrong; the pack cannot read a live estate over the network, so
  an estate binding is only as current as the tracked source file the project keeps; and a document digest
  folds CRLF to LF before hashing, so a line-ending flip is not a move while any other byte is. The date
  horizon stays `memory.staleHorizonDays` at 180 and stays the register's stale list; no new config key.
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
imports its prose into the protected NOTE block, and is idempotent. Without `--write` it never rewrites
the rendered docs or `STATE.json`, which a verify-only run compiles **in memory** and compares against
the copy on disk (`generatedAt` excluded) rather than rewriting: agreement is `state-writeback PASS …
left untouched`, disagreement is a FAIL that names `--write` as the fix. A verify-only run is **not**
write-free, though. It writes: (1) `.respawnpack/runtime/savepoint-attempt.json`, the machine-local
record of this attempt, every run; (2) a candidate lead under `memory/candidates/` (plus its line in
`memory/candidates/audit.jsonl`, both tracked) for each FAIL or CANNOT_DETERMINE row it captures;
(3) `docs/derived/LESSONS.md`, re-rendered only when that capture moved a count it states and it was
in step beforehand; and (4) `STATE.json` when none exists yet. It also runs the configured validator
adapters, which are external commands with their own effects. It never appends an ops-log row,
updates the host auto-memory pointer, folds the wave ledger, writes a graph entity, re-records a
removal catch, or rewrites the corpus digest; those belong to `--write`.

The NOTE block is **bounded, never silently**: `NOTE_BUDGET` is 700 **words** (whitespace-separated
tokens, counted by one `countWords` the budget, the marker, the migration seed and this README all
share; a note, not a second handoff document). The field hit the old 1,200-character budget repeatedly,
keeping real handoff state in the note, so B3 raised it to the owner's word count. A note over budget
makes `savepoint` emit a `note:budget:<file>` **FAIL** in `--verify` before anything is cut, naming the
length in words and where the full text would go. `--write` keeps the first words, ends the block with a
visible marker (inside the budget, so a re-render is stable):
When `docs/derived/` is itself a scanned live-content directory (so the corpus manifest inside
`STATE.json.removals` digests the kernel's own CONTINUITY.md and LESSONS.md), the corpus digest of
those two documents **excludes their volatile `_Generated <time>._` line** (and LESSONS.md's G14 age
line and G8 behind line beside it): the render re-stamps it
every run, and without the exclusion a bare `savepoint --verify` after a `--write` FAILed
`state-writeback` over a timestamp, minted a lead whose claim carried the moving digests (never
deduped) and re-rendered, which moved the stamp again: a verify that could never pass twice. The body
is still digested whole, so a real reintroduction or any hand-edit outside the stamp (or the age line) still moves the
digest, and a stale generated doc whose stamp has NOT moved is still caught by its content. The strip
is named by path (the kernel's own generated docs), never guessed from a `_Generated`-looking line in
a hand-authored file, and the digest is defined once in `hooks/_manifest.js` so the writer and the
boot reader cannot disagree.

That alone fixes the TIMESTAMP, but the render also moves the CONTENT of those documents AFTER
`STATE.json` is persisted: `STATE.json` is written at the `writeback` stage, before `render`, the
register refresh and the wave-ledger fold run, so a `--write` that bumped a LESSONS count or re-rendered
a body left the committed manifest describing the pre-render tree, and one `--write` never converged.
So a writing run, after every document is on disk, **re-digests the render targets from their final
bytes through the same stamp-blind path and re-persists the corpus manifest and its per-file findings**,
verified by a digest read-back exactly as the `writeback` write is. It spends no second
`runRemovalScan` (the digest is `hooks/_manifest.js`'s, not the scan's), and for any generated document
whose bytes moved after the post-render scan (the wave-ledger fold rewrites CONTINUITY, the register
refresh rewrites LESSONS) it RE-PARSES that file's findings with the scan's own active phrases through
`corpusFindingsFor`, so the recorded manifest and findings describe the same bytes. Without the re-parse,
A5's incremental carry would trust a byte-identical file with a stale "clear" and a killed-feature phrase
the fold wrote would read clean until a `--full`; with it the next bare `--verify` catches it. It
re-persists only when a document actually moved. On the FIRST `--write` of a checkout that never carried
D3's `HANDOFF.md` or B3's `corpus.json`, those files are CREATED by the render inside the scanned tree, so
the pre-render compile froze a smaller `removals.scannedFiles`/`why` than the final tree carries; the same
re-persist takes the removals verdict's file-set fields (`scannedFiles`, `why`, `notScanned`, `unreadable`)
from that post-render scan too (never a third scan, so the scan-count fence stays at two), so the first
bare verify agrees rather than FAILing `state-writeback` until a second write (G18). A single `savepoint
--write` is therefore idempotent: the next bare `savepoint --verify` PASSes `state-writeback`. The one
thing that still FAILs is a hand edit to a generated document between runs, which is the bypass and the point.

The window that remains, named: the removal VERDICT rows a writing savepoint prints come from the
post-render scan, which runs before the fold, so the `--write` that folds a reintroduction into CONTINUITY
still prints `removals:clear` for it on that run. It is not silent about it: the `state-writeback:converge`
row notes that the record now carries N live occurrence(s) written after the scan, in which document, and
that the next savepoint reports them. The re-parsed findings are recorded, so the NEXT savepoint (verify or
write) catches it. A fold-introduced reintroduction is caught one savepoint later, never only at `--full`.

A one-off `state-writeback` FAIL is **reported** (the row stands and the exit code is 1) but **filed as
a lead only when it persists across two consecutive runs**, recorded in `.respawnpack/runtime/`; a run
that PASSes or could not run (CANNOT_DETERMINE) breaks the streak and clears the marker. The lead's
claim is the stable "STATE.json is stale, run `--write`" rather than the moving digests, so a genuinely
stale tree verified again and again files exactly one lead rather than a new one each time the register
refresh shifts the digest.

The NOTE block is **bounded, never silently**: `NOTE_BUDGET` is 1,200 chars (UTF-16 units, a note, not
a second handoff document). A note over budget makes `savepoint` emit a `note:budget:<file>` **FAIL**
in `--verify` before anything is cut, naming the length and where the full text would go. `--write`
keeps the first chars, ends the block with a visible marker (inside the budget, so a re-render is
stable):

```
…[note truncated at 700 words — N words dropped; full text archived to …]
```

and archives the whole note verbatim to `docs/derived/_archive/<name>.note-overflow-<day>-<digest>.md` **before** the bounded
document is written. The next run passes once the block fits. The migration seed above is sized to fit
the same budget with its archive-naming trailer intact.
