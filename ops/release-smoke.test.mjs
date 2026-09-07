/*
 * RespawnPack · ops/release-smoke.test.mjs — the release smoke's PROFILE contract, in its failing states.
 *
 * ⛔ WHY THIS SUITE EXISTS AND WHY IT DOES NOT RUN THE SMOKE. `node ops/release-smoke.mjs` installs the
 * whole product into a throwaway target once per profile and takes minutes; a suite that ran it would be
 * a suite nobody runs, and the states worth proving are the FAILING ones — a pinned lifecycle row that
 * stopped running, a profile that declined a step without saying why, a `light` install that turned out
 * to withhold nothing, an unknown posture name. None of those can be produced by running the smoke on a
 * healthy tree. So the verdicts live in `ops/_smoke-profiles.mjs` as objects, exactly as step 16's gate
 * lives in `ops/_smoke16-gate.mjs`, and this suite feeds them shapes. The smoke consumes the identical
 * objects, so the fence and the run cannot fork.
 *
 * ⛔ AND THE TREE-CHECKED HALF IS NOT DECORATION. Two claims here are about files rather than functions:
 * that `ops/release-smoke.mjs` really wires those verdicts in (a gate imported and never called is worse
 * than no gate, because it reads as covered), and that `release/build-public.sh`'s own `DEV_ONLY` text
 * still says what the posture layer needs it to say. Both are derived from the source rather than
 * restated here.
 *
 *   node --test ops/release-smoke.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  BASELINE_STEPS, DEFAULT_PROFILES, FIXED_HOOK_FILES, KNOWN_PROFILES,
  evaluateFootprint, evaluateReproduction, parseProfiles,
} from './_smoke-profiles.mjs';

const OPS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(OPS);
const require_ = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const manifest = require_(path.join(ROOT, 'install', '_settings-manifest.js'));
const snippetShape = (() => {
  const snippet = JSON.parse(read('hooks/settings.snippet.json'));
  delete snippet['//'];
  return manifest.shapeOf(snippet);
})();

/** A clean run of the pinned lifecycle: every pinned row, in order, passing. */
const cleanRun = () => BASELINE_STEPS.map((b) => ({ n: b.n, label: b.label, outcome: 'PASS' }));

/*
 * A footprint report shaped like the one runProfile() observes off a real target.
 *
 * The file counts below are SYNTHETIC INPUT to a pure function, not a claim about any install: what is
 * under test is the relationship the verdict enforces between two profiles, so the fixture only has to be
 * shaped like a real pair. The two figures that ARE claims about this tree, the entry and group counts,
 * are read from `hooks/settings.snippet.json` through the manifest's own `shapeOf`, so a snippet edit
 * moves them rather than leaving a stale number here asserting the old shape.
 */
const report = (profile, over = {}) => ({
  profile,
  entries: profile === 'light' ? snippetShape.entries - 2 : snippetShape.entries,
  groups: snippetShape.groups,
  hooks: [...FIXED_HOOK_FILES, 'spawn-guard.js', 'websearch-freshness.js', ...(profile === 'light' ? [] : ['mcp-reaper.js'])],
  created: profile === 'light' ? 156 : 157,
  claudeFiles: profile === 'light' ? 118 : 119,
  kernelPlaced: profile === 'light' ? 12 : 13,
  kernelTotal: 13,
  source: 'DECLARED',
  omittedByProfile: [],
  ...over,
});

