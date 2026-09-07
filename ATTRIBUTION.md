# RespawnPack: Attribution & Credit Ledger

RespawnPack stands on a lot of other people's work. This ledger credits every upstream the [catalog](catalog/README.md) references or the [library](library/README.md) vendors: **author · repository · license · how to install**. All licenses were verified via `gh api repos/<owner>/<repo> --jq '.license.spdx_id'` (and `npm view` / local `package.json` where relevant) on **2026-06-20**.

## How to read this
- **Referenced:** credited, linked, and installable from its own source; RespawnPack does **not** copy its content. This is the default.
- **Vendored:** copied into [`library/`](library/) under a confirmed permissive license, with credit + a provenance line preserved (`> Source: <url> · retrieved <date> · <license>`) — enforced mechanically by the `library/library.test.mjs` content scan in CI.
- **Policy:** every catalogued skill traces to a permissively-licensed source (MIT / Apache-2.0); RespawnPack references them by default (credit + link) and could vendor any into `library/` under its license. Reference-first keeps the pack lean and credits upstreams; it is not a licensing necessity. See [catalog/README.md](catalog/README.md).

---

## Skill sources

The catalog references **154** skills (China/Korea-market-specific skills excluded), every one traced to a permissively-licensed upstream, verified 2026-06-20 by fetching each repo's full file tree via `gh api` and matching names + content.

