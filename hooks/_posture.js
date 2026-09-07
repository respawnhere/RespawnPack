/*
 * RespawnPack · hooks/_posture.js — THE ONE READER OF THE PROJECT'S DECLARED POSTURE.
 *
 * NOT A HOOK (leading underscore — the counts fence excludes these).
 *
 * ⛔ WHY THIS FILE EXISTS. ADR-003 gives a project three postures — `light`, `standard`, `strict` —
 * declared as ONE value in `respawnpack.config.json`, with `strict` defined as exactly what 0.3.0 does.
 * Every rule that a posture may relax has to ask the same question ("what is this project's verdict for
 * rule X?") and get the same answer. Two readers of one policy is the failure `hooks/_contracts.js:23`
 * was written about, so there is exactly one, and this is it.
 *
 * ⛔ AND IT LIVES IN hooks/ BECAUSE THAT IS THE ONLY DIRECTION THAT RESOLVES. The kernel can require
 * from `hooks/` and already does (`kernel/respawnpack.js`, `kernel/lib/state.js`,
 * `kernel/lib/removals.js`, `kernel/lib/closeout.js`); the hooks CANNOT require from the kernel,
 * because the kernel sits at `kernel/lib/` in this repository and at `.claude/respawnpack/lib/` on an
 * installed target. `kernel/lib/posture.js` would have been unreachable from the hooks that need it
 * most. ADR-003 records that decision as final, and it rejects `_boot.js` as a home for the same
 * reason: `_boot.js`'s POSTURES at `:82` are ARMING postures for broken machinery, so overloading the
 * word would make `arm('deny')` ambiguous between "this guard denies by policy" and "this guard's
 * machinery is gone".
 *
 * ⭐ THE FOUR SOURCES ARE FOUR DIFFERENT FACTS, AND COLLAPSING ANY TWO IS THE BUG.
 *
 *   DECLARED    the founder wrote a posture and it is well formed.
 *   DEFAULTED   nobody wrote one. Resolves to `strict`, because an absent key is the migration
 *               guarantee: a target that says nothing keeps today's behaviour exactly. `doctor` still
 *               reports this differently from DECLARED, because "nobody chose" and "chose strict" are
 *               different facts and a report that blurs them is a report nobody can act on.
 *   UNREADABLE  the config is missing-but-locked, or is not parseable JSON. Resolves to `strict` AND
 *               SAYS SO. "Could not read the policy" must never collapse into "the loosest policy"
 *               (anti-drift item 27; the same fail-closed rule `_boot.js:63-82` applies to a guard
 *               whose machinery will not load).
 *   INVALID     a posture is declared and is wrong: an unknown profile, an override with no reason, an
 *               override naming a rule that is fixed in every posture. Resolves to `strict` and says
 *               which. It is REFUSED rather than partially honoured, because a silently discarded
 *               override is the same class of lie as a silently loosened guard.
 *
 * ⛔ THE RESOLVER HAS NO KEY FOR A FIXED RULE, AND THAT IS STRONGER THAN DEFAULTING ONE TO `deny`.
 * A rule with no key cannot be reached by an override at all, so the refusal is UNAVAILABLE rather than
 * merely discouraged. `FIXED_IDS` below is the anti-drift core's own list, carried here so the fence in
 * `hooks/hooks.test.mjs` can assert the intersection with `RESOLVER` is empty, in both directions, from
 * source rather than from prose.
 *
 * ⛔ WHAT THIS FILE DOES NOT DO, TODAY. Nothing consults `verdict()` in a decision path. This module is
 * the reader and the table; the rules that read it land in P3-K-10 (the kernel's day-one coverage rows)
 * and P3-T-10a/b/c (the hook rules), one at a time, each with its own discrimination test. Landing the
 * reader first is what makes those changes reviewable: the table is written down and fenced before any
 * verdict moves.
 *
 * Depends on `./_artifact.js` for the classified read, so absent · transiently unavailable · unreadable
 * · malformed stay four distinct answers here exactly as they are there. Reading the config raw would
 * also have needed a `RAW_READS` classification in `kernel/schema.test.mjs`; reusing the boundary that
 * already exists is the cheaper and the more honest of the two.
 */
