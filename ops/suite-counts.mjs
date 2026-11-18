/*
 * RespawnPack · ops/suite-counts.mjs — run the core suites and EXTRACT their counts, refusing to guess.
 *
 * ⛔ WHY EXTRACTION IS STRICT. Every release document in this repository has, at some point, carried a
 * suite total that was true of a different commit ("591 was true of the commit that measured it").
 * This runner exists so a total can only be produced by parsing each suite's own summary at the
 * commit being measured:
 *
 *   · a suite whose output lacks any of `# tests` / `# pass` / `# fail` is a HARD FAILURE — a count
 *     that cannot be parsed is not a count, and defaulting it to zero would spell PASS;
 *   · `pass + fail == tests` is required per suite — an arithmetic that does not close is evidence
 *     of a truncated or interleaved run, not a rounding detail;
 *   · a nonzero suite exit is a failure even if the summary parses green.
 *
 * TIERS. `--tier full` (the default) runs every suite in `SUITES` — the release gate, mandatory at
 * every phase boundary, and unchanged as the gate it always was. `--tier fast` runs `FAST`, which
 * is `SUITES` with the suites named in `EXCLUDED` taken out, each carrying its own reason (too slow for
 * a two-minute budget, or exercising a host that is not in use) — so the fast list is derived, never a
 * second hand-typed array, and cannot drift out of sync with `SUITES`. `--tier changed` runs only the
 * suites that OWN the paths a builder's branch changed against `main` (committed, staged, working-tree
 * and untracked), through the `PATH_OWNERS` mapping, plus the four fence suites that must run on every
 * count-changing task. The changed tier is a builder-iteration convenience; the full tier stays the
 * phase gate, and CI never calls this runner, so neither is affected by it. Extraction is exactly as
 * strict in every tier: a suite that will not parse is a HARD FAILURE whichever tier ran it. Nothing
 * here lets the fast or changed tier stand in for `--tier full` at a release or phase boundary.
 *
 * PLAN MODE. `--plan` prints the suites the chosen tier WOULD run and exits 0 without running them, so
 * the mapping can be inspected and proven (and the done-when demonstrated) without a twelve-minute hooks
 * run. With `--tier changed`, `--paths a,b,c` overrides the git-derived change set so a hypothetical
 * change can be inspected; without it the plan is computed from the real diff against `main`.
 *
 *   node ops/suite-counts.mjs [--tier fast|full|changed] [--plan] [--paths <csv>] [--json <file>]
 *
 * Each suite's wall time is recorded on its console line and in the JSON rows, so the slow suites are
 * visible without a second timed run. Exit: 0 every suite parsed, arithmetic closed, zero failures ·
 * 1 anything else, including an unrecognized --tier value or a mapping that no longer fits the tree,
 * refused before any suite runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACK = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The core suites — the v0.2.0 baseline, plus v0.3's host-neutral rollover core, its conformance
// traces, and the per-host adapter suites layered on top of it. A suite listed here is a release
// gate; one missing from here can go red without anything noticing, which is why additions land in
// the same commit as the tree they test. The array below IS the count — read it, never restate a
// number here, because this comment is exactly the kind of hand-carried figure that rots the moment
// the next suite is added and nobody remembers to update the prose beside it.
export const SUITES = [
  'hooks/hooks.test.mjs',
  'kernel/kernel.test.mjs',
  'kernel/schema.test.mjs',
  'kernel/concurrency.test.mjs',
  'kernel/reconcile.test.mjs',
  // The markdown renderer behind the browsable record (task O-4a). Goldens only: it renders committed
  // fixture documents, the three project archetypes' own markdown, this pack's spine templates and a
  // real generated block, and compares whole files. No network, no install, no server. Milliseconds.
  'kernel/site.test.mjs',
  'install/install.test.mjs',
  'install/uninstall.test.mjs',
  'install/_scoping.test.mjs',
  'skills/skills.test.mjs',
  // The /respawn boot-set budget fence (task B1): installs the pack into a copy of examples/todo-app,
  // renders STATE.json and the derived docs, and measures the boot set Steps 0 to 2 put in context,
  // failing above 32,000 bytes. A handful of real kernel and installer spawns on a tiny tree — a few
  // seconds, inside the fast-tier budget.
  'skills/respawn/boot-set.test.mjs',
  'counts-fence.test.mjs',
  'library/library.test.mjs',
  // The release smoke's PROFILE contract. Not the smoke itself — that installs the product once per
  // posture and is its own gate; this is `ops/_smoke-profiles.mjs`'s verdicts driven through their
  // failing states, plus the fence holding `release/build-public.sh`'s DEV_ONLY split. Milliseconds.
  'ops/release-smoke.test.mjs',
  // The shared project-fixture helper (task F-0): the four project archetypes every later task's
  // fixtures materialise through, proved deterministic and checked against install.js's own
  // projectType vocabulary. Milliseconds — it writes small trees to a temp dir, nothing installed.
  'ops/project-fixtures.test.mjs',
  // This runner's own derivation (task A0): the changed-set mapping, the fence against the tree, and
  // the plan for each tier, all through the exported pure functions — it never spawns a real suite,
  // so it stays in the fast tier by construction. Milliseconds.
  'ops/suite-counts.test.mjs',
  'core/core.test.mjs',
  'conformance/conformance.test.mjs',
  'adapters/codex/codex-hooks.test.mjs',
  'adapters/claude-code/sdk-supervisor/stream.test.mjs',
  'adapters/claude-code/sdk-supervisor/supervisor.test.mjs',
  'adapters/claude-code/task-runner/runner.test.mjs',
  'adapters/claude-code/task-runner/canary.test.mjs',
  'adapters/codex/app-server/rpc.test.mjs',
  'adapters/codex/app-server/supervisor.test.mjs',
  // The generic OpenAI-compatible provider client and its probe (task P4-M-3). In the fast tier, and
  // deliberately NOT in EXCLUDED as a "host not in use": every test injects its own `fetch` and its own
  // environment, the fixture base URL is `api.example.invalid`, and the suite is unchanged with the
  // network unplugged. Measured in milliseconds. Nothing here reaches a provider, so there is no host
  // whose absence could make it irrelevant.
  'adapters/openai-compatible/client.test.mjs',
  // The offload path across the three providers (task P4-M-4). In the fast tier, and deliberately NOT in
  // EXCLUDED as a "host not in use": no real `claude` and no real `codex` is spawned, `fetch` is injected,
  // and the fixture base URL is `api.example.invalid`. It materialises two project archetypes per test
  // through ops/_project-fixtures.mjs with git off, so it is small temp trees and no child processes.
  // Measured in single-digit seconds.
  'adapters/providers/offload.test.mjs',
  'adapters/claude-code/interactive/interactive.test.mjs',
  'adapters/claude-code/statusline/statusline.test.mjs',
  'license-contract.test.mjs',
];

// The fast tier's suites, expressed as an EXCLUSION from SUITES rather than a second hand-typed list,
// so the two can never quietly drift apart the way independently maintained arrays eventually do.
// Every excluded suite carries its own reason: either it is too slow for the fast tier's two-minute
// budget (measured per-suite in the core-adapters-ops audit §4; re-measured on each machine this runs on), or
// it exercises a host adapter that is not in use here. Anti-drift item 49's four fence suites, checked
// in deriveFast() below, may never end up in this list.
//
// `adapters/claude-code/task-runner/runner.test.mjs` is deliberately NOT here: it is fixture-driven
// against the sdk-supervisor's own recorded streams and needs no live CLI. It runs in ~24s on this
// machine, up from ~8s when P5-T-16b added the out-of-band gates — each of those tests now drives a
// real `git init` fixture, a real `contract delegate`, a real `contract complete --met` and real gate
// child processes, which is the cost of not faking the kernel. Still inside the two-minute budget, and
// the number is recorded here so the next person to add a test knows how much of it is already spent.
//
// `adapters/claude-code/task-runner/canary.test.mjs` is the same call for the same reason: fixture-driven
// against the same recorded streams, no live CLI, the kernel not faked (a real `git init`, `contract
// delegate` and `contract complete --met` per test, plus a real minimal-kernel file copy). Measured
// ~7s on this machine for 19 tests.
export const EXCLUDED = [
  { suite: 'hooks/hooks.test.mjs', reason: 'spawns hundreds of real child processes (measured ~279s idle in the first run, and 711s then 790s under load on this machine) — too slow for the two-minute fast-tier budget; run explicitly for hooks/* work instead' },
  { suite: 'kernel/kernel.test.mjs', reason: 'too slow for the two-minute fast-tier budget (measured ~74s); run explicitly for kernel/* work instead' },
  { suite: 'install/install.test.mjs', reason: 'too slow for the two-minute fast-tier budget (measured ~151s); run explicitly for install/* work instead' },
  { suite: 'install/uninstall.test.mjs', reason: 'paired with install/install.test.mjs as the install/* owning suite; run explicitly for install/* work rather than in every fast-tier run' },
  { suite: 'adapters/codex/codex-hooks.test.mjs', reason: 'exercises the Codex host, not in use on this installation — excluded for relevance, not speed' },
  { suite: 'adapters/codex/app-server/rpc.test.mjs', reason: 'exercises the Codex host, not in use on this installation — excluded for relevance, not speed' },
  { suite: 'adapters/codex/app-server/supervisor.test.mjs', reason: 'exercises the Codex host, not in use on this installation — excluded for relevance, not speed' },
];

// Anti-drift item 49: these four fence suites stay green on every count-changing task and must never
// silently fall out of the fast tier through a future EXCLUDED edit. Checked here, not just asserted
// in a comment, so a bad edit fails loudly the next time this file runs at all.
export const MUST_STAY_FAST = ['counts-fence.test.mjs', 'skills/skills.test.mjs', 'library/library.test.mjs', 'license-contract.test.mjs'];

export function deriveFast() {
  const inSuites = new Set(SUITES);
  const excludedNames = new Set();
  for (const { suite, reason } of EXCLUDED) {
    if (!inSuites.has(suite)) throw new Error(`ops/suite-counts.mjs: EXCLUDED names "${suite}", which is not in SUITES — a stale exclusion for a suite that moved or was removed`);
    if (!reason || !reason.trim()) throw new Error(`ops/suite-counts.mjs: EXCLUDED entry "${suite}" carries no reason — every exclusion must say why`);
    if (excludedNames.has(suite)) throw new Error(`ops/suite-counts.mjs: EXCLUDED names "${suite}" more than once`);
    excludedNames.add(suite);
  }
  const fast = SUITES.filter((s) => !excludedNames.has(s));
  if (fast.length + excludedNames.size !== SUITES.length) throw new Error('ops/suite-counts.mjs: FAST + EXCLUDED does not partition SUITES exactly — this should be unreachable given the checks above');
  for (const mustStay of MUST_STAY_FAST) {
    if (!fast.includes(mustStay)) throw new Error(`ops/suite-counts.mjs: "${mustStay}" is required in the fast tier by anti-drift item 49, but EXCLUDED (or an edit to SUITES) dropped it`);
  }
  return fast;
}
export const FAST = deriveFast();

// The four suites the changed tier always adds, whatever the diff. They are exactly MUST_STAY_FAST —
// named once, aliased here, so the "always run the fences" rule the changed tier owes to anti-drift
// item 49 cannot drift away from the fast tier's copy of the same rule.
export const FENCE_SUITES = MUST_STAY_FAST;

// ⛔ THE CHANGED-TIER MAPPING. Each entry owns a path prefix: a changed path selects the entry when it
// startsWith the prefix, and the changed tier runs the UNION of every selected entry's suites plus the
// fence suites. More specific prefixes ADD rather than replace — `hooks/_` adds the kernel suite on top
// of `hooks/`'s hooks suite, because the second run's merge protocol gates every change under a shared
// hook module (`hooks/_*.js`) on the kernel suite as well as the hooks suite. Over-inclusion is the safe
// direction here: a convenience tier that runs one suite too many costs a little time, while one that
// runs too few would let a builder merge on a green that never touched the broken path. The table is
// fenced against the tree by checkMapping() below on BOTH sides before any suite runs: it refuses a
// prefix that matches no tracked file and a suite name that is not in SUITES, and it also refuses any
// top-level tree owned by no prefix and not excused in UNOWNED_TREES, so a whole tree cannot slip
// through planning only the fences the way schemas/, release/ and spine/ first did.
export const PATH_OWNERS = [
  { prefix: 'hooks/', suites: ['hooks/hooks.test.mjs'] },
  // A shared hook module gates the kernel suite too (second-run rule); it matches `hooks/` as well, so
  // a change to `hooks/_runtime.js` plans hooks AND kernel.
  { prefix: 'hooks/_', suites: ['kernel/kernel.test.mjs'] },
  // The installed wiring the install and uninstall suites read; it also matches `hooks/`, so a snippet
  // change plans the hooks suite as well, which is the conservative direction.
  { prefix: 'hooks/settings.snippet.json', suites: ['install/install.test.mjs', 'install/uninstall.test.mjs'] },
  { prefix: 'kernel/', suites: ['kernel/kernel.test.mjs', 'kernel/schema.test.mjs', 'kernel/concurrency.test.mjs', 'kernel/reconcile.test.mjs', 'kernel/site.test.mjs'] },
  // install/, the uninstaller and the upgrader all live under install/ and own both install suites, plus
  // the D1 scoping detector suite (install/_scoping.js / _scoping.test.mjs). The release smoke is a
  // separate gate and stays separate (it is not a suite in this runner).
  { prefix: 'install/', suites: ['install/install.test.mjs', 'install/uninstall.test.mjs', 'install/_scoping.test.mjs'] },
  { prefix: 'skills/', suites: ['skills/skills.test.mjs', 'skills/respawn/boot-set.test.mjs'] },
  { prefix: 'library/', suites: ['library/library.test.mjs'] },
  { prefix: 'ops/', suites: ['ops/release-smoke.test.mjs', 'ops/project-fixtures.test.mjs', 'ops/suite-counts.test.mjs'] },
  // core/ owns core and conformance; a change under conformance/ needs only the conformance suite.
  { prefix: 'core/', suites: ['core/core.test.mjs', 'conformance/conformance.test.mjs'] },
  { prefix: 'conformance/', suites: ['conformance/conformance.test.mjs'] },
  // schemas/ is validated by the schema suite, which imports ../schemas/validate.mjs and asserts every
  // schema in schemas/ is registered; examples/todo-app's worked config is validated there too. The
  // hooks suite also reads schemas/project-config.schema.json (the mechanical reason scan found it).
  { prefix: 'schemas/', suites: ['kernel/schema.test.mjs', 'hooks/hooks.test.mjs'] },
  { prefix: 'examples/', suites: ['kernel/schema.test.mjs'] },
  // spine/ feeds the site renderer's goldens (spine/derived/*.md); the kernel suite reads
  // spine/reference/behavior-standards.md and spine/derived/LESSONS.md; the schema suite checks a
  // spine/reference/models file exists. All three own it.
  { prefix: 'spine/', suites: ['kernel/kernel.test.mjs', 'kernel/schema.test.mjs', 'kernel/site.test.mjs'] },
  // templates/CLAUDE.md is read as CONTENT by the kernel suite (the prose-first baseline fence) and by
  // the install suite (its template-section list); the uninstaller pairs with the installer over it.
  { prefix: 'templates/', suites: ['kernel/kernel.test.mjs', 'install/install.test.mjs', 'install/uninstall.test.mjs'] },
  // release/build-public.sh's DEV_ONLY split is fenced by the release-smoke suite (not the smoke itself).
  { prefix: 'release/', suites: ['ops/release-smoke.test.mjs'] },
  // Two top-level files a non-fence suite reads as content (found by the mechanical reason scan): the
  // site renderer renders the pack's own README.md as a golden, and the install suite reads VERSION to
  // prove the version-diff refresh. (counts-fence reads both too, but it is a fence and always runs.)
  { prefix: 'README.md', suites: ['kernel/site.test.mjs'] },
  { prefix: 'VERSION', suites: ['install/install.test.mjs'] },
  // Adapter paths own their own adapter suites. `adapters/codex/` covers the Codex hooks adapter; a
  // change under `adapters/codex/app-server/` adds the app-server suites on top of it.
  { prefix: 'adapters/codex/', suites: ['adapters/codex/codex-hooks.test.mjs'] },
  { prefix: 'adapters/codex/app-server/', suites: ['adapters/codex/app-server/rpc.test.mjs', 'adapters/codex/app-server/supervisor.test.mjs'] },
  { prefix: 'adapters/claude-code/sdk-supervisor/', suites: ['adapters/claude-code/sdk-supervisor/stream.test.mjs', 'adapters/claude-code/sdk-supervisor/supervisor.test.mjs'] },
  { prefix: 'adapters/claude-code/task-runner/', suites: ['adapters/claude-code/task-runner/runner.test.mjs', 'adapters/claude-code/task-runner/canary.test.mjs'] },
  { prefix: 'adapters/openai-compatible/', suites: ['adapters/openai-compatible/client.test.mjs'] },
  { prefix: 'adapters/providers/', suites: ['adapters/providers/offload.test.mjs'] },
  { prefix: 'adapters/claude-code/interactive/', suites: ['adapters/claude-code/interactive/interactive.test.mjs'] },
  { prefix: 'adapters/claude-code/statusline/', suites: ['adapters/claude-code/statusline/statusline.test.mjs'] },
];

// A suite that is in SUITES, owned by no prefix, and not a fence suite would be unreachable by the
// changed tier: a change to the tree it covers would run only the fences. That is a real possibility
// for a future suite with no natural path owner, so the fence permits it only when it is named here
// WITH a reason, the same way EXCLUDED must carry one. Empty today — every current suite is owned or a
// fence — but the escape hatch keeps the reachability check honest rather than impossible to satisfy.
export const UNOWNED_SUITES = [];

// ⛔ THE OTHER HALF OF THE FENCE: TREE COVERAGE. A mapping can be reachable from every suite's side yet
// leave a whole source tree owned by no prefix, so a change under it plans only the fences and the suite
// that actually guards it never runs. That is exactly how `schemas/`, `release/`, `spine/` and then
// `templates/` slipped through earlier versions of this file. checkMapping() below therefore also
// requires every top-level tracked tree (each first path segment from `git ls-files`, and each top-level
// file) to be either owned by a PATH_OWNERS prefix, covered by an always-run fence suite, or listed HERE
// with a one-line reason it needs no owning suite. The table is kept honest mechanically, not on trust:
// a tree listed here that a prefix DOES own is refused as stale, one no tracked path matches is refused
// as rot, and (the reason itself) one that a NON-fence suite actually reads as pack content is refused
// outright, naming the suite, so the prose excuse can never outlive the code. A reason here therefore
// only ever says "no non-fence suite reads this" or "only an always-run fence reads it".
export const UNOWNED_TREES = [
  { tree: '.github/', reason: 'CI configuration; CI runs node --test per suite directly, and no suite reads the workflow files as a test input' },
  { tree: '.respawnpack/', reason: "the pack's own runtime ledger (data, not a test input); every suite builds its own .respawnpack/ under a temp fixture" },
  { tree: 'agents/', reason: 'the subagent library; the always-run fence counts-fence.test.mjs fences its inventory, split and counts' },
  { tree: 'catalog/', reason: 'the MCP reference catalog (documentation); no suite reads it' },
  { tree: 'docs/', reason: "project documentation and development records; the always-run fence counts-fence.test.mjs fences the vision docs' counts, and docs/dev and docs/derived are not test inputs" },
  { tree: 'memory/', reason: 'the memory store and its docs; the always-run fence skills/skills.test.mjs lints memory/knowledge, and candidates and graph are data, not test inputs' },
  { tree: 'research/', reason: "collected research, explicitly excluded from the pack's own scans; no suite reads it" },
  { tree: 'workflows/', reason: "the shipped workflow scripts; the always-run fence counts-fence.test.mjs fences review.workflow.js's lenses, and CI syntax-checks the rest" },
  { tree: 'CHANGELOG.md', reason: 'read by the always-run fence counts-fence.test.mjs' },
  { tree: 'CONTRIBUTING.md', reason: 'read by the always-run fence counts-fence.test.mjs' },
  { tree: 'respawnpack.config.json', reason: 'read by the always-run fence counts-fence.test.mjs' },
  { tree: 'LICENSE', reason: 'read by the always-run fence license-contract.test.mjs' },
  { tree: 'ATTRIBUTION.md', reason: 'read by the always-run fence license-contract.test.mjs' },
  { tree: 'SECURITY.md', reason: 'a security-policy document; no suite reads it as a test input' },
  { tree: 'RESPAWN.md', reason: "the dev build-status doc; no suite reads it as a test input" },
  { tree: 'brainstorming.md', reason: 'a development scratch doc; no suite reads it as a test input' },
  { tree: '.gitignore', reason: 'repository git configuration; no suite reads it' },
  { tree: '.gitattributes', reason: 'repository git configuration; no suite reads it' },
];

/**
 * Map a set of changed paths to the suites the changed tier should run: the union of every PATH_OWNERS
 * entry whose prefix the path carries, plus the fence suites, returned in SUITES order (deduped). The
 * fences are added unconditionally, so an empty change set plans exactly the fences.
 */
