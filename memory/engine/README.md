# respawn-memory: the RespawnPack memory engine

The heavyweight backend for RespawnPack's [memory layer](../README.md), one of three that share a single schema (canonical: [`../knowledge-graph.md`](../knowledge-graph.md#one-schema-three-backends)). It does **not** invent a data model. It implements the existing knowledge-graph schema and makes recall far better: **markdown-in-git** entity files are the source of truth, indexed into **PGLite (Postgres-in-WASM) + pgvector** for **hybrid retrieval** (vector ⊕ full-text, fused with RRF) and **graph-augmented recall**. Local-first, single-operator, no required cloud. Embeddings are **pluggable**.

> ⛔ **Distribution, before anything else.** This engine is **opt-in**. File-backed memory
> (`memory/graph/` + grep) is the zero-setup default and needs none of what follows. Install this with
> `node install/install.js <target> --with-memory`, which copies the engine INTO the target and
> registers it **project-locally** in `.mcp.json` against the absolute Node path the installer resolved
> — then confirm it actually answers with `respawnpack doctor`, which completes a real MCP handshake and
> writes a memory through one server process and reads it back through a second. **There is no global
> `rmem` command**: `rmem` is the bin of this private, unpublished package, so every `rmem …` invocation
> below is the in-repo CLI (`node memory/engine/src/cli.mjs …`) or its MCP tool equivalent. There is
> no global `rmem` to install; the installer registers the engine project-locally against an absolute
> Node path.
>
> **Status: built + tested.** Store · index · pluggable embeddings · hybrid + graph-augmented retrieval · traversal · persistence · incremental `sync` · spine-aware negative facts · the living-skill `lessonsFor` feed · vocabulary enforcement · merge/dedup · staleness decay · outcome feedback · size caps · near-duplicate detection · query logging · the freshness hook · `rmem doctor` · the `rmem` CLI · the MCP server all pass `npm test` (**169 assertions** across `smoke` + `full` + `fixes` + `lessons`, on the offline embedder).

## respawn-memory and Claude Code's built-in auto memory
Claude Code v2.1.59+ ships auto memory on by default: Claude writes freeform markdown notes on learnings and patterns to `~/.claude/projects/<project>/memory/`, and a `MEMORY.md` index auto-loads its first 200 lines or 25KB at the start of each session. It is machine-local and unstructured. Claude treats it as context to consider, not enforced configuration.

respawn-memory is a different tool solving a different problem: a typed knowledge graph (entities, observations, typed relations) with hybrid vector plus full-text retrieval, graph-augmented recall, spine-aware negative facts pulled from the DECISIONS register, and CODE-WINS confidence decay on stale entries. The two work together: auto memory holds ad hoc session notes, and respawn-memory holds the durable, queryable project graph.

## The merge it implements
The original principle is the **entity graph** (`gotcha:` / `infra:` / `compat:` / `decision:` / `hyp:` entities, observations, typed edges, query-first discipline). gbrain-style retrieval is **hybrid search**. This engine unifies them: it indexes each **entity's observations** for semantic+keyword recall *and* keeps the **typed relations** as a graph, so a query finds the seed entity by meaning, then expands along its edges. Same schema as the other two backends (file+grep, the Anthropic memory MCP) in the **one-schema, three-backends** model; only the recall power differs. Two deliberate improvements over gbrain:
- **Spine-aware.** `importRemovals()` reads `DECISIONS.md` removals so a ⛔ killed feature becomes a **negative entity** recall surfaces with a "do not reintroduce" caveat. *(live: `rmem spine-sync` / `memory_spine_sync`.)*
- **CODE-WINS confidence.** An entity with `verify-against-code` surfaces a **"verify before relying"** caveat on recall, so stale memory is flagged. *(live: see `caveat`.)*

## Accuracy: vocabulary, caps, merge, feedback, decay, incremental sync, doctor
Seven things the engine enforces so the graph stays trustworthy, not just queryable:

