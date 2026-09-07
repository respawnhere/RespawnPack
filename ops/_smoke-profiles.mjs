/*
 * RespawnPack · ops/_smoke-profiles.mjs — the release smoke's PROFILE verdicts, as an importable module.
 *
 * ⛔ WHY A MODULE AND NOT INLINE PREDICATES, THE SAME REASON `ops/_smoke16-gate.mjs` IS ONE. A verdict
 * that lives only inside a run nobody can call cannot be tested in its failing states, and a smoke that
 * takes minutes per profile is not a thing anyone re-runs to find out what its predicate does on a
 * malformed input. So the three questions this task added — "did strict reproduce the pinned lifecycle",
 * "did light decline anything without saying why", "is the profile name even one we know" — are objects
 * computed here, consumed by `ops/release-smoke.mjs` at run time and driven through their failing states
 * by `ops/release-smoke.test.mjs` in milliseconds. One gate, two callers, no second copy to drift.
 *
 * ⛔ THE PINNED CAPTURE IS EVIDENCE, NOT AN INTENTION. `BASELINE_STEPS` below is the step list of a real
 * `node ops/release-smoke.mjs` run on the unmodified tree at cb30211, transcribed from its own `--out`
 * report rather than typed from the source. It is what "strict reproduces today's output" MEANS: every
 * one of those rows still runs, in that order, and still passes. Regenerate it only from another clean
 * capture, and say in the commit which run it came from.
 *
 * ⛔ AND A DECLINED STEP IS A FOURTH OUTCOME, NEVER AN ABSENCE. Under a profile that does not install a
 * subsystem, the rows that exercise it are NOT_APPLICABLE WITH A REASON — the same vocabulary
 * `kernel/lib/outcome.js` uses, carrying the same meaning. A row that merely stopped appearing would be
 * indistinguishable from a row somebody deleted, which is the oldest defect in this repository.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PACK = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require_ = createRequire(import.meta.url);

const posture = require_(path.join(PACK, 'hooks', '_posture.js'));
const manifest = require_(path.join(PACK, 'install', '_settings-manifest.js'));

/**
 * ⭐ THE PROFILE NAMES COME FROM THE RESOLVER, NEVER FROM A LIST HERE. `hooks/_posture.js` is the one
 * reader of a project's posture (ADR-003), so it is also the one authority on which names exist. A
 * fourth profile added there is runnable here the same day, and a name this file invented would be a
 * second declaration of the set.
 */
export const KNOWN_PROFILES = posture.PROFILES.slice();

/**
 * ⛔ WHAT `node ops/release-smoke.mjs` RUNS WITH NO FLAG, AND WHY IT IS BOTH RATHER THAN ONE.
 *
 * `strict` is the freeze: it is what an existing target with no `posture` key composes, so it is the
 * column whose lifecycle must not move. `light` is the column that actually withholds something, so it
 * is the only one that can prove a withheld subsystem degrades honestly instead of crashing. Running
 * one without the other proves half the claim, and the half it proves is the one nobody doubted.
 *
 * `standard` is runnable by name (`--profile standard`) and is not in the default pair: it composes the
 * same registration set and the same kernel placement as `strict` today, so a third full lifecycle would
 * cost the wall time of the two above and re-prove one of them.
 */
export const DEFAULT_PROFILES = ['strict', 'light'];

/**
 * ⛔ EVERY HOOK CARRYING AT LEAST ONE FIXED RULE ID, DERIVED IN BOTH DIRECTIONS FROM THE TWO TABLES THAT
 * ALREADY DECLARE IT. `hooks/_posture.js` names the ids nothing may switch off (anti-drift items 18-29);
 * `install/_settings-manifest.js` names which hook carries which id. A hook in the intersection must be
 * wired in EVERY composed set, and that is asserted per profile below — the check that stops a posture
 * from quietly becoming a way to un-wire a security guard. Nothing here is hand-listed, so moving a row
 * in ADR-003's table moves this fence with it.
 */
export const FIXED_HOOK_FILES = (() => {
  const fixed = new Set(posture.FIXED_IDS);
  return Object.entries(manifest.RULES_BY_HOOK)
    .filter(([, ids]) => ids.some((id) => fixed.has(id)))
    .map(([file]) => file)
    .sort();
})();

/**
 * The lifecycle rows a clean `strict` run emits, in emission order, captured from the unmodified tree at
 * cb30211. Step 13 trails steps 14-16 because `uninstallLast()` is deliberately deferred to the end of
 * the target's life; that ordering is part of what is pinned.
 */