export function changedSuites(paths, owners = PATH_OWNERS, fence = FENCE_SUITES, suites = SUITES) {
  const selected = new Set(fence);
  for (const raw of paths) {
    const p = raw.replace(/\\/g, '/');
    for (const owner of owners) {
      if (p.startsWith(owner.prefix)) for (const s of owner.suites) selected.add(s);
    }
  }
  return suites.filter((s) => selected.has(s));
}

/** The suite list a tier would run. `full` and `fast` ignore the change set by construction. */
export function planForTier(tier, changedPaths = []) {
  if (tier === 'full') return SUITES;
  if (tier === 'fast') return FAST;
  if (tier === 'changed') return changedSuites(changedPaths);
  throw new Error(`ops/suite-counts.mjs: unknown tier "${tier}"`);
}

/** Does a PATH_OWNERS prefix own this top-level tree? A directory segment ("kernel/") is owned when a
 * prefix equals it or sits under it ("adapters/" is owned by "adapters/codex/"); a top-level file
 * segment ("README.md") is owned only by a prefix equal to it. */
function treeOwnedByPrefix(seg, owners) {
  if (seg.endsWith('/')) return owners.some((o) => o.prefix === seg || o.prefix.startsWith(seg));
  return owners.some((o) => o.prefix === seg);
}

