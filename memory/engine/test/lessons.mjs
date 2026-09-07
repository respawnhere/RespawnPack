// Regression tests for the 6 Graphify-evaluation engine lessons (see
// the dogfood reports and the graphify evaluation, development records, for the source evaluation): query logging, outcome feedback,
// incremental sync, caps in the engine core, near-duplicate detection, and the freshness hook.
import { createEngine } from '../src/engine.mjs';
import { logQuery, readQueryLog, queryLogEnabled } from '../src/querylog.mjs';
import { installHooks, uninstallHooks, statusHooks, resolveRepoRoot, MARKER } from '../src/hook.mjs';
import { CAPS, normText } from '../src/store.mjs';
import { resolve } from 'node:path';
import { rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const threw = async (fn) => { try { await fn(); return false; } catch { return true; } };

// ============================================================================
// Lesson 1: query logging
// ============================================================================

{
  const root = resolve('/tmp/rmem-lesson-querylog'); rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory/.index', memoryDir: 'memory/graph' });
  await m.remember({ id: 'gotcha:log-me', body: 'a fact worth logging' });
  await m.query('a fact worth logging');
  await m.recall('a fact worth logging', { k: 1 });
  const logPath = resolve(root, 'memory/.index/query-log.jsonl');
  ok(existsSync(logPath), 'query() and recall() write query-log.jsonl under dataDir');
  const entries = readQueryLog(m.cfg);
  ok(entries.length === 2, 'both the query() and the recall() call are logged');
  const searchEntry = entries.find((e) => e.kind === 'search');
  const recallEntry = entries.find((e) => e.kind === 'recall');
  ok(searchEntry && searchEntry.query === 'a fact worth logging' && Array.isArray(searchEntry.hit_ids) && searchEntry.hit_ids.includes('gotcha:log-me'), 'the search entry carries {kind, query, hit_ids}');
  ok(recallEntry && typeof recallEntry.duration_ms === 'number' && recallEntry.duration_ms >= 0, 'the recall entry carries a duration_ms');
  ok(searchEntry && typeof searchEntry.ts === 'string' && !Number.isNaN(Date.parse(searchEntry.ts)), 'each entry carries a parseable ts');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

{
  const root = resolve('/tmp/rmem-lesson-querylog-off'); rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory/.index', memoryDir: 'memory/graph', queryLog: false });
  await m.remember({ id: 'gotcha:no-log', body: 'should not be logged' });
  await m.query('should not be logged');
  ok(!existsSync(resolve(root, 'memory/.index/query-log.jsonl')), 'the queryLog:false config toggle suppresses the log file entirely');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

{
  const root = resolve('/tmp/rmem-lesson-querylog-env'); rmSync(root, { recursive: true, force: true });
  process.env.RESPAWN_MEMORY_QUERY_LOG = '0';
  const m = await createEngine({ root, dataDir: 'memory/.index', memoryDir: 'memory/graph' });
  await m.remember({ id: 'gotcha:no-log-env', body: 'should not be logged either' });
  await m.query('should not be logged either');
  ok(!existsSync(resolve(root, 'memory/.index/query-log.jsonl')), 'RESPAWN_MEMORY_QUERY_LOG=0 suppresses the log file');
  delete process.env.RESPAWN_MEMORY_QUERY_LOG;
  await m.close(); rmSync(root, { recursive: true, force: true });
}

{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  ok(queryLogEnabled(m.cfg) === false, 'queryLogEnabled() is false for the ephemeral "memory:" dataDir (nothing to log into)');
  await m.remember({ id: 'gotcha:ephemeral', body: 'ephemeral index' });
  const hits = await m.query('ephemeral index');
  ok(hits.length === 1, 'query() still works normally when logging is a no-op for an ephemeral dataDir');
  await m.close();
}

{
  // logQuery() must NEVER throw into a query, even on a genuinely bad path (invalid Windows path chars).
  const badCfg = { root: resolve('/tmp'), dataDir: 'con|bad*dir', queryLog: true };
  let threwErr = false;
  try { logQuery(badCfg, { kind: 'search', query: 'x', k: 1, hit_ids: [], duration_ms: 0 }); } catch { threwErr = true; }
  ok(!threwErr, 'logQuery() swallows a write failure (fail-silent) instead of throwing');
}

// ============================================================================
// Lesson 2: outcome feedback
// ============================================================================

{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:feedback-useful', confidence: 0.6, observed_at: new Date(Date.now() - 400 * 86400000).toISOString(), body: 'an old fact' });
  const before = await m.get('gotcha:feedback-useful');
  const after = await m.feedback('gotcha:feedback-useful', 'useful');
  ok(after.confidence > before.confidence && after.confidence <= 1.0, 'feedback("useful") nudges confidence up (+0.05), capped at 1.0');
  ok(new Date(after.observed_at).getTime() > new Date(before.observed_at).getTime(), 'feedback("useful") refreshes observed_at to now');
  ok(after.body === before.body, 'feedback("useful") adds NO new observation/frontmatter field — body is unchanged');
  for (let i = 0; i < 20; i++) await m.feedback('gotcha:feedback-useful', 'useful');
  const capped = await m.get('gotcha:feedback-useful');
  ok(capped.confidence === 1.0, 'repeated feedback("useful") caps confidence at 1.0, never exceeds');
  await m.close();
}

{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:feedback-wrong', confidence: 0.8, body: 'a fact that turns out wrong' });
  ok(await threw(() => m.feedback('gotcha:feedback-wrong', 'wrong')), 'feedback("wrong") without a note throws');
  ok(await threw(() => m.feedback('gotcha:feedback-wrong', 'wrong', '   ')), 'feedback("wrong") with a blank note throws');
  const after = await m.feedback('gotcha:feedback-wrong', 'wrong', 'the fix described here no longer applies');
  ok(after.body.includes('## Correction') && after.body.includes('no longer applies'), 'feedback("wrong") appends a ## Correction observation');
  ok(after.confidence < 0.8, 'feedback("wrong") reduces confidence (-0.2)');
  ok(after.body.includes('a fact that turns out wrong'), 'the ORIGINAL observation is preserved — merge, not overwrite');
  for (let i = 0; i < 20; i++) await m.feedback('gotcha:feedback-wrong', 'wrong', 'still wrong');
  const floored = await m.get('gotcha:feedback-wrong');
  ok(floored.confidence === 0.1, 'repeated feedback("wrong") floors confidence at 0.1, never goes lower');
  await m.close();
}

{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  ok(await threw(() => m.feedback('gotcha:does-not-exist', 'useful')), 'feedback() on an unknown entity throws — a loud error, not a silent create');
  ok((await m.get('gotcha:does-not-exist')) === null, 'feedback() on an unknown entity does not create it');
  ok(await threw(() => m.feedback('gotcha:feedback-bad-outcome', 'maybe')), 'feedback() rejects an outcome outside useful|wrong');
  await m.close();
}

{
  // HARD CONSTRAINT: a negative entity's status/caveat/decay-exemption must survive feedback intact.
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'decision:feedback-negative', negative: true, confidence: 1, body: '## ⛔ Removed: the legacy exporter\nDo not reintroduce.' });
  const before = await m.get('decision:feedback-negative');

  const afterUseful = await m.feedback('decision:feedback-negative', 'useful');
  ok(afterUseful.negative === true && afterUseful.confidence === before.confidence, 'feedback("useful") on a negative entity is a no-op (negative + confidence untouched)');

  const afterWrong = await m.feedback('decision:feedback-negative', 'wrong', 'actually the removal note is unclear');
  ok(afterWrong.negative === true, 'feedback("wrong") on a negative entity never flips negative off');
  ok(afterWrong.confidence === before.confidence, 'feedback("wrong") on a negative entity does NOT change confidence — no confidence games that could bury a do-not-reintroduce fact');
  ok(afterWrong.body.includes('## Correction') && afterWrong.body.includes('unclear'), 'feedback("wrong") on a negative entity still appends the Correction observation');

  const hit = (await m.query('legacy exporter removed'))[0];
  ok(hit?.caveat?.startsWith('⛔'), 'the entity still surfaces its ⛔ caveat after feedback');
  ok(hit?.decay === 1, 'the entity is still decay-exempt after feedback');
  await m.close();
}

// ============================================================================
// Lesson 3: incremental sync
// ============================================================================

{
  const root = resolve('/tmp/rmem-lesson-sync'); rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  await m.remember({ id: 'gotcha:sync-a', body: 'alpha fact for incremental sync' });
  await m.remember({ id: 'gotcha:sync-b', body: 'beta fact for incremental sync' });

  const realEmbed = m.embedder.embed.bind(m.embedder);
  let calls = 0;
  m.embedder.embed = async (t) => { calls++; return realEmbed(t); };

  const r1 = await m.sync();
  ok(calls === 0, 'sync() makes ZERO embedder calls when nothing changed since remember()');
  ok(r1.total === 2 && r1.changed === 0 && r1.unchanged === 2 && r1.pruned === 0, 'sync() reports {total:2, changed:0, unchanged:2, pruned:0}');

  const pA = resolve(root, 'memory/graph/gotcha/sync-a.md');
  writeFileSync(pA, readFileSync(pA, 'utf8').replace('alpha fact for incremental sync', 'alpha fact CHANGED by hand'));
  calls = 0;
  const r2 = await m.sync();
  ok(calls === 1, 'sync() makes exactly ONE embedder call — only the hand-edited entity reindexes');
  ok(r2.changed === 1 && r2.unchanged === 1, 'sync() reports exactly 1 changed, 1 unchanged');
  const changedHit = (await m.query('alpha fact CHANGED by hand'))[0];
  ok(changedHit?.id === 'gotcha:sync-a', 'the hand-edited content is actually reindexed and searchable — not silently skipped');

  rmSync(resolve(root, 'memory/graph/gotcha/sync-b.md'));
  const countBeforePrune = await m.count();
  const r3 = await m.sync();
  ok(r3.pruned === 1, 'sync() reports 1 pruned entity whose markdown vanished');
  ok((await m.count()) === countBeforePrune - 1, 'the pruned entity is actually gone from the index');
  ok((await m.get('gotcha:sync-b')) === null, 'the pruned entity is no longer retrievable');

  m.embedder.embed = realEmbed;
  await m.close(); rmSync(root, { recursive: true, force: true });
}

{
  // The checkEntityType vocab-warning pass must still run over EVERY markdown entity, changed or not.
  const root = resolve('/tmp/rmem-lesson-sync-vocab'); rmSync(root, { recursive: true, force: true });
  mkdirSync(resolve(root, 'memory/graph/oddtype2'), { recursive: true });
  writeFileSync(resolve(root, 'memory/graph/oddtype2/thing.md'),
    '---\nid: oddtype2:thing\ntype: oddtype2\n---\n\nnon-canonical type, unchanged across two syncs.\n');
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  await m.sync(); // first sync indexes it (changed:1)
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  await m.sync(); // second sync: unchanged and skipped for reindexing, but still must warn
  console.warn = realWarn;
  ok(warnings.some((w) => /oddtype2/.test(w)), 'the vocab-warning pass runs on the SECOND sync too, even though the entity is unchanged (skip-embed only skips the DB write, never the read-time warning)');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// ============================================================================
// Lesson 4: caps in the engine core
// ============================================================================

{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  ok(await threw(() => m.remember({ id: 'x'.repeat(CAPS.id + 1) + ':y', body: 'x' })), 'remember() with an oversized raw id throws');

  ok(await threw(() => m.remember({ id: 'gotcha:oversized-body', body: 'x'.repeat(CAPS.body + 1) })), 'remember() with an oversized body throws');
  ok((await m.get('gotcha:oversized-body')) === null, 'the oversized-body entity is not partially persisted');

  const tooManyAliases = Array.from({ length: CAPS.aliasCount + 1 }, (_, i) => `alias-${i}`);
  ok(await threw(() => m.remember({ id: 'gotcha:too-many-aliases', body: 'x', aliases: tooManyAliases })), 'remember() with too many aliases throws');

  ok(await threw(() => m.remember({ id: 'gotcha:alias-too-long', body: 'x', aliases: ['a'.repeat(CAPS.aliasLen + 1)] })), 'remember() with an over-length single alias throws');

  const tooManyRelations = Array.from({ length: CAPS.relationCount + 1 }, (_, i) => `relates-to|infra:x-${i}`);
  ok(await threw(() => m.remember({ id: 'gotcha:too-many-relations', body: 'x', relations: tooManyRelations })), 'remember() with too many relations throws');
  await m.close();
}

{
  // Merge-overflow: a merge that pushes the COMBINED body past the cap throws before any write —
  // same no-partial-write guarantee assertKnownVerbs already provides on the merge path.
  const root = resolve('/tmp/rmem-lesson-caps-merge'); rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  await m.remember({ id: 'gotcha:merge-overflow', body: 'y'.repeat(CAPS.body - 100) });
  const path = resolve(root, 'memory/graph/gotcha/merge-overflow.md');
  const before = readFileSync(path, 'utf8');
  let err;
  try { await m.remember({ id: 'gotcha:merge-overflow', body: 'z'.repeat(1000) }); } catch (e) { err = e; }
  ok(!!err && /body too long/.test(err.message), 'a merge that would push the combined body past the cap throws, naming the field/size/cap');
  const after = readFileSync(path, 'utf8');
  ok(after === before, 'the on-disk markdown is unchanged after a rejected merge-overflow — no partial write, markdown or index');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// ============================================================================
// Lesson 5: near-duplicate detection (doctor, flag-only)
// ============================================================================

{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'gotcha:redis-tls-mismatch', body: 'x', aliases: ['redis tls handshake'] });
  await m.remember({ id: 'gotcha:redis-tls-missmatch', body: 'y', aliases: ['redis tls handshake'] }); // deliberately near-identical slug/alias (typo)
  await m.remember({ id: 'gotcha:totally-unrelated-topic', body: 'z' });
  const report = await m.doctor();
  const pair = report.nearDuplicates.find((d) =>
    (d.a === 'gotcha:redis-tls-mismatch' && d.b === 'gotcha:redis-tls-missmatch') ||
    (d.a === 'gotcha:redis-tls-missmatch' && d.b === 'gotcha:redis-tls-mismatch'));
  ok(!!pair && pair.score >= 0.85, 'doctor flags a near-duplicate pair with score >= the threshold');
  ok(!report.nearDuplicates.some((d) => d.a.includes('unrelated') || d.b.includes('unrelated')), 'a clearly-distinct entity is not flagged as a near-duplicate of anything');
  ok(report.summary.nearDuplicates >= 1, 'the summary counts near-duplicates');

  const fixed = await m.doctor({ fix: true });
  ok((await m.count()) === 3, '--fix NEVER auto-merges near-duplicates — all 3 entities still exist after --fix');
  ok(fixed.nearDuplicates.length === report.nearDuplicates.length, 'near-duplicates are still reported after --fix (flag-only, not cleared or acted on)');
  await m.close();
}

// ============================================================================
// Lesson 6: post-merge/post-checkout freshness hook
// ============================================================================

{
  const root = resolve('/tmp/rmem-lesson-hook'); rmSync(root, { recursive: true, force: true });
  mkdirSync(resolve(root, '.git/hooks'), { recursive: true });

  const installed = installHooks(root);
  ok(installed['post-merge'].status === 'installed' && installed['post-checkout'].status === 'installed', 'install writes both post-merge and post-checkout hooks');
  const pmContent = readFileSync(resolve(root, '.git/hooks/post-merge'), 'utf8');
  ok(pmContent.includes(MARKER), 'the installed hook carries the "# respawn-memory hook v1" marker');
  ok(pmContent.includes('rmem sync || true'), 'the hook runs `rmem sync` fail-open (|| true)');
  ok(pmContent.includes('command -v rmem'), 'the hook exits silently if rmem is not on PATH');
  ok(pmContent.includes('respawn-memory.config.json'), 'the hook exits silently if there is no respawn-memory.config.json at the repo root');

  const status1 = statusHooks(root);
  ok(status1['post-merge'] === 'ours' && status1['post-checkout'] === 'ours', 'status reports both hooks as ours after install');

  // A foreign, unmarked hook must never be overwritten.
  rmSync(resolve(root, '.git/hooks/post-checkout'));
  writeFileSync(resolve(root, '.git/hooks/post-checkout'), '#!/bin/sh\necho some other tool\n');
  const installed2 = installHooks(root);
  ok(installed2['post-checkout'].status === 'foreign', 'install refuses to overwrite a foreign (unmarked) hook');
  ok(readFileSync(resolve(root, '.git/hooks/post-checkout'), 'utf8').includes('some other tool'), 'the foreign hook content is left byte-for-byte untouched');
  ok(installed2['post-merge'].status === 'installed', 'the OTHER marker-verified hook still installs normally alongside a foreign sibling');

  const status2 = statusHooks(root);
  ok(status2['post-checkout'] === 'foreign', 'status reports the foreign hook as foreign, not ours');

  const uninstalled = uninstallHooks(root);
  ok(uninstalled['post-merge'].status === 'removed', 'uninstall removes the marker-verified hook');
  ok(uninstalled['post-checkout'].status === 'foreign', 'uninstall refuses to remove the foreign hook');
  ok(existsSync(resolve(root, '.git/hooks/post-checkout')), 'the foreign hook file still exists after uninstall');
  ok(!existsSync(resolve(root, '.git/hooks/post-merge')), 'the marker-verified hook file is actually gone after uninstall');

  const status3 = statusHooks(root);
  ok(status3['post-merge'] === 'absent', 'status reports the removed hook as absent');

  rmSync(root, { recursive: true, force: true });
}

{
  const root = resolve('/tmp/rmem-lesson-hook-nogit'); rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  ok(await threw(async () => installHooks(root)), 'installHooks() throws a clear error when there is no .git/hooks directory at all');
  rmSync(root, { recursive: true, force: true });
}

// ============================================================================
// Fix-round regressions (adversarial verify, 2026-07-08): 3 majors + 2 minors
// found after the lessons landed. Each fix gets a fail-before/pass-after guard.
// ============================================================================

// FIX 1 (major) — index-first write order. remember() must run the index tx BEFORE the markdown
// write, so a mid-index failure (embedder outage) leaves the source of truth byte-identical.
// Fail-before: with the old markdown-first order, the .md carried the new body while the caller
// saw a thrown error and the index served the old one — a silent source-of-truth mutation.
{
  const root = resolve('/tmp/rmem-fix-index-first'); rmSync(root, { recursive: true, force: true });
  const m = await createEngine({ root, dataDir: 'memory:', memoryDir: 'memory/graph' });
  await m.remember({ id: 'gotcha:atomic', body: 'the original fact, must survive a failed re-remember' });
  const path = resolve(root, 'memory/graph/gotcha/atomic.md');
  const before = readFileSync(path, 'utf8');

  const realEmbed = m.embedder.embed.bind(m.embedder);
  m.embedder.embed = async () => { throw new Error('simulated embedder outage'); };
  const threwOnReRemember = await threw(() => m.remember({ id: 'gotcha:atomic', body: 'a NEW body that must never reach disk' }));
  m.embedder.embed = realEmbed;

  ok(threwOnReRemember, 'a re-remember() whose indexing fails propagates the error to the caller');
  ok(readFileSync(path, 'utf8') === before, 'the on-disk markdown is byte-identical after the failed re-remember — no silent source-of-truth mutation');
  const g = await m.get('gotcha:atomic');
  ok(g && g.body.includes('the original fact') && !g.body.includes('NEW body'), 'get() still serves the OLD content — the index rolled back in lockstep with the untouched markdown');
  await m.close(); rmSync(root, { recursive: true, force: true });
}

// FIX 2 (major) — the id cap must hold on BOTH input shapes. The {type, slug} shape bypassed
// assertIdCap (which only saw input.id), so a 500-char slug was silently folded to 60 chars by
// slugify() — two distinct long slugs sharing a prefix could then silently merge.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  const longId = 'gotcha:' + 'y'.repeat(CAPS.id);
  const longSlug = 'y'.repeat(CAPS.id);
  ok(await threw(() => m.remember({ id: longId, body: 'x' })), 'the {id} shape over the id cap throws (baseline)');
  ok(await threw(() => m.remember({ type: 'gotcha', slug: longSlug, body: 'x' })), 'the {type, slug} shape over the id cap ALSO throws — the bypass is closed');
  ok((await m.count()) === 0, 'neither over-cap attempt persisted anything (no silent fold-and-merge)');
  await m.close();
}

