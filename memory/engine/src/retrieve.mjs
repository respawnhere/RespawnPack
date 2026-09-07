// Retrieval where the graph and the search reinforce each other:
//   search()    — hybrid (pgvector cosine ⊕ Postgres full-text) over observations -> ranked entities
//   recall()    — search for the SEED entities, then expand along typed relations (graph-augmented)
//   neighbors() — pure graph traversal of an entity's typed edges
import { toVectorLiteral } from './vec.mjs';
import { parseAliases } from './store.mjs';
const RRF_C = 60;

// --- staleness / decay (read-time only — never mutates stored confidence) ---
// A simple exponential half-life: an entity not touched in HALF_LIFE_DAYS ranks at half its
// undecayed RRF score, a quarter after 2 half-lives, etc. Deliberately simple (no per-type
// tuning) — see memory/engine/README.md "Merge, decay & vocabulary enforcement" for the model.
export const STALE_HALF_LIFE_DAYS = 90;
// Below this decay factor an entity is flagged "possibly stale" at recall time (~2 half-lives).
export const STALE_FLAG_THRESHOLD = 0.25;

/** The timestamp an entity's freshness is judged by: observed_at (when the fact was actually
 * true) if set, else updated_at (when it was last written) — every remember() sets updated_at,
 * so this is never empty for an indexed entity. @param {{observed_at?:string, updated_at?:string}} f */
export function effectiveTimestamp(f) { return f.observed_at || f.updated_at || ''; }

/** Decay factor in (0, 1] for an entity's age as of `now`. An unparsable/absent timestamp
 * decays to a neutral 1 (no penalty) rather than being silently treated as infinitely stale.
 * @param {string} ts @param {Date} [now] */
export function decayFactor(ts, now = new Date()) {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return 1;
  const ageDays = Math.max(0, (now.getTime() - t) / 86400000);
  return Math.pow(0.5, ageDays / STALE_HALF_LIFE_DAYS);
}

/** The decay factor that actually applies to an entity — the single place `negative` (⛔ spine
 * removal) is exempted from staleness, so ranking (search(), below) and display (rowToEntity,
 * below) can never disagree. A ⛔ removal is SUPPOSED to be permanent, so it never decays (factor
 * 1) — the same exemption doctor.mjs already applies to its staleEntries report.
 * @param {{negative?:boolean, observed_at?:string, updated_at?:string}} f */
export function effectiveDecay(f) { return f.negative ? 1 : decayFactor(effectiveTimestamp(f)); }

function rowToEntity(f, score) {
  const decay = effectiveDecay(f);
  const stale = !f.negative && decay < STALE_FLAG_THRESHOLD;
  return {
    id: f.id, type: f.type, slug: f.slug,
    aliases: parseAliases(f.aliases),
    confidence: f.confidence, observed_at: f.observed_at, updated_at: f.updated_at, verify_against_code: f.verify_against_code,
    negative: f.negative, body: f.body, path: f.path, score,
    decay, stale, // derived, read-time-only fields — never written back to the entity row
    // A ⛔ spine removal wins; else staleness; else CODE-WINS asks to re-verify code/infra recall.
    caveat: f.negative ? '⛔ deliberately removed — do not reintroduce'
      : stale ? 'possibly stale — not observed recently, verify before relying'
      : f.verify_against_code ? 'verify against current code before relying' : undefined,
  };
}

/** Hybrid search over observations -> ranked entities. Ranking applies read-time staleness
 * decay (see decayFactor() above) to the fused RRF score, so a fresher entity outranks an
 * otherwise-equally-relevant stale one; `score` on the returned entity is the DECAYED score
 * (what determined the order), and `.decay`/`.stale` show the factor that was applied. */
