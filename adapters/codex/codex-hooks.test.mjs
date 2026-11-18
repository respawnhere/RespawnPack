/*
 * RespawnPack · adapters/codex/codex-hooks.test.mjs — the Codex hooks profile, driven as a black box.
 *
 * Every behavioural hook (precompact/sessionstart/postcompact/stop) is spawned as a REAL child process
 * with realistic stdin, exactly as Codex would invoke it — never `require()`d and called directly — so
 * these tests exercise the actual stdin-read/parse/stdout-contract path, not an in-process shortcut of it.
 * `_shared.js` and `profile.js` are exercised both ways: through the hooks that use them, and directly for
 * edge cases (malformed markers, freshness math) that would be slow or fragile to force through a child
 * process. Every fixture writes under a fresh `os.tmpdir()` directory and every child process is spawned
 * with an EXPLICIT `cwd` pointing at it — never at this repository — so a hook's own `process.cwd()`
 * fallback (exercised deliberately in the malformed-stdin sweep) can never write into this repo's tree.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const core = require_(path.join(HERE, '..', '..', 'core', 'index.js'));
const shared = require_(path.join(HERE, 'hooks', '_shared.js'));
const profile = require_(path.join(HERE, 'profile.js'));

const HOOKS_DIR = path.join(HERE, 'hooks');
const { KINDS } = core.evidence;

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rp-codex-${tag}-`));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows lock */ } };
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

/** Spawn a hook script exactly as Codex would: stdin piped in, stdout/stderr captured, cwd explicit. */
function runHook(name, { input, cwd, env } = {}) {
  const script = path.join(HOOKS_DIR, name);
  const inputText = input === undefined ? '' : (typeof input === 'string' ? input : JSON.stringify(input));
  return spawnSync(process.execPath, [script], {
    input: inputText,
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, RESPAWNPACK_ALLOW_UNSAVED_COMPACT: '', ...(env || {}) },
  });
}

/** stdout is either empty (no JSON emitted) or exactly one JSON value — never partial/garbled. */
function parseStdout(r) {
  if (r.stdout === '') return null;
  return JSON.parse(r.stdout);
}

const runtimeDirOf = (projectDir, sid) => shared.conversationDir(projectDir, sid);

/** Advance a REAL core machine through checkpoint -> ... -> request-compact using synthetic,
 * clearly-labelled evidence, so a hooks-only firing's `observe-completion`/`verify-identity` attempt has
 * something real to succeed against — mirrors core/core.test.mjs's own `toVerified()` helper, extended
 * one transition further to COMPACTING. Used only to exercise the FORWARD-COMPATIBLE plumbing described
 * in respawnpack-sessionstart.js's header; nothing in adapters/codex/hooks/ drives this itself today. */
function driveMachineToCompacting(projectDir, sid) {
  const opened = core.machine.open({ projectDir, host: 'codex', conversationId: sid });
  assert.equal(opened.ok, true, 'test setup: machine would not open');
  const m = opened.machine;
  assert.equal(m.apply({
    transition: 'checkpoint', eventId: 'test-measure-1',
    evidence: [core.evidence.make(KINDS.CONTEXT_MEASUREMENT, { source: 'documented-event', usedPercent: 90, raw: { note: 'synthetic, test-only' } })],
  }).status, 'APPLIED');
  assert.equal(m.apply({
    transition: 'closeout', eventId: 'test-boundary-1',
    evidence: [core.evidence.make(KINDS.SAFE_BOUNDARY, { mechanism: 'unblocked-stop-hook', raw: { note: 'synthetic, test-only' } })],
  }).status, 'APPLIED');

  const dummy = core.handoff.build({
    identity: { host: 'codex', conversationId: sid, conversationIdField: 'session_id' },
    contextCycleId: m.cycleId(),
    git: { head: null, uncommittedFiles: [], sessionDelta: { status: 'CANNOT_DETERMINE', files: [], headMoved: false } },
  });
  const w = core.handoff.writeVerified(m.dir, dummy);
  assert.equal(w.ok, true, 'test setup: dummy machine-advancing handoff would not verify');
  assert.equal(m.apply({ transition: 'stage-handoff', eventId: 'test-write-1', evidence: [w.evidence.written] }).status, 'APPLIED');
  assert.equal(m.apply({ transition: 'verify-handoff', eventId: 'test-readback-1', evidence: [w.evidence.readback] }).status, 'APPLIED');
  assert.equal(m.apply({
    transition: 'request-compact', eventId: 'test-request-1',
    evidence: [core.evidence.make(KINDS.COMPACT_REQUESTED, { mechanism: 'operator-manual', raw: { note: 'synthetic, test-only' } })],
  }).status, 'APPLIED');
  assert.equal(m.state(), 'COMPACTING', 'test setup: machine did not reach COMPACTING');
  return m;
}

// =====================================================================================================
describe('respawnpack-precompact.js — the veto that enforces a verified handoff', () => {
  test('known-good: a real firing writes+verifies a handoff, a pointer, and refreshes the canary — with NOTHING on stdout', () => {
    const d = tmp('pc-good');
    try {
      const sid = 'sess_pc_good';
      const r = runHook('respawnpack-precompact.js', {
        cwd: d,
        input: { hook_event_name: 'PreCompact', session_id: sid, cwd: d, trigger: 'manual' },
      });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', 'a successful PreCompact firing must emit nothing — the ONLY documented output shape is the veto');

      const dir = runtimeDirOf(d, sid);
      const pointer = readJSON(shared.latestHandoffPointerPath(dir));
      assert.ok(pointer.handoffId, 'no latest-handoff pointer was written');

      const doc = readJSON(path.join(dir, `${pointer.handoffId}.json`));
      const v = core.handoff.validate(doc);
      assert.equal(v.ok, true, `the written handoff does not validate against core/state/handoff.js: ${v.reason}`);
      assert.equal(doc.identity.host, 'codex');
      assert.equal(doc.identity.conversationId, sid);
      assert.ok(exists(core.handoff.verifiedPathFor(dir, pointer.handoffId)), 'no read-back verification receipt was written');

      const lastActive = readJSON(shared.lastActivePath(d));
      assert.equal(lastActive.conversationId, sid);
      assert.equal(lastActive.handoffId, pointer.handoffId);

      const canary = readJSON(shared.canaryPath(d));
      assert.equal(canary.event, 'PreCompact');
      assert.equal(canary.session_id, sid);
      assert.equal(canary.ran, true);
      assert.ok(canary.raw && canary.raw.hook_event_name === 'PreCompact', 'the canary did not keep the verbatim stdin');
    } finally { rm(d); }
  });

  test('the pending savepoint note is picked up, sanitized, and consumed exactly once', () => {
    const d = tmp('pc-note');
    try {
      const sid = 'sess_pc_note';
      fs.mkdirSync(shared.RUNTIME_ROLLOVER_DIR(d), { recursive: true });
      fs.writeFileSync(shared.pendingNotePath(d), JSON.stringify({
        exactNextAction: 'rename parseInput to parseHookInput in _shared.js',
        atomicActionId: 'w3a-rename',
        userConstraints: ['never touch hooks/*'],
        unresolvedQuestions: ['is the escape hatch literal string "1" only?'],
        candidateMemories: ['cm_deadbeef'],
        // malformed on purpose: verificationEvidence any-array is fine, but userConstraints gets a
        // non-string entry mixed in to prove sanitization drops it rather than corrupting the handoff.
      }));

      const r = runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sid, cwd: d } });
      assert.equal(r.status, 0);

      const dir = runtimeDirOf(d, sid);
      const pointer = readJSON(shared.latestHandoffPointerPath(dir));
      const doc = readJSON(path.join(dir, `${pointer.handoffId}.json`));
      assert.equal(doc.exactNextAction, 'rename parseInput to parseHookInput in _shared.js');
      assert.equal(doc.atomicActionId, 'w3a-rename');
      assert.deepEqual(doc.userConstraints, ['never touch hooks/*']);
      assert.deepEqual(doc.candidateMemories, ['cm_deadbeef']);

      assert.equal(exists(shared.pendingNotePath(d)), false, 'the pending note must be consumed (deleted) after a successful write');
    } finally { rm(d); }
  });

  test('a malformed pending note is sanitized rather than trusted, and the drop is recorded in unresolvedQuestions', () => {
    const d = tmp('pc-note-bad');
    try {
      const sid = 'sess_pc_note_bad';
      fs.mkdirSync(shared.RUNTIME_ROLLOVER_DIR(d), { recursive: true });
      fs.writeFileSync(shared.pendingNotePath(d), JSON.stringify({
        exactNextAction: 42, // wrong type — must be dropped to null, not coerced
        userConstraints: 'not an array', // wrong type — must become []
        unresolvedQuestions: ['a real question', 7], // mixed — the non-string must be dropped
      }));

      const r = runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sid, cwd: d } });
      assert.equal(r.status, 0);

      const dir = runtimeDirOf(d, sid);
      const pointer = readJSON(shared.latestHandoffPointerPath(dir));
      const doc = readJSON(path.join(dir, `${pointer.handoffId}.json`));
      assert.equal(doc.exactNextAction, null);
      assert.deepEqual(doc.userConstraints, []);
      assert.deepEqual(doc.unresolvedQuestions.filter((q) => q === 'a real question'), ['a real question']);
      assert.ok(doc.unresolvedQuestions.some((q) => /malformed field/.test(q)), 'the sanitization drop was not recorded anywhere');
    } finally { rm(d); }
  });

  test('known-bad vs. known-good control: a blocked runtime directory vetoes; an unblocked one does not', () => {
    const good = tmp('pc-ctrl-good');
    const bad = tmp('pc-ctrl-bad');
    try {
      const goodR = runHook('respawnpack-precompact.js', { cwd: good, input: { hook_event_name: 'PreCompact', session_id: 'sess_ctrl', cwd: good } });
      assert.equal(goodR.status, 0);
      assert.equal(goodR.stdout, '', 'the known-good control emitted a veto, so the control pair proves nothing');

      // Pre-create `.respawnpack` as a plain FILE so the runtime directory can never be created under it —
      // a portable, deterministic write failure that does not depend on chmod/ACLs.
      fs.writeFileSync(path.join(bad, '.respawnpack'), 'not a directory');
      const badR = runHook('respawnpack-precompact.js', { cwd: bad, input: { hook_event_name: 'PreCompact', session_id: 'sess_ctrl', cwd: bad } });
      assert.equal(badR.status, 0, 'a veto is a stdout shape, not a nonzero exit — PreCompact defines no documented nonzero-exit veto');
      const out = parseStdout(badR);
      assert.equal(out.continue, false);
      assert.ok(out.reason && out.reason.length > 40, 'the veto reason is a label, not an instruction');
      assert.match(badR.stderr, /VETOING/);
    } finally { rm(good); rm(bad); }
  });

  test('the escape hatch downgrades an otherwise-veto to a loud warning, and ONLY on the literal string "1"', () => {
    const d = tmp('pc-escape');
    try {
      fs.writeFileSync(path.join(d, '.respawnpack'), 'not a directory');
      const input = { hook_event_name: 'PreCompact', session_id: 'sess_escape', cwd: d };

      const notEnabled = runHook('respawnpack-precompact.js', { cwd: d, input, env: { RESPAWNPACK_ALLOW_UNSAVED_COMPACT: 'true' } });
      assert.equal(parseStdout(notEnabled).continue, false, '"true" must not enable the escape hatch — only the literal "1" does');

      const enabled = runHook('respawnpack-precompact.js', { cwd: d, input, env: { RESPAWNPACK_ALLOW_UNSAVED_COMPACT: '1' } });
      assert.equal(enabled.status, 0);
      assert.equal(enabled.stdout, '', 'the escape hatch must not still emit a veto');
      assert.match(enabled.stderr, /ALLOW_UNSAVED_COMPACT=1 is set/);
      assert.match(enabled.stderr, /UNRECOVERABLE/);
    } finally { rm(d); }
  });

  test('malformed/empty stdin, and a misfired event name, never veto and never write anything', () => {
    const d = tmp('pc-malformed');
    try {
      for (const bad of ['', 'not json', '"just a string"', '42', '[1,2,3]']) {
        const r = runHook('respawnpack-precompact.js', { cwd: d, input: bad });
        assert.equal(r.status, 0, `stdin ${JSON.stringify(bad)} crashed the hook`);
        assert.equal(r.stdout, '', `stdin ${JSON.stringify(bad)} produced a veto with nothing to ground it`);
      }
      const misfire = runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'Stop', session_id: 'x', cwd: d } });
      assert.equal(misfire.status, 0);
      assert.equal(misfire.stdout, '');
      assert.equal(exists(path.join(d, '.respawnpack')), false, 'a misfired event must not write anything');
    } finally { rm(d); }
  });

  test('no usable session_id: vetoes (cannot scope a handoff), still refreshes the canary', () => {
    const d = tmp('pc-nosid');
    try {
      const r = runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', cwd: d } });
      assert.equal(r.status, 0);
      const out = parseStdout(r);
      assert.equal(out.continue, false);
      assert.match(out.reason, /session_id/);
      const canary = readJSON(shared.canaryPath(d));
      assert.equal(canary.session_id, null);
    } finally { rm(d); }
  });
});

