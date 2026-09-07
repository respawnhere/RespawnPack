/*
 * RespawnPack · kernel/lib/applicability.js — which optional contracts has this project DECIDED about?
 *
 * ⛔ THE FAILURE THIS EXISTS TO END. A Claude Code dogfood installed the pack into a fresh repository
 * and ran the loop end to end. The kernel was honest at every step: removals, reconcile and
 * requirements each reported CANNOT_DETERMINE because nothing had been declared, savepoint rolled that
 * up, and the run refused. Correct, and unusable. The operator could not tell a repository whose
 * machinery was BROKEN from one whose machinery was FINE and whose optional contracts nobody had been
 * asked about yet, because both produced the same flat CANNOT_DETERMINE. The two obvious repairs were
 * both defects: normalize CANNOT_DETERMINE into a healthy terminal state, or weaken the zero-work
 * checks until they went green. This module is the third answer — make the DECISION a first-class
 * inspectable object, so "nobody has decided yet" stops being indistinguishable from "this is broken".
 *
 * FOUR STATES, and the difference between the last two is the whole point:
 *   CONFIGURED      real sources are declared, so the check has a subject and runs
 *   NOT_APPLICABLE  the project DECLARED it has no subject here, and said why
 *   UNDECIDED       nobody has answered. NOT a pass, NOT a failure, and NOT inferable into either
 *   INVALID         an answer was attempted and cannot be used — a blank opt-out, a leftover installer
 *                   template, a malformed block. Kept distinct from UNDECIDED because somebody TRIED,
 *                   and telling them they never started is the wrong instruction to give them
 *
 * ⛔ NOT_APPLICABLE IS STILL ONLY EVER DECLARED. Nothing here infers it from an empty directory, an
 * absent file, or a project that merely looks small. That inference is the defect kernel/lib/gate.js,
 * kernel/lib/removals.js and kernel/lib/reconcile.js each independently exist to refuse, and
 * generalizing their vocabulary must not generalize a loophole into it. UNDECIDED is the honest answer
 * for absence, it is not green, and the only thing that moves it is a person answering.
 *
 * ⛔ AND THIS MODULE READS DECLARATIONS, IT DOES NOT RUN CHECKS. "Has anyone decided" and "does the
 * check hold" are different questions, and answering the first with the second is how a broken check
 * reads as an unconfigured project (kernel/lib/reconcile.js surveyReconciliation says the same thing
 * one subsystem down). Every resolver below is config-and-filesystem only: no scan, no adapter, no
 * subprocess. That is also why it is safe for doctor and for a SessionStart nudge to call it.
 */
const fs = require('fs');
const path = require('path');
const { OUTCOME, result } = require('./outcome.js');
const removalsLib = require('./removals.js');
const stateLib = require('./state.js');
const modhealth = require('./modhealth.js');
/*
 * ⛔ THE LAZY-LOAD BOUNDARY, AND IT MOVED BEFORE ANYTHING WAS UN-PLACED (P3-K-14).
 *
 * This was `require('./reconcile.js')`, and ADR-003's rule table reads `kernel:R4 reconcile → n.a., not
 * installed` under `light` — so the day the installer stopped placing that file, THIS require would have
 * thrown MODULE_NOT_FOUND out of the module doctor loads to describe the project, and a subsystem a
 * profile deliberately left out would have arrived as a stack trace instead of a row (anti-drift item
 * 17). Probed through `modhealth` instead: the same boundary `kernel/lib/state.js` already uses for the
 * same module, so absent, unparseable, throwing-at-load and loaded-without-`readConfigClassified` all
 * become one null and one honest row rather than four different crashes.
 *
 * ⛔ AND `null` HERE IS NOT AN ANSWER ABOUT THE PROJECT. It says the reader is unavailable, which is why
 * the reconcile row below asks the POSTURE whether that absence was chosen, and reports INVALID — not
 * UNDECIDED, and never NOT_APPLICABLE — when it was not. "Nobody decided" and "nothing here can read the
 * decision" are different facts, and this module exists because collapsing two of them is the bug.
 */
const RECONCILE_PATH = path.join(__dirname, 'reconcile.js');
const reconcileHealth = modhealth.probePath(RECONCILE_PATH);
const reconcileLib = reconcileHealth.module;

const APPLICABILITY = {
  CONFIGURED: 'CONFIGURED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNDECIDED: 'UNDECIDED',
  INVALID: 'INVALID',
};

/** The two states that mean somebody answered. Everything else blocks release readiness. */
const RESOLVED = new Set([APPLICABILITY.CONFIGURED, APPLICABILITY.NOT_APPLICABLE]);

