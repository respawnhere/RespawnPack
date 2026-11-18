/*
 * RespawnPack · adapters/claude-code/sdk-supervisor/measure.js — occupancy, and the honest account of
 * what is measured versus what is assumed.
 *
 * ⭐ THE NUMERATOR IS PUBLISHED. Every assistant message carries a `usage` block, and the occupied part
 * of the window is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the LATEST
 * one. These are documented API fields — core/lifecycle/evidence.js names exactly this case when it
 * maps the source `documented-api` to HIGH confidence ("SDK usage fields, statusline JSON,
 * getContextUsage()").
 *
 * ⛔ THE DENOMINATOR IS NOT, AND THAT IS THE WHOLE CAVEAT. There is no remaining-capacity call in this
 * protocol. The window size appears in exactly one place — `modelUsage[model].contextWindow` on a
 * result message — and whether it is populated is a runtime question this environment could not answer
 * (auth). So the budget is resolved in this order, and WHICH ONE WAS USED TRAVELS WITH THE NUMBER:
 *
 *   host-reported        modelUsage[…].contextWindow from the host's own result message.
 *   operator-configured  RESPAWNPACK_CLAUDE_CONTEXT_BUDGET, or the `contextBudgetTokens` option.
 *   assumed-default      1000000. A DEFAULT, not a reading — it matches the window every current Opus
 *                        and Sonnet actually has, so the common case is right rather than wrong by 5×.
 *                        A SMALLER window measured against it reads too EMPTY, which is the dangerous
 *                        direction: set the env var on Haiku 4.5 or any reduced-context deployment.
 *                        (This default was 200000 until the 1M window became universal outside Haiku.
 *                        The old value made the safe direction the automatic one, but it was wrong on
 *                        essentially every real session, and a denominator that is always wrong trains
 *                        operators to disregard the number attached to it.)
 *
 * ⛔ AND AN ASSUMED WINDOW MUST NOT BORROW THE NUMERATOR'S CONFIDENCE — WHICH THE MEASUREMENT'S OWN
 * SOURCE NOW SAYS. core has a declared tier for exactly this ratio: `documented-count-configured-window`
 * (MEDIUM), whose whole content is "the count is the host's, the window is ours". So the SOURCE this
 * module declares depends on where the denominator came from:
 *
 *   host-reported                          → `documented-api`                          (HIGH)
 *   operator-configured · assumed-default  → `documented-count-configured-window`      (MEDIUM)
 *
 * Both non-host-reported cases take the same tier because they are the same claim: a window we supplied.
 * A default is not a weaker configuration, it is an unconfigured one, and neither was published by the
 * host. core's threshold policy flags the FINAL threshold on anything that is not HIGH, so the operator
 * confirmation this used to raise by itself is now raised by the confidence the number carries.
 *
 * ⛔ `finalOnAssumedWindow` STAYS, AS A CONTROL RATHER THAN A COMPENSATION. It is computed
 * independently of core's rule and reported beside it, so a suite can assert that the two agree — the
 * day they disagree, one of them is wrong and neither would say so alone.
 */

'use strict';

const path = require('path');
const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));
const stream = require('./stream.js');

const { evidence, thresholds } = core;

// A default, and named as one everywhere it is used.
const DEFAULT_BUDGET_TOKENS = 1000000;
const BUDGET_ENV = 'RESPAWNPACK_CLAUDE_CONTEXT_BUDGET';

const BUDGET_SOURCE = {
  HOST_REPORTED: 'host-reported',
  OPERATOR_CONFIGURED: 'operator-configured',
  ASSUMED_DEFAULT: 'assumed-default',
};

/**
 * The declared measurement source for a ratio, decided by its DENOMINATOR. The numerator is a documented
 * API field either way; what changes is whether the window under it was published or supplied.
 * @param budget  a resolveBudget() result
 */
const measurementSource = (budget) => (budget && budget.hostReported
  ? 'documented-api'
  : 'documented-count-configured-window');

/**
 * Decide the denominator and say where it came from.
 * @returns {{tokens:number, source:string, hostReported:boolean, model:string|null, raw:any, why:string}}
 */
