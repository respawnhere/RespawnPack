// Regression tests for the adversarial-review fixes (blockers + majors + key minors).
import { createEngine } from '../src/engine.mjs';
import { normalizeEntity } from '../src/store.mjs';
import { parseFrontmatter } from '../src/frontmatter.mjs';
import { resolve, sep } from 'node:path';
import { rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const threw = async (fn) => { try { await fn(); return false; } catch { return true; } };

// 1. BLOCKER: relation ids normalized at both ends -> graph recall works for mixed-case ids.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:Redis-TLS', body: 'Redis handshake fails; use rediss scheme.', relations: ['fixed-by|decision:Use-Rediss'] });
  await m.remember({ id: 'decision:Use-Rediss', body: 'Standardize on rediss for managed Redis.' });
  const rec = await m.recall('redis handshake fails', { k: 1, expand: 1 });
  ok(rec.related.some((r) => r.id === 'decision:use-rediss'), 'mixed-case relation resolves (no dangling edge)');
  await m.close();
}

// 2. BLOCKER: path traversal — a crafted type/id cannot escape memory/graph.
{
  const root = '/tmp/rmem-fix-pt'; rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  const e = await m.remember({ id: '../../../../etc:pwn', body: 'malicious' });
  const base = resolve(root, 'memory/graph');
  ok(resolve(e.path).startsWith(base + sep), 'crafted id stays inside memory/graph (' + e.type + ':' + e.slug + ')');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// 3. MAJOR: unknown relation verbs are REJECTED LOUDLY (never silently dropped — closed in the
// accuracy pass; used to be `if (!VERBS.has(verb)) continue;`). remember() throws naming the
// bad verb + the allowed set, and nothing from the call is persisted (no partial entity).
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  let err;
  try { await m.remember({ id: 'gotcha:x', body: 'x', relations: ['fixed-by|decision:y', 'bogus-verb|decision:z'] }); }
  catch (e) { err = e; }
  ok(!!err && /bogus-verb/.test(err.message) && /depends-on/.test(err.message), 'unknown relation verb throws naming the bad verb + the allowed vocabulary');
  ok((await m.get('gotcha:x')) === null, 'the entity is not partially persisted when a relation verb is rejected');
  await m.close();
}

// 4. MAJOR: malformed embedding is rejected with a clear error, not silent corruption.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  m.embedder.embed = async (texts) => texts.map(() => [Number.NaN, 1, 2].concat(new Array(m.dim - 3).fill(0)));
  ok(await threw(() => m.remember({ id: 'gotcha:bad', body: 'bad vector' })), 'NaN in an embedding throws (not silently ingested)');
  await m.close();
}

// 5. MAJOR: sync is atomic — an embed failure mid-rebuild leaves the prior index intact.
// Sync is now INCREMENTAL (Lesson 3: skips re-embedding entities whose content hash is
// unchanged) — so for the failure injection to actually reach the embedder mid-sync, the
// on-disk markdown must genuinely differ from what's indexed. Hand-edit both files directly
// (bypassing remember(), which would just re-sync them immediately) so both are due to reindex.
{
  const root = '/tmp/rmem-fix-sync'; rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  await m.remember({ id: 'gotcha:one', body: 'alpha one' });
  await m.remember({ id: 'gotcha:two', body: 'beta two' });
  const before = await m.count();
  const pOne = resolve(root, 'memory/graph/gotcha/one.md');
  const pTwo = resolve(root, 'memory/graph/gotcha/two.md');
  writeFileSync(pOne, readFileSync(pOne, 'utf8').replace('alpha one', 'alpha one CHANGED'));
  writeFileSync(pTwo, readFileSync(pTwo, 'utf8').replace('beta two', 'beta two CHANGED'));
  const realEmbed = m.embedder.embed.bind(m.embedder);
  let n = 0;
  m.embedder.embed = async (t) => { if (++n >= 2) throw new Error('embeddings outage'); return realEmbed(t); }; // fail reindexing the 2nd changed entity
  ok(await threw(() => m.sync()), 'sync throws on a mid-rebuild embed failure');
  m.embedder.embed = realEmbed;
  ok((await m.count()) === before, 'index is intact after the failed sync (rolled back)');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// 6. MAJOR: non-ASCII titles get a non-empty, unique slug (no 'type:' collision).
{
  const a = normalizeEntity({ type: 'gotcha', title: '日本語' });
  const b = normalizeEntity({ type: 'gotcha', title: '中文' });
  ok(a.slug && a.id !== 'gotcha:' && a.id !== b.id, 'unicode titles get distinct non-empty ids');
}

// 7. MAJOR: an alias containing a comma round-trips intact.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'infra:x', body: 'x', aliases: ['hello, world', 'foo'] });
  const e = await m.get('infra:x');
  ok(e.aliases.length === 2 && e.aliases[0] === 'hello, world', 'comma-containing alias survives storage');
  const fm = parseFrontmatter('---\naliases: ["a, b", c]\n---\nbody');
  ok(fm.data.aliases.length === 2 && fm.data.aliases[0] === 'a, b', 'frontmatter quote-aware list parse');
  await m.close();
}

