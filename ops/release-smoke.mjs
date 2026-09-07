/*
 * RespawnPack · ops/release-smoke.mjs — the installed-target release smoke, run per POSTURE PROFILE.
 *
 * ⛔ WHY A SEPARATE RUN FROM THE SUITES. Every P0 this program found was reproduced on an INSTALLED
 * target, and several of them sat under a green suite that only ever exercised the source tree. The
 * suites prove the mechanisms; this proves the PRODUCT — what a founder actually gets when they run
 * the installer, in the order they would meet it.
 *
 * ⛔ EVERY STEP PRINTS WHAT IT OBSERVED. A step that cannot run says so and why; nothing is inferred,
 * and a skipped step is never counted as a pass. The exit code is derived from failures, and the step
 * count is derived from the steps that ran — no number in the report is carried by hand.
 *
 * ═══ AND SINCE ADR-003, ONCE PER PROFILE ═════════════════════════════════════════════════════════════
 *
 * ⛔ A PROFILE THAT PASSES THIS VACUOUSLY IS WORSE THAN ONE THAT FAILS IT. `install/_settings-manifest.js`
 * now composes a different registration set and a different kernel placement per declared posture, so
 * "the installer works" is no longer one claim: it is one claim per column of ADR-003's table, and the
 * column nobody smokes is the column that breaks. This file therefore runs the WHOLE lifecycle against a
 * fresh disposable target per profile, not just the install step, because the interesting question about
 * a withheld subsystem is not whether it was withheld — it is whether everything downstream of it still
 * behaves honestly afterwards.
 *
 * ⛔ WHICH PROFILES, AND HOW THEY ARE CHOSEN. `--profile <name>`, repeatable and comma-separated. With no
 * flag the run does `strict` then `light` (`DEFAULT_PROFILES` in ops/_smoke-profiles.mjs): `strict` is the
 * freeze, the column an existing target with no `posture` key composes, so it is the one whose lifecycle
 * must not move; `light` is the only column that actually withholds anything, so it is the only one that
 * can prove a withheld subsystem degrades honestly. A name that is not one of `hooks/_posture.js`'s
 * PROFILES is REFUSED at exit 2 before any step runs — the run could not be performed, which is
 * CANNOT_DETERMINE, and nothing was installed to imply otherwise.
 *
 * ⛔ AND THE PROFILE IS DECLARED, NOT PASSED. There is no installer flag for a posture, deliberately:
 * ADR-003 has exactly one reader of a project's posture and it reads the project's own
 * `respawnpack.config.json`. So each profile's target seeds and commits that declaration like a founder
 * would, and the install genuinely runs under it.
 *
 * Two verdicts judge the result, both computed in ops/_smoke-profiles.mjs so they can be driven through
 * their failing states without a multi-minute install: the REPRODUCTION verdict (every row of the pinned
 * capture still ran, in order, passing — or, for a non-strict profile, NOT_APPLICABLE with a reason) and
 * the FOOTPRINT verdict (every hook carrying a fixed rule id is wired in every profile, strict composes
 * the whole snippet, and light is strictly smaller than strict on every measure).
 *
 * The supplied dogfood projects are EVIDENCE and user property.
 * Nothing here reads, writes, or touches them.
 *
 *   node ops/release-smoke.mjs [--profile <name>[,<name>]]... [--out <file>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { validate } from '../schemas/validate.mjs';
import { evaluateStep16, sha256Hex } from './_smoke16-gate.mjs';
import {
  BASELINE_STEPS, DEFAULT_PROFILES, FIXED_HOOK_FILES, KNOWN_PROFILES,
  evaluateFootprint, evaluateReproduction, parseProfiles,
} from './_smoke-profiles.mjs';

const PACK = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);

const OUT = [];
const log = (s) => { OUT.push(s); console.log(s); };
let failures = 0, skipped = 0, ran = 0, declined = 0;

/*
 * The rows THIS profile emitted, in emission order, reset by runProfile(). The reproduction verdict is a
 * comparison against the pinned capture, so the rows have to be captured as data and not only printed:
 * re-parsing our own console output would make the verdict depend on the formatting of the thing it
 * judges, which is how a report ends up agreeing with itself.
 */
let profileRows = [];

function step(n, label, expected, actual, ok) {
  ran += 1;
  if (!ok) failures += 1;
  profileRows.push({ n, label, outcome: ok ? 'PASS' : 'FAIL' });
  log(`${ok ? 'ok  ' : 'FAIL'} ${String(n).padStart(2)}. ${label}\n       expected: ${expected}\n       observed: ${actual}`);
}
function skip(n, label, why) {
  skipped += 1;
  profileRows.push({ n, label, outcome: 'SKIPPED', reason: why });
  log(`SKIP ${String(n).padStart(2)}. ${label}\n       reason: ${why}`);
}
/*
 * ⛔ NOT_APPLICABLE IS THE FOURTH OUTCOME, NOT A THIRD KIND OF SKIP. A step the declared posture makes
 * inapplicable has a KNOWN answer — "this installation does not carry the thing you are asking about" —
 * where a skip has none. Reported separately, counted separately, never rounded into either the passes or
 * the failures, and refused by the reproduction verdict unless it carries a reason.
 */
function na(n, label, why) {
  declined += 1;
  profileRows.push({ n, label, outcome: 'NOT_APPLICABLE', reason: why });
  log(`n/a  ${String(n).padStart(2)}. ${label}\n       not applicable: ${why}`);
}

/*
 * ⛔ THE PROFILE SELECTION IS RESOLVED, AND REFUSED, BEFORE ANY TARGET EXISTS. An unknown posture name
 * must not reach the point where a directory has been created, an installer has run, or a report says
 * anything at all about a lifecycle. Exit 2 because the run could not be performed — the same code
 * "could not run" carries everywhere else in this pack (kernel/lib/outcome.js).
 */
const selection = parseProfiles(process.argv.slice(2));
if (selection.error) {
  console.error(`release smoke: ${selection.error}`);
  console.error('CANNOT_DETERMINE — nothing was installed and no lifecycle result is implied.');
  process.exit(2);
}
const outFile = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

log(`# RespawnPack release smoke — one disposable installed target per posture profile

Pack revision: ${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACK, encoding: 'utf8' }).trim()}
Node: ${process.version} · Platform: ${process.platform}
Profiles this run: ${selection.profiles.join(', ')} (${selection.explicit ? 'named with --profile' : 'the default pair'})
Postures this pack has: ${KNOWN_PROFILES.join(', ')} · hooks wired in every profile: ${FIXED_HOOK_FILES.length}
Pinned lifecycle: the ${BASELINE_STEPS.length} row(s) captured from a clean run on the unmodified tree at
cb30211, reproduced under strict and required to be pass-or-declared-with-a-reason under every other.
`);

/**
 * Run the whole lifecycle against a fresh disposable target that DECLARES `profile`.
 *
 * @param {string} profile one of hooks/_posture.js's PROFILES
 * @returns {Promise<{profile: string, footprint: Object, rows: Object[], dockerResult: string}>}
 */