- **Vocabulary enforcement — never a silent drop.** The canonical entity-type set (`gotcha | infra | compat | decision | hyp`) and relation-verb set (`depends-on | causes | fixed-by | supersedes | relates-to | applies-to`) live in [`../knowledge-graph.md`](../knowledge-graph.md) and are mirrored as `ENTITY_TYPES` / `RELATION_VERBS` in `src/config.mjs`. The two are enforced differently, deliberately:
  - An unknown **relation verb** is a hard reject: `remember()` validates the MERGED entity's relations via `assertKnownVerbs` and throws BEFORE either the markdown write or the index write, naming the bad verb, the `verb|dst` string it came from, and the allowed set. This holds on first-`remember()` AND on the merge path — a bad verb on a re-`remember()` of an *existing* entity throws before its markdown file is touched, so the prior on-disk content is left exactly as it was (no partial write, merged or otherwise). A malformed relation (missing the `verb|dst` shape entirely) is likewise never silently dropped during a merge — `mergeRelations()` passes it through unchanged so it reaches `assertKnownVerbs` and is rejected the same loud way. A relation is always structured `"verb|dst"` input — there's no legitimate reason for it to be malformed, so failing loud and immediate beats an edge nobody notices is missing or dropped.
  - An unknown **entity type** is accepted, not rejected — but never silent. A raw `type:slug` id can come from ad hoc or even hostile input, and the store's path-safety (`slugifyType`) already folds it into a safe path on disk regardless; rejecting on top of that would just turn already-handled input into an unnecessary hard failure. Instead the returned entity carries a `vocab_warning` string (bad value + the allowed set) and `remember()` logs it via `console.warn` — so a caller can't miss it, but a note titled `idea:whatever` still gets saved. `sync()` runs the same `checkEntityType()` warning pass over every entity it reads from markdown, so a non-canonical type sitting in a hand-edited file is surfaced too, not just one that came in through `remember()`. See `checkEntityType()` in `src/store.mjs`.
- **Caps enforced in the engine core, not just at the MCP edge.** The size caps (body ≤ 100000 chars, ≤ 50 aliases at ≤ 200 chars each, ≤ 100 relations at ≤ 200 chars each, id ≤ 200 chars) used to live only in `mcp.mjs`'s zod schema — a CLI or a direct `engine.remember()` call bypassed them entirely. They're now enforced inside `remember()` itself: the raw id is capped (`assertIdCap`) BEFORE `normalizeEntity()`'s `slugify()` gets a chance to silently fold an oversized id into a short one, and body/aliases/relations are capped on the MERGED entity (`assertContentCaps`) so a merge that pushes a combined body/observations — or a unioned alias/relation list — past the cap is caught too, before either write (the same no-partial-write guarantee `assertKnownVerbs` already gives a rejected relation verb). Throws loud, naming the field, the size actually seen, and the cap — never truncates. The zod caps in `mcp.mjs` stay in place as defense-in-depth on the MCP surface. See `CAPS` / `assertIdCap` / `assertContentCaps` in `src/store.mjs`.
- **Merge, don't clobber.** Calling `remember()` again for an id that already exists **unions** rather than overwrites: observations are deduped by normalized text (trim/lowercase/collapse-whitespace) so re-sending the same fact is a no-op, relations are deduped by `verb + normalized-dst`, and aliases are deduped exactly. Scalar fields (`confidence`, `observed_at`, `verify_against_code`, `negative`) take the incoming value only when the caller actually supplied one, so a partial re-`remember()` never wipes a previously-recorded fact. `addObservation()` is now a thin wrapper that hands `remember()` only the new text — the merge does the append-and-dedup. See `mergeEntity()` / `mergeBodies()` / `mergeRelations()` / `mergeAliases()` in `src/store.mjs`.
- **Outcome feedback closes the loop on recall.** `feedback(id, outcome, note)` routes through the same `remember()`/merge machinery every other write goes through — never a raw write. `"useful"` refreshes `observed_at` to now with a small confidence nudge (+0.05, capped at 1.0) — decay already keys off `observed_at` (see below), so a confirmed-useful fact naturally de-stales; no new frontmatter field needed. `"wrong"` REQUIRES a note and appends a `## Correction` observation while reducing confidence (−0.2, floored at 0.1). A ⛔ negative entity is exempt from the confidence games either way: `"useful"` is a no-op on it, and `"wrong"` only appends the Correction text — a do-not-reintroduce fact can never be buried by a confidence swing. An unknown id is a loud error, never a silent create. *(live: `rmem feedback <id> <useful|wrong> [--note "..."]` / `memory_feedback`.)*
- **Staleness decay (read-time, non-destructive).** Every entity's *effective timestamp* is `observed_at` (when the fact was true) if set, else `updated_at` (when it was last written — always set by `remember()`, and correctly round-tripped by `sync()` too: reading a markdown file back into the index preserves its true `updated_at` rather than resetting it to fresh). At query time, `search()` applies a simple exponential half-life (`STALE_HALF_LIFE_DAYS = 90` in `src/retrieve.mjs`) to the fused RRF score before ranking, so a fresher entity outranks an otherwise-equally-relevant stale one — the decay factor influences *which* candidates make the top-`k`, not just their cosmetic display order. Below `STALE_FLAG_THRESHOLD` (0.25, ~2 half-lives) an entity's `caveat` becomes `"possibly stale — not observed recently, verify before relying"`. Stored `confidence` is never touched — decay is purely a derived `.decay` / `.stale` field computed at read time, same spirit as the CODE-WINS caveat above. A ⛔ negative (spine removal) is **exempt from decay entirely** (`effectiveDecay()` in `src/retrieve.mjs` returns a flat `1` for it) — it's supposed to be permanent, so it can never be aged out of a top-`k` search result before its caveat is even computed, and its displayed `.decay`/`.stale` fields agree with that (never shown as "possibly stale").
- **`sync()` is incremental, not wipe-and-re-embed-everything.** Every entity carries a content hash (`store.contentHash` — the frontmatter facts, body, and `updated_at`) in the index; an entity whose freshly-read markdown hash matches what's already indexed is left alone entirely — no delete, no re-embed — which matters once embeddings cost money/latency (`ollama`/`openai`), not just on the free offline `local` embedder. An indexed entity whose markdown file has vanished since the last sync is pruned. This preserves the prior contract exactly: the whole pass is still one transaction (a mid-rebuild embed failure on a changed entity still rolls back to the pre-sync index), the entity-type vocabulary-warning pass still runs over every markdown entity whether it changed or not, and an unchanged entity's `updated_at` is never touched — decay is never reset to fresh. `sync()` returns `{ total, changed, unchanged, pruned }`; the CLI and `memory_sync` both report all four. A persisted index from before this existed self-heals on its first sync after upgrade (see the schema-version guard in `src/index/db.mjs`) rather than requiring a manual rebuild.
- **`rmem doctor`** — a read-only health check (`rmem doctor` / `memory_doctor`) that reports: orphan relations (a `dst` id with no backing entity), unknown entity-types/relation-verbs present in the markdown source, duplicate entities (the same id backed by >1 file) and duplicate observations (repeated text within one entity), stale entries (old + a low effective decay score), index-vs-source drift (the PGLite index disagreeing with the markdown source of truth — missing, extra, or stale-`updated_at` entities), and near-duplicate entities (a Jaro-Winkler similarity ≥0.85 over each pair's normalized slug + aliases, flag-only — see `src/similarity.mjs`). The orphan-relation check normalizes BOTH sides of the comparison (`normalizeRelId()` on the relation's `dst`, against already-normalized entity ids) — a relation authored e.g. `depends-on|infra:Redis` correctly resolves against `infra:redis` rather than being false-flagged as orphan. `--fix` is opt-in and applies **only** the two fixes that are safe and deterministic — dedup identical observations, drop relations that are truly orphaned — and reports exactly what changed; everything else (unknown vocab, drift, which duplicate file to keep, and near-duplicates) is left for a human, on purpose — near-duplicates are deliberately EXCLUDED from `--fix` even as an opt-in: two similar-sounding entities in a hand-curated graph can be deliberately distinct, so auto-merging them would be actively dangerous, not just unhelpful. See `src/doctor.mjs` (`runDoctor` / `fixDoctorIssues`), wired as `engine.doctor({ fix })`.