// 8. MINOR: multi-hop recall reaches the 2nd hop with expand:2.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:a', body: 'alpha seed', relations: ['relates-to|gotcha:b'] });
  await m.remember({ id: 'gotcha:b', body: 'bravo middle', relations: ['relates-to|gotcha:c'] });
  await m.remember({ id: 'gotcha:c', body: 'charlie far' });
  const r1 = await m.recall('alpha seed', { k: 1, expand: 1 });
  const r2 = await m.recall('alpha seed', { k: 1, expand: 2 });
  ok(!r1.related.some((x) => x.id === 'gotcha:c') && r2.related.some((x) => x.id === 'gotcha:c'), 'expand:2 reaches a 2nd-hop neighbor that expand:1 does not');
  await m.close();
}

// 9. MINOR: config paths that escape the root are rejected.
{
  ok(await threw(() => createEngine({ root: '/tmp/x', dataDir: '../../escape' })), 'escaping dataDir is rejected');
  ok(await threw(() => createEngine({ root: '/tmp/x', memoryDir: '/abs/outside' })), 'absolute memoryDir is rejected');
}

// --- accuracy pass (4 items): vocab enforcement, merge/dedup, staleness decay, rmem doctor ---

// 10. VOCAB: an unknown entity TYPE is never silently dropped. Unlike a relation verb (pure
// structured input -> hard reject), a raw `type:slug` id can be hostile/malformed and
// path-safety already neutralizes it, so the design here is permissive-with-a-loud-warning: the
// entity IS written and retrievable (nothing lost) but carries a `vocab_warning` naming the bad
// type + the allowed set, and remember() console.warns it too.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  const e = await m.remember({ id: 'oddtype:thing', body: 'an entity with a non-canonical type' });
  console.warn = realWarn;
  ok(e.vocab_warning && /oddtype/.test(e.vocab_warning) && /gotcha/.test(e.vocab_warning), 'unknown entity type is surfaced as a warning naming the bad value + the allowed set');
  ok(warnings.some((w) => /oddtype/.test(w)), 'the vocab warning is also logged loudly (console.warn), not just returned');
  const fetched = await m.get('oddtype:thing');
  ok(fetched && fetched.body.includes('non-canonical type'), 'the entity is NOT silently dropped — it is written and retrievable');
  await m.close();
}

// 11. VOCAB: a canonical entity type produces no warning.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  const e = await m.remember({ id: 'gotcha:fine', body: 'ordinary gotcha' });
  ok(!e.vocab_warning, 'a canonical entity type carries no vocab_warning');
  await m.close();
}

// 12. MERGE: re-remember()ing an existing id with a NEW observation yields one entity with BOTH
// observations (no duplicate entity, no lost prior fact).
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:merge-me', confidence: 0.8, body: '## Symptom\nThing breaks.' });
  await m.remember({ id: 'gotcha:merge-me', body: '## Fix\nDo the other thing.' });
  ok((await m.count()) === 1, 'remember() on an existing id does not create a second entity');
  const e = await m.get('gotcha:merge-me');
  ok(e.body.includes('Thing breaks') && e.body.includes('Do the other thing'), 'the merged entity carries BOTH observations');
  ok(e.confidence === 0.8, 'a scalar field not resupplied on the 2nd remember() is preserved, not wiped');
  await m.close();
}

// 13. MERGE: re-adding an IDENTICAL (normalized) observation is a no-op — no duplicate text.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:no-dupe', body: '## Symptom\nSame thing every time.' });
  await m.remember({ id: 'gotcha:no-dupe', body: '## Symptom\nSame thing every time.' }); // identical text, re-sent
  await m.remember({ id: 'gotcha:no-dupe', body: '##  Symptom \n  same thing   every time.  ' }); // whitespace/case variant of the SAME text
  const e = await m.get('gotcha:no-dupe');
  const occurrences = (e.body.match(/same thing every time/gi) || []).length;
  ok(occurrences === 1, 're-adding an identical (or whitespace/case-variant) observation is a no-op — no duplicate text');
  await m.close();
}

