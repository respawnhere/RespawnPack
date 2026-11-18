/*
 * RespawnPack · adapters/codex/app-server/capabilities.js — what this profile CLAIMS, and the canary
 * each claim rests on.
 *
 * ⛔ THE DECLARATIONS CARRY TODAY'S CANARY, NOT THE TARGET. The v0.3 design records
 * `codex/app-server` as a planned SUPPORTED profile. That plan is reproduced below under TARGET, where
 * it cannot be mistaken for a declaration — exactly as core/policy/capabilities.js keeps PLANNED
 * separate and has `fromPlan` refuse to promote it.
 *
 * ⛔ AND A CANARY THAT RECORDED A FAILURE IS NOT AN ACTIVATION CANARY — CORE'S RULE NOW, NOT THIS
 * FILE'S. `capabilities.declare()` reads the canary's VERDICT as well as its shape and refuses a
 * SUPPORTED / SUPPORTED_WITH_LIMITATIONS claim whose canary did not record OUTCOME PASS. This file used
 * to withhold a non-PASS canary from core so the shape check could not be satisfied by it; it now hands
 * core what it has and adds only the target and the offline proof — the parts core cannot know. The
 * suite proves BOTH halves, because a rule that only ever produces one answer has not been shown to
 * discriminate.
 *
 * ⭐ THIS IS THE FIRST PROFILE IN THE PACK WHOSE LIVE CANARY COULD ACTUALLY RUN. Codex is installed and
 * authenticated on the machine this was built on, so `canary.js` drove three consecutive in-place
 * rollovers against the real host. What that run observed is in fixtures/captured/ with its digest
 * recorded; what it did NOT observe is still CANNOT_DETERMINE here, and the two are never averaged.
 */

'use strict';

const path = require('path');
const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));

const { capabilities, failures } = core;
const { SUPPORT } = capabilities;
const { OUTCOME } = failures;

const PROFILE = 'codex/app-server';

/*
 * The v0.3 design's TARGET for this profile, per capability: what a passing canary would let it claim.
 * Data, not a declaration. Nothing in this file turns a row of this table into a support level.
 */
const TARGET = {
  probe: {
    support: SUPPORT.SUPPORTED_WITH_LIMITATIONS,
    mechanism: '`node <codex.js> --version`, `generate-json-schema --experimental`, and the mandatory `initialize` handshake over the app-server JSONL transport',
    surface: 'app-server',
    limitations: [
      'the app server is an EXPERIMENTAL surface: `initialize` must pass capabilities.experimentalApi, and the request inventory is regenerated per run because it can move between builds',
      'the handshake runs BEFORE credentials are used, so a green probe does not prove authentication — the first COMPLETED turn does',
    ],
    docs: ['codex app-server generate-json-schema --experimental (ClientRequest.json)', 'captured: -32600 "Not initialized" for a pre-handshake request'],
  },
  measureContext: {
    support: SUPPORT.SUPPORTED_WITH_LIMITATIONS,
    mechanism: 'thread/tokenUsage/updated: last.inputTokens over modelContextWindow, both published by the host',
    surface: 'app-server',
    limitations: [
      'the field names inside tokenUsage are undocumented — the event is documented, its shape is read from live capture, so the verbatim payload travels on every measurement record',
      'for one turn after a compaction the `last` block reports a non-zero totalTokens with every component at 0; occupancy is CANNOT_DETERMINE until the next turn, never 0%',
      'modelContextWindow is nullable; when the host publishes none there is no denominator and occupancy is CANNOT_DETERMINE unless an operator configures one',
    ],
    docs: ['captured: thread/tokenUsage/updated with modelContextWindow 258400', 'captured: the post-compaction all-zero-components row'],
  },
  settleOrStop: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'turn/completed for the turn this supervisor started; turn/interrupt is available and is only sent after the turn/started notification',
    surface: 'app-server',
    docs: ['captured: turn/start → turn/started → item/* → turn/completed', 'captured: -32600 "no active turn to interrupt" before turn/started'],
  },
  requestCompact: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'thread/compact/start {threadId} — a first-class request method in the host\'s own ClientRequest schema',
    surface: 'app-server',
    docs: ['ClientRequest.json declares thread/compact/start with required threadId'],
  },
  observeCompact: {
    support: SUPPORT.SUPPORTED_WITH_LIMITATIONS,
    mechanism: 'the contextCompaction item reaching item/completed on the same threadId; the immediate `{}` ack is never read as completion',
    surface: 'app-server',
    limitations: [
      'the contextCompaction item carries only {id,type} — there is no pre/post token metadata to corroborate the compaction with',
      'a genuine no-op compaction has never been observed on this host, so an ack plus a turn/completed with no item is reported as COMPLETION_UNOBSERVED with a no-op-candidate flag rather than resolved either way',
    ],
    docs: ['captured: item/started → item/completed, same item id, ~1.8s, on a 15.7k/258.4k thread'],
  },
  injectHandoff: {
    support: SUPPORT.SUPPORTED,
    mechanism: 'the verified handoff is claimed exactly once through the O_EXCL receipt and prepended to the next turn/start input',
    surface: 'app-server',
    docs: ['core/lifecycle/consumable.js'],
  },
  resume: {
    support: SUPPORT.SUPPORTED_WITH_LIMITATIONS,
    mechanism: 'the threadId is constant across compaction and is re-checked against a thread/resume every rollover',
    surface: 'app-server',
    limitations: [
      'approvalPolicy is NOT persisted across an app-server restart (sandbox is), so every thread/resume must re-pass the whole policy set — a resume that omits it silently reverts to on-request',
      'a resumed thread renumbers its items item-1, item-2, …, so nothing may be correlated across a cold resume by item id',
    ],
    docs: ['captured: resume without approvalPolicy came back "on-request" on a thread started "never"', 'captured: live item ids are uuidv7, persisted ids are item-N'],
  },
};

