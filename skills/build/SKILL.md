---
name: build
description: The implementation role — build a planned change to spec, in scope, keeping the spine true. Implements, proposes the canonical edits the change implies (WRITE-ONCE), and leaves the work verified + reviewable.
when_to_use: "build", "implement", "build this", "make the change", "write the code for", "/build"
---

# /build — implement to spec, in scope

The role that turns a plan/spec into a change without drifting the docs or wandering out of scope.

## Step 1 — Read the spec + the spine
Start from the `loadout` output (or the request). Read `docs/FEATURES-PAGES.md` for where it lives, `docs/PRODUCT.md` for the feature + its status, `docs/DESIGN.md` for tokens/components, and `docs/DECISIONS.md` for constraints (and to confirm it isn't ⛔ killed). **Code wins** — read the actual token/copy/schema source; mirror it, don't contradict it.

## Step 2 — Scope yourself
Optional but recommended: `lockdown` to the module(s) you're changing (`node .claude/hooks/lockdown.js --set <dir>`), so the change can't sprawl into auth/payments/etc. Clear it when done.

## Step 3 — Implement
**Test-first where the logic warrants it.** For non-trivial new logic — a branch-heavy function, a parser, a state machine, anything with edge cases worth pinning down — write the failing test first, then the code that makes it pass. Match the ceremony to the blast radius: trivial glue (a prop threaded through, a config wired up) doesn't need the test-first dance. See `docs/reference/testing-standards.md` for what's worth testing and the shapes to reach for.

**Instrument as you build.** On service code, emit the structured logs and symptom signals the first incident will ask for — decisions and rejections at stable keys, correlation ids across boundaries — per `docs/reference/observability-basics.md`. Instrumentation added after the incident is archaeology.

Write the change to match the surrounding code (its conventions, naming, error handling, comment density). **Comment intent, not mechanics** — capture the *why* (decisions, gotchas, invariants), not what the code already says; tie a decision-comment to its `DECISIONS.md` `D-id`. Let names carry intent (a precise name beats a what-comment). No hardcoded values that belong in the token/copy/string sources; no user-facing strings outside the copy source. Keep the diff focused and one-concern. Write to the standard: `docs/reference/coding-standards.md`. On hot paths and growth surfaces (request-path code, lists that grow, high-traffic tables), also write to `docs/reference/performance-standards.md` — no queries in loops, paginate what grows, select what you need, pool connections, timeout external calls. On UI-touching changes (components, views, templates, styles), also write to `docs/reference/design-standards.md` — semantic elements over `<div onClick>`, visible focus states, labeled and validated forms, confirm-or-undo on destructive actions, tokens over hardcoded color/spacing values, and the WCAG 2.2 accessibility baseline. For user-facing copy or docs in the change (READMEs, UI strings, changelog prose), also write to `docs/reference/writing-standards.md`, or hand the prose to [`/wordsmith`](../wordsmith/SKILL.md).

**When you clone, copy, migrate or generate, stamp the marker.** A file you derived from another one
carries a record of where it came from, so a later session (or `savepoint`) can verify it rather than
guess: `node .claude/respawnpack/respawnpack.js lineage stamp <target> --from <sourceId>`. `<sourceId>` is
whatever `loadout` Step 2 named or proposed in `docs/derived/state/lineage.json`; the command refuses an
undeclared source or one the derivation lists as forbidden, so a mis-stamped copy is caught here rather
than at `/savepoint`.

**Before creating a new file, find its closest in-repo analog and match its shape.** A new component, route, test, or module mirrors the layout, naming, and conventions of the nearest existing one of its kind — the codebase's own patterns are the spec for how new files look. Don't invent a structure the repo already has a precedent for.

**Verify third-party surfaces, don't recall them.** For a call shape against a third-party API/SDK/framework — not pure internal logic — verify it against current official docs before writing it from memory; training data goes stale and APIs deprecate. Use `/mcp-context7` where it's wired, else `WebFetch`, and note what you verified. Anything written from memory alone on a third-party surface, with no doc checked, is marked `UNVERIFIED` in the handoff.

**Spot-check a non-trivial in-flight decision.** For a decision that's still cheap to reverse — an algorithm choice, a data-shape assumption, anything crossing a module boundary — run the same skeptic pass `/review` Step 3 applies post-hoc, but mid-build, while it's still cheap to change: hand a fresh subagent (Agent tool, chosen by what the check needs, not a name) the artifact and the contract it must satisfy, not your reasoning, with an explicitly adversarial "find issues, don't validate" prompt. Reconcile findings against the artifact; cap it at 2-3 cycles, then take it to the human rather than grinding alone.

**Optional cross-vendor second opinion (high stakes only).** When the decision's blast radius justifies it, escalate the same skeptic pass to a different family's model for an independent read of the diff, routed through `adapters/providers/offload.js --class review --in <file>`. Ask the user first; the offload is one read-only turn with no tools, picked by the capability register and what this machine can actually reach; and when the environment is non-interactive or the offload path isn't available, skip it and say so rather than blocking.

## Step 4 — Keep the spine true (WRITE-ONCE)
If the change adds / alters / removes a feature, propose the **one** canonical edit for each fact: `PRODUCT.md` row (+ status), `FEATURES-PAGES.md` row (feature ↔ route; add the route if new), and a `DECISIONS.md` entry for any decision/removal. A removal → flip `PRODUCT` status to ⛔ killed + a removal entry. **Propose** these (don't auto-write canonical). Do **not** touch derived docs (`/savepoint` regenerates them).

## Step 5 — Verify
Run the project's gates (typecheck / lint / build). If it's browser-observable, verify in the preview. For a new or materially changed page, run [`/walkthrough`](../walkthrough/SKILL.md) on the touched routes — it verifies the rendered page against its contract (presence per state, flows, and capability parity: every coded action reachable in the UI). Leave it green and reviewable; hand off to `review` / `playtest`.

## Auto mode — run an approved plan unattended
For a multi-task plan you've been asked to execute end-to-end without check-ins. It runs on rails, not on trust:
- **A real spec is the entry ticket.** No `loadout` spec (scope + ordered tasks + acceptance criteria) → no auto mode; ambiguity isn't something to resolve by guessing at 2am.
- **Clean git baseline first.** Start from a clean working tree (commit or stash anything pending) so every task's diff lands isolated and revertable.
- **One approval, up front.** Get explicit go-ahead for the whole plan once — then execute without further prompting, rather than re-asking per task or proceeding with none.
- **Dependency order, one commit per task.** Run tasks in the order their dependencies allow; commit each atomically (`<type>(<scope>): <task>`) so a bad step reverts cleanly and the log reads as the plan.
- **Hard-stop and ask** the moment the spec turns ambiguous, or a task is irreversible or high-risk — a migration, a deploy, a destructive or outward action, anything touching auth or payments. Stopping to ask is the safe default; grinding ahead on a guess is not.

The push-guard, spawn-guard, and wave-ledger rails already make this safe to leave running; `docs/reference/orchestration-patterns.md` carries the unattended-run discipline in full.

## Invariants
- Stay in scope; consider `lockdown`.
- Confusion or an uncertain load-bearing assumption goes back to the human — never coded around.
- New product truth → one canonical place, proposed not auto-written.
- Code wins; no hardcoded values that belong in token/copy/schema sources; new files match their closest in-repo analog.
- Comment intent (the *why*), not mechanics; names carry intent (`docs/reference/coding-standards.md`).
- Hot paths write to the performance standard (`docs/reference/performance-standards.md`).
- UI-touching changes write to the design standard (`docs/reference/design-standards.md`).
- Third-party API/SDK/framework call shapes are verified against current docs or flagged `UNVERIFIED` — never written from memory alone.
- A non-trivial in-flight decision gets a capped (2-3 cycle) skeptic spot-check before you continue, not just a post-hoc `/review`, optionally escalated to a cross-vendor model through the offload path (read-only, ask first, skip-and-announce when unavailable or non-interactive).
- Non-trivial new logic is test-first (`docs/reference/testing-standards.md`); trivial glue is exempt — match ceremony to blast radius.
- Auto mode runs only on a real spec + clean baseline + one up-front approval; dependency order, one commit per task; hard-stop and ask on ambiguity or an irreversible/high-risk task.
- Never hand-edit derived docs.