### Persona / multi-domain agent collection, ~134 skills (the bulk)
- **Source:** [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents), **Michael Sitarzewski** ([@msitarzewski](https://github.com/msitarzewski)). (~127.7k★ as of 2026-07-06)
- **License:** **MIT** (permissive, referenced, vendorable).
- **What it covers:** the `# X Agent Personality` → `🧠 Your Identity & Memory` collection across every domain: `engineering-*`, `marketing-*`, `sales-*`, `paid-media-*`, `product-*`, `project-management-*`, `support-*`, `testing-*`, `academic-*`, `specialized-*`, the XR/spatial/game set, and the singletons (`agents-orchestrator`, `accounts-payable-agent`, `zk-steward`, `identity-graph-operator`, `terminal-integration-specialist`, `specialized-mcp-builder`, …). Our installed files match agency-agents' bodies byte-for-byte; only the YAML frontmatter (color/emoji/vibe) was stripped on install.
- **Mirror:** the same collection is published under our exact flat slug names at [GammaLabTechnologies/harmonist](https://github.com/GammaLabTechnologies/harmonist) (**MIT**), the likely proximate source of the installed naming. Either way the operative license is MIT.
- **Ancestral origin:** ~33 of these personas derive from [contains-studio/agents](https://github.com/contains-studio/agents) (**Michael Galpert** ([@mgalpert](https://github.com/mgalpert)) / Contains Studio, 12.4k★), which carries **no license**. agency-agents / harmonist (both MIT) are the actual hosts of the installed files; contains-studio is credited as the upstream origin of that subset.
- **Install:** `git clone https://github.com/msitarzewski/agency-agents`

### Cloudflare official, 9 skills
- **Source:** [cloudflare/skills](https://github.com/cloudflare/skills), **Cloudflare**.
- **License:** **Apache-2.0**.
- **Skills:** `cloudflare`, `cloudflare-email-service`, `durable-objects`, `workers-best-practices`, `wrangler`, `agents-sdk`, `sandbox-sdk`, `turnstile-spin`, `web-perf`.
- **Install:** `/plugin marketplace add cloudflare/skills` → `/plugin install cloudflare@cloudflare`; or `npx skills add https://github.com/cloudflare/skills`.
- **Footnote:** `turnstile-spin` sets up a managed Turnstile *siteverify* Worker (mirrors the [Cloudflare Turnstile docs](https://developers.cloudflare.com/turnstile/): a runtime flow it scaffolds, not a separate skill source).
- **Upstream note (2026-07-06):** the upstream repo now ships 11 skills; two additions, `cloudflare-one` and `cloudflare-one-migrations`, are not yet catalogued here.

### Higgsfield, 4 skills
- **Source:** [higgsfield-ai/skills](https://github.com/higgsfield-ai/skills), **Higgsfield AI**. (CLI: [higgsfield-ai/cli](https://github.com/higgsfield-ai/cli), MIT.)
- **License:** **MIT**.
- **Skills:** `higgsfield-generate`, `higgsfield-marketplace-cards`, `higgsfield-product-photoshoot`, `higgsfield-soul-id`.
- **Install:** `git clone https://github.com/higgsfield-ai/skills`
- **Upstream note (2026-07-06):** a fifth skill, `higgsfield-websites`, was added upstream and is not yet catalogued here.

### Design & UI, 7 skills
- **Source:** [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), **nextlevelbuilder**. (~94k★)
- **License:** **MIT**.
- **Skills:** `ui-ux-pro-max`, `ui-styling`, `banner-design`, `brand`, `design`, `design-system`, `slides` (the `ckm:` namespace cluster).
- **Note:** `ui-styling` originates from **claudekit** (`ckm:ui-styling`); its frontmatter declares MIT but it ships an `Apache-2.0` `LICENSE.txt` (a bundled-dependency license). Effective license is **MIT** via this repo.
- **Install:** `git clone https://github.com/nextlevelbuilder/ui-ux-pro-max-skill`

### `web-interface-guidelines`, referenced and rewritten, 1 source
- **Source:** [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines), **Vercel Labs**.
- **License:** **MIT** (verified via LICENSE file: "Copyright (c) 2025 Vercel Labs").
- **Relationship:** the credited source behind `design-standards.md` §1 and §2: a tier-1 rewrite into RespawnPack's own structure, voice, and organization, never copied verbatim. Full credit note below under "Design standard". Distinct from the sister repo `vercel-labs/agent-skills`, which ships no LICENSE file and stays reference-only (see the WATCHLIST, a development record).
- **Install:** referenced only, nothing to install; the doctrine is fetched from `command.md` in the source repo.

### `frontend-aesthetics` notebook, referenced, 1 source
- **Source:** [anthropics/claude-cookbooks](https://github.com/anthropics/claude-cookbooks), **Anthropic**.
- **License:** **MIT**.
- **Relationship:** a cookbook notebook on prompting for frontend aesthetics; the clean root of the community "frontend designer" skill lineage. Referenced for technique, not reproduced.
- **Install:** referenced only, nothing to install.

---

## Branded plugin marketplaces (referenced + credited)
| Marketplace | Author | Repo | License | Add |
|---|---|---|---|---|
| Anthropic official | Anthropic | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Apache-2.0 | `/plugin marketplace add anthropics/claude-plugins-official` |
| Compound Engineering | [EveryInc](https://github.com/EveryInc) (Every) | [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin) | MIT | `/plugin marketplace add EveryInc/compound-engineering-plugin` |
| Stitch | Google Labs | [google-labs-code/stitch-skills](https://github.com/google-labs-code/stitch-skills) | Apache-2.0 | `/plugin marketplace add google-labs-code/stitch-skills` |
| SwiftUI Pro | [twostraws](https://github.com/twostraws) (Paul Hudson) | [twostraws/SwiftUI-Agent-Skill](https://github.com/twostraws/SwiftUI-Agent-Skill) | MIT | `/plugin marketplace add twostraws/SwiftUI-Agent-Skill` then `/plugin install swiftui-pro@swiftui-agent-skill` |

> SwiftUI Pro is opt-in: relevant only for founders also shipping a native iOS app. It complements `ui-ux-pro-max` (the visual layer) at the code-correctness layer for SwiftUI specifically.

## MCP servers (referenced + credited)
| MCP | Author | Repo | License | Add |
|---|---|---|---|---|
| security-audit | esx ([qianniuspace](https://github.com/qianniuspace)) | [qianniuspace/mcp-security-audit](https://github.com/qianniuspace/mcp-security-audit) | MIT | `claude mcp add security-audit -- npx -y mcp-security-audit`¹ |
| Supabase | Supabase | [supabase/mcp](https://github.com/supabase/mcp) | Apache-2.0 | `claude mcp add --transport http supabase https://mcp.supabase.com/mcp` |
| Fly | Fly.io ([superfly](https://github.com/superfly)) | [superfly/flyctl](https://github.com/superfly/flyctl) | Apache-2.0 | `claude mcp add fly -- flyctl mcp server` |
| Cloudflare | Cloudflare | [cloudflare/mcp-server-cloudflare](https://github.com/cloudflare/mcp-server-cloudflare) | Apache-2.0 | `claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp` |
| Obsidian | cyanheads (Casey J. Hand) | [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | Apache-2.0 | self-host: `git clone` → `npm i && npm run build` → `claude mcp add obsidian -- node <path>/dist/index.js` |

¹ security-audit, like other third-party `npx` servers, runs unpinned on the host; the Docker MCP gateway runs it container-isolated instead, with any secrets held in the OS keychain rather than local config. See [`ops/README.md`](ops/README.md), "Which way does a server connect?"

> The Supabase and Cloudflare MCPs connect as vendor-hosted HTTP endpoints; the OSS repos above are the canonical first-party sources to credit. Stitch's hosted MCP (`stitch.googleapis.com/mcp`) is a closed Google service with no public repo, so credit flows through the `stitch-skills` marketplace.

### Research-reach MCP servers
Verified via `gh api repos/<owner>/<repo> --jq '.license.spdx_id'` on **2026-07-06**. See [`catalog/README.md`](catalog/README.md) for the escalation framing (default pack vs. situational).

| MCP | Author | Repo | License | Add | Verified |
|---|---|---|---|---|---|
| playwright-mcp | Microsoft | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Apache-2.0 | `claude mcp add playwright npx @playwright/mcp@latest` | 2026-07-06 |
| firecrawl-mcp-server | firecrawl (org transferred from mendableai) | [firecrawl/firecrawl-mcp-server](https://github.com/firecrawl/firecrawl-mcp-server) | MIT¹ | `claude mcp add firecrawl --env FIRECRAWL_API_KEY=fc-YOUR_API_KEY -- npx -y firecrawl-mcp`³ | 2026-07-06 |
| Scrapling | D4Vinci | [D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling) | BSD-3-Clause | `pip install "scrapling[ai]" && scrapling install` then `claude mcp add ScraplingServer -- scrapling mcp` | 2026-07-06 |
| CloakBrowser | CloakHQ | [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser) | MIT (wrapper); proprietary binary license² | mounts under `playwright-mcp` as its Chromium executable; no separate `claude mcp add` | 2026-07-06 |

¹ firecrawl-mcp-server itself is MIT. Its parent repo, [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl), is **AGPL-3.0** (146k stars); the MCP server is the permissively-licensed piece, the core engine is not.
² CloakBrowser's wrapper code carries an MIT license, but the Chromium binary it wraps is a separate, proprietary, dual-tier grant (`BINARY-LICENSE.md`): the free tier is a deliberately-stale previous Chromium major, and the current binary requires a paid key. Redistribution and SaaS-embedding are prohibited under that binary license. Do not cite this project as plain MIT; the binary, not the wrapper, is the part that gates use.
³ This firecrawl command writes `FIRECRAWL_API_KEY` into plaintext Claude config. Keyed, third-party `npx` servers like it route more safely through the Docker MCP gateway instead, where the key lives in the OS keychain; see [`ops/README.md`](ops/README.md), "Which way does a server connect?"

### Site-testing MCP servers
Verified via `gh api` on **2026-07-10**. See [`catalog/README.md`](catalog/README.md), "Site-testing reach," for the vetting verdicts (including the evaluated-and-not-adopted candidates, recorded there with reasons).

| MCP | Author | Repo | License | Add | Verified |
|---|---|---|---|---|---|
| chrome-devtools-mcp | Chrome DevTools team (Google) | [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Apache-2.0 | `claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --isolated --no-usage-statistics --no-performance-crux` | 2026-07-10 |

## MCP-server agent skills (referenced by RespawnPack's `mcp-*` skills)
RespawnPack's [`ops/mcp/`](ops/mcp/) skills are **reference-first wrappers**: where the developers ship a skill, RespawnPack credits + points to theirs and adds only its own guardrails. It never forks or restates them. Verified via `gh api` on **2026-06-22**.

| Vendor skill(s) | Author | Repo | License | RespawnPack use |
|---|---|---|---|---|
| `supabase`, `supabase-postgres-best-practices` | Supabase | [supabase/agent-skills](https://github.com/supabase/agent-skills) | MIT | `mcp-supabase` wraps it (guardrails only) |
| `cloudflare`, `wrangler`, … | Cloudflare | [cloudflare/skills](https://github.com/cloudflare/skills) | Apache-2.0 | use-vendor (see Skill sources) |
| `vercel-plugin` (25 skills) + `agent-skills` | Vercel | [vercel/vercel-plugin](https://github.com/vercel/vercel-plugin) · [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | none published¹ | reference-only |
| `context7-mcp`, `context7-cli`, `find-docs` | Upstash | [upstash/context7](https://github.com/upstash/context7) | MIT | `mcp-context7` wraps it |
| `webapp-testing` | Anthropic | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) | Apache-2.0² | `/playtest` routes to it (Playwright) |
| `code-review`, `commit-commands`, `pr-review-toolkit` | Anthropic | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Apache-2.0 | `mcp-github` leans on them |

¹ vercel/vercel-plugin and vercel-labs/agent-skills ship no LICENSE file (verified via `gh api` 2026-07-06). No explicit grant means reference-only: credit and link, never vendor or copy, until Vercel publishes a license.
² anthropics/skills licenses per-skill rather than at the repo root: the repo-level license reads null, but `skills/webapp-testing/LICENSE.txt` is genuine Apache-2.0 (verified 2026-07-06). Future audits should not misread the repo-root null as unlicensed.

**Prior art adapted (credited, MIT, not copied):** [`jeremylongshore/…/flyio-pack`](https://github.com/jeremylongshore/claude-code-plugins-plus-skills) informs `mcp-fly` (no vendor Fly skill exists); [`majiayu000/claude-skill-registry`](https://github.com/majiayu000/claude-skill-registry) `memory-graph` is the surface-compatible prior art the RespawnPack memory engine adapts; [`garrytan/gbrain`](https://github.com/garrytan/gbrain) (**MIT**) is the architectural reference it draws its markdown-to-PGLite/pgvector hybrid-retrieval and typed-graph conventions from.

### Graphify, referenced and wrapped, 1 skill
- **Source:** [safishamsi/graphify](https://github.com/safishamsi/graphify), **Safi Shamsi** (transferred to the Graphify-Labs org). PyPI package `graphifyy`.
- **License:** **MIT**.
- **Relationship:** referenced and wrapped as an external tool via the `ops/mcp/graphify` skill; never vendored or copied. Evaluated 2026-07-08 against v0.9.10, pinned as `graphifyy==0.9.10`.
- **Techniques that informed, not were copied into, the memory engine** (independently implemented in `memory/engine/`, concepts credited): query logging, outcome feedback, incremental sync, central input caps, near-duplicate flagging, and freshness hooks, patterns observed in Graphify's `querylog.py`, `reflect.py`, `cache.py`, `semantic_cleanup.py`, `dedup.py`, and `hooks.py` respectively.
- **Install:** `pip install graphifyy==0.9.10` (or `uv tool install graphifyy==0.9.10`).

---

## Licensing notes
- **The skill catalog is fully traced and permissively licensed.** The persona bulk is [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (MIT, mirrored at GammaLabTechnologies/harmonist), with ~33 personas ancestrally from the unlicensed `contains-studio/agents` (credited as origin, not the host). RespawnPack references all skills by default; any could be vendored under MIT/Apache. Reference-first is a choice the project makes for leanness, and it is not a licensing necessity.
- **Apache-2.0 sources** (Cloudflare skills, the Supabase/Fly/Cloudflare/Obsidian MCPs, the Anthropic + Stitch marketplaces): §4 requires retaining `LICENSE` + any `NOTICE` + attribution **on redistribution**. RespawnPack *references* these and does not vendor them, so crediting + linking here discharges the obligation. If you later vendor any into `library/`, bundle its `LICENSE` + `NOTICE`.
- **`ui-styling`**: declares MIT (claudekit origin) but ships an Apache-2.0 `LICENSE.txt`; effective license MIT via `nextlevelbuilder/ui-ux-pro-max-skill`.

## Compliance reference documentation
The compliance layer ([`library/compliance/`](library/compliance/)) cites and (where redistributable) vendors official regulatory/standards texts: NIST (US Government, public domain), EUR-Lex (© EU, reuse with attribution per Decision 2011/833/EU), UK legislation (Crown copyright, Open Government Licence v3.0), and US/Canada government sources (public domain). Copyrighted standards (ISO 27001, PCI-DSS, AICPA SOC 2) are **linked, not reproduced**. Full citations + licenses: [`library/compliance/references/SOURCES.md`](library/compliance/references/SOURCES.md).

## Writing-quality skill (`/wordsmith` + writing standards)
The `/wordsmith` skill, the writing standards (`spine/reference/writing-standards.md`), and the two research briefs kept in the development repository (`ai-writing-quality.md` and `ai-text-markers-and-human-preference.md`) are RespawnPack-original, authored by **respawnhere** with **GPT (OpenAI)**, June 2026, and AGPL-3.0-or-later like the rest of the framework.
- **Prior art, credited and not copied:** [blader/humanizer](https://github.com/blader/humanizer) (**MIT**, [@blader](https://github.com/blader)), a Claude Code skill that catalogues recurring AI-writing patterns. `/wordsmith` is an independent implementation grounded in the briefs above; it does not vendor or fork humanizer.
- **Literature cited, not reproduced:** Shaib et al. *Measuring AI "Slop" in Text*; Chakrabarty, Laban & Wu *Can AI Writing Be Salvaged?*; Herbold et al. *AI, write an essay for me*; Holtzman et al. *The Curious Case of Neural Text Degeneration*; Kobak et al. *Delving into LLM-assisted writing in biomedical publications through excess vocabulary*; NIH *Plain Language*; CDC *Clear Communication Index*; Wikipedia *Signs of AI writing*. URLs are in each brief's Sources section.

## Behavior standard (`behavior-standards.md` + the CLAUDE.md baseline block)
The behavior standard (`spine/reference/behavior-standards.md`, installed to `docs/reference/`) and the managed `CLAUDE.md` block the installer writes (`templates/CLAUDE.md`) are **RespawnPack-original, AGPL-3.0-or-later**, authored by **respawnhere**, July 2026.
- **Prior art, credited and not copied:** the four principles (think before coding, simplicity first, surgical changes, goal-driven execution) distill **Andrej Karpathy**'s public observations on recurring LLM coding failure modes, circulated by the community as the "karpathy guidelines". The canonical community formulation is [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) (transferred from forrestchang/andrej-karpathy-skills; the old URL redirects) (~188k★, **no license**, still no license after the transfer; verified via `gh api` 2026-07-06), with smaller MIT-licensed adaptations (e.g. [reskywtf/cursor-karpathy-guidelines](https://github.com/reskywtf/cursor-karpathy-guidelines)). Because the canonical text is unlicensed, RespawnPack expresses the ideas independently and quotes none of these texts; the fifth rule (proportionality) makes their own stated tradeoff explicit.

## Design standard (`design-standards.md`)
The design standard (`spine/reference/design-standards.md`, installed to `docs/reference/`) is **RespawnPack-original, AGPL-3.0-or-later**, authored by **respawnhere**, July 2026.
- **Interaction craft and visual system (§1-§2), rewritten with credit:** [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) (**Vercel Labs**, **MIT**, verified via LICENSE file: "Copyright (c) 2025 Vercel Labs") is a terse, testable set of interaction and UI rules. RespawnPack rewrites these into its own structure, voice, and organization rather than reproducing them, credited here and in the standard's own sources section. Distinct from the sister repo `vercel-labs/agent-skills`, which ships no LICENSE file and stays reference-only (see the WATCHLIST, a development record).
- **Psychology of use (§3), curation credited, expression original:** the selected laws cite their original researchers by name in the standard itself (Miller, Fitts, Hick and Hyman, Tversky and Kahneman, Csikszentmihalyi, Wertheimer, and others). The selection and naming of these laws as a set of 30 is curated in **Jon Yablonski**'s *Laws of UX* (lawsofux.com), which is **CC BY-NC-ND 4.0**: its non-commercial and no-derivatives terms are incompatible with any free-software license, this pack's AGPL-3.0-or-later included, so RespawnPack cites the underlying primary research directly and credits Yablonski's curation and naming once, in the standard's sources section, without paraphrasing his explanatory prose.
- **Accessibility baseline (§4), quoted from official sources:** cited by success-criterion number from **W3C WCAG 2.2** (W3C Document License: copy and distribute for any purpose with attribution), the **GOV.UK Design System** (Open Government Licence v3.0), **USWDS** (CC0, public domain), and **The A11y Project** (Apache-2.0).

## Role agents (`agents/`)
The 32 role agents in [`agents/`](agents/) (6 review lenses, 11 engineering/infra advisors, 13 business/research advisors, 2 write-scoped onboarding mappers) are **RespawnPack-original, AGPL-3.0-or-later**, authored by **respawnhere**, July 2026, written to a shared template with original text throughout. The `design-reviewer` lens is RespawnPack-original; the two onboarding mappers' pipeline shape is adapted from `open-gsd/gsd-core` (credited in the Wave 6 table below).
- **Prior art, credited and not copied:** the role **concepts**, meaning the idea of a named specialist for a given domain (a backend architect, a growth strategist, an SRE), draw on the broader persona-agent ecosystem, foremost [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (**MIT**), whose role concepts several of these names share. A content-containment analysis run 2026-07-05 confirmed the pack's earlier installed persona copies (the `skills/` bulk credited above) shared no text with these ancestral collections, and these 29 files were written fresh regardless of that finding: the concepts are credited, no text is copied from agency-agents or any ancestral collection.
- **Market scope:** written for NA/EU-market use, consistent with the rest of the framework's advisory roles.

## Prior-art round 2 (`skill-authoring-standards.md`, `/build` + `/loadout` grafts)
A second prior-art sweep (2026-07-10/11) mined six further MIT-licensed repos for concepts, verified via `gh api repos/<owner>/<repo> --jq '.license.spdx_id'`. Two artifacts already carry adapted concepts from this sweep: [`spine/reference/skill-authoring-standards.md`](spine/reference/skill-authoring-standards.md) (RespawnPack-original, AGPL-3.0-or-later, authored by **respawnhere**) and three grafts onto [`skills/build/SKILL.md`](skills/build/SKILL.md) and [`skills/loadout/SKILL.md`](skills/loadout/SKILL.md). Everything below is a rewrite from a description of the mechanism, never copied text; the mining notes and license verdicts behind it are retained privately, and every verdict bearing on shipped content is stated here.

| Repo | Author | License | Concept credited | Status |
|---|---|---|---|---|
| `addyosmani/agent-skills` | Addy Osmani | MIT | `source-driven-development` → `/build` Step 3's cited-doc-or-`UNVERIFIED` discipline; `doubt-driven-development` → `/build` Step 3's capped mid-build skeptic pass; `interview-me` → `/loadout` Step 1's one-question-at-a-time interview; the uniform skill anatomy + description doctrine behind `skill-authoring-standards.md` rules 1-3; the three-tier (structural/routing/behavioral) skill-eval taxonomy | **Adapted** — the three grafts, the authoring standard, and the eval taxonomy's structural + routing tiers (`skills/skills.test.mjs`); the behavioral tier stays a **candidate** (Stage 3, deliberately deferred) |
| `mattpocock/skills` | Matt Pocock | MIT | `writing-great-skills` + `GLOSSARY.md` (leading words, progressive disclosure, co-location, sediment/sprawl/no-op/negation) behind `skill-authoring-standards.md` rules 5, 10-15; the model-invoked/user-invoked cost-split framing for the skill-listing budget problem; the `git-guardrails-claude-code` hard-block hook pattern | **Adapted** — the authoring standard, the cost-split framing (`disable-model-invocation` dispositions for `skill-guard`/`mcp-graphify`), and the hard-block hook pattern (`hooks/push-guard.js`, marker-gated per the pack's own authorized-push rule) |
| `obra/superpowers` | Jesse Vincent / Prime Radiant | MIT | `writing-skills`' "match the guidance form to the failure" taxonomy + rationalization-table mechanism behind `skill-authoring-standards.md` rules 7, 9; the RED-GREEN-REFACTOR-for-skills authoring methodology; the compaction-surviving progress-ledger, file-handoff discipline, and reviewer-prompt anti-patterns for orchestration resilience | **Adapted** — the authoring standard and the wave-ledger convention (`.respawnpack/wave-ledger.md` + the `PreCompact` nudge hook, folded by `/savepoint`, rehydrated by `/respawn`); the RED-GREEN-REFACTOR-for-skills eval methodology stays a **candidate** (Stage 3). Credited for the taxonomy and mechanism only — its coercive, ALL-CAPS "your human partner" register was deliberately not carried into RespawnPack's plainer voice. |
| `open-gsd/gsd-core` | Open GSD | MIT | the tighten-only-ratchet + allowlist-ratchet size-budget patterns; the wave/file-ownership overlap check and `PreCompact`/`SubagentStop` hook-wiring pattern; the router-skill concept (plus the finding that Claude's Skill tool hard-errors on an unregistered name) | **Adapted** — the ratchets (`skills/skills.test.mjs`'s budget ceiling + shrink-only allowlists) and the overlap-check/hook-wiring patterns (`hooks/spawn-guard.js`, `hooks/precompact-ledger-nudge.js`, the orchestration primer). The router concept was **evaluated and not adopted** (broken on Claude Code per upstream issue #924 — their own Claude adapter reverted to a flat listing) |
| `ColeMurray/background-agents` ("Open-Inspect") | Cole Murray | MIT | the spawn-depth/concurrency guardrail concept; the four-state watchdog taxonomy (never-started / gone-quiet / idle-but-healthy / past-hard-ceiling); the recurring-run circuit-breaker convention | **Adapted** — the spawn guardrail (`hooks/spawn-guard.js`, advisory-first with an opt-in strict mode) and the watchdog taxonomy + circuit-breaker convention (the orchestration primer's unattended-run section) |
| `davila7/claude-code-templates` | Daniel "San" Ávila | MIT (root); **aggregator** | the security-content-scan CI-gate concept, crediting **NVIDIA SkillSpector** (Apache-2.0) as the actual scanning tool the concept wraps | **Adapted** (2026-07-11) — the CI-gate concept shipped as `library/library.test.mjs`: a zero-dependency content scan over vendored `library/` text (the runtime `injection-scan` hook's signature list imported as the single source of truth, plus provenance-line, unsafe-link, and executable/encoded-payload checks, empty shrink-only allowlists). NVIDIA SkillSpector (Apache-2.0) is credited as the scanning-tool concept the CI-gate idea wraps; no SkillSpector code was used or ported. This repo's own catalog aggregates other upstream sources under their own licenses (`wshobson/agents`, the `contains-studio/agents` lineage, `obra/superpowers`, and others) already credited directly elsewhere in this file — any future adoption from those clusters should cite the primary source, not this repo as an intermediate hop. |

The full mining notes behind this table — six per-repo provenance blocks and five theme-mining passes, each recording the license verdict and any hazards found — are retained in the project's private development records rather than published here. Every verdict they reached that bears on what RespawnPack ships is stated in this file; the notes are the working papers, and this table is the conclusion.

### Wave 6 — the catalog-walk adoptions (2026-07-11)
The item-by-item walk over the same round-2 sources (553 items dispositioned; the round-2 prior-art review, Wave 5 results, a development record) landed a second tranche of adaptations. Same discipline: rewrite-and-own from a description of the mechanism — every implementation written first-principles from the walk findings without reopening the clones; no text copied.

| Source (author · license) | Concepts adapted in Wave 6 |
|---|---|
| `open-gsd/gsd-core` (Open GSD · MIT) | worktree-write containment as a tool-layer hook (`hooks/worktree-guard.js`); read-side injection scanning (`hooks/injection-scan.js`); context-utilization monitoring (`hooks/context-monitor.js`); worktree-isolated, atomic-per-finding fix application (`/review`/`/playtest`); the AI-integration spec trigger, closest-analog and assumptions-evidence passes (`/loadout`/`/build`); unattended-batch rails co-source (`/build` auto mode); the brownfield-onboarding pipeline shape (designed in the brownfield onboarding design note, a development record, then built as `/onboard` + the write-scoped `codebase-mapper`/`docs-ingestor` class under the owner-approved Option A) |
| `obra/superpowers` (Jesse Vincent / Prime Radiant · MIT) | the Interfaces (Consumes/Produces) block + spec self-review (`/loadout`); the session-start routing nudge (`hooks/session-routing-nudge.js`); condition-based waiting for async regression tests (`/playtest`); the receiving-feedback discipline (`behavior-standards.md` rule 5); reviewer-prompt anti-patterns, file-handoff-via-files, and the model-tier policy (now in `orchestration-patterns.md`); test-first co-source (`testing-standards.md`) |
| `addyosmani/agent-skills` (Addy Osmani · MIT) | the expand/contract migration discipline (`/db-ops` + `/loadout`); `/build` auto-mode safety rails; cross-vendor second-opinion escalation (`/build`/`/review`); named orchestration anti-patterns + the competing-hypothesis pattern (`orchestration-patterns.md`, `/debug`); the API-contract stability rule (`coding-standards.md` rule 10); the quality-gate CI template; the OWASP LLM Top 10 lens (`/secure`); the observability instrumentation-design floor (`observability-basics.md`); the AI-tell visual check (design-standards §2) and dependency-diff discipline (`/review`); TDD co-source (`testing-standards.md`) |
| `mattpocock/skills` (Matt Pocock · MIT) | testing-standard concepts (seams, anti-patterns, red-before-green); the module-depth rule (`coding-standards.md` rule 9) and its `/checkup` health-scan pair; debug feedback-loop-first + ranked falsifiable hypotheses (`/debug`); the ADR-worthiness test, throwaway-prototype detour, fog-of-war planning split, and wide-refactor expand/contract exception (`/loadout`) |
| Vercel Engineering (MIT, surfaced via the aggregator's catalog) | frontend-rendering performance rules (`performance-standards.md` rules 13–14 + the rule-12 extensions) |
| `davila7/claude-code-templates` (Daniel "San" Ávila · MIT — aggregator-native items only, per the trace-to-primary rule above) | the WebSearch year-freshness nudge (`hooks/websearch-freshness.js`); the context-statusline concept (merged into `hooks/context-monitor.js`); the stop-savepoint OS toast; **from the full hooks-category walk (2026-07-11):** the context-timeline real-token-usage mechanism (transcript `message.usage` parsing → `context-monitor.js`, replacing the byte proxy); the update-search-year auto-rewrite concept (→ `websearch-freshness.js`, implemented via the harness's documented `updatedInput` field); the secret-scanner commit-time trigger (→ `secret-scan.js`); the dangerous-command-blocker + shell-wrapper-guard pair, adopted as one command-aware hook (→ `hooks/shell-guard.js` — the pairing matters: the blocker's own anchors are bypassable exactly the way the wrapper-guard catches). The `tdd-gate` item was evaluated and declined (a hard test-first gate cuts against the pack's ceremony-to-blast-radius rule). `hooks/mcp-reaper.js` is RespawnPack-original (motivated by observed gateway lifecycle behavior, no upstream design) |

## Model capability sources (`spine/reference/models/`)

The model capability register (`spine/reference/models/capability-register.json` and the rendered `capability-register.md` beside it) and the four prompting practice files are **RespawnPack-original, AGPL-3.0-or-later**, authored by **respawnhere**, September 2026. They are a **citation index and nothing is vendored**: no benchmark, dataset, harness, leaderboard table, evaluation code or documentation page is reproduced here.

- **What each entry carries:** the URL of the model maker's own documentation or announcement, or of a named third-party evaluation; the date the page was read (2026-09-03 throughout); and the specific claim that source supports. Short positioning sentences are quoted with the URL on the same line, as citations. Nothing is quoted at a length that could stand in for the source.
- **Model makers cited, referenced only:** **Anthropic** (platform.claude.com, anthropic.com, claude.com), **OpenAI** (developers.openai.com, learn.chatgpt.com, and staff announcement threads on community.openai.com), **MiniMax** (platform.minimax.io, minimax.io, and the MiniMaxAI model cards hosted on Hugging Face).
- **Named third parties cited, referenced only:** **Vals AI** (Terminal-Bench 2.1 leaderboard), **Artificial Analysis** (model pages and evaluations), **Vellum** (benchmark explainers), **Simon Willison** (weblog), **Wikipedia**, **VentureBeat**, and one open issue on MiniMax's own GitHub repository. Each is credited in the register itself, on the line carrying the claim it supports.
- **Every figure is attributed to the party that published it**, and the register says whether that party is the maker of the model being rated or an outside evaluator. Where two sources disagree, both are recorded rather than one being chosen.
- **No trademark, endorsement, affiliation or partnership is claimed.** Model names and vendor identifier strings are used nominatively, to name the products they name.
- **Nothing unverified enters.** A claim the pack's own dated research file could not confirm against a fetched page is excluded from the register by rule, which is why several widely circulated benchmark figures are absent from it.

## RespawnPack's own work
The framework itself (the docs spine, the role skills in [`skills/`](skills/), the [`ops/`](ops/) skills, the governance [`hooks/`](hooks/), the [`workflows/`](workflows/) and [`templates/`](templates/), and the [`install/`](install/)er) is **RespawnPack-original, AGPL-3.0-or-later** (see [LICENSE](LICENSE)).