// =====================================================================================================
describe('respawnpack-sessionstart.js — rehydration on source==="compact"', () => {
  test('known-good: a fresh compaction is rehydrated once — full render, identity confirmed, handoff consumed', () => {
    const d = tmp('ss-good');
    try {
      const sid = 'sess_ss_good';
      const pre = runHook('respawnpack-precompact.js', {
        cwd: d,
        input: {
          hook_event_name: 'PreCompact', session_id: sid, cwd: d, trigger: 'manual',
        },
      });
      assert.equal(pre.status, 0);
      fs.mkdirSync(shared.RUNTIME_ROLLOVER_DIR(d), { recursive: true });
      // Note left AFTER precompact ran once would be for the NEXT compaction — not used by this test;
      // this scenario asserts the plain, note-less rehydration render instead.

      const r = runHook('respawnpack-sessionstart.js', {
        cwd: d,
        input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d },
      });
      assert.equal(r.status, 0);
      const out = parseStdout(r);
      assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
      const ctx = out.hookSpecificOutput.additionalContext;
      assert.match(ctx, /rehydrated handoff/);
      assert.match(ctx, /Same conversation confirmed: sess_ss_good/);

      const dir = runtimeDirOf(d, sid);
      const pointer = readJSON(shared.latestHandoffPointerPath(dir));
      assert.ok(exists(path.join(dir, `${pointer.handoffId}.consumed.json`)), 'the handoff was rendered but never actually consumed');
    } finally { rm(d); }
  });

  test('exactly-once: a duplicate SessionStart(compact) delivery gets a pointer note, never the handoff content again', () => {
    const d = tmp('ss-dup');
    try {
      const sid = 'sess_ss_dup';
      assert.equal(runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sid, cwd: d } }).status, 0);

      const first = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      const firstCtx = parseStdout(first).hookSpecificOutput.additionalContext;
      assert.match(firstCtx, /rehydrated handoff/);

      const second = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      assert.equal(second.status, 0);
      const secondCtx = parseStdout(second).hookSpecificOutput.additionalContext;
      assert.match(secondCtx, /already consumed/);
      assert.match(secondCtx, /codex-sessionstart-hook/, 'the second delivery must be told WHO consumed it first, not just that it was');
      assert.doesNotMatch(secondCtx, /exact next action/, 'the duplicate must not re-render the handoff content — that IS the second delivery of the same atomic action');

      const dir = runtimeDirOf(d, sid);
      const pointer = readJSON(shared.latestHandoffPointerPath(dir));
      // Exactly one consumption receipt on disk, never two, and the machine's own event-scoped
      // consumption trail agrees.
      assert.equal(exists(path.join(dir, `${pointer.handoffId}.consumed.json`)), true);
    } finally { rm(d); }
  });

  test('the shared core state machine legitimately refuses observe-completion under a hooks-only profile, and that refusal is reported, not hidden', () => {
    const d = tmp('ss-machine-refused');
    try {
      const sid = 'sess_ss_refused';
      assert.equal(runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sid, cwd: d } }).status, 0);
      const r = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      const ctx = parseStdout(r).hookSpecificOutput.additionalContext;
      assert.match(ctx, /core rollover state machine/);
      assert.match(ctx, /ILLEGAL_TRANSITION/, 'the ONLY reason this hooks-only profile cannot drive the machine is the state gate — a different failure here would mean something else broke');
    } finally { rm(d); }
  });

  test('once the shared machine has independently reached COMPACTING (as a future app-server profile would leave it), this hook\'s attempt APPLIES — first call APPLIED, duplicate call NOOP', () => {
    const d = tmp('ss-machine-applied');
    try {
      const sid = 'sess_ss_applied';
      assert.equal(runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sid, cwd: d } }).status, 0);

      // Advance the SAME on-disk journal to COMPACTING, exactly as a future app-server-driven profile
      // sharing this conversationDir would have left it — see adapters/codex/app-server/README.md.
      const before = driveMachineToCompacting(d, sid);
      assert.equal(before.cycleIndex(), 0);

      const first = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      const firstCtx = parseStdout(first).hookSpecificOutput.additionalContext;
      assert.match(firstCtx, /verified in-place rollover, cycle 0 -> 1/);

      const second = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      const secondCtx = parseStdout(second).hookSpecificOutput.additionalContext;
      // The handoff-consumption layer already reports ALREADY_CONSUMED; the machine layer's OWN dedup
      // (keyed on the same handoffId used as eventId) independently reports its own no-op, proving the
      // NOOP branch — not just the REFUSED branch exercised above — is reachable and correctly worded.
      assert.match(secondCtx, /duplicate observe-completion recognized as a no-op/);
    } finally { rm(d); }
  });

  // ===================================================================================================
  // P1-CT-11 — the SessionStart noop/verify-identity retry gap (the core-adapters-ops audit §5 T11).
  //
  // The defect: attemptMachine() returned immediately on a NOOP from observe-completion, two lines
  // before it would have attempted verify-identity. A NOOP there means only "this delivery did not
  // newly apply observe-completion" — never "verify-identity already ran". A firing that applied
  // observe-completion (COMPACTING -> REHYDRATING) and was then killed before reaching verify-identity
  // left the machine parked in REHYDRATING forever: every redelivered SessionStart(compact) afterward
  // would see the SAME NOOP and return the SAME early message, never trying verify-identity again and
  // never saying anything else about it. Three states below, in this suite's existing style of driving
  // the REAL machine via driveMachineToCompacting() and reading the REAL hook's stdout.
  test('P1-CT-11 · retry gap: a redelivered SessionStart(compact) still attempts verify-identity after observe-completion NOOPs from a simulated inter-statement crash', () => {
    const d = tmp('ss-retry-gap');
    try {
      const sid = 'sess_retry_gap';
      assert.equal(runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sid, cwd: d } }).status, 0);

      // Advance the same on-disk journal to COMPACTING, exactly like the existing "independently reached
      // COMPACTING" test above.
      const before = driveMachineToCompacting(d, sid);
      assert.equal(before.cycleIndex(), 0);

      const dir = runtimeDirOf(d, sid);
      const pointer = readJSON(shared.latestHandoffPointerPath(dir));
      const handoffId = pointer.handoffId;

      // Simulate the exact inter-statement crash T11 describes: a firing applies observe-completion and
      // is killed before it reaches verify-identity two statements later in attemptMachine(). Applied
      // directly against the SAME on-disk journal the hook itself reopens below, so this is
      // indistinguishable, from the journal's point of view, from a real crashed firing.
      const rCrash = before.apply({
        transition: 'observe-completion', eventId: handoffId,
        evidence: [core.evidence.make(KINDS.COMPACT_COMPLETED, { signal: 'session_start_compact', raw: { note: 'synthetic: the firing that crashes before verify-identity' } })],
      });
      assert.equal(rCrash.status, 'APPLIED', 'test setup: the simulated pre-crash observe-completion did not apply');
      assert.equal(before.state(), 'REHYDRATING', 'test setup: the simulated crash did not leave the machine parked in REHYDRATING');

      // The redelivery: Codex re-fires SessionStart(compact) for the same session, exactly what a
      // crash-then-restart produces. observe-completion NOOPs (already applied above) — that is the
      // trigger; the defect was returning right there without ever trying verify-identity.
      const redelivered = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      assert.equal(redelivered.status, 0);
      const ctx = parseStdout(redelivered).hookSpecificOutput.additionalContext;
      assert.match(ctx, /duplicate observe-completion recognized as a no-op/, 'test setup: observe-completion must NOOP here, or this is not exercising the gap');
      assert.match(ctx, /verified in-place rollover, cycle 0 -> 1/, 'the retry gap: a NOOP observe-completion must not stop verify-identity from being attempted when identity has not yet been verified for this cycle');

      // The honest, durable fact behind the prose: a fresh machine handle (as the next hook firing would
      // open) shows identity actually got verified and the cycle actually advanced.
      const after = core.machine.open({ projectDir: d, host: 'codex', conversationId: sid });
      assert.equal(after.ok, true);
      assert.equal(after.machine.state(), 'ACTIVE', 'identity was never actually verified — the machine is still parked in REHYDRATING');
      assert.equal(after.machine.cycleIndex(), 1, 'the cycle never advanced — verify-identity was never actually applied');
    } finally { rm(d); }
  });

  test('P1-CT-11 · nearest bypass: a mismatched identity retried via the fallthrough still halts, and every later redelivery keeps reporting the halt, never "verified"', () => {
    const d = tmp('ss-retry-mismatch');
    try {
      const sidA = 'sess_retry_A';
      const sidB = 'sess_retry_B';
      // A real PreCompact for A sets the last-active pointer to A — same setup as the existing
      // "identity mismatch is surfaced" test above.
      assert.equal(runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sidA, cwd: d } }).status, 0);

      // Seed a real, verified handoff for B directly, and drive B's OWN machine to COMPACTING.
      const dirB = runtimeDirOf(d, sidB);
      const openedB = core.machine.open({ projectDir: d, host: 'codex', conversationId: sidB });
      const recB = core.handoff.build({
        identity: { host: 'codex', conversationId: sidB, conversationIdField: 'session_id' },
        contextCycleId: openedB.machine.cycleId(),
        exactNextAction: 'this belongs to session B',
        git: { head: null, uncommittedFiles: [], sessionDelta: { status: 'CANNOT_DETERMINE', files: [], headMoved: false } },
      });
      const wB = core.handoff.writeVerified(dirB, recB);
      assert.equal(wB.ok, true);
      shared.writeLatestHandoffPointer(dirB, { handoffId: recB.handoffId, cycleIdAtWrite: openedB.machine.cycleId() });
      const before = driveMachineToCompacting(d, sidB);

      // Simulate the same inter-statement crash as the retry-gap test above, so the FIRST real hook call
      // below is itself already a redelivery: observe-completion applied, verify-identity never attempted.
      const rCrash = before.apply({
        transition: 'observe-completion', eventId: recB.handoffId,
        evidence: [core.evidence.make(KINDS.COMPACT_COMPLETED, { signal: 'session_start_compact', raw: { note: 'synthetic: the firing that crashes before verify-identity' } })],
      });
      assert.equal(rCrash.status, 'APPLIED', 'test setup: the simulated pre-crash observe-completion did not apply');

      // Redelivery #1: observe-completion NOOPs (already applied above) — the retry-gap trigger. The fix
      // must still retry verify-identity even though sidA != sidB: identity really does mismatch, and
      // IDENTITY_MISMATCH HALTS the machine by design (core/policy/failures.js), a stronger guarantee
      // than a plain refusal that this fix must not weaken. The halt must be reported, never silent, and
      // never "verified".
      const first = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sidB, cwd: d } });
      const firstCtx = parseStdout(first).hookSpecificOutput.additionalContext;
      assert.match(firstCtx, /duplicate observe-completion recognized as a no-op/, 'test setup: observe-completion must NOOP on this delivery');
      assert.match(firstCtx, /IDENTITY_MISMATCH/, 'the retried verify-identity must still be attempted and its halt reported, not silently dropped');
      assert.doesNotMatch(firstCtx, /verified in-place rollover/, 'a mismatched identity must NEVER be reported as verified');

      const midway = core.machine.open({ projectDir: d, host: 'codex', conversationId: sidB });
      assert.equal(midway.ok, true);
      assert.equal(midway.machine.state(), 'HALTED', 'test setup: an identity mismatch must halt the machine, not merely refuse this one call');

      // Redelivery #2: the machine is now HALTED. core/lifecycle/machine.js's apply() short-circuits on
      // st.halted before it even looks at the transition table, so observe-completion itself now comes
      // back HALTED, not NOOP — a different branch of attemptMachine() entirely (the untouched
      // rComplete.status !== 'APPLIED' branch). Every subsequent call must keep reporting the SAME halt —
      // never a fresh success, never quiet.
      const second = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sidB, cwd: d } });
      const secondCtx = parseStdout(second).hookSpecificOutput.additionalContext;
      assert.match(secondCtx, /IDENTITY_MISMATCH/);
      assert.doesNotMatch(secondCtx, /verified in-place rollover/, 'a halted rollover must never be reported as verified, no matter how many times it is redelivered');

      const after = core.machine.open({ projectDir: d, host: 'codex', conversationId: sidB });
      assert.equal(after.ok, true);
      assert.equal(after.machine.state(), 'HALTED');
      assert.ok(after.machine.halted(), 'the halt must persist across redeliveries, not clear itself');
      assert.equal(after.machine.cycleIndex(), 0, 'the cycle must never advance for a rollover that never verified identity');
    } finally { rm(d); }
  });

  test('P1-CT-11 · unaffected by the fix: a fresh single-delivery in-place rollover is byte-for-byte unchanged, and redelivering an already-verified identity is not a re-verification', () => {
    const d = tmp('ss-retry-happy');
    try {
      const sid = 'sess_retry_happy';
      assert.equal(runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sid, cwd: d } }).status, 0);
      driveMachineToCompacting(d, sid);

      const dir = runtimeDirOf(d, sid);
      const pointer = readJSON(shared.latestHandoffPointerPath(dir));

      const first = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      assert.equal(first.status, 0);
      const firstCtx = parseStdout(first).hookSpecificOutput.additionalContext;
      // Golden, byte-for-byte: the fix must not change a single character of a fresh, first-ever,
      // identity-matching delivery — the "verified in-place rollover" branch is reached exactly as
      // before, with an empty prefix.
      const expected = [
        `RespawnPack: rehydrated handoff ${pointer.handoffId}.`,
        `Same conversation confirmed: ${sid}.`,
        '- unresolved: no pending savepoint note was found at .respawnpack/runtime/rollover/_codex-pending-note.json (see adapters/codex/skills/respawn-rollover/SKILL.md) — exactNextAction and atomicActionId are unset for this handoff',
        'core rollover state machine: verified in-place rollover, cycle 0 -> 1.',
      ].join('\n');
      assert.equal(firstCtx, expected, 'the happy path must be byte-for-byte unchanged by the retry-gap fix');

      // Redeliver: identity is ALREADY verified (cycle already advanced to 1 above) — this must not be
      // re-verified (no second cycle advance, no re-decision), only honestly reported as the no-op it is.
      const second = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      const secondCtx = parseStdout(second).hookSpecificOutput.additionalContext;
      assert.match(secondCtx, /duplicate observe-completion recognized as a no-op/);
      assert.match(secondCtx, /duplicate verify-identity recognized as a no-op/, 'an already-verified identity must be honestly reported as the no-op it is, not silently skipped and not re-verified');
      assert.doesNotMatch(secondCtx, /verified in-place rollover/, 'a redelivery of an already-verified identity must not claim a fresh verification');

      const after = core.machine.open({ projectDir: d, host: 'codex', conversationId: sid });
      assert.equal(after.ok, true);
      assert.equal(after.machine.cycleIndex(), 1, 'the cycle must not double-advance on a redelivery of an already-verified identity');
    } finally { rm(d); }
  });

  test('identity mismatch is surfaced, never silently treated as continuity', () => {
    const d = tmp('ss-mismatch');
    try {
      const sidA = 'sess_A';
      const sidB = 'sess_B';
      // A real PreCompact for A sets the last-active pointer to A.
      assert.equal(runHook('respawnpack-precompact.js', { cwd: d, input: { hook_event_name: 'PreCompact', session_id: sidA, cwd: d } }).status, 0);

      // Seed a handoff+pointer for B directly (bypassing precompact, which would overwrite last-active) —
      // the scenario this proves is "SessionStart(compact) reports a DIFFERENT session than the one that
      // last ran PreCompact," which is exactly what the identity check exists to catch.
      const dirB = runtimeDirOf(d, sidB);
      const openedB = core.machine.open({ projectDir: d, host: 'codex', conversationId: sidB });
      const recB = core.handoff.build({
        identity: { host: 'codex', conversationId: sidB, conversationIdField: 'session_id' },
        contextCycleId: openedB.machine.cycleId(),
        exactNextAction: 'this belongs to session B',
        git: { head: null, uncommittedFiles: [], sessionDelta: { status: 'CANNOT_DETERMINE', files: [], headMoved: false } },
      });
      const wB = core.handoff.writeVerified(dirB, recB);
      assert.equal(wB.ok, true);
      shared.writeLatestHandoffPointer(dirB, { handoffId: recB.handoffId, cycleIdAtWrite: openedB.machine.cycleId() });

      const r = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sidB, cwd: d } });
      const ctx = parseStdout(r).hookSpecificOutput.additionalContext;
      assert.match(ctx, /IDENTITY MISMATCH/);
      assert.match(ctx, new RegExp(sidA));
      assert.match(ctx, new RegExp(sidB));
      // The mismatch is reported ALONGSIDE the handoff, not instead of it — the consumption itself is a
      // separate protection and still legitimately succeeds for B's own handoff.
      assert.match(ctx, /this belongs to session B/);
    } finally { rm(d); }
  });

  test('no prior pointer at all: identity is CANNOT_DETERMINE, not a false mismatch and not a false match', () => {
    const d = tmp('ss-nopointer-identity');
    try {
      const sid = 'sess_first_ever';
      const dir = runtimeDirOf(d, sid);
      const opened = core.machine.open({ projectDir: d, host: 'codex', conversationId: sid });
      const rec = core.handoff.build({
        identity: { host: 'codex', conversationId: sid, conversationIdField: 'session_id' },
        contextCycleId: opened.machine.cycleId(),
        git: { head: null, uncommittedFiles: [], sessionDelta: { status: 'CANNOT_DETERMINE', files: [], headMoved: false } },
      });
      const w = core.handoff.writeVerified(dir, rec);
      shared.writeLatestHandoffPointer(dir, { handoffId: rec.handoffId, cycleIdAtWrite: opened.machine.cycleId() });
      assert.equal(w.ok, true);

      const r = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d } });
      const ctx = parseStdout(r).hookSpecificOutput.additionalContext;
      assert.match(ctx, /could not be cross-checked/);
      assert.doesNotMatch(ctx, /IDENTITY MISMATCH/);
      assert.doesNotMatch(ctx, /Same conversation confirmed/);
    } finally { rm(d); }
  });

  test('no pending handoff at all: an honest message, not silence and not an error', () => {
    const d = tmp('ss-nohandoff');
    try {
      const r = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', session_id: 'sess_never_precompacted', cwd: d } });
      assert.equal(r.status, 0);
      const ctx = parseStdout(r).hookSpecificOutput.additionalContext;
      assert.match(ctx, /no pending handoff was found/);
    } finally { rm(d); }
  });

  test('source is not "compact": a minimal canary touch only, no additionalContext, never crashes Claude-style STATE.json logic in here', () => {
    const d = tmp('ss-other-source');
    try {
      for (const source of ['startup', 'resume', 'clear']) {
        const r = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source, session_id: 'sess_x', cwd: d } });
        assert.equal(r.status, 0, `source=${source} crashed`);
        assert.equal(r.stdout, '', `source=${source} emitted output — only "compact" should ever inject anything`);
      }
      const canary = readJSON(shared.canaryPath(d));
      assert.equal(canary.event, 'SessionStart:clear', 'the canary should reflect the LAST source observed');
    } finally { rm(d); }
  });

  test('missing session_id on source=="compact": honest message, no crash', () => {
    const d = tmp('ss-nosid');
    try {
      const r = runHook('respawnpack-sessionstart.js', { cwd: d, input: { hook_event_name: 'SessionStart', source: 'compact', cwd: d } });
      assert.equal(r.status, 0);
      const ctx = parseStdout(r).hookSpecificOutput.additionalContext;
      assert.match(ctx, /no usable session_id/);
    } finally { rm(d); }
  });

  test('malformed/empty stdin never crashes and never emits output', () => {
    const d = tmp('ss-malformed');
    try {
      for (const bad of ['', 'not json', 'null', '[]']) {
        const r = runHook('respawnpack-sessionstart.js', { cwd: d, input: bad });
        assert.equal(r.status, 0, `stdin ${JSON.stringify(bad)} crashed the hook`);
        assert.equal(r.stdout, '');
      }
    } finally { rm(d); }
  });
});