export const BASELINE_STEPS = [
  { n: 1, label: 'default install completes on a fresh target' },
  { n: 1, label: 'the installer does NOT install the optional memory engine by default' },
  { n: 2, label: 'doctor runs on a fresh install and reports no BROKEN component' },
  { n: 2, label: 'doctor reports the DF-005 reconciliation state on a project that has not configured it' },
  { n: 2, label: 'doctor names onboarding as INCOMPLETE on a fresh install, and names what is undecided' },
  { n: 2, label: 'and that unfinished onboarding is NOT rounded down to green' },
  { n: 3, label: 'state compiles and recomputes its counts from rows' },
  { n: 4, label: 'savepoint runs the full verification battery and reports each check' },
  { n: 4, label: 'an unconfigured removal contract and reconciliation are CANNOT_DETERMINE, never a quiet pass' },
  { n: 5, label: 'quality gate on a CONFIGURED PASSING project' },
  { n: 5, label: 'quality gate on a DETECTED BUT UNCONFIGURED project' },
  { n: 5, label: 'quality gate on a DECLARED NOT-APPLICABLE project' },
  { n: 5, label: 'the gate verdict artifact conforms to its declared schema' },
  { n: 6, label: 'the collaborate contract is the default and can be entered explicitly' },
  { n: 7, label: 'delegate opens with derived acceptance criteria and refuses without them' },
  { n: 7, label: 'a PARTIAL attestation is refused and names what was not attested' },
  { n: 7, label: 'a FULL attestation closes the delegation and archives it as a claim, not a proof' },
  { n: 8, label: 'goal mode requires a stated goal AND stated completion criteria' },
  { n: 8, label: 'a goal with no completion criteria is REFUSED, never inferred' },
  { n: 8, label: 'collaborate SUSPENDS the goal rather than destroying it' },
  { n: 8, label: 'the suspended goal resumes with its contract intact' },
  { n: 8, label: 'goal completion REFUSES on an unmet stated criterion' },
  { n: 9, label: 'file-backed memory is ACTIVE with no setup, and the engine is reported as not installed' },
  { n: 10, label: '--with-memory installs the engine and completes a REAL MCP handshake plus a write/read round trip' },
  { n: 10, label: 'the engine is registered against an ABSOLUTE node path, with no global rmem and no PATH mutation' },
  { n: 11, label: 'a canary skill can be enabled, freezing its baseline' },
  { n: 11, label: '.skill-meta.json conforms to its declared schema' },
  { n: 11, label: 'regenerate evaluates a real keyed entity and reports its overlay budget' },
  { n: 11, label: 'status reports the canary as living against its frozen base' },
  { n: 11, label: 'reset restores the baseline without deleting the founder archive' },
  { n: 11, label: 'a NON-canary skill is refused — living behaviour is opt-in for three skills and nothing else' },
  { n: 12, label: 'upgrade preserves founder-authored skills and memory' },
  { n: 12, label: 'upgrade ARCHIVES the living overlay rather than silently discarding it' },
  { n: 12, label: '`living status` REPORTS the loss instead of showing a clean PASS' },
  { n: 14, label: 'every artifact this installed target generated conforms to its DECLARED schema' },
  { n: 14, label: 'an invented interaction mode in a gitignored file NEVER grants autonomy' },
  { n: 14, label: 'evidence at an UNKNOWN schemaVersion is rejected WITH its reason recorded, and moves no count' },
  { n: 15, label: 'DF-005 reconciliation runs on an installed target and finds drift in BOTH directions' },
  { n: 15, label: 'doctor reports the reconciliation as ACTIVE — a configured check reporting drift is not a broken check' },
  { n: 15, label: 'the verdict reaches STATE.json while the task records themselves do NOT' },
  { n: 16, label: 'the INSTALLED kernel under REAL concurrent replacement: sentinel-confirmed readers watch writer activity' },
  { n: 13, label: 'uninstall removes what the pack owns and NOTHING the founder authored' },
  { n: 13, label: 'uninstall REPORTS the lifecycle artifacts it preserves rather than leaving them unnamed' },
];