const path = require('path');
const artifact = require('./_artifact.js');

/** The founder-owned file the posture is declared in. One spelling, read from here. */
const CONFIG_FILE = 'respawnpack.config.json';

/** The three postures, in order of increasing rigidity. ADR-003's Decision. */
const PROFILES = ['light', 'standard', 'strict'];

/**
 * ⛔ ABSENT MEANS `strict`, AND THAT IS THE MIGRATION GUARANTEE, NOT A PREFERENCE. Both source audits
 * originally wrote "absent defaults to standard" while ALSO defining standard as a relaxation, which
 * cannot both hold. ADR-003 resolves it for the kernel audit's reading: one frozen name plus one
 * comparison test (P3-N-2) discharges "no change for an existing target" for both trees at once.
 */
const DEFAULT_PROFILE = 'strict';

/**
 * The verdict vocabulary, verbatim from ADR-003's legend:
 *   deny   `permissionDecision:"deny"`, `decision:"block"`, or a non-zero outcome
 *   advise `additionalContext` + `systemMessage`, or a non-PASS row at exit 0
 *   off    silent exit 0
 *   n.a.   does not apply
 * `n.a.` is a real cell in the table (`kernel:R3` and `kernel:R4` under `light`) and is kept distinct
 * from `off` on purpose: "does not apply" and "applies and stays silent" are different answers, and the
 * pack refuses to collapse them anywhere else either.
 */
const VERDICTS = ['off', 'advise', 'deny', 'n.a.'];

/**
 * What a FOUNDER may write in an override. `n.a.` is deliberately absent: declaring a rule
 * not-applicable is the `{notApplicable, reason}` contract the config already carries for its own
 * subsystems, judged against a project's shape, not a posture dial a rule can be spun to.
 */
const OVERRIDE_VERDICTS = ['off', 'advise', 'deny'];

/*
 * ⛔ THE FIXED SET — every rule the anti-drift core names, which no posture and no override may reach.
 * Carried here so this module can REFUSE an override on one by name rather than ignoring it, and so the
 * resolver fence can assert `RESOLVER` has no key for any of them. Source: the rework task list, §1 "The fixed
 * ids, for the resolver fence", which is ADR-003's bold rows plus `lockdown` and `worktree-guard` (both
 * read `deny` in all three columns without being marked bold, and the direction that costs is a rule
 * fixed in the contract but reachable in the resolver).
 *
 * Sixteen kernel rows, and the reason splits in two. NINE are fixed because relaxing one FORGES A GREEN:
 * R10 a partial gate, R11 zero claims, R12 `checked <= 0`, R13 STATE stale, R14 writeback drift, R18 a
 * critical adapter with no discriminating controls, R21 manufactured completion, R22 promotion without
 * `--verified-by`, R24 sweep loss. A profile may decide a check does not APPLY to a project; it may
 * never decide that a check which could not run counts as a check that passed. SEVEN more are fixed for
 * having NO FALSE-POSITIVE CLASS: R7, R8, R19, R20, R23, R25, R26. A rule that never fires wrongly has
 * nothing for a posture to relax; loosening it would buy no correct behaviour and cost the refusal
 * outright. Only the required reason's LENGTH is negotiable, never its presence.
 */
const FIXED_IDS = [
  'lockdown',
  'worktree-guard',
  'index-guard:wave-sweep',
  'index-guard:foreign-staged',
  'index-guard:control-plane',
  'push-guard:tier2',
  'shell-guard:catastrophe',
  'secret-scan',
  'docker-session-tag:label',
  'injection-scan',
  'context-monitor',
  'session-routing-nudge:boot',
  'runtime:baseline',
  'stop-savepoint:detect',
  'precompact:handoff-write',
  'kernel:R7', 'kernel:R8',
  'kernel:R10', 'kernel:R11', 'kernel:R12', 'kernel:R13', 'kernel:R14',
  'kernel:R18', 'kernel:R19', 'kernel:R20', 'kernel:R21', 'kernel:R22',
  'kernel:R23', 'kernel:R24', 'kernel:R25', 'kernel:R26',
];

