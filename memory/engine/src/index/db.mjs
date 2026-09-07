import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// PGLite (Postgres-in-WASM) + pgvector. Local-first, zero external service.
// The schema is the knowledge-graph model (entities + observations + relations) — the SAME
// schema the file/grep fallback and the Anthropic memory MCP use; this backend adds embeddings.
// `dataDir === 'memory:'` -> ephemeral in-memory index; otherwise a persisted dir.
/** @param {object} cfg @param {number} dim */
export async function openDb(cfg, dim) {
  const d = Number(dim);
  if (!Number.isInteger(d) || d < 1 || d > 8192) throw new Error(`invalid embedding dim: ${dim}`);
  const dataDir = cfg.dataDir === 'memory:' ? undefined : resolve(cfg.root, cfg.dataDir);
  if (dataDir) mkdirSync(dataDir, { recursive: true }); // PGLite does not create nested parents
  const db = await PGlite.create(dataDir ? { dataDir, extensions: { vector } } : { extensions: { vector } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k text PRIMARY KEY, v text);
    CREATE TABLE IF NOT EXISTS entities (
      id text PRIMARY KEY,        -- canonical "type:slug" (e.g. gotcha:redis-tls-mismatch)
      type text, slug text, aliases text,
      confidence real, observed_at text, verify_against_code boolean DEFAULT false,
      negative boolean DEFAULT false,  -- a ⛔ removal: deliberately killed, must not return
      body text, path text, updated_at text,
      content_hash text  -- store.contentHash(e); lets sync() skip re-embedding unchanged entities
    );
    CREATE TABLE IF NOT EXISTS observations (   -- chunked entity body; the searchable unit
      id serial PRIMARY KEY, entity_id text, ord int, body text, emb vector(${d}), tsv tsvector
    );
    CREATE INDEX IF NOT EXISTS obs_tsv ON observations USING gin (tsv);
    CREATE INDEX IF NOT EXISTS obs_entity ON observations (entity_id);
    CREATE TABLE IF NOT EXISTS relations (      -- typed edges between entities
      src text, rel text, dst text
    );
    CREATE INDEX IF NOT EXISTS rel_src ON relations (src);
    CREATE INDEX IF NOT EXISTS rel_dst ON relations (dst);
  `);
  // Guard against a persisted index whose vectors were built with a different provider/dim.
  const got = (await db.query(`SELECT v FROM meta WHERE k = 'dim'`)).rows[0];
  if (!got) await db.query(`INSERT INTO meta (k, v) VALUES ('dim', $1)`, [String(d)]);
  else if (got.v !== String(d)) {
    await db.close(); // don't leak the handle/lock on the guard
    throw new Error(`index dim ${got.v} != embedder dim ${d} — embeddings provider changed; run \`rmem reindex\` to rebuild.`);
  }

  // Schema-version guard, same pattern as the dim check above: an index persisted before Lesson 3
  // (incremental sync) predates the `content_hash` column, which CREATE TABLE IF NOT EXISTS above
  // does NOT retrofit onto an already-existing table. Detect it via a versioned meta row and
  // migrate in place (ADD COLUMN IF NOT EXISTS, idempotent) rather than dropping the index: a
  // migrated row's content_hash is NULL, which never equals a freshly computed hash, so sync()
  // naturally reindexes every such entity exactly once — the index "rebuilds cleanly" without a
  // destructive wipe.
  const SCHEMA_VERSION = '2';
  const gotSchema = (await db.query(`SELECT v FROM meta WHERE k = 'schema_version'`)).rows[0];
  if (!gotSchema || gotSchema.v !== SCHEMA_VERSION) {
    await db.exec(`ALTER TABLE entities ADD COLUMN IF NOT EXISTS content_hash text;`);
    await db.query(
      `INSERT INTO meta (k, v) VALUES ('schema_version', $1) ON CONFLICT (k) DO UPDATE SET v = $1`,
      [SCHEMA_VERSION],
    );
  }

  return db;
}