export async function search(db, embedder, query, { k = 8, pool = 30 } = {}) {
  const qemb = toVectorLiteral((await embedder.embed([query]))[0], embedder.dim);
  const vrows = (await db.query(
    `SELECT entity_id, MIN(emb <=> $1::vector) AS dist
       FROM observations GROUP BY entity_id ORDER BY dist ASC LIMIT $2`, [qemb, pool],
  )).rows;
  let krows = [];
  try {
    krows = (await db.query(
      `SELECT entity_id, MAX(ts_rank(tsv, plainto_tsquery('english',$1))) AS rank
         FROM observations WHERE tsv @@ plainto_tsquery('english',$1)
        GROUP BY entity_id ORDER BY rank DESC LIMIT $2`, [query, pool],
    )).rows;
  } catch { /* sparse query -> vector only */ }

  /** @type {Map<string, number>} */
  const rrf = new Map();
  vrows.forEach((r, i) => rrf.set(r.entity_id, (rrf.get(r.entity_id) || 0) + 1 / (RRF_C + i + 1)));
  krows.forEach((r, i) => rrf.set(r.entity_id, (rrf.get(r.entity_id) || 0) + 1 / (RRF_C + i + 1)));
  if (!rrf.size) return [];

  // Fetch the FULL candidate pool's entity rows before the k-cutoff, so decay can influence
  // which candidates make the top k (not just re-decorate an already-fixed top-k list).
  const candIds = [...rrf.keys()];
  const ents = (await db.query(`SELECT * FROM entities WHERE id = ANY($1)`, [candIds])).rows;
  const byId = new Map(ents.map((e) => [e.id, e]));

  const decayed = candIds
    .filter((id) => byId.has(id))
    .map((id) => {
      const f = byId.get(id);
      // effectiveDecay() exempts `negative` (⛔ spine removal — "do not reintroduce") from the age
      // penalty, so a permanent removal fact isn't sliced off the top-k before its caveat is ever
      // computed; same helper rowToEntity() uses for the displayed .decay/.stale, so ranking and
      // display can never disagree.
      const decay = effectiveDecay(f);
      return { id, f, rawScore: rrf.get(id), score: rrf.get(id) * decay };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return decayed.map(({ f, score }) => rowToEntity(f, score));
}

/** The typed edges of an entity (outgoing and incoming). */
export async function neighbors(db, id, { rel } = {}) {
  const out = (await db.query(
    `SELECT rel, dst AS other, 'out' AS dir FROM relations WHERE src = $1 ${rel ? 'AND rel = $2' : ''}`,
    rel ? [id, rel] : [id])).rows;
  const inc = (await db.query(
    `SELECT rel, src AS other, 'in' AS dir FROM relations WHERE dst = $1 ${rel ? 'AND rel = $2' : ''}`,
    rel ? [id, rel] : [id])).rows;
  return [...out, ...inc];
}

/**
 * Graph-augmented recall: hybrid-search the seeds, then pull their 1-hop related entities so
 * the answer includes the gotcha AND its fix AND what it touches.
 */
export async function recall(db, embedder, query, { k = 5, expand = 1 } = {}) {
  const seeds = await search(db, embedder, query, { k });
  const hops = Math.max(0, Math.floor(Number(expand) || 0));
  if (!hops || !seeds.length) return { seeds, related: [] };
  const seen = new Set(seeds.map((s) => s.id));
  /** @type {Map<string, {via:string, from:string, hop:number}>} */
  const refs = new Map();
  let frontier = seeds.map((s) => s.id);
  for (let hop = 1; hop <= hops && frontier.length; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const n of await neighbors(db, id)) {
        if (seen.has(n.other)) continue;
        seen.add(n.other);
        refs.set(n.other, { via: n.dir === 'out' ? n.rel : `${n.rel} (inverse)`, from: id, hop });
        next.push(n.other);
      }
    }
    frontier = next;
  }
  if (!refs.size) return { seeds, related: [] };
  const ents = (await db.query(`SELECT * FROM entities WHERE id = ANY($1)`, [[...refs.keys()]])).rows;
  const byId = new Map(ents.map((e) => [e.id, e]));
  // Only surface neighbors that exist as entities (skip dangling targets like a skill:<name>).
  const related = [...refs.entries()].filter(([id]) => byId.has(id)).map(([id, ref]) => ({ ...rowToEntity(byId.get(id), 0), ...ref }));
  return { seeds, related };
}
