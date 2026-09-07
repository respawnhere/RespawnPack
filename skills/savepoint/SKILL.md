---
name: savepoint
description: End-of-session documentation procedure for a RespawnPack docs/ spine: regenerates the DERIVED docs (CHANGELOG/GAPS/CONTINUITY) from git and the canonical docs, surfaces any CANONICAL edits for owner confirmation, and runs a drift-check. The counterpart to /respawn.
when_to_use: "savepoint", "/savepoint", "save", "save the session", "checkpoint", "closeout", "/closeout", "close out", "wrap up the session", "end of session", "session handoff", "update the docs", "regenerate the changelog / gaps / continuity"
---

# /savepoint — end-of-session documentation procedure

Keeps the `docs/` spine from drifting: it writes the handoff the next `/respawn` loads. Read `docs/README.md` for the model. In short:

- **CANONICAL** (`docs/*.md`, root `CLAUDE.md`/`AGENTS.md`) — hand-authored at decision time. `/savepoint` **proposes** edits but **never writes them without owner confirmation**.
- **DERIVED** (`docs/derived/*.md`) — **regenerated here, never hand-edited.**
- **REFERENCE / SKILLS** — touched only when a procedure changes.

> Run manually at the end of each session (~2 weeks to stabilize the steps), then a `Stop` hook can run it automatically. **This skill never pushes; it commits only when explicitly asked.**

## Config (set per repo)
- `routeSource` — how routes are discovered (e.g. `app/**/page.tsx`, `pages/**`, `src/routes/**`, a router manifest). Used by the routes↔matrix drift-check.
- `codeTruth` — the canonical-by-code paths (design tokens, copy strings, schema) used by the tokens↔docs drift-check.

⛔ **Each of these has three states, and an absent key is the third one.** Configured (real paths), declared
not applicable (`{"notApplicable": true, "reason": "..."}` — the reason is required), or **undecided**, which
is what an absent key means. Undecided is honest and is not a failure, but it is not release-ready either:
the coverage verdict below stays `CANNOT_DETERMINE` and the run does not exit 0. Resolve it in `/respawn`
Step 2, never here. An install from before the templates were removed may carry the literal
`<set ROUTE_SOURCE>` / `<set CODE_TRUTH: …>`; those are reported as INVALID and are never read as a value —
handed one, this step's route enumeration would match nothing and report no drift.

## Step 0 — Scope the session
- `git log --oneline -20` → find the range since the last `docs(savepoint)` commit (or session start) = `<SINCE>`.
- `git diff --stat <SINCE>..HEAD` + `git status` (include uncommitted work).
- Read the scratch activity log if a PostToolUse capture hook is installed (optional).

## Step 1 — Regenerate the DERIVED set (wholesale, never hand-edit)
- **`docs/derived/CHANGELOG.md`** — append a session entry from Step 0's scope: commits and the uncommitted diff or status alike (group feat/fix/docs). A savepoint often runs before the owner commits, so the git log alone would miss that session's entry. Removals reference `DECISIONS.md` by `D-id`, never re-described.
- **`docs/derived/GAPS.md`** — roll up OPEN gaps; **recompute counts FROM the rows**. Pull build-gaps from `FEATURES-PAGES.md` §5 + deferred from `PRODUCT.md`. Drop anything closed this session.
- **`docs/derived/CONTINUITY.md`** — a fresh next-session snapshot (the handoff `/respawn` reads). **Strip ephemeral git state** (commit hashes, "N ahead"). Point to canon. Capture current state + standing reminders.
- **`docs/derived/LESSONS.md`** — the lessons register, and the one derived doc you never write by hand at all: `savepoint --write` (Step 2b) renders it in full from `memory/graph/**` (one row per promoted entity: what it is, its first observation, when it was promoted, the verification that earned it, and the skills its `applies-to|skill:` relations name) plus the count of leads still sitting in `memory/candidates/` awaiting review. Both counts are re-derived from those files on every run and checked back against them, so a stale number here is a `FAIL`. A project that has no `LESSONS.md` gets one created by the first `--write`; there is no hand-authored original to migrate and nothing for `restore-derived` to put back.
- **`.respawnpack/wave-ledger.md`**, if present — `savepoint --write` (Step 2b) folds it automatically: one changelog line per dispatch group into `CHANGELOG.md`'s most recent entry, its current state into `CONTINUITY.md`'s generated block, then deletes the ledger. It's scratch, mid-run state; its permanent home is always these derived docs, never itself. A tracked ledger is never folded or deleted; it reports `wave-ledger` NOT_APPLICABLE instead.

