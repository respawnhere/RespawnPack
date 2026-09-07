# Installing RespawnPack

One command drops the framework into a target repo. **Idempotent**: existing files are skipped (never clobbered); `.claude/settings.json` hooks + `permissions.allow` are *merged*, not overwritten. The hook half of that merge **remembers what it placed**, so a hook entry you delete stays deleted. See "The settings merge remembers what it placed" below.

```bash
# get the pack (any location; it is never copied into the target wholesale):
git clone https://github.com/respawnhere/RespawnPack.git
# from that clone:
node install/install.js /path/to/your/repo
# or, run inside the target repo with RespawnPack on disk:
node /path/to/RespawnPack/install/install.js
# preview first: prints the full summary (create/skip/protect/gitignore/monorepo detection), writes nothing:
node install/install.js /path/to/your/repo --dry-run
# re-install: overwrites existing FRAMEWORK files, but SKIPS protected files (upgrading to a
# newer pack version? use `install/upgrade.js` — see "Upgrading" below):
node install/install.js /path/to/your/repo --force
# overwrite EVERYTHING, including protected files (prints a warning first):
node install/install.js /path/to/your/repo --force-all
node install/install.js /path/to/your/repo --migrate-removals-scope  # explicit legacy config migration
```

Requires **Node + git** on the target (the hooks + installer are Node; no `jq`). Git is used for the
`.gitignore` self-heal (below); its absence only disables that one step (skipped silently), it doesn't fail
the install.