// FIX 3 (major) — hook subcommands must agree from a subdirectory. resolveRepoRoot() finds the
// true repo root from anywhere inside, so status/uninstall run from a subpackage no longer
// silently report "absent" while the real hooks stay active at the root.
{
  const root = resolve('/tmp/rmem-fix-hooksub'); rmSync(root, { recursive: true, force: true });
  mkdirSync(resolve(root, '.git/hooks'), { recursive: true });
  const sub = resolve(root, 'packages/backend/app');
  mkdirSync(sub, { recursive: true });

  ok(resolveRepoRoot(sub) === root, 'resolveRepoRoot() walks up from a subdirectory to the true repo root');

  installHooks(root); // install at the real root
  const statusFromSub = statusHooks(resolveRepoRoot(sub));
  ok(statusFromSub['post-merge'] === 'ours' && statusFromSub['post-checkout'] === 'ours', 'status resolved from a subdirectory sees the real hooks (was: silently "absent")');
  const uninstalledFromSub = uninstallHooks(resolveRepoRoot(sub));
  ok(uninstalledFromSub['post-merge'].status === 'removed', 'uninstall resolved from a subdirectory actually removes the hooks (was: silent no-op)');
  ok(!existsSync(resolve(root, '.git/hooks/post-merge')), 'the hook is genuinely gone after a subdirectory-initiated uninstall');
  await (async () => {})();

  const nogit = resolve('/tmp/rmem-fix-nogit-resolve'); rmSync(nogit, { recursive: true, force: true }); mkdirSync(nogit, { recursive: true });
  ok(await threw(async () => resolveRepoRoot(nogit)), 'resolveRepoRoot() throws a clear error when no repo root exists above the start dir');
  rmSync(root, { recursive: true, force: true }); rmSync(nogit, { recursive: true, force: true });
}

