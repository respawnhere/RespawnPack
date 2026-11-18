#!/usr/bin/env node
/*
 * RespawnPack · adapters/codex/hooks/respawnpack-stop.js — Stop hook: a settle marker for a future
 * supervisor's safe-boundary logic.
 *
 * ⭐ AN UNBLOCKED STOP FIRING IS THE SETTLE SIGNAL — verified fact, not this file's invention (see the
 * W3a brief: "Stop's decision:'block' is NOT a veto (forces another turn); an unblocked Stop firing =
 * settle signal"). This hook does not decide whether to block; it has nothing to enforce here at all. It
 * records that a boundary was reached, shaped close to core/lifecycle/evidence.js's own SAFE_BOUNDARY
 * evidence kind (`mechanism: 'unblocked-stop-hook'`, matching the exact string core/core.test.mjs's own
 * fixtures use) so a later supervisor — this adapter's own future work, or W3b — can read this log and
 * construct a real SAFE_BOUNDARY record without re-deriving what "settled" meant.
 *
 * ⛔ NO DECISION IS EVER EMITTED. A Stop hook CAN return `{decision:"block", reason}` to force another
 * turn — that is someone else's mechanism, for someone else's purpose. This hook only ever writes a log
 * line and exits 0 with empty stdout; it must never be the reason a session is held open.
 *
 * Contract: stdin = Stop JSON (session_id, cwd, and whatever else this Codex build sends — undocumented
 * beyond the common fields). Output: NOTHING on stdout. Always exit 0.
 */
'use strict';
const shared = require('./_shared.js');

shared.installSafetyNet((e) => {
  shared.stderrLine(`settle marker failed unexpectedly — ${(e && e.message) || e}`);
  shared.exitSilently();
});

(async () => {
  const rawText = await shared.readStdin();
  const parsed = shared.parseInput(rawText);

  const input = parsed.ok ? parsed.value : {};
  const projectDir = shared.projectDirOf(input);
  const sid = parsed.ok ? shared.sidOf(input) : null;

  shared.refreshCanary(projectDir, { event: 'Stop', sessionId: sid, raw: parsed.ok ? input : { unparseable: true, error: parsed.error } });

  if (!parsed.ok) {
    shared.stderrLine(`stdin did not parse (${parsed.error}); marker recorded at the canary only`);
    shared.exitSilently();
    return;
  }
  if (!sid) {
    shared.stderrLine('Stop fired with no usable session_id; nothing to scope a per-conversation settle marker to beyond the canary already refreshed');
    shared.exitSilently();
    return;
  }

  const dir = shared.conversationDir(projectDir, sid);
  const bounded = shared.boundedRaw(input);
  const w = shared.appendMarker(shared.stopLogPath(dir), {
    kind: 'settle-marker', mechanism: 'unblocked-stop-hook', sessionId: sid, ...bounded,
  });
  if (!w.ok) shared.stderrLine(`could not append the settle marker at ${dir} — ${w.detail}`);

  shared.exitSilently();
})();
