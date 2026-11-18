/*
 * RespawnPack · ops/suite-counts.test.mjs — the changed-tier derivation, its fence against the tree,
 * and the tier plans, proved through the runner's exported pure functions (task A0).
 *
 * ⛔ THIS SUITE NEVER RUNS A REAL SUITE. It imports the mapping and the plan functions and asserts over
 * their return values; the one place it touches git is `git ls-files`, to fence the real mapping against
 * the real tree. So it runs in milliseconds and belongs in the fast tier, which is where SUITES puts it.
 *
 * Three states per the task row:
 *   · the original defect fails — the old runner had no changed tier, so a one-file hooks change ran
 *     EVERY suite; and a mapping could name a suite or prefix that did not exist with nothing noticing;
 *   · the corrected case passes — one hooks file plans hooks + the four fences only; `hooks/_runtime.js`
 *     plans kernel too; no change plans the fences only;
 *   · the nearest bypass fails — a mapping entry pointing at a suite outside SUITES, or a prefix absent
 *     from the tree, is refused before any suite runs, and `--tier full` ignores the diff entirely.
 *
 *   node --test ops/suite-counts.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  SUITES, FAST, MUST_STAY_FAST, FENCE_SUITES, PATH_OWNERS, UNOWNED_TREES,
  changedSuites, planForTier, checkMapping, treeReadReference, readSuiteSources,
} from './suite-counts.mjs';

const PACK = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const treePaths = () => execFileSync('git', ['ls-files'], { cwd: PACK, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const fencesInOrder = SUITES.filter((s) => FENCE_SUITES.includes(s));

// --- corrected case -----------------------------------------------------------------------------

test('a one-file hooks change plans the hooks suite and the four fences only', () => {
  const plan = changedSuites(['hooks/context-monitor.js']);
  assert.deepEqual(plan, SUITES.filter((s) => s === 'hooks/hooks.test.mjs' || FENCE_SUITES.includes(s)));
  assert.ok(plan.includes('hooks/hooks.test.mjs'), 'the hooks suite must run for a hooks change');
  for (const f of FENCE_SUITES) assert.ok(plan.includes(f), `fence ${f} must always run`);
  // The defect this replaces: the old runner had no changed tier, so a one-file hooks change ran the
  // whole list. A plan equal to the full list would be that old behaviour sneaking back.
  assert.ok(plan.length < SUITES.length, 'the changed tier must not run every suite');
  assert.ok(!plan.includes('kernel/kernel.test.mjs'), 'a non-underscore hook must not pull the kernel suite');
});

test('a shared hook module (hooks/_*.js) gates the kernel suite as well as the hooks suite', () => {
  const plan = changedSuites(['hooks/_runtime.js']);
  assert.ok(plan.includes('hooks/hooks.test.mjs'));
  assert.ok(plan.includes('kernel/kernel.test.mjs'), 'hooks/_*.js gates the kernel suite (second-run merge rule)');
  for (const f of FENCE_SUITES) assert.ok(plan.includes(f));
});

test('no change plans the four fences only', () => {
  assert.deepEqual(changedSuites([]), fencesInOrder);
  assert.equal(changedSuites([]).length, FENCE_SUITES.length);
});

test('the settings snippet and install/ own the install and uninstall suites', () => {
  for (const p of ['hooks/settings.snippet.json', 'install/install.js', 'install/upgrade.js']) {
    const plan = changedSuites([p]);
    assert.ok(plan.includes('install/install.test.mjs'), `${p} must plan the install suite`);
    assert.ok(plan.includes('install/uninstall.test.mjs'), `${p} must plan the uninstall suite`);
  }
});

test('core/ owns both core and conformance; conformance/ owns conformance alone', () => {
  const core = changedSuites(['core/_io.js']);
  assert.ok(core.includes('core/core.test.mjs') && core.includes('conformance/conformance.test.mjs'));
  const conf = changedSuites(['conformance/CAPABILITY-MATRIX.md']);
  assert.ok(conf.includes('conformance/conformance.test.mjs'));
  assert.ok(!conf.includes('core/core.test.mjs'), 'a conformance-only change must not pull the core suite');
});

test('editing this runner plans its own test, and the suite is registered in SUITES', () => {
  assert.ok(SUITES.includes('ops/suite-counts.test.mjs'), 'the runner test must be in SUITES (and thus the fast tier)');
  assert.ok(changedSuites(['ops/suite-counts.mjs']).includes('ops/suite-counts.test.mjs'));
});

// --- the mapping is coherent against the real tree ----------------------------------------------

test('the real mapping fits the real tree: every prefix exists, every suite is real, every suite is reachable', () => {
  assert.doesNotThrow(() => checkMapping(PATH_OWNERS, SUITES, FENCE_SUITES, treePaths()));
});

// --- nearest bypass fails -----------------------------------------------------------------------

test('bypass: a mapping entry pointing at a suite outside SUITES is refused before any suite runs', () => {
  const bad = [...PATH_OWNERS, { prefix: 'hooks/', suites: ['hooks/not-a-suite.test.mjs'] }];
  assert.throws(() => checkMapping(bad, SUITES, FENCE_SUITES, treePaths()), /not in SUITES/);
});

test('bypass: a mapping prefix that matches no tracked file is refused before any suite runs', () => {
  const bad = [...PATH_OWNERS, { prefix: 'nowhere-in-the-tree/', suites: ['hooks/hooks.test.mjs'] }];
  assert.throws(() => checkMapping(bad, SUITES, FENCE_SUITES, treePaths()), /matches no file in the tree/);
});

test('the fence catches a SUITES entry that no prefix owns (it would run only the fences)', () => {
  const extra = [...SUITES, 'adapters/ghost/ghost.test.mjs'];
  assert.throws(() => checkMapping(PATH_OWNERS, extra, FENCE_SUITES, treePaths()), /owned by no prefix/);
});

// --- tree coverage: the other side of the fence (the gap the reviewer found) --------------------

test('bypass: a top-level tree that no prefix owns and UNOWNED_TREES does not excuse is refused', () => {
  const treeWithOrphan = [...treePaths(), 'brand-new-tree/thing.js'];
  assert.throws(
    () => checkMapping(PATH_OWNERS, SUITES, FENCE_SUITES, treeWithOrphan),
    /top-level trees are owned by no PATH_OWNERS prefix.*brand-new-tree\//s,
  );
});

test('the cross-tree sources the reviewer found unowned now plan their guarding suites', () => {
  const schemas = changedSuites(['schemas/registry.json']);
  // schema suite validates schemas/; the hooks suite reads project-config.schema.json too.
  assert.ok(schemas.includes('kernel/schema.test.mjs') && schemas.includes('hooks/hooks.test.mjs'), 'a schemas/ change must plan the schema and hooks suites');
  const release = changedSuites(['release/build-public.sh']);
  assert.ok(release.includes('ops/release-smoke.test.mjs'), 'a release/ change must plan the release-smoke suite');
  const spine = changedSuites(['spine/derived/CONTINUITY.md']);
  for (const s of ['kernel/kernel.test.mjs', 'kernel/schema.test.mjs', 'kernel/site.test.mjs']) {
    assert.ok(spine.includes(s), `a spine/ change must plan ${s}`);
  }
  // templates/CLAUDE.md is read as content by the kernel and install suites (the second-round finding).
  const templates = changedSuites(['templates/CLAUDE.md']);
  for (const s of ['kernel/kernel.test.mjs', 'install/install.test.mjs', 'install/uninstall.test.mjs']) {
    assert.ok(templates.includes(s), `a templates/ change must plan ${s}`);
  }
  // examples/todo-app's worked config is validated by the schema suite too.
  assert.ok(changedSuites(['examples/todo-app/respawnpack.config.json']).includes('kernel/schema.test.mjs'));
});

// --- the mechanical reason check: an UNOWNED reason is verified against the suite sources, not trusted -

test('mechanical reason: an UNOWNED_TREES excuse for a tree a non-fence suite reads is refused, naming the suite', () => {
  const stale = [...UNOWNED_TREES, { tree: 'catalog/', reason: 'bogus — a non-fence suite really reads it' }];
  const sources = new Map([['kernel/kernel.test.mjs', "const x = fs.readFileSync(path.join(KERNEL, '..', 'catalog', 'thing.md'), 'utf8');"]]);
  assert.throws(
    () => checkMapping(PATH_OWNERS, SUITES, FENCE_SUITES, treePaths(), stale, sources),
    /UNOWNED_TREES excuses "catalog\/", but the non-fence suite kernel\/kernel\.test\.mjs/,
  );
});

test('mechanical reason: a fixture write or a temp-dir join is not a read, so the excuse stands', () => {
  // The exact shapes that must NOT trip the scan: a literal write target and a per-test temp join.
  const fixtureish = "write(repo, 'catalog/x.md', '...'); const p = path.join(dir, 'catalog', 'y.md');";
  assert.equal(treeReadReference(fixtureish, 'catalog/'), null);
  // A genuine pack-content read does trip it.
  assert.ok(treeReadReference("path.join(ROOT_DIR, 'catalog', 'z.md')", 'catalog/'));
  assert.ok(treeReadReference("path.join(__dirname, '..', 'catalog', 'z.md')", 'catalog/'));
});

test('the real suite sources prove every UNOWNED_TREES reason true (no non-fence suite reads any of them)', () => {
  const sources = readSuiteSources(PACK);
  for (const { tree } of UNOWNED_TREES) {
    for (const [suite, src] of sources) {
      assert.equal(treeReadReference(src, tree), null, `${suite} reads ${tree}, so it cannot be excused as UNOWNED`);
    }
  }
});

test('stale: an UNOWNED_TREES entry for a tree a prefix actually owns is refused', () => {
  const stale = [...UNOWNED_TREES, { tree: 'kernel/', reason: 'bogus — kernel/ is really owned' }];
  assert.throws(() => checkMapping(PATH_OWNERS, SUITES, FENCE_SUITES, treePaths(), stale), /a PATH_OWNERS prefix owns it/);
});

test('rot: an UNOWNED_TREES entry no tracked path matches is refused', () => {
  const rotted = [...UNOWNED_TREES, { tree: 'gone-tree/', reason: 'a tree that was removed' }];
  assert.throws(() => checkMapping(PATH_OWNERS, SUITES, FENCE_SUITES, treePaths(), rotted), /no tracked path matches/);
});

test('an UNOWNED_TREES entry without a reason is refused', () => {
  const noReason = [...UNOWNED_TREES, { tree: 'catalog/', reason: '' }];
  // catalog/ is already excused once with a reason, so the empty duplicate is what trips the check.
  assert.throws(() => checkMapping(PATH_OWNERS, SUITES, FENCE_SUITES, treePaths(), noReason), /carries no reason/);
});

test('full tier ignores the diff entirely; fast tier ignores it too', () => {
  assert.deepEqual(planForTier('full', ['hooks/context-monitor.js']), SUITES);
  assert.deepEqual(planForTier('full'), SUITES);
  assert.deepEqual(planForTier('fast', ['hooks/context-monitor.js']), FAST);
});

test('an unknown tier is rejected rather than guessed', () => {
  assert.throws(() => planForTier('everything'), /unknown tier/);
});

// --- anti-drift item 49 ------------------------------------------------------------------------

test('the four fence suites are in every changed plan, and are exactly the fast-tier fences', () => {
  for (const paths of [[], ['README.md'], ['hooks/x.js'], ['kernel/y.js'], ['docs/dev/z.md'], ['ops/suite-counts.mjs']]) {
    const plan = changedSuites(paths);
    for (const f of MUST_STAY_FAST) assert.ok(plan.includes(f), `${f} missing from the changed plan for ${JSON.stringify(paths)}`);
  }
  assert.deepEqual([...FENCE_SUITES].sort(), [...MUST_STAY_FAST].sort(), 'the changed tier must fence exactly the suites the fast tier fences');
});
