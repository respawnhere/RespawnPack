/*
 * RespawnPack · skills/respawn/boot-set.test.mjs — the /respawn boot-set budget fence (B1).
 *
 * ⛔ WHY THIS EXISTS. /respawn Step 0 to Step 2 put a fixed set of things in context before the human
 * speaks, and that set is a budget, not a dumping ground. The review of 2026-09-23 measured it at ~50 KB
 * (~12.6k tokens) on the worked example, almost all of it two reads B1 removes: the full `doctor --json`
 * (Step 2 now reads `doctor --onboarding`) and `docs/DECISIONS.md` whole (Step 1 now reads the killed
 * features out of STATE.json). This fence measures the boot set the kernel actually produces on
 * `examples/todo-app` and fails above 8,000 tokens (32,000 bytes, four bytes per token). It is a
 * tighten-only ceiling; the measured number is recorded beside it.
 *
 * ⛔ THE SET IS MEASURED PER NAMED ITEM, NOT AS ONE NUMBER. A fence that summed STATE.json alone would
 * pass a bloated DECISIONS.md read sitting right beside it, so every item Steps 0 to 2 name is a line in
 * the breakdown and the total is the sum of those lines — see assertUnderBudget's message.
 *
 * ⛔ INSTALL, NOT A SHORTCUT. The boot set includes the FULL `doctor --json` (the base's Step 2 read),
 * whose size is the installed hook/lib/skill inventory, so the fixture is the pack installed into a copy
 * of the example through the real installer, exactly as a booting session would find it. `state` then
 * `savepoint --write` render STATE.json, CONTINUITY and GAPS the way a closed-out session leaves them;
 * the SessionStart injection is produced by spawning `hooks/session-routing-nudge.js` (A7's bounded
 * reads) against that tree, the same hook a real boot runs. The kernel under test is this worktree's;
 * `--dir` reads the installed copy's inventory.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, 'kernel', 'respawnpack.js');
const INSTALLER = path.join(ROOT, 'install', 'install.js');
const HOOK = path.join(ROOT, 'hooks', 'session-routing-nudge.js');
const EXAMPLE = path.join(ROOT, 'examples', 'todo-app');
const renderLib = createRequire(import.meta.url)(path.join(ROOT, 'kernel', 'lib', 'render.js'));

// 8,000 tokens at the four-bytes-per-token proxy the skill states. Tighten-only: lower it as the boot
// set shrinks, never raise it to accommodate a regression.
const CEILING = 32000;
// The projection/data reads alone (Step 0 STATE.json + injection, Step 1 PRODUCT.md + killed rows, Step 2
// doctor --onboarding) under their OWN tighten-only ceiling, so a regression in the doctor projection is
// named here separately from a growth in the skill body or the prose docs the whole-set ceiling catches.
// 9,769 B is the old narrow sum, when Step 2's read was counted as the full `--json` projection; the boot
// renders the TEXT form, so these reads are ~7,680 B today and a projection reverting toward the json
// dump (or growing past it) is exactly what trips this.
const NARROW_CEILING = 9769;
const b = (s) => Buffer.byteLength(s, 'utf8');

/**
 * The boot-budget check, pure so the "one byte over fails with the breakdown" state can be proven on a
 * synthetic input without building a fixture. Returns the total when it is within budget; throws with
 * every named item in the message when it is not.
 */
function assertUnderBudget(breakdown, ceiling) {
  const items = Object.entries(breakdown);
  const total = items.reduce((a, [, v]) => a + v, 0);
  if (total > ceiling) {
    const lines = items.map(([k, v]) => `    ${k}: ${v} B`).join('\n');
    throw new Error(`/respawn boot set is ${total} B, over the ${ceiling} B ceiling:\n${lines}`);
  }
  return total;
}

const F = {}; // filled by the one fixture build below
let fixtureDir = null;

