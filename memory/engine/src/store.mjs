// Markdown-in-git store: the source of truth. One ENTITY per file under memoryDir,
// foldered by type (memory/graph/<type>/<slug>.md). Body = observations; frontmatter =
// type/confidence/aliases/typed-relations. Git supplies history/provenance.
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.mjs';
import { ENTITY_TYPES } from './config.mjs';

/**
 * @typedef {Object} Entity
 * @property {string} id            canonical "type:slug" (e.g. gotcha:redis-tls-mismatch)
 * @property {string} type          gotcha | infra | compat | decision | hyp
 * @property {string} slug
 * @property {string[]} [aliases]   alternate names for recall
 * @property {number} [confidence]  0..1
 * @property {string} [observed_at]
 * @property {boolean}[verify_against_code]  CODE-WINS: recall flags it for re-verification
 * @property {string[]}[relations]  typed edges "verb|dst-entity-id" (this entity is the src)
 * @property {string} [body]        the observations (atomic statements)
 * @property {string} [path]
 * @property {string} [updated_at]
 */

export function graphDir(cfg) { return resolve(cfg.root, cfg.memoryDir); }

/** Split a canonical id into {type, slug}. */
export function splitId(id) {
  const i = String(id).indexOf(':');
  return i < 0 ? { type: 'fact', slug: String(id) } : { type: id.slice(0, i), slug: id.slice(i + 1) };
}
export function makeId(type, slug) { return `${type}:${slug}`; }
// Path-safe slug, never empty — all-non-ASCII input (CJK/emoji) gets a stable hash slug so it
// isn't silently lost or clobbered onto a shared 'type:' id.
const slugify = (s) => {
  const v = String(s == null ? '' : s);
  const c = v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return c || ('x-' + createHash('md5').update(v).digest('hex').slice(0, 10));
};
// Type segment: path-safe, defaults to 'fact'. Strips any ../ \ : so it can't escape memory/graph.
const slugifyType = (t) => String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'fact';

/**
 * Vocabulary check for an entity type. Path-safety (slugifyType) is a SEPARATE, unconditional
 * concern (a crafted/hostile type must still fold to a safe path); this is purely about the
 * canonical vocabulary in memory/knowledge-graph.md. Never silently drops the entity — an
 * unknown type is surfaced as a warning (not thrown) because a raw `type:slug` id is often
 * hostile/malformed input that path-safety already neutralizes; rejecting it here would just
 * turn an already-handled input into an unnecessary hard failure. Returns the warning string,
 * or undefined if `type` is in ENTITY_TYPES.
 * @param {string} type post-slugifyType (folded) type
 */
export function checkEntityType(type) {
  if (ENTITY_TYPES.includes(type)) return undefined;
  return `unknown entity type "${type}" — not in the canonical vocabulary (${ENTITY_TYPES.join(' | ')}); see memory/knowledge-graph.md`;
}

/** Normalize loose input into a full Entity (derives a path-safe id/type/slug). @param {object} e */
export function normalizeEntity(e) {
  let { id, type, slug } = e;
  if (id) ({ type, slug } = splitId(id));
  type = slugifyType(type);
  slug = slug ? slugify(slug) : slugify(e.title || e.slug || (e.body || '').split('\n')[0].slice(0, 48) || 'note');
  const vocabWarning = checkEntityType(type);
  const out = { ...e, id: makeId(type, slug), type, slug };
  if (vocabWarning) out.vocab_warning = vocabWarning; // surfaced, never silently dropped — see engine.remember()
  return out;
}

/** Normalize a relation endpoint id exactly like an entity id, so graph edges never dangle. */
export function normalizeRelId(rawId) {
  const { type, slug } = splitId(rawId);
  return makeId(slugifyType(type), slugify(slug));
}

// --- size caps (Lesson 4: caps in the engine core) ---
// Mirrors the zod caps in mcp.mjs exactly (id/body/aliases/relations) so a CLI or direct
// engine.remember() call can't bypass them — zod there stays as defense-in-depth on the MCP
// surface only, this is the single enforcement point every caller actually goes through.
export const CAPS = { id: 200, body: 100000, aliasCount: 50, aliasLen: 200, relationCount: 100, relationLen: 200 };

/** The raw, PRE-normalization canonical id of a loose remember() input, covering BOTH input
 * shapes: the explicit `id` when given, else `type:slug` when an explicit slug was supplied —
 * so assertIdCap() below cannot be bypassed by passing {type, slug} instead of {id} (slugify()'s
 * .slice(0,60) would otherwise silently fold a 500-char slug, and two distinct long slugs sharing
 * a 60-char prefix would silently merge into one entity). A title/body-derived slug (no id, no
 * slug supplied) has no raw identifier to cap — its truncation is the documented derivation
 * behavior, not a silent fold of a caller-chosen identifier. @param {object} input @returns {string|undefined} */
export function rawEntityId(input) {
  if (input.id != null) return String(input.id);
  if (input.slug != null) return `${input.type == null ? '' : String(input.type)}:${String(input.slug)}`;
  return undefined;
}