/*
 * ⛔ THE POSTURE LAYER — IT CHANGES WHICH OUTCOME A ROW RETURNS, NEVER WHAT AN OUTCOME MEANS.
 *
 * ADR-003 (a development record) gives a project three postures declared in ONE
 * key of respawnpack.config.json, and its rule table says what each of the day-one kernel rows does
 * under each. Ten of the twenty-eight refusal points are relaxable at all; the other eighteen are the
 * anti-drift core or build-time fences, and `hooks/_posture.js` deliberately has NO KEY for them, so
 * they cannot be reached from here even by asking. The five ids below are the only ones this module
 * ever names, and none of them is in that fixed set.
 *
 * TWO MECHANISMS, AND NEITHER RENAMES AN OUTCOME:
 *
 *   (a) R1 routes, R2 codeTruth, R5 qualityGate — and R3/R4 under `standard`. The row is still
 *       surveyed, still printed, and its `state` stays exactly what it was (UNDECIDED: nobody decided,
 *       which remains true). What changes is the CHECK the row produces: `coverageChecks` returns PASS
 *       with `checked: 1` and `postureRelaxed: <profile>` instead of CANNOT_DETERMINE, and the original
 *       reason is still the first thing in `detail`. The declaration that was inspected is the posture
 *       itself, so `checked: 1` is a real subject and not the zero-work PASS outcome.js refuses.
 *
 *   (b) R3 removals and R4 reconcile under `light`. The row BECOMES NOT_APPLICABLE — the one state
 *       this module insists is only ever DECLARED — and it is legitimate here for exactly that reason:
 *       the founder declared a posture, in a tracked file, with a reason the diff carries. The detail
 *       is AUTHORED and names the posture, and it is applied ONLY where the absence needs no inference:
 *       no removals registry file at all, or the profile not carrying the reconciliation contract.
 *
 * ⛔ AND R3 IS MANDATORY IN EVERY POSTURE THE MOMENT A REGISTRY WITH ROWS EXISTS (anti-drift item 14).
 * A profile may make an UNCONFIGURED contract advisory; a CONFIGURED one that scanned nothing never
 * PASSes. Both halves are enforced by `removalsEligibility()` below, not by prose.
 *
 * ⛔ INVALID IS REFUSED IN EVERY POSTURE. `relax()` returns the row untouched unless its state is
 * UNDECIDED, so a blank opt-out, a leftover `<set ROUTE_SOURCE>` template or a half-declared reconcile
 * block stays INVALID and stays non-zero under `light` exactly as under `strict`. "Nobody answered" is
 * the only thing a posture may answer for; "somebody answered wrongly" is not.
 *
 * ⛔ AND NOTHING RELAXES UNLESS A POSTURE WAS DECLARED. `policyOf()` refuses DEFAULTED, UNREADABLE and
 * INVALID resolutions alike, so a project with no `posture` key behaves exactly as it does today, and a
 * config that could not be read never becomes the loosest policy. A target whose install predates
 * `hooks/_posture.js` passes no policy at all and lands in the same place.
 */
const POSTURE_ROWS = {
  routes: 'kernel:R1',
  codeTruth: 'kernel:R2',
  removals: 'kernel:R3',
  reconcile: 'kernel:R4',
  qualityGate: 'kernel:R5',
};

/** ADR-003's onboarding row. It governs whether a relaxed row counts as ANSWERED, nothing else. */
const POSTURE_ONBOARDING = 'kernel:R6';

/** The verdicts that relax. `deny` — and any id the resolver does not carry — leaves the row alone. */
const RELAXING = new Set(['off', 'advise']);

/**
 * The caller's resolved posture, or `null` when nothing may relax.
 *
 * The kernel resolves ONCE PER VERB and hands the result down; this module never reads the config for a
 * posture itself, because two readers of one policy is the failure `hooks/_contracts.js:23` was written
 * about and ADR-003 settles it with a single reader in `hooks/_posture.js`.
 */
function policyOf(posture) {
  if (!posture || typeof posture.verdict !== 'function') return null;
  if (posture.source !== 'DECLARED') return null;
  if (typeof posture.profile !== 'string' || !posture.profile) return null;
  return posture;
}

/*
 * ⛔ ONE DEFINITION OF "THIS ROW RELAXES", FOR THE ROWS THAT ARE NOT COVERAGE ROWS EITHER.
 *
 * ADR-003 gives the kernel ten relaxable rows. Six of them (R1–R6) are the coverage survey's, and
 * `relax()` below applies them. The other four are not: `kernel:R9` is the gate's no-build-system
 * verdict (kernel/lib/gate.js), `kernel:R15` is the NOTE budget row, `kernel:R16` is the unmigrated
 * derived doc and `kernel:R17` is an unknown `--candidate` klass — all three of those are built in
 * kernel/respawnpack.js. Each of them still has to answer the SAME two questions this module already
 * answers for its own rows: is this resolution one anything may relax on (DECLARED only), and is the
 * cell's verdict a relaxing one. Re-spelling `new Set(['off','advise'])` in a second file is exactly
 * how the two answers drift apart on the day one of them gains a third verdict, so the predicate is
 * exported from here — the module that owns the posture layer — and nothing else defines it.
 *
 * `n.a.` is deliberately NOT relaxing here. It is mechanism (b), which needs an AUTHORED reason and an
 * inference-free absence, and `relax()` is the only thing allowed to build that shape.
 */
function relaxes(posture, id) {
  const policy = policyOf(posture);
  return Boolean(policy) && RELAXING.has(policy.verdict(id));
}

/**
 * ONE SHAPE FOR "THE DECLARED POSTURE ANSWERED THIS ROW", written once and reached from both sites that
 * may build it: `relax()`'s mechanism (b), and the reconcile row when the subsystem the profile does not
 * install is genuinely not on disk (P3-K-14). Two hand-written copies of a NOT_APPLICABLE-by-posture row
 * is how one of them quietly stops carrying `postureRule`, and a relaxation nobody can attribute is the
 * thing this module refuses everywhere else.
 *
 * `basis: 'declared'` is the truthful word: what was declared is the POSTURE, in a tracked file, and
 * `detail` opens with the authored reason naming it.
 */
function answeredByPosture(row, policy, id, authored) {
  return {
    ...row,
    state: APPLICABILITY.NOT_APPLICABLE,
    basis: 'declared',
    detail: `${authored} (${row.detail})`,
    postureRelaxed: policy.profile,
    postureRule: id,
    postureDetail: `answered by the declared \`${policy.profile}\` posture (ADR-003 ${id})`,
  };
}

/**
 * Apply the declared posture to one surveyed row.
 *
 * @param {Object} row the row as the survey classified it
 * @param {Object|null} policy a `policyOf()` result
 * @param {{id:string, relaxable?:boolean, inferenceFree?:boolean, authored?:string}} opts
 */
