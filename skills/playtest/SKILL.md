---
name: playtest
description: The QA / playtest role — exercise the real surface (the host's /run), find issues across tiers, FIX them, and write a regression test encoding each bug, with an atomic commit per fix and a self-regulating stop heuristic. Verification before and after delegates to the host's /verify. Turns "found a bug" into "fixed + can't regress."
when_to_use: "playtest", "/playtest", "qa", "/qa", "test this", "smoke test", "find bugs", "qa the feature", "check it works"
disable-model-invocation: true
---

# /playtest — find → fix → regression-test loop

**Thin wrapper.** Exercising the surface is the host's `/run` and the before/after check is the host's `/verify` — the host's commands, which the pack does not vouch for; no `/run` or `/verify` here means drive and test directly, and say so. The pack keeps the find → fix → regression-test loop: **every fix gets a regression test**, committed atomically.

## Step 1 — Exercise the surface
Drive the real thing with the host's `/run`: the API/CLI for backends, the test suite where it exists, and for browser UI the official [`anthropics/skills` **webapp-testing**](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) skill or the **`browser_*`** MCP tools. Drive the live app, not a mock, and cross-reference `docs/FEATURES-PAGES.md` — a feature that should be there but isn't is a finding.

## Step 2 — Find across tiers
Collect issues by tier: (1) broken/incorrect behavior, (2) missing states (empty/loading/error), (3) a11y/perf/polish. Note repro for each.

## Step 3 — Fix → regression-test → atomic commit (per issue)
For each issue, in order:
1. **Fix** it in source (in scope).
2. **Write a regression test** that encodes the exact bug (fails before, passes after). If the repo has no test setup, scaffold the minimal one — breaking the no-tests baseline. **For a timing or async bug, poll for the real condition with a deadline — never a fixed `sleep`.** Wait on the actual post-condition (the element appears, the row lands, the state settles) up to a timeout.
3. **Commit atomically** — one fix + its test per commit (`fix(<area>): <bug>`), revertable + reviewable.
4. **Verify before/after** with the host's `/verify` (a test run or screenshot where `/verify` is unavailable), so the fix is proven, not asserted.

**Running the loop unattended? Isolate it in a worktree.** A background agent driving this loop runs in a dedicated worktree: the per-issue atomic commit is the rollback unit — back a bad fix out with `git revert`, never a corrective Write — with a recovery note. One fix agent owns the whole issue list.

## Step 4 — Self-regulating stop
Stop when: the surface is clean, OR you hit the fix cap (default ~10), OR risk is rising (speculative fixes, unrelated code touched, confidence dropping). Don't grind past confidence — report what's left.

## Step 5 — Hand off
Summarize: fixed (with commits + tests), still-open (with repro), and any spine edits implied (propose the `PRODUCT`/`FEATURES-PAGES` update for a missing feature). Hand off to `ship`.

## Invariants
- Exercising the surface is the host's `/run`; the before/after check is the host's `/verify`. Absent → drive and test directly and say so, never skip the proof.
- Every fix gets a regression test; one fix + test per atomic commit.
- A timing/async regression test polls for the condition with a deadline, never a fixed `sleep`.
- An unattended loop runs in a dedicated worktree — the atomic commit per issue is the rollback unit, git revert (never a corrective Write), a recovery note, one fix agent for the list.
- Stop on the cap or rising risk; report the remainder rather than over-fixing.
