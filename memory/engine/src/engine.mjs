import { loadConfig } from './config.mjs';
import { getEmbedder } from './embeddings/index.mjs';
import { openDb } from './index/db.mjs';
import { indexEntity, assertKnownVerbs } from './index/ingest.mjs';
import { search, recall, neighbors } from './retrieve.mjs';
import {
  writeEntity, readEntity, readEntities, normalizeEntity, parseAliases, mergeEntity, checkEntityType,
  assertIdCap, assertContentCaps, rawEntityId, contentHash, entityPath,
} from './store.mjs';
import { runDoctor, fixDoctorIssues } from './doctor.mjs';
import { logQuery } from './querylog.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Run fn inside a single transaction so a mid-rebuild failure (e.g. an embeddings outage during
// sync) leaves the prior index intact instead of wiped/partial.
async function tx(db, fn) {
  await db.query('BEGIN');
  try { const r = await fn(); await db.query('COMMIT'); return r; }
  catch (e) { try { await db.query('ROLLBACK'); } catch { /* already aborted */ } throw e; }
}

// The engine over the knowledge-graph schema (entities + observations + relations).
// Markdown-in-git is the source of truth; PGLite is a rebuildable hybrid index on top.
// `persistFiles:false` keeps it index-only (used by tests).
/** @param {object} [opts] root, dataDir, embeddings, persistFiles */
export async function createEngine(opts = {}) {
  const cfg = loadConfig(opts.root || process.cwd(), opts);
  const embedder = getEmbedder(cfg);
  const dim = (await embedder.embed(['dimension probe']))[0].length; // true dim, provider-agnostic
  embedder.dim = dim; // override the provider hint with the probed dim — used to validate vectors
  const db = await openDb(cfg, dim);
  const persist = opts.persistFiles !== false;

  return {
    cfg, embedder, db, dim,

    /**
     * Upsert an entity (the unit of memory). @param {object} input loose: {id|type+slug, body, relations, ...}
     * @param {{replace?:boolean}} [opts] `replace:true` writes `input` verbatim instead of
     *   merging onto the existing entity — an internal escape hatch for `doctor --fix` (which
     *   needs to REMOVE a duplicate/orphan, and the normal union-merge would just resurrect it).
     *   Not exposed via the CLI/MCP surface; regular callers always merge.
     *
     * Vocabulary: an unknown entity TYPE is never silently dropped — it's accepted (a crafted or
     * ad-hoc raw id can produce one, and path-safety already keeps it filesystem-safe) but a
     * `vocab_warning` is attached to the returned entity AND logged loudly via console.warn, so
     * the caller can't miss it. An unknown relation VERB is rejected outright — validated via
     * `assertKnownVerbs` BEFORE either the disk write or the index write, so a rejected verb never
     * touches the source of truth (this holds on first-remember AND on the merge path: a bad verb
     * on a re-remember() of an EXISTING entity throws before its markdown file is touched, leaving
     * the prior on-disk content exactly as it was — no partial write, merged or otherwise).
     * Merge, don't clobber: re-remember()ing an id that already exists UNIONS observations
     * (deduped by normalized text), relations (deduped by verb+normalized-dst), and aliases
     * (deduped exact) onto the existing entity rather than duplicating or overwriting it.
     * Atomic against the source of truth: the index transaction runs BEFORE the markdown write
     * (index-first — see the comment at the write site below), so on ANY failure inside
     * remember() the on-disk .md ends byte-identical to its pre-call state.
     */
    async remember(input, opts = {}) {
      // Cap the RAW id length before normalizeEntity()'s slugify() gets a chance to silently
      // fold an over-long id into a short slug — a too-long id must throw loud, not disappear.
      // rawEntityId() covers BOTH input shapes ({id} and {type, slug}), so the cap can't be
      // bypassed by supplying a 500-char slug instead of a 500-char id.
      assertIdCap(rawEntityId(input));
      const e = normalizeEntity(input);
      if (e.vocab_warning) console.warn(`respawn-memory: ${e.vocab_warning}`);

      const existing = opts.replace ? null : (persist && cfg.memoryDir ? readEntity(cfg, e.id) : null) || (await this.get(e.id));
      const merged = existing ? mergeEntity(existing, e) : e;
      merged.vocab_warning = e.vocab_warning; // surfaced on the return value either way; never persisted (writeEntity ignores it)
      merged.updated_at = new Date().toISOString(); // always bumped — a merge (or replace) is itself an update

      // Lesson 4: caps in the engine core. Checked on the MERGED entity (not just the raw input)
      // so a merge that pushes a combined body/observations — or a unioned alias/relation list —
      // past the cap is caught too, before either write; mcp.mjs's zod caps stay as
      // defense-in-depth on the MCP surface, this is the enforcement every caller goes through.
      assertContentCaps(merged);

      // Validate relation verbs on the MERGED entity before either write. Reuses the same
      // assertKnownVerbs() indexEntity() would otherwise apply only after the disk write — call it
      // here first so a rejected verb throws before writeEntity() ever touches markdown (closes
      // the "bad verb on a re-remember corrupts the source of truth" bug: previously writeEntity
      // ran first and indexEntity's internal check threw only afterward, so the bad merged body/
      // relations were already persisted to disk by the time the error surfaced).
      assertKnownVerbs(merged.relations);

      // INDEX-FIRST write order: run the index transaction before touching the markdown source
      // of truth. If ANYTHING inside remember() fails — an embedder outage, a malformed vector, a
      // DB error — the tx() rolls the index back AND the .md on disk is still byte-identical to
      // its pre-call state, so a caller who was told the operation failed never finds the source
      // of truth silently mutated underneath the old index (the reverse of the old order's bug).
      // The residual failure window is the opposite, benign direction: if writeEntity() itself
      // fails AFTER the index commit, the exception is honest (the write really didn't happen)
      // and the index is merely briefly AHEAD of markdown — which the next sync() reverts from
      // markdown truth via the content-hash mismatch (or prunes, for a never-written new entity),
      // exactly the "index is a disposable, rebuildable cache under markdown-in-git truth"
      // invariant this engine is built on. entityPath() (the same helper writeEntity() itself
      // uses) computes AND path-safety-validates the on-disk path up front, so the indexed row
      // carries the correct path and a crafted path still rejects before any write of either kind.
      if (persist && cfg.memoryDir) merged.path = entityPath(cfg, merged);
      await tx(db, () => indexEntity(db, embedder, merged, cfg));
      if (persist && cfg.memoryDir) writeEntity(cfg, merged);
      return merged;
    },

    /** Extend an entity with a new observation (extend-don't-duplicate; a no-op if the
     * normalized text is already present). @param {string} id @param {string} text */
    async addObservation(id, text) {
      const onDisk = persist ? readEntity(cfg, id) : null;
      const cur = onDisk || (await this.get(id));
      if (!cur) throw new Error(`unknown entity ${id} — remember() it first`);
      // Pass only the new text as `body` — remember()'s merge onto the existing entity does the
      // append-and-dedup, so an identical (already-present) observation is correctly a no-op.
      return this.remember({ id: cur.id, body: text });
    },

    /** Fetch one full entity from the index (with its relations + aliases as a list). @param {string} id */
    async get(id) {
      const r = (await db.query('SELECT * FROM entities WHERE id = $1', [id])).rows[0];
      if (!r) return null;
      const rels = (await db.query('SELECT rel, dst FROM relations WHERE src = $1', [id])).rows.map((x) => `${x.rel}|${x.dst}`);
      return {
        id: r.id, type: r.type, slug: r.slug,
        aliases: parseAliases(r.aliases),
        confidence: r.confidence, observed_at: r.observed_at, updated_at: r.updated_at, verify_against_code: r.verify_against_code,
        negative: r.negative, relations: rels, body: r.body, path: r.path,
      };
    },

    /** Lessons keyed to a skill (entities with `applies-to|skill:<name>`) — the living-skill feed. */
    async lessonsFor(skillName) {
      const dst = skillName.startsWith('skill:') ? skillName : `skill:${skillName}`;
      const srcs = (await db.query(`SELECT src FROM relations WHERE dst = $1 AND rel = 'applies-to'`, [dst])).rows.map((r) => r.src);
      if (!srcs.length) return [];
      const rows = (await db.query(
        `SELECT * FROM entities WHERE id = ANY($1) ORDER BY confidence DESC NULLS LAST, observed_at DESC`, [srcs])).rows;
      return rows.map((r) => ({ id: r.id, type: r.type, confidence: r.confidence, observed_at: r.observed_at, body: r.body, negative: r.negative }));
    },

    /** Hybrid search -> ranked entities. Lesson 1: every call is fail-silently JSONL-logged
     * (query-log.jsonl under dataDir) via logQuery() — wrapped so a logging failure can NEVER
     * throw into a query; see querylog.mjs. */
    async query(q, opt) {
      const t0 = Date.now();
      const hits = await search(db, embedder, q, opt);
      logQuery(cfg, { kind: 'search', query: q, k: opt?.k ?? 8, hit_ids: hits.map((h) => h.id), duration_ms: Date.now() - t0 });
      return hits;
    },

    /** Graph-augmented recall: seeds (hybrid) + their related entities. Logged the same way as
     * query() above, kind:'recall'; hit_ids are the seed ids (recall's primary hits). */
    async recall(q, opt) {
      const t0 = Date.now();
      const r = await recall(db, embedder, q, opt);
      logQuery(cfg, { kind: 'recall', query: q, k: opt?.k ?? 5, hit_ids: r.seeds.map((s) => s.id), duration_ms: Date.now() - t0 });
      return r;
    },

    /** Typed edges of an entity. */
    async neighbors(id, opt) { return neighbors(db, id, opt); },

    /**
     * Lesson 2: outcome feedback on a recalled entity. Routes through remember()'s existing
     * merge/vocab/cap machinery — never a raw write.
     *   "useful": refreshes observed_at to now (decay already keys off observed_at, so a
     *     confirmed-useful fact naturally de-stales) + a bounded confidence nudge (+0.05, capped
     *     at 1.0). No new frontmatter fields.
     *   "wrong": REQUIRES a note; appends a `## Correction` observation and reduces confidence
     *     (-0.2, floored at 0.1).
     * HARD CONSTRAINT: a ⛔ negative entity's status/decay-exemption/caveat is never perturbed by
     * feedback — "wrong" on a negative only appends the Correction observation (confidence
     * untouched, so a do-not-reintroduce fact can never be buried by a confidence game); "useful"
     * on a negative is a no-op (returns the entity unchanged; there is nothing to "confirm-fresh"
     * about a fact that's already decay-exempt and permanent).
     * Unknown entity -> a loud error, never a silent create.
     * @param {string} id @param {'useful'|'wrong'} outcome @param {string} [note]
     */
    async feedback(id, outcome, note) {
      if (outcome !== 'useful' && outcome !== 'wrong') {
        throw new Error(`feedback: outcome must be "useful" or "wrong" (got ${JSON.stringify(outcome)})`);
      }
      const existing = (persist && cfg.memoryDir ? readEntity(cfg, id) : null) || (await this.get(id));
      if (!existing) throw new Error(`feedback: unknown entity ${id} — remember() it first`);

      if (outcome === 'wrong') {
        if (!note || !String(note).trim()) throw new Error('feedback: outcome "wrong" requires a note explaining what was wrong');
        const confidence = existing.negative ? undefined : clamp((existing.confidence ?? 0.5) - 0.2, 0.1, 1.0);
        return this.remember({ id: existing.id, body: `## Correction\n${String(note).trim()}`, confidence });
      }

      // "useful"
      if (existing.negative) return existing; // decay-exempt & permanent — feedback is a no-op
      const confidence = clamp((existing.confidence ?? 0.5) + 0.05, 0.1, 1.0);
      return this.remember({ id: existing.id, observed_at: new Date().toISOString(), confidence });
    },

    /** Rebuild the index from the markdown source of truth (source of truth wins). Every write
     * entrypoint warns on a non-canonical entity type (see remember()); sync() reads entities
     * straight from markdown via readEntities(), bypassing normalizeEntity()'s check, so it must
     * run the same checkEntityType() warning here — collected and console.warn'd per entity,
     * never dropped (an off-vocab type on disk is still indexed, exactly like remember() would).
     *
     * Lesson 3: INCREMENTAL. A full delete-everything-and-re-embed on every sync() is only free
     * on the offline `local` embedder — real ollama/openai providers pay for every observation on
     * every sync, even for entities nobody touched. Each entity now carries a content_hash
     * (store.contentHash — the frontmatter facts + body + updated_at); an entity whose freshly-
     * read markdown hash matches the index's stored hash is left alone entirely (no delete, no
     * re-embed) — the same rebuild-on-mismatch guard db.mjs already uses for the embedder dim
     * change makes an old (pre-hash) index self-heal into this scheme on first sync. Preserves the
     * prior contract exactly: (a) the whole pass is still one transaction, so a mid-rebuild embed
     * failure still rolls back to the pre-sync index (tx(), reused unchanged); (b) the vocab-
     * warning pass still runs over EVERY markdown entity, changed or not; (c) an unchanged
     * entity's row (including updated_at) is never touched, so decay is never reset to fresh — and
     * a CHANGED entity still gets its true updated_at from the markdown it was read from, exactly
     * as before. An indexed entity whose markdown file has vanished is pruned.
     * @returns {Promise<{total:number, changed:number, unchanged:number, pruned:number}>}
     */
    async sync() {
      const ents = readEntities(cfg);
      for (const e of ents) {
        const w = checkEntityType(e.type);
        if (w) console.warn(`respawn-memory: ${w}`);
      }
      const onDiskIds = new Set(ents.map((e) => e.id));
      const indexed = new Map((await db.query('SELECT id, content_hash FROM entities')).rows.map((r) => [r.id, r.content_hash]));

      let changed = 0, unchanged = 0, pruned = 0;
      await tx(db, async () => {
        for (const [id] of indexed) {
          if (onDiskIds.has(id)) continue; // still on disk — not a prune candidate
          await db.query('DELETE FROM observations WHERE entity_id = $1', [id]);
          await db.query('DELETE FROM relations WHERE src = $1', [id]);
          await db.query('DELETE FROM entities WHERE id = $1', [id]);
          pruned++;
        }
        for (const e of ents) {
          if (indexed.get(e.id) === contentHash(e)) { unchanged++; continue; } // skip delete+re-embed
          await indexEntity(db, embedder, e, cfg);
          changed++;
        }
      });
      return { total: ents.length, changed, unchanged, pruned };
    },

    async count() { return Number((await db.query('SELECT count(*)::int AS n FROM entities')).rows[0].n); },

    /** Health-check the store (see doctor.mjs for the full check list). Read-only.
     * @param {{fix?:boolean}} [opts] */
    async doctor(opts = {}) {
      const report = await runDoctor(cfg, db);
      if (!opts.fix) return report;
      const applied = await fixDoctorIssues(this, report);
      return { ...report, applied };
    },

    async close() { await db.close(); },
  };
}
