# RespawnPack: Skills / roles library

The org chart, as runnable skills. Fresh-authored and **harness-native**: they orchestrate with the built-in Agent + Workflow tools, not bash. Each role **reads from and writes back to the spine** (it never invents product truth).

## The roles

| Skill | Role | Chains into |
|---|---|---|
| [`respawn`](respawn/SKILL.md) | boot a session from the last savepoint (load handoff, orient) | `loadout` |
| [`loadout`](loadout/SKILL.md) | brainstorm → plan → spec | `build` |
| [`build`](build/SKILL.md) | implement to spec, in scope | `review`, `playtest` |
| [`review`](review/SKILL.md) | multi-lens change review (Agent fan-out + adversarial verify) | `playtest`, `ship` |
| [`playtest`](playtest/SKILL.md) | find → fix → regression-test loop | `ship` |
| [`walkthrough`](walkthrough/SKILL.md) | contract-driven site testing: walk pages from the user's seat (presence per state · flows · capability parity) | `build`, `playtest` |
| [`ship`](ship/SKILL.md) | pre-ship gate → authorized push → deploy-verify | `savepoint` |
| [`debug`](debug/SKILL.md) | query-memory-first → root-cause → fix → capture learning | (cross-cutting) |
| [`secure`](secure/SKILL.md) | security audit: code (OWASP) · deps/SBOM · infra advisories (fan-out + verify) | (cross-cutting) |
| [`comply`](comply/SKILL.md) | compliance audit: triage frameworks → per-requirement checklists (`library/compliance/`) → ranked gaps | (cross-cutting) |
| [`savepoint`](savepoint/SKILL.md) | end-of-session: regenerate derived docs + drift-check | (cross-cutting) |
| [`wordsmith`](wordsmith/SKILL.md) | human-first writing and editing: de-slop prose and scripts, preserve meaning and voice | (cross-cutting) |
| [`checkup`](checkup/SKILL.md) | periodic codebase-health scan against the module-depth standard (typed `/checkup` only — kept off the model-visible listing) | (cross-cutting) |
| [`onboard`](onboard/SKILL.md) | brownfield adoption: map an existing codebase → evidence-cited spine drafts → per-section human confirmation (typed `/onboard` only; `/respawn` recommends it on un-spined repos) | `loadout` |
| [`task`](task/SKILL.md) | fresh-session-per-task delegate role for the task-runner queue: one bounded `contract delegate`, boot unchanged, attest per criterion, report a confirmation line only | (terminal — reports back to the runner or operator) |
| [`aar`](aar/SKILL.md) | after-action report for a window of work: run the `aar` verb, read the written report back, propose the human NOTE at its foot (typed `/aar` only, kept off the model-visible listing) | (cross-cutting) |

A typical loop: **respawn → loadout → build → review → playtest → ship → savepoint**, with **walkthrough** verifying touched pages post-build / pre-ship, **debug** for anything broken, **secure** for security-sensitive changes, **comply** for anything handling regulated data, **wordsmith** for any user-facing writing, and **aar** at the end of a phase to write up the window the loop just closed.

**Aliases (prose-routed).** The clear-verb names are kept as `when_to_use` trigger phrases for discoverability: saying "plan" or "let's plan" routes to `/loadout`, "QA" to `/playtest`, "test the site"/"test the pages" to `/walkthrough`, "closeout" to `/savepoint`, "postmortem" to `/debug`, "audit"/"security" to `/secure`, "compliance"/"gdpr"/"hipaa" to `/comply`. Typed slash commands are the themed names only (a typed `/plan` is not registered; command names come from the skill directory name).

**Security loop.** `/secure` is the deep audit; it's reinforced by `/review`'s security lens (every change), a threat-model step in `/loadout` (plan time), a `/ship` gate that blocks sensitive pushes on HIGH-severity findings, the [`secret-scan`](../hooks/secret-scan.js) pre-push hook, and a [security CI template](../templates/ci/security.yml) (gitleaks + dep-audit, on push/PR + weekly). Secret hygiene proper lives in [`/secrets-audit`](../ops/secrets-audit/SKILL.md).