// FIX 4 (minor) — near-duplicate detection compares SAME-TYPE pairs only. A cross-type slug match
// (infra:redis + gotcha:redis) is the naming convention working as intended, not a duplicate, and
// previously scored a false-positive 1.0.
{
  const m = await createEngine({ dataDir: 'memory:', persistFiles: false });
  await m.remember({ id: 'infra:redis', body: 'the redis component', aliases: ['redis'] });
  await m.remember({ id: 'gotcha:redis', body: 'a redis gotcha', aliases: ['redis'] });
  await m.remember({ id: 'gotcha:redis-2', body: 'another redis gotcha', aliases: ['redis'] }); // same-type near-pair
  const report = await m.doctor();
  ok(!report.nearDuplicates.some((d) => (d.a === 'infra:redis' || d.b === 'infra:redis')), 'a cross-type slug match (infra:redis vs gotcha:redis) is NOT flagged — the naming convention is not a duplicate');
  ok(report.nearDuplicates.some((d) => (d.a.startsWith('gotcha:') && d.b.startsWith('gotcha:'))), 'a genuine SAME-type near-pair is still flagged');
  await m.close();
}

// FIX 5 (minor) — normText is a single exported helper in store.mjs (doctor.mjs imports it rather
// than redefining a byte-identical copy). This guards the export so the two can never diverge.
{
  ok(normText('  Foo   BAR  ') === 'foo bar', 'the shared normText() lowercases, trims, and collapses whitespace as doctor.mjs relies on');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
