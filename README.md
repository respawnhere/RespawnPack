# RespawnPack

An open-source **Claude Code framework** for solo founders and small teams.

> **Status: `v0.3.1`.** Shipped: the anti-drift docs spine, the command loop (`/respawn` through
> `/savepoint`), MCP-first ops with a skill per managed-infra server, governance hooks, a state kernel
> that makes the load-bearing checks executable, a security and compliance loop, a reference-first
> skill catalog with full attribution, and a one-command installer/upgrader/uninstaller.
>
> **Currently in progress.**
> - **Host adapters.** The Claude Code adapter installs: `interactive/`, `sdk-supervisor/` and
>   `statusline/` are placed and `doctor` reports a row per module, with `statusline` left opt-in at
>   the settings level. The Codex adapter works but is **not wired into the installer** yet. Pi
>   support lives in the separate `respawn-pi` package.
> - **Living skills** cover three opt-in canaries (`debug`, `savepoint`, `knowledge`). Widening the
>   set follows evidence that adaptation improves a skill, rather than a glob matching more files.
> - **Memory engine**, optional by design. File-backed memory is the zero-setup default;
>   `--with-memory` installs the engine into your target and registers it project-locally, so nothing
>   depends on a global `rmem`. It needs Node and a working `npm install`.
> - **`mcp-reaper` on a live Docker daemon**: exercised against a stub; behaviour against a real
>   daemon is **not claimed**, and reports CANNOT_DETERMINE where none is reachable.
> - **Task reconciliation** compares your task list against your own gap/gate records in both
>   directions, as `savepoint --only compile,reconcile` (the bare `reconcile` verb still works and
>   prints a deprecation line). Declare a source in `respawnpack.config.json`; undeclared reads as
>   NOT_CONFIGURED rather than as a pass.
> - **Schemas**: every machine-readable state artifact has one in `schemas/`, verified in this
>   repo's tests and *not* installed into your target, so the kernel's own loaders stay the
>   production validators and the runtime stays dependency-free.
>
> `respawnpack doctor` reports what is actually active in *your* install.

## Why this exists

Most agent stacks optimize for generating code. For a solo founder shipping a product over months, the binding constraint is **knowledge drift**: docs and mockups go stale and contradict the code when direction changes, the agent re-adds features that were deliberately killed, and the feature↔page↔flow map lives in someone's head. RespawnPack is built around keeping that knowledge true over time, on top of direct control of the managed services the product runs on.

It is built for a single operator shipping one product on managed infrastructure. RespawnPack does not claim to have invented anti-drift: gstack, SuperClaude, BMAD, Cline Memory Bank and others each have working mechanisms for parts of it. What it contributes is the combination: a write-once canonical/derived docs spine, a decisions and removals register with a killed-feature guard, automated cross-artifact drift checks, verified conversation rollover, and MCP-first infrastructure control, aimed at one operator rather than a fleet.

## Install
```bash
git clone https://github.com/respawnhere/RespawnPack.git
node RespawnPack/install/install.js /path/to/your/repo   # idempotent; --force to overwrite
```
This drops the docs spine, the role skills, MCP-first ops, governance hooks, Workflow templates, a security CI, and the credited skill catalog into the target, detects its stack, and merges the hooks into `.claude/settings.json`. Requires Node and git. Details: [install/README.md](install/README.md).

### Updating
Each release is published as a single commit with no history behind it, so `git pull` inside an older clone of this repository stops with "refusing to merge unrelated histories". Re-clone, or reset the clone onto the release:

```bash
git -C RespawnPack fetch origin && git -C RespawnPack reset --hard origin/main
```

Then run `node RespawnPack/install/upgrade.js /path/to/your/repo` in your project: it re-lays only what changed and records what it retired. Details: [install/README.md](install/README.md).

## Quickstart
```bash
node install/install.js /path/to/repo      # 1. install (idempotent)
```
Then, in Claude Code inside that repo, run the loop:

| Step | Command | Does |
|---|---|---|
| boot | `/respawn` | load the last handoff, orient, surface what's next |
| plan | `/loadout` | brainstorm, plan, spec (threat-model, scale-model, and compliance-classify where relevant) |
| build | `/build` | implement to spec, in scope, commenting *intent* |
| check | `/review` · `/playtest` · `/secure` · `/comply` | multi-lens review, find→fix→test, security audit, compliance audit |
| ship | `/ship` | pre-ship gate, authorized push, verify |
| save | `/savepoint` | regenerate the handoff for the next `/respawn` |