/*
 * ⛔ THE RESOLVER TABLE — the switchable surface, and NOTHING ELSE IS IN IT.
 *
 * Carried from ADR-003's rule table, which itself carries the posture design note, lines 32-88, verbatim. That table
 * has fifty-four rows: thirty-one are fixed (the list above), two (`kernel:R27` unenforceable schema
 * keyword, `kernel:R28` fixture drift) are BUILD-TIME fences over this pack's own registry with no
 * runtime column at all, and the twenty-one below are what is left. Writing the fixed rows here "as
 * deny" would have been the weaker design: an override could then ASK for them and merely be refused,
 * instead of there being nothing to ask.
 *
 * ⛔ AND ONE ROW BELOW IS NOT IN THAT COUNT, ON PURPOSE. `kernel:readiness` (P2-Q-2) arrives by a DATED
 * AMENDMENT to ADR-003's rule table rather than as one of its fifty-four accepted rows, because the
 * accepted text is carried verbatim and is not rewritten to admit a later row. Twenty-two keys, then:
 * the twenty-one the accepted table leaves, plus the one the amendment adds. A row that gains a key
 * here without gaining an ADR row is the drift this note exists to make visible.
 *
 * `qualifiers` records a cell whose ADR entry says more than one word, so the narrowing is not lost on
 * the way into code. It is documentation attached to the row, never a second verdict: `verdict()`
 * returns the word.
 */
const RESOLVER = {
  // --- index-guard: four of its seven rules are switchable; the other three are fixed above ---------
  'index-guard:editor-containment': { light: 'off', standard: 'deny', strict: 'deny' },
  'index-guard:no-bash': { light: 'off', standard: 'deny', strict: 'deny' },
  'index-guard:unmodelled': {
    light: 'advise', standard: 'deny', strict: 'deny',
    qualifiers: { standard: 'HIDDEN_PROGRAM only — the deny narrows rather than disappearing' },
  },
  'index-guard:writer-lease': { light: 'off', standard: 'deny', strict: 'deny' },

  // --- the switchable halves of guards whose other half is fixed -----------------------------------
  'push-guard:tier1': { light: 'off', standard: 'deny', strict: 'deny' },
  'docker-session-tag:advise': { light: 'off', standard: 'advise', strict: 'advise' },
  'stop-savepoint:block': { light: 'off', standard: 'deny', strict: 'deny' },
  'precompact:block': { light: 'advise', standard: 'deny', strict: 'deny' },

  /*
   * ⛔ THE READINESS CHECKLIST (P2-Q-2). NOT a `kernel:R<n>` row: the numbered rows are the reconciled
   * specification's own fifty-four, and inventing an `R29` would put a row in ADR-003's ACCEPTED table
   * that the table does not carry. The dated amendment under "The rule table" adds this id instead, in
   * the style of resolution 4's, and `kernel/lib/readiness.js` is the one thing that asks about it.
   *
   * `advise` scales the list rather than silencing it: `light` asks the essential tier and `standard`
   * the full one, both reporting every row with the reason it would have failed still first in
   * `detail`, and `strict` fails the verb on a FAIL. The relaxation moves the ROLLUP, never a word.
   */
  'kernel:readiness': { light: 'advise', standard: 'advise', strict: 'deny' },

  // --- wholly switchable hooks ---------------------------------------------------------------------
  'spawn-guard:ceiling': { light: 'advise', standard: 'advise', strict: 'deny' },
  'websearch-freshness': { light: 'advise', standard: 'advise', strict: 'advise' },
  'mcp-reaper': { light: 'off', standard: 'deny', strict: 'deny' },

  // --- the ten relaxable kernel rows. Rigidity, not correctness ------------------------------------
  'kernel:R1': { light: 'advise', standard: 'advise', strict: 'deny' },
  'kernel:R2': { light: 'advise', standard: 'advise', strict: 'deny' },
  'kernel:R3': {
    light: 'n.a.', standard: 'advise', strict: 'deny',
    qualifiers: {
      light: 'n.a. ONLY where the absence is free of inference: no removals registry at all. '
        + 'The moment a removals.json with rows exists, R3 is mandatory in every posture.',
    },
  },
  'kernel:R4': {
    light: 'n.a.', standard: 'advise', strict: 'deny',
    qualifiers: { light: 'n.a. ONLY where reconcile.js is not installed by profile, never inferred from an absent task source' },
  },
  'kernel:R5': { light: 'advise', standard: 'advise', strict: 'deny' },
  'kernel:R6': { light: 'advise', standard: 'advise', strict: 'deny' },
  'kernel:R9': { light: 'advise', standard: 'deny', strict: 'deny' },
  'kernel:R15': {
    light: 'advise', standard: 'advise', strict: 'deny',
    qualifiers: { standard: 'advise on --verify' },
  },
  'kernel:R16': {
    light: 'advise', standard: 'deny', strict: 'deny',
    qualifiers: { light: 'advise, and auto-migrate' },
  },
  'kernel:R17': { light: 'advise', standard: 'advise', strict: 'deny' },
};

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const shapeOf = (v) => (Array.isArray(v) ? 'an array' : v === null ? 'null' : `a ${typeof v}`);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** One resolution, in the one shape every caller reads. */
const frame = (profile, overrides, source, detail) => ({ profile, overrides, source, detail });

