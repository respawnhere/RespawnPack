#!/usr/bin/env node
/*
 * RespawnPack upgrader — THE supported update path: one command instead of the two it used to take.
 *   node install/upgrade.js [targetDir]   (default: cwd)
 *     --dry-run   previews the whole upgrade: both phases run in their dry-run forms (the full
 *                 removal listing, then the full install summary) and nothing is written
 *     --migrate-removals-scope  explicitly authorizes install.js to widen an exact legacy docs-only
 *                 removals block. Matching values alone are never treated as ownership provenance.
 *
 * WHY ONE COMMAND: updating used to be "uninstall in upgrade scope, then reinstall" — two commands
 * whose safety depends on being run together, in order, with the right flags (--for-upgrade on the
 * first; forgetting it turns the step into a full-uninstall dry run at best, a settings/CLAUDE.md
 * strip at worst). This script IS that pair, composed. It reimplements neither the removal
 * inventory nor the merge logic — it spawns the two siblings that own them:
 *   phase 1: uninstall.js <target> --for-upgrade --force   (pack files go; settings.json,
 *            CLAUDE.md, respawnpack.config.json, .gitignore, and .respawnpack/ all stay)
 *   phase 2: install.js <target>                           (the current pack lays down fresh; the
 *            kept files are merged into / skipped over, exactly as on any install)
 *
 * Default EXECUTES — deliberately unlike uninstall.js's dry-run-by-default. The uninstaller
 * defaults safe because its full scope removes things only the founder can restore; the upgrade
 * scope never touches user truth by construction (that's what --for-upgrade means), so a
 * confirm-by-default here would just re-create the two-step flow this script exists to retire.
 * --dry-run is there when you want the preview.
 *
 * PREFLIGHT: before phase 1 removes anything, the pack source itself is sanity-checked — VERSION
 * readable, both sibling scripts present, hooks/settings.snippet.json parseable, and every source
 * tree install.js reads unguarded enumerable and non-empty (plus the two root-level files it reads
 * directly, ATTRIBUTION.md and templates/CLAUDE.md, readable). A half-checkout must never strip a
 * target it can't re-lay: preflight failure aborts with the target byte-untouched.
 *
 * No third-party dependencies (fs/path/child_process only — child_process is a Node builtin, used to
 * spawn the two sibling scripts under the same Node binary running this one — plus this pack's own
 * install/_sources.js, the ONE shared list of source trees/files this preflight and install.js both
 * read; see that module's header for why it exists).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SOURCE_TREES, SOURCE_FILES, KERNEL_FILES, CORE_FILES } = require('./_sources.js');

const SRC = path.resolve(__dirname, '..');
const INSTALL_JS = path.join(__dirname, 'install.js');
const UNINSTALL_JS = path.join(__dirname, 'uninstall.js');

const KNOWN_FLAGS = new Set(['--dry-run', '--migrate-removals-scope']);
const flagArgs = process.argv.slice(2).filter((a) => a.startsWith('--'));
const unknownFlags = flagArgs.filter((f) => !KNOWN_FLAGS.has(f));
if (unknownFlags.length) {
  // Same discipline as uninstall.js: a script whose first phase removes files must not let a
  // typo'd flag fall through as a target-dir argument.
  console.error(`Unknown flag(s): ${unknownFlags.join(' ')} — supported: --dry-run --migrate-removals-scope`);
  process.exit(1);
}
const DRY_RUN = flagArgs.includes('--dry-run');
const MIGRATE_REMOVALS_SCOPE = flagArgs.includes('--migrate-removals-scope');
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// More than one positional means the shell split an unquoted spaced path ("upgrade.js C:\My Projects\app"
// would silently target C:\My) or a stray argument — refuse before ANY action, naming every value seen.
if (argv.length > 1) {
  console.error(`Too many positional arguments — expected at most one (the target dir), got: ${argv.map((a) => `"${a}"`).join(' ')}. If the path has spaces, quote it.`);
  process.exit(1);
}
const TARGET = path.resolve(argv[0] || process.cwd());
// Same canonicalization as install.js: realpath + case-fold on the case-insensitive-FS platforms
// (win32/darwin), so a case-flipped spelling of the pack root cannot dodge the self-target refusal.
const canonicalDir = (p) => {
  let r; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};
if (canonicalDir(TARGET) === canonicalDir(SRC)) { console.error('Refusing to upgrade RespawnPack against itself.'); process.exit(1); }

// ---------------------------------------------------------------------------------------------
// Preflight — nothing has touched the target yet, and nothing will until every check passes.
// SOURCE_TREES/SOURCE_FILES come from install/_sources.js — the ONE shared declaration of every
// source tree and individually-read file install.js reads UNGUARDED (its top-level trees plus the
// sub-trees it names as units: the ops/* skill dirs and memory/knowledge from skillDirs,
// templates/ci, the two library/compliance/ trees, kernel/core's own sub-trees; plus the two
// root-level files no tree check can vouch for, ATTRIBUTION.md and templates/CLAUDE.md) — i.e. the
// paths where a missing one would crash the install midway, after phase 1 already stripped the
// target. agents/ is deliberately absent from it: install.js itself treats a missing agents/ as a
// no-op, and a preflight must never be stricter than the installer it fronts. This is a
// directory-level gate for the half-checkout class — per-FILE completeness inside a listed tree
// stays install.js's own concern (and the uninstall suite's round-trip sweep is the fence for that
// inventory).
//
// ⛔ IT SAID "EVERY SOURCE TREE" AND OMITTED THE TWO THAT MATTER MOST. `kernel/` and `core/` were
// absent from this list for as long as it has existed, while phase 1's `uninstall --for-upgrade`
// deletes every one of their installed files (uninstall.js KERNEL_FILES / CORE_FILES). Reproduced
// twice on a disposable target, from a pack source torn the way a shallow clone, a sparse checkout
// or a bad merge tears one:
//   • one file missing from kernel/lib/ → preflight PASSED → the target went from 12 kernel libs
//     and 13 core files to 3 and 0, and its kernel stopped running at all;
//   • the whole core/ tree missing      → preflight PASSED → the target went from 13 core files to 0.
// Both times phase 2 died on ENOENT after phase 1 had already stripped the target, and the closing
// message said the script is "safe to repeat" — true only from an intact source, which is precisely
// what the operator does not have. THE INVARIANT IS: never delete from the target anything this
// source cannot put back, and a tree phase 1 removes that this preflight does not check is a hole
// in it.
//
// ⛔ AND THE LIST USED TO BE HAND-MAINTAINED HERE A SECOND TIME, WHICH WAS THE SAME DEFECT ONE LEVEL
// UP: a list that agrees with what install.js reads today can still silently diverge — from
// install.js's reads, or from a second copy of itself — the next time either changes and nothing
// keeps them in step. install/_sources.js is the fix: ONE declaration, required by both this
// preflight and install.js's own preflight (see that module's header for why, and install.js for
// the second consumer), so there is no second copy left to drift. The regression in
// install/uninstall.test.mjs still tears every entry in turn, so a phantom entry cannot survive and
// the kernel/core omission cannot come back — and a second test now asserts this file declares no
// SOURCE_TREES/SOURCE_FILES of its own. Recorded as the closed pair P-002 in
// docs/derived/state/pairs.json.
// ---------------------------------------------------------------------------------------------
const problems = [];
let version = '';
try {
  version = fs.readFileSync(path.join(SRC, 'VERSION'), 'utf8').trim();
  if (!version) problems.push('VERSION is empty');
} catch { problems.push('VERSION is missing or unreadable'); }
for (const rel of ['install/install.js', 'install/uninstall.js']) {
  if (!fs.existsSync(path.join(SRC, rel))) problems.push(`${rel} is missing — it is one of the two phase scripts this one composes`);
}
/*
 * ⛔ THE SNIPPET IS PARSED HERE, AND SINCE P3-T-11 IT IS ALSO COMPOSED HERE. Phase 2's merge no longer
 * copies the snippet fixed: it projects it onto the target's declared posture through
 * `install/_settings-manifest.js`. That module is therefore load-bearing in exactly the way
 * `install/install.js` is — phase 1 has already stripped the target by the time phase 2 would discover
 * it is missing or throws — so the preflight proves it LOADS AND COMPOSES rather than merely existing.
 * Every profile is composed, because a manifest that composes `strict` and dies on `light` bricks
 * precisely the target that asked for something other than the default.
 */