`/task` is the fresh-session delegate role the task runner dispatches. `/debug` enters whenever something breaks, and it queries memory before investigating. `/wordsmith` cleans any user-facing writing (docs, READMEs, copy, narration) so it reads clear and human, against the writing standard. Every clear verb still routes by prose: say "plan" for `/loadout`, "QA" for `/playtest`, "closeout" for `/savepoint`, "postmortem" for `/debug`, "proofread" for `/wordsmith`, "gdpr" or "hipaa" for `/comply`. Typed commands are the themed names; the clear verbs work only as trigger phrases.

### Your first session

Four commands cover day one. Run them in order:

1. **`/respawn`** boots the session. On a fresh, unconfigured install it also runs the first-run adoption interview: it offers optional extras (the Compound Engineering plugin, the design pack, vendor MCP servers for your detected stack) and asks about compliance scope (what personal data you touch, which jurisdictions you serve). You will see a short interview, then a boot summary once it is answered.
2. **`/loadout`** turns your request into a plan and, for build-ready work, a spec. You will see a brainstorm of the real problem, a few forcing questions if something is genuinely uncertain, and a proposed set of canonical doc edits (`PRODUCT.md`, `FEATURES-PAGES.md`, `DECISIONS.md`) for you to confirm.
3. **`/build`** then **`/review`** implement the spec in scope, then run a multi-lens review (correctness, security, performance, maintainability, spine-consistency) against the diff. You will see the change land, then a ranked list of findings with file:line and a concrete fix for each.
4. **`/savepoint`** ends the session. It regenerates **and verifies** the three derived state documents (`GAPS.md`, `CONTINUITY.md` and `LESSONS.md`, the register of promoted lessons and unreviewed leads) so the next `/respawn` resumes cleanly instead of starting cold. `CHANGELOG.md` is a derived file too and is **not** one of them: it is the hand-authored history, updated from git rather than rendered, so nothing regenerates it and `savepoint --verify` does not check it against a source. `kernel/lib/render.js` renders exactly the three named above. The one exception is the wave-ledger fold: under `--write`, `savepoint` appends an untracked `.respawnpack/wave-ledger.md`'s dispatch lines to `CHANGELOG.md`'s most recent entry, so kernel code now does read and write this file, just never render it wholesale.

See [examples/todo-app/](examples/todo-app/) for a reference filled-in spine: what a healthy `docs/` tree looks like once these have run a few times, versus the empty templates the installer lays down.

Everything else (`/secure`, `/comply`, the 32-role agent bench, the memory engine) layers on once this loop feels natural.

### Choose how strict it is: the posture profile

A fresh install seeds nothing, and an unconfigured project behaves exactly as `v0.3.0` did. To loosen
it, declare one key in `respawnpack.config.json`:

```json
"posture": { "profile": "standard" }
```

It is an **object with a `profile` field**, not a bare string; the installer refuses a malformed value
rather than carrying it along. There are three profiles:

| profile | what changes |
|---|---|
| `strict` | exactly what `v0.3.0` does. The default when the key is absent, and where an unreadable or invalid declaration lands, because a policy that could not be read is never the loosest policy. |
| `standard` | the recommendation for new installs. The kernel's day-one coverage rows advise instead of exiting 2, and `index-guard`'s unmodelled-construct refusal narrows. The reason still prints. |
| `light` | Claude may commit and push, `index-guard`'s four switchable rules stand down, and the Stop-side savepoint hold and the PreCompact hold become advice. |