function run(dir, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--dir', dir], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

before(() => {
  const git = (dir, ...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-b1-bootset-'));
  // A copy of the shipped example — the fixture is the todo app because it is the pack's own worked
  // example and the number the review measured; the boot set on a document project reads the same files.
  for (const f of fs.readdirSync(EXAMPLE)) fs.cpSync(path.join(EXAMPLE, f), path.join(fixtureDir, f), { recursive: true });
  git(fixtureDir, 'init', '--quiet', '--initial-branch=main');
  git(fixtureDir, 'config', 'user.email', 'b1@respawnpack.test');
  git(fixtureDir, 'config', 'user.name', 'Boot');
  git(fixtureDir, 'config', 'commit.gpgsign', 'false');
  git(fixtureDir, 'add', '-A');
  git(fixtureDir, 'commit', '--quiet', '-m', 'example baseline');

  const inst = spawnSync(process.execPath, [INSTALLER, fixtureDir], { encoding: 'utf8' });
  assert.equal(inst.status, 0, `the installer failed on the example copy:\n${inst.stdout}\n${inst.stderr}`);
  // Commit the install the way a real adoption does, BEFORE the closeout — otherwise every placed pack
  // file reads as uncommitted "session work" in D3's files-touched snapshot and bloats both STATE.json and
  // HANDOFF.md with paths a booting session never produced. A real boot reads a project whose install is
  // committed and whose HANDOFF names the SESSION's work, which on this example (no work) is none.
  git(fixtureDir, 'add', '-A');
  git(fixtureDir, 'commit', '--quiet', '-m', 'install respawnpack');
  run(fixtureDir, ['state']);          // compile docs/derived/STATE.json
  run(fixtureDir, ['savepoint', '--write']); // render CONTINUITY/GAPS the way a closeout leaves them

  const statePath = path.join(fixtureDir, 'docs', 'derived', 'STATE.json');
  assert.ok(fs.existsSync(statePath), 'the fixture build did not produce docs/derived/STATE.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  // The SessionStart injection the way the hook renders it — spawn the real hook against the tree.
  const hook = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ source: 'startup', session_id: 'b1-bootset', cwd: fixtureDir }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: fixtureDir },
    encoding: 'utf8',
  });
  const injection = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;

  const onboardingJson = run(fixtureDir, ['doctor', '--onboarding', '--json']);
  const onboardingText = run(fixtureDir, ['doctor', '--onboarding']);
  const fullDoctor = run(fixtureDir, ['doctor', '--json']);

  F.state = state;
  F.onboarding = JSON.parse(onboardingJson.stdout);
  F.onboardingTextBytes = b(onboardingText.stdout);
  F.onboardingTextLines = onboardingText.stdout.split(/\r?\n/).filter((l) => /^\s+(CONFIGURED|NOT_APPLICABLE|UNDECIDED|INVALID)\b/.test(l));
  F.fullDoctor = JSON.parse(fullDoctor.stdout);
  F.fullDoctorBytes = b(fullDoctor.stdout);

  // Each boot-set item, measured once. Step 2's read is counted in the TEXT form, because that is what
  // the boot renders into context (the `--json` form exists for the AskUserQuestion interview); the whole
  // set below sums it alongside the Step 0 documents and this skill's own body, since running `/respawn`
  // loads all of them before the human speaks. The skill body is the INSTALLED copy the boot reads.
  const stateBytes = b(fs.readFileSync(statePath, 'utf8'));
  const injectionBytes = b(injection);
  const onboardingTextBytes = b(onboardingText.stdout);
  const productBytes = b(fs.readFileSync(path.join(fixtureDir, 'docs', 'PRODUCT.md'), 'utf8'));
  const killedRowsBytes = b(JSON.stringify(state.killedFeatures || []));
  const continuityBytes = b(fs.readFileSync(path.join(fixtureDir, 'docs', 'derived', 'CONTINUITY.md'), 'utf8'));
  const gapsBytes = b(fs.readFileSync(path.join(fixtureDir, 'docs', 'derived', 'GAPS.md'), 'utf8'));
  // D3: HANDOFF.md is read FIRST at boot, before CONTINUITY, so it joins the summed boot set. savepoint
  // --write (above) renders it; the fixture build fails loudly if it did not.
  const handoffPath = path.join(fixtureDir, 'docs', 'derived', 'HANDOFF.md');
  assert.ok(fs.existsSync(handoffPath), 'savepoint --write did not render docs/derived/HANDOFF.md (D3)');
  const handoffBytes = b(fs.readFileSync(handoffPath, 'utf8'));
  const skillPath = path.join(fixtureDir, '.claude', 'skills', 'respawn', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'the installer did not place the respawn skill the boot loads');
  const skillBodyBytes = b(fs.readFileSync(skillPath, 'utf8'));

  // The WHOLE boot set AFTER B1 — everything Steps 0 to 2 put in context before the human speaks, so the
  // 32,000 B ceiling can fail on the parts that actually grow (the skill body, the prose docs), not only
  // on the data reads.
  F.after = {
    'STATE.json': stateBytes,
    'docs/derived/HANDOFF.md': handoffBytes,
    'docs/derived/CONTINUITY.md': continuityBytes,
    'docs/derived/GAPS.md': gapsBytes,
    'SessionStart injection': injectionBytes,
    'doctor --onboarding (text, the form the boot reads)': onboardingTextBytes,
    'docs/PRODUCT.md': productBytes,
    'killed-feature rows (STATE.json.killedFeatures)': killedRowsBytes,
    'skills/respawn/SKILL.md (the skill body /respawn loads)': skillBodyBytes,
  };

  // The projection/data reads alone (Step 0 STATE.json + injection, Step 1 PRODUCT.md + killed rows, Step 2
  // doctor --onboarding), held under NARROW_CEILING so a doctor-projection regression is named apart from
  // skill-body or prose-doc growth. Same TEXT form the boot reads.
  F.narrow = {
    'STATE.json': stateBytes,
    'SessionStart injection': injectionBytes,
    'doctor --onboarding (text)': onboardingTextBytes,
    'docs/PRODUCT.md': productBytes,
    'killed-feature rows (STATE.json.killedFeatures)': killedRowsBytes,
  };

  // The WHOLE set the SAME method measures with the BASE's reads: the full `doctor --json` Step 2 used to
  // run, and `docs/DECISIONS.md` whole Step 1 used to read. Same tree, same skill and prose docs, old
  // reads — the original defect, now measured over the whole boot set.
  F.base = {
    'STATE.json': stateBytes,
    'docs/derived/CONTINUITY.md': continuityBytes,
    'docs/derived/GAPS.md': gapsBytes,
    'SessionStart injection': injectionBytes,
    'doctor --json (full, old Step 2 read)': F.fullDoctorBytes,
    'docs/PRODUCT.md': productBytes,
    'docs/DECISIONS.md whole (old Step 1 read)': b(fs.readFileSync(path.join(fixtureDir, 'docs', 'DECISIONS.md'), 'utf8')),
    'skills/respawn/SKILL.md (the skill body /respawn loads)': skillBodyBytes,
  };
});

