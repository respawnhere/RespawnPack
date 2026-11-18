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
- `docs/` (the spine): canonical templates (`PRODUCT`, `FEATURES-PAGES`, `DESIGN`, `ARCHITECTURE-ROADMAP`) + `DECISIONS.md`, which lands as a GENERATED, verified index over the decision shard `docs/decisions/` (one file per decision; author decisions there, and split an existing monolith with `respawnpack migrate decisions --write`) + `docs/derived/*` + `docs/reference/` + `docs/_archive/` (+ the seven standards, which are coding, writing, performance, behavior, design, skill-authoring and testing, plus the orchestration-patterns and observability-basics references, the living-skills doctrine, the NA/EU compliance reference, and memory conventions, all under `docs/reference/`). `docs/reference/models/` also lands: the capability register (`capability-register.json`), its rendered document (`capability-register.md`), and the four prompting-practice files (`prompting-anthropic.md`, `prompting-openai.md`, `prompting-minimax.md`, `prompting-general.md`), so a target's own copy is what the routing policy and the offload path read first. (A `knowledge`/`docs-only` target receives only the writing, behaviour, orchestration and compliance standards; the six software standards are omitted unless opted back in; see the project-type section below.) `<PROJECT>` and `<date>` are auto-filled; the rest are yours to complete.
- `.claude/skills/` (the roles): `respawn`/`loadout`/`build`/`review`/`playtest`/`walkthrough`/`ship`/`debug`/`secure`/`comply`/`savepoint`/`wordsmith`/`checkup`/`onboard`/`task`/`aar` + `skill-guard` + `knowledge` + the ops skills (`deploy-verify`/`db-ops`/`secrets-audit`/`infra-status`) + the per-server `mcp-*` skills (`context7`, `github`, `graphify` and `runtime` always; `fly`, `supabase` and `security-audit` only when the detected stack calls for them: `fly.toml`, a `supabase/` directory, and a `package.json` at the root or one level down, respectively). **So a target with none of those three markers receives 26 skills; 29 is the all-gates-fired maximum, not what every install gets.** This is one of the four optionality axes in the core/optional boundary decision; gating is install-time and additive, so a later re-run places a newly-earned skill without `--force`. Declaring `extras: ["mcp"]` in `respawnpack.config.json` places the three stack-gated `mcp-*` skills (`fly`, `supabase`, `security-audit`) even when their markers are absent, the vendor opt-in. Since B5 (2026-10-09) every placed skill except the ten model-invocable roles (`respawn`, `savepoint`, `loadout`, `build`, `review`, `ship`, `debug`, `task`, `secure`, `comply`) carries `disable-model-invocation: true`: still installed and reachable by its slash command, but off the model-visible listing (`skills/README.md`, "Model-invocable, command-only, or extra").
- `.claude/agents/` (defensive): if the pack ships a top-level `agents/*.md`, each lands at `.claude/agents/<file>`. Since B5 (2026-10-09) only the **six review lenses** land by default; the other 26 agents are held back for the opt-in extras pack. No-op if the pack doesn't have an `agents/` dir yet. **So a target receives 6 agents by default (listing ~2.1 KB, down from ~8.9 KB); 32 is the maximum, reached only by adding `"agents"` to `respawnpack.config.json`'s `extras` array** (`agents/README.md` "Install placement"). It is the same additive, install-time gating as the skills axis above: a later re-run places the newly-declared extras fresh, without `--force`. This is placement scope, not a new capability: the pack carries no capability flag (the one it used to have, `--with-memory`, was retired with the memory engine, decision 33), so extras are declared in config rather than flagged on the command line.
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
- The `CLAUDE.md` managed marker block is a separate mechanism (marker-scoped, refreshed by `upgrade.js`; see the Upgrading section) and stays on plain `--force`: it's marker-scoped by regex and never touches text outside the markers, so there's nothing for `--force-all` to additionally protect there. The `.claude/rules/respawnpack/` rule files are version-aware the same way (plain `--force` refreshes a pack-marked file; a founder-taken-over one is never overwritten).

