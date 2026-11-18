/*
 * RespawnPack · adapters/claude-code/sdk-supervisor/capabilities.js — what this profile CLAIMS, and the
 * canary each claim rests on.
 *
 * ⛔ THE DECLARATIONS CARRY TODAY'S CANARY, NOT THE TARGET. The v0.3 design records `claude-code/
 * sdk-supervisor` as a planned SUPPORTED profile. That plan is reproduced below under TARGET, where it
 * cannot be mistaken for a declaration — exactly as core/policy/capabilities.js keeps PLANNED separate
 * and has `fromPlan` refuse to promote it. In THIS environment the live activation canary exits
 * CANNOT_DETERMINE (the host answered an authentication failure), so every declaration below is
 * CANNOT_DETERMINE and says why in the host's own words.
 *
 * ⛔ AND A CANARY THAT RECORDED A FAILURE IS NOT AN ACTIVATION CANARY — WHICH IS NOW CORE'S RULE, NOT
 * THIS FILE'S. `capabilities.declare()` reads the canary's VERDICT as well as its shape, and refuses a
 * SUPPORTED / SUPPORTED_WITH_LIMITATIONS claim whose canary did not record OUTCOME PASS. This file used
 * to hold that guard itself, forwarding a non-PASS canary as `null` so core never saw it; it now hands
 * core the canary it actually has and lets core decide, adding only what core cannot know — the TARGET
 * this profile aims at and what has been proven offline. That is the difference between a compensation
 * and a diagnosis, and it matters: a compensation protects the file that contains it, and three other
 * adapters were each protecting themselves the same way.
 *   The suite proves BOTH halves — a PASS canary declares SUPPORTED, today's real CANNOT_DETERMINE
 * canary does not, and core refuses it directly when handed it — because a rule that only ever produces
 * one answer has not been shown to discriminate.
 */

'use strict';

const path = require('path');
const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));

const { capabilities, failures } = core;
const { SUPPORT } = capabilities;
const { OUTCOME } = failures;

const PROFILE = 'claude-code/sdk-supervisor';

/*
 * The v0.3 design's TARGET for this profile, per capability: what a passing canary would let it claim.
 * Data, not a declaration. Nothing in this file turns a row of this table into a support level.
 */
const TARGET = {
  probe: {
    support: SUPPORT.SUPPORTED,
    mechanism: '`claude --version` + one headless handshake turn; the init message enumerates the slash commands and reports the build',
    surface: 'cli',
    docs: ['CLI reference: --print, --output-format stream-json, --verbose', 'SDK: SDKSystemMessage(init).slash_commands'],
  },
  measureContext: {
    support: SUPPORT.SUPPORTED_WITH_LIMITATIONS,
    mechanism: 'usage block of the latest assistant message (input + cache_read + cache_creation) over the context window',
    surface: 'cli',
    limitations: [
      'there is no remaining-capacity call in this protocol; the denominator comes from modelUsage[…].contextWindow when the host populates it, and is otherwise ASSUMED (default 1000000 — the window every current Opus and Sonnet has; RESPAWNPACK_CLAUDE_CONTEXT_BUDGET to override, which a 200K-window model such as Haiku 4.5 requires)',
      'whether contextWindow is populated at runtime is unverified in this environment',
    ],
    docs: ['SDK: ModelUsage.contextWindow', 'SDK: per-assistant-message usage fields'],
  },
  settleOrStop: {
    support: SUPPORT.SUPPORTED_WITH_LIMITATIONS,
    mechanism: 'the host\'s own result message ends the turn; the supervisor issues the turns, so there is nothing to race',
    surface: 'cli',
    limitations: ['v0.3 does not interrupt a turn mid-stream — the supervisor waits for the result rather than claiming a settle it did not observe'],
    docs: ['CLI reference: --print emits one result message per turn'],
  },
  requestCompact: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'the documented `/compact` slash command dispatched into the same conversation with --resume',
    surface: 'cli',
    docs: ['SDK: slash_commands includes "compact"; only non-interactive-safe commands are dispatchable'],
  },
  observeCompact: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'the compact_boundary system message (success), compact_result:"failed" (failure), the host\'s "Not enough messages to compact." (no-op)',
    surface: 'cli',
    docs: ['SDK: SDKCompactBoundaryMessage.compact_metadata', 'SDK: SDKStatusMessage.compact_result / compact_error'],
  },
  injectHandoff: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'the verified handoff is claimed exactly once through the O_EXCL receipt and prepended to the next prompt',
    surface: 'cli',
    docs: ['core/lifecycle/consumable.js'],
  },
  resume: {
    support: SUPPORT.SUPPORTED,
    mechanism: '--resume <session_id> against the same conversation; the id is compared before and after every compaction',
    surface: 'cli',
    docs: ['CLI reference: --resume', 'SDK: session_id on every result message'],
  },
};

