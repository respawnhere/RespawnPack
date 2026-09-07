// RespawnPack counts fence — node:test + node:assert only (zero new dependencies, per pack philosophy).
//
// WHY THIS EXISTS: the pack's own docs carry load-bearing numbers ("32 tool-scoped subagents",
// "fourteen governance hooks", "21 per-requirement checklists") that silently rot as directories
// evolve — nothing else ties the prose to the tree. agents/README.md's "Source of truth" section
// already states the rule: when a summary drifts from the files, the files win and the summary
// gets fixed. This suite makes that rule executable for every count line in README.md,
// docs/vision/ARCHITECTURE.md, CONTRIBUTING.md, and agents/README.md (plus the same numbers'
// echoes in install/README.md, which sits outside the four but repeats two of the counts).
//
// Two-sided fence: each assertion first requires the claim to still MATCH (rewording a count line
// without updating this file fails here — the fence must move with the prose, never silently stop
// checking), then requires the claimed number to equal the directory-derived truth.
//
// Run:
//   node --test counts-fence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // this file lives at the repo root

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/*
 * Some fences below guard a DEVELOPMENT artifact rather than a shipped one — the changelog and the
 * architecture decision records exist while the pack is being built and are not part of the
 * published package. In the tree where those files live, the fence runs and is as strict as ever.
 * Against the published tree it has nothing to check, and a hard read would fail on a file whose
 * absence is correct.
 *
 * ⛔ THE DISTINCTION THAT MATTERS, because P5 below warns against exactly the wrong version of this:
 * a fence may stand down only when its subject is ABSENT, never when the subject is present but has
 * changed. "The ADR was reworded so the check no longer matches" must still fail loudly. Absence is
 * a different fact from disagreement, and only absence is permitted to skip.
 */
const devArtifact = (rel) => fs.existsSync(path.join(ROOT, rel));
const listFiles = (rel, keep = () => true) =>
  fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).filter((e) => e.isFile() && keep(e.name)).map((e) => e.name);

// The docs spell small counts as words ("fourteen governance hooks", "Thirty-two ... subagents");
// the fence reads both spellings so a claim can't dodge it by switching form.
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  'twenty-one': 21, 'thirty-two': 32,
};
function toNumber(raw) {
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;
  const word = WORD_NUMBERS[raw.toLowerCase()];
  assert.notEqual(word, undefined, `"${raw}" is neither a digit string nor a number word this fence knows — extend WORD_NUMBERS`);
  return word;
}
// Asserts the claim exists (at least once) and that EVERY occurrence carries the expected number.
// The capture group in `re` must isolate the number (digits or a number word).
function expectClaim(fileRel, re, expected, label) {
  const matches = [...read(fileRel).matchAll(re)];
  assert.ok(matches.length, `${fileRel}: expected to find the "${label}" count line (/${re.source}/) — if the prose was reworded, update this fence with it`);
  for (const m of matches) {
    assert.equal(toNumber(m[1]), expected, `${fileRel}: "${label}" claims ${m[1]} but the tree says ${expected} — fix the prose (the directories are the source of truth)`);
  }
}