/** What each capability has been proven to do OFFLINE, against fixtures. Never a support level. */
const OFFLINE_PROOF = {
  probe: 'the executable resolver, the schema loader and the outbound validator are driven by the captured schema and by a fake transport',
  measureContext: 'the occupancy arithmetic, the post-compaction all-zero row and the null-window case are driven by captured tokenUsage payloads with known answers',
  settleOrStop: 'a turn that never completed refuses to produce a boundary, and an interrupt before turn/started is refused rather than sent into the captured race',
  requestCompact: 'thread/compact/start is not sent unless the machine APPLIED request-compact from HANDOFF_VERIFIED',
  observeCompact: 'the verdict is driven by the REAL captured contextCompaction pair, by an ack-without-item stream, by a duplicate item/completed and by an identity-changed stream',
  injectHandoff: 'a second consumption of the same handoff returns ALREADY_CONSUMED pointing at the first',
  resume: 'the identity comparison halts on a mismatch, and the resume re-check asserts the re-passed approvalPolicy came back in force',
};

/**
 * Turn one capability's canary into a declaration.
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
    why: `a live activation canary observed this capability working on ${canary && canary.observedAt}`,
  });
  if (!d.downgraded) return d;

  // core's `why` names the defect and the verdict; this adds the host's own words for it, plus what
  // this profile is aiming at and what the fixtures have already shown offline.
  const detail = canary && canary.why ? ` The host's own words: ${canary.why}.` : '';
  return {
    ...d,
    why: `${d.why}.${detail} Target for this profile is ${target.support}, and a target is not an observation. `
      + `Proven offline against fixtures: ${OFFLINE_PROOF[capability]}.`,
  };
}

/**
 * The whole profile.
 * @param canaryReport  { outcome, observedAt, why, raw, ran, perCapability?: {cap: canary} }
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
 * The canary record for a completed run. Built here so the canary script and the suite produce the
 * SAME shape, and so the verbatim host payloads travel with it.
 */
function canaryFromReport(report, { observedAt = null } = {}) {
  return {
    ran: true,
    kind: 'codex-app-server-supervisor-activation',
    observedAt: observedAt || (report && report.endedAt) || new Date().toISOString(),
    outcome: report ? report.outcome : OUTCOME.CANNOT_DETERMINE,
    why: report ? (report.firstProblem || null) : 'no canary was run',
    // A canary with no verbatim payload is refused by core; this keeps what the host actually said.
    raw: JSON.stringify({
      profile: PROFILE,
      codexVersion: report && report.environment ? report.environment.codexVersion : null,
      codexJs: report && report.environment ? report.environment.codexJs : null,
      threadId: report ? report.threadId : null,
      rollovers: report && report.rollovers ? report.rollovers.map((r) => ({
        index: r.index, cycleBefore: r.cycleBefore, cycleAfter: r.cycleAfter,
        itemId: r.itemId || null, compactTurnId: r.compactTurnId || null,
        claims: (r.claims || []).map((c) => ({ name: c.name, outcome: c.outcome })),
      })) : [],
      claims: report && report.claims ? report.claims.map((c) => ({ name: c.name, outcome: c.outcome })) : [],
      eventLog: report ? report.eventLog || null : null,
    }),
  };
}

module.exports = { PROFILE, TARGET, OFFLINE_PROOF, declareOne, declareAll, matrix, canaryFromReport };
