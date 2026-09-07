# RespawnPack: Ops layer (MCP-first)

The managed-infra control surface. RespawnPack's deliberate inverse of the build-your-own-binaries stance: for infra actions (DB, deploy, secrets, status), **prefer the managed-service MCP tools** over shell. They give direct, typed, verifiable control of the exact services the product runs on.

**Scope note:** this layer is managed-infra-first. It drives Supabase, Fly, Cloudflare, and Vercel-class services directly through their MCP servers, and that is where it is strongest: direct, typed, verifiable control of the real platform APIs. For self-managed or PaaS stacks (docker-compose, Render, Kubernetes, plain Postgres/Redis/Celery) where no managed-service MCP is wired, the ops skills still apply, but they degrade to the platform's own CLI and generic procedures (`docker`, `render`, `kubectl`, `psql`, `alembic`, and the like). In that mode the MCP-first instruction becomes "use the platform CLI, and verify against prod truth." This is a scope statement, not an apology: the managed-infra path is simply what RespawnPack targets.

## The ops skills
| Skill | Role |
|---|---|
| [`deploy-verify`](deploy-verify/SKILL.md) | confirm a deploy actually landed + works in prod (pairs with `/ship`) |
| [`db-ops`](db-ops/SKILL.md) | schema/migrations/queries via the DB MCP (migration-before-deploy, RLS baseline, read-safety) |
| [`secrets-audit`](secrets-audit/SKILL.md) | secret hygiene: inventory vs platform, redaction, rotation (pairs with the secret-scan hook; the secrets dimension of [`/secure`](../skills/secure/SKILL.md)) |
| [`infra-status`](infra-status/SKILL.md) | a health snapshot across the managed services |

> 📝 **Parameterize on install** to the target's actual MCP servers. Set `opsTargets` in `respawnpack.config.json` (the stack, e.g. `db=supabase`, `host=fly`, `edge=cloudflare`, `host=vercel`) so each skill knows which MCP toolset to reach for. Where an MCP server isn't connected, the skill falls back to the vendor CLI (`flyctl`, `wrangler`, `supabase`, `gh`) and says so.

## Standalone scripts
Plain Node scripts, no `SKILL.md`, run directly — never installed onto a target.

| Script | Role |
|---|---|
| [`sweep-scratch.mjs`](sweep-scratch.mjs) | recovery tool: move a subagent's scratch output (`.respawnpack/scratch/<agent>/**`) to where it was meant to go, verifying by byte size rather than existence. Preview by default; `--write` performs it. Moved out of the kernel (P2-K-13) — same refusals, including the `--into` containment guard reused from `kernel/lib/removals.js`. `node ops/sweep-scratch.mjs [--dir <d>] [--into <d>] [--write] [--json]` |

## MCP server skills (`ops/mcp/`): per server, living
A skill per MCP server we drive, but only where the vendor doesn't already ship one. Where they do (Cloudflare and Vercel ship full skills; Supabase / Context7 / Playwright / GitHub ship skills for the product knowledge), RespawnPack references the vendor skill and adds a thin guardrail layer; it never forks them.