function relax(row, policy, { id, relaxable = true, inferenceFree = false, authored = null }) {
  if (!policy || !relaxable) return row;
  // ⛔ UNDECIDED ONLY. INVALID means somebody tried and got it wrong, and no posture answers for that.
  if (row.state !== APPLICABILITY.UNDECIDED) return row;
  const verdict = policy.verdict(id);
  if (verdict === 'n.a.') {
    // Mechanism (b). Refused outright where the absence would have to be inferred.
    if (!inferenceFree || !authored) return row;
    return answeredByPosture(row, policy, id, authored);
  }
  if (!RELAXING.has(verdict)) return row;
  // Mechanism (a). The row's own state is untouched — it is still true that nobody decided.
  return {
    ...row,
    postureRelaxed: policy.profile,
    postureRule: id,
    postureDetail: `reported rather than refused: the declared \`${policy.profile}\` posture relaxes this row to an advisory (ADR-003 ${id})`,
  };
}

/*
 * ⛔ `<set ROUTE_SOURCE>` IS NOT CONFIGURATION, AND THE READER THAT BELIEVED IT WAS SILENTLY GREEN.
 *
 * The installer seeded `routeSource: "<set ROUTE_SOURCE>"` and
 * `codeTruth: "<set CODE_TRUTH: token/copy/schema source paths>"` as literal string VALUES. /savepoint
 * Step 3 enumerates ROUTE_SOURCE against FEATURES-PAGES.md §2; handed that literal it globs zero
 * routes, finds zero orphans in either direction, and reports no drift — DF-007's zero-match
 * confirmation, wearing a config key. The installer no longer writes them (install/install.js), and
 * this recognizes the ones already on disk in every target installed before it stopped, because a
 * founder-owned config is never rewritten underneath its owner.
 *
 * Deliberately narrow: `<set …>` is the shape the installer emitted, not a general "looks unfinished"
 * heuristic. A founder whose real route glob contains angle brackets is not silently overruled.
 */
const INSTALLER_TEMPLATE = /^<\s*set\b[^>]*>$/i;

const isTemplate = (v) => typeof v === 'string' && INSTALLER_TEMPLATE.test(v.trim());
const nonEmpty = (v) => typeof v === 'string' && Boolean(v.trim());
const exists = (dir, ...rel) => { try { return fs.existsSync(path.join(dir, ...rel)); } catch { return false; } };

/**
 * Read the whole config, classified. `removals.readConfig` and `reconcile.readConfigClassified` each
 * own their own block; this reader owns only the TOP-LEVEL founder-facing keys those two do not read.
 */
function readTopLevel(dir) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, 'respawnpack.config.json'), 'utf8')); }
  catch (e) {
    return e && e.code === 'ENOENT'
      ? { status: 'ABSENT', value: null, detail: 'no respawnpack.config.json' }
      : { status: 'MALFORMED', value: null, detail: `respawnpack.config.json is unreadable or not parseable JSON (${e.message})` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { status: 'MALFORMED', value: null, detail: 'respawnpack.config.json must contain a JSON object' };
  }
  return { status: 'OK', value: doc, detail: null };
}

/*
 * ⛔ ONE DECLARATION SHAPE FOR THE TWO KEYS THAT HAD NONE. `routeSource` and `codeTruth` were bare
 * strings with no way to say "this project has no routes" — so the only expressible answers were a real
 * value or a lie. They now accept the SAME opt-out the removal contract and the reconciler already
 * take, because a founder who has learned one opt-out should not have to learn a third:
 *
 *   "routeSource": "app/**\/page.tsx"                                    → CONFIGURED
 *   "routeSource": {"notApplicable": true, "reason": "no web surface"}   → NOT_APPLICABLE
 *   (absent)                                                             → UNDECIDED
 *   "routeSource": "<set ROUTE_SOURCE>"  |  {"notApplicable": true}      → INVALID
 */
function resolveDeclaredPath(raw, { key, subject }) {
  if (raw === undefined) {
    return { state: APPLICABILITY.UNDECIDED, basis: 'absent', detail: `no ${key} in respawnpack.config.json — ${subject}` };
  }
  if (isTemplate(raw)) {
    return {
      state: APPLICABILITY.INVALID, basis: 'template',
      detail: `${key} still holds the installer's template ${JSON.stringify(String(raw).trim())}. That is not a value: a drift-check handed it matches nothing and reports no drift, which is a check agreeing with everything`,
    };
  }
  if (nonEmpty(raw)) return { state: APPLICABILITY.CONFIGURED, basis: 'declared', detail: `${key} = ${String(raw).trim()}` };
  if (typeof raw === 'string') {
    return { state: APPLICABILITY.INVALID, basis: 'malformed', detail: `${key} is blank — a key present with nothing in it is a configuration fault, not an absence` };
  }
  if (Array.isArray(raw)) {
    // Empty is EMPTY, not malformed: a founder who wrote `[]` declared nothing, and telling them their
    // syntax is wrong sends them to fix the one thing that is fine. Rule 12 — classify by shape.
    if (!raw.length) return { state: APPLICABILITY.UNDECIDED, basis: 'empty', detail: `${key} is an empty list — ${subject}` };
    // ⛔ And the template check reaches INSIDE the list. Guarding only the bare-string form would let
    // `["<set CODE_TRUTH: …>"]` through as configuration, which is the same silent-green one wrapper out.
    const templated = raw.filter(isTemplate);
    if (templated.length) {
      return {
        state: APPLICABILITY.INVALID, basis: 'template',
        detail: `${key} still holds the installer's template ${JSON.stringify(String(templated[0]).trim())}. That is not a value, inside a list or out of one`,
      };
    }
    const values = raw.filter(nonEmpty).map((v) => v.trim());
    if (values.length === raw.length) return { state: APPLICABILITY.CONFIGURED, basis: 'declared', detail: `${key} = ${values.join(', ')}` };
    return { state: APPLICABILITY.INVALID, basis: 'malformed', detail: `${key} must be an array of non-empty strings` };
  }
  if (raw && typeof raw === 'object') {
    if (raw.notApplicable === true) {
      return nonEmpty(raw.reason)
        ? { state: APPLICABILITY.NOT_APPLICABLE, basis: 'declared', detail: `declared not applicable: ${raw.reason.trim()}` }
        : {
          state: APPLICABILITY.INVALID, basis: 'malformed',
          detail: `${key}.notApplicable is true with no reason — an opt-out nobody has to justify is an opt-out nobody reviews`,
        };
    }
    if (raw.notApplicable !== undefined) {
      return { state: APPLICABILITY.INVALID, basis: 'malformed', detail: `${key}.notApplicable must be boolean true beside a reason` };
    }
    return { state: APPLICABILITY.UNDECIDED, basis: 'empty', detail: `${key} declares nothing — ${subject}` };
  }
  return { state: APPLICABILITY.INVALID, basis: 'malformed', detail: `${key} must be a string, an array of strings, or an opt-out {notApplicable, reason}` };
}