async function runProfile(profile) {
  profileRows = [];
  let footprint = { profile, entries: NaN, groups: NaN, hooks: [], created: NaN, claudeFiles: NaN, kernelPlaced: NaN, kernelTotal: NaN, source: 'UNREPORTED', omittedByProfile: [] };
  let reconcileInstalled = true;
  let reconcileWithheldBecause = '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-release-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (rel, body) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  };
  const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [path.join(dir, '.claude', 'respawnpack', 'respawnpack.js'), ...args, '--dir', dir, '--json'],
      { encoding: 'utf8', timeout: 300000 });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* left null */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const schema = (name) => readJSON(path.join(PACK, 'schemas', name));

  log(`\n${'═'.repeat(96)}\n## Profile \`${profile}\` — a disposable installed target of its own`
    + `\n\nTarget: ${dir}`
    + '\nPosture: DECLARED in the target\'s own respawnpack.config.json BEFORE the installer runs, because'
    + '\n         install/install.js resolves it from the founder\'s config (hooks/_posture.js, the one reader)'
    + '\n         and never from a flag of its own.\n');

  // --- the target ------------------------------------------------------------------------------------
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'release@respawnpack.test');
  git('config', 'user.name', 'Release Smoke');
  git('config', 'commit.gpgsign', 'false');
  write('README.md', '# release-smoke target\n');
  write('docs/DECISIONS.md', '# Decisions\n\nD-075 retires the magic gauntlet. Do not reintroduce it.\n');
  write('story/07_Weapons.md', '# Weapons\n\nThe launch roster ships tiered weapons.\n');
  write('package.json', JSON.stringify({ name: 'release-smoke-target', version: '1.0.0', scripts: { lint: 'node -e "process.exit(0)"' } }, null, 2));
  /*
   * ⛔ THE POSTURE IS THE FOUNDER'S DECLARATION, SO IT IS SEEDED AND COMMITTED LIKE ONE. `install.js`
   * reads it through `hooks/_posture.js` at its §2e-bis, before it places a single kernel file, and there
   * is deliberately no installer flag to override that (ADR-003: one reader, one source). So the only way
   * to smoke an install UNDER a profile is to be a project that declares it. Measured against the
   * unmodified tree before this was written: declaring `strict` moves exactly one observable, doctor's own
   * `posture` row (CONFIGURED rather than NOT_CONFIGURED), which no lifecycle step below asserts on —
   * every other doctor row and every savepoint check is identical to a target with no posture key at all.
   */
  write('respawnpack.config.json', JSON.stringify({ posture: { profile } }, null, 2) + '\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'seed');

  // 1. DEFAULT INSTALL --------------------------------------------------------------------------------
  const install = spawnSync(process.execPath, [path.join(PACK, 'install', 'install.js'), dir], { encoding: 'utf8', timeout: 600000 });
  step(1, 'default install completes on a fresh target', 'exit 0', `exit ${install.status}${install.status ? ` — ${(install.stderr || '').slice(0, 200)}` : ''}`, install.status === 0);
  step(1, 'the installer does NOT install the optional memory engine by default',
    'no .mcp.json respawn-memory entry (file-backed memory is the zero-setup default)',
    `.mcp.json ${fs.existsSync(path.join(dir, '.mcp.json')) ? 'present' : 'absent'}`,
    !((readJSON(path.join(dir, '.mcp.json')) || {}).mcpServers || {})['respawn-memory']);

  /*
   * ⛔ WHAT THIS PROFILE COMPOSED AND WHAT IT PLACED, READ OFF THE TARGET RATHER THAN OFF THE MANIFEST
   * THAT DECIDED IT. Asking `install/_settings-manifest.js` what it WOULD compose and reporting that as
   * what the target got is the same class of mistake as a CI step reporting its own intention; the files
   * on disk are the only witness that the composition reached them. So the entry count, the group count
   * and the hook set come out of the target's own `.claude/settings.json`, the placed count is a walk of
   * the target's own `.claude/`, and the installer's own summary line is parsed beside them as a
   * cross-check. Nothing is asserted here: `evaluateFootprint` in `ops/_smoke-profiles.mjs` is the judge,
   * at the end, where both profiles' numbers exist to be compared against each other.
   */
  {
    const settings = readJSON(path.join(dir, '.claude', 'settings.json')) || {};
    const groups = Object.values(settings.hooks || {}).flat();
    const entries = groups.flatMap((g) => (g && g.hooks) || []);
    // Every .js token in a command counts as wired: the script itself and, for a dispatcher registration
    // (`dispatch.js PreToolUse <group> --covers a.js,b.js`), each hook it runs in-process (P4-T-15b).
    const hooks = [...new Set(entries.flatMap((h) => String((h && h.command) || '').match(/[A-Za-z0-9_.-]+\.js/g) || []))].sort();
    const walk = (d) => { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? walk(path.join(d, e.name)) : 1; return n; };
    const num = (re) => { const m = re.exec(String(install.stdout || '')); return m ? Number(m[1]) : NaN; };
    const kernel = /kernel: placed (\d+) of (\d+) file\(s\)/.exec(String(install.stdout || ''));
    footprint = {
      profile,
      entries: entries.length,
      groups: groups.length,
      hooks,
      created: num(/created (\d+) file\(s\)/),
      claudeFiles: fs.existsSync(path.join(dir, '.claude')) ? walk(path.join(dir, '.claude')) : NaN,
      kernelPlaced: kernel ? Number(kernel[1]) : NaN,
      kernelTotal: kernel ? Number(kernel[2]) : NaN,
      source: (/settings\.json posture: `[^`]+` \(([A-Z]+)\)/.exec(String(install.stdout || '')) || [])[1] || 'UNREPORTED',
      omittedByProfile: [...String(install.stdout || '').matchAll(/− omitted by `[^`]+`: (.+)$/gm)].map((m) => m[1].trim()),
    };
    log(`---- profile \`${profile}\` footprint ----`
      + `\ncomposed hook set: ${footprint.entries} entr(ies) in ${footprint.groups} group(s), posture source ${footprint.source}`
      + `\n  wired:   ${footprint.hooks.join(' ') || 'NONE'}`
      + `\n  omitted by this profile: ${footprint.omittedByProfile.join(' · ') || 'nothing'}`
      + `\nplaced file count: the installer reported ${footprint.created} created; ${footprint.claudeFiles} file(s) now under the target's .claude/;`
      + ` kernel ${footprint.kernelPlaced} of ${footprint.kernelTotal}\n`);
  }

  // 2. DEFAULT DOCTOR ---------------------------------------------------------------------------------
  {
    const d = cli('doctor');
    const rows = (d.json && d.json.rows) || [];
    const broken = rows.filter((r) => r.label === 'BROKEN');
    step(2, 'doctor runs on a fresh install and reports no BROKEN component',
      'rows emitted, zero BROKEN', `${rows.length} row(s), ${broken.length} BROKEN${broken.length ? `: ${broken.map((r) => r.check).join(', ')}` : ''}`,
      rows.length > 0 && broken.length === 0);
    /*
     * ⛔ THE SAME QUESTION UNDER EVERY PROFILE, AND THE PROFILE-CORRECT ANSWER REQUIRED OF EACH. A posture
     * that does not install the reconciliation subsystem (ADR-003 `kernel:R4` reads "n.a., not installed"
     * in the `light` column) must say exactly that and NAME ITSELF, which is a different sentence from
     * "you have not configured it" and may not stand in for it. The two answers that would be wrong here
     * are the two this pack exists to prevent: BROKEN, and a quiet green.
     */
    const reconcileRow = rows.find((r) => r.check === 'reconcile:tasks');
    reconcileInstalled = fs.existsSync(path.join(dir, '.claude', 'respawnpack', 'lib', 'reconcile.js'));
    const wantReconcile = reconcileInstalled ? 'NOT_CONFIGURED' : 'NOT_APPLICABLE';
    // Carried WHOLE, not truncated: this sentence becomes the reason three declined rows give for
    // themselves below, and a reason cut off mid-word is a reason the reader has to guess the end of.
    if (reconcileRow && !reconcileInstalled) reconcileWithheldBecause = String(reconcileRow.detail || '').replace(/\s+/g, ' ').trim();
    step(2, 'doctor reports the DF-005 reconciliation state on a project that has not configured it',
      `a reconcile:tasks row reading ${wantReconcile}${reconcileInstalled ? '' : ', naming the posture that withheld the subsystem'}`,
      reconcileRow ? `${reconcileRow.label} — ${reconcileRow.detail.slice(0, 90)}` : 'NO ROW',
      Boolean(reconcileRow) && reconcileRow.label === wantReconcile
        && (reconcileInstalled || new RegExp(`\\b${profile}\\b`).test(String(reconcileRow.detail))));

    /*
     * ⛔ A FRESH INSTALL IS NOT A FINISHED ONE, AND THIS IS WHERE THAT IS PROVED ON A REAL INSTALLATION
     * RATHER THAN ON A FIXTURE. The dogfood's complaint was that a working install with unanswered
     * questions was indistinguishable from a damaged one; the row below is the sentence that separates
     * them, and it must NOT be green — an install nobody has finished answering for has not established
     * that it is ready.
     */
    const onboarding = rows.find((r) => r.check === 'onboarding');
    step(2, 'doctor names onboarding as INCOMPLETE on a fresh install, and names what is undecided',
      'an onboarding row reading INCOMPLETE, listing the unresolved contracts',
      onboarding ? `${onboarding.label} — ${onboarding.detail.slice(0, 110)}` : 'NO ROW',
      Boolean(onboarding) && onboarding.label === 'INCOMPLETE' && /undecided/.test(onboarding.detail));
    step(2, 'and that unfinished onboarding is NOT rounded down to green',
      'doctor outcome CANNOT_DETERMINE with zero BROKEN rows', `${d.json && d.json.outcome} with ${broken.length} BROKEN`,
      Boolean(d.json) && d.json.outcome === 'CANNOT_DETERMINE' && broken.length === 0);
  }

  // 3. STATE COMPILATION ------------------------------------------------------------------------------
  {
    const sd = path.join(dir, 'docs', 'derived', 'state');
    fs.mkdirSync(path.join(sd, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'requirements.json'), JSON.stringify({
      schemaVersion: '1.0.0', denominatorVersion: 'rs-1',
      requirements: [{ id: 'R-1', title: 'export works', mandatory: true }, { id: 'R-2', title: 'import works', mandatory: true }],
      gates: {},
    }, null, 2));
    git('add', '-A'); git('commit', '--quiet', '-m', 'requirements');
    const s = cli('state');
    const st = readJSON(path.join(dir, 'docs', 'derived', 'STATE.json'));
    step(3, 'state compiles and recomputes its counts from rows', 'exit 0, mandatory 2 derived from the rows',
      `exit ${s.code}, mandatory=${st && st.counts && st.counts.mandatory}`, s.code === 0 && st && st.counts.mandatory === 2);
  }

  // 4. SAVEPOINT VERIFICATION -------------------------------------------------------------------------
  {
    const sp = cli('savepoint');
    const checks = (sp.json && sp.json.checks) || [];
    step(4, 'savepoint runs the full verification battery and reports each check',
      'checks emitted, including the removal contract and the DF-005 reconciliation',
      `${checks.length} check(s): ${[...new Set(checks.map((c) => String(c.check).split(':')[0]))].join(', ')}`,
      checks.length > 0 && checks.some((c) => String(c.check).startsWith('removals')) && checks.some((c) => c.check === 'reconcile'));
    step(4, 'an unconfigured removal contract and reconciliation are CANNOT_DETERMINE, never a quiet pass',
      'savepoint exit 2', `exit ${sp.code}`, sp.code === 2);
  }

  // 5. QUALITY GATE — three project shapes ------------------------------------------------------------
  {
    const vf = path.join(dir, 'gate-verdict.json');
    const cfgPath = path.join(dir, 'respawnpack.config.json');
    const base = readJSON(cfgPath) || {};

    // 5a. configured and passing
    fs.writeFileSync(cfgPath, JSON.stringify({ ...base, qualityGate: { checks: [{ name: 'lint', root: '.', command: process.execPath, args: ['-e', 'process.exit(0)'] }] } }, null, 2));
    const passing = cli('gate', '--verdict-file', vf);
    step(5, 'quality gate on a CONFIGURED PASSING project', 'PASS at exit 0 with ran >= 1',
      `${passing.json && passing.json.outcome} exit ${passing.code} ran=${passing.json && passing.json.ran}`,
      passing.code === 0 && passing.json.outcome === 'PASS' && passing.json.ran >= 1);

    /*
     * 5b. The stack is DETECTED and nothing is runnable — the vacuous-green case Scenario N exists for.
     * The seed package.json carries a `lint` script, which is a genuinely CONFIGURED node project, so it
     * is emptied for this sub-case and restored afterwards. (The first version of this step used the
     * seeded file and got PASS/ran=1 — correctly, because the project WAS configured. The step was
     * measuring the wrong project, not catching a defect.)
     */
    fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2));
    const pkg = path.join(dir, 'package.json');
    const pkgBody = fs.readFileSync(pkg, 'utf8');
    fs.writeFileSync(pkg, JSON.stringify({ name: 'release-smoke-target', version: '1.0.0' }, null, 2));
    const unconfigured = cli('gate', '--verdict-file', vf);
    // K-09: the exit code and the diagnosis are two fields now — CANNOT_DETERMINE decides CI, the gate's
    // own NOT_CONFIGURED tells the operator which of the two unknowns this was. Both are asserted here.
    step(5, 'quality gate on a DETECTED BUT UNCONFIGURED project', 'CANNOT_DETERMINE / NOT_CONFIGURED at exit 2, never a green with ran 0',
      `${unconfigured.json && unconfigured.json.outcome} (${unconfigured.json && unconfigured.json.label}) exit ${unconfigured.code} ran=${unconfigured.json && unconfigured.json.ran} `
      + `profiles=${((unconfigured.json || {}).profiles || []).map((p) => p.id).join(',') || 'none'}`,
      unconfigured.code === 2 && unconfigured.json.outcome === 'CANNOT_DETERMINE' && unconfigured.json.label === 'NOT_CONFIGURED'
        && unconfigured.json.ran === 0 && ((unconfigured.json || {}).profiles || []).length > 0);
    fs.writeFileSync(pkg, pkgBody);

    // 5c. declared not applicable, with a reason
    fs.writeFileSync(cfgPath, JSON.stringify({ ...base, qualityGate: { notApplicable: true, reason: 'a content repository with no build' } }, null, 2));
    const na = cli('gate', '--verdict-file', vf);
    step(5, 'quality gate on a DECLARED NOT-APPLICABLE project', 'NOT_APPLICABLE at exit 0, declared true',
      `${na.json && na.json.outcome} exit ${na.code} declared=${na.json && na.json.declared}`,
      na.code === 0 && na.json.outcome === 'NOT_APPLICABLE' && na.json.declared === true);

    step(5, 'the gate verdict artifact conforms to its declared schema',
      'valid against schemas/gate-verdict.schema.json',
      (() => { const r = validate(readJSON(vf), schema('gate-verdict.schema.json')); return r.valid ? 'valid' : r.errors.join(' | '); })(),
      validate(readJSON(vf), schema('gate-verdict.schema.json')).valid);

    fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2));
  }

  // 6. COLLABORATE ------------------------------------------------------------------------------------
  {
    const c = cli('contract', 'collaborate');
    step(6, 'the collaborate contract is the default and can be entered explicitly',
      'mode collaborate', `${c.json && c.json.contract && c.json.contract.mode}`, c.code === 0 && c.json.contract.mode === 'collaborate');
  }

  // 7. DELEGATE — open and close ----------------------------------------------------------------------
  {
    const d = cli('contract', 'delegate', '--task', 'fix the CSV writer', '--acceptance', 'writer emits CRLF;a test covers it');
    step(7, 'delegate opens with derived acceptance criteria and refuses without them',
      'mode delegate with 2 criteria', `mode=${d.json.contract.mode} criteria=${d.json.contract.acceptance.length}`,
      d.code === 0 && d.json.contract.mode === 'delegate' && d.json.contract.acceptance.length === 2);

    const partial = cli('contract', 'complete', '--met', 'writer emits CRLF');
    step(7, 'a PARTIAL attestation is refused and names what was not attested',
      'FAIL naming the missing criterion', `${partial.json.outcome}: ${String(partial.json.error || '').slice(0, 70)}`,
      partial.json.outcome === 'FAIL' && /a test covers it/.test(String(partial.json.error)));

    const done = cli('contract', 'complete', '--met', 'writer emits CRLF', '--met', 'a test covers it', '--evidence', 'suite green');
    step(7, 'a FULL attestation closes the delegation and archives it as a claim, not a proof',
      'PASS, archived with the attestation wording', `${done.json.outcome}`,
      done.code === 0 && done.json.outcome === 'PASS'
        && /this is a claim, not a proof/.test(JSON.stringify(readJSON(path.join(dir, '.respawnpack', 'runtime', 'delegations.json')) || {})));
  }

  // 8. GOAL — open, suspend, resume, and refuse mechanical completion ----------------------------------
  {
    const g = cli('contract', 'goal', '--id', 'G-R', '--goal', 'ship the export', '--completion', 'all-mandatory-conformant');
    step(8, 'goal mode requires a stated goal AND stated completion criteria',
      'PASS with the contract recorded', `${g.json.outcome} goal=${g.json.contract.activeGoalId}`, g.code === 0 && g.json.contract.activeGoalId === 'G-R');

    const refused = cli('contract', 'goal', '--goal', 'no criteria given');
    step(8, 'a goal with no completion criteria is REFUSED, never inferred',
      'non-zero, naming --completion', `exit ${refused.code}: ${String((refused.json || {}).error || '').slice(0, 60)}`,
      refused.code !== 0 && /--completion/.test(String((refused.json || {}).error)));

    const suspended = cli('contract', 'collaborate');
    step(8, 'collaborate SUSPENDS the goal rather than destroying it',
      'suspendedGoalId G-R', `${suspended.json.contract.suspendedGoalId}`, suspended.json.contract.suspendedGoalId === 'G-R');

    const resumed = cli('contract', 'goal', '--resume');
    step(8, 'the suspended goal resumes with its contract intact',
      'mode goal, active G-R', `mode=${resumed.json.contract.mode} active=${resumed.json.contract.activeGoalId}`,
      resumed.code === 0 && resumed.json.contract.mode === 'goal' && resumed.json.contract.activeGoalId === 'G-R');

    // ⛔ The mechanical-completion refusal. Every mandatory row is UNEVIDENCED here, so the stated
    // criterion is UNMET and the goal must refuse to close — the run-B failure mode, inverted.
    const close = cli('contract', 'complete');
    step(8, 'goal completion REFUSES on an unmet stated criterion',
      'non-zero, goal still ongoing', `exit ${close.code}: ${String((close.json || {}).error || (close.json || {}).outcome || '').slice(0, 80)}`,
      close.code !== 0 && (readJSON(path.join(dir, 'docs', 'derived', 'state', 'goal.json')) || {}).ongoingGoalId === 'G-R');
    cli('contract', 'collaborate');
  }

  // 9. FILE-BACKED MEMORY IS THE DEFAULT --------------------------------------------------------------
  {
    const d = cli('doctor');
    const engine = ((d.json && d.json.rows) || []).find((r) => r.check === 'memory:engine');
    const skill = ((d.json && d.json.rows) || []).find((r) => r.check === 'memory:skill');
    step(9, 'file-backed memory is ACTIVE with no setup, and the engine is reported as not installed',
      'memory:skill ACTIVE, memory:engine NOT_CONFIGURED',
      `skill=${skill && skill.label} engine=${engine && engine.label}`,
      skill && skill.label === 'ACTIVE' && engine && engine.label === 'NOT_CONFIGURED');
  }

  // 10. --with-memory: a real MCP handshake and cross-process persistence -------------------------------
  {
    const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (npm.status !== 0) {
      skip(10, '--with-memory MCP handshake and cross-process persistence',
        'npm is not available on this host, so the engine cannot be installed. NOT a pass — the mechanism is unverified here and install/install.test.mjs is the standing evidence.');
    } else {
      const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-release-mem-'));
      try {
        execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: mem });
        fs.writeFileSync(path.join(mem, 'README.md'), '# memory target\n');
        const r = spawnSync(process.execPath, [path.join(PACK, 'install', 'install.js'), mem, '--with-memory'], { encoding: 'utf8', timeout: 900000 });
        const memoryLib = require_(path.join(mem, '.claude', 'respawnpack', 'lib', 'memory.js'));
        const probe = r.status === 0 ? memoryLib.probe(mem) : { outcome: 'FAIL', detail: `install exited ${r.status}` };
        step(10, '--with-memory installs the engine and completes a REAL MCP handshake plus a write/read round trip',
          'probe PASS, detail naming the handshake and the cross-process round trip',
          `${probe.outcome} — ${String(probe.detail || '').slice(0, 150)}`,
          probe.outcome === 'PASS' && /handshake/i.test(String(probe.detail)) && /ACROSS TWO SERVER PROCESSES/i.test(String(probe.detail)));
        step(10, 'the engine is registered against an ABSOLUTE node path, with no global rmem and no PATH mutation',
          'an absolute path in .mcp.json',
          (() => { const e = ((readJSON(path.join(mem, '.mcp.json')) || {}).mcpServers || {})['respawn-memory']; return e ? e.command : 'no entry'; })(),
          (() => { const e = ((readJSON(path.join(mem, '.mcp.json')) || {}).mcpServers || {})['respawn-memory']; return Boolean(e) && path.isAbsolute(e.command); })());
      } finally { try { fs.rmSync(mem, { recursive: true, force: true }); } catch { /* windows lock */ } }
    }
  }

  // 11. LIVING-SKILL CANARY LIFECYCLE ------------------------------------------------------------------
  {
    const sd = path.join(dir, '.claude', 'skills', 'debug');
    const en = cli('living', 'enable', 'debug');
    const meta = readJSON(path.join(sd, '.skill-meta.json'));
    step(11, 'a canary skill can be enabled, freezing its baseline', 'exit 0 with .skill-meta.json written',
      `exit ${en.code} meta=${meta ? 'present' : 'absent'}`, en.code === 0 && Boolean(meta));
    step(11, '.skill-meta.json conforms to its declared schema',
      'valid against schemas/skill-meta.schema.json',
      (() => { const r = validate(meta, schema('skill-meta.schema.json')); return r.valid ? 'valid' : r.errors.join(' | '); })(),
      validate(meta, schema('skill-meta.schema.json')).valid);

    // Regeneration evaluates keyed memory entities, so give the installed target one real subject. A
    // fresh `.gitkeep`-only graph is intentionally CANNOT_DETERMINE: zero checked subjects cannot pass.
    write('memory/graph/gotcha/release-smoke-living.md', [
      '---',
      'id: gotcha:release-smoke-living',
      'confidence: 0.9',
      'observed_at: 2026-08-12T00:00:00Z',
      'relations: [applies-to|skill:debug]',
      '---',
      '',
      'The release smoke proves an installed target can derive this traced overlay line.',
      '',
    ].join('\n'));
    const regen = cli('living', 'regenerate', 'debug', '--write');
    const regenDetail = String((((regen.json || {}).checks || [])[0] || {}).detail || '');
    step(11, 'regenerate evaluates a real keyed entity and reports its overlay budget',
      'exit 0, one learned line, budget 12 line(s)',
      `exit ${regen.code}: ${regenDetail || String(regen.stderr || '').slice(0, 120)}`,
      regen.code === 0 && /1 learned line/.test(regenDetail) && /budget 12 line\(s\)/.test(regenDetail));
    const status = cli('living', 'status', 'debug');
    step(11, 'status reports the canary as living against its frozen base', 'PASS',
      `${(status.json || {}).outcome}`, status.code === 0);
    const reset = cli('living', 'reset', 'debug');
    step(11, 'reset restores the baseline without deleting the founder archive', 'exit 0',
      `exit ${reset.code}`, reset.code === 0);

    const nonCanary = cli('living', 'enable', 'shell-guard');
    step(11, 'a NON-canary skill is refused — living behaviour is opt-in for three skills and nothing else',
      'non-zero', `exit ${nonCanary.code}`, nonCanary.code !== 0);
  }

  // 12. UPGRADE PRESERVES FOUNDER CONTENT AND LIFECYCLE ARCHIVES ----------------------------------------
  {
    const founderSkill = write('.claude/skills/my-own/SKILL.md', '# a skill the founder wrote\n');
    const founderMemory = write('memory/graph/gotcha/mine.md', '# a memory the founder wrote\n');
    cli('living', 'enable', 'debug');
    fs.appendFileSync(path.join(dir, '.claude', 'skills', 'debug', 'SKILL.md'), '\n<!-- founder overlay line -->\n');

    const up = spawnSync(process.execPath, [path.join(PACK, 'install', 'upgrade.js'), dir], { encoding: 'utf8', timeout: 900000 });
    const archives = fs.existsSync(path.join(dir, '.claude', 'skills', 'debug'))
      ? fs.readdirSync(path.join(dir, '.claude', 'skills', 'debug')).filter((f) => /^SKILL\.superseded/.test(f)) : [];
    step(12, 'upgrade preserves founder-authored skills and memory', 'exit 0, both intact',
      `exit ${up.status} skill=${fs.existsSync(founderSkill)} memory=${fs.existsSync(founderMemory)}`,
      up.status === 0 && fs.existsSync(founderSkill) && fs.existsSync(founderMemory));
    step(12, 'upgrade ARCHIVES the living overlay rather than silently discarding it',
      'a SKILL.superseded*.md archive naming the founder lines', archives.join(', ') || 'NONE',
      archives.length >= 1 && /founder overlay line/.test(fs.readFileSync(path.join(dir, '.claude', 'skills', 'debug', archives[0]), 'utf8')));
    step(12, '`living status` REPORTS the loss instead of showing a clean PASS',
      'status names the archive', (() => { const s = cli('living', 'status', 'debug'); return `${s.code}: ${String(s.stdout).replace(/\s+/g, ' ').slice(0, 120)}`; })(),
      /superseded/i.test(cli('living', 'status', 'debug').stdout));
  }

  // 13. UNINSTALL — exactly the documented artifacts ----------------------------------------------------
  // (run last on this target; steps 14–16 use their own)
  const uninstallLast = () => {
    const founderSkill = path.join(dir, '.claude', 'skills', 'my-own', 'SKILL.md');
    const founderMemory = path.join(dir, 'memory', 'graph', 'gotcha', 'mine.md');
    const un = spawnSync(process.execPath, [path.join(PACK, 'install', 'uninstall.js'), dir, '--force'], { encoding: 'utf8', timeout: 900000 });
    step(13, 'uninstall removes what the pack owns and NOTHING the founder authored',
      'pack hooks gone; founder skill, founder memory and project docs intact',
      `exit ${un.status} hooks=${fs.existsSync(path.join(dir, '.claude', 'hooks', 'index-guard.js'))} `
      + `founderSkill=${fs.existsSync(founderSkill)} founderMemory=${fs.existsSync(founderMemory)} decisions=${fs.existsSync(path.join(dir, 'docs', 'DECISIONS.md'))}`,
      un.status === 0 && !fs.existsSync(path.join(dir, '.claude', 'hooks', 'index-guard.js'))
        && fs.existsSync(founderSkill) && fs.existsSync(founderMemory) && fs.existsSync(path.join(dir, 'docs', 'DECISIONS.md')));
    step(13, 'uninstall REPORTS the lifecycle artifacts it preserves rather than leaving them unnamed',
      'the summary names the preserved artifacts', String(un.stdout).replace(/\s+/g, ' ').slice(-160),
      /SKILL\.base\.md|\.skill-meta\.json|superseded/i.test(String(un.stdout)));
  };

  // 14. NEW: DECLARED SCHEMA VALIDATION ON THE INSTALLED TARGET -----------------------------------------
  {
    const families = [
      ['docs/derived/STATE.json', 'state.schema.json'],
      ['docs/derived/state/goal.json', 'goal.schema.json'],
      ['.respawnpack/runtime/contract.json', 'runtime-contract.schema.json'],
      ['respawnpack.config.json', 'project-config.schema.json'],
    ];
    const bad = [];
    for (const [rel, name] of families) {
      const doc = readJSON(path.join(dir, rel));
      if (doc === null) { bad.push(`${rel}: absent or unparseable`); continue; }
      const r = validate(doc, schema(name));
      if (!r.valid) bad.push(`${rel}: ${r.errors.slice(0, 2).join(' | ')}`);
    }
    step(14, 'every artifact this installed target generated conforms to its DECLARED schema',
      `${families.length} families valid`, bad.length ? bad.join(' ;; ') : `all ${families.length} valid`, bad.length === 0);

    // And the negative direction: a malformed artifact is refused, never read as truth.
    const rc = path.join(dir, '.respawnpack', 'runtime', 'contract.json');
    const good = fs.readFileSync(rc, 'utf8');
    fs.writeFileSync(rc, JSON.stringify({ mode: 'autonomous', activeGoalId: 'G-R', suspendedGoalId: null, setAt: new Date().toISOString() }));
    const rt = require_(path.join(dir, '.claude', 'hooks', '_runtime.js'));
    step(14, 'an invented interaction mode in a gitignored file NEVER grants autonomy',
      'readContract degrades to collaborate', `mode=${rt.readContract(dir).mode}`, rt.readContract(dir).mode === 'collaborate');
    fs.writeFileSync(rc, good);

    const sd = path.join(dir, 'docs', 'derived', 'state');
    fs.writeFileSync(path.join(sd, 'evidence', 'future.json'), JSON.stringify({
      schemaVersion: '9.9.9', requirements: ['R-1'], sourceRevision: 'x', verdict: 'pass',
      positiveControl: { passed: true }, negativeControl: { detected: true },
    }));
    cli('state');
    const st = readJSON(path.join(dir, 'docs', 'derived', 'STATE.json'));
    step(14, 'evidence at an UNKNOWN schemaVersion is rejected WITH its reason recorded, and moves no count',
      'accepted 0, the rejection reason naming the version, conformant 0',
      `accepted=${st.evidence.accepted} conformant=${st.counts.conformant} reason=${(st.evidence.rejected[0] || {}).reason || 'none recorded'}`,
      st.evidence.accepted === 0 && st.counts.conformant === 0 && /unknown schemaVersion/.test((st.evidence.rejected[0] || {}).reason || ''));
    fs.rmSync(path.join(sd, 'evidence', 'future.json'));
  }

  // 15. NEW: DF-005 RECONCILIATION ON THE INSTALLED TARGET ----------------------------------------------
  /*
   * ⛔ THE ONE PLACE A PROFILE CAN MAKE A LIFECYCLE STEP INAPPLICABLE, AND IT IS REPORTED AS THE FOURTH
   * OUTCOME RATHER THAN QUIETLY DROPPED. `light` does not place `kernel/lib/reconcile.js` at all (ADR-003
   * `kernel:R4`), so there is no reconciliation on this target to run, drift or project into STATE.json.
   * Every one of the three rows below therefore says NOT_APPLICABLE and carries the reason the TARGET
   * ITSELF gave for it — doctor's own `reconcile:tasks` detail, captured at step 2 — rather than a reason
   * this file made up. A row that simply stopped appearing would be indistinguishable from a row somebody
   * deleted, which is exactly what `ops/_smoke-profiles.mjs`'s reproduction verdict refuses to accept.
   */
  if (!reconcileInstalled) {
    const why = reconcileWithheldBecause
      || `the declared \`${profile}\` posture does not install kernel/lib/reconcile.js (ADR-003 kernel:R4), and doctor gave no detail for it`;
    na(15, 'DF-005 reconciliation runs on an installed target and finds drift in BOTH directions', why);
    na(15, 'doctor reports the reconciliation as ACTIVE — a configured check reporting drift is not a broken check', why);
    na(15, 'the verdict reaches STATE.json while the task records themselves do NOT', why);
  } else {
    const cfgPath = path.join(dir, 'respawnpack.config.json');
    const base = readJSON(cfgPath) || {};
    fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      tasks: [{ id: 'R-1', title: 'export works', status: 'open' }, { id: 'T-ORPHAN', title: 'a task no requirement tracks', status: 'open' }],
    }, null, 2));
    fs.writeFileSync(cfgPath, JSON.stringify({
      ...base,
      state: { ...(base.state || {}), reconcile: { tasks: { kind: 'json', path: 'tasks.json', pointer: 'tasks' }, project: { kind: 'requirements' } } },
    }, null, 2));

    const r = cli('reconcile');
    step(15, 'DF-005 reconciliation runs on an installed target and finds drift in BOTH directions',
      'DRIFT at exit 1, naming the orphan task AND the untracked requirement',
      `${(r.json || {}).reconciliation} exit ${r.code} — ${String((r.json || {}).why || '').slice(0, 120)}`,
      r.code === 1 && r.json.reconciliation === 'DRIFT'
        && /T-ORPHAN/.test(String(r.json.why)) && /R-2/.test(String(r.json.why)));

    const d = cli('doctor');
    const row = ((d.json && d.json.rows) || []).find((x) => x.check === 'reconcile:tasks');
    step(15, 'doctor reports the reconciliation as ACTIVE — a configured check reporting drift is not a broken check',
      'ACTIVE', row ? row.label : 'NO ROW', Boolean(row) && row.label === 'ACTIVE');

    cli('state');
    const st = readJSON(path.join(dir, 'docs', 'derived', 'STATE.json'));
    step(15, 'the verdict reaches STATE.json while the task records themselves do NOT',
      'reconciliation.status DRIFT, and no task title in the durable projection',
      `status=${st.reconciliation && st.reconciliation.status} leaked=${/a task no requirement tracks/.test(JSON.stringify(st))}`,
      st.reconciliation && st.reconciliation.status === 'DRIFT' && !/a task no requirement tracks/.test(JSON.stringify(st)));

    fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2));
    fs.rmSync(path.join(dir, 'tasks.json'));
  }

  // 16. ATOMIC-WRITE CONTENTION, THROUGH THE INSTALLED KERNEL — DETERMINISTICALLY SYNCHRONIZED ---------
  /*
   * ⛔ THIS STEP HAS NOW SHIPPED TWO DIFFERENT HARNESS DEFECTS, AND BOTH CORRECTIONS ARE KEPT IN VIEW.
   *
   * FIRST (P1-3): it was not concurrent at all — `spawnSync` inside `payloads.map()` let child 0 consume
   * the whole window and printed `writes=1445,0,0,0,0` under a green predicate. Third occurrence of that
   * exact mistake in this repository. The non-vacuity rule it earned — every writer must land >=1
   * replacement — is preserved below.
   *
   * SECOND (the b2b1d0b audit): the rewrite was concurrent but only TIMING-SYNCHRONIZED. An independent
   * audit ran the smoke three times at unchanged b2b1d0b and got one step-16 FAIL (194 valid reads, zero
   * read failures, every writer landed, `distinctPayloadsSeen=1`) then two passes. Two defects:
   *   · a shared future timestamp was the only rendezvous — nothing proved any reader was active before
   *     or during writer activity, and the seeded initial file was WRITER 0'S OWN payload, so "saw p0"
   *     could not distinguish the pre-write file from writer activity;
   *   · the parent aggregated `Math.max(reader.distinct)` over per-reader COUNTS — two readers each
   *     seeing one different payload scored 1, and the union was not computable because identities were
   *     never reported.
   *
   * NOW: an explicit synchronization protocol, judged by ops/_smoke16-gate.mjs (one gate, shared with
   * the kernel/concurrency.test.mjs control fixture so the verdict cannot fork):
   *   1. the target is seeded with a SENTINEL payload distinct from every writer payload;
   *   2. every writer signals READY and BLOCKS on stdin for GO;
   *   3. every reader reads the target, CONFIRMS it is the sentinel, signals READY, and keeps reading;
   *   4. only when every child is READY does the parent broadcast GO to all writers at once — a
   *      broadcast, not a per-child round trip, so release does not serialise the children;
   *   5. each reader stays active until its first non-sentinel observation or a bounded hard deadline;
   *   6. readers report the HASHES they observed and the parent takes the cross-reader UNION.
   * Readers therefore run before AND during writer activity BY CONSTRUCTION. Every protocol breach is a
   * loud failure — a child that never signals READY, a GO that never arrives, a first read that is not
   * the sentinel, and an observation deadline that expires all fail with distinct exit codes and named
   * reasons. Nothing here retries until green, and the union requirement (sentinel AND >=1 writer
   * payload, every member a known complete payload) is strictly stronger than the old `distinct >= 2`.
   */
  {
    const stateJs = path.join(dir, '.claude', 'respawnpack', 'lib', 'state.js');
    const artifactJs = path.join(dir, '.claude', 'hooks', '_artifact.js');
    const cdir = path.join(dir, '.respawnpack', 'contention');
    const target = path.join(cdir, 'STATE.json');
    fs.mkdirSync(cdir, { recursive: true });
    const WRITERS = 5, READERS = 2, WINDOW_MS = 1500;
    const READY_DEADLINE_MS = 20000, RELEASE_WAIT_MS = 20000, OBSERVE_DEADLINE_MS = 30000, CLOSE_DEADLINE_MS = 45000;
    const J2 = JSON.stringify;

    const payloads = Array.from({ length: WRITERS }, (_, i) => JSON.stringify({ writer: i, filler: String(i).repeat(200000) }));
    payloads.forEach((p, i) => fs.writeFileSync(path.join(cdir, `p${i}.bin`), p));
    const SENTINEL = JSON.stringify({ writer: 'sentinel', filler: 'seeded-before-any-writer-'.repeat(8000) });
    fs.writeFileSync(target, SENTINEL);
    const sentinelHash = sha256Hex(SENTINEL);
    const writerHashes = payloads.map((p) => sha256Hex(p));

    const writerSrc = (i) =>
      `const st=require(${J2(stateJs)});const p=require("fs").readFileSync(${J2(path.join(cdir, `p${i}.bin`))},"utf8");`
      + 'process.stdout.write("READY\\n");'
      + `const t=setTimeout(()=>{process.stderr.write("never released: no GO within ${RELEASE_WAIT_MS}ms");process.exit(3);},${RELEASE_WAIT_MS});`
      + 'let released=false;let buf="";'
      + 'function run(){'
      + `const end=Date.now()+${WINDOW_MS};let n=0;const refused=[];`
      + `while(Date.now()<end){try{st.writeAtomic(${J2(target)},p);n++;}catch(e){refused.push(e.code||"UNKNOWN");}}`
      + 'process.stdout.write("\\n"+JSON.stringify({kind:"w",n,refused}));process.exit(0);}'
      + 'process.stdin.on("data",(d)=>{buf+=d;if(!released&&buf.includes("GO")){released=true;clearTimeout(t);run();}});'
      + 'process.stdin.on("end",()=>{if(!released){process.stderr.write("stdin closed before GO");process.exit(3);}});';

    const readerSrc = () =>
      `const a=require(${J2(artifactJs)});const crypto=require("crypto");`
      + 'const sha=(t)=>crypto.createHash("sha256").update(t).digest("hex");'
      + 'const pause=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);'
      + `const first=a.readTextClassified(${J2(target)});`
      + 'if(first.status!=="OK"){process.stderr.write("first read was "+first.status+", not OK");process.exit(4);}'
      + `if(sha(first.text)!==${J2(sentinelHash)}){process.stderr.write("first read is not the sentinel — writers released early or the seed is wrong");process.exit(4);}`
      + 'process.stdout.write("READY\\n");'
      + `let reads=1;const bad=[];const seen=new Set([${J2(sentinelHash)}]);let sawWriter=false;`
      + `const deadline=Date.now()+${OBSERVE_DEADLINE_MS};`
      + `while(Date.now()<deadline){const r=a.readTextClassified(${J2(target)});`
      + `if(r.status==="OK"){reads++;const h=sha(r.text);seen.add(h);if(h!==${J2(sentinelHash)}){sawWriter=true;break;}}else{bad.push(r.status);}pause();}`
      + `if(!sawWriter){process.stderr.write("no writer payload observed within ${OBSERVE_DEADLINE_MS}ms of confirming the sentinel");process.exit(5);}`
      + 'process.stdout.write("\\n"+JSON.stringify({kind:"r",reads,bad,hashes:[...seen],sentinelConfirmed:true,sawWriterPayload:true}));process.exit(0);';

    const launchStaged = (src, withStdin) => {
      const child = spawn(process.execPath, ['-e', src], { stdio: [withStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const h = { child, out: '', err: '', code: null };
      h.ready = new Promise((resolve) => child.stdout.on('data', (d) => { h.out += d; if (h.out.includes('READY')) resolve(true); }));
      child.stderr.on('data', (d) => { h.err += d; });
      h.closed = new Promise((resolve) => child.on('close', (code) => { h.code = code; resolve(code); }));
      return h;
    };
    const afterOrLabel = (p, ms, label) => Promise.race([
      p.then(() => null),
      new Promise((resolve) => { const t = setTimeout(() => resolve(label), ms); if (t.unref) t.unref(); }),
    ]);

    const writers = payloads.map((_, i) => launchStaged(writerSrc(i), true));
    const readers = Array.from({ length: READERS }, () => launchStaged(readerSrc(), false));
    const all = [...writers, ...readers];

    let protocolFailure = null;
    const readyTimedOut = await afterOrLabel(Promise.all(all.map((h) => h.ready)), READY_DEADLINE_MS, 'READY');
    if (readyTimedOut) {
      protocolFailure = `a child never signalled READY within ${READY_DEADLINE_MS}ms — `
        + all.map((h, i) => `${i < WRITERS ? `w${i}` : `r${i - WRITERS}`}=${h.out.includes('READY') ? 'ready' : 'NOT-READY'}`).join(' ');
    } else {
      // Readiness holds: writers loaded and blocked, readers sentinel-confirmed and actively reading.
      for (const wr of writers) { try { wr.child.stdin.write('GO\n'); wr.child.stdin.end(); } catch { /* the exit code will say */ } }
      const closeTimedOut = await afterOrLabel(Promise.all(all.map((h) => h.closed)), CLOSE_DEADLINE_MS, 'CLOSE');
      if (closeTimedOut) protocolFailure = `a child never exited within ${CLOSE_DEADLINE_MS}ms of release`;
    }
    if (protocolFailure) for (const h of all) { try { h.child.kill(); } catch { /* already gone */ } }
    await Promise.all(all.map((h) => h.closed));

    const parseReport = (h) => { try { return JSON.parse(h.out.trim().split(/\r?\n/).pop()); } catch { return null; } };
    const w = writers.map(parseReport);
    const rd = readers.map(parseReport);
    const finalText = fs.readFileSync(target, 'utf8');
    const temps = fs.readdirSync(cdir).filter((f) => f.endsWith('.tmp')).length;

    const verdict = evaluateStep16({
      exits: all.map((h) => h.code),
      writers: w,
      readers: rd,
      sentinelHash,
      writerHashes,
      finalHash: sha256Hex(finalText),
      temps,
    });
    const wrote = w.map((x) => (x ? x.n : -1));
    const refusals = w.flatMap((x) => (x ? x.refused : ['CHILD_DIED']));
    const reads = rd.reduce((a, x) => a + (x ? x.reads : 0), 0);
    const readFailures = rd.flatMap((x) => (x ? x.bad : ['CHILD_DIED']));
    const firstErr = all.map((h) => h.err.trim()).filter(Boolean)[0] || '';

    step(16, 'the INSTALLED kernel under REAL concurrent replacement: sentinel-confirmed readers watch writer activity',
      `every child READY; readers confirm the SENTINEL before release; all ${WRITERS} writers land >=1 replacement; `
      + 'the cross-reader UNION of observed payloads contains the sentinel AND >=1 writer payload, every member a known '
      + 'complete payload; the pack reader never reports ABSENT/UNREADABLE; the survivor is one complete writer payload; '
      + 'no temporary survives',
      (protocolFailure ? `⛔ ${protocolFailure} · ` : '')
      + `exits=${all.map((h) => h.code).join(',')} writes=${wrote.join(',')} writerRefusals=${refusals.length}`
      + `${refusals.length ? `[${[...new Set(refusals)].join(',')}]` : ''} reads=${reads} readFailures=${readFailures.length}`
      + `${readFailures.length ? `[${[...new Set(readFailures)].join(',')}]` : ''} distinctPayloadsSeen=${verdict.distinctObserved} `
      + `unionHasSentinel=${verdict.union.has(sentinelHash)} unionWriterPayloads=${[...verdict.union].filter((x) => writerHashes.includes(x)).length} `
      + `survivorComplete=${writerHashes.includes(sha256Hex(finalText))} temps=${temps}`
      + (verdict.pass ? '' : ` · gate: ${verdict.failures.join(' · ')}`)
      + (firstErr && !verdict.pass ? ` · firstChildStderr: ${firstErr.slice(0, 140)}` : ''),
      !protocolFailure && verdict.pass);
    fs.rmSync(cdir, { recursive: true, force: true });
  }

  uninstallLast();

  // 17. LIVE DOCKER — CHECKED ONCE, CONDITIONAL, NON-BLOCKING -------------------------------------------
  /*
   * ⛔ mcp-reaper's live-daemon behaviour has been CANNOT_DETERMINE for seven consecutive rounds and is
   * recorded as such rather than assumed. This checks ONCE whether a real daemon is reachable. If it is,
   * the live verification runs against uniquely labelled disposable containers and cleans up only those.
   * If it is not, the attempt is recorded once and nothing else happens: no install, no service start, no
   * retry loop, and no effect on the release-ready result.
   */
  let dockerResult = 'CANNOT_DETERMINE';
  {
    /*
     * ⛔ AND A PROFILE THAT NEVER WIRES THE REAPER HAS NOTHING TO PROVE ABOUT IT. `mcp-reaper` is `off` in
     * ADR-003's `light` column, so `install/_settings-manifest.js` omits its entries entirely and no
     * session on such a target ever invokes it. Sweeping with the PACK's copy anyway would be a green row
     * about a script this installation does not run, which is the vacuous pass this step's own history
     * warns about. Derived from the composed set observed on the target, never from the profile's name.
     */
    const reaperWired = (footprint.hooks || []).includes('mcp-reaper.js');
    const probe = reaperWired
      ? spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20000 })
      : { status: 1, stdout: '', stderr: '' };
    const reachable = probe.status === 0 && String(probe.stdout).trim().length > 0;
    if (!reaperWired) {
      dockerResult = 'NOT_APPLICABLE';
      log(`\n---- live Docker ----\nNOT_APPLICABLE — the composed set for \`${profile}\` wires no mcp-reaper entry (ADR-003 reads \`off\` for it in`
        + '\nthis column), so no session on this target ever runs the reaper and there is no live-daemon behaviour'
        + '\nof THIS INSTALLATION to verify. Not probed, not installed, not started.');
    } else if (!reachable) {
      const why = probe.error && probe.error.code === 'ENOENT'
        ? 'the docker client is not on PATH'
        : `the docker client is present but no daemon answered (${String(probe.stderr || probe.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 120)})`;
      log(`\n---- live Docker ----\nCANNOT_DETERMINE — ${why}.\nChecked once. Not installed, not started, not retried. This does NOT block release readiness, and\nnothing about live-daemon mcp-reaper behaviour is claimed.`);
    } else {
      const label = `respawnpack-release-smoke-${process.pid}`;
      const made = [];
      try {
        const c = spawnSync('docker', ['run', '-d', '--label', `respawnpack.smoke=${label}`, '--label', 'respawnpack.keep=true',
          '--name', `${label}-keep`, 'busybox', 'sleep', '600'], { encoding: 'utf8', timeout: 180000 });
        if (c.status !== 0) {
          log(`\n---- live Docker ----\nCANNOT_DETERMINE — a daemon answered but the disposable container could not be created (${String(c.stderr).replace(/\s+/g, ' ').slice(0, 140)}).`);
        } else {
          made.push(`${label}-keep`);
          const reaper = spawnSync(process.execPath, [path.join(PACK, 'hooks', 'mcp-reaper.js'), '--reap', 'all', 'release-smoke-session'],
            { encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
          const alive = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', `${label}-keep`], { encoding: 'utf8', timeout: 60000 });
          const survived = String(alive.stdout).trim() === 'true';
          dockerResult = survived ? 'PASS' : 'FAIL';
          step(17, 'LIVE DOCKER: a keep=true container survives the reaper sweep against a real daemon',
            'the labelled container is still running after the sweep',
            `reaper exit ${reaper.status}, container running=${String(alive.stdout).trim()}`, survived);
        }
      } catch (e) {
        log(`\n---- live Docker ----\nCANNOT_DETERMINE — the live check threw: ${String(e.message).slice(0, 140)}`);
      } finally {
        for (const name of made) {
          spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 120000 });
        }
        if (made.length) log(`live Docker: cleaned up ${made.length} disposable container(s) created by this run, and nothing else.`);
      }
    }
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ }
  return { profile, footprint, rows: profileRows.slice(), dockerResult };
}