## The settings merge remembers what it placed
The hooks merge is additive: it never rewrites a group you authored, and it never removes an entry.
That used to mean it could not tell **"new in this pack version"** from **"you deleted this on purpose"**,
because from `settings.json` alone the two look identical: absent. So it re-added both, every run, and a
hook you had removed came back on the next install.

`.respawnpack/install-receipt.json` now records the `(event, matcher, command, if)` tuples the installer
placed, beside the adapter files it already tracked (and, since G1, a `placed` digest map described in the
uninstall section), and the merge reads it first:

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

**A widened matcher replaces the old entry, it never sits beside it** (G1). When a snippet entry's
matcher grows between pack versions (`injection-scan`'s `PostToolUse` matcher widened to catch the
subagent-result channel), the merge keys a hook on `(command, if)` within its matcher group, so the new
wide entry reads as missing and is added. An owned entry the current snippet no longer wires, but whose
same `(event, command)` it now wires under exactly one new `(matcher, if)` pair, is therefore **removed**:
the widened entry takes its place and the receipt tuple moves to the new wiring. Keying on `(event,
command)` and requiring a single new pair makes the old-to-new mapping unambiguous and catches a widened
matcher, a changed `if`, or both at once; a command the snippet wires under **several** pairs is left
untouched, which is what keeps `index-guard`'s two deliberate `PreToolUse` matchers and `secret-scan`'s two
`if`s all alive. An entry the receipt does **not** own is a founder's hook that happens to share the
command: it is left exactly as yours and named. With no
ownership record the merge stays add-only (a pre-receipt target keeps today's behaviour, and the summary
says so). This is what stops the field's duplicate `injection-scan` registration: the stale narrow one
still firing beside the new wide one after every upgrade.

**Present is not the same as ours.** A hook already in `settings.json` that is byte-identical to one the
pack would place is recorded as pack-owned only when the receipt says the pack placed it. A founder's own
identical hook, there before the pack placed it (on a first install, or as a hook new in this pack version),
is recorded apart under `settingsHooksFounder`, is never retired or replaced, and `uninstall.js` leaves it
where you put it. The deny rules, `claudeMdExcludes` and the worktree keys follow the same rule: an entry
is the pack's only when this run added it or a prior receipt says the pack placed it.

**An install that predates the record** (no receipt, or a `schemaVersion: 1` one) has no memory, so the
merge falls back to today's add-only behaviour **and says so in the summary** rather than letting you
believe a removal will stick when it cannot. That run records what it owns, so the next removal does. An
unparseable `settings.json` still skips the whole merge and leaves the file byte-identical; the ownership
record is carried forward unchanged rather than replaced with an empty one.

**The control-plane `permissions.deny` rules (C1, decision 32).** Under `standard` and `light` the
installer merges a set of `permissions.deny` rules into `settings.json`: an `Edit(…)`, a `Write(…)` and
a `NotebookEdit(…)` rule for each control-plane path (`.respawnpack/*`, `.respawnpack/runtime/**`,
`respawnpack.config.json`, `docs/derived/state/**`, `.claude/settings.json`,
`.claude/settings.local.json`, `.claude/hooks/**`, `.claude/agents/**`, `.mcp.json`, `.git/**`), so the
host refuses an editor-tool write to the control plane without a hook process. The merge is the same
union, exact-string, never-remove-a-founder's-entry discipline as `permissions.allow`, **plus** the same
ownership record the hooks have: `.respawnpack/install-receipt.json` records exactly the deny rules the
pack placed (`permissionsDeny`), so an upgrade never duplicates one, a flip to `strict` retires exactly
the pack's rules (strict emits none), and `uninstall.js` removes exactly ours while a deny rule you added
yourself, never recorded as ours, stays. The writeable namespaces `.respawnpack/scratch/**` and
`.respawnpack/onboarding/**` are deliberately uncovered, so a helper's draft stays writable. `strict`
emits **no** deny rules and keeps a byte-identical receipt; it relies on the editor hooks. What a deny
rule cannot see is a Bash redirection; `index-guard`'s fixed control-plane rule still refuses that in
every posture.

`uninstall.js` replays the same record, so a hook entry an older pack version wired, one today's snippet
no longer names, is still removed, while a hook of your own that neither names is left alone.