// ══ STATE 1 ═══ strict reproduces the pinned capture ═══════════════════════════════════════════════
describe('state 1 — strict reproduces today\'s smoke output', () => {
  test('every pinned row, in order, passing, is a PASS for strict', () => {
    const v = evaluateReproduction({ profile: 'strict', observed: cleanRun() });
    assert.equal(v.outcome, 'PASS', v.failures.join(' | '));
    assert.equal(v.passed.length, BASELINE_STEPS.length);
    assert.deepEqual(v.notApplicable, []);
    assert.deepEqual(v.extra, []);
  });

  test('the pinned capture is a real capture: distinct labels, and the deferred uninstall last', () => {
    const labels = BASELINE_STEPS.map((b) => b.label);
    assert.equal(new Set(labels).size, labels.length, 'two pinned rows share a label, so an in-order match is ambiguous');
    // uninstallLast() runs after step 16 by design; that ordering is part of what is pinned.
    assert.equal(BASELINE_STEPS.at(-1).n, 13, 'the pinned capture no longer ends with the deferred uninstall');
    assert.equal(BASELINE_STEPS.at(-3).n, 16, 'step 16 no longer immediately precedes the deferred uninstall');
  });

  test('a pinned row that stopped running is a FAIL, not a smaller green', () => {
    const observed = cleanRun().filter((r) => r.label !== 'state compiles and recomputes its counts from rows');
    const v = evaluateReproduction({ profile: 'strict', observed });
    assert.equal(v.outcome, 'FAIL');
    assert.match(v.failures.join(' '), /never ran: state compiles/);
  });

  test('a pinned row that failed, or ran out of order, is a FAIL', () => {
    const failed = cleanRun().map((r) => (r.n === 4 ? { ...r, outcome: 'FAIL' } : r));
    assert.equal(evaluateReproduction({ profile: 'strict', observed: failed }).outcome, 'FAIL');

    const reordered = cleanRun();
    [reordered[2], reordered[20]] = [reordered[20], reordered[2]];
    const v = evaluateReproduction({ profile: 'strict', observed: reordered });
    assert.equal(v.outcome, 'FAIL');
    assert.match(v.failures.join(' '), /out of order/);
  });

  test('strict may never decline a pinned row, however good its reason', () => {
    const observed = cleanRun().map((r) => (r.n === 15
      ? { ...r, outcome: 'NOT_APPLICABLE', reason: 'the declared strict posture does not install it' } : r));
    const v = evaluateReproduction({ profile: 'strict', observed });
    assert.equal(v.outcome, 'FAIL');
    assert.match(v.failures.join(' '), /strict declined a pinned step, which it may never do/);
  });

  test('a row the smoke could not run at all is CANNOT_DETERMINE, never a pass and never a fail', () => {
    // Step 10 skips itself on a host with no npm. That host has not failed to reproduce the lifecycle.
    const observed = cleanRun().map((r) => (r.n === 10
      ? { ...r, outcome: 'SKIPPED', reason: 'npm is not available on this host' } : r));
    const v = evaluateReproduction({ profile: 'strict', observed });
    assert.equal(v.outcome, 'CANNOT_DETERMINE');
    assert.equal(v.undetermined.length, 2);
    assert.deepEqual(v.failures, []);
  });

  test('a skip with no reason is a silent skip, and a silent skip is a FAIL', () => {
    const observed = cleanRun().map((r) => (r.n === 10 ? { ...r, outcome: 'SKIPPED', reason: '' } : r));
    assert.equal(evaluateReproduction({ profile: 'strict', observed }).outcome, 'FAIL');
  });
});