/*
 * qualityGate takes the SAME declared opt-out removals and reconcile already use, but its CONFIGURED
 * shape is `{"checks": [...]}` — not a string or a glob — so resolveDeclaredPath above (built for
 * routeSource/codeTruth) does not fit it. This is its own reader of the same vocabulary.
 *
 * ⛔ AND IT MUST AGREE WITH gate.js's OWN VERDICT ON THE SAME INPUT, OR notApplicable: true WOULD MEAN
 * TWO DIFFERENT THINGS DEPENDING ON WHICH MODULE READ IT. gate.js's runGate() tightened a bare
 * `notApplicable: true` (no reason) from a quiet NOT_APPLICABLE pass into a refusal — the same rule
 * removals.js and reconcile.js already enforce: an opt-out nobody has to justify is an opt-out nobody
 * reviews. Read here, the same input is an ATTEMPTED-AND-UNUSABLE declaration: INVALID, not UNDECIDED,
 * because somebody tried and got it wrong, and telling them they never started is the wrong instruction.
 */
function resolveQualityGate(raw) {
  // gate.js's own fallback when nothing is declared: it still auto-detects a stack and runs what it
  // finds. That is a real thing that can happen, and it is still not a DECISION — this module answers
  // "has anybody decided", not "will something run", so absence stays UNDECIDED regardless.
  const fallback = "gate.js falls back to auto-detecting a stack and running what it finds, and nobody has confirmed that default or declared this project's gate not applicable";
  if (raw === undefined) {
    return { state: APPLICABILITY.UNDECIDED, basis: 'absent', detail: `no qualityGate in respawnpack.config.json — ${fallback}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      state: APPLICABILITY.INVALID, basis: 'malformed',
      detail: 'qualityGate must be an object: {"checks": [...]} or {"notApplicable": true, "reason": "..."}',
    };
  }
  if (raw.notApplicable === true) {
    return nonEmpty(raw.reason)
      ? { state: APPLICABILITY.NOT_APPLICABLE, basis: 'declared', detail: `declared not applicable: ${String(raw.reason).trim()}` }
      : {
        state: APPLICABILITY.INVALID, basis: 'malformed',
        detail: 'qualityGate.notApplicable is true with no reason — an opt-out nobody has to justify is an opt-out nobody reviews',
      };
  }
  if (raw.notApplicable !== undefined) {
    return { state: APPLICABILITY.INVALID, basis: 'malformed', detail: 'qualityGate.notApplicable must be boolean true beside a reason' };
  }
  if (raw.checks === undefined) {
    return { state: APPLICABILITY.UNDECIDED, basis: 'empty', detail: `qualityGate declares nothing — ${fallback}` };
  }
  if (!Array.isArray(raw.checks)) {
    return { state: APPLICABILITY.INVALID, basis: 'malformed', detail: 'qualityGate.checks must be an array of check objects' };
  }
  if (!raw.checks.length) {
    // Empty is EMPTY, not malformed — Rule 12: a founder who wrote `checks: []` declared nothing, the
    // same as omitting the key, and telling them their syntax is wrong sends them to fix the one thing
    // that is fine.
    return { state: APPLICABILITY.UNDECIDED, basis: 'empty', detail: `qualityGate.checks is an empty list — ${fallback}` };
  }
  const names = raw.checks.map((c) => (c && typeof c === 'object' && nonEmpty(c.name) ? c.name.trim() : 'unnamed')).join(', ');
  return { state: APPLICABILITY.CONFIGURED, basis: 'declared', detail: `qualityGate.checks declares ${raw.checks.length} check(s): ${names}` };
}

/*
 * PROGRESSIVE ACTIVATION, AS A NUDGE AND NEVER AS A VERDICT.
 *
 * A greenfield repository should start with a small truthful contract and pick checks up as the
 * artifacts they read appear. The probe below answers "is there something here to point this check at
 * yet", which is what makes the onboarding question answerable instead of abstract — and it is
 * REPORTED, never applied. Finding a route directory does not configure the route source, and finding
 * none does not mark it not-applicable. Both of those are the inference this whole module refuses.
 *
 * The route probe list mirrors install/install.js's own detection so the installer and the survey
 * cannot disagree about what counts as a route source.
 */
const ROUTE_DIRS = ['src/app', 'app', 'src/pages', 'pages', 'src/routes'];

function routeArtifact(dir) {
  for (const d of ROUTE_DIRS) if (exists(dir, d)) return d;
  return null;
}

/*
 * PROGRESSIVE ACTIVATION for the quality gate — same doctrine as routeArtifact above: report what
 * gate.js would find, and never apply it. Finding a stack does NOT configure the gate and finding none
 * does NOT excuse it; only a founder's own declaration in respawnpack.config.json moves the row above.
 *
 * ⛔ MIRRORED, NOT REQUIRED — same choice ROUTE_DIRS made against install.js, for the same reason.
 * kernel/lib/modhealth.js's SUBSYSTEMS registry names every export a production module reads off
 * another kernel lib; gate.js's entry there lists only `EXIT` and `runGate`, which is everything
 * respawnpack.js reads today, and a fence in kernel/kernel.test.mjs fails on any drift from the real
 * call sites. Calling gate.js's own `detectProfiles`/`candidateRoots` from here would be a THIRD,
 * undeclared read that this file does not own the registry for. So this copies gate.js's own detection
 * file list instead of requiring the module — two readers that agree on what a stack looks like without
 * one depending on the other's internals. (Tracked as a known duplication in docs/derived/state/pairs.json
 * P-024, alongside ROUTE_DIRS's own copy of install.js's detection.)
 */
const GATE_STACK_ROOTS = ['backend', 'frontend'];
const GATE_MONOREPO_PARENTS = ['apps', 'services', 'packages'];
const GATE_STACK_FILES = [
  ['node', ['package.json']],
  ['python', ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'tox.ini']],
  ['go', ['go.mod']],
  ['rust', ['Cargo.toml']],
];

function qualityGateRoots(dir) {
  const roots = ['.'];
  for (const fixed of GATE_STACK_ROOTS) if (exists(dir, fixed)) roots.push(fixed);
  for (const parent of GATE_MONOREPO_PARENTS) {
    try {
      for (const e of fs.readdirSync(path.join(dir, parent), { withFileTypes: true })) {
        if (e.isDirectory()) roots.push(`${parent}/${e.name}`);
      }
    } catch { /* no such parent directory here — nothing to add */ }
  }
  return roots;
}

function qualityGateArtifact(dir) {
  const found = [];
  for (const root of qualityGateRoots(dir)) {
    for (const [id, files] of GATE_STACK_FILES) {
      const hit = files.find((f) => exists(dir, root, f));
      if (hit) found.push(`${id} (${hit}${root === '.' ? '' : ` in ${root}`})`);
    }
  }
  return found.length ? found.join(', ') : null;
}

function requirementsRel() {
  return `${stateLib.STATE_DIR}/requirements.json`.split(path.sep).join('/');
}

/**
 * One row per optional contract: what state it is in, how it got there, and what would resolve it.
 *
 * @param {string} dir the project root
 * @param {Object} [posture] the verb's ONE resolved posture: `{profile, source, verdict(id)}`. Omitted,
 *   absent or anything but a DECLARED resolution and every row is classified exactly as it is today.
 */
function survey(dir, posture) {
  const top = readTopLevel(dir);
  const doc = top.value || {};
  const policy = policyOf(posture);
  const rows = [];

  // --- removals: the killed-feature contract -------------------------------------------------------
  {
    const cfg = removalsLib.readConfig(dir);
    const registry = (() => {
      try {
        const doc2 = JSON.parse(fs.readFileSync(path.join(dir, cfg.registry), 'utf8'));
        const count = Array.isArray(doc2 && doc2.removals) ? doc2.removals.length : 0;
        const baseline = typeof (doc2 || {}).emptyBaseline === 'string' && doc2.emptyBaseline.trim() ? doc2.emptyBaseline.trim() : null;
        return { present: true, count, baseline };
      } catch { return { present: false, count: 0, baseline: null }; }
    })();
    let row;
    if (cfg.error) row = { state: APPLICABILITY.INVALID, basis: 'malformed', detail: cfg.error };
    else if (cfg.notApplicable) row = { state: APPLICABILITY.NOT_APPLICABLE, basis: 'declared', detail: `declared not applicable: ${cfg.notApplicable}` };
    else if (!cfg.configured) {
      row = {
        state: APPLICABILITY.UNDECIDED, basis: top.status === 'ABSENT' ? 'absent' : 'empty',
        detail: 'state.removals declares no liveContentDirs — nothing scans this project for reintroduced killed features',
      };
    } else if (registry.count) {
      row = { state: APPLICABILITY.CONFIGURED, basis: 'declared', detail: `${registry.count} guarded removal(s), scanning ${cfg.liveContentDirs.join(', ')}` };
    } else if (registry.baseline) {
      /*
       * Configured to scan, with a registry that states its own emptiness. That is a decision — the
       * contract is on and the project has said, in writing, that it has retired nothing yet — so the
       * first row that lands is enforced without anybody re-onboarding the subsystem.
       */
      row = { state: APPLICABILITY.NOT_APPLICABLE, basis: 'declared', detail: `empty retirement baseline declared: ${registry.baseline}` };
    } else {
      /*
       * ⛔ AND THIS IS THE CASE THE FRESH INSTALL ACTUALLY LANDS IN. The installer seeds liveContentDirs,
       * so the scan is configured; nothing has been retired, so the registry is empty. Reporting that as
       * CONFIGURED would claim a guarantee with no subject behind it, which is the empty-validator shape.
       * It is UNDECIDED: the project has not yet said whether it has retired nothing, or has simply not
       * recorded what it retired.
       */
      row = {
        state: APPLICABILITY.UNDECIDED, basis: registry.present ? 'empty' : 'absent',
        detail: `${cfg.registry} records no removals, so the scan over ${cfg.liveContentDirs.join(', ')} has nothing to enforce`,
      };
    }
    /*
     * ⛔ R3's TWO GUARDS, AND THEY ARE THE ANTI-DRIFT CORE'S OWN SENTENCE SPLIT IN HALF (item 14):
     * "a profile may make an UNCONFIGURED contract advisory; a CONFIGURED one that scanned nothing
     * never PASSes". So a posture may relax this row only while `liveContentDirs` is unset AND the
     * registry holds no rows — the moment either is false, R3 is mandatory in every posture, and the
     * `light` NOT_APPLICABLE needs the stronger condition still: no registry FILE at all, because
     * "there is no registry here" is inference-free and "the registry is empty" is not.
     */
    const unconfigured = !cfg.configured && !registry.count;
    rows.push(relax({
      subsystem: 'removals', title: 'the killed-feature contract', ...row,
      artifact: registry.count ? `${cfg.registry} (${registry.count} row(s))` : registry.present ? cfg.registry : null,
      remedy: cfg.configured
        ? `record this project's retired capabilities in ${cfg.registry}, or declare \`"emptyBaseline": "<why nothing has been retired yet>"\` there`
        : 'declare state.removals.liveContentDirs, or declare state.removals.notApplicable with a reason',
    }, policy, {
      id: POSTURE_ROWS.removals,
      relaxable: unconfigured,
      inferenceFree: unconfigured && !registry.present,
      authored: policy
        ? `the declared \`${policy.profile}\` posture answers the killed-feature contract for a project that has no ${cfg.registry} at all `
          + '— the scan turns mandatory again, in every posture, the moment a registry with rows exists'
        : null,
    }));
  }

  // --- reconcile: DF-005, the task list against the project's own records --------------------------
  {
    /*
     * ⛔ "IS THE READER HERE" IS ASKED BEFORE "WHAT DOES IT SAY", AND THE ANSWER DEPENDS ON THE
     * DECLARATION (P3-K-14). ADR-003's `light` cell for `kernel:R4` reads "n.a., NOT INSTALLED", and its
     * qualifier is exact: n.a. only where `reconcile.js` is not installed BY PROFILE, never inferred from
     * an absent task source. Until this task that cell could never be true, because every install placed
     * the file. It can be true now, so the two absences are separated here rather than blurred:
     *
     *   the module is gone AND the declared posture's R4 cell is `n.a.`  → NOT_APPLICABLE, authored,
     *                                                                      naming the posture
     *   the module is gone under any other posture (or none)            → INVALID. The profile expects
     *                                                                      this subsystem, so its absence
     *                                                                      is breakage, and `doctor`'s
     *                                                                      kernel-lib row says BROKEN
     *
     * INVALID rather than UNDECIDED for the second, because UNDECIDED means "nobody answered" and would
     * send a founder to write a declaration into a file no reader is left to read. Somebody's install is
     * damaged; that is a different instruction.
     */
    if (!reconcileLib) {
      const missing = {
        subsystem: 'reconcile', title: 'the task/record reconciliation',
        artifact: exists(dir, requirementsRel()) ? requirementsRel() : null,
        detail: reconcileHealth.detail || reconcileHealth.status,
      };
      const naByProfile = Boolean(policy) && policy.verdict(POSTURE_ROWS.reconcile) === 'n.a.';
      rows.push(naByProfile
        ? answeredByPosture(
          { ...missing, remedy: `declare a posture that carries the task/record reconciliation (\`standard\` or \`strict\`) and re-run the installer, which places lib/${path.basename(RECONCILE_PATH)} for those profiles` },
          policy, POSTURE_ROWS.reconcile,
          `the declared \`${policy.profile}\` posture does not install the reconciliation subsystem, so this project has nothing for it to compare `
          + '— read from the declaration, never inferred from an absent task source',
        )
        : {
          ...missing,
          state: APPLICABILITY.INVALID,
          basis: 'unloadable',
          detail: `the reconciliation subsystem is not usable here: ${missing.detail}. This posture carries the contract, so that is a damaged install rather than a decision`,
          remedy: 'run `doctor` — it reports the subsystem as BROKEN by name — then re-run the installer to restore it',
        });
    } else {
      const read = reconcileLib.readConfigClassified(dir);
      const cfg = read.value;
      let row;
      if (read.status === 'MALFORMED') row = { state: APPLICABILITY.INVALID, basis: 'malformed', detail: read.detail };
      else if (!cfg || (cfg.notApplicable !== true && cfg.tasks === undefined && cfg.project === undefined)) {
        row = {
          state: APPLICABILITY.UNDECIDED, basis: read.status === 'ABSENT' ? 'absent' : 'empty',
          detail: 'state.reconcile declares no task source and no project record source, so nothing is compared',
        };
      } else if (cfg.notApplicable === true) {
        row = nonEmpty(cfg.reason)
          ? { state: APPLICABILITY.NOT_APPLICABLE, basis: 'declared', detail: `declared not applicable: ${String(cfg.reason).trim()}` }
          : { state: APPLICABILITY.INVALID, basis: 'malformed', detail: 'state.reconcile.notApplicable is true with no reason — an opt-out nobody has to justify is an opt-out nobody reviews' };
      } else if (cfg.tasks === undefined || cfg.project === undefined) {
        row = {
          state: APPLICABILITY.INVALID, basis: 'partial',
          detail: `state.reconcile declares only the ${cfg.tasks === undefined ? 'project' : 'tasks'} side — a half-configured comparison compares nothing`,
        };
      } else if (!cfg.tasks || typeof cfg.tasks !== 'object' || !cfg.project || typeof cfg.project !== 'object') {
        // PRESENT and unusable, which is a configuration fault and not an absence. `tasks: null` read as
        // "no key here" is exactly the truthiness bug reconcile.js's own loader records having fixed.
        row = { state: APPLICABILITY.INVALID, basis: 'malformed', detail: 'state.reconcile.tasks and state.reconcile.project must each be a source object' };
      } else row = { state: APPLICABILITY.CONFIGURED, basis: 'declared', detail: `comparing tasks (${cfg.tasks.kind}) against project records (${cfg.project.kind})` };
      /*
       * ⛔ R4's `light` CELL READS "n.a., NOT INSTALLED", AND THE AUTHORED REASON SAYS EXACTLY THAT.
       * ADR-003's qualifier is "never inferred from an absent task source", so the sentence below is
       * about the DECLARATION — this posture does not carry the reconciliation contract — and never
       * about the tree. Finding no task file still means UNDECIDED under `standard` and `strict`.
       */
      rows.push(relax({
        subsystem: 'reconcile', title: 'the task/record reconciliation', ...row,
        artifact: exists(dir, requirementsRel()) ? requirementsRel() : null,
        remedy: 'declare state.reconcile.tasks and state.reconcile.project, or declare state.reconcile.notApplicable with a reason',
      }, policy, {
        id: POSTURE_ROWS.reconcile,
        inferenceFree: true,
        authored: policy
          ? `the declared \`${policy.profile}\` posture does not carry the task/record reconciliation, so this project has nothing for it to compare `
            + '— read from the declaration, never inferred from an absent task source'
          : null,
      }));
    }
  }

  /*
   * --- requirements: the approved denominator ------------------------------------------------------
   * ⛔ THIS ROW REPORTS kernel/lib/state.js's VERDICT, IT DOES NOT SECOND-GUESS IT. An ABSENT
   * requirements source is NOT_APPLICABLE there and has been since the six-answer classification landed
   * — a project that tracks no denominator is a supported project, not an unfinished one. Re-deciding
   * that here would give one fact two authorities, which is rule 2 of the release invariants. What this
   * row adds is `basis`, so a reader can see the difference between a decision and an absence without
   * either of them changing.
   */
  {
    const rel = requirementsRel();
    const present = exists(dir, rel);
    rows.push({
      subsystem: 'requirements', title: 'the approved requirement denominator',
      state: present ? APPLICABILITY.CONFIGURED : APPLICABILITY.NOT_APPLICABLE,
      basis: present ? 'declared' : 'absent',
      detail: present ? `${rel} supplies the denominator every gate is evaluated against` : `no ${rel} — this project tracks no requirement denominator`,
      artifact: present ? rel : null,
      remedy: `write ${rel} when this project adopts an approved requirement denominator`,
    });
  }

  /*
   * ⛔ AN UNPARSEABLE CONFIG IS NOT AN ABSENT KEY, AND SAYING "no routeSource in
   * respawnpack.config.json" WOULD SEND THE FOUNDER TO ADD ONE TO A FILE THAT CANNOT BE READ. The
   * removals and reconcile readers above already classify this themselves; these two have no reader of
   * their own, so the distinction is drawn here. Rule 12: classify by shape, never by falsiness.
   */
  const malformedConfig = top.status === 'MALFORMED'
    ? { state: APPLICABILITY.INVALID, basis: 'malformed', detail: top.detail }
    : null;

  // --- routes: what /savepoint's routes↔matrix drift-check enumerates ------------------------------
  {
    const artifact = routeArtifact(dir);
    const row = malformedConfig || resolveDeclaredPath(doc.routeSource, {
      key: 'routeSource',
      subject: "/savepoint's routes↔matrix drift-check has nothing to enumerate",
    });
    rows.push(relax({
      subsystem: 'routes', title: 'the route source', ...row, artifact,
      remedy: artifact
        ? `set routeSource to the glob that enumerates this project's routes (a route tree exists at ${artifact}), or declare {"notApplicable": true, "reason": "..."} if this project serves no routes`
        : 'set routeSource to the glob that enumerates this project\'s routes, or declare {"notApplicable": true, "reason": "..."} if this project serves no routes',
    }, policy, { id: POSTURE_ROWS.routes }));
  }

  // --- codeTruth: the canonical-by-code paths the tokens↔docs drift-check defers to ----------------
  {
    const row = malformedConfig || resolveDeclaredPath(doc.codeTruth, {
      key: 'codeTruth',
      subject: "/savepoint's code↔docs drift-check has no canonical source to defer to",
    });
    rows.push(relax({
      subsystem: 'codeTruth', title: 'the canonical-by-code paths', ...row, artifact: null,
      remedy: 'set codeTruth to the token/copy/schema paths that win over prose, or declare {"notApplicable": true, "reason": "..."} if no such source exists here',
    }, policy, { id: POSTURE_ROWS.codeTruth }));
  }

  // --- qualityGate: what kernel/lib/gate.js's runGate() would evaluate on this project -------------
  {
    const artifact = qualityGateArtifact(dir);
    const row = malformedConfig || resolveQualityGate(doc.qualityGate);
    rows.push(relax({
      subsystem: 'qualityGate', title: 'the quality gate', ...row, artifact,
      remedy: artifact
        ? `declare qualityGate.checks (a stack was detected: ${artifact}), or declare {"notApplicable": true, "reason": "..."} if this project has no quality gate`
        : 'declare qualityGate.checks, or declare {"notApplicable": true, "reason": "..."} if this project has no quality gate',
    }, policy, { id: POSTURE_ROWS.qualityGate }));
  }

  /*
   * ⛔ R6 IS THE ROW THAT DECIDES WHETHER A RELAXED ROW COUNTS AS ANSWERED, AND IT IS ITS OWN QUESTION.
   * A row relaxed by mechanism (a) keeps state UNDECIDED, which is honest and would otherwise leave
   * `onboardingComplete` false forever under `light`. So the onboarding aggregate asks ADR-003's own
   * `kernel:R6` cell once: while it relaxes, a posture-relaxed row is an ANSWERED row here. An INVALID
   * row is never relaxed upstream, so it still blocks onboarding in every posture — which is the whole
   * reason this is derived from the rows rather than from the profile name.
   */
  const relaxedOnboarding = Boolean(policy) && RELAXING.has(policy.verdict(POSTURE_ONBOARDING));
  const answered = (r) => RESOLVED.has(r.state) || (relaxedOnboarding && Boolean(r.postureRelaxed));
  const unresolved = rows.filter((r) => !answered(r));
  return {
    rows,
    configRead: { status: top.status, detail: top.detail },
    posture: policy ? { profile: policy.profile, source: policy.source } : null,
    relaxed: rows.filter((r) => r.postureRelaxed).map((r) => r.subsystem),
    undecided: rows.filter((r) => r.state === APPLICABILITY.UNDECIDED).map((r) => r.subsystem),
    invalid: rows.filter((r) => r.state === APPLICABILITY.INVALID).map((r) => r.subsystem),
    /*
     * ⛔ "COMPLETE" MEANS EVERY CONTRACT HAS AN ANSWER, NOT THAT EVERY CONTRACT IS ON. A project that
     * declared five of six not-applicable with reasons is fully onboarded. A project that left one
     * blank is not, however much of the rest it configured — that is the whole distinction the flat
     * CANNOT_DETERMINE could not express.
     */
    onboardingComplete: unresolved.length === 0,
    unresolved: unresolved.map((r) => r.subsystem),
  };
}