## Step 2 — Surface CANONICAL edits the session implies (PROPOSE, don't auto-write)
Scan the diff for anything that changes product truth; present a checklist for owner confirmation; apply only what's confirmed.
- New / changed / **removed** feature → `PRODUCT.md` row + status (a removal → flip to ⛔ killed **and** add a `DECISIONS.md` entry via the ⛔ removal channel).
- New route/page or nav change → `FEATURES-PAGES.md` row (+ the routes↔matrix check, Step 3).
- A decision or reversal → a new `DECISIONS.md` `D-NNN` entry.
- A token/brand/design change → `DESIGN.md` (defers to code).
- An architecture/roadmap shift → `ARCHITECTURE-ROADMAP.md`.

## Step 2b — Run the executable verification (do this BEFORE reporting anything)

```bash
node .claude/respawnpack/respawnpack.js savepoint --verify --json
```

**Exit codes are three-valued and you must treat them as three:** `0` PASS · `1` FAIL · `2`
CANNOT_DETERMINE. **A check that could not run is not a pass.** Do not pipe this through anything before
reading `$?` — reading an exit status through a pipe captures the wrong process's status, and that
alone accounted for the first of seven drift-checks that silently failed in a real run.

What it does that a human re-read cannot:
- recompiles `docs/derived/STATE.json` from the structured sources **in memory** and **recomputes every
  count from rows** — never carrying one forward. Without `--write` the copy on disk is compared, not
  replaced: agreement is `state-writeback PASS … left untouched`, disagreement is a FAIL that names
  `--write` as the fix, and nothing in the tree changes (the only verify-only write is creating a
  `STATE.json` that does not exist yet);
- renders the derived docs from that state and then **verifies every rendered number back against its
  source**, failing on disagreement;
- runs any project validator adapters declared in `respawnpack.config.json` (e.g. `tools/validate.py`,
  `tools/verify_docs.py --verify`) and **discards the verdict of a critical adapter that cannot be shown to
  answer differently for a known-good and a known-bad control**;
- proposes structured memory entries from the session.

⛔ **Do not report a successful savepoint on a non-zero exit.** The failure this whole step exists to
prevent is a savepoint that "passed all five drift checks" while the documents the next session boots
from described a project state that had not existed for a day. If the command exits `1`, fix the
disagreement it names. If it exits `2`, say which check could not run — do not round it down to green.

### Scoping a savepoint — `--only` / `--skip`

A savepoint is **ten named stages**, run in this order:

<!-- savepoint-stages -->
`compile` · `writeback` · `render` · `verify` · `removals` · `lineage` · `reconcile` · `coverage` · `adapters` · `memory`

`--only a,b,c` narrows the run to those stages; `--skip a,b,c` drops them. Both are comma-separated and
both may be repeated. Every posture profile runs all ten by default.

```bash
node .claude/respawnpack/respawnpack.js savepoint --verify --only compile,render,verify --json
node .claude/respawnpack/respawnpack.js savepoint --verify --skip adapters --json
```

⛔ **A scoped run is a PARTIAL savepoint and you must report it as one.** Every stage that did not run
emits a `stage:<name>` row at `NOT_APPLICABLE` whose detail says **SKIPPED BY REQUEST**, the text output
leads its verdict with a `PARTIAL SAVEPOINT` line, and the `savepoint-attempt.json` receipt records
`stages: {requested, ran, skipped}`. Never describe a scoped run as "the savepoint passed" — say which
stages ran. A skipped stage establishes **nothing**: skipping `removals` on a project with a populated
`removals.json` prints the skip and never a `PASS`, because a scan that did not happen is not a clean
scan. The exit code follows the rows that ran, which is exactly why the skips are printed.

⛔ **The closeout is the full run.** A partial receipt deliberately carries **no `sourceRevision`**, so
the Stop hook keeps asking for a savepoint — a scoped run is a cheap check during a session, not the
end-of-session closeout. Use the unscoped command for Step 2b.

⛔ **`compile` is required and is never implied.** Every later stage reads the freshly compiled state, so
`--skip compile` — or an `--only` set that leaves it out — is **refused at exit 2** rather than run
against whatever `STATE.json` was already on disk. Write `--only compile,render,verify`, not
`--only render,verify`. An **unknown stage name is also refused at exit 2**, naming the valid set, and
nothing runs — no receipt is written and no stage is executed.

**Find the failing rows by `check`, not by `id` or `status`.** Every row in `checks[]` is
`{outcome, check, detail, checked, ...}` (`kernel/lib/outcome.js:34-47`; the full contract is documented
once in `kernel/README.md`). There is no `id` field and no `status` field on this array. Filter for the
rows worth reading:

```bash
node .claude/respawnpack/respawnpack.js savepoint --verify --json | jq -r '.checks[] | select(.outcome != "PASS") | .check'
```