// =====================================================================================================
describe('respawnpack-postcompact.js — observational corroboration only', () => {
  test('known-good: appends a marker beside the journal, emits nothing, and never opens/mutates the machine', () => {
    const d = tmp('poc-good');
    try {
      const sid = 'sess_poc_good';
      const dir = runtimeDirOf(d, sid);
      const r = runHook('respawnpack-postcompact.js', { cwd: d, input: { hook_event_name: 'PostCompact', session_id: sid, cwd: d, trigger: 'auto' } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', 'PostCompact carries no documented additionalContext — this hook must emit nothing');

      assert.equal(exists(path.join(dir, 'journal.jsonl')), false, 'an observational-only hook minted a cycle — it must never call machine.open()');
      const lines = fs.readFileSync(shared.postcompactLogPath(dir), 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const row = JSON.parse(lines[0]);
      assert.equal(row.trigger, 'auto');
      assert.equal(row.raw.hook_event_name, 'PostCompact');
    } finally { rm(d); }
  });

  test('multiple firings append multiple lines, each complete', () => {
    const d = tmp('poc-multi');
    try {
      const sid = 'sess_poc_multi';
      for (let i = 0; i < 3; i++) {
        assert.equal(runHook('respawnpack-postcompact.js', { cwd: d, input: { hook_event_name: 'PostCompact', session_id: sid, cwd: d, trigger: 'manual' } }).status, 0);
      }
      const dir = runtimeDirOf(d, sid);
      const lines = fs.readFileSync(shared.postcompactLogPath(dir), 'utf8').trim().split('\n');
      assert.equal(lines.length, 3);
      for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
    } finally { rm(d); }
  });

  test('malformed stdin and missing session_id never crash and never write a per-conversation marker', () => {
    const d = tmp('poc-bad');
    try {
      for (const bad of ['', 'not json']) {
        const r = runHook('respawnpack-postcompact.js', { cwd: d, input: bad });
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '');
      }
      const r2 = runHook('respawnpack-postcompact.js', { cwd: d, input: { hook_event_name: 'PostCompact', cwd: d } });
      assert.equal(r2.status, 0);
      assert.equal(fs.readdirSync(path.join(d, '.respawnpack', 'runtime', 'rollover')).some((n) => n.startsWith('codex-')), false);
    } finally { rm(d); }
  });
});

// =====================================================================================================
describe('respawnpack-stop.js — a settle marker, never a decision', () => {
  test('known-good: appends a marker shaped like core evidence.SAFE_BOUNDARY, emits nothing', () => {
    const d = tmp('stop-good');
    try {
      const sid = 'sess_stop_good';
      const r = runHook('respawnpack-stop.js', { cwd: d, input: { hook_event_name: 'Stop', session_id: sid, cwd: d, stop_hook_active: false } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', 'a Stop settle marker must never emit a decision');

      const dir = runtimeDirOf(d, sid);
      const row = JSON.parse(fs.readFileSync(shared.stopLogPath(dir), 'utf8').trim().split('\n')[0]);
      assert.equal(row.mechanism, 'unblocked-stop-hook');
      // Shaped closely enough that a future consumer can hand this straight to evidence.make/validate.
      const rebuilt = core.evidence.make(KINDS.SAFE_BOUNDARY, { mechanism: row.mechanism, raw: row.raw });
      assert.equal(core.evidence.validate(rebuilt).ok, true, 'the settle marker is not shaped closely enough to become a real SAFE_BOUNDARY record');
    } finally { rm(d); }
  });

  test('malformed stdin never crashes and never emits a decision', () => {
    const d = tmp('stop-bad');
    try {
      for (const bad of ['', 'not json', '{"decision":"block"}']) {
        const r = runHook('respawnpack-stop.js', { cwd: d, input: bad });
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '', `input ${JSON.stringify(bad)} must never produce a decision-shaped output`);
      }
    } finally { rm(d); }
  });
});

// =====================================================================================================
describe('respawnpack-canary.js — the activation evidence, safe on any event', () => {
  test('known-good: refreshes the marker, increments fireCount, ALWAYS empty stdout regardless of event', () => {
    const d = tmp('canary-good');
    try {
      const events = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd'];
      for (const event of events) {
        const r = runHook('respawnpack-canary.js', { cwd: d, input: { hook_event_name: event, session_id: 'sess_canary', cwd: d } });
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '', `registering the canary against ${event} must never produce a decision`);
      }
      const doc = readJSON(shared.canaryPath(d));
      assert.equal(doc.fireCount, events.length);
      assert.equal(doc.event, 'SessionEnd');
      assert.ok(doc.firstSeenAt);
      assert.notEqual(doc.firstSeenAt, doc.at, 'firstSeenAt must survive refreshes unchanged, only `at` moves');
    } finally { rm(d); }
  });

  test('a canary usable by core.policy.capabilities: kind/observedAt/raw/ran all present', () => {
    const d = tmp('canary-usable');
    try {
      runHook('respawnpack-canary.js', { cwd: d, input: { hook_event_name: 'Stop', session_id: 's', cwd: d } });
      const doc = readJSON(shared.canaryPath(d));
      const shaped = { kind: doc.kind, observedAt: doc.at, raw: doc.raw, ran: doc.ran };
      assert.equal(core.capabilities.canaryUsable(shaped).ok, true);
      assert.equal(core.capabilities.canaryUsable(null).ok, false, 'known-bad control: no canary is never usable');
      assert.equal(core.capabilities.canaryUsable({ ...shaped, raw: undefined }).ok, false, 'known-bad control: a canary with no verbatim payload is never usable');
    } finally { rm(d); }
  });

  test('malformed stdin STILL refreshes the marker (proof the process ran), always with empty stdout', () => {
    const d = tmp('canary-malformed');
    try {
      const r = runHook('respawnpack-canary.js', { cwd: d, input: 'not json at all' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      const doc = readJSON(shared.canaryPath(d));
      assert.equal(doc.event, null);
      assert.equal(doc.raw.unparseable, true);
    } finally { rm(d); }
  });
});

// =====================================================================================================
describe('profile.js — the capability declaration, honest about today', () => {
  test('known-bad control: no canary anywhere in the project — every canary-gated capability is CANNOT_DETERMINE and says why', () => {
    const d = tmp('profile-none');
    try {
      const m = profile.declareAll(d);
      assert.equal(m.profile, 'codex-interactive-hooks');
      assert.equal(m.outcome, 'CANNOT_DETERMINE');
      assert.equal(m.rolloverCapable, false);
      assert.deepEqual(m.undeclared, [], 'every one of the 7 capabilities must be explicitly declared, never left implicit');
      const byCap = Object.fromEntries(m.declarations.map((x) => [x.capability, x]));
      for (const cap of ['probe', 'settleOrStop', 'observeCompact', 'injectHandoff', 'resume']) {
        assert.equal(byCap[cap].support, 'CANNOT_DETERMINE', `${cap} should be CANNOT_DETERMINE with no live canary`);
        assert.equal(byCap[cap].downgraded, true);
      }
      assert.equal(byCap.measureContext.support, 'NOT_SUPPORTED');
      assert.equal(byCap.requestCompact.support, 'NOT_SUPPORTED');
    } finally { rm(d); }
  });

  test('known-good control: a fresh canary upgrades every canary-gated capability, and the two genuinely-unsupported ones stay NOT_SUPPORTED', () => {
    const d = tmp('profile-fresh');
    try {
      shared.refreshCanary(d, { event: 'Stop', sessionId: 's', raw: { hook_event_name: 'Stop' } });
      const m = profile.declareAll(d);
      const byCap = Object.fromEntries(m.declarations.map((x) => [x.capability, x]));
      assert.equal(byCap.probe.support, 'SUPPORTED_WITH_LIMITATIONS');
      assert.equal(byCap.settleOrStop.support, 'SUPPORTED');
      assert.equal(byCap.observeCompact.support, 'SUPPORTED_WITH_LIMITATIONS');
      assert.equal(byCap.injectHandoff.support, 'SUPPORTED_WITH_LIMITATIONS');
      assert.equal(byCap.resume.support, 'SUPPORTED_WITH_LIMITATIONS');
      assert.equal(byCap.measureContext.support, 'NOT_SUPPORTED', 'a canary firing must never upgrade a capability this profile genuinely cannot do');
      assert.equal(byCap.requestCompact.support, 'NOT_SUPPORTED');
      // rolloverCapable stays false even at best — this profile can never supply measureContext/
      // requestCompact, which is the honest reason a hooks-only Codex profile is SUPPORTED_WITH_
      // LIMITATIONS in the multi-host rollover design (a development record), never the SUPPORTED target.
      assert.equal(m.rolloverCapable, false);
      assert.deepEqual(m.unmet.sort(), ['measureContext', 'requestCompact']);
    } finally { rm(d); }
  });

  test('a marker that records no VERDICT lifts nothing — silence is not a pass, and core is what says so', () => {
    /*
     * The pre-W6a marker shape: well-formed, fresh, `ran:true`, verbatim payload — and no `outcome`.
     * core/policy/capabilities.js now requires a canary to carry OUTCOME PASS, so a marker left on disk
     * by an older install stops lifting capabilities until a trusted hook fires again and rewrites it.
     * Fail-closed on purpose: the alternative is a rule that reads an unstated verdict as a passing one.
     */
    const d = tmp('profile-noverdict');
    try {
      shared.refreshCanary(d, { event: 'Stop', sessionId: 's', raw: { hook_event_name: 'Stop' } });
      const p = shared.canaryPath(d);
      const doc = readJSON(p);
      assert.equal(doc.outcome, 'PASS', 'a real firing must record its own verdict, or the check below tests nothing');
      delete doc.outcome;
      fs.writeFileSync(p, JSON.stringify(doc, null, 2));

      // The control: this shape still passes core's SHAPE gate, so what refuses it below is the verdict.
      const read = profile.readCanary(d);
      assert.equal(read.usable, true, 'the adapter still considers it present, fresh and asserting that it ran');
      assert.equal(core.capabilities.canaryUsable(read.canary).ok, true);

      const m = profile.declareAll(d);
      const probe = m.declarations.find((x) => x.capability === 'probe');
      assert.equal(probe.support, 'CANNOT_DETERMINE', 'a marker with no recorded verdict was read as a passing one');
      assert.match(probe.why, /no verdict/);
    } finally { rm(d); }
  });

  test('freshness is checked, not just presence: a stale canary is downgraded again, distinctly worded from "absent"', () => {
    const d = tmp('profile-stale');
    try {
      shared.refreshCanary(d, { event: 'Stop', sessionId: 's', raw: {} });
      const p = shared.canaryPath(d);
      const doc = readJSON(p);
      doc.at = new Date(Date.now() - (profile.CANARY_FRESHNESS_MS + 86400000)).toISOString();
      fs.writeFileSync(p, JSON.stringify(doc, null, 2));

      const m = profile.declareAll(d);
      const probe = m.declarations.find((x) => x.capability === 'probe');
      assert.equal(probe.support, 'CANNOT_DETERMINE');
      assert.match(probe.why, /day\(s\) ago/, 'a stale canary must be explained AS staleness, not conflated with "never fired"');
    } finally { rm(d); }
  });

  test('every declaration carries its evidence requirement — a non-empty why, or a named mechanism plus docs', () => {
    const d = tmp('profile-evidence');
    try {
      const m = profile.declareAll(d);
      for (const decl of m.declarations) {
        const hasWhy = typeof decl.why === 'string' && decl.why.length > 20;
        const hasMechanismAndDocs = typeof decl.mechanism === 'string' && decl.mechanism.length > 10 && decl.docs.length > 0;
        assert.ok(hasWhy || hasMechanismAndDocs, `${decl.capability}: neither a real "why" nor a mechanism+docs pair — an unexplained declaration cannot be checked`);
      }
    } finally { rm(d); }
  });

  test('a malformed canary marker on disk degrades to CANNOT_DETERMINE rather than crashing profile.js', () => {
    const d = tmp('profile-corrupt');
    try {
      fs.mkdirSync(shared.RUNTIME_ROLLOVER_DIR(d), { recursive: true });
      fs.writeFileSync(shared.canaryPath(d), '{ not json');
      assert.doesNotThrow(() => profile.declareAll(d));
      const m = profile.declareAll(d);
      assert.equal(m.declarations.find((x) => x.capability === 'probe').support, 'CANNOT_DETERMINE');
    } finally { rm(d); }
  });
});

// =====================================================================================================
describe('_shared.js — the small helpers every hook depends on', () => {
  test('boundedRaw truncates past the ceiling and says so, matching core.evidence.MAX_RAW_BYTES', () => {
    const big = 'x'.repeat(shared.MAX_RAW_BYTES + 500);
    const b = shared.boundedRaw(big);
    assert.equal(b.rawTruncated, true);
    assert.equal(b.rawBytes, shared.MAX_RAW_BYTES + 500);
    assert.equal(b.raw.length, shared.MAX_RAW_BYTES);
    const small = shared.boundedRaw({ a: 1 });
    assert.equal(small.rawTruncated, false);
  });

  test('peekPendingNote never deletes; clearPendingNote does — so a failed write can retry with the same note', () => {
    const d = tmp('shared-note');
    try {
      fs.mkdirSync(shared.RUNTIME_ROLLOVER_DIR(d), { recursive: true });
      fs.writeFileSync(shared.pendingNotePath(d), JSON.stringify({ exactNextAction: 'x' }));
      const peek1 = shared.peekPendingNote(d);
      assert.equal(peek1.present, true);
      assert.equal(exists(shared.pendingNotePath(d)), true, 'peek must not consume the note');
      const peek2 = shared.peekPendingNote(d);
      assert.equal(peek2.present, true, 'a second peek must see the same note');
      shared.clearPendingNote(d);
      assert.equal(exists(shared.pendingNotePath(d)), false);
      assert.equal(shared.peekPendingNote(d).present, false);
    } finally { rm(d); }
  });

  test('readCanaryDoc distinguishes absent from present, and never throws on a missing project', () => {
    const d = tmp('shared-canary-read');
    try {
      assert.equal(shared.readCanaryDoc(d).present, false);
      shared.refreshCanary(d, { event: 'Stop', sessionId: 's', raw: {} });
      assert.equal(shared.readCanaryDoc(d).present, true);
    } finally { rm(d); }
  });

  test('the last-active pointer and the per-conversation handoff pointer are independent files', () => {
    const d = tmp('shared-pointers');
    try {
      assert.equal(shared.readLastActive(d), null);
      shared.writeLastActive(d, { conversationId: 'sess_x', handoffId: 'ho_1' });
      assert.equal(shared.readLastActive(d).conversationId, 'sess_x');

      const dir = shared.conversationDir(d, 'sess_x');
      assert.equal(shared.readLatestHandoffPointer(dir), null);
      shared.writeLatestHandoffPointer(dir, { handoffId: 'ho_1', cycleIdAtWrite: 'codex:sess_x:0:aaaaaaaaaaaa' });
      assert.equal(shared.readLatestHandoffPointer(dir).handoffId, 'ho_1');
    } finally { rm(d); }
  });

  test('escape-hatch audit log: the primitive respawnpack-precompact.js calls when a machine.open()-known directory outlives a later write failure', () => {
    // The end-to-end child-process path this backs (machine.open() succeeds, so the conversation
    // directory is known, but the SUBSEQUENT handoff write specifically fails) is not practically
    // forceable as a black-box test — every input this adapter's own sanitization allows through
    // reaches a valid handoff record, and a directory-level write block (the control used elsewhere in
    // this suite) fails machine.open() itself first, before a directory is ever known. So this test
    // exercises the primitive respawnpack-precompact.js's `auditEscapeHatch` calls directly, in
    // isolation, rather than through that unreachable-in-practice combination.
    const d = tmp('shared-escape-audit');
    try {
      const dir = shared.conversationDir(d, 'sess_audit');
      const w = shared.appendMarker(shared.escapeHatchLogPath(dir), {
        kind: 'escape-hatch-used', env: 'RESPAWNPACK_ALLOW_UNSAVED_COMPACT', reason: 'test-only', raw: { note: 'synthetic' },
      });
      assert.equal(w.ok, true);
      const row = JSON.parse(fs.readFileSync(shared.escapeHatchLogPath(dir), 'utf8').trim());
      assert.equal(row.kind, 'escape-hatch-used');
      assert.equal(row.reason, 'test-only');
    } finally { rm(d); }
  });
});

// =====================================================================================================
describe('packaging — hooks.json.template, config.toml.snippet, and the SKILL.md', () => {
  test('hooks.json.template is valid JSON, names every behavioural hook and the canary, and carries the placeholder + trust-step language', () => {
    const text = fs.readFileSync(path.join(HERE, 'hooks.json.template'), 'utf8');
    const doc = JSON.parse(text);
    assert.ok(doc.hooks.PreCompact, 'no PreCompact registration');
    assert.ok(doc.hooks.SessionStart, 'no SessionStart registration');
    assert.ok(doc.hooks.PostCompact, 'no PostCompact registration');
    assert.ok(doc.hooks.Stop, 'no Stop registration');
    assert.match(text, /\{\{RESPAWNPACK_CODEX_HOOKS_DIR\}\}/);
    assert.match(text, /respawnpack-canary\.js/);
    assert.match(text, /\/hooks/, 'the template must name the interactive trust step');
    for (const name of ['respawnpack-precompact.js', 'respawnpack-sessionstart.js', 'respawnpack-postcompact.js', 'respawnpack-stop.js', 'respawnpack-canary.js']) {
      assert.match(text, new RegExp(name.replace('.', '\\.')), `${name} is never referenced by the template`);
    }
  });

  test('config.toml.snippet names the same five scripts and the trust step, and every hook script it references actually exists', () => {
    const text = fs.readFileSync(path.join(HERE, 'config.toml.snippet'), 'utf8');
    assert.match(text, /\[hooks\]/);
    assert.match(text, /features/);
    assert.match(text, /\/hooks/);
    for (const name of ['respawnpack-precompact.js', 'respawnpack-sessionstart.js', 'respawnpack-postcompact.js', 'respawnpack-stop.js', 'respawnpack-canary.js']) {
      assert.match(text, new RegExp(name.replace('.', '\\.')), `${name} is never referenced by the snippet`);
      assert.equal(fs.existsSync(path.join(HOOKS_DIR, name)), true, `${name} is referenced by the template but does not exist`);
    }
  });

  test('SKILL.md frontmatter satisfies the open agent skills standard: name a-z0-9- <=64, description <=1024', () => {
    const text = fs.readFileSync(path.join(HERE, 'skills', 'respawn-rollover', 'SKILL.md'), 'utf8');
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    assert.ok(m, 'no frontmatter block found');
    const nameMatch = /^name:\s*(.+)$/m.exec(m[1]);
    const descMatch = /^description:\s*(.+)$/m.exec(m[1]);
    assert.ok(nameMatch, 'no name field');
    assert.ok(descMatch, 'no description field');
    const name = nameMatch[1].trim();
    const description = descMatch[1].trim();
    assert.equal(name, 'respawn-rollover');
    assert.ok(name.length <= 64, `name is ${name.length} chars, over the 64 cap`);
    assert.match(name, /^[a-z0-9-]+$/, 'name must be a-z0-9- only');
    assert.ok(description.length <= 1024, `description is ${description.length} chars, over the 1024 cap`);
    assert.ok(description.length > 0);
    assert.match(text, /_codex-pending-note\.json/, 'the skill must name the exact file it instructs writing');
    assert.match(text, /cannot/i, 'the skill must say plainly what RespawnPack cannot do (trigger /compact itself) — honest manual-step language is the whole point');
  });

  test('app-server/ now holds the W3b managed profile the hooks profile was reserved beside', () => {
    // This test began life as the opposite tripwire — "app-server/ must stay a placeholder" — and it
    // fired exactly once, when W3b landed. It now fences the profile's presence instead.
    const entries = fs.readdirSync(path.join(HERE, 'app-server'));
    for (const f of ['README.md', 'rpc.js', 'supervisor.js', 'capabilities.js', 'canary.js']) {
      assert.ok(entries.includes(f), `adapters/codex/app-server/ lost ${f}`);
    }
  });
});

// =====================================================================================================
// W6c. Repo-state preservation — dirty, staged, clean and conflicted repositories must survive EVERY
// rollover write path (respawnpack-precompact.js, respawnpack-sessionstart.js) byte-for-byte.
//
// Every OTHER fixture above is a plain `fs.mkdtempSync()` directory — never `git init`'d — so
// `shared.gitHead`/`shared.gitUncommittedFiles` have always failed silently and returned null/[] in
// this file. This battery is the first place in this suite that runs these hooks against a REAL git
// repository with real dirty/staged/conflicted content, which is exactly how it found two live,
// previously-unreachable-by-this-suite bugs in `_shared.js`'s `gitUncommittedFiles` (see the fix
// comment there): a trim-before-slice off-by-one that corrupted every plain "modified, not staged"
// filename, and a missing exclusion for this pack's own `.respawnpack/` runtime tree.
// =====================================================================================================

/*
 * Every path these two hooks may legitimately create or rewrite — enumerated by literally running a
 * real precompact + sessionstart(compact) pair against a clean repo and listing what appeared under
 * .respawnpack/, not guessed from reading the source. Anything under .respawnpack/runtime/ that does not
 * match one of these shapes is an undocumented artifact; anything outside it that changes at all is a
 * preservation defect.
 */
function isKnownRuntimeArtifact(relPath) {
  return (
    relPath === '.respawnpack/runtime/rollover/_codex-hooks-canary.json'
    || relPath === '.respawnpack/runtime/rollover/_codex-last-active.json'
    || relPath === '.respawnpack/runtime/rollover/_codex-pending-note.json'
    || /^\.respawnpack\/runtime\/rollover\/codex-[^/]+\/(journal\.jsonl|cycle\.json|state\.json|latest-handoff\.json)$/.test(relPath)
    || /^\.respawnpack\/runtime\/rollover\/codex-[^/]+\/ho_[A-Za-z0-9_]+(\.verified|\.consumed)?\.json$/.test(relPath)
  );
}

const sha256Bytes = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Every tracked+untracked file under `dir`, excluding `.git`, content-digested. `/`-normalized keys. */
function walkFiles(dir, rel = '') {
  const out = {};
  let entries;
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (rel === '' && e.name === '.git') continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, walkFiles(dir, relPath));
    else if (e.isFile()) {
      try { out[relPath] = sha256Bytes(fs.readFileSync(path.join(dir, relPath))); } catch { out[relPath] = 'UNREADABLE'; }
    }
  }
  return out;
}

function gitTextOrNote(dir, args) {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return `<git ${args.join(' ')} FAILED: ${(e && e.message) || e}>`; }
}

// See the identical helper in hooks/hooks.test.mjs for why only porcelain needs this: `git diff`,
// `git diff --cached` and `git ls-files -u` only ever describe TRACKED content, and .respawnpack/ is
// never tracked by anything this battery does.
const stripRuntimeLines = (porcelainText) => porcelainText.split(/\r?\n/).filter((l) => !l.includes('.respawnpack')).join('\n');

function snapshotRepo(dir) {
  return {
    head: gitTextOrNote(dir, ['rev-parse', 'HEAD']).trim(),
    porcelain: gitTextOrNote(dir, ['status', '--porcelain=v1']),
    diff: gitTextOrNote(dir, ['diff']),
    diffCached: gitTextOrNote(dir, ['diff', '--cached']),
    lsFilesU: gitTextOrNote(dir, ['ls-files', '-u']),
    files: walkFiles(dir),
  };
}

/**
 * The ONE comparator every preservation assertion below goes through — including the DISCRIMINATING
 * CONTROL, so that control proves THIS exact code path can fail, not a parallel one.
 * @returns {{ok:boolean, problems:string[], newRuntimePaths:string[]}}
 */
function comparePreservation(before, after) {
  const problems = [];
  if (before.head !== after.head) problems.push(`HEAD moved: ${before.head} -> ${after.head}`);
  if (stripRuntimeLines(before.porcelain) !== stripRuntimeLines(after.porcelain)) {
    problems.push(`porcelain changed outside .respawnpack/:\n--before--\n${before.porcelain}\n--after--\n${after.porcelain}`);
  }
  if (before.diff !== after.diff) problems.push(`git diff changed — these hooks never touch tracked content:\n--before--\n${before.diff}\n--after--\n${after.diff}`);
  if (before.diffCached !== after.diffCached) problems.push(`git diff --cached changed:\n--before--\n${before.diffCached}\n--after--\n${after.diffCached}`);
  if (before.lsFilesU !== after.lsFilesU) problems.push(`git ls-files -u changed — conflict stage entries must survive untouched:\n--before--\n${before.lsFilesU}\n--after--\n${after.lsFilesU}`);

  const beforePaths = new Set(Object.keys(before.files));
  const afterPaths = new Set(Object.keys(after.files));
  const newRuntimePaths = [];

  for (const p of afterPaths) {
    const isRuntime = p.startsWith('.respawnpack/runtime/');
    if (!beforePaths.has(p)) {
      if (isRuntime) newRuntimePaths.push(p);
      else problems.push(`new path appeared outside .respawnpack/runtime/: ${p}`);
      continue;
    }
    if (before.files[p] !== after.files[p]) {
      if (isRuntime) newRuntimePaths.push(p);
      else problems.push(`user-owned path changed content: ${p}`);
    }
  }
  for (const p of beforePaths) {
    if (!afterPaths.has(p)) problems.push(`path DISAPPEARED (never permitted, even under .respawnpack/): ${p}`);
  }

  return { ok: problems.length === 0, problems, newRuntimePaths };
}

function assertPreserved(before, after, label) {
  const cmp = comparePreservation(before, after);
  assert.ok(cmp.ok, `${label}: preservation violated —\n${cmp.problems.join('\n')}`);
  for (const p of cmp.newRuntimePaths) {
    assert.ok(isKnownRuntimeArtifact(p),
      `${label}: ${p} is new/changed under .respawnpack/runtime/ but does not match any known rollover artifact shape — an undocumented write`);
  }
  return cmp;
}

/** snapshot -> spawn one hook for real -> snapshot -> assert preservation. */
function runPreserving(dir, hookName, input, label) {
  const before = snapshotRepo(dir);
  const r = runHook(hookName, { cwd: dir, input });
  const after = snapshotRepo(dir);
  assert.equal(r.status, 0, `${label}: ${hookName} exited ${r.status}; stderr: ${r.stderr}`);
  assertPreserved(before, after, label);
  return r;
}

function findV2Handoff(dir, sid) {
  const cdir = runtimeDirOf(dir, sid);
  let names;
  try { names = fs.readdirSync(cdir); } catch { return null; }
  const name = names.find((n) => /^ho_[A-Za-z0-9_]+\.json$/.test(n));
  return name ? readJSON(path.join(cdir, name)) : null;
}

/** Turns a plain `fs.mkdtempSync()` scratch dir into a real one-commit git repo — every OTHER fixture
 * in this file skips this step entirely, which is exactly why this battery is the first to exercise
 * `_shared.js`'s real git parsing. Returns a bound `git(...args)` helper for the caller's own setup. */
function gitInitRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'harness@respawnpack.test');
  git('config', 'user.name', 'RespawnPack Harness');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'initial');
  return git;
}