| Skill | Server | Kind | Connect |
|---|---|---|---|
| [`mcp-runtime`](mcp/runtime/SKILL.base.md) | the Docker MCP gateway itself: run servers, profiles, keychain secrets | create-custom | n/a (it IS the gateway) |
| [`mcp-fly`](mcp/fly/SKILL.base.md) | Fly.io (`mcp__fly__*`) | create-custom | direct (wraps host `flyctl`) |
| [`mcp-supabase`](mcp/supabase/SKILL.base.md) | Supabase | wrap-thin → `supabase/agent-skills` | direct (remote OAuth) |
| [`mcp-context7`](mcp/context7/SKILL.base.md) | Context7 external-library docs | wrap-thin → `upstash/context7` | gateway (pre-wired on managed infra) |
| [`mcp-github`](mcp/github/SKILL.base.md) | GitHub MCP + `gh` CLI | wrap-thin → Anthropic plugins | direct or gateway (remote-hosted; the skill doesn't mandate one) |
| [`mcp-security-audit`](mcp/security-audit/SKILL.base.md) | npm-dep CVE scan (the JS leg of `/secure`) | create-custom | gateway preferred (npx isolation), direct fallback |
| [`mcp-graphify`](mcp/graphify/SKILL.base.md) | Graphify structural code graph (`Graphify-Labs/graphify`, MIT, PyPI `graphifyy`, pinned) | create-custom | direct (filesystem-coupled) |

These are **living skills** (frozen baseline + adaptive overlay). Doctrine: [`../spine/reference/living-skills.md`](../spine/reference/living-skills.md).

### Which way does a server connect?
RespawnPack wires a server one of two ways: a direct `claude mcp add ...` (per-server, its own process, credentials in `.mcp.json`/`.claude.json`), or through the Docker MCP gateway (`mcp-runtime`: one endpoint, keychain-injected secrets, container isolation). They are not interchangeable, and every printed command in this pack is a direct add except where noted below. Route by what the server actually is:

1. **Remote OAuth / hosted HTTP endpoints** (Supabase, Cloudflare: `claude mcp add --transport http <name> https://...`): **direct add**. The gateway only proxies these as remote OAuth endpoints rather than local signed containers (its own documented caveat, see [`mcp-runtime`](mcp/runtime/SKILL.base.md#honest-caveats)), so routing them through it adds a hop with no isolation or secret benefit.
2. **Local, filesystem- or host-CLI-coupled stdio tools** (`mcp-fly` wraps the host's authenticated `flyctl`; respawn-memory's `rmem mcp` reads this repo's `memory/` dir; Graphify serves a local `graph.json` and rules the gateway out in its own skill, see [`mcp-graphify`](mcp/graphify/SKILL.base.md)): **direct add**. Containerizing buys volume mounts and re-auth, not isolation that matters here.
3. **Keyed and/or third-party-code servers** (`mcp-security-audit` and similar `npx -y` servers; firecrawl, which needs `FIRECRAWL_API_KEY`; Context7; Playwright when adopted): **the gateway** ([`mcp-runtime`](mcp/runtime/SKILL.base.md)). `docker mcp secret set` puts the key in the OS keychain instead of plaintext `.mcp.json`/`.claude.json` (what the secret-scan hook and [`/secrets-audit`](secrets-audit/SKILL.md) hunt for), the container isolates code this pack didn't write, and one endpoint serves every client. Use the gateway's signed catalog when the server is listed there, an OCI/custom server via the gateway when it is not. This is the bucket that earns `mcp-runtime` its billing as the operational half of MCP-first, not the other two.
4. **No Docker Desktop** (or Windows without WSL2, the gateway's own requirement): direct add is always legitimate, even for a keyed server from bucket 3, but the key then lands in plaintext config. Say so, and point at [`/secrets-audit`](secrets-audit/SKILL.md) and the secret-scan hook.

The table above annotates each server's bucket. Exact commands: the table's links, [`mcp-runtime`](mcp/runtime/SKILL.base.md), and the [catalog page](../catalog/README.md).

### The starter kit
Three layers, not a pile of one-off adds:
1. **User-scope direct adds**: remote-OAuth endpoints (Supabase, Cloudflare), host-CLI-wrapped tools (Fly), personal/local apps (Obsidian and the like). Set once, cover every project.
2. **One gateway entry**, also user-scope and set once: `claude mcp add MCP_DOCKER -- docker mcp gateway run --profile <name>`, carrying the whole containerized third-party set behind a single endpoint.
3. **Per-project direct adds**, only for servers actually coupled to a repo: respawn-memory (reads *this* repo's `memory/`) and Graphify (serves *this* repo's `graph.json`). These can't be user-scope by nature.

**Fast path:** `docker mcp profile pull respawnhere/respawn_pack` pulls the pack's reference profile instead of hand-building one, server by server.
- It bundles roughly 32 signed servers: research reach (playwright, fetch, duckduckgo, wikipedia, and more), utilities, security, and `mcp/memory`, the Anthropic knowledge-graph server that is exactly this pack's memory backend 2 (see [`memory/knowledge-graph.md`](../memory/knowledge-graph.md#one-schema-three-backends)).
- Prune to taste: `docker mcp profile server remove <server>` drops one, `docker mcp profile tools` trims a server's tool allowlist. More servers means more tools means more context spent per session, so prune toward what the project actually uses.

**Hands-off:** enable Docker Desktop's "Start Docker Desktop when you sign in" setting (Settings → General); the gateway then starts at session start and each server's container lazy-boots on its first tool call, no manual step needed.

**Scope:** both the direct adds and the gateway entry are user-scope and set-once, no per-project re-wiring. Only repo-coupled servers are per-project by nature. Keeping a bucket-3 server (e.g. `mcp-security-audit`) as a direct user-scope add instead of routing it through the gateway is a legitimate deliberate exception to the routing rule above, not a violation.

## Release smoke (`ops/release-smoke.mjs`), once per posture profile
`node ops/release-smoke.mjs` installs the product into a fresh disposable target and drives the whole lifecycle against it: install, doctor, state, savepoint, the quality gate in three project shapes, the delegate and goal contracts, memory, living skills, upgrade, uninstall, schema conformance, DF-005 reconciliation, real concurrent replacement through the installed kernel, and a conditional live-Docker check. It never touches a real project, and it deletes each target when it is done.

Since ADR-003 the installer composes a different registration set and a different kernel placement per declared posture, so the run is per profile rather than once. **Selection:** `--profile <name>`, repeatable and comma-separated. With no flag the run does `strict` then `light`. `strict` is the freeze, the column an existing target with no `posture` key composes, so it is the one whose lifecycle must not move; `light` is the only column that actually withholds anything, so it is the only one that can show a withheld subsystem degrading honestly. `standard` is runnable by name and is not in the default pair because it composes the same set as `strict` today. A name that is not one of `hooks/_posture.js`'s profiles is refused at exit 2 before any step runs, because a run that could not be performed is CANNOT_DETERMINE, not a failure.

There is no installer flag for a posture, deliberately: ADR-003 has exactly one reader of a project's posture and it reads the project's own `respawnpack.config.json`. Each profile's target therefore seeds and commits that declaration the way a founder would, and the install genuinely runs under it.

Each profile's section of the report names the composed hook set (entry count, group count, the hooks actually wired, and what this profile omitted) and the placed file count (what the installer reported, what is on disk under the target's `.claude/`, and how many kernel files of the full list were placed). Two verdicts then judge the run, both computed in [`_smoke-profiles.mjs`](_smoke-profiles.mjs) so they can be driven through their failing states in milliseconds by [`release-smoke.test.mjs`](release-smoke.test.mjs) rather than only by a multi-minute install:

- **Reproduction.** Every row of a pinned capture, taken from a clean run on the unmodified tree, still ran, in order, and passed. `strict` may decline nothing. Another profile may decline a row only as NOT_APPLICABLE carrying the reason the target itself gave, never by the row quietly ceasing to appear. A row that could not be run at all, such as the memory-engine step on a host with no npm, is CANNOT_DETERMINE rather than either.
- **Footprint.** Every hook carrying a fixed rule id is wired in every profile, derived from `hooks/_posture.js`'s own fixed set crossed with `install/_settings-manifest.js`; `strict` composes the whole snippet; and `light` is strictly smaller than `strict` on every measure. A profile that withheld nothing would have passed vacuously, which is worse than failing.

## Test tiers (`ops/suite-counts.mjs`)
`node ops/suite-counts.mjs --tier full` (the default) runs every suite named in the script's own `SUITES` array. This is the release gate: mandatory at every phase boundary, and unchanged from what this file always did. `node ops/suite-counts.mjs --tier fast` runs a smaller set, `FAST`, computed inside the script by excluding named suites from `SUITES` rather than hand-typing a second list, so the two sets cannot drift apart. Every exclusion carries its own reason (too slow for the fast tier's two-minute budget, or exercising a host adapter not in use); the four suites named by the pack's own anti-drift contract stay in the fast tier by construction, checked on every run. Both tiers extract each suite's own `# tests` / `# pass` / `# fail` summary and treat a suite that will not parse as a hard failure; that contract does not vary by tier. The fast tier is a convenience for iterating on a task; it is never a substitute for `--tier full` at a release or phase boundary.

## Project fixtures (`ops/_project-fixtures.mjs`)
`materialize(kind, dir)` writes one of four deterministic project trees to a directory: `docs-only` (a documentation repository with no toolchain), `ops-infra` (Terraform, an Ansible inventory, a compose file and shell scripts, no application code), `greenfield-app` (a Node service with lint, test and build scripts, an OpenAPI file and a schema) and `mature-product` (the same shape plus CI, CODEOWNERS and a release history). The four kinds are checked against `install/install.js`'s own `PROJECT_TYPE_DROPS` in both directions, so the fixture vocabulary and the installer's declared `projectType` values cannot drift apart. It never installs the pack itself; a suite that needs the pack on top of a fixture runs `install/install.js` separately. See `ops/project-fixtures.test.mjs` for exactly what each kind proves.

## Safety rules (every ops skill honors)
1. **Reads vs writes.** Read freely (status, schema, logs). A **prod write** (migration, secret set, scale, destroy) needs the same explicit human authorization as a push: name the target, state the effect, ask.
2. **Migration/secret before the code that needs it.** Apply schema/secret prerequisites *before* the deploy, or the deploy ships a broken surface (see `/ship`).
3. **Never print secret values.** Reference keys by name; verify presence, not contents.
4. **Prod reads may be gated.** Some harnesses soft-block direct prod DB reads. If blocked, surface it and ask rather than working around it.
5. **Verify against prod truth**, not assumptions. That's the whole point of MCP-first.