That prints the stable id of every row that is not `PASS`, for example
`rendered-claims:docs/derived/CONTINUITY.md` or `note:budget:<file>`. Read that same row's `detail`
field for why it failed.

**Read the TWO verdicts before you read the exit code.** `--json` returns `verdicts.integrity` and
`verdicts.coverage`, and the text output prints them on one line:

- **Integrity** — did the machinery work: compilation, the digest-verified writeback, the rendered
  claims, the adapters, and every check whose subject this project has actually declared.
- **Coverage** — which optional contracts are configured, which are declared not applicable, and which
  nobody has decided about yet (`applicability` carries the per-contract rows).

`integrity: PASS · coverage: CANNOT_DETERMINE` is a specific, common, and **reportable** state: the pack
is working and onboarding is unfinished. Say exactly that, name the contracts in `unresolved`, and route
them to `/respawn` Step 2. Do not describe it as a broken savepoint, and do not describe it as a passing
one — the exit is still `2`, on purpose, because a project with unresolved contracts is not
release-ready. Splitting the report is the fix; splitting the exit code would be the manufactured green
one indirection further out.

**If `render:*` says "not yet migrated", that is a first-run step, not a savepoint failure.** A project
whose `CONTINUITY.md`/`GAPS.md` were hand-authored has no kernel-generated block, so those checks report
CANNOT_DETERMINE and **exit 0 is unreachable until the migration runs** — which is why SessionStart now
names it at boot instead of leaving you to meet it at closeout. `savepoint --verify --write` archives
each original **verbatim** to `docs/derived/_archive/<name>.pre-kernel.md` and imports its prose into the
protected NOTE block. It is **reversible**: `respawnpack restore-derived <CONTINUITY.md|GAPS.md>` previews
the undo and `--write` performs it, and the archive is never deleted, so migrate → restore → migrate all
resolve to the same original. Do it at the **start** of a session — it rewrites two documents.

**If `note:budget:*` FAILs, the NOTE block is over its 1,200-char budget — trim it, or accept the
archive.** The budget is deliberate (a note, not a second handoff document) and it is never enforced
silently: `--verify` reports the overflow before anything is cut, and `--write` keeps the first chars,
ends the block with a visible `…[note truncated at 1200 chars — N chars dropped; full text archived to
…]` marker, and archives the **whole** note verbatim to
`docs/derived/_archive/<name>.note-overflow-<day>-<digest>.md` first. Nothing is dropped; the row is
still FAIL so the cut is not reported as a clean savepoint, and the next run passes once the block fits.
Do not paste the archive back into the note — move durable content into the canonical docs (PRODUCT,
DECISIONS, a dated memo) and keep the note to what the next session must read first.

## Step 2c — Memory capture is now mechanical; review is the operator's job

Step 2b already **wrote** the candidates: every `FAIL`/`CANNOT_DETERMINE` check, every newly-stated
goal constraint, and every `--candidate "kind:text"` you passed became a durable, evidence-backed
**candidate memory** (`core/memory/candidates.js`, via `memory/candidates/<id>.json` + `memory/candidates/audit.jsonl`) —
capture is no longer something to remember to do. What is still yours is the review, and **silence is
still not a decision**: a captured lead that nobody reviews is exactly the "wrote it and it stayed
empty" failure one layer later, now shaped as "wrote it and nobody looked."