/** Read the source of every non-fence suite, for the mechanical reason check. Fence suites are skipped
 * because they always run, so a tree they read is already covered. This runner's OWN test is skipped
 * too: its string literals are the mapping's test fixtures (crafted read-shaped paths that exercise this
 * very scan), not reads of the pack tree, so scanning it would flag whatever tree a fixture names. ~24
 * small files, read once. */
export const SCAN_SKIP = new Set([...FENCE_SUITES, 'ops/suite-counts.test.mjs']);
export function readSuiteSources(packDir, suites = SUITES, skip = SCAN_SKIP) {
  const map = new Map();
  for (const s of suites) {
    if (skip.has(s)) continue;
    try { map.set(s, fs.readFileSync(path.join(packDir, s), 'utf8')); } catch { /* a missing suite file is caught by the fast/full run itself */ }
  }
  return map;
}

/**
 * Does `src` read the pack's own copy of `tree` as CONTENT? The reliable mechanical signal is a path
 * that reaches the tree's first segment off the pack root: either a `'..'` hop into it
 * (`path.join(KERNEL, '..', 'templates', ...)`) or a pack-root variable straight into it
 * (`path.join(ROOT_DIR, 'skills', ...)`). A temp-fixture join anchors on a per-test directory with no
 * such hop, and a literal write target (`write(repo, 'docs/derived/x')`) is a write, not a read — so
 * neither trips this, which is the whole point: it finds reads, not mentions. Returns {line, text} of
 * the first match, or null. Over-matches within the read class (a mention in a root-relative comment
 * counts) and errs toward refusing an excuse. */
