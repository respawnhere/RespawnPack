# Knowledge graph conventions

A small, structured graph beats flat notes because you can traverse relations ("what depends on X," "what causes Y") and query by type. Keep it small and high-signal. The goal is recall of hard-won facts.

## Entity types
| Type | Name pattern | Holds |
|---|---|---|
| **Gotcha** | `gotcha:<slug>` | symptom → root cause → fix. The highest-value type. |
| **Infrastructure** | `infra:<component>` | a live component + its facts (endpoint, region, quirks, config truth) |
| **Compatibility** | `compat:<tool>` | version / tooling / platform constraints that bite (e.g. "X breaks on Windows without Y") |
| **Decision (operational)** | `decision:<slug>` | an ops-level call not big enough for `docs/DECISIONS.md` |
| **Hypothesis** | `hyp:<slug>` | an open theory under investigation (promote to Gotcha when confirmed, or delete) |

## Relations (typed edges)
`depends-on` · `causes` · `fixed-by` · `supersedes` · `relates-to` · `applies-to`. Use them. They're what makes traversal useful (e.g. `infra:redis depends-on compat:tls-scheme`; `gotcha:matchmaker-race relates-to infra:queue`). The last, **`applies-to|skill:<name>`**, links a lesson/gotcha to the RespawnPack skill it informs. It's the relation `/skill-guard` regenerates a living skill's `## Learned` overlay from (see the living-skills doctrine).

## Observations
Atomic facts attached to an entity, one statement each. A Gotcha typically carries three: the symptom, the root cause, the fix. Add observations to grow an entity over time rather than spawning near-duplicate entities.

## Workflow
- **Query first** (`search_nodes` / grep the index) before investigating, always.
- **Extend, don't duplicate**: `add_observations` on an existing entity when the fact belongs to it; `create_entities` only for a genuinely new thing.
- **Promote/prune**: a confirmed `hyp:` becomes a `gotcha:`; a disproven one is deleted. Stale infra facts get corrected, not stacked.
- **Verify before trusting**: a recalled fact reflects when it was written. Confirm it still holds (file/flag/endpoint still exists) before acting on it.

## Naming
Lowercase kebab slugs, type prefix: `gotcha:redis-tls-mismatch`, `infra:media-plane`, `compat:windows-prisma-dll`. Stable slugs so relations + cross-references survive.

## Seeding
On install, seed the few gotchas the project already knows (from past incidents / the changelog). A graph with 10 real gotchas + the query-first discipline beats an empty one nobody fills.

## One schema, three backends
This is the **canonical statement** of RespawnPack's memory model (linked from [`README.md`](README.md) and [`engine/README.md`](engine/README.md), not restated there). The schema is always the knowledge graph on this page: **entities** (`type:slug`) + **observations** + **typed relations**. Three backends implement that same schema at increasing recall power; the markdown entity files stay the source of truth throughout. Pick per repo:

1. **File + grep (no deps).** An entity is `memory/graph/<type>/<slug>.md`: the `type:slug` id maps to `<type>/<slug>.md`, frontmatter carries `aliases` + `relations` (`verb|dst-id`, using the verbs above), and the **body is the observations** (e.g. the `## Symptom` / `## Root cause` / `## Fix` sections of a gotcha). Query = grep. The always-available floor.
2. **MCP memory server.** The Anthropic Memory MCP, whose native primitives **are** this schema: `create_entities` / `add_observations` / `create_relations` (write), `search_nodes` / `open_nodes` (query + traverse). Survives across sessions.
3. **The `respawn-memory` engine** ([`engine/`](engine/)). Keeps those same markdown entity files as the source of truth and adds a PGLite + pgvector index for **hybrid recall** (vector plus full-text) and **graph-augmented retrieval** (find the seed entity by meaning, then expand along its typed relations). It does not change the schema; it indexes it. The "verify before trusting" rule above is enforced there as the CODE-WINS `verify-against-code` caveat on recall. The heavyweight option; degrades to the file backend when it isn't running.

Same entities, relations, and naming across all three; only the recall/indexing power differs. Write to the schema, not to a backend.

## Candidates: a lead is not a fact

`/savepoint` automatically captures **candidate memories** — evidence-backed leads, never conclusions
reconstructed from a diff (ADR-001) — into a separate, TRACKED store (`memory/candidates/<id>.json` +
`memory/candidates/audit.jsonl`, `core/memory/candidates.js`), distinct from the graph above. A candidate is
`finding` (a FAIL/CANNOT_DETERMINE savepoint check), `constraint` (a newly-stated goal constraint), or
`decision`/`root-cause-fix` (an operator-stated `--candidate "kind:text"`). It carries provenance
(who/what captured it, which cycle/revision, what evidence backs it) and a `verificationState`:
`candidate` (the default — a lead), `verified` (promoted), or `rejected`.

**Promotion is the only door into this graph**, and it is never automatic: `respawnpack memory
candidates promote <id> --as <type>/<slug> --verified-by "<what proved it>"` REQUIRES a stated
verification (an empty one is refused) and writes the entity above at `memory/graph/<type>/<slug>.md`
— the file-backed schema this page documents, with `promotedFrom`/`verifiedBy` added to its
frontmatter so the canonical fact traces back to the candidate and the verification that earned it.
`respawnpack memory candidates reject <id> --why "<reason>"` closes a lead that turned out wrong. Both
are idempotent and audited (`memory/candidates/audit.jsonl`): a repeat is a recorded no-op pointing at the first,
not a second promotion or a silently different one.

⛔ **An agent recalling a candidate MUST label it as an unverified lead, every time, with no exception.**
`core/memory/candidates.js`'s `renderForRecall()` is the only rendering path and already prefixes every
unverified item with an `UNVERIFIED LEAD` marker and a "NOT established; verify before relying on it"
qualifier — but any prose summary an agent writes BY HAND (a session note, a savepoint output line, an
answer to "what do we know about X") must carry the same discipline: a candidate is a hypothesis
someone recorded, not project truth, until it has been promoted through the gate above. Presenting a
`candidate`- or `rejected`-state record as settled fact is the exact failure this store exists to
prevent — the same failure the `verificationState` wall is drawn to stop the automatic writer itself
from committing.

## The register: this graph, rendered for a person

The graph above is a directory of markdown files and the candidate store beside it is a directory of
JSON records. Neither is something a person reads, and that cost is measurable: thirteen candidates
accumulated unreviewed across sessions because nothing ever put them in front of anybody.
`docs/derived/LESSONS.md` is the **human-readable projection of both** — rendered by `savepoint --write`
(`kernel/lib/render.js`), one table row per promoted entity (`type:slug`, its first observation,
`promotedAt`, the `verifiedBy` that earned the promotion, and the skills its `applies-to|skill:`
relations name, so a lesson that became a rule is visible as one), then the counts of candidate and
rejected leads with the command to review them. `savepoint --verify` re-derives all three counts from
these same files and compares every rendered number against them, so the register cannot quietly go
stale; SessionStart cites the two counts in one line, read from the tracked files rather than from
`STATE.json`, so it needs no freshness caveat. The register is a **projection and never a source**: it
is regenerated, never hand-edited, nothing is decided in it, and the promotion gate above remains the
only door from a lead into this graph — a candidate appears there as a counted lead under the same
`UNVERIFIED LEAD` discipline, never as a row in the table.