let snippetSource = null;
try { snippetSource = JSON.parse(fs.readFileSync(path.join(SRC, 'hooks', 'settings.snippet.json'), 'utf8')); }
catch { problems.push('hooks/settings.snippet.json is missing or not valid JSON — install.js cannot merge hooks without it'); }
if (snippetSource) {
  try {
    delete snippetSource['//'];
    const manifest = require('./_settings-manifest.js');
    const posture = require('../hooks/_posture.js');
    for (const profile of posture.PROFILES) {
      const { settings } = manifest.compose(snippetSource, profile);
      if (!settings || !settings.hooks || !Object.keys(settings.hooks).length) {
        problems.push(`install/_settings-manifest.js composed an EMPTY hook set for the \`${profile}\` posture — phase 2 would wire nothing`);
      }
    }
  } catch (e) {
    problems.push(`install/_settings-manifest.js could not compose the hook set (${e.message}) — install.js cannot merge hooks without it`);
  }
}
for (const rel of SOURCE_TREES) {
  let entries = null;
  try { entries = fs.readdirSync(path.join(SRC, rel)); } catch { problems.push(`${rel}/ is missing or unreadable`); continue; }
  if (!entries.length) problems.push(`${rel}/ is empty`);
}
for (const rel of SOURCE_FILES) {
  try { fs.readFileSync(path.join(SRC, rel)); } catch { problems.push(`${rel} is missing or unreadable`); }
}
/*
 * ⛔ AND EVERY FILE OF THE TWO TREES WHOSE LOSS BRICKS THE TARGET, not just the trees themselves.
 * A tree check answers "is kernel/lib/ there", and the reproduction that survived the tree fix was ONE
 * file missing from inside it: preflight passed, phase 1 stripped, phase 2 died on ENOENT, and the
 * target went from 12 kernel libs and 13 core files to 3 and 0. Same destruction, one granularity down.
 * Scoped to kernel/ and core/ on purpose — see the note beside these lists in _sources.js.
 */
