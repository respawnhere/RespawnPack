---
name: debug
description: The diagnosis role — query memory first, find the real root cause before any fix, then capture the learning so the next session finds it. Enforces "no fixes without investigation" and a stop-after-N-failed-fixes guard.
when_to_use: "debug", "/debug", "postmortem", "/postmortem", "investigate", "why is this broken", "root cause", "this is failing", "fix the bug", "prod issue"
---

# /debug — query-memory-first diagnosis

The role that resists the urge to fix blind. Memory only pays off if it's read first — so this skill makes that Step 0.

## Step 0 — Query memory FIRST (the discipline)
Before investigating, search project memory for the symptom — whichever backend is wired (same schema across all): the **respawn-memory engine** (`memory_query` for hybrid recall, `memory_recall` for the seed gotcha + its fix via the graph), the **Anthropic Memory MCP** (`search_nodes`), or grep the entity files under `memory/graph/`; plus `docs/DECISIONS.md`. **If a prior entry matches, start from its recorded root cause + fix** — don't re-derive it. Heed the recall caveats: a **`⛔ deliberately removed`** hit means don't reintroduce it; a **`verify against current code`** hit (CODE-WINS) means confirm it still holds before trusting it. On a fresh install, an empty or absent `memory/`/`graph/` means no captured knowledge yet — that's expected, not a failed query; proceed to normal diagnosis. This is the single highest-value habit; do not skip it.

**Optional structural adjunct.** Once memory has surfaced (or ruled out) a prior entry, and you have a suspect symbol or file, check whether Graphify is set up (`/mcp-graphify`) — if so, use `explain <symbol>` (what calls it) or `affected <symbol>` (blast radius) to orient structurally on the failing area before Step 1. This can speed root-cause hunting, but it's optional and structural only — memory stays the mandatory Step 0 for *why* something broke; Graphify only ever answers *what calls what*.

## Step 1 — Reproduce + gather evidence
Reproduce the failure. Collect the concrete signal (logs, stack, a failing request, the exact error) before forming a theory. For prod, prefer MCP-first reads (DB, logs, health) over guessing.

## Step 2 — Root-cause (the Iron Law)
**No fix without a confirmed root cause.**

**Build the tightest feedback loop first.** Before theorizing, find the fastest way to trigger the bug on demand — a one-line repro, a focused failing test, a single request you can replay. Every hypothesis below is tested against this loop; the cheaper it is to run, the more theories you kill per minute.

**Rank falsifiable hypotheses; don't chase one at a time.** Hold two or three candidate causes at once, ordered by likelihood, and for each name the evidence that would *kill* it — a hypothesis you can't falsify is a belief, not a lead. Test the cheapest-to-refute first and let the evidence promote and demote, rather than committing to the first idea and hunting for confirmation.

**Run the common-archetype checklist** when nothing obvious fits — most bugs are one of a handful of shapes: off-by-one / boundary, stale cache or state, race / ordering, environment or config drift, or a fix aimed at the wrong layer. Walk the list before inventing an exotic theory.

If you've made **3 fix attempts without resolution, stop** — the model of the problem is wrong; step back, re-gather, or escalate (below). Don't pile fixes on a misunderstanding.

**Escalation for the hardest, non-reproducible bugs.** When a bug won't reproduce and single-threaded investigation has stalled, fan out 2-3 investigators (Agent tool), each chosen for a different lead to carry, not a name to remember, and each tasked with *refuting the others'* theory, not defending its own. Competing refutation surfaces the real cause faster than parallel confirmation. See `docs/reference/orchestration-patterns.md` for the competing-hypothesis pattern.

## Step 3 — Fix (minimal, in scope)
Apply the smallest change that addresses the root cause. Scope yourself — consider `lockdown` to the module so the fix doesn't sprawl. Don't refactor opportunistically mid-debug.

## Step 4 — Verify
Confirm the original symptom is gone, against the same evidence from Step 1 (not a proxy). Check you didn't break a neighbor.

## Step 5 — Capture the learning
Write the gotcha back to memory — `memory_remember` a `gotcha:<slug>` entity (or `memory_add_observation` to extend an existing one; or write the entity file): **symptom → root cause → fix**, with a `fixed-by` / `relates-to` relation where it aids traversal. This is what makes Step 0 work next time. If it's a real decision/removal, also propose the `DECISIONS.md` entry — the engine mirrors ⛔ removals into memory as negative facts via `memory_spine_sync`.

## Invariants
- Query memory before investigating.
- Graphify (if set up) is optional structural orientation only — supplements, never substitutes, the mandatory memory query.
- No fix without a confirmed root cause: build a fast feedback loop, hold ranked falsifiable hypotheses (each names what would kill it), and stop after 3 failed attempts — for a non-reproducible bug, escalate to competing-hypothesis investigators that refute each other.
- Capture the gotcha on resolution (close the loop).
- Verify against the original evidence, not a proxy.
