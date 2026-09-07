// Index an entity: upsert the entity row, chunk its body into observations (embedded +
// full-text), and write its typed relations. A synthetic "name" observation (type + slug +
// aliases) makes name/alias recall work even before the body matches.
import { RELATION_VERBS } from '../config.mjs';
import { normalizeRelId, contentHash } from '../store.mjs';
import { toVectorLiteral } from '../vec.mjs';

const VERBS = new Set(RELATION_VERBS);

/** @param {string} body @param {number} max */
function chunkObservations(body, max) {
  // Prefer the markdown section structure (## Symptom / ## Root cause / ## Fix) as natural
  // observation boundaries; fall back to paragraph packing.
  const text = String(body || '').trim();
  if (!text) return [];
  const bySection = text.split(/\n(?=#{1,6}\s)/).map((s) => s.trim()).filter(Boolean);
  const units = bySection.length > 1 ? bySection : text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const u of units) {
    if (cur && (cur.length + 2 + u.length) > max) { out.push(cur); cur = u; }
    else cur = cur ? `${cur}\n\n${u}` : u;
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}

function asList(v) { return Array.isArray(v) ? v : v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []; }

/**
 * Validate every `verb|dst` relation string against the canonical vocabulary. Throws a clear,
 * named error on the FIRST bad one — an unknown verb is never silently dropped (it used to be:
 * `if (!VERBS.has(verb)) continue;`). Unlike an unknown entity TYPE (which a hostile/malformed
 * raw id can produce and which path-safety already neutralizes — see store.checkEntityType),
 * a relation string is always structured `verb|dst` input with no such legacy contract, so a
 * hard reject here is the safer default: an edge either belongs in the graph or the caller finds
 * out immediately, rather than the entity silently missing a relation nobody notices.
 * @param {string[]} relations */
export function assertKnownVerbs(relations) {
  for (const r of relations || []) {
    const [verb, dst] = String(r).split('|').map((s) => s && s.trim());
    if (!verb || !dst) throw new Error(`malformed relation "${r}" — expected "verb|dst-id"`);
    if (!VERBS.has(verb)) {
      throw new Error(`unknown relation verb "${verb}" (in "${r}") — not in the canonical vocabulary (${RELATION_VERBS.join(' | ')}); see memory/knowledge-graph.md`);
    }
  }
}

/** @param {import('@electric-sql/pglite').PGlite} db @param {object} embedder @param {object} e @param {object} cfg */
export async function indexEntity(db, embedder, e, cfg) {
  assertKnownVerbs(e.relations); // validate BEFORE any write — a bad verb aborts before touching the DB
  const dim = embedder.dim;
  await db.query('DELETE FROM observations WHERE entity_id = $1', [e.id]);
  await db.query('DELETE FROM relations WHERE src = $1', [e.id]);
  await db.query('DELETE FROM entities WHERE id = $1', [e.id]);

  const aliases = asList(e.aliases);
  await db.query(
    `INSERT INTO entities (id,type,slug,aliases,confidence,observed_at,verify_against_code,negative,body,path,updated_at,content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [e.id, e.type, e.slug, JSON.stringify(aliases), e.confidence ?? null, e.observed_at || '',
     !!e.verify_against_code, !!e.negative, e.body || '', e.path || '', e.updated_at || '', contentHash(e)],
  );

  // A synthetic name/alias observation (ord -1) so "redis tls" finds gotcha:redis-tls-mismatch.
  const nameText = [e.type, e.slug.replace(/-/g, ' '), ...aliases].join(' ');
  const obs = [nameText, ...chunkObservations(e.body, cfg.chunkChars || 1200)];
  const ords = [-1, ...obs.slice(1).map((_, i) => i)];
  const embs = await embedder.embed(obs);
  for (let i = 0; i < obs.length; i++) {
    await db.query(
      `INSERT INTO observations (entity_id, ord, body, emb, tsv) VALUES ($1,$2,$3,$4::vector,to_tsvector('english',$3))`,
      [e.id, ords[i], obs[i], toVectorLiteral(embs[i], dim)],
    );
  }

  // assertKnownVerbs() above already threw on anything malformed/unknown, so every entry here
  // is a well-formed, in-vocabulary "verb|dst" — no silent skip needed (or possible) at this point.
  for (const r of e.relations || []) {
    const [verb, dst] = String(r).split('|').map((s) => s.trim());
    await db.query('INSERT INTO relations (src,rel,dst) VALUES ($1,$2,$3)', [e.id, verb, normalizeRelId(dst)]);
  }
}
