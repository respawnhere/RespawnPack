---
name: respawn
description: The session-start role — boots a session from generated current state (docs/derived/STATE.json, revision-validated before it is trusted), then the human note in CONTINUITY, canonical truth (PRODUCT/DECISIONS, incl. ⛔ killed features), memory for gotchas, and the tree. Surfaces contradictions instead of picking a source. Reads exactly what /savepoint writes.
when_to_use: "respawn", "/respawn", "start", "/start", "resume", "/resume", "boot the session", "load the handoff", "where did we leave off", "pick up where we left off", "what's next", "new session", "catch me up"
---

# /respawn — boot a session from the last savepoint

The first thing you run in a new session. `/savepoint` writes the handoff at session end; `/respawn` loads it at the start, so you begin oriented instead of cold and don't re-investigate a solved problem or re-propose a killed feature. Orientation only: it **reads and proposes**, and does not change code until you confirm the direction.

## Step 0 — Load current state, and validate it before trusting it

```bash
node .claude/respawnpack/respawnpack.js status
```

**`docs/derived/STATE.json` is the primary handoff** — generated, schema-versioned, revision-bound. It
carries the live facts: goal and milestone *as separate things*, the current atomic task, per-requirement
status, counts derived from rows, open P0/P1, scoped blockers with their exact missing authority, next
unblocked work, evidence freshness, and an explicit list of what could not be determined.

⛔ **Validate before quoting — and a matching revision is NOT enough.** `status` now checks the
recorded digest of every compiler input, so an UNCOMMITTED edit to `requirements.json` makes the state
stale at an unchanged HEAD; when it does, `status` exits 2 and WITHHOLDS the counts rather than printing
them beside a warning. Treat a non-zero exit as "there is no current count", not as "the tool complained".
If `sourceRevision` differs from `git rev-parse HEAD`,
STATE.json is a projection of an older revision — say so, run `node .claude/respawnpack/respawnpack.js state` to refresh, and do not
repeat a number from it as current. A stale projection presented confidently is the failure this whole
layer exists to prevent.

⛔ **`state` refreshes STATE.json only — it does not touch CONTINUITY.md or GAPS.md.** Rendering and
writing those two is `savepoint --write`'s job alone. `state`'s report now names any rendered doc that
has fallen behind: a `generated-block:<file>` row means that file's generated block no longer matches
the state you just refreshed. It is CANNOT_DETERMINE, not a FAIL — `state` reports the staleness, it
does not gate on it, so its own exit stays 0 over that row alone. Treat the row as the instruction it is
naming and run `node .claude/respawnpack/respawnpack.js savepoint --write` next; running `state` again
only reconfirms the same staleness.

⛔ **Surface contradictions; never pick a source silently.** If STATE.json, the git tree, and the wave
ledger disagree, report the disagreement. The kernel exits `2` (`CANNOT_DETERMINE`) rather than choosing,
and so should you.

Then, and only then:
- **`docs/derived/CONTINUITY.md`** — read the `RESPAWNPACK:NOTE` block. That is the human note: prose a
  person wrote about where things stand. Everything below the `GENERATED` marker is rendered from
  STATE.json, so reading it is redundant and *quoting* it instead of the source is how prose and truth
  drift apart.
- **`docs/derived/GAPS.md`** — generated from the same rows; skim only if you need the per-row table.
- **`docs/derived/CHANGELOG.md`** — history. **Not** part of default boot context; open it only when the
  session actually needs the past.
- **`.respawnpack/runtime/precompact-<session>.json`** — if a compaction happened, the SessionStart hook
  has already injected and consumed this. Read it directly only when the injection is missing.

If there is no `STATE.json`, say so — either this project has not adopted the state kernel (boot from
CONTINUITY.md and treat its contents as **unverified assertions**, not derived facts), or `/savepoint`
has not run yet.

## Step 0b — Know which contract you are in

```bash
node .claude/respawnpack/respawnpack.js contract
```

`collaborate` (the default) means orientation only: read, propose, and wait for direction. `delegate`
means one bounded task with acceptance criteria. `goal` means explicit autonomous work — select the next
bounded unblocked unit from `nextUnblockedWork` and honor the goal's constraints and forbidden actions.

⛔ **Never infer `goal` from a task looking big.** If the user wants autonomous completion they say so,
and it gets recorded with completion criteria.