// --- run the selected profiles, then judge ------------------------------------------------------------
const results = [];
for (const profile of selection.profiles) results.push(await runProfile(profile));

/*
 * ⛔ VERDICT 1 — DID EACH PROFILE REPRODUCE THE PINNED LIFECYCLE. `strict` must show every pinned row
 * passing, in order, and may decline nothing; any other profile may decline a row only by saying, in the
 * report, which subsystem this installation does not carry. A row that is missing, out of order, failed,
 * or skipped without a reason is a build-blocking failure and is counted as one, so the exit code below
 * still derives from `failures` and from nothing else.
 */
log('\n---- verdict: reproduction of the pinned lifecycle ----');
for (const r of results) {
  const v = evaluateReproduction({ profile: r.profile, observed: r.rows });
  log(`${v.outcome === 'PASS' ? 'ok  ' : (v.outcome === 'FAIL' ? 'FAIL' : 'c/d ')} \`${r.profile}\`: `
    + `${v.passed.length} of ${BASELINE_STEPS.length} pinned row(s) passed`
    + `${v.notApplicable.length ? `, ${v.notApplicable.length} declared NOT_APPLICABLE` : ''}`
    + `${v.undetermined.length ? `, ${v.undetermined.length} undetermined` : ''}`
    + `${v.extra.length ? `, ${v.extra.length} row(s) beyond the pinned capture` : ''}`);
  for (const d of v.notApplicable) log(`       n/a  ${d.label}\n            because: ${d.reason}`);
  for (const u of v.undetermined) log(`       c/d  ${u.label}\n            because: ${u.reason}`);
  for (const f of v.failures) log(`       ⛔ ${f}`);
  if (v.outcome === 'FAIL') failures += v.failures.length;
}

