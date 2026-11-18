#!/usr/bin/env node
/*
 * RespawnPack · adapters/codex/hooks/respawnpack-canary.js — the activation canary.
 *
 * ⭐ WHY THIS FILE EXISTS SEPARATELY FROM THE BEHAVIOURAL HOOKS. Codex has no scriptable "list my active
 * hooks" command, and registration in hooks.json/config.toml is gated by BOTH `features.hooks` and a
 * per-hook interactive trust decision (`/hooks` in-session) that this pack cannot observe from outside.
 * An installed file is not a running integration — core/policy/capabilities.js says so explicitly, and
 * downgrades any capability claim that lacks one of these records. So the only honest proof that Codex
 * hooks are wired AND trusted in a given project is a marker written by a hook that actually fired, and
 * this script's only job is to be that proof for as many events as it is registered against.
 *
 * ⛔ THIS HOOK NEVER EMITS A DECISION, ON PURPOSE. hooks.json.template registers it broadly — potentially
 * against PermissionRequest and PreToolUse, which ARE decision-bearing events for other hooks. If this
 * script ever emitted `{"decision": ...}` or a permission verdict, a copy/paste of its registration onto
 * a security-relevant event would silently start granting or denying things nobody reviewed. So: read
 * stdin, refresh the marker, emit NOTHING on stdout, exit 0. Always. That is the entire contract, and it
 * is safe to attach to literally any hook event for exactly that reason.
 *
 * ⛔ THE MARKER IS REFRESHED EVEN WHEN STDIN DOES NOT PARSE. Every OTHER hook in this adapter treats
 * unparseable stdin as "we cannot safely act" and does nothing further (see respawnpack-precompact.js's
 * header for why). This hook is different because it takes no consequential action either way — the mere
 * fact that Codex invoked this script IS the signal being recorded, and refusing to note that because the
 * payload was garbled would throw away the one thing this script exists to prove.
 *
 * Contract: stdin = whatever the registered event sends (undocumented consolidated schema — common
 * fields only: session_id, cwd, hook_event_name, permission_mode, turn_id, transcript_path, model).
 * Output: NOTHING on stdout, ever. Exit 0, always.
 */
'use strict';
const shared = require('./_shared.js');

shared.installSafetyNet((e) => {
  shared.stderrLine(`canary hit an unexpected error and is exiting conservatively — ${(e && e.message) || e}`);
  shared.exitSilently();
});

(async () => {
  const rawText = await shared.readStdin();
  const parsed = shared.parseInput(rawText);

  // process.cwd() is the fallback even on a parse failure — Codex spawns this process FROM the project
  // directory in every documented invocation shape, so it is the best signal available when the payload
  // itself cannot be trusted. See _shared.js's projectDirOf for the same choice made once, centrally.
  const input = parsed.ok ? parsed.value : {};
  const projectDir = shared.projectDirOf(input);
  const event = parsed.ok ? shared.eventOf(input) : null;
  const sessionId = parsed.ok ? shared.sidOf(input) : null;
  // Verbatim, regardless of parseability — an unparseable payload is itself evidence of something, and
  // dropping it would be exactly the "typed wrapper without the raw payload" defect core/ refuses.
  const raw = parsed.ok ? input : { unparseable: true, error: parsed.error, text: rawText.slice(0, 2000) };

  const w = shared.refreshCanary(projectDir, { event, sessionId, raw });
  if (!w.ok) shared.stderrLine(`could not refresh the activation canary at ${projectDir} — ${w.detail}`);

  shared.exitSilently();
})();
