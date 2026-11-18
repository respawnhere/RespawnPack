# RespawnPack: further reading

RespawnPack ships its own 32-role agent library in [`agents/`](../agents/); that library is what the pack actually runs. This page is the credited index of third-party skills, packs, and marketplaces worth knowing about: everything below is referenced, never copied, and traced to a permissively licensed upstream. The full credit ledger, with install commands and license verification detail, lives in [`ATTRIBUTION.md`](../ATTRIBUTION.md).

Nothing here is vendored into your repo by the installer. If you want one of these skills, follow its source link and add it yourself, or use the marketplace commands in the last section. During adoption, `/respawn` asks which of the marketplace packs you want and records your choices, so you do not have to read this whole page up front.

The bulk of the entries below, everything credited to agency-agents, are one collection: [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) (MIT), also mirrored at [GammaLabTechnologies/harmonist](https://github.com/GammaLabTechnologies/harmonist). About 33 of those personas are ancestrally derived from the unlicensed [contains-studio/agents](https://github.com/contains-studio/agents), credited here as their origin even though agency-agents/harmonist are the actual MIT-licensed hosts. NA/EU scope only: skills specific to the China/Korea market are deliberately excluded.

## Academic and worldbuilding

- `academic-anthropologist` (agency-agents, MIT): builds culturally coherent societies grounded in ritual, kinship, and belief systems.
- `academic-geographer` (agency-agents, MIT): builds geographically coherent worlds from climate, terrain, and spatial analysis.
- `academic-historian` (agency-agents, MIT): validates historical coherence and enriches settings via periodization and material culture.
- `academic-narratologist` (agency-agents, MIT): grounds story-structure advice in established narrative frameworks from Propp to Campbell.
- `academic-psychologist` (agency-agents, MIT): builds psychologically credible characters from personality theory and motivation.

## Cloud and infrastructure

- `cloudflare` (Cloudflare, Apache-2.0): the comprehensive Workers, Pages, storage, and AI platform skill.
- `cloudflare-email-service` (Cloudflare, Apache-2.0): send and receive transactional email via Cloudflare Email Routing.
- `durable-objects` (Cloudflare, Apache-2.0): build and review stateful coordination with Durable Objects.
- `sandbox-sdk` (Cloudflare, Apache-2.0): build sandboxed code execution for AI interpreters and CI/CD.
- `turnstile-spin` (Cloudflare, Apache-2.0): set up Cloudflare Turnstile end to end, including the siteverify Worker.
- `web-perf` (Cloudflare, Apache-2.0): measure Core Web Vitals and other performance metrics via Chrome DevTools MCP.
- `workers-best-practices` (Cloudflare, Apache-2.0): review and author Workers code against production best practices.
- `wrangler` (Cloudflare, Apache-2.0): the CLI skill for deploying and managing Workers, KV, R2, D1, and more.

Upstream note: as of 2026-07-06 the source repo ships 11 skills; two additions, `cloudflare-one` and `cloudflare-one-migrations`, are not yet catalogued above. See the marketplace entry below to pull the full current set.

## Data and analytics

- `data-consolidation-agent` (agency-agents, MIT): consolidates extracted sales data into live reporting dashboards.
- `report-distribution-agent` (agency-agents, MIT): automates distribution of consolidated sales reports by territory.

## Design and UI

- `ckm:banner-design` (nextlevelbuilder, MIT): designs banners for social, ads, and hero art with AI-generated visuals.
- `ckm:brand` (nextlevelbuilder, MIT): brand voice, visual identity, and messaging framework consistency.
- `ckm:design` (nextlevelbuilder, MIT): the comprehensive design skill covering identity, tokens, UI styling, and logo generation.
- `ckm:design-system` (nextlevelbuilder, MIT): three-layer token architecture, component specs, and slide generation.
- `ckm:slides` (nextlevelbuilder, MIT): strategic HTML presentations with Chart.js, tokens, and copywriting formulas.
- `ckm:ui-styling` (nextlevelbuilder, MIT): accessible UI with shadcn/ui, Radix, and Tailwind utility-first styling.
- `design-brand-guardian` (agency-agents, MIT): brand strategist for identity development and consistency maintenance.
- `design-image-prompt-engineer` (agency-agents, MIT): crafts detailed prompts for AI image generation.
- `design-inclusive-visuals-specialist` (agency-agents, MIT): generates culturally accurate, non-stereotypical images and video.
- `design-ui-designer` (agency-agents, MIT): visual design systems, component libraries, and pixel-perfect interfaces.
- `design-ux-architect` (agency-agents, MIT): technical architecture and CSS foundations for UX implementation.
- `design-ux-researcher` (agency-agents, MIT): user behavior analysis, usability testing, and data-driven design insight.
- `design-visual-storyteller` (agency-agents, MIT): visual narratives, multimedia content, and brand storytelling.
- `design-whimsy-injector` (agency-agents, MIT): adds personality and playful, memorable moments to brand experiences.
- `frontend-aesthetics` (anthropics/claude-cookbooks, MIT): a cookbook notebook on prompting for frontend aesthetics; the clean root of the community "frontend designer" skill lineage.
- `technical-artist` (agency-agents, MIT): art-to-engine pipeline covering shaders, VFX, LOD, and cross-engine asset optimization.
- `ui-ux-pro-max` (nextlevelbuilder, MIT): 50+ styles, 161 color palettes, 57 font pairings, and 161 product types across 10 stacks.
- `web-interface-guidelines` (Vercel Labs, MIT): terse, testable interaction and UI rules spanning accessibility, forms, motion, and performance; the credited source behind the pack's design standard.

## Engineering and architecture

- `agents-orchestrator` (agency-agents, MIT): autonomous pipeline manager for the entire development workflow.
- `agents-sdk` (Cloudflare, Apache-2.0): build AI agents on Workers with durable workflows and real-time WebSockets.
- `engineering-ai-data-remediation-engineer` (agency-agents, MIT): self-healing data pipelines via local SLMs and semantic clustering.
- `engineering-ai-engineer` (agency-agents, MIT): ML model development, deployment, and production integration.
- `engineering-autonomous-optimization-architect` (agency-agents, MIT): shadow-tests API performance under financial and security guardrails.
- `engineering-backend-architect` (agency-agents, MIT): scalable system design, database architecture, and API development.
- `engineering-cms-developer` (agency-agents, MIT): Drupal and WordPress theming, plugins, and content architecture.
- `engineering-code-reviewer` (agency-agents, MIT): constructive review focused on correctness, maintainability, and security.
- `engineering-data-engineer` (agency-agents, MIT): reliable data pipelines, lakehouse architecture, and ETL/ELT.
- `engineering-database-optimizer` (agency-agents, MIT): schema design, query optimization, and indexing across major databases.
- `engineering-devops-automator` (agency-agents, MIT): infrastructure automation, CI/CD pipelines, and cloud operations.
- `engineering-email-intelligence-engineer` (agency-agents, MIT): extracts structured, reasoning-ready data from raw email threads.
- `engineering-embedded-firmware-engineer` (agency-agents, MIT): bare-metal and RTOS firmware across ESP32, ARM Cortex-M, and Nordic.
- `engineering-filament-optimization-specialist` (agency-agents, MIT): restructures Filament PHP admin interfaces for usability.
- `engineering-frontend-developer` (agency-agents, MIT): modern React/Vue/Angular UI implementation and performance optimization.
- `engineering-git-workflow-master` (agency-agents, MIT): Git branching strategy, conventional commits, rebasing, and worktrees.
- `engineering-incident-response-commander` (agency-agents, MIT): production incident management and post-mortem facilitation.
- `engineering-mobile-app-builder` (agency-agents, MIT): native iOS/Android and cross-platform mobile development.
- `engineering-rapid-prototyper` (agency-agents, MIT): ultra-fast proof-of-concept and MVP creation.
- `engineering-security-engineer` (agency-agents, MIT): threat modeling, vulnerability assessment, and secure code review.
- `engineering-senior-developer` (agency-agents, MIT): Laravel/Livewire/FluxUI, advanced CSS, and Three.js integration.
- `engineering-software-architect` (agency-agents, MIT): system design, domain-driven design, and technical decision-making.
- `engineering-solidity-smart-contract-engineer` (agency-agents, MIT): EVM smart contract architecture, gas optimization, and DeFi protocols.
- `engineering-sre` (agency-agents, MIT): SLOs, error budgets, observability, and chaos engineering.
- `engineering-technical-writer` (agency-agents, MIT): developer documentation, API references, and README authorship.
- `engineering-threat-detection-engineer` (agency-agents, MIT): SIEM rule development, MITRE ATT&CK mapping, and threat hunting.
- `graphify` (Graphify-Labs/graphify, MIT; PyPI `graphifyy`): tree-sitter structural code graph: call graphs, blast-radius, symbol-to-symbol paths, hotspot review. Wrapped as a tool (see [`ops/mcp/graphify`](../ops/mcp/graphify/SKILL.base.md)); a structural complement to the memory layer, not a replacement for it.
- `lsp-index-engineer` (agency-agents, MIT): unified code intelligence through LSP client orchestration and semantic indexing.
- `specialized-civil-engineer` (agency-agents, MIT): civil and structural engineering across Eurocode, ACI, AISC, and other global standards.
- `specialized-cultural-intelligence-strategist` (agency-agents, MIT): detects invisible exclusion and ensures cross-cultural resonance.
- `specialized-developer-advocate` (agency-agents, MIT): developer community building, technical content, and developer experience.
- `specialized-document-generator` (agency-agents, MIT): generates professional PDF, PPTX, DOCX, and XLSX files programmatically.
- `specialized-french-consulting-market` (agency-agents, MIT): navigates the French ESN/SI freelance ecosystem and portage salarial.
- `specialized-mcp-builder` (agency-agents, MIT): designs, builds, and tests Model Context Protocol servers.
- `specialized-model-qa` (agency-agents, MIT): audits ML and statistical models end to end, including replication.
- `specialized-salesforce-architect` (agency-agents, MIT): multi-cloud Salesforce solution architecture and integration patterns.
- `specialized-workflow-architect` (agency-agents, MIT): maps complete workflow trees for systems, journeys, and agent interactions.
- `terminal-integration-specialist` (agency-agents, MIT): terminal emulation and text rendering for Swift applications.

## Marketing and growth

- `marketing-ai-citation-strategist` (agency-agents, MIT): audits brand visibility across ChatGPT, Claude, Gemini, and Perplexity (AEO/GEO).
- `marketing-app-store-optimizer` (agency-agents, MIT): App Store Optimization, conversion rate optimization, and discoverability.
- `marketing-book-co-author` (agency-agents, MIT): turns founder voice notes and positioning into a structured thought-leadership book.
- `marketing-carousel-growth-engine` (agency-agents, MIT): generates viral TikTok/Instagram carousels from a site URL via Playwright.
- `marketing-content-creator` (agency-agents, MIT): editorial calendars and copy for multi-platform campaigns.
- `marketing-cross-border-ecommerce` (agency-agents, MIT): full-funnel strategy across Amazon, Shopee, Lazada, and TikTok Shop.
- `marketing-growth-hacker` (agency-agents, MIT): rapid user acquisition through data-driven experimentation and viral loops.
- `marketing-instagram-curator` (agency-agents, MIT): visual storytelling, community building, and aesthetic optimization.
- `marketing-linkedin-content-creator` (agency-agents, MIT): thought leadership and personal brand building on LinkedIn.
- `marketing-reddit-community-builder` (agency-agents, MIT): authentic community engagement and value-driven content on Reddit.
- `marketing-seo-specialist` (agency-agents, MIT): technical SEO, content optimization, and organic search strategy.
- `marketing-short-video-editing-coach` (agency-agents, MIT): post-production coaching across CapCut, Premiere, and DaVinci Resolve.
- `marketing-social-media-strategist` (agency-agents, MIT): cross-platform campaigns and community management.
- `marketing-tiktok-strategist` (agency-agents, MIT): viral content, algorithm optimization, and community building on TikTok.
- `marketing-twitter-engager` (agency-agents, MIT): real-time engagement and thought-leadership building on X/Twitter.
- `marketing-video-optimization-specialist` (agency-agents, MIT): YouTube algorithm optimization, retention, and thumbnail strategy.
- `paid-media-auditor` (agency-agents, MIT): systematic audit of Google, Microsoft, and Meta ad accounts across 200+ checkpoints.
- `paid-media-creative-strategist` (agency-agents, MIT): ad copywriting, RSA optimization, and creative testing frameworks.
- `paid-media-paid-social-strategist` (agency-agents, MIT): cross-platform paid social across Meta, LinkedIn, TikTok, and Snapchat.
- `paid-media-ppc-strategist` (agency-agents, MIT): search, shopping, and performance-max campaign architecture at scale.
- `paid-media-programmatic-buyer` (agency-agents, MIT): display and programmatic buying across DV360 and trade desk platforms.
- `paid-media-search-query-analyst` (agency-agents, MIT): search-term analysis and negative-keyword architecture.
- `paid-media-tracking-specialist` (agency-agents, MIT): conversion tracking, tag management, and attribution modeling.

## Media generation

- `higgsfield-generate` (Higgsfield, MIT): core image, video, and audio generation workflows.
- `higgsfield-marketplace-cards` (Higgsfield, MIT): generates marketplace-ready product card creative.
- `higgsfield-product-photoshoot` (Higgsfield, MIT): produces product photoshoot imagery from reference assets.
- `higgsfield-soul-id` (Higgsfield, MIT): consistent character/identity generation across shoots.

Upstream note: as of 2026-07-06 a fifth skill, `higgsfield-websites`, was added upstream and is not yet catalogued above.

## Product and project management

- `product-behavioral-nudge-engine` (agency-agents, MIT): adapts interaction cadence and style to maximize user motivation.
- `product-feedback-synthesizer` (agency-agents, MIT): synthesizes multi-channel user feedback into actionable product insight.
- `product-manager` (agency-agents, MIT): owns the full product lifecycle from discovery through go-to-market.
- `product-sprint-prioritizer` (agency-agents, MIT): agile sprint planning, feature prioritization, and resource allocation.
- `product-trend-researcher` (agency-agents, MIT): emerging-trend identification and competitive analysis.
- `project-management-experiment-tracker` (agency-agents, MIT): experiment design, execution tracking, and A/B test management.
- `project-management-jira-workflow-steward` (agency-agents, MIT): enforces Jira-linked Git workflows and release-safe branching.
- `project-management-project-shepherd` (agency-agents, MIT): cross-functional coordination, timelines, and stakeholder alignment.
- `project-management-studio-operations` (agency-agents, MIT): day-to-day studio efficiency and process optimization.
- `project-management-studio-producer` (agency-agents, MIT): high-level creative/technical orchestration across a project portfolio.
- `project-manager-senior` (agency-agents, MIT): converts specs to tasks and remembers prior projects for realistic scoping.

## Sales

- `sales-account-strategist` (agency-agents, MIT): land-and-expand execution, stakeholder mapping, and QBR facilitation.
- `sales-coach` (agency-agents, MIT): rep development, pipeline review facilitation, and call coaching.
- `sales-data-extraction-agent` (agency-agents, MIT): monitors Excel files and extracts MTD/YTD sales metrics for reporting.
- `sales-deal-strategist` (agency-agents, MIT): MEDDPICC qualification and win planning for complex B2B cycles.
- `sales-discovery-coach` (agency-agents, MIT): elite discovery methodology, question design, and gap quantification.
- `sales-engineer` (agency-agents, MIT): technical discovery, demo engineering, and POC scoping.
- `sales-outbound-strategist` (agency-agents, MIT): signal-based multi-channel prospecting and ICP definition.
- `sales-pipeline-analyst` (agency-agents, MIT): pipeline health diagnostics, deal velocity, and forecast accuracy.
- `sales-proposal-strategist` (agency-agents, MIT): transforms RFPs into win narratives and win-theme development.

## Security and compliance

- `agentic-identity-trust` (agency-agents, MIT): identity, authentication, and trust verification for autonomous agents.
- `blockchain-security-auditor` (agency-agents, MIT): smart contract vulnerability detection and formal verification.
- `compliance-auditor` (agency-agents, MIT): SOC 2, ISO 27001, HIPAA, and PCI-DSS audits from readiness through evidence.
- `identity-graph-operator` (agency-agents, MIT): shared identity graph that multiple agents resolve against for a canonical answer.
- `zk-steward` (agency-agents, MIT): Zettelkasten-style knowledge-base steward, switching perspective to domain experts.

## Support and operations

- `accounts-payable-agent` (agency-agents, MIT): executes vendor payments and recurring bills across any payment rail.
- `automation-governance-architect` (agency-agents, MIT): governance-first audit of n8n-style automations for value and risk.
- `corporate-training-designer` (agency-agents, MIT): enterprise training system design and curriculum development.
- `study-abroad-advisor` (agency-agents, MIT): full-spectrum study abroad planning across the US, UK, EU, and Asia-Pacific.
- `supply-chain-strategist` (agency-agents, MIT): supplier development, strategic sourcing, and quality control.
- `support-analytics-reporter` (agency-agents, MIT): transforms raw data into dashboards, KPIs, and statistical analysis.
- `support-executive-summary-generator` (agency-agents, MIT): transforms business inputs into consultant-grade summaries.
- `support-finance-tracker` (agency-agents, MIT): financial planning, budget management, and performance analysis.
- `support-infrastructure-maintainer` (agency-agents, MIT): system reliability, performance optimization, and technical operations.
- `support-legal-compliance-checker` (agency-agents, MIT): checks business operations and content against relevant laws and regulations.
- `support-support-responder` (agency-agents, MIT): customer support delivery, issue resolution, and experience optimization.

## Testing and QA

- `testing-accessibility-auditor` (agency-agents, MIT): audits interfaces against WCAG and tests with assistive technologies.
- `testing-api-tester` (agency-agents, MIT): comprehensive API validation and performance testing.
- `testing-evidence-collector` (agency-agents, MIT): screenshot-driven QA that requires visual proof for every finding.
- `testing-performance-benchmarker` (agency-agents, MIT): measures and improves system performance across applications.
- `testing-reality-checker` (agency-agents, MIT): evidence-based production-readiness certification, defaulting to "needs work".
- `testing-test-results-analyzer` (agency-agents, MIT): comprehensive test result evaluation and quality metrics.
- `testing-tool-evaluator` (agency-agents, MIT): evaluates and recommends tools, software, and platforms for business use.
- `testing-workflow-optimizer` (agency-agents, MIT): analyzes and automates workflows across business functions.

## Workflows and meta

- `workflow-book-chapter` (agency-agents, MIT): structured workflow for drafting a book chapter end to end.
- `workflow-landing-page` (agency-agents, MIT): structured workflow for building a marketing landing page.
- `workflow-startup-mvp` (agency-agents, MIT): structured workflow for scoping and building a startup MVP.
- `workflow-with-memory` (agency-agents, MIT): structured workflow that persists context across a multi-step task.

## XR, spatial, and game

- `game-audio-engineer` (agency-agents, MIT): FMOD/Wwise integration, adaptive music, and spatial audio budgeting.
- `game-designer` (agency-agents, MIT): GDD authorship, player psychology, and economy balancing.
- `level-designer` (agency-agents, MIT): layout theory, pacing architecture, and encounter design.
- `macos-spatial-metal-engineer` (agency-agents, MIT): native Swift and Metal 3D rendering for macOS and Vision Pro.
- `narrative-designer` (agency-agents, MIT): GDD-aligned narrative design, branching dialogue, and lore architecture.
- `nexus-spatial-discovery` (agency-agents, MIT): spatial discovery patterns for immersive environments.
- `nexus-strategy` (agency-agents, MIT): strategic planning patterns for spatial and immersive products.
- `visionos-spatial-engineer` (agency-agents, MIT): native visionOS spatial computing and Liquid Glass interfaces.
- `xr-cockpit-interaction-specialist` (agency-agents, MIT): immersive cockpit-based control systems for XR.
- `xr-immersive-developer` (agency-agents, MIT): browser-based WebXR AR/VR development.
- `xr-interface-architect` (agency-agents, MIT): spatial interaction design for immersive AR/VR/XR environments.

## Marketplaces and vendor packs

Add commands for the branded marketplaces and vendor skill packs worth knowing about. Full detail, license verification, and dates are in [`ATTRIBUTION.md`](../ATTRIBUTION.md).

- **Anthropic official**: `/plugin marketplace add anthropics/claude-plugins-official`. Apache-2.0.
- **Compound Engineering**: `/plugin marketplace add EveryInc/compound-engineering-plugin`. MIT.
- **Stitch**: `/plugin marketplace add google-labs-code/stitch-skills`. Apache-2.0.
- **Cloudflare skills**: `/plugin marketplace add cloudflare/skills` then `/plugin install cloudflare@cloudflare` (or `npx skills add https://github.com/cloudflare/skills`). Apache-2.0. Now ships 11 skills, including `cloudflare-one` and `cloudflare-one-migrations` in addition to the set catalogued above.
- **Supabase agent skills**: `git clone https://github.com/supabase/agent-skills`. MIT.
- **Vercel**: `vercel/vercel-plugin` (25 skills) and `vercel-labs/agent-skills`. Neither ships a published LICENSE file, so treat both as reference-only: credit and link, do not vendor or copy, until Vercel publishes a license.
- **Higgsfield skills**: `git clone https://github.com/higgsfield-ai/skills`. MIT. Now ships 5 skills, including the new `higgsfield-websites`.
- **nextlevelbuilder ui-ux-pro-max**: `git clone https://github.com/nextlevelbuilder/ui-ux-pro-max-skill`. MIT.
- **SwiftUI Pro** (Paul Hudson, MIT, opt-in for founders also shipping iOS): `/plugin marketplace add twostraws/SwiftUI-Agent-Skill` then `/plugin install swiftui-pro@swiftui-agent-skill`. Complementary to `ui-ux-pro-max` (the visual layer) at the code-correctness layer for SwiftUI.

### Research reach: browser and crawler MCP servers

The built-in `WebFetch` reads static HTML. It misses anything JS-rendered (a page that only populates after client-side script runs) and anything sitting behind a bot wall (a fingerprint check, a rate limit, a Cloudflare challenge). When a research task hits one of those, reach for an MCP server built for it rather than accepting a blank page. Verified via `gh api` on 2026-07-06; full license and citation detail is in [`ATTRIBUTION.md`](../ATTRIBUTION.md).

Two connection paths exist for any of these: direct `claude mcp add`, or the Docker MCP gateway. Routing rule and detail: [`ops/README.md`](../ops/README.md), "Which way does a server connect?"

**Default pack**, the first two rungs past `WebFetch`:

- **playwright-mcp** (Microsoft, Apache-2.0, 34.8k stars, first-party): drives a real browser via accessibility-tree automation, so it renders JS pages and can click, type, and wait through an interactive flow. Local, no API key.
  `claude mcp add playwright npx @playwright/mcp@latest`
  Note: the Docker MCP gateway ships the same image under its `browser_*` tools, so if you already run the gateway you may have this covered without adding it separately.
- **firecrawl** (firecrawl, MIT server code, 6.9k stars, first-party): scrape, crawl, map, search, and structured extract, for whole-site or multi-page research rather than one URL at a time. Respects `robots.txt` by default.
  Gateway path (preferred): `docker mcp secret set FIRECRAWL_API_KEY=fc-YOUR_API_KEY`, then enable it through `/mcp-runtime`.
  Direct fallback (no Docker/WSL2): `claude mcp add firecrawl --env FIRECRAWL_API_KEY=fc-YOUR_API_KEY -- npx -y firecrawl-mcp`. This writes the key into plaintext Claude config; run `/secrets-audit` afterward.
  A keyless, rate-limited hosted endpoint exists for a scrape/search-only trial, and a Docker Compose self-host path needs no key but drops the cloud-only anti-bot layer.

**Situational**, reach for these only when the default pack cannot get a clean answer:

- **Scrapling** (D4Vinci, BSD-3-Clause, 68.4k stars, native MCP): fully local, Python-based. Pre-filters page content by CSS selector before it reaches the model, which saves tokens, and ships built-in prompt-injection sanitization. Its `StealthyFetcher` handles anti-bot walls. Worth the extra Python runtime when those two properties matter more than staying in the Node toolchain.
  `pip install "scrapling[ai]" && scrapling install`
  `claude mcp add ScraplingServer -- scrapling mcp`
- **CloakBrowser** (CloakHQ, 27.8k stars): not an MCP server on its own. It swaps in under `playwright-mcp` as the Chromium executable, giving that same accessibility-tree automation an anti-detect stealth browser underneath it for fingerprint-hostile targets.
  **Read this before adopting it.** The wrapper code is MIT, but the Chromium binary itself is dual-tier and proprietary: the free tier is a deliberately-stale previous Chromium major, and the current binary requires a paid key. Redistribution and SaaS-embedding are prohibited by the binary license. This is legitimate for QA, uptime monitoring, and resilience-testing against fingerprint-hostile targets, including your own infrastructure. It must not be used to defeat auth walls, paywalls, or rate limits that are protecting personal data, and not for account or credential abuse. Those prohibited uses are barred by the vendor's own license, not just by this note. Do not describe this project as plain MIT anywhere it is mentioned; the binary is the part that matters and it is not.

The ethics floor holds at every rung: respect `robots.txt` and each site's terms of service, never circumvent an auth wall or a paywall, and route anything personal-data-shaped to `/comply` instead of scraping it directly.

Once any of these are connected, the `researcher`, `trend-researcher`, and `system-architect` agents pick them up automatically. They run on a deny-list rather than an allow-list, so a newly connected MCP tool is available to them without an agent-file edit.

### Site-testing reach: browser introspection for `/walkthrough` and `/playtest`

The site-testing loop drives the project's **own** app (localhost / preview / staging) — a different lane from research reach, with a stricter boundary: it never pilots third-party sites, and it never runs through the developer's personal logged-in browser. Interaction driving is already covered by the research-reach default above (`playwright-mcp` / the gateway's `browser_*` tools) plus the `anthropics/skills` webapp-testing skill. Verified via `gh api` on 2026-07-10.

**Situational addition:**

- **chrome-devtools-mcp** (Chrome DevTools team, Apache-2.0, 46.6k stars, first-party): the introspection the interaction drivers lack — console messages with source-mapped stacks, network-request inspection (a double-submit stops being a guess: two POSTs in the log), performance traces + Lighthouse audits, heap snapshots. Feeds `/walkthrough`'s state-honesty probe and `/playtest`'s perf tier.
  `claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --isolated --no-usage-statistics --no-performance-crux`
  `--isolated` gives it a throwaway profile; the two `--no-*` flags switch off Google usage-stats and CrUX egress. Keep `install_extension` and `execute_3p_developer_tool` out of skill allowlists — third-party LLM scans flagged (unaudited) risks on exactly those surfaces.

**Evaluated and not adopted** (2026-07-10 — recorded so the vetting isn't re-run every session):

- **browser-use** (MIT, 104k stars, healthy org) — **deferred**. Capable, and its multi-agent exploratory QA crawl (vibetest) is genuinely novel, but telemetry is on by default and ships the task text, visited URLs, and action history to PostHog (`ANONYMIZED_TELEMETRY=false` to disable), and its autonomous agent loop needs its own LLM key — a second model reading untrusted page content is a second prompt-injection surface. Re-evaluate if the telemetry default flips; the contract-driven `/walkthrough` covers the testing need deterministically meanwhile.
- **Browser MCP** (BrowserMCP/mcp) and **OpenChrome** (shaun0927/openchrome) — **declined**. Both are built to drive the user's real, logged-in Chrome — the wrong trust shape for testing your own app, since the blast radius is every authenticated session in that profile (OpenChrome's own SECURITY.md tells you to keep exactly that separation, and it ships an anti-bot/CAPTCHA-bypass layer the pack will not wire regardless). Browser MCP is additionally a solo-maintainer fork, inactive ~14 months, with a publicly-filed, closed-without-a-fix LAN exposure: its extension bridge binds `0.0.0.0:9009`, so on shared Wi-Fi another device can drive the browser. For flows behind login, the safe pattern is a dedicated test account + profile under the tools above — never a personal browser session.

## Prior-art: skill/template ecosystems

A second prior-art sweep studied six further Claude-Code skill/template ecosystems for **concepts**, not skills to install — reference-first, rewritten and never copied, credited in [`ATTRIBUTION.md`](../ATTRIBUTION.md) and tracked in the project's watchlist:

- [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) (Addy Osmani, MIT): source of the three shipped `/build` + `/loadout` grafts and part of the skill-authoring standard.
- [`mattpocock/skills`](https://github.com/mattpocock/skills) (Matt Pocock, MIT): source of part of the skill-authoring standard and the model/user-invoked cost-split concept.
- [`obra/superpowers`](https://github.com/obra/superpowers) (Jesse Vincent, MIT): source of part of the skill-authoring standard and studied orchestration-resilience concepts.
- [`open-gsd/gsd-core`](https://github.com/open-gsd/gsd-core) (Open GSD, MIT): studied eval-harness, routing-budget, and orchestration-resilience concepts.
- [`ColeMurray/background-agents`](https://github.com/ColeMurray/background-agents) ("Open-Inspect," MIT): studied orchestration-resilience concepts (spawn guardrails, watchdog taxonomy, circuit breakers).
- [`davila7/claude-code-templates`](https://github.com/davila7/claude-code-templates) (Daniel "San" Ávila, MIT root, aggregator): studied security-content-scan concept; itself aggregates other upstreams already credited directly elsewhere in this pack.

None of the six above are vendored or installed by RespawnPack; see `ATTRIBUTION.md`'s "Prior-art round 2" section for what's actually adapted versus tracked as a future candidate.