/** What each capability has been proven to do OFFLINE, against fixtures. Never a support level. */
const OFFLINE_PROOF = {
  probe: 'the executable resolver, the argv builder and the auth classifier are driven by the captured streams',
  measureContext: 'occupancy arithmetic and budget provenance are driven by synthetic usage blocks with known answers',
  settleOrStop: 'a killed turn and a resultless turn both refuse to produce a boundary record',
  requestCompact: 'the /compact turn is not spawned unless the machine APPLIED request-compact from HANDOFF_VERIFIED',
  observeCompact: 'the three-way verdict is driven by the REAL captured failure (which reports is_error:false / subtype:"success") and by synthetic boundary and no-op streams',
  injectHandoff: 'a second consumption of the same handoff returns ALREADY_CONSUMED pointing at the first',
  resume: '--resume carries the observed session id, and the identity comparison halts on a mismatch',
};

/**
 * Turn one capability's canary into a declaration.
 *
 * The TARGET is always what is claimed; core decides whether the canary in hand lets it stand. The only
 * thing added afterwards is the part core has no way to know.
 *
 * @param capability  one of core's seven
 * @param canary      { ran, kind, observedAt, raw, outcome, why } — `outcome` must be PASS for the
 *                    target to stand, and core is what checks that
 */
function declareOne(capability, canary) {
  const target = TARGET[capability];
  if (!target) throw new Error(`no target recorded for capability ${capability}`);

  const d = capabilities.declare({
    capability,
    support: target.support,
    canary,
    limitations: target.limitations || [],
    mechanism: target.mechanism,
    docs: target.docs || [],
    why: `an activation canary observed this capability working on ${canary && canary.observedAt}`,
  });
  if (!d.downgraded) return d;

  /*
   * core refused the claim and its `why` already names the defect — no canary, a canary that did not
   * pass and which verdict it recorded, a canary with no verbatim payload. What core cannot say is that
   * this profile HAS a target and that the capability is proven offline, which is the difference between
   * "unproven here" and "unbuilt". The host's own words for the failure travel too, from the canary.
   */
  const detail = canary && canary.why ? ` The host's own words: ${canary.why}.` : '';
  return {
    ...d,
    why: `${d.why}.${detail} Target for this profile is ${target.support}, and a target is not an observation. `
      + `Proven offline against fixtures: ${OFFLINE_PROOF[capability]}.`,
  };
}

/**
 * The whole profile.
 *
 * @param canaryReport  { outcome, observedAt, why, raw, ran, perCapability?: {cap: canary} }
 *                      A single overall canary applies to every capability unless perCapability names one.
 */
function declareAll(canaryReport = null) {
  return capabilities.CAPABILITIES.map((cap) => {
    const per = canaryReport && canaryReport.perCapability && canaryReport.perCapability[cap];
    return declareOne(cap, per || canaryReport);
  });
}

/** The matrix row for this profile, rolled up by core. */
function matrix(canaryReport = null) {
  return capabilities.matrix(PROFILE, declareAll(canaryReport));
}

/**
 * The canary record for a probe that could not authenticate. Built here so the canary script and the
 * suite produce the SAME shape, and so the verbatim host words travel with it.
 */
function canaryFromProbe(probeResult, { observedAt = null } = {}) {
  const verbatim = probeResult && probeResult.verbatim ? probeResult.verbatim : {};
  return {
    ran: true,
    kind: 'claude-code-sdk-supervisor-activation',
    observedAt: observedAt || new Date().toISOString(),
    outcome: probeResult ? probeResult.outcome : OUTCOME.CANNOT_DETERMINE,
    why: probeResult ? (probeResult.why || null) : 'no probe was run',
    // A canary with no verbatim payload is refused by core; this keeps whatever the host actually said.
    raw: JSON.stringify({
      version: probeResult && probeResult.version,
      exePath: probeResult && probeResult.exePath,
      structural: probeResult && probeResult.structural,
      authMessage: verbatim.authMessage || null,
      stderr: verbatim.stderr || '',
      lines: verbatim.lines || [],
    }),
  };
}

module.exports = { PROFILE, TARGET, OFFLINE_PROOF, declareOne, declareAll, matrix, canaryFromProbe };
