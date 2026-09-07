# RespawnPack: Memory layer

Operational recall, so the agent stops re-investigating solved problems. This is **distinct from `docs/DECISIONS.md`** (which is canonical *product/architecture* decisions): the memory layer holds **gotchas, infra facts, and learnings**, the "we hit this before, here's the fix" knowledge.

## The one rule that makes memory pay off
**Reading it is mandatory.** Memory that's written but never consulted is dead weight, the #1 failure mode of every memory system. So the discipline is baked into the roles: [`/debug`](../skills/debug/SKILL.md) **Step 0 queries memory before investigating**, and resolves close the loop by capturing back ([`/debug`](../skills/debug/SKILL.md) Step 5, [`/knowledge`](knowledge/SKILL.md)).

## What's stored
- **Knowledge graph**: entities + relations + observations (gotchas, infrastructure facts, compatibility constraints, hypotheses). Conventions: [`knowledge-graph.md`](knowledge-graph.md).
- **Learnings ledger**: lighter, append-on-resolution lessons with confidence + source. Format: [`learnings.template.md`](learnings.template.md).
- **Candidate memories**: `/savepoint`'s automatic, evidence-backed captures — every failed/undetermined check, every new goal constraint, every operator-stated root-cause/fix pair. Tracked at `memory/candidates/<id>.json` + `memory/candidates/audit.jsonl` (`core/memory/candidates.js`), reviewed with `respawnpack memory candidates`. **A candidate is not a fact**: it is recallable only as an unverified lead until an explicit, audited `promote` writes it into the graph above (`memory/graph/<type>/<slug>.md`). See [`knowledge-graph.md`](knowledge-graph.md#candidates-a-lead-is-not-a-fact).
- **The register**: `docs/derived/LESSONS.md`, the human-readable projection of everything above. `savepoint --write` renders it — one row per entity promoted into `memory/graph/**` (its id, first observation, `promotedAt`, the `verifiedBy` that earned it, and the skills its `applies-to|skill:` relations name), then the count of leads in `memory/candidates/` still awaiting review — and `savepoint --verify` parses every number back out and compares it to those files, so a stale count is a `FAIL` rather than a plausible sentence. It is a projection, never a source: nothing is decided or written there, and the promotion gate below is still the only door from a lead into the graph. SessionStart cites it in one line, so a session is told the store exists instead of having to think to look — the failure this register was built for was thirteen candidates accumulating unreviewed across sessions because nothing ever mentioned them.
- **Why this repository's own `memory/candidates/` ships tracked**: intentional dogfood residue, a transparency artifact of the same class as `docs/derived/state/pairs.json` and `docs/derived/state/removals.json`. It is never copied into a target install; `install/_sources.js` never names `memory/candidates/`.

## What this is not
The memory layer is not a code index. "What does the code say right now" is answered by Claude Code's own search (Grep, Glob, agentic reading), and "what exists and where it lives" is answered by the docs spine's feature-page-flow matrix. Memory holds what the code cannot say on its own: decisions, constraints, gotchas, learnings, and why something is the way it is. A pre-built code index would go stale on every commit; this layer exists for knowledge that has no other home.

The code-structure question now has a recommended companion: Graphify, wrapped as a pinned external tool via the `ops/mcp/graphify` skill, for calls, imports, and blast-radius queries over an AST-derived graph. The boundary still stands: Graphify holds what the code IS, this layer holds WHY.

## Three backends, one schema
File + grep, the MCP memory server, and the `respawn-memory` engine all implement the same entity/observation/relation schema at increasing recall power. Canonical statement: [`knowledge-graph.md`](knowledge-graph.md#one-schema-three-backends).

Claude Code also ships its own auto memory, a different tool with a different job. See [`engine/README.md`](engine/README.md#respawn-memory-and-claude-codes-built-in-auto-memory).

## The write/read loop
```
/debug Step 0:  search memory for the symptom  ──►  start from the recorded root cause + fix (if found)
        Step 5:  on resolution, capture symptom → root cause → fix  ──►  feeds the next Step 0
/knowledge:      query ("what do we know about X") OR capture a gotcha/learning
/savepoint:      (optional) prompt to capture any uncaptured gotcha from the session
```

## Boundary with the spine
- A **product/architecture decision or removal** → `docs/DECISIONS.md` (canonical, human-authored).
- An **operational gotcha / infra fact / learning** → here (the graph/ledger).
- When in doubt: would a *generator* need it (then DECISIONS) or would a *debugger* need it (then memory)?