## Step 1 — Orient to canonical truth
Skim the canonical docs enough to not contradict them:
- `docs/PRODUCT.md` — what exists and its status (live / held / deferred / **killed**).
- `docs/DECISIONS.md` — recent decisions and, critically, the **⛔ removals**. Note them so you never propose resurrecting a killed feature this session.
- `docs/FEATURES-PAGES.md` — only if the session's likely work touches routes/flows.

## Step 2 — First-run adoption interview (skip once the pack is configured)
Trigger: run `node .claude/respawnpack/respawnpack.js doctor --json` and read the `onboarding` row. `INCOMPLETE` means at least one optional contract is still undecided; the canonical docs still being templates (unfilled `<PLACEHOLDERS>` in `PRODUCT.md`/`DECISIONS.md`/etc.) is the other trigger. If neither is true, skip straight to Step 3. If the docs are unfilled **and the repo already holds a real codebase** (a brownfield adoption), recommend typing `/onboard` before hand-filling anything — it drafts the spine docs from code evidence and walks a per-section confirmation (proposals only; WRITE-ONCE holds) — then continue the interview below either way.

(a0) **Resolve every undecided contract. This is the part that must not be skipped.**

⛔ **An optional contract has three states, and "nobody asked" is one of them.** A dogfood run installed
the pack on a fresh repo, left every optional contract unanswered, and got a flat `CANNOT_DETERMINE` for
the rest of the project's life. The kernel was right and the onboarding was incomplete, and the two
tempting repairs — treat `CANNOT_DETERMINE` as a healthy terminal state, or relax the zero-work checks
until something goes green — are both the defect this pack exists to refuse. The fix is here: **ask.**

`doctor --json` returns an `applicability` survey with one row per contract, each carrying its `state`,
how it got there (`basis`), and the `remedy` that would resolve it. For **each** row that is not
`CONFIGURED` or `NOT_APPLICABLE`, ask the human — `AskUserQuestion` is the right tool, one question per
contract, options drawn from the row's own `remedy`:

| Contract | Configure it by | Or declare it not applicable |
|---|---|---|
| `removals` (killed features) | `state.removals.liveContentDirs` + rows in the registry | `state.removals.notApplicable` + `reason`, **or** `"emptyBaseline": "<why nothing has been retired yet>"` in the registry when the scan is configured and the project has genuinely retired nothing |
| `reconcile` (task list ↔ project records) | `state.reconcile.tasks` + `state.reconcile.project` | `state.reconcile.notApplicable` + `reason` |
| `requirements` (approved denominator) | write `docs/derived/state/requirements.json` | absent is already `NOT_APPLICABLE` — a project may track no denominator |
| `routes` | `routeSource` = the glob that enumerates this project's routes | `"routeSource": {"notApplicable": true, "reason": "..."}` |
| `codeTruth` | `codeTruth` = the token/copy/schema paths that outrank prose | `"codeTruth": {"notApplicable": true, "reason": "..."}` |

Three rules hold while you do this:

1. **Never answer on the human's behalf.** Finding no `app/` directory is not permission to declare the
   project routeless; an empty registry is not evidence nothing was ever retired. `NOT_APPLICABLE` is a
   claim somebody makes and can be held to, which is why the reason is mandatory and why the kernel
   rejects an opt-out without one.
2. **Undecided is a legitimate answer to give today.** If the human doesn't know yet, leave it — say so
   in the boot summary and move on. It stays `CANNOT_DETERMINE`, it keeps blocking release readiness,
   and that is the correct, visible state. What is not acceptable is leaving it undecided *silently*.
3. **Propose the edit; never write it.** WRITE-ONCE holds here as everywhere: show the exact
   `respawnpack.config.json` diff and apply only what the human confirms.

**Progressive activation.** A young repo should start with a small true contract and pick checks up as
the artifacts they read appear, so re-ask a contract when its `artifact` field shows one has arrived —
a route tree that now exists, a `requirements.json` that now exists, a first row in the removal
registry. That is a prompt to decide, never a decision: the survey reports what it found and changes
nothing on its own.