**Compliance loop.** `/comply` triages the applicable NA/EU frameworks and audits against the detailed per-requirement checklists in [`library/compliance/`](../library/compliance/) (each citing the regulation). A compliance-by-design step in `/loadout`, a lens in `/review`, and a gate in `/ship` mirror the security loop.

**Writing loop.** `/wordsmith` edits prose and scripts (docs, READMEs, changelogs, copy, narration) to be clear, specific, and human, against the [writing standards](../spine/reference/writing-standards.md). `/build` applies the same standard when it authors user-facing copy or docs. It is quality editing, not authorship detection: no single "tell" proves AI authorship.

**Performance loop.** The [performance standards](../spine/reference/performance-standards.md) codify the first-traffic-spike failures (N+1 queries, unbounded lists, missing indexes, per-request connections, request-path heavy work, missing timeouts). A scale-model step in `/loadout` (plan time), a performance lens in `/review` (every diff, with `EXPLAIN`/advisors via the DB MCP where wired), and a hot-path gate in `/ship` mirror the security loop. `/build` writes to the standard on hot paths and growth surfaces.

**Design loop.** The [design standards](../spine/reference/design-standards.md) codify interface quality as an index plus per-§ detail files: Rule 0 stakes calibration, §1 interaction craft, §2 visual system, §3 psychology of use, §4 the WCAG 2.2 A/AA baseline, §5 validation probes. A design-model step in `/loadout` (plan time), the `design-reviewer` lens in `/review` (UI-touching diffs), a `/ship` gate (the §5 passes + the WCAG baseline), and `/walkthrough`'s trip-over citations mirror the security loop. `/build` writes to the standard on UI-touching changes.

**Site-testing loop.** `/walkthrough` verifies the *rendered* product against per-page contracts (`docs/reference/page-tests/`) generated from the `FEATURES-PAGES` matrix plus a code-level capability inventory — the parity sweep that catches coded-but-unreachable features (a created session with no end/leave control; a message its author can't edit or delete). It tests from the user's seat and reports driven-vs-inferred honestly; `/playtest` remains the find→fix→regression-test loop it feeds.

**Testing loop.** The [testing standards](../spine/reference/testing-standards.md) codify when tests get written and what makes one worth keeping (test-first where the logic earns it, the regression contract, behavior-over-implementation, deterministic-or-deleted). `/build` writes to the standard on non-trivial new logic, `/review` checks coverage against it, `/playtest` proves bugs dead with fails-before/passes-after regression tests, and `/checkup` audits module shape so the seams stay testable.

**Behavioral baseline.** The [behavior standards](../spine/reference/behavior-standards.md) govern conduct: surface assumptions, build the minimum, change surgically, define done first, match ceremony to blast radius, and weigh feedback before acting on it. The installer injects a digest into the target's `CLAUDE.md` as a managed block, so the discipline holds even when no role is invoked; the roles operationalize it. Prior art (Karpathy's LLM-coding guidance) is credited in [ATTRIBUTION.md](../ATTRIBUTION.md).

**Authoring standard.** Skills are written and pruned to the [skill-authoring standards](../spine/reference/skill-authoring-standards.md): every line pays for a failure it prevents, in the cheapest tier that prevents it (reference file over body, body over listing) — the listing is a per-session tax on every target, budgeted against the harness's real caps (`docs/reference/skill-authoring-standards.md` once installed).

**Living skills (three opt-in canaries).** Per owner decision OD-1 the lifecycle covers `debug`, `savepoint` and `knowledge` only, and only after `respawnpack living enable <skill>` freezes the on-disk skill as its `SKILL.base.md` baseline — a default install activates none of it and every other skill is STATIC by design, a supported state rather than a gap. An enabled canary carries that frozen baseline plus an adaptive `SKILL.md` whose "Learned" overlay is regenerated from memory as the project teaches it new patterns. [`/skill-guard`](.) checks whether the live `SKILL.md` has drifted from its frozen baseline (`SKILL.base.md`), regenerates its Learned overlay from memory, and resets it to baseline when the overlay goes wrong.

