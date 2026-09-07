# Claude Code limits: skills and agents

What Claude Code actually permits and charges for skills and subagents, verified 2026-07-10 two ways: the official docs (code.claude.com/docs — skills.md, sub-agents.md) and a string-literal scan of the locally installed CLI binary (v2.1.205, `~/.local/share/claude/versions/`). The pack installs 27 skills + 32 agents into every target (originally ~25/30 when measured; see the pre-fix snapshot note below), so these numbers are the pack's operating envelope, not trivia. Measured pack footprint is included at the bottom.

## The limits

| Item | Value | Kind | Verified |
|---|---|---|---|
| Per-skill `description` + `when_to_use` in the listing | **1,536 chars combined**, longer is truncated | hard default, configurable `skillListingMaxDescChars` | docs + binary |
| Skill-listing context budget | **`skillListingBudgetFraction`, default 1% of the context window**; overflow truncates descriptions (warning names the remedy: disable skills or raise the fraction) | hard default, configurable | docs + binary |
| Legacy env override | `SLASH_COMMAND_TOOL_CHAR_BUDGET` takes precedence when set | env var | binary |
| Per-skill listing overrides | `skillOverrides`: `name-only` (listed, no description) · `user-invocable-only` (hidden from model, `/name` kept) · `off` (hidden from both) | setting | docs + binary |
| `when_to_use` frontmatter | **Officially honored**: "Guidance for when the model should reach for this skill. Becomes part of the tool description." | spec | docs + binary (schema string) |
| Other honored skill frontmatter | `name`, `description`, `model`, `allowed-tools`/`disallowed-tools`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `effort`, `shell`, `version`, `paths`, `hooks`, `context`, `agent`, `mcpServers` | spec | binary (key list) |
| SKILL.md body size | **<500 lines guidance**, no hard limit found; body loads only on invocation and then stays in context for the session | guidance | docs |
| Reference files in a skill dir | Unlimited; load on demand; >300-line files should carry a TOC | guidance | skill-creator |
| `name` frontmatter | **≤ 64 chars**, lowercase/numbers/hyphens, no XML tags, no reserved words | hard | platform docs |
| Number of skills | Claude Code: no hard cap — the listing budget is the effective cap. **API surface: hard cap of 8 skills per request/container** | surface-dependent | docs + platform docs |
| Subagent frontmatter | `name`, `description` (required); `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills` (preloads full skill content into the subagent), `mcpServers`, `hooks`, `memory`, `isolation`, `effort`, `initialPrompt` | spec | docs |
| Subagent context | Fresh, isolated window per spawn; skills/agents budgets are separate; preloaded skills bill the subagent, not the parent | mechanics | docs |
| MEMORY.md injection into subagents | First **200 lines or 25 KB**, whichever first | hard | docs |
| Subagent nesting | 5 levels max | hard | docs |
| Number of agents / agent description length | UNDOCUMENTED — no cap found in docs or binary strings | — | — |
| Agent description style | Bundled authoring guidance: skill descriptions carry the user's trigger phrases; **agent descriptions should include `<example>` blocks** | guidance | binary |

Diagnostics in a live target: `/doctor` shows the skill-listing cost and its biggest contributors; `/context` shows the listing as the model actually receives it (post-budget). `/skills` toggles per-skill listing state. A cheap routing diagnostic from the vendor guide: ask Claude "when would you use the X skill?" — it quotes back the description it actually sees (post-truncation), which surfaces a silently-truncated listing from inside the conversation.

## Cross-surface constraints (vendor guide, resources hub)

"The Complete Guide to Building Skills for Claude" (resources.anthropic.com/hubfs, Jan 2026 — a resources-hub PDF *outside* the docs tree; found by the owner, missed by the docs-scoped sweep) adds validation-level constraints the docs pages don't state:

| Item | Value | Note |
|---|---|---|
| `description` field | **≤ 1,024 chars**, must contain both WHAT and WHEN | validation cap on the field itself — coexists with the 1,536-char *listing* cap, which covers description + `when_to_use` and governs display truncation |
| Frontmatter content | **no XML angle brackets `< >`** anywhere | injection guard — frontmatter lands in the system prompt (pack audited 2026-07-10: one violation found in `mcp-context7` `when_to_use`, fixed) |
| Skill names | kebab-case only; **"claude"/"anthropic" prefixes reserved** | pack clean |
| Skill folder | no README.md inside the skill dir (docs go in SKILL.md or `references/`) | pack clean; `SKILL.base.md` is a bundled resource, not a README |
| SKILL.md body | "under 5,000 words" phrasing of the same guidance as <500 lines | consistent |
| Simultaneous skills | **"more than 20–50 enabled" is the vendor's own caution threshold** (recommend selective enablement / packs) | the pack installs 25 — inside the caution zone; independently corroborates the budget-overflow finding |
| `compatibility` frontmatter | optional, 1–500 chars, environment requirements | not currently used by the pack |
| Anti-overtrigger pattern | negative triggers in the description ("Do NOT use for X — use Y instead") | candidate for sharpening the `playtest` ↔ `walkthrough` boundary |

## Mechanics worth knowing