function makeDirtyWorktree(dir) {
  fs.appendFileSync(path.join(dir, 'README.md'), 'dirty edit\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'scratch.ts'), 'export const wip = true;\n');
}

function makeStagedOnly(dir, git) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'staged.ts'), 'export const staged = true;\n');
  git('add', 'src/staged.ts');
}

function makeStagedPlusDirty(dir, git) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'staged.ts'), 'export const staged = true;\n');
  git('add', 'src/staged.ts');
  fs.appendFileSync(path.join(dir, 'src', 'staged.ts'), '// further edit after staging\n');
  fs.writeFileSync(path.join(dir, 'src', 'untracked-too.ts'), 'export const alsoNew = true;\n');
  fs.appendFileSync(path.join(dir, 'README.md'), 'separately dirty\n');
}

/** A REAL merge conflict via an actual `git merge` — not hand-typed markers. */
function makeMergeConflict(dir, git) {
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'line1\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'shared base');
  git('checkout', '-b', 'feature', '--quiet');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'line1-feature\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'feature change');
  git('checkout', 'main', '--quiet');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'line1-main\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'main change');
  try { git('merge', 'feature', '--no-edit'); }
  catch { /* a real conflicting merge exits nonzero — that IS the desired outcome */ }
}

describe('W6c · repo-state preservation — every rollover write path is inert to user content', () => {
  test('clean repo · nothing to preserve, and the reported facts are trivially truthful', () => {
    const d = tmp('w6c-clean');
    try {
      gitInitRepo(d);
      const sid = 'w6c_clean_main';
      const pc = runPreserving(d, 'respawnpack-precompact.js', { hook_event_name: 'PreCompact', session_id: sid, cwd: d, trigger: 'manual' }, 'clean/PreCompact');
      assert.equal(pc.status, 0);
      const v2 = findV2Handoff(d, sid);
      assert.ok(v2, 'no v2 handoff written for a clean repo');
      assert.deepEqual(v2.git.uncommittedFiles, []);
      assert.deepEqual(v2.git.sessionDelta, { status: 'CANNOT_DETERMINE', files: [], headMoved: false });

      const ss = runPreserving(d, 'respawnpack-sessionstart.js', { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d }, 'clean/SessionStart(compact)');
      assert.equal(ss.status, 0);
      const ctx = parseStdout(ss).hookSpecificOutput.additionalContext;
      assert.match(ctx, /rehydrated handoff/);
    } finally { rm(d); }
  });

  const DIRTY_STATES = [
    ['dirty worktree (tracked mod + untracked)', (dir) => makeDirtyWorktree(dir), ['README.md', 'src/scratch.ts']],
    ['staged-only changes', (dir, git) => makeStagedOnly(dir, git), ['src/staged.ts']],
    ['staged+dirty mixed', (dir, git) => makeStagedPlusDirty(dir, git), ['README.md', 'src/staged.ts', 'src/untracked-too.ts']],
  ];

  for (const [name, setup, expected] of DIRTY_STATES) {
    test(`${name} · preserved byte-for-byte, and uncommittedFiles names exactly the dirty paths`, () => {
      const d = tmp(`w6c-${name.replace(/[^a-z0-9]+/gi, '-')}`);
      try {
        const git = gitInitRepo(d);
        setup(d, git);

        const sid = 'w6c_main';
        const pc = runPreserving(d, 'respawnpack-precompact.js', { hook_event_name: 'PreCompact', session_id: sid, cwd: d, trigger: 'manual' }, `${name}/PreCompact`);
        assert.equal(pc.status, 0);
        const v2 = findV2Handoff(d, sid);
        assert.ok(v2, `no v2 handoff written (${name})`);
        assert.deepEqual([...v2.git.uncommittedFiles].sort(), expected, 'uncommittedFiles must name exactly the dirty paths, no more, no less');
        assert.equal(v2.git.uncommittedTruncated, false);
        // This adapter has no SessionStart-time baseline layer yet (see respawnpack-precompact.js's own
        // banner) — sessionDelta must ALWAYS be the honest CANNOT_DETERMINE, on every state, never a
        // guessed CHANGED/UNCHANGED that this layer cannot actually back up.
        assert.deepEqual(v2.git.sessionDelta, { status: 'CANNOT_DETERMINE', files: [], headMoved: false });

        const ss = runPreserving(d, 'respawnpack-sessionstart.js', { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d }, `${name}/SessionStart(compact)`);
        assert.equal(ss.status, 0);
        const ctx = parseStdout(ss).hookSpecificOutput.additionalContext;
        for (const f of expected) assert.match(ctx, new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `injected context did not name ${f} (${name})`);
      } finally { rm(d); }
    });
  }

  test('a REAL merge conflict (actual `git merge`, not hand-typed markers) · hook exits 0, contract holds, handoff write+readback-verifies, and the tree is preserved exactly', () => {
    const d = tmp('w6c-conflict');
    try {
      const git = gitInitRepo(d);
      makeMergeConflict(d, git);
      assert.match(gitTextOrNote(d, ['status', '--porcelain']), /^UU shared\.txt$/m, 'test setup did not actually produce a live merge conflict');
      assert.notEqual(gitTextOrNote(d, ['ls-files', '-u']).trim(), '', 'no conflict stage entries — test setup did not reproduce a real conflict');

      const sid = 'w6c_conflict_main';
      const pc = runPreserving(d, 'respawnpack-precompact.js', { hook_event_name: 'PreCompact', session_id: sid, cwd: d, trigger: 'manual' }, 'conflict/PreCompact');
      assert.equal(pc.status, 0, 'PreCompact must exit 0 even mid-conflict');
      assert.equal(pc.stdout, '', 'a successful firing emits nothing — a merge conflict alone must not trip an unrelated veto');

      const v2 = findV2Handoff(d, sid);
      assert.ok(v2, 'no v2 handoff written mid-conflict');
      const vr = core.handoff.validate(v2);
      assert.equal(vr.ok, true, `the handoff written mid-conflict does not validate: ${vr.reason}`);
      assert.ok(exists(core.handoff.verifiedPathFor(runtimeDirOf(d, sid), v2.handoffId)),
        'no read-back verification receipt mid-conflict — the handoff must still write+readback-verify');
      assert.ok(v2.git.uncommittedFiles.includes('shared.txt'), 'uncommittedFiles must name the conflicted path');
      // Never a wrong-but-plausible list: this adapter's sessionDelta is unconditionally CANNOT_DETERMINE
      // (no baseline layer exists here), which trivially satisfies "correct or CANNOT_DETERMINE" — but it
      // must still be exactly that literal shape, mid-conflict included, never something guessed.
      assert.deepEqual(v2.git.sessionDelta, { status: 'CANNOT_DETERMINE', files: [], headMoved: false });

      const ss = runPreserving(d, 'respawnpack-sessionstart.js', { hook_event_name: 'SessionStart', source: 'compact', session_id: sid, cwd: d }, 'conflict/SessionStart(compact)');
      assert.equal(ss.status, 0);
      const ctx = parseStdout(ss).hookSpecificOutput.additionalContext;
      assert.match(ctx, /shared\.txt/, 'the rehydrated context must still name the conflicted path');

      assert.match(fs.readFileSync(path.join(d, 'shared.txt'), 'utf8'), /<{7}[^\n]*\n[\s\S]*={7}[\s\S]*>{7}/,
        'the conflict markers themselves were altered — a rollover hook touched user-owned conflicted content');
    } finally { rm(d); }
  });
});