/** Cap the RAW (pre-normalize) id length, before slugify() gets a chance to silently truncate
 * it — a too-long id must throw loud, not fold quietly into a shorter slug. Pass it
 * rawEntityId(input) so the {type, slug} input shape is capped identically to the {id} shape.
 * No-op when there is no raw identifier at all (title/body-derived slug). @param {*} rawId */
export function assertIdCap(rawId) {
  if (rawId == null) return;
  const s = String(rawId);
  if (s.length > CAPS.id) throw new Error(`entity id too long: ${s.length} chars (max ${CAPS.id}) — "${s.slice(0, 60)}..."`);
}

/** Cap body/aliases/relations on an already-normalized-or-merged entity. Called on the MERGED
 * entity in engine.remember() (after mergeEntity, before either write) so a merge that pushes a
 * combined body/observations — or a unioned alias/relation list — past the cap is caught too,
 * not just an oversized single remember() call. Throws loud naming the field, the size actually
 * seen, and the cap; never silently truncates. @param {Entity} e */
export function assertContentCaps(e) {
  const bodyLen = String(e.body || '').length;
  if (bodyLen > CAPS.body) throw new Error(`entity body too long: ${bodyLen} chars (max ${CAPS.body})`);
  const aliases = arr(e.aliases);
  if (aliases.length > CAPS.aliasCount) throw new Error(`too many aliases: ${aliases.length} (max ${CAPS.aliasCount})`);
  for (const a of aliases) {
    if (String(a).length > CAPS.aliasLen) throw new Error(`alias too long: ${String(a).length} chars (max ${CAPS.aliasLen}) — "${String(a).slice(0, 40)}..."`);
  }
  const relations = arr(e.relations);
  if (relations.length > CAPS.relationCount) throw new Error(`too many relations: ${relations.length} (max ${CAPS.relationCount})`);
  for (const r of relations) {
    if (String(r).length > CAPS.relationLen) throw new Error(`relation too long: ${String(r).length} chars (max ${CAPS.relationLen}) — "${String(r).slice(0, 40)}..."`);
  }
}

// --- merge / dedup (remember() on an existing id unions rather than clobbers) ---

/** Normalized key for observation-text dedup: trim, lowercase, collapse whitespace. Not stored —
 * comparison only. Exported so doctor.mjs reuses THIS definition for its duplicate-observation
 * check (the helper-reuse doctrine): the two normalizations must be the same function, not two
 * copies that could drift and make doctor flag "duplicates" the merge would not dedup (or miss
 * ones it would). */