- **Three-level loading**: metadata (name + description + when_to_use) is always in context; the SKILL.md body enters context only when the skill fires and then persists for the session; bundled reference files load individually on demand. Body length is therefore a per-invocation cost, description length a per-session cost on every session.
- **Truncation is silent from the model's side.** When the listing overflows the budget, some skills' descriptions are dropped from what the model sees. A skill whose description was dropped can still be user-invoked (`/name`) but the model can no longer route to it by prose. The CLI prints a warning; nothing in the conversation shows it.
- **Descriptions are the routing.** Claude also under-triggers skills on simple one-step requests by design, so descriptions should carry explicit, pushy trigger phrasing (Anthropic's own skill-creator guidance). `when_to_use` is the sanctioned place for trigger phrases; it is appended to the description in the listing and counts toward the 1,536-char cap.

## The pack's measured footprint (2026-07-10, at `74b0b37`)

25 installed skills (13 roles + 7 `mcp-*` + 4 ops + `knowledge`), 30 agents.

- **Per-skill cap: all clean.** Largest combined `description` + `when_to_use` is `mcp-graphify` at 929 of 1,536; next `mcp-runtime` 805, `respawn` 693. No file approaches the cap.
- **Total listing payload: ~12,900 chars (≈3,200 tokens) before names and formatting overhead.** Against the default 1% budget this **overflows on a standard 200k-context model** under either reading of the budget unit (1% of 200k as chars = 2,000; converted at ~4 chars/token = ~8,000). Consequence: in a fresh target, some pack skills are silently listed without descriptions and their prose routing goes dead — before the target's own skills spend a single character of the same budget.
- Skill bodies: all ≤82 lines against the 500-line guidance. Agent files: largest 19.1k chars (`system-architect`). The design-standards index + per-§ split matches the recommended reference-file pattern exactly.

**Remediation applied (W4a, 2026-07-11):** the levers below were implemented as a composition per the prior-art round-2 T2/T3 specs — seven listings trimmed (−1,383 chars, all trigger phrases byte-preserved), `skill-guard` + `mcp-graphify` flipped to `disable-model-invocation` (chained/opt-in, not prose-routed), `mcp-fly`/`mcp-supabase`/`mcp-security-audit` conditionally installed on detected stack, and the installer now merges `skillListingBudgetFraction: 0.02` (never clobbering a user value, disclosed in the summary). Post-fix measure: 11,502 chars total, **10,376 model-visible (~2,594 tokens)** worst-case, ~9.3–9.9k typical — inside the 0.02 budget with headroom. Residual verification: confirm via `/context` in a live target that `disable-model-invocation` removes listing chars (binary-corroborated, not doc-confirmed). The figures in the footprint section above are the pre-fix snapshot, kept for history.

## Levers (decision pending at the time — since applied, see above)

1. **Raise the budget at install time.** The installer already merges `settings.json`; adding `skillListingBudgetFraction: 0.02` gives ~2× headroom for the pack plus the target's own skills, at an honest cost of ~2% of context per session spent on listings. Should be disclosed in the installer summary, not slipped in.
2. **Trim the long tail.** Average combined payload is ~516 chars/skill; the top four (`graphify` 929, `runtime` 805, `respawn` 693, `wordsmith` 678) can lose a third without losing their trigger phrases. Trimming alone cannot get 25 skills safely under the default budget (~350 avg needed), so this composes with lever 1 rather than replacing it.
3. **`skillOverrides: name-only` for low-routing-value skills.** Candidates are skills reached mainly by explicit command or by another skill's instruction rather than by prose routing. Costs model-side discoverability; use per-target, not as a pack default.
4. **Agent bench follow-up:** add `<example>` blocks to the 30 agent descriptions per the bundled guidance — a routing-quality lever independent of the budget issue.

## Platform docs (API surface + cross-surface facts)

Swept 2026-07-10 (agent-skills section: overview, best-practices, enterprise, quickstart, claude-api-skill, skills-guide, API reference — 8 pages). **No contradictions with anything above.** The API-surface hard limits, for when pack skills ever ride the API / Agent SDK rather than Claude Code:

| Item | Value | Kind |
|---|---|---|
| Skills per API request/container | **8 max** | hard |
| Skill upload size | **≤ 30 MB** total | hard |
| API skill runtime | **no network access, no runtime package installs** — pre-configured deps only (Claude Code: full network; claude.ai: admin-dependent) | runtime |
| Cross-surface sync | custom skills do **not** sync — separate upload per surface (API / claude.ai / Claude Code) | mechanics |
| Skills + ZDR | **not eligible** for Zero Data Retention | data retention |
| Versioning | custom skills get epoch versions, `latest` alias; delete requires removing all versions first | mechanics |
| Required beta headers (API) | `code-execution-2025-08-25`, `skills-2025-10-02`, `files-api-2025-04-14` | mechanics |
| `display_title` frontmatter | optional; must be unique among custom skills; dir name must match `name` (case/underscore-insensitive) | validation |

Authoring guidance the platform docs add beyond the Code docs: descriptions in **third person**; reference files kept **one level deep** from SKILL.md; **TOC for reference files >100 lines** (stricter than skill-creator's 300); forward slashes only in paths; MCP tools referenced by **fully qualified `ServerName:tool_name`** (a polish item for the pack's `mcp-*` skills, which name tools loosely in prose). Pack implication: the pack's skills shell out freely (git, node, gh) and are therefore **Claude Code-native — they would not run on the no-network API runtime**; if that ever matters, the `compatibility` frontmatter field is the sanctioned place to declare it.

Sources: code.claude.com/docs/en/skills.md · code.claude.com/docs/en/sub-agents.md · platform.claude.com/docs/en/agents-and-tools/agent-skills/* + build-with-claude/skills-guide + api/skills/* · `anthropic-skills:skill-creator` (authoring guidance) · string scan of CLI v2.1.205 · "The Complete Guide to Building Skills for Claude" (resources.anthropic.com/hubfs, Jan 2026). Method note: skills documentation spans THREE properties — code.claude.com/docs (Claude Code), platform.claude.com/docs (API/platform), and the resources hub — plus the engineering blog and anthropics/skills. Scope limit sweeps by topic across all of them, not by product; both coverage gaps in this research were product-scoped sweeps that missed a property.