/*
 * The coverage half of savepoint's two verdicts, as checks.
 *
 * ⛔ ONLY THE SUBSYSTEMS THAT HAVE NO CHECK OF THEIR OWN ARE EMITTED HERE. removals, reconcile and
 * requirements already produce their own applicability verdict inside savepoint, and each now tags it
 * `domain: 'coverage'` at the point it is constructed. Emitting a second row for them from this module
 * would put one fact under two authorities and double-count it in the rollup — the failure doctor's
 * row-collision fence exists to make loud one layer up. `routes` and `codeTruth` have no kernel check
 * at all (they are read by /savepoint's prose steps), so this is their only producer.
 *
 * `qualityGate` is excluded for a THIRD, sharper reason. Unlike routes/codeTruth it DOES have a real
 * check — kernel/lib/gate.js's runGate() — but that check requires actually SPAWNING lint/test/build
 * subprocesses, which is exactly what this module's own header refuses to do (config-and-filesystem
 * only, no scan, no adapter, no subprocess). A `coverage` row here could report only "a checks array
 * exists", which is the zero-subject PASS this file's doctrine exists to refuse one layer up. The real
 * verdict belongs to runGate() alone — reached today through the standalone `gate` verb, which savepoint
 * does not call — so no `domain: 'coverage'` row for qualityGate exists anywhere, and it stays that way
 * here on purpose.
 */