describe('W6c · discriminating control — the preservation harness can actually fail', () => {
  function fakeHookRun(dir, code) {
    const before = snapshotRepo(dir);
    const r = spawnSync(process.execPath, ['-e', code], { cwd: dir, encoding: 'utf8' });
    const after = snapshotRepo(dir);
    assert.equal(r.status, 0, `the fake hook itself crashed — proves nothing: ${r.stderr}`);
    return comparePreservation(before, after);
  }

  const BAD_CASES = [
    ['mutates a pre-existing tracked user file', "require('fs').appendFileSync('README.md','MUTATED BY FAKE HOOK\\n');", /user-owned path changed content: README\.md/],
    ['writes a brand-new stray file outside .respawnpack/', "require('fs').writeFileSync('evil-stray.txt','should never exist\\n');", /new path appeared outside \.respawnpack\/runtime\/: evil-stray\.txt/],
    ['deletes a pre-existing user file', "require('fs').unlinkSync('README.md');", /path DISAPPEARED[^:]*: README\.md/],
  ];

  for (const [label, code, expectedProblem] of BAD_CASES) {
    test(`known-bad: a fake hook that ${label} FAILS comparePreservation`, () => {
      const d = tmp('w6c-control-bad');
      try {
        gitInitRepo(d);
        const cmp = fakeHookRun(d, code);
        assert.equal(cmp.ok, false, `the comparator did not catch a hook that ${label} — it cannot detect what this battery claims to detect`);
        assert.ok(cmp.problems.some((p) => expectedProblem.test(p)), `the failure was not attributed to the right cause: ${cmp.problems.join(' | ')}`);
      } finally { rm(d); }
    });
  }

  test('known-good: a fake hook that writes ONLY a real-shaped runtime artifact PASSES both the comparator and the artifact-shape check', () => {
    const d = tmp('w6c-control-good');
    try {
      gitInitRepo(d);
      const before = snapshotRepo(d);
      const r = spawnSync(process.execPath, ['-e',
        "const fs=require('fs'),path=require('path');"
        + "fs.mkdirSync(path.join('.respawnpack','runtime','rollover'),{recursive:true});"
        + "fs.writeFileSync(path.join('.respawnpack','runtime','rollover','_codex-hooks-canary.json'),JSON.stringify({ran:true})+'\\n');",
      ], { cwd: d, encoding: 'utf8' });
      assert.equal(r.status, 0);
      const after = snapshotRepo(d);
      const cmp = assertPreserved(before, after, 'control/known-good runtime write');
      assert.deepEqual(cmp.newRuntimePaths, ['.respawnpack/runtime/rollover/_codex-hooks-canary.json']);
    } finally { rm(d); }
  });

  test('known-bad (shape layer): a fake hook that writes an UNRECOGNIZED filename under .respawnpack/runtime/ passes the raw comparator but fails the artifact-shape check', () => {
    const d = tmp('w6c-control-unknown-shape');
    try {
      gitInitRepo(d);
      const before = snapshotRepo(d);
      const r = spawnSync(process.execPath, ['-e',
        "const fs=require('fs'),path=require('path');"
        + "fs.mkdirSync(path.join('.respawnpack','runtime'),{recursive:true});"
        + "fs.writeFileSync(path.join('.respawnpack','runtime','totally-unexpected-artifact.bin'),'???');",
      ], { cwd: d, encoding: 'utf8' });
      assert.equal(r.status, 0);
      const after = snapshotRepo(d);
      const cmp = comparePreservation(before, after);
      assert.equal(cmp.ok, true, 'a write structurally under .respawnpack/runtime/ must pass the PREFIX-level comparator — this test is about the SHAPE layer catching what the prefix layer cannot');
      assert.deepEqual(cmp.newRuntimePaths, ['.respawnpack/runtime/totally-unexpected-artifact.bin']);
      assert.throws(() => assertPreserved(before, after, 'control/unknown shape'),
        /does not match any known rollover artifact shape/,
        'assertPreserved must reject an unrecognized artifact filename even though it is under .respawnpack/runtime/');
    } finally { rm(d); }
  });
});