function resolveBudget({ observation = null, env = process.env, contextBudgetTokens = null } = {}) {
  if (observation) {
    const reported = stream.reportedContextWindow(observation);
    if (reported.ok) {
      return {
        tokens: reported.contextWindow,
        source: BUDGET_SOURCE.HOST_REPORTED,
        hostReported: true,
        model: reported.model,
        raw: reported.raw,
        why: `the host published contextWindow=${reported.contextWindow} for ${reported.model} on its own result message`,
      };
    }
  }

  const configured = contextBudgetTokens !== null && contextBudgetTokens !== undefined
    ? Number(contextBudgetTokens)
    : Number(env && env[BUDGET_ENV]);
  if (Number.isFinite(configured) && configured > 0) {
    return {
      tokens: configured,
      source: BUDGET_SOURCE.OPERATOR_CONFIGURED,
      hostReported: false,
      model: null,
      raw: { [BUDGET_ENV]: env && env[BUDGET_ENV], contextBudgetTokens },
      why: `the host published no context window; the operator configured ${configured}`,
    };
  }

  return {
    tokens: DEFAULT_BUDGET_TOKENS,
    source: BUDGET_SOURCE.ASSUMED_DEFAULT,
    hostReported: false,
    model: null,
    raw: null,
    why: `the host published no context window and nothing is configured, so ${DEFAULT_BUDGET_TOKENS} is ASSUMED — set ${BUDGET_ENV} for this model to measure against a real number`,
  };
}

/**
 * Measure one turn's occupancy.
 *
 * @returns {{measurable:boolean, usedPercent:number|null, usedTokens:number|null, budget, record:object|null, why:string|null}}
 *
 * An unmeasurable turn returns `usedPercent: null` and NO evidence record. It is never 0 — core's
 * threshold policy states the case: 0 is silence at the final threshold and 100 is a checkpoint every
 * turn, and an absent measurement is neither.
 */
function measure({ observation, env = process.env, contextBudgetTokens = null, observedAt = null } = {}) {
  const usage = stream.latestUsage(observation);
  const budget = resolveBudget({ observation, env, contextBudgetTokens });

  if (!usage.ok) {
    return { measurable: false, usedPercent: null, usedTokens: null, budget, record: null, why: usage.why };
  }

  const usedPercent = Math.min(100, (usage.usedTokens / budget.tokens) * 100);
  const record = evidence.make(evidence.KINDS.CONTEXT_MEASUREMENT, {
    source: measurementSource(budget),
    usedPercent,
    // The HOST's identity for the turn this number was read from. It is what makes a redelivered
    // measurement recognisable as one; an id minted here would be a counter of ours, and two turns
    // that happened to occupy the same number of tokens would collide.
    turnUuid: (observation.result && observation.result.msg && observation.result.msg.uuid) || null,
    // Typed beside the raw payload, never instead of it.
    usedTokens: usage.usedTokens,
    budgetTokens: budget.tokens,
    budgetSource: budget.source,
    windowHostReported: budget.hostReported,
    model: usage.model,
    mechanism: 'claude-code cli stream-json: usage block of the latest assistant message',
    raw: { usage: usage.raw, budget: budget.raw, budgetSource: budget.source, model: usage.model },
    ...(observedAt ? { observedAt } : {}),
  });

  return {
    measurable: true,
    usedPercent,
    usedTokens: usage.usedTokens,
    parts: usage.parts,
    budget,
    source: record.source,
    record,
    why: null,
  };
}

/**
 * Apply the cycle's threshold latches to a measurement. Thin on purpose: the policy lives in
 * core/policy/thresholds.js and this only supplies the number and re-states the assumed-window flag.
 */
function evaluate({ measurement, latchRecord, thresholdConfig = null }) {
  const normalized = thresholds.normalize(thresholdConfig);
  if (!normalized.ok) return { ok: false, why: normalized.reason };

  const source = measurementSource(measurement.budget);
  const ev = thresholds.evaluate({
    usedPercent: measurement.measurable ? measurement.usedPercent : null,
    source,
    thresholds: normalized.thresholds,
    record: latchRecord,
  });

  const windowAssumed = Boolean(measurement.budget && !measurement.budget.hostReported);
  return {
    ok: true,
    thresholds: normalized.thresholds,
    source,
    evaluation: ev,
    windowAssumed,
    /*
     * core flags a non-HIGH confidence at `final`, and the source above is MEDIUM exactly when the
     * denominator was ours — so core already covers this case. The flag is kept as an INDEPENDENT
     * second opinion, computed from the budget rather than from the confidence: it is reported beside
     * core's answer and the suite asserts the two agree. A compensation that has become a control is
     * worth keeping; deleting it would leave nothing to catch the day core's tier stops matching.
     */
    finalOnAssumedWindow: windowAssumed && ev.fire.includes('final'),
    requiresOperatorConfirmation: ev.requiresOperatorConfirmation || (windowAssumed && ev.fire.includes('final')),
  };
}

module.exports = { DEFAULT_BUDGET_TOKENS, BUDGET_ENV, BUDGET_SOURCE, measurementSource, resolveBudget, measure, evaluate };