function coverageChecks(dir, posture) {
  const s = survey(dir, posture);
  const checks = [];
  for (const row of s.rows) {
    if (row.subsystem !== 'routes' && row.subsystem !== 'codeTruth') continue;
    const check = `${row.subsystem}:config`;
    if (row.postureRelaxed && row.state === APPLICABILITY.UNDECIDED) {
      checks.push(relaxedCheck(row, check, row.detail));
    } else if (row.state === APPLICABILITY.CONFIGURED) {
      /*
       * `checked: 1` is the DECLARATION that was inspected, and it is a real subject: the key exists and
       * carries a usable value. This is not the zero-subject PASS kernel/lib/outcome.js refuses — that
       * one is a checker reporting agreement having examined nothing. Whether the declared source then
       * holds up is the integrity half's question, asked by whoever reads it.
       */
      checks.push(result(OUTCOME.PASS, check, row.detail, { checked: 1, domain: 'coverage', applicability: row.state }));
    } else if (row.state === APPLICABILITY.NOT_APPLICABLE) {
      checks.push(row.postureRelaxed
        ? relaxedCheck(row, check, row.detail)
        : result(OUTCOME.NOT_APPLICABLE, check, row.detail, { domain: 'coverage', applicability: row.state }));
    } else {
      checks.push(result(OUTCOME.CANNOT_DETERMINE, check, `${row.detail}. ${row.remedy}`, { checked: 0, domain: 'coverage', applicability: row.state }));
    }
  }
  return { checks, survey: s };
}

