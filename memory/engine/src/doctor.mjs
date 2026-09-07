// rmem doctor — health-check the store. Read-only by default: reports findings + a summary
// count. `--fix` (opt-in) applies ONLY safe, deterministic fixes (dedup identical observations,
// drop truly orphan relations) and reports exactly what changed. Never touches confidence,
// never invents data, never fixes anything ambiguous (unknown vocab, drift direction) —
// those are reported for a human to resolve, per the "read-only unless asked" design in
// memory/engine/README.md.
import { ENTITY_TYPES, RELATION_VERBS } from './config.mjs';
import { readEntities, readEntity, splitObservations, parseAliases, normalizeRelId, normText } from './store.mjs';
import { effectiveTimestamp, decayFactor, STALE_FLAG_THRESHOLD } from './retrieve.mjs';
import { jaroWinkler, comparableLabel } from './similarity.mjs';

// Lesson 5: near-duplicate threshold — a Jaro-Winkler score at/above this on the normalized
// slug+aliases text is reported (flag-only, see nearDuplicates below).
const NEAR_DUP_THRESHOLD = 0.85;

// Relation dsts in these namespaces are DELIBERATELY not entities (memory/knowledge-graph.md): the
// `applies-to|skill:<name>` relation links a lesson/gotcha to the RespawnPack skill it informs, and
// `skill` is NOT an entity type — it names a skill. Such a dst can therefore never have a backing
// entity, so it must be EXEMPT from the orphan check below (and hence from `--fix`, which drops
// flagged orphans). Without this exemption every living-skill lesson link — the `lessonsFor()` feed
// that /skill-guard regenerates a skill's `## Learned` overlay from — is a false orphan that
// `rmem doctor --fix` silently deletes: data loss in the exact class the engine's accuracy work
// exists to close. (the graphify bind-layer design note (a development record), decision D-0NN+1, calls the `skill:` target
// "already a latent instance of this rough edge"; `code_refs` code coordinates are the other
// deliberate non-entity, but they ride a frontmatter passthrough field — never a relation — so the
// orphan check never sees them, per D-0NN+2's separate report-only rot check.)
const NON_ENTITY_REL_NAMESPACES = new Set(['skill']);
/** True when a NORMALIZED relation dst names a documented non-entity namespace (e.g. `skill:build`),
 * which is a valid, intentional edge target — not a dangling/orphan edge. */
function isNonEntityRelTarget(normalizedDst) {
  return NON_ENTITY_REL_NAMESPACES.has(String(normalizedDst).split(':')[0]);
}

/** The index's entities, shaped like readEntities() output, for checks that need SOME working
 * set even when there's no markdown source (persistFiles:false / dataDir:'memory:' — every
 * existing test uses this shape, and `rmem doctor` must be testable the same way). */
async function readIndexEntities(db) {
  const rows = (await db.query('SELECT * FROM entities')).rows;
  const relRows = (await db.query('SELECT src, rel, dst FROM relations')).rows;
  const relsBySrc = new Map();
  for (const r of relRows) { if (!relsBySrc.has(r.src)) relsBySrc.set(r.src, []); relsBySrc.get(r.src).push(`${r.rel}|${r.dst}`); }
  return rows.map((r) => ({
    id: r.id, type: r.type, slug: r.slug, aliases: parseAliases(r.aliases),
    confidence: r.confidence, observed_at: r.observed_at, updated_at: r.updated_at,
    verify_against_code: r.verify_against_code, negative: r.negative,
    relations: relsBySrc.get(r.id) || [], body: r.body, path: r.path,
  }));
}

/**
 * @typedef {Object} DoctorReport
 * @property {Array<{src:string, rel:string, dst:string}>} orphanRelations   relation dst has no entity (source OR index)
 * @property {Array<{id:string, type:string}>} unknownTypes                 markdown entity whose type isn't canonical
 * @property {Array<{id:string, verb:string, raw:string}>} unknownVerbs     markdown relation whose verb isn't canonical
 * @property {Array<{id:string, count:number}>} duplicateEntities           same id claimed by >1 markdown file
 * @property {Array<{id:string, text:string, count:number}>} duplicateObservations  repeated (normalized) observation text within one entity
 * @property {Array<{id:string, effectiveTimestamp:string, decay:number}>} staleEntries  old + low effective score
 * @property {Array<{id:string, issue:string}>} drift                      markdown source vs PGLite index disagree
 * @property {Array<{a:string, b:string, score:number}>} nearDuplicates    flag-only: same-type label/alias similarity >= threshold (never auto-fixed)
 * @property {{entities:number, orphanRelations:number, unknownTypes:number, unknownVerbs:number,
 *   duplicateEntities:number, duplicateObservations:number, staleEntries:number, drift:number,
 *   nearDuplicates:number}} summary
 */

/**
 * Run all read-only checks. Prefers the markdown SOURCE OF TRUTH (memory/graph/**\/*.md) for
 * everything; when there is no source on disk (index-only engines — `persistFiles:false` /
 * `dataDir:'memory:'`, the shape every other test in this repo uses), falls back to the index
 * itself for the checks that don't inherently require a second, independent copy to compare
 * against (drift and duplicate-file detection are skipped in that mode — there's nothing to
 * drift from). @param {object} cfg @param {import('@electric-sql/pglite').PGlite} db
 * @returns {Promise<DoctorReport>}
 */
