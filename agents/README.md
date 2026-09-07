# RespawnPack: Role agents

Thirty-two [Claude Code project subagents](https://docs.claude.com/en/docs/claude-code/sub-agents) (`.md` files with YAML frontmatter: `name`, `description`, `tools`) that ship in this pack. A **core set of 22** installs to a target repo's `.claude/agents/` by default; the remaining **10 opt-in business/research advisors** install only on request (see "Install placement" below). Read-only by default: a reviewer or an advisor finds, designs, and reports; it never edits code or writes files itself. The deliverable lives in the response, and applying it is the job of the `/build` loop or the human reading that response. Keeping "propose" and "change" as separate tool grants, not just a convention someone has to remember, is what makes that boundary hold. **One named exception exists** — the two onboarding mappers below carry `Write` (no Edit, no Bash), bounded to the gitignored `.respawnpack/onboarding/` scratch dir and verified by `/onboard`'s git-status containment gate; an owner-approved, deliberately scoped grant (see that section), not a precedent for widening others.

## Install placement

Two tiers. The **core set** installs by default, every run, no flag needed. The **opt-in extras** are a
different product — ten commercial-function advisors (marketing, sales, support, finance) that most
solo-founder/small-team repos never call — and install only on request. Agents are inert files with no
executable capability (no code path admits `agents/` at all; see "Attribution and status" below), so this
is a placement-scope decision, not a second product capability: ADR-002 (a development record)
reserves `--with-memory` as the pack's one capability flag, so extras are declared, not flagged. Add
`"agents"` to the `extras` array `respawnpack.config.json` already carries for adoption-interview opt-ins
(`/respawn`'s first-run interview can record this the same way it records the design-capability opt-in),
then (re)run the installer — a later re-run places the newly-declared extras fresh, without `--force`. An
existing `respawnpack.config.json` the installer cannot parse is never read as consent: that run places the
core set only, and its summary says so.

### Core (installed by default — 22 agents)

| Section | Agents |
|---|---|
| Review lenses (6 of 6) | all six — see the table below |
| Engineering and infra (11 of 11) | all eleven — see the table below |
| Business and research (3 of 13) | `product-manager`, `feedback-synthesizer`, `researcher` |
| Onboarding mappers (2 of 2) | both — see the table below |

### Opt-in (`extras: ["agents"]` in `respawnpack.config.json` — 10 agents)

| Agent | From |
|---|---|
| [`content-marketer.md`](content-marketer.md) | Business and research |
| [`sales-outbound.md`](sales-outbound.md) | Business and research |
| [`seo-specialist.md`](seo-specialist.md) | Business and research |
| [`social-media-strategist.md`](social-media-strategist.md) | Business and research |
| [`email-lifecycle-marketer.md`](email-lifecycle-marketer.md) | Business and research |
| [`finance-tracker.md`](finance-tracker.md) | Business and research |
| [`proposal-writer.md`](proposal-writer.md) | Business and research |
| [`customer-support.md`](customer-support.md) | Business and research |
| [`trend-researcher.md`](trend-researcher.md) | Business and research |
| [`growth-strategist.md`](growth-strategist.md) | Business and research |

## Review lenses

Six lenses, all fan-out targets for [`/review`](../skills/review/SKILL.md) (its Step 2 delegates to each by name) and all directly invokable on their own. Ask for "a security review of this diff" and Claude Code can route straight to `security-reviewer` without going through the whole `/review` flow.

| Agent | Job |
|---|---|
| [`correctness-reviewer.md`](correctness-reviewer.md) | Checks a diff for logic errors, edge cases, error propagation, and intent-vs-implementation mismatches |
| [`security-reviewer.md`](security-reviewer.md) | Checks a diff for authz/IDOR gaps, injection, authn/session issues, SSRF/deserialization, and secrets/PII exposure |
| [`performance-reviewer.md`](performance-reviewer.md) | Checks a diff for scale failures, including N+1s, unbounded reads, missing indexes, and request-path heavy work |
| [`maintainability-reviewer.md`](maintainability-reviewer.md) | Checks a diff for complexity, coupling, naming, dead code, and comment quality |
| [`spine-consistency-reviewer.md`](spine-consistency-reviewer.md) | Checks a diff against `docs/PRODUCT.md`/`docs/FEATURES-PAGES.md`, watches for a resurrected `docs/DECISIONS.md`-killed feature, and catches routes missing a matrix row |
| [`design-reviewer.md`](design-reviewer.md) | Checks a UI-touching diff for interaction-craft, visual-system, psychology-of-use, and accessibility-baseline violations against `docs/reference/design-standards.md`; reports not-applicable when the diff has no UI surface |

## Engineering and infra

Eleven advisors covering system design, service-level design, and delivery mechanics. The main agent delegates to one of these by description match when a request fits its lane, or you name it explicitly when the lens itself is the point: "ask the system-architect whether this needs a queue."

| Agent | Job |
|---|---|
| [`system-architect.md`](system-architect.md) | The flagship: system/infrastructure architecture, covering service topology, datastore choice, provider selection, and migration paths |
| [`backend-architect.md`](backend-architect.md) | Service-level design within an already-chosen system: API surface, data model, authz pattern, background work |
| [`frontend-developer.md`](frontend-developer.md) | Frontend implementation for React/Next-class UIs: component structure, state placement, data fetching, accessibility |
| [`database-optimizer.md`](database-optimizer.md) | Diagnoses slow queries, designs indexes, reviews migrations for safety (Postgres/Supabase-first) |
| [`devops-automator.md`](devops-automator.md) | CI/CD pipeline design, environment/secret hygiene, release and rollback strategy |
| [`ai-engineer.md`](ai-engineer.md) | Designs and hardens LLM-powered features: model selection, prompt versioning, evals, cost, failure handling |
| [`data-engineer.md`](data-engineer.md) | Analytics and data foundation sized to a solo founder: event schemas, Postgres-first pipelines, metric definitions |
| [`sre-incident-responder.md`](sre-incident-responder.md) | Reliability posture for a one-person on-call: SLIs, alert hygiene, incident-command steps |
| [`rapid-prototyper.md`](rapid-prototyper.md) | Sizes the cheapest experiment that answers "should we build this," plus the throwaway-vs-keeper call after |
| [`mobile-app-builder.md`](mobile-app-builder.md) | iOS and Android build design: framework choice, shared contract with web, store-review readiness, release engineering |
| [`technical-writer.md`](technical-writer.md) | Developer-facing and product-technical documentation: READMEs, API references, setup guides, changelogs |

## Business and research

Thirteen advisors covering product judgment, research, growth, and the founder-facing business functions. Same delegation model as engineering: description match, or name it directly.

| Agent | Job |
|---|---|
| [`product-manager.md`](product-manager.md) | Problem framing, prioritization, and spec quality for a solo founder without a product team |
| [`feedback-synthesizer.md`](feedback-synthesizer.md) | Turns raw multi-channel user feedback into a ranked, evidenced insight brief |
| [`researcher.md`](researcher.md) | General-purpose multi-source research on any topic gating a real decision |
| [`trend-researcher.md`](trend-researcher.md) | Market and competitor intelligence: teardowns, trend validation, pricing-landscape maps |
| [`growth-strategist.md`](growth-strategist.md) | Acquisition and growth strategy: channel selection, the acquisition-activation-retention loop, experiment design |
| [`seo-specialist.md`](seo-specialist.md) | Organic-search strategy: technical SEO foundation, keyword targets, page-level content prescriptions |
| [`content-marketer.md`](content-marketer.md) | Content strategy or a ready-to-execute brief, built from evidence of customer pain and founder expertise |
| [`social-media-strategist.md`](social-media-strategist.md) | Social presence strategy: platform selection, native-format content plans, engagement system |
| [`email-lifecycle-marketer.md`](email-lifecycle-marketer.md) | Email as an owned retention channel: consent posture, deliverability, lifecycle sequences |
| [`sales-outbound.md`](sales-outbound.md) | Founder-led B2B outbound: ICP definition, prospecting quality, sequence design, qualification |
| [`proposal-writer.md`](proposal-writer.md) | Proposals, quotes, and SOW scope sections for founder-led B2B sales |
| [`customer-support.md`](customer-support.md) | Support triage design, drafted replies, and routing what support learns back into the product |
| [`finance-tracker.md`](finance-tracker.md) | Founder-facing finance operations: runway truth, unit economics, invoicing hygiene, cost discipline |

## Onboarding mappers (write-scoped — the one exception)

Dispatched only by [`/onboard`](../skills/onboard/SKILL.md) for brownfield adoption. Both carry `tools: Read, Grep, Glob, Write` — Write so each can land its evidence-annotated map in `.respawnpack/onboarding/` and return a one-line confirmation instead of flooding the orchestrator's context. The boundary is hard: writes land only under that gitignored scratch dir, `/onboard` aborts on any tracked-file change after mapping, and everything they read in the target repo is treated as data, never instructions.

| Agent | Job |
|---|---|
| [`codebase-mapper.md`](codebase-mapper.md) | One parameterized mapper, four scopes (product surface · routes · architecture · decision-fossils): reads the codebase, writes one evidence-cited map per scope, marks every claim EVIDENCED or INFERRED |
| [`docs-ingestor.md`](docs-ingestor.md) | Reads pre-existing READMEs/ADRs/docs and maps their claims for code-verification (the likeliest injection vector, hardened accordingly) |

## Extended reach (MCP tools)

Almost every agent here works from the repo alone, with a strict read-only allowlist (`tools: Read, Grep, Glob`) and no outside connection. Three roles are different: `researcher`, `trend-researcher`, and `system-architect` need a live external check to do their job at all, so instead of a fixed allowlist they omit `tools:` entirely and carry a deny-list (`disallowedTools`) instead. Omitting `tools:` means the agent inherits every tool available in the session, including every MCP tool the user connects, now and in the future, with no file edit needed when a new server comes online. The deny-list then removes what those three roles should never touch: the write-capable builtins (`Write`, `Edit`, `NotebookEdit`, `Bash`), sub-spawning (`Agent`), and the three infra servers (`mcp__supabase`, `mcp__fly`, `mcp__cloudflare-api`) wholesale, since those carry destructive tools (a migration runner, a machine-destroy call) with no place in a research role's hands. The practical effect: these three can reach through a user's connected browser automation, fetch, crawler, and docs-search tools to answer a question, with every write-capable *builtin* removed.

⚠️ **What that does not buy you.** A deny-list on an inherited grant bounds what it names, and nothing else. These three do **not** have a general "cannot create, modify, or delete anything" guarantee — the same sentence that explains the design says why: the agent inherits *every* MCP tool the session has, now and in the future. Connect a notes writer, an issue tracker, a filesystem server, or a deploy server outside the three named infra servers, and that server's write tools are inherited un-denied. If you run write-capable MCP servers you want these roles kept away from, add them to `disallowedTools` in `researcher.md`, `trend-researcher.md` and `system-architect.md`, or give those three an explicit `tools:` allowlist instead — an allowlist is the only form here that is closed by construction. An unconnected server named in the deny-list, or any unconnected server generally, degrades gracefully; the agent simply lacks those tools, nothing errors.

Every other role keeps the strict read-only allowlist (`Read, Grep, Glob`), unchanged. The recommended research MCP pack, and its install commands, live on the catalog page, not here.

Users can grant their own MCP servers to any role by adding `mcp__<server-name>` to that role's frontmatter (an allowlisted role gains it as a new grant; a deny-listed role loses it if added there instead). For a server only one agent should ever see, attach it via the `mcpServers` frontmatter field instead of a shared connection; this is an advanced path and it connects only for that one agent.

## Adding your own

Copy the pattern from any file here: frontmatter with `name` (matching the filename stem), a `description` that states when the main agent should delegate to it and what it returns, and `tools: Read, Grep, Glob` for a normal role. Only give a role the `researcher`/`trend-researcher`/`system-architect` treatment (omit `tools:`, add `disallowedTools`) if it is genuinely impossible without a live external check across an open-ended set of tools; see the Extended reach section above for the exact pattern and what belongs on the deny-list. Then the same five body sections every agent here uses: the role framing (who this is, what it returns, that it has no edit tools), a scope boundary against the nearest neighboring role where one exists, operating rules (read the spine first, verify before asserting, return the deliverable in the response, state assumptions and ask rather than guess), and for reviewers, the lens mandate, failure classes, evidence bar, skeptic rule, and severity-ranked output format instead. Keep new roles read-only in effect; that is the property that makes them safe to fan out wide without a review turning into an accidental edit. (The onboarding mappers are the one deliberate, owner-approved exception — scoped, gated, and not a template to copy.)

## Source of truth

These files **are** the source of truth for what each role does. Other docs (this README, `skills/README.md`, `docs/vision/ARCHITECTURE.md`) carry a one-line summary for someone reading top to bottom; the full mandate lives here. If a summary elsewhere drifts from a file's actual frontmatter `description`, this directory wins. Update the summary to match, not the other way around.

## Attribution and status

The 32 role agents are RespawnPack-original text, written to a shared template (the onboarding-mapper pipeline shape is adapted from `open-gsd/gsd-core`, credited). Credits and the role-concept inspirations behind several of these names are in [ATTRIBUTION.md](../ATTRIBUTION.md). The living-skill doctrine ([spine/reference/living-skills.md](../spine/reference/living-skills.md)) applies to this directory the same as everywhere else in the pack; frozen baselines for these agents arrive in a later pass. ⚠️ **No code path admits `agents/` today**: `kernel/lib/living.js` resolves only `.claude/skills/<name>/` or `skills/<name>/`, gated on the three-canary list, so nothing in this directory has an executable drift check.