after(() => { if (fixtureDir) { try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* windows lock */ } } });

test('[B1] corrected · the WHOLE boot set on examples/todo-app is under the 32,000 B ceiling, with the breakdown', () => {
  const total = assertUnderBudget(F.after, CEILING);
  // The measured number, recorded beside the tighten-only ceiling (console so the evidence is in the run).
  console.log(`  /respawn WHOLE boot set after B1: ${total} B of ${CEILING} B (${Math.round(total / 4)} tokens at 4 B/token)\n` + Object.entries(F.after).map(([k, v]) => `    ${k}: ${v} B`).join('\n'));
  assert.ok(total < CEILING, `boot set ${total} B is not under ${CEILING} B`);
  // The skill body is the largest single item and the one most likely to grow, so the fence MUST count it:
  // a ceiling that could not fail on the skill body is not the fence the row asked for.
  assert.ok(F.after['skills/respawn/SKILL.md (the skill body /respawn loads)'] > 10000,
    'the skill body must be a counted item, not omitted — it is the part of the boot set most likely to grow');

  // ⛔ D3 · PROVE THE CEILING AT THE CAP, NOT ONLY AT THIS EXAMPLE'S ACTUAL HANDOFF. The fence sums the
  // example's real HANDOFF.md (small, because a committed install leaves no session work to list); a busy
  // project's HANDOFF can reach its byte cap, so the WORST case substitutes the cap for the actual size.
  // If that is over the ceiling, the cap (or the skill body) is too large — the fix is the cap, not the
  // ceiling. This is what makes `handoffByteCap`'s value a tested boot-budget decision, not a guess.
  const CAP = renderLib.HANDOFF_BYTE_CAP;
  const atCap = total - F.after['docs/derived/HANDOFF.md'] + CAP;
  console.log(`  /respawn boot set AT HANDOFF's ${CAP} B cap: ${atCap} B of ${CEILING} B (margin ${CEILING - atCap} B)`);
  assert.ok(atCap < CEILING,
    `at HANDOFF's ${CAP} B byte cap the boot set would be ${atCap} B, over the ${CEILING} B ceiling — lower state.handoffByteCap (render.js HANDOFF_BYTE_CAP) or trim the skill body; do NOT raise the ceiling`);
});

test('[B1] corrected · the projection/data reads stay under their own tighten-only ceiling, apart from the skill body', () => {
  const total = assertUnderBudget(F.narrow, NARROW_CEILING);
  console.log(`  projection/data reads (Step 0-2 minus prose docs and skill body): ${total} B of ${NARROW_CEILING} B\n` + Object.entries(F.narrow).map(([k, v]) => `    ${k}: ${v} B`).join('\n'));
  assert.ok(total < NARROW_CEILING, `projection reads ${total} B are not under ${NARROW_CEILING} B — a doctor-projection regression`);
});