/**
 * Read the profiles a run was asked for out of its argv.
 *
 * ⛔ AN UNKNOWN NAME IS REFUSED BEFORE ANY STEP RUNS, AND IT IS `CANNOT_DETERMINE`, NOT `FAIL`. The
 * caller cannot report a lifecycle it never ran, and "could not run" has its own exit code everywhere
 * else in this pack (anti-drift item 2). Returning `{error}` rather than throwing keeps the decision
 * with the caller, which is what owns the exit map.
 *
 * `--profile` repeats (`--profile strict --profile light`) and accepts a comma list; duplicates collapse
 * in first-seen order so `--profile light --profile light` runs one lifecycle, not two identical ones.
 *
 * @param {string[]} argv typically `process.argv.slice(2)`
 * @returns {{profiles: string[], error: string|null, explicit: boolean}}
 */
export function parseProfiles(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const asked = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--profile') continue;
    const raw = args[i + 1];
    if (raw === undefined || raw.startsWith('--')) {
      return { profiles: [], explicit: true, error: '`--profile` was given with no value. Name one of: ' + KNOWN_PROFILES.join(', ') };
    }
    i += 1;
    for (const piece of raw.split(',')) {
      const name = piece.trim();
      if (!name) {
        return { profiles: [], explicit: true, error: `\`--profile ${raw}\` contains an empty name. Name one of: ${KNOWN_PROFILES.join(', ')}` };
      }
      if (!KNOWN_PROFILES.includes(name)) {
        return {
          profiles: [],
          explicit: true,
          error: `\`--profile ${name}\` is not a posture this pack has. The only postures are ${KNOWN_PROFILES.join(', ')} `
            + '(hooks/_posture.js PROFILES, ADR-003). Refused before any step ran, so nothing was installed and no result is implied.',
        };
      }
      if (!asked.includes(name)) asked.push(name);
    }
  }
  if (!asked.length) return { profiles: DEFAULT_PROFILES.slice(), explicit: false, error: null };
  return { profiles: asked, explicit: true, error: null };
}

/**
 * Did this profile's run reproduce the pinned lifecycle?
 *
 * PASS requires every baseline row to appear, in baseline order, and to be either a pass or an explicit
 * NOT_APPLICABLE carrying a reason. `strict` additionally may decline NOTHING: it is defined as the
 * column that behaves exactly as 0.3.0 did, so a NOT_APPLICABLE there is a regression wearing a
 * profile's name.
 *
 * ⛔ AND THIS VERDICT HAS THREE STATES, NOT TWO, FOR THE SAME REASON EVERY OTHER ONE IN THIS PACK DOES.
 * The smoke already reports a row it could not run at all — step 10 on a host with no npm — as a SKIP
 * carrying its reason, and that host has not failed to reproduce the lifecycle; it has not established
 * whether it did. So a pinned row that was skipped WITH a reason yields CANNOT_DETERMINE, a skip with no
 * reason is a FAILURE (a silent skip is the oldest defect here), and only a genuine miss, a wrong
 * outcome or an out-of-order row is FAIL.
 *
 * @param {{profile: string, observed: Array<{label: string, outcome: string, reason?: string}>, baseline?: Array<{label: string}>}} args
 * @returns {{outcome: string, pass: boolean, profile: string, failures: string[], passed: string[], notApplicable: Array<{label: string, reason: string}>, undetermined: Array<{label: string, reason: string}>, extra: string[]}}
 */
export function evaluateReproduction({ profile, observed, baseline = BASELINE_STEPS }) {
  const failures = [];
  const rows = Array.isArray(observed) ? observed : [];
  const labels = rows.map((r) => String((r && r.label) || ''));
  const expected = (Array.isArray(baseline) ? baseline : []).map((b) => String((b && b.label) || ''));

  const passed = [];
  const notApplicable = [];
  const undetermined = [];
  let cursor = 0;
  for (const label of expected) {
    const at = labels.indexOf(label, cursor);
    if (at < 0) {
      failures.push(labels.includes(label)
        ? `out of order (the pinned capture runs it earlier): ${label}`
        : `never ran: ${label}`);
      continue;
    }
    cursor = at + 1;
    const row = rows[at] || {};
    const reason = String(row.reason || '').trim();
    if (row.outcome === 'PASS') { passed.push(label); continue; }
    if (row.outcome === 'NOT_APPLICABLE') {
      if (!reason) failures.push(`NOT_APPLICABLE with no reason given, which is a silent skip: ${label}`);
      else if (profile === 'strict') failures.push(`strict declined a pinned step, which it may never do: ${label} (${reason})`);
      else notApplicable.push({ label, reason });
      continue;
    }
    if (row.outcome === 'SKIPPED') {
      if (!reason) failures.push(`skipped with no reason given: ${label}`);
      else undetermined.push({ label, reason });
      continue;
    }
    failures.push(`${row.outcome || 'NO OUTCOME'}: ${label}`);
  }

  const known = new Set(expected);
  const extra = labels.filter((l) => !known.has(l));
  const outcome = failures.length ? 'FAIL' : (undetermined.length ? 'CANNOT_DETERMINE' : 'PASS');
  return { outcome, pass: outcome === 'PASS', profile, failures, passed, notApplicable, undetermined, extra };
}