export async function runDoctor(cfg, db) {
  const fileEnts = readEntities(cfg); // memory/graph/**/*.md — the source of truth, when present
  const hasSource = fileEnts.length > 0;
  const ents = hasSource ? fileEnts : await readIndexEntities(db);

  // --- duplicate entities: the same canonical id backed by >1 markdown file ---
  // (readEntities() derives id per-file; a collision means two files map to one id, e.g. a
  // stray copy or a case-variant filename on a case-insensitive filesystem. Only meaningful
  // against real files — an index has no such notion.)
  const byId = new Map();
  if (hasSource) for (const e of fileEnts) byId.set(e.id, (byId.get(e.id) || 0) + 1);
  const duplicateEntities = [...byId.entries()].filter(([, n]) => n > 1).map(([id, count]) => ({ id, count }));

  // --- unknown vocabulary present in the entity set ---
  const unknownTypes = ents.filter((e) => !ENTITY_TYPES.includes(e.type)).map((e) => ({ id: e.id, type: e.type }));
  const unknownVerbs = [];
  for (const e of ents) {
    for (const r of e.relations || []) {
      const [verb] = String(r).split('|').map((s) => s && s.trim());
      if (verb && !RELATION_VERBS.includes(verb)) unknownVerbs.push({ id: e.id, verb, raw: r });
    }
  }

  // --- duplicate observations within a single entity's body ---
  const duplicateObservations = [];
  for (const e of ents) {
    const units = splitObservations(e.body);
    const seen = new Map(); // normalized text -> count
    for (const u of units) { const k = normText(u); seen.set(k, (seen.get(k) || 0) + 1); }
    for (const [k, count] of seen) {
      if (count > 1) duplicateObservations.push({ id: e.id, text: units.find((u) => normText(u) === k), count });
    }
  }

  // --- orphan relations: dst has no entity in the working set ---
  // Compare NORMALIZED ids on both sides: entity ids are normalized (normalizeEntity()), and the
  // index normalizes every relation dst via normalizeRelId() (see index/ingest.mjs), so a
  // relation authored e.g. "depends-on|infra:Redis" must resolve against "infra:redis" — comparing
  // the raw, un-normalized dst string here would falsely flag a valid edge as orphan (and, worse,
  // `--fix` would then delete it). Dsts in a documented non-entity namespace (`skill:<name>`, the
  // `applies-to` target) are exempt entirely — they have no backing entity BY DESIGN, so flagging
  // them would let `--fix` delete every living-skill lesson link (see NON_ENTITY_REL_NAMESPACES).
  const entIds = new Set(ents.map((e) => e.id));
  const orphanRelations = [];
  for (const e of ents) {
    for (const r of e.relations || []) {
      const [verb, dst] = String(r).split('|').map((s) => s && s.trim());
      if (!verb || !dst) continue;
      const normDst = normalizeRelId(dst);
      if (isNonEntityRelTarget(normDst)) continue; // e.g. applies-to|skill:<name> — a non-entity by design, never an orphan
      if (!entIds.has(normDst)) orphanRelations.push({ src: e.id, rel: verb, dst: normDst });
    }
  }

  // --- stale entries: old + low effective score ---
  const staleEntries = ents
    .filter((e) => !e.negative) // a ⛔ removal is SUPPOSED to be permanent — staleness doesn't apply
    .map((e) => ({ id: e.id, effectiveTimestamp: effectiveTimestamp(e), decay: decayFactor(effectiveTimestamp(e)) }))
    .filter((r) => r.decay < STALE_FLAG_THRESHOLD);

  // --- index-vs-source drift: only meaningful when a real markdown source exists to drift from ---
  const drift = [];
  if (hasSource) {
    const idxRows = (await db.query('SELECT id, updated_at FROM entities')).rows;
    const idxById = new Map(idxRows.map((r) => [r.id, r.updated_at]));
    for (const e of fileEnts) {
      if (!idxById.has(e.id)) { drift.push({ id: e.id, issue: 'in markdown source but not indexed — run `rmem sync`' }); continue; }
      const idxUpdated = idxById.get(e.id) || '';
      if (e.updated_at && idxUpdated && e.updated_at !== idxUpdated) {
        drift.push({ id: e.id, issue: `updated_at differs (source ${e.updated_at} vs index ${idxUpdated}) — run \`rmem sync\`` });
      }
    }
    for (const [id] of idxById) {
      if (!entIds.has(id)) drift.push({ id, issue: 'indexed but no markdown file — run `rmem sync` to drop it' });
    }
  }

  // --- near-duplicates: flag-only pairwise similarity over normalized slug+aliases text ---
  // NEVER auto-merged (see fixDoctorIssues below — deliberately absent from it): two
  // similar-sounding entities in a hand-curated graph can be deliberately distinct (e.g. two
  // related-but-different gotchas), so this is a human-review signal, not a dedup action.
  // SAME-TYPE pairs only: a cross-type slug match (infra:redis + gotcha:redis) is the naming
  // convention working as intended, not a duplicate.
  // O(n^2) is fine at our scale (a few hundred entities, per the engine's own docs).
  const nearDuplicates = [];
  for (let i = 0; i < ents.length; i++) {
    const li = comparableLabel(ents[i]);
    for (let j = i + 1; j < ents.length; j++) {
      if (ents[i].id === ents[j].id) continue;
      if (ents[i].type !== ents[j].type) continue;
      const score = jaroWinkler(li, comparableLabel(ents[j]));
      if (score >= NEAR_DUP_THRESHOLD) nearDuplicates.push({ a: ents[i].id, b: ents[j].id, score: Number(score.toFixed(3)) });
    }
  }
  nearDuplicates.sort((x, y) => y.score - x.score);

  const summary = {
    entities: ents.length,
    orphanRelations: orphanRelations.length,
    unknownTypes: unknownTypes.length,
    unknownVerbs: unknownVerbs.length,
    duplicateEntities: duplicateEntities.length,
    duplicateObservations: duplicateObservations.length,
    staleEntries: staleEntries.length,
    drift: drift.length,
    nearDuplicates: nearDuplicates.length,
  };
  return { orphanRelations, unknownTypes, unknownVerbs, duplicateEntities, duplicateObservations, staleEntries, drift, nearDuplicates, summary };
}