// ---------------------------------------------------------------------------------------------
// Directory-derived truth
// ---------------------------------------------------------------------------------------------
const agentFiles = listFiles('agents', (f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.replace(/\.md$/, ''));
const AGENTS_TOTAL = agentFiles.length;
const REVIEW_LENSES = agentFiles.filter((f) => f.endsWith('-reviewer')).length;
// The write-scoped mappers are identified by their actual tool grant, not by name: the frontmatter
// `tools:` line carrying Write is the property the docs' "2 write-scoped" claims are ABOUT.
const MAPPERS = agentFiles.filter((f) => {
  const fm = read(`agents/${f}.md`).match(/^---\r?\n[\s\S]*?^---/m);
  const tools = fm && fm[0].match(/^tools:\s*(.+)$/m);
  return tools && /\bWrite\b/.test(tools[1]);
}).length;
const ADVISORS = AGENTS_TOTAL - REVIEW_LENSES - MAPPERS;
// Node hooks; the pre-push git-hook sample is counted separately by the prose. Leading-underscore files
// are EXCLUDED: the six shared modules (`_runtime.js`, `_cmd.js`, `_shell.js`, `_git-effect.js`,
// `_index-lease.js`, `_manifest.js`) are libraries the hooks require, never wired to an event. Counting a
// library as a governance hook would make the docs' "fifteen" false in the other direction — the fence
// measures hooks, not FILES: the directory also holds the suites and `_harness.mjs`.
//
// ⛔ AND `dispatch.js` IS EXCLUDED BY NAME, WITH THE REASON, FOR THE SAME REASON THE LIBRARIES ARE
// (P4-T-15b). It enforces nothing, carries no rule id, has no row in ADR-003's table and no entry in
// `install/_settings-manifest.js`'s RULES_BY_HOOK: it is the ENTRY POINT that runs the guards, one
// process per PreToolUse registration group, on the profiles that compose it. Counting it would make
// every "fifteen governance hooks" sentence in the repo say sixteen and each of them would then be
// FALSE - there would still be fifteen guards. The exclusion is a named set rather than a pattern so a
// second entry point cannot join it silently, and the test below proves the file it names is really
// there, which is what stops this from being a way to hide a hook from the count.
const NOT_GUARDS = new Set(['dispatch.js']);
const HOOKS = listFiles('hooks', (f) => f.endsWith('.js') && !f.startsWith('_') && !NOT_GUARDS.has(f)).length;
const CHECKLISTS = listFiles('library/compliance/requirements', (f) => f.endsWith('.md')).length;
const STANDARDS = listFiles('spine/reference', (f) => f.endsWith('-standards.md')).length;

// agents/README.md's section tables are the one place the engineering-vs-business advisor split is
// defined, so the fence first proves those tables partition the files on disk exactly (every agent
// in exactly one row, no phantom rows), then treats the per-section row counts as derived truth for
// the split claims in README.md and the word-number sentences beside the tables themselves.
function tableRows(sectionMd) {
  return [...sectionMd.matchAll(/^\|\s*\[`([\w-]+)\.md`\]/gm)].map((m) => m[1]);
}
function section(md, heading) {
  const m = md.match(new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
  assert.ok(m, `agents/README.md: section "## ${heading}" not found — if it was renamed, update this fence`);
  return m[1];
}

test('agents/README.md section tables partition the agent files on disk exactly', () => {
  const md = read('agents/README.md');
  const rows = {
    lenses: tableRows(section(md, 'Review lenses')),
    engineering: tableRows(section(md, 'Engineering and infra')),
    business: tableRows(section(md, 'Business and research')),
    mappers: tableRows(section(md, 'Onboarding mappers (write-scoped — the one exception)')),
  };
  const all = [...rows.lenses, ...rows.engineering, ...rows.business, ...rows.mappers];
  assert.equal(new Set(all).size, all.length, 'no agent may appear in two section tables');
  assert.deepEqual([...all].sort(), [...agentFiles].sort(), 'the four tables together must list exactly the agent files on disk — a new agent needs a row, a removed one loses its row');
  assert.equal(rows.lenses.length, REVIEW_LENSES, 'the Review lenses table must hold exactly the *-reviewer agents');
  assert.equal(rows.mappers.length, MAPPERS, 'the Onboarding mappers table must hold exactly the Write-granted agents');
  assert.equal(rows.engineering.length + rows.business.length, ADVISORS, 'the two advisor tables must hold exactly the non-lens, non-mapper agents');
});

// The engineering/business row counts double as derived truth for the split claims below.
const md = read('agents/README.md');
const ENGINEERING = tableRows(section(md, 'Engineering and infra')).length;
const BUSINESS = tableRows(section(md, 'Business and research')).length;

test('agents/README.md word-number sentences match its own tables and the tree', () => {
  expectClaim('agents/README.md', /^([\w-]+) \[Claude Code project subagents\]/gm, AGENTS_TOTAL, 'Thirty-two ... subagents opener');
  expectClaim('agents/README.md', /^([\w-]+) lenses, all fan-out targets/gm, REVIEW_LENSES, 'Six lenses');
  expectClaim('agents/README.md', /^([\w-]+) advisors covering system design/gm, ENGINEERING, 'Eleven advisors (engineering)');
  expectClaim('agents/README.md', /^([\w-]+) advisors covering product judgment/gm, BUSINESS, 'Thirteen advisors (business)');
  expectClaim('agents/README.md', /The (\d+) role agents are RespawnPack-original/g, AGENTS_TOTAL, 'attribution total');
});

test('README.md count claims match the tree', () => {
  expectClaim('README.md', /the (\d+)-role agent bench/g, AGENTS_TOTAL, 'agent bench total');
  expectClaim('README.md', /A (\d+)-role specialist bench/g, AGENTS_TOTAL, 'specialist bench heading');
  expectClaim('README.md', /installs (\d+) tool-scoped subagents/g, AGENTS_TOTAL, 'installed subagent total');
  expectClaim('README.md', /the (\d+)-role subagent library/g, AGENTS_TOTAL, 'subagent library total');
  expectClaim('README.md', /(\d+) review lenses/g, REVIEW_LENSES, 'review lenses');
  expectClaim('README.md', /(\d+) advisors across engineering/g, ADVISORS, 'advisors total');
  expectClaim('README.md', /(\d+) engineering\/infra advisors/g, ENGINEERING, 'engineering advisors');
  expectClaim('README.md', /(\d+) business\/research advisors/g, BUSINESS, 'business advisors');
  expectClaim('README.md', /(\d+) write-scoped onboarding mappers/g, MAPPERS, 'onboarding mappers');
  expectClaim('README.md', /(\d+) per-requirement (?:NA\/EU )?checklists/g, CHECKLISTS, 'compliance checklists');
});

test('docs/vision/ARCHITECTURE.md count claims match the tree', () => {
  expectClaim('docs/vision/ARCHITECTURE.md', /(\d+) tool-scoped Claude Code subagents/g, AGENTS_TOTAL, 'subagent total');
  expectClaim('docs/vision/ARCHITECTURE.md', /the (\d+)-role subagent library/g, AGENTS_TOTAL, 'layout-row total');
  expectClaim('docs/vision/ARCHITECTURE.md', /the (\d+) role agents/g, AGENTS_TOTAL, 'installed-agents line');
  expectClaim('docs/vision/ARCHITECTURE.md', /(\d+) review lenses/g, REVIEW_LENSES, 'review lenses');
  expectClaim('docs/vision/ARCHITECTURE.md', /(\d+) advisory roles across/g, ADVISORS, 'advisory roles');
  expectClaim('docs/vision/ARCHITECTURE.md', /(\d+) engineering\/business advisors/g, ADVISORS, 'layout-row advisors');
  expectClaim('docs/vision/ARCHITECTURE.md', /(\d+) (?:write-scoped )?onboarding mappers/g, MAPPERS, 'onboarding mappers');
  // ⛔ README.md's OWN hook count was unfenced. A Unit 7 mutation changed "the fifteen governance hooks"
  // to "fourteen" and this suite stayed 12 pass / 0 fail — while the same edit in install/README.md and
  // hooks/README.md both died. It is the most-read spelling of that number in the repo, and it was the
  // one nothing pinned.
  expectClaim('README.md', /the ([\w-]+) governance hooks/g, HOOKS, 'README governance hooks');
  expectClaim('docs/vision/ARCHITECTURE.md', /([\w-]+)(?: Node)? governance hooks/g, HOOKS, 'governance hooks');
});

test('CONTRIBUTING.md and install/README.md echo the same hook and standards counts', () => {
  expectClaim('CONTRIBUTING.md', /;\s*(\d+) in total\)/g, HOOKS, 'hooks row total');
  expectClaim('install/README.md', /the ([\w-]+) Node hooks/g, HOOKS, 'Node hooks list');
  // The anchor was `standards —` until P6-N-7 removed em-dashes from prose (anti-drift item 48). The
  // claim, the capture group and the derived number are unchanged; only the delimiter that ends the
  // match moved, so this stays as two-sided as it was.
  expectClaim('install/README.md', /the ([\w-]+) standards, which are/g, STANDARDS, 'standards enumeration');
});

// hooks/README.md's own opening sentence states the count, and NOTHING read it — so it sat at
// "Fourteen" through a release that shipped fifteen. The pack's most-read hook document was the one
// surface the count fence did not cover.
// ⛔ THE EXCLUSION IS ONLY HONEST WHILE THE EXCLUDED FILE EXISTS. A name that no longer matches
// anything on disk is a count adjustment with nothing behind it, and this is the shape that would let
// somebody drop a guard out of the total by adding its filename above.
test('every hooks/ file excluded from the governance-hook count is really on disk and really not a guard', () => {
  const present = new Set(listFiles('hooks', (f) => f.endsWith('.js')));
  for (const name of NOT_GUARDS) {
    assert.ok(present.has(name), `${name} is excluded from the governance-hook count but is not in hooks/ - remove the exclusion or restore the file`);
    const src = read(`hooks/${name}`);
    assert.match(src, /NOT A GOVERNANCE HOOK/,
      `${name} is excluded from the governance-hook count, so its own header has to say so - an exclusion whose file does not agree with it is a silent count adjustment`);
  }
  // The one thing the count claim rests on: the excluded file carries no rule id, so no posture row and
  // no composition decision can be hiding behind it.
  const rules = read('install/_settings-manifest.js');
  for (const name of NOT_GUARDS) {
    assert.ok(!rules.includes(`'${name}': [`),
      `${name} is excluded from the governance-hook count but RULES_BY_HOOK assigns it rule ids - then it IS a guard and the count is wrong`);
  }
});

test('hooks/README.md states the derived hook count in its opener', () => {
  expectClaim('hooks/README.md', /The safety layer most solo setups skip\. ([\w-]+) hooks/g, HOOKS, 'hooks README opener');
  expectClaim('hooks/README.md', /excluded from the "([\w-]+)" count/g, HOOKS, 'hooks README shared-module note');
});

/*
 * ⛔ THE SHARED-MODULE INVENTORY FENCE.
 *
 * A hook's `require()` list, the installer's copy list, the uninstaller's removal list and the manual
 * install command in the docs are FOUR representations of one set, and they drifted the moment the set
 * grew: `_shell.js` and `_git-effect.js` shipped in the installer while `hooks/README.md` still said
 * "four files", its `cp` line still omitted both, `install/README.md` listed neither, and
 * ARCHITECTURE.md named only two. Nothing failed — a reader following the documented manual install
 * would simply have produced a target where every governance hook dies on MODULE_NOT_FOUND.
 *
 * The `require()` graph is the source of truth here, because it is the thing execution actually needs.
 */
test('every shared module a hook requires appears in the installer, the uninstaller and the docs', () => {
  const hookFiles = listFiles('hooks', (f) => f.endsWith('.js'));
  /*
   * ⛔ TWO SPELLINGS, BOTH EDGES. `require('./_x.js')` is the plain one; every hook with shared
   * dependencies now binds through `boot.need('./_x.js')`, because a bare require of a module that
   * cannot load kills the hook before it can emit its conservative answer. A scan that knew only the
   * first found ONE module (`_boot.js`) and would have let the installer drop the other seven.
   */
  const EDGE = /(?:require|\.need)\(['"]\.\/(_[\w-]+\.js)['"]\)/g;
  const required = new Set();
  for (const f of hookFiles.filter((h) => !h.startsWith('_'))) {
    for (const m of read(`hooks/${f}`).matchAll(EDGE)) required.add(m[1]);
  }
  // Modules a module requires travel too — the graph is transitive, and `_runtime.js` delegating its
  // lock to `_index-lease.js` is exactly the edge a hook-only scan would miss.
  for (let grew = true; grew;) {
    grew = false;
    for (const mod of [...required]) {
      for (const m of read(`hooks/${mod}`).matchAll(EDGE)) {
        if (!required.has(m[1])) { required.add(m[1]); grew = true; }
      }
    }
  }
  assert.ok(required.size >= 8,
    `the require scan found only ${required.size} shared modules — the pack ships eight, so the edge pattern has drifted`);
  assert.ok(required.size >= 2, 'the require scan found almost nothing — the pattern it matches must have changed');

  const onDisk = new Set(hookFiles.filter((f) => f.startsWith('_')));
  for (const mod of required) assert.ok(onDisk.has(mod), `hooks require ${mod}, which is not in hooks/`);

  const sorted = [...required].sort();
  const bare = sorted.map((m) => m.replace(/\.js$/, ''));

  const installer = read('install/install.js');
  const uninstaller = read('install/uninstall.js');
  const hooksReadme = read('hooks/README.md');
  const installReadme = read('install/README.md');
  const architecture = read('docs/vision/ARCHITECTURE.md');

  // The manual `cp hooks/{...}` brace list is the command a human actually runs.
  const cpLine = /cp hooks\/\{([^}]+)\}/.exec(hooksReadme);
  assert.ok(cpLine, 'hooks/README.md: the manual copy command could not be found — if it was reworded, update this fence with it');
  const cpNames = new Set(cpLine[1].split(',').map((s) => s.trim()));

  for (const mod of sorted) {
    assert.ok(installer.includes(`'${mod}'`), `install/install.js does not place ${mod} — every installed hook would die on MODULE_NOT_FOUND`);
    assert.ok(uninstaller.includes(`'${mod}'`), `install/uninstall.js does not remove ${mod} — uninstall would leave an orphaned library behind`);
    assert.ok(cpNames.has(mod.replace(/\.js$/, '')), `hooks/README.md's manual copy command omits ${mod} — following the documented install produces a broken target`);
    assert.ok(installReadme.includes(`\`${mod}\``), `install/README.md does not list ${mod} among the shared modules`);
    assert.ok(architecture.includes(`\`${mod}\``), `docs/vision/ARCHITECTURE.md does not list ${mod} among the shared modules`);
  }

  /*
   * ⛔ AND A SHARED MODULE THE KERNEL REACHES BUT NO HOOK REQUIRES IS STILL A SHARED MODULE, WHICH THE
   * REQUIRE-GRAPH SCAN ABOVE CANNOT SEE AT ALL.
   *
   * The kernel does not reach the hook tree by `require('./…')`. It resolves the one relative path both
   * layouts share — `path.resolve(__dirname, '..', 'hooks', 'x.js')` — and probes it, which is invisible
   * to every regex above. `_posture.js` sat in exactly that state until `index-guard.js` began resolving
   * its rules through it, and `_exceptions.js` (P1-E-1a) sat there for one task: only `doctor`'s `exceptions`
   * row read it until the guards that consume the grammar landed (E-1b to E-1d). A module in that state
   * is INVISIBLE to the scan above, so nothing would have caught it being placed by the installer and
   * forgotten by the uninstaller, or documented in a manual copy command a reader follows to produce a
   * target whose kernel probes a reader nobody copied.
   *
   * Derived from the kernel's own source in the SAME spelling kernel/kernel.test.mjs derives CROSS_TREE
   * and KERNEL_CROSS_TREE from, widened by one file: `respawnpack.js` reaches the hook tree too, and
   * CROSS_TREE covers only `kernel/lib/`. Comments are stripped first — a path named in prose is not a
   * read.
   */
  const kernelOnly = (() => {
    const rels = ['kernel/respawnpack.js', ...listFiles('kernel/lib', (f) => f.endsWith('.js')).map((f) => `kernel/lib/${f}`)];
    const out = new Set();
    for (const rel of rels) {
      const text = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const m of text.matchAll(/'hooks',\s*'([_\w.-]+\.js)'/g)) out.add(m[1]);
    }
    return [...out].filter((m) => !required.has(m)).sort();
  })();

  for (const mod of kernelOnly) {
    assert.ok(onDisk.has(mod), `the kernel reaches ${mod} cross-tree, and it is not in hooks/`);
    assert.ok(installer.includes(`'${mod}'`), `install/install.js does not place ${mod} — the kernel would probe a reader that was never placed`);
    assert.ok(uninstaller.includes(`'${mod}'`), `install/uninstall.js does not remove ${mod} — uninstall would leave an orphaned library behind`);
    assert.ok(cpNames.has(mod.replace(/\.js$/, '')), `hooks/README.md's manual copy command omits ${mod} — following the documented install produces an incomplete target`);
    assert.ok(hooksReadme.includes(`\`${mod}\``), `hooks/README.md does not describe ${mod} among the shared modules`);
  }

  // And the prose counts of that set must equal it, in both places that spell it out.
  //
  // ⛔ TWO DIFFERENT COUNTS, AND THEY ARE NOT INTERCHANGEABLE. `install/README.md` and ARCHITECTURE.md
  // say "the shared modules they/the hooks REQUIRE", which is the require graph and nothing else.
  // `hooks/README.md` counts the modules IN THE DIRECTORY that are not hooks, which is that set plus the
  // ones only the kernel reaches — a reader copying files by hand needs all of them.
  const inDirectory = sorted.length + kernelOnly.length;
  expectClaim('hooks/README.md', /\*\*([\w-]+) shared modules in this directory are not hooks\*\*/g, inDirectory, 'hooks README shared-module count');
  expectClaim('install/README.md', /plus the ([\w-]+) shared modules they require/g, sorted.length, 'install README shared-module count');
  expectClaim('docs/vision/ARCHITECTURE.md', /plus ([\w-]+) shared modules the hooks require/g, sorted.length, 'ARCHITECTURE shared-module count');
  // The README also promises the reader copies all of them — and "the hooks fail to load" is the
  // consequence for the require-graph ones only, so the sentence says what actually happens instead.
  expectClaim('hooks/README.md', /copy all ([\w-]+) or the target is incomplete/g, inDirectory, 'hooks README copy-all count');
  assert.deepEqual(bare.length, sorted.length);
});

/*
 * ⛔ NO SHIPPED SOURCE FILE MAY CONTAIN A LITERAL NUL.
 *
 * `_index-lease.js` shipped with three of them inside a template literal — a `\u0000` I meant to escape
 * and wrote raw. The consequences were entirely invisible until something needed to read the file:
 * git classified the module as BINARY (so diffs became useless), grep skipped it silently, and the
 * editing tooling could not match text around the byte. A control character you cannot see in review
 * is a control character nobody reviews.
 */
/*
 * ⛔ AND THE FIRST VERSION OF THIS FENCE CONTAINED ONE ITSELF — in the very sentence explaining the
 * rule, because the byte was pasted where the escape belonged. It also scanned a hand-listed set of
 * directories that excluded root-level `.mjs`, so it could not inspect itself. Both are why the
 * inventory below is DERIVED FROM GIT rather than typed out, and why this prose always spells the byte
 * as its escape and never contains it.
 */
test('no tracked JS/MJS file contains byte zero, and git treats them all as text', () => {
  // Recursive, from tracked files, including this fence. Vendored third-party clones are excluded:
  // their hygiene belongs to their upstreams, and findings there would be noise we cannot act on.
  const tracked = execFileSync('git', ['ls-files', '--', '*.js', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !p.startsWith('research/') && !p.startsWith('graphify-8/') && !p.includes('node_modules/'));

  assert.ok(tracked.includes('counts-fence.test.mjs'), 'the fence must be inside its own inventory');
  assert.ok(tracked.length > 20, `expected a substantial source inventory, got ${tracked.length}`);

  const offenders = tracked.filter((p) => fs.readFileSync(path.join(ROOT, p)).includes(0));
  assert.deepEqual(offenders, [], `byte zero in tracked source: ${offenders.join(', ')}`);

  // And git must AGREE these are text — the property that actually breaks when they are not. `-I`
  // makes git skip binary files, so a tracked source missing from this listing is one git has decided
  // it cannot diff or search.
  const searchable = new Set(
    execFileSync('git', ['grep', '-I', '-l', '-e', '.', '--', '*.js', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\\/g, '/')),
  );
  const opaque = tracked.filter((p) => !searchable.has(p));
  assert.deepEqual(opaque, [], `git cannot text-search these tracked sources (it considers them binary): ${opaque.join(', ')}`);
});

// Test-count claims in prose rot the instant a test is added — kernel/README.md said "32 kernel tests"
// while the suite had grown to 38, inside the very layer whose whole argument is that hand-carried
// numbers drift. So the count is derived from the tree the same way every other fence here works.
test('test-count claims match the suites on disk', () => {
  const countTests = (rel) => [...read(rel).matchAll(/^\s*test\(/gm)].length;
  expectClaim('kernel/README.md', /\((\d+) tests\)/g, countTests('kernel/kernel.test.mjs'), 'kernel test count');
});

// P-016 · kernel/README.md's bootstrap paragraph named eight lazily-loaded subsystems (`state` through
// `assert`) while kernel/lib/modhealth.js's own SUBSYSTEMS registry had grown to ten — `reconcile` and
// `applicability` shipped with no mention in the sentence, so a reader was told two live subsystems do
// not exist. Loaded from the registry itself (not regexed off its source) because the object literal's
// entries are not uniformly shaped — some are one-liners, some span several lines — so only the real
// keys are reliable. Checked both directions: a registered subsystem missing from the sentence UNDER-
// claims what modhealth carries, and a sentence name that is not a registered key OVER-claims it.
test('kernel/README.md subsystem sentence matches modhealth.SUBSYSTEMS exactly', () => {
  const modhealth = createRequire(import.meta.url)(path.join(ROOT, 'kernel', 'lib', 'modhealth.js'));
  const registered = Object.keys(modhealth.SUBSYSTEMS);
  assert.ok(registered.length > 0, 'kernel/lib/modhealth.js SUBSYSTEMS is empty — nothing to check the README sentence against');

  const readme = read('kernel/README.md').replace(/\s*\n>?\s*/g, ' ');
  // The delimiters were em-dashes until P6-N-7 removed them from prose (anti-drift item 48). Same
  // sentence, same capture of the named list, same both-directions comparison against SUBSYSTEMS;
  // only the punctuation that brackets the list changed.
  const sentence = /Every other kernel subsystem \(([^)]*)\) is loaded lazily through `modhealth`/.exec(readme);
  assert.ok(sentence, 'kernel/README.md: the "Every other kernel subsystem" sentence could not be found — if it was reworded, update this fence with it');
  const named = [...sentence[1].matchAll(/`([\w-]+)`/g)].map((m) => m[1]);

  const namedSet = new Set(named);
  const missingFromSentence = registered.filter((s) => !namedSet.has(s));
  assert.deepEqual(missingFromSentence, [],
    `kernel/lib/modhealth.js registers ${missingFromSentence.join(', ')}, which kernel/README.md's subsystem sentence does not name — a reader is told fewer lazily-loaded subsystems exist than actually do`);

  const registeredSet = new Set(registered);
  const notRegistered = named.filter((n) => !registeredSet.has(n));
  assert.deepEqual(notRegistered, [],
    `kernel/README.md's subsystem sentence names ${notRegistered.join(', ')}, which kernel/lib/modhealth.js does not register in SUBSYSTEMS — a reader is told a subsystem is lazily loaded that does not exist`);
});

// P-017 · VERSION is this repo's own declared authority ("the single source for the version any doc
// cites" — respawnpack.config.json's own codeTruthNote) and respawnpack.config.json's `respawnpack`
// field drifted to "0.3.0" while VERSION stayed "0.2.0" — a config the pack ships as its own dogfood
// proof, disagreeing with the file it names as authoritative. Compared to the trimmed file content,
// never a restated digit, so a future bump only has one place to happen for this fence to keep passing.
test('respawnpack.config.json version matches VERSION', () => {
  const version = read('VERSION').trim();
  const config = JSON.parse(read('respawnpack.config.json'));
  assert.equal(config.respawnpack, version,
    `respawnpack.config.json declares respawnpack "${config.respawnpack}" but VERSION says "${version}" — VERSION is authoritative, so the config is wrong`);
});

/*
 * The quality gate's vocabulary is stated in three places — the code, the installed workflow template,
 * and the kernel README. A gate whose docs promise a word the code cannot return is the same class of
 * defect the gate itself exists to end, so the names are fenced rather than trusted.
 *
 * ⭐ RE-AIMED BY K-09, at the same two documents. The gate no longer owns an outcome vocabulary: it
 * owns a MAPPING from its own diagnostic labels onto kernel/lib/outcome.js's four outcomes, and both
 * halves of that mapping are read here from the code. Reading only the left column would let a label
 * be re-pointed at a different outcome — the one edit that silently moves an exit code — with no
 * fence firing, so the mapped values are checked against outcome.js's own enum too.
 */
test('the quality gate outcome vocabulary matches the code', () => {
  const outcome = createRequire(import.meta.url)('./kernel/lib/outcome.js');
  const block = /const LABEL_OUTCOME = \{([\s\S]*?)\n\};/.exec(read('kernel/lib/gate.js'));
  assert.ok(block, 'kernel/lib/gate.js no longer declares LABEL_OUTCOME as a literal object — re-aim this fence rather than deleting it');

  const pairs = [...block[1].matchAll(/^\s{2}([A-Z_]+):\s*OUTCOME\.([A-Z_]+),/gm)].map((m) => [m[1], m[2]]);
  const labels = pairs.map(([l]) => l).sort();
  assert.deepEqual(labels, ['COULD_NOT_RUN', 'FAIL', 'NOT_APPLICABLE', 'NOT_CONFIGURED', 'PASS'],
    'kernel/lib/gate.js no longer maps exactly the five documented gate labels');

  // Every label lands on a real outcome, and the two that mean "could not establish anything" land on
  // the one that has its own exit code. NOT a restatement of the table: this is the property the table
  // exists to hold, which is why it is spelled as a rule rather than copied as a second table.
  for (const [label, mapped] of pairs) {
    assert.ok(mapped in outcome.OUTCOME, `kernel/lib/gate.js maps ${label} to ${mapped}, which kernel/lib/outcome.js does not define`);
    if (label === 'NOT_CONFIGURED' || label === 'COULD_NOT_RUN') {
      assert.equal(mapped, 'CANNOT_DETERMINE',
        `${label} now maps to ${mapped} — a gate that could not run has been collapsed into a verdict it never reached`);
    }
    if (label === 'PASS' || label === 'FAIL' || label === 'NOT_APPLICABLE') {
      assert.equal(mapped, label, `${label} no longer maps to itself, so the gate and the pack disagree about a word they share`);
    }
  }

  // Both documents must name every word the gate can print: its labels, and the outcomes they map to.
  const words = [...new Set([...labels, ...pairs.map(([, m]) => m)])].sort();
  for (const rel of ['templates/ci/quality-gate.yml', 'kernel/README.md']) {
    for (const name of words) {
      assert.match(read(rel), new RegExp(name), `${rel} does not mention the ${name} verdict the gate can return`);
    }
  }
});

/*
 * ⛔ THE GATE RUNS EXACTLY ONCE, AND THE ARTIFACT IS THAT RUN.
 *
 * An earlier version of this fence sliced the workflow between two step names and asserted inside the
 * slice — so it could not see a second `gate` invocation after the boundary, and there was one: a
 * `gate --json > file || true` publication step. That second run could not reverse the first failure,
 * but it re-ran the project's tests and builds, could produce a DIFFERENT flaky verdict, published an
 * artifact that was not the verdict which decided CI, and put a gate invocation behind the exact
 * `|| true` this file forbids.
 *
 * A fence that only inspects the region where the defect is not is worse than no fence: it reports
 * clean. So this asserts over the WHOLE document.
 */
test('the quality gate is invoked exactly once, and the artifact is that same run', () => {
  const yaml = read('templates/ci/quality-gate.yml');
  // Only executable lines count — the header prose names the command while explaining it.
  const runLines = yaml.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && /respawnpack\.js\s+gate\b/.test(l));

  assert.equal(runLines.length, 1,
    `the gate is invoked ${runLines.length} time(s); it must run once. A second invocation re-runs the project's ` +
    `tests, can disagree with the first, and publishes an artifact that is not the verdict that decided CI:\n${runLines.join('\n')}`);

  const invocation = runLines[0];
  assert.doesNotMatch(invocation, /\|\|\s*true|\|\|\s*:/, 'the gate invocation discards its own exit code');

  // The step that owns the invocation must not neutralise it either.
  const lines = yaml.split(/\r?\n/);
  const idx = lines.findIndex((l) => l === invocation);
  let stepStart = idx;
  while (stepStart > 0 && !/^\s*-\s+name:/.test(lines[stepStart])) stepStart--;
  let stepEnd = idx + 1;
  while (stepEnd < lines.length && !/^\s*-\s+name:/.test(lines[stepEnd])) stepEnd++;
  const step = lines.slice(stepStart, stepEnd).join('\n');
  assert.doesNotMatch(step, /continue-on-error/, 'the gate step is marked continue-on-error, which discards the verdict');

  // The verdict must be written by that same invocation — not regenerated later.
  assert.match(invocation, /--verdict-file|\|\s*tee\b/,
    'the gate invocation does not emit the verdict file, so the uploaded artifact cannot be the run that decided CI');

  // And it must be uploadable even when the gate failed — a failing verdict is the one worth reading.
  const upload = yaml.slice(yaml.indexOf('upload-artifact'));
  assert.ok(upload.length, 'no artifact upload step');
  const uploadStart = yaml.lastIndexOf('- name:', yaml.indexOf('upload-artifact'));
  assert.match(yaml.slice(uploadStart, yaml.indexOf('upload-artifact')), /if:\s*always\(\)/,
    'the upload must run with if: always(), or a failed gate publishes nothing');
});

// The review workflow and the reviewer-agent library are two representations of ONE list, and they had
// silently diverged: six `agents/*-reviewer.md` on disk against five DIMENSIONS in the workflow, with
// `design` missing — so a workflow-driven review skipped a lens while reporting a complete run. The
// workflow's own comment said "keep them in sync"; a comment is not a mechanism. This is.
test('workflows/review.workflow.js covers exactly the reviewer-agent lenses on disk', () => {
  const src = read('workflows/review.workflow.js');
  const block = /const DIMENSIONS = \[([\s\S]*?)\n\]/.exec(src);
  assert.ok(block, 'workflows/review.workflow.js: could not find the DIMENSIONS array — if it was renamed, update this fence with it');
  const keys = [...block[1].matchAll(/\bkey:\s*'([^']+)'/g)].map((m) => m[1]).sort();
  const lenses = agentFiles.filter((f) => f.endsWith('-reviewer')).map((f) => f.replace(/-reviewer$/, '')).sort();
  // The spine lens is filed as `spine-consistency-reviewer` but keyed `spine` — normalize that one alias.
  const normalized = lenses.map((l) => (l === 'spine-consistency' ? 'spine' : l)).sort();
  assert.deepEqual(keys, normalized,
    `review.workflow.js DIMENSIONS [${keys}] do not match the reviewer agents on disk [${normalized}] — a lens in one and not the other means reviews silently skip it`);
  assert.equal(keys.length, REVIEW_LENSES, 'lens count must equal the reviewer-agent count the docs cite');
});

/*
 * ⛔ UNIT 7 CORRECTIONS · THREE FRONT-PAGE STATEMENTS THAT OUTLIVED THEIR OWN TRUTH.
 *
 * The counts above fence numbers against directories. These three fence STATUS CLAIMS against the
 * mechanism that decides them, because that is the shape the external review kept finding: a sentence
 * that was accurate when written, a mechanism that moved underneath it, and nothing anywhere that
 * noticed. Each is two-sided in the same way as the counts — the claim must still MATCH (a reword
 * fails here rather than silently disabling the check), and it must still AGREE with the tree.
 */

// A retired claim walking back in is the failure mode: `README.md` said the memory engine's activation
// was "not yet proven to resolve in an installed target" long after OVERCLAIMS row 4 was closed, an
// installed-target test was proving the round trip, and `doctor` was completing a real MCP handshake.
test('README does not carry the retired "memory activation is unproven" claim', () => {
  const readme = read('README.md');

  // ⛔ THE MECHANISM HALF FIRST, and it is not decoration. If the installed-target proof is ever
  // deleted, the honest README claim is the OLD one — so this fence must send the reader to restore the
  // claim, not go on policing a sentence that has quietly become true again.
  assert.match(read('install/install.test.mjs'), /the installed engine did not answer/,
    'the installed-target MCP round-trip assertion is gone — if the proof was removed, the retired README claim has to come BACK, and this fence be rewritten with it');

  // …then the claim half.
  assert.doesNotMatch(readme, /not yet proven to resolve/i,
    'README.md has resurrected the retired "not yet proven to resolve" claim — OVERCLAIMS row 4, the installed-target test and doctor\'s own MCP handshake all contradict it');

  // …and the honest limitations the correction must NOT have swept away with it.
  /*
   * ⛔ THIS FENCE GUARDS THE DISCLOSURES, NOT THE HEADING ABOVE THEM. The heading has been reworded
   * once already — a published README should describe outstanding work as work in progress, not
   * confess to being unfinished — and rewording it is a presentation decision that is nobody's
   * business but the author's. What is NOT negotiable is the list underneath: each limitation below
   * has to survive whatever the section is called. So the anchor is deliberately loose and the
   * per-item assertions are strict, which is the opposite of how the first version was written.
   */
  const banner = /> \*\*(?:Currently in progress|Being honest about what is not finished)\.\*\*([\s\S]*?)\r?\n\r?\n/.exec(readme);
  assert.ok(banner, 'README.md: the in-progress banner could not be found — if it was reworded again, widen the alternation above rather than dropping the check');
  for (const [re, what] of [
    [/zero-setup default/, 'file-backed memory is the zero-setup default'],
    [/optional/i, 'the engine is OPTIONAL'],
    [/--with-memory/, '`--with-memory` is what installs it locally'],
    [/global `rmem`/, 'nothing depends on a global `rmem`'],
    [/npm install/, 'installation still depends on the required Node/npm environment'],
  ]) {
    assert.match(banner[1], re, `the memory correction dropped an honest limitation: ${what}`);
  }
});

// `README.md`'s Quickstart said `/savepoint` regenerates CHANGELOG, GAPS and CONTINUITY. The kernel's
// executable render list has only ever held two of those, and Unit 7 had already corrected the shipped
// `spine/derived/CHANGELOG.md` template to say it is hand-maintained. The list is the source of truth.
test("README's /savepoint step names exactly the kernel's executable render targets", () => {
  const block = /const targets = \[([\s\S]*?)\r?\n {2}\];/.exec(read('kernel/respawnpack.js'));
  assert.ok(block, 'kernel/respawnpack.js: the render target list could not be found — if it moved, update this fence with it');
  const rendered = [...block[1].matchAll(/path\.join\('docs', 'derived', '([\w.]+)'\)/g)].map((m) => m[1]).sort();
  // P2-O-3 added the third: docs/derived/LESSONS.md, the lessons register, rendered from the memory
  // store rather than from STATE.json and verified by render.js's `verifyLessons` for exactly that
  // reason. The fence is unchanged in kind — the README's sentence must name every target the kernel
  // actually renders, and adding one without saying so is the drift this test exists to catch.
  assert.deepEqual(rendered, ['CONTINUITY.md', 'GAPS.md', 'LESSONS.md'],
    'the kernel renders a different set than this fence knows — update the README claim and this fence together, in the same change');

  const step = /\*\*`\/savepoint`\*\* ends the session\.([^\n]*)/.exec(read('README.md'));
  assert.ok(step, 'README.md: the Quickstart `/savepoint` step could not be found — if it was reworded, update this fence with it');
  for (const f of rendered) {
    assert.ok(step[1].includes(f), `the /savepoint step does not name ${f}, which the kernel actually renders`);
  }
  // The claim that started this. `[^.]*` cannot cross a sentence end, so naming CHANGELOG in a LATER
  // sentence (to say it is hand-authored) is fine; describing it as regenerated is not.
  assert.doesNotMatch(step[1], /regenerates?[^.]*CHANGELOG/i,
    '`/savepoint` is described as regenerating CHANGELOG. It does not: kernel/lib/render.js renders CONTINUITY.md and GAPS.md and nothing else, and `savepoint --verify` never checks CHANGELOG against a source');
  assert.match(step[1], /CHANGELOG\.md[^.]*\bnot\b/i,
    'the step must say plainly that CHANGELOG is NOT one of the regenerated documents — silence is what let the old claim read as true');
});

// A hand-carried count of a MOVING branch cannot stay true. This one said "21 commits over 077e2f1"
// while the branch stood at 32 over `main` and 36 over `origin/main`. Replacing it with a fresher
// number would only reset the same clock, so the prose carries no count at all and names the command.
test('CHANGELOG carries no hand-authored commit count for the hardening branch', (t) => {
  if (!devArtifact('CHANGELOG.md')) return t.skip('CHANGELOG.md is a development artifact and is absent from the published package');
  const note = /### Note on this section\r?\n([\s\S]*?)\r?\n\r?\n/.exec(read('CHANGELOG.md'));
  assert.ok(note, 'CHANGELOG.md: the "Note on this section" block could not be found — if it was reworded, update this fence with it');
  assert.match(note[1], /hardening\/state-kernel/, 'the note no longer identifies the branch it is about');
  assert.doesNotMatch(note[1], /\b\d+\s+commits?\b/i,
    'a hand-carried commit count is back in CHANGELOG.md. A branch that is still advancing has no permanent hand-authored count — name the git command that answers it instead');
  assert.match(note[1], /git log/,
    'having removed the number, the note must point at the command that is right on every day');
});

/*
 * ⛔ THE RELEASE-TRUTH FENCE. README, kernel/README.md and the artifact registry each describe the two
 * mechanisms added last — declared schemas and DF-005 reconciliation — and each of those descriptions is
 * exactly the kind of sentence this program has repeatedly found outliving its own mechanism. So every
 * one is checked against the CODE, and the mechanism is checked to still exist BEFORE its sentence is
 * policed: a fence that survives the deletion of what it describes is a fence guarding nothing.
 */
test('the schema layer is described accurately, and only while it exists', () => {
  const registry = JSON.parse(read('schemas/registry.json'));
  assert.ok(registry.families.length >= 15, `the artifact registry holds only ${registry.families.length} families — too few to be an inventory`);
  for (const f of registry.families) {
    assert.ok(fs.existsSync(path.join(ROOT, 'schemas', f.schema)), `the registry names a schema that does not exist: ${f.schema}`);
  }

  // "Not installed into a target" is claimed in two READMEs and is true only while the installer agrees.
  assert.doesNotMatch(read('install/install.js'), /schemas\//,
    'install.js now places something from schemas/, so "not installed into a target" is false in README.md and kernel/README.md');
  /*
   * ⛔ PINNED TO EACH CLAIM, NOT TO THE FILE. The first version asserted only that "not installed"
   * appeared SOMEWHERE in README.md — and it appears twice, so a mutation that reworded the banner to
   * say the schemas ship into a target left the other mention standing and the fence green. A fence
   * satisfiable from a different sentence than the one under test is not checking that sentence.
   */
  const banner = /^> .*schemas[\s\S]*?\n\n/m.exec(read('README.md').replace(/\s*\n>\s*/g, ' '))
    || [read('README.md').replace(/\s*\n>?\s*/g, ' ')];
  assert.match(banner[0], /schemas\/[\s\S]{0,200}\*not\* installed into your target/,
    'README.md\'s status banner no longer says the schemas are NOT installed into your target');

  const row = /^\| `schemas\/` \|(.*)\|$/m.exec(read('README.md'));
  assert.ok(row, 'README.md: the `schemas/` row is gone from the repo map');
  assert.match(row[1], /not installed into a target/i,
    'the README repo-map row for `schemas/` no longer states that it is not installed into a target');
  assert.match(read('kernel/README.md'), /not installed into a target/i,
    'kernel/README.md does not say the schemas are NOT installed into a target — the property a reader would otherwise assume');
  // Markdown wraps, so every pattern here tolerates a line break and a blockquote marker between words.
  assert.match(read('kernel/README.md').replace(/\s*\n>?\s*/g, ' '), /procedural loaders in `lib\/` remain the production validators/,
    'kernel/README.md no longer states that the procedural loaders remain the production validators — without it, a reader has two candidate sources of truth for every format');
});

test('the DF-005 reconciliation is described accurately, and only while it exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'kernel', 'lib', 'reconcile.js')), 'kernel/lib/reconcile.js is gone; every claim below is about nothing');
  assert.match(read('kernel/respawnpack.js'), /reconcile: cmdReconcile/, 'the reconcile verb is no longer dispatched');
  /*
   * ⛔ PINNED TO TWO FILES, NOT ONE, SINCE K-03 (BUG-3). `cmdSavepoint` used to call
   * `reconcileLib.runReconciliation(DIR)` itself; it now reuses the result `stateLib.compile(DIR)`
   * already computed (compile() calls `reconcileLib.runReconciliation(dir)` once and returns it as
   * `reconciliation`), so the two halves of "savepoint still runs reconciliation" now live one file
   * apart — the compiler runs it, and savepoint folds its checks in — and both must still hold.
   */
  assert.match(read('kernel/lib/state.js'), /reconcileLib\.runReconciliation\(dir\)/,
    'the state compiler no longer runs reconciliation — nothing would be left for savepoint to fold in');
  /*
   * ⛔ AND SINCE P3-K-10 THE FOLD PASSES THROUGH THE POSTURE LAYER, SO THE PIN IS TWO HALVES. ADR-003
   * lets a declared `light` or `standard` answer the reconcile coverage row, and `relaxCoverage` is the
   * one seam that applies the survey's decision to the checks reconcile.js already built. Both halves
   * are asserted because either alone would pass over a savepoint that computed the rows and dropped
   * them — the claim is still "savepoint folds reconciliation's checks into its own", unchanged.
   */
  assert.match(read('kernel/respawnpack.js'), /relaxCoverage\(reconciliation\.checks,/,
    'savepoint no longer reads reconciliation checks at all — it has become a command nobody runs, which is the state DF-005 describes');
  assert.match(read('kernel/respawnpack.js'), /checks\.push\(\.\.\.reconcileRows\)/,
    'savepoint computes the reconciliation rows and never folds them into its own check list, so nothing they say can reach the verdict');

  for (const doc of ['README.md', 'kernel/README.md']) {
    assert.match(read(doc), /reconcil/i, `${doc} does not mention the reconciliation at all`);
  }
  // The one property that must never quietly soften.
  assert.match(read('kernel/README.md'), /zero task records[\s\S]{0,120}can never be `PASS`/i,
    'kernel/README.md no longer states that reading zero records can never be PASS — the rule the whole check rests on');
  assert.match(read('kernel/lib/reconcile.js'), /ZERO_RECORDS/, 'the ZERO_RECORDS class is gone from the implementation the README describes');
  assert.match(read('kernel/README.md'), /NOT_APPLICABLE`? \(\*\*declared/i,
    'kernel/README.md no longer says NOT_APPLICABLE is declared rather than inferred');
  assert.match(read('kernel/lib/reconcile.js'), /notApplicable is true with no reason/,
    'the implementation no longer refuses an unjustified opt-out, so the README claim is unearned');
});

test('the live-Docker verification is reported as unverified wherever it is mentioned', () => {
  /*
   * ⛔ Eight consecutive rounds of CANNOT_DETERMINE. The failure mode worth fencing is not somebody
   * claiming a pass — it is the sentence quietly disappearing, after which nothing says the gap exists.
   */
  const flat = read('README.md').replace(/\s*\n>?\s*/g, ' ');
  assert.match(flat, /live Docker daemon/i,
    'README.md no longer names the live-Docker gap. Removing the sentence does not close it');
  assert.match(flat, /not claimed|not proven|CANNOT_DETERMINE/i,
    'README.md mentions the live Docker daemon without saying the behaviour is unverified');
  assert.match(read('ops/release-smoke.mjs'), /dockerResult = 'CANNOT_DETERMINE'/,
    'the release smoke no longer defaults the live-Docker result to CANNOT_DETERMINE');
  assert.doesNotMatch(read('ops/release-smoke.mjs'), /apt-get|brew install|docker desktop/i,
    'the release smoke tries to PROVISION docker. It checks once and records the answer; it does not install or start services');
});

test('the release smoke derives its own counts and carries none by hand', () => {
  const src = read('ops/release-smoke.mjs');
  assert.match(src, /\$\{ran\} step\(s\) ran/, 'the release smoke no longer derives its step count from the steps that ran');
  assert.match(src, /skipped \+= 1/, 'the release smoke no longer tracks skips separately — a skipped step counted as a pass is the oldest defect in this repository');
  assert.doesNotMatch(src, /\b\d\d+ steps?\b/, 'a hand-carried step count is back in the release smoke');
});

/*
 * ⛔ P5 — THE CORE/OPTIONAL BOUNDARY IS DOCUMENTED EXACTLY AS THE INSTALLER IMPLEMENTS IT.
 *
 * P5's `core vs optional packs` unit sat at `not_started` with `evidence: NONE` because the string
 * appeared in no artifact, no test and no design note — only in the two documents tracking the gap.
 * ADR-002 records the owner's decision: FOUR optionality axes that ALREADY EXIST, and no new package,
 * repository or plugin architecture invented to make the word "modular" apply.
 *
 * A decision written only in prose is the thing this repository has spent nine rounds learning not to
 * trust. So every axis is re-derived from the SOURCE here, in both directions: the ADR must still make
 * the claim (a reworded ADR must move this fence with it, never silently stop checking), and the claim
 * must equal what `install/install.js` and `kernel/lib/living.js` actually do.
 */
test('P5: the core/optional boundary is documented exactly as the installer implements it', (t) => {
  const ADR = 'docs/hardening/ADR-002-core-and-optional-boundary.md';
  // Absent only in the published package, where the ADR is not shipped. Wherever the ADR exists —
  // which is wherever anyone is actually editing it — every axis below still runs in both directions.
  if (!devArtifact(ADR)) return t.skip('the ADR is a development artifact and is absent from the published package');
  const adr = read(ADR);
  const installer = read('install/install.js');
  const living = read('kernel/lib/living.js');

  // --- axis 1: exactly one capability flag, and the installer's own banner names it ----------------
  const knownFlags = /const KNOWN_FLAGS = new Set\(\[([^\]]*)\]\)/.exec(installer);
  assert.ok(knownFlags, 'install.js no longer declares KNOWN_FLAGS as a literal set — re-aim this fence rather than deleting it');
  const flags = [...knownFlags[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(flags, ['--dry-run', '--force', '--force-all', '--migrate-removals-scope', '--with-memory'],
    'the installer flag surface changed. ADR-002 says --with-memory is the ONLY capability flag; every other flag must be '
    + 'install behavior or an explicit migration authorization, and the ADR has to say so.');
  /*
   * ⛔ THE BANNER OMITTED THE ONE CAPABILITY FLAG, AND ONLY WRITING THIS FENCE FOUND IT. install.js's
   * own usage block listed --force, --force-all and --dry-run and never mentioned --with-memory, while
   * two READMEs documented it. The pack's single opt-in capability was absent from the installer's own
   * help text.
   */
  const banner = installer.slice(0, installer.indexOf("const fs = require('fs')"));
  for (const f of flags) {
    assert.ok(banner.includes(f), `install.js's own usage banner does not mention ${f} — the help text a user reads first is missing a real flag`);
  }
  assert.match(adr, /`--with-memory`/, 'ADR-002 no longer names the memory flag');

  // --- axis 1 (cont.): file-backed memory is CORE, and the code says so in those terms -------------
  assert.match(read('kernel/lib/memory.js'), /mode: 'file'[\s\S]{0,300}zero-setup default/,
    'kernel/lib/memory.js no longer returns the file backend as the zero-setup default');
  assert.match(adr, /not a degraded fallback|zero-setup default/,
    'ADR-002 no longer states that file-backed memory is core rather than a degraded fallback');

  // --- axis 3: the stack gates, derived from source, both directions ------------------------------
  const gateBlock = /const MCP_GATE = \{([\s\S]*?)\n\};/.exec(installer);
  assert.ok(gateBlock, 'install.js no longer declares MCP_GATE as a literal object — re-aim this fence rather than deleting it');
  const gated = [...gateBlock[1].matchAll(/^\s*'?([\w-]+)'?:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(gated, ['fly', 'security-audit', 'supabase'],
    'the set of stack-gated MCP skills changed — ADR-002 names exactly these three, and the table beside them is now wrong');
  const mcpLoop = /for \(const m of \[([^\]]*)\]\)/.exec(installer.slice(installer.indexOf('const MCP_GATE')));
  assert.ok(mcpLoop, 'the mcp-* placement loop is no longer a literal list — re-aim this fence rather than deleting it');
  const allMcp = [...mcpLoop[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const ungated = allMcp.filter((m) => !gated.includes(m)).sort();
  assert.deepEqual(ungated, ['context7', 'github', 'graphify', 'runtime'],
    'the always-placed MCP skills changed — ADR-002 lists these four as unconditional');
  for (const m of gated) assert.match(adr, new RegExp(`mcp-${m}`), `ADR-002 does not name the gated skill mcp-${m}`);

  /*
   * ⛔ AND THE "27 SKILLS" NUMBER IS THE ALL-GATES-FIRED MAXIMUM, NOT WHAT A TARGET RECEIVES. A tree
   * with no fly.toml, no supabase/ and no package.json gets 24. Stating 27 without that qualifier is
   * the same class of claim as a green gate that skipped every check: true of a condition nobody is in.
   */
  const skillsSrc = read('skills/skills.test.mjs');
  const declared = /assert\.equal\(SKILL_SOURCES\.length, (\d+),/.exec(skillsSrc);
  assert.ok(declared, 'skills.test.mjs no longer pins SKILL_SOURCES.length — re-aim this fence rather than deleting it');
  const maxSkills = Number(declared[1]);
  const skillDirs = /const skillDirs = \[([\s\S]*?)\];/.exec(installer);
  assert.ok(skillDirs, 'install.js no longer declares skillDirs as a literal — re-aim this fence rather than deleting it');
  // `skillDirs` already carries `memory/knowledge` alongside the role and ops skills — the first draft
  // of this fence added it a second time and the arithmetic refused to close, which is the fence working.
  const unconditional = [...skillDirs[1].matchAll(/'([^']+)'/g)].length;
  const minSkills = unconditional + ungated.length;
  assert.equal(maxSkills, minSkills + gated.length,
    `the skill arithmetic no longer closes: ${unconditional} unconditional + ${ungated.length} ungated MCP + ${gated.length} gated `
    + `should equal the pinned maximum ${maxSkills}`);
  assert.ok(adr.includes(String(maxSkills)) && adr.includes(String(minSkills)),
    `ADR-002 must state BOTH the all-gates-fired maximum (${maxSkills}) and what a target with no stack markers receives (${minSkills})`);

  // --- axis 4: three canaries, opt-in, and everything else STATIC and complete ---------------------
  const canaries = /const CANARIES = \[([^\]]*)\]/.exec(living);
  assert.ok(canaries, 'living.js no longer declares CANARIES as a literal — re-aim this fence rather than deleting it');
  const names = [...canaries[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, ['debug', 'savepoint', 'knowledge'],
    'the canary set changed — ADR-002 names exactly these three as the opt-in living skills');
  for (const c of names) assert.match(adr, new RegExp(`\`${c}\``), `ADR-002 does not name the canary ${c}`);
  assert.match(adr, /complete supported skill/i,
    'ADR-002 no longer states that a STATIC skill is a complete supported skill — that is the design position, not a shortfall');

  /*
   * ⛔ AND THE THING THE DECISION EXISTS TO PREVENT. The risk in leaving this unit open was never that
   * nothing would be built — it was that something WOULD be, to make "optional packs" sound larger.
   */
  assert.match(adr, /No separate packages or repositories/,
    'ADR-002 no longer records that no separate package or repository is created');
  assert.match(adr, /Do not reintroduce a plugin architecture/,
    'ADR-002 no longer records that a plugin architecture must not be reintroduced');
});

/*
 * ⛔ P-020 — THE ONE COUNT DERIVED FROM A SECOND HARDCODED LIST, NOT THE TREE. Every other count fence
 * in this file re-derives its number from a directory read on every run; "nine skills ship a
 * `SKILL.base.md`" was checked once by hand during an audit and then trusted — `pairs.json` records the
 * gap under its own id rather than pretending it does not exist. Both documents that state the count
 * also warn, in the same breath, that the base-shipping set is a DIFFERENT set from the three living
 * canaries, so P-020's invariant has two halves and both are asserted below: the count against the
 * tree, and the disjointness against `kernel/lib/living.js`'s CANARIES literal.
 */
function baseFilesUnder(rootRel, excludeRel = []) {
  const root = path.join(ROOT, rootRel);
  const excludeAbs = excludeRel.map((e) => path.join(ROOT, e));
  const out = [];
  (function walk(dir) {
    if (excludeAbs.includes(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === 'SKILL.base.md') out.push(full);
    }
  })(root);
  return out;
}

test('the SKILL.base.md skill count matches the tree and stays disjoint from the living canaries', () => {
  // Directory-derived truth: every SKILL.base.md under skills/, ops/ (its ops/mcp subdirectory
  // excluded here and walked separately below, so its files are counted once, not twice) and
  // ops/mcp/ — the same three roots install.js copies a frozen base from.
  const baseFiles = [
    ...baseFilesUnder('skills'),
    ...baseFilesUnder('ops', ['ops/mcp']),
    ...baseFilesUnder('ops/mcp'),
  ];
  const baseShippingSkills = baseFiles.map((f) => path.basename(path.dirname(f))).sort();
  assert.ok(baseShippingSkills.length > 0,
    'the SKILL.base.md walk found nothing under skills/, ops/ or ops/mcp/ — the walk logic itself is broken');
  const BASE_COUNT = baseShippingSkills.length;

  // Both documents' stated count, in every place either states it — a differently-worded restatement
  // that silently drops the number is exactly the gap a two-sided fence exists to catch.
  expectClaim('spine/reference/living-skills.md', /the tree carried (\w+)\n> `SKILL\.base\.md` files/g,
    BASE_COUNT, 'living-skills.md — "the tree carried nine" history line (:13-14)');
  expectClaim('spine/reference/living-skills.md',
    /the (\w+) skills that ship a `SKILL\.base\.md` on disk today are all non-canaries/g,
    BASE_COUNT, 'living-skills.md — drift-check caveat (:57)');
  expectClaim('skills/skill-guard/SKILL.md',
    /different sets\. The (\w+)\nskills that ship a baseline today are all non-canaries/g,
    BASE_COUNT, 'skill-guard/SKILL.md — Mode A caveat (:18-19)');
  expectClaim('skills/skill-guard/SKILL.md', /\(the (\w+) that ship one are all non-canaries\)/g,
    BASE_COUNT, 'skill-guard/SKILL.md — Invariants line (:37)');

  // The second half of P-020's invariant: a skill earns a SKILL.base.md by shipping one from the
  // start; a canary earns one only when `living enable` freezes what is already on disk. The two
  // sets must never overlap, or "different sets" — both docs' own words — stops being true.
  const living = read('kernel/lib/living.js');
  const canaryLiteral = /const CANARIES = \[([^\]]*)\]/.exec(living);
  assert.ok(canaryLiteral, 'living.js no longer declares CANARIES as a literal — re-aim this fence rather than deleting it');
  const canaryNames = [...canaryLiteral[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const overlap = baseShippingSkills.filter((name) => canaryNames.includes(name));
  assert.deepEqual(overlap, [],
    `these skill(s) both ship a SKILL.base.md and are living canaries — P-020's "different sets" invariant is broken: ${overlap.join(', ')}`);
});

/*
 * ⛔ THE INVENTORY OF UNMIRRORED OBLIGATIONS, FENCED AGAINST ITSELF.
 *
 * docs/derived/state/pairs.json enumerates the pairs in this pack — invariants of the form "X must agree
 * with Y" — and which of them a two-sided fence actually checks. It exists because every defect that
 * shipped in 5204353 was a broken pair and every fence that caught one was two-sided, 4/4 in both
 * directions. Its whole value is the number of UNFENCED entries, which is the size of what a human still
 * has to hold in their head.
 *
 * ⛔ SO IT CANNOT BE A DOCUMENT. A register of debt that nothing checks becomes the exact furniture it was
 * written to prevent — the shape of `spine/reference/testing-standards.md` rules 14 and 15, which were
 * added and then violated within the hour by the change that added them. Every claim below is therefore
 * derived, in both directions where a direction exists:
 *
 *   declared -> real   an `enforcedBy` naming a file that does not exist, or a test name that appears
 *                      nowhere in it, is a fence about nothing and fails here.
 *   unfenced -> justified   an entry with no fence must say WHY, at length. An unexplained gap is
 *                      indistinguishable from an overlooked one, which is the same doctrine the removal
 *                      contract and the quality gate both apply to a declared opt-out.
 *
 * What it does NOT prove is that every real pair in the tree is listed — that is P-023's own row, recorded
 * there rather than quietly excepted.
 */
test('the pair inventory is fenced against itself: every claimed fence exists, every gap is justified', () => {
  const doc = JSON.parse(read('docs/derived/state/pairs.json'));
  assert.equal(doc.schemaVersion, '1.0.0', 'pairs.json declares an unexpected schemaVersion');
  assert.ok(Array.isArray(doc.pairs) && doc.pairs.length >= 20,
    `pairs.json holds ${(doc.pairs || []).length} row(s) — an inventory this small is not the one the sweep produced`);

  const ids = new Set();
  let unfenced = 0;
  for (const p of doc.pairs) {
    const at = `pairs.json ${p.id}`;
    assert.ok(/^P-\d{3}$/.test(p.id || ''), `${at}: ids are P-NNN`);
    assert.equal(ids.has(p.id), false, `${at}: duplicate id`);
    ids.add(p.id);
    for (const k of ['sideA', 'sideB', 'invariant', 'exposure']) {
      assert.ok(typeof p[k] === 'string' && p[k].trim(), `${at}: ${k} is required`);
    }
    assert.ok(Object.prototype.hasOwnProperty.call(doc.shapes, p.shape),
      `${at}: shape ${JSON.stringify(p.shape)} is not one of ${Object.keys(doc.shapes).join('/')} — the shape decides which technique can fence it at all`);

    if (p.enforcedBy === null) {
      unfenced += 1;
      // A gap nobody has to justify is a gap nobody reviews — the same bar a declared opt-out meets.
      assert.ok(typeof p.why === 'string' && p.why.trim().length > 80,
        `${at}: unfenced, and its \`why\` is a label rather than a reason (${(p.why || '').length} chars)`);
      continue;
    }

    /*
     * ⛔ A FENCE IS A FILE AND A TEST NAME, BOTH CHECKED. "file:test title" — the file must exist and the
     * title must appear in it. Without the second half an entry could name a real file and a test that
     * was renamed or deleted, and the register would report coverage that had already evaporated.
     */
    assert.ok(typeof p.enforcedBy === 'string' && p.enforcedBy.includes(':'),
      `${at}: enforcedBy must be "<file>:<test title>" or null`);
    const idx = p.enforcedBy.indexOf(':');
    const file = p.enforcedBy.slice(0, idx).trim();
    const title = p.enforcedBy.slice(idx + 1).trim();
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${at}: enforcedBy names ${file}, which does not exist`);
    assert.ok(read(file).includes(title),
      `${at}: ${file} contains no test titled "${title}" — a fence that no longer exists is worse than a declared gap, because it reports coverage`);
  }

  // The number this file exists to publish, recomputed from the rows rather than restated.
  assert.equal(unfenced, doc.pairs.filter((p) => p.enforcedBy === null).length,
    'the unfenced count disagrees with the rows — recompute from rows, never carry a total forward');
  assert.ok(unfenced > 0,
    'zero unfenced pairs would mean this register has nothing left to say; if that is ever true, prove it rather than asserting it');
});

/*
 * ⛔ WHY THIS EXISTS. Found live: spine/reference/compliance-requirements.md:7 linked
 * `[`/comply` skill](#planned-the-comply-skill)`, a same-file anchor to a heading that had already been
 * renamed to `## The `/comply` skill & adherence layer`. Nothing caught it. skills/skills.test.mjs's own
 * link checker only resolves links found in *installed skill* files against the installed tree, and even
 * there it explicitly skips a pure same-file anchor rather than validating it
 * (`if (!withoutAnchor) continue;`) — anchor fragments are not checked at all, anywhere, today.
 *
 * Deliberately narrow, matching the exact shape of the bug that shipped rather than a general-purpose
 * link checker: same-file fragment links only (`[text](#slug)`), across the dozen top-level
 * spine/reference/*.md standards (not design-standards/'s subfiles, not a repo-wide crawl, not cross-file
 * anchors, not GitHub's duplicate-heading `-1`/`-2` suffixing — none of which any file here has needed).
 */
function githubSlug(headingText) {
  // GitHub's heading-anchor algorithm: strip inline-code backticks, lowercase, drop everything that is not
  // a letter/digit/space/hyphen/underscore, then turn spaces into hyphens. Removing "&" out of "skill &
  // adherence" leaves "skill  adherence" (two spaces), which is what turns into the double hyphen in
  // "skill--adherence" below — not a bug in this function, the algorithm GitHub itself uses.
  return headingText
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/ /g, '-');
}

test('every same-file anchor link in spine/reference/*.md resolves to a real heading', () => {
  const dir = path.join(ROOT, 'spine', 'reference');
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => `spine/reference/${e.name}`);
  assert.ok(files.length >= 10, `expected at least 10 spine/reference/*.md files, found ${files.length}`);

  // Pure same-file fragment links only: the "(" must be immediately followed by "#". A link to an external
  // URL (`https://example.com/x#section`) has "(" followed by "h", never matches this shape, and so is
  // never evaluated here — excluded by construction of the regex, not by a scheme allowlist that could
  // itself go stale.
  const anchorLinkRe = /\]\(#([^)]+)\)/g;
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/gm;

  const broken = [];
  for (const rel of files) {
    const content = read(rel);
    const slugs = new Set();
    let hm;
    while ((hm = headingRe.exec(content))) slugs.add(githubSlug(hm[2]));

    let lm;
    while ((lm = anchorLinkRe.exec(content))) {
      const target = lm[1];
      if (!slugs.has(target)) broken.push(`${rel} :: #${target}`);
    }
  }
  assert.deepEqual(broken, [],
    `dead same-file anchor(s) in spine/reference — the linked heading no longer exists or was never spelled this way:\n${broken.join('\n')}`);
});
