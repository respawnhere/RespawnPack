---
name: loadout
description: The planning role (/loadout) — brainstorm → plan → spec for a feature or change, grounded in the docs spine. Surfaces the real problem, drafts a right-sized plan, optionally stress-tests it with a multi-lens review, and proposes the canonical edits the work implies. Presents decisions; never auto-commits direction.
when_to_use: "loadout", "/loadout", "gear up", "prep the run", "plan", "/plan", "let's plan", "how should we build", "break this down", "brainstorm", "what should we build", "spec this"
---

# /loadout — brainstorm → plan → spec

Turn a request into a plan (and, for build-ready work, a spec) plus a set of **proposed** canonical edits. Reads the spine first, so it never plans something that already exists or was deliberately killed.

## Step 0 — Read the spine
Read `docs/PRODUCT.md` (what exists + status), `docs/FEATURES-PAGES.md` (routes/flows/nav), `docs/DECISIONS.md` (decided + ⛔ killed). **If the request matches a ⛔ killed entry, stop and surface it** (don't re-plan a removed thing without an explicit reversal).

## Step 1 — Brainstorm (frame the real problem)
Restate the goal in one line. Ask the few forcing questions that matter (who's it for, the narrowest wedge, the status quo it beats). Explore 2–3 approaches; name the tradeoffs. State the load-bearing assumptions the plan rests on, and substantiate each against the codebase — cite the file that proves or refutes it, don't just assert it; if one is uncertain or can't be proven from the code, ask before building on it. Use `AskUserQuestion` for genuine forks — recommend an option, don't just list them.

**Offer a visual when seeing beats reading.** For a layout, a flow, or a side-by-side comparison — where a quick sketch settles the question faster than a paragraph — offer a just-in-time mockup or diagram. Decide it per question, never by default; most forks are settled in words.

**When scoping is genuinely unclear, interview one question at a time.** Don't batch a question list — ask one, with your own best guess attached (a wrong guess draws a faster correction than an open question does), and state a confidence read alongside it. Stop when a new answer stops changing the plan — a checkable test, not a fixed question count.

## Step 2 — Plan
Break the work into ordered steps. Identify the files/surfaces touched, the risks, and the verification. Right-size it — a small change gets a few bullets, not a doc. For anything multi-step, create a task list (Task tools) with dependencies.

**Wide, mechanical refactors expand before they contract.** A rename or signature change that sweeps the whole codebase never lands big-bang: add the new form alongside the old (expand), migrate call sites in reviewable batches, then remove the old form (contract) once nothing references it. Each phase is its own step and its own commit.

**Too big for one session? Split decided from fog-of-war.** When the work won't fit one sitting, break it into tickets and chart only the stretch you can actually see — the decided part. Mark the rest explicitly unexplored rather than inventing detail you'll rewrite; a plan that says where the map ends beats one that fakes the whole territory.

**Name the source of truth before any clone, copy, migration or regeneration.** When the plan will clone,
copy, migrate, or generate a file from another one, state which file is the source of truth. Check
`docs/derived/state/lineage.json` for it (`node .claude/respawnpack/respawnpack.js lineage seed` proposes
the sources a repository already has, from evidence files, if none are declared yet); if the source isn't
declared there, propose the row for the human to confirm — **WRITE-ONCE, never auto-written**, the same
rule as the canonical docs edits below.

**Orient in unfamiliar territory (optional).** If the work touches an area of the codebase you don't already know cold, and Graphify is available (`/mcp-graphify`), use `explain`/`get_community`/`affected` to map the area and its blast radius before writing the spec — grounds the plan in real structure instead of assumption. Skip it when the territory's already familiar or Graphify isn't set up; the plan proceeds the same either way.

**Scale-model growth-relevant work.** If it touches the request path, a list that grows, or a table users write to: name the expected read/write patterns, the hot paths (the two or three queries/routes that will carry the traffic), and how the data grows — then fold the consequences into the plan (indexes, pagination, caching, queue vs request-path) per `docs/reference/performance-standards.md`. Performance is cheapest designed in here too; retrofitting pagination onto a shipped unbounded feed is a migration, not a diff.

**Design-model user-facing work.** If it touches a UI surface a user sees or operates: name which `docs/reference/design-standards.md` sections apply (§1 interaction craft, §2 visual system, §3 psychology of use, §4 accessibility baseline), the surface's stakes per Rule 0 (a one-off internal screen versus a high-frequency or destructive-action flow), and the accessibility floor it must clear — then fold the consequences into the plan (states, affordances, and a11y requirements as spec line items, not an afterthought). Design is cheapest planned in here too; retrofitting keyboard support or a confirm-before-delete step onto a shipped flow is a rework, not a diff.

**Threat-model security-relevant work.** If it touches auth, user input, payments, file handling, or anything internet-facing: name the attack surface, the trust boundaries it crosses, the abuse cases (how would someone misuse this?), and the authz model — and fold the mitigations into the plan/spec. Security is cheapest designed in here, not bolted on at `/secure`. **If the feature calls an LLM or agent**, name the AI abuse cases too — prompt injection (direct, and indirect via retrieved documents or tool output), unsafe handling of model output (rendered, executed, or run as a query), and excessive agency (tool grants beyond need) — not just the compliance angle. And if the feature handles personal, health, financial, or children's data, classify the data + name the applicable regimes (GDPR / CCPA / HIPAA / …) and the lawful basis now — compliance is cheapest designed in too. Propose the `compliance.config.md` and `docs/compliance/RoPA.md` deltas the new data flow implies. Flag anything warranting a deeper `/secure` or `/comply` pass.

## Step 3 — Stress-test (optional, for big/risky plans)
Fan out a small **parallel** panel of review lenses via the Agent tool, e.g. product (is this the right thing?), feasibility (will it survive contact with the code?), risk (what breaks?). Each subagent is chosen by what that lens needs to answer, not by a name to remember. Synthesize their findings into the plan. Keep it to a handful of agents; run synthesis after. If the Workflow tool isn't available in this environment, run the same lenses as sequential Agent calls and verify findings before reporting.

## Step 4 — Spec (for build-ready work)
Write a concrete spec the `build` role can pick up: scope, the canonical rows it will add/change, acceptance criteria, out-of-scope notes.

**Spike an unproven unknown before you freeze the spec.** If the spec rests on a technical or visual question you can't answer on paper — will this API do what we need, does this interaction feel right — build the smallest throwaway prototype that answers it, then write the spec from what you learned. The spike's code is disposable; it never ships.

**For a spec spanning multiple files or components, add an Interfaces block** — for each piece, the exact signatures it *Consumes* and *Produces* (function, type, and endpoint shapes, not prose). This is what lets the pieces be built against each other instead of guessed at.

**An AI-touching feature's spec names its AI contract:** the model choice, the prompting approach, the eval rubric it's graded against, a cost budget, and the guardrails (injection handling, output validation, bounded agency). Consult the `ai-engineer` agent while planning it — an unspecified AI surface ships as an unbounded one.

**Self-review the spec before handing off.** Scan it once for placeholders and TBDs left unfilled, internal contradictions (two sections that can't both hold), and ambiguity a builder could read two ways — fix them inline now, while the spec is cheap to change. A spec that hands off clean is the difference between one `/build` pass and three.

## Step 5 — Propose the canonical edits (WRITE-ONCE)
A new feature implies exactly one authored home for each fact: a `PRODUCT.md` row (+ status), a `FEATURES-PAGES.md` row (feature ↔ route), and a `DECISIONS.md` entry (the choice + rationale). **Propose** these for the human to approve — do not write them silently.

**Not every choice earns a `DECISIONS.md` entry — apply the ADR-worthiness test:** is it hard to reverse, does it cut across modules, and would a newcomer ask "why is it done this way?" A yes to any of the three makes it worth recording; a local, easily-reverted choice stays in the code and its comment, off the ledger.

## Invariants
- Read the spine before planning; never plan a ⛔ killed feature.
- Present decisions, recommend, and ask — user decides (two models agreeing is signal, not a mandate).
- New product truth → one canonical place, proposed not auto-written.
- Threat-model security-relevant, scale-model growth-relevant, and design-model user-facing work at plan time (build security, performance, and design in — don't bolt them on); AI-touching work also names its AI abuse cases and, in the spec, its AI contract (model, prompts, evals, cost, guardrails).
- Graphify orientation (if available) is optional — never required to plan unfamiliar territory.
- When scoping is unclear, interview one question at a time with a guess + confidence attached; stop on the checkable test (a new answer stops changing the plan), not a fixed count.
- Multi-file specs carry an Interfaces (Consumes/Produces) block and pass a placeholder/contradiction/ambiguity self-review before handoff.
- Wide, mechanical refactors go expand → migrate-in-batches → contract, never big-bang.
- Hands off to `build`.