Add `"overrides"` beside `"profile"` for a single rule, as `{ "verdict", "reason" }` with the reason
required. What no profile and no override can reach is the anti-drift core: the security column
(`shell-guard`'s catastrophe class, `secret-scan`, `push-guard` tier 2), `index-guard`'s wave-sweep,
foreign-staged and control-plane refusals, the SessionStart baseline, the Stop-side delta detection and
the PreCompact handoff write. `hooks/_posture.js` carries **no key** for any of them, so naming one
makes the whole declaration invalid rather than being quietly ignored. `hooks/_posture.js` is the one
reader, for the kernel as well as the hooks, and
ADR-003 is the decision with the rule-by-rule table (a
development record, kept in the source repository rather than shipped in the package).

The installer composes the hook set for whichever profile it finds, and `install/upgrade.js` re-lays
only what changed on a flip: an entry the new profile does not compose is removed and recorded as
retired in `.respawnpack/install-receipt.json`, so flipping back restores it. `light` also does not
receive `kernel/lib/reconcile.js`, and `doctor` reports that subsystem as `NOT_APPLICABLE` naming the
posture rather than `BROKEN`. `node .claude/respawnpack/respawnpack.js doctor` carries a `posture` row
that names which of the four states produced the profile it is running under: a declaration, an absent
key, a config that would not parse, or a declaration that was refused.

### Declare an exception: forgive one reviewed line, never a rule

A posture profile moves a rule for everybody. Sometimes the rule is right and one line is not: the AWS
documentation example key in a setup guide, a range teardown script whose `rm -rf` genuinely targets a
scratch mount. Name that one subject instead of loosening the rule:

```json
"exceptions": [
  { "id": "aws-doc-example-key", "rule": "secret-scan",
    "match": { "fingerprint": "sha256:<64 lowercase hex, copied from the deny>", "path": "docs/aws-setup.md" },
    "reason": "the AWS documentation example key, quoted in the setup guide" }
]
```

An exception names a **subject**, a path glob, a fingerprint of the matched text, a command fingerprint,
or a checklist item, and never a **verdict**: that is the line between this key and `posture.overrides`
above. An override moves a rule for every subject and is refused on the ids the anti-drift core fixes; an
exception carves out one reviewed subject and leaves the rule denying everything else, so it reaches rules
a posture profile never can, the security column included. `reason` is required, `respawnpack.config.json`
is already in `index-guard`'s `CONTROL_PLANE` so a subagent cannot write itself one, and the guard still
says what it lifted: `🔓 allowed by exception <id> (<rule>): <reason>`, on the channels the founder and
the model both read. Six guards accept one today, `secret-scan`, `injection-scan`, `shell-guard`'s
catastrophe class, `push-guard` tier 2, `worktree-guard` and `index-guard`'s unmodelled-construct rule;
`index-guard`'s three anti-drift-fixed rules and every kernel refusal accept none. `hooks/_exceptions.js`
is the one reader, and ADR-004 is the decision (a development
record, kept in the source repository rather than shipped in the package). `node
.claude/respawnpack/respawnpack.js doctor` carries an `exceptions` row naming how many are declared and
how many have expired.
### Declare where copies come from

Anything cloned, copied, migrated or regenerated has a source, and a project usually has an opinion about
which one is the truth: a range's configuration cloned from the wrong template box, a generated API
client whose schema moved, a customer document copied from a stale template. Declare it in
`docs/derived/state/lineage.json`, a file this pack reads and never writes on its own:

```json
{
  "sources": [{ "id": "range-inventory", "kind": "inventory", "path": "inventory/range.yml", "authority": "source-of-truth" }],
  "derivations": [{ "id": "guac-config", "target": "config/guac/range.conf", "from": ["range-inventory"], "how": "generate", "neverFrom": ["template-inventory"] }]
}
```

`node .claude/respawnpack/respawnpack.js lineage seed` proposes the sources a repository already has (a
Terraform root, an Ansible inventory, an OpenAPI document, a Prisma schema, and more) from evidence files
it finds, never from a guess about which one is right; `--write` writes the proposal once, only when no
such file exists yet. It never proposes a derivation: which file derives from which is the founder's own
knowledge, so `derivations` stays for you to fill in.

`lineage stamp <target> --from <sourceId>` then writes the marker: a comment in the target's own syntax
(`#`, `//`, `<!-- -->`, `--`, `/* */`, chosen by extension) naming the source and its digest at the
moment of the copy, or a `<target>.lineage.json` sidecar for anything a comment cannot reach. Re-stamping
replaces the line rather than adding a second one. It refuses a source a derivation declares `neverFrom`,
and refuses a source id nothing has declared.

`lineage`, the tenth savepoint stage, then verifies every marker against the source it names: the
recorded digest has to match the source on disk right now, not merely name the right id, so a stale copy
fails even though its marker is technically correct. No declaration at all is `NOT_APPLICABLE` at exit 0
and is not an onboarding contract; declaring one is opt-in, and `doctor`'s `lineage` row says which state
you are in.

### Browse the record: your own documents, on your own machine

The project's knowledge lives in markdown, which is right for a diff and wrong for an evening's reading.
One command renders it:

```bash
node .claude/respawnpack/respawnpack.js site --serve
```

That builds every `.md` under `docs/` and `memory/graph/`, plus the root `README.md`, into
`.respawnpack/site/` — one page per document, an index, a sidebar tree, breadcrumbs and a per-page
outline — and serves it at `http://127.0.0.1:<port>/` until you press Ctrl-C. The server binds
**`127.0.0.1` and nothing else**: not `0.0.0.0`, not `::`, not even `localhost`, which can resolve
somewhere else. It answers `GET` and `HEAD`, serves that one directory read-only, refuses a path that
tries to leave it, and runs nothing.

`state.html` is the dashboard, and it obeys the same rule everything else in the pack obeys: when the
compiled state is **CURRENT** it shows the goal, the milestone, the counts, the blockers and the next
unblocked work; when it is **stale, unreadable or absent** it shows the banner with the reason and
**withholds every number**. Withheld, not shown with a caveat — a number printed beside a warning is
still a number you will quote tomorrow.

The site is a **projection**, never a second source of truth: it reads tracked documents and writes only
under its output directory, it has no editing surface, and a rebuild of an unchanged tree produces
byte-identical pages. `--out` puts it somewhere else, and a path inside a directory the build reads is
refused rather than written to. `.respawnpack/` is already gitignored, so nothing here belongs in a
commit. Diagrams are drawn by your browser from one pinned script the pack never downloads, and every
diagram's source is on the page beside it, so an offline read loses the picture and nothing else.

## The pieces that set it apart

**The anti-drift spine.** A `docs/` tree with a WRITE-ONCE canonical/derived split, a decisions-and-removals register, and an automated drift-check (routes↔matrix, tokens↔docs, killed-feature grep). It keeps product knowledge true as the code changes. See [spine/README.md](spine/README.md).

**One verdict vocabulary, and a savepoint you can scope.** Every row `savepoint`, `gate` and `doctor` emit has the same shape, `{ outcome, check, detail, checked, domain, subject, label }`: four outcomes (`PASS` · `FAIL` · `CANNOT_DETERMINE` · `NOT_APPLICABLE`), exit codes `0` · `1` · `2` · `0`, and each subsystem's own richer word (`NOT_CONFIGURED`, `SILENTLY INACTIVE`) kept in `label` for display only, deriving no exit code. `savepoint` is ten named stages (`compile`, `writeback`, `render`, `verify`, `removals`, `lineage`, `reconcile`, `coverage`, `adapters`, `memory`); `--only` and `--skip` narrow the run, every skipped stage prints its own row rather than vanishing, and a partial run withholds `sourceRevision` from its receipt so it can never be read as a finished closeout. `compile` is required, and an unknown stage name is refused. See [kernel/README.md](kernel/README.md).

**An After Action Report, composed from what already happened.** `respawnpack aar` assembles one document for a window, bottom line first, from the compiled state at each end, the commits, the derived changelog entries dated inside it, and the machine-local savepoint receipt, candidate journal and delegation archive; an input that could not be read is a row in the report rather than a silent gap. `--write` creates it under `docs/derived/aar/`, and a goal's successful close writes one automatically. See [kernel/README.md](kernel/README.md).

**A production-readiness checklist that is found rather than asserted.** `respawnpack readiness` derives sixteen items from what is actually in the tree — a README, a CI workflow, a test command, secret scanning in CI, a filled CODEOWNERS, a LICENSE, a lockfile, ignored env files, and the archetype's own: a Terraform remote state backend, no plaintext credential in a variable file or inventory, vaulted inventories, a health route, migrations, error tracking, a documentation index, a link check. An item that does not apply to this shape of repository is not a row, and a tree nothing was recognised in is `CANNOT_DETERMINE` rather than green. The declared posture scales it: `light` asks the essential tier and `standard` the full list, both reporting every row at exit 0 with the reason it would have failed still first in the detail, and `strict` fails on an unmet item. An item the founder has judged is excepted by name with a reason in `respawnpack.config.json`, in the same one exception grammar the guards use, and the lift is reported in every posture. `/ship` Step 1 runs it. See [kernel/README.md](kernel/README.md).

**A task runner that decides completion out of band.** `adapters/claude-code/task-runner/` reads a queue at `docs/derived/state/tasks.json`, refuses to start from a stale projection, and runs one fresh headless session per task with its tool allow list derived from the project's declared posture and projectType rather than one fixed floor for every project, recorded on the receipt as `tools.derivedFrom`; a queue row's own `tools` field, when present, can only narrow that derived set, never widen it. A row may also declare `taskClass`, one of `core/policy/routing.js`'s eight classes; the runner always routes with `requiresHooks: true`, so the model chosen never leaves the hooked family, and both the routed and (when overridden) the effective model are recorded as `route` on the task-attempt receipt. What the session achieved is decided by the runner's own gates plus the kernel's per-criterion attestation record, never from the transcript saying so, and never from a timeout or an exit code. It writes a receipt and a handoff. The `/task` skill is the matching in-session role. One real run against a live host is recorded, defects and cost included, in the field run of 2026-09-03 in the source repository. It runs from a RespawnPack checkout against a target and is not installed into one.

**MCP-first ops, one skill per server.** The ops layer drives managed infrastructure (Supabase, Fly, Cloudflare, Vercel) through their MCP servers, with a skill per server under `ops/mcp/`. RespawnPack only authors a skill where the vendor does not already ship one (Fly, the Docker MCP gateway, the npm-audit server). For Supabase, Context7, GitHub, and Cloudflare it points at the vendors' own skills and adds a thin guardrail layer. See [ops/README.md](ops/README.md).

**Living skills: three canaries, opt-in.** `debug`, `savepoint` and `knowledge` can be given a living form: a frozen `SKILL.base.md` baseline plus a `## Learned (living)` overlay regenerated from memory entities keyed to that skill, where **every line carries its date, confidence and source path**. `respawnpack living enable|regenerate|status|reset` drives it; a reset restores the baseline and archives the overlay, leaving the source memory intact. ⛔ **A default install activates nothing, and every other skill is a STATIC skill, a complete and supported state.** This used to claim *every* owned skill had two forms while zero `.skill-meta.json` existed anywhere; the claim is now exactly three, and `respawnpack living status` answers it for your project. Vendor skills are never modified. See [spine/reference/living-skills.md](spine/reference/living-skills.md).

**The memory engine.** `memory/engine/` (respawn-memory) is persistent project memory. Markdown-in-git entity files are the source of truth (gotchas, infra facts, decisions, with typed relations), indexed into PGLite and pgvector for hybrid search (vector plus full-text) and graph-augmented recall: find the seed entity by meaning, then expand along its relations to pull the fix and what it touches. It runs as an MCP server, with pluggable embeddings (a local offline fallback, Ollama, or any OpenAI-compatible endpoint). `/debug` and `/knowledge` query it first.

**File-backed memory (`memory/graph/` plus grep) is the zero-setup default**: no flag, no npm, no MCP server, no external service. The engine is one explicit opt-in on top of it:

```bash
node install/install.js <target> --with-memory     # installs the engine INTO the target and registers it
node <target>/.claude/respawnpack/respawnpack.js doctor
```

The installer copies the engine to `.claude/respawnpack/memory/engine/`, runs `npm install` there, and registers it **project-locally** in `.mcp.json` against the **absolute Node path it resolved at install time**, so nothing depends on PATH. `doctor` then proves it works by completing a real MCP handshake and writing a memory through one server process and reading it back through a second, against a throwaway store so your own memory is never touched.

There is no global `rmem` to install; the engine is only ever registered project-locally by the installer. See [memory/engine/README.md](memory/engine/README.md).

**Security and compliance, woven in.** `/secure` runs a defense-in-depth audit (OWASP, dependency CVEs, infra advisories). `/comply` audits against the regulations that apply, using 21 per-requirement checklists spanning GDPR, UK GDPR, CCPA, HIPAA, GLBA, the EU AI Act, and more. Both gate `/ship`, and a security CI (gitleaks plus dependency audit) runs on every push.

**Human-first writing.** `/wordsmith` edits prose and scripts (docs, READMEs, changelogs, landing-page and in-app copy, narration) to be clear, specific, and genuinely human, removing AI-slop while preserving the author's meaning and voice. It applies a writing standard (`docs/reference/writing-standards.md`), the prose counterpart of the coding standard, and is quality editing rather than authorship detection.

**Performance under real load.** A performance standard (`docs/reference/performance-standards.md`) codifies the failures that kill products at their first traffic spike: N+1 queries, unbounded lists, missing indexes, per-request connections, heavy work on the request path, external calls without timeouts. It is wired through the loop, mirroring the security loop: `/loadout` scale-models growth surfaces at plan time, `/review` runs a performance lens on every diff, and `/ship` gates hot-path changes (`EXPLAIN` via the DB MCP, pagination, bundle delta).

**A behavioral baseline in every CLAUDE.md.** The installer writes a managed block into the target's `CLAUDE.md` carrying six conduct rules: surface assumptions before building, build the minimum that solves it, change surgically, define done before starting, match ceremony to blast radius, and weigh feedback before acting on it. Four distill Andrej Karpathy's LLM-coding guidance, expressed independently; ceremony-scaling is RespawnPack's counterweight to their caution-over-speed bias; and weighing feedback before acting joined in round 2, adapted from prior art (`docs/reference/behavior-standards.md`, both credited in [ATTRIBUTION.md](ATTRIBUTION.md)).

**A 32-role specialist bench.** `agents/` installs 32 tool-scoped subagents that the loop and the founder delegate to (a 22-file core set by default; ten commercial-function advisors are opt-in, added to `respawnpack.config.json`'s `extras` array, see `agents/README.md` "Install placement"): 6 review lenses fan out from `/review` (correctness, security, performance, maintainability, spine-consistency, design), 24 advisors across engineering, infra, and business return designs, plans, and briefs rather than edits, and 2 write-scoped onboarding mappers back `/onboard` (the bench's one non-read-only exception, bounded and gated). The flagship is `system-architect`: architecture discipline a generalist model usually lacks on its own, including a load-bearing load-model check before any topology choice, a bias toward boring technology over what trended last, a plan for exiting a decision before entering it, and cost worked out at three scales rather than one. Every role reads the docs spine before proposing anything and refuses to resurrect a feature the killed-features register already closed.

**Which model does what.** Three model families sit behind one routing policy: Anthropic Claude, OpenAI, and MiniMax or any other host that speaks the OpenAI chat-completions protocol. `spine/reference/models/capability-register.md` rates named models against eight task classes (coding, review, security-testing, long-context, planning, writing, research, extraction), every `preferred` or `capable` rating carrying a dated, cited source and everything else reading `unproven` rather than guessed. `core/policy/routing.js` reads that register plus what this machine can actually reach and answers with a family, a model, and why. Hook-bearing work stays on Claude Code whatever the register says elsewhere, because the hooks are the anti-drift core; `adapters/providers/offload.js` carries a bounded, hookless unit of work (a review lens, a research read, a bulk summary) to whichever family the evidence and reachability agree on instead, and writes a receipt naming the route. An ops-infra project with no `providers` block declared simply has two families reachable instead of three, and the receipt says so; an application repository with a provider key exported has all three. Nothing here has called a live provider: every gate runs on fakes, and a bounded live probe per model is the owner's own action. See `spine/reference/models/capability-register.md`, `adapters/openai-compatible/README.md`, and `adapters/providers/README.md`.

## v0.3: multi-host in-place rollover *(shipped as `v0.3.0`)*

RespawnPack's continuity, state, and handoff rules live in a host-neutral core, with first-class adapters connecting it to Claude Code (interactive hooks, and a managed Agent SDK supervisor) and OpenAI Codex (interactive hooks, and a managed app-server supervisor). Every profile's capability claims rest on a fired, passing activation canary rather than on installed files alone, so what a host is recorded as doing is what it was observed doing. See [`conformance/CAPABILITY-MATRIX.md`](conformance/CAPABILITY-MATRIX.md) for the capability contract and each profile's declared-versus-observed status, and the `adapters/claude-code/` and `adapters/codex/` READMEs for the per-host detail. Pi support ships as the separate `respawn-pi` package, built on this pack's host-neutral core.

## What's in the box
| Component | What |
|---|---|
| `spine/` | anti-drift docs templates (canonical/derived/reference), the feature↔page↔flow matrix, the decisions/removals register, the coding, writing, performance, behavior, and design standards, and the living-skill doctrine |
| `skills/` | the role library (`respawn`, `loadout`, `build`, `review`, `playtest`, `walkthrough`, `ship`, `debug`, `secure`, `comply`, `savepoint`, `wordsmith`, `checkup`, `onboard`, `task`, `aar`) plus `skill-guard` |
| `agents/` | the 32-role subagent library (6 review lenses, 11 engineering/infra advisors, 13 business/research advisors, 2 write-scoped onboarding mappers), tool-scoped and installed to `.claude/agents/`; a 22-file core set by default, the 10 commercial-function advisors among them opt in via `respawnpack.config.json`'s `extras` array |
| `ops/` | MCP-first ops (`deploy-verify`, `db-ops`, `secrets-audit`, `infra-status`), a skill per MCP server under `ops/mcp/`, and the pack's own maintenance scripts, among them `sweep-scratch.mjs` and the release smoke |
| `memory/` | the knowledge-graph conventions, the `/knowledge` skill, and the `respawn-memory` engine in `memory/engine/` |
| `hooks/` | the fifteen governance hooks, composed for the declared posture: hard blocks (`lockdown`, `push-guard`, `shell-guard`, `worktree-guard`, `index-guard`), scanners (`secret-scan` at commit and push, `injection-scan`), session lifecycle (`session-routing-nudge`, `mcp-reaper`, `docker-session-tag`, `stop`→`savepoint` opt-in), advisories (`context-monitor`, `websearch-freshness`, `spawn-guard`, `precompact-ledger-nudge`) |
| `workflows/` | Workflow-tool templates (`audit`, `review`, `migrate`) |
| `templates/` | install-time templates: security CI (gitleaks plus dep-audit, on push and weekly), quality-gate CI (presets found by detection: Node/Python/Go/Rust lint/typecheck/test/build, plus Terraform, Ansible, shell, Docker, Kubernetes and docs wherever the tree shows them), `CODEOWNERS`, and the `CLAUDE.md` behavioral-baseline block |
| `catalog/` | a reference-first index of curated third-party skills and MCPs, credited and linked, never copied |
| `library/` | RespawnPack-shipped content, including `compliance/` (21 per-requirement NA/EU checklists plus cited source texts, worked by `/comply`). Installed into a target only where `compliance.config.md` declares a compliance scope, alongside `docs/compliance/` |
| `schemas/` | a declared JSON Schema per machine-readable state artifact, plus `registry.json` mapping each family to its schema, path, durability, writer and readers. **Not installed into a target**: these are normative declarations verified in this repo's tests, while the kernel's own loaders stay the production validators, so the zero-dependency runtime gains nothing to carry |
| `ATTRIBUTION.md` | the credit ledger: author, repo, and license for every referenced or vendored source |
| `install/` | the one-command installer |

## Map

| Doc | What |
|---|---|
| [docs/vision/VISION.md](docs/vision/VISION.md) | What it is, the problem it targets, the signature, and where it sits |
| [docs/vision/ARCHITECTURE.md](docs/vision/ARCHITECTURE.md) | The full-stack components, the repo layout, what `install` lays down, and how a posture is declared |
| [ATTRIBUTION.md](ATTRIBUTION.md) | The credit ledger: every referenced skill, MCP, and marketplace, with author, repo, and license |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to work on the pack |
| [SECURITY.md](SECURITY.md) | Supported versions and how to report a vulnerability |
| [install/README.md](install/README.md) | Installing, upgrading, and uninstalling, flag by flag, and what each posture composes |
| [spine/README.md](spine/README.md) | The documentation spine: what each canonical and derived document is for |
| [skills/README.md](skills/README.md) | The lifecycle skills and when each one runs |
| [ops/README.md](ops/README.md) | The MCP-first ops layer |
| [hooks/README.md](hooks/README.md) | Every governance hook and what it enforces |
| [memory/README.md](memory/README.md) | The memory engine: storage model, retrieval, and the `rmem` CLI |
| [catalog/README.md](catalog/README.md) | The referenced third-party skill ecosystem |
| [docs/research/claude-code-limits.md](docs/research/claude-code-limits.md) | Host limits the pack works within, including the skill-listing budget the installer sets |

## Background

RespawnPack distills patterns its creator (respawnhere) arrived at while building products with AI assistance on managed infrastructure, where the recurring failure was knowledge drift. The anti-drift spine, the session-continuity loop, the MCP-first ops layer, the memory engine, and the security loop are the parts that held up in practice, generalized so any repo can install them.

## License

RespawnPack is **AGPL-3.0-or-later**. Copyright © 2026 respawnhere. The complete terms are in
[LICENSE](LICENSE).

Third-party skills and references keep their own licenses, credited in
[ATTRIBUTION.md](ATTRIBUTION.md).
