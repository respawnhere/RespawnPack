/*
 * RespawnPack · adapters/claude-code/interactive/probe.js — the activation canary for the interactive
 * hooks profile: proof the hooks RAN, not proof the hook FILES are installed.
 *
 * ⛔ WHAT COUNTS AS EVIDENCE, AND WHAT DOES NOT. `.claude/hooks/session-routing-nudge.js` existing on disk
 * proves an installer copied a file; it proves nothing about whether Claude Code has ever invoked it.
 * core/policy/capabilities.js states the rule this file exists to satisfy: "installing files is not proof
 * that a capability is active." So this probe looks for RUNTIME ARTIFACTS a hook can only have produced by
 * actually running for THIS conversation:
 *
 *   .respawnpack/runtime/session-<sessionId>.json         written by hooks/session-routing-nudge.js's
 *                                                          captureBaseline(), on EVERY SessionStart.
 *   .respawnpack/runtime/rollover/claude-code-<sessionId>/thresholds.json
 *                                                          written by hooks/context-monitor.js the first
 *                                                          time a configured context threshold fires.
 *
 * ⛔ THE LATCH FILE'S ABSENCE IS NOT A FAILURE. A conversation that has not yet crossed 60% of its context
 * budget will legitimately have no thresholds.json — context-monitor.js has had nothing to report. Gating
 * PASS on both files existing would report a healthy, freshly-started session as broken. So PASS requires
 * the SessionStart baseline (guaranteed on every session) to exist and look real; the latch file, when
 * present, is recorded as ADDITIONAL corroboration, never as a second requirement.
 *
 * ⛔ "LOOKS REAL" IS CHECKED, NOT ASSUMED. A baseline is accepted only when its own `sessionId` matches the
 * one being probed and it carries the fields captureBaseline() actually writes (`workingDigest`,
 * `capturedAt`) — a file that merely exists is not the same claim as a file this profile's own hook wrote
 * for this conversation.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const core = require(path.join(__dirname, '..', '..', '..', 'core', 'index.js'));
const { evidence, failures } = core;
const { OUTCOME } = failures;

const KIND = 'claude-interactive-hooks-activation';
const HOST = evidence.HOSTS.CLAUDE_CODE;

const safeId = (id) => String(id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

function readJSON(file) {
  try { return { doc: JSON.parse(fs.readFileSync(file, 'utf8')), err: null }; }
  catch (e) { return { doc: null, err: (e && e.code) || (e && e.message) || 'unreadable' }; }
}

/** A parseable, not-absurdly-future timestamp. The freshness check this canary can honestly make about a
 * record with no fixed lifetime — see the file header for why a numeric age window does not apply here. */
function looksLikeATimestamp(s) {
  if (typeof s !== 'string' || !s) return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && t <= Date.now() + 60000; // a minute of clock skew tolerance, no more
}

/**
 * @param {{projectDir:string, sessionId:string}} args
 * @returns {{ran:true, kind:string, observedAt:string, outcome:string, why:string|null, raw:string}}
 */
function probe({ projectDir, sessionId } = {}) {
  const observedAt = new Date().toISOString();
  if (!projectDir || !sessionId) {
    return {
      ran: true, kind: KIND, observedAt, outcome: OUTCOME.CANNOT_DETERMINE,
      why: 'probe() needs both projectDir and sessionId to look for THIS conversation\'s own runtime artifacts — neither may be inferred',
      raw: JSON.stringify({ projectDir: projectDir || null, sessionId: sessionId || null }),
    };
  }

  const sid = String(sessionId);
  const baselinePath = path.join(projectDir, '.respawnpack', 'runtime', `session-${safeId(sid)}.json`);
  const cdir = core.cycle.conversationDir(projectDir, HOST, sid);
  const latchPath = core.thresholds.latchPath(cdir);

  const { doc: baseline, err: baselineErr } = readJSON(baselinePath);
  const { doc: latch, err: latchErr } = readJSON(latchPath);

  const baselineOk = Boolean(
    baseline && baseline.sessionId === sid
    && typeof baseline.workingDigest === 'string' && baseline.workingDigest
    && looksLikeATimestamp(baseline.capturedAt),
  );
  const latchOk = Boolean(latch && typeof latch.cycleId === 'string' && latch.cycleId && latch.latched && typeof latch.latched === 'object' && !Array.isArray(latch.latched));

  const raw = JSON.stringify({
    baselinePath, baselineFound: Boolean(baseline), baselineOk, baselineErr,
    latchPath, latchFound: Boolean(latch), latchOk, latchErr,
  });

  if (!baselineOk) {
    return {
      ran: true, kind: KIND, observedAt, outcome: OUTCOME.CANNOT_DETERMINE,
      why: `SessionStart's own baseline (${baselinePath}) was not found or did not look real `
        + `(${baselineErr || 'present but missing sessionId/workingDigest/capturedAt'}) — an installed hook `
        + 'FILE is not evidence that it has ever run for this conversation.',
      raw,
    };
  }

  return {
    ran: true, kind: KIND, observedAt, outcome: OUTCOME.PASS,
    why: latchOk
      ? 'SessionStart\'s baseline and context-monitor\'s per-cycle latch file were both found and well-formed for this conversation'
      : 'SessionStart\'s baseline was found and well-formed; context-monitor\'s latch file was not — expected for '
        + 'a conversation that has not yet crossed a configured context threshold, not evidence of a broken hook',
    raw,
  };
}

module.exports = { probe, KIND, HOST };