export const normText = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Split a body into observation-ish units on the same boundaries the indexer chunks on
 * (## headings, else blank-line paragraphs) — good enough for dedup even though the indexer's
 * own chunkObservations() additionally packs by a max-char budget for embedding. @param {string} body */
export function splitObservations(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  const bySection = text.split(/\n(?=#{1,6}\s)/).map((s) => s.trim()).filter(Boolean);
  return bySection.length > 1 ? bySection : text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
}

/** Union two bodies' observations, deduping identical (normalized) text; existing order first. @param {string} oldBody @param {string} newBody */
export function mergeBodies(oldBody, newBody) {
  const oldUnits = splitObservations(oldBody);
  const seen = new Set(oldUnits.map(normText));
  const added = splitObservations(newBody).filter((u) => (seen.has(normText(u)) ? false : (seen.add(normText(u)), true)));
  return [...oldUnits, ...added].join('\n\n').trim();
}

/** Union two "verb|dst" relation lists, deduped by (verb, normalized-dst) so mixed-case dst
 * strings collapse to the same edge; keeps the first-seen literal for a stable frontmatter diff.
 * A malformed relation (no "verb|dst" shape, e.g. missing the pipe) is passed through UNCHANGED
 * rather than silently dropped — that would re-introduce the silent-drop the accuracy pass closed
 * elsewhere (see assertKnownVerbs in index/ingest.mjs). It reaches assertKnownVerbs via
 * engine.remember()'s pre-write validation and is rejected loudly there, naming the bad string. */
export function mergeRelations(oldRels, newRels) {
  const seen = new Set(); // `${verb}|${normalizedDst}`
  const out = [];
  for (const r of [...(oldRels || []), ...(newRels || [])]) {
    const [verb, dst] = String(r).split('|').map((s) => s && s.trim());
    if (!verb || !dst) { out.push(r); continue; } // malformed — do not drop; let assertKnownVerbs reject it loudly
    const key = `${verb}|${normalizeRelId(dst)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Union two alias lists, deduped by exact string (aliases are verbatim recall text, so no
 * case-folding — "GraphQL" and "graphql" are kept distinct on purpose). */
export function mergeAliases(oldAliases, newAliases) {
  const seen = new Set();
  const out = [];
  for (const a of [...(oldAliases || []), ...(newAliases || [])]) {
    if (a == null || a === '' || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * Merge a newly-normalized entity onto an existing one (remember() called again for the same
 * id): observations/relations/aliases UNION (deduped) rather than clobber; scalar fields
 * (confidence/observed_at/verify_against_code/negative) take the incoming value only when the
 * caller explicitly supplied it, so a partial re-remember doesn't wipe a previously-set fact.
 * @param {Entity} existing @param {Entity} incoming @returns {Entity}
 */
export function mergeEntity(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    body: mergeBodies(existing.body, incoming.body),
    relations: mergeRelations(existing.relations, incoming.relations),
    aliases: mergeAliases(existing.aliases, incoming.aliases),
    confidence: incoming.confidence ?? existing.confidence,
    observed_at: incoming.observed_at || existing.observed_at || undefined, // '' from a DB round-trip is "no value", not a real empty string
    verify_against_code: incoming.verify_against_code ?? existing.verify_against_code,
    negative: incoming.negative ?? existing.negative,
  };
}

// --- content hash (Lesson 3: incremental sync) ---
// A deterministic fingerprint of everything sync() needs to treat as "content": the frontmatter
// facts AND the body, INCLUDING updated_at. Excluding updated_at looks tempting (it's bumped on
// every remember() even when nothing else changed) but that bump only ever happens alongside a
// real remember()-driven write, which already reindexes immediately — by the time sync() next
// reads the file, the index already reflects that same updated_at, so the hash still matches and
// sync() still skips it. INCLUDING it is what makes a bare hand-edited updated_at (bypassing
// remember() entirely, e.g. a hand-fixed timestamp) force a reindex too, which is exactly what
// keeps decay/drift correct across sync() (see the "updated_at round-trips through sync" guarantee
// in engine.mjs). Excludes `path` (derived, not content). @param {Entity} e */
export function contentHash(e) {
  const canon = JSON.stringify({
    type: e.type, aliases: arr(e.aliases), confidence: e.confidence ?? null,
    observed_at: e.observed_at || '', verify_against_code: !!e.verify_against_code,
    negative: !!e.negative, relations: arr(e.relations), body: e.body || '',
    updated_at: e.updated_at || '',
  });
  return createHash('sha256').update(canon).digest('hex');
}

function assertInside(cfg, p) {
  const base = resolve(graphDir(cfg));
  const full = resolve(p);
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`entity path escapes the memory dir: ${p}`);
}

/** The on-disk path an entity lives at, path-safety-checked — WITHOUT writing anything. The one
 * place the memoryDir layout (`<type>/<slug>.md`) is computed: writeEntity()/readEntity() route
 * through it, and engine.remember() calls it directly to know (and validate) the path BEFORE the
 * index transaction runs — index-first write order: the markdown source of truth is only touched
 * after the index commit succeeds, so a mid-index failure can never leave the markdown mutated.
 * @param {object} cfg @param {{type:string, slug:string}} e @returns {string} */
export function entityPath(cfg, e) {
  const path = join(graphDir(cfg), e.type, `${e.slug}.md`);
  assertInside(cfg, path);
  return path;
}

/** Write an entity to disk. @param {object} cfg @param {Entity} e @returns {string} path */
export function writeEntity(cfg, e) {
  const path = entityPath(cfg, e);
  mkdirSync(dirname(path), { recursive: true });
  const fm = clean({
    id: e.id, type: e.type, confidence: e.confidence, observed_at: e.observed_at,
    'verify-against-code': e.verify_against_code ? true : undefined,
    negative: e.negative ? true : undefined,
    aliases: e.aliases, relations: e.relations, updated_at: e.updated_at,
  });
  writeFileSync(path, serializeFrontmatter(fm, e.body || ''));
  return path;
}

/** Read one entity file by id (or null). */
export function readEntity(cfg, id) {
  const { type, slug } = splitId(normalizeRelId(id));
  const path = entityPath(cfg, { type, slug });
  if (!existsSync(path)) return null;
  const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  return toEntity(data.id || id, data, body, path);
}

/** Read every entity from disk (recursive). @param {object} cfg @returns {Entity[]} */
export function readEntities(cfg) {
  const dir = graphDir(cfg);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith('.md'))
    .map((rel) => {
      const full = join(dir, String(rel));
      const { data, body } = parseFrontmatter(readFileSync(full, 'utf8'));
      const id = data.id || idFromRel(String(rel));
      return toEntity(id, data, body, full);
    });
}

function idFromRel(rel) {
  const parts = rel.replace(/\\/g, '/').replace(/\.md$/, '').split('/');
  const slug = parts.pop();
  const type = parts.pop() || 'fact';
  return makeId(type, slug);
}

function toEntity(id, data, body, path) {
  const { type, slug } = splitId(id);
  return {
    id, type, slug,
    aliases: arr(data.aliases), confidence: data.confidence, observed_at: data.observed_at,
    verify_against_code: !!data['verify-against-code'], negative: !!data.negative,
    relations: arr(data.relations),
    updated_at: data.updated_at, // writeEntity() persists this; round-trip it so decay + doctor's
    // "updated_at differs" drift check work across a sync (previously always empty post-sync).
    body, path,
  };
}

function clean(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && !v.length) continue;
    r[k] = v;
  }
  return r;
}
function arr(v) { return Array.isArray(v) ? v : v ? [v] : []; }

/** Decode the DB aliases column (JSON array; tolerates legacy CSV). */
export function parseAliases(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; }
  catch { return String(v).split(',').map((s) => s.trim()).filter(Boolean); }
}
