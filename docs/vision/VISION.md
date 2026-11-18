# RespawnPack: Vision

## What it is

RespawnPack is an open-source, host-adapted coding-agent framework for solo founders and small teams shipping products on managed infrastructure. The current v0.2 distribution is a Claude Code reference implementation. The next architecture keeps a shared continuity, governance, memory, and anti-drift core while adding first-class adapters for Claude Code, OpenAI Codex, and Pi.

It pairs a full operating loop (plan, build, review, test, secure, ship, and session continuity) with a distinctive foundation: an **anti-drift knowledge spine** that keeps project documentation and decisions true over time. Managed-service operations remain MCP-first. Orchestration uses each host's documented native surfaces - hooks, skills, agents, workflows, SDKs, app-server/RPC protocols, and CLI commands - selected through a capability contract instead of assumed from one host.

RespawnPack ships per-MCP-server skills under `ops/mcp/`, built only where a vendor does not already ship one. Its **living/base skill mechanism** pairs a frozen `SKILL.base.md` baseline with an adaptive `SKILL.md` overlay regenerated from memory, with drift-check and reset. It is implemented and opt-in for three canary skills (`debug`, `savepoint`, `knowledge`); every other skill is a fully supported static skill. The optional **respawn-memory engine** stores a markdown-in-git knowledge graph, indexed into PGLite and pgvector for hybrid and graph-augmented recall.

The pack also ships standards and roles for user-facing prose, performance, security, compliance, testing, and agent behavior. These support the operating loop; they do not replace product truth or host security boundaries.

## The problem

Agent coding tools made writing code cheap. For a solo founder over months, the binding constraint is not generation; it is **knowledge drift**. Documentation, mockups, plans, and memory go stale and contradict the code when direction changes. An agent can re-add features that were deliberately killed because nothing records the removal. The feature-page-flow map lives nowhere the agent can read. A long session reaches its context boundary without a verified, executable handoff.

This is the problem RespawnPack's creator (respawnhere) kept hitting when building products with AI assistance on managed infrastructure: the docs and continuity were the bottleneck, not the code. A plan/review/build/ship loop is only as good as the knowledge it operates on, so RespawnPack puts a knowledge and continuity layer underneath the loop and requires roles to read from and write back to it.

## The signature

1. **Anti-drift knowledge spine:** one docs tree in four classes (canonical, derived, reference, and skills); a feature-page-flow matrix that feeds generation and verification; an append-only decisions and removals register; WRITE-ONCE, archive-never-delete, and code-wins rules; and savepoint/respawn procedures tied to executable drift checks.
2. **Verified in-place rollover:** when a host exposes the required capabilities, RespawnPack saves and reads back a handoff, compacts the same conversation, observes completion, rehydrates canonical state, and continues exactly once. When a host does not expose programmatic compaction, RespawnPack stops truthfully at the manual boundary rather than simulating control.
3. **Host-native orchestration:** a shared core is connected through capability-tested adapters. Claude Code, Codex, and Pi use their own documented hooks, SDKs, agents, extensions, app-server/RPC protocols, and CLI surfaces. Host capabilities are dependencies to prove, not features the pack pretends to provide.
4. **MCP-first ops:** direct, typed control of managed services (Postgres/Supabase, Fly, Cloudflare, and others) from inside the agent session, verified against production truth.
5. **Query-first, provenance-aware memory:** structured recall is consulted before reinvestigation. Operational handoffs are always persisted; inferred long-term knowledge begins as a candidate and becomes canonical only after verification.

## Where it sits

RespawnPack is not the first framework to structure an AI coding agent, and it does not claim to have invented persistent knowledge, compaction, or anti-drift. Several projects and hosts have working mechanisms for these concerns. Its contribution is the combination: a WRITE-ONCE canonical/derived docs spine, a decisions and removals register with a killed-feature guard, automated cross-artifact drift checks, verified conversation rollover, and MCP-first managed-infrastructure control for a single operator rather than a fleet.

The capability contract for each host profile, and its declared-versus-observed status today, is in [`conformance/CAPABILITY-MATRIX.md`](../../conformance/CAPABILITY-MATRIX.md).

## Audience and license

Solo founders and small teams on managed infrastructure (Cloudflare, Fly, Supabase, Vercel-class). Licensed AGPL-3.0-or-later: free to use, modify, and self-host, with the reciprocity obligation reaching users served over a network.

## Non-goals

- Supporting every coding-agent host or reducing all hosts to a lowest common denominator.
- GUI or terminal-keystroke automation, private-transcript mutation, or terminal scraping as a control protocol.
- Replacing the host's own session runtime, permission system, sandbox, or security boundary.
- Fleet-scale parallel-agent coordination, a browser daemon, multi-model overlays, or a swarm runtime.
- Claiming automatic rollover where a host only supports a manual compact step.