**Reporting loop.** `/aar` composes an [After Action Report](aar/SKILL.md) for a window of work from records the kernel already keeps: the compiled state at each end of the window, the commits, the derived changelog entries dated inside it, and (labelled machine-local) the last savepoint receipt, the candidate journal and the delegation archive. It opens with its bottom line, withholds a count whose committed `STATE.json` did not describe its own revision, and shows every candidate memory as an unverified lead. `contract complete goal` writes one automatically on a successful close unless `--no-aar`, since a goal closing is the one phase end this pack can name without inference; the NOTE at the foot is the human's half and is proposed, never auto-written.

**Per-server MCP skills.** The `mcp-*` skills (one per managed service) live under [`ops/mcp/`](../ops/mcp/).

**Role agents.** A 32-role subagent bench lives under [`agents/`](../agents/README.md): the 6 review lenses `/review` fans out to, plus 24 engineering, infra, and business advisors and the 2 write-scoped onboarding mappers `/onboard` dispatches (the bench's one non-read-only exception, bounded and gated). The main agent delegates to one by description match when a request fits its lane, or a role can be named directly.

## Shared principles (every role honors these)
1. **Read the spine first.** Before acting, read the relevant canonical docs: `PRODUCT.md` (what exists + status), `FEATURES-PAGES.md` (where it lives), `DECISIONS.md` (what's decided/**killed**). Never propose or build a feature that `DECISIONS.md` marks ⛔ killed.
2. **WRITE-ONCE.** New product truth (a feature/decision/removal) is authored in exactly one canonical place. Propose the `PRODUCT`/`FEATURES-PAGES`/`DECISIONS` edit; don't restate it elsewhere. Canonical edits are **proposed for the human, never auto-written** (user sovereignty).
3. **Never hand-edit derived docs.** `CHANGELOG`/`GAPS`/`CONTINUITY` are regenerated by `/savepoint`.
4. **Harness-native orchestration.** Use the Agent tool for parallel/independent work and the Workflow tool for deterministic fan-out (find → verify → synthesize). Subagents are on by default for that work, with no founder ask needed: choose them by description, name one only when the lens itself is the point, and let the spawn guard cap the fan-out. **Moderate concurrency**: keep parallel subagents well under the rate-limit ceiling (in practice, ~13 at once gets throttled; stay single-digit and run synthesis sequentially). Before spawning a parallel wave, declare each agent's disjoint file ownership (overlapping writers is the classic stale-coordination failure). `spawn-guard` appends a dispatch line to `.respawnpack/wave-ledger.md` automatically; add each wave's **outcome** yourself, since nothing observes what an agent returned (`/respawn` rehydrates it; `/savepoint` folds and deletes it when untracked, and reports a tracked one NOT_APPLICABLE). **Brief every agent to write a stub file first and extend it section by section** — an agent that dies before its single write leaves nothing — and **sweep its scratch namespace only after the completion notification, verifying by byte size** (`node ops/sweep-scratch.mjs --into <dir>`): "file exists at destination" is not success. The full discipline — dispatch briefs, file-handoff, model tiers, review anti-patterns, stall taxonomy — is [`orchestration-patterns.md`](../spine/reference/orchestration-patterns.md).
5. **MCP-first ops.** For infra actions (DB, deploy, secrets), prefer the managed-service MCP tools over shell. Verify against prod truth.
6. **Verify before asserting.** Don't report a finding or a "done" you haven't checked. Reviews adversarially verify before reporting; ships verify post-deploy.
7. **Push is authorized, never automatic.** No `git push` without an explicit human go-ahead in the current session.
8. **Write to the standard.** Code shows *what*; comments and names carry *why*. Comment intent (decisions, gotchas, invariants, tied to a `DECISIONS.md` `D-id`), not mechanics. `/build` writes to it, `/review` checks it: [`coding-standards.md`](../spine/reference/coding-standards.md). On hot paths and growth surfaces the same pair applies [`performance-standards.md`](../spine/reference/performance-standards.md).

## Install
Skills land in the target repo's `.claude/skills/<name>/SKILL.md` (the Phase-6 installer copies them). They reference the spine at `docs/`.