export function treeReadReference(src, tree) {
  const seg = tree.endsWith('/') ? tree.slice(0, -1) : tree;
  const e = seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const q = "['\"`]";
  const res = [
    new RegExp(`${q}\\.\\.${q}\\s*,\\s*${q}${e}${q}`),
    new RegExp(`\\b(?:ROOT|PACK|PACK_ROOT|REPO_ROOT|ROOT_DIR)\\s*,\\s*${q}${e}${q}`),
  ];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (res.some((r) => r.test(lines[i]))) return { line: i + 1, text: lines[i].trim() };
  }
  return null;
}

/**
 * ⛔ FENCE THE MAPPING AGAINST THE TREE, both sides, before any suite runs. The SUITE side: (a) a prefix
 * that no tracked file carries (a typo, or a path that moved); (b) a mapping suite that is not in SUITES
 * (so nothing would run it, or it points at a file that no longer exists); (c) a SUITES entry reachable
 * from no prefix, not a fence suite, and not in UNOWNED_SUITES with a reason. The TREE side (the gap the
 * reviewer found): (d) a top-level tracked tree — each first path segment and each top-level file — that
 * is owned by no prefix, covered by no always-run fence suite, and not in UNOWNED_TREES with a reason, so
 * a change under it would plan only the fences and its real guard would never run. And the TREE table is
 * kept honest: (e) an UNOWNED_TREES entry a prefix actually owns is refused as stale, (f) one no tracked
 * path matches is refused as rot, and (g) one that a NON-fence suite actually reads as pack content is
 * refused outright, naming the suite and line — so the prose reason is mechanically checked, never
 * trusted. The tree and the suite sources are passed in so the check is pure and a test can drive every
 * failing state; suiteSources defaults to reading the non-fence suites off disk for a real invocation.
 */
