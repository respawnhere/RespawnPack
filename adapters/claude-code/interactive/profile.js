/*
 * RespawnPack · adapters/claude-code/interactive/profile.js — what the INTERACTIVE HOOKS profile CLAIMS,
 * and the canary each claim rests on. Mirrors adapters/claude-code/sdk-supervisor/capabilities.js's own
 * structure deliberately: same TARGET/declareOne/declareAll/matrix shape, so a reader who already knows
 * one profile's declaration file can read this one.
 *
 * ⭐ THE PROFILE, AND WHY ITS CAPABILITY PROFILE LOOKS DIFFERENT FROM THE SUPERVISOR'S. This is
 * the multi-host rollover design's "Interactive profile" section (a development record): hooks/*.js observe, measure, persist
 * and block — they never issue a conversation turn, so `requestCompact` is honestly NOT_SUPPORTED here
 * (see TARGET.requestCompact) rather than SUPPORTED_WITH_LIMITATIONS, the level the design doc's
 * capability table reserves for a profile that at least ATTEMPTS the action imperfectly. The operator's
 * own `/compact` is the real mechanism, named as manual everywhere this profile speaks about it
 * (hooks/context-monitor.js, hooks/precompact-ledger-nudge.js) — never implied to be automatic.
 *
 * ⛔ THE DECLARATIONS CARRY WHATEVER CANARY THE CALLER SUPPLIES, NOT A FIXED TARGET. Exactly like the
 * SDK-supervisor's capabilities.js: the v0.3 design's TARGET table is reproduced below as a plan, and a
 * target is never promoted to a declaration without a PASSING activation canary (probe.js) for it. The
 * PASSING part is core's rule, not this file's — `capabilities.declare()` reads the canary's OUTCOME as
 * well as its shape and downgrades a claim whose canary did not record PASS, so this profile hands over
 * the canary it has and adds only the target and the offline proof afterwards. A profile installed but
 * never run declares CANNOT_DETERMINE for everything but `requestCompact`, which needs no canary because
 * it is declared NOT_SUPPORTED unconditionally — an accurate claim about the mechanism, not an
 * observation of one.
 */
'use strict';

const path = require('path');
const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));

// core's OUTCOME vocabulary is not imported here on purpose: the canary's verdict is read by
// capabilities.declare(), and a copy of the comparison in this file is how the two drift apart.
const { capabilities } = core;
const { SUPPORT } = capabilities;

const PROFILE = 'claude-interactive-hooks';

/*
 * The v0.3 design's TARGET for this profile, per capability — data, not a declaration. Nothing in this
 * file turns a row of this table into a support level on its own; see declareOne().
 */
const TARGET = {
  probe: {
    support: SUPPORT.SUPPORTED_WITH_LIMITATIONS,
    mechanism: 'the hooks\' own runtime artifacts for THIS conversation: the SessionStart baseline '
      + '(.respawnpack/runtime/session-<sessionId>.json) and context-monitor.js\'s per-cycle latch file '
      + '(.respawnpack/runtime/rollover/claude-code-<sessionId>/thresholds.json), checked for presence and '
      + 'structural freshness — see probe.js.',
    limitations: [
      'installed hook FILES are not evidence of activation — only a runtime artifact a hook actually wrote for this conversation counts',
      'the latch file legitimately does not exist for a conversation that has not yet crossed a configured context threshold, so its absence alone does not fail the probe',
    ],
    docs: ['adapters/claude-code/interactive/probe.js', 'hooks/session-routing-nudge.js captureBaseline()'],
  },
  measureContext: {
    support: SUPPORT.SUPPORTED_WITH_LIMITATIONS,
    mechanism: 'three ranked sources (core/lifecycle/evidence.js SOURCE_CONFIDENCE): the opt-in statusline '
      + 'tee (documented-api, HIGH, when its record is fresher than 60s), the transcript\'s own usage block '
      + '(internal-format, LOW), and a transcript byte-size proxy (byte-proxy, PROXY).',
    limitations: [
      'hooks receive no context-usage fields on their event payload at all — every number here is derived from a side channel, never read off the event itself',
      'the private transcript JSONL is explicitly internal and undocumented; only the opt-in statusline tee (adapters/claude-code/statusline/, NOT installed by default) reaches HIGH confidence',
    ],
    docs: ['adapters/claude-code/statusline/README.md', 'core/lifecycle/evidence.js'],
  },
  settleOrStop: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'the Stop hook (hooks/stop-savepoint.js) blocks continuation on session-delta work that is not '
      + 'yet closed out; the boundary is the host\'s own turn completion, never a timer.',
    docs: ['hooks/stop-savepoint.js'],
  },
  requestCompact: {
    support: SUPPORT.NOT_SUPPORTED,
    mechanism: null,
    why: 'a hook cannot invoke a slash command, and there is no other documented mechanism for a PreCompact '
      + 'or SessionStart hook to make an unmanaged interactive client run /compact. The manual fallback is '
      + 'real and is named as manual everywhere this profile speaks about it: the operator runs /compact. '
      + 'Fully automatic requestCompact needs the managed SDK-supervisor profile '
      + '(adapters/claude-code/sdk-supervisor), which issues the turn itself.',
    docs: ['docs/vision/ARCHITECTURE.md — the host adapters', 'adapters/claude-code/sdk-supervisor/capabilities.js'],
  },
  observeCompact: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'SessionStart with source="compact" is the documented completion boundary '
      + '(core/lifecycle/evidence.js COMPLETION_SIGNALS.session_start_compact); PreCompact\'s own hard '
      + 'precondition (hooks/precompact-ledger-nudge.js) corroborates that a verified handoff existed '
      + 'before this compaction was ever allowed to reach the host.',
    limitations: ['no PostCompact hook exists for Claude Code (unlike Codex) — SessionStart(compact) is the only completion signal this profile observes; a PostCompact corroboration is future work, not shipped here'],
    docs: ['core/lifecycle/evidence.js COMPLETION_SIGNALS', 'hooks/session-routing-nudge.js'],
  },
  injectHandoff: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'the verified handoff is claimed exactly once through the O_EXCL receipt '
      + '(core/lifecycle/consumable.js) and injected via SessionStart\'s hookSpecificOutput.additionalContext.',
    docs: ['core/lifecycle/consumable.js', 'hooks/session-routing-nudge.js'],
  },
  resume: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'the interactive profile never starts a replacement conversation; /compact is documented to '
      + 'preserve session_id, and verify-identity (core/lifecycle/machine.js) checks that empirically on '
      + 'every rollover rather than assuming it from the documentation alone.',
    docs: ['docs/vision/ARCHITECTURE.md', 'core/lifecycle/states.js'],
  },
};

