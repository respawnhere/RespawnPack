/*
 * RespawnPack · adapters/claude-code/interactive/interactive.test.mjs — behavioral tests for the
 * interactive hooks profile's capability declarations (profile.js) and activation canary (probe.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const core = require_(path.join(HERE, '..', '..', '..', 'core', 'index.js'));
const { probe } = require_(path.join(HERE, 'probe.js'));
const { PROFILE, TARGET, declareOne, declareAll, matrix } = require_(path.join(HERE, 'profile.js'));

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rp-interactive-'));
}
function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

// ---------------------------------------------------------------------------------------------
describe('profile.js · declarations never exceed what a canary actually observed', () => {
  test('requestCompact is NOT_SUPPORTED unconditionally — no canary changes it', () => {
    const withCanary = declareOne('requestCompact', { ran: true, kind: 'x', observedAt: new Date().toISOString(), raw: '{}', outcome: 'PASS' });
    const withoutCanary = declareOne('requestCompact', null);
    assert.equal(withCanary.support, core.capabilities.SUPPORT.NOT_SUPPORTED);
    assert.equal(withoutCanary.support, core.capabilities.SUPPORT.NOT_SUPPORTED);
    assert.match(withoutCanary.why, /cannot invoke a slash command/);
    assert.equal(withCanary.downgraded, false, 'a well-formed NOT_SUPPORTED declaration must not be downgraded');
  });

  test('every OTHER capability is CANNOT_DETERMINE with no canary — a plan is not an observation', () => {
    for (const cap of core.capabilities.CAPABILITIES) {
      if (cap === 'requestCompact') continue;
      const d = declareOne(cap, null);
      assert.equal(d.support, core.capabilities.SUPPORT.CANNOT_DETERMINE, `${cap} was declared ${d.support} with no canary`);
      assert.match(d.why, /no activation canary/);
    }
  });

  test('a PASSING canary promotes a capability to its TARGET support level', () => {
    const canary = { ran: true, kind: 'claude-interactive-hooks-activation', observedAt: new Date().toISOString(), raw: '{"ok":true}', outcome: 'PASS', why: null };
    for (const cap of core.capabilities.CAPABILITIES) {
      if (cap === 'requestCompact') continue;
      const d = declareOne(cap, canary);
      assert.equal(d.support, TARGET[cap].support, `${cap}: expected the TARGET support level on a passing canary`);
      assert.equal(d.downgraded, false, `${cap} was downgraded despite a passing canary: ${d.why}`);
    }
  });

  test('a canary that ran and FAILED is not the same as no canary — both report CANNOT_DETERMINE but the reason differs', () => {
    const failed = { ran: true, kind: 'x', observedAt: new Date().toISOString(), raw: '{}', outcome: 'CANNOT_DETERMINE', why: 'the baseline was never written' };
    const d = declareOne('measureContext', failed);
    assert.equal(d.support, core.capabilities.SUPPORT.CANNOT_DETERMINE);
    assert.match(d.why, /the baseline was never written/, 'the canary\'s own reason must survive into the declaration');
  });

  test('declareAll covers exactly the seven capabilities, and matrix() rolls it up under the right profile name', () => {
    const all = declareAll(null);
    assert.deepEqual(all.map((d) => d.capability).sort(), [...core.capabilities.CAPABILITIES].sort());
    const row = matrix(null);
    assert.equal(row.profile, PROFILE);
    assert.equal(PROFILE, 'claude-interactive-hooks');
    // requestCompact is a REQUIRED rollover capability and is NOT_SUPPORTED without a supervisor —
    // so this profile alone can never claim rolloverCapable, and must say which capability blocks it.
    assert.equal(row.rolloverCapable, false);
    assert.ok(row.unmet.includes('requestCompact'));
  });
});

// ---------------------------------------------------------------------------------------------
describe('probe.js · the activation canary distinguishes installed from active', () => {
  test('no runtime artifacts at all → CANNOT_DETERMINE, never PASS', () => {
    const dir = tmpProject();
    try {
      const r = probe({ projectDir: dir, sessionId: 'sess-probe-1' });
      assert.equal(r.outcome, 'CANNOT_DETERMINE');
      assert.match(r.why, /baseline/);
      assert.equal(r.ran, true);
      assert.ok(r.raw && r.raw.length, 'a canary with no verbatim payload would be refused by core.capabilities.canaryUsable');
    } finally { rm(dir); }
  });

  test('a real SessionStart baseline with no latch file yet → PASS (a fresh session has nothing to latch)', () => {
    const dir = tmpProject();
    const sid = 'sess-probe-2';
    try {
      const baselineDir = path.join(dir, '.respawnpack', 'runtime');
      fs.mkdirSync(baselineDir, { recursive: true });
      fs.writeFileSync(path.join(baselineDir, `session-${sid}.json`), JSON.stringify({
        sessionId: sid, head: null, files: {}, capturedAt: new Date().toISOString(),
        workingDigest: 'abc123', stagedDigest: 'def456', indexPath: null,
      }));
      const r = probe({ projectDir: dir, sessionId: sid });
      assert.equal(r.outcome, 'PASS', r.why);
      assert.match(r.why, /latch file was not/);
    } finally { rm(dir); }
  });

  test('a fabricated baseline that does not match the session id being probed is NOT accepted as evidence', () => {
    const dir = tmpProject();
    const sid = 'sess-probe-3';
    try {
      const baselineDir = path.join(dir, '.respawnpack', 'runtime');
      fs.mkdirSync(baselineDir, { recursive: true });
      // A baseline for a DIFFERENT session — an installed-but-never-run hook cannot fabricate this.
      fs.writeFileSync(path.join(baselineDir, `session-${sid}.json`), JSON.stringify({
        sessionId: 'some-other-session', capturedAt: new Date().toISOString(), workingDigest: 'abc123',
      }));
      const r = probe({ projectDir: dir, sessionId: sid });
      assert.equal(r.outcome, 'CANNOT_DETERMINE', 'a baseline whose own sessionId disagrees with the probed session must not pass');
    } finally { rm(dir); }
  });

  test('a real baseline AND a real latch file for this conversation → PASS, and both are named', () => {
    const dir = tmpProject();
    const sid = 'sess-probe-4';
    try {
      const baselineDir = path.join(dir, '.respawnpack', 'runtime');
      fs.mkdirSync(baselineDir, { recursive: true });
      fs.writeFileSync(path.join(baselineDir, `session-${sid}.json`), JSON.stringify({
        sessionId: sid, capturedAt: new Date().toISOString(), workingDigest: 'abc123',
      }));
      const cdir = core.cycle.conversationDir(dir, 'claude-code', sid);
      fs.mkdirSync(cdir, { recursive: true });
      fs.writeFileSync(path.join(cdir, 'thresholds.json'), JSON.stringify({
        kind: 'threshold-latches', cycleId: `claude-code:${sid}:0:unestablished`, latched: { 60: { at: new Date().toISOString(), atPercent: 60 } },
      }));
      const r = probe({ projectDir: dir, sessionId: sid });
      assert.equal(r.outcome, 'PASS', r.why);
      assert.match(r.why, /both found and well-formed/);
    } finally { rm(dir); }
  });

  test('missing projectDir/sessionId is CANNOT_DETERMINE, never a throw', () => {
    assert.doesNotThrow(() => probe({}));
    const r = probe({});
    assert.equal(r.outcome, 'CANNOT_DETERMINE');
  });
});