/*
 * ⛔ VERDICT 2 — DID THE PROFILES DIFFER IN THE DIRECTION ADR-003 CLAIMS, AND DID NONE OF THEM UN-WIRE A
 * GUARD. The first half is what stops a "light" profile from passing by doing nothing at all; the second
 * is the one that matters, and it is derived from `hooks/_posture.js`'s own fixed-id set rather than from
 * a list here, so a rule that moves columns moves this check with it.
 */
log('\n---- verdict: composed hook set and placed footprint, per profile ----');
const snippetShape = (() => {
  try {
    const snippet = JSON.parse(fs.readFileSync(path.join(PACK, 'hooks', 'settings.snippet.json'), 'utf8'));
    delete snippet['//'];
    return require_(path.join(PACK, 'install', '_settings-manifest.js')).shapeOf(snippet);
  } catch { return { entries: NaN, groups: NaN }; }
})();
for (const r of results) {
  const f = r.footprint;
  log(`     \`${r.profile}\` (${f.source}): composed ${f.entries} entr(ies) in ${f.groups} group(s) across ${f.hooks.length} hook(s); `
    + `placed ${f.created} file(s) reported, ${f.claudeFiles} under .claude/, kernel ${f.kernelPlaced} of ${f.kernelTotal}`);
  log(`       wired:   ${f.hooks.join(' ') || 'NONE'}`);
  log(`       omitted: ${f.omittedByProfile.join(' · ') || 'nothing'}`);
}
{
  const v = evaluateFootprint(results.map((r) => r.footprint), { snippetEntries: snippetShape.entries });
  for (const c of v.compared) log(`ok   ${c}`);
  for (const f of v.failures) log(`FAIL ${f}`);
  if (!v.compared.length && results.length < 2) {
    log('c/d  only one profile ran, so the strict-versus-light comparison could not be made. '
      + 'Run with no --profile to make it.');
  }
  if (!v.pass) failures += v.failures.length;
}

// --- derived result ---------------------------------------------------------------------------------
log(`\n---- result ----`);
log(`${ran} step(s) ran · ${failures} failed · ${skipped} skipped · ${declined} not applicable`
  + ` · profile(s): ${results.map((r) => `${r.profile} (live Docker: ${r.dockerResult})`).join(' · ')}`);
log(failures ? 'RELEASE SMOKE FAILED' : 'RELEASE SMOKE PASSED');
if (outFile) fs.writeFileSync(outFile, `${OUT.join('\n')}\n`);
process.exit(failures ? 1 : 0);
