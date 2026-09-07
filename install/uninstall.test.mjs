// RespawnPack uninstaller test suite — node:test + node:assert only (zero new dependencies, per pack
// philosophy). Same harness shape as install.test.mjs: the real scripts run as child processes against
// fresh temp dirs, and the assertions read what they leave behind. Nearly every test starts from a real
// install.js run, because the uninstaller's whole contract is defined relative to what the installer
// actually placed — testing it against a hand-built fixture would just re-encode the inventory by hand,
// which is the drift this pair of files is designed to prevent.
//
// Run:
//   node --test install/uninstall.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module'; // to read install/_sources.js, a CommonJS module, from this ESM suite

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // .mjs has no CommonJS __dirname; derive it
const INSTALL_JS = path.join(__dirname, 'install.js');
const UNINSTALL_JS = path.join(__dirname, 'uninstall.js');
const UPGRADE_JS = path.join(__dirname, 'upgrade.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runScript(script, dir, flags = []) {
  const result = spawnSync(process.execPath, [script, dir, ...flags], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error(`${path.basename(script)} exited with status ${result.status}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
    err.status = result.status;
    throw err;
  }
  return result.stdout + (result.stderr ? `\n${result.stderr}` : '');
}
const runInstaller = (dir, flags) => runScript(INSTALL_JS, dir, flags);
const runUninstaller = (dir, flags) => runScript(UNINSTALL_JS, dir, flags);
const runUpgrader = (dir, flags) => runScript(UPGRADE_JS, dir, flags);
// For the refusal/conflict tests, which assert ON a non-zero exit instead of treating it as a harness error.
function runUninstallerRaw(dir, flags = []) {
  const result = spawnSync(process.execPath, [UNINSTALL_JS, dir, ...flags], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
function runUpgraderRaw(dir, flags = []) {
  const result = spawnSync(process.execPath, [UPGRADE_JS, dir, ...flags], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function readFile(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}
function fileExists(dir, rel) {
  return fs.existsSync(path.join(dir, rel));
}
function writeFileAt(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

// Recursive file listing (target-relative, forward slashes, sorted) — the ground truth the sweep and
// snapshot tests compare on. Directories are implied by their files; an empty dir shows up nowhere,
// which is exactly the uninstaller's own definition of "prunable".
function walkFiles(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, r));
    else out.push(r);
  }
  return out.sort();
}
function snapshotFiles(root) {
  return new Map(walkFiles(root).map((rel) => [rel, readFile(root, rel)]));
}

async function withTempDir(t, prefix, fn) {
  const dir = makeTempDir(prefix);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await fn(dir);
}

// --- (a) the round-trip completeness sweep: install → uninstall leaves EXACTLY the user-truth keep-set --
// This is the lockstep fence between install.js and uninstall.js: a future install.js placement that
// uninstall.js doesn't name (and that isn't deliberately kept) survives the uninstall and fails the
// exact-set comparison below — so inventory drift breaks CI instead of leaking files into targets.
test('full uninstall on a fresh install leaves exactly the user-truth keep-set', async (t) => {
  await withTempDir(t, 'rpu-sweep-', (dir) => {
    runInstaller(dir);
    runUninstaller(dir, ['--force']);

    const KEEP = [
      // canonical spine (founder truth) + the docs-system index page
      'docs/README.md', 'docs/PRODUCT.md', 'docs/FEATURES-PAGES.md', 'docs/DECISIONS.md', 'docs/DESIGN.md', 'docs/ARCHITECTURE-ROADMAP.md',
      // derived docs (/savepoint's ledger — never the pack's to delete)
      'docs/derived/CHANGELOG.md', 'docs/derived/GAPS.md', 'docs/derived/CONTINUITY.md',
      // the killed-feature registry: AUTHORED by the project, so it is founder truth for the same
      // reason DECISIONS.md is. The installer now seeds an empty skeleton, and uninstall must leave
      // it — a founder who recorded twenty removals and then uninstalled would otherwise lose the
      // whole record. Covered by the "docs/derived/* is never touched, in any mode" rule already.
      'docs/derived/state/removals.json',
      // archive convention page (the archive may hold the founder's own retired docs)
      'docs/_archive/README.md',
      // compliance.config.md is placed unconditionally — it is the form a target fills in to declare
      // a scope (P2-T-12) — and it is protected at install time too. docs/compliance/*.md are NOT
      // here: this is a plain `runInstaller(dir)` with no declared scope, so install.js's §1b gate
      // never placed them at all; see the dedicated compliance-scope tests below for the
      // declared-scope state, where they ARE placed and ARE in the keep-set.
      'compliance.config.md',
      // the knowledge graph floor — memory/** is user truth wholesale
      'memory/graph/.gitkeep',
      // founder-edited config (kept by default; --purge-config is the explicit opt-out)
      'respawnpack.config.json',
      // settings.json survives with our hooks stripped: permissions.allow + skillListingBudgetFraction stay
      '.claude/settings.json',
    ].sort();
    assert.deepEqual(walkFiles(dir), KEEP, 'after install→uninstall, the target must hold exactly the keep-set — anything extra is inventory drift between install.js and uninstall.js');

    const settings = JSON.parse(readFile(dir, '.claude/settings.json'));
    assert.equal(settings.hooks, undefined, 'the hooks object held only pack entries, so it must be pruned away entirely');
    assert.ok(settings.permissions.allow.includes('Bash(git status)'), 'permissions.allow must survive a full uninstall (read-only allows, possibly user-tuned by now)');
    assert.equal(settings.skillListingBudgetFraction, 0.02, 'skillListingBudgetFraction must survive too');
  });
});

// --- (a1) T-13: the round-trip sweep with the "agents" extras declared also leaves exactly the keep-set --
// The sweep above already proves the CORE-only state (22 agents, the new default) uninstalls clean, since
// uninstall.js's AGENT_FILES inventory is gate-independent — built by enumerating the pack's OWN agents/
// source tree, the same shape it already used for the stack-gated MCP skills, not by what a given target
// happened to receive. It needed no change for T-13. This proves the OTHER state: a target that declared
// the "agents" extras entry and received all 32 agent files also leaves no orphan.
test('full uninstall on an install with the "agents" extras declared also leaves exactly the user-truth keep-set', async (t) => {
  await withTempDir(t, 'rpu-sweep-agents-extras-', (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'respawnpack.config.json'), JSON.stringify({ extras: ['agents'] }, null, 2));
    runInstaller(dir);
    assert.equal(
      fs.readdirSync(path.join(dir, '.claude', 'agents')).filter((f) => f.endsWith('.md')).length, 32,
      'the fixture must actually receive the full 32-agent bench for this test to mean anything',
    );

    runUninstaller(dir, ['--force']);

    const KEEP = [
      'docs/README.md', 'docs/PRODUCT.md', 'docs/FEATURES-PAGES.md', 'docs/DECISIONS.md', 'docs/DESIGN.md', 'docs/ARCHITECTURE-ROADMAP.md',
      'docs/derived/CHANGELOG.md', 'docs/derived/GAPS.md', 'docs/derived/CONTINUITY.md',
      'docs/derived/state/removals.json',
      'docs/_archive/README.md',
      'compliance.config.md',
      'memory/graph/.gitkeep',
      'respawnpack.config.json',
      '.claude/settings.json',
    ].sort();
    assert.deepEqual(walkFiles(dir), KEEP, 'after install→uninstall from the extras-declared state, the target must hold exactly the keep-set — none of the 10 extra agent files survives as an orphan');
  });
});

// --- (a2) receipt-based adapter removal: the placement receipt is written, replayed, and contained -----
// install.js §3c writes .respawnpack/install-receipt.json derived from its own placedPaths; uninstall.js
// replays it under .claude/adapters/. Sweep (a) above already proves completeness (a receipted file the
// uninstall misses fails its exact keep-set). These prove the three properties that sweep cannot see on
// its own: the receipt names what was placed, an upgrade preserves it, and a path outside the adapter
// root is refused rather than removed.
test('install writes a placement receipt naming exactly the adapter files it placed', async (t) => {
  await withTempDir(t, 'rpu-receipt-write-', (dir) => {
    runInstaller(dir);
    const receipt = JSON.parse(readFile(dir, '.respawnpack/install-receipt.json'));
    assert.equal(receipt.schemaVersion, 2, 'the receipt carries its schema version — bumped to 2 when P3-T-08 added the settings-hook tuples beside the adapter paths');
    const placed = walkFiles(dir).filter((p) => p.startsWith('.claude/adapters/'));
    assert.deepEqual([...receipt.adapters].sort(), placed.sort(),
      'the receipt must name EXACTLY the files present under .claude/adapters/ — it is derived from placedPaths, so any divergence is a bug in the receipt, not the tree');
    assert.ok(placed.includes('.claude/adapters/claude-code/interactive/profile.js'), 'the interactive profile module is placed and receipted');
    assert.ok(placed.includes('.claude/adapters/claude-code/interactive/probe.js'), 'the interactive canary module is placed and receipted');
    // P5-CT-4: sdk-supervisor and statusline join the same receipt, from the same ADAPTER_FILES
    // declaration in install/_sources.js — named explicitly here, beside the interactive pair above,
    // rather than trusting the blanket deepEqual alone to say so.
    for (const f of ['cli.js', 'capabilities.js', 'measure.js', 'stream.js', 'supervisor.js', 'canary.js']) {
      assert.ok(placed.includes(`.claude/adapters/claude-code/sdk-supervisor/${f}`), `sdk-supervisor/${f} is placed and receipted`);
    }
    assert.ok(placed.includes('.claude/adapters/claude-code/statusline/statusline.js'), 'the statusline tee is placed and receipted');
  });
});

/*
 * P3-T-08 — the receipt's SECOND kind of placement: the (event, matcher, command, if) tuples the
 * settings merge laid into a file the pack does not own. Sweep (a) above proves the uninstall still
 * strips settings.json clean; these prove the receipt half specifically — that it names what the merge
 * placed, that the uninstaller replays it, and that a founder's own hooks are not in its reach.
 */
test('the receipt names every settings hook the merge placed, and uninstall replays it', async (t) => {
  await withTempDir(t, 'rpu-receipt-hooks-', (dir) => {
    runInstaller(dir);
    const receipt = JSON.parse(readFile(dir, '.respawnpack/install-receipt.json'));
    const settings = JSON.parse(readFile(dir, '.claude/settings.json'));

    const inFile = [];
    for (const [evt, groups] of Object.entries(settings.hooks)) {
      for (const g of groups) for (const h of (g.hooks || [])) inFile.push([evt, g.matcher || '', h.command, h.if || ''].join(''));
    }
    const inReceipt = receipt.settingsHooks.map((t2) => [t2.event, t2.matcher, t2.command, t2.if].join(''));
    assert.deepEqual(inReceipt.sort(), inFile.sort(),
      'on a fresh install the receipt must name EXACTLY the hook tuples now in settings.json — a tuple it misses is one a founder can never durably remove, and one it invents is one the uninstaller would strip without having placed it');
    assert.equal(receipt.settingsHooks.filter((t2) => t2.command.includes('secret-scan.js')).length, 2,
      'anti-drift item 29: secret-scan\'s two Bash registrations are two rules and must be recorded as two tuples');

    runUninstaller(dir, ['--force']);
    const after = JSON.parse(readFile(dir, '.claude/settings.json'));
    assert.equal(after.hooks, undefined, 'every receipted tuple is replayed out of settings.json, so the hooks object is pruned away entirely');
  });
});

test('a receipt tuple the current snippet no longer names is still replayed; a founder hook it does not name is left alone', async (t) => {
  await withTempDir(t, 'rpu-receipt-hooks-legacy-', (dir) => {
    runInstaller(dir);

    // Two shapes side by side under one event: a hook an OLDER pack version wired (so today's snippet
    // does not name it, and only the receipt can) and a founder's own hook (which neither names).
    const settingsPath = path.join(dir, '.claude/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [
      { type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/retired-in-a-later-version.js', timeout: 30 },
      { type: 'command', command: 'node my-own-guard.js' },
    ] });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    const receiptPath = path.join(dir, '.respawnpack/install-receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.settingsHooks.push({ event: 'PreToolUse', matcher: 'Bash', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/retired-in-a-later-version.js', if: '' });
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

    const output = runUninstaller(dir, ['--force']);
    const after = JSON.parse(readFile(dir, '.claude/settings.json'));
    const commands = Object.values(after.hooks || {}).flat().flatMap((g) => g.hooks || []).map((h) => h.command);
    assert.deepEqual(commands, ['node my-own-guard.js'],
      'the receipted tuple must go even though today\'s snippet never names it (that is the LEGACY_HOOK_ENTRIES gap the record closes), and the founder\'s own hook — named by neither snippet nor receipt — must stay');
    assert.match(output, /came from the receipt alone/, 'the summary must disclose that a removal rested on the receipt rather than on today\'s snippet');
  });
});

test('a receipt tuple naming a hook the founder never had removes nothing else (containment)', async (t) => {
  await withTempDir(t, 'rpu-receipt-hooks-containment-', (dir) => {
    runInstaller(dir);
    const settingsPath = path.join(dir, '.claude/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'node founder-prompt-hook.js' }] }];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    // A torn/tampered receipt: rows with no command, no event, a non-object, and one naming the
    // founder's hook under the WRONG event — none of which may reach anything.
    const receiptPath = path.join(dir, '.respawnpack/install-receipt.json');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.settingsHooks = [
      ...receipt.settingsHooks,
      { event: 'UserPromptSubmit' },
      { command: 'node founder-prompt-hook.js' },
      'not-an-object',
      { event: 'SessionStart', matcher: '', command: 'node founder-prompt-hook.js', if: '' },
    ];
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

    runUninstaller(dir, ['--force']);
    const after = JSON.parse(readFile(dir, '.claude/settings.json'));
    assert.deepEqual(Object.keys(after.hooks || {}), ['UserPromptSubmit'],
      'a receipt is data: a malformed row names nothing, and a well-formed one only ever matches a hook under the exact event AND matcher it names');
    assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, 'node founder-prompt-hook.js', 'the founder hook the receipt mis-addressed must survive byte-identical');
  });
});

test('--for-upgrade keeps the receipt\'s hook tuples through phase 1, so phase 2 can respect a removal', async (t) => {
  await withTempDir(t, 'rpu-receipt-hooks-upgrade-', (dir) => {
    runInstaller(dir);
    const before = JSON.parse(readFile(dir, '.respawnpack/install-receipt.json')).settingsHooks;
    assert.ok(before.length >= 20, 'precondition: the install recorded the full snippet');

    runUninstaller(dir, ['--for-upgrade', '--force']); // exactly what upgrade.js phase 1 runs

    const after = JSON.parse(readFile(dir, '.respawnpack/install-receipt.json')).settingsHooks;
    assert.deepEqual(after, before,
      'anti-drift item 31: --for-upgrade preserves .respawnpack/ and settings.json untouched, so the ownership record survives phase 1 intact — phase 2 rewrites it, and a founder-removed entry it names must still be respected there');
    assert.ok(readFile(dir, '.claude/settings.json').includes('index-guard.js'),
      '--for-upgrade does not touch settings.json at all, so the hooks it holds are phase 2\'s input');
  });
});

test('--for-upgrade removes the adapter files but keeps the receipt for phase 2 to rewrite', async (t) => {
  await withTempDir(t, 'rpu-receipt-upgrade-', (dir) => {
    runInstaller(dir);
    runUninstaller(dir, ['--for-upgrade', '--force']);
    assert.equal(fileExists(dir, '.claude/adapters/claude-code/interactive/profile.js'), false,
      'the adapter modules are pack surface — an upgrade removes them so phase 2 re-lays the current pack');
    assert.equal(fileExists(dir, '.respawnpack/install-receipt.json'), true,
      'the receipt lives under .respawnpack/ (session state an upgrade preserves); phase 2 rewrites it from the freshly-placed set');
  });
});

/*
 * ⛔ P5-CT-4: THE UNCONDITIONAL REMOVAL ABOVE WAS SAFE ONLY BECAUSE NOTHING HAD EVER EDITED THE FILE.
 *
 * Phase 2 of an upgrade (install.js, no --force) SKIPS any destination that already exists — that is
 * what lets a founder-added settings.json hook or a filled-in CODEOWNERS survive a routine upgrade. So
 * the ONLY thing standing between a hand-patched adapter file and losing that edit on the next upgrade
 * was phase 1 (uninstall --for-upgrade) choosing to remove it unconditionally. It no longer does: the
 * receipt loop is content-matched now, the same way REMOVE_IF_UNMODIFIED already is for
 * CODEOWNERS/ATTRIBUTION/etc below — byte-equal to what this pack version ships is removed and re-laid
 * fresh (proven by the test above, which never edits the file); anything else is kept, and the summary
 * says so the same way it already does for an edited CODEOWNERS.
 */
test('upgrade.js keeps a founder-modified adapter file byte-for-byte and reports it, while an untouched sibling still refreshes', async (t) => {
  await withTempDir(t, 'rpu-upgrade-adapter-modified-', (dir) => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    runInstaller(dir);

    const cliRel = '.claude/adapters/claude-code/sdk-supervisor/cli.js';
    fs.appendFileSync(path.join(dir, cliRel), '\n// FOUNDER: raised the turn timeout for our slower CI runners — an upgrade must not eat this.\n');
    const modifiedContent = readFile(dir, cliRel);

    const probeRel = '.claude/adapters/claude-code/interactive/probe.js';
    const probeBefore = readFile(dir, probeRel);

    const output = runUpgrader(dir); // the full one-command path, both phases, real run

    assert.equal(readFile(dir, cliRel), modifiedContent,
      'a founder-modified adapter file must survive a full upgrade byte-for-byte');
    assert.match(output, /kept \d+ file\(s\) you have edited since install/,
      'the upgrade must say it kept an edited file, not stay silent about it');
    assert.match(output, /sdk-supervisor\/cli\.js/, 'the report must name the specific file it kept');

    // An untouched sibling is unaffected either way: it matched pack source, so phase 1 removed it and
    // phase 2 re-laid it fresh — byte-identical to what it was, but via the ordinary path, not a skip.
    assert.equal(readFile(dir, probeRel), probeBefore, 'an unmodified sibling adapter file must be unchanged after the round trip');

    // The regenerated receipt still names the founder-kept file — ownership continuity into the next cycle.
    const receipt = JSON.parse(readFile(dir, '.respawnpack/install-receipt.json'));
    assert.ok(receipt.adapters.includes(cliRel), 'the kept, founder-modified file must still be receipted so a later uninstall/upgrade knows about it');
  });
});

test('a receipt naming a path outside .claude/adapters/ removes nothing outside it (containment)', async (t) => {
  await withTempDir(t, 'rpu-receipt-containment-', (dir) => {
    runInstaller(dir);
    writeFileAt(dir, 'DO-NOT-DELETE.txt', 'founder file the receipt has no business naming\n');
    // A tampered/torn receipt: a bare root path, a `..` escape, and one legitimate in-bounds entry.
    writeFileAt(dir, '.respawnpack/install-receipt.json', JSON.stringify({
      schemaVersion: 1,
      adapters: ['DO-NOT-DELETE.txt', '.claude/adapters/../../DO-NOT-DELETE.txt', '.claude/adapters/claude-code/interactive/profile.js'],
    }));
    runUninstaller(dir, ['--force']);
    assert.equal(fileExists(dir, 'DO-NOT-DELETE.txt'), true,
      'a receipt is data; a path outside .claude/adapters/ — directly or via .. — must be refused, never removed');
    assert.equal(fileExists(dir, '.claude/adapters/claude-code/interactive/profile.js'), false,
      'the one in-bounds adapter path is still replayed and removed');
  });
});

// --- (a3) P2-T-12: uninstall handles BOTH compliance-scope states cleanly, no orphan either way ----------
// install.js §1b/§4c now places library/ and docs/compliance/ only when compliance.config.md declares a
// non-empty scope. Sweep (a) above already proves the no-scope state leaves no orphan (its KEEP-set has
// no library/ or docs/compliance/ entries, because a plain runInstaller() never places them). This proves
// the OTHER state: a target that DID declare a scope gets library/ removed (REMOVE_IF_UNMODIFIED, unless
// hand-edited) while docs/compliance/ and compliance.config.md survive (protected, never-touched) — and
// neither state's uninstall errors or leaves an orphaned library/ directory behind.
const DECLARED_SCOPE_CONFIG_FOR_UNINSTALL = `# Test project — compliance scope

## 4. Applicable frameworks (the resolved list)
- **Default scope (almost always):** GDPR, CCPA
- **Conditional/sector (triggered):** none
- **Explicitly out of scope (and why):** n/a
`;

test('uninstall from a target with a declared compliance scope removes library/ but leaves docs/compliance/ and compliance.config.md, with no orphan', async (t) => {
  await withTempDir(t, 'rpu-compliance-scope-', (dir) => {
    writeFileAt(dir, 'compliance.config.md', DECLARED_SCOPE_CONFIG_FOR_UNINSTALL);
    runInstaller(dir);
    assert.equal(fileExists(dir, 'library/compliance/requirements/gdpr.md'), true, 'precondition: the declared scope placed library/');
    assert.equal(fileExists(dir, 'docs/compliance/README.md'), true, 'precondition: the declared scope placed docs/compliance/');

    runUninstaller(dir, ['--force']);

    assert.equal(fileExists(dir, 'library'), false, 'library/ is pack-owned reference material (REMOVE_IF_UNMODIFIED) and must be fully removed, leaving no orphaned directory');
    assert.equal(fileExists(dir, 'docs/compliance/README.md'), true, 'docs/compliance/ is a living artifact /comply maintains — never touched by uninstall, in any mode');
    assert.equal(fileExists(dir, 'docs/compliance/REGISTER.md'), true);
    assert.equal(fileExists(dir, 'compliance.config.md'), true, 'compliance.config.md is never touched by uninstall either');
    // The DECLARED_SCOPE_CONFIG_FOR_UNINSTALL content itself must survive byte-for-byte — it is the
    // founder's own declared scope, not pack-owned content REMOVE_IF_UNMODIFIED could match.
    assert.equal(readFile(dir, 'compliance.config.md'), DECLARED_SCOPE_CONFIG_FOR_UNINSTALL);
  });
});

test('uninstall from a target with NO declared compliance scope (library/ never placed) does not error and leaves no orphan', async (t) => {
  await withTempDir(t, 'rpu-compliance-noscope-', (dir) => {
    runInstaller(dir); // no compliance.config.md seeded — the installer's own unfilled template
    assert.equal(fileExists(dir, 'library'), false, 'precondition: no declared scope placed no library/');

    const output = runUninstaller(dir, ['--force']); // must not throw / exit non-zero (runUninstaller does both)

    assert.equal(fileExists(dir, 'library'), false, 'still absent — uninstall must not error trying to remove a tree that was never placed');
    assert.equal(fileExists(dir, 'compliance.config.md'), true, 'compliance.config.md (unconditionally placed) survives, never touched by uninstall');
    assert.doesNotMatch(output, /ENOENT|TypeError|undefined is not|Cannot read propert/i,
      'the REMOVE_IF_UNMODIFIED existence check must skip an absent library/ file silently, not surface a crash');
  });
});

// --- (b) surgical, not scorched-earth: user content survives everywhere the pack removes around it ------
test('uninstall removes pack files around user content without touching it: seeded files, hook groups, CLAUDE.md text, canonical docs', async (t) => {
  await withTempDir(t, 'rpu-surgical-', (dir) => {
    runInstaller(dir);

    // Seed user truth in every surface the uninstaller operates on.
    const productText = 'FOUNDER-WRITTEN PRODUCT.md — an uninstall must never touch this\n';
    fs.writeFileSync(path.join(dir, 'docs/PRODUCT.md'), productText);
    const skillNote = 'user notes living INSIDE a pack skill dir\n';
    writeFileAt(dir, '.claude/skills/build/notes.md', skillNote);
    const refNote = 'user doc inside docs/reference/ — file-level surgery must leave it (and its dir)\n';
    writeFileAt(dir, 'docs/reference/team-notes.md', refNote);

    const settingsPath = path.join(dir, '.claude/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // A user hook riding inside OUR matcher group, a whole user group on a matcher we also use, and a
    // user-only event — all three shapes must survive while our entries around them disappear.
    settings.hooks.PreToolUse.find((g) => g.matcher === 'Edit|Write|MultiEdit|NotebookEdit').hooks.push({ type: 'command', command: 'node my-edit-hook.js' });
    settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node my-own-guard.js' }] });
    settings.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'node my-prompt-hook.js' }] }];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    const userBefore = '# My Project\n\nHand-written guidance before the block.\n\n';
    const userAfter = '\nHand-written guidance after the block.\n';
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), userBefore + readFile(dir, 'CLAUDE.md') + userAfter);

    const output = runUninstaller(dir, ['--force']);

    // Pack artifacts around the seeds are gone…
    assert.ok(!fileExists(dir, '.claude/skills/build/SKILL.md'), 'the pack SKILL.md must be removed');
    assert.ok(!fileExists(dir, 'docs/reference/coding-standards.md'), 'pack reference docs must be removed');
    // …the seeds and their dirs are not.
    assert.equal(readFile(dir, '.claude/skills/build/notes.md'), skillNote, 'a user file inside a pack skill dir must survive, byte-identical');
    assert.equal(readFile(dir, 'docs/reference/team-notes.md'), refNote, 'a user file inside docs/reference/ must survive — and keep the dir from being pruned');
    assert.equal(readFile(dir, 'docs/PRODUCT.md'), productText, 'canonical docs are user truth in every mode');

    const after = JSON.parse(readFile(dir, '.claude/settings.json'));
    const allCommands = Object.values(after.hooks).flat().flatMap((g) => g.hooks).map((h) => h.command);
    assert.deepEqual(allCommands.sort(), ['node my-edit-hook.js', 'node my-own-guard.js', 'node my-prompt-hook.js'], 'exactly the three user hooks must remain — every pack hook gone, no user hook lost');
    const editGroups = after.hooks.PreToolUse.filter((g) => g.matcher === 'Edit|Write|MultiEdit|NotebookEdit');
    assert.equal(editGroups.length, 1, 'our Edit-matcher group had a user hook in it, so the GROUP must survive (only our entries inside it go)');
    assert.equal(after.hooks.Stop, undefined, 'an event array that held only pack hooks must be pruned');
    assert.ok(after.hooks.UserPromptSubmit, 'a user-only event must be untouched');

    const claude = readFile(dir, 'CLAUDE.md');
    assert.ok(claude.includes(userBefore.trim()), 'CLAUDE.md text before the block must survive');
    assert.ok(claude.includes(userAfter.trim()), 'CLAUDE.md text after the block must survive');
    assert.doesNotMatch(claude, /RESPAWNPACK:BEHAVIOR/, 'the marker block itself must be fully stripped');
    assert.match(output, /your text kept/, 'summary should say the strip kept the user text');
  });
});

// --- (c) dry-run is the DEFAULT and changes nothing --------------------------------------------------
test('no-flag run is a dry run: full listing printed, byte-for-byte nothing changes', async (t) => {
  await withTempDir(t, 'rpu-dryrun-', (dir) => {
    runInstaller(dir);
    writeFileAt(dir, '.respawnpack/wave-ledger.md', 'in-flight ledger — a dry run must not eat this\n');
    const before = snapshotFiles(dir);

    const output = runUninstaller(dir); // no flags at all — the safety default

    assert.match(output, /UNINSTALL DRY RUN/, 'the no-flag mode must announce itself as a dry run');
    assert.match(output, /would remove \d+ pack file\(s\)/, 'the listing must use "would" phrasing');
    assert.match(output, /- \.claude\/skills\/build\/SKILL\.md/m, 'the dry run must print the full per-file listing, not just counts');
    assert.match(output, /re-run with --force/, 'the dry run must say how to execute for real');
    assert.deepEqual(snapshotFiles(dir), before, 'a dry run must leave every file byte-identical — no removal, no settings/CLAUDE.md/.gitignore rewrite');

    const output2 = runUninstaller(dir, ['--force', '--dry-run']); // explicit --dry-run beats --force
    assert.match(output2, /dry run wins/, 'combining --force with --dry-run must fall back to the dry run, and say so');
    assert.deepEqual(snapshotFiles(dir), before, '--force --dry-run must still change nothing');
  });
});

// --- (d) --for-upgrade: pack files go, the re-lay surface stays, install.js round-trips cleanly ---------
test('--for-upgrade removes pack files but keeps settings/CLAUDE.md/config/.gitignore/.respawnpack, and a reinstall round-trips', async (t) => {
  await withTempDir(t, 'rpu-upgrade-', (dir) => {
    spawnSync('git', ['init', '-q'], { cwd: dir }); // the installer's .gitignore step is git-repo-gated, and this round-trip asserts on that file
    runInstaller(dir);
    writeFileAt(dir, '.respawnpack/wave-ledger.md', 'session state that must survive an upgrade\n');
    const keepBytes = {};
    for (const rel of ['.claude/settings.json', 'CLAUDE.md', 'respawnpack.config.json', '.gitignore']) keepBytes[rel] = readFile(dir, rel);

    runUninstaller(dir, ['--for-upgrade', '--force']);

    assert.ok(!fileExists(dir, '.claude/skills/build/SKILL.md'), 'pack skills must be removed in upgrade scope');
    assert.ok(!fileExists(dir, 'docs/reference/coding-standards.md'), 'pack reference docs must be removed in upgrade scope');
    assert.ok(!fileExists(dir, '.claude/hooks/lockdown.js'), 'pack hooks must be removed in upgrade scope');
    for (const [rel, bytes] of Object.entries(keepBytes)) {
      assert.equal(readFile(dir, rel), bytes, `${rel} must survive --for-upgrade byte-identical — install.js re-lays on top of it`);
    }
    assert.equal(readFile(dir, '.respawnpack/wave-ledger.md'), 'session state that must survive an upgrade\n', '.respawnpack/ is the target\'s session state, not a pack version\'s — an upgrade keeps it');

    runInstaller(dir); // the re-lay: a plain install, exactly what the upgrade doc-flow prescribes

    assert.ok(fileExists(dir, '.claude/skills/build/SKILL.md'), 'the reinstall must re-lay the pack skills');
    assert.ok(fileExists(dir, '.claude/hooks/lockdown.js'), 'the reinstall must re-lay the hooks');
    assert.equal(readFile(dir, '.claude/settings.json'), keepBytes['.claude/settings.json'], 'the reinstall must find every hook already wired and leave settings.json byte-identical (no duplicates)');
    assert.equal(readFile(dir, 'CLAUDE.md'), keepBytes['CLAUDE.md'], 'the reinstall must see the marker block present and leave CLAUDE.md byte-identical');
    assert.equal(readFile(dir, 'respawnpack.config.json'), keepBytes['respawnpack.config.json'], 'the reinstall must keep the protected config byte-identical');
  });
});

// --- (e) the mcp-fly legacy class: a stack-drift orphan is removed even though today's gate skips it ----
test('a stranded mcp-fly (placed when the stack matched, orphaned when it moved on) is removed', async (t) => {
  await withTempDir(t, 'rpu-legacy-fly-', (dir) => {
    runInstaller(dir); // no fly.toml → today's install gate skips mcp-fly entirely
    assert.ok(!fileExists(dir, '.claude/skills/mcp-fly/SKILL.base.md'), 'precondition: the gate must not have placed mcp-fly');
    // Simulate the harvest's finding: an older install ran while fly.toml existed, then the stack moved on.
    writeFileAt(dir, '.claude/skills/mcp-fly/SKILL.base.md', '# stranded frozen base from a fly-era install\n');
    writeFileAt(dir, '.claude/skills/mcp-fly/SKILL.md', '# stranded living copy from a fly-era install\n');

    const output = runUninstaller(dir, ['--force']);

    assert.ok(!fileExists(dir, '.claude/skills/mcp-fly/SKILL.base.md'), 'the stranded frozen base must be removed — the inventory names every shipped server, gate or no gate');
    assert.ok(!fileExists(dir, '.claude/skills/mcp-fly/SKILL.md'), 'the stranded living copy must be removed');
    assert.ok(!fileExists(dir, '.claude/skills/mcp-fly'), 'the emptied mcp-fly dir must be pruned');
    assert.match(output, /mcp-fly\/SKILL\.md/, 'the listing should name the orphan it removed');
  });
});

// --- (f) the mcp-routing lesson: a target-authored skill inside our mcp-* namespace SURVIVES -----------
test('a target-authored mcp-routing skill in our mcp-* namespace survives while pack mcp-* siblings are removed', async (t) => {
  await withTempDir(t, 'rpu-routing-', (dir) => {
    runInstaller(dir);
    const routing = '---\nname: mcp-routing\n---\n\nthe founder\'s own hand-written MCP routing skill, NOT the pack\'s.\n';
    writeFileAt(dir, '.claude/skills/mcp-routing/SKILL.md', routing);

    runUninstaller(dir, ['--force']);

    assert.equal(readFile(dir, '.claude/skills/mcp-routing/SKILL.md'), routing, 'mcp-routing must survive byte-identical — removal is by inventory name, never by mcp-* prefix');
    assert.ok(!fileExists(dir, '.claude/skills/mcp-runtime/SKILL.md'), 'pack mcp-* siblings must still be removed around it');
    assert.ok(!fileExists(dir, '.claude/skills/mcp-context7/SKILL.md'), 'pack mcp-* siblings must still be removed around it');
  });
});

// --- (g) hand-filled shared-namespace files: kept once edited, removed only while pristine (the
// pristine-removed half is what sweep (a) proves — CODEOWNERS is not in its keep-set) ------------------
test('an edited .github/CODEOWNERS is kept and reported', async (t) => {
  await withTempDir(t, 'rpu-codeowners-', (dir) => {
    runInstaller(dir);
    const filled = '# Filled in by the founder\n* @your-github-handle\n';
    fs.writeFileSync(path.join(dir, '.github/CODEOWNERS'), filled);

    const output = runUninstaller(dir, ['--force']);

    assert.equal(readFile(dir, '.github/CODEOWNERS'), filled, 'a CODEOWNERS the founder filled in is user truth now — it must be kept');
    assert.match(output, /kept 1 file\(s\) you have edited/, 'the summary must report the kept-because-edited file');
    assert.match(output, /- \.github\/CODEOWNERS/, 'the summary must name it');
  });
});

// --- (h) .gitignore ownership proof: marker blocks are ours; a bare hand-written rule is not ------------
test('a hand-written .respawnpack/ ignore rule (no markers) survives; the installer\'s marker block is removed', async (t) => {
  await withTempDir(t, 'rpu-gitignore-hand-', (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir }); // the installer's gitignore step is git-repo-gated
    // Hand-written rule BEFORE install: the installer detects it and adds no block of its own.
    fs.writeFileSync(path.join(dir, '.gitignore'), '# local state\n.respawnpack/\n');
    runInstaller(dir);

    runUninstaller(dir, ['--force']);

    assert.equal(readFile(dir, '.gitignore'), '# local state\n.respawnpack/\n', 'a markerless rule is ambiguous (possibly hand-written), so it must be left byte-identical');
  });
});

test('the installer-added .respawnpack/ marker block is removed but user rules around it stay', async (t) => {
  await withTempDir(t, 'rpu-gitignore-marker-', (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir }); // the installer's gitignore step is git-repo-gated
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n');
    runInstaller(dir); // appends the marker-wrapped .respawnpack/ block below the user rules

    runUninstaller(dir, ['--force']);

    const gi = readFile(dir, '.gitignore');
    assert.ok(gi.startsWith('node_modules/\ndist/'), 'the user\'s own rules must survive at the top');
    assert.doesNotMatch(gi, /RespawnPack: runtime state/, 'the marker block must be gone');
    assert.doesNotMatch(gi, /^\.respawnpack\/$/m, 'the rule inside the removed block must be gone with it');
  });
});

// --- (i) respawnpack.config.json: kept by default, removed only with the explicit flag -----------------
test('--purge-config removes respawnpack.config.json; the default keeps it', async (t) => {
  await withTempDir(t, 'rpu-config-', (dir) => {
    runInstaller(dir);
    runUninstaller(dir, ['--force']);
    assert.ok(fileExists(dir, 'respawnpack.config.json'), 'the founder-edited config must be kept by default');

    runUninstaller(dir, ['--force', '--purge-config']);
    assert.ok(!fileExists(dir, 'respawnpack.config.json'), '--purge-config is the explicit opt-in that removes it');
  });
});

// --- (j) refusals: self-target, contradictory flags, unknown flags all exit non-zero, changing nothing --
test('refuses to run against the pack itself, on contradictory flags, and on unknown flags', async (t) => {
  await withTempDir(t, 'rpu-refuse-', (dir) => {
    const self = runUninstallerRaw(path.resolve(__dirname, '..'), ['--force']);
    assert.equal(self.status, 1, 'uninstalling the pack from itself must be refused');
    assert.match(self.stderr, /Refusing to uninstall RespawnPack from itself/);

    runInstaller(dir);
    const before = snapshotFiles(dir);

    const conflict = runUninstallerRaw(dir, ['--force', '--for-upgrade', '--purge-config']);
    assert.equal(conflict.status, 1, '--purge-config with --for-upgrade is a contradiction, not a precedence puzzle');
    assert.match(conflict.stderr, /contradicts --for-upgrade/);

    const typo = runUninstallerRaw(dir, ['--froce']);
    assert.equal(typo.status, 1, 'an unknown flag must hard-fail — a destructive tool cannot let a typo fall through');
    assert.match(typo.stderr, /Unknown flag\(s\): --froce/);

    assert.deepEqual(snapshotFiles(dir), before, 'every refusal must leave the target byte-identical');
  });
});

// --- (k) upgrade.js: the one-command update path (uninstall --for-upgrade + reinstall, composed) --------
// Test (d) above proves the two-phase mechanism round-trips; these prove the wrapper that owns it:
// default-executes with founder content intact, --dry-run previews both phases without writing (the
// CHILDREN's own dry-run banners are asserted, so flag-forwarding can't silently regress), preflight
// aborts on a torn pack source before phase 1 touches the target, and the same typo/extra-positional/
// self-target refusal discipline as the uninstaller it fronts.
test('upgrade.js round-trips in one command: pack files back, founder edits to CLAUDE.md/config/settings/.gitignore untouched', async (t) => {
  await withTempDir(t, 'rpu-upgrade-cmd-', (dir) => {
    spawnSync('git', ['init', '-q'], { cwd: dir }); // the installer's .gitignore step is git-repo-gated, and this test pins that file byte-for-byte
    runInstaller(dir);

    // Hand-edit user truth on every surface the upgrade scope promises to keep.
    const founderText = '\n## Founder guidance\n\nHand-written text outside the markers — an upgrade must not eat this.\n';
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), founderText);
    const cfgPath = path.join(dir, 'respawnpack.config.json');
    const cfg = JSON.parse(readFile(dir, 'respawnpack.config.json'));
    cfg.extras = ['adopted:mcp-graphify'];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    const settingsPath = path.join(dir, '.claude/settings.json');
    const settings = JSON.parse(readFile(dir, '.claude/settings.json'));
    settings.hooks.PreToolUse.find((g) => g.matcher === 'Edit|Write|MultiEdit|NotebookEdit').hooks.push({ type: 'command', command: 'node my-upgrade-survivor.js' });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    const gitignoreBefore = readFile(dir, '.gitignore');

    runUpgrader(dir); // no flags — the default EXECUTES; that is the whole point of the one-command path

    assert.ok(fileExists(dir, '.claude/skills/build/SKILL.md'), 'the upgrade must re-lay the pack skills');
    assert.ok(fileExists(dir, '.claude/hooks/lockdown.js'), 'the upgrade must re-lay the pack hooks');
    const claude = readFile(dir, 'CLAUDE.md');
    assert.ok(claude.includes('an upgrade must not eat this'), 'founder text outside the markers must survive the upgrade');
    assert.match(claude, /^<!-- RESPAWNPACK:BEHAVIOR v/m, 'the managed marker block must still be present (kept through phase 1; phase 2 sees it recorded at the current pack version and skips it — a version-stale block would be refreshed in place instead)');
    const cfgAfter = JSON.parse(readFile(dir, 'respawnpack.config.json'));
    assert.deepEqual(cfgAfter.extras, ['adopted:mcp-graphify'], 'a founder-added config field must survive — the config is protected in both phases');
    const after = JSON.parse(readFile(dir, '.claude/settings.json'));
    const cmds = Object.values(after.hooks).flat().flatMap((g) => g.hooks).map((h) => h.command);
    assert.equal(cmds.filter((c) => c === 'node my-upgrade-survivor.js').length, 1, 'the user hook must survive exactly once — kept by phase 1, not duplicated by phase 2\'s merge');
    assert.equal(readFile(dir, '.gitignore'), gitignoreBefore, '.gitignore must come through the upgrade byte-identical');
  });
});

test('upgrade.js --dry-run names both phases and changes nothing', async (t) => {
  await withTempDir(t, 'rpu-upgrade-dry-', (dir) => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    runInstaller(dir);
    const before = snapshotFiles(dir);

    const output = runUpgrader(dir, ['--dry-run']);

    assert.match(output, /UPGRADE DRY RUN/, 'the banner must announce the dry run');
    assert.match(output, /phase 1\/2/, 'the preview must name phase 1 (the upgrade-scope uninstall)');
    assert.match(output, /phase 2\/2/, 'the preview must name phase 2 (the fresh install)');
    // Flag-forwarding proof: the two lines above are PARENT text and would still print if the child
    // flags were mangled into a real run. Only the children's own dry-run banners prove the withheld
    // --force and the forwarded --dry-run actually reached them — a forwarding regression fails here,
    // not just (eventually) the byte-identical snapshot below.
    assert.match(output, /UPGRADE-SCOPE UNINSTALL DRY RUN/, 'phase 1 must run as the uninstaller\'s own dry run — its banner is the proof --force was really withheld');
    assert.match(output, /nothing was written; re-run without --dry-run to actually install/, 'phase 2 must run as install.js --dry-run — its closing dry-run line is the proof the flag was forwarded');
    assert.match(output, /the real run re-creates them/, 'the parent must explain the misleading phase-2 skip counts (the preview runs against the un-stripped target)');
    assert.deepEqual(snapshotFiles(dir), before, 'a dry run must leave every file byte-identical — neither phase may write');
  });
});

test('upgrade.js forwards --migrate-removals-scope to phase 2, in dry-run and real modes', async (t) => {
  await withTempDir(t, 'rpu-upgrade-migrate-', (dir) => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    runInstaller(dir);
    const cfgPath = path.join(dir, 'respawnpack.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.state.removals = {
      registry: 'docs/derived/state/removals.json',
      liveContentDirs: ['docs'],
      extensions: ['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'],
      historyPaths: ['docs/DECISIONS.md', 'docs/derived/CHANGELOG.md'],
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

    const before = snapshotFiles(dir);
    const preview = runUpgrader(dir, ['--dry-run', '--migrate-removals-scope']);
    assert.match(preview, /install\.js --dry-run --migrate-removals-scope/, 'the parent did not declare the forwarded flags');
    assert.match(preview, /would be WIDENED/, 'the phase-2 child did not receive migration authorization');
    assert.deepEqual(snapshotFiles(dir), before, 'upgrade migration dry run wrote files');

    runUpgrader(dir, ['--migrate-removals-scope']);
    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(after.state.removals.liveContentDirs, ['.'], 'the real upgrader dropped migration authorization before phase 2');
  });
});

test('upgrade.js rejects an unknown flag (--forc) and changes nothing', async (t) => {
  await withTempDir(t, 'rpu-upgrade-typo-', (dir) => {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    runInstaller(dir);
    const before = snapshotFiles(dir);

    const typo = runUpgraderRaw(dir, ['--forc']);

    assert.equal(typo.status, 1, 'an unknown flag must hard-fail — phase 1 removes files, so a typo cannot fall through as a target dir');
    assert.match(typo.stderr, /Unknown flag\(s\): --forc/);
    assert.match(typo.stderr, /supported: --dry-run --migrate-removals-scope(?:\s|$)/,
      'the error must name the complete supported flag surface');
    assert.deepEqual(snapshotFiles(dir), before, 'a rejected flag must leave the target byte-identical');
  });
});

test('upgrade.js refuses to run against the pack itself', () => {
  // On win32 (case-insensitive FS) probe with a case-FLIPPED spelling of the pack root: the refusal
  // canonicalizes via realpath + case-fold, so the flipped string must still read as self — a raw
  // string compare would wave it through and run the upgrade against the pack repo. On case-sensitive
  // platforms the flipped spelling would be a different (nonexistent) path, so probe as-is there.
  const packRoot = path.resolve(__dirname, '..');
  const probe = process.platform === 'win32' ? packRoot.toUpperCase() : packRoot;
  const self = runUpgraderRaw(probe); // no flags: the refusal must beat the executing default
  assert.equal(self.status, 1, 'upgrading the pack against itself must be refused before anything runs');
  assert.match(self.stderr, /Refusing to upgrade RespawnPack against itself/);
});

// --- (k5) preflight: a torn pack checkout must abort BEFORE phase 1 strips the target -------------------
// The copy list is the test's own minimal enumeration of what preflight + install actually read (no
// .git/research/node_modules; PDFs under library/compliance/references/ are skipped — install.js reads
// only SOURCES.md there). Tearing ONE preflighted tree out of the copy and pointing the copy's own
// upgrade.js at a healthy target must exit 1 naming that tree, with the target byte-identical.
const PACK_COPY_LIST = [
  'VERSION', 'ATTRIBUTION.md',
  // install/_sources.js is load-bearing here, not decoration: the copy's own upgrade.js requires it
  // at the top of the file (`require('./_sources.js')`), before the preflight body even runs — omit
  // it and every test below breaks on MODULE_NOT_FOUND instead of exercising the preflight at all.
  'install/install.js', 'install/uninstall.js', 'install/upgrade.js', 'install/_sources.js',
  // ⛔ kernel/ and core/ belong here for the same reason they belong in upgrade.js's preflight: a copy
  // without them is not a healthy pack, so a test that tears ONE tree out of it would be tearing three.
  'kernel', 'core',
  // Host adapters install.js places (§3b) and _sources.js preflights — the sweep below tears each
  // SOURCE_TREES entry, so every one must be present in this healthy copy or the tear self-fails.
  // P5-CT-4 added sdk-supervisor and statusline beside interactive; all three are named here for the
  // same reason.
  'adapters/claude-code/interactive', 'adapters/claude-code/sdk-supervisor', 'adapters/claude-code/statusline',
  'spine', 'skills', 'hooks', 'workflows', 'catalog', 'templates', 'agents',
  'memory/README.md', 'memory/knowledge-graph.md', 'memory/learnings.template.md', 'memory/knowledge',
  'ops/mcp', 'ops/deploy-verify', 'ops/db-ops', 'ops/secrets-audit', 'ops/infra-status',
  'library/README.md', 'library/compliance/README.md', 'library/compliance/requirements',
  'library/compliance/references/SOURCES.md',
];
function copyPackSubset(destRoot) {
  const srcRoot = path.resolve(__dirname, '..');
  for (const rel of PACK_COPY_LIST) {
    const from = path.join(srcRoot, rel);
    if (!fs.existsSync(from)) continue; // e.g. agents/ is optional to install.js — the copy stays no stricter than it
    const to = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
}

test('upgrade.js preflight: a pack copy missing ops/deploy-verify aborts with exit 1 and the target byte-identical', async (t) => {
  await withTempDir(t, 'rpu-upgrade-preflight-pack-', async (packCopy) => {
    await withTempDir(t, 'rpu-upgrade-preflight-target-', (target) => {
      copyPackSubset(packCopy);
      fs.rmSync(path.join(packCopy, 'ops', 'deploy-verify'), { recursive: true, force: true }); // the torn tree — one of the newly-preflighted ones

      runInstaller(target); // a real, healthy install the torn checkout must NOT be allowed to strip
      const before = snapshotFiles(target);

      const r = spawnSync(process.execPath, [path.join(packCopy, 'install', 'upgrade.js'), target], { encoding: 'utf8' });
      if (r.error) throw r.error;

      assert.equal(r.status, 1, 'a torn pack source must abort the upgrade');
      assert.match(r.stderr, /Preflight failed/, 'the abort must present as a preflight failure, not a mid-install crash');
      assert.match(r.stderr, /ops\/deploy-verify\/ is missing or unreadable/, 'the failure must name the exact missing tree');
      assert.match(r.stderr, /NOTHING was removed/, 'the message must state the target was not touched');
      assert.deepEqual(snapshotFiles(target), before, 'the target must be byte-identical — preflight runs before phase 1 removes anything');
    });
  });
});

/*
 * ⛔ THE PREFLIGHT PROMISED "EVERY SOURCE TREE" AND OMITTED `kernel/` AND `core/`, WHICH ARE THE TWO
 * PHASE 1 DELETES AND NOTHING ELSE CAN REPLACE. Reproduced on a disposable target before the fix, from
 * a pack source torn the way a shallow clone or a bad merge tears one: with the whole `core/` tree
 * missing the preflight PASSED, phase 1 stripped the target, phase 2 died on ENOENT, and the target
 * went from 13 core files to 0. With one file missing from `kernel/lib/` the same run took it from 12
 * kernel libs and 13 core files to 3 and 0, and its kernel stopped running at all.
 *
 * ⛔ SO THIS TEST IS DERIVED FROM THE LIST, NOT WRITTEN AGAINST IT. It reads `SOURCE_TREES` out of
 * install/_sources.js — the ONE shared declaration upgrade.js's preflight and install.js's own
 * preflight both require (P-002, docs/derived/state/pairs.json) — and tears EVERY entry in turn.
 * That closes the loop in both directions: a tree added to the shared list is covered the day it is
 * added, and a phantom entry naming a tree the pack does not ship fails here immediately instead of
 * silently making the gate unfalsifiable. The single-tree test above stays as the readable worked
 * example; this is the sweep behind it.
 *
 * ⛔ WHAT IT STILL DOES NOT PROVE, stated rather than left to be discovered: that `SOURCE_TREES` is
 * COMPLETE against everything install.js reads — a tree install.js starts reading unguarded and
 * nobody adds to install/_sources.js is still invisible to this sweep; nothing here (or anywhere)
 * derives the list from install.js's own source. What moving both preflights onto one shared module
 * DOES close is the narrower defect that actually shipped: two hand-written lists silently
 * disagreeing with EACH OTHER, which is how kernel/ and core/ went missing in the first place. The
 * test immediately below proves there is only one list left to disagree.
 */
test('upgrade.js preflight: EVERY preflighted source tree, torn in turn, aborts before the target is touched', async (t) => {
  const sourcesSrc = fs.readFileSync(path.resolve(__dirname, '_sources.js'), 'utf8');
  const block = sourcesSrc.match(/SOURCE_TREES:\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'SOURCE_TREES could not be read out of install/_sources.js — this sweep would silently cover nothing');
  const trees = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(trees.length >= 20, `only ${trees.length} preflighted tree(s) parsed; the regex has drifted from the source`);
  for (const required of ['kernel', 'kernel/lib', 'core', 'core/lifecycle']) {
    assert.ok(trees.includes(required), `${required} is not preflighted — phase 1 deletes it and phase 2 cannot put it back`);
  }

  await withTempDir(t, 'rpu-preflight-sweep-pack-', async (packCopy) => {
    await withTempDir(t, 'rpu-preflight-sweep-target-', (target) => {
      copyPackSubset(packCopy);
      // ONE install, reused by every iteration: a preflight that aborts correctly never touches the
      // target, so if any iteration does touch it the snapshot below catches exactly that.
      runInstaller(target);
      const before = snapshotFiles(target);

      for (const tree of trees) {
        const treeAbs = path.join(packCopy, tree);
        const stash = `${treeAbs}.stashed`;
        if (!fs.existsSync(treeAbs)) {
          assert.fail(`upgrade.js preflights ${tree}/, which this pack does not ship — a gate on a tree that cannot exist can never fail honestly`);
        }
        fs.renameSync(treeAbs, stash);
        try {
          const r = spawnSync(process.execPath, [path.join(packCopy, 'install', 'upgrade.js'), target], { encoding: 'utf8' });
          if (r.error) throw r.error;
          assert.equal(r.status, 1, `a pack source missing ${tree}/ did not abort the upgrade`);
          assert.match(r.stderr, /Preflight failed/, `missing ${tree}/ must abort at preflight, not mid-install`);
          assert.ok(r.stderr.includes(`${tree}/ is missing or unreadable`) || r.stderr.includes(`${tree}/ is empty`),
            `the abort must name ${tree}/ specifically; got: ${r.stderr.slice(0, 300)}`);
          assert.deepEqual(snapshotFiles(target), before, `the target was modified while ${tree}/ was missing — phase 1 ran before the gate`);
        } finally { fs.renameSync(stash, treeAbs); }
      }
    });
  });
});

/*
 * ⛔ P-002 — ONE LIST, NOT TWO THAT HAPPEN TO AGREE TODAY (docs/derived/state/pairs.json).
 *
 * upgrade.js's preflight list used to be typed out a second time, independent of what install.js
 * actually reads — free of PHANTOMS (the sweep above proves that), but never proven COMPLETE against
 * install.js's own reads, and it went stale exactly that way: `kernel/` and `core/` were both missing
 * from it for as long as it existed. install/_sources.js is the fix: ONE declaration, required by
 * both upgrade.js's preflight and install.js's own preflight, so a tree is added to the list once,
 * for both consumers, and there is no second copy left to drift out of step with the first.
 *
 * This does not prove the shared list is complete against install.js's reads — nothing statically
 * derives that (see the sweep test above, which says so). It proves the narrower defect that
 * actually shipped cannot recur: upgrade.js and install.js cannot silently disagree with each other
 * about the list, because the source of truth for "what does install.js read unguarded" exists in
 * exactly one place now, not two that happened to still agree.
 */
test('upgrade.js and install.js source their preflight list from install/_sources.js — neither declares SOURCE_TREES/SOURCE_FILES of its own', () => {
  const sourcesPath = path.resolve(__dirname, '_sources.js');
  assert.ok(fs.existsSync(sourcesPath), 'install/_sources.js is missing — both requires below would fail at runtime');

  const upgradeSrc = fs.readFileSync(path.resolve(__dirname, 'upgrade.js'), 'utf8');
  const installSrc = fs.readFileSync(path.resolve(__dirname, 'install.js'), 'utf8');

  for (const [label, src] of [['upgrade.js', upgradeSrc], ['install.js', installSrc]]) {
    assert.doesNotMatch(src, /(?:const\s+)?SOURCE_TREES\s*[:=]\s*\[/,
      `${label} declares its own SOURCE_TREES literal — the preflight list must come from install/_sources.js, the one shared source, or the two can silently drift apart again exactly as P-002 describes`);
    assert.doesNotMatch(src, /(?:const\s+)?SOURCE_FILES\s*[:=]\s*\[/,
      `${label} declares its own SOURCE_FILES literal — same defect, the other half of the shared list`);
    assert.match(src, /require\(['"]\.\/_sources(?:\.js)?['"]\)/,
      `${label} does not require ./_sources.js — it must read the preflight list from the shared module, not a copy of it`);
  }
});

/*
 * ⛔ THE TREE GATE LEFT THE SAME DESTRUCTION OPEN ONE GRANULARITY DOWN, AND THAT WAS MEASURED, NOT GUESSED.
 *
 * Adding `kernel/` and `core/` to the preflight closed the missing-TREE case. It did not close the
 * missing-FILE case: with `kernel/lib/` present but one file inside it gone, the preflight still passed,
 * phase 1 stripped the target and phase 2 died on ENOENT. Reproduced against the fixed tree gate — 12
 * kernel libs and 13 core files became 3 and 0, the identical outcome as before the tree fix. "Per-file
 * completeness stays install.js's own concern" is a defensible boundary for a tree whose loss is
 * recoverable; it is not one for the two trees the target cannot function without.
 *
 * The loop is DERIVED from install/_sources.js, so a file added to the kernel or the core is covered the
 * day it is added — the same property that makes the tree sweep above self-maintaining.
 */
test('upgrade.js preflight: EVERY kernel and core file, torn in turn, aborts before the target is touched', async (t) => {
  const sources = createRequire(import.meta.url)(path.resolve(__dirname, '_sources.js'));
  const files = [...sources.KERNEL_FILES, ...sources.CORE_FILES];
  assert.ok(files.length >= 24, `only ${files.length} kernel/core file(s) declared — the derivation has drifted from the source`);

  await withTempDir(t, 'rpu-preflight-files-pack-', async (packCopy) => {
    await withTempDir(t, 'rpu-preflight-files-target-', (target) => {
      copyPackSubset(packCopy);
      runInstaller(target);
      const before = snapshotFiles(target);

      for (const rel of files) {
        const abs = path.join(packCopy, rel);
        const stash = `${abs}.stashed`;
        assert.ok(fs.existsSync(abs), `_sources.js declares ${rel}, which the pack does not ship — a gate on a file that cannot exist never fails honestly`);
        fs.renameSync(abs, stash);
        try {
          const r = spawnSync(process.execPath, [path.join(packCopy, 'install', 'upgrade.js'), target], { encoding: 'utf8' });
          if (r.error) throw r.error;
          assert.equal(r.status, 1, `a pack source missing ${rel} did not abort the upgrade`);
          assert.match(r.stderr, /Preflight failed/, `missing ${rel} must abort at preflight, not mid-install`);
          assert.ok(r.stderr.includes(`${rel} is missing or unreadable`),
            `the abort must name ${rel} specifically; got: ${r.stderr.slice(0, 300)}`);
          assert.deepEqual(snapshotFiles(target), before, `the target was modified while ${rel} was missing — phase 1 ran before the gate`);
        } finally { fs.renameSync(stash, abs); }
      }
    });
  });
});

// --- (k6) extra positionals: the unquoted-spaced-path trap must hard-fail, not mis-target ---------------
test('upgrade.js rejects a second positional argument and changes nothing', async (t) => {
  await withTempDir(t, 'rpu-upgrade-positional-', (dir) => {
    runInstaller(dir);
    const before = snapshotFiles(dir);

    const r = runUpgraderRaw(dir, ['extra-positional']);

    assert.equal(r.status, 1, 'two positionals must hard-fail — "upgrade.js C:\\My Projects\\app" would otherwise silently target C:\\My');
    assert.match(r.stderr, /Too many positional arguments/, 'the error must say what went wrong');
    assert.ok(r.stderr.includes(`"${dir}"`) && r.stderr.includes('"extra-positional"'), 'the error must name BOTH values so the founder sees exactly what the shell split');
    assert.match(r.stderr, /quote/i, 'the error must hint that spaced paths need quoting');
    assert.deepEqual(snapshotFiles(dir), before, 'the refusal must leave the target byte-identical');
  });
});

/*
 * Unit 7 · an upgrade must not silently destroy a founder's living overlay.
 *
 * ⛔ THE DEFECT. `.claude/skills/debug/SKILL.md` is in the uninstaller's SKILLS inventory, so
 * `--for-upgrade` unlinked it and install.js re-laid the pack's copy. `.skill-meta.json` and
 * `SKILL.base.md` both survived, and because `living enable` freezes whatever is on disk, the pack's
 * SKILL.md usually EQUALS the frozen base — so every check `living status` runs came back true and it
 * reported `PASS · living, base intact, overlay 0/12 line(s)`. Nothing lied. The overlay was simply
 * gone, and the post-upgrade state was indistinguishable from "nothing was ever learned here".
 *
 * Not covered by any test before this one: `grep upgrade` across the suites returned nothing that
 * touched living skills at all. The fix is not to skip the removal — a founder who upgrades wants the
 * new pack skill — it is that the destruction leaves a record the next reader trips over.
 */
test('upgrade: a living overlay is archived and REPORTED, never silently replaced', async (t) => {
  await withTempDir(t, 'rp-upgrade-living-', (dir) => {
    runInstaller(dir);

    // Enable the lifecycle on a canary and put a real learned line into the overlay, through the
    // product's own path — not by hand-writing the file this test then reads back.
    const rp = (...a) => spawnSync(process.execPath, [path.join(dir, '.claude', 'respawnpack', 'respawnpack.js'), ...a, '--dir', dir], { encoding: 'utf8' });
    assert.equal(rp('living', 'enable', 'debug').status, 0, 'enable must succeed for the rest of this fixture to mean anything');

    const graph = path.join(dir, 'memory', 'graph');
    fs.mkdirSync(graph, { recursive: true });
    fs.writeFileSync(path.join(graph, 'upgrade-probe.md'),
      '---\nrelations:\n  - applies-to|skill:debug\nconfidence: 0.9\n---\n\nUPGRADE PROBE LESSON: the index lease is per index identity, not per file path.\n');
    assert.equal(rp('living', 'regenerate', 'debug', '--write').status, 0);

    const skillMd = () => fs.readFileSync(path.join(dir, '.claude', 'skills', 'debug', 'SKILL.md'), 'utf8');
    assert.match(skillMd(), /UPGRADE PROBE LESSON/, 'the overlay must actually be on disk before the upgrade');
    const beforeStatus = rp('living', 'status', 'debug');
    assert.equal(beforeStatus.status, 0, 'a freshly regenerated living skill is PASS');

    // The upgrade, exactly as a founder runs it.
    const up = spawnSync(process.execPath, [UPGRADE_JS, dir], { encoding: 'utf8' });
    assert.equal(up.status, 0, `upgrade must succeed: ${up.stdout}${up.stderr}`);

    // The pack's skill is back — that half was never in question and stays true.
    assert.doesNotMatch(skillMd(), /UPGRADE PROBE LESSON/, 'the pack copy replaces the living form; this fixture is about what is SAID, not about preventing that');

    // ⭐ The two halves that were false. The lines still exist somewhere…
    const archive = path.join(dir, '.claude', 'skills', 'debug', 'SKILL.superseded.md');
    assert.ok(fs.existsSync(archive), 'the pre-upgrade living form must be archived, not unlinked');
    assert.match(fs.readFileSync(archive, 'utf8'), /UPGRADE PROBE LESSON/, 'and the archive must be the real one, not a stub');

    // …and the next reader is TOLD, instead of being handed a clean bill of health.
    const after = rp('living', 'status', 'debug');
    assert.notEqual(after.status, 0, 'status must not be PASS over an overlay that was destroyed minutes ago');
    assert.match(after.stdout + after.stderr, /SKILL\.superseded\.md/, 'and it must name where the lines went');
    assert.notEqual(after.stdout, beforeStatus.stdout, 'the before and after reports must be distinguishable at all');

    /*
     * ⛔ A SECOND UPGRADE MUST NOT EAT THE FIRST ONE'S ARCHIVE. The first version of this fixture ran
     * `upgrade` exactly ONCE, so it could not see that the second pass archived the PACK's own copy
     * over the founder's lines — while refreshing the stamp, leaving `living status` naming an archive
     * that no longer held anything of theirs. A report that points at the wrong place is worse than no
     * report: it ends the search. Found by the fourth adversarial gate, not by this test.
     */
    const up2 = spawnSync(process.execPath, [UPGRADE_JS, dir], { encoding: 'utf8' });
    assert.equal(up2.status, 0, `the second upgrade must also succeed: ${up2.stdout}${up2.stderr}`);
    assert.match(fs.readFileSync(archive, 'utf8'), /UPGRADE PROBE LESSON/,
      "the second upgrade overwrote the founder's archived text with the pack's own copy");
    const after2 = rp('living', 'status', 'debug');
    assert.notEqual(after2.status, 0, 'still not PASS while the overlay is superseded');
    assert.match(after2.stdout + after2.stderr, /SKILL\.superseded\.md/, 'and it must still name the archive');

    // Acting on the report clears it — the stamp is a message, not a permanent scar. The ARCHIVE stays.
    assert.equal(rp('living', 'regenerate', 'debug', '--write').status, 0);
    assert.equal(rp('living', 'status', 'debug').status, 0, 'a re-derived overlay is clean again');
    // ⛔ Asserts on the TEXT, not on existence: the previous version checked existsSync where the
    // sentence said "the founder's archived text", and a stub file would have satisfied it.
    assert.match(fs.readFileSync(archive, 'utf8'), /UPGRADE PROBE LESSON/,
      "clearing the stamp must not disturb the founder's archived text");

    /*
     * ⛔ AND THE THIRD UPGRADE, AFTER A REGENERATE — the ordinary lifecycle, and the one the previous
     * fix reinstated the original P0 inside. That fix answered "do not clobber the archive" with a
     * `continue`, which skipped the archive-and-stamp block while `for (const rel of REMOVE)` forty
     * lines below still deleted SKILL.md. So: overlay destroyed, nothing archived, nothing stamped, and
     * `living status` back to PASS. A fifth gate walked it in three commands.
     *
     * The invariant this asserts is the one the code now states: EVERY upgrade that removes a living
     * form archives it and stamps it — never overwriting, never skipping. If the name is taken, the
     * next one is used.
     */
    fs.writeFileSync(path.join(graph, 'second-round.md'),
      '---\nrelations:\n  - applies-to|skill:debug\nconfidence: 0.95\n---\n\nSECOND ROUND LESSON: an archive that is skipped is not an archive that is kept.\n');
    assert.equal(rp('living', 'regenerate', 'debug', '--write').status, 0);
    assert.match(skillMd(), /SECOND ROUND LESSON/, 'the second-round overlay must be on disk before upgrade #3');

    const up3 = spawnSync(process.execPath, [UPGRADE_JS, dir], { encoding: 'utf8' });
    assert.equal(up3.status, 0, `the third upgrade must succeed: ${up3.stdout}${up3.stderr}`);
    const archives = fs.readdirSync(path.join(dir, '.claude', 'skills', 'debug'))
      .filter((f) => /^SKILL\.superseded(\.\d+)?\.md$/.test(f))
      .map((f) => fs.readFileSync(path.join(dir, '.claude', 'skills', 'debug', f), 'utf8'));
    assert.ok(archives.some((t) => /SECOND ROUND LESSON/.test(t)),
      'the second-round overlay was destroyed by upgrade #3 and archived nowhere');
    assert.ok(archives.some((t) => /UPGRADE PROBE LESSON/.test(t)),
      'and the FIRST archive must still be intact — never overwritten, only added to');
    const after3 = rp('living', 'status', 'debug');
    assert.notEqual(after3.status, 0, 'status must not be PASS over an overlay upgrade #3 destroyed');
  });
});

/*
 * ⛔ THREE BEHAVIOURS THAT WORKED AND WERE FENCED BY NOTHING. A sixth gate mutation-tested the round
 * that shipped them: deleting `keepLiving`, deleting the notes printing, and deleting the
 * unparseable-meta note text each broke NO test. A guarantee nothing fences is a guarantee already
 * drifting — these assert the user-visible TEXT and the surviving file, so the mutation has to fail.
 */
test('upgrade: an unparseable .skill-meta.json leaves the living form in place, and SAYS so', async (t) => {
  await withTempDir(t, 'rp-keepliving-', (dir) => {
    runInstaller(dir);
    const skillMd = path.join(dir, '.claude', 'skills', 'debug', 'SKILL.md');
    const meta = path.join(dir, '.claude', 'skills', 'debug', '.skill-meta.json');
    fs.writeFileSync(skillMd, `${fs.readFileSync(skillMd, 'utf8')}\n<!-- FOUNDER MARKER -->\n`);
    fs.writeFileSync(meta, '{ this is not json');

    const out = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--for-upgrade', '--force'], { encoding: 'utf8' });
    assert.equal(out.status, 0, `upgrade-scope uninstall must succeed: ${out.stdout}${out.stderr}`);

    // (a) The file survives — this is what `keepLiving` buys, and the mutation that removes it lands here.
    assert.ok(fs.existsSync(skillMd), 'an unparseable meta must not cost the founder their living form');
    assert.match(fs.readFileSync(skillMd, 'utf8'), /FOUNDER MARKER/, 'and it must be THEIR file, not a re-laid copy');

    // (b) …and the founder is told, in words, on stdout. The note was assembled and never printed for a
    // whole round: a record nobody prints is a record nobody has.
    const said = out.stdout + out.stderr;
    assert.match(said, /skill-meta\.json does not parse/, 'the reason must be stated');
    assert.match(said, /LEFT IN PLACE/, 'and the consequence named, so the state is not a surprise later');
  });
});

test('upgrade: the archive note reaches the founder, not just the notes array', async (t) => {
  await withTempDir(t, 'rp-notes-', (dir) => {
    runInstaller(dir);
    const rp = (...a) => spawnSync(process.execPath, [path.join(dir, '.claude', 'respawnpack', 'respawnpack.js'), ...a, '--dir', dir], { encoding: 'utf8' });
    assert.equal(rp('living', 'enable', 'debug').status, 0);
    const graph = path.join(dir, 'memory', 'graph');
    fs.mkdirSync(graph, { recursive: true });
    fs.writeFileSync(path.join(graph, 'note-probe.md'),
      '---\nrelations:\n  - applies-to|skill:debug\nconfidence: 0.9\n---\n\nNOTE PROBE LESSON: a record nobody prints is a record nobody has.\n');
    assert.equal(rp('living', 'regenerate', 'debug', '--write').status, 0);

    const out = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--for-upgrade', '--force'], { encoding: 'utf8' });
    assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
    const said = out.stdout + out.stderr;
    assert.match(said, /SKILL\.superseded/, 'the archive must be named on stdout, where a founder reads it');
    assert.match(said, /living status/, 'and the way to see it again must be named too');
  });
});

test('a full uninstall PRESERVES the living-lifecycle artifacts and NAMES them', async (t) => {
  await withTempDir(t, 'rp-leftovers-', (dir) => {
    /*
     * ⛔ THE PREVIOUS VERSION OF THIS TEST COULD NOT FAIL FOR THE REASON IT EXISTED. It read
     *     const left = fs.readdirSync(skillDir); if (left.length) { assert.match(said, …); }
     * so an uninstaller that DELETED every lifecycle artifact — the exact regression it was meant to
     * catch — produced an empty directory, skipped the assertion, and passed. A conditional guard
     * around the only assertion is the DF-007 shape wearing a different hat: the check ran, found
     * nothing, and read as confirmation.
     *
     * These are POSITIVE assertions. `SKILL.base.md` is the founder's frozen skill, `.skill-meta.json`
     * is the record of their opt-in, and an archive holds text the pack replaced — keeping all three is
     * right, and saying nothing about them was the defect. Both halves are now required.
     */
    runInstaller(dir);
    enableLiving(dir);
    const d = path.join(dir, '.claude', 'skills', 'debug');
    fs.writeFileSync(path.join(d, 'SKILL.superseded.md'), 'FOUNDER ARCHIVED TEXT\n');

    const out = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--force'], { encoding: 'utf8' });
    assert.equal(out.status, 0, `${out.stdout}${out.stderr}`);
    const said = out.stdout + out.stderr;

    // (a) PRESERVATION — each named individually, so a partial regression cannot hide behind the others.
    assert.ok(fs.existsSync(path.join(d, 'SKILL.base.md')), 'SKILL.base.md is the founder\'s frozen skill and must survive a full uninstall');
    assert.ok(fs.existsSync(path.join(d, '.skill-meta.json')), '.skill-meta.json records their opt-in and must survive');
    assert.equal(fs.readFileSync(path.join(d, 'SKILL.superseded.md'), 'utf8'), 'FOUNDER ARCHIVED TEXT\n',
      'an archive holds text the pack replaced — it must survive byte-identical');

    // (b) REPORTING — the founder is told what stayed, by name. Silence about what is left behind is
    //     the same failure as silence about what was destroyed.
    // ⛔ PATH-QUALIFIED, AFTER A MUTATION WALKED THROUGH THE BARE FORM. `/SKILL\.base\.md/` matched a
    // DIFFERENT line — the `mcp-*` skills ship their own base files and appear in the removal listing —
    // so the assertion passed with the reporting scan mutated away. The regex now names the directory
    // under test, which is the only thing this fixture is about.
    assert.match(said, /skills.debug.SKILL\.base\.md/, 'the summary must name debug/SKILL.base.md among what remains');
    assert.match(said, /skills.debug..skill-meta\.json/, 'and debug/.skill-meta.json');
    assert.match(said, /skills.debug.SKILL\.superseded\.md/, 'and debug/SKILL.superseded.md');
  });
});

/*
 * ⛔ A PREVIEW THAT DISAGREES WITH THE RUN IS WORSE THAN NO PREVIEW — and this pair reproduced exactly
 * that on a real installed target before `planLivingArchive()` existed:
 *     five slots occupied · dry run   → "living form WOULD be archived beside its base"
 *     five slots occupied · execution → "5 superseded archives already exist — LEFT IN PLACE"
 * The bound lived inside `if (!DRY_RUN)`, so the preview never evaluated the decision it was previewing.
 * These fixtures pin BOTH boundaries: the last slot that works, and the first that does not.
 */
const occupyArchives = (dir, howMany) => {
  const d = path.join(dir, '.claude', 'skills', 'debug');
  const names = ['SKILL.superseded.md', 'SKILL.superseded.2.md', 'SKILL.superseded.3.md',
    'SKILL.superseded.4.md', 'SKILL.superseded.5.md'];
  for (let i = 0; i < howMany; i += 1) fs.writeFileSync(path.join(d, names[i]), `occupied slot ${i + 1}\n`);
  return d;
};
const enableLiving = (dir) => {
  const r = spawnSync(process.execPath,
    [path.join(dir, '.claude', 'respawnpack', 'respawnpack.js'), 'living', 'enable', 'debug', '--dir', dir],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, `living enable must succeed: ${r.stdout}${r.stderr}`);
};

test('archive plan: FOUR slots occupied — the preview names .5 and the run creates exactly that file', async (t) => {
  await withTempDir(t, 'rp-arch4-', (dir) => {
    runInstaller(dir);
    enableLiving(dir);
    const d = occupyArchives(dir, 4);
    const skillMd = path.join(d, 'SKILL.md');
    fs.writeFileSync(skillMd, `${fs.readFileSync(skillMd, 'utf8')}\nFOUNDER BYTES AT SLOT FOUR\n`);
    const founder = fs.readFileSync(skillMd, 'utf8');

    const preview = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--for-upgrade'], { encoding: 'utf8' });
    assert.equal(preview.status, 0, `${preview.stdout}${preview.stderr}`);
    const said = preview.stdout + preview.stderr;
    // The preview must NAME the file, not gesture at one — that vagueness is what hid the mismatch.
    assert.match(said, /WOULD be archived as SKILL\.superseded\.5\.md/,
      'the dry run must name the exact archive the run will create');
    assert.ok(!fs.existsSync(path.join(d, 'SKILL.superseded.5.md')), 'a dry run must write nothing');

    const run = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--for-upgrade', '--force'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout + run.stderr, /archived as SKILL\.superseded\.5\.md/,
      'the run must name the same file the preview named');
    const archive = path.join(d, 'SKILL.superseded.5.md');
    assert.ok(fs.existsSync(archive), 'the named archive must exist after the run');
    assert.equal(fs.readFileSync(archive, 'utf8'), founder,
      "and hold the founder's bytes exactly — not a re-laid copy, not a stub");
  });
});

test('archive plan: FIVE slots occupied — preview and run agree, and nothing is destroyed', async (t) => {
  await withTempDir(t, 'rp-arch5-', (dir) => {
    runInstaller(dir);
    enableLiving(dir);
    const d = occupyArchives(dir, 5);
    const skillMd = path.join(d, 'SKILL.md');
    fs.writeFileSync(skillMd, `${fs.readFileSync(skillMd, 'utf8')}\nFOUNDER BYTES AT THE BOUND\n`);
    const before = fs.readFileSync(skillMd, 'utf8');

    const preview = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--for-upgrade'], { encoding: 'utf8' });
    const run = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--for-upgrade', '--force'], { encoding: 'utf8' });
    assert.equal(preview.status, 0); assert.equal(run.status, 0);
    for (const [label, out] of [['dry run', preview], ['execution', run]]) {
      const said = out.stdout + out.stderr;
      assert.match(said, /LEFT IN PLACE/, `${label} must say the living form is left in place at the bound`);
      assert.doesNotMatch(said, /WOULD be archived|archived as SKILL/,
        `${label} must not promise an archive it will not make`);
    }
    // ⭐ The discriminating half: the bound is only a real bound if nothing was destroyed or created.
    assert.equal(fs.readFileSync(skillMd, 'utf8'), before, 'SKILL.md must be byte-identical at the bound');
    assert.ok(!fs.existsSync(path.join(d, 'SKILL.superseded.6.md')), 'no sixth archive may appear');
  });
});

/*
 * ⛔ A PREVIEW MUST NOT CALL A PACK FILE THE FOUNDER'S. Unit 7 found the survivors report matching on
 * FILENAME alone and running AFTER the removal loop — so in a dry run, where nothing had been removed
 * yet, every pack-shipped `SKILL.base.md` under an `mcp-` skill was printed under "KEPT (yours, not the
 * pack's)". The same file appeared twice in one preview: in "would remove 144 pack file(s)" and as
 * founder property. This is closeout finding 1's shape reappearing inside the fix for closeout finding
 * 2, and the earlier fixture could not see it because it was path-qualified to `debug`.
 */
test('uninstall preview: a pack-shipped base is never reported as founder property', async (t) => {
  await withTempDir(t, 'rp-kept-pack-', (dir) => {
    runInstaller(dir);
    const packBase = path.join(dir, '.claude', 'skills', 'mcp-github', 'SKILL.base.md');
    assert.ok(fs.existsSync(packBase), 'the fixture needs a pack-shipped base to exist');
    fs.writeFileSync(packBase, `${fs.readFileSync(packBase, 'utf8')}\nMY OWN EDIT\n`);

    const preview = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--dry-run'], { encoding: 'utf8' });
    assert.equal(preview.status, 0, `${preview.stdout}${preview.stderr}`);
    const said = preview.stdout + preview.stderr;
    const keptSection = said.slice(said.indexOf('lifecycle artifacts KEPT'));
    assert.doesNotMatch(keptSection, /mcp-github.SKILL\.base\.md/,
      'a file the inventory is about to delete must never be listed as KEPT');
    // ⭐ Control: it must still appear ONCE, in the would-remove list — the fix is subtraction from the
    // KEPT report, not silence about the file.
    assert.equal((said.match(/mcp-github.SKILL\.base\.md/g) || []).length, 1,
      'the pack base belongs in exactly one list: the removal listing');

    // …and the preview agrees with the run: it is gone afterwards.
    const run = spawnSync(process.execPath, [UNINSTALL_JS, dir, '--force'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.ok(!fs.existsSync(packBase), 'the run removes what the preview said it would remove');
  });
});

test('doctor describes a missing _manifest.js instead of dying before it can emit a row', async (t) => {
  await withTempDir(t, 'rp-nomanifest-', (dir) => {
    /*
     * ⛔ A SOFT REQUIRE IN ONE FILE IS NOT A SOFT REQUIRE. `respawnpack.js` guarded its own require of
     * this module and the guard was UNREACHABLE: `lib/state.js` and `lib/removals.js` are loaded first
     * and hard-required the same file, so `doctor` died with a raw MODULE_NOT_FOUND stack and zero rows
     * while three shipped surfaces recorded the case as handled. Every module on the path has to agree.
     */
    runInstaller(dir);
    fs.unlinkSync(path.join(dir, '.claude', 'hooks', '_manifest.js'));
    const r = spawnSync(process.execPath,
      [path.join(dir, '.claude', 'respawnpack', 'respawnpack.js'), 'doctor', '--dir', dir], { encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    /*
     * ⛔ THE ASSERTION HAS TO SEPARATE A CRASH FROM A DIAGNOSIS, AND ITS FIRST FORM DID NOT. It banned
     * the string "Cannot find module" anywhere in the output. That was a fair proxy for "doctor died"
     * only while dying was the sole way doctor could ever produce it. Once doctor started REPORTING why
     * a module will not load, the honest row `hook-lib:_runtime.js  THREW WHILE LOADING — Error: Cannot
     * find module './_manifest.js'` tripped the very check written to demand it. What must be absent is
     * the CRASH — an uncaught throw's stack frames and require stack, with no verdict at the end — not
     * the words a good diagnostic uses.
     */
    assert.doesNotMatch(out, /^\s+at .+\(node:internal/m, 'doctor died with a stack trace instead of emitting rows');
    assert.doesNotMatch(out, /Require stack:/, 'doctor died on an unhandled MODULE_NOT_FOUND');
    assert.match(out, /→ FAIL/, 'doctor reached no verdict — a report that stops before its conclusion is the same failure in a quieter form');
    assert.equal(r.status, 1, 'a target whose hooks cannot load must exit non-zero');
    assert.match(out, /hook-lib:_manifest\.js/, 'and it must NAME the missing module');
    assert.match(out, /MISSING/, 'as missing');
    // …and the module that fails only THROUGH it is reported too, for the reason it actually fails.
    assert.match(out, /hook-lib:_runtime\.js\s+THREW WHILE LOADING/, 'a library broken through another library must say so');
    // Control: rows were actually emitted, so this is a report rather than a silent exit.
    assert.match(out, /hook-lib:_cmd\.js/, 'the other library rows must still print');
  });
});

// --- P4-T-15b · the dispatcher registrations leave with the pack -------------------------------------
//
// ⛔ WHY THIS NEEDS ITS OWN FENCE. `hooks/dispatch.js` is registered by `light` and `standard` and by NO
// snippet — `hooks/settings.snippet.json` is the `strict` column, and `strict` keeps the multi-hook
// wiring (anti-drift item 35). The uninstaller's settings sweep builds its "ours" set from the snippet
// plus the receipt, so a dispatcher entry is removed by the RECEIPT alone. That is fine for a target this
// pack version installed and wrong for one whose receipt is absent, torn, or predates the ownership
// record: it would keep a live registration pointing at a file the uninstall just deleted, and every Bash
// tool call in that project would then fail its hook. `install/uninstall.js`'s DISPATCH_HOOK_ENTRIES is
// the hand-named list that closes that, and this is the fence that keeps it in step with what the
// composer can actually place.
test('P4-T-15b: every dispatcher registration any profile can compose is named in uninstall.js', () => {
  const manifest = createRequire(import.meta.url)(path.resolve(__dirname, '_settings-manifest.js'));
  const posturePolicy = createRequire(import.meta.url)(path.resolve(__dirname, '..', 'hooks', '_posture.js'));
  const snippet = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'hooks', 'settings.snippet.json'), 'utf8'));
  delete snippet['//'];

  const composable = new Set();
  for (const profile of posturePolicy.PROFILES) {
    const { settings } = manifest.compose(snippet, profile);
    for (const groups of Object.values(settings.hooks)) {
      for (const g of groups) for (const h of (g.hooks || [])) if (h.command.includes('dispatch.js')) composable.add(h.command);
    }
  }
  assert.ok(composable.size >= 2, `only ${composable.size} dispatcher registration(s) are composable across every profile — the derivation has drifted, so this fence would pass while proving nothing`);

  const uninstaller = fs.readFileSync(UNINSTALL_JS, 'utf8');
  for (const command of composable) {
    assert.ok(uninstaller.includes(command),
      `install/uninstall.js does not name the composable registration "${command}", so a target whose receipt is missing would keep a settings entry pointing at a hook file the uninstall removed`);
  }
});

test('P4-T-15b: a dispatching profile uninstalls clean — no hook file and no registration left behind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-uninst-dispatch-'));
  try {
    runInstaller(dir);
    // Declare a dispatching posture and re-install so the target actually holds the dispatcher wiring.
    const cfgPath = path.join(dir, 'respawnpack.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.posture = { profile: 'standard' };
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    runInstaller(dir);

    const before = fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8');
    assert.ok(before.includes('dispatch.js'), 'sanity: the target must hold the dispatcher wiring before the uninstall proves it leaves');
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'hooks', 'dispatch.js')), 'sanity: the hook file must be there too');

    runUninstaller(dir, ['--force']);

    assert.ok(!fs.existsSync(path.join(dir, '.claude', 'hooks', 'dispatch.js')),
      'the dispatcher file must be removed by the uninstall — a hook directory left holding an orphaned entry point is exactly the drift install/_sources.js\'s inventory exists to prevent');
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    const after = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '';
    assert.ok(!after.includes('dispatch.js'),
      'a registration that survives the uninstall points at a file the uninstall deleted, and every Bash tool call in that project then fails its hook');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