## Architecture
```
memory/graph/<type>/<slug>.md   ← source of truth: ONE entity per file
  frontmatter: type · aliases · relations (verb|dst-id) · confidence · verify-against-code
  body:        the observations (## Symptom / ## Root cause / ## Fix …)
        │  remember / addObservation / sync
        ▼
PGLite + pgvector   entities · observations(emb, tsv) · relations
        │
   hybrid + graph    search: vector ⊕ full-text → RRF → ranked entities
                     recall: search the seeds, then expand 1 hop along typed relations
                     neighbors: pure graph traversal
```
- **`src/store.mjs`**: read/write entity markdown (`type:slug` ids, foldered by type); entity-type vocab check (`checkEntityType`); the merge/dedup helpers (`mergeEntity` and friends); the size caps (`CAPS` / `assertIdCap` / `assertContentCaps`); the per-entity content fingerprint (`contentHash`) `sync()` uses to skip unchanged entities.
- **`src/index/db.mjs` · `ingest.mjs`**: PGLite schema (entities/observations/relations, plus a `content_hash` column with a schema-version migration guard for an index persisted before it existed); chunk the body into observations → embed → upsert; a synthetic name/alias observation makes name recall work; `assertKnownVerbs` rejects an unknown relation verb (also called directly from `engine.remember()` before the MARKDOWN write, so a rejected verb on a merge never reaches disk — not just before the index write).
- **`src/embeddings/`**: pluggable: `local` (zero-config, offline, deterministic hash, a weak lexical *dev/test* fallback), `ollama` (local-but-real), `openai` (any OpenAI-compatible endpoint). True dim probed at init.
- **`src/retrieve.mjs`**: `search` (hybrid, decay-ranked) · `recall` (graph-augmented) · `neighbors` (traversal) + the CODE-WINS / possibly-stale / ⛔ caveats; `decayFactor` / `effectiveTimestamp` / `effectiveDecay` are exported standalone (`effectiveDecay` is the single place `negative` is exempted from decay, shared by both ranking and display so they can't disagree).
- **`src/doctor.mjs`** (+ **`src/similarity.mjs`**): `runDoctor` (read-only health check, normalizes relation dsts via `normalizeRelId` before the orphan-existence check, and flags near-duplicate entities via a small dependency-free Jaro-Winkler over normalized slug+aliases, same-type pairs only, so the deliberate cross-type slug convention — `infra:redis` + `gotcha:redis` — is never flagged) + `fixDoctorIssues` (the safe deterministic subset of fixes, reading the fix target from the markdown source of truth when one exists — near-duplicates are deliberately excluded) — see "Accuracy" above.
- **`src/engine.mjs`**: `remember` (merges + enforces vocab + caps, validated before either write) / `addObservation` / `get` / `query` / `recall` (both logged, see `src/querylog.mjs`) / `neighbors` / `feedback` / `lessonsFor` / `sync` (incremental; also runs the entity-type vocab check) / `count` / `doctor`.
- **`src/querylog.mjs`**: a fail-silent JSONL append of every `query()`/`recall()` call (`query-log.jsonl` under `dataDir`) — wrapped so a logging failure can never break a query. Off for the ephemeral `dataDir: 'memory:'`; toggle with config `queryLog: false` or env `RESPAWN_MEMORY_QUERY_LOG=0`.
- **`src/hook.mjs`**: `rmem hook install|uninstall|status` — portable-sh `post-merge`/`post-checkout` git hooks that run `rmem sync` synchronously and fail open (missing `rmem`, missing config, or a failed sync all exit 0). A pre-existing hook without the `# respawn-memory hook v1` marker is never touched.

## Config (`respawn-memory.config.json` at the repo root)
Pluggable, **no hard cloud default**: `local` runs offline out of the box; configure a real provider for quality.
```jsonc
{
  "memoryDir": "memory/graph",
  "dataDir": "memory/.index",          // or "memory:" for an ephemeral in-memory index
  "embeddings": { "provider": "ollama", "model": "nomic-embed-text", "baseUrl": "http://localhost:11434" }
  // or { "provider": "openai", "model": "text-embedding-3-small", "apiKeyEnv": "OPENAI_API_KEY" }
  // default: { "provider": "local", "dim": 256 }  ← offline, lexical-only; fine for dev, weak for recall
}
```

## Use
```js
import { createEngine } from './memory/engine/src/engine.mjs'; // relative: the package is private (in-repo)
const m = await createEngine();
await m.remember({
  id: 'gotcha:redis-tls-mismatch', confidence: 0.9, verify_against_code: true,
  aliases: ['redis tls'], relations: ['fixed-by|decision:redis-rediss-scheme'],
  body: '## Symptom\nRedis handshake fails in prod.\n## Fix\nUse the rediss:// (TLS) scheme.',
});
// Re-remember()ing the same id MERGES: this adds a 3rd observation, it does not duplicate the entity.
await m.remember({ id: 'gotcha:redis-tls-mismatch', body: '## Detection\nError string: "unencrypted connection".' });
await m.query('redis handshake error');           // hybrid → ranked entities, decay-ranked (+ CODE-WINS / possibly-stale / ⛔ caveat)
await m.recall('redis fails', { k: 1, expand: 1 }); // { seeds, related }: seed + its fix via the graph
await m.neighbors('gotcha:redis-tls-mismatch');    // typed edges
await m.feedback('gotcha:redis-tls-mismatch', 'useful');                    // confirms it: observed_at -> now, confidence +0.05
await m.feedback('gotcha:redis-tls-mismatch', 'wrong', 'the scheme changed again in v3'); // appends a ## Correction, confidence -0.2
await m.sync();                                     // incremental: rebuilds the index from markdown, skipping unchanged entities
await m.doctor();                                    // read-only health check: orphans, unknown vocab, dupes, staleness, drift, near-dupes
await m.doctor({ fix: true });                       // + apply the safe, deterministic fixes (dedup + drop truly orphan relations)
```
```bash
rmem feedback gotcha:redis-tls-mismatch useful
rmem feedback gotcha:redis-tls-mismatch wrong --note "the scheme changed again in v3"
rmem doctor              # same health check from the CLI (now including near-duplicates)
rmem doctor --fix        # + apply the safe fixes, report exactly what changed
rmem hook install # write post-merge/post-checkout hooks that run `rmem sync` after a pull/checkout
rmem hook status  # ours | foreign | absent, per hook
```

`npm test` runs on the local embedder (no network). MIT.