1. Run `node .claude/respawnpack/respawnpack.js memory candidates --json` (or read `--json`
   output's top-level `capturedCandidates` field / `memoryProposals[].candidateId` from Step 2b) and
   look at every `verificationState: "candidate"` row.
2. For each one, make an **explicit, recorded** decision:
   - **Promote** it once you have actually verified it — `memory candidates promote <id> --as
     <type>/<slug> --verified-by "<what proved it>"` (e.g. `--as gotcha/redis-retry-starvation`).
     `--verified-by` is REQUIRED and is not a formality: a promotion with nothing behind it is the
     implementing context qualifying its own work, the exact failure this gate exists to refuse. This
     writes the canonical entity to `memory/graph/<type>/<slug>.md` (memory/knowledge-graph.md's
     file-backed schema) and is idempotent — promoting the same id to the same `--as` twice is a
     recorded no-op.
   - **Reject** it with `memory candidates reject <id> --why "<reason>"` when it turned out wrong or
     not worth keeping. Also idempotent, also requires a reason.
   - **Defer** it explicitly (say so in the session summary) when it needs more information before
     either — an undecided candidate is a legitimate state, but a SILENTLY undecided one is not.
3. A root-cause/fix pair is never inferred from the diff — if you have one, state it now with
   `savepoint --candidate "root-cause-fix:<the pair, in your own words>"` (repeatable; also accepts
   `decision`/`constraint`/`finding`). Reconstructing a conclusion from memory rather than stating it
   is the failure ADR-001 exists to prevent.

A candidate is recallable only as an **unverified lead** until promoted (`memory/knowledge-graph.md`)
— never present one to a reader as an established fact.

## Step 3 — Drift-check (flag, don't silently fix)

*The mechanical half of this list is now Step 2b's job — counts, rendered claims and adapter verdicts
are checked by a program, not by remembering to look. What remains below is genuinely judgement work.*
- **Routes ↔ matrix:** enumerate `routeSource` ↔ `FEATURES-PAGES.md` §2 — every route has a row and every row a route (no orphans). Check the diff for added/removed routes. **Skip this and say so if `routeSource` is undecided or invalid** — enumerating an unset source matches zero routes and reports no drift, which is a check agreeing with everything.
- **Code ↔ docs:** no doc hardcodes a value contradicting `codeTruth` (tokens, copy, schema). Same rule: an undecided `codeTruth` means this check did not run, not that it passed.
- ~~**Killed features not resurrected:** grep the diff + docs for anything matching a `DECISIONS.md` ⛔ removal.~~ — **superseded by Step 2b.** This line was the whole enforcement behind "⛔ killed features are never re-added", and a field run measured what it was worth: a retired feature sat live and unmarked in a directory nobody's scanner read. `respawnpack savepoint --verify` now runs the structured contract (`kernel/lib/removals.js`) over **every configured live-content directory**. What is still yours: a removal only becomes enforceable once it has a row in `docs/derived/state/removals.json` naming the phrases that would reintroduce it. `respawnpack removals` prints which rows are guarded, which are `unverified`, and which directories were scanned — read it rather than assuming the absolute holds.
- **Provenance not adrift:** a cloned, copied, migrated or generated file whose marker names the wrong
  source, or whose source has moved since. `respawnpack savepoint --verify` runs the tenth stage
  (`kernel/lib/lineage.js`) over every derivation declared in `docs/derived/state/lineage.json`,
  recomputing the digest each marker records against the source on disk rather than trusting what the
  marker says. What is still yours: a copy only becomes checkable once it is declared there and stamped —
  `node .claude/respawnpack/respawnpack.js lineage stamp <target> --from <sourceId>` writes the marker
  after you clone, copy, migrate or generate. No declaration at all reports `NOT_APPLICABLE`, not a gap.
- **Built-vs-held conflicts:** a `PRODUCT.md` 🔒 feature that gained/lost a live route.
- **Stale cross-refs:** broken links to moved/renamed docs.
- **Counts:** model/route/etc. counts cited in docs vs reality.
- **Skills' referenced facts:** light pass — does any `.claude/skills/*` reference a file/flag/endpoint that changed?
- **Living-skill drift:** run [`/skill-guard`](../skill-guard/SKILL.md)'s drift-check (Mode A) over the pack's owned skills, flagging any that drifted from their frozen baseline.
- **Compliance regime drift:** a new data class / jurisdiction / sub-processor in the diff that isn't reflected in `compliance.config.md`, `docs/compliance/RoPA.md`, or `docs/compliance/REGISTER.md` — flag it for a `/comply` pass.
- **Dependency currency:** flag dependencies one or more major versions behind (e.g. `npm outdated`) as a `GAPS.md` row — this is currency drift, not a vulnerability finding, so keep it separate from any CVE/security results.

## Step 4 — Output
Write a short savepoint summary: what shipped (the changelog entry), which derived docs were regenerated, which canonical edits were applied (owner-confirmed) vs proposed-and-deferred, and the drift-check findings. Optionally stage a `docs(savepoint): regen at <hash>` commit. **Do not push** without an explicit go-ahead.

That commit moves HEAD one past the revision `STATE.json` describes, and that is **expected, not drift**: a
commit whose diff touches only `docs/derived/**` and `memory/candidates/**` (and nothing under
`docs/derived/state/`, the compiler inputs) is *savepoint-only*, and every reader — SessionStart, `status`,
`doctor`, the Stop hook, the generated-block check — treats it as the same source as the work it saved.
Keep it that way: commit the session's **work** first and the savepoint output separately. A commit that
mixes code with the regenerated docs is not savepoint-only, so the state it carries is bound one commit
behind and reads `STALE` until the next savepoint — correctly, because the source moved.

## Invariants
1. **Never hand-edit a DERIVED doc** — regenerate it.
2. **Never auto-write a CANONICAL doc** — propose in Step 2, apply only on confirmation.
3. **WRITE-ONCE:** each fact has one canonical home; everything else references or is generated from it.
4. **No push; commit only when asked.**