export function checkMapping(owners = PATH_OWNERS, suites = SUITES, fence = FENCE_SUITES, treePaths = [], unownedTrees = UNOWNED_TREES, suiteSources) {
  const suiteSet = new Set(suites);
  const fenceSet = new Set(fence);
  const sources = suiteSources ?? readSuiteSources(PACK, suites);
  const tree = treePaths.map((p) => p.replace(/\\/g, '/'));

  // (a) every prefix exists in the tree.
  for (const { prefix } of owners) {
    if (!tree.some((f) => f.startsWith(prefix))) {
      throw new Error(`ops/suite-counts.mjs: PATH_OWNERS prefix "${prefix}" matches no file in the tree — a typo, or a path that moved or was removed`);
    }
  }

  // (b, c) suite reachability.
  const reachable = new Set();
  for (const f of fence) {
    if (!suiteSet.has(f)) throw new Error(`ops/suite-counts.mjs: FENCE_SUITES names "${f}", which is not in SUITES`);
    reachable.add(f);
  }
  for (const { prefix, suites: owned } of owners) {
    for (const s of owned) {
      if (!suiteSet.has(s)) throw new Error(`ops/suite-counts.mjs: PATH_OWNERS prefix "${prefix}" owns "${s}", which is not in SUITES — a suite that moved or was renamed`);
      reachable.add(s);
    }
  }
  for (const { suite, reason } of UNOWNED_SUITES) {
    if (!suiteSet.has(suite)) throw new Error(`ops/suite-counts.mjs: UNOWNED_SUITES names "${suite}", which is not in SUITES`);
    if (!reason || !reason.trim()) throw new Error(`ops/suite-counts.mjs: UNOWNED_SUITES entry "${suite}" carries no reason — an unowned suite must say why it is reachable by no prefix`);
    reachable.add(suite);
  }
  const unreachable = suites.filter((s) => !reachable.has(s));
  if (unreachable.length) {
    throw new Error(`ops/suite-counts.mjs: these SUITES are owned by no prefix, are not fence suites, and are not in UNOWNED_SUITES with a reason, so the changed tier could never run them: ${unreachable.join(', ')}`);
  }

  // (e, f) the tree table is kept honest before it is trusted to excuse a tree.
  const listed = new Set();
  for (const { tree: t, reason } of unownedTrees) {
    if (!reason || !reason.trim()) throw new Error(`ops/suite-counts.mjs: UNOWNED_TREES entry "${t}" carries no reason — an unowned tree must say why it needs no owning suite`);
    if (treeOwnedByPrefix(t, owners)) throw new Error(`ops/suite-counts.mjs: UNOWNED_TREES lists "${t}", but a PATH_OWNERS prefix owns it — a stale exclusion that now hides a real owner`);
    if (fenceSet.has(t)) throw new Error(`ops/suite-counts.mjs: UNOWNED_TREES lists "${t}", which is a fence suite that always runs — remove it`);
    const exists = t.endsWith('/') ? tree.some((f) => f.startsWith(t)) : tree.includes(t);
    if (!exists) throw new Error(`ops/suite-counts.mjs: UNOWNED_TREES lists "${t}", which no tracked path matches — a stale entry for a tree that moved or was removed`);
    // (g) the reason is mechanical, not prose on trust: if a non-fence suite actually reads this tree as
    // pack content, the excuse is a lie and the tree needs a real owner. This is the check that would
    // have caught templates/ (read by the kernel and install suites) the first time.
    for (const [suite, src] of sources) {
      const ref = treeReadReference(src, t);
      if (ref) throw new Error(`ops/suite-counts.mjs: UNOWNED_TREES excuses "${t}", but the non-fence suite ${suite}:${ref.line} reads it (${ref.text.slice(0, 80)}) — give "${t}" a real owner in PATH_OWNERS instead of an excuse`);
    }
    listed.add(t);
  }

  // (d) every top-level tree is owned, fence-covered, or listed.
  const topLevel = new Set();
  for (const p of tree) {
    const i = p.indexOf('/');
    topLevel.add(i === -1 ? p : p.slice(0, i + 1));
  }
  const uncovered = [...topLevel].filter((seg) => !treeOwnedByPrefix(seg, owners) && !fenceSet.has(seg) && !listed.has(seg)).sort();
  if (uncovered.length) {
    throw new Error(`ops/suite-counts.mjs: these top-level trees are owned by no PATH_OWNERS prefix and are not in UNOWNED_TREES with a reason, so a change under them would plan only the fences and their real guard would never run: ${uncovered.join(', ')}`);
  }
}