/**
 * One relaxed coverage row, in the two shapes ADR-003 allows and no third.
 *
 * ⛔ `checked: 1` IS THE DECLARATION THAT WAS INSPECTED, WHICH IS A REAL SUBJECT. The posture is a
 * value in a tracked, reviewable file, and reading it is work. This is not outcome.js's zero-subject
 * PASS — that one is a checker reporting agreement having examined nothing at all — and `detail` still
 * opens with the reason the row would have refused on, so nothing is hidden by the relaxation.
 */
function relaxedCheck(row, check, detail) {
  const meta = { domain: 'coverage', applicability: row.state, postureRelaxed: row.postureRelaxed, postureRule: row.postureRule };
  return row.state === APPLICABILITY.NOT_APPLICABLE
    ? result(OUTCOME.NOT_APPLICABLE, check, row.detail, { checked: 0, ...meta })
    : result(OUTCOME.PASS, check, `${detail} ${row.postureDetail}.`, { checked: 1, ...meta });
}

/*
 * ⛔ THE COVERAGE ROWS THIS MODULE DOES NOT PRODUCE, RELAXED BY THE SAME ONE DECISION.
 *
 * `removals:config` / `removals:registry` come from kernel/lib/removals.js and `reconcile` from
 * kernel/lib/reconcile.js, because each subsystem owns its own verdict and emitting a second row here
 * would put one fact under two authorities. So the DECISION still happens exactly once, in the survey
 * above, and this applies it to the rows those modules already built: the row's status is what moved,
 * and this is the seam that carries it into the check the operator reads.
 *
 * ⛔ IT ONLY EVER TOUCHES A `coverage` ROW THAT SAID CANNOT_DETERMINE. removals.js's FAIL branch — rows
 * recorded and nothing enforcing them — carries no coverage domain and is left exactly where it is, in
 * every posture: that is a determined breach, not an undetermined check, and no profile relaxes it.
 */
const COVERAGE_OWNERS = {
  'removals:config': 'removals',
  'removals:registry': 'removals',
  reconcile: 'reconcile',
};

/**
 * @param {Array<Object>} checks another subsystem's checks, unmodified when nothing relaxes
 * @param {Object} surveyed the `survey` half of a `coverageChecks()` result — the same one consult
 */
function relaxCoverage(checks, surveyed) {
  const rows = new Map((surveyed && Array.isArray(surveyed.rows) ? surveyed.rows : []).map((r) => [r.subsystem, r]));
  return (checks || []).map((c) => {
    if (!c || c.domain !== 'coverage' || c.outcome !== OUTCOME.CANNOT_DETERMINE) return c;
    const row = rows.get(COVERAGE_OWNERS[c.check]);
    if (!row || !row.postureRelaxed) return c;
    return relaxedCheck(row, c.check, c.detail);
  });
}

module.exports = {
  APPLICABILITY, RESOLVED, INSTALLER_TEMPLATE, POSTURE_ROWS, POSTURE_ONBOARDING,
  coverageChecks, isTemplate, relaxCoverage, relaxes, survey,
};