// 14. MERGE: relations and aliases UNION (deduped) across remember() calls, not just observations.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:union-me', body: 'x', aliases: ['alpha'], relations: ['relates-to|infra:one'] });
  await m.remember({ id: 'gotcha:union-me', body: 'x more', aliases: ['alpha', 'beta'], relations: ['relates-to|infra:one', 'depends-on|infra:two'] });
  const e = await m.get('gotcha:union-me');
  ok(e.aliases.length === 2 && e.aliases.includes('alpha') && e.aliases.includes('beta'), 'aliases union across remember() calls, deduped');
  ok(e.relations.length === 2, 'relations union across remember() calls, deduped (the repeated relates-to|infra:one is not doubled)');
  await m.close();
}

// 15. MERGE + addObservation: extending still works and is itself dedup-safe now that it routes
// through remember()'s merge instead of doing its own body concatenation.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:add-obs', body: '## Symptom\nOriginal fact.' });
  await m.addObservation('gotcha:add-obs', '## Detail\nA genuinely new fact.');
  await m.addObservation('gotcha:add-obs', '## Symptom\nOriginal fact.'); // re-add the SAME original text via addObservation
  const e = await m.get('gotcha:add-obs');
  ok((e.body.match(/Original fact\./g) || []).length === 1, 'addObservation is itself a no-op when the text is already present');
  ok(e.body.includes('A genuinely new fact'), 'addObservation still extends with genuinely new text');
  await m.close();
}

// 16. STALENESS: a fresher observation/entity outranks an otherwise-equal stale one at query time.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  const now = new Date();
  const longAgo = new Date(now.getTime() - 400 * 86400000).toISOString(); // ~4.4 half-lives ago
  const fresh = now.toISOString();
  // Same wording (so hybrid relevance ties) — only the effective timestamp differs.
  await m.remember({ id: 'gotcha:stale-one', observed_at: longAgo, body: 'widget frobnicator raises a timeout error' });
  await m.remember({ id: 'gotcha:fresh-one', observed_at: fresh, body: 'widget frobnicator raises a timeout error' });
  const hits = await m.query('widget frobnicator timeout error', { k: 2 });
  ok(hits[0]?.id === 'gotcha:fresh-one', 'the fresher entity outranks the equally-relevant stale one');
  const staleHit = hits.find((h) => h.id === 'gotcha:stale-one');
  ok(staleHit && staleHit.decay < hits.find((h) => h.id === 'gotcha:fresh-one').decay, 'the stale entity carries a lower decay factor than the fresh one');
  ok(staleHit && staleHit.stale === true && /possibly stale/.test(staleHit.caveat || ''), 'a sufficiently old entity is flagged possibly-stale with a caveat');
  await m.close();
}

// 17. STALENESS: decay does not mutate stored confidence — it's a read-time-only computed field.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  const longAgo = new Date(Date.now() - 400 * 86400000).toISOString();
  await m.remember({ id: 'gotcha:confidence-untouched', confidence: 0.95, observed_at: longAgo, body: 'an old but still-recorded-as-confident fact' });
  const e = await m.get('gotcha:confidence-untouched');
  ok(e.confidence === 0.95, 'stored confidence is never destructively decayed');
  await m.close();
}

// 18. DOCTOR: detects a seeded orphan relation (dst has no entity) and a seeded duplicate
// observation, read-only by default (findings reported, nothing mutated).
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:has-orphan', body: 'the source fact', relations: ['fixed-by|decision:never-remembered'] });
  await m.remember({ id: 'gotcha:has-dupe', body: '## Note\nRepeat me.\n\n## Note\nRepeat me.' });
  const report = await m.doctor();
  ok(report.orphanRelations.some((o) => o.src === 'gotcha:has-orphan' && o.dst === 'decision:never-remembered'), 'doctor detects the seeded orphan relation');
  ok(report.duplicateObservations.some((d) => d.id === 'gotcha:has-dupe'), 'doctor detects the seeded duplicate observation');
  ok(report.summary.orphanRelations >= 1 && report.summary.duplicateObservations >= 1, 'the summary counts reflect both findings');
  ok(!report.applied, 'doctor is read-only by default (no `applied` section without --fix)');
  const stillThere = await m.get('gotcha:has-orphan');
  ok(stillThere && stillThere.relations.some((r) => r.includes('never-remembered')), 'read-only doctor does not mutate the orphan relation');
  await m.close();
}