## Large-tree scoping: a preview unless `--write-settings` (D1)

On a large tree, the cost the field measured was the boot read set and the directory scans, not
retrieval. The installer's stack detector gains a second pass that, from what it already sees, proposes
the host's own scoping settings for the asset and generated directories that weigh a tree down, and
recommends the host's code-intelligence (LSP) plugin per detected language. **By default it writes
nothing: it PREVIEWS the block it would write and records that preview in the receipt.** The host page
each fact came from, read 2026-10-10 as data: the deny semantics (deny is evaluated before allow, and a
`Read` deny also blocks `Edit` and `Write`) are on [`permissions`](https://code.claude.com/docs/en/permissions.md);
the `claudeMdExcludes`, `worktree.symlinkDirectories` and `worktree.sparsePaths` KEY GRAMMAR (types,
defaults, absolute-path matching) is on [`settings-reference`](https://code.claude.com/docs/en/settings-reference.md),
the page the settings guide [`settings`](https://code.claude.com/docs/en/settings.md) links to per key
(the worktree feature itself is [`worktrees`](https://code.claude.com/docs/en/worktrees.md)); and the
official LSP plugin table is on [`plugins/code-intelligence`](https://code.claude.com/docs/en/plugins/code-intelligence.md).

**The two-signal rule, stated once in `install/_scoping.js`** and reused by the tests and by `doctor`. A
directory is NAMED only when BOTH hold: (1) it is a conventional asset/generated name (`node_modules`,
`dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `coverage`, `target`, `vendor`, `__pycache__`,
`.venv`, `venv`, `.tox`, `bin`, `obj`, `public/assets`, `public/static`, `static/media`, `assets/media`,
`*.xcassets`) OR a directory the target's `.gitignore` names as a whole single segment; AND (2) it is
large or binary by a cheap measure — more than 200 entries at one level, or more than 50 MB of
top-of-directory files, or more than half its sampled files binary (at most 500 entries sampled, never a
walk). The entry-count signal qualifies a conventional NAME; a gitignored-only name needs the size or
binary signal, so a gitignored `docs/` of markdown is not denied. An empty `dist/` (signal 1 only) and a
60 MB `src/` of source (signal 2 only, non-conventional) are both left alone.

**What it emits**, all through documented host settings:

- **`permissions.deny` `Read(<dir>/**)`** for each named directory, appended after C1's control-plane
  rules through the same emitter, receipt (`permissionsDeny`) and uninstall. A `Read` deny also blocks
  `Edit` and `Write` on the same paths, so a generated directory you edit by hand would be blocked —
  which is why it is a preview first. **It never emits `Read(.env*)` or any dotfile secrets pattern**: on
  host 2.1.259+ a `Read(.env*)` deny made every `cd DIR && grep` prompt for approval (gsd-core PR #4236),
  so the rule is always an explicit `Read(<dir>/**)` and a directory in the `.env` family is refused by
  name even if it qualifies by size.
- **`claudeMdExcludes`** — TWO patterns per directory: `**/<dir>/CLAUDE.md` for a `CLAUDE.md` directly
  inside it and `**/<dir>/**/CLAUDE.md` for one nested any depth below, so both depths are excluded even
  if the host's `**` does not match zero segments. Both carry the `**/` prefix because the host matches
  `claudeMdExcludes` against ABSOLUTE paths, so a bare `<dir>/CLAUDE.md` would never match.
- **`worktree.symlinkDirectories`** naming the dependency directories among the set (`node_modules`,
  `vendor`, `.venv`, `venv`, `target`) so a writer's worktree shares them instead of re-installing.
- **`worktree.sparsePaths`** is the one setting the preview prints but never writes without
  `--write-settings --sparse`, a second explicit flag, because a sparse checkout that omits a directory a
  test needs breaks a writer silently. It is emitted only when the named set covers more than half the
  tree by size, and then as the COMPLEMENT (the top-level directories NOT named), so no needed directory
  is omitted. A top-level directory is dropped from the complement ONLY when its WHOLE single segment is
  named: a nested named path like `public/assets` keeps its parent `public` in the complement (so
  `public/index.html` survives a sparse checkout) and relies on the `Read(public/assets/**)` deny to cover
  the heavy subdirectory.
- **The LSP plugin recommendation** per detected language, PRINTED and recorded in the receipt
  (`lspRecommended`) only — the pack never installs a plugin and never writes `enabledPlugins`, because
  plugin enablement is your marketplace action and a wrong write there is a settings fault the pack cannot
  verify. The thirteen official plugins the host lists map the detected languages as: TypeScript/JavaScript
  → `typescript-lsp`, Python → `pyright-lsp`, Go → `gopls-lsp`, Rust → `rust-analyzer-lsp`, Java/Kotlin →
  `jdtls-lsp` (Kotlin also has `kotlin-lsp`), C# → `csharp-lsp`, Ruby → `ruby-lsp`, PHP → `php-lsp`, Swift
  → `swift-lsp`, C/C++ → `clangd-lsp`; **Elixir (`mix.exs`) has no official plugin** and is named as such.

**The flags.** `--write-settings` turns the preview into writes (the deny rules, the excludes, the
symlink directories); `--sparse` additionally writes `worktree.sparsePaths`. `--sparse` without
`--write-settings` is refused, and either flag with `--dry-run` is refused (a dry run writes nothing). The
LSP recommendation is never written in any mode, and the receipt's `lspRecommended` is re-derived on every
run, so a tree with no scope left records none. `upgrade.js` forwards both flags to its install phase:
an upgrade run with `--write-settings` re-applies the scoping once (never duplicating a rule), and when a
directory no longer qualifies — a generated directory was deleted — its `Read`, exclude and worktree
entries are RETIRED (removed from `settings.json`) and named in the install summary, never dropped
silently. The whole feature is gated on a directory being named: on a project with no large tree (such as
`examples/todo-app`) nothing is emitted — no preview, no LSP line, no receipt key — and `doctor` reports
`scoping` NOT_APPLICABLE naming the two-signal rule. On a previewed target `doctor` shows a
`scoping` preview-only line; on a written target it shows one PASS row per family and removes exactly the
receipt's entries on uninstall. `strict` is byte-identical on the default (no-flag) run; `--write-settings`
is a non-default action a founder takes deliberately, and its Read denies follow C1's in any profile.

## The hook set is composed for your posture

`hooks/settings.snippet.json` is no longer copied fixed into every target. It is the **`strict` column of
a profile manifest** (`install/_settings-manifest.js`), and the merge composes it for the posture declared
in `respawnpack.config.json` (ADR-003). Three of the resolver's four sources, `DEFAULTED` (no key),
`UNREADABLE` (the config will not parse) and `INVALID` (a refused declaration), all compose `strict`, so an
existing target that says nothing, and a target whose config is broken, both get exactly what the pack has
always laid: 13 groups, 22 entries, byte for byte. The summary names which of the four you are in.

**A FRESH install now seeds `posture: {profile: "standard", seededBy: "installer"}` (decision 34)**, so a
new target composes the `standard` column from the first install rather than `strict`. An EXISTING target
with no posture key is never given one on upgrade, so it stays `DEFAULTED` to `strict` byte for byte
(decision 16's other half); `install/fixtures/strict-settings.json` pins that, and
`install/fixtures/standard-settings.json` pins what a fresh install now lays. `doctor` reports a seeded
posture as `DECLARED-BY-INSTALLER` — declared, but nobody has chosen it yet — kept distinct from a
founder's own `CONFIGURED` choice and from the `NOT_CONFIGURED` an unconfigured target shows.

What each profile composes:

| profile | groups | entries | omitted, and why | PreToolUse wiring |
| --- | --- | --- | --- | --- |
| `strict` | 13 | 22 | nothing. `strict` **is** the snippet. | one process per hook |
| `standard` | 12 | 14 | `websearch-freshness` and both `mcp-reaper` registrations (inert: one rule each, `off` under `standard` since C2, decision 32), **plus** `worktree-guard` and `lockdown` (retired, C1). The WebSearch group is dropped entirely. | editor group is index-guard alone (one process); the Bash group is one `dispatch.js` process |
| `light` | 12 | 14 | the same five as `standard` — C2 made the relaxed profiles compose the identical set: `websearch-freshness` and both `mcp-reaper` (inert), `worktree-guard` and `lockdown` (retired). | editor group is index-guard alone; the Bash group is one `dispatch.js` process |

**Three different subtractions, kept apart.** The `omitted` column is two reasons at once: a guard that is wholly `off` (inert: `websearch-freshness` and `mcp-reaper` under both relaxed profiles since C2) and a whole hook the profile **retires** (`worktree-guard` and `lockdown`, whose rules stay FIXED, so they compose and deny under `strict`). `push-guard` and `docker-session-tag` are NOT in the list: C2 switched their tier-1 and advisory branches `off`, but each keeps a FIXED half (`push-guard:tier2`, `docker-session-tag:label`), so the hook is never inert and stays wired. The wiring column is processes: `light` and `standard` compose the one fully-covered `PreToolUse` group that remains, the Bash group, as one
`node ${CLAUDE_PROJECT_DIR}/.claude/hooks/dispatch.js PreToolUse bash --covers <guards>` entry instead of
four separate ones: the same guards, in the same declared order, with the same verdicts, in one Node
process (see [`hooks/README.md`](../hooks/README.md#dispatchjs-one-process-per-pretooluse-registration-group)).
The editor group is **index-guard alone** after C1 (one process, no dispatcher, because wrapping a single
guard saves nothing). That is 22 − 3 (inert: `mcp-reaper` ×2 + `websearch-freshness`) − 2 (retired) − 4
(Bash per-hook entries) + 1 (the Bash dispatcher entry) = 14, the same for `light` and `standard`; the
group count drops from 13 to 12 because the WebSearch group loses its only entry. `strict`
composes none of these, because that profile is defined as exactly what 0.3.0 does and its composed bytes
are pinned. `secret-scan` is never folded in
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

**The receipt records the pack version that laid the files (G16, schemaVersion 4).** `packVersion` is
written on every fresh install **and** every upgrade (`upgrade.js` phase 2 is this install), read from the
same `VERSION` file the CLAUDE.md managed-block opener records, so a project can report the release it ran
without a reader having to infer it from the block. The kernel's `doctor install:pack-version` row reads it
back and cross-checks it against that opener: `INSTALLED` when they agree, `BROKEN` when they disagree (a
half-applied upgrade), `NOT_CONFIGURED` on a pre-G16 receipt, `NOT_APPLICABLE` when there is no receipt.
Like G1's `placed`, `packVersion` records only and withholds nothing, so a **`strict`** receipt is no longer
byte-for-byte what 0.3.0 wrote: the same sanctioned exception to "strict stays byte-identical" (decision 32),
and the strict-receipt key-set freeze (`install/install.test.mjs`) is widened by this one key. Every reader
still keys on a key's presence, never on the schema number, so a v2 or v3 receipt upgrades cleanly.


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

## The managed CLAUDE.md block, and the pack-owned rule files beside it

The `CLAUDE.md` managed block (between the `RESPAWNPACK:BEHAVIOR` markers) is kept **under 2 KB**: the
boot pointer, the interaction digest with the ⛔ "never infer goal mode" rule, and the six numbered
behaviour lines. It is composed the same for every project type. The standards it used to inline (the
safety-check baseline, the performance line, the licensing notice) now ship as pack-owned rule files
under **`.claude/rules/respawnpack/`**, which the installer lays, refreshes and uninstalls alongside the
block:

- `safety-checks.md` and `performance.md` carry YAML `paths:` frontmatter, so a host at or above
  **v2.1.211** loads each one only when the agent touches a matching file (test/hook/script/CI paths for
  the first, request-path and data-access paths for the second). `licensing.md` carries **no** `paths:`
  on purpose, because the licence must reach a session that never opens code.
- Each file's first marker line records the pack version that wrote it (`RESPAWNPACK:RULE v<version>`).
  A differing version, or `--force`, refreshes it in place; the same version is skipped. A file whose
  opening no longer carries that marker is one a founder has taken over, so it is **left untouched and
  reported**, never overwritten, the same guard the block has. The pack-owned `respawnpack/`
  subdirectory keeps these from ever colliding with a founder's own `.claude/rules/*.md`.
- `uninstall.js` judges the rule files by their **marker** (the founder-takeover signal), not by content:
  it removes exactly the marked rule files it knows by name (keeping a founder-taken-over one), and
  `upgrade.js` re-lays them. Since G1 the install also records each placed rule file's digest in the
  receipt's `placed` map, so the record is complete and the marker and the digest agree; the removal
  decision stays the marker. Recording those digests is why a `strict` receipt is **no longer byte-for-byte
  what 0.3.0 wrote** (its SHAPE gained the `placed` key, decision 32, re-dated for G1), while strict's
  BEHAVIOUR (which hooks, which settings, which files) is unchanged, because `placed` records only and
  withholds nothing. `doctor` does not yet report a pack rule a founder deleted or hand-edited; that is out
  of this task's scope and a later task if the owner wants it.

What the move does and does not buy: on a host at or above v2.1.211 a path-scoped rule costs a session
nothing until the agent touches matching code, so the per-session startup cost drops from the whole
7 KB block to the ~2 KB block alone. On an **older host** every rule under `.claude/rules/` loads at
session start like `CLAUDE.md`, so the saving there is the block shrinking; the rule files move bytes
from one startup file to another rather than deferring them.

`respawnpack.config.json`'s `projectType` decides which **rule file** a target receives (not which block
section: the block is identical for every type). The known types are `knowledge`, `docs-only`,
`ops-infra`, `greenfield-app` and `mature-product`; an unknown value is refused with a one-line notice
and writes no block or rule files, never guessed at from the file tree. A `knowledge`, `docs-only` or
`ops-infra` target has no request path, so it never receives `performance.md`.

**The same type also decides the reference standards set (G10).** A `knowledge` or `docs-only` target has
no code, request path, UI or test suite, so the installer omits the six software standards
(`coding-standards.md`, `testing-standards.md`, `performance-standards.md`, `observability-basics.md`,
`design-standards.md` with its five `design-standards/` detail files, and `skill-authoring-standards.md`)
and places only `writing-standards.md`, `behavior-standards.md`, `orchestration-patterns.md` and
`compliance-requirements.md` (plus `living-skills.md`, the `models/` routing register, and
`docs/reference/README.md`, which then lists only the subtrees it laid). The field measured those six
shipped byte-identical and unused on a document project. Every other type, and an undeclared target,
receives all of them exactly as before. **Opt-in survives the type:** name a software standard by its
stem in `respawnpack.config.json`'s `extras` array (for example `"extras": ["coding-standards"]`, or
`"design-standards"` to also bring its detail files) and a knowledge target receives that one back. The
upgrade re-lays by type: an installed project that declares `knowledge` and upgrades loses the six from
`docs/reference/` (the uninstall inventory names them, and a file that was never placed is simply absent
and skipped).

Declare the type one of two ways. On a fresh install, pass **`--project-type <t>`** (the same five values):
the installer composes CLAUDE.md for that type, writes `projectType` into the seeded config, and for
`knowledge` seeds the three declarations below, all in one run. An unknown value, a value with no argument,
or one that conflicts with a type an existing config already declares is refused before anything is
written. On an existing target you edit `projectType` into `respawnpack.config.json` and re-run, and the
upgrade back-fills the same declarations around it. (The flag and the config read the same vocabulary,
fenced against `PROJECT_TYPE_DROPS` so they cannot drift.)

`knowledge` is the name going forward for a document project (courseware, a book, SOPs, a knowledge base),
and `docs-only` is a recognised **alias** that composes the same block and seeds the same declarations, so
a target that already declares `docs-only` still installs. A `knowledge` (or `docs-only`) install declares
`routeSource`, `codeTruth` and `state.reconcile` not-applicable with a one-sentence reason each and
`seededBy: "installer"` — the installer declares only what the declared TYPE makes true (a document
project serves no routes, has no code that outranks its prose, and tracks no structured task list), never
what it infers from a tree, and `doctor` says so: `declared not applicable by the installer (projectType
knowledge): <reason>`. Every other type seeds none of this. These seeds are additive: a founder's own value
in any of those keys is never overwritten, and they fill in only on a fresh install or where the key is
absent on upgrade.

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

There are two connection paths. **direct** (`claude mcp add`) is for remote-OAuth endpoints (Supabase, Cloudflare) and local / CLI-coupled stdio tools (Graphify, Fly). **gateway** (`/mcp-runtime`, the Docker MCP gateway) is for keyed or third-party `npx` servers: it stores the credential in the OS keychain via `docker mcp secret set` and injects it at container runtime, instead of writing it into plaintext Claude config. The full routing rule lives in [`ops/README.md`, "Which way does a server connect?"](../ops/README.md#which-way-does-a-server-connect). Example output:
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

## The state kernel, and memory

`install.js` also places the executable kernel into `.claude/respawnpack/`: `respawnpack.js` plus its `lib/` (state, render, gate, removals, lineage, aar, readiness, site, closeout, memory, living, outcome, assert, modhealth, applicability, and reconcile where the posture carries it). Seventeen files under `strict` and `standard`, sixteen under `light`: ADR-003's rule table reads `kernel:R4 reconcile → n.a., not installed` in that column, so `install/_settings-manifest.js` projects the same posture onto `install/_sources.js`'s `KERNEL_FILES` that it projects onto the hook registrations, and `lib/reconcile.js` is withheld. `install/_sources.js` still declares all seventeen, because that list is what the PACK must be able to supply and `upgrade.js`'s preflight still demands every one of them before phase 1 strips anything. A posture flip re-lays what the new profile needs and retires what it no longer places, but only when the file on disk is byte-identical to the one this installer laid; the retirement is recorded under `kernelRetired` in `.respawnpack/install-receipt.json` so the flip back is visible. `doctor` reports a subsystem a profile withheld as `NOT_APPLICABLE`, naming the profile and the ADR row that withheld it, never `BROKEN`. That is the binary the quality-gate CI template invokes (`node .claude/respawnpack/respawnpack.js gate --verdict-file …`), and the one `doctor`, `status`, `savepoint --verify`, `removals`, `contract` and `living` all run through. There is no `respawnpack` command on `PATH`: the installer adds no `bin`. Every invocation that a session or a founder is told to RUN uses the `node .claude/respawnpack/respawnpack.js …` form, including the three runtime strings in `hooks/session-routing-nudge.js`. Prose elsewhere still writes the bare verb (`respawnpack living`, `respawnpack removals`) as shorthand when naming a capability rather than giving a command; that is deliberate, and it is why this sentence no longer claims "every documented invocation".

There is no memory flag. The install uses the zero-setup file backend (`memory/graph` plus grep), the one backend the pack ships; `doctor`'s memory row reports it directly, with no probe. The optional memory engine and its `--with-memory` flag were retired (decision 33, 2026-10-09); the installer no longer places an engine, runs no npm and creates no `.mcp.json`, so the PGLite `memory/.index/` tree can no longer be created by the installer.

**Legacy cleanup on upgrade.** A target installed by an older pack version still carries an engine, so `uninstall.js` (phase 1 of an upgrade) removes it as `KNOWN_LEGACY` work: the `.claude/respawnpack/memory/` tree, the `.mcp.json` `respawn-memory` registration (kept if the file holds another server), and the `memory.engine` record in `respawnpack.config.json`, each reported. A user's `memory/.index/` (the engine's own database) and `memory/graph/**` (the knowledge) are never touched; `doctor` names a left-over `memory/.index/` once as a legacy artifact the owner may delete.

**The host auto-memory mirror.** `memory candidates promote` writes the graph entity and mirrors one line into the host's native auto memory `MEMORY.md`, resolved in order: the `RESPAWNPACK_AUTO_MEMORY_DIR` environment override (tests and probes only), else `autoMemoryDirectory` from `.claude/settings.json`, then `.claude/settings.local.json`, then `~/.claude/settings.json` (a relative value resolves against the project root; policy scopes are not read), else `~/.claude/projects/<encoded>/memory/`. If the directory does not exist the mirror is NOT_APPLICABLE and the promotion still PASSes on the graph write; nothing is created. `reject` removes the mirror. The index line is withheld (CANNOT_DETERMINE, the memory file still written) if it would push `MEMORY.md` past the host's 200-line or 25 KB cap. The pack only ever writes and removes its own `respawnpack-*` files and the lines tagged by their names.

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
  the `.claude/rules/respawnpack/` rule files (removed only while they still carry the pack marker; one a
  founder took over is kept and reported, and a founder's own `.claude/rules/*.md` are never named),
  the `.github/workflows/respawnpack-*.yml` CI templates, and `.respawnpack/` (runtime state, the one
  recursive removal). The `mcp-*` skills are enumerated **ungated** from the pack source plus `KNOWN_LEGACY`,
  so a skill placed when the stack matched (say `mcp-fly` from a Fly era) is still removed after the stack
  moved on and the install-time gate went silent about it, the orphan class the 2026-07-11 upgrade harvest found.
- **Shared-namespace files are judged against the install receipt, not the current source** (G1):
  `ATTRIBUTION.md`, `catalog/README.md`, `library/**`, `.github/CODEOWNERS`, `.claude/LICENSE.respawnpack`
  and the receipted adapters each carry, in `.respawnpack/install-receipt.json`'s `placed` map, the
  sha256 (CRLF-folded) of the bytes the install placed. The uninstaller compares the bytes on disk to
  **that digest**, and names the rule that decided each file:
  - **equal → "unchanged since install"**: removed, so a reinstall re-places the current version. This
    holds even if the file changed **upstream** since you installed, and even if the pack **retired** the
    source, because the digest alone proves the pack placed it. (Before G1 the uninstaller compared to the
    current source, so a file changed upstream but untouched locally read as "modified", was kept, and the
    reinstall never re-placed it: the field saw `ATTRIBUTION.md` / `catalog/README.md` / `library/README.md`
    stay stale after every upgrade. A retired source was also kept forever.)
  - **different → "edited since install"**: kept and listed by name, so a local edit is never lost.
  - **no digest on file** (an install that predates `placed`, or a torn/absent receipt, all "no memory"):
    the uninstaller falls back to the old current-source comparison and says so per file
    ("no digest in the receipt; compared to the current source"), so the verdict is never silent about
    which rule decided. A CRLF-only difference is not an edit on either rule.
  The receipt is trusted the way `STATE.json` is: a hand-forged `placed` digest made to match a
  locally-edited file would make that edit read as unchanged and remove it. That forged-receipt case is
  outside the guarantee, the same trust root the whole pack rests on. The B4 rule files are listed in
  `placed` too, but they are still judged by their marker (the founder-takeover signal), not by the
  digest. `--dry-run` computes and prints the identical per-file verdicts the real run acts on, from one
  verdict function, so the preview a founder reads before acting cannot disagree with the run.
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
Don't want the script? A hand copy needs everything the installer places, not the four directories an earlier version of this line named. **How many files that is depends on which install-time gates fire** (the stack-gated `mcp-*` skills, the `extras` agents, the compliance scope, the posture's kernel projection), so this page carries no number: `--dry-run` prints the exact count for your target, on the day you run it. Copy `spine/*` to `docs/`, the skill dirs to `.claude/skills/`, `agents/*.md` to `.claude/agents/`, `hooks/*.js` (including every `_`-prefixed shared module listed under "What it lays down" above, plus `dispatch.js`, and `hooks/pre-push` to `.git/hooks/`) to `.claude/hooks/`, `workflows/*` to `.claude/workflows/`, `adapters/claude-code/{interactive,sdk-supervisor,statusline}/*.js` (skipping every `*.test.mjs` and `sdk-supervisor/fixtures/`) to the matching `.claude/adapters/claude-code/` subdirectory, `kernel/*` to `.claude/respawnpack/`, `library/*`, `memory/*`, the `templates/CLAUDE.md` managed block, and `templates/rules/respawnpack/*.md` to `.claude/rules/respawnpack/` (substituting the pack version into the `RESPAWNPACK:RULE` marker, and omitting `performance.md` for a `knowledge`/`docs-only`/`ops-infra` target), then merge `hooks/settings.snippet.json` into `.claude/settings.json`. That merge gives you the `strict` set, which is the one that is safe to hand-merge. Verify the result with `node .claude/respawnpack/respawnpack.js doctor` rather than by counting files.

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