/**
 * The paths a builder's branch has changed against `main`: committed, staged and working-tree changes
 * (`git diff --name-only <base>`) plus untracked files (`git ls-files --others --exclude-standard`). A
 * git failure throws rather than returning an empty set, because an undetermined change set that
 * silently planned only the fences would under-test — "could not run" is a distinct state, never a pass.
 */
export function gitChangedPaths(packDir, base = 'main') {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: packDir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
    return r.stdout.split(/\r?\n/).filter(Boolean);
  };
  const diffed = run(['diff', '--name-only', base]);
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...diffed, ...untracked])];
}

/** Every tracked path, for fencing the mapping's prefixes against the tree. */
export function gitTreePaths(packDir) {
  const r = spawnSync('git', ['ls-files'], { cwd: packDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * Parse the node:test summary in either reporter form — TAP (`# tests 225`) or spec (`ℹ tests 225`),
 * since node picks by TTY. Returns {tests, pass, fail} or throws naming what is absent. Each label is
 * anchored and matched apart from the others — a regex loose enough to confuse `pass` with `tests`
 * (or `tests` with `suites`) would be the vacuous extractor this file exists to forbid.
 */
export function extract(suite, output) {
  const grab = (label) => {
    const m = output.match(new RegExp(`^(?:# |\\u2139 )${label}\\s+(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const tests = grab('tests');
  const pass = grab('pass');
  const fail = grab('fail');
  const absent = [['tests', tests], ['pass', pass], ['fail', fail]].filter(([, v]) => v === null).map(([k]) => k);
  if (absent.length) throw new Error(`${suite}: could not extract ${absent.join(', ')} from the runner output — refusing to report a number nobody measured`);
  if (pass + fail !== tests) throw new Error(`${suite}: pass ${pass} + fail ${fail} != tests ${tests} — the arithmetic does not close, so this run cannot be reported`);
  return { tests, pass, fail };
}

function usage() {
  return 'usage: node ops/suite-counts.mjs [--tier fast|full|changed] [--plan] [--paths <csv>] [--json <file>]';
}

function main(argv) {
  const value = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
  // --tier parsing. Refuses an unrecognized value before any suite runs — a typo must never silently
  // fall back to running everything (too slow to notice) or nothing (too quiet to notice).
  const tier = value('--tier') ?? 'full';
  if (tier !== 'fast' && tier !== 'full' && tier !== 'changed') {
    console.error(`unrecognized --tier "${tier}" — ${usage()}`);
    process.exit(1);
  }
  const planOnly = argv.includes('--plan');
  const pathsOverride = value('--paths');

  let list;
  if (tier === 'changed') {
    // The mapping is fenced against the tree before it can be trusted to pick suites.
    let treePaths;
    try { treePaths = gitTreePaths(PACK); } catch (e) { console.error(`ops/suite-counts.mjs: could not list the tree to fence the mapping — ${e.message}`); process.exit(1); }
    try { checkMapping(PATH_OWNERS, SUITES, FENCE_SUITES, treePaths); } catch (e) { console.error(e.message); process.exit(1); }

    let changed;
    if (pathsOverride !== undefined) {
      changed = pathsOverride.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      try { changed = gitChangedPaths(PACK); } catch (e) { console.error(`ops/suite-counts.mjs: could not derive the changed paths from the diff against main — ${e.message}`); process.exit(1); }
    }
    list = changedSuites(changed);
    if (planOnly) {
      const origin = pathsOverride !== undefined ? 'from --paths' : 'from the diff against main plus untracked';
      console.log(`plan: --tier changed · ${changed.length} changed path(s) ${origin} · ${list.length} suite(s) would run`);
      for (const s of list) console.log(`  ${s}${FENCE_SUITES.includes(s) ? '  (fence)' : ''}`);
      process.exit(0);
    }
  } else {
    list = planForTier(tier);
    if (planOnly) {
      console.log(`plan: --tier ${tier} · ${list.length} suite(s) would run`);
      for (const s of list) console.log(`  ${s}`);
      process.exit(0);
    }
  }

  const rows = [];
  let bad = 0;
  for (const suite of list) {
    // The hooks and installed-layout suites intentionally spawn hundreds of real child processes, so the
    // ceiling must sit well ABOVE their real runtime, not at it. The old 900,000 ms (15 min) ceiling
    // killed a healthy hooks suite under load: hooks/hooks.test.mjs alone took 711s and then 790s on this
    // machine inside the full tier and was cut off at the 900s mark, after which the extractor (correctly)
    // refused to invent a count for a run that never printed its summary. 1,800,000 ms (30 min) clears the
    // worst observed run with headroom while still bounding a genuinely hung suite. (The idle, lighter-load
    // figure in EXCLUDED's note, ~279s, is the first-run measurement, not this ceiling's reference point.)
    const started = Date.now();
    const r = spawnSync(process.execPath, ['--test', path.join(PACK, suite)], { encoding: 'utf8', cwd: PACK, timeout: 1_800_000 });
    const wallMs = Date.now() - started;
    const output = `${r.stdout}\n${r.stderr}`;
    let row;
    try {
      const c = extract(suite, output);
      row = { suite, ...c, exit: r.status, wallMs, ok: r.status === 0 && c.fail === 0 };
    } catch (e) {
      row = { suite, tests: null, pass: null, fail: null, exit: r.status, wallMs, ok: false, error: e.message };
    }
    if (!row.ok) bad += 1;
    rows.push(row);
    console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${suite.padEnd(30)} tests=${row.tests ?? '?'} pass=${row.pass ?? '?'} fail=${row.fail ?? '?'} exit=${row.exit} wall=${wallMs}ms${row.error ? `\n       ${row.error}` : ''}`);
  }

  const parsed = rows.filter((r) => r.tests !== null);
  const total = { suites: rows.length, parsed: parsed.length, tests: parsed.reduce((a, r) => a + r.tests, 0), pass: parsed.reduce((a, r) => a + r.pass, 0), fail: parsed.reduce((a, r) => a + r.fail, 0), wallMs: rows.reduce((a, r) => a + r.wallMs, 0) };
  console.log(`\ntotal: ${total.tests} tests · ${total.pass} pass · ${total.fail} fail · ${total.parsed}/${total.suites} suites parsed · ${total.wallMs} ms wall${bad ? ' · ⛔ NOT A CLEAN RUN' : ''}`);

  const jsonFlag = argv.indexOf('--json');
  if (jsonFlag !== -1 && argv[jsonFlag + 1]) {
    fs.writeFileSync(argv[jsonFlag + 1], JSON.stringify({ at: null, tier, rows, total, clean: bad === 0 }, null, 2));
  }
  process.exit(bad ? 1 : 0);
}

// Run the CLI only when invoked directly, so a test can import the pure functions above without the
// top-level run firing (and without executing a single real suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
