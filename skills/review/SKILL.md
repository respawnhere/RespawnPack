---
name: review
description: The review role — multi-lens review of a change via parallel Agent fan-out, with adversarial verification before reporting. Covers correctness, security, performance, maintainability, spine-consistency (does the change match the docs, resurrect a killed feature, or drift tokens?), and design (UI-touching diffs only).
when_to_use: "review", "review this", "review the diff", "review the PR", "code review", "check my changes", "/review"
---

# /review — multi-lens change review

Catches what passes CI but breaks prod (or breaks the spine). Harness-native: independent lenses run in parallel, findings are verified before they're reported.

## Step 1 — Scope the change
`git diff` for the change set (uncommitted, a branch range, or a PR). Note the risk surface — auth, payments, data mutations, external APIs, and migrations get extra scrutiny, and so do hot paths + growth surfaces (request-path code, lists that grow, high-traffic tables).

**Dependency changes get read, not waved through.** A diff that adds or bumps a dependency ideally moves one at a time; read the lockfile diff (new transitive packages, unexpected version jumps), don't rubber-stamp it — a lockfile is where a supply-chain surprise hides.

If Graphify is available (`/mcp-graphify`), run `affected <symbol>` on the changed symbols to bound the blast radius — feed that into the correctness and spine-consistency lenses in Step 2. Skip it when Graphify isn't set up; scoping proceeds from the diff alone.

## Step 2 — Fan out review lenses (parallel)
Spawn independent reviewers via the Agent tool (or a Workflow for larger diffs), delegating to the matching subagent for each lens (each installed at `.claude/agents/<name>-reviewer.md`). The lens is the point here, so all six are named, not left to a description match. The full lens definitions (what to hunt for, the evidence bar, the skeptic rule, output format) live in those files; they are the source of truth. This is the one-line essence of each, for orientation:
- **[`correctness-reviewer`](../../agents/correctness-reviewer.md)** — logic errors, edge cases, error propagation, intent-vs-implementation.
- **[`security-reviewer`](../../agents/security-reviewer.md)** — authz/access control (IDOR, ownership checks), injection (SQL/command/XSS), authn/session, SSRF/deserialization, and sensitive-data exposure, weighted by risk surface. Scan new/changed dependencies for CVEs (the `security-audit` MCP). For a deep pass on sensitive changes, hand to [`/secure`](../secure/SKILL.md); secret hygiene is [`/secrets-audit`](../secrets-audit/SKILL.md); changes touching regulated personal/health/financial data go to [`/comply`](../comply/SKILL.md).
- **[`performance-reviewer`](../../agents/performance-reviewer.md)** — the scale failures cheap to catch in a diff, against `docs/reference/performance-standards.md`: queries inside loops (N+1), unbounded/unpaginated reads, `SELECT *` on hot or wide tables, new filters/sorts without an index (flags the risk from the code and schema; a live `EXPLAIN` or Supabase advisor check is a `/db-ops` or human follow-up), per-request connections, heavy work on the request path, external calls without a timeout, and payload/bundle bloat. Weighted like security by the risk surface (hot paths + growth surfaces).
- **[`maintainability-reviewer`](../../agents/maintainability-reviewer.md)** — complexity, coupling, naming, dead code, leaked abstractions, and comment quality against `docs/reference/coding-standards.md`.
- **[`spine-consistency-reviewer`](../../agents/spine-consistency-reviewer.md)** — match against `docs/PRODUCT.md` + `docs/FEATURES-PAGES.md`, resurrected ⛔ killed features (`docs/DECISIONS.md` removals), hardcoded values contradicting the token/copy source, routes missing a matrix row.
- **[`design-reviewer`](../../agents/design-reviewer.md)** — interaction craft, visual system, psychology-of-use traps, and the accessibility baseline against `docs/reference/design-standards.md`, with the §5 validation passes run as review probes (keyboard-only, narrow-viewport, reduced-motion). Only fires when the diff touches UI code, templates, or styles; reports not-applicable otherwise.

Keep concurrency moderate (single-digit). For a big diff, use a Workflow: dimension → finding → verify, pipelined. If the Workflow tool isn't available in this environment, run the same lenses as sequential Agent calls and verify findings before reporting.

## Step 3 — Adversarially verify (before reporting)
For each finding, run a skeptic pass that tries to **refute** it (default to "not a real issue" unless the evidence holds). Drop or downgrade findings that don't survive. Force any finding you can't verify to low confidence. This is what keeps the review trustworthy.

**Optional cross-vendor second opinion.** For a high-stakes diff, the skeptic pass can be escalated to a different family's model for an independent read, routed through `adapters/providers/offload.js --class review --in <file>` (same mechanism as `/build`'s). Ask first; the offload is one read-only turn with no tools, picked by the capability register and what this machine can actually reach; skip and announce when the offload path isn't available or the session is non-interactive.

## Step 4 — Report (+ optionally fix)
Report surviving findings ranked by severity, each with file:line + a concrete fix. If asked, apply the fixes (in scope) and re-verify. Spine-consistency findings → propose the canonical edit (e.g. a missing `FEATURES-PAGES` row), don't just flag.

**Applying a batch of fixes? Isolate them in a worktree.** When you're asked to apply the findings rather than just report them, run the fix pass in a dedicated worktree so a bad fix can't reach the main working tree: one commit per finding (revertable and reviewable in isolation), and back a wrong fix out with `git revert`/`git reset` — never a corrective Write layered on top. Leave a short recovery note (findings done, worktree path) so a crashed run can be cleaned up. One fix agent owns the whole findings list — not one agent per finding, which races on shared files.

## Invariants
- Verify before reporting — no unverified finding presented as high-confidence.
- Always run the spine-consistency lens (it's the differentiator).
- Moderate concurrency; synthesis after the fan-out.
- Reviews propose canonical edits; they don't silently rewrite the spine.
- Applying fixes runs in a dedicated worktree — one commit per finding, roll back with git (never a corrective Write), one fix agent per findings list, plus a recovery note.
- Graphify blast-radius check (if available) is an optional input to scoping — complements, never replaces, the lens fan-out.
