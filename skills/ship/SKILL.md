---
name: ship
description: The release role — pre-ship gate, an AUTHORIZED push (never automatic), MCP-first deploy verification, and a savepoint. Optionally runs an independent cross-model review on sensitive paths first.
when_to_use: "ship", "ship it", "release", "deploy", "push it", "land this", "/ship"
---

# /ship — gate → authorized push → verify

The role that gets a change to prod safely. The hard rule: **push is authorized, never automatic.**

## Step 1 — Pre-ship gate
Run the **readiness gate** first: `node .claude/respawnpack/respawnpack.js readiness`. It is the mechanical half of this step — a README, a CI workflow, a test command, secret scanning in CI, a filled CODEOWNERS, a LICENSE, a lockfile, ignored env files, plus this repository's own shape (a Terraform remote state backend, no plaintext credential in a variable file or inventory, vaulted inventories, a health route, migrations, error tracking, a docs index, a link check). Every row carries its remedy; an item that does not apply here is not a row; a tree it recognises nothing in is exit 2, never green. The declared posture scales it (`strict` fails on an unmet item, `light` and `standard` report the same rows at exit 0), and an item the founder has judged is excepted by name with a reason in `respawnpack.config.json` rather than skipped. **Under `strict`, do not proceed past a non-zero exit** — close the item or declare the exception.
Then confirm the change is releasable: `review` clean, `playtest` clean, and the project gates green (typecheck / lint / build). Confirm the spine is consistent (the change's `PRODUCT`/`FEATURES-PAGES`/`DECISIONS` edits are in). For **sensitive paths** (auth / payments / webhooks / migrations), run [`/secure`](../secure/SKILL.md) as a release gate — **block on unresolved HIGH-severity findings** — plus [`/comply`](../comply/SKILL.md) for changes touching regulated personal data, and optionally an **independent cross-model review** (a second model is a real catch on what one rationalizes). At minimum apply the verification gate: any finding you can't verify is low-confidence. For **hot-path changes** (new/changed queries on high-traffic tables, list endpoints, bundle-affecting frontend work), gate on `docs/reference/performance-standards.md`: `EXPLAIN` the new queries MCP-first (the Supabase advisors catch unindexed FKs; for latency, `EXPLAIN` or `pg_stat_statements` via `execute_sql`), confirm pagination on anything unbounded, and check the client bundle delta. For **UI-touching changes** (new/changed components, views, templates, styles), gate on `docs/reference/design-standards.md`: run the §5 validation passes (keyboard-only, narrow-viewport, reduced-motion) and confirm the WCAG 2.2 A/AA accessibility baseline holds — and run [`/walkthrough`](../walkthrough/SKILL.md) on the affected pages (contract + capability-parity check: catches coded-but-unreachable features before users do).

## Step 2 — Stage + describe (don't push yet)
Commit locally with a clear conventional message. Then **stop**: list the staged commits, state exactly what a push triggers (which CI/deploy workflows fire, expected wall-clock + cost), and **ask for explicit authorization.** Past-turn or earlier-in-session authorizations expire — each push needs its own go-ahead. On that go-ahead, mint the single-use marker the `push-guard` hook requires: run `node .claude/hooks/push-guard.js --allow-next`. The rule stays exactly what it was — push is authorized, never automatic — it's just mechanical now: the marker is consumed by the very next `git push` attempt, so the authorization can't quietly outlive this moment.

## Step 3 — Migration-before-deploy check
If the change needs a schema/migration or a config/secret that must exist before the code runs, apply it **first** (MCP-first — e.g. the DB migration via the Supabase/DB MCP) so the deploy doesn't ship a broken endpoint. Verify it landed before pushing.

## Step 4 — Push (only on the go-ahead) + deploy-verify
On the explicit go-ahead, push to the correct remote only. Then verify the deploy MCP-first: health endpoint, the changed surface works in prod, logs clean. Don't declare shipped until verified. If the verify fails, follow `/deploy-verify`'s roll-back-or-roll-forward procedure instead of declaring shipped.

## Step 5 — Savepoint
Run `/savepoint` to record the release (changelog), reconcile gaps, and refresh the handoff.

## Invariants
- **The readiness gate runs before the push, and a non-zero exit under `strict` stops the ship.** Close the item or except it by name with a reason; there is no skip flag.
- **No `git push` without an explicit human go-ahead in the current session.** Default after every commit is wait.
- Migrations/secrets land before the code that needs them.
- Sensitive paths pass `/secure` (no unresolved HIGH-severity findings), and regulated-data changes pass `/comply`, before the push.
- Hot-path changes pass the performance gate (EXPLAIN + pagination + bundle delta) before the push.
- UI-touching changes pass the design gate (§5 validation passes + WCAG 2.2 A/AA baseline) before the push.
- Verify post-deploy before claiming done.
- Push to the correct remote only; know what each push costs.