// 19. DOCTOR --fix: applies only the safe, deterministic fixes and reports exactly what changed.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:fix-orphan', body: 'x', relations: ['fixed-by|decision:ghost', 'relates-to|infra:real'] });
  await m.remember({ id: 'infra:real', body: 'a real entity so this relation is NOT an orphan' });
  await m.remember({ id: 'gotcha:fix-dupe', body: '## A\nSame text.\n\n## A\nSame text.\n\n## B\nDistinct text.' });
  const fixed = await m.doctor({ fix: true });
  ok(fixed.applied.droppedRelations.some((o) => o.src === 'gotcha:fix-orphan' && o.dst === 'decision:ghost'), '--fix drops the truly orphan relation');
  ok(fixed.applied.dedupedEntities.includes('gotcha:fix-dupe'), '--fix dedupes the duplicate observation');
  const orphanFixed = await m.get('gotcha:fix-orphan');
  ok(!orphanFixed.relations.some((r) => r.includes('ghost')) && orphanFixed.relations.some((r) => r.includes('infra:real')), 'the orphan edge is gone but the valid edge survives --fix');
  const dupeFixed = await m.get('gotcha:fix-dupe');
  ok((dupeFixed.body.match(/Same text\./g) || []).length === 1 && dupeFixed.body.includes('Distinct text'), '--fix removes the duplicate but keeps distinct content');
  const reReport = await m.doctor();
  ok(reReport.summary.orphanRelations === 0 && reReport.summary.duplicateObservations === 0, 'a second doctor run after --fix reports the issues resolved');
  await m.close();
}

// --- adversarial-review pass 2: doctor normalization, --fix source-of-truth, merge-before-write,
// negative-exempt decay, malformed-relation no-silent-drop, updated_at round-trip, sync vocab warn ---

// 20. BLOCKER FIX 1: doctor must normalize BOTH sides of the orphan-relation existence check
// (entity ids are normalized; the index normalizes relation dsts via normalizeRelId — comparing
// the raw dst string false-flags a valid mixed-case edge as orphan, and --fix would delete it).
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'infra:redis', body: 'the real infra entity, lowercase canonical id' });
  await m.remember({ id: 'gotcha:mixed-case-dst', body: 'x', relations: ['depends-on|infra:Redis'] }); // mixed-case dst
  const report = await m.doctor();
  ok(report.summary.orphanRelations === 0, 'a mixed-case relation dst that resolves to a real (normalized) entity is NOT flagged orphan');
  ok(!report.orphanRelations.some((o) => o.src === 'gotcha:mixed-case-dst'), 'the mixed-case edge does not appear in the orphan list at all');
  const fixed = await m.doctor({ fix: true });
  ok(fixed.applied.droppedRelations.length === 0, '--fix drops nothing — there was no real orphan');
  const e = await m.get('gotcha:mixed-case-dst');
  ok(e.relations.some((r) => r.includes('depends-on') && /infra:redis/i.test(r)), '--fix KEEPS the valid mixed-case edge (no data loss)');
  await m.close();
}