test('[B1] corrected · each named Step 0–2 item is present in the sum (a STATE.json-only fence would miss a bloated read)', () => {
  // The whole point of a per-item breakdown: the skill body, the prose docs, the Step 2 doctor read and
  // the Step 1 killed-feature read are each a counted line, so a bloated one cannot hide behind
  // STATE.json's small, steady size.
  for (const key of [
    'STATE.json', 'docs/derived/HANDOFF.md', 'docs/derived/CONTINUITY.md', 'docs/derived/GAPS.md', 'SessionStart injection',
    'doctor --onboarding (text, the form the boot reads)', 'docs/PRODUCT.md',
    'killed-feature rows (STATE.json.killedFeatures)', 'skills/respawn/SKILL.md (the skill body /respawn loads)',
  ]) {
    assert.ok(key in F.after, `the boot-set breakdown dropped "${key}" — an item nobody measures is a budget nobody enforces`);
    assert.ok(F.after[key] >= 0, `${key} has no byte count`);
  }
  const parts = Object.values(F.after).reduce((a, v) => a + v, 0);
  assert.equal(assertUnderBudget(F.after, CEILING), parts, 'the total must be the sum of the named parts, nothing elided');
});

test('[B1] original defect · the same WHOLE set with the base reads (full doctor + DECISIONS.md whole) is over the ceiling', () => {
  assert.throws(() => assertUnderBudget(F.base, CEILING), /over the 32000 B ceiling/,
    'with the pre-B1 reads the boot set must exceed the budget — that is the defect B1 fixes');
  assert.ok(F.fullDoctorBytes > 20480, `full doctor --json is ${F.fullDoctorBytes} B, not over 20 KB — the row's premise no longer holds`);
});

test('[B1] corrected · doctor --onboarding text form is one line per contract, under 2,048 B', () => {
  assert.equal(F.onboardingTextLines.length, F.fullDoctor.applicability.rows.length,
    `the text form printed ${F.onboardingTextLines.length} contract line(s), not one per the ${F.fullDoctor.applicability.rows.length} survey rows`);
  assert.ok(F.onboardingTextBytes <= 2048, `doctor --onboarding text is ${F.onboardingTextBytes} B, over the 2 KB boot budget`);
  console.log(`  doctor --onboarding: text ${F.onboardingTextBytes} B, json ${F.after['doctor --onboarding (json)']} B (full doctor --json was ${F.fullDoctorBytes} B)`);
});

test('[B1] corrected · doctor --onboarding rows are byte-equal to the full doctor applicability rows, remedy and all', () => {
  assert.equal(JSON.stringify(F.onboarding.applicability), JSON.stringify(F.fullDoctor.applicability.rows),
    'the projection must be byte-identical to the full doctor survey — same computation, never a second reader');
  // A dropped `remedy` would break the byte-equality above; this names the field so the reason is legible.
  for (const r of F.onboarding.applicability) assert.ok(r.remedy && r.remedy.length > 10, `the ${r.subsystem} row lost its remedy`);
  assert.equal(F.onboarding.onboardingComplete, F.fullDoctor.applicability.onboardingComplete, 'the verdict must agree with the full doctor');
});

test('[B1] bypass · doctor --onboarding on a project with no config reports the undecided rows, never an empty array called complete', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-b1-noconfig-'));
  try {
    fs.writeFileSync(path.join(bare, 'README.md'), '# bare\n'); // no respawnpack.config.json at all
    const onb = JSON.parse(run(bare, ['doctor', '--onboarding', '--json']).stdout);
    assert.equal(onb.onboardingComplete, false, 'a project nobody has configured must not read as onboarding-complete');
    assert.ok(Array.isArray(onb.applicability) && onb.applicability.length >= 1, 'the survey rows must be reported, never an empty array presented as complete');
    assert.ok(onb.unresolved.length >= 1, 'the unresolved list must name what nobody has decided');
    // and it is exactly the survey the full doctor reports on the same bare tree, not a second answer.
    const full = JSON.parse(run(bare, ['doctor', '--json']).stdout);
    assert.equal(JSON.stringify(onb.applicability), JSON.stringify(full.applicability.rows));
  } finally { try { fs.rmSync(bare, { recursive: true, force: true }); } catch { /* windows lock */ } }
});