// ══ STATE 2 ═══ light withholds, declares it, and still runs everything else ═══════════════════════
describe('state 2 — light reports a smaller placed set and still passes every lifecycle step', () => {
  const lightRun = () => cleanRun().map((r) => (r.n === 15
    ? { ...r, outcome: 'NOT_APPLICABLE', reason: 'the declared `light` posture does not install the reconciliation subsystem (ADR-003 kernel:R4)' }
    : r));

  test('a declined row with a reason is a PASS for light, and is reported as declined rather than passed', () => {
    const v = evaluateReproduction({ profile: 'light', observed: lightRun() });
    assert.equal(v.outcome, 'PASS', v.failures.join(' | '));
    assert.equal(v.notApplicable.length, 3, 'the three DF-005 rows are the ones light declines');
    assert.equal(v.passed.length, BASELINE_STEPS.length - 3);
    assert.match(v.notApplicable[0].reason, /light/, 'a declined row must name the posture that withheld the subsystem');
  });

  test('a declined row with NO reason is a silent skip, and is refused', () => {
    const observed = lightRun().map((r) => (r.outcome === 'NOT_APPLICABLE' ? { ...r, reason: '   ' } : r));
    const v = evaluateReproduction({ profile: 'light', observed });
    assert.equal(v.outcome, 'FAIL');
    assert.match(v.failures.join(' '), /NOT_APPLICABLE with no reason given, which is a silent skip/);
  });

  test('light dropping a row entirely is still a FAIL — declining is not the same as vanishing', () => {
    const observed = lightRun().filter((r) => r.n !== 15);
    const v = evaluateReproduction({ profile: 'light', observed });
    assert.equal(v.outcome, 'FAIL');
    assert.equal(v.failures.length, 3);
  });

  test('the footprint comparison accepts a light that really is smaller on every measure', () => {
    const v = evaluateFootprint([report('strict'), report('light')], { snippetEntries: snippetShape.entries });
    assert.equal(v.pass, true, v.failures.join(' | '));
    assert.equal(v.compared.length, 4, 'entries, claudeFiles, kernelPlaced and created are all compared');
  });

  test('a light that withheld NOTHING is refused as the vacuous pass it is', () => {
    const v = evaluateFootprint([report('strict'), report('light', { kernelPlaced: 13, claudeFiles: 119, entries: snippetShape.entries, created: 157 })],
      { snippetEntries: snippetShape.entries });
    assert.equal(v.pass, false);
    assert.match(v.failures.join(' '), /a profile that withholds nothing passed vacuously/);
  });

  test('a count that could not be observed is unknown, never zero', () => {
    const v = evaluateFootprint([report('strict', { created: NaN })], { snippetEntries: snippetShape.entries });
    assert.equal(v.pass, false);
    assert.match(v.failures.join(' '), /`created` was not observed, so it is unknown rather than zero/);
  });

  /*
   * ⛔ THE CHECK THE WHOLE PROFILE LAYER RESTS ON. A posture is a way to spend fewer node processes; it
   * is never a way to un-wire a guard. The hook list is derived from `hooks/_posture.js`'s own FIXED_IDS
   * crossed with `install/_settings-manifest.js`'s RULES_BY_HOOK, so moving a row in ADR-003's table
   * moves this fence with it rather than leaving it asserting a stale list.
   */
  test('no profile may drop a hook that carries a FIXED rule id', () => {
    assert.ok(FIXED_HOOK_FILES.includes('secret-scan.js') && FIXED_HOOK_FILES.includes('shell-guard.js')
      && FIXED_HOOK_FILES.includes('index-guard.js') && FIXED_HOOK_FILES.includes('lockdown.js'),
    'the derived fixed-hook set no longer contains the security column, so this fence proves nothing');
    assert.ok(!FIXED_HOOK_FILES.includes('mcp-reaper.js'),
      'mcp-reaper carries no fixed rule id (ADR-003 reads `off` for it under light) and must stay omittable');

    const stripped = report('light', { hooks: report('light').hooks.filter((h) => h !== 'secret-scan.js') });
    const v = evaluateFootprint([report('strict'), stripped], { snippetEntries: snippetShape.entries });
    assert.equal(v.pass, false);
    assert.match(v.failures.join(' '), /composed set omits a hook carrying a FIXED rule id: secret-scan\.js/);
  });

  test('strict composing anything other than the whole snippet is a FAIL — strict IS the snippet', () => {
    const v = evaluateFootprint([report('strict', { entries: snippetShape.entries - 1 })], { snippetEntries: snippetShape.entries });
    assert.equal(v.pass, false);
    assert.match(v.failures.join(' '), /strict IS the snippet/);
  });
});

