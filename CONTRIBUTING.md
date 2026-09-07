# Contributing to RespawnPack

RespawnPack is a Claude Code framework for solo founders / small teams on managed infra. See [docs/](docs/) for the vision and architecture.

## Layout
| Dir | What |
|---|---|
| `spine/` | the anti-drift docs templates (canonical/derived/reference) |
| `skills/` | the role library (respawn/loadout/build/review/playtest/walkthrough/ship/debug/secure/comply/savepoint/wordsmith/checkup/onboard/task) |
| `memory/` | knowledge-graph conventions + the `/knowledge` skill |
| `ops/` | MCP-first ops skills (deploy-verify, db-ops, secrets-audit, infra-status) |
| `hooks/` | governance hooks (lockdown, secret-scan, stop→savepoint, push-guard, index-guard, injection-scan, …; 15 in total) |
| `workflows/` | reusable Workflow-tool templates |
| `catalog/` | reference-first credited index of curated third-party skills + MCPs (not copied) |
| `library/` | RespawnPack-shipped content (currently the per-requirement compliance checklists + cited sources under `compliance/`) |
| `ATTRIBUTION.md` | credit ledger: author · repo · license per source (reference-first: credit + link, copy nothing unlicensed) |
| `install/` | the installer, the one-command upgrader (`upgrade.js`), and the mirror uninstaller |
| `docs/` | RespawnPack's own vision/architecture docs + research briefs |

## How to add things
- **A skill**: `skills/<name>/SKILL.md` (or `ops/`/`memory/` for those categories) with frontmatter (`name`, `description`, `when_to_use`) + the procedure. Write it to the authoring standard (`spine/reference/skill-authoring-standards.md` — listing budget, guidance forms, pruning tests); match the existing skills' shape; honor the shared principles in `skills/README.md`. Add it to the installer's `skillDirs` list.
- **A hook**: a Node script in `hooks/` (no `jq`/shell-branching, for cross-platform parity) + an entry in `hooks/settings.snippet.json` + a README row. Smoke-test it (pipe sample hook JSON) before committing — pipe from bash/Git Bash: Windows PowerShell 5.1's string piping doesn't reliably reach node's stdin, so a PS smoke-test can false-negative on a working hook.
- **A workflow template**: `workflows/<name>.workflow.js` following the Workflow-tool DSL; keep `meta` a pure literal; honor moderate-concurrency.

## Principles (non-negotiable)
- **Harness-native** over custom binaries (Agent/Workflow/Task/Skill/Hook primitives).
- **MCP-first** for infra.
- **WRITE-ONCE + spine-aware**: skills read canonical truth and *propose* edits; they never invent product truth or hand-edit derived docs.
- **Reads free, writes authorized**: no push / prod-write without an explicit human go-ahead.
- **Dogfood**: validate changes against a real repo before release.

## Conventions
Conventional commits. Hooks/installer in Node (cross-platform). Keep skills tight (a procedure). Test hooks + the installer before committing. Write to the coding and writing standards. Comment *intent*, not mechanics (`spine/reference/coding-standards.md` and `spine/reference/writing-standards.md` here; they land under `docs/reference/` once installed). A test that needs a project tree uses `ops/_project-fixtures.mjs`'s four archetypes (`docs-only`, `ops-infra`, `greenfield-app`, `mature-product`) instead of a hand-rolled one; a mechanism that only two archetypes exercise differently still needs fixtures from both, never one.