/** Read the entity to fix from the markdown SOURCE OF TRUTH when a file exists for it, falling
 * back to the index (engine.get) only when there is no markdown (persistFiles:false /
 * dataDir:'memory:', the index-only mode every test in this repo also uses). `runDoctor` always
 * diagnoses from markdown when it's present (see hasSource in runDoctor above) — reading the fix
 * target from the index instead would, on index/markdown drift, regress the markdown file to
 * stale index content instead of correcting it. @param {object} engine @param {string} id */
async function readForFix(engine, id) {
  return (engine.cfg ? readEntity(engine.cfg, id) : null) || (await engine.get(id));
}

/**
 * Apply the safe, deterministic subset of fixes: dedup identical (normalized) observations in
 * an entity's body, and drop relation entries whose dst has no source entity. Both write the
 * FULL corrected entity back via `engine.remember(entity, { replace: true })` — `replace`
 * bypasses the normal union-merge (which would just resurrect the very duplicate/orphan being
 * removed) while still round-tripping every other field unchanged, so markdown + index stay in
 * sync. Ambiguous/judgment fixes (unknown vocab, drift direction, which duplicate entity file to
 * keep) are NEVER auto-applied — they're left in the report for a human.
 * @param {object} engine @param {DoctorReport} report
 * @returns {Promise<{dedupedEntities:string[], droppedRelations:Array<{src:string,rel:string,dst:string}>}>}
 */
export async function fixDoctorIssues(engine, report) {
  const dedupedEntities = [];
  for (const id of new Set(report.duplicateObservations.map((d) => d.id))) {
    const e = await readForFix(engine, id);
    if (!e) continue;
    const units = splitObservations(e.body);
    const seen = new Set();
    const deduped = units.filter((u) => (seen.has(normText(u)) ? false : (seen.add(normText(u)), true))).join('\n\n').trim();
    if (deduped !== (e.body || '').trim()) {
      await engine.remember({ ...e, body: deduped }, { replace: true });
      dedupedEntities.push(id);
    }
  }

  const droppedRelations = [];
  const orphansBySrc = new Map();
  for (const o of report.orphanRelations) {
    if (!orphansBySrc.has(o.src)) orphansBySrc.set(o.src, []);
    orphansBySrc.get(o.src).push(o);
  }
  for (const [src, orphans] of orphansBySrc) {
    const e = await readForFix(engine, src);
    if (!e) continue;
    // report.orphanRelations carries NORMALIZED dsts (see runDoctor above) — normalize the
    // entity's own relation dst the same way before comparing, or a mixed-case relation here
    // would never match its own orphan record and a truly-orphan edge would survive --fix.
    const orphanRaw = new Set(orphans.map((o) => `${o.rel}|${o.dst}`));
    const kept = (e.relations || []).filter((r) => {
      const [verb, dst] = String(r).split('|').map((s) => s && s.trim());
      const normDst = normalizeRelId(dst);
      // Defense-in-depth at the destructive site: never drop an edge into a documented non-entity
      // namespace (skill:<name>). runDoctor already omits these from orphanRelations, so this can't
      // normally fire — but this is the exact delete that the orphan-check exemption exists to
      // prevent, so guard it here too rather than trust every future report producer.
      if (isNonEntityRelTarget(normDst)) return true;
      return !orphanRaw.has(`${verb}|${normDst}`);
    });
    if (kept.length !== (e.relations || []).length) {
      await engine.remember({ ...e, relations: kept }, { replace: true });
      for (const o of orphans) droppedRelations.push(o);
    }
  }

  return { dedupedEntities, droppedRelations };
}