/** What each capability has been proven to do OFFLINE, against fixtures/tests. Never a support level. */
const OFFLINE_PROOF = {
  probe: 'hooks/hooks.test.mjs and this package\'s own tests drive real hook runs and assert on the runtime artifacts probe.js reads',
  measureContext: 'hooks/hooks.test.mjs\'s context-lifecycle suite drives all three measurement sources with synthetic transcripts and tee files of known content',
  settleOrStop: 'hooks/hooks.test.mjs\'s Stop suite (DF-003/RA-1, R-8/Scenario J) exercises the session-delta boundary directly',
  requestCompact: 'not applicable — this capability is declared NOT_SUPPORTED unconditionally; there is no mechanism to prove offline',
  observeCompact: 'hooks/hooks.test.mjs drives real PreCompact then SessionStart(source=compact) pairs and asserts the machine transitions and cycle advance',
  injectHandoff: 'hooks/hooks.test.mjs asserts a redelivered SessionStart(compact) injects only a pointer note, never the content twice',
  resume: 'the identity-verification evidence and its guard are exercised by core/core.test.mjs and conformance/ fixtures this profile shares with every other Claude adapter',
};

/**
 * Turn one capability's canary into a declaration.
 * @param capability  one of core's seven
 * @param canary      { ran, kind, observedAt, raw, outcome, why } from probe.js — `outcome` must be PASS
 *                     for the target to stand, and core is what checks that.
 */
function declareOne(capability, canary) {
  const target = TARGET[capability];
  if (!target) throw new Error(`no target recorded for capability ${capability}`);

  // requestCompact needs no canary: it is an accurate claim about a MECHANISM THAT DOES NOT EXIST for
  // this profile, not an observation that could pass or fail. capabilities.declare() does not require a
  // canary for NOT_SUPPORTED, and this profile does not manufacture one.
  if (target.support === SUPPORT.NOT_SUPPORTED) {
    return capabilities.declare({ capability, support: SUPPORT.NOT_SUPPORTED, why: target.why, mechanism: target.mechanism, docs: target.docs || [] });
  }

  const d = capabilities.declare({
    capability,
    support: target.support,
    canary,
    limitations: target.limitations || [],
    mechanism: target.mechanism,
    docs: target.docs || [],
    why: `an activation canary observed the hooks' own runtime artifacts on ${canary && canary.observedAt}`,
  });
  if (!d.downgraded) return d;

  // core's `why` already names the defect and, for a canary that ran and did not pass, the verdict it
  // recorded. Added here: the probe's own words, and what this profile is aiming at versus what it has
  // already been shown to do offline — neither of which core can know.
  const detail = canary && canary.why ? ` The probe's own words: ${canary.why}.` : '';
  return {
    ...d,
    why: `${d.why}.${detail} Target for this profile is ${target.support}. Proven offline: ${OFFLINE_PROOF[capability]}.`,
  };
}

/**
 * The whole profile.
 * @param canaryReport  a probe.js result, or null. Applied to every capability except requestCompact,
 *                       which needs none.
 */
function declareAll(canaryReport = null) {
  return capabilities.CAPABILITIES.map((cap) => declareOne(cap, canaryReport));
}

/** The matrix row for this profile, rolled up by core. */
function matrix(canaryReport = null) {
  return capabilities.matrix(PROFILE, declareAll(canaryReport));
}

module.exports = { PROFILE, TARGET, OFFLINE_PROOF, declareOne, declareAll, matrix };