// 21. BLOCKER FIX 2: --fix must diagnose AND fix from the markdown source of truth, not the
// index — on index/markdown drift, fixing from the index would regress markdown to stale content.
{
  const root = resolve('/tmp/rmem-fix-drift'); rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  // A safe, unrelated fix target (a genuine duplicate observation) so --fix has real work to do.
  await m.remember({ id: 'gotcha:safe-fix-target', body: '## A\nSame text.\n\n## A\nSame text.' });
  // The entity we'll drift: remember it, then hand-edit its ON-DISK markdown body WITHOUT
  // reindexing, so the index still holds the OLD body and the markdown file holds NEW content.
  await m.remember({ id: 'gotcha:drifted', body: '## Original\nOriginal index-held content.' });
  const path = resolve(root, 'memory/graph/gotcha/drifted.md');
  const original = readFileSync(path, 'utf8');
  const driftedMarkdown = original.replace('Original index-held content.', 'NEW markdown-only content — the index does not know about this.');
  writeFileSync(path, driftedMarkdown);
  ok(driftedMarkdown !== original, 'sanity: the on-disk markdown body was actually changed independent of the index');

  await m.doctor({ fix: true }); // fixes the unrelated dupe; must not touch gotcha:drifted's content
  const afterFix = readFileSync(path, 'utf8');
  ok(afterFix.includes('NEW markdown-only content'), "the drifted entity's markdown body is NOT overwritten with stale index content by an unrelated --fix");
  ok(!afterFix.includes('Original index-held content.') || afterFix.includes('NEW markdown-only content'), 'the stale index body was not written back over the markdown source');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// 22. BLOCKER FIX 3: remember() must validate relation verbs on the MERGED entity BEFORE the
// disk write — re-remember()ing an existing entity with a bad verb must throw AND leave the
// on-disk markdown completely untouched (no bad relation, no merged body persisted).
{
  const root = resolve('/tmp/rmem-fix-merge-validate'); rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  await m.remember({ id: 'gotcha:merge-validate', body: '## Original\nOriginal valid content.', relations: ['relates-to|infra:one'] });
  const path = resolve(root, 'memory/graph/gotcha/merge-validate.md');
  const before = readFileSync(path, 'utf8');

  let err;
  try { await m.remember({ id: 'gotcha:merge-validate', body: '## Extra\nThis must never be persisted.', relations: ['bogus-verb|x:y'] }); }
  catch (e) { err = e; }
  ok(!!err && /bogus-verb/.test(err.message), 're-remember() with a bad relation verb on the MERGE path throws naming the bad verb');

  const after = readFileSync(path, 'utf8');
  ok(after === before, 'the on-disk markdown is byte-for-byte UNCHANGED after a rejected merge (no bad relation, no merged body leaked to disk)');
  ok(!after.includes('This must never be persisted'), 'the rejected new observation text never reached disk');
  ok(!after.includes('bogus-verb'), 'the rejected relation never reached disk');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// 23. BLOCKER FIX 4: a negative (⛔ spine-removal) entity must not decay out of ranking — an aged
// negative competing against a fresher non-negative of similar text must still surface in a
// small-k query (doctor.mjs already exempts `negative` from its stale report; carry that into search()).
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  const longAgo = new Date(Date.now() - 400 * 86400000).toISOString(); // ~4.4 half-lives ago
  const fresh = new Date().toISOString();
  await m.remember({ id: 'decision:old-removal', negative: true, confidence: 1, observed_at: longAgo, body: 'the legacy widget exporter was permanently removed and must not return' });
  await m.remember({ id: 'gotcha:fresh-competitor', observed_at: fresh, body: 'the legacy widget exporter permanently removed must not return' });
  const hits = await m.query('legacy widget exporter permanently removed must not return', { k: 2 });
  ok(hits.some((h) => h.id === 'decision:old-removal'), 'the aged negative entity is still returned in a small-k query, not decayed out');
  const neg = hits.find((h) => h.id === 'decision:old-removal');
  ok(neg && neg.decay === 1, 'a negative entity carries decay=1 (no age penalty applied)');
  ok(neg && /⛔/.test(neg.caveat || ''), 'the negative entity still surfaces its ⛔ do-not-reintroduce caveat');
  await m.close();
}

// 24. MAJOR FIX 5: mergeRelations must NOT silently drop a malformed relation (no "verb|dst"
// shape) — it must reach assertKnownVerbs and throw, naming the bad string, not vanish quietly.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:malformed-rel', body: 'x' });
  let err;
  try { await m.remember({ id: 'gotcha:malformed-rel', body: 'x more', relations: ['not-pipe-delimited'] }); }
  catch (e) { err = e; }
  ok(!!err, 're-remember() with a malformed (non "verb|dst") relation throws — it is not silently dropped by mergeRelations');
  ok(err && /not-pipe-delimited/.test(err.message), 'the error names the malformed relation string');
  await m.close();
}

