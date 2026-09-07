#!/usr/bin/env node
/*
 * RespawnPack · adapters/codex/hooks/respawnpack-postcompact.js — PostCompact hook: observational
 * corroboration only. No decisions.
 *
 * ⛔ WHY THIS HOOK NEVER TOUCHES core.machine. PostCompact is documented as observational-only — common
 * output fields, NO additionalContext — and the brief is explicit that this hook makes none. Calling
 * `core.machine.open()` is not free of side effects: on a conversation's first-ever open it MINTS a cycle
 * and appends a CYCLE_OPEN row (see core/lifecycle/machine.js). That is a legitimate thing for a hook that
 * is ABOUT to act on the machine to do, but this hook never acts on it, so opening it here would be a
 * mutation with no corresponding decision — exactly what "no decisions" rules out. Instead this hook
 * computes the SAME conversation directory `core.machine.conversationDir` would (a pure path join, no
 * I/O) and appends a marker beside whatever the machine's journal already contains, without reading or
 * writing that journal itself.
 *
 * ⭐ WHAT THIS HOOK IS FOR. `postcompact_hook` is a declared completion signal in
 * core/lifecycle/evidence.js (hosts: [codex], documented: true) that nothing in this adapter currently
 * feeds into the machine — respawnpack-sessionstart.js uses `session_start_compact` instead, because
 * SessionStart is the hook that can actually inject a handoff. This log is what lets a FUTURE consumer
 * (a supervisor, or a later wave of this hook) corroborate "PostCompact also fired, and here is exactly
 * what it said" against the SessionStart(compact) firing that (normally) preceded it — two independent
 * observations of the same event are worth more than one, especially since neither payload's shape is
 * documented beyond the common fields.
 *
 * Contract: stdin = PostCompact JSON. Output: NOTHING on stdout — PostCompact carries no additionalContext
 * per the verified facts, and no other output field is documented for it either. Always exit 0.
 */
'use strict';
const shared = require('./_shared.js');

shared.installSafetyNet((e) => {
  shared.stderrLine(`postcompact marker failed unexpectedly — ${(e && e.message) || e}`);
  shared.exitSilently();
});

(async () => {
  const rawText = await shared.readStdin();
  const parsed = shared.parseInput(rawText);

  const input = parsed.ok ? parsed.value : {};
  const projectDir = shared.projectDirOf(input);
  const sid = parsed.ok ? shared.sidOf(input) : null;

  shared.refreshCanary(projectDir, { event: 'PostCompact', sessionId: sid, raw: parsed.ok ? input : { unparseable: true, error: parsed.error } });

  if (!parsed.ok) {
    shared.stderrLine(`stdin did not parse (${parsed.error}); marker recorded at the canary only, nothing else to scope it to`);
    shared.exitSilently();
    return;
  }
  if (!sid) {
    shared.stderrLine('PostCompact fired with no usable session_id; nothing to scope a per-conversation marker to beyond the canary already refreshed');
    shared.exitSilently();
    return;
  }

  const dir = shared.conversationDir(projectDir, sid);
  const bounded = shared.boundedRaw(input);
  const w = shared.appendMarker(shared.postcompactLogPath(dir), {
    kind: 'postcompact-marker', trigger: input.trigger || null, sessionId: sid, ...bounded,
  });
  if (!w.ok) shared.stderrLine(`could not append the postcompact marker at ${dir} — ${w.detail}`);

  shared.exitSilently();
})();