/**
 * A malformed declaration. Fails closed to `strict` and CARRIES THE REASON, because a run that quietly
 * fell back would look identical to a run that was told to be strict.
 */
const invalid = (why) => frame(DEFAULT_PROFILE, {}, 'INVALID',
  `${CONFIG_FILE} declares an INVALID posture (${why}) — it resolves to strict, and the declaration is refused rather than partly honoured`);

/**
 * Read the project's declared posture.
 *
 * @param {string} projectDir the project root
 * @returns {{profile:string, overrides:Object, source:'DECLARED'|'DEFAULTED'|'UNREADABLE'|'INVALID', detail:string}}
 */
function resolve(projectDir) {
  const file = path.join(String(projectDir == null ? '.' : projectDir), CONFIG_FILE);
  const read = artifact.readJSONClassified(file);

  if (read.status === 'ABSENT') {
    return frame(DEFAULT_PROFILE, {}, 'DEFAULTED',
      `no ${CONFIG_FILE}, so no posture is declared — every rule behaves as strict, which is exactly what this pack has always done`);
  }
  if (read.status !== 'OK') {
    const what = read.status === 'MALFORMED' ? 'is not parseable JSON' : 'could not be read';
    return frame(DEFAULT_PROFILE, {}, 'UNREADABLE',
      `${CONFIG_FILE} ${what} (${read.detail || read.status}) — the posture is UNREADABLE and resolves to strict. `
      + 'A policy that could not be read is never the loosest policy.');
  }

  const cfg = read.doc;
  if (!isPlainObject(cfg)) return invalid(`the file is ${shapeOf(cfg)}, expected a JSON object`);
  if (!has(cfg, 'posture') || cfg.posture === undefined) {
    return frame(DEFAULT_PROFILE, {}, 'DEFAULTED',
      `${CONFIG_FILE} declares no \`posture\` key — every rule behaves as strict. Nobody has chosen a posture, which is not the same fact as choosing strict.`);
  }

  const declared = cfg.posture;
  if (!isPlainObject(declared)) return invalid(`\`posture\` is ${shapeOf(declared)}, expected an object with \`profile\` and \`overrides\``);

  let profile = DEFAULT_PROFILE;
  let profileNamed = false;
  if (declared.profile !== undefined) {
    if (!PROFILES.includes(declared.profile)) {
      return invalid(`\`posture.profile\` is ${JSON.stringify(declared.profile)}, and the only postures are ${PROFILES.join(', ')}`);
    }
    profile = declared.profile;
    profileNamed = true;
  }

  const overrides = {};
  if (declared.overrides !== undefined) {
    if (!isPlainObject(declared.overrides)) {
      return invalid(`\`posture.overrides\` is ${shapeOf(declared.overrides)}, expected an object keyed by rule id`);
    }
    for (const [id, rule] of Object.entries(declared.overrides)) {
      const at = `\`posture.overrides[${JSON.stringify(id)}]\``;
      if (!isPlainObject(rule)) return invalid(`${at} is ${shapeOf(rule)}, expected {verdict, reason}`);
      const extra = Object.keys(rule).filter((k) => k !== 'verdict' && k !== 'reason');
      if (extra.length) return invalid(`${at} carries ${extra.join(', ')}; an override is exactly {verdict, reason}`);
      if (!OVERRIDE_VERDICTS.includes(rule.verdict)) {
        return invalid(`${at}.verdict is ${JSON.stringify(rule.verdict)}, and an override may only say ${OVERRIDE_VERDICTS.join(', ')}`);
      }
      if (typeof rule.reason !== 'string' || !rule.reason.trim()) {
        return invalid(`${at} has no \`reason\`. An override nobody has to justify is an override nobody reviews, which is the rule `
          + 'this pack already enforces on every other opt-out it accepts');
      }
      if (FIXED_IDS.includes(id)) {
        return invalid(`${at} names a rule that is FIXED in every posture. It is refused rather than ignored: a silently discarded `
          + 'override is the same class of lie as a silently loosened guard');
      }
      if (!has(RESOLVER, id)) {
        return invalid(`${at} names \`${id}\`, which is not a rule this resolver carries. An override aimed at nothing would `
          + 'read as accepted and change no verdict at all');
      }
      overrides[id] = { verdict: rule.verdict, reason: rule.reason };
    }
  }

  const count = Object.keys(overrides).length;
  return frame(profile, overrides, 'DECLARED',
    `${profileNamed ? `posture \`${profile}\` is declared` : `\`posture\` is declared with no \`profile\`, so the profile is \`${DEFAULT_PROFILE}\``}`
    + ` in ${CONFIG_FILE}${count ? `, with ${count} per-rule override(s): ${Object.keys(overrides).sort().join(', ')}` : ', with no per-rule overrides'}`);
}

/**
 * The verdict for one rule id under an already-resolved posture.
 *
 * Takes the resolution rather than a project directory ON PURPOSE: a hook resolves once, beside its
 * `.off` marker check, and then asks about each of its rules. Re-reading the config per rule would make
 * one hook invocation answer from two reads of a file that can change between them.
 *
 * ⛔ AN ID THE TABLE DOES NOT CARRY ANSWERS `deny`. That is every FIXED rule and every typo, and it is
 * the only direction that cannot cause the harm it exists to prevent: a mis-wired consult can tighten,
 * never loosen. A fixed rule must not be routed through here at all, and `hooks/hooks.test.mjs` asserts
 * the table has no key for one.
 *
 * @param {{profile:string, overrides:Object}} resolved a `resolve()` result
 * @param {string} id the rule id
 * @returns {'off'|'advise'|'deny'|'n.a.'}
 */
function verdict(resolved, id) {
  const row = has(RESOLVER, id) ? RESOLVER[id] : null;
  if (!row) return 'deny';

  const r = isPlainObject(resolved) ? resolved : {};
  const override = isPlainObject(r.overrides) && isPlainObject(r.overrides[id]) ? r.overrides[id] : null;
  if (override && OVERRIDE_VERDICTS.includes(override.verdict)) return override.verdict;

  const profile = PROFILES.includes(r.profile) ? r.profile : DEFAULT_PROFILE;
  return row[profile];
}

module.exports = {
  CONFIG_FILE, PROFILES, DEFAULT_PROFILE, VERDICTS, OVERRIDE_VERDICTS, FIXED_IDS, RESOLVER,
  resolve, verdict,
};