// ══ STATE 3 ═══ an unknown profile refuses before any step runs ════════════════════════════════════
describe('state 3 — an unknown profile refuses', () => {
  test('a name that is not one of the resolver\'s PROFILES is refused, and nothing is selected', () => {
    const r = parseProfiles(['--profile', 'paranoid']);
    assert.deepEqual(r.profiles, [], 'a refused run must select no profile at all');
    assert.match(r.error, /is not a posture this pack has/);
    assert.match(r.error, new RegExp(KNOWN_PROFILES.join(', ')), 'the refusal must name the postures that do exist');
    assert.match(r.error, /Refused before any step ran/);
  });

  test('the refusal is case-sensitive and does not guess', () => {
    assert.ok(parseProfiles(['--profile', 'Light']).error, '`Light` is not `light`; a posture name is not guessed at');
    assert.ok(parseProfiles(['--profile', 'strict,bogus']).error, 'one bad name in a comma list refuses the whole run');
    assert.ok(parseProfiles(['--profile']).error, '`--profile` with no value is refused');
    assert.ok(parseProfiles(['--profile', '--out']).error, 'a following flag is not read as a profile name');
    assert.ok(parseProfiles(['--profile', 'light,']).error, 'an empty name in a comma list is refused');
  });

  test('the known set is the resolver\'s, not a second list, and the default pair is strict then light', () => {
    const posture = require_(path.join(ROOT, 'hooks', '_posture.js'));
    assert.deepEqual(KNOWN_PROFILES, posture.PROFILES, 'the smoke has grown its own idea of which postures exist');
    assert.deepEqual(DEFAULT_PROFILES, ['strict', 'light']);
    for (const p of DEFAULT_PROFILES) assert.ok(posture.PROFILES.includes(p), `the default pair names ${p}, which the resolver does not have`);
    assert.deepEqual(parseProfiles([]).profiles, DEFAULT_PROFILES, 'no flag must mean the documented default pair');
    assert.equal(parseProfiles([]).explicit, false);
    assert.deepEqual(parseProfiles(['--profile', 'light', '--profile', 'light']).profiles, ['light'],
      'a repeated name must not run the same lifecycle twice');
    assert.deepEqual(parseProfiles(['--profile', 'light,strict']).profiles, ['light', 'strict'],
      'a comma list runs in the order it was written');
  });

  test('the smoke really refuses at exit 2, and really wires both verdicts in', () => {
    const src = read('ops/release-smoke.mjs');
    assert.match(src, /if \(selection\.error\) \{/, 'the smoke no longer refuses an unparseable profile selection');
    assert.match(src, /process\.exit\(2\)/, 'the refusal no longer exits 2, so "could not run" has collapsed into another outcome');
    // Refused BEFORE anything is created: the refusal must precede the first mkdtempSync in the file.
    assert.ok(src.indexOf('process.exit(2)') < src.indexOf('mkdtempSync'),
      'the profile refusal now happens after a target has been created, so a refused run leaves a target behind');
    assert.match(src, /evaluateReproduction\(\{ profile: r\.profile, observed: r\.rows \}\)/,
      'the reproduction verdict is imported but never called, which reads as covered while proving nothing');
    assert.match(src, /evaluateFootprint\(results\.map\(/,
      'the footprint verdict is imported but never called');
    assert.match(src, /failures \+= v\.failures\.length/,
      'a verdict failure no longer reaches the exit code, so the smoke could report FAIL and exit 0');
  });
});

// ══ THE FENCE ══ build-public.sh and the profile files agree ═══════════════════════════════════════
/*
 * ⛔ THE PUBLIC BUILD SHIPS THE MECHANISM AND WITHHOLDS THE RECORD OF DECIDING IT, AND THAT SPLIT IS
 * DERIVED FROM THE SCRIPT'S OWN TEXT RATHER THAN RESTATED HERE. `install/_settings-manifest.js` is
 * product code: an installed target composes its registration set and its kernel placement through it, so
 * a public build that excluded it would ship an installer that cannot run. ADR-003 and
 * `docs/design/posture-profiles-by-project-type.md` are the RECORD of the decision, and the owner marked
 * both of those document classes dev-only in the script itself (`docs/hardening`, `docs/design`) with
 * their reasons written beside them. Widening the build to carry them would contradict a decision this
 * task has no standing to reopen, so the fence holds the split rather than proposing a new one.
 */
describe('the fence — build-public.sh ships the profile mechanism and withholds the profile record', () => {
  /*
   * ⛔ THE SCRIPT THIS FENCE READS IS ITSELF DEV-ONLY, AND THE ONLY THING PERMITTED TO STAND THIS FENCE
   * DOWN IS ITS ABSENCE. `release/` is in the exclusion list it declares, so in the published package
   * there is no build script to check and a hard read would fail on a file whose absence is correct. In
   * the tree where it lives the fence runs and is as strict as ever. Absence is a different fact from
   * disagreement: a build script that is present but no longer says this must still fail loudly. Same
   * distinction, same wording, as `counts-fence.test.mjs`'s `devArtifact` helper.
   */
  const BUILD_SH = 'release/build-public.sh';
  const absent = (t) => (fs.existsSync(path.join(ROOT, BUILD_SH))
    ? false
    : (t.skip('release/build-public.sh is the build tooling itself and is absent from the published package'), true));

  /** The DEV_ONLY array, parsed out of the script rather than retyped. */
  const devOnlyOf = (sh) => {
    const block = /DEV_ONLY=\(\n([\s\S]*?)\n\)/.exec(sh);
    assert.ok(block, 'release/build-public.sh no longer declares a DEV_ONLY=( ... ) array this fence can read');
    return [...block[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
  };

  /** Would the build's own exclusion loop delete this repo-relative path? A directory takes its subtree. */
  const excludedBy = (devOnly) => (rel) => devOnly.some((d) => rel === d || rel.startsWith(`${d}/`));

  test('the exclusion list parses, and still carries the entries this split depends on', (t) => {
    if (absent(t)) return;
    const devOnly = devOnlyOf(read(BUILD_SH));
    assert.ok(devOnly.length >= 8, `parsed only ${devOnly.length} DEV_ONLY entries, so this fence is reading the wrong thing`);
    assert.ok(devOnly.includes('docs/hardening'), 'ADR-003 lives under docs/hardening; the build no longer excludes it');
    assert.ok(devOnly.includes('docs/design'), 'the posture design note lives under docs/design; the build no longer excludes it');
    assert.ok(devOnly.includes('release'), 'the script no longer excludes its own directory, which is what makes this fence dev-side');
  });

  test('the profile MECHANISM ships: nothing an installed target composes through is dev-only', (t) => {
    if (absent(t)) return;
    const excluded = excludedBy(devOnlyOf(read(BUILD_SH)));
    const productSide = [
      'install/_settings-manifest.js',   // the (profile, event) -> entries projection install.js composes through
      'install/_sources.js',             // KERNEL_FILES, the list composeKernelFiles() narrows
      'install/install.js',
      'install/upgrade.js',
      'hooks/_posture.js',               // the ONE reader of a project's posture, installed to .claude/hooks/
      'hooks/settings.snippet.json',     // the strict column itself
      'kernel/lib/reconcile.js',         // the subsystem light declines, which every other profile places
    ];
    for (const rel of productSide) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is gone, so this fence is guarding a file that no longer exists`);
      assert.ok(!excluded(rel), `${rel} is excluded from the public build, so an installed target could not compose a posture`);
    }
  });

  test('the profile RECORD stays dev-only, exactly as the owner marked its document class', (t) => {
    if (absent(t)) return;
    const excluded = excludedBy(devOnlyOf(read(BUILD_SH)));
    for (const rel of ['docs/hardening/ADR-003-posture-profiles.md', 'docs/design/posture-profiles-by-project-type.md']) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is gone; this fence names it by path`);
      assert.ok(excluded(rel), `${rel} would now ship, which widens the public build past what docs/dev and the script's own comments allow`);
    }
  });

  test('the DEV_ONLY list SAYS SO, so the next reader finds the reasoning and not just the effect', (t) => {
    if (absent(t)) return;
    const sh = read(BUILD_SH);
    const block = /DEV_ONLY=\(\n([\s\S]*?)\n\)/.exec(sh)[1];
    assert.match(block, /docs\/design'\s+#.*posture/i,
      'the docs/design entry no longer says that the posture design note stays behind while the manifest ships');
    assert.match(block, /docs\/hardening'\s+#.*ADR-003|docs\/hardening'\s+#.*posture/i,
      'the docs/hardening entry no longer names ADR-003 or the posture layer it governs');
  });

  /*
   * The build's own dead-link sweep fails the build when a SHIPPING document links to an excluded path.
   * Checked here too, because finding it at build time means finding it at publication time.
   */
  test('no shipping document links to the dev-only profile record', (t) => {
    if (absent(t)) return;
    const excluded = excludedBy(devOnlyOf(read(BUILD_SH)));
    const md = require_('node:child_process')
      .execFileSync('git', ['ls-files', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\\/g, '/'))
      .filter((p) => !excluded(p) && !p.startsWith('research/'));
    assert.ok(md.length > 20, `expected a substantial markdown inventory, got ${md.length}`);
    const offenders = [];
    for (const rel of md) {
      for (const m of read(rel).matchAll(/\]\(([^)#][^)]*\.(?:md|json|mjs|js|sh|yml))\)/g)) {
        const target = m[1];
        if (/^https?:/.test(target)) continue;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
        if (excluded(resolved)) offenders.push(`${rel} -> ${target}`);
      }
    }
    assert.deepEqual(offenders, [], `a shipping document links into the dev-only tree, which fails the public build: ${offenders.join(', ')}`);
  });
});
