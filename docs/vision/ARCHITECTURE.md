# RespawnPack: Architecture

The full-stack components and the repo layout. Two views: **what the pack contains** (the framework) and **what it lays down when installed** into a target repo.

## Architecture direction after v0.3

The tree described below is the Claude Code reference implementation plus the host-neutral core `v0.3.0` extracted from it. Continuity, state, policy, and memory rules live in `core/`, and the existing v0.2 paths still resolve. First-class adapters connect that core to Claude Code hooks, the Agent SDK supervisor and the statusline, and to Codex hooks and app server. Pi support builds on the same host-neutral core as the separate `respawn-pi` package.

The shared contract is evidence-based: adapters probe whether their integration is active, report context measurement confidence, reach a safe boundary, request compaction through a documented host API, observe completion, inject a verified handoff, and continue the same conversation identity. An unavailable capability reports `CANNOT_DETERMINE` or a manual fallback; copied files alone never prove support.

This was an incremental migration rather than a flag-day rewrite. The state kernel remains the release-truth authority, and host adapters provide observations and actions without inventing separate truth models. See [`conformance/CAPABILITY-MATRIX.md`](../../conformance/CAPABILITY-MATRIX.md) for the capability matrix and each profile's declared-versus-observed status, and `core/lifecycle/states.js` for the state machine itself.

## How rigid the pack is: the posture profile

One founder-owned key in `respawnpack.config.json` decides how much of the pack refuses versus advises:

```json
"posture": { "profile": "standard" }
```

It is an **object with a `profile` field**, never a bare string, and the installer refuses a malformed value rather than carrying it along. `profile` is one of `light`, `standard` or `strict`; an optional `overrides` map takes per-rule `{ "verdict", "reason" }` pairs, where the reason is required. `hooks/_posture.js` is the one reader, for the kernel as well as the hooks, and ADR-003 (a development record) is the decision and the rule-by-rule table; it is a development record kept in the source repository rather than shipped in the package.

- **`strict`** is defined as exactly what `v0.3.0` does. An absent key resolves to it, and so does an unreadable config or an invalid declaration, which each say so in one line, because a policy that could not be read is never the loosest policy.
- **`standard`** is the recommendation for new installs: the kernel's onboarding coverage rows advise instead of exiting 2, and `index-guard`'s unmodelled-construct refusal narrows.
- **`light`** additionally lets Claude commit and push, stands `index-guard`'s four switchable rules down, and turns the Stop-side savepoint block and the PreCompact block into advice.

A fresh install seeds no posture key at all, so adopting a profile is always something a founder wrote down. Nothing in the anti-drift core is reachable by a profile or an override: `hooks/_posture.js` carries no key for a fixed rule, so naming one makes the whole declaration invalid rather than being quietly discarded.

A third surface reads the same declarations rather than adding one: `respawnpack site` renders the repository's own tracked documents (`docs/**`, `memory/graph/**`, the root `README.md`) into a static site under `.respawnpack/site/` and, with `--serve`, puts it on `127.0.0.1` and no other interface. It is a **projection**: it reads tracked files, writes only under its output directory, has no editing surface, refuses an output path inside a directory it reads, and rebuilds byte-identically, so there is never a second place a fact could live. Its `state.html` dashboard reads `docs/derived/STATE.json` through `hooks/_runtime.js`'s `readDurableState` — the reader the SessionStart hook, `status` and `doctor` already share — so a CURRENT state shows the goal, the counts, the blockers and the next work, and anything else shows the banner and **withholds every number**, exactly as the boot injection does. Markdown is rendered by `kernel/lib/site.js`, written in the pack rather than vendored (owner decision 20); diagrams are drawn in the reader's own browser from one pinned CDN script that the pack never fetches, with each diagram's source on the page for a reader who has neither.

Beside `posture` sits a second, independent declaration in the same file: a tracked `exceptions` array, each entry naming one reviewed SUBJECT a guard already denies rather than the guard's verdict, so it reaches rules a posture profile never can, the security column included. `hooks/_exceptions.js` is the one reader, on `hooks/_posture.js`'s own four-source model (DECLARED, DEFAULTED, UNREADABLE, INVALID); six guards consult it today (`secret-scan`, `injection-scan`, `shell-guard`'s catastrophe class, `push-guard` tier 2, `worktree-guard`, and `index-guard`'s unmodelled-construct rule), and `index-guard`'s three anti-drift-fixed rules and every kernel refusal accept none. ADR-004 (a development record) is the decision, a development record kept in the source repository rather than shipped in the package.