// 25. MAJOR FIX 6: toEntity() must read updated_at back from frontmatter, so decay and drift
// detection reflect the true age across a sync (previously always empty post-sync -> decay reset
// to neutral, and doctor's "updated_at differs" branch was dead).
{
  const root = resolve('/tmp/rmem-fix-updated-at'); rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  await m.remember({ id: 'gotcha:old-timestamp', body: 'a fact recorded a long time ago' });
  const path = resolve(root, 'memory/graph/gotcha/old-timestamp.md');
  const raw = readFileSync(path, 'utf8');
  const longAgo = new Date(Date.now() - 400 * 86400000).toISOString(); // ~4.4 half-lives ago
  writeFileSync(path, raw.replace(/updated_at: .*/, `updated_at: ${longAgo}`)); // backdate on disk, bypassing remember()

  await m.sync();
  const e = await m.get('gotcha:old-timestamp');
  ok(e.updated_at === longAgo, "sync() round-trips the backdated updated_at from frontmatter into the index (toEntity() now reads it back)");

  // Confirm the round-tripped timestamp actually DRIVES decay (not just stored inertly): a fresh
  // competitor with the same wording should now outrank it, exactly like the observed_at staleness test.
  await m.remember({ id: 'gotcha:fresh-timestamp', body: 'a fact recorded a long time ago' });
  const hits = await m.query('a fact recorded a long time ago', { k: 2 });
  const old = hits.find((h) => h.id === 'gotcha:old-timestamp');
  const freshHit = hits.find((h) => h.id === 'gotcha:fresh-timestamp');
  ok(old && freshHit && old.decay < freshHit.decay, "the synced-back updated_at is NOT reset to fresh — it still carries the old entity's true decay");
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// 26. MINOR FIX 7: sync() must run the same entity-type vocab check every other write entrypoint
// runs, so a non-canonical type sitting in a markdown file surfaces a vocab_warning (collected +
// console.warn'd), not silently indexed with no warning at all.
{
  const root = resolve('/tmp/rmem-fix-sync-vocab'); rmSync(root, { recursive: true, force: true });
  mkdirSync(resolve(root, 'memory/graph/oddtype'), { recursive: true });
  writeFileSync(resolve(root, 'memory/graph/oddtype/thing.md'),
    '---\nid: oddtype:thing\ntype: oddtype\n---\n\nAn entity hand-written with a non-canonical type, never passed through remember().\n');

  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  const n = await m.sync();
  console.warn = realWarn;

  ok(n.total === 1 && n.changed === 1, 'sync() indexes the off-vocab-type entity — it is not dropped');
  ok(warnings.some((w) => /oddtype/.test(w) && /gotcha/.test(w)), 'sync() surfaces a vocab_warning (console.warn) for the non-canonical type, naming it + the allowed set');
  const e = await m.get('oddtype:thing');
  ok(e && e.type === 'oddtype', 'the off-vocab entity is indexed and retrievable exactly as authored');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// 27. DATA-LOSS FIX: the `applies-to|skill:<name>` relation dst is DELIBERATELY not an entity
// (memory/knowledge-graph.md: `skill` names a RespawnPack skill, not an entity type). doctor must
// NOT flag it as an orphan and `--fix` must NOT drop it — otherwise every living-skill lesson link
// (the lessonsFor() feed /skill-guard rebuilds a skill's `## Learned` overlay from) is a false
// orphan that `rmem doctor --fix` silently deletes. A genuinely orphaned dst in a real namespace
// (no backing entity) must still be flagged AND dropped, so the exemption is surgical, not blanket.
// The src carries BOTH a skill link and a real orphan, so --fix processes the entity and we prove
// it removes only the orphan while the skill link survives.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:skill-linked', confidence: 0.9, body: 'a lesson that informs a skill', relations: ['applies-to|skill:build', 'relates-to|infra:gone'] });

  const report = await m.doctor();
  ok(!report.orphanRelations.some((o) => o.dst === 'skill:build'), 'the applies-to|skill: link is NOT flagged an orphan (skill: is a documented non-entity namespace)');
  ok(report.orphanRelations.some((o) => o.src === 'gotcha:skill-linked' && o.dst === 'infra:gone'), 'a genuinely orphaned relation (no backing entity, real namespace) is still flagged');
  ok(report.summary.orphanRelations === 1, 'the summary counts only the real orphan, not the skill link');

  const fixed = await m.doctor({ fix: true });
  ok(fixed.applied.droppedRelations.some((o) => o.dst === 'infra:gone'), '--fix drops the genuine orphan edge');
  ok(!fixed.applied.droppedRelations.some((o) => o.dst === 'skill:build'), '--fix does NOT drop the skill link');
  const e = await m.get('gotcha:skill-linked');
  ok(e.relations.some((r) => r.includes('applies-to') && r.includes('skill:build')), 'the applies-to|skill: link SURVIVES --fix (no data loss)');
  ok(!e.relations.some((r) => r.includes('infra:gone')), 'the genuine orphan edge is gone after --fix');
  const ls = await m.lessonsFor('build');
  ok(ls.some((l) => l.id === 'gotcha:skill-linked'), 'lessonsFor still feeds the skill-linked lesson after --fix (the living-skill overlay source is intact)');
  await m.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