test('[D3] a busy project\'s HANDOFF.md stays under its byte cap (the example margin is thin, so the cap, not the fence, is the lever)', () => {
  // The whole-set fence measures only examples/todo-app, where HANDOFF is small; a busy project would
  // bust the 32,000 B ceiling unseen without HANDOFF's own byte cap. Render HANDOFF for a busy state (300
  // requirements → a bounded 20 next-unblocked list, 20 blockers, 40 files touched) and assert it is held
  // under the default byte cap, cutting its longest list with the "N more" line and keeping every pointer.
  const nextUnblockedWork = Array.from({ length: 20 }, (_, i) => ({ id: `R-${i}`, title: `unblocked requirement number ${i} with a descriptive title`, status: 'unevidenced' }));
  const blockers = Array.from({ length: 20 }, (_, i) => ({ id: `B-${i}`, blockedBy: [`R-${i}`], missingAuthority: 'owner sign-off needed before this unblocks' }));
  const state = {
    generatedAt: '2026-10-10T00:00:00Z', goal: 'ship the busy project', goalComplete: false,
    milestone: 'phase 2', milestoneComplete: false, currentAtomicTask: 'wire the busy thing',
    counts: { nextUnblocked: 300 }, nextUnblockedWork, blockers,
  };
  const handoff = {
    mode: 'goal',
    filesTouched: { source: 'session-delta', total: 40, truncated: true, headMoved: true, shown: Array.from({ length: 25 }, (_, i) => `src/module-${i}/file-with-a-longish-name-${i}.ts`) },
    verifyCommands: ['python tools/validate.py', 'node .claude/respawnpack/respawnpack.js savepoint --verify'],
    writeCycle: 'deadbeef',
    // G17 · a busy machine: a frozen log snapshot and 15 open incidents, so the Operations section is
    // exercised under pressure and the incident list (cut FIRST in the trim order) is what gives.
    opsLog: { rows: 142, head: 'abc123def456', last: { action: 'deployed the busy thing to prod', result: 'green', at: '2026-10-22T00:00:00Z' } },
    openIncidents: { ids: Array.from({ length: 15 }, (_, i) => `inc_${String(i).padStart(16, '0')}`), total: 15 },
  };
  const doc = renderLib.renderHandoff(handoff, state);
  const bytes = Buffer.byteLength(doc, 'utf8');
  console.log(`  [D3] busy-project HANDOFF.md: ${bytes} B of ${renderLib.HANDOFF_BYTE_CAP} B cap (${renderLib.countWords(doc)} words of ${renderLib.HANDOFF_WORD_BUDGET})`);
  assert.ok(bytes <= renderLib.HANDOFF_BYTE_CAP, `busy HANDOFF is ${bytes} B, over the ${renderLib.HANDOFF_BYTE_CAP} B cap`);
  assert.match(doc, /more in/, 'a busy handoff must cut a list with a "N more in" pointer');
  // Every section's fixed pointer lines survive - the byte cap shrinks lists, never a pointer. The
  // Operations section is the sixth (G17): its pointer, the frozen log count and the open-incident count
  // are fixed lines; only the incident ID list is trimmable, placed FIRST in the trim order so it wins
  // ties against the other lists.
  for (const h of ['## Current task', '## Next unblocked', '## Blockers', '## Files touched', '## Verify commands', '## Operations']) {
    assert.ok(doc.includes(h), `the byte cap dropped the "${h}" section — a pointer was cut`);
  }
  assert.match(doc, /- 15 open incident\(s\)/, 'the open-incident COUNT (a fixed line) must survive even when the id list is cut');
  assert.match(doc, /Full log: `\.respawnpack\/ops-log\.jsonl`/, 'the Operations pointer line was cut');
  // The incident id list IS trimmed under the busy load - it is a trimmable list, not a fixed line.
  const shownIncidentIds = (doc.match(/- `inc_\d{16}`/g) || []).length;
  assert.ok(shownIncidentIds < 15, `the incident id list was not trimmed - ${shownIncidentIds} of 15 ids shown with the busy load over the cap`);
});

test('[B1] bypass · a boot set one byte over the ceiling fails, and the breakdown is in the message', () => {
  assert.doesNotThrow(() => assertUnderBudget({ 'STATE.json': 32000 }, CEILING), 'exactly at the ceiling is allowed');
  assert.throws(() => assertUnderBudget({ 'STATE.json': 16000, 'doctor --onboarding (json)': 16001 }, CEILING),
    /32001 B, over the 32000 B ceiling[\s\S]*doctor --onboarding/,
    'one byte over must fail AND name the items that summed to it');
});