/**
 * Cross-profile footprint: what each profile composed and placed, and whether the relationship between
 * them is the one ADR-003 claims.
 *
 * ⛔ THREE CLAIMS, AND THE FIRST IS THE ONE THAT MATTERS. (1) Every hook carrying a FIXED rule id is
 * wired in every composed set — a profile is a way to spend fewer processes, never a way to un-wire a
 * guard; a hook a `dispatch.js --covers` registration runs in-process counts as wired (P4-T-15b). (2)
 * `strict` composes the whole snippet, which is the observable half of the freeze. (3) Where both are
 * present, `light` composes fewer registrations and places fewer kernel files than `strict` — a "light"
 * install that withheld nothing would mean the profile did nothing at all, which is the vacuous pass
 * this task's own risk note names. The raw file counts (`claudeFiles`, `created`) are reported beside
 * them but not required to shrink: light withholds `lib/reconcile.js` and places `hooks/dispatch.js`,
 * so the two can tie, and a tie there says nothing about whether the profile did its work.
 *
 * A measure that could not be observed (a report field left null because the installer's summary did not
 * parse) is a FAILURE here, never a zero: a count that cannot be read is not a count.
 *
 * @param {Array<{profile: string, entries: number|null, groups: number|null, hooks: string[], created: number|null, claudeFiles: number|null, kernelPlaced: number|null, kernelTotal: number|null}>} reports
 * @param {{snippetEntries: number}} snippet the strict column's own shape, from install/_settings-manifest.js
 * @returns {{pass: boolean, failures: string[], compared: string[]}}
 */
export function evaluateFootprint(reports, { snippetEntries } = {}) {
  const failures = [];
  const rows = Array.isArray(reports) ? reports : [];
  if (!rows.length) failures.push('no profile reported a footprint at all');

  const NUMERIC = ['entries', 'groups', 'created', 'claudeFiles', 'kernelPlaced'];
  for (const r of rows) {
    for (const key of NUMERIC) {
      if (!Number.isFinite(r[key])) failures.push(`${r.profile}: \`${key}\` was not observed, so it is unknown rather than zero`);
    }
    const wired = new Set(r.hooks || []);
    const missing = FIXED_HOOK_FILES.filter((h) => !wired.has(h));
    if (missing.length) failures.push(`${r.profile}: composed set omits a hook carrying a FIXED rule id: ${missing.join(', ')}`);
  }

  const strict = rows.find((r) => r.profile === 'strict');
  const light = rows.find((r) => r.profile === 'light');
  if (strict && Number.isFinite(snippetEntries) && strict.entries !== snippetEntries) {
    failures.push(`strict composed ${strict.entries} entr(ies) but hooks/settings.snippet.json declares ${snippetEntries} — strict IS the snippet`);
  }

  const compared = [];
  if (strict && light) {
    // A comparison goes into `compared` only when it HELD. The caller prints that list as `ok` lines, and
    // a line reading "strict 22 > light 22" beside its own failure would be a report arguing with itself.
    for (const key of ['entries', 'kernelPlaced']) {
      if (!Number.isFinite(strict[key]) || !Number.isFinite(light[key])) continue;
      if (light[key] >= strict[key]) {
        failures.push(`light did not shrink \`${key}\`: strict ${strict[key]}, light ${light[key]} — a profile that withholds nothing passed vacuously`);
      } else compared.push(`${key}: strict ${strict[key]} > light ${light[key]}`);
    }
    // Reported, never required: light withholds one kernel file and places the dispatcher, so these
    // may tie or move either way without saying anything about the profile.
    for (const key of ['claudeFiles', 'created']) {
      if (!Number.isFinite(strict[key]) || !Number.isFinite(light[key])) continue;
      const rel = light[key] < strict[key] ? '>' : light[key] === strict[key] ? '=' : '<';
      compared.push(`${key}: strict ${strict[key]} ${rel} light ${light[key]} (reported, not required to shrink)`);
    }
  }
  return { pass: failures.length === 0, failures, compared };
}