(a) **Optional extras.** Offer, via `AskUserQuestion` (multiSelect): the Compound Engineering plugin, the ui-ux-pro-max design pack, the Cloudflare skills pack, the Anthropic official plugins, the vendor MCP servers for the stack `respawnpack.config.json.opsTargets` already detected (Supabase/Fly/Cloudflare), the research-reach MCP pack (default: playwright-mcp + firecrawl — universal, not stack-gated), and Graphify (structural code graph via the `/mcp-graphify` skill — a read-only, optional external tool: `pip install graphifyy==0.9.10`, needs Python + pip, not installed by the RespawnPack installer; answers what-calls-X, blast-radius, and symbol-path questions, while WHY-questions and concept searches still go to the memory layer). For each one accepted, print its add command from `catalog/README.md` and propose an edit adding it under the `extras` key in `respawnpack.config.json` (array of accepted extra names + the date offered); Graphify has no ready-to-run add command yet at this point (its MCP server needs an extracted `graph.json` path first), so accepting it just records `"graphify"` under `extras` and points the user at `/mcp-graphify` for the extract-then-serve setup. That printed command follows the routing rule (`ops/README.md`, "Which way does a server connect?") for the MCP-server extras: firecrawl (the default-pack keyed/third-party instance) prints the gateway path (`docker mcp secret set` then enable via `/mcp-runtime`) as primary with the direct `--env` command flagged as fallback only; the vendor servers (Supabase/Fly/Cloudflare) and playwright print the direct command as today. Scrapling and CloakBrowser are situational, not offered by default here — point to `catalog/README.md` if asked; CloakBrowser gets a "read the warning on the catalog page first" flag.

(b) **Compliance scope.** Ask what personal-data classes the product touches, which jurisdictions it serves, and any sector triggers (health, finance, children, AI features, card payments, enterprise/EU sales) — the same axes as `compliance.config.md` §1–3. Propose the `compliance.config.md` deltas (WRITE-ONCE: propose, never auto-write); the human approves, `/comply` consumes it later, and `/loadout` keeps asking as new data flows appear rather than re-litigating this every session once it's answered.

## Step 3 — Query memory (don't re-derive solved problems)
Search the knowledge layer for anything relevant to the standing work: the knowledge graph (Memory MCP `search_nodes`, if installed) and any learnings/gotchas store. Surface prior root-cause→fix pairs so the session starts from recorded knowledge, not a blank slate. (This is the read side of the discipline `/debug` enforces on the write side.)

## Step 4 — Reconcile the working tree
- `git status` + `git log --oneline -10` → what's uncommitted, what branch, anything mid-flight.
- Cross-check against CONTINUITY's "current state": if the tree shows work that the handoff doesn't mention (or vice-versa), flag the mismatch — the last session may have ended without a `/savepoint`.
- Check for `.respawnpack/wave-ledger.md` before trusting `CONTINUITY.md` alone: if present, it's more recent and higher-resolution for an interrupted multi-wave run (a plan-window kill never got the chance to update `CONTINUITY.md`, but the ledger was written live, one line per completed wave). Cross-check its commit ranges against `git log` — never trust the ledger alone — then resume at the first wave/task it does *not* mark complete; never re-dispatch one it already closes out.

## Step 5 — Brief + propose the next move
Give a short, scannable boot summary:
- **Where we are** — current state in 1–2 lines (from CONTINUITY + git).
- **Open** — the live gaps worth attention (from GAPS).
- **Reminders** — any standing constraints / ⛔ killed features to respect.
- **Next** — a recommended first action, and the role to hand to (`/loadout` to plan new work · `/build` to continue a spec · `/debug` if something's broken · `/review` / `/playtest` / `/ship` if mid-pipeline · `/savepoint` if this was a quick orientation with nothing to build).

Recommend; let the human pick. Don't auto-start work.

## Invariants
- **Orientation only** — read and propose; never start changing code before the direction is confirmed.
- **Respect ⛔ killed features** — load DECISIONS removals in Step 1 so nothing resurrects them.
- **Symmetric with `/savepoint`** — it consumes the CONTINUITY/GAPS/CHANGELOG that `/savepoint` regenerates. If the handoff is stale or missing, surface that rather than trusting it blindly.
- **Memory is read first** (Step 3), mirroring `/debug` Step 0 — so the session compounds prior knowledge instead of repeating it.
- **Adoption interview is proposal-only and once-per-config** (Step 2) — applicability, extras and compliance-scope deltas are always proposed for approval, never auto-written, and it skips itself once `doctor`'s `onboarding` row reads COMPLETE and the canonical docs are filled in.
- **Every optional contract gets an answer, and the answer is the human's** (Step 2a0) — configured, or not-applicable with a stated reason, or explicitly left undecided and said out loud. Never inferred from an empty directory, and never rounded to green. <!-- invariant -->