for (const rel of [...KERNEL_FILES, ...CORE_FILES]) {
  try { fs.readFileSync(path.join(SRC, rel)); } catch { problems.push(`${rel} is missing or unreadable`); }
}
/*
 * ⛔ AND SINCE P3-K-14 THE KERNEL IS PROJECTED ONTO THE POSTURE TOO, so the projection is proved here
 * for the same reason the hook composition above is: phase 1 has already stripped the target by the
 * time phase 2 would discover that `composeKernelFiles` throws or hands back nothing. The list demanded
 * of the SOURCE stays every file (the loop above) — what a target receives is what narrows.
 */
try {
  const manifest = require('./_settings-manifest.js');
  const posture = require('../hooks/_posture.js');
  for (const profile of posture.PROFILES) {
    const { files } = manifest.composeKernelFiles(KERNEL_FILES, profile);
    if (!files.length) problems.push(`install/_settings-manifest.js composed an EMPTY kernel for the \`${profile}\` posture — phase 2 would place no kernel at all`);
    for (const rel of files) {
      if (!KERNEL_FILES.includes(rel)) problems.push(`install/_settings-manifest.js composed \`${rel}\` for the \`${profile}\` posture, which is not a kernel file this pack ships`);
    }
  }
} catch (e) {
  problems.push(`install/_settings-manifest.js could not compose the kernel file set (${e.message}) — phase 2 cannot place the kernel without it`);
}
if (problems.length) {
  console.error(`Preflight failed — the pack source at ${SRC} is not sane; NOTHING was removed from the target:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Fix the pack checkout (git status, or re-clone) and re-run.');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// The two phases. stdio: 'inherit' — each child's own output IS the progress report (the removal
// listing, the install summary); this script only adds the frame around them.
// ---------------------------------------------------------------------------------------------
if (DRY_RUN) console.log(`\n🔍 RespawnPack ${version} UPGRADE DRY RUN → ${TARGET} (both phases preview; nothing written)`);
else console.log(`\n🔄 RespawnPack ${version} UPGRADE → ${TARGET}`);

function runPhase(header, script, args) {
  console.log(`\n${header}`);
  const r = spawnSync(process.execPath, [script, TARGET, ...args], { stdio: 'inherit' });
  if (r.error) { console.error(`failed to spawn ${path.basename(script)}: ${r.error.message}`); return 1; }
  return r.status === null ? 1 : r.status; // a signal-killed child has no status; treat it as failure
}

const phase1 = runPhase(
  `phase 1/2 — clear the old pack files (uninstall.js --for-upgrade${DRY_RUN ? ', dry run' : ' --force'}; settings.json/CLAUDE.md/config/.gitignore/.respawnpack/ kept)`,
  UNINSTALL_JS,
  DRY_RUN ? ['--for-upgrade'] : ['--for-upgrade', '--force'], // no --force = the uninstaller's own dry-run default
);
if (phase1 !== 0) {
  console.error(`\nupgrade aborted: phase 1 (uninstall.js) exited ${phase1} — install.js was NOT run. Fix the cause and re-run; this script is safe to repeat.`);
  process.exit(phase1);
}

const phase2 = runPhase(
  `phase 2/2 — re-lay the current pack (install.js${DRY_RUN ? ' --dry-run' : ''}${MIGRATE_REMOVALS_SCOPE ? ' --migrate-removals-scope' : ''})`,
  INSTALL_JS,
  [...(DRY_RUN ? ['--dry-run'] : []), ...(MIGRATE_REMOVALS_SCOPE ? ['--migrate-removals-scope'] : [])],
);
if (phase2 !== 0) {
  console.error(`\nupgrade incomplete: phase 2 (install.js) exited ${phase2} after phase 1 removed the old pack files. Fix the cause and re-run — this script is safe to repeat.`);
  process.exit(phase2);
}

if (DRY_RUN) {
  // The phase-2 preview necessarily runs against the still-installed (un-stripped) target, so its
  // create/skip counts misstate the real run — say so in one line rather than leaving the founder
  // to reconcile "would create 0 / skip ~130" with an upgrade that re-creates everything.
  console.log('\nnote: the phase-2 preview runs against the un-stripped target — its counts say "skip" for files phase 1 would first remove; the real run re-creates them from the current pack.');
  console.log('(dry run — nothing was written; re-run without --dry-run to actually upgrade)');
} else console.log(`\n✅ RespawnPack ${version} upgrade complete → ${TARGET} — pack files re-laid; founder content preserved (CLAUDE.md text outside the managed block, your own hooks/permissions in settings.json, founder config fields, .respawnpack/) while pack-owned surfaces move with the version: the managed block and the config's version/upgradedAt stamp refresh on a version change, settings.json is re-serialized (2-space/LF; gains skillListingBudgetFraction when unset), and an older target's .gitignore may gain the pack's marker blocks.`);
console.log('');