## The components (the full stack)

1. **Spine**, the anti-drift knowledge layer (the foundation everything else reads/writes):
   - Templated `docs/` skeleton: canonical (`PRODUCT`, `FEATURES-PAGES` matrix, `DECISIONS` register, `DESIGN`, `ARCHITECTURE-ROADMAP`), derived (`CHANGELOG`, `GAPS`, `CONTINUITY`), reference (the coding / writing / performance / behavior / design / skill-authoring / testing standards, the orchestration-patterns and observability-basics references, the living-skills doctrine, the compliance reference), skills.
   - The four rules baked into a `docs/README` convention: WRITE-ONCE, removals-first-class, archive-never-delete, code-wins.
2. **Skills / roles library**, the org chart, fresh-authored plus harness-native: `respawn` (session-start boot), `loadout` (brainstorm→plan→spec), `review` (correctness / security / performance / maintainability / spine-consistency via Agent fan-out), `build`, `playtest` (find→fix→regression-test), `walkthrough` (contract-driven site testing: per-page presence/flows/capability-parity from the user's seat), `ship` (release/verify), `debug` (query-memory-first), `secure` (security audit: OWASP / deps / infra advisories), `comply` (compliance audit against per-requirement checklists), `savepoint` (session-end docs + drift-check), `wordsmith` (human-first writing and editing), `checkup` (periodic module-depth health scan), `onboard` (brownfield adoption: evidence-cited spine drafts), `task` (fresh-session-per-task delegate for the task-runner queue). Each role reads from and writes back to the spine.
3. **Memory**, a structured knowledge graph plus the query-first discipline (a skill that forces consulting it) plus the decisions/learnings ledgers.
4. **Ops (MCP-first)**, managed-infra control skills: `deploy-verify`, `db-ops`, `secrets-audit`, `infra-status`, templated against the common MCP servers (Supabase/Fly/Cloudflare/…).
5. **Governance / hooks**, the governance layer: fifteen Node governance hooks, among them a `lockdown` `PreToolUse` edit-scoping deny, a pre-push secret/PII diff-scan, `push-guard` and `spawn-guard`, worktree-write containment, **`index-guard`** (git-index ownership during parallel work: file scopes do not partition the index), read-side injection scanning, context monitoring, and a `Stop` hook that runs `/savepoint`. Plus a security CI template (gitleaks + dependency-CVE audit, on push + weekly) and a `.github/CODEOWNERS` template (sensitive-path review gates). Plus the push-discipline convention.
6. **Orchestration patterns**, reusable Workflow templates (audit, review find→verify→synthesize, migration sweep) + subagent conventions + the moderate-concurrency default (large parallel fan-outs hit rate limits).
7. **Installer**, one command that drops the spine + skills + hooks + config into any target repo, detects its stack, and wires the MCP-first ops to what's present.
8. **Meta**, RespawnPack treats itself as a product: its own docs (this tree), `VERSION`, `LICENSE` (AGPL-3.0-or-later), and `CONTRIBUTING`.
9. **Memory engine** (`memory/engine`), the respawn-memory engine: a markdown source of truth plus a PGLite hybrid store and graph-augmented recall, exposed as an MCP server. ⛔ It is **opt-in**: file-backed memory (`memory/graph/` + grep) is the zero-setup default and a default install requires no npm, no MCP registration and no external service. `install/install.js <target> --with-memory` copies the engine INTO the target and registers it **project-locally** against an installer-resolved absolute Node path; `respawnpack doctor` then proves it with a real MCP handshake and a cross-process write/retrieve round trip. There is **no global `rmem` command**: it is the bin of a private, unpublished package, and the old `claude mcp add respawn-memory -- rmem mcp` instruction could never resolve (OVERCLAIMS #4).
10. **Per-server ops skills** (`ops/mcp/`), one skill per MCP server: `mcp-fly`, `mcp-runtime`, `mcp-supabase`, `mcp-context7`, `mcp-github`, `mcp-security-audit`, `mcp-graphify`.
11. **Living-skill mechanism** (`skills/skill-guard` + `spine/reference/living-skills.md`), the living/base skill mechanism: `kernel/lib/living.js` implements it for the three opt-in canaries (`skill-guard` is the prose companion, not the enforcement) and `living-skills.md` documents the convention.
12. **State kernel** (`kernel/`), the executable behind the load-bearing checks, the layer that stops
    verification being prose. Compiles `docs/derived/STATE.json` from structured sources (requirement
    denominator, revision-bound evidence, goal/milestone as separate fields), **recomputes every count
    from rows**, renders `CONTINUITY`/`GAPS` from that state, then **verifies every rendered claim back
    against its source**. Four outcomes everywhere (`PASS` / `FAIL` / `CANNOT_DETERMINE` /
    `NOT_APPLICABLE`), with distinct exit codes, because a check that could not run is not a pass.
    Ships the prose-assertion helper (normalise before matching · occurrence-count-plus-location, never
    substring absence · known-good/known-bad control pairs) so drift-checks stop being hand-rolled per
    session. Calls project validators through a declared adapter interface rather than reimplementing
    them. Installs to `.claude/respawnpack/`; `/savepoint` is a thin procedure around it.
    `savepoint` is **ten named stages** (`compile`, `writeback`, `render`, `verify`, `removals`,
    `lineage`, `reconcile`, `coverage`, `adapters`, `memory`), scoped with `--only` and `--skip`; every stage that
    did not run prints its own row, and a partial run withholds `sourceRevision` from its receipt so it
    cannot be read as a completed closeout. `reconcile` remains as a deprecated alias for
    `savepoint --only compile,reconcile`. Every row `savepoint`, `gate` and `doctor` emit shares one
    shape, `{ outcome, check, detail, checked, domain, subject, label }`, where `label` carries each
    subsystem's own richer word (`NOT_CONFIGURED`, `SILENTLY INACTIVE`) for display only: no exit code,
    rollup or refusal is derived from it. A declared posture relaxes which outcome the coverage rows
    return and never what an outcome means. Three more verbs read the same compiled state: `lineage`
    verifies every declared derivation's provenance marker against the source it names before a clone,
    copy, migration or generation is trusted (`lineage seed`/`stamp` propose and write the markers,
    never a verdict), `readiness` finds a production-readiness checklist from the tree rather than
    asserting it, scaled by the declared posture, and `aar` composes an After Action Report for a
    window, bottom line first, into `docs/derived/aar/`. See [`kernel/README.md`](../../kernel/README.md).
13. **Role-agent library** (`agents/`), 32 tool-scoped Claude Code subagents: 6 review lenses that fan out from `/review`, 24 advisory roles across engineering/infra and business/research that return designs, plans, and briefs rather than edit files, and 2 write-scoped onboarding mappers that `/onboard` dispatches (the bench's one non-read-only exception, bounded and gated). A 22-file core set (the lenses, the engineering/infra advisors, the mappers, and three general product/research roles) installs by default; the other 10 business/research advisors are opt-in, reachable by adding `"agents"` to `respawnpack.config.json`'s `extras` array (`agents/README.md` "Install placement" names them). Every role reads the spine first and honors a `DECISIONS.md` kill.
14. **Host adapters and supervisors** (`core/`, `adapters/`), a capability-tested boundary around a shared, host-neutral rollover lifecycle (context-cycle state machine, typed evidence, exactly-once handoffs) that the v0.2 Claude paths do not depend on and are unchanged by. Every capability claim rests on a fired, passing activation canary, never on installed files alone, and is rendered per profile in [`conformance/CAPABILITY-MATRIX.md`](../../conformance/CAPABILITY-MATRIX.md). Three profile classes, each honest about what has actually been shown rather than what is designed:
    - **Interactive hooks** (Claude Code, Codex) stop truthfully at a manual compact boundary (the operator runs `/compact`) and enforce a verified handoff as a hard precondition beforehand. Enforced, with a named manual step.
    - **Codex app-server** (managed, automatic) is **live-proven**: three consecutive in-place rollovers ran end to end on a real thread on this machine, checked in as digest-fenced evidence.
    - **Claude Agent SDK** (managed, automatic) is implemented against the documented headless stream-json protocol; its live activation canary is `CANNOT_DETERMINE` in this environment because the context is unauthenticated, not because the profile is untested.

    Three Claude Code modules are placed by the installer: `interactive/` (the hooks profile's declaration and activation probe), `sdk-supervisor/` (the managed-profile process surface, placed for a caller to require, started by nothing the installer wires) and `statusline/` (placed by default, but its `.claude/settings.json` `statusLine` slot is a single command the installer never writes, so placement is not activation). `adapters/claude-code/task-runner/` is **not** placed. It runs from this checkout against a target and is recorded as deliberately absent from `install/_sources.js`'s `ADAPTER_FILES`, out of scope for this wave rather than forgotten.

    Pi support is not one of these three: it ships as the separate `respawn-pi` package, built on this same host-neutral core.

    Claude's background `stop`/`respawn` is **process recovery**, restarting a host process while preserving its conversation. It is **never context rollover**.

15. **Model-aware orchestration** (`core/policy/routing.js`, `adapters/openai-compatible/`, `adapters/providers/`), evidence over habit for which model a piece of work runs on. `spine/reference/models/capability-register.json` rates named models from three families, Anthropic Claude, OpenAI, and MiniMax or any other OpenAI-compatible host, against eight task classes; every `preferred` or `capable` rating carries a dated source, everything else reads `unproven`. `core/policy/routing.js` reads that register plus what this machine can actually reach and picks a family and model; a hook-bearing task session never leaves the Claude family, whatever the register prefers elsewhere, because the hooks are the anti-drift core. `adapters/providers/offload.js` carries one bounded, hookless unit of work (a review lens, a research read, a bulk summary) to the routed family and writes `.respawnpack/runtime/offload-<id>.json` naming the route, the families it skipped and why, and the usage, never the prompt or the credential. A caller reads the register from the target's own installed copy under `docs/reference/models/` first, falling back to this pack's own when the target has none, so an ops-infra repository with no register of its own and no `providers` block routes on this pack's copy with two families reachable, while an application repository with both installed and a provider key exported has three. Like the task runner, `adapters/providers/` and `adapters/openai-compatible/` are pack-side: they run from the checkout against a target and are not placed by the installer. No live provider call has been made building this: every gate here runs on fakes, and a bounded live probe per model is the owner's own action.

## Repo layout
```
RespawnPack/
├── README.md  LICENSE  CONTRIBUTING.md  VERSION
├── install/            one-command installer, upgrader, and mirror uninstaller + stack detection
├── spine/              templated docs skeleton (canonical/derived/reference) + the convention
│   └── reference/living-skills.md   the living/base skill convention
├── skills/             the role/skill library (respawn, loadout, build, review, playtest, walkthrough, ship, debug, secure, comply, savepoint, wordsmith, checkup, onboard, task, …)
│   └── skill-guard/    prose companion to the living/base mechanism — kernel/lib/living.js implements it
├── agents/             the 32-role subagent library (6 review lenses + 24 engineering/business advisors + 2 onboarding mappers), tool-scoped; 22 core install by default, 10 opt in via extras
├── hooks/              fifteen governance hooks (lockdown · secret-scan · push/spawn-guard · injection-scan · worktree-guard · index-guard · stop→savepoint · …)
│                       plus eleven shared modules the hooks require, not hooks themselves:
│                       `_contracts.js` · `_boot.js` · `_runtime.js` · `_cmd.js` · `_manifest.js` · `_artifact.js` · `_shell.js` · `_git-effect.js` · `_index-lease.js` · `_posture.js` · `_exceptions.js`
├── kernel/             the state kernel: STATE.json compiler, prose-assertion helper, derived-doc renderer + verifier, the `respawnpack` CLI
├── core/               the host-neutral rollover core: lifecycle state machine, typed evidence, exactly-once handoffs, capability policy, the model routing policy
├── adapters/           host adapters and supervisors over core/: claude-code/ (interactive hooks, sdk-supervisor, statusline), codex/ (hooks, app-server), openai-compatible/ (HTTP client for MiniMax and similar hosts) and providers/ (the offload path); Pi support ships as the separate respawn-pi package
├── conformance/        known-good/known-bad lifecycle traces replayed through the real core machine, plus the generated capability matrix
├── memory/             knowledge-graph + query-first conventions + decisions/learnings ledger format
│   └── engine/         respawn-memory engine: markdown source of truth + PGLite hybrid + graph-augmented recall (MCP server; OPT-IN via install --with-memory, no global rmem)
├── ops/                MCP-first ops skills (deploy-verify, db-ops, secrets-audit, …)
│   └── mcp/            per-server skills (mcp-fly, mcp-runtime, mcp-supabase, mcp-context7, mcp-github, mcp-security-audit, mcp-graphify)
├── workflows/          reusable Workflow templates (audit, review, migrate)
├── templates/          install-time templates (security CI: gitleaks + dep-audit · quality-gate CI: lint/typecheck/test/build · CODEOWNERS · the CLAUDE.md baseline block)
├── catalog/            reference-first credited index of third-party skills + MCPs (by domain)
├── library/            RespawnPack-shipped content (currently the compliance checklists + cited sources)
├── ATTRIBUTION.md      credit ledger: author · repo · license per source
└── docs/               RespawnPack's own docs (vision, architecture, research)
```

## What `install` lays down in a target repo
- `docs/` spine (the four-class tree + convention README + empty canonical templates to fill) + the coding, writing, performance, behavior, design, skill-authoring, and testing standards, the orchestration-patterns and observability-basics references, and the NA/EU compliance reference under `docs/reference/`. `docs/reference/models/` also lands: the capability register, its rendered document, and the four per-family prompting-practice files, so the routing policy and the offload path read a target's own copy before falling back to the pack's.
- `CLAUDE.md`: the behavioral baseline as a managed marker block (created, or appended to an existing file; refreshed when the pack version changes, or with `--force`).
- `.claude/skills/`: the role skills (incl. `/respawn`, `/secure`, `/comply`, `/savepoint`, `/wordsmith`, and `/task`, the fresh-session delegate role the task-runner queue dispatches) + `knowledge` + the MCP-first ops skills. Three `mcp-*` skills are stack-gated, so a target with none of their markers receives fewer than the maximum; the install summary prints what it placed.
- `.claude/agents/`: the 32 role agents (review lenses + engineering + business advisors + onboarding mappers) ship in the pack; a 22-file core set installs by default, the other 10 business/research advisors are opt-in via `respawnpack.config.json`'s `extras` array, mirroring `--with-memory`'s opt-in shape above.
- `.claude/hooks/` + `.claude/settings.json`: the fifteen governance hooks, composed for the declared posture and wired through the settings snippet: hard blocks (lockdown, push-guard, shell-guard, worktree-guard, index-guard), the commit- and push-time secret-scan and read-side injection-scan, session lifecycle (session-routing-nudge, mcp-reaper, docker-session-tag, opt-in Stop→savepoint), and the advisories (context-monitor, websearch-freshness, spawn-guard, precompact-ledger-nudge). `strict` wires one process per hook; `light` and `standard` wire the two fully covered `PreToolUse` groups through `hooks/dispatch.js` instead, and `light` also omits the two `mcp-reaper` registrations because every rule that hook carries reads `off` in that column. Flipping profile re-lays what the new one composes and retires what it no longer places, recorded in `.respawnpack/install-receipt.json` so the flip back is visible.
- `.claude/respawnpack/`: the state kernel, `respawnpack.js` (verbs: `state`, `savepoint --verify`, `status`, `doctor`) + `lib/`. `doctor` is the one that reports what is installed, configured, unsupported, stale, or **silently inactive**, because "files were copied" has been mistaken for "the feature is active" more than once in this pack's own history.
- `.claude/adapters/claude-code/`: `interactive/`, `sdk-supervisor/` and `statusline/`. Placement is inventory, not activation: `statusLine` is a single settings slot the installer never writes, and `doctor`'s `host-adapter:*` rows reach `ACTIVE` only from a fired canary.
- `.claude/workflows/` + `.github/workflows/respawnpack-security.yml` (gitleaks + dep-audit CI) + `.github/workflows/respawnpack-quality.yml` (lint/typecheck/test/build CI) + `.github/CODEOWNERS` (sensitive-path gates).
- `catalog/` + `ATTRIBUTION.md`: the reference-first, credited skill catalog. `library/` (RespawnPack-shipped content: the compliance checklists + cited sources) and `docs/compliance/` are placed only where `compliance.config.md` declares a non-empty compliance scope; `compliance.config.md` itself always ships, because it is the form that declares one.
- `respawnpack.config.json` recording the detected stack + which MCP-ops are wired. The installer seeds **no** `posture` key: an absent key is `strict`, and a project's posture is always something a founder wrote.

## Principles
- **Host-native first**: prefer documented hook, agent, workflow, skill, SDK, app-server/RPC, and CLI primitives. Use repository scripts to connect those protocols, never terminal keystroke injection or private transcript mutation.
- **Capabilities are proven**: activation canaries and observed lifecycle events back support claims; missing evidence is `CANNOT_DETERMINE`, not pass.
- **MCP-first ops**: lean on managed-service MCP servers for infra control.
- **Everything reads the spine**: every role reads PRODUCT/FEATURES-PAGES/DECISIONS and writes back via the spine's rules, and none of them invents product truth.
- **Moderate concurrency by default**: fan-out, but keep parallel subagents well under the rate-limit ceiling.
- **Posture is declared, never inferred**: the pack does not read a tree and conclude how strict it should be. An absent, unreadable or invalid declaration resolves to `strict` and says which of the four it was.
- **An exception names a subject, never a verdict**: it carves one reviewed line, path or command out of a guard that keeps denying everything else, rather than moving what the guard does. That is what lets it reach a rule a posture profile is refused on.