## What it lays down
- `docs/` (the spine): canonical templates (`PRODUCT`, `FEATURES-PAGES`, `DECISIONS`, `DESIGN`, `ARCHITECTURE-ROADMAP`) + `docs/derived/*` + `docs/reference/` + `docs/_archive/` (+ the seven standards, which are coding, writing, performance, behavior, design, skill-authoring and testing, plus the orchestration-patterns and observability-basics references, the living-skills doctrine, the NA/EU compliance reference, and memory conventions, all under `docs/reference/`). `docs/reference/models/` also lands: the capability register (`capability-register.json`), its rendered document (`capability-register.md`), and the four prompting-practice files (`prompting-anthropic.md`, `prompting-openai.md`, `prompting-minimax.md`, `prompting-general.md`), so a target's own copy is what the routing policy and the offload path read first. `<PROJECT>` and `<date>` are auto-filled; the rest are yours to complete.
- `.claude/skills/` (the roles): `respawn`/`loadout`/`build`/`review`/`playtest`/`walkthrough`/`ship`/`debug`/`secure`/`comply`/`savepoint`/`wordsmith`/`checkup`/`onboard`/`task`/`aar` + `skill-guard` + `knowledge` + the ops skills (`deploy-verify`/`db-ops`/`secrets-audit`/`infra-status`) + the per-server `mcp-*` skills (`context7`, `github`, `graphify` and `runtime` always; `fly`, `supabase` and `security-audit` only when the detected stack calls for them: `fly.toml`, a `supabase/` directory, and a `package.json` at the root or one level down, respectively). **So a target with none of those three markers receives 26 skills; 29 is the all-gates-fired maximum, not what every install gets.** This is one of the four optionality axes in the core/optional boundary decision; gating is install-time and additive, so a later re-run places a newly-earned skill without `--force`.
- `.claude/agents/` (defensive): if the pack ships a top-level `agents/*.md`, each lands at `.claude/agents/<file>`, except the ten business/research advisors held back for the opt-in extras pack. No-op if the pack doesn't have an `agents/` dir yet. **So a target receives 22 agents by default; 32 is the maximum, reached only by adding `"agents"` to `respawnpack.config.json`'s `extras` array** (`agents/README.md` "Install placement"). It is the same additive, install-time gating as the skills axis above: a later re-run places the newly-declared extras fresh, without `--force`. Unlike `--with-memory` (the pack's one capability flag), this is placement scope, not a new capability, so it is declared in config rather than flagged on the command line.
- `.claude/hooks/`: the fifteen Node hooks (`lockdown.js`, `secret-scan.js`, `stop-savepoint.js`, `push-guard.js`, `spawn-guard.js`, `precompact-ledger-nudge.js`, `worktree-guard.js`, `index-guard.js`, `injection-scan.js`, `context-monitor.js`, `session-routing-nudge.js`, `websearch-freshness.js`, `shell-guard.js`, `mcp-reaper.js`, `docker-session-tag.js`) + the `pre-push` git-hook sample, plus the eleven shared modules they require (`_contracts.js`, `_boot.js`, `_runtime.js`, `_cmd.js`, `_manifest.js`, `_artifact.js`, `_shell.js`, `_git-effect.js`, `_index-lease.js`, `_posture.js`, `_exceptions.js`. These are libraries, not hooks; a hook whose module did not travel cannot load at all. `_contracts.js` is the one typed-contract declaration that both the hooks and `doctor` validate against, `_posture.js` is the one reader of the project's declared posture, which `index-guard.js` binds through `_boot.need` and the state kernel reads cross-tree for `doctor`, `_exceptions.js` is the one reader of the project's declared exceptions, which `secret-scan.js` binds the same way and `doctor` reads for its `exceptions` row, and `_boot.js` is the bootstrap boundary that turns a module which will not load (*or that loads and violates its contract*) into a conservative degradation rather than a dead hook or a silent bypass).
- `.claude/adapters/claude-code/`: three host-adapter modules the v0.3 rollover core ships. `interactive/` (`profile.js`, `probe.js`) is the capability declaration and activation probe for the hooks profile above. `sdk-supervisor/` (`cli.js`, `capabilities.js`, `measure.js`, `stream.js`, `supervisor.js`, `canary.js`) is the managed-profile process surface: not wired into settings.json, not run by anything the installer starts, just placed so a caller (today, only this pack's own checkout) can `require()` it. `statusline/` (`statusline.js`) is an opt-in context-usage tee: placed by default, but its `.claude/settings.json` `statusLine` slot is a single command the installer never writes or overwrites, so placing the file is not the same as activating it (see the adapter's own README for the one-line manual wiring step). `node .claude/respawnpack/respawnpack.js doctor`'s `host-adapter:*` rows report placement (and, for sdk-supervisor, that it loads through its installed `core/` dependency) without ever claiming activation from file presence alone. `adapters/claude-code/task-runner/` is not placed; it stays out of scope for this wave.
- `.claude/workflows/`: the `audit`/`review`/`migrate` templates.
- `.github/workflows/respawnpack-security.yml`: security CI (gitleaks secret scan + dependency-CVE audit, on push/PR + weekly schedule).
- `.github/workflows/respawnpack-quality.yml`: quality-gate CI (on push/PR). Calls `respawnpack gate` **once** and takes its exit code as the verdict: **PASS** (a configured check ran and passed) · **FAIL** (a configured check failed) · **NOT_CONFIGURED** (a stack was detected but nothing meaningful could run, exit 2, **not green**) · **NOT_APPLICABLE** (the project *declared* it has no gate in `respawnpack.config.json`; never inferred). It detects Node, Python, Go and Rust at the root and one level down, and honours an explicit `qualityGate.checks` list for builds it cannot detect. Earlier versions ran four steps that each *skipped* when the script was missing, so a non-Node repo reported green having checked nothing.
- `ATTRIBUTION.md` + `catalog/README.md` (the reference-first, credited further-reading page, organized into domain sections): the credit ledger and skill catalog; nothing third-party is copied. Plus `library/`: RespawnPack-shipped content (currently the compliance checklists + cited sources); `library/compliance/` ships the per-requirement checklists (markdown) that `/comply` consumes, and the cited source PDFs stay pack-only (never installed). **`library/` and `docs/compliance/` are gated on `compliance.config.md` declaring a non-empty scope in its "Applicable frameworks" section (§4), not on posture**: a target with no declared scope receives neither (saving ~471 KB / 24 files + ~20 KB / 5 files); declaring a scope and re-running `install.js`/`upgrade.js` places both. `compliance.config.md` itself always ships, because it's the form a target fills in to declare that scope. An unparseable `compliance.config.md` places nothing from either tree and says why; see `/comply` (`skills/comply/SKILL.md`) for where the material lives meanwhile.
- `.claude/settings.json`: the hooks block, a `permissions.allow` read-only baseline, and `skillListingBudgetFraction: 0.02` (a third top-level key, absent from `settings.snippet.json`, raising the skill-listing budget so a 29-skill pack is not silently truncated to names, sized for the all-gates-fired maximum on purpose, since a budget sized for the minimum would truncate the installs that earn the most skills). The `permissions.allow` baseline is `git status`/`git diff`/`git log`, plus `flyctl status`/`flyctl logs` when a Fly host is detected. All three are merged in, never overwritten.
- `memory/graph/.gitkeep`: floors the `memory/graph/` directory so the file-backend grep path always has somewhere to look, even before anything's been written to it. If the target already has a same-name-different-case sibling (e.g. `Memory/`), the installer warns that the two will merge on a case-insensitive filesystem rather than failing.
- `respawnpack.config.json`: detected `routeSource` + `opsTargets`. `codeTruth` is never seeded and `routeSource` is omitted entirely when detection finds nothing: an absent key is UNDECIDED, and `/respawn` resolves it.
- `.gitignore` (self-heal, only touched if needed): if the target's own ignore rules happen to swallow a path RespawnPack just placed (e.g. a generic `build/` rule matching `.claude/skills/build/`), the installer appends a narrowly-targeted `!`-negation block re-including exactly those paths, never a blanket `!.claude/`. See "The `.gitignore` self-heal" below.

## Protected files (`--force` vs `--force-all`)
Some placed files are canonical docs or config the user hand-fills after install. Overwriting them on a routine `--force` upgrade would destroy real project content. These are **protected**: `docs/PRODUCT.md`, `docs/FEATURES-PAGES.md`, `docs/DECISIONS.md`, `docs/DESIGN.md`, `docs/ARCHITECTURE-ROADMAP.md`, `compliance.config.md`, every `docs/compliance/*.md` placement, and `respawnpack.config.json`.

- **`--force`** overwrites everything else (framework files: skills, hooks, workflows, reference docs, and so on) but **keeps** any protected file that already exists. The summary prints them distinctly: `N protected file(s) kept (overwrite with --force-all)`.
- **`--force-all`** overwrites protected seeded files too. It prints a one-line warning listing what it is about to clobber. An existing removal registry is authored negative knowledge and is never erased, even by this flag.
- The `CLAUDE.md` managed marker block is a separate mechanism (marker-scoped, refreshed by `upgrade.js`; see the Upgrading section) and stays on plain `--force`: it's marker-scoped by regex and never touches text outside the markers, so there's nothing for `--force-all` to additionally protect there.

## The settings merge remembers what it placed
The hooks merge is additive: it never rewrites a group you authored, and it never removes an entry.
That used to mean it could not tell **"new in this pack version"** from **"you deleted this on purpose"**,
because from `settings.json` alone the two look identical: absent. So it re-added both, every run, and a
hook you had removed came back on the next install.

`.respawnpack/install-receipt.json` now records the `(event, matcher, command, if)` tuples the installer
placed, beside the adapter files it already tracked, and the merge reads it first:

| in the receipt | in `settings.json` | what happens |
| --- | --- | --- |
| yes | yes | ours, still wired. Left exactly as you have it (your `timeout`, your group, your ordering). |
| yes, and retired | no | **retired by an earlier profile.** Re-added the moment a profile composes it again (see below). |
| yes | no | **founder-removed.** Not re-added, on this run or any later one, and the summary names it. |
| no | either | new in this pack version. Added, as before. |

The event is part of the tuple because one command legitimately rides several events (`index-guard` is
wired under five), and `if` is part of it because `secret-scan` is registered twice on the same matcher
under two different conditions. Those are two rules, and neither the merge nor the receipt ever collapses
them into one.

**An install that predates the record** (no receipt, or a `schemaVersion: 1` one) has no memory, so the
merge falls back to today's add-only behaviour **and says so in the summary** rather than letting you
believe a removal will stick when it cannot. That run records what it owns, so the next removal does. An
unparseable `settings.json` still skips the whole merge and leaves the file byte-identical; the ownership
record is carried forward unchanged rather than replaced with an empty one.

`uninstall.js` replays the same record, so a hook entry an older pack version wired, one today's snippet
no longer names, is still removed, while a hook of your own that neither names is left alone.

## The hook set is composed for your posture

`hooks/settings.snippet.json` is no longer copied fixed into every target. It is the **`strict` column of
a profile manifest** (`install/_settings-manifest.js`), and the merge composes it for the posture declared
in `respawnpack.config.json` (ADR-003). Three of the resolver's four sources, `DEFAULTED` (no key),
`UNREADABLE` (the config will not parse) and `INVALID` (a refused declaration), all compose `strict`, so a
target that says nothing, and a target whose config is broken, both get exactly what the pack has always
laid: 13 groups, 22 entries, byte for byte. The summary names which of the four you are in.

What each profile composes:

| profile | groups | entries | omitted, and why | PreToolUse wiring |
| --- | --- | --- | --- | --- |
| `strict` | 13 | 22 | nothing. `strict` **is** the snippet. | one process per hook |
| `standard` | 13 | 17 | nothing. No hook is wholly `off` in that column. | one `dispatch.js` process per group |
| `light` | 13 | 15 | both `mcp-reaper` registrations. ADR-003 gives that hook one rule and it reads `off` under `light`, so the wiring only started a process that read the config and exited. | one `dispatch.js` process per group |

**Two different subtractions, kept in two different lists.** The `omitted` column is guards: an entry
leaves only when every rule its hook carries is `off`. The wiring column is processes: `light` and
`standard` compose the two fully-covered `PreToolUse` groups as one
`node ${CLAUDE_PROJECT_DIR}/.claude/hooks/dispatch.js PreToolUse <group> --covers <guards>` entry each instead of three and
four separate ones: the same guards, in the same declared order, with the same verdicts, in one Node
process (see [`hooks/README.md`](../hooks/README.md#dispatchjs-one-process-per-pretooluse-registration-group)).
That is 22 − 2 (inert under `light`) − 7 (per-hook entries replaced) + 2 (dispatcher entries) = 15 for
`light`, and 22 − 7 + 2 = 17 for `standard`. `strict` composes neither substitution, because that profile
is defined as exactly what 0.3.0 does and its composed bytes are pinned. `secret-scan` is never folded in
under any profile: its two Bash registrations are two permission rules, one `if` each, and merging them
would hand a security scan every Bash command instead of the two spellings it is registered for.

The entry names the guards it runs because `doctor` reads `settings.json` to decide whether a hook is
wired, and a dispatcher registration that named only itself made five live guards report as
`SILENTLY INACTIVE` and turned a healthy report red. The file itself is placed only where a profile wires
it, for the same reason.

`.respawnpack/install-receipt.json` records `settingsWiring` (which of the two wirings this install laid,
and the groups it covers), and the per-hook entries a dispatching profile replaced are recorded as
retired, so flipping back to `strict` re-lays them and flipping forward removes them again. The wiring is
reversible in both directions, for the same reason a profile change is.

An entry is omitted only when **every** rule its hook carries resolves to `off`. That is derived from
`hooks/_posture.js` rather than listed, so a rule that is fixed in all three postures keeps its hook wired
in all three: most hooks have one, and they self-disable from the inside instead. A per-guard override
changes no wiring at all (the entry stays, the rule stands down), so it is reversible by editing one file.

**Switching profile** re-lays only what changed and prints the diff. An entry the new profile does not
compose is **retired**: removed from `settings.json`, and recorded as retired in the receipt so flipping
back restores it. Three conditions guard that removal, and all three are required: the manifest omitted
that exact tuple, the receipt proves this installer placed it, and there is an ownership record at all. A
target with no record retires nothing, because a removal it cannot prove is one it does not make; a
founder-added entry is named by no record and is never touched; and an unparseable `settings.json` still
skips the entire merge and records nothing.

## Preview with `--dry-run`
Add `--dry-run` to any invocation (plain, `--force`, or `--force-all`) to see exactly what would happen.
The full summary (create/skip/protect counts, detected `routeSource`/`opsTargets`, monorepo detection notes,
and any `.gitignore` re-includes) prints normally, but **nothing is written**: no file, no directory, no
`.claude/settings.json` merge, no `.gitignore` edit. The actionable "Next steps" list is suppressed (there's
nothing to act on yet) and replaced with a one-line reminder to re-run without the flag.

`--dry-run` also prints the settings merge as a three-way diff (what it **would add**, what it **would
keep** as you have it, and what it **respects as founder-removed**), so an upgrade against a target whose
hooks you have pruned can be inspected before it runs.

## MCP wiring suggestions
The summary always suggests the default research-reach MCP pack (playwright-mcp and firecrawl, documented on the [catalog page](../catalog/README.md#research-reach-browser-and-crawler-mcp-servers) along with the situational tier), and when stack detection (below) also finds a Supabase / Fly / Cloudflare target, it prints the exact command to wire that up too, only for targets actually detected. Suggestions are grouped by how the server connects.

There are two connection paths. **direct** (`claude mcp add`) is for remote-OAuth endpoints (Supabase, Cloudflare) and local / CLI-coupled stdio tools (respawn-memory, Graphify, Fly). **gateway** (`/mcp-runtime`, the Docker MCP gateway) is for keyed or third-party `npx` servers: it stores the credential in the OS keychain via `docker mcp secret set` and injects it at container runtime, instead of writing it into plaintext Claude config. The full routing rule lives in [`ops/README.md`, "Which way does a server connect?"](../ops/README.md#which-way-does-a-server-connect). Example output:
```
direct:
  research (browser):  claude mcp add playwright npx @playwright/mcp@latest
  db (supabase):       claude mcp add --transport http supabase https://mcp.supabase.com/mcp
  host (fly):          claude mcp add fly -- flyctl mcp server
  edge (cloudflare):   claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp
gateway:
  research (crawl):    docker mcp secret set FIRECRAWL_API_KEY, then enable/add firecrawl via the gateway
    fallback (no Docker/WSL2): claude mcp add firecrawl --env FIRECRAWL_API_KEY=fc-YOUR_API_KEY -- npx -y firecrawl-mcp
verify: claude mcp list for direct adds, docker mcp tools for the gateway
```
firecrawl needs an API key, so it defaults to the gateway path. Without Docker Desktop (on Windows it needs the WSL2 backend; the gateway and `docker mcp` CLI still run from the Windows side), the fallback direct command still works, but the key then lands in plaintext in Claude's config; the printed fallback line carries an explicit warning and points at `/secrets-audit`.

The fastest way to stand up the gateway path is pulling the published starter profile instead of adding servers one at a time; details in [ops/README.md, "The starter kit"](../ops/README.md#the-starter-kit).

## Stack detection
The installer sniffs the target and pre-sets `routeSource` (Next app/pages router, `src/routes`, and the like) and `opsTargets` (Fly / Cloudflare / Vercel / Supabase / Prisma) so `/savepoint`'s drift-check and the ops skills know what to point at. When detection finds no route source the key is OMITTED rather than filled with a placeholder. `codeTruth` (token/copy/schema paths) has no detector at all and is never seeded; `/respawn` or `/onboard` proposes it from evidence, and either key may instead be declared `{"notApplicable": true, "reason": "..."}` when the project genuinely has none.

Detection also probes exactly **one level down** into common monorepo layouts (`backend/`, `frontend/`, and every immediate child of `apps/`, `services/`, `packages/`) for the same markers, so a `backend/`+`frontend/`-shaped repo (e.g. a FastAPI + Next.js split) isn't left with an unset `routeSource`/`opsTargets` just because nothing matched at the root. It's bounded (no recursion past that one level) and conservative: a subdir finding only ever *fills a gap*, it never overrides something the root already found, and `routeSource` records exactly where it was found (e.g. `frontend/app/**/page.{tsx,jsx,ts,js}`). The same probe also recognizes Python (`requirements.txt`/`pyproject.toml` sets `opsTargets.runtime = 'python'`) and container/PaaS hosting (`docker-compose*.yml` sets `'docker'`, `render.yaml` sets `'render'`, `Procfile` sets `'procfile'`), and all three are also checked at the target root. The summary prints a `monorepo detection:` line naming what was found and where, when anything beyond the root fired. This detection only ever fills in `respawnpack.config.json`; it never touches `.mcp.json`.

## The `.gitignore` self-heal
A target's own `.gitignore` can incidentally swallow a path RespawnPack just placed. The dogfood case that motivated this: a `build/` ignore rule (common in JS/Python projects alike) also matches `.claude/skills/build/`, silently git-ignoring that skill directory. After placing files, if the target is a git repo, the installer runs `git check-ignore` against everything it manages (created, skipped, or protected, not just what was written this run) and, for anything actually ignored, appends a narrowly-targeted negation block to the target's `.gitignore`:

```
# --- RespawnPack: re-included install paths (auto-generated, do not hand-edit) ---
# One of this target's own ignore rules above matched a path RespawnPack placed (e.g. a generic
# `build/` rule catching `.claude/skills/build/`). Re-included by exact path only, never a blanket
# `!.claude/`, so anything else you deliberately ignore under these trees stays ignored.
!.claude/skills/build/
# --- /RespawnPack: re-included install paths ---
```

Notes:
- **Never a blanket `!.claude/`.** Only the exact colliding paths (at whatever directory depth the ignore rule actually matched) are re-included, so something you deliberately ignore under `.claude/`, your own `.claude/settings.local.json`, say, stays ignored.
- **Idempotent**: the block carries a marker; a re-run that finds the marker already present leaves `.gitignore` alone rather than duplicating it.
- **Skips silently** when the target has no `.git` directory (the gate is `.git` existence, not `git` on `PATH`): no error, no `.gitignore` touched.
- If the target has no `.gitignore` yet, one is created containing just this block (only when there's actually something to re-include; this is the RE-INCLUDE block specifically).
- **A SECOND block is written unconditionally in any git repo**, whether or not anything collided: `# --- RespawnPack: runtime state (auto-generated, do not hand-edit) ---` followed by `.respawnpack/`. So a fresh target with a clean tree and no `.gitignore` still ends up with one. Both blocks are marker-delimited and both are removed on uninstall.

## After installing
1. Fill the `docs/` canonical templates (start with `PRODUCT.md` + the `FEATURES-PAGES.md` matrix).
2. Run `/respawn` and finish onboarding. Every optional contract needs an answer: configure it, or declare it
   not applicable **with a reason**. `node .claude/respawnpack/respawnpack.js doctor` lists what is still undecided.
   ⛔ The installer no longer writes a `codeTruth` or `routeSource` placeholder: an undetected value leaves the key
   ABSENT, because a template string read as a glob matches nothing and reports no drift. Absent is UNDECIDED, which
   is honest and is not a failure, but it is not release-ready either, and savepoint will not exit 0 until it is resolved.
3. (optional) install the git secret guard: `cp .claude/hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push`.
4. Use it: `/respawn` to boot a session, `/loadout` to start work, `/savepoint` at session end.
5. (optional) wire up MCP servers for any detected ops targets. See the summary output or the section above.

## Upgrading
`install/upgrade.js` is **the** update command: one run clears the old pack files from a target and
re-lays the version currently in your RespawnPack checkout. Founder **content** is preserved (text
outside `CLAUDE.md`'s managed block, your own hooks/permissions in `settings.json`, every founder field
in `respawnpack.config.json`, and `.respawnpack/`) while the pack-owned surfaces move with the version:
the `CLAUDE.md` managed block refreshes when the pack version changes, `respawnpack.config.json` gets its
`respawnpack` + `upgradedAt` stamps bumped, `settings.json` is re-serialized (2-space indent, LF; gains
`skillListingBudgetFraction` when unset), and an older target's `.gitignore` may gain the pack's marker blocks.

```bash
# upgrade a target to the pack version in this checkout:
node install/upgrade.js /path/to/your/repo
# preview first: both phases run in their dry-run forms (full removal listing + install summary) and nothing
# is written. The install summary previews against the still-installed target, so files phase 1 would first
# remove show up as "skip" — the real run re-creates them:
node install/upgrade.js /path/to/your/repo --dry-run
node install/upgrade.js /path/to/your/repo --migrate-removals-scope  # authorize the exact docs-only scope migration
```

Under the hood it composes the uninstaller's `--for-upgrade` scope with a fresh `install.js` on top;
run those two yourself (see "Uninstalling" below) if you ever need the pieces separately. Before
removing anything it preflights the pack source (`VERSION`, both sibling scripts, the hooks snippet,
the source trees), so a half-checkout aborts cleanly instead of stripping a target it can't re-lay;
it also refuses to run against the pack repo itself, and an unknown flag hard-fails rather than
falling through as a target dir.

**On a posture flip, an upgrade is the same run with a different projection.** Edit `posture.profile`
in `respawnpack.config.json`, re-run `install/upgrade.js`, and three things move together, each
recorded in `.respawnpack/install-receipt.json` so the flip back is visible: the composed hook set
(entries the new profile does not compose are removed and marked retired; `settingsWiring` records
whether this install laid the per-hook or the `dispatch.js` wiring), the kernel projection
(`lib/reconcile.js` is withheld under `light` and re-laid on the way back, under `kernelRetired`), and
`dispatch.js` itself, which is placed only where a profile wires it. A retirement needs all three of
its conditions: the manifest omitted that exact tuple, the receipt proves this installer placed it, and
there is an ownership record at all. Nothing the founder wrote is touched, and an entry no record names
is never removed. Nothing else about the upgrade changes: the same preflight, the same content
preservation, the same `--dry-run`.

## The state kernel, and the optional memory engine

`install.js` also places the executable kernel into `.claude/respawnpack/`: `respawnpack.js` plus its `lib/` (state, render, gate, removals, lineage, aar, readiness, site, closeout, memory, living, outcome, assert, modhealth, applicability, and reconcile where the posture carries it). Seventeen files under `strict` and `standard`, sixteen under `light`: ADR-003's rule table reads `kernel:R4 reconcile → n.a., not installed` in that column, so `install/_settings-manifest.js` projects the same posture onto `install/_sources.js`'s `KERNEL_FILES` that it projects onto the hook registrations, and `lib/reconcile.js` is withheld. `install/_sources.js` still declares all seventeen, because that list is what the PACK must be able to supply and `upgrade.js`'s preflight still demands every one of them before phase 1 strips anything. A posture flip re-lays what the new profile needs and retires what it no longer places, but only when the file on disk is byte-identical to the one this installer laid; the retirement is recorded under `kernelRetired` in `.respawnpack/install-receipt.json` so the flip back is visible. `doctor` reports a subsystem a profile withheld as `NOT_APPLICABLE`, naming the profile and the ADR row that withheld it, never `BROKEN`. That is the binary the quality-gate CI template invokes (`node .claude/respawnpack/respawnpack.js gate --verdict-file …`), and the one `doctor`, `status`, `savepoint --verify`, `removals`, `contract` and `living` all run through. There is no `respawnpack` command on `PATH`: the installer adds no `bin`. Every invocation that a session or a founder is told to RUN uses the `node .claude/respawnpack/respawnpack.js …` form, including the three runtime strings in `hooks/session-routing-nudge.js`. Prose elsewhere still writes the bare verb (`respawnpack living`, `respawnpack removals`) as shorthand when naming a capability rather than giving a command; that is deliberate, and it is why this sentence no longer claims "every documented invocation".

`--with-memory` is OPT-IN and does four extra things: copies the memory engine into `.claude/respawnpack/memory/`, runs `npm install` there from the lockfile, writes an `.mcp.json` entry (`respawn-memory`) pointing at an installer-resolved ABSOLUTE Node entry point, and records the choice in `respawnpack.config.json`. Without it the pack uses the zero-setup file backend, which is the default by owner decision OD-2. `doctor` verifies the engine by performing a real MCP handshake and a write/retrieve round trip, not by checking that files exist.

## Uninstalling
`install/uninstall.js` is the installer's mirror: it derives what to remove from the same placement
inventory `install.js` lays down (plus a `KNOWN_LEGACY` list for artifacts older pack versions placed),
and it is **surgical**: files are removed by exact inventory name, directories are pruned only once
genuinely empty, and nothing is ever removed by name prefix. That last rule is load-bearing: targets
legitimately author their own skills inside our namespaces (a hand-written `mcp-routing` sitting beside
the pack's `mcp-*` skills), and a prefix sweep would eat them.

```bash
# preview (the DEFAULT — prints the full removal listing, removes nothing):
node install/uninstall.js /path/to/your/repo
# actually uninstall:
node install/uninstall.js /path/to/your/repo --force
# upgrade scope (phase 1 of `install/upgrade.js` — see "Upgrading" above, which is the update
# command): clear pack files but keep settings.json/CLAUDE.md/config/.gitignore/.respawnpack/:
node install/uninstall.js /path/to/your/repo --for-upgrade --force
# also remove respawnpack.config.json (founder-edited, so kept by default):
node install/uninstall.js /path/to/your/repo --force --purge-config
```

What a full uninstall touches, and how:
- **Pack files go**: the `.claude/` skills/agents/hooks/workflows the installer placed, `docs/reference/**`,
  the `.github/workflows/respawnpack-*.yml` CI templates, and `.respawnpack/` (runtime state, the one
  recursive removal). The `mcp-*` skills are enumerated **ungated** from the pack source plus `KNOWN_LEGACY`,
  so a skill placed when the stack matched (say `mcp-fly` from a Fly era) is still removed after the stack
  moved on and the install-time gate went silent about it, the orphan class the 2026-07-11 upgrade harvest found.
- **Shared-namespace files go only while pristine**: `ATTRIBUTION.md`, `catalog/README.md`, `library/**`,
  and `.github/CODEOWNERS` are compared against the pack source and removed only if unmodified; anything
  you edited (a filled-in CODEOWNERS) is kept and reported.
- **Managed blocks are stripped, hosts survive**: `CLAUDE.md` loses exactly the `RESPAWNPACK:BEHAVIOR`
  marker block (a file that held nothing else is removed whole); `.claude/settings.json` loses exactly the
  pack's hook entries, matched per hook on the same `(command, if)` identity the installer merge dedupes on;
  your hooks and groups stay, emptied groups/events are pruned, `permissions.allow` and
  `skillListingBudgetFraction` stay; `.gitignore` loses the two installer marker blocks, while a bare
  hand-written `.respawnpack/` rule (no markers = ambiguous ownership) is left alone.
- **Never touched, in any mode**: the canonical spine docs (`PRODUCT`, `FEATURES-PAGES`, `DECISIONS`,
  `DESIGN`, `ARCHITECTURE-ROADMAP`), `docs/README.md`, `docs/derived/*`, `docs/_archive/*`,
  `docs/compliance/*`, `compliance.config.md`, `memory/**`, and `CLAUDE.md` text outside the markers.
  `respawnpack.config.json` is kept unless you pass `--purge-config` (which contradicts `--for-upgrade`
  and errors if combined).

## Manual install
Don't want the script? A hand copy needs everything the installer places, not the four directories an earlier version of this line named. **How many files that is depends on which install-time gates fire** (the stack-gated `mcp-*` skills, the `extras` agents, the compliance scope, the posture's kernel projection), so this page carries no number: `--dry-run` prints the exact count for your target, on the day you run it. Copy `spine/*` to `docs/`, the skill dirs to `.claude/skills/`, `agents/*.md` to `.claude/agents/`, `hooks/*.js` (including every `_`-prefixed shared module listed under "What it lays down" above, plus `dispatch.js`, and `hooks/pre-push` to `.git/hooks/`) to `.claude/hooks/`, `workflows/*` to `.claude/workflows/`, `adapters/claude-code/{interactive,sdk-supervisor,statusline}/*.js` (skipping every `*.test.mjs` and `sdk-supervisor/fixtures/`) to the matching `.claude/adapters/claude-code/` subdirectory, `kernel/*` to `.claude/respawnpack/`, `library/*`, `memory/*` and the `templates/CLAUDE.md` managed block, then merge `hooks/settings.snippet.json` into `.claude/settings.json`. That merge gives you the `strict` set, which is the one that is safe to hand-merge. Verify the result with `node .claude/respawnpack/respawnpack.js doctor` rather than by counting files.

## Running the tests
`install/install.test.mjs` is a `node:test` + `node:assert` suite (zero new dependencies) that runs the real installer as a child process against fresh temp dirs under `os.tmpdir()`, then asserts on what it leaves behind: fresh install, no-clobber re-run, `--force` vs `--force-all` vs protected files, the `CLAUDE.md` marker-block state machine (including the version-aware refresh on a plain install), `permissions.allow` merge/dedupe, the unparseable-`settings.json` guard (file left byte-identical, merge skipped with a warning), `--dry-run` (writes nothing, reports what would happen), the `.gitignore` self-heal (re-includes a swallowed path, idempotent on re-run, silent when there's no git repo), monorepo stack detection (one level into `backend/`/`frontend/`, including the Python-`app/`-package false-positive guard), and the case-insensitive-FS warning for an existing `Memory/`-style sibling. Each test cleans up its own temp dir.

```bash
node --test install/install.test.mjs
```

`install/uninstall.test.mjs` is its sibling for the uninstaller: the round-trip completeness sweep
(install → uninstall leaves exactly the user-truth keep-set, the lockstep fence that fails CI if a new
`install.js` placement isn't accounted for), surgical survival of user content (seeded files inside pack
dirs, user hook groups and hooks riding inside our matcher groups, `CLAUDE.md` text around the block,
canonical docs), the no-flag dry-run default, the `--for-upgrade` → reinstall round-trip, the stranded
`mcp-fly` legacy orphan, the `mcp-routing` stranger that must survive, edited-vs-pristine `CODEOWNERS`,
`.gitignore` marker-vs-hand-written ownership, `--purge-config`, and the refusal paths. The same file
also covers `install/upgrade.js` (the wrapper composes the two scripts this suite already exercises):
the one-command round-trip with founder edits intact, the `--dry-run` preview (asserting the children's
own dry-run banners, so flag-forwarding can't silently regress), the torn-pack-source preflight abort,
and the unknown-flag, extra-positional, and self-target refusals.

```bash
node --test install/uninstall.test.mjs
```

Also worth running after any edit to the installer, uninstaller, or upgrader themselves:
```bash
node --check install/install.js
node --check install/uninstall.js
node --check install/upgrade.js
```
